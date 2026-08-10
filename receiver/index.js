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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.COREAD_PORT || '7239')
const BOOKS_DIR = path.join(__dirname, 'books')
const INBOX_DIR = path.join(__dirname, 'inbox')
const CHAT_OUTPUT = path.join(INBOX_DIR, 'chat_output.jsonl')
const DEBUG_LOG = path.join(INBOX_DIR, 'debug.jsonl')

fs.mkdirSync(BOOKS_DIR, { recursive: true })
fs.mkdirSync(INBOX_DIR, { recursive: true })

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

// 初始化 chat_output 游标（跳过已有内容，只推送新消息）
let chatOutputLastLine = (() => {
  try { return fs.readFileSync(CHAT_OUTPUT, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 }
})()

// 每 100ms 轮询 chat_output.jsonl，有新行就推送给所有 SSE 客户端。
// 流式中间记录（_stream）也原样推送，侧栏据此渲染打字机效果；/history 仍过滤它们。
setInterval(() => {
  try {
    const lines = fs.readFileSync(CHAT_OUTPUT, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length <= chatOutputLastLine) return
    const fresh = lines.slice(chatOutputLastLine)
    chatOutputLastLine = lines.length
    // 无论有无客户端都经 pushSSE 缓冲进 recentEvents（AI-006）：
    // 断线重连时按 Last-Event-ID 只重放没收到的事件。首次连接（lastId=0）不回放，
    // 侧栏已通过 /history 加载历史；重复再由侧栏 _seenMsgs 去重。
    for (const line of fresh) {
      try { pushSSE('message', JSON.parse(line)) } catch {}
    }
  } catch {}
}, 100)

function bookDir(bookId) {
  // 归一化：去掉微信读书的 k-suffix 会话变体，一本书只对应一个目录
  const normalized = baseBookId(bookId)
  const d = path.join(BOOKS_DIR, normalized)
  fs.mkdirSync(path.join(d, 'chapters'), { recursive: true })
  return d
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
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
  const chapterFile = path.join(bookDir(bookId), 'chapters', `${chapterUid}.txt`)
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
        _ts: d.receivedAt || d.timestamp * 1000 })
    }
    const chatItems = []
    for (const d of readJsonl(path.join(INBOX_DIR, 'chat_input.jsonl'))) {
      // 带书上下文的消息保留 bookId，供侧栏按书隔离引用与对话（AI-001）
      const item = { role: 'user', content: d.content, _ts: d.timestamp }
      if (d.bookId) {
        item.bookId = d.bookId
        item.bookTitle = d.bookTitle || ''
        item.chapter = d.chapter || ''
        item.chapterUid = d.chapterUid || ''
        item.chapterUidInt = d.chapterUidInt || 0
        item.selectedText = d.selectedText || ''
      }
      chatItems.push(item)
    }
    for (const d of readJsonl(CHAT_OUTPUT)) {
      if ('_stream' in d) continue  // 过滤流式中间分片
      chatItems.push({ role: 'assistant', content: d.content, _ts: d.timestamp || 0 })
    }
    // 标注 + 最近 200 条聊天按时间戳交错排序：让标注与其自动回复相邻，
    // 侧栏既按时间顺序展示，也能据此为回复继承正确的书籍书签（AI-001）
    const allItems = [...annItems, ...chatItems.slice(-200)]
      .sort((a, b) => (a._ts || 0) - (b._ts || 0))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(allItems))
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

  // 共读标注列表（GET /annotations?bookId=..）
  // 返回该书所有已共读标注（selectedText 等），供内容脚本在书页里标记共读段落。
  if (req.method === 'GET' && req.url.startsWith('/annotations?')) {
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

  // POST 只允许 weread.qq.com 和 扩展 sidebar（chrome-extension://）
  if (req.method === 'POST' && origin
    && !origin.includes('weread.qq.com')
    && !origin.startsWith('chrome-extension://')) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

  let data
  try { data = await readBody(req) }
  catch { res.writeHead(400); res.end('Bad JSON'); return }

  const url = req.url

  try {
    if (url === '/annotation') {
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
      fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''))
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

    } else if (url === '/chat') {
      // 来自侧栏或共读弹窗的用户消息
      const { content, bookId, bookTitle, chapter, chapterUid, selectedText } = data
      if (!content) { res.writeHead(400); res.end(); return }
      const entry = { role: 'user', content, timestamp: Date.now() }
      if (bookId) {
        entry.bookId = bookId
        entry.bookTitle = bookTitle || ''
        entry.chapter = chapter || ''
        entry.chapterUid = chapterUid || ''
        entry.selectedText = selectedText || ''
      }
      fs.appendFileSync(path.join(INBOX_DIR, 'chat_input.jsonl'),
        JSON.stringify(entry) + '\n')

      // 来自共读弹窗的消息（不是侧栏）：推送用户消息到侧栏 + 显示思考状态
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
      const msg = `【章节完成】《${bookTitle}》${chapterTitle} 已读完，请生成本章摘要并问我这章的 learning。`
      triggerInject(msg)

    } else if (url === '/progress') {
      // 进度同步（来自 weread API 兜底轮询，后期用）
      const { bookId } = data
      if (bookId) {
        const payload = JSON.stringify({ ...data, updatedAt: Date.now() })
        fs.writeFileSync(path.join(bookDir(bookId), 'progress.json'), payload)
        writeBookMeta(bookId, data)
      }

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
