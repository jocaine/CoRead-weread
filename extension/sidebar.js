const RECEIVER = 'http://127.0.0.1:7239'
let sseConn = null

function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function setDot(connected) {
  document.getElementById('dot').style.background = connected ? '#07c160' : '#ddd'
}

// ── 引用划线数据 ──────────────────────────────────────────────────────────
const RECENT_ANNS = []
const MAX_RECENT = 50
let selectedAnn = null

function addRecentAnn(ann) {
  const dup = RECENT_ANNS.findIndex(a => a.bookId === ann.bookId && a.selectedText === ann.selectedText)
  if (dup !== -1) RECENT_ANNS.splice(dup, 1)
  RECENT_ANNS.unshift(ann)
  if (RECENT_ANNS.length > MAX_RECENT) RECENT_ANNS.length = MAX_RECENT

  // 新标注自动选中
  if (!selectedAnn) selectedAnn = ann
  // 有标注就显示入口按钮
  if (RECENT_ANNS.length > 0) {
    document.getElementById('refs-toggle-btn').classList.add('on')
  }
  renderRefUI()
}

// ── 当前引用卡片 ──────────────────────────────────────────────────────────
function renderCurrentRef() {
  const card = document.getElementById('ref-current')

  if (!selectedAnn) {
    card.classList.remove('on')
    return
  }

  card.classList.add('on')

  document.getElementById('rc-text').textContent = selectedAnn.selectedText || ''
  document.getElementById('rc-book-tag').textContent = selectedAnn.bookTitle || ''

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
    const isSel = selectedAnn &&
      selectedAnn.bookId === ann.bookId &&
      selectedAnn.selectedText === ann.selectedText

    const item = document.createElement('div')
    item.className = 'drawer-item' + (isSel ? ' sel' : '')
    const preview = esc((ann.selectedText || '').slice(0, 120))
    const exceeded = (ann.selectedText || '').length > 120

    item.innerHTML = `
      <div class="di-book">${esc(ann.bookTitle || '未知书')}</div>
      <div class="di-chapter">${esc((ann.chapter || '').slice(0, 40))}</div>
      <div class="di-text">${preview}${exceeded ? '…' : ''}</div>
      <span class="di-toggle">展开 ▼</span>
      <div class="di-full">${esc(ann.selectedText || '')}</div>`

    // 点击正文区域：选中并关闭
    item.querySelector('.di-text')?.addEventListener('click', (e) => {
      e.stopPropagation()
      selectedAnn = ann
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

// Header 按钮：打开引用列表
document.getElementById('refs-toggle-btn').addEventListener('click', () => {
  openDrawer()
})

// 卡片上的 "切换引用" 按钮
document.getElementById('rc-switch-btn').addEventListener('click', () => {
  openDrawer()
})

// 取消当前引用
document.getElementById('rc-deselect-btn').addEventListener('click', () => {
  selectedAnn = null
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

function addBubble(role, content, extra, note) {
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
  } else {
    hideThinking()
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  }

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
      if (d.role === 'assistant') addBubble('assistant', d.content)
      else if (d.role === 'annotation') {
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
    body.bookId = selectedAnn.bookId
    body.bookTitle = selectedAnn.bookTitle
    body.chapter = selectedAnn.chapter || ''
    body.chapterUid = selectedAnn.chapterUid || ''
    body.selectedText = selectedAnn.selectedText
    const quote = document.getElementById('ref-quote')
    if (quote && quote.checked) {
      body.content = `[引用]《${selectedAnn.bookTitle}》${selectedAnn.chapter || ''}\n> "${selectedAnn.selectedText}"\n\n${content}`
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

async function loadHistory() {
  try {
    const items = await fetch(`${RECEIVER}/history`).then(r => r.json())
    for (const d of items) {
      if (d.role === 'annotation') {
        addBubble('annotation', d.content, d.selectedText, d.userNote)
        addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
          chapterUid: d.chapterUid, selectedText: d.selectedText })
      }
      else if (d.role === 'user') addBubble('user', d.content)
      else if (d.role === 'assistant') addBubble('assistant', d.content)
    }
  } catch {}
}

loadHistory().then(connect)
