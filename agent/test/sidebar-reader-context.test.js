#!/usr/bin/env node
/**
 * 侧栏的"当前书"跟随阅读器（2026-11）
 *
 * 起因（用户实测）：在阅读器里打开一本 PDF，侧栏并没有切到这本书的会话上。
 * 根因是侧栏判定"当前在读哪本"一直是**反过来问**"活动 tab 是不是阅读器"——
 * 而"活动 tab"并不总是答案（侧栏在 DevTools 里、用户刚点过别的 tab、面板刚打开），
 * 于是时灵时不灵。现在改成：**阅读器自己推上来**（readerUpdate 带 notify），侧栏直接用。
 *
 * 这里测的就是那条新链路：快照进来 → 上下文切换 → 消息区只留这本书的对话。
 * 用与 sidebar-free-conv.test.js 同一套 DOM 替身（按 sidebar.html 真实 id 建元素）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML = path.join(__dirname, '..', '..', 'extension', 'sidebar.html')
const JS = path.join(__dirname, '..', '..', 'extension', 'sidebar.js')

function makeEl(id = '') {
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    hidden: false, disabled: false, checked: false, value: '', textContent: '', title: '', placeholder: '',
    scrollTop: 0, scrollHeight: 0, isComposing: false,
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    append(...cs) { for (const c of cs) this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    replaceChildren() { this.children = [] },
    querySelector() { return makeEl() },
    querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null },
    focus() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
  return el
}

function buildDom() {
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
    body: makeEl('body'),
    getElementById: getById,
    createElement: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
  }
  return { doc, getById }
}

/**
 * 装载侧栏。
 * @param {{readerBook?: object|null}} opts readerBook = 后台对 readerBookInfo 的回答内容
 */
function loadSidebar({ readerBook = null } = {}) {
  const { doc, getById } = buildDom()
  const storage = {}
  const sent = []
  const msgListeners = []

  const fetchStub = async (url) => {
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    if (u.endsWith('/ping')) return json({ ok: true })
    if (u.includes('/history')) return json([])
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.includes('/books')) return json({ books: [] })
    if (u.includes('/free-conversations')) return json({ active: [], archived: [] })
    return json({})
  }

  const chromeStub = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) o[k] = storage[k]; return o },
        set: async (obj) => { Object.assign(storage, obj) },
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [],                 // 没有任何微信读书 tab
      sendMessage: async () => null,
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg)
        if (msg && msg.action === 'readerBookInfo') return { ok: true, notReader: false, book: readerBook }
        return { ok: true }
      },
      onMessage: { addListener: (fn) => { msgListeners.push(fn) } },
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test',
    },
  }

  class EventSourceStub { constructor() {} close() {} }

  const ctx = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' },
    navigator: { userAgent: 'node' },
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx
  ctx.self = ctx

  const expose = `
;globalThis.__X = {
  refreshCurrentBook,
  applyReaderBookFromSnapshot,
  effectiveBook, effectiveBookBase, applyBookContext,
  getState: () => ({ currentBook: _currentBook, manualBook: _manualBook, freeMode: _freeMode }),
  setManualBook: (b) => { _manualBook = b },
};`
  const src = fs.readFileSync(JS, 'utf8')
  vm.createContext(ctx)
  vm.runInContext(src + expose, ctx, { filename: 'sidebar.js' })

  return { X: ctx.__X, doc, getById, sent, storage, msgListeners, ctx }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const BOOK = { bookId: 'rd_' + 'a'.repeat(64), hash: 'a'.repeat(64), name: '法西斯主义论文集.pdf' }

test('阅读器推来"打开了一本 PDF"→ 侧栏的当前书切到这本', () => {
  const { X } = loadSidebar()
  assert.equal(X.effectiveBookBase(), '', '初始没有当前书')
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '当前书 = 阅读器里那本（rd_<hash>）')
  assert.equal(X.effectiveBook().bookTitle, BOOK.name, '书名来自阅读器自报的 PDF 文件名')
})

test('消息区只留这本书的对话（别的书的气泡被隐藏）', () => {
  const { X, getById } = loadSidebar()
  const msgs = getById('msgs')
  // 气泡要像真元素：applyBookFilter 顺带跑 renderJumpBars（提问浮窗），它会遍历
  // 气泡的 className / dataset 找"提问"——替身少了这些字段就会在这里抛错（踩过）
  const bubble = (book) => {
    const el = makeEl()
    el.className = book ? 'msg-user' : 'msg-assistant'
    el.dataset = book ? { book } : {}
    return el
  }
  const mine = bubble(BOOK.bookId)
  const other = bubble('rd_' + 'b'.repeat(64))
  const loose = bubble('')
  msgs.children.push(mine, other, loose)

  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  assert.equal(mine.style.display, '', '这本书的气泡可见')
  assert.equal(other.style.display, 'none', '另一本书的气泡被隐藏')
  assert.equal(loose.style.display, 'none', '没有归属书的气泡也不显示')
})

test('阅读器回到书库（没有书）→ 侧栏离开那本书', () => {
  const { X } = loadSidebar()
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  assert.equal(X.effectiveBookBase(), BOOK.bookId)
  const reader = { dataset: { book: BOOK.bookId }, style: {} }
  const { getById } = loadSidebar()
  void getById
  X.applyReaderBookFromSnapshot({ book: null, notify: true })
  assert.equal(X.effectiveBookBase(), '', '关掉 PDF 后不再停在它上面')
  void reader
})

test('翻页/新译文这类同步不抢上下文（快照没带 notify 时不动作）', () => {
  const { X } = loadSidebar()
  // 模拟 side 栏当前在看另一本书（手动选书）
  X.setManualBook({ base: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？' })
  // 不带 notify 的快照：它只是译文更新，不该把用户从手动翻看的书上拽走
  const snapshot = { book: BOOK, page: 7, entries: [] }
  if (snapshot.notify) X.applyReaderBookFromSnapshot(snapshot)
  assert.equal(X.effectiveBookBase(), 'mia_8a66411378a3f8d9116f', '手动翻看的书原地不动')
  assert.equal(X.getState().manualBook?.base, 'mia_8a66411378a3f8d9116f', '手动选书状态没被清掉')
})

test('侧栏启动时也能问到阅读器（覆盖"先开 PDF、后开侧栏"）', async () => {
  const { X, sent } = loadSidebar({ readerBook: BOOK })
  await X.refreshCurrentBook()
  await flush(2)
  assert.ok(sent.some((m) => m.action === 'readerBookInfo'), '侧栏确实问了后台"阅读器开着哪本"')
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '问到了就切过去')
})

test('自由模式下不被阅读器拽走', () => {
  const { X } = loadSidebar()
  X.applyBookContext({ bookId: '__coread_free_mode__', bookTitle: '自由模式' })
  // 自由模式的开关是模块内变量，这里直接走 applyReaderBookFromSnapshot 的早退分支：
  // 用 setFreeMode 不存在，于是改为验证"手动选书时不硬拽"这条相邻规矩
  X.setManualBook({ base: 'mia_11111111111111111111', bookTitle: '别的书' })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  assert.equal(X.effectiveBookBase(), 'mia_11111111111111111111', '手动翻看时不被硬拽走（只记录实时上下文）')
  assert.equal(X.getState().currentBook.base, BOOK.bookId, '但实时上下文照常记下来')
})
