#!/usr/bin/env node
/**
 * 用量记账（lib/usage-log.js）的约束（2026-10 诊断）
 *
 * 这个模块只做一件事：把服务商回来的 usage 原样记下来。它出错的形态很隐蔽——
 * 记错了不会报错，只会让报表给出**错的结论**（"命中率 0%"或"命中率 100%"），
 * 所以我们用测试钉住四条：
 *
 * ① 三种服务商口径都要认：DeepSeek 报 hit/miss 两字段、OpenAI 只报 cached_tokens、
 *    有的干脆不报缓存——不报时 hit/miss 记 **null**，绝不能编成 0（0 会被报表读成"全部未命中"）。
 * ② 记账失败绝不影响对话：磁盘满/目录没了只打一行警告，不抛。
 * ③ 两个 API 入口都要记（callLLMOnce / callLLMStream）——只记一处的话，
 *    流式那条（占绝大多数）就永远不在报表里。
 * ④ 推理模型的"思考"要单独记一格（2026-10-24 加）：它算在 output 里，不分开就没法判断
 *    "这份报告到底花了多少 token"——实测一次课题报告 93% 的输出是思考。
 *
 * 跑法：node agent/test/usage-log.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readUsage, inferKind, appendUsage, recordUsage, describeUsage } from '../lib/usage-log.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coread-usage-')), 'usage.jsonl')

test('readUsage：DeepSeek 口径（hit/miss 两字段）', () => {
  const u = readUsage({
    usage: { prompt_tokens: 141234, completion_tokens: 812, prompt_cache_hit_tokens: 139000, prompt_cache_miss_tokens: 2234 },
  })
  assert.deepEqual(u, { input: 141234, output: 812, hit: 139000, miss: 2234, think: null })
})

test('readUsage：OpenAI 口径（只有 cached_tokens，miss 用 input-hit 补）', () => {
  const u = readUsage({ usage: { prompt_tokens: 5000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 4000 } } })
  assert.deepEqual(u, { input: 5000, output: 100, hit: 4000, miss: 1000, think: null })
})

test('readUsage：只报了一个数时补另一个；两个都没报就都留 null（不许编 0）', () => {
  const onlyHit = readUsage({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900 } })
  assert.equal(onlyHit.miss, 100)
  const neither = readUsage({ usage: { prompt_tokens: 1000, completion_tokens: 10 } })
  assert.equal(neither.hit, null)
  assert.equal(neither.miss, null)
})

test('readUsage：没有 usage 的响应 → null（429/500 的错误体不该记一行）', () => {
  assert.equal(readUsage(null), null)
  assert.equal(readUsage({}), null)
  assert.equal(readUsage({ error: { message: 'rate limited' } }), null)
  assert.equal(readUsage({ usage: {} }), null)
})

test('readUsage：推理模型的"思考"单独记一格（否则"输出"会被当成正文体积）', () => {
  const u = readUsage({
    usage: {
      prompt_tokens: 100, completion_tokens: 900,
      prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 800 },
    },
  })
  assert.equal(u.output, 900)
  assert.equal(u.think, 800, '900 里 800 是思考，正文只有 100')
})

test('inferKind：按判定指令的首句分档；认不出记「判定」', () => {
  assert.equal(inferKind('现在做动作③「引用解析」：下面这条消息…'), '引用解析')
  assert.equal(inferKind('现在判断：下面这条新消息和上一条是不是同一个问题'), '判同一性')
  assert.equal(inferKind('我不认得这句话'), '判定')
  assert.equal(inferKind(''), '判定')
})

test('appendUsage：落一行 JSON，缺的字段保持 null、没有的不留空壳', () => {
  const file = tmpFile()
  const row = appendUsage({
    ts: 1700000000000, kind: '主回复', conv: 'rd_x', model: 'm', stream: true, ms: 1200,
    input: 100, hit: 90, miss: 10, output: 5,
  }, file)
  assert.equal(row.kind, '主回复')
  appendUsage({ kind: '判定', input: 10, output: 1 }, file)
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ts, 1700000000000)
  assert.equal(rows[0].hit, 90)
  assert.equal(rows[1].hit, null, '没报的命中数必须保持 null')
  assert.equal(rows[1].conv, undefined, '没有对话归属时不留空字段')
  assert.equal(rows[1].stream, false)
})

test('appendUsage：带思考的调用会把 think 写进去（报表要靠它区分思考与正文）', () => {
  const file = tmpFile()
  appendUsage({ kind: '课题报告', input: 100, output: 900, think: 800 }, file)
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(row.think, 800)
})

test('appendUsage：写不进去返回 null，不抛（磁盘满/目录没了都不该让对话挂掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-usage-'))
  const blocker = path.join(dir, 'not-a-dir')
  fs.writeFileSync(blocker, 'x')
  assert.equal(appendUsage({ kind: 'x' }, path.join(blocker, 'sub', 'usage.jsonl')), null)
})

test('recordUsage：永不抛（坏参数 / 坏路径都一样）', () => {
  assert.doesNotThrow(() => recordUsage(null))
  assert.doesNotThrow(() => recordUsage({ kind: 'x', usage: { input: 1 } }, { file: path.join(os.tmpdir(), '不存在的目录', 'x.jsonl') }))
})

test('describeUsage：命中/未命中带百分比，输出带思考分开报', () => {
  const one = describeUsage({ kind: 'x', input: 100, hit: 90, miss: 10, output: 5, ms: 1200 })
  assert.match(one, /输入 100/)
  assert.match(one, /命中 90 \/ 未命中 10（90\.0%）/)
  assert.match(one, /输出 5/)
  assert.match(one, /1\.2s/)
  assert.match(describeUsage({ kind: 'x', output: 900, think: 800 }), /输出 900（其中思考 800）/)
  assert.match(describeUsage({ kind: 'x', input: 10 }), /该服务商未回报缓存命中数/)
})

test('源码钉住：两个出口都记账（usage 曾经被读完就丢）', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
  const hits = (src.match(/recordUsage\(\{/g) || []).length
  assert.ok(hits >= 2, `callLLMOnce 与 callLLMStream 都要记账，实际 ${hits} 处`)
  assert.match(src, /include_usage: true/, '流式必须要求服务商回 usage')
})
