// hotNodes（会意图热点节点）：画像"他大致关心什么"的材料来源，分三层取（2026-10 用户定调）。
// 门槛管质量、名额管数量。排序键：跨到几本书 → 跨书被引次数 → 总被引次数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hotNodes } from '../lib/knowledge-graph.js'

// 每个节点挂一个 book；引用者（to）挂自己的 book，用来看"跨到几本书"
const N = (id, book, point = '') => ({ id, point, discussions: book ? [{ book }] : [] })
const flat = (r) => [...r.super, ...r.qualified, ...r.general]

test('排序：跨到几本书优先于跨书被引次数', () => {
  const g = {
    nodes: [
      N('wide', '甲', '跨到两本书'),
      N('deep', '甲', '在一本外书里被引三次'),
      N('b1', '乙'), N('b2', '丙'),
      N('c1', '乙'), N('c2', '乙'), N('c3', '乙'),
    ],
    edges: [
      { from: 'wide', to: 'b1' }, { from: 'wide', to: 'b2' },        // 跨到 乙、丙 → 2 本
      { from: 'deep', to: 'c1' }, { from: 'deep', to: 'c2' }, { from: 'deep', to: 'c3' },  // 跨到 乙 → 1 本，3 次
    ],
  }
  const all = flat(hotNodes(g))
  assert.deepEqual(all.slice(0, 2).map((n) => n.id), ['wide', 'deep'], '跨 2 本的要排在跨 1 本被引 3 次的前面')
  assert.equal(all[0].crossBooks, 2)
  assert.equal(all[1].crossBooks, 1)
  assert.equal(all[1].crossEdge, 3)
})

test('超级招：跨到 ≥3 本不同的书 → 全录，且不占统招名额', () => {
  const g = {
    nodes: [
      N('star', '甲', '跨到三本书'), N('k1', '甲', '统招一'),
      N('x1', '乙'), N('x2', '丙'), N('x3', '丁'),   // star 跨到 乙丙丁
      N('y1', '乙'), N('y2', '乙'),                   // k1 跨到乙（1 本，被引 2 次 → 达线）
    ],
    edges: [
      { from: 'star', to: 'x1' }, { from: 'star', to: 'x2' }, { from: 'star', to: 'x3' },
      { from: 'k1', to: 'y1' }, { from: 'k1', to: 'y2' },
    ],
  }
  const r = hotNodes(g, { qualifierSlots: 1 })
  assert.deepEqual(r.super.map((n) => n.id), ['star'])
  assert.deepEqual(r.qualified.map((n) => n.id), ['k1'], 'star 不占名额，统招那一个名额仍收下 k1')
  assert.ok(!r.general.some((n) => n.id === 'star'), 'star 也不该在普招里再出现一次')
})

test('达线超过统招名额 → overflow 记数，落选者按排序先被普招补进', () => {
  const nodes = [], edges = []
  // 4 个达线的（各跨书被引 2 次）
  for (const id of ['k1', 'k2', 'k3', 'k4']) {
    nodes.push(N(id, '甲', id), N('p_' + id, '乙'))
    edges.push({ from: id, to: 'p_' + id }, { from: id, to: 'p_' + id })
  }
  // 2 个不达线的（只在同书里被引 1 次）
  for (const id of ['s1', 's2']) {
    nodes.push(N(id, '甲', id), N('q_' + id, '甲'))
    edges.push({ from: id, to: 'q_' + id })
  }

  const r = hotNodes({ nodes, edges }, { qualifierSlots: 2, generalSlots: 3 })
  assert.equal(r.qualified.length, 2)
  assert.equal(r.overflow, 2, '4 个达线只给了 2 个统招名额')
  assert.equal(r.general.length, 3)
  assert.ok(r.general.slice(0, 2).every((n) => n.crossEdge >= 2), '普招先补达线落选的，再轮到没达线的')
})

test('达线不足统招名额 → 普招补足总数', () => {
  const nodes = [N('k1', '甲'), N('g1', '甲', '同书一'), N('g2', '甲', '同书二'), N('g3', '甲', '同书三'), N('p1', '乙'), N('p2', '甲'), N('p3', '甲'), N('p4', '甲')]
  const edges = [
    { from: 'k1', to: 'p1' },     // k1 跨书 1 次 —— 不达"≥2"的线
    { from: 'g1', to: 'p2' }, { from: 'g2', to: 'p3' }, { from: 'g3', to: 'p4' },
  ]
  const r = hotNodes({ nodes, edges }, { qualifierSlots: 5, generalSlots: 3 })
  assert.deepEqual(r.qualified, [], '没人达线 → 统招空着')
  assert.equal(r.general.length, 3, '靠普招补足')
  assert.equal(r.overflow, 0)
})

test('derived 边不算被引用（那是同一栈相邻段的机械产物）', () => {
  const g = { nodes: [N('n', '甲'), N('c', '乙')], edges: [{ from: 'n', to: 'c', kind: 'derived' }] }
  const r = hotNodes(g)
  assert.deepEqual(flat(r), [])
})

test('从没被引用过的节点不入选（三层都空）', () => {
  const g = { nodes: [N('a', '甲'), N('b', '甲')], edges: [] }
  const r = hotNodes(g)
  assert.deepEqual(r.super, [])
  assert.deepEqual(r.qualified, [])
  assert.deepEqual(r.general, [])
  assert.equal(r.overflow, 0)
})

test('引用者没有 book 信息 → 计入总被引，不计入跨书（保持中立）', () => {
  const g = { nodes: [N('n', '甲'), N('c', null)], edges: [{ from: 'n', to: 'c' }] }
  const all = flat(hotNodes(g))
  assert.equal(all.length, 1)
  assert.equal(all[0].cited, 1, '总被引要算上')
  assert.equal(all[0].crossEdge, 0, '但不许误判成跨书')
  assert.equal(all[0].crossBooks, 0)
})

test('两边书集合有交集就不算跨书（严格口径）', () => {
  const g = { nodes: [N('n', '甲'), N('c', '甲')], edges: [{ from: 'n', to: 'c' }] }
  assert.equal(flat(hotNodes(g))[0].crossEdge, 0, '同一本书里自循环不算跨出语境')
})

test('同一本外书里被引多次 → 只算 1 本书（跨书数不等于跨书次数）', () => {
  const g = {
    nodes: [N('n', '甲'), N('c1', '乙'), N('c2', '乙'), N('c3', '乙')],
    edges: [{ from: 'n', to: 'c1' }, { from: 'n', to: 'c2' }, { from: 'n', to: 'c3' }],
  }
  const all = flat(hotNodes(g))
  assert.equal(all[0].crossEdge, 3)
  assert.equal(all[0].crossBooks, 1, '三边都落在乙书 → 只跨到 1 本')
})
