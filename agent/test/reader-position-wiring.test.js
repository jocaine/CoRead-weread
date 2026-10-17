#!/usr/bin/env node
/**
 * 阅读器「读到哪儿」的接线（2026-11 二次改版）
 *
 * 起因（用户报）："下次打开阅读器的时候，当前阅读位置的定义问题"。
 * 查下来是三件事叠在一起：
 *   ① 位置只记到"第几页"，回来滚到那一页**顶端** —— 页内位置丢了（适宽下一页常比屏幕高，
 *      教程书一章好几屏，"同一页"根本不等于"同一处"）；
 *   ② 打开后只滚一次（60ms），而那一刻所有页高还是按**第 1 页**估的占位值，
 *      等上面那些页陆续渲染，内容就从你脚下移开（页高不一的 PDF 尤其明显，还时灵时不灵）；
 *   ③ 教程书的"读到第几章"被写成了 `currentPage()`，而那个函数遍历的是 PDF 的
 *      `state.pages`（教程书下是空数组）→ **永远是 1**：教程书每次打开都回到第一章，
 *      滚动时状态栏也一直写"第 1 / 7 章"。
 *
 * 这个文件盯的是"接线"：算术本身在 extension/test/reader-position.test.mjs（纯函数单测），
 * 真环境那一遍在扩展自检的 8h 段。三者分工别混。
 *
 * ⚠️ 为什么这里读源码而不是跑 DOM：这个仓库没有给阅读器页面配 DOM 替身
 *（它依赖 pdf.js 与 chrome.* 太多，见 reader-toolbar-states.test.js 开头的说明）。
 *
 * 跑法：node agent/test/reader-position-wiring.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = fs.readFileSync(path.join(ROOT, 'extension', 'reader.js'), 'utf8')
const SELFCHECK = fs.readFileSync(path.join(ROOT, 'extension', 'selfcheck.js'), 'utf8')

/** 抠出一个函数的函数体（去掉注释，避免注释里的字被当成实现） */
function bodyOf(src, decl) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const i = clean.indexOf(decl)
  assert.ok(i >= 0, `找不到 ${decl}（改名了就要同步改这里）`)
  // ⚠️ 函数体的 `{` 要**跳过参数表**再找：`(bytes, name, opts = {})` 里那个 `{}` 不是函数体，
  // 直接找第一个 `{` 会只抠出 `{}`，于是断言全部假通过（这个坑自己踩过一次）
  const start = clean.indexOf('{', clean.indexOf(')', i))
  return bracedBlock(clean, start)
}

/** 从 `{` 开始配平到它自己的 `}` */
function bracedBlock(src, start) {
  assert.ok(start >= 0, '找不到函数体的左花括号')
  let depth = 0
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start, k + 1) }
  }
  assert.fail('花括号没配平')
}

test('位置只有一个定义：currentPage() 就是 currentPosition().page', () => {
  const body = bodyOf(SRC, 'function currentPage()')
  assert.ok(/currentPosition\(\)\.page/.test(body),
    'currentPage() 又自己算了一遍 → 两把尺子迟早分叉（保存用一个、显示用另一个）')
  const pos = bodyOf(SRC, 'function currentPosition()')
  assert.ok(/positionFromBoxes\(/.test(pos), 'currentPosition 不再用公共算术算 PDF 的位置')
  assert.ok(/scrollRefLine\(\)/.test(pos), '参考线必须走 scrollRefLine()（存与恢复同一条线）')
})

test('记录里除了"第几页"还存**页内比例** frac（老记录按 0 兼容）', () => {
  const save = bodyOf(SRC, 'async function saveRecord()')
  assert.ok(/page:\s*pos\.page/.test(save) && /frac:\s*pos\.frac/.test(save),
    '记录里少了 frac → 又变成"只记到第几页"')
  assert.ok(/const pos = currentPosition\(\)/.test(save), '保存的位置必须来自 currentPosition()')
  // 恢复侧：老记录没有 frac 时要当成 0（= 旧行为"回到那一页顶端"），不能变成 NaN
  const load = bodyOf(SRC, 'async function loadDocument')
  assert.ok(/frac:\s*saved\.frac/.test(load), '恢复时没把 frac 交给 restorePosition')
  assert.ok(!/setTimeout\(\(\) => gotoPage\(saved\.page/.test(load),
    '又回到"60ms 后 gotoPage 一次"——那正是位置落错地方的原因（见文件头 ②）')
  assert.ok(/restorePosition\(/.test(load), '打开 PDF 时没有走 restorePosition')
})

test('落位要纠偏，而且不许跟用户抢滚动条', () => {
  const restore = bodyOf(SRC, 'function restorePosition(')
  assert.ok(/applyPosition\(target\)/.test(restore), 'restorePosition 应当**立刻**落一次（不能只排队等定时器）')
  assert.ok(/RESTORE_SETTLE_MS/.test(restore), 'restorePosition 没设"最多纠多久"的上限')
  const tick = bodyOf(SRC, 'function restoreTick()')
  assert.ok(/stuck >= 2/.test(tick), '缺"落不动就收手"的刹车 → 到底/到顶时会一直重试')
  assert.ok(/RESTORE_MAX_TRIES/.test(tick), '缺"最多补几次"的上限')
  // ⚠️ "已经正好在位"与"想动却动不了"必须分开：混成一个的话，纠偏会在第一次 ticks
  // 就收手（那一刻当然是在位的），而漂移是**之后**才发生的 —— 等于白做（写这一版时踩到）
  const apply = bodyOf(SRC, 'function applyPosition(')
  assert.ok(/'in-place'/.test(apply) && /'blocked'/.test(apply), 'applyPosition 没把"在位"与"动不了"分开')
  assert.ok(/'blocked' \|\| res === 'no-box'/.test(tick),
    'restoreTick 又把"在位"当成卡住了 → 纠偏会提前收手')
  // 用户一动就停手：这四个事件里至少 wheel / touchstart / pointerdown 挂在滚动区、
  // keydown 挂在 document（程序化 scrollTo 不会产生它们，所以判得准）
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) {
    assert.ok(new RegExp(`'${ev}'[\\s\\S]{0,120}cancelRestore`).test(SRC), `缺少"用户${ev}就取消纠偏"`)
  }
  assert.ok(/'keydown'[\s\S]{0,120}cancelRestore/.test(SRC), '缺少"用户按键就取消纠偏"')
  // 页面渲染完一页 → 几何变了 → 补落一次（漂移正是渲染引起的）
  const render = bodyOf(SRC, 'async function renderPage(num)')
  assert.ok(/restoreOnLayoutChange\(\)/.test(render), 'renderPage 完成后没有补落一次 → 又会落错地方')
})

test('教程书的"第几章"只来自 Tutorial，不许拿 currentPage() 量', () => {
  const pos = bodyOf(SRC, 'function currentPosition()')
  assert.ok(/Tutorial\.currentIndex\(\)/.test(pos), '教程书的位置没问 Tutorial → 章号只能量出 1（见文件头 ③）')
  const scroll = bodyOf(SRC, 'function onScroll()')
  // 单独盯**教程书那条分支**：PDF 那条用 currentPage() 是对的，不能一起禁掉
  const at = scroll.indexOf('state.tutorialOpen')
  assert.ok(at > 0, 'onScroll 里没有"教程书"那条分支了？')
  // `if (state.tutorialOpen) {` 之后第一个 `{` 就是这条分支的左花括号（那个 `if` 在 at 之前）
  const tutBranch = bracedBlock(scroll, scroll.indexOf('{', at))
  assert.ok(/Tutorial\.currentIndex\(\)/.test(tutBranch), '教程分支没问 Tutorial → 状态栏会一直写"第 1 章"')
  assert.ok(!/currentPage\(\)/.test(tutBranch),
    '教程分支里又用了 currentPage()（它遍历的是 PDF 的 state.pages，教程书下永远是 1）')
  assert.ok(/if \(ch !== state\.tutorialPage\) state\.tutorialPage = ch/.test(tutBranch),
    '教程分支没有把"当前章"跟 Tutorial 对齐')
  const tut = bodyOf(SRC, 'async function openTutorial()')
  assert.ok(/restorePosition\(/.test(tut), '打开教程书时没恢复章内位置（只回到"第几章"等于没记住位置）')
  const toc = bodyOf(SRC, 'function syncTocPosition()')
  assert.ok(/Tutorial\.currentIndex\(\)/.test(toc), '目录的"当前位置"对教程书又用了 PDF 那把尺子')
})

test('书库记录里的"读到第几页"不许在打开过程中被写成 1', () => {
  const meta = bodyOf(SRC, 'function touchLibraryMeta(posArg)')
  assert.ok(/posArg \|\| currentPosition\(\)/.test(meta),
    'touchLibraryMeta 又自己现算位置了 → openBytes 里那次调用会把"第 1 页"写进书库记录')
  assert.ok(/pos\.page/.test(meta), '上报的页码不是那份位置')
  const open = bodyOf(SRC, 'async function openBytes(bytes, name, opts = {})')
  assert.ok(/touchLibraryMeta\(\)/.test(open), '打开一本书时不再登记书库元信息')
})

test('自检能读到"当场量的位置"与"记录里存的位置"两个值', () => {
  // 这两个值缺一个，就分不清"存错了"还是"恢复错了"（用户看到的现象一模一样）
  assert.ok(/position:\s*async/.test(SRC) && /storedPage/.test(SRC), 'SELFCHECK_OPS 缺 position（含 storedPage/storedFrac）')
  assert.ok(/setPosition:\s*async/.test(SRC), 'SELFCHECK_OPS 缺 setPosition（自检要造"上次读到这儿"）')
  assert.ok(/下次打开回到的是/.test(SELFCHECK), '自检页里没有"下次打开还在原处"那一段')
  assert.ok(/page:\s*5,\s*frac:\s*0\.55/.test(SELFCHECK), '自检没有真的摆一个位置再重开一遍')
})
