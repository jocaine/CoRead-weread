#!/usr/bin/env node
/**
 * 讨论组问题归纳（thread-question.js）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/thread-question.test.js
 * 与 topic-stack.test.js 互补：那边测判同一性 + 栈状态机，这里测收口时"把讨论追的具体问题
 * 归纳成一句"（threads.question）的指令 / prompt / 解析 / tool loop。
 *
 * 测试数据（讨论栈 / 解析用例）与代码分离，从 fixtures/thread-question-fixtures.json 读取；
 * mock LLM 响应队列与断言是控制流，留在本文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildQuestionInstruction,
  buildQuestionPrompt,
  parseQuestionResult,
  consolidateThreadQuestion,
} from '../lib/thread-question.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/thread-question-fixtures.json', import.meta.url), 'utf-8'))
const { discussionStack } = fixtures

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
const okQuestion = (q) => JSON.stringify({ question: q })

// ── 指令 / prompt ────────────────────────────────────────────────────────────
test('归纳指令：要求具体问题、疑问句、不命名不归类', () => {
  const inst = buildQuestionInstruction()
  for (const kw of ['正在追的**那一个具体问题**', '一句提问（疑问句，一句话）', '不要给问题命名', '不要归类到母题', '不要复述讨论的结论', '直接以提问的口吻写', '不要写成"用户问……"']) {
    assert.ok(inst.includes(kw), `指令应包含「${kw}」`)
  }
  assert.ok(inst.includes('{"question":"一句提问"}'), '格式示例应为一行纯 JSON')
})

test('归纳 prompt：携带讨论内容（user + AI 对话），划线不带', () => {
  const p = buildQuestionPrompt(discussionStack)
  assert.ok(p.includes('讨论内容'), '应标注讨论内容段')
  assert.ok(p.includes('哥萨克没有国家能力'), '栈内 AI 回复应出现')
  assert.ok(p.includes('无法自我再生产，有什么什么不对的吗'), '栈内用户追问应出现')
})

test('归纳 prompt：整场讨论不做窗口截断（长讨论保留开头锚点）', () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `轮${i}` }))
  const p = buildQuestionPrompt(long)
  assert.ok(p.includes('轮0'), '讨论开头应保留（开头确立具体问题，截掉会丢锚点）')
  assert.ok(p.includes('轮19'), '讨论结尾应保留')
  assert.ok(!p.includes('最近'), '不应出现判同一性的窗口截断措辞')
})

// ── parseQuestionResult ──────────────────────────────────────────────────────
for (const c of fixtures.questionParseCases) {
  test(`解析：${c.name}`, () => {
    assert.equal(parseQuestionResult(c.text), c.expect)
  })
}

// ── consolidateThreadQuestion 主流程 ─────────────────────────────────────────
test('主流程：归纳成功 → question 字符串 + attempts:1', async () => {
  const r = await consolidateThreadQuestion(discussionStack, {
    callLLM: makeLLM(okQuestion('哥萨克为什么要求自治而不建国独立')),
  })
  assert.equal(r.question, '哥萨克为什么要求自治而不建国独立')
  assert.equal(r.attempts, 1)
})

test('主流程：非法输出重试，重试 prompt 携带修正提示', async () => {
  const prompts = []
  const r = await consolidateThreadQuestion(discussionStack, {
    callLLM: async (p, mt) => {
      prompts.push(p)
      if (prompts.length === 1) return '坏'
      return okQuestion('哥萨克的建制结构如何')
    },
    log: () => {},
  })
  assert.equal(r.question, '哥萨克的建制结构如何')
  assert.equal(r.attempts, 2)
  assert.ok(prompts[1].includes('上一次输出未通过校验'))
})

test('重试：网络失败时重发原样 prompt（不带修正提示）', async () => {
  const prompts = []
  const r = await consolidateThreadQuestion(discussionStack, {
    callLLM: async (p, mt) => {
      prompts.push(p)
      if (prompts.length === 1) throw new Error('network down')
      return okQuestion('哥萨克的建制结构如何')
    },
    log: () => {},
  })
  assert.equal(r.attempts, 2)
  assert.equal(prompts[1], prompts[0], '网络失败重试应原样重发 basePrompt')
})

test('主流程：耗尽尝试后抛错', async () => {
  await assert.rejects(
    consolidateThreadQuestion(discussionStack, { callLLM: makeLLM('坏', '坏', '坏') }),
    /3 次尝试后仍无有效结果/,
  )
})

test('主流程：attempts:5 时耗尽用 5 次（归纳可重试次数更高）', async () => {
  await assert.rejects(
    consolidateThreadQuestion(discussionStack, { callLLM: makeLLM('坏', '坏', '坏', '坏', '坏'), attempts: 5 }),
    /5 次尝试后仍无有效结果/,
  )
})

test('重试提示：明确禁止解释格式/写前言（针对"我们只需要输出…"复读失败模式）', async () => {
  const prompts = []
  await assert.rejects(
    consolidateThreadQuestion(discussionStack, {
      callLLM: async (p, mt) => {
        prompts.push(p)
        if (prompts.length === 1) return '我们只需要输出一个 JSON 对象，字段 question 为一句提问。'
        return '坏'
      },
      log: () => {},
    }),
    /仍无有效结果/,
  )
  assert.ok(prompts[1].includes('任何解释、前言、示例、推理过程都算失败'), '重试提示应禁止解释格式/前言/推理')
})

test('主流程：空栈 / 未注入 callLLM → TypeError', async () => {
  await assert.rejects(consolidateThreadQuestion([], { callLLM: makeLLM(okQuestion('x')) }), /需要非空栈/)
  await assert.rejects(consolidateThreadQuestion(discussionStack, {}), /必须注入 callLLM/)
})
