#!/usr/bin/env node
/**
 * 引用里的「章节」标签（2026-11 用户定调）
 *
 * ── 用户看到的现象 ────────────────────────────────────────────────────────────
 * 引用抽屉里每张卡片在书名下都孤零零一行 `3`。它的真身是 `ann.chapter`——
 * 微信读书顶栏那一串（书名 + 位置号）被 content.js 的 splitBookTitle() 拆开时，
 * 把尾部那个裸数字当成了"章节"（见 extension/content.js:146-189）。
 * 谁也不知道 `3` 是什么。用户定的调子：**前面加「章节：」这个说明**，先让它读得懂。
 *
 * ── 本文件钉住什么 ────────────────────────────────────────────────────────────
 * 三处显示这个字段的地方都必须带标签、且**没有章节时不许留一个空的"章节："**：
 *   ① 引用抽屉卡片  sidebar.js 的 .di-chapter
 *   ② 当前引用卡片  sidebar.js 的 #rc-meta
 *   ③ 回答气泡竖排条 sidebar.js 的 .ref-chapter（值截 2 字 + 「章节」竖排标签）
 *
 * 为什么用真 sidebar.js 而不是读源码正则：这三处都是**拼 HTML 字符串**，
 * 正则只能证明"源码里出现过这几个字"，证明不了"渲染出来的那条真带标签、
 * 且空章节那条真的什么都没渲染"。这里跑真代码、读渲出来的 DOM。
 * 跑法：node --test agent/test/sidebar-chapter-label.test.js
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

// ── DOM 替身（与 sidebar-quote-banner.test.js 同一套；改动请同步）────────────
function makeEl(id = '') {
  const classes = new Set()
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    get className() { return [...classes].join(' ') },
    set className(v) { classes.clear(); for (const c of String(v || '').split(/\s+/)) if (c) classes.add(c) },
    classList: {
      add(c) { classes.add(c) },
      remove(c) { classes.delete(c) },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c) },
      contains(c) { return classes.has(c) },
    },
    hidden: false, disabled: false, checked: false, value: '', textContent: '', title: '', placeholder: '',
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, isComposing: false,
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    // 真 DOM 的 replaceChildren：清空再挂上给的那些节点。
    // 2026-11 补：侧栏的引用卡正文改用 `box.replaceChildren()` 之后，这个替身缺它就会抛
    // `box.replaceChildren is not a function`——那是**替身的洞**，不是产品的问题。
    replaceChildren(...cs) { this.children = []; this._html = ''; for (const c of cs) this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
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
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) cache.set(id, makeEl(id))
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
    removeEventListener() {},
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
  }
  return { doc, ids, getById }
}

const BOOK = 'CB_aaaaaaaaaaaaaaaaaaaa'
const BOOK_TITLE = '失明症漫记（罗翔推荐）'
/** 就是用户截图里那条：章节字段是裸数字 3（微读顶栏尾部的位置号） */
const ANN = {
  bookId: BOOK, bookTitle: BOOK_TITLE, chapter: '3',
  chapterUid: 'e_2', chapterUidInt: 2, refNum: 288,
  selectedText: '不论看来多么有悖情理，这个念头倒使她大大放下心来，因为……而汽车这么大的物件是不能藏在床底下的。',
  receivedAt: Date.parse('2026-11-02'),
}

function loadSidebar() {
  const { doc, ids, getById } = buildDom()
  const fetchStub = async (url) => {
    const json = (o) => ({ ok: true, status: 200, json: async () => o })
    const u = String(url)
    if (u.includes('/annotations')) return json([ANN])
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.includes('/books')) return json({ books: [] })
    if (u.includes('/history')) return json([])
    if (u.includes('/free-conversations')) return json({ current: null, active: [], archived: [] })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
    if (u.endsWith('/ping')) return json({ ok: true })
    return json({})
  }
  const chromeStub = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: {
      query: async () => [], sendMessage: async () => null,
      onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://test/' + p },
  }
  class EventSourceStub { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null } close() {} }
  const ctx = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    AbortController,
    crypto: globalThis.crypto,
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

  // 只暴露本文件要用的那几处：当前引用卡片、回答气泡引用条、引用抽屉
  const expose = `
;globalThis.__X = {
  renderRefUI,
  refReplyHTML,
  renderDrawer,
  setAnn: (a) => { selectedAnn = a },
  // RECENT_ANNS 是侧栏里那份引用库：抽屉从这里取，引用卡片的存在性也看它
  storeRefs: (list) => { RECENT_ANNS.length = 0; for (const a of list) RECENT_ANNS.push(a) },
  // 卡片与抽屉都按"当前书"过滤，所以先立上下文（书名同时给卡片用）
  setBook: (base, title) => { _currentBook = base ? { base, bookTitle: title || '' } : null; applyBookFilter() },
  // 抽屉是逐条 appendChild 的，DOM 替身里要读 children 才看得见
  drawerHtml: () => ((document.getElementById('drawer-list') || {}).children || [])
    .map((el) => el.innerHTML || '').join('\\n'),
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, getById }
}

/** 铺好"当前书 + 已选引用 + 库里有一条标注"这三件事 */
function setup({ chapter = '3', selectedText = ANN.selectedText } = {}) {
  const { X, getById } = loadSidebar()
  const ann = { ...ANN, chapter, selectedText }
  // RECENT_ANNS 是侧栏里那份引用库：抽屉从它取，引用卡片的存在性也看它
  X.setBook(BOOK, BOOK_TITLE)
  X.setAnn(ann)
  X.storeRefs([ann])
  return { X, getById, ann }
}

// ── ① 引用抽屉卡片 ──────────────────────────────────────────────────────────
test('引用抽屉卡片：章节一行带「章节：」标签（用户截图里那个孤零零的 3）', () => {
  const { X } = setup()
  X.renderDrawer()
  const html = X.drawerHtml()
  const line = /<div class="di-chapter">([\s\S]*?)<\/div>/.exec(html)
  assert.ok(line, '卡片里要有章节这一行')
  assert.equal(line[1], '章节：3', '裸数字前面必须带上「章节：」——它就是用户看不懂的那个 3')
})

test('引用抽屉卡片：没有章节时不许留一个空的「章节：」', () => {
  const { X } = setup({ chapter: '' })
  X.renderDrawer()
  const line = /<div class="di-chapter">([\s\S]*?)<\/div>/.exec(X.drawerHtml())
  assert.ok(line, '章节这一行始终在（空着就是空着）')
  assert.doesNotMatch(line[1], /章节/, '没章节就别写标签——那会变成一句没有下文的"章节："')
})

test('引用抽屉卡片：章节是正常名字时也带标签、原样显示', () => {
  const { X } = setup({ chapter: '卷二 第五章' })
  X.renderDrawer()
  const line = /<div class="di-chapter">([\s\S]*?)<\/div>/.exec(X.drawerHtml())
  assert.equal(line[1], '章节：卷二 第五章', '真章节名也要带标签（两种数据长得一样，标签是唯一的区分）')
})

// ── ② 当前引用卡片（#rc-meta）──────────────────────────────────────────────
test('当前引用卡片：meta 行是「章节：X」+「N 字」', () => {
  const { X, getById } = setup()
  X.renderRefUI()
  const meta = getById('rc-meta').innerHTML
  assert.match(meta, /<span>章节：3<\/span>/, '章节要带标签')
  assert.match(meta, /<span>\d+ 字<\/span>/, '字数那一项照旧')
})

test('当前引用卡片：没有章节时 meta 行只剩「N 字」', () => {
  const { X, getById } = setup({ chapter: '' })
  X.renderRefUI()
  const meta = getById('rc-meta').innerHTML
  assert.doesNotMatch(meta, /章节/, '没章节不写标签')
  assert.match(meta, /<span>\d+ 字<\/span>/, '字数那一项仍在')
})

// ── ③ 回答气泡的竖排引用条（.ref-chapter）──────────────────────────────────
test('回答气泡竖排条：章节拆成「竖排标签 + 横排值」两行，且整块没有章节时不出', () => {
  const { X } = setup()
  const bar = X.refReplyHTML({ ...ANN, chapter: '3' }, '回答正文')
  assert.match(bar, /<span class="ref-chapter"><span class="rc-label">章节<\/span><span class="rc-val">3<\/span><\/span>/,
    '条宽只有 40px，「章节：3」整串竖排会又高又难读，必须拆成标签行 + 值行（见 sidebar.html）')

  const noChapter = X.refReplyHTML({ ...ANN, chapter: '' }, '回答正文')
  assert.doesNotMatch(noChapter, /ref-chapter/, '没章节时整块不出现（不留一个空标签悬在那儿）')
})

test('回答气泡竖排条：长章节名截到 2 字（完整章节名在卡片与抽屉里都是全的）', () => {
  const { X } = setup()
  const bar = X.refReplyHTML({ ...ANN, chapter: '卷二 第五章' }, '回答正文')
  assert.match(bar, /<span class="rc-val">卷二<\/span>/, '值截 2 字，否则"卷二 第五章"会把竖排条撑宽')
})
