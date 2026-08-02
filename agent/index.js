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

// ── 上下文加载（启动时一次性构建） ──────────────────────────────────────────
function buildSystemInstruction() {
  const rules = readIfExists(path.join(AGENT_DIR, 'AGENT.md'))
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  const soul = readIfExists(path.join(AGENT_DIR, 'soul.md'))
  const openTopics = readIfExists(path.join(AGENT_DIR, 'open_topics.md'))
  return [
    '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n',
    rules,
    '\n\n========\n# 用户阅读画像（profile.md）\n', profile,
    '\n\n========\n# 你的自画像（soul.md）\n', soul,
    '\n\n========\n# 未明话题（open_topics.md）\n', openTopics,
  ].join('')
}

// ── 侧栏聊天 I/O ─────────────────────────────────────────────────────────────
function appendChatOutput(role, content) {
  try { fs.appendFileSync(CHAT_OUTPUT, JSON.stringify({ role, content: stripCodeBlocks(content), timestamp: Date.now() }) + '\n') } catch {}
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
const history = []  // [{ role: 'user'|'assistant', content: string }]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function htmlTitle(text) {
  const match = String(text || '').match(/<h1[^>]*>(.*?)<\/h1>/i)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

async function callLLMOnce(maxTokens = 8192) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, ...history],
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

async function callLLM(maxTokens = 8192) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callLLMOnce(maxTokens)
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

async function say(userText, options = {}) {
  history.push({ role: 'user', content: userText })
  let reply
  try {
    reply = await callLLM(options.maxTokens || 8192)
  } catch (e) {
    history.pop()
    return `⚠️ ${e.message}`
  }
  history.push({ role: 'assistant', content: reply })
  return reply
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

// 会话结束时合并重写 profile / soul，保持文件精简不膨胀
async function saveSessionMemory() {
  if (history.length < 4) return
  console.log('\n正在固化本次会话记忆...')

  const specs = [
    { type: 'profile', file: 'profile.md', maxChars: 400 },
    { type: 'soul', file: 'soul.md', maxChars: 250 },
  ]

  for (const { type, file, maxChars } of specs) {
    const filePath = path.join(AGENT_DIR, file)
    const oldContent = readIfExists(filePath)

    // 备份旧文件
    if (oldContent) {
      try { fs.copyFileSync(filePath, filePath + '.bak') } catch {}
    }

    const prompt = `会话即将结束。请将原内容与本次讨论的新认知合并，输出完整的重写版本（删去被覆盖的旧条目，保持精简）。

只输出合并后的完整 ${file} 内容（≤${maxChars}字），不要输出任何其他文字、标记或说明。
无新认知则原样输出原内容。

原内容：
${oldContent || '（尚无记录）'}`

    let content = await rewriteWithRetry(type, prompt)
    if (content) {
      fs.writeFileSync(filePath, content + '\n')
      console.log(`  ✓ ${file} 已合并重写`)
    } else {
      console.log(`  ⚠️ ${file} 重试后仍未通过校验，保留旧文件`)
    }
  }
}

async function rewriteWithRetry(type, prompt) {
  const MIN_LEN = 30  // 去空白后最少 30 字

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await say(prompt, { maxTokens: 1200 })
    // say() 已经把 {role:'assistant', content:resp} 推入了 history
    // 下面是 LLM 对单任务的回复，整段即是目标内容，无需正则切割

    const content = resp.trim()
    const stripped = content.replace(/\s/g, '')
    if (stripped.length >= MIN_LEN) return content

    // 校验失败：从 history 里摘掉坏回复，追加纠正指令重试
    console.log(`  ⚠️ ${type} 第 ${attempt + 1} 次校验未通过（去空白 ${stripped.length} 字），重试...`)
    history.pop()  // 移除坏的 assistant 回复
    history.pop()  // 移除触发它的 user 消息
    prompt = `上一次的输出太短或为空（去空白仅 ${stripped.length} 字）。请重新输出合并后的完整内容，不要省略。`
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
  const cursor = getCursor()
  if (cursor >= anns.length) return false

  for (let i = cursor; i < anns.length; i++) {
    const ann = anns[i]
    // silent 标注只存档不触发讨论（用户已通过 /chat 发送了聊天消息）
    if (ann.silent) continue
    currentAnn = ann
    annTurnCount = 0
    console.log(`\n── 新划线 · 《${ann.bookTitle}》${ann.chapter || ''} ──`)
    const reply = await say(buildAnnotationPrompt(ann))
    console.log('\n' + stripCodeBlocks(reply) + '\n')
    appendChatOutput('assistant', reply)
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

  const had = await processNewAnnotations()
  if (!had) console.log('（暂无新标注。开始阅读后划线，我会接话。）\n')

  rl.prompt()

  let busy = false

  // 每 3 秒轮询新标注 + 侧栏用户消息
  const poller = setInterval(async () => {
    if (busy) return

    // 优先处理新标注
    const anns = readAnnotations()
    if (getCursor() < anns.length) {
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
    const chatCursor = getChatInputCursor()
    if (chatCursor >= inputs.length) return
    busy = true
    rl.pause()
    try {
      for (let i = chatCursor; i < inputs.length; i++) {
        const msg = inputs[i]
        // 带书籍元数据的消息：补全章节上下文，设置标注状态用于 takeaway
        if (msg.bookId && msg.selectedText) {
          currentAnn = {
            bookId: msg.bookId, bookTitle: msg.bookTitle,
            chapter: msg.chapter, chapterUid: msg.chapterUid,
            selectedText: msg.selectedText, userNote: msg.content,
          }
          annTurnCount = 0
        }
        annTurnCount++
        let userMsg = enrichChatMessage(msg)
        if (annTurnCount >= 3 && currentAnn) {
          userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
        }
        const reply = await say(userMsg)
        const takeaway = extractTakeaway(reply)
        if (takeaway && currentAnn) { saveTakeaway(currentAnn, takeaway) }
        console.log('\n[侧栏] ' + stripCodeBlocks(reply) + '\n')
        appendChatOutput('assistant', reply)
      }
      setChatInputCursor(inputs.length)
    } catch (e) { console.log(`⚠️ ${e.message}\n`) }
    busy = false
    rl.resume()
    rl.prompt()
  }, 3000)

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
        const reply = await say(line)
        console.log('\n' + stripCodeBlocks(reply) + '\n')
        appendChatOutput('assistant', reply)
      } else {
        // 普通用户回复：追踪轮次，第 3 轮起附 takeaway 请求
        annTurnCount++
        let userMsg = line
        if (annTurnCount >= 3 && currentAnn) {
          userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
        }
        const reply = await say(userMsg)

        const takeaway = extractTakeaway(reply)
        if (takeaway && currentAnn) {
          saveTakeaway(currentAnn, takeaway)
          console.log(`\n  [takeaway 已保存]\n`)
        }

        console.log('\n' + stripCodeBlocks(reply) + '\n')
        appendChatOutput('assistant', reply)
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
    try { await saveSessionMemory() } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
    console.log('👋 共读会话结束。')
    process.exit(0)
  }

  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
