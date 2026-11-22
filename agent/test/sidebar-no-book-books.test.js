#!/usr/bin/env node
/**
 * 侧栏「无书默认界面」直接列出已读书籍（2026-11 改版）
 *
 * 起因（用户要求）：读书模式没检测到正在阅读的书时，界面只给一个「📚 从已读书籍中
 * 选择」按钮 —— 想翻旧账得再点一次、在弹窗里翻。改版后**书单直接列在界面上**，
 * 点一行就进那本书的历史记录（手动选书）。
 *
 * 这里锁住改版后的那条路径（DOM 替身跑真 sidebar.js，与 sidebar-reader-context.test.js
 * 用同一套替身）：
 *   ① 无书 → 界面可见、书单一本一条（不必先点按钮）；
 *   ② 点一条 → 切到这本书的手动查看，界面收起、消息区回来；
 *   ③ 搜索框只在书多时出现（书少时它只是白占一行）；
 *   ④ 本机服务没起来 → 说明 + 「重试」，重试后书单能起来；
 *   ⑤ 旧的「从已读书籍中选择」按钮必须不复存在（防止改版被悄悄退回）。
 *
 * 跑法：node --test agent/test/sidebar-no-book-books.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML = path.join(__dirname, '..', '..', 'extension', 'sidebar.html')
const JS = path.join(__dirname, '..', '..', 'extension', 'sidebar.js')

function makeEl(id = '') {
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    hidden: false, disabled: false, checked: false, value: '', textContent: '', title: '', placeholder: '',
    scrollTop: 0, scrollHeight: 0, isComposing: false,
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    append(...cs) { for (const c of cs) this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    replaceChildren() { this.children = [] },
    querySelector() { return makeEl() },
    querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null },
    focus() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
  return el
}

function buildDom() {
  const html = fs.readFileSync(HTML, 'utf8')
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const cache = new Map()
  const hiddenInHtml = (id) => {
    const m = new RegExp('<(\\w+)([^>]*\\bid="' + id + '"[^>]*)>').exec(html)
    return !!(m && /(^|\s)hidden(\s|=|$)/.test(m[2]))
  }
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) { const el = makeEl(id); el.hidden = hiddenInHtml(id); cache.set(id, el) }
    return cache.get(id)
  }
  const doc = {
    body: makeEl('body'),
    getElementById: getById,
    createElement: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener() {},
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev) },
  }
  return { doc, getById }
}

/**
 * @param {{books?: object[], failBooks?: boolean}} opts books = /books 返回的书单；
 *        failBooks = 头几次请求直接失败（模拟 CoRead 本机服务没起来）
 */
function loadSidebar({ books = [], failFirst = 0 } = {}) {
  const { doc, getById } = buildDom()
  const storage = {}
  let bookCalls = 0
  let failures = failFirst

  const fetchStub = async (url) => {
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    if (u.includes('/books')) {
      bookCalls++
      if (failures > 0) { failures--; throw new Error('ECONNREFUSED') }
      return json({ books })
    }
    if (u.endsWith('/ping')) return json({ ok: true })
    if (u.includes('/api-config')) return json({ configured: true })
    if (u.includes('/history')) return json([])
    if (u.includes('/stack-hits')) return json({ hits: [] })
    if (u.includes('/free-conversations')) return json({ active: [], archived: [] })
    if (u.includes('/graph')) return json({ nodes: [], edges: [] })
    return json({})
  }

  const chromeStub = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) o[k] = storage[k]; return o },
        set: async (obj) => { Object.assign(storage, obj) },
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [],                 // 没有任何微信读书 tab → 无书状态
      sendMessage: async () => null,
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: {
      sendMessage: async () => ({ ok: true, notReader: true }),
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test',
    },
  }

  class EventSourceStub { constructor() {} close() {} }

  const ctx = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    chrome: chromeStub,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' },
    navigator: { userAgent: 'node' },
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx
  ctx.self = ctx

  const expose = `
;globalThis.__X = {
  renderNoBookView, refreshNoBookBooks, effectiveBookBase, effectiveBook, spineOf,
  getState: () => ({ manualBook: _manualBook, freeMode: _freeMode, books: _bookPickerList }),
};`
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(JS, 'utf8') + expose, ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, getById, calls: () => bookCalls }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const BOOKS = [
  { base: 'CB_aaaaaaaaaaaaaaaaaaaa', bookTitle: '静静的顿河 十四', updatedAt: Date.parse('2026-11-01') },
  { base: 'mia_8a66411378a3f8d9116f', bookTitle: '列宁：怎么办？', updatedAt: Date.parse('2026-10-20') },
]

test('无书时：书单直接列在界面上（不用先点按钮）', async () => {
  const { X, getById } = loadSidebar({ books: BOOKS })
  X.renderNoBookView()
  await flush()
  assert.equal(getById('no-book-view').hidden, false, '无书界面可见')
  assert.equal(getById('msgs').style.display, 'none', '消息区让位给无书界面')
  const list = getById('nb-list')
  assert.equal(list.children.length, 2, '两本已读书籍各占一条')
  assert.ok(list.children[0]._html.includes('静静的顿河'), '第一条就是最近更新的那本')
  assert.equal(getById('nb-books-count').textContent, '2', '小标题旁的数量')
  assert.equal(getById('nb-books-count').hidden, false, '有书就显示数量')
})

test('点一条 → 切到这本书的手动查看，无书界面收起', async () => {
  const { X, getById } = loadSidebar({ books: BOOKS })
  X.renderNoBookView()
  await flush()
  const first = getById('nb-list').children[0]
  first.dispatch('click')
  await flush()
  assert.equal(X.effectiveBookBase(), BOOKS[0].base, '上下文切到点的那本书')
  assert.equal(X.getState().manualBook.bookTitle, '静静的顿河 十四', '进入手动查看（头部会显示书名）')
  assert.equal(getById('no-book-view').hidden, true, '无书界面收起')
  assert.equal(getById('msgs').style.display, '', '消息区回来显示这本书的历史记录')
})

test('搜索框只在书多时出现（书少时白占一行）', async () => {
  const few = loadSidebar({ books: BOOKS })
  few.X.renderNoBookView()
  await flush()
  assert.equal(few.getById('nb-search').hidden, true, '2 本书不显示搜索框')

  const many = loadSidebar({ books: [...BOOKS, ...BOOKS, ...BOOKS, ...BOOKS] })
  many.X.renderNoBookView()
  await flush()
  assert.equal(many.getById('nb-search').hidden, false, '8 本书显示搜索框')
})

test('本机服务没起来：说明 + 「重试」，重试后书单能起来', async () => {
  const { X, getById } = loadSidebar({ books: BOOKS, failFirst: 1 })
  X.renderNoBookView()
  await flush()
  const msg = getById('nb-empty')
  assert.equal(msg.hidden, false, '书单位置显示说明')
  assert.match(msg.innerHTML, /读不到已读书籍/, '一句话说清出了什么事')
  assert.match(msg.innerHTML, /请确认 CoRead 已启动/, '提示先确认本机服务已启动')
  assert.match(msg.innerHTML, /重试/, '给一个重试按钮')
  assert.equal(getById('nb-list').hidden, true, '书单让位给说明')

  await X.refreshNoBookBooks()   // 等于用户点了「重试」（按钮的点击处理就是它）
  await flush()
  assert.equal(getById('nb-list').children.length, 2, '重试后书单起来了')
  assert.equal(getById('nb-empty').hidden, true, '说明收起')
})

test('书脊色块：颜色按书 ID 固定，中文取首字、西文取头两个字母', async () => {
  const { X, getById } = loadSidebar({ books: BOOKS })
  X.renderNoBookView()
  await flush()
  const first = getById('nb-list').children[0]
  const m = /class="book-spine" style="background:(#[0-9a-f]{6})">([^<]*)</.exec(first._html)
  assert.ok(m, '每行前面有一枚书脊色块')
  assert.equal(m[2], '静', '中文书名取首字')
  assert.equal(X.spineOf(BOOKS[0]).color, m[1], '同一本书每次取到同一个颜色')
  assert.equal(X.spineOf({ base: BOOKS[0].base, bookTitle: '改过名的书' }).color, m[1],
    '改名不换色（颜色按书 ID 取）')
  assert.equal(X.spineOf({ base: 'x'.repeat(16), bookTitle: 'Theories of German Fascism' }).text, 'Th',
    '西文取头两个字母（一个字母认不出是哪本）')
})

test('旧交互不许退回：无书界面不再有「从已读书籍中选择」按钮', () => {
  const { getById } = loadSidebar({ books: BOOKS })
  assert.equal(getById('nb-pick-btn'), null, '那个按钮（以及多余的这一次点击）已经拿掉')
})
