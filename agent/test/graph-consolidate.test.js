#!/usr/bin/env node
/**
 * 固化（收口讨论 → 会意图）单元测试 — 内置 node:test。
 * 运行：node test/graph-consolidate.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createGraph, addNode, findNode, addEdge, contextOf } from '../lib/knowledge-graph.js'
import { consolidateDiscussion, addDerivedEdge, addCitationEdges, pruneRedundantCitationEdges, nextNodeId, groupExcerpts, cloneGraph } from '../lib/graph-consolidate.js'

// 假 LLM：按队列吐预设文本（与 knowledge-graph 测试同款）
function makeLLM(results) {
  let i = 0
  return async () => {
    if (i >= results.length) throw new Error('假 LLM 队列耗尽')
    return results[i++]
  }
}

test('固化：直建节点（derivePoint → deriveAliases → 新建，讨论无损；节点不可变）', async () => {
  const g = createGraph()
  const llm = makeLLM([
    '{"point":"列宁分化哥萨克的策略"}',
    '{"aliases":["列宁分化哥萨克的策略为什么没奏效","用阶级的眼睛看哥萨克，套错了对象"]}',
  ])
  const r = await consolidateDiscussion(g, {
    question: '为什么列宁最初分化哥萨克的策略没有奏效？',
    book: '《静静的顿河》',
    chapter: '五',
    excerpts: [{ q: '为什么没奏效', a: '身份社会错用了手术刀' }],
  }, { callLLM: llm })
  assert.equal(r.point, '列宁分化哥萨克的策略')
  assert.equal(g.nodes.length, 1)
  const n = findNode(g, r.nodeId)
  assert.equal(n.point, '列宁分化哥萨克的策略')
  assert.deepEqual(n.aliases, ['列宁分化哥萨克的策略为什么没奏效', '用阶级的眼睛看哥萨克，套错了对象'])
  assert.equal(n.discussions.length, 1)
  assert.equal(n.discussions[0].question, '为什么列宁最初分化哥萨克的策略没有奏效？')
  assert.equal(n.discussions[0].excerpts[0].a, '身份社会错用了手术刀', 'excerpts 无损入库')
})

test('固化：直建节点（不判同）——同样 point 的第二次讨论也新建节点，节点不可变', async () => {
  const g = createGraph()
  // 两次固化同一点 point：每次都是新节点（2026-08-29 用户定调：去聚合判同）
  for (let i = 0; i < 2; i++) {
    const llm = makeLLM(['{"point":"列宁分化哥萨克的策略"}', '{"aliases":["阶级分析的手术刀"]}'])
    const r = await consolidateDiscussion(g, { question: `第 ${i + 1} 次讨论列宁策略？`, excerpts: [{ q: 'Q', a: 'A' }] }, { callLLM: llm })
    assert.equal(g.nodes.length, i + 1, '每次固化都新建节点')
    assert.equal(findNode(g, r.nodeId).discussions.length, 1, '讨论不追加进旧节点')
  }
  assert.equal(g.nodes.length, 2)
})

test('固化：节点 id 唯一（时间戳 + 序号）', () => {
  const a = nextNodeId(1787000000000)
  const b = nextNodeId(1787000000000)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('n_'))
})

test('固化：derived 边（跳过缺失/同节点）；user 引用边（from 缺失/同节点/重复跳过）', () => {
  const g = createGraph()
  addNode(g, { id: 'n_a', point: 'A' })
  addNode(g, { id: 'n_b', point: 'B' })
  assert.equal(addDerivedEdge(g, 'n_a', 'n_b'), 1)
  assert.equal(addDerivedEdge(g, 'n_a', 'n_b'), 0, '同 pair 已有 derived 边去重（评审 P5）')
  assert.equal(addDerivedEdge(g, 'n_a', 'n_a'), 0, '同节点跳过')
  assert.equal(addDerivedEdge(g, 'n_x', 'n_b'), 0, '缺失节点跳过')
  assert.equal(addCitationEdges(g, ['n_a', 'n_a', 'n_b', 'n_不存在'], 'n_b'), 1, '重复引用同节点只建一条（去重）')
  assert.equal(addCitationEdges(g, ['n_a'], 'n_b'), 0, '同 pair 已存在则跳过')
  assert.equal(g.edges.filter((e) => e.kind === 'user').length, 1)
})

// ── user 边：同脉络多命中折叠（2026-09 用户定调：一个节点命中同一条脉络多个节点，
//    只按脉络上最后（recent 侧）的一个命中节点建边；只在本次命中列表内折叠，
//    绝不越过命中列表接到脉络更晚的节点——脉络自身的边原样保留）──────────────

test('user 边：同脉络多命中只按最后命中节点建边（收口分段 A 场景，不越过命中列表接 c）', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_b', 'n_c', 'n_A', 'n_B']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_b', kind: 'derived' })  // 脉络 M：a→b→c
  addEdge(g, { from: 'n_b', to: 'n_c', kind: 'derived' })
  // 收口分段 A 命中脉络 M 上的 a、b → 只按最后命中节点 b 建边（b→A）
  assert.equal(addCitationEdges(g, ['n_a', 'n_b'], 'n_A'), 1)
  assert.equal(g.edges.filter((e) => e.to === 'n_A').length, 1)
  assert.equal(g.edges.some((e) => e.from === 'n_b' && e.to === 'n_A'), true, '只建最后命中节点 b 的边')
  assert.equal(g.edges.some((e) => e.from === 'n_a' && e.to === 'n_A'), false, '较早命中节点 a 被折叠（内容已被 b 包含）')
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_A'), false, '绝不越过命中列表把脉络更晚的 c 直接接 A')
  // 同栈另一段 B 命中 c → B 自己建 c→B（互不串扰；c 不由 A 代接）
  assert.equal(addCitationEdges(g, ['n_c'], 'n_B'), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_B'), true)
  // 脉络自身边（a→b、b→c）原样保留
  assert.equal(g.edges.filter((e) => e.kind === 'derived').length, 2)
})

test('user 边：命中整条脉络只建一条（最晚节点）；跨脉络互不可达的命中各自建边', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_b', 'n_c', 'n_d', 'n_e', 'n_x', 'n_y']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_b' })  // 脉络一（user 边成链）：a→b→c
  addEdge(g, { from: 'n_b', to: 'n_c' })
  addEdge(g, { from: 'n_d', to: 'n_e', kind: 'derived' })  // 脉络二：d→e
  // 命中整条脉络 a、b、c → 只建最后节点 c 的一条边
  assert.equal(addCitationEdges(g, ['n_a', 'n_b', 'n_c'], 'n_x'), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_x'), true)
  assert.equal(g.edges.filter((e) => e.to === 'n_x').length, 1)
  // 跨两条脉络命中（b 在脉络一、e 在脉络二，互不可达、内容互不包含）→ 各建一条
  assert.equal(addCitationEdges(g, ['n_b', 'n_e'], 'n_y'), 2)
  assert.equal(g.edges.some((e) => e.from === 'n_b' && e.to === 'n_y'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_e' && e.to === 'n_y'), true)
})

test('user 边：脉络祖先关系隔未命中中间节点也折叠；分支互不可达的命中不折叠', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_x', 'n_c', 'n_m', 'n_n', 'n_t']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_x' })  // 脉络：a→x→c（x 未被命中）
  addEdge(g, { from: 'n_x', to: 'n_c' })
  addEdge(g, { from: 'n_a', to: 'n_m' })  // a 的另一分支：m→n
  addEdge(g, { from: 'n_m', to: 'n_n' })
  // 命中 a、c（中间节点 x 未命中）：a 经 x 仍可达 c → 折叠成 c 一条边
  assert.equal(addCitationEdges(g, ['n_a', 'n_c'], 'n_t'), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_t'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_a' && e.to === 'n_t'), false)
  // 命中 a、x、n：a 是 x 的祖先被折叠（内容被 x 包含）；n 与 x 互不可达 → 两条边
  const before = g.edges.length
  assert.equal(addCitationEdges(g, ['n_a', 'n_x', 'n_n'], 'n_t'), 2)
  assert.equal(g.edges.length - before, 2)
  assert.equal(g.edges.some((e) => e.from === 'n_x' && e.to === 'n_t'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_n' && e.to === 'n_t'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_a' && e.to === 'n_t'), false, 'a 的内容已被 x 包含，不重复建边')
})

// ── 冗余 user 边清理（2026-09 用户定调：段间 derived 链覆盖上游命中 → 该 user 边
//    与 b→A+A→B 效果相同，删除；derived 边与其它节点一律不动）──────────────

test('冗余清理：脉络 a→c→b（c 在 b 上游），A 命中 {a,b}→b→A，B 命中 c 且 A→B 衍生成立 → 删 c→B', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_c', 'n_b', 'n_A', 'n_B']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_c', kind: 'derived' })  // 脉络 M：a→c→b
  addEdge(g, { from: 'n_c', to: 'n_b', kind: 'derived' })
  // 收口分段：A 命中 a、b（折叠只建最后命中节点 b）；B 命中 c
  assert.equal(addCitationEdges(g, ['n_a', 'n_b'], 'n_A'), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_b' && e.to === 'n_A'), true)
  assert.equal(addCitationEdges(g, ['n_c'], 'n_B'), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_B'), true, '先建 c→B（此时 A→B 尚未判定）')
  addDerivedEdge(g, 'n_A', 'n_B')  // 段间衍生判定成立
  // 清理：c 已能沿 c→b→A→B 到达 B → c→B 冗余
  assert.equal(pruneRedundantCitationEdges(g, ['n_A', 'n_B']), 1)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_B'), false, '删 c→B（不建，效果由 b→A+A→B 达成）')
  assert.equal(g.edges.some((e) => e.from === 'n_b' && e.to === 'n_A'), true, 'b→A 保留')
  assert.equal(g.edges.some((e) => e.from === 'n_A' && e.to === 'n_B' && e.kind === 'derived'), true, 'derived A→B 保留')
  assert.equal(g.edges.filter((e) => e.kind === 'derived').length, 3, '脉络自身边 + derived A→B 原样')
  // 效果相同：清理前后 B 的 L3 上下文（root→recent 路径并集）逐 id 一致
  const before = contextOf(g, ['n_B']).map((n) => n.id)
  g.edges.push({ from: 'n_c', to: 'n_B', kind: 'user' })  // 模拟不清理的旧状态
  const after = contextOf(g, ['n_B']).map((n) => n.id)
  assert.deepEqual(before, after, '删 c→B 后上下文不变（内容已被 A→B 链覆盖）')
})

test('冗余清理：脉络 a→b→c（c 在 b 下游）时 c→B 不删（A→B 覆盖不到 c 的内容）', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_b', 'n_c', 'n_A', 'n_B']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_b', kind: 'derived' })  // 脉络 M：a→b→c
  addEdge(g, { from: 'n_b', to: 'n_c', kind: 'derived' })
  addCitationEdges(g, ['n_a', 'n_b'], 'n_A')
  addCitationEdges(g, ['n_c'], 'n_B')
  addDerivedEdge(g, 'n_A', 'n_B')
  assert.equal(pruneRedundantCitationEdges(g, ['n_A', 'n_B']), 0, 'c 无替代路径到达 B，c→B 必须保留')
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_B'), true, '下游命中 c→B 不删（上轮定调）')
})

test('冗余清理：段间衍生判定不成立（无 A→B）时上游命中边不删（宁漏勿删）', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_c', 'n_b', 'n_A', 'n_B']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_c', kind: 'derived' })  // 脉络 M：a→c→b
  addEdge(g, { from: 'n_c', to: 'n_b', kind: 'derived' })
  addCitationEdges(g, ['n_a', 'n_b'], 'n_A')
  addCitationEdges(g, ['n_c'], 'n_B')
  // 无 derived A→B（衍生判定不成立/失败）：c 到 B 只有 c→B 一条路 → 不删
  assert.equal(pruneRedundantCitationEdges(g, ['n_A', 'n_B']), 0)
  assert.equal(g.edges.some((e) => e.from === 'n_c' && e.to === 'n_B'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_b' && e.to === 'n_A'), true)
})

test('冗余清理：只处理指定新节点，老节点入边与 derived 边不动', () => {
  const g = createGraph()
  for (const id of ['n_x', 'n_y', 'n_old', 'n_new']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_x', to: 'n_y', kind: 'derived' })  // 脉络：x→y
  addEdge(g, { from: 'n_x', to: 'n_old' })                 // 老节点既有 user 边
  addCitationEdges(g, ['n_y'], 'n_new')                   // 新节点入边
  addDerivedEdge(g, 'n_old', 'n_new')
  assert.equal(pruneRedundantCitationEdges(g, ['n_new']), 0, 'n_new 无冗余（n_y 到 n_new 无替代路径）')
  assert.equal(g.edges.some((e) => e.from === 'n_y' && e.to === 'n_new'), true)
  assert.equal(g.edges.some((e) => e.from === 'n_x' && e.to === 'n_old'), true, '老节点入边不受清理影响')
  assert.equal(pruneRedundantCitationEdges(g, ['n_old']), 0, '把老节点当目标也不删（其边是历史事实）')
  assert.equal(g.edges.some((e) => e.from === 'n_x' && e.to === 'n_old'), true)
  assert.equal(pruneRedundantCitationEdges(g, []), 0, '空目标列表 → 0')
})

test('固化：缺 question / 未注入 callLLM 抛 TypeError', async () => {
  const g = createGraph()
  await assert.rejects(() => consolidateDiscussion(g, { excerpts: [] }, { callLLM: makeLLM(['{}']) }), /question/)
  await assert.rejects(() => consolidateDiscussion(g, { question: 'Q？' }), /callLLM/)
})

test('groupExcerpts：user/assistant 配对成 {q, a}，无回复的提问舍弃', () => {
  assert.deepEqual(groupExcerpts([
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'Q3' },  // 未配对（最后一条 user）
  ]), [{ q: 'Q1', a: 'A1' }, { q: 'Q2', a: 'A2' }])
  assert.deepEqual(groupExcerpts([]), [])
})

test('cloneGraph：深拷贝副本，固化沙盒互不影响（自由模式用）', () => {
  const g = createGraph()
  addNode(g, { id: 'n_a', point: 'A', aliases: ['能指A'], discussions: [{ question: 'Q？', excerpts: [{ q: 'Q', a: 'A' }] }] })
  addNode(g, { id: 'n_b', point: 'B' })
  addEdge(g, { from: 'n_a', to: 'n_b' })
  const copy = cloneGraph(g)
  assert.deepEqual(copy.nodes, g.nodes, '副本内容与原图一致')
  assert.deepEqual(copy.edges, g.edges)
  // 改副本（模拟自由模式固化）不碰原图
  addNode(copy, { id: 'n_c', point: 'C' })
  addEdge(copy, { from: 'n_a', to: 'n_c' })
  copy.nodes[0].point = '被改了'
  assert.equal(g.nodes.length, 2, '原图节点数不变')
  assert.equal(g.edges.length, 1, '原图边数不变')
  assert.equal(findNode(g, 'n_a').point, 'A', '原图节点内容不被副本改动污染')
  assert.equal(findNode(copy, 'n_c').point, 'C', '副本可独立新建节点')
  // 无图/空图 → 空副本
  assert.deepEqual(cloneGraph(null), { nodes: [], edges: [] })
})
