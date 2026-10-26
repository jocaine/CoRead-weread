/**
 * CoRead 翻译能力 · 纯函数层：prompt 组装、请求体组装、模型回复解析、错误分类；
 * 另外放一个给托盘用的「插件报到」（reportExtensionToHost，见下）。
 *
 * 本文件不含任何 chrome.* 调用（报到那个函数只读 chrome.runtime.id/version，取不到就返回
 * false），可在 node 里直接单测（见 test/translate-protocol.test.mjs）。
 * translate-background.js 以 ES module 方式 import；translate-overlay.js 是 executeScript
 * 按需注入的经典脚本，不能 import 模块，因此不依赖本文件。
 */

export const RECEIVER_URL = 'http://127.0.0.1:7239'
export const API_CONFIG_PATH = '/api-config'

/**
 * 向本机服务报到一次（POST /hello），把**扩展 ID** 交给它。
 *
 * 为什么需要：托盘右键的「打开 CoRead 阅读器」要打开 chrome-extension://<ID>/reader.html，
 * 而这个 ID 只有浏览器知道（就是下面的 chrome.runtime.id）。托盘是另一个进程，问不到它，
 * 所以由插件每次启动主动报一次；接收端把它落到 data\runtime\extension-id，托盘读那个文件。
 *
 * 三条刻意的选择：
 *   · **不 await、不重试、失败静默**：报到只服务"托盘的快捷方式能用"这一件事，
 *     接收端没启动、或用户根本没装托盘，都不该影响浏览器的任何正常使用。
 *   · **带上版本号**：接收端目前只用它打一行日志（便于排查"用户装的插件是旧的"），
 *     真正用于校验的是 ID 本身。
 *   · **放在本文件**：service_worker.js 与 sidebar.js 都要调，而这两个文件之间没有共享代码
 *     （sidebar 是经典脚本，不 import）。真源放这儿，两边 import 同一份；
 *     接收端地址也复用 RECEIVER_URL，不再各写一份 127.0.0.1:7239。
 *
 * @returns {Promise<boolean>} 报到成功与否（调用方通常直接忽略）
 */
export async function reportExtensionToHost() {
  try {
    const id = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || ''
    if (!id) return false
    const res = await fetch(`${RECEIVER_URL}/hello`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, version: chrome.runtime.getManifest().version }),
    })
    return !!(res && res.ok)
  } catch {
    return false   // 本机服务没起：这不是错误，静默跳过
  }
}
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
export const PROMPT_VERSION = 5
// 5：文本翻译改成「system 放规则 + user 放书名与待译正文」；划词与 OCR 两套规则（2026-10-24）
// 4：新增框选「只识别原文、不翻译」（RECOGNIZE_PROMPT）
// 3：请求体加了 JSON 模式与"关思考"（见 buildChatBody）

export const IMAGE_PROMPT = [
  '你是屏幕截图翻译器。用户框选了屏幕的一块区域，图片就是这块区域。',
  '1. original：逐字誊写图片中的正文，不改写、不补全、不总结，保留原有的段落与换行。',
  '2. translation：把 original 译成简体中文，忠实原文，术语前后一致，保留段落与换行。',
  '3. 截图里可能混有按钮、菜单、图标、状态栏或截断的半行文字。只处理正文，忽略明显的界面噪声。',
  '4. 只输出一个 JSON 对象，格式为 {"original":"…","translation":"…"}。',
  '不要输出解释、前后缀、Markdown 代码块或任何 JSON 之外的内容。',
  '5. 图中没有可翻译的文字时，original 与 translation 都填空字符串。',
].join('\n')

/**
 * 框选后的「只识别原文」：**不翻译**，只把图里的字誊出来。
 *
 * 谁在用它（2026-11）：阅读器的框选菜单里选「设为引用」时。图片页没有文字层，
 * 引用的身份（原文）必须先由模型识别出来；这一步不该顺手翻译 —— 用户明确选的是
 * "设为引用"，多花一次翻译的钱、多等一次，还可能把识别结果盖掉。
 *
 * 输出协议刻意比 IMAGE_PROMPT 少一个字段：只有 original，调用方不会误拿到译文。
 */
export const RECOGNIZE_PROMPT = [
  '你要做的是**原文识别**，不是翻译。用户框选了屏幕的一块区域，图片就是这块区域。',
  '1. 逐字誊写图片中的正文，不改写、不补全、不总结。按自然段输出：段落之间空一行；段落内不要把一句话按截图的行宽切成多行。',
  '2. 截图里可能混有按钮、菜单、图标、状态栏或截断的半行文字。只处理正文，忽略明显的界面噪声。',
  '3. 只输出一个 JSON 对象，格式为 {"original":"…"}。',
  '不要输出解释、前后缀、Markdown 代码块或任何 JSON 之外的内容。',
  '4. 图中没有可识别的文字时，original 填空字符串。',
].join('\n')

/**
 * 文本翻译的规则，放进 **system 消息**（与「待译正文」分开）。
 *
 * 2026-10-24 重写（用户反馈译文生硬）。旧版只有三句：「把用户选中的文字译成简体中文。
 * 保留段落与换行。只输出 JSON。」——那等于要求照着英文的句子结构输出中文，再交给
 * temperature 0.2 去逐字落地，读起来就是翻译腔。这一版把要求写全：
 *   · 先读懂整句再下笔（不让模型一个词一个词对照）
 *   · 按中文语序重组，不保留英文句式与破折号插入语
 *   · 术语/人名/地名首次出现时括注原文，前后一致
 *   · 不增不减，段落保留，段内不按原文行宽断行
 *
 * 为什么单独放 system（同一天定调）：旧版把这些要求和原文用 \n\n 粘在同一条 user 消息里，
 * 模型分不清「要求」和「要译的内容」——哲学/政论原文里全是祈使句，容易被当成指令。
 * 分开之后规则是稳定前缀，正文在 user 消息的【待译文字】区块里（见 buildTranslateContent）。
 *
 * 扫描件那条路（原文是 OCR 认出来的）另用 TRANSLATE_SYSTEM_PROMPT_OCR：多一条「可能有错字」。
 * PDF 文字层抽出来的原文没有识别误差，**不能**带这句——否则模型会去"纠正"人名、术语和旧拼法
 * （2026-10-24 修的就是这个：重译原先一律当 OCR 处理）。
 */
const TRANSLATE_RULES = [
  '你是为中文读者翻译的译者，目标语言是简体中文。',
  '用户消息里用【待译文字】和【待译文字结束】标出的是要翻译的正文；书名只用于理解语境，不要翻译书名。',
  '1. 先读懂整句（必要时连同上文）再下笔；不要一个词一个词对照着译。原文本来就是中文时不要改写句子，只把繁体字转成简体。',
  '2. 译成自然、通顺的现代汉语：按中文的语序和节奏重组句子，该拆的长句拆开，该提前的成分提前；',
  '   不要保留英文的语序、从句嵌套和破折号插入语——原文用破折号插进来的补充说明，按中文习惯改成短句、括号或顺承。',
  '3. 术语、人名、地名在同一段译文里首次出现时，可在译名后用括号注出原文，如「世俗现实（säkulare Wirklichkeit）」；前后译法保持一致。',
  '4. 不增、不减、不改写原意：不要添加原文没有的判断、因果或评价，也不要漏掉信息；原文的论证、语气和修辞要保留。',
  '5. 保持原文的段落划分；一段之内不要按原文的行宽断行。',
]
const TRANSLATE_OUTPUT_RULE = '6. 只输出一个 JSON 对象，格式为 {"translation":"…"}。不要输出解释、前后缀或 Markdown 代码块。'
/** 原文是 OCR 认出来的才有这一条（扫描件 / 框选识别）。不编号：它说的是"输入从哪来"，不是第 6 条要求。 */
const TRANSLATE_OCR_RULE = '另：这段原文来自截图识别，可能有错字、断行或漏字。明显的识别错误可以按上下文改正；但不要改动原文的用词和风格，也不要凭空补内容。'

export const TRANSLATE_SYSTEM_PROMPT = [...TRANSLATE_RULES, TRANSLATE_OUTPUT_RULE].join('\n')
export const TRANSLATE_SYSTEM_PROMPT_OCR = [...TRANSLATE_RULES, TRANSLATE_OCR_RULE, TRANSLATE_OUTPUT_RULE].join('\n')

/** 首次解析失败后的补救 prompt：把模型上一次的输出贴回去，要求只吐 JSON。 */
export const RETRY_PROMPT = [
  '你上一次的输出不是合法 JSON。请把它整理成合法的 JSON 对象，字段为 original 与 translation。',
  '只输出 JSON，不要任何其他文字。以下是上一次的输出：',
].join('\n')

/** 原文识别那一步的补救 prompt（与 RETRY_PROMPT 的差别只在字段：这里只要 original）。 */
export const RETRY_RECOGNIZE_PROMPT = [
  '你上一次的输出不是合法 JSON。请把其中的原文整理成合法的 JSON 对象，字段为 original。',
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

/**
 * 请求失败时"去掉什么再试一次"的顺序（纯函数，单测钉住）。
 *
 * 为什么会 400：thinking 是 DeepSeek 系写法、response_format 有些网关会拒。
 * 顺序是既定的：
 *   ① 调用方要的那一发（精译要 noThinking:false = 不传 thinking 字段）；
 *   ② 本来关着思考 → 再试一次"开思考"（有些上游单纯不认 disabled 这个值）；
 *   ③ 开了 JSON 模式 → 最后去掉它再试一次。
 *
 * 2026-10-24 加精译时把这套从 chat() 里抽出来：分支一多，"精译会不会被错误地降级成
 * 关思考"这种事只看代码很难确认，单测里一行 deepEqual 就能钉住。
 *
 * @param {{jsonMode?: boolean, noThinking?: boolean, jsonModeRejected?: boolean, thinkingRejected?: boolean}} p
 *   jsonMode/noThinking      本次调用想用什么
 *   jsonModeRejected/thinkingRejected  本会话里这两样是否已被上游拒过
 * @returns {Array<{jsonMode: boolean, noThinking: boolean}>}
 */
export function planChatAttempts({
  jsonMode = true, noThinking = true, jsonModeRejected = false, thinkingRejected = false,
} = {}) {
  const wantJson = !!jsonMode && !jsonModeRejected
  const startNoThinking = !!noThinking && !thinkingRejected
  const attempts = [{ jsonMode: wantJson, noThinking: startNoThinking }]
  if (startNoThinking) attempts.push({ jsonMode: wantJson, noThinking: false })
  if (wantJson) attempts.push({ jsonMode: false, noThinking: false })
  return attempts
}

/**
 * 组一次 chat/completions 的请求体。
 *
 * 两个默认开着的开关，都是 2026-11 为「重译结果格式不正确」这个报错加的
 * （实测模型 deepseek-v4-flash，同一段 136 字原文）：
 *
 *   jsonMode     response_format=json_object。上游会把输出约束成 JSON，思考也从
 *                1068 token 降到 582。我们的每条 prompt 本来就只要 JSON，没有理由不开。
 *   noThinking   thinking={"type":"disabled"}。翻译是机械活，思考对结果没帮助，代价却极大：
 *                开思考 8.1 秒 / 输出 1099 token（其中思考占 1068），关掉 0.75 秒 / 29 token。
 *                更要命的是 max_tokens 是**两者共用**的额度 —— 思考一旦吃满（实测见过
 *                思考 token 正好 2048 = 额度上限），finish_reason 变成 length、
 *                content 是空的，答案根本没生成。
 *
 * 不认 thinking 字段的上游会让请求 400，调用方（translate-background 的 chat）
 * 会去掉这个字段重发一次，之后本会话都不再发。
 */
export function buildChatBody({
  model, content, system = '', maxTokens = 8192, temperature = 0.2, jsonMode = true, noThinking = true,
}) {
  // system 只放**文字规则**：图片必须留在 user 消息里（见 buildImageContent），
  // 所以图片翻译那条路永远不传 system。system 为空时消息形态与改动前逐字一致。
  const messages = []
  const sys = String(system ?? '').trim()
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push({ role: 'user', content })

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (noThinking) body.thinking = { type: 'disabled' }
  return body
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

/**
 * 组文本翻译的 user 消息：书名 + 用标记围起来的正文。
 *
 * 为什么带书名（2026-10-24 用户定调）：给模型一个"这是什么书"的先验（哲学 / 历史 / 小说），
 * 对术语和语气有一点帮助。**刻意不带前后文** —— 用户明确只要书名，不想把上下文也塞进去。
 *
 * 为什么正文必须有边界标记：规则已经挪进 system，user 消息里只剩"书名 + 正文"。
 * 不标边界时，书名那一行同样是一串英文，模型有可能把书名也当成待译的句子翻掉。
 */
export function buildTranslateContent({ text, bookTitle } = {}) {
  const title = String(bookTitle ?? '').trim()
  const body = String(text ?? '')
  const user = (title ? '书名：' + title + '\n\n' : '')
    + '【待译文字】\n' + body + '\n【待译文字结束】'
  return [{ type: 'text', text: user }]
}

/** 从 OpenAI 兼容的 chat completions 响应里取出正文。 */
export function extractReplyText(payload) {
  const choice = payload?.choices?.[0]
  const msg = choice?.message
  const content = msg?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('')
      .trim()
    if (joined) return joined
  }
  // 回答被额度截断时**不**退回 reasoning_content：那段是"还没想完"的过程，
  // 不是答案。把它当正文交给 JSON 解析，用户看到的就是一句误导人的
  // 「格式不正确」（2026-11 实测：思考 token 正好等于 max_tokens 时就是这个现场）。
  if (choice?.finish_reason === 'length') return ''
  // 有些推理模型确实把正文放在 reasoning_content 里，回答完整时仍按正文处理。
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim()
  }
  return ''
}

export function stripCodeFence(text) {
  const s = String(text ?? '').trim()
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  return fence ? fence[1].trim() : s
}

/**
 * 从模型回复里取出那个 JSON 对象（容忍代码块包裹与前后多余文字）。
 * 各解析器共用这一份：格式容忍度只该有一处，否则"翻译能过、识别过不了"迟早出现。
 */
function jsonObjectFromReply(raw) {
  const text = stripCodeFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw makeError('PARSE_ERROR', '模型未返回 JSON 对象')
  }
  let obj
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    throw makeError('PARSE_ERROR', '模型输出的 JSON 无法解析：' + e.message)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw makeError('PARSE_ERROR', '模型返回的 JSON 不是对象')
  }
  return obj
}

/**
 * 解析模型返回的译文 JSON。
 * 容忍代码块包裹、JSON 前后有多余文字；字段缺失时返回空串。
 * @returns {{original: string, translation: string}}
 * @throws {Error} 解析不出对象或 translation 为空时抛出，code 为 PARSE_ERROR
 */
export function parseTranslation(raw) {
  const obj = jsonObjectFromReply(raw)
  const translation = String(obj.translation ?? '').trim()
  if (!translation) throw makeError('PARSE_ERROR', '模型返回的 JSON 缺少 translation 字段')
  return { original: String(obj.original ?? '').trim(), translation }
}

/**
 * 解析「只识别原文」那一步的回复（RECOGNIZE_PROMPT 的 output）。
 *
 * 与 parseTranslation 的差别只有一个：**没有 translation 也算成功** —— 这一步本来就
 * 不翻译。空原文仍算失败：一条没有任何文字的引用没有身份，设了也没用。
 * @returns {string} 识别出的原文
 * @throws {Error} 解析不出对象或 original 为空时抛出，code 为 PARSE_ERROR
 */
export function parseRecognized(raw) {
  const obj = jsonObjectFromReply(raw)
  const original = String(obj.original ?? '').trim()
  if (!original) throw makeError('PARSE_ERROR', '模型返回的 JSON 缺少 original 字段（图里没有可识别的文字）')
  return original
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
    return { code: 'BAD_KEY', message: 'API Key 无效（HTTP ' + status + '），请检查配置中的 API Key', detail }
  }
  if (status === 404) {
    return { code: 'BAD_ENDPOINT', message: '接口或模型不存在（HTTP 404）。请检查 API 地址与模型名', detail }
  }
  if (status === 413) {
    return { code: 'TOO_LARGE', message: '截图过大，超出模型服务限制，请缩小选区', detail }
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message: '请求过于频繁或额度用尽（HTTP 429）', detail }
  }
  if (status >= 500) {
    return { code: 'UPSTREAM', message: '模型服务返回错误（HTTP ' + status + '）' + (detail ? '：' + detail : ''), detail }
  }
  return { code: 'UPSTREAM', message: '模型服务返回错误（HTTP ' + status + '）' + (detail ? '：' + detail : ''), detail }
}

/**
 * 把 fetch 抛出的异常翻译成可诊断的 code + 中文文案。
 *
 * 浏览器对「域名解析不了 / 端口没人监听 / 地址缺协议头 / 被代理挡住」**一律只给
 * TypeError: Failed to fetch**（部分平台给 DOMException: NetworkError），这一句话本身分不出是
 * 哪一种。所以文案里必须带上两样东西：**异常名**与**请求打去的实际地址**
 * （target，由调用方传入 chatCompletionsUrl 的结果）——否则用户和排查者都只能靠猜。
 *
 * @param {unknown} err fetch 抛出的异常
 * @param {string} target 实际请求的完整地址
 * @param {string} probeNote 调用方补做的连通性探测结论（见 translate-background.js 的 probeInternet）
 */
export function classifyFetchError(err, target = '', probeNote = '') {
  const name = String(err?.name ?? '')
  const msg = String(err?.message ?? err ?? '')
  const where = target ? '，请求地址 ' + target : ''
  const note = probeNote ? '。' + probeNote : ''
  if (name === 'AbortError' || /abort/i.test(msg)) {
    return { code: 'TIMEOUT', message: '模型服务 60 秒内未响应，请重试或更换模型', detail: msg }
  }
  // TypeError 是各平台通用形态；DOMException/NetworkError 是另一副面孔，两者都算连不上。
  if (name === 'TypeError' || (name === 'DOMException' && /network/i.test(msg))) {
    return {
      code: 'NETWORK',
      message: '无法连接模型服务' + where + note
        + '。请检查「自定义模型配置 → API 地址」；如果浏览器开着系统代理/VPN，'
        + '试试先关掉它，或把这个域名设为直连（浏览器走系统代理，很多「地址没错但连不上」都是代理造成的）',
      detail: name + ': ' + msg + (target ? ' | target=' + target : '') + (probeNote ? ' | probe=' + probeNote : ''),
    }
  }
  return { code: 'UNKNOWN', message: '请求失败：' + msg + where, detail: msg }
}
