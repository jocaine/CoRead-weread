#!/usr/bin/env node
/**
 * 判同一性 + 专题化讨论栈（AI-016 / Q2.5）真实 API 冒烟测试。
 * 与 smoke-topicize.mjs（单条判专题化）互补：本脚本模拟多轮对话序列，
 * 驱动栈状态机（processStackMessage），端到端验证"哪几轮算一次专题化讨论"。
 * 运行：npm run smoke:stack（需 agent/.env 配置 COREAD_API_KEY / COREAD_API_BASE）
 * 建议在改判同一性判据 / 栈状态机逻辑后跑一次。
 */
import { processStackMessage } from '../lib/topic-stack.js'

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

async function callLLMOnce(prompt, maxTokens) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0,
      tool_choice: 'none',
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
  const data = JSON.parse(raw)
  const msg = data.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

// 对话序列用例：turns = 用户轮次（note 必填；selected 模拟划线结构体；aiReply = 模拟 AI 回复，
// 仅作后续同一性判断的上下文，不入 API）。expect = 每轮期望的栈动作。
// 标定依据：Q2.5 栈状态机（入栈=专题化初判，累积=同一问题，收口=换问题+专题化，忽略=非专题化）。
const SEQUENCES = [
  {
    name: '入栈+指代接续+无指代观点接续',
    turns: [
      { userNote: '一个政权靠什么维持？我总觉得光靠暴力撑不久', selected: { text: '老人认出故人，两人对坐无语', book: '《静静的顿河》', chapter: '六' }, aiReply: '维持靠的是一整套制度化安排，暴力只是最后的手段。' },
      { userNote: '那维持条件是内生的还是外来的？', aiReply: '两者互为条件：内生给合法性，外来给资源，制度在接口处复制自己。' },
      { userNote: '不对，我觉得制度自身的惯性才是关键，你漏了路径依赖', aiReply: '你说得对——既得利益者会锁住制度，惯性本身是维持的一部分。' },
    ],
    expect: ['pushed', 'pushed', 'pushed'],
    basis: '首条专题化入栈；显式指代接续；第三条无"那/这/它"仍承接上一轮（观点接续）→ 都累积',
  },
  {
    name: '中间插闲聊不切断',
    turns: [
      { userNote: '一个政权靠什么维持？', aiReply: '维持靠制度化安排，暴力只是最后手段。' },
      { userNote: '哈哈这书真敢写', aiReply: '（闲聊，不进栈）' },
      { userNote: '那维持条件是内生的还是外来的？', aiReply: '两者互为条件。' },
    ],
    expect: ['pushed', 'ignored', 'pushed'],
    basis: '闲聊不同问题且非专题化 → 忽略不入栈、不切断；回到机制追问继续累积',
  },
  {
    name: '问题转移切断（收口）',
    turns: [
      { userNote: '一个政权靠什么维持？', aiReply: '维持靠制度化安排，暴力只是最后手段。' },
      { userNote: '那维持条件是内生的还是外来的？', aiReply: '两者互为条件。' },
      { userNote: '列宁的工人贵族论为什么后来被抛弃了？', aiReply: '工人贵族论与实际工人运动的背离是主因。' },
    ],
    expect: ['pushed', 'pushed', 'closed_and_pushed'],
    basis: '前两轮累积；第三条换问题 + 专题化 → 收口旧栈（一次专题化讨论结束）+ 开新栈',
  },
  {
    name: '解绑漂移不切断',
    turns: [
      { userNote: '一个政权靠什么维持？', selected: { text: '老人认出故人，两人对坐无语', book: '《静静的顿河》', chapter: '六' }, aiReply: '维持靠制度化安排。' },
      { userNote: '这个讲法放到今天的企业组织里还成立吗？', aiReply: '成立——组织结构就是制度化安排的具体形态。' },
    ],
    expect: ['pushed', 'pushed'],
    basis: '第二条无划线（模拟解绑转自由对话），但承接同一问题 → 不切断，累积',
  },
  {
    name: '空栈非专题化忽略',
    turns: [
      { userNote: '"代偿"这个词是什么意思？', aiReply: '代偿指由他人代为偿还。' },
    ],
    expect: ['ignored'],
    basis: '词义一次答完 → 非专题化 → 忽略，栈保持空',
  },
  {
    name: 'AI 回复成种子：首问忽略 → 承接展开入栈（降级救回链路）',
    turns: [
      { userNote: '人生到底有什么意义？', aiReply: '意义不是被发现的，而是每个人通过选择与行动定义出来的——萨特所谓"存在先于本质"。' },
      { userNote: '那照这么说，意义是主观的，那宗教给人规定的意义又算什么？', aiReply: '宗教把意义定义为先于个体而存在，与"意义由人定义"恰是两条相反的路径。' },
      { userNote: '那这两条路会导向不同的活法吗？', aiReply: '会——一条以自身选择为准，一条以既有教义为准。' },
    ],
    expect: ['ignored', 'pushed', 'pushed'],
    basis: '首问无上一轮 AI 回复且自身空泛 → 忽略；AI 回复抛出"意义是主观构建"种子，次问承接展开（入栈，可能走降级）；第三问同一问题累积',
  },
  {
    name: '纯反应不救回：嗯嗯不因 AI 回复深刻入栈',
    turns: [
      { userNote: '人生到底有什么意义？', aiReply: '意义不是被发现的，而是每个人通过选择与行动定义出来的。' },
      { userNote: '嗯嗯，有道理', aiReply: '（沉默）' },
    ],
    expect: ['ignored', 'ignored'],
    basis: '首问忽略；纯反应虽承接上一轮 AI 回复但不构成推进 → 降级判定维持非专题化 → 仍忽略',
  },
]

const ACT_SYM = { pushed: '入栈', ignored: '忽略', closed_and_pushed: '收口' }
let totalHit = 0
let totalRuns = 0

console.log(`模型: ${MODEL} | temperature: 0 | 序列用例: ${SEQUENCES.length}\n`)
for (const seq of SEQUENCES) {
  const deps = {
    callLLM: callLLMOnce,
    maxTokens: 512,
    log: (m) => console.log(`    ${m}`),
  }
  let stack = []
  const actions = []
  const closed = []
  let lastAssistant = ''  // 上一轮 AI 回复（对话流紧邻上一条 assistant 消息），作降级判定的辅助材料
  for (const [i, turn] of seq.turns.entries()) {
    const { aiReply: _reply, ...msgRest } = turn  // aiReply 是模拟回复，不进判定消息
    const msg = lastAssistant ? { ...msgRest, assistantContext: { content: lastAssistant } } : { ...msgRest }
    const r = await processStackMessage(stack, msg, deps)
    actions.push(r.action)
    if (r.action === 'closed_and_pushed') closed.push(i + 1)  // 第几轮收口
    stack = r.stack
    if (r.action !== 'ignored' && turn.aiReply) {
      stack.push({ role: 'assistant', content: turn.aiReply })  // AI 回复入栈，供后续同一性判断
    }
    if (turn.aiReply) lastAssistant = turn.aiReply  // 无论是否入栈，上一轮 AI 回复都是对话流的一部分
  }
  const ok = actions.every((a, i) => a === seq.expect[i])
  if (ok) totalHit++
  totalRuns++
  const gotStr = actions.map((a) => `${ACT_SYM[a] ?? a}`).join(' → ')
  const expectStr = seq.expect.map((a) => ACT_SYM[a]).join(' → ')
  console.log(`${ok ? '✔' : '✘'} ${seq.name}`)
  console.log(`    期望: ${expectStr}`)
  console.log(`    实际: ${gotStr}${closed.length ? `（第 ${closed.join('、')} 轮收口）` : ''}`)
  console.log(`    依据: ${seq.basis}`)
  if (!ok) {
    // 定位第一处偏差轮次
    const badIdx = actions.findIndex((a, i) => a !== seq.expect[i])
    console.log(`    ⚠️ 第 ${badIdx + 1} 轮不符合预期（期望 ${ACT_SYM[seq.expect[badIdx]]}，实际 ${ACT_SYM[actions[badIdx]] ?? actions[badIdx]}）提问: "${seq.turns[badIdx].userNote}"`)
  }
  console.log('')
}
console.log(`命中率: ${totalHit}/${totalRuns}`)
process.exitCode = totalHit === totalRuns ? 0 : 1
