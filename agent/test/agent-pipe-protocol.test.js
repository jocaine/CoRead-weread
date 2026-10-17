#!/usr/bin/env node
/**
 * agent ↔ 托盘 的"身份应答"跨语言契约测试（2026-11）
 *
 * 背景：agent 用一个全机唯一的命名管道做单实例锁；2026-11 起这把锁**兼职应答** ——
 * 托盘拨一次号，agent 回一行 JSON，于是"引擎到底在不在跑、是不是我们这一份"从猜测变成事实。
 * 这条链路跨两种语言（node 写 / PowerShell 读），两边任何一边改了字段名、分隔符、大小写规则，
 * 都不会报错，只会**静默退化**成"占着号但不答话"（托盘退回旧行为、状态又说不清）。
 * 所以这里做端到端验证，而不是各自测各自的：
 *
 *   · 服务端用**真代码**：agent/lib/agent-identity.js 的 serveHello()
 *   · 客户端用**真代码**：installer/launcher/tray.ps1 里抠出来的 Get-AgentState /
 *     Get-AgentPipeInfo（抠出来跑，不抄一份，免得测试与实现漂移）
 *
 * 覆盖五档：号不存在 → none；回话且 root 就是本包根 → mine（含大小写/尾斜杠不同）；
 * 回话但 root 是别的文件夹 → other；号在但对方不答话（旧版本 agent 的行为）→ silent。
 *
 * 跑法：node --test agent/test/agent-pipe-protocol.test.js
 *   COREAD_TRAY_PS1  指向另一份 tray.ps1（一般不用改）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveHello, agentHelloLine, normalizeRoot, AGENT_ROLE, AGENT_HELLO_VERSION } from '../lib/agent-identity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const TRAY_PS1 = process.env.COREAD_TRAY_PS1 || path.join(ROOT, 'installer', 'launcher', 'tray.ps1')

/** 从 tray.ps1 里原样抠出"身份探测"那一段（变量声明 + 四个函数）*/
function extractProbeBlock() {
  const src = fs.readFileSync(TRAY_PS1, 'utf8')
  const from = src.indexOf('$script:agentPipeName = ')
  const to = src.indexOf('function Test-ChildAlive(')
  assert.ok(from > 0 && to > from,
    `在 ${TRAY_PS1} 里找不到身份探测那一段（$script:agentPipeName … Test-ChildAlive），测试要跟着改`)
  return src.slice(from, to)
}

const MY_ROOT = 'C:\\CoRead-Test 目录'          // 本包根（假路径，只用来比对字符串）
const OTHER_ROOT = 'D:\\CoRead-0.3.1'           // "另一份安装"的包根

let caseNo = 0

/**
 * 让真·托盘函数去拨一次号，返回它给出的状态。
 * bind: null = 不绑任何号；否则 (sock) => ... 的连接处理函数（用真 serveHello 或直接 destroy）
 */
async function probeWithTray(bind, pipeShortName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-pipe-'))
  const outFile = path.join(tmp, 'result.json')
  const shimPath = path.join(tmp, 'shim.ps1')

  // 桩 + 真代码。注意顺序：抠出来的那一段自己会设 agentPipeName='CoReadAgent' 与
  // myRootKey=$PackageRoot，所以我们的覆盖必须写在它**后面**。
  const shim = [
    '$PackageRoot = $env:PROBE_ROOT',
    '$script:children = @{ agent = $null; receiver = $null }',
    'function Get-CoreadProcesses { return @() }   # 桩：整机扫描说"没有"（本用例只关心管道判据）',
    extractProbeBlock(),
    '$script:agentPipeName = $env:PROBE_PIPE',
    '$script:myRootKey = $env:PROBE_ROOT',
    '$script:agentOtherRoot = ""',
    '$script:agentProbe = @{ at = [datetime]::MinValue; state = "" }',
    '$r = @{ state = (Get-AgentState); other = $script:agentOtherRoot }',
    '[IO.File]::WriteAllText($env:PROBE_OUT, ($r | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))',
  ].join('\n')
  // ⚠️ 必须带 UTF-8 BOM：抠出来的代码里有中文（注释与状态字符串），而 PowerShell 5.1 把无 BOM
  //    的 UTF-8 当系统 ANSI（GBK）读 —— 见 AGENTS.md 第 1、3 条（本项目实测被吞过整行代码）。
  fs.writeFileSync(shimPath, '\uFEFF' + shim, 'utf8')

  let srv = null
  if (bind) {
    srv = net.createServer(bind)
    await new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen('\\\\.\\pipe\\' + pipeShortName, resolve)
    })
  }

  try {
    const code = await new Promise((resolve) => {
      // ⚠️ 用异步 spawn 而不是 spawnSync：spawnSync 会把 node 的事件循环**堵住**，
      //    上面那个 in-process 的管道服务就来不及回话（客户端会读超时）。
      //    stdio:'ignore' 而不是管道：受限环境下管道会 EPERM，这里也不需要它的输出。
      const p = spawn('powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shimPath],
        {
          stdio: 'ignore',
          env: {
            ...process.env,
            PROBE_ROOT: MY_ROOT,
            PROBE_PIPE: pipeShortName,
            PROBE_OUT: outFile,
          },
        })
      p.on('exit', (c) => resolve(c))
      p.on('error', () => resolve(-1))
    })
    assert.ok(fs.existsSync(outFile), `托盘那一段没写出结果（powershell 退出码 ${code}）`)
    return JSON.parse(fs.readFileSync(outFile, 'utf8'))
  } finally {
    if (srv) await new Promise((resolve) => srv.close(resolve))
  }
}

const nextPipeName = () => `CoReadTest-${process.pid}-${++caseNo}`

test('协议本身：一行 JSON，正好是托盘的四个字段', () => {
  const line = agentHelloLine('C:\\CoRead\\', 4321)
  assert.match(line, /\n$/, '必须以换行结尾 —— 托盘是按行读的')
  assert.deepEqual(JSON.parse(line), {
    role: AGENT_ROLE, v: AGENT_HELLO_VERSION, pid: 4321, root: 'C:\\CoRead',
  })
  assert.equal(normalizeRoot('D:\\a\\'), 'D:\\a', '结尾分隔符要去掉（两边都要，否则比不相等）')
})

test('号不存在 → none（真托盘函数 × 真 agent 协议）', async () => {
  const r = await probeWithTray(null, nextPipeName())
  assert.equal(r.state, 'none', '没有号就该判"真没有 agent"，看门狗才该去拉一个')
})

test('回话的 root 就是本包根 → mine', async () => {
  const r = await probeWithTray((sock) => serveHello(sock, MY_ROOT), nextPipeName())
  assert.equal(r.state, 'mine')
})

test('root 大小写与结尾斜杠不同 → 仍判 mine（Windows 路径规则）', async () => {
  const r = await probeWithTray((sock) => serveHello(sock, MY_ROOT.toUpperCase() + '\\'), nextPipeName())
  assert.equal(r.state, 'mine', '大小写/尾斜杠不算"另一份"，否则每次开机都会误报被占用')
})

test('回话的 root 是另一份安装 → other，并把路径带回来', async () => {
  const r = await probeWithTray((sock) => serveHello(sock, OTHER_ROOT), nextPipeName())
  assert.equal(r.state, 'other')
  assert.equal(r.other, OTHER_ROOT, '要把"是哪一份"记下来，菜单才能点名')
})

test('号在但对方一个字不说（旧版本 agent 的行为）→ silent，而不是 none', async () => {
  // 旧版 agent 的连接回调是 (sock) => sock.destroy()：接起来就挂断
  const r = await probeWithTray((sock) => sock.destroy(), nextPipeName())
  assert.equal(r.state, 'silent',
    '这一档绝不能判成 none —— 那会让看门狗去拉一个必然撞锁退出的进程')
})

// ── 接线检查：状态名是"字符串"在三个地方流转，改一处漏一处不会报错，只会静默说不清 ──
test('接线：新状态在 Get-Status 与菜单文案里都接上了', () => {
  const src = fs.readFileSync(TRAY_PS1, 'utf8')
  for (const st of ['agent-other', 'agent-silent']) {
    const hits = (src.match(new RegExp(`'${st}'`, 'g')) || []).length
    assert.ok(hits >= 2,
      `${st} 只出现 ${hits} 次：Get-Status 要返回它、菜单 switch 要有它的分支（改名时最容易漏一处）`)
  }
  assert.match(src, /Get-AgentState/, 'Get-Status 必须走管道判据')
  assert.match(src, /Test-AgentRunning/, '看门狗必须用管道判据，否则会去拉一个必然撞锁的进程')
})

test('接线：agent 真的把包根交给了应答函数，并用上了共用管道名', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent', 'index.js'), 'utf8')
  assert.match(src, /serveHello\(sock,\s*PACKAGE_ROOT\)/,
    'index.js 必须把 PACKAGE_ROOT 交给 serveHello —— 交错了（比如交了 AGENT_DIR）会让托盘永远认不出"我们这一份"')
  assert.match(src, /AGENT_PIPE_NAME/, '管道名必须来自 lib/agent-identity.js，别在 index.js 里再写一份字面量')
  assert.match(src, /\bPACKAGE_ROOT\b[\s\S]{0,400}from '\.\/lib\/paths\.js'|PACKAGE_ROOT,/,
    'PACKAGE_ROOT 要从 lib/paths.js 取（路径唯一真源）')
})
