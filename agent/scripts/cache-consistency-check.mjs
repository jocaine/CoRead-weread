// 跨会话缓存一致性检查（2026-10）：
// 对比「在线历史序列」（say() 逐轮 push 的 hist）与「启动恢复序列」（restoreHistories
// 重建）——两者任何一条消息不一致，前缀缓存从该条起全部失配。
// 用法：node scripts/cache-consistency-check.mjs [booksDir]
import fs from 'node:fs'
import path from 'node:path'

const INBOX = path.join(process.cwd(), 'receiver', 'inbox')
const CHAT_INPUT = path.join(INBOX, 'chat_input.jsonl')
const CHAT_OUTPUT = path.join(INBOX, 'chat_output.jsonl')

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
function stripCodeBlocks(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
}
function stripMemorize(text) {
  return String(text || '').replace(/【MEMORIZE】[\s\S]*?【\/MEMORIZE】/g, '').trim()
}
function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}
// 与 agent/index.js 完全一致的 storeText 构造（恢复端）
function storeTextOf(u) {
  return u.selectedText
    ? `【划线】《${u.bookTitle || ''}》${u.chapter || ''}\n划线原文：${u.selectedText}\n我的提问：${u.content}`
    : u.content
}

// ── 重建：user（chat_input）+ assistant（chat_output 最终记录）按时间戳排序 ──
const msgs = []
for (const line of readIfExists(CHAT_INPUT).split('\n')) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (typeof d.timestamp !== 'number') continue
    msgs.push({ role: 'user', ts: d.timestamp, d })
  } catch {}
}
for (const line of readIfExists(CHAT_OUTPUT).split('\n')) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (typeof d.timestamp !== 'number') continue
    if (d.role === 'assistant') {
      msgs.push({ role: 'assistant', ts: d.timestamp, content: d.content, hasStream: typeof d._stream === 'number' })
    }
  } catch {}
}
msgs.sort((a, b) => a.ts - b.ts)

// 配对：user 之后第一条不带 _stream 的 assistant（与 restoreHistories 一致）
const turns = []   // { key, user, reply }
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
  turns.push({ key: u.bookId ? baseBookId(u.bookId) : '_common', user: storeTextOf(u), reply })
}

// 按书分组，输出两套序列的差异
const byBook = new Map()
for (const t of turns) {
  if (!byBook.has(t.key)) byBook.set(t.key, [])
  byBook.get(t.key).push(t)
}

for (const [key, list] of byBook) {
  const online = []   // 修复前在线：assistant = chat_output 原文（含代码块，未 strip）
  const restored = [] // 恢复：assistant = stripCodeBlocks(stripMemorize(reply))
  for (const t of list) {
    online.push({ role: 'user', content: t.user })
    online.push({ role: 'assistant', content: t.reply })
    restored.push({ role: 'user', content: t.user })
    restored.push({ role: 'assistant', content: stripCodeBlocks(stripMemorize(t.reply)) })
  }
  // 对比
  let firstDiff = -1
  let codeBlockCount = 0
  for (let i = 0; i < online.length; i++) {
    if (online[i].content !== restored[i].content) { firstDiff = i; break }
  }
  for (const t of list) if (/```/.test(t.reply)) codeBlockCount++
  const bytes = list.reduce((s, t) => s + t.user.length + t.reply.length, 0)
  console.log(`\n书 ${key || '(空key)'}：${list.length} 轮，${(bytes / 1024).toFixed(1)} KB 文本，含代码块回复 ${codeBlockCount} 条`)
  if (firstDiff === -1) {
    console.log('  ✓ 在线序列与恢复序列完全一致（修复前语义）——缓存前缀可跨会话命中')
  } else {
    const i = firstDiff
    console.log(`  ✗ 第 ${i + 1} 条消息（第 ${Math.floor(i / 2) + 1} 轮 ${i % 2 === 0 ? 'user' : 'assistant'}）开始不一致`)
    const o = online[i].content, r = restored[i].content
    console.log(`    在线(${o.length}字) 头100字：${JSON.stringify(o.slice(0, 100))}`)
    console.log(`    恢复(${r.length}字) 头100字：${JSON.stringify(r.slice(0, 100))}`)
    // 找出具体差异模式
    if (o.includes('```') || r.includes('```')) console.log('    → 差异疑似来自代码块（stripCodeBlocks）')
    else {
      for (let k = 0; k < Math.min(o.length, r.length); k++) {
        if (o[k] !== r[k]) { console.log(`    → 第一个不同字符位置 ${k}：在线「${o.slice(Math.max(0, k - 15), k + 15)}」vs 恢复「${r.slice(Math.max(0, k - 15), k + 15)}」`); break }
      }
      if (o.length !== r.length) console.log(`    → 长度不同（${o.length} vs ${r.length}），且公共前缀完全一致——差异在尾部`)
    }
  }
}
