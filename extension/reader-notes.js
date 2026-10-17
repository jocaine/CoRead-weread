/**
 * 译文对照面板（自包含组件）
 *
 * 位置：挂在 CoRead 侧栏里（不再占用阅读器页面的一栏 —— 那样开着侧栏就是两栏并排）。
 * 自包含：样式自己注入，只依赖传入的两个回调（send / onClose），
 * 所以它也能被 .selftest/notes.html 独立加载来测。
 *
 * 与阅读器的通信都经后台中继：
 *   本组件 → send({action:'readerCommand', type, id, text?})
 *   阅读器 → send({action:'readerSync', snapshot}) → 后台广播 → 本组件 update()
 *
 * ── 划选共读（2026-11）──────────────────────────────────────────────────────
 * 扫描件的框选翻译整页之后，用户想讨论的常常只是其中一句——而那一页没有可划的词
 * （图片页没有文字层）。所以译文里的文字可以直接划选：
 *   · 选中 → 浮出一个**深色小工具条**（.rn-tip，与阅读器划词浮标 .rd-tip 同一套视觉）
 *   · 点「设为引用」→ 走后台既有的 setTranslationRef（不新增通道），只把这一段设成引用
 *   · 设成之后 → **收起本面板**，回到侧栏的问答界面（引用卡就在那儿，接着就能提问）
 *   · 已被设成引用的那一段 → 卡片里画一道**下划线**（与阅读器标原文同一个机制：
 *     CSS Custom Highlight，不改 DOM）
 */
;(function () {
  'use strict'

  const STYLE_ID = 'coread-notes-style'

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
.rn-wrap { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rn-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--line, #dfe3e8); font-weight: 600; flex: none; }
.rn-spacer { flex: 1; }
.rn-muted { color: var(--muted, #6b7280); font-weight: 400; font-size: 12px; }
.rn-book { padding: 6px 12px; font-size: 12px; color: var(--muted, #6b7280);
  border-bottom: 1px solid var(--line, #eef1f4); flex: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-list { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.rn-item { border: 1px solid var(--line, #dfe3e8); border-radius: 8px; padding: 8px 10px; background: #fff; }
.rn-item.is-active { border-color: #f0c070; background: #fffaf0; }
.rn-item.is-error { border-color: #e8b4b4; }
.rn-src { color: var(--muted, #6b7280); line-height: 1.5; max-height: 4.6em; overflow: hidden;
  cursor: pointer; border-left: 2px solid #d8e6dd; padding-left: 8px; margin-bottom: 6px; }
.rn-src:hover { color: #23262b; }
.rn-src.is-open { max-height: none; }
.rn-dst { line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.rn-pending { color: var(--muted, #6b7280); }
.rn-err { color: #9a3b3b; }
.rn-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
.rn-acts button { border: 1px solid var(--line, #dfe3e8); background: #fff; color: #3c4148;
  font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.rn-acts button:hover { background: #f2f4f7; }
.rn-acts button.rn-ref { border-color: #a8dcc0; color: #07883f; background: #f2fbf6; }
/* 改原文（2026-11 重做）：编辑器**就地**替换原文预览那一块。
   旧版是往卡片底部再追加一个文本框，于是同一段文字出现两次、卡片还会往上长。
   层次按视觉规格来：主操作实心、取消描边、键盘提示最弱（11px 灰）。 */
.rn-item.is-editing { border-color: #bfe3cc; background: #fbfefc; }
/* 编辑态里，操作行下面紧跟的是**当前译文**（还没被替换掉的那一版）：
   加一道很轻的分隔线，让人看出"上面是在改的原文、下面是将被替换的译文"。 */
.rn-item.is-editing .rn-dst { margin-top: 8px; padding-top: 8px; border-top: 1px solid #eef1f4; }
.rn-edit { border-left: 2px solid #a8dcc0; padding-left: 8px; }
.rn-edit-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.rn-edit-label { font-size: 12px; font-weight: 600; color: #0a7d43; }
.rn-edit-hint { font-size: 11px; color: #888; }
.rn-edit textarea {
  display: block; width: 100%; box-sizing: border-box;
  min-height: 64px; max-height: 40vh;
  font: inherit; font-size: 13px; line-height: 1.7; color: #222;
  border: 1px solid #d0d0d0; border-radius: 8px; padding: 6px 8px;
  background: #fff; resize: vertical;
}
.rn-edit textarea:focus { outline: none; border-color: #0a7d43; box-shadow: 0 0 0 3px rgba(10, 125, 67, .18); }
.rn-edit-acts { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.rn-edit-keys { margin-right: auto; font-size: 11px; color: #aaa; }
.rn-edit-acts button {
  font: inherit; font-size: 12px; line-height: 1.2; padding: 4px 12px;
  border-radius: 8px; cursor: pointer; border: 1px solid transparent;
  background: transparent; color: #555;
  transition: background 120ms cubic-bezier(.4, 0, .2, 1), border-color 120ms, color 120ms;
}
.rn-edit-acts button.rn-primary { background: #07c160; border-color: #07c160; color: #fff; font-weight: 600; }
.rn-edit-acts button.rn-primary:hover { background: #06ad56; border-color: #06ad56; }
.rn-edit-acts button.rn-ghost { border-color: #e5e5e5; background: #fff; }
.rn-edit-acts button.rn-ghost:hover { background: #f2f4f7; }
.rn-edit-acts button[disabled] { opacity: .55; cursor: default; }
@media (prefers-reduced-motion: reduce) { .rn-edit-acts button { transition: none; } }
.rn-empty { padding: 16px; color: var(--muted, #6b7280); line-height: 1.8; }
.rn-empty kbd { border: 1px solid var(--line, #dfe3e8); border-bottom-width: 2px; border-radius: 4px;
  padding: 0 4px; background: #fafbfc; font-family: inherit; }

/* 选中译文之后浮出来的小工具条（2026-11 用户定调：不要卡片底下那个常驻按钮，
   要"选中才出现"的浮动工具条）。视觉与**阅读器里划词的浮标 .rd-tip 同一套**：
   深色底 + 白字 + 圆角，让人一眼认出"这是划词以后的动作条"，而不是卡片的一部分。 */
.rn-tip {
  position: fixed;
  z-index: 2000;          /* 压在 #reader-notes(1200) 之上：工具条属于"浮在最上面"那一层 */
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: #23262b;
  border-radius: 8px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, .28);
}
.rn-tip[hidden] { display: none !important; }
.rn-tip button {
  border: 0;
  background: transparent;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.rn-tip button:hover { background: rgba(255, 255, 255, .16); }

/* 点已引用的那一段浮出的动作条（2026-11 用户定调：要像微信阅读那样"点划线就能删"）。
   视觉与划选工具条同一套（深色底），所以直接复用 .rn-tip 的规则，只多一个类名区分用途。

   「删除引用」为什么用 #ff9b90 而不是规格里的 --co-danger #e74c3c：
   这层是深色底 #23262b，实测 --co-danger 在上面只有约 3.7:1，低于 12px 正文要求的 4.5；
   #ff9b90 约 7.5:1，够用。规格里那套 token 是给浅色面板底算的，深色浮层要单独取值。 */
.rn-tip-ref button.rn-tip-del { color: #ff9b90; }
.rn-tip-ref button.rn-tip-del:hover { background: rgba(231, 76, 60, .22); }

/* 「这一段已经设成引用了」的下划线（2026-11 用户要求）。
   用 CSS Custom Highlight 画：与阅读器标原文**同一个机制**（reader.js 的
   refreshHighlights 也是它），卡片文字一个节点都不动 —— 插 <u> 会打乱文字节点、
   连带影响选区恢复（restoreSelection 靠文本节点算偏移）。
   样式跟阅读器那边保持一致：都是"这里有一层标记"，不抢正文。 */
::highlight(rn-ref) {
  background-color: rgba(122, 205, 150, .22);
  text-decoration: underline;
  text-decoration-color: rgba(10, 125, 67, .75);
  text-decoration-thickness: 2px;
}
`
    document.head.appendChild(s)
  }

  /**
   * 已引用的段落，在卡片里画一道下划线。
   *
   * 为什么用 CSS Custom Highlight 而不是往 DOM 里插 `<u>`：与阅读器标原文**同一个
   * 机制**（reader.js 的 refreshHighlights 也是它）。好处是卡片文字一个节点都不动 ——
   * 插标签会打乱文字节点、连带影响选区恢复（restoreSelection 靠文本节点算偏移），
   * 而选区恢复正是"划了一半、对面翻页"时必须保住的。
   *
   * 按什么找位置（引用的身份是**原文**，显示的可能是摘录）：
   *   · 文字条目 → 引用的原文对上条目的 source，再画引用**显示**的那半边
   *   · 图片条目 → 没有原文可对，直接拿显示的那半边在译文里找
   * 对不上就不画：宁可不画，不可画错地方。
   */
  const MARK_NAME = 'rn-ref'

  function markQuotes(anns, bookId) {
    const HL = window.Highlight
    if (!HL || !window.CSS || !CSS.highlights) return { ranges: 0, pairs: 0, matched: 0, marks: [] }
    const norm = (s) => String(s || '').replace(/\s+/g, '')
    const all = Array.isArray(anns) ? anns : []
    const list = all.filter(
      // 只画**当前这本书**的引用：侧栏存着所有书的引用，不过滤会把别的书的下划线
      // 画到这本书的译文上（两本书译文撞句子时尤其明显）。
      // 两边都用 indexOf 互相包含判断：调用方给的可能是完整 bookId，也可能是它的
      // 前缀（两处归一化口径不同），前缀匹配两个方向都成立。
      (a) => a && a.selectedText && (!bookId || String(a.bookId || '').indexOf(bookId) === 0
        || bookId.indexOf(String(a.bookId || '')) === 0),
    )
    const ranges = []
    const marks = []     // [{ range, ann }]：点击命中时要靠它反查"这是哪一条引用"
    let pairs = 0        // 数据对上了、但文字在卡片里定位失败的次数（排查用）
    for (const dst of document.querySelectorAll('#rn-body .rn-dst')) {
      const box = dst.closest('.rn-item')
      const entry = (box && box.__entry) || null
      const shown = String(dst.textContent || '')
      if (!entry || !shown) continue
      for (const a of list) {
        let needle = ''
        if (entry.kind === 'image') {
          needle = String(a.translation || a.selectedText || '')
        } else if (norm(a.selectedText) === norm(entry.source)) {
          needle = String(a.translation || a.selectedText || '')
        }
        if (!needle.trim()) continue
        const hit = nearestRange(dst, needle, shown)
        if (hit) { ranges.push(hit); marks.push({ range: hit, ann: a }) }
        else pairs++
      }
    }
    if (ranges.length) CSS.highlights.set(MARK_NAME, new HL(...ranges))
    else CSS.highlights.delete(MARK_NAME)
    return { ranges: ranges.length, pairs, matched: list.length, total: all.length, marks }
  }

  /**
   * 在 box 里给 needle 找一个 Range。
   *
   * 先精确找；找不到就退一步按**前 12 字**找 —— 现实里差的往往是行尾断词的一个空格
   * （pdf.js 抽出来的文字与译文里回填的空格未必完全一致）。
   * 跨文本节点也能命中：把节点的文字接起来定位，再把偏移映射回 (节点, 偏移)。
   */
  function nearestRange(box, needle, shown) {
    const want = String(needle).trim()
    let at = shown.indexOf(want)
    let len = want.length
    if (at < 0) {
      const head = want.slice(0, 12).trim()
      if (head.length < 3) return null
      at = shown.indexOf(head)
      if (at < 0) return null
      len = head.length
    }
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    const nodes = []
    let n
    while ((n = walk.nextNode())) nodes.push(n)
    const pos = (offset) => {
      let acc = 0
      for (const nd of nodes) {
        const l = (nd.nodeValue || '').length
        if (offset <= acc + l) return { node: nd, off: offset - acc }
        acc += l
      }
      return null
    }
    const a = pos(at)
    const b = pos(at + len)
    if (!a || !b) return null
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(b.node, b.off)
    return r
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true } catch (e) {}
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (e) { return false }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

  /**
   * 挂载。
   * @param {HTMLElement} root 容器
   * @param {{send:(msg:object)=>Promise<any>, onClose?:()=>void, toast?:(t:string,err?:boolean)=>void}} opts
   */
  function mount(root, opts) {
    injectStyle()
    const send = opts.send
    const toast = opts.toast || (() => {})
    let snapshot = { book: null, entries: [], activeId: '', page: 0, total: 0 }
    let editingId = ''

    root.classList.add('rn-wrap')
    root.replaceChildren()

    const head = el('div', 'rn-head')
    const title = el('span', null, '译文对照')
    const spacer = el('span', 'rn-spacer')
    const count = el('span', 'rn-muted', '0 条')
    const clearBtn = el('button', 'rn-muted', '清空')
    clearBtn.type = 'button'
    clearBtn.style.cssText = 'border:1px solid var(--line,#dfe3e8);background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit;font-size:12px'
    clearBtn.addEventListener('click', () => send({ action: 'readerCommand', type: 'clear' }))
    const closeBtn = el('button', 'rn-muted', '← 返回')
    closeBtn.type = 'button'
    closeBtn.title = '返回共读标注'
    closeBtn.style.cssText = 'border:0;background:transparent;cursor:pointer;font:inherit;padding:2px 6px'
    closeBtn.addEventListener('click', () => opts.onClose && opts.onClose())
    head.append(title, spacer, count, clearBtn, closeBtn)

    const bookLine = el('div', 'rn-book', '')
    const list = el('div', 'rn-list')
    const empty = el('div', 'rn-empty')
    empty.append(
      el('div', null, '划选一段原文按 Alt+T 翻译；扫描件用阅读器工具栏的「框选翻译」。'),
      el('div', null, '译文会显示在这里，并贴回原文位置。'),
      el('div', null, '想只讨论其中一句？在译文里划出那一句，点浮出来的「设为引用」。'),
    )
    root.append(head, bookLine, list, empty)

    /**
     * 浮动工具条：**选中才出现**，挂在面板根节点上、position: fixed。
     * 为什么挂根节点而不是卡片里：跟着视口走，滚动列表时不会把它留在原地
     *（挂在卡片里会被滚动带走，用户看到的是"工具条飘在半空"）。
     */
    const tip = el('div', 'rn-tip')
    tip.hidden = true
    const tipRef = el('button', null, '设为引用')
    tipRef.type = 'button'
    const tipCopy = el('button', null, '复制')
    tipCopy.type = 'button'
    tip.append(tipRef, tipCopy)
    // 按住工具条时别让浏览器把选区清掉（默认 mousedown 会取消选区）
    tip.addEventListener('mousedown', (ev) => ev.preventDefault())
    root.append(tip)

    /**
     * 点"已引用的那一段"浮出的动作条。
     *
     * 与上面那条划选工具条**不是同一个东西**，所以是两个元素：一个出现在"选中文字时"，
     * 一个出现在"点的位置正好在某道划线上时"。合成一个会让状态互相打架
     *（选中文字时又检测到划线，该显示哪一套？）。
     */
    const refTip = el('div', 'rn-tip rn-tip-ref')
    refTip.hidden = true
    const tipDel = el('button', 'rn-tip-del', '删除引用')
    tipDel.type = 'button'
    const tipCopyRef = el('button', null, '复制')
    tipCopyRef.type = 'button'
    refTip.append(tipDel, tipCopyRef)
    // 按住动作条时别让浏览器把选区清掉（与划选工具条同理）
    refTip.addEventListener('mousedown', (ev) => ev.preventDefault())
    root.append(refTip)

    /** 当前动作条针对的那一条引用（点开时赋值，action 里用） */
    let activeRef = null
    /** 划线的 Range 与它对应的引用（每次 markRefs 重建） */
    let refMarks = []

    function hideRefTip() {
      refTip.hidden = true
      activeRef = null
    }

    /**
     * 译文里的划选状态。
     *
     * 为什么要记它：一重排（翻页、新译文到达都会 render）整个列表会被重建，
     * 选区一没工具条就没了 —— 而"划了半句、这时对面又翻了一页"是常态。
     * 所以渲染前先存、渲染后按存的原文把选区**重新画回去**。
     */
    let sel = { id: '', text: '' }

    /** 清掉选区与工具条（设完引用、切面板时用）。 */
    function clearSelection() {
      sel = { id: '', text: '' }
      const s = window.getSelection && window.getSelection()
      if (s && s.removeAllRanges) s.removeAllRanges()
      tip.hidden = true
    }

    /** 只收起工具条、**保留选区**（列表重排时用：选区还要画回去）。 */
    function hideTip() { tip.hidden = true }

    /**
     * 用户此刻选中的是不是**某张卡的译文**？是就回报 {id, text}。
     *
     * 只认译文（.rn-dst）里的选区：划原文那半边不给工具条 —— 那条路该走阅读器
     * 页面上的划词（原文在书页里有文字层，锚点、跳回原文都齐），从卡片里划原文
     * 反而会得到一条"没有锚点"的引用，比不提供更坏。
     */
    function selectionInList() {
      const s = window.getSelection && window.getSelection()
      if (!s || s.isCollapsed || !s.rangeCount) return null
      const text = String(s.toString() || '').trim()
      if (!text) return null
      const range = s.getRangeAt(0)
      const node = range.commonAncestorContainer
      const host = (node.nodeType === 1 ? node : node.parentElement)
      if (!host || !host.closest) return null
      const dst = host.closest('.rn-dst')
      const item = host.closest('.rn-item')
      if (!dst || !item || !list.contains(item)) return null
      return { id: item.dataset.id || '', text, rect: range.getBoundingClientRect() }
    }

    /**
     * 把某个工具条摆到 rect 上方（上方放不下就摆到下方）。
     * 两条工具条共用这一份：位置算法只该有一处，否则迟早一条对一条错。
     */
    function placeTipAt(node, rect) {
      node.hidden = false
      // 先显形再量尺寸（hidden 时 offsetWidth 恒为 0，量出来会把位置算错）
      const w = node.offsetWidth || 150
      const h = node.offsetHeight || 30
      let left = rect.left + rect.width / 2 - w / 2
      let top = rect.top - h - 8
      if (top < 8) top = rect.bottom + 8
      left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
      node.style.left = left + 'px'
      node.style.top = top + 'px'
    }

    /**
     * 把划选工具条摆到选区上方（上方放不下就摆到下方）。
     *
     * 工具条上不再显示选中文字（2026-11 用户定调：只要两个按钮）。要确认"引哪一句"
     * 就把它挂在按钮的 title 上 —— 悬停能看到，但不会让工具条随句子长短变形。
     */
    function showTipAt(rect, text) {
      tipRef.title = '把选中的这一段设为当前引用：' + text
      placeTipAt(tip, rect)
    }

    /**
     * 屏幕坐标 → 文字位置（collapsed Range）。
     * caretRangeFromPoint 是 Chrome/Safari 的实现，caretPositionFromPoint 是标准名，
     * 两个都试：本项目只跑 Chrome，但自测页与将来换内核时不会白屏。
     */
    function caretPointAt(x, y) {
      try {
        if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y)
      } catch (e) {}
      try {
        if (document.caretPositionFromPoint) {
          const p = document.caretPositionFromPoint(x, y)
          if (p && p.offsetNode) {
            const r = document.createRange()
            r.setStart(p.offsetNode, p.offset)
            r.collapse(true)
            return r
          }
        }
      } catch (e) {}
      return null
    }

    /**
     * 被点中的那一行的矩形（动作条要落在它正上方）。
     *
     * 为什么不能直接用 caret 的矩形：caret 是**零宽**的一条线，拿它居中算出来的 left
     * 是负数，会被夹到视口最左边 —— 动作条就飘到跟这句话无关的地方去了。
     * 一道划线可能跨好几行，Range.getClientRects() 会给出每一行一块，取包含点击点的那块。
     */
    function lineRectOf(mark, caret, x, y) {
      try {
        const rects = mark.range.getClientRects ? [...mark.range.getClientRects()] : []
        const hit = rects.find((r) => y >= r.top - 1 && y <= r.bottom + 1 && x >= r.left - 1 && x <= r.right + 1)
        if (hit) return hit
        // 点在线框边缘时会落空：取纵向最近的一行，总比飘走好
        let best = null
        let bestD = Infinity
        for (const r of rects) {
          const d = Math.abs((r.top + r.bottom) / 2 - y)
          if (d < bestD) { bestD = d; best = r }
        }
        if (best) return best
      } catch (e) {}
      try {
        const r = caret && caret.getBoundingClientRect()
        if (r && (r.width || r.height)) return r
      } catch (e) {}
      return { left: x, top: y, width: 0, height: 0, bottom: y }
    }

    /** 这个坐标落在哪一道"已引用"的划线上？没有就 null。 */
    function markAtPoint(x, y) {
      const caret = caretPointAt(x, y)
      if (!caret) return null
      for (const m of refMarks) {
        try {
          // comparePoint 返回 0 = 这个点在 Range 范围内（含首尾）
          if (m.range.comparePoint(caret.startContainer, caret.startOffset) === 0) return m
        } catch (e) {}
      }
      return null
    }

    /**
     * 把已经设成引用的段落标出来（卡片里一道下划线）。
     *
     * 数据从快照来（reader.js 的 notesSnapshot 带 refs），不做本地记账：
     * 本地记账会在"面板重开 / 侧栏被回收重建"之后全丢，而那时引用还在 ——
     * 于是下划线与引用卡不一致（用户看到的是"有的有、有的没有"）。
     */
    function markRefs() {
      const book = snapshot.book || {}
      const r = markQuotes(snapshot.refs || [], String(book.bookId || ''))
      refMarks = r.marks || []
      // 给自测/排查看的三个数：画了几道、数据对上但文字没定位到几次、手里有几条引用
      root.dataset.refMarks = String(r.ranges)
      root.dataset.refPairs = String(r.pairs)
      root.dataset.refAnn = String(r.matched) + '/' + String(r.total)
    }

    /** 把选区重新画回那张卡的译文里（按存下来的文字找位置；找不到就不画）。 */
    function restoreSelection() {
      if (!sel.id || !sel.text) return
      const item = list.querySelector('.rn-item[data-id="' + sel.id + '"]')
      const dst = item && item.querySelector('.rn-dst')
      if (!dst) { sel = { id: '', text: '' }; return }
      const walk = document.createTreeWalker(dst, NodeFilter.SHOW_TEXT)
      const nodes = []
      let n
      while ((n = walk.nextNode())) nodes.push(n)
      const full = nodes.map((x) => x.nodeValue || '').join('')
      const at = full.indexOf(sel.text)
      if (at < 0) { sel = { id: '', text: '' }; return }
      const pos = (offset) => {
        let acc = 0
        for (const nd of nodes) {
          const l = (nd.nodeValue || '').length
          if (offset <= acc + l) return { node: nd, off: offset - acc }
          acc += l
        }
        const last = nodes[nodes.length - 1]
        return last ? { node: last, off: (last.nodeValue || '').length } : null
      }
      const a = pos(at)
      const b = pos(at + sel.text.length)
      if (!a || !b) return
      try {
        const r = document.createRange()
        r.setStart(a.node, a.off)
        r.setEnd(b.node, b.off)
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(r)
        const rect = r.getBoundingClientRect()
        if (rect && (rect.width || rect.height)) showTipAt(rect, sel.text)
      } catch (e) { sel = { id: '', text: '' } }
    }

    /** 监听选区变化：在译文里划了字就浮出工具条，划走了就收起来。 */
    function onSelectionChange() {
      const hit = selectionInList()
      if (!hit) {
        sel = { id: '', text: '' }
        hideTip()
        return
      }
      sel = hit
      if (hit.rect && (hit.rect.width || hit.rect.height)) showTipAt(hit.rect, hit.text)
    }
    document.addEventListener('selectionchange', onSelectionChange)

    /**
     * 设一条引用（划选那一段 / 或整卡），两条路共用。
     *
     * 成功之后做两件事：
     *   ① 清选区与工具条（这一段已经引了，工具条没有存在意义）
     *   ② **收起本面板回到问答界面**（2026-11 用户定调）——面板是侧栏上的整屏覆盖层，
     *      不收起的话用户设完引用还停在译文列表里，得自己点「← 返回」才看得到引用卡，
     *      而下一步动作（就着这句提问）恰恰在那边。
     */
    async function makeReference(id, quote) {
      const r = await send(quote
        ? { action: 'readerCommand', type: 'reference', id, quote }
        : { action: 'readerCommand', type: 'reference', id })
      if (r && r.ok) {
        toast('已设为引用')
        clearSelection()
        // 等一下再收起：后台还要把这条引用 POST 给接收端、接收端再推 SSE 回来，
        // 侧栏的引用卡是靠那条 SSE 填的（applySetRef）。不等的话收起瞬间卡片可能还是
        // 上一条 —— 用户看到的是"回到问答界面了，但引用卡没换"。200ms 是实测够用的量级。
        await new Promise((res) => setTimeout(res, 200))
        if (opts.onClose) opts.onClose()
      } else {
        toast('设为引用失败：' + ((r && r.error && r.error.message) || '原因未知'), true)
      }
      return r
    }

    /**
     * 点卡片里的文字时，看看落点在不在某道划线上 → 是就浮出动作条。
     *
     * 只在"没有文字选区"时才认：用户正划着半句时，点击是划选过程的一部分，
     * 那时弹动作条会跟划选工具条打架（而且会挡住他要点的位置）。
     */
    list.addEventListener('click', (ev) => {
      const s = window.getSelection && window.getSelection()
      if (s && !s.isCollapsed && String(s.toString() || '').trim()) return
      const mark = markAtPoint(ev.clientX, ev.clientY)
      if (!mark) { hideRefTip(); return }
      activeRef = mark.ann
      tipDel.title = '删除这条引用：' + String(mark.ann.translation || mark.ann.selectedText || '').slice(0, 40)
      // 贴着被点中的那一行放（见 lineRectOf：caret 是零宽的，不能拿它居中）
      placeTipAt(refTip, lineRectOf(mark, caretPointAt(ev.clientX, ev.clientY), ev.clientX, ev.clientY))
    })

    // 点别处就收起（capture 阶段：先于页面里其它 click 处理，避免"刚弹就被别的逻辑吃掉"）。
    // 点在划线上时这条会先收起、随后 list 的 click 又把它弹出来 —— 一帧之内，看不出闪。
    document.addEventListener('pointerdown', (ev) => {
      if (!refTip.hidden && !refTip.contains(ev.target)) hideRefTip()
    }, true)
    // 滚动、改窗口大小：划线跟着动，动作条留在原地就成了"浮在半空"
    list.addEventListener('scroll', () => hideRefTip(), { passive: true })
    window.addEventListener('resize', () => hideRefTip())

    tipRef.addEventListener('click', () => {
      const q = String(sel.text || '').trim()
      if (!q || !sel.id) return
      makeReference(sel.id, q)
    })
    tipCopy.addEventListener('click', async () => {
      const q = String(sel.text || '').trim()
      if (!q) return
      const ok = await copyText(q)
      toast(ok ? '已复制选中的一句' : '复制失败', !ok)
    })

    /**
     * 删除一条引用。
     *
     * 真正的删除在**侧栏**（它才有接收端存档、引用列表、微读划线的完整删除流程），
     * 所以这里走宿主给的 onDeleteRef 回调，不在面板里另写一套。
     * 宿主没提供（例如独立加载的自测页）就如实说"不支持"，不假装成功。
     */
    tipDel.addEventListener('click', async () => {
      const ann = activeRef
      if (!ann) return
      hideRefTip()
      if (!opts.onDeleteRef) { toast('当前页面不支持删除引用', true); return }
      let ok = false
      try { ok = !!(await opts.onDeleteRef(ann)) } catch (e) { ok = false }
      if (!ok) return   // 用户在确认框里取消了 / 删除失败：什么都不改
      // 乐观更新：先把这条从本地清单里摘掉，下划线立刻消失。
      // 真值随后由阅读器的新快照纠正（侧栏删完会叫它重拉一遍）。
      snapshot.refs = (snapshot.refs || []).filter(
        (r) => String(r.selectedText || '') !== String(ann.selectedText || ''),
      )
      render()
      toast('已删除引用')
    })

    tipCopyRef.addEventListener('click', async () => {
      const q = String((activeRef && (activeRef.translation || activeRef.selectedText)) || '').trim()
      if (!q) return
      const ok = await copyText(q)
      toast(ok ? '已复制这一句' : '复制失败', !ok)
    })

    /**
     * 「改原文」编辑器（2026-11 重做，见文件里那段说明）。
     * 返回的元素会被放在**原文预览原来的位置**，所以卡片不会因为进入编辑态而跳动。
     */
    function buildEditor(e) {
      const box = el('div', 'rn-edit')
      const head = el('div', 'rn-edit-head')
      head.append(
        el('span', 'rn-edit-label', '改原文'),
        el('span', 'rn-edit-hint', '改完会按新的原文重译这一段'),
      )

      const ta = document.createElement('textarea')
      ta.value = e.source || ''
      ta.spellcheck = false
      ta.rows = 3
      ta.setAttribute('aria-label', '原文')
      // 随内容长高：先归零再按 scrollHeight 设 —— 不归零的话删字之后框不会缩回去
      const grow = () => {
        ta.style.height = 'auto'
        ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px'
      }
      ta.addEventListener('input', grow)

      const acts = el('div', 'rn-edit-acts')
      const keys = el('span', 'rn-edit-keys', 'Ctrl/⌘+Enter 重译 · Esc 取消')
      const cancelBtn = el('button', 'rn-ghost', '取消')
      cancelBtn.type = 'button'
      const okBtn = el('button', 'rn-primary', '重译')
      okBtn.type = 'button'

      const cancel = () => { editingId = ''; render() }
      /**
       * 提交：等后台的**真实回执**再决定关不关编辑器。
       * 不能像旧版那样"发出去就关" —— 重译失败时用户刚改的那段就白费了，
       * 而失败原因只在校角弹一下（很容易没看见）。
       */
      const submit = async () => {
        const text = ta.value.trim()
        if (!text) { toast('原文不能为空', true); ta.focus(); return }
        // 一个字都没改就别白跑一趟（那会白白重翻一次、还多花一次模型调用）
        if (text === String(e.source || '').trim()) { cancel(); return }
        okBtn.textContent = '重译中…'
        okBtn.disabled = true
        cancelBtn.disabled = true
        let res = null
        try { res = await send({ action: 'readerCommand', type: 'retranslate', id: e.id, text }) } catch (err) {
          res = { ok: false, error: { message: String((err && err.message) || err) } }
        }
        if (res && res.ok === false) {
          // 失败：把编辑器留着、按钮恢复，用户可以直接改完重试
          toast('重译失败：' + ((res.error && res.error.message) || '原因未知'), true)
          okBtn.textContent = '重译'
          okBtn.disabled = false
          cancelBtn.disabled = false
          ta.focus()
          return
        }
        editingId = ''
        render()
      }
      cancelBtn.addEventListener('click', cancel)
      okBtn.addEventListener('click', submit)
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); cancel() }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit() }
      })

      acts.append(keys, cancelBtn, okBtn)
      box.append(head, ta, acts)
      // 聚焦并把光标放到**末尾**：用户多半是想补/改最后几个字，全选会让人一敲就全删了
      setTimeout(() => {
        ta.focus()
        try { ta.setSelectionRange(ta.value.length, ta.value.length) } catch (err) {}
        grow()
      }, 0)
      return box
    }

    function render() {
      const entries = snapshot.entries || []
      count.textContent = entries.length + ' 条'
      bookLine.textContent = snapshot.book
        ? snapshot.book.name + (snapshot.total ? '　第 ' + (snapshot.page || 1) + ' / ' + snapshot.total + ' 页' : '')
        : '未打开 PDF'
      empty.hidden = entries.length > 0
      list.replaceChildren()

      for (const e of entries) {
        const item = el('div', 'rn-item' + (e.id === snapshot.activeId ? ' is-active' : '') + (e.error ? ' is-error' : ''))
        item.dataset.id = e.id
        item.__entry = e      // 下划线按它判断"这条是文字还是图片、原文是什么"

        const editing = editingId === e.id
        if (editing) item.classList.add('is-editing')

        const dst = el('div', 'rn-dst')
        if (e.pending) dst.append(el('span', 'rn-pending', '翻译中…'))
        else if (e.error) dst.append(el('span', 'rn-err', '失败：' + e.error))
        else dst.textContent = e.translation || ''

        if (editing) {
          // 编辑器**就地**替换原文预览：卡片不跳，同一段文字也只出现一次
          item.append(buildEditor(e), dst)
        } else {
          const src = el('div', 'rn-src', e.source || (e.kind === 'image' ? '（图片区域）' : ''))
          src.title = '点击跳到原文'
          src.addEventListener('click', () => {
            src.classList.toggle('is-open')
            send({ action: 'readerCommand', type: 'reveal', id: e.id })
          })
          item.append(src, dst)

          const acts = el('div', 'rn-acts')
          const mk = (label, fn, cls) => {
            const b = el('button', cls || null, label)
            b.type = 'button'
            b.addEventListener('click', fn)
            return b
          }
          const btns = [mk('跳到原文', () => send({ action: 'readerCommand', type: 'reveal', id: e.id }))]
          // 没有原文的条目（扫描件的图片区域）不给「改原文」：文本框会是空的，
          // 提交必然被拦，等于摆了个按钮让人白点。
          if (String(e.source || '').trim()) {
            btns.push(mk('改原文', () => { editingId = e.id; render() }))
          }
          btns.push(
            mk('复制译文', async () => {
              const ok = await copyText(e.translation || '')
              toast(ok ? '已复制' : '复制失败', !ok)
            }),
            mk('设为引用', () => makeReference(e.id), 'rn-ref'),
            mk('删除', () => send({ action: 'readerCommand', type: 'remove', id: e.id })),
          )
          acts.append(...btns)
          item.append(acts)
        }

        list.appendChild(item)
      }

      // 列表刚被整个重建（replaceChildren）：划线的 Range 全失效了，动作条必须收起，
      // 否则它指着一段已经不存在的文字（点了会删错/没反应）。
      hideRefTip()
      // 先把选区按存的原文画回去，再画下划线。
      // ⚠️ 顺序不能反：restoreSelection 会改选区（不动 DOM），markQuotes 只读 DOM。
      restoreSelection()
      markRefs()
    }

    render()

    return {
      update(next) {
        snapshot = Object.assign({}, snapshot, next || {})
        render()
      },
      /** 收起面板时清选区：下次打开是干净的（不带着上次那半句） */
      clearSelection,
      getSnapshot() { return snapshot },
    }
  }

  window.CoReadNotes = { mount }
})()
