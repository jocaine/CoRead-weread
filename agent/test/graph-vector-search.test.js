import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGraphVectorSearch, requestEmbeddings } from '../lib/graph-vector-search.js'
import { localGraphEmbedding } from '../lib/local-embedding.js'

const config = { configured: true, embedBase: 'https://embed.invalid/v1', embedModel: 'test-model', embedKey: 'test-key' }
const texts = { first: [40, 1], duplicate: [9, 2], other: [3, 4], edit: [0, 1], query: [2, 0] }

test('回答前等待首次及新增描述准备完成，准备中不能提前查找', async () => {
  let release
  const requests = []
  const search = createGraphVectorSearch({ localEmbedding: {
    id: 'waiting-test',
    embed: async input => {
      requests.push(input)
      await new Promise(resolve => { release = resolve })
      return input.map(() => Float32Array.of(1, 0))
    },
  } })
  const nodes = [{ id: 'A', descriptions: ['first'] }]
  for (const description of ['first', 'second']) {
    nodes[0].descriptions = description === 'first' ? ['first'] : ['first', 'second']
    let finished = false
    const waiting = search.ready(nodes).then(result => { finished = true; return result })
    await Promise.resolve()
    assert.equal(finished, false)
    release()
    const prepared = await waiting
    assert.equal(prepared.entries.length, description === 'first' ? 1 : 2)
  }
  assert.deepEqual(requests, [['first'], ['second']])
  assert.equal((await search.ready(nodes)).entries.length, 2)
  assert.equal(requests.length, 2)
})

test('准备失败明确拒绝继续，间隔60秒后可重新准备并恢复', async (t) => {
  let calls = 0
  let failing = true
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const search = createGraphVectorSearch({ localEmbedding: {
    id: 'failure-test',
    embed: async input => {
      calls++
      if (failing) throw new Error('模型加载失败')
      return input.map(() => Float32Array.of(1, 0))
    },
  } })
  const nodes = [{ id: 'A', descriptions: ['first'] }]
  await assert.rejects(search.ready(nodes), /模型加载失败/)
  await assert.rejects(search.ready(nodes), /模型加载失败/)
  assert.equal(calls, 1)
  failing = false
  now += 60_000
  assert.equal((await search.ready(nodes)).entries.length, 1)
  assert.equal(calls, 2)
})

test('描述逐条查找、同节点合并；重启不用重算，改描述只补新增文本', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-vectors-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cacheFile = path.join(dir, 'cache.json')
  const requests = []
  const fetchImpl = async (_, { body }) => {
    const { input } = JSON.parse(body)
    requests.push(input)
    return Response.json({ data: input.map((x, index) => ({ index, embedding: texts[x] })).reverse() })
  }
  const nodes = [
    { id: 'A', point: 'unindexed title', aliases: ['unindexed alias'], descriptions: ['first', 'duplicate'] },
    { id: 'B', descriptions: ['other'] },
    { id: 'C', point: 'not a fallback', descriptions: [] },
  ]
  const cold = createGraphVectorSearch({ cacheFile, fetchImpl })
  assert.equal(cold.prepare(nodes, config), null)
  await cold.waitForIndex()
  assert.deepEqual(requests, [['first', 'duplicate', 'other']])
  const restarted = createGraphVectorSearch({ cacheFile, fetchImpl })
  assert.deepEqual((await restarted.search('query', restarted.prepare(nodes, config))).map(n => n.id), ['A', 'B'])
  nodes[0].descriptions = ['edit']
  assert.equal(restarted.prepare(nodes, config), null)
  await restarted.waitForIndex()
  assert.deepEqual((await restarted.search('query', restarted.prepare(nodes, config))).map(n => n.id), ['B'])
  assert.deepEqual(requests, [['first', 'duplicate', 'other'], ['query'], ['edit'], ['query']])
})

test('0.48 门槛和 8 条上限分开生效，超额时按每个节点的最高分取舍', async () => {
  const vector = score => [score, Math.sqrt(1 - score ** 2)]
  const embeddings = {
    above: vector(0.4848), below: vector(0.479), moderate: vector(0.6), strong: [1, 0], query: [1, 0], unrelated: [-1, 0],
  }
  const fetchImpl = async (_, { body }) => {
    const { input } = JSON.parse(body)
    return Response.json({ data: input.map((text, index) => ({ index, embedding: embeddings[text] })) })
  }
  const nodes = [
    { id: 'above', descriptions: ['above'] },
    { id: 'below', descriptions: ['below'] },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `strong-${i}`, descriptions: ['strong'] })),
    { id: 'multiple', descriptions: ['strong', 'moderate'] },
    { id: 'moderate', descriptions: ['moderate'] },
  ]
  const search = createGraphVectorSearch({ fetchImpl })
  search.prepare(nodes, config)
  await search.waitForIndex()
  const prepared = search.prepare(nodes, config)
  const sixNodes = search.prepare(nodes.slice(0, 7), config)
  assert.deepEqual((await search.search('query', sixNodes)).map(n => n.id), ['above', 'strong-0', 'strong-1', 'strong-2', 'strong-3', 'strong-4'])
  assert.deepEqual((await search.search('query', prepared)).map(n => n.id), [...Array.from({ length: 7 }, (_, i) => `strong-${i}`), 'multiple'])
  assert.deepEqual(await search.search('unrelated', prepared), [])
})

test('服务返回重复的序号时拒绝整批，避免把向量配到错误描述上', async () => {
  const fetchImpl = async () => Response.json({ data: [{ index: 0, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })
  await assert.rejects(requestEmbeddings(config, ['a', 'b'], fetchImpl), /向量序号无效/)
})

test('本地模型按 0.59 筛选，不读取已有的云端向量，也不访问云端接口', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-local-vectors-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cacheFile = path.join(dir, 'cache.json')
  const nodes = [{ id: 'near', descriptions: ['near'] }, { id: 'far', descriptions: ['far'] }]
  const cloud = createGraphVectorSearch({ cacheFile, fetchImpl: async () => Response.json({
    data: nodes.map((_, index) => ({ index, embedding: [1, 0] })),
  }) })
  cloud.prepare(nodes, config)
  await cloud.waitForIndex()

  const requests = []
  const local = createGraphVectorSearch({ cacheFile, fetchImpl: () => assert.fail('不应调用云端'), localEmbedding: {
    ...localGraphEmbedding,
    embed: async (input) => {
      requests.push(input)
      return input.map(text => {
        const score = { near: 0.5905, far: 0.589, query: 1 }[text]
        return Float32Array.of(score, Math.sqrt(1 - score ** 2))
      })
    },
  } })
  assert.equal(local.prepare(nodes), null)
  await local.waitForIndex()
  assert.deepEqual((await local.search('query', local.prepare(nodes))).map(node => node.id), ['near'])
  assert.deepEqual(requests, [['near', 'far'], ['query']])
})
