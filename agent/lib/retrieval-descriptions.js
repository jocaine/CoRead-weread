import { discussionBlock } from './discussion-text.js'
import { extractJsonObject } from './topicize.js'

export const DESCRIPTION_VERSION = 'topics-v1'
export const MAX_DESCRIPTION_CHARACTERS = 400

export function buildDescriptionsPrompt(excerpts) {
  return DESCRIPTION_INSTRUCTIONS + discussionBlock(excerpts)
}

export function parseDescriptions(text) {
  const value = extractJsonObject(text)
  if (!value || !Array.isArray(value.descriptions)) return null
  if (value.descriptions.some(d => typeof d !== 'string' || !d.trim())) return null
  const descriptions = [...new Set(value.descriptions.map(d => d.trim()))]
  if (descriptions.reduce((sum, d) => sum + [...d].length, 0) > MAX_DESCRIPTION_CHARACTERS) return null
  return descriptions
}

// 一次生成统一描述；只对调用失败、格式或总篇幅不合规重试，不再另做模型核对。
export async function deriveDescriptions(excerpts, { callLLM, attempts = 3, maxTokens = 8192, log = () => {} } = {}) {
  if (typeof callLLM !== 'function') throw new TypeError('deriveDescriptions: 缺少 callLLM')
  if (!Array.isArray(excerpts) || !excerpts.some(e => e?.q || e?.a)) throw new TypeError('deriveDescriptions: 缺少讨论原文')
  const prompt = buildDescriptionsPrompt(excerpts)
  let failure
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const text = await callLLM(attempt ? prompt + '\n请重新输出合法 JSON，描述合计不得超过400字符，不限制条数。' : prompt, maxTokens)
      const descriptions = parseDescriptions(text)
      if (!descriptions) throw new Error('检索描述格式不合法或超过400字符')
      return { descriptions, attempts: attempt + 1 }
    } catch (e) {
      failure = e
      log(`检索描述第${attempt + 1}次失败：${e.message}`)
    }
  }
  throw new Error('检索描述生成失败：' + failure?.message, { cause: failure })
}
export const DESCRIPTION_INSTRUCTIONS = "你是 CoRead 的会意系统。请从下面整段讨论中，一次生成少量检索描述，不区分核心标题和补充描述。它们只用于向量检索找到原对话，不是结论摘要，答案留在原对话里。\n每条写清具体对象，以及重要的讨论问题、关系或分歧，使用户换一种说法也能找到；不要只列关键词，也不要模糊成适用于许多对话的抽象主题。\n优先保留用户持续追问、质疑和修正所涉及的问题；略去顺带举例和一次性解释。不穷尽全部知识点，不按 AI 回答字数决定重要性。重复不作为本次首要取舍标准。\n允许省略答案、弱化断言：优先描述讨论了什么、比较什么、对什么有分歧，不裁定哪一种因果解释或历史判断已经成立，不复述讨论过程流水账。\n不能借疑问句偷渡有争议的前提：未确认某关系成立时，写“是否有关、如何理解其关系”，不要写成默认关系成立的“为什么导致”。\n涉及被反驳的解释时，可以记录针对该解释的质疑，但不能把它作为双方结论。保留观点归属、否定和不确定程度；允许不写结论，不允许把关系写反。\n有必要表达具体关系时，对象、条件、因果及变化方向必须忠于原话；拿不准就退回对象之间的关系或适用性问题，不补推论，不引入外部知识。\n所有描述合计不超过 400 个字符（包含标点，不含 JSON 格式字符）。篇幅上限不是目标；有几条重要内容就写几条，必要时可返回空数组。\n只输出一行 JSON：{\"descriptions\":[\"独立的检索描述\"]}，不要分析、解释或其他字段。\n\n"
