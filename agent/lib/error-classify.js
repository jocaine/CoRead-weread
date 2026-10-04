/**
 * LLM 调用的错误分类（2026-10 机制级修复：网络层失败此前**一次都不重试**）。
 *
 * 背景（2026-09-26《大国大城》实例）：`fetch failed` 是 Node 内置 fetch（undici）对
 * 「一个 HTTP 响应都没拿到」这一类失败的统一文案（DNS 解析失败 / 连接被拒 / TLS 握手
 * 失败 / socket 被重置）。这类错误是 TypeError、`status` 为 undefined，而重试判定只认
 * `AbortError || [429,500,502,503,504].includes(e.status)` → 判定为"不可重试"，3 次
 * 重试机制形同虚设，原始英文串直接落进侧栏气泡：`⚠️ fetch failed`。
 * 更常见的"网络抖一下"，反而比 HTTP 500 更不宽容——这个不等号不是有意设计。
 *
 * 机制：
 *   1. isNetworkError / canRetryError 把网络层失败与超时、429、5xx 一视同仁（同样 3 次
 *      重试 + 退避）；参数校验类 4xx 与内容失败（截断/非法输出）仍不重试，避免空转。
 *   2. networkErrorMessage 把裸错误翻译成中文可诊断文案，并带底层 cause.code
 *      （ECONNRESET / ENOTFOUND / …），下次再出问题一眼能看出是对端重置还是 DNS 挂了。
 *
 * 纯函数，不读写文件、不发网络请求。流式与非流式两条调用链共用本模块，避免判定漂移。
 */

/**
 * 取根因错误码：undici 把底层 errno 挂在 e.cause 上（如 AggregateError→cause.code）。
 * @returns {string} 形如 'ECONNRESET'，取不到返回 ''
 */
export function causeCode(e) {
  let c = e?.cause
  for (let i = 0; i < 4 && c; i++) {
    if (c.code) return String(c.code)
    if (Array.isArray(c.errors) && c.errors.length) { c = c.errors[0]; continue }
    c = c.cause
  }
  return ''
}

/** 判定字符串里有没有网络类关键字（errno / undici 码 / undici 统一文案）。 */
function hasNetworkKeyword(s) {
  if (!s) return false
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPROTO|UND_ERR|fetch failed|socket hang up/i.test(s)
}

/**
 * 「连 HTTP 响应都没拿到」的网络层失败：DNS / 连接被拒 / 连接中断 / TLS / 响应头超时。
 * 这类失败请求可能已经到达服务端（服务端照常计费），但客户端一个字节都没收到——
 * 重发是安全的（不像"流中途断了"，那种绝不能重发，见调用方的 yielded 判断）。
 */
export function isNetworkError(e) {
  const name = String(e?.name || '')
  const msg = String(e?.message || '')
  // AbortError：可能是响应头阶段的 120s 客户端超时，也可能是流停滞保护（真相在调用方）
  if (name === 'AbortError' || /aborted/i.test(msg)) return true
  if (/^(TypeError:\s*)?fetch failed$/i.test(msg.trim())) return true
  if (/terminated|other side closed|socket hang up/i.test(msg)) return true
  return hasNetworkKeyword(msg) || hasNetworkKeyword(causeCode(e)) || hasNetworkKeyword(String(e?.cause?.message || ''))
}

/**
 * 该不该重试这一次调用。
 * @param {*} e 抛出的错误
 * @param {boolean} yielded 是否已经吐出过内容（true → 绝不重试，重发会造成内容错乱）
 */
export function canRetryError(e, { yielded = false } = {}) {
  if (yielded) return false
  if (isNetworkError(e)) return true
  if ([429, 500, 502, 503, 504].includes(e?.status)) return true
  return /空流|模型无回应/.test(String(e?.message || ''))
}

/**
 * 侧栏展示用文案：把「⚠️ fetch failed」换成中文可诊断错误串，并附底层 cause.code。
 * 已是本模块产物（带「连不上模型 API」前缀）的错误原样返回，避免重试循环里重复包装。
 */
export function networkErrorMessage(e) {
  const code = causeCode(e)
  const plain = String(e?.message || e || '网络错误')
  if (plain.startsWith('连不上模型 API')) return plain
  const suffix = code ? `（${code}）` : ''
  return `连不上模型 API${suffix}：这次连一个响应都没拿到（网络中断 / DNS 或 TLS 失败 / 响应头超时），已重试 3 次仍失败，稍后重发即可`
}

/**
 * 「配置/额度类致命错误」：重试无用、逐条重发只会把同一句话刷满整个书的历史。
 * 2026-09-28《大国大城》实例：余额耗尽（402 Insufficient Balance）后，一条重放队列
 * 里的 213 条提问各写了一个 `⚠️` 气泡——调用方识别出这类错误后应当**中止本轮队列**并暂停，
 * 而不是继续逐条试。
 * 判定口径：401/402/403 三个状态码，或响应体里的余额/鉴权关键字（服务商文案并不统一）。
 */
export function isFatalConfigError(e) {
  const status = Number(e?.status)
  if (status === 401 || status === 402 || status === 403) return true
  const msg = String(e?.message || '')
  return /Insufficient Balance|Authentication Fails|invalid[_ -]?api[_ -]?key|Unauthorized|余额不足|账户余额|额度不足|欠费/i.test(msg)
}

/**
 * 致命错误的中文可执行文案（写进侧栏的 system 气泡）。
 * 说明"发生了什么 + 队列已暂停 + 怎么恢复"，避免用户只看到一串英文错误码。
 */
export function fatalErrorMessage(e) {
  const status = Number(e?.status)
  const msg = String(e?.message || '')
  if (status === 402 || /Insufficient Balance|余额不足|账户余额|额度不足|欠费/i.test(msg)) {
    return '⚠️ 模型 API 余额不足（402 Insufficient Balance）——已暂停本轮消息队列，不再逐条重试。' +
      '去服务商控制台充值后最多 10 分钟自动继续（重启 agent 可立即恢复；没回复的那条会重新回答，不会丢）。'
  }
  if (status === 401 || status === 403 || /Authentication Fails|invalid[_ -]?api[_ -]?key|Unauthorized/i.test(msg)) {
    return '⚠️ 模型 API 鉴权失败（401/403）——已暂停本轮消息队列。请在侧栏「⋯ → 模型 API 配置」里检查 API Key / 地址 / 模型名，' +
      '改完最多 10 分钟自动继续（重启 agent 可立即恢复）。'
  }
  return `⚠️ 模型 API 配置/额度类致命错误，已暂停本轮消息队列：${msg || '未知原因'}`
}
