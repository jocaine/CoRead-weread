#!/usr/bin/env node
/**
 * 判同一性 + 专题化讨论栈（AI-016 / Q2.5）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/topic-stack.test.js
 * 与 topicize.test.js 互补：那边测单条判专题化，这里测多轮讨论的边界（同一性 + 栈状态机）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ATTEMPTS,
  STACK_CONTEXT_ROUNDS,
  judgeSameProblem,
  parseSameResult,
  buildSameProblemPrompt,
  buildSameProblemInstruction,
  formatStackContext,
  makeStackEntry,
  processStackMessage,
} from '../lib/topic-stack.js'

// ── 测试辅助 ────────────────────────────────────────────────────────────────
function makeLLM(...responses) {
  const queue = [...responses]
  return async (prompt, maxTokens) => {
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'callLLM 应收到非空 prompt')
    assert.ok(Number.isFinite(maxTokens), 'callLLM 应收到 maxTokens')
    const r = queue.shift()
    if (r === undefined) throw new Error('unexpected extra callLLM call')
    if (r instanceof Error) throw r
    return r
  }
}

const okTopic = (t) => JSON.stringify({ topicized: t })
const okSame = (s) => JSON.stringify({ same: s })

// 样例栈：两条用户轮次 + 一条 AI 回复
const sampleStack = [
  { role: 'user', content: '一个政权靠什么维持？光靠暴力撑不久', selected: { text: '老人认出故人，两人对坐无语', book: '《静静的顿河》', chapter: '六' } },
  { role: 'assistant', content: '维持靠的是一整套制度化安排，暴力只是最后的手段。' },
  { role: 'user', content: '那维持条件是内生的还是外来的？' },
]

const continuationMsg = { userNote: '不对，我觉得制度自身的惯性才是关键' }
const switchedMsg = { userNote: '列宁的工人贵族论为什么后来被抛弃了？' }
const chitchatMsg = { userNote: '哈哈这书真敢写' }

// ── buildSameProblemInstruction / prompt / context ──────────────────────────
test('判同一性指令包含二元等价判据（不命名不归类）', () => {
  const inst = buildSameProblemInstruction()
  for (const kw of ['是不是同一个问题', '不要求显式指代', '角度切换不切断', '不要给问题命名', '不要归类', '不要判断它有没有可推进内核']) {
    assert.ok(inst.includes(kw), `指令应包含「${kw}」`)
  }
})

test('判同一性指令输出纯 JSON 示例（same 字段）', () => {
  const inst = buildSameProblemInstruction()
  assert.ok(inst.includes('{"same":true}'), '格式示例应为一行纯 JSON')
  assert.ok(!inst.includes('topicized'), '判同一性不应出现 topicized 字段')
})

test('prompt 携带当前讨论（最近几轮）+ 新消息；划线带上', () => {
  const p = buildSameProblemPrompt(continuationMsg, sampleStack)
  assert.ok(p.includes('当前讨论'), '应标注当前讨论上下文')
  assert.ok(p.includes('一个政权靠什么维持'), '栈内用户轮次应出现')
  assert.ok(p.includes('维持靠的是一整套制度化安排'), '栈内 AI 回复应出现')
  assert.ok(p.includes('老人认出故人，两人对坐无语'), '划线应作为上下文带上')
  assert.ok(p.includes('新消息："不对，我觉得制度自身的惯性才是关键"'))
})

test('formatStackContext 窗口化：只取最近 N 轮', () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `轮${i}` }))
  const ctx = formatStackContext(long)
  const lines = ctx.split('\n')
  assert.equal(lines.length, STACK_CONTEXT_ROUNDS, '最多取 STACK_CONTEXT_ROUNDS 轮')
  assert.ok(ctx.includes('轮12') && ctx.includes('轮19'), '取的是最近的轮次')
  assert.ok(!ctx.includes('轮0'), '最早的轮次被窗口挤出')
})

test('formatStackContext 划线标注入行（结构体取 text）', () => {
  const ctx = formatStackContext([{ role: 'user', content: 'x', selected: { text: '划线y', book: '《b》', chapter: '一' } }])
  assert.ok(ctx.includes('（划线：划线y）'))
})

// ── parseSameResult ──────────────────────────────────────────────────────────
test('解析：同一问题 → {same:true}', () => {
  assert.deepEqual(parseSameResult(okSame(true)), { same: true })
})

test('解析：换问题 → {same:false}', () => {
  assert.deepEqual(parseSameResult(okSame(false)), { same: false })
})

test('解析：前言回显/围栏 → fallback 提取（复用 extractJsonObject 容忍逻辑）', () => {
  assert.deepEqual(parseSameResult('我们只需要输出JSON。{"same":true}'), { same: true })
  assert.deepEqual(parseSameResult('```json\n{"same":false}\n```'), { same: false })
})

test('解析：多余字段容忍；缺 same / 非布尔 → null', () => {
  assert.deepEqual(parseSameResult('{"same":true,"note":"承接上一轮"}'), { same: true })
  assert.equal(parseSameResult('{}'), null)
  assert.equal(parseSameResult('{"same":"yes"}'), null)
  assert.equal(parseSameResult('闲聊'), null)
})

// ── judgeSameProblem 主流程 ──────────────────────────────────────────────────
test('主流程：同一问题 → same:true', async () => {
  const r = await judgeSameProblem(continuationMsg, sampleStack, { callLLM: makeLLM(okSame(true)) })
  assert.equal(r.same, true)
  assert.equal(r.attempts, 1)
})

test('主流程：换问题 → same:false', async () => {
  const r = await judgeSameProblem(switchedMsg, sampleStack, { callLLM: makeLLM(okSame(false)) })
  assert.equal(r.same, false)
})

test('主流程：maxTokens 原样透传', async () => {
  let seen = null
  await judgeSameProblem(continuationMsg, sampleStack, {
    maxTokens: 256,
    callLLM: async (p, mt) => { seen = mt; return okSame(true) },
  })
  assert.equal(seen, 256)
})

test('主流程：非法输出重试，重试 prompt 携带修正提示', async () => {
  const prompts = []
  const r = await judgeSameProblem(continuationMsg, sampleStack, {
    callLLM: async (p, mt) => {
      prompts.push(p)
      if (prompts.length === 1) return '坏'
      return okSame(true)
    },
    log: () => {},
  })
  assert.equal(r.same, true)
  assert.equal(r.attempts, 2)
  assert.ok(prompts[1].includes('上一次输出未通过校验'))
})

test('重试：网络失败时重发原样 prompt（不带修正提示——模型没收到过它）', async () => {
  const prompts = []
  const r = await judgeSameProblem(continuationMsg, sampleStack, {
    callLLM: async (p, mt) => {
      prompts.push(p)
      if (prompts.length === 1) throw new Error('network down')
      return okSame(true)
    },
    log: () => {},
  })
  assert.equal(r.same, true)
  assert.equal(r.attempts, 2)
  assert.equal(prompts[1], prompts[0], '网络失败重试应原样重发 basePrompt')
  assert.ok(!prompts[1].includes('上一次输出未通过校验'), '网络失败不应带修正提示')
})

test('重试：⚠️ 失败串重发原样 prompt（不带修正提示）', async () => {
  const prompts = []
  const r = await judgeSameProblem(continuationMsg, sampleStack, {
    callLLM: async (p, mt) => {
      prompts.push(p)
      if (prompts.length === 1) return '⚠️ 上游 500'
      return okSame(true)
    },
    log: () => {},
  })
  assert.equal(r.same, true)
  assert.equal(r.attempts, 2)
  assert.equal(prompts[1], prompts[0], '⚠️ 失败串重试应原样重发 basePrompt')
  assert.ok(!prompts[1].includes('上一次输出未通过校验'))
})

test('主流程：耗尽尝试后抛错', async () => {
  await assert.rejects(
    judgeSameProblem(continuationMsg, sampleStack, { callLLM: makeLLM('坏', '坏', '坏') }),
    /3 次尝试后仍无有效判定/,
  )
})

test('主流程：LLM 返回失败串 → 抛错', async () => {
  await assert.rejects(
    judgeSameProblem(continuationMsg, sampleStack, { callLLM: makeLLM('⚠️ 上游 500', '⚠️ 上游 500', '⚠️ 上游 500') }),
    /判同一性 LLM 返回失败串/,
  )
})

test('主流程：空栈 / 缺消息 / 未注入 callLLM → TypeError', async () => {
  await assert.rejects(judgeSameProblem(continuationMsg, [], { callLLM: makeLLM(okSame(true)) }), /需要非空栈/)
  await assert.rejects(judgeSameProblem({ userNote: '' }, sampleStack, { callLLM: makeLLM(okSame(true)) }), /需要新消息内容/)
  await assert.rejects(judgeSameProblem(continuationMsg, sampleStack, {}), /必须注入 callLLM/)
})

test('MAX_ATTEMPTS / STACK_CONTEXT_ROUNDS 默认值', () => {
  assert.equal(MAX_ATTEMPTS, 3)
  assert.equal(STACK_CONTEXT_ROUNDS, 8)
})

// ── processStackMessage 栈状态机 ─────────────────────────────────────────────
test('空栈 + 专题化消息 → pushed（开新栈，划线结构体原样带上）', async () => {
  const msg = { userNote: '政权靠什么维持？', selected: { text: '老人认出故人', book: '《静静的顿河》', chapter: '六' } }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(true)), log: () => {} })
  assert.equal(r.action, 'pushed')
  assert.equal(r.stack.length, 1)
  assert.equal(r.stack[0].content, '政权靠什么维持？')
  assert.equal(r.stack[0].selected.text, '老人认出故人')
  assert.equal(r.stack[0].selected.book, '《静静的顿河》')
  assert.equal(r.stack[0].role, 'user')
})

test('空栈 + 非专题化消息 → ignored，栈保持空', async () => {
  const r = await processStackMessage([], { userNote: '这个词什么意思？' }, { callLLM: makeLLM(okTopic(false)), log: () => {} })
  assert.equal(r.action, 'ignored')
  assert.deepEqual(r.stack, [])
})

test('非空栈 + 同一问题 → pushed（累积，不调判专题化）', async () => {
  // 只调一次判同一性，队列里第二个响应不该被消费
  const r = await processStackMessage(sampleStack, continuationMsg, { callLLM: makeLLM(okSame(true)), log: () => {} })
  assert.equal(r.action, 'pushed')
  assert.equal(r.stack.length, sampleStack.length + 1)
  assert.equal(r.stack.at(-1).content, continuationMsg.userNote)
})

test('非空栈 + 换问题 + 专题化 → closed_and_pushed（收口旧栈 + 开新栈）', async () => {
  const now = () => 1786173499706
  const r = await processStackMessage(sampleStack, switchedMsg, { callLLM: makeLLM(okSame(false), okTopic(true)), log: () => {}, now })
  assert.equal(r.action, 'closed_and_pushed')
  assert.equal(r.closed.ts, 1786173499706, '讨论组 ts = 收口时间（可注入）')
  assert.deepEqual(r.closed.entries, sampleStack, '被收口的旧栈作为整栈桶归档进讨论组 entries')
  assert.equal(r.stack.length, 1, '新栈只有新消息')
  assert.equal(r.stack[0].content, switchedMsg.userNote)
})

test('非空栈 + 换问题 + 非专题化 → ignored（不切断，栈不变）', async () => {
  const r = await processStackMessage(sampleStack, chitchatMsg, { callLLM: makeLLM(okSame(false), okTopic(false)), log: () => {} })
  assert.equal(r.action, 'ignored')
  assert.deepEqual(r.stack, sampleStack, '栈原样保留')
})

test('makeStackEntry：无划线时不带 selected 字段', () => {
  assert.deepEqual(makeStackEntry({ userNote: '为什么？' }), { role: 'user', content: '为什么？' })
})

test('makeStackEntry：划线结构体原样透传（book/chapter 一并保留）', () => {
  const sel = { text: '老人认出故人，两人对坐无语', book: '《静静的顿河》', chapter: '六' }
  assert.deepEqual(makeStackEntry({ userNote: '为什么？', selected: sel }), { role: 'user', content: '为什么？', selected: sel })
})

// ── 降级入栈（Q2.5 + 降级判定，2026-08-11）────────────────────────────────────
test('空栈 + 降级救回（usedAssist）+ 带 assistantContext → pushed 且补入 AI 回复背景轮次', async () => {
  const msg = { userNote: '那照这么说，宗教给人规定的意义又算什么？', assistantContext: { content: '意义是被创造的，不是被发现的。' } }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(false), okTopic(true)), log: () => {} })
  assert.equal(r.action, 'pushed')
  assert.equal(r.stack.length, 2, '背景 AI 回复 + 当前消息')
  assert.equal(r.stack[0].role, 'assistant')
  assert.equal(r.stack[0].content, '意义是被创造的，不是被发现的。')
  assert.equal(r.stack[1].role, 'user')
  assert.equal(r.stack[1].content, '那照这么说，宗教给人规定的意义又算什么？')
})

test('降级救回：assistantContext.selected 透传到背景轮次（AI 回复针对的划线带上）', async () => {
  const msg = {
    userNote: '那照这么说，宗教给人规定的意义又算什么？',
    assistantContext: {
      content: '意义是被创造的，不是被发现的。',
      selected: { text: '老人认出故人，两人对坐无语', book: '《静静的顿河》', chapter: '六' },
    },
  }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(false), okTopic(true)), log: () => {} })
  assert.equal(r.action, 'pushed')
  assert.equal(r.stack[0].role, 'assistant')
  assert.equal(r.stack[0].selected.text, '老人认出故人，两人对坐无语')
  assert.equal(r.stack[0].selected.book, '《静静的顿河》')
  assert.equal(r.stack[1].selected, undefined, '用户消息无划线，user 轮次不带 selected')
})

test('降级救回：assistantContext 无划线时背景轮次不带 selected', async () => {
  const msg = { userNote: '那照这么说，意义是主观的？', assistantContext: { content: '意义是被创造的。' } }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(false), okTopic(true)), log: () => {} })
  assert.equal(r.stack[0].role, 'assistant')
  assert.equal(r.stack[0].selected, undefined)
})

test('空栈 + 正常专题化（非降级）→ pushed 只含当前消息，不补背景', async () => {
  const msg = { userNote: '一种秩序靠什么维持得下去？', assistantContext: { content: '无关的上一轮回复' } }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(true)), log: () => {} })
  assert.equal(r.action, 'pushed')
  assert.equal(r.stack.length, 1)
  assert.equal(r.stack[0].content, '一种秩序靠什么维持得下去？')
})

test('空栈 + 降级判仍非专 → ignored，不因 assistantContext 误入栈', async () => {
  const msg = { userNote: '嗯嗯', assistantContext: { content: '意义是被创造的。' } }
  const r = await processStackMessage([], msg, { callLLM: makeLLM(okTopic(false), okTopic(false)), log: () => {} })
  assert.equal(r.action, 'ignored')
  assert.deepEqual(r.stack, [])
})

test('非空栈换问题分支：剥掉 assistantContext，不触发降级（只调同一性+判专题化各一次）', async () => {
  const msg = { userNote: '列宁的工人贵族论为什么后来被抛弃了？', assistantContext: { content: '关于旧问题（秩序维持）的上一轮回复' } }
  // 队列只有两个响应；若降级被触发会多调而抛 "unexpected extra callLLM call"
  const r = await processStackMessage(sampleStack, msg, { callLLM: makeLLM(okSame(false), okTopic(true)), log: () => {} })
  assert.equal(r.action, 'closed_and_pushed')
  assert.deepEqual(r.closed.entries, sampleStack)
})
