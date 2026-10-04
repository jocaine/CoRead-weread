/**
 * 「翻译一下不该卡」的回归：译文对照搬到侧栏之后，这一步在阅读器里应当只剩同步开销。
 * 需要用 --width=900 跑。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 20000) {
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
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') return { ok: true, data: { original: msg.text, translation: 'Y' + msg.text.slice(0, 24) } }
  return { ok: false, error: { message: 'unexpected ' + msg.action } }
}

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/many.pdf' : '/.selftest/many.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'many.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 20000)

  const sc = document.getElementById('rd-scroll')
  check('滚动容器有界（它一破，懒加载就退化成全量重画）',
    sc.clientHeight > 200 && sc.clientHeight < window.innerHeight,
    { clientHeight: sc.clientHeight, windowInner: window.innerHeight })

  for (let i = 0; i < 5; i++) { sc.scrollTop += sc.clientHeight * 0.9; await sleep(400) }
  await waitFor(() => T.state.pages.filter((p) => p.rendered).length >= 4, 15000)
  sc.scrollTop = 0
  await sleep(400)

  check('能建立选区', T.selectOffsets(1, 0, 60))
  const before = T.renderStats()
  const scrollBefore = sc.scrollTop
  const t0 = performance.now()
  await T.translateSelection()
  const elapsed = Math.round(performance.now() - t0)
  await sleep(900)
  const after = T.renderStats()

  out.summary = {
    elapsedMs: elapsed,
    renderCountDelta: after.renderCount - before.renderCount,
    renderMsDelta: after.renderMs - before.renderMs,
    scrollDelta: sc.scrollTop - scrollBefore,
    sent: window.__sent.map((m) => m.action).slice(-4),
  }

  check('翻译 + 同步没有触发画布重画', after.renderCount === before.renderCount, [before.renderCount, after.renderCount])
  check('没有画布渲染耗时', after.renderMs - before.renderMs === 0, after.renderMs - before.renderMs)
  check('没有把书页滚走', Math.abs(sc.scrollTop - scrollBefore) < 4, out.summary.scrollDelta)
  check('翻译很快（< 1 秒，含替身往返）', elapsed < 1000, elapsed)
  check('翻译后把快照同步给了侧栏', window.__sent.some((m) => m.action === 'readerSync'), JSON.stringify(out.summary.sent))

  const b2 = T.renderStats()
  for (let i = 0; i < 10; i++) await T.syncNotes()
  await sleep(600)
  const a2 = T.renderStats()
  check('连续 10 次同步不引发重画', a2.renderCount === b2.renderCount, a2.renderCount - b2.renderCount)

  const b3 = T.renderStats()
  document.getElementById('rd-zoom-in').click()
  await sleep(1400)
  const a3 = T.renderStats()
  check('缩放只重画可见的少数页（<= 4）', a3.renderCount - b3.renderCount <= 4, a3.renderCount - b3.renderCount)
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
