/**
 * 阅读器自测场景：在页面上下文里执行（由 drive.mjs 注入）。
 * 直接喂 PDF 字节，走「选区 → 偏移 → 翻译 → 高亮」的真实代码路径，
 * 再检查缩放之后锚点是否还落在同一处。
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

const T = window.__readerTest
const out = { checks: [], errors: [] }
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail })
  return !!ok
}

// 结果自带出处：看到它就确定这一轮是在哪个环境跑的，不会被上一轮的遗留文件骗到
out.context = location.href
out.storageKind = 'unknown'

/** 阅读数据落在哪：真实扩展页面在 chrome.storage.local，自测页面在 localStorage 替身里 */
async function allRecordKeys() {
  if (!window.__stubbedStorage && window.chrome && chrome.storage && chrome.storage.local) {
    const all = await chrome.storage.local.get(null)
    return Object.keys(all).filter((k) => k.startsWith('rd:book:'))
  }
  return Object.keys(localStorage).filter((k) => k.startsWith('rd:book:'))
}

// 自测环境里没有 chrome.storage（普通网页），用 localStorage 顶替：
// 接口形状一致，且跨刷新还在。跑在真实扩展页面里时用真的 storage，这里就不装。
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

// 假的翻译后台：消息形状与真实 SW 完全一致，只把模型换掉
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') {
    return { ok: true, data: { original: msg.text, translation: '【译】' + msg.text.replace(/\s+/g, ' ').slice(0, 60) } }
  }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { code: 'UNEXPECTED', message: '意外的消息 ' + msg.action } }
}

try {
  out.storageKind = window.__stubbedStorage ? 'localStorage 替身' : 'chrome.storage.local（真实）'

  // 0) pdf.js 的"附件"必须在位：缺了不会报错，只会让整类 PDF 变空白页
  const assetBase = location.protocol === 'chrome-extension:' ? '' : '/extension/'
  const assets = [
    ['cmaps', 'cmaps/Adobe-Japan1-0.bcmap'],
    ['standard_fonts', 'standard_fonts/FoxitFixed.pfb'],
    ['wasm', 'wasm/jbig2.wasm'],
    ['wasm', 'wasm/openjpeg.wasm'],
    ['iccs', 'iccs/CGATS001Compat-v2-micro.icc'],
  ]
  for (const [label, rel] of assets) {
    let status = 0
    try { status = (await fetch(assetBase + 'vendor/pdfjs/' + rel)).status } catch (e) { status = -1 }
    check('附件在位：' + rel, status === 200, status)
  }

  // 扩展页面取不到扩展包外的文件，样本 PDF 在 extension/test/ 下另放了一份
  const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
  const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
  await T.openBytes(bytes, 'sample.pdf')

  check('打开的页数正确', T.state.doc && T.state.doc.numPages === 3, T.state.doc && T.state.doc.numPages)
  check('按文件内容算出哈希', /^[0-9a-f]{64}$/.test(T.state.hash), T.state.hash.slice(0, 12) + '…')

  // 等第 1、2 页渲染完（渲染是懒加载的，要等 IntersectionObserver 触发）
  await waitFor(() => T.state.pages[0].rendered, 12000)
  T.gotoPage(2, false)
  await waitFor(() => T.state.pages[1] && T.state.pages[1].rendered, 12000)

  const p1 = T.state.pages[0]
  const p2 = T.state.pages[1]
  check('第 1 页渲染出画布', !!(p1 && p1.canvas), p1 && p1.canvas && (p1.canvas.width + '×' + p1.canvas.height))
  check('第 1 页有文字层 span', !!(p1 && p1.layer && p1.layer.querySelectorAll('span').length > 0),
    p1 && p1.layer && p1.layer.querySelectorAll('span').length)
  check('第 2 页有文字层 span', !!(p2 && p2.layer && p2.layer.querySelectorAll('span').length > 0),
    p2 && p2.layer && p2.layer.querySelectorAll('span').length)

  // ── 划词 → 偏移 → 翻译 ───────────────────────────────────────────────────
  const ok = T.selectOffsets(2, 0, 120)
  check('能在文字层里建立选区', ok)
  const anchors = T.selectionAnchors()
  check('选区能换算成页内偏移锚点', !!(anchors && anchors.anchors.length === 1 && anchors.anchors[0].page === 2),
    JSON.stringify(anchors && anchors.anchors))
  const srcText = anchors ? T.anchorsText(anchors.anchors) : ''
  check('原文按行规整过（不是两行直接粘住）', /survive translation|survive\stranslation/.test(srcText) || !/survivetranslation/.test(srcText), srcText.slice(0, 70))

  await T.translateSelection()
  await waitFor(() => T.state.entries.length && !T.state.entries[0].pending, 8000)
  const e0 = T.state.entries[0]
  check('译文进了对照栏', !!(e0 && e0.translation), e0 && e0.translation)
  const snap1 = [...(window.__sent || [])].reverse().find((m) => m.action === 'readerSync')
  check('译文已同步给侧栏', !!(snap1 && snap1.snapshot.entries.length === 1),
    snap1 && snap1.snapshot.entries.length)
  check('译文条目带着锚点', !!(e0 && e0.anchors && e0.anchors.length === 1 && e0.anchors[0].start === 0))

  // ── 高亮落在原文上（不改文字层 DOM）────────────────────────────────────
  T.refreshHighlights()
  check('用 CSS Custom Highlight 标出原文', !!(window.CSS && CSS.highlights && CSS.highlights.has('rd-src')))
  check('文字层 DOM 没有被改动（还是 span，没有包一层）',
    !!(p2.layer && p2.layer.querySelectorAll('span').length > 0 && p2.layer.querySelectorAll('mark, .rd-hl').length === 0))

  const rectsBefore = T.anchorRects()
  const firstRect = rectsBefore[0] && rectsBefore[0].rects[0]
  check('锚点能解出屏幕矩形', !!firstRect, JSON.stringify(firstRect))
  if (firstRect) {
    const pageRect = p2.wrap.getBoundingClientRect()
    check('矩形落在这一页的范围内',
      firstRect[0] >= pageRect.left - 2 && firstRect[0] + firstRect[2] <= pageRect.right + 2,
      JSON.stringify([Math.round(pageRect.left), Math.round(pageRect.right), firstRect]))
  }

  // ── 缩放：锚点必须还在同一处文字上 ───────────────────────────────────────
  const textBefore = e0.source
  await T.setScale(2.0)
  await sleep(400)
  T.refreshHighlights()
  const rectsAfter = T.anchorRects()
  const rectAfter = rectsAfter[0] && rectsAfter[0].rects[0]
  check('缩放后锚点仍然解得出来', !!rectAfter, JSON.stringify(rectAfter))
  check('缩放后仍指向同一段原文', T.anchorsText([{ page: 2, start: e0.anchors[0].start, end: e0.anchors[0].end }]) === textBefore,
    T.anchorsText([{ page: 2, start: e0.anchors[0].start, end: e0.anchors[0].end }]).slice(0, 50))
  if (firstRect && rectAfter) {
    check('缩放后矩形变大了（说明真的缩放了）', rectAfter[2] > firstRect[2], firstRect[2] + ' → ' + rectAfter[2])
  }
  check('文字层节点没有被重建（缩放走的是 update）', T.state.pages[1].layer.querySelectorAll('span').length > 0)

  // 锚点在文字层被重建后依然成立：清掉这页重渲染一次
  const layerSpans = p2.layer.querySelectorAll('span').length
  const reRange = (() => {
    const r = T.state.pages[1]
    return r && r.layer ? r.layer.querySelectorAll('span')[0].textContent : ''
  })()
  check('拿到缩放后的首行文字（用于对照）', !!reRange, reRange.slice(0, 40) + ' (spans=' + layerSpans + ')')

  out.summary = {
    pages: T.state.doc.numPages,
    entries: T.state.entries.length,
    srcText: srcText.slice(0, 80),
    translation: e0 && e0.translation,
    rectBefore: firstRect,
    rectAfter: rectAfter,
  }

  // ── 图片页（模拟扫描件）：必须真的画出东西来，且被识别为无文字 ──────────
  T.gotoPage(3, false)
  await waitFor(() => T.state.pages[2] && T.state.pages[2].rendered, 15000)
  const img = T.state.pages[2]
  check('图片页渲染完成', !!(img && img.rendered))
  check('图片页真的画出了内容（不是空白）', !!(img && img.canvasBlank === false), img && img.canvasBlank)
  check('图片页没有文字层', !!(img && (img.textChars || 0) < 20), img && img.textChars)
  // 这本书前两页有文字，所以**不该**被当成扫描件
  check('有文字的 PDF 不显示"扫描件"提示', document.getElementById('rd-scan-hint').hidden === true)
  out.summary.imagePage = {
    canvasBlank: img && img.canvasBlank,
    textChars: img && img.textChars,
    canvas: img && img.canvas ? [img.canvas.width, img.canvas.height] : null,
    scanHintHidden: document.getElementById('rd-scan-hint').hidden === true,
    renderError: T.state.lastRenderError || null,
  }

  // 保存是防抖的：等它真的落盘，否则第二段场景（刷新后）什么都读不到
  await sleep(1200)
  out.savedKeys = await allRecordKeys()
  check('译文与进度已落盘（供刷新后验证）', out.savedKeys.length === 1, JSON.stringify(out.savedKeys))
} catch (e) {
  out.errors.push(String((e && e.stack) || e))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
