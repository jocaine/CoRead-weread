#!/usr/bin/env node
/**
 * 判专题化（AI-016）真实 API 冒烟测试 — 端到端验证"模拟提问 → 真实模型 → 是否专题化"。
 * 与单元测试（test/topicize.test.js，假 LLM 测代码逻辑）互补：本脚本测模型是否听话、判得准不准。
 * 运行：npm run smoke（需 agent/.env 配置 COREAD_API_KEY / COREAD_API_BASE）
 * 建议在改判据 / 改指令 / 换模型后跑一次。
 */
import { buildTopicizePrompt, parseJudgeResult } from '../lib/topicize.js'

// .env 由 npm run smoke（--env-file-if-exists=.env）加载，直接读 process.env
const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

async function callLLMOnce(prompt) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0, // 判定任务要确定性（docstring 中"建议固定低温度"的落点）
      tool_choice: 'none',
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
  const data = JSON.parse(raw)
  const msg = data.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

// 模拟用户提问（判定材料=提问本身；sel 有值时附带划线，仅用于解析提问中的指代——
// 2026-08-11 用户定调：边界情况若有对应划线要作为上下文加入，指代解析后该进就进；
// 但词义/闲聊/情绪等无需划线的判定不能被划线内容带偏）。期望值 = 按 Q2 判据人工标定，
// 依据列说明为什么标这个期望。用例数据与代码分离，从 scripts/data/judge-smoke-cases.json 加载。
import { readFileSync } from 'node:fs'
const GROUPS = JSON.parse(readFileSync(new URL('./data/judge-smoke-cases.json', import.meta.url), 'utf-8'))

const CASES = GROUPS.flatMap((g) => g.cases.map((c) => ({ ...c, group: g.title })))
// 用例名等宽对齐：名称最长 8 字，含中文/英文混合用 padEnd 按码点不够精确，统一补到 8
const pad = (s) => String(s).padEnd(10)

// 每个用例连跑 ROUNDS 轮：temperature 0 下判定应完全稳定，
// 轮间结果不一致 = 模型在判据边界上摇摆（2026-08-10 抓到的"审美评价"两轮两结果）
const ROUNDS = 3

let totalHit = 0
let unstable = 0
console.log(`模型: ${MODEL} | temperature: 0 | 用例: ${CASES.length} × ${ROUNDS} 轮\n`)
let lastGroup = null
for (const c of CASES) {
  if (c.group !== lastGroup) {
    console.log(`=== ${c.group} ===`)
    lastGroup = c.group
  }
  const rounds = []
  let rawSample = ''
  for (let r = 0; r < ROUNDS; r++) {
    const raw = await callLLMOnce(buildTopicizePrompt({ userNote: c.note, selected: c.sel ? { text: c.sel } : undefined }))
    if (!rawSample) rawSample = raw
    const parsed = parseJudgeResult(raw)
    rounds.push(parsed ? (parsed.topicized ? '专' : '不') : '解失')
  }
  const expectSym = c.expect ? '专' : '不'
  const hitCount = rounds.filter((r) => r === expectSym).length
  const stable = new Set(rounds).size === 1
  if (!stable) unstable++
  totalHit += hitCount
  const brief = rawSample.length > 55 ? rawSample.slice(0, 55).replace(/\n/g, '↵') + '…' : rawSample.replace(/\n/g, '↵')
  const selPart = c.sel ? ` 划线: "${c.sel.length > 18 ? c.sel.slice(0, 18) + '…' : c.sel}"` : ''
  console.log(`${hitCount === ROUNDS ? '✔' : '✘'} ${pad(c.name)}期望=${expectSym} | ${ROUNDS}轮判定: ${rounds.join('/')} | ${hitCount}/${ROUNDS}${stable ? '' : ' ⚠️不稳定'} | 提问: "${c.note}"${selPart}`)
  if (hitCount < ROUNDS) console.log(`          原始输出样本: ${brief}`)
}
console.log(`\n命中率: ${totalHit}/${CASES.length * ROUNDS} | 不稳定用例(轮间摇摆): ${unstable}`)
process.exitCode = totalHit === CASES.length * ROUNDS ? 0 : 1
