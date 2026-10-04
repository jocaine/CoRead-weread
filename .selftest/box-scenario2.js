/** 第二段：刷新后重新打开扫描件，框选译文与位置标记必须原样回来 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
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
T.state.translateOverride = async () => ({ ok: false, error: { message: '不该再翻译一次' } })

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/scan.pdf' : '/.selftest/scan.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'scan.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)

  check('图片类译文被恢复', T.state.entries.length === 1, T.state.entries.length)
  const e = T.state.entries[0]
  check('恢复的条目仍是图片类', !!(e && e.kind === 'image'), e && e.kind)
  check('译文内容一致', !!(e && e.translation === '【译】扫描页文字'), e && e.translation)
  check('位置比例也恢复了', !!(e && e.rect && e.rect.w > 0), JSON.stringify(e && e.rect))

  const marks = T.imageMarks()
  check('位置标记重新画上了', marks.length === 1, JSON.stringify(marks))
  check('标记比例与记录一致',
    !!(marks[0] && Math.abs(parseFloat(marks[0].style.width) - e.rect.w * 100) < 0.1),
    marks[0] && (marks[0].style.width + ' vs ' + (e.rect.w * 100).toFixed(3)))

  // 划词浮标在没有选区时必须真的不可见（.rd-tip 自带 display:flex，容易漏掉 [hidden]）
  const tip = document.getElementById('rd-tip')
  check('没有选区时划词浮标不可见', getComputedStyle(tip).display === 'none', getComputedStyle(tip).display)

  out.summary = { entries: T.state.entries.length, rect: e && e.rect, mark: marks[0] && marks[0].style }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
