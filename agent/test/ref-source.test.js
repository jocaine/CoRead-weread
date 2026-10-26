#!/usr/bin/env node
/**
 * 译文引用的原文块 — 内置 node:test。
 * 运行：node test/ref-source.test.js（或在 agent/ 下 node --test）
 *
 * 背景（2026-10-24）：PDF 阅读器里用户划的是译文，引用身份却是原文。拼 prompt 时要判断
 * 这条引用是不是译文、该挂哪份原文做对照。判定只有两步（标注字段 / 语言兜底），
 * 但错了会让模型把中文当原文，所以单独钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { REF_SOURCE_MAX, clipRefSource, isTranslatedRef, refSourceOf } from '../lib/ref-source.js'

const EN = 'Until Germany has broken through the entanglement of such Medusa-like beliefs'
const ZH = '在德国冲破这些文章中迎面而来的、如美杜莎般纠缠的信念之前'
const MATERIAL = '> "' + ZH + '"'

// ── 判定 ──────────────────────────────────────────────────────────────────────
test('标注记录里有 translation：就是译文引用', () => {
  assert.equal(isTranslatedRef({ ref: { translation: ZH }, selectedText: EN, material: MATERIAL }), true)
  // 空白字符串不算（空字符串在存档里等价于"没有译文"）；这条用英文引文隔离掉语言兜底
  assert.equal(isTranslatedRef({ ref: { translation: '   ' }, selectedText: EN, material: '> "' + EN + '"' }), false)
})

test('认不到记录时按语言兜底：中文引文 + 非中文原文 = 译文', () => {
  assert.equal(isTranslatedRef({ ref: null, selectedText: EN, material: MATERIAL }), true)
})

test('两边同语言 / 有一边为空：不是译文引用', () => {
  // 微读的中文划线：引文与身份都是中文
  assert.equal(isTranslatedRef({ ref: null, selectedText: ZH, material: MATERIAL }), false)
  // 英文引文（没翻过的段落）
  assert.equal(isTranslatedRef({ ref: null, selectedText: EN, material: '> "' + EN + '"' }), false)
  assert.equal(isTranslatedRef({ ref: null, selectedText: '', material: MATERIAL }), false)
  assert.equal(isTranslatedRef({}), false)
})

// ── 取哪份原文 ────────────────────────────────────────────────────────────────
test('context 是外文原文（文字条目）→ 用 context，它带划线前后各 300 字', () => {
  const ref = { context: 'before ' + EN + ' after' }
  assert.equal(refSourceOf({ ref, selectedText: EN }), 'before ' + EN + ' after')
})

test('context 是整卡译文（扫描件）→ 退回引用身份 selectedText', () => {
  const ref = { context: ZH + '（整卡译文）' }
  assert.equal(refSourceOf({ ref, selectedText: EN }), EN)
})

test('没有 context / 没有记录 → 退回 selectedText', () => {
  assert.equal(refSourceOf({ ref: { context: '   ' }, selectedText: EN }), EN)
  assert.equal(refSourceOf({ ref: null, selectedText: EN }), EN)
  assert.equal(refSourceOf({}), '')
})

// ── 截断 ──────────────────────────────────────────────────────────────────────
test('clipRefSource 超长时截断并留下说明（静默截断会让模型以为原文就到这儿）', () => {
  assert.equal(clipRefSource('  short  '), 'short')
  const long = 'x'.repeat(REF_SOURCE_MAX + 20)
  const cut = clipRefSource(long)
  assert.ok(cut.length > REF_SOURCE_MAX)
  assert.ok(cut.endsWith('（原文过长，已截断）'))
  assert.ok(cut.startsWith(long.slice(0, 100)))
})
