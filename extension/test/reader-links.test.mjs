/**
 * PDF 链接（注释 /Link）的几何与去处 —— 纯函数单测。
 *
 * 这个文件盯的是三件"肉眼很难看出错"的事：
 *   1. PDF 坐标（原点在左下）→ 页内百分比（原点在左上）的换算；
 *   2. 只放行 http/https/mailto（PDF 里能塞 `javascript:`）；
 *   3. 文档内目标该落到页内哪一处（不同目标类型下标不同）。
 *
 * 运行：node extension/test/reader-links.test.mjs
 *      （已挂进 package.json 的 `npm run test:ext`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  safeExternalUrl,
  isLinkAnnotation,
  linkTarget,
  linkQuads,
  linkBoxes,
  destTop,
  linkAt,
} from '../reader-links.js'

/**
 * 造一个 612×792 的视口替身。`convertToViewportPoint` 做的是 pdf.js 里那件核心的事：
 * PDF 的 y 从页底往上数，DOM 的 y 从页顶往下数，所以 y 要翻过来（792 - y）。
 */
const viewport = {
  width: 612,
  height: 792,
  convertToViewportPoint: (x, y) => [x, 792 - y],
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)

// ── 外部地址 ─────────────────────────────────────────────────────────────────

test('只认 http / https / mailto 的绝对地址', () => {
  assert.equal(safeExternalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(safeExternalUrl('http://example.com/'), 'http://example.com/')
  assert.equal(safeExternalUrl('mailto:someone@example.com'), 'mailto:someone@example.com')
  assert.equal(safeExternalUrl('HTTPS://Example.com/x'), 'https://example.com/x')
})

test('危险/相对/空地址一律不认（宁可点不动，也不打开一个错地方）', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '')
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), '')
  assert.equal(safeExternalUrl('file:///C:/Windows/System32/calc.exe'), '')
  assert.equal(safeExternalUrl('/relative/path'), '')
  assert.equal(safeExternalUrl('example.com'), '')       // 没有协议：不猜
  assert.equal(safeExternalUrl(''), '')
  assert.equal(safeExternalUrl('   '), '')
  assert.equal(safeExternalUrl(null), '')
  assert.equal(safeExternalUrl(undefined), '')
})

// ── 哪些注释算链接 ───────────────────────────────────────────────────────────

test('只认 /Link，且跳过 pdf.js 标了"别渲染"的注释', () => {
  assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 1, 1] }), true)
  assert.equal(isLinkAnnotation({ annotationType: 2, rect: [0, 0, 1, 1] }), true)
  assert.equal(isLinkAnnotation({ subtype: 'Highlight', rect: [0, 0, 1, 1] }), false)
  assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 1, 1], hidden: true }), false)
  assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 1, 1], noHTML: true }), false)
  assert.equal(isLinkAnnotation(null), false)
})

test('链接去处：地址 → 文档内目标 → 命名动作；都没有就不认', () => {
  assert.deepEqual(linkTarget({ url: 'https://example.com/' }), { kind: 'url', url: 'https://example.com/' })
  // url 被 pdf.js 判成不安全时，退回去看 dest：不能因为地址坏就整条丢掉
  assert.deepEqual(linkTarget({ url: 'javascript:1', dest: [{ num: 3, gen: 0 }, { name: 'Fit' }] }),
    { kind: 'dest', dest: [{ num: 3, gen: 0 }, { name: 'Fit' }] })
  assert.deepEqual(linkTarget({ action: 'NextPage' }), { kind: 'action', action: 'NextPage' })
  assert.equal(linkTarget({ url: 'javascript:1' }), null)
  // 空的 dest 数组不是目标：铺了盒子只会"点了报错"
  assert.equal(linkTarget({ dest: [] }), null)
  assert.equal(linkTarget({ dest: '' }), null)
  assert.equal(linkTarget({}), null)
})

// ── 坐标换算 ─────────────────────────────────────────────────────────────────

test('矩形链接：PDF 的 y 从页底数 → 页内百分比从页顶数', () => {
  // 页面高 792；链接在 PDF 里 y=700~720（靠近页顶），换算到 DOM 是 72~92
  const boxes = linkBoxes({ rect: [100, 700, 200, 720] }, viewport)
  assert.equal(boxes.length, 1)
  close(boxes[0].x, 100 / 612)
  close(boxes[0].y, 72 / 792)
  close(boxes[0].w, 100 / 612)
  close(boxes[0].h, 20 / 792)
})

test('Rect 的四个数写反了也能认（PDF 只要求两个角，不要求顺序）', () => {
  const a = linkBoxes({ rect: [200, 720, 100, 700] }, viewport)
  const b = linkBoxes({ rect: [100, 700, 200, 720] }, viewport)
  assert.deepEqual(a, b)
})

test('用了 QuadPoints 时按每个四边形各铺一块（一段跨行的链接 = 多个盒子）', () => {
  // 两行：第一行 y 700~720，第二行 y 660~680
  const quadPoints = [
    100, 720, 200, 720, 100, 700, 200, 700,
    100, 680, 200, 680, 100, 660, 200, 660,
  ]
  const boxes = linkBoxes({ rect: [100, 660, 200, 720], quadPoints }, viewport)
  assert.equal(boxes.length, 2)
  close(boxes[0].y, 72 / 792)
  close(boxes[1].y, 112 / 792)
  close(boxes[0].h, 20 / 792)
})

test('超出页面的部分夹回页内（否则会盖到页缝与页码上）', () => {
  const boxes = linkBoxes({ rect: [-50, -50, 700, 900] }, viewport)
  assert.equal(boxes.length, 1)
  close(boxes[0].x, 0)
  close(boxes[0].y, 0)
  close(boxes[0].w, 1)
  close(boxes[0].h, 1)
})

test('零面积 / 没有坐标的注释不铺盒子；视口没尺寸时也如实返回空', () => {
  assert.deepEqual(linkBoxes({ rect: [100, 700, 100, 720] }, viewport), [])
  assert.deepEqual(linkBoxes({ rect: [100, 700, 200, 700] }, viewport), [])
  assert.deepEqual(linkBoxes({ rect: [100, 700, 200, 720] }, { width: 0, height: 0 }), [])
  assert.deepEqual(linkBoxes({}, viewport), [])
  assert.deepEqual(linkBoxes({ rect: [NaN, 0, 10, 10] }, viewport), [])
})

test('缩放不影响结果：换成 2 倍视口，百分比完全一样', () => {
  const scaled = {
    width: 1224,
    height: 1584,
    convertToViewportPoint: (x, y) => [x * 2, (792 - y) * 2],
  }
  const a = linkBoxes({ rect: [100, 700, 200, 720] }, viewport)
  const b = linkBoxes({ rect: [100, 700, 200, 720] }, scaled)
  assert.deepEqual(a, b)
})

test('linkQuads 兼容 Float32Array（pdf.js 实际给的就是它）', () => {
  const qp = Float32Array.from([100, 720, 200, 720, 100, 700, 200, 700])
  const quads = linkQuads({ quadPoints: qp })
  assert.equal(quads.length, 1)
  assert.deepEqual(quads[0][0], [100, 720])
})

// ── 文档内目标的位置 ─────────────────────────────────────────────────────────

test('destTop 按目标类型从不同下标读纵向位置', () => {
  const pageRef = { num: 9, gen: 0 }
  assert.equal(destTop([pageRef, { name: 'XYZ' }, null, 700, null]), 700)
  assert.equal(destTop([pageRef, { name: 'FitH' }, 640]), 640)
  assert.equal(destTop([pageRef, { name: 'FitBH' }, 640]), 640)
  assert.equal(destTop([pageRef, { name: 'FitR' }, 0, 100, 612, 750]), 750)
  // 只指定整页的类型没有纵向位置
  assert.equal(destTop([pageRef, { name: 'Fit' }]), null)
  assert.equal(destTop([pageRef, { name: 'XYZ' }, null, null, null]), null)
  // 命名目标（字符串）在 reader.js 里先经 getDestination 解析成数组，这里只认数组
  assert.equal(destTop('chapter3'), null)
  assert.equal(destTop(null), null)
})

// ── 命中判定 ─────────────────────────────────────────────────────────────────

test('点落在盒子内才命中（边界算命中），重叠时取上面那条', () => {
  const links = [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.1, id: 'under' },
    { x: 0.15, y: 0.1, w: 0.1, h: 0.1, id: 'over' },
  ]
  assert.equal(linkAt(links, 0.05, 0.15), null)
  // 两条重叠：后铺的那条盖在上面，点到的是它
  assert.equal(linkAt(links, 0.2, 0.15).id, 'over')
  assert.equal(linkAt(links, 0.16, 0.15).id, 'over')
  // 边界：正好压在右边 / 下边也算点到了
  assert.equal(linkAt(links, 0.3, 0.2).id, 'under')
  assert.equal(linkAt(links, 0.31, 0.15), null)
})

test('没有链接时返回 null，不抛异常', () => {
  assert.equal(linkAt([], 0.5, 0.5), null)
  assert.equal(linkAt(null, 0.5, 0.5), null)
  assert.equal(linkAt([null], 0.5, 0.5), null)
})
