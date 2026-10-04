/**
 * CoRead 翻译能力 · 纯函数层：prompt 组装、请求体组装、模型回复解析、错误分类。
 *
 * 本文件不含任何 chrome.* 调用，可在 node 里直接单测（见 test/translate-protocol.test.mjs）。
 * translate-background.js 以 ES module 方式 import；translate-overlay.js 是 executeScript
 * 按需注入的经典脚本，不能 import 模块，因此不依赖本文件。
 */

export const RECEIVER_URL = 'http://127.0.0.1:7239'
export const API_CONFIG_PATH = '/api-config'

/**
 * chrome.storage.local 的键。侧栏工具箱写入，translate-background 读取。
 *
 * 配置策略：默认全部沿用 CoRead 的 agent/api-config.json（经 receiver 读取）。
 * 下面三个 *Override 是可选的按字段覆盖：已填写的项覆盖同名项，未填写的项沿用其值。
 */
export const STORE_KEYS = {
  config: 'stConfig',                    // CoRead 配置的本地缓存（每次读真源后刷新）
  enabled: 'stEnabled',                  // 翻译总开关，缺省视为启用
  apiBaseOverride: 'stApiBaseOverride',
  apiKeyOverride: 'stApiKeyOverride',
  modelOverride: 'stModelOverride',
  legacyVisionModel: 'stVisionModel',    // 旧键：早期只能覆盖模型，读取时兼容
  // 最近一次翻译的诊断（锚点拿到了没有、文字落在哪个 frame）。
  // 特意存在扩展本地而不是只写进 receiver：诊断信息要能在不重启任何进程的情况下看到。
  lastDiag: 'stLastDiag',
}

/** prompt 版本号。prompt 或输出协议改动时加一，便于排查历史缓存差异。 */
export const PROMPT_VERSION = 2

export const IMAGE_PROMPT = [
  '你是屏幕截图翻译器。用户框选了屏幕的一块区域，图片就是这块区域。',
  '1. original：逐字誊写图片中的正文，不改写、不补全、不总结，保留原有的段落与换行。',
  '2. translation：把 original 译成简体中文，忠实原文，术语前后一致，保留段落与换行。',
  '3. 截图里可能混有按钮、菜单、图标、状态栏或截断的半行文字。只处理正文，忽略明显的界面噪声。',
  '4. 只输出一个 JSON 对象，格式为 {"original":"…","translation":"…"}。',
  '不要输出解释、前后缀、Markdown 代码块或任何 JSON 之外的内容。',
  '5. 图中没有可翻译的文字时，original 与 translation 都填空字符串。',
].join('\n')

export const RETRANSLATE_PROMPT = [
  '把用户给出的文字译成简体中文。这段文字来自屏幕截图识别，可能有错字与断行。',
  '保留段落与换行。',
  '只输出一个 JSON 对象，格式为 {"translation":"…"}。',
  '不要输出解释、前后缀或 Markdown 代码块。',
].join('\n')

/** 划词翻译：来源是网页上的真实文本，没有识别误差。 */
export const SELECTION_PROMPT = [
  '把用户选中的文字译成简体中文。保留段落与换行。',
  '只输出一个 JSON 对象，格式为 {"translation":"…"}。',
  '不要输出解释、前后缀或 Markdown 代码块。',
].join('\n')

/** 首次解析失败后的补救 prompt：把模型上一次的输出贴回去，要求只吐 JSON。 */
export const RETRY_PROMPT = [
  '你上一次的输出不是合法 JSON。请把它整理成合法的 JSON 对象，字段为 original 与 translation。',
  '只输出 JSON，不要任何其他文字。以下是上一次的输出：',
].join('\n')

/**
 * 重新定位：让模型看着当前屏幕截图，找出某段文字在画面里的位置。
 * 画布书的正文画在 canvas 上，页面里没有文字节点，布局一变就没有任何本地办法
 * 把高亮映射回去——只能看着渲染结果找。按需触发（用户点按钮），不自动跑。
 */
export const RELOCATE_PROMPT = [
  '这是一张网页截图。请在图中找到下面这段文字，并给出它的位置。',
  '给出的这段只是**开头一部分**，用它在图中定位即可。',
  '用比例坐标表示（0~1，相对整张图片的宽高），x/y 是边界框左上角，w/h 是宽高。',
  '',
  '要找的文字：',
  '「{text}」',
  '',
  '提示：它大约在 x={hx}、y={hy} 附近（同样是比例坐标），但页面可能重排过，',
  '以你在图中真实看到的为准。截图里可能有工具界面留下的深色小提示条，忽略它。',
  '',
  '如果在图中**看不到**这段文字，输出 {"x":0,"y":0,"w":0,"h":0}。',
  '否则只输出一个 JSON 对象，例如 {"x":0.12,"y":0.34,"w":0.5,"h":0.06}。',
  '不要输出任何解释、前后缀或代码块。',
].join('\n')

/**
 * 取一段用于定位的短文本：折叠空白、在词边界截断。
 * 整段原文（几百字还带换行）让模型在画面里精确匹配太难，开头几十字好得多。
 */
export function relocateSnippet(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp >= max * 0.6 ? cut.slice(0, sp) : cut).trim()
}

export function buildRelocatePrompt(text, hint) {
  const hx = Math.max(0, Math.min(1, Number(hint && hint.x) || 0)).toFixed(3)
  const hy = Math.max(0, Math.min(1, Number(hint && hint.y) || 0)).toFixed(3)
  return RELOCATE_PROMPT
    .replace('{text}', relocateSnippet(text, 80))
    .replace('{hx}', hx)
    .replace('{hy}', hy)
}

/**
 * 解析重新定位的结果。三种结局要分开，因为补救办法不同：
 *   ok        拿到可用的框
 *   notvisible 模型明确说"画面上看不到这段文字"（全 0）——要用户滚动到它可见
 *   badformat 输出根本不是约定的 JSON —— 是模型/格式问题
 * @returns {{box: {x:number,y:number,w:number,h:number}|null, reason: 'ok'|'notvisible'|'badformat', raw: string}}
 */
export function parseRelocateReply(raw) {
  const out = { box: null, reason: 'badformat', raw: String(raw ?? '').slice(0, 200) }
  const text = stripCodeFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return out
  let obj = null
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!obj || typeof obj !== 'object') return out
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const box = {
    x: Math.max(0, Math.min(1, num(obj.x))),
    y: Math.max(0, Math.min(1, num(obj.y))),
    w: Math.max(0, Math.min(1, num(obj.w))),
    h: Math.max(0, Math.min(1, num(obj.h))),
  }
  // 全 0 = 模型明确表示"看不到"；框太小 = 当没看见，别把噪点当结果
  if (box.w === 0 && box.h === 0) {
    out.reason = 'notvisible'
    return out
  }
  if (box.w < 0.01 || box.h < 0.002) return out
  out.box = box
  out.reason = 'ok'
  return out
}

export function normalizeApiBase(base) {
  return String(base ?? '').trim().replace(/\/+$/, '')
}

export function chatCompletionsUrl(apiBase) {
  return normalizeApiBase(apiBase) + '/chat/completions'
}

/** apiBase 对应的权限 origin，用于 chrome.permissions.request。 */
export function originPattern(apiBase) {
  const u = new URL(normalizeApiBase(apiBase))
  return u.origin + '/*'
}

export function buildChatBody({ model, content, maxTokens = 2048, temperature = 0.2 }) {
  return {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  }
}

/**
 * 图片只能出现在 user 消息里：放进 system / assistant 会被上游以 400 拒绝。
 * 所以这里始终返回 user 消息的 content 数组。
 */
export function buildImageContent(prompt, dataUrl) {
  return [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]
}

export function buildTextContent(prompt, text) {
  return [
    { type: 'text', text: prompt + '\n\n' + String(text ?? '') },
  ]
}

/** 从 OpenAI 兼容的 chat completions 响应里取出正文。 */
export function extractReplyText(payload) {
  const choice = payload?.choices?.[0]
  const msg = choice?.message
  const content = msg?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  // 部分推理模型把正文放在 reasoning_content；另有数组形态的多段 content
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim()
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('')
      .trim()
    if (joined) return joined
  }
  return ''
}

export function stripCodeFence(text) {
  const s = String(text ?? '').trim()
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  return fence ? fence[1].trim() : s
}

/**
 * 解析模型返回的译文 JSON。
 * 容忍代码块包裹、JSON 前后有多余文字；字段缺失时返回空串。
 * @returns {{original: string, translation: string}}
 * @throws {Error} 解析不出对象或 translation 为空时抛出，code 为 PARSE_ERROR
 */
export function parseTranslation(raw) {
  const text = stripCodeFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw makeError('PARSE_ERROR', '模型输出里没有 JSON 对象')
  }
  let obj
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    throw makeError('PARSE_ERROR', '模型输出的 JSON 无法解析：' + e.message)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw makeError('PARSE_ERROR', '模型输出的 JSON 不是对象')
  }
  const translation = String(obj.translation ?? '').trim()
  if (!translation) throw makeError('PARSE_ERROR', '模型输出里没有 translation 字段')
  return { original: String(obj.original ?? '').trim(), translation }
}

export function makeError(code, message, detail = '') {
  const err = new Error(message)
  err.code = code
  if (detail) err.detail = detail
  return err
}

function brief(text, max = 200) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const VISION_HINTS = /image|vision|visual|multimodal|multi-modal|图片|图像|视觉|不支持|unsupported|invalid content type/i

/** 上游 4xx 里出现这些词时，判定为「当前模型不支持图片输入」。 */
export function isVisionUnsupported(status, bodyText) {
  if (status !== 400 && status !== 404 && status !== 422) return false
  return VISION_HINTS.test(String(bodyText ?? ''))
}

/**
 * 把上游 HTTP 错误翻译成可诊断的 code + 中文文案。
 * @returns {{code: string, message: string, detail: string}}
 */
export function classifyHttpError(status, bodyText) {
  const detail = brief(bodyText)
  if (isVisionUnsupported(status, bodyText)) {
    return {
      code: 'MODEL_NO_VISION',
      message: '当前模型不支持图片输入。请在工具箱翻译页的「自定义模型配置 → 模型」中填写支持图片输入的模型',
      detail,
    }
  }
  if (status === 401 || status === 403) {
    return { code: 'BAD_KEY', message: 'API Key 被拒绝（HTTP ' + status + '）。请检查配置中的 API Key', detail }
  }
  if (status === 404) {
    return { code: 'BAD_ENDPOINT', message: '接口或模型不存在（HTTP 404）。请检查 API 地址与模型名', detail }
  }
  if (status === 413) {
    return { code: 'TOO_LARGE', message: '截图体积超过上游限制，请缩小选区', detail }
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message: '请求过于频繁或额度用尽（HTTP 429）', detail }
  }
  if (status >= 500) {
    return { code: 'UPSTREAM', message: '模型服务返回错误（HTTP ' + status + '）' + (detail ? '：' + detail : ''), detail }
  }
  return { code: 'UPSTREAM', message: '模型服务返回错误（HTTP ' + status + '）' + (detail ? '：' + detail : ''), detail }
}

/** 把 fetch 抛出的异常翻译成可诊断的 code + 中文文案。 */
export function classifyFetchError(err) {
  const name = String(err?.name ?? '')
  const msg = String(err?.message ?? err ?? '')
  if (name === 'AbortError' || /abort/i.test(msg)) {
    return { code: 'TIMEOUT', message: '模型服务 60 秒内未响应，请重试或更换模型', detail: msg }
  }
  if (name === 'TypeError') {
    return {
      code: 'NETWORK',
      message: '无法连接模型服务。请检查 API 地址，或在工具箱翻译页重新授权该域名',
      detail: msg,
    }
  }
  return { code: 'UNKNOWN', message: '请求失败：' + msg, detail: msg }
}
