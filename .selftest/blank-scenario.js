/**
 * 空白页专项排查：把渲染结果的实际状态全部打出来。
 *   - 画布像素尺寸与实际尺寸是否吻合
 *   - 画布是不是接近全白（采样）
 *   - 文字层有多少字、有多少 span
 *   - 渲染有没有抛错
 * 用不同 devicePixelRatio 各跑一次，就能判断是不是高分屏渲染分支的问题。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
  }
  return false
}

const out = { checks: [], errors: [], diag: {} }
const T = window.__readerTest

// 真实的 chrome.storage 用不了（这不是扩展页面），用替身保证代码路径不报错
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

try {
  out.dpr = window.devicePixelRatio
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'sample.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 20000)

  const p = T.state.pages[0]
  out.diag = {
    dpr: window.devicePixelRatio,
    rendered: T.state.pages.filter((x) => x.rendered).length,
    canvasAttr: p && p.canvas ? [p.canvas.width, p.canvas.height] : null,
    canvasCss: p && p.canvas ? [p.canvas.style.width, p.canvas.style.height] : null,
    canvasRect: p && p.canvas ? (() => { const r = p.canvas.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })() : null,
    textChars: p ? p.textChars : null,
    textSpans: p && p.layer ? p.layer.querySelectorAll('span').length : null,
    canvasBlank: p ? p.canvasBlank : null,
    renderError: T.state.lastRenderError || null,
    statusText: (document.getElementById('rd-status') || {}).textContent || '',
  }

  // 直接看画布像素：非白像素占比
  if (p && p.canvas) {
    try {
      const ctx = p.canvas.getContext('2d')
      const w = p.canvas.width, h = p.canvas.height
      const img = ctx.getImageData(0, 0, w, h).data
      let nonWhite = 0, total = 0
      for (let i = 0; i < img.length; i += 4 * 37) {   // 抽样，别把整幅读完
        total++
        if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) nonWhite++
      }
      out.diag.nonWhiteRatio = +(nonWhite / total).toFixed(4)
      out.diag.sampledPixels = total
    } catch (e) {
      out.diag.pixelError = String(e && e.message)
    }
  }

  out.checks.push({ name: '首页渲染完成', ok: !!(p && p.rendered), detail: out.diag.rendered })
  out.checks.push({ name: '画布有非白像素（真的画上东西了）', ok: (out.diag.nonWhiteRatio || 0) > 0.002, detail: out.diag.nonWhiteRatio })
  out.checks.push({ name: '画布尺寸与 CSS 尺寸成 dpr 比例', ok: !!(p && p.canvas &&
    Math.abs(p.canvas.width - parseFloat(p.canvas.style.width) * window.devicePixelRatio) <= 2),
    detail: JSON.stringify([out.diag.canvasAttr, out.diag.canvasCss, window.devicePixelRatio]) })
  out.checks.push({ name: '文字层有字', ok: (out.diag.textChars || 0) > 0, detail: out.diag.textChars })
  out.checks.push({ name: '没有渲染报错', ok: !T.state.lastRenderError, detail: JSON.stringify(T.state.lastRenderError) })
} catch (e) {
  out.errors.push(String((e && e.stack) || e))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
