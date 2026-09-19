// 验证截尾游标方案（2026-10 用户定调）：
// B（逐轮重放/在线模拟）：push user → trim → push assistant——得在线末尾状态 + 累计切掉条数
// C（游标恢复）：全量配对后 slice(累计切掉条数) 续推 + 兜底 trim——应逐条等于 B
// 旧 A（一次截尾）：全量 push 后一次 trim——超长会话与 B 不同（跨会话前缀断裂的根因）
import fs from 'node:fs'
import path from 'node:path'

const INBOX = path.join(process.cwd(), 'receiver', 'inbox')
const CHAT_INPUT = path.join(INBOX, 'chat_input.jsonl')
const CHAT_OUTPUT = path.join(INBOX, 'chat_output.jsonl')

const HIST_TOKEN_BUDGET = 64000
const HIST_TRIM_TARGET = 25720
const TOKEN_PER_CHAR = 0.62
function estimateTokens(text) { return Math.ceil(String(text || '').length * TOKEN_PER_CHAR) }
function trim(h, cursorRef) {
  if (!h.length) return
  let total = 0
  for (const m of h) total += estimateTokens(m.content)
  if (total <= HIST_TOKEN_BUDGET) return
  let acc = 0, cut = 0
  for (let i = h.length - 1; i >= 0; i--) {
    acc += estimateTokens(h[i].content)
    if (acc > HIST_TRIM_TARGET && i < h.length - 1) { cut = i + 1; break }
  }
  if (cut > 0) {
    if (cut % 2 === 1) cut += 1   // 切偶数条：保留段从 user 开始
    const removed = h.splice(0, cut)
    if (cursorRef) cursorRef.n += removed.length
  }
}
function readIfExists(file) { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
function stripCodeBlocks(text) { return String(text || '').replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim() }
function stripMemorize(text) { return String(text || '').replace(/【MEMORIZE】[\s\S]*?【\/MEMORIZE】/g, '').trim() }
function baseBookId(bookId) { return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '') }
function storeTextOf(u) {
  return u.selectedText
    ? `【划线】《${u.bookTitle || ''}》${u.chapter || ''}\n划线原文：${u.selectedText}\n我的提问：${u.content}`
    : u.content
}

const msgs = []
for (const line of readIfExists(CHAT_INPUT).split('\n')) {
  if (!line.trim()) continue
  try { const d = JSON.parse(line); if (typeof d.timestamp === 'number') msgs.push({ role: 'user', ts: d.timestamp, d }) } catch {}
}
for (const line of readIfExists(CHAT_OUTPUT).split('\n')) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (typeof d.timestamp === 'number' && d.role === 'assistant') {
      msgs.push({ role: 'assistant', ts: d.timestamp, content: d.content, hasStream: typeof d._stream === 'number' })
    }
  } catch {}
}
msgs.sort((a, b) => a.ts - b.ts)

const turnsByBook = new Map()
for (let i = 0; i < msgs.length; i++) {
  if (msgs[i].role !== 'user') continue
  const u = msgs[i].d
  let reply = ''
  for (let j = i + 1; j < msgs.length; j++) {
    const n = msgs[j]
    if (n.role === 'user') break
    if (n.hasStream) continue
    if (n.content) { reply = n.content; break }
  }
  if (!reply) continue
  const key = u.bookId ? baseBookId(u.bookId) : '_common'
  const list = turnsByBook.get(key) || []
  list.push({ role: 'user', content: storeTextOf(u) })
  list.push({ role: 'assistant', content: stripCodeBlocks(stripMemorize(reply)) })
  turnsByBook.set(key, list)
}

for (const [key, list] of turnsByBook) {
  // B：在线模拟（逐轮重放），记录累计切掉条数（= 游标）
  const B = []
  const cursor = { n: 0 }
  for (let i = 0; i + 1 < list.length; i += 2) {
    B.push(list[i]); trim(B, cursor); B.push(list[i + 1])
  }
  // C：游标恢复
  const C = []
  const skip = Math.min(cursor.n, list.length)
  for (let i = skip; i < list.length; i++) C.push(list[i])
  trim(C, null)   // 兜底（应不触发）
  const tok = (h) => h.reduce((s, m) => s + estimateTokens(m.content), 0)
  const same = B.length === C.length && B.every((m, i) => m.content === C[i].content)
  console.log(`${key.slice(0, 12)}…：全部 ${list.length / 2} 轮，游标 ${cursor.n} 条（${cursor.n / 2} 轮）`)
  console.log(`  B 在线末态 → ${B.length / 2} 轮（${Math.round(tok(B) / 100) / 10}K token）`)
  console.log(`  C 游标恢复 → ${C.length / 2} 轮（${Math.round(tok(C) / 100) / 10}K token）${same ? '  ✓ 与在线末态逐条一致' : '  ✗ 不一致！'}`)
}
