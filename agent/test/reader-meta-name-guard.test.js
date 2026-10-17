#!/usr/bin/env node
/**
 * 兜底文件名不许覆盖真书名（2026-11，用户实测报的 bug）
 *
 * ── 报的现象 ──────────────────────────────────────────────────────────────────
 * 用户："什么玩意你怎么给我搞出一堆 source.pdf, sample.pdf"。
 * 查下来书库里的 `name` 字段被写成了 `source.pdf`（两本真书都是），
 * 而书库界面显示的就是这个字段——所以真名永久丢了。
 *
 * ── 机制（这条测试盯的就是它）────────────────────────────────────────────────
 * 书库把原件统一存成 `<hash>\source.pdf`，于是"文件名"和"书名"在一条路上重合：
 * 从书库再打开一次原件、或把那份原件拖进窗口，浏览器给的文件名就是 `source.pdf`。
 * 而 `writeReaderMeta` 是**合并覆盖**（后写盖先写），并且阅读器每次存进度都会
 * 顺带把当时的 `state.name` 报一遍（reader.js 的 touchLibraryMeta）——
 * 一次误写会被反复加固，再也回不去。
 *
 * ── 修法与断言方式 ────────────────────────────────────────────────────────────
 * 修在**唯一写入点** `writeReaderMeta`：已有真名时，兜底名一律不覆盖，只留痕。
 * 这里不扫字符串"看起来在不在"——`isRealBookName` 是从 receiver 源码里**抠出来真跑**的
 *（与 agent/test/reader-book-contract.test.js 抠 readerBookHash 同一套路数）。
 *
 * 跑法：node agent/test/reader-meta-name-guard.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RECEIVER_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'receiver', 'index.js'), 'utf8')

/** 从 receiver 源码里抠出某个函数并真跑它（不复制逻辑，改实现这里必须跟着改） */
function extractFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}')
  const m = re.exec(RECEIVER_SRC)
  assert.ok(m, `receiver/index.js 里找不到 ${name}（改名了就要同步改这条测试）`)
  /**
   * ⚠️ 依赖的常量必须用 `var` **以同一个名字**注入（踩过两次）：
   *   · 先写 `globalThis.__GENERIC = …` → 函数体里读的是 `GENERIC_READER_NAMES`，
   *     ctx 上多一个属性不等于建立词法绑定，照样 ReferenceError；
   *   · 顺序也要对：`var` 会提升但赋值不会，所以常量要先跑、函数后跑。
   */
  const setM = /const GENERIC_READER_NAMES = (new Set\(\[[^\]]*\]\))/.exec(RECEIVER_SRC)
  assert.ok(setM, 'receiver/index.js 里找不到 GENERIC_READER_NAMES')
  const ctx = { Set, String, console }
  vm.createContext(ctx)
  vm.runInContext(`var GENERIC_READER_NAMES = ${setM[1]};`, ctx)
  vm.runInContext(`var ${name} = function ${name}(${m[1]}) {${m[2]}\n};`, ctx)
  return (arg) => ctx[name](arg)
}

const isRealBookName = extractFn('isRealBookName')

test('兜底文件名不算真书名（这两个是我们自己制造的）', () => {
  assert.equal(isRealBookName('source.pdf'), false, '系统内部的原件名，绝不该当书名')
  assert.equal(isRealBookName('未命名.pdf'), false, '阅读器读不到文件名时的占位')
  assert.equal(isRealBookName('SOURCE.PDF'), false, '大小写不该绕过')
  assert.equal(isRealBookName('  source.pdf  '), false, '前后空格不该绕过')
})

test('真空名算真书名', () => {
  assert.equal(isRealBookName('A Clinical Introduction to Lacanian Psychoanalysis.pdf'), true)
  assert.equal(isRealBookName('Theories of German Fascism_ On the Collection of Essays.pdf'), true)
  assert.equal(isRealBookName('法西斯主义论文集.pdf'), true)
})

/**
 * ⚠️ 这几条是**故意的**：它们看着也"不像正经书名"，但可能真是用户自己起的文件名。
 * 挡掉等于替用户判断"你这名字不像书名"——越权，而且会静默吞掉真名。
 */
test('可能真是用户文件名的，一律不挡（只挡我们自己制造的那两个）', () => {
  for (const n of ['sample.pdf', 'scan.pdf', 'many.pdf', 'outline.pdf', 'book.pdf', '1.pdf', 'a.pdf']) {
    assert.equal(isRealBookName(n), true, `${n} 可能真是用户的文件名，不许挡`)
  }
})

test('空 / 非字符串不算真书名（首存时会照存，但不会拿去覆盖）', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(isRealBookName(v), false, JSON.stringify(v) + ' 不算真名')
  }
})

// ── 覆盖规则本身：真名在，兜底名想覆盖 → 保留真名 + 留痕 ──────────────────────
/** 按 receiver 里 writeReaderMeta 的规则重演一次合并（与实现逐条对应） */
function mergeMeta(prev, patch) {
  const next = Object.assign({}, prev, patch, { hash: 'x', updatedAt: 1 })
  if (isRealBookName(prev.name) && 'name' in patch && !isRealBookName(patch.name)) {
    next.name = prev.name
    next.nameRejected = String(patch.name == null ? '' : patch.name).slice(0, 200)
    next.nameRejectedAt = 1
  }
  return next
}

test('已有真名时，source.pdf 覆盖不进来，并留下痕迹', () => {
  const out = mergeMeta({ name: 'Theories of German Fascism.pdf', pages: 9 }, { name: 'source.pdf' })
  assert.equal(out.name, 'Theories of German Fascism.pdf', '真名必须活下来')
  assert.equal(out.nameRejected, 'source.pdf', '要留痕，不能静默丢弃')
})

test('正常换名照旧生效（别把门关死）', () => {
  const out = mergeMeta({ name: '老名字.pdf' }, { name: '新名字.pdf' })
  assert.equal(out.name, '新名字.pdf')
})

test('第一次存书时哪怕是兜底名也照存（空着比存兜底名更糟）', () => {
  const out = mergeMeta({}, { name: 'source.pdf' })
  assert.equal(out.name, 'source.pdf', '首存不该被挡——那时没有更好的名字可用')
  assert.equal(out.nameRejected, undefined, '首存不算"被拒"')
})

test('patch 里不带 name 时不碰名字（存进度那条路本来就不该改书名）', () => {
  const out = mergeMeta({ name: '真名.pdf' }, { pages: 300, page: 6 })
  assert.equal(out.name, '真名.pdf')
  assert.equal(out.nameRejected, undefined)
})

test('只有一处写 reader-meta.json（这条修法成立的前提）', () => {
  const writes = [...RECEIVER_SRC.matchAll(/writeFileSync\(path\.join\(dir, READER_META\)/g)]
  assert.equal(writes.length, 1,
    'reader-meta.json 必须只有一个写入点，否则这道闸门会被绕过')
  assert.ok(/function writeReaderMeta\(hash, patch\)/.test(RECEIVER_SRC),
    'writeReaderMeta 还在（改名了要同步改这条）')
})
