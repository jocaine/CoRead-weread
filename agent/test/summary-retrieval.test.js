import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPointPrompt, buildAliasPrompt, parsePointResult, parseAliasesResult, buildReferencePrompt } from '../lib/knowledge-graph.js'
import { consolidateDiscussion } from '../lib/graph-consolidate.js'
import { buildDescriptionsPrompt, parseDescriptions, deriveDescriptions } from '../lib/retrieval-descriptions.js'

test('无补充侧面的讨论仍能创建节点，不重试、不凑 aliases', async () => {
  const graph = { nodes: [], edges: [] }
  let calls = 0
  await consolidateDiscussion(graph, {
    question: '顿河流通券为什么失去信用？',
    excerpts: [{ q: '是政权的问题吗？', a: '还需要进一步讨论。' }],
  }, { callLLM: async () => {
    calls++
    return '{"descriptions":[]}'
  } })
  assert.equal(calls, 1)
  assert.equal(graph.nodes.length, 1)
  assert.deepEqual(graph.nodes[0].aliases, [])
  assert.deepEqual(graph.nodes[0].descriptions, [])
})

test('统一描述没有条数限制；超篇幅不截断，重试后才接受', async () => {
  const many = Array.from({ length: 9 }, (_, i) => '独立问题' + i)
  assert.deepEqual(parseDescriptions(JSON.stringify({ descriptions: many })), many)
  assert.equal(parseDescriptions(JSON.stringify({ descriptions: ['字'.repeat(401)] })), null)
  assert.equal(parseDescriptions('{"descriptions":[123]}'), null)
  const prompt = buildDescriptionsPrompt([{ q: '为什么？', a: '解释', selected: { text: '书中原文' } }])
  assert.ok(prompt.includes('书中原文'))
  assert.ok(prompt.includes('不是结论摘要'))
  assert.ok(!prompt.includes('最多 4 条'))
  let calls = 0
  const result = await deriveDescriptions([{ q: 'Q', a: 'A' }], { callLLM: async () => {
    calls++
    return JSON.stringify({ descriptions: calls === 1 ? ['字'.repeat(401)] : many })
  } })
  assert.equal(calls, 2)
  assert.deepEqual(result.descriptions, many)
})

test('已迁移节点用统一描述匹配，不再把旧标题或旧问题当作索引', () => {
  const prompt = buildReferencePrompt({ message: '提问', nodes: [
    { id: 'new', point: '过时的标题', aliases: ['过时的背景'], questions: ['过时的问题'], descriptions: ['对象与讨论关系'] },
    { id: 'old', point: '未迁移的标题', aliases: ['旧描述'] },
  ] })
  assert.ok(prompt.includes('对象与讨论关系'))
  assert.ok(!prompt.includes('过时的标题'))
  assert.ok(!prompt.includes('过时的背景'))
  assert.ok(!prompt.includes('过时的问题'))
  assert.ok(prompt.includes('未迁移的标题'))
})

test('生成材料保留对象与分歧要求，不再鼓励穷尽背景面', () => {
  const input = { question: '为什么？', point: '具体问题', excerpts: [{ q: '我不同意', a: '有另一种解释' }] }
  const point = buildPointPrompt(input)
  const aliases = buildAliasPrompt(input)
  assert.ok(point.includes('具体对象、比较项和否定条件'))
  for (const prompt of [point, aliases]) {
    assert.ok(prompt.includes('共同结论'))
    assert.ok(prompt.includes('不确定程度'))
  }
  assert.ok(aliases.includes('实质讨论篇幅和推进程度'))
  assert.ok(aliases.includes('返回空数组'))
  assert.ok(!aliases.includes('宁可多写'))
  assert.ok(!aliases.includes('各成一条'))
})

test('拒绝非文字结果及伪空补充，接受明确的空数组', () => {
  for (const point of [{ bad: true }, 123, ['标题']]) {
    assert.equal(parsePointResult(JSON.stringify({ point })), null)
  }
  assert.deepEqual(parseAliasesResult('{"aliases":[]}'), { aliases: [] })
  for (const aliases of [null, '标题', [123], [{}], ['   ']]) {
    assert.equal(parseAliasesResult(JSON.stringify({ aliases })), null)
  }
})
