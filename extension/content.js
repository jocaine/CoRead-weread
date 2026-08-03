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

// 跨 frame 共享最近章节（标注可能发生在与网络捕获不同的 frame）
// 带 bookId 归一化，避免切书后误用上一本书的章节槽位
async function persistSharedChapter(bookId, slot, title) {
  try {
    await chrome.storage.session.set({ coreadChapter: { bookId: baseBookId(bookId), slot, title, ts: Date.now() } })
  } catch {}
}
async function readSharedChapter() {
  try {
    const { coreadChapter } = await chrome.storage.session.get('coreadChapter')
    return coreadChapter || null
  } catch { return null }
}

// 从存储的 chapterUid 提取 WeRead 认识的原生 hash 槽位（e_0 / t_1）
// 兼容两种存储格式：原始槽位 "e_0"，或拼接名 "中文版前言_e_0"
function toWereadHashSlot(chapterUid) {
  const s = String(chapterUid || '')
  if (/^[te]_\d+$/.test(s)) return s
  const m = s.match(/(?:^|_)([te]_\d+)$/)
  return m ? m[1] : ''
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
function getReadingContext() {
  const topPath = (() => { try { return window.top.location.pathname } catch { return location.pathname } })()
  const bookId = topPath.split('/').pop() || ''
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
  return { bookId, bookTitle, chapter, chapterUid }
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
  // 进度 API 兜底：网络章节拦截缺位时补上槽位。
  // 进度响应里的 chapterUid 是纯数字索引（如 20），不带 e_/t_ 前缀，
  // 所以前缀只能来自真实章节捕获：本 frame 的 _chapterSlot（已被 !_chapterSlot 排除），
  // 或跨 frame 共享的 coreadChapter.slot。有真实前缀才构造槽位，否则不伪造——
  // 用默认 'e' 给 txt 书会造出错误的 e_N，污染标注和跳转（比留空更糟：留空走 /find-chapter 检索兜底）。
  if (!_chapterSlot && Number.isFinite(book.chapterIdx)) {
    const shared = await readSharedChapter()
    const sharedSlot = shared && (!shared.bookId || shared.bookId === baseBookId(ctx.bookId)) ? shared.slot : ''
    const prefix = /^[te]_\d+$/.test(sharedSlot) ? sharedSlot.split('_')[0] : ''
    if (prefix) {
      const slot = `${prefix}_${book.chapterIdx}`
      _chapterSlot = slot
      persistSharedChapter(ctx.bookId, slot, book.chapterTitle || ctx.chapter || '')
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
  // 本 frame 拿不到章节信息时，用跨 frame 共享的最新章节兜底（仅限同一本书）
  if (!ctx.chapterUid || !ctx.chapter) {
    const shared = await readSharedChapter()
    if (shared && (!shared.bookId || shared.bookId === baseBookId(ctx.bookId))) {
      if (!ctx.chapterUid && shared.slot) ctx.chapterUid = shared.slot
      if (!ctx.chapter && shared.title) ctx.chapter = shared.title
    }
  }

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
        chapterUid: ctx.chapterUid || '', selectedText,
      },
    })
  } catch {}
  try {
    chrome.runtime?.sendMessage({
      action: 'coreadSetRefApply',
      ref: { bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapter: ctx.chapter || '',
        chapterUid: ctx.chapterUid || '', selectedText },
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
    persistSharedChapter(bookId, slotUid, ctx.chapter)
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
const observer = new MutationObserver(() => {
  const ctx = getReadingContext()
  if (ctx.chapter !== lastChapterTitle) onChapterChange(ctx)
  injectToolbarButton()
  scheduleCoReadMarking()
})
observer.observe(document.body, { childList: true, subtree: true })

// 点击空白关闭弹窗
document.addEventListener('mousedown', e => {
  if (popup && !popup.contains(e.target)) removePopup()
}, true)

// ── 10. 接收侧栏跳转请求 ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 引用删除后刷新共读标记：先清掉页面上所有旧标记再重新标记，
  // 否则被删的引用会一直留在书页上（只加不减的 markCoReadPassages 不会自己清）。
  if (msg.action === 'refreshCoReadMarks') {
    try { clearCoReadMarks() } catch {}
    _coReadAnns = null
    scheduleCoReadMarking()
    return
  }
  if (msg.action !== 'jumpToAnnotation') return
  const ctx = getReadingContext()
  sendResponse({ bookId: ctx.bookId, chapterUid: ctx.chapterUid, chapter: ctx.chapter, bookTitle: ctx.bookTitle })
  jumpToChapterAndHighlight(msg.bookId, msg.chapterUid, msg.selectedText)
  return true
})

async function jumpToChapterAndHighlight(bookId, chapterUid, selectedText) {
  const ctx = getReadingContext()
  const currentBase = baseBookId(ctx.bookId)
  const targetBase = baseBookId(bookId)
  // 存储的 chapterUid 可能是拼接名（中文版前言_e_0），WeRead 只认原生槽位
  const slot = toWereadHashSlot(chapterUid)

  // 不同书 → 跳转整个页面
  if (targetBase && currentBase !== targetBase) {
    const url = slot
      ? `https://weread.qq.com/web/reader/${targetBase}#${slot}`
      : `https://weread.qq.com/web/reader/${targetBase}`
    try { window.top.location.href = url } catch { location.href = url }
    return
  }

  // 同书不同章节 → 修改 hash（weread 的 reader iframe 通过 hash 切换章节）
  if (slot) {
    try { window.top.location.hash = '#' + slot } catch {}
    try { location.hash = '#' + slot } catch {}
    // 等页面渲染
    await new Promise(r => setTimeout(r, 2000))
  }

  // 在当前可见的 DOM 中查找并高亮文字
  if (selectedText) findAndHighlight(selectedText)
}

function findAndHighlight(text) {
  if (!text) return
  // 清除旧高亮
  document.querySelectorAll('.coread-highlight').forEach(el => {
    const p = el.parentNode
    if (p) p.replaceChild(document.createTextNode(el.textContent), el)
  })

  // 缩短搜索词提高命中率
  const needle = text.replace(/\s+/g, '').slice(0, 30)
  if (!needle) return

  // 在 DOM 中搜索文本节点
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false)
  let bestNode = null, bestLen = 0
  while (walker.nextNode()) {
    const compact = walker.currentNode.textContent.replace(/\s+/g, '')
    const idx = compact.indexOf(needle)
    if (idx !== -1 && compact.length > bestLen) {
      bestNode = walker.currentNode
      bestLen = compact.length
    }
  }

  if (bestNode) {
    try {
      const parent = bestNode.parentNode
      const span = document.createElement('span')
      span.className = 'coread-highlight'
      span.style.cssText = 'background:#ffeb3b;border-radius:2px;padding:1px 0;'
      // 把整个文本节点包进高亮 span
      parent.insertBefore(span, bestNode)
      span.appendChild(bestNode)
      span.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch {}
  }
}

// 初始化
const initCtx = getReadingContext()
lastChapterUid = initCtx.chapterUid
lastChapterTitle = initCtx.chapter
postDebug({ source: 'lifecycle', stage: 'content-loaded' })
console.log('[CoRead] content script loaded', initCtx)

// 首屏章节的共读标记（DOM 渐进渲染时 observer 会继续补标）
scheduleCoReadMarking()

// 结构诊断：加载时 + 内容渲染后各记录一次
postReaderStructure()
setTimeout(postReaderStructure, 2500)
