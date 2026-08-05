const RECEIVER = 'http://127.0.0.1:7239'
let sseConn = null
let _lastEventId = 0  // 已收到的最新 SSE 事件 id，断线重连时用于续传（AI-006）

function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// 可靠的删除图标（SVG 描边垃圾桶，避免 🗑 emoji 在 Windows 下渲染异常/模糊）
const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>'
// 表头「删除当前引用」按钮统一填充 SVG 图标（HTML 里的 🗑 仅作兜底）
try { document.getElementById('rc-del-btn').innerHTML = ICON_TRASH } catch {}

function setDot(connected) {
  document.getElementById('dot').style.background = connected ? '#07c160' : '#ddd'
}

// AI-004：智能滚动。用户已滚回上方阅读时不强制拉到底部；仅在接近底部时跟随新内容。
function maybeAutoScroll(el) {
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  if (dist < 80) el.scrollTop = el.scrollHeight
}

// ── 引用划线数据 ──────────────────────────────────────────────────────────
const RECENT_ANNS = []
const MAX_RECENT = 50
let selectedAnn = null
// 待渲染的「引用回复」队列（FIFO）。每条引用提交 push 一项，最终完整记录到达时
// shift 队首配对渲染。SSE 事件严格有序（agent 按 chat_input 顺序处理并流式输出），
// 所以最终记录与提交按序配对——用队列取代原单个 _pendingRef，解决「前一条引用
// 回复未结束时又发一条」导致串槽/丢回复的问题（AI-006）。
let _pendingRefs = []
let _refNumCounter = 0   // 引用序号计数器
let _selectionStateRestored = false  // 是否已从存储恢复过选中状态（含显式取消）
let _pendingSelectRef = null  // 划线共读"设为当前引用"的待选标记（来自 content.js storage）

// 当前阅读的书籍（AI-001 隔离）：由 content.js 广播 / 侧栏主动查询获得。
// 切书后只显示当前书的引用与对话，其他书的上下文隐藏不删除。
let _currentBook = null  // { base, bookTitle }
// 消息书签（AI-001）：流式回复归属的书。annotation / user-popup / 书绑定聊天设置它，
// 之后的 assistant 流式气泡继承，用于按书过滤消息区。
let _thinkingBook = ''

// 消息字号（AI-002）
const FONT_SIZE_MIN = 11
const FONT_SIZE_MAX = 18
let _fontSize = 13

// 引用身份比较：bookId 带会变的 k 会话后缀（同一本书每次打开 reader 后缀都不同），
// 必须用 baseBookId 归一化后再比较，否则同一引用会因后缀不同而重复堆积。
function sameRef(a, b) {
  return !!(a && b && baseBookId(a.bookId) === baseBookId(b.bookId) && a.selectedText === b.selectedText)
}

// 精确引用匹配（AI-007）：优先按 bookmarkId / 章节位置区分同文本的多条引用，
// 都缺失才退回「书 + 原文」。删除 / 划线移除时用它，避免同文本引用连坐删除。
function refMatches(a, b) {
  if (!a || !b) return false
  if (a.bookmarkId && b.bookmarkId) return String(a.bookmarkId) === String(b.bookmarkId)
  const aPos = Number(a.chapterUidInt) > 0 && a.bookmarkRange
  const bPos = Number(b.chapterUidInt) > 0 && b.bookmarkRange
  if (aPos && bPos) {
    return baseBookId(a.bookId) === baseBookId(b.bookId) &&
      Number(a.chapterUidInt) === Number(b.chapterUidInt) &&
      String(a.bookmarkRange) === String(b.bookmarkRange)
  }
  return sameRef(a, b)
}

// ── 持久化 ────────────────────────────────────────────────────────────────
function saveState() {
  try {
    chrome.storage.local.set({
      refs: RECENT_ANNS.map(a => ({
        bookId: a.bookId, bookTitle: a.bookTitle, chapter: a.chapter,
        chapterUid: a.chapterUid, chapterUidInt: a.chapterUidInt || 0,
        bookmarkRange: a.bookmarkRange || '', bookmarkId: a.bookmarkId || '',
        selectedText: a.selectedText, refNum: a.refNum
      })),
      refNumCounter: _refNumCounter,
      selectedRef: selectedAnn ? {
        bookId: selectedAnn.bookId, bookTitle: selectedAnn.bookTitle,
        chapter: selectedAnn.chapter, chapterUid: selectedAnn.chapterUid,
        chapterUidInt: selectedAnn.chapterUidInt || 0,
        bookmarkRange: selectedAnn.bookmarkRange || '', bookmarkId: selectedAnn.bookmarkId || '',
        selectedText: selectedAnn.selectedText, refNum: selectedAnn.refNum
      } : null
    })
  } catch {}
}

async function loadState() {
  try {
    const data = await chrome.storage.local.get(['refs', 'refNumCounter', 'selectedRef', 'pendingSelectRef', 'fontSize'])
    // 恢复用户设定的消息字号（AI-002）
    if (data.fontSize) { _fontSize = data.fontSize; applyFontSize() }
    if (data.refs?.length) {
      _refNumCounter = data.refNumCounter || 0
      for (const r of data.refs) {
        RECENT_ANNS.push({ ...r })
        if (RECENT_ANNS.length > MAX_RECENT) RECENT_ANNS.shift()
      }
    }
    // selectedRef 显式为 null 表示用户取消过引用，恢复后保持"未选中"，
    // 历史回放时不再自动重新选中。仅当从未保存过选中状态（首次启动）
    // 时才允许在加载历史后自动选中最新一条。
    if (data.selectedRef !== undefined) {
      _selectionStateRestored = true
      selectedAnn = data.selectedRef
        ? (RECENT_ANNS.find(a => sameRef(a, data.selectedRef)) || null)
        : null
    }
    // 划线共读"设为当前引用"的待选标记：只读入内存，先不从 storage 删除——
    // 若本次未能成功应用（/history 失败或标注尚未入库），保留在 storage，
    // 下次面板加载时重试；只有成功应用或被更新的显式选择取代时才清除。
    if (data.pendingSelectRef) {
      _pendingSelectRef = data.pendingSelectRef
    }
  } catch {}
}

// 清除"设为当前引用"的待选标记：意图被成功应用（applySetRef/applyPendingSelect）
// 或用户做出更新的显式选择（抽屉选中、取消）时调用，避免残留待办在下次加载时
// 把旧引用强制选中。
function clearPendingSelect() {
  _pendingSelectRef = null
  try { chrome.storage.local.remove('pendingSelectRef') } catch {}
}

// 应用"设为当前引用"的待选标记：在引用列表里找到该标注并选中
function applyPendingSelect() {
  if (!_pendingSelectRef) return
  const ref = _pendingSelectRef
  // AI-001：当前书的待选引用才强制选中；其他书的等切回该书再处理
  if (_currentBook && _currentBook.base && baseBookId(ref.bookId) !== _currentBook.base) return
  const found = RECENT_ANNS.find(a => sameRef(a, ref))
  if (found) {
    // 待选引用带整数 chapterUid 时补进列表条目（旧数据可能缺失）
    if (!found.chapterUidInt && ref.chapterUidInt) { found.chapterUidInt = ref.chapterUidInt; saveState() }
    selectedAnn = found
    clearPendingSelect()
    saveState()
    renderRefUI()
  }
  // 未找到：保留 _pendingSelectRef 与 storage 中的待选标记，等后续
  // applySetRef（annotation-select SSE / 直连消息）或下次面板加载再试。
}

// 把一条标注设为"当前引用"（划线共读）：加入引用列表并强制选中，不发送任何提问。
// 触发来源：receiver 的 annotation-select SSE 事件，或 content.js 的直接消息（coreadSetRefApply）。
function applySetRef(ann) {
  if (!ann || !ann.selectedText) return
  addRecentAnn(ann)
  // AI-001：当前书之外的引用不强制选中（加入列表即可），避免聊天误绑定旧书
  if (_currentBook && _currentBook.base && baseBookId(ann.bookId) !== _currentBook.base) {
    selectedAnn = null
    saveState()
    renderRefUI()
    return
  }
  selectedAnn = ann
  saveState()
  renderRefUI()
  // 已实时应用，清除待选标记（含内存态），避免下次加载重复强制选中
  clearPendingSelect()
}

// 划线共读的直接消息通道（来自 content.js）：即使 receiver 未重启（没有 annotation-select SSE），
// 侧栏已打开时也能实时把该标注设为当前引用
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'coreadSetRefApply' && msg.ref) {
    const r = msg.ref
    applySetRef({ bookId: r.bookId, bookTitle: r.bookTitle, chapter: r.chapter || '',
      chapterUid: r.chapterUid || '', chapterUidInt: r.chapterUidInt || 0, selectedText: r.selectedText })
  }
  // AI-001：content.js 广播当前阅读书籍（切书 = 页面导航，content.js 重载即广播）
  if (msg?.action === 'coreadBookContext') {
    applyBookContext(msg)
  }
})

// 解析用户消息中的 [引用] 标记，提取引用信息
function parseRefFromContent(content) {
  const match = (content || '').match(/^\[引用\]《(.+?)》([^\n]*)\n> "(.+?)"/)
  if (!match) return null
  return { bookTitle: match[1], chapter: match[2]?.trim(), selectedText: match[3] }
}

function addRecentAnn(ann, opts = {}) {
  const dupIdx = RECENT_ANNS.findIndex(a => sameRef(a, ann))
  if (dupIdx !== -1) {
    // 已存在：保留原序号，只移到最前（避免重启回放时重新编号导致序号递增）
    const existing = RECENT_ANNS[dupIdx]
    RECENT_ANNS.splice(dupIdx, 1)
    ann.refNum = existing.refNum
    // 新对象缺划线定位字段时继承旧的：防止后续无 bookmarkId 的事件
    //（如 annotation-select / annotation）覆盖掉已同步的划线定位信息
    if (!ann.bookmarkRange && existing.bookmarkRange) ann.bookmarkRange = existing.bookmarkRange
    if (!ann.bookmarkId && existing.bookmarkId) ann.bookmarkId = existing.bookmarkId
    if (!ann.chapterUidInt && existing.chapterUidInt) ann.chapterUidInt = existing.chapterUidInt
  } else {
    _refNumCounter++
    ann.refNum = _refNumCounter
  }
  RECENT_ANNS.unshift(ann)
  if (RECENT_ANNS.length > MAX_RECENT) RECENT_ANNS.length = MAX_RECENT

  // 自动选中最新标注；历史回放（select:false）时跳过，避免覆盖已恢复/已取消的选中状态
  if (opts.select !== false) {
    if (selectedAnn && sameRef(selectedAnn, ann)) {
      selectedAnn = ann
    } else if (!selectedAnn) {
      selectedAnn = ann
    }
  }
  saveState()
  renderRefUI()
}

// 根据引用文本查找序号
function findRefNum(bookTitle, chapter, selectedText) {
  for (const a of RECENT_ANNS) {
    if (a.bookTitle === bookTitle && a.selectedText === selectedText) return a.refNum
  }
  for (const a of RECENT_ANNS) {
    if (a.bookTitle === bookTitle && selectedText && (a.selectedText || '').includes(selectedText.slice(0, 30))) return a.refNum
  }
  return ''
}

// 根据 pendingRef 信息选中对应的引用
function selectRefByPending(ref) {
  for (const a of RECENT_ANNS) {
    if (a.bookTitle === ref.bookTitle && sameRef(a, ref)) {
      selectedAnn = a
      clearPendingSelect()  // 用户显式选择取代残留待办
      saveState()
      renderRefUI()
      return
    }
  }
  for (const a of RECENT_ANNS) {
    if (a.bookTitle === ref.bookTitle && ref.selectedText &&
        (a.selectedText || '').includes(ref.selectedText.slice(0, 30))) {
      selectedAnn = a
      clearPendingSelect()  // 用户显式选择取代残留待办
      saveState()
      renderRefUI()
      return
    }
  }
}

// ── 当前引用卡片 ──────────────────────────────────────────────────────────
function renderCurrentRef() {
  const card = document.getElementById('ref-current')

  // 没有标注时隐藏卡片
  if (RECENT_ANNS.length === 0) {
    card.classList.remove('on')
    return
  }

  card.classList.add('on')

  // 没有选中引用时，显示空状态：隐藏详情/操作区，仅保留表头和提示
  if (!selectedAnn) {
    card.classList.add('empty')
    document.getElementById('rc-jump-btn').style.display = 'none'
    document.getElementById('rc-jump-back-btn').style.display = 'none'
    document.getElementById('rc-del-btn').style.display = 'none'
    document.getElementById('rc-collapse-btn').style.display = 'none'
    document.getElementById('rc-deselect-btn').style.display = 'none'
    return
  }

  card.classList.remove('empty')
  document.getElementById('rc-jump-btn').style.display = ''
  document.getElementById('rc-del-btn').style.display = ''
  document.getElementById('rc-collapse-btn').style.display = ''
  document.getElementById('rc-deselect-btn').style.display = ''
  renderJumpBack()  // AI-006：有跳转记录才显示「↩ 返回」

  document.getElementById('rc-text').textContent = selectedAnn.selectedText || ''
  document.getElementById('rc-book').textContent = selectedAnn.bookTitle || ''

  const chapter = selectedAnn.chapter || ''
  const len = (selectedAnn.selectedText || '').length
  document.getElementById('rc-meta').innerHTML =
    `${chapter ? `<span>${esc(chapter)}</span>` : ''}<span>${len} 字</span>`
}

// ── 引用列表抽屉 ──────────────────────────────────────────────────────────
let drawerSearchQuery = ''

function filterAnns() {
  // AI-001：引用按当前书隔离。有当前书时只列出该书的引用，无则全部
  let list = RECENT_ANNS
  if (_currentBook && _currentBook.base) {
    list = list.filter(a => baseBookId(a.bookId) === _currentBook.base)
  }
  const q = drawerSearchQuery.trim().toLowerCase()
  if (!q) return list
  return list.filter(a => {
    return (a.bookTitle || '').toLowerCase().includes(q) ||
      (a.chapter || '').toLowerCase().includes(q) ||
      (a.selectedText || '').toLowerCase().includes(q)
  })
}

// 搜索命中高亮：把文本按查询切分，命中的片段包 <mark>。分段后各自 esc，
// 避免先整体转义再套标签时把 &lt; 等实体的中间部分误当命中打坏。
function hl(text, q) {
  if (!q) return esc(text)
  const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${safeQ})`, 'i')
  return String(text).split(re).map(p => {
    if (p && p.toLowerCase() === q.toLowerCase()) return `<mark>${esc(p)}</mark>`
    return esc(p)
  }).join('')
}

// 查询命中是否落在概览可见区（前30字 / 后20字）。
// 命中整段都在头 30 字或尾 20 字内 → 概览已可见；横跨省略号或被遮在中间 → 需展开。
function matchVisibleInPreview(text, q) {
  const len = text.length
  if (len <= 50) return true  // 概览即全文，必然可见
  const low = text.toLowerCase()
  const qi = q.toLowerCase()
  const headEnd = 30
  const tailStart = len - 20
  let idx = low.indexOf(qi)
  while (idx !== -1) {
    const end = idx + qi.length
    if (end <= headEnd || idx >= tailStart) return true
    idx = low.indexOf(qi, idx + 1)
  }
  return false
}

function renderDrawer() {
  const list = document.getElementById('drawer-list')
  list.innerHTML = ''
  // AI-001：标题标注当前隔离范围——在读书籍时只列该书引用，未在读时才是"全部引用"
  const titleEl = document.getElementById('drawer-title')
  if (titleEl) titleEl.textContent = _currentBook && _currentBook.bookTitle
    ? `引用 · 《${_currentBook.bookTitle}》`
    : '全部引用'

  const anns = filterAnns()

  if (anns.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:0.92em;">无匹配引用</div>'
    return
  }

  const q = drawerSearchQuery.trim().toLowerCase()

  for (const ann of anns) {
    const isSel = sameRef(selectedAnn, ann)

    const raw = ann.selectedText || ''
    // 概览：前30字 + 省略号 + 后20字；50 字以内直接显示全文
    const exceeded = raw.length > 50
    const previewText = exceeded ? raw.slice(0, 30) + '…' + raw.slice(-20) : raw
    // 搜索时命中藏在省略号中间的文本 → 自动展开让命中可见（命中在概览里则保持折叠）
    const autoExpand = !!(q && exceeded && raw.toLowerCase().includes(q) && !matchVisibleInPreview(raw, q))

    const item = document.createElement('div')
    item.className = 'drawer-item' + (isSel ? ' sel' : '') + (autoExpand ? ' expanded' : '')
    // 展开/折叠按钮放在正文下方：折叠时跟在概览后面，展开时跟在全文后面
    const toggleHtml = exceeded
      ? `<span class="di-toggle">${autoExpand ? '折叠 ▲' : '展开 ▼'}</span>`
      : ''  // 全文不足 50 字：概览即全文，无需展开按钮
    item.innerHTML = `
      <div class="di-head">
        <span class="di-num">#${ann.refNum || '?'}</span>
        <span class="di-book">${hl(ann.bookTitle || '未知书', q)}</span>
      </div>
      <div class="di-chapter">${hl((ann.chapter || '').slice(0, 40), q)}</div>
      <div class="di-text">${hl(previewText, q)}</div>
      <div class="di-full">${hl(raw, q)}</div>
      ${toggleHtml}
      <div class="di-actions">
        <button class="di-jump-btn">📍 跳转</button>
        <button class="di-del-btn" title="删除这条引用">${ICON_TRASH}</button>
      </div>`

    // 点击正文区域：选中并关闭（折叠时点概览，展开时点全文）
    const selectOnClick = (e) => {
      e.stopPropagation()
      selectedAnn = ann
      clearPendingSelect()  // 用户显式选择取代残留待办
      saveState()
      closeDrawer()
      renderRefUI()
    }
    item.querySelector('.di-text')?.addEventListener('click', selectOnClick)
    item.querySelector('.di-full')?.addEventListener('click', selectOnClick)

    // 点击展开/折叠按钮
    item.querySelector('.di-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const expanded = item.classList.contains('expanded')
      item.classList.toggle('expanded')
      item.querySelector('.di-toggle').textContent = expanded ? '展开 ▼' : '折叠 ▲'
    })

    // 点击跳转按钮：在微信读书打开引用所在章节
    item.querySelector('.di-jump-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      jumpToAnnotation(ann)
    })

    // 点击删除按钮
    item.querySelector('.di-del-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteRef(ann)
    })

    list.appendChild(item)
  }
}

async function openDrawer() {
  drawerSearchQuery = ''
  document.getElementById('drawer-search').value = ''
  document.getElementById('ref-drawer').classList.add('on')
  // AI-001：打开前向活动 tab 重新查询当前书。跨 tab 的最后一次广播可能把
  // _currentBook 带偏（后台 tab 加载晚于前台），不刷新就会显示错书的引用。
  await refreshCurrentBook()
  renderDrawer()
  setTimeout(() => document.getElementById('drawer-search').focus(), 100)
}

function closeDrawer() {
  document.getElementById('ref-drawer').classList.remove('on')
}

function renderRefUI() {
  renderCurrentRef()
}

// ── 消息字号（AI-002）─────────────────────────────────────────────────────
function applyFontSize() {
  document.body.style.setProperty('--msg-font-size', _fontSize + 'px')
  const up = document.getElementById('fs-up')
  const down = document.getElementById('fs-down')
  if (up) up.disabled = _fontSize >= FONT_SIZE_MAX
  if (down) down.disabled = _fontSize <= FONT_SIZE_MIN
}

function setFontSize(n) {
  _fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n))
  applyFontSize()
  try { chrome.storage.local.set({ fontSize: _fontSize }) } catch {}
}

// ── 当前书籍上下文（AI-001）───────────────────────────────────────────────
// 头部队列显示当前书，无书时回落到格言
function renderCurrentBook() {
  const el = document.getElementById('current-book')
  if (!el) return
  if (_currentBook && _currentBook.bookTitle) {
    el.innerHTML = `《${esc(_currentBook.bookTitle)}》`
    el.title = _currentBook.bookTitle
  } else {
    el.innerHTML = '<em>We read to know we are not alone.</em>'
    el.title = ''
  }
}

// 按当前书过滤消息区：只显示标记为当前书的消息。
// 自由消息也会带上发消息时正在读的书（见 submit），切书后同样不显示。
// 无当前书（首页等）时全部显示。
function applyBookFilter() {
  const book = _currentBook ? _currentBook.base : ''
  const msgs = document.getElementById('msgs')
  for (const el of msgs.children) {
    const b = el.dataset.book || ''
    el.style.display = (!book || b === book) ? '' : 'none'
  }
  // AI-005：切书后浮窗提问列表同步刷新（只列当前书可见的提问）
  renderJumpBars()
  if (jumpFab && jumpFab.classList.contains('open')) renderJumpList()
}

// 应用阅读上下文：记录当前书；书变化时取消其他书的选中引用、刷新引用/消息过滤
function applyBookContext(ctx) {
  const rawBase = baseBookId(ctx && ctx.bookId)
  // 防御：只认形如真实书 ID 的 bookId。书架/首页等非阅读页的历史广播可能带
  // "shelf"、空串等垃圾值，若写入 _currentBook 会让引用隔离失效（AI-001）。
  const base = /^[A-Za-z0-9_]{12,}$/.test(rawBase) ? rawBase : ''
  const bookTitle = String((ctx && ctx.bookTitle) || '').trim()
  const next = base ? { base, bookTitle } : null
  const changed = !_currentBook || _currentBook.base !== base
  _currentBook = next
  if (changed) {
    // 选中引用属于其他书 → 取消选中（保留在列表里），避免聊天误绑定旧书
    if (next && selectedAnn && baseBookId(selectedAnn.bookId) !== next.base) {
      selectedAnn = null
      saveState()
    }
    renderCurrentRef()
    renderDrawer()
    applyBookFilter()
    // 切书是明确的上下文切换：滚到底部展示当前书的最新内容
    const msgs = document.getElementById('msgs')
    if (msgs) msgs.scrollTop = msgs.scrollHeight
  }
  renderCurrentBook()
}

// 侧栏打开 / 切换 tab 时，向活动的微信读书 tab 查询当前阅读上下文。
// 直接定向问活动 tab 的顶层 frame（不走 runtime 广播）：广播会被每个 content
// script 帧抢答、可能绑到非活动 tab 的书，这里点名唯一的目标（AI-008）。
// bookId 为空（如无活动阅读页）也走 applyBookContext：把当前书重置为无书状态。
async function refreshCurrentBook() {
  try {
    let ctx = null
    const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*', active: true, lastFocusedWindow: true })
    if (tab?.id) {
      try {
        ctx = await chrome.tabs.sendMessage(tab.id, { action: 'getReadingContext' }, { frameId: 0 }).catch(() => null)
      } catch {}
    }
    if (ctx && typeof ctx.bookId === 'string') applyBookContext(ctx)
    else applyBookContext({ bookId: '' })  // 无活动阅读页 → 重置为无书状态
  } catch {}
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────

// 打开引用列表（卡片上的切换引用按钮）
document.getElementById('rc-switch-btn').addEventListener('click', () => {
  openDrawer()
})

// 卡片折叠/展开
document.getElementById('rc-collapse-btn').addEventListener('click', () => {
  const card = document.getElementById('ref-current')
  const btn = document.getElementById('rc-collapse-btn')
  card.classList.toggle('collapsed')
  btn.textContent = card.classList.contains('collapsed') ? '▸' : '▾'
})

// 跳转到原文位置（微信读书原生章节 URL）
document.getElementById('rc-jump-btn').addEventListener('click', () => {
  if (selectedAnn) jumpToAnnotation(selectedAnn)
})

// 返回跳转前的位置（AI-006）
document.getElementById('rc-jump-back-btn').addEventListener('click', () => {
  jumpBack()
})

// 删除当前引用
document.getElementById('rc-del-btn').addEventListener('click', () => {
  if (selectedAnn) deleteRef(selectedAnn)
})

// 取消当前引用
document.getElementById('rc-deselect-btn').addEventListener('click', () => {
  selectedAnn = null
  clearPendingSelect()  // 显式取消：待办意图被取代
  saveState()
  renderRefUI()
})

// 关闭抽屉
document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer)
document.getElementById('ref-drawer').addEventListener('click', (e) => {
  if (e.target.id === 'ref-drawer') closeDrawer()
})

// 搜索引用
document.getElementById('drawer-search').addEventListener('input', (e) => {
  drawerSearchQuery = e.target.value
  renderDrawer()
})

// ── 字号调节（AI-002）────────────────────────────────────────────────────
try {
  document.getElementById('fs-up').addEventListener('click', () => setFontSize(_fontSize + 1))
  document.getElementById('fs-down').addEventListener('click', () => setFontSize(_fontSize - 1))
  applyFontSize()
} catch {}

// ── 消息 ────────────────────────────────────────────────────────────────────
let thinkingEl = null

function showThinking(bookId) {
  hideThinking()
  // AI-001：记录本次回复归属的书，后续 assistant 流式气泡继承此书签
  _thinkingBook = baseBookId(bookId) || ''
  const msgs = document.getElementById('msgs')
  thinkingEl = document.createElement('div')
  thinkingEl.className = 'msg-thinking'
  thinkingEl.dataset.book = _thinkingBook  // AI-001：跟随本次回复的书
  thinkingEl.innerHTML = `<div class="bubble"><span>思考中</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`
  msgs.appendChild(thinkingEl)
  applyBookFilter()
  maybeAutoScroll(msgs)
}

function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null }
}

// 去重：跟踪已显示的 assistant 消息（前 200 字指纹）
const _seenFingerprints = new Set()

function addBubble(role, content, extra, note, bookId) {
  // assistant 消息去重
  if (role === 'assistant') {
    const fp = (content || '').slice(0, 200)
    if (_seenFingerprints.has(fp)) return
    _seenFingerprints.add(fp)
    if (_seenFingerprints.size > 200) _seenFingerprints.clear()  // 防止无限增长
  }

  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')

  // AI-001：书签标记，供按书隔离消息区（引用回复走 _renderRefReply，其内单独打标）
  if (bookId) el.dataset.book = baseBookId(bookId)

  if (role === 'annotation') {
    el.className = 'msg-annotation'
    el.innerHTML = `<span class="label">📌 共读引文</span>
      ${extra ? `<div class="quote">"${esc(extra)}"</div>` : ''}
      <div class="text">${esc(content)}</div>
      ${note ? `<div class="user-note">💬 ${esc(note)}</div>` : ''}`
  } else if (role === 'user') {
    el.className = 'msg-user'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  } else if (role === 'user-popup') {
    // 来自共读弹窗的用户消息：显示引用 + 用户问题，并启动思考动画
    showThinking(bookId)
    el.className = 'msg-user'
    const quoteText = note ? `> "${esc(note)}"\n\n` : ''
    el.innerHTML = `<div class="bubble">${quoteText}${esc(content)}</div>`
  } else {
    if (_pendingRefs.length) {
      // 非流式的引用回复（如历史回放）：直接渲染完整气泡
      _renderRefReply(content)
      return
    }
    hideThinking()
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  }

  msgs.appendChild(el)
  applyBookFilter()
  maybeAutoScroll(msgs)
}

// ── 消息去重 ──────────────────────────────────────────────────────────────
// 去重只依赖 _seenMsgs：SSE 断点续传只重放客户端没收到的（lastId 分支），
// 已显示过的消息 key 都在 _seenMsgs 里；首次连接不再回放（见 receiver），
// 所以不再需要 _historyMaxTs 这类「跳过早于 history」的守卫。
// 例外：annotation-select（设为当前引用）幂等且不产生气泡，在 connect() 里
// 走到这里之前单独处理，不参与去重（它的 key 是常量，去重会误伤第 2 次起）。
const _seenMsgs = new Set()

function _msgKey(d) {
  // 标注事件无 timestamp，content 是《书名》章节——同章节两条标注 content 相同，
  // 若沿用统一 key 会被去重误杀第 2 条起。改用原文+批注区分（AI-006）。
  if (d.role === 'annotation') {
    return `annotation|${String(d.selectedText || '').slice(0, 80)}|${String(d.userNote || '').slice(0, 80)}`
  }
  return `${d.role || ''}|${d.timestamp || 0}|${(d.content || '').slice(0, 40)}`
}

function _isDuplicate(d) {
  const key = _msgKey(d)
  if (_seenMsgs.has(key)) return true
  _seenMsgs.add(key)
  return false
}

// ── 流式渲染 ──────────────────────────────────────────────────────────────
// 不变量：一条回复只产生一个气泡。chunk 合并进同一个 _streamEl；-1 标记只置
// 完成标志；流结束后的最终记录由 connect() 跳过（内容已在流里显示）或用于
// 渲染引用回复的完整气泡——绝不走 addBubble 再建一个。
let _streamEl = null
let _streamDone = false

function _handleStream(d) {
  if (d._stream === -1) {
    // 流结束标记：清掉气泡指针（内容已在 DOM 里），置完成标志等最终记录
    _streamEl = null
    _streamDone = true
    _thinkingBook = ''  // AI-001：本条回复的书签使命结束
    return
  }
  // 引用回复（_pendingRefs 队列非空）：未完成输出前不显示，保持思考动画，
  // 等最终完整记录到达后由 connect() 一次渲染带引用的气泡
  if (_pendingRefs.length) return

  // 普通回复：打字机，合并渲染进同一个气泡
  hideThinking()
  if (!_streamEl) {
    const msgs = document.getElementById('msgs')
    _streamEl = document.createElement('div')
    _streamEl.className = 'msg-assistant'
    _streamEl.dataset.book = _thinkingBook  // AI-001：继承本次回复归属的书
    _streamEl.innerHTML = `<div class="bubble"></div>`
    msgs.appendChild(_streamEl)
    applyBookFilter()
  }
  _streamEl.querySelector('.bubble').textContent = d.content || ''
  // AI-004：流式时不强制拉滚动条到底部，仅用户接近底部时跟随
  maybeAutoScroll(_streamEl.parentElement)
}

// 渲染一条「带引用的完整回复」气泡：引用回复在流式结束后（或非流式消息）调用，
// 提取自原 addBubble 的 ref-reply 分支，供两种路径复用。
function _renderRefReply(content) {
  const ref = _pendingRefs.shift()  // AI-006：按提交顺序 shift，避免串槽
  if (!ref) return
  hideThinking()
  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')
  el.className = 'msg-assistant ref-reply'
  // AI-001：引用回复归属该书
  if (ref.bookId) el.dataset.book = baseBookId(ref.bookId)
  const book = esc(ref.bookTitle || '')
  const chapter = esc((ref.chapter || '').slice(0, 12))
  const num = findRefNum(ref.bookTitle, ref.chapter, ref.selectedText)
  const snippet = esc((ref.selectedText || '').slice(0, 80))
  // 注意：不要用带前导空白的模板字符串，bubble 是 white-space:pre-wrap，
  // 前导换行/空格会在气泡顶部渲染出一大片空白。
  el.innerHTML =
    `<div class="ref-bar" data-ref-num="${num}">` +
      `<span class="ref-book">${book}</span>` +
      (chapter ? `<span class="ref-chapter">${chapter}</span>` : '') +
      `<span class="ref-num">#${num || '?'}</span>` +
    `</div>` +
    `<div class="bubble">` +
      `<div class="ref-quote-preview" data-ref-num="${num}">"${snippet}${(ref.selectedText || '').length > 80 ? '…' : ''}"</div>` +
      `${esc(content)}` +
    `</div>`

  // 点击引用条或预览 → 切换当前引用
  el.querySelector('.ref-bar')?.addEventListener('click', () => selectRefByPending(ref))
  el.querySelector('.ref-quote-preview')?.addEventListener('click', () => selectRefByPending(ref))

  msgs.appendChild(el)
  applyBookFilter()
  maybeAutoScroll(msgs)
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  if (sseConn) return
  // 断线重连时带 lastId 续传：只重放上次断开后没收到的事件（AI-006）。
  // 首次连接 _lastEventId=0 → 不带参数 → receiver 不回放（历史由 /history 加载）。
  const q = _lastEventId > 0 ? `?lastId=${_lastEventId}` : ''
  sseConn = new EventSource(`${RECEIVER}/events${q}`)
  sseConn.onopen = () => setDot(true)
  sseConn.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      if (d._seq) _lastEventId = Math.max(_lastEventId, d._seq)  // 记录进度，供续传
      if (d.type === 'connected') { setDot(true); return }
      if (d.type !== 'message') return

      // 流式记录（chunk / -1 结束标记）
      if (d._stream !== undefined) {
        _handleStream(d)
        return
      }

      // 流刚结束后的最终完整记录：普通回复内容已在流里显示过，直接跳过；
      // 引用回复（_pendingRefs 队列非空）此时才一次渲染带引用的完整气泡。
      if (_streamDone && d.role === 'assistant') {
        _streamDone = false
        _seenMsgs.add(_msgKey(d))  // 登记，防 SSE 回放重复
        _renderRefReply(d.content)  // 队列非空才渲染引用气泡，内部按序 shift
        return
      }

      // 「设为当前引用」不产生气泡、applySetRef 幂等，不参与消息去重：
      // 该事件无 timestamp/content，去重 key 恒为常量，会误伤第 2 次起的设置。
      if (d.role === 'annotation-select') {
        applySetRef({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
          chapterUid: d.chapterUid, chapterUidInt: d.chapterUidInt || 0, selectedText: d.selectedText })
        return
      }

      // 微信读书划线同步：划线立即成为引用并设为当前引用（可见的"反应"）。
      // 复用 applySetRef 的选中逻辑（当前书之外不强制选中），不弹气泡。
      if (d.role === 'annotation-sync') {
        if (d.bookId && d.selectedText) {
          applySetRef({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter || '',
            chapterUid: '', chapterUidInt: d.chapterUidInt || 0,
            bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
            selectedText: d.selectedText })
        }
        return
      }

      // 划线在微信读书里被删除（用户点「删除划线」）：同步移除引用列表 + 刷新书页共读标记
      if (d.role === 'annotation-removed') {
        const removed = d.removed || []
        for (const r of removed) {
          for (let i = RECENT_ANNS.length - 1; i >= 0; i--) {
            if (refMatches(RECENT_ANNS[i], r)) RECENT_ANNS.splice(i, 1)  // AI-007：精确匹配，避免连坐
          }
        }
        if (removed.length) {
          saveState()
          renderRefUI()
          renderDrawer()  // 若抽屉开着，让被删引用从列表消失
          try { chrome.runtime.sendMessage({ action: 'refreshCoReadMarks' }) } catch {}
        }
        return
      }

      if (_isDuplicate(d)) return
      if (d.role === 'assistant') {
        addBubble('assistant', d.content)
      } else if (d.role === 'user-popup') {
        // 来自共读弹窗的用户消息（AI-001：引用回复绑定该书）
        _pendingRefs.push({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter, selectedText: d.selectedText })
        addBubble('user-popup', d.content, null, d.selectedText, d.bookId)
        // 弹窗发送的标注要实时加入引用列表（标注记录 silent:true，receiver 不会推 annotation 事件）
        if (d.bookId && d.selectedText) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, selectedText: d.selectedText })
        }
      } else if (d.role === 'annotation') {
        showThinking(d.bookId)
        addBubble('annotation', d.content, d.selectedText, d.userNote, d.bookId)
        addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
          chapterUid: d.chapterUid, selectedText: d.selectedText })
      }
    } catch {}
  }
  sseConn.onerror = () => {
    setDot(false)
    sseConn.close()
    sseConn = null
    setTimeout(connect, 5000)
  }
}

// ── 发送 ─────────────────────────────────────────────────────────────────────
async function submit() {
  const input = document.getElementById('input')
  const content = input.value.trim()
  if (!content) return
  input.value = ''
  input.style.height = 'auto'
  // AI-001：消息归属当前书——有选中引用归引用书；否则归正在阅读的书，
  // 自由消息也带上"在哪本书里聊起来的"标记，切书后不显示
  const msgBook = selectedAnn ? selectedAnn.bookId : (_currentBook ? _currentBook.base : '')
  addBubble('user', content, null, null, msgBook)
  showThinking(msgBook)

  const body = { content }

  if (selectedAnn) {
    // AI-001：引用回复气泡按 bookId 打书签隔离；入队等最终记录配对（AI-006）
    _pendingRefs.push({ bookId: selectedAnn.bookId, bookTitle: selectedAnn.bookTitle, chapter: selectedAnn.chapter, selectedText: selectedAnn.selectedText })
    body.bookId = selectedAnn.bookId
    body.bookTitle = selectedAnn.bookTitle
    body.chapter = selectedAnn.chapter || ''
    body.chapterUid = selectedAnn.chapterUid || ''
    body.selectedText = selectedAnn.selectedText
    body.content = `[引用]《${selectedAnn.bookTitle}》${selectedAnn.chapter || ''}\n> "${selectedAnn.selectedText}"\n\n${content}`
  } else {
    // 自由提问：不入队。不能清空 _pendingRefs——前一条引用回复若还在流式，
    // 其最终记录仍需要自己的队项配对；队项在最终记录到达时由 _renderRefReply
    // 消费，正常流程不会残留（AI-006）。
    // 自由消息也把当前书标记传给 receiver，落库后历史回放能按书归属（AI-001）
    if (_currentBook && _currentBook.base) {
      body.bookId = _currentBook.base
      body.bookTitle = _currentBook.bookTitle || ''
    }
  }

  try {
    await fetch(`${RECEIVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.warn('[CoRead] chat POST failed:', e.message)
    // 发送失败：消息没到 receiver，agent 不会回复。撤销思考动画并清掉待渲染
    // 引用，否则下一条真实回复会被过期引用污染（引用条错标、气泡不显示）。
    _pendingRefs = []  // 本条没到 receiver、agent 不会回复，清掉待渲染引用防污染
    hideThinking()
  }
}

document.getElementById('send-btn').addEventListener('click', submit)
document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
})
document.getElementById('input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(this.scrollHeight, 120) + 'px'
})

// 从完整 bookId 提取基础 bookId（去掉末尾 k 会话后缀），用于归一化比较
function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

// ── 跳转到微信读书原文（用 WeRead 原生章节 URL，不依赖 DOM） ──────────────
// 微信读书阅读器按 {bookId}k{chapterUid} 定位章节，k 后缀是内部编码。
// 已从阅读器 JS 逆向出 encode()/decode() 并用真实数据验证（2026-08-05）：
//   encode("CB_5mV8e38bN3LX70d71Y1rh59U") = "ee442b8364...f24"（书 ID 路径段）
//   encode(158) = "06432b4029e064096632ab8"（静静顿河 URL k 后缀，getProgress chapterUid 一致）
// 编码规则：MD5 前缀3 + 类型位('3'数字/'4'字符) + '2' + MD5 尾2 + 十六进制长度
//   + 内容（数字按9位分组转hex / 字符按 charCode）+ 长度不足20补 MD5 前几位 + MD5 校验3位。
// MD5 用纯 JS 实现（blueimp，已验证与 node crypto 对 ASCII 输入一致；encode 的
// 输入全是 ASCII——整数 chapterUid 与 bookId）。
function md5(s) {
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3]
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586)
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330)
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426)
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983)
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417)
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162)
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101)
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329)
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632)
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302)
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083)
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848)
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690)
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501)
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784)
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734)
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463)
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556)
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353)
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640)
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222)
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189)
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835)
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651)
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415)
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055)
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606)
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799)
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744)
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649)
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379)
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551)
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3])
  }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b)
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t) }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t) }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t) }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t) }
  function md51(s) {
    var n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i
    for (i = 64; i <= s.length; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)))
    s = s.substring(i - 64)
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3)
    tail[i >> 2] |= 0x80 << ((i % 4) << 3)
    if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0 }
    tail[14] = n * 8; md5cycle(state, tail); return state
  }
  function md5blk(s) {
    var md5blks = [], i
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24)
    }
    return md5blks
  }
  function rhex(n) {
    var s = '', j
    for (j = 0; j < 4; j++) s += md5HexChars[(n >> (j * 8 + 4)) & 0x0f] + md5HexChars[(n >> (j * 8)) & 0x0f]
    return s
  }
  function hex(x) { for (var i = 0; i < x.length; i++) x[i] = rhex(x[i]); return x.join('') }
  function add32(a, b) { return (a + b) & 0xffffffff }
  var md5HexChars = '0123456789abcdef'.split('')
  return hex(md51(s))
}

// 「返回跳转前位置」状态：跳转时记住原 tab URL，点击 ↩ 恢复（AI-006）。
let jumpBackPos = null  // { url }

// 从存储的 chapterUid 提取 WeRead 认识的原生 hash 槽位（e_0 / t_1）
// 兼容两种存储格式：原始槽位 "e_0"，或拼接名 "中文版前言_e_0"
function toWereadHashSlot(chapterUid) {
  const s = String(chapterUid || '')
  if (/^[te]_\d+$/.test(s)) return s
  const m = s.match(/(?:^|_)([te]_\d+)$/)
  return m ? m[1] : ''
}

// 微信读书 reader URL 编码（逆向自阅读器 JS，已用真实数据验证）
function weReadEncode(input) {
  if (typeof input === 'number') input = String(input)
  if (typeof input !== 'string') return ''
  const h = md5(input)
  let out = h.substr(0, 3)
  const body = (() => {
    if (/^\d*$/.test(input)) {
      const arr = []
      for (let i = 0; i < input.length; i += 9) {
        arr.push(parseInt(input.substr(i, Math.min(i + 9, input.length))).toString(16))
      }
      return ['3', arr]
    }
    let s = ''
    for (let i = 0; i < input.length; i++) s += input.charCodeAt(i).toString(16)
    return ['4', [s]]
  })()
  out += body[0]
  out += '2' + h.substr(h.length - 2, 2)
  for (let j = 0; j < body[1].length; j++) {
    let lenHex = body[1][j].length.toString(16)
    if (lenHex.length === 1) lenHex = '0' + lenHex
    out += lenHex
    out += body[1][j]
    if (j < body[1].length - 1) out += 'g'
  }
  if (out.length < 20) out += h.substr(0, 20 - out.length)
  out += md5(out).substr(0, 3)
  return out
}

// 跳转：URL 导航到微信读书章节。
// {baseBookId}k{encode(chapterUidInt)} 是微信读书原生章节 URL，跳到正确章节；
// 旧标注缺 chapterUidInt 时用 hash 槽位 / /find-chapter 兜底；导航后内容脚本
// 靠 pendingJump（storage）在书页里滚动高亮引用的句子（AI-006）。
async function jumpToAnnotation(ann) {
  try {
    const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
    const base = baseBookId(ann.bookId)
    if (!base) { console.warn('[CoRead] jump: missing bookId'); return }

    // 记住当前位置供「↩ 返回」（AI-006，恢复跳转前章节）
    if (tab && tab.url) {
      jumpBackPos = { url: tab.url }
      renderJumpBack()
    }

    // 章节定位优先级：chapterUidInt → k-suffix URL（精确）；
    //   缺失时用 chapterUid 原生 hash 槽位（e_0/t_1）→ #slot；
    //   再缺失用引用文字在本地正文缓存反查（/find-chapter）→ chapterUid 或 slot。
    const uid = Number(ann.chapterUidInt) || 0
    let url = `https://weread.qq.com/web/reader/${base}`
    let located = uid > 0
    if (uid > 0) {
      try {
        const k = weReadEncode(uid)
        if (k) { url += 'k' + k } else { located = false }
      } catch { located = false }
    }
    if (!located) {
      const slot = toWereadHashSlot(ann.chapterUid || '')
      if (slot) {
        url += '#' + slot
      } else if (ann.selectedText) {
        try {
          const r = await fetch(`${RECEIVER}/find-chapter?bookId=${encodeURIComponent(ann.bookId)}` +
            `&text=${encodeURIComponent(ann.selectedText.slice(0, 60))}`)
          const j = await r.json()
          if (j && Number(j.chapterUid) > 0) {
            const k = weReadEncode(Number(j.chapterUid))
            if (k) url += 'k' + k
          } else if (j && j.slot) {
            url += '#' + j.slot
          }
        } catch {}
      }
    }

    // 先把待定位的引用原文写进 storage，内容脚本在目标页加载后用它在书页里
    // 滚动高亮（AI-006，恢复跳转后定位引用的句子；storage 交给帧内自行消费）。
    if (ann.selectedText) {
      try {
        await chrome.storage.local.set({
          pendingJump: { bookId: ann.bookId, selectedText: ann.selectedText, ts: Date.now() },
        })
      } catch {}
    }

    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true })
    } else {
      await chrome.tabs.create({ url, active: true })
    }
  } catch (e) {
    console.warn('[CoRead] jump failed:', e.message)
  }
}

// 返回跳转前的位置（AI-006）
async function jumpBack() {
  try {
    if (!jumpBackPos || !jumpBackPos.url) return
    // 返回时同时清掉待定位目标，避免恢复的页面再次被高亮定位
    try { await chrome.storage.local.remove('pendingJump') } catch {}
    const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
    if (tab) await chrome.tabs.update(tab.id, { url: jumpBackPos.url, active: true })
    jumpBackPos = null
    renderJumpBack()
  } catch (e) {
    console.warn('[CoRead] jump back failed:', e.message)
  }
}

function renderJumpBack() {
  const btn = document.getElementById('rc-jump-back-btn')
  if (!btn) return
  btn.style.display = jumpBackPos ? 'inline-block' : 'none'
}

// ── 删除引用 ────────────────────────────────────────────────────────────────
// 从侧栏列表 + chrome.storage.local 移除，并尽力同步删除 receiver 存档 + 书页共读标记。
// 本地列表是 UI 的唯一事实来源：乱码 / 仅存在于 storage 的引用在 annotations.jsonl 里
// 没有对应行，receiver 会返回 deleted:0。若依赖它的确认才移除，这类引用将永远删不掉，
// 所以本地移除不依赖 receiver 结果（receiver 同步是 best-effort）。
// 自绘确认弹窗：扩展页面不能用原生 confirm()（Chrome 压制并恒返回假），
// 这里用侧栏内的 overlay + 确认/取消按钮替代，返回 Promise<boolean>。
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay')
    document.getElementById('confirm-title').textContent = title
    document.getElementById('confirm-msg').textContent = message
    overlay.classList.add('on')
    const okBtn = document.getElementById('confirm-ok-btn')
    const cancelBtn = document.getElementById('confirm-cancel-btn')
    const cleanup = () => {
      overlay.classList.remove('on')
      okBtn.removeEventListener('click', onOk)
      cancelBtn.removeEventListener('click', onCancel)
      overlay.removeEventListener('click', onBg)
      document.removeEventListener('keydown', onKey)
    }
    const onOk = () => { cleanup(); resolve(true) }
    const onCancel = () => { cleanup(); resolve(false) }
    const onBg = (e) => { if (e.target === overlay) onCancel() }
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onOk()
    }
    okBtn.addEventListener('click', onOk)
    cancelBtn.addEventListener('click', onCancel)
    overlay.addEventListener('click', onBg)
    document.addEventListener('keydown', onKey)
    cancelBtn.focus()  // 默认聚焦「取消」，防止误触回车直接删除
  })
}

async function deleteRef(ann) {
  if (!ann?.bookId || !ann?.selectedText) return
  const ok = await showConfirm('删除这条引用？', '删除后书页里的共读标记也会移除。')
  if (!ok) return

  // 先从本地移除匹配项（AI-007：按 bookmarkId/章节位置精确匹配，避免同文本连坐删除）
  for (let i = RECENT_ANNS.length - 1; i >= 0; i--) {
    if (refMatches(RECENT_ANNS[i], ann)) RECENT_ANNS.splice(i, 1)
  }
  // 若删的是当前选中的引用，清空选中态
  if (refMatches(selectedAnn, ann)) selectedAnn = null
  saveState()
  renderRefUI()
  renderDrawer()  // 若抽屉开着，刷新列表让删除项消失

  // 尽力同步删除 receiver 的 annotations.jsonl 存档（失败不影响本地移除）。
  // 带上 bookmarkId/章节位置让 receiver 走精确匹配，同文本的其他引用不被误删（AI-007）。
  try {
    const r = await fetch(`${RECEIVER}/annotation-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: ann.bookId, selectedText: ann.selectedText, chapter: ann.chapter || '',
        bookmarkId: ann.bookmarkId || '', chapterUidInt: ann.chapterUidInt || 0,
        bookmarkRange: ann.bookmarkRange || '',
      }),
    })
    const j = await r.json()
    if (!j || !j.deleted) console.warn('[CoRead] delete: no archived record to remove', j)
  } catch (e) {
    console.warn('[CoRead] delete receiver sync failed:', e.message)
  }
  // 通知 content script 刷新共读标记（删掉的段落不再高亮）。
  // 必须在 receiver 删除完成之后发，否则重新拉取的 /annotations 仍含已删引用，
  // 绿色共读标记会被重新画回来（删了又出现）。
  try { chrome.runtime.sendMessage({ action: 'refreshCoReadMarks' }) } catch {}

  // 若是微信读书划线同步来的引用，同步删除微信读书里的划线。
  // 有持久化 bookmarkId 就直传（content script 直接可用，绕开内存映射/frame 差异）；
  // 没有则传章节+range，由 content script 按映射/构造/bookmarklist 兜底解析。
  if (ann.bookmarkId || (ann.bookmarkRange && Number(ann.chapterUidInt) > 0)) {
    try {
      const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'removeWeReadUnderline', bookId: ann.bookId,
          chapterUidInt: ann.chapterUidInt || 0, range: ann.bookmarkRange || '',
          bookmarkId: ann.bookmarkId || '',
        }, { frameId: 0 }).catch(() => {})
      }
    } catch {}
  }
}

async function loadHistory() {
  try {
    const items = await fetch(`${RECEIVER}/history`).then(r => r.json())
    // 引用列表已由 loadState() 从本地恢复；这里把历史里尚未加入的标注补进来
    // （例如侧栏关闭期间新增的标注）。addRecentAnn 内部按 bookId+selectedText 去重，
    // 已存在的引用不会重排/重新编号，select:false 也不会覆盖恢复的选中状态。
    let histPendingRef = null
    let histBook = ''  // AI-001：历史游走中当前的书上下文，assistant 回复继承
    for (const d of items) {
      if (d.role === 'annotation') {
        if (d.bookId) histBook = baseBookId(d.bookId)
        addBubble('annotation', d.content, d.selectedText, d.userNote, d.bookId)
        // 已在本地的引用不重复添加；侧栏关闭期间新增的标注补进来
        // （select:false 避免覆盖恢复的选中/取消选中状态）
        const exists = RECENT_ANNS.some(a => sameRef(a, d))
        if (!exists) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, chapterUidInt: d.chapterUidInt || 0,
            bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
            selectedText: d.selectedText }, { select: false })
        }
      }
      else if (d.role === 'user') {
        if (d.bookId) histBook = baseBookId(d.bookId)
        // 无 bookId 的旧自由消息：沿用当前书上下文做最佳归属（AI-001），
        // 不切断书签链——它是在该书讨论期间发出的
        addBubble('user', d.content, null, null, d.bookId || histBook)
        // 解析 [引用] 标记，关联后续 assistant 回复
        const ref = parseRefFromContent(d.content)
        if (ref) { histPendingRef = ref; if (d.bookId) histPendingRef.bookId = d.bookId }
      }
      else if (d.role === 'assistant') {
        _pendingRefs = histPendingRef ? [histPendingRef] : []
        histPendingRef = null
        addBubble('assistant', d.content, null, null, histBook)
      }
    }
    // 对账清理：划线同步来的引用（带 bookmarkRange）必然存在于 annotations.jsonl，
    // 会在 /history 里返回。若微信读书里删了划线（可能发生在侧栏关闭期间），对应标注
    // 已从存档移除、/history 不再返回，这里把本地列表里的幽灵引用清掉，避免重开侧栏又冒出来。
    {
      const histAnnKeys = new Set()
      for (const d of items) {
        if (d.role === 'annotation') {
          histAnnKeys.add(baseBookId(d.bookId) + '::' + String(d.selectedText || '').replace(/\s+/g, ''))
        }
      }
      for (let i = RECENT_ANNS.length - 1; i >= 0; i--) {
        const a = RECENT_ANNS[i]
        if (!a.bookmarkRange) continue  // 手动弹窗引用不在这套数据里，不误删
        const key = baseBookId(a.bookId) + '::' + String(a.selectedText || '').replace(/\s+/g, '')
        if (!histAnnKeys.has(key)) RECENT_ANNS.splice(i, 1)
      }
    }
    // 首次启动（本地从未保存选中状态）：默认选中最新的一条标注
    if (!_selectionStateRestored && !selectedAnn && RECENT_ANNS.length) {
      selectedAnn = RECENT_ANNS[0]
      saveState()
    }
  } catch {}
  // 划线共读"设为当前引用"：无论 /history 是否成功都尝试应用待选引用。
  // 引用列表已由 loadState() 从本地恢复，待选引用若就在本地引用里可直接选中；
  // /history 失败（receiver 未启动）或标注尚未入库时保留待选标记，下次加载再试。
  applyPendingSelect()
  // 恢复的引用列表可能没有触发 addRecentAnn 的渲染，这里统一刷新一次
  renderRefUI()
}

// ── 提问位置浮窗（AI-005）───────────────────────────────────────────────────
// 仿 DeepSeek 网页版：右侧小浮窗列出本会话里的提问，点击条目直接滚动到对应
// 消息并高亮，不用在长聊天记录里翻找。
const jumpFab = document.getElementById('jump-fab')
const jumpListEl = document.getElementById('jump-list')
let _jumpTargets = []  // 与浮窗列表条目一一对应的用户消息元素

// 提取一条用户消息的提问摘要：跳过引用行（> 开头）和 [引用] 头部，取首行正文
function questionSnippet(el) {
  const bubble = el.querySelector('.bubble')
  if (!bubble) return ''
  const lines = String(bubble.textContent || '').split('\n')
  for (const l of lines) {
    const t = l.trim()
    if (t && !t.startsWith('>') && !t.startsWith('[引用]')) return t
  }
  return (lines[0] || '').trim()
}

// 收集当前可见区（按书过滤后）的用户提问消息
function collectQuestions() {
  const out = []
  const msgs = document.getElementById('msgs')
  for (const el of msgs.children) {
    if (el.style.display === 'none') continue
    if (!el.classList.contains('msg-user')) continue
    out.push(el)
  }
  return out
}

// 折叠态横杠数量随提问数动态变化：<10 有几条显示几条，≥10 只显示 10 条
//（更多提问靠展开面板的滚动条查看）。0 条提问时整个浮窗隐藏。
// 计算当前视口所在的「提问+回答」域对应的提问序号：提问 i 与其回答构成一个域，
// 顶部已滚过、且最靠下的那个提问即为当前域。视口落在哪个域，就高亮哪根横杠。
function computeJumpActive() {
  const msgs = document.getElementById('msgs')
  if (!msgs) return -1
  const n = _jumpTargets.length
  if (n === 0) return -1
  const msgsRect = msgs.getBoundingClientRect()
  let active = -1
  for (let i = 0; i < n; i++) {
    // 消息相对可视区顶部的偏移（已滚出顶部为负）；用 getBoundingClientRect 而非
    // offsetTop，避免依赖 offsetParent 不是 #msgs 时的相对基准偏差
    const relTop = _jumpTargets[i].getBoundingClientRect().top - msgsRect.top
    if (relTop <= 8) { active = i; continue }
    break  // 之后的提问还没滚到顶部，仍在上一个域内
  }
  if (active === -1) active = 0  // 最上方还没到第一个提问时高亮第一条
  // 兜底：滚到最底部时，若最后一条提问仍在视口内（末尾内容太短推不到顶），
  // 直接选中最后一条，避免聊天末尾高亮停在倒数第二条
  if (active < n - 1 && msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 2) {
    const lastRelTop = _jumpTargets[n - 1].getBoundingClientRect().top - msgsRect.top
    if (lastRelTop < msgs.clientHeight) active = n - 1
  }
  return active
}

// 把选中态落到折叠横杠上：与当前域对应的那根横杠高亮（超出已显示条数则不高亮）
function applyJumpBarActive(active) {
  const btn = document.getElementById('jump-fab-btn')
  if (!btn) return
  btn.querySelectorAll('.jbar').forEach((b, i) => b.classList.toggle('sel', i === active))
}

function renderJumpBars() {
  if (!jumpFab) return
  const btn = document.getElementById('jump-fab-btn')
  if (!btn) return
  _jumpTargets = collectQuestions()  // 折叠态也能算当前域
  const n = Math.min(_jumpTargets.length, 10)
  btn.innerHTML = ''
  for (let i = 0; i < n; i++) {
    const bar = document.createElement('span')
    bar.className = 'jbar'
    btn.appendChild(bar)
  }
  jumpFab.style.display = _jumpTargets.length === 0 ? 'none' : ''
  applyJumpBarActive(computeJumpActive())
}

// 完整内容 tooltip：在卡片内条目上方显示，避开右缘把手
function showJumpTip(item, text) {
  const tip = document.getElementById('jump-tip')
  if (!tip) return
  tip.textContent = text
  tip.classList.add('on')
  const fab = document.getElementById('jump-fab')
  if (fab) {
    const fabRect = fab.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    let top = itemRect.top - fabRect.top - tip.offsetHeight - 8
    const maxTop = fabRect.height - tip.offsetHeight - 8
    top = Math.max(8, Math.min(top, maxTop))
    tip.style.top = Math.round(top) + 'px'
  }
}

function hideJumpTip() {
  const tip = document.getElementById('jump-tip')
  if (tip) tip.classList.remove('on')
}

// 把 #msgs 滚到指定内容坐标（块顶部对齐容器顶部）。
// 不用 scrollIntoView / rAF 动画：面板展开时 #msgs 的滚动监听会干扰前者，后者在
// 部分环境（无头浏览器）下帧回调不稳定。直接赋值 scrollTop 在各类环境都可靠。
function scrollMsgsTo(target) {
  const msgs = document.getElementById('msgs')
  if (!msgs) return
  msgs.scrollTop = target
  updateJumpActive()  // 立即刷新"当前提问"高亮
}

function jumpToQuestion(el) {
  // 先准备好高亮（强制回流）再滚动，避免滚动期间被样式变更干扰
  el.classList.remove('jump-flash')
  void el.offsetWidth
  el.classList.add('jump-flash')
  setTimeout(() => el.classList.remove('jump-flash'), 1500)
  const msgs = document.getElementById('msgs')
  if (!msgs) return
  // 计算该提问在内容坐标系里的位置（块顶部对齐容器顶部 = scrollIntoView block:start）
  const target = el.getBoundingClientRect().top - msgs.getBoundingClientRect().top + msgs.scrollTop
  scrollMsgsTo(target)
}

// 高亮当前视口正在看的提问（仿 DeepSeek 滚动导航：列表随聊天滚动实时定位）。
// 取"顶部已滚过、且最靠下的那个提问"作为当前项——聊天滚到哪一段，就高亮哪一问。
function updateJumpActive() {
  if (!jumpListEl || !jumpFab.classList.contains('open')) return
  const msgs = document.getElementById('msgs')
  if (!msgs) return
  const active = computeJumpActive()
  const items = jumpListEl.querySelectorAll('.jump-item')
  items.forEach((it, i) => it.classList.toggle('active', i === active))
  // 让高亮项在面板内保持可见：手动算 scrollTop，不用 scrollIntoView——
  // scrollIntoView 在 #msgs 的滚动事件里调用，会取消正在进行的平滑滚动
  if (items[active] && jumpListEl) {
    const listRect = jumpListEl.getBoundingClientRect()
    const itemRect = items[active].getBoundingClientRect()
    if (itemRect.top < listRect.top) {
      jumpListEl.scrollTop += itemRect.top - listRect.top
    } else if (itemRect.bottom > listRect.bottom) {
      jumpListEl.scrollTop += itemRect.bottom - listRect.bottom
    }
  }
  applyJumpBarActive(active)  // 同步折叠横杠的选中态
}

function renderJumpList() {
  if (!jumpListEl) return
  const qs = collectQuestions()
  _jumpTargets = qs
  jumpListEl.innerHTML = ''
  if (qs.length === 0) {
    jumpListEl.innerHTML = '<div class="jump-empty">还没有提问</div>'
    updateJumpActive()
    return
  }
  qs.forEach((el, i) => {
    const item = document.createElement('div')
    item.className = 'jump-item'
    item.dataset.idx = i
    const text = questionSnippet(el) || '（消息）'
    const span = document.createElement('span')
    span.className = 'jump-text'
    span.textContent = text
    item.appendChild(span)
    item.addEventListener('click', () => {
      // 跳转后保持面板打开（仿 DeepSeek 滚动导航），高亮随滚动定位到目标提问，
      // 便于连续跳转；移出卡片自动收起
      jumpToQuestion(el)
    })
    // 文本被省略（超宽）时，悬停用 tooltip 显示完整内容
    item.addEventListener('mouseenter', () => {
      if (span.scrollWidth > span.clientWidth + 1) showJumpTip(item, text)
    })
    item.addEventListener('mouseleave', hideJumpTip)
    jumpListEl.appendChild(item)
  })
  updateJumpActive()
}

function openJumpPanel() {
  jumpFab.classList.add('open')
  renderJumpList()
}

function closeJumpPanel() {
  jumpFab.classList.remove('open')
  hideJumpTip()
}

// 仿 DeepSeek：悬停小横杠自动展开提问列表，移出（含面板区域）延迟收起。
// mouseenter/mouseleave 覆盖所有子孙元素——鼠标移到展开的面板上时不会误收起。
let _jumpHoverTimer = null
jumpFab.addEventListener('mouseenter', () => {
  clearTimeout(_jumpHoverTimer)
  _jumpHoverTimer = setTimeout(() => openJumpPanel(), 100)
})
jumpFab.addEventListener('mouseleave', () => {
  clearTimeout(_jumpHoverTimer)
  _jumpHoverTimer = setTimeout(() => closeJumpPanel(), 250)
})

// 监听消息区增删：面板展开时实时刷新提问列表（发送、SSE 收消息都会触发）
function setupJumpObserver() {
  const msgs = document.getElementById('msgs')
  if (!msgs || typeof MutationObserver === 'undefined') return
  const obs = new MutationObserver(() => {
    // 消息增删时始终刷新折叠横杠数量；面板展开时再重建列表
    renderJumpBars()
    if (jumpFab.classList.contains('open')) renderJumpList()
  })
  obs.observe(msgs, { childList: true })
}
setupJumpObserver()
renderJumpBars()  // 初始渲染横杠（无提问时隐藏浮窗）

// 滚动消息区时同步更新"当前提问"高亮（面板展开时）
const _jumpMsgsEl = document.getElementById('msgs')
if (_jumpMsgsEl) {
  _jumpMsgsEl.addEventListener('scroll', () => {
    if (jumpFab.classList.contains('open')) {
      updateJumpActive()
    } else {
      applyJumpBarActive(computeJumpActive())  // 折叠态：滚动时同步当前域的横杠选中
    }
  }, { passive: true })
}

// 启动后查询当前阅读书籍（AI-001）：覆盖「切书后重开侧栏」的场景
loadState()
  .then(loadHistory)
  .then(connect)
  .then(() => refreshCurrentBook())

// 活动 tab 变化时刷新当前书（AI-001）：用户在多本书 / 多个微信读书 tab 间切换
try { chrome.tabs.onActivated.addListener(() => refreshCurrentBook()) } catch {}
