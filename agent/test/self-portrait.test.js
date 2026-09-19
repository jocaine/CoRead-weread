#!/usr/bin/env node
/**
 * 用户情况与观念画像维护（self-portrait）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/self-portrait.test.js
 *
 * 假 callLLM 测代码逻辑（重试、解析、校验、去重参照）；真实模型行为用回填脚本端到端验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ATTEMPTS,
  judgeSelfPortrait,
  parseSelfPortraitResult,
  buildSelfPortraitPrompt,
  buildSelfPortraitInstruction,
  MAX_NOTE_CHARS,
} from '../lib/self-portrait.js'

// ── 测试辅助 ────────────────────────────────────────────────────────────────
function makeLLM(...responses) {
  const queue = [...responses]
  return async (prompt, maxTokens) => {
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'callLLM 应收到非空 prompt')
    assert.ok(Number.isFinite(maxTokens), 'callLLM 应收到 maxTokens')
    const r = queue.shift()
    if (r === undefined) throw new Error('unexpected extra callLLM call')
    if (r instanceof Error) throw r
    return r
  }
}

const okAll = (s, e, t, b) => JSON.stringify({ situation: s || [], events: e || [], thoughts: t || [], belief: b || [] })

// ── 判定解析 ────────────────────────────────────────────────────────────────
test('解析：标准输出 → situation/belief', () => {
  assert.deepEqual(parseSelfPortraitResult('{"situation":["父母离婚"],"events":["8月离职"],"thoughts":["觉得乡愁太早"],"belief":["反感宿命论"]}'), { situation: ['父母离婚'], events: ['8月离职'], thoughts: ['觉得乡愁太早'], belief: ['反感宿命论'] })
})

test('解析：空数组合法（无新信息）', () => {
  assert.deepEqual(parseSelfPortraitResult('{"situation":[],"events":[],"thoughts":[],"belief":[]}'), { situation: [], events: [], thoughts: [], belief: [] })
})

test('解析：容忍围栏/前言回显/多余字段', () => {
  assert.deepEqual(parseSelfPortraitResult('```json\n{"situation":["x"],"events":[],"thoughts":[],"belief":[],"extra":1}\n```'), { situation: ['x'], events: [], thoughts: [], belief: [] })
  assert.deepEqual(parseSelfPortraitResult('结果如下。{"situation":["x"]}'), { situation: ['x'], events: [], thoughts: [], belief: [] })
})

test('解析：过滤空串、缺字段/非数组 → null', () => {
  assert.deepEqual(parseSelfPortraitResult('{"situation":[""," a "],"belief":null}'), { situation: ['a'], events: [], thoughts: [], belief: [] })
  assert.equal(parseSelfPortraitResult('{"record":[]}'), null)
  assert.equal(parseSelfPortraitResult('{"situation":"x"}'), null)
  assert.equal(parseSelfPortraitResult('不是 JSON'), null)
})

// ── 主流程 ────────────────────────────────────────────────────────────────
test('主流程：有情况+观念 → 返回两条目', async () => {
  const r = await judgeSelfPortrait({ userNote: '我父母离婚了，8月从启辰之星离职，给孙阿姨打了电话，而且我认为制度优越性依附于国际位置' }, { callLLM: makeLLM(okAll(['父母离婚'], ['8月从启辰之星离职', '给孙阿姨打了电话'], ['打电话前犹豫了很久'], ['认为制度优越性依附于国际位置'])) })
  assert.deepEqual(r.situation, ['父母离婚'])
  assert.deepEqual(r.events, ['8月从启辰之星离职', '给孙阿姨打了电话'])
  assert.deepEqual(r.thoughts, ['打电话前犹豫了很久'])
  assert.deepEqual(r.belief, ['认为制度优越性依附于国际位置'])
  assert.equal(r.attempts, 1)
})

test('主流程：无新信息 → 双空数组（零写入）', async () => {
  const r = await judgeSelfPortrait({ userNote: '列宁当时对哥萨克的判断是什么' }, { callLLM: makeLLM(okAll([], [], [], [])) })
  assert.deepEqual(r.situation, [])
  assert.deepEqual(r.events, [])
  assert.deepEqual(r.thoughts, [])
  assert.deepEqual(r.belief, [])
})

test('主流程：现有画像传入 prompt 作去重参照', async () => {
  let seenPrompt = ''
  const callLLM = async (p, mt) => { seenPrompt = p; return okAll([], [], [], []) }
  await judgeSelfPortrait({ userNote: '我父母离婚了' }, { callLLM, existing: '## 情况\n- 父母离婚' })
  assert.ok(seenPrompt.includes('现有画像（仅作去重参照'))
  assert.ok(seenPrompt.includes('父母离婚'))
})

test('主流程：空消息 / 未注入 callLLM → TypeError', async () => {
  await assert.rejects(judgeSelfPortrait({ userNote: '' }, { callLLM: makeLLM(okAll()) }), /需要用户消息内容/)
  await assert.rejects(judgeSelfPortrait({ userNote: 'x' }, {}), /必须注入 callLLM/)
  await assert.rejects(judgeSelfPortrait(null, { callLLM: makeLLM(okAll()) }), /input 必须是消息对象/)
})

test('主流程：超长消息截断到 MAX_NOTE_CHARS', async () => {
  const long = '我'.repeat(MAX_NOTE_CHARS + 100)
  let seenPrompt = ''
  const callLLM = async (p, mt) => { seenPrompt = p; return okAll() }
  await judgeSelfPortrait({ userNote: long }, { callLLM })
  assert.ok(seenPrompt.includes('消息过长，已截断'))
})

// ── 重试与容错 ─────────────────────────────────────────────────────────────
test('重试：非法输出 → 带修正提示重试 → 成功', async () => {
  const callLLM = makeLLM('思考草稿…', okAll(['我当过兵']))
  const r = await judgeSelfPortrait({ userNote: '我当过兵' }, { callLLM })
  assert.deepEqual(r.situation, ['我当过兵'])
  assert.equal(r.attempts, 2)
})

test('重试：非法输出耗尽 → Error', async () => {
  await assert.rejects(judgeSelfPortrait({ userNote: 'x' }, { callLLM: makeLLM('垃圾', '垃圾', '垃圾') }), /仍无有效判定/)
})

test('重试：⚠️ 上游失败串 / 调用抛错 → 重试成功', async () => {
  const r1 = await judgeSelfPortrait({ userNote: 'x' }, { callLLM: makeLLM('⚠️ 上游 500', okAll(['x'])) })
  assert.deepEqual(r1.situation, ['x'])
  const r2 = await judgeSelfPortrait({ userNote: 'x' }, { callLLM: makeLLM(new Error('net'), okAll(['y'])) })
  assert.deepEqual(r2.situation, ['y'])
})

test('重试：调用抛错耗尽 → Error', async () => {
  await assert.rejects(judgeSelfPortrait({ userNote: 'x' }, { callLLM: makeLLM(new Error('net'), new Error('net'), new Error('net')) }), /画像维护 LLM 调用失败.*net/)
})

test('MAX_ATTEMPTS 导出 = 3', () => {
  assert.equal(MAX_ATTEMPTS, 3)
})

test('prompt 组装：含指令、用户消息、situation/belief 定义', () => {
  const p = buildSelfPortraitPrompt({ userNote: '我最近在换工作' })
  assert.ok(p.includes('用户画像'))
  assert.ok(p.includes('situation（情况）'))
  assert.ok(p.includes('belief（观念）'))
  assert.ok(p.includes('events（做过的事）'))
  assert.ok(p.includes('thoughts（对事件的思考）'))
  assert.ok(p.includes('我最近在换工作'))
})

test('prompt 组装（2026-10 缓存定调：材料在前、消息在后）：现有画像/脉络/划线先于用户消息', () => {
  const p = buildSelfPortraitPrompt(
    { userNote: '我最近在换工作', selected: { text: '划线文本' } },
    '现有画像条目甲\n现有画像条目乙',
    '脉络内容'
  )
  const idx = (s) => { const i = p.indexOf(s); assert.ok(i !== -1, '应包含：' + s.slice(0, 20)); return i }
  const iInst = idx('你是 CoRead 的「用户画像」维护员')
  const iExisting = idx('现有画像（仅作去重参照，不要重复输出已覆盖的信息）：')
  const iCtx = idx('对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：')
  const iSel = idx('划线内容（仅用于解析消息中的指代）：')
  const iUser = idx('用户消息："我最近在换工作"')
  assert.ok(iInst < iExisting, '指令在最前')
  assert.ok(iExisting < iCtx, '现有画像（稳定材料）应先于可变材料——静态前缀可扩展')
  assert.ok(iCtx < iUser && iSel < iUser, '可变材料与划线都在用户消息前（判定对象在后）')
  assert.ok(p.trim().endsWith('用户消息："我最近在换工作"'), '用户消息应位于 prompt 末尾')
})