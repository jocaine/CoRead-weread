#!/usr/bin/env node
/**
 * 固化后分段（segmentStack）单元测试 — 内置 node:test。
 * 运行：node test/segment-stack.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { segmentStack } from '../lib/segment-stack.js'

function makeLLM(results) {
  let i = 0
  return async () => {
    if (i >= results.length) throw new Error('假 LLM 队列耗尽')
    return results[i++]
  }
}

const u = (content, extra = {}) => ({ role: 'user', content, ...extra })
const a = (content) => ({ role: 'assistant', content })

test('分段：先判专题化（无内核轮次不做过滤处理，跟随并入）→ 再判同一性（切段）', async () => {
  // m1 t(true)（开组）；m2 判专题化 false + 降级补判 false（有上一轮回复）→ 无内核，
  // 但**不做过滤处理**：不判同一、跟随并入当前组；m3 t(true) + same(true)（并入）
  const llm = makeLLM(['{"topicized":true}', '{"topicized":false}', '{"topicized":false}', '{"topicized":true}', '{"same":true}'])
  const r = await segmentStack([
    u('问题A'),
    a('回答A'),
    u('闲聊轮次'),   // 无内核 → 跟随并入（不滤掉）
    u('问题B'),      // 与组A 同一 → 并入
  ], { callLLM: llm })
  assert.equal(r.ignored, 0, '无内核轮次不做过滤处理')
  assert.equal(r.segments.length, 1)
  assert.deepEqual(r.segments[0].entries.filter((e) => e.role === 'user').map((e) => e.content), ['问题A', '闲聊轮次', '问题B'], '无内核轮次跟随并入当前组')
})

test('分段：发散的具体问题切段（同一栈内多个不可分割组）', async () => {
  // m1 t(true) 开组；m2 t(true) + same(false) → 切段开新组
  const llm = makeLLM(['{"topicized":true}', '{"topicized":true}', '{"same":false}'])
  const r = await segmentStack([
    u('哥萨克立场为什么复杂？'),
    a('回答'),
    u('教会为什么不给自杀者念经？'),
  ], { callLLM: llm })
  assert.equal(r.segments.length, 2, '发散的具体问题切成两段')
  assert.equal(r.segments[0].entries[0].content, '哥萨克立场为什么复杂？')
  assert.equal(r.segments[1].entries[0].content, '教会为什么不给自杀者念经？')
})

test('分段：cites 按组收集（去重）；assistant 轮次跟随入组', async () => {
  const llm = makeLLM(['{"topicized":true}', '{"topicized":true}', '{"same":false}'])
  const r = await segmentStack([
    u('问题A', { cites: ['n_x', 'n_x'] }),
    a('回答A'),
    u('问题B', { cites: ['n_y'] }),
  ], { callLLM: llm })
  assert.equal(r.segments.length, 2)
  assert.deepEqual(r.segments[0].cites, ['n_x'], '组1 引用去重')
  assert.deepEqual(r.segments[1].cites, ['n_y'], '组2 引用')
  assert.equal(r.segments[0].entries.some((e) => e.role === 'assistant'), true, 'assistant 轮次跟随入组')
})

test('分段：单轮栈 → 单组；空输入 → 空；缺 callLLM 抛 TypeError', async () => {
  const r1 = await segmentStack([u('唯一问题')], { callLLM: makeLLM(['{"topicized":true}']) })
  assert.equal(r1.segments.length, 1)
  assert.equal(r1.segments[0].entries.length, 1)
  const r2 = await segmentStack([], { callLLM: makeLLM([]) })
  assert.equal(r2.segments.length, 0)
  await assert.rejects(() => segmentStack([u('Q')]), /callLLM/)
})

test('分段：verdictOf 复用已判专题化结论（不调 LLM）；未命中走 LLM', async () => {
  // 全部轮次由 verdictOf 给结论（无内核轮次跟随并入，不滤掉）：假 LLM 队列为空也跑得动
  const r1 = await segmentStack([
    u('问题A', { _caseId: 'c1' }),
    a('回答A'),
    u('闲聊轮次', { _caseId: 'c2' }),  // verdictOf → false → 无内核，跟随并入
    u('问题B', { _caseId: 'c3' }),     // verdictOf → true → 判同一性（无 LLM 时走失败兜底 same=true 并入）
  ], {
    callLLM: makeLLM([]),
    verdictOf: (e) => (e._caseId === 'c2' ? false : e._caseId ? true : undefined),
  })
  assert.equal(r1.ignored, 0, 'verdictOf=false 的轮次不做过滤处理')
  assert.equal(r1.segments.length, 1, '问题A/闲聊/问题B 并入一组')
  assert.deepEqual(r1.segments[0].entries.filter((e) => e.role === 'user').map((e) => e._caseId), ['c1', 'c2', 'c3'], '无内核轮次跟随并入')
  // verdictOf 未命中的轮次走 LLM（队列里有判专题化判定）
  const r2 = await segmentStack([u('问题C', { _caseId: 'cx' })], {
    callLLM: makeLLM(['{"topicized":true}']),
    verdictOf: (e) => (e._caseId === 'cx' ? undefined : undefined),
  })
  assert.equal(r2.segments.length, 1, 'verdictOf 未命中 → LLM 判定专题化')
  // 条目额外字段（_caseId）透传保留
  assert.equal(r2.segments[0].entries[0]._caseId, 'cx', '段内条目保留原条目额外字段')
  await assert.rejects(
    () => segmentStack([u('Q')], { callLLM: makeLLM([]), verdictOf: 'not-a-fn' }),
    /verdictOf/,
  )
})
