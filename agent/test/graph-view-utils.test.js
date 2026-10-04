#!/usr/bin/env node
/**
 * 拓扑图视图的纯函数（extension/graph-view.js 的 utils）单元测试。
 * 运行：node test/graph-view-utils.test.js
 *
 * 为什么放在 agent/test：`graph-view.js` 是普通 <script>（IIFE 挂 window/globalThis），
 * 无模块导出、扩展目录下也没有测试跑道；但它里面的 computePath / computeChains /
 * computeHitLayers 是纯函数，口径直接决定"用户在图上看到的"是否等于"AI 实际拿到的"。
 * 2026-10 的《大国大城》跑题就是因为两者不一致（图 46 节点 / L3 8 节点）而难以定位，
 * 所以这里用最小 vm 沙箱把它加载进来单测。
 *
 * 注意：vm 沙箱里造出来的数组/Set 属于另一个 realm，`assert.deepStrictEqual` 比原型会
 * 失败——断言前一律用 `[...x]` / `Array.from(x, fn)` 转成本 realm 的普通数组。
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

function loadUtils() {
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math,
    document: { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }) },
    addEventListener() {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'graph-view.js' })
  SANDBOX = sandbox
  const U = sandbox.CoReadGraphView && sandbox.CoReadGraphView.utils
  assert.ok(U, 'graph-view.js 应挂出 CoReadGraphView.utils')
  return U
}
const U = loadUtils()
const ids = (setOrArr) => [...setOrArr].sort()

// 图：a ─user→ b ─user→ c（命中链）；d ─derived→ c（同栈相邻段，不该进 l3）；
//     c ─user→ down（去路，不该进 l3）；solo 无入边
const NODES = ['n_a', 'n_b', 'n_c', 'n_d', 'n_down', 'n_solo'].map((id) => ({ id, point: id, x: 0, y: 0, r: 6 }))
const EDGES = [
  { from: 'n_a', to: 'n_b', kind: 'user' },
  { from: 'n_b', to: 'n_c', kind: 'user' },
  { from: 'n_d', to: 'n_c', kind: 'derived' },
  { from: 'n_c', to: 'n_down', kind: 'user' },
]

test('computeHitLayers：一场讨论一次闭包——种子并集，只沿 user 入边递归', () => {
  // 种子 = 本轮命中 ∪ 本场栈已挂的引用（收口后会并进同一个节点的 user 边，所以一起取闭包）
  const r = U.computeHitLayers(NODES, EDGES, ['n_c', 'n_d'])
  assert.deepEqual(ids(r.ids), ['n_a', 'n_b', 'n_c', 'n_d'], '闭包 = 种子 + 沿 user 入边的上游')
  assert.equal(r.ids.has('n_down'), false, 'user 出边（下游）不进')
  assert.equal(r.ids.has('n_solo'), false, '没被指认也不是上游的节点不进')
  assert.deepEqual(ids(r.recent), ['n_c', 'n_d'], 'recent = 种子里的引用节点（两个也是并集）')
  assert.deepEqual(ids(r.roots), ['n_a', 'n_d'], 'roots = 闭包里没有 user 入边的起点')
})

test('computeHitLayers：闭包内部的边全部可见（弱边档）——节点不能是无线孤点', () => {
  // d 与 c 之间是 derived 边：不在强边档（不是 user 边），但两端都在闭包里 → 必须进弱边档，
  // 否则 d 会变成没有连线的孤点，图失去结构（2026-10 用户反馈"看不懂"）。
  const r = U.computeHitLayers(NODES, EDGES, ['n_c', 'n_d'])
  assert.deepEqual(Array.from(r.weakEdges, (e) => e.from + '>' + e.to), ['n_d>n_c'], '弱边 = 闭包内的 derived 边')
  const strong = new Set(Array.from(r.pathEdges, (e) => e.from + '>' + e.to))
  const weak = new Set(Array.from(r.weakEdges, (e) => e.from + '>' + e.to))
  const inside = EDGES.filter((e) => r.ids.has(e.from) && r.ids.has(e.to)).map((e) => e.from + '>' + e.to)
  assert.ok(inside.length > 0)
  for (const k of inside) assert.ok(strong.has(k) || weak.has(k), `${k} 必须在两档之一`)
  assert.equal(weak.has('n_c>n_down'), false, '跨出闭包的边不画')
})

test('computeHitLayers：无命中 / 命中全不存在 → 空；单个无上游的引用只有它自己', () => {
  assert.equal(U.computeHitLayers(NODES, EDGES, []).ordered.length, 0)
  assert.equal(U.computeHitLayers(NODES, EDGES, ['n_missing']).ordered.length, 0)
  const solo = U.computeHitLayers(NODES, EDGES, ['n_d'])
  assert.deepEqual(ids(solo.ids), ['n_d'], 'n_d 没有 user 入边 → 闭包就它自己')
  assert.equal(solo.pathEdges.length, 0)
  assert.equal(solo.weakEdges.length, 0)
})

test('computeChains：user 口径下 derived 相连的命中各成一条链（混合口径会并成一条）', () => {
  // c 的混合祖先集含 d（d ─derived→ c），所以 d 与 c 在混合口径下路径相交 → 一条链
  assert.equal(U.computeChains(NODES, EDGES, ['n_c', 'n_d'], ['user']).length, 2, 'user 口径：两条链')
  assert.equal(U.computeChains(NODES, EDGES, ['n_c', 'n_d']).length, 1, '混合口径：并成一条')
})

test('chainActiveSet：单链隔离只激活该链（切换脉络要真的隔离，其它脉络压暗）', () => {
  // 两条链：链A = {n_a,n_b,n_c}（n_c 的 user 来路），链B = {n_d}（n_d 无 user 来路）
  const chains = U.computeChains(NODES, EDGES, ['n_c', 'n_d'], ['user'])
  assert.equal(chains.length, 2)
  const a = U.chainActiveSet(EDGES, chains[0], ['n_a', 'n_d'], ['n_c', 'n_d'])
  assert.deepEqual(ids(a.ids), ['n_a', 'n_b', 'n_c'], '只激活链 A 的节点，n_d 不在内')
  assert.deepEqual(Array.from(a.strong, (e) => e.from + '>' + e.to), ['n_a>n_b', 'n_b>n_c'], '链内 user 边为强调边')
  // roots / recent 也必须按链过滤——否则别的脉络的节点照样画虚线环与脉冲环
  assert.deepEqual([...a.roots], ['n_a'], 'roots 只留本链的')
  assert.deepEqual([...a.recent], ['n_c'], 'recent 只留本链的引用节点（n_d 被滤掉）')
  const b = U.chainActiveSet(EDGES, chains[1], ['n_a', 'n_d'], ['n_c', 'n_d'])
  assert.deepEqual(ids(b.ids), ['n_d'], '链 B 只有 n_d 自己（无来路）')
  assert.equal(b.strong.size, 0)
  assert.equal(b.weak.size, 0, 'n_d 在链内没有任何边——这也是真实图里的常见形态')
  assert.deepEqual([...b.recent], ['n_d'], 'recent = n_d（n_c 不在链 B）')
  // 两条链的激活集互不相交：切换即隔离
  for (const id of a.ids) assert.equal(b.ids.has(id), false)
  // 「全部」走 hl 本身的两层集，不走这里
  assert.equal(U.chainActiveSet(EDGES, null, [], []).ids.size, 0)
})

test('computePath：默认仍是混合边口径（搜索 / 单击预览用），kinds 可收窄', () => {
  assert.equal(U.computePath(NODES, EDGES, ['n_c']).ordered.length, 4, '混合：a/b/c/d')
  assert.equal(U.computePath(NODES, EDGES, ['n_c'], ['user']).ordered.length, 3, '只 user：a/b/c')
})

test('回归守卫：render() 里不许直接读 hl.ids / hl.roots / hl.recent / hl.stackOnly / hl.edges', () => {
  // 2026-10 的真实 bug：单链隔离只改到了"边"，节点判定（onPath）、root 虚线环、recent 脉冲环
  // 仍直接读全量 hl.*，于是"观察某条脉络时其它脉络的节点也高亮/闪环"。
  // 纯函数单测盖不到渲染分支，所以这里做一次源码级守卫：render() 必须一律读激活集
  // （hlIds / hlEdges / hlWeakEdges / hlStackOnly / hlRoots / hlRecent）。
  const src = fs.readFileSync(SRC, 'utf8')
  const start = src.indexOf('    render() {')
  assert.ok(start > 0, '找不到 render()')
  const end = src.indexOf('\n    }\n', start)          // 方法收尾的 4 空格缩进右花括号
  assert.ok(end > start, '找不到 render() 的结尾')
  const code = src.slice(start, end)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))   // 注释里可以提这些名字
    .join('\n')
  assert.ok(code.length > 3000, `render() 提取过短（${code.length} 字符）——守卫会形同虚设，检查切片边界）`)
  for (const bad of ['hl.ids', 'hl.roots', 'hl.recent', 'hl.stackOnly', 'hl.edges', 'hl.weakEdges']) {
    assert.equal(code.includes(bad), false,
      `render() 里出现了 ${bad} —— 必须读激活集，否则单链隔离会漏（多脉络时其它脉络照旧高亮）`)
  }
})

// ── 状态机：详情面板的进入 / 退出（2026-10 修：✕ 退出时脉络按钮不见了） ──────────
// 单击节点看详情会把高亮切成 manual（单节点混合路径），并把消息级命中暂存进 _savedState。
// 退出详情必须把这次预览一并退出，否则暂存的命中永远回不来：hl.chains 只剩 1 条 →
// 「全部 / 脉络 N」按钮消失。这里用 Object.create 造实例、桩掉渲染，避开 DOM。
function fakeView(over = {}) {
  const v = Object.create(SANDBOX.CoReadGraphView.GraphView.prototype)
  v.sel = 'n_x'
  v.hl = { mode: 'manual', targets: ['n_x'] }
  v._savedState = null
  v._hlHidden = false
  v._focusChain = -1
  v.calls = { hide: 0, recompute: 0, render: 0, clear: 0, fit: 0, anim: 0 }
  v._hideDetail = () => { v.calls.hide++ }
  v.recomputeHighlight = () => { v.calls.recompute++ }
  v.render = () => { v.calls.render++ }
  v._fitToChain = () => { v.calls.fit++ }
  v._animCam = () => { v.calls.anim++ }
  v.fitToNodes = () => { v.calls.fit++ }
  v.clearHighlight = () => { v.calls.clear++; v.hl = null }
  Object.assign(v, over)
  return v
}

test('closeDetail：从节点预览退出 → 恢复暂存的消息级命中（脉络按钮才能回来）', () => {
  const saved = { mode: 'hit', targets: ['n_a', 'n_b'], chains: [{}, {}, {}] }
  const v = fakeView({ _savedState: { hl: saved, focusChain: 1, hidden: false } })
  v.closeDetail()
  assert.equal(v.sel, null, '详情已关')
  assert.equal(v.calls.hide, 1)
  assert.equal(v.calls.recompute, 1, '必须重算（重算里会重渲染横幅与脉络按钮）')
  assert.equal(v.hl, saved, '恢复的是暂存的消息级命中，不是 manual 预览')
  assert.equal(v._focusChain, 1, '聚焦的脉络也一并恢复')
  assert.equal(v._savedState, null, '暂存用掉即清')
  assert.equal(v.calls.clear, 0, '有暂存时不该清高亮')
  assert.equal(v.calls.render, 1, '最后仍要重绘一帧')
})

test('closeDetail：没有暂存（裸单击预览）→ 真正清掉高亮并恢复相机', () => {
  const v = fakeView({ _savedState: null, _preFocusCam: { x: 1, y: 2, scale: 3 } })
  v.closeDetail()
  assert.equal(v.calls.clear, 1, '无暂存 → clearHighlight')
  assert.equal(v.calls.anim, 1, '恢复聚焦前相机')
  assert.equal(v.calls.recompute, 0)
  assert.equal(v.calls.render, 1)
})

test('closeDetail：非 manual 态（点空白但没预览）不碰高亮', () => {
  const v = fakeView({ hl: { mode: 'hit', targets: ['n_a'] } })
  v.closeDetail()
  assert.equal(v.calls.clear, 0)
  assert.equal(v.calls.recompute, 0)
  assert.equal(v.calls.render, 1)
})

test('_isHitLikeHl：只有 hit/picked/simulate 是命中态；search/manual 走混合边路径', () => {
  const v = fakeView()
  for (const mode of ['hit', 'picked', 'simulate']) assert.equal(v._isHitLikeHl({ mode }), true, mode)
  for (const mode of ['search', 'manual', undefined]) assert.equal(v._isHitLikeHl({ mode }), false, String(mode))
  assert.equal(v._isHitLikeHl(null), false)
  // search 也带空 stackOnly——不能再靠它判命中态（那会把搜索结果误换成 user 来路闭包）
  assert.equal(v._isHitLikeHl({ mode: 'search', stackOnly: new Set() }), false)
})

test('labelShape：描述省略只由缩放决定（高亮与非高亮同一缩放必须一致）', () => {
  const shape = (r) => ({ ...U.labelShape(r) })
  assert.deepEqual(shape(0.5), { chars: 6, lines: 1 })
  assert.deepEqual(shape(1.0), { chars: 9, lines: 2 })
  assert.deepEqual(shape(2.0), { chars: 17, lines: 3 })
  assert.deepEqual(shape(3.0), { chars: 20, lines: 3 })
  // labelShape 只有一个入参（ratio）——"高亮多一档"这种分支不许再回来
  assert.equal(U.labelShape.length, 1, 'labelShape 不能带"是否高亮"参数：同一缩放必须同一截断')
  // 单调：放大只会更全，不会更少
  let prev = 0
  for (const r of [0.1, 0.5, 0.9, 1.3, 2, 3, 5]) {
    const c = shape(r).chars
    assert.ok(c >= prev, `ratio=${r} 的字数不该比更小时少`)
    prev = c
  }
})

test('回归守卫：render() 里 labelShape 只传 ratio（高亮不得改变描述省略）', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const start = src.indexOf('    render() {')
  const end = src.indexOf('\n    }\n', start)
  const code = src.slice(start, end)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.ok(code.includes('labelShape(ratio)'), 'render() 应以 labelShape(ratio) 取标签档位')
  assert.equal(/labelShape\(ratio\s*,/.test(code), false,
    'render() 里 labelShape 多传了参数——高亮状态会让描述省略与非高亮不一致')
})

// ── 标签绘制：底色档位与"不许描边光晕"（2026-10 性能修正） ──────────────────
function fakeCtx(calls) {
  return {
    measureText: (t) => ({ width: String(t).length * 12 }),
    beginPath: () => calls.push('beginPath'),
    roundRect: () => calls.push('roundRect'),
    fillRect: () => calls.push('fillRect'),
    fill: () => calls.push('fill'),
    fillText: () => calls.push('fillText'),
    strokeText: () => calls.push('strokeText'),
  }
}

test('drawLabel：底色按档位只画一次圆角矩形，且绝不用描边光晕', () => {
  const calls = []
  const ctx = fakeCtx(calls)
  const boxes = () => calls.filter((c) => c === 'roundRect' || c === 'fillRect').length
  // 普通标签（0）：完全不画底——与加光晕之前的表现一致
  U.drawLabel(ctx, '这是一条比较长的知识点描述文本', 0, 0, 1, 9, 0, 12, 2, 1)
  assert.equal(boxes(), 0, '普通标签不画底')
  assert.ok(calls.filter((c) => c === 'fillText').length >= 1, '文字照画')
  // 高亮标签（0.5）：半透明底，一次
  calls.length = 0
  U.drawLabel(ctx, '高亮知识点描述', 0, 0, 1, 9, 0.5, 12, 2, 1)
  assert.equal(boxes(), 1, '底色只画一次（不是逐行描边）')
  // 悬停 / 选中（0.88）：白 pill，一次
  calls.length = 0
  U.drawLabel(ctx, '悬停知识点', 0, 0, 1, 9, 0.88, 12, 3, 1)
  assert.equal(boxes(), 1)
  // 三种档位下都不许出现 strokeText
  assert.equal(calls.filter((c) => c === 'strokeText').length, 0)
})

test('回归守卫：graph-view.js 里不许出现 .strokeText( 调用（逐帧描字形 = 卡顿源）', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.equal(/\.strokeText\s*\(/.test(code), false,
    'strokeText 描边字形是 canvas 最贵的操作之一；标签底请用 drawLabel 的 bgAlpha（一次圆角矩形）')
})

test('命中标识环：图例色取自 COLORS（不许写死），图例只列两条', () => {
  // 用户报过"recent 标识和图例颜色对不上"：一半是渲染漏读 COLORS（隐藏态误用 pathAccent），
  // 一半是图例硬编码色值会和渲染漂移。这条测试把两条路都堵住；同时钉住图例的条目数
  //（2026-10 用户定调：那两层术语没必要占图例位置 → 只留 路径起点 / 引用到的知识点 两条）。
  const C = SANDBOX.CoReadGraphView.COLORS
  const keys = ['pathAccent', 'rootMark', 'recentMark']
  for (const k of keys) assert.ok(C && C[k], `COLORS.${k} 未导出/缺失`)
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = U.colorDist(C[keys[i]], C[keys[j]])
      assert.ok(d >= 25, `${keys[i]}(${C[keys[i]]}) 与 ${keys[j]}(${C[keys[j]]}) 色距 ${d.toFixed(0)} 过近，图上分不出来`)
    }
  }
  const src = fs.readFileSync(SRC, 'utf8')
  const at = src.indexOf('class="gv-lg-title">命中高亮')
  assert.ok(at > 0, '找不到图例块')
  const block = src.slice(at, at + 1200)
  const ringLines = block.split('\n').filter((l) => l.includes('class="ring'))
  assert.equal(ringLines.length, 2, `图例应只列两条，实际 ${ringLines.length} 条`)
  for (const l of ringLines) {
    assert.ok(l.includes('COLORS.'), `图例环色没取自 COLORS：${l.trim().slice(0, 70)}`)
    assert.equal(/#[0-9a-fA-F]{6}/.test(l), false, `图例环色硬编码了十六进制：${l.trim().slice(0, 70)}`)
  }
  // 图例文案里不许再出现那两个术语（用户明确要求在图例中去掉）
  for (const term of ['本场已挂', '来路']) {
    assert.equal(block.includes(term), false, `图例里不该再出现「${term}」`)
  }
})

test('回归守卫：recent 环满不透明（不许把脉冲的淡出套到常驻环上）', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const at = src.indexOf('if (isRecent) {')
  assert.ok(at > 0, '找不到 recent 环绘制块')
  const block = src.slice(at, at + 900)
  assert.ok(/ctx\.globalAlpha = alpha\b/.test(block), 'recent 常驻环必须满不透明')
  assert.equal(/ctx\.globalAlpha = alpha \* \(0\.45/.test(block), false,
    '常驻环不许再乘 0.45 之类的淡出系数——图上那圈会发灰，与图例实心色对不上')
  assert.ok(block.includes('COLORS.recentMark'), 'recent 环必须用 recentMark')
})
