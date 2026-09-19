/**
 * 收口固化的共享判定材料与公共前缀（2026-10 用户定调）。
 *
 * 归纳问题 / 派生 point / 派生能指 aliases 三个判定读**同一段讨论全文**。缓存只认公共前缀，
 * 所以三个 prompt 统一为：`[公共前缀] + [段全文] + [各自的任务尾]`——全文字节一致地前置，
 * 第 2、3 次调用命中第 1 次建立的全文前缀（共享大块在前、差异小块在后，与判同一性/引用解析同款）。
 * 公共前缀职责 = 材料自述 + 工作流预告 + 输出纪律，任务中立（不偏向三种动作任何一种）；
 * 各自判据与输出格式留在任务尾。
 */

// 公共前缀：三次调用字节完全相同（属于命中区）。任务中立——只解释材料与流程，
// 不展开任何动作专属判据，也不带"宁漏勿误"这类只属于个别动作的总纪律。
export const CONSOLIDATE_FRAMING = "你是 CoRead 的「会意系统」。下面是一段【收口讨论全文】——来自同一场专题化讨论，\n用户提问与 AI 回复按对话顺序连续排列：\"用户：\" 开头的是用户发言，\"AI：\" 开头的是 AI 回复；\n这场讨论在收口时已被细切为一个不可分割的知识点讨论组。\n\n现在要对这段材料做一次会意图固化判定。本次调用会请你完成三种动作中的一种——归纳这段讨论\n正在追的具体问题（question）、派生这条知识点的落点表述（point）、或拾取被 point 卸下的\n背景对象能指（aliases）。具体做哪一件、判定标准与输出格式，全部见末尾的任务指令。\n\n读法约定：\n- 先通读全文，掌握讨论脉络（追的是哪个问题、如何推进、展开过哪些背景内容），再执行末尾任务；\n- 材料只是判定依据——不要复述、转述或解释材料本身；\n- 直接按末尾任务指令的输出格式给结果：只输出要求的那一行 JSON，不要任何其他文字、推理过程或代码块。"

// 段条目 → 讨论轮次对（{q, a}）：user 后最近一条非空 assistant 成对；与固化落图的
// discussion.excerpts 口径一致——归纳/point/aliases 必须从同一份 excerpts 渲染，前缀才字节相同。
export function groupExcerpts(entries) {
  const out = []
  let q = ''
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    if (e.role === 'user') q = String(e.content || '').trim()
    else if (e.role === 'assistant' && q) {
      const a = String(e.content || '').trim()
      if (a) out.push({ q, a })
      q = ''
    }
  }
  return out
}

// 段全文（统一渲染，全量不截断）：三个固化判定的共享材料块。
export function discussionBlock(excerpts) {
  const lines = ['讨论内容（收口讨论全文，全量提供，不截断）：']
  for (const e of Array.isArray(excerpts) ? excerpts : []) {
    const q = String(e?.q || '').trim()
    const a = String(e?.a || '').trim()
    if (q) lines.push('用户："' + q + '"')
    if (a) lines.push('AI："' + a + '"')
  }
  return lines.join('\n')
}

// 组装：公共前缀 + 段全文 + 任务尾（任务尾每调用不同，是唯一 miss 段）。
export function buildConsolidatePrompt(excerpts, tail) {
  return [CONSOLIDATE_FRAMING, '', discussionBlock(excerpts), '', tail].join('\n')
}