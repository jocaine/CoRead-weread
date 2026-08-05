/**
 * CoRead content script — 运行于 weread.qq.com/web/reader/*
 */

const RECEIVER = 'http://127.0.0.1:7239'
const DEBUG_VERSION = 'selection-context-v1'

// ── 1.5 章节槽位跟踪 ──────────────────────────────────────────────────────────
// WeRead 阅读时顶层 URL hash 恒为空，无法作为章节标识。
// 章节 API 的路径（/web/book/chapter/e_0）是唯一可靠的章节标识，这里跟踪它，
// 供标注 / 引用 / 跳转使用。前缀（t_/e_）也从中学习。
let _chapterSlot = ''        // 原始章节槽位，如 "e_20"
let _chapterTitle = ''       // 最近一次捕获到的章节标题
let _chapterPrefix = 'e'     // 章节前缀，默认 'e'（本项目的 epub 书）
let _chapterUidInt = 0       // 阅读位置整数 chapterUid（getProgress 提供），跳转 URL 用

// 跨 frame 共享最近章节（标注可能发生在与网络捕获不同的 frame）
// 带 bookId 归一化，避免切书后误用上一本书的章节槽位
async function persistSharedChapter(bookId, slot, title, uidInt) {
  try {
    // uidInt 为 0 时不覆盖同书已有的有效值（getProgress 与章节捕获可能在不同 frame/时刻）
    let mergedUid = uidInt || 0
    if (!mergedUid) {
      const prev = await readSharedChapter()
      if (prev && prev.bookId === baseBookId(bookId) && prev.uidInt) mergedUid = prev.uidInt
    }
    await chrome.storage.session.set({
      coreadChapter: { bookId: baseBookId(bookId), slot, title, uidInt: mergedUid, ts: Date.now() },
    })
  } catch {}
}
async function readSharedChapter() {
  try {
    const { coreadChapter } = await chrome.storage.session.get('coreadChapter')
    return coreadChapter || null
  } catch { return null }
}

// ── 1. 允许文字选中 ──────────────────────────────────────────────────────────
const styleEl = document.createElement('style')
styleEl.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }'
document.head.appendChild(styleEl)

// ── 2. 接收 page_hook.js（MAIN world）拦截到的消息 ──────────────────────────
let _copiedText = ''
let _copySelection = null
window.addEventListener('message', e => {
  if (e.data?.__cr === 'copy') {
    _copiedText = e.data.text
    _copySelection = e.data.selection || null
  }
  if (e.data?.__cr === 'chapter') handleChapterContent(e.data.url, e.data.raw)
  if (e.data?.__cr === 'progress') handleProgressContent(e.data.url, e.data.raw)
  if (e.data?.__cr === 'bookmarks') handleBookmarkContent(e.data.url, e.data.raw)
  if (e.data?.__cr === 'add-bookmark') handleAddBookmark(e.data.url, e.data.body)
  if (e.data?.__cr === 'add-bookmark-response') handleAddBookmarkResponse(e.data.raw)
  if (e.data?.__cr === 'remove-bookmark-req') {
    // 微信读书内部删划线：同步删掉对应共读引用（划线即引用，引用也一并消失）
    postDebug({ source: 'bookmark-remove', stage: 'we-read-req-format', body: String(e.data.body || '').slice(0, 300) })
    handleWeReadRemoveBookmark(e.data.body)
  }
  if (e.data?.__cr === 'network-meta') {
    postDebug({
      source: 'network-discover',
      stage: e.data.source || '',
      url: e.data.url || '',
      rawLength: e.data.rawLength || 0,
      preview: e.data.preview || '',
    })
  }
})

// ── 3. 从 DOM / URL 读取当前阅读上下文 ────────────────────────────────────
// 通知侧栏当前书籍上下文（AI-001 书籍隔离）。
// 切书 = 整页导航 → content.js 重新加载 → 这里在 init 广播一次；
// 另有 observer 监听 bookId 变化兜底（SPA 式不刷新切书）。
function broadcastBookContext(ctx) {
  if (!ctx) return
  try {
    chrome.runtime.sendMessage({
      action: 'coreadBookContext',
      bookId: ctx.bookId || '',
      bookTitle: ctx.bookTitle || '',
      chapter: ctx.chapter || '',
      chapterUid: ctx.chapterUid || '',
      chapterUidInt: ctx.chapterUidInt || 0,
    })
  } catch {}
}

// 微信读书 reader URL 的 k 后缀解码（逆向自阅读器 JS，已验证）：
// "06432b4029e064096632ab8" → "158"（整数 chapterUid）
function weReadDecode(enc) {
  if (typeof enc !== 'string' || enc.length <= 3) return ''
  const type = enc.charAt(3)
  let i = 5 + parseInt(enc.charAt(4))
  const end = enc.length - 3
  let out = ''
  for (; i < end && (i === 5 + parseInt(enc.charAt(4)) || enc.charAt(i) === 'g');) {
    if (i !== 5 + parseInt(enc.charAt(4)) && enc.charAt(i) === 'g') i++
    if (i + 2 > end) return ''
    const chunkLen = parseInt(enc.substr(i, 2), 16)
    if (i + 2 + chunkLen > end) return ''
    const chunk = enc.substr(i + 2, chunkLen)
    let seg = ''
    if (type === '3') { const n = parseInt(chunk, 16); if (isNaN(n)) return ''; seg = '' + n }
    else { for (let k = 0; k < chunk.length; k += 2) seg += String.fromCharCode(parseInt(chunk.substr(k, 2), 16)) }
    out += seg; i = i + 2 + chunkLen
  }
  return out
}

// 从顶层 reader URL 的 k 后缀解码当前章节整数 chapterUid。
// frame 无关（读 window.top.location），比依赖本 frame 的 getProgress 更可靠。
function chapterUidIntFromUrl() {
  try {
    const path = (() => { try { return window.top.location.pathname } catch { return location.pathname } })()
    const m = String(path).match(/k([0-9a-f]+)$/i)
    if (!m) return 0
    const n = Number(weReadDecode(m[1]))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

function getReadingContext() {
  const topPath = (() => { try { return window.top.location.pathname } catch { return location.pathname } })()
  // AI-001 书籍隔离：只有阅读器页（/web/reader/…）的路径段才是书 ID。
  // 书架/首页/书籍详情等页面的路径段是 "shelf"、"web" 等非书 ID，若误当 bookId
  // 广播给侧栏，会把侧栏"当前书"设成垃圾值，导致切换引用栏的按书隔离失效。
  const readerMatch = /^\/web\/reader\/([^/]+)$/.exec(topPath)
  const bookId = readerMatch ? readerMatch[1] : ''
  const topDoc = (() => { try { return window.top.document } catch { return document } })()
  const bookTitle =
    topDoc.querySelector('.readerTopBar_title')?.textContent?.trim() ||
    topDoc.querySelector('[class*="readerTop"] [class*="title"]')?.textContent?.trim() ||
    topDoc.title.replace('微信读书', '').trim()
  const chapter =
    topDoc.querySelector('.readerChapterTitleWrap_title')?.textContent?.trim() ||
    topDoc.querySelector('[class*="chapterTitle"]')?.textContent?.trim() ||
    _chapterTitle ||
    ''
  // URL hash 只在跳转/手动导航时出现，正常阅读为空；用跟踪的网络槽位兜底
  const hashSlot = (() => { try { return window.top.location.hash.replace('#', '') } catch { return '' } })()
  const chapterUid = (/^[te]_\d+$/.test(hashSlot) ? hashSlot : _chapterSlot) || ''
  // 整数 chapterUid：跳转 URL 用（k{encode(chapterUidInt)}）。
  // 优先 URL k 后缀解码（frame 无关、反映当前章节），回退本 frame 的 getProgress 追踪。
  const uidInt = chapterUidIntFromUrl() || _chapterUidInt || 0
  return { bookId, bookTitle, chapter, chapterUid, chapterUidInt: uidInt }
}

function previewText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

// 乱码/损坏文本检测：含替换字符 �（传输/解码损坏的明确标记），
// 或 WeRead 的加密章节 blob（32 位 hex 前缀 + 一长串 base64）。这类文本存成引用
// 会成为侧栏里删不掉的乱码引用（jsonl 里通常没有对应记录，删除永远返回 deleted:0）。
function isGarbledText(text) {
  const s = String(text || '')
  if (/[\uFFFD]/.test(s)) return true
  return /^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]{100,}$/.test(s.trim())
}

function getQueryParam(queryText, name) {
  for (const part of String(queryText || '').split('&')) {
    const [key, value = ''] = part.split('=')
    if (key === name) {
      try { return decodeURIComponent(value.replace(/\+/g, ' ')) }
      catch { return value }
    }
  }
  return ''
}

function utf8FromBase64(value) {
  try {
    const clean = String(value || '').replace(/[^A-Za-z0-9+/=]/g, '')
    const padded = clean + '='.repeat((4 - clean.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

function textScore(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const bad = (s.match(/\uFFFD/g) || []).length
  return cjk * 4 - bad * 20 + Math.min(s.length, 2000) / 200
}

function decodeWereadChapter(raw) {
  const source = String(raw || '').trim()
  if (!/^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]/.test(source)) return ''

  const bodyWithMarker = source.slice(32)
  const body = source.slice(33)
  const candidates = [
    body,
    bodyWithMarker,
    '5' + bodyWithMarker,
    '6' + bodyWithMarker,
    '7' + bodyWithMarker,
    'P' + body,
  ]
  for (let i = 0; i < 6; i++) {
    candidates.push(source.slice(32 + i))
    candidates.push(source.slice(33 + i))
  }

  let best = ''
  let bestScore = 0
  for (const candidate of candidates) {
    const decoded = utf8FromBase64(candidate).replace(/\uFFFD+/g, '')
    const score = textScore(decoded)
    if (score > bestScore) {
      best = decoded
      bestScore = score
    }
  }
  return bestScore > 40 ? best : ''
}

async function postDebug(data) {
  try {
    await fetch(`${RECEIVER}/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debugVersion: DEBUG_VERSION, ...getReadingContext(), ...data, timestamp: Date.now() }),
    })
  } catch {}
}

async function handleProgressContent(url, raw) {
  let data
  try { data = JSON.parse(raw) } catch { return }
  const ctx = getReadingContext()
  const book = data.book || {}
  // 追踪整数 chapterUid（阅读位置），供跳转 URL 使用（k{encode(chapterUidInt)}）
  if (Number.isFinite(book.chapterUid)) _chapterUidInt = book.chapterUid
  // getProgress 响应含微信读书内部书 ID（CB_xxx），没等到 bookmarklist 时也尽早记下，
  // 供删除划线时构造 bookmarkId / 拉 bookmarklist
  if (data.bookId) _wereadBookId = data.bookId
  // 进度 API 兜底：网络章节拦截缺位时补上槽位。
  // 进度响应里的 chapterUid 是纯数字索引（如 20），不带 e_/t_ 前缀，
  // 所以前缀只能来自真实章节捕获：本 frame 的 _chapterSlot（已被 !_chapterSlot 排除），
  // 或跨 frame 共享的 coreadChapter.slot。有真实前缀才构造槽位，否则不伪造——
  // 用默认 'e' 给 txt 书会造出错误的 e_N，污染标注。
  if (!_chapterSlot && Number.isFinite(book.chapterIdx)) {
    const shared = await readSharedChapter()
    const sharedSlot = shared && (!shared.bookId || shared.bookId === baseBookId(ctx.bookId)) ? shared.slot : ''
    const prefix = /^[te]_\d+$/.test(sharedSlot) ? sharedSlot.split('_')[0] : ''
    if (prefix) {
      const slot = `${prefix}_${book.chapterIdx}`
      _chapterSlot = slot
      persistSharedChapter(ctx.bookId, slot, book.chapterTitle || ctx.chapter || '', _chapterUidInt)
    }
  }
  // 无论槽位是否已有，都把最新整数 chapterUid 持久化到共享章节
  // （getProgress 是整数 chapterUid 的可靠来源，可能只在本 frame 触发；
  //  引用创建在别的 frame 时靠 shared.uidInt 兜底）
  if (_chapterUidInt) {
    const slotForPersist = _chapterSlot || ''
    const titleForPersist = book.chapterTitle || ctx.chapter || ''
    if (slotForPersist || titleForPersist) {
      persistSharedChapter(ctx.bookId, slotForPersist, titleForPersist, _chapterUidInt)
    }
  }
  const payload = {
    bookId: ctx.bookId,
    bookTitle: ctx.bookTitle,
    chapterTitle: ctx.chapter,
    wereadBookId: data.bookId || book.bookId || '',
    chapterUid: book.chapterUid || '',
    chapterIdx: book.chapterIdx || '',
    chapterOffset: Number.isFinite(book.chapterOffset) ? book.chapterOffset : 0,
    summary: book.summary || '',
    synckey: book.synckey || '',
    sourceUrl: url,
  }
  try {
    await fetch(`${RECEIVER}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    await postDebug({
      source: 'progress',
      stage: 'saved',
      chapterUid: payload.chapterUid,
      chapterOffset: payload.chapterOffset,
      summaryPreview: previewText(payload.summary),
    })
  } catch (e) {
    console.warn('[CoRead] progress POST failed:', e.message)
  }
}

// ── 3.5 微信读书划线 → 共读引用（bookmarklist 批量 + addBookmark 实时） ─────
// 把微信读书划线（markText + chapterUid 整数 + range 位置）同步成共读引用：
// 跳转直接用整数 chapterUid 走 WeRead 原生 URL / 内部定位，不依赖 DOM。
// 幂等：入库前先查 /annotations 已存在的 selectedText，避免重复堆积。
// 触发源：1) bookmarklist 响应（打开书/刷新时的已有划线）；2) addBookmark 请求
//（用户新画一条线的实时创建，立即成引用）。
async function syncBookmarkRef(text, uidInt, range, bookmarkId) {
  const t = String(text || '').trim()
  const u = Number(uidInt) || 0
  if (!t || !u) return false
  const ctx = getReadingContext()
  const bookId = ctx.bookId
  if (!bookId) return false
  try {
    const r = await fetch(`${RECEIVER}/annotations?bookId=${encodeURIComponent(bookId)}`)
    const list = await r.json()
    for (const a of list || []) {
      if (a.selectedText && normalizeText(a.selectedText) === normalizeText(t)) return false  // 已存在
    }
  } catch {}
  try {
    const resp = await fetch(`${RECEIVER}/annotation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...ctx, selectedText: t, userNote: '',
        silent: true, setRef: false, source: 'bookmark-sync',
        chapterUid: '', chapterUidInt: u,
        bookmarkRange: String(range || ''),
        // 持久化 bookmarkId：删除引用时侧栏直接携带，绕开内存映射/frame 差异
        bookmarkId: String(bookmarkId || ''),
        timestamp: Math.floor(Date.now() / 1000),
      }),
    })
    postDebug({ source: 'bookmark-sync', stage: 'created', chapterUidInt: u, range: String(range || ''), bookmarkId: String(bookmarkId || ''), text: t.slice(0, 24) })
    return resp.ok
  } catch { return false }
}

// 微信读书划线 → bookmarkId 映射（删除引用时用它删微信读书的划线）。
// key: `${baseBookId}:${chapterUidInt}:${range}`。bookmarklist 响应 + addBookmark 响应填充。
const _bookmarkIdByRange = {}
// 微信读书内部书 ID（形如 CB_xxx，bookmarklist / getProgress / bookmarkId 里出现），
// 用于按已知格式构造 bookmarkId、拉取 bookmarklist 精确匹配。与 URL 里的 v-id 不同。
let _wereadBookId = ''
// 我们自己发起的 removeBookmark（侧栏删引用时直接调 API），page_hook 同样会拦截到，
// 用这个集合跳过自触发，避免把刚删完的引用再删一遍 / 推无意义的删除事件。
const _removingBookmarkIds = new Set()

function rememberBookmarkId(bookId, uidInt, range, bookmarkId) {
  if (!bookmarkId || !range) return
  const u = Number(uidInt) || 0
  if (!u) return
  _bookmarkIdByRange[`${baseBookId(bookId)}:${u}:${String(range)}`] = String(bookmarkId)
}

// 从 bookmarkId（形如 `${wereadBookId}_${chapterUidInt}_${start}-${end}`，如
// CB_5mV8e38bN3LX70d71Y1rh59U_159_6325-6356）解析章节与位置。
// addBookmark 响应只有 bookmarkId、不含 chapterUid/range，请求侧信息又可能跨 frame 丢失，
// 用它兜底回填映射。返回 null 表示格式不符（注释类 bookmarkId 可能不同）。
function parseBookmarkIdParts(bookmarkId) {
  const parts = String(bookmarkId || '').split('_')
  if (parts.length < 3) return null
  const range = parts[parts.length - 1]
  const uid = Number(parts[parts.length - 2])
  if (!uid || !/^\d+-\d+$/.test(range)) return null
  return { uidInt: uid, range, wereadBookId: parts.slice(0, parts.length - 2).join('_') }
}

async function handleBookmarkContent(url, raw) {
  let data
  try { data = JSON.parse(raw) } catch { return }
  const ctx = getReadingContext()
  const updated = Array.isArray(data.updated) ? data.updated : []
  if (!updated.length) return
  for (const bk of updated) {
    if (bk.bookId) _wereadBookId = bk.bookId
    const text = String(bk.markText || bk.text || '').trim()
    const uidInt = Number(bk.chapterUid) || 0
    if (!text || !uidInt) continue
    if (bk.bookmarkId) rememberBookmarkId(ctx.bookId, uidInt, bk.range || '', bk.bookmarkId)
    await syncBookmarkRef(text, uidInt, bk.range || bk.markPos || '', bk.bookmarkId || '')
  }
}

// 微信读书内部删除划线（用户在书页里点「删除划线」）：请求体含 bookmarkId，
// 据此把对应共读引用从接收端存档删掉（receiver 会推 annotation-removed 事件，
// 侧栏据此移除引用列表并刷新共读标记）。自己发起的删除用 _removingBookmarkIds 跳过。
async function handleWeReadRemoveBookmark(body) {
  let data
  try { data = JSON.parse(body) } catch { return }
  const bookmarkId = String(data.bookmarkId || '')
  if (!bookmarkId) return
  if (_removingBookmarkIds.has(bookmarkId)) {
    postDebug({ source: 'bookmark-remove', stage: 'we-read-sync-skip', bookmarkId })
    return
  }
  const parts = parseBookmarkIdParts(bookmarkId)  // 顺带回填 wereadBookId
  if (parts && !_wereadBookId) _wereadBookId = parts.wereadBookId
  const ctx = getReadingContext()
  postDebug({ source: 'bookmark-remove', stage: 'we-read-sync', bookmarkId, uidInt: parts && parts.uidInt, range: parts && parts.range, bookId: ctx.bookId })
  try {
    const resp = await fetch(`${RECEIVER}/annotation-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookmarkId,
        bookId: ctx.bookId || '',
        chapterUidInt: (parts && parts.uidInt) || 0,
        bookmarkRange: (parts && parts.range) || '',
        source: 'weread',
      }),
    })
    const j = await resp.json().catch(() => null)
    postDebug({ source: 'bookmark-remove', stage: 'we-read-sync-result', deleted: j && j.deleted })
  } catch (e) {
    postDebug({ source: 'bookmark-remove', stage: 'we-read-sync-err', message: e.message })
  }
}

// addBookmark 请求体里 markText 是 base64 编码的 UTF-8（如 "5ZCO5aSH..." → "后备队..."），
// 只有纯 base64 字母表（无空格/标点）且解码出有效中文（允许少量结尾替换字符）才解码，否则原样保留。
function tryBase64Decode(s) {
  try {
    const t = String(s || '').trim()
    if (t.length < 12) return s
    if (!/^[A-Za-z0-9+/=]+$/.test(t)) return s
    const binary = atob(t)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const decoded = new TextDecoder().decode(bytes)
    const cjk = (decoded.match(/[一-鿿]/g) || []).length
    const bad = (decoded.match(/�/g) || []).length
    if (cjk > 0 && bad <= Math.max(1, Math.floor(decoded.length / 20))) return decoded
  } catch {}
  return s
}

// 实时：用户新画一条微信读书划线（addBookmark 请求体含位置）。
// 新建成功后自动打开侧栏，让"划线即引用"有看得见的反应（侧栏打开时 SSE 会推给它）。
// 记下请求的位置（响应里没有 chapterUid/range），供 addBookmark 响应回填 bookmarkId。
// 用 Map<range> 池代替原单个槽位：快速连画多条划线时各自独立，响应按 range 精确
// 匹配，避免后到请求覆盖前一条导致 bookmarkId 记到错误位置（AI-006）。
const _pendingAddBookmarks = new Map()
function _findPendingAddBookmark(rangeKey) {
  if (!_pendingAddBookmarks.size) return null
  const exact = rangeKey && _pendingAddBookmarks.get(String(rangeKey))
  if (exact) return exact
  // 响应不携带任何位置信息时按插入序取最老一条（FIFO best-effort）
  return _pendingAddBookmarks.values().next().value || null
}
async function handleAddBookmark(url, body) {
  let data
  try { data = JSON.parse(body) } catch { return }
  const text = tryBase64Decode(data.markText)
  const range = String(data.range || '')
  if (range) {
    _pendingAddBookmarks.set(range, { chapterUidInt: Number(data.chapterUid) || 0, range })
    if (_pendingAddBookmarks.size > 50) {  // 防泄漏上限，超限丢最老
      const oldestKey = _pendingAddBookmarks.keys().next().value
      _pendingAddBookmarks.delete(oldestKey)
    }
  }
  postDebug({ source: 'bookmark-sync', stage: 'add-req', uid: data.chapterUid, range: data.range, hasMark: !!data.markText, markLen: String(text || '').length })
  const created = await syncBookmarkRef(text, data.chapterUid, data.range)
  if (created) {
    try { chrome.runtime.sendMessage({ action: 'openPanel' }).catch(() => {}) } catch {}
  }
}

// addBookmark 响应：提取新建划线的 bookmarkId，删除引用时用它删微信读书的划线。
// 宽容解析（{bookmarkId} / {book:{...}} / {data:{...}}）。响应通常只有 bookmarkId，
// 没有 chapterUid/range，优先从 bookmarkId 内嵌位置或 _pendingAddBookmarks 池补全后缓存。
function handleAddBookmarkResponse(raw) {
  let data
  try { data = JSON.parse(raw) } catch { return }
  const bookmarkId =
    data.bookmarkId || data.id ||
    (data.book && (data.book.bookmarkId || data.book.id)) ||
    (data.data && (data.data.bookmarkId || data.data.id)) || ''
  if (!bookmarkId) {
    postDebug({ source: 'bookmark-sync', stage: 'add-resp-no-id', preview: String(raw).slice(0, 160) })
    return
  }
  // 位置信息的权威优先级（AI-006，防快速连画多条时 pending 被后续请求覆盖导致串槽）：
  //   1) 响应体自带 chapterUid/range（新建划线的真实位置）
  //   2) bookmarkId 字符串内嵌的 wereadBookId_uidInt_range（parseBookmarkIdParts）
  //   3) 请求时按 range 记下的 pending 池（best-effort，精确匹配或 FIFO 最老）
  const parsed = parseBookmarkIdParts(bookmarkId)
  if (parsed && !_wereadBookId) _wereadBookId = parsed.wereadBookId
  const respUidInt = Number(data.chapterUid || (data.book && data.book.chapterUid) || (data.data && data.data.chapterUid)) || 0
  const respRange = String(data.range || (data.book && data.book.range) || (data.data && data.data.range) || '')
  let uidInt = respUidInt || (parsed && parsed.uidInt) || 0
  let range = respRange || (parsed && parsed.range) || ''
  if (!uidInt || !range) {
    const pending = _findPendingAddBookmark(range)
    if (pending) {
      if (!uidInt) uidInt = pending.chapterUidInt
      if (!range) range = pending.range
    }
  }
  if (range) _pendingAddBookmarks.delete(String(range))  // 消费掉的 pending 及时清掉
  const ctx = getReadingContext()
  if (uidInt && range) rememberBookmarkId(ctx.bookId, uidInt, range, bookmarkId)
  postDebug({ source: 'bookmark-sync', stage: 'add-resp', bookmarkId, uidInt, range, parsedUid: parsed && parsed.uidInt, parsedRange: parsed && parsed.range, respUidInt, respRange })
}

// ── 4. 标注弹窗 ────────────────────────────────────────────────────────────
let popup = null

function removePopup() {
  if (popup) { popup.remove(); popup = null }
}

function showAnnotationPopup(selectedText, x, y) {
  removePopup()
  if (!selectedText) return

  popup = document.createElement('div')
  popup.id = 'coread-popup'
  Object.assign(popup.style, {
    position: 'fixed',
    left: Math.min(x - 150, window.innerWidth - 320) + 'px',
    top: Math.min(y + 12, window.innerHeight - 180) + 'px',
    zIndex: '2147483647',
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: '12px',
    width: '300px',
    fontFamily: '-apple-system, sans-serif',
    fontSize: '14px',
  })

  popup.innerHTML = `
    <div style="color:#888;margin-bottom:4px;font-size:11px;">设为当前引用</div>
    <div style="color:#555;margin-bottom:10px;font-size:12px;line-height:1.5;max-height:72px;overflow-y:auto;
                padding:6px 8px;background:#f8f8f8;border-left:3px solid #07c160;border-radius:4px;">
      ${escHtml(selectedText)}
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
      <button id="coread-cancel"
        style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;
               background:#f5f5f5;cursor:pointer;font-size:13px;">取消</button>
      <button id="coread-send"
        style="padding:4px 12px;border:none;border-radius:4px;
               background:#07c160;color:#fff;cursor:pointer;font-size:13px;">设为引用</button>
    </div>
  `
  document.documentElement.appendChild(popup)
  setTimeout(() => popup?.querySelector('#coread-send')?.focus(), 50)

  popup.querySelector('#coread-cancel').addEventListener('click', removePopup)
  popup.querySelector('#coread-send').addEventListener('click', async () => {
    const sendBtn = popup.querySelector('#coread-send')

    // 显示设置状态
    sendBtn.disabled = true
    sendBtn.textContent = '设置中...'

    const ok = await setCurrentRef(selectedText)

    if (ok) {
      sendBtn.textContent = '已设为引用 ✓'
      sendBtn.style.background = '#576b95'
    } else {
      sendBtn.textContent = '设置失败'
      sendBtn.style.background = '#e74c3c'
    }
    setTimeout(() => removePopup(), 1200)
  })
  popup.addEventListener('mousedown', e => e.stopPropagation())
}

function getDirectSelectionText() {
  const docs = [document]
  try {
    if (window.top?.document && window.top.document !== document) docs.push(window.top.document)
  } catch {}
  for (const doc of docs) {
    const text = doc.getSelection?.()?.toString?.()?.trim()
    if (text) return text
  }
  return ''
}

function escHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function setCurrentRef(selectedText) {
  // 乱码防护：损坏/编码文本不存为引用，弹窗会显示「设置失败」
  if (isGarbledText(selectedText)) {
    console.warn('[CoRead] 拒绝乱码引用：', String(selectedText).slice(0, 30))
    return false
  }
  const ctx = getReadingContext()
  // 本 frame 拿不到章节信息时，用跨 frame 共享的最新章节兜底（仅限同一本书）。
  // 整数 chapterUid 无条件合并：getProgress 可能只在顶层 frame 触发，本 frame 为 0，
  // 而 URL k 后缀解码也可能因顶层未导航而缺失，需要共享数据兜底。
  const shared = await readSharedChapter()
  if (shared && (!shared.bookId || shared.bookId === baseBookId(ctx.bookId))) {
    if (!ctx.chapterUid && shared.slot) ctx.chapterUid = shared.slot
    if (!ctx.chapter && shared.title) ctx.chapter = shared.title
    if (!ctx.chapterUidInt && shared.uidInt) ctx.chapterUidInt = shared.uidInt
  }
  // 诊断：记录设引用时的上下文（含整数 chapterUid 是否拿到），排查跳转问题
  postDebug({
    source: 'setref',
    stage: 'ctx',
    chapterUid: ctx.chapterUid || '',
    chapterUidInt: ctx.chapterUidInt || 0,
    topUrl: (() => { try { return window.top.location.pathname } catch { return '' } })().slice(0, 90),
  })

  // 后台静默发送：正文缓存（保留，为侧栏后续提问提供上下文）
  trySendSelectionContent(ctx.chapterUid, ctx, selectedText, _copySelection)
  trySendDomContent(ctx.chapterUid, ctx, selectedText)

  // 存为引用：等待入库结果，成功才走后续。setRef:true 让 receiver 推送
  // annotation-select 事件，侧栏实时设为"当前引用"，不再向 agent 发送提问。
  // 失败时如实返回 false（弹窗显示「设置失败」），避免出现提示成功但标注
  // 从未入库的假象（共读标记 / 历史恢复 / 删除同步全部依赖 annotations.jsonl）。
  let ok = false
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const resp = await fetch(`${RECEIVER}/annotation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ctx, selectedText, userNote: '', silent: true, setRef: true, timestamp: Math.floor(Date.now() / 1000) }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    ok = resp.ok
  } catch { ok = false }
  if (!ok) {
    console.warn('[CoRead] 设为引用失败：receiver 不可达')
    return false
  }

  console.log('[CoRead] set current ref', selectedText.slice(0, 30))
  // 入库成功后：记录待选引用（侧栏本次才打开时加载并选中）、通知侧栏实时选中、
  // 自动打开侧栏、刷新共读标记。
  try {
    await chrome.storage.local.set({
      pendingSelectRef: {
        bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapter: ctx.chapter || '',
        chapterUid: ctx.chapterUid || '', chapterUidInt: ctx.chapterUidInt || 0, selectedText,
      },
    })
  } catch {}
  try {
    chrome.runtime?.sendMessage({
      action: 'coreadSetRefApply',
      ref: { bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapter: ctx.chapter || '',
        chapterUid: ctx.chapterUid || '', chapterUidInt: ctx.chapterUidInt || 0, selectedText },
    }).catch(() => {})
  } catch {}
  // 自动打开侧栏，让用户看到当前引用，之后在侧栏里提问
  try { chrome.runtime?.sendMessage({ action: 'openPanel' }) } catch {}

  // 新标注已入库：清空共读标注缓存，下次 observer 触发时重新拉取，让刚共读的段落被标上
  _coReadAnns = null
  scheduleCoReadMarking()
  return true
}

// ── 5. 注入 CoRead 按钮到 weread 工具栏 ───────────────────────────────────
function injectToolbarButton() {
  const container = document.querySelector('.reader_toolbar_itemContainer')
  if (!container || container.querySelector('.coread-toolbar-btn')) return

  const btn = document.createElement('div')
  btn.className = 'toolbarItem coread-toolbar-btn'
  btn.style.cssText = 'cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;width:56px;flex-shrink:0;'
  btn.innerHTML = `
    <div class="toolbarItem_icon" style="font-size:18px;line-height:1;color:#fff;">📖</div>
    <div class="toolbarItem_text" style="font-size:11px;color:#fff;margin-top:2px;">共读</div>
  `

  btn.addEventListener('click', async () => {
    try {
      const toolbar = document.querySelector('.reader_toolbar_container')
      const rect = toolbar?.getBoundingClientRect() || { left: 200, bottom: 300, width: 300 }

      // 触发 wr_copy 按钮，拦截其 clipboard 调用来取得选中文字
      _copiedText = getDirectSelectionText()
      _copySelection = null
      try { document.querySelector('.toolbarItem.wr_copy')?.click() }
      catch (e) {
        await postDebug({ source: 'toolbar', stage: 'wr-copy-click-error', message: e.message })
      }
      await new Promise(r => setTimeout(r, 250))

      if (!_copiedText) {
        console.warn('[CoRead] 未能获取选中文字，请确认 clipboard hook 已注入')
        await postDebug({ source: 'toolbar', stage: 'copy-empty' })
        return
      }
      showAnnotationPopup(_copiedText, rect.left + rect.width / 2, rect.bottom)
    } catch (e) {
      console.warn('[CoRead] toolbar click failed:', e)
      await postDebug({ source: 'toolbar', stage: 'click-error', message: e.message, stack: String(e.stack || '').slice(0, 600) })
    }
  })

  container.appendChild(btn)
  console.log('[CoRead] toolbar button injected')
}

// ── 6. 章节正文处理 ─────────────────────────────────────────────────────────

// 来自 page_hook.js 拦截到的网络响应（主路线）
async function handleChapterContent(url, raw) {
  const urlText = String(url || '')
  const queryText = urlText.split('?')[1] || ''
  const pathText = urlText.split('?')[0] || ''
  const ctx = getReadingContext()
  const bookId = getQueryParam(queryText, 'bookId') || ctx.bookId || ''
  const slotUid = getQueryParam(queryText, 'chapterUid') || pathText.split('/').filter(Boolean).pop()
  if (/^[te]_\d+$/.test(slotUid)) {
    _chapterSlot = slotUid
    _chapterPrefix = slotUid.split('_')[0] || _chapterPrefix
    if (ctx.chapter) _chapterTitle = ctx.chapter
    persistSharedChapter(bookId, slotUid, ctx.chapter, _chapterUidInt)
  }
  const chapterUid = /^[te]_\d+$/.test(slotUid) && ctx.chapter
    // 前缀用当前章节标题，而不是 chapterFileName(ctx,'')：ctx 在 _chapterSlot 更新前
    // 捕获，其 chapterUid 仍是上一章的槽位，直接引用会把文件名拼成 e_0_e_1 这种污染名
    ? `${sanitizeChapterTitle(ctx.chapter)}_${slotUid}`
    : slotUid
  if (!bookId || !chapterUid) return

  let text = ''
  try {
    const json = JSON.parse(raw)
    text = json.content || json.chapterContent || json.data?.content || ''
    if (Array.isArray(text)) text = text.join('\n\n')
  } catch {
    text = decodeWereadChapter(raw)
    if (!text && raw.length > 200 && !/^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]/.test(String(raw || '').trim())) text = raw
  }
  await postDebug({
    source: 'network',
    stage: 'chapter-response',
    url,
    rawLength: raw.length,
    extractedTextLength: String(text || '').length,
    extractedPreview: previewText(text),
  })
  if (!text || text.length < 100) return

  text = text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId,
        baseBookId: baseBookId(bookId),
        chapterUid,
        chapterTitle: ctx.chapter,
        bookTitle: ctx.bookTitle,
        text,
        source: 'network',
      }),
    })
    console.log(`[CoRead] chapter saved via network: bookId=${bookId} uid=${chapterUid} (${text.length} chars)`)
  } catch (e) {
    console.warn('[CoRead] content POST failed:', e.message)
  }
}

// DOM 捕获 ─────────────────────────────────────────────────────────────────
function captureCurrentChapterText() {
  const paras = document.querySelectorAll([
    '.wr_readerPage p',
    '.reader_chapter p',
    '[class*="readerPage"] p',
    '[class*="reader"] p',
    '.wr_readerPage [class*="content"]',
    '.reader_chapter [class*="content"]',
    '[class*="readerPage"] [class*="content"]',
  ].join(', '))
  const text = Array.from(paras)
    .map(p => p.textContent.trim())
    .filter(t => t.length > 0)
    .join('\n\n')
  if (text.length >= 100) return text

  const container = document.querySelector('.wr_readerPage, .reader_chapter, [class*="readerPage"]')
  return (container?.innerText || '')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .join('\n\n')
}

function sanitizeChapterTitle(title) {
  return title ? String(title).replace(/[^\w一-龥]/g, '_').slice(0, 40) : ''
}

function chapterFileName(ctx, chapterUid) {
  return chapterUid || ctx.chapterUid
    || sanitizeChapterTitle(ctx.chapter)
    || `t${Date.now()}`
}

async function trySendSelectionContent(chapterUid, ctx, selectedText, selection) {
  const text = selection?.context || ''
  const containsSelection = selectedText ? normalizeText(text).includes(normalizeText(selectedText)) : false
  await postDebug({
    ...ctx,
    source: 'selection',
    stage: 'annotation-send',
    textLength: text.length,
    contextLength: selection?.contextLength || 0,
    containsSelection,
    selectedTextLength: selectedText.length,
    selectedPreview: previewText(selectedText),
    textPreview: previewText(text),
    ancestorTag: selection?.ancestorTag || '',
    ancestorClass: String(selection?.ancestorClass || '').slice(0, 120),
  })
  if (!text || text.length < 100 || !containsSelection) return
  const uid = chapterFileName(ctx, chapterUid)
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: ctx.bookId,
        baseBookId: baseBookId(ctx.bookId),
        bookTitle: ctx.bookTitle,
        chapterUid: uid,
        chapterTitle: ctx.chapter,
        text,
        selectedText,
        source: 'selection',
      }),
    })
    console.log(`[CoRead] chapter saved via selection: ${text.length} chars uid=${uid}`)
  } catch (e) {
    console.warn('[CoRead] selection content POST failed:', e.message)
  }
}

async function trySendDomContent(chapterUid, ctxOverride, selectedText = '') {
  const ctx = ctxOverride || getReadingContext()
  const text = captureCurrentChapterText()
  const containsSelection = selectedText ? normalizeText(text).includes(normalizeText(selectedText)) : null
  await postDebug({
    ...ctx,
    source: 'dom',
    stage: selectedText ? 'annotation-send' : 'chapter-change',
    textLength: text.length,
    containsSelection,
    selectedTextLength: selectedText.length,
    selectedPreview: previewText(selectedText),
    textPreview: previewText(text),
  })
  if (!text || text.length < 100) return
  if (selectedText && !containsSelection) return
  const uid = chapterFileName(ctx, chapterUid)
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: ctx.bookId,
        baseBookId: baseBookId(ctx.bookId),
        bookTitle: ctx.bookTitle,
        chapterUid: uid,
        chapterTitle: ctx.chapter,
        text,
        selectedText,
        source: 'dom',
      }),
    })
    console.log(`[CoRead] chapter saved via DOM: ${text.length} chars uid=${uid}`)
  } catch (e) {
    console.warn('[CoRead] DOM content POST failed:', e.message)
  }
}

// ── 7. 章节切换检测 ─────────────────────────────────────────────────────────
let lastChapterUid = ''
let lastChapterTitle = ''

function onChapterChange(ctx) {
  if (ctx.chapterUid === lastChapterUid && ctx.chapter === lastChapterTitle) return
  if (lastChapterUid && lastChapterTitle) {
    reportChapterComplete(lastChapterUid, lastChapterTitle)
  }
  lastChapterUid = ctx.chapterUid
  lastChapterTitle = ctx.chapter
  setTimeout(() => trySendDomContent(ctx.chapterUid), 1500)
}

async function reportChapterComplete(chapterUid, chapterTitle) {
  const ctx = getReadingContext()
  try {
    await fetch(`${RECEIVER}/chapter-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapterUid, chapterTitle }),
    })
  } catch (e) {
    console.warn('[CoRead] chapter-complete failed:', e.message)
  }
}


// ── 8.5 共读段落标记 ─────────────────────────────────────────────────────────
// 在书页里把已经共读/讨论过的段落标出来：匹配文字绿色下划线 + 段落首「共」徽标，
// 与微信读书自带的黄色划线区分。数据来自 receiver 的 GET /annotations。
const CO_READ_CLASS = 'coread-codread'
let _coReadAnns = null      // 当前书的标注缓存
let _coReadBookId = ''      // 缓存归属的 baseBookId
let _coReadTimer = null     // 防抖定时器

function normalizeCoRead(text) {
  return String(text || '').replace(/[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/g, '')
}

async function fetchCoReadAnns(bookId) {
  const base = baseBookId(bookId)
  if (_coReadBookId === base && _coReadAnns !== null) return _coReadAnns
  try {
    const r = await fetch(`${RECEIVER}/annotations?bookId=${encodeURIComponent(bookId)}`)
    const list = await r.json()
    _coReadAnns = Array.isArray(list) ? list.filter(a => a && a.selectedText) : []
  } catch {
    _coReadAnns = null   // 失败不缓存，observer 下次触发时重试
  }
  _coReadBookId = base
  return _coReadAnns || []
}

// 把规范化（去空白/零宽）后的子串范围映射回原始字符串偏移
function mapNormOffset(raw, norm, normIdx) {
  let seen = 0
  for (let i = 0; i < raw.length; i++) {
    if (/[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/.test(raw[i])) continue
    if (seen === normIdx) return i
    seen++
  }
  return seen === normIdx ? raw.length : -1
}

// 精确包住文本节点里匹配的子串，加绿色下划线
function wrapMatchedText(node, ann) {
  try {
    const raw = node.textContent || ''
    const needle = normalizeCoRead(ann.selectedText)
    const idx = normalizeCoRead(raw).indexOf(needle)
    if (idx === -1) return false
    const start = mapNormOffset(raw, normalizeCoRead(raw), idx)
    const end = mapNormOffset(raw, normalizeCoRead(raw), idx + needle.length)
    if (start < 0 || end <= start) return false
    const range = node.ownerDocument.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const span = node.ownerDocument.createElement('span')
    span.className = CO_READ_CLASS
    span.title = (ann.selectedText || '').slice(0, 120)
    span.style.cssText =
      'text-decoration: underline;text-decoration-color:#07c160;text-decoration-thickness:2px;cursor:default;'
    range.surroundContents(span)
    return true
  } catch { return false }
}

// 收集文档内所有文本节点（穿透 shadow root，适配 WeRead 可能用 shadow DOM / 子 frame 渲染正文）
function collectAllTextNodes(root, out) {
  // root 为 document 时 ownerDocument 是 null，需回退到 root 本身（见评审发现 1）
  const doc = root.ownerDocument || root
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
  let n
  while ((n = walker.nextNode())) out.push(n)
  const hosts = root.querySelectorAll('*')
  for (const h of hosts) {
    if (h.shadowRoot) collectAllTextNodes(h.shadowRoot, out)
  }
}

// 文本节点最近的"段落级"锚点元素（用于放「共」徽标）
function nearestParagraphEl(node) {
  let el = node.parentElement
  while (el && el !== node.ownerDocument.body) {
    const tag = el.tagName
    if (['P', 'SECTION', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) return el
    if (el.shadowRoot || el.tagName === 'BODY') return el
    el = el.parentElement
  }
  return node.parentElement || node.ownerDocument.body
}

// 给段落锚点加「共」徽标（一个段落最多一个）
function addCoReadBadge(anchor, ann) {
  if (anchor.querySelector('.coread-codread-badge')) return
  const badge = document.createElement('span')
  badge.className = 'coread-codread-badge'
  badge.textContent = '共'
  const note = ann.userNote ? '\n批注：' + String(ann.userNote).slice(0, 80) : ''
  badge.title = (ann.selectedText || '').slice(0, 80) + note
  Object.assign(badge.style, {
    display: 'inline-block',
    marginRight: '4px',
    padding: '0 4px',
    borderRadius: '3px',
    background: '#07c160',
    color: '#fff',
    fontSize: '10px',
    lineHeight: '1.4',
    verticalAlign: 'super',
    cursor: 'default',
  })
  anchor.insertBefore(badge, anchor.firstChild)
}

// 清除当前 frame 内所有共读标记（绿色下划线 + 「共」徽标），把被包住的文字还原。
// 递归穿透 shadow root，与 collectAllTextNodes 的标记范围保持一致。
// 用于删除引用后的 refresh：先清后画，否则被删的引用会一直留在书页上。
function clearCoReadMarks(root) {
  root = root || document
  const doc = root.ownerDocument || root
  const unwrap = []
  const badges = []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false)
  let n
  while ((n = walker.nextNode())) {
    if (n.classList.contains(CO_READ_CLASS)) unwrap.push(n)
    else if (n.classList.contains('coread-codread-badge')) badges.push(n)
  }
  for (const s of unwrap) {
    try { s.replaceWith(...s.childNodes) } catch { try { s.remove() } catch {} }
  }
  for (const b of badges) b.remove()
  const hosts = root.querySelectorAll('*')
  for (const h of hosts) {
    if (h.shadowRoot) clearCoReadMarks(h.shadowRoot)
  }
}

// 标记当前可见章节中的共读段落（幂等：已标记文本节点直接跳过，防 observer 循环）。
// 按文本节点搜索而非依赖 .wr_readerPage p 容器，兼容 WeRead 各版本文本渲染结构。
async function markCoReadPassages() {
  // bookId：顶层路径优先，其次当前路径，最后用跨 frame 共享的章节 bookId 兜底
  // （正文可能在子 frame，顶层才持有 bookId）
  const ctx = getReadingContext()
  const pathBook = (location.pathname.match(/\/web\/reader\/([^/]+)/) || [])[1] || ''
  let bookId = ctx.bookId || pathBook || ''
  if (!bookId) {
    const shared = await readSharedChapter()
    if (shared && shared.bookId) bookId = shared.bookId
  }
  if (!bookId) return
  await fetchCoReadAnns(bookId)
  if (!_coReadAnns || !_coReadAnns.length) return

  const textNodes = []
  collectAllTextNodes(document, textNodes)
  for (const n of textNodes) {
    const parent = n.parentElement
    if (parent && parent.closest('.' + CO_READ_CLASS)) continue  // 已加下划线
    const nText = normalizeCoRead(n.textContent)
    if (nText.length < 8) continue
    for (const ann of _coReadAnns) {
      const needle = normalizeCoRead(ann.selectedText)
      if (needle.length < 8) continue
      if (nText.includes(needle)) {
        wrapMatchedText(n, ann)
        addCoReadBadge(nearestParagraphEl(n), ann)
        break
      }
    }
  }
}

function scheduleCoReadMarking() {
  if (_coReadTimer) return
  _coReadTimer = setTimeout(async () => {
    _coReadTimer = null
    try { await markCoReadPassages() } catch {}
  }, 600)
}

// 诊断：记录当前 frame 的阅读 DOM 结构，用于定位正文所在 frame/结构（排查共读标记不显示）
function postReaderStructure() {
  const sentinel = '逃课'  // 用一条真实标注词探测正文是否在本 frame 的可见 DOM 里
  postDebug({
    source: 'structure',
    stage: 'reader-dom',
    isTop: (() => { try { return window.top === window } catch { return false } })(),
    frameUrl: location.href.slice(0, 140),
    bodyTextLen: (document.body.innerText || '').length,
    pCount: document.querySelectorAll('p').length,
    wrReaderPage: !!document.querySelector('.wr_readerPage'),
    wrPageReader: !!document.querySelector('.wr_page_reader'),
    anyReader: !!document.querySelector('[class*="reader"]'),
    shadowHosts: (() => { let c = 0; try { document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) c++ }) } catch {} return c })(),
    hasSentinelInBody: normalizeCoRead(document.body.innerText || '').includes(sentinel),
  })
}

// ── 9. MutationObserver：章节切换 + 工具栏检测 ─────────────────────────────
let _lastBookBaseId = ''
const observer = new MutationObserver(() => {
  const ctx = getReadingContext()
  // SPA 式不刷新切书兜底：top path 的 bookId 变了就广播，让侧栏跟随
  const base = baseBookId(ctx.bookId)
  if (base && base !== _lastBookBaseId) {
    _lastBookBaseId = base
    broadcastBookContext(ctx)
  }
  if (ctx.chapter !== lastChapterTitle) onChapterChange(ctx)
  injectToolbarButton()
  scheduleCoReadMarking()
})
observer.observe(document.body, { childList: true, subtree: true })

// 点击空白关闭弹窗
document.addEventListener('mousedown', e => {
  if (popup && !popup.contains(e.target)) removePopup()
}, true)

// ── 10. 接收侧栏消息 ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 引用删除后刷新共读标记：先清掉页面上所有旧标记再重新标记，
  // 否则被删的引用会一直留在书页上（只加不减的 markCoReadPassages 不会自己清）。
  if (msg.action === 'refreshCoReadMarks') {
    try { clearCoReadMarks() } catch {}
    _coReadAnns = null
    scheduleCoReadMarking()
    return
  }
  // 侧栏打开/切 tab 时查询当前阅读上下文（AI-001）
  if (msg.action === 'getReadingContext') {
    const ctx = getReadingContext()
    sendResponse({ bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapter: ctx.chapter, chapterUid: ctx.chapterUid, chapterUidInt: ctx.chapterUidInt })
    return true
  }
  // 删除引用时同步删除微信读书划线：按 range 查 bookmarkId。
  // 解析顺序：1) 引用持久化的 bookmarkId（annotation 直接携带，绕开内存映射）
  //           2) 内存映射 _bookmarkIdByRange
  //           3) 已知格式构造（wereadBookId_chapterUidInt_range）
  //           4) 拉 bookmarklist 按章节+range 精确匹配（权威兜底）
  // 定位后优先直接同源调 /web/book/removeBookmark；失败再尝试 page_hook 调 reader 组件。
  if (msg.action === 'removeWeReadUnderline') {
    try { if (window.top !== window) { sendResponse({ ok: false, reason: 'not-top' }); return false } } catch {}
    postDebug({ source: 'bookmark-remove', stage: 'request', chapterUidInt: msg.chapterUidInt, range: msg.range, hasBookmarkId: !!msg.bookmarkId })
    removeWeReadUnderlineByRef(msg).then(result => {
      postDebug({ source: 'bookmark-remove', stage: 'result', ok: result.ok, reason: result.reason || '', via: result.via || '' })
      sendResponse({ ok: result.ok, reason: result.reason || '' })
      // 画布阅读器没有组件钩子可调（vue/react 均为 0），API 删完服务器状态后
      // 画布仍残留黄划线，只有刷新页面才消失。删除成功后自动刷新一次。
      // 微信读书会用 getProgress 恢复阅读位置。via==='pagehook' 时组件自己重绘了，不需要刷。
      if (result.ok && result.via !== 'pagehook') {
        postDebug({ source: 'bookmark-remove', stage: 'page-reload', via: result.via || '' })
        setTimeout(() => { try { location.reload() } catch (e) { postDebug({ source: 'bookmark-remove', stage: 'reload-err', message: e.message }) } }, 400)
      }
      return true
    })
    return true
  }
})

// 解析 bookmarkId 并删除微信读书划线。
// 返回 { ok, reason?, via? }。直接调 removeBookmark API（同源，含登录态），
// 失败再尝试 page_hook 通过 reader 组件删除。
async function removeWeReadUnderlineByRef(msg) {
  const bookId = msg.bookId || ''
  const uidInt = Number(msg.chapterUidInt) || 0
  const range = String(msg.range || '')
  const key = `${baseBookId(bookId)}:${uidInt}:${range}`
  // 权威候选：引用持久化的 bookmarkId / 内存映射（来自 bookmarklist / addBookmark 响应），
  // 基本可信，失败后允许走 page_hook 兜底
  const authoritative = []
  if (msg.bookmarkId) authoritative.push(String(msg.bookmarkId))
  if (_bookmarkIdByRange[key]) authoritative.push(String(_bookmarkIdByRange[key]))
  // 构造候选：按已知格式 bookmarkId = `${wereadBookId}_${chapterUidInt}_${range}` 拼出来，
  // 只试直接 API（格式不符/已失效时 succ:0 快速失败，不反复触发 page_hook 3 秒超时）
  const constructed = (_wereadBookId && uidInt && /^\d+-\d+$/.test(range))
    ? [`${_wereadBookId}_${uidInt}_${range}`] : []
  for (const id of [...new Set(authoritative)]) {
    const ok = await removeWeReadUnderline(id, {})
    if (ok) return { ok: true, via: 'id' }
  }
  for (const id of constructed) {
    if (authoritative.includes(id)) continue
    const ok = await removeWeReadUnderline(id, { skipFallback: true })
    if (ok) return { ok: true, via: 'id' }
  }
  // 权威兜底：拉 bookmarklist 按章节+range 精确匹配后删除
  if (_wereadBookId && uidInt && range) {
    try {
      const found = await findBookmarkIdFromList(_wereadBookId, uidInt, range)
      if (found && !authoritative.includes(found) && !constructed.includes(found)) {
        const ok = await removeWeReadUnderline(found, {})
        if (ok) return { ok: true, via: 'bookmarklist' }
        return { ok: false, reason: 'remove-failed' }
      }
    } catch {}
  }
  return (authoritative.length || constructed.length) ? { ok: false, reason: 'remove-failed' } : { ok: false, reason: 'no-bookmark-id' }
}

// 拉取微信读书 bookmarklist，按 chapterUid + range 精确匹配 bookmarkId。
async function findBookmarkIdFromList(wereadBookId, uidInt, range) {
  const resp = await fetch(`/web/book/bookmarklist?bookId=${encodeURIComponent(wereadBookId)}`, { credentials: 'include' })
  const j = await resp.json().catch(() => null)
  for (const bk of (j && j.updated) || []) {
    if (Number(bk.chapterUid) === uidInt && String(bk.range || '') === String(range) && bk.bookmarkId) {
      return String(bk.bookmarkId)
    }
  }
  return ''
}

// 删除微信读书划线：先直接调 removeBookmark API（同源，含登录态）；
// 若失败，再尝试 page_hook 通过 reader 组件删除。opts.skipFallback 为真时
// 失败直接返回（避免对构造/错误的候选 id 反复触发 page_hook 的 3 秒超时）。
async function removeWeReadUnderline(bookmarkId, opts = {}) {
  // 标记为自己发起的删除：page_hook 拦截到的 removeBookmark-req 据此跳过，
  // 避免把刚删完的引用再同步删一遍
  _removingBookmarkIds.add(String(bookmarkId))
  try {
    try {
      const resp = await fetch('/web/book/removeBookmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookmarkId }),
      })
      const j = await resp.json().catch(() => ({}))
      // 成功判定只看响应体：HTTP 200 但 succ:0（如 id 已失效/格式不符）不能算成功，
      // 否则会误报"已删除"而书页划线仍在。空体/非 JSON 时才退回 resp.ok。
      if (j && (j.succ === 1 || j.success === 1 || j.code === 0 ||
        (resp.ok && !('succ' in j) && !('success' in j) && !('code' in j)))) {
        postDebug({ source: 'bookmark-remove', stage: 'api-direct', bookmarkId, succ: j.succ })
        return true
      }
      postDebug({ source: 'bookmark-remove', stage: 'api-direct-fail', bookmarkId, resp: String(resp.status), body: String(JSON.stringify(j)).slice(0, 200) })
    } catch (e) {
      postDebug({ source: 'bookmark-remove', stage: 'api-direct-err', message: e.message })
    }
  } finally {
    _removingBookmarkIds.delete(String(bookmarkId))
  }
  if (opts.skipFallback) return false
  // 回退：page_hook 调 reader 组件删除划线（会重绘画布）
  return new Promise((resolve) => {
    let settled = false
    const onResult = (e) => {
      if (!e.data || e.data.__cr !== 'coread-remove-bookmark-result') return
      window.removeEventListener('message', onResult)
      if (!settled) { settled = true; resolve(!!e.data.ok) }
      // 记录 page_hook 的组件查找结果，便于定位为何删不掉/找不到组件
      if (e.data.diag) {
        postDebug({ source: 'bookmark-remove', stage: 'pagehook-diag', ok: e.data.ok, method: e.data.method || '', reason: e.data.reason || '', diag: JSON.stringify(e.data.diag).slice(0, 900) })
      }
    }
    window.addEventListener('message', onResult)
    setTimeout(() => {
      window.removeEventListener('message', onResult)
      if (!settled) { settled = true; resolve(false) }
    }, 3000)
    try { window.postMessage({ __cr: 'coread-remove-bookmark', bookmarkId }, '*') } catch (e) {
      if (!settled) { settled = true; resolve(false) }
    }
  })
}

// 主动扫描阅读器环境：page_hook 找删除划线的方法/组件并回报 diag。
// 加载时 + 渲染后各扫一次，配合结构诊断定位"删除划线后画布不刷新"的组件。
function scanReaderEnv() {
  try {
    const onResult = (e) => {
      if (!e.data || e.data.__cr !== 'coread-scan-reader-result') return
      window.removeEventListener('message', onResult)
      postDebug({ source: 'structure', stage: 'pagehook-scan', ok: e.data.ok, method: e.data.method || '', diag: JSON.stringify(e.data.diag || {}).slice(0, 900) })
    }
    window.addEventListener('message', onResult)
    window.postMessage({ __cr: 'coread-scan-reader' }, '*')
    setTimeout(() => window.removeEventListener('message', onResult), 4000)
  } catch {}
}

// 初始化
const initCtx = getReadingContext()
lastChapterUid = initCtx.chapterUid
lastChapterTitle = initCtx.chapter
_lastBookBaseId = baseBookId(initCtx.bookId)
broadcastBookContext(initCtx)
postDebug({ source: 'lifecycle', stage: 'content-loaded' })
postDebug({ source: 'content-version', version: 'v3-pending-fix' })
console.log('[CoRead] content script loaded', initCtx)

// 首屏章节的共读标记（DOM 渐进渲染时 observer 会继续补标）
scheduleCoReadMarking()

// 结构诊断：加载时 + 内容渲染后各记录一次
postReaderStructure()
setTimeout(postReaderStructure, 2500)

// 阅读器环境扫描：加载时 + 渲染后各一次
scanReaderEnv()
setTimeout(scanReaderEnv, 3500)

// ── 11. 跳转引用定位（AI-006） ─────────────────────────────────────────────
// 侧栏 jumpToAnnotation 把 { bookId, selectedText, ts } 写进 chrome.storage.local.pendingJump；
// 目标页每个 content script frame 加载后（以及 storage 变更时）消费它：在正文里滚动
// 高亮引用的句子。WeRead 是 SPA、正文异步渲染，findAndHighlight 内部轮询最多约 15s。
function findAndHighlight(text) {
  const needle = String(text || '').replace(/\s+/g, '').slice(0, 30)
  if (!needle) return Promise.resolve({ found: false, reason: 'no-needle' })
  return new Promise((resolve) => {
    let attempts = 0
    const tryFind = () => {
      attempts++
      // 清除旧高亮
      document.querySelectorAll('.coread-highlight').forEach(el => {
        const p = el.parentNode
        if (p) p.replaceChild(document.createTextNode(el.textContent), el)
      })
      const nodes = []
      const collect = (root, out) => {
        const doc = root.ownerDocument || root
        const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
        let n
        while ((n = w.nextNode())) out.push(n)
        const hosts = root.querySelectorAll('*')
        for (const h of hosts) if (h.shadowRoot) collect(h.shadowRoot, out)
      }
      collect(document, nodes)
      // 命中最长文本节点（包含引用的段落），减少误命中
      let best = null, bestLen = 0
      for (const n of nodes) {
        const compact = n.textContent.replace(/\s+/g, '')
        if (compact.indexOf(needle) !== -1 && compact.length > bestLen) { best = n; bestLen = compact.length }
      }
      if (best) {
        try {
          const parent = best.parentNode
          const span = document.createElement('span')
          span.className = 'coread-highlight'
          span.style.cssText = 'background:#ffeb3b;border-radius:2px;padding:1px 0;'
          parent.insertBefore(span, best)
          span.appendChild(best)
          span.scrollIntoView({ behavior: 'smooth', block: 'center' })
          resolve({ found: true, attempts })
          return
        } catch (e) { resolve({ found: false, attempts }); return }
      }
      if (attempts < 18) setTimeout(tryFind, 800)  // 最多约 15s
      else resolve({ found: false, attempts })
    }
    tryFind()
  })
}

async function checkPendingJump() {
  try {
    const { pendingJump } = await chrome.storage.local.get('pendingJump')
    if (!pendingJump || !pendingJump.selectedText) return
    if (Date.now() - (pendingJump.ts || 0) > 40000) {
      await chrome.storage.local.remove('pendingJump')  // 过期清理
      return
    }
    if (pendingJump.bookId && baseBookId(pendingJump.bookId) !== baseBookId(getReadingContext().bookId)) return
    const result = await findAndHighlight(pendingJump.selectedText)
    if (result && result.found) {
      await chrome.storage.local.remove('pendingJump')  // 命中后消费掉
    }
  } catch {}
}

// 加载时 + storage 变更时各消费一次（SPA hash 路由不重载页面时靠 onChanged 兜底）
checkPendingJump()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pendingJump) checkPendingJump()
})
