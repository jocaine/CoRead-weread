/**
 * 真实 LLM API 判定调用（2026-08-28 机制级修复：截断检测，宁漏勿误）。
 *
 * 背景（d_14 教训）：deepseek-v4-flash 的 reasoning_content 占用大量 token，
 * maxTokens 给小了会被思考草稿耗尽、输出在 finish_reason: length 截断；截断产物
 * 可能只是半截 JSON 或思考文本，从中"碰巧"抠出合法 JSON 纯属运气。此前
 * `content || reasoning_content` 的回退在截断时会把**思考文本当输出**，解析层
 * 再宽松校验，就产出过 point="..." 这种垃圾节点。
 *
 * 机制（用户定调，2026-08-28）：
 *   1. 检测 finish_reason === 'length' → 视为失败，**截断时绝不用 reasoning_content
 *      顶替**（那只是未完成的思考草稿）；
 *   2. 预算不足时自动升级到 MAX_JUDGE_TOKENS（16384）重发同 prompt 一次（模型没
 *      收到过修正，重发原样 prompt，不拼修正提示）；
 *   3. 升级后仍截断 → 返回 { ok:false, truncated:true }，调用方转成 ⚠️ 失败串，
 *      judge 层重试，耗尽抛错 → 上层宁漏勿误（不建节点）。
 *   4. 非截断且 content 为空时保留 reasoning_content 回退（少数推理模型把回复放
 *      那里，兼容现状）。
 *
 * 纯网络调用，不读写文件。所有真实 API 判定调用（index.js callLLMOnce /
 * group-discussions.mjs / derive-knowledge-graph.mjs）共用此实现，避免截断处理漂移。
 */
export const MAX_JUDGE_TOKENS = 16384  // 判定调用的预算上限（推理模型思考 + 输出）

/**
 * 一次非流式判定调用：fetch + 解析 + 截断升级重试。
 * @param {object} opts { apiBase, apiKey, model, system, prompt, maxTokens?, temperature? }
 * @returns {Promise<{ok: boolean, truncated: boolean, text: string}>}
 *   ok:false 且 truncated:true → 升级预算后仍截断（调用方转 ⚠️ 失败串）
 * @throws 网络/HTTP/解析错误向上抛（调用方按网络失败处理）
 */
export async function completionOnce({
  apiBase,
  apiKey,
  model,
  system,
  prompt,
  maxTokens = 2048,
  temperature = 0,
}) {
  let budget = maxTokens
  for (let round = 1; round <= 2; round++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    let resp
    try {
      resp = await fetch(`${String(apiBase).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          max_tokens: budget,
          temperature,
          tool_choice: 'none',
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const raw = await resp.text()
    if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
    let data
    try { data = JSON.parse(raw) } catch { data = null }
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const msg = data?.choices?.[0]?.message
    const finish = data?.choices?.[0]?.finish_reason

    if (finish === 'length') {
      // 输出被截断：预算不够 → 升级到上限重发同 prompt 一次；仍截断 → 判定失败
      if (budget < MAX_JUDGE_TOKENS) {
        budget = MAX_JUDGE_TOKENS
        continue
      }
      return { ok: false, truncated: true, text: '' }
    }

    // 非截断：content 优先；为空则回退 reasoning_content（少数推理模型把回复放那里）
    const text = String(msg?.content || msg?.reasoning_content || '').trim()
    if (!text) throw new Error('模型无回应：' + JSON.stringify(data || {}).slice(0, 200))
    return { ok: true, truncated: false, text }
  }
  // 理论上不可达（round 上限 2），兜底按失败处理
  return { ok: false, truncated: true, text: '' }
}
