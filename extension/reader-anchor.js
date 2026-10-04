/**
 * 阅读器锚点：在「页号 + 页内字符偏移」与 DOM Range 之间来回换算。
 *
 * 为什么不用 Range 或像素坐标当锚点：
 *   - Range 绑在具体节点上。文字层重挂（重新打开、换渲染策略）后节点就没了，Range 失效。
 *   - 像素坐标会被缩放和重排冲掉（微信读书那套补丁就是被这个逼出来的）。
 * pdf.js 的文字层每个 span 就是**一行文字**，页内顺序稳定；所以用「第几页 + 页内第几个字」
 * 当锚点，缩放、重开、换设备都能重新解析回同一个位置。
 *
 * 本文件是纯函数，不碰 chrome.*，可以在 node 里单测。
 */

/**
 * 把一页文字层里的 span 拉平成索引：spans 与每行起始偏移。
 * 只认直接子 span（pdf.js 会把 markedContent 包一层，用 .markedContent span 也算）。
 * @param {ParentNode} layerEl
 * @returns {{spans: Element[], offsets: number[], total: number}}
 */
export function pageTextIndex(layerEl) {
  const spans = layerEl ? [...layerEl.querySelectorAll('span')] : []
  const offsets = []
  let total = 0
  for (const s of spans) {
    offsets.push(total)
    total += (s.textContent || '').length
  }
  return { spans, offsets, total }
}

/**
 * 页内字符偏移 → 具体的文本节点与节点内偏移（Range 的 setStart/setEnd 参数）。
 * 偏移落在两行之间时，归到前一行的末尾（和选区的直觉一致）。
 * @returns {{node: Node, offset: number}|null}
 */
export function offsetToPoint(layerEl, offset) {
  const { spans, offsets, total } = pageTextIndex(layerEl)
  if (!spans.length) return null
  const off = Math.max(0, Math.min(total, Number(offset) || 0))
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    const len = (span.textContent || '').length
    const start = offsets[i]
    if (off <= start + len) {
      const node = span.firstChild
      if (!node) continue
      return { node, offset: Math.max(0, Math.min(len, off - start)) }
    }
  }
  const last = spans[spans.length - 1]
  if (!last.firstChild) return null
  return { node: last.firstChild, offset: (last.textContent || '').length }
}

/**
 * 「页号 + 起止偏移」→ Range。节点还没渲染好时返回 null（调用方应先把这页渲染出来）。
 */
export function rangeFromOffsets(layerEl, start, end) {
  const a = offsetToPoint(layerEl, start)
  const b = offsetToPoint(layerEl, end)
  if (!a || !b) return null
  try {
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    return r
  } catch {
    return null
  }
}

/**
 * Range → 页内起止偏移。Range 不在这页文字层里时返回 null。
 */
export function offsetsFromRange(layerEl, range) {
  const { spans, offsets, total } = pageTextIndex(layerEl)
  if (!spans.length || !range) return null
  const locate = (node, offset) => {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]
      if (span === node || span.contains(node)) {
        return offsets[i] + Math.min(offset, (span.textContent || '').length)
      }
    }
    return null
  }
  const start = locate(range.startContainer, range.startOffset)
  const end = locate(range.endContainer, range.endOffset)
  if (start === null || end === null) return null
  const a = Math.min(start, end)
  const b = Math.max(start, end)
  return { start: Math.max(0, Math.min(total, a)), end: Math.max(0, Math.min(total, b)) }
}

/**
 * 取选区在各页里的偏移，按页分组。
 * @param {Range} range
 * @param {Element[]} pageLayers 页面顺序排列的文字层
 * @returns {Array<{page: number, start: number, end: number}>} page 从 1 开始
 */
export function offsetsAcrossPages(range, pageLayers) {
  const out = []
  for (let i = 0; i < pageLayers.length; i++) {
    const layer = pageLayers[i]
    if (!layer) continue
    // 只统计与该页有交集的选区：把选区的头和尾夹到本页范围内，再看是否非空
    const hit = offsetsFromRange(layer, range)
    if (!hit) continue
    if (hit.end <= hit.start) continue
    out.push({ page: i + 1, start: hit.start, end: hit.end })
  }
  return out
}

/**
 * 把按行切开的文字接成正常句子。
 *
 * pdf.js 的文字层一行一个 span，直接拼起来会得到 "survivetranslation" 这种断词。
 * 规则：行间补一个空格；若上一行以连字符结尾且下一行以小写字母开头，视为断词，
 * 去掉连字符直接接（这是 PDF 里最常见的断词写法）。
 * @param {string[]} lines
 */
export function joinLines(lines) {
  const parts = (lines || []).map((s) => String(s ?? ''))
  let out = ''
  for (const raw of parts) {
    const line = raw.trim()
    if (!line) continue
    if (!out) { out = line; continue }
    const cjkEnd = /[\u4e00-\u9fff]$/.test(out)
    const cjkStart = /^[\u4e00-\u9fff]/.test(line)
    if (/[-\u2010\u2011]$/.test(out) && /^[a-z]/.test(line)) {
      out = out.slice(0, -1) + line        // 行尾断词：去掉连字符直接接
    } else if (cjkEnd && cjkStart) {
      out += line                          // 两边都是中文：不加空格
    } else {
      out += ' ' + line
    }
  }
  return out
}

/**
 * 取出一段偏移覆盖到的每一行文字（保留行结构）。
 *
 * 不能用 range.toString() 取行：文字层的 span 之间没有分隔符，Range 会把两行直接粘成
 * "survivetranslation"。行的边界只能从 span 自己拿。
 * @returns {string[]}
 */
export function linesFromOffsets(layerEl, start, end) {
  const { spans, offsets, total } = pageTextIndex(layerEl)
  const a = Math.max(0, Math.min(total, Number(start) || 0))
  const b = Math.max(0, Math.min(total, Number(end) || 0))
  const lines = []
  for (let i = 0; i < spans.length; i++) {
    const text = spans[i].textContent || ''
    const s0 = offsets[i]
    const s1 = s0 + text.length
    if (s1 <= a || s0 >= b) continue
    const from = Math.max(0, a - s0)
    const to = Math.min(text.length, b - s0)
    if (to <= from) continue               // 空区间不产出空行
    lines.push(text.slice(from, to))
  }
  return lines
}

/** 取出一段偏移对应的可读原文（行间补空格 / 处理断词）。 */
export function textFromOffsets(layerEl, start, end) {
  return joinLines(linesFromOffsets(layerEl, start, end))
}
