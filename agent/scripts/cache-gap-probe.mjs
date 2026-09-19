#!/usr/bin/env node
// 阶段3：更长间隔的链保留实测（阶段2 结束后启动，避免同刻重放互相污染）
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

const head = '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n'
const SYSTEM = head + read(path.join(AGENT, 'AGENT.md'))
const persona = '【背景档案】（profile.md / soul.md / 书籍足迹的内容——不是用户本轮发言，只用于理解用户背景；即使出现"自述/自陈/你说过"式表述，也不得转述或引用为用户原话）\n\n【用户阅读画像】\n' + read(path.join(AGENT, 'profile.md')) + '\n\n【你的自画像】\n' + read(path.join(AGENT, 'soul.md'))
const anchor = '【本轮消息】（上面历史与【背景档案】都只是背景——本行以下是用户当前要你直接回应的内容：若含引文+提问，先围绕引文本身回答）\n'
const journalRaw = read(path.join(AGENT, 'session_journal.jsonl'))
const bookMsgs = journalRaw.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((e) => e && e.kind === 'msg' && e.bookKey === 'mia_8a66411378a3f8d9116f')
  .map((e) => ({ role: e.role, content: String(e.content || '') }))
const graph = JSON.parse(read(path.join(AGENT, 'data', 'knowledge-graph.json')))
const nodeBriefs = graph.nodes.map((n) => ({ id: n.id, point: n.point, aliases: n.aliases, questions: (n.discussions || []).map((d) => d.question) }))
const briefBlock = '知识点节点：\n' + nodeBriefs.map((n) => {
  const al = (n.aliases || []).length ? '（能指：' + n.aliases.map((a) => '"' + a + '"').join('；') + '）' : ''
  const qs = (n.questions || []).length ? '（讨论过：' + n.questions.slice(0, 5).map((q) => '"' + q + '"').join('；') + '）' : ''
  return '- ' + n.id + '：「' + n.point + '」' + al + qs
}).join('\n')
// 与阶段1 相同的第 5 轮请求体（bookMsgs 前 5 对）
let hist = []
for (let k = 1; k <= 5; k++) {
  const u = bookMsgs[(k - 1) * 2]
  hist.push({ role: 'user', content: u.content })
  const a = bookMsgs[(k - 1) * 2 + 1]
  if (a) hist.push({ role: 'assistant', content: a.content })
}
const enriched = (k, store) => '[正在共读]《列宁：怎么办？》一 教条主义和"批评自由"\n' + '\n[当前进度前文窗口]\n' + ('原文段落上下文的稳定内容部分' + k).repeat(30) + '\n\n' + store
const m5store = bookMsgs[8].content
const M5 = [{ role: 'system', content: SYSTEM }, ...hist.slice(0, 9), { role: 'user', content: persona }, { role: 'user', content: anchor + enriched(5, m5store) }]
const R5 = [{ role: 'user', content: buildReferenceInstruction() + '\n\n' + briefBlock + '\n\n用户发言："' + m5store.slice(0, 400) + '"' }]

async function call(label, messages) {
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  console.log(label.padEnd(14) + ' total=' + total + ' hit=' + hit + ' miss=' + (total - hit) + ' 命中率=' + (total ? (100 * hit / total).toFixed(1) : '-') + '%')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!API_KEY) { console.log('no key'); process.exit(0) }
console.log('阶段3 启动：先等待 20 分钟（与阶段1 的 R5/M5 拉开 ≥30 分钟间隔）')
await sleep(1200000)
console.log('— 重放 R5（间隔 ~' + (20 + 0) + '+ min）')
await call('R5重放', R5)
await sleep(5000)
console.log('— 重放 M5（间隔 ~20+ min）')
await call('M5重放', M5)
await sleep(1200000)
console.log('— 二次重放 R5/M5（间隔 ~40+ min）')
await call('R5重放2', R5)
await sleep(5000)
await call('M5重放2', M5)
console.log('阶段3 完成')