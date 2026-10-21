#!/usr/bin/env node
/**
 * 侧栏的"当前书"跟随**活动标签页**（2026-11 二次改版）
 *
 * ── 规则（用户定调：与微信读书打开的那本书表现一致）─────────────────────────
 *   活动标签页 = 我们的 PDF 阅读器 → 侧栏显示它开着的那本
 *   活动标签页 = 微读的书页        → 侧栏显示那本
 *   活动标签页 = 别的任何页面      → 侧栏回到无书界面（书单），**不再**挂着 PDF 会话
 *
 * ── 起因（用户实测）─────────────────────────────────────────────────────────
 * "现在即使当前在毫不相关的标签页，只要标签栏内有其标签页，侧栏就一直显示着这个会话"。
 * 根因是两条治过头的防线：后台会"按 URL 找一个后台挂着的阅读器标签页"顶上来，
 * 侧栏又额外有一条"阅读器标签页还开着 → 绝不清空"。两条都已删掉，本文件把它们钉住。
 *
 * ── 历史（第一版，2026-11 上半月）───────────────────────────────────────────
 * 上一版修的是相反方向的 bug：在阅读器里打开 PDF，侧栏没跟过去（因为那时只问活动 tab，
 * 而"活动 tab"在某些时刻并不等于阅读器）。当时的办法是"阅读器自己推上来就用"。
 * 推送这条路**保留**（它仍是换书最可靠的信号），但加了前提：**必须是活动标签页推的**。
 *
 * 跑法：node agent/test/sidebar-reader-context.test.js
 *      （用与 sidebar-free-conv.test.js 同一套 DOM 替身，按 sidebar.html 真实 id 建元素）
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

const BOOK = { bookId: 'rd_' + 'a'.repeat(64), hash: 'a'.repeat(64), name: '法西斯主义论文集.pdf' }
const OTHER_BOOK = { bookId: 'rd_' + 'b'.repeat(64), hash: 'b'.repeat(64), name: '别的书.pdf' }
const WEREAD_BOOK = { bookId: 'ce0321c0722b4a5d9f7b0c1e2d3f4a5b', bookTitle: '大国大城', chapter: '第 1 章' }
const WEREAD_URL = 'https://weread.qq.com/web/reader/' + WEREAD_BOOK.bookId

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
 *
 * @param {object} opts 把"后台会怎么回答"和"浏览器里此刻是什么样"摊成参数：
 *   · `activeKind`  后台对 `readerContextQuery` 报的"活动标签页是哪一类页面"
 *                   （'reader' 阅读器 / 'weread-book' 微读书页 / 'weread' 微读其它页 /
 *                    'page' 文库网页 / 'other' 任何别的网页 / 'unknown' 判不出来）
 *   · `readerBook`  活动标签页是阅读器时，它开着哪本 PDF（null = 没开着书）
 *   · `unknown` / `loading`  阅读器答不上来 / 正在打开书
 *   · `queryThrows`  后台那条查询直接抛错（后台没起来 / service worker 在重启）
 *   · `noReqEcho`    答复里**没有带回 req** —— 说明答话的不是后台那条路
 *   · `wereadCtx`    活动标签页（微读书页）对 getReadingContext 的回答（null = 没应声）
 *   · `pageBinding`  活动标签页（文库网页）对 coreadBindingQuery 的回答（null = 没应声/未绑定）
 *   · `activeTabId`  chrome.tabs.query 报的活动标签页 id（null = 查不出来）
 */
function loadSidebar({
  activeKind = 'reader', readerBook = null, unknown = false, loading = false,
  tabId = 11, url = '', queryThrows = false, noReqEcho = false,
  wereadCtx = null, pageBinding = null, activeTabId = 11,
} = {}) {
  const { doc, getById } = buildDom()
  const storage = {}
  const sent = []
  const tabMsgs = []
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
      // 只回答"活动标签页是谁"这一种查询（activeTabId 那条）；按 URL 找 tab 的一律空
      query: async (q) => (q && q.active
        ? (activeTabId === null ? [] : [{ id: activeTabId, url: 'https://news.qq.com/' }])
        : []),
      sendMessage: async (id, msg) => {
        tabMsgs.push({ id, msg })
        if (msg && msg.action === 'getReadingContext') return wereadCtx
        if (msg && msg.action === 'coreadBindingQuery') return pageBinding
        return null
      },
      get: async (id) => ({ id, active: id === activeTabId }),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg)
        if (msg && msg.action === 'readerContextQuery') {
          if (queryThrows) throw new Error('后台没起来')
          const payload = { ok: true, notReader: activeKind !== 'reader', activeKind, tabId, url }
          if (activeKind === 'reader') {
            payload.book = readerBook
            if (unknown) payload.unknown = true
            if (loading) payload.loading = true
          }
          // 正常那条路一定把 req 原样带回来（见 translate-background.js 的 readerContextQuery）
          return noReqEcho ? payload : Object.assign({ req: msg.req }, payload)
        }
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
  effectiveBook, effectiveBookBase, applyBookContext, isPageSourceUrl,
  getState: () => ({ currentBook: _currentBook, manualBook: _manualBook, freeMode: _freeMode, readerReportsBook: _readerReportsBook }),
  setManualBook: (b) => { _manualBook = b },
};`
  const src = fs.readFileSync(JS, 'utf8')
  vm.createContext(ctx)
  vm.runInContext(src + expose, ctx, { filename: 'sidebar.js' })

  /**
   * 把一条消息**像浏览器那样**投给侧栏的所有监听器（可带 sender）。
   * 侧栏有两个 onMessage 监听器：大的那个处理 coreadBookContext 等，
   * 小的那个处理 readerUpdate —— 两边都要投，才等于真环境。
   */
  const fire = (msg, sender) => {
    for (const fn of msgListeners.slice()) {
      try { fn(msg, sender || {}, () => {}) } catch (e) {}
    }
  }

  return { X: ctx.__X, doc, getById, sent, tabMsgs, msgListeners, fire, ctx }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// ── 阅读器是活动标签页：跟随它 ────────────────────────────────────────────────

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
  const other = bubble(OTHER_BOOK.bookId)
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
  X.applyReaderBookFromSnapshot({ book: null, notify: true })
  assert.equal(X.effectiveBookBase(), '', '关掉 PDF 后不再停在它上面')
})

test('翻页/新译文这类同步不抢上下文（快照没带 notify 时不动作）', () => {
  const { X } = loadSidebar()
  // 模拟侧栏当前在看另一本书（手动选书）
  X.setManualBook({ base: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？' })
  // 不带 notify 的快照：它只是译文更新，不该把用户从手动翻看的书上拽走
  const snapshot = { book: BOOK, page: 7, entries: [] }
  if (snapshot.notify) X.applyReaderBookFromSnapshot(snapshot)
  assert.equal(X.effectiveBookBase(), 'mia_8a66411378a3f8d9116f', '手动翻看的书原地不动')
  assert.equal(X.getState().manualBook?.base, 'mia_8a66411378a3f8d9116f', '手动选书状态没被清掉')
})

test('侧栏启动时也能问到阅读器（覆盖"先开 PDF、后开侧栏"）', async () => {
  const { X, sent } = loadSidebar({ activeKind: 'reader', readerBook: BOOK })
  await X.refreshCurrentBook()
  await flush(2)
  const asked = sent.filter((m) => m && m.action === 'readerContextQuery')
  assert.ok(asked.length > 0, '侧栏确实问了后台"我该认哪本书"')
  assert.ok(asked.every((m) => typeof m.req === 'string' && m.req), '每条都带 req 随机串（只认后台的答复）')
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '问到了就切过去')
})

// ── 本次修复的核心：活动标签页不是阅读器 → 不许再挂着它那本书 ────────────────

test('活动标签页是毫不相干的网页 → 侧栏不再挂着阅读器里那本书（本次修复的核心）', async () => {
  const { X } = loadSidebar({ activeKind: 'other' })
  // 先让侧栏认着阅读器里那本 PDF（= 用户刚在阅读器里看书，_readerReportsBook 也因此为真）
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '前置：当前书是那本 PDF')
  assert.equal(X.getState().readerReportsBook, true, '前置：那道"阅读器开着书"的防线此刻是真')

  // 用户切到新闻网页。阅读器标签页**还开着**（就在标签栏里），但用户没在看它。
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), '', '活动标签页不是阅读器 → 回到无书界面（与微读那本书被切走时一致）')
})

test('活动标签页是微读的书架/详情页 → 同样是无书', async () => {
  const { X } = loadSidebar({ activeKind: 'weread', readerBook: null })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), '', '微读的非书页不是"在读某本书"')
})

test('活动标签页是文库网页（marxists/bilibili）→ 同样是无书', async () => {
  const { X } = loadSidebar({ activeKind: 'page', readerBook: null })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), '', '未绑定的文库页面是无书；绑定后的页面由 refreshCurrentBook 问页面自己（见 coreadBindingQuery）')
})

test('文库网页已绑定正式书 → 切回这个标签页时侧栏认那本书（绑定不能只在绑定那一瞬生效）', async () => {
  const formal = { ok: true, bound: true, bookId: '480328505d095c4808beaf4', bookTitle: '大国大城' }
  const { X } = loadSidebar({ activeKind: 'page', readerBook: null, pageBinding: formal })
  assert.equal(X.effectiveBookBase(), '', '前置：一开始没有当前书')
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), formal.bookId, '页面自己报的绑定就是这本书')
  assert.equal(X.effectiveBook().bookTitle, formal.bookTitle, '书名也带回来（头部要用）')
})

test('文库网页已绑定网页文章的书（mia_）→ 切回来也认它', async () => {
  const mia = { ok: true, bound: true, bookId: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？' }
  const { X } = loadSidebar({ activeKind: 'page', readerBook: null, pageBinding: mia })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), mia.bookId)
})

test('文库网页的绑定查询没应声（内容脚本没起来）→ 按未绑定处理，不误认书', async () => {
  const { X } = loadSidebar({ activeKind: 'page', readerBook: null, pageBinding: null })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), '', '问不到绑定 ≠ 有书；等页面加载完会再问一次（tabs.onUpdated）')
})

test('isPageSourceUrl：跳转判据认网页阅读源，不认微读/阅读器地址，也不吃子串伪装', () => {
  const { X } = loadSidebar()
  const yes = [
    'https://www.marxists.org/chinese/lenin/1917/x.htm',
    'https://marxists.org/chinese/lenin/1917/x.htm',
    'https://www.bilibili.com/read/cv123456',
    'http://www.bilibili.com/read/cv123456',
  ]
  for (const u of yes) assert.equal(X.isPageSourceUrl(u), true, u + ' 应认作网页阅读源')
  const no = [
    'https://weread.qq.com/web/reader/abc',
    'chrome-extension://x/reader.html',
    'https://evilmarxists.org/chinese/x',
    'https://www.bilibili.com.evil.com/x',
    '',
  ]
  for (const u of no) assert.equal(X.isPageSourceUrl(u), false, u + ' 不应认作网页阅读源')
})

test('活动标签页判不出来（拿不到标签页）→ 保持原样，绝不误清', async () => {
  const { X } = loadSidebar({ activeKind: 'unknown', readerBook: BOOK })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '"我问不出来"不等于"你没在读书"')
})

test('后台答不上来（查询抛错）→ 保持原样', async () => {
  const { X } = loadSidebar({ queryThrows: true, readerBook: BOOK })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '后台在重启 / 没起来时不许把当前书清掉')
})

test('答复里没带回 req（答话的不是后台）→ 保持原样', async () => {
  const { X } = loadSidebar({ noReqEcho: true, readerBook: OTHER_BOOK })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '分不清是谁答的就不动（页面抢答过这个坑）')
})

test('阅读器答非所问 / 正在打开书（unknown、loading）→ 保持原样', async () => {
  const a = loadSidebar({ activeKind: 'reader', readerBook: null, unknown: true })
  a.X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await a.X.refreshCurrentBook()
  assert.equal(a.X.effectiveBookBase(), BOOK.bookId, 'unknown ≠ 没有书')

  const b = loadSidebar({ activeKind: 'reader', readerBook: null, loading: true })
  b.X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await b.X.refreshCurrentBook()
  assert.equal(b.X.effectiveBookBase(), BOOK.bookId, 'loading ≠ 没有书')
})

// ── 活动标签页是微读的书页：跟随它 ──────────────────────────────────────────

test('活动标签页是微读书页 → 当前书切到那本（问的就是后台点名的那个标签页）', async () => {
  const { X, tabMsgs } = loadSidebar({
    activeKind: 'weread-book', tabId: 7, url: WEREAD_URL, wereadCtx: WEREAD_BOOK,
  })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), WEREAD_BOOK.bookId, '切到微读那本')
  assert.equal(X.effectiveBook().bookTitle, '大国大城')
  assert.ok(tabMsgs.some((m) => m.id === 7 && m.msg && m.msg.action === 'getReadingContext'),
    '问的是后台报的那个活动标签页，不是自己再查一遍')
})

test('微读书页的内容脚本还没应声 → 书 ID 取自 URL（问不倒的事实），不清空', async () => {
  const { X } = loadSidebar({
    activeKind: 'weread-book', tabId: 7, url: WEREAD_URL, wereadCtx: null,
  })
  X.applyReaderBookFromSnapshot({ book: BOOK, notify: true })
  await X.refreshCurrentBook()
  assert.equal(X.effectiveBookBase(), WEREAD_BOOK.bookId, 'URL 里就写着书 ID（/web/reader/<书 ID>）')
})

// ── 推送侧：只有活动标签页推上来的才算数 ────────────────────────────────────

test('阅读器推的换书通知：不是活动标签页推的 → 不采纳', () => {
  const { X, fire } = loadSidebar({ activeKind: 'reader', readerBook: BOOK })
  X.applyBookContext({ bookId: BOOK.bookId, bookTitle: BOOK.name })
  const snapshot = { book: OTHER_BOOK, notify: true }

  fire({ action: 'readerUpdate', snapshot, fromActive: false })
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '后台挂着的阅读器不许改当前书')

  fire({ action: 'readerUpdate', snapshot, fromActive: true })
  assert.equal(X.effectiveBookBase(), OTHER_BOOK.bookId, '活动标签页推的照旧采纳')
})

test('阅读器推的换书通知：判不出来是谁推的 → 照旧采纳（宁可放过，别不跟）', () => {
  const { X, fire } = loadSidebar({ activeKind: 'reader', readerBook: BOOK })
  fire({ action: 'readerUpdate', snapshot: { book: BOOK, notify: true } })
  assert.equal(X.effectiveBookBase(), BOOK.bookId, 'fromActive 缺失时按"就当它是"处理')
})

test('微读页面的广播：只有活动标签页、且是顶层 frame 的才算数', async () => {
  // `activeKind:'unknown'`：让启动链那次自动刷新什么都不做（这条测的是**广播过滤**，
  // 不是刷新；不然它会先把当前书清掉，断言就看不出过滤有没有生效）
  const { X, fire } = loadSidebar({ activeKind: 'unknown', activeTabId: 3 })
  X.applyBookContext({ bookId: BOOK.bookId, bookTitle: BOOK.name })
  const mia = { bookId: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？' }

  // ① 后台标签页（中键点开一本书、恢复会话、后台刷新）广播 → 忽略
  fire({ action: 'coreadBookContext', ...mia }, { tab: { id: 9 }, frameId: 0 })
  await flush()
  assert.equal(X.effectiveBookBase(), BOOK.bookId, '没在看的标签页不许改当前书')

  // ② 活动标签页广播 → 采纳
  fire({ action: 'coreadBookContext', ...mia }, { tab: { id: 3 }, frameId: 0 })
  await flush()
  assert.equal(X.effectiveBookBase(), mia.bookId, '活动标签页广播的当前书照旧采纳')

  // ③ 子 frame 的广播 → 忽略（content.js 在微读每个 frame 里都跑，子 frame 读到的是
  //    它自己的路径，于是广播空 bookId，会把当前书清掉）
  fire({ action: 'coreadBookContext', bookId: '', bookTitle: '' }, { tab: { id: 3 }, frameId: 5 })
  await flush()
  assert.equal(X.effectiveBookBase(), mia.bookId, '子 frame 的空 bookId 广播是噪声，不许清空')
})

// ── 手动选书 / 自由模式的既有规矩不受影响 ──────────────────────────────────

test('网页绑定到正式书籍：coreadManualBook 把侧栏切到那本书的对话', async () => {
  // 2026-11 用户报的"网页弹窗只能加入网页源文章的书"——书单修好后，这条链路也得通：
  // 网页对话框点 OK 会发 coreadManualBook，侧栏必须把当前书切成那本正式书，
  // 之后提问/引用才归到它的对话里。
  const { X, fire } = loadSidebar({ activeKind: 'page', readerBook: null })
  // 先等启动链那次 refreshCurrentBook 跑完（活动页是文库页 → 它会先把当前书清空）；
  // 真实场景里用户点「绑定这本书」远晚于面板加载，不会撞上这一拍。
  await flush()
  const formal = { bookId: '480328505d095c4808beaf4', bookTitle: '大国大城' }
  fire({ action: 'coreadManualBook', ...formal }, { tab: { id: 11 }, frameId: 0 })
  await flush()
  assert.equal(X.effectiveBookBase(), formal.bookId, '当前书 = 网页上绑定到的那本正式书')
  assert.equal(X.effectiveBook().bookTitle, formal.bookTitle, '书名也带过去（头部与对话归属都要）')
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
