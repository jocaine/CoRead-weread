#!/usr/bin/env node
/**
 * CoRead 本地接收端
 * 监听来自 Chrome 扩展的标注、正文、章节事件，写入本地文件。
 * 启动：node receiver/index.js
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { GRAPH_FILE, FREE_GRAPH_FILE, readGraphFile, readFreeGraphFile, buildDemoGraph } from './graph-data.js'  // AI-020：会意图图数据
import { writeApiConfig, validateApiConfigInput, resolveApiConfig, isConfigured } from '../agent/lib/api-config.js'  // 模型 API 配置（侧栏「⋯」入口的读写端）
// 自由模式多对话（2026-11 用户定调）：对话注册表（新建 / 列表 / 重命名 / 删除 + 消息计数）。
// agent 在归档时写同一份注册表（留墓碑记录），两边都用同一个 lib 保证读写口径一致。
import {
  isFreeKey, readRegistry, createConversation, ensureLegacyConversation,
  renameConversation, dropConversation, deleteConversationMessages, touchConversation,
  activeConversations, archivedConversations, findConversation, freeConversationFile,
} from '../agent/lib/free-conversation.js'
// 存档整文件重写一律原子替换（2026-09-30）：agent 每 300ms 轮询读 chat_input/annotations，
// 原地 writeFileSync 的"先截断再写"空窗会让它读到 0 行 → 游标归零 → 全量重放（2026-09-28 实例）
import { writeFileAtomic } from '../agent/lib/atomic-write.js'
// 聊天存储（2026-10-02 方案 B）：消息改存 SQLite（agent 与 receiver 共用同一个库，
// WAL 下可同时读写）。旧 chat_input/chat_output.jsonl 迁移后只作备份，不再读写。
import { openChatStore } from '../agent/lib/chat-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = path.join(__dirname, '..', 'agent')
const PORT = parseInt(process.env.COREAD_PORT || '7239')
const BOOKS_DIR = path.join(__dirname, 'books')
const INBOX_DIR = path.join(__dirname, 'inbox')
const CHAT_DB = path.join(INBOX_DIR, 'chat.db')          // 聊天库（方案 B：唯一真源，agent 共用）
const STREAM_FILE = path.join(INBOX_DIR, 'stream.jsonl') // 瞬态打字机通道（agent 写，不入档）
const AGENT_STATE_FILE = path.join(INBOX_DIR, 'agent_state.jsonl')  // agent 处理步骤（2026-10：侧栏"正在…"文案）
const DEBUG_LOG = path.join(INBOX_DIR, 'debug.jsonl')
const TOPIC_STACK_FILE = path.join(__dirname, '..', 'agent', 'topic_stack.json')  // 实时讨论栈（/stack-hits 与 stack-updated 轮询的数据源，2026-09）
const TOOLBOX_DIR = path.join(__dirname, 'toolbox')  // 翻译记录（工具箱「贴回本页译文」的数据源）
const TOOL_HISTORY = path.join(TOOLBOX_DIR, 'history.jsonl')

fs.mkdirSync(BOOKS_DIR, { recursive: true })
fs.mkdirSync(INBOX_DIR, { recursive: true })
fs.mkdirSync(TOOLBOX_DIR, { recursive: true })

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set()

// 事件缓冲区：带递增 _seq，用于断点续传
let _eventSeq = 0
const recentEvents = []  // [{ type, ...data, _seq }]
const MAX_RECENT = 100

function pushSSE(type, data) {
  _eventSeq++
  // payloadData 同时作为断点续传缓冲条目：含 _seq，客户端据此记录进度，
  // 重连后只重放 _seq > lastId 的事件（AI-006）。
  const payloadData = { type, ...data, _seq: _eventSeq }
  recentEvents.push(payloadData)
  if (recentEvents.length > MAX_RECENT) recentEvents.shift()
  if (sseClients.size === 0) return
  const payload = `id: ${_eventSeq}\ndata: ${JSON.stringify(payloadData)}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
}

// 初始化推送水位线：消息用库里的自增 id（只推新行，不重读历史），
// 流式通道用字节偏移（文件按累计文本追加，可随时被 agent 清空）。
let _store = null
function chatStore() {
  if (!_store) _store = openChatStore(CHAT_DB)
  return _store
}
/**
 * 退出前关掉聊天库。**每次退出都必须走这里。**
 * 为什么：SQLite 在最后一个连接正常 close() 时，会自动把暂存本（-wal）搬回主库、
 * 并删掉 -wal 与 -shm。不 close 直接退出的话这两个文件会一直留着，主库停在旧版本。
 * 数据不会因此损坏（下次连接会自动恢复），但"干净退出"这道安全网就失效了。
 */
function closeChatStore() {
  if (!_store) return
  try { _store.close() } catch (e) { console.error(`⚠️ 关闭聊天库失败：${e.message}`) }
  _store = null
}
let chatLastMessageId = (() => { try { return chatStore().lastMessageId() } catch { return 0 } })()
let chatLastEventId = (() => { try { return chatStore().lastEventId() } catch { return 0 } })()
let streamOffset = (() => { try { return fs.statSync(STREAM_FILE).size } catch { return 0 } })()
// agent 处理步骤游标（agent_state.jsonl）：跳过已有内容，只推送新步骤（2026-10）
let agentStateLastLine = (() => {
  try { return fs.readFileSync(AGENT_STATE_FILE, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 }
})()

// 每 100ms 轮询一次，推给所有 SSE 客户端：
//   ① 聊天库：id > 水位线的新消息（替代旧"整读 63MB chat_output 再按行数切片"，
//      旧做法 40 小时烧了约 2700 秒 CPU）；
//   ② 瞬态流式通道：按字节偏移 tail（打字机效果），文件被清空时按"长度回缩"复位；
//   ③ 处理步骤 agent_state.jsonl：按行数增量。
setInterval(() => {
  try {
    const store = chatStore()
    const fresh = store.listMessages({ sinceId: chatLastMessageId })
    if (fresh.length) {
      chatLastMessageId = fresh[fresh.length - 1].id
      for (const m of fresh) {
        pushSSE('message', {
          role: m.role, content: m.content, timestamp: m.timestamp, bookKey: m.conv,
          ...(m.status === 'failed' ? { failed: true } : {}),
        })
      }
    }
    // 图命中事件（events 表）：侧栏图视图据此高亮，不渲染为消息气泡
    const events = store.listEvents({ sinceId: chatLastEventId, limit: 50 })
    if (events.length) {
      chatLastEventId = events[events.length - 1].id
      for (const e of events) {
        if (e.kind !== 'graph-hit') continue
        pushSSE('message', {
          role: 'graph-hit', hits: (e.payload && e.payload.hits) || [],
          reason: (e.payload && e.payload.reason) || '', timestamp: e.ts, bookKey: e.conv,
        })
      }
    }
  } catch {}
  // 瞬态流式通道（打字机）：只读新增字节，不整读文件
  try {
    const size = fs.statSync(STREAM_FILE).size
    if (size < streamOffset) streamOffset = 0        // agent 启动时清空过 → 从头读
    if (size > streamOffset) {
      const fd = fs.openSync(STREAM_FILE, 'r')
      const buf = Buffer.alloc(size - streamOffset)
      const read = fs.readSync(fd, buf, 0, buf.length, streamOffset)
      fs.closeSync(fd)
      const text = buf.slice(0, read).toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      // 只处理完整行；半行留到下一轮（offset 不推进到最后一行之后）
      if (lastNl >= 0) {
        streamOffset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.trim()) continue
          try { pushSSE('message', JSON.parse(line)) } catch {}
        }
      }
    }
  } catch {}
  // agent 处理步骤（agent_state.jsonl）→ SSE type=agent-state：侧栏思考气泡按步骤换文案。
  // agent 端裁剪重写会让行数回缩 → 游标复位（旧行不回放——状态是瞬态的，只关心当轮）
  try {
    const sl = fs.readFileSync(AGENT_STATE_FILE, 'utf8').trim().split('\n').filter(Boolean)
    if (sl.length < agentStateLastLine) agentStateLastLine = sl.length
    if (sl.length > agentStateLastLine) {
      const freshState = sl.slice(agentStateLastLine)
      agentStateLastLine = sl.length
      for (const line of freshState) {
        try { pushSSE('agent-state', JSON.parse(line)) } catch {}
      }
    }
  } catch {}
}, 100)

// AI-020：会意图图文件变化轮询（3s 一次 stat）→ mtime 变化时 SSE graph-updated，
// 侧栏图视图开着就自动重拉（图由会意系统固化到 agent/data/knowledge-graph.json）。
// 自由模式沙盒图（knowledge-graph.free.json）单独轮询：测试固化也实时通知，
// 图视图保持当前模式（正式/自由）重拉。
let _graphFileMtime = 0
let _freeGraphFileMtime = 0
setInterval(() => {
  let m = 0
  try { m = fs.statSync(GRAPH_FILE).mtimeMs } catch {}
  if (m > 0 && m !== _graphFileMtime) {
    _graphFileMtime = m
    pushSSE('graph-updated', {})
  }
  let fm = 0
  try { fm = fs.statSync(FREE_GRAPH_FILE).mtimeMs } catch {}
  if (fm > 0 && fm !== _freeGraphFileMtime) {
    _freeGraphFileMtime = fm
    pushSSE('graph-updated', { free: true })
  }
}, 3000)

// 实时讨论栈变化轮询（3s stat agent/topic_stack.json）→ mtime 变化时 SSE
// stack-updated：侧栏据此重拉 /stack-hits，恢复/清除"当前讨论命中"高亮
//（2026-09 用户定调：命中 = 当前实时栈 cites 的节点脉络，栈结束即命中结束）。
let _stackFileMtime = 0
setInterval(() => {
  let m = 0
  try { m = fs.statSync(TOPIC_STACK_FILE).mtimeMs } catch {}
  if (m > 0 && m !== _stackFileMtime) {
    _stackFileMtime = m
    pushSSE('stack-updated', {})
  }
}, 3000)

// 自由对话注册表变化轮询（3s stat agent/data/free-conversations.json）→ SSE
// free-conversations-updated：侧栏对话条/对话列表实时刷新。**归档是 agent 写的**
//（它要顺手做记忆合并与收口固化），只靠 receiver 自己的写点通知不到侧栏——
// 所以这里像图文件那样盯 mtime，收发两侧谁写都能推。
let _freeConvFileMtime = 0
setInterval(() => {
  let m = 0
  try { m = fs.statSync(freeConversationFile(AGENT_DIR)).mtimeMs } catch {}
  if (m > 0 && m !== _freeConvFileMtime) {
    _freeConvFileMtime = m
    pushSSE('free-conversations-updated', {})
  }
}, 3000)

function bookDir(bookId) {
  // 归一化：去掉微信读书的 k-suffix 会话变体，一本书只对应一个目录。
  // 再做路径安全化：即使 bookId 夹带 '..' / 分隔符，落点仍在 BOOKS_DIR 内
  // （空结果回退 '_invalid'，不塌缩到根目录）。
  const normalized = sanitizePathPart(baseBookId(bookId)) || '_invalid'
  const d = path.join(BOOKS_DIR, normalized)
  fs.mkdirSync(path.join(d, 'chapters'), { recursive: true })
  return d
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

// 路径安全化：只保留字母数字、下划线、连字符，剥离路径分隔符、点与 '..'，
// 杜绝 bookId/chapterUid 夹带路径穿越（评审 P1）。微信读书的 bookId 与章节
// 文件名只用到这些字符，不影响正常目录/文件名。
function sanitizePathPart(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
}

// GET 数据接口只允许扩展来源调用：阻止任意网页触发本地端扫描/建目录/读数据。
// 扩展页面因 host_permissions 绕过 CORS，请求不带 Origin 头（实测 Sec-Fetch-Mode:cors / Sec-Fetch-Dest:empty）。
// 任意网页的 fetch 必带 Origin（白名单拦）；<img>/导航/脚本客户端(curl) 的 Sec-Fetch 值不同（no-cors/image/navigate/缺失）。
// 网页阅读源（AI-021 网页源适配器）来源白名单：只认精确/子域匹配的 host，
// 避免伪造相近域名。新增阅读源站点在这里登记（同时需 manifest 匹配 + 适配器 SITES）。
function isPageSourceOrigin(origin) {
  try {
    const host = String(new URL(String(origin || '')).hostname).toLowerCase()
    return host === 'marxists.org' || host.endsWith('.marxists.org')
      || host === 'bilibili.com' || host === 'www.bilibili.com'
  } catch { return false }
}

function originAllowed(origin, req) {
  if (String(origin || '').includes('weread.qq.com')
    || isPageSourceOrigin(origin)
    || String(origin || '').startsWith('chrome-extension://')) return true
  // 无 Origin：仅放行扩展页/内容脚本发起的浏览器请求指纹
  if (!origin) {
    const mode = req.headers['sec-fetch-mode'] || ''
    const dest = req.headers['sec-fetch-dest'] || ''
    return mode === 'cors' && dest === 'empty'
  }
  return false
}

// 比 originAllowed 更严：只认扩展页（或本机进程）。用于 /api-config —— 该接口会明文
// 返回 API Key，不能像 /history 那样连 weread.qq.com 和网页阅读源一起放行
//（密钥不该流给页面脚本）。判定分两层：
//   1. Host 必须是回环地址：挡 DNS rebinding（攻击者域名解析到 127.0.0.1 时浏览器视为
//      同源、请求不带 Origin，响应会被其页面读到）。
//   2. Origin 为空（扩展页经 host_permissions 绕过 CORS 时实测不带 Origin，见上方注释；
//      也可能是 curl 等本机进程——本机进程本就能直接读配置文件，不算额外泄露）
//      或显式是 chrome-extension://。带页面 Origin 的请求一律拒绝。
function isExtensionOnly(origin, req) {
  const host = String(req.headers.host || '').toLowerCase()
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  if (String(origin || '').startsWith('chrome-extension://')) return true
  return !origin
}

function readBody(req) {
  // 必须收集全部 Buffer 后再一次性 toString('utf8') 解码：
  // 逐个 chunk 做 body += chunk 时，若一个多字节 UTF-8 字符跨 chunk 边界，
  // 每次转换都会把不完整的字节解码成 U+FFFD（�），选中文字里就会混入乱码。
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

// ── 自由模式多对话（2026-11 用户定调）────────────────────────────────────────
// 注册表（agent/data/free-conversations.json）只存标题与状态；"这场对话有多少条消息、
// 最后说话是什么时候"直接数聊天存档——不引入会与真实落库漂移的冗余计数。
// 一次扫描把两个文件的计数都算出来（列表/单条查询共用）。
function conversationCounts() {
  // ── 自由对话实时计数（消息数/最后活跃/首条提问）──
  // 旧实现每 3s 把 chat_input + chat_output 两个文件全读一遍并逐行 parse；
  // 现在是一次 SQL（按 conv 聚合 + 每组取首条提问）。
  const counts = new Map()   // key -> { user, assistant, lastAt, firstUser }
  try {
    for (const r of chatStore().db.prepare(
      "SELECT conv, role, COUNT(*) AS n, MAX(ts) AS lastAt FROM messages GROUP BY conv, role",
    ).all()) {
      const c = counts.get(r.conv) || { user: 0, assistant: 0, lastAt: 0, firstUser: '' }
      if (r.role === 'user') c.user += Number(r.n)
      else c.assistant += Number(r.n)
      c.lastAt = Math.max(c.lastAt, Number(r.lastAt) || 0)
      counts.set(r.conv, c)
    }
    for (const r of chatStore().db.prepare(
      "SELECT conv, content, MIN(id) AS firstId FROM messages WHERE role='user' GROUP BY conv",
    ).all()) {
      const c = counts.get(r.conv)
      if (c && !c.firstUser) c.firstUser = String(r.content || '')
    }
  } catch {}
  return counts
}

// 注册表条目 + 实时计数 → 侧栏用的结构。title 为空（还没起名的新对话）时用首条
// 用户消息兜底显示（不写回注册表：标题由侧栏在首条发送后正式落库）。
function decorateConversation(c, counts) {
  const n = counts.get(c.key) || { user: 0, assistant: 0, lastAt: 0, firstUser: '' }
  const fallback = String(n.firstUser || '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return {
    key: c.key,
    title: c.title || fallback || '',
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || c.createdAt || 0,
    lastAt: n.lastAt || c.updatedAt || c.createdAt || 0,
    messages: n.user + n.assistant,
    status: c.status === 'archived' ? 'archived' : 'active',
    archivedAt: c.archivedAt || 0,
    archive: c.archive || null,
  }
}

/** 读注册表（顺带把历史遗留的默认对话补登记）。返回 { conversations, counts } */
function conversationsSnapshot() {
  ensureLegacyConversation(AGENT_DIR)
  return { registry: readRegistry(AGENT_DIR), counts: conversationCounts() }
}

// ── 阅读器书库 ────────────────────────────────────────────────────────────────
// 放进来过的 PDF 存原件，下次不用再手动选文件。位置：receiver/books/<hash>/
//   source.pdf       原件
//   reader-meta.json 书名、页数、打开时间等（列表就靠它）
// 书的内容哈希当目录名，所以同一份文件重复打开只会有一份。
const READER_META = 'reader-meta.json'
const MAX_READER_FILE = 300 * 1024 * 1024     // 单个 PDF 上限 300MB

/** 只接受十六进制内容哈希当目录名：顺手把路径穿越挡在外面 */
function normalizeReaderHash(h) {
  const s = String(h || '').trim().toLowerCase()
  return /^[a-f0-9]{16,64}$/.test(s) ? s : ''
}

function readerDir(hash) { return path.join(BOOKS_DIR, hash) }
function readerFilePath(hash) { return path.join(readerDir(hash), 'source.pdf') }

function readReaderMeta(hash) {
  try { return JSON.parse(fs.readFileSync(path.join(readerDir(hash), READER_META), 'utf8')) } catch { return null }
}

function writeReaderMeta(hash, patch) {
  const dir = readerDir(hash)
  fs.mkdirSync(dir, { recursive: true })
  const next = Object.assign({}, readReaderMeta(hash) || {}, patch, { hash, updatedAt: Date.now() })
  fs.writeFileSync(path.join(dir, READER_META), JSON.stringify(next, null, 2))
  return next
}

function listReaderBooks() {
  const out = []
  let names = []
  try { names = fs.readdirSync(BOOKS_DIR) } catch { return out }
  for (const name of names) {
    const meta = readReaderMeta(name)
    if (!meta) continue                       // 不是阅读器的书（微信读书的书目录没有这个文件）
    let size = 0
    try { size = fs.statSync(readerFilePath(name)).size } catch {}
    out.push(Object.assign({}, meta, { size, hasFile: size > 0 }))
  }
  out.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  return out
}

/** 读原始字节的请求体（PDF 上传不能套 JSON/base64） */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function looksWereadEncoded(text) {
  return /^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]{100,}$/.test(String(text || '').trim())
}

function cjkCount(text) {
  return (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length
}

function safeWriteContent(bookId, chapterUid, text, selectedText) {
  const chapterFile = path.join(bookDir(bookId), 'chapters', `${sanitizePathPart(chapterUid) || '_invalid'}.txt`)
  const existing = readIfExists(chapterFile)
  if (existing && existing.length > text.length) {
    if (looksWereadEncoded(existing) && cjkCount(text) > 50) {
      fs.writeFileSync(chapterFile, text)
      return 'replacedEncoded'
    }
    const existingHasSelection = selectedText && normalizeText(existing).includes(normalizeText(selectedText))
    const textHasSelection = selectedText && normalizeText(text).includes(normalizeText(selectedText))
    if (selectedText && (existingHasSelection || !textHasSelection)) {
      return 'keptExisting'
    }
    if (!selectedText) {
      return 'keptExisting'
    }
  }
  fs.writeFileSync(chapterFile, text)
  return 'written'
}

/**
 * 翻译记录（工具箱「贴回本页译文」的数据源）：一行一条 JSON。
 * 存 url / 页面标题 / 原文 / 译文 / 页面坐标，用于把译文重新贴回原来的位置。
 */
function readToolRecords() {
  const out = []
  let raw = ''
  try { raw = fs.readFileSync(TOOL_HISTORY, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

function writeToolRecords(records) {
  const body = records.map((r) => JSON.stringify(r)).join('\n')
  fs.writeFileSync(TOOL_HISTORY, body + (records.length ? '\n' : ''))
}

function writeBookMeta(bookId, data) {
  if (!bookId) return
  const file = path.join(bookDir(bookId), 'meta.json')
  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
  })()
  const next = {
    ...prev,
    bookId,
    baseBookId: data.baseBookId || baseBookId(bookId),
    bookTitle: data.bookTitle || prev.bookTitle || '',
    wereadBookId: data.wereadBookId || prev.wereadBookId || '',
    updatedAt: Date.now(),
  }
  fs.writeFileSync(file, JSON.stringify(next))
}

function triggerInject(message) {
  const pendingFile = path.join(INBOX_DIR, 'pending.txt')
  fs.appendFileSync(pendingFile, message + '\n')
  const injectScript = path.join(__dirname, '..', 'agent', 'scripts', 'inject.sh')
  if (fs.existsSync(injectScript)) {
    try { execSync(`bash "${injectScript}"`, { timeout: 5000 }) }
    catch (e) { /* inject 失败不影响接收端运行 */ }
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  // OPTIONS 预检直接放行
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.writeHead(204); res.end(); return
  }

  // 历史记录（GET /history）
  if (req.method === 'GET' && req.url === '/history') {
    // 来源限制：只允许扩展读历史，任意网页不可读走聊天/标注数据（评审 P1）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const readJsonl = (file) => {
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      } catch { return [] }
    }
    // 标注全部保留，聊天消息截最近 200 条
    // AI-010：标注一律是"引用"，历史回放时侧栏只把它们并入引用列表 + 参与对账清理，
    // 不渲染消息气泡（见 sidebar loadHistory）。silent 概念已移除，这里不需要再透传。
    const annItems = []
    for (const d of readJsonl(path.join(INBOX_DIR, 'annotations.jsonl'))) {
      annItems.push({ role: 'annotation', content: `《${d.bookTitle}》${d.chapter || ''}`,
        selectedText: d.selectedText, userNote: d.userNote || '',
        bookId: d.bookId, bookTitle: d.bookTitle,
        chapter: d.chapter || '', chapterUid: d.chapterUid || '', chapterUidInt: d.chapterUidInt || 0,
        bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
        sourceUrl: d.sourceUrl || '',
        _ts: d.receivedAt || d.timestamp * 1000 })
    }
    const chatItems = []
    // 聊天消息来自聊天库（一个查询，替代"读两个 jsonl 再各自排序拼接"）：
    // id 序 = 到达顺序；回答带 reply_to，与提问天然相邻。
    let chatRows = []
    try { chatRows = chatStore().listMessages({}) } catch {}
    for (const m of chatRows) {
      if (m.role === 'user') {
        // 带书上下文的消息保留 bookId，供侧栏按书隔离引用与对话（AI-001）
        const item = { role: 'user', content: m.content, _ts: m.timestamp }
        if (m.bookId) {
          item.bookId = m.bookId
          item.bookTitle = m.bookTitle || ''
          item.chapter = m.chapter || ''
          item.chapterUid = m.chapterUid || ''
          item.chapterUidInt = 0
          item.selectedText = m.selectedText || ''
        }
        chatItems.push(item)
      } else {
        // 失败气泡也回放（侧栏显示为错误气泡）；system = 指令回复。
        // bookKey = 这条回复真实所属的对话（2026-10-02）：旧版这里不带 bookKey，侧栏只能把
        // 回复归给"最近前序提问的那本书"——2026-09-28 重放留下的 74 条《静静的顿河》回复
        // 因此堆到了《大国大城》视图的末尾。带上它，侧栏就能精确归属。
        chatItems.push({
          role: m.role, content: m.content, _ts: m.timestamp || 0, bookKey: m.conv,
          ...(m.status === 'failed' ? { failed: true } : {}),
        })
      }
    }
    // 聊天消息先按时间戳混排、再取最近 500 条：user/assistant 交错后截取，
    // 避免数组顺序里"全部 user 在前、assistant 在后"导致截尾把提问整个裁掉。
    // 200 太小——agent 回复数是提问的 2~3 倍，200 窗口把老提问挤没（修：AI-016）。
    const chatSorted = chatItems.sort((a, b) => (a._ts || 0) - (b._ts || 0))
    // 标注 + 最近 500 条聊天按时间戳交错排序：让标注与其自动回复相邻，
    // 侧栏既按时间顺序展示，也能据此为回复继承正确的书籍书签（AI-001）
    const allItems = [...annItems, ...chatSorted.slice(-500)]
      .sort((a, b) => (a._ts || 0) - (b._ts || 0))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(allItems))
    return
  }

  // 模型 API 配置（GET /api-config）——侧栏「⋯ → 模型 API 配置」弹窗的数据源。
  // 返回生效配置（插件文件 > .env，见 agent/lib/api-config.js）。**明文返回 apiKey**：
  // 本机单用户工具，弹窗要用它预填输入框（"给一个 edit" 直接改），因此这里比
  // /history 更严 —— 只认扩展页，weread 页面源与任意网页一律 403（见 isExtensionOnly）。
  if (req.method === 'GET' && req.url.split('?')[0] === '/api-config') {
    if (!isExtensionOnly(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const cfg = resolveApiConfig()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      model: cfg.model,
      configured: isConfigured(cfg),
      source: cfg.source,
    }))
    return
  }

  // 已读书籍列表（GET /books）——读书模式「无书默认界面」手动选书的数据源。
  // 返回 { books: [{ base, bookTitle, wereadBookId, updatedAt }] }，按最近更新倒序。
  // 数据源：books/<base>/meta.json（每次标注/正文/进度写入都会更新），并用聊天与
  // 标注存档里出现过的 bookId 兜底——只有聊天记录、没有 meta 的书也能被选中查看。
  // 侧栏据此列出「已读过的书籍」：读完的书不在微信读书中打开时，也有查看聊天记录的入口。
  if (req.method === 'GET' && req.url.split('?')[0] === '/books') {
    // 来源限制：只允许扩展读列表，任意网页不可枚举本地已读书籍（评审 P1 同款）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const books = new Map()  // base -> { base, bookTitle, wereadBookId, updatedAt }
    const touch = (base, bookTitle, wereadBookId, updatedAt) => {
      if (!base) return
      const cur = books.get(base) || { base, bookTitle: '', wereadBookId: '', updatedAt: 0 }
      if (bookTitle) cur.bookTitle = bookTitle
      if (wereadBookId) cur.wereadBookId = wereadBookId
      if (updatedAt) cur.updatedAt = Math.max(cur.updatedAt, updatedAt)
      books.set(base, cur)
    }
    try {
      for (const name of fs.readdirSync(BOOKS_DIR)) {
        const dir = path.join(BOOKS_DIR, name)
        let st
        try { st = fs.statSync(dir) } catch { continue }
        if (!st.isDirectory()) continue
        let meta
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch { continue }
        touch(baseBookId(meta.baseBookId || meta.bookId || name),
          meta.bookTitle || '', meta.wereadBookId || '', meta.updatedAt || 0)
      }
    } catch {}
    const scanLines = (file) => {
      try { return fs.readFileSync(file, 'utf8').split('\n') } catch { return [] }
    }
    // 书籍足迹来源：库里的消息（提问自带 bookId/bookTitle）——不再读 chat_input.jsonl
    try {
      for (const r of chatStore().db.prepare(
        "SELECT conv, book_id, book_title, MAX(ts) AS lastAt FROM messages WHERE role='user' GROUP BY conv",
      ).all()) {
        const id = r.book_id || r.conv
        if (id) touch(baseBookId(id), r.book_title || '', '', Number(r.lastAt) || 0)
      }
    } catch {}
    for (const line of scanLines(path.join(INBOX_DIR, 'annotations.jsonl'))) {
      if (!line) continue
      try {
        const d = JSON.parse(line)
        if (d.bookId) touch(baseBookId(d.bookId), d.bookTitle || '', '', d.receivedAt || 0)
      } catch {}
    }
    const list = [...books.values()]
      // 与侧栏防御一致：只认形如真实书 ID 的 base（排除测试/垃圾 bookId），
      // 保证选出的书能通过侧栏的上下文校验；双下划线前缀的哨兵上下文
      //（如自由模式 __coread_free_mode__）不是真实书籍，一并排除
      .filter(b => /^[A-Za-z0-9_]{12,}$/.test(b.base) && !b.base.startsWith('__'))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ books: list }))
    return
  }

  // 会意图拓扑图（GET /graph[?demo=1][?free=1]）——AI-020
  // 返回 { nodes, edges, updatedAt, demo, free, source }：节点 = 知识点（point/aliases/discussions），
  // 边 = 用户问题意识轨迹（from → to，kind: user|derived）。数据源 = agent/data/
  // knowledge-graph.json（会意系统固化的图文件，一张图一个文件，§5.3）；?demo=1 时
  // 用演示拓扑（scripts/data/knowledge-graph-demo.json）重建，供侧栏图视图在真实图
  // 为空时预览交互与命中高亮；?free=1 时返回自由模式沙盒图（agent/data/
  // knowledge-graph.free.json，自由模式测试固化产物；文件不存在则回退正式图）。
  if (req.method === 'GET' && req.url.split('?')[0] === '/graph') {
    // 来源限制：只允许扩展读图（评审 P1 同款）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const u = new URL(req.url, 'http://localhost')
    let out = readGraphFile()
    if (u.searchParams.get('demo') === '1') {
      const dg = buildDemoGraph()
      if (dg) out = { nodes: dg.nodes, edges: dg.edges, updatedAt: Date.now(), demo: true }
    } else if (u.searchParams.get('free') === '1') {
      const fg = readFreeGraphFile()
      if (fg) out = fg
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }

  // 当前实时栈的引用命中（GET /stack-hits?book=..）——2026-09 用户定调：
  // 图视图显示的"当前讨论命中" = 实时讨论栈（agent/topic_stack.json）里 user 条目
  // 挂的 cites（去重）。侧栏打开图 / 收到 stack-updated / 切书时重拉：非空恢复
  // 高亮 + 横幅；栈收口清空后为空 → 侧栏清除 hit 态高亮。
  if (req.method === 'GET' && req.url.split('?')[0] === '/stack-hits') {
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const u = new URL(req.url, 'http://localhost')
    const book = baseBookId(u.searchParams.get('book') || '')
    const hits = []
    try {
      const stacks = JSON.parse(fs.readFileSync(TOPIC_STACK_FILE, 'utf8'))
      const stack = stacks[book] || []
      for (const e of stack) {
        if (e && e.role === 'user' && Array.isArray(e.cites)) {
          for (const c of e.cites) if (c && !hits.includes(c)) hits.push(c)
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hits }))
    return
  }

  // 自由模式对话列表（GET /free-conversations）——2026-11 用户定调（自由模式多对话）。
  // 返回 { current: key|null, active: [...], archived: [...] }：每条含 key/title/消息数/
  // 最近活跃时间/状态。侧栏「自由对话」弹窗与对话条据此渲染；current = 最近活跃的
  // 活动对话（侧栏首次进入自由模式时恢复它，之后由侧栏自己记住选择）。
  if (req.method === 'GET' && req.url.split('?')[0] === '/free-conversations') {
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const { registry, counts } = conversationsSnapshot()
    // 排序口径 = 最近说话时间（聊天存档实测），注册表的 updatedAt 只作兜底：
    // 手动改标题/登记活动都会刷 updatedAt，用它排序会让"刚改过名字的老对话"跳最前
    const sortByLast = (list) => list
      .map((c) => decorateConversation(c, counts))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    const active = sortByLast(activeConversations(registry))
    const archived = archivedConversations(registry)
      .map((c) => decorateConversation(c, counts))
      .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // current = 最近有实际说话的对话（lastAt 最大的那条，不是"最近被改过名字"的那条）：
    // 侧栏首次进入自由模式时恢复它——网页端的"回到上次那场对话"。
    // lastActive 缺省时（所有对话都还没说过话）回落到 current（= 第一条活动对话）。
    const spoken = active.find((c) => c.lastAt)
    res.end(JSON.stringify({
      current: (spoken || active[0] || {}).key || null,
      lastActive: spoken ? spoken.key : null,
      active,
      archived,
    }))
    return
  }

  // 反查章节（GET /find-chapter?bookId=..&text=..）
  // 用引用文字在本地正文缓存里找到对应章节文件，返回可跳转的章节定位：
  //   chapterUid（数字文件名，可用 k-suffix URL）或 slot（e_0/t_1 原生 hash 槽位）。
  // 用于旧标注 chapterUidInt 为空、无法直接用 k-suffix 跳转时的兜底（AI-006）。
  if (req.method === 'GET' && req.url.startsWith('/find-chapter?')) {
    const u = new URL(req.url, 'http://localhost')
    const bookId = u.searchParams.get('bookId') || ''
    const text = u.searchParams.get('text') || ''
    if (!bookId || !text) { res.writeHead(400); res.end('{}'); return }
    // 来源限制：只允许扩展调用，任意网页的简单 GET 无法触发本地扫描/建目录（评审 P1）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const chaptersDir = path.join(bookDir(bookId), 'chapters')
    const needle = normalizeText(text).slice(0, 60)
    let best = null
    let bestLen = 0
    try {
      for (const name of fs.readdirSync(chaptersDir)) {
        if (!name.endsWith('.txt')) continue
        const t = fs.readFileSync(path.join(chaptersDir, name), 'utf8')
        if (!t) continue
        if (normalizeText(t).indexOf(needle) !== -1 && t.length > bestLen) {
          bestLen = t.length
          const base = name.replace(/\.txt$/, '')
          let chapterUid = ''
          let slot = ''
          if (/^[te]_\d+$/.test(base)) slot = base
          else if (/^\d+$/.test(base)) chapterUid = base
          else { const m = base.match(/(?:^|_)([te]_\d+)$/); slot = m ? m[1] : '' }
          best = { filename: name, chapterUid, slot }
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(best || { chapterUid: '', slot: '' }))
    return
  }

  // 翻译记录（GET /tool-records?url=..&limit=..）——「贴回本页译文」的数据源
  if (req.method === 'GET' && req.url.split('?')[0] === '/tool-records') {
    // 来源限制：翻译记录含用户读过的原文，只允许扩展读（与 /annotations 同级）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const u = new URL(req.url, 'http://localhost')
    const target = u.searchParams.get('url') || ''
    const limit = Math.min(parseInt(u.searchParams.get('limit'), 10) || 50, 500)
    const all = readToolRecords().filter((r) => !target || r.url === target)
    all.reverse()  // 新的在前
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records: all.slice(0, limit), total: all.length }))
    return
  }

  // 阅读器书库：已放进来的 PDF（GET /reader-books）
  // 书库列表属于个人数据，只允许扩展读
  if (req.method === 'GET' && req.url.split('?')[0] === '/reader-books') {
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ books: listReaderBooks() }))
    return
  }

  // 取回书库里的 PDF 原件（GET /reader-book-file?hash=..）
  if (req.method === 'GET' && req.url.split('?')[0] === '/reader-book-file') {
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end(); return }
    const u = new URL(req.url, 'http://localhost')
    const hash = normalizeReaderHash(u.searchParams.get('hash'))
    if (!hash) { res.writeHead(400); res.end('bad hash'); return }
    let buf
    try { buf = fs.readFileSync(readerFilePath(hash)) } catch { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
    return
  }

  // 共读标注列表（GET /annotations?bookId=..）
  // 返回该书所有已共读标注（selectedText 等），供内容脚本在书页里标记共读段落。
  if (req.method === 'GET' && req.url.startsWith('/annotations?')) {
    // 来源限制：只允许扩展读标注，任意网页不可读走划线数据（评审 P1）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    const u = new URL(req.url, 'http://localhost')
    const bookId = u.searchParams.get('bookId') || ''
    const base = baseBookId(bookId)
    const out = []
    if (base) {
      try {
        const lines = fs.readFileSync(path.join(INBOX_DIR, 'annotations.jsonl'), 'utf8').trim().split('\n')
        for (const line of lines) {
          if (!line) continue
          let d
          try { d = JSON.parse(line) } catch { continue }
          if (!d.selectedText) continue
          if (d.bookId && baseBookId(d.bookId) === base) {
            out.push({
              selectedText: d.selectedText,
              chapter: d.chapter || '',
              chapterUid: d.chapterUid || '',
              chapterUidInt: d.chapterUidInt || 0,
              // 返回完整记录：侧栏据此把该书标注合并进引用列表（抽屉打开/SSE重连时
              // 拉全量补齐，不依赖 SSE 是否恰好送达；AI-012）
              bookId: d.bookId || '',
              bookTitle: d.bookTitle || '',
              bookmarkRange: d.bookmarkRange || '',
              bookmarkId: d.bookmarkId || '',
              userNote: d.userNote || '',
              sourceUrl: d.sourceUrl || '',
              timestamp: d.receivedAt || (d.timestamp ? d.timestamp * 1000 : 0),
            })
          }
        }
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }

  // SSE 订阅（GET /events[?lastId=..]）
  if (req.method === 'GET' && req.url.split('?')[0] === '/events') {
    // 来源限制：只允许扩展订阅事件流，任意网页不可偷听聊天推送（评审 P1）
    if (!originAllowed(origin, req)) { res.writeHead(403); res.end('{}'); return }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
    // 断点续传：只重放客户端没收到的事件（_seq > lastId）。lastId 来自 EventSource
    // 自动重连时的 Last-Event-ID 头，或侧栏重建连接时通过 ?lastId= 传入（AI-006）。
    // 首次连接（lastId=0）不回放——侧栏已通过 /history 加载历史。
    const u = new URL(req.url, 'http://localhost')
    const queryLastId = parseInt(u.searchParams.get('lastId'), 10) || 0
    const lastId = parseInt(req.headers['last-event-id'], 10) || queryLastId || 0
    if (lastId > 0) {
      for (const evt of recentEvents) {
        if (evt._seq > lastId) {
          res.write(`id: ${evt._seq}\ndata: ${JSON.stringify(evt)}\n\n`)
        }
      }
    }
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // POST 只允许 weread.qq.com、网页阅读源（marxists.org / bilibili.com）和 扩展 sidebar
  if (req.method === 'POST' && origin
    && !origin.includes('weread.qq.com')
    && !isPageSourceOrigin(origin)
    && !origin.startsWith('chrome-extension://')) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

  // 存 PDF 原件：请求体是**原始字节**，不能走 JSON 解析，所以在 readBody 之前拦下来
  if (req.url.split('?')[0] === '/reader-book-file') {
    const u = new URL(req.url, 'http://localhost')
    const hash = normalizeReaderHash(u.searchParams.get('hash'))
    if (!hash) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"bad hash"}'); return }
    let buf
    try {
      buf = await readRawBody(req, MAX_READER_FILE)
    } catch (e) {
      const tooLarge = e && e.code === 'TOO_LARGE'
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: tooLarge ? '文件超过 300MB，未存入书库' : '读取请求体失败' }))
      return
    }
    if (!buf.length || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"error":"不是 PDF 文件"}')
      return
    }
    try {
      const dir = readerDir(hash)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(readerFilePath(hash), buf)
      const name = decodeURIComponent(u.searchParams.get('name') || '')
      const meta = writeReaderMeta(hash, { name, size: buf.length, lastOpenedAt: Date.now() })
      console.log(`[reader] 存入书库 ${hash.slice(0, 12)}… ${name || '(未命名)'} ${(buf.length / 1048576).toFixed(1)}MB`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hash, size: meta.size }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '写入失败：' + e.message }))
    }
    return
  }

  let data
  try { data = await readBody(req) }
  catch { res.writeHead(400); res.end('Bad JSON'); return }

  const url = req.url

  try {
    if (url === '/api-config') {
      // 保存模型 API 配置（侧栏「⋯ → 模型 API 配置」保存按钮）。写入 agent/api-config.json，
      // agent 每次调用 LLM 前重读该文件 —— 保存后立即生效，不需要重启 agent。
      // 与 GET 同样只认扩展页：不能让页面脚本改写用户的密钥/把请求导向别处。
      if (!isExtensionOnly(origin, req)) {
        res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'forbidden' })); return
      }
      const v = validateApiConfigInput(data)
      if (!v.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: v.error }))
        return
      }
      try {
        writeApiConfig(v.value)
      } catch (e) {
        console.error('[api-config] 写入失败：', e.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '写入配置失败：' + e.message }))
        return
      }
      // 日志只记地址与模型，绝不打印 key
      console.log(`[api-config] 已更新 base=${v.value.apiBase} model=${v.value.model}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, apiBase: v.value.apiBase, model: v.value.model, configured: true, source: 'plugin',
      }))
      return

    } else if (url === '/annotation') {
      // 标注写入 inbox
      const line = JSON.stringify({ ...data, receivedAt: Date.now() })
      fs.appendFileSync(path.join(INBOX_DIR, 'annotations.jsonl'), line + '\n')
      writeBookMeta(data.bookId, data)
      console.log(`[annotation] ${data.bookTitle} · ${data.chapter} · "${data.selectedText?.slice(0, 20)}..."`)
      // AI-010：标注一律是"引用"（划线共读设为引用 / 微信读书划线同步），不触发 agent
      // 自动讨论、不推 annotation 消息气泡；只按来源推送引用事件让侧栏实时加进引用列表。
      // （旧的"划线即讨论"非静默分支已无入口，silent 概念整体移除。）
      if (data.setRef) {
        // 划线共读弹窗只"设为当前引用"，不触发 agent 讨论：推送 annotation-select 事件，
        // 侧栏收到后把该标注加入引用列表并选中为当前引用
        pushSSE('message', {
          role: 'annotation-select',
          selectedText: data.selectedText,
          bookId: data.bookId,
          bookTitle: data.bookTitle,
          chapter: data.chapter || '',
          chapterUid: data.chapterUid || '',
          chapterUidInt: data.chapterUidInt || 0,
          sourceUrl: data.sourceUrl || '',
        })
      } else if (data.source === 'bookmark-sync') {
        // 微信读书划线同步：静默入库（不触发 agent），推送轻量事件让侧栏实时把
        // 划线加进引用列表（不弹气泡、不强制选中），便于看到同步生效。
        pushSSE('message', {
          role: 'annotation-sync',
          selectedText: data.selectedText,
          bookId: data.bookId,
          bookTitle: data.bookTitle,
          chapter: data.chapter || '',
          chapterUidInt: data.chapterUidInt || 0,
          bookmarkRange: data.bookmarkRange || '',
          bookmarkId: data.bookmarkId || '',
          sourceUrl: data.sourceUrl || '',
        })
      }

    } else if (url === '/annotation-delete') {
      // 删除引用：优先按 bookmarkId 精确匹配（划线同步来的引用，能区分同文本的多条划线）；
      // 其次按 chapterUidInt + bookmarkRange；兜底按 bookId + selectedText。
      // 从 annotations.jsonl 移除所有匹配行，并推送 annotation-removed 事件让侧栏同步移除。
      const { bookId, selectedText, bookmarkId, chapterUidInt, bookmarkRange } = data
      if ((!bookId || !selectedText) && !bookmarkId) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing fields' })); return }
      const base = baseBookId(bookId || '')
      const needle = normalizeText(selectedText || '')
      const uidInt = Number(chapterUidInt) || 0
      const file = path.join(INBOX_DIR, 'annotations.jsonl')
      let lines = []
      try { lines = fs.readFileSync(file, 'utf8').split('\n') } catch { lines = [] }
      const kept = []
      const removed = []
      let deleted = 0
      for (const line of lines) {
        if (!line.trim()) continue
        let d
        try { d = JSON.parse(line) } catch { kept.push(line); continue }
        let isMatch = false
        if (bookmarkId) {
          // 精确 bookmarkId 优先；旧数据没有 bookmarkId 时按章节+范围兜底
          isMatch = (!!d.bookmarkId && String(d.bookmarkId) === String(bookmarkId))
            || (uidInt && Number(d.chapterUidInt) === uidInt && String(d.bookmarkRange || '') === String(bookmarkRange))
        } else if (uidInt && bookmarkRange) {
          isMatch = Number(d.chapterUidInt) === uidInt && String(d.bookmarkRange || '') === String(bookmarkRange)
        } else {
          isMatch = !!d.bookId && baseBookId(d.bookId) === base && normalizeText(d.selectedText || '') === needle
        }
        if (isMatch) { deleted++; removed.push(d) } else kept.push(line)
      }
      writeFileAtomic(file, kept.join('\n') + (kept.length ? '\n' : ''))
      // 推删除事件：侧栏据此移除引用列表 + 刷新书页共读标记（微信读书内删划线时）
      if (removed.length) {
        pushSSE('message', {
          role: 'annotation-removed',
          removed: removed.map(r => ({
            bookId: r.bookId, bookTitle: r.bookTitle || '',
            chapter: r.chapter || '', selectedText: r.selectedText,
            bookmarkRange: r.bookmarkRange || '', bookmarkId: r.bookmarkId || '',
          })),
        })
      }
      console.log(`[annotation-delete] book=${base.slice(0, 12)}… deleted=${deleted}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deleted }))
      return  // 必须 return：否则会落到底部公共 res.writeHead(200)，对已结束的响应二次 writeHead 抛 ERR_HTTP_HEADERS_SENT，导致进程崩溃

    } else if (url === '/book-delete') {
      // 删除一本书（侧栏「已读过的书籍」列表的删除操作）。清理三处：
      // 1) books/<base>/ 目录（meta/章节缓存/discussions/progress，含书籍足迹数据源）；
      // 2) annotations.jsonl 中该书标注（引用列表数据源，删净后不再出现在 /history）；
      // 3) 聊天库中该对话的全部消息与事件（事务删除、按 conv 精确命中）。
      // 2026-10-02（方案 B）：3) 以前是"读 63MB chat_output + 按 bookKey/配对归属过滤 + 整文件重写"，
      // 那个重写空窗正是 09-28 重放事故的起点；现在是一条 DELETE。
      const { base } = data
      if (!base || !/^[A-Za-z0-9_]{12,}$/.test(base) || base.startsWith('__')) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid base' })); return
      }
      const norm = sanitizePathPart(base) || base
      // 按 bookId 过滤 jsonl 存档（文件不存在时跳过，不新建空文件）——只剩标注文件还在用文件存储
      const filterByBook = (file) => {
        let raw = null
        try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
        let removed = 0
        const kept = []
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          let d
          try { d = JSON.parse(line) } catch { kept.push(line); continue }
          if (d.bookId && baseBookId(d.bookId) === base) { removed++; continue }
          kept.push(line)
        }
        writeFileAtomic(file, kept.join('\n') + (kept.length ? '\n' : ''))
        return removed
      }
      const annRemoved = filterByBook(path.join(INBOX_DIR, 'annotations.jsonl'))
      const chatRemoved = (() => {
        try { return chatStore().deleteConversation(base) } catch (e) { console.log('[book-delete] 删库失败: ' + e.message); return { messages: 0, events: 0 } }
      })()
      let dirRemoved = false
      try {
        fs.rmSync(path.join(BOOKS_DIR, norm), { recursive: true, force: true })
        dirRemoved = true
      } catch {}
      console.log('[book-delete] base=' + norm.slice(0, 16) + '… dir=' + dirRemoved + ' ann=' + annRemoved +
        ' messages=' + chatRemoved.messages + ' events=' + chatRemoved.events)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, dirRemoved, annRemoved,
        chatInRemoved: chatRemoved.messages, chatOutRemoved: chatRemoved.events,
      }))
      return

    } else if (url === '/book-create') {
      // 网页阅读源：读者手动建书（AI-021 用户定调：不做 URL 自动归书，
      // 由读者在网页上建书并把页面绑定到书；书名由读者输入，不抓远程页面，
      // 避免旧页面 GB2312/GBK 按 UTF-8 误读造成的乱码）
      const title = String((data && data.bookTitle) || '').trim()
      if (!title || title.length > 200) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad title' })); return }
      let bookId = ''
      for (let tries = 0; tries < 5 && !bookId; tries++) {
        const cand = 'mia_' + Array.from({ length: 20 }, function () { return '0123456789abcdef'.charAt(Math.floor(Math.random() * 16)) }).join('')
        if (!fs.existsSync(path.join(BOOKS_DIR, cand))) bookId = cand
      }
      if (!bookId) { res.writeHead(500); res.end(JSON.stringify({ error: 'id exhausted' })); return }
      writeBookMeta(bookId, { bookId: bookId, baseBookId: bookId, bookTitle: title })
      console.log('[book-create] ' + bookId + ' 《' + title + '》')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, bookId: bookId, bookTitle: title }))
      return

    } else if (url === '/chat') {
      // 来自侧栏或共读弹窗的用户消息
      const { content, bookId, bookTitle, chapter, chapterUid, selectedText, refs } = data
      if (!content) { res.writeHead(400); res.end(); return }
      const entry = { role: 'user', content, timestamp: Date.now() }
      if (bookId) {
        entry.bookId = bookId
        entry.bookTitle = bookTitle || ''
        entry.chapter = chapter || ''
        entry.chapterUid = chapterUid || ''
        entry.selectedText = selectedText || ''
      }
      // 自由模式手动引用（2026-09）：侧栏窗体携带的引用节点 id 清单，原样落库，
      // agent 收口建边时以它为 cites（是否与语义解析命中合并由 agent 决定）
      if (Array.isArray(refs)) entry.refs = refs
      // 入库为"待处理"（status=pending）：agent 轮询到就回答，答完置 ok、失败置 failed（可重试）。
      // 旧实现是往 chat_input.jsonl 追加一行 + 由 agent 维护游标与指纹台账去重（三套机制）。
      const msgId = (() => {
        try {
          return chatStore().insertMessage({
            conv: bookId ? baseBookId(bookId) : '_common',
            role: 'user', content, ts: entry.timestamp, status: 'pending',
            bookId, bookTitle: bookTitle || '', chapter: chapter || '', chapterUid: chapterUid || '',
            selectedText: selectedText || '', refs: Array.isArray(refs) ? refs : undefined,
          })
        } catch (e) { console.log('[chat] 写库失败: ' + e.message); return 0 }
      })()

      // 自由对话活动登记（2026-11 多对话）：刷新该对话的最近活跃时间，并在它还没有
      // 标题时用首条用户消息兜底起名（不覆盖用户手动改过的标题，见 touchConversation）
      if (isFreeKey(bookId)) {
        try {
          const c = touchConversation(AGENT_DIR, bookId, { title: content, now: entry.timestamp })
          if (c) pushSSE('free-conversations-updated', {})
        } catch {}
      }

      // 来自共读弹窗的消息（不是侧栏）：推送用户消息到侧栏 + 显示思考状态。
      // 翻译气泡的「设为引用」走的是 /annotation（setRef: true），不经过这里。
      if (bookId && selectedText && !origin.startsWith('chrome-extension://')) {
        pushSSE('message', {
          role: 'user-popup',
          content: content,
          bookId: bookId,
          bookTitle: bookTitle || '',
          chapter: chapter || '',
          chapterUid: chapterUid || '',
          selectedText: selectedText,
        })
      }

      console.log(`[chat] ${content.slice(0, 50)}`)

      // 返回落库 timestamp：侧栏据此把本地渲染的提问注册为"历史已渲染"（_histKeys），
      // 使面板打开期间的增量历史重拉（回复恢复轮询）不会把用户刚发的提问重复渲染一遍
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, timestamp: entry.timestamp }))
      return

    } else if (url === '/free-conversations') {
      // 自由对话增删改（POST /free-conversations）——2026-11 用户定调。action：
      //   create → 新建一场空对话（返回 key，侧栏切过去并清空消息区）
      //   rename → 改标题（title 空串 = 回到"新对话"）
      //   delete → 彻底删除（含消息；用于清理不想要的空对话/测试残留）
      // 归档走的是 /free-archive（要交给 agent 做记忆与收口，不能只改注册表）。
      const action = String((data && data.action) || '')
      if (action === 'create') {
        const { key, conversation } = createConversation(AGENT_DIR, { title: String((data && data.title) || '') })
        console.log('[free-conversation] create ' + key)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, key, conversation: decorateConversation(conversation, new Map()) }))
        pushSSE('free-conversations-updated', {})
        return
      }
      if (action === 'rename') {
        const key = String((data && data.key) || '')
        const c = isFreeKey(key) ? renameConversation(AGENT_DIR, key, (data && data.title) || '') : null
        if (!c) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return }
        console.log('[free-conversation] rename ' + key + ' → ' + (c.title || '(空)'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, conversation: decorateConversation(c, conversationCounts()) }))
        pushSSE('free-conversations-updated', {})
        return
      }
      if (action === 'delete') {
        const key = String((data && data.key) || '')
        if (!isFreeKey(key)) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad key' })); return }
        const removed = (() => { try { return chatStore().deleteConversation(key) } catch { return { messages: 0, events: 0 } } })()
        const dropped = dropConversation(AGENT_DIR, key)
        console.log(`[free-conversation] delete ${key}（消息 ×${removed.messages} 事件 ×${removed.events}）`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: dropped, removed: { input: removed.messages, output: removed.events } }))
        pushSSE('free-conversations-updated', {})
        return
      }
      res.writeHead(400); res.end(JSON.stringify({ error: 'unknown action' }))
      return

    } else if (url === '/free-archive') {
      // 归档一场自由对话（POST /free-archive）——2026-11 用户定调。
      // 归档要动的东西（记忆合并、收口固化、清栈清消息）都在 agent 侧，这里只把
      // 请求入队（content='/归档' + payload.archive 勾选项），agent 轮询到就执行；
      // 结果以 role=system 入库 → SSE 回侧栏（toast + 系统气泡）。
      const key = String((data && data.key) || '')
      if (!isFreeKey(key)) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad key' })); return }
      const archive = { key, memory: !!(data && data.memory), graph: !!(data && data.graph) }
      const ts = Date.now()
      try {
        chatStore().insertMessage({
          conv: baseBookId(key), role: 'user', content: '/归档', ts, status: 'pending', payload: { archive },
        })
      } catch (e) {
        console.log('[free-archive] 写库失败: ' + e.message)
        res.writeHead(500); res.end(JSON.stringify({ error: 'store failed' })); return
      }
      console.log(`[free-archive] ${key} memory=${archive.memory} graph=${archive.graph}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, timestamp: ts }))
      return

    } else if (url === '/content') {
      // 章节正文缓存
      const { bookId, chapterUid, text, selectedText } = data
      if (!bookId || !chapterUid || !text) {
        console.warn(`[content] 400 missing fields: bookId=${bookId} chapterUid=${chapterUid} textLen=${text?.length}`)
        res.writeHead(400); res.end(); return
      }
      const result = safeWriteContent(bookId, chapterUid, text, selectedText)
      writeBookMeta(bookId, data)
      console.log(`[content] bookId=${bookId} chapterUid=${chapterUid} (${text.length} chars) ${result}`)

    } else if (url === '/debug') {
      const line = JSON.stringify({ ...data, receivedAt: Date.now() })
      fs.appendFileSync(DEBUG_LOG, line + '\n')
      console.log(`[debug] ${data.source || 'unknown'} ${data.stage || ''} ${data.bookTitle || data.bookId || ''}`)

    } else if (url === '/chapter-complete') {
      // 章节结束事件
      const { bookId, chapterUid, chapterTitle, bookTitle } = data
      console.log(`[chapter-complete] 《${bookTitle}》${chapterTitle}`)
      // 更新进度
      const progressFile = path.join(bookDir(bookId), 'progress.json')
      const prev = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile)) : {}
      fs.writeFileSync(progressFile, JSON.stringify({ ...prev, lastChapterUid: chapterUid, updatedAt: Date.now() }))
      const msg = `【章节完成】《${bookTitle}》${chapterTitle} 已读完，请问我这章的 learning。`
      triggerInject(msg)

    } else if (url === '/progress') {
      // 进度同步（来自 weread API 兜底轮询，后期用）
      const { bookId } = data
      if (bookId) {
        const payload = JSON.stringify({ ...data, updatedAt: Date.now() })
        fs.writeFileSync(path.join(bookDir(bookId), 'progress.json'), payload)
        writeBookMeta(bookId, data)
      }

    } else if (url === '/reader-book') {
      // 登记/更新一本阅读器里的书（书库列表的元信息）。原件走 /reader-book-file。
      const hash = normalizeReaderHash(data && data.hash)
      if (!hash) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"bad hash"}')
        return
      }
      const patch = { lastOpenedAt: Date.now() }
      if (data.name !== undefined) patch.name = String(data.name).slice(0, 200)
      if (Number.isFinite(data.pages)) patch.pages = data.pages
      if (Number.isFinite(data.entries)) patch.entries = data.entries
      if (data.page !== undefined) patch.page = data.page
      const meta = writeReaderMeta(hash, patch)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, meta }))
      return
    } else if (url === '/reader-book-delete') {
      // 从书库删掉一本（连同原件）
      const hash = normalizeReaderHash(data && data.hash)
      if (!hash) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"bad hash"}')
        return
      }
      fs.rmSync(readerDir(hash), { recursive: true, force: true })
      console.log(`[reader] 已从书库删除 ${hash.slice(0, 12)}…`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    } else if (url === '/tool-record') {
      // 翻译记录：扩展每次翻译成功后落一行，「贴回本页译文」据此把气泡还原回原位。
      // 尽力而为的旁路存储，不参与共读的任何链路（不写 inbox、不触发 agent）。
      const pageUrl = String((data && data.url) || '')
      const translation = String((data && data.translation) || '')
      if (!pageUrl || !translation) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing url or translation' }))
        return
      }
      const rec = {
        id: 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: Date.now(),
        url: pageUrl.slice(0, 2000),
        pageTitle: String((data && data.pageTitle) || '').slice(0, 300),
        kind: data && data.kind === 'image' ? 'image' : 'text',
        original: String((data && data.original) || '').slice(0, 20000),
        translation: translation.slice(0, 20000),
        pageX: Math.round(Number(data && data.pageX) || 0),
        pageY: Math.round(Number(data && data.pageY) || 0),
        pageW: Math.round(Number(data && data.pageW) || 0),
        pageH: Math.round(Number(data && data.pageH) || 0),
        // overlay 版本号：排查"改了代码但页面里跑的还是旧实例"时一眼能看出来
        overlayV: Math.round(Number(data && data.overlayV) || 0),
        // 是否拿到了 DOM 锚点：页面重排（打开侧栏、拉伸窗口）后能不能自动跟随
        anchored: !!(data && data.anchored),
        anchorReason: String((data && data.anchorReason) || '').slice(0, 20),
        // 滚动链里内层滚动容器的个数：掉到 0 就是"只跟窗口滚动"
        chain: Math.round(Number(data && data.chain) || 0),
        // 画布书：拿到 canvas 比例锚点没有、canvas 是否被按新宽度重绘过
        canvasAnchor: !!(data && data.canvasAnchor),
        canvasChanged: !!(data && data.canvasChanged),
        canvasInfo: (data && data.canvasInfo) ? {
          rect: String(data.canvasInfo.rect || '').slice(0, 20),
          intrinsic: String(data.canvasInfo.intrinsic || '').slice(0, 20),
        } : null,
        // 诊断：这段文字落在哪些 frame 里（每个 { url, has, len }）
        frames: Array.isArray(data && data.frames)
          ? data.frames.slice(0, 6).map((f) => ({
            url: String((f && f.url) || '').slice(0, 110),
            has: !!(f && f.has),
            len: Math.round(Number(f && f.len) || 0),
            shadows: Math.round(Number(f && f.shadows) || 0),
            // 正文不在文字节点里时，这两个是判断"画布书"还是"跨源 iframe"的依据
            canvas: (f && f.canvas) ? {
              n: Math.round(Number(f.canvas.n) || 0),
              maxW: Math.round(Number(f.canvas.maxW) || 0),
              maxH: Math.round(Number(f.canvas.maxH) || 0),
            } : null,
            iframes: Array.isArray(f && f.iframes)
              ? f.iframes.slice(0, 6).map((x) => ({
                src: String((x && x.src) || '').slice(0, 110),
                w: Math.round(Number(x && x.w) || 0),
                h: Math.round(Number(x && x.h) || 0),
                readable: !!(x && x.readable),
              }))
              : [],
          }))
          : [],
      }
      fs.appendFileSync(TOOL_HISTORY, JSON.stringify(rec) + '\n')
      console.log(`[tool-record] ${rec.kind} ${rec.url.slice(0, 70)}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: rec.id }))
      return

    } else if (url === '/tool-records-clear') {
      // 清除某页的翻译记录（工具箱的「清除本页记录」）
      const target = String((data && data.url) || '')
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing url' }))
        return
      }
      const all = readToolRecords()
      const kept = all.filter((r) => r.url !== target)
      writeToolRecords(kept)
      console.log(`[tool-records-clear] removed=${all.length - kept.length}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, removed: all.length - kept.length }))
      return

    } else {
      res.writeHead(404); res.end(); return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (e) {
    console.error('[error]', e)
    res.writeHead(500)
    res.end(e.message)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CoRead receiver listening on http://localhost:${PORT}`)
  console.log(`Inbox: ${INBOX_DIR}`)
  console.log(`Books: ${BOOKS_DIR}`)
})

// ── 优雅退出 ─────────────────────────────────────────────────────────────────
// 以前这里没有任何退出处理：stop.bat / start.bat 都是 taskkill /F 直接杀进程，
// 聊天库从来没有被 close() 过，于是 -wal 一直不清空（见 scripts/chat.db.diag-wal.mjs 的判读）。
// 注意：Windows 上 taskkill /F 属于强杀，进程收不到信号，所以任务管理器里结束进程
// 仍会留下 -wal/-shm —— 那种情况下靠下次连接自动恢复，数据不丢。
let _closing = false
function gracefulExit(signal) {
  if (_closing) return
  _closing = true
  console.log(`\n收到 ${signal}，正在关闭…`)
  closeChatStore()
  server.close(() => process.exit(0))
  // 有 SSE 长连接挂着时 close() 的回调可能迟迟不来，兜底 2 秒后强制退出
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', () => gracefulExit('SIGINT'))
process.on('SIGTERM', () => gracefulExit('SIGTERM'))
