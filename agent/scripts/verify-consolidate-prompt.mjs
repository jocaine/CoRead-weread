#!/usr/bin/env node
// A/B 验证：收口固化三段判定新结构（公共前缀 + 段全文 + 任务尾）
// ① 产出 vs 图里已存量值（A = 旧结构产出）——质量门：打印对照供人工复核
// ② usage 实测：B2/B3（point/能指）的缓存命中面是否 ≈ 公共前缀 + 段全文
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

const { buildQuestionPrompt } = await import('../lib/thread-question.js')
const { buildPointPrompt, buildAliasPrompt } = await import('../lib/knowledge-graph.js')
const { discussionBlock } = await import('../lib/discussion-text.js')

async function show(label, prompt, maxTok) {
  const t0 = Date.now()
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxTok, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + JSON.stringify(data).slice(0, 200))
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  const pct = total ? (100 * hit / total).toFixed(0) : '-'
  console.log('   ' + label.padEnd(8) + ' total=' + String(total).padStart(6) + ' hit=' + String(hit).padStart(6) + ' (' + pct + '%)  ' + (Date.now() - t0) + 'ms')
  return { hit, total, text: String(data.choices?.[0]?.message?.content || '') }
}
const extractJson = (t) => {
  const m = String(t || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

if (!API_KEY) { console.log('no key'); process.exit(0) }
const graph = JSON.parse(read(path.join(AGENT, 'data', 'knowledge-graph.json')))
const samples = []
for (const n of graph.nodes) {
  const d = n.discussions && n.discussions[0]
  if (!d || !d.question || !String(n.point || '').trim()) continue
  const ex = Array.isArray(d.excerpts) ? d.excerpts.filter((e) => e && (e.q || e.a)) : []
  if (ex.length < 2) continue
  if (!Array.isArray(n.aliases) || !n.aliases.length) continue
  samples.push(n)
  if (samples.length >= 6) break
}
console.log('样本节点 ' + samples.length + ' 个（A = 图内存量产出[旧结构]，B = 新结构实跑）\n')
let cachedOk = 0
for (const n of samples) {
  const d = n.discussions[0]
  const excerpts = d.excerpts.filter((e) => e && (e.q || e.a))
  const entries = []
  for (const e of excerpts) {
    if (e.q) entries.push({ role: 'user', content: e.q })
    if (e.a) entries.push({ role: 'assistant', content: e.a })
  }
  const blockTok = Math.ceil(discussionBlock(excerpts).length * 0.62)
  console.log('─ ' + n.id + '（excerpts ' + excerpts.length + ' 轮，全文≈' + blockTok + ' tok）')
  try {
    const q1 = await show('B1归纳', buildQuestionPrompt(entries), 384)
    const question = extractJson(q1.text)?.question
    const p1 = await show('B2point', buildPointPrompt({ question: question || d.question, excerpts }), 16384)
    const point = extractJson(p1.text)?.point
    const a1 = await show('B3能指', buildAliasPrompt({ point: point || n.point, question: question || d.question, excerpts }), 8192)
    const aliases = extractJson(a1.text)?.aliases
    console.log('   存量 question: ' + String(d.question).slice(0, 70))
    console.log('   B1  question: ' + String(question || '(解析失败)').slice(0, 70))
    console.log('   存量 point   : ' + String(n.point).slice(0, 70))
    console.log('   B2  point   : ' + String(point || '(解析失败)').slice(0, 70))
    console.log('   存量 aliases : ' + n.aliases.length + ' 条 | B3: ' + (aliases ? aliases.length : 0) + ' 条')
    const goodHit = p1.hit > 0 && a1.hit > 0
    if (goodHit) cachedOk++
    console.log('   命中对照: B2命中=' + p1.hit + ' / B3命中=' + a1.hit + '（全文前缀≈' + blockTok + ' tok；命中率 B2=' + (p1.total ? (100 * p1.hit / p1.total).toFixed(0) : '-') + '% B3=' + (a1.total ? (100 * a1.hit / a1.total).toFixed(0) : '-') + '%）')
  } catch (e) {
    console.log('   ⚠️ ' + e.message)
  }
  console.log('')
}
console.log('B2/B3 都吃到缓存命中的样本: ' + cachedOk + '/' + samples.length)
