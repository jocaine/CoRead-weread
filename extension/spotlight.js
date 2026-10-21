/**
 * 聚光灯（独立组件）—— 把真实界面上的一处挖出来照亮，其余压暗，旁边挂一张提示卡。
 *
 * 2026-10-21 从旧的教程引导里抽出来单独成类。抽的理由：那套挖洞/避让/跟随滚动的
 * **绘制**逻辑从来没出过错，出错的一直是它外面的教程状态机（跨重载、串书、例句归属）。
 * 所以这块值得做成一个"拿起来就能用"的组件，而不是跟着某个功能一起烂掉。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   import { Spotlight } from './spotlight.js'
 *
 *   const spot = new Spotlight({ dim: 0.45, padding: 8, radius: 10 })
 *   spot.onAction = (id) => { if (id === 'ok') spot.hide() }
 *   spot.pointTo('#graph-btn', {
 *     step: '1 / 2',
 *     title: '你的第一个知识点出来了',
 *     body: '点这个 ◎ 打开会意图。\n换个说法再问同一件事，图上会把命中的来路点亮。',
 *     actions: [{ id: 'open', label: '打开会意图看看', primary: true }, { id: 'later', label: '知道了' }],
 *   })
 *   // …… spot.refresh() 手动重量；spot.hide() 收掉；spot.destroy() 彻底拆掉
 *
 * ── 另外两种常见形态（都只要一个方法）──────────────────────────────────────
 *   spot.dimOnly('#某个区域')                         // **只压暗、不挂卡**：先让他看一眼，话待会儿说
 *   spot.pointTo('#按钮', {
 *     title: '点这里就行',
 *     dismissOnTargetClick: true,                 // 用户点了目标 → 自动收掉
 *     onTargetClick: () => console.log('他点了'),  // 收掉之前的回调（可选）
 *   })
 *
 * ── 它替你处理了这些麻烦事 ──────────────────────────────────────────────────
 *   · **任意多个洞**：用 SVG mask 挖洞（一个遮罩 + 白底 + 黑矩形洞），
 *     不是"四个方块围一圈"——后者多洞时会**叠色变暗**，一洞两洞看不出，三洞四洞就脏了。
 *   · **圆角与描边**：洞本身带圆角，外面一圈细描边标出边界。
 *   · **别压暗要点的东西**：页面上带 `data-spotlight-pin` 的元素（菜单、抽屉这类
 *     "用户接下来真要去点"的控件）自动一起挖出来，不用每处调用都写一遍。
 *   · **提示卡自动避让**：优先放目标下方，没地方就上方、右侧、左侧，最后夹到视口里。
 *   · **跟着动**：滚动 / 缩放 / 布局变化时重算（滚动用 capture 监听，内层滚动容器也算）。
 *   · **目标没了就收掉**：目标被移除或尺寸为 0（切了页面、抽屉关了）时自动 hide，
 *     不留一个指着空气的洞。
 *   · **不挡操作**：整层 `pointer-events: none`，只有提示卡上的按钮可点——
 *     用户点的永远是真实控件，聚光灯只是"光"。
 *
 * ── 它故意不管的事 ──────────────────────────────────────────────────────────
 *   · 不管"走到第几步"：那是业务状态机的事（谁调用谁维护）。这里只负责"照哪儿、说什么"。
 *   · 不做动画（除了按钮 hover）：引导不该抢注意力。
 *   · 不修改被测元素的任何样式，也不往它的 DOM 里插东西。
 */

const STYLE_ID = 'spotlight-style'
const ROOT_ID = 'spotlight-root'

const CSS = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
}
#${ROOT_ID}[hidden] { display: none; }
#${ROOT_ID} svg.spot-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
#${ROOT_ID} .spot-tip {
  position: fixed;
  min-width: 200px;
  /* 宽度：够读一行汉字（约 20 字），但绝不超屏；窄面板下自动收 */
  max-width: min(340px, calc(100vw - 28px));
  /* ⚠️ 这里**不能**写 max-height/overflow:auto。
     原因是小三角（.spot-arrow）绝对定位在卡片边界外 -5px 处；一旦卡片成了滚动容器，
     那个"露出去的头"就算可滚动内容 → 每次都会多出一条滚动条（2026-10-21 用户看到的那条）。
     长正文的滚动交给 .spot-body（它下面没有越界子元素）。 */
  background: #fff;
  color: #24332b;
  border-radius: 8px;
  /* 阴影取规格里的"弹层"档；间距取 2/4/6/8/10/12 刻度（见 coread-visual-spec） */
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.65;
  pointer-events: auto;
  font-family: inherit;
  /* 中文长句与长书名：宁可断行，也不许溢出卡片（以前没有这两行，长标题会把卡撑破） */
  overflow-wrap: anywhere;
  word-break: break-word;
  line-break: strict;
  text-wrap: pretty;
}
#${ROOT_ID} .spot-tip .spot-step {
  font-size: 11px;
  color: #07c160;
  font-weight: 600;
  margin-bottom: 2px;
}
#${ROOT_ID} .spot-tip .spot-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2d26;
  margin-bottom: 4px;
}
#${ROOT_ID} .spot-tip .spot-body {
  color: #4a5c53;
  /* 正文长了在这里滚，不把整张卡变成滚动容器（见 .spot-tip 那条注释） */
  max-height: calc(100vh - 180px);
  overflow: auto;
}
#${ROOT_ID} .spot-tip .spot-body b { color: #1f7a49; }
/* 一行一块（body 传数组时用）：让"每一行"真的是一行，不再靠 \n 硬折 */
#${ROOT_ID} .spot-tip .spot-line + .spot-line,
#${ROOT_ID} .spot-tip .spot-line + .spot-quote,
#${ROOT_ID} .spot-tip .spot-quote + .spot-line,
#${ROOT_ID} .spot-tip .spot-quote + .spot-quote { margin-top: 3px; }
/* 例句/话术行：左侧色条 + 浅底，跟正文分开，用户一眼看到"这是可以照抄的" */
#${ROOT_ID} .spot-tip .spot-quote {
  padding: 6px 8px;
  background: #f4fbf7;
  border-left: 2px solid #07c160;
  border-radius: 0 4px 4px 0;
  color: #285741;
}
#${ROOT_ID} .spot-tip .spot-acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
#${ROOT_ID} .spot-tip button {
  font-family: inherit;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid #cfdcd4;
  background: #fff;
  color: #2e7d4f;
  cursor: pointer;
}
#${ROOT_ID} .spot-tip button:hover { border-color: #07c160; color: #07c160; }
#${ROOT_ID} .spot-tip button.spot-primary {
  background: #07c160;
  border-color: #07c160;
  color: #fff;
  font-weight: 600;
}
#${ROOT_ID} .spot-tip button.spot-primary:hover { background: #06ad56; border-color: #06ad56; color: #fff; }
#${ROOT_ID} .spot-tip .spot-arrow {
  position: absolute;
  width: 10px; height: 10px;
  background: #fff;
  transform: rotate(45deg);
  box-shadow: -1px -1px 2px rgba(0, 0, 0, 0.06);
}
`

/** 元素是否还"真的在那儿"（在文档里、有面积） */
function visible(el) {
  if (!el || !el.isConnected) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** 解析目标：选择器 / 元素 / 元素数组（都支持） */
function toEls(target) {
  if (!target) return []
  if (typeof target === 'string') {
    try { return [...document.querySelectorAll(target)] } catch (e) { return [] }
  }
  if (Array.isArray(target)) return target.filter((x) => x && x.isConnected)
  return target.isConnected ? [target] : []
}

export class Spotlight {
  /**
   * @param {{dim?:number, padding?:number, radius?:number, duration?:number}} opts
   *   dim      压暗程度 0~1（默认 0.45）
   *   padding  洞口比目标外扩多少像素（默认 6）
   *   radius   洞口圆角（默认 8）
   */
  constructor(opts = {}) {
    // ⚠️ 这个属性**不能**叫 dim：会盖掉同名方法（自测抓到过：instance.dim 变成数字 0.45）
    this.dimAmount = typeof opts.dim === 'number' ? opts.dim : 0.45
    this.padding = typeof opts.padding === 'number' ? opts.padding : 6
    this.radius = typeof opts.radius === 'number' ? opts.radius : 8
    /** 按钮回调（缺省值）：spot.onAction = (id) => {} */
    this.onAction = null
    this._target = null
    this._tip = null
    this._els = null
    this._timer = null
    this._raf = 0
    this._clickHandler = null        // "点了目标就算做到"的文档级监听（见 _watchTargetClick）
    this._onScroll = () => this._schedule()
    this._onResize = () => this._schedule()
    this._root = null
    this._svg = null
    this._maskRect = null
    this._holes = []
    this._tipEl = null
  }

  // ── 对外 ──────────────────────────────────────────────────────────────────
  get active() { return !!(this._root && !this._root.hidden) }

  /**
   * 照亮目标并在旁边挂提示卡。
   * @param {string|Element|Element[]} target 选择器 / 元素 / 元素数组（多个 → 多个洞）
   * @param {{step?:string, title?:string, body?:string,
   *          actions?:Array<{id:string,label:string,primary?:boolean}>,
   *          placement?:'auto'|'below'|'above'|'right'|'left',
   *          onAction?:(id:string)=>void,
   *          dismissOnTargetClick?:boolean, onTargetClick?:()=>void}} tip
   *       行为选项也在这一格里（都写在文件头的用法里）：
   *         · `onAction`            只对这一次生效的按钮回调（优先于实例级 onAction）
   *         · `dismissOnTargetClick` 用户点了**目标本身**就自动收掉（引导"点它就对了"这类）
   *         · `onTargetClick`       同上，先回调再做（收掉与否仍由 dismissOnTargetClick 决定）
   *       **不传 tip 或 tip 为空对象 = 只压暗、不挂卡**（`dim()` 就是它的语法糖）。
   * @returns {boolean} 目标找得到 → true
   */
  pointTo(target, tip = {}) {
    const els = toEls(target)
    if (!els.length) { this.hide(); return false }
    this._target = target
    this._els = els
    this._tip = tip || {}
    this._centered = false
    this._ensureDom()
    this._root.hidden = false
    this._renderTip()
    this._layout()
    this._startFollow()
    this._watchTargetClick()
    return true
  }

  /** 只更新提示卡内容（目标不变） */
  setTip(tip) {
    this._tip = Object.assign({}, this._tip, tip || {})
    if (!this.active) return
    this._renderTip()
    if (this._centered) this._centerTip()
    else this._layout()
  }

  /**
   * 只压暗、不挂提示卡（dimOnly）。
   * 用在"先让用户看一眼这里有什么，话等一会儿再说"的场合（比如先照亮、再逐条讲解）。
   */
  dimOnly(target) { return this.pointTo(target, {}) }

  /**
   * 全屏压暗、**不挖洞**，卡片居中。
   *
   * 用在"纯说明"的那一步：没有具体控件可指，但又需要把注意力从界面上收回来
   *（比如讲一条行为规则："以后换个说法再问，图上会亮"）。
   * 之前我用"照一个整屏大的目标"硬凑，结果是**压暗完全看不见**、只剩一张悬空的卡——
   * 这一步就是为那种场景补的（2026-10-21 实测发现）。
   */
  cardOnly(tip = {}) {
    this._ensureDom()
    this._root.hidden = false
    this._tip = tip || {}
    this._els = []
    this._centered = true
    this._unwatchTargetClick()
    this._renderTip()
    this._renderHoles([])
    this._centerTip()
    this._startFollow()
    return true
  }

  _centerTip() {
    const el = this._tipEl
    if (!el || el.hidden) return
    const tw = el.offsetWidth
    const th = el.offsetHeight
    el.style.left = Math.max(8, Math.round((window.innerWidth - tw) / 2)) + 'px'
    el.style.top = Math.max(8, Math.round((window.innerHeight - th) / 2)) + 'px'
    const old = el.querySelector('.spot-arrow')
    if (old) old.remove()
  }


  /** 手动重量（外面改了布局时可以立刻刷一次） */
  refresh() {
    if (!this.active) return
    if (this._centered) this._centerTip()
    else this._layout()
  }

  /** 收掉（保留 DOM，下次 pointTo 直接复用） */
  hide() {
    this._stopFollow()
    this._unwatchTargetClick()
    if (this._root) this._root.hidden = true
    // 提示卡也一起藏起来：下次可能是"只压暗不挂卡"，留着上次的卡内容会闪一下
    if (this._tipEl) this._tipEl.hidden = true
    this._centered = false
    this._els = null
    this._target = null
  }

  /** 彻底拆掉（页面卸载或组件不再需要时） */
  destroy() {
    this._stopFollow()
    this._unwatchTargetClick()
    try { this._root && this._root.remove() } catch (e) {}
    this._root = null
    this._svg = null
    this._maskRect = null
    this._holes = []
    this._tipEl = null
    this._els = null
  }

  // ── 内部：DOM ─────────────────────────────────────────────────────────────
  _ensureDom() {
    if (this._root && this._root.isConnected) return
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style')
      st.id = STYLE_ID
      st.textContent = CSS
      document.head.appendChild(st)
    }
    const root = document.createElement('div')
    root.id = ROOT_ID
    // SVG 遮罩：一个白底 + 若干黑洞（mask 的黑 = 不画 → 透出下面的真实界面）
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'spot-svg')
    const defs = document.createElementNS(NS, 'defs')
    const mask = document.createElementNS(NS, 'mask')
    mask.setAttribute('id', ROOT_ID + '-mask')
    mask.setAttribute('maskUnits', 'userSpaceOnUse')
    const full = document.createElementNS(NS, 'rect')   // 白底：整屏都要画
    full.setAttribute('x', '0'); full.setAttribute('y', '0')
    full.setAttribute('fill', '#fff')
    mask.appendChild(full)
    const maskHoles = document.createElementNS(NS, 'g')  // 黑洞：每次 layout 重建
    mask.appendChild(maskHoles)
    defs.appendChild(mask)
    svg.appendChild(defs)
    const veil = document.createElementNS(NS, 'rect')
    veil.setAttribute('x', '0'); veil.setAttribute('y', '0')
    veil.setAttribute('fill', `rgba(0,0,0,${this.dimAmount})`)
    veil.setAttribute('mask', `url(#${ROOT_ID}-mask)`)
    svg.appendChild(veil)
    root.appendChild(svg)
    const tipEl = document.createElement('div')
    tipEl.className = 'spot-tip'
    tipEl.hidden = true
    root.appendChild(tipEl)
    document.body.appendChild(root)
    this._root = root
    this._svg = svg
    this._mask = mask
    this._full = full
    this._maskHoles = maskHoles
    this._veil = veil
    this._holeG = document.createElementNS(NS, 'g')      // 洞的描边画在遮罩之上
    svg.appendChild(this._holeG)
    this._tipEl = tipEl
  }

  // ── 内部：提示卡 ───────────────────────────────────────────────────────────
  _renderTip() {
    const t = this._tip || {}
    const el = this._tipEl
    if (!el) return
    const esc = (s) => String(s == null ? '' : s)
      .replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
    const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

    /**
     * 正文的换行规则（2026-10-21 改，起因是"现在看的难受"）：
     *   · `body` 传**数组** → 每一项一行（最推荐：语义清楚，不靠 \n 猜）
     *   · 传字符串 → 按 \n 切（兼容旧写法）
     *   · 一行以 `> ` 开头 → 渲染成**例句块**（左侧色条 + 浅底），告诉用户"这行能照抄"
     * 以前整段文字靠 `<br>` 硬折，中文长句会在句子中间断开，读起来像断气——
     * 现在每行一个块，折行交给浏览器的断行规则（见 CSS 里的 overflow-wrap/line-break）。
     */
    const lines = Array.isArray(t.body)
      ? t.body.map((x) => String(x))
      : (t.body ? String(t.body).split('\n') : [])
    const body = lines.length
      ? `<div class="spot-body">${lines.map((line) => (
          /^>\s?/.test(line)
            ? `<div class="spot-quote">${inline(line.replace(/^>\s?/, ''))}</div>`
            : `<div class="spot-line">${inline(line)}</div>`
        )).join('')}</div>`
      : ''
    const acts = Array.isArray(t.actions) ? t.actions : []
    el.innerHTML =
      (t.step ? `<div class="spot-step">${esc(t.step)}</div>` : '') +
      (t.title ? `<div class="spot-title">${esc(t.title)}</div>` : '') +
      body +
      (acts.length
        ? `<div class="spot-acts">${acts.map((a) =>
            `<button type="button" data-act="${esc(a.id || '')}"${a.primary ? ' class="spot-primary"' : ''}>${esc(a.label || a.id || '好')}</button>`
          ).join('')}</div>`
        : '')
    el.hidden = !(t.step || t.title || body || acts.length)
    el.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = b.dataset.act
        // 单次回调优先（同一个实例会被不同引导复用，实例级 onAction 只当缺省）
        const cb = (t.onAction || this.onAction)
        try { cb && cb(id, this) } catch (err) {}
      })
    })
  }

  /**
   * "用户点了目标就算做到了"（引导里最自然的一条出口）。
   *
   * 为什么用**文档级 capture 监听**：遮罩整层是 `pointer-events: none`，用户点的一直是
   * 真实控件；在捕获阶段听一次就能知道他点了哪儿，不用给目标改样式、也不用包一层。
   * 点提示卡自己的按钮不算（那是 onAction 的事）。
   */
  _watchTargetClick() {
    this._unwatchTargetClick()
    if (!(this._tip && this._tip.dismissOnTargetClick && typeof this._tip.onTargetClick === 'function')
      && !(this._tip && this._tip.dismissOnTargetClick)) return
    this._clickHandler = (e) => {
      if (!this.active || !this._els) return
      if (this._root && this._root.contains(e.target)) return   // 点的是提示卡
      const hit = this._els.some((el) => el === e.target || (el.contains && el.contains(e.target)))
      if (!hit) return
      const cb = this._tip && this._tip.onTargetClick
      try { cb && cb(this) } catch (err) {}
      if (this._tip && this._tip.dismissOnTargetClick) this.hide()
    }
    document.addEventListener('click', this._clickHandler, true)
  }

  _unwatchTargetClick() {
    if (this._clickHandler) {
      document.removeEventListener('click', this._clickHandler, true)
      this._clickHandler = null
    }
  }

  // ── 内部：量尺寸与摆位 ────────────────────────────────────────────────────
  _schedule() {
    if (this._raf) return
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._layout() })
  }

  _startFollow() {
    this._stopFollow()
    window.addEventListener('scroll', this._onScroll, true)
    window.addEventListener('resize', this._onResize)
    // 布局可能因为别的原因变（抽屉打开、字体加载、列表渲染）：低频兜底重量
    this._timer = setInterval(() => this._schedule(), 400)
  }

  _stopFollow() {
    window.removeEventListener('scroll', this._onScroll, true)
    window.removeEventListener('resize', this._onResize)
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
  }

  _layout() {
    if (!this.active) return
    // 居中模式（cardOnly）：整屏压暗、一个洞都不挖，只把卡摆中间
    if (this._centered) {
      this._renderHoles([])
      this._centerTip()
      return
    }
    if (!this._els) return
    const els = this._els.filter(visible)
    if (!els.length) { this.hide(); return }   // 目标没了 → 不留一个指着空气的洞

    // 洞口 = 目标矩形 + 所有 data-spotlight-pin 元素（"用户接下来要去点"的东西）
    const rects = []
    const pushRect = (r) => rects.push({
      x: r.left - this.padding, y: r.top - this.padding,
      w: r.width + this.padding * 2, h: r.height + this.padding * 2,
    })
    for (const el of els) pushRect(el.getBoundingClientRect())
    for (const el of document.querySelectorAll('[data-spotlight-pin]')) {
      if (visible(el)) pushRect(el.getBoundingClientRect())
    }

    this._renderHoles(rects)
    this._placeTip(rects[0])
  }

  /** 把遮罩尺寸与"洞"画出来（rects 为空 = 整屏压暗、不挖洞） */
  _renderHoles(rects) {
    const NS = 'http://www.w3.org/2000/svg'
    const vw = window.innerWidth
    const vh = window.innerHeight
    // mask 用的是 userSpaceOnUse，所以白底 / 遮罩的尺寸要**写成数字**，不能用 100%
    this._full.setAttribute('width', String(vw))
    this._full.setAttribute('height', String(vh))
    this._veil.setAttribute('width', String(vw))
    this._veil.setAttribute('height', String(vh))

    this._maskHoles.replaceChildren()
    this._holeG.replaceChildren()
    for (const r of rects || []) {
      const hole = document.createElementNS(NS, 'rect')
      hole.setAttribute('x', String(r.x)); hole.setAttribute('y', String(r.y))
      hole.setAttribute('width', String(r.w)); hole.setAttribute('height', String(r.h))
      hole.setAttribute('rx', String(this.radius))
      hole.setAttribute('fill', '#000')                     // mask 里黑色 = 不画 = 透出真实界面
      this._maskHoles.appendChild(hole)
      const ring = document.createElementNS(NS, 'rect')       // 洞口描边（画在遮罩之上）
      ring.setAttribute('x', String(r.x)); ring.setAttribute('y', String(r.y))
      ring.setAttribute('width', String(r.w)); ring.setAttribute('height', String(r.h))
      ring.setAttribute('rx', String(this.radius))
      ring.setAttribute('fill', 'none')
      ring.setAttribute('stroke', 'rgba(7,193,96,.9)')
      ring.setAttribute('stroke-width', '1.5')
      this._holeG.appendChild(ring)
    }
  }

  _placeTip(hole) {
    const el = this._tipEl
    if (!el || el.hidden) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const tw = el.offsetWidth
    const th = el.offsetHeight
    const gap = 10
    const pref = (this._tip && this._tip.placement) || 'auto'
    const fit = (x, y) => x >= 8 && y >= 8 && x + tw <= vw - 8 && y + th <= vh - 8
    const cands = []
    if (pref === 'below' || pref === 'auto') cands.push({ x: hole.x + hole.w / 2 - tw / 2, y: hole.y + hole.h + gap, side: 'top' })
    if (pref === 'above' || pref === 'auto') cands.push({ x: hole.x + hole.w / 2 - tw / 2, y: hole.y - th - gap, side: 'bottom' })
    if (pref === 'right' || pref === 'auto') cands.push({ x: hole.x + hole.w + gap, y: hole.y + hole.h / 2 - th / 2, side: 'left' })
    if (pref === 'left' || pref === 'auto') cands.push({ x: hole.x - tw - gap, y: hole.y + hole.h / 2 - th / 2, side: 'right' })
    let pick = cands.find((c) => fit(c.x, c.y)) || cands[0]
    const x = Math.min(Math.max(8, pick.x), vw - tw - 8)
    const y = Math.min(Math.max(8, pick.y), vh - th - 8)
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    // 小三角：贴在提示卡朝向洞口的那条边上
    const old = el.querySelector('.spot-arrow')
    if (old) old.remove()
    const arrow = document.createElement('div')
    arrow.className = 'spot-arrow'
    const cx = hole.x + hole.w / 2
    if (pick.side === 'top') {
      arrow.style.left = Math.min(Math.max(10, cx - x - 5), tw - 20) + 'px'
      arrow.style.top = '-5px'
    } else if (pick.side === 'bottom') {
      arrow.style.left = Math.min(Math.max(10, cx - x - 5), tw - 20) + 'px'
      arrow.style.bottom = '-5px'
    } else if (pick.side === 'left') {
      arrow.style.left = '-5px'
      arrow.style.top = Math.min(Math.max(10, hole.y + hole.h / 2 - y - 5), th - 20) + 'px'
    } else {
      arrow.style.right = '-5px'
      arrow.style.top = Math.min(Math.max(10, hole.y + hole.h / 2 - y - 5), th - 20) + 'px'
    }
    el.appendChild(arrow)
  }
}

/** 单例方便：不想自己管实例时用这个 */
let _shared = null
export function sharedSpotlight(opts) {
  if (!_shared) _shared = new Spotlight(opts)
  return _shared
}
