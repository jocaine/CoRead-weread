#!/usr/bin/env node
/**
 * 引用自带的「划线附近原文」单元测试 — 内置 node:test。
 * 运行：node test/annotation-context.test.js（或在 agent/ 下 node --test）
 *
 * 背景（这条链路为什么存在）：微读的书，agent 靠 `chapters\*.txt` 里的整章正文取上下文；
 * PDF 阅读器没有章节正文（`chapters\` 是空的），上下文由阅读器在「设为引用」时算好、
 * 随标注一起报上来，落在 annotations.jsonl 的 `context` 字段。本文件锁的就是"认领"规则：
 * 认到就用、认不到就空手回去（绝不错认成另一条划线）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { annotationContextFor, findAnnotationContext, findAnnotationRef, readAnnotationRows } from '../lib/annotation-context.js'

const BOOK = 'rd_6b45298ee60849ff025176dbd8f88b75d90a1c04057550e9f37719513e2c2473'
const OTHER = 'rd_0562df5267e32a3fd43802e194cbd6bc8f3d099de90905700e0bffd207ad8aae'
const TEXT = ',\" the weeldy seminar he gives as chairman'
const CTX = 'attended the seminar for years. ' + TEXT + ' of the Department of Psychoanalysis.'

const row = (over = {}) => ({ bookId: BOOK, selectedText: TEXT, context: CTX, setRef: true, ...over })

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-context-test-'))
  const file = path.join(dir, 'annotations.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

// ── 认领规则 ──────────────────────────────────────────────────────────────────
test('按书 + 划线原文认领那段附近原文', () => {
  assert.equal(findAnnotationContext([row()], BOOK, TEXT), CTX)
})

test('空白差异不影响认领（pdf.js 吞空格、行尾断词都在这里被抹平）', () => {
  const spaced = '," the weeldy   seminar\nhe gives as chairman'
  assert.equal(findAnnotationContext([row()], BOOK, spaced), CTX)
  assert.equal(findAnnotationContext([{ ...row(), selectedText: spaced }], BOOK, TEXT), CTX)
})

test('别的书里的同名划线不会认领过来', () => {
  assert.equal(findAnnotationContext([row({ bookId: OTHER })], BOOK, TEXT), '')
})

test('书 ID 归一化交给调用方（agent 传的是自己的 baseBookId）', () => {
  const withSuffix = BOOK + 'k0123456789abcdef'
  const normalize = (id) => String(id || '').replace(/k[0-9a-f]{16,}$/i, '')
  assert.equal(findAnnotationContext([row({ bookId: withSuffix })], BOOK, TEXT, normalize), CTX)
  // 不传归一化函数时按原样比较 —— 带后缀的那条就认不到（这正是要传的理由）
  assert.equal(findAnnotationContext([row({ bookId: withSuffix })], BOOK, TEXT), '')
})

test('同一条划线划了多次：取最后一条（最近那次带的上下文）', () => {
  const rows = [row({ context: '旧的' }), row({ context: '新的' })]
  assert.equal(findAnnotationContext(rows, BOOK, TEXT), '新的')
})

test('前缀兜底：存档里那份多带了尾巴（行尾断词/多选了半句）也能认到', () => {
  // 存档里的划线原文比这次提问带过来的长一点，但前 24 字相同 —— 只有兜底那一步能认上
  const stored = TEXT + ' of the Department'
  assert.equal(findAnnotationContext([row({ selectedText: stored })], BOOK, TEXT), CTX)
  // 前 24 字也对不上就不能瞎认（宁可没有上下文，不可给错上下文）
  const 别的话 = '完全不同的一句话，前面二十四个字就分道扬镳了'
  assert.equal(findAnnotationContext([row({ selectedText: 别的话 })], BOOK, TEXT), '')
})

test('老标注（没有 context 字段）与坏输入一律返回空串', () => {
  const noCtx = { bookId: BOOK, selectedText: TEXT }
  assert.equal(findAnnotationContext([noCtx], BOOK, TEXT), '')
  assert.equal(findAnnotationContext([row({ context: '   ' })], BOOK, TEXT), '')
  assert.equal(findAnnotationContext([row()], BOOK, ''), '')
  assert.equal(findAnnotationContext([row()], '', TEXT), '')
  assert.equal(findAnnotationContext([], BOOK, TEXT), '')
  assert.equal(findAnnotationContext(null, BOOK, TEXT), '')
})

// ── 整条记录（译文引用要拿它判断"有没有 translation"）───────────────────────
test('findAnnotationRef 返回整条记录，不只是 context', () => {
  const withTr = row({ translation: '译文片段' })
  const hit = findAnnotationRef([withTr], BOOK, TEXT)
  assert.equal(hit, withTr)
  assert.equal(hit.translation, '译文片段')
  assert.equal(findAnnotationRef([row({ bookId: OTHER })], BOOK, TEXT), null)
  assert.equal(findAnnotationRef([], BOOK, TEXT), null)
})

test('findAnnotationRef：同一段有两条时，带 context 的优先（旧 findAnnotationContext 只认它）', () => {
  // 真实来路：先设过一次引用（带 context），后来又设了一次（没有 context）。
  // 上下文要取那条带 context 的；但"是不是译文"两条都说得出，取哪条都不影响判定。
  const noCtx = { bookId: BOOK, selectedText: TEXT, translation: '译文' }
  const rows = [noCtx, row({ context: '新的上下文', translation: '译文' })]
  assert.equal(findAnnotationRef(rows, BOOK, TEXT).context, '新的上下文')
  assert.equal(findAnnotationContext(rows, BOOK, TEXT), '新的上下文')
})

test('findAnnotationRef：只有"有译文没 context"的记录也要认得到', () => {
  const noCtx = { bookId: BOOK, selectedText: TEXT, translation: '译文' }
  assert.equal(findAnnotationRef([noCtx], BOOK, TEXT), noCtx)
  // 上下文仍然空手（旧行为不变）
  assert.equal(findAnnotationContext([noCtx], BOOK, TEXT), '')
})

// ── 读存档 ────────────────────────────────────────────────────────────────────
test('readAnnotationRows 跳过解析不了的行，文件不在就返回空数组', () => {
  const file = tmpFile([JSON.stringify(row()), '{ 这不是 JSON', '', JSON.stringify(row({ bookId: OTHER }))])
  assert.equal(readAnnotationRows(file).length, 2)
  assert.deepEqual(readAnnotationRows(path.join(path.dirname(file), '不存在.jsonl')), [])
})

test('annotationContextFor 直接从存档文件认领（agent 走的就是这一步）', () => {
  const file = tmpFile([JSON.stringify(row())])
  assert.equal(annotationContextFor(BOOK, TEXT, { file }), CTX)
  assert.equal(annotationContextFor(OTHER, TEXT, { file }), '')
})

test('存档改动后缓存会跟上（按 size+mtime 失效，不会读到旧内容）', () => {
  const file = tmpFile([JSON.stringify(row({ context: '第一版' }))])
  assert.equal(annotationContextFor(BOOK, TEXT, { file }), '第一版')
  fs.writeFileSync(file, JSON.stringify(row({ context: '第二版，长一点点' })) + '\n')
  assert.equal(annotationContextFor(BOOK, TEXT, { file }), '第二版，长一点点')
})
