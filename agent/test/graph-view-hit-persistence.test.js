#!/usr/bin/env node
/**
 * 会意图两处行为锁（2026-11 用户报）：
 *
 * ① **命中高亮不许被"滞后的空栈数据"吞掉**。用户原话：「当节点命中的动画结束之后，
 *    立刻打开会意图时刚命中的节点不会被高亮，而是直到回答完成后才会被补充上」。
 *    成因：`/stack-hits` 读的是实时讨论栈的 cites，而本轮提问的 cites 要等**回答收口**
 *    才由 agent 写进栈（agent/index.js 的 driveTopicStack）——回答期间它必然是空的。
 *    旧规则见到空结果就在 4 秒后清高亮，于是"刚命中的节点"在回答结束前是看不到的。
 *    现在：本轮还在进行（侧栏传 pending）或刚结束（STACK_LAG_GRACE_MS 宽限）时，
 *    空结果一律当"没有更新"，高亮留着。
 *
 * ② **hover 节点 / 看详情时整张图定格**。用户原话：「让会意图在节点被hover和查看详情
 *    的时候就暂停住不要动了」。这里泵真帧循环，量节点坐标：定格期必须一帧都不动。
 *
 * 跑法：node --test agent/test/graph-view-hit-persistence.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', 'extension', 'graph-view.js')

let SANDBOX = null
const frames = []   // 手动帧泵：requestAnimationFrame 的回调排这里，测试自己推进

function loadView() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math,
    performance: { now: () => 0 },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }),
    },
    addEventListener() {},
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame() {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'graph-view.js' })
  SANDBOX = sandbox
  assert.ok(sandbox.CoReadGraphView && sandbox.CoReadGraphView.GraphView, 'graph-view.js 应挂出 GraphView')
  return sandbox.CoReadGraphView.GraphView
}
const GraphView = loadView()

test('本轮全部拒绝的空通知清除旧高亮，滞后的上一轮栈不能重新点亮', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() }, _turnHits: ['old'] })
  v.onHit([], '', 'turn')
  assert.equal(v.calls.cleared, 1)
  v.applyStackHits(['old'], { pending: true, used: ['old'] })
  assert.equal(v.calls.hit, 0)
  assert.deepEqual([...v._turnHits], [])
})

/** 造一个"只有状态、没有 DOM"的实例（渲染/避让打桩，量的是物理有没有推进） */
function fakeView(over = {}) {
  const v = Object.create(GraphView.prototype)
  v.hl = null
  v._hlHidden = false
  v._focusChain = -1
  v._activeHl = null
  v._turnHits = null
  v._stackIds = []
  v._stackLagUntil = 0
  v._open = true
  v._pendingChainFit = false
  v.hover = null
  v.sel = null
  v._dragging = null
  v._anim = null
  v._pulseUntil = 0
  v._settledOnce = true   // 定格的前提 = 布局已收敛过（未收敛时不定格，另有专门用例）
  v.calls = { hit: 0, seeded: null, cleared: 0 }
  v.applyHit = (seeds) => { v.calls.hit++; v.calls.seeded = seeds }
  v.clearHighlight = () => { v.calls.cleared++; v.hl = null; v._turnHits = null }
  Object.assign(v, over)
  return v
}

// ── ① 空栈结果不清命中高亮 ──────────────────────────────────────────────────
test('回答进行中（pending）：空 /stack-hits 不清高亮——刚命中的节点要一直看得见', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() - 60000 } })   // 远早于旧的 4s 保护窗
  v.applyStackHits([], { pending: true })
  assert.equal(v.calls.cleared, 0, '本轮还在跑，空结果只是"cites 还没落栈"，不能清')
  assert.equal(v.hl && v.hl.mode, 'hit', '高亮原样保留')
  assert.ok(v._stackLagUntil > Date.now(), '同时打开宽限窗口（回答落库到 cites 入栈还有几秒）')
})

test('宽限窗口：pending 报完之后（回答刚落库）的几秒内，空结果照样不清', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() - 60000 } })
  v.applyStackHits([], { pending: true })
  v.applyStackHits([])   // 侧栏已认为本轮结束（回答落库了），但 cites 还在路上
  assert.equal(v.calls.cleared, 0, '宽限期内不清——receiver 3s 轮询 + agent 收口写盘还要几秒')
})

test('宽限期过了、本轮也结束了：空结果照旧清高亮（栈收口即命中结束，2026-09 定调不变）', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() - 60000 } })
  v._stackLagUntil = Date.now() - 1   // 宽限过期
  v.applyStackHits([])
  assert.equal(v.calls.cleared, 1, '真正的"栈清空"仍要清')
})

test('命中动画保护（2026-10）没被改掉：刚命中 4s 内的空结果不清', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() } })
  v.applyStackHits([])
  assert.equal(v.calls.cleared, 0, '动画还在播，空结果不清')
  assert.equal(v._stackLagUntil, 0, '这一条不靠宽限窗口，靠 hl.at 的 4s 判定')
})

test('高亮丢了但本轮命中还在：打开图时用本轮命中补回来', () => {
  const v = fakeView({ hl: null, _turnHits: ['n_a', 'n_b'], _open: true })
  v.applyStackHits([], { pending: true })
  assert.equal(v.calls.hit, 1, '要重放本轮命中')
  assert.deepEqual([...v.calls.seeded], ['n_a', 'n_b'])
})

test('图没开着时不偷偷加载：补命中只在图已经打开的场合做', () => {
  const v = fakeView({ hl: null, _turnHits: ['n_a'], _open: false })
  v.applyStackHits([], { pending: true })
  assert.equal(v.calls.hit, 0, '图关着就别拉图（applyHit 会触发 loadGraph）')
})

test('栈给了 used（最近一轮真用上的）→ 图只亮这一份，不按累积 cites 画', () => {
  // 2026-10-27 实况：一轮用了 2 个，讨论栈累积了 5 条 cites；按 cites 画会堆出 5 个。
  const v = fakeView({ _turnHits: ['n_last'], _stackLagUntil: Date.now() + 5000 })
  v.applyStackHits(['n_cite_1', 'n_cite_2', 'n_cite_3'], { used: ['n_used_1', 'n_used_2'] })
  assert.equal(v.calls.hit, 1)
  assert.deepEqual([...v.calls.seeded], ['n_used_1', 'n_used_2'], '画的是 used，不是累积 cites')
  assert.equal(v._stackLagUntil, 0, '真数据到了，宽限窗口作废')
})

test('回答期间（pending）栈给了真数据：仍优先本轮命中——那一轮的 cites 还没落栈', () => {
  const v = fakeView({ _turnHits: ['n_turn'] })
  v.applyStackHits(['n_stack'], { pending: true, used: ['n_prev'] })
  assert.deepEqual([...v.calls.seeded], ['n_turn'],
    '栈里此刻是上一轮的数据，不能拿它顶替刚命中的那一轮')
})

test('老栈没有 used（升级前的记录）→ 退回按累积 cites 画（别把已有的高亮弄丢）', () => {
  const v = fakeView({ _turnHits: null })
  v.applyStackHits(['n_cite_1', 'n_cite_2'], {})
  assert.deepEqual([...v.calls.seeded], ['n_cite_1', 'n_cite_2'])
})

test('used 是空数组（这一轮命中了但一个都没用上）→ 清掉上一轮的高亮', () => {
  const v = fakeView({ hl: { mode: 'hit', at: Date.now() - 60000 } })
  v.applyStackHits(['n_cite_1'], { used: [] })
  assert.equal(v.calls.hit, 0, '没有可画的节点')
  assert.equal(v.calls.cleared, 1, '上一轮的高亮要清掉，不能留着冒充这一轮')
})

test('打开图（图还没加载）时：非空命中要挂起收敛后的链聚焦校准', () => {
  const v = fakeView({ graph: null, _turnHits: null })
  v.applyStackHits(['n_a'])
  assert.equal(v._pendingChainFit, true, '环形初始布局里聚焦位置不对，等物理收敛再落位')
})

// ── ② hover / 详情 → 定格 ───────────────────────────────────────────────────
/** 造一张有两条边、初始速度非零的图，泵帧看坐标变不变 */
function physicsView(over = {}) {
  const v = fakeView(over)
  const mk = (id, x, y) => ({ id, point: id, aliases: [], discussions: [], books: [], r: 10, x, y, vx: 1.5, vy: 0.8, pinned: false })
  const nodes = [mk('n_a', -200, 0), mk('n_b', 200, 0), mk('n_c', 0, 200)]
  v.run = {
    nodes,
    edges: [{ from: 'n_a', to: 'n_b', kind: 'user' }],
    byId: new Map(nodes.map((n) => [n.id, n])),
    adj: new Map(nodes.map((n) => [n.id, new Set()])),
  }
  v._physics = { running: true, tick: 0 }
  v.render = () => {}
  v._stepHoverFx = () => {}
  v._separateLabels = () => false   // 单独量物理：避让是另一条"挪节点"的路，已由 frozen 一起挡住
  return v
}
const snap = (v) => v.run.nodes.map((n) => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|')
/** 泵帧：先清空队列、强制本视图重新排帧——队列是全局的，不清就会跑到上一个用例的帧上
 *  （那会让断言"看似通过"：量的是别的图，当然一动不动）。 */
const pump = (v, n = 3) => {
  frames.length = 0
  v._raf = 0
  v._ensureLoop()
  for (let i = 0; i < n; i++) {
    const cb = frames.shift()
    if (!cb) break
    cb()
  }
}

test('悬停节点 → 物理定格（坐标一帧都不动）；移开 → 继续收敛', () => {
  const v = physicsView()
  const start = snap(v)
  pump(v, 3)
  assert.notEqual(snap(v), start, '前置：物理确实在推进（不是一开始就没动）')
  v.hover = 'n_a'
  const before = snap(v)
  pump(v, 5)
  assert.equal(snap(v), before, '悬停期间节点坐标必须一模一样')
  v.hover = null
  pump(v, 3)
  assert.notEqual(snap(v), before, '移开鼠标 → 物理接着跑（定格是暂停，不是停机）')
})

test('详情面板开着（sel）→ 同样定格', () => {
  const v = physicsView()
  pump(v, 2)
  v.sel = 'n_b'
  const before = snap(v)
  pump(v, 5)
  assert.equal(snap(v), before, '看详情时图不许漂走')
})

test('拖动节点时不定格：弹性联动（AI-037）还得看得见', () => {
  const v = physicsView()
  pump(v, 2)
  v.hover = 'n_a'                                     // 悬停在节点上（按下时也会带上）
  v._dragging = { kind: 'node', id: 'n_a', sx: 0, sy: 0, moved: true }
  const before = snap(v)
  pump(v, 3)
  assert.notEqual(snap(v), before, '拖拽中物理照跑——这是用户自己要看的联动')
})

test('_motionFrozen：只看悬停 / 选中 / 拖拽 / 收敛状态，别的状态一律不定格', () => {
  const v = fakeView()
  v._settledOnce = true
  assert.equal(v._motionFrozen(), false)
  v.hover = 'n_a'
  assert.equal(v._motionFrozen(), true)
  v.hover = null
  v.sel = 'n_b'
  assert.equal(v._motionFrozen(), true)
  v._dragging = { kind: 'node', id: 'n_b', moved: false }
  assert.equal(v._motionFrozen(), true, '按下但没拖动：仍定格（点击不该让图跳一下）')
  v._dragging.moved = true
  assert.equal(v._motionFrozen(), false, '真拖动：交给物理')
  v._dragging = { kind: 'pan', moved: true }
  assert.equal(v._motionFrozen(), true, '平移画布不改节点位置，不需要物理')
})

test('布局还没收敛 → 不停格：图先长完（半成品环形布局不能被冻在半路）', () => {
  const v = physicsView({ _settledOnce: false })
  v.hover = 'n_a'          // 一进图鼠标就落在节点上是常事
  const before = snap(v)
  pump(v, 3)
  assert.notEqual(snap(v), before, '未收敛期间照旧跑物理')
  // 收敛（tick 走到上限即判定为静止）之后，同样的 hover 才开始定格
  v._physics.tick = 99999
  pump(v, 1)
  assert.equal(v._settledOnce, true, '收敛那一刻要立起标记')
  const settled = snap(v)
  pump(v, 3)
  assert.equal(snap(v), settled, '收敛后 hover 才定格')
})

test('重载图（startPhysics）与会话清零：收敛标记要重置，下一张图同样先长完', () => {
  const v = physicsView()
  v.hover = 'n_a'
  v.startPhysics()
  assert.equal(v._settledOnce, false, '新布局重新计收敛')
  assert.equal(v._motionFrozen(), false, '未收敛 → 不定格')
})
