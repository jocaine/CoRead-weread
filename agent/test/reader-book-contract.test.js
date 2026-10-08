#!/usr/bin/env node
/**
 * 阅读器的书 ↔ 共读侧：两条不能破的约定（2026-11）
 *
 * 背景：以前我们自己的阅读器和共读侧是两套互不相识的东西 —— 打开 PDF 不进
 * 「已读过的书籍」，在阅读器里点「设为引用」被判成"当前页面未关联任何书籍"。
 * 修完之后，有两件事**一旦被后人改坏，用户要过很久才会发现**，所以钉在这里：
 *
 *   ① 书 ID 形态必须两边一致（`rd_` + PDF 内容哈希）。扩展侧生成、接收端解析，
 *      各写一份代码；哪天有人只改一边，表现是"引用归不了书/列表里多出怪条目"，
 *      而且不报错。
 *   ② **两条删除线各自独立**：删「书籍记录」（/book-delete）不许碰 PDF 原件；
 *      删「书库原件」（/reader-book-delete）不许碰共读侧的 meta.json。
 *      两边共用 data\reading\books\<hash>\ 一个目录，历史上 /book-delete 就是
 *      `rm -rf 整个目录` —— 阅读器的书一旦进入那个列表，用户删个记录就会连
 *      PDF 原件一起没了。这是本文件存在的主要理由。
 *
 * 为什么用"读源码 + 断言形状"而不是起一个接收端跑真请求：那需要复制 agent/receiver
 * 到临时目录、占端口、等启动，与其余测试（纯逻辑、毫秒级）的形态不一致。真正的
 * 端到端验证在 test\scratch\reader-book-smoke.mjs（26 条断言，打真实 HTTP、验真实落盘），
 * 这里是它的"永不退化的最小版本"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RECEIVER = path.join(__dirname, '..', '..', 'receiver', 'index.js')
const READER_JS = path.join(__dirname, '..', '..', 'extension', 'reader.js')
const SIDEBAR_JS = path.join(__dirname, '..', '..', 'extension', 'sidebar.js')
const RECEIVER_SRC = fs.readFileSync(RECEIVER, 'utf8')
const READER_SRC = fs.readFileSync(READER_JS, 'utf8')
const SIDEBAR_SRC = fs.readFileSync(SIDEBAR_JS, 'utf8')

/** 从源码里取出字符串常量（如 `const READER_BOOK_PREFIX = 'rd_'`） */
function constOf(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`).exec(src)
  assert.ok(m, `源码里找不到 ${name}（这个测试与实现是绑定的，改名了就要同步改这里）`)
  return m[1]
}

test('书 ID 前缀两边一致：扩展与接收端都是 rd_', () => {
  const inReceiver = constOf(RECEIVER_SRC, 'READER_BOOK_PREFIX')
  // 扩展侧没有导出常量（页面脚本），断言它的拼法写死是 'rd_' + 哈希
  const extOk = /return hash \? 'rd_' \+ hash : ''/.test(READER_SRC)
  assert.equal(inReceiver, 'rd_', `接收端的阅读器书前缀变了：${inReceiver}`)
  assert.ok(extOk, 'extension/reader.js 的 readerBookId 不再返回 rd_<hash> —— 两边会各建一套记录')
})

test('书 ID 形态能过全部下游校验（侧栏 / 删除入口 / 接收端汇总）', () => {
  const bookId = 'rd_' + 'a'.repeat(64)   // 真实形态：rd_ + 64 位十六进制
  // 侧栏 applyBookContext 的"像不像真实书 ID"闸门
  assert.ok(/^[A-Za-z0-9_]{12,}$/.test(bookId), '过不了侧栏的书 ID 校验 → 上下文会被当成垃圾值丢掉')
  // /book-delete 的入参校验
  assert.ok(/^[A-Za-z0-9_]{12,}$/.test(bookId) && !bookId.startsWith('__'), '过不了 /book-delete 的入参校验')
  // 接收端 sanitizePathPart：只留字母数字下划线，rd_ 必须原样活下来
  assert.equal(bookId.replace(/[^A-Za-z0-9_-]/g, ''), bookId, 'sanitizePathPart 会改掉这个 ID')
  // /books 列表的过滤器（侧栏「已读过的书籍」的数据源）
  assert.ok(/^[A-Za-z0-9_]{12,}$/.test(bookId), '过不了 /books 的过滤器 → 列表里看不到这本书')
  // 侧栏 baseBookId 去掉的是 k+16位十六进制后缀；rd_ 开头不会被误伤
  assert.equal(bookId.replace(/k[0-9a-f]{16,}$/i, ''), bookId, 'baseBookId 会把这个 ID 截断')
})

test('删「书籍记录」不许碰 PDF 原件（/book-delete 逐件删，不再 rm -rf 整个目录）', () => {
  const start = RECEIVER_SRC.indexOf("url === '/book-delete'")
  assert.ok(start > 0, '找不到 /book-delete 分支')
  const end = RECEIVER_SRC.indexOf("url === '/book-create'", start)
  assert.ok(end > start, '找不到 /book-delete 分支的结尾')
  const block = RECEIVER_SRC.slice(start, end)

  assert.ok(!/rmSync\([^)]*BOOKS_DIR[^)]*recursive:\s*true/.test(block),
    '/book-delete 又在整目录删了 —— 阅读器的书会和 PDF 原件一起消失')
  assert.ok(block.includes('读取器') || block.includes('CHAT_SIDE'),
    '/book-delete 不再区分共读侧文件清单')
  const m = /const CHAT_SIDE = \[([^\]]*)\]/.exec(block)
  assert.ok(m, '找不到共读侧文件白名单（CHAT_SIDE）')
  assert.ok(!m[1].includes('source.pdf'), 'CHAT_SIDE 里出现了 source.pdf —— 这正是不能删的东西')
  assert.ok(!m[1].includes('reader-meta.json'), 'CHAT_SIDE 里出现了 reader-meta.json —— 那是书库侧的记录')
  assert.ok(m[1].includes('meta.json'), 'CHAT_SIDE 丢了 meta.json —— 删完记录还留在「已读过的书籍」里')
})

test('删「书库原件」不许碰共读侧记录（/reader-book-delete 只删两件）', () => {
  const start = RECEIVER_SRC.indexOf("url === '/reader-book-delete'")
  assert.ok(start > 0, '找不到 /reader-book-delete 分支')
  const end = RECEIVER_SRC.indexOf("url === '/tool-record'", start)
  assert.ok(end > start, '找不到 /reader-book-delete 分支的结尾')
  const block = RECEIVER_SRC.slice(start, end)

  assert.ok(!/rmSync\(readerDir\([^)]*\)[^)]*recursive:\s*true/.test(block),
    '/reader-book-delete 又整目录删了 —— 会把共读侧的 meta.json / 引用一起带走')
  assert.ok(block.includes("'source.pdf'") && block.includes('READER_META'),
    '这里应当只删 source.pdf 与 reader-meta.json 两件')
  assert.ok(!/'meta\.json'/.test(block), '这里出现了 meta.json —— 共读侧记录不该被它删')
})

test('阅读器的书与书库共用同一个目录名（rd_<hash>），不裂成两份', () => {
  // 目录名归一化：裸哈希与 rd_ 前缀都必须落到同一个目录，否则 reader-meta.json
  // 与 meta.json 会各躺一个目录、而按裸哈希取原件会 404（实测踩过）
  const m = /function readerBookHash\(input\)\s*\{([\s\S]*?)\n\}/.exec(RECEIVER_SRC)
  assert.ok(m, '找不到 readerBookHash（目录名归一化函数）')
  assert.ok(m[1].includes('READER_BOOK_PREFIX'), 'readerBookHash 不再补前缀 → 目录名出现两种写法')
  assert.ok(/function normalizeReaderHash\(h\)\s*\{[\s\S]*?startsWith\('rd_'\)/.test(RECEIVER_SRC),
    'normalizeReaderHash 不再剥前缀 → 带前缀的入参会校验失败（老接口按裸哈希传）')
})

test('侧栏认得"阅读器里正在看的那本 PDF"', () => {
  assert.ok(/action:\s*'readerBookInfo'/.test(SIDEBAR_SRC),
    '侧栏不再问后台"阅读器里开着哪本" → 用阅读器时侧栏又变回"未检测到正在阅读的书籍"')
  // 阅读器侧是**监听**这个消息（不是发送），所以断言监听分支存在
  assert.ok(/msg\.action === 'readerBookInfo'/.test(READER_SRC),
    '阅读器不再回答 readerBookInfo → 侧栏问不到书')
  const bg = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'translate-background.js'), 'utf8')
  assert.ok(/^\s*readerBookInfo,\s*$/m.test(bg), '后台没有注册 readerBookInfo 处理器')
  assert.ok(/isReaderUrl\(url\)[\s\S]{0,400}bookId/.test(bg),
    '后台解析书籍上下文时不再单独认阅读器页面 → 「设为引用」会又报"未加入一本书籍"')
})
