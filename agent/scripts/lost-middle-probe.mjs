#!/usr/bin/env node
/**
 * Lost in the Middle 实测（deepseek-v4-flash）：关键事实放在上下文 开头/中间/结尾，
 * 问同一个问题，看模型能否找到它。每个位置采样 3 次。
 * 若 U 形成立：中间位置错误率显著高于开头/结尾；若模型长上下文鲁棒：三位置都答对。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env')
const env = {}
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Z_]+)\s*=\s*(.+)$/)
    if (m) env[m[1]] = m[2].trim()
  }
}
const API_KEY = env.COREAD_API_KEY || ''
const API_BASE = (env.COREAD_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = env.COREAD_MODEL || 'deepseek-chat'

const KEY_FACT = '【关键事实】本次会议的备份代码是 8842-7719。'
const FILL = '这是第 ${i} 条背景记录：某区域办事处的季度运营报告摘要，内容涉及资源调配、流程优化与人员安排的一般性描述，其中没有任何特殊编码、号码或机密信息，仅作为普通档案存档。'
const QUESTION = '上下文里有一句以【关键事实】开头的话。那句话提到的备份代码是什么？只输出代码本身（4位数字-4位数字），不要任何其他文字。'
const ANSWER = '8842-7719'

async function ask(messages) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 256, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`)
  const msg = data.choices?.[0]?.message || {}
  // 推理模型：content 可能为空、答案在 reasoning_content 里——两者都读
  const content = String(msg.content || '').trim()
  const reasoning = String(msg.reasoning_content || '').trim()
  const full = content || reasoning
  const m = full.match(/8842-7719/)
  const ok = !!m && !/无法|没有|未找到|不存在/.test(full)
  return { text: full.slice(0, 60), ok, tokens: data.usage?.prompt_tokens || 0 }
}

function buildMessages(keyIdx, total) {
  const msgs = []
  for (let i = 1; i <= total; i++) {
    msgs.push({ role: 'user', content: i === keyIdx ? KEY_FACT : FILL.replace('${i}', i) })
  }
  msgs.push({ role: 'user', content: QUESTION })
  return msgs
}

async function run(position, keyIdx, total) {
  const results = []
  for (let k = 1; k <= 3; k++) {
    const { text, tokens } = await ask(buildMessages(keyIdx, total))
    results.push({ text, ok: text.replace(/\s/g, '') === ANSWER })
  }
  const okCount = results.filter((r) => r.ok).length
  console.log(`${position.padEnd(6)} 答对 ${okCount}/3  ${results.map((r) => (r.ok ? '✓' : `✗(${r.text.slice(0, 24)})`)).join('  ')}`)
  return okCount
}

async function main() {
  if (!API_KEY) { console.log('无 COREAD_API_KEY，跳过'); return }
  const TOTAL = 25   // 25 条 × ~1K token ≈ 30K 上下文
  console.log(`model=${MODEL}  上下文 ${TOTAL} 条背景消息（≈30K token），关键事实位置×3，每位置采样 3 次（temperature=0）\n`)
  // 先发一次空跑拿真实 token 数（第一条消息单独发太小，直接在一次完整请求里看 usage）
  await run('开头', 1, TOTAL)
  await run('中间', Math.floor(TOTAL / 2), TOTAL)
  await run('结尾', TOTAL, TOTAL)
  console.log('\n判断：中间明显差于两端 → U 形成立；三位置都答对 → 该模型长上下文鲁棒，中间劣势弱')
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
