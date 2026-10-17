/**
 * CoRead 自检：在**真实浏览器环境**里跑一遍关键流程，把结果写成 JSON。
 *
 * ── 为什么需要它（2026-11）──────────────────────────────────────────────────
 * Chrome 137 起 `--load-extension` 被移除（本机 154 实测，最小扩展也装不进去；
 * 替代路 CDP `Extensions.loadUnpacked`、写 Preferences 预装、Edge，全试过，都不行）。
 * 于是 test/selftest 那套无头自测**装不进扩展**，侧栏与阅读器里那些用到
 * chrome.* API 的东西，自动化一次都没在真环境验过——只能靠人肉点、口述现象，来回猜。
 *
 * 这个页面把那条路补上：由**扩展自己**（它有全部 API 权限）跑真实流程，
 * 结果 POST 到接收端落成 `logs\selfcheck.json`，开发者读那个文件就能定位问题。
 *
 * ── 它测什么、不测什么 ──────────────────────────────────────────────────────
 * 测：真实扩展环境里的模块加载、书 ID 一致性、storage、后台消息、开标签页、
 *     阅读器里的目录跳章与划词共读、侧栏真的被打开、引导层能在真页面里画出来。
 * 不测：需要在侧栏里连续点六下的那条引导脚本（那靠 test/selftest 的夹具覆盖了逻辑，
 *     真环境里由用户点一次「教程」自己看）。
 */

import { TUTORIAL_HEX, TUTORIAL_BOOK_ID, TUTORIAL_STORE_KEY, loadBook, title, chapterCount, toc, openChapter, lessonIndex } from './tutorial/index.js'
import * as Guide from './tutorial-guide.js'
import * as Script from './tutorial-script.js'

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
  list.innerHTML = checks.map((c) =>
    `<div class="row"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span>` +
    `<span class="name">${esc(c.name)}</span><span class="detail">${esc(c.detail || '')}</span></div>`).join('')
  const passed = checks.filter((c) => c.ok).length
  document.getElementById('summary').textContent = `已跑 ${checks.length} 项，通过 ${passed}，失败 ${checks.length - passed}`
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
 * 侧栏的真实状态（2026-11 用户要求"再弄一点自检"）。
 *
 * 为什么要这个：用户连报几轮"例句没有 / 还是不行"，而我只能从 debug 日志反推
 * "他点的是哪个按钮、抽屉里到底有没有东西"——查得慢，还猜错过。这条把侧栏**问一遍**：
 * 例句数据读到没、抽屉里渲染出几条、当前书认出来没、教程走到第几步、卡片上有哪些按钮。
 * 全是可读的事实。
 *
 * 侧栏没开着时**不会**有回音，所以带超时——如实回报"没问到"，不假装成功。
 */
async function probeSidebar() {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ action: 'coreadTutorialProbe', want: 'all' }),
      new Promise((res) => setTimeout(() => res({ ok: false, error: '侧栏没有回应（没开着？）' }), 2500)),
    ])
    return r || { ok: false, error: '没有回应' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 让侧栏**真的做一个动作**（2026-11 用户质问"为什么不能用插件内的来试试看"之后加的）。
 *
 * 与 `probeSidebar()` 的分工：
 *   · probeSidebar = **问**侧栏现在什么样（只读）
 *   · sidebarOp   = 让侧栏**做**一件事（真的点那个按钮）
 *
 * 为什么必须分开：用户连报的"点切换引用之后底层界面跳回选书界面"，问的时候一切正常，
 * 点下去才出事——只问不点，永远看不见它。
 *
 * ⚠️ 传的是**动作名**（侧栏那边有一张表），不是代码：CSP 禁 `eval`/`new Function`。
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
 * 为什么必须有：manifest 的 version 是 1.0.1，改多少次都一样 —— 光看版本号，
 * 开发者分不清"你跑的是哪一版代码"，于是会拿旧代码猜新问题（实测踩过这种糊涂账）。
 * 有了指纹，直接和仓库里的源文件逐字比对就知道差在哪几个文件上。
 */
async function fingerprint() {
  const files = [
    'manifest.json', 'reader.js', 'reader.html', 'sidebar.js', 'sidebar.html',
    'translate-background.js', 'service_worker.js', 'selfcheck.js',
    'tutorial/index.js', 'tutorial/render.js', 'tutorial/lessons.js',
    'tutorial/tutorial.css', 'tutorial/book/book.json',
    'tutorial-guide.js', 'tutorial-script.js',
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

/**
 * 阅读器页面到底活没活：重试若干次问它 `typeof window.__readerTest`。
 *
 * 为什么单独抽出来：它是**唯一**可信的"阅读器正常"判据（URL 不行，见下），
 * 而且要在两个地方用（兜底导航前判一次、正式检查时再判一次）。
 * 页面可能还在加载，所以重试；但**最后一次的原始错误要带回来**，
 * 否则报告里只剩一个 `{}`，我又得猜（上一轮就是）。
 */
async function readerAlive(tabId, tries = 8) {
  let r = null
  for (let i = 0; i < tries; i++) {
    r = await readerOp(tabId, 'alive')
    if (r && r.ok && r.value === 'object') return r
    await sleep(700)
  }
  return r
}

/**
 * 让阅读器执行一个**预定义操作**并取回值。
 *
 * ⚠️ 只传操作名，**不传代码**（2026-11 被浏览器拦死过一次）：
 * 原先是 `new Function('return (' + expression + ')')` 在阅读器页面里求值，
 * 而 MV3 的 CSP 是 `script-src 'self'`，动态求值一律拒绝：
 *   "Evaluating a string as JavaScript violates ... script-src 'self'"
 * 自检的十几项因此全报"阅读器拒绝执行"。**而且夹具里查不出来**——
 * 夹具是普通网页、没有那行 CSP 头（已修：serve.mjs 现在给它加同样的头）。
 * 现在阅读器那边是一张**操作表**（reader.js 的 SELFCHECK_OPS），这里只报名字。
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
  // 空对象是最难查的一种：它意味着"消息通道在异步响应之前就关了"（监听函数没 return true），
  // 或者对面根本没处理这个消息。挑明它，别让报告里只留一个 {}（踩过，查了半天）
  if (!Object.keys(r).length) {
    return { ok: false, error: '阅读器回应为空对象 —— 通常是那边没在异步响应前 return true，或没处理这条消息' }
  }
  if (r.ok === false) return { ok: false, error: '阅读器拒绝执行：' + String(r.error || '未说明') }
  return r
}

async function run() {
  const btn = document.getElementById('run')
  btn.disabled = true
  // ⚠️ 每次跑都要把结果清空（2026-11 踩到）：checks 是模块级的，不清就会**跨次累积**——
  // 同一页面上跑第二遍时，报告里是 27+27=54 项，而且上一次的失败项会混进来，
  // 看起来像"这次又坏了"。自测夹具连跑四次，就是这么把这个 bug 逼出来的。
  checks.length = 0
  out.errors.length = 0
  out.checks = checks
  out.startedAt = new Date().toISOString()
  render()
  try {
    // ── 1. 扩展环境本身 ────────────────────────────────────────────────────
    const mf = chrome.runtime.getManifest()
    out.version = mf.version
    out.extensionId = chrome.runtime.id
    check('扩展环境正常（拿得到 manifest）', !!mf.name, mf.name + ' ' + mf.version)

    // 文件指纹：开发者据此判断"你跑的是哪一版代码"（版本号 1.0.1 改多少次都不变）
    out.files = await fingerprint()

    // ── 2. 书 ID：三处常量必须一致（这里能读到两处，接收端那处在报告里由 AI 比对源码）──
    check('教程书 ID 是 64 位十六进制', /^[a-f0-9]{64}$/.test(TUTORIAL_HEX), TUTORIAL_HEX)
    check('共读侧 ID 形态与 PDF 一致（rd_ + 哈希）', TUTORIAL_BOOK_ID === 'rd_' + TUTORIAL_HEX, TUTORIAL_BOOK_ID)
    out.ids = { hex: TUTORIAL_HEX, bookId: TUTORIAL_BOOK_ID, storeKey: TUTORIAL_STORE_KEY }

    // ── 3. 教程书内容读得出来（七章、每章有标题）────────────────────────────
    await loadBook()
    const tocData = toc()
    check('教程书读得出来，共 7 章', chapterCount() === 7, chapterCount())
    check('每章都有标题', tocData.every((c) => c.title && c.title.length > 1), tocData.map((c) => c.num + c.title).join(' '))
    out.tutorial = { title: title(), chapters: tocData.map((c) => c.title) }

    // ── 4. chrome.storage 能写能读 ────────────────────────────────────────
    const probeKey = 'selfcheck:probe'
    await chrome.storage.local.set({ [probeKey]: { at: Date.now() } })
    const back = await chrome.storage.local.get(probeKey)
    check('chrome.storage.local 能写能读', !!(back && back[probeKey] && back[probeKey].at), JSON.stringify(back))
    await chrome.storage.local.remove(probeKey)

    // ── 5. 引导层能在真页面里画出来（挖洞 = 四块遮罩）──────────────────────
    const target = document.getElementById('run')
    Guide.showStep({ step: '1 / 1', title: '自检：引导层', body: '这条是自检画的，跑完自动收掉。', target })
    await sleep(350)
    const g = window.__tutorialScript.guide()
    check('引导层能起来', g.active === true, JSON.stringify(g))
    check('遮罩挖了四块（挖洞=四块围一圈）', g.masks === 4, 'masks=' + g.masks)
    check('高亮框落在指定元素上', !!(g.target && g.target.rect[2] > 10), JSON.stringify(g.target))
    Guide.hide()
    await sleep(150)
    check('引导层能收掉', window.__tutorialScript.guide().active === false)

    // ── 6. 主控状态能存能取（教程脚本的状态就靠它跨"侧栏重开"活下来）──────
    // ⚠️ 参数是**课号**（lessons.js 里的下标），不是书 ID。
    // 这里原来还写着旧签名 `Script.start({ bookId })`——不报错（`Number({})` 是 NaN，
    // 被 `|| 0` 兜住），于是自检永远只验到"第 0 课"，而真实调用方万一也这么写就静默开错课。
    // 自测里当场报出 `Tutorial is not defined` 才发现这处没跟着改。
    await Script.start(0)
    await sleep(250)
    const saved = await chrome.storage.local.get('tutorialRun')
    check('教程状态写进了 storage（侧栏重开还能接上）', !!(saved && saved.tutorialRun && saved.tutorialRun.active),
      JSON.stringify(saved && saved.tutorialRun))
    out.script = Script.state()
    await Script.stop('自检')

    // ── 7. 后台：打开阅读器里的那本书（用户反馈 ① 的那条链路）──────────────
    const opened = await chrome.runtime.sendMessage({ action: 'openReaderBook', base: TUTORIAL_BOOK_ID, name: '第一次共读' }).catch((e) => ({ ok: false, error: String(e.message || e) }))
    out.openReaderBook = opened
    check('后台 openReaderBook 返回成功', !!(opened && opened.ok), JSON.stringify(opened))
    check('后台回报的 URL 里带 ?open=（这是它该做到的事）',
      !!(opened && typeof opened.url === 'string' && /\?open=[a-f0-9]{16,64}/.test(opened.url)),
      JSON.stringify(opened && opened.url))
    await sleep(1500)
    let tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('reader.html') + '*' }).catch(() => [])
    check('阅读器标签页真的开了/切过来了', tabs.length > 0, '共 ' + tabs.length + ' 个阅读器标签页')
    out.readerTabs = tabs.map((t) => ({ id: t.id, url: t.url, status: t.status, discarded: !!t.discarded }))

    // ⚠️ **不要拿"标签页 URL 里还留着 ?open="当断言**（我上一版就这么错了，白报了两条假失败）：
    // 阅读器的设计是"打开完那本书就把查询串抹掉"（history.replaceState，见 reader.js 的
    // handleOpenParam）——为的是刷新页面时不重复打开。所以 URL 里没有 ?open= 是**正常**的。
    // 真正该问的是"阅读器有没有被导航到那一本"，而那只有一个可信判据：
    // **页面自己报它开着哪本书**（下面那几项）。
    let tabUrl = tabs[0] ? tabs[0].url : ''
    out.readerTabsAfterOpen = { id: tabs[0] && tabs[0].id, url: tabUrl, status: tabs[0] && tabs[0].status }

    // 兜底：轮询不到阅读器再自己导航一次（换来"其余项目仍测得到"，
    // 而不是让十几项全塌——塌下来只会让报告看起来像"阅读器整个废了"）
    if (tabs[0] && !(await readerAlive(tabs[0].id, 2))) {
      const want = chrome.runtime.getURL('reader.html') + '?open=' + TUTORIAL_HEX
      out.navTrace = []
      const snap = async (label) => {
        const list = await chrome.tabs.query({ url: chrome.runtime.getURL('reader.html') + '*' }).catch(() => [])
        const t = list[0] || {}
        return { label, count: list.length, id: t.id, url: t.url, status: t.status, title: t.title }
      }
      out.navTrace.push(await snap('before'))
      await chrome.tabs.update(tabs[0].id, { url: want }).catch((e) => { out.navTrace.push({ label: 'update-error', error: String((e && e.message) || e) }) })
      out.navTrace.push(await snap('right-after-update'))
      await sleep(2500)
      out.navTrace.push(await snap('after-2.5s'))
      tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('reader.html') + '*' }).catch(() => [])
      tabUrl = tabs[0] ? tabs[0].url : ''
      out.readerTabsAfterFix = { id: tabs[0] && tabs[0].id, url: tabUrl, status: tabs[0] && tabs[0].status }
    }

    // ── 8. 阅读器那边：教程书打开了吗、目录能不能跳章（用户反馈 ②）──────────
    const tab = tabs[0]
    if (tab) {
      const alive = await readerAlive(tab.id, 8)
      out.readerAlive = alive
      check('阅读器页面的自测入口活着（模块没报错）', !!(alive && alive.ok && alive.value === 'object'),
        JSON.stringify(alive))

      const snap = await readerOp(tab.id, 'tutorialSnapshot')
      out.tutorialSnapshot = snap && snap.value
      check('教程书已经在阅读器里打开', !!(snap && snap.ok && snap.value && snap.value.open === true),
        JSON.stringify(snap))

      const name = await readerOp(tab.id, 'bookName')
      check('书名校验（书名显示为这本手册）', !!(name && name.ok && /第一次共读/.test(String(name.value))), JSON.stringify(name))

      const hasBook = await readerOp(tab.id, 'hasBook')
      check('阅读器认它为"当前这本书"（侧栏据此归属）', !!(hasBook && hasBook.ok && hasBook.value === true), JSON.stringify(hasBook))

      const bookId = await readerOp(tab.id, 'bookId')
      check('共读侧 ID 与常量一致', !!(bookId && bookId.ok && bookId.value === TUTORIAL_BOOK_ID), JSON.stringify(bookId))

      // 目录：打开 → 七章 → 点最后一条真的跳过去
      const tocOpen = await readerOp(tab.id, 'tocOpen')
      out.toc = tocOpen && tocOpen.value
      check('阅读器的目录能打开并且列出七章',
        !!(tocOpen && tocOpen.ok && tocOpen.value && tocOpen.value.items === 7), JSON.stringify(tocOpen))

      const jumped = await readerOp(tab.id, 'tocJump', 6)
      out.tocJump = jumped && jumped.value
      // 判据用三样一起看：跳章真的落到第 7 章、书的"当前章"跟着变、状态栏也跟着变。
      // 只看 currentIndex 不够——上一版就是它暴露了"滚动到了但当前章没变"的真 bug；
      // 只看状态栏也不够——那可能只是渲染到了。三个都对才算真的跳过去了。
      check('点目录里的最后一章真的跳过去了（章序 = 6、状态栏 = 第 7 章）',
        !!(jumped && jumped.ok && jumped.value && jumped.value.jumped &&
           jumped.value.index === 6 && /第\s*7\s*\/\s*7\s*章/.test(String(jumped.value.info))),
        JSON.stringify(jumped && jumped.value))

      const info = await readerOp(tab.id, 'pageInfo')
      check('状态栏显示"第几章"', !!(info && info.ok && /章/.test(String(info.value))), JSON.stringify(info))

      // ── 8b. 书里的「开始本课」→ 侧栏引导（这一版的核心链路，2026-11 合并两套之后）──
      // 先翻到第 2 章（那一章有课）
      await readerOp(tab.id, 'tocJump', 1)
      const card = await readerOp(tab.id, 'lessonCard')
      out.lessonCard = card && card.value
      check('第 2 章里有「开始本课」入口',
        !!(card && card.ok && card.value && card.value.exists && card.value.chapter === 2), JSON.stringify(card && card.value))
      check('课块上写着这一课的标题',
        !!(card && card.ok && card.value && String(card.value.title || '').length > 4), String(card && card.value && card.value.title))

      const started = await readerOp(tab.id, 'startLesson')
      out.startLesson = started && started.value
      // 关键：**中间那一步也要核**。这一环断了不会报错，只是点了没反应
      check('点「开始本课」把引导状态真的写进了存储（书 → 侧栏的接力棒）',
        !!(started && started.ok && started.value && started.value.wrote),
        JSON.stringify(started && started.value && started.value.run))
      // ⚠️ 判据用「第 2 章那一课**在课程表里的下标**」，不能写死 1（2026-11 我写错过）：
      // 第 2 章是**第一课**（第 1 章没课），所以它对应的 lesson 是 0。
      // 写死 1 的结果是这条断言永远失败——把它当成产品 bug 查就白费一轮。
      const expectLesson = lessonIndex(2)
      check('写进去的是第 2 章那一课（课号按课程表的下标）',
        !!(started && started.ok && started.value && started.value.run &&
           started.value.run.lesson === expectLesson),
        `期望 lesson=${expectLesson}，实得 ${JSON.stringify(started && started.value && started.value.run)}`)
      check('按钮变成"已开始"并且不给重复点',
        !!(started && started.ok && started.value && started.value.disabled && /已开始/.test(started.value.btn)),
        JSON.stringify(started && started.value && { btn: started.value.btn, disabled: started.value.disabled }))
      check('侧栏没自动打开时给出**能照做**的打开方式（图标 / 快捷键）',
        !!(started && started.ok && started.value && /CoRead 图标/.test(started.value.hint) && /Alt/.test(started.value.hint)),
        String(started && started.value && started.value.hint).slice(0, 80))

      // ── 8c. 侧栏打不开时，用户有没有**能用键盘**的第二条路？──────────────
      // 快捷键写错的表现是静默失效（chrome://extensions/shortcuts 里显示"未设置"，
      // 按下去毫无反应）。实测踩过：`Ctrl+Shift+U` 在 manifest 里过得了校验，
      // 但浏览器不会把它绑给 `_execute_action`（那一组留给 Chrome 自带快捷键）。
      // 所以这里把"到底绑上了什么"读出来，写进报告。
      const cmds = await readerOp(tab.id, 'commands')

      // ── 8e. 侧栏的真实状态（2026-11 用户要求"再弄一点自检"）──────────────
      // 这一段是这一轮的重点：前面几轮我一直在**用日志反推**"用户点了哪个按钮、
      // 抽屉里到底有没有例句"，查得慢、还猜错过。这里直接把侧栏问一遍。
      //
      // 先退出自由模式（2026-11 实测）：8e / 8f 两段都假设"侧栏认的是这本教程书"，
      // 而自由模式是"没有书的随手记"，两者互斥。产品本身也是这么做的——开始上课时
      // 侧栏会自己退出自由模式（见 sidebar.js 的 coreadTutorialLesson）。
      const free = await sidebarOp('exitFreeMode')
      out.freeModeBefore = free
      if (free && free.wasFree) await sleep(1200)   // refreshCurrentBook 是异步的，等它切完
      const sb = await probeSidebar()
      out.sidebarProbe = sb
      check('侧栏有回应（自检能读到它的真实状态）', !!(sb && sb.ok), JSON.stringify(sb && sb.error))
      if (sb && sb.ok) {
        check('侧栏读到了预设例句的数据', sb.sampleDataLoaded === true,
          'sampleDataLoaded=' + sb.sampleDataLoaded + ' count=' + sb.sampleCount)
        check('侧栏能造出预设例句条目', sb.sampleCount > 0, 'count=' + sb.sampleCount)
        check('侧栏认得出当前是教程书（决定「教程」入口与例句归属）', sb.isTutorialBook === true,
          'bookBase=' + String(sb.bookBase).slice(0, 20))
        check('侧栏没有把例句漏在抽屉外（打开抽屉时应能看到）',
          sb.drawerHasSamples === true || sb.drawerSampleItems > 0,
          'drawerSampleItems=' + sb.drawerSampleItems)
        if (sb.tutorial && sb.tutorial.active) {
          check('侧栏知道教程正在跑（第几课第几步）', sb.tutorial.stepCount > 0, JSON.stringify(sb.tutorial))
        }
        out.sidebarButtons = sb.refCardButtons
        check('引用卡上两个按钮都能被识别（以后"点错了哪个"不用猜）',
          Array.isArray(sb.refCardButtons) && sb.refCardButtons.length >= 2,
          JSON.stringify(sb.refCardButtons))
      }

      // ── 8f. 「切换引用」整条链路：**真的点**，再看结果（2026-11）────────────
      // 为什么单列一段（用户质问："你那套自检根本没啥用"——他说得对）：
      // 上面 8e 只是**问**侧栏状态，问的时候一切正常；用户报的"点切换引用之后
      // 底层界面跳回选书界面"只在**点下去**的那 0.4~1.5 秒里发生，所以自检一直绿、
      // 用户一直坏。这一段在真环境里真的按那个按钮，再比对点之前/点之后的当前书与界面——
      // 判据就是用户眼睛看到的那个现象（书单铺开 = #book-picker 带 on）。
      const endToEnd = { ran: false }
      if (sb && sb.ok) {
        endToEnd.ran = true
        endToEnd.exitedFreeMode = out.freeModeBefore || null
        const before = await sidebarOp('state')
        endToEnd.before = before
        check('端到端前置：侧栏此刻认的是教程书',
          !!(before && before.ok && before.book === TUTORIAL_BOOK_ID),
          'book=' + String(before && before.book).slice(0, 24))
        const clicked = await sidebarOp('clickSwitchRef')
        endToEnd.clicked = clicked
        check('端到端：真的点到了「切换引用」那个按钮', !!(clicked && clicked.ok), JSON.stringify(clicked))
        await sleep(1500)   // bug 就在这 0.4~1.5 秒里发生，等它跑完再看
        const after = await sidebarOp('state')
        endToEnd.after = after
        check('点「切换引用」之后当前书**没有**被清空（用户看到的那一跳就是它）',
          !!(after && after.ok && !!after.book && after.book === before.book),
          'before=' + String(before && before.book).slice(0, 24) + ' after=' + String(after && after.book).slice(0, 24))
        check('点「切换引用」之后没有跳回选书界面（无书视图没有露出来）',
          !!(after && after.ok && after.noBook === false
            && !(before && before.picker === false && after.picker === true)),
          'before.noBook=' + String(before && before.noBook) + ' after.noBook=' + String(after && after.noBook)
            + ' picker=' + String(after && after.picker))
        check('点「切换引用」之后抽屉真的开了', !!(after && after.ok && after.drawer === true), JSON.stringify(after))
        check('抽屉里摆着预备好的例句（这正是一课要教的操作面）',
          !!(after && after.ok && after.sampleItems > 0), 'sampleItems=' + String(after && after.sampleItems))
        const picked = await sidebarOp('clickSample', 0)
        endToEnd.picked = picked
        await sleep(600)
        const afterPick = await sidebarOp('state')
        endToEnd.afterPick = afterPick
        check('点一条例句之后引用卡上真的换成了它（与真引用同一条路）',
          // ⚠️ 原先这条只断言"卡上有字"，而那**是假的绿**：真环境实测里卡上一直是
          // 上一句旧引用（"头到尾走了一遍——"），照样通过。现在必须**对得上那句话**。
          !!(picked && picked.ok && picked.text && afterPick && afterPick.ok
            && String(afterPick.ref).indexOf(String(picked.text).slice(0, 12)) === 0),
          '点了「' + String(picked && picked.text).slice(0, 14) + '」，卡上是「'
            + String(afterPick && afterPick.ref).slice(0, 20) + '」')
        check('选完例句之后当前书仍然没被清空',
          !!(afterPick && afterPick.ok && !!afterPick.book && afterPick.book === before.book),
          'book=' + String(afterPick && afterPick.book).slice(0, 24))
      } else {
        // 侧栏没开着就没得点。如实报"没跑"，**不写一条永远绿的假断言**。
        check('端到端「切换引用」那一段跑了', false, '侧栏没回应，整段跳过：先打开侧栏再跑自检')
      }
      out.endToEnd = endToEnd
      /**
       * ── 8g. 侧栏只跟随**活动标签页**（2026-11 二次改版，用户报的那个现象）────────
       *
       * 用户实测的话："现在即使当前在毫不相关的标签页，只要标签栏内有其标签页，
       * 侧栏就一直显示着这个会话。" 这一段就把那句话**在真环境里做一遍**：
       * 开一个无关标签页并切过去 → 侧栏应当回到无书界面（书单铺开）→
       * 再切回阅读器 → 侧栏应当跟回来、会话还在。
       *
       * 为什么只能在自检里做：它依赖**真实的** tabs.onActivated 与窗口焦点，
       * 而 DOM 替身那套测试（agent/test/sidebar-reader-context.test.js）只覆盖了
       * 侧栏内部的判断逻辑，"浏览器到底有没有把 onActivated 送到侧栏"它验不了。
       *
       * ⚠️ 造场景用的是 `about:blank`：它是"跟阅读毫无关系的页面"的最干净代表，
       * 不联网、不受任何站点脚本影响。用完就关掉，不留垃圾标签页。
       */
      const focus = { ran: false }
      if (sb && sb.ok) {
        focus.ran = true
        const beforeAway = await sidebarOp('state')
        focus.before = beforeAway
        check('跟随前置：切走之前，侧栏认的就是阅读器里这本',
          !!(beforeAway && beforeAway.ok && beforeAway.book === TUTORIAL_BOOK_ID),
          'book=' + String(beforeAway && beforeAway.book).slice(0, 24))
        let decoy = null
        try {
          decoy = await chrome.tabs.create({ url: 'about:blank', active: true, windowId: tab.windowId })
        } catch (e) {
          focus.createError = String((e && e.message) || e)
        }
        check('跟随：自检能开一个无关标签页并切过去（这个场景得自己造）',
          !!(decoy && decoy.id), String(focus.createError || ''))
        if (decoy && decoy.id) {
          await sleep(1500)          // 等 tabs.onActivated → 侧栏重算一次当前书
          const away = await sidebarOp('state')
          focus.away = away
          check('切到无关标签页后：侧栏不再挂着那本书（当前书为空）',
            !!(away && away.ok && !away.book),
            'book=' + String(away && away.book).slice(0, 24))
          check('切到无关标签页后：无书界面露出来了（书单铺开）',
            !!(away && away.ok && away.noBook === true),
            'noBook=' + String(away && away.noBook))
          // 切回阅读器：必须跟回来。少了这一条，修成"切走了就回不来"比原来更坏。
          try { await chrome.tabs.update(tab.id, { active: true }) } catch (e) {}
          try { await chrome.windows.update(tab.windowId, { focused: true }) } catch (e) {}
          await sleep(1500)
          const back = await sidebarOp('state')
          focus.back = back
          check('切回阅读器后：侧栏跟着回来（那本书的会话没有被清掉）',
            !!(back && back.ok && back.book === TUTORIAL_BOOK_ID),
            'book=' + String(back && back.book).slice(0, 24))
          check('切回阅读器后：无书界面收起来了',
            !!(back && back.ok && back.noBook === false),
            'noBook=' + String(back && back.noBook))
          try { await chrome.tabs.remove(decoy.id) } catch (e) {}
        }
      } else {
        check('端到端「只跟随活动标签页」那一段跑了', false, '侧栏没回应，整段跳过：先打开侧栏再跑自检')
      }
      out.focusFollow = focus
      /**
       * ── 8h. 阅读位置：**下次打开还在我离开的那一处**（2026-11 二次改版）──────────
       *
       * 用户报的原话是"下次打开阅读器的时候，当前阅读位置的定义问题"。
       * 修完之后位置的定义是「第几页/章 + 页内比例」，这一段就真的做一遍：
       *   读到某一处（第 5 章 55% 处）→ 落盘 → **重新加载阅读器**（= 下次打开，走的是
       *   侧栏「读」那条 `?open=` 深链）→ 读回实际位置，比对页/章与比例。
       * 全程用教程书（唯一**一定**存在、不依赖用户放了哪本 PDF 的书）。
       *
       * ⚠️ 自检不留痕：先记下原来读到哪，验完写回去。
       */
      const posBefore = await readerOp(tab.id, 'position')
      out.positionBefore = posBefore && posBefore.value
      // 这一次加载的指纹：重载之后必须换一个，否则读到的可能是**旧页面**还没卸载时的回音
      //（那当然是"位置没变"，断言会假通过）
      const sessionWas = posBefore && posBefore.value && posBefore.value.session
      const posSet = await readerOp(tab.id, 'setPosition', { page: 5, frac: 0.55, persist: true })
      out.positionSet = posSet && posSet.value
      check('自检能摆出"上次读到第 5 章 55% 处"',
        !!(posSet && posSet.ok && posSet.value && posSet.value.page === 5), JSON.stringify(posSet && posSet.value))
      check('摆完位当场量回来的位置就是它（存/量同一把尺子）',
        !!(posSet && posSet.ok && Math.abs(Number(posSet.value.frac) - 0.55) < 0.06),
        JSON.stringify(posSet && posSet.value))
      // 重新加载阅读器 = "下次打开"。走 `?open=` 深链（侧栏「读」那条路），
      // 不是 tabs.reload()：URL 里的 ?open= 早被 replaceState 抹掉了，
      // 直接 reload 会落到**书库列表**上，那验的就不是"打开这本书"了。
      const readerUrl = chrome.runtime.getURL('reader.html') + '?open=' + TUTORIAL_HEX
      try { await chrome.tabs.update(tab.id, { url: readerUrl }) } catch (e) { out.positionNavError = String((e && e.message) || e) }
      const isFresh = (p) => !!(p && p.ok && p.value && p.value.session && p.value.session !== sessionWas)
      const back = await waitFor(async () => {
        const p = await readerOp(tab.id, 'position')
        return isFresh(p) && !p.value.restoring && !!p.value.page
      }, 20000)
      // 兜底再读一次（waitFor 超时也要有值可写进报告）
      let posAfter = null
      for (let i = 0; i < 12; i++) {
        const p = await readerOp(tab.id, 'position')
        if (isFresh(p) && !p.value.restoring) { posAfter = p; break }
        await sleep(700)
      }
      out.positionAfter = posAfter && posAfter.value
      out.positionReloaded = back
      check('重新打开阅读器之后能读到位置（而且读的是**新那一次加载**）',
        !!(posAfter && posAfter.ok && posAfter.value && posAfter.value.page),
        JSON.stringify(posAfter && posAfter.value))
      if (posAfter && posAfter.ok && posAfter.value) {
        check('下次打开回到的是**同一章**（不是第 1 章）',
          posAfter.value.page === 5, 'page=' + posAfter.value.page)
        check('下次打开回到的是**同一处**（页内比例对得上，容差 8%）',
          Math.abs(Number(posAfter.value.frac) - 0.55) < 0.08,
          'frac=' + posAfter.value.frac + '（期望 ≈0.55）')
        check('记录里存的就是那一处，不是"第 1 页/第 1 章"',
          posAfter.value.storedPage === 5 && !(posAfter.value.storedPage === 1 && posSet && posSet.value && posSet.value.page === 5),
          JSON.stringify({ storedPage: posAfter.value.storedPage, storedFrac: posAfter.value.storedFrac }))
        check('教程书滚动后状态栏说的是**当前这一章**（旧版永远写"第 1 章"）',
          /第\s*5\s*\/\s*\d+\s*章/.test(String(await readerOp(tab.id, 'pageInfo').then((r) => r && r.value))),
          String(await readerOp(tab.id, 'pageInfo').then((r) => r && r.value)))
      }
      // 把自检改过的位置写回去，别给用户留下"读到第 5 章"这种痕迹
      if (posBefore && posBefore.ok && posBefore.value && posBefore.value.page) {
        await readerOp(tab.id, 'setPosition', { page: posBefore.value.page, frac: posBefore.value.frac || 0, persist: true })
      }
      out.commands = cmds && cmds.value
      const openCmd = Array.isArray(out.commands) ? out.commands.find((c) => c.name === '_execute_action') : null
      check('打开侧栏的快捷键注册上了（没注册的话卡片上的提示就是空头支票）',
        !!(openCmd && openCmd.shortcut && openCmd.shortcut.length > 0),
        JSON.stringify(out.commands))

      // 侧栏此刻开着吗？这决定"要不要调 open()"以及"广播有没有听众"
      const ctx = await readerOp(tab.id, 'sidePanelContexts')
      out.sidePanelContexts = ctx && ctx.value
      check('能查到侧栏上下文（getContexts 可用）',
        !!(ctx && ctx.ok && ctx.value && ctx.value.supported !== false), JSON.stringify(ctx && ctx.value))

      // ── 8d. 「跳到原文」那条链路（2026-11 用户报"回到主界面"之后加的）────────
      // 侧栏点 📍 时走 `readerCommand` 的 `locate`：在**当前打开的这一本**里找那段原文、
      // 滚过去、圈一下——不重载、不依赖引用里那个靠不住的章号。
      // 这条自检把"定位成没成"变成直接可读的事实，不用再靠日志反推用户点了哪个按钮。
      const loc = await readerOp(tab.id, 'locateProbe', '自检定位探针 · ' + Date.now())
      out.locateProbe = loc && loc.value
      check('在正文里能按原文定位（「跳到原文」靠它，不再重载全书）',
        !!(loc && loc.ok && loc.value && loc.value.found), JSON.stringify(loc && loc.value))
      check('定位不到时如实回报 found:false（不假装成功）',
        !!(loc && loc.ok && loc.value && typeof loc.value.found === 'boolean'))

      // ── 9. 划词 → 点「共读」→ 侧栏设为当前引用（真实链路，不 mock）────────
      const selRes = await readerOp(tab.id, 'selectParagraph')
      out.selectParagraph = selRes && selRes.value
      check('能在教程正文上划出选区',
        !!(selRes && selRes.ok && selRes.value && selRes.value.ok && selRes.value.chars > 5), JSON.stringify(selRes))
      check('划词后浮出「共读」浮标',
        !!(selRes && selRes.ok && selRes.value && selRes.value.tipVisible && /共读/.test(selRes.value.tipLabel)),
        JSON.stringify(selRes && selRes.value))

      const refRes = await readerOp(tab.id, 'submitSelection')
      check('点「共读」真的把这段设成了引用',
        !!(refRes && refRes.ok && refRes.value && refRes.value.ok), JSON.stringify(refRes && refRes.value))

      // ── 10. 侧栏那边会收到什么（这一步的后续——写"待选引用"标记——是**后台**干的，
      //        阅读器只负责把消息发给它。所以这里只如实记录阅读器的返回，
      //        不去断言 storage 里的标记：那样测的是后台，而这个页面驱动不到后台那一步
      //        （踩过：在自检里写了一条永远失败的断言，报假失败比不报更坏）──
      out.pendingMarker = '未在自检里断言（写它的是后台 setTranslationRef，见 translate-background.js）'
      check('阅读器报告"设为引用"成功（这一步后续由后台写标记）',
        !!(refRes && refRes.ok && refRes.value && refRes.value.ok), JSON.stringify(refRes && refRes.value))

      // ── 11. 侧栏页面能被打开（拿得到它的 DOM 才算数）────────────────────
      // 扩展页之间不能互相读 DOM，所以只能"打开它、等它自己报"。
      // 这里退一步：确认 chrome.sidePanel API 存在且可调用（调用本身可能因缺用户手势失败，
      // 那属于浏览器策略，不是我们的 bug——所以只报结果，不判失败）。
      let sidePanelResult = 'not-tried'
      try {
        const t2 = await readerTab()
        await chrome.sidePanel.open({ tabId: t2.id })
        sidePanelResult = 'opened'
      } catch (e) {
        sidePanelResult = 'failed: ' + String(e.message || e)
      }
      out.sidePanel = sidePanelResult
      check('chrome.sidePanel.open 可调用（结果见 out.sidePanel；缺手势时失败属浏览器策略）',
        sidePanelResult === 'opened' || /user gesture|gesture/i.test(sidePanelResult), sidePanelResult)
    } else {
      check('找到阅读器标签页', false, '没有阅读器标签页，后面几项跳过')
    }
  } catch (e) {
    out.errors.push(String((e && e.stack) || e))
    check('自检过程没抛异常', false, String((e && e.message) || e))
  }

  // ── 收尾：算总分、落盘、必要时下载 ────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length
  out.total = checks.length
  out.passed = passed
  out.failed = checks.length - passed
  out.finishedAt = new Date().toISOString()
  out.ok = out.failed === 0 && out.errors.length === 0
  out.userAgent = navigator.userAgent

  const summary = document.getElementById('summary')
  summary.textContent = `跑完：${out.passed}/${out.total} 项通过` + (out.ok ? ' ✅' : ' ❌')
  btn.disabled = false

  let uploaded = false
  let where = ''
  // ① 新接口（落成 logs\selfcheck.json，最好读）
  try {
    const r = await fetch(RECEIVER + '/selfcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    })
    const d = await r.json().catch(() => null)
    if (d && d.ok) { uploaded = true; where = d.file }
  } catch (e) {}
  // ② 回退：/debug（**老版本就有的接口**，写进 logs\debug.jsonl）。
  // 为什么要这条兜底：用户机器上正跑着的 CoRead 可能是旧版本，没有 /selfcheck，
  // 直接 404 —— 那时报告就白跑了。降级成一行 debug 记录，AI 助手照样能从日志里读出来。
  if (!uploaded) {
    try {
      const r = await fetch(RECEIVER + '/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'selfcheck',
          stage: 'report',
          ok: out.ok,
          passed: out.passed,
          total: out.total,
          version: out.version,
          files: out.files,
          // 每条掐到 200 字：debug.jsonl 是行日志，别让一份报告把它撑爆
          checks: out.checks.map((c) => ({ name: c.name, ok: c.ok, detail: String(c.detail || '').slice(0, 200) })),
          errors: out.errors,
          ids: out.ids,
          tocItems: out.toc ? (() => { try { return JSON.parse(out.toc).items } catch { return null } })() : null,
          openReaderBook: out.openReaderBook,
          lessonCard: out.lessonCard,
          startLesson: out.startLesson,
          commands: out.commands,
          sidePanelContexts: out.sidePanelContexts,
          // ⚠️ 新增的探针一定要加进这个列表（2026-11 踩过）：字段算出来了却没往上报，
          // 报告里就是 undefined——等于"自检自己把证据丢了"，跟以前那个空 `{}` 同一类毛病。
          sidebarProbe: out.sidebarProbe,
          sidebarButtons: out.sidebarButtons,
          // 「切换引用」真的点一遍的四个时刻（点之前 / 点之后 / 选完例句之后）：
          // 用户报的那一跳就画在这几个快照的差里，不必再靠口述。
          endToEnd: out.endToEnd,
          locateProbe: out.locateProbe,
          navTrace: out.navTrace,
          readerAlive: out.readerAlive,
          readerTabs: out.readerTabs,
          sidePanel: out.sidePanel,
        }),
      })
      const d = await r.json().catch(() => null)
      if (r.ok) { uploaded = true; where = 'logs\\debug.jsonl（旧版接收端的降级通道，source=selfcheck）' }
      else where = 'HTTP ' + r.status
    } catch (e) { where = String((e && e.message) || e) }
  }

  const fileEl = document.getElementById('file')
  if (uploaded) {
    fileEl.textContent = `报告已送到本机服务：${where} —— AI 助手读这个就能看到结果`
  } else {
    fileEl.textContent = '本机服务没接收（它没在运行？）—— 已下载 coread-selfcheck.json，把它发给 AI 助手'
  }
  out.uploaded = uploaded
  out.uploadedWhere = where
  if (!uploaded) {
    // 兜底：下载一份，用户总能把它发给我
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'coread-selfcheck.json'
    a.click()
  }
  console.log('[selfcheck] 结果', out)
  window.__selfcheckResult = out
  return out
}

// 自测夹具靠这个入口跑它；**必须在 run 定义之后立刻挂上**。
// 放到文件末尾会让夹具一直等不到、白等超时（踩过：产品代码没错，是入口出现得太晚）。
window.__selfcheck = run

document.getElementById('run').addEventListener('click', () => { run() })
render()
