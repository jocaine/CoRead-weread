#!/usr/bin/env node
/**
 * 托盘拉起子进程（installer/launcher/tray.ps1 的 Start-Child）—— 回归测试（2026-11）
 *
 * 为什么有这条测试：这个函数踩过一个**完全静默**的坑 ——
 *     Start-Process -FilePath $Node -ArgumentList @($script)
 * PowerShell 5.1 的 -ArgumentList 只是把数组用空格拼成**一整行**交出去，它**不会**替参数
 * 加引号。而 Windows 给程序传参数就是这一行文字，程序只能自己按**半角空格**把它切开。
 * 于是包根路径里只要有半角空格（D:\CoRead 1.0.1\、C:\Users\Zhang San\... 这种），node 收到
 * 的就是被切断的路径：它把第一个词当成"要运行的脚本" → 找不到 → 打印
 * "Error: Cannot find module 'D:\CoRead'" 后立刻退出。接收端与 agent 是同一行代码、同一个
 * 拼法，所以**两个一起死** —— 托盘状态显示"已停止"，而托盘日志（tray.log / agent.log：
 * 有"启动:"、有 PID）看不出任何异常，真相只在子进程的 stderr 里。2026-11 一个用户报的
 * "启动后托盘里显示未运行"就是这个，排查信息为零。
 *
 * 这条守卫不检查"源码里有没有引号"（换个写法就绕过了），而是把 tray.ps1 里**真正的
 * Start-Child 原样抠出来跑一遍**：造一个名字带半角空格的包根，让它去起一个只干一件事的
 * 子进程 —— 在自己旁边写个标记文件。
 *   标记文件出现  = node 真的跑到了那个脚本 → 绿
 *   路径被切断    = node 立刻退出，标记文件永不出现 → 红
 *
 * 跑法：node --test agent/test/tray-start-child.test.js
 *   COREAD_TRAY_PS1  指向另一份 tray.ps1（用它验证这条守卫确实抓得住那个 bug：
 *                    把副本里的引号去掉，测试必须变红）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const TRAY_PS1 = process.env.COREAD_TRAY_PS1 || path.join(ROOT, 'installer', 'launcher', 'tray.ps1')

/** 从 tray.ps1 里**原样**抠出 Start-Child（守卫必须盯着真代码，不能抄一份进来）*/
function extractStartChild() {
  const src = fs.readFileSync(TRAY_PS1, 'utf8')
  const from = src.indexOf('function Start-Child(')
  const to = src.indexOf('function Get-PortOwner(')
  assert.ok(from > 0 && to > from,
    `在 ${TRAY_PS1} 里找不到 Start-Child / Get-PortOwner 这两段，测试要跟着改`)
  return src.slice(from, to)
}

test('Start-Child：包根路径带半角空格时，子进程也必须真的跑起来', () => {
  // 临时目录里再造一层带**半角空格**的"包根" —— 就是当年那台用户机器的形状
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-tray-'))
  const pkgRoot = path.join(tmp, 'CoRead 1.0.1 portable')
  const logsDir = path.join(pkgRoot, 'logs')
  const agentDir = path.join(pkgRoot, 'agent')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })

  // 子进程脚本只做一件事：在自己旁边写个标记文件（用 .cjs，免得受 package.json 的 type 影响）
  fs.writeFileSync(path.join(agentDir, 'probe.cjs'),
    "require('fs').writeFileSync(require('path').join(__dirname, 'ran.txt'), 'ok')\n")

  // 桩：Start-Child 依赖的四个外部名字 + 它自己的函数体
  const shim = [
    '$PackageRoot = $env:PROBE_ROOT',
    "$LogDir = Join-Path $PackageRoot 'logs'",
    '$Node = $env:PROBE_NODE',
    '$script:children = @{ agent = $null; receiver = $null }',
    'function Write-Log($name, $msg) { Add-Content -Path (Join-Path $LogDir "$name.log") -Value $msg }',
    extractStartChild(),
    "Start-Child 'agent' 'agent\\probe.cjs' | Out-Null",
    "$marker = Join-Path $PackageRoot 'agent\\ran.txt'",
    '$deadline = (Get-Date).AddSeconds(20)',
    'while (-not (Test-Path $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }',
  ].join('\n')

  const shimPath = path.join(tmp, 'shim.ps1')
  // ⚠️ 必须带 UTF-8 BOM：抠出来的函数体里有中文（注释与日志文案），而 PowerShell 5.1 把
  //    无 BOM 的 UTF-8 当系统 ANSI（中文 Windows 是 GBK）解析 —— 见 AGENTS.md 第 1 条。
  fs.writeFileSync(shimPath, '\uFEFF' + shim, 'utf8')

  const r = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shimPath],
    {
      stdio: 'ignore',            // 不走管道：受限环境下管道会 EPERM，这里也不需要它的输出
      timeout: 120000,
      env: { ...process.env, PROBE_ROOT: pkgRoot, PROBE_NODE: process.execPath },
    })

  const errLog = path.join(logsDir, 'agent.err.log')
  const childErr = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').trim() : '(没有 err 日志)'
  const marker = path.join(agentDir, 'ran.txt')

  assert.ok(fs.existsSync(marker),
    '子进程没有跑起来 —— 包根路径里的半角空格把参数切断了（Start-Child 的 -ArgumentList 少了引号）。\n' +
    `包根：${pkgRoot}\nnode 的 stderr：\n${childErr}\n（powershell 退出码 ${r.status}）`)

  assert.doesNotMatch(childErr, /Cannot find module/,
    'node 报"找不到模块"= 脚本路径被半角空格切成两截，说明 Start-Child 又漏了引号。\n' +
    `node 的 stderr：\n${childErr}`)
})
