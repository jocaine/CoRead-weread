#!/usr/bin/env node
/**
 * 把 judge-real-cases.json 的判定结果按「一次专题化讨论」分组（threads 存放方式）。
 *
 * 输入：数据文件 judge-real-cases.json（纯数据，cases 忠实保留源结构）+ 结果文件
 *       judge-real-results.json（results 判专题化结论、sameResults 判同一性缓存）。
 * 分组用会意讨论栈状态机（topic-stack.js 的规则）跑真实消息时序：
 *   空栈 + 专题化 → 开新讨论；空栈 + 非专题化 → 忽略（ignored）
 *   非空栈 + 同一问题（判同一性）→ 累积入当前讨论
 *   非空栈 + 换问题 + 专题化 → 收口当前讨论，开新讨论；非专题化 → 忽略
 * 判同一性上下文 = 栈内「用户提问 + AI 回复」对话：每条入栈消息把自己的 AI 回复
 *   （chat_output 配对）作为 assistant 条目一起推进，判断"是否同一问题"时回复可见。
 * 判专题化结果复用结果文件的 results（不重复调用）；判同一性走真实 LLM，
 * 并把成功的判定写回 sameResults——可续跑：中途断（余额/网络）后重跑只补缺失的判同一性。
 * 判同一性结果与指令版本绑定（sameInstHash）：指令变了旧 sameResults 失效，全量重判。
 *
 * 关联键用 timestamp（源消息时间戳，跨重提取稳定）而非 id（重提取后 id 会移位）。
 *
 * 输出：结果文件新增 discussions（专题化讨论组，结构对齐 topic-library-design §5.2 threads：
 *   { id, book, chapter, openTs, open, question, excerpts:[{ id, q, sel?, t }] }）+ ignored + errors。
 *   question = 收口时把这次讨论追的具体问题归纳成一句（threads.question，见 lib/thread-question.js）。
 *   归纳结果按讨论栈哈希 + qInstHash 版本缓存（threadQuestions），重跑命中则零调用。
 * 写回前自动备份 RES + '.bak'。结果可重复运行：只依赖数据文件 + results（+ 已存 sameResults/threadQuestions）。
 *
 * 用法：npm run group:discussions
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeSameProblem, buildSameProblemInstruction } from '../lib/topic-stack.js'
import { consolidateThreadQuestion, buildQuestionInstruction } from '../lib/thread-question.js'
import { parseMessage, loadReplyByTs } from '../lib/chat-input.js'
import { reconstructTopicized } from '../lib/results.js'

// 判同一性结果与指令版本绑定：指令变了，旧 sameResults 失效（重新判定），否则缓存会掩盖口径变化。
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h.toString(36)
}
const INST_HASH = hashStr(buildSameProblemInstruction())
const Q_INST_HASH = hashStr(buildQuestionInstruction())  // 归纳问题指令版本（threads.question 缓存）

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.resolve(__dirname, './data/judge-real-cases.json')
const RES = path.resolve(__dirname, './data/judge-real-results.json')
const CHAT_IN = path.resolve(__dirname, '../../receiver/inbox/chat_input.jsonl')
const CHAT_OUT = path.resolve(__dirname, '../../receiver/inbox/chat_output.jsonl')

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
if (!API_KEY || !API_BASE) throw new Error('.env 缺少 COREAD_API_KEY / COREAD_API_BASE')

const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
async function callLLM(prompt, maxTokens = 512) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        tool_choice: 'none',
      }),
      signal: controller.signal,
    })
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`API ${resp.status}: ${raw.slice(0, 200)}`)
    const data = JSON.parse(raw)
    const msg = data.choices?.[0]?.message
    return (msg?.content || msg?.reasoning_content || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

const data = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
const prevRes = fs.existsSync(RES) ? JSON.parse(fs.readFileSync(RES, 'utf-8')) : {}
// AI 回复：从聊天流配对（全时间线，user 消息 ts → 紧邻 assistant 内容），excerpt 的 a 字段用
const replyByTs = loadReplyByTs({ inputPath: CHAT_IN, outputPath: CHAT_OUT })
// 关联键用 timestamp（源时间戳，重提取后 id 会移位但 timestamp 稳定）：
// 判专题化 verdict 看 results；判同一性已存结论看 sameResults；原文/派生解析看 cases
const caseById = new Map((data.cases || []).map((c) => [c.id, c]))
const parsedById = new Map((data.cases || []).map((c) => [c.id, parseMessage(c)]))
// 判专题化结论：judge 刚写的瞬态 results 优先；已被 group 消费掉则从分组输出（excerpts/ignored/errors 的 topicized）重建
const verdictByTs = Array.isArray(prevRes.results)
  ? new Map((prevRes.results || []).map((r) => [r.timestamp, r.topicized]))
  : reconstructTopicized(prevRes)
// 只在指令版本一致时复用缓存的判同一性；版本不一致则全部重新判定
const sameByTs = new Map()
if (prevRes.sameInstHash === INST_HASH) {
  for (const r of prevRes.sameResults || []) sameByTs.set(r.timestamp, r.same)
} else {
  console.log(`⚠️ 判同一性指令版本变化（${prevRes.sameInstHash || '无'} → ${INST_HASH}），缓存失效，全部重新判定\n`)
}
// 讨论组问题归纳（threads.question）缓存：按讨论栈内容哈希 + 指令版本。版本一致时命中复用，重跑零调用
const questionByKey = new Map()
if (prevRes.qInstHash === Q_INST_HASH) {
  for (const r of prevRes.threadQuestions || []) {
    if (r.stackKey && typeof r.question === 'string') questionByKey.set(r.stackKey, r.question)
  }
} else {
  console.log(`⚠️ 归纳问题指令版本变化（${prevRes.qInstHash || '无'} → ${Q_INST_HASH}），缓存失效，全部重新归纳\n`)
}

// 栈条目：判同一性上下文只读 content/selected，额外挂 _caseId 便于映射回原文
const toEntry = (c) => {
  const p = parsedById.get(c.id)
  return { role: 'user', content: p.note, ...(p.sel ? { selected: { text: p.sel } } : {}), _caseId: c.id }
}
// 该消息的 AI 回复 → assistant 栈条目（回复参与同一性判定）；无回复返回 null
const toAssist = (c) => {
  const a = replyByTs.get(c.timestamp)
  return a && a.trim() ? { role: 'assistant', content: a, _caseId: c.id } : null
}
const toMessage = (c) => {
  const p = parsedById.get(c.id)
  return { userNote: p.note, ...(p.sel ? { selected: { text: p.sel } } : {}) }
}
const toExcerpt = (c) => {
  const p = parsedById.get(c.id)
  // topicized 携带每条消息的判专题化结论：入组≠判专题化（承接同问题的延续消息可能不专题化）。
  // 它是结果文件里 results 数组的分布式替代，group 重跑靠它重建判专题化结论。
  // a = 该用户消息的 AI 回复（threads 的 excerpts 结构 {q, a, t} 对齐）。
  return { id: c.id, q: p.note, a: replyByTs.get(c.timestamp) || '', ...(p.sel ? { sel: p.sel } : {}), t: c.timestamp, topicized: verdictByTs.get(c.timestamp) === true }
}
const toIgnored = (c) => {
  const p = parsedById.get(c.id)
  return { id: c.id, timestamp: c.timestamp, a: replyByTs.get(c.timestamp) || '', ...p, topicized: false }
}

// 收口当前栈 → 讨论组（threads 风格：id + book + chapter + openTs + excerpts + question）
// question：收口时把这次专题化讨论追的具体问题归纳成一句（threads.question），按栈哈希缓存。
async function closeStack(stack, { open = false } = {}) {
  // 栈含 AI 回复（assistant 条目，_caseId 与它的 user 条目相同）：只取 user 出 excerpt，避免重复
  const userEntries = stack.filter((e) => e.role === 'user')
  const first = userEntries[0]
  const firstCase = caseById.get(first._caseId) || {}
  const excerpts = userEntries.map((e) => toExcerpt(caseById.get(e._caseId)))
  const thread = {
    id: `d_${discussions.length + 1}`,
    book: data.book,
    chapter: parsedById.get(first._caseId)?.chapter || '',
    openTs: firstCase.timestamp || first.t,
    open,
    excerpts,
  }
  // 具体问题由整栈归纳：closed 栈定格（哈希稳定 → 重跑命中缓存）；open 栈若后续增长，哈希变 → 重新归纳
  const stackKey = hashStr(excerpts.map((e) => e.t).join('|'))
  const cached = questionByKey.get(stackKey)
  if (cached) {
    thread.question = cached
  } else {
    try {
      const r = await consolidateThreadQuestion(stack, { callLLM, maxTokens: 384, attempts: 5, log: console.log })
      thread.question = r.question
      newlyQuestion.set(stackKey, r.question)
      console.log(`  ✓ ${thread.id} question: ${r.question.slice(0, 40)}${r.question.length > 40 ? '…' : ''}`)
    } catch (e) {
      questionFailures++
      console.log(`  ⚠️ ${thread.id} 归纳讨论问题失败: ${e.message}`)
    }
  }
  return thread
}

const discussions = []
const ignored = []
const errors = []
const sameById = new Map()  // 本次新判的同一性（写回用），与缓存合并
const newlyQuestion = new Map()  // 本次新归纳的讨论问题（写回用），与缓存合并
let questionFailures = 0  // 归纳讨论问题失败的讨论组数
let stack = []

console.log(`模型: ${MODEL} | 判同一性分组 ${data.cases.length} 条（判专题化复用已存 results）\n`)
for (let i = 0; i < data.cases.length; i++) {
  const c = data.cases[i]
  const topicized = verdictByTs.get(c.timestamp) === true

  if (stack.length === 0) {
    if (topicized) {
      stack = [toEntry(c), ...(toAssist(c) ? [toAssist(c)] : [])]
      console.log(`[${String(i + 1).padStart(3)}] 专题化 → 开新讨论 d_${discussions.length + 1}: ${parsedById.get(c.id).note.slice(0, 40)}…`)
    } else {
      ignored.push(toIgnored(c))
    }
    continue
  }

  let same = sameByTs.has(c.timestamp) ? sameByTs.get(c.timestamp) : null
  if (same === null) {
    try {
      const r = await judgeSameProblem(toMessage(c), stack, { callLLM, log: () => {} })
      same = r.same
      sameById.set(c.timestamp, same)   // 成功即记录，重跑不再调 API
    } catch (e) {
      errors.push({ id: c.id, timestamp: c.timestamp, note: parsedById.get(c.id).note, topicized, error: e.message })
      console.log(`[${String(i + 1).padStart(3)}] ⚠️ 判同一性失败（栈不变）: ${parsedById.get(c.id).note.slice(0, 40)}… (${e.message})`)
      continue
    }
  }

  if (same) {
    stack.push(toEntry(c), ...(toAssist(c) ? [toAssist(c)] : []))
  } else if (topicized) {
    const closed = await closeStack(stack)
    discussions.push(closed)
    stack = [toEntry(c), ...(toAssist(c) ? [toAssist(c)] : [])]
    console.log(`[${String(i + 1).padStart(3)}] 换问题 + 专题化 → 收口 ${closed.id}（${closed.excerpts.length} 条），开新讨论`)
  } else {
    ignored.push(toIgnored(c))
    console.log(`[${String(i + 1).padStart(3)}] 换问题 + 非专题化 → 忽略（${parsedById.get(c.id).note.slice(0, 40)}…）`)
  }
}
if (stack.length) discussions.push(await closeStack(stack, { open: true }))

const inDiscussions = discussions.reduce((n, d) => n + d.excerpts.length, 0)
// 合并缓存的归纳问题 + 本次新归纳的（缓存指令版本一致时，重跑只补新讨论组的）
const allQuestions = new Map([...questionByKey, ...newlyQuestion])
const threadQuestions = [...allQuestions].map(([stackKey, question]) => ({ stackKey, question }))
const groupSummary = {
  total: data.cases.length,
  discussions: discussions.length,
  inDiscussions,
  ignored: ignored.length,
  errors: errors.length,
  sameResults: sameByTs.size + sameById.size,
  threadQuestions: discussions.filter((d) => d.question).length,
  questionFailures,
  at: new Date().toISOString().slice(0, 10),
}
if (fs.existsSync(RES)) fs.copyFileSync(RES, RES + '.bak')  // 先备份，后写回
// 合并缓存的判同一性 + 本次新判的，统一 [{id, timestamp, same}]（写回结果文件）
const sameResults = (data.cases || [])
  .map((c) => {
    const same = sameByTs.get(c.timestamp) ?? sameById.get(c.timestamp)
    return same === undefined ? null : { id: c.id, timestamp: c.timestamp, same }
  })
  .filter(Boolean)
// results 是瞬态中间数据：group 消费完即从文件丢弃，判专题化结论由 discussions/ignored/errors 的 topicized 承担
const { results: _dropped, ...rest } = prevRes
fs.writeFileSync(
  RES,
  JSON.stringify({ ...rest, discussions, ignored, errors, sameResults, sameInstHash: INST_HASH, threadQuestions, qInstHash: Q_INST_HASH, groupSummary }, null, 2) + '\n',
  'utf-8',
)

console.log(`\n讨论组 ${discussions.length}（含 ${inDiscussions} 条专题化消息）| 忽略 ${ignored.length} | 判同一性失败 ${errors.length} | 归纳问题 ${threadQuestions.length}（失败 ${questionFailures}）`)
for (const d of discussions) {
  const briefs = d.excerpts.map((e) => e.q.length > 22 ? e.q.slice(0, 22) + '…' : e.q).join(' / ')
  console.log(`  ${d.id}${d.open ? ' [进行中]' : ''} [章${d.chapter}] (${d.excerpts.length}条) ${briefs}`)
}
console.log(`\n结果已写回: ${path.relative(process.cwd(), RES)}`)
