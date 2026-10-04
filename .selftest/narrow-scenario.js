/**
 * 窄屏（典型：CoRead 侧栏也开着）下阅读器页面本身的布局约束。
 *
 * 译文对照已经搬进侧栏，所以阅读器页面**不该再有任何侧栏**；
 * 剩下的关键约束是滚动容器必须有界（它一破，进度/锚点/懒加载全废，还会引发全量重画）。
 * 需要用 --width=900 跑。
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
    storage: { local: { async get() { return {} }, async set() {} } },
    runtime: { sendMessage: async (msg) => { window.__sent.push(msg); return { ok: true } } },
  }
}

const T = window.__readerTest
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') return { ok: true, data: { original: msg.text, translation: '【译】' + msg.text.slice(0, 20) } }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

try {
  out.width = window.innerWidth
  check('这次是按窄屏跑的', window.innerWidth < 1100, window.innerWidth)

  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/many.pdf' : '/.selftest/many.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'many.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 20000)

  // 译文对照搬走之后，阅读器页面里不该还有那一栏
  check('页面里没有译文对照栏', !document.getElementById('rd-panel') && !document.getElementById('rd-entries'))
  check('没有任何 .rd-panel 元素', document.querySelectorAll('.rd-panel').length === 0)

  // 滚动容器必须有界（一旦被整本书撑开，进度/锚点/懒加载全废）
  const sc = document.getElementById('rd-scroll')
  out.scrollBox = { clientHeight: sc.clientHeight, windowInner: window.innerHeight, scrollHeight: sc.scrollHeight }
  check('滚动容器高度有界', sc.clientHeight > 200 && sc.clientHeight < window.innerHeight, out.scrollBox)
  check('内容比容器高（它才是滚动的那个）', sc.scrollHeight > sc.clientHeight + 100, out.scrollBox)

  // 窄屏下书页要把宽度用起来（没有侧栏占位），且不超出可视区域
  const page = T.state.pages[0]
  const pr = page.wrap.getBoundingClientRect()
  out.page = { left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width), view: window.innerWidth }
  check('书页不超出窗口宽度', pr.left >= -2 && pr.right <= window.innerWidth + 2, out.page)
  check('书页宽度用到了窗口的大部分（> 60%）', pr.width > window.innerWidth * 0.6, out.page)

  out.summary = { width: window.innerWidth, scrollBox: out.scrollBox, page: out.page }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
