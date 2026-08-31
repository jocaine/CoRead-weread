#!/usr/bin/env node
/** 生成真实 L3 块完整样本（与 index.js l3Block 同款组装），供展示 */
import fs from 'node:fs'

const g = JSON.parse(fs.readFileSync('agent/data/knowledge-graph.json', 'utf8'))

function l3Block(nodes) {
  const lines = [
    '[图路径上下文]（你引用/联想到了之前聊过的知识点，root→recent 路径不截断）：',
    '使用方式：用户消息里的指认说法已匹配到下列旧知识点。回答时——',
    '① 先正面回答用户的问题本身，不要被下文带跑；',
    '② 用户引用旧知识点时，把它当作"我们之前共同建立的理解"，在此基础上延续、修正或反驳，给出实质推进（新例证、新区分、明确反驳），不要复述原文；',
    '③ 命中多个节点时注意它们之间的路径关系（谁引用谁）；',
    '④ 图路径只是背景资料，用户没引用到的节点不要硬提。',
    '知识点路径：',
  ]
  for (const n of nodes) {
    lines.push(`- ${n.point}`)
    for (const d of n.discussions || []) {
      const book = d?.book ? `《${d.book}》` : ''
      lines.push(`  · ${book}${d?.chapter || ''}：${d?.question || ''}`)
      const exs = Array.isArray(d?.excerpts) ? d.excerpts.filter((e) => e && (e.q || e.a)) : []
      for (const e of exs) {
        if (e.q) lines.push(`    用户："${e.q}"`)
        if (e.a) lines.push(`    AI："${e.a}"`)
      }
    }
  }
  return lines.join('\n')
}

const node = g.nodes.find((n) => n.id === 'n_d_28')
const out = l3Block([node])
fs.writeFileSync('agent/scripts/_l3_sample.txt', out)
console.log(`已生成 _l3_sample.txt：${out.length} 字符 ≈ ${Math.ceil(out.length * 0.62)} token（单节点 n_d_28，全量）`)
