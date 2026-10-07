/**
 * 聊天存储（SQLite，2026-10-02 方案 B）：替代 chat_input.jsonl / chat_output.jsonl / .chat_input_cursor
 * / .chat_input_replied 四件套，成为消息的唯一真源。
 *
 * ── 为什么换（旧结构实测画像）──────────────────────────────────────────────
 * 旧 chat_output.jsonl：63.2 MB / 33168 行，其中 **97.1% 的字节是流式累计快照**
 * （31919 条，平均每条回复 56.3 条；抽样 31527 条是最终回复的前缀 = 零新增信息），
 * 真正"消息"只有 567 条。而且：45% 的记录没有 bookKey；255 个时间戳同毫秒有多条记录
 * （时间戳不是唯一键）；提问与回答分在两个文件里靠时间戳 join。
 * 由此派生出一堆补丁与事故：没有主键 → 只能发明"指纹"去重（其多行格式 bug 就是
 * 2026-09-28 重放 288 条的根因）；删除只能整文件重写 → 与 300ms 轮询撞出"读到空文件"
 * → 游标归零；接收端每 100ms 整读 63 MB（40 小时烧掉约 2700 秒 CPU）；配对只能靠
 * 时间序 + 归属启发式（于是 ⚠️ 错误气泡会被当成"回答"）。
 *
 * ── 新结构 ────────────────────────────────────────────────────────────────
 * 线性日志 → 关系表，键都在库里，不再需要外部记账：
 *   conversations  每个 bookKey / 自由对话一行（含归档墓碑信息）
 *   messages       id 自增主键 = 队列游标；status = pending|streaming|ok|failed；
 *                  reply_to 指向被回答的提问（配对从"推断"变成"引用"）；
 *                  attempts 支持失败重试；book/chapter/selected/refs/payload 各归其列
 *   events         graph-hit 这类非消息事件（不进 messages，不再污染配对）
 *   meta           schema 版本、迁移标记
 * 流式快照**不再落盘**：打字机走进程间瞬态通道（inbox/stream.jsonl，可随时清空），
 * 断线重连由接收端补一条"正在生成"状态。
 *
 * 并发：WAL + busy_timeout，agent 与 receiver 可同时读写（旧结构做不到这一点，
 * 只能靠"原子替换 + 游标 + 指纹"绕）。
 *
 * 只做本机文件 IO；不调模型、不发网络请求。
 */

import fs from 'fs'
import path from 'path'

export const SCHEMA_VERSION = 1
export const DEFAULT_DB_FILE = 'chat.db'

/**
 * 本模块需要的最低 Node 版本。
 * 原因：聊天库用的是 Node 内置的 SQLite（`node:sqlite`），不装任何第三方依赖，
 * 所以 Node 版本就是硬门槛——版本不够时连模块都加载不出来。
 * 版本沿革（官方文档）：
 *   v22.5.0        首次加入，但必须加 --experimental-sqlite 启动参数
 *   v22.13.0/v23.4.0 不再需要那个参数
 *   v24.15.0       进入 release candidate（v24.x LTS 线）
 * 本项目按 >=24 要求，并用本机 v24.15.0 实测。
 */
export const MIN_NODE_MAJOR = 24

export function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= MIN_NODE_MAJOR) return
  throw new Error(
    `聊天库需要 Node >= ${MIN_NODE_MAJOR}（当前 v${process.versions.node}）。\n` +
    `  原因：数据存在 SQLite 里，用的是 Node 自带的 node:sqlite 模块，不引入第三方依赖。\n` +
    `  旧版 Node 上该模块要么不存在，要么必须加 --experimental-sqlite 启动参数。\n` +
    `  处理：升级 Node 到 ${MIN_NODE_MAJOR} 或更高（当前 LTS 即满足），然后重新运行。`,
  )
}

assertNodeVersion()

// 动态 import：先查版本再加载模块，这样旧版 Node 上看到的是上面那句清晰报错，
// 而不是一句 "Cannot find module 'node:sqlite'"。
const { DatabaseSync } = await import('node:sqlite')

/** 打开（必要时初始化）数据库。 */
export function openChatStore(dbFile, opts = {}) {
  return new ChatStore(dbFile, opts)
}

export class ChatStore {
  /**
   * @param {string} dbFile 数据库文件路径
   * @param {{readonly?: boolean, create?: boolean}} [opts]
   */
  constructor(dbFile, opts = {}) {
    this.file = dbFile
    const readonly = !!opts.readonly
    if (!readonly) fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    const exists = fs.existsSync(dbFile)
    if (!exists && (readonly || opts.create === false)) {
      throw new Error(`聊天库不存在：${dbFile}`)
    }
    this.db = new DatabaseSync(dbFile, readonly ? { readOnly: true } : {})
    if (!readonly) {
      // WAL：读写并发；NORMAL：每事务 fsync 一次（本机单用户足够安全且快得多）
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.#migrateSchema()
    } else {
      this.db.exec('PRAGMA busy_timeout = 5000')
    }
  }

  #migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',      -- active | archived
        created_at INTEGER,
        updated_at INTEGER,
        archived_at INTEGER,
        archive_memory INTEGER DEFAULT 0,
        archive_graph INTEGER DEFAULT 0,
        note TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,       -- 自增 = 队列游标 + 稳定主键（去重不再需要指纹）
        conv TEXT NOT NULL,                         -- bookKey / 自由对话 key（归属不再是启发式）
        role TEXT NOT NULL,                         -- user | assistant | system
        content TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,                        -- 毫秒时间戳（与旧文件同口径，便于对照）
        status TEXT NOT NULL DEFAULT 'ok',          -- pending | streaming | ok | failed
        attempts INTEGER NOT NULL DEFAULT 0,
        reply_to INTEGER REFERENCES messages(id),   -- 回答指向提问：配对从推断变引用
        error TEXT,
        book_id TEXT, book_title TEXT, chapter TEXT, chapter_uid TEXT, selected_text TEXT,
        refs TEXT,                                  -- JSON 数组（自由模式引用清单）
        payload TEXT                                -- JSON 对象（/归档 等指令的附加字段）
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        conv TEXT DEFAULT '',
        kind TEXT NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    `)
    const v = this.getMeta('schema_version')
    if (!v) this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  close() { try { this.db.close() } catch {} }

  // ── meta ────────────────────────────────────────────────────────────────
  getMeta(key) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))
    return r ? r.value : null
  }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value))
  }

  // ── 对话 ────────────────────────────────────────────────────────────────
  upsertConversation(key, fields = {}) {
    const k = String(key || '')
    if (!k) return
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO conversations(key, title, status, created_at, updated_at, archived_at, archive_memory, archive_graph, note)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
        status = excluded.status,
        updated_at = excluded.updated_at,
        archived_at = COALESCE(excluded.archived_at, conversations.archived_at),
        archive_memory = excluded.archive_memory,
        archive_graph = excluded.archive_graph,
        note = CASE WHEN excluded.note != '' THEN excluded.note ELSE conversations.note END
    `).run(
      k, String(fields.title || ''), String(fields.status || 'active'),
      Number(fields.createdAt || now), Number(fields.updatedAt || now),
      fields.archivedAt ? Number(fields.archivedAt) : null,
      fields.archiveMemory ? 1 : 0, fields.archiveGraph ? 1 : 0, String(fields.note || ''),
    )
  }
  getConversation(key) {
    return this.db.prepare('SELECT * FROM conversations WHERE key = ?').get(String(key || '')) || null
  }
  listConversations({ status } = {}) {
    if (status) return this.db.prepare('SELECT * FROM conversations WHERE status = ? ORDER BY updated_at DESC').all(String(status))
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all()
  }

  // ── 消息 ────────────────────────────────────────────────────────────────
  /**
   * 插入一条消息。
   * @returns {number} 新消息 id
   */
  insertMessage(m) {
    const info = this.db.prepare(`
      INSERT INTO messages(conv, role, content, ts, status, attempts, reply_to, error,
                           book_id, book_title, chapter, chapter_uid, selected_text, refs, payload)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(m.conv || '_common'),
      String(m.role || 'assistant'),
      String(m.content == null ? '' : m.content),
      Number(m.ts || Date.now()),
      String(m.status || 'ok'),
      Number(m.attempts || 0),
      m.replyTo == null ? null : Number(m.replyTo),
      m.error == null ? null : String(m.error),
      m.bookId == null ? null : String(m.bookId),
      m.bookTitle == null ? null : String(m.bookTitle),
      m.chapter == null ? null : String(m.chapter),
      m.chapterUid == null ? null : String(m.chapterUid),
      m.selectedText == null ? null : String(m.selectedText),
      m.refs == null ? null : JSON.stringify(m.refs),
      m.payload == null ? null : JSON.stringify(m.payload),
    )
    return Number(info.lastInsertRowid)
  }

  updateMessage(id, fields = {}) {
    const sets = []
    const vals = []
    for (const [k, col] of [['status', 'status'], ['error', 'error'], ['attempts', 'attempts'], ['content', 'content'], ['replyTo', 'reply_to'], ['payload', 'payload']]) {
      if (fields[k] !== undefined) { sets.push(`${col} = ?`); vals.push(k === 'payload' && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]) }
    }
    if (!sets.length) return
    vals.push(Number(id))
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  getMessage(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id)) || null
  }

  /** 队列：待处理（含失败可重试）的用户消息，按 id 升序 = 到达顺序。 */
  listPending({ limit = 50, includeFailed = true } = {}) {
    const statuses = includeFailed ? "('pending','failed')" : "('pending')"
    return this.db.prepare(
      `SELECT * FROM messages WHERE role = 'user' AND status IN ${statuses} ORDER BY id ASC LIMIT ?`,
    ).all(Number(limit)).map(rowToMessage)
  }

  /** 按对话取消息（可选增量：sinceId）。 */
  listMessages({ conv, sinceId = 0, limit = 0, roles } = {}) {
    const where = ['id > ?']
    const vals = [Number(sinceId) || 0]
    if (conv) { where.push('conv = ?'); vals.push(String(conv)) }
    if (roles && roles.length) { where.push(`role IN (${roles.map(() => '?').join(',')})`); vals.push(...roles) }
    let sql = `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id ASC`
    if (limit) { sql += ' LIMIT ?'; vals.push(Number(limit)) }
    return this.db.prepare(sql).all(...vals).map(rowToMessage)
  }

  /** 全部消息里最大 id（接收端 SSE 增量推送的水位线）。 */
  lastMessageId() {
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get()
    return Number(r ? r.n : 0)
  }

  countByConv() {
    const out = {}
    for (const r of this.db.prepare('SELECT conv, COUNT(*) AS n FROM messages GROUP BY conv').all()) out[r.conv] = Number(r.n)
    return out
  }

  /**
   * 配对：每条 user 消息 → 它的回答（assistant/system）。
   * 旧实现靠"user 之后、下一条 user 之前第一条非空 assistant"推断（还会把 ⚠️ 当成回答），
   * 现在优先用 reply_to 直接引用；没有 reply_to 的历史数据按旧规则回退，且默认跳过失败气泡。
   */
  pairReplies({ conv, includeFailedReplies = false } = {}) {
    const rows = conv
      ? this.db.prepare('SELECT * FROM messages WHERE conv = ? AND role IN (\'user\',\'assistant\',\'system\') ORDER BY ts ASC, id ASC').all(String(conv))
      : this.db.prepare("SELECT * FROM messages WHERE role IN ('user','assistant','system') ORDER BY ts ASC, id ASC").all()
    const byId = new Map(rows.map((r) => [Number(r.id), r]))
    const pairs = new Map()   // user message id → reply（已转成消息对象，字段名与旧 JSONL 一致）
    for (const r of rows) {
      if (r.role === 'user') continue
      if (r.reply_to != null && byId.has(Number(r.reply_to))) { pairs.set(Number(r.reply_to), r); continue }
      if (r.status === 'failed' && !includeFailedReplies) continue
      if (String(r.content || '').startsWith('⚠️') && !includeFailedReplies) continue
      // 回退：时间上最近的前一条 user（同一对话内）
      let best = null
      for (const u of rows) {
        if (u.role !== 'user') continue
        if (conv == null && u.conv !== r.conv) continue
        if (Number(u.ts) <= Number(r.ts) && (!best || Number(u.ts) > Number(best.ts))) best = u
      }
      if (best && !pairs.has(Number(best.id))) pairs.set(Number(best.id), r)
    }
    // 统一出口：调用方拿到的是消息对象（timestamp/bookKey/... 与旧 JSONL 同名字段）
    const out = new Map()
    for (const [uid, r] of pairs) out.set(uid, rowToMessage(r))
    return out
  }

  /** 重建某对话的最近轮次（替代旧 restoreHistories 的文件配对）。 */
  loadTurns(conv, { limit = 40, includeFailed = false } = {}) {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE conv = ? AND role IN ('user','assistant') AND status IN ('ok','failed')
       ORDER BY id DESC LIMIT ?`,
    ).all(String(conv), Number(limit)).reverse()
    const pairs = this.pairReplies({ conv })
    const turns = []
    for (const r of rows) {
      if (r.role !== 'user') continue
      const rep = pairs.get(Number(r.id))
      if (!rep) continue
      if (rep.status === 'failed' && !includeFailed) continue
      turns.push({ user: rowToMessage(r), assistant: rowToMessage(rep) })
    }
    return turns
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  insertEvent({ ts = Date.now(), conv = '', kind, payload = null } = {}) {
    const info = this.db.prepare('INSERT INTO events(ts, conv, kind, payload) VALUES(?,?,?,?)')
      .run(Number(ts), String(conv || ''), String(kind || ''), payload == null ? null : JSON.stringify(payload))
    return Number(info.lastInsertRowid)
  }
  listEvents({ sinceId = 0, limit = 100, kind } = {}) {
    const where = ['id > ?']
    const vals = [Number(sinceId) || 0]
    if (kind) { where.push('kind = ?'); vals.push(String(kind)) }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...vals, Number(limit))
    return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), conv: r.conv, kind: r.kind, payload: r.payload ? JSON.parse(r.payload) : null }))
  }
  lastEventId() {
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get()
    return Number(r ? r.n : 0)
  }

  // ── 删除 ────────────────────────────────────────────────────────────────
  /** 删一场对话的全部消息与事件（事务内，不再整文件重写）。 */
  deleteConversation(conv) {
    const key = String(conv || '')
    if (!key) return { messages: 0, events: 0 }
    const m = this.db.prepare('DELETE FROM messages WHERE conv = ?').run(key)
    const e = this.db.prepare('DELETE FROM events WHERE conv = ?').run(key)
    return { messages: Number(m.changes || 0), events: Number(e.changes || 0) }
  }
  /** 删除指定 id 的消息（清理失败气泡等）。 */
  deleteMessages(ids) {
    const list = (ids || []).map(Number).filter(Number.isFinite)
    if (!list.length) return 0
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try { for (const id of list) n += Number(stmt.run(id).changes || 0); this.db.exec('COMMIT') } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return n
  }

  /**
   * 删除事件（2026-02：用户停止一轮时，那一轮的图命中事件要一并删掉）。
   * 为什么不留：命中事件是"给侧栏点亮节点"的一次性信号，不参与任何持久结构；
   * 留着它只会在断线重连补发时把已清掉的高亮又推回来。
   * @param {{conv?: string, kind?: string}} f 按对话与类型过滤（都不给则删全部）
   * @returns {number} 删掉的行数
   */
  deleteEvents({ conv, kind } = {}) {
    const where = []
    const vals = []
    if (conv != null) { where.push('conv = ?'); vals.push(String(conv)) }
    if (kind != null) { where.push('kind = ?'); vals.push(String(kind)) }
    if (!where.length) return 0
    const r = this.db.prepare(`DELETE FROM events WHERE ${where.join(' AND ')}`).run(...vals)
    return Number(r.changes || 0)
  }

  // ── 统计/维护 ───────────────────────────────────────────────────────────
  stats() {
    const one = (sql) => Number(this.db.prepare(sql).get().n || 0)
    return {
      file: this.file,
      sizeBytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      userMessages: one("SELECT COUNT(*) AS n FROM messages WHERE role='user'"),
      replies: one("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'"),
      systemMessages: one("SELECT COUNT(*) AS n FROM messages WHERE role='system'"),
      pending: one("SELECT COUNT(*) AS n FROM messages WHERE status='pending'"),
      failed: one("SELECT COUNT(*) AS n FROM messages WHERE status='failed'"),
      events: one('SELECT COUNT(*) AS n FROM events'),
      conversations: one('SELECT COUNT(*) AS n FROM conversations'),
    }
  }
  /**
   * 搬运动作（checkpoint）：把暂存本（-wal）里已提交的数据搬回主库（-db），
   * 并把暂存本截断成 0 字节。
   *
   * 为什么要有它：WAL 模式下新数据先写暂存本，主库滞后。搬完之后，
   * 只拷 chat.db 一个文件就是完整的——这是备份的前置动作。
   *
   * 失败不再静默：以前是 `catch {}`，失败了你不知道，会拿到一个不完整的备份。
   * 仍然不抛异常（调用方多为收尾流程），但会返回结果并把原因打到 stderr。
   * @returns {{ok: boolean, busy?: number, log?: number, checkpointed?: number, error?: string}}
   */
  checkpoint({ quiet = false } = {}) {
    try {
      const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      const busy = Number(r?.busy || 0)
      const log = Number(r?.log || 0)
      const checkpointed = Number(r?.checkpointed || 0)
      if (busy !== 0) {
        const msg = `暂存本搬运动作未完成：有 ${busy} 个读操作占用，${log} 帧中只搬回 ${checkpointed} 帧`
        if (!quiet) console.error(`⚠️ ${msg}`)
        return { ok: false, busy, log, checkpointed, error: msg }
      }
      if (checkpointed < log) {
        const msg = `暂存本搬运动作未搬完：${log} 帧中只搬回 ${checkpointed} 帧`
        if (!quiet) console.error(`⚠️ ${msg}`)
        return { ok: false, busy, log, checkpointed, error: msg }
      }
      return { ok: true, busy, log, checkpointed }
    } catch (e) {
      if (!quiet) console.error(`⚠️ 暂存本搬运动作失败：${e.message}`)
      return { ok: false, error: e.message }
    }
  }
}

/** DB 行 → 消息对象（字段名与旧 JSONL 保持一致，消费者尽量不用改）。 */
export function rowToMessage(r) {
  if (!r) return null
  return {
    id: Number(r.id),
    conv: r.conv,
    role: r.role,
    content: r.content,
    timestamp: Number(r.ts),
    status: r.status,
    attempts: Number(r.attempts || 0),
    replyTo: r.reply_to == null ? null : Number(r.reply_to),
    error: r.error || null,
    bookKey: r.conv,
    bookId: r.book_id || undefined,
    bookTitle: r.book_title || undefined,
    chapter: r.chapter || undefined,
    chapterUid: r.chapter_uid || undefined,
    selectedText: r.selected_text || undefined,
    refs: r.refs ? safeJson(r.refs) : undefined,
    payload: r.payload ? safeJson(r.payload) : undefined,
  }
}
function safeJson(s) { try { return JSON.parse(s) } catch { return undefined } }
