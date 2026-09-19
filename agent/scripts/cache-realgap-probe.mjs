#!/usr/bin/env node
// 真实 pipeline 缓冲测量：fresh 前缀下，B1(归纳)→B2(point) 间隔 g 的命中率
// 每 (节点, 间隔) 组合用独立节点（fresh 前缀），避免缓存串扰。9 个节点 × 3 档。
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
async function call(prompt, maxTokens) {
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
  return { total, hit }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { buildQuestionPrompt } = await import('../lib/thread-question.js')
const { buildPointPrompt } = await import('../lib/knowledge-graph.js')
if (!API_KEY) process.exit(0)
const graph = JSON.parse(read(path.join(AGENT, 'data', 'knowledge-graph.json')))
const used = new Set(['n_d_5', 'n_d_7', 'n_d_13', 'n_d_14', 'n_d_16', 'n_d_18']) // A/B 已用过（前缀已入缓存）
const candidates = []
for (const n of graph.nodes) {
  if (used.has(n.id)) continue
  const d = n.discussions && n.discussions[0]
  if (!d || !d.question) continue
  const ex = (d.excerpts || []).filter((e) => e && (e.q || e.a))
  if (ex.length < 1) continue
  candidates.push({ n, d, ex })
}
const GAPS = [0, 1500, 3000]
console.log('节点候选 ' + candidates.length + '，取前 9 个 × 3 档间隔')
for (let gi = 0; gi < GAPS.length; gi++) {
  const gap = GAPS[gi]
  for (let i = 0; i < 3; i++) {
    const { n, d, ex } = candidates[gi * 3 + i]
    const entries = []
    for (const e of ex) { if (e.q) entries.push({ role: 'user', content: e.q }); if (e.a) entries.push({ role: 'assistant', content: e.a }) }
    const r1 = await call(buildQuestionPrompt(entries), 384)
    await sleep(gap)
    const r2 = await call(buildPointPrompt({ question: d.question, excerpts: ex }), 16384)
    const pct = r2.total ? (100 * r2.hit / r2.total).toFixed(1) : '-'
    const shared = Math.min(r1.total, r2.total)
    console.log('间隔 ' + String(gap).padStart(4) + 'ms  ' + n.id + ' | B1 total=' + r1.total + ' | B2 total=' + r2.total + ' hit=' + r2.hit + ' 命中率=' + pct + '%（共享前缀≈' + shared + '）')
  }
}
