/**
 * CoRead 自检：在**真实浏览器环境**里跑一遍关键流程，把结果写成 JSON。
 *
 * ── 为什么需要它（2026-11）──────────────────────────────────────────────────
 * Chrome 137 起 `--load-extension` 被移除（本机实测，最小扩展也装不进去）。
 * 于是 test/selftest 那套无头自测**装不进扩展**，侧栏与阅读器里那些用到 chrome.* API
 * 的东西，自动化一次都没在真环境验过——只能靠人肉点、口述现象，来回猜。
 *
 * 这个页面把那条路补上：由**扩展自己**（它有全部 API 权限）跑真实流程，
 * 结果 POST 到接收端落成 `logs\selfcheck.json`，开发者读那个文件就能定位问题。
 *
 * ── 2026-10-20 改版：不再有"内置教程书" ─────────────────────────────────────
 * 教程改成一本文档排版好的真 PDF（作者放进阅读器书库）。所以自检不再拿"那本一定要
 * 存在的教程书"当靶子，而是**从书库里挑第一本真 PDF**来验：打开、目录、跳页、
 * 划词、侧栏认书、切换引用。书库是空的（新装 + 没放过 PDF）时，书相关的那几段
 * 如实报"跳过"，不写假断言。
 */

const RECEIVER = 'http://127.0.0.1:7239'
const checks = []
const out = { startedAt: new Date().toISOString(), version: '', checks, errors: [] }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) })
  render()
  return !!ok
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
  }
  return false
}

function render() {
  const list = document.getElementById('out')
  if (!list) return
  list.innerHTML = checks.map((c) =>
    `<div class="row"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span>` +
    `<span class="name">${esc(c.name)}</span><span class="detail">${esc(c.detail || '')}</span></div>`).join('')
  const passed = checks.filter((c) => c.ok).length
  const sum = document.getElementById('summary')
  if (sum) sum.textContent = `已跑 ${checks.length} 项，通过 ${passed}，失败 ${checks.length - passed}`
}
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))

/** 找（或开）阅读器标签页 */
async function readerTab() {
  const url = chrome.runtime.getURL('reader.html') + '*'
  let tabs = await chrome.tabs.query({ url }).catch(() => [])
  if (tabs && tabs.length) return tabs[0]
  const t = await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html'), active: false })
  await sleep(1200)
  return t
}

/**
 * 让阅读器执行一个**预定义操作**并取回值。
 *
 * ⚠️ 只传操作名，**不传代码**：MV3 的 CSP 是 `script-src 'self'`，动态求值一律拒绝
 *（踩过：自检的十几项全报"阅读器拒绝执行"）。阅读器那边是一张操作表 SELFCHECK_OPS。
 *
 * 失败时**必须把原因带回报告**：sendMessage 有几种失败不抛异常（标签页还在加载、
 * 没有监听者时会 resolve 成 undefined），原先把价值写成 `{}`，报告里只剩空括号。
 */
async function readerOp(tabId, op, arg) {
  if (!tabId) return { ok: false, error: '没有标签页 id' }
  let r
  try {
    r = await chrome.tabs.sendMessage(tabId, { action: 'selfcheckEval', op, arg })
  } catch (e) {
    return { ok: false, error: 'sendMessage 抛错：' + String((e && e.message) || e) }
  }
  if (r === undefined || r === null) {
    return { ok: false, error: '阅读器没有回应（页面还没加载完 / 没有装监听者？）' }
  }
  if (typeof r !== 'object') return { ok: false, error: '回应不是对象：' + typeof r }
  if (!Object.keys(r).length) {
    return { ok: false, error: '阅读器回应为空对象 —— 通常是那边没在异步响应前 return true' }
  }
  if (r.ok === false) return { ok: false, error: '阅读器拒绝执行：' + String(r.error || '未说明') }
  return r
}

/** 侧栏的真实状态（问 `coreadSidebarProbe`，只读） */
async function probeSidebar() {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ action: 'coreadSidebarProbe' }),
      new Promise((res) => setTimeout(() => res({ ok: false, error: '侧栏没有回应（没开着？）' }), 2500)),
    ])
    return r || { ok: false, error: '没有回应' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 让侧栏**真的做一个动作**（点按钮），不是只问状态。
 *
 * 为什么要这条通道：自检能**问**侧栏（probeSidebar），但点不了——`chrome.scripting` /
 * `tabs.sendMessage` 只能注入**网页**，侧栏是扩展自己的页面，没有 API 能从外面注入。
 * 所以"点一下会怎样"只能在侧栏内部发生：那边有一张动作表，这里报动作名。
 */
async function sidebarOp(op, arg) {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ action: 'coreadSelfcheckOp', op, arg }),
      new Promise((res) => setTimeout(() => res({ ok: false, error: '侧栏没有回应（没开着？）' }), 2500)),
    ])
    return r || { ok: false, error: '没有回应' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 给扩展里这几个关键文件算**指纹**（内容 SHA-256 前 12 位）。
 *
 * 为什么必须有：manifest 的 version 改一次不容易，而代码可能改了几十遍——光看版本号，
 * 开发者分不清"你跑的是哪一版代码"，于是会拿旧代码猜新问题（实测踩过这种糊涂账）。
 */
async function fingerprint() {
  const files = [
    'manifest.json', 'reader.js', 'reader.html', 'sidebar.js', 'sidebar.html',
    'translate-background.js', 'service_worker.js', 'selfcheck.js', 'graph-view.js',
  ]
  const out = {}
  for (const f of files) {
    try {
      const buf = await (await fetch(chrome.runtime.getURL(f))).arrayBuffer()
      const d = await crypto.subtle.digest('SHA-256', buf)
      out[f] = [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch (e) {
      out[f] = 'ERR'
    }
  }
  return out
}

/** 挑一本书库里的真 PDF 当靶子（没有就返回 null，后面几段如实跳过） */
async function pickLibraryBook() {
  try {
    const r = await fetch(RECEIVER + '/reader-books')
    if (!r.ok) return null
    const d = await r.json()
    const list = (d && Array.isArray(d.books)) ? d.books : []
    const withFile = list.filter((b) => b && b.hash && b.hasFile !== false)
    const b = withFile[0] || null
    return b ? { hash: String(b.hash), name: String(b.name || ''), pages: Number(b.pages) || 0 } : null
  } catch (e) {
    return null
  }
}

async function run() {
  const btn = document.getElementById('run')
  if (btn) btn.disabled = true
  // ⚠️ 每次跑都要把结果清空：checks 是模块级的，不清就会**跨次累积**，
  // 同一页面跑第二遍时报告里会出现双份，失败项混进来看着像"这次又坏了"。
  checks.length = 0
  out.errors.length = 0
  out.checks = checks
  out.startedAt = new Date().toISOString()

  try {
    // ── 1. 扩展环境 ──────────────────────────────────────────────────────────
    const mf = chrome.runtime.getManifest()
    out.version = mf.version || ''
    check('扩展环境正常（拿得到 manifest）', !!mf.name, mf.name + ' ' + mf.version)
    out.files = await fingerprint()
    check('关键文件指纹都算得出来（不是一堆 ERR）',
      Object.values(out.files).filter((v) => v === 'ERR').length === 0, JSON.stringify(out.files))

    // ── 2. storage 能写能读 ─────────────────────────────────────────────────
    const probeKey = 'selfcheck:probe'
    await chrome.storage.local.set({ [probeKey]: { at: Date.now() } })
    const back = await chrome.storage.local.get(probeKey)
    check('chrome.storage.local 能写能读', !!(back && back[probeKey] && back[probeKey].at), JSON.stringify(back))
    await chrome.storage.local.remove(probeKey)

    // ── 3. 挑一本真 PDF（书库里的第一本）────────────────────────────────────
    const book = await pickLibraryBook()
    out.book = book
    check('书库里至少有一本 PDF（自检的靶子）', !!book,
      book ? book.name + ' / ' + book.hash.slice(0, 12) : '书库是空的：先在阅读器里「打开 PDF」放一本进来')

    if (!book) {
      // 书相关的那几段没得跑。如实报，不写假绿。
      check('书相关检查（打开/目录/划词/侧栏认书）', false, '书库为空，整段跳过')
    } else {
      // ── 4. 打开这本书 ────────────────────────────────────────────────────
      const bookId = 'rd_' + book.hash
      const opened = await chrome.runtime.sendMessage({ action: 'openReaderBook', base: bookId, name: book.name })
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      out.openReaderBook = opened
      check('后台 openReaderBook 返回成功', !!(opened && opened.ok), JSON.stringify(opened))
      check('后台回报的 URL 里带 ?open=（这是它该做到的事）',
        !!(opened && /[?&]open=/.test(String(opened.url || ''))), String(opened && opened.url))

      const tab = await readerTab()
      check('阅读器标签页真的开了/切过来了', !!(tab && tab.id), 'tabId=' + (tab && tab.id))

      let alive = null
      for (let i = 0; i < 10 && tab && tab.id; i++) {
        alive = await readerOp(tab.id, 'alive')
        if (alive && alive.ok && alive.value === 'object') break
        await sleep(700)
      }
      check('阅读器页面的自测入口活着（模块没报错）', !!(alive && alive.ok && alive.value === 'object'),
        JSON.stringify(alive))

      if (tab && tab.id && alive && alive.ok) {
        const okOpen = await waitFor(async () => {
          const s = await readerOp(tab.id, 'hasBook')
          return !!(s && s.ok && s.value === true)
        }, 15000)
        check('这本书已经在阅读器里打开', okOpen)

        const idRes = await readerOp(tab.id, 'bookId')
        out.bookId = idRes && idRes.value
        check('阅读器认这本书的共读侧 ID（侧栏据此归属）', !!(idRes && idRes.ok && idRes.value === bookId),
          String(idRes && idRes.value) + ' 期望 ' + bookId)

        const info = await readerOp(tab.id, 'pageInfo')
        check('状态栏显示"第几页/共几页"', !!(info && info.ok && /第\s*\d+\s*\/\s*\d+/.test(String(info.value))),
          JSON.stringify(info && info.value))

        // ── 5. 目录：能打开、能跳 ──────────────────────────────────────────
        const toc = await readerOp(tab.id, 'tocOpen')
        out.toc = toc && toc.value
        check('目录能打开并且有条目', !!(toc && toc.ok && toc.value && toc.value.items > 0), JSON.stringify(toc && toc.value))
        if (toc && toc.ok && toc.value && toc.value.items > 1) {
          const jumped = await readerOp(tab.id, 'tocJump', toc.value.items - 1)
          check('点目录里的最后一条真的跳过去了', !!(jumped && jumped.ok && jumped.value && jumped.value.jumped),
            JSON.stringify(jumped && jumped.value))
        }

        // ── 6. 「跳到原文」那条链路 ────────────────────────────────────────
        const loc = await readerOp(tab.id, 'locateProbe', '自检定位探针 · ' + Date.now())
        out.locateProbe = loc && loc.value
        check('定位不到时如实回报 found:false（不假装成功）',
          !!(loc && loc.ok && loc.value && typeof loc.value.found === 'boolean'))

        // ── 7. 划词 → 浮标 → 设为引用（真实链路，不 mock）──────────────────
        const sel = await readerOp(tab.id, 'selectParagraph')
        out.selectParagraph = sel && sel.value
        check('能在正文上划出选区', !!(sel && sel.ok && sel.value && sel.value.chars > 5), JSON.stringify(sel && sel.value))
        check('划词后浮出浮标', !!(sel && sel.ok && sel.value && sel.value.tipVisible), JSON.stringify(sel && sel.value))

        const ref = await readerOp(tab.id, 'submitSelection')
        check('点浮标真的把这段设成了引用', !!(ref && ref.ok && ref.value && ref.value.ok),
          JSON.stringify(ref && ref.value))

        // 用户 2026-11 报的 bug：设完了、后台也存了，但书页上被划的那一段没有任何标记。
        // 只看 submitSelection 的返回值发现不了它，必须问阅读器"画出来了几道线"。
        const refMark = await readerOp(tab.id, 'refMarkProbe')
        out.refMark = refMark && refMark.value
        check('设为引用之后，被引用的那一段在书页上有标记',
          !!(refMark && refMark.ok && refMark.value && refMark.value.ranges > 0),
          JSON.stringify(refMark && refMark.value))

        // ── 8. 侧栏：认书 + 切换引用（真点）────────────────────────────────
        const sb = await probeSidebar()
        out.sidebarProbe = sb
        check('侧栏有回应（自检能读到它的真实状态）', !!(sb && sb.ok), JSON.stringify(sb && sb.error))
        if (sb && sb.ok) {
          check('侧栏认得出当前这本书', sb.bookBase === bookId, 'bookBase=' + String(sb.bookBase).slice(0, 24))
          out.sidebarButtons = sb.refCardButtons
          check('引用卡上的按钮都能被识别', Array.isArray(sb.refCardButtons) && sb.refCardButtons.length >= 2,
            JSON.stringify(sb.refCardButtons))

          const before = await sidebarOp('state')
          const clicked = await sidebarOp('clickSwitchRef')
          check('端到端：真的点到了「切换引用」那个按钮', !!(clicked && clicked.ok), JSON.stringify(clicked))
          await sleep(1200)
          const after = await sidebarOp('state')
          out.refSwitch = { before, clicked, after }
          check('点完之后当前书**没有**被清空（用户报过的那一跳）',
            !!(after && after.ok && !!after.book && after.book === (before && before.book)),
            'before=' + String(before && before.book).slice(0, 24) + ' after=' + String(after && after.book).slice(0, 24))
          check('点完之后抽屉真的开了', !!(after && after.ok && after.drawer === true), JSON.stringify(after))
          check('抽屉里摆出了引用', !!(after && after.ok && after.drawerItems > 0),
            'drawerItems=' + String(after && after.drawerItems))
        }
      }
    }

    // ── 9. 快捷键与侧栏上下文（阅读器那边的两条真环境探针）────────────────
    const reader = await readerTab()
    if (reader && reader.id) {
      const cmds = await readerOp(reader.id, 'commands')
      out.commands = cmds && cmds.value
      const openCmd = Array.isArray(out.commands) ? out.commands.find((c) => c.name === '_execute_action') : null
      check('打开侧栏的快捷键注册上了（没注册的话提示就是空头支票）',
        !!(openCmd && openCmd.shortcut), JSON.stringify(out.commands))
      const ctx = await readerOp(reader.id, 'sidePanelContexts')
      out.sidePanelContexts = ctx && ctx.value
      check('能查到侧栏上下文（getContexts 可用）',
        !!(ctx && ctx.ok && ctx.value && ctx.value.supported !== false), JSON.stringify(ctx && ctx.value))
    }
  } catch (e) {
    out.errors.push(String((e && e.stack) || e))
    check('自检过程没抛异常', false, String((e && e.message) || e))
  }

  out.ok = checks.every((c) => c.ok)
  out.passed = checks.filter((c) => c.ok).length
  out.total = checks.length
  out.finishedAt = new Date().toISOString()
  if (btn) btn.disabled = false
  return out
}

/**
 * 把报告送到本机服务（`POST /selfcheck` → `logs\selfcheck.json`）。
 *
 * 两段降级：主通道不通就走 `/debug`（旧版接收端也有这个口子），再不通就**下载**一份
 * `coread-selfcheck.json` —— 用户把它发给助手，别让这一趟白跑。
 */
async function upload(payload) {
  let uploaded = false
  let where = ''
  try {
    const r = await fetch(RECEIVER + '/selfcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (r.ok) {
      const d = await r.json().catch(() => null)
      uploaded = true
      where = (d && d.file) || 'logs\\selfcheck.json'
    } else where = 'HTTP ' + r.status
  } catch (e) { where = String((e && e.message) || e) }

  if (!uploaded) {
    try {
      const r2 = await fetch(RECEIVER + '/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ source: 'selfcheck', stage: 'report' }, payload)),
      })
      if (r2.ok) { uploaded = true; where = 'logs\\debug.jsonl（旧版接收端的降级通道，source=selfcheck）' }
    } catch (e) {}
  }

  if (!uploaded) {
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'coread-selfcheck.json'
      a.click()
      where = '已下载 coread-selfcheck.json'
    } catch (e) {}
  }
  return { uploaded, where }
}

window.__selfcheck = async function () {
  const rep = await run()
  const sum = document.getElementById('summary')
  if (sum) sum.textContent = `跑完：${rep.passed}/${rep.total}` + (rep.ok ? ' ✅ 全过' : ' ❌ 有失败')
  const payload = {
    ok: rep.ok, passed: rep.passed, total: rep.total, version: rep.version,
    files: rep.files, book: rep.book, bookId: rep.bookId,
    checks: rep.checks, errors: rep.errors, toc: rep.toc, selectParagraph: rep.selectParagraph,
    locateProbe: rep.locateProbe, refMark: rep.refMark, sidebarProbe: rep.sidebarProbe, sidebarButtons: rep.sidebarButtons,
    refSwitch: rep.refSwitch, openReaderBook: rep.openReaderBook,
    commands: rep.commands, sidePanelContexts: rep.sidePanelContexts,
    startedAt: rep.startedAt, finishedAt: rep.finishedAt,
  }
  const up = await upload(payload)
  payload.uploaded = up.uploaded
  payload.uploadedWhere = up.where
  const fileEl = document.getElementById('file')
  if (fileEl) {
    fileEl.textContent = up.uploaded
      ? `报告已送到本机服务：${up.where} —— AI 助手读这个就能看到结果`
      : '本机服务没接收（它没在运行？）—— 报告已下载，把它发给 AI 助手'
  }
  return payload
}

document.getElementById('run')?.addEventListener('click', () => { window.__selfcheck().catch(() => {}) })
