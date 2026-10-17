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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionStopFile, listSessionStopFiles, RUNTIME_DIR } from '../lib/paths.js'
import { isFreeKey } from '../lib/free-conversation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RECEIVER_SRC = path.join(__dirname, '..', '..', 'receiver', 'index.js')

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

/**
 * receiver 那头的形态闸（2026-11 修）：`POST /session-stop` 会先校验会话 key 形态，
 * 不过闸就直接 400 —— 不写信号文件、不推 message-stopped。
 *
 * 为什么必须有这条测试：那行原先只认 `_common` / `mia_` / 自由对话三种，**微信读书的书
 * ID（纯十六进制）与阅读器的 `rd_` 全被拒**。表现是"在微读书里点「停止」从来没生效过"：
 * 侧栏本地先把气泡删了、看着像停了，而 agent 那头还在生成（它从来没收到信号）。
 * 这种"看着成功、实际没做"的缺口不会报错，所以拿真实 key 形态钉住它。
 *
 * 实现方式：把 receiver 里那段判断里的**正则原样抠出来**跑（不是另抄一份正则），
 * 这样实现改了、测试跟着变；万一哪天这段被重构/挪走，下面的断言会失败——那是提醒同步本测试。
 */
test('receiver /session-stop 的会话 key 形态闸要认全四种真实写法', () => {
  const src = fs.readFileSync(RECEIVER_SRC, 'utf8')
  const at = src.indexOf("url === '/session-stop'")
  assert.ok(at > 0, '找不到 /session-stop 分支')
  const block = src.slice(at, at + 1800)
  const regexes = [...block.matchAll(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[a-z]*/g)].map((m) => m[0])
  assert.ok(regexes.length >= 2, '没抠到形态正则——实现可能被重构了，请同步本测试')
  const matches = (key) => regexes.some((r) => {
    const i = r.lastIndexOf('/')
    try { return new RegExp(r.slice(1, i), r.slice(i + 1)).test(key) } catch { return false }
  })
  const cases = [
    ['_common', '通用上下文'],
    ['480328505d095c4808beaf4', '微信读书的书 ID（纯十六进制）'],
    ['rd_e0c91cb6aa56dd0057235ba7374c03e599e1e37e09b3bc9f55f64e1a5b98a25e', 'CoRead 阅读器里的 PDF'],
    ['mia_4ddee185575e5a19ec11', 'marxists 网页阅读源'],
    ['__coread_free_abcd1234__', '自由对话（普通一场）'],
  ]
  for (const [key, why] of cases) {
    const okShape = key === '_common' || isFreeKey(key) || matches(key)
    assert.ok(okShape, `${why}（${key.slice(0, 24)}…）必须过形态闸：不过就是 400，停止信号写不下去，agent 收不到`)
  }
})
