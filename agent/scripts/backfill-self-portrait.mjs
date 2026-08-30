#!/usr/bin/env node
/**
 * 用户情况与观念画像回填 — 把历史用户消息喂给画像维护，生成 agent/self-portrait.md。
 *
 * 数据源：agent/session_journal.jsonl（及 .bak*）+ receiver/inbox/chat_input.jsonl（及 .bak*），
 * 按 content 全文去重，按时间排序。每条消息调用 judgeSelfPortrait，
 * 输出 situation（情况）/ belief（观念）的**总结条目**（画像语言，非原文截取）；
 * 每条判定传入已积累的画像条目作去重参照；最后把全部条目渲染成 self-portrait.md。
 *
 * 运行：npm run backfill:portrait（需 agent/.env 配置 COREAD_API_KEY / COREAD_API_BASE）
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeSelfPortrait } from '../lib/self-portrait.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = path.join(__dirname, '..')
const OUT_FILE = path.join(AGENT_DIR, 'self-portrait.md')

// .env 由 npm run backfill:portrait（--env-file-if-exists=.env）加载
const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

async function callLLMOnce(prompt, maxTokens = 4096) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0, // 判定任务要确定性
      tool_choice: 'none',
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
  const data = JSON.parse(raw)
  const msg = data.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

/**
 * 从一条消息的 content 里提取"用户原话"（剥离系统注入窗口与划线块）。
 */
function extractUserNote(content) {
  if (!content || typeof content !== 'string') return null
  let text = content.trim()
  if (text.startsWith('[正在共读]')) {
    const qi = text.indexOf('[引用]')
    if (qi === -1) return null
    text = text.slice(qi).trim()
  }
  if (text.startsWith('[引用]')) {
    const titleMatch = text.match(/^\[引用\]《([^》]+?)》/)
    let bookTitle = titleMatch ? titleMatch[1].trim() : ''
    let chapter = ''
    const chMatch = bookTitle.match(/\s+([^\s]+)$/)
    if (chMatch) { chapter = chMatch[1]; bookTitle = bookTitle.slice(0, chMatch.index).trim() }
    const ls = text.split('\n')
    let i = 0
    while (i < ls.length && !/^>/.test(ls[i])) i++
    while (i < ls.length && /^>/.test(ls[i])) i++
    const rest = ls.slice(i).join('\n').trim()
    if (!rest) return null
    return { note: rest, bookTitle, chapter }
  }
  return { note: text, bookTitle: '', chapter: '' }
}

// 已有画像条目 → 去重参照文本（四类）
function portraitText(portrait) {
  const parts = []
  if (portrait.situation.length) parts.push('情况：\n' + portrait.situation.map((s) => '- ' + s).join('\n'))
  if (portrait.events.length) parts.push('做过的事：\n' + portrait.events.map((s) => '- ' + s).join('\n'))
  if (portrait.thoughts.length) parts.push('对事件的思考：\n' + portrait.thoughts.map((s) => '- ' + s).join('\n'))
  if (portrait.belief.length) parts.push('观念：\n' + portrait.belief.map((s) => '- ' + s).join('\n'))
  return parts.join('\n\n')
}

// 新条目并入画像（按文本去重，保留出现顺序）
function mergePortrait(portrait, r) {
  for (const k of ['situation', 'events', 'thoughts', 'belief']) {
    const arr = r[k] || []
    for (const item of arr) {
      if (!portrait[k].includes(item)) portrait[k].push(item)
    }
  }
}

// ── 收集数据源 ───────────────────────────────────────────────────────────
const SOURCE_FILES = [
  ...readdirSync(AGENT_DIR).filter((f) => /^session_journal\.jsonl(\..*)?$/.test(f)).map((f) => path.join(AGENT_DIR, f)),
  ...readdirSync(path.join(AGENT_DIR, '..', 'receiver', 'inbox'))
    .filter((f) => /^chat_input\.jsonl(\..*)?$/.test(f))
    .map((f) => path.join(AGENT_DIR, '..', 'receiver', 'inbox', f)),
  ...readdirSync(path.join(AGENT_DIR, '..', 'receiver', 'inbox'))
    .filter((f) => /^chat_output\.jsonl(\..*)?$/.test(f))
    .map((f) => path.join(AGENT_DIR, '..', 'receiver', 'inbox', f)),
].sort()
console.log(`数据源：${SOURCE_FILES.length} 个文件`);

const seen = new Set()
const messages = [];
for (const f of SOURCE_FILES) {
  const raw = readFileSync(f, 'utf-8')
  for (const l of raw.trim().split('\n').filter(Boolean)) {
    let o = null
    try { o = JSON.parse(l) } catch {}
    if (!o) continue
    let m = null
    if (o.kind === 'msg' && o.role === 'user') {
      m = { t: o.t || 0, content: o.content, bookTitle: '', chapter: '', selectedText: '' }
    } else if (o.role === 'user' && o.content) {
      let bookTitle = String(o.bookTitle || '').trim()
      let chapter = String(o.chapter || '').trim()
      const chMatch = bookTitle.match(/\s+([^\s]+)$/)
      if (chMatch && !chapter) { chapter = chMatch[1]; bookTitle = bookTitle.slice(0, chMatch.index).trim() }
      m = { t: o.timestamp || 0, content: o.content, bookTitle, chapter, selectedText: o.selectedText || '' }
    }
    if (!m || !String(m.content || '').trim()) continue
    const fp = String(m.content).trim()
    if (seen.has(fp)) continue
    seen.add(fp)
    messages.push(m)
  }
}

// 收集 AI 回复（chat_output）作对话脉络：流式累积取每条时间戳的最终完整版
const replyByT = {}
for (const f of SOURCE_FILES) {
  if (!/chat_output/.test(f)) continue
  const raw = readFileSync(f, 'utf-8')
  for (const l of raw.trim().split('\n').filter(Boolean)) {
    let o = null
    try { o = JSON.parse(l) } catch {}
    if (!o || o.role !== 'assistant' || !o.content) continue
    const t = o.timestamp || 0
    const c = String(o.content).trim()
    if (!t || c.length < 40) continue
    const prev = replyByT[t]
    // 流式中间记录是完整版的真前缀，保留更长的
    if (!prev || c.length > prev.length) replyByT[t] = c
  }
}
const replyTimes = Object.keys(replyByT).map(Number).sort((a, b) => a - b)
const replies = replyTimes.map((t) => ({ t, c: replyByT[t] }))
console.log('AI 回复条目（去流式后）：' + replies.length);

// 为每条用户消息挂对话脉络：取它前后 10 分钟窗口内的 AI 回复（最多 3 条，拼接截断）
const CTX_WINDOW_MS = 10 * 60 * 1000
function attachContext(m) {
  const nearby = replies.filter((r) => Math.abs(r.t - m.t) <= CTX_WINDOW_MS).slice(0, 3)
  if (!nearby.length) return ''
  return nearby.map((r) => '[AI] ' + r.c.slice(0, 600)).join('\n\n').slice(-4000)
}
for (const m of messages) m.context = attachContext(m)
messages.sort((a, b) => (a.t || 0) - (b.t || 0))
console.log(`共 ${messages.length} 条用户消息（去重后）`);

// ── 逐条判定（带已有画像作去重参照） ─────────────────────────────────────
const portrait = { situation: [], events: [], thoughts: [], belief: [] }
let judged = 0, failed = 0;
for (const m of messages) {
  const ext = extractUserNote(m.content)
  const note = (ext && ext.note) || String(m.content || '').trim()
  if (!note) continue
  judged++
  const input = { userNote: note }
  const sel = String(m.selectedText || '').trim()
  if (sel) input.selected = { text: sel }
  try {
    const r = await judgeSelfPortrait(input, {
      callLLM: callLLMOnce,
      existing: portraitText(portrait), // 已积累画像 → 去重参照
      context: m.context, // 对话脉络（前后 AI 回复）→ 归纳动机/意义
      maxTokens: 4096,
      log: (s) => console.log(s),
    })
    if (r.situation.length || r.events.length || r.thoughts.length || r.belief.length) {
      mergePortrait(portrait, r)
      for (const s of r.situation) console.log('  📝 情况：' + s)
      for (const e of r.events) console.log('  🎬 事件：' + e)
      for (const t of r.thoughts) console.log('  💭 思考：' + t)
      for (const b of r.belief) console.log('  ✦ 观念：' + b)
    }
  } catch (e) {
    failed++
    console.log('  ⚠️ 判定失败：' + e.message + '（消息：' + note.slice(0, 40) + '）')
  }
}


// ── 渲染 self-portrait.md ──────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10)
const md = [
  '# 用户情况与观念画像（self-portrait）',
  '',
  '> 由会话内容维护：用户谈到自己的生活状况 → 记入「情况」；实际做过的事 → 记入「做过的事」；',
  '> 对自己经历的想法/感受/心理活动 → 记入「对事件的思考」；表露立场/价值观/看问题的方式 → 记入「观念」。',
  '> 与 profile.md 的区别：不进头部上下文（维护不伤 LLM 前缀缓存）、不是合并式重写（有新信息才追加条目）；',
  '> 条目是**总结**（画像陈述），不是原文截取。',
  '> 回填生成：' + today + '｜来源：历史对话 ' + judged + ' 条',
  '',
  '## 情况（situation）',
  '',
  ...(portrait.situation.length ? portrait.situation.map((s) => '- ' + s) : ['（暂无）']),
  '',
  '## 做过的事（events）',
  '',
  ...(portrait.events.length ? portrait.events.map((e) => '- ' + e) : ['（暂无）']),
  '',
  '## 对事件的思考（thoughts）',
  '',
  ...(portrait.thoughts.length ? portrait.thoughts.map((t) => '- ' + t) : ['（暂无）']),
  '',
  '## 观念（belief）',
  '',
  ...(portrait.belief.length ? portrait.belief.map((b) => '- ' + b) : ['（暂无）']),
  '',
  '---',
  '> 统计：判定 ' + judged + ' 条，失败 ' + failed + ' 条，画像条目 情况 ' + portrait.situation.length + ' 条 / 做过的事 ' + portrait.events.length + ' 条 / 思考 ' + portrait.thoughts.length + ' 条 / 观念 ' + portrait.belief.length + ' 条。',
].join('\n')

writeFileSync(OUT_FILE, md + '\n', 'utf-8')
console.log('\n✅ 已生成 ' + path.basename(OUT_FILE) + '（情况 ' + portrait.situation.length + ' / 事件 ' + portrait.events.length + ' / 思考 ' + portrait.thoughts.length + ' / 观念 ' + portrait.belief.length + '）')