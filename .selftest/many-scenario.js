/**
 * 多页场景下的性能回归：读了很多页之后再缩放，只该重画看得见的那几页。
 * 之前的实现会把所有渲染过的页一起重画（读到第 13 页时拖一下缩放 = 同时重画 13 张画布）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(120)
  }
  return false
}

const out = { checks: [], errors: [], context: location.href }
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail })
  return !!ok
}

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

const T = window.__readerTest
T.state.translateOverride = async () => ({ ok: false, error: { message: '不该翻译' } })

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/many.pdf' : '/.selftest/many.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'many.pdf')
  check('打开的是 13 页的书', T.state.doc.numPages === 13, T.state.doc.numPages)
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 20000)

  // 一页页往下滚，让大部分页都渲染出来
  const scroller = document.getElementById('rd-scroll')
  for (let i = 0; i < 12; i++) {
    scroller.scrollTop = scroller.scrollTop + scroller.clientHeight * 0.9
    await sleep(450)
  }
  await waitFor(() => T.state.pages.filter((p) => p.rendered).length >= 8, 20000)
  const before = T.renderStats()
  out.beforeZoom = before
  check('已经渲染了不少页（够形成压力）', before.renderedPages >= 8, before.renderedPages)

  // 回到顶部再缩放：此时"已渲染但离屏"的页很多
  scroller.scrollTop = 0
  await sleep(400)
  const mid = T.renderStats()

  document.getElementById('rd-zoom-in').click()
  await sleep(1200)
  const after = T.renderStats()
  out.zoom = { renderedPages: after.renderedPages, reRendered: after.lastZoomRerendered, stale: after.stalePages, delta: after.renderCount - mid.renderCount }

  check('缩放时只重画了看得见的少数页（≤ 3）', after.lastZoomRerendered <= 3, after.lastZoomRerendered)
  check('重画总数远小于已渲染页数', after.renderCount - mid.renderCount <= 3, after.renderCount - mid.renderCount)
  check('离屏的已渲染页被标记为待重画', after.stalePages >= 3, after.stalePages)

  // 滚回去的那一页应当被补画
  const staleBefore = T.renderStats().renderCount
  scroller.scrollTop = scroller.clientHeight * 4
  await waitFor(() => T.state.pages.some((p) => p.rendered && !p.needsRender && p.num > 3), 20000)
  const fixed = T.renderStats()
  out.afterScroll = { renderCount: fixed.renderCount, stale: fixed.stalePages, delta: fixed.renderCount - staleBefore }
  check('滚回去的页被补画了', fixed.renderCount > staleBefore, fixed.renderCount - staleBefore)
  check('待重画的页在减少', fixed.stalePages < after.stalePages, [after.stalePages, fixed.stalePages])

  out.summary = { dpr: before.dpr, before, zoom: out.zoom, afterScroll: out.afterScroll, maxPixels: Math.max(...fixed.canvasPixels) }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
