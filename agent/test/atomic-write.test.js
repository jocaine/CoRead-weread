/**
 * 原子写单测（lib/atomic-write.js）—— 内置 node:test。
 *
 * 驱动背景：chat_input.jsonl 有多个"整文件重写"的写入方（删书 /book-delete、自由对话删除、
 * selftest 收尾），而 agent 每 300ms 读同一个文件。`fs.writeFileSync` 先截断到 0 字节再写，
 * 读到那个空窗的轮询会把游标钳成 0 → 全量重放（2026-09-28）。本测试钉住两点：
 *   ① 内容正确替换（含覆盖已有文件）；
 *   ② **边写边读的读者永远读不到空文件/半截内容**——这正是修复要保证的性质。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { writeFileAtomic } from '../lib/atomic-write.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coread-atomic-'))

test('替换写入：新建 + 覆盖已有内容', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'chat_input.jsonl')
  assert.equal(writeFileAtomic(file, 'a\nb\n'), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n')
  assert.equal(writeFileAtomic(file, 'c\n'), true, '覆盖已存在的文件（Windows 上 rename 替换）')
  assert.equal(fs.readFileSync(file, 'utf8'), 'c\n')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('空内容也能写（清空队列是合法操作）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'x.jsonl')
  writeFileAtomic(file, 'old\n')
  assert.equal(writeFileAtomic(file, ''), true)
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('不留临时文件；写失败不抛错（存档写入不该拖垮调用方）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'y.jsonl')
  writeFileAtomic(file, 'hello\n')
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], `不应残留临时文件：${leftovers}`)
  // 目标是目录 → 写临时文件或 rename 都会失败：返回 false 而不是抛错
  const dirAsTarget = path.join(dir, 'adir')
  fs.mkdirSync(dirAsTarget)
  assert.equal(writeFileAtomic(dirAsTarget, 'x'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子性：另一个进程高频重写时，读者永远看不到空文件或半截内容（2026-09-28 空窗回归）', async (t) => {
  const dir = tmpDir()
  const file = path.join(dir, 'chat_input.jsonl')
  const log = path.join(dir, 'reader.log')
  const stop = path.join(dir, 'stop')
  const childFile = path.join(dir, 'reader.cjs')
  const line = JSON.stringify({ role: 'user', content: '提问', timestamp: 1, bookId: 'b' }) + '\n'
  const body = line.repeat(200)
  writeFileAtomic(file, body)

  // 读者必须是**另一个进程**：同进程里同步写会独占事件循环，测不出真实的并发空窗
  // （生产里的读取方就是另一个进程：agent 每 300ms readFileSync 同一个文件）。
  fs.writeFileSync(childFile, `
const fs = require('fs')
const [target, logFile, stopFile, expectLen] = process.argv.slice(2)
let reads = 0
const end = Date.now() + 2500
while (Date.now() < end && reads < 300000 && !fs.existsSync(stopFile)) {
  reads++
  let raw
  try { raw = fs.readFileSync(target, 'utf8') } catch (e) { fs.appendFileSync(logFile, 'ERR ' + e.code + '\\n'); continue }
  if (raw.length !== Number(expectLen)) fs.appendFileSync(logFile, 'BAD len=' + raw.length + '\\n')
}
fs.appendFileSync(logFile, 'done reads=' + reads + '\\n')
`)
  const child = spawn(process.execPath, [childFile, file, log, stop, String(body.length)], { stdio: 'ignore' })
  let spawned = false
  try {
    await new Promise((resolve) => setTimeout(resolve, 60))
    spawned = true
  } catch {}

  for (let i = 0; i < 120; i++) {
    writeFileAtomic(file, body)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  fs.writeFileSync(stop, '')
  const exited = await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
  ])
  if (!exited) { try { child.kill() } catch {} }
  if (!spawned && !fs.existsSync(log)) {
    t.diagnostic('无法在本环境 spawn 子进程，跳过跨进程断言')
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }

  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  const bad = text.split('\n').filter((l) => l.startsWith('BAD') || l.startsWith('ERR'))
  const reads = Number((text.match(/done reads=(\d+)/) || [])[1] || 0)
  assert.deepEqual(bad, [], `读者读到了空文件/半截内容：${bad.slice(0, 3).join(' | ')}`)
  assert.ok(reads > 0, `读者应当至少成功读过几次（实际 ${reads}）`)
  assert.equal(fs.readFileSync(file, 'utf8'), body)
  fs.rmSync(dir, { recursive: true, force: true })
})
