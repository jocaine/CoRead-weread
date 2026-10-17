#!/usr/bin/env node
/**
 * 自由对话「中途弹栈旧讨论暂存」单元测试 — 内置 node:test 运行器。
 * 运行：node test/free-closed-stacks.test.js
 *
 * 覆盖 2026-11 修的那条事故链：自由模式的讨论栈弹栈后，旧讨论原本被就地丢掉，
 * 归档只收最后留在栈里的那一段（22 轮的一场对话因此只出一个节点）。
 * 这里锁住暂存的三件事：攒得进去、取出来还是原样、归档/删除时清得掉。
 * 全部在临时目录里跑（不碰 data\sessions 里的真实数据）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readFreeClosedStacks,
  saveFreeClosedStacks,
  stashFreeClosedStack,
  closedStacksOf,
  dropFreeClosedStacks,
} from '../lib/free-closed-stacks.js'

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-fcs-'))
  return path.join(d, 'sessions', 'free-closed-stacks.json')
}

const KEY = '__coread_free_abcd1234__'
const seg = (q) => [{ role: 'user', content: q }, { role: 'assistant', content: '回答：' + q }]

test('读：文件不存在 → 空对象（不抛错，调用方按"没有暂存"处理）', () => {
  const f = tmpFile()
  assert.deepEqual(readFreeClosedStacks(f), {})
})

test('暂存：按 key 追加，返回累计段数；内容原样取回（含 cites）', () => {
  const f = tmpFile()
  assert.equal(stashFreeClosedStack(KEY, seg('第一段'), { file: f }), 1, '第一次 → 1 段')
  const withCites = [{ role: 'user', content: '第二段', cites: ['n_a', 'n_b'] }, { role: 'assistant', content: '回答' }]
  assert.equal(stashFreeClosedStack(KEY, withCites, { file: f }), 2, '第二次 → 2 段')
  const list = closedStacksOf(KEY, f)
  assert.equal(list.length, 2, '两段都在')
  assert.equal(list[0].entries[0].content, '第一段')
  assert.deepEqual(list[1].entries[0].cites, ['n_a', 'n_b'], 'cites 是收口建 user 边的材料，不能丢')
  assert.ok(list[0].ts > 0, '每段带暂存时间（归档时按它排序）')
})

test('暂存：key / entries 不合法 → 0 段，且不落盘', () => {
  const f = tmpFile()
  assert.equal(stashFreeClosedStack('', seg('x'), { file: f }), 0, '空 key')
  assert.equal(stashFreeClosedStack(KEY, [], { file: f }), 0, '空栈')
  assert.equal(stashFreeClosedStack(KEY, null, { file: f }), 0, 'null')
  assert.equal(fs.existsSync(f), false, '一次都不该建文件')
})

test('取：没有该 key → []；脏数据（entries 空/非数组）被滤掉', () => {
  const f = tmpFile()
  assert.deepEqual(closedStacksOf('__coread_free_none__', f), [], '没攒过 → []')
  saveFreeClosedStacks({
    [KEY]: [{ ts: 1, entries: seg('好的') }, { ts: 2, entries: [] }, { ts: 3 }, null, { ts: 4, entries: 'not-array' }],
  }, f)
  const list = closedStacksOf(KEY, f)
  assert.equal(list.length, 1, '只留 entries 非空的段')
  assert.equal(list[0].entries[0].content, '好的')
})

test('清：归档/删除时清掉该 key（返回是否真的清了东西）', () => {
  const f = tmpFile()
  stashFreeClosedStack(KEY, seg('要清的'), { file: f })
  stashFreeClosedStack('__coread_free_ffff0000__', seg('别人的'), { file: f })
  assert.equal(dropFreeClosedStacks(KEY, f), true, '第一次 → 清掉了')
  assert.equal(dropFreeClosedStacks(KEY, f), false, '再清 → 没东西可清')
  assert.deepEqual(closedStacksOf(KEY, f), [], '该 key 已空')
  assert.equal(closedStacksOf('__coread_free_ffff0000__', f).length, 1, '别的对话的暂存不受影响（按 key 隔离）')
})

test('写：先备份后写（第二次写留 .bak，可回退上一次清单）', () => {
  const f = tmpFile()
  stashFreeClosedStack(KEY, seg('第一次'), { file: f })
  assert.equal(fs.existsSync(f + '.bak'), false, '首次写没有上一版可备份')
  stashFreeClosedStack(KEY, seg('第二次'), { file: f })
  assert.equal(fs.existsSync(f + '.bak'), true, '第二次写留下 .bak')
  const bak = JSON.parse(fs.readFileSync(f + '.bak', 'utf8'))
  assert.equal(bak[KEY].length, 1, '.bak 是"只攒了第一段"时的那一版')
})

test('坏文件：内容不是 JSON → 读成空（不把归档整条链路带崩）', () => {
  const f = tmpFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{ 这不是 JSON')
  assert.deepEqual(readFreeClosedStacks(f), {})
  assert.equal(stashFreeClosedStack(KEY, seg('照样能攒'), { file: f }), 1, '坏文件被当成空的，接着写')
})
