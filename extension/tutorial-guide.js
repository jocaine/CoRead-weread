/**
 * 侧栏里的「聚光灯引导」——游戏新手关那种做法。
 *
 * ── 它跟"自动播放的动画"差在哪（2026-11 用户明确要求）────────────────────────
 * 动画是**看它演**，引导是**让你做**。所以这一层做四件事：
 *   ① 把界面压暗（四块半透明遮罩挖一个洞，洞就落在真实控件上）；
 *   ② 在洞旁边说一句话："点这里"；
 *   ③ **你必须真的做那一下**才往下走（点错会被拦下并提示，不是干看着）；
 *   ④ 卡住了能跳过、不想看了能退出。
 *
 * 为什么挖洞用四块 div 而不是 `box-shadow: 0 0 0 9999px rgba(0,0,0,.5)` 那种写法：
 * 后者要给洞元素设 `pointer-events: none` 才能让点击穿过去，而"点错要被拦下"
 * 恰恰要求遮罩能吃到点击。四块遮罩天然满足：洞是真的空的，点它落到真控件上。
 */

const MASK_CLASS = 'tut-mask'
const TIP_ID = 'tut-guide-tip'

let layer = null      // { root, masks: [4], tip, title, body, progress, target, onWrong }
let active = false

function ensureCss() {
  if (document.getElementById('tut-guide-css')) return
  const style = document.createElement('style')
  style.id = 'tut-guide-css'
  style.textContent = `
    .${MASK_CLASS} {
      position: fixed;
      z-index: 900;
      background: rgba(18, 20, 24, .55);
      transition: opacity .2s ease;
    }
    #${TIP_ID} {
      position: fixed;
      z-index: 910;
      width: min(300px, 88vw);
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, .30);
      padding: 13px 15px 12px;
      font-size: 13px;
      line-height: 1.65;
      color: #23262b;
    }
    #${TIP_ID} .tg-head {
      display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;
    }
    #${TIP_ID} .tg-step {
      font-size: 11px; font-weight: 700; letter-spacing: .06em;
      color: #0a7d43; background: #eaf7f0; border-radius: 4px; padding: 1px 6px;
      flex: none;
    }
    /* 这是"第几课"：顶部那行写清"哪一课 · 第几步"，用户才知道自己在整个教程的哪儿 */
    #${TIP_ID} .tg-lesson {
      font-size: 11.5px; color: #8a8f98; width: 100%; margin-top: 2px;
    }
    #${TIP_ID} .tg-title { font-weight: 650; font-size: 13.5px; }
    #${TIP_ID} .tg-body { color: #4b5563; }
    #${TIP_ID} .tg-acts {
      display: flex; gap: 8px; align-items: center; margin-top: 11px; flex-wrap: wrap;
    }
    /* 例句按钮可能有好几条，让它们各占一行、文字不截断 */
    #${TIP_ID} .tg-acts .tg-wide {
      flex: 1 1 100%; text-align: left; white-space: normal; line-height: 1.5;
    }
    #${TIP_ID} button {
      font: inherit; font-size: 12px; border-radius: 7px; cursor: pointer;
      padding: 4px 11px; border: 1px solid #d8dde3; background: #fff; color: #23262b;
    }
    #${TIP_ID} button.tg-primary {
      border-color: #a8dcc0; background: #eaf7f0; color: #0a7d43; font-weight: 600;
    }
    #${TIP_ID} button:hover { background: #f2f5f7; }
    #${TIP_ID} .tg-quit {
      margin-left: auto; border: 0; background: transparent; color: #9aa0a6; padding: 4px 2px;
    }
    #${TIP_ID} .tg-quit:hover { color: #a82e22; background: transparent; }
    /* 点错时抖一下：告诉用户"不是这里"，而不是让他以为教程坏了 */
    #${TIP_ID}.tg-wrong { animation: tg-shake .32s ease; }
    @keyframes tg-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-5px); }
      75% { transform: translateX(5px); }
    }
  `
  document.head.appendChild(style)
}

function build() {
  if (layer) return layer
  ensureCss()
  const root = document.createElement('div')
  root.id = 'tut-guide-layer'
  const masks = []
  for (let i = 0; i < 4; i++) {
    const m = document.createElement('div')
    m.className = MASK_CLASS
    m.addEventListener('click', (ev) => { ev.stopPropagation(); onWrongClick(ev) }, true)
    root.appendChild(m)
    masks.push(m)
  }
  const tip = document.createElement('div')
  tip.id = TIP_ID
  tip.hidden = true
  tip.innerHTML =
    `<div class="tg-head"><span class="tg-step"></span><span class="tg-title"></span><span class="tg-lesson"></span></div>` +
    `<div class="tg-body"></div>` +
    `<div class="tg-acts"></div>`
  root.appendChild(tip)
  document.body.appendChild(root)
  layer = {
    root,
    masks,
    tip,
    step: tip.querySelector('.tg-step'),
    lesson: tip.querySelector('.tg-lesson'),
    title: tip.querySelector('.tg-title'),
    body: tip.querySelector('.tg-body'),
    acts: tip.querySelector('.tg-acts'),
    target: null,
    targetId: '',
    onWrong: null,
    wrongTimer: 0,
  }
  window.addEventListener('resize', () => { if (active) place() })
  // 目标可能在滚动容器里（引用卡列表、消息区）——滚动也要跟着挪
  window.addEventListener('scroll', () => { if (active) place() }, true)
  return layer
}

function onWrongClick(ev) {
  const l = layer
  if (!l || !active) return
  // 点错：抖一下 + 说一句"点这里"，不推进
  const t = l.tip
  t.classList.remove('tg-wrong')
  void t.offsetWidth          // 强制重排，动画才会重新播
  t.classList.add('tg-wrong')
  clearTimeout(l.wrongTimer)
  l.wrongTimer = setTimeout(() => t.classList.remove('tg-wrong'), 420)
  if (typeof l.onWrong === 'function') l.onWrong(ev)
}

/**
 * 「永不遮挡」标记：带 `data-guide-pin` 的元素**任何一步都不压暗**。
 *
 * 为什么需要（2026-11 用户实测）：遮罩原来只挖一个洞，于是"这一步要你点 A"的时候，
 * 界面上别的东西全都点不动。用户报的正是这个——第 2 步要让他挑一句样例引文，
 * 而引用抽屉在侧栏里，被遮罩压着，他只能点"跳过"。
 * 一个真实界面上常常需要同时够到两三处（目标 + 装它的容器），所以要支持多个洞。
 */
const PIN_SELECTOR = '[data-guide-pin]'

/**
 * 极简标记 → HTML。只支持 `**强调**`、换行、`<br>`。
 *
 * 为什么需要：引导文案是"教程"，一段话里要有重点和断句；纯 textContent 会把 `**` 和 `<br>`
 * 原样显示出来（踩过：卡片上直接印着 `**我准备的例句**`）。
 * 只处理这三种、并且**先把 HTML 转义掉**再放标记回来——课程表虽然是静态文件，
 * 但没有理由在这条路上留一个"以后有人往里写用户输入就出事"的口子。
 */
function miniMd(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\n/g, '<br>')
}

/** 当前该"看得见也点得到"的矩形：目标 + 所有被标记的元素 */
function holes() {
  const l = layer
  const out = []
  const t = l && l.target ? (typeof l.target === 'function' ? l.target() : l.target) : null
  const add = (el, pad) => {
    if (!el || !el.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) return
    out.push({
      left: Math.max(0, r.left - pad),
      top: Math.max(0, r.top - pad),
      right: Math.min(window.innerWidth, r.right + pad),
      bottom: Math.min(window.innerHeight, r.bottom + pad),
    })
  }
  add(t, 6)
  for (const el of document.querySelectorAll(PIN_SELECTOR)) add(el, 2)
  return out
}

/**
 * 用"按洞的边界切格子、合并成矩形"的办法算遮罩。
 *
 * 不用"目标四边各一块"那种固定四块的做法，是因为它**只能有一个洞**。
 * 这里做的是通用解：把屏幕按每个洞的左右边界切成竖条，按上下边界切成横条，
 * 逐格判断"这一格有没有被某个洞完全盖住"，没盖住就并进当前矩形——于是
 * 一个洞得到 4 块（与旧行为一致），两个洞得到 6~8 块，都能正确压暗。
 * 格子数最多 (2n+1)²，n 通常 ≤ 4，可以忽略。
 */
function buildMasks(hs) {
  const W = window.innerWidth
  const H = window.innerHeight
  if (!hs.length) return [{ left: 0, top: 0, width: W, height: H }]
  const vx = [...new Set([0, W, ...hs.map((h) => h.left), ...hs.map((h) => h.right)])].sort((a, b) => a - b)
  const hy = [...new Set([0, H, ...hs.map((h) => h.top), ...hs.map((h) => h.bottom)])].sort((a, b) => a - b)
  const covered = (x, y) => hs.some((h) => x >= h.left && x <= h.right && y >= h.top && y <= h.bottom)
  const rects = []
  for (let i = 0; i < vx.length - 1; i++) {
    let runStart = null
    for (let j = 0; j < hy.length - 1; j++) {
      const x = (vx[i] + vx[i + 1]) / 2
      const y = (hy[j] + hy[j + 1]) / 2
      const solid = !covered(x, y)
      if (solid && runStart === null) runStart = hy[j]
      const last = j === hy.length - 2
      if ((!solid || last) && runStart !== null) {
        const end = solid && last ? hy[j + 1] : hy[j]
        if (end - runStart > 0 && vx[i + 1] - vx[i] > 0) {
          rects.push({ left: vx[i], top: runStart, width: vx[i + 1] - vx[i], height: end - runStart })
        }
        runStart = null
      }
    }
  }
  return rects
}

/** 把遮罩摆到"所有该露出来的地方之外"（目标 + data-guide-pin，可多块） */
function place() {
  const l = layer
  if (!l || !l.target) return
  const hs = holes()
  if (!hs.length) { hideMasks(); return }
  const rects = buildMasks(hs)
  // 需要几块就补几块（遮罩块数量随洞数变化，不能写死 4）
  while (l.masks.length < rects.length) {
    const m = document.createElement('div')
    m.className = MASK_CLASS
    l.root.appendChild(m)
    l.masks.push(m)
  }
  l.masks.forEach((m, i) => {
    const g = rects[i]
    if (!g) { m.style.display = 'none'; return }
    m.style.display = 'block'
    m.style.left = g.left + 'px'
    m.style.top = g.top + 'px'
    m.style.width = g.width + 'px'
    m.style.height = g.height + 'px'
  })
  // 提示气泡放在目标下方（放不下就放上方），并夹在窗口内
  const t = hs[0]
  const tipW = l.tip.offsetWidth || 300
  const tipH = l.tip.offsetHeight || 120
  const W = window.innerWidth
  const H = window.innerHeight
  const left = Math.min(Math.max(8, t.left + 6), Math.max(8, W - tipW - 8))
  let top = t.bottom + 10
  if (top + tipH > H - 8) top = Math.max(8, t.top - tipH - 10)
  l.tip.style.left = left + 'px'
  l.tip.style.top = top + 'px'
}

function hideMasks() {
  if (!layer) return
  for (const m of layer.masks) m.style.display = 'none'
}

/**
 * 开始一步引导。
 * @param {{target:HTMLElement|Function, step?:string, title:string, body?:string,
 *          actions?:Array<{label:string, primary?:boolean, onClick:Function}>,
 *          onQuit?:Function, onWrong?:Function}} opts
 *   `target` 可以传函数：每帧现取（列表重排、卡片刚渲染出来时用得上）
 */
export function showStep(opts) {
  const l = build()
  active = true
  l.target = opts.target || null
  l.targetId = opts.targetId || ''
  l.onWrong = opts.onWrong || null
  l.step.textContent = opts.step || ''
  l.step.hidden = !opts.step
  l.lesson.textContent = opts.lesson || ''
  l.lesson.hidden = !opts.lesson
  l.title.textContent = opts.title || ''
  // 正文允许我们自己的极简标记（`**强调**` 与 `<br>`）——课程表里用它们分段。
  // ⚠️ 只对**我们自己写的**文案用 innerHTML（课程表是打包进扩展的静态文件，不含用户输入）；
  // 任何来自外部的文字都必须走 textContent，否则就是一个注入点。
  l.body.innerHTML = miniMd(opts.body || '')
  l.body.hidden = !opts.body
  l.acts.replaceChildren()
  for (const a of opts.actions || []) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = a.label
    // 例句按钮上的文字会被截短（卡片放不下整句），所以把全文挂到 title 上
    if (a.title) b.title = a.title
    if (a.primary) b.className = 'tg-primary'
    // 例句按钮可能很多条：让它们换行、别把卡片撑得横向溢出
    if (a.wide) b.classList.add('tg-wide')
    b.addEventListener('click', () => a.onClick && a.onClick())
    l.acts.appendChild(b)
  }
  if (opts.onQuit) {
    const q = document.createElement('button')
    q.type = 'button'
    q.className = 'tg-quit'
    q.textContent = '退出教程'
    q.addEventListener('click', () => opts.onQuit())
    l.acts.appendChild(q)
  }
  l.tip.hidden = false
  place()
  // 布局还没落定时（元素刚渲染）再摆一次
  setTimeout(place, 60)
  setTimeout(place, 240)
  return true
}

/** 目标变了/内容变了，重新摆一次（不重建） */
export function refresh() { place() }

/** 收掉引导层 */
export function hide() {
  active = false
  if (!layer) return
  layer.target = null
  layer.onWrong = null
  layer.tip.hidden = true
  hideMasks()
}

/** 现在有没有在引导（自测与业务逻辑都要问这一句） */
export function isActive() { return active }

/** 当前引导的目标（自测用：确认高亮的到底是谁） */
export function currentTarget() {
  if (!layer || !layer.target) return null
  const el = typeof layer.target === 'function' ? layer.target() : layer.target
  if (!el || !el.getBoundingClientRect) return null
  const r = el.getBoundingClientRect()
  return {
    // id 一并报出来：自测要断言"这一步高亮的确实是那个控件"，
    // 光有 class 与坐标说明不了问题（踩过：位置对了但高亮在别的元素上）
    id: el.id || layer.targetId || '',
    cls: String(el.className || '').slice(0, 60),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  }
}
