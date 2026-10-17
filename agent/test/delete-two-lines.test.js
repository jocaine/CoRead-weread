#!/usr/bin/env node
/**
 * 删除的两条线，各删各的（2026-11 用户定调）
 *
 * ── 用户的模型（这份测试存在的全部理由）──────────────────────────────────────
 *   · 阅读器「书库」里的每一项 = **那个 PDF 原件**   → 删的是文件
 *   · 侧栏「会话 / 已读书籍」里的每一项 = **这本书的记录** → 删的是划线/讨论/聊天
 * 两个界面各自只删自己那一样。用户原话：
 *   "书库里的项应该只是指的原件，而会话里的项才对应这些记录"。
 *
 * ── 为什么必须钉住 ────────────────────────────────────────────────────────────
 * 我先前做反过一次：在侧栏点删除时弹"二选一"（只删记录 / 连原件一起删）。
 * 那等于把两样东西塞进一次选择，用户得先想清楚"我站的这个列表代表什么"——
 * 而这本来就该由界面替他定好。这次把它拆回两条各自独立的线。
 * 书库里那一项**没有**"要不要连记录一起删"的问题，因为它代表的就是文件。
 *
 * 跑法：node agent/test/delete-two-lines.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SIDEBAR_HTML = path.join(ROOT, 'extension', 'sidebar.html')
const SIDEBAR_JS = path.join(ROOT, 'extension', 'sidebar.js')
const READER_JS = path.join(ROOT, 'extension', 'reader.js')
const SIDEBAR_SRC = fs.readFileSync(SIDEBAR_JS, 'utf8')
const READER_SRC = fs.readFileSync(READER_JS, 'utf8')

function makeEl(id = '') {
  const el = {
    id, children: [], dataset: {}, style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    hidden: false, disabled: false, value: '', textContent: '', title: '', placeholder: '', type: '',
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev || {}) },
    click() { this.dispatch('click', { target: this, stopPropagation() {}, preventDefault() {} }) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    append(...cs) { for (const c of cs) this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() {}, replaceChildren() { this.children = [] },
    querySelector(sel) { return this._q(sel) },
    _q(sel) {
      const cls = String(sel).replace(/^\./, '')
      const walk = (n) => {
        for (const c of n.children || []) {
          if (String(c.className || '').split(/\s+/).includes(cls)) return c
          const hit = walk(c); if (hit) return hit
        }
        return null
      }
      return walk(this)
    },
    querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null }, focus() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
  return el
}

/** 装载侧栏；`posted` 收下所有 POST 的 {url, body} */
function loadSidebar() {
  const html = fs.readFileSync(SIDEBAR_HTML, 'utf8')
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const cache = new Map()
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) cache.set(id, makeEl(id))
    return cache.get(id)
  }
  const doc = {
    body: makeEl('body'), getElementById: getById, createElement: () => makeEl(),
    querySelector: () => makeEl(), querySelectorAll: () => [],
    _h: {}, addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn) },
    removeEventListener() {}, dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev || {}) },
  }
  const posted = []
  const fetchStub = async (url, opts = {}) => {
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    // 只记**删除类**请求：侧栏启动时会往 /debug 打一堆上报，那不是我们要验的东西
    if (opts.method === 'POST' && /(book-delete|reader-book-delete)/.test(u)) {
      posted.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null })
    }
    if (u.includes('/books')) return json({ books: [] })
    return json({})
  }
  const chromeStub = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => null, onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, create: async () => ({}) },
    runtime: { sendMessage: async () => ({ ok: true, notReader: true }), onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://test/' + p, id: 'test' },
    commands: { getAll: async () => [] }, permissions: { request: async () => true },
  }
  class ES { constructor() {} close() {} }
  const ctx = {
    document: doc, chrome: chromeStub, fetch: fetchStub, EventSource: ES, AbortController,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { try { fn && fn() } catch {} return 0 },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { href: 'chrome-extension://test/sidebar.html' }, navigator: { userAgent: 'node' },
    CoReadGraphView: undefined,
  }
  ctx.globalThis = ctx
  ctx.self = ctx
  vm.createContext(ctx)
  vm.runInContext(SIDEBAR_SRC + '\n;globalThis.__X = { buildBookItem, deleteBook };', ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, getById, posted }
}

const READER_BOOK = { base: 'rd_' + 'a'.repeat(64), bookTitle: '法西斯主义论文集.pdf', updatedAt: Date.now() }
const WEREAD_BOOK = { base: 'CB_aaaaaaaaaaaaaaaaaaaa', bookTitle: '静静的顿河', updatedAt: Date.now() }

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// ── 侧栏那条线：只删记录 ──────────────────────────────────────────────────────
test('确认后：侧栏对阅读器的书也只 POST /book-delete，绝不 POST /reader-book-delete', async () => {
  const { X, posted, getById } = loadSidebar()
  const p = X.deleteBook(READER_BOOK)
  await flush()                                  // 等确认框弹出来
  getById('confirm-ok-btn').dispatch('click')    // 点「确认删除」
  await p
  await flush()
  assert.equal(posted.length, 1, '只发了一次请求')
  assert.ok(posted[0].url.includes('/book-delete'), '打的是记录那条线')
  assert.ok(!posted[0].url.includes('reader-book-delete'), '绝不打原件那条线')
  assert.equal(posted[0].body.base, READER_BOOK.base, '带的是书 ID')
})

test('确认框的正文写明"原件留在阅读器书库里"（否则用户以为书没了）', async () => {
  const { X, getById } = loadSidebar()
  const p = X.deleteBook(READER_BOOK)
  await flush()
  const msg = getById('confirm-msg').textContent || ''
  assert.ok(msg.includes('原件'), '要提到原件，用户才知道它去哪了：' + msg)
  assert.ok(msg.includes('书库'), '要指明原件留在哪：' + msg)
  getById('confirm-cancel-btn').dispatch('click')   // 收掉弹窗，免得影响下一条
  await p
})

test('取消不发任何请求', async () => {
  const { X, posted, getById } = loadSidebar()
  const p = X.deleteBook(WEREAD_BOOK)
  await flush()
  getById('confirm-cancel-btn').dispatch('click')
  await p
  await flush()
  // ⚠️ 不断言 deleteBook 的返回值：它是"用户确认后才干活"的命令式函数，
  // 取消时提前 return（undefined），本来就不该有布尔语义——那是确认框的返回值，不是它的
  assert.equal(posted.length, 0, '取消 → 一个删除请求都不该发')
})

// ── 阅读器那条线：只删原件，且只对有原件的项给按钮 ────────────────────────────
test('阅读器的删除只打 /reader-book-delete，且不碰 /book-delete', () => {
  const m = /function deleteReaderBook\(b\)\s*\{([\s\S]*?)\n\}/.exec(READER_SRC)
  assert.ok(m, 'reader.js 里要有 deleteReaderBook')
  assert.ok(m[1].includes("'/reader-book-delete'"), '打原件那条线')
  assert.ok(!m[1].includes("'/book-delete'"), '不许顺手把记录也删了')
  assert.ok(/body: JSON\.stringify\(\{ hash: b\.hash \}\)/.test(m[1]), '带的是 hash（原件按内容哈希存）')
})

test('书库里每一项都有删除按钮，不按"有没有文件"分叉（没文件的项压根不列）', () => {
  // ⚠️ 这条盯的是一个走弯路的教训（用户报"书库里有一个 sample.pdf 无法删除"）：
  // 先后试过"列出来但点不动"和"列出来并给一个清记录的按钮"，用户都否了。
  // 现在规则只有一条：**原件不在就不列**（见下一条），所以这里不需要任何 hasFile 判断。
  const m = /if \(!b\.isTutorial\) \{([\s\S]*?)\n    \}/.exec(READER_SRC)
  assert.ok(m, '阅读器书库要有"给删除按钮"的判断')
  assert.ok(!/hasFile/.test(m[1]), '这个判断里不该出现 hasFile：没有文件的项不会列出来')
  assert.ok(m[1].includes('rd-lib-del'), '里面建的就是那个删除按钮')
  assert.ok(/deleteReaderBook\(b\)/.test(m[1]), '点了调 deleteReaderBook')
})

test('删除确认框只说一件事（不再分"有文件 / 没文件"两种说法）', () => {
  const m = /function deleteReaderBook\(b\)\s*\{([\s\S]*?)\n\}/.exec(READER_SRC)
  assert.ok(m, 'reader.js 里要有 deleteReaderBook')
  assert.ok(!/hasFile/.test(m[1]), '不该再有 hasFile 分支：没有文件就没有这一项')
  assert.ok(m[1].includes('从书库删除'), '文案就是"从书库删除"')
})

test('列表端：原件不在就不列、并清掉那份记录（用户定调"没有就是没有了"）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'receiver', 'index.js'), 'utf8')
  const m = /if \(size === 0\) \{([\s\S]*?)\n    \}/.exec(src)
  assert.ok(m, 'listReaderBooks 里要有"原件不在"的处理')
  assert.ok(m[1].includes('rmSync'), '要把那份 reader-meta.json 清掉，别留着')
  assert.ok(m[1].includes('continue'), '清完不要把它放进列表')
  // 规则要单一：不许再加"名字是不是兜底名"这种附加条件（那正是上一版的弯路）
  assert.ok(!/size === 0 && /.test(src), '判据只该是 size === 0，别再 && 别的条件')
})

test('阅读器的删除弹窗只有两个答案（没有"另一项"这种第三按钮）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'extension', 'reader.html'), 'utf8')
  // ⚠️ 不能用"数两个闭合标签"的正则找这一段：弹窗里有嵌套 div（box / msg / actions 各一层），
  // 那样会在第一个能凑上的地方提前收尾、把 actions 截掉（这条当场踩过：实得 3 个按钮其实是对的，
  // 是正则骗了我）。改成从 overlay 起到下一个空行为止。
  const start = html.indexOf('<div id="rd-del-overlay"')
  assert.ok(start > -1, 'reader.html 里要有删除弹窗')
  const end = html.indexOf('</div>\n\n', start)
  const block = html.slice(start, end > start ? end : start + 1200)
  const btns = [...block.matchAll(/class="rd-del-btn[^"]*"/g)].map((x) => x[0])
  assert.equal(btns.length, 2, '只该有取消 + 删除两个按钮，实得：' + btns.join(' / '))
  assert.ok(!block.includes('rd-del-alt'), '第三按钮要连结构一起删掉，不留死代码')
})

test('侧栏的确认框也回到两个按钮（不许再长出第三选项）', () => {
  const html = fs.readFileSync(SIDEBAR_HTML, 'utf8')
  assert.ok(!html.includes('confirm-alt'), '侧栏确认框不该有第三个按钮')
  assert.ok(!/altText|altValue/.test(SIDEBAR_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'showConfirm 不该再有 altText/altValue 参数（撤干净，别留半截）')
})

test('改名保护与"清记录"各管各的，共用同一个判据函数（别再各写一套）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'receiver', 'index.js'), 'utf8')
  const uses = [...src.matchAll(/isRealBookName\(/g)].length
  // 用途：定义 1 处 + 写入端"兜底名不许覆盖真名"（判 prev、判 patch 各一次）。
  // 列表端**不用它**了——那条规则只剩"原件在不在"（见上面那条测试）。
  assert.ok(uses >= 3, 'isRealBookName 该有定义 + 写入端两处使用，实得 ' + uses)
})

test('receiver 的两条删除接口都还在（这次只改界面，没动后端语义）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'receiver', 'index.js'), 'utf8')
  assert.ok(src.includes("url === '/book-delete'"), '/book-delete 在')
  assert.ok(src.includes("url === '/reader-book-delete'"), '/reader-book-delete 在')
})
