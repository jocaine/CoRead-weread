#!/usr/bin/env node
/**
 * 固化（收口讨论 → 会意图）单元测试 — 内置 node:test。
 * 运行：node test/graph-consolidate.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createGraph, addNode, findNode } from '../lib/knowledge-graph.js'
import { consolidateDiscussion, addDerivedEdge, addCitationEdges, nextNodeId, groupExcerpts } from '../lib/graph-consolidate.js'

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
