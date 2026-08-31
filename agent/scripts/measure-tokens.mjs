#!/usr/bin/env node
/**
 * 真实每轮 token 估算：把历史消息发给 DeepSeek API，用 usage.prompt_tokens 拿真实分词数。
 * user 块、assistant 块各发一次请求（拼接成大消息，边界误差 <1%）。
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

const INPUTS = path.join(__dirname, '..', '..', 'receiver', 'inbox', 'chat_input.jsonl')
const OUTPUTS = path.join(__dirname, '..', '..', 'receiver', 'inbox', 'chat_output.jsonl')

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

async function measure(label, texts) {
  const content = texts.join('\n\n')
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 1, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`)
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const per = total / texts.length
  const chars = texts.reduce((s, t) => s + t.length, 0)
  console.log(`${label.padEnd(12)} n=${String(texts.length).padEnd(4)} 字符=${String(chars).padEnd(8)} token=${String(total).padEnd(8)} 每条均值=${per.toFixed(1)} token（字符/token=${(chars / total).toFixed(2)}）`)
  return per
}

async function main() {
  if (!API_KEY) { console.log('无 COREAD_API_KEY，跳过'); return }
  const users = readJsonl(INPUTS).filter((m) => m && m.content)
  const assts = readJsonl(OUTPUTS).filter((o) => o && o.role === 'assistant' && !('_stream' in o) && o.content && o.content.trim() && !o.content.startsWith('⚠️'))
  console.log(`model=${MODEL}\n历史样本：user ${users.length} 条 / assistant ${assts.length} 条\n`)
  const uPer = await measure('user', users.map((m) => m.content))
  const aPer = await measure('assistant', assts.map((m) => m.content))
  const perTurn = uPer + aPer
  console.log('---')
  console.log(`每轮（1 user + 1 assistant）真实 token ≈ ${perTurn.toFixed(0)}`)
  for (const budget of [128000, 192000, 256000]) {
    console.log(`${budget} token ≈ ${Math.round(budget / perTurn)} 轮`)
  }
  console.log(`\n对照：字符数估算（estimateTokens）≈ ${Math.round((users.reduce((s, m) => s + m.content.length, 0) / users.length) + (assts.reduce((s, m) => s + m.content.length, 0) / assts.length))} token/轮`)
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
