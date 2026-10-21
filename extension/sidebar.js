// ── 托盘要用的一件事：把扩展 ID 报给本机服务（POST /hello）────────────────────
// 侧栏是经典脚本（sidebar.html 用 <script src> 引入），不能 import translate-protocol.js，
// 所以这里按同样的报文自己发一份 —— 字段名（id/version）与那个模块里的
// reportExtensionToHost 必须一致，改一处就要改另一处。
//
// 为什么侧栏也要报：service worker 可能因空闲被浏览器回收，而"浏览器启动"与"服务端启动"
// 的先后顺序也不固定（先开浏览器、后开托盘是常见顺序）。侧栏是用户最常打开的地方，
// 让它每次打开都补报一次，托盘就不必等 SW 被唤醒。
//
// 静默失败：接收端没起时这不是错误，吞掉即可，绝不能影响侧栏加载。
function reportExtensionToHost() {
  try {
    fetch(RECEIVER + '/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }),
    }).catch(() => {})
  } catch (e) {}
}

const RECEIVER = 'http://127.0.0.1:7239'
reportExtensionToHost()   // 必须在这行之后：函数体里用到 RECEIVER
// 自由模式（2026-09 定调；2026-11 扩为多对话）：侧栏里的独立上下文，引用解析照常
// 命中正式会意图，对话内容默认不留痕（不进长期记忆、不进正式图）。
// 多对话（2026-11 用户定调）：每个自由对话 = 一个独立 bookKey（__coread_free_<8hex>__；
// 默认对话沿用历史哨兵 FREE_KEY），历史/消息区/讨论栈/命中全按"按书隔离"这条既有链路
// 天然互不串味；归档时由用户勾选是否保存记忆、是否走正常收口程序进正式拓扑图。
const FREE_KEY = '__coread_free_mode__'   // 默认自由对话（历史哨兵书，向后兼容）
const FREE_KEY_RE = /^__coread_free_/
let _freeMode = false  // 是否处于自由模式（进入后消息区/引用/图视图按自由对话隔离）
let _freeKey = FREE_KEY  // 当前自由对话的 key（多对话：每场对话一个 key）
let _freeConvs = []      // 活动自由对话清单（GET /free-conversations 的 active）
let _freeArchived = []   // 已归档自由对话（墓碑记录：产物去向说明）

// 当前自由对话持久化：面板重开/切换 tab 后回到上次那场对话（与 manualBook 同款思路）。
// 读回发生在 loadState()（异步），这里只提供读写两个入口 + 内存值。
function saveFreeState() {
  try { chrome.storage.local.set({ freeConvKey: _freeKey || FREE_KEY }) } catch {}
}
function restoreFreeKey() {
  return isFreeConvKey(_freeKey) ? _freeKey : FREE_KEY
}
let _savedReadingAnn = null  // 进入自由模式前暂存的读书模式选中引用（退出自由模式时恢复）
let _savedExitCtx = null  // 进入自由模式前 _currentBook 的快照（退出时恢复实时上下文用）

// 是否自由对话 key（默认哨兵 + 新建对话都算）
function isFreeConvKey(key) {
  return FREE_KEY_RE.test(String(key || ''))
}

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

// 不可见双向控制字符（bidi controls）：U+061C 阿拉伯字母标记、U+200E LRM、U+200F RLM、
// U+202A~U+202E 嵌入/覆盖、U+2066~U+2069 隔离。它们能把一整段文字的方向翻成 RTL，
// 从而让全角引号 “ ” 被镜像成 ” “（顺序整个反过来），而字符本身在界面上完全看不见。
// 用户从书籍正文 / 网页粘贴时可能带进来，这里统一在显示层剥掉（正文收发不受影响）。
const BIDI_INVISIBLE_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

function stripInvisibleBidi(t) {
  return String(t == null ? '' : t).replace(BIDI_INVISIBLE_RE, '')
}

function esc(t) {
  return stripInvisibleBidi(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// 属性值转义（href 等）：esc 之后补引号，避免内容提前闭合属性
function escAttr(t) {
  return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ── Markdown 渲染（2026-10）─────────────────────────────────────────────────
// AI 回复是 markdown（**加粗**、小标题、列表、引用、表格…），此前一律走 textContent +
// white-space:pre-wrap 原样显示，星号、竖线、# 直接暴露给用户。这里做一个自包含的
// 迷你渲染器：MV3 扩展页 CSP 不允许远程脚本，引 marked/markdown-it 还要多一份打包流程，
// 所以手写，只覆盖讨论回复里真实会出现的语法。
//
// 安全模型（重要）：整段文本先按行 HTML 转义，再在**转义后的结果**上套标记 →
// 正文里的 < > & 永远是实体，所有标签都只可能由本文件生成，不存在注入面。
// 链接 href 另走协议白名单（http/https/mailto），javascript: 之类退化成纯文本。
//
// 支持：段落 / 软换行（单换行按 <br>）、# 标题、**粗**、*斜*、~~删除~~、`行内码`、
//      ``` 围栏代码块 ```、> 引用、- / 1. 列表（更深的缩进做视觉下沉）、--- 分隔线、
//      | 表格 |、[文本](链接) 与裸链接。
function mdInline(s) {
  // 行内代码先摘出来占位：里面的 * _ ~~ 不该被当成强调标记
  const codes = []
  let t = String(s == null ? '' : s).replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c)
    return '\u0001' + (codes.length - 1) + '\u0001'
  })
  // 链接 [文本](url)：白名单外的协议（javascript: / data: …）不建链，保留原文
  t = t.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, text, url) => {
    const raw = url.replace(/&amp;/g, '&')
    if (!/^(?:https?:|mailto:)/i.test(raw)) return m
    return '<a href="' + escAttr(raw) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
  })
  // 裸链接（前面是行首或空白等边界，避免把已生成的 href 再包一层）
  t = t.replace(/(^|[\s(（【])(https?:\/\/[^\s<>()（）【】"]+)/g, (m, pre, url) =>
    pre + '<a href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>')
  t = t.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^\n]+?)__/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
  t = t.replace(/(^|[^\w_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
  t = t.replace(/~~([^\n]+?)~~/g, '<del>$1</del>')
  t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code class="md-code">' + codes[Number(i)] + '</code>')
  return t
}

// 表格分隔行（|---|:--:|）判定与单元格切分
function mdIsTableSep(line) {
  return !!line && line.includes('|') && line.includes('-') && /^\s*\|?[\s:|-]*\|?\s*$/.test(line)
}
function mdSplitRow(line) {
  return String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}
function mdColAlign(sepCell) {
  const s = String(sepCell).trim()
  if (/^:-+:$/.test(s)) return 'md-c'
  if (/^:-+$/.test(s)) return 'md-l'
  if (/^-+:$/.test(s)) return 'md-r'
  return ''
}

function mdToHtml(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  const para = []  // 段落缓冲：软换行渲染成 <br>
  const flushPara = () => {
    if (!para.length) return
    out.push('<p>' + para.join('<br>') + '</p>')
    para.length = 0
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 围栏代码块：``` / ~~~ 起止，内容只转义不做高亮（AGENT.md 禁止回复带代码块，仅兜底）
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      flushPara()
      const closeRe = new RegExp('^\\s*' + fence[1][0] + '{3,}\\s*$')
      const buf = []
      i++
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(esc(lines[i])); i++ }
      if (i < lines.length) i++  // 吃掉闭合围栏（未闭合则吃到末尾）
      out.push('<pre class="md-pre"><code>' + buf.join('\n') + '</code></pre>')
      continue
    }
    // 空行 = 段落边界
    if (!line.trim()) { flushPara(); i++; continue }
    // 分隔线
    if (/^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line)) {
      flushPara()
      out.push('<hr class="md-hr">')
      i++
      continue
    }
    // 标题：# 后必须有空格；级别往下压（+2），聊天气泡里 h1/h2 太抢眼
    const head = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (head) {
      flushPara()
      const lv = Math.min(head[1].length + 2, 6)
      out.push('<h' + lv + '>' + mdInline(esc(head[2])) + '</h' + lv + '>')
      i++
      continue
    }
    // 引用块：连续 > 行合并成一个 blockquote
    if (/^\s{0,3}>/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        buf.push(mdInline(esc(lines[i].replace(/^\s{0,3}>\s?/, ''))))
        i++
      }
      out.push('<blockquote>' + buf.join('<br>') + '</blockquote>')
      continue
    }
    // 表格：本行含 | 且下一行是分隔行 → 表头 + 表体
    if (line.includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      flushPara()
      const headCells = mdSplitRow(line)
      const aligns = mdSplitRow(lines[i + 1]).map(mdColAlign)
      i += 2
      let body = ''
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = mdSplitRow(lines[i])
        let tr = ''
        for (let c = 0; c < headCells.length; c++) {
          tr += '<td' + (aligns[c] ? ' class="' + aligns[c] + '"' : '') + '>' +
            mdInline(esc(cells[c] || '')) + '</td>'
        }
        body += '<tr>' + tr + '</tr>'
        i++
      }
      let hr = ''
      for (let c = 0; c < headCells.length; c++) {
        hr += '<th' + (aligns[c] ? ' class="' + aligns[c] + '"' : '') + '>' +
          mdInline(esc(headCells[c] || '')) + '</th>'
      }
      out.push('<table class="md-table"><thead><tr>' + hr + '</tr></thead><tbody>' + body + '</tbody></table>')
      continue
    }
    // 列表：连续同类项合成一个 ol/ul；缩进更深的项做视觉下沉（不做真正的嵌套层级，
    // 聊天气泡里够用，也避免层级算法的边界坑）
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushPara()
      const ordered = /\d/.test(item[2])
      const baseIndent = item[1].replace(/\t/g, '  ').length
      let html = ordered ? '<ol class="md-list">' : '<ul class="md-list">'
      let j = i
      while (j < lines.length) {
        const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[j])
        if (!m) break
        if (/\d/.test(m[2]) !== ordered) break  // 类型切换 → 结束本列表
        const indent = m[1].replace(/\t/g, '  ').length
        html += '<li' + (indent > baseIndent ? ' class="md-sub"' : '') + '>' + mdInline(esc(m[3]))
        // 续行：缩进的非列表行并入本项（markdown 的 lazy continuation）
        let k = j + 1
        const cont = []
        while (k < lines.length && lines[k].trim() &&
               !/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(lines[k]) && /^\s+/.test(lines[k])) {
          cont.push(mdInline(esc(lines[k].trim())))
          k++
        }
        if (cont.length) html += '<br>' + cont.join('<br>')
        html += '</li>'
        j = k
      }
      html += ordered ? '</ol>' : '</ul>'
      out.push(html)
      i = j
      continue
    }
    // 普通段落行
    para.push(mdInline(esc(line)))
    i++
  }
  flushPara()
  return out.join('')
}

// 助理气泡正文（markdown）。.md 类在 CSS 里关掉白空格保留，改由块级元素负责排版——
// 生成 HTML 里没有多余空白，但 pre-wrap 仍会把源码换行当空白显示，直接关掉更稳。
function mdBubble(content) {
  return '<div class="bubble md">' + mdToHtml(content) + '</div>'
}

// 可靠的删除图标（SVG 描边垃圾桶，避免 🗑 emoji 在 Windows 下渲染异常/模糊）
const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>'
// 表头「删除当前引用」按钮统一填充 SVG 图标（HTML 里的 🗑 仅作兜底）
try { document.getElementById('rc-del-btn').innerHTML = ICON_TRASH } catch {}

// ── 连接状态（2026-10 改：轮询当唯一真源）─────────────────────────────────
// 谁说了算：**轮询**。插件每 5 秒敲一次接收端的 /ping，问的是"你现在答不答得上来"。
// 为什么不用 SSE 的连接状态当判据：SSE 断线时浏览器会静默重连，状态可能长时间偏绿
//   （半开连接），而"灯是绿的、消息却发不出去"正是要消灭的那个假象。
// 为什么不在发送那一刻才探：那样用户打完字、按了发送才知道，字还可能被清掉。
//   常驻轮询让用户在**打字之前**就看见。
// 绿灯要同时满足两条：问得出去（轮询通过）+ 答得回来（SSE 连着）。
let _backendAlive = false   // 轮询结果：接收端答不答得上来（决定能不能发送）
let _sseOpen = false        // SSE 连接：回复能不能实时推过来（决定灯够不够绿）
let _pingTimer = null

function refreshDot() {
  const dot = document.getElementById('dot')
  if (!dot) return
  dot.style.background = (_backendAlive && _sseOpen) ? '#07c160' : '#ddd'
  dot.title = !_backendAlive
    ? 'CoRead 本机服务未运行'
    : (!_sseOpen ? '推送通道已断开，正在重连' : 'CoRead 本机服务运行中')
}

function setBackendAlive(alive) {
  const was = _backendAlive
  _backendAlive = alive
  // 状态**变化**才记（每 5 秒刷一条日志会把 debug.jsonl 冲爆）。
  // 为什么必须留痕：指示灯灰着的时候，"轮询不通"和"推送通道没连上"是两种完全不同的
  // 故障，而它们都表现成一个灰点（2026-10-20 用户报"接收端在跑、灯是灰的"，
  // 就是靠这行日志分清的）。
  if (was !== alive) postSidebarDebug({ stage: 'conn-state', alive, sse: _sseOpen })
  refreshDot()   // 灯是唯一的常驻提示；发送被拦时的解释走弹窗（见 showSendFailedNotice）
  // 本机服务刚起来（启动顺序常是"先开侧栏、后开 CoRead"）：无书界面正停在
  // 「读不到已读书籍」的话顺手重拉一次书单，省得用户自己去找那个「重试」
  if (alive && !was && _nbShown && _booksFailed) refreshNoBookBooks()
  // 本机服务刚起来：补一次"图里有几个点"的基线（见 initGraphCoachBaseline）。
  // 少了它，先开侧栏后启动 CoRead 的用户永远等不到第一个知识点的引导。
  if (alive && !was) initGraphCoachBaseline()
}

function setSseOpen(open) {
  if (open === _sseOpen) return
  _sseOpen = open
  postSidebarDebug({ stage: 'conn-state', alive: _backendAlive, sse: _sseOpen })
  refreshDot()
}

async function pingOnce() {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2000)   // 卡住的请求也要有个头，否则轮询会堆积
  try {
    const r = await fetch(RECEIVER + '/ping', { signal: ctl.signal, cache: 'no-store' })
    setBackendAlive(r.ok)
  } catch {
    setBackendAlive(false)
  } finally {
    clearTimeout(timer)
  }
}

function startPingLoop() {
  pingOnce()                                     // 立刻探一次，别让灯先灰 5 秒
  if (_pingTimer) clearInterval(_pingTimer)
  _pingTimer = setInterval(pingOnce, 5000)
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
/**
 * 阅读器此刻**明确**报着一本真书吗（2026-11）。
 *
 * 用途：清空"当前书"之前的最后一道防线——**挡住那些"猜出来的清空"**（消息往返失败、
 * 页面还没起来之类）。与 `_currentBook` 的区别：这个是"阅读器说的"，
 * 那个是"侧栏当前认定的"，两者可能因为时序而不一致。
 *
 * ⚠️ 它**不等于**"用户在看这本书"（2026-11 二次改版）：阅读器标签页开着、但用户切到了
 * 别的标签页时，清空是**对的**（与微信读书那本书表现一致）。所以由"活动标签页身份"
 * 得出的清空会带 `authoritative` 绕过这道防线，见 applyBookContext。
 */
let _readerReportsBook = false
// 上面那个事实是"什么时候知道的"（2026-11）。日志里带上它，
// 才能一眼分清"阅读器刚说过有书"和"是很久以前说的、中间可能已经关掉了"。
let _readerReportsBookAt = 0
// 手动选书（2026-10）：读书模式未检测到阅读书籍时，从「已读过的书籍」里手动选择
// 一本书查看它的历史记录——已读完的书在微信读书外没有聊天记录入口，这是查看/
// 继续讨论的兜底。有效上下文优先级：自由模式 > 手动选书 > 实时检测到的书；
// 检测到真实阅读上下文后自动退出手动选书，恢复跟随。持久化在 storage（manualBook）。
let _manualBook = null  // { base, bookTitle }
// 消息书签（AI-001）：流式回复归属的书。annotation / user-popup / 书绑定聊天设置它，
// 之后的 assistant 流式气泡继承，用于按书过滤消息区。
let _thinkingBook = ''

let _toastTimer = 0
// 最近的微信读书上下文（{ base, bookTitle }）：退出自由模式时恢复用（页面广播 / 面板打开时记录）
let _lastWereadContext = null
// 文本附件（上传后读取进本次讨论，不落盘保存原文件、不建已上传列表）：读到的文件正文暂存这里
let _pendingAttachment = null  // { fileName, text } | null

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

// 从本地列表移除满足条件的引用；若移除的是当前选中的引用，一并清空选中态并清除
// 待选标记（AI-018）。划线删除（annotation-removed）、删除引用、/history 对账清理
// 共用此入口——保证"列表里没了，选中态也没了"，避免卡片继续显示已删除引用 /
// 已删划线的陈旧内容（此前 annotation-removed 与对账清理只 splice 不碰 selectedAnn，
// 卡片会把已删除引用的内容一直显示到面板重开）。
function removeAnns(pred) {
  let selectedRemoved = false
  for (let i = RECENT_ANNS.length - 1; i >= 0; i--) {
    const a = RECENT_ANNS[i]
    if (!pred(a)) continue
    if (selectedAnn && refMatches(selectedAnn, a)) selectedRemoved = true
    RECENT_ANNS.splice(i, 1)
  }
  if (selectedRemoved) {
    selectedAnn = null
    clearPendingSelect()
  }
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
    sourceUrl: a.sourceUrl || '',
    selectedText: a.selectedText,
    // 译文（2026-11）：不写进这里，面板重开后引用卡就变回原文显示 ——
    // "刚设完是译文、重开一次成原文"正是这一处会漏的。
    ...(a.translation ? { translation: a.translation } : {}),
    refNum: a.refNum
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
        sourceUrl: selectedAnn.sourceUrl || '',
        selectedText: selectedAnn.selectedText,
        // 译文（2026-11）：同上——选中的那条也要带着，否则重开后卡片又显示原文
        ...(selectedAnn.translation ? { translation: selectedAnn.translation } : {}),
        refNum: selectedAnn.refNum
      } : null,
      // 2026-10：手动选书持久化——面板重开后保持上次手动查看的书；
      // refreshCurrentBook 启动时会检测真实阅读上下文，检测到书则自动退出
      manualBook: _manualBook ? { base: _manualBook.base, bookTitle: _manualBook.bookTitle } : null
    })
  } catch {}
  saveFreeState()  // 当前自由对话（多对话，2026-11）
  scheduleRefsSave()
}

async function loadState() {
  try {
    const data = await chrome.storage.local.get(['refs', 'refNumCounter', 'selectedRef', 'pendingSelectRef', 'fontSize', 'manualBook', 'freeConvKey'])
    // 恢复自由模式上次所在的对话（2026-11 多对话）：清单拉到后 loadFreeConversations
    // 会校正失效的 key（对话已被归档/删除 → 落到最近活跃的一场）
    if (isFreeConvKey(data.freeConvKey)) _freeKey = data.freeConvKey
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
    // 2026-10：手动选书恢复——启动时先恢复，refreshCurrentBook 检测到真实阅读
    // 上下文会自动退出手动选书（见 applyBookContext）
    if (data.manualBook && typeof data.manualBook.base === 'string') {
      _manualBook = { base: data.manualBook.base, bookTitle: String(data.manualBook.bookTitle || '').trim() }
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
  // AI-001：当前书（有效上下文，含手动选书）的待选引用才强制选中；其他书的等切回该书再处理
  const effBase = effectiveBookBase()
  if (effBase && baseBookId(ref.bookId) !== effBase) return
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
  // AI-001：当前书（有效上下文，含手动选书）之外的引用不强制选中（加入列表即可），
  // 避免聊天误绑定旧书
  const effBase = effectiveBookBase()
  if (effBase && baseBookId(ann.bookId) !== effBase) {
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
// 侧栏已打开时也能实时把该标注设为当前引用。
// 2026-11 起 content.js 真的会发它（画一条微信读书划线时）：面板关着时这条消息没有收件人
// （静默失败），靠的是同一个动作里写下的 pendingSelectRef 待选标记——见 content.js 的
// syncBookmarkRef 与下面的 applyPendingSelect。
//
// ⚠️ 参数列表必须带 `sendResponse`：里面有分支要**同步回答**（侧栏探针），
// 漏了就报 `sendResponse is not defined`——自检报告里当场现形（2026-11）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'coreadSidebarProbe') {
    // 自检问侧栏的真实状态（2026-11）。为什么要这个口子：
    // 用户连报几轮"还是不行"，而我只能从日志反推"他点的是哪个按钮、抽屉里到底有没有东西"。
    // 有了它，自检可以直接问侧栏要一份**可读的事实**，不用猜。
    //
    // 注意是**同步回答**（sendResponse 立刻回，不返回 true 等异步）：
    // 它只读内存里的几个变量，没有异步成分。
    try {
      sendResponse(sidebarProbe())
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) })
    }
    return
  }
  /**
   * 自检要能"**真的点一下**"（2026-11 用户质问："为什么不能用插件内的来试试看"）。
   *
   * ── 为什么必须加这条通道 ────────────────────────────────────────────────────
   * 上面那条 `coreadSidebarProbe` 只能**问**状态，点不了任何东西。而用户报的
   * "点切换引用之后底层界面跳回选书界面"——问的时候一切正常，**点下去**才出事。
   * 于是自检一直是绿的，用户那边一直是坏的。
   *
   * 为什么不能让自检页自己去点：`chrome.scripting` / `tabs.sendMessage` 只能注入**网页**，
   * 侧栏是扩展自己的页面，浏览器**没有**任何 API 能从外面往里注入脚本。
   * 所以"点一下会怎样"只能在侧栏内部发生：这里列一张**动作表**，自检报动作名，
   * 侧栏真的去 `.click()` 那个真按钮——走的是用户点它时**完全同一条**代码路径。
   *
   * ⚠️ 只认表里的名字，**不接受代码字符串**：MV3 的 CSP 是 `script-src 'self'`，
   * `eval` / `new Function` 会被浏览器当场拒绝（踩过，见 selfcheck.js 里 readerOp 的注释）。
   */
  if (msg?.action === 'coreadSelfcheckOp') {
    /** 用户眼睛能看到的那几件事：当前书、无书视图露没露、抽屉开着没、引用卡上是什么 */
    const sideState = () => {
      const nbView = document.getElementById('no-book-view')
      return {
      book: effectiveBookBase(),
      picker: !!document.getElementById('book-picker')?.classList?.contains('on'),
      drawer: !!document.getElementById('ref-drawer')?.classList?.contains('on'),
      ref: String((document.getElementById('rc-text') || {}).textContent || ''),
      drawerItems: document.querySelectorAll('#drawer-list .drawer-item').length,
      // 「回到选书界面」的**准确**判据（2026-11 自检实测订正）：
      // 原先我用的是书单浮层 `#book-picker`，而用户看到的那一跳其实是**无书视图**
      //（`#no-book-view`：内联已读书籍列表 + 底部那格换成 PDF 入口条）。
      // 判据挂错元素 = 真出事时它还是绿的（实测：book 已经变空，picker 却是 false）。
      noBook: !!nbView && nbView.hidden === false,
      readerHasBook: _readerReportsBook,
      }
    }
    const selfcheckOps = {
      state: sideState,
      /** 用户点「切换引用 ▸」：就是那个按钮、就是那个处理器（openDrawer + 快照） */
      clickSwitchRef() {
        const b = document.getElementById('rc-switch-btn')
        if (!b) return { ok: false, error: '#rc-switch-btn 不在（界面改过？）' }
        b.click()
        return { ok: true, clicked: 'rc-switch-btn' }
      },
      /** 用户点抽屉里的第 N 条引用：走它自己的 click 处理器（pickReference + 关抽屉） */
      clickDrawerItem(arg) {
        const i = Number(arg) || 0
        const items = document.querySelectorAll('#drawer-list .drawer-item')
        if (!items[i]) return { ok: false, error: '抽屉里没有第 ' + i + ' 条（当前 ' + items.length + ' 条）' }
        // 报回去的是**引用原文**（`.di-text` 里那一句），不是整个条目的文字——
        // 条目里还带章节/书名等附注，拿它去比对引用卡会永远对不上。
        const text = String((items[i].querySelector('.di-text') || {}).textContent || '')
        items[i].click()
        return { ok: true, clicked: i, text: text }
      },
      closeRefDrawer() {
        closeDrawer()
        return { ok: true }
      },
    }
    const fn = selfcheckOps[String(msg.op || '')]
    if (!fn) {
      sendResponse({ ok: false, error: '未知动作：' + String(msg.op) + '（可用：' + Object.keys(selfcheckOps).join('/') + '）' })
      return
    }
    try {
      const r = fn(msg.arg)
      sendResponse(Object.assign({ ok: true }, r && typeof r === 'object' ? r : { value: r }))
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) })
    }
    return
  }
  if (msg?.action === 'coreadSetRefApply' && msg.ref) {
    const r = msg.ref
    // 带上划线定位字段（bookmarkRange / bookmarkId）：与 receiver 的 annotation-sync
    // 事件同形，删除引用时才认得出"是这条划线的引用"（否则同文本的多条会连坐）
    applySetRef({ bookId: r.bookId, bookTitle: r.bookTitle, chapter: r.chapter || '',
      chapterUid: r.chapterUid || '', chapterUidInt: r.chapterUidInt || 0, selectedText: r.selectedText,
      bookmarkRange: r.bookmarkRange || '', bookmarkId: r.bookmarkId || '',
      sourceUrl: r.sourceUrl || '' })
  }
  // AI-021 网页阅读源：读者在网页上手动建书/绑定页面后，把该书设为手动查看的书
  //（绑定是用户主动动作，非自动跟随；退出自由模式限制同 coreadBookContext）
  if (msg?.action === 'coreadManualBook') {
    if (_freeMode) return
    const base = String(msg.bookId || '')
    if (!/^[A-Za-z0-9_]{12,}$/.test(base)) return
    const title = String(msg.bookTitle || '').trim()
    _manualBook = { base: base, bookTitle: title }
    saveState()
    applyBookContext({ bookId: base, bookTitle: title })
  }
  // AI-011：划线内容 → 引用栏搜索（来自 content.js 工具栏按钮，侧栏已打开时的实时通道）。
  // 同时清掉 storage 待搜词，避免面板后续加载再重复开一次抽屉。
  if (msg?.action === 'coreadOpenRefSearch') {
    _pendingRefSearch = null
    try { chrome.storage.local.remove('pendingRefSearch') } catch {}
    openDrawerWithSearch(msg.query || '')
  }
  // AI-001：content.js 广播当前阅读书籍（切书 = 页面导航，content.js 重载即广播）。
  if (msg?.action === 'coreadBookContext') {
    // 自由模式期间忽略书页广播：测试上下文不被切书/页面导航打断，退出自由模式时恢复
    if (_freeMode) return
    if (typeof msg.bookId === 'string') {
      _lastWereadContext = { base: baseBookId(msg.bookId), bookTitle: String(msg.bookTitle || '').trim() }
    }
    applyWereadBroadcast(msg, sender)
  }
})

// 解析用户消息中的 [引用] 标记，提取引用信息。
// ⚠️ 走 splitQuotedQuestion，**不要**自己写正则：引用块可能是多行（译文一换行就会），
// 而正文里那个换行会提前结束引用块 —— 单行正则在这里会截出半句、进而配错引用。
function parseRefFromContent(content) {
  const q = splitQuotedQuestion(content)
  return q ? { bookTitle: q.book, chapter: q.chapter, selectedText: q.quote } : null
}

/**
 * 拆一条「带引用的提问」的 content：`[引用]《书名》章节` + `> "划线原文"` + 空行 + 提问正文。
 *
 * 为什么要拆：库里 user 消息对引用提问是**带前缀的**（写入侧见 submit 里的 body.content），
 * 而气泡以前只喂正文（本地回显就是正文），于是同一条提问有两种长相——刚发出去是干净的
 * 提问，重开面板后从历史回放却会连着 `[引用]《书名》…` 和 `> "原文"` 一起显示在绿气泡里。
 * 现在发送与回放**喂同一份文本**（见 submit 的 bubbleText），气泡把这段前缀渲染成
 * **上方横幅**（与回答气泡的 .ref-quote-preview 同一套视觉），正文另起一块。
 *
 * 返回 null = 不是引用提问（自由提问 / 斜杠命令 / 附件开头的消息），气泡照旧整段纯文本。
 * 注意**只在开头认**：附件消息是 `[附件]《…》…\n\n[引用]…`，前缀不在行首就整段照旧，
 * 免得把附件正文也误当引用块啃掉。
 */
function splitQuotedQuestion(content) {
  const s = String(content || '')
  const m = s.match(/^\[引用\]《([^》]*)》([^\n]*)\n/)
  if (!m) return null
  const lines = s.slice(m[0].length).split('\n')
  const quotes = []
  let i = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('>')) { quotes.push(t.replace(/^>\s?/, '').replace(/^"|"$/g, '')); continue }
    if (!t) { if (quotes.length) i++; break }   // 空行 = 引用块到此为止
    break
  }
  if (!quotes.length) return null
  return {
    book: (m[1] || '').trim(),
    chapter: (m[2] || '').trim(),
    quote: quotes.join('\n'),
    body: lines.slice(i).join('\n').replace(/^\n+/, '').replace(/\s+$/, ''),
  }
}

/**
 * 一个引用标记成什么文本：**扩展把译文设成的引用显示译文**（2026-11 用户定调）。
 *
 * 为什么要有这一层：PDF 场景下原文是外文、用户读的是译文，所以引用卡与对话里那条
 * 引用横幅都该显示译文；但原文仍是这条引用的**身份**（判重、删除匹配、跳回原文全用它，
 * 见 sameRef / refMatches），一个字都不能动。有译文用译文，没有就回落原文 ——
 * 微信读书的划线、以及没翻译过的段落都走回落，长相与改动前完全一致。
 */
function refDisplayText(a) {
  if (!a) return ''
  return String(a.translation || '').trim() || String(a.selectedText || '')
}

// 引用横幅里最多显示多少字：与回答气泡的引用条同一个 80 字口径（超出打省略号），
// 全文放 title —— 提问气泡的横幅是"这条提问引了哪段"，不是给人读原文的地方。
const QUOTE_BANNER_MAX = 80

/**
 * 把一条提问拼成 `[引用]《书名》章节` + `> "引用块"` + 空行 + 正文。
 * 引用块可多行：每行都带 `>`，因为正文里的换行会**提前结束**引用块（见 splitQuotedQuestion）。
 */
function buildQuotedQuestion(book, chapter, quoteText, body) {
  const quoted = String(quoteText || '').split('\n')
    .map((line) => '> "' + line + '"')
    .join('\n')
  return `[引用]《${book || ''}》${chapter || ''}\n${quoted}\n\n${body || ''}`
}

/**
 * 一条提问该显示成什么文本：能凑出 `[引用]《书名》章节` + `> "原文"` 的形态就凑出来，
 * 再由 splitQuotedQuestion 拆成"上方横幅 + 正文"。
 *
 * 为什么要有这一层：**两种提问在数据里的长相不一样**——
 *   · 侧栏提交：content 自带前缀（`[引用]…\n> "…"\n\n提问`，写入侧见 submit）；
 *   · 共读弹窗提交：content 只有提问，引用另存 selectedText 字段（receiver 的 /chat 落库）。
 * 后者若不在这里拼回来，同一条"带引用的提问"就会有两种下场：实时气泡靠 selectedText 画出
 * 引用行、重开面板后从历史回放却**连引用一起不见了**（历史回放只喂 content）。
 *
 * ⚠️ 2026-11：`msg.translation` 有值时横幅显示**译文**（见 refDisplayText）。
 * 历史消息落库的 content 里存的是当时的引用块（老消息里是原文），所以回放时用
 * `/history` 带回来的 translation 把那一块**重建**一遍 —— 不重建的话，同一条提问
 * "刚发出去显示译文、重开面板后变回原文"，又是一处"两种长相"。
 * 认不出是哪条引用时原样返回，绝不猜。
 */
function quotedQuestionText(msg) {
  const c = String((msg && msg.content) || '')
  const display = String((msg && msg.translation) || '').trim()
  if (/^\[引用\]/.test(c)) {
    if (!display) return c
    const q = splitQuotedQuestion(c)
    if (!q) return c
    return buildQuotedQuestion(q.book, q.chapter, display, q.body)
  }
  const sel = String((msg && msg.selectedText) || '')
  if (!sel) return c
  // PDF 那条路：selectedText 是原文（引用身份），translation 是用户读到的那半边
  return buildQuotedQuestion((msg && msg.bookTitle) || '', (msg && msg.chapter) || '',
    display || sel, c)
}

/** 带引用的提问气泡的 HTML：上方横幅（引用文本）+ 正文。
 *  横幅**只是横幅**：不出回答气泡那根竖排书名条（2026-11 用户定调"竖着的不要"）；
 *  书名与章节**也不显示在横幅上**（同日用户定调）——横幅就照回答气泡那条的样子，
 *  只有引用文本。悬停提示同理只放引用全文（横幅截断时能看到全的）。
 *  书名/章节仍在解析结果里（`q.book`/`q.chapter` 用于点击横幅时选回那条引用），
 *  只是不上屏。
 *
 *  `q.quote` 走的是 refDisplayText：PDF 那条引用带译文时这里显示**译文**，
 *  原文进 title —— 气泡是给人读的，而用户读得懂的是译文。 */
function userQuoteBubbleHTML(q) {
  const full = q.quote
  const shown = full.length > QUOTE_BANNER_MAX ? full.slice(0, QUOTE_BANNER_MAX) + '…' : full
  return (
    '<div class="bubble">' +
      // title 走 escAttr：原文里可能有半角引号（译文常见），esc 不转义 `"`，直接拼会把属性提前闭合
      '<div class="uq-quote" title="' + escAttr(full) + '">' +
        '<span class="uqq-text">"' + esc(shown) + '"</span>' +
      '</div>' +
      '<div class="uq-body">' + esc(q.body) + '</div>' +
    '</div>'
  )
}

/**
 * 把一条提问的文本渲染进气泡：拆得出引用 → 上方横幅 + 正文；拆不出 → 整段纯文本。
 * 横幅可点（与回答气泡的引用条同一个动作：把这条引用设回"当前引用"）。
 * 侧栏提交的提问、共读弹窗来的提问、历史回放三条路都走它——三种入口一种长相。
 */
function renderQuoteBubble(el, content) {
  const q = splitQuotedQuestion(content)
  if (!q) {
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
    return false
  }
  el.innerHTML = userQuoteBubbleHTML(q)
  const quoteEl = el.querySelector('.uq-quote')
  if (quoteEl) {
    quoteEl.addEventListener('click', () => selectRefByPending({
      bookTitle: q.book, chapter: q.chapter, selectedText: q.quote,
    }))
  }
  return true
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

/**
 * 书名比较（容错，2026-11）。
 *
 * 同一本书在数据里**可能有两种写法**：老数据把章节拼在书名里
 *（「大国大城：当代中国的统一、发展与平衡 1 欧洲正经历大考」），
 * 新数据从写入侧起只留干净书名（「大国大城：当代中国的统一、发展与平衡」）。
 *
 * 为什么必须容错：历史消息里的引用条、历史引用列表都还是老写法，而这两处
 *（findRefNum 找序号、selectRefByPending 点引用条切当前引用）以前是 `===` 比较——
 * 一旦一边干净一边带章节，就会**静默不匹配**：用户点引用条，界面上什么都不发生。
 * 两种写法之间恰好是"前缀"关系，用前缀判定既认得出同一本，又不会张冠李戴
 *（真正的身份另有 sameRef：bookId + 原文，这里只管显示与选中）。
 */
function titleMatches(a, b) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (x === y) return true
  if (!x || !y) return false
  return x.indexOf(y) === 0 || y.indexOf(x) === 0
}

// 根据引用文本查找序号
function findRefNum(bookTitle, chapter, selectedText) {
  for (const a of RECENT_ANNS) {
    if (titleMatches(a.bookTitle, bookTitle) && a.selectedText === selectedText) return a.refNum
  }
  for (const a of RECENT_ANNS) {
    if (titleMatches(a.bookTitle, bookTitle) && selectedText && (a.selectedText || '').includes(selectedText.slice(0, 30))) return a.refNum
  }
  return ''
}

// 根据 pendingRef 信息选中对应的引用
function selectRefByPending(ref) {
  for (const a of RECENT_ANNS) {
    if (titleMatches(a.bookTitle, ref.bookTitle) && sameRef(a, ref)) {
      selectedAnn = a
      clearPendingSelect()  // 用户显式选择取代残留待办
      saveState()
      renderRefUI()
      return
    }
  }
  for (const a of RECENT_ANNS) {
    if (titleMatches(a.bookTitle, ref.bookTitle) && ref.selectedText &&
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
// 主体显示什么：refDisplayText —— 带译文的引用（PDF 翻译那条路）显示译文，
// 其余照旧显示原文。原文**不藏起来**：卡片里有"原文"一栏可展开（见 renderCurrentRef），
// 点「📍」跳回原文也永远按原文定位（引用身份始终是原文）。
//
// AI-018：折叠态缩略概览 = 书名 + 引用前文。选中引用时填充，空态/无选中时清空，
// 折叠时（.collapsed 且非 .empty）CSS 显示它——切换引用后折叠态也能直接看清当前引用。
function renderCollapsedPreview() {
  const pv = document.getElementById('rc-preview')
  if (!pv) return
  if (!selectedAnn) { pv.innerHTML = ''; return }
  const hasTr = !!String(selectedAnn.translation || '').trim()
  pv.innerHTML =
    `<div class="rcp-book">《${esc(selectedAnn.bookTitle || '')}》</div>` +
    `<div class="rcp-text"${hasTr ? ` title="${escAttr('原文：' + (selectedAnn.selectedText || ''))}"` : ''}>` +
    `${esc(refDisplayText(selectedAnn))}</div>`
}

function renderCurrentRef() {
  const card = document.getElementById('ref-current')

  // 自由模式隐藏「当前引用」窗体：测试上下文不显示任何引用卡片
  //（进入/退出自由模式都经 applyBookContext → renderCurrentRef 刷新）
  if (_freeMode) {
    card.classList.remove('on')
    return
  }

  // 无有效上下文（未检测到阅读书籍、未手动选书）：隐藏引用卡片，消息区由
  //「无书默认界面」接管——不再残留显示上一本书的选中引用（2026-10）
  if (!effectiveBookBase()) {
    card.classList.remove('on')
    return
  }

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
    renderCollapsedPreview()  // 空态概览留空（CSS 也不显示）
    renderJumpBack()
    return
  }

  card.classList.remove('empty')
  document.getElementById('rc-jump-btn').style.display = ''
  document.getElementById('rc-del-btn').style.display = ''
  document.getElementById('rc-collapse-btn').style.display = ''
  document.getElementById('rc-deselect-btn').style.display = ''
  renderJumpBack()  // AI-006：有跳转记录才显示「↩ 返回」

  renderCollapsedPreview()
  renderCurrentRefBody(selectedAnn)
  document.getElementById('rc-book').textContent = selectedAnn.bookTitle || ''

  const chapter = selectedAnn.chapter || ''
  const len = (selectedAnn.selectedText || '').length
  document.getElementById('rc-meta').innerHTML =
    `${chapter ? `<span>章节：${esc(chapter)}</span>` : ''}<span>${len} 字</span>`
}

/**
 * 卡片正文：**主体是引用文本，译文优先**（见 refDisplayText）。
 *
 * 带译文时另起一栏「原文」——默认收起，点一下展开。
 * 为什么要留这一栏（而不是把原文彻底藏掉）：原文是这条引用的身份，
 * 用户核对"引的到底是哪一句"、以及把它跟书页对上时都要看它；
 * 但它不该跟译文抢主角位置（PDF 场景下用户根本读不懂它）。
 */
function renderCurrentRefBody(a) {
  const box = document.getElementById('rc-text')
  if (!box) return
  const original = String((a && a.selectedText) || '')
  const translation = String((a && a.translation) || '').trim()

  box.replaceChildren()
  const main = document.createElement('div')
  main.className = 'rc-main'
  main.textContent = refDisplayText(a)
  box.appendChild(main)

  if (!translation || !original) return   // 没有译文：就是原来的单块原文，一个字都不变

  const details = document.createElement('div')
  details.className = 'rc-orig'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'rc-orig-toggle'
  btn.textContent = '原文 ▸'
  btn.title = '显示这条引用的原文（引用按原文定位、按原文判重）'
  const body = document.createElement('div')
  body.className = 'rc-orig-text'
  body.hidden = true
  body.textContent = original
  btn.addEventListener('click', () => {
    body.hidden = !body.hidden
    btn.textContent = body.hidden ? '原文 ▸' : '原文 ▾'
  })
  details.append(btn, body)
  box.appendChild(details)
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
  // AI-001：引用严格按有效上下文隔离。未读到书且未手动选书时不列任何引用，
  // 绝不回退成"全部"，否则抽屉会把多本书的引用混在一起（正是"没隔离"的根因）。
  // 手动选书（2026-10）时按选中的书隔离。
  const base = effectiveBookBase()
  if (!base) return []
  let list = RECENT_ANNS.filter(a => baseBookId(a.bookId) === base)
  // 检索两侧都剥掉不可见双向控制字符（见 esc 注释）：划线文本从书页抄来、搜索词从
  // 工具栏带过来，同一段文字两边可能一边带 RLM、一边不带，不归一化就会"明明有却搜不到"
  const q = stripInvisibleBidi(drawerSearchQuery).trim().toLowerCase()
  if (q) {
    list = list.filter(a => {
      return stripInvisibleBidi(a.bookTitle || '').toLowerCase().includes(q) ||
        stripInvisibleBidi(a.chapter || '').toLowerCase().includes(q) ||
        stripInvisibleBidi(a.selectedText || '').toLowerCase().includes(q)
    })
  }
  // AI-013：抽屉按书中位置倒序显示（只排序渲染副本，不影响 RECENT_ANNS 内部与选中逻辑）
  return sortRefsByPositionDesc(list)
}

// 搜索命中高亮：把文本按查询切分，命中的片段包 <mark>。分段后各自 esc，
// 避免先整体转义再套标签时把 &lt; 等实体的中间部分误当命中打坏。
// 两侧都先剥不可见双向控制字符（与 filterAnns 的检索口径一致，否则命中标不上）。
function hl(text, q) {
  const src = stripInvisibleBidi(text)
  const query = stripInvisibleBidi(q)
  if (!query) return esc(src)
  const safeQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${safeQ})`, 'i')
  return src.split(re).map(p => {
    if (p && p.toLowerCase() === query.toLowerCase()) return `<mark>${esc(p)}</mark>`
    return esc(p)
  }).join('')
}

// 查询命中是否落在概览可见区（前30字 / 后20字）。
// 命中整段都在头 30 字或尾 20 字内 → 概览已可见；横跨省略号或被遮在中间 → 需展开。
function matchVisibleInPreview(text, q) {
  const src = stripInvisibleBidi(text)
  const len = src.length
  if (len <= 50) return true  // 概览即全文，必然可见
  const low = src.toLowerCase()
  const qi = stripInvisibleBidi(q).toLowerCase()
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

/**
 * 侧栏的真实状态（供自检查询）。
 *
 * 这是"不要再猜"的落点：当前书认出来没、抽屉开着没、引用卡里现在是什么、卡上有哪些按钮
 * ——全部一次性读出来。这些都是本页面内存里的东西，回答没有异步成分。
 */
function sidebarProbe() {
  return {
    ok: true,
    drawerOpen: !!(document.getElementById('ref-drawer') || {}).classList
      && document.getElementById('ref-drawer').classList.contains('on'),
    bookBase: effectiveBookBase(),
    refText: String(((document.getElementById('rc-text') || {}).textContent) || '').slice(0, 40),
    // 抽屉里现在有几条引用（自检用它验"切换引用"这一步真的把东西摆出来了）
    drawerItems: document.querySelectorAll('#drawer-list .drawer-item').length,
    // 引用卡上那两个按钮的实际位置——"用户到底点了哪个"这个问题以后不必再靠日志反推
    refCardButtons: [...document.querySelectorAll('#ref-current button, .rc-head button')].map((b) => ({
      id: b.id, text: String(b.textContent || '').trim().slice(0, 12), title: String(b.title || '').slice(0, 20),
    })),
  }
}
window.__coreadSidebarProbe = sidebarProbe

/**
 * 把一条引用设为当前引用（抽屉里点一条、或"设为当前引用"那条链路都走它）。
 *
 * 为什么要把"选引用"抽出来：原来只有抽屉里那一条 DOM 处理器会这么干，
 * 于是别的地方想选一条只能**再写一遍**——而"再写一遍"的代价是两边会分叉
 * （一边清了待选标记、另一边忘了）。
 */
function pickReference(ann) {
  if (!ann) return false
  selectedAnn = ann
  clearPendingSelect()   // 用户显式选择取代残留待办
  saveState()
  renderRefUI()
  return true
}

function renderDrawer() {
  const list = document.getElementById('drawer-list')
  list.innerHTML = ''
  // AI-001：标题标注当前隔离范围——按有效上下文（实时检测 / 手动选书）列引用，
  // 未在读且未手动选书时提示先打开书（2026-10 手动选书也在这里）
  const titleEl = document.getElementById('drawer-title')
  const effBook = effectiveBook()
  if (titleEl) titleEl.textContent = effBook && effBook.bookTitle
    ? `引用 · 《${effBook.bookTitle}》`
    : '暂未关联书籍'

  const anns = filterAnns()

  if (anns.length === 0) {
    const hint = !effBook
      ? '未在读书籍页：请打开一本书，或从已读书籍中选择'
      : '无匹配引用'
    list.innerHTML = `<div style="text-align:center;color:#bbb;padding:20px;font-size:0.92em;">${hint}</div>`
    return
  }

  // 检索口径与 filterAnns 一致：两侧都剥不可见双向控制字符（否则高亮/自动展开会失灵）
  const q = stripInvisibleBidi(drawerSearchQuery).trim().toLowerCase()

  for (const ann of anns) {
    const isSel = sameRef(selectedAnn, ann)

    const raw = ann.selectedText || ''
    // 概览：前30字 + 省略号 + 后20字；50 字以内直接显示全文
    const exceeded = raw.length > 50
    const previewText = exceeded ? raw.slice(0, 30) + '…' + raw.slice(-20) : raw
    // 搜索时命中藏在省略号中间的文本 → 自动展开让命中可见（命中在概览里则保持折叠）
    const autoExpand = !!(q && exceeded && stripInvisibleBidi(raw).toLowerCase().includes(q) && !matchVisibleInPreview(raw, q))

    const item = document.createElement('div')
    item.className = 'drawer-item' + (isSel ? ' sel' : '') + (autoExpand ? ' expanded' : '')
    // 展开/折叠按钮放在正文下方：折叠时跟在概览后面，展开时跟在全文后面
    const toggleHtml = exceeded
      ? `<span class="di-toggle">${autoExpand ? '折叠 ▲' : '展开 ▼'}</span>`
      : ''  // 全文不足 50 字：概览即全文，无需展开按钮
    // 「章节：」标签跟着值走（2026-11）：chapter 为空时这一行留空，
    // **不留一句没下文的"章节："**。标签写在 hl() 外面，搜索命中只染章节名本身。
    const chapterHtml = ann.chapter ? `章节：${hl(ann.chapter.slice(0, 40), q)}` : ''
    item.innerHTML = `
      <div class="di-head">
        <span class="di-num">#${ann.refNum || '?'}</span>
        <span class="di-book">${hl(ann.bookTitle || '未知书籍', q)}</span>
      </div>
      <div class="di-chapter">${chapterHtml}</div>
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
  // 2026-10：按有效上下文拉取（手动选书时拉手动选中的书）
  const effBook = effectiveBook()
  if (!effBook || !effBook.base) return false
  try {
    const r = await fetch(`${RECEIVER}/annotations?bookId=${encodeURIComponent(effBook.base)}`)
    const list = await r.json()
    if (!Array.isArray(list)) return false
    let added = 0
    for (const d of list) {
      if (!d.selectedText) continue
      const exists = RECENT_ANNS.some(a => sameRef(a, d))
      if (!exists) {
        addRecentAnn({
          bookId: d.bookId || effBook.base,
          bookTitle: d.bookTitle || effBook.bookTitle,
          chapter: d.chapter || '', chapterUid: d.chapterUid || '',
          chapterUidInt: d.chapterUidInt || 0,
          bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
          selectedText: d.selectedText,
          // 译文（2026-11）：SSE 断线后靠这趟全量补齐，漏了它就会出现
          // "实时那条有译文、补齐出来的那条没有"
          ...(d.translation ? { translation: d.translation } : {}),
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
  const searchEl = document.getElementById('drawer-search')
  searchEl.value = drawerSearchQuery
  cleanInputBidi(searchEl)  // 书页抄来的搜索词可能夹带不可见双向控制字符，先剥掉再显示
  drawerSearchQuery = searchEl.value
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
// 有效上下文：自由模式 > 手动选书 > 实时检测到的书。所有"当前书"判定（消息过滤、
// 引用隔离、命中隔离、发送归属、头部显示）都走这里，保证手动选书时全链路按
// 选中的书工作（2026-10：无书默认界面 + 已读书籍手动选择）。
// 自由模式（2026-11 多对话）：base = 当前自由对话 key，title = 对话标题——
// 每个对话一个 key，消息区/讨论栈/命中按 key 隔离，切换对话 = 切上下文。
function effectiveBook() {
  if (_freeMode) return { base: _freeKey || FREE_KEY, bookTitle: freeConvTitle(_freeKey) }
  if (_manualBook) return _manualBook
  return _currentBook
}
function effectiveBookBase() {
  const b = effectiveBook()
  return b ? b.base : ''
}

// 头部队列显示有效上下文，无书时回落到格言；自由模式显示「自由模式 · 对话标题」
function renderCurrentBook() {
  const el = document.getElementById('current-book')
  if (!el) return
  const book = effectiveBook()
  if (book && book.bookTitle) {
    el.innerHTML = isFreeConvKey(book.base)
      ? '<span style="font-weight:600">自由模式</span>'
      : `《${esc(book.bookTitle)}》`
    el.title = book.bookTitle
  } else {
    el.innerHTML = '<em>We read to know we are not alone.</em>'
    el.title = ''
  }
}

// 按当前上下文过滤消息区：自由模式只显示**当前对话**的消息（该对话 key）；读书模式
// 只显示有效上下文（实时检测 / 手动选书）的书的消息；无有效上下文（书架/首页等且未
// 手动选书）时隐藏全部消息，消息区由「无书默认界面」接管——不再像旧逻辑那样
// 残留显示上一本书/全部书的内容（2026-10 修复）。自由对话之间同样按 key 隔离
//（2026-11 多对话）：切对话 = 切 key，天然只显示该场对话。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ **消息区是"一个容器装所有会话"**：切书 / 切对话只把别的会话的气泡置成
// `display:none`，**不从 DOM 移除**。所以 #msgs 里躺着所有会话的历史，几百个隐藏
// 节点是常态。由此派生出一条铁律（2026-11 用一次真实故障换来）：
//
//   **任何想知道"这格有什么 / 有多少 / 是不是空的"的代码，都必须同时按
//   上下文归属 + 可见性判断，一律走下面 nodesInContext()。**
//
// 只数"有没有子元素"的判据会永远为真——2026-11 开场卡整整两轮没露面，就是
// hasRealMsg() 撞上别的书的隐藏气泡、认定"已有内容"（屏幕上什么都没有，日志却
// 说 real=true）。裸写 `for (const el of msgs.children)` 属于同类错误，
// test/selftest/check-msgs-walk.mjs 会在跑批时直接拦下。
// ─────────────────────────────────────────────────────────────────────────────
function applyBookFilter() {
  const book = effectiveBookBase()
  const msgs = document.getElementById('msgs')
  for (const el of msgs.children) {   // msgs-walk-ok: 规则的**源头**，它自己定义可见性
    const b = el.dataset.book || ''
    el.style.display = (book && b === book) ? '' : 'none'
  }
  // AI-005：切书后浮窗提问列表同步刷新（只列当前书可见的提问）
  renderJumpBars()
  if (jumpFab && jumpFab.classList.contains('open')) renderJumpList()
}

/**
 * 一条消息是不是属于**当前**上下文的？—— 与 applyBookFilter 同一把尺子。
 *
 * 这是"当前会话可见内容"的唯一定义。别的判据（数数、判空、收集提问、清理节点）都不
 * 该自己再写一遍：两边一旦分叉，就会出现"看得见的是空的、代码却认为有内容"这类
 * 幽灵 bug（2026-11 实测）。
 */
function msgInCurrentContext(el) {
  const book = effectiveBookBase()
  if (!book || !el) return false
  return String((el.dataset && el.dataset.book) || '') === book
}

/**
 * 当前上下文的节点（顺序 = DOM 顺序）。**遍历消息区一律用它**，别裸写 msgs.children：
 *   · 过滤掉别的书 / 别的对话的气泡（它们只是被隐藏，还在 DOM 里）
 *   · 过滤掉开场卡的壳（id=intro，它不属于"内容"）
 * 传 all=true 才返回不过滤的原始列表（只有 msgsDigest 这类诊断要用，见那边的 marker）。
 *
 * 返回的是**新数组**：调用方可以边遍历边 remove/append 而不受影响。
 */
function nodesInContext({ all = false } = {}) {
  const msgs = document.getElementById('msgs')
  if (!msgs) return []
  const out = []
  for (const el of msgs.children) {   // msgs-walk-ok: 唯一入口自身
    if (all) { out.push(el); continue }
    if (el.id === 'intro') continue
    if (msgInCurrentContext(el)) out.push(el)
  }
  return out
}

// 滚到底部展示当前上下文最新内容。必须在 #msgs 可见后调用：无书状态下
// renderNoBookView 把消息区设为 display:none，此时设置 scrollTop 是 no-op
//（恢复显示时会被重置为 0）——所以上下文切换的滚动统一放在调用方的
// renderNoBookView() 之后执行（applyBookContext / pickBook / exitManualBook）。
function scrollMsgsToBottom() {
  const msgs = document.getElementById('msgs')
  if (msgs) msgs.scrollTop = msgs.scrollHeight
}

// 有效上下文变化时的统一处理：取消异书选中引用、刷新引用/消息过滤、
// 恢复/清除"当前讨论命中"。切书 / 手动选书 / 退出手动选书 / 进出自由模式共用。
// 滚动到底部由各调用方在 renderNoBookView 恢复消息区可见之后调用 scrollMsgsToBottom。
function onEffectiveContextChange() {
  const effBase = effectiveBookBase()
  // 命中脉络按书隔离（2026-09）：每本书的实时栈独立，命中显示只在它所属的上下文
  // 存在。上下文切换（切书 / 手动选书 / 进出自由模式）后，旧书或旧模式的命中高亮
  // 与挂起的命中动画不再属于当前上下文——取消动画并清掉高亮（自由模式进出也走
  // 这里：applyBookContext({bookId: FREE_KEY}) / 恢复读书上下文）
  if (_hitBook && _hitBook !== effBase) {
    _hitBook = ''
    if (graphView) {
      graphView._cancelAutoDismiss()
      graphView.clearHighlight()
    }
  }
  // 选中引用属于其他书 → 取消选中（保留在列表里），避免聊天误绑定旧书
  if (effBase && selectedAnn && baseBookId(selectedAnn.bookId) !== effBase) {
    selectedAnn = null
    saveState()
  }
  renderCurrentRef()
  renderDrawer()
  applyBookFilter()
  // 2026-09：切换/初始化后恢复新书的"当前讨论命中"高亮（实时栈 cites → /stack-hits）
  refreshStackHits()
}

// 手动选书期间检测到真实阅读（选的就是这本也算"已在读"）：退出兜底的手动
// 查看，恢复自动跟随。有效上下文没变（实时书 == 手动书）时不弹提示。
//
// 2026-11：这段逻辑从 applyBookContext 里抽出来单独一个函数——阅读器那条路
//（refreshCurrentBook 问后台"阅读器里开着哪本 PDF"）也要用同一套退出规则，
// 复制一遍必然走偏。
function leaveManualBookIfRealRead(next) {
  if (!_manualBook || !next || _freeMode) return
  const switched = _manualBook.base !== next.base
  _manualBook = null
  saveState()
  if (switched) showToast('检测到正在阅读《' + (next.bookTitle || '…') + '》，已恢复自动跟随')
}

// 应用阅读上下文：记录实时检测到的书；有效上下文变化时取消其他书的选中引用、
// 刷新引用/消息过滤。手动选书期间，实时上下文不打断手动查看；一旦检测到真实
// 阅读上下文（任何一本书），自动退出手动选书恢复跟随——手动选书是"无书时查看
// 历史记录"的兜底入口（2026-10）。
//
// ⚠️ 第三个参数 `opts.authoritative`（2026-11 二次改版）：
//   含义是"**这个结论来自问不倒的事实**，不要去质疑它"（目前只有一种来源：
//   活动标签页是哪一类页面 —— 只查 URL，不问消息，见 refreshCurrentBook）。
//   它唯一的作用是绕过下面 `_readerReportsBook` 那道防线。为什么必须能绕过：
//   那道防线是"阅读器开着书就不许清空"，而"阅读器开着"**不等于**"用户在看它" ——
//   用户切到毫不相干的网页时，侧栏就该回到无书界面（与微信读书标签页一致），
//   此时防线必须让路，否则又变回"只要那个标签页还在，侧栏就一直挂着它的会话"。
function applyBookContext(ctx, why, opts) {
  const rawBase = baseBookId(ctx && ctx.bookId)
  // 防御：只认形如真实书 ID 的 bookId。书架/首页等非阅读页的历史广播可能带
  // "shelf"、空串等垃圾值，若写入 _currentBook 会让引用隔离失效（AI-001）。
  const base = /^[A-Za-z0-9_]{12,}$/.test(rawBase) ? rawBase : ''
  const bookTitle = String((ctx && ctx.bookTitle) || '').trim()
  const next = base ? { base, bookTitle } : null
  const prevEffBase = effectiveBookBase()
  /**
   * 诊断（2026-11）：**"当前书被清空"这件事必须留痕**。
   *
   * 快照显示：点开切换引用后的 0.4 秒内，侧栏的"当前书"从 `rd_e0c91c…` 变成空，
   * 而阅读器**一直**好好地报着"第一次共读"。也就是说清空是侧栏自己干的，
   * 但日志里看不出是**哪条路**（`refreshCurrentBook` 的清空分支、阅读器快照的清空分支、
   * 退出自由模式、还是别的）——用户看到的"底层界面回到选书界面"就是它，而我没有证据只能猜。
   * 所以这里把调用来源（堆栈）一起记下来。
   */
  if (!next && _currentBook) {
    /**
     * ⚠️ **防线**（2026-11）：如果阅读器此刻报着一本真书，就不许清空。
     *
     * 为什么加它：快照显示点开抽屉后的 0.4 秒内"当前书"被清空，而阅读器**一直**
     * 好好地报着"第一次共读"。清空走的是哪条路我还没抓到（已加日志），
     * 但无论哪条路，**"阅读器开着书"这个事实优先于任何清空意图**——
     * 清了就是用户看到的"底层界面回到选书界面"（书单铺开 + 底部那格换成 PDF 入口条）。
     *
     * 这道防线不猜来源、不依赖时序，直接把最坏的结果挡住。
     *
     * ⚠️ 但它**只挡"猜出来的清空"**（2026-11 二次改版）：`authoritative` 的清空来自
     * 活动标签页的身份（问不倒的事实），那类清空必须放行——否则用户切到别的标签页时，
     * 侧栏会一直挂着阅读器里那本书的会话，正是本轮要修掉的现象。
     */
    if (_readerReportsBook && !(opts && opts.authoritative)) {
      postSidebarDebug({
        stage: 'book-context-clear-blocked',
        was: String(_currentBook.base || '').slice(0, 20),
        why: String(why || '(未标注)'),
      })
      return
    }
    const st = (new Error()).stack || ''
    postSidebarDebug({
      stage: 'book-context-cleared',
      was: String(_currentBook.base || '').slice(0, 20),
      rawBase: String(rawBase || '').slice(0, 20),
      // `why` = **谁**要清空。调用栈只能告诉你"在 refreshCurrentBook 里"，
      // 而那个函数里有几条路都会清（阅读器说没书 / 活动标签页不是在读书 / 微读书页说没有书）——
      // 光看栈分不清是哪条，2026-11 就因此多猜了一轮。调用方现在必须自己报上来。
      why: String(why || '(未标注)'),
      readerReportsBook: _readerReportsBook,
      caller: st.split('\n').slice(1, 5).map((s) => s.trim().replace(/^at\s+/, '').split(' ')[0]).join(' < '),
    })
  }
  _currentBook = next
  leaveManualBookIfRealRead(next)
  const newEffBase = effectiveBookBase()
  const ctxChanged = !prevEffBase || prevEffBase !== newEffBase
  /**
   * **"当前书换了一本"必须留痕**（2026-11 用户报"读《大国大城》时会话莫名跳到教程"）。
   *
   * 原先只有"清空"留痕（book-context-cleared），而"从 A 换到 B"一声不响——
   * 于是用户说"莫名其妙跳了"时，日志里查不到任何东西，只能猜。
   * 这里把 from / to / why / 调用来源一起记下来：谁把上下文换掉的，一眼可读。
   */
  if (newEffBase !== prevEffBase) {
    const st = (new Error()).stack || ''
    postSidebarDebug({
      stage: 'book-context-changed',
      from: String(prevEffBase || '(空)').slice(0, 20),
      to: String(newEffBase || '(空)').slice(0, 20),
      why: String(why || '(未标注)'),
      caller: st.split('\n').slice(1, 5).map((s) => s.trim().replace(/^at\s+/, '').split(' ')[0]).join(' < '),
    })
  }
  if (ctxChanged) onEffectiveContextChange()
  renderCurrentBook()
  renderNoBookView()
  renderManualBanner()
  // 滚动必须等 renderNoBookView 恢复 #msgs 可见之后（无书→有书切换时，
  // 此前消息区是 display:none，在那之前设 scrollTop 会被重置为 0）
  if (ctxChanged) scrollMsgsToBottom()
}

/**
 * 侧栏打开 / 切换标签页时，问后台"我现在该认哪本书"。
 *
 * ── 规则一句话（2026-11 二次改版，用户定调：与微信读书标签页一致）────────────
 *   **当前书 = 活动标签页所代表的那本书；活动标签页不是阅读源 → 无书（书单界面）。**
 *
 *     活动标签页 = 我们的阅读器   → 它开着的那本 PDF（它答不上来就保持原样，绝不清）
 *     活动标签页 = 微读的**书页** → 那本书（书 ID 从 URL 就能读出来，书名问页面）
 *     活动标签页 = 别的任何页面   → 无书：书单铺开，与微读那本书被切走时一模一样
 *
 * ── 为什么改（用户实测）─────────────────────────────────────────────────────
 * 改之前，只要标签栏里还开着那个 PDF 标签页，侧栏就一直挂着它的会话——哪怕用户正在
 * 看毫不相干的网页。两个原因叠加：
 *   ① 后台会"按 URL 在整条标签栏里找一个开着的阅读器标签页"顶上来（旧 readerBookInfo）；
 *   ② 这里还额外有一条"阅读器标签页还开着 → 绝不清空"的防线。
 * 两条都是治"点切换引用跳回选书界面"时加的，**治过头**：把"阅读器开着"当成了"正在读"。
 *
 * ── 仍然保留的谨慎（都是真 bug 换来的，别删）─────────────────────────────────
 *   · 后台答不上来 / 没带回 req（答话的不是后台） → **什么都不动**
 *   · 阅读器说"正在打开书"或答非所问（unknown/loading） → 保持上一次已知的书
 *   · 决定"有没有书"的只有**问不倒的事实**：活动标签页是哪一类页面（只查 URL，见
 *     translate-background.js 的 activeTabKind）。"问页面"拿到的东西只用来补书名/章节，
 *     问不到就退回 URL 里那个书 ID —— 绝不因为"问不到"而清空。
 */
async function refreshCurrentBook() {
  // 自由模式期间保持自由上下文：不被面板重开/活动 tab 变化刷新覆盖（退出时手动恢复）
  if (_freeMode) {
    applyBookContext({ bookId: _freeKey || FREE_KEY, bookTitle: freeConvTitle(_freeKey) })
    return
  }
  let r = null
  /**
   * ⚠️ 问的是 `readerContextQuery`（**只给后台的一条**），不是 `readerBookInfo`。
   *
   * `readerBookInfo` 是**广播**，打开着的阅读器页面也会收到并作答（它那条监听是给
   * "后台点名问页面"用的），而广播**先答的赢**。页面只能说"我这儿开着哪本"，
   * 它不知道自己是前台还是后台标签页——于是用户切回微信读书时，页面抢先答一句
   * "我这儿开着教程书"，侧栏就永远回不到微读那本书（2026-11 用户实测）。
   * 带 `req` 随机串是第二道锁：答复必须原样带回来，才算后台那条路的答复。
   */
  const req = 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  try {
    r = await chrome.runtime.sendMessage({ action: 'readerContextQuery', req })
  } catch (e) {
    // 抛错 ≠ 没有书（2026-11 实测：这里原先是个静默的 `catch {}`，
    // 于是一条"问不到"的路会静悄悄地走到下面的兜底，把当前书清掉）。
    postSidebarDebug({ stage: 'reader-info-threw', error: String((e && e.message) || e) })
    return
  }
  /**
   * ⚠️ 只认**后台**的答复：必须把 `req` 原样带回来（见 translate-background.js 里
   * readerContextQuery 的注释）。一份没有 req 的答复说明答话的不是后台
   *（阅读器页面 / 别的监听者），那种情况按"答不上来"处理——**什么都不动**。
   */
  if (!r || r.req !== req) {
    postSidebarDebug({
      stage: 'reader-info-shape-unknown',
      kept: String(effectiveBookBase() || '(空)').slice(0, 20),
      why: '答复里没有带回 req：答话的不是后台那条路，按"答不上来"处理',
    })
    return
  }
  /**
   * ① 活动标签页**就是**我们的阅读器 → 它说哪本就是哪本。
   *
   * ⚠️ 判据是"**没明说不是**，就按是来处理"（2026-11 根因）：`notReader` 缺字段的答复
   * 曾经被当成"后台说这不是阅读器"，于是掉进微读那条兜底、把当前书清空 ——
   * 用户看到的"底层界面回到选择书界面"就是它。
   */
  if (r.notReader !== true) {
    // 记住"阅读器此刻报着什么"——清空当前书之前会看它（见 applyBookContext 的防线）。
    // 覆盖 `unknown` 的情况：只有**明确**报了一本真书才算数。
    rememberReaderBook(r.book && r.book.bookId && !r.unknown)
    /**
     * `unknown` = 阅读器在，但**它现在答不上来**（页面正在加载/重载，内容脚本还没起来）。
     * 这种情况**绝不能当成"没有书"**——那会把当前书清掉：书单铺开、底部那格换成
     * PDF 入口条、引用变"暂未关联书籍"。正确做法：**保留上一次已知的书**。
     */
    if (r.unknown || r.loading) {
      postSidebarDebug({
        stage: 'reader-info-unknown',
        kept: (_currentBook && _currentBook.base || '').slice(0, 20),
        loading: !!r.loading,
      })
      return
    }
    const b = r.book
    if (b && b.bookId) {
      // 记进 _lastWereadContext？不：那个变量是"最近的微信读书上下文"，退出自由模式
      // 时恢复用；把 PDF 塞进去会让退出自由模式后显示一本没在微读里打开的书。
      //
      // ⚠️ 书名取 `b.name`，不是 `b.bookTitle`（2026-11 修"灰节点"根因）：
      // 阅读器回的 bookInfo 是 { bookId, hash, name, page, total }（见 reader.js 的
      // readerBookInfo），**根本没有 bookTitle 这个字段**。原先读 b.bookTitle 恒为
      // undefined → 当前书变成"书 ID 对、书名空"：头部退回格言，且此后**纯打字提问**
      // 落库只有 bookId、没有书名（带划线的消息不受影响：它的书名来自标注记录）。
      // 收口那边又只从划线取书名 → 节点没有书 → 图上涂成默认灰（未归属书籍）。
      const bTitle = String(b.name || b.bookTitle || '').trim()
      leaveManualBookIfRealRead({ base: baseBookId(b.bookId), bookTitle: bTitle })
      applyBookContext({ bookId: b.bookId, bookTitle: bTitle },
        'reader-branch:活动标签页是阅读器，它报着这本书', { authoritative: true })
    } else {
      // 阅读器**明确**说"我这儿没开着书"（回到书库了）→ 无书。这话是它自己说的，照做。
      applyBookContext({ bookId: '' }, 'reader-branch:活动标签页是阅读器，它说没开着书', { authoritative: true })
    }
    return
  }
  /**
   * ② 活动标签页不是阅读器 → 它在不在"读书"由**它的身份**决定（后台的 `activeKind`）。
   *
   * 这一类结论只查 URL、不问消息，所以可以放心执行——包括清空：
   *   'weread'（书架/详情/搜索）、'other'（任何别的网页） → 没有书
   *   'page'（文库网页） → 页面自己知道它被绑定到哪本书（binding 存在 chrome.storage.local，
   *                        见 source-mia.js）；已绑定就认那本，未绑定才回到无书界面
   *   'unknown'（拿不到活动标签页：没有窗口 / 查询失败） → 什么都不知道，**别动侧栏**
   */
  const kind = String(r.activeKind || 'unknown')
  if (kind === 'other' || kind === 'weread') {
    postSidebarDebug({
      stage: 'active-tab-not-reading',
      kind,
      was: String(effectiveBookBase() || '(空)').slice(0, 20),
      why: '活动标签页不是在读书的页面 → 与微读那本书被切走时一样，回到无书界面',
    })
    applyBookContext({ bookId: '' }, 'active-tab:活动标签页是「' + kind + '」，不是在读书', { authoritative: true })
    return
  }
  if (kind === 'page') {
    /**
     * 网页阅读源：页面自己报绑定（AI-021）。
     *
     * 为什么必须问：绑定是**一次**用户动作（弹窗里点「绑定这本书」），而 `coreadManualBook`
     * 只在绑定的那一瞬间送到侧栏。用户切到别的标签页再切回来、或重开侧栏时，那条消息早没了；
     * 若不在这里补问，侧栏会按"活动标签页不是读书页"清成无书界面，而页面明明还绑着书，
     * 用户就得去书单里重新点一次——"加入一本书"看起来像没生效。
     *
     * 只问**活动标签页的顶层 frame**：source-mia 在 iframe 里也跑，广播式询问会被子 frame
     * 抢答（它按自己的路径解析绑定，可能解析出另一本书）。问不到就当未绑定：页面还在加载时
     * 内容脚本确实可能没起来，等 `tabs.onUpdated` 的 complete 会再问一次。
     */
    let binding = null
    const tabId = Number(r.tabId)
    if (Number.isFinite(tabId) && tabId > 0) {
      try {
        binding = await chrome.tabs.sendMessage(tabId, { action: 'coreadBindingQuery' }, { frameId: 0 }).catch(() => null)
      } catch (e) {}
    }
    if (binding && binding.ok && binding.bound && binding.bookId) {
      applyBookContext(
        { bookId: binding.bookId, bookTitle: binding.bookTitle || '' },
        'page-branch:网页阅读源页面已绑定这本书',
        { authoritative: true },
      )
      return
    }
    postSidebarDebug({
      stage: 'active-tab-page-unbound',
      was: String(effectiveBookBase() || '(空)').slice(0, 20),
      answered: !!binding,
      why: '活动标签页是文库网页，且页面没报出绑定 → 无书（侧栏给「加入一本书」入口）',
    })
    applyBookContext({ bookId: '' }, 'page-branch:网页阅读源页面未绑定', { authoritative: true })
    return
  }
  if (kind === 'unknown') {
    postSidebarDebug({ stage: 'active-tab-unknown', kept: String(effectiveBookBase() || '(空)').slice(0, 20) })
    return
  }
  // ③ 活动标签页是微读的**书页** → 问它要书名/章节（书 ID 从 URL 也能直接读出来）
  try {
    let ctx = null
    const tabId = Number(r.tabId)
    if (Number.isFinite(tabId) && tabId > 0) {
      // 定向问**活动标签页**的顶层 frame（不走广播：广播会被每个 content script 帧抢答，
      // 可能绑到非活动 tab 的书，AI-008）。tabId 用后台给的那个，不再自己查一次——
      // 两次查询之间用户切了 tab，两个答案就会打架。
      try {
        ctx = await chrome.tabs.sendMessage(tabId, { action: 'getReadingContext' }, { frameId: 0 }).catch(() => null)
      } catch (e) {}
    }
    if (ctx && typeof ctx.bookId === 'string' && ctx.bookId) {
      _lastWereadContext = { base: baseBookId(ctx.bookId), bookTitle: String(ctx.bookTitle || '').trim() }
      applyBookContext(ctx, 'weread-branch:活动标签页是微读书页，它报了这本书', { authoritative: true })
      return
    }
    if (ctx && typeof ctx.bookId === 'string') {
      // 页面答了、但说"我不是书页"：**页面比 URL 权威**（URL 可能刚导航过去、页面还没跟上）
      applyBookContext({ bookId: '' }, 'weread-branch:微读书页说自己没有书（页面更权威）', { authoritative: true })
      return
    }
    /**
     * 问不到（内容脚本还没起来 / 页面正在加载）→ 书 ID 直接**从 URL 读**：
     * `/web/reader/<书 ID>`，与 content.js 的 getReadingContext 读的是同一段路径，所以不算猜。
     * 书名尽力补（当前书同名 → 已读书单），补不到就空着：书对了、标题晚一拍，
     * 好过把上一本书留在界面上。
     */
    const base = bookIdFromReaderUrl(r.url || '')
    if (!base) {
      postSidebarDebug({ stage: 'weread-branch-no-book-id', url: String(r.url || '').slice(0, 80) })
      return
    }
    const known = (_currentBook && _currentBook.base === base ? _currentBook.bookTitle : '')
      || ((_bookPickerList || []).find((x) => x && x.base === base) || {}).bookTitle
      || ''
    _lastWereadContext = { base, bookTitle: String(known).trim() }
    applyBookContext({ bookId: base, bookTitle: known },
      'weread-branch:微读书页（页面还没应声，书 ID 取自 URL）', { authoritative: true })
  } catch (e) {
    postSidebarDebug({ stage: 'weread-branch-threw', error: String((e && e.message) || e) })
  }
}

/**
 * 记下"我们自己的阅读器此刻有没有书"（清空当前书之前的最后一道防线，**只挡猜出来的清空**）。
 *
 * 为什么必须是**黏性**的、不能只在 refreshCurrentBook 里更新（2026-11 自检实测的教训）：
 * 原先只有 refreshCurrentBook 的第 ① 条路会写这个变量，而那一条恰恰是**会被跳过的那条**——
 * 一旦跳过，变量还是旧值 false，防线就等于不存在，兜底照样把当前书清掉。
 * 现在改成两个来源：阅读器**自己推**上来的快照（最可靠）+ 第 ① 条路的回答。
 *
 * ⚠️ 2026-11 二次改版：这道防线**挡不住**来自"活动标签页身份"的清空 ——
 * 用户切到别的标签页时侧栏就该回到无书界面（见 applyBookContext 的 authoritative）。
 */
function rememberReaderBook(has) {
  _readerReportsBook = !!has
  _readerReportsBookAt = Date.now()
}

/**
 * 阅读器换书了（打开 / 切换 / 关掉一份 PDF）——**它自己报上来的**，直接切过去。
 *
 * 为什么不复用 refreshCurrentBook（2026-11 用户实测"打开 PDF 但侧栏没跟过去"）：
 * 那条路要反过来问后台"现在哪个 tab 是活动的、它是不是阅读器"，而"活动 tab"这件事
 * 并不总是答案 —— 侧栏在 DevTools 里、用户刚点过别的 tab、面板刚打开还没轮到它，
 * 都会问出一个"不是阅读器"的结果，于是上下文没跟过去，而且**时灵时不灵**。
 * 换书是阅读器自己知道的事实，它推过来的那一刻就是最可靠的信号，直接采用。
 */
function applyReaderBookFromSnapshot(snapshot) {
  if (_freeMode) return                       // 自由模式优先，别被阅读器拽走
  const b = snapshot && snapshot.book
  const base = b ? baseBookId(b.bookId) : ''
  // 阅读器**自己推**上来的这份快照是最可靠的事实来源，所以它同时更新那道防线
  //（见 rememberReaderBook 的注释：原先只有会被跳过的那条路才写它，等于没有）。
  rememberReaderBook(!!base)
  if (!base) {                                // 阅读器回到书库了 → 离开这本书
    if (_currentBook && String(_currentBook.base).startsWith('rd_')) {
      applyBookContext({ bookId: '' }, 'reader-push:阅读器回到书库了')
    }
    return
  }
  const next = { base, bookTitle: String(b.name || '').trim() }
  if (_manualBook) {
    // 用户手动翻着另一本书时，不硬拽：只把实时上下文记下来（与微信读书那条路的规矩一致）
    if (_manualBook.base !== base) { _currentBook = next; return }
    leaveManualBookIfRealRead(next)
  }
  applyBookContext({ bookId: b.bookId, bookTitle: b.name }, 'reader-push:阅读器推上来的这本书')
  // 兜底：侧栏刚打开时可能还没跑完历史回放（那之前消息区是空的），而 applyBookFilter
  // 只对**已在 DOM 里**的气泡生效。loadHistory 幂等（_histKeys 去重），重跑只补增量。
  loadHistory().catch(() => {})
}

/**
 * 活动标签页的 id（判不出来 = null）。
 *
 * ⚠️ 它只用来**过滤推送**，所以失败时必须往"放行"那一侧倒：判不出来时调用方一律照旧
 * 处理（见 applyWereadBroadcast）。取的是"最后聚焦的那个窗口"的活动标签页 ——
 * 与本文件其它几处（网页绑定入口、绑定对话框）的取法一致。
 */
async function activeTabId() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return t && typeof t.id === 'number' ? t.id : null
  } catch (e) {
    return null
  }
}

/**
 * 微读页面广播上来的"我现在读的是这本" —— **只有活动标签页的才算数**（2026-11 二次改版）。
 *
 * 为什么必须过滤（与阅读器那条推送同一个理由，见 readerUpdate 的处理）：
 *   · content.js 在**每个微读页面加载时**都会广播一次（书架页也会，那时 bookId 是空串）；
 *   · 中键点开一本书、浏览器恢复上次的会话、用户在后台刷新页面……都会触发广播；
 *   · 采纳它们等于让"用户没在看的标签页"改掉侧栏的当前书 —— 用户实测报的正是这类现象：
 *     "当前在毫不相关的标签页，侧栏还挂着另一个标签页那本书的会话"。
 *
 * ⚠️ 只认**顶层 frame**（`frameId === 0`）：content.js 跑在微读的每个 frame 里，而
 * getReadingContext 读的是 `window.top` 的路径 —— 子 frame 读到的是它自己的路径，
 * 于是会广播一个空 bookId（跨域 frame 必然如此），而空 bookId 会**把当前书清掉**。
 * 那种广播是纯噪声，一条都不该采纳。
 *
 * ⚠️ 判不出来时**放行**（tabs.query 失败 / sender 没带 tab）：宁可放过一份可疑的广播，
 * 也不要把"我问不出来"变成"侧栏不跟了"。
 */
async function applyWereadBroadcast(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined
  const frameId = sender ? sender.frameId : undefined
  if (typeof frameId === 'number' && frameId !== 0) {
    postSidebarDebug({
      stage: 'weread-broadcast-ignored', why: '不是顶层 frame 的广播',
      frameId, bookId: String(msg.bookId || '').slice(0, 20),
    })
    return
  }
  if (typeof tabId === 'number') {
    const active = await activeTabId()
    if (active !== null && active !== tabId) {
      postSidebarDebug({
        stage: 'weread-broadcast-ignored', why: '广播来自非活动标签页',
        from: tabId, active, bookId: String(msg.bookId || '').slice(0, 20),
      })
      return
    }
  }
  applyBookContext(msg, 'weread-broadcast:微读页面广播的当前书')
}

// ── 无书默认界面 / 已读书籍（2026-10；2026-11 改版）────────────────────────
// 读书模式未检测到阅读书籍时，消息区显示默认界面（不再残留上一本书的内容）。
// 手动选书（_manualBook）解决的是同一件事：已读完的书在微信读书里不会再打开，
// 需要一个入口翻它的旧账。手动选书期间消息、引用、命中、发送归属全部按选中的书
// 工作（effectiveBook 统一判定）；一旦检测到真实阅读就自动退出。
//
// 2026-11 改版（用户要求）：**已读书籍直接列在界面上**，不必再点「从已读书籍中
// 选择」进弹窗。同一份书单（_bookPickerList）仍被弹窗复用——书读着的时候（无书
// 界面不可见）也要能从「⋯ 菜单 / 手动选书横幅」翻别本书的记录。
let _bookPickerList = []   // GET /books 的结果（无书界面书单 + 弹窗共用一份）
let _booksLoaded = false   // 成功拉到过（有缓存就不再重复打请求）
let _booksFailed = false   // 上次拉取失败（本机服务没起来）→ 界面显示「重试」
let _booksLoading = false  // 正在拉取（首屏没缓存时显示「加载中…」）
let _nbShown = false       // 无书界面上一轮是否可见：只在「隐藏 → 显示」那一刻拉一次
let _nbRenderKey = null    // 上次渲染的书单指纹：没变就不重建 DOM（见 renderNoBookList）
const NB_SEARCH_MIN = 6    // 书多于这个数才显示搜索框（书少时它只是白占一行）

// ── 无书默认界面 ──────────────────────────────────────────────────────────────
// 显示/隐藏 + 同步禁用聊天输入（无书时发消息没有归属书，历史回放无从展示，
// 直接禁用输入让行为规范）
/**
 * 底部那一格二选一：`#footer`（输入区）还是 `#nb-reader-bar`（PDF 入口）（2026-11）。
 *
 * 为什么不是"两个都留着"：那一格只有 36px 高，无书时的输入框还是**禁用**状态、
 * 只写着一句"未检测到书籍：请打开微信读书中的书"——它占着唯一的位置，
 * 却回答不了"我手上就是一份 PDF"这个问题，所以让它让位。
 *
 * ⚠️ 但**本机服务没起来时不让位**（`_booksFailed`）：那时书单区显示的是
 * "读不到已读书籍 + 重试"，PDF 入口这时候点下去只会拿到"打不开"——
 * 该看见的是故障本身，不是一枚点了会报错的按钮。
 * 判据是两件事同时成立才换：`noBook && !_booksFailed`。
 *
 * ⚠️ 调用点有两处，别只留一处：本函数由 renderNoBookView 调（它每次切上下文都跑），
 * 而 `_booksFailed` 是**拉书单之后**才知道的——`refreshNoBookBooks` 拿到结果还要再调一次，
 * 否则本机服务挂掉时底部会一直停着那枚没用的 PDF 按钮。
 */
function renderBottomSlot(noBook) {
  const readerBar = document.getElementById('nb-reader-bar')
  const footer = document.getElementById('footer')
  const showReaderBar = !!noBook && !_booksFailed
  if (readerBar) readerBar.hidden = !showReaderBar
  if (footer) footer.hidden = showReaderBar
}

function renderNoBookView() {
  const view = document.getElementById('no-book-view')
  const msgs = document.getElementById('msgs')
  const noBook = !_freeMode && !effectiveBookBase()
  if (view) view.hidden = !noBook
  if (msgs) msgs.style.display = noBook ? 'none' : ''
  // 开场卡归消息区：无书（读书模式下没检测到书）时整格由「无书默认界面」接管，
  // 卡也跟着收起——否则它会在书单下面留着半张，看着像"上一本书的残影"。
  // 只置 hidden、不清内容：切回有书时 syncIntro 会按新上下文整张重画。
  if (noBook) {
    const card = document.getElementById('intro')
    if (card) card.hidden = true
  }
  // 无书时把所有消息置为隐藏并刷新提问浮窗：applyBookFilter(book='') 全隐藏，
  // 提问浮窗（jump-fab）随之收起，不残留上一本书的跳转条
  if (noBook) applyBookFilter()
  const input = document.getElementById('input')
  const sendBtn = document.getElementById('send-btn')
  const attachBtn = document.getElementById('attach-btn')
  if (input) {
    input.disabled = noBook
    /**
     * 无书时输入框整条会被 PDF 入口条取代（见下面 renderBottomSlot），
     * 所以这句占位文案**只有在本机服务没起来时**才真的看得见（那时输入框留着）。
     * 还是照旧写上：万一将来又把输入框留下来了，它至少说的是实话。
     */
    input.placeholder = noBook
      ? '未检测到书籍：请打开微信读书中的书'   // 输入框只有 ~18 个字宽，再长会被截断
      : '输入你的问题…'
  }
  if (sendBtn) sendBtn.disabled = noBook
  if (attachBtn) attachBtn.disabled = noBook
  /**
   * 底部那一格（输入框 / PDF 入口）**每次都要重算**，不能只在 noBook 变的时候算。
   *
   * 踩到过：原先写成 `if (noBook && !_nbShown) renderBottomSlot(...)`，于是本机服务挂着的时候
   * ——启动时先画一次（那时 `_booksFailed` 还是假）→ 拉书单失败置真 → 重画时 `_nbShown`
   * 已经是真、整段被跳过 → 底部永远停着那枚点了只会报错的 PDF 按钮。
   * 这个函数很便宜（两次 getElementById + 两个 hidden 赋值），值得每次算。
   */
  renderBottomSlot(noBook)
  // 内联书单：进无书界面那一刻刷新一次（本函数被 applyBookContext 频繁调用——
  // 切 tab / 切上下文都会走——所以只在「隐藏 → 显示」时打请求，其余时候用缓存渲染）
  if (noBook && !_nbShown) refreshNoBookBooks()
  _nbShown = noBook
  renderNoBookList()
  /**
   * 开场卡就在这一格：**上下文定下来的那一刻**重画一次。
   *
   * 为什么放这里（2026-11 实测踩到）：这个函数是所有"上下文换了"的必经之路
   * （切书 / 手动选书 / 检测到在读 / 进出自由模式 / 启动定上下文），而开场卡要讲的是
   * "你现在在哪个场合、从哪句话起头"——没有比这里更合适的会合点。原先只把它挂在
   * loadHistory 收尾和启动链末尾，于是**启动早期那两次调用 base 还是空的**（书还没认出来），
   * 等 pickBook / refreshCurrentBook 真的把书认下来时，已经没有任何一处再叫它画了：
   * 用户看到的就是"还是啥也没有"。
   *
   * 放在 renderNoBookList 之后：无书时本函数先把卡置 hidden，这里再算一次，
   * 无书状态下 renderIntro 会走 base 为空那一支，不会把卡又画回来。
   */
  syncIntro()
  refreshWebBindEntry()  // AI-021：无书状态时按活动 tab 显示/隐藏网页绑定入口
}

// 拉取已读书籍列表（GET /books → { books: [{ base, bookTitle, wereadBookId, updatedAt }] }）。
// force=false 且已成功拉过 → 直接用缓存，不打请求。
// 失败时**保留上一次的书单**：本机服务短暂没应声，不该把界面上已有的书清空。
async function loadBooks(force) {
  if (!force && _booksLoaded) return true
  _booksLoading = true
  try {
    const r = await fetch(`${RECEIVER}/books`)
    const d = await r.json()
    _bookPickerList = Array.isArray(d && d.books) ? d.books : []
    _booksLoaded = true
    _booksFailed = false
  } catch {
    _booksFailed = true   // _booksLoaded 保持 false → 下次调用自动重试
  }
  _booksLoading = false
  return !_booksFailed
}

// 无书界面书单的刷新：先按缓存渲染（避免闪一下空白），拉完再渲染一次
async function refreshNoBookBooks() {
  if (_booksLoading) return
  const p = loadBooks(true)   // 内部同步置 _booksLoading，下面这次渲染就能显示「加载中…」
  renderNoBookList()
  await p
  renderNoBookList()
  // 拉完才知道本机服务通不通 → 底部那一格跟着重算一次（见 renderBottomSlot）
  renderBottomSlot(!_freeMode && !effectiveBookBase())
}

// 书单里的时间：越近说得越口语（今天 / 昨天 / 3 天前），远了才报日期。一排
// "2026/10/8" 既占地方又不好扫；这样一眼能看出"哪几本是最近在读的"。
function fmtBookDate(ts) {
  const t = Number(ts) || 0
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
}

// 书脊色块：一长串书名看着是一堵墙，给每本配一枚"首字色块"就有颜色和辨识度了。
// 颜色按**书 ID**取（改名不会变色），固定六色，只做区分、不承载任何含义。
const SPINE_COLORS = ['#4f8f74', '#5f7ea6', '#9a7550', '#836791', '#6f8055', '#9c6363']
function spineOf(b) {
  const key = String((b && b.base) || (b && b.bookTitle) || '')
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  const title = String((b && b.bookTitle) || '').trim()
  return {
    color: SPINE_COLORS[Math.abs(h) % SPINE_COLORS.length],
    // 中文取首字；西文取头两个字母（一个字母认不出来是哪本）
    text: /^[A-Za-z]/.test(title) ? title.slice(0, 2) : (title.slice(0, 1) || '书'),
  }
}

/**
 * 这本是不是**我们自己阅读器里的书**（书 ID 形如 `rd_<内容哈希>`，见 reader.js 的 readerBookId）。
 * 用于决定"点这一行"该干什么：阅读器里的书应该去读，微信读书的书只能看记录。
 */
function isReaderBook(b) {
  return /^rd_[a-f0-9]{16,64}$/i.test(String((b && b.base) || ''))
}

/**
 * 在阅读器里打开这本书（2026-11）。
 *
 * 为什么要有它：用户实测"我点击第一次共读对话的时候阅读器并没有自己弹出来"。
 * 原因不是坏了，是**从来没有这条动作**——书单里"点一本"一直只做"手动选书 →
 * 看它的讨论记录"，而 `rd_` 那几本（我们阅读器放进去的书）在侧栏里连一个"去读"的
 * 入口都没有。所以这里补一条：交给后台开/切阅读器标签页，并带上 `?open=<hash>`。
 */
async function openInReader(b) {
  const name = b.bookTitle || b.name || ''
  try {
    const r = await chrome.runtime.sendMessage({ action: 'openReaderBook', base: b.base, name })
    if (r && r.ok) {
      showToast(r.reused ? '已切到阅读器打开这本书' : '已打开阅读器')
      return true
    }
    showToast((r && r.error && r.error.message) || '打不开阅读器页面')
  } catch (e) {
    showToast('打不开阅读器页面：' + String((e && e.message) || e))
  }
  return false
}

// 一条已读书籍（无书界面书单与弹窗共用同一套结构）：
// 整行点击 = 手动查看它的历史记录（pickBook），右侧垃圾桶 = 删掉它的全部存档。
// 版式是**单行**：色块 + 书名（占满）+ 最近更新的时间 —— 两行式在窄侧栏里一行只能
// 装一本书，扫起来太慢。类名沿用弹窗那套 .bp-item / .bi-*（样式在 sidebar.html）。
function buildBookItem(b) {
  const item = document.createElement('div')
  item.className = 'bp-item'
  const spine = spineOf(b)
  const time = fmtBookDate(b.updatedAt)
  const exact = b.updatedAt ? new Date(b.updatedAt).toLocaleDateString() : ''
  const readerBook = isReaderBook(b)
  item.innerHTML =
    `<span class="book-spine" style="background:${spine.color}">${esc(spine.text)}</span>` +
    `<div class="bi-main">` +
      `<div class="bi-title">${esc(b.bookTitle || '（书名未知）')}</div>` +
    `</div>` +
    (time ? `<span class="bi-meta" title="最近更新 ${exact}">${time}</span>` : '') +
    // 阅读器里的书多一枚「去读」：它是点得动的（有原件、能打开），
    // 与微信读书那类"只能看记录"的书在这里分开
    (readerBook ? `<button class="bi-open" title="用 CoRead 阅读器打开">读</button>` : '') +
    // 垃圾桶删的是**记录**，不是那个 PDF 文件——这一点对所有书都成立，所以说明统一。
    // 阅读器里的书要删原件得去阅读器「书库」（见 deleteBook 的注释：两个界面各代表一样东西）
    `<button class="bi-del" title="删除这本书的讨论记录（PDF 原件留在阅读器书库里）">${ICON_TRASH}</button>`
  // 阅读器里的书：整行点击 = 去读（那才是用户点它时想干的事）；
  // 微信读书的书：整行点击仍然是看讨论记录（那些书在微读里打开，这里没有原文可读）
  item.addEventListener('click', () => { readerBook ? openInReader(b) : pickBook(b) })
  const openBtn = item.querySelector('.bi-open')
  if (openBtn) openBtn.addEventListener('click', (e) => { e.stopPropagation(); openInReader(b) })
  item.querySelector('.bi-del').addEventListener('click', (e) => {
    e.stopPropagation()  // 不触发行点击的选书
    deleteBook(b)
  })
  return item
}

// 无书界面的已读书籍书单（内联渲染，不用点按钮）：加载中 / 服务未启动 / 空 /
// 无匹配 / 正常书单，五种面貌都在这里定。
function renderNoBookList() {
  const listEl = document.getElementById('nb-list')
  if (!listEl) return
  const msgEl = document.getElementById('nb-empty')
  const searchEl = document.getElementById('nb-search')
  const countEl = document.getElementById('nb-books-count')
  const total = _bookPickerList.length
  // 书少时不显示搜索框（一行白白占掉一本书的位置）
  const showSearch = total > NB_SEARCH_MIN
  if (searchEl) searchEl.hidden = !showSearch
  if (countEl) { countEl.textContent = total ? String(total) : ''; countEl.hidden = !total }
  // 搜索框藏起来时它里面的旧关键词不参与过滤——否则重新进界面会被静默滤空
  const q = (showSearch && searchEl ? searchEl.value : '').trim().toLowerCase()
  const list = q
    ? _bookPickerList.filter(b => String(b.bookTitle || '').toLowerCase().includes(q))
    : _bookPickerList

  // 指纹没变就直接返回：本函数会被 renderNoBookView 频繁带着跑（切 tab 就会走一遍
  // applyBookContext），重建 DOM 会把用户滚到一半的书单弹回顶部
  const key = [total, q, _booksLoading ? 'L' : '', _booksFailed ? 'F' : '',
    list.map(b => b.base + '\u0001' + (b.bookTitle || '') + '\u0001' + (b.updatedAt || 0)).join('\u0002')].join('|')
  if (key === _nbRenderKey) return
  _nbRenderKey = key

  // 状态消息统一版式：一枚图标 + 一句话 + 可选的一行小字（都比纯文字居中好看，
  // 也和上面那张状态卡用的是同一枚图标）
  const showMsg = (title, sub, opts) => {
    listEl.hidden = true
    if (!msgEl) return
    msgEl.className = 'nb-msg' + (opts && opts.err ? ' err' : '')
    msgEl.innerHTML =
      `<span class="nb-badge lg"><svg><use href="#nb-book-glyph"></use></svg></span>` +
      `<div class="nb-msg-title">${title}</div>` +
      (sub ? `<div class="nb-msg-sub">${sub}</div>` : '') +
      (opts && opts.retry ? '<button class="nb-retry">重试</button>' : '')
    msgEl.hidden = false
    if (opts && opts.retry) {
      msgEl.querySelector('.nb-retry')?.addEventListener('click', () => refreshNoBookBooks())
    }
  }

  if (!total && _booksLoading) return showMsg('正在读取已读书籍…')
  if (!total && _booksFailed) {
    return showMsg('读不到已读书籍', 'CoRead 本机服务没在运行<br>启动后点下面的「重试」',
      { err: true, retry: true })
  }
  if (!list.length) {
    return showMsg(q ? '没有匹配的书名' : '还没有已读书籍',
      q ? '换个词试试' : '在微信读书里划过线、提过问的书，会出现在这里')
  }
  listEl.hidden = false
  if (msgEl) msgEl.hidden = true
  listEl.innerHTML = ''   // 元素随节点一起丢弃，事件监听不会残留
  for (const b of list) listEl.appendChild(buildBookItem(b))
}

// ── AI-021 网页阅读源：无书视图的『绑定当前网页页面』入口 ────────────────
// 仅当：处于无书状态（本函数由 renderNoBookView 调用）+ 活动 tab 是文库网页
// + 该页尚未绑定（向页面适配器查询）。绑定由页面上的对话框完成，绑定后
// storage 变更（miaBindings）触发本函数刷新，入口消失，页面右下角胶囊常驻。
const WEB_PAGE_RE = /^https:\/\/(www\.marxists\.org\/chinese|www\.bilibili\.com)\//

/**
 * 这个 URL 是不是网页阅读源页面（marxists / B 站）。
 *
 * 与 `WEB_PAGE_RE` 分工不同：那条只回答"侧栏要不要给绑定入口"，必须严格对齐
 * manifest 的注入范围；这条回答"一条引用是不是从网页上划出来的"——网页可以绑定到
 * 微信读书的书或阅读器里的书（2026-11 放开），所以跳转时不能只看 bookId 前缀。
 */
function isPageSourceUrl(url) {
  return /^https?:\/\/(?:[A-Za-z0-9-]+\.)*(?:marxists\.org|bilibili\.com)\//i.test(String(url || ''))
}
async function refreshWebBindEntry() {
  const card = document.getElementById('nb-web-card')
  const urlEl = document.getElementById('nb-web-url')
  if (!card) return
  card.hidden = true
  if (_freeMode || effectiveBookBase()) return
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = tabs && tabs[0]
  } catch (e) { return }
  if (!tab || !tab.id || !WEB_PAGE_RE.test(String(tab.url || ''))) return
  let ans = null
  try { ans = await chrome.tabs.sendMessage(tab.id, { action: 'coreadBindingQuery' }, { frameId: 0 }).catch(() => null) } catch (e) {}
  if (!(ans && ans.ok)) {
    try {
      const resps = await chrome.tabs.sendMessage(tab.id, { action: 'coreadBindingQuery' })
      const arr = Array.isArray(resps) ? resps : []
      ans = arr.find(function (x) { return x && x.ok }) || null
    } catch (e) {}
  }
  if (!ans || ans.bound) return
  // 路径独占一行 chip：取末尾两段并做中间省略，长路径也不会撑破布局
  const full = String(ans.pageUrl || tab.url || '')
  const path = full.replace(/^https?:\/\/[^/]+/, '')
  const segs = path.split('/').filter(Boolean)
  let show = '…/' + (segs.length > 2 ? segs.slice(-2).join('/') : segs.join('/') || path.replace(/^\//, ''))
  if (show.length > 46) show = show.slice(0, 20) + '…' + show.slice(-20)
  if (urlEl) { urlEl.textContent = show; urlEl.title = full }
  card.hidden = false
}

// 手动选书横幅：手动查看期间显示在消息区上方，提供「切换书籍 / 退出手动」入口
function renderManualBanner() {
  const banner = document.getElementById('manual-banner')
  const exitItem = document.getElementById('mm-exit-manual')
  const show = !!_manualBook && !_freeMode
  if (banner) banner.hidden = !show
  if (exitItem) exitItem.hidden = !show
  if (show && _manualBook) {
    const nameEl = document.getElementById('manual-book-name')
    if (nameEl) nameEl.textContent = _manualBook.bookTitle || ''
  }
}

// 打开已读书籍选择弹窗（入口：⋯ 菜单 / 手动选书横幅的「切换书籍」；无书界面不再
// 用它——那边直接把书单列出来了）。每次打开强制拉一次：书读着的时候进来的，图的就是「最新」。
async function openBookPicker() {
  const overlay = document.getElementById('book-picker')
  if (!overlay) return
  overlay.classList.add('on')
  const listEl = document.getElementById('bp-list')
  const emptyEl = document.getElementById('bp-empty')
  if (listEl) listEl.innerHTML = '<div class="bp-msg">加载中…</div>'
  if (emptyEl) emptyEl.hidden = true
  await loadBooks(true)
  const search = document.getElementById('bp-search')
  if (search) search.value = ''   // 每次打开都从全量书单开始（旧关键词不该接着过滤）
  renderBookList()
  if (search) setTimeout(() => search.focus(), 100)
}

// 弹窗里的书单（与无书界面书单共用 _bookPickerList / buildBookItem，只是有自己的搜索词）
function renderBookList() {
  const listEl = document.getElementById('bp-list')
  const emptyEl = document.getElementById('bp-empty')
  if (!listEl) return
  if (_booksFailed && !_bookPickerList.length) {
    listEl.innerHTML = '<div class="bp-msg bp-err">CoRead 本机服务未启动，无法读取已读书籍</div>'
    return
  }
  const searchEl = document.getElementById('bp-search')
  const q = (searchEl ? searchEl.value : '').trim().toLowerCase()
  const list = _bookPickerList.filter(b => !q || (b.bookTitle || '').toLowerCase().includes(q))
  listEl.innerHTML = ''
  if (!list.length) {
    if (emptyEl) {
      emptyEl.hidden = false
      emptyEl.textContent = q ? '无匹配的书籍' : '暂无已读书籍记录'
    }
    return
  }
  if (emptyEl) emptyEl.hidden = true
  for (const b of list) listEl.appendChild(buildBookItem(b))
}

// 删除一本书的记录。**只清共读侧**：划线、章节缓存、聊天、「已读书籍」记录。
//
// ⚠️ 模型的边界（2026-11 用户定调，别再来回改）：
//   侧栏这一栏里的每一项 = **这本书的讨论记录**，不是那个 PDF 文件；
//   阅读器「书库」里的每一项 = **那个 PDF 原件**。
//   两个界面各自只删自己那一样，**不做"二选一"弹窗**——那等于把两件东西塞进一次选择里，
//   用户得先想清楚"我现在站的这个列表代表什么"，而这件事本来就该由界面替他定好。
//   所以这里永远只打 /book-delete；原件在阅读器书库里删（见 reader.js 的 deleteReaderBook）。
//   历史（别再走回去）：这里曾经会让阅读器的书二选一（记录 / 连原件一起删），
//   用户当场否掉——"书库里的项应该只是指的原件，而会话里的项才对应这些记录"。
async function deleteBook(b) {
  if (!b || !b.base) return
  const title = b.bookTitle || '这本书'
  const readerBook = isReaderBook(b)
  const ok = await showConfirm(`删除《${title}》的讨论记录？`,
    '将删除这本书的划线、章节缓存与聊天记录（含「已读书籍」列表），此操作不可恢复。'
    + (readerBook ? '\nPDF 原件不在这里删：它留在阅读器「书库」里，要删那份文件请去那里。' : ''))
  if (!ok) return
  try {
    const resp = await fetch(`${RECEIVER}/book-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: b.base }),
    })
    if (!resp.ok) throw new Error('bad status')
  } catch {
    showToast('删除失败：CoRead 本机服务无响应', true)
    return
  }
  // 删除的是当前有效上下文（正在阅读/手动查看的书）→ 重置为无书状态，
  // 避免残留上下文继续绑定已删除的书（消息区/引用/命中都按书隔离）
  if (effectiveBookBase() === b.base) {
    if (_manualBook && _manualBook.base === b.base) _manualBook = null
    if (_currentBook && _currentBook.base === b.base) _currentBook = null
    saveState()
  }
  // 本地引用列表清理（removeAnns 统一处理"移除的是当前选中引用 → 清空选中态"）
  removeAnns(a => baseBookId(a.bookId) === b.base)
  // 移除消息区残留的该书气泡：loadHistory 回放出的 DOM 还在，书已删不可再展示。
  // 用 all:true 拿全量——**要删的正是当前不可见的那批**（书已删、已不是当前上下文），
  // 走默认过滤会一条都拿不到。
  for (const el of nodesInContext({ all: true })) {
    if ((el.dataset.book || '') === b.base) el.remove()
  }
  saveState()
  onEffectiveContextChange()
  renderCurrentBook()
  renderNoBookView()
  renderManualBanner()
  // 刷新已读书籍列表（弹窗 + 无书界面的内联书单是同一份数据）
  _bookPickerList = _bookPickerList.filter(x => x.base !== b.base)
  renderBookList()
  renderNoBookList()
  // AI-021：广播删除事件，网页适配器（source-mia.js）据此清理本地页面→书绑定，
  // 避免残留绑定下次访问页面时把已删的书重新建出来
  try { chrome.runtime.sendMessage({ action: 'coreadBookDeleted', base: b.base }) } catch {}
  showToast(`已删除《${title}》`)
}

function closeBookPicker() {
  document.getElementById('book-picker')?.classList.remove('on')
}

// 手动选一本书：进入「手动查看该书历史记录」状态。_manualBook 优先于实时检测
//（effectiveBook），实时上下文照常记录在 _currentBook；检测到真实阅读后自动退出。
function pickBook(book) {
  if (!book || !book.base) return
  closeBookPicker()
  const same = _manualBook && _manualBook.base === book.base
  _manualBook = { base: book.base, bookTitle: String(book.bookTitle || '').trim() }
  saveState()
  if (!same) {
    // 手动选书是一次明确的上下文切换：引用/消息/命中/滚动全部按新书重算。
    // 不写 _currentBook（它只记录实时检测），后续实时上下文照常覆盖
    onEffectiveContextChange()
    showToast(`已切换到《${_manualBook.bookTitle || '…'}》的历史记录`)
  }
  renderCurrentBook()
  renderNoBookView()
  renderManualBanner()
  // 手动选书切换同样在消息区恢复可见后再滚到底部（无书状态进入时 #msgs 是隐藏的）
  if (!same) scrollMsgsToBottom()
}

// 停止手动选书：恢复自动跟随（实时检测到哪本书就显示哪本）
function exitManualBook() {
  if (!_manualBook) return
  const was = _manualBook
  _manualBook = null
  saveState()
  onEffectiveContextChange()
  renderCurrentBook()
  renderNoBookView()
  renderManualBanner()
  scrollMsgsToBottom()
  // 退出后立即向活动 tab 查询真实阅读上下文（可能正在读书）
  refreshCurrentBook()
  showToast(`已退出《${was.bookTitle || '…'}》的手动查看`)
}
// ── 轻提示 toast ──────────────────────────────────────────────────────────
function showToast(text, isErr) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = text
  el.classList.toggle('err', !!isErr)
  el.classList.add('on')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('on'), 2600)
}

// ── 遮罩点击关闭（弹窗/抽屉通用）───────────────────────────────────────────
// 必须「按在遮罩上、也在遮罩上松开」才算点遮罩。只看 click 的 e.target 是不够的：
// 在面板内按下、拖到遮罩上松开时，click 的目标是 press/release 两者的**最近公共祖先**
// ——正是遮罩本身，于是弹窗被误关（在输入框里选中文字往外拖、按下后手滑出面板都会踩到）。
// 因此记下 mousedown 目标并校验 mouseup 目标，两者都落在遮罩上才关闭。
// 松开点落在遮罩外（含拖出浏览器窗口）一律不关。
function bindMaskClose(overlay, close) {
  if (!overlay) return
  let downOnMask = false
  overlay.addEventListener('mousedown', (e) => { downOnMask = e.target === overlay })
  overlay.addEventListener('mouseup', (e) => {
    const onMask = downOnMask && e.target === overlay
    downOnMask = false
    if (onMask) close()
  })
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────

// 打开引用列表（卡片上的切换引用按钮）
document.getElementById('rc-switch-btn').addEventListener('click', () => {
  openDrawer()
  postSidebarDebug({ stage: 'drawer-open' })
})

// 卡片折叠/展开
document.getElementById('rc-collapse-btn').addEventListener('click', () => {
  const card = document.getElementById('ref-current')
  const btn = document.getElementById('rc-collapse-btn')
  card.classList.toggle('collapsed')
  btn.textContent = card.classList.contains('collapsed') ? '▸' : '▾'
})

// AI-018：点击折叠态概览直接展开卡片（看完整引用不用先点表头折叠按钮）
document.getElementById('rc-preview')?.addEventListener('click', () => {
  const card = document.getElementById('ref-current')
  card.classList.remove('collapsed')
  document.getElementById('rc-collapse-btn').textContent = '▾'
})

// 跳转到原文位置（微信读书原生章节 URL）
document.getElementById('rc-jump-btn').addEventListener('click', () => {
  if (selectedAnn) jumpToAnnotation(selectedAnn)
})

/**
 * 引用卡上「切换引用 ▸」被点到了。
 *
 * 除了记一笔，还要**采一串快照**（2026-11）：
 * 用户报"点切换引用之后底层界面回到选书界面"，而日志里**没有任何导航记录**——
 * 也就是说"跳"不是扩展发起的，或者发生在别的地方。分不清就不能再修。
 * 从点开抽屉那一刻起，连续几秒记录**阅读器**（URL / 书 / 是否显示书库）与
 * **侧栏**（抽屉开着没 / 书单开着没 / 当前书）的状态，最后一次性上报。
 * 这样"哪一层、在第几秒跳的"直接可读。
 */
function snapshotAroundSwitch() {
  const shots = []
  const sideState = () => ({
    drawer: !!(document.getElementById('ref-drawer') || {}).classList?.contains?.('on'),
    picker: !!(document.getElementById('book-picker') || {}).classList?.contains?.('on'),
    book: effectiveBookBase().slice(0, 14) || '(空)',
    ref: String(((document.getElementById('rc-text') || {}).textContent) || '').slice(0, 16),
  })
  const tick = async (tag) => {
    let reader = null
    try {
      // 与 refreshCurrentBook 用同一条**只给后台**的查询（带 req）：快照要反映的是
      // "后台认为该认哪本"，不是"阅读器页面自己开着哪本"。
      const req = 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const r = await chrome.runtime.sendMessage({ action: 'readerContextQuery', req })
      reader = r && r.req === req && r.ok
        ? (r.book ? { book: String(r.book.bookTitle || '').slice(0, 12) } : { book: '(无书→书库)' })
        : { error: 'r.failed' }
      // `activeKind` 取代了原来的 `via`（2026-11 二次改版）：现在后台只报"活动标签页是
      // 哪一类页面"，不再有"后台挂着的阅读器"那一路。快照里带着它，一眼可读
      // "那一刻侧栏认的是哪本书、凭的是什么"。
      if (r && r.req === req && r.ok) reader.activeKind = String(r.activeKind || '')
    } catch (e) { reader = { error: '消息失败' } }
    shots.push(Object.assign({ tag, t: Date.now() % 100000 }, sideState(), { reader: JSON.stringify(reader) }))
  }
  ;(async () => {
    await tick('0s')
    for (const [ms, tag] of [[400, '0.4s'], [1200, '1.2s'], [3000, '3s'], [6000, '6s']]) {
      await new Promise((r) => setTimeout(r, ms === 400 ? 400 : 800))
      await tick(tag)
    }
    postSidebarDebug({ stage: 'switch-snapshots', shots })
  })().catch(() => {})
}

document.getElementById('rc-switch-btn')?.addEventListener('click', () => {
  postSidebarDebug({ stage: 'btn-switch-ref', hasRef: !!selectedAnn, text: String((selectedAnn && selectedAnn.selectedText) || '').slice(0, 20) })
  snapshotAroundSwitch()
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
bindMaskClose(document.getElementById('ref-drawer'), closeDrawer)

// 搜索引用（输入框同样是"输入框引号镜像"的受害面：净化后再取词，与检索口径一致）
document.getElementById('drawer-search').addEventListener('input', (e) => {
  cleanInputBidi(e.target)
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
// 「正在…」文案按 agent 处理步骤更新（2026-10）：agent 经 receiver 推 SSE
// type=agent-state（step: resolve=引用解析 / answer=生成回复），气泡文案跟着换；
// 状态迟迟未到（agent 正在处理上一条/排队）则按等待时长走兜底文案。
const THINKING_COPY = {
  init: '正在理解你的提问',
  resolve: '正在检索此前讨论过的知识点',
  answer: '正在组织回答',
  fallback1: '正在结合上下文思考',
  fallback2: '内容较多，仍在思考',
}
const _thinkingFallbacks = []  // 兜底文案定时器（hideThinking / 步骤到达时清除）
let _thinkingStepArrived = false  // 是否已收到 agent 步骤（收到后兜底不再覆盖）

function setThinkingLabel(text) {
  if (!thinkingEl) return
  const label = thinkingEl.querySelector('.bubble > span:first-child')
  if (label) label.textContent = text
}
function clearThinkingFallbacks() {
  for (const t of _thinkingFallbacks) clearTimeout(t)
  _thinkingFallbacks.length = 0
}
function scheduleThinkingFallback(delay, text) {
  const t = setTimeout(() => {
    if (thinkingEl && !_thinkingStepArrived) setThinkingLabel(text)
  }, delay)
  _thinkingFallbacks.push(t)
}

function showThinking(bookId) {
  hideThinking()
  _recoverAnswerSeen = false  // 新一轮提问：允许在需要时重新弹思考气泡
  // AI-001：记录本次回复归属的书，后续 assistant 流式气泡继承此书签
  _thinkingBook = baseBookId(bookId) || ''
  const msgs = document.getElementById('msgs')
  thinkingEl = document.createElement('div')
  thinkingEl.className = 'msg-thinking'
  thinkingEl.dataset.book = _thinkingBook  // AI-001：跟随本次回复的书
  thinkingEl.innerHTML = `<div class="bubble"><span>${THINKING_COPY.init}</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`
  msgs.appendChild(thinkingEl)
  msgsRecord('thinking', thinkingEl)
  applyBookFilter()
  maybeAutoScroll(msgs)
  // 兜底文案：agent 状态未在预期时间内到达（排队/长思考）时逐步换文案
  _thinkingStepArrived = false
  scheduleThinkingFallback(5000, THINKING_COPY.fallback1)
  scheduleThinkingFallback(15000, THINKING_COPY.fallback2)
}

function hideThinking() {
  // 有回复开始渲染（流式分片 / 完整记录 / 历史补渲染）→ 本打开会话里不再由
  // 「未回复提问恢复」逻辑重新弹思考气泡（否则已出现的回复旁会再挂一个思考中）
  _recoverAnswerSeen = true
  clearThinkingFallbacks()
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null }
  // 2026-11 拆开：**撤思考气泡 ≠ 这一轮结束**。流式第一片到达时也会撤它，而那一刻回答才
  // 刚开始打字 —— 按钮必须继续是「停止」（用户定调：整条回答写完之前都能停）。
  // 所以这里只负责气泡，"按钮该是什么"交给 syncSendBtn() 按实际进度算；
  // "本轮结束"由各处显式调 finishWaiting()（答案落库 / 停止 / 失败 / 放弃等待）。
}

// 去重：跟踪已显示的 assistant 消息（前 200 字指纹）
const _seenFingerprints = new Set()

// 系统提示气泡（2026-09）：/收口 等系统反馈——区别于普通消息的小号灰字样式。
// 2026-11：可传 bookId 显式归属（自由模式的多对话提示要挂在当前那场对话下，
// 否则按默认归属回落到哨兵 key，切到别的对话时这条提示会串场）。
function renderSystemBubble(content, bookId) {
  const msgs = document.getElementById('msgs')
  if (!msgs) return
  const el = document.createElement('div')
  // 含换行的回执（/相处 的清单、/归档 的产物说明）多带一个 multi：CSS 据此改左对齐，
  // 单行短提示（/收口 等）仍居中。2026-10
  el.className = /\n/.test(String(content || '')) ? 'msg-system multi' : 'msg-system'
  const book = bookId || effectiveBookBase()
  if (book) el.dataset.book = baseBookId(book)
  el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  msgs.appendChild(el)
  msgsRecord('system', el)
  applyBookFilter()
  maybeAutoScroll(msgs)
}

// ── 会话开场（2026-11）────────────────────────────────────────────────────────
// 新建一场对话 / 刚要跟一本书开聊时，消息区是空的。"空"本身不难看，难的是用户
// 站在那里不知道下一步点哪儿：原先自由模式只落一条灰字提示（讲的是现象），读书
// 模式则**什么都没有**。
//
// 形态（2026-11 用户定调，第一版被否掉过，别再走回去）：
//   第一版是**一张卡**——白底描边 + 标题行「这场共读还没开始」+ 引文块 + 两颗占满
//   整宽的按钮 + 末行小字。用户的评价是"太重、太像说明书"：那一格的信息量是界面
//   别处的三倍，读起来像一张表单，不像对话的开场。
//   现在只剩两行，居中：
//     · 一句话回答"我在哪"（引文走**行内引子**：一道绿竖线 + 原文，不再套第二个框）
//     · 一行小胶囊回答"能做什么"（不占满整宽，所以读起来是"提议"不是"表单"）
//
// 三条设计规矩（后续改这里时别丢）：
//   ① 胶囊必须真的能点出结果。凡是写"点上方某某"的文案都不算设计——用户刚进来，
//      不该先去找控件；
//   ② 引文必须来自用户自己的划线（RECENT_ANNS），不写"例如…"这种占位口水话。
//      这条是这个产品的立身之本：它只聊你真正读到的地方；
//   ③ 产品规则（"它知道你读到哪"这类）只挂在悬停提示上，**不占屏幕**——第一版把它
//      做成末行小字，正是"说明书感"的来源之一。
//
// 归属：整块 data-book = 当前书 / 当前对话 key。
// applyBookFilter 按 data-book 过滤消息区的子元素，所以切书 / 切对话 / 进出自由模式
// 时这一块会跟着上下文一起走；loadHistory 末尾的 syncIntro 负责补内容。

// 判定的判定留痕：结果**变了**才上报一次（见 renderIntro 里的说明）。
// 为什么要细到 base / loaded / real：这几种原因在界面上长得一模一样——都是"什么都没有"
// ——没有这条留痕就只能靠猜，2026-11 已经因此白跑了一轮。
let _introTraceLast = ''
function introTracePost(rec) {
  const sig = `${rec.base}|${rec.real}|${rec.loaded}|${rec.free}`
  if (sig === _introTraceLast) return
  _introTraceLast = sig
  if (window.__coreadIntroTrace) window.__coreadIntroTrace.push(rec)   // DOM 层自测读它
  postSidebarDebug({
    stage: 'intro',
    base: String(rec.base || '').slice(0, 20),
    real: rec.real,          // 消息区是否已有真实内容（气泡/思考中/系统通报）
    loaded: rec.loaded,      // /history 是否已回放完（没跑完就不许画，避免闪一下）
    free: rec.free,          // 自由模式 / 读书模式
    before: rec.before,      // 本次判定前卡是不是藏着的
    len: rec.contentLen,
    msgs: msgsDigest(),      // 消息区里到底坐着谁 —— "real=true 却没有消息"那类问题全靠它
    log: Array.isArray(_msgsLog) ? _msgsLog.slice(-12) : [],   // 最近 12 笔追加（只记类名/归属/长度）
  })
}

/**
 * 这一格对**当前上下文**来说，还有没有真实内容？
 *
 * 判据就一句：nodesInContext() 里有没有东西（它已经按归属 + 可见性过滤过了）。
 * 这里不再自己遍历——2026-11 就是因为在这里裸写遍历、撞上别的书的隐藏气泡，
 * 开场卡整整两轮没露面。
 *
 * 注意：**思考中气泡不算内容**（正在等回答，会话本身还是空的）。它本来带的是当前
 * 书的标、会被 nodesInContext() 收进来，所以在这里单独剔除。
 */
function hasRealMsg() {
  for (const el of nodesInContext()) {
    if (el.classList && el.classList.contains('msg-thinking')) continue
    return true
  }
  return false
}

// 真实消息落库 → 开场卡让位。只对**当前上下文**的消息生效（见 msgInCurrentContext）：
// 别的书/别的对话来消息，不该把当前这场空对话的开场卡顺手摘了。
function dropIntroIfReal(el) {
  if (msgInCurrentContext(el)) dropIntro()
}

/**
 * 黑匣子（2026-11）：消息区里每一次追加都记一笔，只记**结构**不记内容
 *（id / class / data-book / 长度），滚动保留最近 30 笔。
 *
 * 为什么需要它：开场卡的判据是"消息区空不空"，而"消息区里到底有什么"这件事在
 * 用户机器上一直是黑的——实测出现过 `real=true` 但库里一条消息都没有的情况
 *（卡因此按设计不画，看起来就是"还是什么都没有"），光看日志分不出那个占位的是
 * 思考气泡、系统通报还是别的书留下的残影。DOM 层自测里有 `document` 替身可以随便查，
 * 真实侧栏里没有 DevTools 就只能靠这个。
 */
// ⚠️ 用 var 不用 const/let：introTracePost 可能在本文件后面那段声明执行之前就被调用
//（函数声明提升、顶层链又跑得早），换成 const 会撞上暂时性死区、把整个侧栏脚本打断。
var _msgsLog = []
function msgsRecord(what, el, extra) {
  try {
    _msgsLog.push({
      t: Date.now() % 100000,
      what,
      cls: (el && el.className) || '',
      id: (el && el.id) || '',
      // doc=归属哪本书/哪场对话：""=没打标的（历史/哨兵），"none"=元素上没有 dataset
      doc: el && el.dataset ? String(el.dataset.book || '') : 'none',
      len: el && el.innerHTML ? String(el.innerHTML).length : 0,
      ...(extra || {}),
    })
    if (_msgsLog.length > 30) _msgsLog.shift()
  } catch {}
}

// 消息区当前的"内容地图"（给上报用）：**只列可见的**，其余按归属归成一句统计。
// 为什么要这么写：消息区是所有书共用一个容器，里面有几百条别的书的隐藏气泡是常态
//（2026-11 实测：一次上报打出 400+ 个节点，日志直接没法看，真正有用的那句被淹了）。
function msgsDigest() {
  const vis = []
  let hidden = 0
  const byBook = {}
  // msgs-walk-ok: 诊断专用——它要的恰恰是**全部**节点（含隐藏的），才能报出
  // "隐藏了多少、分别是哪些会话"。走 nodesInContext({all:true}) 拿到原始列表。
  for (const el of nodesInContext({ all: true })) {
    const hiddenNow = el.style && el.style.display === 'none'
    if (hiddenNow) {
      hidden++
      const b = (el.dataset && el.dataset.book) || '(无归属)'
      byBook[b] = (byBook[b] || 0) + 1
      continue
    }
    if (vis.length < 12) vis.push(`${el.id || el.className || el.tagName}${el.dataset && el.dataset.book ? '@' + String(el.dataset.book).slice(0, 8) : ''}`)
  }
  const tail = hidden ? `  [+隐藏 ${hidden} 条：${Object.entries(byBook).map(([b, n]) => `${b.slice(0, 8)}×${n}`).join(' ')}]` : ''
  return (vis.join(',') || '(可见区为空)') + tail
}

// 摘掉开场。真实消息一到就调用（新会话开张那一刻，这几行就该消失）。
// 留着节点的壳、只清内容并置 hidden：下次切到一场空对话时 syncIntro 直接复用。
function dropIntro() {
  const el = document.getElementById('intro')
  if (!el) return
  el.hidden = true
  el.innerHTML = ''
  // 居中是给"空态"用的：有内容了必须撤掉，否则消息会从中间开始排
  const msgs = document.getElementById('msgs')
  if (msgs) msgs.classList.remove('intro-on')
}

// 开场文案。刻意只有两行（第一版是"标题 + 副文案 + 末行小字"三层，用户嫌像说明书）：
//   title = 一句话回答"我在哪"，ann = 可选的行内引子（你的划线）
//   acts  = 可选的一行小胶囊
// 产品规则那两句（原末行小字）没删，收进 PROD_RULES，渲染时挂到 title 的悬停提示上。
//
// ⚠️ **按钮资格**（2026-11 用户定调，别再往回加）：
//   这是"新建会话、还没有任何气泡"的状态。此处**凡是用户自己打字就能做到的事，都不该有按钮**——
//   「提个问题」只是把光标挪进输入框、输入框就在下面，属于多余；
//   「选一条已有的划线」更糟：这场对话**还没有引用**，让空会话去"选引用"是自相矛盾。
//   有资格留下的只有"光靠打字拿不到"的东西：
//     · 先说我的看法   → 替你选中那条划线 + 填好话头（划线是现成的，替你挂上）
//     · 接着「上一场」聊 → 切到指定那场对话（对话在别处，替你切过去）
//     · 从会意图里选个知识点 → 打开图并选为引用（图在别处，替你打开）
//   没有划线时这场共读本来就开不了张：**不出按钮**，把话说明白即可。
//   （有划线时也只留「先说我的看法」一颗：另一颗"提个问题"同样只是把光标挪进输入框。）
// ⚠️ **开场不出任何按钮**（2026-11 用户定调，这是最终版，别再往回加）：
//   走到这一版之前挂过五颗，全被否掉，理由归成一句：**空会话里不该有能点的东西**。
//     ·「提个问题」「说点什么」——只是把光标挪进输入框（输入框就在下面）
//     ·「选一条已有的划线」——这场对话还没有引用，让空会话去选引用是自相矛盾
//     ·「接着说某场对话」——用户是新建一场进来的，劝他聊别的等于说"你建的这个多余"
//     ·「先说我的看法」/「从会意图里选个知识点」——**用户原话：多余的**
//   产品在这一格要做的只有一件事：把状态说清楚 + 一句箴言填空。动作入口有两处已经够了——
//   输入框（想说什么直接打）和下方引用卡/书里的划线（起点）。
//   所以 introPlan 只返回 title（主句），不再有 acts。
const INTRO_TITLE = '和这本书聊起来'
const PROD_RULES = '它知道你读到哪，只聊你已经读到的地方；自由对话不会被自动写进会意图'

/**
 * 开场箴言（2026-11 用户定调）。
 *
 * 为什么要有它：空态真正的问题**不是排版，是内容**——中间什么都没有，怎么摆都显得空旷。
 * 曾经把内容推到底部、"用位置去救空旷"，那是治错了病。这里放一句有分量的话，
 * 让它站在中间当重心；"这本书还一句话没聊过"退到下面当一句状态说明。
 *
 * 选的是马克思《〈政治经济学批判〉序言》（1859）里那句：
 *   在科学的入口处，正像在地狱的入口处一样，必须提出这样的要求：
 *   **这里必须根绝一切犹豫；这里任何怯懦都无济于事。**
 * 上句本身是马克思转引但丁《神曲·地狱篇》第三歌的铭文——他把"入口处"从地狱挪到了
 * 科学上。只把下半句刻在开场是因为半句就够重，整句太长会压平重心。
 *
 * ⚠️ 出处别写错：《资本论》第一卷序言里**没有**这一句（那里是"在科学上没有平坦的大道"，
 * 出自《资本论》法文版序与跋）。这里是《政治经济学批判》序言。
 *
 * 换箴言只改这一处（文案 + 出处一起改）。
 */
const MOTTO = {
  text: '这里必须根绝一切犹豫',
  // 署名只留人名（2026-11 用户定调）：空态里写"《〈政治经济学批判〉序言》"这种一串
  // 书名号太重，也把一句用来填空的话抬成了学术引注。要查出处的人自己去查。
  from: '卡尔·马克思',
}

function introPlan(base) {
  if (_freeMode) {
    return {
      // 固定一句，**不写"第几场"**（2026-11 用户定调）：场次是个跟用户当下的意图
      // 无关的计数器——他刚新建了一场，关心的是"这场能干什么"，不是编号。
      title: '这是一场自由对话',
      rules: '每场对话各自独立，归档时可以决定留下什么；自由对话不会被自动写进会意图',
    }
  }
  // 读书模式：**固定一句**（2026-11 用户定调）。
  // 不按"有没有划线"分两种文案——加那个判断是我自己多出来的复杂度，用户明确否掉：
  // "不要再加这个 hasAnn 的判断了，都用'这本书还没有对话'"。
  // 也**不再写书名**：顶栏已经写着《…》了（这就是当初"和《…》聊起来"那句话的问题之一，
  // 另一个问题是搭配——书是被聊的对象，不是跟你聊天的对方）。
  // 主句短还带来一个好处：不会再出现"长书名把这句话顶成两行"那种事故（实测过）。
  return {
    title: '这本书还没有对话',
    rules: PROD_RULES,
  }
}

// 重画开场。只有"当前上下文一条内容都没有、且历史已回放完"时才画——
// 后者是为了避掉启动那一小段空窗：历史还没回来就先画，回来一看有消息再摘掉，
// 用户看到的是闪一下（loadHistory 会把 _histLoaded 置真）。
function renderIntro() {
  const el = document.getElementById('intro')
  if (!el) return
  const base = effectiveBookBase()
  const real = hasRealMsg()
  // 留痕（2026-11 排查用）："该出现却没出现"时，唯一能区分"没轮到画 / 判据不满足 /
  // 画了又被清掉"的证据就是这一条。判定结果变了才上报一次 —— 每次上下文变化都刷屏的话，
  // 这份日志就没法读了；而"变了才报"恰好把用户看得见的每一次状态切换都记下来。
  introTracePost({ base, real, loaded: _histLoaded, free: _freeMode, before: el.hidden, contentLen: el.innerHTML.length })
  // 无有效上下文（书架/首页，读书模式）→ 由「无书默认界面」接管，这里不画
  if (!base || real || !_histLoaded) { dropIntro(); return }
  const plan = introPlan(base)
  if (!plan || !plan.title) { dropIntro(); return }   // 兜底：连一句话都给不出就别占地方
  // ── 结构：**永远三行**（2026-11 用户定调）────────────────────────────────
  //   主句（我在哪）→ 箴言（填空、给分量）→ 署名
  // 层次：主句 15px/最深（语用：先知道这是什么场合），箴言 13px/浅（审美），署名 11px/最浅。
  // 划线**不在这里显示**（用户明确："开场里不该显示那行划线"）：它是内容，不是提示；
  // 下方引用卡已经显示它了。所以这里不再拼任何引文块。
  // 主句文案由 introPlan 按"有没有划线"给（有 → 聊起来；没有 → 还没开张），
  // 但**显示的行数永远一样**——这一点很关键：开场不该因有没有划线而变形。
  const capHtml = `<div class="it-cap" title="${escAttr(plan.rules || PROD_RULES)}">${esc(plan.title)}</div>`
  el.dataset.book = base
  el.hidden = false
  // 也不绑任何点击事件：开场里没有按钮（见文件头的按钮说明）。
  el.innerHTML =
    capHtml +
    `<div class="it-motto">${esc(MOTTO.text)}</div>` +
    `<div class="it-from">${esc(MOTTO.from)}</div>`
}

/**
 * 当前上下文该不该有开场——每次上下文变化 / 历史回放完 / 消息落库后调一次。
 * 置 hidden 之后不 return：applyBookFilter 要照常跑（它决定这一块在当前书下显示与否）。
 *
 * `#msgs.intro-on` 是配套的：空态整块居中（上下留白），有消息时去掉这个类，
 * 消息照旧从顶部往下排。两件事必须同生同灭，所以放在这一个函数里。
 */
function syncIntro() {
  renderIntro()
  const el = document.getElementById('intro')
  const msgs = document.getElementById('msgs')
  if (msgs) msgs.classList.toggle('intro-on', !!(el && !el.hidden))
  if (el) applyBookFilter()
}

/**
 * 追加一个气泡。
 * @returns {HTMLElement|null} 新建的气泡（被去重/就地升级吸收时返回 null）——
 *   调用方（submit）要靠它记住"本轮提问的气泡"，停止时才能精确删掉那一颗。
 */
function addBubble(role, content, extra, note, bookId) {
  // assistant 消息去重
  if (role === 'assistant') {
    const fp = (content || '').slice(0, 200)
    if (_seenFingerprints.has(fp)) return null
    _seenFingerprints.add(fp)
    if (_seenFingerprints.size > 200) _seenFingerprints.clear()  // 防止无限增长
  }

  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')

  // AI-001：书签标记，供按书隔离消息区（引用回复走 _renderRefReply，其内单独打标）
  if (bookId) el.dataset.book = baseBookId(bookId)

  if (role === 'user') {
    el.className = 'msg-user'
    // 带引用的提问 → 上方横幅（引用原文）+ 正文；普通提问照旧整段纯文本
    renderQuoteBubble(el, content)
  } else if (role === 'user-popup') {
    // 来自共读弹窗的用户消息：显示引用 + 用户问题，并启动思考动画。
    // 引用同样走**上方横幅**（2026-11）：弹窗只给 selectedText 字段、正文里没有前缀，
    // 由 quotedQuestionText 拼成库里那套形态再交给同一个渲染——不拼的话气泡里会是一行
    // 生文本 `> "原文"`（绿底上多一个尖括号）。
    showThinking(bookId)
    el.className = 'msg-user'
    const popupRef = extra || {}
    renderQuoteBubble(el, quotedQuestionText({
      content, selectedText: note, bookTitle: popupRef.bookTitle, chapter: popupRef.chapter,
    }))
  } else {
    if (_pendingRefs.length || _streamEl) {
      if (_streamEl) {
        // 流式已显示但最终记录走了兜底路径（-1 标记丢失等）：就地升级/补齐，
        // 避免在已显示的气泡旁再渲染一个重复气泡
        const entry = _pendingRefs.shift()
        if (entry && entry.ref) upgradeStreamToRefReply(_streamEl, entry.ref, content)
        else patchStreamedComplete(_streamEl, content)
        _streamEl = null
        finishWaiting()   // 答案补齐进已显示的气泡 = 这一轮结束，按钮回「发送」
        return null
      }
      // 非流式的完整渲染（历史回放 / 兜底）：直接渲染
      _renderRefReply(content)
      return null
    }
    hideThinking()
    el.className = 'msg-assistant'
    el.innerHTML = mdBubble(content)
  }

  msgs.appendChild(el)
  msgsRecord('bubble:' + role, el)
  dropIntroIfReal(el)   // 会话开张了：这场对话的开场卡（若有）到此为止
  applyBookFilter()
  maybeAutoScroll(msgs)
  return el
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

// ── 历史渲染幂等 + 未回复提问的恢复 ──────────────────────────────────────
// 面板在 AI 回复期间被关闭再打开（2026-11 用户反馈）：
// 关闭侧栏会销毁文档，重开是新会话——loadHistory 只看到"提问"看不到"回复"，
// 既不显示思考状态，还可能漏掉恰在「loadHistory 抓取」与「SSE 注册」之间落库的
// 回复（SSE 新连接 lastId=0 不回放缓冲、/history 又已抓过）——只能靠再次重载
// 才看到答案。这里做三件事：
//  1) loadHistory 幂等：_histKeys 记录已渲染条目，重复执行只补渲染增量；
//  2) 打开时检测「最新提问无回复」→ 恢复思考气泡（该提问的回复在实时流 /
//     轮询补渲染到达时按既有流程正常显示；历史回放只在单趟内部做 [引用] 配对，
//     绝不向实时队列 _pendingRefs 入队——历史里永无回复的旧提问若占着队位，
//     会把之后实时到达的回复劫持成旧书的引用气泡，按书过滤后直接消失）；
//  3) 挂轻量轮询（2s/趟）补渲染间隙里落库的回复，直到回复落库或超上限。
//     实时流（SSE）照常推送，轮询只是兜底，二者都经 _histKeys / 指纹去重互斥。
// ⚠️ 2) 要真的能触发，前提是 receiver 把**在途提问**（status=pending）也回放出来：
// 2026-11 之前 /history 把它滤掉了，于是"思考中关掉面板、再打开"既没有提问气泡、
// 也没有思考气泡（见 receiver/index.js 的 /history 分支）。
const _histKeys = new Set()   // 已渲染的历史条目 key（role|ts|内容前40字）
/**
 * 历史回放过至少一趟（含失败那趟）。
 *
 * 为什么要有这个标志（2026-11）：开场卡不能抢在历史前面画。启动时 applyBookContext →
 * renderNoBookView 会在 loadHistory 之前跑一遍，那时 _histKeys 还是空的，于是"这本书
 * 早就聊过几百轮"也会被当成空会话：先画一张开场卡，历史回来再摘掉——用户看到的是闪一下。
 * 置真之后开场卡才允许出现（见 renderIntro）。
 */
let _histLoaded = false
let _recoverTimer = 0         // 未回复提问的恢复轮询定时器
let _recoverTicks = 0         // 已轮询趟数（上限保护）
let _recoverTs = 0            // 这 60 趟是在等哪一条提问（落库时间戳；换了新一轮就重置预算）
const RECOVER_MAX_TICKS = 60  // ≈2 分钟；正常几趟内结束
let _recoverAnswerSeen = false  // 本会话是否已有回复开始渲染（此后恢复逻辑不再重弹思考气泡）

// 历史条目 key：与 /history 条目（role/_ts）及 SSE 最终记录（timestamp）对齐，
// 让「历史增量渲染」与「实时流收尾渲染」对同一条记录互斥。
function msgHistKey(role, ts, content) {
  return `${role}|${ts || 0}|${String(content || '').slice(0, 40)}`
}

// 完整回复指纹登记（口径与 addBubble 的 assistant 去重一致：前 200 字）。
// 流式收尾渲染时登记，历史增量渲染就不会再渲染同一条回复。
function rememberAssistant(content) {
  _seenFingerprints.add(String(content || '').slice(0, 200))
  if (_seenFingerprints.size > 200) _seenFingerprints.clear()
}

// ── 流式渲染 ──────────────────────────────────────────────────────────────
// 不变量：一条回复只产生一个气泡。chunk 合并进同一个 _streamEl；-1 标记只置
// 完成标志（保留 _streamEl 供最终记录升级/补齐）；最终记录处理后置空 _streamEl。
// 引用回复也流式实时显示，引用条在最终记录到达时就地补上——绝不走 addBubble 再建一个。
let _streamEl = null
let _streamDone = false

function _handleStream(d) {
  // 已弃那一轮的残片（2026-11）：整条丢掉——不画气泡、不置 _streamDone。
  // 认领依据是分片自带的 replyToTs（= 那一轮提问落库的 timestamp），与「停止」收尾登记的
  // _discardedTurnTs 同一个口径。没有它就只能靠"此刻在不在等回答"猜，而实测最糟的情形
  // 恰恰是"用户已经改口问了下一题、旧那轮的分片此刻才到"——猜不出，就画出一颗无主小气泡。
  // 注意 _discardedTurnTs **不随新提问清空**：清空的时机就是旧分片可能到达的时机（见上）。
  if (_discardedTurnTs && Number(d.replyToTs || 0) === _discardedTurnTs) return
  if (d._stream === -1) {
    // 流结束标记：置完成标志等最终完整记录。_streamEl 不置空——最终记录要
    // 用它就地升级出引用条（引用回复）或补齐完整文本（普通回复缺尾）。
    _streamDone = true
    _thinkingBook = ''  // AI-001：本条回复的书签使命结束
    syncSendBtn()       // 字吐完了、但答案还没落库 → 仍算进行中（按钮继续「停止」）
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
    // AI-001：继承本次回复归属的书。优先用回复自带的 bookKey（agent 落库即打标，
    // 与提问书一致），面板重开恢复的提问若历史记录缺 bookId，也能正确归属
    _streamEl.dataset.book = baseBookId(d.bookKey) || _thinkingBook
    _streamEl.innerHTML = `<div class="bubble md"></div>`
    msgs.appendChild(_streamEl)
    msgsRecord('stream', _streamEl)
    applyBookFilter()
  }
  // 流式分片的 content 是**累计全文**（agent 侧约定），所以每片都整段重渲染 markdown：
  // 加粗/列表在标记闭合的那一刻成形，用户看到的就是边流边排版的效果
  _streamEl.querySelector('.bubble').innerHTML = mdToHtml(d.content || '')
  syncSendBtn()   // 回答开始打字 → 按钮必须是「停止」（这一轮还没走完）
  // AI-004：流式时不强制拉滚动条到底部，仅用户接近底部时跟随
  maybeAutoScroll(_streamEl.parentElement)
}

// 引用回复气泡的完整 HTML（引用条 + 引用原文预览 + 回复正文）
function refReplyHTML(ref, content) {
  const book = esc(ref.bookTitle || '')
  // 竖排条 .ref-bar 只有 30–40px 宽：章节名截到 2 字（完整章节名在「当前引用」卡与
  // 引用抽屉里都是全的，这里只是个定位提示），配「章节」竖排标签 + 值横排，见 sidebar.html
  const chapter = esc((ref.chapter || '').slice(0, 2))
  const num = findRefNum(ref.bookTitle, ref.chapter, ref.selectedText)
  const snippet = esc((ref.selectedText || '').slice(0, 80))
  // 注意：不要用带前导空白的模板字符串——生成 HTML 里的换行/缩进会进气泡排版；
  // 正文走 markdown 渲染，引用预览行保持半角引号包住的纯文本（它整行是一句被引用的原文）。
  return (
    `<div class="ref-bar" data-ref-num="${num}">` +
      `<span class="ref-book">${book}</span>` +
      (chapter ? `<span class="ref-chapter"><span class="rc-label">章节</span><span class="rc-val">${chapter}</span></span>` : '') +
      `<span class="ref-num">#${num || '?'}</span>` +
    `</div>` +
    `<div class="bubble md">` +
      `<div class="ref-quote-preview" data-ref-num="${num}">"${snippet}${(ref.selectedText || '').length > 80 ? '…' : ''}"</div>` +
      `${mdToHtml(content)}` +
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
    el.innerHTML = mdBubble(content)
  }
  msgs.appendChild(el)
  msgsRecord('entry:' + (ref ? 'quoted' : 'plain'), el)
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
  if (!b) return
  b.classList.add('md')  // 上游若建的是纯文本气泡，这里一并升级成 markdown 排版
  b.innerHTML = mdToHtml(content)
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  if (sseConn) return
  // 断线重连时带 lastId 续传：只重放上次断开后没收到的事件（AI-006）。
  // 首次连接 _lastEventId=0 → 不带参数 → receiver 不回放（历史由 /history 加载）。
  const q = _lastEventId > 0 ? `?lastId=${_lastEventId}` : ''
  postSidebarDebug({ stage: 'sse-connecting', lastId: _lastEventId })
  sseConn = new EventSource(`${RECEIVER}/events${q}`)
  sseConn.onopen = () => {
    postSidebarDebug({ stage: 'sse-open' })
    setSseOpen(true)
    // 接收端此刻才起来时，把菜单里的「接收端未连接」刷成真实配置状态（只刷新不弹窗）
    refreshApiStatus()
    // AI-012：重连成功后自愈——补上断连期间漏掉的标注，无需重开面板。
    // 初始连接时 _currentBook 可能尚未就绪（refreshCurrentBook 在其后执行），
    // 此时 syncAnnsFromReceiver 内守卫直接返回，由首次 loadHistory 兜底。
    syncAnnsFromReceiver().then(changed => { if (changed) { renderRefUI(); renderDrawer() } })
  }
  sseConn.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      if (d._seq) _lastEventId = Math.max(_lastEventId, d._seq)  // 记录进度，供续传
      if (d.type === 'connected') { setSseOpen(true); return }
      // 会意图刷新（AI-020）：图文件更新 → 图视图开着就重拉
      if (d.type === 'graph-updated') {
        // 第一个知识点诞生时引导一次（见 maybeCoachFirstNode：只认"开机 0 个 → 现在有"）
        maybeCoachFirstNode()
        if (graphView?.isOpen()) graphView.reload()
        return
      }
      // 2026-09：实时栈变化 → 重拉 /stack-hits，恢复/清除"当前讨论命中"高亮
      if (d.type === 'stack-updated') { refreshStackHits(); return }
      // 停止当前回答（2026-02）：接收端已受理停止请求 → 本地收尾。
      // 幂等：点按钮时本地已经收过一次尾，这里再走一次不会出错（气泡已无、高亮已清）。
      // 为什么还要这一条：agent 被强杀 / 接收端自己判定停止（如答案已到）时，
      // 屏幕要靠这条事件才收得干净。
      if (d.type === 'message-stopped') {
        // 只认事件自带的 timestamp（它就是"哪一轮"的身份证）。**不要**回退到 _awaitTs——
        // 那会让一条过期事件被误当成当前轮。对不上就是重放的旧事件，不动屏幕（见 isCurrentTurn）。
        finishStoppedTurn({ content: _awaitContent, bookKey: d.bookKey || _awaitBook, timestamp: d.timestamp })
        return
      }
      // 2026-11 多对话：对话清单变化（新建/改名/归档/删除）→ 重拉清单刷新对话条与列表；
      // 归档完成后当前对话若已被清掉，自动落到最近活跃的一场
      if (d.type === 'free-conversations-updated') {
        const before = _freeKey
        loadFreeConversations().then(async () => {
          if (_freeMode && before && !_freeConvs.some((c) => c.key === before)) {
            const next = _freeConvs.length ? _freeConvs[0].key : (await createFreeConversation({ silent: true }))
            if (next) switchFreeConversation(next)
          }
        })
        return
      }
      // agent 处理步骤（2026-10）：思考气泡按步骤换文案（resolve / answer）。
      // 无气泡（回复已开始渲染/历史回放）时忽略；按书匹配防串上下文（命中按书隔离同款）。
      if (d.type === 'agent-state') {
        const stateBook = baseBookId(d.bookKey) || ''
        if (thinkingEl && (!stateBook || !thinkingEl.dataset.book || stateBook === thinkingEl.dataset.book)) {
          const label = d.step === 'resolve' ? THINKING_COPY.resolve : (d.step === 'answer' ? THINKING_COPY.answer : '')
          if (label) {
            _thinkingStepArrived = true
            clearThinkingFallbacks()
            setThinkingLabel(label)
          }
        }
        return
      }
      if (d.type !== 'message') return

      // 会意图命中（AI-020）：agent 引用解析命中旧知识点（L3 图路径上下文）→
      // 图视图按两层高亮（2026-10）：① 命中节点 + 沿 user 入边的来路 = L3 真带进
      // 本轮 context 的部分（绿）；② 实时栈累计命中的其余节点（橙环，它们的讨论已
      // 在会话历史里）。旧的"混合边全祖先路径并集"已废弃——图和 L3 不一致会误导判断。
      // 图未打开时暂存，打开即应用。
      // 命中按书隔离（2026-09）：graph-hit 带 bookKey（命中所属书），只显示与当前
      // 上下文匹配的命中——自由模式只收 FREE_KEY 的命中（并入引用窗体），读书模式
      // 只收当前书的命中；其他书的命中忽略，避免串上下文
      if (d.role === 'graph-hit' && Array.isArray(d.hits) && d.hits.length) {
        const hitBook = baseBookId(d.bookKey) || ''
        // 2026-10：命中按有效上下文隔离（手动选书时按手动选中的书）
        const ctxBook = effectiveBookBase()
        console.log('[CoRead] graph-hit', d.hits.length, 'hitBook=', hitBook, 'ctxBook=', ctxBook, 'open=', !!graphView && graphView.isOpen())
        if (hitBook !== ctxBook) return
        // 已弃那一轮的命中（2026-11）：命中是在**生成回答之前**写出来的，用户完全可能在
        // "引用判定"那几秒里点停止 —— 事件这时才到，一来就把图点亮，而那一轮已经没有提问、
        // 也不在栈里（收口不会碰到它）。认出来源就整条丢掉，与流式分片同一套身份证。
        if (_discardedTurnTs && Number(d.replyToTs || 0) === _discardedTurnTs) return
        graphView?.onHit(d.hits, d.reason || '')
        _hitBook = hitBook
        // 自由模式：语义命中自动并入引用窗体（可悬浮取消），随消息提交为 cites
        if (_freeMode) {
          for (const id of d.hits) addFreeRef(id, '', true)   // auto：停止时要收回去
        }
        return
      }

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
        // 指纹去重检查必须在 rememberAssistant 登记之前：若这条回复已由
        // 「未回复提问恢复轮询」的历史增量渲染过（完整气泡已在屏），这里只丢弃
        // 流式占位气泡即可——不得再 shift 队列（配对条目已被增量渲染消费）
        const dupAlreadyRendered = _seenFingerprints.has(String(d.content || '').slice(0, 200))
        // 登记历史/指纹：恢复轮询的增量历史重拉不会把这条回复再渲染一遍
        _histKeys.add(msgHistKey('assistant', d.timestamp, d.content))
        rememberAssistant(d.content)
        if (dupAlreadyRendered) {
          if (_streamEl) { _streamEl.remove(); _streamEl = null }
          finishWaiting()   // 答案已由恢复轮询渲染过：这一轮同样结束了
          return
        }
        const entry = _pendingRefs.shift()  // 队列非空才渲染引用气泡，内部按序 shift
        if (entry && entry.ref) {
          if (_streamEl) upgradeStreamToRefReply(_streamEl, entry.ref, d.content)
          else _renderEntry(entry, d.content)  // 空回复等无流式气泡时兜底
        } else if (_streamEl) {
          patchStreamedComplete(_streamEl, d.content)
        } else {
          // 流式分片全部错过（面板关闭期间落库 / loadHistory↔SSE 间隙）、只收到
          // -1 + 最终记录：没有气泡可补齐，直接按完整回复渲染，避免本次打开漏答案
          addBubble('assistant', d.content)
        }
        _streamEl = null
        finishWaiting()   // 最终完整记录到齐 = 这一轮结束，按钮回「发送」
        return
      }

      // 「设为当前引用」不产生气泡、applySetRef 幂等，不参与消息去重：
      // 该事件无 timestamp/content，去重 key 恒为常量，会误伤第 2 次起的设置。
      if (d.role === 'annotation-select') {
        applySetRef({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
          chapterUid: d.chapterUid, chapterUidInt: d.chapterUidInt || 0, selectedText: d.selectedText,
          // 译文（2026-11）：PDF 阅读器「设为引用」那条路带它。丢了它就等于这条引用
          // 没有译文可显示（引用卡与对话横幅双双回落原文）。
          ...(d.translation ? { translation: d.translation } : {}),
          sourceUrl: d.sourceUrl || '' })
        return
      }

      // 微信读书划线同步：划线立即成为引用并设为当前引用（可见的"反应"）。
      // 复用 applySetRef 的选中逻辑（当前书之外不强制选中），不弹气泡。
      if (d.role === 'annotation-sync') {
        if (d.bookId && d.selectedText) {
          applySetRef({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter || '',
            chapterUid: '', chapterUidInt: d.chapterUidInt || 0,
            bookmarkRange: d.bookmarkRange || '', bookmarkId: d.bookmarkId || '',
            // 微读划线没有译文（这个字段恒缺失）——透传只为形状统一，不改变行为
            ...(d.translation ? { translation: d.translation } : {}),
            selectedText: d.selectedText, sourceUrl: d.sourceUrl || '' })
        }
        return
      }

      // 划线在微信读书里被删除（用户点「删除划线」）：同步移除引用列表 + 刷新书页共读标记。
      // AI-018：走 removeAnns 统一入口——被删的是当前选中引用时一并清空选中态，
      // 否则卡片会继续显示已删划线的陈旧内容（此前只 splice 不碰 selectedAnn）。
      if (d.role === 'annotation-removed') {
        const removed = d.removed || []
        if (removed.length) {
          removeAnns(a => removed.some(r => refMatches(a, r)))  // AI-007：精确匹配，避免连坐
          saveState()
          renderRefUI()
          renderDrawer()  // 若抽屉开着，让被删引用从列表消失
          try { chrome.runtime.sendMessage({ action: 'refreshCoReadMarks' }) } catch {}
        }
        return
      }

      if (_isDuplicate(d)) return
      // 系统提示（2026-09）：/收口 等指令反馈——toast + 系统样式气泡。
      // 消费掉对应消息的 pending 配对条目（该条指令消息在发送时入过队），不参与
      // 引用回复配对；历史回放时 _isDuplicate 已去重，不会重复弹 toast。
      if (d.role === 'system') {
        _pendingRefs.shift()
        hideThinking()
        finishWaiting()   // 指令的回执到了 = 这一轮结束
        showToast(d.content, false)
        renderSystemBubble(d.content)
        return
      }
      if (d.role === 'assistant') {
        addBubble('assistant', d.content)
        finishWaiting()   // 没有流式气泡可补、答案直接落库到了 = 这一轮结束
      } else if (d.role === 'user-popup') {
        // 来自共读弹窗的用户消息（AI-001：引用回复绑定该书）
        _pendingRefs.push({ ref: { bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter, selectedText: d.selectedText } })
        addBubble('user-popup', d.content,
          { bookTitle: d.bookTitle, chapter: d.chapter }, d.selectedText, d.bookId)
        // 弹窗发送的标注要实时加入引用列表（标注走 annotation-select 事件，不产生消息气泡）
        if (d.bookId && d.selectedText) {
          addRecentAnn({ bookId: d.bookId, bookTitle: d.bookTitle, chapter: d.chapter,
            chapterUid: d.chapterUid, selectedText: d.selectedText, sourceUrl: d.sourceUrl || '' })
        }
      }
      // AI-010：不再处理 role='annotation'——标注一律是引用（走 annotation-select/annotation-sync），
      // receiver 不推 annotation 消息气泡，消息区不再渲染"只显示引用"的气泡。
    } catch {}
  }
  sseConn.onerror = () => {
    // 记下 readyState：0=CONNECTING（还在重试）1=OPEN（罕见：open 之后又报错）
    // 2=CLOSED（**致命**：浏览器已经放弃，必须自己重建，否则永远是灰的）
    postSidebarDebug({ stage: 'sse-error', readyState: sseConn ? sseConn.readyState : -1 })
    setSseOpen(false)
    sseConn.close()
    sseConn = null
    setTimeout(connect, 5000)
  }
}

// ── 当前讨论命中（2026-09 用户定调）────────────────────────────────────────
// 命中 = 当前实时栈（topic_stack）里 user 条目挂的 cites 对应的节点：
// 打开图 / 收到 stack-updated / 切书时从 receiver 重拉 /stack-hits 恢复高亮；
// 图视图据此渲染"第二层"（橙环，本场讨论已挂的知识点）+ 与本轮命中一起算 L3 来路层
// （2026-10 两层口径，见 extension/graph-view.js computeHitLayers）。
// 栈收口清空后 hits 为空 → 图视图清除 hit 态高亮（栈结束即命中结束）。
async function refreshStackHits() {
  const ctxBook = effectiveBookBase()
  if (!ctxBook) return
  // 图视图不可用时：读书模式不拉；自由模式仍拉——窗体锁定条目（栈命中并入）不依赖图
  if (!graphView && !_freeMode) return
  let hits = null
  try {
    const r = await fetch(RECEIVER + '/stack-hits?book=' + encodeURIComponent(ctxBook))
    const d = await r.json()
    hits = Array.isArray(d.hits) ? d.hits : []
  } catch {}
  // 自由模式（2026-10 用户定调）：同一份栈命中并入窗体为锁定条目（历史消息已提交的
  // 引用，不可删，随栈自动更新）——图上栈命中高亮与窗体显示同源，保持两边一致。
  // 栈收口/清空后 hits 为空 → 锁定条目清空、图按 applyStackHits 的空结果规则清除。
  if (_freeMode && hits) setFreeStackCites(hits)
  if (!graphView || !hits) return
  // 「本轮还在进行」交给图视图判空结果（2026-11）：这一轮还没走完（在等回答 / 正在流式
  // 渲染 / 等答案落库，见 isAnswerInFlight）时，本轮提问的 cites 还没由 agent 写进实时栈，
  // /stack-hits 必然是空的 —— 那不是"命中结束"，不能据此清高亮（用户报："命中动画一结束就
  // 打开会意图，刚命中的节点没被高亮，要等回答完成才补上"）。
  graphView.applyStackHits(hits, { pending: isAnswerInFlight() })
}

// ── 停止当前回答（2026-02 用户定调）─────────────────────────────────────────
// 回答生成期间，发送按钮**就地**变「停止」（不并排加第二个按钮）。
// 点停止 → 通知接收端写一个信号文件（agent 在另一个进程里，只能这样告诉它）→
// 本地立刻收尾：删掉提问与半截回答两颗气泡、清命中高亮、原文回填输入框。
//
// 为什么按钮态以"本地是否在等回答"为准、不等 agent 回执：agent 被强杀时回执永不到达，
// 按钮会永远卡在「停止」，用户既停不了也发不出。
let _awaitingStop = false    // 本轮提问还没走完：从发送起，到答案落库 / 被停掉 / 失败为止
let _awaitUserEl = null      // 本轮提问的气泡（停止时要连它一起删）
let _awaitBook = ''          // 本轮提问归属的对话（命中按对话隔离，防串场）
let _awaitTs = 0             // 本轮提问的落库 timestamp（停止请求要带上它做目标标识）
// 已经被「停止」弃掉那一轮的身份证（= 提问落库 timestamp，2026-11）。
// 为什么留着它：停止是**本地先收尾**的（提问与半截回答两颗气泡当场删掉），而 agent 那一头
// 可能还在生成 —— 实测模型第一个 token 能晚到 8.6 秒（点停止 19:58:08.982，第一片
// 19:58:17.611）。那片分片带着 `replyToTs` 回来时，侧栏手里已经没有"本轮"了（气泡删了、
// 也不在等回答），只能新建一颗气泡把那半句画上；而被弃那一轮**永远不会再落一条完整回答**
// 来补它 → 屏幕上就留下一颗没有提问的小气泡（用户报的「小气泡里写着'这句话'」）。
// 所以这里记下身份证，_handleStream 认出来源的残片一律不画。
let _discardedTurnTs = 0
// "停止比 /chat 的回执先到"（2026-11 的窄缝）：连点两下按钮就可能发生 —— 发送的请求还在飞，
// 停止已经点了，这时还不知道这条提问的 timestamp（身份证没到手）。先记一笔，等回执到了再补
// 认领；否则那一轮的迟到分片会因为"认不出来源"又画出一颗无主气泡。
let _stopBeforeTs = false
const STOP_LABEL = '停止'
const SEND_LABEL = '发送'

function setSendBtnMode(stopping) {
  const btn = document.getElementById('send-btn')
  if (!btn) return
  btn.textContent = stopping ? STOP_LABEL : SEND_LABEL
  btn.classList.toggle('stopping', !!stopping)
}

/**
 * 还有一条回答没走完吗？下面三种情形都算「进行中」，按钮都该是「停止」：
 *   · 在等回答（模型还没吐第一个字，`_awaitingStop`）
 *   · 屏幕上正有流式气泡在长（`_streamEl`）
 *   · 流吐完了、最终完整记录还没到（`_streamDone`）
 *
 * 2026-11 修（用户定调复盘）：**整条回答写完之前都能停**。原先按钮态只跟着「思考气泡」走，
 * 而流式第一片到达时正好会撤思考气泡（见 _handleStream）→「停止」活不过回答的第一个字：
 * 回答一开始打字，按钮就变回「发送」，那条长回答再也停不掉（想停只能等它写完）。
 */
function isAnswerInFlight() {
  return !!_awaitingStop || !!_streamEl || !!_streamDone
}
/** 把上面那个事实投影到按钮上。**凡是改动这三个状态的地方都要调它一次**，否则按钮卡在旧样子。 */
function syncSendBtn() { setSendBtnMode(isAnswerInFlight()) }

/** 开始等这一条的回答：按钮变「停止」。userEl = 这条提问的气泡 */
function startWaiting(userEl, book, content) {
  _awaitingStop = true
  _awaitUserEl = userEl || null
  _awaitBook = book || ''
  _awaitTs = 0
  _awaitContent = content || ''
  _stopBeforeTs = false   // 新的一轮：上一轮的"停止赶在回执前"作废
  syncSendBtn()
}
/** 这一轮结束了（答案落库 / 已停止 / 失败 / 放弃等待）：清等待标记，按钮按实际状态回落。
 *  不清 _awaitTs 与 _awaitUserEl——停止收尾（SSE 可能比 POST 响应先到）还要用它们。 */
function finishWaiting() {
  _awaitingStop = false
  syncSendBtn()
}
let _awaitContent = ''   // 本轮提问原文（停止后回填输入框）

/** 点「停止」：告知接收端 + 本地收尾（不等回执）。 */
async function requestStop() {
  // 只认事实：没有在飞的一轮（此刻按钮是「发送」）就忽略。
  // 回答已经开始打字时 _awaitingStop 仍是 true（见 isAnswerInFlight），所以这一条也放过。
  if (!isAnswerInFlight()) return
  const content = _awaitContent
  const ts = _awaitTs
  const book = _awaitBook
  // 回执还没回来（ts=0）就点了停止：先记一笔，等 POST 回执到了再把身份证补登记
  // （见 submit 里处理 /chat 响应的那一段），否则这一轮的迟到分片认不出来源、又会画成气泡。
  _stopBeforeTs = !ts
  // 本地先收尾：用户点下去就该看到反应，不等 agent。SSE message-stopped 到达时会再走一次
  // 同一个收尾函数（幂等），那时 _awaitTs 已填好，可登记历史 key。
  // force：本地这一次是"确认要停"，此刻 ts 可能还没从 POST 响应回来，不能拿它当门槛。
  finishWaiting()
  finishStoppedTurn({ content, bookKey: book, timestamp: ts, force: true })
  try {
    await fetch(`${RECEIVER}/session-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv: book, targetTs: ts }),
    })
  } catch (e) {
    console.warn('[CoRead] session-stop POST failed:', e.message)
  }
}

/**
 * 这条停止事件是不是"当前这一轮"的（2026-02）。
 *
 * 为什么必须判：message-stopped 是按**对话**隔离的，而删除是**不认轮次**的——
 * 只要同一场对话里收到这个事件就会删掉"当前那颗提问气泡"。而 SSE 断线重连会
 * **补发最近 100 条事件**（接收端 recentEvents 缓冲），于是一次停止的旧事件
 * 完全可能在下一轮提问时被重放，把新气泡连带删掉（现象：正常提问的气泡也没了）。
 *
 * 所以：能对 timestamp 就一定对（提问落库时间戳是这一轮的身份证）；
 * 对不上就是过期的重放事件，一律不动屏幕。force = 本地刚点的停止（此刻 ts 可能还没回来）。
 */
function isCurrentTurn({ bookKey, timestamp, force } = {}) {
  const evBook = baseBookId(bookKey) || ''
  const ctxBook = effectiveBookBase()
  if (evBook && ctxBook && evBook !== ctxBook) return false
  if (force) return true
  if (!_awaitUserEl && !_streamEl) return false     // 屏幕上没有"本轮"可删
  const ts = Number(timestamp || 0)
  return !!ts && ts === Number(_awaitTs || 0)
}

/**
 * 停止收尾（幂等）：撤思考气泡、删提问与半截回答两颗气泡、清命中高亮与自动弹出的图窗口、
 * 原文回填输入框（**覆盖**框内内容，2026-02 用户定调）。
 */
function finishStoppedTurn({ content, bookKey, timestamp, force = false } = {}) {
  // 排查留痕（2026-02）：这条路径只在"停止"时该被走到。若正常提问也被走到，
  // debug.jsonl 里会留下 source=sidebar / kind=stop-turn 的记录，可直接定位是谁触发的。
  postSidebarDebug({
    kind: 'stop-turn', bookKey, timestamp: timestamp || 0, force,
    awaitTs: _awaitTs, hasUserEl: !!_awaitUserEl, hasStreamEl: !!_streamEl,
  })
  if (!isCurrentTurn({ bookKey, timestamp, force })) return    // 过期事件 / 别的对话：不动屏幕
  // 记下这一轮的身份证（提问落库 timestamp），供 _handleStream 认领"之后才到的残片"。
  // 只在这一轮真的被收尾时登记：上面那道闸挡掉的过期重放事件不该被记成"已弃"。
  _discardedTurnTs = Number(timestamp || _awaitTs || 0)

  hideThinking()
  // 半截回答气泡（流式那条）
  if (_streamEl) {
    try { _streamEl.remove() } catch {}
    _streamEl = null
  }
  _streamDone = false
  finishWaiting()   // 这一轮已被弃掉：清等待标记，按钮回「发送」
  // 提问气泡
  if (_awaitUserEl) {
    try { _awaitUserEl.remove() } catch {}
    _awaitUserEl = null
  }
  // 命中高亮 + 自动弹出的拓扑图窗口。图不是这一轮自动弹的就不关（用户自己开着的窗口不关）。
  try {
    const gv = graphView
    if (gv) {
      gv._cancelAutoDismiss()          // 先取消挂起的渐隐/轮播定时器
      gv.clearHighlight()              // 高亮与"本轮命中"一起清（内置 _turnHits = null）
      if (gv._autoOpened) gv.close()
      gv._autoOpened = false
    }
  } catch {}
  // 引用配对队列：本次请求那个占位条目出队，否则下一条真实回复的配对会挤偏一格。
  // 2026-11 修：出队要按**提交顺序**（shift）而不是弹末尾（pop）—— 用户可以在一条回答
  // 还没写完时再按回车问下一题，那时队列里排着两条，pop 会把**下一条**的占位挤掉，
  // 于是后一条的引用回复配对整体偏一格（引用条挂错消息）。正在生成的就是队首那一条。
  try { if (_pendingRefs.length) _pendingRefs.shift() } catch {}
  // 自由模式：把"这一轮语义命中自动并入"的待提交引用收回（人工选的与已进栈的锁定组不动）
  try { dropAutoFreeRefs() } catch {}
  // 登记历史 key：面板重开时的增量历史不会把这条提问再渲染一遍
  try { if (timestamp) _histKeys.add(msgHistKey('user', timestamp, content || '')) } catch {}
  // 原文回填（覆盖框内内容），光标置末尾并保持聚焦——改题目重发是本功能的主要用途。
  // 没有原文可回填时（接收端自己判定停止、本地没参与）不清空用户正在打的字。
  try {
    const inp = document.getElementById('input')
    if (inp) {
      if (content) inp.value = content
      _inputPrevValue = inp.value
      inp.style.height = 'auto'
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'
      inp.focus()
      inp.setSelectionRange(inp.value.length, inp.value.length)
    }
  } catch {}
  // 收尾是一次性的：清掉"本轮"引用，之后任何重放的旧事件都不会再命中这一轮（见 isCurrentTurn）
  _awaitUserEl = null
  _awaitTs = 0
  _awaitContent = ''
  // 停掉的若是这场对话的**第一条**提问，消息区此刻又空了（提问气泡与半截回答都被摘掉）。
  // 这时把开场卡放回来，而不是留一块白板——用户按「停止」多半就是想换个问法再来一次，
  // 卡上的按钮正好接住这一步。里面有内容时 hasRealMsg 会拦住，不会凭空多出一张卡。
  syncIntro()
}

// ── 发送 ─────────────────────────────────────────────────────────────────────
async function submit() {
  const input = document.getElementById('input')
  const typed = stripInvisibleBidi(input.value).trim()  // 双向控制字符不进正文（见 esc 注释）
  // 框里挂着命令块时，把它拼在正文前面（形如「/相处 以后别老用比喻」）；
  // 用户自己手打了斜杠命令（正文以 / 开头）就忽略块——以他手打的为准
  const useCmd = _pendingCmd && !typed.startsWith('/')
  const content = useCmd ? (_pendingCmd + (typed ? ' ' + typed : '')) : typed
  const attach = _pendingAttachment
  // 允许只有附件、没有正文；也允许只有命令块（「/相处」单独回车 = 只列清单）
  if (!content && !attach) return
  // /归档（2026-11）：自由模式下的斜杠命令，直接弹出归档确认窗（要勾选产物去向，
  // 不能像普通消息那样直接发出）。不发消息、不入队，输入框照常保留原文本。
  if (_freeMode && content === '/归档') {
    document.getElementById('cmd-menu').hidden = true
    openFreeArchive(_freeKey)
    return
  }
  // 本机程序没在运行 → 不发，弹窗告知（2026-10）。
  // 拦在清空输入框之前：原文字样留着，用户启动 CoRead 后直接再按一次发送即可。
  if (!_backendAlive) {
    showSendFailedNotice('CoRead 本机服务未运行，消息未发送。\n双击 Start-CoRead.vbs 启动后重试。')
    pingOnce()   // 立刻复探一次，把灯刷成真实状态
    return
  }
  input.value = ''
  _inputPrevValue = ''
  _pendingCmd = ''
  renderCmdChip()
  _quoteParityFlipped = false  // 新消息重新判定输入法引号奇偶（下次第一下就错会立刻再纠正）
  input.style.height = 'auto'
  _pendingAttachment = null
  renderAttachChip()
  // AI-001：消息归属有效上下文——有选中引用归引用书；否则归正在阅读的书 /
  // 手动选中的书（2026-10），自由消息也带上"在哪本书里聊起来的"标记，切书后不显示
  const msgBook = selectedAnn ? selectedAnn.bookId : effectiveBookBase()
  // 斜杠命令（/收口 等，2026-09）不绑定引用——否则 [引用] 前缀会破坏命令匹配
  const _isCmd = /^\//.test(content)
  // 本次提问是否绑定引用：自由模式强制不带（测试对话不绑定引用），斜杠命令也不带
  const isQuoted = !!(selectedAnn && !_freeMode && !_isCmd)
  // 气泡文本与**落库文本同格式**（`[引用]《书名》章节` + `> "引用文本"` + 空行 + 正文）：addBubble
  // 会把这段前缀渲染成上方横幅。以前气泡只喂正文，于是同一条提问"刚发出去"是干净提问、
  // "重开面板后从历史回放"却多出一段 `[引用]…> "…"` 原文（2026-11 用户报的"气泡长出前缀"）。
  //
  // 2026-11：引用文本走 refDisplayText（**译文优先**）——PDF 那条引用带译文时，
  // 横幅显示用户读到的那句；原文仍是引用的身份（body.selectedText 不动），
  // 只是不上横幅（在引用卡里可查，那里点「原文」就看得到）。
  const quoteHead = isQuoted
    ? buildQuotedQuestion(selectedAnn.bookTitle, selectedAnn.chapter, refDisplayText(selectedAnn), '') + '\n'
    : ''   // 末尾这个换行 = 引用块与正文之间那个空行（正文由 bubbleText 接在后面）
  // 气泡预览：附件用「📎 文件名」占位 + 正文（附件正文不整段贴进气泡，只进 agent 上下文）
  const attachText = attach
    ? ('📎 ' + attach.fileName + (content ? '\n\n' + content : ''))
    : content
  const bubbleText = quoteHead + attachText
  const userEl = addBubble('user', bubbleText, null, null, msgBook)
  showThinking(msgBook)
  // 发送成功即进入"等回答"态：按钮变「停止」，并记住这颗提问气泡（停止时连它一起删）
  startWaiting(userEl, msgBook, content)

  // 附件块：作为本次讨论上下文喂给 AI；用后即弃，不落盘、不生成文档书、不建已上传列表
  const attachBlock = attach ? ('[附件]《' + attach.fileName + '》\n' + attach.text) : ''
  const body = {}

  // 自由模式强制走自由消息路径（测试对话不绑定引用；进入自由模式时已清空选中引用，
  // 这里双保险：即使 selectedAnn 残留也不让消息带 [引用] 前缀/划线上下文）。
  // 判据与气泡文本共用 isQuoted，避免"气泡有横幅、落库没有前缀"这类不一致。
  if (isQuoted) {
    // AI-001：引用回复气泡按 bookId 打书签隔离；入队等最终记录配对（AI-006）
    _pendingRefs.push({ ref: { bookId: selectedAnn.bookId, bookTitle: selectedAnn.bookTitle, chapter: selectedAnn.chapter, selectedText: selectedAnn.selectedText } })
    body.bookId = selectedAnn.bookId
    body.bookTitle = selectedAnn.bookTitle
    body.chapter = selectedAnn.chapter || ''
    body.chapterUid = selectedAnn.chapterUid || ''
    body.selectedText = selectedAnn.selectedText
    // 为什么**不**把译文也塞进聊天库：那样要给 messages 表加一列，而它只服务一件事
    // ——回放时把横幅重建成译文。而译文本来就躺在标注存档里（/annotation 落的那个
    // `translation`），/history 会按消息的 bookId + selectedText 把它带回来，
    // 见 quotedQuestionText。能不加列就不加列。
    // 落库文本 = 前缀 + 正文；前缀与气泡文本（quoteHead）同源，不再各写一份（两处各写
    // 一份字符串，改一处忘一处就会出现"气泡有横幅、重开后没了"这类不一致）
    body.content = quoteHead + content
  } else {
    // AI-006：自由提问也入队一个 ref:null 条目，保证最终记录按提交顺序配对。
    // 之前自由消息不入队，若「自由回复流式中途又发引用」，自由回复的最终记录
    // 会错配到新入队的引用（引用条错标）；现在每条消息都有占位，配对不乱。
    _pendingRefs.push({ ref: null })
    // 自由消息也把当前书标记传给 receiver，落库后历史回放能按书归属（AI-001）；
    // 2026-10：手动选书时按手动选中的书归属
    const effBook = effectiveBook()
    if (effBook && effBook.base) {
      body.bookId = effBook.base
      body.bookTitle = effBook.bookTitle || ''
    }
    // 自由模式：携带引用窗体清单（语义命中 + 手动选取，用户可取消），agent 收口
    // 以它为 cites 建 user 边（2026-09）
    if (_freeMode && _freeRefs.length) {
      body.refs = _freeRefs.map((r) => r.id)
    }
    body.content = content
  }
  // 附件块前置到发给 agent 的内容（叠加到文本/引用之上）
  if (attachBlock) {
    body.content = attachBlock + (body.content ? '\n\n' + body.content : '')
  }

  try {
    const resp = await fetch(`${RECEIVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (resp.ok) {
      // 把这条提问注册为"历史已渲染"（_histKeys，key 与 /history 条目一致：
      // role=user + receiver 落库 timestamp + 落库 content）：面板打开期间若有
      // 回复恢复轮询在跑（此前有提问在 AI 回复中），增量历史重拉不会把刚发的
      // 提问再渲染一遍
      try {
        const j = await resp.json()
        if (j && j.timestamp) {
          _histKeys.add(msgHistKey('user', j.timestamp, body.content))
          // 停止请求需要它做"目标是哪一条"的标识（agent 侧据此配对提问行）
          if (_awaitingStop) _awaitTs = j.timestamp
          // 停止比回执先到：此刻才拿到这条提问的身份证，补登记给 _handleStream 认领残片
          else if (_stopBeforeTs) { _discardedTurnTs = j.timestamp; _stopBeforeTs = false }
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[CoRead] chat POST failed:', e.message)
    // 兜底（2026-10）：轮询最多滞后 5 秒，"刚好在断掉那一瞬间"发送仍会走到这里。
    // 必须说一句 —— 否则屏幕上就是"我的话在、思考闪了一下、然后什么都没有"。
    // 原文放回输入框：用户启动 CoRead 后可以直接重发，不用重打一遍。
    try {
      const inp = document.getElementById('input')
      if (inp && !inp.value) { inp.value = content; inp.style.height = 'auto' }
    } catch {}
    showSendFailedNotice('CoRead 本机服务未响应，消息未发送。\n原文已保留在输入框，可再次发送。')
    pingOnce()
    // 发送失败：这条消息没到 receiver、agent 不会回复。弹掉刚入队的自己的条目，
    // 避免它的最终记录永远不来、把后续真实回复的配对挤偏。不整队清空——前一条
    // 仍在流式的回复还需要自己的队项配对。
    _pendingRefs.pop()
    _awaitUserEl = null   // 这条没发出去，没有"本轮提问气泡"可留
    hideThinking()
    finishWaiting()       // 没发出去 = 没有这一轮，按钮回「发送」
  }
}

// 输入框净化（2026-10）：粘贴进来的不可见双向控制字符会就地改写整段文字的方向，
// 让全角引号 “ ” 镜像成 ” “ —— 用户看到的就是"双引号顺序反了"，但字符本身看不见、
// 也说不清哪里不对。这里在输入时直接剥掉，并保持光标位置不跳（见 stripInvisibleBidi）。
function cleanInputBidi(el) {
  const before = el.value
  const after = stripInvisibleBidi(before)
  if (after === before) return
  const caret = el.selectionStart
  el.value = after
  const pos = Math.max(0, (caret || 0) - (before.length - after.length))
  try { el.setSelectionRange(pos, pos) } catch {}
}

// ── 全角双引号方向校正（2026-10）─────────────────────────────────────────────
// 现象（用户实测 + 落库码点确认）：在侧栏输入框里按引号键，**第一下出 ”、第二下才出 “**，
// 即"双引号顺序反了"；粘贴一段正确的 “……” 进来显示却完全正常，换到别的输入框也正常。
//
// 成因：中文输入法的引号键是「按次数奇偶交替输出 “ / ”」。这个奇偶状态一旦在一个输入框里
// 停在被错开的一侧（先按过一次、或删掉重打、或发送后 JS 清空 value 而输入法计数没回位），
// 该框内的引号就会**一直**反着出；焦点换到别的程序/输入框会重置，所以别处看着正常。
// 输入法内部状态插件改不了，但可以在字符插入的瞬间把方向纠正回来：
//   · 只有"本框第一次全角双引号打出来是 ”（且它前面没有未配对的 “）"才判定奇偶被错开；
//   · 判定后，本框内之后每次插入的全角双引号一律取反 → 用户看到的就是正确的 “ ” “ ”；
//   · 正常输入（第一下就是 “）**完全不干预**——粘贴的正确文本、输入法正常时的嵌套引号
//     “a“b”c” 都不会被动；
//   · 框里引号清空（发送后 / 全删）→ 重新判定。
// 只处理全角双引号：半角 " 与单引号 ‘’ 不动（英文撇号 don’t 会被误伤）。
let _quoteParityFlipped = false

// s 里未配对的 “ 个数（多出来的 ” 不产生负数）
function unmatchedOpenQuotes(s) {
  let depth = 0
  for (const c of s) {
    if (c === '\u201c') depth++
    else if (c === '\u201d') depth = Math.max(0, depth - 1)
  }
  return depth
}

// 打字纠正：只在 value 恰好新增 1 个字符（＝敲进一个字符）时判定；粘贴/不增反减不参与。
// prevValue 是上一次 input 事件后的值（调用方维护）。
function fixTypedQuoteDirection(el, prevValue) {
  if (!el || el.isComposing) return  // 输入法组字中（拼音串）不动
  const v = el.value
  const caret = el.selectionStart
  if (v.length === prevValue.length + 1 && caret != null && caret > 0) {
    const pos = caret - 1
    const ch = v[pos]
    if (ch === '\u201c' || ch === '\u201d') {
      if (!_quoteParityFlipped && ch === '\u201d' && unmatchedOpenQuotes(v.slice(0, pos)) === 0) {
        _quoteParityFlipped = true  // 第一次引号就是闭合引号 → 输入法奇偶被错开了
        postSidebarDebug({ source: 'input', stage: 'quote-parity-flip', at: pos })
      }
      if (_quoteParityFlipped) {
        const want = ch === '\u201c' ? '\u201d' : '\u201c'
        el.value = v.slice(0, pos) + want + v.slice(pos + 1)
        try { el.setSelectionRange(caret, caret) } catch {}  // 1:1 换字，光标位置不变
      }
    }
  }
  if (el.value.indexOf('\u201c') === -1 && el.value.indexOf('\u201d') === -1) _quoteParityFlipped = false
}
let _inputPrevValue = ''  // 输入框上一次的 value（打字纠正要判断"新增了哪个字符"）

// 待提交的命令（点斜杠菜单里需要补内容的项后出现）。它**不是输入框里的文本**，而是贴在框内
// 左侧的一个整体块：接着打的要求与它是一个整体，框里为空时按退格、或点块上的 ✕，一起移除；
// 提交时由 submit() 拼成「/相处 你的要求」。
let _pendingCmd = ''
function renderCmdChip() {
  const chip = document.getElementById('cmd-chip')
  const input = document.getElementById('input')
  if (!chip || !input) return
  if (_pendingCmd) {
    const name = document.getElementById('cmd-chip-name')
    if (name) name.textContent = _pendingCmd
    chip.hidden = false
    // chip 是绝对定位（不占文档流），所以要把输入框左内距推到它右边，文字才不会被压住
    input.style.paddingLeft = (chip.offsetWidth + 14) + 'px'
  } else {
    chip.hidden = true
    input.style.paddingLeft = ''   // 回落到 CSS 默认值
  }
}
document.getElementById('cmd-chip-remove').addEventListener('click', () => {
  _pendingCmd = ''
  renderCmdChip()
  document.getElementById('input').focus()
})

document.getElementById('send-btn').addEventListener('click', () => {
  // 回答生成中（含已经开始打字）→ 同一个按钮是「停止」（2026-02 用户定调：就地变，不并排加第二个）
  // 判据必须与按钮文案同源（isAnswerInFlight），否则会出现"显示停止、点下去却变成发送"
  if (isAnswerInFlight()) { requestStop(); return }
  submit()
})
document.getElementById('input').addEventListener('keydown', e => {
  const menu = document.getElementById('cmd-menu')
  const menuOpen = !!menu && !menu.hidden
  // 菜单开着时这四个键归菜单（轮不到"发送"）：↑↓ 移动选中、Enter 确认、Esc 关掉
  if (menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    moveCmdHighlight(e.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (menuOpen && e.key === 'Escape') {
    e.preventDefault()
    menu.hidden = true
    clearCmdHighlight()
    return
  }
  // Tab = 补全（不执行）：把当前选中项放进输入框，焦点留在输入框等用户接着打字。
  // 与 Enter 的分工——Enter 是"确认执行"，Tab 是"先把它填进来，我还想补点别的"（类 shell 补全）。
  // 菜单没开时不拦 Tab，浏览器默认的焦点移动照旧（2026-10）。
  if (menuOpen && e.key === 'Tab') {
    e.preventDefault()
    const items = visibleCmdItems()
    const cur = items.find((it) => it.classList.contains('on')) || items[0]
    const el = document.getElementById('input')
    if (cur) {
      const cmd = cur.dataset.cmd || ''
      menu.hidden = true
      clearCmdHighlight()
      clearTypedCommandStub(el)   // 清掉唤起菜单的那半截（Tab 路径原先漏了 → chip 旁边多一个 /）
      if (cur.dataset.prefill) {
        _pendingCmd = cmd      // 需要补内容的命令（/相处）→ 落成 chip，接着打要求
        renderCmdChip()
      } else {
        el.value = cmd         // 无参命令（/收口）→ 补全成文本、不执行（想发再回车）
        _inputPrevValue = cmd
        el.style.height = 'auto'
      }
    }
    el.focus()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (menuOpen) {
      const typed = document.getElementById('input').value.trim()
      // 已经手打完整条命令（/收口、/相处…）→ 直接发它，不要替他选菜单第一项
      const exact = visibleCmdItems().find((it) => (it.dataset.cmd || '') === typed)
      if (exact) {
        menu.hidden = true
        clearCmdHighlight()
        submit()
        return
      }
      // 还只是半截（"/"、"/相"）→ Enter 确认当前选中项（复用点击处理：chip / 直接执行都在那）
      const items = visibleCmdItems()
      const cur = items.find((it) => it.classList.contains('on')) || items[0]
      if (cur) cur.click()
      return
    }
    if (document.getElementById('input').value.trim() === '/') return  // 纯 "/" 不发送（斜杠菜单占位）
    submit()
    return
  }
  // 框里已经空了还按退格 → 删掉待提交的命令块（要删就一起删，不留半个命令）
  if (e.key === 'Backspace' && _pendingCmd && !document.getElementById('input').value) {
    e.preventDefault()
    _pendingCmd = ''
    renderCmdChip()
  }
})
document.getElementById('input').addEventListener('input', function () {
  // 顺序要紧：先按"原始值"判断打字纠正（它靠 +1 字符定位），再做双向控制字符净化，
  // 最后把净化后的值记成基准，供下一次判断
  fixTypedQuoteDirection(this, _inputPrevValue)
  cleanInputBidi(this)
  _inputPrevValue = this.value
  this.style.height = 'auto'
  this.style.height = Math.min(this.scrollHeight, 120) + 'px'
})
// 输入法组字结束（拼音上屏）时补一次判定，并同步基准值
document.getElementById('input').addEventListener('compositionend', function () {
  _inputPrevValue = this.value
})
// 粘贴走同一套净化：paste 后 value 才更新，所以在下一个事件循环里补一次（输入法上屏同理）
document.getElementById('input').addEventListener('paste', function () {
  const el = this
  setTimeout(() => {
    cleanInputBidi(el)
    _inputPrevValue = el.value
  }, 0)
})

// ── 斜杠命令菜单（2026-09）：输入 / 弹出可用操作，点击即执行 ──
// 2026-11 多对话：/归档 只在自由模式出现（归档当前对话并选择产物去向），
// /收口 只在读书模式出现（自由对话要不要收口由归档时决定，收口用的是同一套程序）。
const cmdMenu = document.getElementById('cmd-menu')
function syncCmdMenuItems() {
  if (!cmdMenu) return
  for (const item of cmdMenu.querySelectorAll('.cmd-item')) {
    const when = item.dataset.when || 'reading'
    // 'both' = 两种模式都显示（相处规则与读书/自由模式无关，2026-10）
    item.hidden = when === 'both' ? false : (when === 'free') !== !!_freeMode
  }
}
/**
 * 菜单里**当前可见**的项。按模式隐藏的项（hidden）不参与上下键——
 * 否则键盘会停在一个看不见的项上（2026-10）。
 */
function visibleCmdItems() {
  if (!cmdMenu) return []
  return [...cmdMenu.querySelectorAll('.cmd-item')].filter((it) => !it.hidden)
}
/** 选中第 idx 项（越界绕回，所以一直按 ↓ 会循环）。焦点仍在输入框，这是"高亮"不是 DOM focus */
function setCmdHighlight(idx) {
  const items = visibleCmdItems()
  for (const it of items) it.classList.remove('on')
  if (!items.length) return
  const i = ((idx % items.length) + items.length) % items.length
  items[i].classList.add('on')
}
/** ↑↓ 移动选中态；当前没有选中时，↓ 落第一项、↑ 落最后一项 */
function moveCmdHighlight(delta) {
  const items = visibleCmdItems()
  if (!items.length) return
  const cur = items.findIndex((it) => it.classList.contains('on'))
  setCmdHighlight(cur < 0 ? (delta > 0 ? 0 : items.length - 1) : cur + delta)
}
function clearCmdHighlight() {
  if (!cmdMenu) return
  for (const it of cmdMenu.querySelectorAll('.cmd-item.on')) it.classList.remove('on')
}
/**
 * 选完菜单项之后，清掉"唤起菜单时敲的那半截命令"（"/" 或 "/相"）——它不是内容，只是占位符；
 * 留着会跟 chip（或补全/写回的文本）拼成「//相处」这种双斜杠。
 * 只清"以 / 开头且不含空白"的半截：带空格的是用户已经写完的话，不动。
 * 三条选择路径（鼠标点击、Enter、Tab）共用这一个函数——2026-10 修 Tab 路径漏清。
 * @returns {boolean} 是否清掉了
 */
function clearTypedCommandStub(el) {
  if (!el || !/^\/\S*$/.test(String(el.value || '').trim())) return false
  el.value = ''
  _inputPrevValue = ''
  el.style.height = 'auto'
  return true
}
if (cmdMenu) {
  document.getElementById('input').addEventListener('input', () => {
    const v = document.getElementById('input').value || ''
    // 只在"正在敲命令"时开菜单：以 / 开头**且还没出现空白**。
    // 一旦打了空格（如「/相处 别老用比喻」），说明命令段结束、后面是正文——菜单必须让开，
    // 否则按回车会被当成"选中菜单项"，而不是发送这条消息（2026-10 修）。
    const show = /^\/\S*$/.test(v)
    if (show) syncCmdMenuItems()
    cmdMenu.hidden = !show
    // 第一个字符是 / → 选中态自动落到第一项，接着就能 ↑↓ 选、Enter 确认
    if (show) setCmdHighlight(0)
    else clearCmdHighlight()
  })
  // 鼠标划过哪一项，选中态就跟到哪一项（键盘与鼠标共用同一个高亮，不会两处同时亮）
  cmdMenu.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.cmd-item')
    if (!item || item.hidden) return
    const i = visibleCmdItems().indexOf(item)
    if (i >= 0) setCmdHighlight(i)
  })
  cmdMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.cmd-item')
    // 按模式隐藏的项：正常情况下它 display:none、根本点不到（见 .cmd-item[hidden]），这行是防御
    if (!item || item.hidden) return
    const el = document.getElementById('input')
    const cmd = item.dataset.cmd || ''
    cmdMenu.hidden = true
    clearCmdHighlight()
    clearTypedCommandStub(el)   // 清掉唤起菜单的那半截（见函数注释）
    if (item.dataset.prefill) {
      // 需要补内容的命令（/相处）：命令做成输入框内的一个整体块，用户接着打自己的要求，
      // 提交时自动拼成「/相处 你的要求」。**不直接发**——点它的人本意是要接着说话。
      _pendingCmd = cmd
      renderCmdChip()
      cmdMenu.hidden = true
      el.focus()
      return
    }
    // 无参命令（/收口、/归档）：直接执行；若框里还挂着上一个命令块，先摘掉（用户换意图了）
    if (_pendingCmd) { _pendingCmd = ''; renderCmdChip() }
    el.value = cmd
    _inputPrevValue = el.value
    submit()
  })
  document.addEventListener('click', (e) => {
    if (!cmdMenu.contains(e.target) && e.target !== document.getElementById('input')) {
      cmdMenu.hidden = true
      clearCmdHighlight()
    }
  })
}

// ── 上传文本附件（读取进本次讨论，不落盘保存原文件）──────────────────────────
// 只接受 .md/.txt，读到的正文暂存 _pendingAttachment，随下一条消息作为讨论上下文
// 发给 agent；用后即弃——不写盘、不生成文档书、不建"已放入的文件"列表。
const ATTACH_MAX_CHARS = 50000  // 单次附件正文上限（防撑爆讨论上下文）
function renderAttachChip() {
  const chip = document.getElementById('attach-chip')
  const nameEl = document.getElementById('attach-chip-name')
  if (!chip || !nameEl) return
  if (_pendingAttachment) {
    nameEl.textContent = _pendingAttachment.fileName
    chip.hidden = false
  } else {
    chip.hidden = true
    nameEl.textContent = ''
  }
}

async function pickAttachment(file) {
  if (!file) return
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!['md', 'markdown', 'txt', 'text'].includes(ext)) {
    showToast('仅支持 .md / .txt 文本附件', true)
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast('附件超过 2MB，无法添加', true)
    return
  }
  let text
  try { text = await file.text() } catch { showToast('读取附件失败', true); return }
  if (!text.trim()) { showToast('附件内容为空', true); return }
  // 只截取前 ATTACH_MAX_CHARS（带省略说明），避免超大文本直接撑爆讨论上下文
  if (text.length > ATTACH_MAX_CHARS) {
    text = text.slice(0, ATTACH_MAX_CHARS) + '\n…[前 ' + ATTACH_MAX_CHARS + ' 字之外已省略]'
  }
  _pendingAttachment = { fileName: file.name, text }
  renderAttachChip()
  showToast('已添加文本附件：' + file.name)
}

document.getElementById('attach-btn')?.addEventListener('click', () => {
  document.getElementById('file-input')?.click()
})
document.getElementById('file-input')?.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0]
  if (f) pickAttachment(f)
  e.target.value = ''  // 清空选择，允许重复选择同一文件
})
document.getElementById('attach-chip-remove')?.addEventListener('click', () => {
  _pendingAttachment = null
  renderAttachChip()
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
    // 网页上划出来的引用：不管它归到哪本书（网页书 / 微读正式书 / 阅读器 PDF），
    // 跳转目标都是那个网页。判据是 sourceUrl 的站点，不是 bookId 前缀。
    const fromWebPage = isPageSourceUrl(ann.sourceUrl)

    // ---- 诊断（2026-11）：把"当时到底拿到了什么"写下来 ----------------------------
    // 为什么要这一条：用户报"点切换引用回到选书界面"，而我加的那条 `rd_` 分支**没进**——
    // 但我是靠"日志里没有 jump-rd"**推断**出来的，没有直接证据说明 `ann.bookId` 长什么样。
    // 这类"分支为什么没进"的问题，唯一可靠的办法是把入参原样打出来。
    postSidebarDebug({
      stage: 'jump-begin',
      annBookId: String(ann.bookId || '').slice(0, 32),
      base: String(base || '').slice(0, 32),
      isRd: base.indexOf('rd_') === 0,
      fromWebPage,
      text: String(ann.selectedText || '').slice(0, 24),
      chapterNum: ann.chapterNum === undefined ? '(无)' : ann.chapterNum,
    })

    // 我们自己阅读器里的书（`rd_`，含扩展自带的教程书）——**必须在这里拦下来**。
    // 2026-11 用户实测：在教程书里点「切换引用」，界面回到了**选书界面**。
    // 原因是这条路漏了：下面全是"去微信读书跳转"的逻辑，`rd_` 书既不在 weread tab 里、
    // 也没有章节槽位，于是被当成"找不到的书"处理，用户看到的就是选书界面。
    //
    // 修法要点（用户第二次反馈后定稿）：
    //   ① 优先走**同页定位**：`readerCommand` 的 `locate(text)`——阅读器不重载、
    //      直接在正文里找到这段原文并滚过去、加一圈高亮。用户点"跳到原文"要的是
    //      "让我看见那句话在哪"，不是"把整本书重新打开一遍"。
    //   ② 定位不到再退回"按章打开"（深链带 `&chapter=`）。
    //   ③ **不要依赖引用里的章号**：教程书的引用是我们自己造的，它**没有** chapterNum，
    //      于是 `Number(undefined) || 0` = 0，深链缺了 `&chapter=`，阅读器只能从头打开——
    //      这正是用户看到的"回到主界面"。
    if (base.indexOf('rd_') === 0 && !fromWebPage) {
      try {
        const r = await chrome.runtime.sendMessage({
          action: 'readerCommand', type: 'locate', text: String(ann.selectedText || ''),
        }).catch(() => null)
        postSidebarDebug({
          stage: 'jump-rd', located: !!(r && r.ok && r.found), text: String(ann.selectedText || '').slice(0, 20),
        })
        if (r && r.ok && r.found) return
      } catch (e) {}
      // 同页定位没成（阅读器没开、或者这段不在这一本里）：退回按章打开
      try {
        await chrome.runtime.sendMessage({
          action: 'openReaderBook',
          base,
          name: ann.bookTitle || '',
          chapter: Number(ann.chapterNum) || 0,
        })
      } catch (e) {
        showToast('打不开阅读器：' + String((e && e.message) || e), true)
      }
      return
    }

    // 网页阅读源（AI-021）：跳转 = 打开标注所在网页并滚动到原文。
    // 目标 URL 带 #coread=<encodeURIComponent(selectedText)>，source-mia.js 加载后定位滚动；
    // 已在同一页则直接发 coread-scroll 消息，不重载。↩ 返回记录原 tab（URL 级恢复）。
    //
    // 旧条件只认 `mia_` 书。网页现在也能绑定到正式书籍（微信读书 / 阅读器），
    // 那些引用同样带着网页 sourceUrl，必须走这条路；`mia_` 仍保留在条件里，
    // 是为了让缺 sourceUrl 的旧网页引用仍能报出"缺少页面地址"，而不是掉进微读跳转。
    if (fromWebPage || base.indexOf('mia_') === 0) {
      const srcUrl = String(ann.sourceUrl || '')
      if (!srcUrl || !ann.selectedText) {
        showToast('该引用缺少页面地址，无法跳转', true)
        return
      }
      const baseUrl = srcUrl.split('#')[0]
      const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      const onSamePage = !!(cur && cur.url && cur.url.split('#')[0] === baseUrl)
      if (onSamePage && cur.id) {
        try {
          await chrome.tabs.sendMessage(cur.id, { action: 'coread-scroll', text: ann.selectedText })
        } catch {}
        return
      }
      // 记住当前位置供「↩ 返回」（URL 级）
      if (cur && cur.id && cur.url) {
        jumpBackPos = { url: cur.url, tabId: cur.id, ts: Date.now() }
        await persistJumpBack()
        renderJumpBack()
      }
      const target = baseUrl + '#coread=' + encodeURIComponent(ann.selectedText)
      // 复用同作品的已开 tab（按目录前缀），否则新开 tab（不劫持其他书页面）
      const dirPrefix = new URL(baseUrl).pathname.replace(/[^/]*$/, '')
      const mTabs = await chrome.tabs.query({ url: 'https://www.marxists.org/chinese/*' })
      const mtab = mTabs.find(function (t) {
        try { return t.url && new URL(t.url).pathname.indexOf(dirPrefix) === 0 } catch (e) { return false }
      })
      if (mtab) {
        await chrome.tabs.update(mtab.id, { url: target, active: true })
      } else {
        await chrome.tabs.create({ url: target, active: true })
      }
      return
    }

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
/**
 * 自绘确认弹窗：扩展页面不能用原生 confirm()（Chrome 压制并恒返回假），
 * 这里用侧栏内的 overlay + 确认/取消按钮替代，返回 Promise<boolean>。
 *
 * ⚠️ 只有"确定 / 取消"两个答案。曾经为"PDF 记录还是原件"加过第三个按钮，
 * 用户否掉了那个模型（两个界面各自代表一样东西，不该让人在一次删除里选），
 * 于是按钮与 altText 参数一并撤掉——少一个参数、少一种组合，别再加回来。
 */
function showConfirm(title, message, { okOnly = false, okText = '确认删除' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay')
    document.getElementById('confirm-title').textContent = title
    document.getElementById('confirm-msg').textContent = message
    overlay.classList.add('on')
    const okBtn = document.getElementById('confirm-ok-btn')
    const cancelBtn = document.getElementById('confirm-cancel-btn')
    // okOnly（2026-10）：只留一个确定按钮，用于"只告知、不需要用户做选择"的场景
    // （例：本机程序没在运行时按了发送）。此时遮罩点击与 Esc 都按"知道了"处理；
    // 另挂 .notice 走一套"通知型"排版（正文两行、按钮紧凑且绿色，见 sidebar.html）。
    okBtn.textContent = okText
    cancelBtn.hidden = okOnly
    if (okOnly) overlay.classList.add('notice')
    let keyTimer = null   // 下面"延后注册 Enter 监听"用的句柄（见函数末尾那段注释）
    const cleanup = () => {
      if (keyTimer) clearTimeout(keyTimer)  // 若弹窗在监听挂上之前就关了（见下方注册那段）
      overlay.classList.remove('on')
      overlay.classList.remove('notice')   // 通知型的排版不能留给下一次普通确认框
      okBtn.removeEventListener('click', onOk)
      cancelBtn.removeEventListener('click', onCancel)
      overlay.removeEventListener('mousedown', onDown)
      overlay.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
    }
    const onOk = () => { cleanup(); resolve(true) }
    const onCancel = () => { cleanup(); resolve(false) }
    // 点遮罩＝取消：与 bindMaskClose 同款判定——按和松都落在遮罩上才算，
    // 避免在确认框里按下、拖到遮罩上松开时被误当取消（详情见 bindMaskClose 注释）
    let downOnMask = false
    const onDown = (e) => { downOnMask = e.target === overlay }
    const onUp = (e) => {
      const onMask = downOnMask && e.target === overlay
      downOnMask = false
      if (onMask) { if (okOnly) onOk(); else onCancel() }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { if (okOnly) onOk(); else onCancel() }
      else if (e.key === 'Enter') onOk()
    }
    okBtn.addEventListener('click', onOk)
    cancelBtn.addEventListener('click', onCancel)
    overlay.addEventListener('mousedown', onDown)
    overlay.addEventListener('mouseup', onUp)
    // Esc / Enter 的全局监听**延到下一个事件循环**再挂（2026-10 修一个真 bug）：
    // 弹窗有可能正是被一次"回车"打开的（本机程序没在运行时按回车发送），而**同一次
    // keydown 还会继续冒泡到 document** —— 监听若当场挂上，这个回车会立刻命中 onKey
    // → onOk，弹窗开了又瞬间关掉，用户完全看不见（实机现象：按回车毫无反应，
    // 只有点发送按钮才弹得出来）。
    keyTimer = setTimeout(() => document.addEventListener('keydown', onKey), 0)
    if (!okOnly) cancelBtn.focus()  // 默认聚焦「取消」，防止误触回车直接删除
  })
}

// 发送失败提示（2026-10）：本机程序没在运行（或发送途中断开）时告知用户。
// 为什么用自绘弹窗而不是原生 alert()：扩展页面里原生对话框被 Chrome 压制
//   （见 showConfirm 上方的注释），而且自绘的与侧栏视觉一致。
// 为什么不 await：不必等用户点掉弹窗才结束 submit()，调用即返回。
function showSendFailedNotice(message) {
  return showConfirm('无法发送', message, { okOnly: true, okText: '知道了' })
}

// 自绘输入弹窗（2026-11：自由对话重命名）。与 showConfirm 同款 overlay，返回
// Promise<string|null>（取消/关闭返回 null）。不用原生 prompt()——扩展页面里 Chrome 压制它。
function showPrompt({ title, message = '', value = '', placeholder = '', maxLength = 40 }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-overlay')
    const input = document.getElementById('prompt-input')
    if (!overlay || !input) { resolve(null); return }
    document.getElementById('prompt-title').textContent = title
    const msgEl = document.getElementById('prompt-msg')
    msgEl.textContent = message
    msgEl.hidden = !message
    input.value = value
    input.placeholder = placeholder
    input.maxLength = maxLength
    overlay.classList.add('on')
    const okBtn = document.getElementById('prompt-ok-btn')
    const cancelBtn = document.getElementById('prompt-cancel-btn')
    const cleanup = () => {
      overlay.classList.remove('on')
      okBtn.removeEventListener('click', onOk)
      cancelBtn.removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKey)
      overlay.removeEventListener('mousedown', onDown)
      overlay.removeEventListener('mouseup', onUp)
    }
    const onOk = () => { const v = input.value; cleanup(); resolve(v) }
    const onCancel = () => { cleanup(); resolve(null) }
    const onKey = (e) => {
      // 输入框里的 Enter 提交、Escape 取消；stopPropagation 防止冒泡触发全局快捷键
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onOk() }
      else if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    let downOnMask = false
    const onDown = (e) => { downOnMask = e.target === overlay }
    const onUp = (e) => {
      const onMask = downOnMask && e.target === overlay
      downOnMask = false
      if (onMask) onCancel()
    }
    okBtn.addEventListener('click', onOk)
    cancelBtn.addEventListener('click', onCancel)
    input.addEventListener('keydown', onKey)
    overlay.addEventListener('mousedown', onDown)
    overlay.addEventListener('mouseup', onUp)
    setTimeout(() => { input.focus(); input.select() }, 30)
  })
}

async function deleteRef(ann) {
  if (!ann?.bookId || !ann?.selectedText) return false
  const ok = await showConfirm('删除这条引用？', '删除后书页中的共读标记也会移除。')
  if (!ok) return false

  // 先从本地移除匹配项（AI-007：按 bookmarkId/章节位置精确匹配，避免同文本连坐删除）。
  // removeAnns 统一处理"移除的是当前选中引用 → 一并清空选中态"（AI-018）
  removeAnns(a => refMatches(a, ann))
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

  /**
   * 同一件事也要告诉**阅读器**（2026-11）：它在书页上画的"已引用"绿线（rd-ref）
   * 同样以这份存档为准，而删除不一定经过译文面板——引用卡、抽屉里都能删。
   * 不通知的话，用户会看到"侧栏里已经删了，书页上还留着一道线"，要等下一次
   * refreshRefs（切回标签页 / 打开译文面板）才消失。
   *
   * 带上 bookId：侧栏存着所有书的引用，不带的话在 A 书删一条会把 B 书阅读器里
   * 同文的标记一起抹掉（同文不同书，肉眼几乎发现不了）。
   */
  try {
    chrome.runtime.sendMessage({
      action: 'readerCommand', type: 'forgetRef',
      text: ann.selectedText, bookId: ann.bookId,
    })
  } catch {}

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
  // 返回"确实删了"：调用方（译文面板的动作条）据此决定要不要提示成功、
  // 要不要把下划线抹掉。用户取消 / 参数不全都走上面的 false，不能当成删了。
  return true
}

// ── 未回复提问的恢复轮询 ──────────────────────────────────────────────
// loadHistory 末尾发现最新提问无回复时开启：每 2s 重拉一次 /history（loadHistory
// 幂等，只补增量渲染）。目的：覆盖"回复恰在 loadHistory 抓取与 SSE 注册之间落库"
// 的漏网窗口——那次回复既不在历史快照里、SSE 新连接（lastId=0）也不回放，不轮询
// 就只能等下次重载才看到答案。回复落库（下一次扫描不再是 pending）即停。
function scheduleRecoverPoll() {
  clearTimeout(_recoverTimer)
  if (_recoverTicks >= RECOVER_MAX_TICKS) return
  _recoverTimer = setTimeout(async () => {
    _recoverTicks++
    await loadHistory()  // loadHistory 尾部会再次调用本函数决定续期或停止
  }, 2000)
}
function stopRecoverPoll() {
  clearTimeout(_recoverTimer)
  _recoverTicks = 0
  _recoverTs = 0
}

// 完整 assistant 记录的直接渲染（历史增量 / 轮询补渲染专用）。与 addBubble 的
// 区别：绝不触碰正在进行的实时流气泡（_streamEl）与实时提交队列（_pendingRefs）——
// 历史增量渲染可能发生在实时流中间（未回复提问的恢复轮询期间 AI 正在流式输出），
// 若走 addBubble / _renderRefReply 会把历史里较早的回复错补到当前流式气泡上、
// 或把实时队列里新提问的配对条目错误消费掉。引用条配对只接受本趟历史遍历内部
// 的局部条目（histRef），绝不从全局队列取。指纹与实时流收尾渲染互斥。
function renderCompleteAssistant(content, bookId, histRef) {
  const fp = String(content || '').slice(0, 200)
  if (_seenFingerprints.has(fp)) return  // 已被实时流/历史渲染过
  _seenFingerprints.add(fp)
  if (_seenFingerprints.size > 200) _seenFingerprints.clear()
  if (histRef) {
    _renderEntry({ ref: histRef }, content)  // 本趟局部配对：历史里的引用回复带引用条
    return
  }
  hideThinking()
  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')
  el.className = 'msg-assistant'
  if (bookId) el.dataset.book = baseBookId(bookId)
  el.innerHTML = mdBubble(content)
  msgs.appendChild(el)
  msgsRecord('assistant:complete', el, { via: histRef ? 'hist' : 'direct' })
  dropIntroIfReal(el)   // 历史/轮询补渲染出第一条回复 → 开场卡该摘了（限当前上下文）
  applyBookFilter()
  maybeAutoScroll(msgs)
}

async function loadHistory() {
  // 遍历结束时若 pendingUser 仍非空 = 最新一条提问还没有回复落库（AI 仍在回复中，
  // 或回复恰在「loadHistory 抓取」与「SSE 注册」之间落库、本趟没抓到）——据此恢复
  // "思考中"状态并挂轮询补渲染（见函数尾部）。
  // 标志先置：本趟（含失败那趟）跑完，开场卡才有资格出现（见 _histLoaded 的注释）。
  _histLoaded = true
  let pendingUser = null
  let loadFailed = false  // /history 抓取失败（接收端暂不可用）：轮询不能停，等恢复
  try {
    const items = await fetch(`${RECEIVER}/history`).then(r => r.json())
    // 引用列表已由 loadState() 从本地恢复；这里把历史里尚未加入的标注补进来
    // （例如侧栏关闭期间新增的标注）。addRecentAnn 内部按 bookId+selectedText 去重，
    // 已存在的引用不会重排/重新编号，select:false 也不会覆盖恢复的选中状态。
    // 本函数幂等：_histKeys 记录已渲染条目，重复执行（恢复轮询）只补渲染增量。
    let histBook = ''  // AI-001：历史游走中当前的书上下文，assistant 回复继承
    let histPendingRef = null  // 本趟局部单槽配对（[引用] 提问 → 本趟内到达的回复）
    for (const d of items) {
      if (d.role === 'graph-hit') continue  // AI-020：会意图命中事件不渲染为消息
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
            sourceUrl: d.sourceUrl || '',
            // 译文（2026-11）：面板重开/本地引用被对账清理后靠这趟重建，
            // 漏掉它就是"重开一次译文变回原文"
            ...(d.translation ? { translation: d.translation } : {}),
            selectedText: d.selectedText }, { select: false })
        }
      }
      else if (d.role === 'user') {
        if (d.bookId) histBook = baseBookId(d.bookId)
        // 幂等：已渲染过的提问（本会话发送/上一趟已渲染）直接跳过，不重复渲染。
        // 提问气泡元素要留着：等在回答的那条提问，恢复「停止」按钮时得知道删哪颗气泡。
        let userEl = null
        const key = msgHistKey('user', d._ts, d.content)
        if (!_histKeys.has(key)) {
          _histKeys.add(key)
          // 无 bookId 的旧自由消息：沿用当前书上下文做最佳归属（AI-001），
          // 不切断书签链——它是在该书讨论期间发出的
          // 文本走 quotedQuestionText：弹窗来的提问引用在 selectedText 字段里，
          // 不拼回来气泡就只剩提问、横幅不见了（2026-11）
          userEl = addBubble('user', quotedQuestionText(d), null, null, d.bookId || histBook)
        }
        // 在途提问（receiver 标了 pending = 回复还没落库，agent 还在回答）。
        // 2026-11 用户报的 bug：这种提问原先被 receiver 整个滤掉，于是"思考中关掉面板、
        // 再打开"时提问气泡与思考气泡双双不见。标记照旧记在 pendingUser 上，供本函数
        // 尾部恢复思考气泡 + 「停止」按钮（见那里的注释）。
        pendingUser = { bookId: d.bookId || histBook, content: d.content, el: userEl, ts: Number(d._ts) || 0, inFlight: !!d.pending }
        // 在途提问 = **本轮回答还没开始渲染**：历史里排在它之前的那些回复属于更早的回合，
        // 不能拿它们当"本轮答案已在屏上"（渲染历史回复会经 hideThinking 把这个标志置真，
        // 不重置的话重开面板时思考气泡又被吞掉——正是这一条让本测试第一版红过）。
        // 有实时流气泡时不重置：那才是真的"本轮答案正在打字"，此时不许再弹思考气泡。
        if (d.pending && !_streamEl) _recoverAnswerSeen = false
        // 本趟局部配对（histPendingRef，单槽、仅 [引用] 提问）：它的回复在本趟
        // 遍历里到达时带引用条渲染。绝不入 _pendingRefs（实时提交队列）——
        // 历史里"永远没被回复"的旧提问（如被截断/agent 漏答）若占着实时队位，
        // 会劫持之后实时到达的回复（把新回复渲染成旧书的引用气泡，按书过滤后
        // 直接消失；自由模式提问的回复就是这么丢的）。
        if (userEl) {
          const ref = parseRefFromContent(d.content)
          if (ref) {
            histPendingRef = ref
            if (d.bookId) histPendingRef.bookId = d.bookId
          }
        }
      }
      else if (d.role === 'assistant') {
        pendingUser = null  // 此前的提问已有回复落库
        const key = msgHistKey('assistant', d._ts, d.content)
        if (_histKeys.has(key)) continue
        _histKeys.add(key)
        // 归属（2026-10-02）：优先用回复自带的 bookKey（receiver 按库里 conv 打标）——
        // 旧数据 / 哨兵上下文（_common）才退回"最近前序提问的书"（histBook）。
        // 不加这条会把跨书回复算到当前书上：2026-09-28 重放的 74 条《静静的顿河》回复
        // 因此堆在《大国大城》末尾（那段时间没有 user 消息，histBook 停在大国大城）。
        const replyBook = (d.bookKey && d.bookKey !== '_common') ? baseBookId(d.bookKey) : histBook
        // 走 renderCompleteAssistant：历史渲染不碰实时流气泡与实时队列（见上），
        // 引用条配对只用本趟局部 histPendingRef；指纹与实时流收尾渲染互斥
        renderCompleteAssistant(d.content, replyBook, histPendingRef)
        histPendingRef = null
      }
    }
    // 对账清理：划线同步来的引用（带 bookmarkRange）必然存在于 annotations.jsonl，
    // 会在 /history 里返回。若微信读书里删了划线（可能发生在侧栏关闭期间），对应标注
    // 已从存档移除、/history 不再返回，这里把本地列表里的幽灵引用清掉，避免重开侧栏又冒出来。
    // AI-018：走 removeAnns——被清掉的若是当前选中引用，一并清空选中态（此前只 splice，
    // 恢复的选中引用被清理后卡片仍显示陈旧内容直到下次重开）。
    {
      const histAnnKeys = new Set()
      for (const d of items) {
        if (d.role === 'annotation') {
          histAnnKeys.add(baseBookId(d.bookId) + '::' + String(d.selectedText || '').replace(/\s+/g, ''))
        }
      }
      removeAnns(a => {
        if (!a.bookmarkRange) return false  // 手动弹窗引用不在这套数据里，不误删
        const key = baseBookId(a.bookId) + '::' + String(a.selectedText || '').replace(/\s+/g, '')
        return !histAnnKeys.has(key)
      })
    }
    // 首次启动（本地从未保存选中状态）：默认选中最新的一条标注
    if (!_selectionStateRestored && !selectedAnn && RECENT_ANNS.length) {
      selectedAnn = RECENT_ANNS[0]
      saveState()
    }
  } catch { loadFailed = true }
  // 划线共读"设为当前引用"：无论 /history 是否成功都尝试应用待选引用。
  // 引用列表已由 loadState() 从本地恢复，待选引用若就在本地引用里可直接选中；
  // /history 失败（receiver 未启动）或标注尚未入库时保留待选标记，下次加载再试。
  applyPendingSelect()
  // 恢复的引用列表可能没有触发 addRecentAnn 的渲染，这里统一刷新一次
  renderRefUI()
  // AI-011：/history 刷新了 RECENT_ANNS 后，若引用抽屉已开着（划线内容搜索可能
  // 在面板加载期间由实时消息提前打开），重渲染一次让搜索结果显示最新数据
  renderDrawer()

  // ── 未回复提问的恢复（面板在 AI 回复期间被关闭再打开）────────────────
  // 历史里最新一条是提问且无回复落库：恢复"思考中"气泡 + 挂恢复轮询，
  // 补渲染间隙里落库的回复。该提问的实时回复到达时按既有流程渲染（流式分片
  // 直接建气泡、最终记录走收尾分支；无配对条目时渲染普通气泡，绝不会因本趟
  // 历史没有入队而丢回复）；回复落库 / 回复已实时渲染后轮询即停。
  //
  // 2026-11 补齐两件事（用户报"思考中关掉面板、再打开两颗气泡都不见了"）：
  //   ① 在途提问现在由 receiver 回放（带 pending 标记），所以这里真的会走到
  //      "有提问没回复"这一支——此前 receiver 把 pending 行滤掉了，这一支只在
  //      "提问存在但回复永远不来"的罕见情况下才触发；
  //   ② 除了思考气泡，把「停止」按钮一起恢复：重开后状态与关掉前一致，这条还在
  //      生成的回答能直接停掉（原先只有一颗思考气泡、按钮却是「发送」，自相矛盾）。
  if (loadFailed) {
    // 抓取失败：接收端暂不可用，回答无法送达，保住轮询等它恢复
    scheduleRecoverPoll()
  } else if (pendingUser) {
    // 轮询预算按**这一条提问**算（用落库时间戳当身份证）：换了新一轮提问就把预算重置，
    // 否则上一轮攒满的趟数会让新一轮刚开就"放弃"。
    if (pendingUser.ts && pendingUser.ts !== _recoverTs) { _recoverTicks = 0; _recoverTs = pendingUser.ts }
    if (_recoverTicks >= RECOVER_MAX_TICKS) {
      // 轮询预算（≈2 分钟）用尽还是没等到回答：撤掉思考气泡并说清原因。
      // 不撤的话这颗气泡会一直转下去——本机服务没跑、模型不可用、agent 被强杀
      // 都会落在这一支（回复真到了仍会正常渲染，只是不再占着一颗转圈的球）。
      // 提示只在"库说这条还在处理中"时给：那种情况"一直没等到"的判断才站得住。
      if (thinkingEl) {
        hideThinking()
        finishWaiting()   // 放弃等待 = 这一轮到此为止，按钮回「发送」（答案真到了仍会渲染）
        if (pendingUser.inFlight) {
          showToast('这条提问一直没等到回答：CoRead 本机服务或模型可能没在运行。回答到达时会自动显示。', true)
        }
      }
    } else {
      // 只有当思考气泡已被清掉、且本会话还没有回复开始渲染时才恢复它——
      // 回复已在流式渲染中（气泡正打字）时不再弹一个"思考中"在它后面
      if (!thinkingEl && !_recoverAnswerSeen) {
        showThinking(pendingUser.bookId)
        // 提问正文（剥掉 [引用] 头与 > 原文行）做停止收尾的"原文回填"，
        // 否则库里那串前缀会被灌进输入框
        startWaiting(pendingUser.el || _awaitUserEl, pendingUser.bookId, questionTextFrom(pendingUser.content))
        // startWaiting 会把 _awaitTs 清 0（实时那条要等 POST /chat 的响应才填），
        // 但恢复的这条**现在就知道** ts：它是"哪一轮"的身份证，停止请求与
        // message-stopped 事件的配对都用它，不补上的话停止会以 ts=0 收尾
        //（气泡删了、历史 key 却登记错，面板重开时这条提问又会从历史里长回来）。
        _awaitTs = pendingUser.ts || 0
      }
      scheduleRecoverPoll()
    }
  } else {
    stopRecoverPoll()
    // 没有"在途提问"了 = 这一轮结束了（答案已落库并被本趟历史渲染，或提问已被停掉）。
    // 面板在回答期间关掉再打开时，答案是从历史补渲染的、不走 SSE 的最终记录分支，
    // 所以按钮要靠这里复位——不然「停止」会一直挂着（2026-11 与按钮态解耦一起补的）。
    finishWaiting()
  }
  // 最后一步：这场对话一条内容都没有 → 落开场卡（有内容则它已经被 addBubble /
  // renderCompleteAssistant 摘掉了，这里再兜一次）。放在函数尾部是因为卡上的引文
  // 要等本趟回放把 RECENT_ANNS 补齐、把"最新一条划线"选出来才算得准。
  syncIntro()
}

/**
 * 一条历史提问的正文：剥掉 `[引用]《书名》章节` 头与 `> "原文"` 行。
 *
 * 为什么要它：库里 user 消息的 content 对引用提问是带前缀的（`[引用]…\n> "…"\n\n提问`），
 * 而「停止」收尾会把 `_awaitContent` **覆盖**回输入框。直接拿 content 回填的话，
 * 用户会看到 `[引用]《大国大城》\n> "划线原文"` 被灌进输入框里。
 */
function questionTextFrom(content) {
  const body = String(content || '').split('\n')
    .map((l) => l.trim())
    .filter((t) => t && !t.startsWith('>') && !t.startsWith('[引用]'))
  return body.join('\n').trim() || String(content || '').trim()
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
  // 带引用的提问：正文在 .uq-body，横幅 .uq-quote 也在 textContent 里且不以 `>` 开头
  //（渲染后前缀已变成横幅），不先把正文挑出来，浮窗列表会把引用原文当成提问摘要
  const bodyEl = bubble.querySelector('.uq-body')
  if (bodyEl) {
    for (const l of String(bodyEl.textContent || '').split('\n')) {
      const t = l.trim()
      if (t) return t
    }
    return ''
  }
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
  for (const el of nodesInContext()) {   // 归属 + 可见性由入口统一处理（提问浮窗只列本会话）
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

// 完整内容 tooltip（AI-031：显示在卡片左侧、垂直对齐条目中心，不再堆在上方）
function showJumpTip(item, text) {
  const tip = document.getElementById('jump-tip')
  if (!tip) return
  tip.textContent = text
  tip.classList.add('on')
  const fab = document.getElementById('jump-fab')
  if (fab) {
    const fabRect = fab.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    const vw = window.innerWidth || document.documentElement.clientWidth || 0
    const vh = window.innerHeight || document.documentElement.clientHeight || 0
    // 右缘紧贴卡片左缘 - 10，垂直对齐条目中心
    const right = Math.max(12, vw - fabRect.left + 10)
    tip.style.right = Math.round(right) + 'px'
    let top = itemRect.top + itemRect.height / 2 - tip.offsetHeight / 2
    top = Math.max(12, Math.min(top, vh - tip.offsetHeight - 12))
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
    jumpListEl.innerHTML = '<div class="jump-empty">暂无提问</div>'
    updateJumpActive()
    return
  }
  qs.forEach((el, i) => {
    const item = document.createElement('div')
    item.className = 'jump-item'
    item.dataset.idx = i
    const text = questionSnippet(el) || '（无内容）'
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

// ── 自由模式 · 多对话（2026-11 用户定调：像网页端一样的新建对话 + 会话隔离 + 归档）──
// 隔离机制不新造层：每个自由对话 = 一个独立 bookKey（__coread_free_<8hex>__，默认对话
// 沿用历史哨兵 FREE_KEY）。消息归属（bookId/bookKey）、消息区过滤（dataset.book）、
// 会意讨论栈（topic_stack[bookKey]）、LLM 会话历史（histories[bookKey]）、引用命中
// 隔离全部复用"按书隔离"这一条既有链路——切对话 = 切 key。
// 归档（对话条右侧 ⤓）：归档弹窗勾选「保存记忆 / 收口为节点加入拓扑图」→ POST
// /free-archive → agent 执行记忆合并与正式图固化，然后清栈清消息（归档即删除），
// 注册表留一条墓碑记录（产物去向）显示在对话列表的「已归档」区。
//
// 引用窗体（2026-09）：本次讨论的引用节点清单——语义命中（graph-hit）自动并入 +
// 手动从拓扑图选取（双击）；条目悬浮可取消；随消息提交（body.refs），agent 收口
// 以窗体清单为 cites 建 user 边。
// 2026-10 用户定调：窗体 = 待提交（可删）+ 锁定（栈命中并入，不可删）——
// 实时栈命中（/stack-hits，历史消息已提交的 cites）同时进图高亮（第二层）与窗体锁定条目，
// 二者同源保持一致；锁定条目只作显示，不随消息提交（agent 以 body.refs 为 cites，
// 历史 cites 已由各自消息提交过，重复提交无意义）。
let _freeRefs = []          // [{ id, point }]：待提交引用清单（手动选取 + 语义命中并入，可删）
let _stackCiteIds = []      // 锁定引用 id[]：实时栈命中（历史消息已提交的 cites），随 /stack-hits 自动更新、不可删
let _hitBook = ''           // 当前图视图命中显示的来源书（''=无）：按书隔离——切书/切换模式时清理
let _graphPointCache = null // Map(id → point)：正式图节点缓存（窗体显示 / 命中并入取 point）
async function ensureGraphPointCache() {
  if (_graphPointCache) return _graphPointCache
  const map = new Map()
  try {
    const r = await fetch(`${RECEIVER}/graph`)
    const g = await r.json()
    if (Array.isArray(g.nodes)) {
      for (const n of g.nodes) if (n && n.id) map.set(n.id, String(n.point || n.id))
    }
  } catch {}
  _graphPointCache = map
  return map
}
function pointOf(id) {
  return (_graphPointCache && _graphPointCache.get(id)) || String(id || '')
}
// 窗体全集 id（显示与图高亮共用）：待提交在前，锁定栈命中去重在后
function freeDisplayIds() {
  const pendIds = _freeRefs.map((r) => r.id)
  return [...pendIds, ..._stackCiteIds.filter((id) => !pendIds.includes(id))]
}
// 手动选取高亮同步：窗体全集（待提交 + 锁定）→ 图视图高亮其讨论脉络（横幅 +
// 隐藏/显示按钮，2026-09）。取消完待提交项后锁定命中仍高亮——窗体与图一致。
function syncPickHighlight() {
  if (!graphView) return
  graphView._cancelAutoDismiss()   // 用户手动操作：取消挂起的自动渐隐/轮播（图保持打开）
  const ids = freeDisplayIds()
  if (!ids.length) { graphView.clearHighlight(); return }
  // 图未加载（如刚打开）时 noFit：物理收敛后由 _pendingChainFit 落位，避免对未稳定
  // 的初始坐标播聚焦动画（与 applyStackHits 同一保护）
  const needLoad = !graphView.graph
  if (needLoad) graphView._pendingChainFit = true
  graphView.applyHit(ids, '', 'picked', needLoad)
}
// 加入引用（语义命中 / 手动选取共用；id 去重）
// auto=true = 语义命中自动并入（用户没点过），停止时要收回（见 dropAutoFreeRefs）
async function addFreeRef(id, point, auto = false) {
  if (!id) return
  if (_freeRefs.some((r) => r.id === id)) return
  _freeRefs.push({ id, point: point || pointOf(id), auto: !!auto })
  await ensureGraphPointCache()   // 补 point（命中并入时可能只有 id）
  const r = _freeRefs.find((x) => x.id === id)
  if (r) r.point = point || pointOf(id)
  renderFreeRefs()
}
/**
 * 收回"语义命中自动并入"的待提交引用（2026-11）。
 *
 * 为什么停止时要收：自动并入是替**这一轮提问**找的讨论线索，随消息一起作为 cites 提交。
 * 而这一轮被用户停掉了——它从没进过讨论栈，也不会被收口。那些线索留着的话，下一条提问
 * 会把它们一起提交上去（`body.refs`），等于把"被弃那一轮"的命中挂到新提问名下，
 * 收口时还会变成图的 user 边。已提交进栈的（锁定组，`_stackCiteIds`）不动。
 */
function dropAutoFreeRefs() {
  if (!_freeRefs.some((r) => r.auto)) return
  _freeRefs = _freeRefs.filter((r) => !r.auto)
  renderFreeRefs()
}
function removeFreeRef(id) {
  _freeRefs = _freeRefs.filter((r) => r.id !== id)
  renderFreeRefs()
  syncPickHighlight()   // 剩余引用重新高亮（或清空）
}
function clearFreeRefs() {
  _freeRefs = []
  _stackCiteIds = []   // 锁定命中只在自由模式会话内显示；退出时一并清空
  renderFreeRefs()
  syncPickHighlight()
}
// 栈命中并入窗体（锁定）：/stack-hits 返回当前实时栈里历史 user 消息已提交的 cites。
// 调用点：refreshStackHits（自由模式；打开图 / 收到 stack-updated / 模式切换都会走到）。
function setFreeStackCites(hits) {
  if (!_freeMode) return   // fetch 异步返回时可能已退出自由模式
  const ids = []
  for (const id of hits || []) if (id && !ids.includes(id)) ids.push(id)
  _stackCiteIds = ids
  // 已提交进栈的待提交项升为锁定（从待提交移除，避免重复提交与重复显示）
  if (ids.length) _freeRefs = _freeRefs.filter((r) => !ids.includes(r.id))
  ensureGraphPointCache()
    .then(() => { if (_freeMode) renderFreeRefs() })
    .catch(() => { if (_freeMode) renderFreeRefs() })
}
// 渲染自由模式引用窗体（仅自由模式激活时可见）。结构：
//   [锁定组]  📌 讨论命中（已提交，不可删）→ 🔒 条目（无 ✕，随栈自动更新）
//   [待提交组] #n 条目（语义命中 / 手动选取，可 ✕ 取消，随消息提交 body.refs）
function renderFreeRefs() {
  const box = document.getElementById('free-refs')
  if (!box) return
  // 记住这一次渲染之前窗体是不是藏着的：**刚切进自由模式**那一下要特殊处理
  //（显示时直接给到最新一条，见函数尾部）——藏着的元素量不出高度，那时算出来的
  // 滚动位置是没有意义的。
  const wasHidden = box.hidden
  box.hidden = !_freeMode
  const list = document.getElementById('fr-list')
  const empty = document.getElementById('fr-empty')
  if (!list || !empty) return
  const label = document.getElementById('fr-label')
  const pendIds = _freeRefs.map((r) => r.id)
  // 显示去重：同一节点既是锁定又是待提交时按待提交渲染（可取消本次重新引用）
  const locked = _stackCiteIds.filter((id) => !pendIds.includes(id))
  const total = _freeRefs.length + locked.length
  if (label) label.textContent = '🔗 本次引用' + (total ? '（' + total + '）' : '')
  // 折叠态同步（2026-11）：与读书模式「当前引用」卡片同款——折叠后表头下方留一行
  // 缩略概览（条数 + 节点名），不用展开就能看清引用了什么。两条边界：
  //   · 空清单没东西可折：按钮隐藏并强制展开，否则折叠态下只剩表头，
  //     连"暂无引用"的提示都看不见；
  //   · 清单被清空（取消/换对话/退出自由模式）时同样自动展开。
  const cbtn = document.getElementById('fr-collapse-btn')
  const cprev = document.getElementById('fr-preview')
  if (!total) box.classList.remove('collapsed')
  if (cbtn) {
    cbtn.style.display = total ? '' : 'none'
    cbtn.textContent = box.classList.contains('collapsed') ? '▸' : '▾'
  }
  if (cprev) {
    // 编号与清单一致（待提交 #1..#n），锁定命中用 🔒 前缀区分
    const names = _freeRefs.map((r, i) => `${i + 1}. ${r.point}`)
      .concat(locked.map((id) => '🔒 ' + pointOf(id)))
    const brief = names.join('　')
    // 概览首行报**两组各几条**而不报总数：总数表头已经写了，重复没意义；
    // 折叠时真正看不见的是"哪几条能取消、哪几条是锁定的"，顺带提示可点开
    const split = []
    if (_freeRefs.length) split.push('待提交 ' + _freeRefs.length)
    if (locked.length) split.push('讨论命中 ' + locked.length)
    cprev.innerHTML = names.length
      ? `<div class="frp-count">${split.join(' · ')}（点此展开）</div>` +
        `<div class="frp-items" title="${escAttr(brief)}">${esc(brief)}</div>`
      : ''
  }
  let html = ''
  if (locked.length) {
    html += '<div class="fr-locked-hd" title="实时讨论栈命中的节点（历史消息已提交的引用），随讨论自动更新，不可删除">' +
      '📌 讨论命中（已提交 · 不可删）</div>'
    for (const id of locked) {
      const point = pointOf(id)
      html += '<div class="fr-item fr-locked" title="' + esc(point) + '">' +
        '<span class="fr-idx">🔒</span>' +
        '<span class="fr-point">' + esc(point.length > 40 ? point.slice(0, 40) + '…' : point) + '</span>' +
      '</div>'
    }
  }
  html += _freeRefs.map((r, i) =>
    '<div class="fr-item" title="' + esc(r.point) + '">' +
      '<span class="fr-idx">#' + (i + 1) + '</span>' +
      '<span class="fr-point">' + esc(r.point.length > 40 ? r.point.slice(0, 40) + '…' : r.point) + '</span>' +
      '<button class="fr-x" data-idx="' + i + '" title="取消引用">✕</button>' +
    '</div>').join('')
  list.innerHTML = html
  for (const b of list.querySelectorAll('.fr-x')) {
    b.addEventListener('click', () => {
      const r = _freeRefs[Number(b.dataset.idx)]
      if (r) removeFreeRef(r.id)
    })
  }
  empty.style.display = total ? 'none' : ''
  // 新引用要能看见（2026-11 用户反馈）：限高之后清单自己会滚，而新加的条目是**追加在
  // 末尾**的 —— 不跟随的话，用户刚在会意图里双击选的那条就落在可视区外，看起来像"没选上"。
  // 规则直接用读书模式消息区那一套（AI-004 的 maybeAutoScroll）：接近底部才跟随，
  // 手动往上翻看旧引用时不被强行拽下去。与消息区同一个函数、同一条规则，两处手感一致。
  //
  // 例外：**刚切进自由模式**（藏 → 显）时无条件给到最新一条。切换模式是用户明确的
  // "我要看这个上下文"动作，与消息区切上下文就滚到底部同一条道理；而此刻清单本来就在
  // 最上面（藏着的元素没有高度，之前那次渲染算不出位置），不强制的话每次进来都要手动滚。
  if (wasHidden && !box.hidden) list.scrollTop = list.scrollHeight
  else maybeAutoScroll(list)
}
// 打开拓扑图进入选取模式（手动选取引用）：正式图 + 单击看详情/双击选取
function openPickMode() {
  if (!graphView) return
  graphView.setMode('formal')
  graphView.open()
  refreshStackHits()
  graphView.setPickMode(true)
}

// 当前自由对话的显示标题（注册表里没登记时按序号兜底："对话 N"）
function freeConvTitle(key) {
  const k = key || _freeKey
  const c = _freeConvs.find((x) => x.key === k)
  if (c && c.title) return c.title
  const i = _freeConvs.findIndex((x) => x.key === k)
  return i >= 0 ? '对话 ' + (i + 1) : '新对话'
}
function freeConvMeta(key) {
  return _freeConvs.find((x) => x.key === (key || _freeKey)) || null
}
// 拉对话清单（活动 + 已归档），并刷新对话条/列表。
// 会校正当前 key：不在活动清单里（被删/被归档/老数据对不上）就落到最近活跃的一场，
// 并整链刷新上下文——否则面板重开后头部标题/消息区会停在已失效的那场对话上。
// autoCreate 只在**最外层**调用时为真：真的空清单时补建第一场对话。递归自己时必须关掉
// ——若接收端建了对话却读不回（注册表写不进去之类的异常），否则会无限套娃。
async function loadFreeConversations({ autoCreate = true } = {}) {
  let keyChanged = false
  try {
    const r = await fetch(`${RECEIVER}/free-conversations`)
    const d = await r.json()
    _freeConvs = Array.isArray(d.active) ? d.active : []
    _freeArchived = Array.isArray(d.archived) ? d.archived : []
    if (!_freeConvs.length && autoCreate) {
      // 一条都没有：建第一场对话（默认对话由 receiver 侧补登记，这里只是兜底）。
      // 递归自己时必须关掉 autoCreate（见函数头注释）。
      const c = await createFreeConversation({ silent: true, reload: false })
      if (c) return loadFreeConversations({ autoCreate: false })
    }
    if (_freeConvs.length && !_freeConvs.some((c) => c.key === _freeKey)) {
      // 当前 key 不在活动清单里（被删/被归档/老数据对不上）：恢复到最近有说话的对话
      //（storage 里记的那场若还在用，上面的分支不会进来）
      const next = d.lastActive && _freeConvs.some((c) => c.key === d.lastActive)
        ? d.lastActive
        : (_freeConvs[0] && _freeConvs[0].key)
      if (next && next !== _freeKey) {
        _freeKey = next
        saveFreeState()
        keyChanged = true
      }
    }
  } catch {
    // 接收端未启动：清单拉不到，至少保证当前 key 可用（默认对话）
    if (!_freeConvs.length) _freeConvs = [{ key: _freeKey || FREE_KEY, title: '', messages: 0 }]
  }
  if (keyChanged && _freeMode) {
    applyBookContext({ bookId: _freeKey, bookTitle: freeConvTitle(_freeKey) })
    onEffectiveContextChange()
    renderCurrentBook()
    refreshStackHits()
  }
  renderFreeConvBar()
  renderFreeConvList()
  return _freeConvs
}

// 首条指路（2026-11 用户定调）：切到自由模式 / 新建对话 / 切到一场空对话时，消息区落
// 一条提示，把"这是一场独立对话、怎么再开一场、归档能留什么"讲清楚——光有上方对话条，
// 用户不一定意识到自由模式是多对话的。
//
// 2026-11 改版：原先这里落的是一条**灰字系统气泡**（只有文案、没有动作：讲的是现象，
// 用户读完还得自己去找"＋ 新对话"在哪），现在整条被开场卡接管——文案、引文、动作按钮
// 都在卡里，见 renderIntro。所以这几个调用点（新建 / 切换 / 进自由模式）直接调
// syncIntro，**别在这里再补一颗系统气泡**：两颗提示叠在一起，用户会以为系统在复读。

// 新建一场自由对话并切过去。reload=false 时不重拉清单（由调用方负责）——
// loadFreeConversations 的补建分支要走这条，避免两条异步链互相递归。
async function createFreeConversation({ silent = false, reload = true } = {}) {
  try {
    const r = await fetch(`${RECEIVER}/free-conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    })
    const d = await r.json()
    if (!d || !d.key) throw new Error('no key')
    if (reload) await loadFreeConversations()
    switchFreeConversation(d.key, { toast: silent ? '' : '已新建对话' })
    return d.key
  } catch {
    if (!silent) showToast('新建对话失败：CoRead 本机服务未启动', true)
    return null
  }
}

// 切换自由对话：换上下文（消息区/引用窗体/讨论栈/命中全按新 key 隔离）
async function switchFreeConversation(key, { toast = '' } = {}) {
  const next = String(key || '')
  if (!isFreeConvKey(next)) return
  const prev = _freeKey
  if (next === prev) { renderFreeConvBar(); renderFreeConvList(); return }
  _freeKey = next
  saveFreeState()
  // 旧对话的消息从 DOM 里摘掉（其余对话的消息本来就 display:none，留着只为省一次重渲染；
  // 摘掉后切回来靠 /history 重新渲染——_histKeys 已按对话隔离，不会互相吞消息）
  if (prev) removeConversationBubbles(prev)
  // 流式气泡/结束标记属于上一场对话：它可能正指向刚被摘掉的节点（切回来时下一个
  // 分片会新建气泡；已落库的内容由 loadHistory 补齐），这里一并复位
  _streamEl = null
  _streamDone = false
  finishWaiting()   // 上一场对话的"进行中"不该带到新对话上（按钮回「发送」）
  clearFreeRefs()   // 引用窗体属于上一场对话：待提交 + 锁定栈命中一并清空
  hideThinking()    // 上一场对话的"思考中"不该挂在新对话上
  onEffectiveContextChange()   // 消息过滤 / 引用卡片 / 命中高亮整链刷新
  renderCurrentBook()
  renderFreeConvBar()
  renderFreeConvList()
  refreshStackHits()   // 新对话的实时栈命中（"讨论命中"锁定条目）
  loadHistory()        // 把新对话的历史消息渲染出来（幂等：已渲染的按 _histKeys 跳过）
  syncIntro()      // 切到一场还没说过话的对话 → 补回开场卡（loadHistory 里也会兜一次）
  renderNoBookView()
  scrollMsgsToBottom()
  if (toast) showToast(toast)
}

// 摘掉某场对话的消息气泡（切对话用）。只摘该 key 的，别的对话不动。
function removeConversationBubbles(key) {
  // all:true —— 摘的正是"已不是当前对话"的那批（当前 key 刚被切掉），
  // 走默认过滤会一条都拿不到，气泡就永远留在 DOM 里跟着下一次切换串场。
  for (const el of nodesInContext({ all: true })) {
    if ((el.dataset.book || '') === key) el.remove()
  }
}

// 渲染自由对话条（切到自由模式的那一刻就出现，见 toggleFreeMode）。
// 三样东西一眼可见：当前对话（点击开列表）、＋ 新对话（实心绿的主按钮）、⤓ 归档；
// 另外两处提示多对话存在且可用：徽标显示对话总数、空对话时提示行点出"开新话题"。
function renderFreeConvBar() {
  const bar = document.getElementById('free-conv-bar')
  if (!bar) return
  bar.hidden = !_freeMode
  if (!_freeMode) return
  const titleEl = document.getElementById('fc-title')
  const countEl = document.getElementById('fc-count')
  const hintEl = document.getElementById('fc-hint')
  const cur = document.getElementById('fc-cur')
  const total = _freeConvs.length
  const meta = freeConvMeta(_freeKey)
  const title = freeConvTitle(_freeKey)
  const msgs = meta ? (meta.messages || 0) : 0
  if (titleEl) titleEl.textContent = title
  // 对话总数徽标：只有一场时也显示（"1"本身就在说"这是一场对话，可以再有第二场"）
  if (countEl) {
    countEl.hidden = !total
    countEl.textContent = total ? String(total) : ''
    countEl.title = total ? `自由模式共有 ${total} 场对话（点左侧标题切换）` : ''
  }
  if (cur) {
    cur.title = `当前自由对话：${title}（${msgs ? msgs + ' 条消息' : '暂无消息'}）` +
      (total > 1 ? `\n自由模式共 ${total} 场对话，点击切换或新建` : '\n点击切换 / 新建对话')
  }
  if (hintEl) {
    // 空对话（刚进入自由模式 / 刚新建）时给一句指路：说点什么，或另开一场
    const show = msgs === 0
    hintEl.hidden = !show
    hintEl.textContent = show
      ? (total > 1
        ? '这是本场对话的独立上下文，与其他对话互不影响。直接提问即可，或点击「＋ 新对话」另开一场。'
        : '自由模式下可创建多场互不影响的对话。直接提问即可。')
      : ''
  }
}

function renderFreeConvList() {
  const overlay = document.getElementById('free-conv-overlay')
  if (!overlay) return
  const list = document.getElementById('fcv-list')
  const empty = document.getElementById('fcv-empty')
  if (!list) return
  const fmtTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  }
  list.innerHTML = ''
  for (const c of _freeConvs) {
    const item = document.createElement('div')
    item.className = 'fcv-item' + (c.key === _freeKey ? ' cur' : '')
    const bits = [c.messages ? c.messages + ' 条消息' : '暂无消息']
    if (c.lastAt) bits.push('最近 ' + fmtTime(c.lastAt))
    item.innerHTML =
      `<div class="fci-main">` +
        `<div class="fci-title">${esc(c.title || '新对话')}</div>` +
        `<div class="fci-meta">${esc(bits.join(' · '))}</div>` +
      `</div>` +
      (c.key === _freeKey ? '<span class="fci-badge">当前</span>' : '') +
      `<button class="fci-act" data-act="rename" title="重命名本对话">✎</button>` +
      `<button class="fci-act" data-act="archive" title="归档本对话（可保存记忆、收口进会意图）">⤓</button>` +
      `<button class="fci-act fci-del" data-act="delete" title="彻底删除本对话及其消息">🗑</button>`
    item.addEventListener('click', (e) => {
      const btn = e.target.closest('.fci-act')
      if (btn) {
        e.stopPropagation()
        if (btn.dataset.act === 'archive') openFreeArchive(c.key)
        else if (btn.dataset.act === 'rename') renameFreeConversation(c.key, c.title)
        else deleteFreeConversation(c.key, c.title)
        return
      }
      switchFreeConversation(c.key)
      closeFreeConvList()
    })
    list.appendChild(item)
  }
  if (empty) empty.hidden = _freeConvs.length > 0
  // 已归档区：墓碑记录（产物去向说明），可彻底删除
  const wrap = document.getElementById('fcv-arch-wrap')
  const archList = document.getElementById('fcv-arch-list')
  if (!wrap || !archList) return
  wrap.hidden = !_freeArchived.length
  archList.innerHTML = ''
  for (const c of _freeArchived) {
    const item = document.createElement('div')
    item.className = 'fcv-arch-item'
    const note = (c.archive && c.archive.note) || '已归档（未保存记忆、未收口）'
    item.innerHTML =
      `<div class="fca-main">` +
        `<div class="fca-title">${esc(c.title || '（无标题对话）')}</div>` +
        `<div class="fca-meta">${esc(fmtTime(c.archivedAt))}${note ? ' · ' + esc(note) : ''}</div>` +
      `</div>` +
      `<button class="fci-act fci-del" data-act="drop" title="从归档记录中删除这条">🗑</button>`
    item.querySelector('[data-act="drop"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await fetch(`${RECEIVER}/free-conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', key: c.key }),
        })
      } catch {}
      await loadFreeConversations()
    })
    archList.appendChild(item)
  }
}

function openFreeConvList() {
  const overlay = document.getElementById('free-conv-overlay')
  if (!overlay) return
  overlay.classList.add('on')
  loadFreeConversations()
  renderFreeConvList()
}
function closeFreeConvList() {
  document.getElementById('free-conv-overlay')?.classList.remove('on')
}

// 重命名自由对话（对话列表里的 ✎）：标题只用于显示与识别，不影响隔离
async function renameFreeConversation(key, current) {
  const label = current || freeConvTitle(key)
  const next = await showPrompt({
    title: '重命名对话',
    value: label,
    placeholder: '输入对话名称…',
    maxLength: 40,
  })
  if (next === null) return          // 取消
  const title = next.trim()
  if (title === (current || '')) return
  try {
    const r = await fetch(`${RECEIVER}/free-conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', key, title }),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch {
    showToast('重命名失败：CoRead 本机服务未启动', true)
    return
  }
  await loadFreeConversations()
  if (key === _freeKey) renderCurrentBook()
  showToast('已重命名为「' + (title || '新对话') + '」')
}

async function deleteFreeConversation(key, title) {
  const label = title || freeConvTitle(key)
  const ok = await showConfirm('删除自由对话', `彻底删除「${label}」及其消息？归档记录也不会保留。`)
  if (!ok) return
  try {
    await fetch(`${RECEIVER}/free-conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', key }),
    })
  } catch {
    showToast('删除失败：CoRead 本机服务未启动', true)
    return
  }
  const wasCurrent = key === _freeKey
  if (wasCurrent) removeConversationBubbles(key)
  await loadFreeConversations()
  if (wasCurrent) {
    const next = _freeConvs.length ? _freeConvs[0].key : null
    if (next) switchFreeConversation(next)
    else await createFreeConversation()
  }
  showToast('已删除对话')
}

// ── 归档（2026-11：归档 = 对话结束并删除）────────────────────────────────────
// 两个勾选项 = 这场对话的产物去向：保存记忆（profile/soul）、收口进拓扑图（正常收口程序）。
// 2026-11 用户定调：**默认两项都勾上**（归档默认就把这场对话完整走一遍正常程序），
// 但可以取消——取消是"这次先不留痕"，不是"以后都不留"。所以这里把用户**最后一次的
// 选择**记在 storage 里：第一次打开默认双勾，用户取消过哪项，下次就沿用他的选择。
const ARCHIVE_PREF_KEY = 'freeArchiveOpts'

// 读上次选择；从未选过 → 两项都勾（默认全走正常程序）
async function loadArchivePref() {
  const dflt = { memory: true, graph: true }
  try {
    const d = await chrome.storage.local.get([ARCHIVE_PREF_KEY])
    const v = d && d[ARCHIVE_PREF_KEY]
    if (v && typeof v === 'object') {
      return { memory: v.memory !== false, graph: v.graph !== false }
    }
  } catch {}
  return dflt
}
function saveArchivePref(pref) {
  try { chrome.storage.local.set({ [ARCHIVE_PREF_KEY]: { memory: !!pref.memory, graph: !!pref.graph } }) } catch {}
}

let _archiveKey = ''   // 归档弹窗当前针对的对话
async function openFreeArchive(key) {
  const k = key || _freeKey
  if (!isFreeConvKey(k)) return
  _archiveKey = k
  const overlay = document.getElementById('free-archive-overlay')
  const convEl = document.getElementById('fa-conv')
  const memEl = document.getElementById('fa-memory')
  const graphEl = document.getElementById('fa-graph')
  const okBtn = document.getElementById('fa-ok')
  if (!overlay) return
  const meta = freeConvMeta(k)
  const title = freeConvTitle(k)
  if (convEl) convEl.textContent = title + (meta ? `（${meta.messages || 0} 条消息）` : '')
  if (okBtn) okBtn.disabled = false
  closeFreeConvList()
  overlay.classList.add('on')   // 先开弹窗（不等 storage），勾选状态回读后再校正
  const pref = await loadArchivePref()
  if (memEl) memEl.checked = !!pref.memory
  if (graphEl) graphEl.checked = !!pref.graph
}
function closeFreeArchive() {
  document.getElementById('free-archive-overlay')?.classList.remove('on')
  _archiveKey = ''
}

// 执行归档：POST /free-archive → agent 侧做（记忆合并 / 收口固化 / 清栈清消息），
// 结果以 role=system 落库并经 SSE 回到侧栏（toast + 系统气泡）。
async function submitFreeArchive() {
  const key = _archiveKey
  if (!isFreeConvKey(key)) return
  const memory = !!document.getElementById('fa-memory')?.checked
  const graph = !!document.getElementById('fa-graph')?.checked
  saveArchivePref({ memory, graph })   // 记住这次的选择（下次打开沿用）
  const okBtn = document.getElementById('fa-ok')
  if (okBtn) okBtn.disabled = true
  const wasCurrent = key === _freeKey
  let queued = false
  try {
    const r = await fetch(`${RECEIVER}/free-archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, memory, graph }),
    })
    queued = r.ok
  } catch {}
  if (!queued) {
    if (okBtn) okBtn.disabled = false
    showToast('归档失败：CoRead 本机服务未启动', true)
    return
  }
  closeFreeArchive()
  // 归档要跑记忆合并 / 收口固化（要调模型，可能几十秒）：先给"处理中"反馈，
  // 完成时 agent 会推 role=system 的系统气泡 + toast。
  if (memory || graph) showToast('归档中：正在' + [memory ? '保存记忆' : '', graph ? '收口进会意图' : ''].filter(Boolean).join(' + ') + '…')
  if (wasCurrent) showThinking(key)
  // 从活动清单里立刻摘掉（agent 完成后会把消息清掉，这里先刷新列表）
  setTimeout(() => loadFreeConversations(), 600)
}

function toggleFreeMode() {
  _freeMode = !_freeMode
  // iPhone 风格滑动开关：滑块状态 / 轨道颜色 / 两侧文案高亮随模式切换
  const sw = document.getElementById('free-switch')
  if (sw) {
    sw.classList.toggle('on', _freeMode)
    sw.setAttribute('aria-checked', _freeMode ? 'true' : 'false')
    const states = sw.querySelectorAll('.ms-state')
    if (states.length === 2) {
      states[0].classList.toggle('act', !_freeMode)  // 读书
      states[1].classList.toggle('act', _freeMode)   // 自由
    }
  }
  if (_freeMode) {
    // 暂存读书模式的选中引用：进入自由模式会被当作"切书"取消选中，退出时原样恢复
    _savedReadingAnn = selectedAnn
    // 快照进入前的实时检测上下文（_currentBook）：applyBookContext(自由对话 key) 会
    // 把它覆写成自由对话，退出自由模式时靠这份快照恢复，不依赖可能陈旧/为空的
    // _lastWereadContext（手动选书期间它常常不是"进入前正在读的书"）
    _savedExitCtx = _currentBook ? { ..._currentBook } : null
    // 恢复上次所在的对话（storage）；清单异步拉到后再校正（key 失效则落到最近活跃的一场）
    _freeKey = restoreFreeKey()
    applyBookContext({ bookId: _freeKey, bookTitle: freeConvTitle(_freeKey) })
    // _freeMode 已先置位，applyBookContext 里 ctxChanged 判定失效（进出前后
    // effectiveBookBase 都是 FREE_KEY），onEffectiveContextChange 被跳过——读书模式
    // 的「当前引用」卡片残留 .on 不隐藏，与「本次引用」窗体叠成两栏（2026-10 修复）。
    // 这里与切书/手动选书一致，强制整链刷新：隐藏当前引用卡片、消息区/引用抽屉按
    // 对话 key 隔离、清掉跨上下文命中高亮并取消选中（已暂存，退出时恢复）。
    onEffectiveContextChange()
    renderFreeRefs()
    renderFreeConvBar()   // 对话条在进入自由模式的那一刻就出现（含 ＋ 新对话）
    // 开场卡立刻跟上：这一刻"场合"已经变了（读书 → 自由），不该等 loadFreeConversations
    // 那一趟网络回来才换说法。清单回来后还会再刷一次（那时候"第 N 场"才准）。
    syncIntro()
    // 进入自由模式同样要滚到底部看最新消息（2026-11 用户反馈：切过来时滚动条停在最上面）。
    // 为什么 applyBookContext 尾部那句没兜住它：_freeMode 在本函数开头就置位了，
    // 进/出前后 effectiveBookBase() 都是 FREE_KEY → 那边 ctxChanged = false →
    // scrollMsgsToBottom() 不执行（与上面显式补调 onEffectiveContextChange() 同一个原因，
    // 2026-10 只补了不隐藏「当前引用」卡片那一半，滚动这一半漏了）。
    // 位置放在 renderFreeConvBar() 之后：对话条会占掉消息区高度，等它就位再滚，
    // 落的才是真正的底部。
    scrollMsgsToBottom()
    loadFreeConversations().then(() => {
      // 清单回来后再刷一次：标题/总数徽标/开场卡都要等清单才准
      //（卡上的「这是第 N 场」「接着上一场」都取自清单）
      renderFreeConvBar()
      syncIntro()
    })
    showToast('已进入自由模式：各对话相互独立，归档时可选择保存记忆、收口进会意图')
  } else {
    // 退出自由模式：恢复到进入前的上下文。不用 applyBookContext 恢复——它带
    // 「检测到真实阅读即退出手动选书」规则，而 _lastWereadContext 只是历史快照
    //（手动选书期间常常不是"进入前正在读的书"），用它恢复会把手动选书悄悄清掉；
    // 且恢复目标与退出前有效上下文相同时（手动书 M → 自由 → M，进出前后
    // effectiveBookBase 都是 M）applyBookContext 的 ctxChanged 判定为 false，
    // 不会重刷消息过滤——消息区停留在自由模式内容上（2026-11 用户反馈）。
    // 实时阅读检测由随后的 refreshCurrentBook 重做：真的在读书才自动退手动选书。
    _currentBook = _savedExitCtx || null  // 进入自由模式前的实时检测快照
    _savedExitCtx = null
    onEffectiveContextChange()  // 无条件整链刷新：过滤切回手动书/快照书、清跨上下文命中
    renderCurrentBook()
    renderNoBookView()
    renderManualBanner()
    // 消息区由 renderNoBookView 恢复可见后滚到底部（无有效上下文时 #msgs 隐藏，跳过）
    if (effectiveBookBase()) scrollMsgsToBottom()
    // 恢复后立即向活动 tab 查询真实阅读上下文：快照是进入自由模式前的，期间可能
    // 已切书/离开阅读页，会过期（2026-09 修复）
    refreshCurrentBook()
    // 恢复进入自由模式前暂存的选中引用（引用仍在列表里才重新选中）
    if (_savedReadingAnn) {
      const found = RECENT_ANNS.find(a => sameRef(a, _savedReadingAnn))
      if (found) { selectedAnn = found; saveState() }
      _savedReadingAnn = null
    }
    renderRefUI()
    // 清除本次引用窗体与图视图已选标记（自由对话上下文独立，下次重新开始）
    clearFreeRefs()
    renderFreeConvBar()
    showToast('已退出自由模式')
  }
  // 进出自由模式都是"换了个场合"：开场卡跟着换一套说法（读书模式讲书、自由模式讲
  // 这场对话怎么独立）。放在末尾、两个分支都走，避免只在一边补而另一边留着旧卡。
  syncIntro()
  if (graphView) graphView.setMode(_freeMode ? 'free' : 'formal')
}

// ── 会意图拓扑视图（AI-020）─────────────────────────────────────────────
// 图视图（extension/graph-view.js）：Obsidian 式话题拓扑图。常态浏览（缩放/平移/
// 悬停邻接/点选详情/搜索）；SSE graph-hit 命中 → 自动弹出拓扑图并播放命中路径
// 动画（横幅即命中通知）→ 渐隐关闭；图已打开时直接高亮不自动关闭。
// 数据：GET {receiver}/graph（agent/data/knowledge-graph.json，图空时可 ?demo=1 预览；
// 自由模式激活时 ?free=1 看沙盒图）。
const graphView = typeof CoReadGraphView !== 'undefined'
  ? new CoReadGraphView.GraphView({
      receiver: RECEIVER,
      container: document.getElementById('graph-overlay'),
      // 选择模式双击节点：手动选取为引用（自由模式，2026-09）
      onPick: (node) => {
        if (!_freeMode || !node || !node.id) return
        addFreeRef(node.id, node.point || '')
        syncPickHighlight()   // 图视图立即高亮已选引用的讨论脉络（横幅 + 隐藏/显示按钮）
        graphView?.focusNodeChain(node.id)   // 新选节点所在链 → 聚焦过去（多链时）
      },
    })
  : null
const graphBtn = document.getElementById('graph-btn')
if (graphBtn && graphView) {
  graphBtn.addEventListener('click', () => {
    postSidebarDebug({ stage: 'graph-open', book: effectiveBookBase().slice(0, 16) })
    graphView.open()
    refreshStackHits()
  })
}
// ── 会意图引导：第一个知识点诞生时，带用户去看一眼（2026-10-20）──────────────
/**
 * 为什么要有它：教程 PDF 里**不讲会意图**（用户定调），但"收口 → 知识点 → 命中"
 * 是这东西跟普通 AI 聊天的分水岭。等用户自己发现，多半永远发现不了。
 *
 * 出现的时机只有一个，而且必须是真的"第一次"：**开机时图里一个点都没有，之后有了**。
 * 为什么不用"图里有节点 && 没看过"当判据：老用户图里早就有几十个点了，
 * 那样会在某次无关的更新时突然蹦出一张"你的第一个知识点出来了"，可笑且不可信。
 * 看过就写 `graphCoachSeen`，永不再现；⋯ 菜单里有「重看会意图引导」可以手动放出来。
 */
const GRAPH_COACH_KEY = 'graphCoachSeen'
let _coachShown = false
let _coachNodeId = ''
let _coachPreview = false          // true = 预览态（图里还没点，只给看样式）
let _coachPersist = false          // 关掉时要不要写"看过"标记（只有真触发才写）
let _spotMod = null                // { Spotlight, shared } —— 聚光灯模块，按需加载一次
let _spot = null                   // 复用的实例（一个页面一个就够）

/**
 * 聚光灯模块（`extension/spotlight.js`）按需加载。
 *
 * 为什么不用静态 import：sidebar.js 是**经典脚本**（它头部解释了原因），写不了 import 语句，
 * 只能动态 import()。加载失败**不能把引导带死**——所以调用方有兜底（退回内置卡片）。
 */
async function loadSpotlight() {
  if (_spot) return _spot
  if (!_spotMod) _spotMod = await import('./spotlight.js')
  _spot = _spotMod.sharedSpotlight({ dim: 0.45, padding: 6, radius: 8 })
  return _spot
}

/** 引导当前是不是"活着"（卡片或聚光灯任一个在） */
function coachActive() {
  const card = document.getElementById('coach-card')
  if (card && !card.hidden) return true
  return !!(_spot && _spot.active)
}

function hideCoachSpotlight() {
  if (_spot) { try { _spot.hide() } catch (e) {} }
}
let _nodeCountAtBoot = -1        // -1 = 还没读到（本机服务还没起来）

async function fetchGraphNodes() {
  try {
    const r = await fetch(RECEIVER + '/graph', { cache: 'no-store' })
    if (!r.ok) return null
    const g = await r.json()
    return Array.isArray(g.nodes) ? g.nodes : null
  } catch (e) { return null }
}

/** 最新的那个点（收口刚写进去的就是它）。图里没点返回 null。 */
function newestNode(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null
  return nodes.slice().sort((a, b) =>
    (Number(b.updatedAt || b.createdAt || 0)) - (Number(a.updatedAt || a.createdAt || 0)))[0] || null
}

async function coachSeen() {
  try {
    const st = await chrome.storage.local.get(GRAPH_COACH_KEY)
    return !!(st && st[GRAPH_COACH_KEY])
  } catch (e) { return false }
}

/** 开机基线：读一次"现在图里有几个点"。读不到（本机服务没起）就保持 -1，等它起来再补。 */
async function initGraphCoachBaseline() {
  if (_nodeCountAtBoot !== -1) return
  if (await coachSeen()) { _nodeCountAtBoot = 0; return }   // 看过就不必再算
  const nodes = await fetchGraphNodes()
  if (nodes) {
    _nodeCountAtBoot = nodes.length
    postSidebarDebug({ stage: 'graph-coach-baseline', nodes: nodes.length })
  }
}

/**
 * 把卡片放出来。
 * @param {{nodeId?:string, count?:number, preview?:boolean, persist?:boolean}} o
 *   preview  = "图里还没有点，只给你看样式" → 卡片里多一句黄底说明
 *   persist  = 关掉时是否写"看过"标记。**只有真正的第一次触发才写**；
 *              手动看（⋯ 菜单）不写——否则用户看一次，真正的自动引导就永久关掉了。
 */
function showCoachCard({ nodeId = '', count = 0, preview = false, persist = false } = {}) {
  const card = document.getElementById('coach-card')
  if (!card) return
  _coachNodeId = nodeId || ''
  _coachPreview = !!preview
  _coachPersist = !!persist
  card.hidden = false
  const note = card.querySelector('.cc-preview-note')
  if (note) note.hidden = !preview
  // 闪一下 ◎：卡片上说了"打开会意图"，但用户未必知道入口在哪
  const g = document.getElementById('graph-btn')
  if (g) { g.classList.add('pulse'); setTimeout(() => g.classList.remove('pulse'), 4200) }
  postSidebarDebug({
    stage: persist ? 'graph-coach-shown' : 'graph-coach-preview',
    node: String(_coachNodeId).slice(0, 24),
    nodes: count,
  })
}

/**
 * 引导的**首选**形态：聚光灯照亮右上角的 ◎，旁边挂一张卡。
 *
 * 为什么不用页面里那块常驻卡（showCoachCard）：引导的价值在于"把用户的眼睛带到那个按钮上"。
 * 常驻卡只能说明，聚光灯能把整屏压暗、只留 ◎ 亮着——这是用户点得下去的关键。
 * 卡片仍然保留，作为**兜底**（聚光灯模块加载失败时用），不是主路径。
 *
 * @returns {Promise<boolean>} 聚光灯成功起来 → true；否则 false（调用方退回卡片）
 */
async function showCoachSpotlight({ nodeId = '', persist = false } = {}) {
  let spot
  try {
    spot = await loadSpotlight()
  } catch (e) {
    postSidebarDebug({ stage: 'spotlight-load-failed', error: String((e && e.message) || e) })
    return false
  }
  if (!spot) return false
  _coachNodeId = nodeId || ''
  _coachPreview = false
  _coachPersist = !!persist
  const ok = spot.pointTo('#graph-btn', {
    step: '第一个知识点',
    title: '它收口成了一个点',
    body: ['点 ◎ 打开会意图。', '后续提问带上这个说法，即可命中。'],
    actions: [
      { id: 'open', label: '打开看看', primary: true },
      { id: 'later', label: '知道了' },
    ],
    // 单次回调（同一个实例会被不同引导复用，所以不放在实例上）
    onAction: (id) => { if (id === 'open') openGraphForCoach(); else dismissCoach() },
  })
  if (!ok) return false
  postSidebarDebug({ stage: persist ? 'graph-coach-shown' : 'graph-coach-preview', via: 'spotlight', node: String(_coachNodeId).slice(0, 24) })
  return true
}

/** 图更新了：如果"开机 0 个点，现在有了"，就是第一个知识点诞生 —— 引导一次 */
async function maybeCoachFirstNode() {
  if (_coachShown) return
  if (_nodeCountAtBoot !== 0) return          // 只认"从 0 到 1"
  if (await coachSeen()) return
  const nodes = await fetchGraphNodes()
  if (!nodes || !nodes.length) return
  _coachShown = true
  const newest = newestNode(nodes)
  const nodeId = (newest && newest.id) || ''
  // 首选聚光灯；起不来（模块加载失败等）才退回页面内那块卡
  const ok = await showCoachSpotlight({ nodeId, persist: true })
  if (!ok) showCoachCard({ nodeId, count: nodes.length, persist: true })
}

/** 等某个选择器的元素出现**并且可见**（引导要照它，得等它真的画出来） */
async function waitElVisible(sel, ms = 8000) {
  const end = Date.now() + Math.max(500, ms)
  while (Date.now() < end) {
    const el = document.querySelector(sel)
    if (el && !el.hidden && el.getBoundingClientRect().width > 0) return el
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

/**
 * **完整引导流程（三步）** —— ⋯ 菜单里的「◎ 会意图引导」走这一条。
 *
 *   第 1 步：只照亮右上角 ◎，告诉他"点这里"
 *   第 2 步：把图打开并落到那个点上，然后照亮右边的**详情面板**（这就是那个点）
 *   第 3 步：照亮图本身，讲清"换个说法再问 → 这条来路亮起来 = 节点命中"
 *
 * 为什么生产触发（第一个知识点自然诞生）**只走第 1 步**：那是在用户正聊天时弹出的，
 * 自动把整张图盖上来太打扰。想看全流程就点菜单——这就是"调试入口"的用途。
 */
async function startCoachDemo({ persist = false } = {}) {
  let spot
  try {
    spot = await loadSpotlight()
  } catch (e) {
    postSidebarDebug({ stage: 'spotlight-load-failed', error: String((e && e.message) || e) })
    const list = (await fetchGraphNodes()) || []
    const newest = newestNode(list)
    showCoachCard({ nodeId: (newest && newest.id) || '', count: list.length, preview: !newest, persist })
    return false
  }
  const list = (await fetchGraphNodes()) || []
  const newest = newestNode(list)
  _coachNodeId = (newest && newest.id) || ''
  _coachPersist = !!persist
  _coachShown = false            // 演示不占用"正式出过一次"的状态
  postSidebarDebug({ stage: 'graph-coach-demo', step: 1, nodes: list.length })

  const finish = () => {
    try { spot.hide() } catch (e) {}
    if (_coachPersist) {
      try { chrome.storage.local.set({ [GRAPH_COACH_KEY]: Date.now() }) } catch (e) {}
    }
    _coachPersist = false
  }

  const step3 = () => {
    postSidebarDebug({ stage: 'graph-coach-demo', step: 3 })
    /**
     * 这一课要讲的是"**怎么把会意图里的点用起来**"。写法顺序（2026-10-21 用户退回过三版）：
     *   ① 先讲**机制**——它每一问都会先去会意图里找旧节点，命中了就把那条来路带进这一轮。
     *      没有这一句，下面直接甩"两种问法都能命中"就是莫名其妙的结论（用户原话）。
     *   ② 再给**两种问法**（显式 / 隐式），各自一句可直接照抄的话。
     *   ③ 边界：只说"上次那事儿"（无线索空指）不认——这条是判定代码里写死的规则。
     *
     * 另外两条硬边界：
     *   · 例子不放**完整节点标题**（会让人以为要背标题）；
     *   · 例子不能是**名词**（"授权"是词，节点存的是**说法**）。
     *
     * 注意：这里**没有**"填一句试试"按钮（2026-10-21 用户删掉）。理由：那会把引导变成
     * 替他打字——我们教的是"怎么问"，不该代劳；而且填进输入框的话他大概率直接发出去，
     * 变成一条不是自己想问的话。
     */
    spot.cardOnly({
      step: '第 3 步 / 共 3 步',
      title: '先检索，再回答',
      body: [
        '每次提问，先在会意图检索旧节点；命中则并入该节点的来路。',
        '命中靠提问里的表述：',
        '> 显式：之前聊过的「授权是自下而上的」',
        '> 隐式：那套授权自下而上的体系为什么一直没有走通',
        '表述不必与节点原文一致，但须明确。',
      ],
      actions: [{ id: 'done', label: '明白了', primary: true }],
      onAction: () => finish(),
    })
  }

  const step2 = async () => {
    // 图里一个点都没有：别假装能指（引导绝不能指着空气说话）
    if (!_coachNodeId) {
      postSidebarDebug({ stage: 'graph-coach-demo', step: 2, detail: false, reason: 'no-node' })
      spot.cardOnly({
        step: '第 2 步 / 共 3 步',
        title: '图里还没有点',
        body: ['讨论充分后，自动收口为节点。'],
        actions: [{ id: 'next', label: '继续看命中', primary: true }, { id: 'done', label: '知道了' }],
        onAction: (id) => { if (id === 'next') step3(); else finish() },
      })
      return
    }
    try { openGraphForCoach() } catch (e) { finish(); return }
    // 等详情面板真的画出来（图是异步拉的，节点选中也是异步的）
    const panel = await waitElVisible('#gv-detail', 5000)
    postSidebarDebug({ stage: 'graph-coach-demo', step: 2, detail: !!panel })
    if (!panel) {
      spot.cardOnly({
        step: '第 2 步 / 共 3 步',
        title: '没定位到那个点',
        body: ['图刚生成，稍等；也可直接点该节点。'],
        actions: [{ id: 'next', label: '继续看命中', primary: true }, { id: 'done', label: '知道了' }],
        onAction: (id) => { if (id === 'next') step3(); else finish() },
      })
      return
    }
    const ok = spot.pointTo('#gv-detail', {
      step: '第 2 步 / 共 3 步',
      title: '这就是那个点',
      body: ['右侧为详情：说法与来路。'],
      actions: [{ id: 'next', label: '下一步', primary: true }, { id: 'done', label: '先看到这' }],
      placement: 'left',
      onAction: (id) => { if (id === 'next') step3(); else finish() },
    })
    if (!ok) finish()
  }

  const ok = spot.pointTo('#graph-btn', {
    step: '第 1 步 / 共 3 步',
    title: '第一个知识点出来了',
    body: ['点右上角 ◎ 打开会意图。'],
    actions: [{ id: 'next', label: '下一步', primary: true }, { id: 'done', label: '先不看' }],
    // 用户自己点了 ◎ 也算"做到"，直接进第 2 步
    dismissOnTargetClick: true,
    onTargetClick: () => step2(),
    onAction: (id) => { if (id === 'next') { try { spot.hide() } catch (e) {} step2() } else finish() },
  })
  if (!ok) finish()
  return ok
}

function dismissCoach() {
  const card = document.getElementById('coach-card')
  if (card) card.hidden = true
  const g = document.getElementById('graph-btn')
  if (g) g.classList.remove('pulse')
  hideCoachSpotlight()
  // 只有"真正的第一次"才写标记（见 showCoachCard 的 persist 说明）
  if (_coachPersist) {
    try { chrome.storage.local.set({ [GRAPH_COACH_KEY]: Date.now() }) } catch (e) {}
  }
  _coachPreview = false
  _coachPersist = false
}

function openGraphForCoach() {
  const nodeId = _coachNodeId
  dismissCoach()
  if (!graphView) return
  postSidebarDebug({ stage: 'graph-coach-open', node: String(nodeId).slice(0, 24) })
  graphView.open()
  refreshStackHits()
  /**
   * 指出那个点（2026-10-21 补）。
   *
   * 原先这里调的是 `focusNodeChain`，而它在"当前没有多链高亮"时是**空操作**——
   * 刚收口出来的第一个点打开图时没有任何命中链，所以它什么都不做。
   * 也就是说卡片上那句"这个点会被圈出来"当时是**空话**。
   * 现在用 `revealNode`：等图拉完 → selectNode（高亮来路 + 相机对准 + 打开右侧详情）。
   */
  if (nodeId) {
    graphView.revealNode(nodeId)
      .then((ok) => postSidebarDebug({ stage: 'graph-coach-reveal', node: String(nodeId).slice(0, 24), ok: !!ok }))
      .catch(() => {})
  }
}

document.getElementById('cc-open')?.addEventListener('click', openGraphForCoach)
document.getElementById('cc-later')?.addEventListener('click', dismissCoach)
document.getElementById('cc-close')?.addEventListener('click', dismissCoach)

/**
 * ── 调试入口（2026-10-20）────────────────────────────────────────────────────
 *
 * 为什么要留一个：这张卡的正式触发条件是"用户第一个知识点自然收口"——
 * 要等一场真讨论聊透，而且**只出现一次**（写 `graphCoachSeen` 之后永不再现）。
 * 没有这个入口，改样式 / 验文案 / 复现问题都要先伪造一场收口，成本太高。
 *
 * 怎么打开 console：**右键侧栏 → 检查**（或 `chrome://extensions` → CoRead →
 * 「检查视图」→ `sidebar.html`）。然后在 console 里：
 *
 *   __coreadDebug.coach.show()     放一次卡片（图里有节点就圈最新那个；没有就只给样式）
 *   __coreadDebug.coach.trigger()  走一遍**生产路径**：假装开机时是 0 个点，看它会不会触发
 *   __coreadDebug.coach.reset()    清掉"看过"标记 + 收掉卡片，让真正的第一个节点还能触发
 *   __coreadDebug.state()          这几个内部量：基线、是否已出过、要圈哪个点、当前书
 *
 * 这些动作都只动界面与本地记忆，不碰用户的图、不写任何讨论。
 */
window.__coreadDebug = {
  coach: {
    async show() {
      const list = (await fetchGraphNodes()) || []
      const newest = newestNode(list)
      showCoachCard({ nodeId: (newest && newest.id) || '', count: list.length, preview: !newest })
      return { nodes: list.length, node: (newest && newest.id) || '', preview: !newest }
    },
    async trigger() {
      _coachShown = false
      _nodeCountAtBoot = 0                       // 伪造"开机时一个点都没有"
      try { await chrome.storage.local.remove(GRAPH_COACH_KEY) } catch (e) {}
      await maybeCoachFirstNode()
      const card = document.getElementById('coach-card')
      return { shown: !!(card && !card.hidden), baseline: _nodeCountAtBoot, node: _coachNodeId }
    },
    reset() {
      try { chrome.storage.local.remove(GRAPH_COACH_KEY) } catch (e) {}
      _coachShown = false
      _coachPreview = false
      _nodeCountAtBoot = -1
      const card = document.getElementById('coach-card')
      if (card) card.hidden = true
      const g = document.getElementById('graph-btn')
      if (g) g.classList.remove('pulse')
      initGraphCoachBaseline()                   // 重新读一次基线（异步，不阻塞返回值）
      return true
    },
  },
  state() {
    return {
      baseline: _nodeCountAtBoot,          // -1 还没读到；0 图里当时是空的
      shown: _coachShown,
      preview: _coachPreview,
      nodeId: _coachNodeId,
      freeMode: _freeMode,
      book: effectiveBookBase(),
      cardHidden: !!document.getElementById('coach-card')?.hidden,
    }
  },
}


const pickBtn = document.getElementById('fr-pick-btn')
if (pickBtn) pickBtn.addEventListener('click', openPickMode)
// 本次引用窗体折叠/展开（2026-11）：表头 ▾ 切换；折叠态点概览直接展开（同 AI-018 的
// rc-preview 手感）。折叠态只存在 DOM class 上，与读书模式卡片一样不落盘。
document.getElementById('fr-collapse-btn')?.addEventListener('click', () => {
  const box = document.getElementById('free-refs')
  const btn = document.getElementById('fr-collapse-btn')
  if (!box) return
  box.classList.toggle('collapsed')
  if (btn) btn.textContent = box.classList.contains('collapsed') ? '▸' : '▾'
})
document.getElementById('fr-preview')?.addEventListener('click', () => {
  const box = document.getElementById('free-refs')
  if (!box) return
  box.classList.remove('collapsed')
  const btn = document.getElementById('fr-collapse-btn')
  if (btn) btn.textContent = '▾'
})
const freeSwitch = document.getElementById('free-switch')
if (freeSwitch) {
  freeSwitch.addEventListener('click', toggleFreeMode)
  // 初始同步：默认读书模式（关态），与 _freeMode = false 一致
  freeSwitch.classList.toggle('on', _freeMode)
  freeSwitch.setAttribute('aria-checked', _freeMode ? 'true' : 'false')
  const st = freeSwitch.querySelectorAll('.ms-state')
  if (st.length === 2) {
    st[0].classList.toggle('act', !_freeMode)
    st[1].classList.toggle('act', _freeMode)
  }
}

// ── 自由对话 UI 接线（2026-11 多对话）─────────────────────────────────────
// 对话条：点当前对话 → 对话列表（切换/归档/删除）；＋ 新建；⤓ 归档当前对话
document.getElementById('fc-cur')?.addEventListener('click', openFreeConvList)
document.getElementById('fc-new')?.addEventListener('click', () => createFreeConversation())
document.getElementById('fc-archive')?.addEventListener('click', () => openFreeArchive(_freeKey))

// 对话列表弹窗：关闭 / 遮罩点击关闭 / 新建
document.getElementById('fcv-close-btn')?.addEventListener('click', closeFreeConvList)
document.getElementById('fcv-new-btn')?.addEventListener('click', async () => { closeFreeConvList(); await createFreeConversation() })
{
  const ov = document.getElementById('free-conv-overlay')
  if (ov) {
    let downOnMask = false
    ov.addEventListener('mousedown', (e) => { downOnMask = e.target === ov })
    ov.addEventListener('mouseup', (e) => { if (downOnMask && e.target === ov) closeFreeConvList(); downOnMask = false })
  }
}

// 归档弹窗：取消 / 遮罩关闭 / 确认归档
document.getElementById('fa-cancel')?.addEventListener('click', closeFreeArchive)
document.getElementById('fa-ok')?.addEventListener('click', submitFreeArchive)
{
  const ov = document.getElementById('free-archive-overlay')
  if (ov) {
    let downOnMask = false
    ov.addEventListener('mousedown', (e) => { downOnMask = e.target === ov })
    ov.addEventListener('mouseup', (e) => { if (downOnMask && e.target === ov) closeFreeArchive(); downOnMask = false })
  }
}

// ── 头部「⋯」更多设置菜单（字号）─────────────────────────────────────
const moreBtn = document.getElementById('more-btn')
const moreMenu = document.getElementById('more-menu')
if (moreBtn && moreMenu) {
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation()  // 避免被下面的 document 点击立即关闭
    moreMenu.classList.toggle('on')
  })
  // 点击菜单外区域关闭
  document.addEventListener('click', (e) => {
    if (moreMenu.classList.contains('on') && !moreMenu.contains(e.target) && e.target.id !== 'more-btn') {
      moreMenu.classList.remove('on')
    }
  })
}

// ── 模型 API 配置（2026-10）─────────────────────────────────────────────
// 入口 = 头部「⋯」菜单的「🔑 模型 API 配置」；当前未配置 API 时打开插件自动弹出。
// 真源是 agent/api-config.json（后端 GET/POST /api-config，.env 为回退）：插件不自己
// 存一份，避免"界面显示"与"agent 实际取值"两套状态漂移。接收端没起来时**不**自动
// 弹窗——那时"未配置"是误判，连接状态交给头部指示点。
const apiOverlay = document.getElementById('api-config')

function openApiConfig() {
  if (moreMenu) moreMenu.classList.remove('on')
  if (!apiOverlay) return
  apiOverlay.classList.add('on')
  const errEl = document.getElementById('api-err')
  if (errEl) errEl.textContent = ''
}

function closeApiConfig() {
  apiOverlay?.classList.remove('on')
}

// 拉当前生效配置；接收端未响应返回 null（与"确认未配置"区分开）
async function fetchApiConfig() {
  try {
    const r = await fetch(`${RECEIVER}/api-config`)
    if (!r.ok) throw new Error('bad status')
    const cfg = await r.json()
    return cfg && typeof cfg === 'object' ? cfg : null
  } catch { return null }
}

function fillApiForm(cfg) {
  const base = document.getElementById('api-base')
  const key = document.getElementById('api-key')
  const model = document.getElementById('api-model')
  if (base) base.value = cfg.apiBase || ''
  if (key) key.value = cfg.apiKey || ''
  if (model) model.value = cfg.model || ''
}

// ── 预设地址 / 模型（2026-10-21）──────────────────────────────────────────────
// 候选值写在 sidebar.html 的两条 <datalist> 里，联动逻辑在 extension/api-presets.js
// （单独文件，理由见那边的注释）。这里只做转发：
//   · 预设是加速项，不是必需项 —— 那个文件没加载成功就退化为"不补默认值、不联动"，
//     弹窗照常能开、能存（否则一个可选文件会把整个配置入口带塌）。
const apiPresets = window.CoreadApiPresets || null
apiPresets?.install()          // 地址 ↔ 模型联动（接线在 api-presets.js 里，只有一处）
function applyApiPresetDefaults() { apiPresets?.applyDefaults() }

// 菜单项状态文案：已配置=绿（带模型名）/ 未配置=灰 / 接收端未连=灰
function renderApiStatus(cfg) {
  const desc = document.getElementById('mm-api-desc')
  if (!desc) return
  if (!cfg) { desc.textContent = '本机服务未连接'; desc.classList.remove('ok'); return }
  if (cfg.configured) { desc.textContent = '已配置 · ' + (cfg.model || ''); desc.classList.add('ok'); return }
  desc.textContent = '未配置，点这里填写'
  desc.classList.remove('ok')
}

async function refreshApiStatus() {
  renderApiStatus(await fetchApiConfig())
}

// 打开配置弹窗：firstRun = 未配置时的引导态（多一行说明）
function showApiConfigModal(cfg, firstRun) {
  if (cfg) fillApiForm(cfg)
  applyApiPresetDefaults()   // 空着的字段补预设（已有值一律不动）
  const first = document.getElementById('api-first')
  if (first) first.hidden = !firstRun
  const src = document.getElementById('api-src')
  if (src) src.hidden = !(cfg && cfg.source === 'env')
  openApiConfig()
}

// 打开插件时检查一次：确认"未配置"才自动弹窗，并把已填的部分配置预填进输入框
async function checkApiConfigOnOpen() {
  const cfg = await fetchApiConfig()
  renderApiStatus(cfg)
  if (cfg && !cfg.configured) showApiConfigModal(cfg, true)
}

async function saveApiConfig() {
  const btn = document.getElementById('api-save-btn')
  const errEl = document.getElementById('api-err')
  const payload = {
    apiBase: (document.getElementById('api-base')?.value || '').trim(),
    apiKey: (document.getElementById('api-key')?.value || '').trim(),
    model: (document.getElementById('api-model')?.value || '').trim(),
  }
  const fail = (msg) => { if (errEl) errEl.textContent = msg }
  fail('')
  // 前端只拦"空值"，URL 合法性等以后端校验为准（单一真源在 lib/api-config.js）
  if (!payload.apiBase || !payload.apiKey || !payload.model) {
    fail('请填写 API 地址、API Key 和模型名')
    return
  }
  if (btn) btn.disabled = true
  try {
    const r = await fetch(`${RECEIVER}/api-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json().catch(() => null)
    if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || '保存失败')
    renderApiStatus({ configured: true, model: d.model || payload.model })
    closeApiConfig()
    showToast('模型 API 已保存，下次提问即生效')
  } catch (e) {
    const msg = (e && e.message) ? e.message : '保存失败'
    fail(/fetch|network/i.test(msg) ? 'CoRead 本机服务未连接，保存失败。请先启动 CoRead。' : msg)
  } finally {
    if (btn) btn.disabled = false
  }
}

document.getElementById('mm-api-config')?.addEventListener('click', async () => {
  if (moreMenu) moreMenu.classList.remove('on')
  const cfg = await fetchApiConfig()
  showApiConfigModal(cfg, false)
  if (!cfg) {
    const errEl = document.getElementById('api-err')
    if (errEl) errEl.textContent = 'CoRead 本机服务未连接，无法读取或保存配置。请先启动 CoRead。'
  }
})
document.getElementById('api-save-btn')?.addEventListener('click', saveApiConfig)
document.getElementById('api-cancel-btn')?.addEventListener('click', closeApiConfig)
document.getElementById('api-close-btn')?.addEventListener('click', closeApiConfig)
bindMaskClose(apiOverlay, closeApiConfig)
// 三个输入框回车即保存（Esc 关闭）
for (const id of ['api-base', 'api-key', 'api-model']) {
  document.getElementById(id)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveApiConfig() }
    else if (e.key === 'Escape') closeApiConfig()
  })
}
// 地址 ↔ 模型互相对齐由 api-presets.js 的 install() 接线（见上面那几行），这里不再重复绑。

// 「没有 API Key？去 DeepSeek 申请」：新标签页打开，侧栏停在原地不跳走。
// 地址从 <a href> 里取 —— 页面上写的那一个就是唯一真源，这里不再存一份副本。
document.getElementById('api-key-help')?.addEventListener('click', (e) => {
  e.preventDefault()
  const url = e.currentTarget.href
  if (!url) return
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url, active: true }).catch(() => window.open(url, '_blank', 'noopener'))
  } else {
    window.open(url, '_blank', 'noopener')   // 自测页（没有 chrome.tabs）走这条
  }
})

// ── 无书默认界面 / 已读书籍的事件绑定（2026-10；2026-11 改版）──────────────
// 无书界面已无「从已读书籍中选择」按钮：书单直接列在那里（renderNoBookList），
// 搜索框只在书多时出现，输入即过滤
document.getElementById('nb-search')?.addEventListener('input', renderNoBookList)

/**
 * PDF 阅读器入口（2026-11 从工具箱提上来）。
 *
 * 两个入口共用它：
 *   · 「⋯」菜单的 📕 PDF 阅读器（`#mm-reader`）
 *   · 无书界面状态卡上的按钮（`#nb-reader-btn`）——给"手上只有一份 PDF、
 *     微信读书里没有这本书"的人一条明确的出路
 *
 * 两个都传 `pick: true`（= 落地后自动拉起选文件框），因为从这两处点进来的人
 * 手里**已经有文件了**，让他再自己找一次「打开 PDF」是白要一步。
 * 走 `?pick=1` 而不是发消息：阅读器可能还没开，消息没有收件人（与 `?open=` 同一个理由）。
 */
function openReaderFrom(where) {
  if (moreMenu) moreMenu.classList.remove('on')
  try {
    openReader({ pick: true })
  } catch (e) {
    showToast('打不开阅读器：' + String((e && e.message) || e))
  }
  postSidebarDebug({ stage: 'open-reader', where })
}

document.getElementById('mm-reader')?.addEventListener('click', () => openReaderFrom('menu'))
document.getElementById('nb-reader-btn')?.addEventListener('click', () => openReaderFrom('no-book'))

document.getElementById('mm-pick-book')?.addEventListener('click', () => {
  if (moreMenu) moreMenu.classList.remove('on')
  openBookPicker()
})
document.getElementById('mm-exit-manual')?.addEventListener('click', () => {
  if (moreMenu) moreMenu.classList.remove('on')
  exitManualBook()
})
// 自检（2026-11）：开一个新标签页跑自检。它要读写 chrome.* 与各模块，
// 只能在扩展自己的页面里跑，所以是"开页面"而不是"就地跑"。
document.getElementById('mm-selfcheck')?.addEventListener('click', () => {
  if (moreMenu) moreMenu.classList.remove('on')
  chrome.tabs.create({ url: chrome.runtime.getURL('selfcheck.html') }).catch((e) => {
    showToast('打不开自检页：' + String((e && e.message) || e))
  })
})
// 会意图引导（2026-10-20；2026-10-21 改成完整三步）：正式出现只有一次，错过了就没有入口了。
// 这里点一下就走**完整流程**（照 ◎ → 打开图落到那个点 → 讲命中），见 startCoachDemo。
// 不写"看过"标记，点多少次都不影响以后自动出现。
document.getElementById('mm-graph-coach')?.addEventListener('click', async () => {
  if (moreMenu) moreMenu.classList.remove('on')
  await startCoachDemo({ persist: false })
})
document.getElementById('mb-switch-btn')?.addEventListener('click', openBookPicker)
document.getElementById('mb-exit-btn')?.addEventListener('click', exitManualBook)
document.getElementById('bp-close-btn')?.addEventListener('click', closeBookPicker)
bindMaskClose(document.getElementById('book-picker'), closeBookPicker)  // 点击遮罩关闭（按+松都在遮罩上才算）
document.getElementById('bp-search')?.addEventListener('input', renderBookList)

/**
 * 侧栏每次打开就上报自己的**构建指纹**（2026-11）。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────────────────
 * 用户报过两次"还是不行"，而真相是**他机器上跑的还是旧代码**：
 * 扩展要手动重新加载才生效，但没有任何地方能一眼看出"当前跑的是哪一版"。
 * 于是每一轮都变成"我改 → 他试 → 呈现旧行为 → 我再猜"，白烧两轮。
 *
 * 修复办法不是让用户更小心，而是**让版本变成可观测的**：打开侧栏就往日志里写一串文件指纹，
 * 与仓库里的源文件一比就知道差在哪几个文件上（算法与 extension/selfcheck.js 的
 * fingerprint() 一致，都是 SHA-256 前 6 字节）。
 */
async function reportBuildStamp() {
  const files = [
    'sidebar.js', 'sidebar.html', 'translate-background.js', 'service_worker.js',
    'reader.js', 'graph-view.js', 'api-presets.js',
  ]
  const out = {}
  for (const f of files) {
    try {
      const buf = await (await fetch(chrome.runtime.getURL(f))).arrayBuffer()
      const d = await crypto.subtle.digest('SHA-256', buf)
      out[f] = [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch (e) { out[f] = 'ERR' }
  }
  postSidebarDebug({ stage: 'build-stamp', files: out })
}

// 启动后查询当前阅读书籍（AI-001）：覆盖「切书后重开侧栏」的场景。
// applyPendingRefSearch 放在 loadHistory 之后：引用列表就绪后再打开抽屉搜索，
// 否则搜索框填了词但列表还是空的（AI-011）。
checkApiConfigOnOpen()  // 打开插件即检查模型 API：确认未配置就自动弹出配置弹窗（用户定调）
startPingLoop()         // 存活轮询：驱动连接指示灯 + 决定能不能发送（见 setDot 上方说明）
reportBuildStamp()      // 上报构建指纹：一眼看出当前跑的是哪一版（见函数注释）
initGraphCoachBaseline() // 记下"图里现在有几个点"：第一个知识点诞生时要用它判"从 0 到 1"
loadState()
  .then(loadHistory)
  .then(applyPendingRefSearch)
  .then(connect)
  .then(() => refreshCurrentBook())
  .then(() => {
    renderNoBookView()
    renderManualBanner()
    // 初始化加载完对话后滚到底部：loadHistory 历史回放期间 maybeAutoScroll 只在
    // 接近底部时跟随，长对话会停在最上方；此前靠 refreshCurrentBook 的上下文切换
    // 触发滚动，但手动选书恢复等「上下文未变化」场景不会触发。初始化是明确的
    // 「打开对话」动作，直接滚到最新消息（横幅渲染后再滚，避免其高度挤压错位）。
    const msgs = document.getElementById('msgs')
    if (msgs) msgs.scrollTop = msgs.scrollHeight
    // 启动链跑到这里，上下文（当前书 / 当前自由对话）终于定了，开场卡要按**定下来的**
    // 上下文画。前面几处 renderNoBookView 可能跑在 /history 还没回来、refreshCurrentBook
    // 还没答复的时候，那时 _histLoaded 还是假、书也还没认出来，卡被有意压着不发。
    // loadHistory 里已经调过一次，这里是兜底（幂等）。
    syncIntro()
  })
  /**
   * ⚠️ **这条链断在哪一步，都不许把 SSE 一起带走**（2026-10-20 用户实测：接收端明明
   * 在跑，指示灯一直是灰的）。
   *
   * 指示灯要绿，得同时满足"问得出去"（/ping 轮询，它在链外，一直正常）和"答得回来"
   * （SSE `/events` 连着）。而 SSE 原先**只挂在这条 promise 链的第三步**：
   * `loadState → loadHistory → applyPendingRefSearch → connect`。
   * 链上任何一步 reject（历史拉取失败、引用恢复抛错…），`connect()` 就**永远不跑**，
   * 而链尾也没有 catch —— 于是面板安静地停在"灯是灰的、但轮询是通的"这个状态：
   * 用户在界面上看到的正是"接收端明明在跑、插件却显示灰的"。
   *
   * 现在：链上失败只记一条日志；`connect()` 另外**无条件**调一次（它内部幂等：
   * `if (sseConn) return`），链跑完再补一次。SSE 不再依赖历史加载成功。
   */
  .catch((e) => postSidebarDebug({ stage: 'init-chain-failed', error: String((e && e.message) || e) }))
connect()               // 事件流单独起，不等历史（幂等）
loadJumpBack()  // AI-006：面板重开后恢复「↩ 返回」能力（有未过期的跳转记录时）

// 活动 tab 变化时刷新当前书（AI-001）：用户在多本书 / 多个微信读书 tab 间切换
try {
  chrome.tabs.onActivated.addListener(function () { refreshCurrentBook(); refreshWebBindEntry() })
  /**
   * 阅读器标签页**被关掉**时，撤掉"阅读器报着书"那道防线（2026-11）。
   *
   * 为什么必须撤：那道防线是黏性的（见 rememberReaderBook），它挡住的是"误清空"；
   * 但如果阅读器已经关了、它还原样留着，侧栏就会一直认着那本不在的书，
   * 并且**拒绝**回到无书界面——把一种坏换成另一种坏。关掉标签页就是"这本书没了"
   * 的确定信号，此时解除防线、重新算一次当前书。
   */
  chrome.tabs.onRemoved.addListener(function () {
    setTimeout(function () {
      chrome.tabs.query({ url: chrome.runtime.getURL('reader.html') + '*' })
        .then(function (list) {
          if (!list || !list.length) { rememberReaderBook(false); refreshCurrentBook() }
        })
        .catch(function () {})
    }, 400)
  })
  // 同一 tab 内导航（文库章节间跳转）也刷新网页绑定入口
  chrome.tabs.onUpdated.addListener(function (tabId, info) {
    if (info.url || info.status === 'complete') refreshWebBindEntry()
    /**
     * 活动标签页**加载完成**时重算一次当前书（2026-11 二次改版）。
     *
     * 为什么需要：切到一个还在加载（或刚被浏览器丢弃、正在恢复）的阅读器标签页时，
     * 它一时答不上来 —— 侧栏按"保持上一次已知的书"处理（这条必须保留，见
     * refreshCurrentBook 的注释），于是那几秒里显示的是**另一个标签页里**那本书的会话。
     * 页面加载完就是"它答得上来了"的信号，这里补一次重算。
     *
     * 只看活动标签页：别的标签页加载完跟"用户在看什么"无关。
     */
    if (info.status === 'complete') {
      activeTabId().then(function (id) {
        if (id !== null && id === tabId) refreshCurrentBook()
      }).catch(function () {})
    }
  })
} catch {}

// AI-021：『绑定当前网页页面到书…』按钮 —— 唤起页面上的绑定对话框
document.getElementById('nb-bind-btn')?.addEventListener('click', async () => {
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = tabs && tabs[0]
  } catch (e) {}
  if (!tab || !tab.id) return
  let ok = false
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { action: 'coreadOpenBindDialog' }, { frameId: 0 }).catch(() => null)
    if (r && r.ok) ok = true
  } catch (e) {}
  if (!ok) {
    try {
      const resps = await chrome.tabs.sendMessage(tab.id, { action: 'coreadOpenBindDialog' })
      const arr = Array.isArray(resps) ? resps : []
      ok = arr.some(function (x) { return x && x.ok })
    } catch (e) {}
  }
  if (!ok) showToast('无法打开绑定窗口，请刷新页面后重试', true)
})

// AI-021：绑定/解除后（页面或其它上下文写入 miaBindings）刷新入口
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes || !changes.miaBindings) return
    refreshWebBindEntry()
    /**
     * 绑定状态变了，**当前书也要跟着重算**。
     *
     * 只在绑定的那一瞬发 `coreadManualBook` 是不够的：页面上的「解除绑定」不会发那条消息，
     * 侧栏就会一直挂着刚解除的书；反过来，别的标签页/旧会话写入绑定时侧栏也可能还停在无书界面。
     * `refreshCurrentBook` 对文库页会问页面自己（kind='page'），已绑定认书、解除后回无书，
     * 正好把两头都收口。写 `miaBindings` 不会触发它再写绑定，不存在自环。
     */
    refreshCurrentBook().catch(function () {})
  })
} catch {}

// ── 工具箱（入口：头部「⋯」菜单；当前只有「翻译」一页）────────────────────────
// 模型配置默认全部用 CoRead 的（agent/api-config.json，经 receiver 读取）。工具箱里另有
// 三个可选的按字段覆盖：填了就用填的，留空的仍用 CoRead 的。
// 存储键与 translate-protocol.js 的 STORE_KEYS 保持一致。
//
// ⚠️ 2026-11：工具箱的「阅读器」页**已删除**，PDF 阅读器改挂「⋯」菜单顶层（#mm-reader，
// 见下面 openReader / openReaderFrom）。所以这里只认 'translate' 一个 tab。
// 原文案「工具箱就是 PDF 阅读器与翻译的入口」已随之下线——它现在只讲对了一半。
const TR_KEYS = {
  enabled: 'stEnabled',
  apiBase: 'stApiBaseOverride',
  apiKey: 'stApiKeyOverride',
  model: 'stModelOverride',
  legacyModel: 'stVisionModel',   // 旧键：早期只能覆盖模型，读到就迁移过来
}
const toolbox = document.getElementById('toolbox')
let trStatus = null   // 最近一次 getTranslateStatus 的结果，按钮处理函数要用里面的 origin

function sendTranslate(message) {
  return chrome.runtime.sendMessage(message).catch(function (e) {
    return { ok: false, error: { message: String(e && e.message ? e.message : e) } }
  })
}

function trSetErr(msg) {
  const el = document.getElementById('tr-err')
  if (el) el.textContent = msg || ''
}

function trErrorText(resp, fallback) {
  const err = resp && resp.error
  if (!err) return fallback
  return (err.code ? '[' + err.code + '] ' : '') + (err.message || fallback)
}

async function refreshTranslateStatus() {
  const resp = await sendTranslate({ action: 'getTranslateStatus' })
  const st = resp && resp.ok ? resp.status : null
  trStatus = st
  const baseEl = document.getElementById('tr-base-model')
  const endpointEl = document.getElementById('tr-endpoint')
  const warn = document.getElementById('tr-grant-warn')
  const originEl = document.getElementById('tr-origin')
  if (baseEl) {
    if (!st) baseEl.textContent = '读取失败'
    else if (!st.configured) baseEl.textContent = '未配置'
    else baseEl.textContent = (st.model || '（未填模型）') + (st.usingOverride ? '（自定义）' : '')
  }
  // 实际会去打的那个地址（含覆盖项生效后的结果）。报 NETWORK 时先看这一行：
  // 它若是空的或不合法的（没有 https://），就不是授权问题，是地址问题。
  if (endpointEl) {
    if (!st) endpointEl.textContent = '读取失败'
    else if (!st.apiBase) endpointEl.textContent = '未配置'
    else endpointEl.textContent = st.apiBase
    endpointEl.title = endpointEl.textContent
  }
  renderEnableSwitch(!st || st.enabled !== false)
  if (warn) warn.hidden = !(st && st.configured && st.origin && !st.granted)
  if (originEl) originEl.textContent = (st && st.origin) || ''
  refreshRecordCount()
  return st
}

/** 本页译文记录条数：贴回 / 清除两个入口据此显示与置灰。 */
function refreshRecordCount() {
  const total = trStatus ? (trStatus.recordTotal || 0) : 0
  const countEl = document.getElementById('tr-record-count')
  const restoreBtn = document.getElementById('tr-restore-btn')
  const clearBtn = document.getElementById('tr-clear-btn')
  if (countEl) countEl.textContent = total ? '（' + total + '）' : ''
  if (restoreBtn) restoreBtn.disabled = !total
  if (clearBtn) clearBtn.disabled = !total
  renderTranslateDiag(trStatus && trStatus.lastDiag)
}

/**
 * 最近一次翻译的诊断：锚点拿到没有、文字落在哪个 frame。
 * 数据来自扩展本地存储，不依赖 receiver —— 排查时不用重启任何进程。
 */
function renderTranslateDiag(diag) {
  const el = document.getElementById('tr-diag')
  if (!el) return
  if (!diag) {
    el.hidden = true
    el.textContent = ''
    el.title = ''
    return
  }
  const frames = Array.isArray(diag.frames) ? diag.frames : []
  const hit = frames.filter((f) => f && f.has).length
  const when = diag.at ? new Date(diag.at).toLocaleTimeString() : ''
  const parts = [
    '最近一次翻译' + (when ? ' ' + when : ''),
    '定位锚点' + (diag.anchored ? '已获取' : '未获取（' + (diag.anchorReason || '原因未知') + '）'),
  ]
  if (diag.pageW) parts.push('选区 ' + diag.pageW + '×' + diag.pageH)
  if (typeof diag.chain === 'number') parts.push('滚动容器层级 ' + diag.chain)
  if (diag.canvasAnchor) {
    parts.push('画布锚点已获取' + (diag.canvasChanged ? '（画布重绘，位置为近似值）' : '（仅缩放，位置精确）'))
  } else if (diag.canvasInfo) {
    parts.push('画布尺寸 ' + diag.canvasInfo.intrinsic)
  }
  if (frames.length) parts.push('内嵌框架命中 ' + hit + '/' + frames.length)
  el.hidden = false
  el.textContent = parts.join(' · ')
  el.title = JSON.stringify(diag, null, 1)
}

// ── 启用开关 ──────────────────────────────────────────────────────────────────
// 关掉后：两个快捷键与这里的两个按钮都停用（后台还会再挡一次，见 translate-background.js
// 的 requireEnabled）。「测试连接」不受影响，关着也能验证配置。
function renderEnableSwitch(on) {
  const sw = document.getElementById('tr-enable')
  if (sw) {
    sw.classList.toggle('on', on)
    sw.setAttribute('aria-checked', on ? 'true' : 'false')
  }
  document.getElementById('tr-enable-on')?.classList.toggle('act', on)
  document.getElementById('tr-enable-off')?.classList.toggle('act', !on)
  for (const id of ['tr-region-btn', 'tr-selection-btn']) {
    const btn = document.getElementById(id)
    if (btn) btn.disabled = !on
  }
}

async function setTranslateEnabled(on) {
  try { await chrome.storage.local.set({ [TR_KEYS.enabled]: on }) } catch (e) {}
  renderEnableSwitch(on)
  showToast(on ? '翻译已启用' : '翻译已禁用，快捷键不再响应')
}

// ── 自定义模型配置（三项可选覆盖）─────────────────────────────────────────────
const TR_OVERRIDE_FIELDS = [
  ['tr-api-base', TR_KEYS.apiBase],
  ['tr-api-key', TR_KEYS.apiKey],
  ['tr-model', TR_KEYS.model],
]

async function loadTranslateSettings() {
  let store = {}
  try { store = await chrome.storage.local.get([TR_KEYS.enabled, TR_KEYS.apiBase, TR_KEYS.apiKey, TR_KEYS.model, TR_KEYS.legacyModel]) } catch (e) {}
  renderEnableSwitch(store[TR_KEYS.enabled] !== false)
  // 旧键只在没有新键时兜底，让早期填过的「视觉模型」不丢
  const modelValue = store[TR_KEYS.model] || store[TR_KEYS.legacyModel] || ''
  const values = { 'tr-api-base': store[TR_KEYS.apiBase] || '', 'tr-api-key': store[TR_KEYS.apiKey] || '', 'tr-model': modelValue }
  for (const [id] of TR_OVERRIDE_FIELDS) {
    const el = document.getElementById(id)
    // 正在输入的框不要被覆盖
    if (el && document.activeElement !== el) el.value = values[id] || ''
  }
}

async function saveTranslateOverride(id, key) {
  const el = document.getElementById(id)
  if (!el) return
  try {
    await chrome.storage.local.set({ [key]: el.value.trim() })
    if (key === TR_KEYS.model) await chrome.storage.local.remove(TR_KEYS.legacyModel)
  } catch (e) {}
  showToast('模型配置已保存')
  refreshTranslateStatus()
}

/** 快捷键按 chrome.commands 的实际绑定显示：改过键、或与别的扩展冲突时这里会露出真相。 */
async function refreshShortcutLabels() {
  let cmds = []
  try { cmds = await chrome.commands.getAll() } catch (e) {}
  const pick = (name) => {
    const c = cmds.find((x) => x.name === name)
    return c && c.shortcut ? c.shortcut : '未设置'
  }
  const region = document.getElementById('tr-key-region')
  const selection = document.getElementById('tr-key-selection')
  if (region) region.textContent = pick('translate-region')
  if (selection) selection.textContent = pick('translate-selection')
}

// 打开工具箱并切到指定 tab。tab 切换是通用的：按钮的 data-tab 与页面的 data-page 同名即可，
// 以后加工具只要在 sidebar.html 里加一个按钮 + 一个 .tb-page，这里不用改。
function openToolbox(tab) {
  if (moreMenu) moreMenu.classList.remove('on')
  if (!toolbox) return
  if (tab) selectToolboxTab(tab)
  toolbox.classList.add('on')
  trSetErr('')
  loadTranslateSettings()
  refreshShortcutLabels()
  refreshTranslateStatus()
}

function closeToolbox() {
  if (toolbox) toolbox.classList.remove('on')
}

function selectToolboxTab(name) {
  const tabs = document.querySelectorAll('#tb-tabs .tb-tab')
  const pages = document.querySelectorAll('#toolbox .tb-page')
  for (const t of tabs) t.classList.toggle('on', t.dataset.tab === name)
  for (const p of pages) p.hidden = p.dataset.page !== name
}

// 面板上的两个动作按钮：先确认已配置且已授权，再发起翻译。
// chrome.permissions.request 必须在用户手势里调用，所以 origin 提前存在 trStatus 里，
// 点击时第一个 await 就是它（中间不夹别的异步调用，避免用户手势过期）。
async function runTranslateAction(action, label) {
  trSetErr('')
  if (!trStatus) await refreshTranslateStatus()
  const st = trStatus
  if (!st) { trSetErr('无法读取翻译状态，请重试'); return }
  if (st.enabled === false) { trSetErr('翻译已禁用，请先启用上方开关'); return }
  if (!st.configured) { trSetErr('尚未配置模型 API，请在「模型 API 配置」中填写地址与 Key'); return }
  if (st.origin && !st.granted) {
    let granted = false
    try { granted = await chrome.permissions.request({ origins: [st.origin] }) } catch (e) {}
    if (!granted) {
      trSetErr('尚未授权访问 ' + st.origin + '，翻译请求将被浏览器拦截')
      refreshTranslateStatus()
      return
    }
  }
  const out = await sendTranslate({ action })
  if (out && out.ok) { closeToolbox(); return }
  trSetErr(trErrorText(out, label))
  refreshTranslateStatus()
}

document.getElementById('mm-toolbox')?.addEventListener('click', function () { openToolbox('translate') })
document.getElementById('tb-close-btn')?.addEventListener('click', closeToolbox)
bindMaskClose(toolbox, closeToolbox)
document.getElementById('tb-tabs')?.addEventListener('click', function (e) {
  const tab = e.target.closest('.tb-tab')
  if (tab && tab.dataset.tab) selectToolboxTab(tab.dataset.tab)
})

/**
 * 阅读器：扩展自己的页面，不是注入到网站里的脚本，所以直接开一个标签页即可。
 * 侧栏太窄，长时间阅读还是在标签页里舒服。
 *
 * @param {{pick?: boolean}} [opts] `pick` = 打开后自动拉起"选 PDF 文件"那个系统窗口。
 *   只有**用户点了明确要读 PDF 的入口**（菜单 / 无书界面）才传它；从别处（比如
 *   「去读」某一本）不传 —— 那里用户要的是"接着读上次那本"，弹选择框是打扰。
 */
function openReader(opts) {
  const url = chrome.runtime.getURL('reader.html') + (opts && opts.pick ? '?pick=1' : '')
  chrome.tabs.create({ url, active: true })
  closeToolbox()
}

/**
 * 译文面板里点了「删除引用」→ 走侧栏自己那条删除流程（deleteRef）。
 *
 * 面板传来的是**它画面上下划线对应的那条引用**（selectedText 是引用身份；
 * bookId / bookmarkId / 章节位置用于精确匹配，见 refreshRefs 的映射）。
 * 这里必须先在本地的 RECENT_ANNS 里找到同一条 —— deleteRef 要的是带 bookmarkId
 * 等字段的完整记录，只拿一个 selectedText 无法区分"同一段文字的两次引用"。
 *
 * @param {{selectedText?:string, bookId?:string, bookmarkId?:string}} ref
 * @returns {Promise<boolean>} 真的删掉了才 true（用户取消 → false，面板不会动下划线）
 */
async function deleteRefFromNotes(ref) {
  const want = String((ref && ref.selectedText) || '').trim()
  if (!want) return false

  /**
   * 三级匹配，从精确到宽松：
   *   ① refMatches：bookmarkId 或 章节位置——能区分同文不同处
   *   ② 书 + 原文（sameRef）：bookId 在两边都做过 baseBookId 归一化
   *   ③ 只比原文：面板那份快照可能没带 bookId（老快照 / 接收端没给）
   * 前两级都要求书对得上；只有第三级才退化成"全书范围找同文"。
   */
  const byId = ref && ref.bookmarkId
    ? RECENT_ANNS.find((a) => refMatches(a, ref))
    : null
  const hit = byId
    || RECENT_ANNS.find((a) => sameRef(a, { bookId: (ref && ref.bookId) || '', selectedText: want }))
    || RECENT_ANNS.find((a) => String(a.selectedText || '').trim() === want)
  if (!hit) {
    // 常见成因：面板里那份清单比侧栏新/旧（刚删过、或接收端还没同步）。
    // 如实说，不假装删成功——假装的话下划线会消失但引用还在。
    showToast('侧栏里已没有这条引用（可能已被删除）', true)
    return false
  }

  const gone = await deleteRef(hit)
  if (!gone) return false

  /**
   * 通知阅读器这件事现在统一在 `deleteRef()` 里做（2026-11）：
   * 卡片 / 抽屉 / 译文面板三条删除路径都走它，只在这里再发一遍会重复。
   * 面板这边拿到 true 就够了——它据此收起动作条、抹掉卡片里的下划线。
   */
  return true
}

// ── 译文对照（阅读器翻过的段落）──────────────────────────────────────────────
// 面板挂在本侧栏里（reader-notes.js 渲染），阅读器通过后台中继同步条目过来。
let notesPanel = null

// 译文对照面板：**菜单里的入口已删**（2026-11 用户定调）。它现在只有两个来源：
//   ① 阅读器顶栏的「译文」→ 经后台广播 notesOpen 到这里（openNotes）
//   ② 划词翻译完成时阅读器自己 requestNotesOpen
// 所以下面不再有 mm-notes 的点击绑定——别再加回菜单项，两个入口两套说法只会让人猜。
function openNotes() {
  const box = document.getElementById('reader-notes')
  if (!box) return
  if (!notesPanel && window.CoReadNotes) {
    notesPanel = window.CoReadNotes.mount(document.getElementById('rn-body'), {
      send: (msg) => chrome.runtime.sendMessage(msg),
      onClose: closeNotes,
      toast: (t, err) => showToast(t, err),
      // 点译文里那道"已引用"的下划线 → 动作条上的「删除引用」走这里（见 deleteRefFromNotes）
      onDeleteRef: deleteRefFromNotes,
    })
    // 打开时先拉一次当前快照（阅读器可能已经翻过几段了）
    chrome.runtime.sendMessage({ action: 'readerGet' })
      .then((r) => { if (r && r.snapshot) notesPanel.update(r.snapshot) })
      .catch(() => {})
  }
  box.classList.add('on')
  // 面板收着时可能已经收到"书页上点了某条译文"（滚动要等看得见才量得出位置，
  // 见 reader-notes.js 的 pendingJump / onShown）。显示出来以后补上这一跳。
  if (notesPanel && notesPanel.onShown) notesPanel.onShown()
}

function closeNotes() {
  document.getElementById('reader-notes')?.classList.remove('on')
}

// 阅读器那边翻译完 / 双击空白处，都会经后台广播过来
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.action) return
  if (msg.action === 'readerUpdate') {
    if (notesPanel && msg.snapshot) notesPanel.update(msg.snapshot)
    // 2026-11：换书（打开/切换/关掉 PDF）时阅读器会把 notify 置真 —— 那是"把侧栏切到
    // 这本书"的可靠信号，直接用，不再反过来问"哪个 tab 是活动的"。
    // 翻页 / 新译文这类同步不带 notify：不打扰用户当前翻看的书。
    //
    // ⚠️ 2026-11 二次改版：**只认从活动标签页推上来的那一份**（后台随附 `fromActive`）。
    // 为什么必须过滤：阅读器页面**加载时**会自己打开 URL 里指定的那本书并推一份 notify，
    // 而扩展重载 / 浏览器恢复会话时，几个后台阅读器标签页会同时加载、各推一份 ——
    // 采纳它们等于让"用户根本没在看的标签页"改掉侧栏的当前书，与"侧栏只跟随活动标签页"
    // 直接冲突。`fromActive` 判不出来（null/undefined）时**照旧采纳**：
    // 宁可放过一份可疑的快照，也不要把"我问不出来"变成"侧栏不跟了"。
    if (msg.snapshot && msg.snapshot.notify) {
      if (msg.fromActive === false) {
        postSidebarDebug({
          stage: 'reader-push-ignored',
          book: String((msg.snapshot.book && msg.snapshot.book.bookId) || '(无书)').slice(0, 20),
          why: '这份快照不是活动标签页推上来的（后台挂着的阅读器不许改当前书）',
        })
      } else {
        applyReaderBookFromSnapshot(msg.snapshot)
      }
    }
    return
  }
  if (msg.action === 'notesOpen') { openNotes(); return }
  if (msg.action === 'notesClose') { closeNotes(); return }
})
document.getElementById('tr-region-btn')?.addEventListener('click', function () {
  runTranslateAction('startSelection', '框选翻译失败')
})
document.getElementById('tr-selection-btn')?.addEventListener('click', function () {
  runTranslateAction('translateSelection', '划词翻译失败')
})

document.getElementById('tr-enable')?.addEventListener('click', function () {
  setTranslateEnabled(!this.classList.contains('on'))
})

for (const [id, key] of TR_OVERRIDE_FIELDS) {
  const el = document.getElementById(id)
  el?.addEventListener('change', function () { saveTranslateOverride(id, key) })
  el?.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); this.blur() }   // blur 触发 change
    else if (e.key === 'Escape') closeToolbox()
  })
}

document.getElementById('tr-shortcuts-btn')?.addEventListener('click', function () {
  try { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }
  catch (e) { showToast('请在 chrome://extensions/shortcuts 中修改快捷键', true) }
})

document.getElementById('tr-grant-btn')?.addEventListener('click', async function () {
  trSetErr('')
  const st = trStatus || await refreshTranslateStatus()
  if (!st || !st.origin) { trSetErr('无法读取模型地址，请先在「模型 API 配置」中填写'); return }
  let granted = false
  try { granted = await chrome.permissions.request({ origins: [st.origin] }) } catch (e) {}
  if (!granted) { trSetErr('尚未授权访问 ' + st.origin); return }
  showToast('已授权访问 ' + st.origin)
  refreshTranslateStatus()
})

document.getElementById('tr-test-btn')?.addEventListener('click', async function () {
  trSetErr('正在测试连接…')
  const resp = await sendTranslate({ action: 'testConnection' })
  if (resp && resp.ok) {
    trSetErr('')
    showToast('连接正常，模型回复：' + String(resp.text || '').replace(/\s+/g, ' ').slice(0, 20))
  } else {
    trSetErr(trErrorText(resp, '连接测试失败'))
  }
})

document.getElementById('tr-api-cfg-btn')?.addEventListener('click', async function () {
  closeToolbox()
  const cfg = await fetchApiConfig()
  showApiConfigModal(cfg, false)
})

// 把本页已记录的译文贴回页面：按记录里的页面坐标还原气泡，滚回原处即可看到
document.getElementById('tr-restore-btn')?.addEventListener('click', async function () {
  trSetErr('')
  const resp = await sendTranslate({ action: 'restoreTranslations' })
  if (resp && resp.ok) {
    showToast('已贴回 ' + (resp.shown || 0) + ' 条译文')
    closeToolbox()
    return
  }
  trSetErr(trErrorText(resp, '贴回失败'))
})

// 清除本页记录，并顺手关掉页面上还开着的译文气泡
document.getElementById('tr-clear-btn')?.addEventListener('click', async function () {
  trSetErr('')
  const resp = await sendTranslate({ action: 'clearTranslations' })
  if (resp && resp.ok) {
    showToast('已清除本页 ' + (resp.removed || 0) + ' 条记录')
    refreshTranslateStatus()
    return
  }
  trSetErr(trErrorText(resp, '清除失败'))
})
