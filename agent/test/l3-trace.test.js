#!/usr/bin/env node
/**
 * 全过程记录（调试用）的契约测试（2026-10-24）
 *
 * 这份记录是给人看的：调命题递归时，用户要能看清"草稿写了什么、每个课题喂了哪段、
 * 报告结论是哪句、**这一枝是谁点的题、点的什么题**、R4 手里有什么"。所以这里钉两件事：
 *   ① 每种事件都渲染得出来、字段没漏（漏了就等于那一步看不见）；
 *   ② 写文件的路径扛得住故障——记录写不进去绝不能让这一轮回答挂掉。
 *
 * 跑法：node agent/test/l3-trace.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { traceHeader, renderTraceEvent, localStamp, openL3Trace, pruneTraces } from '../lib/l3-trace.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coread-trace-'))

test('traceHeader：一眼看清这是哪一轮（对话/路径/命中/提问）', () => {
  const md = traceHeader({
    ts: '2026-10-24 14:12:03',
    conv: 'book_x',
    mode: 'tasks',
    path: 'tasks',
    points: [{ kid: 'K-1', point: '方向甲' }, { kid: 'K-2', point: '方向乙' }],
    question: '我想到之前聊过的那个机制',
  })
  assert.match(md, /# L3 命题递归 · 全过程/)
  assert.match(md, /- 时间：2026-10-24 14:12:03/)
  assert.match(md, /- 对话：`book_x`/)
  assert.match(md, /路径：tasks（装配模式 `tasks`）/)
  assert.match(md, /- K-1 「方向甲」/)
  assert.match(md, /- K-2 「方向乙」/)
  assert.match(md, /我想到之前聊过的那个机制/)
})

test('traceHeader：没有命中/没有问题也不留空壳', () => {
  const md = traceHeader({ conv: '', path: 'full' })
  assert.match(md, /本轮命中：0 个/)
  assert.doesNotMatch(md, /\*\*本轮提问\*\*\n\n```\n\n```/)
})

test('draft 事件：草稿全文 + 方向列表（草稿是最关键的一步，不能只报字数）', () => {
  const md = renderTraceEvent({ type: 'draft', raw: '【方向：甲】\n- 要点一', chars: 12, directions: ['甲'], ms: 4200 })
  assert.match(md, /① R1 草稿/)
  assert.match(md, /篇幅：12 字｜1 个方向｜耗时 4\.2s/)
  assert.match(md, /方向：「甲」/)
  assert.match(md, /【方向：甲】\n- 要点一/, '草稿全文要原样进记录')
})

test('draft 事件：没解析出方向也要说清（否则看的人以为是漏了）', () => {
  const md = renderTraceEvent({ type: 'draft', raw: '一段没标记的草稿', chars: 8, directions: [] })
  assert.match(md, /没解析出【方向：】标记/)
})

test('report 事件：材料规模、派给它的题、正文都在', () => {
  const md = renderTraceEvent({
    type: 'report', kid: 'K-1.1', point: '更早的方向', depth: 1, askedBy: 'K-1',
    question: '那段里有没有被反问的原文？', task: '请说清关于「接不住的信号」当时讲过什么', taskFrom: 'K-1',
    materialChars: 8035, truncated: true, ms: 6100,
    materialPreview: '〔知识点〕…',  body: '已知',

  })
  assert.match(md, /#### K-1\.1 「更早的方向」/)
  assert.match(md, /〔来路 1 跳 · K-1 点题〕材料 8,035 字（\*\*已截断\*\*，只给了前段）｜R2 6\.1s/)
  assert.match(md, /课题（K-1 派）：请说清关于「接不住的信号」当时讲过什么/)
  assert.match(md, /材料开头/)
})

test('report 事件：拒绝交付要明写（它进统计、不进汇总）', () => {
  const md = renderTraceEvent({ type: 'report', kid: 'K-2', point: 'p', depth: 0, aspect: '甲', refused: true, refuseWhy: '这段当时谈的是别的' })
  assert.match(md, /拒绝交付/)
  assert.match(md, /这段当时谈的是别的/)
})

test('report 事件：没拿到登记（模型挂了/输出不合法）也要留一行', () => {
  const md = renderTraceEvent({ type: 'report', ok: false, kid: 'K-3', point: 'p', depth: 0 })
  assert.match(md, /R2 登记\*\*：❌ 没拿到/)
})

test('ask 事件：候选表 + 派给每个候选的具体问题（这就是"命题递归"的题面）', () => {
  const md = renderTraceEvent({
    type: 'ask', kid: 'K-1', depth: 0, ms: 2100,
    candidates: [{ kid: 'K-1.1', point: '候选一' }, { kid: 'K-1.2', point: '候选二' }],
    asks: [{ kid: 'K-1.1', question: '那段里有没有被反问的原文？' }],
    raw: 'K-1.1：那段里有没有被反问的原文？',
  })
  assert.match(md, /#### R3 派题 · K-1（2 个候选父节点 → 派出 1 个问题）/)
  assert.match(md, /\| K-1\.1 候选一 \| 那段里有没有被反问的原文？ \|/)
  assert.match(md, /\| K-1\.2 候选二 \| — 用不上 \|/)
  assert.match(md, /K-1\.1：那段里有没有被反问的原文？/)
  assert.match(md, /R3 耗时 2\.1s/)
})

test('ask 事件：知识点的 | 不能把表格撑坏', () => {
  const md = renderTraceEvent({ type: 'ask', kid: 'K-1', depth: 0, candidates: [{ kid: 'K-1.1', point: '甲|乙' }], asks: [{ kid: 'K-1.1', question: '问|什么' }] })
  assert.match(md, /甲\\\|乙/)
  assert.match(md, /问\\\|什么/)
})

test('ask 事件：失败/跳过要写"没问成"，不能让人以为是"用不上"', () => {
  const failed = renderTraceEvent({ type: 'ask', kid: 'K-1', depth: 0, failed: true, reason: '只出了思考链', candidates: [{ kid: 'K-1.1', point: '候选一' }], asks: [] })
  assert.match(failed, /调用失败/)
  assert.match(failed, /这一层没问下去/)
  assert.match(failed, /候选（没问成）/)
  const skipped = renderTraceEvent({ type: 'ask', kid: 'K-1', depth: 0, skipped: '没有缺口', candidates: [], asks: [] })
  assert.match(skipped, /跳过：没有缺口/)
  assert.doesNotMatch(failed, /\| 候选（子节点看过它的材料开头）/, '失败时不该画题面表')
})

test('gate / fallback / note / section：都要在记录里留痕（不然看不出"为什么少了几步"）', () => {
  assert.match(renderTraceEvent({ type: 'gate', reason: '调用数 10/10' }), /兜底闸触发：调用数 10\/10/)
  assert.match(renderTraceEvent({ type: 'fallback', reason: 'R1 草稿失败' }), /退回旧的整段注入：R1 草稿失败/)
  assert.match(renderTraceEvent({ type: 'note', text: '本轮走 `full`' }), /> 本轮走 `full`/)
  assert.match(renderTraceEvent({ type: 'section', text: '② 命题递归' }), /\n## ② 命题递归\n/)
})

test('aggregate 事件：R4 的输入全文进记录（终稿是拿什么攒出来的，一眼可对）', () => {
  const md = renderTraceEvent({ type: 'aggregate', message: '【草稿】\n…\n【课题报告】\n…' })
  assert.match(md, /③ R4 的输入/)
  assert.match(md, /【课题报告】/)
})

test('final 事件：标题可带 label（both 模式要分得清 A/B 两份终稿）', () => {
  const md = renderTraceEvent({ type: 'final', label: 'B 新路径（这次没给用户看）', text: 'B 的正文' })
  assert.match(md, /## ④ B 新路径（这次没给用户看）/)
  assert.match(md, /B 的正文/)
  assert.match(renderTraceEvent({ type: 'final', text: '默认标题' }), /## ④ 终稿（用户看到的就是这段）/)
})

test('final 事件：终稿 + 覆盖度表（低于阈值标"疑似丢弃"）', () => {
  const md = renderTraceEvent({
    type: 'final', text: '这是终稿',
    coverage: [{ kid: 'K-1', ratio: 0.61 }, { kid: 'K-2', ratio: 0.05 }],
  })
  assert.match(md, /这是终稿/)
  assert.match(md, /\| K-1 \| 61% \| 已整合 \|/)
  assert.match(md, /\| K-2 \| 5% \| 疑似丢弃 \|/)
})

test('未知事件不抛，写一行注释（调试记录不能因为多一种事件就断）', () => {
  assert.match(renderTraceEvent({ type: '什么鬼' }), /<!-- 未知事件：什么鬼 -->/)
  assert.equal(renderTraceEvent(null).startsWith('\n<!-- 未知事件'), true)
})

test('dispatch 事件：派题要看得见每条候选派了什么（不许渲染成"未知事件"）', () => {
  const md = renderTraceEvent({
    type: 'dispatch', kid: 'K-1', depth: 0, ms: 2400, raw: 'K-1.1：无\nK-1.2：题',
    tasks: [{ kid: 'K-1.1', task: '' }, { kid: 'K-1.2', task: '要它交出当时讲接住的那段' }],
  })
  assert.doesNotMatch(md, /未知事件/)
  assert.match(md, /派题 · K-1/)
  assert.match(md, /2 个候选 → 1 个有题/)
  assert.match(md, /K-1\.1 \| — 用不上/)
  assert.match(md, /要它交出当时讲接住的那段/)
})

test('aggregate 事件：带 kid 的是每层回归汇总，不带 kid 的老事件才是 R4 的输入', () => {
  assert.match(renderTraceEvent({ type: 'aggregate', kid: 'K-1', message: '中转记录' }), /回归汇总 · K-1/)
  assert.match(renderTraceEvent({ type: 'aggregate', message: '草稿+报告' }), /R4 的输入/)
})

test('live 事件：本轮有效来路要写出来（下一轮继承的依据）', () => {
  assert.match(renderTraceEvent({ type: 'live', nodes: ['n_a', 'n_b'] }), /本轮有效来路 2 个.*n_a、n_b/)
  assert.match(renderTraceEvent({ type: 'live', nodes: [] }), /本轮没有新成功上报的来路节点/)
  // 被拒的节点是从继承集合里**去掉**的那批，也要看得见
  const both = renderTraceEvent({ type: 'live', nodes: ['n_a'], failed: ['n_x'] })
  assert.match(both, /本轮有效来路 1 个/)
  assert.match(both, /本轮被拒 1 个（从继承集合里去掉）：n_x/)
})

test('openL3Trace：建目录、写头、按顺序追加；返回可用的文件路径', () => {
  const dir = path.join(tmpDir(), 'l3-trace')
  const t = openL3Trace({ dir, meta: { conv: 'c1', path: 'tasks', points: [{ kid: 'K-1', point: '甲' }] } })
  assert.ok(t.file, '应当给出文件路径')
  t.write({ type: 'note', text: '第一件事' })
  t.write({ type: 'final', text: '终稿正文' })
  const md = fs.readFileSync(t.file, 'utf8')
  assert.match(md, /# L3 命题递归 · 全过程/)
  assert.ok(md.indexOf('第一件事') < md.indexOf('终稿正文'), '必须按事件顺序落盘')
})

test('openL3Trace：目录不可用时静默降级（记录写不进去，回答不能挂）', () => {
  const dir = tmpDir()
  const blocker = path.join(dir, 'not-a-dir')
  fs.writeFileSync(blocker, 'x')           // 拿一个**文件**当目录用
  const t = openL3Trace({ dir: blocker, meta: {} })
  assert.equal(t.file, '', '开不了就明确告诉调用方"没有文件"')
  assert.doesNotThrow(() => t.write({ type: 'note', text: 'x' }))
})

test('localStamp：文件名/标题用本地时间（不是 UTC，否则看日志的人会错 8 小时）', () => {
  const s = localStamp(new Date(2026, 9, 24, 14, 12, 3))
  assert.equal(s.file, '2026-10-24T14-12-03')
  assert.equal(s.human, '2026-10-24 14:12:03')
})

test('pruneTraces：只留最近 50 份（调试开关忘了关也不会攒成几百份）', () => {
  const dir = tmpDir()
  for (let i = 0; i < 55; i++) {
    const n = `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00-00-${String(i % 60).padStart(2, '0')}.md`
    fs.writeFileSync(path.join(dir, n), 'x')
  }
  fs.writeFileSync(path.join(dir, 'l3-dump.json'), '{}')   // 不是记录文件，不许动
  const before = fs.readdirSync(dir).length
  pruneTraces(dir, 50)
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
  assert.ok(names.length <= 50, `应当只剩 ≤50 份，实际 ${names.length}`)
  assert.ok(fs.existsSync(path.join(dir, 'l3-dump.json')), '别的文件不许误删')
  assert.ok(before > 50)
})
