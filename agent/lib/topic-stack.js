#!/usr/bin/env node
/**
 * 会意系统 · 判同一性 + 专题化讨论栈（AI-016 / Q2.5）
 *
 * 判专题化的单元不是单次提问，而是一段连续追同一问题的沟通（"一次专题化讨论"）。
 * 范围由栈管理：栈 = 进行中的专题化讨论，跨会话持久化（重启/换会话不弹空，用户可能下次接着聊）。
 * 对应 topic-library-design.md §5.3 Q2.5。
 *
 * 栈状态机：
 *   空栈 + 消息 → 判专题化（Q2 判据）
 *     ├─ 有内核 → 入栈（消息 + 划线 + AI 回复全带上）
 *     └─ 无内核 → 忽略，栈保持空
 *   非空栈 + 消息 → 判同一性（与栈内累积内容比）
 *     ├─ 同一问题 → 入栈累积
 *     └─ 不同问题 → 判专题化
 *           ├─ 无内核 → 忽略（不入栈，不切断）
 *           └─ 有内核 → 收口：全部弹栈归档为一次专题化讨论 → 新消息开新栈
 *
 * 关键设计（用户定调，2026-08-11）：
 * - 同一性 = 二元等价判断：只判"新消息和当前讨论是不是同一个问题"，不命名、不归类。
 *   识别接续不靠显式指代——无"那/这/它"的新观点/反驳/理解延伸，只要承接上一轮就是同一问题。
 * - 没有独立的"讨论结束"判断：出现新的专题化讨论才收口；没开新专题就一直留在栈里。
 * - 入栈 ≠ 转正：入栈只是延续性初判；是否构成知识点由收口固化时的逐段判专题化复核。
 * - 本模块不做任何跨讨论归属：节点间连接只来自用户引用（引用解析命中建边）与同栈段间衍生。
 *
 * 实现要点：
 * - callLLM(prompt, maxTokens) 由调用方注入，与 judgeTopicization 同模式（测试插假函数，接入包真调用）。
 * - 栈条目：{ role: 'user'|'assistant', content, selected?: { text, book?, chapter? } }。
 *   划线结构体：user 轮次带自己的划线，assistant 轮次带它针对的划线（可缺省）。
 *   AI 回复由调用方后续追加进栈（本模块只读栈内容做同一性判断的上下文）。
 * - 本模块不读写任何用户文件，纯判断。
 */

import {
  judgeTopicization,
  buildTopicizeInstruction,
  extractJsonObject,
} from './topicize.js'

export const MAX_ATTEMPTS = 3
export const STACK_CONTEXT_ROUNDS = 8  // 窗口上限（2026-10 起只用于收口分段等一次性场景；判同一性已改全栈追加）

// ── 判同一性（Q2.5 核心新判断）───────────────────────────────────────────────

// 判同一性标准提示词：二元等价判断，不命名不归类
// 核心口径：是不是还在推进当前讨论追的那一个"具体问题"（2026-08-13 收紧）——
//   · 知识点式提问（针对讨论中刚出现的概念/出处/细节追问）算承接，即使它单独判专题化会不通过；
//   · 换了具体问题即使还在同一话题/母题下也算换问题（例：从"列宁为什么分化哥萨克失败"转到"哥萨克是不是民族"）。
export function buildSameProblemInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在判断：下面这条新消息，是不是在延续当前讨论正在追的同一个问题。',
    '',
    '当前讨论是「用户提问 + AI 回复」的对话记录（AI：… 是 AI 对上一问的解答）。新消息通常在回应 AI 的最新回复或顺着讨论的进展继续——AI 回复和讨论的问题一起构成判断材料，不要只盯着最后一句提问。',
    '',
    '判断标准（核心：新消息是不是还在推进当前讨论追的那一个具体问题）：',
    '- 是同一问题：新消息承接当前讨论正在追的具体问题——追问、反驳、补充、换个角度看、拿新例子检验都算承接。换角度/换对象/换书聊同一个问题不切断，但前提是还追着同一个问题。',
    '  · 不要求显式指代。用户对上一轮答复给出新观点、反驳或理解延伸（例：AI 说"制度是外部条件的函数"，用户回"不对，我觉得制度自身的惯性才是关键"），即使没有"那/这/它"等指代词，也是同一问题。',
    '  · 讨论中遇到不懂的知识点而提问，仍是同一问题：针对当前讨论刚提到/出现的概念、人物、出处、细节追问（例：讨论说到"社会结构高度自治"，用户问"这个自治具体指什么"；或问"列宁在哪篇文章里写过"），是为了理解当前问题，属于承接——这类知识性提问单独拿出来不会开启新讨论，但在讨论内是推进，要入栈。',
    '- 不是同一问题：用户追的具体问题换了。换问题不要求话题完全无关——哪怕还在同一个话题/母题下，只要不再追当前那一个具体问题，就是换问题。例：当前讨论在追"列宁为什么分化哥萨克失败"，用户转去问"哥萨克是不是一个民族、为什么这么特立独行"；或从"身份再生产怎么分析"转到"库金诺夫这个人的政治姿态到底是什么"——都是换了问题，不是承接。',
    '  · 对 AI 回复风格的吐槽 / 命令 / 要求（例："你好好反思一下吧"、"别用这种三段式"、"你把它记住"），不是在对问题本身推进 → 换问题。',
    '  · 引用书中新段落、问它表面在讲什么（例："这一段以及后面什么意思"、"这是啥情况没看懂"），属于独立的阅读理解提问，不算承接当前讨论（即使段落主题相关）→ 换问题。',
    '',
    '只判断"新消息和当前讨论是不是同一个问题"。不要给问题命名、不要归类到话题、不要判断它有没有可推进内核——那是别的判断的职责。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"same":true}',
    '字段：same 布尔；true=同一问题，false=换了问题。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

// 栈内累积内容 → 对话渲染。maxRounds<=0 = 全栈（2026-10 判同一性默认：全栈追加——
// 滑动窗口每轮滑 1 条，前缀位置全错位，判定输入几乎每次全部重新算（缓存 ~10%）；
// 全栈 = 上一轮判定输入 + 本轮新消息，前缀连续命中（缓存 90%+ 的前提是 prompt 头
// 字节稳定：头部不许带轮数等每轮变化的计数——2026-10 实测，'当前讨论（N 轮）'
// 让 N 每轮 +2，前缀在指令后就分叉，44 条真实栈 ~25K token 每轮 0% 命中全价重算；
// 去计数后同形状 99.6% 命中），栈在收口时弹栈清空不会无限增长）；
// maxRounds>0 = 取最近 N 轮（收口分段/归纳问题等一次性场景，内容每次全新、
// 无缓存复用，窗口化控制量即可）。
export function formatStackContext(stack, maxRounds = 0) {
  const recent = maxRounds > 0 && Array.isArray(stack)
    ? stack.slice(-maxRounds)
    : (Array.isArray(stack) ? stack : [])
  return recent
    .map((e) => {
      const who = e.role === 'assistant' ? 'AI' : '用户'
      const sel = e.selected && String(e.selected.text || '').trim() ? `（划线：${e.selected.text}）` : ''
      return `${who}：${e.content}${sel}`
    })
    .join('\n')
}

// 组装判同一性 prompt：指令 + 当前讨论（栈内累积，全栈追加——缓存前缀连续，
// 每轮 = 上轮判定输入 + 本轮新消息）+ 新消息（2026-10）
// 2026-10 缓存修复（实测 0% → 99.6%）：头部不许带 `当前讨论（N 轮）` 这类随轮次
// 变化的计数字节——N 每轮 +2，前缀在指令后第一处就分叉，全栈追加的缓存收益全丢
// （真实栈 44 条约 25K token 每轮全价重算）。模型不需要知道轮数，口径在指令里。
export function buildSameProblemPrompt(message, stack) {
  const userNote = String(message.userNote || '').trim()
  const lines = [
    buildSameProblemInstruction(),
    '',
    '当前讨论：',
    formatStackContext(stack),
    '',
    `新消息："${userNote}"`,
  ]
  return lines.join('\n')
}

// 解析判同一性回复：{"same":bool}；容忍前言回显/围栏/多余字段
export function parseSameResult(text) {
  const d = extractJsonObject(text)
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.same === 'boolean') {
    return { same: d.same }
  }
  return null
}

function errMsg(e) {
  if (e instanceof Error) return e.message || String(e)
  if (typeof e === 'string') return e
  try { return String(e || '未知错误') } catch { return '未知错误' }
}

/**
 * 判同一性 tool loop 主入口。
 *
 * @param {object} message 新消息：{ userNote（必填）, selected?: { text, book?, chapter? } }
 * @param {Array}  stack 当前栈（非空）
 * @param {object} deps { callLLM（必填）, maxTokens?, attempts?, log? }
 * @returns {Promise<{same:boolean, attempts:number}>}
 */
export async function judgeSameProblem(message, stack, deps = {}) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('judgeSameProblem: message 必须是消息对象')
  }
  const userNote = String(message.userNote || '').trim()
  if (!userNote) throw new TypeError('judgeSameProblem: 需要新消息内容（userNote 非空）')
  if (!Array.isArray(stack) || stack.length === 0) {
    throw new TypeError('judgeSameProblem: 需要非空栈——空栈时由判专题化决定入不入')
  }
  const { callLLM, maxTokens = 2048, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('judgeSameProblem: 必须注入 callLLM(prompt, maxTokens)')
  }

  const basePrompt = buildSameProblemPrompt(message, stack)
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
      // 网络失败不带修正提示——模型没收到上一个 prompt，原样重发即可。
      if (attempt === attempts - 1) {
        throw new Error(`判同一性 LLM 调用失败：${errMsg(e)}`, { cause: e })
      }
      logReason = `LLM 调用失败（${errMsg(e)}）`
      log(`  ⚠️ 判同一性调用失败 (attempt ${attempt + 1}/${attempts}): ${errMsg(e)}`)
      continue
    }

    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`判同一性 LLM 返回失败串：${out.slice(0, 60)}`)
      logReason = 'LLM 返回失败串'
      continue
    }

    const parsed = parseSameResult(out)
    if (parsed) {
      log(`  ✓ 判同一性（attempt ${attempt + 1}）：${parsed.same ? '同一问题' : '换问题'}`)
      return { same: parsed.same, attempts: attempt + 1 }
    }

    promptHint = logReason = `输出不是合法 JSON 或缺少 same 字段（${out.slice(0, 60)}）`
    log(`  ⚠️ 判同一性第 ${attempt + 1} 次校验未通过（${logReason}），重试...`)
  }

  throw new Error(`判同一性 ${attempts} 次尝试后仍无有效判定（${logReason}）`)
}

// ── 栈状态机（Q2.5）──────────────────────────────────────────────────────────

// 一条用户消息入栈时生成栈条目（划线结构体原样带上；AI 回复由调用方后续追加）
export function makeStackEntry(message) {
  const selected = message.selected
  return {
    role: 'user',
    content: String(message.userNote || '').trim(),
    ...(selected && typeof selected === 'object' && String(selected.text || '').trim() ? { selected } : {}),
  }
}

/**
 * 栈状态机一步：喂一条用户消息，决定它的归属。
 *
 * @param {Array}  stack 当前栈（可为空）
 * @param {object} message { userNote（必填）, selected?: { text, book?, chapter? }, assistantContext?: { content, selected? } }
 *   - selected：用户这轮的划线结构体（可无）
 *   - assistantContext：上一轮 AI 回复 { content（文本）, selected?（它针对的划线，结构体同上） }。
 *     仅空栈判专题化时参与降级判定（见 judgeTopicization）；非空栈"换问题→判专题化"分支会剥掉它
 *     （那属于被换掉的旧问题，不承接）
 * @param {object} deps 透传给 judgeTopicization / judgeSameProblem；可选 now() 注入收口时间（默认 Date.now）
 * @returns {Promise<{action:'pushed'|'ignored'|'closed_and_pushed', stack:Array, closed?:object}>}
 *   - pushed：入栈（空栈初判专题化 或 同一问题累积）。若为"降级救回"（第一判非专、
 *     靠上一轮 AI 回复承接补判），栈首补入该 AI 回复作背景轮次（assistant 条目，带它针对的划线）
 *     ——它是讨论的真正起点，缺了后续同一性判断材料不完整
 *   - ignored：忽略不入栈（空栈非专题化 或 非同一问题且非专题化），栈不切断
 *   - closed_and_pushed：收口——closed = 专题化讨论组 { ts（收口时间）, entries（被收口的旧栈） }，
 *     整体归档为一次专题化讨论；新消息开新栈（stack=[新条目]）
 */
export async function processStackMessage(stack, message, deps = {}) {
  const cur = Array.isArray(stack) ? stack : []

  if (cur.length === 0) {
    const r = await judgeTopicization(message, deps)
    if (!r.topicized) {
      deps.log && deps.log('  → 空栈 + 非专题化：忽略，栈保持空')
      return { action: 'ignored', stack: [] }
    }
    const entry = makeStackEntry(message)
    const assist = message.assistantContext
    const assistContent = assist && typeof assist === 'object' ? String(assist.content || '').trim() : ''
    const assistSelected = assist && typeof assist === 'object' && assist.selected
      && String(assist.selected.text || '').trim() ? assist.selected : null
    const newStack = r.usedAssist && assistContent
      ? [{ role: 'assistant', content: assistContent, ...(assistSelected ? { selected: assistSelected } : {}) }, entry]
      : [entry]
    deps.log && deps.log(r.usedAssist
      ? '  → 空栈 + 专题化（降级救回）：入栈，补入上一轮 AI 回复作背景'
      : '  → 空栈 + 专题化：入栈（开新栈）')
    return { action: 'pushed', stack: newStack }
  }

  const same = await judgeSameProblem(message, cur, deps)
  if (same.same) {
    deps.log && deps.log('  → 同一问题：入栈累积')
    return { action: 'pushed', stack: [...cur, makeStackEntry(message)] }
  }

  // 换问题 → 判专题化。剥掉 assistantContext：栈内已有当前讨论上下文，而"上一轮 AI 回复"
  // 属于被换掉的旧问题，新消息不承接它——降级只会误判，此分支不启用。
  const { assistantContext: _ignored, ...msgWithoutAssist } = message
  const r2 = await judgeTopicization(msgWithoutAssist, deps)
  if (r2.topicized) {
    deps.log && deps.log('  → 不同问题 + 专题化：收口旧栈，新消息开新栈')
    const now = typeof deps.now === 'function' ? deps.now : Date.now
    return { action: 'closed_and_pushed', closed: { ts: now(), entries: cur }, stack: [makeStackEntry(message)] }
  }

  deps.log && deps.log('  → 不同问题 + 非专题化：忽略，不切断')
  return { action: 'ignored', stack: cur }
}

export { buildTopicizeInstruction }  // 供冒烟脚本复用判专题化指令
