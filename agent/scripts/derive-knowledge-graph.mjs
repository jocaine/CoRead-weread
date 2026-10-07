#!/usr/bin/env node
/**
 * 会意图 · 真实数据演示：专题化讨论 → 固化（新建节点，节点不可变）；
 * 用户发言引用 → 引用解析（动作③）→ 建边；上下文填充（root→recent 路径）。
 *
 * 输入：agent/scripts/data/judge-real-results.json（discussions 数组，取带 question 的条目）
 * 输出（拆文件约定，2026-08-27 用户定调：**有效数据结果与测试辅助字段分开，不放同一文件，
 * 保持有效数据的数据结构完整**）：
 *   agent/scripts/data/knowledge-graph-results.json —— **有效数据**：会意图本体
 *     （真实讨论固化出的节点 + 真实判定产出的 derived 边，§5.3 结构完整、可直接加载）；
 *     不含模拟节点 n_current、不含模拟引用触发的 user 边。
 *   agent/scripts/data/knowledge-graph-demo.json —— **测试辅助**：simulation（模拟输入）、
 *     events（执行日志）、summary、错边纠正演示、上下文路径演示、demoOnly（演示在有效图上
 *     追加的模拟节点与 user 边）。有效图 + demoOnly = 演示完整状态。
 * 运行：
 *   node scripts/derive-knowledge-graph.mjs                  # fake 模式（确定性假 LLM，不碰网络）
 *   node --env-file-if-exists=.env scripts/derive-knowledge-graph.mjs --real   # 真实 API
 *
 * 机制演示（与设计文档 §5 一致）：
 * 1. 固化：每条收口讨论派生 point（狭隘范畴）+ 拾取被卸除的能指（aliases，重心在背景对象：
 *    自然指认的说法，多条合起来覆盖核心完整，不要标题腔），新建节点——**节点不可变**
 *    （2026-08-29 用户定调：去聚合判同，每次固化都新建，不并入、不追加、不改写）。
 * 2. 引用解析：模拟用户发言（引用旧知识点），命中多个节点 → 全部建边，无轻确认；
 *    命中只建边（引用短语只留在解析协议里，不存进边），不再抄录引用词进 aliases。
 * 3. 上下文填充：当前节点沿图的 root→recent 路径，多引用并集去重，不截断。
 * 4. 错边纠正：演示 removeEdge / updateEdge。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  createGraph,
  addNode,
  addEdge,
  removeEdge,
  updateEdge,
  contextOf,
  derivePoint,
  deriveAliases,
  resolveReferences,
} from '../lib/knowledge-graph.js'
import { completionOnce, MAX_JUDGE_TOKENS } from '../lib/llm-api.js'
import { DEVDATA_DIR } from '../lib/paths.js'   // 开发期数据的唯一真源（不进包）

// 输入与产物都在仓库根的 test\（2026-10 从 agent/scripts/data/ 挪出来）：
// 那些是作者的私人语料（真实讨论单元、评判结果、读书会意图谱），放在打包源目录隔壁
// 会被"整目录拷"捎带进发行包。详见 lib/paths.js 里 DEVDATA_DIR 的注释。
const DATA = path.join(DEVDATA_DIR, 'judge-real-results.json')
const OUT = path.join(DEVDATA_DIR, 'knowledge-graph-results.json')   // 有效数据
const OUT_DEMO = path.join(DEVDATA_DIR, 'knowledge-graph-demo.json') // 测试辅助
fs.mkdirSync(DEVDATA_DIR, { recursive: true })

const useReal = process.argv.includes('--real')

// ── callLLM：fake（确定性规则）或真实 API ─────────────────────────────────────
function makeFakeLLM() {
  return async (prompt, maxTokens = 512) => {
    // 按任务分派：提示词特征判断是哪个动作
    if (prompt.includes('归纳知识点表述')) {
      // derivePoint：取问题主干（去「为什么/为何」+ 尾部标点）作 point
      // （确定性规则；真实模式由 LLM 归纳狭隘范畴）
      const m = prompt.match(/讨论的具体问题："([^"]+)"/)
      const q = (m?.[1] || '未知').replace(/[？?。]$/, '')
      const stem = q.replace(/^(为什么|为何|到底|究竟)/, '').trim() || q
      return JSON.stringify({ point: stem })
    }
    if (prompt.includes('写可指认的说法')) {
      // deriveAliases：fake 规则——能指 = point + 讨论问题原文（带问号的标题形态）
      // （确定性规则；真实模式由 LLM 写讨论里展开过的背景事物及其内容）
      const pm = prompt.match(/条目 point："([^"]+)"/)
      const point = pm?.[1] || '未知'
      const qm = prompt.match(/讨论问题："([^"]+)"/)
      const q = (qm?.[1] || '').trim().slice(0, 40)
      const aliases = q ? [point, q] : [point]
      return JSON.stringify({ aliases })
    }
    if (prompt.includes('指认旧知识点的说法')) {
      // resolveReferences（全量精判断）：fake 规则——发言里存在 ≥5 字连续段
      // 是节点 point 的子串 → 命中（确定性规则；真实模式由 LLM 语义判定）
      const m = prompt.match(/用户发言："([^"]+)"/)
      const msg = m?.[1] || ''
      const nodes = [...prompt.matchAll(/^- (\S+)：「([^」]+)」/gm)].map((x) => ({ id: x[1], point: x[2] }))
      const grams = new Set()
      for (let i = 0; i + 5 <= msg.length; i++) grams.add(msg.slice(i, i + 5))
      const hits = nodes
        .filter((n) => n.point && [...grams].some((g) => n.point.includes(g)))
        .map((n) => n.id)
      return JSON.stringify({ hits })
    }
    throw new Error(`fake LLM：未知任务（${prompt.slice(0, 40)}）`)
  }
}

function makeRealLLM() {
  const API_KEY = process.env.COREAD_API_KEY
  const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
  const MODEL = process.env.COREAD_MODEL || 'gpt-4o'
  if (!API_KEY || !API_BASE) throw new Error('--real 模式需要 .env 配置 COREAD_API_KEY / COREAD_API_BASE')
  const SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
  // 真实 API 判定调用（lib/llm-api.js 统一实现：截断检测 + 预算升级重发，宁漏勿误）。
  // 升级后仍截断 → ⚠️ 失败串，judge 层重试；耗尽抛错 → 上层宁漏勿误（不建节点）。
  return async (prompt, maxTokens = 512) => {
    const r = await completionOnce({
      apiBase: API_BASE,
      apiKey: API_KEY,
      model: MODEL,
      system: SYSTEM,
      prompt,
      maxTokens,
    })
    if (!r.ok) return '⚠️ 输出被截断（finish_reason: length）'
    return r.text
  }
}

const callLLM = useReal ? makeRealLLM() : makeFakeLLM()
// 推理模型（deepseek-v4-flash）的 reasoning_content 占用大量 token：
// 2048 会被思考草稿耗尽、JSON 输出被截断（finish_reason: length）——引用解析
// 带候选节点全部上下文时必须给足预算（16384），派生/拾取能指等短判定 2048 即可。
// 截断由 lib/llm-api.js 统一兜底：自动升级到 16384 重发一次，仍截断 → ⚠️ 失败串（宁漏勿误）。
const depsPoint = { callLLM, maxTokens: MAX_JUDGE_TOKENS, attempts: 3, log: () => {} }  // point 带 excerpts 语境，推理模型需要大预算（d_14：4096 仍截断）
const depsAlias = { callLLM, maxTokens: 8192, attempts: 3, log: () => {} }  // 能指带全量讨论内容（不截取），陈述完整也可能输出更长，预算给足
const depsReference = { callLLM, maxTokens: 16384, attempts: 3, log: () => {} }

// ── 主流程 ────────────────────────────────────────────────────────────────────
const src = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
const discussions = src.discussions.filter((d) => d.question)
if (discussions.length === 0) {
  console.error('未找到带 question 的讨论，退出')
  process.exit(1)
}

const graph = createGraph()
const events = []
const discussionNode = new Map()   // discussion id → 节点 id（固化时填充，衍生关联用）

// 1. 固化：每条讨论 → 派生 point（题目层浅归纳）→ 拾取被卸除的能指 → 新建节点
//    （**节点不可变**，2026-08-29 用户定调：去聚合判同——不再判断"属于哪个已有节点"，
//    每次固化都新建；excerpts 交锋原文随讨论无损入库——档案无损原则，引用解析
//    精判断与后续上下文填充都依赖它；aliases——条目的备选称呼：自然指认的说法，
//    多条合起来覆盖核心完整，不要标题腔；2026-08-27 定调。引用命中只建边，不进 aliases）
const toDiscussion = (d) => ({
  question: d.question,
  book: d.book,
  chapter: d.chapter,
  excerpts: (d.excerpts || []).map((e) => ({ q: e.q, a: e.a })).filter((e) => e.q || e.a),
})

for (const d of discussions) {
  const { point } = await derivePoint(
    { question: d.question, excerpts: (d.excerpts || []).map((e) => ({ q: e.q, a: e.a })).filter((e) => e.q || e.a) },
    depsPoint,
  )
  const newId = `n_${d.id}`
  // 新建节点：拾取被卸除的能指（重心在背景对象），随节点入库（节点不可变，之后不再改）
  const { aliases } = await deriveAliases(
    { point, question: d.question, excerpts: (d.excerpts || []).map((e) => ({ q: e.q, a: e.a })).filter((e) => e.q || e.a) },
    depsAlias,
  )
  addNode(graph, { id: newId, point, aliases, discussion: toDiscussion(d) })
  discussionNode.set(d.id, newId)
  events.push({ event: 'aggregate', id: d.id, action: '新建', nodeId: newId, point })
}

// 1.5 衍生关联（拓扑边的第二条来源）：衍生判定发生在**分割（收口）动作内部**
//     ——group-discussions.mjs 在收口当前讨论时同步判定"后一条是否从前一条的思考中
//     衍生"（无显式引用句式也算），产出已写入 judge-real-results.json 的 derivations。
//     这里只消费其结果建边，不重新判定（分割已完成，事后补判时机不对）。
const derivations = Array.isArray(src.derivations) ? src.derivations : []
for (const dv of derivations) {
  const prevNode = discussionNode.get(dv.from)
  const nextNode = discussionNode.get(dv.to)
  if (!prevNode || !nextNode || prevNode === nextNode) continue   // 同节点无需边
  addEdge(graph, { from: prevNode, to: nextNode, kind: 'derived' })
  events.push({ event: 'edge', from: prevNode, to: nextNode, kind: 'derived', reason: dv.reason || '' })
}

// 2. 引用解析：模拟用户发言——用户用自己实际的口头称呼引用旧知识点
//    （「阶级分析的手术刀」「泵和阀」）→ 命中。**命中不建边**（2026-08-27 定调：
//    命中与建边解耦——会话中只取上下文，边在固化时当前讨论固化出节点后建）；
//    语义匹配（2026-08-29 加强）：内容线索与节点身份同一个知识点即可，能指词面
//    命中不是必要条件；内容线索是底线（空指不解析）
const simMessage = '我想到我们之前说的「阶级分析的手术刀」，还有「泵和阀」，为什么它们会走向完全不同的结果呢？'
// 节点材料只放条目身份（point + 能指 + 讨论过的问题），不放讨论原文
// （2026-08-27 用户定调：匹配靠能指接住自然说法，不需要读原文）
const nodeBriefs = graph.nodes.map((n) => ({
  id: n.id,
  point: n.point,
  aliases: n.aliases,
  questions: n.discussions.map((d2) => d2.question),
}))
const { hits } = await resolveReferences({ message: simMessage, nodes: nodeBriefs }, depsReference)

// 当前讨论：模拟"南美的工业化"讨论 → 新建节点（固化直建，节点不可变）
const currentId = 'n_current'
if (!graph.nodes.some((n) => n.id === currentId)) {
  addNode(graph, { id: currentId, point: '南美的工业化', discussion: { question: '为什么南美工业化走向不同？', book: '《拉丁美洲被切开的血管》' } })
}
for (const id of hits) {
  if (!graph.nodes.some((n) => n.id === id)) continue
  addEdge(graph, { from: id, to: currentId })
  events.push({ event: 'edge', from: id, to: currentId })
}

// 3. 上下文填充：当前节点 root→recent 路径（多引用并集去重，不截断）
const pathBefore = contextOf(graph, currentId)

// 3.5 拆文件：先拍有效数据快照（在纠正演示改动 graph 之前）——
//     有效图 = 真实讨论固化出的节点（无模拟节点 n_current）+ 真实判定产出的
//     derived 边（无模拟引用触发的 user 边）；demoOnly = 演示在有效图上追加的部分
const effectiveGraph = {
  nodes: graph.nodes.filter((n) => n.id !== currentId),
  edges: graph.edges.filter((e) => e.kind === 'derived'),
}
const demoOnly = {
  nodes: graph.nodes.filter((n) => n.id === currentId),
  edges: graph.edges.filter((e) => e.kind !== 'derived'),
}

// 4. 错边纠正演示：删掉第一条 **user 引用边**（衍生边是思考连续性证据，不演示删它），
//    再改第二条 user 边的目标（按 from+to 定位；同 pair 多条边全部删除/修改）
let corrected = null
const userEdges = graph.edges.filter((e) => e.kind !== 'derived')
if (userEdges.length > 0) {
  const first = userEdges[0]
  const removed = removeEdge(graph, { from: first.from, to: first.to })
  const second = userEdges[1]
  const updated = second ? updateEdge(graph, { from: second.from, to: second.to, newTo: currentId }) : 0
  corrected = { removed, updated }
}
const pathAfter = contextOf(graph, currentId)

const now = new Date().toISOString()
// ── 文件1：有效数据（会意图本体，§5.3 结构完整，可直接加载）──
const effectiveOut = {
  generatedAt: now,
  graph: effectiveGraph,
}
fs.writeFileSync(OUT, `${JSON.stringify(effectiveOut, null, 2)}\n`)

// ── 文件2：测试辅助（模拟输入 / 执行日志 / 演示产物）──
const demoOut = {
  generatedAt: now,
  mode: useReal ? 'real' : 'fake',
  source: 'agent/scripts/data/judge-real-results.json',
  note: '测试辅助文件：只含演示输入、过程与演示产物，不含有效数据。有效数据见 knowledge-graph-results.json；有效图 + demoOnly = 演示完整状态。',
  simulation: { message: simMessage, currentDiscussion: '南美的工业化（模拟）' },
  summary: { nodes: graph.nodes.length, edges: graph.edges.length, hits: hits.length },
  events,
  demoOnly,
  contextPath: pathBefore.map((n) => ({ id: n.id, point: n.point, aliases: n.aliases })),
  contextPathAfterCorrection: pathAfter.map((n) => ({ id: n.id, point: n.point })),
  corrected,
}
fs.writeFileSync(OUT_DEMO, `${JSON.stringify(demoOut, null, 2)}\n`)

// ── 控制台摘要 ────────────────────────────────────────────────────────────────
console.log(`模式：${useReal ? '真实 API' : 'fake（确定性假 LLM）'}`)
console.log(`输入：${discussions.length} 条专题化讨论`)
console.log(`固化结果：${effectiveGraph.nodes.length} 个有效节点（全部新建，节点不可变）＋ ${demoOnly.nodes.length} 个模拟节点`)
const derivedEdges = events.filter((e) => e.kind === 'derived')
console.log(`衍生关联：${derivedEdges.length} 条 derived 边（对话连续性，无显式引用）`)
for (const e of derivedEdges) console.log(`  · ${e.from} → ${e.to}（${e.reason.slice(0, 40)}）`)
const aliasTotal = graph.nodes.reduce((s, n) => s + (n.aliases?.length || 0), 0)
console.log(`能指：共 ${aliasTotal} 个 aliases（节点创建时拾取，平均每节点 ${(aliasTotal / Math.max(graph.nodes.length, 1)).toFixed(1)} 个）`)
console.log('')
console.log(`模拟用户发言："${simMessage}"`)
console.log(`引用解析：全量 ${graph.nodes.length} 节点精判断 → 命中 ${hits.length} 个节点（暂存，固化时建边）`)
for (const id of hits) {
  const node = graph.nodes.find((n) => n.id === id)
  console.log(`  · ${id}「${node?.point}」`)
}
console.log('')
console.log(`上下文路径（root→recent，${pathBefore.length} 个节点，不截断）：`)
for (const n of pathBefore) console.log(`  · ${n.id} ${n.point}`)
if (corrected) console.log(`\n错边纠正：删 ${corrected.removed} 条、改 ${corrected.updated} 条（纠正后路径 ${pathAfter.length} 个节点）`)
console.log(`\n有效数据：${OUT}（会意图本体，无测试辅助）`)
console.log(`测试辅助：${OUT_DEMO}（simulation / events / 演示产物）`)
