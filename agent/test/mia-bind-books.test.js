#!/usr/bin/env node
/**
 * 网页阅读源「加入一本书」的候选书单（2026-11 用户报）
 *
 * 用户原话：「阅读网页源的时候，弹窗选择加入一本书时只能加入网页源文章的对话，而不能
 * 加入正式书籍的对话」。
 *
 * 根因不在绑定链路，而在候选书单：旧实现 `existingMiaBooks()` 把 `/books` 的结果按
 * `^mia_` 过滤，微信读书的书与阅读器里的 PDF 全被滤掉，下拉里只剩网页文章建出来的书。
 * 绑定本身是按 bookId 归属的（侧栏 coreadManualBook → applyBookContext），所以只要
 * 候选里出现正式书，点下去就会进那本书的对话。
 *
 * 这里锁两件最容易再犯的事：
 *   · 候选书单必须来自 `/books` 的全部真实书（不是又有人把过滤加回去）；
 *   · 垃圾 ID / 哨兵 ID 不能混进下拉（发过去侧栏也会丢，列出来只会让人选了个空）。
 *
 * 跑法：node agent/test/mia-bind-books.test.js
 *      （与 mia-fit-width.test.js 同一套"抠函数源码 + 桩依赖"的做法，不需要浏览器）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = path.join(__dirname, '..', '..', 'extension', 'source-mia.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

/** 抠出一个 2 空格缩进的函数体（与仓库里其它源码级守卫同一套做法） */
function fnSource(name) {
  const at = SRC.indexOf('function ' + name + '(')
  assert.ok(at > 0, `找不到 function ${name}()`)
  const end = SRC.indexOf('\n  }\n', at)
  assert.ok(end > at, `找不到 function ${name} 的结尾`)
  // existingBooks 是 async 函数：只从 `function` 处切会把 `async` 丢了，里面一有 await
  // 就不是合法函数体（new Function 会当场抛）。往前看 6 个字符补回来。
  const start = SRC.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at
  return SRC.slice(start, end + 4)
}

/** 把函数源码 + 它依赖的闭包变量一起包成一个可调用的函数 */
function buildFn(name, deps) {
  const keys = Object.keys(deps)
  const body = fnSource(name)
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body + `\n  return ${name};`)(...keys.map((k) => deps[k]))
}

const BOOKS = [
  // 微信读书的正式书：纯十六进制 ID（见 receiver 的 /books 过滤口径）
  { base: '480328505d095c4808beaf4', bookTitle: '大国大城', updatedAt: 30 },
  { base: 'ee442b83643425f356d563865333862', bookTitle: '静静的顿河', updatedAt: 10 },
  // 网页文章建出来的书
  { base: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？', updatedAt: 20 },
  // 阅读器里的 PDF / 教程书
  { base: 'rd_' + 'a'.repeat(64), bookTitle: '第一次共读', updatedAt: 40 },
]

function loadExistingBooks(books) {
  return buildFn('existingBooks', { getJson: async () => ({ books }) })
}

test('existingBooks：正式书籍（微信读书 / 阅读器）必须进候选 —— 不能只有网页文章的书', async () => {
  const got = await loadExistingBooks(BOOKS)()
  const bases = got.map((b) => b.base)
  assert.ok(bases.includes('480328505d095c4808beaf4'), '微信读书的书在候选里')
  assert.ok(bases.includes('rd_' + 'a'.repeat(64)), '阅读器里的书也在候选里')
  assert.ok(bases.includes('mia_8a66411378a3f8d9116f'), '网页文章的书照旧在')
})

test('existingBooks：按最近更新倒序（与侧栏「已读书籍」同一口径，最近读的排最前）', async () => {
  const got = await loadExistingBooks(BOOKS)()
  assert.deepEqual(got.map((b) => b.bookTitle), ['第一次共读', '大国大城', '列宁：怎么办？', '静静的顿河'])
})

test('existingBooks：垃圾 ID / 哨兵上下文不进下拉（发过去侧栏也会丢）', async () => {
  const got = await loadExistingBooks([
    ...BOOKS,
    { base: 'short', bookTitle: '太短' },
    { base: '', bookTitle: '空' },
    { base: '__coread_free_abcd1234__', bookTitle: '自由模式哨兵' },
    { base: 'mia_有中文', bookTitle: '非法字符' },
    null,
  ])()
  assert.deepEqual(got.map((b) => b.bookTitle), ['第一次共读', '大国大城', '列宁：怎么办？', '静静的顿河'])
})

test('existingBooks：/books 答不上来（本机服务没起来）→ 空列表，不抛错', async () => {
  const got = await buildFn('existingBooks', { getJson: async () => null })()
  assert.deepEqual(got, [])
  const got2 = await buildFn('existingBooks', { getJson: async () => ({ books: null }) })()
  assert.deepEqual(got2, [])
})

test('bookGroupOf：三种书各归各组（只影响下拉分组标题）', () => {
  const fn = buildFn('bookGroupOf', {})
  assert.equal(fn('mia_8a66411378a3f8d9116f'), 'mia', '网页文章')
  assert.equal(fn('rd_' + 'a'.repeat(64)), 'reader', '阅读器里的 PDF')
  assert.equal(fn('480328505d095c4808beaf4'), 'weread', '微信读书（兜底组）')
  assert.equal(fn(''), 'weread', '空 ID 也不抛错')
})

test('守卫：弹窗必须用全部书籍，不许把 mia-only 的过滤加回来', () => {
  assert.equal(/function existingMiaBooks\(/.test(SRC), false,
    '旧的 mia-only 取书函数已删除；若有人加回来，正式书籍会再次从下拉里消失')
  assert.ok(/books = await existingBooks\(\)/.test(SRC),
    '弹窗必须调用 existingBooks()（全部书籍）')
  assert.equal(/const b of miaBooks/.test(SRC), false,
    '选项渲染不能再遍历 miaBooks')
  // 三组标题都在：用户一眼能找到"我正在读的那本正式书"
  for (const label of ['微信读书', '网页文章', 'CoRead 阅读器']) {
    assert.ok(SRC.includes("'" + label + "'"), `下拉缺少分组「${label}」`)
  }
})
