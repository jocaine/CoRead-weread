#!/usr/bin/env node
/**
 * 侧栏自由模式多对话 · DOM 层冒烟自测（2026-11 用户定调）
 *
 * 为什么需要它：extension/sidebar.js 是注入到扩展页的经典脚本，改完之后
 *   ① 语法对不对、② 有没有引用到不存在的 DOM id、③ 多对话状态机
 *   （新建 / 切换 / 归档确认 / 列表渲染）会不会在真实元素上炸掉
 * —— 这三件事在没有浏览器的环境里没人替你验证。本脚本用一份**按 sidebar.html
 * 真实 id 集**构造的 DOM 替身把脚本跑起来，然后直接调用那几个函数，断言行为。
 *
 * 与真实浏览器的差距：canvas / SSE / fetch 都是替身，只验证"结构、状态、DOM 读写路径"，
 * 不验证视觉与真实网络。跑法：node test/sidebar-free-conv.test.js
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

// ── DOM 替身 ────────────────────────────────────────────────────────────────
function makeEl(id = '') {
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    _html: '',
    // innerHTML 赋值必须清空子节点——渲染函数都是「先清空再逐行 append」
    // （不清空的话重复渲染会在测试里叠加出不存在的行）
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    title: '',
    placeholder: '',
    scrollTop: 0,
    scrollHeight: 0,
    isComposing: false,
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    // 行内按钮查询：把 data-act 也当成"能找到"，让 renderFreeConvList 的绑定代码真的跑起来
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('[data-act=')) {
        const act = sel.slice(10, -2)
        if (this.innerHTML.includes('data-act="' + act + '"')) return makeEl()
        return null
      }
      return makeEl()
    },
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
  return el
}

// 按 sidebar.html 里真实存在的 id 建元素：脚本引用到 html 里没有的 id 时拿到 null，
// 真实浏览器里同样会 null —— 于是"拼错的 id"会在本测试里暴露成 TypeError。
// 元素的初始 hidden 也照 html 里的 hidden 属性还原（否则替身一律 false，
// 会把"读书模式下对话条本该初始隐藏"这类断言测反）。
function buildDom() {
  const html = fs.readFileSync(HTML, 'utf8')
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const cache = new Map()
  // 该 id 所在标签是否带 hidden 属性
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
  // 自由对话列表里的行在测试里由 renderFreeConvList 生成，用独立的元素工厂
  const doc = {
    body: makeEl('body'),
    getElementById: getById,
    createElement: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  return { doc, ids, getById }
}

// 一次装载：跑完 sidebar.js 的顶层代码 + 把要断言的对象暴露出来
function loadSidebar({ convList = [], archiveOk = true, pingOk = true } = {}) {
  const { doc, ids, getById } = buildDom()
  const calls = []   // 记录 fetch 调用 [{url, method, body}]
  const storage = {}
  const convs = convList.map((c) => ({ ...c }))   // 可变的清单替身（create/rename/delete 后 GET 能看到变化）

  const fetchStub = async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method, body })
    const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => obj })

    // 存活探测（2026-10）：默认成功。传 pingOk:false 模拟"本机程序没在运行"
    // —— 连接灯、离线横幅、发送按钮置灰都挂在它上面。
    if (u.endsWith('/ping')) return json({ ok: true }, pingOk)

    if (u.endsWith('/free-conversations') && method === 'GET') {
      const active = convs.filter((c) => c.status !== 'archived')
      return json({ current: active[0] ? active[0].key : null, lastActive: active[0] ? active[0].key : null, active, archived: [] })
    }
    if (u.endsWith('/free-conversations') && body && body.action === 'create') {
      const c = { key: '__coread_free_ffffffff__', title: '', messages: 0, createdAt: 900, updatedAt: 900, lastAt: 0, status: 'active' }
      convs.unshift(c)
      return json({ ok: true, key: c.key, conversation: c })
    }
    if (u.endsWith('/free-conversations')) return json({ ok: true })
    if (u.endsWith('/free-archive')) return json({ ok: archiveOk, timestamp: 123 })
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
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
    tabs: { query: async () => [], sendMessage: async () => null, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} } },
  }

  class EventSourceStub { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null } close() {} }

  const ctx = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    // 轮询的超时中断（2026-10：连接状态改「轮询当唯一真源」，见 sidebar.js 的 pingOnce）。
    // 浏览器里必然有，沙箱得显式给 —— 否则顶层那句 startPingLoop() 会抛
    // ReferenceError: AbortController is not defined，整份 sidebar.js 都装不进来
    // （实测：14 个测试一起失败，报错都指向 loadSidebar）。
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    // 定时器**不执行回调**：扩展页里的恢复轮询/防抖都是 setTimeout 驱动，同步执行会让
    // loadHistory ↔ scheduleRecoverPoll 互相递归到爆栈。测试只关心显式调用路径。
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

  const src = fs.readFileSync(JS, 'utf8')
  const expose = '\n;globalThis.__X = { toggleFreeMode, renderFreeConvBar, renderFreeConvList, openFreeConvList, closeFreeConvList, openFreeArchive, closeFreeArchive, submitFreeArchive, switchFreeConversation, submit, createFreeConversation, loadFreeConversations, freeConvTitle, freeConvMeta, freeConvIsEmpty, maybeFreeConvHint, effectiveBookBase, effectiveBook, isFreeConvKey, deleteFreeConversation, removeConversationBubbles, renderCurrentBook, applyBookFilter, getState: () => ({ freeMode: _freeMode, freeKey: _freeKey, freeConvs: _freeConvs, archived: _freeArchived }) };'
  vm.createContext(ctx)
  vm.runInContext(src + expose, ctx, { filename: 'sidebar.js' })

  return { X: ctx.__X, calls, storage, doc, ids, getById, convs, ctx }
}

// 等若干轮微任务（脚本里全是 await fetch 链）
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const CONV_A = { key: '__coread_free_aaaaaaaa__', title: '哥萨克问题', messages: 6, createdAt: 100, updatedAt: 200, lastAt: 200, status: 'active' }
const CONV_B = { key: '__coread_free_bbbbbbbb__', title: '', messages: 0, createdAt: 300, updatedAt: 300, lastAt: 0, status: 'active' }

// ── 载入与初始态 ────────────────────────────────────────────────────────────
test('侧栏脚本可在扩展页 DOM 上装载（顶层代码不抛错，无未定义 id 崩溃）', () => {
  const { X } = loadSidebar({ convList: [CONV_A, CONV_B] })
  assert.ok(X, '上下文里的函数已暴露 = 顶层代码执行完毕')
  assert.equal(X.getState().freeMode, false, '默认读书模式')
  assert.equal(X.getState().freeKey, '__coread_free_mode__', '默认落在历史哨兵对话上')
})

test('sidebar.js 引用的 DOM id 全部存在于 sidebar.html', () => {
  const { ids } = loadSidebar({ convList: [] })
  const js = fs.readFileSync(JS, 'utf8')
  const refs = new Set([...js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))
  const missing = [...refs].filter((r) => !ids.has(r))
  assert.deepEqual(missing, [], '缺失的 id: ' + missing.join(', '))
})

// ── 进入自由模式：拉清单、建对话条 ──────────────────────────────────────────
test('进入自由模式：拉到对话清单、当前对话标题正确、对话条显示', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  const st = X.getState()
  assert.equal(st.freeMode, true)
  assert.equal(st.freeConvs.length, 2, '清单已拉回')
  assert.equal(X.freeConvTitle(st.freeKey), '哥萨克问题', '标题取自清单')
  assert.equal(getById('fc-title').textContent, '哥萨克问题', '对话条标题已渲染')
  assert.equal(getById('free-conv-bar').hidden, false, '对话条可见')
  // 有效上下文 = 当前对话 key（消息过滤/发送归属都按它）
  assert.equal(X.effectiveBookBase(), st.freeKey)
})

test('清单为空时自动建第一场对话，并切过去（且不会无限递归）', async () => {
  const { X, calls } = loadSidebar({ convList: [] })
  X.toggleFreeMode()
  await flush(12)
  const created = calls.filter((c) => c.method === 'POST' && c.body && c.body.action === 'create')
  assert.equal(created.length, 1, '只建了一场（递归被 autoCreate=false 挡住）')
  assert.equal(X.getState().freeKey, '__coread_free_ffffffff__', '当前对话 = 新建的那场')
  assert.equal(X.getState().freeConvs.length, 1, '清单已有这场对话')
})

test('当前 key 不在活动清单里（被归档/删除）→ 落到清单里最近活跃的一场', async () => {
  const { X } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  // 默认哨兵不在清单里 → 落到 lastActive（CONV_A）
  assert.equal(X.getState().freeKey, CONV_A.key)
  assert.equal(X.effectiveBookBase(), CONV_A.key)
})

// ── 切换对话：隔离 ──────────────────────────────────────────────────────────
test('切到自由模式的那一刻：对话条与「＋ 新对话」就已就位（不等清单返回）', () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()   // 不 flush：模拟"刚点开关"的那一帧
  assert.equal(getById('free-conv-bar').hidden, false, '对话条立刻可见')
  assert.equal(getById('fc-new').hidden, false, '＋ 新对话立刻可用')
  assert.equal(getById('fc-archive').hidden, false, '⤓ 归档立刻可用')
  assert.equal(getById('fc-title').textContent, '新对话', '清单还没回来时标题先占位')
})

test('对话条显示对话总数徽标；空对话给出指路提示行', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  assert.equal(getById('fc-count').textContent, '2', '徽标 = 对话总数')
  assert.equal(getById('fc-count').hidden, false)
  // CONV_A 有 6 条消息 → 不是空对话，提示行隐藏
  assert.equal(getById('fc-hint').hidden, true, '有消息的对话不显示指路行')
  // 切到空对话 CONV_B → 提示行出现，并点出"再开一场"
  await X.switchFreeConversation(CONV_B.key)
  X.renderFreeConvBar()
  assert.equal(getById('fc-hint').hidden, false, '空对话显示指路行')
  assert.match(getById('fc-hint').textContent, /＋ 新对话/)
  assert.match(getById('fc-hint').textContent, /互不影响/)
})

test('指路气泡每场对话最多一条，且只归属当前对话（不串场）', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  await X.switchFreeConversation(CONV_B.key)
  X.maybeFreeConvHint()
  const msgs = getById('msgs')
  // 数"每场对话各落了几条"，不按可见性过滤
  const hintsFor = (key) => msgs.children.filter((el) => el.className === 'msg-system' && el.dataset.book === key)
  assert.equal(hintsFor(CONV_B.key).length, 1, '空对话落一条提示')
  X.maybeFreeConvHint()   // 同一场再调（幂等）
  assert.equal(hintsFor(CONV_B.key).length, 1, '同一场对话不重复落')
  // 切到有 6 条消息的对话：不落提示，且 B 的提示随切走被摘下
  await X.switchFreeConversation(CONV_A.key)
  X.maybeFreeConvHint()
  assert.equal(hintsFor(CONV_A.key).length, 0, '已有 6 条消息的对话不落提示')
  assert.equal(hintsFor(CONV_B.key).length, 0, 'B 的提示随切走被摘掉（气泡按对话隔离）')
  // 切回空对话：把那条提示补回来（不是又落一条）
  await X.switchFreeConversation(CONV_B.key)
  assert.equal(hintsFor(CONV_B.key).length, 1, '切回空对话补回提示，仍只有一条')
})

test('切换对话：上下文 key 换掉、标题跟着换', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  await X.switchFreeConversation(CONV_B.key)
  const st = X.getState()
  assert.equal(st.freeKey, CONV_B.key, '当前对话已切换')
  assert.equal(X.effectiveBookBase(), CONV_B.key, '有效上下文跟着换（消息过滤/发送归属都按新 key）')
  assert.equal(X.freeConvTitle(CONV_B.key), '对话 2', '无标题的新对话按序号兜底显示')
  assert.equal(getById('fc-title').textContent, '对话 2')
})

test('切换对话 = 切 key：新对话的消息气泡与旧对话不共用 dataset.book', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  const msgs = getById('msgs')
  const mk = (book) => { const el = makeEl(); el.dataset.book = book; msgs.appendChild(el); return el }
  const a1 = mk(CONV_A.key)
  const a2 = mk(CONV_A.key)
  const b1 = mk(CONV_B.key)
  // 当前是 CONV_A：A 的两条可见、B 的隐藏
  X.applyBookFilter()
  assert.equal(a1.style.display, '', 'A 的消息可见')
  assert.equal(b1.style.display, 'none', 'B 的消息隐藏')
  // 切到 B：A 的气泡被摘下（不用等下一条消息就切干净），B 的显示
  await X.switchFreeConversation(CONV_B.key)
  assert.equal(msgs.children.includes(a1), false, 'A 的气泡已从 DOM 摘下')
  assert.equal(msgs.children.includes(a2), false)
  assert.equal(msgs.children.includes(b1), true, 'B 的气泡保留')
  assert.equal(b1.style.display, '', 'B 的消息可见')
})

test('对话列表渲染：当前对话打「当前」标记，行内三个动作按钮齐全', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  const list = getById('fcv-list')
  X.renderFreeConvList()
  assert.equal(list.children.length, 2, '两场对话两行')
  const html = list.children.map((c) => c.innerHTML).join('\n')
  assert.match(html, /哥萨克问题/)
  assert.match(html, /data-act="rename"/)
  assert.match(html, /data-act="archive"/)
  assert.match(html, /data-act="delete"/)
  assert.match(html, /当前/, '当前对话有「当前」标记')
})

// ── 归档：确认弹窗 → /free-archive ─────────────────────────────────────────
test('归档弹窗：默认两项都勾上（归档默认走完整正常程序），可取消', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  const mem = getById('fa-memory'); mem.checked = false      // 先弄脏，验证会被默认值覆盖
  const graph = getById('fa-graph'); graph.checked = false
  await X.openFreeArchive(CONV_A.key)
  assert.equal(mem.checked, true, '保存记忆默认勾上')
  assert.equal(graph.checked, true, '收口进拓扑图默认勾上')
  assert.equal(getById('free-archive-overlay').classList.contains('on'), true, '弹窗打开')
  assert.match(getById('fa-conv').textContent, /哥萨克问题/, '弹窗显示对话标题与消息数')
  assert.match(getById('fa-conv').textContent, /6 条消息/)
})

test('归档默认值只在首次生效：取消并归档后，下次打开沿用上次选择', async () => {
  const h = loadSidebar({ convList: [CONV_A, CONV_B] })
  h.X.toggleFreeMode()
  await flush()
  await h.X.openFreeArchive(CONV_A.key)
  h.getById('fa-memory').checked = false      // 这次不留记忆
  h.getById('fa-graph').checked = false       // 也不收口
  await h.X.submitFreeArchive()
  // 再开一次（模拟下一场对话归档）：沿用上次的取消，而不是又回到双勾
  await h.X.openFreeArchive(CONV_B.key)
  assert.equal(h.getById('fa-memory').checked, false, '沿用上次取消')
  assert.equal(h.getById('fa-graph').checked, false, '沿用上次取消')
  // 逐项断言（storage 里的对象来自 VM 上下文，跨 realm 用 deepStrictEqual 会栽在原型上）
  const pref = h.storage.freeArchiveOpts
  assert.equal(pref && pref.memory, false, 'memory 选择已落 storage')
  assert.equal(pref && pref.graph, false, 'graph 选择已落 storage')
  // 勾回来 → 又被记住（openFreeArchive 会异步回读上次选择，所以必须在它之后再改）
  await h.X.openFreeArchive(CONV_B.key)
  h.getById('fa-memory').checked = true
  h.getById('fa-graph').checked = true
  await h.X.submitFreeArchive()
  await h.X.openFreeArchive(CONV_A.key)
  assert.equal(h.getById('fa-memory').checked, true, '勾回来也记住')
  assert.equal(h.getById('fa-graph').checked, true)
})

test('确认归档：POST /free-archive 带上 key 与勾选项（默认勾上的两项 = true/true）', async () => {
  const { X, calls, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  await X.openFreeArchive(CONV_A.key)
  await X.submitFreeArchive()
  const req = calls.find((c) => c.url.endsWith('/free-archive'))
  assert.ok(req, '发出了归档请求')
  assert.deepEqual(req.body, { key: CONV_A.key, memory: true, graph: true })
  assert.equal(getById('free-archive-overlay').classList.contains('on'), false, '弹窗已关闭')
})

test('确认归档：取消两项后如实传 false/false（这次不留痕）', async () => {
  const { X, calls, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  await X.openFreeArchive(CONV_A.key)
  getById('fa-memory').checked = false
  getById('fa-graph').checked = false
  await X.submitFreeArchive()
  const req = calls.find((c) => c.url.endsWith('/free-archive'))
  assert.deepEqual(req.body, { key: CONV_A.key, memory: false, graph: false })
})

test('归档请求失败（接收端未启动）：弹窗保持打开、按钮恢复可用', async () => {
  const h = loadSidebar({ convList: [CONV_A] })
  h.X.toggleFreeMode()
  await flush()
  h.X.openFreeArchive(CONV_A.key)
  // 换上一定失败的 fetch（模拟接收端未启动）后确认归档
  h.ctx.fetch = async () => { throw new Error('ECONNREFUSED') }
  await h.X.submitFreeArchive()
  assert.equal(h.getById('free-archive-overlay').classList.contains('on'), true, '失败时弹窗不关')
  assert.equal(h.getById('fa-ok').disabled, false, '按钮恢复可用（可重试）')
})

// ── 新建对话 ────────────────────────────────────────────────────────────────
test('新建对话：POST create → 切到新 key', async () => {
  const { X, calls } = loadSidebar({ convList: [CONV_A, CONV_B] })
  X.toggleFreeMode()
  await flush()
  await X.createFreeConversation()
  const created = calls.find((c) => c.method === 'POST' && c.body && c.body.action === 'create')
  assert.ok(created, 'create 请求已发出')
  assert.equal(X.getState().freeKey, '__coread_free_ffffffff__')
})

test('isFreeConvKey：只认自由对话 key（真实书 ID / 其它哨兵都不认）', () => {
  const { X } = loadSidebar({ convList: [] })
  assert.equal(X.isFreeConvKey('__coread_free_mode__'), true)
  assert.equal(X.isFreeConvKey('__coread_free_0123abcd__'), true)
  assert.equal(X.isFreeConvKey('ee442b83643425f356d563865'), false)
  assert.equal(X.isFreeConvKey('_common'), false)
  assert.equal(X.isFreeConvKey(''), false)
})

// ── 读书模式不得出现自由模式专属 UI（2026-11 用户反馈）──────────────────────
// 回归的是真实踩过的坑：对话条用 `#free-conv-bar { display: flex }` 定义，而 UA 的
// `[hidden] { display: none }` 优先级更低 —— 于是 JS 明明置了 hidden，读书模式下
// 这条自由模式的条子照样挂在消息区上方。本文件既有约定是"display 覆盖 hidden 的元素
// 必须补一条 [hidden] 强制规则"（见 sidebar.html 里 .gv-* 那段 AI-021 注释）。
function htmlSource() {
  return fs.readFileSync(HTML, 'utf8')
}
// 取某条选择器规则体（第一个匹配到的），用于断言它是否设了 display
// ── 本机程序没在运行：灯变灰（文字说明原因）+ 按发送时弹窗拦住 ────────────────
// 注：灯的"绿"需要 SSE 也连上，而测试里的 EventSourceStub 不会触发 onopen，
//     所以这里只断言"离线时变灰"，不断言在线时变绿。
test('本机程序没在运行时：灯变灰，提示文字直说"未运行"', async () => {
  const { getById } = loadSidebar({ convList: [], pingOk: false })
  await flush()
  assert.equal(getById('dot').style.background, '#ddd', '连接灯变灰')
  assert.equal(getById('dot').title, '本机程序未运行', '提示文字直接说明是哪种断连')
  assert.doesNotMatch(getById('dot').title, /重连/, '不能把"程序没运行"说成"正在重连"')
})

test('本机程序在运行时：灯的文字不说"未运行"', async () => {
  const { getById } = loadSidebar({ convList: [] })   // 默认 /ping 成功
  await flush()
  assert.doesNotMatch(getById('dot').title, /未运行/, '在线时不提"未运行"')
})

test('本机程序没在运行时按发送：不发出、弹出提示、原文留在输入框', async () => {
  const { X, getById, calls } = loadSidebar({ convList: [], pingOk: false })
  await flush()
  getById('input').value = '这句话应该发不出去'
  await X.submit()
  await flush()
  assert.equal(calls.filter((c) => c.url.endsWith('/chat')).length, 0, '没有发出任何消息')
  assert.equal(getById('confirm-overlay').classList.contains('on'), true, '弹出了提示框')
  assert.equal(getById('confirm-title').textContent, '无法发送', '弹窗标题')
  assert.match(getById('confirm-msg').textContent, /未运行/, '弹窗说明了原因')
  assert.equal(getById('confirm-cancel-btn').hidden, true, '只留确定按钮（不需要用户做选择）')
  assert.equal(getById('confirm-overlay').classList.contains('notice'), true, '走通知型排版（标题正文左对齐 + 紧凑绿色按钮）')
  assert.equal(getById('input').value, '这句话应该发不出去', '原文原样留在输入框')
})

function cssRuleBody(html, selector) {
  const esc2 = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp('(?:^|[},])\\s*' + esc2 + '\\s*(?:,[^{}]*)?\\{([^}]*)\\}', 'm').exec(html)
  return m ? m[1] : ''
}

test('读书模式：对话条与「本次引用」窗体都不可见（CSS 层强制 hidden 生效）', () => {
  const html = htmlSource()
  // 对话条是 display:flex，必须自带 [hidden] 强制规则；同时确认它真的设了 display
  // （若哪天 display 去掉了，这条断言会失败并提醒可以删掉多余的强制规则）
  assert.match(cssRuleBody(html, '#free-conv-bar'), /display\s*:\s*flex/,
    '#free-conv-bar 仍是 display:flex')
  assert.match(html, /#free-conv-bar\[hidden\][^{]*\{\s*display:\s*none\s*!important/,
    '#free-conv-bar[hidden] 必须强制 display:none（否则读书模式下常显）')
  // 徽标 / 提示行也走 hidden，同款兜底
  assert.match(html, /#free-conv-bar \.fc-count\[hidden\]/, 'fc-count[hidden] 兜底规则在')
  assert.match(html, /#free-conv-bar \.fc-hint\[hidden\]/, 'fc-hint[hidden] 兜底规则在')
  // 「本次引用」窗体（也是自由模式专属）：不能设 display，否则 [hidden] 失效
  assert.doesNotMatch(cssRuleBody(html, '#free-refs'), /display\s*:/,
    '#free-refs 不得设 display（设了就必须补 [hidden] 强制规则）')
})

test('读书模式：对话框/开关切换后对话条保持隐藏，进自由模式才显示', async () => {
  const { X, getById } = loadSidebar({ convList: [CONV_A, CONV_B] })
  assert.equal(getById('free-conv-bar').hidden, true, '初始（读书模式）隐藏')
  X.toggleFreeMode()                       // 进自由
  assert.equal(getById('free-conv-bar').hidden, false, '进自由模式显示')
  X.toggleFreeMode()                       // 回读书
  assert.equal(getById('free-conv-bar').hidden, true, '退出后隐藏')
  await flush()
  assert.equal(getById('free-conv-bar').hidden, true, '退出后异步链也不会把它翻出来')
})
