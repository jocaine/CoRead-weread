/**
 * 后台侧的两条"当前在读哪本书"规矩（2026-11 二次改版）。
 *
 * 为什么单独测它们：这两条判断决定了**侧栏什么时候把当前书清空**，而清错的代价是
 * 用户看到"界面跳回选书界面"（2026-11 反复踩过）。它们都是纯逻辑，能在 node 里直接跑：
 *
 *   ① `activeTabKind(url)`   —— 活动标签页属于哪一类页面（**只看 URL**，问不倒的事实）；
 *   ② `readerSync` 随附的 `fromActive` —— 这份阅读器快照是不是活动标签页推上来的；
 *   ③ `pickLastTab` / `readerContextQuery.lastReader` —— 活动标签页是无关网页时，
 *      后台带回"最后那个阅读器标签页"的书（2026-10-27）。
 *
 * 运行：node extension/test/reader-context.test.mjs
 *      （已挂进 package.json 的 `npm run test:ext`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { activeTabKind, installTranslateBackground, pickLastTab, refAnchorsOf, refContextOf } from '../translate-background.js'

const WEREAD_BOOK_URL = 'https://weread.qq.com/web/reader/ce0321c0722b4a5d9f7b0c1e2d3f4a5b'
const WEREAD_BOOK_K_URL = WEREAD_BOOK_URL + 'k06432b4029e064096632ab8'   // 带章节目录后缀（真实形态）

// ── ① 活动标签页的分类 ────────────────────────────────────────────────────────

test('微读的书页（/web/reader/<书 ID>）认得出，带 k 章节后缀也算', () => {
  assert.equal(activeTabKind(WEREAD_BOOK_URL), 'weread-book')
  assert.equal(activeTabKind(WEREAD_BOOK_K_URL), 'weread-book')
})

test('微读的其它页（书架 / 详情 / 搜索）不是书页 —— 侧栏据此回到无书界面', () => {
  for (const u of [
    'https://weread.qq.com/web/shelf',
    'https://weread.qq.com/web/bookDetail/ce0321c0722b4a5d9f7b0c1e2d3f4a5b',
    'https://weread.qq.com/web/search/books?keyword=x',
    'https://weread.qq.com/',
  ]) {
    assert.equal(activeTabKind(u), 'weread', u + ' 被当成书页了 → 侧栏会认一本根本不存在的书')
  }
})

test('文库类网页阅读源是 page，别的网页是 other —— 两者都算"不在读书"', () => {
  assert.equal(activeTabKind('https://www.marxists.org/chinese/marx/01.htm'), 'page')
  assert.equal(activeTabKind('https://www.bilibili.com/video/BV1xx'), 'page')
  for (const u of [
    'https://news.qq.com/a/20261101',
    'chrome://extensions/',
    'about:blank',
    'chrome-extension://test/selfcheck.html',
  ]) {
    assert.equal(activeTabKind(u), 'other', u + ' 应当按"读不相干的页面"处理')
  }
})

test('拿不到活动标签页时是 unknown —— 侧栏据此**什么都不做**，绝不误清', () => {
  assert.equal(activeTabKind(''), 'unknown')
  assert.equal(activeTabKind(null), 'unknown')
  assert.equal(activeTabKind(undefined), 'unknown')
})

// ── ② 阅读器快照随附的 fromActive ────────────────────────────────────────────

/** 活动标签页的默认替身：一个跟阅读无关的网页（用户去聊天窗口/查资料时的场景） */
const NEWS_TAB = { id: 9, windowId: 1, url: 'https://news.qq.com/a/20261101' }

/** 装一个够用的 chrome 替身，并把后台的消息监听器抓出来 */
function setupBackground({
  active = true,
  getThrows = false,
  activeTab = NEWS_TAB,
  readerTabs = [],
  wereadTabs = [],
  bookInfo = {},
} = {}) {
  const state = { broadcast: [], listener: null, queries: [], sent: [] }
  globalThis.chrome = {
    commands: { onCommand: { addListener() {} } },
    tabs: {
      get: async (id) => {
        if (getThrows) throw new Error('标签页已经不在了')
        return { id, active }
      },
      // 后台只会问这几类（见 translate-background.js）：
      //   { active: true }      → 活动标签页
      //   { url: reader.html* } → 开着的阅读器标签页
      //   { url: weread book }  → 微读书页（只用来比"最后在读的是不是 PDF"）
      query: async (q) => {
        state.queries.push(q)
        if (q && q.active) return activeTab ? [activeTab] : []
        const u = String((q && q.url) || '')
        if (u.includes('reader.html')) return readerTabs
        if (u.includes('weread.qq.com/web/reader')) return wereadTabs
        return []
      },
      sendMessage: async (id, msg) => {
        state.sent.push({ id, msg })
        if (!msg || msg.action !== 'readerBookInfo') return undefined
        const v = bookInfo[id]
        if (v instanceof Error) throw v
        return v
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => { state.listener = fn } },
      // 后台广播（阅读器 → 侧栏）：替身把每条都记下来
      sendMessage: async (msg) => { state.broadcast.push(msg) },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
  }
  installTranslateBackground()
  assert.ok(state.listener, '后台没注册消息监听器')
  return state
}

/** 像浏览器那样投一条消息给后台，并等它的答复（sendResponse） */
function tell(state, msg, sender) {
  return new Promise((resolve) => {
    state.listener(msg, sender || {}, resolve)
  })
}

const snapshotMsg = { action: 'readerSync', snapshot: { book: null, notify: true } }

test('阅读器推快照：标签页在后台 → fromActive:false（侧栏据此不切当前书）', async () => {
  const s = setupBackground({ active: false })
  const r = await tell(s, snapshotMsg, { tab: { id: 5 } })
  assert.deepEqual(r, { ok: true })
  const upd = s.broadcast.find((m) => m.action === 'readerUpdate')
  assert.ok(upd, '后台没有把快照广播给侧栏')
  assert.equal(upd.fromActive, false, '后台标签页推的快照被当成了活动标签页 → 侧栏会被没在看的书顶掉')
})

test('阅读器推快照：标签页就是当前这个 → fromActive:true', async () => {
  const s = setupBackground({ active: true })
  await tell(s, snapshotMsg, { tab: { id: 5 } })
  const upd = s.broadcast.find((m) => m.action === 'readerUpdate')
  assert.equal(upd.fromActive, true)
})

test('查不到标签页状态时退回消息自带的 active；两者都没有 → null（侧栏按"就当它是"处理）', async () => {
  const s = setupBackground({ getThrows: true })
  await tell(s, snapshotMsg, { tab: { id: 5, active: false } })
  assert.equal(s.broadcast.find((m) => m.action === 'readerUpdate').fromActive, false,
    'tabs.get 失败时应退回 sender.tab.active')

  s.broadcast.length = 0
  await tell(s, snapshotMsg, { tab: { id: 5 } })
  assert.equal(s.broadcast.find((m) => m.action === 'readerUpdate').fromActive, null,
    '两条路都问不出来时如实报 null，不能凭空说"它在后台"')
})

test('不是从标签页来的快照（扩展页面自己发的）→ fromActive:null，照旧采纳', async () => {
  const s = setupBackground()
  await tell(s, snapshotMsg, {})
  assert.equal(s.broadcast.find((m) => m.action === 'readerUpdate').fromActive, null)
})

// ── ③ 最后一个阅读器标签页（2026-10-27）────────────────────────────────────
// 用户从 PDF 切到无关网页（聊天窗口/查资料）时，侧栏不再回首页，而是显示"最后那个
// 阅读器标签页"的对话。后台只负责把事实带回去，用不用由侧栏决定。

const READER_BOOK = { bookId: 'rd_0123456789abcdef', hash: '0123456789abcdef', name: '第一次共读' }

test('pickLastTab：优先取最近用过的那一个（lastAccessed 压过标签栏位置）', () => {
  assert.equal(pickLastTab([
    { id: 1, index: 5, lastAccessed: 1000 },
    { id: 2, index: 1, lastAccessed: 3000 },
  ]).id, 2)
})

test('pickLastTab：老 Chrome 没有 lastAccessed → 取标签栏最右（index 最大）', () => {
  assert.equal(pickLastTab([
    { id: 1, index: 0 },
    { id: 2, index: 4 },
    { id: 3, index: 2 },
  ]).id, 2)
  assert.equal(pickLastTab([]), null)
  assert.equal(pickLastTab(null), null)
})

test('活动标签页是无关网页：带回最后那个阅读器标签页的书，并且只问它', async () => {
  const s = setupBackground({
    readerTabs: [
      { id: 3, windowId: 1, index: 2, lastAccessed: 1000 },
      { id: 7, windowId: 1, index: 5, lastAccessed: 2000 },
    ],
    bookInfo: { 7: { ok: true, book: READER_BOOK } },
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q1' })
  assert.equal(r.req, 'q1')
  assert.equal(r.activeKind, 'other')
  assert.deepEqual(r.lastReader, { tabId: 7, book: READER_BOOK })
  assert.deepEqual(s.sent.map((x) => x.id), [7], '只该问最后那个阅读器标签页')
})

test('"最后"取最近用过的那个，不是标签栏最右的', async () => {
  const s = setupBackground({
    readerTabs: [
      { id: 3, windowId: 1, index: 5, lastAccessed: 1000 },  // 更靠右，但更久没碰
      { id: 7, windowId: 1, index: 2, lastAccessed: 2000 },  // 最近用过
    ],
    bookInfo: { 7: { ok: true, book: READER_BOOK } },
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q2' })
  assert.equal(r.lastReader.tabId, 7)
})

test('阅读器标签页在别的窗口 → 不算（侧栏按窗口挂）', async () => {
  const s = setupBackground({
    readerTabs: [{ id: 7, windowId: 2, index: 5, lastAccessed: 3000 }],
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q3' })
  assert.equal(r.lastReader, undefined)
  assert.equal(s.sent.length, 0)
})

test('最后在读的是微读书页 → 不回落 PDF（防后台 PDF 抢微读会话）', async () => {
  const s = setupBackground({
    readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 1000 }],
    wereadTabs: [{ id: 8, windowId: 1, index: 6, lastAccessed: 2000, url: WEREAD_BOOK_URL }],
    bookInfo: { 7: { ok: true, book: READER_BOOK } },
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q4' })
  assert.equal(r.lastReader, undefined)
  assert.equal(s.sent.length, 0, '微读更新时不该再去问 PDF')
})

test('微读书页比阅读器更旧 → 仍显示 PDF（只否定"最后在读的是微读"）', async () => {
  const s = setupBackground({
    readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 2000 }],
    wereadTabs: [{ id: 8, windowId: 1, index: 6, lastAccessed: 1000, url: WEREAD_BOOK_URL }],
    bookInfo: { 7: { ok: true, book: READER_BOOK } },
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q4b' })
  assert.equal(r.lastReader.tabId, 7)
})

test('活动标签页是微读书页：走原规则，不探阅读器', async () => {
  const s = setupBackground({
    activeTab: { id: 9, windowId: 1, url: WEREAD_BOOK_URL },
    readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 9999 }],
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q5' })
  assert.equal(r.activeKind, 'weread-book')
  assert.equal(r.lastReader, undefined)
  assert.equal(s.sent.length, 0)
})

test('阅读器明确说没开书 → 不带 lastReader（侧栏照旧回首页）', async () => {
  const s = setupBackground({
    readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 1000 }],
    bookInfo: { 7: { ok: true, book: null } },
  })
  const r = await tell(s, { action: 'readerContextQuery', req: 'q6' })
  assert.equal(r.lastReader, undefined)
})

test('阅读器答不上来（加载中 / 答非所问 / 消息失败）→ 带 unknown，侧栏保持当前书', async () => {
  const cases = [
    { ok: true, loading: true, book: null },
    {},                              // 答非所问：没有 ok:true
    new Error('页面已经不在了'),
    undefined,
  ]
  for (const info of cases) {
    const s = setupBackground({
      readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 1000 }],
      bookInfo: { 7: info },
    })
    const r = await tell(s, { action: 'readerContextQuery', req: 'q6b' })
    assert.deepEqual(r.lastReader, { tabId: 7, unknown: true })
  }
})

test('阅读器 500ms 不应答（被冻结）→ 带 unknown，且不把侧栏的上下文刷新挂住', async () => {
  const s = setupBackground({
    readerTabs: [{ id: 7, windowId: 1, index: 5, lastAccessed: 1000 }],
    bookInfo: { 7: new Promise(() => {}) },   // 永远不 resolve
  })
  const t0 = Date.now()
  const r = await tell(s, { action: 'readerContextQuery', req: 'q6c' })
  assert.deepEqual(r.lastReader, { tabId: 7, unknown: true })
  assert.ok(Date.now() - t0 >= 450, '没等到超时就返回了，说明超时逻辑没生效')
})

// ── refContextOf：这次引用该带什么上下文（2026-11 扫描件带整卡译文）────────────

test('refContextOf：调用方给了上下文就用它（并去掉首尾空白）', () => {
  assert.equal(refContextOf({ context: '  整页译文  ' }), '整页译文')
})

test('refContextOf：扫描件没给上下文 → 退成"说清缺什么"的说明', () => {
  const out = refContextOf({ image: true, original: '' })
  assert.match(out, /扫描件/)
  assert.match(out, /没有可提取的文字层/)
})

test('refContextOf：文字引用没给上下文 → 空串（不塞一句多余说明）', () => {
  assert.equal(refContextOf({ original: '原句' }), '')
})

test('refContextOf：上限放宽到 4000，一张整页译文卡不被切掉', () => {
  // 2500 字（旧上限 2000 会切掉尾巴）：这张卡必须完整通过
  const card = '译'.repeat(2500)
  assert.equal(refContextOf({ context: card, image: true }).length, 2500)
  // 超过 4000 才切
  assert.equal(refContextOf({ context: 'x'.repeat(5000) }).length, 4000)
})

// ── refAnchorsOf：这条引用落在书里哪一处（跳引用靠它，不是按文字猜）────────────
// 现场：把《置身事内》的 PDF 抽成文本，「全国预算收入」在第 56 页与第 58 页各一遍。
// 用户划的是第 58 页那一处；存档里带上锚点，跳回去才不会落到第 56 页。

test('refAnchorsOf：阅读器报上来的锚点原样保留（转成整数）', () => {
  assert.deepEqual(
    refAnchorsOf({ anchors: [{ page: 58, start: 251, end: 257 }] }),
    [{ page: 58, start: 251, end: 257 }],
  )
  // 跨页引用有多段，按顺序保留
  assert.deepEqual(
    refAnchorsOf({ anchors: [{ page: 3, start: 10, end: 30 }, { page: 4, start: 0, end: 12 }] }).map((a) => a.page),
    [3, 4],
  )
  // 浮点 / 字符串也认（上游偶尔给 number 的字符串形态）
  assert.deepEqual(refAnchorsOf({ anchors: [{ page: '58', start: 251.9, end: '257' }] }),
    [{ page: 58, start: 251, end: 257 }])
})

test('refAnchorsOf：坏锚点丢掉，别让阅读器拿着荒唐页号去跳', () => {
  const out = refAnchorsOf({
    anchors: [
      { page: 0, start: 1, end: 2 },       // 页号从 1 起
      { page: 58, start: 9, end: 9 },      // end <= start：框不住东西
      { page: 58, start: -1, end: 5 },     // 偏移为负
      { page: 'x', start: 1, end: 2 },     // 页号不是数
      null,
      { page: 58, start: 251, end: 257 },  // 唯一好的那条
    ],
  })
  assert.deepEqual(out, [{ page: 58, start: 251, end: 257 }])
})

test('refAnchorsOf：没有锚点（老数据 / 扫描件）→ 空数组，不补默认值', () => {
  assert.deepEqual(refAnchorsOf({}), [])
  assert.deepEqual(refAnchorsOf({ anchors: [] }), [])
  assert.deepEqual(refAnchorsOf({ anchors: 'not-an-array' }), [])
  assert.deepEqual(refAnchorsOf(null), [])
})

test('refAnchorsOf：最多留 8 段（再多只可能是上游出错）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ page: i + 1, start: 0, end: 4 }))
  assert.equal(refAnchorsOf({ anchors: many }).length, 8)
})
