#!/usr/bin/env node
/**
 * 「停止当前回答」· 侧栏 DOM 层冒烟自测（2026-02）
 *
 * 为什么需要它：这个功能的删除动作跑在 DOM 上，而**删错东西**是最难自查的一类 bug ——
 * 实测踩过一次：正常提问的提问气泡也没了。成因是 SSE 断线重连会补发最近 100 条事件，
 * 于是一次停止的旧 message-stopped 在下一轮提问时被重放，把新气泡连带删掉。
 * 本文件把这个场景固化成回归测试（第三条），并覆盖两条基本路径（提问气泡在 / 停止要生效）。
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
    isComposing: false, _h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
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

function loadSidebar() {
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
    if (u.includes('/stack-hits')) return json({ hits: [] })
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
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx; ctx.self = ctx
  const expose = '\n;globalThis.__X = { submit, finishStoppedTurn, isCurrentTurn, getState: () => ({ awaiting: _awaitingStop, userEl: _awaitUserEl, awaitTs: _awaitTs, streamEl: _streamEl, content: _awaitContent }), applyBookFilter, renderNoBookView, effectiveBookBase };'
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
