/**
 * reader-anchor.js 的单测：只覆盖不依赖真实 DOM Range 的部分。
 * pageTextIndex / linesFromOffsets 只用到 querySelectorAll 与 textContent，
 * 所以一个假 layer 就够，不需要 jsdom。
 *
 * 运行：node extension/test/reader-anchor.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contextForRef,
  glyphTextFromOps,
  joinLines,
  joinSlices,
  linesFromFixedItems,
  linesFromItems,
  linesFromOffsets,
  looksSpaceStarved,
  offsetsAcrossPages,
  offsetsFromRange,
  pageTextIndex,
  pickLocateAnchor,
  planContextWindow,
  restoreItemSpaces,
  spacedPageFix,
  spacedLinesFromOffsets,
  textFromOffsets,
  textFromSpacedOffsets,
} from '../reader-anchor.js'

/** 假文字层：pdf.js 里一行就是一个 span，这里只需要 textContent */
const fakeLayer = (lines) => ({ querySelectorAll: () => lines.map((t) => ({ textContent: t })) })

// ── 行拼接 ────────────────────────────────────────────────────────────────────
test('joinLines 行间补空格（这是断词 bug 的正解）', () => {
  assert.equal(joinLines(['do not survive', 'translation by themselves.']),
    'do not survive translation by themselves.')
})

test('joinLines 处理行尾连字符断词', () => {
  assert.equal(joinLines(['a well-docu-', 'mented claim']), 'a well-documented claim')
  // 行尾是破折号、下一行不是小写字母时，不当作断词
  assert.equal(joinLines(['the end -', 'Next sentence']), 'the end - Next sentence')
})

test('joinLines 中文之间不加空格，中英之间加', () => {
  assert.equal(joinLines(['这是一句', '中文。']), '这是一句中文。')
  assert.equal(joinLines(['中文结尾', 'English follows']), '中文结尾 English follows')
  assert.equal(joinLines(['English ends', '中文开始']), 'English ends 中文开始')
})

test('joinLines 跳过空行、去掉首尾空白', () => {
  assert.equal(joinLines(['  first  ', '', '   ', 'second']), 'first second')
  assert.equal(joinLines([]), '')
  assert.equal(joinLines(null), '')
})

// ── 跨页切片接成一段（2026-11 用户实报：跨页引用后条目里还带着换行）───────────────
test('joinSlices 跨页不留换行：英文补空格接着写', () => {
  assert.equal(joinSlices(['kept short on purpose.', 'Reading foreign literature']),
    'kept short on purpose. Reading foreign literature')
})

test('joinSlices 跨页行尾连字符断词照样接回去', () => {
  // 一个词被页边界劈开：上一页末尾 "well-docu-"、下一页开头 "mented"
  assert.equal(joinSlices(['a well-docu-', 'mented claim']), 'a well-documented claim')
})

test('joinSlices 跨页中文之间不加空格', () => {
  assert.equal(joinSlices(['这是一句', '中文。']), '这是一句中文。')
  assert.equal(joinSlices(['中文结尾', 'English follows']), '中文结尾 English follows')
})

test('joinSlices 切片内部残留的换行也一并接掉', () => {
  // 个别 PDF 的 ToUnicode 会让一个 span 的 str 里带 \n —— 不能让它漏进引用原文
  assert.equal(joinSlices(['first line\nsecond line', 'third']), 'first line second line third')
  assert.equal(joinSlices(['第一行\n第二行', 'third']), '第一行第二行 third')   // 中文之间照旧不加空格
})

test('joinSlices 与页内换行同一套规则：切几段不影响结果', () => {
  const lines = ['Reading foreign literature', 'means meeting sentences', 'that do not survive']
  assert.equal(joinSlices([lines.join('\n')]), joinLines(lines))
  assert.equal(joinSlices([lines[0], lines[1] + '\n' + lines[2]]), joinLines(lines))
  assert.equal(joinSlices([lines.join(' ')]), joinLines(lines))   // 页内本来就是一行的情况
})

test('joinSlices 对空段 / 坏输入不炸', () => {
  assert.equal(joinSlices([]), '')
  assert.equal(joinSlices(null), '')
  assert.equal(joinSlices(['', '   ', null, undefined, 'x']), 'x')
})

// ── 页内索引 ──────────────────────────────────────────────────────────────────
test('pageTextIndex 给出每行起始偏移与总长', () => {
  const idx = pageTextIndex(fakeLayer(['abc', 'de', 'f']))
  assert.deepEqual(idx.offsets, [0, 3, 5])
  assert.equal(idx.total, 6)
})

test('pageTextIndex 对空层返回空结构', () => {
  assert.deepEqual(pageTextIndex(fakeLayer([])), { spans: [], offsets: [], total: 0 })
  assert.deepEqual(pageTextIndex(null), { spans: [], offsets: [], total: 0 })
})

// ── 偏移取行 ──────────────────────────────────────────────────────────────────
test('linesFromOffsets 只取与区间有交集的行，并按行切好', () => {
  const layer = fakeLayer(['Reading foreign literature', 'means meeting sentences', 'that do not survive'])
  // 第一行 26 字；[8,20) 落在 "foreign literature" 里
  assert.deepEqual(linesFromOffsets(layer, 8, 20), ['foreign lite'])
  // 跨到第二行：第一行取末尾，第二行取开头 —— 这一步正是"不能直接拼 Range 文本"的原因
  assert.deepEqual(linesFromOffsets(layer, 20, 35), ['rature', 'means mee'])
  // 只碰第二行
  assert.deepEqual(linesFromOffsets(layer, 26, 31), ['means'])
})

test('linesFromOffsets 夹紧越界偏移，空区间不产出空行', () => {
  const layer = fakeLayer(['abc', 'def'])
  assert.deepEqual(linesFromOffsets(layer, -5, 999), ['abc', 'def'])
  assert.deepEqual(linesFromOffsets(layer, 4, 4), [])
  assert.deepEqual(linesFromOffsets(layer, 99, 120), [])
})

test('textFromOffsets 把跨行选区拼成正常句子（不是两行粘住）', () => {
  const lines = ['sentences that do not survive', 'translation by themselves.']
  const layer = fakeLayer(lines)
  const start = lines[0].indexOf('survive')
  const end = lines[0].length + 11          // 第二行取到 "translation" 末尾
  assert.equal(textFromOffsets(layer, start, end), 'survive translation')
  // 整段取出来时，行与行之间必须是空格而不是直接粘住
  assert.equal(textFromOffsets(layer, 0, 999),
    'sentences that do not survive translation by themselves.')
})

// ── 跨页选区（2026-11 用户实报：划线跨页时划词浮标不弹）───────────────────────
/**
 * 带节点的假文字层：每行一个 span、span 里一个文字节点 —— 与 pdf.js 的结构一致，
 * Range 的端点就落在这两种节点上。`contains` 只认自己与自己的文字子节点。
 */
const pageWithNodes = (lines) => {
  const layer = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [],
    querySelectorAll: () => layer.childNodes,
    contains: (n) => n === layer || layer.childNodes.some((s) => s === n || s.contains(n)),
  }
  layer.childNodes = lines.map((t) => {
    const text = { nodeType: 3, parentNode: null }
    const span = {
      nodeType: 1,
      tagName: 'SPAN',
      textContent: t,
      childNodes: [text],
      contains: (n) => n === span || n === text,
    }
    text.parentNode = span
    return span
  })
  return layer
}

/** 取第 i 行的文字节点（Range 端点最常落在它上面） */
const textOf = (layer, i) => layer.childNodes[i].childNodes[0]

/**
 * 假 Range。`intersectsNode` 按页顺序判断：页面上下堆叠、互不重叠，所以
 * "这一层在起止两页之间"与浏览器真 intersectsNode 的结论一致。
 */
const rangeAcross = (layers, startNode, startOffset, endNode, endOffset) => {
  const layerOf = (node) => layers.findIndex((l) => l.contains(node))
  const from = layerOf(startNode)
  const to = layerOf(endNode)
  return {
    startContainer: startNode,
    startOffset,
    endContainer: endNode,
    endOffset,
    intersectsNode(layer) {
      const i = layers.indexOf(layer)
      return i >= Math.min(from, to) && i <= Math.max(from, to)
    },
  }
}

test('跨页选区：首页算到页尾、次页从页首算起（旧实现两页都给 null）', () => {
  const p1 = pageWithNodes(['hello world', 'second line'])      // 11 + 11 = 22
  const p2 = pageWithNodes(['third line here', 'last line'])    // 15 + 9 = 24
  const layers = [p1, p2]
  // 从第 1 页第二行第 3 个字，拖到第 2 页第一行第 4 个字
  const range = rangeAcross(layers, textOf(p1, 1), 3, textOf(p2, 0), 4)
  assert.deepEqual(offsetsAcrossPages(range, layers), [
    { page: 1, start: 14, end: 22 },
    { page: 2, start: 0, end: 4 },
  ])
})

test('跨页选区穿过整页：中间那一页整页都要（否则长引用会丢一句话）', () => {
  const p1 = pageWithNodes(['aaaa', 'bb'])          // 6
  const p2 = pageWithNodes(['cccccc', 'dd'])        // 8
  const p3 = pageWithNodes(['eeee', 'ff'])          // 6
  const layers = [p1, p2, p3]
  const range = rangeAcross(layers, textOf(p1, 1), 1, textOf(p3, 0), 3)
  assert.deepEqual(offsetsAcrossPages(range, layers), [
    { page: 1, start: 5, end: 6 },
    { page: 2, start: 0, end: 8 },                  // 两端都不在这一页，但选区穿过了它
    { page: 3, start: 0, end: 3 },
  ])
})

test('没被选区碰到的页一条锚点都不给（不能把没翻到的页当成整页选中）', () => {
  const p1 = pageWithNodes(['aaaa', 'bb'])
  const p2 = pageWithNodes(['cccccc', 'dd'])
  const p3 = pageWithNodes(['eeee', 'ff'])
  const layers = [p1, p2, p3]
  const range = rangeAcross(layers, textOf(p1, 0), 1, textOf(p1, 1), 1)
  assert.deepEqual(offsetsAcrossPages(range, layers), [{ page: 1, start: 1, end: 5 }])
})

test('端点落在行间空白（层 + 子节点序号）时按行首折算，不当成整页', () => {
  const p1 = pageWithNodes(['hello world', 'second line'])
  const p2 = pageWithNodes(['aaa', 'bbb', 'ccc'])    // 3 + 3 + 3 = 9
  const layers = [p1, p2]
  // 从第 2 页第 2 行之前开始（层元素 + offset 1），选到第 3 行第 2 个字
  const range = rangeAcross(layers, p2, 1, textOf(p2, 2), 2)
  assert.deepEqual(offsetsAcrossPages(range, layers), [{ page: 2, start: 3, end: 8 }])
  // 跨页：终点落在下一页的"第 2 行之前"
  const cross = rangeAcross(layers, textOf(p1, 1), 2, p2, 1)
  assert.deepEqual(offsetsAcrossPages(cross, layers), [
    { page: 1, start: 13, end: 22 },
    { page: 2, start: 0, end: 3 },
  ])
})

test('端点是 span 元素时 offset 是子节点序号，不是字数', () => {
  const p1 = pageWithNodes(['hello world', 'second line'])
  // 端点在第 2 行的 span 上：offset 0 = 行首，offset 1 = 行尾（该 span 只有一个文字子节点）
  const atStart = rangeAcross([p1], p1.childNodes[1], 0, p1.childNodes[1], 1)
  assert.deepEqual(offsetsFromRange(p1, atStart), { start: 11, end: 22 })
})

test('单页区间：与改动前完全一致（跨页处理不能改变页内划选）', () => {
  const p1 = pageWithNodes(['hello world', 'second line'])
  const range = rangeAcross([p1], textOf(p1, 0), 6, textOf(p1, 1), 4)
  assert.deepEqual(offsetsFromRange(p1, range), { start: 6, end: 15 })
  assert.deepEqual(offsetsAcrossPages(range, [p1]), [{ page: 1, start: 6, end: 15 }])
})


test('同一对偏移在文字层重建后仍取到相同原文', () => {
  const lines = ['Reading foreign literature means meeting sentences', 'that do not survive translation by themselves.']
  const before = textFromOffsets(fakeLayer(lines), 0, 999)
  // 模拟缩放 / 重新打开：文字层 DOM 换成一批新节点，内容一致
  const after = textFromOffsets(fakeLayer([...lines]), 0, 999)
  assert.equal(before, after)
  assert.match(before, /^Reading foreign literature/)
  assert.match(before, /sentences that do not survive/)   // 跨行处是空格，不是粘连
})

// ── 补回被 pdf.js 吞掉的词间空格 ───────────────────────────────────────────────
// 真实案例（用户实报，2026-11）：item 文字是 "thegeneraleditorof"，
// 而绘图指令里的字形序列是 "the general editor of"。
const glyphItem = (unicode) => ({ unicode })

test('glyphTextFromOps 从绘图指令里取回真字流（含空格）', () => {
  const ops = { showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 }
  const fnArray = [31, 33, 44, 44, 47]                       // beginText / setFont / showText / showText / …
  const argsArray = [
    null, ['g_d0_f1', 14],
    [[glyphItem('the'), glyphItem(' '), glyphItem('general')]],
    [[glyphItem('editor')]],
    [0, 0, [glyphItem(' of'), 20, [glyphItem(' Lacan')]]],    // TJ：数字是字距微调，不该当文字
  ]
  assert.equal(glyphTextFromOps(fnArray, argsArray, ops), 'the generaleditor of Lacan')
  assert.equal(glyphTextFromOps(null, null, ops), '')
})

test('looksSpaceStarved 只对"长串字母中间没空格"报警', () => {
  assert.equal(looksSpaceStarved('hoiswidelyrecognizedastheforemostinterpreter'), true)
  assert.equal(looksSpaceStarved('the general editor of the book'), false)
  assert.equal(looksSpaceStarved('这是一段中文正文，本来就没有词间空格。'), false)
  assert.equal(looksSpaceStarved(''), false)
  assert.equal(looksSpaceStarved('uncharacteristically'), true)   // 单个超长词也会命中 —— 只是白跑一次
})

test('restoreItemSpaces 只在真字流多出空格的地方插空格', () => {
  const items = [{ str: 'thegeneraleditorof' }]
  const truth = 'the general editor of'
  const fix = restoreItemSpaces(items, truth)
  assert.deepEqual(fix.lines, ['the general editor of'])
  assert.deepEqual(fix.inserted, [[3, 10, 16]])              // 三个插入点（行内坐标）
})

test('restoreItemSpaces 绝不删改字符：item 自己带的空格原样留着', () => {
  // pdf.js 猜出来的空格（真字流里没有）必须保留，否则我们反而把它抹掉了
  const fix = restoreItemSpaces([{ str: 'thegeneral editorof' }], 'thegeneraleditorof')
  assert.equal(fix.lines[0], 'thegeneral editorof')
  assert.deepEqual(fix.inserted, [[]])
})

test('restoreItemSpaces 对不上就整页放弃（连字、隐形字符、ToUnicode 不一致）', () => {
  assert.equal(restoreItemSpaces([{ str: 'abc' }], 'abd'), null)          // 字符本身不同
  assert.equal(restoreItemSpaces([{ str: 'abc' }], ''), null)             // 没真字流
  assert.equal(restoreItemSpaces([], 'abc'), null)
})

test('restoreItemSpaces 跨 item 的边界空格不补（交给 joinLines 的行间空格）', () => {
  const items = [{ str: 'ab' }, { str: 'cd' }]               // 两行：ab / cd
  const layer = fakeLayer(['ab', 'cd'])
  const fix = restoreItemSpaces(items, 'ab cd')              // 真字流：ab·cd
  assert.deepEqual(fix.lines, ['ab', 'cd'])                  // 两边都不用动
  assert.deepEqual(fix.inserted, [[], []])
  // 行边界那个空格由 joinLines 提供 —— 所以整段取出来仍然正确
  assert.equal(textFromSpacedOffsets(layer, fix, 0, 999), 'ab cd')
})

test('spacedPageFix 在 item 与文字层对不上时拒绝出手（宁可缺空格，不可错位）', () => {
  const items = [{ str: 'thegeneraleditorof' }]
  const truth = 'the general editor of'
  const same = spacedPageFix(fakeLayer(['thegeneraleditorof']), items, truth)
  assert.equal(same.lines[0], 'the general editor of')
  // 文字层里的文字与 item 不一致（页面重排过 / 换过节点）→ null
  assert.equal(spacedPageFix(fakeLayer(['别的东西']), items, truth), null)
})

test('textFromSpacedOffsets 切片时把插入的空格算进偏移', () => {
  const items = [{ str: 'freshair' }]
  const layer = fakeLayer(['freshair'])
  const fix = spacedPageFix(layer, items, 'fresh air')
  assert.deepEqual(fix.inserted, [[5]])
  // 原偏移 [5,8) = "air" → 补过空格后要切到 "air"，不能因为多了一个空格而串位
  assert.equal(textFromSpacedOffsets(layer, fix, 5, 8), 'air')
  assert.equal(textFromSpacedOffsets(layer, fix, 0, 5), 'fresh')
  // 整段取出来：空格在里面
  assert.equal(textFromSpacedOffsets(layer, fix, 0, 8), 'fresh air')
  // 没有 fix 时与 textFromOffsets 完全一致（退回老路）
  assert.equal(textFromSpacedOffsets(layer, null, 0, 8), textFromOffsets(layer, 0, 8))
})

test('textFromSpacedOffsets 仍按行拼接（跨行补空格、行尾断词照旧）', () => {
  const items = [{ str: 'amanifesta-' }, { str: 'tionofdesire' }]
  const layer = fakeLayer(['amanifesta-', 'tionofdesire'])
  const fix = spacedPageFix(layer, items, 'a manifesta-tion of desire')
  assert.deepEqual(fix.lines, ['a manifesta-', 'tion of desire'])
  assert.equal(textFromSpacedOffsets(layer, fix, 0, 999), 'a manifestation of desire')
})

// ── 无 DOM 切片（页面还没渲染时用）─────────────────────────────────────────────
// 场景：重开一本书，在译文对照里点一条旧条目的「设为引用」——那一页还没渲染，
// 没有文字层可查，只能现问 pdf.js 要一份文字（items）。
test('linesFromItems 与 linesFromOffsets 逐字一致（两份实现不许漂移）', () => {
  const lines = ['Reading foreign literature', 'means meeting sentences', 'that do not survive']
  const items = lines.map((str) => ({ str }))
  const layer = fakeLayer(lines)
  for (const [a, b] of [[0, 999], [8, 20], [20, 35], [26, 31], [5, 60]]) {
    assert.deepEqual(linesFromItems(items, a, b), linesFromOffsets(layer, a, b))
  }
})

test('linesFromItems 只取与区间有交集的行，并对坏输入不炸', () => {
  const items = [{ str: 'abc' }, { str: '' }]
  assert.deepEqual(linesFromItems([{ str: 'abc' }, { str: 'de' }], 2, 4), ['c', 'd'])
  assert.deepEqual(linesFromItems([], 0, 10), [])
  assert.deepEqual(linesFromItems(null, 0, 10), [])
  assert.deepEqual(linesFromItems([{ str: 'abc' }], 10, 20), [])   // 整段在区间之外
  assert.deepEqual(linesFromItems([{ str: 'abc' }], 2, 1), [])     // 倒过来的区间
  assert.deepEqual(linesFromItems(items, 0, 3), ['abc'])           // 空 item 不产出空行
})

test('linesFromFixedItems 切补过空格那份，但偏移仍按原文字算', () => {
  const items = [{ str: 'freshair' }, { str: 'andmore' }]   // 原长 8 + 7
  const fix = restoreItemSpaces(items, 'fresh air and more')
  assert.deepEqual(fix.lines, ['fresh air', 'and more'])
  // 原偏移 [5,8) = "air" —— 补进来一个空格之后不能串位（与 textFromSpacedOffsets 同一把尺）
  assert.deepEqual(linesFromFixedItems(fix, 5, 8), ['air'])
  assert.deepEqual(linesFromFixedItems(fix, 8, 15), ['and more'])
  // 边界上那个补进来的空格：joinLines 会 trim 掉 —— 与 textFromSpacedOffsets 的行为完全一致
  assert.equal(joinLines(linesFromFixedItems(fix, 0, 5)), 'fresh')
  assert.equal(joinLines(linesFromFixedItems(fix, 0, 15)), 'fresh air and more')
  // 没有 fix（这页不需要补）时什么都不切，调用方会退回 linesFromItems
  assert.deepEqual(linesFromFixedItems(null, 0, 15), [])
  assert.deepEqual(linesFromFixedItems({ lines: null }, 0, 15), [])
})

test('linesFromFixedItems 与 spacedLinesFromOffsets 逐字一致（两份实现不许漂移）', () => {
  const lines = ['Reading foreign literature', 'means meeting', 'sentences that do', 'not survive translation']
  const items = lines.map((str) => ({ str }))
  const layer = fakeLayer(lines)
  const fix = spacedPageFix(layer, items, lines.join(' '))
  for (const [a, b] of [[0, 999], [0, 20], [20, 45], [8, 20], [26, 31], [0, 5]]) {
    assert.equal(joinLines(linesFromFixedItems(fix, a, b)), textFromSpacedOffsets(layer, fix, a, b),
      '区间 [' + a + ',' + b + ')')
  }
})

test('spacedPageFix 在没有文字层时也出手（页面还没渲染的页）', () => {
  // 有文字层：逐字校验照旧
  assert.equal(spacedPageFix(fakeLayer(['别的东西']), [{ str: 'thegeneraleditorof' }], 'the general editor of'), null)
  // 没有文字层（null）：items 与真字流出自同一次 getTextContent，跳过校验直接用
  const fix = spacedPageFix(null, [{ str: 'thegeneraleditorof' }], 'the general editor of')
  assert.equal(fix.lines[0], 'the general editor of')
  assert.equal(spacedPageFix(null, [], 'x'), null)
})

// ── 「划线附近原文」取哪几页、每页取哪一段（纯算术）──────────────────────────
/** 假页长表：只列出存在的页，其余当"拿不到这一页的文字"（null） */
const pageTotals = (map) => (n) => (n in map ? map[n] : null)

test('planContextWindow：划线在页面中部 → 只取这一页，前后各扩 300 字', () => {
  const plan = planContextWindow([{ page: 3, start: 400, end: 460 }], pageTotals({ 3: 1000 }))
  assert.deepEqual(plan, [{ page: 3, from: 100, to: 760 }])
})

test('planContextWindow：划线在页首 → 往前一页的尾巴补足 300 字', () => {
  const plan = planContextWindow([{ page: 3, start: 40, end: 100 }], pageTotals({ 2: 500, 3: 1000 }))
  assert.deepEqual(plan, [
    { page: 2, from: 240, to: 500 },     // 补 260 字（= 300 − 40）
    { page: 3, from: 0, to: 400 },
  ])
})

test('planContextWindow：划线在页尾 → 往后一页的开头补足 300 字', () => {
  const plan = planContextWindow([{ page: 3, start: 900, end: 960 }], pageTotals({ 3: 1000, 4: 400 }))
  assert.deepEqual(plan, [
    { page: 3, from: 600, to: 1000 },
    { page: 4, from: 0, to: 260 },       // 补 260 字（= 300 − 40）
  ])
})

test('planContextWindow：跨页划线 → 首页留前文、末页留后文、中间页整页要', () => {
  // 中间的页在真实数据里一定是"整页都被划线覆盖"（选区连续，offsetsAcrossPages 会把中间页夹成整页）
  const plan = planContextWindow(
    [{ page: 5, start: 200, end: 900 }, { page: 6, start: 0, end: 900 }, { page: 7, start: 0, end: 120 }],
    pageTotals({ 5: 1000, 6: 900, 7: 800 }),
  )
  assert.deepEqual(plan, [
    { page: 5, from: 0, to: 900 },
    { page: 6, from: 0, to: 900 },
    { page: 7, from: 0, to: 420 },
  ])
})

test('planContextWindow：没有邻页时给多少算多少（不假装凑满）', () => {
  const plan = planContextWindow([{ page: 1, start: 0, end: 50 }], pageTotals({ 1: 800 }))
  assert.deepEqual(plan, [{ page: 1, from: 0, to: 350 }])
})

test('planContextWindow：拿不到某一页（null）就跳过它，其余照常', () => {
  const plan = planContextWindow([{ page: 3, start: 10, end: 60 }], pageTotals({ 3: 900 }))
  assert.deepEqual(plan, [{ page: 3, from: 0, to: 360 }])
})

test('planContextWindow：往前补页最多 span 页（不让长书一路往前翻）', () => {
  const totals = pageTotals({ 1: 100, 2: 100, 3: 100, 4: 100, 5: 100 })
  const plan = planContextWindow([{ page: 5, start: 0, end: 10 }], totals, { span: 2 })
  assert.deepEqual(plan, [
    { page: 3, from: 0, to: 100 },
    { page: 4, from: 0, to: 100 },
    { page: 5, from: 0, to: 100 },      // 这一页只有 100 字，后文要不满 300 → 夹到页尾
  ])
  // span=0：一页都不往前补，只给划线所在页
  assert.deepEqual(planContextWindow([{ page: 5, start: 0, end: 10 }], totals, { span: 0 }),
    [{ page: 5, from: 0, to: 100 }])
})

test('planContextWindow：坏锚点与空输入返回空计划（不产出、也不抛）', () => {
  const totals = pageTotals({ 1: 500 })
  assert.deepEqual(planContextWindow([], totals), [])
  assert.deepEqual(planContextWindow(null, totals), [])
  assert.deepEqual(planContextWindow([{ page: NaN, start: 0, end: 10 }], totals), [])
  assert.deepEqual(planContextWindow([{ page: 1, start: undefined, end: 10 }], totals), [])
  assert.deepEqual(planContextWindow([{ page: 9, start: 0, end: 10 }], totals), [])   // 那一页拿不到文字
})

test('planContextWindow：划线那页没有文字（扫描件）→ 空计划，不拿旁页凑数', () => {
  // 这是无头自测抓到的真实缺陷：图片页没有文字层，如果不管这道闸，
  // "往前补页"会把上一页的尾巴当成"划线附近的原文"报上去 —— 那段文字与划线毫无关系。
  const totals = pageTotals({ 1: 500, 2: 400, 3: 0 })
  assert.deepEqual(planContextWindow([{ page: 3, start: 0, end: 10 }], totals), [])
  // 反过来：划线那页有文字时，邻页照样补
  assert.deepEqual(planContextWindow([{ page: 3, start: 0, end: 10 }], pageTotals({ 2: 400, 3: 300 })),
    [{ page: 2, from: 100, to: 400 }, { page: 3, from: 0, to: 300 }])
})

test('planContextWindow：before/after 可调，切片夹在页内不越界', () => {
  const plan = planContextWindow([{ page: 2, start: 10, end: 20 }], pageTotals({ 1: 40, 2: 30 }), { before: 25, after: 25 })
  assert.deepEqual(plan, [
    { page: 1, from: 25, to: 40 },       // 补 15 字（= 25 − 10）
    { page: 2, from: 0, to: 30 },        // 20 + 25 越出页尾 → 夹到 30
  ])
})

// ── contextForRef：设为引用时带什么上下文（2026-11 扫描件那条路）───────────────

test('contextForRef：文字条目有附近原文时，就用附近原文（不拿译文顶）', () => {
  const near = '前文……划线的那一句……后文'
  const entry = { kind: 'text', source: '划线的那一句', translation: '【译】划线的那一句' }
  assert.equal(contextForRef(near, entry), near)
})

test('contextForRef：扫描件没有附近原文 → 退回**整张卡片的译文**', () => {
  // 图片条目：kind=image、source 为空、translation 是整页译文
  const entry = { kind: 'image', source: '', translation: '第一句。第二句。第三句。' }
  assert.equal(contextForRef('', entry), '第一句。第二句。第三句。')
  // 没有 kind 但 source 为空（老快照）也按扫描件处理
  assert.equal(contextForRef('   ', { source: '', translation: '整页译文' }), '整页译文')
})

test('contextForRef：文字条目取不到附近原文时**不**拿译文顶（跨语言上下文比没有更坏）', () => {
  const entry = { kind: 'text', source: 'the original sentence', translation: '【译】原句' }
  assert.equal(contextForRef('', entry), '')
})

test('contextForRef：什么都没有时返回空串（不假装有上下文）', () => {
  assert.equal(contextForRef('', null), '')
  assert.equal(contextForRef('', { kind: 'image', translation: '' }), '')
})

// ── pickLocateAnchor：点一条引用该跳到哪一处（2026-10-25 用户实测的"跳到最近一处"）──

/** 一份"划在 page/start-end"的候选，写成来源表的形状 */
const src = (from, text, ...anchors) => ({ from, items: [{ text, anchors }] })

test('pickLocateAnchor：划那一刻记下的锚点压过同文的其它来源', () => {
  // 现场：把《置身事内》的 PDF 抽成文本，"全国预算收入"在第 56 页与第 58 页各一遍。
  // 用户划的是第 58 页那一处（"分税制改革之后，全国预算收入占GDP…"）。
  const a = pickLocateAnchor('全国预算收入', [
    src('mark', '全国预算收入', { page: 58, start: 251, end: 257 }),
    src('record', '全国预算收入', { page: 56, start: 655, end: 661 }),
  ])
  assert.deepEqual(a, { page: 58, start: 251, end: 257, from: 'mark' })
})

test('pickLocateAnchor：前一个来源里没有这一条 → 落到下一个来源', () => {
  const a = pickLocateAnchor('全国预算收入', [
    src('mark', '另一段完全不同的文字', { page: 12, start: 0, end: 4 }),
    src('entry', '全国预算收入', { page: 58, start: 251, end: 257 }),
    src('record', '全国预算收入', { page: 56, start: 655, end: 661 }),
  ])
  assert.deepEqual(a, { page: 58, start: 251, end: 257, from: 'entry' })
})

test('pickLocateAnchor：文字按"去空白"口径对齐（PDF 行间空格与存下来的不一致）', () => {
  const a = pickLocateAnchor('全国 预算\n收入', [src('mark', '全国预算收入', { page: 58, start: 251, end: 257 })])
  assert.deepEqual(a, { page: 58, start: 251, end: 257, from: 'mark' })
})

test('pickLocateAnchor：跨页的引用取**第一段**（按阅读顺序落位）', () => {
  const a = pickLocateAnchor('跨页的一段', [src('mark', '跨页的一段',
    { page: 3, start: 10, end: 30 }, { page: 4, start: 0, end: 12 })])
  assert.equal(a.page, 3)
  assert.equal(a.start, 10)
})

test('pickLocateAnchor：坏锚点跳过，不因一个坏值就整条放弃', () => {
  const a = pickLocateAnchor('全国预算收入', [src('mark', '全国预算收入',
    { page: 0, start: 1, end: 2 },        // 页号从 1 起
    { page: 58, start: 9, end: 9 },       // end <= start：框不住东西
    { page: 58, start: 'x', end: 5 },     // 偏移不是数
    { page: 58, start: 251, end: 257 })])
  assert.deepEqual(a, { page: 58, start: 251, end: 257, from: 'mark' })
})

test('pickLocateAnchor：都没有 / 入参不完整时返回 null（调用方据此退回按文字找）', () => {
  assert.equal(pickLocateAnchor('全国预算收入', []), null)
  assert.equal(pickLocateAnchor('全国预算收入', [src('mark', '别的段落', { page: 1, start: 0, end: 4 })]), null)
  assert.equal(pickLocateAnchor('全国预算收入', [{ from: 'mark' }]), null)
  assert.equal(pickLocateAnchor('全国预算收入', [src('mark', '全国预算收入', null)]), null)
  assert.equal(pickLocateAnchor('', [src('mark', '全国预算收入', { page: 1, start: 0, end: 4 })]), null)
  assert.equal(pickLocateAnchor('全国预算收入', null), null)
})
