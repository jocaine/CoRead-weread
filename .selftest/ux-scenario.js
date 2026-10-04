/**
 * 三个体验改动的验证：
 *   1) 同一段重复翻译不生成第二条（也不重复调用模型），而是跳回已有那条
 *   2) 翻译时自动展开对照栏
 *   3) 点正文里已经翻过的地方 → 展开对照栏并高亮对应条目
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
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

let calls = 0
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') {
    calls++
    return { ok: true, data: { original: msg.text, translation: '【译' + calls + '】' + msg.text.slice(0, 30) } }
  }
  if (msg.action === 'translateImage') { calls++; return { ok: true, data: { original: 'IMG', translation: '【图译】' } } }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

try {
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'sample.pdf')
  await waitFor(() => T.state.pages[0] && T.state.pages[0].rendered, 15000)

  // ── 1) 同一段翻两次 ──────────────────────────────────────────────────────
  T.selectOffsets(1, 0, 60)
  await T.translateSelection()
  await waitFor(() => T.state.entries.length === 1 && !T.state.entries[0].pending, 8000)
  check('第一次翻译产生 1 条', T.state.entries.length === 1, T.state.entries.length)
  check('第一次调用了模型', calls === 1, calls)
  const first = T.state.entries[0]

  T.selectOffsets(1, 0, 60)          // 完全相同的区间
  await T.translateSelection()
  await sleep(600)
  check('同一段再翻一次不新增条目', T.state.entries.length === 1, T.state.entries.length)
  check('也没有重复调用模型', calls === 1, calls)
  check('跳回的是原来那条（被设为当前）', T.state.activeId === first.id, T.state.activeId)
  out.toastAfterDup = (document.getElementById('rd-toast') || {}).textContent || ''

  // 稍微不同的区间应当算新的一条（第 1 页总共只有 113 字，别越界）
  check('能建立第二个选区', T.selectOffsets(1, 70, 110))
  await T.translateSelection()
  await waitFor(() => T.state.entries.length === 2, 8000)
  check('不同的区间仍是新条目', T.state.entries.length === 2, T.state.entries.length)
  check('这次才又调用模型', calls === 2, calls)

  // 越界区间不该被当成有效选区（防止"什么都没发生"被误判成通过）
  check('越界区间不算选区', T.selectOffsets(1, 140, 200) === false)

  // ── 2) 翻译时请侧栏把译文对照打开（对照栏现在挂在侧栏里）────────────────
  window.__sent.length = 0
  check('能建立第三个选区', T.selectOffsets(1, 0, 30))
  await T.translateSelection()
  await sleep(700)
  const acts = window.__sent.map((m) => m.action)
  check('翻译后请求侧栏打开译文对照', acts.includes('notesOpen'), JSON.stringify(acts))
  check('翻译后同步了快照', !!window.__sent.find((m) => m.action === 'readerSync' && m.snapshot.entries.length === 3),
    JSON.stringify(acts))

  // ── 3) 点正文里已翻过的位置 ──────────────────────────────────────────────
  T.state.activeId = ''
  T.renderImageMarks()
  window.__sent.length = 0
  await sleep(150)

  const rects = T.anchorRects()                     // 各条锚点在屏幕上的矩形
  const target = rects[0]
  check('拿得到第一条的屏幕矩形', !!(target && target.rects && target.rects[0]), JSON.stringify(target && target.rects))
  const r = target.rects[0]
  const px = r[0] + r[2] / 2
  const py = r[1] + r[3] / 2
  out.hit = T.entryAtPoint(px, py) ? T.entryAtPoint(px, py).id : null
  check('命中判定能找到这一条', T.entryAtPoint(px, py) === T.state.entries[0], out.hit)
  check('空白处不误判', T.entryAtPoint(px, py + 4000) === null)

  document.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }))
  await sleep(300)
  check('点已翻过的正文会请侧栏打开对照',
    window.__sent.some((m) => m.action === 'notesOpen'), JSON.stringify(window.__sent.map((m) => m.action)))
  check('并把它设为当前条目', T.state.activeId === T.state.entries[0].id, T.state.activeId)

  out.summary = { entries: T.state.entries.length, calls, activeId: T.state.activeId }

  // 界面状态别自欺：框选按钮不该在没开框选时显示成选中态；
  // 有文字的页不该被报成"画布空白"
  const boxBtn = document.getElementById('rd-box')
  check('没开框选时按钮不是选中态', !boxBtn.classList.contains('is-on') && T.state.boxMode === false,
    boxBtn.className)
  check('有文字的页不被报成画布空白', T.state.pages[0].canvasBlank !== true,
    T.state.pages[0].canvasBlank)
  out.statusLine = document.getElementById('rd-status').textContent
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
