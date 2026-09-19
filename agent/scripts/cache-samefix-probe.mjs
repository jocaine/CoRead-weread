#!/usr/bin/env node
// 决定性验证：判同一性 prompt 的 '当前讨论（N 轮）' 计数字节是否毁掉全栈前缀缓存
// S1 = 含 N 头部(44)；S2 = 含 N 头部(46, 栈追加2条)  → 预期命中 ≈0（前缀在 N 处断）
// S3 = 去 N 头部（'当前讨论：'）；S4 = 去 N 头部 + 栈追加2条  → 预期命中 ≈ inst+全栈
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
const INST = '你是 CoRead 的「会意系统」，现在判断：下面这条新消息，是不是在延续当前讨论正在追的同一个问题。判定标准：追问、反驳、补充、换角度都算承接；换了具体问题即使同话题也算换问题。只输出一行 JSON。'
const stackBase = JSON.parse(read(path.join(AGENT, 'topic_stack.json')))['mia_8a66411378a3f8d9116f'] || []
const fmt = (e) => (e.role === 'assistant' ? 'AI：' : '用户：') + e.content
const stack = (n) => stackBase.slice(0, n).map(fmt).join('\n')
const pad2 = '\n用户：这个问题我们继续往下想，列宁说的工人贵族和我们这边对比起来有实质区别。\nAI：区别在于列宁的工人贵族是从外部帝国体系获得超额利润的分利阶层，而我们的情形是另一回事。'

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
  console.log(label.padEnd(10) + ' total=' + String(total).padStart(6) + ' hit=' + String(hit).padStart(6) + ' miss=' + String(total - hit).padStart(6) + ' 命中率=' + (total ? (100 * hit / total).toFixed(1) : '-') + '%')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!API_KEY) { console.log('no key'); process.exit(0) }
const N = stackBase.length
console.log('真实栈 ' + N + ' 条 ≈ ' + Math.ceil(stack(N).length * 0.62) + ' tok\n')
const msgA = '新消息："用户场景A的发言"'
const msgB = '新消息："用户场景B的完全不同发言"'
await call('S1(含N)', INST + '\n\n当前讨论（' + N + ' 轮）：\n' + stack(N) + '\n\n' + msgA)
await sleep(2500)
await call('S2(含N+2)', INST + '\n\n当前讨论（' + (N + 2) + ' 轮）：\n' + stack(N) + pad2 + '\n\n' + msgB)
await sleep(2500)
await call('S3(去N)', INST + '\n\n当前讨论：\n' + stack(N) + '\n\n' + msgA)
await sleep(2500)
await call('S4(去N+2)', INST + '\n\n当前讨论：\n' + stack(N) + pad2 + '\n\n' + msgB)
