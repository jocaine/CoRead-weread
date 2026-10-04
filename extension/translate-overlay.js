/**
 * CoRead 翻译气泡 · 页面内遮罩与气泡
 *
 * 由 translate-background.js 通过 chrome.scripting.executeScript 按需注入，只在顶层 frame 运行。
 * 幂等：重复注入直接返回，由调用方再用一次 func 调用指定动作。
 *
 * 职责边界：本文件只做 DOM（遮罩框选、裁剪、气泡渲染）。
 * 截图与模型调用都在 service worker，本文件通过 chrome.runtime.sendMessage 请求。
 *
 * 多气泡（2026-10）：一页可以同时存在多个译文气泡，各自锚在自己的原文位置，互不顶掉。
 * 每个气泡可拖拽、可折叠成一个小「译」标记、可单独关闭。锚定用的是**页面坐标**
 * （pageX/pageY = 视口坐标 + 当时的滚动量），再用滚动补偿保持贴住原文。
 */

(() => {
  const MAX_SIDE = 1600          // 裁剪后最长边上限
  const MIN_SIDE = 10            // 小于这个尺寸的框选视为误触
  const MAX_BUBBLES = 10         // 同页气泡上限，超出时关掉最早的那个
  // 版本号：写进译文记录，用来判断页面里跑的到底是哪一版 overlay
  // （改了 overlay 之后必须"刷新扩展 + 刷新页面"才生效，旧实例会一直活着）
  const OVERLAY_VERSION = 20

  // 重复注入：DOM 已存在，交给调用方决定做什么
  // （translate-background.js 注入后会紧接着用一次 func 调用 startSelection / showText / restore）
  if (window.__coreadStOverlay) return

  let els = null
  let state = 'idle'             // idle | selecting
  let dragStart = null
  let viewport = { width: 0, height: 0 }
  const bubbles = []             // 活跃气泡，新的在后
  let bubbleSeq = 0
  let lastClickedBubble = null   // 最近一次 mousedown 落在哪个气泡里（判断点内/点外）
  let lastSize = null            // 最近一次手动调整的尺寸，新气泡沿用（同一次会话内）

  // ── 构建 Shadow DOM ─────────────────────────────────────────────────────────
  function build() {
    const host = document.createElement('div')
    host.id = 'coread-st-host'
    // all: initial 切断宿主页面的继承样式（font / color / line-height 会穿透影子边界）
    host.style.cssText = 'all: initial;'

    const shadow = host.attachShadow({ mode: 'closed' })

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = chrome.runtime.getURL('translate-overlay.css')
    shadow.appendChild(link)

    const wrap = document.createElement('div')
    // 静态模板，不含任何用户数据；模型输出一律走 textContent
    wrap.innerHTML = [
      '<div class="st-root" hidden>',
      '  <div class="st-shade"></div>',
      '  <div class="st-sel" hidden></div>',
      '</div>',
      '<div class="st-layer"></div>',
      '<div class="st-toast" hidden></div>',
      '<template class="st-tpl">',
      '  <div class="st-bubble" hidden>',
      '    <div class="st-head">',
      '      <span class="st-grip" title="按住可拖动">⋮⋮</span>',
      '      <span class="st-title">截图翻译</span>',
      '      <button class="st-pin" type="button" title="固定：不随页面滚动、点别处也不收起">📌</button>',
      '      <button class="st-collapse" type="button" title="折叠为小标记">▾</button>',
      '      <button class="st-close" type="button" title="关闭">×</button>',
      '    </div>',
      '    <div class="st-body">',
      '      <div class="st-status">正在处理…</div>',
      '      <div class="st-result" hidden>',
      '        <div class="st-dest">',
      '          <div class="st-text"></div>',
      '          <div class="st-actions">',
      '            <button class="st-coread" type="button" title="设为侧栏的当前引用，之后在输入框里向 AI 提问">设为引用</button>',
      '            <button class="st-copy" type="button">复制译文</button>',
      '            <button class="st-relocate" type="button" hidden',
      '                    title="页面重排后高亮只能就近保留。点这里让模型看着当前画面把这段文字重新找出来">重新定位</button>',
      '          </div>',
      '        </div>',
      '        <details class="st-orig-wrap" open>',
      '          <summary>原文（可编辑，改完点「重译」）</summary>',
      '          <textarea class="st-orig" spellcheck="false"></textarea>',
      '          <div class="st-orig-actions">',
      '            <button class="st-retranslate" type="button" disabled',
      '                    title="按当前原文重新翻译（Ctrl+Enter）">重译</button>',
      '          </div>',
      '        </details>',
      '      </div>',
      '    </div>',
      '    <div class="st-resize" title="拖动调整大小"></div>',
      '  </div>',
      '</template>',
    ].join('\n')

    shadow.appendChild(wrap)
    document.documentElement.appendChild(host)

    const q = (sel) => shadow.querySelector(sel)
    els = {
      host,
      shadow,
      root: q('.st-root'),
      shade: q('.st-shade'),
      sel: q('.st-sel'),
      layer: q('.st-layer'),
      toast: q('.st-toast'),
      tpl: q('.st-tpl'),
    }
  }

  // ── 框选 ────────────────────────────────────────────────────────────────────
  function startSelection() {
    if (!els) return
    // 开始框选不再关掉已有气泡：多气泡并存，互不顶掉
    state = 'selecting'
    // 高亮与气泡在框选期间让开鼠标：否则在已翻译过的区域上按下，
    // 事件被高亮吃掉，遮罩收不到 mousedown，新框选起不来
    els.layer.classList.add('st-lock')
    viewport = { width: window.innerWidth, height: window.innerHeight }
    els.root.hidden = false
    els.sel.hidden = true
    els.shade.style.cursor = 'crosshair'
    document.documentElement.style.userSelect = 'none'
    dragStart = null

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
    els.shade.addEventListener('mousedown', onMouseDown, true)
  }

  // 开始框选时不再关掉已有气泡：多气泡并存，互不顶掉

  function stopSelectListeners() {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    if (els) {
      els.shade.removeEventListener('mousedown', onMouseDown, true)
      els.layer.classList.remove('st-lock')   // 框选结束，高亮与气泡恢复可交互
    }
    document.documentElement.style.userSelect = ''
  }

  function cancelSelection() {
    stopSelectListeners()
    dragStart = null
    state = 'idle'
    if (!els) return
    els.root.hidden = true
    els.sel.hidden = true
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    cancelSelection()
  }

  /** 气泡的 Esc 独立于框选：关掉最近打开的那个。框选进行中不抢 Esc（那时 Esc 是取消框选）。 */
  function onBubbleKeyDown(e) {
    if (e.key !== 'Escape' || state === 'selecting') return
    const b = lastBubble()
    if (!b) return
    e.preventDefault()
    e.stopPropagation()
    closeBubble(b)
  }

  function onContextMenu(e) {
    if (state !== 'selecting') return
    e.preventDefault()
    e.stopPropagation()
    cancelSelection()
  }

  function onMouseDown(e) {
    if (state !== 'selecting' || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragStart = { x: e.clientX, y: e.clientY }
    placeSel(e.clientX, e.clientY, 0, 0)
    els.sel.hidden = false
  }

  function onMouseMove(e) {
    if (!dragStart) return
    const left = Math.min(dragStart.x, e.clientX)
    const top = Math.min(dragStart.y, e.clientY)
    placeSel(left, top, Math.abs(e.clientX - dragStart.x), Math.abs(e.clientY - dragStart.y))
  }

  function onMouseUp(e) {
    if (!dragStart) return
    const start = dragStart
    dragStart = null
    const rect = {
      left: Math.min(start.x, e.clientX),
      top: Math.min(start.y, e.clientY),
      width: Math.abs(e.clientX - start.x),
      height: Math.abs(e.clientY - start.y),
    }
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
      cancelSelection()
      return
    }
    finalize(rect)
  }

  function placeSel(left, top, width, height) {
    els.sel.style.left = left + 'px'
    els.sel.style.top = top + 'px'
    els.sel.style.width = width + 'px'
    els.sel.style.height = height + 'px'
  }

  // ── 截图 → 裁剪 → 翻译 ──────────────────────────────────────────────────────
  async function finalize(rect) {
    stopSelectListeners()
    state = 'idle'
    // 遮罩与选框必须先隐藏再截图，否则会被拍进去
    els.root.hidden = true
    els.sel.hidden = true
    await nextFrames()

    const capture = await send({ action: 'captureScreen' })
    if (!capture || !capture.ok) {
      const b = createBubble(rect, { kind: 'image', title: '截图翻译' })
      showError(b, capture && capture.error, '截图失败')
      return
    }

    let dataUrl
    try {
      dataUrl = await cropToDataUrl(capture.dataUrl, rect, viewport.width, MAX_SIDE)
    } catch (e) {
      const b = createBubble(rect, { kind: 'image', title: '截图翻译' })
      showError(b, { message: '裁剪失败：' + e.message }, '裁剪失败')
      return
    }

    const b = createBubble(rect, { kind: 'image', title: '截图翻译', loading: true })
    const res = await send({ action: 'translateImage', dataUrl })
    if (!b.alive) return
    if (!res || !res.ok) {
      showError(b, res && res.error, '翻译失败')
      return
    }
    renderResult(b, res.data)
  }

  function nextFrames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40)))
    })
  }

  /** 按截图的设备像素倍率裁出框选区域；最长边超过上限时等比缩小。 */
  function cropToDataUrl(dataUrl, rect, viewportWidth, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        try {
          const scale = img.naturalWidth / viewportWidth
          const sx = Math.max(0, Math.round(rect.left * scale))
          const sy = Math.max(0, Math.round(rect.top * scale))
          const sw = Math.min(img.naturalWidth - sx, Math.round(rect.width * scale))
          const sh = Math.min(img.naturalHeight - sy, Math.round(rect.height * scale))
          if (sw <= 0 || sh <= 0) throw new Error('框选区域超出截图范围')

          let dw = sw
          let dh = sh
          const longest = Math.max(sw, sh)
          if (longest > maxSide) {
            const k = maxSide / longest
            dw = Math.max(1, Math.round(sw * k))
            dh = Math.max(1, Math.round(sh * k))
          }

          const canvas = document.createElement('canvas')
          canvas.width = dw
          canvas.height = dh
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)
          // PNG：文字边缘不引入 JPEG 振铃；上游按尺寸换算 token，与体积无关
          resolve(canvas.toDataURL('image/png'))
        } catch (e) {
          reject(e)
        }
      }
      img.onerror = () => reject(new Error('截图数据无法解码'))
      img.src = dataUrl
    })
  }

  // ── 气泡：创建与销毁 ────────────────────────────────────────────────────────
  function lastBubble() {
    for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].alive) return bubbles[i]
    return null
  }

  function createBubble(rect, opts = {}) {
    const node = els.tpl.content.cloneNode(true)
    const el = node.querySelector('.st-bubble')
    els.layer.appendChild(el)

    const b = {
      id: ++bubbleSeq,
      el,
      alive: true,
      collapsed: false,
      kind: opts.kind || 'image',
      noRecord: !!opts.noRecord,   // 贴回历史的气泡不再写回记录，否则每贴一次就多一条
      hlEls: [],                   // 原文高亮条（跨行会有多条）
      hlRects: [],                 // 高亮条的屏幕坐标（摆放时用）
      // 锚点存**屏幕坐标**，配合 scrollChain 的位移量决定它跟着哪块内容走。
      // 不能用"视口 + window.scrollY"的页面坐标：微读这类阅读页正文在内层容器里滚，
      // 文档滚动量恒为 0，那样算出来的补偿永远是 0，气泡与高亮就会钉在屏幕上、一滚就跑偏。
      chipPos: { x: rect.left, y: rect.top },
      bodyPos: { x: rect.left + rect.width + 10, y: rect.top },
      scrollChain: [],
      lastOriginal: '',            // 当前译文对应的原文：原文被改过后「重译」才可点
      retranslating: false,
      pinned: false,               // 固定：不随页面滚动、点别处也不收起
      compact: false,              // 固定且鼠标离开时的"只显示译文"小卡
      resizing: null,
      refBusy: false,
      range: null,                 // DOM 锚点：有了它，页面重排后能自己找回位置
      rangeRoot: null,             // 锚点在哪个文档里（顶层 / 某个同源 iframe）
      anchorReason: '',            // 记录用：range / notfound / rejected
      sourceText: '',              // 划词时的原始选区文字（找回位置时比模型誊写更可靠）
      size: lastSize ? { ...lastSize } : null,   // 用户拖出来的尺寸，新气泡沿用
      drag: null,
      rect,
    }
    b.refs = {
      head: el.querySelector('.st-head'),
      title: el.querySelector('.st-title'),
      pin: el.querySelector('.st-pin'),
      collapse: el.querySelector('.st-collapse'),
      close: el.querySelector('.st-close'),
      status: el.querySelector('.st-status'),
      result: el.querySelector('.st-result'),
      text: el.querySelector('.st-text'),
      coread: el.querySelector('.st-coread'),
      copy: el.querySelector('.st-copy'),
      relocate: el.querySelector('.st-relocate'),
      retranslate: el.querySelector('.st-retranslate'),
      origWrap: el.querySelector('.st-orig-wrap'),
      orig: el.querySelector('.st-orig'),
      resize: el.querySelector('.st-resize'),
    }

    wireBubble(b)
    bubbles.push(b)
    el.hidden = false
    applySize(b)
    createHighlights(b, opts.rects && opts.rects.length ? opts.rects : [rect])
    // 滚动链在**创建时**按选区位置记一次就够：这条链代表"这段内容被谁滚"，
    // 之后无论气泡被拖到哪、折叠还是展开，都跟着同一块内容走。
    b.scrollChain = captureScrollChain(b.chipPos.x + 3, b.chipPos.y + 3)
    placeBubble(b, '正在处理…', opts.title)

    while (bubbles.filter((x) => x.alive).length > MAX_BUBBLES) {
      const oldest = bubbles.find((x) => x.alive)
      if (!oldest || oldest === b) break
      closeBubble(oldest)
    }
    return b
  }

  function wireBubble(b) {
    // 整卡都能拖（排除需要交互的元素），折叠态也能拖
    b.el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, textarea, summary, a, .st-text')) return
      onBubbleDragStart(b, e)
    })
    // 记录"这一下点在哪个气泡里"：document 上的收起逻辑据此判断点内还是点外
    // （闭合影子根会把 target 重定向成宿主元素，外面的监听看不到内部节点）
    b.el.addEventListener('mousedown', () => { lastClickedBubble = b })
    b.refs.close.addEventListener('click', (e) => { e.stopPropagation(); closeBubble(b) })
    b.refs.collapse.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(b) })
    b.refs.pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(b) })
    b.refs.resize.addEventListener('mousedown', (e) => onResizeStart(b, e))
    b.refs.copy.addEventListener('click', () => onCopy(b))
    b.refs.coread.addEventListener('click', () => setAsReference(b))
    b.refs.relocate.addEventListener('click', () => relocateNow(b))
    b.refs.retranslate.addEventListener('click', () => runRetranslate(b))
    // 重译改成手动触发：改完原文点「重译」（或 Ctrl+Enter），不再边打字边发请求
    b.refs.orig.addEventListener('input', () => updateRetranslateState(b))
    b.refs.orig.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeBubble(b)
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runRetranslate(b) }
    })
    // 固定的气泡：鼠标离开就收小，移回就展开
    b.el.addEventListener('mouseenter', () => setCompact(b, false))
    b.el.addEventListener('mouseleave', () => setCompact(b, true))
  }
  /** 原文没改动时「重译」置灰：一眼能看出当前译文是不是已经对应当前原文。 */
  function updateRetranslateState(b) {
    const dirty = b.refs.orig.value.trim() !== String(b.lastOriginal || '').trim()
    b.refs.retranslate.disabled = !dirty
  }

  // ── 固定：钉在屏幕当前位置 ──────────────────────────────────────────────────
  /**
   * 固定后：不随页面滚动（onScrollFollow 跳过它），点别处也不会自动收起
   * （onDocumentMouseDown 跳过它）。适合"一边读别处，一边把这段译文留在眼前"。
   * 固定状态下鼠标一离开就收成"只显示译文"的小卡，移回来恢复完整形态。
   */
  function togglePin(b) {
    b.pinned = !b.pinned
    b.el.classList.toggle('st-pinned', b.pinned)
    b.refs.pin.classList.toggle('on', b.pinned)
    b.refs.pin.title = b.pinned
      ? '取消固定（恢复跟随原文）'
      : '固定：不随页面滚动、点别处也不收起'
    if (b.pinned) {
      b.el.style.transform = 'none'   // 停在现在的屏幕位置
    } else {
      // 解钉：把当前屏幕位置换算回锚点（锚点 = 屏幕位置 + 累计滚动量），重新贴住原文
      const { dx, dy } = scrollDeltaOf(b)
      const left = (parseFloat(b.el.style.left || '0') || 0) + dx
      const top = (parseFloat(b.el.style.top || '0') || 0) + dy
      b.bodyPos = { x: left, y: top }
      b.chipPos = { x: left, y: top }
      placeHighlights(b)
    }
    setCompact(b, false)
  }

  /** 固定的气泡在鼠标离开后收成只显示译文的小卡；其余情况一律展开。 */
  function setCompact(b, on) {
    const want = on && b.pinned && !b.collapsed
    if (!!b.compact === want) return
    b.compact = want
    b.el.classList.toggle('st-compact', want)
    applySize(b)
    placeBubble(b, null, null)
  }

  // ── 手动调整尺寸 ────────────────────────────────────────────────────────────
  const MIN_W = 240
  const MIN_H = 120
  const COMPACT_W = 250          // 固定 + 鼠标离开时的宽度

  /** 折叠态不能带着手动调过的宽度（会变成一条长条），所以折叠时摘掉、展开时贴回。 */
  function applySize(b) {
    if (b.collapsed) {
      b.el.style.width = ''
      b.el.style.height = ''
      return
    }
    if (b.compact) {
      // 固定且鼠标离开：只显示译文的小卡（宽度由 JS 定，不用 CSS !important，免得跟这里打架）
      b.el.style.width = COMPACT_W + 'px'
      b.el.style.height = ''
      return
    }
    if (!b.size) {
      b.el.style.width = ''
      b.el.style.height = ''
      return
    }
    b.el.style.width = b.size.w + 'px'
    b.el.style.height = b.size.h + 'px'
  }

  function onResizeStart(b, e) {
    if (e.button !== 0) return
    e.preventDefault()
    // 这里要拦住冒泡（不然整卡拖动会一起启动），但**必须自己把记账补上**：
    // 否则 document 上的"点别处就收起"会把它当成点在外面，先把气泡收成小标记，
    // 尺寸就再也应用不上了（这正是"尺寸调不动"的原因）。
    lastClickedBubble = b
    e.stopPropagation()
    const rect = b.el.getBoundingClientRect()
    b.resizing = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height }
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeEnd)
  }

  function onResizeMove(e) {
    const b = bubbles.find((x) => x.alive && x.resizing)
    if (!b) return
    // 两道保险：正在拖尺寸就说明用户在操作它，别让它处于"只显示译文"或被收起的形态，
    // 否则尺寸写进去也看不出来（applySize 对这两种形态有自己的处理）。
    if (b.compact) setCompact(b, false)
    if (b.collapsed) toggleCollapse(b)
    b.size = {
      w: Math.max(MIN_W, Math.round(b.resizing.w + e.clientX - b.resizing.x)),
      h: Math.max(MIN_H, Math.round(b.resizing.h + e.clientY - b.resizing.y)),
    }
    applySize(b)
  }

  function onResizeEnd() {
    const b = bubbles.find((x) => x.alive && x.resizing)
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    if (!b) return
    b.resizing = null
    lastSize = b.size ? { ...b.size } : null   // 记住，后面的新气泡沿用
  }

  // ── 设为引用（交给共读用）──────────────────────────────────────────────────
  /**
   * 只把原文设为侧栏的当前引用，**不直接发出提问**——用户在侧栏输入框里自己问。
   * 内容脚本不能跨域 POST，交给 service worker 发 /annotation（setRef: true）。
   */
  async function setAsReference(b) {
    if (!b.alive || b.refBusy) return
    const original = b.refs.orig.value.trim() || b.refs.text.textContent || ''
    if (!original) return
    b.refBusy = true
    const btn = b.refs.coread
    const label = btn.textContent
    btn.textContent = '设置中…'
    const res = await send({
      action: 'setTranslationRef',
      original,
      translation: b.refs.text.textContent || '',
      url: location.href,
      pageTitle: document.title || '',
    })
    b.refBusy = false
    if (!b.alive) return
    if (!res || !res.ok) {
      btn.textContent = label
      b.refs.status.hidden = false
      b.refs.status.classList.add('st-error')
      b.refs.status.textContent = (res && res.error && res.error.message) || '设为引用失败'
      return
    }
    btn.textContent = '已设为引用'
    setTimeout(() => { if (b.alive) btn.textContent = label }, 1600)
  }

  /**
   * 原文高亮：把被翻译过的地方标出来（截图=框选那块，划词=选中那几行）。
   * 高亮长驻到气泡被关闭为止；点高亮可以展开/收起对应译文。
   * 用覆盖层画，不改页面 DOM —— 不动页面结构，也就不存在破坏排版的风险。
   */
  function createHighlights(b, rects) {
    for (const r of rects) {
      // 太小的矩形不画：划词拿不到选区矩形时是 (0,0)，画出来只是个 2px 的点
      if (!r || (r.width || 0) < 2 || (r.height || 0) < 2) continue
      b.hlRects.push({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
    renderHighlightEls(b)
    captureCanvasAnchor(b)   // 画布书：记下位置在 canvas 上的比例，重排后靠它映射
  }

  /** 按 b.hlRects 重建高亮条（重排后条数会变，所以整体重建而不是逐个改坐标）。 */
  function renderHighlightEls(b) {
    for (const hl of b.hlEls) hl.remove()
    b.hlEls = []
    for (const _ of b.hlRects) {
      const hl = document.createElement('div')
      hl.className = 'st-hl'
      els.layer.insertBefore(hl, b.el)   // 高亮压在气泡下面
      // 记成"点在气泡里"：否则点高亮会被当成点外面，先把气泡收起来再切换，行为会打架
      hl.addEventListener('mousedown', () => { lastClickedBubble = b })
      hl.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(b) })
      b.hlEls.push(hl)
    }
    placeHighlights(b)
  }

  function placeHighlights(b) {
    if (!b.hlEls || !b.hlEls.length) return
    b.hlEls.forEach((hl, i) => {
      const r = b.hlRects[i]
      if (!r) return
      hl.style.left = r.x + 'px'
      hl.style.top = r.y + 'px'
      hl.style.width = r.w + 'px'
      hl.style.height = r.h + 'px'
      hl.style.transform = 'none'
    })
  }

  // ── 重排后重新定位：靠 DOM Range ───────────────────────────────────────────
  /**
   * 视口宽度一变（打开侧栏、拉伸窗口、旋转屏幕），正文会重排，像素锚点立刻失效。
   * 有 Range 就不一样了：浏览器重排后 getClientRects() 会直接告诉我们新位置。
   * 划词的 Range 是现成的（选区就是），截图的得拿模型誊写的原文去页面里找。
   */
  function rectsOfRange(range) {
    if (!range) return null
    try {
      const out = []
      for (const r of range.getClientRects()) {
        if (r && r.width > 1 && r.height > 1) {
          out.push({ left: r.left, top: r.top, width: r.width, height: r.height })
        }
      }
      return out.length ? out : null
    } catch (e) {
      return null
    }
  }

  /**
   * 收集所有能搜的文档：顶层 + **同源 iframe**（最多两层），并记下它到顶层视口的偏移。
   * 微读这类阅读器的正文就在 iframe 里——content.js 是靠 all_frames 才跑进去的，
   * 只搜顶层文档会一无所获（实测 anchored=false 就是这个原因）。
   * 跨源 iframe 读不到 contentDocument，直接跳过。
   */
  function collectSearchRoots() {
    const out = []
    const visit = (doc, offsetX, offsetY, frames, depth) => {
      if (!doc || depth > 2) return
      out.push({ doc, offsetX, offsetY, frames })
      let list = []
      try { list = Array.prototype.slice.call(doc.querySelectorAll('iframe, frame')) } catch (e) { return }
      for (const f of list) {
        let r = null
        try { r = f.getBoundingClientRect() } catch (e) { continue }
        if (!r || r.width < 40 || r.height < 40) continue
        let inner = null
        try { inner = f.contentDocument } catch (e) { inner = null }
        if (!inner || !inner.body) continue          // 跨源 iframe 读不到
        let bx = 0
        let by = 0
        try {
          const cs = doc.defaultView.getComputedStyle(f)
          bx = parseFloat(cs.borderLeftWidth) || 0
          by = parseFloat(cs.borderTopWidth) || 0
        } catch (e) {}
        visit(inner, offsetX + r.left + bx, offsetY + r.top + by, frames.concat([f]), depth + 1)
      }
    }
    visit(document, 0, 0, [], 0)
    return out
  }

  /** iframe 链到顶层视口的当前偏移（每次测量都重算：iframe 自己也会被滚动/重排）。 */
  function framesOffsetNow(frames) {
    if (!frames || !frames.length) return { x: 0, y: 0 }
    let x = 0
    let y = 0
    for (const f of frames) {
      // iframe 被换掉/移除时 getBoundingClientRect 返回全 0，会把高亮算到左上角去
      if (!f || !f.isConnected) return null
      let r = null
      try { r = f.getBoundingClientRect() } catch (e) { return null }
      if (!r) return null
      let bx = 0
      let by = 0
      try {
        const cs = f.ownerDocument.defaultView.getComputedStyle(f)
        bx = parseFloat(cs.borderLeftWidth) || 0
        by = parseFloat(cs.borderTopWidth) || 0
      } catch (e) {}
      x += r.left + bx
      y += r.top + by
    }
    return { x, y }
  }

  /** 把气泡 Range 的矩形换算到顶层视口坐标；跨源等异常返回 null。 */
  function rangeRectsToTop(b) {
    const rects = rectsOfRange(b.range)
    if (!rects) return null
    const frames = b.rangeRoot && b.rangeRoot.frames
    if (!frames || !frames.length) return rects
    const off = framesOffsetNow(frames)
    if (!off) return null
    return rects.map((r) => ({
      left: r.left + off.x,
      top: r.top + off.y,
      width: r.width,
      height: r.height,
    }))
  }

  /**
   * 在页面文字里找 needle 对应的 Range。同一段文字可能重复出现，
   * 所以把所有出现位置都比一遍，挑离 nearRect（当初框选的位置）最近的那个。
   * 返回 { range, root }（root 记着它在哪个文档里，重排时要回那儿重新测量）。
   */
  function findTextRange(needle, nearRect) {
    const target = normalizeText(needle)
    if (target.length < 6) return null
    const roots = collectSearchRoots()
    let best = null
    for (const root of roots) {
      const hit = findRangeInDoc(root, target, nearRect)
      if (hit && (!best || hit.d < best.d)) best = { range: hit.range, root, d: hit.d }
    }
    if (!best) return null
    return { range: best.range, root: best.root }
  }

  /** 在单个文档里找（含穿透 shadow root）。偏移用于把矩形换算到顶层视口比较远近。 */
  function findRangeInDoc(root, target, nearRect) {
    const doc = root.doc
    const body = doc.body || doc.documentElement
    if (!body) return null

    // 这里**不能**用 body.textContent 做预检：textContent 看不到 shadow root 里的文字，
    // 而微读这类阅读器的正文恰恰可能渲染在 shadow root 里（content.js 就是因为这个才要
    // 穿透 shadow root 收集文本节点）。用它预检会把"有这段文字"错判成"没有"，直接放弃。
    // 画布书的正文根本不在 DOM 里，这一趟走完也很快，不值得为它冒误判的风险。

    // 一次遍历把正文压成"去空白后的字符串 + 每个字符对应的 (文本节点, 原始偏移)"
    const wNode = []
    const wOff = []
    const chars = []
    const skip = /[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/
    const seen = new Set()
    const walk = (node) => {
      if (!node || seen.has(node)) return
      seen.add(node)
      let walker = null
      try { walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false) } catch (e) { return }
      let n = null
      while ((n = walker.nextNode())) {
        const data = n.data || ''
        if (!data) continue
        for (let i = 0; i < data.length; i++) {
          if (skip.test(data[i])) continue
          chars.push(data[i])
          wNode.push(n)
          wOff.push(i)
        }
      }
      // 穿透 shadow root（WeRead 可能用它渲染正文）
      let hosts = []
      try { hosts = Array.prototype.slice.call(node.querySelectorAll('*')) } catch (e) { hosts = [] }
      for (const h of hosts) {
        if (h.shadowRoot) walk(h.shadowRoot)
      }
    }
    walk(body)

    const flat = chars.join('')
    if (flat.length < target.length) return null

    const rangeAt = (at, len) => {
      const s = at
      const e = at + len - 1
      if (s < 0 || e >= wNode.length) return null
      try {
        const r = doc.createRange()
        r.setStart(wNode[s], wOff[s])
        r.setEnd(wNode[e], wOff[e] + 1)
        return r
      } catch (err) {
        return null
      }
    }
    const distTo = (range) => {
      const rects = rectsOfRange(range)
      if (!rects) return Infinity
      let best = Infinity
      for (const r of rects) {
        const d = Math.abs(r.left + root.offsetX - nearRect.left) + Math.abs(r.top + root.offsetY - nearRect.top)
        if (d < best) best = d
      }
      return best
    }

    const pickNearest = (len) => {
      const probe = len === target.length ? target : target.slice(0, len)
      let best = null
      let at = flat.indexOf(probe)
      let guard = 0
      while (at !== -1 && guard < 40) {
        guard++
        const r = rangeAt(at, probe.length)
        if (r) {
          const d = nearRect ? distTo(r) : 0
          if (!best || d < best.d) best = { range: r, d }
          if (d < 6) break   // 已经贴合当初的位置，不用再比了
        }
        at = flat.indexOf(probe, at + 1)
      }
      return best
    }

    // 先按整段找；模型誊写可能有出入，退一步用前 12 字找起点
    return pickNearest(target.length) || pickNearest(Math.min(12, target.length))
  }

  /**
   * 命中位置是否落在当初框选的区域里。创建时还没重排，真命中的话必然在框内；
   * 用"是否在框内"而不是"距离多少像素"，是因为框选区域往往比文字本身大一圈。
   */
  function matchInsideFrame(rect, frame, tol) {
    if (!rect || !frame) return false
    return rect.left >= frame.left - tol
      && rect.left <= frame.left + frame.width + tol
      && rect.top >= frame.top - tol
      && rect.top <= frame.top + frame.height + tol
  }

  /**
   * 重记链的基准（不重新采点）。
   *
   * 链上的滚动容器是**创建时在选区位置**采下来的，那才是"这段内容被谁滚"的正解。
   * 之后每次重排都重新采点是错的：采点一旦落空（高亮正好盖在那个位置、锚点已被
   * 挪到视口外），就会采成"只有文档"的退化链，内层滚动容器永久丢失——表现就是
   * "滚不动了、不跟随了"。所以这里只刷新基准值，容器集合保持不变。
   *
   * 只有当链上的容器**全部**失联（页面重排把它们换掉了）时，才回退到重新采一次。
   */
  function rebaseChainTo(b, allowRecapture) {
    const old = b.scrollChain || []
    const kept = []
    for (const s of old) {
      if (s.el && !s.el.isConnected) continue
      kept.push({
        el: s.el,
        left: s.el ? s.el.scrollLeft : window.scrollX,
        top: s.el ? s.el.scrollTop : window.scrollY,
      })
    }
    const hadInner = old.some((s) => s.el)
    const lostAllInner = hadInner && !kept.some((s) => s.el)
    if (allowRecapture && lostAllInner) {
      const r = b.el.getBoundingClientRect()
      const recaptured = captureScrollChain(r.left + 3, r.top + 3)
      if (recaptured.some((s) => s.el)) {
        b.scrollChain = recaptured
        return
      }
    }
    if (!kept.some((s) => s.el === null)) {
      kept.push({ el: null, left: window.scrollX, top: window.scrollY })   // 文档自身
    }
    b.scrollChain = kept
  }

  /** 把气泡按 Range 重排后的真实位置重新锚定（高亮条数可能变了，整体重建）。 */
  function anchorToRange(b, rects) {
    b.hlRects = rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
    renderHighlightEls(b)
    markApprox(b, false)     // 有真实位置了，撤掉"可能不准"标记
    // 注意：不要在这里重算 canvas 比例。canvas 被重绘过时映射本来就只是近似，
    // 每次重排都从"已经近似的位置"再推一次会累积漂移。比例只在创建时记一次。
    b.chipPos = { x: rects[0].left, y: rects[0].top }
    b.bodyPos = { x: rects[0].left + rects[0].width + 10, y: rects[0].top }
    rebaseChainTo(b, true)   // 只重记基准，容器集合不动
    b.el.style.transform = 'none'
  }

  // ── 画布书：正文画在 canvas 上，没有文字节点 ────────────────────────────────
  /**
   * 微读的"画布书"把整章正文画在一张 canvas 上（实测 1918×7981），页面里没有任何
   * 文字节点，所以拿不到 Range。退而求其次：把高亮位置记成**相对 canvas 的比例**。
   * canvas 只是被 CSS 缩放时，比例映射是精确的；即使 canvas 按新宽度重绘过
   * （文字在画布里重排），比例映射也比原地不动更接近。
   */
  /**
   * 找到与选区**相交面积最大**的那张 canvas。
   *
   * 两个坑：
   *  1) 不能用 elementsFromPoint —— 它会跳过 pointer-events: none 的元素，
   *     而画布书的 canvas 常常正是 pointer-events: none（它只是张渲染面）。
   *  2) 不能只判断"某个角点是否在 canvas 内" —— 框选通常带一点外边距，
   *     左上角可能刚好落在画布外，于是什么都找不到（实测就栽在这里）。
   *     所以改成算相交面积，取重叠最大的那张。
   */
  function findCanvasFor(rect) {
    let list = []
    try { list = document.querySelectorAll('canvas') } catch (e) { return null }
    let best = null
    let bestArea = 0
    for (const c of list) {
      let r = null
      try { r = c.getBoundingClientRect() } catch (e) { continue }
      if (!r || r.width < 2 || r.height < 2) continue
      const ow = Math.min(r.right, rect.left + rect.width) - Math.max(r.left, rect.left)
      const oh = Math.min(r.bottom, rect.top + rect.height) - Math.max(r.top, rect.top)
      if (ow <= 0 || oh <= 0) continue
      const area = ow * oh
      if (area > bestArea) { bestArea = area; best = c }
    }
    return best
  }

  function captureCanvasAnchor(b) {
    if (!b.hlRects.length) return
    const first = b.hlRects[0]
    const canvas = findCanvasFor({ left: first.x, top: first.y, width: first.w, height: first.h })
    if (!canvas) return
    const cr = canvas.getBoundingClientRect()
    if (!cr.width || !cr.height) return
    b.canvasInfo = {
      rect: Math.round(cr.width) + '×' + Math.round(cr.height),
      intrinsic: canvas.width + '×' + canvas.height,
    }
    b.canvasRef = canvas
    b.canvasFrac = b.hlRects.map((r) => ({
      fx: (r.x - cr.left) / cr.width,
      fy: (r.y - cr.top) / cr.height,
      fw: r.w / cr.width,
      fh: r.h / cr.height,
    }))
    b.canvasIntrinsic = { w: canvas.width, h: canvas.height }
  }

  /** 按 canvas 比例把高亮位置映射回屏幕；canvas 没了或尺寸异常返回 null。 */
  function reanchorToCanvas(b) {
    const c = b.canvasRef
    if (!c || !c.isConnected || !b.canvasFrac || !b.canvasFrac.length) return null
    const cr = c.getBoundingClientRect()
    if (!cr.width || !cr.height) return null
    // canvas 的固有像素尺寸变了 → 内容被按新宽度重绘过，比例只是近似（要标出来）
    b.canvasLayoutChanged = !(b.canvasIntrinsic
      && c.width === b.canvasIntrinsic.w
      && c.height === b.canvasIntrinsic.h)
    return b.canvasFrac.map((f) => ({
      left: cr.left + f.fx * cr.width,
      top: cr.top + f.fy * cr.height,
      width: Math.max(2, f.fw * cr.width),
      height: Math.max(2, f.fh * cr.height),
    }))
  }

  /**
   * 标记 / 撤销"位置可能不准"（虚线 + 降透明度）。
   * 处于这个状态时气泡上才出现「重新定位」——它是唯一的补救手段，也意味着一次模型调用，
   * 所以只在真的不准时露出来，不做自动触发。
   */
  function markApprox(b, on) {
    b.approx = !!on
    for (const hl of b.hlEls) hl.classList.toggle('st-hl-approx', !!on)
    if (b.refs.relocate) b.refs.relocate.hidden = !on
  }

  /**
   * 截图取景用：把高亮和气泡整体藏起来（都在 .st-layer 里），等两帧让它真的从画面上消失。
   * 画面必须干净——留着那个位置不准的虚线框，模型十有八九会把看到的框直接抄回来。
   * 只改 visibility，不动布局，因此不会引起页面重排。
   * 藏起来期间用一个小角标告知进度（它在 .st-layer 之外，会留在截图里，
   * 但缩在角落里，不影响模型找正文）。
   */
  async function hideOverlayForCapture() {
    if (!els || !els.layer) return
    els.layer.style.visibility = 'hidden'
    if (els.toast) {
      els.toast.textContent = '重新定位中…（这一张截图会发给模型）'
      els.toast.hidden = false
    }
    // 等两帧让它真的重绘掉；标签页在后台时 rAF 会被节流甚至不触发，
    // 所以再加一道 300ms 兜底，避免这里把整个流程卡住。
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      setTimeout(finish, 300)
      requestAnimationFrame(() => requestAnimationFrame(finish))
    })
  }

  function showOverlayAfterCapture() {
    if (!els) return
    if (els.layer) els.layer.style.visibility = ''
    if (els.toast) {
      els.toast.hidden = true
      els.toast.textContent = ''
    }
  }

  /**
   * 按需重新定位：截当前屏幕，让模型在画面里找出这段文字，再把高亮贴回去。
   * 这条路专门留给画布渲染的书——正文画在 canvas 上，页面里没有文字节点，
   * Range / 画布比例 / 重搜文字全都无从下手，只有看着渲染结果才能找到。
   * 坐标由模型给出，是近似的；拿到之后按新位置重记画布比例，后续滚动继续跟随。
   */
  async function relocateNow(b) {
    if (!b.alive || b.relocating) return
    const text = b.sourceText || b.lastOriginal
    const btn = b.refs.relocate
    if (!text || !btn) return
    b.relocating = true
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = '定位中…'
    b.refs.status.hidden = false
    b.refs.status.classList.remove('st-error')
    b.refs.status.textContent = '正在让模型在当前画面里找这段文字…'
    let res
    try {
      const vw = Math.max(1, window.innerWidth)
      const vh = Math.max(1, window.innerHeight)
      // 提示用高亮现在的位置：重排后它通常还在附近，能帮模型缩小搜索范围
      const hint = { x: b.chipPos.x / vw, y: b.chipPos.y / vh }
      // 截图前把整个覆盖层藏起来：否则画面里就有那个（位置不准的）虚线框，
      // 模型十有八九直接把看到的框抄回来，白跑一次。
      await hideOverlayForCapture()
      res = await send({ action: 'relocateAnchor', text, hint })
      showOverlayAfterCapture()
    } catch (e) {
      showOverlayAfterCapture()
      res = { ok: false, error: { message: String(e?.message || e) } }
    }
    b.relocating = false
    btn.disabled = false
    btn.textContent = label
    if (!b.alive) return

    if (!res || !res.ok) {
      const err = (res && res.error) || {}
      const msg = err.message || '重新定位失败'
      // detail 里放的是模型的原话 / 出错细节：显示出来（截断），省得为了看一眼去开 F12
      const detail = err.detail ? String(err.detail).slice(0, 120) : ''
      b.refs.status.hidden = false
      b.refs.status.classList.add('st-error')
      b.refs.status.textContent = '重新定位失败：' + msg + (detail ? '（' + detail + '）' : '')
      try {
        console.log('[CoRead 翻译] 重新定位失败', {
          overlayV: OVERLAY_VERSION,
          code: err.code || '',
          message: msg,
          detail: err.detail || '',
        })
      } catch (e) {}
      return
    }
    const box = res.box || {}
    const vw = Math.max(1, window.innerWidth)
    const vh = Math.max(1, window.innerHeight)
    const rect = {
      left: box.x * vw,
      top: box.y * vh,
      width: Math.max(24, box.w * vw),
      height: Math.max(10, box.h * vh),
    }
    anchorToRange(b, [rect])
    captureCanvasAnchor(b)     // 位置变了，画布比例按新位置重记，滚动才有得跟
    b.anchorReason = 'relocated'
    b.canvasLayoutChanged = false
    b.refs.status.hidden = true
    try {
      console.log('[CoRead 翻译] 重新定位完成', {
        overlayV: OVERLAY_VERSION,
        snippet: res.snippet || '',
        box: box,
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        canvas: b.canvasInfo || null,
      })
    } catch (e) {}
  }

  /**
   * 重排后重新找锚点：阅读器重排时可能把正文节点整个换掉，手里那个 Range 就失效了
   * （getClientRects 返回空）。这时拿原文再搜一次——搜索穿透 shadow root，
   * 重挂后的内容照样能找到（微信读书的普通书籍就是这种情况）。
   */
  function refindAnchor(b) {
    const text = b.sourceText || b.lastOriginal
    if (!text) return null
    const { dx, dy } = scrollDeltaOf(b)
    // 用气泡现在的屏幕位置当"邻近参照"：它一直贴着原文，重排后也不会跑远
    const near = { left: b.chipPos.x - dx, top: b.chipPos.y - dy }
    const hit = findTextRange(text, near)
    if (!hit) return null
    const rects = rangeRectsToTop({ range: hit.range, rangeRoot: hit.root })
    if (!rects) return null
    b.range = hit.range
    b.rangeRoot = hit.root
    b.anchorReason = 'refound'
    return rects
  }

  /**
   * 就地冻结：把当前的屏幕位置固化成新的零点（位置不动）。
   * 用于"重排后连文字也找不回来"的情况——页面变宽后正文变矮、文档变短时浏览器会
   * 钳制滚动位置，用旧基准算出的假位移会把高亮甩到视口下方几千像素处
   * （表现就是"宽度一变，截图框不见了"）。基准重记后从 0 开始重新跟随。
   */
  function freezeInPlace(b) {
    const { dx, dy } = scrollDeltaOf(b)
    const hlScreen = b.hlEls.map((hl) => {
      const r = hl.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    if (hlScreen.length) b.hlRects = hlScreen
    b.chipPos = { x: b.chipPos.x - dx, y: b.chipPos.y - dy }
    b.bodyPos = { x: b.bodyPos.x - dx, y: b.bodyPos.y - dy }
    for (const hl of b.hlEls) hl.style.transform = 'none'
    b.el.style.transform = 'none'
    rebaseChainTo(b, true)
    // 页面重排过、又找不到 DOM 锚点：这块高亮现在只能停在原位，未必还对着原文。
    // 用虚线标出来，别让人以为它是准的（画布书 / 跨源 iframe 会走到这里），
    // 同时露出「重新定位」让人按需让模型找一次。
    markApprox(b, true)
  }

  /** 视口尺寸变了：有 Range 的按重排后的真实位置重贴，其余按 canvas 比例 / 重新搜索 / 就地冻结。 */
  function reflowBubbles() {
    for (const b of [...bubbles]) {
      if (!b.alive) continue
      if (b.pinned) continue          // 固定的本来就钉在屏幕上，不参与重排
      let rects = b.range ? rangeRectsToTop(b) : null
      if (!rects) {
        // 画布书：只在 canvas 是"纯缩放"时用比例映射——那时它是精确的。
        // 若 canvas 被按新宽度重绘过（内容在画布里重新折行），比例映射只是猜测，
        // 而且可能把高亮推到很远；此时"停在原地"反而更接近，因为用户正看着那段文字，
        // 它就在附近。所以重绘的情况下不采用映射，交给下面的冻结分支。
        const mapped = reanchorToCanvas(b)
        if (mapped && !b.canvasLayoutChanged) rects = mapped
      }
      if (!rects) rects = refindAnchor(b)       // 普通页面：重排后重新搜一次文字
      if (rects) {
        anchorToRange(b, rects)
      } else {
        freezeInPlace(b)   // 都找不回来：基准归零，位置不动 + 虚线标注，别被假位移甩出屏幕
      }
      placeBubble(b, null, null)
    }
  }

  let _reflowTimer = null
  function onViewportResize() {
    clearTimeout(_reflowTimer)
    _reflowTimer = setTimeout(reflowBubbles, 160)   // 拖窗口时会连发，防抖一下
  }

  // ── 滚动跟随：记录"锚点位置上的滚动容器链" ─────────────────────────────────
  /**
   * 关键：不能只看 window.scrollY。微读这类阅读页正文在内层容器里滚，文档滚动量恒为 0。
   * 所以在锚点位置命中一个页面元素，往上收集所有可滚动祖先，连文档一起记下它们的滚动量；
   * 之后靠这些容器滚动量的变化量来移动气泡与高亮。
   * 用 elementsFromPoint 并跳过自己的宿主元素，避免命中覆盖层自己。
   */
  function captureScrollChain(x, y) {
    const chain = []
    let list = []
    try { list = document.elementsFromPoint(x, y) || [] } catch (e) { list = [] }
    let hit = null
    for (const el of list) {
      if (!els || el === els.host || (el.closest && el.closest('#coread-st-host'))) continue
      hit = el
      break
    }
    let node = hit
    while (node && node !== document.documentElement && node !== document.body) {
      let scrollable = false
      try {
        const style = window.getComputedStyle(node)
        const oy = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
        const ox = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth
        scrollable = oy || ox
      } catch (e) {}
      if (scrollable) chain.push({ el: node, left: node.scrollLeft, top: node.scrollTop })
      node = node.parentElement
    }
    chain.push({ el: null, left: window.scrollX, top: window.scrollY })   // 文档自身
    return chain
  }

  /** 自上次记录基准以来，这条链上一共滚了多少。 */
  function scrollDeltaOf(b) {
    let dx = 0
    let dy = 0
    for (const s of b.scrollChain || []) {
      if (s.el && !s.el.isConnected) {
        // 容器已被页面重排换掉。**绝对不能**把它现在的 scrollTop 当成滚动量：
        // 新容器是 0、基准是旧容器的值，一减就是一个几千像素的假位移，
        // 会把气泡和高亮整体甩到屏幕外——表现就是"宽度一变，标记直接消失"。
        continue
      }
      const left = s.el ? s.el.scrollLeft : window.scrollX
      const top = s.el ? s.el.scrollTop : window.scrollY
      dx += left - s.left
      dy += top - s.top
    }
    return { dx, dy }
  }

  function removeHighlights(b) {
    for (const hl of b.hlEls || []) hl.remove()
    b.hlEls = []
  }

  /** 摆放 + 记录滚动基准。anchor 用页面坐标，所以滚动时靠补偿保持贴住原文。 */
  function placeBubble(b, statusText, title) {
    if (title) b.refs.title.textContent = title
    if (statusText) {
      b.refs.status.hidden = false
      b.refs.status.classList.remove('st-error')
      b.refs.status.textContent = statusText
    }
    const anchor = b.collapsed ? b.chipPos : b.bodyPos
    viewport = { width: window.innerWidth, height: window.innerHeight }
    const bubble = b.el
    const bw = bubble.offsetWidth || 380
    const bh = bubble.offsetHeight || 160
    const margin = 8

    // 元素实际屏幕位置 = 锚点 − 累计滚动量（translate 负责这部分）
    const { dx, dy } = scrollDeltaOf(b)
    let left = anchor.x
    let top = anchor.y
    const screenX = left - dx
    const screenY = top - dy
    // 只在锚点本来就落在视口内时才做防溢出钳制。
    // 贴回历史的锚点常在屏幕下方（甚至几千像素外），那时钳制会把气泡硬塞进当前视口，
    // 一堆贴回的气泡就会堆在底部——锚定失效。所以离屏的锚点原样摆，滚过去自然能看到。
    const onScreen = screenX > -bw && screenX < viewport.width && screenY > -bh && screenY < viewport.height
    if (!b.collapsed && onScreen) {
      if (screenX + bw > viewport.width - margin) left = anchor.x - bw - 20
      if (screenX < margin) left = margin + dx
      if (screenY + bh > viewport.height - margin) top = viewport.height - bh - margin + dy
      if (screenY < margin) top = margin + dy
    }
    bubble.style.left = left + 'px'
    bubble.style.top = top + 'px'
    bubble.style.transform = 'translate(' + -dx + 'px,' + -dy + 'px)'
    ensureScrollWatch()
  }

  function toggleCollapse(b) {
    b.collapsed = !b.collapsed
    b.el.classList.toggle('st-collapsed', b.collapsed)
    b.refs.collapse.textContent = b.collapsed ? '▸' : '▾'
    b.refs.collapse.title = b.collapsed ? '展开译文' : '折叠为小标记'
    applySize(b)
    placeBubble(b, null, null)
  }

  function closeBubble(b) {
    if (!b || !b.alive) return
    b.alive = false
    removeHighlights(b)
    document.removeEventListener('mousemove', onBubbleDragMove)
    document.removeEventListener('mouseup', onBubbleDragUp)
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    // 头部那个 mousedown 监听随元素一起被移除
    b.el.remove()
    const idx = bubbles.indexOf(b)
    if (idx >= 0) bubbles.splice(idx, 1)
    if (!bubbles.length) releaseGlobalWatch()
  }

  function closeAllBubbles() {
    for (const b of [...bubbles]) closeBubble(b)
  }

  function collapseBubble(b) {
    if (!b.alive || b.collapsed) return
    toggleCollapse(b)
  }

  /**
   * 点击气泡以外的地方 → 把展开的气泡收成小标记，让开正文。
   * 点在某个气泡里时只收别的（保持"点哪个留哪个"），所以不会打断正在看的那个。
   * 用冒泡阶段的 document 监听：气泡自己的监听先跑，已经把 lastClickedBubble 填好了。
   */
  function onDocumentMouseDown() {
    const keep = lastClickedBubble
    lastClickedBubble = null
    for (const b of [...bubbles]) {
      if (!b.alive || b.collapsed || b.pinned) continue   // 固定的不收
      if (b !== keep) collapseBubble(b)
    }
  }

  // ── 滚动跟随：所有气泡一起补偿 ──────────────────────────────────────────────
  function ensureScrollWatch() {
    window.removeEventListener('scroll', onScrollFollow, true)
    window.addEventListener('scroll', onScrollFollow, true)
    window.removeEventListener('keydown', onBubbleKeyDown, true)
    window.addEventListener('keydown', onBubbleKeyDown, true)
    document.removeEventListener('mousedown', onDocumentMouseDown)
    document.addEventListener('mousedown', onDocumentMouseDown)
    window.removeEventListener('resize', onViewportResize)
    window.addEventListener('resize', onViewportResize)
  }

  function releaseGlobalWatch() {
    window.removeEventListener('scroll', onScrollFollow, true)
    window.removeEventListener('keydown', onBubbleKeyDown, true)
    document.removeEventListener('mousedown', onDocumentMouseDown)
    window.removeEventListener('resize', onViewportResize)
    clearTimeout(_reflowTimer)
  }

  function onScrollFollow() {
    for (const b of bubbles) {
      if (!b.alive || b.pinned) continue   // 固定的钉在屏幕位置，不跟着滚
      const { dx, dy } = scrollDeltaOf(b)
      const transform = 'translate(' + -dx + 'px,' + -dy + 'px)'
      b.el.style.transform = transform
      for (const hl of b.hlEls) hl.style.transform = transform
    }
  }

  // ── 气泡内容 ────────────────────────────────────────────────────────────────
  function showError(b, error, fallbackTitle) {
    if (!b.alive) return
    const message = (error && error.message) || fallbackTitle || '发生错误'
    const detail = error && error.detail ? '\n\n' + String(error.detail).slice(0, 300) : ''
    b.refs.result.hidden = true
    b.refs.status.hidden = false
    b.refs.status.classList.add('st-error')
    b.refs.status.textContent = message + detail
  }

  /**
   * 气泡标题用译文开头那截，而不是写死的"截图翻译"：
   * 一页开好几个气泡时，只有这样才能一眼对上是哪一段（折叠成小标记后更是只剩标题）。
   */
  function titleFrom(text, kind) {
    const first = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || ''
    if (!first) return kind === 'image' ? '截图翻译' : '划词翻译'
    return first.length > 14 ? first.slice(0, 14) + '…' : first
  }

  function renderResult(b, data) {
    if (!b.alive) return
    if (!data) {
      showError(b, { message: '模型未返回可显示的内容' }, '翻译失败')
      return
    }
    b.refs.status.hidden = true
    b.refs.status.classList.remove('st-error')
    b.refs.result.hidden = false
    b.refs.text.textContent = data.translation || ''
    b.refs.orig.value = data.original || ''
    b.refs.origWrap.hidden = !data.original
    b.lastOriginal = data.original || ''
    b.refs.title.textContent = titleFrom(data.translation, b.kind)

    // 截图模式没有现成的 Range：拿模型誊写的原文去页面文字里找一份（含同源 iframe）。
    // **必须校验命中位置**：此刻还没重排，真命中的话必然落在当初框选的区域里。
    // 不校验的话，正文在跨源 iframe / canvas 里时会匹配到页头、目录之类的相似文字——
    // 锚错了比不锚更糟：气泡跳到错位置，而且滚动链也会在错误的地方采集。
    if (!b.range && b.kind === 'image' && data.original) {
      const { dx, dy } = scrollDeltaOf(b)
      // 框选区域此刻在屏幕上的位置（翻译这几秒里可能滚过页面，所以要减掉累计滚动量）
      const frame = { left: b.rect.left - dx, top: b.rect.top - dy, width: b.rect.width, height: b.rect.height }
      const hit = findTextRange(data.original, frame)
      const hitRects = hit ? rangeRectsToTop({ range: hit.range, rangeRoot: hit.root }) : null
      if (hitRects && matchInsideFrame(hitRects[0], frame, 40)) {
        b.range = hit.range
        b.rangeRoot = hit.root
        b.anchorReason = 'range'
        anchorToRange(b, hitRects)
      } else {
        b.anchorReason = hit ? 'rejected' : 'notfound'
      }
    }

    updateRetranslateState(b)
    placeBubble(b, null, null)   // 标题变了要重新量一次（折叠态是自适应宽度）
    recordTranslation(b, data)
  }

  /** 落一条翻译记录到 receiver（尽力而为：失败不影响阅读）。 */
  function recordTranslation(b, data) {
    if (b.noRecord) return
    if (!data || !data.translation) return
    const first = b.hlRects[0] || { x: b.chipPos.x, y: b.chipPos.y, w: 0, h: 0 }
    // 同时打到页面控制台（F12 → Console）：工具箱面板里的那一行是给日常看的，
    // 这里是排查用的，两个入口都不依赖 receiver。
    try {
      console.log('[CoRead 翻译]', {
        overlayV: OVERLAY_VERSION,
        anchored: !!b.range,
        anchorReason: b.range ? 'range' : (b.anchorReason || ''),
        chain: (b.scrollChain || []).filter((s) => s.el).length,
        frame: b.rect.width + '×' + b.rect.height,
        canvas: b.canvasInfo || null,
        canvasChanged: !!b.canvasLayoutChanged,
      })
    } catch (e) {}
    send({
      action: 'recordTranslation',
      url: location.href,
      pageTitle: document.title || '',
      kind: b.kind,
      original: data.original || '',
      translation: data.translation,
      // 记录里存"视口 + 文档滚动量"的近似页面坐标：贴回时是重新摆放到屏幕上，
      // 内层容器滚动过的阅读页这个近似会不准（已知限制）
      pageX: Math.round(first.x + window.scrollX),
      pageY: Math.round(first.y + window.scrollY),
      pageW: Math.round(first.w),
      pageH: Math.round(first.h),
      overlayV: OVERLAY_VERSION,
      // 有没有拿到 DOM 锚点（Range）：有的话页面重排后能自动跟随。
      // reason 区分"文字没找到"（正文在跨源 iframe / canvas 里）和"找到了但位置对不上"
      anchored: !!b.range,
      anchorReason: b.range ? 'range' : (b.anchorReason || ''),
      // 滚动容器链里"内层容器"的个数（不含文档自身）。
      // 这个数掉到 0 就意味着跟随退化成"只跟窗口滚动"——排查"滚不动了"看它。
      chain: (b.scrollChain || []).filter((s) => s.el).length,
      // 画布书相关：拿到 canvas 比例锚点没有、canvas 是否被按新宽度重绘过
      canvasAnchor: !!b.canvasRef,
      canvasChanged: !!b.canvasLayoutChanged,
      canvasInfo: b.canvasInfo || null,
    })
  }

  async function onCopy(b) {
    const text = b.refs.text.textContent || ''
    if (!text) return
    const ok = await copyText(text)
    const btn = b.refs.copy
    const old = btn.textContent
    btn.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { if (b.alive) btn.textContent = old }, 1200)
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {}
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'
      els.shadow.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (e) {
      return false
    }
  }

  async function runRetranslate(b) {
    if (!b.alive || b.retranslating) return
    const text = b.refs.orig.value.trim()
    if (!text) return
    b.retranslating = true
    b.refs.retranslate.disabled = true
    const previous = b.refs.text.textContent
    b.refs.status.hidden = false
    b.refs.status.classList.remove('st-error')
    b.refs.status.textContent = '正在重译…'
    const res = await send({ action: 'translateText', text })
    b.retranslating = false
    if (!b.alive) return
    if (!res || !res.ok) {
      b.refs.status.hidden = true
      b.refs.text.textContent = previous
      b.refs.text.classList.add('st-stale')
      b.refs.text.title = (res && res.error && res.error.message) || '重译失败'
      updateRetranslateState(b)   // 失败后按钮回到可点，方便重试
      return
    }
    b.refs.status.hidden = true
    b.refs.text.classList.remove('st-stale')
    b.refs.text.title = ''
    b.refs.text.textContent = (res.data && res.data.translation) || ''
    b.refs.title.textContent = titleFrom(b.refs.text.textContent, b.kind)
    // 这下译文与当前原文对上了，按钮回到置灰。
    // 重译结果不写回记录（记录留的是首次翻译），所以「贴回页面」贴的是最初那版。
    b.lastOriginal = text
    updateRetranslateState(b)
    placeBubble(b, null, null)
  }

  // ── 气泡拖拽 ────────────────────────────────────────────────────────────────
  function onBubbleDragStart(b, e) {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = b.el.getBoundingClientRect()
    b.drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top }
    document.addEventListener('mousemove', onBubbleDragMove)
    document.addEventListener('mouseup', onBubbleDragUp)
  }

  function onBubbleDragMove(e) {
    const b = bubbles.find((x) => x.alive && x.drag)
    if (!b) return
    const left = b.drag.left + e.clientX - b.drag.x
    const top = b.drag.top + e.clientY - b.drag.y
    b.el.style.left = left + 'px'
    b.el.style.top = top + 'px'
    b.el.style.transform = 'none'
  }

  function onBubbleDragUp() {
    const b = bubbles.find((x) => x.alive && x.drag)
    document.removeEventListener('mousemove', onBubbleDragMove)
    document.removeEventListener('mouseup', onBubbleDragUp)
    if (!b) return
    b.drag = null
    // 拖到哪，锚点就挪到哪。锚点是"还没算滚动量"的位置，所以要加回累计量，
    // 否则拖完之后的滚动会让它跳一下。
    const { dx, dy } = scrollDeltaOf(b)
    const left = (parseFloat(b.el.style.left || '0') || 0) + dx
    const top = (parseFloat(b.el.style.top || '0') || 0) + dy
    b.bodyPos = { x: left, y: top }
    b.chipPos = { x: left, y: top }
  }

  // ── 划词结果 / 贴回历史 ─────────────────────────────────────────────────────
  /** 划词翻译的结果渲染：不涉及遮罩与截图，只在选区旁出气泡。 */
  function showText(data, rect, sourceText) {
    viewport = { width: window.innerWidth, height: window.innerHeight }
    const box = rect || { left: 16, top: 64, width: 0, height: 0 }
    // 划词时选区还在：核对文字一致就取它的 Range —— 逐行高亮，而且重排后能自动跟住。
    // 文字对不上（用户中途改了选区）就退回 SW 传来的那一个矩形，绝不标错地方。
    const range = liveSelectionRange(sourceText)
    const rects = (range && rectsOfRange(range)) || [box]
    const b = createBubble(box, { kind: 'text', title: '划词翻译', rects })
    b.range = range
    b.sourceText = String(sourceText || '')
    renderResult(b, { translation: (data && data.translation) || '' })
  }

  /** 取当前选区的 Range；文字与 expected 不一致时返回 null（避免标错）。 */
  function liveSelectionRange(expected) {
    try {
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount) return null
      if (normalizeText(sel.toString()) !== normalizeText(expected)) return null
      return sel.getRangeAt(0).cloneRange()
    } catch (e) {
      return null
    }
  }

  function normalizeText(s) {
    return String(s || '').replace(/[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/g, '')
  }

  /**
   * 贴回历史记录：records = [{ original, translation, pageX, pageY, kind }]。
   * 页面坐标是记录时存下来的，所以滚回原处就能看到。
   */
  function restore(records) {
    if (!Array.isArray(records) || !records.length) return 0
    viewport = { width: window.innerWidth, height: window.innerHeight }
    let shown = 0
    for (const r of records) {
      const pageX = Number(r.pageX) || 0
      const pageY = Number(r.pageY) || 0
      const w = Number(r.pageW) || 0
      const h = Number(r.pageH) || 0
      const rect = { left: pageX - window.scrollX, top: pageY - window.scrollY, width: w, height: h }
      const b = createBubble(rect, {
        kind: r.kind === 'image' ? 'image' : 'text',
        title: '译文（贴回）',
        noRecord: true,
        rects: [rect],
      })
      renderResult(b, { original: r.original || '', translation: r.translation || '' })
      shown++
    }
    return shown
  }

  // ── 与 service worker 通信 ──────────────────────────────────────────────────
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = chrome.runtime.lastError
          if (err) {
            resolve({ ok: false, error: { code: 'SW_UNAVAILABLE', message: '扩展后台无响应：' + err.message } })
            return
          }
          resolve(resp || { ok: false, error: { code: 'NO_RESPONSE', message: '扩展后台未返回结果' } })
        })
      } catch (e) {
        resolve({ ok: false, error: { code: 'SW_UNAVAILABLE', message: '扩展上下文已失效，请刷新页面后重试' } })
      }
    })
  }

  // ── 启动 ────────────────────────────────────────────────────────────────────
  // 只建 DOM，不自动动作。translate-background.js 注入完成后会再调一次具体动作。
  build()
  window.__coreadStOverlay = {
    startSelection,
    showText,
    restore,
    cancel: cancelSelection,
    closeAll: closeAllBubbles,
    count: () => bubbles.filter((b) => b.alive).length,
  }
})()
