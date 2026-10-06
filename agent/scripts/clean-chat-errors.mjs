#!/usr/bin/env node
/**
 * 清理失败气泡（SQLite 版，2026-10-02 方案 B）。
 *
 * 用途（2026-09-28《大国大城》实例的善后）：那次重放留下 213 条 `⚠️ LLM API 402` 气泡。
 * 现在它们是库里的 messages 行（role=assistant, status=failed），删除就是一条 DELETE——
 * 不再需要"停服 + 整文件重写 + 重启 receiver"（旧的 chat_output.jsonl 63MB 重写会打乱
 * receiver 的行数游标；库是按 id 增量读的，事务删除不影响在线推送）。
 *
 * 用法：
 *   node scripts/clean-chat-errors.mjs                     # dry-run：只列会被删的行
 *   node scripts/clean-chat-errors.mjs --apply             # 真删（删前打印备份提示）
 *   node scripts/clean-chat-errors.mjs --book 480328505d0  # 只清某本书/某场对话（前缀匹配）
 *   node scripts/clean-chat-errors.mjs --from 2026-09-28T00:45 --to 2026-09-28T01:55 \
 *        --any-assistant --book ee442b8364                  # 清该时间窗内的 AI 回复（重复回答）
 *
 * --apply 前会自动把要删的行导出到 receiver/inbox/deleted-messages.<时间戳>.json（可人工恢复）。
 */
import fs from 'fs'
import path from 'path'
import { CHAT_DB, READING_DIR } from '../lib/paths.js'  // 数据路径唯一真源
import { openChatStore } from '../lib/chat-store.js'

const DB_FILE = CHAT_DB
// 删除前的导出存档落在 reading\（与 annotations 同格）；2026-10 前是 receiver\inbox
const INBOX_DIR = READING_DIR
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : '' }
const APPLY = has('--apply')
const BOOK = val('--book')
const ANY_ASSISTANT = has('--any-assistant')
const KEEP = new Set(String(val('--keep') || '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite))
const FROM = val('--from') ? new Date(val('--from')).getTime() : null
const TO = val('--to') ? new Date(val('--to')).getTime() : null
const t = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })

if (!fs.existsSync(DB_FILE)) {
  console.error(`✗ 找不到聊天库 ${DB_FILE}（先跑 scripts/migrate-chat-to-sqlite.mjs --apply）`)
  process.exit(1)
}
const store = openChatStore(DB_FILE)
const where = ["role = 'assistant'"]
const vals = []
if (!ANY_ASSISTANT) where.push("(status = 'failed' OR content LIKE '⚠️%')")
if (BOOK) { where.push('conv LIKE ?'); vals.push(BOOK + '%') }
if (FROM) { where.push('ts >= ?'); vals.push(FROM) }
if (TO) { where.push('ts <= ?'); vals.push(TO) }
const rows = store.db.prepare(`SELECT id, conv, ts, status, content FROM messages WHERE ${where.join(' AND ')} ORDER BY id`).all(...vals)
  .filter((r) => !KEEP.has(Number(r.id)))   // --keep：显式排除（如"这是某条提问的唯一回答，不要当重复删掉"）

console.log(`库：${DB_FILE}`)
console.log(`模式：${ANY_ASSISTANT ? '清该范围内的全部 AI 回复' : '只清失败气泡（status=failed 或 ⚠️ 开头）'}${BOOK ? `，对话前缀 ${BOOK}` : ''}${FROM || TO ? `，时间窗 ${FROM ? t(FROM) : '不限'} ~ ${TO ? t(TO) : '不限'}` : ''}`)
console.log(`命中：${rows.length} 行`)
const byConv = {}
for (const r of rows) byConv[r.conv] = (byConv[r.conv] || 0) + 1
console.log('按对话：', JSON.stringify(byConv))
for (const r of rows.slice(0, 5)) console.log(`   例：${t(r.ts)} | ${String(r.conv).slice(0, 8)} | ${String(r.content).replace(/\n/g, ' ').slice(0, 60)}`)
if (rows.length > 5) console.log(`   …其余 ${rows.length - 5} 行同类`)

if (!APPLY) {
  console.log('\n（dry-run：未改动数据库。确认无误后加 --apply）')
  store.close()
  process.exit(0)
}
if (!rows.length) { console.log('\n没有需要清理的行。'); store.close(); process.exit(0) }
const backup = path.join(INBOX_DIR, `deleted-messages.${Date.now()}.json`)
fs.writeFileSync(backup, JSON.stringify({ deletedAt: Date.now(), filter: { BOOK, ANY_ASSISTANT, FROM, TO }, rows }, null, 2) + '\n')
const n = store.deleteMessages(rows.map((r) => r.id))
console.log(`\n✓ 已删除 ${n} 行；被删内容已导出：${backup}`)
console.log(`  剩余：${JSON.stringify(store.stats())}`)
store.close()
