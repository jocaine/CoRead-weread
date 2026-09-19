#!/usr/bin/env node
// 探针：共享大前缀（≈真实收口段全文规模）建立后，第二次调用（不同尾）间隔多久才能命中？
// 每档用独立前缀文本（互不共享，避免前面档次的单元污染后面的命中测量）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(__dirname, '..')
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const env = {}
for (const line of read(path.join(AGENT, '.env')).split('\n')) { const m = line.trim().match(/^([A-Z_]+)\s*=\s*(.+)$/); if (m) env[m[1]] = m[2].trim() }
const API_KEY = env.COREAD_API_KEY || ''
const API_BASE = (env.COREAD_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = env.COREAD_MODEL || 'deepseek-chat'
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
async function call(prompt, maxTokens = 32) {
  const t0 = Date.now()
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return { total, hit, ms: Date.now() - t0 }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!API_KEY) { console.log('no key'); process.exit(0) }

const GAPS = [0, 500, 1000, 1500, 2500, 4000]
// 每档独立前缀：约 8K 字符 ≈ 5K token（≈真实段全文量级）
const unit = (k) => '这是第 ' + k + ' 段收口讨论里的一句展开内容，讨论的是' + ('机制、条件与张力的具体表述' + k).repeat(3) + '。'
const blockFor = (k) => Array.from({ length: 60 }, (_, i) => '用户："讨论轮次' + i + '的内容：' + ('这段讨论在追的具体问题与推进过程' + k).repeat(4) + '"\nAI："回复轮次' + i + '：' + ('对上一问的解答与延伸，背景对象及其展开' + k).repeat(4) + '"').join('\n')
console.log('共享前缀 ≈ ' + Math.ceil((blockFor(0).length + 400) * 0.62) + ' tok（≈真实段全文量级）\n')
for (let gi = 0; gi < GAPS.length; gi++) {
  const gap = GAPS[gi]
  const k = gi
  const common = '【公共前缀】你是固化判定系统，本次可能归纳问题或派生 point 或拾取能指。\n\n' + blockFor(k)
  const tail1 = '\n\n【任务1】归纳讨论正在追的具体问题，输出一行 JSON。'
  const tail2 = '\n\n【任务2】派生 point（不同的任务尾，只有它不同）。输出一行 JSON。'
  const r1 = await call(common + tail1)
  await sleep(gap)
  const r2 = await call(common + tail2)
  const pct = r2.total ? (100 * r2.hit / r2.total).toFixed(1) : '-'
  console.log('间隔 ' + String(gap).padStart(4) + 'ms | 第1次 total=' + r1.total + ' (hit=0) | 第2次 total=' + r2.total + ' hit=' + r2.hit + ' 命中率=' + pct + '%  (' + r2.ms + 'ms)')
}
