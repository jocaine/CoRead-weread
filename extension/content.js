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
window.addEventListener('message', e => {
  if (e.data?.__cr === 'copy') {
    _copiedText = e.data.text
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
  if (e.data?.__cr === 'crj-debug') {
    postDebug({ source: 'crj', stage: 'debug', diag: e.data.diag || null })
  }
  if (e.data?.__cr === 'crj-url-poll') {
    // page_hook 在 crj 改写后轮询 URL，判断微信读书是否真的导航到目标章
    postDebug({ source: 'crj', stage: 'url-poll', path: e.data.path, search: e.data.search })
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
        setRef: false, source: 'bookmark-sync',
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

// 取当前真实选中的文字（AI-011）。微信读书正文可能渲染在子 frame，顶层 getSelection
// 拿不到正文里的选区——所以递归遍历所有同源 iframe/frame 文档，取第一个非空选区。
function getDirectSelectionText() {
  const textOf = (doc) => (doc?.getSelection?.()?.toString?.() || '').trim()
  // 保持原顺序：本 frame 优先，其次顶层
  const top = (() => { try { return window.top?.document } catch { return null } })()
  const own = textOf(document)
  if (own) return own
  if (top && top !== document) {
    const t = textOf(top)
    if (t) return t
  }
  // 正文子 frame：DFS 遍历所有可达 iframe/frame 文档
  const seen = new Set([document])
  if (top) seen.add(top)
  const stack = [document, top].filter(Boolean)
  while (stack.length) {
    const doc = stack.pop()
    if (!doc || doc.nodeType !== 9) continue
    let frames = []
    try { frames = Array.from(doc.querySelectorAll('iframe, frame')) } catch { frames = [] }
    for (const f of frames) {
      let cd = null
      try { cd = f.contentDocument } catch {}
      if (!cd || seen.has(cd)) continue
      seen.add(cd)
      const t = textOf(cd)
      if (t) return t
      stack.push(cd)
    }
  }
  return ''
}

// ── 5. 注入 CoRead 按钮到 weread 工具栏（AI-011：划线内容 → 引用栏搜索） ──
function injectToolbarButton() {
  const container = document.querySelector('.reader_toolbar_itemContainer')
  if (!container || container.querySelector('.coread-toolbar-btn')) return

  const btn = document.createElement('div')
  btn.className = 'toolbarItem coread-toolbar-btn'
  btn.style.cssText = 'cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;width:56px;flex-shrink:0;'
  btn.title = '在侧栏引用栏中搜索划线内容（如角色名）'
  btn.innerHTML = `
    <div class="toolbarItem_icon" style="font-size:18px;line-height:1;color:#fff;">🔍</div>
    <div class="toolbarItem_text" style="font-size:11px;color:#fff;margin-top:2px;">查引用</div>
  `

  // AI-011：优先直接读选区（DOM 书精确；canvas 书正文画在画布上、无原生选区，读不到），
  // 空则点微信读书复制按钮兜底（普通选区给精确文本，划线内选区给整条——canvas 书
  // 已知限制：微信读书的精确子选区只在真实 Ctrl+C 的 isTrusted 路径里重建，无法绕过）。
  btn.addEventListener('click', async () => {
    try {
      _copiedText = getDirectSelectionText()
      if (!_copiedText) {
        try { document.querySelector('.toolbarItem.wr_copy')?.click() }
        catch (e) {
          await postDebug({ source: 'toolbar', stage: 'wr-copy-click-error', message: e.message })
        }
        await new Promise(r => setTimeout(r, 250))
      }

      if (!_copiedText) {
        console.warn('[CoRead] 未能获取选中文字，请确认 clipboard hook 已注入')
        await postDebug({ source: 'toolbar', stage: 'copy-empty' })
        return
      }
      // 划线内容 → 侧栏引用栏搜索（替换原「设为引用」弹窗：引用已改由微信读书划线直接产生）
      openRefSearch(_copiedText)
    } catch (e) {
      console.warn('[CoRead] toolbar click failed:', e)
      await postDebug({ source: 'toolbar', stage: 'click-error', message: e.message, stack: String(e.stack || '').slice(0, 600) })
    }
  })

  container.appendChild(btn)
  console.log('[CoRead] toolbar button injected')
}

// AI-011：用选中/划线文字在侧栏引用栏搜索（如查角色名在所有引用里的出现）。
// 三管齐下保证侧栏无论是否已打开都能搜到：
// 1) 存 storage 待搜词（侧栏本次才打开时加载兜底，见 sidebar.js applyPendingRefSearch）
// 2) 实时消息（侧栏已打开时立即应用）
// 3) 打开侧栏（让用户看到搜索结果）
async function openRefSearch(selectedText) {
  try {
    await chrome.storage.local.set({ pendingRefSearch: { query: selectedText, ts: Date.now() } })
  } catch {}
  try {
    chrome.runtime?.sendMessage({ action: 'coreadOpenRefSearch', query: selectedText }).catch(() => {})
  } catch {}
  try { chrome.runtime?.sendMessage({ action: 'openPanel' }) } catch {}
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
  // 跳转前捕获阅读位置锚点（AI-006 返回用）：bookId + 章节 + 视口顶部可见文本
  if (msg.action === 'getReadingAnchor') {
    sendResponse(captureReadingAnchor())
    return true
  }
  // 侧栏同章跳转（canvas）：不导航，直接在当前页点笔记面板条目让微信读书自己定位（AI-011）
  if (msg.action === 'locateNotePanel') {
    if (window.top !== window) { sendResponse({ ok: false, reason: 'not-top' }); return false }
    locateViaNotePanel(msg.text).then(nd => {
      postDebug({ source: 'jump', stage: 'note-panel-msg', ok: !!(nd.found && nd.clicked), found: nd.found, clicked: nd.clicked, items: nd.items, panelOpen: nd.panelOpen, reason: nd.reason || '' })
      sendResponse({ ok: !!(nd.found && nd.clicked), diag: nd })
    })
    return true
  }
  // 侧栏同章跳转的兜底 ping：pendingJump 已写入，这里主动触发一次消费
  //（storage.onChanged 在 content script 刚挂监听时可能漏事件）
  if (msg.action === 'checkPendingJump') {
    checkPendingJump()
    sendResponse({ received: true })
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
postDebug({ source: 'content-version', version: 'v3-note-gate' })
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
// position：'start' 让命中文本对齐视口顶部（返回阅读位置用），默认 'center' 居中高亮（跳引用用）。

// 可靠滚动：微信读书阅读器有自管滚动容器（canvas/分段渲染），scrollIntoView smooth
// 在 scroll 监听环境下实测是 no-op（侧栏 #msgs 同款问题，见 AI-004 记忆）。改手动定位：
// 沿祖先链找最近的可滚动容器（scrollHeight>clientHeight 且 overflow-y 可滚），直接设
// scrollTop，让高亮 span 对齐视口顶部（'start'）或居中（'center'）。找不到容器回退 window。
// 每个 pendingJump 只记一次滚动诊断（首次命中时上报 scroller 探测结果，判断 canvas 书
// 的真实滚动容器到底符不符合启发式，定位"找到了但没滚到"的根因）。
let _scrollDiagLogged = false
// 章节正文容器。findAndHighlight / 未命中诊断只搜这里——全文档搜索会命中右侧笔记面板
//（wr_reader_note_panel_*）里 0×0 的引用文本条目（实测：172 章跳转命中笔记面板 item，
// 无布局尺寸，滚动必然失败）。canvas 书正文在 .readerChapterContent 的隐藏文本层里。
function chapterContentRoot() {
  try {
    return document.querySelector('.readerChapterContent') || document.querySelector('[class*="readerChapterContent"]') || document
  } catch { return document }
}

// charIndex/totalChars：needle 在整个章节压缩文本中的字符偏移/总长，用于 canvas 隐藏层
// 元素零布局尺寸时按字符比例近似定位（隐藏层与可见滚动容器同源，字符比例≈滚动比例）。
function scrollSpanIntoView(span, position, charIndex, totalChars) {
  try {
    let target = null
    try { target = span.getBoundingClientRect() } catch {}
    // 第一遍：最近的 overflow-y auto|scroll 且真实溢出的祖先（老行为，DOM 书首选）。
    // 第二遍兜底：没有 auto|scroll 时，取路径上最外层 overflow hidden 且真实溢出的容器
    // ——canvas 阅读器的自管滚动容器常是 overflow:hidden（scrollTop 仍可手动设置生效）。
    let scroller = span.parentElement
    let hiddenCandidate = null
    const candidates = []  // 诊断：记录路径上的候选容器
    while (scroller) {
      const cs = getComputedStyle(scroller)
      const overflowY = cs.overflowY || 'visible'
      const hasOverflow = scroller.scrollHeight > scroller.clientHeight + 4
      candidates.push({ tag: scroller.tagName, cls: String(scroller.className || '').slice(0, 50), overflowY, sh: scroller.scrollHeight, ch: scroller.clientHeight })
      if (/(auto|scroll)/.test(overflowY) && hasOverflow) break
      if (/hidden/.test(overflowY) && hasOverflow) hiddenCandidate = scroller  // 每次覆盖 → 最终是最外层
      scroller = scroller.parentElement
    }
    if (!scroller) scroller = hiddenCandidate
    if (!scroller) {
      // 祖先链找不到（含 hidden 兜底也没有）→ 扫一遍全文档，取溢出最大
      // （scrollHeight-clientHeight）的滚动候选容器。canvas 阅读器的真实滚动容器有时在
      // 目标元素的兄弟分支上（不在祖先链里），只在此兜底路径扫一次，代价可控。
      try {
        let bestEl = null, bestOverflow = 0
        const all = document.querySelectorAll('*')
        for (let i = 0; i < all.length; i++) {
          const el = all[i]
          const cs = getComputedStyle(el)
          if (!/(auto|scroll|hidden)/.test(cs.overflowY || 'visible')) continue
          const o = el.scrollHeight - el.clientHeight
          if (o > bestOverflow) { bestOverflow = o; bestEl = el }
        }
        if (bestEl && bestOverflow > 4) scroller = bestEl
      } catch {}
    }
    if (!_scrollDiagLogged) {
      _scrollDiagLogged = true
      let tInfo = null
      try {
        const cs = getComputedStyle(span)
        tInfo = { tag: span.tagName, cls: String(span.className || '').slice(0, 50), display: cs.display, visibility: cs.visibility, position: cs.position }
      } catch {}
      postDebug({
        source: 'jump', stage: 'scroll-diag',
        target: tInfo,
        targetRect: target ? { w: Math.round(target.width), h: Math.round(target.height), top: Math.round(target.top) } : null,
        scroller: scroller ? { tag: scroller.tagName, cls: String(scroller.className || '').slice(0, 50), overflowY: (getComputedStyle(scroller).overflowY || ''), sh: scroller.scrollHeight, ch: scroller.clientHeight } : null,
        candidates: candidates.slice(0, 8),
        charIndex: charIndex || 0, totalChars: totalChars || 0,
      })
    }
    if (!scroller) {
      // 连滚动容器都找不到 → 退到窗口滚动（rect 定位）
      if (target) {
        const relTop = target.top - (window.scrollY || 0)
        let next = (window.scrollY || 0) + relTop
        if (position !== 'start') next -= (window.innerHeight - (target.height || 0)) / 2
        window.scrollTo(0, Math.max(0, Math.round(next)))
      }
      return
    }
    if (target && target.width !== 0 && target.height !== 0) {
      // rect 可用（DOM 书 / 有布局的隐藏层）：按目标相对容器的偏移滚动
      const sRect = scroller.getBoundingClientRect()
      const relTop = target.top - sRect.top
      let next = scroller.scrollTop + relTop
      if (position === 'start') next -= 8  // 顶部留一点余量，避开工具栏
      else next -= (sRect.height - target.height) / 2  // 居中
      scroller.scrollTop = Math.max(0, Math.round(next))
      return
    }
    // rect 不可用（canvas 隐藏层元素零布局尺寸，实测 172 章隐藏层 rect 为 0×0）：
    // 用字符偏移比例近似定位到引文所在页。
    if (charIndex && totalChars > 0) {
      const frac = Math.max(0, Math.min(1, charIndex / totalChars))
      scroller.scrollTop = Math.max(0, Math.round(frac * (scroller.scrollHeight - scroller.clientHeight)))
      console.log(`[CoRead] canvas char-fraction scroll ${Math.round(frac * 100)}% (${charIndex}/${totalChars}) scroller=${scroller.tagName}.${String(scroller.className || '').split(' ')[0]} sh=${scroller.scrollHeight} ch=${scroller.clientHeight}`)
      return
    }
    // 都没有 → 尽力窗口滚动
    if (target) {
      const relTop = target.top - (window.scrollY || 0)
      let next = (window.scrollY || 0) + relTop
      if (position !== 'start') next -= (window.innerHeight - (target.height || 0)) / 2
      window.scrollTo(0, Math.max(0, Math.round(next)))
    }
  } catch (e) {
    console.log('[CoRead] scrollSpanIntoView error:', e && e.message)
  }
}

function findAndHighlight(text, position, noDom) {
  const needle = String(text || '').replace(/\s+/g, '').slice(0, 30)
  if (!needle) return Promise.resolve({ found: false, reason: 'no-needle' })
  return new Promise((resolve) => {
    let attempts = 0
    const tryFind = () => {
      attempts++
      // 清除旧高亮（noDom 模式本来就不插入，无需清理）
      if (!noDom) {
        document.querySelectorAll('.coread-highlight').forEach(el => {
          const p = el.parentNode
          if (p) p.replaceChild(document.createTextNode(el.textContent), el)
        })
      }
      const nodes = []
      const collect = (root, out) => {
        const doc = root.ownerDocument || root
        const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
        let n
        while ((n = w.nextNode())) out.push(n)
        const hosts = root.querySelectorAll('*')
        for (const h of hosts) if (h.shadowRoot) collect(h.shadowRoot, out)
      }
      collect(chapterContentRoot(), nodes)
      // 全文本压缩 + 各节点起点（跨节点搜索 / 字符比例定位共用）
      let joined = '', starts = []
      try {
        for (const n of nodes) { starts.push(joined.length); joined += n.textContent.replace(/\s+/g, '') }
      } catch {}
      // 命中最长文本节点（包含引用的段落），减少误命中
      let best = null, bestLen = 0, bestIdx = -1
      for (let k = 0; k < nodes.length; k++) {
        const compact = nodes[k].textContent.replace(/\s+/g, '')
        if (compact.indexOf(needle) !== -1 && compact.length > bestLen) { best = nodes[k]; bestLen = compact.length; bestIdx = k }
      }
      // needle 在整个章节压缩文本中的起始偏移（canvas 字符比例定位用）
      let hit = -1
      if (best && bestIdx >= 0) {
        const compact = best.textContent.replace(/\s+/g, '')
        hit = starts[bestIdx] + compact.indexOf(needle)
      } else if (!best) {
        // 单节点没命中 → 跨节点搜索：canvas 隐藏文本层按行/句切成很多短节点，30 字引文常
        // 跨多个节点，单节点 indexOf 永远找不到（F3）。命中 needle 起点落在哪个节点用哪个。
        hit = joined.indexOf(needle)
        if (hit !== -1) {
          for (let k = nodes.length - 1; k >= 0; k--) {
            if (starts[k] <= hit) { best = nodes[k]; break }
          }
        }
      }
      if (best) {
        try {
          if (noDom) {
            // canvas 书：只滚动不改 DOM。canvas 阅读器的隐藏文本层与滚动容器同源，
            // 直接滚动包含引文的元素即可到达引文；插入 span 会触发微信读书重渲染、
            // 把位置重置回章节开头（AI-006 诊断确认），故这里只取参照元素滚动。
            const ref = best.parentNode || best.parentElement
            scrollSpanIntoView(ref, position, hit, joined.length)
            resolve({ found: true, attempts, noDom: true })
            return
          }
          const parent = best.parentNode
          const span = document.createElement('span')
          span.className = 'coread-highlight'
          span.style.cssText = 'background:#ffeb3b;border-radius:2px;padding:1px 0;'
          parent.insertBefore(span, best)
          span.appendChild(best)
          scrollSpanIntoView(span, position, hit, joined.length)
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

// AI-006 返回用：捕获阅读视口顶部附近的可见文本作定位锚点。跳转前侧栏调它，
// 返回时用 findAndHighlight 按锚点把页面重新滚回原阅读位置（不只回章节）。
// 只扫视口上半部（避开顶部工具栏、不抓屏外段落），命中"最靠上"的可见文本节点。
function captureReadingAnchor() {
  try {
    const ctx = getReadingContext()
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
    const vw = window.innerWidth
    const vh = window.innerHeight
    const scanTop = 60          // 避开顶部工具栏
    const scanBottom = vh * 0.45  // 只看视口上半部
    let best = null
    let bestTop = Infinity
    for (const n of nodes) {
      const t = (n.textContent || '').replace(/\s+/g, '')
      if (t.length < 12) continue
      const r = n.parentNode ? n.parentNode.getBoundingClientRect() : null
      if (!r || r.width === 0 || r.height === 0) continue
      if (r.bottom < scanTop || r.top > scanBottom) continue
      if (r.left < 0 || r.right > vw) continue  // 只看主文本列
      if (r.top < bestTop) { bestTop = r.top; best = n }
    }
    if (!best) return { ok: false, reason: 'no-visible-text' }
    return {
      ok: true,
      bookId: ctx.bookId,
      chapterUidInt: ctx.chapterUidInt || 0,
      anchorText: (best.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }
  } catch (e) {
    return { ok: false, reason: 'throw:' + (e && e.message) }
  }
}

// 未命中重试：WeRead 章节正文异步渲染，一次 findAndHighlight（内部轮询约 15s）可能
// 在章节还没画出来时结束。TTL 内额外重试几次，覆盖晚渲染 / 首帧未就绪的场景。
let _pendingJumpRetries = 0
// 笔记面板定位的 in-flight 守卫：同章跳转时 onChanged + sidebar ping 可能各触发一次
// checkPendingJump，同一 ts 只点一次笔记条目（见 checkPendingJump noDom 分支）。
let _notePanelInFlightTs = 0
const PENDING_JUMP_MAX_RETRIES = 4
// 本 frame content script 加载时间 / 加载时章节：用于区分「源页（跳转前已加载很久）」和
// 「目标页（跳转后新加载）」。源页只滚动不消费 pendingJump，否则 +2.5s 的 confirm 会在
// 导航提交前把 pendingJump 删掉，目标页加载后就什么都没了（F1 竞态 → 停在章节开头）。
const _contentLoadedAt = Date.now()
const _loadedChapterUidInt = chapterUidIntFromUrl()

// ── 笔记面板原生定位（AI-011） ───────────────────────────────────────────────
// canvas 书正文画在画布上，DOM 滚动定位不到引文（Rounds 1-5 已验证无解）。微信读书自己的
// 笔记面板（右侧"笔记"tab）每条划线条目点击 = 它自己执行精确到句的原生定位（跨章/同章/
// 画布书全生效）。这里在目标页找到引用对应的那条，dispatch click 让微信读书自己跳。
// 返回 diag 供上报；未命中调用方回退 findAndHighlight（保留原行为不倒退）。
// querySelDeep：面板/条目可能藏在 shadow root 里，递归穿透（Rounds 3 里 collectText 也要
// 递归 shadow 才找得到 canvas 书正文，同款问题）。
function querySelDeep(root, sel) {
  const out = []
  try { for (const e of root.querySelectorAll(sel)) out.push(e) } catch {}
  try {
    for (const h of root.querySelectorAll('*')) {
      if (h.shadowRoot) out.push(...querySelDeep(h.shadowRoot, sel))
    }
  } catch {}
  return out
}
async function locateViaNotePanel(quoteText, probeOnly) {
  const diag = { found: false, clicked: 0, items: 0, panelOpen: false, matched: [], reason: '' }
  try {
    const needle = String(quoteText || '').replace(/\s+/g, '')
    if (!needle) { diag.reason = 'empty-quote'; return diag }
    const panel = (querySelDeep(document, '.wr_reader_note_panel')[0])
      || (querySelDeep(document, '[class*="note_panel"]')[0])
      || null
    diag.panelOpen = !!panel && (panel.offsetWidth > 0 || panel.offsetHeight > 0 || panel.getClientRects().length > 0)
    let items = []
    for (const s of ['.wr_reader_note_panel_item', '[class*="note_panel_item"]', '[class*="note_item"]']) {
      items = querySelDeep(document, s)
      if (items.length) break
    }
    diag.items = items.length
    if (!items.length) { diag.reason = 'no-items'; return diag }
    let matchedItem = null
    for (const item of items) {
      const txt = (item.textContent || '').replace(/\s+/g, '')
      if (txt.indexOf(needle) !== -1) { matchedItem = item; break }
    }
    if (!matchedItem) { diag.reason = 'no-text-match'; return diag }
    diag.found = true
    diag.matched.push(String(matchedItem.className || matchedItem.tagName || '').slice(0, 80))
    if (probeOnly) return diag  // 探测模式：只判断条目在不在/匹配不匹配，不点击
    // 点击目标：优先条目内的"回原文/定位"按钮（各版本命名不一），没有就点条目本身。
    const clickTargets = []
    try {
      for (const b of matchedItem.querySelectorAll('a, button, [role="button"], [class*="original"], [class*="locate"], [class*="go_origin"]')) {
        const t = String(b.textContent || '').trim()
        if (/原文|定位|查看|去阅读/.test(t) || /original|locate/i.test(String(b.className || ''))) clickTargets.push(b)
      }
    } catch {}
    clickTargets.push(matchedItem)
    const seen = new Set()
    for (const t of clickTargets) {
      if (seen.has(t)) continue
      seen.add(t)
      try {
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        diag.clicked++
      } catch {}
    }
    return diag
  } catch (e) {
    diag.reason = 'throw:' + (e && e.message)
    return diag
  }
}
// 消费 pendingJump（带 ts 守卫：2.5s 延迟期间若被新跳转覆盖则不消费）。
async function consumePendingJump(ts) {
  try {
    const { pendingJump } = await chrome.storage.local.get('pendingJump')
    if (ts !== undefined && pendingJump && pendingJump.ts !== ts) return
    await chrome.storage.local.remove('pendingJump')
    console.log('[CoRead] jump consumed (note-panel)')
  } catch {}
}

// ── 笔记面板定位轮询（AI-011） ──────────────────────────────────────────────
// 实测：bookmarklist 数据 ~1s 就到，但笔记条目要 ~20s 才渲染进 DOM（微信读书自己延迟）。
// 关键坑（AI-011 实测）：条目出现 ≠ 阅读器就绪。数据缓存的页面条目 1s 就出现，但 canvas
// 阅读器要到 ~15-20s 才就绪，过早点击是 no-op（v3-note-poll 整段回退就是这个原因）。所以
// 这里「就绪门」：条目已渲染 且 页面加载超过 NOTE_PANEL_READY_GATE_MS 才点击；点击后若
// 触发微信读书 reload 导航（落章不落句），pendingJump 保留，新页面循环重试、就绪后再点。
// 就绪门调参依据：能用的 v3-note-panel 点击发生在页面加载 ~20s（冷加载条目 20s 才现）。
const NOTE_PANEL_READY_GATE_MS = 18000
const NOTE_PANEL_TRY_OPEN = false  // 实验：点开"笔记"tab 尝试提前渲染（代价：面板弹出）
let _notePanelTimer = null
async function notePanelJumpLoop(pj) {
  if (window.top !== window) return  // 面板只在顶层 frame
  if (_notePanelTimer) return
  let tries = 0
  let opened = false
  let prevItems = 0
  const tick = async () => {
    _notePanelTimer = null
    try {
      // 每次 tick 校验：pendingJump 已被新跳转覆盖则中止（避免旧循环点到旧引用）
      const cur = await chrome.storage.local.get('pendingJump').catch(() => ({}))
      if (!cur.pendingJump || (pj.ts !== undefined && cur.pendingJump.ts !== pj.ts)) {
        postDebug({ source: 'jump', stage: 'note-panel-abort', tries })
        _notePanelInFlightTs = 0
        return
      }
      if (NOTE_PANEL_TRY_OPEN && !opened) {
        opened = true
        const po = tryOpenNotePanel()
        if (po.clicked) postDebug({ source: 'jump', stage: 'note-panel-open', cls: po.cls, text: po.text })
      }
      // 探测：只看条目在不在、匹配不匹配，不点击（就绪门判定用）
      const probe = await locateViaNotePanel(pj.selectedText, true)
      tries++
      const age = Date.now() - _contentLoadedAt
      // 未就绪：条目没渲染 或 阅读器没就绪 → 继续等（过早点击是 no-op，AI-011 实测）
      if (probe.items === 0 || age < NOTE_PANEL_READY_GATE_MS) {
        // 日志防刷屏：首次、items 从 0→N 的瞬间、以及每 12 次 tick 记一条
        if (tries === 1 || (probe.items > 0 && prevItems === 0) || tries % 12 === 0) {
          postDebug({ source: 'jump', stage: 'note-panel-wait', tries, items: probe.items, reason: probe.reason || '', pageAge: age })
        }
        prevItems = probe.items
        if (tries < 100) {  // ~70s 上限
          _notePanelTimer = setTimeout(tick, 700)
          return
        }
        _notePanelInFlightTs = 0
        postDebug({ source: 'jump', stage: 'note-panel-timeout', tries, items: probe.items, reason: probe.reason || '', pageAge: age })
        consumePendingJump(pj.ts)
        return
      }
      // 就绪：真正点击定位（微信读书自己精确到句）
      const nd = await locateViaNotePanel(pj.selectedText, false)
      if (nd.found && nd.clicked) {
        _notePanelInFlightTs = 0
        console.log(`[CoRead] jump note-panel clicked items=${nd.items} pageAge=${age} tries=${tries}`)
        postDebug({
          source: 'jump', stage: 'note-panel', found: true, clicked: nd.clicked,
          items: nd.items, panelOpen: nd.panelOpen, tries, reason: nd.reason || '',
          pageAge: age, gateMs: NOTE_PANEL_READY_GATE_MS,
          chapterChanged: chapterUidIntFromUrl() !== _loadedChapterUidInt,
        })
        setTimeout(() => consumePendingJump(pj.ts), 2500)
        return
      }
      // 点击意外未命中（条目刚出现又消失/文本变了）→ 继续轮询
      postDebug({ source: 'jump', stage: 'note-panel-miss-after-ready', tries, reason: nd.reason || '', items: nd.items })
      _notePanelTimer = setTimeout(tick, 700)
    } catch (e) {
      postDebug({ source: 'jump', stage: 'note-panel-err', message: e && e.message })
      if (tries < 100) _notePanelTimer = setTimeout(tick, 1000)
      else { _notePanelInFlightTs = 0; consumePendingJump(pj.ts) }
    }
  }
  tick()
}

// 实验：点开"笔记"tab 尝试提前渲染笔记条目（NOTE_PANEL_TRY_OPEN 开启时调用）。
// 只点可见的、文本以"笔记"开头的 tab/button；找不到就放弃（轮询照跑，20s 后条目自现）。
function tryOpenNotePanel() {
  const diag = { clicked: false, cls: '', text: '' }
  try {
    const els = document.querySelectorAll('[role="tab"], button, [class*="tab"]')
    for (const el of els) {
      if (!el.getClientRects().length) continue
      const t = String(el.textContent || '').trim()
      if (/^笔记/.test(t) && t.length <= 8) {
        diag.cls = String(el.className || '').slice(0, 80)
        diag.text = t.slice(0, 20)
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        diag.clicked = true
        return diag
      }
    }
  } catch {}
  return diag
}

async function checkPendingJump() {
  try {
    const { pendingJump } = await chrome.storage.local.get('pendingJump')
    if (!pendingJump || !pendingJump.selectedText) {
      console.log('[CoRead] jump: no pendingJump')
      return
    }
    const age = Date.now() - (pendingJump.ts || 0)
    if (age > 60000) {
      await chrome.storage.local.remove('pendingJump')  // 过期清理
      console.log('[CoRead] jump: expired, removed', age)
      return
    }
    const curBook = baseBookId(getReadingContext().bookId)
    const tgtBook = pendingJump.bookId ? baseBookId(pendingJump.bookId) : ''
    if (tgtBook && tgtBook !== curBook) {
      postDebug({ source: 'jump', stage: 'guard-book-mismatch', tgtBook, curBook })
      return  // 书都不匹配：不消费也不重试（重试也白搭）
    }
    // canvasCrj 跳转用 noDom 模式（只滚动不改 DOM）：canvas 阅读器隐藏文本层与滚动容器
    // 同源，滚动即可到达引文；插入 span 会触发微信读书重渲染、把位置重置回章节开头
    //（AI-006 诊断确认），故 canvas 书不插 DOM 高亮，位置由滚动决定。
    const noDom = !!pendingJump.canvasScroll
    // 每次跳转序列首次尝试时重置滚动诊断（重试不再重复上报）
    if (_pendingJumpRetries === 0) _scrollDiagLogged = false
    // canvas 书（noDom）：正文在画布上，DOM 滚不动，优先点微信读书笔记面板里引用对应的
    // 原生条目——点它 = 微信读书自己精确到句定位（AI-011）。点击不触发页面导航/重载，
    // 不存在 k-suffix 重载流"导航提交前消费掉目标"的竞态，故命中即延迟消费、不套 allowConsume。
    // 只在本 frame 是顶层 frame 时尝试（笔记面板在顶层），子 frame 直接走回退。
    if (noDom) {
      // canvas 书：正文画在画布上，findAndHighlight 的 DOM 滚动 5 轮实测无效（且内部最多轮询
      // 15s，会把重试拖慢）。唯一能精确到句的是笔记面板条目点击（AI-011）。但条目要 ~20s 才
      // 渲染进 DOM（bookmarklist 数据 ~1s 就到，渲染被微信读书延迟）——一次 locate 必落空，
      // 直接起 700ms 轮询循环，条目一出现立刻点击定位。防重复：同章跳转时 onChanged 与
      // sidebar ping 各触发一次 checkPendingJump，同一 ts 只起一个循环。
      if (_notePanelInFlightTs === pendingJump.ts) return
      _notePanelInFlightTs = pendingJump.ts
      notePanelJumpLoop(pendingJump)
      return
    }
    const result = await findAndHighlight(pendingJump.selectedText, pendingJump.position, noDom)
    if (result && result.found) {
      // 命中后不立即消费：WeRead 的 k-suffix 导航会异步加载/重绘章节，可能把刚定位的
      // 位置清掉（表现就是"停在章节开头"）。延迟 ~2.5s 再确认一次，确认时重跑
      // findAndHighlight 重新滚动，若仍在则消费。
      const allowConsume = allowConsumePendingJump(pendingJump)
      console.log(`[CoRead] jump found noDom=${noDom} attempts=${result.attempts} allowConsume=${allowConsume}`)
      postDebug({
        source: 'jump', stage: noDom ? 'canvas-scroll' : 'highlight-found',
        attempts: result.attempts, allowConsume,
        pageAge: Date.now() - _contentLoadedAt,
        chapterChanged: chapterUidIntFromUrl() !== _loadedChapterUidInt,
      })
      if (allowConsume) setTimeout(() => { confirmPendingJumpHighlight(noDom, pendingJump.ts) }, 2500)
      return
    }
    // 诊断：定位未命中时上报 DOM 状态。hasNeedleInDom 用跨节点拼接判断（与 findAndHighlight
    // 一致），避免引文跨节点时单节点扫描误报 false。
    try {
      const nd = String(pendingJump.selectedText || '').replace(/\s+/g, '').slice(0, 30)
      let inDom = false
      try {
        // 与 findAndHighlight 的 collect 一致：也要递归进 shadow root，否则 canvas 书正文
        // 藏在 shadow 里时 hasNeedleInDom 会误报 false，把调试带偏。
        const textNodes = []
        const collectText = (root, out) => {
          const doc = root.ownerDocument || root
          const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
          let nn
          while ((nn = w.nextNode())) out.push(nn)
          const hosts = root.querySelectorAll('*')
          for (const h of hosts) if (h.shadowRoot) collectText(h.shadowRoot, out)
        }
        collectText(chapterContentRoot(), textNodes)
        let joined = ''
        for (const tn of textNodes) joined += (tn.textContent || '').replace(/\s+/g, '')
        inDom = joined.indexOf(nd) !== -1
      } catch {}
      console.log(`[CoRead] jump miss: needleInDom=${inDom} attempts=${result.attempts}`)
      postDebug({
        source: 'jump', stage: 'highlight-miss',
        hasNeedleInDom: inDom,
        bodyTextLen: (document.body.innerText || '').length,
        pCount: document.querySelectorAll('p').length,
        topUrl: (() => { try { return window.top.location.pathname } catch { return '' } })().slice(0, 90),
      })
    } catch {}
    if (_pendingJumpRetries < PENDING_JUMP_MAX_RETRIES) {
      _pendingJumpRetries++
      setTimeout(checkPendingJump, 4000)
    }
  } catch (e) {
    console.log('[CoRead] jump check error:', e && e.message)
  }
}

// 是否允许消费 pendingJump：目标页（跳转后新加载的页 / SPA 已切到目标章）才消费。
// 源页（加载很久且章节未变）只滚动不消费；若 confirm 在导航提交前消费，目标页就没目标了。
function allowConsumePendingJump(pendingJump) {
  try {
    const pageAge = Date.now() - _contentLoadedAt
    if (pageAge < 15000) return true  // 刚加载 → 大概率是目标页（整页 reload 跳转）
    const cur = chapterUidIntFromUrl()
    if (cur !== _loadedChapterUidInt) {
      // SPA 切章：只有当前章正是目标章才消费，避免手动翻页把 pendingJump 错消费掉
      const m = String(pendingJump.bookId || '').match(/k([0-9a-f]{16,})$/i)
      if (!m) return true
      const tgt = Number(weReadDecode(m[1]))
      if (!tgt || cur === tgt) return true
      return false
    }
    return false  // 源页：同章跳转、导航还没提交，不消费
  } catch { return false }
}

// 命中后的确认：重跑一次 findAndHighlight 重新高亮/滚动，扛过 SPA 重渲染清掉定位的情况。
// 重跑仍命中 → 消费 pendingJump；未命中（章节还在重渲染）→ 走常规重试。
// ts 校验：confirm 调度时的 pendingJump 若已被新跳转覆盖，则不消费（F4 不对称守卫）。
async function confirmPendingJumpHighlight(noDom, ts) {
  try {
    const { pendingJump } = await chrome.storage.local.get('pendingJump')
    if (!pendingJump || !pendingJump.selectedText) {
      console.log('[CoRead] jump confirm: no pendingJump')
      return
    }
    if (ts !== undefined && pendingJump.ts !== ts) {
      console.log('[CoRead] jump confirm: pendingJump replaced, skip')
      return
    }
    const age = Date.now() - (pendingJump.ts || 0)
    if (age > 60000) {
      await chrome.storage.local.remove('pendingJump')
      return
    }
    const result = await findAndHighlight(pendingJump.selectedText, pendingJump.position, noDom)
    if (result && result.found) {
      _pendingJumpRetries = 0
      await chrome.storage.local.remove('pendingJump')
      console.log('[CoRead] jump confirmed + consumed')
      return
    }
    console.log('[CoRead] jump confirm re-miss')
    if (_pendingJumpRetries < PENDING_JUMP_MAX_RETRIES) {
      _pendingJumpRetries++
      setTimeout(checkPendingJump, 4000)
    }
  } catch (e) {
    console.log('[CoRead] jump confirm error:', e && e.message)
  }
}

// 加载时 + storage 变更时各消费一次（SPA hash 路由不重载页面时靠 onChanged 兜底）。
// 新 pendingJump（新一次跳转）重置重试计数，避免上次残留的重试次数影响本次。
function onPendingJumpChanged() {
  _pendingJumpRetries = 0
  checkPendingJump()
}
// 补发 page_hook 在 document_start 阶段写的 crj 诊断（那时 postMessage 还没被监听）。
// page_hook 是 MAIN world，这里的 isolated world 读不到它的 window.__crjDiagLog，
// 改用 DOM CustomEvent 让 page_hook 补发（DOM 事件跨 world 可达，见 page_hook.js）。
try { window.dispatchEvent(new CustomEvent('coread-flush-crj')) } catch {}
checkPendingJump()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pendingJump) onPendingJumpChanged()
})
