#!/usr/bin/env node
/**
 * 「插件关着的时候画一条划线 → 再打开插件，当前引用就是这条新划线」（2026-11 用户报）
 *
 * 用户原话：「当插件关闭的时候，进行划线，再打开插件时引用没有更新」。
 *
 * 根因不是"没记下来"，而是**只走了一条实时通道**：画线时 receiver 会推一条
 * annotation-sync 事件给侧栏——可侧栏关着的时候没有收件人，事件落进空气；而下次打开
 * 面板时 `/history` 只会把这条划线**加进引用列表**，不会把它选中，于是引用卡还停在旧的那条。
 *
 * 修法是把"设为当前引用"这个意图落成**待选标记**（`chrome.storage.local.pendingSelectRef`，
 * 与翻译工具「设为引用」同一个键）：面板下次打开时由 applyPendingSelect 认领。
 * 这条链路横跨两个文件，所以本文件两半都测：
 *   · content.js 半边（vm 沙箱）：画线（addBookmark）要写标记；批量回放（bookmarklist，
 *     打开书时把已有划线补进来）**不许**写——否则每次翻页都会把用户的当前引用抢走；
 *   · sidebar.js 半边（vm 沙箱）：storage 里有标记 + /history 里有这条标注 → 选中它。
 *
 * 跑法：node --test agent/test/highlight-sets-current-ref.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const CONTENT = path.join(ROOT, 'extension', 'content.js')
const SIDEBAR = path.join(ROOT, 'extension', 'sidebar.js')
const HTML = path.join(ROOT, 'extension', 'sidebar.html')

// 与 sidebar-*.test.js 同一套"沙箱里跑不了动态 import"的说明：sidebar.js 顶层
// loadTutorial() 已经自己 catch 了，这里只是防线，免得将来再有人在顶层裸 import()。
process.on('unhandledRejection', (e) => {
  if (e && e.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') return
  throw e
})

const BOOK = '480328505d095c4808beaf4'
const TEXT = '在应对全球经济危机的过程中，中国实施了宽松的财政'
const RANGE = '16598-16628'
const UID_INT = 37

// ── 通用替身 ───────────────────────────────────────────────────────────────
function makeEl(id = '') {
  return {
    id, children: [], dataset: {}, style: {}, hidden: false, value: '', textContent: '', _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    className: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, _h: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { const p = this.parent; if (p && p.children) p.children = p.children.filter((x) => x !== this) },
    querySelector() { return makeEl() }, querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null }, focus() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
}

// ── content.js 半边 ─────────────────────────────────────────────────────────
/**
 * @param {Array} annotations GET /annotations 的返回（用来演"这条划线已经入库了"）
 */
function loadContent({ annotations = [], annotationOk = true } = {}) {
  const sets = []        // chrome.storage.local.set 收到的对象
  const messages = []    // chrome.runtime.sendMessage 收到的东西
  const fetches = []     // fetch(url, opts)
  const doc = {
    title: '大国大城',
    body: makeEl('body'),
    head: makeEl('head'),
    getElementById: () => null,
    querySelector: (sel) => {
      if (sel === '.readerTopBar_title') return { textContent: '大国大城：当代中国的统一、发展与平衡' }
      if (sel === '.readerChapterTitleWrap_title') return { textContent: '' }
      return null
    },
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    createTreeWalker: () => ({ nextNode: () => null }),
    addEventListener() {}, removeEventListener() {},
    getSelection: () => ({ toString: () => '' }),
  }
  const win = {
    addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() {},
    location: { pathname: '/web/reader/' + BOOK, href: 'https://weread.qq.com/web/reader/' + BOOK, hash: '' },
  }
  win.top = win
  win.top.document = doc
  const storageLocal = {
    get: async () => ({}), set: async (o) => { sets.push(o) }, remove: async () => {},
    _data: {},
  }
  const storageSession = { get: async () => ({}), set: async () => {} }
  const chromeStub = {
    storage: {
      local: storageLocal,
      session: storageSession,
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: (m) => { messages.push(m); return Promise.resolve({ opened: false, error: 'no gesture' }) },
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
  }
  const fetchStub = async (url, opts = {}) => {
    const u = String(url)
    fetches.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => obj })
    if (u.includes('/annotations')) return json(annotations)
    if (u.endsWith('/annotation')) return json({ ok: annotationOk }, annotationOk)
    return json({})
  }
  class MutationObserverStub { observe() {} disconnect() {} }
  class CustomEventStub { constructor(t, o) { this.type = t; this.detail = o && o.detail } }
  const ctx = {
    document: doc, window: win, chrome: chromeStub, fetch: fetchStub,
    MutationObserver: MutationObserverStub, CustomEvent: CustomEventStub,
    location: win.location, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 'node' }, TextDecoder, TextEncoder, Uint8Array, URL, atob, btoa,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
  }
  ctx.globalThis = ctx
  ctx.self = ctx
  const expose = `
;globalThis.__X = {
  handleAddBookmark,
  handleBookmarkContent,
  syncBookmarkRef,
  readingContext: () => getReadingContext(),
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(CONTENT, 'utf8') + expose, ctx, { filename: 'content.js' })
  return { X: ctx.__X, sets, messages, fetches }
}

const addReq = (over = {}) => JSON.stringify({
  chapterUid: UID_INT, range: RANGE, markText: TEXT, ...over,
})

test('content：新画一条划线 → 落"待选引用"标记 + 直接消息 + 请后台开面板', async () => {
  const h = loadContent()
  await h.X.handleAddBookmark('https://weread.qq.com/web/book/addBookmark', addReq())

  const post = h.fetches.find((f) => f.url.endsWith('/annotation') && f.method === 'POST')
  assert.ok(post, '划线要入库成引用（这条没变）')
  assert.equal(post.body.setRef, false, '入库仍走 bookmark-sync（不触发 agent 讨论）')

  const mark = h.sets.map((o) => o.pendingSelectRef).filter(Boolean)[0]
  assert.ok(mark, '必须落 pendingSelectRef：面板关着时这是唯一能把"设为当前引用"带到下次打开的东西')
  assert.equal(mark.selectedText, TEXT)
  assert.equal(mark.bookId, BOOK)
  assert.equal(mark.chapterUidInt, UID_INT, '带整数章节号，跳转/删除都要用')
  assert.equal(mark.bookmarkRange, RANGE, '带 range：删除引用时才能精确对上这条划线')

  const direct = h.messages.find((m) => m.action === 'coreadSetRefApply')
  assert.ok(direct, '面板已开着时走直接消息（SSE 断开也能即时生效）')
  assert.equal(direct.ref.selectedText, TEXT)
  assert.ok(h.messages.some((m) => m.action === 'openPanel'), '仍然请后台尽力打开面板')
})

test('content：打开书时的批量回放（bookmarklist）不许抢当前引用', async () => {
  const h = loadContent()
  const raw = JSON.stringify({ updated: [{ markText: TEXT, chapterUid: UID_INT, range: RANGE, bookmarkId: 'CB_x_' + UID_INT + '_' + RANGE }] })
  await h.X.handleBookmarkContent('https://weread.qq.com/web/book/bookmarklist', raw)
  assert.ok(h.fetches.some((f) => f.url.endsWith('/annotation') && f.method === 'POST'), '已有划线仍要补进引用库')
  assert.equal(h.sets.filter((o) => o.pendingSelectRef).length, 0,
    '批量回放绝不能写待选标记——否则每次翻页/重开书都会把用户的当前引用换成最后一条划线')
})

test('content：同一条划线重复画（已入库）不重复写标记', async () => {
  const h = loadContent({ annotations: [{ bookId: BOOK, selectedText: TEXT }] })
  await h.X.handleAddBookmark('https://weread.qq.com/web/book/addBookmark', addReq())
  assert.equal(h.fetches.filter((f) => f.url.endsWith('/annotation')).length, 0, '已在库里 → 不再入库')
  assert.equal(h.sets.filter((o) => o.pendingSelectRef).length, 0, '也不写标记')
})

// ── sidebar.js 半边 ─────────────────────────────────────────────────────────
function buildSidebarDom() {
  const html = fs.readFileSync(HTML, 'utf8')
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const cache = new Map()
  const hiddenInHtml = (id) => {
    const m = new RegExp('<(\\w+)([^>]*\\bid="' + id + '"[^>]*)>').exec(html)
    return !!(m && /(^|\s)hidden(\s|=|$)/.test(m[2]))
  }
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) { const el = makeEl(id); el.hidden = hiddenInHtml(id); cache.set(id, el) }
    return cache.get(id)
  }
  const doc = {
    body: makeEl('body'), getElementById: getById, createElement: () => makeEl(),
    querySelector: () => makeEl(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  }
  return { doc, ids, getById }
}

/** 打开面板：storage 里已经有"待选引用"标记，/history 里有这条标注 */
function openPanel({ pendingSelectRef, manualBook, history }) {
  const { doc, ids, getById } = buildSidebarDom()
  const storage = { refs: [], refNumCounter: 0, selectedRef: null }
  if (pendingSelectRef) storage.pendingSelectRef = pendingSelectRef
  if (manualBook) storage.manualBook = manualBook
  const removed = []
  const fetchStub = async (url) => {
    const u = String(url)
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (u.endsWith('/history')) return json(history)
    if (u.includes('/annotations')) return json([])
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
    if (u.endsWith('/ping')) return json({ ok: true })
    return json({})
  }
  const chromeStub = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) o[k] = storage[k]; return o },
        set: async (o) => { Object.assign(storage, o) },
        remove: async (k) => { removed.push(k); delete storage[k] },
      },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => null,
      onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    runtime: { sendMessage: async () => null, onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://test/' + p },
  }
  class EventSourceStub { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null } close() {} }
  const ctx = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub, fetch: fetchStub, EventSource: EventSourceStub, AbortController,
    crypto: globalThis.crypto, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' }, navigator: { userAgent: 'node' },
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx
  ctx.self = ctx
  const expose = `
;globalThis.__X = {
  state: () => ({
    selected: selectedAnn ? selectedAnn.selectedText : null,
    selectedNum: selectedAnn ? selectedAnn.refNum : 0,
    refTexts: RECENT_ANNS.map((a) => a.selectedText),
    pendingMark: _pendingSelectRef,
    pendingInStorage: !!document && false,
  }),
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(SIDEBAR, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, storage, removed, ids, getById }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const ANN_ROW = {
  role: 'annotation', content: '《大国大城：当代中国的统一、发展与平衡》', selectedText: TEXT,
  bookId: BOOK, bookTitle: '大国大城：当代中国的统一、发展与平衡', chapter: '', chapterUid: '',
  chapterUidInt: UID_INT, bookmarkRange: RANGE, bookmarkId: '', sourceUrl: '',
  _ts: 1791700000000,
}

test('sidebar：面板重开时认出待选引用，当前引用卡换成这条新划线', async () => {
  const h = openPanel({
    pendingSelectRef: {
      bookId: BOOK, bookTitle: '大国大城：当代中国的统一、发展与平衡', chapter: '',
      chapterUidInt: UID_INT, bookmarkRange: RANGE, bookmarkId: '', selectedText: TEXT,
    },
    history: [ANN_ROW],
  })
  await flush()
  const s = h.X.state()
  assert.equal(s.selected, TEXT, '这就是用户报的"再打开插件时引用没有更新"——现在要更新')
  assert.ok(s.refTexts.includes(TEXT), '这条划线也进了引用列表')
  assert.equal(s.pendingMark, null, '认领成功即清掉标记（否则每次打开面板都会把用户后来的选择顶掉）')
  assert.ok(h.removed.includes('pendingSelectRef'), 'storage 里的标记也要一起清')
})

test('sidebar：标注还没入库时不硬塞，标记留着下次再试', async () => {
  const h = openPanel({
    pendingSelectRef: { bookId: BOOK, selectedText: TEXT, chapterUidInt: UID_INT, bookmarkRange: RANGE },
    history: [],   // /history 还没有这条（receipt 尚未写盘 / 接收端刚起来）
  })
  await flush()
  const s = h.X.state()
  assert.equal(s.selected, null, '找不到就不选（绝不空造一条引用）')
  assert.ok(s.pendingMark, '标记必须留着：下次打开面板时 /history 就能查到了')
})

test('sidebar：看的是另一本书时不被待选标记抢走（AI-001 按书隔离）', async () => {
  // 场景：用户手动选着 B 书在看历史记录，同时在 A 书里画了一条线。
  // 这条划线该进列表，但**不该**把 B 书的当前引用抢过来——等切回 A 书再认领。
  const h = openPanel({
    manualBook: { base: 'rd_otherbook000000000000000000', bookTitle: '另一本书' },
    pendingSelectRef: {
      bookId: BOOK, bookTitle: '大国大城：当代中国的统一、发展与平衡', selectedText: TEXT,
      chapterUidInt: UID_INT, bookmarkRange: RANGE,
    },
    history: [ANN_ROW],
  })
  await flush()
  const s = h.X.state()
  assert.equal(s.selected, null, '当前上下文是 B 书 → 不许把 A 书的划线塞成当前引用')
  assert.ok(s.refTexts.includes(TEXT), '但它照样进引用列表（切回 A 书就能看到并选中）')
  assert.ok(s.pendingMark, '标记留着：切回 A 书时再认领')
})
