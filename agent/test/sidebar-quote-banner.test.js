#!/usr/bin/env node
/**
 * 「带引用的提问气泡 = 上方横幅 + 正文」DOM 层冒烟自测（2026-11 用户定调）
 *
 * 用户原话：「我们现在为带引用的提问题气泡带上回答气泡带的这种上方横幅（竖着的不要）」。
 *
 * 背景（这条 bug 的成因）：库里 user 消息对引用提问是**带前缀的**——
 *   `[引用]《书名》章节\n> "划线原文"\n\n提问正文`
 * 而发送时喂给气泡的只有正文。于是同一条提问有两种长相：刚发出去是纯文本，
 * 重开面板后从历史回放却会连 `[引用]《…》` 和 `> "原文"` 一起显示在绿气泡里。
 *
 * 现在两边都走同一套渲染（addBubble → splitQuotedQuestion）：前缀变成气泡顶部的
 * 横幅（书名/章节 + 引号包住的原文），正文另起一块 .uq-body；**不出竖条**
 *（.ref-bar 是回答气泡专属）。本文件锁的就是这三件事。
 *
 * 跑法：node --test agent/test/sidebar-quote-banner.test.js
 * 与真浏览器的差距：DOM 是替身（不跑层叠、不排版），只验证"该出现的元素出现了、
 * 文案落到了哪一块"；视觉（绿底上白字横幅的观感）要靠人眼。
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

/** sidebar.js 顶层的 loadTutorial() 是无 catch 的动态 import，vm 沙箱里必然欠一个
 *  未处理拒绝；node:test 会把它算到当时正在跑的测试头上（同 sidebar-pending-question）。 */
const VM_IMPORT_ERR = 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'
process.on('unhandledRejection', (e) => {
  if (e && e.code === VM_IMPORT_ERR) return
  throw e
})

// ── DOM 替身（与 sidebar-pending-question.test.js / sidebar-free-conv.test.js 同一套）──
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

function loadSidebar({ history = [] } = {}) {
  const { doc, ids, getById } = buildDom()
  const calls = []
  const storage = {}
  const fetchStub = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET' })
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
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
  splitQuotedQuestion,
  userQuoteBubbleHTML,
  quotedQuestionText,
  questionSnippet,
  addBubble,
  setBook: (base) => { _currentBook = base ? { base, bookTitle: '测试书' } : null; applyBookFilter() },
  state: () => {
    const msgs = document.getElementById('msgs')
    const cls = (c) => msgs.children.filter((el) => String(el.className).split(/\\s+/).includes(c))
    return {
      users: cls('msg-user').map((el) => el.innerHTML),
    }
  },
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, calls, storage, doc, ids, getById }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// ── 解析：前缀 → 横幅字段 ────────────────────────────────────────────────────
test('splitQuotedQuestion：书名/章节/原文/正文四段都拆出来', () => {
  const { X } = loadSidebar()
  const q = X.splitQuotedQuestion('[引用]《国家与革命》第2章\n> "这种作法，自然并不新鲜"\n\n不是"就是"，是同一个功能的两副语法。')
  assert.ok(q, '引用提问要能拆开')
  assert.equal(q.book, '国家与革命')
  assert.equal(q.chapter, '第2章')
  assert.equal(q.quote, '这种作法，自然并不新鲜', '引号要被剥掉（横幅自己补引号）')
  assert.equal(q.body, '不是"就是"，是同一个功能的两副语法。', '正文只剩提问本身')
})

test('splitQuotedQuestion：无章节 / 只有引用没有正文 / 多行引用都认', () => {
  const { X } = loadSidebar()
  const noChapter = X.splitQuotedQuestion('[引用]《学做工》\n> "家伙们自有其逻辑"\n\n这怎么讲？')
  assert.equal(noChapter.chapter, '')
  assert.equal(noChapter.body, '这怎么讲？')

  const noBody = X.splitQuotedQuestion('[引用]《学做工》第一章\n> "家伙们自有其逻辑"')
  assert.equal(noBody.body, '', '只引不问：正文为空，气泡里只留横幅')
  assert.equal(noBody.quote, '家伙们自有其逻辑')

  const multi = X.splitQuotedQuestion('[引用]《学做工》第一章\n> "第一行\n> 第二行"\n\n接着问')
  assert.equal(multi.quote, '第一行\n第二行', '多行划线要拼回一段')
  assert.equal(multi.body, '接着问')
})

test('splitQuotedQuestion：自由提问 / 斜杠命令 / 附件消息一律返回 null（照旧纯文本）', () => {
  const { X } = loadSidebar()
  assert.equal(X.splitQuotedQuestion('为什么统一市场对工人更重要？'), null)
  assert.equal(X.splitQuotedQuestion('/收口'), null)
  // 附件消息的前缀不在行首 → 整段照旧，不把附件正文误当引用块啃掉
  assert.equal(X.splitQuotedQuestion('[附件]《论文.pdf》\n正文正文\n\n[引用]《学做工》\n> "x"\n\n问'), null)
  assert.equal(X.splitQuotedQuestion(''), null)
  assert.equal(X.splitQuotedQuestion(undefined), null)
})

// ── 渲染：横幅 + 正文两块，且不出竖条 ────────────────────────────────────────
test('气泡：引用提问渲染成 .uq-quote 横幅 + .uq-body 正文，不含 [引用] / > 原文', () => {
  const { X } = loadSidebar()
  const html = X.userQuoteBubbleHTML(X.splitQuotedQuestion(
    '[引用]《国家与革命》第2章\n> "这种作法，自然并不新鲜"\n\n不是"就是"，是同一个功能的两副语法。'))
  assert.match(html, /class="uq-quote"/, '要有上方横幅')
  assert.match(html, /class="uq-body"/, '正文要单独一块')
  assert.match(html, /uqq-text">"这种作法，自然并不新鲜"</, '横幅里只有原文（带引号）')
  assert.match(html, /uq-body">不是"就是"/, '正文落在 .uq-body')
  assert.doesNotMatch(html, /国家与革命/, '书名与章节不进气泡（2026-11 用户定调：横幅上只要原文）')
  assert.doesNotMatch(html, /\[引用\]/, '前缀不该再出现在气泡里')
  assert.doesNotMatch(html, /&gt;/, '> 原文行不该再出现在气泡里')
  assert.doesNotMatch(html, /ref-bar/, '竖排书名条是回答气泡专属——提问气泡不要（用户明确要求）')
})

test('气泡：超长原文按 80 字截断打省略号，全文进 title', () => {
  const { X } = loadSidebar()
  const long = '甲'.repeat(120)
  const q = X.splitQuotedQuestion(`[引用]《学做工》第一章\n> "${long}"\n\n问一问`)
  assert.equal(q.quote.length, 120, '解析阶段不截断（title 要放全文）')
  const html = X.userQuoteBubbleHTML(q)
  // 只看横幅可见那一段（title 里是全文，不能拿整段 HTML 去数）
  const shown = /<span class="uqq-text">"([^"]*)"/.exec(html)
  assert.ok(shown, '横幅里要有原文')
  assert.equal(shown[1], '甲'.repeat(80) + '…', '横幅只留 80 字 + 省略号（与回答气泡的引用条同口径）')
  const tip = /title="([^"]*)"/.exec(html)
  assert.ok(tip, '要有悬停提示')
  assert.equal(tip[1], long, '提示里放**原文全文**，鼠标悬停能看到被省略的部分')
  assert.doesNotMatch(tip[1], /学做工/, '提示不带书名——书名已在横幅行首，重复（2026-11 用户定调）')
  // 原文含半角引号时 title 属性不能被提前闭合（esc 不转义 `"`，属性值必须走 escAttr）
  const withQuote = X.userQuoteBubbleHTML(X.splitQuotedQuestion('[引用]《学做工》第一章\n> "the so-called "gift" economy"\n\n这段在说什么？'))
  assert.match(withQuote, /title="[^"]*&quot;gift&quot;/, '属性里的半角引号要转成 &quot;')
  assert.doesNotMatch(withQuote, /title="[^"]*"[^>]*"[^>]*>/, 'title 不能被内容里的引号提前闭合')
})

test('历史回放：带引用的提问气泡走横幅（不是整段纯文本）', async () => {
  const REF_Q = '[引用]《大国大城》欧洲正经历大考\n> "在应对全球经济危机的过程中"\n\n为什么统一市场对工人更重要？'
  const { X } = loadSidebar({ history: [{ role: 'user', content: REF_Q, _ts: 1791700000000, bookId: 'b1' }] })
  await flush()
  X.setBook('b1')
  const users = X.state().users
  assert.equal(users.length, 1)
  assert.match(users[0], /uq-quote/)
  assert.match(users[0], /uqq-text">"在应对全球经济危机的过程中"/, '横幅里是原文')
  assert.doesNotMatch(users[0], /大国大城/, '书名不显示在气泡上')
  assert.match(users[0], /uq-body[^>]*>为什么统一市场对工人更重要？/)
  assert.doesNotMatch(users[0], /\[引用\]/)
})

test('自由提问：没有横幅，整段照旧纯文本', async () => {
  const { X } = loadSidebar({ history: [{ role: 'user', content: '为什么统一市场对工人更重要？', _ts: 1791700000000, bookId: 'b1' }] })
  await flush()
  X.setBook('b1')
  const users = X.state().users
  assert.equal(users.length, 1)
  assert.match(users[0], /<div class="bubble">为什么统一市场对工人更重要？<\/div>/)
  assert.doesNotMatch(users[0], /uq-quote/)
})

// ── 共读弹窗来的提问：引用在 selectedText 字段里，不在正文里 ──────────────────
test('quotedQuestionText：正文没前缀但带 selectedText → 拼成横幅那套形态', () => {
  const { X } = loadSidebar()
  assert.equal(
    X.quotedQuestionText({ content: '这怎么讲？', selectedText: '家伙们自有其逻辑', bookTitle: '学做工', chapter: '第一章' }),
    '[引用]《学做工》第一章\n> "家伙们自有其逻辑"\n\n这怎么讲？')
  assert.equal(X.quotedQuestionText({ content: '[引用]《学做工》第一章\n> "x"\n\n问' }),
    '[引用]《学做工》第一章\n> "x"\n\n问', '已有前缀的原样用（不叠一层）')
  assert.equal(X.quotedQuestionText({ content: '没事引用' }), '没事引用')
})

test('历史回放：弹窗来的提问（引用在 selectedText 字段）也要画出横幅', async () => {
  const { X } = loadSidebar({
    history: [{
      role: 'user', content: '这怎么讲？', selectedText: '家伙们自有其逻辑',
      bookTitle: '学做工', chapter: '第一章', _ts: 1791700000000, bookId: 'b1',
    }],
  })
  await flush()
  X.setBook('b1')
  const users = X.state().users
  assert.equal(users.length, 1)
  assert.match(users[0], /uq-quote/, '拼回来才有横幅')
  assert.match(users[0], /uqq-text">"家伙们自有其逻辑"/, '横幅里是原文')
  assert.doesNotMatch(users[0], /学做工/, '书名不显示在气泡上')
  assert.match(users[0], /uq-body">这怎么讲？/, '正文照旧')
})

test('实时：弹窗消息（user-popup）同样走横幅，不再显示 `> "原文"` 生文本', () => {
  const { X } = loadSidebar()
  const el = X.addBubble('user-popup', '这怎么讲？', { bookTitle: '学做工', chapter: '第一章' }, '家伙们自有其逻辑', 'b1')
  assert.ok(el, '气泡要建出来')
  assert.match(el.innerHTML, /uq-quote/, '弹窗提问也有横幅')
  assert.doesNotMatch(el.innerHTML, /&gt;/, '不该再出现那行 `> "原文"`')
  assert.match(X.state().users.join(''), /uq-body">这怎么讲？/)
})

// ── 浮窗摘要：横幅不能顶掉提问摘要 ──────────────────────────────────────────
test('questionSnippet：有横幅时摘要是提问正文，不是引用原文', () => {
  const { X } = loadSidebar()
  // 用真 innerHTML 拼一个最小 DOM：只要 querySelector('.bubble') / ('.uq-body') 能命中
  const bodyEl = { textContent: '为什么统一市场对工人更重要？' }
  const bubbleEl = { querySelector: (sel) => (sel === '.uq-body' ? bodyEl : null) }
  const el = { querySelector: (sel) => (sel === '.bubble' ? bubbleEl : null) }
  assert.equal(X.questionSnippet(el), '为什么统一市场对工人更重要？')
})

test('questionSnippet：老式子元素（无 .uq-body）照旧跳过 > 与 [引用] 行', () => {
  const { X } = loadSidebar()
  const bubbleEl = {
    querySelector: () => null,
    textContent: '[引用]《大国大城》欧洲正经历大考\n> "在应对全球经济危机的过程中"\n\n为什么统一市场对工人更重要？',
  }
  const el = { querySelector: (sel) => (sel === '.bubble' ? bubbleEl : null) }
  assert.equal(X.questionSnippet(el), '为什么统一市场对工人更重要？')
})
