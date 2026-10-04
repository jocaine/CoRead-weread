/**
 * CoRead 翻译能力的 service worker 部分
 *
 * 由 service_worker.js 调用 installTranslateBackground() 装配。不写 DOM：
 * 遮罩框选、裁剪、气泡都在 translate-overlay.js（按需注入的 content script）里。
 *
 * 模型配置的唯一真源是 CoRead 的 agent/api-config.json（经 receiver GET /api-config），
 * 本模块每次调用前读一次并更新本地缓存；receiver 没起来时退回缓存，翻译仍可用。
 *
 * 消息协议（content script / 侧栏翻译面板 → 本模块，全部走 chrome.runtime.sendMessage）：
 *   { action: 'getTranslateStatus' }          → { ok, status }   面板状态（不含 API Key）
 *   { action: 'startSelection' }              → { ok }           进入框选
 *   { action: 'translateSelection' }          → { ok, data }     划词翻译
 *   { action: 'captureScreen' }               → { ok, dataUrl }  仅 overlay 内部用
 *   { action: 'translateImage', dataUrl }     → { ok, data: { original, translation } }
 *   { action: 'translateText', text, source } → { ok, data: { original, translation } }
 *   { action: 'testConnection' }              → { ok, text }
 */

import {
  API_CONFIG_PATH,
  IMAGE_PROMPT,
  RECEIVER_URL,
  RETRANSLATE_PROMPT,
  RETRY_PROMPT,
  SELECTION_PROMPT,
  STORE_KEYS,
  buildChatBody,
  buildImageContent,
  buildRelocatePrompt,
  buildTextContent,
  chatCompletionsUrl,
  classifyFetchError,
  classifyHttpError,
  extractReplyText,
  originPattern,
  parseRelocateReply,
  parseTranslation,
  relocateSnippet,
} from './translate-protocol.js'

const UPSTREAM_TIMEOUT_MS = 60_000
const MAX_TEXT_CHARS = 6000
const ACTION_TITLE = 'CoRead'
const OVERLAY_FILE = 'translate-overlay.js'

const HANDLERS = {
  getTranslateStatus,
  startSelection,
  translateSelection,
  captureScreen,
  translateImage,
  translateText,
  recordTranslation,
  restoreTranslations,
  clearTranslations,
  setTranslationRef,
  relocateAnchor,
  readerSync,
  readerGet,
  readerCommand,
  notesOpen,
  notesClose,
  testConnection,
}

/** 由 service_worker.js 调用一次。 */
export function installTranslateBackground() {
  chrome.commands.onCommand.addListener(async (command) => {
    // 阅读器页面：快捷键转成命令发过去。
    // 不能指望页面自己监听按键 —— 侧栏（或别的面板）有焦点时，按键根本到不了页面。
    const tab = await activeTab()
    const inReader = tab ? isReaderUrl(tab.url) : false
    if (command === 'translate-region') {
      if (inReader) relayToReader('boxSelect')
      else startSelection()
      return
    }
    if (command === 'translate-selection') {
      if (inReader) relayToReader('translateSelection')
      else translateSelection()
    }
  })

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg?.action]
    if (!handler) return undefined
    Promise.resolve(handler(msg, sender))
      .then(sendResponse)
      .catch((e) => sendResponse({
        ok: false,
        error: { code: e?.code || 'UNKNOWN', message: e?.message || String(e) },
      }))
    return true // 异步响应
  })
}

// ── 页面动作：注入与选区读取 ──────────────────────────────────────────────────
// activeTab 由用户手势授予：点扩展图标、按快捷键、点侧栏面板上的按钮。
// 注入与动作分成两步：先注入 overlay 建好 DOM（幂等），再用一次 func 调用告诉它做什么。
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab && tab.id ? tab : null
}

/** 是不是我们自己的阅读器页面（它自己处理划词与快捷键，后台不要插手）。 */
function isReaderUrl(url) {
  if (!url || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return false
  try {
    const reader = chrome.runtime.getURL('reader.html')
    return url.split('#')[0].split('?')[0] === reader
  } catch {
    return false
  }
}

async function ensureOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [OVERLAY_FILE] })
}

async function startSelection() {
  const off = await requireEnabled()
  if (off) return off
  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')
  try {
    await ensureOverlay(tab.id)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (!window.__coreadStOverlay) throw new Error('overlay 未就绪')
        window.__coreadStOverlay.startSelection()
      },
    })
    return { ok: true }
  } catch (e) {
    const detail = String(e?.message || e)
    flashBadge('✕', '当前页面不允许注入脚本')
    return fail('INJECT_FAILED', '当前页面不允许注入脚本（浏览器内部页、扩展商店页、PDF 阅读器等）', detail)
  }
}

// 在页面里读当前选区。作为 func 注入，必须自包含：不能引用本文件作用域里的任何东西。
function readSelectionInPage() {
  const sel = window.getSelection()
  let text = sel ? String(sel.toString() || '').trim() : ''
  let rect = null
  if (text && sel.rangeCount) {
    try {
      const rects = sel.getRangeAt(0).getClientRects()
      for (const r of rects) {
        if (r && r.width > 0 && r.height > 0) {
          rect = { left: r.left, top: r.top, width: r.width, height: r.height }
          break
        }
      }
    } catch {}
  }
  if (!text) {
    // 输入框与文本域里的选中不属于文档选区，要单独取；密码框一律不读
    const el = document.activeElement
    const tag = el && el.tagName
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.type !== 'password') {
      const start = el.selectionStart
      const end = el.selectionEnd
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        text = String(el.value.slice(start, end)).trim()
        const r = el.getBoundingClientRect()
        rect = { left: r.left, top: r.top, width: r.width, height: r.height }
      }
    }
  }
  return { text, rect }
}

/** 划词翻译：读选区 → 纯文本请求 → 在选区旁出气泡。不截图，不需要图像能力。 */
async function translateSelection() {
  const off = await requireEnabled()
  if (off) return off
  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')
  // 阅读器是我们自己的页面：它自己处理 Alt+T（选区在 pdf.js 的文字层里，
  // 翻译结果要进对照栏而不是浮窗）。这里直接让路，避免一次注定失败的注入。
  if (isReaderUrl(tab.url)) return { ok: true, skipped: 'reader' }

  let probe
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSelectionInPage })
    probe = out && out[0] ? out[0].result : null
  } catch (e) {
    const detail = String(e?.message || e)
    flashBadge('✕', '当前页面不允许注入脚本')
    return fail('INJECT_FAILED', '当前页面不允许注入脚本（浏览器内部页、扩展商店页、PDF 阅读器等）', detail)
  }

  const text = String((probe && probe.text) || '').trim()
  if (!text) {
    flashBadge('!', '没有选中文字')
    return fail('NO_SELECTION', '未选中文字。请先在页面上选中内容，再按一次快捷键')
  }
  if (text.length > MAX_TEXT_CHARS) {
    flashBadge('!', '选中文字过长')
    return fail('TOO_LARGE', '选中文字超过 ' + MAX_TEXT_CHARS + ' 字，请缩小选区后重试')
  }

  const r = await chat({ content: buildTextContent(SELECTION_PROMPT, text) })
  if (!r.ok) {
    flashBadge('✕', r.error?.message || '翻译失败')
    return r
  }

  let data
  try {
    data = { translation: parseTranslation(r.text).translation }
  } catch {
    return fail('PARSE_ERROR', '翻译结果不符合约定格式，请重试')
  }

  try {
    await ensureOverlay(tab.id)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (payload, rect, sourceText) => {
        if (!window.__coreadStOverlay) throw new Error('overlay 未就绪')
        // sourceText 用来核对选区是否还是原来那段：一致才按逐行矩形画高亮
        window.__coreadStOverlay.showText(payload, rect, sourceText)
      },
      args: [data, probe.rect, text],
    })
  } catch (e) {
    return fail('INJECT_FAILED', '结果渲染失败：' + String(e?.message || e))
  }
  return { ok: true, data }
}

function flashBadge(text, title) {
  try {
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' })
    if (title) chrome.action.setTitle({ title })
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' })
      chrome.action.setTitle({ title: ACTION_TITLE })
    }, 4000)
  } catch {}
}

// ── 截图 ──────────────────────────────────────────────────────────────────────
async function captureScreen() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return fail('NO_TAB', '没有可用的标签页')
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    if (!dataUrl) return fail('CAPTURE_FAILED', '截图返回空数据')
    return { ok: true, dataUrl }
  } catch (e) {
    const detail = String(e?.message || e)
    if (/quota|MAX_CAPTURE/i.test(detail)) {
      return fail('CAPTURE_RATE', '截图过于频繁（每秒上限 2 次），请稍后重试', detail)
    }
    return fail('CAPTURE_FAILED', '截图失败：' + detail, detail)
  }
}

// ── 配置 ──────────────────────────────────────────────────────────────────────
/**
 * 读取工具箱里的开关与可选覆盖项。
 * enabled 缺省为 true（没写过这个键 = 没关过）。
 */
async function readOverrides() {
  const store = await chrome.storage.local.get([
    STORE_KEYS.enabled,
    STORE_KEYS.apiBaseOverride,
    STORE_KEYS.apiKeyOverride,
    STORE_KEYS.modelOverride,
    STORE_KEYS.legacyVisionModel,
  ])
  const model = String(store[STORE_KEYS.modelOverride] ?? '').trim()
    || String(store[STORE_KEYS.legacyVisionModel] ?? '').trim()
  return {
    enabled: store[STORE_KEYS.enabled] !== false,
    apiBase: String(store[STORE_KEYS.apiBaseOverride] ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(store[STORE_KEYS.apiKeyOverride] ?? '').trim(),
    model,
  }
}

/**
 * 配置以 CoRead 的 agent/api-config.json 为唯一真源（经 receiver 读取），每次调用先读真源
 * 并刷新本地缓存；receiver 没起来时退回缓存。
 * 工具箱里配置了覆盖项时按字段覆盖：已填写的项覆盖 CoRead 的同名项，未填写的项沿用其值。
 */
async function readConfig() {
  const ov = await readOverrides()
  const store = await chrome.storage.local.get([STORE_KEYS.config])
  const cached = store[STORE_KEYS.config] || {}

  let live = null
  let syncError = ''
  try {
    const resp = await fetch(RECEIVER_URL + API_CONFIG_PATH)
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const data = await resp.json()
    if (data && data.apiBase && data.apiKey) {
      live = {
        apiBase: String(data.apiBase).trim(),
        apiKey: String(data.apiKey).trim(),
        model: String(data.model ?? '').trim(),
        syncedAt: Date.now(),
      }
      await chrome.storage.local.set({ [STORE_KEYS.config]: live })
    } else {
      syncError = 'CoRead 里还没有配置模型 API'
    }
  } catch {
    syncError = '接收端未连接'
  }

  const base = live || {
    apiBase: String(cached.apiBase ?? '').trim(),
    apiKey: String(cached.apiKey ?? '').trim(),
    model: String(cached.model ?? '').trim(),
  }
  const baseModel = String(base.model ?? '').trim()
  const baseApiBase = String(base.apiBase ?? '').trim()
  return {
    enabled: ov.enabled,
    apiBase: ov.apiBase || baseApiBase,
    apiKey: ov.apiKey || String(base.apiKey ?? '').trim(),
    model: ov.model || baseModel,
    baseApiBase,
    baseModel,
    override: { apiBase: !!ov.apiBase, apiKey: !!ov.apiKey, model: !!ov.model },
    fromCache: !live,
    syncError,
  }
}

/** 侧栏工具箱用的状态。不含 API Key。 */
async function getTranslateStatus() {
  const cfg = await readConfig()
  let origin = ''
  let granted = false
  if (cfg.apiBase) {
    try {
      origin = originPattern(cfg.apiBase)
      granted = await chrome.permissions.contains({ origins: [origin] })
    } catch {
      origin = ''
    }
  }

  // 当前页已记录的译文条数（「贴回本页译文」按钮的角标）
  let pageUrl = ''
  let recordTotal = 0
  let recordError = ''
  try {
    const tab = await activeTab()
    pageUrl = tab && tab.url ? tab.url : ''
    if (pageUrl) recordTotal = (await fetchToolRecords(pageUrl, 1)).total || 0
  } catch {
    recordError = '接收端未连接，读不到译文记录'
  }

  // 最近一次翻译的诊断（存在扩展本地，不依赖 receiver）
  let lastDiag = null
  try {
    const store = await chrome.storage.local.get([STORE_KEYS.lastDiag])
    lastDiag = store[STORE_KEYS.lastDiag] || null
  } catch (e) {}

  return {
    ok: true,
    status: {
      enabled: cfg.enabled,
      apiBase: cfg.apiBase,
      baseApiBase: cfg.baseApiBase,
      origin,
      granted,
      configured: !!(cfg.apiBase && cfg.apiKey),
      model: cfg.model,
      baseModel: cfg.baseModel,
      override: cfg.override,
      usingOverride: !!(cfg.override.apiBase || cfg.override.apiKey || cfg.override.model),
      fromCache: cfg.fromCache,
      syncError: cfg.syncError,
      pageUrl,
      recordTotal,
      recordError,
      lastDiag,
    },
  }
}

// ── 调用模型 ──────────────────────────────────────────────────────────────────
async function chat({ content, maxTokens = 2048 }) {
  const cfg = await readConfig()
  if (!cfg.apiBase || !cfg.apiKey) {
    return fail('NOT_CONFIGURED', '尚未配置模型 API。请在侧栏「⋯ → 🔑 模型 API 配置」中填写地址与 Key')
  }
  if (!cfg.model) {
    return fail('NOT_CONFIGURED', '未指定模型。请在工具箱翻译页的「自定义模型配置」或「模型 API 配置」中填写模型名')
  }

  // 模型域名需在可选权限中授权，否则 fetch 会被浏览器拦截（表现为 Failed to fetch）
  try {
    const pattern = originPattern(cfg.apiBase)
    const granted = await chrome.permissions.contains({ origins: [pattern] })
    if (!granted) {
      return fail('NEED_GRANT', '尚未授权访问模型域名 ' + pattern + '。请在工具箱翻译页点击「授权访问模型域名」', pattern)
    }
  } catch {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(chatCompletionsUrl(cfg.apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(buildChatBody({ model: cfg.model, content, maxTokens })),
      signal: controller.signal,
    })
  } catch (e) {
    return { ok: false, error: classifyFetchError(e) }
  } finally {
    clearTimeout(timer)
  }

  const body = await resp.text()
  if (!resp.ok) return { ok: false, error: classifyHttpError(resp.status, body) }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return { ok: false, error: { code: 'UPSTREAM', message: '模型服务返回的内容不是 JSON', detail: body.slice(0, 200) } }
  }
  const text = extractReplyText(payload)
  if (!text) return { ok: false, error: { code: 'UPSTREAM', message: '模型未返回内容' } }
  return { ok: true, text }
}

async function translateImage(msg) {
  const off = await requireEnabled()
  if (off) return off
  const dataUrl = String(msg?.dataUrl ?? '')
  if (!dataUrl.startsWith('data:image/')) {
    return fail('BAD_REQUEST', '未收到截图数据')
  }
  const first = await chat({ content: buildImageContent(IMAGE_PROMPT, dataUrl) })
  if (!first.ok) return first
  try {
    return { ok: true, data: parseTranslation(first.text) }
  } catch {
    // 解析失败补救一次：把上一次输出贴回去，要求只吐 JSON
    const retry = await chat({ content: buildTextContent(RETRY_PROMPT, first.text) })
    if (retry.ok) {
      try {
        return { ok: true, data: parseTranslation(retry.text), retried: true }
      } catch {}
    }
    return fail('PARSE_ERROR', '模型返回的内容不符合约定格式，重试后仍失败。请重新截图')
  }
}

async function translateText(msg) {
  const off = await requireEnabled()
  if (off) return off
  const text = String(msg?.text ?? '').trim()
  if (!text) return fail('BAD_REQUEST', '原文为空')
  if (text.length > MAX_TEXT_CHARS) {
    return fail('TOO_LARGE', '原文超过 ' + MAX_TEXT_CHARS + ' 字，请缩短后重试')
  }
  const prompt = msg?.source === 'selection' ? SELECTION_PROMPT : RETRANSLATE_PROMPT
  const r = await chat({ content: buildTextContent(prompt, text) })
  if (!r.ok) return r
  let data
  try {
    data = parseTranslation(r.text)
  } catch {
    return fail('PARSE_ERROR', '重译结果不符合约定格式')
  }
  return { ok: true, data: { original: text, translation: data.translation } }
}

/**
 * 按需重新定位：截当前屏幕，让模型在画面里找出某段文字的位置。
 * 只服务于画布渲染的书——正文画在 canvas 上，页面里没有文字节点，
 * 布局一变就没有任何本地办法把高亮映射回去（Range / 画布比例 / 重搜文字都不成立）。
 * 返回比例坐标，由页面按自己的视口换算。
 */
async function relocateAnchor(msg) {
  const off = await requireEnabled()
  if (off) return off
  const text = String(msg?.text ?? '').trim()
  if (text.length < 4) return fail('BAD_REQUEST', '没有可用于定位的原文')

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return fail('NO_TAB', '没有可用的标签页')

  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  } catch (e) {
    const detail = String(e?.message || e)
    if (/quota|MAX_CAPTURE/i.test(detail)) {
      return fail('CAPTURE_RATE', '截图过于频繁（每秒上限 2 次），请稍后重试', detail)
    }
    return fail('CAPTURE_FAILED', '截图失败：' + detail, detail)
  }
  if (!dataUrl) return fail('CAPTURE_FAILED', '截图返回空数据')

  const prompt = buildRelocatePrompt(text, msg?.hint)
  const r = await chat({ content: buildImageContent(prompt, dataUrl), maxTokens: 256 })
  if (!r.ok) return r
  const parsed = parseRelocateReply(r.text)
  if (parsed.reason === 'notvisible') {
    // 模型说画面上没有这段文字。窗口变窄后正文重排，那段常常被挤出可视区域，
    // 这时候模型是对的：先滚到能看见它，再点一次。
    return fail('NOT_VISIBLE',
      '当前画面上看不到这段文字。请先滚动到能看见它的位置，再点一次「重新定位」',
      parsed.raw)
  }
  if (!parsed.box) {
    return fail('PARSE_ERROR', '模型没有按约定返回位置信息', parsed.raw)
  }
  return { ok: true, box: parsed.box, snippet: relocateSnippet(text, 80) }
}

/**
 * 阅读器 ↔ 侧栏 的中继。
 *
 * 阅读器页面与侧栏是两个扩展页面，彼此不能直接通信，只能经后台转发。
 * 译文对照栏挂在侧栏里（放阅读器页面上会和侧栏凑成两栏），所以：
 *   阅读器 --readerSync--> 后台 --readerUpdate--> 侧栏
 *   侧栏   --readerCommand--> 后台 --readerCommand--> 阅读器
 */
let readerNotesSnapshot = null

async function readerSync(msg) {
  readerNotesSnapshot = msg && msg.snapshot ? msg.snapshot : null
  broadcast({ action: 'readerUpdate', snapshot: readerNotesSnapshot })
  return { ok: true }
}

async function readerGet() {
  return { ok: true, snapshot: readerNotesSnapshot }
}

async function readerCommand(msg) {
  const payload = {
    action: 'readerCommand',
    type: msg && msg.type,
    id: msg && msg.id,
    text: msg && msg.text,
  }
  // 只转发给阅读器页面，并**等它的真实结果**再回给侧栏。
  // 不能"广播完就回 ok"：那样侧栏拿到的是假回执 —— 删除失败、设为引用失败都看不出来。
  // （发送方收不到自己发的消息，所以这里不会自环。）
  try {
    const res = await chrome.runtime.sendMessage(payload)
    return res || { ok: false, error: { message: '阅读器没有返回结果' } }
  } catch (e) {
    return { ok: false, error: { message: '阅读器页面没有响应（可能没打开）' } }
  }
}

/** 把快捷键转成给阅读器的命令（阅读器页面收不到 chrome.commands，侧栏有焦点时也收不到按键） */
async function relayToReader(type) {
  try {
    await chrome.runtime.sendMessage({ action: 'readerCommand', type })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: String((e && e.message) || e) } }
  }
}

/** 打开/收起侧栏里的译文对照。打开时顺便尝试把侧栏本身打开。 */
async function notesOpen(msg, sender) {
  try {
    const win = sender && sender.tab ? sender.tab.windowId : null
    if (chrome.sidePanel && chrome.sidePanel.open && win !== null && win !== undefined) {
      // 需要用户手势；不是手势时会抛错，忽略即可（侧栏本来就开着时也不需要）
      chrome.sidePanel.open({ windowId: win }).catch(() => {})
    }
  } catch (e) {}
  broadcast({ action: 'notesOpen' })
  return { ok: true }
}

async function notesClose() {
  broadcast({ action: 'notesClose' })
  return { ok: true }
}

/** 广播给所有扩展页面（侧栏、阅读器、popup）。没有任何接收方时会 reject，忽略。 */
function broadcast(message) {
  try {
    const p = chrome.runtime.sendMessage(message)
    if (p && p.catch) p.catch(() => {})
  } catch (e) {}
}

async function testConnection() {
  const r = await chat({ content: buildTextContent('只回复两个字：正常', ''), maxTokens: 32 })
  if (!r.ok) return r
  return { ok: true, text: r.text }
}

function fail(code, message, detail = '') {
  return { ok: false, error: detail ? { code, message, detail } : { code, message } }
}

// ── 译文记录（存 receiver，供「贴回本页译文」还原气泡）──────────────────────
// 记录是旁路：不写 inbox、不触发 agent，失败也不影响阅读。
async function fetchToolRecords(url, limit = 50) {
  const resp = await fetch(RECEIVER_URL + '/tool-records?url=' + encodeURIComponent(url) + '&limit=' + limit)
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  const data = await resp.json()
  return {
    records: Array.isArray(data && data.records) ? data.records : [],
    total: Number(data && data.total) || 0,
  }
}

/**
 * 诊断：这段文字到底落在哪个 frame 里。
 * 微读这类阅读器的正文常常在 iframe 中，顶层文档搜不到（overlay 的 anchored=false
 * 就是这么来的）。把每个 frame 的 URL 与"有没有这段文字"记进记录，
 * 就能判断该不该把高亮做进 frame 里，还是正文根本是 canvas 渲染的。
 */
async function probeFrames(tabId, needle) {
  const clean = (s) => String(s || '').replace(/[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/g, '')
  const probe = clean(needle).slice(0, 12)
  if (!tabId || probe.length < 4) return []
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (p) => {
        const norm = (s) => String(s || '').replace(/[\s\u200b\u200c\u200d\ufeff\u2028\u2029]/g, '')
        // 必须穿透 shadow root：textContent 看不到 shadow 里的文字，
        // 用它判断会把"正文在 shadow root 里"误判成"没有这段文字"。
        let buf = ''
        let shadows = 0
        const seen = new Set()
        const walk = (node) => {
          if (!node || seen.has(node)) return
          seen.add(node)
          let walker = null
          try { walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false) } catch (e) { return }
          let n = null
          while ((n = walker.nextNode())) buf += n.data || ''
          let hosts = []
          try { hosts = Array.prototype.slice.call(node.querySelectorAll('*')) } catch (e) { hosts = [] }
          for (const h of hosts) {
            if (h.shadowRoot) {
              shadows++
              walk(h.shadowRoot)
            }
          }
        }
        try { walk(document.body || document.documentElement) } catch (e) {}
        const t = norm(buf)

        // 正文不在任何文字节点里时，最可能是画布渲染。把画布与 iframe 的家底一并报上来：
        // 大尺寸 canvas → 画布书；读不到 contentDocument 的 iframe → 跨源 iframe。
        let canvas = { n: 0, maxW: 0, maxH: 0 }
        try {
          const cs = Array.prototype.slice.call(document.querySelectorAll('canvas'))
          canvas.n = cs.length
          for (const c of cs) {
            canvas.maxW = Math.max(canvas.maxW, c.width || 0)
            canvas.maxH = Math.max(canvas.maxH, c.height || 0)
          }
        } catch (e) {}
        const iframes = []
        try {
          const fs = Array.prototype.slice.call(document.querySelectorAll('iframe'))
          for (const f of fs.slice(0, 6)) {
            let r = null
            try { r = f.getBoundingClientRect() } catch (e) {}
            let readable = false
            try { readable = !!(f.contentDocument && f.contentDocument.body) } catch (e) { readable = false }
            iframes.push({
              src: String(f.src || '').slice(0, 110),
              w: Math.round((r && r.width) || 0),
              h: Math.round((r && r.height) || 0),
              readable: readable,
            })
          }
        } catch (e) {}

        return {
          url: String(location.href).slice(0, 110),
          has: t.includes(p),
          len: t.length,
          shadows: shadows,
          canvas: canvas,
          iframes: iframes,
          top: window === window.top,
        }
      },
      args: [probe],
    })
    return (out || []).map((x) => (x && x.result) || null).filter(Boolean).slice(0, 6)
  } catch (e) {
    return []
  }
}

async function recordTranslation(msg, sender) {
  const payload = {
    url: String(msg?.url || ''),
    pageTitle: String(msg?.pageTitle || ''),
    kind: msg?.kind === 'image' ? 'image' : 'text',
    original: String(msg?.original || ''),
    translation: String(msg?.translation || ''),
    pageX: Number(msg?.pageX) || 0,
    pageY: Number(msg?.pageY) || 0,
    pageW: Number(msg?.pageW) || 0,
    pageH: Number(msg?.pageH) || 0,
    overlayV: Number(msg?.overlayV) || 0,
    anchored: msg?.anchored === true,
    anchorReason: String(msg?.anchorReason || '').slice(0, 20),
    chain: Number(msg?.chain) || 0,
    canvasAnchor: msg?.canvasAnchor === true,
    canvasChanged: msg?.canvasChanged === true,
    canvasInfo: msg?.canvasInfo && typeof msg.canvasInfo === 'object'
      ? { rect: String(msg.canvasInfo.rect || '').slice(0, 20), intrinsic: String(msg.canvasInfo.intrinsic || '').slice(0, 20) }
      : null,
    frames: [],
  }
  if (!payload.url || !payload.translation) {
    return fail('BAD_REQUEST', '记录字段不完整')
  }
  // 只对截图模式探（划词本来就有真实选区，不存在这个问题）
  if (payload.kind === 'image' && !payload.anchored && sender && sender.tab && sender.tab.id) {
    payload.frames = await probeFrames(sender.tab.id, payload.original)
  }

  // 诊断先落在扩展本地：不依赖 receiver 是否重启、是否在跑
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.lastDiag]: {
        at: Date.now(),
        overlayV: payload.overlayV,
        kind: payload.kind,
        anchored: payload.anchored,
        anchorReason: payload.anchorReason,
        chain: payload.chain,
        canvasAnchor: payload.canvasAnchor,
        canvasChanged: payload.canvasChanged,
        pageW: payload.pageW,
        pageH: payload.pageH,
        frames: payload.frames,
        url: payload.url.slice(0, 120),
      },
    })
  } catch (e) {}

  try {
    const resp = await fetch(RECEIVER_URL + '/tool-record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) return fail('RECEIVER_ERROR', '接收端返回 HTTP ' + resp.status)
    return { ok: true }
  } catch (e) {
    return fail('RECEIVER_DOWN', '接收端未连接，本次译文未记录', String(e?.message || e))
  }
}

/** 把本页已记录的译文贴回页面（按记录里的页面坐标还原气泡）。 */
async function restoreTranslations() {
  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')
  if (!tab.url) return fail('NO_TAB', '读不到当前页面地址')

  let data
  try {
    data = await fetchToolRecords(tab.url, 50)
  } catch (e) {
    // 老版本 receiver 没有这三个端点，会返回 404——提示重启，别让人以为是没连上
    return fail('RECEIVER_READ_FAIL', '读不到译文记录（' + String(e?.message || e) + '）。若刚更新过 CoRead，请重启 receiver', String(e?.message || e))
  }
  if (!data.records.length) return fail('NO_RECORDS', '本页还没有译文记录')

  try {
    await ensureOverlay(tab.id)
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (records) => {
        if (!window.__coreadStOverlay) throw new Error('overlay 未就绪')
        return window.__coreadStOverlay.restore(records)
      },
      args: [data.records],
    })
    const shown = out && out[0] ? out[0].result : 0
    return { ok: true, shown }
  } catch (e) {
    flashBadge('✕', '当前页面不允许注入脚本')
    return fail('INJECT_FAILED', '当前页面不允许注入脚本（浏览器内部页、扩展商店页、PDF 阅读器等）', String(e?.message || e))
  }
}

/** 清除本页记录，并顺手关掉页面上还开着的译文气泡。 */
async function clearTranslations() {
  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')
  if (!tab.url) return fail('NO_TAB', '读不到当前页面地址')

  let removed = 0
  try {
    const resp = await fetch(RECEIVER_URL + '/tool-records-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url }),
    })
    if (!resp.ok) return fail('RECEIVER_ERROR', '接收端返回 HTTP ' + resp.status)
    const data = await resp.json().catch(() => null)
    removed = Number(data && data.removed) || 0
  } catch (e) {
    return fail('RECEIVER_READ_FAIL', '无法清除记录（' + String(e?.message || e) + '）。若刚更新过 CoRead，请重启 receiver', String(e?.message || e))
  }

  // 记录清了，页面上开着的气泡也一并收掉（关不掉不影响结果）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (window.__coreadStOverlay) window.__coreadStOverlay.closeAll() },
    })
  } catch (e) {}

  return { ok: true, removed }
}

// ── 送去共读 ──────────────────────────────────────────────────────────────────
/**
 * 判断当前页面属于哪本书：微读从 URL 取 bookId；文库页面（marxists / bilibili）
 * 问页面自己的绑定（source-mia.js 维护 miaBindings，已有 coreadBindingQuery 接口）。
 */
async function resolveBookContext(tab) {
  const url = String((tab && tab.url) || '')
  try {
    const u = new URL(url)
    if (/(^|\.)weread\.qq\.com$/.test(u.hostname)) {
      const m = u.pathname.match(/\/web\/reader\/([A-Za-z0-9]+)/)
      if (m) return { bookId: m[1], bookTitle: '' }
    }
  } catch (e) {}

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'coreadBindingQuery' })
    if (resp && resp.bound && resp.bookId) {
      return { bookId: resp.bookId, bookTitle: resp.bookTitle || '' }
    }
  } catch (e) {}

  return null
}

/** 拿不到书名时补一次：/books 列表里按 base 找，让引用气泡能显示《书名》。 */
async function fillBookTitle(ctx) {
  if (!ctx || ctx.bookTitle) return ctx
  try {
    const resp = await fetch(RECEIVER_URL + '/books')
    if (!resp.ok) return ctx
    const data = await resp.json()
    const hit = (data && Array.isArray(data.books) ? data.books : []).find((b) => b.base === ctx.bookId)
    if (hit && hit.bookTitle) ctx.bookTitle = hit.bookTitle
  } catch (e) {}
  return ctx
}

/**
 * 把译文对应的原文设为侧栏的当前引用，**不直接发出提问**。
 * 走 receiver 的 /annotation（setRef: true）：它只推送 annotation-select 事件，
 * 侧栏收到后把这条加进引用列表并选中为当前引用，不触发 agent 讨论。
 * 用户之后在侧栏输入框里自己提问，走正常的共读链路。
 */
async function setTranslationRef(msg) {
  const original = String(msg?.original || '').trim() || String(msg?.translation || '').trim()
  if (!original) return fail('BAD_REQUEST', '没有可设为引用的内容')

  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')

  const ctx = await fillBookTitle(await resolveBookContext(tab))
  if (!ctx) {
    return fail(
      'NO_BOOK',
      '当前页面没有关联任何书，没法设为引用。微信读书阅读页、或在页面上「加入一本书」过的文库页面才行。',
    )
  }

  try {
    const resp = await fetch(RECEIVER_URL + '/annotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: ctx.bookId,
        bookTitle: ctx.bookTitle || '',
        selectedText: original,
        setRef: true,             // 只设为当前引用，不触发 agent（receiver 据此推 annotation-select）
        source: 'translate-tool',
        sourceUrl: String(msg?.url || ''),
      }),
    })
    if (!resp.ok) return fail('RECEIVER_ERROR', '接收端返回 HTTP ' + resp.status)
  } catch (e) {
    return fail('RECEIVER_DOWN', '接不上本地接收端，没设成引用', String(e?.message || e))
  }

  // 顺手把侧栏打开。拿不到用户手势时会失败，失败也无所谓：引用已入列表，打开侧栏就能看到。
  try { await chrome.sidePanel.open({ tabId: tab.id }) } catch (e) {}

  return { ok: true, bookTitle: ctx.bookTitle || '' }
}

/** 工具箱里关掉翻译时，四个入口统一挡在这里（「测试连接」不受影响，方便关着也能验证配置）。 */
async function requireEnabled() {
  const ov = await readOverrides()
  if (ov.enabled) return null
  // 快捷键路径没有面板可点，用角标给个反馈，否则按键像没反应
  flashBadge('关', '翻译已在工具箱里关闭')
  return fail('DISABLED', '翻译已在工具箱中禁用。请在侧栏「⋯ → 🧰 工具箱 → 翻译」中启用')
}
