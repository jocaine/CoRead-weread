// chat.db.diag-wal.mjs — 只读诊断 SQLite 聊天库的 WAL 状态
//
// 用法（在仓库根目录）：
//   node agent/scripts/chat.db.diag-wal.mjs
//
// 背景：本项目用 SQLite 的 WAL 模式（agent/lib/chat-store.js:60）。
// WAL 模式下一次写入会同时牵涉三个文件：
//   chat.db      主库。只在"搬运动作"（checkpoint）时被更新。
//   chat.db-wal  暂存本。新数据先追加到这里，攒够了才搬回主库。
//   chat.db-shm  索引。多进程共用的查找表 + 每个读者的水位线（书签）。
//                可重建，丢了不心疼；例外是 -wal 绝对不能手删。
//
// 本脚本只读，不改任何数据。它回答三个问题：
//   1. 数据有没有悬在暂存本里没搬回主库？（决定"只拷 chat.db"安不安全）
//   2. 主库文件有多旧？（主库 mtime 落后 = 一直在追加但没搬）
//   3. 是否干净退出过？判据：-shm 还在 = 没有。
//
// 已验证的判据（受控实验，本机 Node 24 + SQLite 3.x）：
//   close() 正常关闭        → -wal 被删除、-shm 被删除、主库已含全部数据
//   wal_checkpoint(TRUNCATE) → 主库已含全部数据，-wal 清成 0 字节，-shm 仍在
//   process.exit(0) 不关闭   → -wal 很大、-shm 仍在、主库停留在旧版本
//
// 关于"没干净关闭"：代码侧已修（agent 三处退出点 + receiver 的 SIGINT/SIGTERM 都先
// closeChatStore()），但 Windows 上 taskkill /F 是强杀、进程收不到信号，所以经
// stop.bat / start.bat 停机时仍会留下 -wal/-shm。那是预期行为，不是故障。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { CHAT_DB } from '../lib/paths.js'  // 数据路径唯一真源
import { openChatStore } from '../lib/chat-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 默认体检当前生效的聊天库（data\sessions\chat.db）；也接受命令行显式给一个路径，
// 这样即使库还没被创建（或想体检某个备份）也能跑。
const dbFile = process.argv[2] || CHAT_DB

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const stat = (p) => { try { return fs.statSync(p) } catch { return null } }
const ago = (t) => {
  const s = Math.round((Date.now() - t.getTime()) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${(s / 3600).toFixed(1)} 小时前`
}

if (!stat(dbFile)) {
  console.error(`聊天库不存在：${dbFile}`)
  process.exit(1)
}

console.log(`聊天库：${dbFile}\n`)

// ── 1. 三个文件的体积与时间戳 ──────────────────────────────────
const rows = []
for (const [label, suf] of [['chat.db（主库）', ''], ['chat.db-wal（暂存本）', '-wal'], ['chat.db-shm（索引）', '-shm']]) {
  const st = stat(dbFile + suf)
  rows.push({ label, size: st ? kb(st.size) : '不存在', mtime: st ? ago(st.mtime) : '—' })
}
const w = Math.max(...rows.map((r) => r.label.length))
for (const r of rows) console.log(`  ${r.label.padEnd(w)}  ${r.size.padStart(10)}   最后写入 ${r.mtime}`)

const walSt = stat(dbFile + '-wal')
const shmSt = stat(dbFile + '-shm')
const dbSt = stat(dbFile)

// ── 2. 问 SQLite 要权威状态 ─────────────────────────────────────
const store = openChatStore(dbFile, { readonly: true })
const q = (sql) => store.db.prepare(sql).get()
const pageSize = q('PRAGMA page_size').page_size
const pageCount = q('PRAGMA page_count').page_count
const journalMode = q('PRAGMA journal_mode').journal_mode
const ck = q('PRAGMA wal_checkpoint(PASSIVE)')
const stats = store.stats()
store.close()

console.log(`\n  journal_mode = ${journalMode}   页大小 ${pageSize}   主库 ${pageCount} 页`)
console.log(`  消息 ${stats.messages} 条 / 对话 ${stats.conversations} 个 / 待处理 ${stats.pending} / 失败 ${stats.failed}`)
console.log(`  暂存本 ${ck.log} 帧，其中已搬回主库 ${ck.checkpointed} 帧`)

// ── 3. 结论 ─────────────────────────────────────────────────────
console.log('\n──── 判读 ────')
const lagMin = dbSt && walSt ? Math.round((walSt.mtime - dbSt.mtime) / 60000) : 0
console.log(`  主库比暂存本旧 ${lagMin} 分钟`)

if (ck.log === 0) {
  console.log('  ✅ 暂存本为空：所有数据都在主库，此刻只拷 chat.db 是完整的')
} else if (ck.checkpointed >= ck.log) {
  console.log(`  ⚠️ 暂存本里 ${ck.log} 帧虽然都已搬回主库（数据不丢），但文件本身没清空。`)
  console.log('     → 这是"搬完了没清扫"的中间状态。只拷 chat.db 目前安全，但下次写入就会变。')
} else {
  console.log(`  ❌ 有 ${ck.log - ck.checkpointed} 帧还没搬回主库 —— 此刻只拷 chat.db 会丢这部分数据！`)
  console.log('     → 先跑 agent/scripts/backup-chat.mjs（会先做 checkpoint），或停掉主程序再拷。')
}

if (shmSt) {
  console.log('  ⚠️ chat.db-shm 还在 → 这个库【上次不是干净关闭的】')
  console.log('     判据来自受控实验：最后一个连接 close() 时，-wal 和 -shm 都会被自动删除。')
  console.log('     代码侧已处理：agent 的 shutdown / .stop 哨兵 / 启动失败三处，以及 receiver 的')
  console.log('     SIGINT/SIGTERM，都会先 closeChatStore() 再退出。')
  console.log('     仍看到 -shm 通常是这两种情况：')
  console.log('       1) 进程被强杀。Windows 上 taskkill /F（stop.bat、start.bat 用的就是它）')
  console.log('          属于强杀，进程收不到信号，所以走它们停机时必然留下 -wal/-shm；')
  console.log('       2) 上次退出发生在本修复之前。')
  console.log('     数据不受影响（下次连接会自动恢复并重放/回滚），只是 WAL 没被清空。')
} else {
  console.log('  ✅ 没有 -shm：上次是干净关闭的')
}
