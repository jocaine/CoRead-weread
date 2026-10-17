#!/usr/bin/env node
/**
 * 侧栏「会话会话开场」· 读书模式启动链自测（2026-11）
 *
 * 为什么单独一份：sidebar-free-conv.test.js 只覆盖了自由模式那半张卡。而用户真正
 * 第一眼看到的是**读书模式**（打开一本书、还没聊过）——那条路要经过
 * loadState → loadHistory → refreshCurrentBook → renderNoBookView 一整条启动链，
 * 卡出不来的原因往往在链子上（上下文还没认出来 / 历史还没回来），不在画卡的那几行。
 * 本文件把这条链子跑通，钉住三件事：
 *   ① 一场什么都没聊过的会话 → 卡出现，且带书名、带按钮；
 *   ② 已经聊过的会话（/history 有内容）→ 不出现（卡是给空会话用的，不是常驻横幅）；
 *   ③ 首条消息发出去 → 开场让位（dropIntro）。
 *
 * 跑法：node --test agent/test/sidebar-intro.test.js
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
  // className 与 classList 必须是**同一份真相**：真实 DOM 里 `el.className = 'msg-user'`
  // 之后 `el.classList.contains('msg-user')` 必然为真。第一版替身把两者做成互不相干的
  // 两个字段，于是"按 classList 判断"的代码在这个替身里永远为假——测试会报出一个
  // 产品里根本不存在的问题（2026-11 实测量到：collectQuestions 返回空数组）。
  const classes = new Set()
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    get className() { return [...classes].join(' ') },
    set className(v) {
      classes.clear()
      for (const c of String(v || '').split(/\s+/)) if (c) classes.add(c)
    },
    classList: {
      add(c) { classes.add(c) },
      remove(c) { classes.delete(c) },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c) },
      contains(c) { return classes.has(c) },
    },
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
    // 真 DOM 的 replaceChildren：清空再挂上给的那些节点。
    // 2026-11 补：侧栏的引用卡正文改用 `box.replaceChildren()` 之后，这个替身缺它就会抛
    // `box.replaceChildren is not a function`——那是**替身的洞**，不是产品的问题
    // （真元素一定有这个方法）。缺了它，这个文件里凡是会走到引用卡正文的测试全红。
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
  const hiddenInHtml = (id) => {
    const m = new RegExp('<(\\w+)([^>]*\\bid="' + id + '"[^>]*)>').exec(html)
    return !!(m && /(^|\s)hidden(\s|=|$)/.test(m[2]))
  }
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) {
      const el = makeEl(id)
      el.hidden = hiddenInHtml(id)
      // 临时诊断开关（CO_DEBUG_CARD=1）：谁把会话开场藏起来的，把调用栈打出来
      if (id === 'intro' && process.env.CO_DEBUG_CARD === '1') {
        let v = el.hidden
        Object.defineProperty(el, 'hidden', {
          get() { return v },
          set(nv) {
            if (nv && !v) console.log('HIDDEN BY:\n' + new Error().stack.split('\n').slice(1, 8).join('\n'))
            v = nv
          },
        })
      }
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
    removeEventListener() {},
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
  }
  return { doc, getById, ids }
}

const BOOK = { base: 'CB_aaaaaaaaaaaaaaaaaaaa', bookTitle: '静静的顿河 十四', wereadBookId: '123', updatedAt: Date.parse('2026-11-01') }
const ANN = {
  bookId: BOOK.base, bookTitle: BOOK.bookTitle, chapter: '卷二 第五章',
  chapterUid: 12, chapterUidInt: 12, bookmarkRange: '15-16',
  selectedText: '人不能因为出身就被判了罪。', receivedAt: Date.parse('2026-11-02'),
}

/**
 * @param {{history?: object[], anns?: object[], manualBook?: object|null, freeConvs?: object[]}} opts
 *   history  = /history 回放（空 = 这场会话什么都没聊过）
 *   anns     = 本地已存的引用（RECENT_ANNS 的来源）
 *   manualBook = 预置 storage 里的手动选书（复现"已读过的书也要能翻出来"那条路）
 *   freeConvs = /free-conversations 返回的对话清单（自由模式的"接着上一场"要用）
 */
function loadSidebar({ history = [], anns = [], manualBook = null, freeConvs = [] } = {}) {
  const { doc, getById, ids } = buildDom()
  const storage = {}
  if (manualBook) storage.manualBook = manualBook
  if (anns.length) { storage.refs = anns; storage.refNumCounter = anns.length }
  storage.selectedRef = anns.length ? { bookId: anns[0].bookId, selectedText: anns[0].selectedText } : null

  const fetchStub = async (url) => {
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    if (u.endsWith('/ping')) return json({ ok: true })
    if (u.includes('/api-config')) return json({ configured: true })
    if (u.includes('/history')) return json(history)
    if (u.includes('/books')) return json({ books: [BOOK] })
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.includes('/free-conversations')) {
      const active = freeConvs.filter((c) => c.status !== 'archived')
      return json({ current: active[0] ? active[0].key : null, lastActive: active[0] ? active[0].key : null, active, archived: [] })
    }
    if (u.includes('/graph')) return json({ nodes: [], edges: [] })
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
      query: async () => [],                 // 没有微信读书 tab → 走手动选书那条路
      sendMessage: async () => ({ ok: true, notReader: true }),
      onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    runtime: { sendMessage: async () => ({ ok: true, notReader: true }), onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://test/' + p, id: 'test' },
  }

  class EventSourceStub { constructor() {} close() {} }

  const ctx = {
    document: doc,
    // renderIntro 每次判定的留痕（见 sidebar.js 里的 __coreadIntroTrace）
    __coreadIntroTrace: [],
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' },
    navigator: { userAgent: 'node' },
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx
  ctx.self = ctx
  ctx.window.__coreadIntroTrace = ctx.__coreadIntroTrace
  ctx.window.document = doc
  // window 与 globalThis 里的定时器/日志是脚本运行时的同一套：脚本里用 `window.x` 读到的
  // 东西必须与 `x` 一致（introTracePost 读 window.__coreadIntroTrace 就是这个用法）。
  ctx.window.setTimeout = ctx.setTimeout
  ctx.window.clearTimeout = ctx.clearTimeout
  ctx.window.postSidebarDebug = () => {}

  const expose = `
;globalThis.__X = {
  pickBook, renderNoBookView, syncIntro, renderIntro, effectiveBookBase, addBubble, hasRealMsg,
  collectQuestions, nodesInContext, toggleFreeMode, switchFreeConversation, loadFreeConversations,
  trace: () => globalThis.__coreadIntroTrace,
  getState: () => ({ manualBook: _manualBook, freeMode: _freeMode, histLoaded: _histLoaded, anns: RECENT_ANNS.length, selectedAnn: selectedAnn ? selectedAnn.selectedText : null }),
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, getById, ids, storage }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

/**
 * 等启动链跑完（loadState → loadHistory → …）。
 *
 * 为什么要等：会话开场有一条闸门 `_histLoaded`（历史没回放完就先画卡，会被随后的历史
 * 替换掉，用户看到闪一下）。所以"卡在不在"这件事必须等 /history 那趟真的跑完再看——
 * 抢在中间断言，测的是闸门而不是卡。上面 flush() 只够跑几轮微任务，/history 那条链更长。
 */
async function settled(X) {
  for (let i = 0; i < 60; i++) {
    if (X.getState().histLoaded) return
    await flush(2)
  }
  throw new Error('启动链没跑完：/history 一直没回来')
}

// /history 里的一条标注回放（标记事件的形状与 receiver 一致）
const histAnn = (ann) => ({
  role: 'annotation', bookId: ann.bookId, bookTitle: ann.bookTitle, chapter: ann.chapter,
  chapterUid: ann.chapterUid, bookmarkRange: ann.bookmarkRange, selectedText: ann.selectedText,
})

test('#intro 这个节点确实在 sidebar.html 里（脚本按 id 取它）', () => {
  const { ids } = loadSidebar()
  assert.ok(ids.has('intro'), 'sidebar.html 里必须有 <div id="intro">')
})

test('有划线时也**只有三行**：主句 + 箴言 + 署名，划线不出现', async () => {
  // 划线通过 /history 回放进来（与真实一致：那条标注既是引用、也在历史里）。
  // 只往 storage.refs 里塞、而 /history 里没有，会被 loadHistory 的**对账清理**当幽灵引用删掉
  //（微信读书里删了划线就该消失，这条规则本身是对的）。
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)            // 手动进这本书（等价于"已读过的书翻出来看"）
  await flush()
  const el = getById('intro')
  const html = el.innerHTML
  assert.equal(X.effectiveBookBase(), BOOK.base, '上下文已切到这本书')
  assert.equal(el.hidden, false, '空会话 → 开场可见')
  assert.equal(el.dataset.book, BOOK.base, '归属这本书')
  // 开场**永远三行**，有划线也不变形
  const divs = [...html.matchAll(/<div class="(it-[a-z-]+)"/g)].map((m) => m[1])
  assert.deepEqual(divs, ['it-cap', 'it-motto', 'it-from'], '结构就是三行：主句 → 箴言 → 署名')
  // ⚠️ 2026-11 用户定调："开场里不该显示那行划线"。它是**内容**不是提示，
  // 下方「📌 当前引用」卡片已经在显示它了。这一条就是防止它再被加回来。
  assert.equal(/it-quote/.test(html), false, '开场里不许有引文块')
  assert.equal(/人不能因为出身就被判了罪/.test(html), false, '划线原文不许出现在开场里')
  assert.equal(/卷二 第五章/.test(html), false, '章节号也不许出现')
  // 主句：**固定一句**（用户否掉了按"有没有划线"分两种文案的写法），也不写书名
  assert.match(html, /it-cap[^>]*>这本书还没有对话/, '主句固定一句，不写书名、不随有没有划线变')
  assert.ok(html.indexOf('it-cap') < html.indexOf('it-motto'), '主句排在箴言之前（语用优先于修辞）')
  assert.match(html, /it-motto">这里必须根绝一切犹豫</, '箴言在（用户挑的那句：卡尔·马克思）')
  assert.match(html, /it-from">卡尔·马克思</, '署名只留人名，不写书名号那一串')
  assert.equal(/政治经济学批判/.test(html), false, '出处那串书名号已按用户要求去掉')
  assert.equal(/拉康/.test(html), false, '换箴言要换干净，旧的那句不许残留')
  // 2026-11 用户定调：拒绝"说明书感"——盒子、标题行、末行小字、占满整宽的按钮都不许回来
  assert.equal(/it-foot/.test(html), false, '末行小字已删（规则挪进悬停提示）')
  assert.equal(/it-sub/.test(html), false, '副文案行已删')
  assert.equal(/这场共读还没开始/.test(html), false, '那句"系统公告"式标题已删')
  // "小绿线"事件（2026-11）：一道 20×2px 的淡绿横线只当装饰用，用户一句"这是什么玩意"否掉。
  // 不指代任何东西的元素不许进空态——这条断言就是防它回来。
  assert.equal(/it-mark/.test(html), false, '不解释自己的装饰（那道小绿线）不许回来')
  assert.match(html, /title="[^"]*它知道你读到哪/, '产品规则挂在悬停提示上，不占屏幕')
})

test('开场里一个按钮都不许有（五颗都被用户否掉过，是最终版）', async () => {
  // 2026-11 定调：**空会话里不该有能点的东西**。走到这一版之前挂过五颗，全被否：
  //   「提个问题」「说点什么」——只是把光标挪进输入框（输入框就在下面）
  //   「选一条已有的划线」——这场对话还没有引用，让空会话去选引用是自相矛盾
  //   「接着说某场对话」——用户是新建一场进来的，劝他聊别的等于说"你建的这个多余"
  //   「先说我的看法」「从会意图里选个知识点」——用户原话："多余的"
  // 动作入口已经有两处：输入框（想说什么直接打）+ 引用卡/书里的划线（起点）。
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  const html = getById('intro').innerHTML
  assert.equal(/<button/.test(html), false, '有划线时也不许有按钮')
  assert.equal(/data-act=/.test(html), false, '连动作标记都不该有：没有动作可绑')
  assert.equal(/it-act/.test(html), false, '胶囊样式也不该被用上')
  // 划线曾经也被算成"这一格里要留的会信息"，现在它整块都不在开场里（见上一条测试）。
  assert.equal(/卷二 第五章/.test(html), false, '开场里也没有引文（划线由下方引用卡负责显示）')
})

test('没有任何划线（新建会话的主场景）→ 同样三行，一颗按钮都不给', async () => {
  // 2026-11 用户定调："你不能预设有一个引用，而且往往就是一条引用还没有。"
  // 没有划线是**新建会话的主场景**；这一条钉两件事：结构不变形、且不出现任何按钮。
  const { X, getById } = loadSidebar()
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  const el = getById('intro')
  const html = el.innerHTML
  assert.equal(el.hidden, false, '仍然出现（这才是最需要说清楚的状态）')
  // 与"有划线"时**完全一样**——结构三行、主句同一句。
  // 这就是"不加 hasAnn 判断"的验证：两种情况下 HTML 应该一模一样。
  const divs = [...html.matchAll(/<div class="(it-[a-z-]+)"/g)].map((m) => m[1])
  assert.deepEqual(divs, ['it-cap', 'it-motto', 'it-from'], '没有划线时也是同样三行')
  assert.ok(html.indexOf('it-cap') < html.indexOf('it-motto'), '主句在箴言之前')
  assert.match(html, /it-cap[^>]*>这本书还没有对话/, '主句与"有划线"时是同一句')
  assert.match(html, /it-motto">这里必须根绝一切犹豫</, '没有划线时箴言照旧在（负责填空）')
  assert.equal(/<button/.test(html), false, '一颗按钮都不给：这场共读开不了张，给了也是自相矛盾')
  assert.equal(/it-quote/.test(html), false, '开场里不许有引文块（有没有划线都不许）')
})

test('不加 hasAnn 判断：有划线 / 没划线，开场 HTML 必须逐字节相同', async () => {
  // 2026-11 用户原话："不要再加这个 hasAnn 的判断了，都用'这本书还没有对话'"。
  // 上面两条分别验了两种情况各自的文案；这一条验**两种情况之间没有分叉**——
  // 逐字节相同才算真的没有分支（一比就露：哪怕只差一个空格也是分支）。
  const withAnn = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(withAnn.X)
  withAnn.X.pickBook(BOOK)
  await flush()
  const noAnn = loadSidebar()
  await settled(noAnn.X)
  noAnn.X.pickBook(BOOK)
  await flush()
  const a = withAnn.getById('intro').innerHTML
  const b = noAnn.getById('intro').innerHTML
  assert.equal(a.length > 0, true, '前提：两种情况都画出了开场')
  assert.equal(a, b, '有没有划线，开场一个字都不该差')
})

test('已经聊过的会话（/history 有内容）→ 不出现开场，且居中态撤掉', async () => {
  const history = [
    { role: 'user', content: '这句话为什么这么说？', bookId: BOOK.base, bookTitle: BOOK.bookTitle, _ts: 1000 },
    { role: 'assistant', content: '因为……', bookKey: BOOK.base, _ts: 1001 },
  ]
  const { X, getById } = loadSidebar({ history, anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  assert.equal(getById('intro').hidden, true, '有历史消息 → 开场不出现')
  assert.equal(getById('msgs').classList.contains('intro-on'), false,
    '居中态必须撤掉（否则消息会从中间开始排）')
  assert.ok(getById('msgs').children.length > 0, '历史消息已渲染进消息区')
})

test('首条消息发出去 → 开场让位', async () => {
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  assert.equal(getById('intro').hidden, false, '前提：卡已在屏上')
  X.addBubble('user', '我的看法是……', null, null, BOOK.base)
  assert.equal(getById('intro').hidden, true, '消息一落，卡收起（这是"空态"，不是常驻横幅）')
})

test('别的书的气泡留在消息区里（隐藏）→ 不算"已有内容"，卡照样出现', async () => {
  // 2026-11 的真实故障：消息区是**所有书共用一个容器**，切书只把别的书的气泡置成
  // display:none、不从 DOM 移除，于是里面有几百条别的书的消息。当时的判据只数
  // "有没有子元素"，于是永远判定"已有内容"，会话开场两轮都没露面——
  // 屏幕上什么都没有，日志里却是 real=true。这条就是钉住这个坑。
  const OTHER = { ...ANN, bookId: 'CB_bbbbbbbbbbbbbbbbbbbb', bookTitle: '另一本书', selectedText: '另一本书里的划线' }
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  const msgs = getById('msgs')
  // 摆上别的书的三条气泡 + 一个思考中（都打了别的书的标）
  for (let i = 0; i < 3; i++) {
    const el = makeEl(); el.dataset.book = OTHER.bookId; el.className = 'msg-user'; msgs.appendChild(el)
  }
  const th = makeEl(); th.className = 'msg-thinking'; th.dataset.book = OTHER.bookId; msgs.appendChild(th)
  X.pickBook(BOOK)
  await flush()
  // 真实浏览器里它们此刻是隐藏的（applyBookFilter 按 data-book 过滤）；替身里手动对齐
  for (const el of msgs.children) { if (el.dataset.book === OTHER.bookId) el.style.display = 'none' }
  assert.equal(X.hasRealMsg(), false, '别的书的消息（隐藏）不算内容')
  assert.equal(getById('intro').hidden, false, '卡照样出现')
  // 当前书自己来一条 → 才算有内容
  const mine = makeEl(); mine.dataset.book = BOOK.base; mine.className = 'msg-user'; msgs.appendChild(mine)
  assert.equal(X.hasRealMsg(), true, '当前书的消息才算内容')
})

test('别的书来消息，不该把当前空对话的会话开场摘掉', async () => {
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  assert.equal(getById('intro').hidden, false, '前提：卡在屏上')
  X.addBubble('user', '别的书里的一句话', null, null, 'CB_bbbbbbbbbbbbbbbbbbbb')
  assert.equal(getById('intro').hidden, false, '别的书的消息被过滤掉，当前这场对话还是空的')
  assert.equal(X.hasRealMsg(), false, '当前上下文仍然算"没内容"')
  X.addBubble('user', '这本书里的一句话', null, null, BOOK.base)
  assert.equal(getById('intro').hidden, true, '当前书的消息一落，卡才让位')
})

test('提问浮窗的取数：只收当前会话的提问（别的书/别的对话的不要）', async () => {
  // 这条覆盖"消息区遍历收进唯一入口"之后的 collectQuestions：它原先自己写
  // `style.display === 'none'` 判断，现在走 nodesInContext()。判据必须与过滤一致，
  // 否则浮窗会列出别的书的提问（点进去跳到看不见的气泡上）。
  const OTHER = { ...ANN, bookId: 'CB_bbbbbbbbbbbbbbbbbbbb', bookTitle: '另一本书' }
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  const msgs = getById('msgs')
  const mk = (book, cls) => { const el = makeEl(); el.dataset.book = book; el.className = cls; msgs.appendChild(el); return el }
  mk(OTHER.bookId, 'msg-user')            // 别的书的提问
  mk(OTHER.bookId, 'msg-assistant')       // 别的书的回答（不是提问）
  X.pickBook(BOOK)
  await flush()
  for (const el of msgs.children) { if (el.dataset.book === OTHER.bookId) el.style.display = 'none' }
  const mineA = mk(BOOK.base, 'msg-user') // 本书的提问 → 该被收
  const mineB = mk(BOOK.base, 'msg-assistant')
  const list = X.collectQuestions()
  // 按**身份**比，不用 deepEqual：DOM 节点是循环结构，深度比较永远不成立
  assert.equal(list.length, 1, '只收当前书的提问')
  assert.equal(list[0], mineA, '收的正是当前书那条 msg-user')
  assert.equal(list.includes(mineB), false, '回答不算提问')
})

test('自由模式：固定一句"这是一场自由对话"，不写第几场，也不出按钮', async () => {
  // 2026-11 用户定调两条：
  //   ① 不写"这是第 N 场自由对话"——场次是个跟用户当下意图无关的计数器：他刚新建一场，
  //      关心的是"这场能干什么"，不是编号；缩到只剩一场时数字还会跳（2 → 1）更奇怪。
  //   ② 按钮全删："从会意图里选个知识点"也被点名"多余的"。
  // 这里给了两场对话（KEY_A 有 6 条消息）正是为了证明：**有编号可写也不写**。
  const KEY_A = '__coread_free_aaaaaaaa__'   // 另一场（有消息）
  const KEY_B = '__coread_free_bbbbbbbb__'   // 当前这场（空）
  const { X, getById } = loadSidebar({
    freeConvs: [
      { key: KEY_A, title: '哥萨克问题', messages: 6, createdAt: 100, updatedAt: 200, lastAt: 200, status: 'active' },
      { key: KEY_B, title: '', messages: 0, createdAt: 300, updatedAt: 300, lastAt: 0, status: 'active' },
    ],
  })
  await settled(X)
  X.toggleFreeMode()
  await flush()
  await X.switchFreeConversation(KEY_B)
  await flush()
  const el = getById('intro')
  const html = el.innerHTML
  assert.equal(el.hidden, false, '空的自由对话 → 开场可见')
  assert.match(html, /it-cap[^>]*>这是一场自由对话</, '固定一句，不编号')
  assert.equal(/第 \d+ 场/.test(html), false, '不许出现场次编号（哪怕清单里有 2 场）')
  assert.equal(/<button/.test(html), false, '一颗按钮都不给')
  assert.equal(/哥萨克问题/.test(html), false, '别场对话的名字也不该出现')
  // 层次与读书模式一致：主句 → 箴言 → 署名
  assert.ok(html.indexOf('it-cap') < html.indexOf('it-motto'), '主句在箴言之前')
})

test('#intro 那段 CSS 不许再自己限宽（限了就会在长书名上断行）', () => {
  // 2026-11 实测：`max-width: 284px` + `padding: 0 6px` 让文字可用宽只剩 272px，
  // 而"《失明症漫记（罗翔推荐）》还一句话没聊过"要 ≈270px——差几像素就断行。
  // 文案长度是**书名决定的**，跟一个拍出来的常数没关系；这种组合早晚会崩。
  // 所以这条断言盯的是"别再往 #intro 上加死宽"。
  const css = fs.readFileSync(HTML, 'utf8')
  const introBlock = /#intro\s*\{([^}]*)\}/.exec(css)
  assert.ok(introBlock, 'sidebar.html 里应能找到 #intro 的样式块')
  const body = introBlock[1]
  assert.equal(/max-width/.test(body), false, '#intro 不许写 max-width（交给父容器）')
  assert.equal(/[^-]width\s*:/.test(body), false, '#intro 不许写固定 width')
  assert.match(body, /text-align:\s*center/, '内容居中')
})

test('判定留痕：卡"该出现却没出现"时，日志里能看出是哪一条判据挡的', async () => {
  // 这条是给下一次排查用的（2026-11 已经因为"看不出来"白跑过一轮）：
  // 三种原因在界面上长得一模一样 —— 都是"什么都没有"。
  const { X, getById } = loadSidebar({ history: [histAnn(ANN)], anns: [{ ...ANN }] })
  await settled(X)
  X.pickBook(BOOK)
  await flush()
  const tr = X.trace()
  assert.ok(tr.length > 0, 'renderIntro 每次判定都留痕')
  const last = tr[tr.length - 1]
  assert.equal(last.base, BOOK.base, '记下了当时的上下文')
  assert.equal(last.loaded, true, '记下了 /history 是否回放完')
  assert.equal(last.real, false, '记下了消息区是否已有内容')
  assert.equal(last.free, false, '记下了是哪种模式')
  assert.equal(getById('intro').hidden, false, '这条判定确实画出了卡')
})
