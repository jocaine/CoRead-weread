/**
 * PDF 里的「链接」怎么从注释变成可点的位置 —— 纯算术 + 地址判定。
 *
 * ── 先弄清一件容易误会的事：链接不是正文 ──────────────────────────────────────
 * PDF 里的一段蓝字下面带下划线，看起来像链接，但那只是**画在页面上的一小块图形**；
 * 真正"点了要跳"的信息写在页面的**注释**（annotation，PDF 的一种独立对象）里，
 * 子类型叫 `/Link`。pdf.js 画 canvas 时不会画它，抽文字层时也不会带上它 ——
 * 所以阅读器必须自己读 `page.getAnnotations()`，在自己的页面上铺一层可点的盒子。
 * 少了这一层，链接的样子都在，就是点不动（2026-11 用户报的就是这个）。
 *
 * ── 为什么这个文件只有纯函数 ──────────────────────────────────────────────────
 * 坐标换算错了，表现是"点偏一点才跳 / 整块区域都点不动"，而真浏览器里很难一眼看出
 * 是谁算错的。抽出来之后 node 里就能直接验（见 extension/test/reader-links.test.mjs）。
 *
 * 运行：node extension/test/reader-links.test.mjs
 */
import { clamp01 } from './reader-position.js'

/** 允许在浏览器里打开的协议。PDF 里可以塞 `javascript:` 之类的 URI，一律不认。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 把一个 URI 变成"敢真的打开"的地址；不是 http/https/mailto、或不是绝对地址 → 空串。
 *
 * 为什么必须**绝对**地址：链接注释里可以写相对路径（`/help`），但我们的 PDF 是用户
 * 从本地拖进来的，没有可靠的"相对于哪个站点"可言。猜一个基准只会打开一个错地方。
 */
export function safeExternalUrl(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim()
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch (e) {
    return ''
  }
  return SAFE_PROTOCOLS.has(u.protocol) ? u.href : ''
}

/**
 * 这条注释是不是「链接」。
 *
 * 只认 `/Link`：高亮、便签、表单那些注释 PDF 里也有，但它们在阅读器里没有可点的去处。
 * `noHTML` / `hidden` 是 pdf.js 标出来的"这条不要渲染"（隐藏注释、打印专用注释）。
 */
export function isLinkAnnotation(a) {
  if (!a) return false
  if (a.noHTML || a.hidden) return false
  // annotationType 是 pdf.js 的数字枚举（LINK = 2），subtype 是 PDF 里的原始名字。
  // 两个都看：不同 pdf.js 版本给过来的字段不完全一致，认错一个就整页链接失效。
  return a.subtype === 'Link' || a.annotationType === 2
}

/**
 * 这条链接要跳到哪儿。三种去处，按优先级：
 *   1. `url`  外部地址（http/https/mailto）→ 新标签页
 *   2. `dest` 文档内的目标（另一页的某处）→ 阅读器自己滚过去
 *   3. `action` PDF 的"命名动作"（下一页 / 首页…）→ 见 reader.js 的 runPdfNamedAction
 *
 * 返回 null 表示这条链接没有可执行的去处（比如只是挂了个附件）——这种不铺盒子，
 * 免得页面上多出一块"能点但没反应"的死区。
 */
export function linkTarget(a) {
  const url = safeExternalUrl(a && a.url) || safeExternalUrl(a && a.unsafeUrl)
  if (url) return { kind: 'url', url }
  const dest = a && a.dest
  // 空数组 / 空串都不算目标：否则会铺出一块点了必然报错的盒子
  if (dest && (typeof dest === 'string' || (Array.isArray(dest) && dest.length))) {
    return { kind: 'dest', dest }
  }
  if (a && a.action) return { kind: 'action', action: String(a.action) }
  return null
}

/** 读一组数字（普通数组或 Float32Array 都行）；有非有限数就整组作废 */
function numberList(v) {
  if (!v || typeof v.length !== 'number') return null
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const n = Number(v[i])
    if (!Number.isFinite(n)) return null
    out[i] = n
  }
  return out
}

/**
 * 一条链接注释覆盖的四边形（PDF 坐标系，单位是 pt，原点在左下角）。
 *
 * 为什么不是"一个矩形"：文字稍微斜一点时，PDF 会把它写成 `QuadPoints`（四个角）而不是
 * 一个正着的 `Rect`。pdf.js 已经把每个四边形整理成与它自己的外接矩形对齐的四个角，
 * 所以这里拿到的一定是"正着的"四边形，下面按外接矩形处理就够准。
 *
 * @returns {Array<Array<[number, number]>>} 每个元素是 4 个角 [[x,y]×4]
 */
export function linkQuads(a) {
  const qp = numberList(a && a.quadPoints)
  if (qp && qp.length >= 8 && qp.length % 8 === 0) {
    const out = []
    for (let i = 0; i < qp.length; i += 8) {
      out.push([
        [qp[i], qp[i + 1]],
        [qp[i + 2], qp[i + 3]],
        [qp[i + 4], qp[i + 5]],
        [qp[i + 6], qp[i + 7]],
      ])
    }
    return out
  }
  const r = numberList(a && a.rect)
  if (!r || r.length < 4) return []
  const x1 = Math.min(r[0], r[2])
  const x2 = Math.max(r[0], r[2])
  const y1 = Math.min(r[1], r[3])
  const y2 = Math.max(r[1], r[3])
  if (!(x2 > x1) || !(y2 > y1)) return []
  return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]]
}

/**
 * 把一条链接注释换算成"页内百分比"的盒子：`{x, y, w, h}`，取值都是 0~1。
 *
 * 为什么用百分比而不是像素：阅读器缩放时只改页盒子的宽度/高度（画布重画、文字层按
 * `--total-scale-factor` 跟着缩放），页内各处的**相对位置不变**。用百分比的话，
 * 缩放完全不用碰链接层；用像素就得在每次缩放时重算一遍，迟早漏掉某条路径。
 *
 * @param {object} a 注释（pdf.js 的 `getAnnotations()` 里的一项）
 * @param {object} viewport `page.getViewport({scale})`（只要有 width/height 和
 *   `convertToViewportPoint`；缩放倍率不影响结果，因为下面除的是同一个视口的宽高）
 */
export function linkBoxes(a, viewport) {
  const vp = viewport
  const width = Number(vp && vp.width)
  const height = Number(vp && vp.height)
  if (!(width > 0) || !(height > 0)) return []
  if (typeof vp.convertToViewportPoint !== 'function') return []
  const boxes = []
  for (const quad of linkQuads(a)) {
    const xs = []
    const ys = []
    let ok = true
    for (const [px, py] of quad) {
      const p = vp.convertToViewportPoint(px, py)
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { ok = false; break }
      xs.push(p[0])
      ys.push(p[1])
    }
    if (!ok) continue
    // 夹进页面：注释的矩形有时会比页面大出一圈（裁切框 / 页面边缘），
    // 不夹的话会盖到页缝和页码上。
    const x0 = clamp01(Math.min(...xs) / width)
    const x1 = clamp01(Math.max(...xs) / width)
    const y0 = clamp01(Math.min(...ys) / height)
    const y1 = clamp01(Math.max(...ys) / height)
    if (!(x1 > x0) || !(y1 > y0)) continue
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }
  return boxes
}

/**
 * 文档内目标（`dest` 数组）要落到目标页的**纵向哪个位置**，单位是 PDF 坐标（pt，从页底算）。
 * 返回 null = 只知道页、不知道页内位置（跳到页顶即可）。
 *
 * 为什么要读这个：书里的 "见第 12 页第 3 段" 这类链接，目标往往是**页中间的一段**；
 * 只跳到那一页的顶端，用户还得自己找。目标类型有五六种写法，纵向位置在不同下标里：
 *   `[页引用 /XYZ left top zoom]`          → top 在下标 3
 *   `[页引用 /FitH top]`                   → top 在下标 2
 *   `[页引用 /FitR left bottom right top]` → top 在下标 5
 * 其余类型（Fit / FitB…）只指定整页，没有纵向位置。
 */
export function destTop(dest) {
  if (!Array.isArray(dest)) return null
  const kind = dest[1] && dest[1].name ? String(dest[1].name) : ''
  let raw = null
  if (kind === 'XYZ') raw = dest[3]
  else if (kind === 'FitH' || kind === 'FitBH') raw = dest[2]
  else if (kind === 'FitR') raw = dest[5]
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * 点 (fx, fy)（页内百分比，0~1）落在哪一条链接上；没有就 null。
 *
 * 从后往前找：链接盒子按注释顺序铺，后铺的盖在上面，与视觉层级一致（同一处有两条
 * 重叠链接时，点到的应该是看得见的上面那条）。
 */
export function linkAt(links, fx, fy) {
  if (!Array.isArray(links)) return null
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i]
    if (!l) continue
    if (fx >= l.x && fx <= l.x + l.w && fy >= l.y && fy <= l.y + l.h) return l
  }
  return null
}
