#!/usr/bin/env node
/**
 * 「停止当前回答」· 侧栏 DOM 层冒烟自测（2026-02）
 *
 * 为什么需要它：这个功能的删除动作跑在 DOM 上，而**删错东西**是最难自查的一类 bug ——
 * 实测踩过一次：正常提问的提问气泡也没了。成因是 SSE 断线重连会补发最近 100 条事件，
 * 于是一次停止的旧 message-stopped 在下一轮提问时被重放，把新气泡连带删掉。
 * 本文件把这个场景固化成回归测试（第三条），并覆盖两条基本路径（提问气泡在 / 停止要生效）。
 *
 * 2026-11 补几条（用户实测《Theories of German Fascism》会话）：停止之后 agent 才吐出来的
 * 那一片流式分片，会被画成一颗没有提问的小气泡（「这句话」）永久留屏。一条钉住侧栏的认领
 * 规则，一条钉住 agent 侧的跨文件契约（流记录必须带这一轮的身份证）；另外两条钉住按钮态
 * ——**整条回答写完之前都能停**（回答一开始打字就变回「发送」是 bug），一条钉住"停止赶在
 * /chat 回执之前"的窄缝（那时还没有身份证，要等回执补登记）。
 *
 * 与真实浏览器的差距：canvas / SSE / fetch 都是替身，只验证"结构、状态、DOM 读写路径"。
 * 跑法：node --test agent/test/sidebar-stop.test.js
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
    id, children: [], dataset: {}, style: {}, hidden: false, disabled: false, checked: false,
    value: '', textContent: '', _html: '', title: '', placeholder: '', scrollTop: 0, scrollHeight: 0,
    clientHeight: 0, isComposing: false, _h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    // maybeAutoScroll 读的是 parentElement（裸 DOM 属性），不补上就会在流式渲染里崩
    get parentElement() { return this.parent || null },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    querySelector() { return makeEl() },
    querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null }, focus() {}, select() {},
    setSelectionRange() {}, getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
  return el
}

function loadSidebar({ graphViewStub = null, stackHits = [], stackUsed = null } = {}) {
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
    querySelector: () => makeEl(), querySelectorAll: () => [], _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener() {}, dispatch() {},
  }
  const calls = []
  let chatSeq = 0
  const chatStamps = []   // 每次 /chat 落库的 timestamp（真实环境里每条都不同，重放才分得清轮次）
  const fetchStub = async (url, opts = {}) => {
    const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: opts.method || 'GET', body })
    const json = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o })
    if (u.endsWith('/ping')) return json({ ok: true })
    if (u.endsWith('/chat')) { const ts = 1770000000000 + (++chatSeq) * 1000; chatStamps.push(ts); return json({ ok: true, timestamp: ts }) }
    if (u.endsWith('/session-stop')) return json({ ok: true })
    if (u.includes('/stack-hits')) return json({ hits: stackHits, used: stackUsed })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
    if (u.endsWith('/history')) return json([])
    if (u.endsWith('/free-conversations')) return json({ current: null, active: [], archived: [] })
    return json({})
  }
  const ctx = {
    document: doc, window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      tabs: { query: async () => [], sendMessage: async () => null, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      runtime: { sendMessage() {}, onMessage: { addListener() {} } } },
    fetch: fetchStub, EventSource: class { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null } close() {} },
    AbortController, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' }, navigator: { userAgent: 'node' },
    CoReadGraphView: graphViewStub ? { GraphView: graphViewStub } : undefined,
  }
  ctx.globalThis = ctx; ctx.self = ctx
  const expose = '\n;globalThis.__X = { submit, finishStoppedTurn, isCurrentTurn, requestStop, handleStream: _handleStream, toggleFreeMode, addFreeRef, emit: (d) => sseConn && sseConn.onmessage && sseConn.onmessage({ data: JSON.stringify(d) }), getState: () => ({ awaiting: _awaitingStop, userEl: _awaitUserEl, awaitTs: _awaitTs, streamEl: _streamEl, streamDone: _streamDone, discarded: _discardedTurnTs, content: _awaitContent, hitBook: _hitBook, freeMode: _freeMode, freeRefs: _freeRefs.map((r) => ({ id: r.id, auto: !!r.auto })) }), applyBookFilter, renderNoBookView, effectiveBookBase };'
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, calls, chatStamps, getById }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

test('复现：正常提问后提问气泡仍在 msgs 里', async () => {
  const { X, calls, getById } = loadSidebar()
  await flush()
  const msgs = getById('msgs')
  const before = msgs.children.length
  getById('input').value = '这段话到底在反驳谁？'
  await X.submit()
  await flush()
  const st = X.getState()
  const after = msgs.children.length
  const attached = st.userEl ? (st.userEl.parent === msgs) : null
  console.log('  [repro] msgs.children: before=%d after=%d', before, after)
  console.log('  [repro] awaiting=%s userEl存在=%s 仍挂在msgs上=%s', st.awaiting, !!st.userEl, attached)
  console.log('  [repro] /chat 调用数=%d', calls.filter((c) => c.url.endsWith('/chat')).length)
  assert.ok(after > before, `提问气泡应当被追加上去（${before} → ${after}）`)
  assert.equal(attached, true, '提问气泡在 submit() 结束后还挂在 msgs 上')
})

// ── 回归：SSE 重放的旧停止事件不得删掉新一轮的气泡 ──────────────────────────
// 真实现象（2026-02 用户实测）：正常提问的提问气泡也没了。
// 成因：message-stopped 只按对话隔离，而删除不认轮次；SSE 断线重连会补发最近 100 条事件，
// 于是一次停止的旧事件在下一轮提问时被重放 → 把新气泡连带删掉。
test('回归：重放的旧 message-stopped 不能删掉新一轮的提问气泡', async () => {
  const { X, getById, chatStamps } = loadSidebar()
  await flush()
  const msgs = getById('msgs')

  // 第 1 轮：提问 → 停止（记下它的 timestamp，这是"哪一轮"的身份证）
  getById('input').value = '第一问'
  await X.submit()
  await flush()
  const firstTs = chatStamps[0]
  X.finishStoppedTurn({ content: '第一问', bookKey: '', timestamp: firstTs, force: true })
  console.log('  [replay] 第1轮 ts=%d 停止后 msgs.children=%d', firstTs, msgs.children.length)

  // 第 2 轮：正常提问（没有任何停止）
  getById('input').value = '第二问（正常提问）'
  await X.submit()
  await flush()
  const afterSubmit = msgs.children.length
  const st = X.getState()
  console.log('  [replay] 第2轮 ts=%d 提问后 msgs.children=%d awaiting=%s', st.awaitTs, afterSubmit, st.awaiting)

  // 断线重连把第 1 轮的停止事件补发了一次（timestamp 是第 1 轮的，与当前轮不同）
  X.finishStoppedTurn({ content: '第一问', bookKey: '', timestamp: firstTs })
  const afterReplay = msgs.children.length
  console.log('  [replay] 收到旧停止事件（ts=%d）后 msgs.children=%d', firstTs, afterReplay)

  assert.ok(afterSubmit >= 2, '第二问的提问气泡 + 思考气泡都在')
  assert.equal(afterReplay, afterSubmit, '重放的旧停止事件不得删掉当前屏幕上的任何气泡')
  assert.equal(X.isCurrentTurn({ bookKey: '', timestamp: firstTs }), false, '旧轮次的 timestamp 判为"不是本轮"')
})

// ── 回归：停止之后才到的流式分片不得长出"无主小气泡"（2026-11 用户实测）─────────
// 真实现象（《Theories of German Fascism》会话）：点「停止」后屏幕上又冒出一颗小气泡，
// 里面就三个字「这句话」，永远留在那儿、排在后一条回答上方。
// 成因链条（stream.jsonl 与 debug.jsonl 对得上）：
//   19:58:08.982 点停止 → 侧栏本地收尾（此刻还没有任何流式气泡，hasStreamEl=false）
//   19:58:17.611 被弃那一轮的**第一个 token** 才到（content="这句话"，_stream=80）
//   19:58:17.613 agent 才读到停止信号，补一条 _stream=-1
// 侧栏收到那一片时 _streamEl 已经是 null → 新建一颗气泡把那半句画上；-1 只是置完成标志，
// 气泡留着；而被弃那一轮**不会再有完整回答落库**来补它 → 小气泡永久留屏。
// 修法：流记录带上这一轮的身份证 replyToTs，侧栏认出"属于已弃那轮"就整条丢掉。
test('回归：停止之后才到的分片不得长出无主小气泡', async () => {
  const { X, getById, chatStamps } = loadSidebar()
  await flush()
  const msgs = getById('msgs')
  const assistants = () => msgs.children.filter((c) => c.className === 'msg-assistant')

  // 第 1 轮：提问 → 点停止（模型还在思考，一颗流式气泡都还没有）
  getById('input').value = '第一问（等不及，停掉）'
  await X.submit()
  await flush()
  const stoppedTs = chatStamps[0]
  X.finishStoppedTurn({ content: '第一问（等不及，停掉）', bookKey: '', timestamp: stoppedTs, force: true })
  assert.equal(X.getState().discarded, stoppedTs, '停止收尾要登记这一轮的身份证')

  // 用户改口问了下一题（真实时间线里只隔了 4 秒）
  getById('input').value = '第二问'
  await X.submit()
  await flush()
  const nextTs = chatStamps[1]

  // 被弃那一轮的分片 + 结束标记此刻才到（带着它自己的身份证）
  X.handleStream({ role: 'assistant', content: '这句话', _stream: 80, replyToTs: stoppedTs })
  X.handleStream({ role: 'assistant', content: '', _stream: -1, replyToTs: stoppedTs })
  console.log('  [straggler] 残片到达后回答气泡数=%d streamDone=%s', assistants().length, X.getState().streamDone)
  assert.equal(assistants().length, 0, '已弃那一轮的残片不得画成气泡')
  assert.equal(X.getState().streamDone, false, '残片的 -1 也不能置完成标志（会被下一条回答误用）')

  // 新一轮自己的分片照常画——闸门不能把正常流式也挡了
  X.handleStream({ role: 'assistant', content: '第二问的回答', _stream: 81, replyToTs: nextTs })
  console.log('  [straggler] 新一轮分片到达后回答气泡数=%d', assistants().length)
  assert.equal(assistants().length, 1, '新一轮的分片照常渲染')
})

// ── 回归：整条回答写完之前都能停（2026-11 用户定调复核）────────────────────────
// 真实现象：回答一开始打字，按钮就变回「发送」—— 那一刻想停也停不了，只能等它写完。
// 成因：按钮态原来只跟「思考气泡」走（hideThinking 顺手调 finishWaiting），而流式第一片
// 到达时正好会撤思考气泡 →「停止」活不过回答的第一个字。
// 现在按钮态按"这一轮的真实进度"算：在等回答 / 气泡在长 / 流吐完等落库，三者都算进行中。
test('回归：回答已经开始打字，按钮仍是「停止」、点下去真的能停', async () => {
  const { X, calls, getById, chatStamps } = loadSidebar()
  await flush()
  const msgs = getById('msgs')
  const btn = getById('send-btn')
  const assistants = () => msgs.children.filter((c) => c.className === 'msg-assistant')

  getById('input').value = '一个会写很长的问题'
  await X.submit()
  await flush()
  const ts = chatStamps[0]
  assert.equal(btn.textContent, '停止', '刚发出去：按钮是「停止」')

  // 回答开始吐字（这一片以前会把按钮打回「发送」）
  X.handleStream({ role: 'assistant', content: '第一段', _stream: 1, replyToTs: ts })
  console.log('  [stop-midway] 打字中按钮="%s" 流式气泡数=%d', btn.textContent, assistants().length)
  assert.equal(assistants().length, 1, '回答气泡已经出现（正在打字）')
  assert.equal(btn.textContent, '停止', '回答正在打字，按钮必须仍是「停止」')

  // 点「停止」：这一轮真的停掉（半截回答与提问都删、原文回填、通知接收端）
  await X.requestStop()
  await flush()
  console.log('  [stop-midway] 停止后 气泡数=%d 按钮="%s" 输入框="%s"',
    assistants().length, btn.textContent, getById('input').value)
  assert.equal(assistants().length, 0, '半截回答被删掉')
  assert.equal(getById('input').value, '一个会写很长的问题', '原文回填进输入框')
  assert.equal(btn.textContent, '发送', '停止后按钮回「发送」')
  assert.ok(calls.some((c) => c.url.endsWith('/session-stop')), '已通知接收端停止')
})

// ── 回归：落库之后按钮才回「发送」（别在打字期间或没吐完时就复位）──────────────
test('回归：流吐完但答案没落库时仍是「停止」，落库后回「发送」', async () => {
  const { X, getById, chatStamps } = loadSidebar()
  await flush()
  const btn = getById('send-btn')
  getById('input').value = '再问一个'
  await X.submit()
  await flush()
  const ts = chatStamps[0]

  X.handleStream({ role: 'assistant', content: '答', _stream: 1, replyToTs: ts })
  X.handleStream({ role: 'assistant', content: '', _stream: -1, replyToTs: ts })
  assert.equal(btn.textContent, '停止', '字吐完了、答案还没落库 → 仍算进行中')

  // 最终完整记录走 SSE 的 message 事件（_streamDone 分支）
  X.emit({ type: 'message', role: 'assistant', content: '答（完整）', timestamp: ts + 5000, bookKey: '' })
  console.log('  [btn-end] 落库后按钮="%s"', btn.textContent)
  assert.equal(btn.textContent, '发送', '答案落库后才回「发送」')
})


// ── 回归：停止赶在 /chat 回执之前（身份证还没到手）──────────────────────────────
// 连点两下按钮就会碰到：发送的请求还在飞，停止已经点了。那一刻还拿不到这条提问的 timestamp，
// 于是"已弃轮次"没有身份证可记 —— 回执到了必须补登记，否则那一轮的迟到分片认不出来源。
test('回归：停止比 /chat 回执先到时，回执到了要补登记身份证', async () => {
  const { X, chatStamps, getById } = loadSidebar()
  await flush()
  getById('input').value = '连点两下的那一问'
  const submitting = X.submit()          // 故意不 await：/chat 还在飞
  await X.requestStop()                  // 回执没回来就点了停止
  await submitting
  await flush()
  console.log('  [stop-before-ts] 回执后 discarded=%d（应为 %d）', X.getState().discarded, chatStamps[0])
  assert.equal(X.getState().discarded, chatStamps[0], '回执到了要补登记这一轮的身份证')
})

// ── 回归：已弃那一轮的命中事件不得把图点亮 ────────────────────────────────────
// 命中是在**生成回答之前**写出来的（引用判定那一步，可能跑好几秒），用户完全可能正好在这
// 几秒里点停止。事件这时才到 —— 不认来源就会把图点亮、挂上"本轮命中"，而那一轮已经没有
// 提问、也不在讨论栈里（收口永远碰不到它）。认领规则与流式分片同一套身份证。
test('回归：已弃那一轮的命中事件不得把图点亮', async () => {
  const hits = []
  class GV {
    constructor() {}
    onHit(h) { hits.push({ ids: h.slice() }) }
    applyStackHits() {} applyHit() {} isOpen() { return false } reload() {}
    clearHighlight() {} close() {} open() {} setMode() {} setPickMode() {}
    setTutorialMode() {} focusNodeChain() {} _cancelAutoDismiss() {}
  }
  const { X, getById, chatStamps } = loadSidebar({ graphViewStub: GV })
  await flush()
  getById('input').value = '要停掉的一问'
  await X.submit()
  await flush()
  const stoppedTs = chatStamps[0]
  X.finishStoppedTurn({ content: '要停掉的一问', bookKey: '', timestamp: stoppedTs, force: true })

  // 被弃那一轮的命中此刻才到（带着它自己的身份证）
  X.emit({ type: 'message', role: 'graph-hit', hits: ['n1', 'n2'], reason: '「旧知识点」', bookKey: '', replyToTs: stoppedTs })
  console.log('  [hit] 已弃轮命中后 onHit 次数=%d', hits.length)
  assert.equal(hits.length, 0, '已弃那一轮的命中不点亮图')

  // 不带身份证（老版本 agent）以及下一轮的命中：照常点亮（闸门别把正常命中挡了）
  X.emit({ type: 'message', role: 'graph-hit', hits: ['n3'], reason: 'r', bookKey: '' })
  X.emit({ type: 'message', role: 'graph-hit', hits: ['n4'], reason: 'r', bookKey: '', replyToTs: stoppedTs + 1000 })
  console.log('  [hit] 正常命中后 onHit 次数=%d', hits.length)
  assert.equal(hits.length, 2, '正常命中照常点亮')
})

// ── 契约（2026-10-27）：命中清单与「引用窗体」只共 cites，来源标 'turn' ─────────────
// hits 里可能混着 L3 往下追读到的父节点（模型自己读的，不是用户指认的）。窗体按 hits 全并的话，
// 那些父节点会变成下一条提问的引用，收口时还会长出 user 边。
test('契约：命中事件带 cites 时，引用窗体只并 cites（追读到的父节点不进）', async () => {
  const got = []
  class GV {
    constructor() {}
    onHit(h, r, source) { got.push({ ids: [...h], source }) }
    applyStackHits() {} applyHit() {} isOpen() { return false } reload() {}
    clearHighlight() {} close() {} open() {} setMode() {} setPickMode() {}
    setTutorialMode() {} _cancelAutoDismiss() {}
  }
  const { X } = loadSidebar({ graphViewStub: GV })
  await flush()
  await X.toggleFreeMode()
  await flush()
  const key = X.effectiveBookBase()   // 自由对话的 key（命中按上下文隔离，事件要带这个）
  X.emit({ type: 'message', role: 'graph-hit', hits: ['n_hit', 'n_parent'], cites: ['n_hit'], reason: 'r', bookKey: key })
  console.log('  [hit-cites] onHit=%o refs=%o', got.map((x) => x.ids), X.getState().freeRefs.map((r) => r.id))
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].ids, ['n_hit', 'n_parent'], '图上亮整份清单（含 L3 追读到的父节点）')
  assert.equal(got[0].source, 'turn', '来源标记：这一轮真用到的')
  const refs = X.getState().freeRefs.map((r) => r.id)
  assert.ok(refs.includes('n_hit'), '引用命中的那个进窗体')
  assert.equal(refs.includes('n_parent'), false, '追读到的父节点不进窗体（它不是用户指认的）')
})

// ── 回归：停止后，那一轮自动并入的待提交引用要收回 ────────────────────────────
// 自由模式下语义命中会自动并入"本次引用"窗体（随下一条消息作为 cites 提交）。那一轮被停掉
// 之后，这些线索还留着的话会被**下一条提问**一起提交，等于把被弃那轮的命中挂到新提问名下；
// 收口时还会变成图的 user 边。人工选的引用不能动（那是用户点的）。
test('回归：停止后，那一轮自动并入的待提交引用要收回', async () => {
  const { X, getById, chatStamps } = loadSidebar()
  await flush()
  await X.toggleFreeMode()
  await flush()
  assert.equal(X.getState().freeMode, true, '进入自由模式')

  await X.addFreeRef('manual-1', '手动选的节点')
  await X.addFreeRef('auto-1', '', true)      // auto=true：语义命中自动并入
  // 注意：读出来要落成宿主域的数组（VM 里造出来的 Array 原型不同，deepStrictEqual 会误报）
  const afterAdd = [...X.getState().freeRefs.map((r) => r.id)]
  assert.deepEqual(afterAdd, ['manual-1', 'auto-1'], '两条都在窗体里')

  getById('input').value = '自由模式里要停掉的一问'
  await X.submit()
  await flush()
  X.finishStoppedTurn({ content: '自由模式里要停掉的一问', bookKey: '', timestamp: chatStamps[0], force: true })
  const left = [...X.getState().freeRefs.map((r) => r.id)]
  console.log('  [auto-refs] 停止后待提交引用=%o', left)
  assert.deepEqual(left, ['manual-1'], '自动并入的收回，人工选的留着')
})

// ── 契约：agent 写的瞬态流记录必须带这一轮的身份证 ────────────────────────────
// 为什么用源码断言：这条身份是**跨文件契约**（agent 写 / 侧栏认）。谁改了字段名或漏传一个
// 调用点，侧栏那边不会报错，只会静默退化成"残片又画成气泡"——正是上一个测试修掉的那个 bug。
// 上面的 DOM 测试喂的是**合成事件**，它证明不了 agent 真的写了这个字段，所以两边都要钉。
test('契约：agent 的每条瞬态流记录都带 replyToTs（提问落库 timestamp）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const from = src.indexOf('let _streamSeq = 0')
  const to = src.indexOf('// 会意图命中事件')
  assert.ok(from > 0 && to > from, '找不到流式通道那两个函数——实现被重构了，请同步本测试')
  const block = src.slice(from, to)
  assert.match(block, /replyToTs: Number\(replyToTs\)/, '字段名必须原样写进 JSON（侧栏按这个名字认）')

  // 每一个写入点都要传：漏一个，那条路径上的残片就又能画成气泡
  const calls = src.split('\n')
    .filter((l) => /appendChatOutputStream(?:End)?\(/.test(l) && !/^\s*function /.test(l))
  // 2026-10-18 删除会话中实时记忆后，写入点从 5 个减到 4 个
  //（少掉的那个是"合并完把确认反馈补写进流"，见 say() 落库那段）
  assert.ok(calls.length >= 4, `预期至少 4 个写入点，实际 ${calls.length} 个——实现变了请同步本测试`)
  for (const line of calls) {
    assert.match(line, /options\.replyToTs/, `这个写入点没带身份证：${line.trim()}`)
  }
  // 身份证从哪来：poller 把提问行的 timestamp 传进 say()
  assert.match(src, /replyToTs: msg\.timestamp/, 'poller 没把提问行的 timestamp 传给 say()')
})

// ── 回归：停止请求本身仍然生效（闸门别把真停止也挡了）──────────────────────
test('回归：本地点停止（force）仍然会删掉本轮气泡', async () => {
  const { X, getById } = loadSidebar()
  await flush()
  const msgs = getById('msgs')
  getById('input').value = '要被停止的一问'
  await X.submit()
  await flush()
  const before = msgs.children.length
  X.finishStoppedTurn({ content: '要被停止的一问', bookKey: '', timestamp: 0, force: true })
  const after = msgs.children.length
  console.log('  [stop] 停止前=%d 停止后=%d 输入框="%s"', before, after, getById('input').value)
  assert.ok(after < before, '本地停止要真的删掉气泡')
  assert.equal(getById('input').value, '要被停止的一问', '原文回填进输入框')
})

// ── 回归：停止是"回退"，不是"清空"（2026-10-27 用户定）────────────────────────
// 停止的那一轮**没有入栈**，会意栈还停在上一轮 —— 前面几轮挂过的命中本来该原样亮着。
// 原来这里是一刀 clearHighlight()，等于"停一轮顺手把这场讨论的痕迹也抹了"。
// 正确行为：本轮命中作废，然后按栈重画；栈里没有命中才真清。
test('回归：停止后高亮回退到停之前的栈命中，而不是清空', async () => {
  const reverted = []
  const cleared = []
  class GV {
    constructor() {}
    onHit() {} applyStackHits() {} applyHit() {} isOpen() { return true } reload() {}
    revertToStackHits(h, used) { reverted.push({ hits: h.slice(), used }); return null }
    clearHighlight() { cleared.push(1) } close() {} open() {} setMode() {} setPickMode() {}
    setTutorialMode() {} focusNodeChain() {} _cancelAutoDismiss() {}
  }
  // used = 栈里最近一轮"真用上"的节点（2026-10-27 第二次改：图按这一份画，不按累积 cites）
  const { X, getById, chatStamps } = loadSidebar({
    graphViewStub: GV, stackHits: ['prev-1', 'prev-2'], stackUsed: ['prev-2'],
  })
  await flush()
  // refreshStackHits 要求"当前上下文有书"（否则它直接 return，图本来也不会显示）。
  // 测试里用自由模式造出这个上下文，它同样走 effectiveBookBase()。
  await X.toggleFreeMode()
  await flush()
  getById('input').value = '要被停掉的一问'
  await X.submit()
  await flush()
  const stoppedTs = chatStamps[0]

  X.finishStoppedTurn({ content: '要被停掉的一问', bookKey: '', timestamp: stoppedTs, force: true })
  await flush(12)

  console.log('  [revert] 回退调用=%j 清空调用=%d', reverted, cleared.length)
  assert.equal(reverted.length, 1, '按栈命中回退，不是清零')
  assert.deepEqual([...reverted[0].hits], ['prev-1', 'prev-2'], '累积 cites 也一并交回（老栈兜底用）')
  assert.deepEqual([...reverted[0].used], ['prev-2'], '最近一轮真用上的那份也要交回（图按它画）')
  assert.equal(cleared.length, 0, '栈里还有命中时不该调 clearHighlight')
})
