#!/usr/bin/env node
// 前缀大小阈值实验：同一形状（指令 + 静态块 + 末尾可变 msg），静态块大小从 2K → 25K，
// 观察第二次调用（换 msg）能否命中静态块——判断 DeepSeek 缓存对“尾部可变”prompt 的生效下限
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(__dirname, '..')
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const env = {}
for (const line of read(path.join(AGENT, '.env')).split('\n')) {
  const m = line.trim().match(/^([A-Z_]+)\s*=\s*(.+)$/)
  if (m) env[m[1]] = m[2].trim()
}
const API_KEY = env.COREAD_API_KEY || ''
const API_BASE = (env.COREAD_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = env.COREAD_MODEL || 'deepseek-chat'
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
const head = '【重要】所有必要数据已直接包含在对话内容里。'

async function call(label, prompt) {
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: 1, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  console.log(label.padEnd(16) + ' total=' + String(total).padStart(6) + ' hit=' + String(hit).padStart(6) + ' miss=' + String(total - hit).padStart(6) + ' 命中率=' + (total ? (100 * hit / total).toFixed(1) : '-') + '%')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!API_KEY) { console.log('no key'); process.exit(0) }
const sizes = [2000, 6000, 15000, 25000]
for (const size of sizes) {
  const unit = '静态判定材料段落。' // 每段 ~9 字
  const pad = unit.repeat(Math.ceil(size / 9))
  const common = head + '\n\n' + pad
  const msgA = '新消息："场景A的发言内容' + size + '"'
  const msgB = '新消息："场景B的完全不同发言内容' + size + '"'
  await call('A@' + (size / 1000) + 'K', common + '\n\n' + msgA)
  await sleep(2000)
  await call('B@' + (size / 1000) + 'K', common + '\n\n' + msgB)
  await sleep(2000)
}
console.log('\n若 B@nK 命中率高 → 该体量下静态块可跨调用命中（尾变无害）；若 ≈0 → 该体量下每次调用都全价重算')