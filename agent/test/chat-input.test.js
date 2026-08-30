#!/usr/bin/env node
/**
 * chat_input/chat_output 配对（loadReplyByTs）单元测试 — 内置 node:test。
 * 运行：node test/chat-input.test.js
 *
 * 2026-08-28 修复（d_22 答非所问）：配对规则 = 该 user 之后、下一条 user 之前的
 * **第一条不带 `_stream`** 的非空 assistant——流式累计快照（_stream 递增 / -1 结束
 * 标记）不是完整回复；最终完整回复由 appendChatOutput 单独写一条不带 _stream 的记录。
 * 旧规则"最后一条非空 assistant"会抓到不属于本会话的孤儿回复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadReplyByTs, parseMessage } from '../lib/chat-input.js'

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-input-test-'))
  const inputPath = path.join(dir, 'chat_input.jsonl')
  const outputPath = path.join(dir, 'chat_output.jsonl')
  return { dir, inputPath, outputPath }
}

const U = (ts, content) => JSON.stringify({ role: 'user', timestamp: ts, content }) + '\n'
const A = (ts, content, stream) => JSON.stringify({ role: 'assistant', timestamp: ts, content, ...(stream !== undefined ? { _stream: stream } : {}) }) + '\n'

test('配对：流式快照全部跳过，取第一条不带 _stream 的完整回复', () => {
  const { dir, inputPath, outputPath } = tmpFiles()
  fs.writeFileSync(inputPath, U(100, '问题一') + U(200, '问题二'))
  // 问题一的回复：流式快照 1/2/3 + 流结束标记(-1) + 最终完整回复（不带 _stream）
  fs.writeFileSync(outputPath,
    A(110, '先', 1) + A(111, '先纠正', 2) + A(112, '先纠正：不是康尼派', 3) + A(113, '', -1) + A(114, '先纠正：不是康尼派，是孟什维克', undefined))
  const replyByTs = loadReplyByTs({ inputPath, outputPath })
  assert.equal(replyByTs.get(100), '先纠正：不是康尼派，是孟什维克', '取第一条不带 _stream 的完整回复')
  assert.equal(replyByTs.has(200), false, '问题二无回复')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('配对：孤儿 assistant（其 user 不在 chat_input）不再被任何 user 配对到', () => {
  const { dir, inputPath, outputPath } = tmpFiles()
  fs.writeFileSync(inputPath, U(100, '问题一') + U(200, '问题二'))
  // 孤儿回复：位于 100 与 200 之间但晚于 100 的真实回复（属于另一个会话/设备，chat_input 无对应 user）
  fs.writeFileSync(outputPath,
    A(105, '回复一', 1) + A(106, '回复一完', undefined) + A(150, '在的。今天读什么？', undefined))
  const replyByTs = loadReplyByTs({ inputPath, outputPath })
  assert.equal(replyByTs.get(100), '回复一完', '取第一条不带 _stream 的回复')
  assert.equal(replyByTs.has(200), false, '问题二在孤儿回复之后、无后续回复，不配对到孤儿')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('配对：无 _stream 字段的旧式输出（历史兼容）按第一条完整回复配对', () => {
  const { dir, inputPath, outputPath } = tmpFiles()
  fs.writeFileSync(inputPath, U(100, '问题一'))
  fs.writeFileSync(outputPath, A(110, '回复甲', undefined) + A(120, '回复乙', undefined))
  const replyByTs = loadReplyByTs({ inputPath, outputPath })
  assert.equal(replyByTs.get(100), '回复甲', '多条完整回复取第一条（该 user 的回复只有一条）')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('parseMessage：纯文本提问 / 引用格式拆解', () => {
  const p1 = parseMessage({ content: '为什么哥萨克立场复杂？', bookTitle: '《静静的顿河  五》', selectedText: '划线A' })
  assert.equal(p1.note, '为什么哥萨克立场复杂？')
  assert.equal(p1.chapter, '五')
  assert.equal(p1.sel, '划线A')
  assert.equal(p1.quoted, false)
  const p2 = parseMessage({ content: '[引用]《静静的顿河  五》\n> "划线B"\n\n那这个怎么解释？' })
  assert.equal(p2.note, '那这个怎么解释？')
  assert.equal(p2.chapter, '五')
  assert.equal(p2.sel, '划线B')
  assert.equal(p2.quoted, true)
})
