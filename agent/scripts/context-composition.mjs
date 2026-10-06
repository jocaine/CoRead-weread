#!/usr/bin/env node
/**
 * 一次主回复请求的上下文构成与占比（真实数据 + 实测校准系数 token/字符 ≈ 0.62）。
 * 场景：读书模式 + 带划线 + L3 命中。
 */
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_DIR, BOOKS_DIR, DATA_FILES } from '../lib/paths.js'  // 数据路径唯一真源

const AGENT = AGENT_DIR
const BOOKS = BOOKS_DIR
const RATIO = 0.62   // 实测校准：真实历史 19.9 万字符 = 12.2 万 token（字符/token ≈ 1.6）

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const tok = (s) => Math.ceil(String(s).length * RATIO)

// ── SYSTEM（buildSystemInstruction 的真实组装）──────────────────────────────
// AGENT.md 是程序文件，跟着代码走；profile/soul 是数据，在 data\profile\ 下
const rules = read(path.join(AGENT, 'AGENT.md'))
const profile = read(DATA_FILES.portrait)
const soul = read(DATA_FILES['values-portrait'])
const booksTitles = []
try {
  for (const name of fs.readdirSync(BOOKS)) {
    try {
      const m = JSON.parse(read(path.join(BOOKS, name, 'meta.json')))
      if (m.wereadBookId && m.bookTitle) booksTitles.push(String(m.bookTitle).replace(/\s+/g, ' ').trim())
    } catch {}
  }
} catch {}
const head = '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n'
const bookSection = booksTitles.length
  ? '\n\n========\n# 用户书籍足迹（已添加引用/划线的书，用于跨书联想）\n' + booksTitles.map((t) => `- 《${t}》`).join('\n')
  : ''
const systemText = [head, rules, '\n\n========\n# 用户阅读画像（profile.md）\n', profile,
  '\n\n========\n# 你的自画像（soul.md）\n', soul, bookSection].join('')

// ── 本次消息（enrichChatMessage + L3）───────────────────────────────────────
// 章节窗口：进度概览 + 前文窗口 ≤1500 字 + 划线窗口 ±300 字（真实量级）
const progressCtx = '当前章节：六；chapterUid=123；offset=456\n微信读书当前位置摘要：…（几行）'
const chapterWindow = `[当前进度前文窗口]\n${'原文'.repeat(1500 / 2)}\n`   // 1500 字
const selWindow = `选中文字附近上下文：${'原文'.repeat(300 / 2)}`             // ±300 字
const bookCtx = `${progressCtx}\n${chapterWindow}\n${selWindow}`            // assembleBookContext 实际
const USER_AVG = 141   // 实测：user 消息均值 141.2 token
const userText = '用户本次提问：我想到我们之前说的芬兰的建国的历史条件，能再展开吗？（真实均值 141 token）'
const userMsg = `[正在共读]《静静的顿河》六\n${bookCtx}\n${userText}`

// L3：真实节点 n_d_28（root，路径=自身）按 l3Block 格式全文
const graph = JSON.parse(read(DATA_FILES['knowledge-graph']))
const n28 = graph.nodes.find((n) => n.id === 'n_d_28')
const l3Lines = [
  '[图路径上下文]（你引用/联想到了之前聊过的知识点，root→recent 路径不截断）：',
  '使用方式：用户消息里的指认说法已匹配到下列旧知识点。回答时——',
  '① 先正面回答用户的问题本身，不要被下文带跑；',
  '② 用户引用旧知识点时，把它当作"我们之前共同建立的理解"，在此基础上延续、修正或反驳，给出实质推进（新例证、新区分、明确反驳），不要复述原文；',
  '③ 命中多个节点时注意它们之间的路径关系（谁引用谁）；',
  '④ 图路径只是背景资料，用户没引用到的节点不要硬提。',
  '知识点路径：',
  `- ${n28.point}`,
]
for (const d of n28.discussions || []) {
  l3Lines.push(`  · 《${d.book}》${d.chapter}：${d.question}`)
  for (const e of d.excerpts || []) {
    if (e.q) l3Lines.push(`    用户："${e.q}"`)
    if (e.a) l3Lines.push(`    AI："${e.a}"`)
  }
}
const l3Text = l3Lines.join('\n')

// ── 历史（当前配置 BUDGET）──────────────────────────────────────────────────
const HIST_BUDGET = 64000

const parts = [
  ['SYSTEM 指令', systemText],
  ['本次消息·章节窗口', userMsg],
  ['本次消息·L3（命中，全量）', l3Text],
]
const userTextOnly = tok('用户本次提问：我想到我们之前说的芬兰的建国的历史条件，能再展开吗？')

console.log('一次读书模式命中请求的上下文构成（token 估算，token/字符=0.62）：\n')
console.log(`SYSTEM：AGENT.md ${tok(rules)} + profile ${tok(profile)} + soul ${tok(soul)} + 书籍足迹 ${tok(bookSection)} + 头 ${tok(head)}`)
console.log(`   = ${tok(systemText)} token（${(systemText.length / 1000).toFixed(1)}K 字符）`)
console.log(`历史：预算 ${HIST_BUDGET} token（≈${Math.round(HIST_BUDGET / 643)} 轮）`)
console.log(`本次消息：章节窗口 ${tok(userMsg) - tok(userText)} + 用户原话 ${USER_AVG}（实测均值）`)
console.log(`L3：${tok(l3Text)} token（${(l3Text.length / 1000).toFixed(1)}K 字符，单节点全量不截断）`)
console.log('')
const total = tok(systemText) + HIST_BUDGET + tok(userMsg) + tok(l3Text)
const rows = [
  ['SYSTEM 指令', tok(systemText)],
  ['历史（预算上限）', HIST_BUDGET],
  ['本次消息（章节窗口+原话）', tok(userMsg)],
  ['L3 图路径（命中）', tok(l3Text)],
]
console.log('占比（命中场景）：')
for (const [name, t] of rows) {
  console.log(`  ${name.padEnd(22)} ${String(t).padStart(7)} token  ${(100 * t / total).toFixed(1).padStart(5)}%`)
}
console.log(`  ${'合计'.padEnd(22)} ${String(total).padStart(7)} token（1M 窗口的 ${(100 * total / 1000000).toFixed(2)}%）`)
console.log('')
console.log('未命中场景（无 L3）：合计 = ' + (total - tok(l3Text)) + ' token')
// ── 引用解析判定调用（独立请求：JUDGE_SYSTEM + 指令 + 全量 55 节点（point+全量能指+问题）+ 发言）──
const nodeLines = graph.nodes.map((n) => {
  const al = (n.aliases || []).length ? `（能指：${n.aliases.map((a) => `"${a}"`).join('；')}）` : ''
  const qs = (n.discussions || []).length ? `（讨论过：${n.discussions.slice(0, 5).map((d) => `"${d.question}"`).join('；')}）` : ''
  return `- ${n.id}：「${n.point}」${al}${qs}`
})
const refNodeBlock = nodeLines.join('\n')
console.log('引用解析判定调用（独立请求，JUDGE_SYSTEM + 指令 + 全量节点 + 发言）：')
console.log(`  全量节点列表 ≈ ${tok(refNodeBlock)} token（55 节点：point + 全部能指 + 讨论过的问题）`)
console.log(`  指令 ≈ ${tok('你是 CoRead 的「会意系统」，现在执行动作③「引用解析」…（判据全文）')} token；用户发言 ≈ ${USER_AVG} token`)
