/**
 * 真实点击「翻译」浮标之后，检查这条路径到底通不通。
 * 前面的拖拽与点击都由驱动用 CDP 真实输入事件派发，这里只负责读结果。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
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

const T = window.__readerTest

try {
  const sel = window.getSelection()
  out.selectionText = sel ? sel.toString() : ''
  check('真实拖拽产生了选区', !!(out.selectionText && out.selectionText.trim().length > 3), out.selectionText.slice(0, 50))

  out.lastSelectionSet = !!(T.state.lastSelection && T.state.lastSelection.anchors)
  check('拖拽后页面记下了选区锚点', out.lastSelectionSet, JSON.stringify(T.state.lastSelection && T.state.lastSelection.anchors))

  const tip = document.getElementById('rd-tip')
  out.tipHidden = tip.hidden
  out.tipDisplay = getComputedStyle(tip).display

  // 点完之后应该出现一条译文（真实后台被替身换掉了，立即返回）
  await waitFor(() => T.state.entries.length > 0, 6000)
  const e = T.state.entries[0]
  out.entries = T.state.entries.length
  check('点「翻译」后产生了译文条目', T.state.entries.length === 1, T.state.entries.length)
  check('条目带上了刚划选的锚点', !!(e && e.anchors && e.anchors.length === 1), JSON.stringify(e && e.anchors))
  await waitFor(() => e && !e.pending, 6000)
  check('译文拿到了', !!(e && e.translation), e && e.translation)
  check('没有报错', !(e && e.error), e && e.error)
  out.entry = e ? { source: (e.source || '').slice(0, 60), translation: e.translation, error: e.error } : null
  out.toastText = (document.getElementById('rd-toast') || {}).textContent || ''
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
