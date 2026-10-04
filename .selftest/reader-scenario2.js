/**
 * 第二段场景：刷新页面后重跑 —— 验证「关掉再打开，译文还贴在原来那段文字上」。
 *
 * 阅读数据在真实扩展页面里落 chrome.storage.local，在自测页面里落 localStorage 替身，
 * 两种都读，断言一致。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(120)
  }
  return false
}

const out = { checks: [], errors: [] }
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail })
  return !!ok
}
out.context = location.href

// 刷新之后 window.chrome 没了（自测页面），重新装一份替身
if (!(window.chrome && window.chrome.storage && window.chrome.storage.local)) {
  window.__stubbedStorage = true
  window.__sent = []
  window.chrome = {
    storage: { local: {
      async get(key) {
        if (key === null) {
          const all = {}
          for (const k of Object.keys(localStorage)) { try { all[k] = JSON.parse(localStorage.getItem(k)) } catch {} }
          return all
        }
        const k = typeof key === 'string' ? key : Object.keys(key)[0]
        const raw = localStorage.getItem(k)
        return raw ? { [k]: JSON.parse(raw) } : {}
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v)) },
    } },
    runtime: { sendMessage: async (msg) => { window.__sent.push(msg); return { ok: true } } },
  }
}

/** 取全部阅读记录（两种存储通用） */
async function allRecords() {
  if (!window.__stubbedStorage && window.chrome && chrome.storage && chrome.storage.local) {
    const all = await chrome.storage.local.get(null)
    return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('rd:book:')))
  }
  const out2 = {}
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('rd:book:')) out2[k] = JSON.parse(localStorage.getItem(k))
  }
  return out2
}

try {
  // 读回第一段场景存下的记录
  const records = await allRecords()
  const keys = Object.keys(records)
  check('上一轮确实存下了记录', keys.length === 1, JSON.stringify(keys.map((k) => k.slice(0, 16) + '…')))
  const rec = keys.length ? records[keys[0]] : null
  check('记录里有译文与锚点', !!(rec && rec.entries && rec.entries.length === 1 && rec.entries[0].anchors.length === 1),
    rec && JSON.stringify({ page: rec.page, scale: rec.scale, n: rec.entries && rec.entries.length }))

  // 用同一份文件重新打开：哈希一致才会命中同一条记录
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await window.__readerTest.openBytes(bytes, 'sample.pdf')
  const T = window.__readerTest

  check('重新打开后译文被恢复', T.state.entries.length === 1, T.state.entries.length)
  const e = T.state.entries[0]
  check('恢复的译文内容一致', !!(e && /【译】/.test(e.translation || '')), e && e.translation)

  // 等这一页渲染出来，然后确认锚点真的解析回了原文位置
  await waitFor(() => T.state.pages[1] && T.state.pages[1].rendered, 12000)
  T.refreshHighlights()
  const rects = T.anchorRects()
  const r = rects[0] && rects[0].rects[0]
  check('恢复的锚点能解出屏幕矩形', !!r, JSON.stringify(r))
  check('高亮重新画上了', !!(window.CSS && CSS.highlights && CSS.highlights.has('rd-src')))

  const text = T.anchorsText([{ page: e.anchors[0].page, start: e.anchors[0].start, end: e.anchors[0].end }])
  check('解析回来的正是当初那段原文', /^Reading foreign literature/.test(text), text.slice(0, 60))

  if (r) {
    const page = T.state.pages[e.anchors[0].page - 1]
    const pr = page.wrap.getBoundingClientRect()
    check('矩形落在该页范围内', r[0] >= pr.left - 2 && r[0] + r[2] <= pr.right + 2,
      JSON.stringify([Math.round(pr.left), Math.round(pr.right), r]))
  }

  check('恢复的缩放比例也还在', T.state.scale > 1.5, T.state.scale)

  // 顺带确认：恢复之后没有把同一条又存一遍
  await sleep(1000)
  const after = await allRecords()
  const rec2 = after[Object.keys(after)[0]]
  check('没有把恢复的条目又存一遍', rec2.entries.length === 1, rec2.entries.length)

  out.summary = {
    restoredEntries: T.state.entries.length,
    rect: r,
    text: text.slice(0, 70),
    scale: T.state.scale,
  }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
