const RECEIVER = 'http://127.0.0.1:7239'

// 侧栏调试上报（与 content.js 的 postDebug 同写 receiver/inbox/debug.jsonl，source=sidebar）
function postSidebarDebug(data) {
  try {
    fetch(`${RECEIVER}/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'sidebar', ...data, timestamp: Date.now() }),
    }).catch(() => {})
  } catch {}
}
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
// 本地工作列表上限。一本书正常最多几千条引用（隔离机制下面板一次只显示当前书的），
// 5000 留足余量；全量存档在 receiver 的 annotations.jsonl，本地列表只是工作缓存。
const MAX_RECENT = 5000
let selectedAnn = null
// 待渲染的「引用回复」队列（FIFO）。每条引用提交 push 一项，最终完整记录到达时
// shift 队首配对渲染。SSE 事件严格有序（agent 按 chat_input 顺序处理并流式输出），
// 所以最终记录与提交按序配对——用队列取代原单个 _pendingRef，解决「前一条引用
// 回复未结束时又发一条」导致串槽/丢回复的问题（AI-006）。
let _pendingRefs = []
let _refNumCounter = 0   // 引用序号计数器
let _selectionStateRestored = false  // 是否已从存储恢复过选中状态（含显式取消）
let _pendingSelectRef = null  // 划线共读"设为当前引用"的待选标记（来自 content.js storage）
let _pendingRefSearch = null  // AI-011：划线内容"引用栏搜索"的待搜词（来自 content.js storage）

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
// refs 大数组防抖写：划线狂点不落盘，安静 800ms 写一次，pagehide 兜底冲掉，
// 避免每次划线都全量重写整个列表（MAX_RECENT=5000 量级序列化毫秒级）。
// 关键小状态（选中引用、序号计数）仍由 saveState 立即写，防面板随时关闭丢失。
let _refsSaveTimer = 0
function serializeRefs() {
  return RECENT_ANNS.map(a => ({
    bookId: a.bookId, bookTitle: a.bookTitle, chapter: a.chapter,
    chapterUid: a.chapterUid, chapterUidInt: a.chapterUidInt || 0,
    bookmarkRange: a.bookmarkRange || '', bookmarkId: a.bookmarkId || '',
    selectedText: a.selectedText, refNum: a.refNum
  }))
}
function flushRefsSave() {
  clearTimeout(_refsSaveTimer)
  try { chrome.storage.local.set({ refs: serializeRefs() }) } catch {}
}
function scheduleRefsSave() {
  clearTimeout(_refsSaveTimer)
  _refsSaveTimer = setTimeout(flushRefsSave, 800)
}
window.addEventListener('pagehide', flushRefsSave)

function saveState() {
  try {
    chrome.storage.local.set({
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
  scheduleRefsSave()
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
    // AI-011：划线内容"引用栏搜索"的待搜词（content.js 工具栏按钮写入）。
    // 应用后即清除（见 applyPendingRefSearch），不长期驻留。
    if (data.pendingRefSearch) {
      _pendingRefSearch = data.pendingRefSearch
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

// AI-011：应用"划线内容 → 引用栏搜索"的待搜词（来自 content.js 工具栏按钮）。
// 打开引用抽屉并填入搜索词，然后清除待搜词，避免面板每次加载都重复弹抽屉。
async function applyPendingRefSearch() {
  if (!_pendingRefSearch) return
  const q = _pendingRefSearch.query || ''
  _pendingRefSearch = null
  try { await chrome.storage.local.remove('pendingRefSearch') } catch {}
  if (q) await openDrawerWithSearch(q)
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
  // AI-011：划线内容 → 引用栏搜索（来自 content.js 工具栏按钮，侧栏已打开时的实时通道）。
  // 同时清掉 storage 待搜词，避免面板后续加载再重复开一次抽屉。
  if (msg?.action === 'coreadOpenRefSearch') {
    _pendingRefSearch = null
    try { chrome.storage.local.remove('pendingRefSearch') } catch {}
    openDrawerWithSearch(msg.query || '')
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

  // 没有选中引用时，显示空状态：隐藏详情/操作区，仅保留表头和提示；
  // 「↩ 返回」例外：有跳转记录（可能刚跳过引用、未选中）时仍显示
  if (!selectedAnn) {
    card.classList.add('empty')
    document.getElementById('rc-jump-btn').style.display = 'none'
    document.getElementById('rc-del-btn').style.display = 'none'
    document.getElementById('rc-collapse-btn').style.display = 'none'
    document.getElementById('rc-deselect-btn').style.display = 'none'
    renderJumpBack()
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

// 引用在书里的位置排序键：章节号 + 章内偏移。
function refPosition(a) {
  const uid = Number(a.chapterUidInt) || 0
  const m = /^(\d+)/.exec(String(a.bookmarkRange || ''))
  const offset = m ? Number(m[1]) : -1
  return [uid, offset]
}
// 按书中位置倒序：位置最靠后的（最新章节 / 章内更靠后）排在最上面（AI-013）。
// 缺章节定位（uid=0）的引用沉底；同位置用 Array.prototype.sort 稳定序兜底。
function sortRefsByPositionDesc(list) {
  return list.slice().sort((a, b) => {
    const pa = refPosition(a), pb = refPosition(b)
    for (let i = 0; i < 2; i++) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i]
    }
    return 0
  })
}

function filterAnns() {
  // AI-001：引用严格按当前书隔离。未读到书（_currentBook 为 null）时不列任何引用，
  // 绝不回退成"全部"，否则抽屉会把多本书的引用混在一起（正是"没隔离"的根因）。
  if (!_currentBook || !_currentBook.base) return []
  let list = RECENT_ANNS.filter(a => baseBookId(a.bookId) === _currentBook.base)
  const q = drawerSearchQuery.trim().toLowerCase()
  if (q) {
    list = list.filter(a => {
      return (a.bookTitle || '').toLowerCase().includes(q) ||
        (a.chapter || '').toLowerCase().includes(q) ||
        (a.selectedText || '').toLowerCase().includes(q)
    })
  }
  // AI-013：抽屉按书中位置倒序显示（只排序渲染副本，不影响 RECENT_ANNS 内部与选中逻辑）
  return sortRefsByPositionDesc(list)
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
  // AI-001：标题标注当前隔离范围——在读书籍时只列该书引用，未在读时提示先打开书
  const titleEl = document.getElementById('drawer-title')
  if (titleEl) titleEl.textContent = _currentBook && _currentBook.bookTitle
    ? `引用 · 《${_currentBook.bookTitle}》`
    : '当前未在读'

  const anns = filterAnns()

  if (anns.length === 0) {
    const hint = !_currentBook
      ? '未在读书籍页，打开一本书后再来切换引用'
      : '无匹配引用'
    list.innerHTML = `<div style="text-align:center;color:#bbb;padding:20px;font-size:0.92em;">${hint}</div>`
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

    // 点击跳转按钮：在微信读书打开引用所在章节。
    // 同时选中该引用并收起抽屉，让「当前引用」卡片显示它和「↩ 返回」按钮
    //（AI-006：否则跳转后卡片是空态，返回按钮不可见）
    item.querySelector('.di-jump-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      selectedAnn = ann
      clearPendingSelect()
      saveState()
      closeDrawer()
      renderRefUI()
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

// AI-012：从 receiver 拉当前书的全部标注，合并进引用列表（缺的补上）。
// 根因：侧栏引用列表靠「面板加载时 loadHistory + 实时 SSE」维护，而 SSE 断点续传
// 缓冲有限（receiver 重启即清空），错过事件后列表会永久落后——书页画线却每次实时
// 读 /annotations 文件，于是出现「书上有线、抽屉里没有」的不一致。这里主动拉全量补齐，
// 不依赖 SSE 是否恰好送达。receiver 未启动时静默失败，沿用本地列表。
async function syncAnnsFromReceiver() {
  if (!_currentBook || !_currentBook.base) return false
  try {
    const r = await fetch(`${RECEIVER}/annotations?bookId=${encodeURIComponent(_currentBook.base)}`)
    const list = await r.json()
    if (!Array.isArray(list)) return false
    let added = 0
    for (const d of list) {
      if (!d.selectedText) continue
      const exists = RECENT_ANNS.some(a => sameRef(a, d))
      if (!exists) {
        addRecentAnn({
          bookId: d.bookId || _currentBook.base,
          bookTitle: d.bookTitle || _currentBook.bookTitle,
          chapter: d.chapter || '', chapterUid: d.chapterUid || '',
          chapterUidInt: d.chapterUidInt || 0,
          bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
          selectedText: d.selectedText,
        }, { select: false })
        added++
      }
    }
    return added > 0
  } catch { return false }
}

async function openDrawer() {
  await openDrawerWithSearch('')
}

// AI-011：打开引用抽屉并预填搜索词（划线内容搜索用，来自 content.js 工具栏按钮）。
// query 为空等价于普通打开。与 openDrawer 一致：打开前重查当前书，防止显示错书的引用。
async function openDrawerWithSearch(query) {
  drawerSearchQuery = query || ''
  document.getElementById('drawer-search').value = drawerSearchQuery
  document.getElementById('ref-drawer').classList.add('on')
  // AI-001：打开前向活动 tab 重新查询当前书。跨 tab 的最后一次广播可能把
  // _currentBook 带偏（后台 tab 加载晚于前台），不刷新就会显示错书的引用。
  await refreshCurrentBook()
  // AI-012：从 receiver 拉当前书全量标注合并进列表——补上 SSE 可能漏掉的最新划线，
  // 抽屉永远显示存档里的全量（书页画线实时读文件，这里对齐）。
  await syncAnnsFromReceiver()
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

  if (role === 'user') {
    el.className = 'msg-user'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  } else if (role === 'user-popup') {
    // 来自共读弹窗的用户消息：显示引用 + 用户问题，并启动思考动画
    showThinking(bookId)
    el.className = 'msg-user'
    const quoteText = note ? `> "${esc(note)}"\n\n` : ''
    el.innerHTML = `<div class="bubble">${quoteText}${esc(content)}</div>`
  } else {
    if (_pendingRefs.length || _streamEl) {
      if (_streamEl) {
        // 流式已显示但最终记录走了兜底路径（-1 标记丢失等）：就地升级/补齐，
        // 避免在已显示的气泡旁再渲染一个重复气泡
        const entry = _pendingRefs.shift()
        if (entry && entry.ref) upgradeStreamToRefReply(_streamEl, entry.ref, content)
        else patchStreamedComplete(_streamEl, content)
        _streamEl = null
        return
      }
      // 非流式的完整渲染（历史回放 / 兜底）：直接渲染
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
// 完成标志（保留 _streamEl 供最终记录升级/补齐）；最终记录处理后置空 _streamEl。
// 引用回复也流式实时显示，引用条在最终记录到达时就地补上——绝不走 addBubble 再建一个。
let _streamEl = null
let _streamDone = false

function _handleStream(d) {
  if (d._stream === -1) {
    // 流结束标记：置完成标志等最终完整记录。_streamEl 不置空——最终记录要
    // 用它就地升级出引用条（引用回复）或补齐完整文本（普通回复缺尾）。
    _streamDone = true
    _thinkingBook = ''  // AI-001：本条回复的书签使命结束
    return
  }
  // 上一条流已 -1 但最终记录缺失（异常断开/回放跳变）：放弃旧气泡，新流开新气泡
  if (_streamDone) { _streamDone = false; _streamEl = null }

  // 打字机，合并渲染进同一个气泡（引用回复也实时显示）
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

// 引用回复气泡的完整 HTML（引用条 + 引用原文预览 + 回复正文）
function refReplyHTML(ref, content) {
  const book = esc(ref.bookTitle || '')
  const chapter = esc((ref.chapter || '').slice(0, 12))
  const num = findRefNum(ref.bookTitle, ref.chapter, ref.selectedText)
  const snippet = esc((ref.selectedText || '').slice(0, 80))
  // 注意：不要用带前导空白的模板字符串，bubble 是 white-space:pre-wrap，
  // 前导换行/空格会在气泡顶部渲染出一大片空白。
  return (
    `<div class="ref-bar" data-ref-num="${num}">` +
      `<span class="ref-book">${book}</span>` +
      (chapter ? `<span class="ref-chapter">${chapter}</span>` : '') +
      `<span class="ref-num">#${num || '?'}</span>` +
    `</div>` +
    `<div class="bubble">` +
      `<div class="ref-quote-preview" data-ref-num="${num}">"${snippet}${(ref.selectedText || '').length > 80 ? '…' : ''}"</div>` +
      `${esc(content)}` +
    `</div>`
  )
}

function bindRefReplyClicks(el, ref) {
  // 点击引用条或预览 → 切换当前引用
  el.querySelector('.ref-bar')?.addEventListener('click', () => selectRefByPending(ref))
  el.querySelector('.ref-quote-preview')?.addEventListener('click', () => selectRefByPending(ref))
}

// 渲染一条队列条目对应的完整气泡（非流式路径 / 流式气泡缺失时的兜底）。
// 队列条目统一为 { ref: 引用信息|null }；ref 非空渲染引用条气泡，null（自由提问）渲染普通气泡。
function _renderEntry(entry, content) {
  if (!entry) return
  hideThinking()
  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')
  const ref = entry.ref
  if (ref) {
    el.className = 'msg-assistant ref-reply'
    // AI-001：引用回复归属该书
    if (ref.bookId) el.dataset.book = baseBookId(ref.bookId)
    el.innerHTML = refReplyHTML(ref, content)
    bindRefReplyClicks(el, ref)
  } else {
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  }
  msgs.appendChild(el)
  applyBookFilter()
  maybeAutoScroll(msgs)
}

function _renderRefReply(content) {
  _renderEntry(_pendingRefs.shift(), content)  // AI-006：按提交顺序 shift，避免串槽
}

// 流式路径收尾：引用回复把流式普通气泡就地升级成带引用条的气泡（引用条此时才显示）
function upgradeStreamToRefReply(el, ref, content) {
  if (!el) return
  hideThinking()
  el.classList.add('ref-reply')
  el.innerHTML = refReplyHTML(ref, content)
  bindRefReplyClicks(el, ref)
}

// 流式路径收尾：普通回复用最终完整记录补齐气泡（修复流式节流可能丢尾）
function patchStreamedComplete(el, content) {
  if (!el) return
  const b = el.querySelector('.bubble')
  if (b) b.textContent = content
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  if (sseConn) return
  // 断线重连时带 lastId 续传：只重放上次断开后没收到的事件（AI-006）。
  // 首次连接 _lastEventId=0 → 不带参数 → receiver 不回放（历史由 /history 加载）。
  const q = _lastEventId > 0 ? `?lastId=${_lastEventId}` : ''
  sseConn = new EventSource(`${RECEIVER}/events${q}`)
  sseConn.onopen = () => {
    setDot(true)
    // AI-012：重连成功后自愈——补上断连期间漏掉的标注，无需重开面板。
    // 初始连接时 _currentBook 可能尚未就绪（refreshCurrentBook 在其后执行），
    // 此时 syncAnnsFromReceiver 内守卫直接返回，由首次 loadHistory 兜底。
    syncAnnsFromReceiver().then(changed => { if (changed) { renderRefUI(); renderDrawer() } })
  }
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

      // 流结束后的最终完整记录：引用回复把流式气泡就地升级出引用条；
      // 普通回复用完整内容补齐（修复流式节流可能丢尾）。
      if (_streamDone && d.role === 'assistant') {
        _streamDone = false
        _seenMsgs.add(_msgKey(d))  // 登记，防 SSE 回放重复
        const entry = _pendingRefs.shift()  // 队列非空才渲染引用气泡，内部按序 shift
        if (entry && entry.ref) {
          if (_streamEl) upgradeStreamToRefReply(_streamEl, entry.ref, d.content)
          else _renderEntry(entry, d.content)  // 空回复等无流式气泡时兜底
        } else {
          patchStreamedComplete(_streamEl, d.content)
        }
        _streamEl = null
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
        _pendingRefs.push({ ref: { bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter, selectedText: d.selectedText } })
        addBubble('user-popup', d.content, null, d.selectedText, d.bookId)
        // 弹窗发送的标注要实时加入引用列表（标注走 annotation-select 事件，不产生消息气泡）
        if (d.bookId && d.selectedText) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, selectedText: d.selectedText })
        }
      }
      // AI-010：不再处理 role='annotation'——标注一律是引用（走 annotation-select/annotation-sync），
      // receiver 不推 annotation 消息气泡，消息区不再渲染"只显示引用"的气泡。
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
    _pendingRefs.push({ ref: { bookId: selectedAnn.bookId, bookTitle: selectedAnn.bookTitle, chapter: selectedAnn.chapter, selectedText: selectedAnn.selectedText } })
    body.bookId = selectedAnn.bookId
    body.bookTitle = selectedAnn.bookTitle
    body.chapter = selectedAnn.chapter || ''
    body.chapterUid = selectedAnn.chapterUid || ''
    body.selectedText = selectedAnn.selectedText
    body.content = `[引用]《${selectedAnn.bookTitle}》${selectedAnn.chapter || ''}\n> "${selectedAnn.selectedText}"\n\n${content}`
  } else {
    // AI-006：自由提问也入队一个 ref:null 条目，保证最终记录按提交顺序配对。
    // 之前自由消息不入队，若「自由回复流式中途又发引用」，自由回复的最终记录
    // 会错配到新入队的引用（引用条错标）；现在每条消息都有占位，配对不乱。
    _pendingRefs.push({ ref: null })
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
    // 发送失败：这条消息没到 receiver、agent 不会回复。弹掉刚入队的自己的条目，
    // 避免它的最终记录永远不来、把后续真实回复的配对挤偏。不整队清空——前一条
    // 仍在流式的回复还需要自己的队项配对。
    _pendingRefs.pop()
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

// 「返回跳转前位置」状态：跳转时记住原阅读位置，点击 ↩ 恢复（AI-006）。
// 持久化到 storage（面板重开也能恢复返回能力）；带 TTL 防陈旧导航。
// 字段：url 原 tab URL、tabId 跳转的 tab、bookId 原书、chapterUidInt 原章节、
// anchorText 原阅读视口顶部的可见文本锚点（DOM 书）、canvas 是否画布书、
// crossChapter 前向跳转是否跨章（画布书跳回选 history.back() vs URL 导航）、
// canvasFrac 画布书滚动比例（尽力，AI-012）、ts 跳转时间。
let jumpBackPos = null
const JUMP_BACK_TTL = 60 * 60 * 1000  // 返回记录 1 小时内有效

async function persistJumpBack() {
  try { if (jumpBackPos) await chrome.storage.local.set({ jumpBackPos }) } catch {}
}

async function clearJumpBack() {
  try { await chrome.storage.local.remove('jumpBackPos') } catch {}
}

async function loadJumpBack() {
  try {
    const { jumpBackPos: saved } = await chrome.storage.local.get('jumpBackPos')
    if (!saved || !saved.url) return
    if (saved.ts && Date.now() - saved.ts > JUMP_BACK_TTL) {
      await clearJumpBack()
      return
    }
    jumpBackPos = saved
    renderJumpBack()
  } catch {}
}

// 从微信读书 reader URL 提取书 ID（路径段可能带 k 后缀，先归一）
function bookIdFromReaderUrl(url) {
  const m = /^https:\/\/weread\.qq\.com\/web\/reader\/([^/?#]+)/.exec(String(url || ''))
  return m ? baseBookId(m[1]) : ''
}

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
    const base = baseBookId(ann.bookId)
    if (!base) { console.warn('[CoRead] jump: missing bookId'); return }

    // 多 tab 时跳到正确的那一个：优先正打开该书（或处于活动状态）的 weread tab，
    // 其次任意 weread tab，再无则新建。避免跳进多个 tab 里错误的那一个。
    let [tab] = await chrome.tabs.query({ url: `https://weread.qq.com/web/reader/${base}*` })
    if (!tab) [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*', active: true, lastFocusedWindow: true })
    if (!tab) [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })

    // 记住当前位置供「↩ 返回」（AI-006）：向当前阅读 tab 捕获视口顶部可见文本作
    // 锚点 + 原章节整数 id，返回时导航回原章节并精确恢复阅读位置（不只回章节）。
    let anchor = null
    if (tab && tab.id) {
      try {
        anchor = await chrome.tabs.sendMessage(tab.id, { action: 'getReadingAnchor' }, { frameId: 0 }).catch(() => null)
      } catch {}
    }
    const uid = Number(ann.chapterUidInt) || 0
    const currentUid = (anchor && Number(anchor.chapterUidInt)) || 0
    if (tab && tab.url) {
      const isCanvas = !!(anchor && anchor.canvas)
      const crossChapter = isCanvas ? (currentUid > 0 && currentUid !== uid) : undefined
      // AI-012：画布书「确认同章」跳转，WeRead 无任何返回逻辑（用户实测），不提供 ↩；
      // 只有跨章（浏览器 back 可恢复）或章未知（保守提供，跳回走 URL 导航）才记返回状态。
      const sameChapterCanvas = isCanvas && currentUid > 0 && currentUid === uid
      if (sameChapterCanvas) {
        jumpBackPos = null
        try { await clearJumpBack() } catch {}
      } else {
        jumpBackPos = {
          url: tab.url,
          tabId: tab.id || 0,
          bookId: (anchor && anchor.bookId) || bookIdFromReaderUrl(tab.url),
          chapterUidInt: currentUid,
          // 画布书锚点是工具栏/书名垃圾（AI-012），不存——跨章跳回靠浏览器 back 原生恢复
          anchorText: isCanvas ? '' : ((anchor && anchor.anchorText) || ''),
          canvas: isCanvas || undefined,
          crossChapter,
          canvasFrac: (anchor && Number.isFinite(anchor.canvasFrac)) ? anchor.canvasFrac : null,
          ts: Date.now(),
        }
        await persistJumpBack()
      }
      renderJumpBack()
    }

    // 章节定位优先级：chapterUidInt → k-suffix URL（精确，保证章节正确）；
    //   缺失时复用注解 bookId 自身带的 k-suffix——那是注解被捕获那一刻的 reader URL
    //   章节，比 chapterUid 槽位可靠（SPA 章节切换时 URL 槽位/DOM 标题常滞后记错，
    //   例如学做工注解真实槽位 e_0 被记成 e_1，直接 #slot 会跳错章）；
    //   再缺失用 chapterUid 原生 hash 槽位（e_0/t_1）→ #slot；
    //   最后用引用文字在本地正文缓存反查（/find-chapter）→ chapterUid 或 slot。
    //   canvas 书（chapterUidInt + bookmarkRange 齐全）额外带 ?crj=uid:start：page_hook
    //   改写 getProgress 让微信读书自己也定位到引文（尽力辅助，见下）。
    const crjStart = parseInt(String(ann.bookmarkRange || '').split('-')[0], 10)
    const useCrj = uid > 0 && Number.isFinite(crjStart) && crjStart >= 0
    // 微信读书自己的跳转约定（用户实测 + AI-011）：跨章带 k、同章不带 k；它的精确定位是
    // 阅读器内部函数（笔记面板条目点击 = 它自己精确到句），URL 的 k 后缀只是章节导航记账。
    // 所以 canvas 书：同章不导航（当前页点笔记面板定位，避免 reload 打乱阅读位置），
    // 跨章带 k 落章后目标页 content script 点笔记面板条目完成精确到句（不再带 crj——
    // getProgress 改写五轮实测不生效）。
    // canvas 书定位全交给笔记面板（AI-011）：笔记面板点击自己会导航到目标章（跨章自愈），
    // 侧栏导航是多余的、只会造成"reload→getProgress 恢复阅读区→再定位"的两步走。
    // AI-012：captureReadingAnchor 加了共享章节兜底后 currentUid 可能已可靠，但画布书仍
    // 一律 noNav（跨章也交给笔记面板自导航，零 reload）——只在 DOM 书才按「同章 or 未知」
    // 判 noNav、已知跨章走 URL 导航。
    const isCanvasAnchor = !!(anchor && anchor.canvas)
    const sameChapter = useCrj && uid > 0 && (isCanvasAnchor ? true : (currentUid === uid || currentUid === 0))
    let url = `https://weread.qq.com/web/reader/${base}`
    let located = false
    let noNav = false
    if (useCrj && sameChapter) {
      // 同章（canvas）：不改 URL、不导航。写 pendingJump，当前页 content script（onChanged）
      // 点笔记面板条目定位；再 ping 一次兜底 storage 事件漏触发。
      noNav = true
    } else if (useCrj) {
      // 跨章（canvas）：带 k 落到目标章，不带 crj。
      const k = weReadEncode(uid)
      if (k) { url += 'k' + k; located = true }
    } else {
      located = uid > 0
      if (uid > 0) {
        try {
          const k = weReadEncode(uid)
          if (k) { url += 'k' + k } else { located = false }
        } catch { located = false }
      }
      if (!located) {
        // bookId 形如 {base}k{suffix}：后缀就是捕获时的真实章节编码，原样拼回即可，
        // 不需要再 weReadEncode（base 已由 baseBookId 剥离后缀）。
        const m = String(ann.bookId || '').match(/k([0-9a-f]{16,})$/i)
        if (m) { url += 'k' + m[1]; located = true }
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
    }

    // 先把待定位的引用原文写进 storage，内容脚本在目标页加载后用它在书页里
    // 滚动高亮（AI-006，恢复跳转后定位引用的句子；storage 交给帧内自行消费）。
    // canvasCrj 跳转标记 canvasScroll：内容脚本用"只滚动不改 DOM"的方式定位（见 content.js
    // findAndHighlight 的 noDom 模式），避免修改隐藏文本层触发微信读书重渲染。
    if (ann.selectedText) {
      try {
        await chrome.storage.local.set({
          pendingJump: {
            bookId: ann.bookId, selectedText: ann.selectedText, ts: Date.now(),
            canvasScroll: useCrj || undefined,
          },
        })
      } catch {}
    }

    console.log(`[CoRead] jumpToAnnotation url=${url} useCrj=${useCrj} noNav=${noNav} sameChapter=${sameChapter}`)
    postSidebarDebug({
      stage: 'jump-decision', url, useCrj, noNav, sameChapter,
      uid, crjStart, currentUid, anchorUid: (anchor && anchor.chapterUidInt) || 0,
      hasAnchor: !!anchor, base,
    })
    if (noNav && tab && tab.id) {
      // 同章（canvas）：不导航。pendingJump 已写入，onChanged 会触发当前页消费；再 ping
      // 一次兜底（content script 挂监听前 storage 变更可能漏事件）。ping 失败（content
      // script 不在）则什么都不做——不倒退：同章不导航本就是最安全的落点。
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'checkPendingJump' }, { frameId: 0 }).catch(() => {})
        await chrome.tabs.update(tab.id, { active: true })
      } catch {}
    } else if (tab) {
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
    const isCanvas = !!jumpBackPos.canvas
    // 恢复 URL：有捕获的章节时用 k{encode(uid)} 精确导航回原章节——不依赖微信读书
    // 的进度恢复（同书内跳转时进度已被目标章节覆盖），无章节信息才回退保存的原 URL。
    // 画布书章节在跳转瞬间常捕获为 0（AI-012，URL 无 k 后缀），已由 content.js 用共享
    // 章节兜底；这里若仍为 0 则退回原 URL（可能被微信读书进度带偏，尽力而为）。
    let url = jumpBackPos.url
    const uid = Number(jumpBackPos.chapterUidInt) || 0
    const bookId = jumpBackPos.bookId || bookIdFromReaderUrl(jumpBackPos.url)
    if (uid > 0 && bookId) {
      try {
        const k = weReadEncode(uid)
        if (k) url = `https://weread.qq.com/web/reader/${baseBookId(bookId)}k${k}`
      } catch {}
    }
    // 待恢复目标写进 pendingJump（仅在 URL 导航回退时写）：
    // - DOM 书：锚点文本 + position:'start'，findAndHighlight 按锚点滚动回原阅读位置；
    // - 画布书：canvasScroll + canvasFrac（滚动比例尽力，canvasRestoreLoop 设回 scrollTop）。
    // 画布书不写垃圾锚点（工具栏/书名）——避免 findAndHighlight 把 span 插进隐藏文本层
    // 触发微信读书重渲染、把位置重置回章首（AI-006）。
    // 优先回跳转时那个 tab（tabId），tab 已关则回退任意 weread tab
    let tab = null
    if (jumpBackPos.tabId) {
      try { tab = await chrome.tabs.get(jumpBackPos.tabId) } catch {}
    }
    if (!tab) [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
    if (!tab) {
      // 没有可回跳的 tab：DOM 书锚点目标先写入 pendingJump，等下次打开该书时消费
      if (!isCanvas && jumpBackPos.anchorText && bookId) {
        await chrome.storage.local.set({
          pendingJump: { bookId, selectedText: jumpBackPos.anchorText, position: 'start', ts: Date.now() },
        })
      }
      postSidebarDebug({ stage: 'jump-back', action: 'no-tab', isCanvas, uid, hasFrac: jumpBackPos.canvasFrac != null })
      jumpBackPos = null
      await clearJumpBack()
      renderJumpBack()
      return
    }
    // AI-012 画布书跳回（用户实测 WeRead 行为）：
    // - 跨章：WeRead 自身无返回逻辑，但浏览器 back 能原生恢复——直接 history.back() 并信任，
    //   不做二次导航覆盖（上版轮询校验 + URL 兜底会竞态把 back 的效果冲掉）。
    // - 同章/章未知：WeRead 无任何返回逻辑（同章无 back），画布书也无 DOM 滚动容器——
    //   只保证章对（URL 导航），章内位置无法恢复。
    let didBack = false
    if (isCanvas && jumpBackPos.crossChapter && tab.id) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { action: 'historyBackToReading', targetUrl: jumpBackPos.url }, { frameId: 0 }).catch(() => null)
        didBack = !!(r && r.ok)
      } catch {}
    }
    if (didBack) {
      // 浏览器 back 已触发，WeRead 原生恢复阅读位置；清掉旧 pendingJump 防被恢复页消费干扰
      try { await chrome.storage.local.remove('pendingJump') } catch {}
    } else {
      // back 守卫拒绝 / 非跨章画布书 / DOM 书 → URL 导航回原章（reload 后由恢复机制定位）
      const ts = Date.now()
      if (!isCanvas && jumpBackPos.anchorText && bookId) {
        await chrome.storage.local.set({
          pendingJump: { bookId, selectedText: jumpBackPos.anchorText, position: 'start', ts },
        })
      } else if (isCanvas && jumpBackPos.canvasFrac != null && bookId) {
        await chrome.storage.local.set({
          pendingJump: { bookId, canvasScroll: true, canvasFrac: jumpBackPos.canvasFrac, ts },
        })
      } else {
        try { await chrome.storage.local.remove('pendingJump') } catch {}
      }
      if (tab) await chrome.tabs.update(tab.id, { url, active: true })
    }
    postSidebarDebug({
      stage: 'jump-back', action: didBack ? 'history-back' : 'navigate',
      isCanvas, uid, crossChapter: jumpBackPos.crossChapter, didBack, url: url.slice(0, 90),
      hasFrac: jumpBackPos.canvasFrac != null,
    })
    jumpBackPos = null
    await clearJumpBack()
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
        // AI-010：标注一律是"引用"（设为引用 / 划线同步），不触发讨论也不产生消息气泡，
        // 历史回放只把它们并入引用列表（addRecentAnn）+ 参与对账清理（histAnnKeys）。
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
        _pendingRefs = histPendingRef ? [{ ref: histPendingRef }] : []
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
  // AI-011：/history 刷新了 RECENT_ANNS 后，若引用抽屉已开着（划线内容搜索可能
  // 在面板加载期间由实时消息提前打开），重渲染一次让搜索结果显示最新数据
  renderDrawer()
}

// ── 提问位置浮窗（AI-005）───────────────────────────────────────────────────
// 仿 DeepSeek 网页版：右侧小浮窗列出本会话里的提问，点击条目直接滚动到对应
// 消息并高亮，不用在长聊天记录里翻找。
const jumpFab = document.getElementById('jump-fab')
const jumpListEl = document.getElementById('jump-list')
let _jumpTargets = []  // 与浮窗列表条目一一对应的用户消息元素
let _jumpBarWinStart = 0  // AI-015：折叠横杠窗口在 _jumpTargets 里的起始序号（= 面板列表视口顶部）

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

// 折叠态（面板收起）右缘把手横杠 = 面板列表视口的缩影（约 10 条窗口）：
// 窗口起点 = 面板列表视口顶部（listWindowStart），条 i = 提问 winStart+i（1:1），
// 高亮 = 当前提问所在条（active - winStart，按它实际在窗口内的位置，不强制置为最后一条）。
// 展开态（面板打开）时把手列隐藏，每根横杠内嵌到对应列表项的右侧、随列表一起滚动
// （见 renderJumpList / sidebar.html）。0 条提问时整个浮窗隐藏。
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

// 面板列表当前视口顶部的提问序号 = 折叠横杠窗口的起点（列表滚动时用它让折叠列镜像视口）。
// 与 computeJumpActive 同理：取"顶部已滚过、且最靠下"的那个，即视口顶部那条。
// 滚到底部只剩不足 10 条时返回视口第一条，窗口起点由调用方 clamp 到 n-10。
function listWindowStart() {
  const list = jumpListEl
  if (!list) return 0
  const items = list.querySelectorAll('.jump-item')
  const n = items.length
  if (n === 0) return 0
  const listRect = list.getBoundingClientRect()
  let start = -1
  for (let i = 0; i < n; i++) {
    const relTop = items[i].getBoundingClientRect().top - listRect.top
    if (relTop <= 8) { start = i; continue }
    break
  }
  if (start === -1) start = 0
  return start
}

// 把选中态落到折叠横杠上：active 映射到窗口内条号（active - 窗口起点）
function applyJumpBarActive(active) {
  const btn = document.getElementById('jump-fab-btn')
  if (!btn) return
  const idx = active - _jumpBarWinStart
  btn.querySelectorAll('.jbar').forEach((b, i) => b.classList.toggle('sel', i === idx))
}

// 当前提问变化时统一入口（聊天滚动、消息增删都走这里）。
// AI-015：折叠横杠窗口 = 面板列表视口的缩影，选中态只标在当前提问实际所在的那一格
// （active - winStart），不再把窗口终点硬锚到当前提问——否则面板里选中第 7 条、关回后
// 横杠却永远是最后一个（此前 bug）。面板展开时窗口完全镜像列表视口（列表滚动由下方
// 监听维护）；面板收起时窗口是上次镜像的视口，仅在当前提问滑出窗口时才被拉回：
// 从窗口顶部滑出 → 窗口贴它（第 1 格），从底部滑出 → 窗口贴它（最后 1 格）。
// 前 9 条提问时窗口贴顶、高亮随序号前移；≤10 问时窗口恒为 [0..n-1]，条 i ↔ 提问 i。
function syncJumpBar(active) {
  if (active === undefined) active = computeJumpActive()
  const n = _jumpTargets.length
  if (n === 0) { _jumpBarWinStart = 0; return }
  const maxStart = Math.max(0, n - 10)
  if (jumpFab.classList.contains('open')) {
    // 面板展开：折叠列隐藏，窗口 = 列表视口的实时镜像（起点取视口顶部那条）
    _jumpBarWinStart = Math.min(listWindowStart(), maxStart)
    applyJumpBarActive(active)
    return
  }
  // 面板收起：保留镜像到的视口；当前提问滑出窗口才按最靠近的一侧拉回
  if (active < _jumpBarWinStart) _jumpBarWinStart = active
  else if (active >= _jumpBarWinStart + 10) _jumpBarWinStart = active - 9
  _jumpBarWinStart = Math.min(_jumpBarWinStart, maxStart)
  applyJumpBarActive(active)
}

function renderJumpBars() {
  if (!jumpFab) return
  _jumpTargets = collectQuestions()  // 折叠态也能算当前域
  const btn = document.getElementById('jump-fab-btn')
  if (!btn) return
  const n = _jumpTargets.length
  btn.innerHTML = ''
  if (n === 0) {
    _jumpBarWinStart = 0
    jumpFab.style.display = 'none'
    return
  }
  const w = Math.min(n, 10)  // 收起时只显示当前视口窗口的横杠（最多 10 条）
  const wrap = document.createElement('div')
  wrap.className = 'jbar-wrap'
  for (let i = 0; i < w; i++) {
    const bar = document.createElement('span')
    bar.className = 'jbar'
    wrap.appendChild(bar)
  }
  btn.appendChild(wrap)
  jumpFab.style.display = ''
  syncJumpBar()
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
  // scrollIntoView 在 #msgs 的滚动事件里调用，会取消正在进行的平滑滚动。
  // AI-015：keep-in-view——当前项已在面板视口内就不滚动（保留用户正在浏览的位置，
  // 折叠列也能按它实际在视口里的位置高亮）；只有滑出视口才从边缘拉回。此前强制置顶
  // 会打断浏览，且让选中格永远顶到视口第 1 格（用户报告折叠列永远是最后/第 1 格的根因之一）。
  if (items[active] && jumpListEl) {
    const listRect = jumpListEl.getBoundingClientRect()
    const r = items[active].getBoundingClientRect()
    if (r.top < listRect.top) {
      jumpListEl.scrollTop += r.top - listRect.top - 2
    } else if (r.bottom > listRect.bottom) {
      jumpListEl.scrollTop += r.bottom - listRect.bottom + 2
    }
  }
  syncJumpBar(active)  // AI-015：同步折叠横杠（窗口镜像列表视口 + 选中格按实际位置高亮）
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
    const bar = document.createElement('span')  // AI-014：每项右侧横杠，随列表一起滚动
    bar.className = 'jbar'
    item.appendChild(bar)
    item.addEventListener('click', () => {
      // 跳转后保持面板打开（仿 DeepSeek 滚动导航），高亮随滚动定位到目标提问，
      // 便于连续跳转；移出卡片自动收起
      jumpToQuestion(el)
    })
    // 文本被省略（超宽）时，悬停用 tooltip 显示完整内容（横杠 hover 由 CSS :hover 处理）
    item.addEventListener('mouseenter', () => {
      if (span.scrollWidth > span.clientWidth + 1) showJumpTip(item, text)
    })
    item.addEventListener('mouseleave', hideJumpTip)
    jumpListEl.appendChild(item)
  })
  updateJumpActive()
}

function openJumpPanel() {
  const wasOpen = jumpFab.classList.contains('open')
  jumpFab.classList.add('open')
  // AI-014：已展开时再次移入（fab mouseenter 每进一次都触发）不再重建列表，
  // 避免项内横杠的 transition 被重置造成闪烁；消息增删由 MutationObserver 负责刷新
  if (!wasOpen) renderJumpList()
}

function closeJumpPanel() {
  jumpFab.classList.remove('open')
  hideJumpTip()
  // AI-015：关回后折叠列 = 面板最后视口的缩影；若用户浏览列表时把当前提问滑出了
  // 该视口，这里把窗口拉回选中项周围（保持在窗口内、按最近一侧显示）
  syncJumpBar()
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
      syncJumpBar()  // AI-015：折叠态滚动聊天时同步当前域高亮（窗口仅在选中项滑出时移动）
    }
  }, { passive: true })
}
// AI-015：面板列表滚动只把折叠横杠窗口同步到列表视口（listWindowStart），改的是窗口
// 起点、不动选中态——选中态只由聊天当前提问（computeJumpActive）决定。此前版本在列表
// 滚动时把列表位置当选中项去驱动折叠横杠，导致面板关回后折叠列显示的是列表位置而非
// 被选中提问（用户报告的 bug）。面板展开时折叠列隐藏，此同步是为关回后"折叠列 = 面板
// 最后视口的缩影"：选中项落在该视口内就按实际位置高亮（第 7 条→第 7 格），落在外则由
// closeJumpPanel 里的 syncJumpBar 把窗口拉回选中项周围。
if (jumpListEl) {
  jumpListEl.addEventListener('scroll', () => {
    if (!jumpFab.classList.contains('open')) return
    _jumpBarWinStart = Math.min(listWindowStart(), Math.max(0, _jumpTargets.length - 10))
    applyJumpBarActive(computeJumpActive())
  }, { passive: true })
}

// 启动后查询当前阅读书籍（AI-001）：覆盖「切书后重开侧栏」的场景。
// applyPendingRefSearch 放在 loadHistory 之后：引用列表就绪后再打开抽屉搜索，
// 否则搜索框填了词但列表还是空的（AI-011）。
loadState()
  .then(loadHistory)
  .then(applyPendingRefSearch)
  .then(connect)
  .then(() => refreshCurrentBook())
loadJumpBack()  // AI-006：面板重开后恢复「↩ 返回」能力（有未过期的跳转记录时）

// 活动 tab 变化时刷新当前书（AI-001）：用户在多本书 / 多个微信读书 tab 间切换
try { chrome.tabs.onActivated.addListener(() => refreshCurrentBook()) } catch {}
