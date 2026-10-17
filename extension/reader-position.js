/**
 * 「阅读位置」的算术（2026-11 二次改版）。
 *
 * ── 位置的唯一定义 ────────────────────────────────────────────────────────────
 *   位置 = **第几页/第几章 + 页内比例 frac**（0 = 那一页的顶端，1 = 那一页的底端）
 *
 * 为什么要有 frac：旧版只记"第几页"，恢复时滚到那一页的**顶端** —— 用户停在页面
 * 下半部分离开，下次打开回到上半部分，等于没记住"读到哪儿"。适宽下一页往往比屏幕高，
 * 教程书一章好几屏，所以"同一页"并不等于"同一处"（2026-11 用户报的就是这个）。
 *
 * ── 为什么算术单独放一个文件 ──────────────────────────────────────────────────
 * 它决定"存什么、恢复到哪"，算错了表现是"位置差一点/差一截"，而那种错在真浏览器里
 * 很难一眼看出是谁算错的。抽成纯函数之后，node 里就能直接验：
 * 存 → 恢复 必须是**同一个位置**（见 extension/test/reader-position.test.mjs）。
 * reader.js 只负责把 DOM 的矩形喂进来、把算出来的滚动量落下去。
 *
 * ⚠️ 与 `currentPage()` 的旧口径保持一致：参考线是**滚动区顶端那条线**
 * （reader.js 里是 `els.scroll.getBoundingClientRect().top + 8`，那 8px 是给顶栏留的）。
 * 判定"在哪一页"的规则也一模一样：第一个**底边还在参考线以下**的页。
 */

/** 把比例夹到 [0,1]；不是有限数就当 0（宁可当成"页顶"，也不要算出个 NaN 滚到天上去） */
export function clamp01(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * 参考线落在这一页的几分之几处。
 * @param {number} ref 参考线的视口纵坐标
 * @param {number} top 这一页盒子的视口纵坐标
 * @param {number} height 这一页盒子的高度
 */
export function fracInBox(ref, top, height) {
  const h = Number(height)
  if (!Number.isFinite(h) || h <= 0) return 0
  return clamp01((Number(ref) - Number(top)) / h)
}

/**
 * 从"每一页的盒子"里读出当前位置。
 * @param {number} ref 参考线的视口纵坐标
 * @param {Array<{page:number, top:number, height:number}>} boxes 按页序
 * @returns {{page:number, frac:number}} 没有任何盒子时给 `{page:1, frac:0}`（没有书的状态）
 */
export function positionFromBoxes(ref, boxes) {
  const list = Array.isArray(boxes) ? boxes : []
  for (const b of list) {
    const h = Number(b && b.height) || 0
    if (Number(b && b.top) + h > Number(ref)) {
      return { page: Number(b.page) || 1, frac: fracInBox(ref, b.top, h) }
    }
  }
  const last = list[list.length - 1]
  if (!last) return { page: 1, frac: 0 }
  // 滚过最后一页的底：算"最后一页的最下面"，别再往后跑
  return { page: Number(last.page) || 1, frac: 1 }
}

/**
 * 要让 `frac` 落在参考线上，滚动位置该**增加**多少（纯增量，调用方加上当前 scrollTop）。
 *
 * 这是 `positionFromBoxes` 的反运算：把结果落下去之后，这一页的顶端会落在
 * `ref - frac*height`，于是参考线正好又量出同一个 `frac`（round-trip 见单测）。
 */
export function deltaToPosition(ref, top, height, frac) {
  const h = Number(height)
  if (!Number.isFinite(h)) return 0
  return (Number(top) - Number(ref)) + clamp01(frac) * h
}
