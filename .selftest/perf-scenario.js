/**
 * 性能与观感回归：
 *   1) 画布位图有像素上限（扫描件页不会再画出上亿像素的画布）
 *   2) 缩放时只重画看得见的那几页，离屏页标记待重画、滚回来再补
 *   3) 选中文字时不在画布原文上再叠一层字形（选区里的字形设为透明）
 * 需要在宽屏（默认 1200）与 --dpr=2 下各跑一次。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 15000) {
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
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') return { ok: true, data: { original: msg.text, translation: '【译】' + msg.text.slice(0, 20) } }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

try {
  // 用扫描件样本（图片页最吃画布像素）
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/scan.pdf' : '/.selftest/scan.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'scan.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 20000)
  await waitFor(() => T.state.pages[1] && T.state.pages[1].rendered, 20000)

  const s0 = T.renderStats()
  out.dpr = s0.dpr
  const maxPixels = Math.max(...s0.canvasPixels)
  check('画布像素量在上限之内（≤ 800 万）', maxPixels <= 8_100_000, { maxPixels, dpr: s0.dpr })
  check('两页都画好了', s0.renderedPages === 2, s0.renderedPages)

  // ── 缩放：只该重画看得见的那几页 ─────────────────────────────────────────
  const before = T.renderStats()
  const target = document.getElementById('rd-zoom-in')
  target.click()
  await sleep(700)
  const after = T.renderStats()
  out.zoom = { before: before.renderCount, after: after.renderCount, reRendered: after.lastZoomRerendered }
  check('缩放时重画的页数不超过 2 页', after.lastZoomRerendered <= 2, after.lastZoomRerendered)
  check('重画次数没有按"所有已渲染页"增长',
    after.renderCount - before.renderCount <= 2, after.renderCount - before.renderCount)

  // 缩放后所有已渲染页要么当场重画、要么被标记待重画，不能有"没标记却过期"的
  const consistent = T.state.pages.every((p) => !p.rendered || p.needsRender || !p.page ||
    Math.abs(p.viewport.scale - T.state.scale) < 0.001)
  check('每页的视口与当前缩放一致', consistent, T.state.scale)

  // ── 选区观感：选区里的字形必须是透明的 ───────────────────────────────────
  const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules] } catch { return [] } })
  const selRules = css.filter((r) => r.selectorText && r.selectorText.includes('::selection'))
  out.selectionRules = selRules.map((r) => ({ sel: r.selectorText, color: r.style.color, bg: r.style.background || r.style.backgroundColor }))
  const tlRule = selRules.find((r) => r.selectorText.includes('.textLayer'))
  check('有专门给文字层的选区规则', !!tlRule, JSON.stringify(out.selectionRules))
  check('选区里的字形是透明的（不再叠一层字）',
    !!(tlRule && (tlRule.style.color === 'transparent' || tlRule.style.color === 'rgba(0, 0, 0, 0)')),
    tlRule && tlRule.style.color)
  check('选区底色是半透明的（能透出画布原文）',
    !!(tlRule && /rgba\(/.test(tlRule.style.background || tlRule.style.backgroundColor || '')),
    tlRule && (tlRule.style.background || tlRule.style.backgroundColor))

  out.summary = { dpr: s0.dpr, maxPixels, zoom: out.zoom, selectionRules: out.selectionRules }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
