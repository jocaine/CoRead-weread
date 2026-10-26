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
  // 「pdf.js 把词间空格吞了」的补救（2026-11，见 reader-anchor.js 那段注释）
  looksSpaceStarved,
  glyphTextFromOps,
  spacedPageFix,
  textFromSpacedOffsets,
  // 附近原文取哪几页/哪一段（纯算术，见 reader-anchor.js 的 planContextWindow）
  planContextWindow,
  // 「设为引用」带什么上下文（扫描件退回整卡译文，见 reader-anchor.js 的 contextForRef）
  contextForRef,
  // 页面还没渲染时（没有文字层）的切片：见 contextAround
  joinLines,
  // 多页切片接成一段原文（页与页之间不留换行，见 reader-anchor.js）
  joinSlices,
  linesFromItems,
  linesFromFixedItems,
  // 「点这条引用该跳到哪一处」的挑选（锚点优先，见 reader.js 的 locateRef）
  pickLocateAnchor,
} from './reader-anchor.js'
import { RECEIVER_URL } from './translate-protocol.js'   // 后台地址的真源，不另写一份
// 「读到哪儿」的算术（第几页 + 页内比例）：纯函数，单测在 extension/test/reader-position.test.mjs
// ⚠️ 只取这两个：`clamp01` 本文件里已经有一个（搜 `const clamp01`，别处也在用），不要再导一个同名的进来
import { positionFromBoxes, deltaToPosition } from './reader-position.js'
// PDF 里的超链接（注释 /Link）怎么铺、怎么命中：纯函数，单测在 extension/test/reader-links.test.mjs
import { isLinkAnnotation, linkTarget, linkBoxes, linkAt, destTop } from './reader-links.js'

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
/**
 * 需要"这条译文存在"才有意义的命令（多标签页路由用，见文件末尾 onMessage 里的 readerCommand）。
 * 没有这条记录的阅读器页面**不响应**这些命令，免得先答一句「未找到」把真正干活的页面盖掉。
 */
const ENTRY_SCOPED_COMMANDS = new Set(['reveal', 'remove', 'reference', 'retranslate', 'precise', 'toggle', 'showTranslation'])
/**
 * 参考线：滚动区顶端往下让 8px。
 *
 * 它是"读到哪儿"的**唯一基准**——`currentPage()`/`currentPosition()` 量它，
 * 恢复位置时也把它当落点（见 reader-position.js 的注释）。两处必须同一条线，
 * 否则存的时候量的是 A、恢复的时候落的是 B，位置就会差那 8px（而且没人看得出来）。
 */
const SCROLL_REF_PAD = 8
/**
 * 落位纠偏最多持续多久 / 补几次（正常几百毫秒内就稳了，这是防"永远在纠"的兜底）。
 * 2.5 秒是留了余量的：它要盖住"上面那几页渲染完"的时间——那才是位置漂移的来源。
 */
const RESTORE_SETTLE_MS = 2500
const RESTORE_MAX_TRIES = 12
/** 纠偏隔多久补一次（120ms ≈ 一帧多，用户看不出"在纠"，又能赶上渲染造成的漂移） */
const RESTORE_TICK_MS = 120
/**
 * 这一次**页面加载**的随机指纹（2026-11）。
 *
 * 用途只有一个：自检验"重新打开之后回到原处"时，必须能分清读到的是**新加载那一次**
 * 阅读器的回答，还是**旧页面**还没卸载时的回音 —— 后者会让断言假通过
 *（旧页面的位置当然还是它自己那个位置）。自检拿它前后比一下就行。
 */
const PAGE_SESSION = Math.random().toString(36).slice(2, 8)

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
  tocBtn: $('rd-toc-btn'),
  toc: $('rd-toc'),
  tocClose: $('rd-toc-close'),
  tocKind: $('rd-toc-kind'),
  tocJump: $('rd-toc-jump'),
  tocRange: $('rd-toc-range'),
  tocFirst: $('rd-toc-first'),
  tocLast: $('rd-toc-last'),
  tocPos: $('rd-toc-pos'),
  tocList: $('rd-toc-list'),
  box: $('rd-box'),
  boxBar: $('rd-box-bar'),
  boxExit: $('rd-box-exit'),
  notes: $('rd-notes'),
  scroll: $('rd-scroll'),
  pages: $('rd-pages'),
  empty: $('rd-empty'),
  scanHint: $('rd-scan-hint'),
  tip: $('rd-tip'),
  tipTranslate: $('rd-tip-translate'),
  tipRef: $('rd-tip-ref'),
  tipCopy: $('rd-tip-copy'),
  boxTip: $('rd-box-tip'),
  boxTranslate: $('rd-box-translate'),
  boxRecognize: $('rd-box-recognize'),
  toast: $('rd-toast'),
  delOverlay: $('rd-del-overlay'),
  delTitle: $('rd-del-title'),
  delMsg: $('rd-del-msg'),
  delCancel: $('rd-del-cancel'),
  delOk: $('rd-del-ok'),
}

const state = {
  doc: null,
  hash: '',
  name: '',
  scale: 1.25,
  fitWidth: true,
  pages: [],            // {num, wrap, canvas, layer, page, viewport, renderTask, textLayer, links, linkLayer, rendered, spaceFix}
  library: [],          // 书库列表（来自 receiver）
  archived: false,      // 当前这本是不是已经在书库里
  entries: [],          // {id, anchors:[{page,start,end}], source, translation, at}
  refsSeen: [],         // 已设成引用的段落 {selectedText, translation, anchors, at}（给译文面板画下划线）
  /**
   * 「这条引用落在书里哪一处」：`{ text, anchors:[{page,start,end}], at, guess? }`（2026-11 修）。
   *
   * `guess: true` = 不是用户划的那一下，而是按文字在附近猜的（见 refRanges ③）——
   * 画绿线可以，跳引用时排在精确锚点之后（见 noteRefMark / locateRef）。
   *
   * 为什么需要单独一份：书页上的标记必须靠偏移才能解析成 Range，而引用清单本身
   * 原先只有文字。于是设引用那一刻把锚点记在本地——这是最靠得住的"用户当时划的是哪一段"
   *（见 noteRefMark）。
   *
   * 2026-10-25 起接收端的存档也会带上锚点（setAsReference 报上去的 page/anchors，
   * 随 refsSeen 回来），所以这份本地缓存**不再是唯一来源**：它仍优先（它是划的那一下），
   * 掉了还有存档那份垫底（见 locateRef）。
   *
   * 真值仍在 refsSeen（接收端那份"这本书还有哪些引用"）：refreshRefs 成功后按文字
   * 裁掉已被删除的（见 pruneRefMarks）。这份只是"画在哪里"的缓存，随进度记录落盘。
   */
  refMarks: [],
  refsAt: 0,            // 上一次从接收端拉这份清单的时刻（TTL 用，见 refreshRefs）
  refsFail: 0,          // 连续失败次数（退避重试用，见 scheduleRefsRetry）
  refsRetryTimer: null, // 排队中的那次重试
  /**
   * 跳引用时目标页还没渲染，位置先记在这儿（见 scrollToAnchor / renderPage）。
   * `{page, start, end}`：文字层要等这一页画好才有，Range 才能解析出来。
   */
  pendingLocate: null,
  activeId: '',
  /**
   * 用户最后一次在**书页上**点了哪一条译文区域（2026-11）。
   *
   * 为什么 activeId 不够：activeId 同时也是"刚翻完一条、把它设为当前"（focusEntry）在写。
   * 侧栏的译文对照要区分这两件事——
   *   · **书页上点过来的** → 列表必须**滚到那一条**（用户刚在书里看到它，对照栏得对上）
   *   · **刚翻完设为当前** → 按老规矩（阅读者贴着底才跟过去，不然别把他从旧条目上拽走）
   * 所以这里另记一份只由"页面上点译文"产生的标记，用**时刻**而不是布尔值：
   * 同一条再点一次也要能触发，布尔值不变就跳不动了。
   */
  revealId: '',
  revealAt: 0,
  pendingAnchorFlash: '',
  boxMode: false,
  /** 这一轮框选是不是"一次性"（Alt+S 进来的是；工具栏按钮进来的不是，见 startBoxSelect） */
  boxOneShot: false,
  boxDrag: null,
  /**
   * 框选拖完、动作条还开着时的那块区域：`{ page, frac, marquee }`（2026-11）。
   * 原先一松手就翻译；现在先问「识别原文」还是「翻译」，这块就是等待选择的目标。
   * marquee 是页面上还留着的那道选框（选动作前一直可见）。动作条收起 / 换书 / 重新拖框会清掉。
   */
  boxChoice: null,
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
  savePending: null,      // { key, name }：排队中的那次保存写给谁（见 scheduleSave）
  /**
   * 正在进行的"落位纠偏"（2026-11 二次改版，见 restorePosition）：
   * `{ pos:{page,frac}, tries, until, stuck }`。null = 没有在恢复。
   */
  restore: null,
}

/**
 * 诊断上报：往接收端的 `logs/debug.jsonl` 写一条（与 content.js / sidebar.js 同一套，source=reader）。
 *
 * 为什么阅读器也要有这条：它以前只有 `console.warn`，而"位置恢复得对不对"这类问题
 * 是用户事后报的——那时他机器上的控制台早就没了，留给开发者的只有"我打开之后跑到别处了"。
 * 有这条链路，`source=reader, stage=restore-*` 就能直接读出来。
 *
 * ⚠️ 失败一律静默：本机服务没起来时阅读照常，绝不能因为上报把恢复流程带崩。
 */
function postDebug(payload) {
  try {
    if (!payload || !payload.stage) return
    fetch(RECEIVER_URL + '/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ source: 'reader', ts: Date.now() }, payload)),
    }).catch(() => {})
  } catch (e) {}
}

// ── 与后台通信 ────────────────────────────────────────────────────────────────
async function callBackground(message) {
  if (state.translateOverride) return state.translateOverride(message)
  if (!canMessage()) return { ok: false, error: { code: 'NO_BG', message: '不在扩展环境里，无法调用后台' } }
  try {
    const resp = await chrome.runtime.sendMessage(message)
    return resp || { ok: false, error: { code: 'NO_RESPONSE', message: '后台没有返回结果' } }
  } catch (e) {
    // 例如后台没起来 / 没有接收方：如实回一个失败对象，别让调用方在半路被异常打断
    return { ok: false, error: { code: 'NO_BG', message: String((e && e.message) || e) } }
  }
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
// 原件存在 data\reading\books\<hash>\source.pdf，列表来自 GET /reader-books。
// receiver 没起来时不影响本地打开，只是没有历史可用。
const LIB_TIMEOUT = 5000

/**
 * 阅读器这本书在**共读侧**的书 ID。
 *
 * 为什么要它（2026-11）：共读侧的"书 ID"以前只有微信读书有（内容脚本从阅读页 URL 取），
 * 我们自己的阅读器是**另一套**（用 PDF 内容哈希当目录名，只存在 reader-meta.json，
 * 见 receiver 的 listReaderBooks），于是：
 *   · 打开 PDF 不进「已读过的书籍」列表；
 *   · 阅读器里点「设为引用」被后台判成"当前页面未关联任何书籍"（报"未加入一本书籍"）。
 * 这里给出阅读器侧的唯一 ID 形态：`rd_` + 64 位内容哈希。
 *
 * 三条约束（改动时别破坏）：
 *   1) 只允许 `[A-Za-z0-9_]`——侧栏与 receiver 的书 ID 校验都是这个字符集
 *      （sidebar.js 的 applyBookContext、receiver 的 sanitizePathPart），带点/横线会被剥。
 *   2) 长度必须 ≥12——侧栏那条 `^[A-Za-z0-9_]{12,}$` 是硬门槛，短了直接被当成垃圾值丢掉，
 *      `rd_` 前缀加哈希共 67 字符，稳过。
 *   3) **与 PDF 内容哈希一一对应**：同一份文件重复打开必须是同一个 ID，否则同一本书
 *      会攒出多条"已读书籍"记录、引用也会对不上。
 * @param {string} hash 内容哈希（sha256Hex 的结果）
 */
function readerBookId(hash) {
  return hash ? 'rd_' + hash : ''
}

/** 当前有没有打开一本书（PDF） */
function hasBook() {
  return !!state.doc
}

/** 当前这本书在共读侧的 ID（没开书时返空串） */
function currentBookId() {
  return state.doc && state.hash ? readerBookId(state.hash) : ''
}

/** 当前这本书的页数 */
function bookTotal() {
  return state.doc ? state.doc.numPages : 0
}

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
    toast('已存入书库，下次无需再选文件')
    return true
  } catch (e) {
    toast('未能存入书库：CoRead 本机服务未启动（' + ((e && e.message) || e) + '）', true)
    return false
  }
}

/**
 * 更新书库里的元信息（书名、页数、译文条数、读到第几页），并把这本登记到**共读侧**
 * （receiver 会写 `<书ID>/meta.json`，即「已读过时的书籍」列表的数据源）。
 *
 * 写失败不提示——receiver 没起来时阅读照常，只是没有共读侧记录（与书库本身同款行为）。
 *
 * ⚠️ `pos` 必须是**当前真实位置**（默认现算一个）。为什么把它做成参数（2026-11 二次改版）：
 * 打开一本书时 `openBytes` 会调一次本函数，而那一刻滚动还没落到恢复位置上——
 * 现算的话量到的是"第 1 页"，于是书库记录里"读到第几页"被**重置成 1**，
 * 600ms 后那次保存才纠正回来（用户中途关掉就永远停在 1）。所以调用方
 * "已经知道位置"时要把位置交进来，别让这里现猜。
 */
function touchLibraryMeta(posArg) {
  const pos = posArg || currentPosition()
  if (!state.hash) return
  receiverJson('/reader-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash: state.hash,
      bookId: readerBookId(state.hash),   // 共读侧 ID（receiver 据此写 meta.json）
      name: state.name,
      pages: state.doc ? state.doc.numPages : 0,
      entries: state.entries.length,
      page: state.doc ? pos.page : 0,
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

/**
 * 空状态底部那句说明——**只在需要的时候出现**（2026-11，按 coread-visual-spec 重做）。
 *
 * 三种状态，三种话，各自只回答"我现在该干什么"：
 *   ① 书库里有你自己放过的书 → "点书名接着读"（一句操作指引，不解释产品）
 *   ② 一本都没有 → 说明**什么时候该用这个阅读器**。它在这儿是有用的：
 *      屏幕空着，而用户手上多半正有个微读转不动的 PDF —— 这句话回答的正是他此刻的问题。
 *      顺带把定位说清（默认走微读传书，外文和转不动的走这里），免得他以为这是主推路径。
 *   ③ 还在读 → 空着，别在没结论的时候先说话。
 *
 * ⚠️ 为什么不做成写死在 HTML 里的固定文案（前一版就是）：
 * 对天天用的人来说，"这个工具是干什么的"每开一次讲一遍是噪音；而缺口出现时
 * （书库空着）它又恰恰是最该说的一句。同一句话，位置对不对全看它出不出现在需要的时候。
 *
 * ⚠️ 状态来自模块变量 `_libLoading` / `state.library`，**不要去读 `#rd-lib-status` 的文案**
 * 反推状态：那是拿显示文本当数据源，改一个字就悄悄改掉逻辑（而且"本机服务未启动"那句
 * 里根本没有状态信息，反推必然会猜）。
 */
let _libLoading = false

function renderEmptyNote() {
  const el = $('rd-empty-note')
  if (!el) return
  if (_libLoading) { el.hidden = true; el.textContent = ''; return }
  const mine = (state.library || []).length
  if (mine > 0) {
    el.hidden = false
    el.textContent = '点书名接着读 —— 读到哪里、译过哪些段落，都还在。'
    return
  }
  el.hidden = false
  el.textContent = '外文 PDF 用这里读最顺。微信读书传不上去、或转成电子书会错版的，'
    + '也放到这里来读 —— 正文是真文字，划词就译，译文按段落贴在原文上。'
}

function renderLibrary(books) {
  const box = els.libraryList
  if (!box) return
  box.replaceChildren()
  if (!books.length) {
    els.libraryStatus.textContent = '暂无'
    renderEmptyNote()
    return
  }
  els.libraryStatus.textContent = books.length + ' 本'
  renderEmptyNote()
  for (const b of books) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'rd-lib-item'
    item.dataset.hash = b.hash
    item.disabled = !b.hasFile

    const main = document.createElement('span')
    main.className = 'rd-lib-main'

    const name = document.createElement('span')
    name.className = 'rd-lib-name'
    name.textContent = b.name || '未命名.pdf'

    const meta = document.createElement('span')
    meta.className = 'rd-lib-meta'
    const bits = []
    if (b.pages) bits.push(b.pages + ' 页')
    if (b.entries) bits.push(b.entries + ' 条译文')
    if (b.size) bits.push(fmtSize(b.size))
    if (b.lastOpenedAt) bits.push(fmtWhen(b.lastOpenedAt))
    meta.textContent = bits.join(' · ')

    main.append(name, meta)
    item.appendChild(main)

    /**
     * 删除按钮（2026-11）：书库里每一项都有。
     *   · **不需要判断"有没有文件"**——没有文件的项根本不会出现在这个列表里
     *     （receiver 的 listReaderBooks 会把"原件不在、只剩记录"的直接清掉）。
     *     这条规则是用户定的："没有就是没有了"。
     */
    const del = document.createElement('span')   // 用 span：button 不能嵌 button
    del.className = 'rd-lib-del'
    del.setAttribute('role', 'button')
    del.setAttribute('tabindex', '0')
    del.title = '从书库删除这个 PDF 文件'
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>'
    const onDel = (e) => {
      e.preventDefault()
      e.stopPropagation()   // 别触发整行点击（那是"打开这一本"）
      deleteReaderBook(b)
    }
    del.addEventListener('click', onDel)
    del.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onDel(e) })
    item.appendChild(del)

    item.addEventListener('click', () => openFromLibrary(b))
    box.appendChild(item)
  }
}

/**
 * 读书库清单。
 *
 * ⚠️ **失败要重试，不能只试一次**（2026-10-20 用户实测："重启后插件找不到接收端"）。
 *
 * 为什么这一条是真缺口：扩展一重载，`reader.html` 也跟着重载，而它加载的那一刻
 * 接收端**可能正在关/开**。实测时间线：22:08:51 重载扩展（本页重新加载）→
 * 22:08:54 旧的接收端被结束 → 22:09:17 新的接收端才起来。
 * 原来这里只试一次，失败就把 `"本机服务未启动"` 写进状态栏**再也不改**——
 * 接收端明明已经起来了，用户看到的还是"找不到接收端"，只能手动刷新页面。
 * 现在：退避重试几次（0.8s / 1.6s / 3.2s / 4s …），期间状态栏写"重试中…"；
 * 全都失败才认输，并且**保留上一次读到的书单**（短暂连不上不该把列表清空）。
 * 另外页面重新可见时再补一次（切回这个标签页就能自愈）。
 */
let _libRetry = 0
async function loadLibrary() {
  if (!els.libraryList) return
  _libLoading = true
  if (!(state.library || []).length) els.libraryStatus.textContent = '读取中…'
  renderEmptyNote()          // 还在读 → 那句说明先别出来（见 renderEmptyNote 的状态表）
  try {
    const data = await receiverJson('/reader-books')
    const books = data.books || []
    state.library = books
    _libLoading = false
    _libRetry = 0
    renderLibrary(books)
  } catch (e) {
    _libLoading = false
    if (_libRetry < 5) {
      _libRetry++
      els.libraryStatus.textContent = '本机服务未启动，重试中…'
      setTimeout(loadLibrary, Math.min(4000, 400 * Math.pow(2, _libRetry - 1)))
      renderEmptyNote()
      return
    }
    renderLibrary(state.library || [])   // 保留上次的清单，不清空
    els.libraryStatus.textContent = '本机服务未启动（可在本机服务启动后切回本页重试）'
  }
}

// 切回这个标签页时若还处在"没连上"的状态，再补一次（不重试的话用户只能手动刷新）
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !_libRetry) return
  _libRetry = 0
  loadLibrary()
})

/**
 * 从书库删掉一项（2026-11）。
 *
 * ── 模型的边界（用户定调，别再来回改）────────────────────────────────────────
 *   · 阅读器「书库」里的每一项 = **那个 PDF 文件** → 在这里删文件
 *   · 侧栏「会话 / 已读书籍」里的每一项 = **这本书的讨论记录** → 在那边删记录
 * 两个界面各自只删自己那一样，所以这里**没有二选一**，也不需要问"要不要连记录一起删"。
 *
 * ── 为什么不需要"没有文件时怎么办"的分支 ─────────────────────────────────────
 * 因为**没有文件的项根本不会出现在书库里**：receiver 的 listReaderBooks 会直接把
 * "只剩记录、原件不在"的那种清掉、不列出来（用户定调："没有就是没有了"）。
 * 所以这里只管一种情况：有原件 → 删原件 + 它自己的记录（页数、读到第几页、译文锚点）。
 * 划线 / 讨论 / 聊天是共读侧，不在这条线上，也不受影响。
 *
 * 历史（别再走回去）：先后试过"列出来但点不动"和"列出来并给一个清记录的按钮"，
 * 前者报"无法删除"，后者被问"我们为什么要有借书卡这个机制"。
 */
function deleteReaderBook(b) {
  if (!b || !b.hash) return
  const name = b.name || '这个 PDF'
  return askDelete(`从书库删除《${name}》？`,
    '会删掉书库里的原件，以及它的页数与读到第几页这些记录。\n'
    + '这本书的划线、讨论和译文记录不受影响（要删那些请去侧栏的已读书籍列表）。')
    .then(async (yes) => {
      if (!yes) return
      try {
        const r = await receiverJson('/reader-book-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash: b.hash }),
        })
        if (!r || r.ok === false) throw new Error('bad response')
      } catch (e) {
        toast('删除失败：CoRead 本机服务无响应', true)
        return
      }
      toast('已从书库删除：' + name)
      loadLibrary()
    })
}

/**
 * 自绘确认弹窗（阅读器版）。与侧栏那个同款，**不是重复造**——它是另一个页面，
 * 拿不到侧栏的 DOM；而扩展页里原生 `confirm()` 被 Chrome 压制（恒返回假），
 * 侧栏早就因此踩过坑。只有"确定 / 取消"两个答案（见 deleteReaderBook 的模型说明）。
 */
function askDelete(title, message) {
  return new Promise((resolve) => {
    if (!els.delOverlay) { resolve(false); return }
    els.delTitle.textContent = title
    els.delMsg.textContent = message
    els.delOverlay.hidden = false
    const done = (v) => {
      els.delOverlay.hidden = true
      els.delCancel.removeEventListener('click', onNo)
      els.delOk.removeEventListener('click', onYes)
      els.delOverlay.removeEventListener('mousedown', onDown)
      els.delOverlay.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
      resolve(v)
    }
    const onYes = () => done(true)
    const onNo = () => done(false)
    // 点遮罩＝取消：按下与松开都落在遮罩上才算（与侧栏 bindMaskClose 同款判定）
    let downOnMask = false
    const onDown = (e) => { downOnMask = e.target === els.delOverlay }
    const onUp = (e) => { if (downOnMask && e.target === els.delOverlay) done(false); downOnMask = false }
    const onKey = (e) => {
      if (e.key === 'Escape') done(false)
      else if (e.key === 'Enter') done(true)
    }
    els.delCancel.addEventListener('click', onNo)
    els.delOk.addEventListener('click', onYes)
    els.delOverlay.addEventListener('mousedown', onDown)
    els.delOverlay.addEventListener('mouseup', onUp)
    // 延到下一个事件循环再挂键盘监听：弹窗正是被一次回车打开的（书库里按回车），
    // 同一次 keydown 还会继续冒泡到 document，当场挂上会被它立刻确认掉（侧栏踩过）
    setTimeout(() => document.addEventListener('keydown', onKey), 0)
    els.delCancel.focus()   // 默认聚焦「取消」，防误触回车直接删
  })
}

/** 从书库打开：把原件取回来（不用再选文件） */
async function openFromLibrary(book) {
  toast('正在从书库读取 ' + (book.name || '') + '…')
  // 打开期间置位：这段时间 `hasBook()` 还是 false，而对侧栏来说
  // **"正在打开"和"没有书"必须区分**（见 readerBookInfo 的注释）
  state.loading = true
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
    toast('从书库打开失败：' + ((e && e.message) || e) + '（可改用「打开本地 PDF」）', true)
  } finally {
    state.loading = false
  }
}

/** 回到书库（关掉当前这本）。
 *  ⚠️ 三件事都要做，少一件就会留下"书库页面上挂着上一本的书名和 120%"：
 *  ① 关掉文档（release 页面 / 清 state）；② 顶栏切回 library 态；③ 清掉顶栏里的旧文字。 */
function showLibrary() {
  closeDoc()
  setToolbar('library')
  resetToolbarText()
  setEmptyVisible(true)
  loadLibrary()
}

// ── 章节目录（2026-11）───────────────────────────────────────────────────────
// 在此之前页码只是**显示**，从来不是**入口**：用户找不到"跳到后面章节"的地方。
//
// 两种内容，按"有没有真章节"降级：
//   1. 有书签的 PDF → pdf.js 的 getOutline()，**真书签**（学术书大量有），按树渲染
//   2. 其余的 PDF  → 只有页码滑杆（我们**不去猜章节**：靠字号猜出来的目录，
//                    猜错了比没有更烦人，而且没法向用户解释为什么这条"章节"落在这儿）
const TOC_OUTLINE_TIMEOUT = 4000
/** 已取到的书签目录（按 hash 缓存，换书重取）。null = 这本书没有书签 */
let _outlineCache = { hash: '', items: null }

/**
 * 把 pdf.js 的 outline 变成可点的平坦列表（带层级与页码）。
 *
 * 页码怎么来的：书签的目的地有两种写法 ——
 *   · 显式数组 [ref, {name:'XYZ'}, left, top, zoom]，ref 是页对象的引用
 *   · 命名字符串（'chapter3'），要去 getDestination 查一次
 * 两种都要处理，否则一半的书签会点不动（这是 pdf.js 的常见坑，不是我们这里特有的）。
 * 取不到页码的书签仍然列出（点它跳到父级目标或不动），但会标 `—`，不假装能跳。
 */
async function loadPdfOutline() {
  if (!state.doc) return []
  if (_outlineCache.hash === state.hash) return _outlineCache.items || []
  let items = []
  try {
    const outline = await Promise.race([
      state.doc.getOutline(),
      new Promise((resolve) => setTimeout(() => resolve(null), TOC_OUTLINE_TIMEOUT)),
    ])
    if (Array.isArray(outline)) {
      const flat = []
      const walk = async (nodes, depth) => {
        for (const node of nodes) {
          if (!node || depth > 3) continue
          let page = 0
          try {
            let dest = node.dest
            if (typeof dest === 'string') dest = await state.doc.getDestination(dest)
            if (Array.isArray(dest) && dest[0] !== undefined) {
              const idx = await state.doc.getPageIndex(dest[0])
              page = idx + 1
            }
          } catch {}
          flat.push({ title: String(node.title || '(无标题)'), page, depth })
          if (Array.isArray(node.items) && node.items.length) await walk(node.items, depth + 1)
        }
      }
      await walk(outline, 0)
      items = flat
    }
  } catch (e) {
    console.warn('[阅读器] 读 PDF 书签失败（不影响翻页）', e)
  }
  _outlineCache = { hash: state.hash, items }
  return items
}

/** 目录每一条：标题 + 页码，点了就跳 */
function tocItem({ title, page, depth }) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'rd-toc-item'
  b.dataset.depth = String(depth || 0)
  b.dataset.page = String(page || 0)
  const label = document.createElement('span')
  label.textContent = title
  const num = document.createElement('span')
  num.className = 'rd-toc-page'
  num.textContent = page ? String(page) : '—'
  b.append(label, num)
  b.addEventListener('click', () => {
    if (page) gotoPage(page)
    closeToc()
  })
  return b
}

/** 刷新目录里的"当前位置"标记与滑杆（滚动时不重建 DOM） */
function syncTocPosition() {
  if (!els.toc || els.toc.hidden) return
  const cur = currentPage()
  const total = bookTotal()
  if (els.tocRange) {
    els.tocRange.max = String(total || 1)
    els.tocRange.value = String(cur)
  }
  if (els.tocPos) {
    els.tocPos.textContent = `${cur} / ${total} 页`
  }
  for (const el of els.tocList.querySelectorAll('.rd-toc-item')) {
    const on = Number(el.dataset.page) === cur
    el.classList.toggle('is-on', on)
  }
}

async function openToc() {
  if (!hasBook() || !els.toc) return
  els.toc.hidden = false
  els.tocKind.textContent = 'PDF 书签 + 页码'
  els.tocList.replaceChildren()
  const loading = document.createElement('div')
  loading.className = 'rd-toc-empty'
  loading.textContent = '读取中…'
  els.tocList.appendChild(loading)

  const items = await loadPdfOutline()
  els.tocList.replaceChildren()
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'rd-toc-empty'
    empty.textContent = '这本 PDF 里没有书签目录（书签是制作 PDF 时做进去的，扫不出内容）。用上面的滑杆翻页。'
    els.tocList.appendChild(empty)
  } else {
    const sec = document.createElement('div')
    sec.className = 'rd-toc-sec'
    sec.textContent = `书签目录 · ${items.length} 条`
    els.tocList.appendChild(sec)
    for (const it of items) els.tocList.appendChild(tocItem(it))
  }
  syncTocPosition()
}

function closeToc() {
  if (els.toc) els.toc.hidden = true
}

function toggleToc() {
  if (!els.toc) return
  if (els.toc.hidden) openToc()
  else closeToc()
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
    failOpen('无法读取文件：' + ((e && e.message) || e))
  }
}

/** 打开过程中的任何失败都收在这里：把空状态放回来 + 明确提示，绝不留下无声的空白页。 */
function failOpen(message) {
  console.warn('[阅读器] 打开失败', message)
  closeDoc()
  setToolbar('library')
  setEmptyVisible(true)
  els.name.textContent = '未打开 PDF'
  els.status.textContent = message
  els.status.style.color = '#9a3b3b'
  toast(message, true)
}

async function openBytes(bytes, name, opts = {}) {
  closeDoc()
  state.name = name || '未命名.pdf'
  els.name.textContent = state.name
  setToolbar('pdf')
  setEmptyVisible(false)
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
    // 刚打开一本书 → 立刻告诉侧栏"当前书换成这本了"（用户点「打开 PDF」时期望的就是它）
    notifyBookChanged()
  } catch (e) {
    failOpen('无法打开该 PDF：' + ((e && e.message) || e))
  }
}

// ── 阅读位置：读到哪儿（量参考线）、回到哪儿（落位 + 纠偏）────────────────────
//
// 位置的**唯一定义**是"第几页 + 页内比例 frac"，算术全在 reader-position.js（有单测），
// 这里只做两件事：把 DOM 的矩形喂进去、把算出来的滚动量落下来。
//
// ⚠️ 两条不许分叉的规矩（agent/test/reader-position-wiring.test.js 盯着）：
//   ① currentPage() **就是** currentPosition().page —— 保存用一个、显示用另一个，
//      两把尺子迟早对不上（表现是"存的时候在第 5 页，打开却回到第 4 页"）。
//   ② 参考线只能有一个来源 scrollRefLine()：存与恢复必须量同一条线，
//      否则位置会差那 8px，而且没人看得出来。

/** 参考线：滚动区顶端 + SCROLL_REF_PAD（"读到哪儿"的唯一基准） */
function scrollRefLine() {
  return els.scroll.getBoundingClientRect().top + SCROLL_REF_PAD
}

/** 每一页的盒子（按页序），喂给 reader-position.js 的纯函数 */
function pageBoxes() {
  const c = els.scroll.getBoundingClientRect()
  return state.pages.map((p) => {
    const r = p.wrap.getBoundingClientRect()
    return { page: p.num, top: r.top - c.top, height: r.height }
  })
}

/** 当前在第几页 */
function currentPage() {
  return currentPosition().page
}

/** 当前位置：{page, frac}（frac 0=页顶 1=页底） */
function currentPosition() {
  return positionFromBoxes(scrollRefLine(), pageBoxes())
}

/** 状态栏的"第几页"（滚动时要跟着走） */
function updatePageInfo() {
  if (!els.pageinfo || !hasBook()) return
  const text = '第 ' + currentPage() + ' / ' + bookTotal() + ' 页'
  if (els.pageinfo.textContent !== text) els.pageinfo.textContent = text
}

/**
 * 跳到第 n 页。
 * @param {number} num 页号
 * @param {boolean} [smooth] 平滑滚动；滑杆连发 input 时传 false（十几个平滑滚动会打架）
 */
function gotoPage(num, smooth = true) {
  const n = Math.max(1, Math.min(state.pages.length || 1, Number(num) || 1))
  const p = state.pages[n - 1]
  if (!p) return
  const c = els.scroll.getBoundingClientRect()
  const delta = p.wrap.getBoundingClientRect().top - c.top - SCROLL_REF_PAD
  cancelRestore('用户主动跳页')
  els.scroll.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' })
  updatePageInfo()
  syncTocPosition()
}

/**
 * 把"读到 pos"落到滚动条上。
 *
 * 返回四种结果，**必须分开**（混成一个会把纠偏搞坏）：
 *   'moved'    动了
 *   'in-place' 已经正好在位 —— 这不是失败：漂移是**之后**才发生的（上面的页渲染完），
 *              所以纠偏不能因为它就收手
 *   'blocked'  想动却动不了（到顶/到底/被别的东西卡住）—— 这才是"落不动"
 *   'no-box'   这一页的盒子还不存在（还没建出来）
 */
function applyPosition(target) {
  const pos = target || (state.restore && state.restore.pos)
  if (!pos || !pos.page) return 'no-box'
  const p = state.pages[pos.page - 1]
  if (!p) return 'no-box'
  const el = p.wrap
  const c = els.scroll.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const delta = deltaToPosition(SCROLL_REF_PAD, r.top - c.top, r.height, pos.frac)
  if (Math.abs(delta) < 1) return 'in-place'
  const before = els.scroll.scrollTop
  els.scroll.scrollBy({ top: delta, behavior: 'auto' })
  return Math.abs(els.scroll.scrollTop - before) < 1 ? 'blocked' : 'moved'
}

/**
 * 回到上次读到的**那一处**（不是"那一页的顶端"：见 reader-position.js 开头那段）。
 *
 * 为什么要纠偏：打开书的那一刻，后面几页的高度还是按第 1 页估的**占位值**，
 * 等它们各自渲染完，页序上方的几何就变了 —— 落好的位置会漂。所以落位之后
 * 在 RESTORE_SETTLE_MS 内反复补落，稳定了就不再动。
 *
 * ⚠️ 用户一动手就停（见下面那几处 cancelRestore）：纠偏的意义是"把布局漂移抵掉"，
 * 用户自己滚走之后再把他拽回来，表现就是"滚不动 / 自己往回跳"。
 */
function restorePosition(target, why) {
  if (!target || !target.page) { state.restore = null; return }
  const pos = { page: Number(target.page) || 1, frac: clamp01(target.frac) }
  state.restore = { pos, tries: 0, until: Date.now() + RESTORE_SETTLE_MS, stuck: 0, timer: null }
  postDebug({ stage: 'restore-start', why: why || '', page: pos.page, frac: Number(pos.frac.toFixed(3)) })
  // 立刻落一次：只排队等定时器的话，用户会先看到第 1 页再被"拽"过去
  applyPosition(target)
  scheduleRestoreTick()
}

/** 排下一次纠偏 */
function scheduleRestoreTick() {
  const r = state.restore
  if (!r) return
  clearTimeout(r.timer)
  r.timer = setTimeout(restoreTick, RESTORE_TICK_MS)
}

/**
 * 纠偏一拍：按**当前**几何再落一次，并决定要不要继续。
 *
 * 刹车有两道：连续两次"落不动"就收手（到底/到顶时再补一万次也不会动，
 * 只会跟用户抢滚动条）；以及最多补 RESTORE_MAX_TRIES 次。
 */
function restoreTick() {
  const r = state.restore
  if (!r) return
  r.timer = null
  r.tries++
  const res = applyPosition(r.pos)
  if (res === 'blocked' || res === 'no-box') r.stuck++
  else r.stuck = 0
  if (r.stuck >= 2) return finishRestore('stuck')
  if (r.tries >= RESTORE_MAX_TRIES) return finishRestore('tries')
  if (Date.now() > r.until) return finishRestore('settled')
  scheduleRestoreTick()
}

/** 布局变了（某页刚渲染完、缩放变了）→ 正在恢复的话按新几何补落一次 */
function restoreOnLayoutChange() {
  if (!state.restore) return
  applyPosition(state.restore.pos)
}

/** 结束这次恢复（自己停下、或用户接管） */
function finishRestore(reason) {
  if (!state.restore) return
  const r = state.restore
  clearTimeout(r.timer)
  state.restore = null
  postDebug({
    stage: 'restore-' + reason, tries: r.tries,
    page: r.pos.page, frac: Number(r.pos.frac.toFixed(3)),
  })
  scheduleSave()      // 落定了再存一次：此刻的位置才是"真的读到这儿"
}

/** 停止正在进行的落位纠偏（用户动手、跳页、换书、换缩放都走它） */
function cancelRestore(why) {
  if (!state.restore) return
  finishRestore('cancelled')
  if (why) postDebug({ stage: 'restore-cancelled-why', why: String(why) })
}

/**
 * 滚动时做的事：把"当前在第几页"跟真实滚动位置对齐。
 *
 * ⚠️ 不在滚动里直接写 storage：滚动一秒能触发几十次，而写 storage 是每本书一整条记录。
 * 落定之后由 finishRestore / scheduleSave 存一次。
 */
function onScroll() {
  updatePageInfo()
  syncTocPosition()
  // 页跟着滚走了，上一处链接的高亮位置已经不对；等下一次 mousemove 再重新算
  clearLinkHover()
  if (state.restore) applyPosition(state.restore.pos)
}

async function loadDocument(bytes, name) {
  state.hash = await sha256Hex(bytes)
  _outlineCache = { hash: '', items: null }   // 换书了，目录缓存作废
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
      renderTask: null, textLayer: null,
      // 链接层：`links` 是这一页所有可点盒子的几何（页内百分比），`linkLayer` 是承载它们的 DOM。
      // 两者都只在页面第一次渲染时建一次（见 buildLinkLayer）。
      links: [], linkLayer: null,
      rendered: false,
    })
  }

  // 恢复上次的进度与译文
  const savedRaw = await loadRecord(state.hash)
  /**
   * 记录校验（2026-11 修）：按内容哈希存的记录里也写着"书名 + 页数"，两者对不上
   * 就说明这条记录不是这本书的（换书、或同一路径的文件被替换过）。
   *
   * 为什么必须校验：自测第二段抓到的正是它 —— 一条 0 条目的记录被当成"这本书的记录"，
   * 刷新之后译文与阅读位置**双双消失**，而盘上明明有一条正确的。
   * 对不上就当没有（随后那次保存会把它覆盖成正确的），并留一条诊断。
   */
  const saved = (savedRaw && sameRecordBook(savedRaw)) ? savedRaw : null
  if (savedRaw && !saved) {
    postDebug({ stage: 'record-mismatch', why: '记录的 name/pages 与当前这本对不上，已忽略',
      recName: savedRaw.name, nowName: state.name, recPages: savedRaw.pages, nowPages: doc.numPages })
  }
  if (saved) {
    if (saved.scale) state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.scale))
    state.entries = Array.isArray(saved.entries) ? saved.entries : []
    // 换了一本书：上一次"拒绝空写"的状态不能带过来（见 saveRecord 的防覆盖）
    state.emptySaveBlocked = false
    state.allowEmptySave = false
    /**
     * 旧记录里的「识别原文」可能是按截图视觉行硬换行的（2026-11 用户实测"一行一句"）。
     * 读回时按新规则整理一次：段内换行接回去、空行保留为分段。
     * 只碰 recognized 的条目——普通译文的换行按原样保留。
     */
    for (const e of state.entries) {
      if (e && e.recognized) {
        e.source = reflowOcrText(e.source)
        e.translation = reflowOcrText(e.translation)
      }
      /**
       * 精译双版本（2026-10-24）：旧记录只有 `precise` 一个布尔值——
       * 那一版把"精译前那份"放在内存里、没落盘，所以读回来时已经找不到了。
       * 这里把 `precise` 迁移成 `preciseText`，`fastText` 留空（没有可切换的另一半，
       * 面板就不会显示切换按钮）；下次再走一遍普通翻译才有两份。
       */
      if (e && e.precise && !e.preciseText) {
        e.preciseText = e.translation || ''
        e.showPrecise = true
      }
      if (e && typeof e.showPrecise !== 'boolean') e.showPrecise = false
    }
    /**
     * 已设成引用的段落（画下划线用）。
     *
     * **先读回上次落盘的那份**，再去接收端刷新（下面的 refreshRefs）：
     * 只靠刷新的话，重启时接收端还没起来就永远空了 —— 那正是"重启后划线全丢、
     * 但引用还在"的成因（引用在侧栏是本地/历史恢复的，不依赖接收端）。
     * 这份是缓存，拉取成功会被覆盖成真值。
     */
    state.refsSeen = Array.isArray(saved.refs) ? saved.refs : []
    /**
     * 引用落在书里的锚点（见 state.refMarks）。
     *
     * 与上面那份清单一起落盘：重启时接收端往往比阅读器晚就绪，那一刻只能靠本地这份
     * 先把书页上的绿线画出来；接收端起来后 refreshRefs 会按真值裁一遍。
     */
    state.refMarks = Array.isArray(saved.refMarks) ? saved.refMarks : []
    state.refsAt = 0
    els.pages.style.setProperty('--total-scale-factor', String(state.scale))
    applyScaleToPlaceholders()
  }
  updateZoomLabel()
  renderEntries()
  renderImageMarks()
  syncNotes()
  // 拉"这本书已引用过哪些段落"（下划线的事实来源）。不 await：打开书不该等网络。
  refreshRefs('open')

  io.disconnect()
  for (const p of state.pages) io.observe(p.wrap)

  /**
   * 回到上次读到的**那一处**（2026-11 二次改版）。
   *
   * 旧版是"60ms 后 gotoPage(saved.page) 一次"：只滚到那一页的**顶端**，
   * 而且那一刻所有页的高度还是按第 1 页估的占位值——页尺寸不一致的 PDF 会明显落错地方。
   * 现在：立刻落到"页 + 页内比例"，之后由渲染完成的回调与几个时间点持续纠偏
   * （见 restorePosition 的注释）。老记录没有 frac → 按 0 处理 = 旧行为，不会把人扔到别处。
   */
  restorePosition(
    saved && saved.page ? { page: saved.page, frac: saved.frac } : null,
    saved && saved.page ? '打开这本书时恢复上次位置' : '没有历史记录',
  )
  // 第一次打开没有历史缩放：直接按窗口宽度铺满，省得每次都要手动点「适宽」
  //（它排在恢复之后：改缩放会改页高，而纠偏会按新几何补落一次）
  if (!saved || !saved.scale) await fitWidth()
  // 顶栏的"第 x / y 页"要立刻有位：不能等用户滚一下才出现
  updatePageInfo()

  toast('已打开：' + state.name + '（' + doc.numPages + ' 页）')
  if (saved && state.entries.length) toast('已恢复 ' + state.entries.length + ' 条译文的原文位置')
}

function closeDoc() {
  const hadBook = hasBook()
  cancelRestore('换书 / 关书')       // 换书时别让上一本的落位纠偏继续拽滚动条
  clearLinkHover()                  // 上一本的链接高亮不能留给下一本
  // 换书 / 回书库时若还停在框选模式：退出来。
  // 不退出的话新书页仍是"框选中"（文字选不中、十字光标），用户会以为新书坏了；
  // 一次性模式框完弹出的动作条也要一并收起（它指的是上一本书里的那一块）。
  endBoxSelect('close')
  hideBoxTip()
  io.disconnect()
  state.doc = null
  state.pages = []
  state.entries = []
  // 换书就换一份"已引用的段落"（下划线按书算，别把上一本的画到这一本上）
  state.refsSeen = []
  // 引用落在书里的锚点同理：那是**上一本**的页内偏移，留下来会把线画到新书的错页
  state.refMarks = []
  state.pendingLocate = null   // 上一本书没画完的跳引用目标，换书后作废
  state.activeId = ''
  state.revealId = ''
  state.revealAt = 0
  state.lastRenderError = null
  state.hash = ''
  els.pages.replaceChildren()
  els.pages.style.setProperty('--total-scale-factor', String(state.scale))
  els.pageinfo.textContent = '—'
  els.scanHint.hidden = true
  clearHighlights()
  renderEntries()
  // 关掉/换掉一本书也要说一声：侧栏据此离开这本书的上下文（否则会停在一本
  // 阅读器里已经关掉的 PDF 上，用户看到"书名还在、但其实没在读"）
  if (hadBook) notifyBookChanged()
}

/**
 * 顶栏的两种样子（2026-11 重做，用户连着报了两轮）。
 *
 * ── 为什么要把这件事收成一个函数 ──────────────────────────────────────────────
 * 原先只有一条 `showPdfChrome(on)` 的布尔开关，而且在里面**顺手把空状态也藏了**；
 * 而 `showLibrary()` 只是把空状态放回来，**从头到尾没碰过工具栏**。
 * 于是从书里点「书库」之后，上一本的书名、「412 页」、「120%」、「框选识别」「译文」
 * 全都留在顶上 —— 用户报的"阅读器顶上的工具栏在书库界面也会全部出现"就是这么来的。
 * 那不是"设计如此"，是这条开关表达不了"我在书库"。
 *
 * ── 用户第二轮又指出三条（都成立，都已改）──────────────────────────────────
 *   ① **"在书库界面为什么还要显示书库"**：我已经在书库里了，这一格是空动作。
 *      → 书库态不再显示 `libraryBtn`。当前在哪儿由状态栏那个词来说（见下）。
 *   ② **"为什么要显示目录"**：目录是**书的内容**的导航（章 / 页）。
 *      书库里没有书，它要么无内容、要么拿着上一本的目录做准备——两样都不对。
 *      → 书库态不再显示 `tocBtn`。（书库列表本身要滚不是理由：列表就在那儿滚。）
 *   ③ **"搞那么多打开 pdf 的按钮是干嘛"**：当时有两个真能用的按钮干同一件事——
 *      顶栏的 `open` 和空状态里的 `openMain`，而它们绑的是**同一句**
 *      `els.file.click()`（见文件末尾的事件接线）。加侧栏那条和菜单那一项，
 *      新用户一眼能看到三四个"打开 PDF"，谁也说不清有什么区别。
 *      → 书库态**只留 `openMain` 一个**（它在书库标题行右端，紧挨着它要影响的那个列表）；
 *        顶栏的 `open` 只在打开书之后出现，那时它才是"再打开一个"的真正入口。
 *
 * ── 一种状态一份清单，不要再回到布尔 ────────────────────────────────────────
 *   library（没打开任何东西）
 *      留下：状态（那格这时显示词"书库"，说明"你在哪儿"，同时本机服务连不上时
 *            由它报错——所以这格不能藏）、空状态里那枚 `openMain`。
 *      藏起来：打开 PDF、书库、目录、书名、页码、缩放、框选识别、适宽、译文。
 *
 *   pdf（在读 PDF）
 *      全都要（含顶栏那枚"打开 PDF"：这时它才是"再打开一个"）。
 *      ⚠️ `openMain`（书库标题行右端那枚按钮）也归本函数管，因为空状态紧跟着它一起显隐
 *      （见下面 setEmptyVisible 的注释）。
 */
const CHROME = {
  library:  ['openMain', 'status'],
  // ⚠️ `fit`（适宽）**故意不在任何清单里**（2026-11 重排）：那一格由"点百分比回适宽"取代，
  // 按钮本身在 HTML 上带着 `hidden`，永远不显示。它在 DOM 里留着，是给快捷键 Ctrl+0
  // 与扩展自检一个显式落点（`els.fit` 仍被绑定）。别顺手加回清单——
  // 加回来 setToolbar 每次跑都会把它 `hidden = false`，那个按钮就又冒出来了。
  pdf:      ['open', 'openMain', 'libraryBtn', 'tocBtn', 'zoomIn', 'zoomOut', 'zoom', 'box', 'notes', 'name', 'status', 'pageinfo'],
}
/** 全部可显隐的工具栏元素（两种状态里出现过的并集），用来先把所有都藏掉再按清单打开 */
const CHROME_ALL = ['open', 'openMain', 'libraryBtn', 'tocBtn', 'zoomIn', 'zoomOut', 'zoom', 'box', 'notes', 'name', 'status', 'pageinfo']

/**
 * 顶栏切到某一态。**只管顶栏**，不碰页面主体（空状态 / 书页）。
 *
 * 这里刻意不"顺手"藏空状态（旧版就是顺手藏的）：那会让"切工具栏"变成
 * "顺手改页面结构"，调用方再想单独控制空状态就没办法了。页面主体另有
 * `setEmptyVisible()`，两件事分开写、各自能读。
 */
function setToolbar(mode) {
  const show = CHROME[mode] || CHROME.pdf
  for (const key of CHROME_ALL) {
    const el = els[key]
    if (el) el.hidden = !show.includes(key)
  }
}

/** 页面主体：书库（空状态）还是书页。与 setToolbar 分开，各管一件事 */
function setEmptyVisible(on) {
  if (els.empty) els.empty.hidden = !on
}

/**
 * 装载时先把顶栏切成书库态（2026-11）。
 *
 * 为什么不靠 HTML 里的 `hidden` 属性：那样规则会分两处（HTML 一处、JS 一处），
 * 改了一处忘了另一处就是"刚打开时多几个死按钮"。这里以 JS 的 CHROME 表为唯一真源，
 * 页面一进来就按它排一次。`?open=` 那条深链会在几毫秒后把顶栏切成 pdf 态，不冲突。
 */
setToolbar('library')

/**
 * 回到书库：清掉上一本的**工具栏残留**，并把状态那格改成"书库"。
 *
 * 为什么状态那格写"书库"：书库态里已经不显示「书库」按钮了（用户问"在书库界面为什么
 * 还要显示书库"——他说得对，那是个空动作）。但顶栏总得回答"我在哪儿"，
 * 于是由这一格来说：平时一个字"书库"，本机服务连不上时它变成错误说明（toolbar 之外的地方
 * 也在用这一格报错，所以它必须留在书库态里）。
 *
 * 不清 `status` 之外的残留就会看到"书库页面上挂着上一本的书名和 120%"——
 * `showLibrary()` 原先只放回空状态就完事，这些一律留在原地。
 */
function resetToolbarText() {
  if (els.name) els.name.textContent = '未打开 PDF'
  if (els.pageinfo) els.pageinfo.textContent = '—'
  if (els.status) { els.status.textContent = '书库'; els.status.style.color = '' }
  closeToc()
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
    /**
     * 链接层（2026-11 补）：PDF 的超链接是页面上的**注释**，不是正文文字，pdf.js 画 canvas
     * 时不会画它、文字层里也没有它。必须自己铺一层可点的盒子，否则那些蓝字只是像素。
     * 先建空层再异步填：读注释不该拖慢正文首屏（见 buildLinkLayer）。
     */
    const links = document.createElement('div')
    links.className = 'rd-links'
    links.hidden = true
    p.wrap.appendChild(links)
    p.linkLayer = links
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
  // 链接层不 await：注释是"有就更好"的一层，读它失败或慢都不该拖住正文
  if (isFirstBuild) buildLinkLayer(p).catch((e) => console.warn('[阅读器] 链接层没铺成（不影响正文）', e))
  p.textChars = pageTextIndex(p.layer).total
  // 画布像素回读（GPU→CPU）不便宜，只在最前面几页做：状态行与"扫描件"判断只需要它
  if (num <= 3) {
    p.canvasInk = canvasInkRatio(p.canvas)
    p.canvasBlank = p.canvasInk < 0.004
  }
  updateScanHint()
  updateStatus()

  refreshHighlights()
  // 这一页刚把占位高度换成真实高度（上面那两行 style.width/height）→ 页序上方的几何变了，
  // 正在恢复位置的话要按新几何补落一次（见 restorePosition 的注释）
  restoreOnLayoutChange()
  if (state.pendingAnchorFlash) {
    const id = state.pendingAnchorFlash
    state.pendingAnchorFlash = ''
    revealEntry(id)
  }
  // 跳引用时这一页还没渲染（见 scrollToAnchor）：现在文字层有了，把那条引用落到精确位置
  if (state.pendingLocate && Number(state.pendingLocate.page) === p.num) {
    const a = state.pendingLocate
    state.pendingLocate = null
    const ok = scrollToAnchor(a)
    postDebug({ stage: 'locate-after-render', page: p.num, ok })
  }
}

// ── 超链接（PDF 注释 /Link）────────────────────────────────────────────────────
//
// 为什么单独有一节：PDF 里的链接**不在正文里**。正文里那段蓝字只是画上去的像素；
// "点了往哪跳"写在页面的**注释**（annotation，PDF 的一种独立对象）里，子类型是 `/Link`。
// pdf.js 画 canvas、抽文字层都不会碰注释 —— 所以这一层必须我们自己铺，
// 否则链接的样子全在，就是点不动（2026-11 用户报的就是这个）。
//
// ⚠️ 这一层是 `pointer-events: none`（见 reader.css），**故意不接鼠标事件**：
//    · 阅读器最主要的动作是划词翻译；链接若盖在文字上，从链接上按下去就选不中字了；
//    · 所以点击改成"按坐标命中"（linkAtPoint），悬停也由 JS 自己算
//      （pointer-events: none 的元素拿不到 :hover）。
//    代价是没有浏览器原生的"右键复制链接地址 / 中键打开"，键盘 Tab + 回车仍然可用。
const pctCss = (v) => (v * 100).toFixed(3) + '%'

/**
 * 把这一页的链接注释铺成可点盒子。**不 await**：注释是"有就更好"的一层，
 * 读它慢或失败都不该拖住正文首屏。
 */
async function buildLinkLayer(p) {
  if (!p || !p.page || !p.linkLayer) return
  let annots = []
  try {
    annots = await p.page.getAnnotations()
  } catch (e) {
    // 只影响"能不能点链接"，正文照样读。不弹提示：坏注释多的 PDF 会每页弹一次
    console.warn('[阅读器] 读第 ' + p.num + ' 页的链接注释失败（正文不受影响）', e)
    return
  }
  // 读注释是异步的：期间用户可能已经换了书 / 关了书，这一页的 DOM 已不在文档里
  if (!p.wrap.isConnected) return
  // 缩放倍率不影响百分比（linkBoxes 里除的就是同一个视口的宽高），所以用哪个视口都行
  const vp = p.viewport || p.page.getViewport({ scale: 1 })
  const frag = document.createDocumentFragment()
  for (const a of annots || []) {
    if (!isLinkAnnotation(a)) continue
    const target = linkTarget(a)
    if (!target) continue          // 附件 / 表单之类：不铺"点了没反应"的死区
    for (const box of linkBoxes(a, vp)) {
      const el = document.createElement('a')
      el.className = 'rd-link'
      el.tabIndex = 0
      el.setAttribute('role', 'link')
      el.style.left = pctCss(box.x)
      el.style.top = pctCss(box.y)
      el.style.width = pctCss(box.w)
      el.style.height = pctCss(box.h)
      const item = { el, ...box, page: p.num, ...target }
      const label = target.kind === 'url' ? target.url
        : target.kind === 'dest' ? '跳到这份 PDF 里的另一处'
        : 'PDF 内部动作：' + target.action
      el.title = label
      el.setAttribute('aria-label', label)
      // 键盘：盒子拿不到鼠标事件，但 Tab 能聚焦，回车/空格要能触发
      el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        ev.stopPropagation()
        activateLink(item)
      })
      p.links.push(item)
      frag.appendChild(el)
    }
  }
  if (!p.links.length) return
  p.linkLayer.appendChild(frag)
  p.linkLayer.hidden = false
}

/** 视口坐标 → 落在哪一条链接上（只用百分比算，不依赖 DOM 命中） */
function linkAtPoint(clientX, clientY) {
  for (const p of state.pages) {
    const links = p.links
    if (!links || !links.length) continue
    const r = p.wrap.getBoundingClientRect()
    if (!(r.width > 0) || !(r.height > 0)) continue
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue
    const hit = linkAt(links, (clientX - r.left) / r.width, (clientY - r.top) / r.height)
    if (hit) return hit
  }
  return null
}

let _linkHot = null           // 此刻高亮着的那个盒子
let _linkHotRaf = 0
const _linkPointer = { x: 0, y: 0 }

function clearLinkHover() {
  // 排着的那一帧也要撤掉：否则鼠标刚移开，它会把高亮又加回来
  if (_linkHotRaf) {
    cancelAnimationFrame(_linkHotRaf)
    _linkHotRaf = 0
  }
  if (_linkHot) {
    _linkHot.el.classList.remove('is-hot')
    _linkHot = null
  }
  els.pages.classList.remove('is-link-hover')
}

/** 悬停：mousemove 一秒几十次，命中压到一帧一次；只在高亮目标变化时动 DOM */
function onPageLinkHover(ev) {
  if (state.boxMode || state.boxChoice) { clearLinkHover(); return }
  _linkPointer.x = ev.clientX
  _linkPointer.y = ev.clientY
  if (_linkHotRaf) return
  _linkHotRaf = requestAnimationFrame(() => {
    _linkHotRaf = 0
    const hit = linkAtPoint(_linkPointer.x, _linkPointer.y)
    if (hit === _linkHot) return
    if (_linkHot) _linkHot.el.classList.remove('is-hot')
    _linkHot = hit
    if (hit) hit.el.classList.add('is-hot')
    els.pages.classList.toggle('is-link-hover', !!hit)
  })
}

function onPageLinkClick(ev) {
  if (state.boxMode || state.boxChoice) return
  if (ev.button !== 0 || ev.detail > 1) return       // 双击的第二下不重复跳
  const sel = window.getSelection()
  // 这次是在划词（有选区）→ 不抢：链接可以再点一下
  if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) return
  const hit = linkAtPoint(ev.clientX, ev.clientY)
  if (!hit) return
  ev.preventDefault()
  ev.stopPropagation()      // 别让 document 上"点已翻过的译文"那一下也跟着触发
  clearLinkHover()
  activateLink(hit)
}

function activateLink(link) {
  if (!link) return
  if (link.kind === 'url') { openExternalUrl(link.url); return }
  if (link.kind === 'dest') {
    jumpToPdfDest(link.dest).catch((e) => {
      toast('这个链接跳不过去：' + ((e && e.message) || e), true)
    })
    return
  }
  if (link.kind === 'action' && !runPdfNamedAction(link.action)) {
    toast('这个链接用的是 PDF 内部动作「' + link.action + '」，阅读器还不支持', true)
  }
}

/**
 * 跳到文档内目标（注释里的 `dest`）。目标可能是命名字符串，也可能是数组；
 * 数组的第一项是**页对象的引用**，要用 `getPageIndex` 换算成页号。
 * 纵向位置能算就算（见 reader-links.js 的 destTop），算不出就跳页顶。
 */
async function jumpToPdfDest(dest) {
  let d = dest
  if (typeof d === 'string') d = await state.doc.getDestination(d)
  if (!Array.isArray(d) || !d.length) throw new Error('文档里没有这个目标')
  let page = 0
  try {
    page = (await state.doc.getPageIndex(d[0])) + 1
  } catch (e) {
    page = 0
  }
  if (!(page >= 1 && page <= bookTotal())) throw new Error('目标页不在文档范围内')
  let frac = 0
  const top = destTop(d)
  if (top !== null) {
    try {
      const pg = (state.pages[page - 1] && state.pages[page - 1].page) || await state.doc.getPage(page)
      const vp = pg.getViewport({ scale: state.scale })
      const y = vp.convertToViewportPoint(0, top)[1]
      if (Number.isFinite(y) && vp.height > 0) frac = clamp01(y / vp.height)
    } catch (e) {}
  }
  gotoPage(page, false)
  if (frac > 0) applyPosition({ page, frac })
}

/** PDF 的"命名动作"里只有翻页几种是能就地执行的；其余（GoBack / Find…）如实说不行 */
function runPdfNamedAction(name) {
  switch (String(name || '')) {
    case 'NextPage': gotoPage(currentPage() + 1); return true
    case 'PrevPage': gotoPage(currentPage() - 1); return true
    case 'FirstPage': gotoPage(1); return true
    case 'LastPage': gotoPage(bookTotal()); return true
    default: return false
  }
}

/** 外部链接一律开新标签：在阅读器这一页里跳走，等于把正在读的书关掉 */
function openExternalUrl(url) {
  const tabs = (typeof chrome !== 'undefined' && chrome.tabs) ? chrome.tabs : null
  if (tabs && typeof tabs.create === 'function') {
    try {
      const p = tabs.create({ url, active: true })
      if (p && typeof p.catch === 'function') p.catch(() => window.open(url, '_blank', 'noopener'))
      return
    } catch (e) {}
  }
  window.open(url, '_blank', 'noopener')   // 自测页（没有 chrome.tabs）走这条
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

/**
 * 工具栏上的渲染状态（2026-11 改：**平时不显示，只在出问题时说话**）。
 *
 * 为什么改：原先它常年占着顶栏中间那一格，显示"已渲染 3/311 页 · 首页文字 412 字 ·
 * 首页墨迹 99.2%"这类数字。那些数字只在**排查渲染问题**时有用，日常阅读时
 * 它只是把顶栏塞得更乱（用户："一堆乱七八糟的东西"）。
 * 现在：
 *   · 正常 → 那一格空着（`hidden`），顶栏少一个东西；
 *   · 出问题（某页渲染失败 / 首页画布画出来是空白）→ 才显示，并且是"有事"的语气；
 *   · 详细的那些数字不删，改挂到 title 上——鼠标停上去还能看到，
 *     排查时照样有（自检与我看日志都靠它）。
 */
function updateStatus() {
  if (!els.status) return
  if (!state.doc) { els.status.hidden = true; els.status.textContent = ''; return }
  const rendered = state.pages.filter((p) => p.rendered).length
  const first = state.pages[0]
  const charsOfFirst = first && first.rendered ? first.textChars : null
  const parts = ['已渲染 ' + rendered + '/' + state.doc.numPages + ' 页']
  if (charsOfFirst !== null) parts.push('首页文字 ' + charsOfFirst + ' 字')
  if (first && first.canvasBlank) parts.push('首页画布空白')
  else if (first && first.canvasInk !== undefined) {
    parts.push('首页墨迹 ' + (first.canvasInk * 100).toFixed(1) + '%')
  }
  els.status.title = parts.join(' · ')   // 详情挂 title：平时不占地方，排查时看得到
  if (state.lastRenderError) {
    els.status.hidden = false
    els.status.textContent = '第 ' + state.lastRenderError.page + ' 页渲染失败：' + state.lastRenderError.message
    els.status.style.color = '#9a3b3b'
    return
  }
  // 正常状态不再常驻；只有"首页画布是空白"这种值得用户知道的异常才冒头
  if (first && first.canvasBlank) {
    els.status.hidden = false
    els.status.textContent = '首页画布是空白（可能是扫描件或渲染异常）'
    els.status.style.color = '#9a5b00'
    return
  }
  els.status.hidden = true
  els.status.textContent = ''
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

/**
 * 选区（可能横跨多页）→ 一段连续原文。
 *
 * 页与页之间**不留换行**（2026-11 用户实报：跨页引用之后，条目里的原文还带着换行）。
 * 跨页的那一句本来就是一句话，接法与页内换行完全相同 —— 交给 joinSlices：
 * 英文补一个空格、行尾连字符断词直接接、中文之间不加空格。
 */
function anchorsText(anchors) {
  const parts = []
  for (const a of anchors) {
    const layer = state.pages[a.page - 1] && state.pages[a.page - 1].layer
    if (!layer) continue
    const t = textFromOffsets(layer, a.start, a.end)
    if (t) parts.push(t)
  }
  return joinSlices(parts)
}

/**
 * 这一页"补过词间空格"的修正；不需要补 / 补不了 → null。每页只算一次（p.spaceFix 缓存）。
 *
 * 现状（2026-11 实测）：pdf.js 抽文字时会把 PDF 里的空格字形吃掉，只在它"猜"到这里
 * 有个空格时才补回来（见 reader-anchor.js 里 restoreItemSpaces 的说明）。那本 311 页的
 * 《A Clinical Introduction to Lacanian Psychoanalysis》就几乎全部猜不中，于是划词翻译
 * 送到对照栏与模型手里的原文是 "hoiswidelyrecognizedastheforemostinterpreterof…"。
 *
 * 两项开销（实测 2026-11，同一本书）：getTextContent ≈ 6ms/页、getOperatorList ≈ 13ms/页。
 * 所以先用 looksSpaceStarved 判"有没有嫌疑"——正常 PDF（如 extension/test/sample.pdf）
 * 一次多余的解析都不会发生；有嫌疑也只按页算一次。
 *
 * `p.spaceFix === undefined` 表示没算过；`null` 表示算过、但不需要或补不了。
 */
async function spacedPage(p) {
  if (p.spaceFix !== undefined) return p.spaceFix
  p.spaceFix = null
  try {
    const tc = await p.page.getTextContent()
    const items = (tc.items || []).filter((it) => it && typeof it.str === 'string' && it.str)
    if (!items.length) return null
    if (!looksSpaceStarved(items.map((it) => it.str).join(''))) return null
    const opList = await p.page.getOperatorList()
    const glyphs = glyphTextFromOps(opList.fnArray, opList.argsArray, pdfjsLib.OPS)
    const fix = spacedPageFix(p.layer, items, glyphs)
    // 一个空格都没补上（那页本来就正常）就不留缓存：行为与改动前逐字一致
    if (fix && fix.inserted.some((x) => x.length)) p.spaceFix = fix
  } catch (e) {
    console.warn('[阅读器] 复原词间空格失败，改用 pdf.js 原样文字', e)
  }
  return p.spaceFix
}

/**
 * 选区 → 送去翻译/复制的原文（anchorsText 的加强版）。
 *
 * 唯一区别：碰上"词间空格被 pdf.js 吞了"的 PDF 就把空格补回来；补不了（对齐不上、
 * 拿不到绘图指令、页面还没渲染）一律退回 anchorsText 的原样文字 —— 宁可少补，不可乱补。
 */
async function sourceText(anchors) {
  const raw = anchorsText(anchors)
  if (!looksSpaceStarved(raw)) return raw
  const parts = []
  for (const a of anchors) {
    const p = state.pages[a.page - 1]
    if (!p || !p.layer) continue
    const fix = await spacedPage(p)
    const t = fix
      ? textFromSpacedOffsets(p.layer, fix, a.start, a.end)
      : textFromOffsets(p.layer, a.start, a.end)
    if (t) parts.push(t)
  }
  // 跨页同样是"接成一句"，不是"一行一页"（同 anchorsText）
  return joinSlices(parts) || raw
}

/**
 * 这次选区对应的原文。
 *
 * 统一从这一个入口取：`sourceText` 会顺带把"词间空格被 pdf.js 吞了"的那类 PDF 补回空格，
 * 所以别在调用点各判一次。
 */
async function textOfSelection(hit) {
  if (!hit) return ''
  return await sourceText(hit.anchors || [])
}

/**
 * 把 OCR 读回来的原文按段落整理一下换行（2026-11 用户实测：识别原文在窄栏里一行一句）。
 *
 * 为什么需要它：OCR prompt 以前要求"保留原有的段落与换行"，模型就会照着**截图的行宽**
 * 硬换行。扫描件一页几十行，中文又常常一行十几个字，丢进侧栏那种窄卡片里就变成
 * 一行一句、参差不齐；既不像文章，也不方便读。
 *
 * 整理规则（只动换行，不动字）：
 *   · 空行 = 段落分隔，保留；
 *   · 段内换行接回去 —— 中文接中文不加空格、英文加空格、行尾连字符断词直接接，
 *     全部复用 PDF 文字层那套 joinLines（同一个问题只该有一份规则）。
 *
 * 边界：只吃单换行/空行；模型若把两段用**单个**换行隔开，这里认不出来，会接成一段。
 * 所以 RECOGNIZE_PROMPT 里明确要求"段落之间空一行"。
 */
function reflowOcrText(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!s) return ''
  return s
    .split(/\n[ \t]*\n+/)          // 空行 = 段落
    .map((para) => joinLines(para.split('\n')))
    .filter(Boolean)
    .join('\n\n')
}

// ── 划线附近的原文（随引用交给共读侧）─────────────────────────────────────────
/**
 * 每条引用最多带多少"附近原文"：划线**前后各 300 字**。
 *
 * 为什么是 300：跟微信读书那条路对齐。agent 在微读那边就是拿划线原文去章节正文里定位、
 * 取前后各 300 字（agent/index.js 的 chapterWindow）；PDF 没有章节正文（`chapters\` 是空的），
 * 所以这份上下文只能由阅读器自己带上去。
 */
const CTX_BEFORE = 300
const CTX_AFTER = 300
/** 页面文字太短时往前/往后最多各看几页（补足上面那 300 字用） */
const CTX_PAGE_SPAN = 2

/**
 * 一页的"可切文字"：拿到就能按页内偏移切一段可读原文。
 *
 * 两种取法，**切法**（行间补空格、行尾断词、吞空格的修正）全部交给 reader-anchor.js，
 * 这里只决定用哪一份：
 *   · 已渲染 → 用文字层（与划线锚点同一套坐标，空格修正还带"与文字层逐字一致"的校验）
 *   · 没渲染 → 现问 pdf.js 要一份（不建 DOM、不画 canvas，只取文字；同样跑空格修正，
 *     只是少了那道校验 —— items 与真字流出自同一次 getTextContent，不存在错位）
 * 两个方向都只**读**，不碰 canvas 与文字层。
 */
async function pageTextOf(p) {
  if (p.layer && p.rendered) {
    const fix = await spacedPage(p)
    return {
      total: pageTextIndex(p.layer).total,
      slice: (a, b) => (fix ? textFromSpacedOffsets(p.layer, fix, a, b) : textFromOffsets(p.layer, a, b)),
    }
  }
  const page = p.page || await state.doc.getPage(p.num)
  p.page = page
  const tc = await page.getTextContent()
  const items = (tc.items || []).filter((it) => it && typeof it.str === 'string' && it.str)
  let total = 0
  for (const it of items) total += it.str.length
  let fix = null
  if (looksSpaceStarved(items.map((it) => it.str).join(''))) {
    try {
      const opList = await page.getOperatorList()
      fix = spacedPageFix(null, items, glyphTextFromOps(opList.fnArray, opList.argsArray, pdfjsLib.OPS))
    } catch (e) {
      console.warn('[阅读器] 附近原文的空格修正失败（只用原样文字）', e)
    }
  }
  return {
    total,
    slice: (a, b) => joinLines(fix ? linesFromFixedItems(fix, a, b) : linesFromItems(items, a, b)),
  }
}

/** 某一页的可切文字；拿不到（没有页对象、pdf.js 抛错）返回 null，让调用方少一段而不是报错。 */
async function pageTextAt(num) {
  const p = state.pages[num - 1]
  if (!p) return null
  try {
    return await pageTextOf(p)
  } catch (e) {
    console.warn('[阅读器] 取第 ' + num + ' 页文字失败（附近原文会短一点）', e)
    return null
  }
}

/**
 * 划线附近的原文：以划线所在页为中心，**前后各取 CTX_BEFORE / CTX_AFTER 字**，跨页自动补齐。
 *
 * 为什么要有它（2026-11）：agent 在微信读书那条路上拿得到"划线 + 前后各 300 字"
 * （章节正文被上传过），PDF 这条路拿不到 —— 于是 prompt 里只有划线那一句，
 * 后面跟着"（暂无这本书的原文足迹…）"。这段文字随引用一起报上去，由 agent 在用不上
 * 章节正文时使用（见 agent/lib/annotation-context.js）。
 *
 * 分工：**取哪几页、每页取哪一段**由 reader-anchor.js 的 planContextWindow 算
 * （纯函数、有单测），这里只负责把要用的页的文字取回来、按那个计划切出来。
 *
 * 边界都当"没有"处理：扫描件没有文字层、页对象缺失、pdf.js 抛错 → 返回空串。
 * **宁可没有上下文，不可给错上下文**。
 */
async function contextAround(anchors) {
  const list = (Array.isArray(anchors) ? anchors : []).filter(
    (a) => a && Number.isFinite(a.page) && Number.isFinite(a.start) && Number.isFinite(a.end),
  )
  if (!list.length) return ''
  const srcs = new Map()
  const prime = async (num) => {
    if (srcs.has(num) || num < 1 || num > state.pages.length) return
    const src = await pageTextAt(num)
    if (src) srcs.set(num, src)
  }
  try {
    for (const a of list) await prime(a.page)

    // 额度不够时才去取邻页（首段离页首不足 before、末段离页尾不足 after），最多各 CTX_PAGE_SPAN 页。
    // 为什么不"一律多取前后各一页"：每多取一页就多一次 getTextContent（实测 ≈6ms/页；
    // 需要补词间空格时还要 getOperatorList ≈13ms），能不取就不取。
    const first = list[0]
    const last = list[list.length - 1]
    let lo = first.page
    let hi = last.page
    for (let k = 0; k < CTX_PAGE_SPAN; k++) {
      const headShort = first.start < CTX_BEFORE && lo > 1
      const lastSrc = srcs.get(hi)
      const tailShort = !!lastSrc && lastSrc.total - last.end < CTX_AFTER && hi < state.pages.length
      if (!headShort && !tailShort) break
      if (headShort) await prime(--lo)
      if (tailShort) await prime(++hi)
    }

    const plan = planContextWindow(list, (n) => {
      const src = srcs.get(n)
      return src ? src.total : null
    }, { before: CTX_BEFORE, after: CTX_AFTER, span: CTX_PAGE_SPAN })

    const parts = []
    for (const s of plan) {
      const src = srcs.get(s.page)
      const text = src && src.slice(s.from, s.to)
      if (text) parts.push(text)
    }
    // 页与页之间不留换行，理由同 anchorsText：这份"附近原文"有时就是 agent 眼里的
    // 这段原文（见 agent/lib/ref-source.js 的 refSourceOf），跨页处凭空多一个换行
    // 会跟着它被引回来。
    return joinSlices(parts)
  } catch (e) {
    console.warn('[阅读器] 组装划线附近原文失败（这条引用会不带上下文）', e)
    return ''
  }
}

function onSelectionSettled() {
  /**
   * 框选模式 / 框选动作条还开着时，不弹划词浮标。
   *
   * 为什么需要这一条：进入框选前若已经有一段选区，它可能还留在页面上；框选那一拖结束后，
   * 这里会被 mouseup 再叫一次，把「翻译 / 设为引用 / 复制」浮标叠到框选动作条上。
   * 两条动作条同时出现，用户不知道该点哪一条。
   */
  if (state.boxMode || state.boxChoice) { hideTip(); return }
  const hit = selectionAnchors()
  if (!hit) { hideTip(); return }
  state.lastSelection = hit
  showTipAt(hit.range)
}

/**
 * 把一条动作条摆到 rect 上方（上方放不下就摆到下方）。
 * 划词浮标与框选动作条共用这一份：位置算法只该有一处，否则迟早一条对一条错。
 */
function placeTipAt(node, rect) {
  node.hidden = false
  // 先显形再量尺寸（hidden 时 offsetWidth 恒为 0，量出来会把位置算错）
  const w = node.offsetWidth || 120
  const h = node.offsetHeight || 32
  let left = rect.left + rect.width / 2 - w / 2
  let top = rect.top - h - 8
  if (top < 8) top = rect.bottom + 8
  // 纵向上也夹进视口：框很大时"摆到框下方"会掉出屏幕（框选动作条尤其容易）
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top))
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
  node.style.left = left + 'px'
  node.style.top = top + 'px'
}

function showTipAt(range) {
  const rect = range.getBoundingClientRect()
  if (!rect || (!rect.width && !rect.height)) { hideTip(); return }
  els.tipTranslate.textContent = '翻译'
  els.tipTranslate.title = '翻译选中的这段'
  // PDF 这条路原先只有翻译与复制，想只引不翻的人没有入口（2026-11 用户要求补上）。
  if (els.tipRef) els.tipRef.hidden = false
  placeTipAt(els.tip, rect)
}

/**
 * 撤掉页面上的文字选区。
 *
 * 为什么要有它：划完词就翻完了，留着那段蓝色选区既碍眼，又会挡住"点已翻过的区域
 * 打开译文对照"这个动作（点击被当成继续选字）。见 translateSelection 的调用点。
 */
function clearSelection() {
  try {
    const sel = window.getSelection()
    if (sel && sel.removeAllRanges) sel.removeAllRanges()
  } catch (e) {}
}

function hideTip() { els.tip.hidden = true }

/**
 * 送给模型的书名：去掉 .pdf 与下载站的尾巴。
 *
 * 书名只用来给模型一个"这是什么书"的先验（哲学 / 历史 / 小说），所以不该让
 * 「-- b3976acf… -- Anna's Archive」这种文件名噪声占上下文 —— 模型还可能把哈希当成正文。
 * 取不到书名就给空串，少了它不影响翻译。
 */
function bookNameForModel() {
  return String(state.name || '')
    .replace(/\.pdf$/i, '')
    .replace(/\s*--\s*[0-9a-f]{16,}\s*--\s*.*$/i, '')
    .trim()
}

async function translateSelection() {
  const hit = state.lastSelection || selectionAnchors()
  if (!hit) {
    toast('请先划选原文，再按 Alt+T', true)
    return
  }
  // 同一段再翻一次不该多出一条
  const dup = findDuplicate({ kind: 'text', anchors: hit.anchors })
  if (dup && reuseDuplicate(dup)) { hideTip(); return }

  const source = await textOfSelection(hit)
  if (!source.trim()) { toast('未获取到可翻译的文字', true); return }
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

  const res = await callBackground({
    action: 'translateText',
    text: source,
    source: 'selection',
    fromOcr: false,               // PDF 文字层抽出来的原文，没有识别误差
    bookTitle: bookNameForModel(),
  })
  entry.pending = false
  if (!res || !res.ok) {
    entry.error = (res && res.error && res.error.message) || '翻译失败'
    renderEntries()
    toast('翻译失败：' + entry.error, true)
    return
  }
  entry.source = source
  entry.translation = (res.data && res.data.translation) || ''
  // 这一份是「快速版」的基线：之后精译时把它存进 fastText，两版就能来回切
  entry.fastText = entry.translation
  entry.preciseText = ''
  entry.showPrecise = false
  entry.error = ''
  renderEntries()
  refreshHighlights()
  // 刚翻完的这段就在用户眼前，**不要**去滚动书页（会把正在看的位置挪走），
  // 只把它设为当前、把对照栏里那一条滚进视野
  focusEntry(entry.id)
  scheduleSave()
}

/**
 * 划词「设为引用」：不翻译，直接把选中的原文交给共读侧（2026-11 用户要求）。
 *
 * 两个分支：
 *   ① 这段**已经翻过** → 引用带上译文（用户读的是译文），与译文面板的「设为引用」一致
 *   ② 没翻过 → 把原文当引用身份报上去；translation 留空，侧栏按 refDisplayText 回落显示原文
 *
 * 成功之后**把侧栏切回对话界面**（2026-11 用户要求）：设引用的下一步一定是提问，
 * 停在译文对照里还得自己点「返回」。这与译文面板里点「设为引用」的行为一致（见
 * reader-notes.js 的 makeReference），连那 200ms 的等待理由也相同。
 *
 * 上下文照旧带 `contextAround`：PDF 没有章节正文可查，agent 只有这一份。
 */
async function referenceSelection() {
  const hit = state.lastSelection || selectionAnchors()
  if (!hit) {
    toast('请先划选一段正文', true)
    return { ok: false, error: { message: '没有选中文字' } }
  }

  // 已经翻过（且翻完了）：直接复用译文条目，别让用户为了设引用再等一次翻译
  const dup = (hit.anchors && hit.anchors.length)
    ? findDuplicate({ kind: 'text', anchors: hit.anchors })
    : null
  if (dup && dup.translation && !dup.pending) {
    const r = await setAsReference(dup)
    if (r && r.ok) {
      hideTip()
      clearSelection()
      showChatAfterReference()
    }
    return r
  }

  const source = String(await textOfSelection(hit)).trim()
  if (!source) {
    toast('未获取到可引用的文字', true)
    return { ok: false, error: { message: '没有可引用的原文' } }
  }
  const context = await contextAround(hit.anchors || [])
  let res
  try {
    res = await callBackground({
      action: 'setTranslationRef',
      original: source,
      // 不翻译：不传 translation。侧栏的 refDisplayText 会回落到 selectedText（原文）
      ...(context ? { context } : {}),
      url: 'reader://' + state.hash + (state.name ? '#' + state.name : ''),
      pageTitle: state.name,
      bookId: readerBookId(state.hash),
      bookTitle: state.name || '',
    })
  } catch (e) {
    res = { ok: false, error: { message: String((e && e.message) || e) } }
  }
  if (res && res.ok) {
    toast('已设为引用')
    hideTip()
    clearSelection()
    // 记下这段（给译文面板画"已经引过了"的下划线，见 refsSeen / noteRefLocal）。
    // translation 留空：这一条引用没有译文，卡片显示的就是原文。
    // anchors 必须带上：它是"书页上那道绿线画在哪"的唯一依据（见 noteRefMark）。
    rememberRef({ source, translation: '', kind: 'text', anchors: hit.anchors }, '')
    showChatAfterReference()
  } else {
    toast('设为引用失败：' + ((res && res.error && res.error.message) || '原因未知'), true)
  }
  return res || { ok: false }
}

// ── 框选识别 / 翻译（扫描件 / 图片页）──────────────────────────────────────────
// 图片页里没有文字节点，Range 与 Custom Highlight 都用不上。所以这条路是：
// 在页面上拖一个框 → 把框里的画布像素裁出来 → 交给模型读图（识别原文 / 翻译）。
// 位置记成「页内比例」，与文字锚点一样与缩放无关（PDF 版式固定，比例永远成立）。
/**
 * 框选模式：**工具栏那枚按钮是切换式的，快捷键 Alt+S 仍是一次性的**（2026-11 用户要求）。
 *
 * ── 为什么两套语义并存（有意为之，别再"统一"掉）──────────────────────────────
 * 这个功能来回改过两次，两次的理由都是真的：
 *   ① 最初是切换式 → 痛点：忘了退出时**划词会被框选拦掉**，用户以为"选不中字了"；
 *   ② 改成一次性（按一次框一次、框完自动退）→ 但扫描件常要连着框好几处，
 *      每处都得回顶栏点一下（用户这次提的正是这个）；
 *   ③ 现在：**按钮切换 + 快捷键一次性**。
 * 既然切换式的老毛病是"忘了自己在框选模式"，那就让它**一直看得见**：
 * 只要在模式里，页面顶部常驻一条 `框选识别 · 拖出选区 · Esc 退出`（见 els.boxBar）。
 * 那条横在正文上方，划词被拦时用户一眼就知道为什么，不会再以为界面坏了。
 *
 * ⚠️ Alt+S 保持一次性：快捷键是"来一下就走"的手势，按完还要再按一次才退出反而别扭。
 */
function startBoxSelect(opts) {
  if (!state.doc) { toast('请先打开 PDF', true); return }
  /**
   * `oneShot`：框完一处就自动退出。只有快捷键（Alt+S）用它——
   * 快捷键是"来一下就走"的手势。工具栏那枚按钮不带这个标记：
   * 它是切换式的，框完继续留在模式里，方便扫描件连着框好几处。
   */
  state.boxOneShot = !!(opts && opts.oneShot)
  // 重新进入 / 再按一次 Alt+S：上一块还没选动作的框作废（它已经不代表"这次要框的"了）
  hideBoxTip()
  // 进入框选时把上一次可能残留的文字选区撤掉：否则它会跟着带到框选动作条那一步，
  // 鼠标一松就再弹一个划词浮标（见 onSelectionSettled 的那道闸）
  clearSelection()
  hideTip()
  if (state.boxMode) return
  state.boxMode = true
  // 框选模式里不显示"这里有链接"的手型与高亮：这时鼠标是在选框，不是要点链接
  clearLinkHover()
  applyBoxModeChrome()
  toast(state.boxOneShot
    ? '在页面上拖出选区，再选「识别原文」或「翻译」（完成后自动退出，Esc 取消）'
    : '框选识别：拖出选区，再选「识别原文」或「翻译」 · Esc 或再点一次退出')
}

/** 开关（工具栏那枚按钮用）：在模式里就退出，不在就进入 */
function toggleBoxSelect() {
  if (state.boxMode) endBoxSelect('toggle')
  else startBoxSelect()
}

/**
 * 框选模式的界面状态：按钮高亮 + 页面上那条常驻提示。**进出两条路都走这里**——
 * 否则"点按钮退出"和"按 Esc 退出"会漏掉一处（按钮还亮着、提示条还挂着，看着像卡住）。
 */
function applyBoxModeChrome() {
  if (els.box) {
    els.box.classList.toggle('is-on', state.boxMode)
    els.box.setAttribute('aria-pressed', state.boxMode ? 'true' : 'false')
    els.box.textContent = state.boxMode ? '框选中' : '框选识别'
    els.box.title = state.boxMode
      ? '正在框选：在页面上拖出选区（点这里或按 Esc 退出）'
      : '进入框选识别：在页面上拖出选区，再选「识别原文」或「翻译」（Alt+S 来一下就走）'
  }
  if (els.boxBar) els.boxBar.hidden = !state.boxMode
  if (els.pages) els.pages.classList.toggle('is-boxing', state.boxMode)
}

function endBoxSelect(reason) {
  if (!state.boxMode) return
  state.boxMode = false
  applyBoxModeChrome()
  if (state.boxDrag) {
    try { state.boxDrag.marquee.remove() } catch (e) {}
    state.boxDrag = null
  }
  // 一次性（done）要留着刚弹出的动作条让人选；主动退出（Esc / 再点一次）则一并收起
  if (reason !== 'done') hideBoxTip()
  if (reason === 'esc') toast('已退出框选模式')
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
  // 上一块还没选动作就又拖了新框：旧动作条作废（它指的是上一块）
  hideBoxTip()
  hideTip()

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
    /**
     * 框**保留**到用户选完动作为止（2026-11 用户实测：松手就把框删掉，界面上只剩动作条，
     * 用户不知道自己框的是哪一块；要等选了翻译 / 引用、生成了 .rd-mark 才重新看见）。
     * 所以这里不再无条件 d.marquee.remove()：有效框交给 showBoxTip 接管，hideBoxTip 收尾；
     * 没拖出有效框（只是点了一下）才当场清掉。
     */
    /**
     * 框完**不一定退出**（2026-11 改）：
     *   · 一次性（Alt+S）→ 退出，符合"来一下就走"；
     *   · 切换式（工具栏按钮）→ **留在模式里**，接着框下一处。
     * 原先无条件 endBoxSelect('done')：那次改动是为了治"忘了退出"，现在由
     * 页面上常驻的那条提示条负责提醒（见 applyBoxModeChrome）。
     */
    if (state.boxOneShot) endBoxSelect('done')
    if (d.moved && d.rect) {
      /**
       * 原先这里直接 translateRegion（一松手就翻）。2026-11 起先弹动作条：
       * 用户要的是一个「识别原文」的入口，而模型调用不该在用户还没选时就先花掉。
       * 框还在页面上（位置记成页内比例），选「识别原文」走 OCR、选「翻译」才裁图送模型。
       */
      showBoxTip(d.pageEl, d.rect, d.marquee)
    } else {
      d.marquee.remove()
    }
  }
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mouseup', up, true)
}

/**
 * 框选拖完后的动作条：翻译，还是只识别原文（2026-11）。
 *
 * 为什么先问一句：框选原先一松手就翻译，扫描件用户想"只要原文、不想翻"时不得不先等一次
 * 翻译、再去译文栏里处理——多花一次模型调用，多等一段。
 * 这里只摆选择，不预先裁图；选「翻译」才走 translateRegion，选「识别原文」才走
 * recognizeRegionText。
 *
 * ⚠️ 「识别原文」不再自动设引用（2026-11 用户定调）：它只把原文放进译文栏，
 * 之后由用户在卡片上决定「翻译」还是「设为引用」。
 *
 * `marquee` = 拖拽时留在页面上的那个框。它**不删**，由 state.boxChoice 接管，
 * 让用户在选动作时一直看得见"我框的是哪一块"；hideBoxTip 时才一起收掉。
 */
function showBoxTip(pageEl, frac, marquee) {
  const num = Number(pageEl && pageEl.dataset.page)
  const p = state.pages[num - 1]
  if (!p || !p.canvas || !p.wrap) {
    if (marquee) { try { marquee.remove() } catch (e) {} }
    toast('本页尚未渲染完成，请稍后重试', true)
    return
  }
  // 上一块如果还没收尾（正常不会走到，onBoxStart 已经收过），别把两个框叠在一起
  if (state.boxChoice) hideBoxTip()
  state.boxChoice = { page: num, frac: { x: frac.x, y: frac.y, w: frac.w, h: frac.h }, marquee: marquee || null }
  const pr = p.wrap.getBoundingClientRect()
  const rect = {
    left: pr.left + frac.x * pr.width,
    top: pr.top + frac.y * pr.height,
    width: Math.max(1, frac.w * pr.width),
    height: Math.max(1, frac.h * pr.height),
  }
  placeTipAt(els.boxTip, rect)
  // 文本框与框选动作条不该同时出现：用户此刻是在给刚拖出来的框选动作
  hideTip()
}

function hideBoxTip() {
  if (els.boxTip) els.boxTip.hidden = true
  // 待选动作的那块框跟着动作条一起收掉（选中动作时它会被真正的 .rd-mark 接替）
  const c = state.boxChoice
  if (c && c.marquee) { try { c.marquee.remove() } catch (e) {} }
  state.boxChoice = null
}

/** 动作条上的两个按钮共用：取走待处理的框，再交给对应的那条路。 */
function runBoxChoice(kind) {
  const c = state.boxChoice
  hideBoxTip()
  if (!c) return
  const p = state.pages[c.page - 1]
  if (!p || !p.wrap) { toast('这一页已经不在视图里了，请重新框选', true); return }
  if (kind === 'recognize') recognizeRegionText(p.wrap, c.frac)
  else translateRegion(p.wrap, c.frac)
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
  if (!p || !p.canvas) { toast('本页尚未渲染完成，请稍后重试', true); return }
  if (frac.w < 0.01 || frac.h < 0.005) { toast('选区过小，请重新框选', true); return }

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
  // 这块原先可能只是"识别原文"（框选识别原文那条路），现在有真译文了：
  // 面板上的"只识别了原文"提示要撤掉（见 reader-notes.js 的 .rn-note）
  entry.recognized = false
  entry.recognizing = false
  renderEntries()
  focusEntry(entry.id)
  scheduleSave()
}

/**
 * 框选「识别原文」：只识别原文，**不翻译、也不自动设引用**（2026-11 用户定调）。
 *
 * 图片页没有文字层，所以先用模型把框里的字识别出来，然后按用户说的
 * "直接把原文放进译文栏"：
 *   · 建一条图片条目，source/translation 都放识别结果；
 *   · 面板上标一句"只识别了原文，未翻译"（recognized），并给一个「翻译」按钮；
 *   · **不**调用 setAsReference —— 引不引用由用户在卡片上自己决定（卡片本来就有
 *     「设为引用」按钮，点了才会切回对话界面）。
 *
 * 为什么 translation 也放原文：译文栏那张卡的正文读的就是 translation。若留空，
 * 用户只看到一张空白卡片；此刻要展示的就是识别出的原文。用户点「翻译」之后，
 * retranslateEntry 会用真译文覆盖它并清掉 recognized。
 *
 * 同一块已经识别 / 已经翻过 → 直接把它设为当前并露出那张卡，不再花一次模型调用。
 */
async function recognizeRegionText(pageEl, frac) {
  const num = Number(pageEl.dataset.page)
  const p = state.pages[num - 1]
  if (!p || !p.canvas) { toast('本页尚未渲染完成，请稍后重试', true); return }
  if (frac.w < 0.01 || frac.h < 0.005) { toast('选区过小，请重新框选', true); return }

  const dup = findDuplicate({ kind: 'image', page: num, rect: frac })
  // 同一块正在翻译 / 正在识别：别再发一次模型调用（那会两条路同时往这一条上写）
  if (dup && dup.pending) { toast('这块还在处理中，请稍后再试', true); return }
  if (dup && (dup.source || dup.translation)) {
    // 已经识别过（或已翻过）：不重复花钱，直接把那张卡露出来让用户决定下一步
    requestNotesOpen()
    focusEntry(dup.id)
    return
  }

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
  entry.pending = true
  entry.recognizing = true
  entry.error = ''
  entry.rect = frac
  if (!dup) state.entries.push(entry)
  renderEntries()
  renderImageMarks()

  const res = await callBackground({ action: 'recognizeImage', dataUrl })
  entry.pending = false
  entry.recognizing = false
  if (!res || !res.ok) {
    entry.error = (res && res.error && res.error.message) || '识别失败'
    renderEntries()
    renderImageMarks()
    toast('识别失败：' + entry.error, true)
    return
  }
  const original = reflowOcrText((res.data && res.data.original) || '')
  if (!original) {
    entry.error = '没有识别到文字'
    renderEntries()
    renderImageMarks()
    toast('没有识别到文字，请重新框选', true)
    return
  }
  entry.source = original
  entry.translation = original
  entry.recognized = true
  entry.error = ''
  renderEntries()
  renderImageMarks()
  focusEntry(entry.id)
  scheduleSave()
  toast('已识别原文')
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
let _bookNotify = false   // 下一次同步要不要顺便让侧栏切到"当前这本书"（见 notesSnapshot/notifyBookChanged）

function scheduleSync() {
  clearTimeout(_syncTimer)
  _syncTimer = setTimeout(syncNotes, 200)
}

function notesSnapshot() {
  return {
    // bookId 是共读侧 ID（见 readerBookId）：侧栏的译文对照、引用归属都按它走，
    // 不是每处各自用 hash 拼一遍。
    book: hasBook()
      ? { bookId: currentBookId(), hash: state.hash, name: state.name }
      : null,
    // notify：这份快照要不要顺带把侧栏的"当前书"切过来。只有**换书**（打开/切换/关掉
    // 一份 PDF）才置真，"翻页/翻译出条新译文"这类同步不置 —— 否则每次滚动都会把侧栏
    // 从用户手动翻看的另一本书上拽回来。
    notify: !!_bookNotify,
    page: hasBook() ? currentPage() : 0,
    total: bookTotal(),
    activeId: state.activeId,
    /**
     * 「用户刚在书页上点了哪一条」——侧栏的译文对照据此**滚到那一条**（见 reader-notes.js）。
     * 只有 `onReaderClick` 那条路会写它（见 revealEntry 的 fromPage）：
     * 侧栏自己点「跳到原文」、翻译完成设为当前都不会带它，所以那些动作不会把列表拽走。
     * 带时刻是为了让"同一条再点一次"也成立（详见 state.revealAt 的注释）。
     */
    revealId: state.revealId,
    revealAt: state.revealAt,
    entries: state.entries.map((e) => ({
      id: e.id,
      kind: e.kind || 'text',
      source: e.source || '',
      translation: e.translation || '',
      pending: !!(e.pending || e.precisionPending),
      // 框选「识别原文」这条路（2026-11）：条目只识别了原文、没有翻译。
      // 面板据此在正文上方标一句，并把「复制译文」改成「复制原文」。
      recognized: !!e.recognized,
      // 正在识别原文（与 pending 的"翻译中"区分开，面板显示"识别原文中…"）
      recognizing: !!e.recognizing,
      // 精译（2026-10-24）：等待态要单独说"精译中…"；精译过要标出来；
      // 两个版本都在时才给切换按钮（旧记录只有一份，切不了）
      precisionPending: !!e.precisionPending,
      showingPrecise: !!e.showPrecise,
      canToggle: !!(e.fastText && e.preciseText),
      // 两版全文也送过去（2026-10-24）：面板的"看原译/看精译"先在**本地**切、立刻可见，
      // 再让阅读器落盘；只送一个"当前译文"的话，切换必须等一次消息往返，慢一拍就表现为"点了没反应"
      fastText: e.fastText || '',
      preciseText: e.preciseText || '',
      error: e.error || '',
      at: e.at || 0,
    })),
    /**
     * 这本书**已设成引用的那些段落**（2026-11）：给译文面板画下划线用
     *（"这一段已经引过了"，见 reader-notes.js 的 markQuotes）。
     *
     * 这份清单**以接收端存档为准**（refreshRefs 从 /annotations 拉），不是"阅读器
     * 自己记的假设"——不然侧栏删了引用，下划线会赖着不走（2026-11 用户实测）。
     * 拉取时点：打开书、面板要快照、页面重新可见；带 TTL 兜底。
     */
    refs: refsSeen(),
  }
}

/** 这份"已引用段落"清单最多留多少条（超出丢最旧的；侧栏那边也按条数显示） */
const REFS_SEEN_MAX = 200
/** 清单多久算过期（见 refreshRefs）。删除后最迟这么久下划线会消失。 */
const REFS_TTL_MS = 2000

/**
 * 从接收端重新拉"这本书的引用清单"（下划线的事实来源）。
 *
 * ── 为什么以存档为准，而不是"阅读器自己记 + 到处发通知"──────────────────────
 * 删除引用是**侧栏**做的，而且有四条路径（卡片删除、微读划线移除、切书清理、
 * /history 对账清理）。让每条路径都通知阅读器，就一定漏一条；漏了的表现是
 * "划线一直在，点开又删不掉"——比不画更坏。
 * 改成"以接收端的 annotations.jsonl 为准、在几个自然时点刷新"，漏掉一条最多
 * 晚 REFS_TTL_MS 更新一次，不会永远错。
 *
 * 时点选在哪：打开书（loadDocument）、面板要快照（readerGet）、页面重新可见。
 * 就是"用户会去看一眼"的那几个瞬间，不额外轮询。
 */
async function refreshRefs(reason, opts = {}) {
  if (!hasBook()) return false
  const now = Date.now()
  if (!opts.force && reason !== 'open' && state.refsAt && now - state.refsAt < REFS_TTL_MS) return false
  state.refsAt = now
  try {
    const bookId = currentBookId()
    const r = await fetch(RECEIVER_URL + '/annotations?bookId=' + encodeURIComponent(bookId), { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const list = await r.json()
    if (!Array.isArray(list)) throw new Error('返回的不是数组')
    state.refsSeen = list
      .filter((d) => d && d.selectedText)
      .map((d) => ({
        selectedText: String(d.selectedText),
        translation: String(d.translation || ''),
        /**
         * 这条引用落在书里哪一处（2026-10-25）：设引用时阅读器随引用一起报上去的。
         * 跳引用靠它回到**划线那一处**（见 locateRef）——没有它就只能按文字在正文里
         * "找个最近的"，同一句话出现两次就会跳错（用户实测报的正是这个）。
         */
        anchors: Array.isArray(d.anchors) ? d.anchors : [],
        // 下面四样是**删除时精确匹配**用的（见 sidebar.js 的 deleteRefFromNotes / refMatches）：
        // 同一段文字在不同章节被引用两次时，光有 selectedText 分不清该删哪一条。
        bookId: String(d.bookId || ''),
        bookmarkId: String(d.bookmarkId || ''),
        chapterUidInt: Number(d.chapterUidInt) || 0,
        bookmarkRange: String(d.bookmarkRange || ''),
        at: d.timestamp || 0,
      }))
      .slice(0, REFS_SEEN_MAX)
    state.refsFail = 0
    // 清单变了：书页上"已引用"的标记按这张真值表重画。
    // 删掉的引用留下的锚点在这里被裁掉；老数据（本地没记过锚点的）由
    // refreshHighlights 按文字在附近页里补找。
    if (pruneRefMarks()) scheduleSave()
    refreshHighlights()
    scheduleSync()   // 清单变了，推一份新快照给面板重画下划线
    return true
  } catch (e) {
    // 接收端没起来 / 还没起完：**保留**上一次的清单（宁可用旧的，也别把下划线全抹掉），
    // 并把 TTL 让开 + 排队重试 —— 重启时它常常要过几秒才起来，只试一次等于永远拉不到。
    state.refsAt = 0
    scheduleRefsRetry(reason)
    return false
  }
}

/**
 * 本地记一笔"刚设过引用"——**只是乐观更新**，真值仍以 refreshRefs 拉回来的为准。
 * 为什么还要它：设完引用面板马上会重画下划线，等一次网络往返会闪一下。
 */
/** 拉引用清单最多重试几次（≈ 0.8s / 1.6s / 3.2s / 6.4s 之后各一次，共约 12 秒） */
const REFS_RETRY_MAX = 4

/**
 * 拉清单失败后的退避重试。
 *
 * 为什么要它：重启机器/浏览器时，阅读器页面往往比接收端（CoRead 托盘 + agent）先就绪，
 * 那一次 fetch 必然失败。旧实现只试一次 —— 于是**每次重启都得赌**那一次网络，
 * 赌输的表现就是"译文卡片的划线全没了，但引用还在"。
 */
function scheduleRefsRetry(reason) {
  const n = (state.refsFail = (state.refsFail || 0) + 1)
  if (n > REFS_RETRY_MAX) return
  const delay = Math.min(8000, 800 * Math.pow(2, n - 1))
  clearTimeout(state.refsRetryTimer)
  state.refsRetryTimer = setTimeout(() => {
    state.refsRetryTimer = null
    if (!hasBook()) return
    refreshRefs('retry:' + (reason || '') + '#' + n, { force: true })
  }, delay)
}

/**
 * 这本书"已设成引用的那些段落"（下划线的事实来源，见 refreshRefs）。
 * 只是一个缓存 —— 真值在接收端的 annotations.jsonl 里。
 */
function refsSeen() {
  return Array.isArray(state.refsSeen) ? state.refsSeen : []
}

/**
 * 一条引用的「文字身份」与「显示那半边」。
 *
 * 口径必须与 translate-background.js 的 setTranslationRef 一致（原文优先；没有原文的
 * 扫描件才落到摘录 / 整段译文）——本地记的锚点靠这段文字与接收端的 selectedText 对齐，
 * 两边口径不同，书页上的下划线就会对不上那一条引用。
 */
function refFieldsOf(entry, quote) {
  const original = String((entry && entry.source) || '').trim()
  const picked = String(quote || '').trim()
  return {
    selectedText: original || picked || String((entry && entry.translation) || '').trim(),
    translation: picked || String((entry && entry.translation) || '').trim(),
  }
}

function noteRefLocal(entry, quote) {
  const { selectedText, translation } = refFieldsOf(entry, quote)
  if (!selectedText) return
  if (!Array.isArray(state.refsSeen)) state.refsSeen = []
  const i = state.refsSeen.findIndex((r) => r.selectedText === selectedText)
  if (i >= 0) state.refsSeen.splice(i, 1)
  // 本地这笔也要带 bookId：面板据此在侧栏里找回同一条引用（见 deleteRefFromNotes）
  state.refsSeen.unshift({ selectedText, translation, bookId: hasBook() ? currentBookId() : '', at: Date.now() })
  if (state.refsSeen.length > REFS_SEEN_MAX) state.refsSeen.length = REFS_SEEN_MAX
  state.refsAt = 0        // 本地这一笔之后允许立刻再拉一次（把别的路径改的也对齐）
}

/**
 * 记下这条引用**落在书里哪一处**（见 state.refMarks）。
 *
 * 只在有锚点时记：图片条目（扫描件）没有文字层锚点，画不了文字下划线，它本来就有
 * `.rd-mark` 的虚线框；硬记一笔空锚点只会让裁剪逻辑以为"这条已经有位置了"。
 *
 * `entry.guess === true` = 这一笔不是"用户划的那一下"，而是按文字在附近**猜**出来的
 *（见 refRanges ③）。两者必须分开记：猜出来的位置用来画绿线可以（画错了顶多一条线），
 * 但它不能冒充"用户划线的那一处"——跳引用时它排在**精确锚点之后**（见 locateRef）。
 * 2026-10-25 实测：一条老引用在第 54 页被猜成第 56 页（真正的划线在第 58 页），
 * 猜完之后"精确"与"猜"就再也分不开了。
 */
function noteRefMark(entry, quote) {
  const { selectedText } = refFieldsOf(entry, quote)
  const anchors = (entry && Array.isArray(entry.anchors)) ? entry.anchors : []
  if (!selectedText || !anchors.length) return false
  if (!Array.isArray(state.refMarks)) state.refMarks = []
  const i = state.refMarks.findIndex((m) => String((m && m.text) || '') === selectedText)
  if (i >= 0) state.refMarks.splice(i, 1)
  state.refMarks.unshift({
    text: selectedText,
    anchors: anchors.map((a) => ({ page: a.page, start: a.start, end: a.end })),
    at: Date.now(),
    ...(entry && entry.guess === true ? { guess: true } : {}),
  })
  if (state.refMarks.length > REFS_SEEN_MAX) state.refMarks.length = REFS_SEEN_MAX
  return true
}

/**
 * 按接收端的引用清单裁掉"已经删掉的引用"留下的锚点。
 *
 * 与译文面板的下划线同一条原则：真值在接收端，本地这份只是缓存——侧栏删了引用，
 * 书页上那道线不能赖着不走。
 */
function pruneRefMarks() {
  if (!Array.isArray(state.refMarks) || !state.refMarks.length) return false
  const live = new Set(refsSeen().map((r) => String((r && r.selectedText) || '').trim()))
  const before = state.refMarks.length
  const now = Date.now()
  /**
   * 刚设出来的引用给一段宽限：refreshRefs 是异步的，一次**在设引用之前发出**的拉取
   * 可能带着旧清单晚到（设引用 → 点开译文面板会同时触发）。没有这条宽限，那一笔
   * 刚画上的线会被旧清单当场裁掉，而它的锚点也就跟着丢了。
   */
  const GRACE_MS = 10000
  state.refMarks = state.refMarks.filter((m) =>
    live.has(String((m && m.text) || '').trim()) || (now - Number((m && m.at) || 0) < GRACE_MS))
  return state.refMarks.length !== before
}

/** 侧栏删了一条引用 → 本地先把那一条摘掉（下一份快照就别再画它了）。 */
function forgetRefLocal(selectedText) {
  const want = String(selectedText || '')
  if (!want) return false
  const beforeRefs = refsSeen().length
  const beforeMarks = Array.isArray(state.refMarks) ? state.refMarks.length : 0
  state.refsSeen = refsSeen().filter((r) => String(r.selectedText || '') !== want)
  // 同一条引用在**书页上**的标记也要立刻消失（else 侧栏删了、书页还留着一道绿线）
  if (Array.isArray(state.refMarks)) {
    state.refMarks = state.refMarks.filter((m) => String((m && m.text) || '') !== want)
  }
  if (state.refsSeen.length !== beforeRefs || (state.refMarks || []).length !== beforeMarks) {
    refreshHighlights()
    scheduleSync()
    scheduleSave()
    return true
  }
  return false
}

/**
 * 记下"这一段设成引用了"（乐观更新，见 noteRefLocal）。
 *
 * 这里同时是**设完引用、书页上立刻出现标记**的入口（2026-11 用户报的 bug：划词设为引用后
 * 选区被撤掉，书页上什么都没留下，用户找不到自己引了哪一段）。
 */
function rememberRef(entry, quote) {
  noteRefLocal(entry, quote)
  noteRefMark(entry, quote)
  refreshHighlights()
  scheduleSync()
  // 清单与锚点都落盘：重启时接收端可能还没起来，先按本地这份把标记画出来
  scheduleSave()
}

// ── 译文对照：显示在 CoRead 侧栏里 ───────────────────────────────────────────
// 阅读器页面**不再自带对照栏**：那样一边开着 CoRead 侧栏、一边再来一栏，就是两栏并排。
// 条目变化 → 经后台中继同步给侧栏；侧栏上的操作 → 经后台中继发回来（见 onReaderCommand）。
/**
 * 把快照推给侧栏（译文对照面板挂在那边，不在这个页面里）。
 * 另外两条：换书用 notifyBookChanged 立刻推、不排队；面板要快照时后台回的是本地缓存。
 */
async function syncNotes() {
  clearTimeout(_syncTimer)      // 立即同步时就取消排队中的那次，免得白发两遍
  _syncTimer = null
  if (!canMessage()) return
  const snap = notesSnapshot()
  _bookNotify = false           // 只生效一次：下次同步回到"不打扰侧栏上下文"
  try {
    await chrome.runtime.sendMessage({ action: 'readerSync', snapshot: snap })
  } catch (e) {}
}

/**
 * 换书了（打开 / 切换 / 关掉一份 PDF）→ 立刻把快照推给侧栏，并让它把"当前书"切过来。
 * 不排队（scheduleSync 那 200ms 防抖会让侧栏慢半拍），因为用户感知到的就是这个瞬间。
 */
function notifyBookChanged() {
  _bookNotify = true
  syncNotes()
}

/** 让侧栏打开译文对照（顺便把侧栏本身打开）。翻译完成、点页面上已翻过的区域都走它。 */
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

/**
 * 设完引用 → 把侧栏切回对话界面（2026-11 用户要求）。
 *
 * 为什么走 `notesClose` 而不是新开一条消息：译文对照就是侧栏上的一个整屏覆盖层
 * （`#reader-notes` 的 `.on`），收起它露出来的正是下面的对话界面 —— 与译文面板里
 * 点「设为引用」后 `onClose` 的效果相同。
 *
 * 为什么要等 200ms：后台还要把引用 POST 给接收端、接收端再推 SSE 回来，侧栏的引用卡
 * 靠那条 SSE 填。收起太快，用户会先看到上一条引用卡、再跳成新的（原因同
 * reader-notes.js 的 makeReference）。200ms 是那边实测够用的量级。
 */
async function showChatAfterReference() {
  await new Promise((r) => setTimeout(r, 200))
  requestNotesClose()
}

// ── 重复翻译：同一段不要生成第二条 ────────────────────────────────────────────

function sameAnchorSet(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((x, i) => x.page === b[i].page && x.start === b[i].start && x.end === b[i].end)
}

/** 找与这次划线/框选重合的旧条目（重合就复用它，而不是再翻一遍） */
function findDuplicate(probe) {
  if (!probe) return null
  if (probe.kind === 'image') {
    const p = Number(probe.page) || 0
    const r = probe.rect || null
    if (!r) return null
    return state.entries.find((e) => e.kind === 'image' && e.page === p && e.rect &&
      Math.abs(e.rect.x - r.x) < 0.02 && Math.abs(e.rect.y - r.y) < 0.02 &&
      Math.abs(e.rect.w - r.w) < 0.02 && Math.abs(e.rect.h - r.h) < 0.02) || null
  }
  return state.entries.find((e) => (e.kind || 'text') === 'text' && sameAnchorSet(e.anchors, probe.anchors)) || null
}

/**
 * 复用一条旧条目（同一段再翻一次时用）。
 * 已有译文就直接把它设为当前并回报"已复用"；还在翻译中 / 上次失败的交回调用方去重翻。
 *
 * ⚠️ `recognized`（只识别原文、没翻译）**不算已有译文**：那条卡的正文里虽然放着识别出的
 * 原文，但用户点「翻译」要的是真译文。不排除它的话，同一块再选「翻译」只会把卡片滚出来、
 * 什么都不翻（2026-11 加「设为引用」时踩到的分叉）。
 */
function reuseDuplicate(dup) {
  if (!dup || dup.pending || dup.error) return false
  if (dup.recognized) return false
  if (!dup.translation) return false
  focusEntry(dup.id)
  return true
}

/**
 * 条目有变化时调用：把快照推给侧栏（对照栏挂在侧栏里，页面里没有 DOM 要重画）。
 *
 * ⚠️ 这里必须**顺手重新排队保存**（2026-11 修，见文件里 saveRecord 的注释）：
 * 打开书时 `fitWidth → setScale` 会排一次保存，那一刻记录还没读回来、条目是 0；
 * 若这次变化不重新排队，600ms 后那次保存会照当时的 state 写盘 —— 把刚翻出来的
 * 译文覆盖成空（自测"刷新后译文没了"抓到的就是这个，而且它时灵时不灵）。
 * renderEntries 是条目变化的唯一总入口（划词/框选/删除/清空/重译/恢复都经它），
 * 所以放在这里一处就够，不必在每个调用点各排一次。
 */
function renderEntries() {
  scheduleSync()
  scheduleSave()
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
    CSS.highlights.delete('rd-ref')
    CSS.highlights.delete('rd-locate')
  }
}

/**
 * 引用匹配用的「去空白」口径。
 *
 * 与 content.js（微读页面的共读标记）和 reader-notes.js（译文卡片里的下划线）同一套：
 * PDF 文字层抽出来的行间空格与存下来的原文未必逐字一致，不去掉空白就对不上。
 */
function compactRefText(s) {
  return String(s || '').replace(/\s+/g, '')
}

/** 去空白后的偏移 → 原串偏移（找不到返回 -1） */
function rawOffsetOfCompact(raw, at) {
  let seen = 0
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) continue
    if (seen === at) return i
    seen++
  }
  return seen === at ? raw.length : -1
}

/**
 * 在**一页**文字层里按原文找一段，返回页内锚点。
 *
 * 这是给"本地没有记过锚点的老引用"用的兜底（见 refRanges ③）：
 * 只按**前 64 字**做一次精确匹配（去空白后），**不做"再退一步按前 12 字找"**。
 * 12 字太短：书里同页出现同样十几个字的地方不少，宁可这一条暂时不画，
 * 也不能把隔壁一句标成引用（同 contextAround 的"宁可没有，不可给错"）。
 * 页内文字对不上（典型：行尾断词被修正过）就不画，用户翻到那一页也不会标错。
 *
 * 页文字缓存在 p.plainText / p.compactText 上：文字层只在首次渲染时建一次
 *（缩放走 textLayer.update，不重建 DOM），所以这层缓存不会过期；换书时 p 整个丢掉。
 */
function anchorOfTextOnPage(p, text) {
  if (!p || !p.layer) return null
  if (p.compactText === undefined) {
    const spans = pageTextIndex(p.layer).spans
    p.plainText = spans.map((s) => s.textContent || '').join('')
    p.compactText = compactRefText(p.plainText)
  }
  const want = compactRefText(text)
  if (want.length < 4 || !p.compactText) return null
  const needle = want.slice(0, 64)
  const at = p.compactText.indexOf(needle)
  if (at < 0) return null
  const start = rawOffsetOfCompact(p.plainText, at)
  const end = rawOffsetOfCompact(p.plainText, at + needle.length)
  if (start < 0 || end <= start) return null
  return { page: p.num, start, end }
}

/**
 * 在当前页附近（±3 页，与 locateText 同一范围）按文字找一段引用的锚点。
 * `curPage` 由调用方算一次传进来：逐条引用各算一遍"当前第几页"没有必要。
 *
 * 为什么不搜全书：同一句话可能在书里出现多次，标错位置比不标更坏；
 * 用户翻到那一页（它渲染时会再调 refreshHighlights）自然就找得到。
 */
function locateRefAnchorNear(text, curPage) {
  if (!state.pages.length) return null
  const cur = Math.max(1, Number(curPage) || 1)
  const order = [cur]
  for (let d = 1; d <= 3; d++) {
    if (cur - d >= 1) order.push(cur - d)
    if (cur + d <= state.pages.length) order.push(cur + d)
  }
  for (const n of order) {
    const p = state.pages[n - 1]
    if (!p || !p.rendered) continue
    const a = anchorOfTextOnPage(p, text)
    if (a) return a
  }
  return null
}

/**
 * 书页上"已经设成引用"的那些 Range（CSS Custom Highlight 的 rd-ref）。
 *
 * 三个来源，从准到松：
 *   ① 设引用那一刻记下的锚点（state.refMarks）——用户划的就是它
 *   ② 本地没锚点、但"引用的文字身份"对得上某条译文的原文 → 用那条译文的锚点
 *   ③ 还是没有 → 按文字在当前页附近找一次，找到就**补记**进 refMarks（下次不必再找）
 *
 * 为什么要 ②③：这个标记是 2026-11 才加的，此前设过的引用 receiver 里只有文字、
 * 没有偏移。只做 ① 的话，用户会看到"新引的有线、旧引的没有"——那与"有的有、有的没有"
 * 是同一种坏。
 */
function refRanges() {
  const out = []
  const seen = new Set()
  const push = (a) => {
    if (!a) return false
    const key = (Number(a.page) || 0) + ':' + (Number(a.start) || 0) + ':' + (Number(a.end) || 0)
    if (seen.has(key)) return false
    const r = resolveAnchor(a)
    if (!r) return false
    seen.add(key)
    out.push(r)
    return true
  }

  // ① 设引用时记下的锚点
  const covered = new Set()
  for (const m of state.refMarks || []) {
    covered.add(compactRefText(m && m.text))
    for (const a of (m && m.anchors) || []) push(a)
  }
  /** 这一轮新认出来的锚点（②③ 共用）：跑完一并补记，下一轮就不必再找 */
  const located = []

  // ② 老引用：引用的文字身份对得上哪条译文的原文，就用那条译文的锚点
  for (const r of refsSeen()) {
    const t = compactRefText(r && r.selectedText)
    if (!t || covered.has(t)) continue
    for (const e of state.entries) {
      if (!e || !e.anchors || !e.anchors.length) continue
      if (compactRefText(e.source) !== t) continue
      for (const a of e.anchors) push(a)
      // 条目可能还没渲染（这时 push 解析不出 Range）：锚点本身是对的，
      // 照样补记下来 —— 等那页渲染时 refreshHighlights 会把它画出来
      located.push({ source: e.source, anchors: e.anchors })
      covered.add(t)   // 对上了就不再往下找（同一段在书里出现两次也只标这一处）
      break
    }
  }

  // ③ 还是没有锚点的：按文字在附近找一次，找到就补记下来
  let curPage = 0
  for (const r of refsSeen()) {
    const t = compactRefText(r && r.selectedText)
    if (!t || covered.has(t)) continue
    if (!curPage) curPage = Math.max(1, currentPage() || 1)
    const a = locateRefAnchorNear(String((r && r.selectedText) || ''), curPage)
    if (!a) continue
    // guess: 这是**按文字猜的**，不是用户划线那一刻记下的（见 noteRefMark）。
    // 同一句话在书里出现两次时，这一猜就可能猜错（实测第 56 / 58 页各有"全国预算收入"）。
    if (push(a)) located.push({ source: String(r.selectedText || ''), anchors: [a], guess: true })
    covered.add(t)
  }
  if (located.length) {
    for (const m of located) noteRefMark(m)
    // 补记的锚点要落盘：下一轮重启就不必再按文字找一遍
    scheduleSave()
  }
  return out
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
  /**
   * 「这一段被我引用了」的标记（2026-11 修：此前设完引用书页上什么都没画）。
   * **最后注册**：注册顺序决定叠放优先级，放在译文底色之后，绿线才不会被
   * 50% 不透明的译文底色盖掉。
   */
  const refs = refRanges()
  if (refs.length) CSS.highlights.set('rd-ref', new Highlight(...refs))
  else CSS.highlights.delete('rd-ref')
}

/** 点页面上某处时命中哪一条译文：图片条目按页内比例，文字条目按锚点矩形 */
/**
 * 点页面上"已经翻过的那一块" → 打开译文对照并把那一条设为当前。
 *
 * 为什么要有它：译文高亮是 CSS Custom Highlight 画的（::highlight 不参与命中测试），
 * 而文字层的字形是透明的 —— 所以"点高亮"这件事没有 DOM 事件可听，只能自己在
 * document 的 click 上按坐标算（图片条目按页内比例、文字条目按锚点矩形，见 entryAtPoint）。
 *
 * 三种情况要让开，否则会跟正常阅读打架：
 *   · 正在框选（那一模式里点击有别的含义）
 *   · 刚划完词还留着选区（用户是在选字，不是在点译文）
 *   · 点在浮标/面板/按钮上（那些元素自己有事要做）
 */
/**
 * 这个点在不在当前选区里？
 *
 * 双击收起译文对照时要问它：双击的第一下会先把光标落在文字上（浏览器默认行为），
 * 于是"双击空白处"与"双击选中的字"在坐标上是重叠的。选区本身不给命中测试，
 * 只能拿 Range 的矩形自己比。
 */
function pointInSelection(x, y) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false
  try {
    for (const r of sel.getRangeAt(0).getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    }
  } catch (e) {}
  return false
}

function onReaderClick(ev) {
  if (state.boxMode) return
  // 框选动作条还开着：这一下要么落在动作条上、要么是在放弃它，
  // 不该顺手当成"点了已翻过的区域"去改当前译文
  if (state.boxChoice) return
  if (ev.button !== 0) return
  const el = ev.target
  if (el && el.closest && el.closest('button, a, input, textarea, .rd-tip, .rd-toc, .rd-del-box, #rd-toast')) return
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) return
  const hit = entryAtPoint(ev.clientX, ev.clientY)
  if (!hit) return
  requestNotesOpen()
  // fromPage：这次是**书页上点过来的**，侧栏的译文对照要同时跳到这一条（见 revealEntry）
  revealEntry(hit.id, { fromPage: true })
}

function entryAtPoint(clientX, clientY) {
  for (const e of state.entries) {
    if (e.kind === 'image' && e.rect) {
      const p = state.pages[e.page - 1]
      if (!p) continue
      const pr = p.wrap.getBoundingClientRect()
      const x = e.rect.x * pr.width + pr.left
      const y = e.rect.y * pr.height + pr.top
      if (clientX >= x && clientX <= x + e.rect.w * pr.width &&
          clientY >= y && clientY <= y + e.rect.h * pr.height) return e
    }
    for (const a of e.anchors || []) {
      const r = resolveAnchor(a)
      if (!r) continue
      for (const rect of r.getClientRects()) {
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return e
      }
    }
  }
  return null
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

/**
 * 把某一条设为当前并跳到它在书页上的位置。
 *
 * `opts.fromPage` = 这次是**用户在书页上直接点的译文区域**（onReaderClick）：
 * 只有这时才写 revealId/revealAt，让侧栏的译文对照也滚到对应条目。
 * 侧栏自己发来的 `reveal`（点「跳到原文」）不带这个标记——用户人就在列表里，
 * 再把列表滚一遍只会在原地抖一下。
 */
async function revealEntry(id, opts = {}) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return
  state.activeId = id
  if (opts.fromPage) {
    state.revealId = id
    state.revealAt = Date.now()
  }
  renderEntries()
  // 面板那边要的是"点下去的同一瞬间跳过去"，不能等 scheduleSync 的 200ms 防抖。
  syncNotes()
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

/**
 * 设为引用：把这一条（或用户划出来的那一段）交给共读侧当"当前引用"。
 *
 * 三个字段缺一不可，各自身份不同：
 *   original    引用**身份**（判重、删除匹配、跳回原文、agent 的上下文认领全用它）
 *   translation 用户**读到的那半边**（只用于显示）
 *   quote       用户在译文里**划出来的那一段**（侧栏译文卡片的划选共读）
 *
 * original 与 translation 的分工是 2026-11 定的：PDF 场景下用户读的是译文，
 * 所以引用卡与对话横幅以译文为主体；但原文仍是身份，一个字都不能动。
 *
 * quote 有值时，引用就是这一段（扫描件那条路的关键：图片条目本来没有原文，
 * 整页译文进引用卡会让讨论失焦）。image 标记告诉后台"这是扫描件"，它据此
 * 把上下文换成一句"这页没有文字层"的说明（图片条目没有锚点，抽不出附近原文）。
 */
async function setAsReference(entry, quote) {
  if (!entry || !entry.translation) return { ok: false, error: { message: '该条目暂无译文' } }
  const picked = String(quote || '').trim()
  /**
   * 只识别了原文、没翻译的条目（框选「识别原文」出来的卡片，之后在卡片上点「设为引用」）：
   * 它的 translation 放的是识别结果（面板正文要显示它），但**不能当成译文报给共读侧** ——
   * 否则引用卡与 agent 都会以为这段已经是中文译文。没划选时就不带 translation，
   * 侧栏按 refDisplayText 回落到 selectedText（原文），语义才正确。
   */
  const recognizedOnly = !!entry.recognized && !picked
  // 上下文随引用一起报上去（PDF 没有章节正文可查，agent 那边只有这一份）。
  // 两条路（见 reader-anchor.js 的 contextForRef）：
  //   · 文字条目 → 划线**附近各 300 字**（contextAround）
  //   · 扫描件（截图/框选识别或翻译）→ 没有原文也没有文字层，退回**整张卡片的译文**：
  //     用户划的那一句的前后文就在这张卡上，不送出去 agent 只剩孤零零一句。
  // 只识别原文的条目没有"另一份译文"可当上下文：原文就是 selectedText 本身，不重复送。
  const context = recognizedOnly ? '' : contextForRef(await contextAround(entry.anchors), entry)
  const shown = picked || (recognizedOnly ? '' : entry.translation)
  const res = await callBackground({
    action: 'setTranslationRef',
    original: entry.source,
    // 划选了就报那一段；没划选报整段（与改动前一致）
    ...(shown ? { translation: shown } : {}),
    ...(picked ? { quote: picked } : {}),
    ...(entry.kind === 'image' ? { image: true } : {}),
    /**
     * 这条引用落在书里哪一处（2026-10-25）：页号 + 页内字符偏移。
     *
     * 为什么要报上去：侧栏点这条引用要跳回**划线那一处**，而按文字找一定会有
     * "跳到同一句话的另一个出现位置"的时候。实测《置身事内》"全国预算收入"在
     * 第 56 页与第 58 页各一遍，用户划的是 58，按文字找落到 56。
     * 存档里带着锚点，换浏览器 / 清缓存 / 本地记号超过上限（见 REFS_SEEN_MAX）之后
     * 也还跳得准（见 refreshRefs 与 locateRef）。
     */
    ...(Array.isArray(entry.anchors) && entry.anchors.length
      ? { anchors: entry.anchors.map((a) => ({ page: a.page, start: a.start, end: a.end })) }
      : {}),
    context,
    url: 'reader://' + state.hash + (state.name ? '#' + state.name : ''),
    pageTitle: state.name,
    bookId: readerBookId(state.hash),   // 共读侧 ID：后台据此定书、接收端据此归属
    bookTitle: state.name || '',
  })
  if (res && res.ok) {
    toast('已设为引用')
    // 记下这一段（给译文面板画"已经引过了"的下划线，见 refsSeen / noteRefLocal）。
    // 只识别原文的条目也按"没有译文"记，下划线靠 selectedText 找到正文里的原文。
    // anchors 要带上：设成引用之后，书页上那一段也得看得见（见 noteRefMark）。
    rememberRef(recognizedOnly
      ? { source: entry.source, translation: '', anchors: entry.anchors }
      : entry, picked)
  }
  return res
}

/** 侧栏发来的操作（经后台中继，见 translate-background.js 的 readerCommand） */
async function onReaderCommand(msg) {
  const type = msg && msg.type
  if (!type) return
  if (type === 'reveal') { await revealEntry(msg.id); return { ok: true } }
  if (type === 'remove') { removeEntry(msg.id); return { ok: true } }
  if (type === 'clear') {
    state.entries = []
    state.allowEmptySave = true   // 用户明确清空：允许把空记录写回去（见 saveRecord）
    state.activeId = ''
    state.revealId = ''
    state.revealAt = 0
    renderEntries()
    refreshHighlights()
    renderImageMarks()
    scheduleSave()
    return { ok: true }
  }
  if (type === 'reference') {
    const e = state.entries.find((x) => x.id === msg.id)
    // msg.quote = 用户在侧栏译文里划出来的那一段（见 reader-notes.js 的划选共读）
    return await setAsReference(e, msg.quote)
  }
  if (type === 'retranslate') return await retranslateEntry(msg.id, msg.text)
  // 精译（2026-10-24）：开思考重译，慢但更准；toggle 在快速版/精译版之间切换
  if (type === 'precise') return await preciseTranslateEntry(msg.id)
  if (type === 'toggle') return toggleTranslation(msg.id)
  if (type === 'showTranslation') return setTranslationVersion(msg.id, msg.showPrecise === true)
  // 侧栏删了一条引用 → 把本地那份"已引用段落"里对应的那一条摘掉（书页绿线随之消失）
  if (type === 'forgetRef') {
    /**
     * 只处理**当前这本书**的删除：侧栏存着所有书的引用，消息里带 bookId 是为了
     * 在 A 书删引用时别把 B 书阅读器里同文的标记一起抹掉（同文不同书很难肉眼发现）。
     * 老版本侧栏不带 bookId → 照旧按文字处理（本页只能画当前这本，风险等于改动前）。
     */
    const wantBook = String(msg.bookId || '')
    if (wantBook && hasBook()) {
      const mine = currentBookId()
      const same = wantBook === mine || wantBook.indexOf(mine) === 0 || mine.indexOf(wantBook) === 0
      if (!same) return { ok: true, ignored: 'not-this-book' }
    }
    forgetRefLocal(String(msg.text || ''))
    return { ok: true }
  }
  /**
   * 在**当前打开的这一本**里找到一段原文，滚过去并圈出来（2026-11）。
   *
   * 为什么加它：侧栏点「跳到原文」时，原先一律走"按章重新打开"（深链 ?open=&chapter=）。
   * 而引用上**没有可靠的章号**——chapterNum 是 undefined，于是 Number(undefined) || 0 = 0、
   * 深链缺了 &chapter=，阅读器只能从头打开，用户看到的就是"回到主界面"（他实测报的正是这个）。
   *
   * 更根本的是：用户点"跳到原文"要的是**让我看见那句话在哪**，不是"把整本书重新打开一遍"。
   * 所以这里做同页定位：不重载、不丢阅读位置、找到就滚过去高亮一圈。
   *
   * 2026-10-25：改走 locateRef —— **先按锚点**（划线那一刻的位置）跳，不再一上来按文字找。
   * 按文字找会把"同一句话的另一个出现位置"当成目标（详见 locateRef 的头注释）。
   */
  if (type === 'locate') return locateRef(String(msg.text || ''))
  // 快捷键由后台中继过来：侧栏有焦点时页面收不到按键，只能走这条路
  if (type === 'boxSelect') { startBoxSelect(); return { ok: true } }
  if (type === 'translateSelection') { await translateSelection(); return { ok: true } }
  return { ok: false, error: { message: '未知操作 ' + type } }
}

/** 删掉一条译文（侧栏里点「删除」） */
function removeEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id)
  // 用户把最后一条删掉了：这次的空记录是**明确的意图**，保存要放行（见 saveRecord 的防覆盖）
  if (!state.entries.length) state.allowEmptySave = true
  if (state.activeId === id) state.activeId = ''
  // 把"页面点过哪一条"的标记也清掉：否则侧栏下次拿快照还会去找一个已经删掉的条目
  if (state.revealId === id) { state.revealId = ''; state.revealAt = 0 }
  renderEntries()
  refreshHighlights()
  renderImageMarks()
  scheduleSave()
}

/**
 * 改原文并重译（侧栏里点「改原文重译」→ 这里执行）。
 * 只改这一条的原文，锚点不动 —— 用户是在修正原文（扫描件的识别错字，或文字层里抽坏的词），位置没变。
 */
async function retranslateEntry(id, text) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return { ok: false, error: { message: '未找到该条目' } }
  /**
   * 这条原来是"只识别原文、没翻译"吗？
   * 是的话，这次动作其实是**第一次翻译**（面板上那个「翻译」按钮走的就是这条路），
   * 提示语与失败文案都不该说"重译"。
   */
  const wasRecognized = !!e.recognized
  const next = String(text || '').trim()
  if (!next) return { ok: false, error: { message: '原文不能为空' } }
  e.source = next
  // 原文换了：正在跑的"精译"对应的还是旧原文，回来时必须作废（见 preciseTranslateEntry）
  e.sourceSeq = (e.sourceSeq || 0) + 1
  e.pending = true
  e.error = ''
  renderEntries()
  const res = await callBackground({
    action: 'translateText',
    text: next,
    source: 'retranslate',
    // 这条原文是不是扫描件 OCR 出来的？决定后台用不用「可能有错字」那套规则（2026-10-24）。
    // 文字条目来自 PDF 文字层，说它有错字会让模型去改人名、术语和旧拼法。
    fromOcr: e.kind === 'image',
    bookTitle: bookNameForModel(),
  })
  e.pending = false
  if (!res || !res.ok) {
    e.error = (res && res.error && res.error.message) || '翻译失败'
    toast((wasRecognized ? '翻译失败：' : '重译失败：') + e.error, true)
    renderEntries()
    return res || { ok: false }
  }
  e.translation = (res.data && res.data.translation) || ''
  // 原来是"只识别原文"的条目：现在有真译文了，面板的"未翻译"提示要撤掉
  e.recognized = false
  e.recognizing = false
  // 重译出的是**新原文**的普通版：两版都作废（旧译文对应的原文已经变了），
  // 从这一份重新开始；否则切换按钮会把一段旧原文的译文拿出来对照
  e.fastText = e.translation
  e.preciseText = ''
  e.showPrecise = false
  toast(wasRecognized ? '已翻译' : '已重译')
  renderEntries()
  refreshHighlights()
  scheduleSave()
  return { ok: true }
}

/**
 * 精译一条（2026-10-24 用户定调：默认快、按需慢）。
 *
 * 为什么单开一条命令，而不是给 retranslate 加参数：
 *   · retranslate 的语义是"用户改了原文，用新原文换一份译文"；精译不改原文，只换翻法。
 *   · 失败时的处理相反：retranslate 失败要报错占住卡片（原文已经变了），精译失败**必须
 *     留着原来那份译文**——用户点精译是想更好，不该因此丢掉手里那版。
 *
 * 两个版本都留下（2026-10-24 用户要求"能两边切换"）：
 *   fastText    普通翻译那一版（第一次精译时从当前译文里存下来）
 *   preciseText 精译那一版
 *   showPrecise 现在显示哪一版；translation 始终等于被选中的那版（落盘/引用都只读它）
 * 两份都落盘：用户切换是随时的事，不能只在本次会话有效。条目上 unlimitedStorage 权限，
 * 多存一份译文换"随时对照"是划算的。
 *
 * 思考模式一次要 5–25 秒（见 translate-background.js 的 precise 注释），pending 期间
 * 卡片显示"精译中…"，当前译文继续显示在下面。
 */
async function preciseTranslateEntry(id) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return { ok: false, error: { message: '未找到该条目' } }
  const source = String(e.source || '').trim()
  if (!source) return { ok: false, error: { message: '这条没有原文，无法精译' } }
  /**
   * 只挡"同一条正在精译"（防止连点两次白花一次 25 秒的调用）。
   *
   * **不再挡 e.pending**（2026-10-24 用户报"点精译总说正在翻译"）：普通翻译/重译也占着
   * 这个标记，于是精译会被一条其实已经在收尾的普通翻译挡住。现在两条可以并行——
   * 普通版先回来、精译后回来覆盖，最终留下的是精译版，fastText 由普通翻译那条路自己写，
   * 不会互相踩（见 translateSelection / retranslateEntry 里对 fastText 的赋值）。
   */
  if (e.precisionPending) return { ok: false, error: { code: 'BUSY', message: '这条正在精译，请稍等' } }

  // 只动自己这个标记：普通翻译/重译用的是 e.pending，两条同时跑时不能互相清
  e.precisionPending = true
  e.error = ''
  renderEntries()
  const t0 = Date.now()
  const seq = e.sourceSeq || 0
  postDebug({ stage: 'precise-start', id, sourceLen: source.length, hasFast: !!e.fastText, hasPrecise: !!e.preciseText })

  let res = null
  try {
    res = await callBackground({
      action: 'translateText',
      text: source,
      source: 'retranslate',
      fromOcr: e.kind === 'image',
      bookTitle: bookNameForModel(),
      precise: true,
    })
  } finally {
    // 不管成功、失败、还是中途抛错，这个标记都必须落回去 ——
    // 否则卡片会永远停在"精译中…"，之后每次点都只会得到"正在精译"
    e.precisionPending = false
  }
  postDebug({ stage: 'precise-done', id, ok: !!(res && res.ok), ms: Date.now() - t0, err: (res && res.error && res.error.message) || '' })

  // 20 多秒里用户可能删了这条、或换了本书（state.entries 整个换掉）：
  // 这时手里这个 e 已经不在列表里，后面的成功提示与落盘都没有意义
  if (!state.entries.includes(e)) return { ok: false, error: { message: '这条已被删除或换书了' } }
  // 原文在这段时间里被改过（改原文重译）：这份精译对应的是旧原文，作废
  if ((e.sourceSeq || 0) !== seq) {
    toast('原文已修改，这次精译作废', true)
    renderEntries()
    return { ok: false, error: { message: '原文已修改，这次精译作废' } }
  }
  if (!res || !res.ok) {
    // 不动两份译文：失败也要保住手里那版（见函数头）
    toast('精译失败：' + ((res && res.error && res.error.message) || '原因未知'), true)
    renderEntries()
    return res || { ok: false }
  }
  // 第一次精译：把当前显示的普通译文存成 fastText；已经在显示精译版时不要
  // 把精译文本误当成普通版（老记录迁移过来的那种：只有一份，没有可切换的另一半）
  if (!e.fastText && !e.showPrecise) e.fastText = e.translation || ''
  e.preciseText = (res.data && res.data.translation) || e.preciseText || e.translation || ''
  e.showPrecise = true
  e.translation = e.preciseText
  toast(e.fastText ? '已精译（可切换两版对照）' : '已精译')
  renderEntries()
  refreshHighlights()
  scheduleSave()
  return { ok: true }
}

/**
 * 设为指定的那一版（面板已经本地切过了，这里只负责"落到阅读器、并保持一致"）。
 * 与 toggleTranslation 的差别：这里接收**目标状态**，重复调用不会来回翻——
 * 面板先切、再发这条，网络/消息慢一拍也不会把状态切反。
 */
function setTranslationVersion(id, showPrecise) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return { ok: false, error: { message: '未找到该条目' } }
  if (!e.fastText || !e.preciseText) {
    return { ok: false, error: { message: '这条还没有两个版本可切换（先精译一次）' } }
  }
  e.showPrecise = !!showPrecise
  e.translation = e.showPrecise ? e.preciseText : e.fastText
  renderEntries()
  refreshHighlights()
  scheduleSave()
  return { ok: true }
}

/**
 * 在「快速版 / 精译版」之间切换（2026-10-24 用户要求：两版都留着，直接对照）。
 * 不动原文、不重新翻译，只换显示；translation 跟着换，后续设引用用的是当前这一版。
 */
function toggleTranslation(id) {
  const e = state.entries.find((x) => x.id === id)
  if (!e) return { ok: false, error: { message: '未找到该条目' } }
  if (!e.fastText || !e.preciseText) {
    return { ok: false, error: { message: '这条还没有两个版本可切换（先精译一次）' } }
  }
  e.showPrecise = !e.showPrecise
  e.translation = e.showPrecise ? e.preciseText : e.fastText
  toast(e.showPrecise ? '正在看精译版' : '正在看快速版')
  renderEntries()
  refreshHighlights()
  scheduleSave()
  return { ok: true }
}

/**
 * 在当前页里按原文定位并高亮（见 onReaderCommand 的 locate）。
 * 找不到就如实回报 found:false（调用方据此退回"按章打开"），**不假装成功**。
 */
function locateText(text) {
  const want = String(text || '').trim()
  if (!want) return { ok: true, found: false }
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const needle = norm(want).slice(0, 40)
  if (needle.length < 4) return { ok: true, found: false }
  const cur = currentPage()
  const order = [cur]
  for (let d = 1; d < 4; d++) {
    if (cur - d >= 1) order.push(cur - d)
    if (cur + d <= state.pages.length) order.push(cur + d)
  }
  for (const n of order) {
    const p = state.pages[n - 1]
    if (!p || !p.layer) continue
    const raw = pageTextIndex(p.layer).spans.map((s) => s.textContent || '').join('')
    const compact = norm(raw)
    const at = compact.indexOf(needle)
    if (at < 0) continue
    // 归一化后的偏移 → 原始偏移（被去掉的空白要数回来）
    let rawAt = -1
    let seen = 0
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) continue
      if (seen === at) { rawAt = i; break }
      seen++
    }
    if (rawAt < 0) continue
    const r = rangeFromOffsets(p.layer, rawAt, Math.min(raw.length, rawAt + want.length))
    if (!r) continue
    const rect = r.getBoundingClientRect()
    const c = els.scroll.getBoundingClientRect()
    els.scroll.scrollBy({ top: rect.top - c.top - Math.min(140, els.scroll.clientHeight * 0.25), behavior: 'smooth' })
    p.wrap.classList.add('rd-flash')
    clearTimeout(p._flashTimer)
    p._flashTimer = setTimeout(() => p.wrap.classList.remove('rd-flash'), 1200)
    if (window.CSS && CSS.highlights) CSS.highlights.set('rd-locate', new Highlight(r))
    return { ok: true, found: true, page: n }
  }
  return { ok: true, found: false }
}

/**
 * 把某处原文滚到眼前、闪一圈、并圈出来。
 *
 * 页还没渲染时（没有文字层 → Range 解析不出来）**不能就地失败**：先把位置记进
 * state.pendingLocate、把这一页排进渲染队列并滚过去，等它画好由 renderPage 接着定位。
 * 否则"从第 51 页跳到第 58 页的引用"就是一次什么都没发生（用户实测踩到的正是这个：
 * locate 在 ±3 页里找不到 → 退回按章打开 → 书重新加载后回到上次读到的第 51 页）。
 *
 * @param {{page:number,start:number,end:number}} anchor
 * @returns {boolean} 是否受理（true = 已滚过去，或已排进"画好就定位"）
 */
function scrollToAnchor(anchor) {
  const page = Math.trunc(Number(anchor && anchor.page))
  const start = Math.trunc(Number(anchor && anchor.start))
  const end = Math.trunc(Number(anchor && anchor.end))
  if (!Number.isFinite(page) || page < 1 || state.pages.length < page) return false
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) return false
  const p = state.pages[page - 1]
  if (!p) return false
  const a = { page, start, end }
  // 上一次跳引用留下的标记不留给这一次（否则屏幕上会同时有两条"你在这儿"）
  if (window.CSS && CSS.highlights) CSS.highlights.delete('rd-locate')
  if (!p.rendered || !p.layer) {
    state.pendingLocate = a
    // force：这是用户**明确要跳到这里**，不能被"布局沉降期只画附近页"的省电闸门挡掉
    //（挡掉的表现是：滚到了那一页，但那一页一直空着，定位也永远不会发生）
    enqueueRender(page, true)
    gotoPage(page, false)   // 先瞬时到位（页高还是占位值，画好之后会再落一次精确位置）
    postDebug({ stage: 'locate-wait-render', page, queued: state.renderQueue.includes(page) })
    return true
  }
  const r = resolveAnchor(a)
  const rects = r ? [...r.getClientRects()] : []
  if (!rects.length) {
    state.pendingLocate = null
    return false
  }
  const c = els.scroll.getBoundingClientRect()
  const rect = rects[0]
  // 已经在视野里就不动（同 scrollToEntry）：用户要的是"看见它"，不是"滚一下"
  const inSight = rect.top >= c.top + 40 && rect.bottom <= c.bottom - 40
  if (!inSight) {
    const delta = rect.top - (c.top + Math.min(140, c.height * 0.25))
    // 跨得远就瞬时到位：平滑滚动横跨十几页会先走一段"看起来什么都没发生"的路
    const far = Math.abs(delta) > c.height * 1.5
    cancelRestore('跳到引用的原文')
    els.scroll.scrollBy({ top: delta, behavior: far ? 'auto' : 'smooth' })
  }
  p.wrap.classList.add('rd-flash')
  clearTimeout(p._flashTimer)
  p._flashTimer = setTimeout(() => p.wrap.classList.remove('rd-flash'), 1200)
  state.pendingLocate = null
  // 用**自己的**高亮名（rd-locate）：复用 rd-src-active 的话，下一次 refreshHighlights
  // 在没有选中条目时会把这条删掉 —— 实测"跳过去的高亮活不过一次重绘"。
  if (window.CSS && CSS.highlights) CSS.highlights.set('rd-locate', new Highlight(r))
  postDebug({ stage: 'locate-applied', page, inSight, scrollTop: Math.round(els.scroll.scrollTop) })
  return true
}

/**
 * 跳到一条引用的**原文那一处**（侧栏点引用 / 「跳到原文」）。
 *
 * 为什么不能只按文字找（旧版就是，2026-10-25 用户报的 bug）：同一句话在书里常常
 * 出现不止一次。把《置身事内》的 PDF 抽成文本看，「全国预算收入」在第 56 页
 * （"中央占全国预算收入的比重从改革前的22%…"）与第 58 页（"分税制改革之后，
 * 全国预算收入占GDP的比重逐步上升…"）各一遍，只隔两页。用户划的是第 58 页，
 * locateText 只在当前页 ±3 页里找、且每页取**第一个命中**——于是落在 56，
 * 用户看到的就是"按内容跳到了最近的一处，不是我的划线"。
 *
 * 所以先按「从准到松」挑锚点（挑选逻辑是纯函数，见 reader-anchor.js 的
 * pickLocateAnchor 与它的单测）：
 *   ① refMarks（真的那笔）—— 设引用那一刻记下的位置（用户划的就是它）
 *   ② entries  —— 这条引用出身的那张译文卡的位置
 *   ③ refsSeen[].anchors —— 接收端存档随引用带回来的位置（活得过本地缓存上限）
 *   ④ refMarks（guess=true）—— 早先按文字**猜**出来的位置：可能是别的出现处，
 *      所以排在最后（它至少稳定，不随用户翻页而变）
 * 都没有（老数据）才退回"从当前页 ±3 页里按文字找"，并如实回报。
 */
function locateRef(text) {
  const want = String(text || '').trim()
  if (!want) return { ok: true, found: false, reason: 'empty' }
  const marks = Array.isArray(state.refMarks) ? state.refMarks : []
  const a = pickLocateAnchor(want, [
    // ① 用户划的那一下记下的位置（最准）
    { from: 'mark', items: marks.filter((m) => !(m && m.guess)).map((m) => ({ text: m && m.text, anchors: m && m.anchors })) },
    // ② 这条引用出身的那张译文卡（同一次划词的另一份记录，也是准的）
    { from: 'entry', items: state.entries.map((e) => ({ text: e && e.source, anchors: e && e.anchors })) },
    // ③ 接收端存档随引用带回来的位置（2026-10-25 起才有；活得过本地缓存上限）
    { from: 'record', items: refsSeen().map((r) => ({ text: r && r.selectedText, anchors: r && r.anchors })) },
    // ④ 按文字猜出来的位置（见 refRanges ③）：可能是同一句话的另一个出现位置，
    //    所以排在最后 —— 但总比"从当前页 ±3 页里再猜一次"稳（它至少不随用户翻页而变）
    { from: 'guess', items: marks.filter((m) => m && m.guess).map((m) => ({ text: m && m.text, anchors: m && m.anchors })) },
  ])
  if (a && scrollToAnchor(a)) {
    postDebug({ stage: 'locate-anchor', from: a.from, page: a.page, text: want.slice(0, 16) })
    return { ok: true, found: true, page: a.page, via: a.from }
  }
  // 老数据（本地与存档都没有锚点）：只能按文字在附近找。这条路上"找错"是可能的，
  // 所以上面的锚点优先，且这里如实回报 found —— 找不到就交给调用方退回按章打开。
  const r = locateText(want)
  postDebug({ stage: 'locate-text', found: !!(r && r.found), page: (r && r.page) || 0, text: want.slice(0, 16) })
  return r
}

/**
 * 后台点名问"你开着哪本书"（见 translate-background.js 的 readerBookInfo）。
 *
 * 回执**必须带 ok:true**：后台拿它当"这条答复确实是 bookInfo 的答复"的判据，
 * 答非所问（比如只有 book 字段）会被当成"它现在答不上来"，侧栏据此保留上一次的书。
 * loading:true = 正在打开书（深链 ?open= 刚到、还没落地），也是"还没准备好"。
 */
function readerBookInfo() {
  if (state.loadingBook) return { ok: true, loading: true, book: null }
  if (!hasBook()) return { ok: true, book: null }
  return {
    ok: true,
    book: {
      bookId: currentBookId(),
      hash: state.hash,
      name: state.name,
      page: currentPage(),
      total: bookTotal(),
    },
  }
}

/**
 * 自检页（extension/selfcheck.js）能对阅读器执行的**预定义操作**。
 *
 * 为什么是一张表而不是"执行一段代码"：自检页是**扩展页面**，但让页面能给阅读器下任意
 * 指令等于开了一个后门。这里只允许表里这些操作，参数与返回值都固定。
 *
 * 协议：selfcheck.js 发 {action:'selfcheckEval', op, arg}，这里回
 *   {ok:true, value} 或 {ok:false, error}
 * —— 回执**必须**有 ok 字段：自检那边把"空对象"当成"消息通道提前关了"（踩过）。
 */
const SELFCHECK_OPS = {
  /** 活着吗（自检第一句就问它：模块没报错才有后面那些） */
  alive: async () => 'object',

  bookName: async () => state.name || '',
  bookId: async () => currentBookId(),
  hasBook: async () => hasBook(),

  /** 状态栏那行字（"第 x / y 页"就在这里） */
  pageInfo: async () => String(els.pageinfo.textContent || ''),

  /** 打开目录并数一下条目（PDF 的书签要异步取，得等它取完再数） */
  tocOpen: async () => {
    if (els.toc.hidden) await openToc()
    return {
      open: !els.toc.hidden,
      items: els.tocList ? els.tocList.querySelectorAll('.rd-toc-item').length : 0,
    }
  },

  /** 跳到第 index 条（0 起）——PDF 走滚动 */
  tocJump: async (index) => {
    const i = Math.max(0, Number(index) || 0)
    gotoPage(i + 1, false)
    return {
      jumped: true,
      index: i,
      info: String(els.pageinfo.textContent || ''),
    }
  },

  /** 快捷键绑上了什么（写错的表现是静默失效，所以要把真相读出来） */
  commands: async () => {
    try { return await chrome.commands.getAll() } catch (e) { return [] }
  },

  /** 侧栏此刻开着几个上下文（决定"要不要调 open()"、广播有没有听众） */
  sidePanelContexts: async () => {
    try {
      const api = chrome.sidePanel
      if (!api || typeof api.getContexts !== 'function') return { supported: false }
      const list = await api.getContexts({})
      return { supported: true, count: Array.isArray(list) ? list.length : 0 }
    } catch (e) {
      return { supported: false, error: String((e && e.message) || e) }
    }
  },

  /** 「跳到原文」那条路（按原文在正文里找，不重载） */
  locateProbe: async (text) => {
    const r = locateText(String(text || ''))
    return { found: !!(r && r.found), page: (r && r.page) || 0 }
  },

  /**
   * 「设为引用」之后，被引用的那一段在书页上到底有没有标记（2026-11 用户报的 bug）。
   *
   * 自检必须能看见这件事：这条链路以前一路"成功"（后台存了、侧栏有卡片），
   * 唯独书页上什么都没画——只看返回值是发现不了的。
   */
  refMarkProbe: async () => {
    const ranges = refRanges()
    const reg = (window.CSS && CSS.highlights && CSS.highlights.get)
      ? CSS.highlights.get('rd-ref')
      : null
    return {
      ranges: ranges.length,
      registered: reg ? reg.size : 0,
      marks: Array.isArray(state.refMarks) ? state.refMarks.length : 0,
      refs: refsSeen().length,
      first: (Array.isArray(state.refMarks) && state.refMarks[0])
        ? String(state.refMarks[0].text || '').slice(0, 40)
        : '',
    }
  },

  /**
   * 当场量的位置 + 记录里存的位置。
   * 两个都要给：只给一个的话，分不清"存错了"还是"恢复错了"——而用户看到的现象一模一样。
   */
  position: async () => {
    const pos = currentPosition()
    const rec = await readOwnRecord()
    return {
      session: PAGE_SESSION,          // 这一次加载的指纹：重载后必须换一个（防旧页面回音）
      page: pos.page,
      frac: Number(Number(pos.frac).toFixed(4)),
      restoring: !!state.restore,
      storedPage: rec ? Number(rec.page) || 0 : 0,
      storedFrac: rec ? Number(rec.frac) || 0 : 0,
    }
  },

  /** 把位置摆到"第 page 页的 frac 处"，persist 时顺手落盘 */
  setPosition: async (arg) => {
    const page = Math.max(1, Number((arg && arg.page) || 1))
    const frac = clamp01((arg && arg.frac) || 0)
    gotoPage(page, false)
    // 页内比例必须在**跳完之后**再落一次：gotoPage 只滚到页顶
    applyPosition({ page, frac })
    updatePageInfo()
    syncTocPosition()
    const pos = currentPosition()
    if (arg && arg.persist) await saveRecord()
    const rec = await readOwnRecord()
    return {
      page: pos.page,
      frac: Number(Number(pos.frac).toFixed(4)),
      storedPage: rec ? Number(rec.page) || 0 : 0,
      storedFrac: rec ? Number(rec.frac) || 0 : 0,
    }
  },

  /** 在已渲染的正文里划出一段（自检要验"划词 → 浮标"这条真实链路） */
  selectParagraph: async () => {
    // pdf.js 渲染是异步的：自检刚跳过来时，目标页可能还没画出文字层。等一小会儿，顺便催渲染。
    const deadline = Date.now() + 4000
    let p = null
    while (!p && Date.now() < deadline) {
      p = state.pages.find((x) => x.rendered && x.layer && pageTextIndex(x.layer).total > 24)
      if (p) break
      const near = state.pages.find((x) => !x.rendered && isPageNear(x, 400))
      if (near) enqueueRender(near.num)
      await new Promise((r) => setTimeout(r, 120))
    }
    if (!p) return { ok: false, reason: '还没有渲染出可划的正文' }
    const range = rangeFromOffsets(p.layer, 0, 24)
    if (!range) return { ok: false, reason: '正文里没有文字节点' }
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    onSelectionSettled()
    return {
      ok: true,
      chars: String(sel.toString() || '').length,
      tipVisible: !els.tip.hidden,
      tipLabel: String(els.tipTranslate.textContent || ''),
      text: String(sel.toString() || '').slice(0, 40),
    }
  },

  /** 点一下浮标（把选中的这段设为引用） */
  submitSelection: async () => {
    const res = await referenceSelection()
    return { ok: !!(res && res.ok !== false), raw: res || null }
  },
}

/** 跑一个自检操作（找不到就如实说，不假装成功） */
async function runSelfcheckOp(op, arg) {
  const fn = SELFCHECK_OPS[op]
  if (!fn) return { ok: false, error: '未知的自检操作：' + String(op) }
  try {
    return { ok: true, value: await fn(arg) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 读**当前这本**书的进度记录（没有书 / 没存过 → null） */
async function readOwnRecord() {
  if (!state.hash) return null
  return await loadRecord(state.hash)
}

/** 后台/侧栏发来的消息（动作名与 translate-background.js 里发给页面的一致） */
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return
  /**
   * 面板被打开（侧栏的译文对照）→ 立刻把"这本书引过哪些段落"刷新一遍。
   *
   * 为什么要这一个触发点：用户点开译文对照，就是为了看译文与划线；
   * 而打开书那一刻的拉取可能失败（重启时接收端还没起来）或者还没返回。
   * 这里 force 一次，等于是"你打开面板我就再对一次账"。
   */
  if (msg.action === 'notesOpen') { refreshRefs('panel', { force: true }); return }
  if (msg.action === 'readerBookInfo') { sendResponse(readerBookInfo()); return }
  // 自检页（extension/selfcheck.js）专用的预定义操作通道，见 SELFCHECK_OPS
  if (msg.action === 'selfcheckEval') {
    runSelfcheckOp(msg.op, msg.arg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }
  if (msg.action === 'readerCommand') {
    /**
     * 多个阅读器标签页打开同一本书时，命令只能由**拥有这条记录**的页面响应。
     *
     * 为什么（2026-10-24 用户报"看快速版没用"）：后台是广播给所有扩展页面的，
     * 原来的写法是"每个页面都答一句"——没有这条记录的那个标签页会先答
     * 「未找到该条目」，于是调用方拿到的是这个错误，而真正切换成功的页面白做了。
     * 没有这条记录就**不响应**（返回 undefined，让 Chrome 把机会留给别的页面）；
     * 所有页面都没有时，后台会得到"阅读器未返回结果"，那是诚实的失败。
     */
    if (msg.id && ENTRY_SCOPED_COMMANDS.has(msg.type) && !state.entries.some((e) => e.id === msg.id)) return
    // ⚠️ 必须带 catch：onReaderCommand 里一旦抛错（不是 return ok:false），
    // Promise 会静默 reject，sendResponse 永不执行 —— 后台的 await 只能超时，
    // 面板看到的是「未返回结果」（表现为：设为引用失败，但接收端其实已经存了）。
    onReaderCommand(msg).then(sendResponse, (e) => sendResponse({
      ok: false,
      error: { code: 'READER_ERROR', message: String((e && e.message) || e) },
    }))
    return true
  }
  if (msg.action === 'boxSelect') { startBoxSelect(); sendResponse({ ok: true }); return }
  if (msg.action === 'translateSelection') { translateSelection(); sendResponse({ ok: true }); return }
  })
}
function scheduleSave() {
  const key = state.hash ? STORE_PREFIX + state.hash : ''
  if (!key) return
  if (!state.saveTimer) state.saveTimer = setTimeout(() => { state.saveTimer = null; saveRecord() }, 600)
  state.savePending = { key, name: state.name }
}

async function saveRecord() {
  const pending = state.savePending
  state.savePending = null
  // 没有排队记录（直接调用/自测）时按当前书现算一份
  const key = (pending && pending.key) || (state.hash ? STORE_PREFIX + state.hash : '')
  if (!key || !hasBook()) return
  const pos = currentPosition()          // 唯一定义：第几页 + 页内比例
  touchLibraryMeta(pos)                  // 顺手更新书库里的页数/译文条数/读到第几页
  if (typeof chrome === 'undefined' || !chrome.storage) return
  const record = {
    name: (pending && pending.name) || state.name,
    pages: bookTotal(),
    page: pos.page,
    // 页内比例（2026-11 二次改版）：老记录没有这一格 → 恢复时按 0 处理，
    // 也就是旧行为"回到那一页的顶端"，不会因为升级而把人扔到别处去
    frac: pos.frac,
    scale: state.scale,
    entries: state.entries.map((e) => ({
      id: e.id,
      kind: e.kind || 'text',
      anchors: e.anchors,
      rect: e.rect,
      page: e.page,
      source: e.source,
      translation: e.translation,
      // 「只识别了原文、没有翻译」要跟着落盘：否则重启后那张卡会变回一张普通译文卡
      //（正文仍是识别结果，只是"未翻译"的说明没了）
      recognized: !!e.recognized,
      // 精译双版本（2026-10-24 用户要求"两边切换"）：两份都落盘，重启后还能对照。
      // translation 只存**当前显示的那一版**；没有精译版的条目不必再存一份 fastText，
      // 否则每条译文都白占一倍空间（只有真走过精译的条目才存两份）
      fastText: e.preciseText ? (e.fastText || '') : '',
      preciseText: e.preciseText || '',
      showPrecise: !!e.showPrecise,
      at: e.at,
    })),
    // 已设成引用的段落：落盘是为了"重启后立刻能画下划线"（见 loadDocument 里那段说明）。
    // 它是缓存，接收端拉回来之后会被覆盖；条数上限与内存那份一致。
    refs: refsSeen().slice(0, REFS_SEEN_MAX),
    // 这些引用落在书里的哪一处（见 state.refMarks）：书页绿线靠它解析 Range，
    // 接收端的存档里没有 PDF 偏移，只能本地存
    refMarks: (Array.isArray(state.refMarks) ? state.refMarks : []).slice(0, REFS_SEEN_MAX),
    updatedAt: Date.now(),
  }
  /**
   * 防"空记录覆盖有记录的存档"（2026-10-24 实测到的数据损坏）。
   *
   * 现场：同一本书开了两个阅读器标签页，一个里有 2 条译文、另一个是空的。空的那个
   * 每次自动保存都往同一个 `rd:book:<hash>` 写 0 条，把好的那份冲掉；两个页面又各自
   * 推快照给侧栏，于是卡片在"2 条 / 0 条"之间跳（正是用户报的"一会消失一会出现"）。
   *
   * 规则：要写 0 条、而盘上那份**有条目**时，拒绝覆盖 —— 除非这次是用户自己明确删空的
   * （removeEntry / clear 会置 allowEmptySave）。宁可少存一次，不可把用户翻过的译文抹掉。
   */
  if (!record.entries.length && !state.allowEmptySave) {
    if (!state.emptySaveBlocked) {
      try {
        const prev = await chrome.storage.local.get([key])
        const old = prev && prev[key]
        if (old && Array.isArray(old.entries) && old.entries.length) {
          state.emptySaveBlocked = true
          postDebug({ stage: 'save-empty-blocked', oldEntries: old.entries.length, key: key.slice(0, 40) })
          return
        }
      } catch (e) {}
    } else {
      return
    }
  } else {
    state.emptySaveBlocked = false
  }
  try {
    await chrome.storage.local.set({ [key]: record })
    state.allowEmptySave = false
  } catch (e) {
    console.warn('[阅读器] 保存失败', e)
  }
}

/**
 * 这条记录是不是"当前这本书"的？
 *
 * 判据只有两条，都写在记录里：**书名相同**、**页数相同**。
 * 为什么不靠哈希就够：哈希是内容算出来的，本该唯一；但"同一路径下的文件被换掉"、
 * 或自测里反复喂不同样本时，旧记录会留在另一个键上，而阅读器按当前哈希读到的
 * 可能是一条**别本书**留下的（它的 name/pages 一眼能看出不对）。
 * 页数对不上尤其硬：那是 pdf.js 报的，不是我们猜的。
 */
function sameRecordBook(rec) {
  if (!rec) return false
  const nowPages = state.doc ? state.doc.numPages : 0
  if (rec.pages && nowPages && Number(rec.pages) !== Number(nowPages)) return false
  const a = String(rec.name || '').trim()
  const b = String(state.name || '').trim()
  if (a && b && a !== b) return false
  return true
}
/** 读回一本书的进度记录（裸内容哈希 → `rd:book:<hash>`） */
async function loadRecord(hash) {
  if (typeof chrome === 'undefined' || !chrome.storage) return null
  try {
    const key = STORE_PREFIX + String(hash || '')
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
// 百分比那格 = 「适宽」（2026-11 重排）：缩小/放大只在"手动缩放"时有意义，
// 而用户想回到"铺满窗口"时，那个数字就是最顺手的落点（原先 100% 时点「适宽」没反应）
// ⚠️ 必须包一层箭头函数：直接把 fitWidth 交给 addEventListener，点一下会把
// MouseEvent 当成 `cheap` 参数传进去（真值）→ 走廉价路径，行为跟预期不一样。
els.zoom.addEventListener('click', () => fitWidth())
els.tocBtn.addEventListener('click', toggleToc)
els.tocClose.addEventListener('click', closeToc)
// 点遮罩空白处也关掉（点在面板里不关）
els.toc.addEventListener('click', (ev) => { if (ev.target === els.toc) closeToc() })
els.tocRange.addEventListener('input', () => {
  // 拖动时**不要**平滑滚动：滑杆会连发十几个 input，每个都触发一次平滑滚动会打架
  gotoPage(Number(els.tocRange.value), false)
})
els.tocFirst.addEventListener('click', () => gotoPage(1))
els.tocLast.addEventListener('click', () => gotoPage(bookTotal()))
// 工具栏那枚是**切换式**（点一下进、再点一下出）；Alt+S 是一次性，两条路见 startBoxSelect
els.box.addEventListener('click', () => toggleBoxSelect())
els.boxExit.addEventListener('click', () => endBoxSelect('toggle'))
els.pages.addEventListener('mousedown', onBoxStart)
// 链接层不接鼠标事件（pointer-events: none，理由见 buildLinkLayer 上方），
// 所以点击与悬停都挂在页面容器上，按坐标算落在哪条链接上。
els.pages.addEventListener('click', onPageLinkClick)
els.pages.addEventListener('mousemove', onPageLinkHover)
els.pages.addEventListener('mouseleave', clearLinkHover)
els.notes.addEventListener('click', requestNotesOpen)
els.tipTranslate.addEventListener('click', translateSelection)
// 划词「设为引用」：不翻译，直接把选中的原文交给共读侧（2026-11）
els.tipRef.addEventListener('click', () => { referenceSelection() })
els.tipCopy.addEventListener('click', async () => {
  const hit = state.lastSelection
  if (hit) copyText(await sourceText(hit.anchors))
  hideTip()
})
// 框选动作条：翻译 / 只识别原文放进译文栏（2026-11）
els.boxTranslate.addEventListener('click', () => runBoxChoice('translate'))
els.boxRecognize.addEventListener('click', () => runBoxChoice('recognize'))

els.scroll.addEventListener('scroll', () => {
  // 框选动作条是按拖框那一刻的屏幕位置摆的；一滚动它就和框错位了，直接收起。
  // 划词浮标不在这里收：它有既有的 selectionchange / mousedown 那套（改动前就这样）。
  hideBoxTip()
  onScroll()
}, { passive: true })
/**
 * 用户一动手，就**停掉落位纠偏**（2026-11 二次改版）：纠偏的意义是"把打开时的
 * 布局漂移抵掉"，而用户自己滚了之后，"他要去的地方"已经不由旧记录决定了——
 * 这时候还接着把他往回拽，表现就是"滚不动 / 自己往回跳"。
 *
 * 为什么听这几个事件而不是 scroll：`scroll` 分不清是用户滚的还是**我们自己落位**造成的
 * （程序化 scrollTo 一样会触发它）。这几个事件只有真人才会产生。
 */
for (const evName of ['wheel', 'touchstart', 'pointerdown']) {
  els.scroll.addEventListener(evName, () => cancelRestore('用户动手：' + evName), { passive: true })
}
document.addEventListener('keydown', () => cancelRestore('用户按键'))
document.addEventListener('mouseup', () => setTimeout(onSelectionSettled, 0))
// 页面重新可见（切回这个标签页）→ 对一次账：别的路径可能刚删/刚加过引用
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshRefs('visible')
})
document.addEventListener('click', onReaderClick)
// 双击空白处（既不在译文高亮上，也没选中文字）→ 收起侧栏里的译文对照
document.addEventListener('dblclick', (ev) => {
  if (state.boxMode || state.boxChoice) return
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
  // 点在动作条自己身上时别收（先让它把 click 收到）；点别处 = 放弃这块框选
  if (!els.boxTip.contains(e.target)) hideBoxTip()
})

document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); translateSelection(); return }
  /**
   * 框选识别的快捷键：**一次性**（按一次框一次、框完自动退）。
   * 与工具栏那枚切换式按钮是两条路，各有各的顺手处——理由写在 startBoxSelect 上方。
   * `oneShot: true` 每次都要传：它同时负责"再按一次 Alt+S 时把标记改成一次性"。
   */
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    startBoxSelect({ oneShot: true })
    return
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setScale(state.scale * 1.15) }
    if (e.key === '-') { e.preventDefault(); setScale(state.scale / 1.15) }
    if (e.key === '0') { e.preventDefault(); fitWidth() }
  }
  if (e.key === 'Escape') {
    if (state.boxMode) endBoxSelect('esc')
    else hideTip()
    // 一次性模式（Alt+S）框完已经退出了，但动作条可能还开着：Esc 也要能收掉
    hideBoxTip()
  }
})

window.addEventListener('resize', () => {
  hideBoxTip()      // 动作条按旧窗口位置摆的，尺寸一变就错位
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
/**
 * 深链：`reader.html?open=<hash>`（侧栏「读」按钮经后台打开阅读器时用）。
 *
 * 为什么走 URL 而不是发消息：侧栏点击时阅读器可能**还没开**——消息没有收件人。
 * URL 是"打开时就带着意图"，新开与复用标签页两条路都成立。
 * 打开完把查询串抹掉（replaceState）：否则刷新页面会再打开一次、用户以为卡住了。
 */
async function handleOpenParam() {
  let hash = ''
  try {
    const u = new URL(location.href)
    hash = (u.searchParams.get('open') || '').toLowerCase()
    if (!/^[a-f0-9]{16,64}$/.test(hash)) return false
    // `&chapter=<n>`（可选）：打开后直接翻到第 n 页。
    // 侧栏里点一条引用要"跳回原文"，深链只带书 ID 的话打开的是上次那一页，
    // 用户会以为跳错了（2026-11 用户反馈的那条路）。
    const chapter = Number(u.searchParams.get('chapter')) || 0
    // 等书库列表回来：从书库打开要那份元信息（书名、页数）才好看
    await loadLibrary().catch(() => {})
    const hit = (state.library || []).find((b) => String(b.hash).toLowerCase() === hash)
    await openFromLibrary(hit || { hash, name: u.searchParams.get('name') || '未命名.pdf' })
    if (chapter > 0) gotoPage(chapter)
    u.searchParams.delete('open')
    u.searchParams.delete('name')
    u.searchParams.delete('chapter')
    history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
    return true
  } catch (e) {
    console.warn('[阅读器] 深链打开失败', e)
    return false
  }
}

/**
 * 深链：`reader.html?pick=1` —— 打开后**直接弹出"选 PDF 文件"那个系统窗口**。
 *
 * 谁在用：侧栏的「⋯ → 📕 PDF 阅读器」与无书界面状态卡上的按钮（见 sidebar.js 的
 * openReaderFrom）。从这两处点进来的人手里已经有文件了，落地后再让他自己找一次
 * 「打开 PDF」是白要一步。
 *
 * 为什么走 URL 而不是发消息：与 `?open=` 同一个理由——阅读器可能**还没开**，
 * 消息没有收件人；而 URL 是"打开时就带着意图"。（也因此侧栏那边用了 `chrome.tabs.create`
 * 而不是复用旧标签页：复用的话意图传不进去，用户看到的是一个上次留下的旧页面。）
 *
 * ⚠️ 两个前提，都不是想当然：
 *   ① 这是**浏览器允许**的，不是我们绕过了什么——点侧栏按钮那一下就是用户手势，
 *      而 `chrome.tabs.create` 开出来的页面里 `input.click()` 仍在那个手势的有效期内
 *      （同一条路在 `?open=` 里已经跑了一年）。若哪天浏览器收紧，表现是"窗口没弹出来，
 *      但页面好好地在空状态上" —— 用户自己点一下「打开 PDF」即可，不会卡住。
 *   ② 只在**没打开任何书**时弹（`state.hash` 为空）：复用标签页打开某一本时不该弹。
 */
function handlePickParam() {
  let want = false
  try {
    const u = new URL(location.href)
    want = u.searchParams.get('pick') === '1'
    if (!want) return false
    u.searchParams.delete('pick')
    history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
  } catch (e) {
    return false
  }
  if (state.hash) return false
  requestAnimationFrame(() => { try { els.file && els.file.click() } catch (e) {} })
  return true
}
setTimeout(() => { handleOpenParam() }, 0)
// `?pick=1` 排在深链后面：两个参数同时出现时（不会，但别留这种可能性）以"打开某一本"为准
setTimeout(() => { handlePickParam() }, 0)

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
  /** 划词翻译真正送出去的那份原文（带补回来的词间空格）——自测断言它 */
  sourceText,
  /** 划线附近各 300 字（随「设为引用」交给共读侧的上下文）——自测断言它 */
  contextAround,
  refreshHighlights,
  /** 「设为引用」之后书页上的标记（自测断言它；见 refMarkProbe 的说明） */
  refMarkInfo() {
    const reg = (window.CSS && CSS.highlights && CSS.highlights.get) ? CSS.highlights.get('rd-ref') : null
    return {
      ranges: refRanges().length,
      registered: reg ? reg.size : 0,
      marks: (state.refMarks || []).map((m) => ({
        text: String((m && m.text) || '').slice(0, 40),
        anchors: (m && m.anchors) || [],
      })),
    }
  },
  refreshCount() {
    let n = 0
    for (const e of state.entries) for (const a of e.anchors || []) if (resolveAnchor(a)) n++
    return n
  },
  // 自检用：`toggleBoxMode` 这个名字从"一次性"时代就在了，语义跟着工具栏按钮走（切换）。
  // 名字不改是因为 selfcheck.js 的操作表按名字调用，改名要两边一起动、没好处。
  toggleBoxMode: () => toggleBoxSelect(),
  toggleBoxSelect,
  startBoxSelect,
  endBoxSelect,
  translateRegion,
  /** 框选动作条与两条分流（2026-11）——自测要验"松手后不立刻翻译、选动作才走" */
  showBoxTip,
  hideBoxTip,
  runBoxChoice,
  recognizeRegionText,
  /** OCR 换行的整理（段内接回、空行保留）——自测要验它 */
  reflowOcrText,
  /** 划词「设为引用」（不翻译）——自测要验它发出的 setTranslationRef 负载 */
  referenceSelection,
  renderImageMarks,
  notesSnapshot,
  syncNotes,
  // 「已引用段落」这条链（重启后划线的持久化 / 拉取重试）——自测要直接驱动它
  refreshRefs,
  saveRecord,
  refsSeen,
  onReaderCommand,
  loadLibrary,
  openFromLibrary,
  showLibrary,
  archiveToLibrary,
  hasBook,
  currentBookId,
  // 目录与「打开侧栏」也是走自测验的东西，一并交出去
  openToc,
  closeToc,
  toggleToc,
  loadPdfOutline,
  /** 把当前选区提交为引用（点浮标那一下）——自测要验它 */
  submitSelection: referenceSelection,
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
      linkCount: state.pages.reduce((n, p) => n + ((p.links && p.links.length) || 0), 0),
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
  /** 书页上的超链接（自检要验"注释真的被铺成了可点盒子"；见 buildLinkLayer） */
  linkInfo() {
    return state.pages.flatMap((p) => (p.links || []).map((l) => {
      const r = l.el.getBoundingClientRect()
      return {
        page: p.num,
        kind: l.kind,
        url: l.url || '',
        hasDest: !!l.dest,
        action: l.action || '',
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      }
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
