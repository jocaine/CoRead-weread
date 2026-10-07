#!/usr/bin/env node
/**
 * 扩展 ID 的校验与「阅读器地址」拼装测试（2026-10）
 *
 * 背景：托盘右键的「打开 CoRead 阅读器」要打开 chrome-extension://<扩展ID>/reader.html，
 * 而这个 ID 是插件启动时报给接收端、由接收端落到 data\runtime\extension-id 的。
 * 于是**一个盘上的文本文件决定了托盘将要打开的地址** —— 它是这条链上唯一不可信的一环。
 * 这里测的就是那一环的守门逻辑（paths.js 的 isExtensionId / extensionReaderUrl）：
 *
 *   ① 形状必须严：Chrome 的扩展 ID 恰好 32 个字符、只用 a~p 十六个字母
 *      （公钥哈希的十六进制，再把 0-9a-f 映射到 a-p）。松一格，就等于允许
 *      `.` `/` `\` 这类字符进入 URL。
 *   ② 必须**大小写敏感**：PowerShell 的 -notmatch 默认忽略大小写，托盘那边一度
 *      因此放行了全大写的乱码（实测漏过）；接收端是 JS，天生大小写敏感。
 *      两处判定必须一致，这条测试就是钉住 JS 这一侧的口径。
 *   ③ 不合法一律返回空串，**绝不抛异常**：调用方（托盘、receiver）都按"空串 = 办不到"处理，
 *      在这里抛错会把一次普通的"还没登记"变成崩溃。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isExtensionId, extensionReaderUrl, EXTENSION_ID_FILE, RUNTIME_DIR } from '../lib/paths.js'

const OK = 'abcdefghijklmnopabcdefghijklmnop'   // 32 位、全在 a~p 内

test('合法扩展 ID：32 位 a~p', () => {
  assert.equal(isExtensionId(OK), true)
  assert.equal(extensionReaderUrl(OK), `chrome-extension://${OK}/reader.html`)
  // 边界：a 与 p 两端都要收
  assert.equal(isExtensionId('a'.repeat(32)), true)
  assert.equal(isExtensionId('p'.repeat(32)), true)
})

test('长度不对一律拒绝', () => {
  assert.equal(isExtensionId(OK.slice(0, 31)), false, '少一位')
  assert.equal(isExtensionId(OK + 'a'), false, '多一位')
  assert.equal(isExtensionId(''), false)
})

test('落在 a~p 之外的字符一律拒绝（q~z、0~9、符号都算）', () => {
  for (const bad of ['q', 'z', '0', '9', 'A', '-', '_', '.', '/', '\\', ' ']) {
    const id = bad + 'a'.repeat(31)
    assert.equal(isExtensionId(id), false, `「${bad}」不该被接受`)
    assert.equal(extensionReaderUrl(id), '', `「${bad}」不该拼出地址`)
  }
})

test('大小写敏感：全大写的 ID 被拒绝（与托盘 -cnotmatch 的口径一致）', () => {
  assert.equal(isExtensionId(OK.toUpperCase()), false)
  assert.equal(extensionReaderUrl(OK.toUpperCase()), '')
})

test('路径穿越形态的输入不会被拼进地址', () => {
  for (const evil of ['../../../../etc/passwd', '..\\..\\..\\windows\\x', 'reader.html/../../x', `${'a'.repeat(32)}/../x`]) {
    assert.equal(extensionReaderUrl(evil), '', `「${evil}」不该拼出地址`)
  }
})

test('非字符串输入不抛异常（空串/数字/null/对象都当"没有"）', () => {
  for (const v of [undefined, null, 0, 123, {}, [], true]) {
    assert.equal(isExtensionId(v), false)
    assert.equal(extensionReaderUrl(v), '')
  }
})

test('落点在 data\\runtime\\ 下，文件名就是 extension-id', () => {
  // 这条路径被三个地方共用（paths.js 定义、receiver 写、tray.ps1 读），改一处就要改三处。
  // 这里钉住"它属于 runtime 那一格"——runtime\ 的定位是"删了无害、自动重建"。
  assert.equal(EXTENSION_ID_FILE, path.join(RUNTIME_DIR, 'extension-id'))
})
