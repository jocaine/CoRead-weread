#!/usr/bin/env node
// SP prompt 重排验证（2026-10）：① 缓存命中新旧对比（真实形状）② 判定质量新旧对比（真实消息样本）
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

const { buildSelfPortraitInstruction } = await import('../lib/self-portrait.js')
const INST = buildSelfPortraitInstruction()
const tok = (s) => Math.ceil(String(s).length * 0.62)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const existing = read(path.join(AGENT, 'self-portrait.md')).slice(-3000)
const journal = read(path.join(AGENT, 'session_journal.jsonl')).split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && e.kind === 'msg')
const lastAsst = [...journal].reverse().find(e => e.role === 'assistant')
const ctx = String(lastAsst ? lastAsst.content : '').slice(-4000)
// 新旧两种组装（与 lib 中 buildSelfPortraitPrompt 的 2026-10 前后版本一致）
const oldOrder = (msg, sel) => {
  const parts = [INST, '', '用户消息："' + msg + '"']
  if (sel) parts.push('', '划线内容（仅用于解析消息中的指代）："' + sel + '"')
  parts.push('', '对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：', ctx)
  parts.push('', '现有画像（仅作去重参照，不要重复输出已覆盖的信息）：', existing)
  return parts.join('\n')
}
const newOrder = (msg, sel) => {
  const parts = [INST, '', '现有画像（仅作去重参照，不要重复输出已覆盖的信息）：', existing]
  parts.push('', '对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：', ctx)
  if (sel) parts.push('', '划线内容（仅用于解析消息中的指代）："' + sel + '"')
  parts.push('', '用户消息："' + msg + '"')
  return parts.join('\n')
}

async function callRaw(label, prompt, maxTokens = 2048) {
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + JSON.stringify(data).slice(0, 300))
  const u = data.usage || {}
  const total = u.prompt_tokens || 0
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return { total, hit, miss: total - hit, text: String(data.choices?.[0]?.message?.content || '') }
}
function fmt(label, r) {
  console.log(label.padEnd(16) + ' total=' + String(r.total).padStart(6) + ' hit=' + String(r.hit).padStart(6) + ' miss=' + String(r.miss).padStart(6) + ' 命中率=' + (r.total ? (100 * r.hit / r.total).toFixed(1) : '-').padStart(6) + '%')
}

if (!API_KEY) { console.log('no key'); process.exit(0) }
console.log('SP prompt 尺寸：旧序 ≈ ' + tok(oldOrder('m', '')) + ' tok；新序 ≈ ' + tok(newOrder('m', '')) + ' tok（现有画像 ' + tok(existing) + ' + 脉络 ' + tok(ctx) + '）\n')

console.log('── ① 缓存命中对比（真实形状，第 2/3 调用看静态前缀命中）──')
const msgs = [
  '我最近在考虑自己工作上的选择，还想到了我们之前讨论的关于体制的看法。',
  '我妈打电话来说老家的事，我觉得自己现在越来越能理解她当年的处境了。',
  '看到书里列宁批评工人贵族，我觉得我们这里也有类似的结构，只是换了形式。',
]
for (let i = 0; i < 3; i++) {
  const r = await callRaw('旧序M' + (i + 1), oldOrder(msgs[i], ''))
  fmt('旧序M' + (i + 1), r)
  await sleep(1500)
}
console.log('')
for (let i = 0; i < 3; i++) {
  const r = await callRaw('新序M' + (i + 1), newOrder(msgs[i], ''))
  fmt('新序M' + (i + 1), r)
  await sleep(1500)
}

console.log('\n── ② 判定质量对比（真实消息样本，旧序 vs 新序，输出条目对比）──')
const chatIn = read(path.join(AGENT, '..', 'receiver', 'inbox', 'chat_input.jsonl')).trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const chatOut = read(path.join(AGENT, '..', 'receiver', 'inbox', 'chat_output.jsonl')).trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const signals = ['我妈', '我爸', '我家', '我自己', '我今年', '我毕业', '我工作', '我住', '我小时候', '我们厂', '离职', '乡愁', '打电话', '觉得自己', '我当过', '我认识', '我的处境', '我认为', '我目前', '我上']
const sample = []
for (const m of chatIn) {
  const c = String(m.content || '')
  if (c.length < 25 || c.length > 600) continue
  if (!signals.some(w => c.includes(w))) continue
  const ts = m.timestamp || 0
  const reply = chatOut.find(o => o.role === 'assistant' && !('_stream' in o) && typeof o.timestamp === 'number' && o.timestamp >= ts && o.timestamp <= ts + 180000 && String(o.content || '').trim() && !String(o.content).startsWith('⚠️'))
  sample.push({ msg: c.slice(0, 400), ctx: reply ? String(reply.content).slice(-4000) : '' })
  if (sample.length >= 10) break
}
console.log('样本消息 ' + sample.length + ' 条\n')
const extract = (t) => {
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
let same = 0, diff = 0
for (let i = 0; i < sample.length; i++) {
  const { msg, ctx: mctx } = sample[i]
  const ctxUsed = mctx || ctx
  const oldP = [INST, '', '用户消息："' + msg + '"', '对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：', ctxUsed, '现有画像（仅作去重参照，不要重复输出已覆盖的信息）：', existing].filter(x => x !== '').join('\n')
  const newP = [INST, '', '现有画像（仅作去重参照，不要重复输出已覆盖的信息）：', existing, '', '对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：', ctxUsed, '', '用户消息："' + msg + '"'].filter(x => x !== '').join('\n')
  const ro = await callRaw('旧', oldP, 1024)
  const rn = await callRaw('新', newP, 1024)
  const jo = extract(ro.text) || {}
  const jn = extract(rn.text) || {}
  const flat = (j) => [].concat(j.situation || [], j.events || [], j.thoughts || [], j.belief || []).join('|')
  const isSame = flat(jo) === flat(jn)
  if (isSame) same++
  else {
    diff++
    console.log('⚠️ 样本 ' + (i + 1) + ' 判定不同：' + msg.slice(0, 60).replace(/\n/g, ' '))
    console.log('   旧序: ' + flat(jo).slice(0, 220))
    console.log('   新序: ' + flat(jn).slice(0, 220))
  }
  await sleep(800)
}
console.log('\n质量对比：一致 ' + same + ' / 不同 ' + diff + '（共 ' + sample.length + ' 条）')
console.log('（不同条目需人工判断是否顺序效应导致的信息损失）')
