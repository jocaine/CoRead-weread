#!/usr/bin/env node
/**
 * 会意系统 · 动作① 判专题化（AI-016）
 *
 * 判断用户的一条提问是否值得进入话题库：它有没有「可推进的问题内核」。
 * 对应 topic-library-design.md §5.3 Q2。
 *
 * 判定材料只有提问本身（第一判纯净）。提问透露出用户真正追的问题；只有划线、没有提问，
 * 说明用户还没透出自己的观点（可能只是标记重点、问历史背景或没读懂），不判。
 * 2026-08-11 降级判定：第一判判为"非专题化"时，若存在上一轮 AI 回复（input.assistantContext），
 * 自动降级把该回复作为辅助材料补考一次——提问自身看不出内核、但可能承接 AI 回复起势
 * （例："人生有什么意义"被忽略后，AI 回复抛出可辩观点，用户顺着追问）。边界见
 * buildTopicizePrompt 降级段（承接才参与 / 纯反应不启用 / AI 回复深刻不是判据）。
 * 降级判专题化 → 返回 usedAssist:true，调用方入栈时补该 AI 回复作背景轮次。
 *
 * 判据（Q2）：有内核 = 分析性、关于机制/结构/关系，能继续追问、可跨书应用；
 * 无内核 = 一次性能答完的事实澄清、或闲聊 → 不进话题库。判据是内容，与交锋/回响等表象无关。
 *
 * 输出协议：LLM 回复只输出一行 JSON，两个值之一：
 *   {"topicized":true}
 * 不设 marker——2026-08-10 真实 API 冒烟实测（temperature 0，8 用例）：
 * 规定"只输出这一个 JSON 对象"后模型 8/8 严格命中、零思考草稿，marker 协议是多余复杂度。
 * 本动作只输出判专题化结果；之后的收口固化（分段 / 问题归纳 / 派生 point·能指 / 建边）
 * 由固化流程承担，与本动作无关。
 *
 * 实现要点：
 * - callLLM(prompt, maxTokens) 由调用方注入——模块不自己调模型。测试时插一个返回
 *   预设文本的函数即可，不碰网络、结果确定；接入 index.js 时包一层真调用传进来。
 * - 解析只做两件事：去代码块围栏（模型偶发 ```json 包裹）+ JSON.parse 全文。
 *   思考草稿 JSON.parse 必失败 → 重试，不需要专门的垃圾检测。
 * - 建议接入时固定低温度（temperature 0，判定任务要确定性）——冒烟实测的前提之一。
 * - 本模块不读写任何用户文件：它是纯判定。文件读写（profile/soul/journal）是 index.js
 *   的职责，那边已有 .bak 备份约定。
 */

export const MAX_ATTEMPTS = 3

// 判据标准提示词（topic-library-design.md §5.3 Q2 + topic-library-ops.md）
export function buildTopicizeInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在执行动作①「判专题化」：判断下面这条讨论单元是否值得进入话题库——它有没有「可推进的问题内核」。',
    '',
    '判定标准（基于真实内容归纳，不凭空发挥、不拔高成空话）：',
    '',
    '- 有内核（专题化）：用户追问的问题是分析性的，关于机制、结构、关系或规律（例："一种秩序靠什么维持得下去"）；能继续追问；可跨书应用。',
    '  · 反问、反讽、带情绪的表述不影响判定——里面藏着可反驳、可深挖的立场或机制就算有内核（例："呵，秩序？不过是强者的遮羞布罢了"）。语气不是判据，看的是内容。',
    '  · 多问并存时，只要含一个可推进的机制追问，整体就有内核（例："这个人是谁？以及他为什么能控制整个村子？"——第一问是认人，第二问是机制，整体专题化）。',
    '- 无内核（不专题化）：',
    '  · 一次性能答完的事实澄清（例："这人物原型是谁""这词什么意思"）。',
    '  · 闲聊、寒暄，与阅读追问无关。',
    '  · 主观评价类（例："你觉得这本书的结尾写得好吗"）——审美/喜好判断一次就能给出，没有可推进的机制内核。',
    '  · 与具体阅读内容脱钩的空泛抽象问题（例："人生到底有什么意义"）——没有可落地的内核。',
    '  · 指代不明、信息不足（例："那这个怎么维持？"）——没有真实内容可依，无法确认内核，保守不专题化。',
    '',
    '关于划线内容：如果提供了划线，它只用来解析提问里的指代（例：提问"那这个怎么维持？"中的"这个"指划线里的什么）。判定的材料仍是提问本身——提问无需划线就能判定时（事实澄清、闲聊、主观评价等），忽略划线，不要因为划线内容本身深刻而判专题化。',
    '',
    '注意：判定的是"这个问题能否被持续推进"，不是"这次聊了多少知识点"，也与交锋长度、讨论热烈程度、回响次数等表象信号无关——问题本身是否一次性能答完，不因讨论多热烈而改变。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"topicized":true}',
    '字段：topicized 布尔；true=有可推进内核（专题化），false=不专题化。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

// 组装判定材料：主体是用户提问（判定对象是"问题本身的性质"——Q2 判据，
// 提问透出观点才有判的价值；2026-08-10 定调：划线不提问 = 还没透出观点，不判）。
// 2026-08-11 修正：有划线时附带划线，仅用于解析提问里的指代（"这个/它/那套"指什么），
// 不参与判据——没有划线的指代短问才保守不进话题库（用户定调，见 buildTopicizeInstruction
// "关于划线内容"段）。交锋/上下文（exchange/context）仍不进。
export function buildTopicizePrompt(input) {
  const userNote = String(input.userNote || '').trim()
  const lines = [buildTopicizeInstruction(), '', `用户提问："${userNote}"`]
  const sel = String(input.selected?.text || '').trim()
  if (sel) lines.push('', `划线内容（仅用于解析提问中的指代）："${sel}"`)
  const assist = String(input.assistantContext?.content || '').trim()
  if (input._downgrade && assist) {
    lines.push(
      '',
      '上一轮 AI 回复（辅助材料）：',
      `"${assist}"`,
      '',
      '降级判定说明：这条消息在第一判（只看提问本身）中未呈现专题化迹象，现将其与上一轮 AI 回复合起来评估：',
      '- 仅当这条消息在语义上承接上一轮 AI 回复（针对它追问、反驳、展开、质疑）时，上一轮 AI 回复才作为判定材料参与：评估「提问 + 上一轮 AI 回复」合起来是否有可推进内核 → 有则专题化，无则不专题化。',
      '- 不承接（全新话题、与上一轮 AI 回复无关）→ 维持不专题化。',
      '- 纯反应（"嗯嗯""确实""明白了"）不构成承接 → 维持不专题化。',
      '- 上一轮 AI 回复自身深刻不是判据——必须这条消息承接了它才参与判定。',
    )
  }
  return lines.join('\n')
}

// 从 LLM 回复里提取判定：优先 JSON.parse 全文；全文非法时（模型偶发带前言回显，
// 如"我们只需要输出JSON。{...}"）从第一个 { 截取到配平 } 再解析。多余字段容忍忽略；
// 思考草稿天然解析失败 → null，调用方重试。围栏（```json）宽容处理。
// topicized/same 布尔字段校验由各自的 parse 函数做，这里只负责取到原始 JSON 对象。
export function parseJudgeResult(text) {
  const d = extractJsonObject(text)
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.topicized === 'boolean') {
    return { topicized: d.topicized }
  }
  return null
}

// 通用提取：从 LLM 回复里拿到第一个合法 JSON 对象（去围栏 + 全文 parse + 配平截取 fallback）。
// 判同一性（{"same":bool}）复用同一套容忍逻辑。
export function extractJsonObject(text) {
  let t = String(text || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let d = rawParse(t)
  if (d) return d
  const open = t.indexOf('{')
  if (open !== -1) {
    const end = findBalancedEnd(t, open)
    if (end !== -1) {
      d = rawParse(t.slice(open, end + 1))
      if (d) return d
    }
  }
  return null
}

// 原始 JSON.parse，不校验字段（字段校验交给各 parse 函数）
function rawParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

// 括号配平扫描：找与第一个 { 配对的 }（跳过 JSON 字符串值内的括号与转义）
function findBalancedEnd(s, open) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function errMsg(e) {
  if (e instanceof Error) return e.message || String(e)
  if (typeof e === 'string') return e
  try { return String(e || '未知错误') } catch { return '未知错误' }
}

/**
 * 判专题化 tool loop 主入口（AI-016）。
 *
 * 两级判定（2026-08-11 用户定调）：
 *   第一判——判定材料 = 提问本身（+划线仅解析指代），纯净，不受任何外部上下文影响。
 *   降级判——第一判为"非专题化"且存在上一轮 AI 回复（input.assistantContext）时自动补考一次：
 *     把上一轮 AI 回复作为辅助材料，评估「提问 + AI 回复」合起来（仅当消息承接 AI 回复）是否有
 *     可推进内核。边界见 buildTopicizePrompt 降级段。降级判专题化 → usedAssist=true，调用方
 *     入栈时补该 AI 回复作背景轮次（它是这场讨论的真正起点）。
 *
 * @param {object} input 讨论单元：
 *   - {string} userNote 用户提问（必填）——判定材料只有它；划线不提问说明用户还没透出观点，不判
 *   - {object} [selected] 划线结构体 { text, book?, chapter? }——text 仅用于解析提问中的指代；
 *     book/chapter 不参与判定，随讨论归档
 *   - {object} [assistantContext] 上一轮 AI 回复 { content（文本，必填）, selected?（它针对的划线，结构体同上） }，
 *     降级判定的辅助材料——仅 content 参与判定，selected 不参与（划线哲学：划线内容不参与判据）
 *   - 其余字段（exchange/context）本模块不参与判定，调用方可忽略
 * @param {object} deps
 *   - {function} callLLM 必填，签名 (prompt, maxTokens) => Promise<string>，
 *     由调用方注入（index.js 集成时包一层 callLLM(maxTokens, [{role:'user',content:prompt}])）。
 *   - {number}   [maxTokens=2048]
 *   - {number}   [attempts=MAX_ATTEMPTS] 每次判定最多尝试次数（含重试）；两级判定各自独立尝试
 *   - {function} [log] 可选诊断日志 (msg) => void
 * @returns {Promise<{topicized:boolean, usedAssist:boolean, attempts:number}>}
 *   - usedAssist：本次判专题化是否走了降级且靠上一轮 AI 回复承接补判为专（供调用方补背景入栈）
 *   - attempts：两级判定实际发起的 LLM 调用总数
 * @throws 内容缺省 / 未注入 callLLM → TypeError；LLM 调用失败 → Error；重试耗尽仍无有效判定 → Error
 */
export async function judgeTopicization(input, deps = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('judgeTopicization: input 必须是讨论单元对象')
  }
  const { userNote } = input
  if (!String(userNote || '').trim()) {
    // 判定材料只有提问：没有提问就没有观点可判（划线不提问 = 标记/背景求助，不判专题化）
    throw new TypeError('judgeTopicization: 需要用户提问（userNote 非空）——判定材料只有提问本身')
  }
  const { callLLM } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('judgeTopicization: 必须注入 callLLM(prompt, maxTokens)')
  }

  // 第一判：纯净材料（buildTopicizePrompt 只含提问 + 划线，不含降级段）
  const r1 = await runJudge(buildTopicizePrompt(input), deps, '判专题化')
  const assist = String(input.assistantContext?.content || '').trim()
  if (r1.topicized || !assist) {
    return { topicized: r1.topicized, usedAssist: false, attempts: r1.used }
  }

  // 降级重判：第一判"非专题化"但存在上一轮 AI 回复——提问自身看不出内核，可能只是
  // 信息不足（指代承接 AI 回复）。把上一轮 AI 回复作为辅助材料补考一次，边界见
  // buildTopicizePrompt 降级段（承接才参与 / 纯反应不启用 / AI 回复深刻不是判据）。
  deps.log && deps.log('  ↓ 第一判非专题化，存在上一轮 AI 回复 → 降级重判（提问 + AI 回复联合评估）')
  const r2 = await runJudge(buildTopicizePrompt({ ...input, _downgrade: true }), deps, '判专题化（降级）')
  return {
    topicized: r2.topicized,
    usedAssist: r2.topicized,  // 降级救回：原本非专的提问靠 AI 回复承接补判为专
    attempts: r1.used + r2.used,
  }
}

// 单次判定 tool loop：最多 attempts 次。每次失败（调用出错 / 上游失败串 / 输出不可解析 /
// 输出是思考草稿）都记下原因重试；最后一次仍失败则抛错。
// 修正提示只喂给模型可修的错误：输出非法（思考草稿/前言回显/缺字段）时把原因拼进重试 prompt；
// 网络失败/⚠️ 失败串时模型没收到过上一个 prompt（或 ⚠️ 串非模型产出），原样重发 basePrompt。
async function runJudge(basePrompt, deps, label) {
  const { callLLM, maxTokens = 2048, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  let logReason = ''    // 最近一次失败原因：进日志、也是最终报错的内容
  let promptHint = ''   // 拼进重试 prompt 的修正提示：只在"输出非法"时写。
                        // 网络失败/⚠️ 失败串时模型没收到过上一个 prompt（或 ⚠️ 串非模型产出），
                        // 带原因重发是噪音（模型无可修正），原样重发 basePrompt。
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0 || !promptHint
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验（${promptHint}）。请重新输出：只给最终一行判定，不要任何推理、字数计算、示例或额外文字。`

    let text
    try {
      text = await callLLM(prompt, maxTokens)
    } catch (e) {
      // 调用失败：最后一次尝试直接抛出（errMsg 兼容非 Error 的拒绝值），之前则记原因重试。
      // 网络失败不带修正提示——模型没收到上一个 prompt，原样重发即可。
      if (attempt === attempts - 1) {
        throw new Error(`${label} LLM 调用失败：${errMsg(e)}`, { cause: e })
      }
      logReason = `LLM 调用失败（${errMsg(e)}）`
      log(`  ⚠️ ${label}调用失败 (attempt ${attempt + 1}/${attempts}): ${errMsg(e)}`)
      continue
    }

    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {  // ⚠️ 前缀 = 上游显式返回的失败串（如 "⚠️ 上游 500"），不是正常判定
      if (attempt === attempts - 1) throw new Error(`${label} LLM 返回失败串：${out.slice(0, 60)}`)
      logReason = 'LLM 返回失败串'
      continue
    }

    const parsed = parseJudgeResult(out)
    if (parsed) {
      log(`  ✓ ${label}（attempt ${attempt + 1}）：${parsed.topicized ? '专题化' : '不专题化'}`)
      return { topicized: parsed.topicized, used: attempt + 1 }
    }

    promptHint = logReason = `输出不是合法 JSON 或缺少 topicized 字段（${out.slice(0, 60)}）`
    log(`  ⚠️ ${label}第 ${attempt + 1} 次校验未通过（${logReason}），重试...`)
  }

  throw new Error(`${label} ${attempts} 次尝试后仍无有效判定（${logReason}）`)
}
