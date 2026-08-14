#!/usr/bin/env node
/**
 * 判专题化 tool loop（AI-016）单元测试 — 内置 node:test 运行器。
 * 运行：npm test（= node --test）
 * 输出协议：纯 JSON {"topicized":true|false}（marker 已按 2026-08-10 真实 API 实测删除）
 *
 * 测试数据（讨论单元输入 / 解析用例）与代码分离，从 fixtures/topicize-fixtures.json 读取；
 * mock LLM 响应队列与断言是控制流，留在本文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MAX_ATTEMPTS,
  judgeTopicization,
  parseJudgeResult,
  buildTopicizePrompt,
  buildTopicizeInstruction,
} from '../lib/topicize.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/topicize-fixtures.json', import.meta.url), 'utf-8'))
const { analytic, fact, chitchat, noSelected, withExchange, downgradePrompt, pureWithAssist, downgradeCases } = fixtures.inputs
const assistReply = fixtures.assistReply

// ── 测试辅助 ────────────────────────────────────────────────────────────────
// 顺序吐回应的假 callLLM；到队尾再调用就抛"意外多调"
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

// 协议：纯 JSON（无 marker）
const ok = (topicized) => JSON.stringify({ topicized })

// ── buildTopicizeInstruction / buildTopicizePrompt ───────────────────────────
test('指令包含 Q2 判据与操作文档约束', () => {
  const inst = buildTopicizeInstruction()
  for (const kw of ['机制', '结构', '关系', '事实澄清', '闲聊', '主观评价', '空泛抽象', '指代不明', '多问并存', '语气不是判据', '可跨书应用', '基于真实内容归纳', '表象信号']) {
    assert.ok(inst.includes(kw), `指令应包含「${kw}」`)
  }
  assert.ok(inst.includes('只用来解析提问里的指代'), '指令应说明划线的用途边界：仅解析指代')
})

test('指令输出格式是纯 JSON 示例、只含 topicized 一个字段', () => {
  const inst = buildTopicizeInstruction()
  assert.ok(inst.includes('{"topicized":true}'), '格式示例应为一行纯 JSON')
  assert.ok(!inst.includes('【JUDGE_TOPICIZE】'), '指令不应再出现 marker')
  assert.ok(!inst.includes('kind'), '指令不应再出现 kind 字段')
  assert.ok(!inst.includes('core'), '指令不应再出现 core 字段')
  assert.ok(!inst.includes('reason'), '指令不应再出现 reason 字段')
})

test('prompt 携带提问+划线（划线仅作指代解析；位置不进）', () => {
  const p = buildTopicizePrompt(analytic)
  assert.ok(p.includes('一种秩序靠什么维持得下去'), '提问是判定主体')
  assert.ok(p.includes('老人认出故人，两人对坐无语'), '划线作为指代解析上下文进 prompt')
  assert.ok(p.includes('划线内容（仅用于解析提问中的指代）：'), '划线带用途边界标签')
  assert.ok(!p.includes('《静静的顿河》'), '位置（书/章）不进 prompt')
})

test('无划线时 prompt 只有提问，不含划线段', () => {
  const p = buildTopicizePrompt(noSelected)
  assert.ok(p.includes('为什么？'))
  assert.ok(!p.includes('划线内容（仅用于解析提问中的指代）：'), '无划线不应出现划线段')
})

test('prompt 携带交锋与会意上下文时只取提问+划线（交锋/上下文不参与判专题化）', () => {
  const p = buildTopicizePrompt(withExchange)
  assert.ok(p.includes('为什么？'))
  assert.ok(p.includes('划线内容'), '划线进 prompt（解析指代用）')
  assert.ok(!p.includes('再展开说说'), '交锋不进判专题化 prompt')
  assert.ok(!p.includes('制度是外部位置的函数'))
  assert.ok(!p.includes('读者在制度的可复制性上反复交锋'))
})

// ── parseJudgeResult ─────────────────────────────────────────────────────────
// 数据表驱动：用例文本 + 期望（true/false/null）都在 fixtures.parseCases
for (const c of fixtures.parseCases) {
  test(`解析：${c.name}`, () => {
    assert.deepEqual(parseJudgeResult(c.text), c.expect === null ? null : { topicized: c.expect })
  })
}

test('解析：思考草稿（超长非 JSON）→ null，交给重试', () => {
  assert.equal(parseJudgeResult('好的我逐步思考。' + '思'.repeat(2000)), null)
})

test('解析：null / undefined 输入 → null', () => {
  assert.equal(parseJudgeResult(null), null)
  assert.equal(parseJudgeResult(undefined), null)
})

// ── judgeTopicization 主流程 ────────────────────────────────────────────────
test('主流程：专题化讨论 → topicized:true', async () => {
  const r = await judgeTopicization(analytic, { callLLM: makeLLM(ok(true)) })
  assert.equal(r.topicized, true)
  assert.equal(r.attempts, 1)
})

test('主流程：事实澄清 → topicized:false', async () => {
  const r = await judgeTopicization(fact, { callLLM: makeLLM(ok(false)) })
  assert.equal(r.topicized, false)
  assert.equal(r.attempts, 1)
})

test('主流程：闲聊 → topicized:false', async () => {
  const r = await judgeTopicization(chitchat, { callLLM: makeLLM(ok(false)) })
  assert.equal(r.topicized, false)
})

test('主流程：JSON 带多余字段（note 引用提问）首试即通过', async () => {
  const valid = '{"topicized":false,"note":"用户提问：这人物原型是谁，事实澄清可一次答完"}'
  const r = await judgeTopicization(fact, { callLLM: makeLLM(valid) })
  assert.equal(r.topicized, false)
  assert.equal(r.attempts, 1)
})

test('主流程：代码块围栏包裹的判定首试即通过', async () => {
  const r = await judgeTopicization(analytic, {
    callLLM: makeLLM('```json\n{"topicized":true}\n```'),
  })
  assert.equal(r.topicized, true)
  assert.equal(r.attempts, 1)
})

test('主流程：思考草稿后重试成功（第二次给有效判定）', async () => {
  const draft = '好的我逐步思考。这个讨论涉及制度机制……' + '思'.repeat(300)
  const r = await judgeTopicization(analytic, {
    callLLM: makeLLM(draft, ok(true)),
    log: () => {},
  })
  assert.equal(r.topicized, true)
  assert.equal(r.attempts, 2)
})

test('主流程：重试 prompt 携带"上一次输出未通过校验"提示', async () => {
  const prompts = []
  const r = await judgeTopicization(analytic, {
    callLLM: async (prompt, mt) => {
      prompts.push(prompt)
      if (prompts.length === 1) return '坏'  // 非 JSON → 解析失败
      return ok(true)
    },
    log: () => {},
  })
  assert.equal(r.attempts, 2)
  assert.ok(prompts[1].includes('上一次输出未通过校验'), '重试 prompt 应携带修正提示')
})

test('重试：网络失败时重发原样 prompt（不带修正提示——模型没收到过它）', async () => {
  const prompts = []
  const r = await judgeTopicization(analytic, {
    callLLM: async (prompt, mt) => {
      prompts.push(prompt)
      if (prompts.length === 1) throw new Error('network down')
      return ok(true)
    },
    log: () => {},
  })
  assert.equal(r.attempts, 2)
  assert.equal(prompts[1], prompts[0], '网络失败重试应原样重发 basePrompt')
  assert.ok(!prompts[1].includes('上一次输出未通过校验'), '网络失败不应带修正提示')
})

test('重试：⚠️ 失败串重发原样 prompt（不带修正提示）', async () => {
  const prompts = []
  const r = await judgeTopicization(analytic, {
    callLLM: async (prompt, mt) => {
      prompts.push(prompt)
      if (prompts.length === 1) return '⚠️ 上游 500'
      return ok(true)
    },
    log: () => {},
  })
  assert.equal(r.attempts, 2)
  assert.equal(prompts[1], prompts[0], '⚠️ 失败串重试应原样重发 basePrompt')
  assert.ok(!prompts[1].includes('上一次输出未通过校验'))
})

test('重试：输出非法后再遇网络失败，修正提示仍保留（模型还没见过它）', async () => {
  const prompts = []
  const r = await judgeTopicization(analytic, {
    callLLM: async (prompt, mt) => {
      prompts.push(prompt)
      if (prompts.length === 1) return '坏'               // 输出非法 → 写 promptHint
      if (prompts.length === 2) throw new Error('flaky')  // 网络失败 → 不该清掉 promptHint
      return ok(true)
    },
    log: () => {},
  })
  assert.equal(r.attempts, 3)
  assert.ok(prompts[2].includes('上一次输出未通过校验'), '网络失败后提示应保留')
  assert.ok(prompts[2].includes('输出不是合法 JSON'), '提示内容应为输出非法原因')
})

test('主流程：maxTokens 原样透传到 callLLM', async () => {
  let seen = null
  const r = await judgeTopicization(analytic, {
    maxTokens: 512,
    callLLM: async (prompt, mt) => { seen = mt; return ok(true) },
  })
  assert.equal(r.topicized, true)
  assert.equal(seen, 512, '自定义 maxTokens 应原样到达 callLLM')
})

test('主流程：非法输出重试，耗尽尝试后抛错', async () => {
  await assert.rejects(
    judgeTopicization(analytic, { callLLM: makeLLM('闲聊吧', '还是闲聊', '继续闲聊') }),
    /3 次尝试后仍无有效判定/,
  )
})

test('主流程：LLM 抛出错误 → 重试后最终抛出带原因的错误', async () => {
  await assert.rejects(
    judgeTopicization(analytic, {
      callLLM: makeLLM(new Error('network down'), new Error('network down'), new Error('network down')),
    }),
    (e) => e.message.includes('判专题化 LLM 调用失败') && e.message.includes('network down'),
  )
})

test('主流程：LLM 以非 Error 值 reject 时原因不丢失', async () => {
  const rejectStr = async () => { throw '上游限流' }  // 非 Error 的拒绝值（字符串）
  await assert.rejects(
    judgeTopicization(analytic, { callLLM: rejectStr }),
    /判专题化 LLM 调用失败：上游限流/,
  )
})

test('主流程：LLM 返回失败串（⚠️ 前缀）→ 最后一次尝试抛"返回失败串"', async () => {
  await assert.rejects(
    judgeTopicization(analytic, {
      callLLM: makeLLM('⚠️ 上游 500', '⚠️ 上游 500', '⚠️ 上游 500'),
    }),
    /判专题化 LLM 返回失败串/,
  )
})

test('主流程：attempts=1 时首试抛错/失败串立即抛出', async () => {
  await assert.rejects(
    judgeTopicization(analytic, { callLLM: makeLLM('⚠️ 上游 500'), attempts: 1 }),
    /判专题化 LLM 返回失败串/,
  )
  await assert.rejects(
    judgeTopicization(analytic, { callLLM: makeLLM(new Error('boom')), attempts: 1 }),
    /判专题化 LLM 调用失败：boom/,
  )
})

test('主流程：可配置尝试次数', async () => {
  await assert.rejects(
    judgeTopicization(analytic, {
      callLLM: makeLLM('坏', '坏'),
      attempts: 2,
    }),
    /2 次尝试后仍无有效判定/,
  )
})

test('主流程：空讨论单元 → TypeError', async () => {
  await assert.rejects(judgeTopicization({}, { callLLM: makeLLM(ok(true)) }), TypeError)
  await assert.rejects(judgeTopicization(null, { callLLM: makeLLM(ok(true)) }), TypeError)
})

test('主流程：未注入 callLLM → TypeError', async () => {
  await assert.rejects(judgeTopicization(analytic, {}), /必须注入 callLLM/)
})

test('主流程：只有划线无提问 → TypeError（判定材料只有提问）', async () => {
  await assert.rejects(
    judgeTopicization({ selected: { text: '老人认出故人，两人对坐无语' } }, { callLLM: makeLLM(ok(true)) }),
    /需要用户提问/,
  )
})

// ── 降级判定（2026-08-11 用户定调：第一判非专 + 有上一轮 AI 回复 → 补考一次）───

test('降级：提问自身有内核 + 有上一轮 AI 回复 → 第一判即专，不降级（usedAssist=false，只调一次）', async () => {
  const r = await judgeTopicization(downgradeCases.selfKernel, { callLLM: makeLLM(ok(true)), log: () => {} })
  assert.equal(r.topicized, true)
  assert.equal(r.usedAssist, false)
  assert.equal(r.attempts, 1, '不降级时只调一次')
})

test('降级：第一判非专 + 无上一轮 AI 回复 → 不降级（只调一次）', async () => {
  const r = await judgeTopicization(downgradeCases.noAssist, { callLLM: makeLLM(ok(false)), log: () => {} })
  assert.equal(r.topicized, false)
  assert.equal(r.usedAssist, false)
  assert.equal(r.attempts, 1)
})

test('降级：承接上一轮 AI 回复展开 → 降级判专（usedAssist=true，attempts=2）', async () => {
  const r = await judgeTopicization(downgradeCases.carryOn, { callLLM: makeLLM(ok(false), ok(true)), log: () => {} })
  assert.equal(r.topicized, true)
  assert.equal(r.usedAssist, true)
  assert.equal(r.attempts, 2, '第一判 + 降级判各一次')
})

test('降级：纯反应维持非专（承接但无推进 → 降级判非专，usedAssist=false）', async () => {
  const r = await judgeTopicization(downgradeCases.pureReaction, { callLLM: makeLLM(ok(false), ok(false)), log: () => {} })
  assert.equal(r.topicized, false)
  assert.equal(r.usedAssist, false)
  assert.equal(r.attempts, 2)
})

test('降级：降级判仍非专 → topicized=false', async () => {
  const r = await judgeTopicization(downgradeCases.laugh, { callLLM: makeLLM(ok(false), ok(false)), log: () => {} })
  assert.equal(r.topicized, false)
  assert.equal(r.usedAssist, false)
})

test('降级：降级判的解析重试照常（降级判前两次坏，第三次给判定）', async () => {
  const r = await judgeTopicization(downgradeCases.carryOn, { callLLM: makeLLM(ok(false), '坏', '坏', ok(true)), log: () => {} })
  assert.equal(r.topicized, true)
  assert.equal(r.usedAssist, true)
  assert.equal(r.attempts, 4, '第一判 1 次 + 降级判 3 次')
})

test('降级 prompt：包含上一轮 AI 回复 + 降级边界说明', () => {
  const p = buildTopicizePrompt(downgradePrompt)
  assert.ok(p.includes('上一轮 AI 回复（辅助材料）'))
  assert.ok(p.includes('降级判定说明'))
  for (const kw of ['承接', '纯反应', '上一轮 AI 回复自身深刻不是判据']) {
    assert.ok(p.includes(kw), `降级段应包含「${kw}」`)
  }
  assert.ok(p.includes('"存在先于本质"'), '上一轮 AI 回复内容进降级 prompt')
})

test('纯净 prompt：不带上一轮 AI 回复段（即使 input 传了 assistantContext）', () => {
  const p = buildTopicizePrompt(pureWithAssist)
  assert.ok(!p.includes('上一轮 AI 回复（辅助材料）'))
  assert.ok(!p.includes('降级判定说明'))
})

test('MAX_ATTEMPTS 默认值为 3', () => {
  assert.equal(MAX_ATTEMPTS, 3)
})
