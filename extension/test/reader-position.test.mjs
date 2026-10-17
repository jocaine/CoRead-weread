/**
 * 「阅读位置」的算术（2026-11 二次改版）。
 *
 * 位置的唯一定义：**第几页/第几章 + 页内比例 frac**。
 * 这个文件只验算术本身（存 → 恢复必须是同一个位置），DOM 那一侧由
 * agent/test/reader-position-wiring.test.js 盯接线、真环境由扩展自检的 8h 段验。
 *
 * 运行：node extension/test/reader-position.test.mjs
 *      （已挂进 package.json 的 `npm run test:ext`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { clamp01, fracInBox, positionFromBoxes, deltaToPosition } from '../reader-position.js'

/** 造一组"页盒子"：每页给高度，按页序堆叠，第一页顶端在 top0 */
function stack(heights, top0 = 0) {
  let top = top0
  return heights.map((h, i) => {
    const box = { page: i + 1, top, height: h }
    top += h
    return box
  })
}

/** 把整摞盒子按滚动量 dy 平移（模拟"滚动"） */
function scrollBy(boxes, dy) {
  return boxes.map((b) => ({ ...b, top: b.top - dy }))
}

// ── 基本口径 ─────────────────────────────────────────────────────────────────

test('参考线落在这一页的几分之几处（页顶 = 0，页底 = 1）', () => {
  assert.equal(fracInBox(100, 100, 400), 0)
  assert.equal(fracInBox(300, 100, 400), 0.5)
  assert.equal(fracInBox(500, 100, 400), 1)
  // 夹住：线跑到页外也别给出 <0 / >1 的数（那会让恢复算出一个荒唐的滚动量）
  assert.equal(fracInBox(50, 100, 400), 0)
  assert.equal(fracInBox(900, 100, 400), 1)
})

test('高度量不出来时算"页顶"，绝不吐 NaN', () => {
  assert.equal(fracInBox(300, 100, 0), 0)
  assert.equal(fracInBox(300, 100, NaN), 0)
  assert.equal(fracInBox(NaN, 100, 400), 0)
  assert.equal(clamp01(undefined), 0)
  assert.equal(clamp01(NaN), 0)
  assert.equal(clamp01(-3), 0)
  assert.equal(clamp01(9), 1)
  assert.equal(clamp01(0.42), 0.42)
})

test('位置 = 参考线所在的那一页 ×（第一个底边还在线以下的页）', () => {
  const boxes = stack([400, 400, 400])          // 三页，每页 400 高
  assert.deepEqual(positionFromBoxes(0, boxes), { page: 1, frac: 0 })
  assert.deepEqual(positionFromBoxes(200, boxes), { page: 1, frac: 0.5 })
  // 第 1 页底边正好压线（bottom === ref）→ 算下一页，与旧版 currentPage 的 `r.bottom > top` 一致
  assert.deepEqual(positionFromBoxes(400, boxes), { page: 2, frac: 0 })
  assert.deepEqual(positionFromBoxes(600, boxes), { page: 2, frac: 0.5 })
  assert.deepEqual(positionFromBoxes(1000, boxes), { page: 3, frac: 0.5 })
  // 线跑到最后一页之外（滚过头 / 量到的几何是旧的）→ 夹在"最后一页的最下面"
  assert.deepEqual(positionFromBoxes(1234, boxes), { page: 3, frac: 1 })
})

test('一页比屏幕还高时，位置落在页中间（旧版只会记"第几页"）', () => {
  // 适宽模式下常见：一页 1400 高，视口才 800
  const boxes = stack([1400, 1400])
  const pos = positionFromBoxes(700, boxes)
  assert.equal(pos.page, 1)
  assert.ok(Math.abs(pos.frac - 0.5) < 1e-9, 'frac=' + pos.frac)

  // 同一页的中段与末段必须是**不同**的位置 —— 这正是旧版丢掉的那一维
  const mid = positionFromBoxes(700, boxes)
  const low = positionFromBoxes(1200, boxes)
  assert.equal(mid.page, low.page, '都还在第 1 页')
  assert.notEqual(mid.frac, low.frac, '页内位置不同 → frac 必须不同')
})

test('滚过最后一页的底：算"最后一页最下面"，不往后跑', () => {
  const boxes = stack([400, 400])
  assert.deepEqual(positionFromBoxes(5000, boxes), { page: 2, frac: 1 })
})

test('没有页（还没开书）时给安全值 {page:1, frac:0}', () => {
  assert.deepEqual(positionFromBoxes(0, []), { page: 1, frac: 0 })
  assert.deepEqual(positionFromBoxes(0, null), { page: 1, frac: 0 })
})

// ── round-trip：存 → 恢复必须是同一处 ────────────────────────────────────────

test('round-trip：按 deltaToPosition 落位之后，量出来的还是同一个位置', () => {
  const cases = [
    { heights: [400, 400, 400], ref: 0 },
    { heights: [400, 400, 400], ref: 250 },
    { heights: [1400, 1400], ref: 700 },      // 页比视口高
    { heights: [300, 900, 300, 1200], ref: 950 },  // 页高不一（占位高与实际高不同就是这种）
    { heights: [300, 900, 300, 1200], ref: 1650 },
    { heights: [2000], ref: 1999 },           // 只有一页且很长
  ]
  for (const c of cases) {
    const boxes = stack(c.heights)
    const want = positionFromBoxes(c.ref, boxes)
    const target = boxes[want.page - 1]
    const delta = deltaToPosition(c.ref, target.top, target.height, want.frac)
    const after = scrollBy(boxes, delta)
    const got = positionFromBoxes(c.ref, after)
    assert.equal(got.page, want.page, `页对不上：${JSON.stringify(c)} → ${JSON.stringify(got)}`)
    assert.ok(Math.abs(got.frac - want.frac) < 1e-9,
      `frac 对不上：${JSON.stringify(c)} 期望 ${want.frac}，实得 ${got.frac}`)
    // 幂等：再算一次 delta 应该是 0（否则恢复会一直微调、变成"滚动条自己抖"）
    const t2 = after[got.page - 1]
    assert.ok(Math.abs(deltaToPosition(c.ref, t2.top, t2.height, got.frac)) < 1e-9, '第二次落位应当不再移动')
  }
})

test('deltaToPosition 只管"该滚多少"：线已经在位时给 0', () => {
  // 一页顶端正好压在参考线上、frac=0 → 不用滚
  assert.equal(deltaToPosition(100, 100, 400, 0), 0)
  // 同一页要落到 50% → 往下滚 200
  assert.equal(deltaToPosition(100, 100, 400, 0.5), 200)
  // 页码那页在参考线上方 300 → 得往回滚 300（再按 frac 往下 0.25*400=100）
  assert.equal(deltaToPosition(100, -200, 400, 0.25), -200)
})
