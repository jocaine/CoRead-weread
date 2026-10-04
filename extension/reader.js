/**
 * CoRead 阅读器：读 PDF，划词翻译，译文按字符偏移锚回原文。
 *
 * 这个页面是扩展自己的页面，不是注入到别人页面里的脚本，所以：
 *   - 不受任何网站 CSS / CSP 影响，直接用普通 DOM
 *   - 正文是 pdf.js 文字层里的**真实文字节点**，能取 Range、能划词
 *   - 锚点用「页号 + 页内字符偏移」，缩放、改窗口大小、重开浏览器都还能解析回原位
 *     （微信读书那种"正文画在 canvas 上、重排后无从下手"的问题，在这里不存在）
 *
 * 译文与进度存在 chrome.storage.local，按文件内容哈希关联：同一份 PDF 再打开就还在。
 */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs'
import {
  offsetsAcrossPages,
  rangeFromOffsets,
  textFromOffsets,
  pageTextIndex,
} from './reader-anchor.js'
import { RECEIVER_URL } from './translate-protocol.js'   // 后台地址的真源，不另写一份

// ── 运行环境 ──────────────────────────────────────────────────────────────────
// 扩展页面里走 chrome.runtime.getURL；自测（普通页面）里退回相对路径，
// 这样同一份代码能在无头浏览器里被验证。
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
// 能不能给后台发消息：只看 sendMessage 在不在。
// 不能用 hasChrome 当条件 —— 它还要求 runtime.id，自测环境里没有 id，
// 结果"同步给侧栏"会被静默跳过（踩过）。
const canMessage = () =>
  typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function'
const assetUrl = (p) => (hasChrome ? chrome.runtime.getURL(p) : new URL(p, location.href).href)

// pdf.js 默认按文档目录找 worker，而我们的 worker 在 vendor/ 下，必须显式指过去。
// 不设的话 getDocument 会一直等不到 worker（表现为"打不开、也不报错"）。
pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('vendor/pdfjs/pdf.worker.min.mjs')

const MIN_SCALE = 0.4
const MAX_SCALE = 4
const RENDER_MARGIN = '900px 0px'
const MAX_CONCURRENT_RENDERS = 2
const STORE_PREFIX = 'rd:book:'

const $ = (id) => document.getElementById(id)
const els = {
  open: $('rd-open'),
  openMain: $('rd-open-main'),
  libraryBtn: $('rd-library-btn'),
  libraryList: $('rd-lib-list'),
  libraryStatus: $('rd-lib-status'),
  file: $('rd-file'),
  name: $('rd-name'),
  status: $('rd-status'),
  pageinfo: $('rd-pageinfo'),
  zoomIn: $('rd-zoom-in'),
  zoomOut: $('rd-zoom-out'),
  zoom: $('rd-zoom'),
  fit: $('rd-fit'),
  box: $('rd-box'),
  notes: $('rd-notes'),
  scroll: $('rd-scroll'),
  pages: $('rd-pages'),
  empty: $('rd-empty'),
  scanHint: $('rd-scan-hint'),
  tip: $('rd-tip'),
  tipTranslate: $('rd-tip-translate'),
  tipCopy: $('rd-tip-copy'),
  toast: $('rd-toast'),
}

const state = {
  doc: null,
  hash: '',
  name: '',
  scale: 1.25,
  fitWidth: true,
  pages: [],            // {num, wrap, canvas, layer, page, viewport, renderTask, textLayer, rendered}
  library: [],          // 书库列表（来自 receiver）
  archived: false,      // 当前这本是不是已经在书库里
  entries: [],          // {id, anchors:[{page,start,end}], source, translation, at}
  activeId: '',
  pendingAnchorFlash: '',
  boxMode: false,
  boxDrag: null,
  renderQueue: [],
  rendering: 0,
  renderCount: 0,          // 画布位图真正重画过多少次（性能回归时看这个数）
  renderMs: 0,             // 重画累计耗时（毫秒）
  lastZoomRerendered: 0,
  lastScaleCheap: false,
  settleUntil: 0,
  settleTimer: null,
  scrollRecoverTimer: null,
  ioFired: 0,
  ioBlocked: 0,
  enqueued: 0,
  lastRenderError: null,
  lastBadFit: null,
  saveTimer: null,
  translateOverride: null,   // 自测用的替身
  lastSelection: null,
}

// ── 与后台通信 ────────────────────────────────────────────────────────────────
async function callBackground(message) {
  if (state.translateOverride) return state.translateOverride(message)
  if (!canMessage()) return { ok: false, error: { code: 'NO_BG', message: '不在扩展环境里，无法调用后台' } }
  const resp = await chrome.runtime.sendMessage(message)
  return resp || { ok: false, error: { code: 'NO_RESPONSE', message: '后台没有返回结果' } }
}

// ── 提示条 ────────────────────────────────────────────────────────────────────
let toastTimer = null
function toast(text, isError = false) {
  els.toast.textContent = text
  els.toast.classList.toggle('is-error', !!isError)
  els.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { els.toast.hidden = true }, isError ? 6000 : 2600)
}

// ── 书库（放进来过的 PDF，下次不用再手动选文件）──────────────────────────────
// 原件存在 receiver/books/<hash>/source.pdf，列表来自 GET /reader-books。
// receiver 没起来时不影响本地打开，只是没有历史可用。
const LIB_TIMEOUT = 5000

async function receiverJson(path, opts = {}, timeout = LIB_TIMEOUT) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(RECEIVER_URL + path, { ...opts, signal: ctl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 本地打开的 PDF 存进书库（原件 + 元信息）。失败不影响阅读，只提示一句。 */
async function archiveToLibrary(bytes, name) {
  if (!state.hash) return false
  try {
    await receiverJson(
      '/reader-book-file?hash=' + state.hash + '&name=' + encodeURIComponent(name || ''),
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes },
      60000,
    )
    state.archived = true
    await touchLibraryMeta()
    toast('已存入书库，下次不用再选文件')
    return true
  } catch (e) {
    toast('这份 PDF 没能存入书库（CoRead 后台没起来？）：' + ((e && e.message) || e), true)
    return false
  }
}

/** 更新书库里的元信息（书名、页数、译文条数、读到第几页） */
function touchLibraryMeta() {
  if (!state.hash) return
  receiverJson('/reader-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash: state.hash,
      name: state.name,
      pages: state.doc ? state.doc.numPages : 0,
      entries: state.entries.length,
      page: state.doc ? currentPage() : 0,
    }),
  }).catch(() => {})
}

function fmtSize(n) {
  if (!n) return ''
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

function fmtWhen(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (x) => String(x).padStart(2, '0')
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    : (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function renderLibrary(books) {
  const box = els.libraryList
  if (!box) return
  box.replaceChildren()
  if (!books.length) {
    els.libraryStatus.textContent = '还没有'
    return
  }
  els.libraryStatus.textContent = books.length + ' 本'
  for (const b of books) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'rd-lib-item'
    item.dataset.hash = b.hash
    item.disabled = !b.hasFile

    const name = document.createElement('span')
    name.className = 'rd-lib-name'
    name.textContent = b.name || '(未命名).pdf'

    const meta = document.createElement('span')
    meta.className = 'rd-lib-meta'
    const bits = []
    if (b.pages) bits.push(b.pages + ' 页')
    if (b.entries) bits.push(b.entries + ' 条译文')
    if (b.size) bits.push(fmtSize(b.size))
    if (b.lastOpenedAt) bits.push(fmtWhen(b.lastOpenedAt))
    meta.textContent = bits.join(' · ')

    item.append(name, meta)
    item.addEventListener('click', () => openFromLibrary(b))
    box.appendChild(item)
  }
}

async function loadLibrary() {
  if (!els.libraryList) return
  els.libraryStatus.textContent = '读取中…'
  try {
    const data = await receiverJson('/reader-books')
    state.library = data.books || []
    renderLibrary(state.library)
  } catch (e) {
    els.libraryStatus.textContent = '读不到（CoRead 后台没起来）'
    els.libraryList.replaceChildren()
  }
}

/** 从书库打开：把原件取回来（不用再选文件） */
async function openFromLibrary(book) {
  toast('正在从书库读取 ' + (book.name || '') + '…')
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 60000)
    let res
    try {
      res = await fetch(RECEIVER_URL + '/reader-book-file?hash=' + book.hash, { signal: ctl.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await openBytes(bytes, book.name || '未命名.pdf', { archived: true })
  } catch (e) {
    toast('从书库打开失败：' + ((e && e.message) || e) + '（可以改用「从本地打开」）', true)
  }
}

/** 回到书库（关掉当前这本） */
function showLibrary() {
  closeDoc()
  els.empty.hidden = false
  els.name.textContent = '未打开文件'
  loadLibrary()
}

// ── 打开文件 ──────────────────────────────────────────────────────────────────
async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function openFile(file) {
  if (!file) return
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await openBytes(bytes, file.name)          // 本地打开的会顺手存进书库
  } catch (e) {
    // 读文件本身失败（权限、被占用、太大）也要说出来，不能一声不响留一片白
    failOpen('读不到这个文件：' + ((e && e.message) || e))
  }
}

/** 打开过程中的任何失败都收在这里：把空状态放回来 + 明确提示，绝不留下无声的空白页。 */
function failOpen(message) {
  console.warn('[阅读器] 打开失败', message)
  closeDoc()
  els.empty.hidden = false
  els.name.textContent = '未打开文件'
  els.status.textContent = message
  els.status.style.color = '#9a3b3b'
  toast(message, true)
}

async function openBytes(bytes, name, opts = {}) {
  closeDoc()
  state.name = name || '未命名.pdf'
  els.name.textContent = state.name
  els.empty.hidden = true
  els.status.textContent = '正在打开…'
  els.status.style.color = ''

  try {
    // pdf.js 会把这份数据 **transfer 给 worker**，原 buffer 随即失效。
    // 所以"要入库的那一份"必须先复制出来，不能等打开完再上传 ——
    // 那时候拿到的是已经被 detach 的空 buffer（踩过：入库静默失败）。
    const keepForUpload = opts.archived ? null : bytes.slice()
    await loadDocument(bytes, name)
    // 本地选的文件顺手存进书库；从书库打开的本来就在里面
    if (keepForUpload) archiveToLibrary(keepForUpload, state.name)
    else touchLibraryMeta()
  } catch (e) {
    failOpen('这份 PDF 打不开：' + ((e && e.message) || e))
  }
}

async function loadDocument(bytes, name) {
  state.hash = await sha256Hex(bytes)
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    // 这四项是 pdf.js 的"附件"，缺了不会报错，只会让整类 PDF 变成**空白页**：
    //   wasm           JBIG2 / JPEG2000 图像解码（扫描件大量使用）
    //   cmaps          中日韩文字的 CID 映射（字体没内嵌时，正文会取不出来）
    //   standard_fonts 未内嵌的标准字体（Helvetica 等）
    //   iccs           色彩描述文件
    // 曾经只放了主库与 worker，结果自己造的简单 PDF 正常、真实 PDF 一片空白。
    cMapUrl: assetUrl('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('vendor/pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('vendor/pdfjs/wasm/'),
    iccUrl: assetUrl('vendor/pdfjs/iccs/'),
  }).promise
  state.doc = doc

  // 用第一页的尺寸给所有页占位；每页真正渲染时会按自己的尺寸纠正
  const first = await doc.getPage(1)
  const baseVp = first.getViewport({ scale: state.scale })
  for (let n = 1; n <= doc.numPages; n++) {
    const wrap = document.createElement('div')
    wrap.className = 'rd-page rd-page-idle'
    wrap.dataset.page = String(n)
    wrap.style.width = baseVp.width + 'px'
    wrap.style.height = baseVp.height + 'px'
    els.pages.appendChild(wrap)
    state.pages.push({
      num: n, wrap, canvas: null, layer: null, page: null, viewport: baseVp,
      renderTask: null, textLayer: null, rendered: false,
    })
  }

  // 恢复上次的进度与译文
  const saved = await loadRecord(state.hash)
  if (saved) {
    if (saved.scale) state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.scale))
    state.entries = Array.isArray(saved.entries) ? saved.entries : []
    els.pages.style.setProperty('--total-scale-factor', String(state.scale))
    applyScaleToPlaceholders()
  }
  updateZoomLabel()
  renderEntries()
  renderImageMarks()
  syncNotes()

  io.disconnect()
  for (const p of state.pages) io.observe(p.wrap)

  if (saved && saved.page) setTimeout(() => gotoPage(saved.page, false), 60)
  // 第一次打开没有历史缩放：直接按窗口宽度铺满，省得每次都要手动点「适宽」
  if (!saved || !saved.scale) await fitWidth()

  toast('已打开：' + state.name + '（' + doc.numPages + ' 页）')
  if (saved && state.entries.length) toast('已恢复 ' + state.entries.length + ' 条译文的原文位置')
}

function closeDoc() {
  io.disconnect()
  state.doc = null
  state.pages = []
  state.entries = []
  state.activeId = ''
  state.lastRenderError = null
  els.pages.replaceChildren()
  els.pages.style.setProperty('--total-scale-factor', String(state.scale))
  els.pageinfo.textContent = '—'
  els.scanHint.hidden = true
  clearHighlights()
  renderEntries()
}

// ── 懒渲染 ────────────────────────────────────────────────────────────────────
const io = new IntersectionObserver((records) => {
  for (const r of records) {
    if (r.isIntersecting) {
      state.ioFired++
      enqueueRender(Number(r.target.dataset.page))
    }
  }
}, { root: els.scroll, rootMargin: RENDER_MARGIN })

/**
 * 画布位图按多大倍率画。
 *
 * 两个限制：
 *  1) 设备倍率最高按 2 算 —— 再高看不出差别，像素量却成倍涨（Windows 125%/150% 很常见）
 *  2) 总像素封顶 —— 扫描件的页面图片本身就有两三千万像素，再乘设备倍率会画出上亿像素的
 *     画布，渲染会明显卡顿。超了就等比降倍率，宁可略糊也不卡。
 */
const MAX_CANVAS_PIXELS = 8_000_000

function bitmapScaleFor(viewport) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = viewport.width * viewport.height * dpr * dpr
  if (pixels <= MAX_CANVAS_PIXELS) return dpr
  return Math.max(1, dpr * Math.sqrt(MAX_CANVAS_PIXELS / pixels))
}

/** 这一页离视口近不近（要不要现在就画） */
function isPageNear(p, margin = 800) {
  if (!p || !p.wrap) return false
  const r = p.wrap.getBoundingClientRect()
  const c = els.scroll.getBoundingClientRect()
  return r.bottom > c.top - margin && r.top < c.bottom + margin
}

function enqueueRender(num, force = false) {
  const p = state.pages[num - 1]
  if (!p) return
  if (p.rendered && !p.needsRender) return       // 已经画好且没过期
  if (p.renderTask || state.renderQueue.includes(num)) return
  // 布局刚变过（缩放、对照栏开合）时会来一波密集的交叉观察回调：页面的高度一变，
  // 原本在观察边距之外的页会成片"进入视野"。这时候只画真正看得见的页，
  // 其余留在待画状态等布局稳定 —— 否则一次开合能把十几页全部重画（实测 78 次），
  // 在重页上就是"卡爆"。
  if (!force && performance.now() < state.settleUntil && !isPageNear(p, 100)) {
    state.ioBlocked++
    return
  }
  state.enqueued++
  state.renderQueue.push(num)
  pumpRenderQueue()
}

/**
 * 布局沉降期：这段时间内忽略"离得还远"的重画请求，避免一次开合把十几页全重画。
 * 被挡下的请求不会丢 —— 靠 recoverStaleVisible() 在滚动/沉降结束时兜底。
 */
function beginSettle(ms = 500) {
  state.settleUntil = performance.now() + ms
  clearTimeout(state.settleTimer)
  state.settleTimer = setTimeout(() => {
    state.settleUntil = 0
    recoverStaleVisible()
  }, ms + 20)
}

/**
 * 兜底：把"在预渲染范围内、但还没画或已过期"的页补上（一次最多 3 页，别压满主线程）。
 *
 * 为什么必须有它：交叉观察只在**进入**时报告一次。沉降期里挡下的那次请求，如果这一页
 * 一直待在观察边距内，就再也不会收到"进入"事件了 —— 表现是某页永远是白的/糊的
 * （踩过：第 3 页一直不渲染）。所以由滚动和沉降结束来兜底，不依赖观察事件。
 */
function recoverStaleVisible() {
  if (!state.doc) return
  let budget = 3
  for (const p of state.pages) {
    if (budget <= 0) break
    if (p.rendered && !p.needsRender) continue
    if (p.renderTask || state.renderQueue.includes(p.num)) continue
    if (!isPageNear(p, 900)) continue
    enqueueRender(p.num, true)
    budget--
  }
}

function pumpRenderQueue() {
  while (state.rendering < MAX_CONCURRENT_RENDERS && state.renderQueue.length) {
    const num = state.renderQueue.shift()
    state.rendering++
    renderPage(num)
      .catch((e) => {
        if (/cancel/i.test(String(e && e.message))) return
        // 渲染失败必须让人看见：之前只打 console.warn，页面表现就是"一片空白"，
        // 既没有提示也不知道该看哪里。现在写进工具栏状态 + 提示条。
        const msg = String((e && e.message) || e)
        state.lastRenderError = { page: num, message: msg }
        console.warn('[阅读器] 渲染第 ' + num + ' 页失败', e)
        updateStatus()
        toast('第 ' + num + ' 页渲染失败：' + msg, true)
      })
      .finally(() => { state.rendering--; pumpRenderQueue() })
  }
}

/** 把画布尺寸与样式设成这个视口对应的值；返回画布位图倍率 */
function sizeCanvas(p, viewport) {
  const scale = bitmapScaleFor(viewport)
  p.canvas.width = Math.max(1, Math.floor(viewport.width * scale))
  p.canvas.height = Math.max(1, Math.floor(viewport.height * scale))
  p.canvas.style.width = viewport.width + 'px'
  p.canvas.style.height = viewport.height + 'px'
  return scale
}

function renderTaskFor(p, viewport, scale) {
  return p.page.render({
    canvasContext: p.canvas.getContext('2d'),
    viewport,
    transform: scale === 1 ? null : [scale, 0, 0, scale, 0, 0],
  })
}

async function renderPage(num) {
  const p = state.pages[num - 1]
  if (!p) return
  if (p.rendered && !p.needsRender) return
  const isFirstBuild = !p.rendered

  const page = p.page || await state.doc.getPage(num)
  p.page = page
  const viewport = page.getViewport({ scale: state.scale })
  p.viewport = viewport

  p.wrap.style.width = viewport.width + 'px'
  p.wrap.style.height = viewport.height + 'px'
  p.wrap.classList.remove('rd-page-idle')

  if (isFirstBuild) {
    const canvas = document.createElement('canvas')
    canvas.className = 'rd-canvas'
    const layer = document.createElement('div')
    layer.className = 'textLayer'
    p.wrap.append(canvas, layer)
    p.canvas = canvas
    p.layer = layer
    const label = document.createElement('div')
    label.className = 'rd-page-num'
    label.textContent = String(num)
    p.wrap.appendChild(label)
  }

  const scale = sizeCanvas(p, viewport)
  p.needsRender = false
  state.renderCount++
  p.renderTask = renderTaskFor(p, viewport, scale)
  const t0 = performance.now()
  try {
    await p.renderTask.promise
  } finally {
    p.renderTask = null
    // 记录耗时：性能问题要看数字，不靠"感觉卡"
    p.lastRenderMs = Math.round(performance.now() - t0)
    state.renderMs += p.lastRenderMs
  }

  if (isFirstBuild) {
    const textContent = await page.getTextContent()
    const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: p.layer, viewport })
    await tl.render()
    p.textLayer = tl
  } else if (p.textLayer) {
    // 只改尺寸、不重建 DOM：文字节点上的 Range 与高亮因此不会失效
    p.textLayer.update({ viewport })
  }

  p.rendered = true
  p.textChars = pageTextIndex(p.layer).total
  // 画布像素回读（GPU→CPU）不便宜，只在最前面几页做：状态行与"扫描件"判断只需要它
  if (num <= 3) {
    p.canvasInk = canvasInkRatio(p.canvas)
    p.canvasBlank = p.canvasInk < 0.004
  }
  updateScanHint()
  updateStatus()

  refreshHighlights()
  if (state.pendingAnchorFlash) {
    const id = state.pendingAnchorFlash
    state.pendingAnchorFlash = ''
    revealEntry(id)
  }
}

/**
 * 画布上"有东西"的比例：先把整页缩成一张小图，再一次读出全部像素，
 * 以出现最多的颜色当底色，算其余像素的占比。
 *
 * 不能用"撒几个采样点"的做法：正文常常只占页面上方一小条，网格很容易整条漏过去，
 * 结果把有字的页报成空白（踩过）。缩略图不会漏 —— 任何角落有内容都会留下痕迹。
 */
function canvasInkRatio(canvas) {
  const W = 64, H = 84
  try {
    if (!canvas.width || !canvas.height) return 0
    const small = document.createElement('canvas')
    small.width = W
    small.height = H
    const sctx = small.getContext('2d', { willReadFrequently: true })
    sctx.drawImage(canvas, 0, 0, W, H)
    const d = sctx.getImageData(0, 0, W, H).data
    const counts = new Map()
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)   // 量化到 32 级，抗噪
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    let top = 0
    for (const v of counts.values()) if (v > top) top = v
    return 1 - top / (W * H)
  } catch {
    return 0
  }
}

function isCanvasBlank(canvas) {
  return canvasInkRatio(canvas) < 0.004     // 少于千分之四的像素不是底色 → 当空白
}

/**
 * 扫描件提示：看**已经渲染出来的**页里有没有文字，而不是只看第 1 页 ——
 * 扫描书的第一页常常是封面（本来就没字），只看第 1 页会误判。
 */
function updateScanHint() {
  const rendered = state.pages.filter((p) => p.rendered)
  if (!rendered.length) return
  const noText = rendered.every((p) => (p.textChars || 0) < 20)
  const enough = rendered.length >= 2 || (state.doc && state.doc.numPages === 1)
  if (enough && noText) els.scanHint.hidden = false
  else if (!noText) els.scanHint.hidden = true
}

/** 工具栏上的渲染状态：已渲染多少页、文字层多少字、有没有报错 */function updateStatus() {
  if (!els.status) return
  if (!state.doc) { els.status.textContent = ''; return }
  const rendered = state.pages.filter((p) => p.rendered).length
  const charsOfFirst = state.pages[0] && state.pages[0].rendered ? state.pages[0].textChars : null
  const parts = ['已渲染 ' + rendered + '/' + state.doc.numPages + ' 页']
  if (charsOfFirst !== null) parts.push('首页文字 ' + charsOfFirst + ' 字')
  if (state.pages[0] && state.pages[0].canvasBlank) parts.push('首页画布空白')
  else if (state.pages[0] && state.pages[0].canvasInk !== undefined) {
    parts.push('首页墨迹 ' + (state.pages[0].canvasInk * 100).toFixed(1) + '%')
  }
  if (state.lastRenderError) {
    els.status.textContent = '第 ' + state.lastRenderError.page + ' 页渲染失败：' + state.lastRenderError.message
    els.status.style.color = '#9a3b3b'
    return
  }
  els.status.textContent = parts.join(' · ')
  els.status.style.color = ''
}

// ── 缩放 ──────────────────────────────────────────────────────────────────────
function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(s * 100) / 100)) }

function applyScaleToPlaceholders() {
  // 还没渲染的页按比例缩放占位尺寸，避免整篇跳一下
  const base = state.pages[0] && state.pages[0].viewport
  if (!base) return
  for (const p of state.pages) {
    if (p.rendered) continue
    p.wrap.style.width = (base.width / base.scale * state.scale) + 'px'
    p.wrap.style.height = (base.height / base.scale * state.scale) + 'px'
  }
}

/**
 * 改缩放。
 *
 * cheap = true 时**不立刻重画任何画布**，只改尺寸并把该页丢进渲染队列。
 * 这条路径给"布局自己变了"的场合用（对照栏开合、拖窗口引起的适宽）：
 * 那些时候用户并没有在调缩放，却要为此同步重画可见页 —— 重页一张几百毫秒，
 * 主线程直接堵住，表现就是"弹个面板整个页面卡爆"。
 * 用户主动缩放（按钮 / 滚轮 / 适宽）仍然立刻重画，保证立刻清晰。
 */
async function setScale(next, { fromFit = false, cheap = false } = {}) {
  const scale = clampScale(next)
  // 手动缩放（按钮/滚轮/程序调用）之后就别再自动适宽了，否则一次滞后的 resize
  // 回调会把用户刚调好的缩放顶掉 —— 踩过：设成 320% 之后被一个迟到的"适宽"打回 40%
  if (!fromFit) state.fitWidth = false
  if (scale === state.scale) return
  const ratio = scale / state.scale
  const anchor = captureScrollAnchor()
  beginSettle()          // 先关闸：接下来这波交叉观察回调只画看得见的页
  state.scale = scale
  els.pages.style.setProperty('--total-scale-factor', String(scale))
  applyScaleToPlaceholders()

  // 缩放时**只重画看得见的那几页**。
  // 之前是把所有渲染过的页全部重画：读到第 30 页时拖一下缩放，就会同时重画 30 张画布，
  // 明显卡顿。看不见的页只改尺寸（位图先按 CSS 拉伸，略糊但立刻可见），
  // 标记 needsRender，等它们滚回视野时再补画。
  let reRendered = 0
  for (const p of state.pages) {
    if (!p.page) continue
    const viewport = p.page.getViewport({ scale })
    p.viewport = viewport
    p.wrap.style.width = viewport.width + 'px'
    p.wrap.style.height = viewport.height + 'px'
    if (p.canvas) {
      p.canvas.style.width = viewport.width + 'px'
      p.canvas.style.height = viewport.height + 'px'
    }
    if (!p.rendered) continue

    if (!cheap && isPageNear(p, 400)) {
      // 文字层只改尺寸、不重建 DOM：文字节点上的 Range 与高亮因此不会失效
      if (p.textLayer) p.textLayer.update({ viewport })
      if (p.renderTask) { try { p.renderTask.cancel() } catch {} }
      const s = sizeCanvas(p, viewport)
      state.renderCount++
      reRendered++
      p.renderTask = renderTaskFor(p, viewport, s)
      p.renderTask.promise.catch(() => {}).finally(() => { p.renderTask = null })
      p.needsRender = false
    } else {
      // 便宜的路径：文字层不用管（span 按百分比定位，font-size 跟 --total-scale-factor 走，
      // 已经自动跟着缩放了），只把位图标为过期，交给队列慢慢补
      p.needsRender = true
      if (cheap && isPageNear(p, 0)) enqueueRender(p.num)
    }
  }
  state.lastZoomRerendered = reRendered
  state.lastScaleCheap = !!cheap

  updateZoomLabel()
  restoreScrollAnchor(anchor, ratio)
  refreshHighlights()
  scheduleSave()
}

/** 缩放前记下"视口顶部压着哪一页的百分之几"，缩放后把同一处放回视口顶部。 */
function captureScrollAnchor() {
  const top = els.scroll.getBoundingClientRect().top
  for (const p of state.pages) {
    const r = p.wrap.getBoundingClientRect()
    if (r.bottom > top + 4) {
      return { page: p.num, frac: r.height ? (top - r.top) / r.height : 0 }
    }
  }
  return null
}

function restoreScrollAnchor(anchor, ratio) {
  if (!anchor) return
  const p = state.pages[anchor.page - 1]
  if (!p) return
  const r = p.wrap.getBoundingClientRect()
  const delta = r.top - els.scroll.getBoundingClientRect().top + anchor.frac * r.height * ratio
  els.scroll.scrollTop += delta
}

function updateZoomLabel() {
  els.zoom.textContent = Math.round(state.scale * 100) + '%'
}

async function fitWidth(cheap = false) {
  if (!state.pages.length) return
  const pad = 32 + 2
  const avail = els.scroll.clientWidth - pad
  // 容器还没布局完时 clientWidth 可能是 0，直接算会得到一个极小的缩放（被夹到最小值），
  // 页面就莫名变成 40%。宁可这次不调，也不要留下一个坏状态。
  if (!(avail > 200)) {
    state.lastBadFit = { avail, clientWidth: els.scroll.clientWidth, at: Date.now() }
    return
  }
  const base = state.pages[0].viewport
  const unit = base.width / base.scale
  await setScale(avail / unit, { fromFit: true, cheap })
  state.fitWidth = true
}

// ── 选区 → 偏移 → 翻译 ────────────────────────────────────────────────────────
function renderedLayers() {
  return state.pages.map((p) => p.layer)
}

function selectionAnchors() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  // 只认落在文字层里的选区：页面上其它地方（对照栏）的选区不该触发翻译
  const startLayer = state.pages.find((p) => p.layer && p.layer.contains(range.startContainer))
  if (!startLayer) return null
  const anchors = offsetsAcrossPages(range, renderedLayers())
  const usable = anchors.filter((a) => a.end > a.start)
  if (!usable.length) return null
  return { anchors: usable, range }
}

function anchorsText(anchors) {
  const parts = []
  for (const a of anchors) {
    const layer = state.pages[a.page - 1] && state.pages[a.page - 1].layer
    if (!layer) continue
    const t = textFromOffsets(layer, a.start, a.end)
    if (t) parts.push(t)
  }
  return parts.join('\n')
}

function onSelectionSettled() {
  const hit = selectionAnchors()
  if (!hit) { hideTip(); return }
  state.lastSelection = hit
  showTipAt(hit.range)
}

function showTipAt(range) {
  const rect = range.getBoundingClientRect()
  if (!rect || (!rect.width && !rect.height)) { hideTip(); return }
  els.tip.hidden = false
  const w = els.tip.offsetWidth || 120
  const h = els.tip.offsetHeight || 32
  let left = rect.left + rect.width / 2 - w / 2
  let top = rect.top - h - 8
  if (top < 8) top = rect.bottom + 8
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
  els.tip.style.left = left + 'px'
  els.tip.style.top = top + 'px'
}

function hideTip() { els.tip.hidden = true }

async function translateSelection() {
  const hit = state.lastSelection || selectionAnchors()
  if (!hit) {
    toast('先划选一段原文，再按 Alt+T', true)
    return
  }
  // 同一段再翻一次不该多出一条
  const dup = findDuplicate({ kind: 'text', anchors: hit.anchors })
  if (dup && reuseDuplicate(dup)) { hideTip(); return }

  const source = anchorsText(hit.anchors)
  if (!source.trim()) { toast('没取到可翻译的文字', true); return }
  hideTip()
  requestNotesOpen()
  // 划完就把选区撤掉：留着蓝色选区既碍眼，也会挡住"点已翻过区域"这个动作
  clearSelection()

  const entry = dup || {
    id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    anchors: hit.anchors,
    source,
    translation: '',
    at: Date.now(),
    pending: true,
  }
  if (!dup) state.entries.push(entry)
  else { entry.pending = true; entry.error = '' }
  renderEntries()

  const res = await callBackground({ action: 'translateText', text: source, source: 'selection' })
  entry.pending = false
  if (!res || !res.ok) {
    entry.error = (res && res.error && res.error.message) || '翻译失败'
    renderEntries()
    toast('翻译失败：' + entry.error, true)
    return
  }
  entry.source = source
  entry.translation = (res.data && res.data.translation) || ''
  entry.error = ''
  renderEntries()
  refreshHighlights()
  // 刚翻完的这段就在用户眼前，**不要**去滚动书页（会把正在看的位置挪走），
  // 只把它设为当前、把对照栏里那一条滚进视野
  focusEntry(entry.id)
  scheduleSave()
}

// ── 框选翻译（扫描件 / 图片页）───────────────────────────────────────────────
// 图片页里没有文字节点，Range 与 Custom Highlight 都用不上。所以这条路是：
// 在页面上拖一个框 → 把框里的画布像素裁出来 → 交给模型读图 → 译文进对照栏。
// 位置记成「页内比例」，与文字锚点一样与缩放无关（PDF 版式固定，比例永远成立）。
/**
 * **按一次框一次**，框完自动退出。
 * 原来要先点按钮切模式、再拖框、还要再点一次退出 —— 多两步，而且忘了退出时划词会被一起拦掉。
 * 现在按钮与 Alt+S 都是"进入一次框选"，拖完即结束，Esc 取消（与页面上的截图翻译同一套习惯）。
 */
function startBoxSelect() {
  if (!state.doc) { toast('先打开一份 PDF', true); return }
  if (state.boxMode) return
  state.boxMode = true
  els.box.classList.add('is-on')
  els.pages.classList.add('is-boxing')
  toast('在页面上拖一个框（框完自动退出，Esc 取消）')
}

function endBoxSelect(reason) {
  if (!state.boxMode) return
  state.boxMode = false
  els.box.classList.remove('is-on')
  els.pages.classList.remove('is-boxing')
  if (state.boxDrag) {
    try { state.boxDrag.marquee.remove() } catch (e) {}
    state.boxDrag = null
  }
  if (reason === 'esc') toast('已取消框选')
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

function pageLocalPoint(pageEl, ev) {
  const r = pageEl.getBoundingClientRect()
  if (!r.width || !r.height) return null
  return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) }
}

function onBoxStart(ev) {
  if (!state.boxMode || ev.button !== 0) return
  const pageEl = ev.target.closest && ev.target.closest('.rd-page')
  if (!pageEl) return
  const start = pageLocalPoint(pageEl, ev)
  if (!start) return
  ev.preventDefault()

  const marquee = document.createElement('div')
  marquee.className = 'rd-marquee'
  pageEl.appendChild(marquee)
  state.boxDrag = { pageEl, start, marquee, moved: false }

  const move = (e) => {
    const d = state.boxDrag
    if (!d) return
    const now = pageLocalPoint(d.pageEl, e)
    if (!now) return
    const rect = {
      x: Math.min(d.start.x, now.x), y: Math.min(d.start.y, now.y),
      w: Math.abs(now.x - d.start.x), h: Math.abs(now.y - d.start.y),
    }
    if (rect.w > 0.004 || rect.h > 0.004) d.moved = true
    Object.assign(d.marquee.style, {
      left: (rect.x * 100) + '%', top: (rect.y * 100) + '%',
      width: (rect.w * 100) + '%', height: (rect.h * 100) + '%',
    })
    d.rect = rect
  }
  const up = () => {
    document.removeEventListener('mousemove', move, true)
    document.removeEventListener('mouseup', up, true)
    const d = state.boxDrag
    state.boxDrag = null
    if (!d) return
    d.marquee.remove()
    endBoxSelect('done')                     // 框完就退出，不用再点一次
    if (d.moved && d.rect) translateRegion(d.pageEl, d.rect)
  }
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mouseup', up, true)
}

/** 从画布上裁出这块区域。画布像素 = CSS 尺寸 × 设备倍率，用比例算就不必关心倍率。 */
function cropCanvas(canvas, frac) {
  const sx = Math.round(frac.x * canvas.width)
  const sy = Math.round(frac.y * canvas.height)
  const sw = Math.max(1, Math.round(frac.w * canvas.width))
  const sh = Math.max(1, Math.round(frac.h * canvas.height))
  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
  return out.toDataURL('image/png')
}

async function translateRegion(pageEl, frac) {
  const num = Number(pageEl.dataset.page)
  const p = state.pages[num - 1]
  if (!p || !p.canvas) { toast('这一页还没画出来，稍等一下再框', true); return }
  if (frac.w < 0.01 || frac.h < 0.005) { toast('框太小了，重新框一块', true); return }

  // 同一块再框一次不该多出一条
  const dup = findDuplicate({ kind: 'image', page: num, rect: frac })
  if (dup && reuseDuplicate(dup)) return

  let dataUrl
  try {
    dataUrl = cropCanvas(p.canvas, frac)
  } catch (e) {
    toast('裁图失败：' + ((e && e.message) || e), true)
    return
  }

  requestNotesOpen()
  const entry = dup || {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'image', page: num, rect: frac,
    source: '', translation: '', at: Date.now(), pending: true,
  }
  if (!dup) state.entries.push(entry)
  else { entry.pending = true; entry.error = ''; entry.rect = frac }
  renderEntries()
  renderImageMarks()

  const res = await callBackground({ action: 'translateImage', dataUrl })
  entry.pending = false
  if (!res || !res.ok) {
    entry.error = (res && res.error && res.error.message) || '翻译失败'
    renderEntries()
    toast('翻译失败：' + entry.error, true)
    return
  }
  entry.source = (res.data && res.data.original) || ''
  entry.translation = (res.data && res.data.translation) || ''
  entry.error = ''
  renderEntries()
  focusEntry(entry.id)
  scheduleSave()
}

/** 把图片类译文的位置标记画到页面上（按页内百分比，所以缩放时自动跟着走） */
function renderImageMarks() {
  for (const el of els.pages.querySelectorAll('.rd-mark')) el.remove()
  for (const e of state.entries) {
    if (e.kind !== 'image' || !e.rect) continue
    const p = state.pages[e.page - 1]
    if (!p) continue
    const d = document.createElement('div')
    d.className = 'rd-mark' + (e.id === state.activeId ? ' is-active' : '')
    d.style.left = (e.rect.x * 100).toFixed(3) + '%'
    d.style.top = (e.rect.y * 100).toFixed(3) + '%'
    d.style.width = (e.rect.w * 100).toFixed(3) + '%'
    d.style.height = (e.rect.h * 100).toFixed(3) + '%'
    p.wrap.appendChild(d)
  }
}

// ── 译文对照：显示在 CoRead 侧栏里 ───────────────────────────────────────────
// 阅读器页面**不再自带对照栏**：那样一边开着 CoRead 侧栏、一边再来一栏，就是两栏并排。
// 条目变化 → 经后台中继同步给侧栏；侧栏上的操作 → 经后台中继发回来（见 onReaderCommand）。
let _syncTimer = null

function scheduleSync() {
  clearTimeout(_syncTimer)
  _syncTimer = setTimeout(syncNotes, 200)
}

function notesSnapshot() {
  return {
    book: state.doc ? { hash: state.hash, name: state.name } : null,
    page: state.doc ? currentPage() : 0,
    total: state.doc ? state.doc.numPages : 0,
    activeId: state.activeId,
    entries: state.entries.map((e) => ({
      id: e.id,
      kind: e.kind || 'text',
      source: e.source || '',
      translation: e.translation || '',
      pending: !!e.pending,
      error: e.error || '',
      at: e.at || 0,
    })),
  }
}

async function syncNotes() {
  clearTimeout(_syncTimer)      // 立即同步时就取消排队中的那次，免得白发两遍
  _syncTimer = null
  if (!canMessage()) return
  try {
    await chrome.runtime.sendMessage({ action: 'readerSync', snapshot: notesSnapshot() })
  } catch (e) {}
}

/** 让侧栏打开译文对照页（顺便把侧栏本身打开） */
function requestNotesOpen() {
  if (!canMessage()) return
  chrome.runtime.sendMessage({ action: 'notesOpen' }).catch(() => {})
  scheduleSync()
}

/** 收起侧栏里的译文对照（双击书页空白处触发） */
function requestNotesClose() {
  if (!canMessage()) return
  chrome.runtime.sendMessage({ action: 'notesClose' }).catch(() => {})
}

// ── 重复翻译：同一段不要生成第二条 ────────────────────────────────────────────

function sameAnchorSet(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((x, i) => x.page === b[i].page && x.start === b[i].start && x.end === b[i].end)
}

function sameRect(a, b) {
  if (!a || !b) return false
  const near = (p, q) => Math.abs(p - q) < 0.008      // 页内比例，约合几个像素
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h)
}

/** 找已经翻过的同一处：文字按锚点比，图片按「页号 + 页内矩形」比 */
function findDuplicate(candidate) {
  return state.entries.find((x) => {
    if (candidate.kind === 'image') {
      return x.kind === 'image' && x.page === candidate.page && sameRect(x.rect, candidate.rect)
    }
    return x.kind !== 'image' && sameAnchorSet(x.anchors, candidate.anchors)
  }) || null
}

/**
 * 重复翻译的处理：不再建新条目，也不重复调用模型 ——
 * 已经有译文就把对照栏打开并跳到那一条；上次失败或还没回来就重试同一条。
 */
function reuseDuplicate(dup) {
  requestNotesOpen()
  if (dup.translation) {
    revealEntry(dup.id)
    toast('这一段已经翻过了，已跳到对照栏')
    return true
  }
  return false
}

/**
 * 点正文里已经翻过的地方 → 打开对照栏并高亮对应那条。
 * 文字高亮是 CSS Custom Highlight 画的，它不接收点击，所以这里自己做命中判定：
 * 把点到的屏幕坐标与每条锚点解析出的矩形比对。
 */
function entryAtPoint(x, y) {
  for (const e of state.entries) {
    if (e.kind === 'image' && e.rect) {
      const p = state.pages[e.page - 1]
      if (!p) continue
      const pr = p.wrap.getBoundingClientRect()
      const left = pr.left + e.rect.x * pr.width
      const top = pr.top + e.rect.y * pr.height
      const w = e.rect.w * pr.width
      const h = e.rect.h * pr.height
      if (x >= left && x <= left + w && y >= top && y <= top + h) return e
      continue
    }
    for (const a of e.anchors || []) {
      const range = resolveAnchor(a)
      if (!range) continue
      for (const r of range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return e
      }
    }
  }
  return null
}

/** 点是否落在"刚划出来的那个选区"里 —— 那种点击是用户在自己选中的文字上点，不算查看译文 */
function pointInSelection(x, y) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false
  try {
    for (const r of sel.getRangeAt(0).getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    }
  } catch {}
  return false
}

function clearSelection() {
  try { window.getSelection().removeAllRanges() } catch {}
}

function onReaderClick(ev) {
  if (state.boxMode) return
  // 注意不能用"有没有选区"当守卫：翻译完之后选区还在（浏览器不会自己清），
  // 那会把后面每一次点击都挡掉。只在"点在自己刚划的选区里"时才跳过。
  if (pointInSelection(ev.clientX, ev.clientY)) return
  const hit = entryAtPoint(ev.clientX, ev.clientY)
  if (!hit) return
  requestNotesOpen()
  revealEntry(hit.id)
}

// ── 原文高亮（CSS Custom Highlight，不改文字层 DOM）───────────────────────────
function resolveAnchor(anchor) {
  const p = state.pages[anchor.page - 1]
  if (!p || !p.layer) return null
  return rangeFromOffsets(p.layer, anchor.start, anchor.end)
}

function clearHighlights() {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete('rd-src')
    CSS.highlights.delete('rd-src-active')
  }
}

function refreshHighlights() {
  if (!window.CSS || !CSS.highlights) return
  const all = []
  const active = []
  for (const e of state.entries) {
    for (const a of e.anchors || []) {
      const r = resolveAnchor(a)
      if (!r) continue
      all.push(r)
      if (e.id === state.activeId) active.push(r)
    }
  }
  if (all.length) CSS.highlights.set('rd-src', new Highlight(...all))
  else CSS.highlights.delete('rd-src')
  if (active.length) CSS.highlights.set('rd-src-active', new Highlight(...active))
  else CSS.highlights.delete('rd-src-active')
}

// ── 侧栏译文区的操作（由后台中继转发过来）────────────────────────────────────
/** 条目有变化时调用：把快照推给侧栏 */
function renderEntries() {
  scheduleSync()
}

async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制')
    return
  } catch (e) {}
  // clipboard API 在没聚焦的文档里会失败，退回老办法（与翻译浮窗里的做法一致）
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    toast(ok ? '已复制' : '复制失败', !ok)
  } catch (e) {
    toast('复制失败', true)
  }
}

/** 设为引用：沿用翻译那套（receiver 侧只设为当前引用，不触发 agent） */
async function setAsReference(entry) {
  if (!entry || !entry.translation) return { ok: false, error: { message: '这条还没有译文' } }
  const res = await callBackground({
    action: 'setTranslationRef',
    original: entry.source,
    translation: entry.translation,
    url: 'reader://' + state.hash + (state.name ? '#' + state.name : ''),
    pageTitle: state.name,
  })
  if (res && res.ok) toast('已设为引用')
  return res
}

/**
 * 改原文并重译（侧栏里点「改原文重译」→ 这里执行）。
 * 只改这一条的原文，锚点不动 —— 用户是在修正识别的错字，位置没变。
 */
async function retranslateEntry(id, text) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return { ok: false, error: { message: '找不到这一条' } }
  const next = String(text || '').trim()
  if (!next) return { ok: false, error: { message: '原文不能为空' } }
  e.source = next
  e.pending = true
  e.error = ''
  renderEntries()
  const res = await callBackground({ action: 'translateText', text: next, source: 'retranslate' })
  e.pending = false
  if (!res || !res.ok) {
    e.error = (res && res.error && res.error.message) || '翻译失败'
    toast('重译失败：' + e.error, true)
    renderEntries()
    return res || { ok: false }
  }
  e.translation = (res.data && res.data.translation) || ''
  toast('已重译')
  renderEntries()
  refreshHighlights()
  scheduleSave()
  return { ok: true }
}

function removeEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id)
  if (state.activeId === id) state.activeId = ''
  renderEntries()
  refreshHighlights()
  renderImageMarks()
  scheduleSave()
}

/** 这一条在屏幕上的第一块矩形（文字用 Range 的矩形，图片用页内比例换算） */
function firstScreenRectOf(e) {
  const first = (e.anchors && e.anchors[0]) || null
  if (first) {
    const r = resolveAnchor(first)
    if (r) {
      const rects = [...r.getClientRects()]
      if (rects.length) return rects[0]
    }
    return null
  }
  if (e.rect) {
    const p = state.pages[e.page - 1]
    if (!p) return null
    const pr = p.wrap.getBoundingClientRect()
    return {
      left: pr.left + e.rect.x * pr.width,
      top: pr.top + e.rect.y * pr.height,
      width: e.rect.w * pr.width,
      height: e.rect.h * pr.height,
    }
  }
  return null
}

/** 把某一条设为当前（不动书页滚动）—— 刚翻完时用，别把用户正在看的位置挪走 */
function focusEntry(id) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return
  state.activeId = id
  renderEntries()          // = 把快照同步给侧栏（侧栏会把它标成当前并滚进视野）
  syncNotes()              // 刚翻完要立刻让侧栏看到，不等防抖
  renderImageMarks()
  refreshHighlights()
}

/**
 * 跳到这一条在正文里的位置。
 * 不用 scrollIntoView(整页)：那会把视口对到整页的中心，长页面上是一次大幅跳动。
 * 改成按高亮自身的矩形算一个位移，落在视口上方偏上的位置。
 */
function scrollToEntry(e) {
  const rect = firstScreenRectOf(e)
  const c = els.scroll.getBoundingClientRect()
  const pageNum = (e.anchors && e.anchors[0] && e.anchors[0].page) || e.page
  const p = pageNum ? state.pages[pageNum - 1] : null
  if (p) {
    p.wrap.classList.add('rd-flash')
    clearTimeout(p._flashTimer)
    p._flashTimer = setTimeout(() => p.wrap.classList.remove('rd-flash'), 900)
  }
  if (!rect) {
    if (p) els.scroll.scrollBy({ top: p.wrap.getBoundingClientRect().top - c.top - 40, behavior: 'smooth' })
    return
  }
  if (rect.top >= c.top + 40 && rect.bottom <= c.bottom - 40) return   // 已经在视野里，别动
  const delta = rect.top - (c.top + Math.min(140, c.height * 0.25))
  els.scroll.scrollBy({ top: delta, behavior: 'smooth' })
}

async function revealEntry(id) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return
  state.activeId = id
  renderEntries()
  renderImageMarks()
  const pageNum = (e.anchors && e.anchors[0] && e.anchors[0].page) || e.page
  if (pageNum) {
    const p = state.pages[pageNum - 1]
    if (p && !p.rendered) {
      // 这页还没渲染：排队渲染，渲染完成后 renderPage 会接着把这一条定位出来
      state.pendingAnchorFlash = id
      enqueueRender(pageNum)
      return
    }
  }
  scrollToEntry(e)
  refreshHighlights()
}

/** 侧栏发来的操作（经后台中继） */
async function onReaderCommand(msg) {
  const type = msg && msg.type
  if (!type) return
  if (type === 'reveal') { await revealEntry(msg.id); return { ok: true } }
  if (type === 'remove') { removeEntry(msg.id); return { ok: true } }
  if (type === 'clear') {
    state.entries = []
    state.activeId = ''
    renderEntries()
    refreshHighlights()
    renderImageMarks()
    scheduleSave()
    return { ok: true }
  }
  if (type === 'reference') {
    const e = state.entries.find((x) => x.id === msg.id)
    return await setAsReference(e)
  }
  if (type === 'retranslate') return await retranslateEntry(msg.id, msg.text)
  // 快捷键由后台中继过来：侧栏有焦点时页面收不到按键，只能走这条路
  if (type === 'boxSelect') { startBoxSelect(); return { ok: true } }
  if (type === 'translateSelection') { await translateSelection(); return { ok: true } }
  return { ok: false, error: { message: '未知操作 ' + type } }
}

// 侧栏（以及后台中继）发来的命令必须有监听者 —— 少了这一段，侧栏里点删除/重译/设为引用
// 全都悄无声息（踩过：自测是直接调 onReaderCommand，正好绕过了消息链路）。
if (canMessage()) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'readerCommand') return
    Promise.resolve(onReaderCommand(msg))
      .then((r) => sendResponse(r || { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: { message: String((e && e.message) || e) } }))
    return true     // 异步响应
  })
}

// ── 进度 ──────────────────────────────────────────────────────────────────────
function currentPage() {
  const top = els.scroll.getBoundingClientRect().top + 8
  for (const p of state.pages) {
    const r = p.wrap.getBoundingClientRect()
    if (r.bottom > top) return p.num
  }
  return state.pages.length || 1
}

function onScroll() {
  if (!state.doc) return
  els.pageinfo.textContent = '第 ' + currentPage() + ' / ' + state.doc.numPages + ' 页'
  clearTimeout(state.scrollRecoverTimer)
  state.scrollRecoverTimer = setTimeout(recoverStaleVisible, 150)
  scheduleSave()
}

function gotoPage(num, smooth = true) {
  const p = state.pages[Math.max(1, Math.min(state.pages.length, num)) - 1]
  if (!p) return
  p.wrap.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
}

// ── 持久化（按内容哈希，存 chrome.storage.local）─────────────────────────────
function scheduleSave() {
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(saveRecord, 600)
}

async function saveRecord() {
  if (!state.doc || !state.hash) return
  touchLibraryMeta()          // 顺手更新书库里的页数/译文条数/读到第几页
  if (typeof chrome === 'undefined' || !chrome.storage) return
  const record = {
    name: state.name,
    pages: state.doc.numPages,
    page: currentPage(),
    scale: state.scale,
    entries: state.entries.map((e) => ({
      id: e.id,
      kind: e.kind || 'text',
      anchors: e.anchors,
      rect: e.rect,
      page: e.page,
      source: e.source,
      translation: e.translation,
      at: e.at,
    })),
    updatedAt: Date.now(),
  }
  try {
    await chrome.storage.local.set({ [STORE_PREFIX + state.hash]: record })
  } catch (e) {
    console.warn('[阅读器] 保存失败', e)
  }
}

async function loadRecord(hash) {
  if (typeof chrome === 'undefined' || !chrome.storage) return null
  try {
    const key = STORE_PREFIX + hash
    const got = await chrome.storage.local.get(key)
    return got[key] || null
  } catch {
    return null
  }
}

// ── 事件接线 ──────────────────────────────────────────────────────────────────
els.open.addEventListener('click', () => els.file.click())
els.openMain.addEventListener('click', () => els.file.click())
els.libraryBtn.addEventListener('click', showLibrary)
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0]
  els.file.value = ''
  openFile(f)
})

els.zoomIn.addEventListener('click', () => { state.fitWidth = false; setScale(state.scale * 1.15) })
els.zoomOut.addEventListener('click', () => { state.fitWidth = false; setScale(state.scale / 1.15) })
els.fit.addEventListener('click', fitWidth)
els.box.addEventListener('click', () => startBoxSelect())
els.pages.addEventListener('mousedown', onBoxStart)
els.notes.addEventListener('click', requestNotesOpen)
els.tipTranslate.addEventListener('click', translateSelection)
els.tipCopy.addEventListener('click', () => {
  const hit = state.lastSelection
  if (hit) copyText(anchorsText(hit.anchors))
  hideTip()
})

els.scroll.addEventListener('scroll', onScroll, { passive: true })
document.addEventListener('mouseup', () => setTimeout(onSelectionSettled, 0))
document.addEventListener('click', onReaderClick)
// 双击空白处（既不在译文高亮上，也没选中文字）→ 收起侧栏里的译文对照
document.addEventListener('dblclick', (ev) => {
  if (state.boxMode) return
  if (els.tip.contains(ev.target)) return
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().trim()) return
  if (pointInSelection(ev.clientX, ev.clientY)) return
  if (entryAtPoint(ev.clientX, ev.clientY)) return      // 双击在已翻过的区域上：那是"跳到原文"
  requestNotesClose()
})
document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelectionSettled, 0) })
document.addEventListener('mousedown', (e) => {
  if (!els.tip.contains(e.target)) hideTip()
})

document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); translateSelection(); return }
  // 框选翻译的快捷键，与页面上的截图翻译一致；按一次框一次，不用先切模式
  if (e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); startBoxSelect(); return }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setScale(state.scale * 1.15) }
    if (e.key === '-') { e.preventDefault(); setScale(state.scale / 1.15) }
    if (e.key === '0') { e.preventDefault(); fitWidth() }
  }
  if (e.key === 'Escape') {
    if (state.boxMode) endBoxSelect('esc')
    else hideTip()
  }
})

window.addEventListener('resize', () => {
  clearTimeout(window.__rdFitTimer)
  // 拖窗口会连续触发，必须走便宜路径
  window.__rdFitTimer = setTimeout(() => { if (state.fitWidth) fitWidth(true) }, 200)
})

// 保存有 600ms 防抖，页面要是正好在防抖窗口里被关掉，这一笔就丢了。
// 页面隐藏 / 卸载时立刻补一次（尽力而为：扩展页面的 storage 写入通常来得及）。
function flushSave() {
  if (!state.saveTimer) return
  clearTimeout(state.saveTimer)
  state.saveTimer = null
  saveRecord()
}
window.addEventListener('pagehide', flushSave)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave()
})

// 拖入文件
document.addEventListener('dragover', (e) => { e.preventDefault() })
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  if (f) openFile(f)
})

// 初始就是空状态：先把书库列出来
if (els.empty && !els.empty.hidden) loadLibrary()

// 滚轮 + Ctrl 缩放
els.scroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  state.fitWidth = false
  setScale(state.scale * (e.deltaY < 0 ? 1.1 : 0.9))
}, { passive: false })

// ── 自测入口 ──────────────────────────────────────────────────────────────────// 无头浏览器里由 drive.mjs 调用：直接喂字节、直接走"选区→偏移→翻译→高亮"这条路，
// 不依赖鼠标拖拽（CDP 里模拟拖选本来就是最不可靠的一环）。
window.__readerTest = {
  state,
  openBytes,
  setScale,
  fitWidth,
  translateSelection,
  selectionAnchors,
  anchorsText,
  refreshHighlights,
  refreshCount() {
    let n = 0
    for (const e of state.entries) for (const a of e.anchors || []) if (resolveAnchor(a)) n++
    return n
  },
  toggleBoxMode: () => startBoxSelect(),
  startBoxSelect,
  endBoxSelect,
  translateRegion,
  renderImageMarks,
  notesSnapshot,
  syncNotes,
  onReaderCommand,
  loadLibrary,
  openFromLibrary,
  showLibrary,
  archiveToLibrary,
  libraryState() {
    return {
      status: els.libraryStatus ? els.libraryStatus.textContent : '',
      items: els.libraryList ? [...els.libraryList.querySelectorAll('.rd-lib-item')].map((b) => ({
        hash: b.dataset.hash,
        disabled: b.disabled,
        name: (b.querySelector('.rd-lib-name') || {}).textContent || '',
        meta: (b.querySelector('.rd-lib-meta') || {}).textContent || '',
      })) : [],
      archived: !!state.archived,
      listCount: (state.library || []).length,
    }
  },
  findDuplicate,
  entryAtPoint,
  renderStats() {
    return {
      renderCount: state.renderCount,
      renderMs: state.renderMs,
      pageRenderMs: state.pages.map((p) => p.lastRenderMs || 0),
      lastZoomRerendered: state.lastZoomRerendered,
      lastScaleCheap: state.lastScaleCheap,
      renderedPages: state.pages.filter((p) => p.rendered).length,
      stalePages: state.pages.filter((p) => p.needsRender).length,
      canvasPixels: state.pages.filter((p) => p.canvas).map((p) => p.canvas.width * p.canvas.height),
      ioFired: state.ioFired,
      ioBlocked: state.ioBlocked,
      enqueued: state.enqueued,
      settleUntil: Math.round(state.settleUntil),
      now: Math.round(performance.now()),
      dpr: window.devicePixelRatio,
    }
  },
  activeEntryId() { return state.activeId },
  imageMarks() {
    return [...els.pages.querySelectorAll('.rd-mark')].map((d) => ({
      page: Number(d.closest('.rd-page').dataset.page),
      style: { left: d.style.left, top: d.style.top, width: d.style.width, height: d.style.height },
      rect: (() => { const r = d.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })(),
    }))
  },
  anchorRects() {
    const out = []
    for (const e of state.entries) {
      for (const a of e.anchors) {
        const r = resolveAnchor(a)
        if (!r) continue
        const rects = [...r.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)])
        out.push({ id: e.id, page: a.page, start: a.start, end: a.end, rects })
      }
    }
    return out
  },
  /** 用一对（页号, 起止偏移）造一个真实选区，模拟用户划选；区间无效时返回 false */
  selectOffsets(page, start, end) {
    const p = state.pages[page - 1]
    if (!p || !p.layer) return false
    const r = rangeFromOffsets(p.layer, start, end)
    if (!r || r.collapsed) return false
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    state.lastSelection = { anchors: [{ page, start, end }], range: r }
    return true
  },
  gotoPage,
  revealEntry,
}
