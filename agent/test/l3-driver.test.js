#!/usr/bin/env node
/**
 * L3 装配层的三条硬约束（2026-10-24）
 *
 * 这个开关的故障形态和前几次一样——**不报错，只是悄悄换了行为**：
 *   · 开关文件写错一个字符 → 静默降级，你以为在跑新路径；
 *   · 装配顺序被改动 → L3 跑到本轮问题后面去，"块尾紧贴问题"那条定调失效；
 *   · 重构时把旧路径删了 → A/B 的基线没了，而且没人会发现（因为线上看起来正常）。
 * 所以三条都用测试钉住。
 *
 * 跑法：node agent/test/l3-driver.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readL3Mode, effectiveMode, assembleCallHist, L3_MODES } from '../lib/l3-driver.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const tmpFile = (content) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coread-l3mode-')), 'l3-mode')
  if (content !== undefined) fs.writeFileSync(f, content)
  return f
}

test('readL3Mode：缺文件 / 空文件 / 不认识的值 一律 full（默认必须是今天的行为）', () => {
  assert.equal(readL3Mode(tmpFile()), 'full', '文件不存在')
  assert.equal(readL3Mode(tmpFile('')), 'full', '空文件')
  assert.equal(readL3Mode(tmpFile('\n\n')), 'full', '只有空行')
  assert.equal(readL3Mode(tmpFile('task')), 'full', '拼错一个字母')
  assert.equal(readL3Mode(tmpFile('新路径')), 'full', '中文')
  assert.equal(readL3Mode(path.join(os.tmpdir(), 'coread-不存在', 'l3-mode')), 'full', '目录不存在')
})

test('readL3Mode：四个合法值，容忍大小写与首尾空白', () => {
  for (const m of L3_MODES) assert.equal(readL3Mode(tmpFile(m)), m)
  assert.equal(readL3Mode(tmpFile('  TASKS \n')), 'tasks')
  assert.equal(readL3Mode(tmpFile('OFF')), 'off')
})

test('effectiveMode：tasks 不走这个装配器（index.js 在装配前就分流到 l3-tasks 了）', () => {
  // 这里断言的是"兜底语义"：万一哪里漏判把 tasks 丢给 assembleCallHist，结果是
  // **按旧路径带上 L3**，而不是悄悄变成没有 L3。both 同理（还没实现）。
  assert.equal(effectiveMode('full'), 'full')
  assert.equal(effectiveMode('off'), 'off')
  assert.equal(effectiveMode('tasks'), 'full')
  assert.equal(effectiveMode('both'), 'full')
})

test('assembleCallHist：full 模式 = 历史 + persona + L3 + 锚定（顺序就是契约）', () => {
  const out = assembleCallHist({
    hist: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
    persona: '【背景档案】…',
    l3: '  [图路径上下文]…原话…  ',
    anchored: '【本轮消息】…问题…',
    mode: 'full',
  })
  assert.deepEqual(out, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: '【背景档案】…' },
    { role: 'user', content: '[图路径上下文]…原话…' },   // ← 必须夹在 persona 与本轮问题之间，且已 trim
    { role: 'user', content: '【本轮消息】…问题…' },
  ])
})

test('assembleCallHist：L3 为空（没有命中）时不插空消息——与改造前一致', () => {
  const base = { hist: [], persona: 'P', anchored: 'A', mode: 'full' }
  assert.deepEqual(assembleCallHist({ ...base, l3: '' }), [
    { role: 'user', content: 'P' },
    { role: 'user', content: 'A' },
  ])
  assert.deepEqual(assembleCallHist({ ...base, l3: '   \n ' }), [
    { role: 'user', content: 'P' },
    { role: 'user', content: 'A' },
  ])
})

test('assembleCallHist：off 模式完全不发 L3（第 0 步验证用）', () => {
  const out = assembleCallHist({ hist: [], persona: 'P', l3: '[图路径上下文]…', anchored: 'A', mode: 'off' })
  assert.deepEqual(out, [
    { role: 'user', content: 'P' },
    { role: 'user', content: 'A' },
  ])
})

test('assembleCallHist：相处规则排在 L3 之后、本轮问题之前（2026-10-27 用户定）', () => {
  // 它要的是"照这个说"，不是"了解这个人"——所以不能留在【背景档案】里，
  // 而且要贴着问题（模型对末尾更敏感）。
  const out = assembleCallHist({
    hist: [{ role: 'user', content: 'q1' }],
    persona: '【背景档案】…',
    l3: '[图路径上下文]…',
    agreement: '【相处规则】…1. 直接给判断…',
    anchored: '【本轮消息】…问题…',
    mode: 'full',
  })
  assert.deepEqual(out.map((m) => m.content), [
    'q1',
    '【背景档案】…',
    '[图路径上下文]…',
    '【相处规则】…1. 直接给判断…',
    '【本轮消息】…问题…',
  ])
  assert.equal(out.at(-1).content, '【本轮消息】…问题…', '问题永远在最后一条')
})

test('assembleCallHist：相处规则为空就不插空消息', () => {
  const base = { hist: [], persona: 'P', anchored: 'A', mode: 'full' }
  for (const agreement of ['', '   ', undefined]) {
    assert.deepEqual(assembleCallHist({ ...base, agreement }), [
      { role: 'user', content: 'P' },
      { role: 'user', content: 'A' },
    ])
  }
})

test('assembleCallHist：默认 mode 视为 full（调用方忘了传也不能丢 L3）', () => {
  const out = assembleCallHist({ hist: [], persona: 'P', l3: 'L', anchored: 'A' })
  assert.equal(out.length, 3)
  assert.equal(out[1].content, 'L')
})

test('源码钉住：旧路径没删（userAncestry + l3Block 仍在），装配已走 driver', () => {
  assert.match(SRC, /userAncestry\(graph, seeds\)/, '旧路径的来路闭包必须保留（A/B 基线）')
  assert.match(SRC, /l3Block\(ancestry\)/, '旧路径的渲染必须保留（A/B 基线）')
  assert.match(SRC, /assembleCallHist\(\{/, 'say() 的 messages 装配必须走 lib/l3-driver.js')
  assert.match(SRC, /readL3Mode\(\)/, '模式必须每轮现读（改文件即生效，不用重启）')
  assert.doesNotMatch(SRC, /\.\.\.\(l3Ctx \? \[/, '旧的临时变量拼装已由 driver 取代，不要留两份')
})
