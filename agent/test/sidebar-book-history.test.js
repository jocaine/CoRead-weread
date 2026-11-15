#!/usr/bin/env node
/**
 * 「点开旧书，聊天记录是空的」DOM 层回归（2026-10-25 用户报）
 *
 * 用户原话：「为什么我的《怎么办》《中国特色社会主义保障制度论纲》这些书的聊天记录都没了」。
 * 库里没丢（214 / 107 条），丢的是**窗口**：/history 首屏只回全库最近 500 条，
 * 两本 9 月的书整本滑出窗口，侧栏按书过滤后一条不剩，于是画了开场卡。
 *
 * 修法（本测试锁的就是它）：点开一本书时按书补拉 `/history?book=<base>`，
 * 只取这一本、不截全局窗口；拉过记账，切来切去不重复请求；失败不记账，下次重试。
 *
 * 跑法：node --test agent/test/sidebar-book-history.test.js
 * 与真浏览器的差距：DOM 是替身（不跑层叠、不排版），只验证"该出现的气泡出现了、
 * 该发的请求发了、不该重复的没重复"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const HTML = path.join(ROOT, 'extension', 'sidebar.html')
const JS = path.join(ROOT, 'extension', 'sidebar.js')

// sidebar.js 顶层的 loadTutorial() 是无 catch 的动态 import，vm 沙箱里必留一笔拒绝；
// 只吞这一种（与 sidebar-pending-question.test.js 同款），别的一律原样抛。
const VM_IMPORT_ERR = 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'
process.on('unhandledRejection', (e) => {
  if (e && e.code === VM_IMPORT_ERR) return
  throw e
})

// ── DOM 替身（与 sidebar-pending-question.test.js 同一套；改动请两边同步）──────
function makeEl(id = '') {
  return {
    id,
    children: [],
    dataset: {},
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) },
      remove(c) { this._s.delete(c) },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    },
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    title: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    className: '',
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { const p = this.parent; if (p && p.children) p.children = p.children.filter((x) => x !== this) },
    querySelector() { return makeEl() },
    querySelectorAll() { return [] },
    setAttribute() {},
    getAttribute() { return null },
    focus() {},
    select() {},
    setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null },
    contains() { return false },
  }
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
    if (!cache.has(id)) {
      const el = makeEl(id)
      el.hidden = hiddenInHtml(id)
      cache.set(id, el)
    }
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
  return { doc, ids, getById }
}

/**
 * 装载真 sidebar.js。
 * @param {{history?: object[], bookHistory?: Record<string, object[]>, failFirstBook?: string}} opts
 *   history      = 首屏 GET /history（**只有最近窗口里的书**，旧书不在里面）
 *   bookHistory  = GET /history?book=<base> 的返回（按书给）
 *   failFirstBook 某本书的第一次补拉抛错（验"失败不记账、下次重试"）
 */
function loadSidebar({ history = [], bookHistory = {}, failFirstBook = '' } = {}) {
  const { doc, ids, getById } = buildDom()
  const calls = []
  const storage = {}
  const failCount = new Map()
  const fetchStub = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET' })
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const m = /\/history\?book=(.+)$/.exec(u)
    if (m) {
      const base = decodeURIComponent(m[1])
      const n = (failCount.get(base) || 0) + 1
      failCount.set(base, n)
      if (base === failFirstBook && n === 1) throw new Error('模拟 receiver 暂时不可用')
      return json(bookHistory[base] || [])
    }
    if (u.endsWith('/history')) return json(history)
    if (u.includes('/annotations')) return json([])
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
    if (u.endsWith('/ping')) return json({ ok: true })
    if (u.endsWith('/free-conversations')) return json({ current: null, active: [], archived: [] })
    return json({})
  }
  const chromeStub = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) o[k] = storage[k]; return o },
        set: async (obj) => { Object.assign(storage, obj) },
        remove: async () => {},
      },
    },
    tabs: { query: async () => [], sendMessage: async () => null, onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
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

  const expose = `
;globalThis.__X = {
  loadHistory,
  applyBookContext,
  bookLoaded: (base) => _bookHistLoaded.has(base),
  bookLoading: () => _bookHistLoading,
  state: () => {
    const msgs = document.getElementById('msgs')
    const cls = (c) => msgs.children.filter((el) => String(el.className).split(/\\s+/).includes(c))
    return {
      bubbles: msgs.children.length,
      users: cls('msg-user').length,
      userText: cls('msg-user').map((el) => el.textContent || el.innerHTML).join(' | '),
      visibleUsers: cls('msg-user').filter((el) => el.style.display !== 'none').length,
      currentBook: effectiveBookBase(),
    }
  },
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, calls, storage, doc, ids, getById }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

async function waitFor (fn, what) {
  for (let i = 0; i < 80; i++) {
    if (fn()) return
    await flush(2)
  }
  throw new Error('等超时：' + what)
}

// 首屏窗口里只有最近这本（b1）
const B1 = 'CB_aaaaaaaaaaaaaaaaaaaa'
const B2 = 'CB_bbbbbbbbbbbbbbbbbbbb'
const B3 = 'CB_cccccccccccccccccccc'
const Q1 = { role: 'user', content: '最近这本书的问题', _ts: 1791700000000, bookId: B1 }
const A1 = { role: 'assistant', content: '最近这本书的回答', _ts: 1791700001000, bookKey: B1 }
// 旧书（b2）：整本在窗口外，首屏 /history 里一条都没有
const Q2 = { role: 'user', content: '旧书里的老问题', _ts: 1788300000000, bookId: B2 }
const A2 = { role: 'assistant', content: '旧书里的老回答', _ts: 1788300001000, bookKey: B2 }

test('旧书不在首屏窗口里 → 点开时按书补拉，气泡出现并可见', async () => {
  const { X, calls } = loadSidebar({ history: [Q1, A1], bookHistory: { [B2]: [Q2, A2] } })
  await waitFor(() => X.state().users === 1, '首屏历史回放')
  assert.equal(X.state().users, 1, '首屏只画了最近那本的一条提问')
  assert.ok(!calls.some((c) => c.url.includes('?book=')), '还没切到旧书，不该有按书补拉')

  X.applyBookContext({ bookId: B2, bookTitle: '旧书' })
  await waitFor(() => X.bookLoaded(B2), '按书补拉完成')
  await flush(6)

  const s = X.state()
  assert.ok(calls.some((c) => c.url.includes('/history?book=' + B2)), '点开旧书要发 ?book= 请求')
  assert.equal(s.users, 2, '旧书的提问气泡补出来了（首屏只有 1 条）')
  assert.match(s.userText, /旧书里的老问题/, '补出来的确实是这本书的内容')
  assert.equal(s.visibleUsers, 1, '当前书 = 旧书 → 只显示它自己的 1 条，另一本被隐藏')
  assert.equal(s.currentBook, B2)
})

test('同一本书只补拉一次：切走再切回，不重复请求、不重复气泡', async () => {
  const { X, calls } = loadSidebar({ history: [Q1, A1], bookHistory: { [B2]: [Q2, A2] } })
  await waitFor(() => X.state().users === 1, '首屏历史回放')
  X.applyBookContext({ bookId: B2, bookTitle: '旧书' })
  await waitFor(() => X.bookLoaded(B2), '第一次补拉')
  await flush(6)

  X.applyBookContext({ bookId: B1, bookTitle: '最近这本' })
  await flush(4)
  X.applyBookContext({ bookId: B2, bookTitle: '旧书' })
  await flush(6)

  const hits = calls.filter((c) => c.url.includes('/history?book=' + B2)).length
  assert.equal(hits, 1, '第二趟切回不再请求（_bookHistLoaded 记账）')
  assert.equal(X.state().users, 2, '气泡也没长第二份（_histKeys 幂等）')
})

test('补拉失败不记账：下次切回会重试，成功后才算拉过', async () => {
  const { X, calls } = loadSidebar({
    history: [Q1, A1],
    bookHistory: { [B3]: [Q2, A2] },
    failFirstBook: B3,
  })
  await waitFor(() => X.state().users === 1, '首屏历史回放')
  X.applyBookContext({ bookId: B3, bookTitle: '会失败的书' })
  await waitFor(() => !X.bookLoading(), '第一次补拉失败收尾')
  assert.equal(X.bookLoaded(B3), false, '失败不该记账')
  assert.equal(X.state().users, 1, '失败时没有气泡')

  X.applyBookContext({ bookId: B1, bookTitle: '最近这本' })
  await flush(4)
  X.applyBookContext({ bookId: B3, bookTitle: '会失败的书' })
  await waitFor(() => X.bookLoaded(B3), '第二次补拉成功')
  await flush(6)

  const hits = calls.filter((c) => c.url.includes('/history?book=' + B3)).length
  assert.equal(hits, 2, '失败那次 + 重试那次')
  assert.equal(X.state().users, 2, '重试成功后气泡出来了')
})

// ── 静态闸门：SSE 补渲染的 assistant 气泡必须带书标记 ─────────────────────────
// 2026-10-26 `l3 both` 的第二份答案就是这么"消失"的：库里有、屏上没有。
// applyBookFilter 的规则是 `el.dataset.book === 当前书 ? 显示 : none`，
// 所以任何走 addBubble('assistant', …) 却没传 bookId 的路径，在读书模式下都会被整条藏掉。
test('SSE 补渲染的 assistant 气泡必须带书标记（否则被 applyBookFilter 藏掉）', () => {
  const src = fs.readFileSync(JS, 'utf8')
  // 规则本身没变：没书签就 hidden
  assert.match(src, /const b = el\.dataset\.book \|\| ''/)
  // 补渲染那条路必须把 d.bookKey 带进去（bookId 是 addBubble 的第 5 个参数；
  // 第 6 个是材料条目 sources——2026-10-27 加的，正文里 [编号] 点开要看它）
  assert.match(src, /addBubble\('assistant', d\.content, null, null, d\.bookKey, d\.sources\)/)
})
