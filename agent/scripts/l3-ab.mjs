#!/usr/bin/env node
/**
 * L3 A/B 离线重放（2026-10-24）
 *
 * 拿 `data\config\l3-dump.json`（say() 抓下来的**某一轮真实输入**），把两条路径各跑一遍：
 *   A 旧路径 full   ：历史 + 画像 + 整条来路（l3Block）+ 本轮问题，一次调用
 *   B 新路径 tasks  ：R1 草稿 → 派课题 → R3 判父 → R4 汇总
 * 两条吃的是同一份输入，所以输出可以直接摆在一起看。
 *
 * 用法：
 *   node agent\scripts\l3-ab.mjs                  # 只看两份 messages 有多大（不花钱）
 *   node agent\scripts\l3-ab.mjs --live           # 真调 API，两边各跑一次
 *   node agent\scripts\l3-ab.mjs --live           # 真调 API，两边各跑一次
 *   node agent\scripts\l3-ab.mjs --file <别的 dump.json>
 *
 * 产物（都在 test\l3-ab\，不入库）：
 *   只看不跑 → <时间>-prompts.md   两边 messages 的全文（B 侧含每一步）
 *   --live   → <时间>.md           两边终稿 + 每次调用的 token 账
 *
 * ⚠️ 重放时缓存是冷的：这里比的是"**要发多少 token**"和"输出长什么样"，
 * 不是账单。线上命中率请看 node agent\scripts\usage-report.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_DIR, BOOKS_DIR, GRAPH_FILE, L3_DUMP_JSON, PROFILE_FILE, AGREEMENT_FILE, RUNTIME_DIR, CHAT_DB } from '../lib/paths.js'
import { openChatStore } from '../lib/chat-store.js'
import { resolveApiConfig, isConfigured } from '../lib/api-config.js'
import { readUsage } from '../lib/usage-log.js'
import { l3Block } from '../lib/l3-context.js'
import { userAncestry, userParents } from '../lib/knowledge-graph.js'
import { assembleCallHist } from '../lib/l3-driver.js'
import { runTasksPipeline } from '../lib/l3-tasks.js'
import { openL3Trace, localStamp } from '../lib/l3-trace.js'
import { openL3Tree } from '../lib/l3-tree.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(RUNTIME_DIR, 'l3-ab')   // 跑批产物放 runtime：删了不影响任何用户数据

const argv = process.argv.slice(2)
const has = (f) => argv.some((a) => a === f || a.startsWith(f + '='))
const argOf = (f) => {
  const eq = argv.find((a) => a.startsWith(f + '='))
  if (eq) return eq.slice(f.length + 1)
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : null
}
const LIVE = has('--live')
const dumpFile = argOf('--file') || L3_DUMP_JSON
const nodeArg = argOf('--node')
const questionArg = argOf('--question')
const nf = new Intl.NumberFormat('en-US')
const tok = (s) => Math.ceil((typeof s === 'number' ? s : String(s || '').length) * 0.62)   // 与 index.js 的 TOKEN_PER_CHAR 同源

/** 从会意图挑一个节点，把它自己的讨论问题当成"用户这一轮问的话"。
 *  为什么要这样造输入：线上先问 A 再问 B，两次的输入根本不同（历史在长），比不了。
 *  用节点自己的问题 + 把它当命中节点，两条路吃到的就是同一份输入，且都拿到了它的来路。 */
function inputFromNode(graph, want) {
  const hit = graph.nodes.find((n) => n.id === want) || graph.nodes.find((n) => n.id.startsWith(want))
  if (!hit) { console.error(`找不到节点 ${want}（可以先用 --list 看有哪些）`); process.exit(1) }
  const d = (hit.discussions || [])[0] || {}
  const question = String(d.question || '').trim()
  if (!question) { console.error(`节点 ${hit.id} 没有讨论问题`); process.exit(1) }
  const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  const titles = []
  try {
    for (const name of fs.readdirSync(BOOKS_DIR)) {
      try {
        const meta = JSON.parse(read(path.join(BOOKS_DIR, name, 'meta.json')))
        if (meta && meta.wereadBookId && meta.bookTitle) titles.push(String(meta.bookTitle).trim())
      } catch {}
    }
  } catch {}
  const bookSection = titles.length ? '\n\n【用户书籍足迹】（已添加引用/划线的书，用于跨书联想）\n' + titles.map((t) => `- 《${t}》`).join('\n') : ''
  const persona = '【背景档案】（用户画像 / 相处规则 / 书籍足迹的内容——不是用户本轮发言，只用于理解用户背景）\n\n'
    + `【用户画像】\n${read(PROFILE_FILE)}\n\n【相处规则】（用户对你（AI）的长期要求，请遵守）\n${read(AGREEMENT_FILE) || '（暂无）'}${bookSection}`
  const asked = String(questionArg || '').trim() || question
  return {
    conv: hit.id,
    question: asked,
    mode: 'ab-node',
    path: 'ab-node',
    hist: [],
    persona,
    // 与 index.js 的 anchored 同款模板：引文/旧知识点只是材料，回答以提问为准
    anchored: '【本轮消息】（上面历史与【背景档案】都只是背景——本行以下是用户当前要你直接回应的内容：含引文时，引文只是材料，回答以提问为准）\n'
      + `我想到我们之前聊过的「${hit.point}」——${question}`,
    hits: [hit.id],
    node: { id: hit.id, point: hit.point, question, excerpts: (d.excerpts || []).length },
  }
}

/** --list：把有来路的节点列出来（挑一个做对比用） */
function listNodes(graph) {
  const indeg = new Map()
  for (const e of graph.edges) if (e.kind === 'user') indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  const rows = graph.nodes
    .filter((n) => (n.discussions || []).length && indeg.get(n.id))
    .map((n) => ({
      id: n.id, point: n.point, inEdges: indeg.get(n.id),
      chars: (n.discussions[0].excerpts || []).reduce((s, e) => s + String(e.a || '').length, 0),
      q: String(n.discussions[0].question || ''),
    }))
    .sort((a, b) => b.chars - a.chars)
  console.log(`图里 ${graph.nodes.length} 个节点，其中有来路、可以直接拿来对比的 ${rows.length} 个：\n`)
  for (const r of rows.slice(0, 25)) {
    console.log(`${r.id}  来路 ${r.inEdges} 条｜原文约 ${nf.format(r.chars)} 字`)
    console.log(`  ${r.point}`)
    console.log(`  问：${r.q.slice(0, 60)}${r.q.length > 60 ? '…' : ''}\n`)
  }
}

/**
 * 图谱里的 q 是不是用户原话？用 8-字重合去 chat.db 里找那一条用户消息。
 * 找不到就说明这个 q 是建谱时**从 AI 的回答反推出来的**（不是原话，别拿它当"原话"用）。
 */
function findUserOriginalByAnswer(answerText) {
  const norm = (x) => String(x || '').replace(/[\s\p{P}]/gu, '')
  const a = norm(answerText).slice(0, 200)
  if (a.length < 20) return null
  let db
  try { db = openChatStore(CHAT_DB) } catch { return null }
  try {
    // 先认这条历史回答：用开头 200 字（去空白标点）里的 12-gram 在库里找
    const grams = []
    for (let i = 0; i + 12 <= a.length; i += 4) grams.push(a.slice(i, i + 12))
    let best = null
    let bestN = 0
    for (const row of db.db.prepare("SELECT id, conv, ts, content FROM messages WHERE role='assistant'").all()) {
      const c = norm(row.content)
      let k = 0
      for (const g of grams) if (c.includes(g)) k++
      if (k > bestN) { bestN = k; best = row }
    }
    if (!best || bestN < 3) return null
    // 再取它在同一对话里、时间在它之前的最后一条用户消息 = 当时那句原话
    const u = db.db.prepare(
      "SELECT id, conv, ts, content FROM messages WHERE role='user' AND conv = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
    ).get(best.conv, best.ts)
    return u ? { ...u, answerId: best.id } : null
  } catch { return null }
}

function dbContextBefore(conv, ts, { limit = 8, maxChars = 8000 } = {}) {
  let db
  try { db = openChatStore(CHAT_DB) } catch { return [] }
  try {
    const rows = db.db.prepare(
      'SELECT id, role, ts, content FROM messages WHERE conv = ? AND ts < ? ORDER BY ts DESC LIMIT ?',
    ).all(conv, ts, limit)
    const out = []
    let used = 0
    for (const r of rows) {
      const c = String(r.content || '')
      if (used + c.length > maxChars) break
      used += c.length
      out.unshift({ role: r.role, content: c })
    }
    return out
  } catch { return [] }
}





function findUserOriginal(q) {
  const norm = (x) => String(x || '').replace(/\[引用\][\s\S]*?\n\n/, '').replace(/[\s\p{P}]/gu, '')
  const t = norm(q)
  if (t.length < 8) return null
  const grams = []
  for (let i = 0; i + 8 <= t.length; i++) grams.push(t.slice(i, i + 8))
  let db
  try { db = openChatStore(CHAT_DB) } catch { return null }
  let best = null
  let bestN = 0
  try {
    for (const row of db.db.prepare("SELECT id, ts, content FROM messages WHERE role='user'").all()) {
      const c = norm(row.content)
      let k = 0
      for (const g of grams) if (c.includes(g)) k++
      if (k > bestN) { bestN = k; best = row }
    }
  } catch {}
  return bestN >= 3 ? { ...best, score: bestN } : null
}

/**
 * 图谱里的 q 是不是用户原话？用 8-字重合去 chat.db 里找那一条用户消息。
 * 找不到就说明这个 q 是建谱时**从 AI 的回答反推出来的**（不是原话，别拿它当"原话"用）。
 */

/**
 * 图谱里的 q 是不是用户原话？用 8-字重合去 chat.db 里找那一条用户消息。
 * 找不到就说明这个 q 是建谱时**从 AI 的回答反推出来的**（不是原话，别拿它当"原话"用）。
 */

// ── 输入 ─────────────────────────────────────────────────────────────────────
const graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'))
if (has('--list')) { listNodes(graph); process.exit(0) }

// ── 只重画：拿存好的事件重新渲染脑图/全过程（不调 API，改样式时用）──────────────
const eventsFile = argOf('--from-events')
if (eventsFile) {
  if (!fs.existsSync(eventsFile)) { console.error(`没有找到 ${eventsFile}`); process.exit(1) }
  const saved = JSON.parse(fs.readFileSync(eventsFile, 'utf8'))
  const base = path.basename(eventsFile).replace(/-事件\.json$/, '')
  const meta = saved.meta || {}
  const t = openL3Trace({ dir: OUT_DIR, stamp: `${base}-全过程`, meta: { ...meta, path: 'tasks' } })
  const tr = openL3Tree({ dir: OUT_DIR, stamp: `${base}-脑图`, meta: { ...meta, mdName: `${base}-全过程.md` } })
  for (const e of saved.events || []) { t.write(e); tr.write(e) }
  console.log(`脑图（重画）：${tr.file}\n全过程（重画）：${t.file}`)
  process.exit(0)
}

let dump
if (nodeArg && nodeArg.includes(',') && !has('--vs-history')) {
  const ids = nodeArg.split(',').map((x) => x.trim()).filter((id) => graph.nodes.some((n) => n.id === id))
  if (ids.length < 2) { console.error('--node a,b 至少要两个有效节点 id'); process.exit(1) }
  const q = String(questionArg || '').trim() || '(多节点测试)'
  dump = { conv: ids[0], question: q, anchored: `【本轮消息】\n${q}`, hist: [], persona: '', hits: ids }
  console.log(`【多命中】${ids.join('、')}`)
} else if (nodeArg) {
  dump = inputFromNode(graph, nodeArg)
} else {
  if (!fs.existsSync(dumpFile)) {
    console.error(`没有找到 ${dumpFile}\n两个办法：\n  ① --node <节点id>：直接拿会意图里的一个节点跑（--list 可以列）\n  ② 建一个空文件 data\\config\\l3-dump，照常在侧栏问一次引用到旧知识点的问题`)
    process.exit(1)
  }
  dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'))
}

// SYSTEM 必须是**同一份**：A/B 之间差别的只能是 L3 那一部分，不能连带把人格规则换掉。
// 构造规则与 index.js 的 buildSystemInstruction 一致（改那边记得改这里）。
const AGENT_RULES = fs.existsSync(path.join(AGENT_DIR, 'AGENT.md'))
  ? fs.readFileSync(path.join(AGENT_DIR, 'AGENT.md'), 'utf8')
  : ''
const PROFILE = fs.existsSync(PROFILE_FILE) ? fs.readFileSync(PROFILE_FILE, 'utf8') : ''
const AGREEMENT = fs.existsSync(AGREEMENT_FILE) ? fs.readFileSync(AGREEMENT_FILE, 'utf8') : ''
const SYSTEM = '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n' + AGENT_RULES
// 与 App 的 personaBlock() 同构：画像 + 相处规则走 messages 里的【背景档案】块，不进 system。
const PERSONA_BLOCK = '【背景档案】（用户画像 / 相处规则 / 书籍足迹的内容——不是用户本轮发言，' +
  '只用于理解用户背景；即使出现"自述/自陈/你说过"式表述，也不得转述或引用为用户原话）\n\n' +
  `【用户画像】\n${PROFILE}\n\n【相处规则】（用户对你（AI）的长期要求，请遵守）\n${AGREEMENT || '（暂无）'}`
// 与 index.js 的 JUDGE_SYSTEM 同一句（判定调用不带人格，避免记忆指令干扰格式）
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
// 必须在 PERSONA_BLOCK 初始化后再补全输入。
if (dump && !dump.persona) dump.persona = PERSONA_BLOCK

// --vs-history：拿节点里**第一个提问的原话**当当前提问，只跑新路径，
// 和**当时 AI 的原回答**对比（2026-10-25 用户定的测试法：不用再跑一遍旧 L3）。
const VS_HISTORY = has('--vs-history')
const VS_N = Math.max(1, Number((argOf('--vs-history') || '1').replace(/^=+/, '')) || 1)
let HIST_ANSWER = ''
let HIST_NODE = null
if (VS_HISTORY) {
  HIST_NODE = graph.nodes.find((n) => n.id === nodeArg)
  if (!HIST_NODE) { console.error(`没有这个节点：${nodeArg}`); process.exit(1) }
  const d = (HIST_NODE.discussions || [])[0] || {}
  const ex = d.excerpts || []
  const first = ex[VS_N - 1] || ex[0] || {}
  let q = String(first.q || d.question || '').trim()
  if (!q) { console.error(`节点 ${nodeArg} 的第 ${VS_N} 段讨论里没有用户提问原话`); process.exit(1) }
  HIST_ANSWER = String(first.a || '').trim()

  // 先用"这一轮的历史回答"去库里定位它对应的用户消息；那才是原话，图谱里的 q 可能是重建的
  const original = findUserOriginalByAnswer(String(first.a || '')) || findUserOriginal(q)
  if (original) {
    const clean = String(original.content).replace(/^\[引用\][\s\S]*?\n\n/, '').trim()
    if (clean.length >= 8 && clean !== q) {
      console.log(`【对照历史】图谱里的 q 与库里 #${original.id} 对得上，改用**用户原话**：${clean.slice(0, 80)}`)
      q = clean
    } else {
      console.log(`【对照历史】图谱里的 q 就是库里 #${original.id} 的用户原话`)
    }
  } else {
    console.log('【对照历史】⚠️ 库里找不到这一问的用户消息——图谱里的 q 是建谱时从 AI 回答反推出来的，不是原话')
  }

  // 上下文：图谱里这一问之前的轮次；没有的话（第一轮），从库里取它之前的对话
  const before = ex.slice(0, Math.max(0, VS_N - 1))
  const histMsgs = []
  for (const e of before) {
    if (e.q) histMsgs.push({ role: 'user', content: String(e.q) })
    if (e.a) histMsgs.push({ role: 'assistant', content: String(e.a) })
  }
  const dbHist = histMsgs.length ? [] : (original ? dbContextBefore(original.conv, original.ts) : [])
  if (dbHist.length) {
    console.log(`           之前上下文：图谱里没有，从库里补了 ${dbHist.length} 条（这一问之前的对话）`)
    for (const m of dbHist) histMsgs.push({ role: m.role, content: m.content })
  }

  // 回放这条提问时，当时存在的材料是它的**父节点**；用节点自己会循环（它的正文就是当年的回答）
  const parentsForHit = userParents(graph, nodeArg)
  const hitIds = parentsForHit.length ? parentsForHit : [nodeArg]
  if (parentsForHit.length) console.log(`           命中改为它的父节点 ${parentsForHit.length} 个：${parentsForHit.join('、')}（用节点自己就是拿答案当背景）`)
  else console.log('           ⚠️ 这个节点没有父节点，只能拿它自己当材料——这一轮的结果会带循环，别当结论用')
  dump = {
    conv: nodeArg,
    persona: PERSONA_BLOCK,
    question: q,
    anchored: `【本轮消息】\n${q}`,
    hist: histMsgs,
    hits: hitIds,
  }
  console.log(`【对照历史】用第 ${VS_N} 段讨论的提问当当前提问：${q}`)
  console.log(`           上下文 ${histMsgs.length} 条｜当时的 AI 回答 ${HIST_ANSWER.length} 字`)
}

const hist = (dump.hist || []).map((m) => ({ role: m.role, content: m.content }))   // id 是本地点位，不发出去
const hits = (dump.hits || []).filter((id) => graph.nodes.some((n) => n.id === id))


// ── A：旧路径 ────────────────────────────────────────────────────────────────
const ancestry = hits.length ? userAncestry(graph, hits) : []
const l3 = dump.l3 || (ancestry.length ? l3Block(ancestry) : '')
const messagesA = [{ role: 'system', content: SYSTEM },
  ...assembleCallHist({ hist, persona: dump.persona, l3, anchored: dump.anchored, mode: 'full' })]

// ── B：新路径（用真流水线，假模型只收 messages）───────────────────────────────
const stepsB = []
const stamp = localStamp()
const OUT = {
  compare: path.join(OUT_DIR, `${stamp.file}.md`),
  trace: `${stamp.file}-全过程`,
  tree: `${stamp.file}-脑图`,
}
/** 全过程记录 + 脑图（与 App 里是同一套渲染器；app 只在 l3-debug 打开时写，这里对拍就写） */
const question = String(dump.anchored || '').split('\n').pop()
const points = hits.map((id, i) => ({ kid: `K-${i + 1}`, point: (graph.nodes.find((n) => n.id === id) || {}).point || '' }))
const trace = openL3Trace({
  dir: OUT_DIR, stamp: OUT.trace,
  meta: { ts: stamp.human, conv: dump.conv, mode: 'A/B', path: 'tasks', points, question },
})
const tree = openL3Tree({
  dir: OUT_DIR, stamp: OUT.tree,
  meta: { conv: dump.conv, question, mdName: `${OUT.trace}.md` },
})
const emitEvents = []
const emitBoth = (e) => { try { emitEvents.push(e); trace.write(e); tree.write(e) } catch {} }

/** 干跑用的假模型：草稿/报告/派题都给"能往下走"的答案，好把每一步的提示词都印出来。 */
function dryModel() {
  const complete = async (o) => {
    stepsB.push({ kind: o.kind, messages: o.messages, system: o.system })
    if (o.kind === '课题草稿') return '【方向：示例方向】\n- 要点一\n没底：旧讨论里怎么说的'
    if (o.kind === '课题报告') return '关系：补充\n结论：（干跑：不生成结论）\n依据：无\n对应：示例方向\n缺口：（干跑：没写缺口）'
    if (o.kind === '课题派题') {
      const kids = [...String(o.messages[0].content).matchAll(/^(K-[\d.]+) 「/gm)].map((m) => m[1])
      return kids.slice(0, 2).map((k) => `${k}：那段材料里，有没有这件事的原文？`).join('\n') || '无'
    }
    throw new Error(o.kind)
  }
  const stream = async function* (o) { stepsB.push({ kind: 'R4 汇总', messages: o.messages }); yield { chunk: '', accumulated: '' } }
  return { complete, stream }
}
async function walkTasks(complete, stream) {
  stepsB.length = 0
  const it = runTasksPipeline({
    hist, persona: dump.persona, anchored: dump.anchored, hits,
    question: dump.question || '',
    question: dump.question || '',
    nodeOf: (id) => graph.nodes.find((n) => n.id === id) || null,
    parentsOf: (id) => userParents(graph, id),
    complete, stream, judgeSystem: JUDGE_SYSTEM,
    log: (m) => console.log(`  [B] ${m}`),
    onEvent: emitBoth,
    onRefusal: (rec) => console.log(`  [B] 🛑 ${rec.kid} 拒绝交付：${rec.why}｜节点 ${rec.nodeId}`),
    onRefusal: (rec) => console.log(`  [B] 🛑 ${rec.kid} 拒绝交付：${rec.why}｜节点 ${rec.nodeId}`),
    opts: {
      // 对拍时 B 的终稿不是"给用户看的那份"（A 才是），图上要标清楚
      finalLabel: 'B 新路径（这次没给用户看）', finalShown: false,
      ...(has('--force-ask') ? { forceAsk: true } : {}),
    },
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  return r.value || ''
}
/** A 的终稿不是流水线产出的，手工补一个"给用户看的"终稿事件 */
function noteAAnswer(text) {
  emitBoth({ type: 'final', label: 'A 旧路径（用户看到的就是这段）', text, coverage: [], shown: true })
}

// ── 真调 API ────────────────────────────────────────────────────────────────
async function chat({ messages, system, maxTokens = 2048, temperature, thinking }) {
  const cfg = resolveApiConfig()
  if (!isConfigured(cfg)) throw new Error('模型 API 未配置：先在侧栏「⋯ → 模型 API 配置」里填好')
  const { apiKey, apiBase, model } = cfg
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, ...messages].map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    // 与 index.js 同一条：机械调用关掉思考，否则 93% 的输出花在"想"上、耗时多 10 倍
    ...(thinking === false ? { thinking: { type: 'disabled' } } : {}),
    tool_choice: 'none',
  })
  const t0 = Date.now()
  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  })
  const raw = await resp.text()
  let data = null
  try { data = JSON.parse(raw) } catch {}
  const u = readUsage(data) || {}
  const msg = data?.choices?.[0]?.message || {}
  // 推理型模型：思考写在 reasoning_content，正文在 content。这里**只用 content**
  // （与 index.js 的流式一致：思考链绝不当作回复），但要把"正文为空、思考却有"说出来，
  // 否则表现就是"跑了 20 秒、零个字"，看不出是模型没吐正文还是解析坏了。
  const text = String(msg.content || '').trim()
  const reasoning = String(msg.reasoning_content || '').trim()
  if (!text && reasoning) console.log(`  ⚠️ 这次只出了思考链（${reasoning.length} 字）、没有正文——多半是 max_tokens 被思考吃光了`)
  return { text, ms: Date.now() - t0, usage: u, finish: data?.choices?.[0]?.finish_reason }
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true })

if (nodeArg && !questionArg) console.log('[提示] 没给 --question，当前提问用的是节点自己的问题——那是自问自答，看不出旧史料能不能支撑新提问')
console.log(`输入：${dumpFile}`)
console.log(`对话 ${dump.conv || '?'}｜命中 ${hits.length} 个${hits.length ? '：' + hits.join('、') : ''}｜历史 ${hist.length} 条`)
console.log(`A 旧路径 messages：${messagesA.length} 条｜${nf.format(messagesA.reduce((n, m) => n + m.content.length, 0))} 字符 ≈ ${nf.format(tok(messagesA.reduce((n, m) => n + m.content.length, 0)))} token`)
console.log(`  其中 L3 块 ${nf.format(l3.length)} 字符 ≈ ${nf.format(tok(l3))} token；来路 ${ancestry.length} 节点\n`)

if (!LIVE) {
  const m = dryModel()
  await walkTasks(m.complete, m.stream)
  let total = 0
  for (const s of stepsB) {
    const chars = s.messages.reduce((n, m) => n + m.content.length, 0)
    total += chars
    console.log(`  ${s.kind.padEnd(10)} ${nf.format(chars).padStart(8)} 字符 ≈ ${nf.format(tok(chars)).padStart(7)} token`)
  }
  console.log(`  合计（含重复的历史前缀，仅作体积参考）≈ ${nf.format(tok(total))} token`)
  const out = path.join(OUT_DIR, `${stamp.file}-prompts.md`)
  const parts = [`# L3 A/B · 只看提示词（${stamp.human}）`, `\n输入：\`${dumpFile}\`；命中：${hits.join('、') || '（无）'}\n`, '## A 旧路径 full\n']
  for (const m of messagesA) parts.push(`### ${m.role}（${nf.format(m.content.length)} 字符）\n\n\`\`\`\n${m.content}\n\`\`\`\n`)
  parts.push('\n## B 新路径 tasks\n')
  for (const s of stepsB) {
    parts.push(`### ${s.kind}（${s.system ? '判定 system' : '默认 system'}）\n`)
    for (const m of s.messages) parts.push(`#### ${m.role}（${nf.format(m.content.length)} 字符）\n\n\`\`\`\n${m.content}\n\`\`\`\n`)
  }
  fs.writeFileSync(out, parts.join('\n'))
  emitBoth({ type: 'note', text: '干跑（没有真调 API）：A 旧路径没有产出终稿；B 的每一格都是假模型走出来"形状"。' })
  console.log(`\n提示词已写到 ${out}`)
  console.log(`脑图（干跑版，看形状不花）：${tree.file}`)
  process.exit(0)
}

// --live：两边真跑
const ledger = []
const rec = (label, u, ms) => ledger.push({ label, input: u.input, hit: u.hit, miss: u.miss, output: u.output, ms })

// --vs-history 只跑新路径；其余模式两边都跑
let a = null
if (!VS_HISTORY) {
  a = await chat({ messages: messagesA.slice(1), system: SYSTEM, maxTokens: 8192 })
  rec('A 旧路径', a.usage, a.ms)
  noteAAnswer(a.text)   // 把 A 的终稿补进脑图（它不经过流水线，没有 final 事件）
  console.log(`A 完成：${a.text.length} 字，${(a.ms / 1000).toFixed(1)}s`)
} else {
  // 对照物是历史回答，不进流水线，只补一个 final 事件让图上能看到"当时是怎么答的"
  noteAAnswer(HIST_ANSWER)
  console.log(`A（对照）＝当时 AI 的原回答：${HIST_ANSWER.length} 字（不重跑旧路径）`)
}

const liveComplete = async (o) => {
  const r = await chat({ messages: o.messages, system: o.system ?? SYSTEM, maxTokens: o.maxTokens, temperature: o.temperature, thinking: o.thinking })
  rec(`B ${o.kind}`, r.usage, r.ms)
  return r.text
}
const liveStream = async function* (o) {
  // 与 index.js 的主回复同预算：8192（2048 会被推理模型的思考吃光，正文一个字都出不来）
  const r = await chat({ messages: o.messages, system: SYSTEM, maxTokens: 8192 })
  rec('B R4 汇总', r.usage, r.ms)
  yield { chunk: r.text, accumulated: r.text }
}
const bText = await walkTasks(liveComplete, liveStream)
console.log(`B 完成：${bText.length} 字`)

const sum = (k) => ledger.reduce((n, x) => n + (Number(x[k]) || 0), 0)
const rows = ledger.map((x) => `| ${x.label} | ${x.input ?? '—'} | ${x.hit ?? '—'} | ${x.miss ?? '—'} | ${x.output ?? '—'} | ${(x.ms / 1000).toFixed(1)}s |`).join('\n')
const out = OUT.compare
const aTitle = VS_HISTORY
  ? `## 当时 AI 的原回答（${HIST_ANSWER.length} 字，历史存档，没有重跑）`
  : `## A · 旧路径（full）——${a.text.length} 字`
const aBody = VS_HISTORY ? HIST_ANSWER : a.text
fs.writeFileSync(out, [
  `# L3 ${VS_HISTORY ? '新路径 vs 历史回答' : 'A/B 实跑'}（${stamp.human}）`,
  '',
  VS_HISTORY
    ? `节点：\`${nodeArg}\`｜用它的第一个提问原话当当前提问｜历史回答 ${HIST_ANSWER.length} 字`
    : `输入：\`${dumpFile}\`｜对话 ${dump.conv || '?'}｜命中 ${hits.join('、') || '（无）'}｜历史 ${hist.length} 条`,
  '',
  '## 用量',
  '',
  '| 调用 | input | hit | miss | output | 耗时 |',
  '|---|---|---|---|---|---|',
  rows,
  '',
  `合计：input ${nf.format(sum('input'))}｜output ${nf.format(sum('output'))}`,
  '',
  aTitle,
  '',
  aBody,
  '',
  `## 新路径（tasks）——${bText.length} 字`,
  '',
  bText,
  '',
].join('\n'))
console.log(`\n两边终稿 + 用量：${out}`)
console.log(`课题分包脑图：${tree.file}`)
console.log(`逐字全过程：${path.join(OUT_DIR, OUT.trace + '.md')}`)
// 把这一轮的事件原样存下来：以后只改"图怎么画"时，用 --from-events 重渲染就行，不用再花钱跑一遍
try {
  fs.writeFileSync(path.join(OUT_DIR, `${stamp.file}-事件.json`), JSON.stringify({
    meta: { ts: stamp.human, conv: dump.conv, question, points },
    events: emitEvents,
  }, null, 1))
  console.log(`事件（可重渲染）：${path.join(OUT_DIR, `${stamp.file}-事件.json`)}`)
} catch (e) { console.log(`（事件没存下：${e.message}）`) }
// 图是这次对拍的产物，跑完直接打开（不想开就只看上面两行路径）
if (tree.file && !has('--no-open')) {
  try {
    const { spawn } = await import('node:child_process')
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', tree.file], { stdio: 'ignore', detached: true }).unref()
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [tree.file], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}
