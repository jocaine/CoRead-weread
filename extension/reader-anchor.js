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
 * 端点落在本层的**元素**节点上时（拖到行间空白、或落在 <br> 上），换算成页内偏移。
 *
 * Chrome 在这种位置给的是「元素 + 第几个子节点」，offset 是**子节点序号**，不是字数。
 * 直接当字数用会算错（甚至把跨页选区判成"整页"），所以单独算：
 *   · 元素就是文字层自己 → offset 就是子节点序号（0 = 页首之前，childNodes.length = 页尾之后）
 *   · 元素是文字层的直接子节点（<br>）→ 取它前面那几个 span 的字数
 * 前提与 `pageTextIndex` 相同：pdf.js 的行 span 是文字层的直接子节点（不嵌套）。
 * 认不出来（别的元素、别的层）→ null，交给调用方按"这一页没被选中"处理。
 */
function offsetAtChild(layerEl, node, offset) {
  if (!layerEl || !node || node.nodeType !== 1) return null
  const kids = layerEl.childNodes || []
  let before
  if (node === layerEl) {
    before = Math.max(0, Math.min(Number(offset) || 0, kids.length))
  } else {
    const idx = Array.prototype.indexOf.call(kids, node)
    if (idx < 0) return null
    before = idx
  }
  let sum = 0
  for (let i = 0; i < before; i++) {
    const kid = kids[i]
    if (kid && kid.nodeType === 1 && String(kid.tagName || '').toUpperCase() === 'SPAN') {
      sum += (kid.textContent || '').length
    }
  }
  return sum
}

/** 这个 Range 有没有穿过这一层（老环境没有 intersectsNode 就当没穿过：宁可少一条锚点） */
function intersectsLayer(range, layerEl) {
  try {
    return typeof range.intersectsNode === 'function' ? range.intersectsNode(layerEl) : false
  } catch (e) {
    return false
  }
}

/**
 * Range → 页内起止偏移。Range 与这页文字层没有交集时返回 null。
 *
 * ⚠️ 跨页划选（2026-11 修，用户实报"划线跨页时浮标不弹"）：
 * 一个 Range 的起点与终点可以落在**两页**的文字层里。旧实现要求两个端点都在本层，
 * 于是跨页选区在**每一页**上都拿到 null —— `offsetsAcrossPages` 返回空数组，
 * `selectionAnchors()` 跟着返回 null，`onSelectionSettled` 走 `hideTip()`：
 * 翻译 / 设为引用 / 复制那条浮标根本不出现，Alt+T 也只会提示"请先划选原文"。
 *
 * 现在按"选区盖住了这一页多少"来算：
 *   · 起点在更前面的一页 → 本页从页首算起
 *   · 终点在更后面的一页 → 本页算到页尾
 *   · 两端都不在本层 → 只有 Range 真的穿过这一层（intersectsNode）才算整页；
 *     否则一本 300 页的书里那些根本没碰到的页也会被当成"整页选中"。
 */
export function offsetsFromRange(layerEl, range) {
  const { spans, offsets, total } = pageTextIndex(layerEl)
  if (!spans.length || !range) return null
  const locate = (node, offset) => {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]
      if (span === node) {
        // 端点是**元素**（span 自己）：offset 是"第几个子节点"，不是"第几个字"。
        // 只有一个文字子节点的行 span 上，0 = 行首、≥1 = 行尾。
        return offsets[i] + (offset > 0 ? (span.textContent || '').length : 0)
      }
      if (span.contains(node)) {
        return offsets[i] + Math.min(offset, (span.textContent || '').length)
      }
    }
    return offsetAtChild(layerEl, node, offset)
  }
  let start = locate(range.startContainer, range.startOffset)
  let end = locate(range.endContainer, range.endOffset)
  if (start === null && end === null) {
    // 两端都不在这一层：整页被选区穿过（跨页划选），或者压根没碰到这一页
    if (!intersectsLayer(range, layerEl)) return null
    start = 0
    end = total
  } else if (start === null) {
    start = 0          // 选区从更前面的一页开始：本页从页首被选中
  } else if (end === null) {
    end = total        // 选区到更后面的一页才结束：本页被选到页尾
  }
  const a = Math.min(start, end)
  const b = Math.max(start, end)
  return { start: Math.max(0, Math.min(total, a)), end: Math.max(0, Math.min(total, b)) }
}

/**
 * 取选区在各页里的偏移，按页分组。
 *
 * 跨页选区会得到**多条**：首页从划过的那一点到页尾、中间页整页、末页从页首到终点
 *（把首尾夹进本页范围由 offsetsFromRange 负责）。
 *
 * @param {Range} range
 * @param {Element[]} pageLayers 页面顺序排列的文字层
 * @returns {Array<{page: number, start: number, end: number}>} page 从 1 开始
 */
export function offsetsAcrossPages(range, pageLayers) {
  const out = []
  for (let i = 0; i < pageLayers.length; i++) {
    const layer = pageLayers[i]
    if (!layer) continue
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
 * 多段切片（通常是"每页一段"）→ 一段连续原文。
 *
 * 为什么需要它（2026-11 用户实报：跨页引用之后，条目里的原文还带着换行）：
 * 跨页划选会得到**多条**锚点（每页一条，见 offsetsAcrossPages），阅读器原先用 '\n'
 * 把它们直接拼起来 —— 于是跨页的那一句在引用卡、译文条目、发给 agent 的原文里
 * 断成了两行，而且和"同一页里换行会被接成一句"自相矛盾。
 *
 * 接法只有一套：**与页内换行完全相同**，交给 joinLines —— 英文补一个空格、
 * 行尾连字符断词直接接、中文之间不加空格。切片内部若还残留 '\n'
 *（个别 PDF 的 ToUnicode 会给出），也一并按行拆开，别让它漏进引用原文。
 *
 * @param {string[]} chunks 按阅读顺序的切片
 * @returns {string}
 */
export function joinSlices(chunks) {
  const lines = []
  for (const c of Array.isArray(chunks) ? chunks : []) {
    for (const line of String(c == null ? '' : c).split('\n')) lines.push(line)
  }
  return joinLines(lines)
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

/** 一页文字层里所有 span 的文字接起来（= pageTextIndex 坐标下的完整正文）。 */
export function pageText(layerEl) {
  const { spans } = pageTextIndex(layerEl)
  return spans.map((s) => s.textContent || '').join('')
}

/**
 * `linesFromOffsets` 的**无 DOM 版**：直接对 `getTextContent()` 的 items 切片。
 *
 * 为什么需要它：页面**还没渲染**时没有文字层（没有 span 可查），而"划线附近的原文"
 * 恰恰会在这种时候被要——重开一本书、在译文对照里点一条旧条目的「设为引用」。
 * items 的顺序与文字层的 span 一一对应（pdf.js 就是一 item 一行span），
 * 所以坐标系统与 `linesFromOffsets` 完全一致，只是文字不从 DOM 取。
 *
 * @param {Array<{str?: string}>} items getTextContent() 里 str 非空的项，顺序即页内顺序
 */
export function linesFromItems(items, start, end) {
  const list = Array.isArray(items) ? items : []
  const a = Math.max(0, Number(start) || 0)
  const b = Math.max(0, Number(end) || 0)
  const out = []
  let off = 0
  for (const it of list) {
    const text = String((it && it.str) || '')
    const s0 = off
    const s1 = off + text.length
    off = s1
    if (s1 <= a || s0 >= b) continue
    const from = Math.max(0, a - s0)
    const to = Math.min(text.length, b - s0)
    if (to <= from) continue
    out.push(text.slice(from, to))
  }
  return out
}

/**
 * 与 `linesFromItems` 同样的切片，但切的是**补过空格**的那份（fix 来自 restoreItemSpaces /
 * spacedPageFix）。给"页面没渲染时也要正常词间空格"用 —— 否则送进模型的是
 * `hoiswidelyrecognizedas…`（见本文件开头那段说明）。
 *
 * fix 里没有 item 的原始长度，由"补后长度 − 插入的空格数"倒推得来 —— 成立的前提是
 * `restoreItemSpaces` 的第一条硬规矩：**只插空格，不删不改**。
 */
export function linesFromFixedItems(fix, start, end) {
  if (!fix || !Array.isArray(fix.lines)) return []
  const lines = fix.lines
  const inserted = Array.isArray(fix.inserted) ? fix.inserted : []
  const a = Math.max(0, Number(start) || 0)
  const b = Math.max(0, Number(end) || 0)
  const out = []
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '')
    const ins = inserted[i] || []
    const rawLen = Math.max(0, line.length - ins.length)
    const s0 = off
    const s1 = off + rawLen
    off = s1
    if (s1 <= a || s0 >= b) continue
    const from = Math.max(0, a - s0)
    const to = Math.min(rawLen, b - s0)
    if (to <= from) continue
    out.push(line.slice(shiftLocal(ins, from), shiftLocal(ins, to)))
  }
  return out
}

// ── 补回被 pdf.js 吞掉的词间空格（2026-11）────────────────────────────────────
//
// 现象：用户划词翻译时，对照栏里的原文是 "hoiswidelyrecognizedastheforemost
// interpreterofLacan'swork…" —— 单词之间的空格全没了。
//
// 原因不在 PDF，也不在我们的锚点代码，而在 pdf.js 的**抽取文字**这一步：
// 它不照抄 PDF 的内容流，而是拿"两个字之间的水平间隙像不像一个空格"去猜
//（内部函数 addFakeSpaces，阈值由字体度量算出来）。猜不中就当成字间紧排，
// 把空隙并进前一个字。实测同一页的绘图指令里，那些空格是**真实存在的字形**
//（unicode === " "，见下面的 glyphTextFromOps），所以真值一直在，只是被丢了。
//
// 修法：拿绘图指令里的字形序列当"真字流"，与 pdf.js 给的 item 文字逐字对齐，
// 只在真字流多出空格的地方把空格插回去。**不动 vendor 里的 pdf.js** —— 那是外部
// 文件，改了下次升级就丢（见 extension/vendor/pdfjs/README.md 的升级步骤）。

/** 连续多少个拉丁字母就算"词间空格被吞了"（见 looksSpaceStarved）。 */
const STARVED_RUN = 20

/**
 * 这段文字像是"词间空格被 pdf.js 吞了"吗？
 *
 * 判据只有一条：**一长串拉丁字母中间一个空格都没有**。英文里 20 个字母的词已是
 * 极端值（uncharacteristically 正好 20），中文根本不会命中（只认 A-Za-z）。
 * 误判的代价只是白跑一次对齐，文字不会变 —— 所以宁可敏感一点。
 */
export function looksSpaceStarved(text, run = STARVED_RUN) {
  return new RegExp('[A-Za-z]{' + run + ',}').test(String(text ?? ''))
}

/**
 * 从绘图指令里取出"真字流"：所有文字指令里的字形字符，按出现顺序接起来。
 *
 * 它能当真值，是因为 pdf.js **画字与抽字用的是同一份字形数组**（每个字形带 unicode），
 * 两条路唯一的差别就是抽取那条会把空格字形吃掉。所以绘图指令里的空格是可靠的。
 *
 * 不产出换行：抽取那边行尾也只是个 hasEOL 标记、不是字符，两边都不含换行才对得上。
 *
 * @param {ArrayLike<number>} fnArray opList.fnArray
 * @param {ArrayLike<unknown>} argsArray opList.argsArray
 * @param {Record<string, number>} ops pdfjsLib.OPS
 */
export function glyphTextFromOps(fnArray, argsArray, ops) {
  if (!fnArray || !argsArray || !ops) return ''
  const textOps = new Set([
    ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText,
  ])
  const out = []
  for (let i = 0; i < fnArray.length; i++) {
    if (!textOps.has(fnArray[i])) continue
    collectGlyphs(argsArray[i], out)
  }
  return out.join('')
}

/** 递归收一条指令参数里的字符：字形取 unicode；TJ 数组里的数字是字距微调，跳过。 */
function collectGlyphs(x, out) {
  if (typeof x === 'string') { out.push(x); return }
  if (isGlyph(x)) { out.push(x.unicode); return }
  if (!Array.isArray(x)) return
  // 字形数组（最常见的形态）整批取走；混着别的（TJ 数组是 [字形…, 数字, 字形…]）就逐个下钻
  if (x.length && x.every(isGlyph)) {
    for (const g of x) out.push(g.unicode)
    return
  }
  for (const y of x) collectGlyphs(y, out)
}

function isGlyph(x) {
  return !!x && typeof x === 'object' && typeof x.unicode === 'string'
}

/**
 * 用"真字流"给这一页每个 item 的文字补回被吞掉的空格。
 *
 * 三条硬规矩（宁可少补，不可乱补）：
 *   ① 只往 item 文字里**插空格**，不删不改任何字符；
 *   ② item 里已经有的空格一律原样留着 —— 它可能是 pdf.js 猜出来的（真字流里没有），
 *      也可能是真字流里的那一个，两种情况都不该动；
 *   ③ 碰到别的差异（连字、隐形字符、ToUnicode 不一致）→ 返回 null，整页放弃。
 *
 * @param {Array<{str?: string}>} items getTextContent() 里 str 非空的项（顺序 = 文字层 span 顺序）
 * @param {string} glyphText 真字流，见 glyphTextFromOps
 * @returns {{lines: string[], inserted: number[][]}|null}
 *   lines[i]    = 第 i 个 item 补好空格后的文字
 *   inserted[i] = 第 i 个 item 内的插入点（行内坐标，升序）
 */
export function restoreItemSpaces(items, glyphText) {
  const list = Array.isArray(items) ? items : []
  const truth = String(glyphText ?? '')
  if (!list.length || !truth) return null
  const lines = []
  const inserted = []
  let gi = 0
  for (const it of list) {
    const s = String((it && it.str) || '')
    let r = ''
    const ins = []
    for (let k = 0; k < s.length; k++) {
      const ch = s[k]
      if (truth[gi] === ch) { r += ch; gi++; continue }
      if (truth[gi] === ' ') {
        // 真字流这里是空格、item 里没有 → 补上。
        // 落在 item 开头的那个空格不补：那是行边界，joinLines 会按"行间补空格/行尾断词"
        // 处理（补在这里反而多一个前导空格，还要再 trim 掉）。
        while (truth[gi] === ' ') { if (k > 0) { ins.push(k); r += ' ' } gi++ }
        if (truth[gi] === ch) { r += ch; gi++; continue }
      }
      if (ch === ' ') { r += ch; continue }    // item 自己带的空格：各走一步，谁也不吞谁
      return null                              // 其它差异：不猜，整页放弃
    }
    lines.push(r)
    inserted.push(ins)
  }
  return { lines, inserted }
}

/**
 * 一页的"补空间"结果，带一道保险：item 文字必须与文字层里的 span 逐字一致。
 *
 * 不一致说明两次 getTextContent() 拿到的不是同一批文字（页面重排过、节点重建过），
 * 那就不能用 —— 偏移对不上会切出错位的原文，比缺空格更糟。
 *
 * `layerEl` 传 null 表示**这一页还没渲染**（没有文字层可校验）：此时 items 与真字流
 * 出自同一次 `getTextContent()`，不存在"两批文字"的可能，所以跳过校验直接用。
 */
export function spacedPageFix(layerEl, items, glyphText) {
  const list = (items || []).filter((it) => it && typeof it.str === 'string' && it.str)
  if (!list.length) return null
  if (layerEl && list.map((it) => it.str).join('') !== pageText(layerEl)) return null
  return restoreItemSpaces(list, glyphText)
}

/** 行内坐标 → 补过空格那份文字里的坐标（把插入的空格算进去）。 */
function shiftLocal(ins, off) {
  let n = 0
  for (let i = 0; i < ins.length; i++) { if (ins[i] <= off) n++; else break }
  return off + n
}

/**
 * 取出一段偏移覆盖到的每一行文字 —— 改用**补过空格**的那份。
 * 切片规则与 linesFromOffsets 完全一致，只是行文字换成 fix.lines[i]，
 * 行内区间端点按"这一行插了几个空格"换算过去。
 * @param {{lines: string[], inserted: number[][]}|null} fix
 */
export function spacedLinesFromOffsets(layerEl, fix, start, end) {
  if (!fix || !Array.isArray(fix.lines)) return linesFromOffsets(layerEl, start, end)
  const { spans, offsets, total } = pageTextIndex(layerEl)
  const a = Math.max(0, Math.min(total, Number(start) || 0))
  const b = Math.max(0, Math.min(total, Number(end) || 0))
  const out = []
  for (let i = 0; i < spans.length; i++) {
    const text = spans[i].textContent || ''
    const s0 = offsets[i]
    const s1 = s0 + text.length
    if (s1 <= a || s0 >= b) continue
    const from = Math.max(0, a - s0)
    const to = Math.min(text.length, b - s0)
    if (to <= from) continue
    const line = fix.lines[i]
    if (typeof line !== 'string') { out.push(text.slice(from, to)); continue }
    const ins = fix.inserted[i] || []
    out.push(line.slice(shiftLocal(ins, from), shiftLocal(ins, to)))
  }
  return out
}

/** 取出一段偏移对应的可读原文，可能带着补回来的词间空格（没有 fix 时等于 textFromOffsets）。 */
export function textFromSpacedOffsets(layerEl, fix, start, end) {
  return joinLines(spacedLinesFromOffsets(layerEl, fix, start, end))
}

// ── 「划线附近原文」的取法（纯算术，与 DOM / pdf.js 无关）──────────────────────
/**
 * 以划线的起止为中心，**前后各取 before / after 字**，额度不够就向相邻页延伸。
 *
 * 为什么要抽成纯函数：这段"取哪几页、每页取哪一段"是这件事里唯一会算错的地方
 * （页首、页尾、跨页、短页要往前多补一页），而它不需要 DOM、不需要 pdf.js ——
 * 抽出来就能用单测把每种边界钉死（浏览器自测在受限环境里跑不起来，见 README 的说明）。
 *
 * @param {Array<{page:number,start:number,end:number}>} anchors 划线在各页的偏移（阅读顺序）
 * @param {(page:number)=>number|null} pageTotal 问"这一页有多少字"；拿不到那页的文字返回 null
 * @param {{before?:number, after?:number, span?:number}} [opts] span = 前后最多各看几页
 * @returns {Array<{page:number, from:number, to:number}>} 按页序、可直接依次取文字拼接
 */
export function planContextWindow(anchors, pageTotal, opts = {}) {
  const before = Number.isFinite(opts.before) ? opts.before : 300
  const after = Number.isFinite(opts.after) ? opts.after : 300
  const span = Number.isFinite(opts.span) ? opts.span : 2
  const list = (Array.isArray(anchors) ? anchors : []).filter(
    (a) => a && Number.isFinite(a.page) && Number.isFinite(a.start) && Number.isFinite(a.end),
  )
  if (!list.length) return []

  const total = (page) => {
    const t = typeof pageTotal === 'function' ? pageTotal(page) : null
    return Number.isFinite(t) && t > 0 ? t : null
  }
  const slices = []
  const add = (page, from, to) => {
    const t = total(page)
    if (t === null) return 0
    const a = Math.max(0, Math.min(t, from))
    const b = Math.max(a, Math.min(t, to))
    if (b <= a) return 0
    slices.push({ page, from: a, to: b })
    return b - a
  }

  const first = list[0]
  const last = list[list.length - 1]

  // ① 划线自己覆盖到的那几页：首页往前留额度、末页往后留额度，中间页整页要
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    add(a.page, a.start - (i === 0 ? before : 0), a.end + (i === list.length - 1 ? after : 0))
  }

  // 划线所在的那几页一个字都拿不到（典型：扫描件＝图片页，没有文字层）→ 空计划。
  // 为什么要这道闸：没有它，下面的"往前补页"会拿**旁页**的文字凑出一段"附近原文"，
  // 而那段文字与划线毫无关系 —— 宁可没有上下文，不可给错上下文。
  if (!slices.length) return []

  // ② 头一段在页首、前面不够 before 字 → 往前几页的**尾巴**补（最多 span 页）
  let need = Math.max(0, before - Math.max(0, first.start))
  for (let n = first.page - 1; need > 0 && n >= 1 && first.page - n <= span; n--) {
    const t = total(n)
    if (t === null) break
    need -= add(n, Math.max(0, t - need), t)
  }

  // ③ 末一段在页尾、后面不够 after 字 → 往后几页的**开头**补（最多 span 页）
  let needTail = Math.max(0, after - Math.max(0, (total(last.page) || 0) - last.end))
  for (let n = last.page + 1; needTail > 0 && n - last.page <= span; n++) {
    const t = total(n)
    if (t === null) break
    needTail -= add(n, 0, needTail)
  }

  return slices.sort((x, y) => x.page - y.page)
}

/**
 * 「设为引用」要带上的上下文：优先用从锚点附近抽出来的原文，没有就退回**整张卡片的译文**。
 *
 * 为什么需要退回：扫描件（截图 / 框选识别 / 框选翻译）的条目没有原文、也没有文字层，从锚点抽上下文
 * 必然是空。而用户划的那一句的前后文，其实**就在这张译文卡片上** —— 不送出去，
 * agent 手里就只有孤零零一句，判断依据严重不足。
 *
 * 边界：只对"没有原文来源"的条目退回译文（扫描件的特征）。普通文字条目要么已经取到
 * 附近原文，要么取不到是因为别的原因（页还没渲染等）—— 那时把**译文**当"附近原文"
 * 会给出跨语言、错位的上下文，比没有更坏（同 contextAround 的既有原则）。
 *
 * @param {string} near 从锚点附近抽出来的原文（扫描件为空串）
 * @param {{kind?:string, source?:string, translation?:string}} entry 译文条目
 * @returns {string} 上下文（可能为空串）
 */
export function contextForRef(near, entry) {
  const own = String(near || '').trim()
  if (own) return own
  const kind = String((entry && entry.kind) || '')
  const source = String((entry && entry.source) || '').trim()
  // 扫描件：没有原文（source 为空）或明确标成图片条目
  if (kind !== 'image' && source) return ''
  return String((entry && entry.translation) || '').trim()
}

// ── 「点这条引用该跳到哪一处」（纯函数，与 DOM / pdf.js 无关）──────────────────
/**
 * 挑锚点用的文字口径：去掉所有空白。
 * 与 reader.js 的 compactRefText 同源 —— PDF 抽出来的行间空格不总与存下来的一致。
 */
const locateCompact = (s) => String(s || '').replace(/\s+/g, '')

/**
 * 一个锚点是否可用。页号从 1 起；偏移必须是非负整数、且 end > start
 * （end <= start 的 Range 什么都框不住，跳过去也看不见东西）。
 * @returns {{page:number,start:number,end:number}|null}
 */
function cleanAnchor(a) {
  if (!a) return null
  const page = Math.trunc(Number(a.page))
  const start = Math.trunc(Number(a.start))
  const end = Math.trunc(Number(a.end))
  if (!Number.isFinite(page) || page < 1) return null
  if (!Number.isFinite(start) || start < 0) return null
  if (!Number.isFinite(end) || end <= start) return null
  return { page, start, end }
}

/**
 * 「点这条引用，跳到书里哪一处」——从几个来源里挑一个**精确锚点**。
 *
 * 为什么需要它（而不是按文字搜）：同一句话在书里常常出现不止一次，按文字找一定
 * 有落到隔壁去的时候。实测《置身事内》：第 56 页与第 58 页各有一个"全国预算收入"，
 * 两处只隔两页 —— 按文字找会撞上"离当前页最近"的那一个，用户看到的就是
 * "跳到了最近的地方，不是我的划线"。
 *
 * 来源按**从准到松**排序（调用方决定顺序，通常）：
 *   ① 设引用那一刻记下的位置（阅读器本地 refMarks）—— 用户划的就是它
 *   ② 这条引用出身的那张译文卡的位置（state.entries）—— 同一次划词的另一份记录
 *   ③ 接收端存档随引用带回来的位置（refsSeen[].anchors）—— 能活过本地缓存上限
 * 都命不中 → null，调用方退回按文字找（那是有歧义的老路，必须如实回报）。
 *
 * @param {string} text 引用原文
 * @param {Array<{from?:string, items?:Array<{text?:string, anchors?:Array}>}>} sources
 * @returns {{page:number,start:number,end:number,from:string}|null}
 */
export function pickLocateAnchor(text, sources = []) {
  const want = locateCompact(text)
  if (!want) return null
  for (const src of Array.isArray(sources) ? sources : []) {
    const items = (src && Array.isArray(src.items)) ? src.items : []
    for (const it of items) {
      if (locateCompact(it && it.text) !== want) continue
      const list = Array.isArray(it && it.anchors) ? it.anchors : []
      for (const raw of list) {
        const a = cleanAnchor(raw)
        if (a) return { ...a, from: String((src && src.from) || '') }
      }
    }
  }
  return null
}

