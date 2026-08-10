#!/usr/bin/env node
/**
 * CoRead 共读 agent — 自包含交互式会话
 *
 * 在 tmux 里常驻运行，读取标准输入（用户输入 + inject.sh 注入的触发行），
 * 与用户实时讨论标注，调用 LLM API 生成回应。不依赖任何外部 CLI。
 *
 * 启动：
 *   cp .env.example .env  # 填入 COREAD_API_KEY 等配置
 *   npm start
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = __dirname
const RECEIVER_DIR = path.join(__dirname, '..', 'receiver')
const INBOX_DIR = path.join(RECEIVER_DIR, 'inbox')
const BOOKS_DIR = path.join(RECEIVER_DIR, 'books')
const ANNOTATIONS = path.join(INBOX_DIR, 'annotations.jsonl')
const CURSOR_FILE = path.join(INBOX_DIR, '.agent_cursor')
const CHAT_INPUT = path.join(INBOX_DIR, 'chat_input.jsonl')
const CHAT_INPUT_CURSOR = path.join(INBOX_DIR, '.chat_input_cursor')
const CHAT_OUTPUT = path.join(INBOX_DIR, 'chat_output.jsonl')
const _repliedFingerprints = new Set()  // 去重：防止同一消息被重复回复
const STOP_FILE = path.join(AGENT_DIR, '.stop')  // stop.bat 写入哨兵 → poller 检测后优雅保存退出
const JOURNAL_FILE = path.join(AGENT_DIR, 'session_journal.jsonl')  // 会话流水账：强杀/断电后启动时恢复记忆

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'

if (!API_KEY) {
  console.error('❌ 请设置 COREAD_API_KEY 环境变量')
  process.exit(1)
}
if (!API_BASE) {
  console.error('❌ 请设置 COREAD_API_BASE 环境变量（如 https://api.openai.com/v1）')
  process.exit(1)
}

// ── 文件读取 ────────────────────────────────────────────────────────────────
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
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

// 书籍足迹签名：用于 poller 检测"新书/书签变化"后重建 SYSTEM
function booksSignature() {
  return userBookTitles().join('|')
}

// ── 上下文加载（启动时一次性构建；书籍足迹/记忆变化时由调用方重建） ────────
function buildSystemInstruction() {
  const rules = readIfExists(path.join(AGENT_DIR, 'AGENT.md'))
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  const soul = readIfExists(path.join(AGENT_DIR, 'soul.md'))
  const openTopics = readIfExists(path.join(AGENT_DIR, 'open_topics.md'))
  const bookTitles = userBookTitles()
  const bookSection = bookTitles.length
    ? '\n\n========\n# 用户书籍足迹（已添加引用/划线的书，用于跨书联想）\n' + bookTitles.map(t => `- 《${t}》`).join('\n')
    : ''
  return [
    '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n',
    rules,
    '\n\n========\n# 用户阅读画像（profile.md）\n', profile,
    '\n\n========\n# 你的自画像（soul.md）\n', soul,
    '\n\n========\n# 未明话题（open_topics.md）\n', openTopics,
    bookSection,
  ].join('')
}

// ── 侧栏聊天 I/O ─────────────────────────────────────────────────────────────
function appendChatOutput(role, content) {
  try { fs.appendFileSync(CHAT_OUTPUT, JSON.stringify({ role, content: stripCodeBlocks(content), timestamp: Date.now() }) + '\n') } catch {}
}

// 流式记录：content 存累计文本，侧栏据此渲染打字机（_stream 存在即流式中间记录）
let _streamSeq = 0
function appendChatOutputStream(content) {
  try {
    fs.appendFileSync(CHAT_OUTPUT, JSON.stringify({
      role: 'assistant',
      content: stripCodeBlocks(content),
      _stream: _streamSeq++,
      timestamp: Date.now(),
    }) + '\n')
  } catch {}
}
// 流结束标记：侧栏收到 _stream === -1 后把该条流标记为完成
function appendChatOutputStreamEnd() {
  try {
    fs.appendFileSync(CHAT_OUTPUT, JSON.stringify({
      role: 'assistant', content: '', _stream: -1, timestamp: Date.now(),
    }) + '\n')
  } catch {}
}

function readChatInputs() {
  const raw = readIfExists(CHAT_INPUT)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function getChatInputCursor() {
  const v = parseInt(readIfExists(CHAT_INPUT_CURSOR), 10)
  return Number.isFinite(v) ? v : 0
}

function setChatInputCursor(n) { fs.writeFileSync(CHAT_INPUT_CURSOR, String(n)) }

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

function bookSummaries(bookId) {
  if (!bookId) return ''
  return readIfExists(path.join(BOOKS_DIR, baseBookId(bookId), 'summaries.md'))
}

// ── LLM API ──────────────────────────────────────────────────────────────────
let SYSTEM = buildSystemInstruction()
let _lastBooksSig = booksSignature()  // 书籍足迹变化检测基线

// 会话上下文按书隔离（AI-001）：key = baseBookId | '_common' | '_meta'
// 读书 X 时的标注讨论、书绑定聊天、自由消息都进 history[X]；切书后互不污染。
// 无书签消息进 '_common'；记忆重写这类元任务进 '_meta'，不进任何书的上下文。
const histories = new Map()  // key -> [{ role: 'user'|'assistant', content: string }]
function histFor(key) {
  if (!histories.has(key)) histories.set(key, [])
  return histories.get(key)
}
let currentBookKey = ''  // 后端跟踪的"正在读的书"（baseBookId），自由消息归属用

function totalHistoryLength() {
  let n = 0
  for (const [k, h] of histories) {
    if (k !== '_meta') n += h.length
  }
  return n
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function htmlTitle(text) {
  const match = String(text || '').match(/<h1[^>]*>(.*?)<\/h1>/i)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

async function callLLMOnce(maxTokens = 8192, hist = []) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, ...hist],
    max_tokens: maxTokens,
    tool_choice: 'none',
  })

  // 防止 fetch 永久挂起导致 agent 卡死
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  let resp
  try {
    resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${API_KEY}`,
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
  // content 优先作为回复；若为空则回退到 reasoning_content（少数推理模型会把回复放这里）
  const text = msg?.content?.trim() || msg?.reasoning_content?.trim()
  if (!text) throw new Error('模型无回应：' + JSON.stringify(data).slice(0, 200))
  return text
}

// ── 流式调用 LLM ────────────────────────────────────────────────────────────
async function* callLLMStream(maxTokens = 8192, hist = []) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, ...hist],
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)

  let resp
  try {
    resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${API_KEY}`,
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
            // 推理模型把思考过程放在 reasoning_content：先累积，content 为空时回退使用
            fullReasoning += delta.reasoning_content
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(stallTimer)
  }

  if (!fullContent.trim()) {
    // 部分推理模型可能只输出 reasoning_content 而 content 为空
    if (fullReasoning.trim()) return fullReasoning
    throw new Error('模型无回应（空流）')
  }

  return fullContent
}

async function callLLM(maxTokens = 8192, hist = []) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callLLMOnce(maxTokens, hist)
    } catch (e) {
      lastErr = e
      // 超时、网络错误、服务端错误均可重试
      const canRetry = e.name === 'AbortError'
        || [429, 500, 502, 503, 504].includes(e.status)
      if (!canRetry || attempt === 3) break
      console.log(`  ⚠️ API 调用失败 (attempt ${attempt}/3): ${e.message}`)
      await sleep(1500 * attempt)
    }
  }
  throw lastErr
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
}

// 带重试的流式调用：只在「一个 chunk 都没产出」前重试（429/5xx/超时/空流），
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
      lastErr = e
      if (yielded) throw e  // 中途失败：不重试
      const canRetry = e.name === 'AbortError'
        || [429, 500, 502, 503, 504].includes(e.status)
        || /空流|模型无回应/.test(e.message || '')
      if (!canRetry || attempt === 3) throw e
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
  hist.push({ role: 'user', content: userText })
  if (key !== '_meta') journalAppend({ kind: 'msg', bookKey: key, role: 'user', content: userText })  // 同步落盘，强杀也不丢
  let fullContent = ''
  let displayContent = ''  // 剥掉 MEMORIZE 标记后的展示文本
  let started = false  // 是否已写过流式记录

  try {
    const stream = callLLMStreamWithRetry(options.maxTokens || 8192, hist)
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
        appendChatOutputStream(stripMemorize(accumulated))
        started = true
        lastWrite = now
      }
    }

    // 收尾展示文本：剥掉 MEMORIZE 标记
    displayContent = stripMemorize(fullContent)

    if (key !== '_meta') {
      // 会话中实时记忆：检测【MEMORIZE】标记 → 就地合并进 profile/soul → 追加确认反馈
      const memorize = extractMemorize(fullContent)
      if (memorize) {
        try {
          const ok = await runMemoryMerge(memorize.target, memorize.content)
          if (ok) {
            displayContent += (displayContent ? '\n\n' : '') + '（CoRead 记住了你的话）'
            SYSTEM = buildSystemInstruction()  // 让后续回复立即用上更新后的 soul/profile
          }
        } catch (e) {
          console.log(`  ⚠️ 记忆就地合并失败: ${e.message}`)
        }
      }
      // 合并完成后把最终内容（含确认反馈）作为流式末段补写进现有气泡，再 -1。
      // 普通回复：末段直接更新气泡；引用回复：侧栏忽略流式末段，走下面最终记录。
      if (memorize) appendChatOutputStream(displayContent)
      appendChatOutputStreamEnd()
      appendChatOutput('assistant', displayContent)
    }
  } catch (e) {
    // 出错也要收尾：流已吐过一部分时补 -1 + 错误记录，避免侧栏气泡卡在思考动画。
    // 元任务（_meta）不写 chat_output，避免在侧栏产生记忆合并过程的伪气泡
    if (key !== '_meta') {
      if (started) appendChatOutputStreamEnd()
      appendChatOutput('assistant', `⚠️ ${e.message}`)
    }
    hist.pop()
    return `⚠️ ${e.message}`
  }

  hist.push({ role: 'assistant', content: displayContent })
  if (key !== '_meta') journalAppend({ kind: 'msg', bookKey: key, role: 'assistant', content: displayContent })
  return stripCodeBlocks(displayContent)
}

// ── 持久化 ───────────────────────────────────────────────────────────────────
function ensureBookDir(bookId) {
  const d = path.join(BOOKS_DIR, baseBookId(bookId))
  fs.mkdirSync(d, { recursive: true })
  return d
}

function saveTakeaway(ann, takeaway) {
  if (!ann?.bookId || !takeaway) return
  const line = JSON.stringify({
    bookId: ann.bookId,
    bookTitle: ann.bookTitle,
    chapter: ann.chapter || '',
    selectedText: ann.selectedText,
    takeaway,
    timestamp: Math.floor(Date.now() / 1000),
  })
  fs.appendFileSync(path.join(ensureBookDir(ann.bookId), 'discussions.jsonl'), line + '\n')
}

// 在第 N 轮时把 takeaway 请求附在用户消息末尾，从模型回应里解析出来
function extractTakeaway(reply) {
  const match = reply.match(/【TAKEAWAY】(.+)/)
  return match ? match[1].trim() : null
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
    scope: '只写用户的事实、品味、知识背景与思维习惯；不要写入你自己的立场、观点或相处方式',
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

// 把对话记录压成可喂给 LLM 的文本（取尾部，控制 token 成本）
function transcriptText(msgs, maxChars = 6000) {
  const txt = msgs.map(m => `[${m.bookKey || 'common'}] ${m.role}: ${m.content}`).join('\n')
  return txt.length > maxChars
    ? '…（对话过长，仅取最近部分）…\n' + txt.slice(txt.length - maxChars)
    : txt
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

    const prompt = `会话即将结束。以下是本次讨论的记录：\n\n${transcript}\n\n` +
      `请从上面的讨论中提炼出属于 ${file}（${purpose}）的新内容，与以下原内容合并，` +
      `输出完整的重写版本（删去被覆盖的旧条目，保持精简）。\n\n` +
      `要求：${scope}。\n\n` +
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

  // 至少一个文件成功合并才打 checkpoint；全失败则保留未合并记录，下次启动再试
  if (anyWritten) {
    journalCheckpoint()
  } else {
    console.log('  ⚠️ 本次未写入任何记忆，未合并对话将保留，下次启动时重试')
  }
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

// ── 跨书记忆检索 ─────────────────────────────────────────────────────────────
function runRecall(selectedText) {
  try {
    const query = selectedText.slice(0, 40).replace(/["'\n]/g, ' ').trim()
    const script = path.join(AGENT_DIR, 'scripts', 'recall.js')
    const result = execSync(`node "${script}" "${query}"`, { timeout: 5000, encoding: 'utf8' }).trim()
    if (result && !result.startsWith('无')) return result
  } catch {}
  return ''
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
  const sum = bookSummaries(bookId)
  if (sum) ctx += `\n${sum}\n`
  return ctx
}

// ── 标注 prompt 构建 ─────────────────────────────────────────────────────────
function buildAnnotationPrompt(ann, turnHint = '') {
  const { bookTitle, chapter, selectedText, userNote, bookId, chapterUid } = ann
  let p = `【新划线】《${bookTitle}》${chapter || ''}\n选中文字："${selectedText}"\n`

  if (userNote) {
    p += `\n用户的第一反应："${userNote}"\n`
  }

  // TODO: 跨书检索暂时禁用，中文分词方案待重新设计
  // const recall = runRecall(selectedText)
  // if (recall) p += `\n[阅读记忆检索]\n${recall}\n`

  p += assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText)
  p += `\n请按行为规则开始讨论这条划线。`
  if (turnHint) p += turnHint
  return p
}

// 为带书籍元数据的聊天消息补全上下文（章节窗口、摘要等）
// 来自共读弹窗的消息已包含引文，这里只补全书级的上下文信息
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
    // coldstart 成功后重建系统指令
    SYSTEM = buildSystemInstruction()
    console.log('\n✓ 阅读画像已加载，开始共读。\n')
  } catch (e) {
    console.log(`\n⚠️  加载失败：${e.message}\n`)
  }
}

// ── 处理新标注 ───────────────────────────────────────────────────────────────
let currentAnn = null
let annTurnCount = 0

async function processNewAnnotations() {
  const anns = readAnnotations()
  let cursor = getCursor()
  // 游标超出实际行数（文件被清空/截断过，如删除操作或手动清理）：把游标钳到当前
  // 行数即可，不要再归零重扫（AI-011）。否则删除任意一条引用（/annotation-delete
  // 重写文件使行数变少）都会触发归零、把全部旧标注重读一遍——旧式标注（无
  // setRef/source，改版前创建）会被当成新划线重新触发 LLM 讨论，每次删除都重放。
  // 钳位后新追加的标注照常从末尾处理，不会永久跳过；已处理的旧标注也不再重扫。
  if (cursor > anns.length) {
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
    annTurnCount = 0
    // AI-001：标注讨论进入所属书的历史，并更新"正在读的书"
    const key = baseBookId(ann.bookId) || currentBookKey || '_common'
    if (baseBookId(ann.bookId)) currentBookKey = key
    console.log(`\n── 新划线 · 《${ann.bookTitle}》${ann.chapter || ''} ──`)
    const reply = await say(buildAnnotationPrompt(ann), { bookKey: key })
    console.log('\n' + stripCodeBlocks(reply) + '\n')
  }
  setCursor(anns.length)
  return true
}

// ── REPL ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📖 CoRead 共读 agent 已启动')
  console.log(`   监听标注：${ANNOTATIONS}`)
  console.log('   输入 /exit 退出，/topics 看未明话题\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

  // 首次启动引导
  await maybeRunColdstart(rl)

  // 强杀/断电兜底：上次会话未固化的对话在启动时恢复合并
  await recoverUnmergedMemory()

  const had = await processNewAnnotations()
  if (!had) console.log('（暂无新标注。开始阅读后划线，我会接话。）\n')

  rl.prompt()

  let busy = false

  // 每 3 秒轮询新标注 + 侧栏用户消息
  const poller = setInterval(async () => {
    if (busy) return

    // 书籍足迹变化（新书 / 书签变化）→ 重建 SYSTEM，让跨书联动的书名列表保持最新
    const sig = booksSignature()
    if (sig !== _lastBooksSig) {
      _lastBooksSig = sig
      SYSTEM = buildSystemInstruction()
    }

    // 优雅停机：stop.bat 写入 .stop 哨兵 → 保存记忆后退出（"正在保存，请稍候"）。
    // 放在 busy 判断之后：若正在调 LLM，等这条回复收尾才保存，避免并发写。
    if (fs.existsSync(STOP_FILE)) {
      clearInterval(poller)
      rl.pause()
      console.log('\n🛑 收到停止请求，正在保存记忆，请稍候…')
      try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
      try { fs.unlinkSync(STOP_FILE) } catch {}
      console.log('👋 已保存，共读会话结束。')
      process.exit(0)
    }

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

    // 处理来自侧栏的用户消息
    const inputs = readChatInputs()
    if (getChatInputCursor() > inputs.length) setChatInputCursor(0)  // 文件清空/截断后重置游标，避免新消息被永久跳过
    const chatCursor = getChatInputCursor()
    if (chatCursor >= inputs.length) return
    busy = true
    rl.pause()
    try {
      for (let i = chatCursor; i < inputs.length; i++) {
        const msg = inputs[i]
        // 去重：指纹 = 时间戳+内容前80字，防止同一消息被重复回复
        const fp = `${msg.timestamp || 0}|${(msg.content || '').slice(0, 80)}`
        if (_repliedFingerprints.has(fp)) { console.log(`  [dedup] skip: ${fp.slice(0,50)}`); continue }
        _repliedFingerprints.add(fp)
        if (_repliedFingerprints.size > 200) _repliedFingerprints.clear()
        // AI-001：消息归属当前书——有 bookId 用其书（自由消息也带书签，见 sidebar submit），
        // 无 bookId 则沿用"正在读的书"（currentBookKey），否则进 _common。
        const key = msg.bookId ? baseBookId(msg.bookId) : (currentBookKey || '_common')
        if (msg.bookId && key !== currentBookKey) {
          // 切书：旧书的讨论周期结束，避免 currentAnn / 轮次残留污染新书
          currentBookKey = key
          currentAnn = null
          annTurnCount = 0
        }
        // 带书籍元数据的消息：绑定到该书讨论（重置轮次、补全书上下文）。
        // 不带 selectedText 的自由消息不绑定书级 TAKEAWAY，但仍进入该书的会话上下文。
        const bookScoped = msg.bookId && msg.selectedText
        if (bookScoped) {
          currentAnn = {
            bookId: msg.bookId, bookTitle: msg.bookTitle,
            chapter: msg.chapter, chapterUid: msg.chapterUid,
            selectedText: msg.selectedText, userNote: msg.content,
          }
          annTurnCount = 0
        }
        let userMsg = enrichChatMessage(msg)
        if (bookScoped) {
          annTurnCount++
          if (annTurnCount >= 3 && currentAnn) {
            userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
          }
        }
        const reply = await say(userMsg, { bookKey: key })
        const takeaway = extractTakeaway(reply)
        // TAKEAWAY 只归属书级讨论；自由提问不写书级总结
        if (bookScoped && takeaway && currentAnn) { saveTakeaway(currentAnn, takeaway) }
        console.log('\n[侧栏] ' + stripCodeBlocks(reply) + '\n')
      }
      setChatInputCursor(inputs.length)
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
    if (line === '/topics') {
      console.log('\n' + readIfExists(path.join(AGENT_DIR, 'open_topics.md')) + '\n')
      rl.prompt(); return
    }

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
        // 普通用户回复：追踪轮次，第 3 轮起附 takeaway 请求
        annTurnCount++
        let userMsg = line
        if (annTurnCount >= 3 && currentAnn) {
          userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
        }
        // AI-001：有当前书讨论锚点归该书，否则归"正在读的书"或通用上下文
        const key = currentAnn ? baseBookId(currentAnn.bookId) : (currentBookKey || '_common')
        const reply = await say(userMsg, { bookKey: key })

        const takeaway = extractTakeaway(reply)
        if (takeaway && currentAnn) {
          saveTakeaway(currentAnn, takeaway)
          console.log(`\n  [takeaway 已保存]\n`)
          // 收口总结已保存，关闭本轮讨论周期：后续 REPL 输入不再绑定到这本书，
          // 避免用户切到别的书继续输入时把总结写进旧书（下次标注会重新锚定）
          currentAnn = null
        }

        console.log('\n' + stripCodeBlocks(reply) + '\n')
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
    try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
    console.log('👋 共读会话结束。')
    process.exit(0)
  }

  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
