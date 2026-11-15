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
  mdToHtml,
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

// ── 材料面板（2026-10-27 晚定稿：链接色 + 整句可点）──────────────────────────
// 用户的原话："让文字变色，使用超链接的文字颜色，然后点击整段范围都能展开。"
// 所以这一句整个包成一个 label（点哪儿都开），面板里放这一句用到的**全部**材料；
// 句尾的 [n] 只是编号，不再各自带一个面板。侧栏只认这一轮真带回来的条目。
const SRC1 = { n: 1, query: '招拍挂哪一年', title: '部39号令详解', site: '自然资源部', text: '2002年5月9日发布', url: 'https://www.mnr.gov.cn/x.html' }

test('mdToHtml：整句就是一个开关，默认收起；点开是标题＋原话＋可点的链接', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('分水岭是 2002 年[1]。', [SRC1])
  assert.match(html, /^<p><label class="vt" title="这一句对照过 1 条网上材料[^"]*">/, '整句是一个可点的 label')
  assert.match(html, /<input type="checkbox" class="cite-t">/, '开关就是这个 checkbox')
  assert.doesNotMatch(html, /checked/, '默认收起：不带 checked')
  assert.match(html, /2002 年<span class="cite-k">\[1\]<\/span>。/, '正文里露出来的只有编号，编号在句号前')
  assert.match(html, /<\/span>。<span class="cite-box">/, '面板接在句号后面')
  assert.match(html, /部39号令详解（自然资源部）/, '第一行是标题与站点')
  assert.match(html, /2002年5月9日发布/, '第二行是网页里那段原话')
  assert.match(html, /<a class="cite-url" href="https:\/\/www\.mnr\.gov\.cn\/x\.html" target="_blank" rel="noopener noreferrer">/, '链接可点、开新页')
})

test('mdToHtml：没带材料条目（历史消息 / 没联网）时，[1] 保持纯文字、整句不变色', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('分水岭是 2002 年[1]。')
  assert.doesNotMatch(html, /class="vt"/, '没有条目就不该有可点的整句')
  assert.doesNotMatch(html, /cite/)
  assert.match(html, /2002 年\[1\]/)
  // 空数组同理（这一轮没查到，不是"查了没有"）
  assert.doesNotMatch(X.mdToHtml('甲[1]', []), /class="vt"/)
})

test('mdToHtml：编号对不上就留成纯文字；一句里引两次，面板只列一次', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('对得上[1]，对不上[9]，又来一次[1]。', [SRC1])
  assert.match(html, /\[9\]/, '编出来的编号原样留着（不猜、不藏，能看见才能查）')
  assert.doesNotMatch(html, /\[9\]<\/span>/, '不能把它也做成编号')
  assert.equal((html.match(/class="cite-k"/g) || []).length, 2, '两处编号都露出来')
  assert.equal((html.match(/class="cite-item"/g) || []).length, 1, '同一条材料在面板里只列一次')
})

test('mdToHtml：面板里放洗过的那段（shown），不是「...」缝起来的原文（text）', () => {
  const { X } = loadSidebar()
  // 服务端给两份：text 是原文（凭据），shown 是洗过、给人读的那段
  const src = {
    n: 1, query: 'q', title: '财政部答记者问', site: '中华人民共和国财政部',
    text: '甲段还没说完 ... 乙段才是完整的一句话，读得通。',
    shown: '乙段才是完整的一句话，读得通。',
    url: 'https://example.com/a',
  }
  const html = X.mdToHtml('这一句是核对过的[1]。', [src])
  assert.match(html, /乙段才是完整的一句话/, '面板里放 shown')
  assert.doesNotMatch(html, /甲段还没说完/, '「...」缝起来的原文不给人看')
  assert.doesNotMatch(html, /\.\.\./, '面板里不该留省略号缝合的痕迹')
  // 老数据没有 shown：退回 text，不能变成一个空面板
  const old = X.mdToHtml('这一句[1]。', [{ n: 1, title: 't', text: '只有原文', url: '' }])
  assert.match(old, /只有原文/)
})

test('mdToHtml：多段原话一段一行（换行留着），面板 CSS 得允许换行', () => {
  const { X } = loadSidebar()
  const src = {
    n: 1, query: 'q', title: '某解读', site: '某站',
    text: '第一段 ... 第二段',
    shown: '第一段在这儿被切断了…\n第二段是完整的一句话。',
    url: 'https://example.com/a',
  }
  const html = X.mdToHtml('核对过的一句[1]。', [src])
  assert.match(html, /第一段在这儿被切断了…\n第二段是完整的一句话。/, '换行要原样进 DOM')
  // 换行进了 DOM 还得 CSS 让它显示出来，否则浏览器把 \n 当空格
  const css = fs.readFileSync(HTML, 'utf8')
  assert.match(css, /\.bubble\.md \.cite-txt \{[^}]*white-space: pre-wrap/, '.cite-txt 要 pre-wrap')
})

test('mdToHtml：材料来自网页，一律转义；非 http(s) 的链接不建链', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('x[1]', [{
    n: 1, title: '<script>alert(1)</script>', site: '某站', text: 'a<b>&c', url: 'javascript:alert(1)',
  }])
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '标题要转义')
  assert.match(html, /a&lt;b&gt;&amp;c/, '原话要转义')
  assert.doesNotMatch(html, /href="javascript:/, 'javascript: 不许变成可点链接')
  assert.match(html, /<span class="cite-url">javascript:alert\(1\)<\/span>/, '退成纯文字')
})

test('mdToHtml：行内代码里的 [1] 不是引用，不替换', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('写法是 `[1]` 这样', [SRC1])
  assert.match(html, /<code class="md-code">\[1\]<\/code>/)
  assert.doesNotMatch(html, /cite-k/)
})

test('addBubble：assistant 气泡把 sources 一路带到渲染（第 6 个参数）', () => {
  const { X, getById } = loadSidebar()
  X.addBubble('assistant', '分水岭是 2002 年[1]。', null, null, 'b1', [SRC1])
  const msgs = getById('msgs')
  const el = msgs.children[msgs.children.length - 1]
  assert.match(el.innerHTML, /class="vt"/, '材料条目没丢在传参路上')
  assert.equal(el.dataset.book, 'b1', '书标记照旧（否则读书模式下整条被藏）')
})

// ── 哪几个字算"这一句"（2026-10-27 晚）──────────────────────────────────────
const SRC2 = { n: 2, query: '', title: '土地财政依赖度减弱', site: '中国房地产报', text: '2024年卖地收入4.87万亿', url: 'https://e.com/b' }

test('mdToHtml：一句两条材料 → 一个整句开关，面板里两条都在', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('跌了四成多，连续三年两位数下滑[1][2]。', [SRC1, SRC2])
  assert.equal((html.match(/class="vt"/g) || []).length, 1, '一整句一个开关，不拆成两个')
  assert.match(html, /class="cite-k">\[1\]<\/span><span class="cite-k">\[2\]<\/span>/, '两个编号都露出来')
  assert.equal((html.match(/class="cite-item"/g) || []).length, 2, '两条材料都收在同一个面板里')
  assert.equal((html.match(/class="cite-box"/g) || []).length, 1)
})

test('mdToHtml：连着的编号里夹着一个编的（[1][9]）→ 认得出的照常，认不出的留文字', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('某段话[1][9]。', [SRC1])
  assert.match(html, /class="vt"/, '这一句仍然可点')
  assert.match(html, /\[1\]<\/span>/, '[1] 照常')
  assert.match(html, /\[9\]/, '[9] 原样留着')
})

test('mdToHtml：可点的范围就是这一句（含编号与句号），前后两句不动', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('这个托是有极限的，现在正在看见。收入从8.7万亿跌到4.87万亿[1][2]。这就是托不住的时候开始了。', [SRC1, SRC2])
  assert.match(html, /现在正在看见。<label class="vt"/, '开关从第二句开头起')
  assert.match(html, /<span class="cite-k">\[2\]<\/span>。<span class="cite-box">[\s\S]*?<\/label>这就是托不住/, '开关在句号之后收起，后一句在外面')
  assert.equal((html.match(/class="vt"/g) || []).length, 1, '只有那一句')
})

test('mdToHtml：只引了一条的句子同样整句可点（用户举的那句：新预算法）', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('新预算法实施以后，地方国有企业包括融资平台公司举的债，法律上不属于政府债务，由企业自己偿还[1]。', [SRC1])
  assert.match(html, /^<p><label class="vt" title="这一句对照过 1 条网上材料[^"]*"><input type="checkbox" class="cite-t">新预算法实施以后/, '一条材料也是"有出处"')
  assert.match(html, /<\/label><\/p>$/, '到句号为止')
  assert.match(html, /class="cite-k">\[1\]</, '编号仍是 [1]')
})

test('mdToHtml：同一行两句都用上了材料，各自一个开关', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('甲说法[1]。乙说法[2]。', [SRC1, SRC2])
  assert.equal((html.match(/class="vt"/g) || []).length, 2, '两句各一个，各自展开各自的面板')
  assert.match(html, /<label class="vt"[^>]*><input type="checkbox" class="cite-t">甲说法/)
  assert.match(html, /<label class="vt"[^>]*><input type="checkbox" class="cite-t">乙说法/)
})

// ── 点别处自动收起 / 点面板里不收起（2026-10-27 用户定）──────────────────────
// 这两条是页面级点击行为，DOM 替身跑不出来（没有真实事件冒泡），所以按本仓库的惯例
// 用源码闸门钉住：删了或写错就红，别等到人眼发现"点别处不收起"。
test('侧栏的点击守卫：点面板内部不收起，点别处把开着的都收起', () => {
  const src = fs.readFileSync(JS, 'utf8')
  assert.match(src, /document\.addEventListener\('click',[\s\S]{0,200}\.cite-box[\s\S]{0,80}stopPropagation/, '点面板内部要拦住，别冒到 label')
  assert.match(src, /querySelectorAll\('input\.cite-t:checked'\)/, '要把已经展开的那些找出来')
  assert.match(src, /cb\.checked = false/, '点别处就把它们合上')
  assert.match(src, /closest\('label\.vt, label\.cite'\)/, '点的是自己那一条时不能收（否则一开一关互相打架）')
})

test('mdToHtml：整行加粗的伪标题（句号在 ** 里面）不会被切坏', () => {
  const { X } = loadSidebar()
  const html = X.mdToHtml('**先说它量的是什么。**\n收入从8.7万亿跌到4.87万亿[1][2]。', [SRC1, SRC2])
  assert.match(html, /<strong>先说它量的是什么。<\/strong>/, '粗体没被切半，星号也没漏出来')
  assert.doesNotMatch(html, /\*\*/)
  assert.match(html, /class="vt"/)
})

test('mdToHtml：没带材料条目时不加标记（历史消息、没联网的回合）', () => {
  const { X } = loadSidebar()
  assert.doesNotMatch(X.mdToHtml('某段话[1][2]。'), /class="vt"/)
  assert.doesNotMatch(X.mdToHtml('某段话[1][2]。', []), /class="vt"/)
})
