#!/usr/bin/env node
/**
 * L3 上下文渲染单元测试 — 内置 node:test。运行：node test/l3-context.test.js
 *
 * 口径（topic-library-design.md §5.4④，2026-10 定调）：
 * - 只渲染 point 标题行 + excerpts 原话，全量不截断
 * - **不渲染 aliases**（判定用索引不是语料）、不出现 derived/去路（由 userAncestry 保证来源）
 * - 标注来路跳数 / 本轮命中 / 源书名，命中节点由调用方排在最后
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { l3Block } from '../lib/l3-context.js'

const node = (id, point, { book = '', question = '', excerpts = [], aliases = [] } = {}) => ({
  id, point, aliases,
  discussions: [{ book, chapter: '', question, excerpts }],
})

test('L3 渲染：来路/命中标签、源书名、问题行、q/a 原话全量', () => {
  const entries = [
    { id: 'n_old', hops: 2, hit: false, node: node('n_old', '更早的知识点', { book: '学做工', question: '更早追的问题？', excerpts: [{ q: '更早的提问', a: '更早的回复' }] }) },
    { id: 'n_hit', hops: 0, hit: true, node: node('n_hit', '本轮指认的点', { book: '大国大城', question: '本轮追的问题？', excerpts: [{ q: '本轮提问', a: '本轮回复' }] }) },
  ]
  const out = l3Block(entries)
  assert.ok(out.includes('【来路 2 跳】 更早的知识点'), '来路标签 + point')
  assert.ok(out.includes('〔源：《学做工》〕'), '来源书名')
  assert.ok(out.includes('【本轮命中】 本轮指认的点'), '命中标签')
  assert.ok(out.includes('  · 这场讨论追的问题：更早追的问题？'), '问题行')
  assert.ok(out.includes('    用户："更早的提问"'))
  assert.ok(out.includes('    AI："更早的回复"'))
  // 顺序 = 入参顺序（排序由 userAncestry 负责：来路在前、命中在最后）。
  // 注意表头也含「【来路 N 跳】」「【本轮命中】」字样，只在正文里比较。
  const body = out.slice(out.indexOf('知识点路径：'))
  assert.ok(body.indexOf('【来路 2 跳】') < body.indexOf('【本轮命中】'))
  assert.ok(body.indexOf('【本轮命中】') > body.lastIndexOf('【来路'))
})

test('L3 渲染：不渲染 aliases（索引不是语料）', () => {
  const n = node('n_a', '知识点表述', { book: 'X', excerpts: [{ q: 'Q', a: 'A' }], aliases: ['能指一：这是给引用解析匹配用的背景说法', '能指二'] })
  const out = l3Block([{ id: 'n_a', hops: 0, hit: true, node: n }])
  assert.ok(!out.includes('能指一'))
  assert.ok(!out.includes('能指二'))
  assert.ok(!out.includes('aliases'))
})

test('L3 渲染：空 excerpts / 缺 discussions / 缺 book 不崩', () => {
  const out = l3Block([
    { id: 'n_1', hops: 1, hit: false, node: { id: 'n_1', point: '没有讨论内容' } },
    { id: 'n_2', hops: 0, hit: true, node: node('n_2', '有讨论但无轮次', { question: '问题？' }) },
  ])
  assert.ok(out.includes('【来路 1 跳】 没有讨论内容'))
  assert.ok(out.includes('【本轮命中】 有讨论但无轮次'))
  assert.ok(out.includes('  · 这场讨论追的问题：问题？'))
  assert.ok(!out.includes('〔源：'))
  assert.deepEqual(l3Block([]), [
    '[图路径上下文]（你引用/联想到了之前聊过的知识点）',
    '使用方式：用户这一轮的说法已匹配到下列旧知识点。回答时——',
    '① 先正面回答用户的问题本身，不要被下文带跑；',
    '② 下文全部是**你和用户当时说过的原话**（不是概括、不是系统的总结），把它当作"我们之前共同建立的理解"，在此基础上延续、修正或反驳，给出实质推进（新例证、新区分、明确反驳），不要复述原文；',
    '③ 【来路 N 跳】是那条讨论当时自己引用过的更早知识点（N 越大越早）；【本轮命中】是用户这一轮直接指认的，排在最后、最贴近当前问题；',
    '④ 只是背景资料，用户这一轮没提到的不要硬提。',
    '知识点路径：',
  ].join('\n'))
})
