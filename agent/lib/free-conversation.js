#!/usr/bin/env node
/**
 * 自由模式 · 多对话（会话隔离 + 归档，2026-11 用户定调）
 *
 * 背景：自由模式原本是**单一**哨兵上下文（FREE_KEY = '__coread_free_mode__'），
 * 所有自由对话共用一份历史/讨论栈。用户要的是网页端那样的多会话：可新建对话、
 * 对话之间完全隔离、归档时可选择"是否保存记忆 / 是否收口为节点加入拓扑图"。
 *
 * 机制（沿用既有哨兵书协议，不新造隔离层）：
 *   · 每个自由对话 = 一个**独立 bookKey**。消息归属、消息区过滤（dataset.book）、
 *     会意讨论栈（topic_stack.json[bookKey]）、LLM 会话历史（histories[bookKey]）、
 *     引用命中隔离全部复用"按书隔离"这一条既有链路，天然互不串味。
 *   · 新对话 key = __coread_free_<8hex>__；默认对话沿用历史 FREE_KEY
 *     （__coread_free_mode__）——不迁移、不重命名，旧栈/旧消息原样可用。
 *   · 本模块只管**注册表**（清单：标题、创建/活跃时间、归档状态）与消息清理；
 *     对话内容本身在 data\sessions\chat.db（2026-10 方案 B：SQLite 取代
 *     chat_input/chat_output.jsonl，见 lib/chat-store.js）。
 *
 * 归属：receiver 与 agent 共用（receiver 提供侧栏用的 HTTP 端点，agent 在归档时
 * 读写状态、清理消息）。纯文件 IO + 纯函数，无进程内状态。
 *
 * 数据：<sessionsDir>/free-conversations.json（2026-10 重构前是 <agentDir>/data/…）
 *   { conversations: [ { id, key, title, createdAt, updatedAt, ticketCount, status,
 *                        archivedAt, archive: { memory, graph } } ] }
 *   status: 'active'（活动列表可见）| 'archived'（已归档——归档即删除，仅留这一条墓碑
 *   记录，说明"这场对话的产物去了哪里"，消息与讨论栈已清）
 */

import fs from 'fs'
import path from 'path'
import { writeFileAtomic } from './atomic-write.js'
import { legacyFreeConversationsFile } from './paths.js'

// 默认自由对话：历史哨兵书 key。旧版本所有自由对话都挂在它下面，保持原样即
// 向后兼容（旧消息、旧 topic_stack 键、旧 sandbox 产物全部继续可用）。
export const LEGACY_FREE_KEY = '__coread_free_mode__'
export const FREE_KEY_PREFIX = '__coread_free_'
const NEW_KEY_RE = /^__coread_free_[0-9a-f]{8}__$/

/** 是否是自由模式会话 key（默认哨兵书 + 新建对话，两类都认） */
export function isFreeKey(key) {
  const k = String(key || '')
  return k === LEGACY_FREE_KEY || NEW_KEY_RE.test(k)
}

/** 生成一个新对话 key（8 位随机十六进制；与 LEGACY 及彼此都不冲突） */
export function newFreeKey(rand = Math.random) {
  let s = ''
  for (let i = 0; i < 8; i++) s += '0123456789abcdef'.charAt(Math.floor(rand() * 16))
  return FREE_KEY_PREFIX + s + '__'
}

/** 注册表文件路径。
 *  2026-10 目录重构后：data\sessions\free-conversations.json（传进来的是 SESSIONS_DIR）。
 *  兼容两种老写法，让升级前/未迁移的数据仍可读：
 *    ① 传的是 agentDir（旧调用点、单测临时目录）→ <dir>/data/free-conversations.json
 *    ② 旧布局原文件确实还在 → 直接读它（迁移脚本跑之前，用户不该看到"对话列表空了"）
 *  只有当老文件真实存在时才回退，避免新装用户在 <dir>/data 下凭空多出一个目录。 */
export function freeConversationFile(dir) {
  const inData = path.join(dir, 'data', 'free-conversations.json')
  if (fs.existsSync(inData)) return inData          // ① 传进来的是老式 agentDir，且老文件还在
  const own = path.join(dir, 'free-conversations.json')
  if (fs.existsSync(own)) return own                // ② 新布局：data\sessions\free-conversations.json
  const legacy = legacyFreeConversationsFile()
  if (fs.existsSync(legacy)) return legacy          // ③ 新位置还没有、老位置有 → 先读老位置（等迁移脚本搬）
  return own                                        // ④ 全新用户：返回新位置
}

/** 从首条用户消息取标题：压平空白的单行，长度上限 max 后截断加 … */
export function deriveTitle(text, max = 24) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 读注册表。返回 { conversations: [] }；文件缺失/损坏 → 空注册表（调用方按"没有对话"
 * 处理，不抛错——receiver 会在首次新建时落盘）。
 */
export function readRegistry(agentDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(freeConversationFile(agentDir), 'utf8'))
    if (obj && Array.isArray(obj.conversations)) {
      return { conversations: obj.conversations.filter((c) => c && isFreeKey(c.key)) }
    }
  } catch {}
  return { conversations: [] }
}

/** 写注册表（先备份后写，与 topic_stack/knowledge-graph 同款闭环） */
export function writeRegistry(agentDir, registry) {
  const file = freeConversationFile(agentDir)
  const out = { conversations: Array.isArray(registry?.conversations) ? registry.conversations : [] }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak') } catch {}
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  return out
}

/** 活动对话（status !== 'archived'），按最近活跃倒序。最近活跃 = updatedAt || createdAt。 */
export function activeConversations(registry) {
  return (registry?.conversations || [])
    .filter((c) => c.status !== 'archived')
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
}

/** 已归档对话（墓碑记录），按归档时间倒序 */
export function archivedConversations(registry) {
  return (registry?.conversations || [])
    .filter((c) => c.status === 'archived')
    .slice()
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
}

/** 按 key 找对话条目 */
export function findConversation(registry, key) {
  const k = String(key || '')
  return (registry?.conversations || []).find((c) => c.key === k) || null
}

/**
 * 新建一个活动对话并落盘。返回 { key, conversation, registry }。
 * title 允许为空（侧栏在首条消息发出后用重命名接口补上）。
 */
export function createConversation(agentDir, { title = '', now = Date.now(), rand = Math.random } = {}) {
  const registry = readRegistry(agentDir)
  const used = new Set(registry.conversations.map((c) => c.key))
  let key = newFreeKey(rand)
  for (let i = 0; i < 20 && (used.has(key) || key === LEGACY_FREE_KEY); i++) key = newFreeKey(rand)
  const conversation = {
    key,
    title: String(title || '').trim(),
    createdAt: now,
    updatedAt: now,
    status: 'active',
  }
  registry.conversations.push(conversation)
  writeRegistry(agentDir, registry)
  return { key, conversation, registry }
}

/** 把历史遗留的默认对话补进注册表（首次使用多对话时调用；已存在则原样返回） */
export function ensureLegacyConversation(agentDir, { now = Date.now() } = {}) {
  const registry = readRegistry(agentDir)
  const existing = findConversation(registry, LEGACY_FREE_KEY)
  if (existing) return { conversation: existing, registry }
  const conversation = {
    key: LEGACY_FREE_KEY,
    title: '默认对话',
    createdAt: now,
    updatedAt: now,
    status: 'active',
  }
  registry.conversations.push(conversation)
  writeRegistry(agentDir, registry)
  return { conversation, registry }
}

/** 重命名对话（title 空串 = 回到"新对话"）。返回更新后的条目或 null。 */
export function renameConversation(agentDir, key, title, { now = Date.now() } = {}) {
  const registry = readRegistry(agentDir)
  const c = findConversation(registry, key)
  if (!c) return null
  c.title = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 40)
  c.updatedAt = now
  writeRegistry(agentDir, registry)
  return c
}

/**
 * 记一次对话活动（每次提问/回复都会经 receiver /chat 走到这里）：
 * 刷新 updatedAt，必要时用首条消息补默认标题。找不到条目就先登记再更新——
 * 老版本默认对话（历史遗留）第一次发言时自动补进注册表。
 */
export function touchConversation(agentDir, key, { title = '', now = Date.now() } = {}) {
  if (!isFreeKey(key)) return null
  const registry = readRegistry(agentDir)
  let c = findConversation(registry, key)
  if (!c) {
    c = { key: String(key), title: '', createdAt: now, updatedAt: now, status: 'active' }
    registry.conversations.push(c)
  }
  c.updatedAt = now
  const t = deriveTitle(title)
  if (t && !c.title) c.title = t
  writeRegistry(agentDir, registry)
  return c
}

/**
 * 归档对话（归档即删除）：registry 里只留一条墓碑记录（status='archived'），
 * 活动列表不再显示、消息与讨论栈由调用方按 key 清理。
 * @param {string} agentDir agent 目录
 * @param {string} key 对话 key
 * @param {object} archive { memory:boolean, graph:boolean } 归档时执行了哪两项
 * @param {string} note 产物说明（侧栏「已归档」列表里显示，如"已保存记忆 / 已收编 2 个节点"）
 */
export function archiveConversation(agentDir, key, { archive = null, note = '', now = Date.now() } = {}) {
  const registry = readRegistry(agentDir)
  const c = findConversation(registry, key)
  if (!c) return null
  c.status = 'archived'
  c.archivedAt = now
  c.updatedAt = now
  c.archive = {
    memory: !!(archive && archive.memory),
    graph: !!(archive && archive.graph),
    note: String(note || '').slice(0, 200),
  }
  writeRegistry(agentDir, registry)
  return c
}

/** 彻底删除对话条目（含墓碑记录）。返回是否删掉了东西。 */
export function dropConversation(agentDir, key) {
  const registry = readRegistry(agentDir)
  const before = registry.conversations.length
  registry.conversations = registry.conversations.filter((c) => c.key !== String(key || ''))
  if (registry.conversations.length === before) return false
  writeRegistry(agentDir, registry)
  return true
}

/**
 * 删除某个对话在聊天存档里的全部消息（归档即删除用）。
 * 逐行过滤 chat_input.jsonl / chat_output.jsonl（按 bookId / bookKey 归属），
 * 有变化才写回；写回前留 .bak（与其它存档同款，误删可人工恢复）。
 * @returns {{ input: number, output: number }} 各自删掉的行数
 */
export function deleteConversationMessages(inboxDir, key) {
  const k = String(key || '')
  const out = { input: 0, output: 0 }
  if (!k) return out
  const purge = (file, field) => {
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
    const lines = raw.split('\n')
    const kept = []
    let removed = 0
    for (const line of lines) {
      if (!line.trim()) { kept.push(line); continue }
      let d = null
      try { d = JSON.parse(line) } catch { kept.push(line); continue }
      if (d && typeof d === 'object' && String(d[field] || '') === k) { removed++; continue }
      kept.push(line)
    }
    if (!removed) return 0
    try { fs.copyFileSync(file, file + '.bak-conv-delete') } catch {}
    // 原子替换（2026-09-30）：agent 每 300ms 轮询读 chat_input，原地 writeFileSync 的
    // "先截断再写"空窗会让它读到 0 行 → 游标被钳成 0 → 全量重放（2026-09-28 实例）
    if (!writeFileAtomic(file, kept.join('\n'))) fs.writeFileSync(file, kept.join('\n'))
    return removed
  }
  out.input = purge(path.join(inboxDir, 'chat_input.jsonl'), 'bookId')
  out.output = purge(path.join(inboxDir, 'chat_output.jsonl'), 'bookKey')
  return out
}
