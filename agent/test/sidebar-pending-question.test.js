#!/usr/bin/env node
/**
 * 「思考中关掉面板、再打开 → 提问气泡与思考气泡都要回来」DOM 层冒烟自测（2026-11 用户报）
 *
 * 用户原话：「插件正在思考的时候，关闭插件，然后再打开，最新提问的气泡和正在思考回答的
 * 气泡都不见了，只能等到思考完成后，再重新打开插件才能看到气泡回来」。
 *
 * 这条链路横跨两个文件，两边各错一半，所以这里两半都锁：
 *   · receiver 半边（源码级守卫）：`/history` 原先不管角色一律把 `status==='pending'` 的行
 *     滤掉——在途提问压根没进历史，侧栏就算想画也无从画起；
 *   · 侧栏半边（跑真 sidebar.js）：拿到带 `pending` 标记的提问行时，要画出提问气泡、
 *     恢复「思考中」气泡，并让发送按钮回到「停止」（重开后状态与关掉前一致）。
 *
 * 跑法：node --test agent/test/sidebar-pending-question.test.js
 * 与真浏览器的差距：DOM 是替身（不跑层叠、不排版），只验证"该出现的元素出现了、按钮该变
 * 的态变了"；SSE 实时流那半条路由 sidebar-free-conv / sidebar-stop 等测试覆盖。
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
const RECEIVER_SRC = path.join(ROOT, 'receiver', 'index.js')

/**
 * sidebar.js 顶层的 `loadTutorial()` 是**没有 catch** 的动态 import（教程引导那两个
 * ES module）。vm 沙箱里跑不了动态 import（要 `--experimental-vm-modules`），于是它
 * 必然留下一个未处理的拒绝；node:test 会把这个拒绝算到**当时正在跑的测试**头上，
 * 于是与它毫无关系的断言被一起判红（实测：本文件 6 条里 5 条报
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，而真正的原因是装载脚本时就欠了这一笔）。
 *
 * 这里只吞掉这一种（按 error.code 认），别的一律原样抛出——不拿它当"让测试变绿"的挡箭牌。
 */
const VM_IMPORT_ERR = 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'
process.on('unhandledRejection', (e) => {
  if (e && e.code === VM_IMPORT_ERR) return
  throw e
})

// ── DOM 替身（与 sidebar-free-conv.test.js 同一套；改动请两边同步）────────────
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
    // 真脱钩：hideThinking / finishStoppedTurn 都是靠 remove() 撤气泡的，
    // 替身里若写成空函数，"气泡还在不在"就永远断言不出来（本测试第一版就栽在这）
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
 * @param {Array} history GET /history 的返回（就是本测试要喂的"库里那份历史"）
 */
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
    // 定时器不执行回调：恢复轮询是 setTimeout 驱动的，同步执行会让
    // loadHistory ↔ scheduleRecoverPoll 递归到爆栈（与 sidebar-free-conv.test.js 同款）
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
  // 面板打开时会检测到"正在读的书"（refreshCurrentBook → applyBookContext）。
  // 测试里直接给一个，免得按书过滤把所有气泡都隐藏了（那会让断言看不出真假）。
  setBook: (base) => { _currentBook = base ? { base, bookTitle: '测试书' } : null; applyBookFilter() },
  setTicks: (n) => { _recoverTicks = n },
  state: () => {
    const msgs = document.getElementById('msgs')
    const cls = (c) => msgs.children.filter((el) => String(el.className).split(/\\s+/).includes(c))
    return {
      bubbles: msgs.children.length,
      users: cls('msg-user').length,
      thinkings: cls('msg-thinking').length,
      userText: cls('msg-user').map((el) => el.innerHTML).join(' | '),
      visibleUsers: cls('msg-user').filter((el) => el.style.display !== 'none').length,
      awaiting: _awaitingStop,
      awaitTs: _awaitTs,
      awaitBook: _awaitBook,
      awaitContent: _awaitContent,
      hasAwaitEl: !!_awaitUserEl,
      sendLabel: (document.getElementById('send-btn') || {}).textContent,
      recoverTicks: _recoverTicks,
      recoverTs: _recoverTs,
    }
  },
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, calls, storage, doc, ids, getById }
}

// 等若干轮微任务（脚本里全是 await fetch 链）
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const REF_Q = '[引用]《大国大城》欧洲正经历大考\n> "在应对全球经济危机的过程中"\n\n为什么统一市场对工人更重要？'
const PENDING = { role: 'user', content: '为什么统一市场对工人更重要？', _ts: 1791700000000, bookId: 'b1', pending: true }
const DONE_Q = { role: 'user', content: '上一轮的问题', _ts: 1791690000000, bookId: 'b1' }
const ANSWER = { role: 'assistant', content: '因为……', _ts: 1791690001000, bookKey: 'b1' }

// ── receiver 半边：在途提问必须回放 ─────────────────────────────────────────
test('守卫：/history 不许把在途提问（pending 的 user 行）一起滤掉', () => {
  const src = fs.readFileSync(RECEIVER_SRC, 'utf8')
  // 条件可能是 `req.url === '/history'` 或带参数的 `req.url.split('?')[0] === '/history'`
  // （2026-10-25 加了 ?book= 单本补拉），两种形状都要能定位到这一段。
  const at = src.search(/req\.method === 'GET' && req\.url(?:\.split\('\?'\)\[0\])? === '\/history'/)
  assert.ok(at > 0, '找不到 /history 分支')
  const block = src.slice(at, at + 8000)
  const line = block.split('\n').find((l) => l.includes("status === 'pending'"))
  assert.ok(line, '/history 里应该有对 pending 行的处理（本轮修复的核心）')
  assert.ok(/m\.role !== 'user'/.test(line),
    'pending 行只能跳过非 user 的（回答落库即 ok/failed）；user 的在途提问必须回放，'
    + '否则"思考中关掉面板再打开"既没有提问气泡也没有思考气泡。实际那行是：' + line.trim())
  assert.ok(/item\.pending = true/.test(block), '回放时必须带上 pending 标记，侧栏据此恢复「停止」态')
})

// ── 侧栏半边：面板打开（顶层 loadState → loadHistory 链） ────────────────────
test('在途提问：提问气泡 + 思考气泡 + 按钮回「停止」，一次打开就都在', async () => {
  const { X, getById } = loadSidebar({ history: [DONE_Q, ANSWER, PENDING] })
  await flush()
  X.setBook('b1')
  const s = X.state()
  assert.equal(s.users, 2, '两条提问（已完成那条 + 在途这条）都要画出来')
  assert.equal(s.thinkings, 1, '在途提问要恢复「思考中」气泡——这就是原先丢掉的那颗')
  assert.equal(s.awaiting, true, '按钮回「停止」：重开后状态与关掉前一致')
  assert.equal(s.sendLabel, '停止', '发送按钮就地变「停止」')
  assert.equal(s.awaitTs, PENDING._ts, '停止请求要带这条提问的落库时间戳（否则 agent 认不出是哪一轮）')
  assert.equal(s.awaitBook, 'b1', '停止信号按对话隔离，归属不能错')
  assert.equal(s.hasAwaitEl, true, '停止收尾要删掉这颗提问气泡，得记住它')
  assert.equal(s.visibleUsers, 2, '当前书就是这条提问的书 → 气泡可见（不是被按书过滤藏了）')
})

test('幂等：重复 loadHistory（恢复轮询每 2 秒跑一趟）不会长出第二个气泡', async () => {
  const { X } = loadSidebar({ history: [PENDING] })
  await flush()
  const before = X.state()
  await X.loadHistory()
  await X.loadHistory()
  const after = X.state()
  assert.equal(after.users, before.users, '提问气泡不重复')
  assert.equal(after.thinkings, 1, '思考气泡也不重复')
})

test('回复落库后（pending 消失）不再有思考气泡，按钮回「发送」', async () => {
  const { X } = loadSidebar({ history: [PENDING, { ...ANSWER, _ts: PENDING._ts + 1000 }] })
  await flush()
  const s = X.state()
  assert.equal(s.users, 1)
  assert.equal(s.thinkings, 0, '最新一条是回答 → 不在等回答')
  assert.equal(s.awaiting, false, '按钮保持「发送」')
  assert.equal(s.recoverTicks, 0, '没有在途提问就不挂恢复轮询')
})

test('空历史不误报：没有提问就没有思考气泡', async () => {
  const { X } = loadSidebar({ history: [] })
  await flush()
  const s = X.state()
  assert.equal(s.users, 0)
  assert.equal(s.thinkings, 0)
  assert.equal(s.awaiting, false)
})

// ── 停止收尾：回填输入框的正文不能带 [引用] 前缀 ────────────────────────────
test('在途的引用提问：恢复的「停止」用的是提问正文，不是库里的 [引用] 前缀那一串', async () => {
  const { X, getById } = loadSidebar({
    history: [{ role: 'user', content: REF_Q, _ts: 1791700000123, bookId: 'b1', pending: true }],
  })
  await flush()
  const s = X.state()
  assert.equal(s.thinkings, 1)
  assert.equal(s.awaitContent, '为什么统一市场对工人更重要？',
    '停止会把 _awaitContent 覆盖回输入框——带上前缀就等于把 [引用]《书名》灌进输入框')
  // 气泡本身按"带引用的提问"渲染：前缀已成上方横幅（只有原文），正文另起一块
  //（2026-11 用户定调；详见 sidebar-quote-banner.test.js）
  assert.match(s.userText, /uq-quote/, '引用原文走上方横幅')
  assert.match(s.userText, /uqq-text">"在应对全球经济危机的过程中"/, '横幅里是原文')
  assert.doesNotMatch(s.userText, /\[引用\]/, '库里的前缀不该再原样显示在气泡里')
  assert.equal(getById('send-btn').textContent, '停止')
})

// ── 兜底：等了 2 分钟还没回答，不能永远转圈 ─────────────────────────────────
test('轮询预算用尽仍无回答：撤掉思考气泡 + 提示，按钮回「发送」', async () => {
  const { X, getById } = loadSidebar({ history: [PENDING] })
  await flush()
  assert.equal(X.state().thinkings, 1, '前置：一开始恢复了思考气泡')
  X.setTicks(60)            // RECOVER_MAX_TICKS：≈2 分钟
  await X.loadHistory()
  const s = X.state()
  assert.equal(s.thinkings, 0, '不能永远挂着"思考中"（本机服务没跑 / agent 被强杀都会走到这里）')
  assert.equal(s.awaiting, false, '按钮回「发送」，用户能继续用')
  assert.equal(getById('toast').classList.contains('on'), true, '要说明为什么不等了')
  assert.match(getById('toast').textContent, /没在运行|没等到/, 'toast 文案要说清原因')
})
