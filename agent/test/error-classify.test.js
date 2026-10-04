/**
 * 错误分类单测（lib/error-classify.js）。
 *
 * 驱动背景（2026-09-26《大国大城》实例）：`fetch failed` 这类网络层失败
 * （TypeError、无 status）此前被判定为"不可重试" → 0 次重试，原始英文串直接落进侧栏。
 * 本文件把判定表固化成测试：网络层失败必须与 429/5xx 同等可重试；参数校验类 4xx 与
 * 已产出内容后的失败绝不可重试；展示文案必须是中文且带底层 cause.code。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { causeCode, isNetworkError, canRetryError, networkErrorMessage, isFatalConfigError, fatalErrorMessage } from '../lib/error-classify.js'

// Node 内置 fetch 的真实失败形态：TypeError: fetch failed + e.cause（AggregateError 包 errno）
function fetchFailed(code) {
  const errno = Object.assign(new Error(code === 'ENOTFOUND' ? 'getaddrinfo ENOTFOUND api.deepseek.com' : `read ${code}`), { code })
  const e = new TypeError('fetch failed')
  e.cause = code === 'ECONNRESET' ? new AggregateError([errno], '') : errno
  return e
}

test('causeCode：从 cause / AggregateError.errors / 嵌套 cause 里取 errno', () => {
  assert.equal(causeCode(fetchFailed('ECONNRESET')), 'ECONNRESET', 'AggregateError 包一层也要取到')
  assert.equal(causeCode(fetchFailed('ENOTFOUND')), 'ENOTFOUND')
  assert.equal(causeCode({ cause: { cause: { code: 'ETIMEDOUT' } } }), 'ETIMEDOUT')
  assert.equal(causeCode(new Error('plain')), '')
  assert.equal(causeCode(undefined), '')
})

test('isNetworkError：fetch failed（无论带不带 cause）都算网络层失败', () => {
  assert.ok(isNetworkError(fetchFailed('ECONNRESET')))
  assert.ok(isNetworkError(new TypeError('fetch failed')), '没有 cause 也算——这正是《大国大城》那次的形态')
  assert.ok(isNetworkError(new Error('fetch failed')))
  assert.ok(isNetworkError(Object.assign(new Error('request to https://api.deepseek.com/chat/completions failed, reason: connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })))
  assert.ok(isNetworkError(new Error('other side closed')))
  assert.ok(isNetworkError(new Error('socket hang up')))
  assert.ok(isNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })), '响应头 120s 超时走 AbortError')
})

test('isNetworkError：业务/内容错误不算网络层失败', () => {
  assert.equal(isNetworkError(Object.assign(new Error('LLM API 401: Authentication Fails'), { status: 401 })), false)
  assert.equal(isNetworkError(new Error('模型无回应（空流）')), false)
  assert.equal(isNetworkError(new Error('LLM 输出被截断（finish_reason: length）')), false)
  assert.equal(isNetworkError(new Error('模型 API 未配置：请在侧栏右上角…')), false)
})

test('canRetryError：网络层失败（旧判定里 0 次重试的那类）必须可重试', () => {
  assert.ok(canRetryError(new TypeError('fetch failed')), '《大国大城》实例：这就是回归点')
  assert.ok(canRetryError(fetchFailed('ECONNRESET')))
  assert.ok(canRetryError(fetchFailed('EAI_AGAIN')))
  assert.ok(canRetryError(Object.assign(new Error('x'), { name: 'AbortError' })))
})

test('canRetryError：429/5xx/空流可重试，其余 4xx 与内容失败不可重试', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.ok(canRetryError(Object.assign(new Error(`LLM API ${status}: oops`), { status })), `${status} 应可重试`)
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(canRetryError(Object.assign(new Error(`LLM API ${status}: oops`), { status })), false, `${status} 不该重试`)
  }
  assert.ok(canRetryError(new Error('模型无回应（空流）')))
  assert.equal(canRetryError(new Error('LLM 输出被截断（finish_reason: length，16384 预算仍不够）')), false)
})

test('canRetryError：已经吐出过内容 → 一律不重试（重发会造成内容错乱）', () => {
  assert.equal(canRetryError(fetchFailed('ECONNRESET'), { yielded: true }), false)
  assert.equal(canRetryError(Object.assign(new Error('LLM API 500: oops'), { status: 500 }), { yielded: true }), false)
  assert.equal(canRetryError(new Error('模型无回应（空流）'), { yielded: true }), false)
})

test('networkErrorMessage：中文可诊断文案 + 底层 cause.code，不重复包装', () => {
  const m1 = networkErrorMessage(fetchFailed('ECONNRESET'))
  assert.match(m1, /^连不上模型 API（ECONNRESET）：/)
  assert.match(m1, /已重试 3 次仍失败，稍后重发即可/)
  assert.match(networkErrorMessage(new TypeError('fetch failed')), /^连不上模型 API：/, '取不到 code 时不带空括号')
  const m2 = networkErrorMessage(new Error('fetch failed'))
  assert.equal(networkErrorMessage(new Error(m2)), m2, '重试循环里第二次包装应原样返回')
})

test('端到端形态：真实 fetch 打到没人监听的端口 → 旧判定漏掉、新判定接住', async () => {
  let e
  try {
    await fetch('http://127.0.0.1:9/chat/completions', { method: 'POST', body: '{}' })
  } catch (err) { e = err }
  assert.ok(e, '应当抛错')
  assert.ok(isNetworkError(e), `实测错误应判为网络层失败：${e.message} cause=${e.cause && (e.cause.code || e.cause.message)}`)
  assert.ok(canRetryError(e), '实测错误应可重试（旧判定下这里是 false → 0 次重试）')
  assert.match(networkErrorMessage(e), /^连不上模型 API/)
})

// ── 配置/额度类致命错误（2026-09-28：余额耗尽后队列里 213 条各刷一个 ⚠️ 气泡） ──
test('isFatalConfigError：401/402/403 与余额/鉴权文案 → 致命（调用方应中止本轮队列）', () => {
  assert.ok(isFatalConfigError(Object.assign(new Error('LLM API 402: Insufficient Balance (request_id: 6a1f651d)'), { status: 402 })),
    '《大国大城》实例：就是这一条')
  assert.ok(isFatalConfigError(Object.assign(new Error('LLM API 401: Authentication Fails'), { status: 401 })))
  assert.ok(isFatalConfigError(Object.assign(new Error('LLM API 403: forbidden'), { status: 403 })))
  assert.ok(isFatalConfigError(new Error('Insufficient Balance')), '状态码缺失时按文案兜底')
  assert.ok(isFatalConfigError(new Error('{"error":{"message":"账户余额不足"}}')))
  assert.ok(isFatalConfigError(new Error('invalid api key')))
})

test('isFatalConfigError：网络/服务端瞬时故障与内容失败都不算致命（应照旧重试或跳过）', () => {
  assert.equal(isFatalConfigError(fetchFailed('ECONNRESET')), false)
  assert.equal(isFatalConfigError(Object.assign(new Error('LLM API 500: oops'), { status: 500 })), false)
  assert.equal(isFatalConfigError(Object.assign(new Error('LLM API 429: rate limit'), { status: 429 })), false)
  assert.equal(isFatalConfigError(new Error('模型无回应（空流）')), false)
  assert.equal(isFatalConfigError(new Error('LLM 输出被截断（finish_reason: length）')), false)
})

test('fatalErrorMessage：中文可执行文案，说清"已暂停 + 怎么恢复 + 消息不会丢"', () => {
  const m402 = fatalErrorMessage(Object.assign(new Error('LLM API 402: Insufficient Balance'), { status: 402 }))
  assert.match(m402, /余额不足/)
  assert.match(m402, /已暂停本轮消息队列/)
  assert.match(m402, /充值/)
  assert.match(m402, /不会丢/)

  const m401 = fatalErrorMessage(Object.assign(new Error('LLM API 401: Authentication Fails'), { status: 401 }))
  assert.match(m401, /鉴权失败/)
  assert.match(m401, /模型 API 配置/)

  assert.match(fatalErrorMessage(new Error('莫名其妙的致命错误')), /^⚠️ 模型 API 配置\/额度类致命错误/)
})
