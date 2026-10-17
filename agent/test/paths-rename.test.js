/**
 * 数据文件改名迁移（migrateRenamedFiles）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/paths-rename.test.js
 *
 * 为什么值得单独测：这个函数动的是**用户数据**——一旦写错（比如在新文件已存在时
 * 仍然覆盖），用户的相处规则会被静默冲掉。所以四种边界逐一钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { migrateRenamedFiles } from '../lib/paths.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coread-rename-'))

test('旧名存在、新名不存在 → 搬过去，内容一字不动', () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'values-portrait.md'), '1. 直接给判断\n')
  const r = migrateRenamedFiles(d)
  assert.equal(r.done.length, 1)
  assert.deepEqual(r.failed, [])
  assert.equal(fs.existsSync(path.join(d, 'values-portrait.md')), false, '旧名应已不在')
  assert.equal(fs.readFileSync(path.join(d, 'agreement.md'), 'utf8'), '1. 直接给判断\n')
})

test('新名已存在 → 一个字都不动（绝不覆盖用户已写的新文件）', () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'values-portrait.md'), '旧的内容\n')
  fs.writeFileSync(path.join(d, 'agreement.md'), '新的内容\n')
  const r = migrateRenamedFiles(d)
  assert.deepEqual(r.done, [])
  assert.equal(fs.readFileSync(path.join(d, 'agreement.md'), 'utf8'), '新的内容\n')
  assert.equal(fs.readFileSync(path.join(d, 'values-portrait.md'), 'utf8'), '旧的内容\n', '旧文件也不删（留给用户自己清）')
})

test('两个都不存在 → 什么都不做（全新用户）', () => {
  const r = migrateRenamedFiles(tmpDir())
  assert.deepEqual(r.done, [])
  assert.deepEqual(r.failed, [])
})

test('幂等：连跑两次，第二次无动作', () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'values-portrait.md'), '内容\n')
  migrateRenamedFiles(d)
  const r2 = migrateRenamedFiles(d)
  assert.deepEqual(r2.done, [])
  assert.equal(fs.readFileSync(path.join(d, 'agreement.md'), 'utf8'), '内容\n')
})

test('目录不存在 → 跳过且不抛错（不能让启动挂在这）', () => {
  const d = path.join(os.tmpdir(), 'coread-rename-missing-' + Date.now())
  const r = migrateRenamedFiles(d)
  assert.deepEqual(r.done, [])
  assert.deepEqual(r.failed, [])
})
