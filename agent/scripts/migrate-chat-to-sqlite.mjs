#!/usr/bin/env node
/**
 * 迁移：JSONL 三件套 → SQLite（方案 B，2026-10-02）。
 *
 * 默认 **演练模式**（只读 JSONL，写入一个临时库并打印结果，不碰线上）：
 *   node scripts/migrate-chat-to-sqlite.mjs
 * 正式迁移（写入 receiver/inbox/chat.db；已存在且有数据时拒绝，除非 --force）：
 *   node scripts/migrate-chat-to-sqlite.mjs --apply
 * 指定库文件（测试/演练）：
 *   node scripts/migrate-chat-to-sqlite.mjs --db /tmp/x.db --apply
 *
 * 迁移做什么：
 *   · 提问（chat_input.jsonl）+ 回答（chat_output.jsonl 里**不带 _stream** 的记录）入库
 *   · 丢掉流式快照（旧文件 97.1% 的字节，零信息量）
 *   · 用去重台账回填 status：有回答或有台账记录 → ok；两者都没有 → pending（会被正常回答）
 *   · graph-hit → events 表；自由对话注册表 → conversations 表
 *   · 另存 agent/data/unanswered-messages.json：**一次都没答过**的提问清单（默认不补答）
 *
 * 迁移后旧 JSONL **原样保留**（不删不改），可随时用 export-chat.mjs 对照或回滚。
 * ⚠️ 跑之前先 stop.bat：agent/receiver 还在跑时它们用的是旧文件路径（迁移不影响它们，
 *    但切换代码后需要重启才会读库）。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { openChatStore } from '../lib/chat-store.js'
import { migrateJsonlToStore } from '../lib/chat-migrate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : '' }

const INBOX = path.join(REPO, 'receiver', 'inbox')
const AGENT_DIR = path.join(REPO, 'agent')
const APPLY = has('--apply')
const FORCE = has('--force')
const dbFile = val('--db') || (APPLY ? path.join(INBOX, 'chat.db') : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coread-migrate-')), 'chat.db'))

console.log(`模式：${APPLY ? '正式迁移（写库）' : '演练（临时库，不碰线上）'}`)
console.log(`库文件：${dbFile}`)
if (APPLY && fs.existsSync(dbFile) && !FORCE) {
  const probe = openChatStore(dbFile, { readonly: true })
  const n = probe.stats().messages
  probe.close()
  if (n > 0) {
    console.error(`✗ 库里已有 ${n} 条消息。要重导请先移走 chat.db（含 -wal/-shm）或加 --force。`)
    process.exit(1)
  }
}

const before = ['chat_input.jsonl', 'chat_output.jsonl', '.chat_input_replied']
  .map((f) => { try { return fs.statSync(path.join(INBOX, f)).size } catch { return 0 } })
  .reduce((a, b) => a + b, 0)

const store = openChatStore(dbFile)
const t0 = Date.now()
let summary
try {
  summary = migrateJsonlToStore({ inboxDir: INBOX, store, agentDir: AGENT_DIR, log: (m) => console.log('  ' + m) })
} catch (e) {
  console.error('✗ 迁移失败：' + e.message)
  store.close()
  process.exit(1)
}
const stats = store.stats()
store.checkpoint()
const after = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0

console.log(`\n耗时 ${Date.now() - t0} ms`)
console.log(`旧 JSONL 合计 ${(before / 1048576).toFixed(1)} MB → 库 ${(after / 1048576).toFixed(2)} MB` +
  `（缩小 ${(before / Math.max(1, after)).toFixed(1)} 倍）`)
console.log(`库内容：${stats.messages} 条消息（用户 ${stats.userMessages} / 回答 ${stats.replies} / 系统 ${stats.systemMessages}）` +
  `、pending ${stats.pending}、failed ${stats.failed}、事件 ${stats.events}、对话 ${stats.conversations}`)
console.log(`丢弃流式快照 ${summary.droppedSnapshots} 条；孤儿回答（提问已删）${summary.orphanReplies} 条`)
console.log(`重放指纹检出 ${summary.replayed} 条；从未被回答的提问 ${summary.unanswered} 条（清单见 agent/data/unanswered-messages.json）`)
store.close()

if (!APPLY) {
  console.log('\n（演练结束：线上文件与线上库都没有改动。确认无误后加 --apply 正式迁移；正式迁移前建议先 stop.bat）')
} else {
  console.log('\n✓ 已写入 chat.db。旧 JSONL 原样保留（可对照/回滚）。')
  console.log('  下一步：切换 agent/receiver 读库（代码改造完成后重启即可）。')
}
