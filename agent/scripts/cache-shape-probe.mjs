#!/usr/bin/env node
/**
 * 上下文形状缓存实测（2026-10）：
 * 用真实形状（SYSTEM + 追加历史 + persona 尾块 + enriched 当轮消息；引用解析判定链交错）
 * 实测每类请求的缓存命中/未命中 token，回答：
 *  ① 主回复链（M）在 persona 插入形状下的稳态命中率（设计地板 = 每轮末尾 ~2 条 + 尾块）；
 *  ② 引用解析链（R）与主回复链交错的共存性（每条用户消息 4 类调用是否互相打断缓存）；
 *  ③ 间隔衰减：真实阅读间隔（6 分钟 / 16 分钟）后同前缀是否还命中；
 *  ④ 各类调用的真实体量（token）。
 * 计费影响：命中 0.05 / 未命中 1.5 元每百万 token——未命中占比几乎等于成本占比。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReferenceInstruction } from '../lib/knowledge-graph.js'

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

// ── 真实材料 ────────────────────────────────────────────────────────────────
const head = '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n'
const SYSTEM = head + read(path.join(AGENT, 'AGENT.md'))
const profile = read(path.join(AGENT, 'profile.md'))
const soul = read(path.join(AGENT, 'soul.md'))
const persona = '【背景档案】（profile.md / soul.md / 书籍足迹的内容——不是用户本轮发言，只用于理解用户背景；即使出现"自述/自陈/你说过"式表述，也不得转述或引用为用户原话）\n\n【用户阅读画像】\n' + profile + '\n\n【你的自画像】\n' + soul
const anchor = '【本轮消息】（上面历史与【背景档案】都只是背景——本行以下是用户当前要你直接回应的内容：若含引文+提问，先围绕引文本身回答）\n'
const journalRaw = read(path.join(AGENT, 'session_journal.jsonl'))
const bookMsgs = journalRaw.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((e) => e && e.kind === 'msg' && e.bookKey === 'mia_8a66411378a3f8d9116f')
  .map((e) => ({ role: e.role, content: String(e.content || '') }))
const graph = JSON.parse(read(path.join(AGENT, 'data', 'knowledge-graph.json')))
const nodeBriefs = graph.nodes.map((n) => ({
  id: n.id,
  point: n.point,
  aliases: n.aliases,
  questions: (n.discussions || []).map((d) => d.question),
}))
const enriched = (k, store) => '[正在共读]《列宁：怎么办？》一 教条主义和"批评自由"\n' +
  '\n[当前进度前文窗口]\n' + ('原文段落上下文的稳定内容部分' + k).repeat(30) + '\n\n' + store

const tok = (s) => Math.ceil(String(s).length * 0.62)

async function call(label, messages) {
  const t0 = Date.now()
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + JSON.stringify(data).slice(0, 200))
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
    : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  const miss = u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens : total - hit
  console.log(label.padEnd(14) + ' total=' + String(total).padStart(6) + ' hit=' + String(hit).padStart(6) +
    ' miss=' + String(miss).padStart(6) + ' 命中率=' + (total ? (100 * hit / total).toFixed(1) : '-').padStart(6) +
    '%  (' + (Date.now() - t0) + 'ms)')
  return { total, hit, miss }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 体量总览 ────────────────────────────────────────────────────────────────
console.log('model=' + MODEL)
console.log('SYSTEM=' + tok(SYSTEM) + ' persona=' + tok(persona) + ' 历史(全部 ' + bookMsgs.length + ' 条)=' + tok(bookMsgs.map((m) => m.content).join('')) + ' token')
const briefBlock = '知识点节点：\n' + nodeBriefs.map((n) => {
  const al = (n.aliases || []).length ? '（能指：' + n.aliases.map((a) => '"' + a + '"').join('；') + '）' : ''
  const qs = (n.questions || []).length ? '（讨论过：' + n.questions.slice(0, 5).map((q) => '"' + q + '"').join('；') + '）' : ''
  return '- ' + n.id + '：「' + n.point + '」' + al + qs
}).join('\n')
console.log('引用解析：指令=' + tok(buildReferenceInstruction()) + ' 节点列表(' + nodeBriefs.length + '节点)=' + tok(briefBlock) + ' token')
if (!API_KEY) { console.log('无 COREAD_API_KEY，跳过实测'); process.exit(0) }

// ── 主流程：真实每用户消息节奏（R 引用解析先于 M 主回复，判定与主回复交错）─────
const TURNS = Math.min(5, Math.floor(bookMsgs.length / 2))
let hist = []
console.log('\n── 阶段1：连续 "R(引用解析) → M(主回复)" × ' + TURNS + '（间隔 2s）──')
for (let k = 1; k <= TURNS; k++) {
  const uIdx = (k - 1) * 2
  const u = bookMsgs[uIdx]
  const store = u.content
  hist.push({ role: 'user', content: store })
  const userMsg = enriched(k, store)
  const rPrompt = buildReferenceInstruction() + '\n\n' + briefBlock + '\n\n用户发言："' + store.slice(0, 400) + '"'
  const mHist = [...hist, { role: 'user', content: persona }, { role: 'user', content: anchor + userMsg }]
  await call('R' + k, [{ role: 'user', content: rPrompt }])
  await sleep(1500)
  await call('M' + k, [{ role: 'system', content: SYSTEM }, ...mHist])
  await sleep(1500)
  const a = bookMsgs[uIdx + 1]
  if (a) hist.push({ role: 'assistant', content: a.content })
}

// ── 阶段2：间隔衰减实测（真实阅读间隔：6 分钟、再 16 分钟）──
console.log('\n── 阶段2：间隔衰减（等待 6 分钟后重放 M' + TURNS + ' 同前缀请求）──')
const lastHist = [...hist]
const lastM = [{ role: 'system', content: SYSTEM }, ...lastHist.slice(0, -1),
  { role: 'user', content: persona }, { role: 'user', content: anchor + enriched(TURNS, bookMsgs[(TURNS - 1) * 2].content) }]
console.log('  等待 6 分钟（' + new Date(Date.now() + 360000).toLocaleTimeString() + ' 恢复）...')
await sleep(360000)
await call('M重放(6min)', lastM)
console.log('  再等待 10 分钟（共 16 分钟间隔）...')
await sleep(600000)
await call('M重放(16min)', lastM)
console.log('\n完成。')
