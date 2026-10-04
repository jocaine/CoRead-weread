/**
 * 阅读器 ↔ 侧栏 的协议，以及这一轮的四条改动：
 *   1) 框选是"按一次框一次"，拖完自动退出；Alt+S 也能直接进
 *   2) 双击书页空白处 → 通知侧栏收起译文对照
 *   3) 侧栏发来的「改原文重译」能改原文并重译
 *   4) 译文对照不再画在阅读器页面上（页面上不该有 .rn-* / .rd-entry 之类的东西），
 *      而是把快照同步给侧栏
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(100)
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
let calls = 0
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') {
    calls++
    return { ok: true, data: { original: msg.text, translation: '【译' + calls + '】' + msg.text.slice(0, 24) } }
  }
  if (msg.action === 'translateImage') { calls++; return { ok: true, data: { original: 'IMG', translation: '【图译】' } } }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}
const sent = () => window.__sent
const lastOf = (action) => [...sent()].reverse().find((m) => m.action === action)
const snapshot = () => { const m = lastOf('readerSync'); return m && m.snapshot }

try {
  // 阅读器页面上不该再有译文对照的 DOM
  check('阅读器页面上没有译文对照容器', !document.getElementById('rd-panel') && !document.getElementById('rd-entries'))
  check('工具栏有「译文」按钮（用来在侧栏打开对照）', !!document.getElementById('rd-notes'))

  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'sample.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)

  // ── 4) 翻译后同步快照给侧栏，并请侧栏把对照页打开 ────────────────────────
  window.__sent.length = 0
  check('能建立选区', T.selectOffsets(1, 0, 60))
  await T.translateSelection()
  await waitFor(() => T.state.entries.length === 1 && !T.state.entries[0].pending, 8000)
  await sleep(400)
  check('翻译后请求打开侧栏译文对照', !!lastOf('notesOpen'), JSON.stringify(sent().map((m) => m.action)))
  const snap = snapshot()
  check('同步了快照', !!(snap && snap.entries && snap.entries.length === 1), snap && snap.entries.length)
  check('快照里有书名与译文', !!(snap && snap.book && snap.book.name === 'sample.pdf' && snap.entries[0].translation),
    snap && JSON.stringify({ book: snap.book, t: snap.entries[0].translation }))
  check('快照里带锚点条目（供侧栏判断条数）', snap.entries.length === T.state.entries.length)

  // ── 3) 侧栏发来「改原文重译」────────────────────────────────────────────
  const id = T.state.entries[0].id
  calls = 0
  const res = await T.onReaderCommand({ type: 'retranslate', id, text: 'Fixed source text for retranslate.' })
  await sleep(300)
  check('重译返回成功', !!(res && res.ok), JSON.stringify(res))
  check('原文被改成了新文本', T.state.entries[0].source === 'Fixed source text for retranslate.',
    T.state.entries[0].source)
  check('译文被刷新', /【译1】/.test(T.state.entries[0].translation), T.state.entries[0].translation)
  check('重译后同步了新快照', !!(snapshot() && snapshot().entries[0].source === 'Fixed source text for retranslate.'))

  // 侧栏的其余命令
  await T.onReaderCommand({ type: 'reveal', id })
  check('reveal 把这一条设为当前', T.state.activeId === id, T.state.activeId)
  const r2 = await T.onReaderCommand({ type: 'reference', id })
  check('reference 走通了（替身后台返回 ok）', !!(r2 && r2.ok), JSON.stringify(r2))
  await T.onReaderCommand({ type: 'remove', id })
  check('remove 删掉了这一条', T.state.entries.length === 0, T.state.entries.length)

  // ── 1) 框选：按一次框一次 ───────────────────────────────────────────────
  T.startBoxSelect()
  check('进入框选状态', T.state.boxMode === true)
  check('按钮显示为选中态', document.getElementById('rd-box').classList.contains('is-on'))

  // Alt+S 也能进入（先退出）
  T.endBoxSelect('esc')
  check('结束框选后按钮恢复', !document.getElementById('rd-box').classList.contains('is-on'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true }))
  await sleep(80)
  check('Alt+S 能直接进入框选', T.state.boxMode === true)

  // 拖一个框：拖完应当自动退出，并且产生一条译文
  const pageEl = document.querySelector('.rd-page')
  const r = pageEl.getBoundingClientRect()
  const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, button: 0 })
  pageEl.dispatchEvent(new MouseEvent('mousedown', at(30, 40)))
  document.dispatchEvent(new MouseEvent('mousemove', at(280, 140)))
  document.dispatchEvent(new MouseEvent('mouseup', at(280, 140)))
  await waitFor(() => T.state.entries.length === 1, 8000)
  check('框选产生了译文', T.state.entries.length === 1, T.state.entries.length)
  check('**框完自动退出**（不用再点一次）', T.state.boxMode === false, T.state.boxMode)
  check('退出后按钮不再选中', !document.getElementById('rd-box').classList.contains('is-on'))

  // ── 2) 双击空白处 → 收起侧栏译文对照 ────────────────────────────────────
  window.__sent.length = 0
  const blankX = r.left + r.width * 0.5
  const blankY = r.top + r.height * 0.85
  check('双击点处确实没有译文命中', T.entryAtPoint(blankX, blankY) === null)
  document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: blankX, clientY: blankY }))
  await sleep(120)
  check('双击空白处发出收起命令', !!lastOf('notesClose'), JSON.stringify(sent().map((m) => m.action)))
  check('收起命令带了 side 标识（侧栏据此关闭）', !!(lastOf('notesClose')))

  out.summary = {
    entries: T.state.entries.length,
    calls,
    actions: sent().map((m) => m.action).slice(-6),
    boxMode: T.state.boxMode,
  }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
