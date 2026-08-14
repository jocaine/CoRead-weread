#!/usr/bin/env node
/**
 * 真实数据 → 判专题化（AI-016）判定，结果写入独立结果文件。
 *
 * 数据：scripts/data/judge-real-cases.json（纯数据，忠实保留聊天流源结构，由 extract-real-cases.mjs 生成）。
 * 结果：scripts/data/judge-real-results.json（独立结果文件，results + judgeSummary）。
 * 判定：逐条走真实的 judgeTopicization（含两级判定/降级/重试/校验），callLLM 走真实 API。
 *       cases 的 note/sel/quoted 由 lib/chat-input.js 解析，数据文件本身不做字段重塑。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/judge-real.mjs                # 全量
 *   node --env-file-if-exists=.env scripts/judge-real.mjs --limit 10     # 前 10 条
 *   node --env-file-if-exists=.env scripts/judge-real.mjs --id 2 --id 5  # 指定 id
 *   node --env-file-if-exists=.env scripts/judge-real.mjs --filter plain # 仅纯提问
 *
 * .env 需配置 COREAD_API_KEY / COREAD_API_BASE / COREAD_MODEL。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeTopicization } from '../lib/topicize.js'
import { messageUnit, parseMessage } from '../lib/chat-input.js'
import { reconstructTopicized } from '../lib/results.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.resolve(__dirname, './data/judge-real-cases.json')
const RES = path.resolve(__dirname, './data/judge-real-results.json')

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

// 与 index.js judgeLLM 同口径：最小判定系统（避免阅读助手指令干扰判定格式）+ temperature 0
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'

async function callLLM(prompt, maxTokens = 512) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        tool_choice: 'none',
      }),
      signal: controller.signal,
    })
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
    const data = JSON.parse(raw)
    const msg = data.choices?.[0]?.message
    return (msg?.content || msg?.reasoning_content || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

// ── CLI 参数 ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { limit: Infinity, ids: [], filter: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') opts.limit = Number(argv[++i])
    else if (argv[i] === '--id') opts.ids.push(Number(argv[++i]))
    else if (argv[i] === '--filter') opts.filter = argv[++i]
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const data = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
const prevRes = fs.existsSync(RES) ? JSON.parse(fs.readFileSync(RES, 'utf-8')) : {}
let cases = [...data.cases]
if (opts.ids.length) cases = cases.filter((c) => opts.ids.includes(c.id))
else if (opts.filter) cases = cases.filter((c) => (opts.filter === 'plain' ? !parseMessage(c).quoted : parseMessage(c).quoted))
cases = cases.slice(0, opts.limit)
if (!cases.length) throw new Error('没有匹配的 cases（--id / --filter 未命中）')

// ── 判专题化结论来源 ─────────────────────────────────────────────────────────
// results 是瞬态中间数据：judge 上次写的还在（同一次 judge→group 周期内）就直接复用；
// 已被 group 消费掉就从分组输出（excerpts/ignored/errors 的 topicized）重建——都按 timestamp 关联。
const verdictByTs = Array.isArray(prevRes.results)
  ? new Map((prevRes.results || []).map((r) => [r.timestamp, r.topicized]))
  : reconstructTopicized(prevRes)

// ── 判定 ─────────────────────────────────────────────────────────────────────
// 每条 case 的 inner 日志先攒进 buf，随该条结果一起打印——避免 stdout 缓冲把
// 判定日志与结果行错序（后台跑全量时实测会交错）。已有判定结论的直接复用，不重复调 API。
const results = []
let skipped = 0
let newly = 0
console.log(`模型: ${MODEL} | temperature: 0 | 判定 ${cases.length} 条（数据文件共 ${data.cases.length} 条）\n`)
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]
  const { note } = parseMessage(c)
  const existing = verdictByTs.get(c.timestamp)
  if (typeof existing === 'boolean') {
    skipped++
    results.push({ id: c.id, timestamp: c.timestamp, topicized: existing, usedAssist: false, attempts: 0 })
    continue
  }
  const buf = []
  const log = (m) => buf.push(`    ${m}`)
  try {
    newly++
    const r = await judgeTopicization(messageUnit(c), { callLLM, log })
    results.push({ id: c.id, timestamp: c.timestamp, topicized: r.topicized, usedAssist: r.usedAssist, attempts: r.attempts })
    const mark = r.topicized ? '✔ 专题化' : '✘ 不专题化'
    const brief = note.length > 40 ? note.slice(0, 40) + '…' : note
    console.log(`[${String(i + 1).padStart(3)}/${cases.length}] ${mark}  ${brief}${r.usedAssist ? '（降级补判）' : ''}`)
    if (buf.length) console.log(buf.join('\n'))
  } catch (e) {
    results.push({ id: c.id, timestamp: c.timestamp, topicized: null, error: e.message })
    console.log(`[${String(i + 1).padStart(3)}/${cases.length}] ✘ 判定失败  ${note.slice(0, 40)}… (${e.message})`)
  }
}

// ── 写回结果到独立结果文件 ────────────────────────────────────────────────────
// results（逐条判专题化结论）是瞬态中间数据：这里写回供 group 本次消费，group 跑完会从文件丢弃。
// 只动 results + judgeSummary 两个键，group 写的 discussions/ignored 等原样保留。
const byTs = new Map(results.map((r) => [r.timestamp, r]))
const finalResults = []
for (const c of data.cases) {
  if (byTs.has(c.timestamp)) { finalResults.push(byTs.get(c.timestamp)); continue }
  const v = verdictByTs.get(c.timestamp)
  if (typeof v === 'boolean') finalResults.push({ id: c.id, timestamp: c.timestamp, topicized: v, usedAssist: false, attempts: 0 })
}
finalResults.sort((a, b) => a.id - b.id)
const judged = finalResults.filter((r) => r.topicized !== null && r.topicized !== undefined)
const judgeSummary = {
  total: data.cases.length,
  judged: judged.length,
  topicized: judged.filter((r) => r.topicized).length,
  notTopicized: judged.filter((r) => !r.topicized).length,
  usedAssist: judged.filter((r) => r.usedAssist).length,
  at: new Date().toISOString().slice(0, 10),
}
if (fs.existsSync(RES)) fs.copyFileSync(RES, RES + '.bak')  // 先备份，后写回
fs.writeFileSync(
  RES,
  JSON.stringify({ ...prevRes, results: finalResults, judgeSummary }, null, 2) + '\n',
  'utf-8',
)

const rate = judged.length ? (judged.filter((r) => r.topicized).length / judged.length * 100).toFixed(0) : '0'
console.log(`\n合计: 已判 ${judged.length}/${data.cases.length}（复用已有 ${skipped} 条，本次新判 ${newly} 条）| 专题化 ${judgeSummary.topicized}（${rate}%）| 不专题化 ${judgeSummary.notTopicized} | 降级补判 ${judgeSummary.usedAssist}`)
console.log(`结果已写回: ${path.relative(process.cwd(), RES)}`)
