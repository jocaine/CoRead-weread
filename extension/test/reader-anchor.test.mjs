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
  joinLines,
  linesFromOffsets,
  pageTextIndex,
  textFromOffsets,
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

// ── 锚点稳定性：同一对偏移在"重建过的"文字层上必须还指向同一段 ────────────────
test('同一对偏移在文字层重建后仍取到相同原文', () => {
  const lines = ['Reading foreign literature means meeting sentences', 'that do not survive translation by themselves.']
  const before = textFromOffsets(fakeLayer(lines), 0, 999)
  // 模拟缩放 / 重新打开：文字层 DOM 换成一批新节点，内容一致
  const after = textFromOffsets(fakeLayer([...lines]), 0, 999)
  assert.equal(before, after)
  assert.match(before, /^Reading foreign literature/)
  assert.match(before, /sentences that do not survive/)   // 跨行处是空格，不是粘连
})
