const RECEIVER = 'http://127.0.0.1:7239'
let sseConn = null

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

// ── 引用划线数据 ──────────────────────────────────────────────────────────
const RECENT_ANNS = []
const MAX_RECENT = 50
let selectedAnn = null
let _pendingRef = null  // 当前等待回复的引用信息
let _refNumCounter = 0   // 引用序号计数器
let _selectionStateRestored = false  // 是否已从存储恢复过选中状态（含显式取消）
let _pendingSelectRef = null  // 划线共读"设为当前引用"的待选标记（来自 content.js storage）

// 引用身份比较：bookId 带会变的 k 会话后缀（同一本书每次打开 reader 后缀都不同），
// 必须用 baseBookId 归一化后再比较，否则同一引用会因后缀不同而重复堆积。
function sameRef(a, b) {
  return !!(a && b && baseBookId(a.bookId) === baseBookId(b.bookId) && a.selectedText === b.selectedText)
}

// ── 持久化 ────────────────────────────────────────────────────────────────
function saveState() {
  try {
    chrome.storage.local.set({
      refs: RECENT_ANNS.map(a => ({
        bookId: a.bookId, bookTitle: a.bookTitle, chapter: a.chapter,
        chapterUid: a.chapterUid, selectedText: a.selectedText, refNum: a.refNum
      })),
      refNumCounter: _refNumCounter,
      selectedRef: selectedAnn ? {
        bookId: selectedAnn.bookId, bookTitle: selectedAnn.bookTitle,
        chapter: selectedAnn.chapter, chapterUid: selectedAnn.chapterUid,
        selectedText: selectedAnn.selectedText, refNum: selectedAnn.refNum
      } : null
    })
  } catch {}
}

async function loadState() {
  try {
    const data = await chrome.storage.local.get(['refs', 'refNumCounter', 'selectedRef', 'pendingSelectRef'])
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
  const found = RECENT_ANNS.find(a => sameRef(a, ref))
  if (found) {
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
      chapterUid: r.chapterUid || '', selectedText: r.selectedText })
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
  renderJumpBack()

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
  const q = drawerSearchQuery.trim().toLowerCase()
  if (!q) return RECENT_ANNS
  return RECENT_ANNS.filter(a => {
    return (a.bookTitle || '').toLowerCase().includes(q) ||
      (a.chapter || '').toLowerCase().includes(q) ||
      (a.selectedText || '').toLowerCase().includes(q)
  })
}

function renderDrawer() {
  const list = document.getElementById('drawer-list')
  list.innerHTML = ''

  const anns = filterAnns()

  if (anns.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:12px;">无匹配引用</div>'
    return
  }

  for (const ann of anns) {
    const isSel = sameRef(selectedAnn, ann)

    const item = document.createElement('div')
    item.className = 'drawer-item' + (isSel ? ' sel' : '')
    const preview = esc((ann.selectedText || '').slice(0, 120))
    const exceeded = (ann.selectedText || '').length > 120

    item.innerHTML = `
      <div class="di-head">
        <span class="di-num">#${ann.refNum || '?'}</span>
        <span class="di-book">${esc(ann.bookTitle || '未知书')}</span>
      </div>
      <div class="di-chapter">${esc((ann.chapter || '').slice(0, 40))}</div>
      <div class="di-text">${preview}${exceeded ? '…' : ''}</div>
      <span class="di-toggle">展开 ▼</span>
      <div class="di-full">${esc(ann.selectedText || '')}</div>
      <div class="di-actions">
        <button class="di-jump-btn">📍 跳转</button>
        <button class="di-del-btn" title="删除这条引用">${ICON_TRASH}</button>
      </div>`

    // 点击正文区域：选中并关闭
    item.querySelector('.di-text')?.addEventListener('click', (e) => {
      e.stopPropagation()
      selectedAnn = ann
      clearPendingSelect()  // 用户显式选择取代残留待办
      saveState()
      closeDrawer()
      renderRefUI()
    })

    // 点击展开/折叠按钮
    item.querySelector('.di-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const expanded = item.classList.contains('expanded')
      item.classList.toggle('expanded')
      item.querySelector('.di-toggle').textContent = expanded ? '展开 ▼' : '折叠 ▲'
    })

    // 点击跳转按钮
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

function openDrawer() {
  drawerSearchQuery = ''
  document.getElementById('drawer-search').value = ''
  document.getElementById('ref-drawer').classList.add('on')
  renderDrawer()
  setTimeout(() => document.getElementById('drawer-search').focus(), 100)
}

function closeDrawer() {
  document.getElementById('ref-drawer').classList.remove('on')
}

function renderRefUI() {
  renderCurrentRef()
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

// 跳转到原文位置
document.getElementById('rc-jump-btn').addEventListener('click', () => {
  if (selectedAnn) jumpToAnnotation(selectedAnn)
})

// 删除当前引用
document.getElementById('rc-del-btn').addEventListener('click', () => {
  if (selectedAnn) deleteRef(selectedAnn)
})

// 返回跳转前的位置
document.getElementById('rc-jump-back-btn').addEventListener('click', () => {
  jumpBack()
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

// ── 消息 ────────────────────────────────────────────────────────────────────
let thinkingEl = null

function showThinking() {
  hideThinking()
  const msgs = document.getElementById('msgs')
  thinkingEl = document.createElement('div')
  thinkingEl.className = 'msg-thinking'
  thinkingEl.innerHTML = `<div class="bubble"><span>思考中</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`
  msgs.appendChild(thinkingEl)
  msgs.scrollTop = msgs.scrollHeight
}

function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null }
}

// 去重：跟踪已显示的 assistant 消息（前 200 字指纹）
const _seenFingerprints = new Set()

function addBubble(role, content, extra, note) {
  // assistant 消息去重
  if (role === 'assistant') {
    const fp = (content || '').slice(0, 200)
    if (_seenFingerprints.has(fp)) return
    _seenFingerprints.add(fp)
    if (_seenFingerprints.size > 200) _seenFingerprints.clear()  // 防止无限增长
  }

  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')

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
    showThinking()
    el.className = 'msg-user'
    const quoteText = note ? `> "${esc(note)}"\n\n` : ''
    el.innerHTML = `<div class="bubble">${quoteText}${esc(content)}</div>`
  } else {
    if (_pendingRef) {
      // 非流式的引用回复（如历史回放）：直接渲染完整气泡
      _renderRefReply(content)
      return
    }
    hideThinking()
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  }

  msgs.appendChild(el)
  msgs.scrollTop = msgs.scrollHeight
}

// ── 消息去重 ──────────────────────────────────────────────────────────────
// 去重只依赖 _seenMsgs：SSE 断点续传只重放客户端没收到的（lastId 分支），
// 已显示过的消息 key 都在 _seenMsgs 里；首次连接不再回放（见 receiver），
// 所以不再需要 _historyMaxTs 这类「跳过早于 history」的守卫。
// 例外：annotation-select（设为当前引用）幂等且不产生气泡，在 connect() 里
// 走到这里之前单独处理，不参与去重（它的 key 是常量，去重会误伤第 2 次起）。
const _seenMsgs = new Set()

function _msgKey(d) {
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
    return
  }
  // 引用回复（_pendingRef 已设）：未完成输出前不显示，保持思考动画，
  // 等最终完整记录到达后由 connect() 一次渲染带引用的气泡
  if (_pendingRef) return

  // 普通回复：打字机，合并渲染进同一个气泡
  hideThinking()
  if (!_streamEl) {
    const msgs = document.getElementById('msgs')
    _streamEl = document.createElement('div')
    _streamEl.className = 'msg-assistant'
    _streamEl.innerHTML = `<div class="bubble"></div>`
    msgs.appendChild(_streamEl)
  }
  _streamEl.querySelector('.bubble').textContent = d.content || ''
  _streamEl.parentElement.scrollTop = _streamEl.parentElement.scrollHeight
}

// 渲染一条「带引用的完整回复」气泡：引用回复在流式结束后（或非流式消息）调用，
// 提取自原 addBubble 的 ref-reply 分支，供两种路径复用。
function _renderRefReply(content) {
  if (!_pendingRef) return
  hideThinking()
  const ref = _pendingRef
  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')
  el.className = 'msg-assistant ref-reply'
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

  _pendingRef = null
  msgs.appendChild(el)
  msgs.scrollTop = msgs.scrollHeight
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  if (sseConn) return
  sseConn = new EventSource(`${RECEIVER}/events`)
  sseConn.onopen = () => setDot(true)
  sseConn.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      if (d.type === 'connected') { setDot(true); return }
      if (d.type !== 'message') return

      // 流式记录（chunk / -1 结束标记）
      if (d._stream !== undefined) {
        _handleStream(d)
        return
      }

      // 流刚结束后的最终完整记录：普通回复内容已在流里显示过，直接跳过；
      // 引用回复（_pendingRef）此时才一次渲染带引用的完整气泡。
      if (_streamDone && d.role === 'assistant') {
        _streamDone = false
        _seenMsgs.add(_msgKey(d))  // 登记，防 SSE 回放重复
        if (_pendingRef) _renderRefReply(d.content)
        return
      }

      // 「设为当前引用」不产生气泡、applySetRef 幂等，不参与消息去重：
      // 该事件无 timestamp/content，去重 key 恒为常量，会误伤第 2 次起的设置。
      if (d.role === 'annotation-select') {
        applySetRef({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
          chapterUid: d.chapterUid, selectedText: d.selectedText })
        return
      }

      if (_isDuplicate(d)) return
      if (d.role === 'assistant') {
        addBubble('assistant', d.content)
      } else if (d.role === 'user-popup') {
        // 来自共读弹窗的用户消息
        _pendingRef = { bookTitle: d.bookTitle, chapter: d.chapter, selectedText: d.selectedText }
        addBubble('user-popup', d.content, null, d.selectedText)
        // 弹窗发送的标注要实时加入引用列表（标注记录 silent:true，receiver 不会推 annotation 事件）
        if (d.bookId && d.selectedText) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, selectedText: d.selectedText })
        }
      } else if (d.role === 'annotation') {
        showThinking()
        addBubble('annotation', d.content, d.selectedText, d.userNote)
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
  addBubble('user', content)
  showThinking()

  const body = { content }

  if (selectedAnn) {
    _pendingRef = { bookTitle: selectedAnn.bookTitle, chapter: selectedAnn.chapter, selectedText: selectedAnn.selectedText }
    body.bookId = selectedAnn.bookId
    body.bookTitle = selectedAnn.bookTitle
    body.chapter = selectedAnn.chapter || ''
    body.chapterUid = selectedAnn.chapterUid || ''
    body.selectedText = selectedAnn.selectedText
    body.content = `[引用]《${selectedAnn.bookTitle}》${selectedAnn.chapter || ''}\n> "${selectedAnn.selectedText}"\n\n${content}`
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
    _pendingRef = null
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

// ── 跳转到微信读书原文位置 ──────────────────────────────────────────────
let jumpBackPos = null  // { bookId, chapterUid }

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

// 从存储的 chapterUid 提取 WeRead 认识的原生 hash 槽位（e_0 / t_1）
// 兼容两种存储格式：原始槽位 "e_0"，或拼接名 "中文版前言_e_0"
function toWereadHashSlot(chapterUid) {
  const s = String(chapterUid || '')
  if (/^[te]_\d+$/.test(s)) return s
  const m = s.match(/(?:^|_)([te]_\d+)$/)
  return m ? m[1] : ''
}

async function jumpToAnnotation(ann) {
  try {
    const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
    if (!tab) { console.warn('[CoRead] no weread tab'); return }

    // 保存当前位置用于返回
    jumpBackPos = { url: tab.url }
    renderJumpBack()

    // 构造目标 URL：完整 bookId + 原生章节 hash（不能用拼接名，WeRead 不认）
    const targetBase = baseBookId(ann.bookId)
    let slot = toWereadHashSlot(ann.chapterUid)
    // 兜底：chapterUid 缺失/不可用时，用引用文字在本地正文缓存反查章节槽位
    if (!slot && ann.selectedText && ann.bookId) {
      try {
        const r = await fetch(`${RECEIVER}/find-chapter?bookId=${encodeURIComponent(ann.bookId)}` +
          `&text=${encodeURIComponent(ann.selectedText.slice(0, 60))}`)
        const j = await r.json()
        if (j?.slot) slot = j.slot
      } catch {}
    }
    let url = `https://weread.qq.com/web/reader/${targetBase}`
    if (slot) url += '#' + slot
    await chrome.tabs.update(tab.id, { url, active: true })

    // 页面加载完成后注入：兜底重设 hash（若被 SPA 剥离则触发 hashchange）
    // + 轮询高亮并滚动到引用段落
    if (ann.selectedText) {
      let done = false
      const inject = () => {
        if (done) return
        done = true
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: navigateAndHighlight,
          args: [slot, ann.selectedText],
        }).then(results => {
          const hit = (results || []).find(r => r && r.result && r.result.found)
          // 诊断：跳转后是否找到引用文字（排查 hash 导航 / 正文 frame / 结构问题）
          fetch(`${RECEIVER}/debug`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'jump', stage: 'navigate-result', slot,
              found: !!hit,
              results: (results || []).map(r => (r && r.result) || null),
            }),
          }).catch(() => {})
        }).catch(() => {})
      }
      const onUpdated = (id, info) => {
        if (id === tab.id && info.status === 'complete') inject()
      }
      chrome.tabs.onUpdated.addListener(onUpdated)
      setTimeout(inject, 5000) // 监听兜底
    }
  } catch (e) {
    console.warn('[CoRead] jump failed:', e.message)
  }
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

  // 先无条件从本地移除所有匹配项（bookId 按 baseBookId 归一化，k 会话后缀不影响匹配）
  for (let i = RECENT_ANNS.length - 1; i >= 0; i--) {
    if (sameRef(RECENT_ANNS[i], ann)) RECENT_ANNS.splice(i, 1)
  }
  // 若删的是当前选中的引用，清空选中态
  if (sameRef(selectedAnn, ann)) selectedAnn = null
  saveState()
  renderRefUI()
  renderDrawer()  // 若抽屉开着，刷新列表让删除项消失
  // 通知书页 content script 刷新共读标记（删掉的段落不再高亮）
  try { chrome.runtime.sendMessage({ action: 'refreshCoReadMarks' }) } catch {}

  // 尽力同步删除 receiver 的 annotations.jsonl 存档（失败不影响本地移除）
  try {
    const r = await fetch(`${RECEIVER}/annotation-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ann.bookId, selectedText: ann.selectedText, chapter: ann.chapter || '' }),
    })
    const j = await r.json()
    if (!j || !j.deleted) console.warn('[CoRead] delete: no archived record to remove', j)
  } catch (e) {
    console.warn('[CoRead] delete receiver sync failed:', e.message)
  }
}

// 注入到页面的纯函数（不能有闭包引用）：
// 1) 顶层 hash 缺失时重设，触发 WeRead 按 hash 切换章节
// 2) 轮询查找引用文字（穿透 shadow root），命中后滚动到该段；章节加载慢也能等
// 3) 若 hash 被保留但 WeRead 忽略（几秒内找不到文字），强制触发 hashchange 重导航
// 返回 Promise，resolve 后 executeScript 拿到每 frame 的 { found, attempts }
function navigateAndHighlight(slot, text) {
  const needle = (text || '').replace(/\s+/g, '').slice(0, 30)
  return new Promise((resolve) => {
    if (!needle) return resolve({ found: false, reason: 'no-needle' })

    const collectNodes = (root, out) => {
      // root 为 document 时 ownerDocument 是 null，需回退到 root 本身（同 content.js 修复）
      const doc = root.ownerDocument || root
      const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
      let n
      while ((n = w.nextNode())) out.push(n)
      const hosts = root.querySelectorAll('*')
      for (const h of hosts) if (h.shadowRoot) collectNodes(h.shadowRoot, out)
    }
    const topHash = () => { try { return window.top.location.hash } catch { return '' } }

    const setHash = (v) => {
      try { window.top.location.hash = v } catch {}
      try { location.hash = v } catch {}
    }
    // 初始兜底：URL 里的 hash 若被 SPA 剥离，这里重新设置以触发 hashchange
    if (slot) {
      try { if (window.top.location.hash.replace('#', '') !== slot) setHash('#' + slot) } catch {}
    }

    let attempts = 0
    let forced = false
    const forceHashChange = () => {
      if (forced || !slot) return
      forced = true
      setHash('')
      setTimeout(() => setHash('#' + slot), 60)
    }

    const tryFind = () => {
      attempts++
      // 清除旧高亮
      document.querySelectorAll('.coread-highlight').forEach(el => {
        const p = el.parentNode
        if (p) p.replaceChild(document.createTextNode(el.textContent), el)
      })
      const nodes = []
      collectNodes(document, nodes)
      for (const n of nodes) {
        if (n.textContent.replace(/\s+/g, '').includes(needle)) {
          const span = document.createElement('span')
          span.className = 'coread-highlight'
          span.style.cssText = 'background:#ffeb3b;border-radius:2px;padding:1px 0;'
          n.parentNode.insertBefore(span, n)
          span.appendChild(n)
          span.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return resolve({ found: true, attempts, topHash: topHash() })
        }
      }
      if (attempts >= 6) forceHashChange() // ~5s 还没命中，多半是章节没切过去
      if (attempts < 18) setTimeout(tryFind, 800) // 最多约 15s
      else resolve({ found: false, attempts, topHash: topHash() })
    }
    setTimeout(tryFind, 400)
  })
}

async function jumpBack() {
  if (!jumpBackPos || !jumpBackPos.url) return
  try {
    const [tab] = await chrome.tabs.query({ url: 'https://weread.qq.com/*' })
    if (!tab) return
    await chrome.tabs.update(tab.id, { url: jumpBackPos.url, active: true })
    jumpBackPos = null
    renderJumpBack()
  } catch (e) {
    console.warn('[CoRead] jump back failed:', e.message)
  }
}

function renderJumpBack() {
  const btn = document.getElementById('rc-jump-back-btn')
  if (!btn) return
  if (jumpBackPos) {
    btn.style.display = 'inline-block'
    btn.textContent = '↩ 返回'
  } else {
    btn.style.display = 'none'
  }
}

async function loadHistory() {
  try {
    const items = await fetch(`${RECEIVER}/history`).then(r => r.json())
    // 引用列表已由 loadState() 从本地恢复；这里把历史里尚未加入的标注补进来
    // （例如侧栏关闭期间新增的标注）。addRecentAnn 内部按 bookId+selectedText 去重，
    // 已存在的引用不会重排/重新编号，select:false 也不会覆盖恢复的选中状态。
    let histPendingRef = null
    for (const d of items) {
      if (d.role === 'annotation') {
        addBubble('annotation', d.content, d.selectedText, d.userNote)
        // 已在本地的引用不重复添加；侧栏关闭期间新增的标注补进来
        // （select:false 避免覆盖恢复的选中/取消选中状态）
        const exists = RECENT_ANNS.some(a => sameRef(a, d))
        if (!exists) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, selectedText: d.selectedText }, { select: false })
        }
      }
      else if (d.role === 'user') {
        addBubble('user', d.content)
        // 解析 [引用] 标记，关联后续 assistant 回复
        const ref = parseRefFromContent(d.content)
        if (ref) histPendingRef = ref
      }
      else if (d.role === 'assistant') {
        _pendingRef = histPendingRef
        histPendingRef = null
        addBubble('assistant', d.content)
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

loadState().then(loadHistory).then(connect)
