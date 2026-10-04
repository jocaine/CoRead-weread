/**
 * 这一轮三条的回归：
 *   1) 侧栏的命令必须真的能到达阅读器 —— 走**消息链路**（不是直接调函数），
 *      以前少注册 onMessage，删除/重译全都悄无声息
 *   2) 快捷键翻译：靠后台中继成命令送到阅读器（侧栏有焦点时页面收不到按键）
 *   3) 译文对照在侧栏里是"一整栏"，不是居中的弹窗（无遮罩、铺满、白底）
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 15000) {
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
    runtime: {
      sendMessage: async (msg) => { window.__sent.push(msg); return { ok: true } },
      onMessage: { addListener: (fn) => { window.__msgListener = fn } },
    },
  }
}
const T = window.__readerTest
let calls = 0
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') {
    calls++
    return { ok: true, data: { original: msg.text, translation: '【译' + calls + '】' + msg.text.slice(0, 20) } }
  }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

/** 模拟后台中继把命令送进页面：走真正的消息监听器 */
function relay(msg) {
  return new Promise((resolve) => {
    const listeners = window.__msgListeners || []
    if (!listeners.length) { resolve('NO-LISTENER'); return }
    let done = false
    const sendResponse = (r) => { if (!done) { done = true; resolve(r) } }
    for (const fn of listeners) {
      const ret = fn({ action: 'readerCommand', ...msg }, {}, sendResponse)
      if (ret !== true && !done) { /* 同步没回应就等异步 */ }
    }
    setTimeout(() => { if (!done) { done = true; resolve('NO-REPLY') } }, 3000)
  })
}

try {
  check('阅读器注册了后台消息监听', (window.__msgListeners || []).length > 0,
    (window.__msgListeners || []).length)

  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'sample.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)

  // 先翻两条
  T.selectOffsets(1, 0, 60)
  await T.translateSelection()
  await waitFor(() => T.state.entries.length === 1 && !T.state.entries[0].pending, 8000)
  T.selectOffsets(1, 70, 110)
  await T.translateSelection()
  await waitFor(() => T.state.entries.length === 2 && !T.state.entries[1].pending, 8000)
  check('先翻出两条', T.state.entries.length === 2, T.state.entries.length)

  // ── 1) 删除：走消息链路 ─────────────────────────────────────────────────
  const delId = T.state.entries[0].id
  const rDel = await relay({ type: 'remove', id: delId })
  await sleep(200)
  check('删除命令到达并回应', !!(rDel && rDel.ok), JSON.stringify(rDel))
  check('**条目真的被删掉了**', T.state.entries.length === 1, T.state.entries.length)
  check('删掉的是指定那条', !T.state.entries.some((e) => e.id === delId))

  // 其余命令同样走消息链路
  const keepId = T.state.entries[0].id
  const rRef = await relay({ type: 'reference', id: keepId })
  check('设为引用命令到达并回应', !!(rRef && rRef.ok), JSON.stringify(rRef))

  const rRe = await relay({ type: 'retranslate', id: keepId, text: 'Retranslated source.' })
  await sleep(300)
  check('改原文重译命令到达并回应', !!(rRe && rRe.ok), JSON.stringify(rRe))
  check('原文确实被改了', T.state.entries[0].source === 'Retranslated source.', T.state.entries[0].source)

  const rRev = await relay({ type: 'reveal', id: keepId })
  check('跳到原文命令到达并回应', !!(rRev && rRev.ok), JSON.stringify(rRev))

  // ── 2) 快捷键：后台中继成 boxSelect / translateSelection ────────────────
  const rBox = await relay({ type: 'boxSelect' })
  check('boxSelect 命令到达并回应', !!(rBox && rBox.ok), JSON.stringify(rBox))
  check('进入了框选状态（等价于 Alt+S）', T.state.boxMode === true, T.state.boxMode)
  T.endBoxSelect('esc')

  T.selectOffsets(1, 0, 40)
  const beforeCount = T.state.entries.length
  const rTr = await relay({ type: 'translateSelection' })
  await sleep(500)
  check('translateSelection 命令到达并回应', !!(rTr && rTr.ok), JSON.stringify(rTr))
  check('划词翻译执行了（条目增加或跳到已有那条）',
    T.state.entries.length >= beforeCount, [beforeCount, T.state.entries.length])

  const rBad = await relay({ type: 'nonsense' })
  check('未知命令有明确回执（不是静默）', !!(rBad && rBad.ok === false), JSON.stringify(rBad))

  // ── 3) 侧栏里的译文对照是"一整栏"而不是弹窗 ─────────────────────────────
  // 侧栏本身在无头浏览器里打不开，这里直接检查它的样式规则
  const css = await (await fetch(location.protocol === 'chrome-extension:' ? 'sidebar.html' : '/extension/sidebar.html')).text()
  const rule = css.slice(css.indexOf('#reader-notes {'), css.indexOf('#rn-body'))
  out.notesRule = rule.replace(/\s+/g, ' ').trim().slice(0, 220)
  check('译文对照定位是铺满（inset: 0）', /inset:\s*0/.test(rule), out.notesRule)
  check('没有半透明遮罩（不是弹窗观感）', !/rgba\(0,\s*0,\s*0/.test(rule), out.notesRule)
  check('不是居中弹窗（没有 align-items/justify-content: center）',
    !/align-items:\s*center/.test(rule) && !/justify-content:\s*center/.test(rule), out.notesRule)
  check('不透明白底（当作一栏看）', /background:\s*#fff/.test(rule), out.notesRule)

  out.summary = {
    entries: T.state.entries.length,
    deleteOk: !!(rDel && rDel.ok),
    notesRule: out.notesRule,
  }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
