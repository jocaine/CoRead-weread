#!/usr/bin/env node
/**
 * 「书名带着章节」的治本修复（2026-11）——写入侧拆、画图侧归一，两侧必须收敛到同一个书名。
 *
 * 背景（用户报的"《大国大城》出现两种节点颜色"）：
 *   微信读书顶栏那一串是**书名 + 章节**拼在一起的，而且分隔符宽度不固定：
 *     「大国大城：当代中国的统一、发展与平衡 1 欧洲正经历大考」← 一个空格 + 章节号
 *     「学做工  制度形式」「静静的顿河…  六」「…论纲  第1章」    ← 两个空格
 *   老代码整串当书名存下来 → 会意图按书名字符串认"书" → 同一本书按章节碎成好几本 → 两种颜色。
 *
 * 现在两头都改：
 *   · 写入侧 extension/content.js 的 splitBookTitle()：拆成「书名」+「章节」，章节回到它自己的字段；
 *   · 画图侧 extension/graph-view.js 的 bookName()：渲染时归一（老数据也一起治）。
 *   这两个规则**必须一致**——不一致就会出现"新数据干净、老数据带章节，图上又分成两本"。
 *   所以本文件的核心断言就是：**同一批真实书名，两边算出来的书名必须逐字相同**。
 *
 * 跑法：node --test agent/test/book-title-split.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const CONTENT = path.join(ROOT, 'extension', 'content.js')
const GRAPH = path.join(ROOT, 'extension', 'graph-view.js')
const SIDEBAR = path.join(ROOT, 'extension', 'sidebar.js')

/**
 * 读源码，并**把换行统一成 LF**。
 *
 * 为什么必须归一：下面几个抽取器用 '\n}\n' 找函数结尾，而本仓库的文件在 Windows
 * 检出后是 CRLF（'}\r\n'）—— 不归一的话「找不到函数的结尾」会随机砸在不同文件上
 *（这台机器上砸中的是 sidebar.js，graph-view.js 恰好是 LF 才没炸）。
 * 源码文本分析不该让换行参与语义。
 */
const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const contentSrc = readSrc(CONTENT)
const graphSrc = readSrc(GRAPH)
const sidebarSrc = readSrc(SIDEBAR)

/** 抠出一个 2 空格缩进的函数体 */
function fnSource(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > 0, `找不到 function ${name}()`)
  const end = src.indexOf('\n  }\n', at) >= 0 ? src.indexOf('\n  }\n', at) : src.indexOf('\n}\n', at)
  assert.ok(end > at, `找不到 function ${name} 的结尾`)
  return src.slice(at, end + 4)
}
/** content.js / sidebar.js 是顶层函数（无缩进），结尾是行首的 } */
function topFnSource(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > 0, `找不到 function ${name}()`)
  const end = src.indexOf('\n}\n', at)
  assert.ok(end > at, `找不到 function ${name} 的结尾`)
  return src.slice(at, end + 3)
}

// eslint-disable-next-line no-new-func
const splitBookTitle = new Function(topFnSource(contentSrc, 'splitBookTitle') + '\n return splitBookTitle')()
// eslint-disable-next-line no-new-func
const bookName = new Function(fnSource(graphSrc, 'bookName') + '\n return bookName')()
// eslint-disable-next-line no-new-func
const titleMatches = new Function(topFnSource(sidebarSrc, 'titleMatches') + '\n return titleMatches')()

// ── 用户书库里的真实书名（从 annotations.jsonl / 图谱里抄来的原件）──────────
const CITY = '大国大城：当代中国的统一、发展与平衡'
const CASES = [
  ['大国大城：当代中国的统一、发展与平衡 1 欧洲正经历大考', CITY, '1 欧洲正经历大考'],
  ['大国大城：当代中国的统一、发展与平衡 4 发展中大国的困境与机遇', CITY, '4 发展中大国的困境与机遇'],
  ['大国大城：当代中国的统一、发展与平衡 5 统一市场符合公共利益', CITY, '5 统一市场符合公共利益'],
  ['学做工  制度形式', '学做工', '制度形式'],
  ['摩托日记  专家', '摩托日记', '专家'],
  ['静静的顿河：全三册（1965年诺贝尔文学奖获奖者肖洛霍夫代表作。只要还有人做正派的人，不正派的时代就会被改变）  六十五',
    '静静的顿河：全三册（1965年诺贝尔文学奖获奖者肖洛霍夫代表作。只要还有人做正派的人，不正派的时代就会被改变）', '六十五'],
  ['中国特色社会主义保障制度论纲  第1章', '中国特色社会主义保障制度论纲', '第1章'],
  ['当代中国社会结构研究报告  2  当代中国社会流动 -- 陆学艺 主编', '当代中国社会结构研究报告', '2  当代中国社会流动 -- 陆学艺 主编'],
  ['Theories of German Fascism: On the Collection of Essays War and Warrior, edited by Ernst Junger.  第1章',
    'Theories of German Fascism: On the Collection of Essays War and Warrior, edited by Ernst Junger.', '第1章'],
  ['列宁：怎么办？', '列宁：怎么办？', ''],
  ['国家与革命', '国家与革命', ''],
  ['第一次共读', '第一次共读', ''],
]

test('splitBookTitle：把顶栏那串拆成「书名」+「章节」（章节不丢，只是挪出书名）', () => {
  for (const [raw, title, chapter] of CASES) {
    const got = splitBookTitle(raw)
    assert.equal(got.bookTitle, title, `书名拆错：${raw}`)
    assert.equal(got.chapter, chapter, `章节拆错：${raw}`)
  }
})

test('两侧必须一致：写入侧拆出来的书名 === 画图侧归一出来的书名（否则图上又分成两本）', () => {
  for (const [raw] of CASES) {
    assert.equal(splitBookTitle(raw).bookTitle, bookName(raw),
      `两侧规则漂了：写入侧给了 ${JSON.stringify(splitBookTitle(raw).bookTitle)}，` +
      `画图侧给了 ${JSON.stringify(bookName(raw))}（输入：${raw}）`)
  }
})

test('边界：空串、只有章节的串、纯数字书名都不许拆坏', () => {
  assert.deepEqual(splitBookTitle(''), { bookTitle: '', chapter: '' })
  assert.deepEqual(splitBookTitle('   '), { bookTitle: '', chapter: '' })
  // 只有章节、没有书名：宁可整串留着 —— 书名不能是空的（空了侧栏会显示成《》）
  const onlyChapter = splitBookTitle(' 1 欧洲正经历大考')
  assert.equal(onlyChapter.bookTitle, '1 欧洲正经历大考', '拆空了就退回整串')
  // 纯数字书名不受"数字+空格"规则影响（它前面没有空白）
  assert.equal(splitBookTitle('1984').bookTitle, '1984')
  assert.equal(splitBookTitle('1984').chapter, '')
})

test('titleMatches：同一本书的新老两种写法要认成同一本（否则点引用条会静默无反应）', () => {
  assert.equal(titleMatches(CITY, '大国大城：当代中国的统一、发展与平衡 1 欧洲正经历大考'), true, '老写法带章节')
  assert.equal(titleMatches('大国大城：当代中国的统一、发展与平衡 1 欧洲正经历大考', CITY), true, '反过来也要认')
  assert.equal(titleMatches(CITY, CITY), true)
  assert.equal(titleMatches('学做工', '学做工  制度形式'), true)
  assert.equal(titleMatches('学做工', '摩托日记'), false, '不同的书不许认成同一本')
  assert.equal(titleMatches('学做工', ''), false, '空书名不匹配（否则满列表都会被认成同一本）')
  assert.equal(titleMatches('', ''), true, '都是空串时 === 成立，保持原语义')
})

// ── 源码级守卫：这两处接线断了，功能就静默失效 ──────────────────────────────
test('守卫：content.js 的 getReadingContext 真的用了 splitBookTitle，且章节优先取页面元素', () => {
  const at = contentSrc.indexOf('function getReadingContext()')
  const block = contentSrc.slice(at, at + 2600)
  assert.ok(/splitBookTitle\(topBarRaw\)/.test(block), '顶栏整串必须过一遍 splitBookTitle')
  assert.ok(/const bookTitle = split\.bookTitle \|\| topBarRaw/.test(block), '拆空了要退回整串')
  assert.ok(/const chapter = chapterEl \|\| split\.chapter/.test(block),
    '章节优先取页面上的章节元素，它为空时才用顶栏拆出来的那半')
})

test('守卫：侧栏比较书名不许再用 ===（新老写法会静默不匹配）', () => {
  const at = sidebarSrc.indexOf('function findRefNum(')
  const end = sidebarSrc.indexOf('function selectRefByPending(', at)
  const block = sidebarSrc.slice(at, end + 1400)
  assert.ok(block.includes('titleMatches(a.bookTitle, bookTitle)'), 'findRefNum 要用 titleMatches')
  assert.ok(block.includes('titleMatches(a.bookTitle, ref.bookTitle)'), 'selectRefByPending 要用 titleMatches')
  assert.equal(/a\.bookTitle === (bookTitle|ref\.bookTitle)/.test(block), false,
    '还有地方在用 === 比较书名 —— 新旧写法不一致时那段会静默失效')
})
