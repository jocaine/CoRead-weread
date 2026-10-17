#!/usr/bin/env node
/**
 * PDF 阅读器入口从工具箱提到「⋯」菜单顶层（2026-11）
 *
 * 起因（用户提问）："PDF 阅读器放在工具箱内部这个不显眼的位置是否合适"。
 * 判断是**分类错了**——工具箱收的是配置类东西（翻译开关、快捷键、模型覆盖），
 * 而阅读器是一个页面入口，而且那条路要走四步、路上没有一个字写着"读"。
 * 于是两处改动：
 *   ① 「⋯」菜单顶层新增 `#mm-reader`（点一下**直接弹出选文件**）；
 *   ② 工具箱里那个「阅读器」tab 连按钮一起删掉（留着就是两套入口，又回到"到底该点哪个"）。
 *
 * 这个文件锁住的正是这两条 —— 用真 sidebar.js 跑在 DOM 替身上，点给用户看的那两个
 * 控件，断言真的开了阅读器标签页、且 URL 带 `?pick=1`（不带的话用户落地还得自己再点一次）。
 *
 * ⚠️ 为什么单独一个文件、不复用 agent/test 里那几个 sidebar 测试的 loadSidebar：
 * 那几份各自内联了一套替身（这是本仓库的既有做法，见 sidebar-free-conv.test.js），
 * 复制一份比抽公共模块改动面小。也**故意不放进 agent/test**：`npm test` 跑的是
 * `node --test` 整目录，而 **DSH 的沙箱里 node 测试运行器 spawn 子进程会 EPERM**，
 * 整个套件本来就跑不起来；扔进去只会让"新加的这条"看起来永远不过。
 * 跑法：node agent/test/sidebar-reader-entry.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const HTML = path.join(ROOT, 'extension', 'sidebar.html')
const JS = path.join(ROOT, 'extension', 'sidebar.js')

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
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev || {}) },
    click(t) { this.dispatch('click', { target: this, stopPropagation() {}, preventDefault() {} }) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    append(...cs) { for (const c of cs) this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    replaceChildren() { this.children = [] },
    querySelector() { return makeEl() },
    querySelectorAll() { return [] },
    setAttribute() {}, getAttribute() { return null },
    focus() {}, select() {}, setSelectionRange() {}, click_() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 } },
    closest() { return null }, contains() { return false },
  }
  return el
}

function buildDom() {
  const html = fs.readFileSync(HTML, 'utf8')
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const cache = new Map()
  const getById = (id) => {
    if (!ids.has(id)) return null
    if (!cache.has(id)) cache.set(id, makeEl(id))
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
    removeEventListener(t, fn) { this._h[t] = (this._h[t] || []).filter((f) => f !== fn) },
    dispatch(t, ev) { for (const f of (this._h[t] || []).slice()) f(ev || {}) },
  }
  return { doc, getById, ids }
}

/**
 * 装载侧栏：真 sidebar.js + DOM 替身。tabsCreated 收 `chrome.tabs.create` 的入参。
 * @param {{booksFail?: boolean}} [opts] booksFail = `/books` 返回非 200（模拟本机服务没起来）
 */
function loadSidebar({ booksFail = false } = {}) {
  const { doc, getById, ids } = buildDom()
  const tabsCreated = []

  const fetchStub = async (url) => {
    const u = String(url)
    // `/books` 失败要**抛**，不能返回 `{ok:false}` —— 真实现（sidebar.js 的 loadBooks）
    // 只用 try/catch 判失败，拿不到非 200 这件事。用 `{ok:false}` 糊过去的话，
    // `_booksFailed` 永远不置真，这条测试就成了"测得挺像、其实没验到"。
    if (booksFail && u.includes('/books')) throw new Error('fetch failed（模拟本机服务没起来）')
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const chromeStub = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      create: (opts) => { tabsCreated.push(opts); return Promise.resolve({ id: 1 }) },
      query: async () => [],
      sendMessage: async () => null,
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test',
    },
    commands: { getAll: async () => [] },
    permissions: { request: async () => true },
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

  const src = fs.readFileSync(JS, 'utf8')
  vm.createContext(ctx)
  vm.runInContext(src + '\n;globalThis.__X = { openReader, openReaderFrom, renderNoBookView, refreshNoBookBooks, loadBooks };', ctx, { filename: 'sidebar.js' })
  return { X: ctx.__X, getById, ids, tabsCreated }
}

// ── ① 菜单里那一项：点一下 = 开阅读器 + 直接弹选文件 ──────────────────────────
test('点「⋯ → 📕 PDF 阅读器」→ 开阅读器标签页，且带上 ?pick=1', () => {
  const { getById, tabsCreated } = loadSidebar()
  const item = getById('mm-reader')
  assert.ok(item, '菜单里必须有 #mm-reader（没有它这个入口就是空的）')
  item.click()
  assert.equal(tabsCreated.length, 1, '应该恰好开一个标签页')
  assert.equal(tabsCreated[0].url, 'chrome-extension://test/reader.html?pick=1',
    'URL 必须带 ?pick=1 —— 不带的话用户落地后还得自己再点一次「打开 PDF」')
  assert.equal(tabsCreated[0].active, true, '新标签页要切过去（否则用户以为没反应）')
})

// ── ② 无书界面那个按钮：同一条路 ──────────────────────────────────────────────
test('无书界面底部的「打开 PDF →」→ 同一条路（给手上只有 PDF 的人）', () => {
  const { getById, tabsCreated } = loadSidebar()
  const btn = getById('nb-reader-btn')
  assert.ok(btn, '无书界面必须有 #nb-reader-btn')
  btn.click()
  assert.equal(tabsCreated.length, 1)
  assert.equal(tabsCreated[0].url, 'chrome-extension://test/reader.html?pick=1')
})

// ── ②b 版式：它是"底部一条"，文案给的是**判断**（2026-11 用户打回三次后定的）──
test('PDF 入口是底部常驻一条，文案"外文 PDF，用这里读"', () => {
  const html = fs.readFileSync(HTML, 'utf8')
  assert.ok(/<div id="nb-reader-bar" hidden>/.test(html), '必须有 #nb-reader-bar（底部那条）')

  /**
   * ⚠️ 只取**这一条的正文**来验文案，别扫整个文件：
   * ① 注释里为了讲清"为什么不用某句话"会把这些句子原样写上（设计记录的价值就在这儿），
   *    扫全文会把说明当成违规；
   * ② 断言也要按"整句"匹配——`也能读` 是 `也能直接打开` 的子串，
   *    用 includes 判否定会自相矛盾（这条真踩过）。
   */
  const block = /<div id="nb-reader-bar"[\s\S]*?<\/div>/.exec(html)
  assert.ok(block, '能取到 #nb-reader-bar 那一段')
  const bar = block[0].replace(/<!--[\s\S]*?-->/g, '')   // 去掉注释，只看真正显示的字

  assert.ok(bar.includes('外文 PDF，用这里读'),
    '左侧那句是"外文 PDF，用这里读"——说清**什么场景该用**，不是描述功能')
  assert.ok(bar.includes('打开 PDF →'), '按钮叫「打开 PDF →」（点了弹的是选文件，喊"阅读器"名不副实）')

  /**
   * 这一格被打回过三次，三种毛病都记在这儿，别让它们回来：
   *   ① 只陈述功能、用户不知道干什么 → "也可以直接读本地 PDF"
   *   ② 读起来在劝用户绕过微读（与"默认传进微读"的定位相反） → "不必先传进微信读书"
   *   ③ 没有主语、也没说什么时候该用 → "PDF 也能直接打开" / "本地 PDF 也能读"
   */
  for (const bad of ['也可以直接读本地', '不必先传进微信读书', '也能直接打开', '本地 PDF 也能读']) {
    assert.ok(!bar.includes(bad), `这条上不该出现「${bad}」（见这里的注释：它被打回过）`)
  }

  /**
   * 定位要成体系：**外文**用阅读器这条判断，必须在三个地方都说到，
   * 因为用户在不同时刻看的是不同的一屏（侧栏那条 / 阅读器里 / 课上）。
   *
   * ⚠️ 阅读器那一处**不在 reader.html 里**，而是 reader.js 的 renderEmptyNote 按状态填的
   * （2026-11 改版）——所以这里读的是 reader.js。别再回 HTML 里找那句话。
   */
  const readerJs = fs.readFileSync(path.join(ROOT, 'extension', 'reader.js'), 'utf8')
  assert.ok(readerJs.includes('function renderEmptyNote'), 'reader.js 里要有 renderEmptyNote')
  assert.ok(readerJs.includes('外文 PDF 用这里读最顺'), '那句场景说明要在 reader.js 里')
  assert.ok(/function renderEmptyNote[\s\S]{0,1400}hidden = true/.test(readerJs),
    'renderEmptyNote 要有"不该说话时闭嘴"的分支（书库还在读的时候）')
  const lessons = fs.readFileSync(path.join(ROOT, 'extension', 'tutorial', 'lessons.js'), 'utf8')
  assert.ok(lessons.includes('读外文'), '教程第 6 课要说"读外文建议用这个阅读器"')

  // 条子必须落在 #no-book-view 里（它是无书界面的一格），不能飘在外面
  const view = html.indexOf('id="no-book-view"')
  const at = html.indexOf('id="nb-reader-bar"')
  const footer = html.indexOf('id="footer"')
  assert.ok(view > -1 && at > view && at < footer, '#nb-reader-bar 要落在 #no-book-view 里',
    `view=${view} bar=${at} footer=${footer}`)
  // 旧版那枚钉在状态卡里的按钮与它的小字提示都不该还在
  assert.ok(!html.includes('nb-reader-hint'), '旧版那行小字提示已下线')
})

// ── ②c 底部那一格与「输入框」互斥，且服务挂了要反过来 ─────────────────────────
test('无书时：藏输入框、露 PDF 条', () => {
  const { X, getById } = loadSidebar()
  X.renderNoBookView()
  assert.equal(getById('footer').hidden, true, '无书时输入框整条让位')
  assert.equal(getById('nb-reader-bar').hidden, false, 'PDF 条顶上来')
})

test('本机服务没起来时：留住输入框、收起 PDF 条（该看见的是故障本身）', async () => {
  const { X, getById } = loadSidebar({ booksFail: true })
  X.renderNoBookView()
  await X.loadBooks(true)           // 等价于"书单拉了一次、失败了"
  X.renderNoBookView()              // 重画这一格（切上下文 / 重试都会走到）
  assert.equal(getById('nb-reader-bar').hidden, true,
    '本机服务没起来时那枚 PDF 按钮点了只会报错，不该占着底部')
  assert.equal(getById('footer').hidden, false, '这时底部要留着输入框那格（它写着"请打开微信读书中的书"）')
})

// ── ③ 不点按钮就不开页（别在装载时自己弹一个标签页出来）──────────────────────
test('装载侧栏本身不许开阅读器标签页', () => {
  const { tabsCreated } = loadSidebar()
  assert.equal(tabsCreated.length, 0)
})

// ── ④ 旧入口必须清干净（留着就是两套入口，用户又得猜该点哪个）────────────────
test('工具箱里不再有阅读器 tab / 页面 / 按钮', () => {
  const html = fs.readFileSync(HTML, 'utf8')
  assert.ok(!html.includes('data-tab="reader"'), '工具箱不该还有「阅读器」tab')
  assert.ok(!html.includes('data-page="reader"'), '工具箱不该还有阅读器页')
  assert.ok(!html.includes('rd-open-btn'), '旧的 #rd-open-btn 不该还在（sidebar.js 已不再绑它）')
})

// ── ⑤ 侧栏不再绑一个不存在的按钮（"看起来接得上、其实没有入口"的假象）────────
test('sidebar.js 不再引用 rd-open-btn', () => {
  const js = fs.readFileSync(JS, 'utf8')
  assert.ok(!js.includes("getElementById('rd-open-btn')"), 'sidebar.js 里不该再绑 #rd-open-btn')
})

// ── ⑥ reader.js 那一半：?pick=1 的判据（纯逻辑，不依赖页面）──────────────────
test('reader.js 有 ?pick=1 的落地处理，且只认 pick=1', () => {
  const js = fs.readFileSync(path.join(ROOT, 'extension', 'reader.js'), 'utf8')
  assert.ok(/function handlePickParam\s*\(/.test(js), 'reader.js 必须有 handlePickParam')
  assert.ok(/searchParams\.get\('pick'\)\s*===\s*'1'/.test(js), '判据必须是 pick=1（不能是"有 pick 就行"）')
  assert.ok(/handlePickParam\(\)/.test(js), 'handlePickParam 必须被调用（定义了不调 = 没写）')
  assert.ok(/els\.file\s*&&\s*els\.file\.click\(\)/.test(js), '要点到真的 file input（点别处不会弹选择框）')
  // 只在没打开任何书时弹：复用标签页打开某一本时弹选择框是打扰
  assert.ok(/if \(state\.hash \|\| state\.tutorialOpen\) return false/.test(js),
    '缺"已经有书就不弹"的守卫')
})

// ── ⑦ 教程第 6 课讲的必须是新位置（它原来指的就是工具箱）─────────────────────
test('教程第 6 课的指路文案与高亮目标都改到了菜单顶层', () => {
  const js = fs.readFileSync(path.join(ROOT, 'extension', 'tutorial', 'lessons.js'), 'utf8')
  assert.ok(/readerItem:\s*'mm-reader'/.test(js), 'SEL 里要有 mm-reader')
  assert.ok(!/工具箱里有 PDF 阅读器/.test(js), '旧的那句"工具箱里有 PDF 阅读器"必须下线')
})
