#!/usr/bin/env node
/**
 * 阅读器顶栏的三态（2026-11）
 *
 * 起因（用户报）："阅读器顶上的工具栏在书库界面也会全部出现，好奇怪"。
 * 根因：顶栏显隐只有一条**布尔开关** `showPdfChrome(on)`（为"教程书"那一种情况写的），
 * 而 `showLibrary()` 从头到尾没碰过它 —— 于是从书里点「书库」之后，上一本的书名、
 * 「412 页」、「120%」、「框选翻译」「译文」全留在顶上。那不是设计如此，是那条开关
 * 表达不了"我在书库"。现在收成三态表 `CHROME = { library, pdf, tutorial }`。
 *
 * 这个文件盯四件事：
 *   ① 三态表存在，且每一态的清单**逐项写死在这里**（谁改了清单，这里必须跟着改——
 *      这正是"有意改动"与"悄悄漂移"的分界）；
 *   ② 书库态不许出现 缩放 / 框选翻译 / 适宽 / 译文 / 页码 / 渲染状态；
 *   ③ 回书库那条路必须同时做三件事：切顶栏、清顶栏文字、放回空状态
 *      （少一件就是"书库页面上挂着上一本的书名"）；
 *   ④ 不许再出现布尔时代的残留（`showPdfChrome` / `PDF_ONLY_BTNS`）。
 *
 * ⚠️ 为什么是"读源码"而不是"跑 DOM"：这个仓库没有给阅读器页面配 DOM 替身
 * （sidebar 那几份有，reader 没有——它依赖 pdf.js 与 chrome.* 太多）。
 * 真环境里验顶栏的是扩展自检（`extension/selfcheck.html`），那要人点一下。
 * 这里的静态断言负责挡住"改回去"这种回归，两者的分工别混。
 *
 * 跑法：node agent/test/reader-toolbar-states.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const JS = path.join(ROOT, 'extension', 'reader.js')
const src = fs.readFileSync(JS, 'utf8')

/** 从源码里取出 CHROME 表并解析成对象（不执行源码，只读它写下的清单） */
function parseChromeTable() {
  const m = /const CHROME = \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(m, 'reader.js 里必须有 CHROME 三态表')
  const out = {}
  for (const line of m[1].split('\n')) {
    const mm = /^\s*(\w+):\s*\[([^\]]*)\],/.exec(line)
    if (!mm) continue
    out[mm[1]] = [...mm[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  return out
}

const CHROME = parseChromeTable()

test('三态表就位，且三种状态齐全', () => {
  assert.deepEqual(Object.keys(CHROME).sort(), ['library', 'pdf', 'tutorial'])
})

test('书库态只留「状态那格 + 书库里那枚打开 PDF」——用户点名的三条都在这里挡住', () => {
  assert.deepEqual(CHROME.library, ['openMain', 'status'],
    '书库态清单被人改动过。若是有意的：请同时改这条断言并说明为什么加/减')

  // ① 用户："在书库界面为什么还要显示书库" —— 我已经在书库里了，那是个空动作
  assert.ok(!CHROME.library.includes('libraryBtn'), '书库态不该有「书库」按钮（当前所在由 status 那格说）')
  // ② 用户："为什么要显示目录" —— 目录是书的目录，不是书库的目录
  assert.ok(!CHROME.library.includes('tocBtn'), '书库态不该有「目录」（书库里没有书，它无内容或拿的是上一本的）')
  // ③ 用户："搞那么多打开 pdf 的按钮是干嘛" —— 两个真能用的按钮干同一件事
  assert.ok(!CHROME.library.includes('open'), '书库态顶栏不该再有「打开 PDF」：书库标题行那枚 openMain 就是它')
  assert.ok(CHROME.pdf.includes('open'), '打开书之后顶栏那枚「打开 PDF」要回来（那时它才是"再打开一个"）')

  for (const key of ['zoomIn', 'zoomOut', 'zoom', 'fit', 'box', 'notes', 'name', 'pageinfo']) {
    assert.ok(!CHROME.library.includes(key), `书库态不该出现 ${key}`)
  }
  // status 必须留着：书库态没有「书库」按钮了，"我在哪儿"和"服务连不上"都靠它说
  assert.ok(CHROME.library.includes('status'), '状态那格要留（它显示"书库"，也负责报服务断线的错）')
})

test('设置那格（status）在两种态里都要有，但内容由 updateStatus 决定显不显示', () => {
  // 书库态那格显示"书库"（补上被拿掉的「书库」按钮）；PDF 态平时 hidden、出错才冒头
  assert.ok(CHROME.library.includes('status'), '书库态要靠它说"我在哪儿"')
  assert.ok(CHROME.pdf.includes('status'), 'PDF 态要靠它报渲染错误')
})

test('框选翻译：工具栏按钮是切换式，Alt+S 是一次性（两条路都要在源码里留下痕迹）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'extension', 'reader.js'), 'utf8')
  assert.ok(/els\.box\.addEventListener\('click', \(\) => toggleBoxSelect\(\)\)/.test(js),
    '工具栏那枚走 toggleBoxSelect（切换式）')
  assert.ok(/startBoxSelect\(\{ oneShot: true \}\)/.test(js), 'Alt+S 要传 oneShot: true（一次性）')
  assert.ok(/if \(state\.boxOneShot\) endBoxSelect\('done'\)/.test(js),
    '框完只在"一次性"时自动退出；切换式要留在模式里，方便连着框')
  assert.ok(/function applyBoxModeChrome/.test(js), '进出模式的界面状态要走同一个函数')
})

test('PDF 态齐全（在读 PDF 时该有的都在）', () => {
  for (const key of ['open', 'libraryBtn', 'tocBtn', 'zoomIn', 'zoomOut', 'zoom', 'box', 'notes', 'name', 'status', 'pageinfo']) {
    assert.ok(CHROME.pdf.includes(key), `PDF 态缺了 ${key}`)
  }
  /**
   * ⚠️ `fit`（适宽）**故意不在清单里**（2026-11 顶栏重排）：那一格被"点百分比数字回适宽"
   * 取代了，按钮本身在 HTML 上带 `hidden`、永不显示；它在 DOM 里留着是给 Ctrl+0
   * 与扩展自检一个显式落点。
   * 一旦把它加回清单，setToolbar 每次跑都会 `hidden = false` —— 那个按钮就又冒出来，
   * 顶栏回到"两个缩放入口"的老样子。这条断言就是拦这个的。
   */
  assert.ok(!CHROME.pdf.includes('fit'), 'fit 不该回到 PDF 态清单：它已被"点百分比"取代')
})

test('教程书态：留下目录与页码，藏掉 PDF 专有动作', () => {
  assert.ok(CHROME.tutorial.includes('tocBtn'), '教程书靠「目录」跳章，必须留')
  assert.ok(CHROME.tutorial.includes('pageinfo'), '页码那格显示"第几章"，是教程书唯一的进度提示')
  for (const key of ['open', 'openMain', 'libraryBtn', 'zoomIn', 'zoomOut', 'zoom', 'box', 'notes']) {
    assert.ok(!CHROME.tutorial.includes(key), `教程书里不该出现 ${key}（点了没反应的按钮比没有更糟）`)
  }
})

test('每态的键都落在可显隐清单里（写错一个名字就会静默失效）', () => {
  const all = /const CHROME_ALL = \[([^\]]*)\]/.exec(src)
  assert.ok(all, 'reader.js 里必须有 CHROME_ALL')
  const allKeys = [...all[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  for (const [mode, keys] of Object.entries(CHROME)) {
    for (const k of keys) {
      assert.ok(allKeys.includes(k), `${mode} 态里的 ${k} 不在 CHROME_ALL 里 → setToolbar 拿不到它`)
    }
  }
})

test('setToolbar 只管顶栏，不顺手改页面主体', () => {
  const fn = /function setToolbar\(mode\) \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(fn, '要有 setToolbar')
  assert.ok(!/els\.empty/.test(fn[1]),
    'setToolbar 里不该碰 els.empty —— 旧版就是在"切工具栏"里顺手藏空状态，'
    + '结果调用方再想单独控制空状态就没办法了')
  assert.ok(/setEmptyVisible/.test(src), '页面主体要由 setEmptyVisible 单独管')
})

test('回书库那条路三件事都做：切顶栏 / 清文字 / 放回空状态', () => {
  const fn = /function showLibrary\(\) \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(fn, '要有 showLibrary')
  assert.ok(/setToolbar\('library'\)/.test(fn[1]), '要切回书库态（用户报的 bug 就是漏了这一步）')
  assert.ok(/resetToolbarText\(\)/.test(fn[1]), '要清掉上一本的书名 / 页码 / 缩放百分比')
  assert.ok(/setEmptyVisible\(true\)/.test(fn[1]), '要把空状态放回来')
})

test('回书库时状态那格写的是「书库」（补上被拿掉的"我在哪儿"）', () => {
  const fn = /function resetToolbarText\(\) \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(fn, '要有 resetToolbarText')
  assert.ok(/textContent = '书库'/.test(fn[1]),
    'resetToolbarText 要把状态那格写成"书库"——书库按钮已经拿掉了，位置感靠它')
})

test('渲染状态平时不显示，只在出问题时冒头（顶栏"乱七八糟"的一半是它）', () => {
  const m = /function updateStatus\(\) \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(m, '要有 updateStatus')
  // ⚠️ 别在正则末尾写 `\}\n`：这个函数体里有缩进四格的 `}`（if 块），
  // 非贪婪匹配会一路吞到文件里下一个顶格 `}`，断言就在别人的代码上跑（这条踩过）
  const body = m[1]
  assert.ok(/els\.status\.hidden = true/.test(body), '正常路径要把它藏掉')
  assert.ok(/els\.status\.title = /.test(body), '那些详细数字要挂到 title 上（排查时还在）')
})

test('打开失败那条路也要回书库态（否则顶栏停在"在读"的样子）', () => {
  const fn = /function failOpen\(message\) \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(fn, '要有 failOpen')
  assert.ok(/setToolbar\('library'\)/.test(fn[1]), 'failOpen 要切回书库态')
})

test('布尔时代的残留必须清干净', () => {
  // 注释里提到 showPdfChrome 是在讲历史，允许；代码里出现就是没清干净
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/showPdfChrome/.test(code), 'showPdfChrome 已被三态取代，代码里不该还有它')
  assert.ok(!/PDF_ONLY_BTNS/.test(code), 'PDF_ONLY_BTNS 已被 CHROME 表取代')
})

test('装载时按书库态排一次顶栏（不靠 HTML 里的 hidden 属性分两处写规则）', () => {
  assert.ok(/^setToolbar\('library'\)$/m.test(src),
    'reader.js 顶层要调一次 setToolbar(\'library\') —— 否则规则分两处，改一处忘一处')
})
