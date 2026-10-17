#!/usr/bin/env node
/**
 * 侧栏「本次引用」窗体折叠 · DOM 层冒烟自测（2026-11 用户报缺）
 *
 * 用户反馈的原话是「自由模式下的引用框无法像读书模式的框那样可以折叠」。读书模式的
 *「当前引用」卡片（sidebar.html #ref-current）有 #rc-collapse-btn + .collapsed + 折叠态
 * 概览（AI-018）；自由模式的「本次引用」窗体（#free-refs）此前一个都没有——它固定在
 * 消息区上方、有几条引用就撑几行，收不起来。
 *
 * 折叠这件事是**两半**：JS 切 class（renderFreeRefs / 两个 click 处理器）+ CSS 靠
 * .collapsed 隐藏清单、显示概览。DOM 替身不跑层叠，所以这里两半分别锁：
 *   · JS 半 → 跑真 sidebar.js，dispatch click，读 classList / style / innerHTML；
 *   · CSS 半 → 读 sidebar.html 原文，查那几条选择器还在不在（谁把 CSS 删了会红）。
 * 与真浏览器的差距：看不到实际像素高度，只验证"该藏的藏、该显的显"这条路径。
 * 跑法：node --test agent/test/sidebar-free-refs-collapse.test.js
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

// ── DOM 替身（与 sidebar-free-conv.test.js 同一套；改动请两边同步）────────────
function makeEl(id = '') {
  const el = {
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
    // 布局尺寸在替身里没有引擎算，由测试按需赋值（见"新引用要能看见"那条：
    // 自动跟随靠的就是 scrollHeight / scrollTop / clientHeight 三个数）
    clientHeight: 0,
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() {},
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

function loadSidebar() {
  const { doc, ids, getById } = buildDom()
  const calls = []
  // 只要够 toggleFreeMode 跑完就行：进自由模式会拉一次对话清单。返回一场已存在的对话，
  // 免得它走"空清单 → 自动新建"那条路（那条路另有测试覆盖）。
  const FETCH_CONV = { key: '__coread_free_aaaaaaaa__', title: '一场自由对话', messages: 2, createdAt: 1, updatedAt: 2, lastAt: 2, status: 'active' }
  const fetchStub = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (u.endsWith('/free-conversations')) {
      return json({ current: FETCH_CONV.key, lastActive: FETCH_CONV.key, active: [FETCH_CONV], archived: [] })
    }
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.endsWith('/graph')) return json({ nodes: [], edges: [] })
    return json({})
  }
  const chromeStub = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { query: async () => [], sendMessage: async () => null, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://test/' + p },
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
  renderFreeRefs,
  toggleFreeMode,
  setFree: (on) => { _freeMode = on },
  setRefs: (refs) => { _freeRefs = refs },
  setLocked: (ids) => { _stackCiteIds = ids },
  setPoints: (pairs) => { _graphPointCache = new Map(pairs) },
  state: () => {
    const box = document.getElementById('free-refs')
    const btn = document.getElementById('fr-collapse-btn')
    const pv = document.getElementById('fr-preview')
    const list = document.getElementById('fr-list')
    const empty = document.getElementById('fr-empty')
    const msgs = document.getElementById('msgs')
    return {
      hidden: box.hidden,
      collapsed: box.classList.contains('collapsed'),
      btnDisplay: btn.style.display,
      btnText: btn.textContent,
      previewHtml: pv.innerHTML,
      previewDisplay: pv.style.display,
      listHtml: list.innerHTML,
      emptyDisplay: empty.style.display,
      listScrollTop: list.scrollTop,
      listScrollHeight: list.scrollHeight,
      msgsScrollTop: msgs.scrollTop,
      msgsScrollHeight: msgs.scrollHeight,
      freeMode: _freeMode,
    }
  },
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, doc, ids, getById, ctx }
}

// 进自由模式 + 塞引用 + 渲染，返回读状态的入口
function setup(refs, locked = [], points = []) {
  const h = loadSidebar()
  h.X.setFree(true)
  h.X.setPoints(points)
  h.X.setRefs(refs)
  h.X.setLocked(locked)
  h.X.renderFreeRefs()
  return h
}

const REF3 = [
  { id: 'n1', point: '注意力是一种可训练的能力' },
  { id: 'n2', point: '深度工作与心流状态的耦合' },
  { id: 'n3', point: '刻意练习中的即时反馈' },
]

// ── 元素存在性 ──────────────────────────────────────────────────────────────
test('折叠按钮与折叠态概览在 sidebar.html 里真的存在（id 拼错会拿到 null）', () => {
  const { getById } = loadSidebar()
  assert.ok(getById('fr-collapse-btn'), '#fr-collapse-btn 存在')
  assert.ok(getById('fr-preview'), '#fr-preview 存在')
  assert.ok(getById('free-refs'), '#free-refs 存在')
})

// ── 展开态基线 ──────────────────────────────────────────────────────────────
test('有引用时：窗体可见、默认展开、折叠按钮是 ▾', () => {
  const { X } = setup(REF3)
  const s = X.state()
  assert.equal(s.hidden, false, '自由模式下窗体可见')
  assert.equal(s.collapsed, false, '默认是展开态（不落盘，重开仍是展开）')
  assert.notEqual(s.btnDisplay, 'none', '折叠按钮可见')
  assert.equal(s.btnText, '▾', '展开态表头显示 ▾')
  assert.equal(s.listHtml.includes('fr-item'), true, '清单已渲染出条目')
})

test('无引用时：折叠按钮隐藏（没东西可折，留着只会误导）', () => {
  const { X } = setup([])
  const s = X.state()
  assert.equal(s.btnDisplay, 'none', '空清单隐藏折叠按钮')
  assert.equal(s.collapsed, false, '也不该是折叠态')
  assert.notEqual(s.emptyDisplay, 'none', '「暂无引用」提示仍可见')
})

// ── 折叠 / 展开两条交互路径 ─────────────────────────────────────────────────
test('点表头 ▾：加上 .collapsed、按钮变 ▸、概览列出两组条数与全部节点名', () => {
  const { X, getById } = setup(REF3, ['n9', 'n10'], [['n9', '讨论栈命中节点甲'], ['n10', '讨论栈命中节点乙']])
  getById('fr-collapse-btn').dispatch('click')
  const s = X.state()
  assert.equal(s.collapsed, true, '折叠 class 已加上（CSS 靠它藏清单）')
  assert.equal(s.btnText, '▸', '折叠态按钮变 ▸')
  assert.match(s.previewHtml, /待提交 3/, '概览报出可取消的那组条数')
  assert.match(s.previewHtml, /讨论命中 2/, '概览报出锁定命中那组条数')
  assert.match(s.previewHtml, /注意力是一种可训练的能力/, '概览含第 1 条节点名')
  assert.match(s.previewHtml, /刻意练习中的即时反馈/, '概览含第 3 条节点名')
  assert.match(s.previewHtml, /讨论栈命中节点乙/, '锁定命中也在概览里（🔒 组）')
  assert.match(s.previewHtml, /frp-count|frp-items/, '概览两行结构：分组条数 + 节点名')
})

test('点概览：直接展开回来（与读书模式 rc-preview 同一手感）', () => {
  const { X, getById } = setup(REF3)
  getById('fr-collapse-btn').dispatch('click')
  assert.equal(X.state().collapsed, true, '前置：已折叠')
  getById('fr-preview').dispatch('click')
  const s = X.state()
  assert.equal(s.collapsed, false, '点概览后展开')
  assert.equal(s.btnText, '▾', '按钮回到 ▾')
})

// ── 边界：折叠态下清单被清空 ────────────────────────────────────────────────
test('折叠后引用被清空：自动展开 + 按钮隐藏（否则只剩表头，连"暂无引用"都看不到）', () => {
  const { X, getById } = setup(REF3)
  getById('fr-collapse-btn').dispatch('click')
  assert.equal(X.state().collapsed, true, '前置：已折叠')
  X.setRefs([])
  X.setLocked([])
  X.renderFreeRefs()
  const s = X.state()
  assert.equal(s.collapsed, false, '清空后自动展开')
  assert.equal(s.btnDisplay, 'none', '折叠按钮隐藏')
  assert.notEqual(s.emptyDisplay, 'none', '「暂无引用」提示可见')
})

test('清空后又有了引用：还能再折叠（折叠能力可重复触发）', () => {
  const { X, getById } = setup(REF3)
  getById('fr-collapse-btn').dispatch('click')
  X.setRefs([]); X.renderFreeRefs()
  X.setRefs([REF3[0]]); X.renderFreeRefs()
  const after = X.state()
  assert.equal(after.collapsed, false, '重新有引用时是展开态（渲染不会自己折上）')
  assert.notEqual(after.btnDisplay, 'none', '按钮回来了')
  getById('fr-collapse-btn').dispatch('click')
  assert.equal(X.state().collapsed, true, '可以再次折叠')
})

// ── 概览内容与清单去重规则一致 ──────────────────────────────────────────────
test('同一节点既待提交又是锁定命中时，概览只算一条（与清单去重同规则）', () => {
  const { X } = setup([{ id: 'n1', point: '同一条节点' }], ['n1'], [['n1', '同一条节点']])
  X.renderFreeRefs()
  const s = X.state()
  assert.equal((s.listHtml.match(/fr-item/g) || []).length, 1, '清单只渲染一条')
  assert.match(s.previewHtml, /待提交 1/, '概览按去重后算：只有「待提交 1」，没有第二个「讨论命中 1」')
  assert.doesNotMatch(s.previewHtml, /讨论命中/, '去重掉的锁定条目不再单独成组')
})

// ── 新引用要能看见：清单自动跟随到底部（与读书模式消息区同一条 AI-004 规则）─────
test('加了引用后清单跟随到底部（刚加的那条不被限高挡在可视区外）', () => {
  const { X, getById } = setup(REF3)
  const list = getById('fr-list')
  // 现场：视口 130px、内容 156px（6 条），当前停在底部（scrollTop 26）
  list.clientHeight = 130
  list.scrollHeight = 182
  list.scrollTop = 26
  X.setRefs(REF3.concat([{ id: 'n4', point: '新加的第 4 条' }]))
  X.renderFreeRefs()
  assert.equal(list.scrollTop, 182, '接近底部 → 跟随到新的底部，最新那条露出来')
})

test('用户正在往上翻旧引用时，不被自动拽到底部（AI-004：不打断浏览）', () => {
  const { X, getById } = setup(REF3)
  const list = getById('fr-list')
  // 现场：视口 130px、内容很长（20 条 = 520px），用户停在最上面看第 1 条
  list.clientHeight = 130
  list.scrollHeight = 520
  list.scrollTop = 0
  X.renderFreeRefs()
  assert.equal(list.scrollTop, 0, '离底部很远 → 位置原地不动')
})

// ── 切换模式那一刻的滚动位置（2026-11 用户反馈："切过来滚动条还在最上面"）─────────
test('切到自由模式：消息区滚到最下面（看最新一条，与读书模式切上下文一致）', () => {
  const h = loadSidebar()
  const msgs = h.getById('msgs')
  // 假布局：一屏放不下，切之前用户停在最上面
  msgs.scrollHeight = 900
  msgs.clientHeight = 600
  msgs.scrollTop = 0
  h.X.toggleFreeMode()
  const s = h.X.state()
  assert.equal(s.freeMode, true, '前置：已切到自由模式')
  assert.equal(s.msgsScrollTop, 900, '切过来就落到最新消息（此前漏了这一步，停在最上面）')
})

test('切进自由模式那一刻：引用清单落在最新一条，不是最上面', () => {
  const h = loadSidebar()
  h.X.setRefs(REF3.concat([{ id: 'n4', point: '第 4 条' }, { id: 'n5', point: '第 5 条' }]))
  h.X.renderFreeRefs()   // 读书模式下渲染：窗体藏着，这时量不出高度
  const list = h.getById('fr-list')
  list.clientHeight = 130   // 切进来之后才有真实布局
  list.scrollHeight = 300
  list.scrollTop = 0
  h.X.toggleFreeMode()
  assert.equal(h.X.state().listScrollTop, 300, '进自由模式直接停在最新一条（藏着的元素算不出位置，必须显式给到底部）')
})

// ── 未捕获异常 ──────────────────────────────────────────────────────────────
test('折叠路径不抛异常（渲染 + 两次点击）', () => {
  const { X, getById } = setup(REF3, ['n9'], [['n9', '命中甲']])
  assert.doesNotThrow(() => {
    getById('fr-collapse-btn').dispatch('click')
    getById('fr-collapse-btn').dispatch('click')
    getById('fr-preview').dispatch('click')
    X.renderFreeRefs()
  })
})

// ── 展开态限高（2026-11 用户要求：超过就出滚轮）────────────────────────────
test('引用多时清单仍把每一条都渲染出来（限高只是视觉裁剪，不许在数据层截断）', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, point: '第 ' + (i + 1) + ' 条引用节点' }))
  const { X } = setup(many)
  const s = X.state()
  assert.equal((s.listHtml.match(/fr-item/g) || []).length, 12,
    '12 条全部在 DOM 里（滚动才看得到，不能只渲染前几条）')
  assert.match(s.listHtml, /第 12 条引用节点/, '最后一条也在')
})

// ── CSS 半：DOM 替身不跑层叠，只能查样式规则原文 ────────────────────────────
test('sidebar.html 的 CSS 里：展开态清单限高 + 超出自滚动，且与读书模式正文区同值', () => {
  const css = fs.readFileSync(HTML, 'utf8')
  const ruleBody = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(css)
    return m ? m[1] : ''
  }
  const list = ruleBody('#free-refs .fr-list')
  assert.match(list, /max-height:\s*\d+px/, '清单要有像素级最大高度')
  assert.match(list, /overflow-y:\s*auto/, '超过高度要出滚动条而不是继续长高')
  // "像读书模式那样"是用户的原始要求：两处限高取同一个值，改一处就该同步另一处
  const px = (body) => Number((/max-height:\s*(\d+)px/.exec(body) || [])[1])
  const rcText = ruleBody('#ref-current .rc-body .rc-text')
  assert.ok(px(rcText) > 0, '读书模式正文区确实有 max-height（否则这条比对没意义）')
  assert.equal(px(list), px(rcText), '与读书模式正文区限高同值')
})

test('sidebar.html 的 CSS 里：折叠时藏清单/空态、显示概览（CSS 那半也锁住）', () => {
  const css = fs.readFileSync(HTML, 'utf8')
  assert.match(css, /#free-refs\.collapsed\s+\.fr-list/, '折叠时 #fr-list 要隐藏')
  assert.match(css, /#free-refs\.collapsed\s+\.fr-empty/, '折叠时空态提示要隐藏')
  assert.match(css, /#free-refs\.collapsed\s+\.fr-preview\s*\{\s*display:\s*block/, '折叠时概览要显示')
  assert.match(css, /#free-refs\s+\.fr-preview\s*\{[^}]*display:\s*none/, '概览默认隐藏（展开态不占高度）')
  assert.match(css, /#free-refs\s+\.fr-collapse-btn/, '折叠按钮要有自己的样式')
})
