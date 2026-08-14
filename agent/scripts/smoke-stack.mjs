#!/usr/bin/env node
/**
 * 判同一性 + 专题化讨论栈（AI-016 / Q2.5）真实 API 冒烟测试。
 * 与 smoke-topicize.mjs（单条判专题化）互补：本脚本模拟多轮对话序列，
 * 驱动栈状态机（processStackMessage），端到端验证"哪几轮算一次专题化讨论"。
 * 运行：npm run smoke:stack（需 agent/.env 配置 COREAD_API_KEY / COREAD_API_BASE）
 * 建议在改判同一性判据 / 栈状态机逻辑后跑一次。
 */
import { readFileSync } from 'node:fs'
import { processStackMessage } from '../lib/topic-stack.js'

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

async function callLLMOnce(prompt, maxTokens) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0,
      tool_choice: 'none',
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
  const data = JSON.parse(raw)
  const msg = data.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

// 对话序列用例（turns/expect/basis）从数据文件读取，不硬编码在代码里。
// 每条：turns = 用户轮次（note 必填；selected 模拟划线结构体；aiReply = 模拟 AI 回复，
// 仅作后续同一性判断的上下文，不入 API）；expect = 每轮期望的栈动作。
// 标定依据：Q2.5 栈状态机（入栈=专题化初判，累积=同一问题，收口=换问题+专题化，忽略=非专题化）。
const SEQUENCES = JSON.parse(
  readFileSync(new URL('./data/smoke-stack-sequences.json', import.meta.url), 'utf-8'),
)

const ACT_SYM = { pushed: '入栈', ignored: '忽略', closed_and_pushed: '收口' }
let totalHit = 0
let totalRuns = 0

console.log(`模型: ${MODEL} | temperature: 0 | 序列用例: ${SEQUENCES.length}\n`)
for (const seq of SEQUENCES) {
  const deps = {
    callLLM: callLLMOnce,
    maxTokens: 512,
    log: (m) => console.log(`    ${m}`),
  }
  let stack = []
  const actions = []
  const closed = []
  let lastAssistant = ''  // 上一轮 AI 回复（对话流紧邻上一条 assistant 消息），作降级判定的辅助材料
  for (const [i, turn] of seq.turns.entries()) {
    const { aiReply: _reply, ...msgRest } = turn  // aiReply 是模拟回复，不进判定消息
    const msg = lastAssistant ? { ...msgRest, assistantContext: { content: lastAssistant } } : { ...msgRest }
    const r = await processStackMessage(stack, msg, deps)
    actions.push(r.action)
    if (r.action === 'closed_and_pushed') closed.push(i + 1)  // 第几轮收口
    stack = r.stack
    if (r.action !== 'ignored' && turn.aiReply) {
      stack.push({ role: 'assistant', content: turn.aiReply })  // AI 回复入栈，供后续同一性判断
    }
    if (turn.aiReply) lastAssistant = turn.aiReply  // 无论是否入栈，上一轮 AI 回复都是对话流的一部分
  }
  const ok = actions.every((a, i) => a === seq.expect[i])
  if (ok) totalHit++
  totalRuns++
  const gotStr = actions.map((a) => `${ACT_SYM[a] ?? a}`).join(' → ')
  const expectStr = seq.expect.map((a) => ACT_SYM[a]).join(' → ')
  console.log(`${ok ? '✔' : '✘'} ${seq.name}`)
  console.log(`    期望: ${expectStr}`)
  console.log(`    实际: ${gotStr}${closed.length ? `（第 ${closed.join('、')} 轮收口）` : ''}`)
  console.log(`    依据: ${seq.basis}`)
  if (!ok) {
    // 定位第一处偏差轮次
    const badIdx = actions.findIndex((a, i) => a !== seq.expect[i])
    console.log(`    ⚠️ 第 ${badIdx + 1} 轮不符合预期（期望 ${ACT_SYM[seq.expect[badIdx]]}，实际 ${ACT_SYM[actions[badIdx]] ?? actions[badIdx]}）提问: "${seq.turns[badIdx].userNote}"`)
  }
  console.log('')
}
console.log(`命中率: ${totalHit}/${totalRuns}`)
process.exitCode = totalHit === totalRuns ? 0 : 1
