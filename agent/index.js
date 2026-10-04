#!/usr/bin/env node
/**
 * CoRead 共读 agent — 自包含交互式会话
 *
 * 在 tmux 里常驻运行，读取标准输入（用户输入 + inject.sh 注入的触发行），
 * 与用户实时讨论标注，调用 LLM API 生成回应。不依赖任何外部 CLI。
 *
 * 启动：
 *   npm start            # 模型 API 在插件侧栏「⋯ → 模型 API 配置」里填（推荐）
 *   cp .env.example .env # 或在 .env 里填 COREAD_API_KEY 等配置（CLI / 无插件场景）
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { judgeSelfPortrait } from './lib/self-portrait.js'
import { processStackMessage, makeStackEntry, collectStackCites } from './lib/topic-stack.js'
import { createGraph, userAncestry, resolveReferences } from './lib/knowledge-graph.js'
import { consolidateThreadQuestion } from './lib/thread-question.js'
import { consolidateDiscussion, addDerivedEdge, addCitationEdges, pruneRedundantCitationEdges, groupExcerpts } from './lib/graph-consolidate.js'
import { segmentStack } from './lib/segment-stack.js'
import { l3Block } from './lib/l3-context.js'  // L3 上下文渲染（2026-10 定调：来源见模块头）
import { parseMessage } from './lib/chat-input.js'  // 引用解析输入剥离引文：只认用户自己的话（见 resolveCitations）
import { resolveApiConfig, isConfigured } from './lib/api-config.js'  // 模型 API 配置：插件侧栏可写，.env 为回退
// 聊天存储（2026-10-02 方案 B）：SQLite 取代 chat_input/chat_output.jsonl + 游标 + 指纹台账。
// id = 队列游标；status = 已回复/待重试；reply_to = 提问↔回答的直接引用。见 lib/chat-store.js 头部。
import { openChatStore } from './lib/chat-store.js'
// 自由模式多对话（2026-11 用户定调）：每个自由对话 = 一个独立 bookKey（隔离链路复用
// "按书隔离"），注册表管标题/活跃时间/归档状态；归档时可选择保存记忆、收编进正式拓扑图。
import { isFreeKey, LEGACY_FREE_KEY, archiveConversation } from './lib/free-conversation.js'
// 错误分类（2026-10）：网络层失败（fetch failed / ECONNRESET / 超时）此前一次都不重试，
// 成因与机制见 lib/error-classify.js 头部注释
import { canRetryError, isNetworkError, networkErrorMessage, isFatalConfigError, fatalErrorMessage } from './lib/error-classify.js'
// 收件箱去重台账 + 游标语义（2026-09-30 机制级修复）已随 SQLite 存储层退役：
// "这条处理过没有"现在是 messages.status 一列，"到哪了"是自增 id——游标文件、指纹台账、
// decideCursor 判定全部不再需要。lib/inbox-dedupe.js 仍留着（迁移脚本用），运行时不再引用。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = __dirname
const RECEIVER_DIR = path.join(__dirname, '..', 'receiver')
const INBOX_DIR = path.join(RECEIVER_DIR, 'inbox')
const BOOKS_DIR = path.join(RECEIVER_DIR, 'books')
const ANNOTATIONS = path.join(INBOX_DIR, 'annotations.jsonl')
const CURSOR_FILE = path.join(INBOX_DIR, '.agent_cursor')
// 聊天存储（方案 B）：唯一真源。旧 chat_input.jsonl / chat_output.jsonl 迁移后原样保留，
// 只作历史备份，不再读写（见 lib/chat-migrate.js）。
const CHAT_DB = path.join(INBOX_DIR, 'chat.db')
// 瞬态打字机通道：流式累计文本走这里（侧栏据此渲染），**不入档**——旧结构里它占了
// chat_output 97.1% 的字节（31919 条快照，全是最终回复的前缀，零信息量）。
// 启动时清空；接收端按字节偏移 tail，文件被清空时靠"长度回缩"识别并复位。
const STREAM_FILE = path.join(INBOX_DIR, 'stream.jsonl')
let _store = null
function chatStore() {
  if (!_store) _store = openChatStore(CHAT_DB)
  return _store
}
/**
 * 退出前关掉聊天库。**每次退出都必须走这里。**
 * 为什么：SQLite 在最后一个连接正常 close() 时，会自动把暂存本（-wal）搬回主库、
 * 并删掉 -wal 与 -shm。不 close 直接 process.exit(0) 的话这两个文件会一直留着，
 * 主库停在旧版本（本机实测过：300 条插入全留在 1.2 MB 的暂存本里）。
 * 数据不会因此损坏（下次连接会自动恢复），但"干净退出"这道安全网就失效了。
 */
function closeChatStore() {
  if (!_store) return
  try { _store.close() } catch (e) { console.error(`⚠️ 关闭聊天库失败：${e.message}`) }
  _store = null
}
function resetStreamFile() {
  try { fs.writeFileSync(STREAM_FILE, '') } catch {}
}
// 处理步骤状态（2026-10）：侧栏"正在…"文案数据源。独立文件——不入库，纯瞬态。
const AGENT_STATE_FILE = path.join(INBOX_DIR, 'agent_state.jsonl')
// 致命故障（余额/鉴权）暂存：say() 捕获时登记，poller 读到后中止本轮队列并暂停。
// 用"取走即清空"的语义，避免一次故障被后续消息重复归因。
let _lastFatalError = null
function takeFatalError() {
  const e = _lastFatalError
  _lastFatalError = null
  return e
}
const STOP_FILE = path.join(AGENT_DIR, '.stop')  // stop.bat 写入哨兵 → poller 检测后优雅保存退出
const JOURNAL_FILE = path.join(AGENT_DIR, 'session_journal.jsonl')  // 会话流水账：强杀/断电后启动时恢复记忆
const TOPIC_STACK_FILE = path.join(AGENT_DIR, 'topic_stack.json')  // 会意讨论栈：跨会话持久化（进行中的讨论跨会话恢复），按书隔离 { bookKey: 栈 }
const GRAPH_FILE = path.join(AGENT_DIR, 'data', 'knowledge-graph.json')  // 会意图持久文件（§5.3：一张图一个文件）
const RESULTS_GRAPH_FILE = path.join(AGENT_DIR, 'scripts', 'data', 'knowledge-graph-results.json')  // 离线固化产物（loadGraph 回退源，与 receiver /graph 一致）
// 自由模式（2026-09 定调；2026-11 扩为多对话）：侧栏里的独立上下文，每个自由对话
// 一个 bookKey（__coread_free_<8hex>__，默认对话沿用历史哨兵 __coread_free_mode__，
// 见 lib/free-conversation.js），对话之间历史/讨论栈/命中全隔离。对话内容默认是
// 临时的（不写 journal、不收口固化）——归档时由用户勾选：保存记忆（profile/soul）、
// 收编进正式拓扑图（完整固化）、或都不留（见 archiveFreeConversation）。
const FREE_KEY = LEGACY_FREE_KEY
const SELF_PORTRAIT_FILE = path.join(AGENT_DIR, 'self-portrait.md')  // 用户情况与观念画像：总结式维护，不进头部

// 模型 API 配置（2026-10）：真源 = agent/api-config.json（插件侧栏「⋯ → 模型 API 配置」
// 经 receiver 写入），.env 的 COREAD_* 作为回退（见 lib/api-config.js）。
// 每次 LLM 调用前重读 → 插件里改完立即生效，不需要重启 agent。
// 未配置时**不再启动即退出**：旧行为会让 agent 直接死掉，用户在插件里填好配置也没人应答；
// 现在改为启动告警 + 调用时报错（requireApiConfig），配置补齐后下一次提问即可用。
if (!isConfigured(resolveApiConfig())) {
  console.warn('⚠️  模型 API 未配置：请在插件侧栏右上角「⋯ → 模型 API 配置」里填写；')
  console.warn('    或在 agent/.env 里设置 COREAD_API_BASE / COREAD_API_KEY（可选 COREAD_MODEL）。')
}

// ── 文件读取 ────────────────────────────────────────────────────────────────
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}
// 「读失败」与「文件不存在 / 内容为空」必须分开（2026-09-30 机制级修复）：
// 瞬时故障（Windows 共享冲突 / 权限 / rename 空窗）返回 null，调用方据此**跳过本轮**；
// 绝不能像 readIfExists 那样把它们吞成 ''，再被下游兜底成 0——0 在队列语义里等于
// "从第 0 行重扫"，2026-09-28 正是这样重放了 288 条旧提问（见 lib/inbox-dedupe.js 头部）。
function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return ''    // 文件不存在 = 空，不是故障
    console.log(`  ⚠️ 读取失败（按"未知"处理，不当作空值）: ${p} — ${(e && (e.code || e.message)) || e}`)
    return null
  }
}

// ── 用户书籍足迹（跨书联动的轻量数据源） ──────────────────────────────────
// 只统计真实微信读书的书（meta.json 里有 wereadBookId），自动排除测试书。
// 跨书联动不依赖原文检索/分词，直接让 AI 用自身知识库对这些书名做主题关联。
function userBookTitles() {
  const titles = []
  try {
    for (const name of fs.readdirSync(BOOKS_DIR)) {
      const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json'))
      if (!meta || !meta.wereadBookId || !meta.bookTitle) continue
      titles.push(String(meta.bookTitle).replace(/\s+/g, ' ').trim())
    }
  } catch {}
  return [...new Set(titles)].sort()
}

// ── 上下文加载（启动时一次性构建；system 只含静态内容，不再重建） ────────────
// 2026-09 画像下沉：profile/soul/书籍足迹从 system 移到 personaBlock（本次消息头部）。
// system 只剩【重要】头 + AGENT.md（静态）——MEMORIZE 合并、会话结束固化
// （saveSessionMemory 重写 profile/soul）、新书足迹都不再触碰 system；
// 前缀缓存因此稳定：跨会话恢复历史后，[静态S + 恢复历史] 前缀可跨会话命中。
function buildSystemInstruction() {
  const rules = readIfExists(path.join(AGENT_DIR, 'AGENT.md'))
  return [
    '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n',
    rules,
  ].join('')
}

// 易变人格块（画像下沉，2026-09）：每次 say 组装时动态读文件拼入本次消息头部。
// 变化只落在"本次消息"（每次本来就是新内容），不触碰历史前缀。
// 2026-09 防跑题（09-07 火星报段落教训）：整块以【背景档案】身份出现，明确"不是用户
// 本轮发言"——此前画像原样拼在提问前，模型把"自述/自陈"式概括当成用户本轮原话，
// 答非所问并编造"你自己说过…"。档案内容禁止被转述/引用为用户原话（AGENT.md 同款规则）。
function personaBlock() {
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  const soul = readIfExists(path.join(AGENT_DIR, 'soul.md'))
  const titles = userBookTitles()
  const bookSection = titles.length
    ? '\n\n【用户书籍足迹】（已添加引用/划线的书，用于跨书联想）\n' + titles.map((t) => `- 《${t}》`).join('\n')
    : ''
  return '【背景档案】（profile.md / soul.md / 书籍足迹的内容——不是用户本轮发言，' +
    '只用于理解用户背景；即使出现"自述/自陈/你说过"式表述，也不得转述或引用为用户原话）\n\n' +
    `【用户阅读画像】\n${profile}\n\n【你的自画像】\n${soul}${bookSection}`
}

// ── 侧栏聊天 I/O（SQLite）────────────────────────────────────────────────────
// 一条消息 = 库里一行。bookKey 就是 conversations.key（删除据此精确清理，不再靠 bookKey 过滤重写文件）。
// opts: { status='ok'|'failed', error, replyTo, bookId/bookTitle/chapter/chapterUid/selectedText }
function appendChatOutput(role, content, bookKey, opts = {}) {
  try {
    return chatStore().insertMessage({
      conv: String(bookKey || '_common'),
      role,
      content: stripCodeBlocks(content),
      ts: Date.now(),
      status: opts.status || 'ok',
      error: opts.error,
      replyTo: opts.replyTo,
      bookId: opts.bookId, bookTitle: opts.bookTitle, chapter: opts.chapter,
      chapterUid: opts.chapterUid, selectedText: opts.selectedText,
    })
  } catch (e) {
    console.log(`  ⚠️ 写库失败：${e.message}`)
    return 0
  }
}

// 流式快照 → 瞬态通道（不入档）。content 存累计文本，侧栏据 _stream 渲染打字机；
// 接收端按字节偏移 tail，收到 seq=-1 把气泡标记完成。
let _streamSeq = 0
function appendChatOutputStream(content, bookKey) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify({
      role: 'assistant',
      content: stripCodeBlocks(content),
      _stream: _streamSeq++,
      timestamp: Date.now(),
      ...(bookKey ? { bookKey } : {}),
    }) + '\n')
  } catch {}
}
// 流结束标记：侧栏收到 _stream === -1 后把该条流标记为完成
function appendChatOutputStreamEnd(bookKey) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify({
      role: 'assistant', content: '', _stream: -1, timestamp: Date.now(),
      ...(bookKey ? { bookKey } : {}),
    }) + '\n')
  } catch {}
}

// 会意图命中事件（topic-library-design.md §5.4④）：引用解析命中旧知识点 → 记一条事件
// （events 表，不进 messages——它没有正文，混在消息里会污染配对与 /history）。
// bookKey = 命中所属书；侧栏图视图据此高亮命中节点的 root→recent 路径并集。
function appendGraphHit(hits, reason, bookKey) {
  try {
    chatStore().insertEvent({
      conv: String(bookKey || ''),
      kind: 'graph-hit',
      payload: { hits: hits || [], reason: String(reason || '').slice(0, 200), bookKey: String(bookKey || '') },
    })
  } catch {}
}

// 处理步骤状态行（2026-10）：agent 当前处理步骤 → receiver 轮询转发 SSE（type=agent-state）
// → 侧栏思考气泡按步骤显示文案（resolve=检索旧知识点 / answer=组织回答）。
// 瞬态行：累计 100 次后裁剪保留最近 100 行（防无限增长）。
let _stateAppends = 0
function appendAgentState(step, bookKey) {
  try {
    fs.appendFileSync(AGENT_STATE_FILE, JSON.stringify({ step, bookKey: String(bookKey || ''), timestamp: Date.now() }) + '\n')
    if (++_stateAppends % 100 === 0) {
      const lines = (readIfExists(AGENT_STATE_FILE) || '').trim().split('\n').filter(Boolean)
      if (lines.length > 200) fs.writeFileSync(AGENT_STATE_FILE, lines.slice(-100).join('\n') + '\n')
    }
  } catch {}
}
// 侧栏消息队列 = 库里"待处理"的行。旧实现读文件 + 游标 + 指纹台账三件套来判断"哪条还没答"，
// 现在就是一条 SQL：status IN ('pending','failed') 按 id 升序（id 即到达顺序）。
// failed 也入队 = 失败会重试（旧实现"调用前记指纹"导致失败的消息永不重试，2026-09-28 的 213 条就是这样）。
function readPendingMessages(limit = 10) {
  try { return chatStore().listPending({ limit }) } catch (e) {
    console.log(`  ⚠️ 读取待处理消息失败：${e.message}`)
    return []
  }
}
function markMessage(id, fields) {
  try { chatStore().updateMessage(id, fields) } catch (e) { console.log(`  ⚠️ 更新消息状态失败：${e.message}`) }
}

// ── 标注队列 ────────────────────────────────────────────────────────────────
function readAnnotations() {
  const raw = readIfExists(ANNOTATIONS)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

function getCursor() {
  const v = parseInt(readIfExists(CURSOR_FILE), 10)
  return Number.isFinite(v) ? v : 0
}

function setCursor(n) { fs.writeFileSync(CURSOR_FILE, String(n)) }

// ── 章节原文上下文 ───────────────────────────────────────────────────────────
function chapterFileName(chapter) {
  return chapter ? chapter.replace(/[^\w一-龥]/g, '_').slice(0, 40) : ''
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

function bookDirNames(bookId, bookTitle = '') {
  if (!bookId) return []
  const baseId = baseBookId(bookId)
  // 归一化后的 baseId 是权威目录，排在第一位
  const names = [baseId]
  const targetTitle = normalizeText(bookTitle)

  try {
    // 向后兼容：扫描已有的 k-suffix 历史目录（迁移前的遗留数据）
    const legacyDirs = fs.readdirSync(BOOKS_DIR)
      .filter(name => name !== baseId && name.startsWith(`${baseId}k`))
      .map(name => {
        const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json')) || {}
        return { name, updatedAt: meta.updatedAt || 0 }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => s.name)
    names.push(...legacyDirs)
  } catch {}

  // 书名模糊匹配（用于 bookId 未知但知道书名的场景）
  if (targetTitle) {
    try {
      const titleMatches = fs.readdirSync(BOOKS_DIR)
        .filter(name => !names.includes(name))
        .filter(name => {
          const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json')) || {}
          return normalizeText(meta.bookTitle) === targetTitle
        })
      names.push(...titleMatches)
    } catch {}
  }

  return [...new Set(names)]
}

function readChapterText(bookId, chapterUid, chapter, selectedText, bookTitle = '') {
  if (!bookId) return ''
  const exactMatches = []
  const fuzzyMatches = []
  for (const dirName of bookDirNames(bookId, bookTitle)) {
    const dir = path.join(BOOKS_DIR, dirName, 'chapters')
    const candidates = [
      chapterUid && path.join(dir, `${chapterUid}.txt`),
      chapter && path.join(dir, `${chapterFileName(chapter)}.txt`),
    ].filter(Boolean)

    for (const file of candidates) {
      const text = readIfExists(file)
      if (!text) continue
      if (hasExactSelection(text, selectedText)) exactMatches.push(text)
      else if (textHasSelection(text, selectedText)) fuzzyMatches.push(text)
    }

    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue
        const text = readIfExists(path.join(dir, name))
        if (!selectedText) continue
        if (hasExactSelection(text, selectedText)) exactMatches.push(text)
        else if (textHasSelection(text, selectedText)) fuzzyMatches.push(text)
      }
    } catch {}
  }

  return exactMatches[0] || fuzzyMatches[0] || ''
}

function chapterTexts(bookId, chapter, bookTitle = '') {
  if (!bookId || !chapter) return []
  const prefix = chapterFileName(chapter)
  const compactChapter = normalizeText(chapter)
  const texts = []
  for (const dirName of bookDirNames(bookId, bookTitle)) {
    const dir = path.join(BOOKS_DIR, dirName, 'chapters')
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    const chunkTexts = names
      .filter(name => name.endsWith('.txt'))
      .sort()
      .map(name => {
        const text = readIfExists(path.join(dir, name))
        const compactHead = normalizeText(text.slice(0, 200))
        const namedForChapter = name === `${prefix}.txt` || name.startsWith(`${prefix}_`)
        return namedForChapter || (compactChapter && compactHead.includes(compactChapter)) ? text : ''
      })
      .filter(Boolean)
    texts.push(...chunkTexts)
  }
  return [...new Set(texts)]
}

function readProgress(bookId, bookTitle = '') {
  if (!bookId) return null

  let best = null
  for (const name of bookDirNames(bookId, bookTitle)) {
    const p = readJsonIfExists(path.join(BOOKS_DIR, name, 'progress.json'))
    if (p && (!best || (p.updatedAt || 0) > (best.updatedAt || 0))) best = p
  }
  return best
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function selectedNeedles(selectedText) {
  const source = String(selectedText || '')
  const pieces = source
    .split(/[。！？；，,.!?:：;、“”"'\n\r\t（）()]+/)
    .map(s => normalizeText(s))
    .filter(s => s.length >= 10)
  const words = source.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []
  return [...new Set([normalizeText(source), ...pieces, ...words])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

function textHasSelection(text, selectedText) {
  if (!selectedText) return true
  const compact = normalizeText(text)
  return selectedNeedles(selectedText).some(needle => compact.includes(normalizeText(needle)))
}

function hasExactSelection(text, selectedText) {
  if (!selectedText) return true
  return normalizeText(text).includes(normalizeText(selectedText))
}

function looseIndexOf(text, needle) {
  if (!needle) return -1
  const exact = text.indexOf(needle)
  if (exact !== -1) return exact

  const compactNeedle = normalizeText(needle)
  if (!compactNeedle) return -1

  let compact = ''
  const positions = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    positions.push(i)
    compact += text[i]
  }
  const compactIdx = compact.indexOf(compactNeedle)
  return compactIdx === -1 ? -1 : positions[compactIdx]
}

function selectionMatch(text, selectedText) {
  for (const needle of selectedNeedles(selectedText)) {
    const idx = looseIndexOf(text, needle)
    if (idx !== -1) return { idx, length: needle.length }
  }
  return { idx: -1, length: 0 }
}

function chapterWindow(bookId, chapterUid, selectedText, chapter, bookTitle = '') {
  const text = readChapterText(bookId, chapterUid, chapter, selectedText, bookTitle)
  if (!text) return ''
  const match = selectionMatch(text, selectedText)
  const idx = match.idx
  if (idx === -1) return text.slice(0, 600)
  const start = Math.max(0, idx - 300)
  const end = Math.min(text.length, idx + Math.max(match.length, selectedText.length) + 300)
  return text.slice(start, end)
}

function readProgressContext(bookId, chapter, selectedText, bookTitle = '') {
  const progress = readProgress(bookId, bookTitle)
  const chunks = chapterTexts(bookId, chapter, bookTitle)
  const joined = chunks.join('\n\n')
  if (!progress && !joined) return ''

  let p = ''
  if (progress) {
    const bits = []
    if (progress.chapterTitle || chapter) bits.push(`当前章节：${progress.chapterTitle || chapter}`)
    if (progress.chapterUid) bits.push(`chapterUid=${progress.chapterUid}`)
    if (Number.isFinite(progress.chapterOffset)) bits.push(`offset=${progress.chapterOffset}`)
    p += `[本章已读进度概览]\n${bits.join('；')}\n`
    if (progress.summary) p += `微信读书当前位置摘要：${progress.summary}\n`
  }

  if (!joined) return p.trim()

  const selectedIdx = looseIndexOf(joined, selectedText)
  const offset = Number.isFinite(progress?.chapterOffset) ? progress.chapterOffset : 0
  const end = selectedIdx !== -1 ? selectedIdx : (offset > 0 ? Math.min(joined.length, offset) : joined.length)
  const start = Math.max(0, end - 1500)
  const windowText = joined.slice(start, end).trim()
  if (windowText) {
    p += `\n[当前进度前文窗口]\n${windowText}\n`
  }
  return p.trim()
}

// ── LLM API ──────────────────────────────────────────────────────────────────
let SYSTEM = buildSystemInstruction()

// 会话上下文按书隔离（AI-001）：key = baseBookId | '_common' | '_meta'
// 读书 X 时的标注讨论、书绑定聊天、自由消息都进 history[X]；切书后互不污染。
// 无书签消息进 '_common'；记忆重写这类元任务进 '_meta'，不进任何书的上下文。
const histories = new Map()  // key -> [{ role: 'user'|'assistant', content: string }]
function histFor(key) {
  if (!histories.has(key)) histories.set(key, [])
  return histories.get(key)
}
let currentBookKey = ''  // 后端跟踪的"正在读的书"（baseBookId），自由消息归属用

// ── 历史惰性截尾（2026-09 用户定调 + 缓存实测）───────────────────────────────
// 前缀缓存只认"从头连续相同"：历史必须**追加式**（每次 = 上次 + 末尾新消息），
// 命中率实测 95%+；每轮滑一条的窗口会让全部历史失配（实测 0%），不可取。
// 输入有界靠"惰性截尾"：平时纯追加（缓存友好），总 token 超预算（64K ≈100 轮）
// 时才从最老处整条切掉一批、切到裁剪目标（40 轮 ≈25.7K）——留 ~60 轮增长余量，
// 避免"切完紧贴预算、追加一条又触发"（那样裁剪频率 = 滑动窗口，失配全废）。
// 被切的是最老消息，长期价值已被会意图（L3 全量带回）/ 会意栈（跨会话持久化）/
// profile·soul 兜底，不丢数据。
// 参数（2026-09 用户拍板）：BUDGET 64K（1M 窗口下请求体量主开关，占 92% 是历史）；
// TRIM 40 轮（承接下限仍充裕：单章讨论 3~10 轮）。裁剪间隔 ≈ (64K-25.7K)/643 ≈ 60 轮。
const HIST_TOKEN_BUDGET = 64000            // 预算上限：超过才触发裁剪（≈99 轮）
const HIST_TRIM_TARGET = 25720             // 裁剪目标：40 轮 × 实测每轮 643 token（≈40 轮）
const TOKEN_PER_CHAR = 0.62                // 实测校准：真实历史 19.9 万字符 = 12.2 万 token（字符/token≈1.6）
// 截尾游标（2026-10 用户定调）：{ bookKey: 累计切掉的消息条数 }——histories 截尾点持久化，
// 重启恢复时从游标处续推（chat 文件里游标之后的轮次 = 在线截尾后的全部内容，纯追加），
// 不用再"全量重建后重放截尾"。
const HIST_CURSOR_FILE = path.join(AGENT_DIR, 'hist_cursors.json')
let histCutCursors = {}   // 运行时态：{ bookKey: 累计切掉条数 }；main 启动时 loadHistCursors() 加载
function loadHistCursors() {
  try {
    const o = JSON.parse(readIfExists(HIST_CURSOR_FILE))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch { return {} }
}
function saveHistCursors() {
  try { fs.writeFileSync(HIST_CURSOR_FILE, JSON.stringify(histCutCursors)) } catch {}
}
function estimateTokens(text) {
  // 校准后的 token 估算（2026-09 实测）：中文为主的混合文本 1 字符 ≈ 0.62 token
  return Math.ceil(String(text || '').length * TOKEN_PER_CHAR)
}
function trimHistoryByBudget(key, hist) {
  if (!hist.length) return
  let total = 0
  for (const m of hist) total += estimateTokens(m.content)
  if (total <= HIST_TOKEN_BUDGET) return   // 未超预算：纯追加，不动序列（缓存前缀保持，95%+ 命中）
  // 超预算：从最新往前数，保留最近一组 ≤ TRIM_TARGET 的消息，更老的全部整条切掉（最新一条永不切）
  let acc = 0
  let cut = 0
  for (let i = hist.length - 1; i >= 0; i--) {
    acc += estimateTokens(hist[i].content)
    if (acc > HIST_TRIM_TARGET && i < hist.length - 1) { cut = i + 1; break }
  }
  if (cut > 0) {
    if (cut % 2 === 1) cut += 1   // 切偶数条：保留段必须从 user 消息开始（消息序列 user/assistant 交替，
                                  // 游标按完整轮次计数，恢复 slice 后直接成对）
    const removed = hist.splice(0, cut)
    histCutCursors[key] = (histCutCursors[key] || 0) + removed.length
    saveHistCursors()
    console.log(`  [hist] ${key} 惰性截尾 ${removed.length} 条（预算 ${HIST_TOKEN_BUDGET}，切至 ${HIST_TRIM_TARGET}，剩 ${hist.length} 条，游标 ${histCutCursors[key]}）——长期内容由会意图 L3 / 栈 / 画像兜底`)
  }
}

function totalHistoryLength() {
  let n = 0
  for (const [k, h] of histories) {
    if (k !== '_meta') n += h.length
  }
  return n
}

// ── 历史启动恢复（2026-09 用户定调：跨会话需要旧消息）────────────────────────
// histories 是内存态、重启即空——跨会话承接断裂（进行中讨论的轮次在主回复
// prompt 里丢失，模型不知道之前聊到哪）。启动时从 chat_input/chat_output
// 重建每本书的最近轮次。配对规则与 lib/chat-input.js loadReplyByTs 一致：
// user 之后、下一条 user 之前的第一条不带 _stream 的 assistant 全文；
// 未配对的 user（最新一条等回复中）不恢复。
// 恢复起点 = 截尾游标（hist_cursors.json，2026-10 用户定调）：在线每次惰性截尾
// 都把累计切掉条数落盘——chat 文件里游标之后的轮次 = 在线截尾后的全部内容
// （截尾后只纯追加），从这里续推即得在线末尾状态，跨会话前缀可命中
// （system 已画像下沉，静态稳定）。
function restoreHistories() {
  try {
    const store = chatStore()
    const convs = Object.keys(store.countByConv())
    // storeText 与 say() / 旧文件版完全同款构造（AI-017：不含章节窗口，防书摘录当用户的话）
    const storeTextOf = (u) => (u.selectedText
      ? `【划线】《${u.bookTitle || ''}》${u.chapter || ''}\n划线原文：${u.selectedText}\n我的提问：${u.content}`
      : u.content)
    for (const key of convs) {
      if (key === '_meta') continue
      // 库里直接取"成轮的最近 N 轮"：提问 + 它的回答（reply_to 直连，未配对的回答不成轮）
      const turns = store.loadTurns(key, { limit: 60 })
      if (!turns.length) continue
      const list = []
      for (const t of turns) {
        list.push({ role: 'user', content: storeTextOf(t.user) })
        list.push({ role: 'assistant', content: stripCodeBlocks(stripMemorize(t.assistant.content)) })
      }
      const hist = histFor(key)
      // 2026-10 游标方案（用户定调）：截尾点已由 trimHistoryByBudget 落盘（累计切掉条数）——
      // 从游标处续推即得在线末尾状态，跨会话前缀可命中（不再全量重建后逐轮重放截尾）。
      const skip = Math.min(histCutCursors[key] || 0, list.length)
      for (let i = skip; i < list.length; i++) hist.push(list[i])
      trimHistoryByBudget(key, hist)
      if (hist.length) console.log(`  [hist] ${key} 启动恢复 ${hist.length} 条（${Math.round(hist.length / 2)} 轮，游标 ${histCutCursors[key] || 0}）`)
    }
  } catch (e) {
    console.log(`  ⚠️ 历史启动恢复失败（不影响运行）: ${e.message}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function htmlTitle(text) {
  const match = String(text || '').match(/<h1[^>]*>(.*?)<\/h1>/i)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

// 取当前生效的模型 API 配置；未配置时给出可操作的报错（侧栏按普通回复失败展示）。
// 每次调用现取：插件里改完配置，下一次提问就生效。
function requireApiConfig() {
  const cfg = resolveApiConfig()
  if (!isConfigured(cfg)) {
    throw new Error('模型 API 未配置：请在侧栏右上角「⋯ → 模型 API 配置」里填写 API 地址与 Key')
  }
  return cfg
}

async function callLLMOnce(maxTokens = 8192, hist = [], opts = {}) {
  const { apiKey, apiBase, model } = requireApiConfig()
  const system = opts.system !== undefined ? opts.system : SYSTEM  // 判定调用可覆盖 SYSTEM（避免阅读助手指令干扰判定）
  // 截断机制（2026-08-28，lib/llm-api.js 同款）：finish_reason:length 视为失败——
  // 预算不足 → 升级到 MAX_JUDGE_TOKENS 重发同 body 一次；仍截断 → 抛错（宁漏勿误，
  // 截断产物/思考草稿绝不当作输出，d_14 point="..." 教训）。
  const MAX_JUDGE_TOKENS = 16384
  let budget = maxTokens
  for (let round = 1; round <= 2; round++) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...hist],
      max_tokens: budget,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      tool_choice: 'none',
    })

    // 防止 fetch 永久挂起导致 agent 卡死
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)

    let resp
    try {
      resp = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const raw = await resp.text()
    let data
    try { data = JSON.parse(raw) } catch { data = null }

    if (!resp.ok) {
      const brief = data?.error?.message || htmlTitle(raw) || raw.slice(0, 120).replace(/\s+/g, ' ').trim()
      const err = new Error(`LLM API ${resp.status}: ${brief || '请求失败'}`)
      err.status = resp.status
      throw err
    }
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const msg = data.choices?.[0]?.message
    const finish = data.choices?.[0]?.finish_reason

    if (finish === 'length') {
      if (budget < MAX_JUDGE_TOKENS) {
        budget = MAX_JUDGE_TOKENS  // 预算升级，重发同 body（模型没收到过修正，原样重发）
        continue
      }
      throw new Error('LLM 输出被截断（finish_reason: length，16384 预算仍不够）')
    }

    // content 优先作为回复；若为空则回退到 reasoning_content（少数推理模型会把回复放这里）。
    // 注意：截断分支已提前返回——reasoning_content 只允许在**完整输出**时作回退。
    const text = msg?.content?.trim() || msg?.reasoning_content?.trim()
    if (!text) throw new Error('模型无回应：' + JSON.stringify(data).slice(0, 200))
    return text
  }
  throw new Error('LLM 输出被截断（finish_reason: length）')
}

// ── 流式调用 LLM ────────────────────────────────────────────────────────────
async function* callLLMStream(maxTokens = 8192, hist = []) {
  const { apiKey, apiBase, model } = requireApiConfig()
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: SYSTEM }, ...hist],
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)

  let resp
  try {
    resp = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!resp.ok) {
    const raw = await resp.text()
    let data
    try { data = JSON.parse(raw) } catch { data = null }
    const brief = data?.error?.message || raw.slice(0, 120)
    const err = new Error(`LLM API ${resp.status}: ${brief}`)
    err.status = resp.status
    throw err
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let fullReasoning = ''

  // 流中途停滞保护：长时间没有新 chunk（推理模型静默思考 / 连接卡死）就 abort，
  // 避免侧栏永远停在"思考中"。上面的 180s 超时只覆盖响应头阶段，管不到 body 流。
  let stallTimer = null
  const STALL_TIMEOUT = 150_000
  const resetStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT)
  }
  resetStall()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetStall()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data: ')) continue
        const json = s.slice(6)
        if (json === '[DONE]') continue

        try {
          const parsed = JSON.parse(json)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) {
            fullContent += delta.content
            yield { chunk: delta.content, accumulated: fullContent }
          } else if (delta?.reasoning_content) {
            // 推理模型的思考链（reasoning_content）绝不作为回复发出：
            // 只在控制台留痕，防止思考内容（含对画像上下文的引用）泄漏进侧栏。
            fullReasoning += delta.reasoning_content
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(stallTimer)
  }

  if (!fullContent.trim()) {
    // 推理模型只输出思考、没有正文（reasoning_content 非空但 content 为空）：
    // 一律按空流处理触发重试，绝不把思考链当回复返回（思考含画像上下文引用，会泄漏给用户）。
    if (fullReasoning.trim()) console.log('  ⚠️ 模型仅输出思考链（reasoning_content），无正文，按空流重试')
    throw new Error('模型无回应（空流）')
  }

  return fullContent
}

async function callLLM(maxTokens = 8192, hist = [], opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callLLMOnce(maxTokens, hist, opts)
    } catch (e) {
      // 网络层失败原样抛出 → 抛前换成中文可诊断文案（带 cause.code），
      // 否则侧栏只会出现 `⚠️ fetch failed` 这种既看不懂也无法定位的串
      lastErr = isNetworkError(e) ? new Error(networkErrorMessage(e)) : e
      // 超时、网络错误、服务端错误均可重试（判定见 lib/error-classify.js）
      if (!canRetryError(e) || attempt === 3) break
      console.log(`  ⚠️ API 调用失败 (attempt ${attempt}/3): ${e.message}`)
      await sleep(1500 * attempt)
    }
  }
  throw lastErr
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
}

// 带重试的流式调用：只在「一个 chunk 都没产出」前重试（429/5xx/超时/网络层失败/空流），
// 已经吐出部分内容后的失败不重试（重发会造成内容错乱），直接向上抛。
async function* callLLMStreamWithRetry(maxTokens, hist) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    const it = callLLMStream(maxTokens, hist)
    let yielded = false
    try {
      while (true) {
        const { done, value } = await it.next()
        if (done) {
          // 生成器以 return 结束：已 yield 过 → 返回累计结果；
          // 未 yield 过但有返回值（纯推理模型把回复放在 return 的 fullReasoning）→ 也返回，
          // 否则会被当成空流重试 3 次后丢弃。只有既无 chunk 也无返回值（真·空流）才重试。
          if (yielded || value) return value
          break
        }
        yielded = true
        yield value
      }
    } catch (e) {
      if (yielded) throw e  // 中途失败：不重试（canRetryError 的 yielded 形参同样兜底）
      // 网络层失败：抛前换成中文可诊断文案（带 cause.code）；已是本模块产物则不重复包装
      lastErr = isNetworkError(e) ? new Error(networkErrorMessage(e)) : e
      if (!canRetryError(e) || attempt === 3) throw lastErr
      console.log(`  ⚠️ 流式调用失败 (attempt ${attempt}/3): ${e.message}`)
      await sleep(1500 * attempt)
      continue
    }
    lastErr = lastErr || new Error('模型无回应（空流）')
    if (attempt === 3) throw lastErr
    console.log(`  ⚠️ 空流重试 (attempt ${attempt}/3)`)
    await sleep(1500 * attempt)
  }
  throw lastErr
}

// 产出最终完整回复的流式入口：边收边把累计文本写进 chat_output（~100ms 节流），
// 收尾写 -1 结束标记 + 最终完整记录。chat_output 的写入由本函数独占，
// 调用方不再各自 appendChatOutput，保证每条回复只产生一组流记录 + 一条最终记录。
async function say(userText, options = {}) {
  // AI-001：写入归属书/上下文的历史；元任务（记忆重写）由调用方显式传 _meta
  const key = options.bookKey || currentBookKey || '_common'
  const hist = histFor(key)
  // AI-017：hist/journal 只存调用方给的入库文本（storeText：用户原话，或"划线原文引用+提问/批注"），
  // 侧栏 enriched（[正在共读] 前缀+章节窗口）只在本次调用注入 callHist，防止书摘录当"用户的话"入库
  const storeText = options.storeText != null ? options.storeText : userText
  hist.push({ role: 'user', content: storeText })
  trimHistoryByBudget(key, hist)  // 2026-09 惰性截尾：追加式保缓存前缀，超预算才从最老切
  // 自由模式（任意自由对话 key）不写 journal：对话内容默认是临时的，不进
  // session_journal（从而不进 profile/soul 记忆固化）；归档时勾选「保存记忆」才
  // 单独把这场对话喂给记忆合并（见 archiveFreeConversation）。
  if (key !== '_meta' && !isFreeKey(key)) journalAppend({ kind: 'msg', bookKey: key, role: 'user', content: storeText })  // 同步落盘，强杀也不丢
  let fullContent = ''
  let displayContent = ''  // 剥掉 MEMORIZE 标记后的展示文本
  let started = false  // 是否已写过流式记录

  try {
    // 本次调用喂 enriched（userText）：历史（hist，原话 storeText）整体保留，
    // 画像独立成块插在历史与当轮消息之间（2026-10 缓存修复）：
    //   [S, u1, a1, ..., uN(storeText), persona, U_N]
    // 下一轮 = 上一轮 + [aN, uN+1(storeText), persona, U_N+1]——前缀（全部历史，
    // 含 uN）连续命中；不再用 slice(0,-1) 替换（那会让上一轮的 user 从请求里消失、
    // 且 persona+U_N 与下一轮历史的 uN(storeText) 分叉，每轮固定失配最近 2~3 轮，
    // 短会话/跨会话首轮命中率降到 50%~70%）。
    // persona 独立块：profile/soul/足迹变化只失配当轮 persona 块，不碰历史前缀。
    // 2026-09 防跑题（09-07 火星报段落教训）：persona 已带【背景档案】"非发言"标注；
    // 当轮输入前再加【本轮消息】锚定行，把"当前要回答什么"在语义上钉死——模型不得
    // 顺着旧主题代答、不得把档案/历史内容当成这轮的用户发言。_meta 记忆合并保持原状
    // （产物另有校验兜底，见 rewriteWithRetry）。
    const persona = personaBlock()
    const anchored = key !== '_meta'
      ? '【本轮消息】（上面历史与【背景档案】都只是背景——本行以下是用户当前要你直接回应的内容：若含引文+提问，先围绕引文本身回答）\n' + userText
      : userText
    // L3 图路径上下文（可选）：独立成一条消息插在锚定消息**之前**——生成点前最后读到
    // 的永远是 anchored（本轮问题/划线本身），而不是一大段旧讨论（2026-10 定调）。
    const l3Ctx = String(options.l3 || '').trim()
    const callHist = [
      ...hist,
      { role: 'user', content: persona },
      ...(l3Ctx ? [{ role: 'user', content: l3Ctx }] : []),
      { role: 'user', content: anchored },
    ]
    const stream = callLLMStreamWithRetry(options.maxTokens || 8192, callHist)
    let lastWrite = 0
    let result
    while (true) {
      result = await stream.next()
      if (result.done) {
        fullContent = result.value || fullContent
        break
      }
      const now = Date.now()
      const accumulated = (result.value && result.value.accumulated) || ''
      fullContent = accumulated
      // 节流：约 100ms 一条（content 是累计文本，中间跳过的写会在下一条覆盖）。
      // 流式时就剥掉 MEMORIZE 标记，用户看不到内部协议；_meta 不写 chat_output
      if (key !== '_meta' && (!started || now - lastWrite >= 100)) {
        appendChatOutputStream(stripMemorize(accumulated), key)
        started = true
        lastWrite = now
      }
    }

    // 2026-10 移除"引用跑题自愈"（用户定调：流式已显示的内容不能被事后替换）：
    // 原机制在答完后用**无历史**的判定 LLM 复查"回复有没有碰引文"，判成跑题就用
    // **无历史、无画像**的加固 prompt 重答一次、覆盖已显示的气泡。实测两个结构性问题：
    //   ① 判定输入没有历史，分不出"接着说上一轮"和"跑到别的话题"，且结论靠"输出里
    //      第一个 是/否 字符"取（推理型模型把思考写进 content 时近乎掷硬币）→ 误判；
    //   ② 重答刻意剥离历史与画像（当初跑题根因是长上下文的旧主题磁吸），一旦误判，
    //      用户看到的就是"答案突然换成另一段、且只对着引文讲，像忘了刚才在聊什么"
    //      （2026-09-24 14:33《大国大城》实例：a 1350 字接着用户的话讲，35 秒后被
    //      874 字的"冷启动式"引文解释覆盖）。
    // 现在**答完即定稿**：流式显示什么、最终记录就是什么（除下面的 MEMORIZE 标记剥离）。
    // 防跑题回到事前：AGENT.md 的【本轮消息】规则 + say() 里的 persona/anchored 锚定块。

    // 收尾展示文本：剥掉 MEMORIZE 标记
    displayContent = stripMemorize(fullContent)

    if (key !== '_meta') {
      // 会话中实时记忆：检测【MEMORIZE】标记 → 就地合并进 profile/soul → 追加确认反馈。
      // 自由模式跳过（对话内容默认不进长期记忆）：标记剥离照常（显示层），合并不执行；
      // 归档时勾选「保存记忆」由 archiveFreeConversation 统一合并。
      const memorize = !isFreeKey(key) ? extractMemorize(fullContent) : null
      if (memorize) {
        try {
          const ok = await runMemoryMerge(memorize.target, memorize.content)
          if (ok) {
            displayContent += (displayContent ? '\n\n' : '') + '（CoRead 记住了你的话）'
            // 2026-09 画像下沉：system 不含画像，合并后无需重建（personaBlock 每次动态读文件）
          }
        } catch (e) {
          console.log(`  ⚠️ 记忆就地合并失败: ${e.message}`)
        }
      }
      // 合并完成后把最终内容（含确认反馈）作为流式末段补写进现有气泡，再 -1。
      if (memorize) appendChatOutputStream(displayContent, key)
      appendChatOutputStreamEnd(key)
      appendChatOutput('assistant', displayContent, key, { replyTo: options.replyTo })
    }
  } catch (e) {
    // 出错也要收尾：流已吐过一部分时补 -1 + 错误记录，避免侧栏气泡卡在思考动画。
    // 元任务（_meta）不写库，避免在侧栏产生记忆合并过程的伪气泡。
    // 失败回答以 status='failed' 入库：它不参与配对（pairReplies 跳过 ⚠️/failed），
    // 也不影响提问的重试状态（提问的 status 由 poller 决定）。
    if (key !== '_meta') {
      if (started) appendChatOutputStreamEnd(key)
      appendChatOutput('assistant', `⚠️ ${e.message}`, key, {
        status: 'failed', error: String(e.message).slice(0, 200), replyTo: options.replyTo,
      })
    }
    // 余额/鉴权类致命错误：登记给 poller → 中止本轮队列 + 暂停（否则队列里每条消息都会
    // 各写一个 ⚠️ 气泡，2026-09-28 一次刷了 213 个）
    if (isFatalConfigError(e)) _lastFatalError = e
    hist.pop()
    return `⚠️ ${e.message}`
  }

  hist.push({ role: 'assistant', content: stripCodeBlocks(displayContent) })
  // 注意：历史里的 assistant 与 chat_output 落盘/启动恢复保持一致（都 stripCodeBlocks）——
  // 否则回复含代码块时，跨会话恢复的历史与在线历史从那条起失配，缓存前缀全部断裂（2026-10）
  if (key !== '_meta' && !isFreeKey(key)) journalAppend({ kind: 'msg', bookKey: key, role: 'assistant', content: displayContent, ...(options.assistantSelected ? { assistantSelected: options.assistantSelected } : {}) })
  return stripCodeBlocks(displayContent)
}

// ── 持久化 ───────────────────────────────────────────────────────────────────

// ── 会意系统 · 实时栈 + 收口固化（2026-08-28 用户定调）──────────────────────
// 聊天时：消息/回复实时喂栈（判专题化入口 + 判同一性切段，lib/topic-stack.js）；
// 引用解析命中 → L3 上下文 + 引用暂存（挂当前讨论）。
// **收口固化（唯一固化时机）**：新的专题化讨论到来，旧的全体弹栈（closed_and_pushed）
// → 当场对弹出的旧讨论：归纳问题 → 固化（节点）→ 段间无条件 derived 边 → user 边 → 写图。
// 关闭 / 启动恢复**不做**收口固化——只是保存/恢复进行中的讨论（栈跨会话持久化），
// 讨论没被新专题化弹栈就不收口。

// callLLM(maxTokens, hist, opts) 与模块约定的 callLLM(prompt, maxTokens) 参数顺序相反，包一层。
// 判定调用不带阅读助手 SYSTEM（避免 MEMORIZE 等指令干扰判定格式），用最小判定系统；
// temperature: 0 保证判定确定性（与冒烟脚本一致）。
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
function judgeLLM(prompt, maxTokens) {
  return callLLM(maxTokens || 2048, [{ role: 'user', content: prompt }], { system: JUDGE_SYSTEM, temperature: 0 })
}

// 从聊天消息提取划线结构体 { text, book, chapter }（无划线返回 undefined）。供 selected / journal 记录复用。
function selectionFromMsg(msg) {
  return msg && msg.selectedText
    ? { text: msg.selectedText, book: msg.bookTitle || '', chapter: msg.chapter || '' }
    : undefined
}

// ── 会意图运行时态：图加载/保存 + 引用解析（L3 上下文） ──
let graph = createGraph()  // 会意图（§5.3）：启动时从 GRAPH_FILE 加载，收口固化时写回
//（2026-11 自由模式多对话：自由对话不再有独立沙盒图——收编进正式图与否由归档弹窗
//  决定，见 archiveFreeConversation；沙盒只服务引用解析的只读基线，已无写入方）

// 读图文件：主文件损坏/缺失 → 回退 .bak（写盘总是先备份，读取失败用备份闭环）。
// 返回 null = 文件不存在或结构不可用（调用方决定下一步）。
function readGraphFile(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return obj
    return null
  } catch {
    return null
  }
}

function loadGraph() {
  const main = readGraphFile(GRAPH_FILE)
  if (main) { graph = main; return }
  if (fs.existsSync(GRAPH_FILE + '.bak')) {
    const bak = readGraphFile(GRAPH_FILE + '.bak')
    if (bak) {
      console.log(`  ⚠️ ${path.basename(GRAPH_FILE)} 读取失败，已从 .bak 恢复（${bak.nodes.length} 节点 / ${bak.edges.length} 边）`)
      graph = bak
      return
    }
  }
  // 回退：离线固化脚本产出的有效图（与 receiver /graph 的三级回退一致）——live
  // 收口固化尚未落盘时，引用解析也能命中真实知识点节点（2026-08-31 修复：此前
  // 正式图缺失 → 空图 → resolveCitations 空图短路，所有模式都永远没有命中事件）。
  // 首次收口固化会把该图连同新节点一起写回正式图文件（saveGraph 全量落盘）。
  const results = readResultsGraph()
  if (results) {
    graph = results
    console.log(`  ⚠️ 正式图缺失，已回退离线固化图（${results.nodes.length} 节点 / ${results.edges.length} 边，scripts/data/knowledge-graph-results.json）`)
    return
  }
  graph = createGraph()
}

// 离线固化产物图：scripts/data/knowledge-graph-results.json（{ graph: {nodes,edges} } 或顶层直接是图）
function readResultsGraph() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RESULTS_GRAPH_FILE, 'utf8'))
    const g = parsed && parsed.graph && typeof parsed.graph === 'object' ? parsed.graph : parsed
    if (!g || !Array.isArray(g.nodes)) return null
    return { nodes: g.nodes, edges: Array.isArray(g.edges) ? g.edges : [] }
  } catch {
    return null
  }
}

function saveGraph() {
  try {
    fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true })
    if (fs.existsSync(GRAPH_FILE)) fs.copyFileSync(GRAPH_FILE, GRAPH_FILE + '.bak')  // 先备份，后读写（用户本地数据）
    fs.writeFileSync(GRAPH_FILE, JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2))
  } catch (e) {
    console.log(`  ⚠️ 会意图写入失败: ${e.message}`)
  }
}

// 说明（2026-11 自由模式多对话）：自由对话**不再**产出沙盒图产物——收编与否由归档
// 弹窗决定，收编就直接写正式图（见 archiveFreeConversation）。receiver 的
// `/graph?free=1` 与 knowledge-graph.free.json 只作为旧产物的只读入口保留
//（历史文件可随时手删；文件不存在时该入口回退正式图）。

// 从收口组 entries（user/assistant 轮次）提取交锋轮次 {q, a}（lib/graph-consolidate.js 导出）


// 会话中引用解析：发言 → 命中节点 id[] + L3 块。图空 / 异常 → 空，不影响主回复。
// 命中只取上下文 + 暂存引用；**不建边**（建边在固化时，2026-08-27 定调命中与建边解耦）。
// 2026-11 输入口径修复：判定材料只留用户自己的话（note），**剥掉引文块**（[引用] 头 +
// > 划线原文）。引用解析判的是"用户是否在指认旧知识点"，而引文是正在读的书的内容——
// 把引文喂进语义匹配，会把"引文主题词撞上同源节点"判成"引用"，产生假阳性
// （实例：对《怎么办？》引文文风的元评论"这到底是翻译的问题，还是列宁说话就是这样啊"
// 因引文含"少数领导者/工人/政治警察"而命中 4 个同书同章节点；剥掉后无指认话术 → 0 命中）。
// 纯文本消息 parseMessage 原样回传（note = 全文），带 [引用] 块的消息只留块后的提问，
// 与判专题化 messageUnit 同口径。REPL/标注路径传入的已是用户原话，行为不变。
async function resolveCitations(userText, bookKey) {
  const note = parseMessage({ content: String(userText || '') }).note
  const text = String(note || '').trim()
  if (!text || !graph.nodes.length) return { hits: [], l3: '' }
  try {
    const nodeBriefs = graph.nodes.map((n) => ({
      id: n.id,
      point: n.point,
      aliases: n.aliases,
      questions: (n.discussions || []).map((d) => d.question),
    }))
    const { hits } = await resolveReferences({ message: text, nodes: nodeBriefs }, {
      callLLM: judgeLLM,
      maxTokens: 16384,
      log: (m) => console.log(`  [引用解析] ${m}`),
    })
    const valid = hits.filter((id) => graph.nodes.some((n) => n.id === id))
    if (valid.length) {
      // AI-020 命中事件：写 chat_output（role=graph-hit，不带 content/_stream——
      // 不渲染为消息、不参与回复配对），receiver 按既有通道转发为 SSE，侧栏图视图
      // 据此高亮命中节点的闭包。reason = 命中的知识点 point 列表；
      // bookKey = 本次讨论归属书，侧栏按当前上下文过滤（命中脉络按书隔离）。
      const reason = valid
        .map((id) => { const n = graph.nodes.find((x) => x.id === id); return n ? `「${n.point}」` : id })
        .join('、')
      appendGraphHit(valid, reason, bookKey)
    }
    // L3 种子 = 本轮命中 ∪ **本场实时栈已挂的全部引用**（2026-10 用户定调）。理由与前端图
    // 高亮同一条：实时栈收口**之前**它们同属一场讨论——固化时同一段消息的 cites 会一起变成
    // 同一个节点的 user 边，所以不是两类东西。于是「图上亮的」与「模型拿到的」严格一致
    // （前端 computeHitLayers 用同一组种子）。种子非空就注入：这场讨论有引用 → 每轮都带上它的来路。
    const seeds = [...new Set([...valid, ...collectStackCites(topicStacks[bookKey || currentBookKey])])]
    const ancestry = seeds.length ? userAncestry(graph, seeds) : []
    return { hits: valid, l3: ancestry.length ? l3Block(ancestry) : '' }
  } catch (e) {
    console.log(`  [引用解析] 本轮跳过（不影响主回复）: ${e.message}`)
    return { hits: [], l3: '' }
  }
}

// ── 会意讨论栈（实时，跨会话持久化）─────────────────────────────────────────
// topic_stack.json 存栈（按书隔离：{ bookKey: 栈 }，bookKey = baseBookId | '_common'）。
// 栈 = 进行中的专题化讨论：跨会话持久化（讨论没被新专题化弹栈就不收口，
// 关闭/启动恢复不做收口固化——只是保存/恢复栈）。
// 读栈文件：主文件损坏/缺失 → 回退 .bak（写盘总是先备份，读取失败用备份闭环）。
// 返回 null = 文件不存在或内容不可用（调用方决定下一步）。
function readStackFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const out = {}
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) out[k] = v
    return out
  } catch {
    return null
  }
}

function readTopicStacks() {
  const main = readStackFile(TOPIC_STACK_FILE)
  if (main) return main
  if (fs.existsSync(TOPIC_STACK_FILE + '.bak')) {
    const bak = readStackFile(TOPIC_STACK_FILE + '.bak')
    if (bak) {
      console.log(`  ⚠️ ${path.basename(TOPIC_STACK_FILE)} 读取失败，已从 .bak 恢复（${Object.keys(bak).length} 个书栈）`)
      return bak
    }
  }
  return {}
}

function saveTopicStacks(stacks) {
  try {
    if (fs.existsSync(TOPIC_STACK_FILE)) fs.copyFileSync(TOPIC_STACK_FILE, TOPIC_STACK_FILE + '.bak')  // 先备份，后读写（用户本地数据）
    fs.writeFileSync(TOPIC_STACK_FILE, JSON.stringify(stacks, null, 2))
  } catch (e) {
    console.log(`  ⚠️ 栈写入失败: ${e.message}`)
  }
}

// 从会话流水账恢复"上一轮 AI 回复"（按书隔离）：每本书各自最近一条 assistant 消息
// （以及它针对的划线，如果有）——判专题化降级判定的同书上下文。
function lastAssistantByBookFromJournal() {
  const out = {}
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8')
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e?.kind === 'msg' && e?.role === 'assistant' && String(e?.content || '').trim()
          && e?.bookKey && !(e.bookKey in out)) {
        out[e.bookKey] = {
          content: String(e.content),
          selected: e.assistantSelected && String(e.assistantSelected.text || '').trim() ? e.assistantSelected : undefined,
        }
      }
    }
  } catch {}
  return out
}

// 把聊天消息组装成栈模块协议：{ userNote, selected?, assistantContext? }
function buildTopicUnit(msg, lastReply, lastReplySelected) {
  const unit = { userNote: msg.content }
  const sel = selectionFromMsg(msg)
  if (sel) unit.selected = sel
  if (lastReply) {
    unit.assistantContext = { content: lastReply }
    if (lastReplySelected) unit.assistantContext.selected = lastReplySelected
  }
  return unit
}

let topicStacks = {}  // 会意讨论栈运行时态（按书隔离）：{ bookKey: 栈 }；main 启动时 readTopicStacks() 加载
let lastReplyByBook = {}  // 每本书最近一轮 AI 回复 { bookKey: { content, selected? } }：判专题化降级判定的同书上下文

// 喂一条用户消息进**它所属书**的会意栈；AI 回复追加进栈；引用命中挂消息条目（随栈持久化）。
// **收口固化（唯一固化时机，2026-08-28 用户定调）**：新的专题化讨论到来、旧栈全体弹栈
// （closed_and_pushed）→ 当场**固化后分段**（lib/segment-stack.js：先判专题化、再判同一性，
// 把栈内发散的具体问题细切成多个不可分割组）→ 每段：归纳问题 → 固化（派生 point/能指
// → 新建节点，**节点不可变**——2026-08-29 用户定调：去聚合判同）→ user 边；
// **derived 边只存在于固化后的分段逻辑中**：同一栈内相邻段之间**无条件**建 derived 边
//（2026-10 用户定调：去掉段间衍生 LLM 判定——同栈弹出的相邻段是思维连续链的机械产物；
// 不替用户思考，user 边仍只来自用户显式引用），**不比对上一个收口专题讨论**。
// 关闭 / 启动恢复不做收口固化。任何异常都不影响主回复（try/catch 隔离）。
// 收口固化（实时收口 closed_and_pushed 与 /收口 手动收口共用，2026-09）：
// 对被弹出的讨论做固化后分段 → 每段归纳问题 → 固化节点 → user 边 → 段间 derived
// 边 → 冗余 user 边清理（上游命中被段间 derived 链覆盖则删，内容不变）→ 写图。
// 返回 { keptClosed }：0 节点产出且非 noTopicized（LLM 故障）时保留
// 被收口讨论，调用方压回栈顶下次重试；noTopicized（整栈无专题化）不保留。
//
// 目标图由 opts 决定（2026-11 自由模式多对话）：
//   · 读书模式：（默认）正式图 graph —— 完整固化
//   · 自由对话归档 + 用户勾选「收口进拓扑图」：同样落**正式图**（isFree:false），并且
//     跑的是**同一套正常程序**（判专题化 → 判同一性分段 → 逐段归纳/派生/建边）——
//     产出是"分段那么多个"知识点节点，不是压成一个占位节点。
//   · 自由对话不勾选收口：零产物（连线都不建），对话内容随归档一并删除。
async function consolidateClosed(closed, opts = {}) {
  const { isFree = false, targetGraph = graph, logTag = '' } = opts
  let keptClosed = null
      if (isFree) {
        // 自由对话且用户没勾"收口进拓扑图"：什么都不做。2026-11 用户定调——自由对话
        // 默认是临时的，只有归档时勾了才走正常收口程序；不勾就零产物。
        console.log(`  [会意栈]${logTag} 自由对话不收编：零产物（对话内容不落图）`)
      } else {
      // ① 固化后分段：先判专题化（识别知识点轮次；无内核轮次**不做过滤处理**，跟随并入
      //    当前组，2026-08-28 定调），再判同一性（细切发散的具体问题）
      const { segments, noTopicized } = await segmentStack(closed.entries, {
        callLLM: judgeLLM,
        log: (m) => console.log(`  [会意栈]${logTag} ${m}`),
      })
      console.log(`  [会意栈] 收口弹出 ${closed.entries.length} 轮 → 分段 ${segments.length} 个不可分割组`)
      // ② 每段：归纳问题（分段之后）→ 固化（派生 point/能指 → 新建节点，节点不可变）→ user 边
      const segResults = []  // {nodeId, question, excerpts}
      for (const seg of segments) {
        let question = ''
        try {
          const qr = await consolidateThreadQuestion(seg.entries, {
            callLLM: judgeLLM, maxTokens: 384, attempts: 5, log: () => {},
          })
          question = qr.question
        } catch (e) {
          console.log(`  [会意栈] 一段问题归纳失败，弃组（宁漏勿误）: ${e.message}`)
        }
        if (!question) continue
        const sel0 = (seg.entries.find((e) => e.role === 'user') || {}).selected
        const discussion = {
          question,
          book: sel0?.book || '',
          chapter: sel0?.chapter || '',
          excerpts: groupExcerpts(seg.entries),
        }
        try {
          const cons = await consolidateDiscussion(targetGraph, discussion, {
            callLLM: judgeLLM,
            log: (m) => console.log(`  [会意栈] ${m}`),
          })
          // user 边：段内消息挂的引用（按触发回合归属 → 本段节点）
          if (seg.cites.length) {
            const n = addCitationEdges(targetGraph, seg.cites, cons.nodeId)
            if (n) console.log(`  [会意栈] user 边 ×${n} → ${cons.nodeId}`)
          }
          segResults.push({ nodeId: cons.nodeId, question, excerpts: groupExcerpts(seg.entries) })
          console.log(`  [会意栈] 段 → ${cons.nodeId}（新建: ${cons.point}）`)
        } catch (e) {
          console.log(`  [会意栈] 一段固化失败，弃组（宁漏勿误）: ${e.message}`)
        }
      }
      // ③ derived 边：同一栈内相邻段**无条件**建边（2026-10 用户定调：去掉段间衍生 LLM
      // 判定——同一栈收口弹出的相邻段处于同一条思维连续链，衍生是收口分段的机械结果；
      // 不替用户思考规定语义关系，user 边仍只来自用户显式引用。不比对上一个收口专题）
      for (let i = 1; i < segResults.length; i++) {
        const n = addDerivedEdge(targetGraph, segResults[i - 1].nodeId, segResults[i].nodeId)
        if (n) console.log(`  [会意栈] derived 边：${segResults[i - 1].nodeId} → ${segResults[i].nodeId}（同栈相邻段，无条件）`)
      // ④ 冗余 user 边清理（2026-09 用户定调）：段间 derived 边建完后，一段命中
      // 的脉络上游节点若已能沿 上游→…→前一段命中脉络→前一段(derived)→本段 到达
      // 本段，其内容（root→自身路径）已被本段上下文完整覆盖，对应 user 边冗余 →
      // 删除（例：脉络 a→c→b，A 命中 {a,b} 折叠成 b→A；B 命中 c 且 A→B 衍生成立
      // → c 沿 c→b→A→B 已到 B，c→B 与 b→A+A→B 效果相同，删 c→B）。
      try {
        const pruned = pruneRedundantCitationEdges(targetGraph, segResults.map((r) => r.nodeId))
        if (pruned) console.log(`  [会意栈] 冗余 user 边清理 ×${pruned}（内容已被段间 derived 链覆盖）`)
      } catch (e) {
        console.log(`  [会意栈] 冗余 user 边清理失败（不影响主回复）: ${e.message}`)
      }

      }
      // 收口固化整体失败（0 节点产出，如 LLM API 持续故障时各段归纳/派生全部失败）：
      // 被收口的讨论不能就此从栈里消失——它一旦弹掉就永不重试（原文只残留在
      // session_journal 流水账里，需人工恢复）。0 产出时把整场讨论压回栈顶，下次收口
      // 整体重试；讨论内容随栈跨会话持久化，期间不丢。部分成功（≥1 节点）维持
      // "失败段弃组"（宁漏勿误）。
      if (segResults.length === 0) {
        if (noTopicized) {
          // 2026-09：整栈无专题化轮次（如"引用命中消息"开的单条栈）——命中不替代
          // 专题化判断，不构成知识点：零产物且不保留重试（重试只会重复同样的判定）。
          // 讨论栈结束 → 其命中展示随之结束（实时栈命中生命周期，2026-09 定调）。
          console.log('  [会意栈] 收口 0 节点产出（整栈无专题化轮次，命中不替代专题化判断）：不保留重试')
        } else {
          keptClosed = closed.entries
          console.log(`  [会意栈] ⚠️ 收口固化 0 节点产出，被收口讨论保留回栈（${closed.entries.length} 轮，下次收口重试）`)
        }
      }
      // 正式图收口固化 → 写正式图文件（自由对话归档勾选"收编"时同样落正式图）
      saveGraph()
      }
  return { keptClosed }
}

// /收口：手动收口当前书（或指定书）的讨论栈（2026-09 用户定调——读完一本书时使用）。
// 与实时收口走同一固化链路；成功后清空该栈（栈结束 → 命中展示随之结束）。
async function forceConsolidate(bookKey) {
  const stack = topicStacks[bookKey] || []
  if (!stack.length) return { reply: '当前没有进行中的讨论可收口。' }
  // 自由对话（任意自由 key）：收编与否是**归档时的用户选择**，不走 /收口 ——
  // 否则会出现"没勾选收编却在对话中偷偷写图"的隐性固化。
  if (isFreeKey(bookKey)) return { reply: '自由对话请在「归档」时选择要不要收口进拓扑图（对话条右侧 ⤓ 归档）。' }
  const closed = { ts: Date.now(), entries: stack }
  try {
    const { keptClosed } = await consolidateClosed(closed, { isFree: false, targetGraph: graph })
    if (keptClosed && keptClosed.length) {
      topicStacks[bookKey] = keptClosed
      saveTopicStacks(topicStacks)
      return { reply: '收口未完成（固化 0 节点产出），讨论已保留，稍后重试 /收口。' }
    }
    topicStacks[bookKey] = []
    saveTopicStacks(topicStacks)
    return { reply: '本书讨论已收口（' + closed.entries.length + ' 轮）。' }
  } catch (e) {
    console.log('  [会意栈] /收口 固化失败: ' + e.message)
    return { reply: '收口失败：' + e.message }
  }
}

async function driveTopicStack(bookKey, unit, reply, cites) {
  try {
    const stack = topicStacks[bookKey] || []
    // 自由对话（任意自由 key）：对话进行中**不做任何图固化**，只维护讨论栈
    //（2026-11 用户定调）——收藏与否在归档时由用户勾选决定。这里把收口的固化分支
    // 直接短路成"不固化"，弹栈的旧讨论就此结束，产物只可能在归档时生成。
    const isFree = isFreeKey(bookKey)
    const freeTag = isFree ? '[自由模式]' : ''
    const logTag = freeTag || (bookKey ? `[${bookKey}]` : '')
    let r = await processStackMessage(stack, unit, {
      callLLM: judgeLLM,
      maxTokens: 2048,
      log: (m) => console.log(`  [会意栈]${logTag} ${m}`),
    })
    // 引用挂消息条目：本消息的 cites 挂到本消息的 user 条目（随栈持久化，跨会话不丢）
    const citesList = Array.isArray(cites) ? cites : []
    if (r.action === 'ignored') {
      // 2026-09 用户定调：引用解析命中（cites 非空）的消息直接入栈——引用是讨论线索，
      // 不随专题化判定丢弃。空栈 → 新消息开单条栈；不同问题 → 旧栈弹栈收口 + 新消息
      // 开新栈。下游同一性判定、收口分段逻辑不变（非专题化条目分段时跟随组、只贡献
      // cites，不构成知识点）。
      if (!citesList.length) return  // 无线索：维持忽略（栈不变，不写盘）
      if (r.stack.length === 0) {
        r = { action: 'pushed', stack: [makeStackEntry(unit)] }
        console.log('  [会意栈] 引用命中消息（非专题化）直接入栈开新栈（cites ×' + citesList.length + '）')
      } else {
        r = { action: 'closed_and_pushed', closed: { ts: Date.now(), entries: r.stack }, stack: [makeStackEntry(unit)] }
        console.log('  [会意栈] 引用命中消息（不同问题·非专题化）：旧栈弹栈收口 + 新消息开新栈（cites ×' + citesList.length + '）')
      }
    }
    const lastUserIdx = r.stack.reduce((acc, e, i) => (e.role === 'user' ? i : acc), -1)
    const savedStack = r.stack.map((e, i) => (i === lastUserIdx && citesList.length ? { ...e, cites: citesList } : e))
    let keptClosed = null  // 收口固化 0 节点产出时保留被收口讨论（压回栈顶，下次收口重试）
    if (r.action === 'closed_and_pushed' && r.closed) {
      // 自由对话：弹栈旧讨论不固化（产物只在归档时生成）；读书模式：正式图实时固化
      if (!isFree) {
        keptClosed = (await consolidateClosed(r.closed, { isFree: false, targetGraph: graph })).keptClosed
      } else {
        console.log(`  [会意栈]${freeTag} 旧讨论弹栈（${r.closed.entries.length} 轮）：不固化——产物在归档时由用户勾选决定`)
      }
    }
    topicStacks[bookKey] = [...(keptClosed || []), ...savedStack, { role: 'assistant', content: String(reply || '').trim(), ...(unit.selected ? { selected: unit.selected } : {}) }]
    saveTopicStacks(topicStacks)
  } catch (e) {
    console.log(`  [会意栈] 本轮跳过（不影响主回复）: ${e.message}`)
  }
}

// ── 自由对话归档（2026-11 用户定调）──────────────────────────────────────────
// 侧栏归档弹窗两项**默认都勾上**（可取消，取消的选择会被记住），随归档请求一并送到：
//   · 保存记忆 memory：把这场对话（histories[key] 的完整轮次）交给 profile/soul 合并
//     ——走的就是 saveSessionMemory 的同一套 specs/校验/备份闭环，只是材料换成这场
//     自由对话（自由对话不进 session_journal，所以不能复用 journal 那条路）。
//   · 收口进拓扑图 graph：这场讨论跑**读书模式那套一模一样的正常程序**——判专题化 →
//     判同一性分段 → 逐段归纳问题 → 派生 point/能指 → 新建节点 → 引用边 → 段间
//     derived 边 → 冗余 user 边清理，写**正式图**（knowledge-graph.json）。
//     产出是"分段那么多个"知识点节点，**不是压成一个占位节点**（那是 2026-09 测试沙盒
//     的旧实现，已废弃；UI 文案也已按真实逻辑改写）。
// 归档即删除：无论勾没勾，归档完成后清空该对话的讨论栈、LLM 历史、会话历史与
// 聊天库里属于它的消息；注册表只留一条墓碑记录（产物去向说明）。
async function archiveFreeConversation(key, opts = {}) {
  const wantMemory = !!(opts && opts.memory)
  const wantGraph = !!(opts && opts.graph)
  const lines = []     // 本次归档真正做过/跳过的事（进系统气泡与墓碑记录）
  const skipped = []   // 用户没勾的项（墓碑里也要写清楚"没做什么"）
  let memoryOk = false
  let nodeCount = 0
  let edgeCount = 0
  let newPoints = []   // 本次收口新建节点的 point（让用户看见"收出了什么"，而不只是一个数字）

  // ① 记忆：这场对话的全部轮次
  if (wantMemory) {
    const hist = (histories.get(key) || []).filter((m) => String(m.content || '').trim())
    if (hist.length >= 2) {
      try {
        const ok = await saveMemoryFromTranscript(
          hist.map((m) => ({ role: m.role, bookKey: key, content: m.content })),
          { label: '这场自由对话' },
        )
        memoryOk = ok
        lines.push(ok ? '已保存记忆（profile / soul）' : '记忆合并未通过校验，已保留原文件')
      } catch (e) {
        lines.push('记忆保存失败：' + e.message)
      }
    } else {
      lines.push('对话太短，未保存记忆')
    }
  } else {
    skipped.push('未保存记忆')
  }

  // ② 拓扑图：这场讨论收口 → **读书模式那套一模一样的正常程序**（判专题化 → 判同一性
  //    分段 → 逐段归纳问题 → 派生 point/能指 → 新建节点 → user 边 → 段间无条件 derived
  //    边 → 冗余 user 边清理），写正式图。这里不做任何"压成一个占位节点"的简化——
  //    自由对话的收口产物与读书模式收口出来的东西同构，用户看到的节点数就是分段的段数。
  const stack = topicStacks[key] || []
  const nodesBefore = graph.nodes.length
  const edgeKeysBefore = new Set(graph.edges.map((e) => `${e.from}|${e.to}|${e.kind || 'user'}`))
  if (wantGraph) {
    if (!stack.length) {
      lines.push('无讨论内容可收口（对话太短：栈内没有轮到归纳）')
    } else {
      try {
        const { keptClosed } = await consolidateClosed(
          { ts: Date.now(), entries: stack },
          { isFree: false, targetGraph: graph, logTag: '[自由·归档]' },
        )
        if (keptClosed && keptClosed.length) {
          lines.push('收口未完成（固化 0 节点产出）—— 对话内容仍会随归档删除')
        } else {
          const newNodes = graph.nodes.slice(nodesBefore)
          nodeCount = newNodes.length
          newPoints = newNodes.map((n) => String(n.point || '')).filter(Boolean)
          // 边没有 id，按 from|to|kind 记差集（同 pair 去重边不会重复计入）
          edgeCount = graph.edges.filter((e) => !edgeKeysBefore.has(`${e.from}|${e.to}|${e.kind || 'user'}`)).length
          lines.push(nodeCount
            ? `已收口进拓扑图（${nodeCount} 个知识点节点 / ${edgeCount} 条边）`
            : '已收口进拓扑图（整场无专题化轮次，未产出知识点节点）')
        }
      } catch (e) {
        lines.push('收口失败：' + e.message)
      }
    }
  } else {
    skipped.push('未收口进拓扑图')
  }

  // ③ 清理 + 墓碑：归档即删除
  topicStacks[key] = []
  saveTopicStacks(topicStacks)
  histories.delete(key)
  lastReplyByBook && delete lastReplyByBook[key]
  if (histCutCursors && key in histCutCursors) { delete histCutCursors[key]; saveHistCursors() }
  // 删这场对话在聊天库里的消息与事件（事务删除；旧实现是整文件重写两遍 jsonl）
  const del = (() => {
    try { const r = chatStore().deleteConversation(key); return { input: r.messages, output: r.events } } catch (e) {
      console.log(`  ⚠️ 归档清理失败：${e.message}`)
      return { input: 0, output: 0 }
    }
  })()
  const note = lines.join('；') || '已归档'
  archiveConversation(AGENT_DIR, key, { archive: { memory: memoryOk, graph: wantGraph && nodeCount > 0 }, note, now: Date.now() })

  const head = `对话已归档并删除${skipped.length ? '（' + skipped.join('、') + '）' : ''}。`
  // 把收口产出的知识点列出来（最多 5 条）：用户要看的是"收成了什么"，
  // 一个节点数说明不了问题——读书模式收口出来的是分段的多个节点，这里同构。
  const pointLine = newPoints.length
    ? `\n收口出的知识点：\n` + newPoints.slice(0, 5).map((p) => '· ' + p).join('\n') +
      (newPoints.length > 5 ? `\n· …等 ${newPoints.length} 个` : '')
    : ''
  console.log(`  [自由模式] 归档 ${key}：${lines.join('；') || '零产物'}（清理消息 input×${del.input} output×${del.output}）`)
  return { reply: head + (lines.length ? lines.join('；') + '。' : '') + pointLine }
}

// ── 用户情况与观念画像（self-portrait） ─────────────────────────────────────
// 用户谈到自己的情况、做过的事、对事件的思考，或表露观念 → 后台判画像 → **总结**为条目
// （situation/events/thoughts/belief），维护 self-portrait.md。
// 与 profile 分离：不进头部（buildSystemInstruction）、不是合并式重写（有新信息才追加条目）、
// 内容是总结而非原文截取——维护不伤 LLM 前缀缓存。任何异常都不影响主回复（try/catch 隔离）；
// 不 await——判定在后台跑，shutdown 时统一等待。
const _pendingSelfPortrait = []

// 读取现有画像条目（进程内缓存，更新后刷新）
let _portraitCache = null  // { situation: [], events: [], thoughts: [], belief: [] }
function readSelfPortrait() {
  if (_portraitCache) return _portraitCache
  const raw = readIfExists(SELF_PORTRAIT_FILE) || ''
  const p = { situation: [], events: [], thoughts: [], belief: [] }
  let section = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('## 情况')) section = 'situation'
    else if (line.startsWith('## 做过的事')) section = 'events'
    else if (line.startsWith('## 对事件的思考')) section = 'thoughts'
    else if (line.startsWith('## 观念')) section = 'belief'
    else if (section && line.startsWith('- ')) p[section].push(line.slice(2).trim())
  }
  _portraitCache = p
  return p
}

// 画像文本（去重参照，取最新一部分）
function portraitText(p) {
  const parts = []
  if (p.situation.length) parts.push('情况：\n' + p.situation.map((s) => '- ' + s).join('\n'))
  if (p.events.length) parts.push('做过的事：\n' + p.events.map((s) => '- ' + s).join('\n'))
  if (p.thoughts.length) parts.push('对事件的思考：\n' + p.thoughts.map((s) => '- ' + s).join('\n'))
  if (p.belief.length) parts.push('观念：\n' + p.belief.map((s) => '- ' + s).join('\n'))
  return parts.join('\n\n')
}

// 合并新条目并重写 self-portrait.md（保留头部说明，条目按现有顺序追加）
function saveSelfPortrait(p) {
  const today = new Date().toISOString().slice(0, 10)
  const md = [
    '# 用户情况与观念画像（self-portrait）',
    '',
    '> 由会话内容维护：用户谈到自己的生活状况 → 记入「情况」；实际做过的事 → 记入「做过的事」；',
    '> 对自己经历的想法/感受/心理活动 → 记入「对事件的思考」；表露立场/价值观/看问题的方式 → 记入「观念」。',
    '> 与 profile.md 的区别：不进头部上下文（维护不伤 LLM 前缀缓存）、不是合并式重写（有新信息才追加条目）；',
    '> 条目是**总结**（画像陈述），不是原文截取。',
    '> 最近更新：' + today,
    '',
    '## 情况（situation）',
    '',
    ...(p.situation.length ? p.situation.map((s) => '- ' + s) : ['（暂无）']),
    '',
    '## 做过的事（events）',
    '',
    ...(p.events.length ? p.events.map((e) => '- ' + e) : ['（暂无）']),
    '',
    '## 对事件的思考（thoughts）',
    '',
    ...(p.thoughts.length ? p.thoughts.map((t) => '- ' + t) : ['（暂无）']),
    '',
    '## 观念（belief）',
    '',
    ...(p.belief.length ? p.belief.map((b) => '- ' + b) : ['（暂无）']),
    '',
  ].join('\n')
  try { fs.writeFileSync(SELF_PORTRAIT_FILE, md + '\n') } catch (e) { console.log(`  ⚠️ 画像写入失败: ${e.message}`) }
}

let _lastReplyCtx = ''  // 最近一轮 AI 回复，作画像判定的对话脉络（归纳动机）
function driveSelfPortrait(unit, ctx = {}) {
  const p = (async () => {
    try {
      const cur = readSelfPortrait()
      const r = await judgeSelfPortrait(unit, {
        callLLM: judgeLLM,
        existing: portraitText(cur), // 现有画像 → 去重参照
        context: _lastReplyCtx, // 对话脉络（最近 AI 回复）→ 归纳动机/意义
        maxTokens: 4096, // AI-012 同款教训：推理型模型先思考再输出，1024 常被思考耗尽
        log: (m) => console.log(`  [画像] ${m}`),
      })
      if (!r.situation.length && !r.events.length && !r.thoughts.length && !r.belief.length) return
      let changed = false
      for (const s of r.situation) if (!cur.situation.includes(s)) { cur.situation.push(s); changed = true }
      for (const e of r.events) if (!cur.events.includes(e)) { cur.events.push(e); changed = true }
      for (const t of r.thoughts) if (!cur.thoughts.includes(t)) { cur.thoughts.push(t); changed = true }
      for (const b of r.belief) if (!cur.belief.includes(b)) { cur.belief.push(b); changed = true }
      if (changed) {
        saveSelfPortrait(cur)
        for (const s of r.situation) console.log(`  [画像] 📝 情况：${s}`)
        for (const e of r.events) console.log(`  [画像] 🎬 事件：${e}`)
        for (const t of r.thoughts) console.log(`  [画像] 💭 思考：${t}`)
        for (const b of r.belief) console.log(`  [画像] ✦ 观念：${b}`)
      }
    } catch (e) {
      console.log(`  [画像] 本轮跳过（不影响主回复）: ${e.message}`)
    }
  })()
  _pendingSelfPortrait.push(p)
  p.finally(() => {
    const i = _pendingSelfPortrait.indexOf(p)
    if (i >= 0) _pendingSelfPortrait.splice(i, 1)
  })
}

// ── 会话中实时记忆（MEMORIZE 协议） ─────────────────────────────────────────
// LLM 在回复末尾发 【MEMORIZE:profile|soul】标记（见 AGENT.md），
// 这里解析它、剥离它（不让用户看到标记）、就地合并进对应的记忆文件。

// profile 与 soul 的语义定义（AI-013）：合并时把"这个文件是什么、能写什么"喂给 LLM，
// 防止模型把两者混为一谈——历史故障里 soul.md 曾被用户画像内容整段覆盖。
const MEMORY_SPECS = {
  profile: {
    file: 'profile.md',
    maxChars: 400,
    purpose: '用户的长期阅读画像：品味、关注主题、思维习惯、知识背景',
    scope: '只写用户的事实、品味、知识背景与思维习惯；不要写入你自己的立场、观点或相处方式。只能依据用户本人明确表达过的内容——AI 回复中对用户的转述、推断、脑补（含跑题回复）一律不得当作事实写入，具体方法/细节若在对话里查无实据就不要写',
  },
  soul: {
    file: 'soul.md',
    maxChars: 400,  // 250→400：旧规则易被压缩挤掉，放宽后模型更倾向保留原规则
    purpose: '你自己的自画像：讨论中形成的立场、共识与分歧、与用户相处的方式、行为要求',
    scope: '只写你自己的立场与行为规则，并完整保留原内容中已有的行为规则；绝不写入用户的画像类内容',
  },
}
const MEMORY_SPEC_LIST = Object.keys(MEMORY_SPECS).map(type => ({ type, ...MEMORY_SPECS[type] }))

function extractMemorize(reply) {
  const m = String(reply || '').match(/【MEMORIZE:(profile|soul)】\s*([\s\S]+?)\s*$/)
  return m ? { target: m[1], content: m[2].trim() } : null
}

// 从显示文本里剥掉 MEMORIZE 标记块（含未完成的部分，避免流式时闪出标记）
function stripMemorize(text) {
  return String(text || '').replace(/【MEMORIZE:(?:profile|soul)】[\s\S]*$/, '').trim()
}

// 把一条待记住的内容就地合并进 profile.md / soul.md（一次小 LLM 调用）
async function runMemoryMerge(target, memory) {
  const spec = MEMORY_SPECS[target] || MEMORY_SPECS.profile
  const { file, maxChars } = spec
  const filePath = path.join(AGENT_DIR, file)
  const oldContent = readIfExists(filePath)
  if (oldContent) {
    try { fs.copyFileSync(filePath, filePath + '.bak') } catch {}
  }
  const prompt = `用户刚刚在对话中表达了值得长期记住的内容：\n\n${memory}\n\n` +
    `请把它合入当前的 ${file}（${spec.purpose}）。\n` +
    `要求：${spec.scope}。\n` +
    `注意：这条 MEMORIZE 内容来自 AI 自己的摘记，可能存在转述失真——只写入其中能由对话中用户真实发言支撑的事实与偏好；查无实据的细节（数字、方法名、具体说法）不得写入。\n` +
    `若有重复则合并覆盖，若无则补充进去，保持精简，删去被覆盖的旧条目。\n\n` +
    `只输出合并后的完整 ${file} 内容（≤${maxChars}字），不要输出任何其他文字、标记或说明。\n\n` +
    `原内容：\n${oldContent || '（尚无记录）'}`
  const content = await rewriteWithRetry(target, prompt, maxChars)
  if (content) {
    fs.writeFileSync(filePath, content + '\n')
    console.log(`  ✓ ${file} 已就地更新（memory trigger）`)
    return true
  }
  return false
}

// ── 会话流水账（session_journal.jsonl） ────────────────────────────────────
// 每条对话同步落盘（fs.appendFileSync 为同步写，硬杀/断电也不丢）。
// checkpoint 标记"此处之前的对话已合并进 profile/soul"，之后的即"未合并"。
function journalAppend(entry) {
  try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ t: Date.now(), ...entry }) + '\n') } catch {}
}

function readJournalLines() {
  const raw = readIfExists(JOURNAL_FILE)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

// 上一次 checkpoint 之后的全部对话消息（尚未固化进 profile/soul 的部分）
function unmergedJournalMsgs() {
  const lines = readJournalLines()
  let lastCp = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].kind === 'checkpoint') lastCp = i
  return lines.slice(lastCp + 1).filter(l => l.kind === 'msg')
}

// 把对话记录压成可喂给 LLM 的文本：区分说话人（用户/AI），不截断——
// 记忆固化要基于全量对话（AI-017）。书摘录已不入库（见 say()），这里只含用户原话与 AI 回复。
function transcriptText(msgs) {
  return msgs.map(m => {
    const who = m.role === 'assistant' ? 'AI' : '用户'
    return `──── ${who}（${m.bookKey || 'common'}）────\n${m.content}`
  }).join('\n\n')
}

// 合并成功后打 checkpoint，并顺带把 journal 轮转成一行（旧对话已蒸馏进 profile/soul，可弃）
function journalCheckpoint() {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify({ t: Date.now(), kind: 'checkpoint' }) + '\n')
  } catch {}
}

// 会话结束 / 启动恢复时，把"尚未固化"的对话合并重写进 profile / soul。
// 对话来源是 session_journal.jsonl（比内存 history 更稳：强杀后启动也能恢复，
// 也顺带修复了 AI-001 把记忆重写隔离进空 _meta 历史、导致模型看不到本次讨论的问题）。
async function saveSessionMemory({ minMsgs = 2 } = {}) {
  const msgs = unmergedJournalMsgs()
  if (msgs.length < minMsgs) {
    console.log(`（待固化对话 ${msgs.length} 条 < ${minMsgs}，跳过记忆合并）`)
    return
  }
  console.log(`\n正在固化本次会话记忆（${msgs.length} 条对话）...`)
  // 记忆合并本体抽成 saveMemoryFromTranscript：自由对话归档（勾选「保存记忆」）走
  // 的是同一套 specs / 校验 / 备份闭环，只是材料换成那一场自由对话的轮次
  //（自由对话不进 session_journal，不能复用 journal 那条入口）。
  const anyWritten = await saveMemoryFromTranscript(msgs, { label: '本次会话' })
  // 至少一个文件成功合并才打 checkpoint；全失败则保留未合并记录，下次启动再试
  if (anyWritten) {
    journalCheckpoint()
  } else {
    console.log('  ⚠️ 本次未写入任何记忆，未合并对话将保留，下次启动时重试')
  }
}

// 记忆合并本体：把 msgs（[{ role:'user'|'assistant', bookKey?, content }]）压成记录文本，
// 逐个人格文件（profile / soul）提炼 + 合并重写。返回是否有文件被成功写入。
// 注意：本函数**不打 journal checkpoint**——checkpoint 只对 session_journal 有意义
//（调用方 saveSessionMemory 负责）；自由对话归档借用本函数时不碰流水账游标。
async function saveMemoryFromTranscript(msgs, { label = '本次讨论' } = {}) {
  const transcript = transcriptText(msgs)

  const specs = MEMORY_SPEC_LIST
  let anyWritten = false

  for (const { type, file, maxChars, purpose, scope } of specs) {
    const filePath = path.join(AGENT_DIR, file)
    const oldContent = readIfExists(filePath)

    // 备份旧文件（上一份 .bak 会被覆盖，只留最近一份供人工恢复）
    if (oldContent) {
      try { fs.copyFileSync(filePath, filePath + '.bak') } catch {}
    }

    const prompt = `${label}已结束。以下是讨论的记录（每条前面已标注来自"用户"还是"AI"）：\n\n${transcript}\n\n` +
      `请从上面的讨论中提炼出属于 ${file}（${purpose}）的新内容，与以下原内容合并，` +
      `输出完整的重写版本（删去被覆盖的旧条目，保持精简）。\n\n` +
      `要求：${scope}。\n\n` +
      `重要：${file} 若为 profile.md——只能把【用户】消息中用户明确表达过的事实、偏好、知识背景记为画像内容；【AI】消息中对用户的转述、推断、脑补（尤其是跑题回复）一律不是用户事实，不得写入。\n\n` +
      `只输出合并后的完整 ${file} 内容（≤${maxChars}字），不要输出任何其他文字、标记或说明。\n` +
      `本次讨论若没有属于 ${file} 的新内容，则原样输出原内容。\n\n原内容：\n${oldContent || '（尚无记录）'}`

    let content = await rewriteWithRetry(type, prompt, maxChars)
    if (content) {
      fs.writeFileSync(filePath, content + '\n')
      anyWritten = true
      console.log(`  ✓ ${file} 已合并重写`)
    } else {
      console.log(`  ⚠️ ${file} 重试后仍未通过校验，保留旧文件`)
    }
  }
  return anyWritten
}

// 强杀/断电兜底：启动时若发现上次会话有未固化的对话，自动恢复合并
async function recoverUnmergedMemory() {
  const msgs = unmergedJournalMsgs()
  if (msgs.length < 4) return
  console.log(`📦 检测到上次会话有 ${msgs.length} 条未合并的对话，正在恢复记忆（请稍候）...`)
  await saveSessionMemory({ minMsgs: 4 })
  console.log('✅ 记忆恢复完成。\n')
}

// AI-012：推理型模型偶尔把思考草稿当成最终输出返回（明显长于目标上限，或复述了任务指令）。
// 此类内容绝不能写进 profile/soul（会覆盖长期记忆），判为"垃圾输出"并触发重试。
function isMergeOutputGarbage(text, maxChars) {
  const t = String(text || '')
  if (t.replace(/\s/g, '').length > maxChars * 3) return true  // 远超目标上限 → 是思考草稿而非精简产物
  if (t.includes('原内容：') || t.includes('注意字数限制') || t.includes('maxChars')) return true  // 复述了任务指令
  return false
}

async function rewriteWithRetry(type, prompt, maxChars) {
  const MIN_LEN = 30  // 去空白后最少 30 字
  const META = '_meta'  // AI-001：记忆重写是元任务，用独立历史，不污染任何书的上下文

  for (let attempt = 0; attempt < 2; attempt++) {
    // AI-012：maxTokens 从 1200 提到 4096——推理型模型先思考再输出，1200 常被思考耗尽、
    // 最终产物还没写完就被截断（截断的思考草稿正是 soul.md 被写乱的原因）。
    const resp = await say(prompt, { maxTokens: 4096, bookKey: META })
    // say() 成功时把 {role:'user'} + {role:'assistant'} 推入了 META 历史；
    // say() 失败时返回 "⚠️ ..." 且已自行 pop 掉它 push 的 user 消息（净变化 0）。
    // 下面是 LLM 对单任务的回复，整段即是目标内容，无需正则切割。

    const content = resp.trim()
    // LLM 调用失败：错误串绝不能写进 profile/soul（会覆盖长期记忆），只重试不写入
    if (/^⚠️/.test(content)) {
      console.log(`  ⚠️ ${type} 第 ${attempt + 1} 次 LLM 调用失败（${content.slice(0, 40)}），重试...`)
      continue  // META 历史已被 say() 平衡，无需清理
    }

    const stripped = content.replace(/\s/g, '')
    if (stripped.length >= MIN_LEN && !isMergeOutputGarbage(content, maxChars)) return content

    // 校验失败（太短 / 思考草稿）：从 META 历史里摘掉这次的 user+assistant 再重试。
    // 只有 say() 成功时 META 历史才多了这两条；失败路径已在 say() 内平衡，不能 pop，
    // 否则会删掉上一轮真实对话。
    const reason = stripped.length < MIN_LEN
      ? `去空白仅 ${stripped.length} 字，太短`
      : '输出像思考草稿（字数远超上限或复述了任务指令）'
    console.log(`  ⚠️ ${type} 第 ${attempt + 1} 次校验未通过（${reason}），重试...`)
    const metaHist = histFor(META)
    metaHist.pop()  // 移除这次的 assistant 回复
    metaHist.pop()  // 移除这次的 user 消息
    prompt = `上一次的输出未通过校验（${reason}）。请重新输出合并后的完整内容（≤${maxChars}字）：直接给最终结果，不要任何推理过程、字数计算或说明。`
  }

  return null
}

// ── 书藉上下文组装（公共） ───────────────────────────────────────────────────
function assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText) {
  let ctx = ''
  const progressCtx = readProgressContext(bookId, chapter, selectedText, bookTitle)
  if (progressCtx) ctx += `\n${progressCtx}\n`
  const win = chapterWindow(bookId, chapterUid, selectedText, chapter, bookTitle)
  if (win) {
    ctx += `\n${win}\n`
  } else {
    ctx += `\n（暂无这本书的原文足迹。如果作者在后文对这个问题有新的回应，我们到时再一起讨论。）\n`
  }
  return ctx
}

// ── 标注 prompt 构建 ─────────────────────────────────────────────────────────
async function buildAnnotationPrompt(ann) {
  const { bookTitle, chapter, selectedText, userNote, bookId, chapterUid } = ann
  let p = `【新划线】《${bookTitle}》${chapter || ''}\n选中文字："${selectedText}"\n`

  if (userNote) {
    p += `\n用户的第一反应："${userNote}"\n`
  }

  // TODO: 跨书检索已废弃（recall.js 删除，中文分词方案待重新设计；跨书承接由会意图 L3 承担）
  // const recall = runRecall(selectedText)
  // if (recall) p += `\n[阅读记忆检索]\n${recall}\n`

  p += assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText)

  // L3 图路径上下文：用户第一反应引用旧知识点时命中（只取上下文，不建边）。
  // 2026-10：L3 不再拼进 prompt 正文，改为独立消息插在【本轮消息】之前（见 say 的
  // options.l3）——否则生成点前最后读到的是旧讨论，块尾磁吸会带跑本轮回复。
  let l3Ctx = ''
  if (userNote) {
    const cr = await resolveCitations(userNote)
    l3Ctx = cr.l3 || ''
  }

  p += `\n请按行为规则开始讨论这条划线。`
  return { text: p, l3: l3Ctx }
}

// 为带书籍元数据的聊天消息补全上下文（章节窗口、摘要）
// 来自共读弹窗的消息已包含引文，这里只补全书级的上下文信息
// （2026-09：L1 本章标注讨论已删——61 轮历史窗口覆盖本章讨论，L1 与历史重复，
//   独特价值仅"未讨论标注的弱提示"，宁缺毋滥）
function enrichChatMessage(msg) {
  if (!msg.bookId || !msg.selectedText) return msg.content

  const { bookId, bookTitle, chapter, chapterUid, selectedText } = msg
  const ctx = assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText)
  if (ctx.trim()) {
    return `[正在共读]《${bookTitle}》${chapter || ''}\n${ctx}\n${msg.content}`
  }
  return msg.content
}

// ── 首次启动：引导冷启动 ─────────────────────────────────────────────────────
const COLDSTART_SKIP_FLAG = path.join(AGENT_DIR, '.coldstart_skipped')

function hasRealProfile() {
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  // 有超过 200 字的真实内容（排除空模板和只有日期的情况）
  return profile.replace(/[-\s_*#]/g, '').length > 200
}

function askQuestion(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

async function maybeRunColdstart(rl) {
  if (hasRealProfile()) return            // 已有画像，跳过
  if (fs.existsSync(COLDSTART_SKIP_FLAG)) return  // 用户之前选了跳过

  console.log('👋 检测到尚未建立阅读画像。')
  console.log('   CoRead 可以通过你的微信读书历史（书架、划线、想法）')
  console.log('   生成一份初始了解，让后续讨论更有针对性。\n')

  const answer = await askQuestion(rl, '是否现在加载？需要 WEREAD_API_KEY（y/n）: ')

  if (answer.trim().toLowerCase() !== 'y') {
    fs.writeFileSync(COLDSTART_SKIP_FLAG, '')
    console.log('\n（已跳过，如需加载可手动运行 node scripts/coldstart.js）\n')
    return
  }

  if (!process.env.WEREAD_API_KEY) {
    console.log('\n⚠️  未检测到 WEREAD_API_KEY，请在 .env 里添加后重新启动。\n')
    return
  }

  console.log('\n开始加载微信读书历史...\n')
  const { execSync } = await import('child_process')
  try {
    execSync(`node "${path.join(AGENT_DIR, 'scripts', 'coldstart.js')}"`, {
      stdio: 'inherit',
      env: process.env,
    })
    // 2026-09 画像下沉：system 不含画像，无需重建（personaBlock 每次动态读文件）
    console.log('\n✓ 阅读画像已加载，开始共读。\n')
  } catch (e) {
    console.log(`\n⚠️  加载失败：${e.message}\n`)
  }
}

// ── 处理新标注 ───────────────────────────────────────────────────────────────
let currentAnn = null

async function processNewAnnotations() {
  const anns = readAnnotations()
  let cursor = getCursor()
  // 游标超出实际行数（文件被清空/截断过，如删除操作或手动清理）：把游标钳到当前
  // 行数即可，不要再归零重扫（AI-011）。否则删除任意一条引用（/annotation-delete
  // 重写文件使行数变少）都会触发归零、把全部旧标注重读一遍——旧式标注（无
  // setRef/source，改版前创建）会被当成新划线重新触发 LLM 讨论，每次删除都重放。
  // 钳位后新追加的标注照常从末尾处理，不会永久跳过；已处理的旧标注也不再重扫。
  if (cursor > anns.length) {
    // 读到 0 行但游标 >0（2026-09-30）：几乎一定是写入方（/annotation-delete 重写
    // annotations.jsonl）造成的半截读——照旧钳位就会把游标写成 0，下一轮把全部旧标注重读
    // 一遍（与 chat 侧同款缺陷，2026-09-28 的 288 条重放就是这条路径）。这里跳过本轮。
    if (!anns.length && cursor > 0) {
      console.log('  ⚠️ annotations 读到 0 行（写入方正在原地重写？）——本轮跳过，游标不动')
      return false
    }
    cursor = anns.length
    setCursor(cursor)
  }
  if (cursor >= anns.length) return false

  for (let i = cursor; i < anns.length; i++) {
    const ann = anns[i]
    // AI-010：标注一律是"引用"（setRef 设为引用 / source=bookmark-sync 划线同步），
    // 只存档不触发讨论（用户通过侧栏 /chat 提问）；silent 概念已移除，改用来源字段判别
    if (ann.setRef || ann.source === 'bookmark-sync') continue
    currentAnn = ann
    // AI-001：标注讨论进入所属书的历史，并更新"正在读的书"
    const key = baseBookId(ann.bookId) || currentBookKey || '_common'
    if (baseBookId(ann.bookId)) currentBookKey = key
    console.log(`\n── 新划线 · 《${ann.bookTitle}》${ann.chapter || ''} ──`)
    // AI-017：标注讨论入库只留"位置 + 划线原文(引用) + 你的批注"，不含章节窗口与内部指令；
    // 完整讨论 prompt 仍喂本次调用，见 say() 的 callHist
    const storeText = `【划线】《${ann.bookTitle}》${ann.chapter || ''}\n划线原文：${ann.selectedText}` +
      (ann.userNote ? `\n我的批注：${ann.userNote}` : '')
    // 处理步骤状态：共读弹窗提交的标注在侧栏也有思考气泡，按步骤更新文案
    if (ann.userNote && graph.nodes.length) appendAgentState('resolve', key)
    const { text: prompt, l3 } = await buildAnnotationPrompt(ann)
    appendAgentState('answer', key)
    const reply = await say(prompt, { bookKey: key, storeText, l3 })
    console.log('\n' + stripCodeBlocks(reply) + '\n')
  }
  setCursor(anns.length)
  return true
}

// ── REPL ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📖 CoRead 共读 agent 已启动')
  console.log(`   监听标注：${ANNOTATIONS}`)
  console.log('   输入 /exit 退出\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

  // 首次启动引导
  await maybeRunColdstart(rl)

  // 强杀/断电兜底：上次会话未固化的对话在启动时恢复合并
  await recoverUnmergedMemory()

  // 聊天存储：打开（必要时建表）并把上次崩溃残留的"处理中"状态清干净。
  // 瞬态打字机通道每次启动清空——它不入档，留着只会让侧栏看到上次的半截气泡。
  resetStreamFile()
  try {
    const st = chatStore().stats()
    console.log(`   聊天库：${CHAT_DB}（${st.messages} 条消息 / ${st.conversations} 个对话 / 待处理 ${st.pending} / 失败待重试 ${st.failed}）`)
    if (st.pending || st.failed) console.log(`   队列里有 ${st.pending + st.failed} 条待处理消息（含失败重试）`)
  } catch (e) {
    console.log(`  ⚠️ 聊天库打开失败：${e.message}`)
    console.log('     若还没有迁移，请先跑：node agent/scripts/migrate-chat-to-sqlite.mjs --apply')
  }

  // 2026-09 用户定调（跨会话需要旧消息）：histories 是内存态、重启即空，
  // 跨会话承接会断裂（进行中讨论的轮次在主回复 prompt 里丢失）——
  // 启动时从聊天库重建每本书的最近轮次（受 BUDGET 约束，reply_to 直接配对）。
  // 必须在 processNewAnnotations 之前（新标注讨论要基于恢复的历史）。
  // 截尾游标先加载：恢复从游标处续推，保证与在线末尾一致（2026-10）。
  histCutCursors = loadHistCursors()
  restoreHistories()

  const had = await processNewAnnotations()
  if (!had) console.log('（暂无新标注。开始阅读后划线，我会接话。）\n')

  // 会意系统运行时态：会意图（L3 数据源）+ 会意栈（按书隔离，跨会话恢复）
  // + 每本书的上一轮 AI 回复（判专题化降级判定材料）
  // 关闭/启动恢复**不做收口固化**——只恢复进行中的讨论（讨论没被新专题化弹栈就不收口）
  loadGraph()
  topicStacks = readTopicStacks()
  lastReplyByBook = lastAssistantByBookFromJournal()

  rl.prompt()

  let busy = false
  // 致命故障（401/402/403：余额不足 / 鉴权失败）后暂停队列的截止时间戳。逐条重试只会把同一句
  // 错误刷满整本书的历史（2026-09-28：重放的 213 条各写一个 ⚠️ 气泡），所以识别到这类错误就
  // 中止本轮并暂停：充值/改配置后自动继续，重启 agent 立即恢复。
  const FATAL_PAUSE_MS = 10 * 60 * 1000
  const RETRY_PAUSE_MS = 60 * 1000   // 非致命失败（网络/截断/空流）也歇一会儿，避免热循环
  let queuePausedUntil = 0

  // 每 3 秒轮询新标注 + 侧栏用户消息
  const poller = setInterval(async () => {
    if (busy) return

    // 优雅停机：stop.bat 写入 .stop 哨兵 → 保存记忆后退出（"正在保存，请稍候"）。
    // 放在 busy 判断之后：若正在调 LLM，等这条回复收尾才保存，避免并发写。
    if (fs.existsSync(STOP_FILE)) {
      clearInterval(poller)
      rl.pause()
      console.log('\n🛑 收到停止请求，正在保存记忆，请稍候…')
      try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
      // 关闭不做收口固化：进行中的讨论留在栈里（topic_stack.json 已实时保存），下次恢复
      try { fs.unlinkSync(STOP_FILE) } catch {}
      closeChatStore()
      console.log('👋 已保存，共读会话结束。')
      process.exit(0)
    }

    // 队列暂停中（刚发生致命故障 / 连续失败）：本轮不调模型、不刷气泡。
    // 停机哨兵在上面已处理，所以暂停期间 stop.bat 照常工作。
    if (Date.now() < queuePausedUntil) return

    // 优先处理新标注：游标与当前行数不一致（新增 / 删除 / 截断）时交给
    // processNewAnnotations 统一处理——它内部会做游标重置 + 指纹去重，
    // 避免重复讨论旧标注（见 processNewAnnotations 注释）
    const anns = readAnnotations()
    if (getCursor() !== anns.length) {
      busy = true
      rl.pause()
      try { await processNewAnnotations() } catch (e) { console.log(`⚠️ ${e.message}\n`) }
      busy = false
      rl.resume()
      rl.prompt()
      return
    }

    // 处理来自侧栏的用户消息 = 库里 status IN ('pending','failed') 的行（按 id 升序）。
    // 旧实现要读文件 + 比游标 + 查指纹台账，还要防"读到空文件→游标归零→全量重放"；
    // 现在"哪条没答"是数据库查询，"答到哪了"是自增 id，那一整类事故从结构上消失。
    const pending = readPendingMessages()
    if (!pending.length) return
    busy = true
    rl.pause()
    try {
      for (const msg of pending) {
        // AI-001：消息归属当前书——有 bookId 用其书（自由消息也带书签，见 sidebar submit），
        // 无 bookId 则沿用"正在读的书"（currentBookKey），否则进 _common。
        const key = msg.bookId ? baseBookId(msg.bookId) : (msg.conv || currentBookKey || '_common')
        // /收口：手动收口本书讨论（2026-09 用户定调——读完一本书时使用）。
        // 指令消息不进栈/不进会话历史/不触发 LLM，只执行收口并回复确认。
        if (String(msg.content || '').trim() === '/收口') {
          const cr = await forceConsolidate(key)
          // 系统提示：role=system（侧栏以系统样式渲染 + toast，不参与引用回复配对）
          appendChatOutput('system', cr.reply, key, { replyTo: msg.id })
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + cr.reply + '\n')
          continue
        }
        // /归档：归档一场自由对话（2026-11 用户定调）。侧栏归档弹窗发出——请求带
        // archive = { key, memory, graph }（勾选项，现在由「聊天库」承载在 payload 里，
        // 老版本是顶层 msg.archive，两个位置都认）。归档 = 这场对话结束并删除：默认勾选的
        // 两项 = 保存记忆 + 收口进正式拓扑图（读书模式那套正常程序）；完成后清栈、清消息、
        // 注册表留墓碑。
        if (String(msg.content || '').trim() === '/归档') {
          const ar = (msg.payload && msg.payload.archive) || msg.archive || {}
          const target = ar.key ? baseBookId(ar.key) : key
          const reply = isFreeKey(target)
            ? (await archiveFreeConversation(target, ar)).reply
            : '只能归档自由模式的对话（读书模式的讨论用 /收口）。'
          appendChatOutput('system', reply, target, { replyTo: msg.id })
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + reply + '\n')
          continue
        }
        // 自由对话（任意自由 key）不改变"正在读的书"：对话结束后，后续无 bookId 的
        // 自由消息仍应归属真实阅读的书，而不是滞留在自由模式
        if (msg.bookId && key !== currentBookKey && !isFreeKey(key)) {
          // 切书：旧书的讨论周期结束，避免 currentAnn 残留污染新书
          currentBookKey = key
          currentAnn = null
        }
        // 带书籍元数据的消息：绑定到该书讨论（补全书上下文）。
        // 不带 selectedText 的自由消息不绑定书级讨论，但仍进入该书的会话上下文。
        const bookScoped = msg.bookId && msg.selectedText
        if (bookScoped) {
          currentAnn = {
            bookId: msg.bookId, bookTitle: msg.bookTitle,
            chapter: msg.chapter, chapterUid: msg.chapterUid,
            selectedText: msg.selectedText, userNote: msg.content,
          }
        }
        // 引用解析（会话中）：命中 → L3 图路径上下文注入；引用挂消息（固化后按组建边）。
        // 自由模式（2026-09）：引用以侧栏窗体为准——msg.refs = 语义命中自动并入 +
        // 用户手动从拓扑图选取的节点清单（用户可在窗体上取消任意条）。带 refs 字段
        // 就用它（校验节点存在），不带则回退语义解析命中（老版本侧栏/其他入口）。
        // 处理步骤状态：图非空时引用解析才真调 LLM，步骤先行（侧栏"正在…"文案）
        if (graph.nodes.length) appendAgentState('resolve', key)
        const citesR = await resolveCitations(msg.content, key)
        let citesFinal = citesR.hits
        if (isFreeKey(key) && Array.isArray(msg.refs)) {
          citesFinal = msg.refs.filter((id) => graph.nodes.some((n) => n.id === id))
          console.log(`  [自由模式] 引用以窗体为准（${citesFinal.length} 条）${citesFinal.length ? '：' + citesFinal.join('、') : ''}`)
        }
        const userMsg = enrichChatMessage(msg)
        // AI-017：侧栏入库只留"划线原文(引用) + 你的提问"，不含 [正在共读] 章节窗口；自由消息保持原话。
        // bookTitle 用 || '' 兜底——与 restoreHistories 的 storeText 构造完全一致（否则缺书名时
        // 在线历史《undefined》与恢复历史《》不同，跨会话缓存前缀断裂，2026-10）
        const storeText = msg.selectedText
          ? `【划线】《${msg.bookTitle || ''}》${msg.chapter || ''}\n划线原文：${msg.selectedText}\n我的提问：${msg.content}`
          : msg.content
        appendAgentState('answer', key)
        // replyTo = 这条提问的 id：回答入库时直接挂上引用（配对从"时间序推断"变成"外键"）
        const reply = await say(userMsg, { bookKey: key, storeText, assistantSelected: selectionFromMsg(msg), l3: citesR.l3, replyTo: msg.id })
        _lastReplyCtx = stripCodeBlocks(reply)
        // 致命配置/额度错误（401/402/403）：中止本轮 + 暂停队列 + 只留一条 system 提示。
        // 该消息保持 pending（不标 ok）→ 充值/改配置后会重新回答；也不再逐条试
        // （旧行为会刷出几百个 ⚠️ 气泡，2026-09-28 一次刷了 213 个）。
        const fatal = takeFatalError()
        if (fatal) {
          const note = fatalErrorMessage(fatal)
          appendChatOutput('system', note, key)
          console.log('\n[侧栏] ' + note + '\n')
          queuePausedUntil = Date.now() + FATAL_PAUSE_MS
          break
        }
        if (/^⚠️/.test(reply)) {
          // 非致命失败（网络/截断/空流）：status=failed → 下一轮/下次启动仍会重试；
          // 歇 60s 再继续，避免对着一台坏掉的 API 热循环。
          markMessage(msg.id, { status: 'failed', error: String(reply).slice(0, 200) })
          queuePausedUntil = Date.now() + RETRY_PAUSE_MS
          break
        }
        markMessage(msg.id, { status: 'ok' })
        // 画像维护（self-portrait）已停用（2026-10 用户定调：画像只写不读、无消费方，展示不需要）。
        // 调用入口注释保留——恢复时取消注释即可；历史条目可用 scripts/backfill-self-portrait.mjs 重建。
        // if (key !== FREE_KEY) {
        //   driveSelfPortrait(
        //     { userNote: msg.content, ...(selectionFromMsg(msg) ? { selected: selectionFromMsg(msg) } : {}) },
        //     { book: msg.bookTitle || '', chapter: msg.chapter || '' }
        //   )
        // }
        console.log('\n[侧栏] ' + stripCodeBlocks(reply) + '\n')
        // 会意栈（按书隔离）：喂该消息所属书的栈；以上一轮**同书** AI 回复为降级上下文；
        // 入栈消息的引用暂存，**收口固化**（新专题化弹栈旧讨论）时建 user 边 + 段间无条件 derived 边。
        const lastR = lastReplyByBook[key]
        await driveTopicStack(key, buildTopicUnit(msg, lastR ? lastR.content : null, lastR ? lastR.selected : undefined), reply, citesFinal)
        lastReplyByBook[key] = { content: stripCodeBlocks(reply), selected: selectionFromMsg(msg) }
      }
    } catch (e) { console.log(`⚠️ ${e.message}\n`) }
    busy = false
    rl.resume()
    rl.prompt()
  }, 300)

  rl.on('line', async (raw) => {
    const line = raw.trim()
    if (!line) { rl.prompt(); return }
    if (busy) return

    if (line === '/exit' || line === '/quit') { rl.close(); return }

    busy = true
    rl.pause()
    try {
      if (line.startsWith('【新划线】')) {
        await processNewAnnotations()
      } else if (line.startsWith('【章节完成】')) {
        // AI-001：章节总结归属当前讨论的书，否则进通用上下文
        const reply = await say(line, { bookKey: currentBookKey || '_common' })
        console.log('\n' + stripCodeBlocks(reply) + '\n')
      } else {
        // 普通用户回复
        // AI-001：有当前书讨论锚点归该书，否则归"正在读的书"或通用上下文
        const key = currentAnn ? baseBookId(currentAnn.bookId) : (currentBookKey || '_common')
        // 引用解析（会话中）：命中 → L3 图路径上下文注入；引用挂消息（固化后按组建边）；
        // 命中事件带书归属（key），侧栏按当前上下文过滤显示
        const citesR = await resolveCitations(line, key)
        const reply = await say(line, { bookKey: key, l3: citesR.l3 })
        _lastReplyCtx = stripCodeBlocks(reply)
        // 画像维护已停用（2026-10 用户定调）：self-portrait 无消费方，调用入口注释保留。
        // driveSelfPortrait(
        //   { userNote: line },
        //   { book: currentAnn?.bookTitle || '', chapter: currentAnn?.chapter || '' }
        // )

        console.log('\n' + stripCodeBlocks(reply) + '\n')
        // 会意栈（按书隔离）：REPL 输入也是用户追问，喂进该书（key）的栈；REPL 无划线，selected 恒缺省
        const lastR = lastReplyByBook[key]
        await driveTopicStack(key, buildTopicUnit({ content: line }, lastR ? lastR.content : null, lastR ? lastR.selected : undefined), reply, citesR.hits)
        lastReplyByBook[key] = { content: stripCodeBlocks(reply), selected: undefined }
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}\n`)
    }
    busy = false
    rl.resume()
    rl.prompt()
  })

  async function shutdown() {
    clearInterval(poller)
    // 若正在调 LLM，等它收尾再固化，避免并发写 profile/soul
    let waited = 0
    while (busy && waited < 15000) { await sleep(100); waited += 100 }
    try { await Promise.allSettled(_pendingSelfPortrait) } catch (e) { console.log(`⚠️ 画像收尾失败: ${e.message}`) }
    try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
    // 关闭不做收口固化：进行中的讨论留在栈里（已实时保存），下次恢复
    closeChatStore()
    console.log('👋 共读会话结束。')
    process.exit(0)
  }

  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => { console.error('❌', e.message); closeChatStore(); process.exit(1) })
