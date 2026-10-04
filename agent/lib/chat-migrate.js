/**
 * 一次性迁移：JSONL 三件套 → SQLite（2026-10-02 方案 B）。
 *
 * 输入（receiver/inbox/）：
 *   chat_input.jsonl        用户消息（提问/指令）
 *   chat_output.jsonl       AI 回复 + 流式快照 + system + graph-hit（快照全部丢弃，占旧文件 97% 字节）
 *   .chat_input_replied     去重台账（旧格式碎片 or 新格式 JSON 行）→ 只用来回填 status/attempts
 * 输出：chat.db（+ agent/data/replay-unanswered.json：2026-09-28 那次重放里"从未被回答"的消息清单，
 *       仅供用户日后决定是否补答；迁移默认不改变现状，不会自动重答）
 *
 * 状态口径（与旧系统对齐，避免迁移带来行为突变）：
 *   · 有成功回答（配对到 assistant/system，且不是 ⚠️ 失败气泡）→ status='ok'
 *   · 无回答但台账里有记录（= 当年"试过"）        → status='ok'（保持现状：不重发、也不补答）
 *   · 无回答且台账里没有记录（= 从没处理过）      → status='pending'（补答，这是队列本来的语义）
 * 想改口径可用 --requeue-replay 把 replay-unanswered.json 里的消息改成 'failed'（可重试）。
 *
 * 幂等：库里已有消息时默认拒绝执行（--force 覆盖）。
 */

import fs from 'fs'
import path from 'path'
import { loadFingerprints } from './inbox-dedupe.js'

const readLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) } catch { return [] }
}
const parse = (line) => { try { return JSON.parse(line) } catch { return null } }
const countOccurrences = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0)

/**
 * @param {object} o
 * @param {string} o.inboxDir
 * @param {import('./chat-store.js').ChatStore} o.store
 * @param {string} [o.agentDir] 读取自由对话注册表（标题/归档状态）
 * @param {(msg: string) => void} [o.log]
 * @param {boolean} [o.dryRun] 只统计不写库
 */
export function migrateJsonlToStore({ inboxDir, store, agentDir, log = () => {}, dryRun = false }) {
  const chatIn = path.join(inboxDir, 'chat_input.jsonl')
  const chatOut = path.join(inboxDir, 'chat_output.jsonl')
  const ledger = path.join(inboxDir, '.chat_input_replied')

  if (!dryRun && store.stats().messages > 0) {
    throw new Error('库里已有消息：迁移会重复导入。确认要重导请先清空 chat.db（或加 --force）')
  }

  const users = readLines(chatIn).map(parse).filter(Boolean)
  log(`chat_input：${users.length} 条用户消息`)

  // ── 台账：哪些消息当年被处理过（并识别 2026-09-28 重放重复追加的那一批） ──
  const ledgerRaw = (() => { try { return fs.readFileSync(ledger, 'utf8') } catch { return '' } })()
  // 重放检测要用**迁移前**的备份：2026-09-30 那次启动已经把在线台账重写成 444 条唯一记录，
  // 重复追加的痕迹只留在 .bak-fp-migrate 里（有则用，没有就退回在线文件）。
  const ledgerForReplay = (() => {
    try { return fs.readFileSync(ledger + '.bak-fp-migrate', 'utf8') } catch { return ledgerRaw }
  })()
  const { states: ledgerStates, stats: ledgerStats } = loadFingerprints(ledgerRaw, users)
  const fingerprintOf = (m) => `${m.timestamp || 0}|${String(m.content || '').slice(0, 80)}`
  const replayed = new Set()
  for (const m of users) {
    const fp = fingerprintOf(m)
    // 用指纹"首行"在原文里数出现次数：新旧两种台账格式都成立（首行本身不含换行，JSON 里不会转义）
    if (countOccurrences(ledgerForReplay, fp.split('\n')[0]) >= 2) replayed.add(m.timestamp)
  }
  log(`台账：旧行 ${ledgerStats.legacy} 条 → 解析出 ${ledgerStates.size} 条记录；检出台账里被重复追加（= 2026-09-28 重放）的指纹 ${replayed.size} 条`)

  // ── 输出：只取"真正的记录"，丢掉 97% 的流式快照 ──
  const outLines = readLines(chatOut).map(parse).filter(Boolean)
  const finals = []
  const events = []
  let snapshots = 0
  for (const d of outLines) {
    if (typeof d._stream === 'number') { snapshots++; continue }        // 流式快照/结束标记：丢弃
    if (d.role === 'graph-hit') { events.push(d); continue }
    if (!String(d.content || '').trim()) continue
    finals.push(d)
  }
  log(`chat_output：${outLines.length} 行 → 丢弃流式快照 ${snapshots} 条，保留回答/系统消息 ${finals.length} 条，事件 ${events.length} 条`)

  // ── 配对（旧规则：user 之后、下一条 user 之前的第一条回答；⚠️ 失败气泡不算回答）──
  // 先在**同一对话内**配对（旧文件时代的全局规则会被"中途切书"打断：问 A 书 → 问 B 书 →
  // A 的回答才到，全局规则就配不上 A 了），未归属书（无 bookKey）的旧回答再做一次全局回退。
  const convOfMsg = (m) => {
    const raw = String(m.bookId || m.bookKey || '')
    return raw ? raw.replace(/k[0-9a-f]{16,}$/i, '') : '_common'
  }
  const pairWithin = (us, outs) => {
    const timeline = [
      ...us.map((m, i) => ({ kind: 'user', ts: Number(m.timestamp) || 0, ord: i, m })),
      ...outs.map((m, i) => ({ kind: 'out', ts: Number(m.timestamp) || 0, ord: i, m })),
    ].sort((a, b) => (a.ts - b.ts) || (a.kind === b.kind ? a.ord - b.ord : (a.kind === 'user' ? -1 : 1)))
    const pairs = new Map()
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].kind !== 'user') continue
      for (let j = i + 1; j < timeline.length; j++) {
        if (timeline[j].kind === 'user') break
        const c = String(timeline[j].m.content || '')
        if (!c.trim() || /^⚠️/.test(c)) continue
        pairs.set(timeline[i].m, timeline[j].m)
        break
      }
    }
    return pairs
  }
  const byConvUsers = new Map()
  for (const u of users) {
    const k = convOfMsg(u)
    if (!byConvUsers.has(k)) byConvUsers.set(k, [])
    byConvUsers.get(k).push(u)
  }
  const byConvOuts = new Map()
  for (const r of finals) {
    const k = convOfMsg(r)
    if (!byConvOuts.has(k)) byConvOuts.set(k, [])
    byConvOuts.get(k).push(r)
  }
  const replyOfUser = new Map()
  const usedReplies = new Set()
  for (const [k, us] of byConvUsers) {
    for (const [u, r] of pairWithin(us, byConvOuts.get(k) || [])) { replyOfUser.set(u, r); usedReplies.add(r) }
  }
  // 全局回退：只用于"没有 bookKey"的旧回答 + 还没配上回答的提问
  const leftoverUsers = users.filter((u) => !replyOfUser.has(u))
  const leftoverOuts = finals.filter((r) => !usedReplies.has(r) && !r.bookKey)
  if (leftoverUsers.length && leftoverOuts.length) {
    for (const [u, r] of pairWithin(leftoverUsers, leftoverOuts)) { replyOfUser.set(u, r); usedReplies.add(r) }
  }

  // ── 写库 ──
  const idByUserTs = new Map()
  let insertedUsers = 0, insertedReplies = 0, okCount = 0, pendingCount = 0, orphanCount = 0
  const unanswered = []

  if (!dryRun) store.db.exec('BEGIN')
  try {
    for (const u of users) {
      const conv = convOfMsg(u)
      const fp = fingerprintOf(u)
      const reply = replyOfUser.get(u)
      const known = ledgerStates.has(fp)
      const status = reply ? 'ok' : (known ? 'ok' : 'pending')
      if (status === 'pending') pendingCount++; else okCount++
      const id = dryRun ? -(insertedUsers + 1) : store.insertMessage({
        conv, role: 'user', content: String(u.content || ''), ts: Number(u.timestamp) || 0,
        status, attempts: known ? 1 : 0,
        bookId: u.bookId, bookTitle: u.bookTitle, chapter: u.chapter, chapterUid: u.chapterUid,
        selectedText: u.selectedText, refs: Array.isArray(u.refs) ? u.refs : undefined,
      })
      insertedUsers++
      idByUserTs.set(Number(u.timestamp), id)
      // 从未得到过任何回答的提问（没有配对回答）——单独留清单，供日后决定是否补答。
      // 注意口径：2026-09-28 重放失败的 213 条**不属于**这一类——它们当年都被正常回答过，
      // 只是重放时的"再答一次"失败了（失败气泡已清理）。这里统计"一次都没答过"的。
      if (!reply) {
        unanswered.push({ id, conv, ts: Number(u.timestamp), replayed: replayed.has(Number(u.timestamp)), content: String(u.content || '').slice(0, 120) })
      }
    }
    for (const [u, reply] of replyOfUser) {
      const uid = idByUserTs.get(Number(u.timestamp))
      const failed = /^⚠️/.test(String(reply.content || ''))
      if (!dryRun) store.insertMessage({
        conv: convOfMsg(u), role: reply.role === 'system' ? 'system' : 'assistant',
        content: String(reply.content || ''), ts: Number(reply.timestamp) || 0,
        status: failed ? 'failed' : 'ok', replyTo: uid,
        error: failed ? String(reply.content || '').slice(0, 200) : undefined,
      })
      insertedReplies++
    }
    // 孤儿回答（提问已被删掉的旧回复）也入库，reply_to 留空——迁移不丢数据
    for (const r of finals) {
      if (usedReplies.has(r)) continue
      orphanCount++
      if (!dryRun) store.insertMessage({
        conv: convOfMsg(r),
        role: r.role === 'system' ? 'system' : 'assistant',
        content: String(r.content || ''), ts: Number(r.timestamp) || 0, status: 'ok',
      })
    }
    if (!dryRun) {
      for (const e of events) {
        store.insertEvent({ ts: Number(e.timestamp) || 0, conv: String(e.bookKey || ''), kind: 'graph-hit', payload: { hits: e.hits || [], reason: e.reason || '' } })
      }
      // 对话表：先由消息导出，再用自由对话注册表补标题/状态
      for (const conv of new Set([...users.map(convOfMsg), ...events.map((e) => String(e.bookKey || ''))])) {
        if (conv) store.upsertConversation(conv, { updatedAt: Date.now() })
      }
      try {
        const regFile = path.join(agentDir || '', 'data', 'free-conversations.json')
        const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'))
        for (const c of reg.conversations || []) {
          store.upsertConversation(c.key, {
            title: c.title || '', status: c.status || 'active',
            createdAt: c.createdAt, updatedAt: c.updatedAt, archivedAt: c.archivedAt,
            archiveMemory: !!(c.archive && c.archive.memory), archiveGraph: !!(c.archive && c.archive.graph),
            note: c.note || '',
          })
        }
      } catch {}
      store.setMeta('migrated_from_jsonl_at', String(Date.now()))
      store.setMeta('migrated_stats', JSON.stringify({ users: insertedUsers, replies: insertedReplies, events: events.length, droppedSnapshots: snapshots, pending: pendingCount }))
      store.db.exec('COMMIT')
      store.checkpoint()
    }
  } catch (e) {
    if (!dryRun) { try { store.db.exec('ROLLBACK') } catch {} }
    throw e
  }

  const summary = {
    users: insertedUsers, replies: insertedReplies, events: events.length,
    droppedSnapshots: snapshots, pending: pendingCount, ledgerKnown: okCount,
    orphanReplies: orphanCount, replayed: replayed.size, unanswered: unanswered.length,
  }
  log(`导入：用户消息 ${insertedUsers} 条（pending ${pendingCount} / 已处理 ${okCount}）、回答 ${insertedReplies} 条（孤儿回答 ${orphanCount} 条）、事件 ${events.length} 条；丢弃快照 ${snapshots} 条`)
  if (!dryRun && agentDir && unanswered.length) {
    try {
      const f = path.join(agentDir, 'data', 'unanswered-messages.json')
      fs.writeFileSync(f, JSON.stringify({
        note: '迁移时发现"从未得到过任何回答"的提问（一次都没答过）。默认保持现状（不补答）；'
          + '要补答：把它们的 status 改成 failed 即可（agent 启动后会重试）：'
          + "UPDATE messages SET status='failed' WHERE id IN (...)",
        generatedAt: Date.now(), count: unanswered.length, messages: unanswered,
      }, null, 2) + '\n')
      log(`另存：${f}（${unanswered.length} 条从未被回答的提问，默认不补答）`)
    } catch {}
  }
  return summary
}

/** 导出回旧 JSONL 形态（兼容老脚本 / 人工查看）：只导出最终消息，不含流式快照。 */
export function exportStoreToJsonl({ store, outDir, log = () => {} }) {
  const rows = store.listMessages({})
  const userLines = []
  const outLines = []
  for (const m of rows) {
    if (m.role === 'user') {
      userLines.push(JSON.stringify({
        role: 'user', content: m.content, timestamp: m.timestamp, bookId: m.bookId,
        bookTitle: m.bookTitle, chapter: m.chapter, chapterUid: m.chapterUid,
        selectedText: m.selectedText, ...(m.refs ? { refs: m.refs } : {}), ...(m.payload || {}),
      }))
    } else {
      outLines.push(JSON.stringify({
        role: m.role, content: m.content, timestamp: m.timestamp, bookKey: m.conv,
        ...(m.status === 'failed' ? { failed: true } : {}),
      }))
    }
  }
  const inFile = path.join(outDir, 'chat_input.export.jsonl')
  const outFile = path.join(outDir, 'chat_output.export.jsonl')
  fs.writeFileSync(inFile, userLines.length ? userLines.join('\n') + '\n' : '')
  fs.writeFileSync(outFile, outLines.length ? outLines.join('\n') + '\n' : '')
  log(`已导出：${inFile}（${userLines.length} 行）、${outFile}（${outLines.length} 行）`)
  return { inFile, outFile, users: userLines.length, outputs: outLines.length }
}
