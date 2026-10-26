#!/usr/bin/env node
/**
 * `/l3` 指令的契约测试（2026-10-24）
 *
 * 这条指令的价值全在"**回执必须说实话**"：切了没有、现在是哪个模式、调试开没开。
 * 它一旦回错，用户会以为自己在跑新路径、其实还在旧路径上——那种错不会报错，只会白跑几天。
 *
 * 跑法：node agent/test/l3-cmd.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleL3Command, MODE_DESC } from '../lib/l3-cmd.js'

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-l3cmd-'))
  return { dir, modeFile: path.join(dir, 'l3-mode'), debugFile: path.join(dir, 'l3-debug') }
}

test('不带参数：念当前模式 + 调试状态 + 用法（不许默默什么都不做）', () => {
  const f = tmp()
  fs.writeFileSync(f.modeFile, 'tasks\n')
  const r = handleL3Command('', f)
  assert.match(r.reply, /当前：模式 `tasks`/)
  assert.match(r.reply, /调试 关/)
  assert.match(r.reply, /\/l3 full\|tasks\|both\|off/)
  assert.equal(r.changed, false)
})

test('切模式：真的写进文件，回执说清"下一句生效"', () => {
  const f = tmp()
  fs.writeFileSync(f.modeFile, 'full\n')
  const r = handleL3Command('tasks', f)
  assert.equal(r.mode, 'tasks')
  assert.equal(r.changed, true)
  assert.equal(fs.readFileSync(f.modeFile, 'utf8').trim(), 'tasks')
  assert.match(r.reply, /已切到 `tasks`/)
  assert.match(r.reply, /下一句提问就生效/)
})

test('切 both：回执要提示"顺手把调试也开上"，否则对比看不到东西', () => {
  const f = tmp()
  const r = handleL3Command('both', f)
  assert.equal(r.mode, 'both')
  assert.match(r.reply, /\/l3 debug on/)
  assert.match(MODE_DESC.both, /两条/)
})

test('切 off：说清这是因果验证用的', () => {
  const f = tmp()
  const r = handleL3Command('off', f)
  assert.equal(r.mode, 'off')
  assert.match(r.reply, /不再带 L3/)
})

test('debug on/off：建文件、删文件，回执跟着变', () => {
  const f = tmp()
  const on = handleL3Command('debug on', f)
  assert.equal(on.debug, true)
  assert.ok(fs.existsSync(f.debugFile))
  assert.match(on.reply, /调试已开/)
  assert.match(on.reply, /脑图/)

  const again = handleL3Command('debug on', f)
  assert.equal(again.debug, true, '开两次是幂等的')

  const off = handleL3Command('debug off', f)
  assert.equal(off.debug, false)
  assert.equal(fs.existsSync(f.debugFile), false)
  assert.match(off.reply, /调试已关/)
})

test('写错参数：认不出就明说，并把当前状态和用法再念一遍', () => {
  const f = tmp()
  fs.writeFileSync(f.modeFile, 'full')
  const r = handleL3Command('task', f)
  assert.equal(r.mode, 'full')
  assert.equal(r.changed, false)
  assert.match(r.reply, /认不出 `task`/)
  assert.match(r.reply, /当前：模式 `full`/)
  assert.equal(fs.readFileSync(f.modeFile, 'utf8').trim(), 'full', '认不出时绝不能改文件')
  assert.match(handleL3Command('debug', f).reply, /用法：\/l3 debug on\|off/)
})

test('文件写不进去：回执必须说"没写成"，不能假装切成功', () => {
  const f = tmp()
  const blocker = path.join(f.dir, 'not-a-dir')
  fs.writeFileSync(blocker, 'x')                       // 拿一个**文件**当目录用
  const r = handleL3Command('tasks', { modeFile: path.join(blocker, 'sub', 'l3-mode'), debugFile: f.debugFile })
  assert.equal(r.changed, false)
  assert.match(r.reply, /没写成/)
  assert.equal(r.mode, 'full', '没写成就不许在回执里说当前是 tasks')
})

test('模式文件里是空/垃圾时，按 full 报（与 readL3Mode 的兜底一致）', () => {
  const f = tmp()
  fs.writeFileSync(f.modeFile, '\n\n')
  assert.match(handleL3Command('', f).reply, /当前：模式 `full`/)
  fs.writeFileSync(f.modeFile, '瞎写的')
  assert.match(handleL3Command('', f).reply, /当前：模式 `瞎写的`/, '文件里是什么就报什么——报假话比不报更糟')
})
