#!/usr/bin/env node
/**
 * 「停止当前回答」信号文件的路径助手测试（2026-02）
 *
 * 这里只测最容易悄悄出错的纯逻辑：文件名怎么来。两条不能破的性质——
 *   ① 按对话隔离：在 A 对话点停止，不能在 agent 处理 B 对话时被误判；
 *   ② 路径穿越防护：对话 key 来自请求体（receiver 的 POST body），
 *      直接拼进文件名的话一个 `..\..\x` 就能把信号写到别处去。
 * 不测 agent 侧的三道闸与前端收尾：那两处要真实 DOM / 轮询循环，属性测试在这里
 * 只能测出"我自己写的替身"，价值不如留给人手验一遍。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { sessionStopFile, listSessionStopFiles, RUNTIME_DIR } from '../lib/paths.js'

test('停止信号按对话隔离：不同对话 key 得到不同文件', () => {
  const a = sessionStopFile('mia_aaaaaaaaaaaaaaaaaaaa')
  const b = sessionStopFile('mia_bbbbbbbbbbbbbbbbbbbb')
  const c = sessionStopFile('__coread_free_1234abcd__')
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
})

test('停止信号是幂等的：同一个 key 每次得到同一个文件', () => {
  assert.equal(sessionStopFile('mia_x'), sessionStopFile('mia_x'))
})

test('文件名不含对话 key 本身（防路径穿越）', () => {
  const evil = '..\\..\\..\\evil'
  const f = sessionStopFile(evil)
  assert.ok(!f.includes('evil'), '文件名里不该出现请求体带来的原文')
  assert.ok(f.includes('session-stop-'), '仍然是可识别的停止信号文件')
})

test('无论 key 多恶意，落点都在 runtime 目录内', () => {
  const cases = [
    '..\\..\\..\\windows\\system32\\x',
    '../../../../etc/passwd',
    'mia_ok/../../escape',
    '',
    '   ',
    'x'.repeat(5000),
  ]
  for (const k of cases) {
    const f = sessionStopFile(k)
    const rel = path.relative(RUNTIME_DIR, f)
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel),
      `key=${JSON.stringify(k.slice(0, 30))} 逃出了 runtime 目录：${f}`)
  }
})

test('listSessionStopFiles 只认停止信号文件，不误伤 runtime 里的其它文件', () => {
  const names = listSessionStopFiles()
  assert.ok(Array.isArray(names))
  for (const n of names) {
    assert.match(path.basename(n), /^session-stop-[0-9a-f]{16}\.json$/)
  }
})
