#!/usr/bin/env node
/**
 * 用量记账（lib/usage-log.js）的约束（2026-10 诊断）
 *
 * 这个模块只做一件事：把服务商回来的 usage 原样记下来。它出错的形态很隐蔽——
 * 记错了不会报错，只会让报表给出**错的结论**（"命中率 0%"或"命中率 100%"），
 * 所以我们用测试钉住三条：
 *
 * ① 三种服务商口径都要认：DeepSeek 报 hit/miss 两字段、OpenAI 只报 cached_tokens、
 *    有的干脆不报缓存——不报时 hit/miss 记 **null**，绝不能编成 0（0 会被报表读成"全部未命中"）。
 * ② 记账失败绝不影响对话：磁盘满/目录没了只打一行警告，不抛。
 * ③ 两个 API 入口都要记（callLLMOnce / callLLMStream）——只记一处的话，
 *    报表会把另一处的量从总数里悄悄漏掉，而"总数对得上"正是这份报表唯一的用处。
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coread-usage-')), 'usage.jsonl')

test('readUsage：DeepSeek 口径（hit/miss 两字段）', () => {
  const u = readUsage({
    choices: [],
    usage: { prompt_tokens: 141234, completion_tokens: 812, prompt_cache_hit_tokens: 139000, prompt_cache_miss_tokens: 2234 },
  })
  assert.deepEqual(u, { input: 141234, output: 812, hit: 139000, miss: 2234 })
})

test('readUsage：OpenAI 口径（只报 cached_tokens，miss 用 input-hit 补）', () => {
  const u = readUsage({ usage: { prompt_tokens: 5000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 4000 } } })
  assert.deepEqual(u, { input: 5000, output: 100, hit: 4000, miss: 1000 })
})

test('readUsage：不报缓存字段 → hit/miss 是 null，不是 0（"没报"≠"全未命中"）', () => {
  const u = readUsage({ usage: { prompt_tokens: 3200, completion_tokens: 64 } })
  assert.equal(u.input, 3200)
  assert.equal(u.output, 64)
  assert.equal(u.hit, null)
  assert.equal(u.miss, null)
})

test('readUsage：中间帧没有 usage → null（流式不能拿 delta 判断要不要看终帧）', () => {
  assert.equal(readUsage({ choices: [{ delta: { content: '字' } }] }), null)
  assert.equal(readUsage(null), null)
  assert.equal(readUsage({ usage: {} }), null)
})

test('inferKind：按判定指令首句认类型，认不出记「判定」', () => {
  assert.equal(inferKind('你是 CoRead 的「会意系统」，现在执行动作①「判专题化」：判断…'), '判专题化')
  assert.equal(inferKind('你是 CoRead 的「会意系统」，现在判断：下面这条新消息…'), '判同一性')
  assert.equal(inferKind('你是 CoRead 的「会意系统」，现在做固化后分段：把一段…'), '分段判同一性')
  assert.equal(inferKind('你是 CoRead 的「会意系统」，现在执行动作③「引用解析」：在用户发言中…'), '引用解析')
  assert.equal(inferKind('你是 CoRead 的「会意系统」，现在为一个知识点条目写可指认的说法（aliases）。'), '派生能指')
  assert.equal(inferKind('你是 CoRead 的「相处规则」维护员。这份清单是…'), '相处规则')
  assert.equal(inferKind('随便一段没见过的判定材料'), '判定')
  assert.equal(inferKind(''), '判定')
})

test('appendUsage：一行一条 JSONL，字段齐、可回读', () => {
  const file = tmpFile()
  appendUsage({ ts: 1700000000000, kind: '主回复', conv: 'rd_x', model: 'm', stream: true, ms: 1200, input: 100, hit: 90, miss: 10, output: 5 }, file)
  appendUsage({ ts: 1700000000001, kind: '引用解析', input: 200, hit: null, miss: null }, file)
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { ts: 1700000000000, kind: '主回复', conv: 'rd_x', model: 'm', stream: true, ms: 1200, input: 100, hit: 90, miss: 10, output: 5 })
  assert.equal(rows[1].hit, null, '没报的命中数必须保持 null')
  assert.equal(rows[1].conv, undefined, '没有对话归属时不留空字段')
})

test('记账失败不影响对话：写不进去只警告，不抛', () => {
  const dir = path.join(os.tmpdir(), `coread-usage-missing-${Date.now()}`, 'nope', 'usage.jsonl')
  assert.doesNotThrow(() => appendUsage({ kind: '主回复', input: 1 }, dir))
  assert.doesNotThrow(() => recordUsage({ kind: '主回复', usage: { input: 1, hit: 0, miss: 1 } }, { file: dir }))
})

test('recordUsage 永不抛：它跑在流式解析循环里，抛一次就吞掉一帧正文', () => {
  const file = tmpFile()
  assert.doesNotThrow(() => recordUsage(null, { file }))
  assert.doesNotThrow(() => recordUsage({ kind: '判定', usage: {} }, { file }))
  assert.equal(recordUsage(null, { file: path.join(file, 'x', 'y') }), null, '写不进去时返回 null，不把异常留到调用方')
})

test('recordUsage：把 readUsage 的结果摊平进流水，且描述串带命中率', () => {
  const file = tmpFile()
  const row = recordUsage({ kind: '主回复', stream: true, usage: { input: 1000, hit: 900, miss: 100, output: 20 }, ms: 3000 }, { file })
  assert.equal(row.hit, 900)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).miss, 100)
  assert.match(describeUsage(row), /命中 900 \/ 未命中 100（90\.0%）/)
})

test('源码钉住：两个 API 入口都记账，usage 不再被丢掉', () => {
  assert.match(SRC, /stream_options:\s*\{\s*include_usage:\s*true\s*\}/, '流式必须继续请求 usage')
  const recorded = SRC.match(/recordUsage\(/g) || []
  assert.ok(recorded.length >= 2, `callLLMOnce 与 callLLMStream 都要记账，实际 ${recorded.length} 处`)
  assert.match(SRC, /if\s*\(!usageDone && parsed\.usage\)/, '流式要读终帧的 usage（终帧 choices 为空，不能挂在 delta 分支里）')
  assert.match(SRC, /const usage = data \? readUsage\(data\) : null/, '非流式要从响应体里取 usage')
  assert.match(SRC, /if \(usage\) recordUsage\(\{/, '没有 usage 的响应（429/500 错误体）不记一行假账')
})
