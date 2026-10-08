#!/usr/bin/env node
/**
 * 升级脚本（installer/launcher/update.ps1）的回归测试 —— 2026-11
 *
 * 为什么要它：这个脚本干的活是**删文件**，而它删的正是程序自己那几格。删错一格
 * （比如把 data\ 也当成程序文件）就是用户几年的阅读记录没了 —— 这类错误不能靠人眼
 * 复查，得让机器每次打包前跑一遍。
 *
 * 造的场景是"覆盖升级了好几个版本的老目录"，把已知的三种残留都塞进去：
 *   · builtin\knowledge-graph-results.json —— 新版本不再分发、**但代码还在读**它
 *     （agent/index.js 的回退图）。这正是"文件消失了却还在起作用"的活样本。
 *   · internal\run-hidden.vbs —— 0.3.1 时代隐藏启动用的，现在没人调它。
 *   · 01-START-CoRead.bat / unblock.bat —— 老入口与老排障脚本，留在根目录会让用户
 *     不知道该点哪个。
 * 同时放进"用户自己的东西"（data\、logs\、根目录一份笔记），断言它们**一个字节没动**。
 *
 * 跑法：node --test agent/test/update-script.test.js
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
const UPDATE_PS1 = path.join(ROOT, 'installer', 'launcher', 'update.ps1')

const w = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const ps = (args) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
  { encoding: 'utf8', timeout: 180000 })

/** 造一个"装过好几个版本、攒了一堆残留"的老目录 */
function makeOldInstall(dir) {
  w(path.join(dir, 'internal', 'tray.ps1'), '# old tray')
  w(path.join(dir, 'internal', 'stop.bat'), '@echo off\r\nrem old stop\r\n')
  w(path.join(dir, 'internal', 'node.exe'), 'FAKE-NODE-OLD')
  w(path.join(dir, 'internal', 'agent', 'index.js'), '// old agent')
  w(path.join(dir, 'internal', 'receiver', 'index.js'), '// old receiver')
  w(path.join(dir, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'CoRead — AI 共读', version: '1.0.0', description: '微信读书划线共读、框选与划词翻译' }))
  w(path.join(dir, 'extension', 'sidebar.js'), '// old sidebar')
  w(path.join(dir, 'assets', 'icons', 'coread.ico'), 'old-ico')
  w(path.join(dir, 'Start-CoRead.vbs'), "' old entry")
  w(path.join(dir, 'README-FIRST.txt'), 'old readme')
  // ── 残留一号：不再分发、但代码还在读的回退图谱 ──
  w(path.join(dir, 'builtin', 'knowledge-graph-results.json'), '{"graph":{"nodes":[{"id":"ghost"}],"edges":[]}}')
  // ── 残留二号：老时代的隐藏启动脚本 ──
  w(path.join(dir, 'internal', 'run-hidden.vbs'), "' old hidden launcher")
  // ── 残留三号：老入口与老排障脚本 ──
  w(path.join(dir, '01-START-CoRead.bat'), '@echo off\r\nrem old entry\r\n')
  w(path.join(dir, 'unblock.bat'), '@echo off\r\nrem removed long ago\r\n')
  // ── 用户自己的东西：一个字节都不许动 ──
  w(path.join(dir, 'data', 'sessions', 'chat.db'), 'USER-CHAT-DB-BYTES')
  w(path.join(dir, 'data', 'config', 'api-config.json'), '{"apiKey":"sk-user-secret"}')
  w(path.join(dir, 'data', 'profile', 'self-portrait.md'), '# 用户的画像')
  w(path.join(dir, 'logs', 'tray.log'), 'user log line\n')
  w(path.join(dir, '我的笔记.txt'), '放在程序目录里的私人笔记')
}

/** 造一个"新版本便携包"的 zip */
function makeNewZip(srcDir, zipPath) {
  w(path.join(srcDir, 'internal', 'tray.ps1'), '# new tray')
  w(path.join(srcDir, 'internal', 'stop.bat'), '@echo off\r\nrem new stop\r\n')
  w(path.join(srcDir, 'internal', 'update.ps1'), '# new update script')
  w(path.join(srcDir, 'internal', 'node.exe'), 'FAKE-NODE-NEW')
  w(path.join(srcDir, 'internal', 'agent', 'index.js'), '// new agent')
  w(path.join(srcDir, 'internal', 'receiver', 'index.js'), '// new receiver')
  w(path.join(srcDir, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'CoRead — AI 共读', version: '1.0.1', description: '微信读书划线共读、框选与划词翻译' }))
  w(path.join(srcDir, 'extension', 'sidebar.js'), '// new sidebar')
  w(path.join(srcDir, 'assets', 'icons', 'coread.ico'), 'new-ico')
  w(path.join(srcDir, 'Start-CoRead.vbs'), "' new entry")
  w(path.join(srcDir, 'README-FIRST.txt'), 'new readme')
  w(path.join(srcDir, 'Update-CoRead.cmd'), '@echo off\r\nrem updater\r\n')
  w(path.join(srcDir, 'data', 'README.txt'), '你的数据放在这里')
  fs.mkdirSync(path.join(srcDir, 'builtin'), { recursive: true })   // 新版是空目录
  const r = ps(['-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${srcDir}', '${zipPath}')`])
  assert.equal(r.status, 0, '造测试 zip 失败：' + (r.stderr || r.stdout))
}

test('升级脚本：清掉旧版本残留、不碰用户数据、落成新版本', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-update-test-'))
  const install = path.join(work, 'CoRead-old')
  const src = path.join(work, 'newpkg')
  const zip = path.join(work, 'CoRead-1.0.1-portable.zip')
  try {
    makeOldInstall(install)
    makeNewZip(src, zip)

    const r = ps(['-File', UPDATE_PS1, '-Root', install, '-Zip', zip])
    const out = (r.stdout || '') + (r.stderr || '')
    assert.equal(r.status, 0, '升级脚本应当成功退出，实际输出：\n' + out)
    assert.match(out, /已更新：1\.0\.0 → 1\.0\.1/, '应报告版本变化')

    // ① 残留必须被清掉
    assert.equal(fs.existsSync(path.join(install, 'builtin', 'knowledge-graph-results.json')), false,
      'builtin\\ 里的旧回退图谱必须清掉（它虽然不再分发，代码却还在读它）')
    assert.equal(fs.existsSync(path.join(install, 'internal', 'run-hidden.vbs')), false, '老隐藏启动脚本必须清掉')
    assert.equal(fs.existsSync(path.join(install, '01-START-CoRead.bat')), false, '老入口必须清掉')
    assert.equal(fs.existsSync(path.join(install, 'unblock.bat')), false, '老排障脚本必须清掉')

    // ② 新版本的文件必须到位（含升级通道本身）
    assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'extension', 'manifest.json'), 'utf8')).version, '1.0.1',
      '版本号应变成新包的')
    assert.equal(fs.readFileSync(path.join(install, 'internal', 'tray.ps1'), 'utf8'), '# new tray', '托盘脚本应是新的')
    assert.equal(fs.readFileSync(path.join(install, 'internal', 'node.exe'), 'utf8'), 'FAKE-NODE-NEW', 'node.exe 应是新的')
    assert.ok(fs.existsSync(path.join(install, 'internal', 'update.ps1')), '更新脚本自己也要跟着更新')
    assert.ok(fs.existsSync(path.join(install, 'Update-CoRead.cmd')), '下次升级的入口要到位')

    // ③ 用户数据一个字节都不许动
    assert.equal(fs.readFileSync(path.join(install, 'data', 'sessions', 'chat.db'), 'utf8'), 'USER-CHAT-DB-BYTES',
      '聊天库必须原样')
    assert.equal(fs.readFileSync(path.join(install, 'data', 'config', 'api-config.json'), 'utf8'), '{"apiKey":"sk-user-secret"}',
      'API 配置（含密钥）必须原样')
    assert.equal(fs.readFileSync(path.join(install, 'data', 'profile', 'self-portrait.md'), 'utf8'), '# 用户的画像',
      '画像必须原样')
    assert.equal(fs.readFileSync(path.join(install, 'logs', 'tray.log'), 'utf8'), 'user log line\n',
      '日志必须原样（只追加我们自己的 update.log）')
    assert.equal(fs.readFileSync(path.join(install, '我的笔记.txt'), 'utf8'), '放在程序目录里的私人笔记',
      '根目录里用户自己的文件不许删')

    // ④ 留痕：升级日志要写上（出问题时有据可查）
    const log = fs.readFileSync(path.join(install, 'logs', 'update.log'), 'utf8')
    assert.match(log, /update 1\.0\.0 -> 1\.0\.1/, '升级日志应记下版本变化')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('升级脚本：递进来一个不是 CoRead 包的 zip —— 拒绝，且一个文件都不删', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-update-bad-'))
  const install = path.join(work, 'CoRead')
  const junkSrc = path.join(work, 'junk')
  const zip = path.join(work, 'random.zip')
  try {
    makeOldInstall(install)
    w(path.join(junkSrc, 'hello.txt'), 'not coread')
    const mk = ps(['-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::CreateFromDirectory('${junkSrc}', '${zip}')`])
    assert.equal(mk.status, 0, '造垃圾 zip 失败')

    const r = ps(['-File', UPDATE_PS1, '-Root', install, '-Zip', zip])
    const out = (r.stdout || '') + (r.stderr || '')
    assert.notEqual(r.status, 0, '不是 CoRead 包时必须失败退出')
    assert.match(out, /不像是 CoRead 便携包/, '要说清拒绝的原因')
    // 关键：拒绝发生在"动手之前"，老目录必须还是完整的
    assert.ok(fs.existsSync(path.join(install, 'internal', 'tray.ps1')), '老程序文件不能被删')
    assert.equal(fs.readFileSync(path.join(install, 'data', 'sessions', 'chat.db'), 'utf8'), 'USER-CHAT-DB-BYTES', '数据不能被删')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
