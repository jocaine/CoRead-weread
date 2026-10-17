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

// 连通性探测用的地址：一个只回 204 空响应的公共端点，用来回答「是网络整体不通，还是只有模型地址不通」。
const PROBE_URL = 'https://www.gstatic.com/generate_204'
const PROBE_TIMEOUT_MS = 5000

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
  openReaderBook,
  openSidePanelForLesson,
  relocateAnchor,
  readerSync,
  readerGet,
  readerBookInfo,
  readerContextQuery,
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
    if (msg && msg[RELAY_MARK]) return undefined
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
        if (!window.__coreadStOverlay) throw new Error('翻译浮层未就绪')
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
    return fail('PARSE_ERROR', '模型返回的内容格式不正确，请重试')
  }

  try {
    await ensureOverlay(tab.id)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (payload, rect, sourceText) => {
        if (!window.__coreadStOverlay) throw new Error('翻译浮层未就绪')
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
      syncError = '尚未配置模型 API'
    }
  } catch {
    syncError = 'CoRead 本机服务未连接'
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
    recordError = 'CoRead 本机服务未连接，无法读取译文记录'
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

/**
 * 模型请求失败后补做的一次连通性探测：拿一个与模型服务无关的公共端点试一下。
 *
 * 为什么需要：浏览器对「DNS 失败 / 端口不通 / 地址缺协议头 / 被系统代理挡住」只回同一句
 * Failed to fetch，光看那句话无法判断该去修配置还是修网络。探测结果让文案能直接说清楚：
 *   · 探测也失败 → 连别的外网也不通（常见元凶：系统代理指向了一个没在跑的端口）
 *   · 探测成功   → 网络整体是通的，问题只在这个模型地址（域名/端口/被单独拦）
 * 只在出错路径上跑一次，正常翻译完全不受影响；探测失败也不上报，只当没探到。
 *
 * @returns {Promise<string>} 结论句子；探不出来时返回空串
 */
async function probeInternet() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(PROBE_URL, { method: 'GET', signal: controller.signal, cache: 'no-store' })
    return '但本机访问其它外网是通的，问题只在这个模型地址'
  } catch (e) {
    const nm = String(e?.name ?? '')
    if (nm === 'AbortError') return '另一项连通性探测也超时，本机当前访问外网很可能整体不通'
    return '另一项连通性探测也失败，本机当前访问外网很可能整体不通'
  } finally {
    clearTimeout(timer)
  }
}

/** 上一次请求时上游是否拒了 thinking / response_format。拒过就不再发，免得每次都白跑 400。 */
let thinkingRejected = false
let jsonModeRejected = false

/** 发一次 chat/completions（超时/网络异常原样抛给调用方，它要带着地址分类）。 */
async function postChat(target, apiKey, opts) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    return await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(buildChatBody(opts)),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 发一次模型请求，取回正文。
 *
 * 2026-11 为「重译结果格式不正确」这条报错改过三处（现场见 translate-protocol.js 的
 * buildChatBody 注释）：
 *   ① 默认关思考、开 JSON 模式 —— 思考会把 max_tokens 吃光，答案根本没机会生成；
 *   ② 这两个字段都不是所有上游都认（thinking 是 DeepSeek 系的写法，response_format
 *      有些网关会拒），所以 400 时按"去掉一个再试"的顺序降级，并把被拒的字段记住；
 *   ③ 真的被截断时如实报"额度用完了"，不再笼统地说成格式问题。
 *
 * @param {boolean} jsonMode 这次调用要不要开 JSON 模式。连通性探测那种"只回两个字"的
 *   请求必须关掉（prompt 里没有 JSON 字样，开了反而可能被判格式不符）。
 */
async function chat({ content, maxTokens = 8192, jsonMode = true }) {
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

  const target = chatCompletionsUrl(cfg.apiBase)
  const wantJson = jsonMode && !jsonModeRejected
  const attempts = [{ jsonMode: wantJson, noThinking: !thinkingRejected }]
  if (!thinkingRejected) attempts.push({ jsonMode: wantJson, noThinking: false })
  if (wantJson) attempts.push({ jsonMode: false, noThinking: false })

  let resp
  let body = ''
  let okAt = -1
  for (let i = 0; i < attempts.length; i++) {
    const opt = attempts[i]
    try {
      resp = await postChat(target, cfg.apiKey, { model: cfg.model, content, maxTokens, ...opt })
    } catch (e) {
      // 带上 target：浏览器对 DNS 失败 / 端口不通 / 地址缺协议头 / 被系统代理挡住都只回一句
      // Failed to fetch，没有这个地址与这次探测，就无法区分是「配置写错了」还是「网络到不了」。
      return { ok: false, error: classifyFetchError(e, target, await probeInternet()) }
    }
    body = await resp.text()
    if (resp.ok) { okAt = i; break }
    // 只在"还有备选、且像是字段不被认"时才降级：400 是这一类的典型表现
    if (resp.status !== 400 || i === attempts.length - 1) break
  }
  // 认账：哪一次成了，就把"失败的尝试里有、成功的那次里没有"的开关记下来 ——
  // 只记真正被去掉的那个（早先一版会把两个都记上，于是白白丢掉了 JSON 模式的好处）。
  if (okAt > 0) {
    const good = attempts[okAt]
    for (let i = 0; i < okAt; i++) {
      if (attempts[i].noThinking && !good.noThinking) thinkingRejected = true
      if (attempts[i].jsonMode && !good.jsonMode) jsonModeRejected = true
    }
  }
  if (!resp.ok) return { ok: false, error: classifyHttpError(resp.status, body) }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return { ok: false, error: { code: 'UPSTREAM', message: '模型服务返回的内容不是 JSON', detail: body.slice(0, 200) } }
  }
  const choice = payload?.choices?.[0]
  const text = extractReplyText(payload)
  if (!text) {
    if (choice?.finish_reason === 'length') {
      const used = payload?.usage?.completion_tokens_details?.reasoning_tokens
      return fail('TRUNCATED',
        '模型把输出额度（' + maxTokens + ' tokens）用完了，答案没写完就被截断'
        + (used ? '，其中 ' + used + ' 花在"思考"上' : '')
        + '。请重试；若反复如此，请在工具箱里换一个非推理模型')
    }
    return { ok: false, error: { code: 'UPSTREAM', message: '模型未返回内容' } }
  }
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
    return fail('PARSE_ERROR', '模型返回的内容格式不正确，重试后仍失败。请重新框选')
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
  try {
    return { ok: true, data: { original: text, translation: parseTranslation(r.text).translation } }
  } catch {}

  // 解析失败补救一次：把同一段原文再要一遍，这次明确要求只吐 JSON。
  // 不把上一次的输出贴回去让它"整理" —— 万一那段是模型的思考过程，
  // 整理出来的就是一段**说得通但翻错了**的译文，比直接报错更糟。
  const retry = await chat({ content: buildTextContent(prompt + '\n上一次没有按格式返回。这次只输出那一个 JSON 对象，不要任何解释、前缀或代码块。', text) })
  if (retry.ok) {
    try {
      return { ok: true, data: { original: text, translation: parseTranslation(retry.text).translation }, retried: true }
    } catch {}
  }
  // 两次都不成：把模型原文的头一段留在控制台，下次不必再靠猜（这条报错本身看不出模型回了什么）
  console.warn('[翻译] 两次都没解析出 JSON，模型原文前 200 字：', String(r.text).slice(0, 200))
  return fail('PARSE_ERROR', '重译结果格式不正确')
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
    return fail('PARSE_ERROR', '模型未按格式返回位置信息', parsed.raw)
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

async function readerSync(msg, sender) {
  readerNotesSnapshot = msg && msg.snapshot ? msg.snapshot : null
  // `fromActive` = 这份快照是不是**活动标签页**推上来的（见 senderTabActive）。
  // 侧栏据此决定"要不要把当前书切过去"：没在看的阅读器标签页不许改侧栏的当前书。
  const fromActive = await senderTabActive(sender)
  broadcast({ action: 'readerUpdate', snapshot: readerNotesSnapshot, fromActive })
  return { ok: true }
}

/**
 * 这条消息是不是来自**活动标签页**？—— true / false，判不出来 = null。
 *
 * 为什么要问这个（2026-11 二次改版，用户要求"侧栏只跟随当前标签页"）：
 * 阅读器页面**加载时**会自己打开 URL 里指定的那本书（深链 `?open=`），并推一份
 * "我换书了"的快照。扩展一重载、或者浏览器恢复上次的会话，几个后台阅读器标签页会
 * 同时加载、各推一份 —— 采纳它们等于让"用户根本没在看的标签页"改掉侧栏的当前书。
 * 有了这个字段，侧栏只认从用户正看着的那个标签页推上来的那一份。
 *
 * 判不出来（拿不到 tab、`tabs.get` 抛错）时如实报 null：**调用方按"就当它是"处理**。
 * 宁可放过一份可疑的快照，也不要把"我问不出来"变成"侧栏不跟了"。
 */
async function senderTabActive(sender) {
  const id = sender && sender.tab ? sender.tab.id : undefined
  if (typeof id !== 'number') return null        // 不是从标签页来的（扩展页面自己发的消息）
  try {
    const t = await chrome.tabs.get(id)
    return !!t.active
  } catch (e) {
    // `tabs.get` 失败（标签页刚被关掉）时退回消息自带的快照值；连它都没有就报"判不出来"
    return sender.tab && typeof sender.tab.active === 'boolean' ? sender.tab.active : null
  }
}

async function readerGet() {
  return { ok: true, snapshot: readerNotesSnapshot }
}

/**
 * 「当前在看哪本书」（2026-11 新增，给侧栏用）。
 *
 * 侧栏判断"当前在读哪本书"一直是去问活动的**微信读书** tab（sidebar.js 的
 * refreshCurrentBook），阅读器页面不在它的查询范围内 —— 所以一边用阅读器看 PDF、
 * 一边开着侧栏时，侧栏显示的是"未检测到正在阅读的书籍"，引用/消息也就没有归属。
 *
 * 这里让侧栏能问后台：阅读器开着哪本书。
 * **直接问页面**，不用缓存的那份快照：扩展重载或 service worker 被回收后缓存是空的，
 * 而"当前打开的是哪本"只有页面自己知道（页面的 state 是权威）。
 *
 * ── ⚠️ 2026-11 二次改版：**只认活动标签页** ─────────────────────────────────
 * 旧版在"活动 tab 不是阅读器"时会再**按 URL 在整条标签栏里找一个开着的阅读器 tab**
 * （标成 `via:'background'` 交给侧栏）。那条兜底是治"打开 PDF 但侧栏没跟过去"时加的，
 * 但它把"阅读器开着"当成了"正在读"，于是：用户在微读里读书、或者干脆在看新闻，
 * 只要那个 PDF 标签页还开在标签栏里，侧栏就一直挂着它的会话 ——
 * 用户实测报的正是"即使当前在毫不相关的标签页，只要标签栏内有其标签页，侧栏就一直
 * 显示着这个会话"。而微信读书那本书不是这样：离开它的标签页，侧栏就回到书单界面。
 * 现在两边一致（用户 2026-11 定调）：
 *
 *   活动标签页 = 我们的阅读器  → 问它开着哪本（`activeKind:'reader'`）
 *   活动标签页 = 别的任何页面  → **没有书**，不再拿后台挂着的阅读器顶替
 *
 * 注意"活动标签页是哪一类页面"只查 URL、**不依赖任何消息往返**（见 activeTabKind），
 * 所以侧栏据此清空是安全的：问不倒的事实才配决定"有没有书"。
 *
 * ── 侧栏问"我现在该认哪本书" ─────────────────────────────────────────────────
 * ⚠️⚠️ 为什么不能让侧栏直接广播 `readerBookInfo`：
 * 那条消息**打开着的阅读器页面也会收到并作答**（reader.js 的 onMessage 就是为"后台点名问页面"
 * 写的），而广播是**先答的赢**。页面的答复只能说明"我这儿开着哪本"——它**不知道自己是前台
 * 还是后台标签页**，也没有"活动标签页是不是微读"这个信息。
 *
 * 实测后果（2026-11 用户报"回到微信读书看《大国大城》，侧栏没跟过去"）：
 * 用户切回微读 → 侧栏问"认哪本" → **阅读器页面抢先答"我这儿开着教程书"** →
 * 侧栏把教程书当成当前书，**根本走不到"问微信读书页"那一步**。
 *（上一版给两份答复补齐了 `notReader` 字段，反而让页面这份答复变成了"合法答案"。）
 *
 * 修法：这一条**只给后台**（页面没有这个动作的处理分支，答不了），
 * 并且带一个 `req` 随机串、要求原样回传——将来再冒出第三个应答者也骗不过侧栏。
 */
async function readerContextQuery(msg) {
  const r = await readerBookInfo()
  return Object.assign({ req: (msg && msg.req) || '' }, r)
}

async function readerBookInfo() {
  const tab = await activeTab()
  const url = String((tab && tab.url) || '')
  /**
   * ① 活动标签页**就是**我们的阅读器 → 问它开着哪本。
   *
   * `activeKind:'reader'` 是给侧栏看的结论（它不再需要自己判断"这个 tab 是什么"）。
   * 这里**不再有"按 URL 找一个后台阅读器"那一步**：理由见上面的改版说明。
   */
  if (isReaderUrl(url)) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { action: 'readerBookInfo' })
      /**
       * ⚠️ **"答非所问"也必须算 unknown**（2026-11 用户实测，真正的根因在这里）。
       *
       * `tabs.sendMessage` 在"页面在、但还没有监听器"时**不抛错**，它会 resolve 成
       * `undefined`——于是走进成功分支、`(r && r.book) || null` 得到 `null`，
       * 后台回了一句"阅读器开着、但没有书"。侧栏照做会把当前书清掉：
       * 书单铺开、底部那格换成 PDF 入口条、引用"暂未关联书籍"。
       * 用户看到的就是那句"**底层界面回到选择书界面**"。
       *
       * 判据：**只有当答复明确是那条 bookInfo 的答复**（带 `ok:true`）时才认它的话；
       * 否则一律当"它现在答不上来"。这一条同时覆盖了页面正在加载、模块还没跑起来、
       * 以及任何"回了但不是我要问的那件事"的情况。
       */
      if (!r || typeof r !== 'object' || r.ok !== true) {
        return { ok: true, notReader: false, activeKind: 'reader', unknown: true, book: null, tabId: tab.id, url }
      }
      // 页面**正在打开书**（深链 `?open=` 刚到、书还没落地）：这也是"还没准备好"。
      // 少了这一条，侧栏会在"打开阅读器"之后的一两秒里收到"没有书"并把当前书清掉。
      if (r.loading) {
        return { ok: true, notReader: false, activeKind: 'reader', unknown: true, loading: true, book: null, tabId: tab.id, url }
      }
      return { ok: true, notReader: false, activeKind: 'reader', book: r.book || null, tabId: tab.id, url }
    } catch (e) {
      /**
       * **问不到 ≠ 没有书**（2026-11 用户实测）：阅读器**正在加载/重载**时消息就是发不进去的，
       * 如实回报 `unknown: true`，侧栏据此保留上一次已知的书。
       */
      return { ok: true, notReader: false, activeKind: 'reader', unknown: true, book: null, tabId: tab.id, url }
    }
  }
  /**
   * ② 活动标签页不是阅读器 → 侧栏该认哪本由 `activeKind` 说话（侧栏据此决定：
   * 微读书页去问它 / 其它页面就是"没有书"）。
   *
   * `tabId` 一并带上：侧栏要问微读页面时，问的就是**这一个**标签页 ——
   * 不让它再自己去 `tabs.query` 一次（两次查询之间用户切了 tab，两个答案就会打架）。
   */
  return { ok: true, notReader: true, activeKind: activeTabKind(url), book: null, tabId: tab && tab.id, url }
}

/**
 * 活动标签页属于哪一类页面（2026-11 二次改版）。
 *
 * **只看 URL，不问页面**——这是"侧栏该不该认一本书"的唯一依据，所以它必须是问不倒的事实。
 * 消息往返会失败、页面会还没起来，而"你现在停在哪个网址上"不会。
 *
 *   'reader'        我们的 PDF 阅读器页面（由 isReaderUrl 先判掉，这里不重复）
 *   'weread-book'   微信读书的**书页**（`/web/reader/<书 ID>`）→ 侧栏去问它要书名
 *   'weread'        微信读书的其它页（书架 / 详情 / 搜索…）→ 无书
 *   'page'          文库类网页阅读源（marxists / bilibili）→ 无书（绑定与否由页面自己报）
 *   'other'         跟阅读毫无关系的页面 → 无书
 *   'unknown'       拿不到活动标签页（没有窗口 / 查询失败）→ **什么都不知道，别动侧栏**
 */
export function activeTabKind(url) {
  const s = String(url || '')
  if (!s) return 'unknown'
  const host = safeHost(s)
  if (host === 'weread.qq.com' || host.endsWith('.weread.qq.com')) {
    try {
      return /^\/web\/reader\/[^/]+/.test(new URL(s).pathname) ? 'weread-book' : 'weread'
    } catch (e) {
      return 'weread'
    }
  }
  if (isPageSourceUrl(s)) return 'page'
  return 'other'
}

function safeHost(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase() } catch { return '' }
}
function isPageSourceUrl(url) {
  const h = safeHost(url)
  return h === 'marxists.org' || h.endsWith('.marxists.org') || h === 'bilibili.com' || h === 'www.bilibili.com'
}

/**
 * 「这条消息是后台自己广播出去的」标记。
 *
 * 用途只有一个：**别处理自己发出去的消息**（否则 readerCommand 会无限自环，
 * 见那个函数里的说明）。字符串取这个名字是为了不可能与真实字段撞车。
 */
const RELAY_MARK = '__coreadFromBackground'

async function readerCommand(msg) {
  const payload = {
    action: 'readerCommand',
    type: msg && msg.type,
    id: msg && msg.id,
    text: msg && msg.text,
    // quote = 用户在**译文里划出来的那一段**（2026-11，侧栏译文卡片的"划选共读"）。
    // 只有 reference 用得上；漏掉它的话阅读器只能退回"整卡"，表现是"划了半句、
    // 进引用的却是整页译文"——而且不报错。转发是白名单式的，所以新增字段必须加成这里。
    quote: msg && msg.quote,
  }
  /**
   * ⚠️ **自环闸门**（2026-11 修，这是"设为引用点不动"的根因）。
   *
   * 这一条原本写着"发送方收不到自己发的消息，所以这里不会自环"——**那句是错的**：
   * 后台用 `chrome.runtime.sendMessage` 广播出去的消息，**后台自己的 onMessage 也会收到**
   * （service worker 是发送方，它收不到的是"回执"，不是消息本身）。
   * 于是：后台转发 → 自己又收到 → 再进 readerCommand → 再转发…… 无限自环，
   * 阅读器一次都没被调到，面板永远等不到回执 —— 用户看到的就是
   * "点了设为引用，面板不收、划线不出"（而且不报错）。
   *
   * 修法用**标记**而不是换 API：转换 tabs.sendMessage 需要先知道"哪个 tab 是阅读器"，
   * 而这一条的设计前提就是"不猜、广播给所有扩展页面，谁认领谁答"。
   * 带上 RELAY_MARK，后台见到就跳过 —— 同一条规矩本仓库已有先例（sidebar.js 的
   * readerContextQuery 用一个 req 串防"第三个应答者"）。
   */
  payload[RELAY_MARK] = 1
  try {
    const res = await chrome.runtime.sendMessage(payload)
    return res || { ok: false, error: { message: '阅读器未返回结果' } }
  } catch (e) {
    return { ok: false, error: { message: '阅读器无响应（可能未打开）' } }
  }
}

/** 把快捷键转成给阅读器的命令（阅读器页面收不到 chrome.commands，侧栏有焦点时也收不到按键） */
async function relayToReader(type) {
  try {
    await chrome.runtime.sendMessage({ action: 'readerCommand', type, [RELAY_MARK]: 1 })
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
    const p = chrome.runtime.sendMessage(typeof message === 'object' && message ? { ...message, [RELAY_MARK]: 1 } : message)
    if (p && p.catch) p.catch(() => {})
  } catch (e) {}
}

async function testConnection() {
  // 连通性探测要的是"能回两个字"，所以这里**不开** JSON 模式（prompt 里没有 JSON 字样，
  // 开了反而可能被上游按格式不符拒掉）；思考照旧关掉，否则 32 个 token 会被思考吃光。
  const r = await chat({ content: buildTextContent('只回复两个字：正常', ''), maxTokens: 32, jsonMode: false })
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
    if (!resp.ok) return fail('RECEIVER_ERROR', 'CoRead 本机服务返回 HTTP ' + resp.status)
    return { ok: true }
  } catch (e) {
    return fail('RECEIVER_DOWN', 'CoRead 本机服务未连接，本次译文未记录', String(e?.message || e))
  }
}

/** 把本页已记录的译文贴回页面（按记录里的页面坐标还原气泡）。 */
async function restoreTranslations() {
  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')
  if (!tab.url) return fail('NO_TAB', '无法读取当前页面地址')

  let data
  try {
    data = await fetchToolRecords(tab.url, 50)
  } catch (e) {
    // 老版本 receiver 没有这三个端点，会返回 404——提示重启，别让人以为是没连上
    return fail('RECEIVER_READ_FAIL', '无法读取译文记录（' + String(e?.message || e) + '）。若刚更新过 CoRead，请重启本机服务', String(e?.message || e))
  }
  if (!data.records.length) return fail('NO_RECORDS', '本页暂无译文记录')

  try {
    await ensureOverlay(tab.id)
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (records) => {
        if (!window.__coreadStOverlay) throw new Error('翻译浮层未就绪')
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
  if (!tab.url) return fail('NO_TAB', '无法读取当前页面地址')

  let removed = 0
  try {
    const resp = await fetch(RECEIVER_URL + '/tool-records-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url }),
    })
    if (!resp.ok) return fail('RECEIVER_ERROR', 'CoRead 本机服务返回 HTTP ' + resp.status)
    const data = await resp.json().catch(() => null)
    removed = Number(data && data.removed) || 0
  } catch (e) {
    return fail('RECEIVER_READ_FAIL', '无法清除记录（' + String(e?.message || e) + '）。若刚更新过 CoRead，请重启本机服务', String(e?.message || e))
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
 * 判断当前页面属于哪本书。三条路，按优先级：
 *   1. 我们自己的阅读器页面 —— 它自己报书 ID（msg.bookId，见 reader.js 的 setAsReference）。
 *      2026-11 新增：此前只有下面两条路，阅读器两条都不沾，于是"设为引用"永远失败，
 *      用户看到的是「当前页面未关联任何书籍…仅支持微信读书阅读页，或已加入一本书的页面」。
 *   2. 微读：从阅读页 URL 取 bookId。
 *   3. 文库页面（marxists / bilibili）：问页面自己的绑定（miaBindings）。
 * @param {chrome.tabs.Tab} tab 活动标签页
 * @param {object} [msg] 发起方的原始消息（阅读器会把 bookId/bookTitle 放在里面）
 */
async function resolveBookContext(tab, msg) {
  const url = String((tab && tab.url) || '')
  // 1) 我们自己的阅读器：书 ID 由页面自报，不猜
  if (isReaderUrl(url)) {
    const bookId = String((msg && msg.bookId) || '').trim()
    if (!bookId) return null          // 没开 PDF 的阅读器页：确实没有书，让调用方报错
    return { bookId, bookTitle: String((msg && msg.bookTitle) || (msg && msg.pageTitle) || '').trim() }
  }
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
 *
 * `msg.context` = **划线附近的一段原文**（阅读器算好的，见 extension/reader.js 的
 * contextAround）。它随标注一起落盘，agent 处理这条引用时用它当上下文 —— PDF 没有
 * 章节正文可查，只有这一份。别的地方（划词浮层、教程书）不带这个字段，行为不变。
 *
 * `msg.translation` = **用户读到的那半边**（2026-11）。PDF 场景下原文是外文，用户看不懂，
 * 所以引用卡与对话里的引用横幅都以它为主体（原文另行可查）。它随标注落盘，
 * 与 `selectedText`（原文，仍是这条引用的身份）并存 —— 两条腿都要，缺一条就是
 * 「设为引用之后译文不见了」。
 *
 * ── 三个字段的分工（2026-11 三次修，别混）────────────────────────────────────
 *   original    原文。文字段落有（划词抽出来的）；**扫描件天然没有**（图片页没有文字层）
 *   quote       用户在侧栏译文里划出来的那一段（见 reader-notes.js 的划选共读）
 *   translation 显示用的那半边。划选时就是 quote，否则是整段译文
 * 引用的内容（selectedText）按 `original || quote || translation` 取：
 *   · 文字段落 → 原文（与微信读书那条路的语义一致：引用身份是原文）
 *   · 扫描件   → 那段译文（原文压根不存在，硬要"原文优先"只会得到一条空引用）
 * 这个回落顺序是这次改动的关键：以前只写了 `original || translation`，扫描件整页
 * 译文进引用卡，用户想讨论的那一句被埋在里面。
 */
/**
 * 上下文的长度上限。
 *
 * 原来写 2000，因为当时上下文只有"划线前后各 300 字"（≤600 字）。
 * 2026-11 起扫描件的引用会把**整张译文卡片**当上下文（见 reader-anchor.js 的
 * contextForRef），一张整页译文卡可以有两三千字，2000 会把尾巴切掉 ——
 * 所以放到与译文上限一致（4000），一张卡能完整装下。
 */
const MAX_CONTEXT_CHARS = 4000
/** 译文的长度上限（receiver 侧还有一道同样的闸；这里防的是把一个超大字段发出去）。 */
const MAX_TRANSLATION_CHARS = 4000

/**
 * 扫描件（图片页）**连整卡译文都没带上**时的一句说明。
 *
 * 历史：图片页没有文字层，`contextAround` 必然返回空串，所以以前扫描件的引用
 * 一点上下文都没有 —— agent 那边只能落成"（暂无这本书的原文足迹…）"，而它连
 * "为什么没有"都不知道。
 * 现状（2026-11）：阅读器改为把**整张卡片的译文**当上下文报上来（见 reader-anchor.js
 * 的 contextForRef），所以这段说明只是**兜底** —— 只有调用方什么上下文都没给时才用到
 *（老客户端、或上游取不到译文）。它现在的价值是"说清缺什么"，而不是常态。
 *
 * 为什么不做 OCR 补一段真原文：那是又一次模型调用，要等、要花钱，而用户此刻正在
 * 等着设引用；而且 OCR 出来的文字与用户框选的那块未必对得上，"给错上下文"比
 * "明说没有上下文"更坏（同 contextAround 的既有原则）。
 */
const IMAGE_CONTEXT_NOTE = '（本段来自扫描件的框选翻译：这一页没有可提取的文字层，'
  + '因此没有原文可查，也没有划线附近的原文。判断依据只有下面这段译文本身。）'

/**
 * 这次引用该带什么上下文（纯函数，单测在 extension/test/reader-context.test.mjs）。
 *
 * 三级：
 *   ① 调用方给了 → 用它（阅读器已经算好：文字条目是附近原文、扫描件是整卡译文）
 *   ② 没给，而且是"没有原文的扫描件引用" → 一句说明缺什么的 IMAGE_CONTEXT_NOTE
 *   ③ 其它情况 → 空串（不给上下文，比给错的强）
 *
 * 为什么 ② 不能一律补：文字条目的原文是引用身份（selectedText），agent 拿它去查章节正文；
 * 再塞一段"附近原文"反而是重复。而扫描件没有身份可查，只能靠这段说明 + 译文本身。
 */
export function refContextOf(msg) {
  const own = String(msg?.context || '').trim().slice(0, MAX_CONTEXT_CHARS)
  if (own) return own
  const original = String(msg?.original || '').trim()
  if (msg?.image === true && !original) return IMAGE_CONTEXT_NOTE
  return ''
}

async function setTranslationRef(msg) {
  const original = String(msg?.original || '').trim()
  const quote = String(msg?.quote || '').trim().slice(0, MAX_TRANSLATION_CHARS)
  const isImage = msg?.image === true   // 供 resolveBookContext 判"扫描件那条路"用
  // 引用的内容：原文优先（那是引用身份），扫描件才落到摘录/整段译文上
  const selected = original || quote || String(msg?.translation || '').trim()
  if (!selected) return fail('BAD_REQUEST', '没有可设为引用的内容')
  const context = refContextOf(msg)
  // 显示用的那半边：划选了就是那一段，否则整段译文
  const translation = (quote || String(msg?.translation || '').trim()).slice(0, MAX_TRANSLATION_CHARS)

  const tab = await activeTab()
  if (!tab) return fail('NO_TAB', '没有可用的标签页')

  const ctx = await fillBookTitle(await resolveBookContext(tab, msg))
  if (!ctx) {
    return fail(
      'NO_BOOK',
      isReaderUrl(tab && tab.url)
        ? '阅读器里还没打开 PDF，无法设为引用。'
        : '当前页面未关联任何书籍，无法设为引用。仅支持微信读书阅读页、CoRead 阅读器，或已「加入一本书」的页面。',
    )
  }

  try {
    const resp = await fetch(RECEIVER_URL + '/annotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: ctx.bookId,
        bookTitle: ctx.bookTitle || '',
        selectedText: selected,   // original || quote || translation（见函数头那段分工）
        ...(context ? { context } : {}),
        // 译文（2026-11）：只有真的翻过才带。浮层那条（translate-overlay）也带它，
        // 但那份"原文"是 textarea 里可编辑的稿子，语义已在调用处说明。
        ...(translation ? { translation } : {}),
        setRef: true,             // 只设为当前引用，不触发 agent（receiver 据此推 annotation-select）
        source: 'translate-tool',
        sourceUrl: String(msg?.url || ''),
      }),
    })
    if (!resp.ok) return fail('RECEIVER_ERROR', 'CoRead 本机服务返回 HTTP ' + resp.status)
  } catch (e) {
    return fail('RECEIVER_DOWN', '未连接 CoRead 本机服务，未设为引用', String(e?.message || e))
  }

  // 顺手把侧栏打开。拿不到用户手势时会失败，失败也无所谓：引用已入列表，打开侧栏就能看到。
  try { await chrome.sidePanel.open({ tabId: tab.id }) } catch (e) {}

  // 留下"待选引用"标记：侧栏**之后**才打开（或刚被回收重建）时靠它把这条自动选中。
  // 为什么必须有（2026-11 用户实测"设了引用，侧栏里没见着选中"）：
  // 走 SSE 的实时路径要求侧栏此刻正在收——阅读器里划词点「共读」时侧栏往往还没开，
  // 那条 annotation-select 广播就落进了空气。这个标记是"下次打开时补上"，
  // 与划线共读（content.js 那条路）用的是同一个键，语义一致。
  try {
    await chrome.storage.local.set({
      pendingSelectRef: {
        bookId: ctx.bookId,
        bookTitle: ctx.bookTitle || '',
        selectedText: selected,
        // 译文（2026-11）：待选标记也要带，否则"侧栏当时没开"这条路的译文又丢了 ——
        // 实时通道（SSE）与待选标记是同一件事的两条路，只补一条等于修了一半。
        ...(translation ? { translation } : {}),
        chapter: '',
        chapterUid: '',
        sourceUrl: String(msg?.url || ''),
      },
    })
  } catch (e) {}

  return { ok: true, bookTitle: ctx.bookTitle || '' }
}

/**
 * 打开「我们自己的阅读器」里的一本书（2026-11 用户实测："我点击第一次共读对话的时候
 * 阅读器并没有自己弹出来"）。
 *
 * 侧栏为什么会点到它却没反应：书单里那几本 `rd_` 开头的书是**阅读器放进去的**，
 * 而侧栏的"点一本"从一开始只做一件事——把聊天记录的归属切到那本书（手动选书）。
 * 它压根不负责打开 PDF，也从没有过"去读"的入口。这里补上这条动作。
 *
 * 为什么由后台开标签页而不是侧栏自己开：侧栏页面没有开标签页的能力，
 * 只有后台有。书已经在书库里（原件在接收端），所以带上 `?open=<hash>` 让阅读器自己取。
 */
/**
 * 后台侧的调试上报（写进 `logs\debug.jsonl`，与 sidebar.js 的 postSidebarDebug 同一落点）。
 *
 * 为什么后台也要报：有些链路**只能靠用户点**（比如侧栏里点一本书去打开阅读器），
 * 我没法自动跑，出事时唯一的现场记录就是这个日志。上一轮自检报告里
 * "reused:false 而 URL 又没有 ?open="这种自相矛盾，如果有这条日志一眼就能看出走了哪条路。
 * 静默失败：接收端没起时这不是错误。
 */
function reportDebug(data) {
  try {
    fetch(RECEIVER_URL + '/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'background', ...data, timestamp: Date.now() }),
    }).catch(() => {})
  } catch (e) {}
}

/**
 * 打开侧栏并让它接上课（书里「开始本课」按钮走这条）。
 *
 * ⚠️ `chrome.sidePanel.open()` 是**必须由用户手势触发**的接口（浏览器策略，不是我们的 bug）：
 * 手势能不能穿过 sendMessage 传到后台，各版本行为不一致——实测有时成功、有时报
 * "may only be called in response to a user gesture"。
 * 所以这里**如实回报 opened**，让书页那个按钮能说真话（"侧栏没自动打开，请手动开一下"），
 * 而不是假装开始了。真正的接续不靠这个调用：引导状态在 chrome.storage 里，
 * 侧栏一打开就 restoreRun() 接上。
 */
/**
 * 请侧栏开某一课（书里「开始本课」按钮走这条）。
 *
 * ── 两件事必须分开做（2026-11 用户实测踩到）────────────────────────────────
 * ① **广播**：告诉侧栏"读一下 storage、把那一课接上"。
 * ② **打开侧栏**：`chrome.sidePanel.open()` 是**必须由用户手势触发**的接口。
 *
 * 原先把 ② 写在前面、① 跟在后面，于是 `open()` 一失败（实测**每次都失败**，见下）
 * 就把 ① 也一起带走了——侧栏明明开着，却收不到"开始这一课"的通知。这是最坏的一种：
 * 功能其实可用，只因为顺序写错而整条失效。
 *
 * ── 为什么 open() 必然失败（实测三次，日志在 logs\debug.jsonl）──────────────
 *   15:45:56 / 15:46:52  open-side-panel-lesson  opened=false
 *   error=`sidePanel.open()` may only be called in response to a user gesture.
 * 手势**不会**穿过 sendMessage 从阅读器页传到后台。这是浏览器的安全边界，不是 bug，
 * 所以只能如实告知用户去点一下工具栏图标；打开时靠 restoreRun() 自动接上（① 那条路）。
 *
 * ── 为什么要先查"侧栏在不在"────────────────────────────────────────────────
 * 侧栏开着的时候**根本不需要** open()。先用 getContexts 查一次，在就跳过，
 * 这样最坏情况下也不会白报一个失败给用户看。
 */
async function openSidePanelForLesson(msg) {
  // ① 广播（无条件，与"能不能打开"完全无关）
  const ping = () => {
    try {
      const p = chrome.runtime.sendMessage({ action: 'coreadTutorialLesson', chapter: msg?.chapter })
      if (p && p.catch) p.catch(() => {})
    } catch (e) {}
  }
  ping()
  setTimeout(ping, 500)     // 侧栏刚被打开时脚本可能还没就绪，再补一次

  // ② 侧栏已经在？那就不用 open() 了
  let alreadyOpen = false
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })
      alreadyOpen = !!(ctxs && ctxs.length)
    }
  } catch (e) {}

  let opened = alreadyOpen
  let error = ''
  if (!alreadyOpen) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      await chrome.sidePanel.open({ windowId: tab ? tab.windowId : undefined })
      opened = true
    } catch (e) {
      // 最常见的失败就是"缺手势"。如实回报，让书里那块卡片能说真话：
      // 引导在右侧侧栏，点一下工具栏图标就接上了（状态在 storage 里等着）。
      error = String((e && e.message) || e)
    }
  }

  reportDebug({
    source: 'open-side-panel-lesson', stage: 'done',
    broadcast: true, alreadyOpen, opened, error,
    // ⚠️ `chapter` 传 0 时原来会被省略，于是日志里根本看不出"调用方到底传没传"。
    // 我因此误判过一次"用户跑的是旧版本"——其实是新版本、只是没写这个字段。
    // 诊断字段宁可冗余：现场只有一次，缺一个字段就要多跑一轮。
    inChapter: Number(msg?.chapter) || 0,
    chapter: Number(msg?.chapter) || 0,
  })
  return { ok: true, broadcast: true, alreadyOpen, opened, error }
}

/**
 * 拼「打开阅读器里的某一本」的 URL。
 *
 * 抽成纯函数是为了**能被自测直接验**：这条链路在真实浏览器里只能靠用户点，
 * 而"URL 到底拼成什么样"恰恰是上一轮报告里唯一说不清的地方
 * （后台回报 reused:false，而标签页 URL 里却没有 ?open= —— 两个事实对不上）。
 * 抽出来之后 test/selftest 可以直接把各种书 ID 喂进来，看拼出来的东西对不对。
 *
 * @param {string} base 书 ID（`rd_<hash>`）
 * @param {string} [name] 书名（可选，只用来让阅读器少查一次）
 * @returns {string} 合法则返回完整 URL；不像书 ID 则返空串（调用方报错）
 */
export function buildReaderBookUrl(base, name, chapter) {
  const id = String(base || '').trim()
  if (!/^rd_[A-Za-z0-9_]{8,}$/i.test(id)) return ''
  const hash = id.replace(/^rd_/i, '').toLowerCase()
  if (!/^[a-f0-9]{16,64}$/.test(hash)) return ''
  const reader = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('reader.html')
    : 'reader.html'
  const ch = Number(chapter) > 0 ? '&chapter=' + Math.floor(Number(chapter)) : ''
  return reader + '?open=' + hash + (name ? '&name=' + encodeURIComponent(String(name).slice(0, 120)) : '') + ch
}

async function openReaderBook(msg) {
  const base = String(msg?.base || '').trim()
  if (!/^rd_[A-Za-z0-9_]{8,}$/i.test(base)) {
    return fail('BAD_BOOK', '这不是阅读器里的书（只有我们自己阅读器放进去的书能这样打开）')
  }
  const hash = base.replace(/^rd_/i, '').toLowerCase()
  if (!/^[a-f0-9]{16,64}$/.test(hash)) return fail('BAD_BOOK', '书 ID 形态不对')
  const url = buildReaderBookUrl(base, msg?.name, msg?.chapter)
  // 已经开着阅读器（不管在哪个窗口）就地切过去并打开那本，而不是再开一个新标签：
  // 开第二个阅读器页会让"当前在看哪本书"这件事出现两个答案。
  let reused = false
  let action = ''
  const wantChapter = Number(msg?.chapter) || 0
  try {
    const opened = await chrome.tabs.query({ url: chrome.runtime.getURL('reader.html') + '*' })
    if (opened && opened.length) {
      reused = true
      const tab = opened[0]
      /**
       * ⚠️ **已经开着这一本、又没有指定要翻到哪一章时，只切前台，不做任何导航。**
       *
       * 为什么（2026-11 用户实测）：`chrome.tabs.update` 只要 URL 变一点点就是**真导航**，
       * 而扩展页面一导航就整页重载——阅读器回到初始空状态，**闪出书库（选书界面）**，
       * 然后才重新打开那一本。用户看到的就是"底层界面回到了选择书籍的界面"。
       *
       * 这条规则对所有调用方都成立（侧栏的 📍、书里的入口、书单的「读」），
       * 所以修在这里最省事、也最不容易漏：**没有新意图就不要重新加载页面**。
       */
      let sameBook = false
      try {
        const cur = new URL(tab.url || '')
        sameBook = (cur.searchParams.get('open') || '').toLowerCase() === hash
      } catch (e) {}
      if (sameBook && wantChapter === 0) {
        await chrome.tabs.update(tab.id, { active: true })
        action = `focus tab ${tab.id}（已在读这一本，不重新加载）`
        try { await chrome.windows.update(tab.windowId, { focused: true }) } catch (e) {}
      } else {
        await chrome.tabs.update(tab.id, { active: true, url })
        action = `update tab ${tab.id}`
        // 切窗口只是顺手，失败无所谓 —— 但**绝不能因为它失败就改变返回值**：
        // 曾经把这三行包在同一个 try 里、后面跟着 return，一旦 windows.update 抛错
        // 就掉进"没找到标签页"的分支，于是又开一个新标签（自检报告里表现为
        // reused:false 与"URL 里没有 ?open="同时出现，自相矛盾）。
        try { await chrome.windows.update(tab.windowId, { focused: true }) } catch (e) {}
      }
    }
  } catch (e) { action = 'query/update 抛错: ' + String((e && e.message) || e) }

  try {
    if (!reused) {
      const t = await chrome.tabs.create({ url })
      action = `create tab ${t && t.id}`
    }
  } catch (e) {
    return fail('OPEN_FAILED', '打不开阅读器页面：' + String((e && e.message) || e))
  }

  // 把这次到底走了哪条路写进 debug 日志：这条链路只能靠用户点，日志是唯一的现场记录
  reportDebug({
    source: 'open-reader-book', stage: 'done',
    reused, action, hash: hash.slice(0, 12), url,
    // `chapter` 一定要写（哪怕是 0）：日志里缺这个字段，就分不清"调用方没传"和
    // "版本旧、压根没这个功能"——我因此误判过一次（详见 docs 的教训一节）
    chapter: Number(msg?.chapter) || 0,
  })
  return { ok: true, reused, hash, url, action }
}

/** 工具箱里关掉翻译时，四个入口统一挡在这里（「测试连接」不受影响，方便关着也能验证配置）。 */
async function requireEnabled() {
  const ov = await readOverrides()
  if (ov.enabled) return null
  // 快捷键路径没有面板可点，用角标给个反馈，否则按键像没反应
  flashBadge('关', '翻译已在工具箱中关闭')
  return fail('DISABLED', '翻译已在工具箱中禁用。请在侧栏「⋯ → 🧰 工具箱 → 翻译」中启用')
}
