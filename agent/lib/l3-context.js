#!/usr/bin/env node
/**
 * L3 上下文渲染（会意图 → 主回复上下文块）。2026-10 定调。
 *
 * 来源只有两条（由调用方 lib/knowledge-graph.js 的 userAncestry 提供）：
 *   ① 本轮引用解析命中的节点；
 *   ② 命中节点的 user 入边闭包（"来路"——那条讨论当时自己引用过的更早知识点）。
 *
 * 两者都只渲染 node.point（标题行）+ discussions 的 excerpts **原话全文**，全量不截断。
 * **不渲染 aliases**：point/aliases 是固化时为"引用解析/判同一性"生成的索引，不是语料——
 * 拿目录当正文，模型会自己补论证（幻觉）。**不走 derived 边**：同栈相邻段是判同一性切出来的
 * "不可分割组"，按系统自己的判定就不是同一个问题，只是同一场会话里先后问出来。**不走 user
 * 出边**（去路）：那是后来别的讨论引用它才长出来的边，不是这个节点的出身，且随图增长漂移。
 *
 * 顺序：来路（跳数大→小）在前，命中节点在最后——块尾紧邻本轮问题（防"块尾磁吸"跑题）。
 * 调用方把本块作为**独立消息**插在【本轮消息】之前（见 index.js 的 say），所以生成点前
 * 最后读到的永远是本轮问题本身。
 */

function l3Block(entries) {
  const lines = [
    '[图路径上下文]（你引用/联想到了之前聊过的知识点）',
    '使用方式：用户这一轮的说法已匹配到下列旧知识点。回答时——',
    '① 先正面回答用户的问题本身，不要被下文带跑；',
    '② 下文全部是**你和用户当时说过的原话**（不是概括、不是系统的总结），把它当作"我们之前共同建立的理解"，在此基础上延续、修正或反驳，给出实质推进（新例证、新区分、明确反驳），不要复述原文；',
    '③ 【来路 N 跳】是那条讨论当时自己引用过的更早知识点（N 越大越早）；【本轮命中】是用户这一轮直接指认的，排在最后、最贴近当前问题；',
    '④ 只是背景资料，用户这一轮没提到的不要硬提。',
    '知识点路径：',
  ]
  for (const { node: n, hops, hit } of entries) {
    const tag = hit ? '【本轮命中】' : `【来路 ${hops} 跳】`
    const srcBook = (n.discussions || []).map((d) => d?.book).find((b) => b)
    lines.push(`${tag} ${n.point}${srcBook ? `　〔源：《${srcBook}》〕` : ''}`)
    for (const d of n.discussions || []) {
      if (d?.question) lines.push(`  · 这场讨论追的问题：${d.question}`)
      const exs = Array.isArray(d?.excerpts) ? d.excerpts.filter((e) => e && (e.q || e.a)) : []
      for (const e of exs) {
        const q = String(e.q || '').trim()
        const a = String(e.a || '').trim()
        if (q) lines.push(`    用户："${q}"`)
        if (a) lines.push(`    AI："${a}"`)
      }
    }
  }
  return lines.join('\n')
}

export { l3Block }
