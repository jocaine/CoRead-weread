#!/usr/bin/env node
/**
 * 导出：SQLite → 旧 JSONL 形态（兼容层，2026-10-02）。
 *
 * 用途：老脚本（measure-tokens / group-discussions / backfill-self-portrait / verify-* 等）
 * 与人工 grep 仍然想要"两个 jsonl 文件"时，用这个命令现导一份**只读副本**。
 * 导出的文件带 .export 后缀，不会被任何在线路径读写。
 *
 *   node scripts/export-chat.mjs                 # → data\backups\chat_{input,output}.export.jsonl
 *   node scripts/export-chat.mjs --out /tmp/dir  # 指定输出目录
 *
 * ⚠️ 2026-10 目录重构后：在线数据全部在 data\ 下，导入导出的旧 JSONL 已随迁移离开
 * `receiver\inbox\`。这个脚本现在是**唯一**重新生成"两个 jsonl"的正路——
 * 那些还在读 jsonl 的老脚本请先用它导出，不要再去找已经不存在的老文件。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { CHAT_DB, DATA_BACKUPS_DIR } from '../lib/paths.js'  // 数据路径唯一真源
import { openChatStore } from '../lib/chat-store.js'
import { exportStoreToJsonl } from '../lib/chat-migrate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : '' }

const dbFile = val('--db') || CHAT_DB
// 默认输出到 data\backups\（导出副本跟备份同格，不污染 reading\）
const outDir = val('--out') || DATA_BACKUPS_DIR
if (!fs.existsSync(dbFile)) {
  console.error(`✗ 找不到聊天库：${dbFile}`)
  console.error('  全新安装还没有聊天记录属正常；老版本升级上来请先跑：')
  console.error('    node agent/scripts/migrate-data-layout.mjs --apply')
  process.exit(1)
}
const store = openChatStore(dbFile, { readonly: true })
const stats = store.stats()
console.log(`库：${dbFile}（${stats.messages} 条消息 / ${stats.conversations} 个对话）`)
exportStoreToJsonl({ store, outDir, log: (m) => console.log('  ' + m) })
store.close()
console.log('提示：导出文件是只读副本，不含流式快照；在线路径不会读它。')
