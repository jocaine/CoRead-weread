#!/usr/bin/env node
// aliases 条数问题核查：新结构(B) vs 旧结构(A) 用同一锚（存量 point/question）
// 每节点：B 跑 1 次 + A 跑 2 次（采样旧结构自身方差），打印条目做覆盖对比
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
async function call(prompt, maxTokens = 8192) {
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  return String(data.choices?.[0]?.message?.content || '')
}
const extractJson = (t) => { const m = String(t || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
const clean = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean))]

const { buildAliasInstruction, buildAliasPrompt } = await import('../lib/knowledge-graph.js')
const { CONSOLIDATE_FRAMING, discussionBlock } = await import('../lib/discussion-text.js')
if (!API_KEY) process.exit(0)
const graph = JSON.parse(read(path.join(AGENT, 'data', 'knowledge-graph.json')))
const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]))

// 旧结构组装（指令前置 + point/question 锚 + 全文 excerpts）——重构自 2026-10 改版前的 buildAliasPrompt
function oldAliasPrompt(input) {
  const point = String(input.point || '').trim()
  const lines = [buildAliasInstruction(), '', '条目 point："' + point + '"']
  if (input.question) lines.push('讨论问题："' + input.question + '"')
  const ex = Array.isArray(input.excerpts) ? input.excerpts.filter((e) => e && (e.q || e.a)) : []
  if (ex.length) {
    lines.push('', '讨论内容（全量提供，不截取——背景事物及其展开内容都在这里找；不许发明讨论里没有的内容）：')
    for (const e of ex) { const q = String(e.q || '').trim(); const a = String(e.a || '').trim(); if (q) lines.push('用户："' + q + '"'); if (a) lines.push('AI："' + a + '"') }
  }
  return lines.join('\n')
}

const ids = ['n_d_5', 'n_d_14', 'n_d_13']
for (const id of ids) {
  const n = byId[id]
  const d = n.discussions[0]
  const excerpts = d.excerpts.filter((e) => e && (e.q || e.a))
  console.log('════ ' + id + ' · point: ' + String(n.point).slice(0, 50))
  console.log('存量(A) aliases ' + n.aliases.length + ' 条:')
  n.aliases.forEach((a, i) => console.log('  A' + (i + 1) + '. ' + a.slice(0, 120)))
  // B 结构（增强要点尾）2 次
  for (let run = 1; run <= 2; run++) {
    const p = buildAliasPrompt({ point: n.point, question: d.question, excerpts })
    const txt = await call(p)
    const arr = clean(extractJson(txt)?.aliases)
    console.log((run === 1 ? 'B(新结构)' : 'B2(新结构)') + ' aliases ' + arr.length + ' 条:')
    arr.forEach((a, i) => console.log('  B' + (run === 1 ? '' : '2') + (i + 1) + '. ' + a.slice(0, 120)))
  }
  // A 结构 1 次（采样旧结构方差）
  const txtA = await call(oldAliasPrompt({ point: n.point, question: d.question, excerpts }))
  const arrA = clean(extractJson(txtA)?.aliases)
  console.log('A(旧结构复跑) aliases ' + arrA.length + ' 条:')
  arrA.forEach((a, i) => console.log('  AR' + (i + 1) + '. ' + a.slice(0, 120)))
  console.log('')
}
