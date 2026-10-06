#!/usr/bin/env node
/**
 * 验证 restoreHistories 恢复逻辑（与 index.js 同款规则）。
 *
 * 数据来源（2026-10 目录重构后）：`data\backups\` 下由 `export-chat.mjs` 导出的只读副本。
 * 不在线数据了——在线真源是 SQLite（data\sessions\chat.db），而恢复逻辑要验的正是
 * "从 jsonl 形态的旧数据恢复"，所以用导出副本作为固定输入反而更合适（可重复）。
 *
 *   node scripts/export-chat.mjs     # 先导一份（→ data\backups\chat_{input,output}.export.jsonl）
 *   node scripts/restore-check.mjs   # 再跑本检查
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_BACKUPS_DIR } from '../lib/paths.js'  // 数据路径唯一真源

const CHAT_INPUT = path.join(DATA_BACKUPS_DIR, 'chat_input.export.jsonl')
const CHAT_OUTPUT = path.join(DATA_BACKUPS_DIR, 'chat_output.export.jsonl')
if (!fs.existsSync(CHAT_INPUT) && !fs.existsSync(CHAT_OUTPUT)) {
  console.error('✗ 找不到导出的 jsonl 副本：')
  console.error(`    ${CHAT_INPUT}`)
  console.error('  先跑一次：node agent/scripts/export-chat.mjs')
  process.exit(1)
}
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
// 检查最近一轮内容（承接质量）。
// 注意：导出副本里不一定有自由模式的消息（例如库刚建、或以旧 JSONL 为准的时期），
// 所以这里要判长度，别直接索引——2026-10 实跑时因为漏判，最后一行崩在 undefined.slice 上。
const lastFree = turns.get('__coread_free_mode__')
if (lastFree && lastFree.length >= 2) {
  console.log('\n自由模式最近一轮：')
  console.log('  user: ' + lastFree[lastFree.length - 2].content.slice(0, 60))
  console.log('  assistant: ' + lastFree[lastFree.length - 1].content.slice(0, 60))
} else {
  console.log('\n（导出副本里没有自由模式的成对轮次，跳过最近一轮抽查）')
}
