/**
 * 讨论组问题归纳（AI-016 扩展，与判同一性配套）。
 *
 * 判同一性判断"新消息和当前讨论是不是同一个问题"；这里在专题化讨论**收口**时，
 * 把整场讨论正在追的那一个**具体问题**归纳成一句提问，作为该 thread 的 question。
 * 与判专题化/判同一性同一套结构：callLLM 由调用方注入，测试插假函数，接入包真调用。
 *
 * 设计口径（用户定调，2026-08-13）：
 * - 一个专题化讨论对应一个具体的 question；收口时定下来（threads.question，见
 *   topic-library-design §5.2——question 从 topic item 层移到 thread 层）。
 * - 归纳的是"具体问题"，不是母题（motif 是更抽象一层的归类依据，另一判断的职责）：
 *   只抓这场讨论追的那一个问题，不命名、不归类、不复述结论。
 *
 * 缓存：与判同一性同款——指令文本哈希（qInstHash）作版本，版本变了旧归纳失效全量重做；
 * 同版本内按讨论组栈内容哈希命中复用（重跑零调用）。
 */
import { formatStackContext, MAX_ATTEMPTS } from './topic-stack.js'
import { extractJsonObject } from './topicize.js'

// 归纳讨论问题的标准提示词：把整场讨论追的具体问题归纳成一句提问
export function buildQuestionInstruction() {
  return [
    '你是 CoRead 的「会意系统」。下面是一次专题化讨论的完整对话（用户提问 + AI 回复）。',
    '请把这次讨论正在追的**那一个具体问题**归纳成一句提问（疑问句，一句话）。',
    '要点：',
    '- 只归纳"讨论在追的那个具体问题"，不要给问题命名、不要归类到母题、不要展开解释。',
    '- 用用户追问的视角写（"为什么……""……是什么"），不要复述讨论的结论或 AI 的解答。',
    '- 抓整场讨论共同指向的问题，不要引用某一轮的具体划线或某一条提问。',
    '- 直接以提问的口吻写，不要写成"用户问……""讨论围绕……""第 N 轮……"这类对讨论的描述。',
    '输出格式（只输出下面这一个 JSON 对象，不要任何其他文字、代码块或推理过程）：',
    '{"question":"一句提问"}',
    '字段：question 为字符串，即这次讨论追的具体问题。只输出这一个 JSON 对象。',
    '注意：不要复述或解释上面的格式要求，不要照抄示例占位，直接给出判定。',
  ].join('\n')
}

// 组装归纳 prompt：指令 + 讨论内容（复用 formatStackContext 的 user/AI 对话渲染）。
// 归纳用**整场讨论**，不做判同一性那种窗口截断——具体问题由开头确立、后续推进修正，
// 截掉开头会丢失讨论锚点（长讨论尤其）。maxRounds 可显式限制，默认全量。
export function buildQuestionPrompt(stack, maxRounds) {
  const limit = Number.isFinite(maxRounds) ? maxRounds : stack.length
  return [
    buildQuestionInstruction(),
    '',
    `讨论内容（${limit} 轮）：`,
    formatStackContext(stack, limit),
  ].join('\n')
}

// 解析归纳结果：{"question":"..."}；容忍前言回显/围栏/多余字段。
// 散文回退：模型有时不包 JSON 直接写一句带问号的提问，还常套"所以讨论的是…""问题应该是…""或"这类
// 引言框架（系统性失败模式）。question 是自由文本（不是判同一性那种门控布尔），一句像样的提问即可。
export function parseQuestionResult(text) {
  const d = extractJsonObject(text)
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    let q = typeof d.question === 'string' ? d.question.trim() : ''
    // 指令措辞照抄：模型把"用用户追问的视角写"这类提示照抄成 question 开头。JSON 路径同样要剥
    q = stripInstructionEcho(q)
    // 剥末问号后的闭合引号（“……？”），保留问号；剥前缀后引号才露出来
    q = q.replace(/([？?])["'“”」』]+$/, '$1').trim()
    // 照抄示例占位（"一句提问"）、省略号占位（"..."）、过短（<4）都不算有效答案
    if (q && q !== '一句提问' && !/^\.{2,}$/.test(q) && q.length >= 4) return q
  }
  return extractProseQuestion(text)
}

// 引言框架头部（可带讨论/修饰词），用于剥"所以讨论的是…"这类引子
const PROSE_META_HEAD = '(?:所以|那么|然而|而|但|但是|于是|其实|总之|综上|综上所述|或|也就是|即|最后|整场|整个|更完整|更准确|本次|这次|本场|我们|我)?'
// 裸连词/承接词（独立成引子，如"或：""更完整："，含模型衔接上一句残片的"者""更具体"）
const PROSE_CONJ = '(?:所以|那么|然而|而|但|但是|于是|其实|总之|综上|综上所述|或|也就是|即|最后|更完整|更准确|者|更具体)'

function stripProseMetaPrefix(q) {
  const patterns = [
    // "的问题可理解为："（模型衔接上一句残片；最具体，先匹配避免"的问题"被下面的模式提前剥掉）
    new RegExp(`^的(?:问题|提问|疑问)?(?:可)?(?:以)?(?:理解为|理解|认为是)[：:：]?`),
    // "所以讨论的具体问题也许是："
    new RegExp(`^${PROSE_META_HEAD}(?:讨论|对话)?(?:的)?(?:核心|主要|具体)?(?:问题|提问|疑问)(?:也许|可能|应该|或许|大概)?(?:是|为)?`),
    // "所以讨论的是"
    new RegExp(`^${PROSE_META_HEAD}(?:讨论|对话)(?:的)?(?:是|为)`),
    // 裸连词
    new RegExp(`^${PROSE_CONJ}`),
    // "更具体："
    new RegExp(`^更?具体[：:：]`),
  ]
  // 循环剥：引言框架可能嵌套（"者更具体："= 者 + 更具体），剥到不再变化
  for (let k = 0; k < 4; k++) {
    let matched = false
    for (const p of patterns) {
      const m = q.match(p)
      if (m && m[0].length > 0) { q = q.slice(m[0].length); matched = true; break }
    }
    if (!matched) break
  }
  return q.replace(/^[：:：]?["'“”「『*]+/, '').trim()
}

// 指令措辞照抄：模型把提示里的"用用户追问的视角写"照抄成 question 开头（"用户追问视角是一句疑问，例如：…"），
// 或"用用户追问的视角写：…"这类变体。剥掉后留真正的提问。这是归纳特有的失败模式（判同一性是布尔没这问题），
// 常见于模型在 JSON 里把指令提示当答案复读——字符串里是全角引号，JSON 没被破坏，会原样走 JSON 路径。
function stripInstructionEcho(q) {
  let s = String(q || '').trim()
  // 编号列表项："6. 用户问…"（模型把讨论里的某条消息编号列举）。剥掉编号再处理后面的元描述
  s = s.replace(/^[（(]?\d+[.、．)）]\s*/, '')
  // "用户追问视角是一句疑问，例如：“为什么…”"：模型把指令提示照抄成 question 开头
  s = s.replace(/^(?:用)?用户(?:追问|的)?(?:视角|角度)(?:是|为)?(?:一句疑问|一个疑问|一个提问|的提问)?(?:，例如|例如)?[：:]?["'“”「『]*/, '')
  // "用户问…""用户追问的是：…"：模型以"用户问"口吻描述讨论而不是直接提问
  // 注意不能带 (?:是|为)?——"用户问为啥…"里会误吞"为"，把"为啥"剥成"啥"
  s = s.replace(/^用户(?:问|追问|提问)(?:的)?是?[：:]?["'“”「『]*/, '')
  return s.trim()
}

// 散文回退：剥围栏 → 取最后一个带问号的句子 → 剥引言框架/共同指向边界/引号 → 在**问题开头或冒号后**
// 的疑问词起切。宁严勿松：过渡问句（"这里的问题是什么？"）、JSON 残片、过短、剥尽虚词后无实义的直接跳过
// 交给重试。中句疑问词（如"到底"）不切，避免砍掉主语。
function extractProseQuestion(text) {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (/^\s*{/.test(clean)) return null // JSON 信封要么有效（上面已返回），要么是残片/占位，散文回退救不了
  const sentences = clean.split(/(?<=[。？!！\n])/)
  const triggers = ['为什么', '为何', '为啥', '怎么', '怎样', '如何', '是什么', '什么是', '是不是', '有没有', '到底', '究竟']
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i].trim()
    if (!/[？?]/.test(s)) continue
    let q = s.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim() // 剥成对引号
    q = stripProseMetaPrefix(q) // 剥"所以讨论的是/问题应该是/或"等引言框架
    q = stripInstructionEcho(q) // 剥指令措辞照抄（"用户追问视角是一句疑问，例如：…"）
    const bound = q.lastIndexOf('共同指向') // 剥"……，共同指向："前的整段分析
    if (bound !== -1) q = q.slice(bound + 4).replace(/^[：:：\s]+/, '').trim()
    let hit = -1, hitPre = ''
    for (const t of triggers) {
      const idx = q.indexOf(t)
      if (idx !== -1 && (hit === -1 || idx < hit)) { hit = idx; hitPre = q[idx - 1] }
    }
    if (hit !== -1 && (hit <= 3 || hitPre === '：' || hitPre === ':')) q = q.slice(hit)
    q = q.replace(/^["'“”「『]+/, '').replace(/["'“”」』]+(?=[？?]$)/, '').trim() // 剥句首引号 + 句末问号紧邻的引号
    q = q.replace(/^[\s【】（(「『“”,，：:]+/, '').trim()
    // 剥完仍带引言残留（"具体问题""的问题""者""用户"等）→ 不是干净问句，交给重试
    if (/^(?:所以|那么|然而|但|但是|或|还是|也就是|即|更完整|更准确|更具体|具体|问题|提问|疑问|可理解|可以理解|共同|至于|者|的|总之|综上|综上所述|用户)/.test(q)) continue
    if (q.length < 6) continue // "是什么？"这类过渡问句太短
    if (q.replace(/[这那是什么啥为什么为何为啥怎么怎样如何吗呢有没有到底究竟一个的？?问题提问疑问。，：:\s]+/g, '').length < 4) continue // 剥尽虚词/问题词后无实义（残留"里"这类零碎）→ 空泛
    return q
  }
  return null
}

/**
 * 归纳讨论问题 tool loop 主入口。
 *
 * @param {Array}  stack 本次专题化讨论的整栈（含 user 与 assistant 轮次，收口时定格）
 * @param {object} deps { callLLM（必填）, maxTokens?, attempts?, log? }
 * @returns {Promise<{question:string, attempts:number}>}
 */
export async function consolidateThreadQuestion(stack, deps = {}) {
  if (!Array.isArray(stack) || stack.length === 0) {
    throw new TypeError('consolidateThreadQuestion: 需要非空栈（收口的讨论栈）')
  }
  const { callLLM, maxTokens = 256, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('consolidateThreadQuestion: 必须注入 callLLM(prompt, maxTokens)')
  }

  const basePrompt = buildQuestionPrompt(stack)
  let logReason = ''
  let promptHint = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0 || !promptHint
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验（${promptHint}）。你在解释格式或写分析，而不是直接给判定。重新输出：只给一行 {"question":"..."}，任何解释、前言、示例、推理过程都算失败。`

    let text
    try {
      text = await callLLM(prompt, maxTokens)
    } catch (e) {
      if (attempt === attempts - 1) {
        throw new Error(`归纳讨论问题 LLM 调用失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      logReason = `LLM 调用失败（${e instanceof Error ? e.message : String(e)}）`
      log(`  ⚠️ 归纳讨论问题调用失败 (attempt ${attempt + 1}/${attempts})`)
      continue
    }

    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`归纳讨论问题 LLM 返回失败串：${out.slice(0, 60)}`)
      logReason = 'LLM 返回失败串'
      continue
    }

    const question = parseQuestionResult(out)
    if (question) {
      log(`  ✓ 归纳讨论问题（attempt ${attempt + 1}）`)
      return { question, attempts: attempt + 1 }
    }

    promptHint = logReason = `输出不是合法 JSON 或缺 question 字段（${out.slice(0, 60)}）`
    log(`  ⚠️ 归纳讨论问题第 ${attempt + 1} 次校验未通过（${logReason}），重试...`)
  }

  throw new Error(`归纳讨论问题 ${attempts} 次尝试后仍无有效结果（${logReason}）`)
}
