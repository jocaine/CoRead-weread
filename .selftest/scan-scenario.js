/**
 * 扫描件（整本只有图片、没有文字层）的行为验证：
 *   - 图片能显示出来（不是空白）
 *   - 识别为"没有文字层"并给出提示
 *   - 划词拿不到东西（不该假装能划）
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

const out = { checks: [], errors: [], context: location.href, storageKind: 'unknown' }
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
out.storageKind = window.__stubbedStorage ? 'localStorage 替身' : 'chrome.storage.local（真实）'

const T = window.__readerTest

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/scan.pdf' : '/.selftest/scan.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'scan.pdf')

  check('打开的页数正确', T.state.doc && T.state.doc.numPages === 2, T.state.doc && T.state.doc.numPages)
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)
  await waitFor(() => T.state.pages[1] && T.state.pages[1].rendered, 15000)

  const p1 = T.state.pages[0]
  const p2 = T.state.pages[1]
  check('图片页都渲染了', !!(p1 && p1.rendered && p2 && p2.rendered))
  check('第 1 页画出了内容（不是空白）', p1 && p1.canvasBlank === false, p1 && p1.canvasBlank)
  check('第 2 页画出了内容（不是空白）', p2 && p2.canvasBlank === false, p2 && p2.canvasBlank)
  check('两页都没有文字层', !!(p1 && p1.textChars < 20 && p2 && p2.textChars < 20), [p1 && p1.textChars, p2 && p2.textChars])
  check('给出了"扫描件"提示', document.getElementById('rd-scan-hint').hidden === false)
  check('没有渲染报错', !T.state.lastRenderError, JSON.stringify(T.state.lastRenderError))

  // 划词：文字层里没有字，本来就不该给出可翻译的选区
  const before = T.selectionAnchors()
  check('没有文字时不产生选区锚点', !before, JSON.stringify(before))

  out.summary = {
    pages: T.state.doc.numPages,
    canvasBlank: [p1 && p1.canvasBlank, p2 && p2.canvasBlank],
    textChars: [p1 && p1.textChars, p2 && p2.textChars],
    hintShown: document.getElementById('rd-scan-hint').hidden === false,
  }
} catch (e) {
  out.errors.push(String((e && e.stack) || e))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
