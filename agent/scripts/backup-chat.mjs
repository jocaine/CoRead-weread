#!/usr/bin/env node
/**
 * 聊天库备份（2026-10-04）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────
 * 聊天库跑在 SQLite 的 WAL 模式下，一次写入牵涉三个文件：
 *   chat.db      主库。只在"搬运动作"（checkpoint）时被更新。
 *   chat.db-wal  暂存本。新数据先追加到这里。
 *   chat.db-shm  索引。多进程共用的查找表，可重建，丢了不心疼。
 * 所以**直接手拷 chat.db 会丢数据**：主库可能滞后几分钟到几小时，
 * 那段时间的对话全在暂存本里，不在你拷走的文件里。
 * 实测（见 chat.db.diag-wal.mjs 的注释）：进程只用 process.exit(0) 退出、
 * 不 close() 数据库时，300 条插入全留在 1.2 MB 的暂存本里，主库一个字节没动。
 *
 * ── 本脚本怎么做 ──────────────────────────────────────────────────────────
 * 首选 Node 自带的 `sqlite.backup()`（SQLite 官方备份接口）：
 * 它按页复制并自动处理并发，**产出一个单一文件**，完整包含主库 + 暂存本里
 * 已提交的全部数据。不需要 -wal / -shm，因此不存在"漏拷"的问题。
 * 库正在被 agent/receiver 写入时也可以安全执行，不需要停机。
 *
 * 如果当前 Node 没有这个接口（v24.15.0 起可用），退回老办法：
 * 先做 checkpoint(TRUNCATE) 把数据钉进主库，再把三个文件一起拷走。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node scripts/backup-chat.mjs                     # 备份到 receiver/backups/
 *   node scripts/backup-chat.mjs --out D:\bak       # 指定目录
 *   node scripts/backup-chat.mjs --db path\to.db    # 指定库
 *   node scripts/backup-chat.mjs --keep 30          # 只留最近 30 份（默认 20）
 *   node scripts/backup-chat.mjs --three-files      # 强制用"checkpoint + 拷三件套"
 *
 * 备份前建议先跑一次体检：node scripts/chat.db.diag-wal.mjs
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { CHAT_DB, DATA_BACKUPS_DIR } from '../lib/paths.js'  // 数据路径唯一真源
import { openChatStore } from '../lib/chat-store.js'
// 直接拿底层连接做两件事：把备份转成单文件形态、只读校验副本。
// 不走 openChatStore，因为它的写模式会执行 `PRAGMA journal_mode = WAL`，
// 那会让备份旁边凭空多出 -wal / -shm。
const { DatabaseSync, backup: sqliteBackupApi } = await import('node:sqlite')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] || '') : '' }

// 路径来自 lib/paths.js（唯一真源）。2026-10 目录重构前它们写死在 receiver\inbox 下。
const DB_FILE = val('--db') || CHAT_DB
// 备份放 data\backups\：跟被备份的库同在 data\ 里，用户复制 data\ 时备份一起走
const OUT_DIR = val('--out') || DATA_BACKUPS_DIR
const KEEP = Math.max(1, Number(val('--keep') || 20))
const FORCE_THREE = has('--three-files')

const bytes = (n) => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'
const stamp = () => {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1) }

if (!fs.existsSync(DB_FILE)) die(`聊天库不存在：${DB_FILE}`)
fs.mkdirSync(OUT_DIR, { recursive: true })

console.log(`聊天库：${DB_FILE}`)
console.log(`备份到：${OUT_DIR}\n`)

// ── 备份前先看状态，并把结论告诉用户 ────────────────────────────────
// ⚠️ 这里必须**可写**打开（2026-10-08 实测踩坑；与 chat.db.diag-wal.mjs 是同一个坑，
//    那边 2026-10-07 修过、这里漏了）：下面那句 `PRAGMA wal_checkpoint(PASSIVE)` 是
//    **写操作** —— 它要把暂存本里的帧搬回主库。只读连接上跑它，SQLite 直接抛错
//    （实测 `disk I/O error`，errstr=disk I/O error / 也可能报 attempt to write a
//    readonly database），脚本会在**产出备份之前**就崩掉。
//    后果是最坏的那种组合：暂存本非空（有数据悬着）时才崩，暂存本为空时才跑得通 ——
//    也就是"没事时能备份、真有事时备份不了"，而用户看到旧备份还在，容易以为已经备过。
//    打开方式与正式备份那步（route A 的 openChatStore(DB_FILE)）保持一致。
const src = openChatStore(DB_FILE)
const before = src.stats()
// 预检只是为了打印帧数，不该有权力让整个备份失败：读不到就直说，备份照做
// （route A 走 SQLite 官方备份接口，本身就能带上暂存本里的数据）。
let ckBefore = null
try {
  ckBefore = src.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
} catch (e) {
  console.log(`  ⚠️ 暂存本状态读不到（${e.message}）——继续备份，不影响备份内容`)
}
src.close()

console.log(`  消息 ${before.messages} 条 / 对话 ${before.conversations} 个`)
if (ckBefore) {
  console.log(`  暂存本 ${ckBefore.log} 帧，其中已搬回主库 ${ckBefore.checkpointed} 帧`)
  if (ckBefore.log > ckBefore.checkpointed) {
    console.log(`  ⚠️ 有 ${ckBefore.log - ckBefore.checkpointed} 帧还只在暂存本里 —— 幸好本脚本会带上它们`)
  }
}

// ── 选路线 ────────────────────────────────────────────────────────────
const sqliteBackup = FORCE_THREE ? null : sqliteBackupApi

const outName = `chat-${stamp()}.db`
const outFile = path.join(OUT_DIR, outName)
let mode = ''

if (typeof sqliteBackup === 'function') {
  // 路线 A：SQLite 官方备份接口 → 单一文件，自带并发处理
  mode = 'sqlite.backup()（官方接口，单文件）'
  console.log(`\n方式：${mode}`)
  const db = openChatStore(DB_FILE)   // 需要读写连接：备份要读 WAL，也要能推进 checkpoint
  try {
    await sqliteBackup(db.db, outFile)
  } finally {
    db.close()
  }

  // 备份继承了源库的 WAL 模式，于是"打开这个备份"会要求在它旁边建 -shm / -wal。
  // 一个留档用的备份应该是自成一体的单文件，所以这里把它改回普通日志模式并压实：
  // 改完就只有 .db 一个文件，任何工具、任何只读打开都不再需要旁边那两个。
  const fix = new DatabaseSync(outFile)
  try {
    fix.exec('PRAGMA journal_mode = DELETE')
    fix.exec('VACUUM')
  } finally {
    fix.close()
  }
  console.log('  已转为单文件形态（journal_mode=DELETE + VACUUM），不依赖 -wal/-shm')
} else {
  // 路线 B：checkpoint 钉住数据，再拷三件套
  mode = 'checkpoint + 拷三件套（当前 Node 无 sqlite.backup）'
  console.log(`\n方式：${mode}`)
  const db = openChatStore(DB_FILE)
  const r = db.checkpoint()
  db.close()
  if (!r.ok) die(`checkpoint 未成功，为避免备份不完整已中止：${r.error}`)
  console.log(`  checkpoint 完成：搬回 ${r.checkpointed} 帧，暂存本已清空`)

  const parts = ['', '-wal', '-shm']
  const made = []
  for (const suf of parts) {
    const from = DB_FILE + suf
    if (!fs.existsSync(from)) continue          // checkpoint 之后 -wal/-shm 可能已被清掉
    const to = path.join(OUT_DIR, outName + suf)
    fs.copyFileSync(from, to)
    // copyFileSync 会连着源文件的修改时间一起复制，让备份看起来像几天前的旧文件。
    // 备份的"时间"应该是它被创建的时间，这里显式改回来。
    const now = new Date()
    try { fs.utimesSync(to, now, now) } catch {}
    made.push(path.basename(to))
  }
  console.log(`  已拷贝 ${made.length} 个文件：${made.join('、')}`)
}

// ── 校验副本：能打开、行数对得上、结构完整 ─────────────────────────────
const verify = new DatabaseSync(outFile, { readOnly: true })
const one = (sql) => Number(verify.prepare(sql).get().n || 0)
const after = {
  messages: one('SELECT COUNT(*) AS n FROM messages'),
  conversations: one('SELECT COUNT(*) AS n FROM conversations'),
  events: one('SELECT COUNT(*) AS n FROM events'),
}
const integrity = verify.prepare('PRAGMA integrity_check').get()
const integrityOk = String(Object.values(integrity || {})[0] || '').toLowerCase() === 'ok'
verify.close()

const size = fs.statSync(outFile).size
console.log(`\n备份完成：${outName}（${bytes(size)}）`)
console.log(`  校验：消息 ${after.messages} / 对话 ${after.conversations} / 事件 ${after.events}`)
console.log(`  完整性检查：${integrityOk ? 'ok' : `异常（${JSON.stringify(integrity)}）`}`)

let exitCode = 0
if (after.messages !== before.messages) {
  console.error(`  ❌ 条数不一致：源 ${before.messages}，副本 ${after.messages} —— 备份期间可能有写入，请重跑`)
  exitCode = 1
} else {
  console.log('  ✅ 条数与源库一致')
}
if (!integrityOk) { console.error('  ❌ 副本完整性检查未通过'); exitCode = 1 }

// ── 轮转：只保留最近 KEEP 份 ───────────────────────────────────────────
const mine = fs.readdirSync(OUT_DIR).filter((f) => /^chat-\d{8}-\d{6}\.db/.test(f))
const groups = new Map()
for (const f of mine) {
  const key = f.match(/^chat-\d{8}-\d{6}\.db/)[0]
  const a = groups.get(key) || []; a.push(f); groups.set(key, a)
}
const keys = [...groups.keys()].sort().reverse()
let removed = 0
for (const k of keys.slice(KEEP)) {
  for (const f of groups.get(k)) { try { fs.unlinkSync(path.join(OUT_DIR, f)); removed++ } catch {} }
}
console.log(`\n现有备份 ${Math.min(keys.length, KEEP)} 份（保留上限 ${KEEP}${removed ? `，本次清理 ${removed} 个旧文件` : ''}）`)

process.exit(exitCode)
