/**
 * 框选翻译（扫描件 / 图片页）场景：
 *   拖一个框 → 裁剪画布 → 交模型读图 → 译文进对照栏 + 页面上留下位置标记。
 * 用真实的 mouse 事件走一遍（不是直接调内部函数），把手柄那段逻辑也覆盖上。
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
out.storageKind = window.__stubbedStorage ? 'localStorage 替身' : 'chrome.storage.local（真实）'

const T = window.__readerTest

// 假的读图翻译：消息形状与真实 SW 一致
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateImage') {
    out.imageBytes = String(msg.dataUrl || '').length
    out.imagePrefix = String(msg.dataUrl || '').slice(0, 22)
    return { ok: true, data: { original: 'SCANNED PAGE TEXT', translation: '【译】扫描页文字' } }
  }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { code: 'UNEXPECTED', message: '意外的消息 ' + msg.action } }
}

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/scan.pdf' : '/.selftest/scan.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'scan.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)
  check('扫描件页已渲染', !!(T.state.pages[0] && T.state.pages[0].rendered))

  // 打开框选模式
  T.startBoxSelect()
  check('框选模式已打开', T.state.boxMode === true)
  check('页面进入框选态（不选中文字、十字光标）', document.getElementById('rd-pages').classList.contains('is-boxing'))

  // 模拟拖框
  const pageEl = document.querySelector('.rd-page')
  const r = pageEl.getBoundingClientRect()
  const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, button: 0 })
  pageEl.dispatchEvent(new MouseEvent('mousedown', at(30, 40)))
  document.dispatchEvent(new MouseEvent('mousemove', at(300, 150)))
  check('拖动时出现橡皮筋框', !!document.querySelector('.rd-marquee'))
  document.dispatchEvent(new MouseEvent('mouseup', at(300, 150)))

  check('拖完橡皮筋被清掉', !document.querySelector('.rd-marquee'))
  await waitFor(() => T.state.entries.length > 0, 8000)
  const e = T.state.entries[0]
  check('产生了图片类译文条目', !!(e && e.kind === 'image'), e && e.kind)
  await waitFor(() => e && !e.pending, 8000)
  check('译文进了对照栏', !!(e && e.translation), e && e.translation)
  check('模型读出的原文也留下了', !!(e && e.source), e && e.source)
  const snapB = [...(window.__sent || [])].reverse().find((m) => m.action === 'readerSync')
  check('译文已同步给侧栏', !!(snapB && snapB.snapshot.entries.length === 1), snapB && snapB.snapshot.entries.length)
  check('截出来的确实是一张图（data:image）', String(out.imagePrefix || '').startsWith('data:image/'), out.imagePrefix)
  check('截图有实际内容（不是几十字节的空图）', (out.imageBytes || 0) > 500, out.imageBytes)

  // 位置标记：按页内百分比定位，缩放时会自己跟着走
  const marks = T.imageMarks()
  check('页面上留下了位置标记', marks.length === 1, JSON.stringify(marks))
  check('标记记在第 1 页', marks[0] && marks[0].page === 1)
  const rect = e && e.rect
  check('位置记成页内比例', !!(rect && rect.w > 0 && rect.w <= 1 && rect.h > 0 && rect.h <= 1), JSON.stringify(rect))
  check('标记尺寸与框一致（百分比）',
    !!(marks[0] && Math.abs(parseFloat(marks[0].style.width) - rect.w * 100) < 0.1),
    marks[0] && marks[0].style.width)

  // 缩放后标记仍按比例落在同一处
  const beforeLeft = parseFloat(marks[0].style.left)
  await T.setScale(1.8)
  await sleep(300)
  const marks2 = T.imageMarks()
  check('缩放后标记还在', marks2.length === 1)
  check('缩放后仍按同一比例定位（位置不跑）',
    !!(marks2[0] && Math.abs(parseFloat(marks2[0].style.left) - beforeLeft) < 0.01),
    marks2[0] && (marks2[0].style.left + ' vs ' + beforeLeft))

  // 落盘，供第二段（刷新后）验证
  await sleep(1200)
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('rd:book:'))
  check('已落盘', keys.length === 1, JSON.stringify(keys))
  out.summary = {
    rect, translation: e && e.translation, source: e && e.source,
    mark: marks2[0] && marks2[0].style, imageBytes: out.imageBytes,
  }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
