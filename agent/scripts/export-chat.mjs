#!/usr/bin/env node
/**
 * 导出：SQLite → 旧 JSONL 形态（兼容层，2026-10-02）。
 *
 * 用途：老脚本（measure-tokens / group-discussions / backfill-self-portrait / verify-* 等）
 * 与人工 grep 仍然想要"两个 jsonl 文件"时，用这个命令现导一份**只读副本**。
 * 导出的文件带 .export 后缀，不会被任何在线路径读写。
 *
 *   node scripts/export-chat.mjs                 # → receiver/inbox/chat_{input,output}.export.jsonl
 *   node scripts/export-chat.mjs --out /tmp/dir  # 指定输出目录
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { openChatStore } from '../lib/chat-store.js'
import { exportStoreToJsonl } from '../lib/chat-migrate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const INBOX = path.join(REPO, 'receiver', 'inbox')
const args = process.argv.slice(2)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : '' }

const dbFile = val('--db') || path.join(INBOX, 'chat.db')
const outDir = val('--out') || INBOX
if (!fs.existsSync(dbFile)) {
  console.error(`✗ 找不到聊天库：${dbFile}（先跑 scripts/migrate-chat-to-sqlite.mjs --apply）`)
  process.exit(1)
}
const store = openChatStore(dbFile, { readonly: true })
const stats = store.stats()
console.log(`库：${dbFile}（${stats.messages} 条消息 / ${stats.conversations} 个对话）`)
exportStoreToJsonl({ store, outDir, log: (m) => console.log('  ' + m) })
store.close()
console.log('提示：导出文件是只读副本，不含流式快照；在线路径不会读它。')
