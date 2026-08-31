#!/usr/bin/env node
/** 验证 restoreHistories 恢复逻辑（真实数据，与 index.js 同款规则） */
import fs from 'node:fs'

const CHAT_INPUT = 'receiver/inbox/chat_input.jsonl'
const CHAT_OUTPUT = 'receiver/inbox/chat_output.jsonl'
const readIfExists = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const baseBookId = (id) => String(id || '').replace(/k[0-9a-f]{16,}$/i, '')
const stripCodeBlocks = (t) => t.replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
const stripMemorize = (t) => String(t || '').replace(/【MEMORIZE:(?:profile|soul)】[\s\S]*$/, '').trim()

const msgs = []
for (const line of readIfExists(CHAT_INPUT).split('\n')) {
  if (!line.trim()) continue
  let d; try { d = JSON.parse(line) } catch { continue }
  if (typeof d.timestamp !== 'number') continue
  msgs.push({ role: 'user', ts: d.timestamp, d })
}
for (const line of readIfExists(CHAT_OUTPUT).split('\n')) {
  if (!line.trim()) continue
  let d; try { d = JSON.parse(line) } catch { continue }
  if (typeof d.timestamp !== 'number') continue
  msgs.push({ role: 'assistant', ts: d.timestamp, content: d.content, hasStream: typeof d._stream === 'number' })
}
msgs.sort((a, b) => a.ts - b.ts)

const turns = new Map()
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
  const storeText = u.selectedText
    ? `【划线】《${u.bookTitle || ''}》${u.chapter || ''}\n划线原文：${u.selectedText}\n我的提问：${u.content}`
    : u.content
  const list = turns.get(key) || []
  list.push({ role: 'user', content: storeText })
  list.push({ role: 'assistant', content: stripCodeBlocks(stripMemorize(reply)) })
  turns.set(key, list)
}

console.log('恢复结果（真实数据）：\n')
for (const [key, list] of turns) {
  const totalChars = list.reduce((s, m) => s + m.content.length, 0)
  const estTok = Math.ceil(totalChars * 0.62)
  const marker = estTok > 64000 ? '→ 超出 64K，触发惰性截尾（切到 40 轮）' : '→ 预算内，全量保留'
  console.log(`${key.padEnd(22)} ${Math.round(list.length / 2)} 轮（${list.length} 条） 估算 ${estTok} token  ${marker}`)
}
// 检查最近一轮内容（承接质量）
const lastFree = turns.get('__coread_free_mode__')
if (lastFree) {
  console.log('\n自由模式最近一轮：')
  console.log('  user: ' + lastFree[lastFree.length - 2].content.slice(0, 60))
  console.log('  assistant: ' + lastFree[lastFree.length - 1].content.slice(0, 60))
}
