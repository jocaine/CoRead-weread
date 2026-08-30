#!/usr/bin/env node
/**
 * 用户情况与观念画像 · 维护（self-portrait）
 *
 * 用户在对话里谈到自己时（自己的情况），或表露立场/价值观/看问题的方式时（自己的观念），
 * 把本条消息**总结**为画像条目，维护一份独立画像。对应 self-portrait-design.md。
 *
 * 与 profile 的本质区别：
 * - 不进头部上下文（buildSystemInstruction 不含本画像）——维护不伤 LLM 前缀缓存；
 * - 不是合并式重写——只在有新信息时追加条目，旧条目不动；
 * - 内容是**总结**（归纳成画像陈述），不是原文截取（用户定调 2026-08-17）。
 *
 * 关键设计（用户定调）：
 * - 总结不抄原话：条目是对用户情况/观念的归纳陈述，简洁画像语言，不流水账。
 * - 只记用户：判定材料只有用户消息；AI 的话不记。
 * - 去重靠比对现有画像：判定时输入现有画像条目，与已有信息重复的不再输出。
 * - 本模块只判"总结出什么"，不负责写文件——文件读写（self-portrait.md）是调用方职责。
 *
 * 实现要点：
 * - callLLM(prompt, maxTokens) 由调用方注入——模块不自己调模型。测试时插假函数，
 *   接入 index.js 时包一层真调用传进来（同 judgeLLM 模式，temperature 0）。
 * - 解析复用 topicize.js 的 extractJsonObject；思考草稿 JSON.parse 必失败 → 重试。
 * - 输出协议：只输出一行 JSON {"situation":["..."],"belief":["..."]}；无内容输出空数组。
 */

import { extractJsonObject } from './topicize.js'

export const MAX_ATTEMPTS = 3

// 判据标准提示词（self-portrait-design.md §4）
export function buildSelfPortraitInstruction() {
  return [
    '你是 CoRead 的「用户画像」维护员。用户消息里谈到自己的情况、做过的事、对事件的思考，或表露观念时，把它们**总结**为画像条目。',
    '',
    '画像分四类：',
    '- situation（情况）：用户的生活状况——家庭与亲属、工作、居住、年龄、经历、处境（例："父母离婚，随爷爷奶奶生活过""已毕业在外工作""24岁"）。',
    '- events（做过的事）：用户实际做过的事情与行动，带时间线索，并且**必须总结出做这件事的出发点/动机/对用户的意义**——用户对 CoRead 说出的完整的事都不是唠家常，行为背后是处境与意图（例："给孙阿姨（之前认识的保洁员）打电话问候她出车祸后的身体——这是基于对自己阶级位置的认知、想开始自己的实践田野的第一步脚印，不是单纯的人情问候"；"8月从启辰之星离职——对现状不满，准备到别处看看"）。只记表面行为（"打了个电话"）是残缺总结。',
    '- thoughts（对事件的思考）：用户对自己经历/事件的想法、感受、心理活动、自我定位与行动意图——为某事犹豫、回忆、自我剖析、心境变化、对自己处境的认知（例："给孙阿姨打电话前犹豫了很久，担心打扰她，最后觉得能说上话就好""认为自己处于无产者位置，想从对自身阶级位置的认识出发开始实践""看到书中家庭场景想到自己家，感到难过""觉得自己的乡愁来得太早"）。',
    '- belief（观念）：用户的立场、价值观、看问题的方式、思维习惯——包括阅读讨论中反复坚持的立场（例："认为制度优越性依附于国际位置而非制度本身""习惯用阶级分析视角看社会""自认为是马克思主义者"）。',
    '',
    '总结原则：',
    '- 归纳成简洁陈述句（一句一事），画像语言，不抄用户原话、不流水账。',
    '- 只总结用户本人；用户转述别人的事不记（除非带出用户自己的处境/态度）。',
    '- 无新信息输出空数组；与现有画像重复的信息不输出（现有画像已覆盖的不重复总结）。',
    '',
    '不记：',
    '- 对书中人物、情节的评价与感受（那是阅读感受，不是用户观念）。',
    '- 纯知识问答（例："康尼派是什么""列宁当时对哥萨克的判断是什么"）。',
    '- 寒暄客套（例："你好""ping"）、对 AI 回复风格的要求（那是 soul 的领域）、对 AI 回复内容本身的讨论。',
    '- 一次性的、为推进讨论临时提出的问题——不总结（要的是用户反复坚持或明确宣示的立场）。',
    '',
    '关于划线内容：如果提供了划线，它只用来解析消息里的指代。判定材料仍是用户消息本身。',
    '关于对话脉络：如果提供了对话脉络（该消息前后的 AI 回复），它用来理解事件的来龙去脉——用户做某事的动机/出发点往往在脉络里展开（例：用户先向 AI 咨询"组织实践怎么学"，AI 回应后用户决定联系孙阿姨——动机在 AI 回复的语境中可见）。从脉络中归纳用户的动机与意义；AI 回复里的观点不属于用户，不总结 AI 的内容，但 AI 回应所揭示的用户意图要总结。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程；不要先分析消息、不要复述任务）：',
    '{"situation":["情况条目1"],"events":["做过的事条目1"],"thoughts":["对事件的思考条目1"],"belief":["观念条目1"]}',
    '字段：situation / events / thoughts / belief 均为字符串数组；元素为总结出的画像条目（简洁陈述句）。没有对应内容就输出空数组。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

export const MAX_NOTE_CHARS = 4000  // 超长消息（通话记录转写等）截断：保留开头关键信息，防推理模型输出分析而非 JSON
export const MAX_EXISTING_CHARS = 3000  // 现有画像输入上限：只带最新一部分作去重参照

/**
 * 组装判定材料：用户消息（主体）+ 划线（仅解析指代）+ 对话脉络（AI 回复，理解动机）+ 现有画像（去重参照）。
 * @param {object} input { userNote（必填）, selected? }
 * @param {string} [existing] 现有画像文本，判定时用于去重
 * @param {string} [context] 对话脉络（该消息前后的 AI 回复），用于归纳用户做事的动机/意义
 */
export const MAX_CONTEXT_CHARS = 4000  // 对话脉络输入上限
export function buildSelfPortraitPrompt(input, existing, context) {
  let userNote = String(input.userNote || '').trim()
  if (userNote.length > MAX_NOTE_CHARS) {
    userNote = userNote.slice(0, MAX_NOTE_CHARS) + '\n\n……（消息过长，已截断；以截断部分为准判定与总结）'
  }
  const lines = [buildSelfPortraitInstruction(), '', `用户消息："${userNote}"`]
  const sel = String(input.selected?.text || '').trim()
  if (sel) lines.push('', `划线内容（仅用于解析消息中的指代）："${sel}"`)
  const ctx = String(context || '').trim()
  if (ctx) {
    lines.push('', '对话脉络（该消息前后的 AI 回复，仅用于理解事件来龙去脉与用户动机）：')
    lines.push(ctx.length > MAX_CONTEXT_CHARS ? ctx.slice(-MAX_CONTEXT_CHARS) : ctx)
  }
  const ex = String(existing || '').trim()
  if (ex) {
    lines.push('', '现有画像（仅作去重参照，不要重复输出已覆盖的信息）：')
    lines.push(ex.length > MAX_EXISTING_CHARS ? ex.slice(-MAX_EXISTING_CHARS) : ex)
  }
  return lines.join('\n')
}


// 解析回复：{"situation":[...],"events":[...],"thoughts":[...],"belief":[...]}；容忍前言回显/围栏/多余字段；字段非法 → null
export function parseSelfPortraitResult(text) {
  const d = extractJsonObject(text)
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const arr = (k) => Array.isArray(d[k]) ? d[k].map((x) => String(x || '').trim()).filter(Boolean) : []
    const situation = arr('situation')
    const events = arr('events')
    const thoughts = arr('thoughts')
    const belief = arr('belief')
    if (situation.length || events.length || thoughts.length || belief.length) return { situation, events, thoughts, belief }
    // 全空数组也算合法输出（无新信息）——需确认至少存在一个字段且为数组
    if (['situation', 'events', 'thoughts', 'belief'].some((k) => Array.isArray(d[k]))) return { situation, events, thoughts, belief }
  }
  return null
}

function errMsg(e) {
  if (e instanceof Error) return e.message || String(e)
  if (typeof e === 'string') return e
  try { return String(e || '未知错误') } catch { return '未知错误' }
}

/**
 * 画像维护主入口：判定 + 总结。
 *
 * @param {object} input
 *   - {string} userNote 用户消息原文（必填）
 *   - {object} [selected] 划线结构体 { text, book?, chapter? }——text 仅用于解析消息中的指代
 * @param {object} deps
 *   - {function} callLLM 必填，签名 (prompt, maxTokens) => Promise<string>
 *   - {string}   [existing] 现有画像文本（去重参照）
 *   - {string}   [context] 对话脉络（该消息前后的 AI 回复），用于归纳用户做事的动机/意义
 *   - {number}   [maxTokens=4096]
 *   - {number}   [attempts=MAX_ATTEMPTS]
 *   - {function} [log] 可选诊断日志 (msg) => void
 * @returns {Promise<{situation:string[], events:string[], thoughts:string[], belief:string[], attempts:number}>}
 *   四类：情况 / 做过的事 / 对事件的思考 / 观念；都为空 = 无新信息，零写入。
 * @throws 内容缺省 / 未注入 callLLM → TypeError；LLM 调用失败 → Error；重试耗尽 → Error
 */
export async function judgeSelfPortrait(input, deps = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('judgeSelfPortrait: input 必须是消息对象')
  }
  const userNote = String(input.userNote || '').trim()
  if (!userNote) {
    throw new TypeError('judgeSelfPortrait: 需要用户消息内容（userNote 非空）')
  }
  const { callLLM } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('judgeSelfPortrait: 必须注入 callLLM(prompt, maxTokens)')
  }

  const basePrompt = buildSelfPortraitPrompt(input, deps.existing, deps.context)
  const { maxTokens = 4096, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  let logReason = ''    // 最近一次失败原因：进日志、也是最终报错的内容
  let promptHint = ''   // 拼进重试 prompt 的修正提示：只在"输出非法"时写

  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0 || !promptHint
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验（${promptHint}）。请重新输出：只给最终一行 JSON，不要任何推理、字数计算、示例或额外文字。`

    let text
    try {
      text = await callLLM(prompt, maxTokens)
    } catch (e) {
      if (attempt === attempts - 1) {
        throw new Error(`画像维护 LLM 调用失败：${errMsg(e)}`, { cause: e })
      }
      logReason = `LLM 调用失败（${errMsg(e)}）`
      log(`  ⚠️ 画像维护调用失败 (attempt ${attempt + 1}/${attempts}): ${errMsg(e)}`)
      continue
    }

    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`画像维护 LLM 返回失败串：${out.slice(0, 60)}`)
      logReason = 'LLM 返回失败串'
      continue
    }

    const parsed = parseSelfPortraitResult(out)
    if (parsed) {
      const n = parsed.situation.length + parsed.events.length + parsed.thoughts.length + parsed.belief.length
      const parts = [
        parsed.situation.length ? parsed.situation.length + ' 条情况' : '',
        parsed.events.length ? parsed.events.length + ' 条事件' : '',
        parsed.thoughts.length ? parsed.thoughts.length + ' 条思考' : '',
        parsed.belief.length ? parsed.belief.length + ' 条观念' : '',
      ].filter(Boolean).join(' + ')
      log(`  ✓ 画像维护（attempt ${attempt + 1}）：${n ? '总结 ' + parts : '无新信息'}`)
      return { situation: parsed.situation, events: parsed.events, thoughts: parsed.thoughts, belief: parsed.belief, attempts: attempt + 1 }
    }

    promptHint = logReason = `输出不是合法 JSON 或缺少 situation/belief 数组字段（${out.slice(0, 60)}）`
    log(`  ⚠️ 画像维护第 ${attempt + 1} 次校验未通过（${logReason}），重试...`)
  }

  throw new Error(`画像维护 ${attempts} 次尝试后仍无有效判定（${logReason}）`)
}