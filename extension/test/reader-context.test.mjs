/**
 * 后台侧的两条"当前在读哪本书"规矩（2026-11 二次改版）。
 *
 * 为什么单独测它们：这两条判断决定了**侧栏什么时候把当前书清空**，而清错的代价是
 * 用户看到"界面跳回选书界面"（2026-11 反复踩过）。它们都是纯逻辑，能在 node 里直接跑：
 *
 *   ① `activeTabKind(url)`   —— 活动标签页属于哪一类页面（**只看 URL**，问不倒的事实）；
 *   ② `readerSync` 随附的 `fromActive` —— 这份阅读器快照是不是活动标签页推上来的。
 *
 * 运行：node extension/test/reader-context.test.mjs
 *      （已挂进 package.json 的 `npm run test:ext`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { activeTabKind, installTranslateBackground, refContextOf } from '../translate-background.js'

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

/** 装一个够用的 chrome 替身，并把后台的消息监听器抓出来 */
function setupBackground({ active = true, getThrows = false } = {}) {
  const state = { broadcast: [], listener: null }
  globalThis.chrome = {
    commands: { onCommand: { addListener() {} } },
    tabs: {
      get: async (id) => {
        if (getThrows) throw new Error('标签页已经不在了')
        return { id, active }
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => { state.listener = fn } },
      // 后台广播（阅读器 → 侧栏）：替身把每条都记下来
      sendMessage: async (msg) => { state.broadcast.push(msg) },
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
