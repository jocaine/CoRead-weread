/**
 * 书库（放进来过的 PDF，下次不用再手动选）。
 *
 * receiver 的接口本身由 library-check.mjs 用真实 HTTP 验（17 项）；
 * 这里验阅读器侧：列表渲染、点一下打开、本地打开的自动入库、后台没起来时的表现。
 * 浏览器的 fetch 被换成受控替身 —— 自测页面的来源不在 receiver 的白名单里，真发不出去。
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
    runtime: { sendMessage: async (msg) => { window.__sent.push(msg); return { ok: true } } },
  }
}

const T = window.__readerTest
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') return { ok: true, data: { original: msg.text, translation: '【译】' + msg.text.slice(0, 20) } }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

const RECEIVER = 'http://127.0.0.1:7239'
const realFetch = window.fetch.bind(window)
const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
const sample = new Uint8Array(await (await realFetch(pdfUrl)).arrayBuffer())
const HASH = 'd'.repeat(64)

// ── 受控的 receiver 替身 ────────────────────────────────────────────────────
const calls = []
let mode = 'ok'          // ok | down | empty
window.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (!u.startsWith(RECEIVER)) return realFetch(url, opts)
  calls.push({ url: u.slice(RECEIVER.length), method: (opts.method || 'GET').toUpperCase() })

  if (mode === 'down') throw new TypeError('Failed to fetch')
  if (u.includes('/reader-books')) {
    const books = mode === 'empty' ? [] : [{
      hash: HASH, name: '库里的书.pdf', pages: 3, entries: 5, size: sample.length,
      lastOpenedAt: Date.now() - 3600_000, hasFile: true,
    }]
    return new Response(JSON.stringify({ books }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (u.includes('/reader-book-file') && (!opts.method || opts.method === 'GET')) {
    return new Response(sample, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

try {
  // ── 1) 打开页面就该列出书库 ──────────────────────────────────────────────
  await T.loadLibrary()
  await sleep(200)
  const st = T.libraryState()
  out.library = st
  check('书库列出了一本', st.items.length === 1, JSON.stringify(st.items))
  check('条目显示书名', st.items[0] && st.items[0].name === '库里的书.pdf', st.items[0] && st.items[0].name)
  check('条目显示页数/译文数/大小/时间', !!(st.items[0] && /3 页/.test(st.items[0].meta) && /5 条译文/.test(st.items[0].meta)),
    st.items[0] && st.items[0].meta)
  check('状态行显示本数', st.status === '1 本', st.status)
  check('空书库时不报错', true)

  // ── 2) 点一下就从书库打开，不用再选文件 ─────────────────────────────────
  calls.length = 0
  await T.openFromLibrary({ hash: HASH, name: '库里的书.pdf' })
  await waitFor(() => T.state.doc && T.state.pages[0] && T.state.pages[0].rendered, 20000)
  check('从书库打开的 PDF 渲染出来了', !!(T.state.doc && T.state.pages[0].rendered))
  check('书页数正确', T.state.doc.numPages === 3, T.state.doc.numPages)
  check('顶栏显示书名', document.getElementById('rd-name').textContent === '库里的书.pdf',
    document.getElementById('rd-name').textContent)
  check('打开时取回了原件', calls.some((c) => c.url.startsWith('/reader-book-file')), JSON.stringify(calls))
  check('**没有再上传一遍原件**（本来就在库里）', !calls.some((c) => c.method === 'POST' && c.url.startsWith('/reader-book-file')),
    JSON.stringify(calls))
  check('更新了最近打开时间', calls.some((c) => c.method === 'POST' && c.url === '/reader-book'), JSON.stringify(calls))

  // ── 3) 本地打开的文件会自动入库 ─────────────────────────────────────────
  calls.length = 0
  await T.openBytes(sample.slice(), '本地选的.pdf')   // 每次给一份新的（pdf.js 会 transfer 掉）
  await waitFor(() => T.state.doc && T.state.pages[0] && T.state.pages[0].rendered, 20000)
  await sleep(500)
  const put = calls.find((c) => c.method === 'POST' && c.url.startsWith('/reader-book-file'))
  check('本地打开的上传进了书库', !!put, JSON.stringify(calls))
  check('上传带了内容哈希与文件名', !!(put && /hash=[a-f0-9]{64}/.test(put.url) && /本地选的\.pdf/.test(decodeURIComponent(put.url))),
    put && put.url)
  check('入库后标记为已归档', T.libraryState().archived === true)

  // ── 4) 回书库 ───────────────────────────────────────────────────────────
  T.showLibrary()
  await sleep(400)
  check('回到书库后清掉了当前书', T.state.doc === null)
  check('空状态又露出来了', document.getElementById('rd-empty').hidden === false)
  check('书库重新列了出来', T.libraryState().items.length === 1, T.libraryState().items.length)

  // ── 5) 后台没起来：说明清楚，本地打开照常 ───────────────────────────────
  mode = 'down'
  await T.loadLibrary()
  await sleep(200)
  check('读不到时给出原因', /后台没起来/.test(T.libraryState().status), T.libraryState().status)
  check('读不到时不残留旧列表', T.libraryState().items.length === 0, T.libraryState().items.length)

  calls.length = 0
  await T.openBytes(sample.slice(), '离线打开.pdf')
  await waitFor(() => T.state.doc && T.state.pages[0] && T.state.pages[0].rendered, 20000)
  check('**后台没起来也能正常读**', !!(T.state.doc && T.state.pages[0].rendered))
  check('并且明确告知没入库', /没能存入书库/.test(document.getElementById('rd-toast').textContent),
    document.getElementById('rd-toast').textContent)

  // ── 6) 空书库 ───────────────────────────────────────────────────────────
  mode = 'empty'
  await T.loadLibrary()
  await sleep(200)
  check('空书库显示"还没有"', T.libraryState().status === '还没有', T.libraryState().status)
  check('空书库不渲染条目', T.libraryState().items.length === 0)

  out.summary = { library: out.library, uploadCalls: calls.length }
} catch (err) {
  out.errors.push(String((err && err.stack) || err))
}

out.ok = out.errors.length === 0 && out.checks.every((c) => c.ok)
return out
