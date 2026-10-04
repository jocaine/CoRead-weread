#!/usr/bin/env node
/**
 * 自由模式多对话 · receiver 端点端到端自测（2026-11 用户定调）
 *
 * 用一个**临时端口**的 receiver 实例跑（不碰正在运行的那一个），验证：
 *   GET  /free-conversations  → 清单结构（current/active/archived）+ 默认对话自动补登记
 *   POST /free-conversations  → create / rename / delete 三个动作
 *   POST /free-archive        → 归档请求按 agent 协议入库为一条待处理消息（content=/归档
 *                                + archive 勾选项），消息计数/标题兜底与真实落库一致
 *
 * 数据安全：备份 agent/data/free-conversations.json 并**只清理本次新建**的对话条目；
 * 聊天库里本次写入的消息在结束时删掉（按时间戳精确匹配），不留测试残留。
 *
 * 运行（脚本自己拉一个临时端口的 receiver；POSIX 下子进程被回收时会自己收尾）：
 *   node scripts/selftest-free-conversations.mjs
 * 或先手动起一个隔离实例，再把地址传进来（Windows 上子进程回收不可靠时用这个）：
 *   $env:COREAD_PORT=7241; node receiver/index.js      # 另一个终端
 *   node scripts/selftest-free-conversations.mjs http://127.0.0.1:7241
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { openChatStore } from '../lib/chat-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')            // = <repo>/agent
const REPO = path.join(ROOT, '..')                 // = <repo>
const REGISTRY = path.join(ROOT, 'data', 'free-conversations.json')
const CHAT_DB = path.join(REPO, 'receiver', 'inbox', 'chat.db')
function messageCount(dbFile) {
  try { const s = openChatStore(dbFile, { readonly: true }); const n = s.stats().messages; s.close(); return n } catch { return 0 }
}
function readPendingRows(dbFile) {
  try {
    const s = openChatStore(dbFile, { readonly: true })
    const rows = s.db.prepare("SELECT * FROM messages WHERE role='user' ORDER BY id DESC LIMIT 3").all()
    s.close()
    return rows.reverse()
  } catch { return [] }
}
const PORT = 7241
const EXTERNAL = process.argv[2] || ''   // 传入地址 = 复用外部已起的隔离实例（脚本不再自己 spawn）

let pass = 0, fail = 0
function check(cond, label) {
  if (cond) { pass++; console.log('  ✔ ' + label) }
  else { fail++; console.log('  ✖ ' + label) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 扩展页来源指纹：receiver 的 originAllowed 只放行 chrome-extension:// 或"无 Origin + cors/empty"
const HEAD = { 'Content-Type': 'application/json', Origin: 'chrome-extension://selftest', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }
const base = EXTERNAL || `http://127.0.0.1:${PORT}`

async function req(method, url, body) {
  const r = await fetch(base + url, { method, headers: HEAD, ...(body ? { body: JSON.stringify(body) } : {}) })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json }
}

const registryBackup = fs.existsSync(REGISTRY) ? fs.readFileSync(REGISTRY, 'utf8') : null
const createdKeys = []
const sentTimestamps = []

function restore() {
  // 清理本次新建的对话条目（其余原有条目原样保留）；注册表原本不存在则删掉
  try {
    if (registryBackup !== null) {
      fs.writeFileSync(REGISTRY, registryBackup)
    } else if (fs.existsSync(REGISTRY)) {
      fs.unlinkSync(REGISTRY)
      try { fs.unlinkSync(REGISTRY + '.bak') } catch {}
    }
  } catch (e) { console.log('  ⚠️ 注册表恢复失败: ' + e.message) }
  // 清掉本次写入的消息（2026-10-02 方案 B：消息在聊天库里，按时间戳精确删行——
  // 不再重写 chat_input.jsonl；那次"原地重写 + 300ms 轮询撞上截断空窗"正是 09-28 重放的起点）
  try {
    if (sentTimestamps.length && fs.existsSync(CHAT_DB)) {
      const store = openChatStore(CHAT_DB)
      const ids = store.db.prepare(
        `SELECT id FROM messages WHERE ts IN (${sentTimestamps.map(() => '?').join(',')})`,
      ).all(...sentTimestamps).map((r) => Number(r.id))
      const removed = store.deleteMessages(ids)
      store.close()
      if (removed) console.log(`  （自测清理：删掉本次写入的 ${removed} 条消息）`)
    }
  } catch (e) { console.log('  ⚠️ 消息清理失败: ' + e.message) }
}

const child = EXTERNAL ? null : spawn(process.execPath, [path.join(REPO, 'receiver', 'index.js')], {
  env: { ...process.env, COREAD_PORT: String(PORT) },
  stdio: 'ignore',
})

try {
  // 等接收端起监听
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(150)
    try { const r = await fetch(base + '/free-conversations', { headers: HEAD }); up = r.ok } catch {}
  }
  if (!up) throw new Error(`临时 receiver 未能在 ${PORT} 起来`)
  console.log(`\n临时 receiver 就绪（端口 ${PORT}）\n`)

  // ── ① 首次拉清单：默认对话自动补登记 ──
  console.log('① GET /free-conversations（默认对话自动补登记）')
  const l0 = await req('GET', '/free-conversations')
  check(l0.status === 200, 'HTTP 200')
  check(Array.isArray(l0.json.active) && Array.isArray(l0.json.archived), '返回 active / archived 两个数组')
  const legacy = (l0.json.active || []).find((c) => c.key === '__coread_free_mode__')
  check(!!legacy, '默认对话（历史哨兵 __coread_free_mode__）已在活动清单')
  check(l0.json.current === (l0.json.active[0] || {}).key, 'current = 最近活跃的一场')
  check(typeof legacy.messages === 'number' && typeof legacy.lastAt === 'number', '条目带 messages / lastAt')

  // ── ② 新建对话 ──
  console.log('\n② POST /free-conversations { action: create }')
  const c1 = await req('POST', '/free-conversations', { action: 'create' })
  check(c1.status === 200 && /^__coread_free_[0-9a-f]{8}__$/.test(c1.json.key || ''), '新建返回合法 key：' + (c1.json && c1.json.key))
  createdKeys.push(c1.json.key)
  const c2 = await req('POST', '/free-conversations', { action: 'create' })
  createdKeys.push(c2.json.key)
  check(c1.json.key !== c2.json.key, '两次新建 key 不重复')

  const l1 = await req('GET', '/free-conversations')
  check(l1.json.active.length === l0.json.active.length + 2, `活动清单 +2（${l0.json.active.length} → ${l1.json.active.length}）`)
  check(l1.json.active.every((c) => c.status === 'active'), '清单里没有归档态条目')

  // ── ③ 讲话：消息计数与标题兜底 ──
  console.log('\n③ POST /chat（自由对话归属 + 标题兜底 + 计数）')
  const chat = await req('POST', '/chat', { content: '哥萨克为什么在革命中立场复杂？', bookId: c1.json.key, bookTitle: '新对话' })
  check(chat.status === 200 && chat.json.ok, '提问落库成功')
  sentTimestamps.push(chat.json.timestamp)
  const l2 = await req('GET', '/free-conversations')
  const conv1 = l2.json.active.find((c) => c.key === c1.json.key)
  check(conv1.messages === 1, `该对话消息计数 = 1（实际 ${conv1 && conv1.messages}）`)
  check(conv1.title === '哥萨克为什么在革命中立场复杂？', '标题用首条提问兜底：' + (conv1 && conv1.title))
  check(l2.json.active[0].key === c1.json.key, '刚说话的对话排到最前（最近活跃排序）')

  // ── ④ 改名 ──
  console.log('\n④ POST /free-conversations { action: rename }')
  const rn = await req('POST', '/free-conversations', { action: 'rename', key: c1.json.key, title: '哥萨克问题' })
  check(rn.status === 200 && rn.json.conversation.title === '哥萨克问题', '改名生效')
  const l3 = await req('GET', '/free-conversations')
  check(l3.json.active.find((c) => c.key === c1.json.key).title === '哥萨克问题', '清单里标题已更新')
  const bad = await req('POST', '/free-conversations', { action: 'rename', key: 'nope', title: 'x' })
  check(bad.status === 404, '非法 key 改名 → 404')

  // ── ⑤ 归档入队（agent 协议）──
  console.log('\n⑤ POST /free-archive（归档请求按 agent 协议入队）')
  const beforeLines = messageCount(CHAT_DB)
  const ar = await req('POST', '/free-archive', { key: c2.json.key, memory: true, graph: true })
  check(ar.status === 200 && ar.json.ok, '归档请求入队成功')
  sentTimestamps.push(ar.json.timestamp)
  const rows = readPendingRows(CHAT_DB)
  check(messageCount(CHAT_DB) === beforeLines + 1, '聊天库追加 1 条消息')
  const entry = rows[rows.length - 1] || {}
  check(entry.content === '/归档', 'content = /归档（agent 轮询识别的指令）')
  check(entry.conv === c2.json.key, 'conv = 被归档对话的 key（agent 据此定位对话）')
  const payload = entry.payload ? JSON.parse(entry.payload) : {}
  check(payload.archive && payload.archive.memory === true && payload.archive.graph === true, 'archive 勾选项原样传递 memory/graph')
  check(payload.archive && payload.archive.key === c2.json.key, 'archive.key 与 conv 一致')
  const badAr = await req('POST', '/free-archive', { key: 'ee442b83643425f', memory: true })
  check(badAr.status === 400, '非自由 key 归档 → 400（不会误归档真实书）')

  // ── ⑥ 删除对话 ──
  console.log('\n⑥ POST /free-conversations { action: delete }')
  const del = await req('POST', '/free-conversations', { action: 'delete', key: c1.json.key })
  check(del.status === 200 && del.json.ok, '删除成功')
  check(del.json.removed.input === 1, `该对话的提问一并清掉（input×${del.json.removed.input}）`)
  const l4 = await req('GET', '/free-conversations')
  check(!l4.json.active.some((c) => c.key === c1.json.key), '清单里不再有它')
  const badDel = await req('POST', '/free-conversations', { action: 'delete', key: 'x' })
  check(badDel.status === 400, '非法 key 删除 → 400')
  const badAction = await req('POST', '/free-conversations', { action: 'wat' })
  check(badAction.status === 400, '未知 action → 400')

  // ── ⑦ 来源限制 ──
  console.log('\n⑦ 来源限制（任意网页不可读写本地数据）')
  const noOrigin = await fetch(base + '/free-conversations')
  check(noOrigin.status === 403, '无扩展来源指纹 → 403')
} catch (e) {
  fail++
  console.log('\n✖ 自测异常: ' + e.message)
} finally {
  try { if (child) child.kill() } catch {}
  await sleep(300)
  restore()
  console.log(`\n结果：pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
}
