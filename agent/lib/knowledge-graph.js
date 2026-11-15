#!/usr/bin/env node
/**
 * 会意系统 · 会意图（有向图拓扑）：图结构 + 固化直建 + 引用解析（AI-0xx）
 *
 * 对应 topic-library-design.md §5（会意图：有向图拓扑）。问题意识交还给用户：
 * 系统不猜母题，只做两件狭隘范畴的事——判专题化（见 topicize.js / topic-stack.js）、
 * 引用解析（本文件）。节点之间的边只来自用户引用（"我想到我们之前说的X"）与
 * 同栈段间衍生（derived）。
 *
 * 本模块三部分：
 * 1. 图结构与操作（纯函数）：节点 node = 一次收口讨论组的固化（**不可变**——
 *    2026-08-29 用户定调：去聚合判同，每次固化都新建节点，建成后不再被系统修改；
 *    手动修正走 updateNodePoint / updateNodeAliases）；边 edge = 用户引用
 *    （from = 被引用的旧知识点，to = 当前讨论所在节点，kind 恒为 "user"）或
 *    段间衍生（kind = "derived"）。root = 无入边的节点；recent = 当前讨论所在节点。
 * 2. 路径上下文（contextOf）：取目标节点的 root→recent 路径（多目标并集、去重、
 *    按拓扑序 root 在前）。**本函数保留给离线工具/前端**——L3 上下文组装自 2026-10
 *    起改用 userAncestry（只走 user 入边，见下），不再走混合边的全祖先链。
 * 2.5 L3 来路闭包（userAncestry）：只沿 user 入边反向递归（"这条讨论当时引用过谁"），
 *    供 L3 上下文组装（§5.4④）。有界靠选择，不截断。
 * 3. 引用解析（resolveReferences，动作③）：用户发言里引用旧知识点时，找出指认
 *    旧知识点的说法并匹配节点。**纯 LLM 语义判定**（2026-08-27 定调：去掉字符串
 *    粗召回与覆盖判定；2026-08-29 加强：语义匹配——内容线索与节点身份是同一个
 *    知识点即可，能指词面命中不是必要条件；**内容线索是底线**——空指不解析，
 *    不惯着用户）。一次发言可命中多个节点；不需要用户轻确认；错边事后可删可改
 *    （removeEdge / updateEdge）。
 *
 * 输出协议（沿用 topicize.js 的成熟约定）：
 * - 引用解析：{"hits":["n_xxx","n_yyy"]}（命中的节点 id 列表，可为空）
 * - 不设 marker；解析复用 extractJsonObject（去围栏 + 全文 parse + 配平截取 fallback）。
 *
 * 实现要点（与 topicize.js 一致）：
 * - callLLM(prompt, maxTokens) 由调用方注入——模块不自己调模型。测试时插一个返回
 *   预设文本的函数即可，不碰网络、结果确定。
 * - 建议接入时固定低温度（temperature 0，判定任务要确定性）。
 * - 本模块不读写任何用户文件：纯判定 + 纯图操作。
 */

import { extractJsonObject } from './topicize.js'
import { buildConsolidatePrompt } from './discussion-text.js'

export const MAX_ATTEMPTS = 3

// ───────────────────────── 1. 图结构与操作（纯函数） ─────────────────────────

/**
 * 新建一张空图。
 * @returns {{nodes: Array, edges: Array}} 图 = { nodes: [{id, point, discussions[], createdAt, updatedAt}],
 *   edges: [{from, to, kind}] }（结构见 topic-library-design.md §5.3）
 */
export function createGraph() {
  return { nodes: [], edges: [] }
}

/**
 * 新建节点（固化直建，**节点不可变**，2026-08-29 用户定调：去聚合判同——
 * 每次收口讨论组固化成一个新节点，建成后不再被系统修改——不并入、不追加、
 * 不改写；手动修正走 updateNodePoint / updateNodeAliases）。discussion =
 * 一次专题化讨论 { question, book?, chapter?, excerpts? }。
 * aliases = 被卸除的能指（deriveAliases 的产物）：讨论里作为已知背景被带出的对象
 * 及其展开内容（point 管落点，aliases 管被卸下的能指——重心与 point 对称，
 * 2026-08-29 用户定调）；
 * 节点创建时生成一次。
 * @param {object} graph
 * @param {object} node { id, point, aliases?, discussion? }——新建时 point 必填
 * @returns {object} 新建的节点
 * @throws id 已存在 → TypeError（节点不可变，不聚合、不并入）
 */
export function addNode(graph, node) {
  if (!node || !String(node.id || '').trim()) {
    throw new TypeError('addNode: 需要 id')
  }
  const id = String(node.id).trim()
  if (graph.nodes.some((n) => n.id === id)) {
    throw new TypeError(`addNode: 节点已存在（${id}）——节点不可变，不聚合、不并入`)
  }
  const point = String(node.point || '').trim()
  if (!point) throw new TypeError('addNode: 新建节点需要 point')
  const now = Date.now()
  const created = {
    id,
    point,
    aliases: cleanAliases(node.aliases),
    discussions: node.discussion ? [normalizeDiscussion(node.discussion)] : [],
    createdAt: now,
    updatedAt: now,
  }
  graph.nodes.push(created)
  return created
}

// 去空、去重、保序
function cleanAliases(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const a of list) {
    const s = String(a || '').trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/**
 * 把**盘上图文件**里已存在节点的内容合回内存图（防"内存旧图覆盖外部修正"）。
 *
 * 为什么需要它：agent 启动时把整张图读进内存，之后只在自己收口时整份写回。
 * 于是任何**在这之间**对 GRAPH_FILE 的修改（回填书名、手工修 point、清理脚本）
 * 都会在下一次收口时被静默覆盖 —— 2026-11 一次书名回填就是这样被盖掉的，
 * 用户在图上看到"改了又变回去"。
 *
 * 规则：只合**两边都有的节点**，且以盘上那份为准。依据是节点不可变
 *（2026-08-29 用户定调：agent 只新建节点、从不改写已有节点，见 updateNodePoint 的注释），
 * 所以盘上那份只可能比内存新，不会更旧。内存里新加的节点、以及边，一律不动
 *（边由 agent 独占生成与清理，盘上的边被合进来会复活已删的冗余边）。
 *
 * @param {object} graph 内存图（会被就地修改）
 * @param {Array} diskNodes 盘上图文件的 nodes
 * @returns {number} 合入的节点数（0 = 盘上没变 / 无重叠）
 */
export function mergeNodeMetadata(graph, diskNodes) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(diskNodes)) return 0
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  let merged = 0
  for (const d of diskNodes) {
    if (!d || typeof d !== 'object' || !d.id) continue
    const cur = byId.get(d.id)
    if (!cur) continue
    if (JSON.stringify(cur) === JSON.stringify(d)) continue
    Object.assign(cur, d)
    merged++
  }
  return merged
}

/**
 * 更新节点 point（手动修正入口：固化后节点不被系统修改——无聚合、不改写，
 * 显式修正走这里）。
 * @param {object} graph
 * @param {string} id
 * @param {string} point 新 point（非空）
 * @returns {object|null} 更新后的节点；节点不存在返回 null
 */
export function updateNodePoint(graph, id, point) {
  const p = String(point || '').trim()
  if (!p) throw new TypeError('updateNodePoint: 需要非空 point')
  const n = graph.nodes.find((x) => x.id === id)
  if (!n) return null
  n.point = p
  n.updatedAt = Date.now()
  return n
}

function normalizeDiscussion(d) {
  if (!d || typeof d !== 'object') throw new TypeError('normalizeDiscussion: 需要 discussion 对象')
  const question = String(d.question || '').trim()
  if (!question) throw new TypeError('normalizeDiscussion: discussion 需要 question')
  return {
    question,
    book: String(d.book || '').trim(),
    chapter: String(d.chapter || '').trim(),
    excerpts: Array.isArray(d.excerpts) ? d.excerpts : [],
  }
}

/**
 * 建边：记录知识点之间的拓扑关系。两种来源（kind）：
 * - "user"：用户的显式引用（"我想到我们之前说的X"）
 * - "derived"：同一栈收口切出的相邻段之间无条件建立的对话连续性边（2026-10 用户
 *   定调：去 LLM 判定——同栈相邻段是思维连续链的机械产物，不替用户思考）
 * 2026-08-27 用户定调：**去掉 quote 字段**——追溯与删改触发均未实现，字段暂不落库；
 * 引用短语不落库、不进解析协议（协议只返回命中节点 id 列表，2026-08-29 加强后
 * 命中与建边解耦，边只记 from/to/kind）。
 * 2026-08-30（评审 P5）：**from/to 必须是图中已有节点**——不允许引用不存在的 id
 * 产生悬空边污染拓扑（调用方重复校验无害）。
 * @param {object} graph
 * @param {object} edge { from, to, kind? }——kind 默认 "user"
 * @returns {object} 新建的边
 */
export function addEdge(graph, edge) {
  const from = String(edge?.from || '').trim()
  const to = String(edge?.to || '').trim()
  if (!from || !to) throw new TypeError('addEdge: 需要 from 与 to')
  if (!graph.nodes.some((n) => n.id === from)) {
    throw new TypeError(`addEdge: from 节点不存在（${from}）——不允许悬空边`)
  }
  if (!graph.nodes.some((n) => n.id === to)) {
    throw new TypeError(`addEdge: to 节点不存在（${to}）——不允许悬空边`)
  }
  const e = {
    from,
    to,
    kind: edge.kind === 'derived' ? 'derived' : 'user',
  }
  graph.edges.push(e)
  return e
}

/**
 * 删边：按 from+to 精确删除（同 from→to 可能有多条边，全部删除）。
 * @param {object} graph
 * @param {object} edge { from, to }
 * @returns {number} 删除条数
 */
export function removeEdge(graph, edge) {
  const from = String(edge?.from || '').trim()
  const to = String(edge?.to || '').trim()
  const before = graph.edges.length
  graph.edges = graph.edges.filter((e) => e.from !== from || e.to !== to)
  return before - graph.edges.length
}

/**
 * 改边：把 (from,to) 的边改指向（同 from→to 的全部改）。
 * @param {object} graph
 * @param {object} edge { from, to, newFrom?, newTo? }
 * @returns {number} 修改条数
 */
export function updateEdge(graph, edge) {
  const from = String(edge?.from || '').trim()
  const to = String(edge?.to || '').trim()
  const newFrom = String(edge?.newFrom || '').trim()
  const newTo = String(edge?.newTo || '').trim()
  if (!newFrom && !newTo) throw new TypeError('updateEdge: 需要 newFrom 或 newTo')
  let count = 0
  for (const e of graph.edges) {
    if (e.from !== from || e.to !== to) continue
    if (newFrom) e.from = newFrom
    if (newTo) e.to = newTo
    count++
  }
  return count
}

/**
 * 按 id 找节点。
 * @returns {object|null}
 */
export function findNode(graph, id) {
  return graph.nodes.find((n) => n.id === id) || null
}

/**
 * 按 point 精确匹配节点（机械查找；语义匹配交给引用解析的 LLM 判定）。
 * @returns {Array<object>} 匹配的节点列表
 */
export function findNodesByPoint(graph, point) {
  const p = String(point || '').trim()
  if (!p) return []
  return graph.nodes.filter((n) => n.point === p)
}

/**
 * 判 fromId 是否能沿边到达 toId。
 *
 * 口径：边方向 = 引用方向（from = root 侧被引用节点，to = recent 侧引用节点），
 * root→recent 路径 = 脉络；能沿边从 X 到达 Y ⟺ X 是 Y 脉络上的较早节点。
 *
 * @param {object} graph
 * @param {string} fromId 起点节点 id
 * @param {string} toId   终点节点 id
 * @param {Array<string>} [kinds] 只允许走的边 kind（如 ['user']）；省略/空 = 全部 kind。
 *   **注意（2026-10）**：user 边的折叠判据必须传 `['user']`——L3 只沿 user 入边取来路，
 *   借道 derived 的"覆盖"关系对 L3 不再成立（详见 graph-consolidate.js 的折叠注释）。
 *   不传 kinds 的调用方（前端图视图/离线工具）保持"混合边"旧口径。
 * @returns {boolean} from === to 或任一节点缺失 → false；否则沿边 DFS 判可达
 */
export function isReachable(graph, fromId, toId, kinds) {
  const from = String(fromId || '').trim()
  const to = String(toId || '').trim()
  if (!from || !to || from === to) return false
  if (!findNode(graph, from) || !findNode(graph, to)) return false
  const allow = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null
  const stack = [from]
  const seen = new Set([from])
  while (stack.length) {
    const cur = stack.pop()
    for (const e of graph.edges) {
      if (e.from !== cur || seen.has(e.to)) continue
      if (allow && !allow.has(e.kind)) continue
      if (e.to === to) return true
      seen.add(e.to)
      stack.push(e.to)
    }
  }
  return false
}

/**
 * 热点节点：**被后来讨论反复引用**的节点，分三层取（2026-10 用户定调；供画像"他大致关心什么"做材料）。
 *
 * ⚠️ 口径（这里踩过一次坑，写清楚）：边的方向 = 引用方向，**from = 被引用的旧知识点，
 * to = 当前讨论所在节点**。所以"被引用"数的是**出边**（从该节点出发的 user 边）；
 * 入边是"它这场讨论引用了谁"，含义相反。只算 user 边——derived 是同一栈相邻段的机械产物，
 * 不代表用户回头引用。
 *
 * 三层：**门槛管质量、名额管数量**，两者分开才能各自独立调（嫌材料长只动名额，
 * 嫌选出来不够硬只动门槛）。
 *   · 超级招 super：**跨到 ≥superBooks 本不同的书** → 全录，不占名额、不设上限。
 *     依据是"多语境"，且**不依赖图的规模**（3 本就是 3 本，不会随节点变多而通胀）；
 *     严格程度自带数量控制，所以空着也是正常状态，不为了"能看到它工作"而放宽。
 *   · 统招 qualified：**跨书被引 ≥qualifierCross 次**，按排序取前 qualifierSlots。
 *     门槛管质量（"反复"而非"偶发一次"，跨书排除了同书内自循环），名额防膨胀。
 *   · 普招 general：其余按排序补 generalSlots 个。达线但没拿到统招名额的也在这里——
 *     它们排序更高，会优先被补进来，强信号不浪费。
 *
 * 排序键：**跨到几本书 → 跨书被引次数 → 总被引次数**（多语境广度优先，再看反复程度）。
 *
 * "跨到几本书" = 引用它的那些讨论所在的书里，**不属于它自己**的书有几个（集合去重，
 * 所以同一本外书里被引 3 次只算 1 本）。有一边没有 book 信息的边：计入总被引，
 * 不计入跨书/跨书数（保持中立，不误判成同书）。
 *
 * 不用"讨论轮次"：2026-10 用户定调——聊得多不等于在意。
 *
 * @param {object} graph 会意图
 * @param {object} [opts] { superBooks=3, qualifierCross=2, qualifierSlots=5, generalSlots=3 }
 * @returns {{super: Array, qualified: Array, general: Array, overflow: number}}
 *   条目为 { id, point, cited, crossEdge, crossBooks }；
 *   overflow = 达线却没拿到统招名额的个数（>0 说明门槛该往上调了，调用方据此写日志）
 */
export function hotNodes(graph, opts = {}) {
  const {
    superBooks = 3,
    qualifierCross = 2,
    qualifierSlots = 5,
    generalSlots = 3,
  } = opts
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : []
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const booksOf = (n) => new Set(
    ((n && n.discussions) || []).map((d) => String((d && d.book) || '').trim()).filter(Boolean),
  )

  const cited = new Map()      // 总被引
  const cross = new Map()      // 其中来自"别的书"的次数
  const foreign = new Map()    // 跨到的那些书（集合）
  for (const e of edges) {
    if (!e || e.kind === 'derived' || !e.from) continue
    cited.set(e.from, (cited.get(e.from) || 0) + 1)
    const fb = booksOf(byId.get(e.from))
    const tb = booksOf(byId.get(e.to))
    if (!fb.size || !tb.size) continue
    const out = [...tb].filter((b) => !fb.has(b))
    if (!out.length) continue
    cross.set(e.from, (cross.get(e.from) || 0) + 1)
    const s = foreign.get(e.from) || new Set()
    for (const b of out) s.add(b)
    foreign.set(e.from, s)
  }

  const rows = nodes
    .map((n) => ({
      id: n.id,
      point: String(n.point || ''),
      cited: cited.get(n.id) || 0,
      crossEdge: cross.get(n.id) || 0,
      crossBooks: (foreign.get(n.id) || new Set()).size,
    }))
    .filter((n) => n.cited > 0)
    .sort((a, b) =>
      b.crossBooks - a.crossBooks ||
      b.crossEdge - a.crossEdge ||
      b.cited - a.cited ||
      String(a.id).localeCompare(String(b.id)))

  const superSet = rows.filter((r) => r.crossBooks >= superBooks)
  const atLine = rows.filter((r) => r.crossBooks < superBooks && r.crossEdge >= qualifierCross)
  const qualified = atLine.slice(0, qualifierSlots)
  const chosen = new Set([...superSet, ...qualified].map((r) => r.id))
  const general = rows.filter((r) => !chosen.has(r.id)).slice(0, generalSlots)

  return { super: superSet, qualified, general, overflow: Math.max(0, atLine.length - qualified.length) }
}

// ───────────────────────── 2. 路径上下文（root → recent） ─────────────────────────

/**
 * 取目标节点的 root→recent 路径上下文（§5.4④）。
 *
 * 规则：沿入边反向收集目标的所有可达祖先（含自身，root = 无入边节点），
 * 多目标取并集去重，按拓扑序输出（root 在前，recent 在后）。
 * 不截断：路径上节点的内容全量返回（有界靠选择，不靠截断）。
 *
 * @param {object} graph
 * @param {string|Array<string>} targetIds 目标节点 id 或 id 列表（一次发言命中多个节点）
 * @returns {Array<object>} 按拓扑序排列的节点列表（并集、去重）
 */
export function contextOf(graph, targetIds) {
  const targets = (Array.isArray(targetIds) ? targetIds : [targetIds])
    .map((id) => String(id || '').trim())
    .filter((id) => id && findNode(graph, id))
  if (targets.length === 0) return []

  // 反向可达集：targets ∪ 所有祖先（沿入边）
  const seen = new Set(targets)
  const stack = [...targets]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of graph.edges) {
      if (e.to === cur && !seen.has(e.from)) {
        seen.add(e.from)
        stack.push(e.from)
      }
    }
  }
  const ids = [...seen]
  return topoSortNodes(graph, ids)
}

// 子图拓扑排序（Kahn）。边方向 = 引用方向（from 在前，to 在后），root 自然排最前。
// 出现环时（用户引用成环，理论上不应发生）降级为按 id 稳定序，保证不挂。
function topoSortNodes(graph, ids) {
  const idSet = new Set(ids)
  const adj = new Map()
  const indeg = new Map()
  for (const id of ids) {
    adj.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue
    adj.get(e.from).push(e.to)
    indeg.set(e.to, indeg.get(e.to) + 1)
  }
  const queue = [...ids].filter((id) => indeg.get(id) === 0)
  const order = []
  while (queue.length) {
    const cur = queue.shift()
    order.push(cur)
    for (const nxt of adj.get(cur)) {
      indeg.set(nxt, indeg.get(nxt) - 1)
      if (indeg.get(nxt) === 0) queue.push(nxt)
    }
  }
  const ordered = order.length === ids.length ? order : ids.slice().sort()
  return ordered.map((id) => findNode(graph, id)).filter(Boolean)
}

// ─────────────── 2.5 L3 来路闭包（user 入边，2026-10 定调） ───────────────

/**
 * L3 上下文可带的最大节点数（命中节点 + 来路）。命中节点一律保留，其余按跳数由近及远取。
 * user 边当前很稀疏（实测全图 40 条 / 104 节点，反向闭包通常 1~8 个节点），上限只是
 * 兜底：将来 user 边变密时防止闭包意外膨胀。
 */
export const L3_MAX_NODES = 12

/**
 * 取 L3 的"来路"闭包：沿 **user 入边** 反向递归。
 *
 * 方向语义（边的约定：from = 被引用的旧知识点，to = 当前讨论所在节点）：
 * - **user 入边**：这场讨论**当时引用了**哪些旧知识点 = 这个节点的**来路**（出身）。
 *   节点不可变 ⇒ 来路边在固化那一刻就定型，之后只减不增（只被冗余清理删除）。
 * - user 出边（去路）：后来别的讨论引用它才长出来的边。它不是这个节点的出身，是
 *   **那些下游节点的来路**；且随图增长而漂移 ⇒ L3 不走。
 * - derived 边（同栈相邻段）：段是判同一性切出来的"不可分割组"，**相邻两段按系统
 *   自己的判定就不是同一个问题**，只是同一场会话里先后问出来 ⇒ 不是承接对象，L3 不走。
 *
 * 2026-10 定调（此前实现走 contextOf 的 user+derived 混合全祖先链）：命中一个节点会把
 * 整条派生链连同链间 user 桥递归拖进来，实测 51 节点 / 29 万字，块尾落在一条与当前问题
 * 无关的旧讨论上，导致主回复答非所问（《大国大城》2026-09-26 实例）。改为只走来路后
 * 同一轮降到 8 节点 / 4.2 万字，块尾即本轮命中节点。
 *
 * @param {object} graph
 * @param {string|Array<string>} targetIds 本轮引用解析命中的节点 id
 * @param {object} [opts] { maxNodes?: number } 节点上限（默认 L3_MAX_NODES）
 * @returns {Array<{id: string, node: object, hops: number, hit: boolean}>}
 *   排序：来路跳数大→小在前，命中节点（hops=0）在最后——命中钉在块尾、紧贴本轮问题。
 *   目标全不存在 → 空数组。
 */
export function userAncestry(graph, targetIds, opts = {}) {
  const raw = Number(opts?.maxNodes)
  const maxNodes = Number.isInteger(raw) && raw > 0 ? raw : L3_MAX_NODES
  const targets = (Array.isArray(targetIds) ? targetIds : [targetIds])
    .map((id) => String(id || '').trim())
    .filter((id) => id && findNode(graph, id))
  if (targets.length === 0) return []

  const hop = new Map()
  for (const id of targets) hop.set(id, 0)
  let frontier = [...targets]
  let h = 0
  while (frontier.length) {
    h++
    const next = []
    for (const cur of frontier) {
      for (const e of graph.edges) {
        if (e.kind !== 'user' || e.to !== cur) continue
        if (hop.has(e.from) || !findNode(graph, e.from)) continue
        hop.set(e.from, h)
        next.push(e.from)
      }
    }
    frontier = next
  }

  let ids = [...hop.keys()]
  if (ids.length > maxNodes) {
    // 超上限：命中节点（0 跳）优先保留，其余由近及远；同跳按 id 稳定序
    ids = ids
      .slice()
      .sort((a, b) => (hop.get(a) - hop.get(b)) || (a < b ? -1 : 1))
      .slice(0, maxNodes)
  }
  const hitIdx = new Map(targets.map((id, i) => [id, i]))
  return ids
    .map((id) => ({ id, node: findNode(graph, id), hops: hop.get(id), hit: hop.get(id) === 0 }))
    .sort((a, b) => (b.hops - a.hops) || ((hitIdx.get(a.id) ?? -1) - (hitIdx.get(b.id) ?? -1)))
}

/**
 * 取一个节点的**直接**来路（user 入边的 from）：这条讨论当时引用了哪些旧知识点。
 *
 * 与 userAncestry 的区别只有一层：那边递归取整条闭包（L3 旧路径一次全扒进来），
 * 这边只给"上一层"——L3 新路径（lib/l3-tasks.js）要一层一层判"值不值得再追"，
 * 一次只肯为下一层花一次调用。方向语义与 userAncestry 同一套（见那里的注释）：
 * 只走 user 入边，不走 derived（同栈相邻段不是承接对象），不走 user 出边（去路会漂移）。
 *
 * @param {object} graph
 * @param {string} nodeId
 * @returns {string[]} 父节点 id（去重，按 edges 里的出现顺序）；节点不存在 → []
 */
export function userParents(graph, nodeId) {
  const id = String(nodeId || '').trim()
  if (!id) return []
  const out = []
  for (const e of graph.edges || []) {
    if (e.kind !== 'user' || e.to !== id) continue
    if (out.includes(e.from)) continue
    if (!graph.nodes.some((n) => n.id === e.from)) continue
    out.push(e.from)
  }
  return out
}

// ───────────────────────── 3. 旧版 point / aliases 辅助函数 ─────────────────────
// 正式收口已改用 retrieval-descriptions.js；以下接口仅兼容旧离线脚本。


export function buildPointInstruction() {
  return [
    '你是 CoRead 的「会意系统」，为本段收口讨论生成核心表述 point，用于展示及后续语义检索。',
    '用一句可独立理解的描述，说清主要对象、必要语境和真正追问的机制、条件、关系或分歧，不只列关键词。',
    '以用户持续追问、修正和反驳的问题确定重心，不以 AI 回答的篇幅或语气决定重心。',
    '保留区分本次讨论所必需的具体对象、比较项和否定条件：删掉后会变成另一个问题，就必须保留；不要为了抽出机制卸掉这些信息。',
    '例如「中国历史未孕育出哥萨克式角色的条件与机制」比「社会角色的形成机制」更明确；「顿河流通券信用与发行政权存亡的关系」比「货币与政治」更明确。例子只示范表达方式，不提供本段事实。',
    '有核心矛盾或分歧就保留，没有则不强造；不拔高成母题，不把所有侧面都塞进 point。',
    '保留观点归属、否定和不确定程度：用户反驳过的解释不能当作共同结论；AI 单方面提出的解释不能当作用户接受的理解；未解决的问题保持开放，不擅自补答案。',
    '所有内容依据本段材料，不引入外部知识；不用「这个」「他」「上述」省略必要对象。',
    '只输出一行 JSON：{"point":"本段讨论的核心表述"}，point 必须是非空字符串。',
  ].join('\n')
}

/**
 * 组装派生 point 的判定材料：讨论的具体问题 + 可选讨论内容（excerpts）。
 * 表达清楚所需的语境（"苏联水兵在革命中""货币与政权的矛盾"）常藏在讨论内容里，
 * 不在 question 字面——提供 excerpts 让 LLM 从真实讨论中取语境，而不是瞎猜。
 * @param {object} input { question: string, excerpts?: Array<{q, a}> }
 */
export function buildPointPrompt(input) {
  const question = String(input?.question || '').trim()
  const excerpts = Array.isArray(input?.excerpts) ? input.excerpts.filter((e) => e?.q || e?.a) : []
  // 2026-10 结构定调：公共前缀 + 段全文（全量，point 改吃全文语境——矛盾结构常在中段）
  // + 任务尾（question 锚 + 语境纪律 + 指令）。全文与归纳/能指同字节前置，命中同一缓存前缀。
  const tail = [
    `讨论的具体问题："${question}"`,
    '',
    '注意：point 的语境必须来自上面的讨论内容，不许发明讨论里没有的背景。',
    '',
    buildPointInstruction(),
  ].join('\n')
  return buildConsolidatePrompt(excerpts, tail)
}

/**
 * 从 LLM 回复里提取 point：{"point": string}。
 * 内容有效性（2026-08-28 机制级修复，d_14 point="..." 教训）：不只查非空——
 * 截断产物/思考草稿里"碰巧"抠出的 JSON 可能是占位残片，必须校验实质内容。
 * @returns {{point: string}|null}
 */
export function parsePointResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (typeof d.point !== 'string') return null
  const point = d.point.trim()
  // 有效性：非空（已有）+ 不是占位残片（纯省略号/纯标点/过短）。宁漏勿误：
  // 拦下垃圾 point 只是少建一个节点，放行垃圾会污染知识图谱。
  if (!point) return null
  if (point.length < 2) return null                                   // 过短（"…"、"。"）
  if (/^[.…。·、，,;；:：!！?？~～\-—"'""'（）()\s]+$/.test(point)) return null  // 纯标点/省略号残片
  return { point }
}

/**
 * 派生 point 主入口：讨论的具体问题 → 知识点狭隘范畴表述。
 * @param {object} input { question: string }
 * @param {object} deps { callLLM 必填, maxTokens?, attempts?, log? }
 * @returns {Promise<{point: string, attempts: number}>}
 * @throws 内容缺省 / 未注入 callLLM → TypeError；重试耗尽仍无有效判定 → Error
 */
export async function derivePoint(input, deps = {}) {
  const question = String(input?.question || '').trim()
  if (!question) throw new TypeError('derivePoint: 需要讨论的具体问题（question）')
  if (typeof deps.callLLM !== 'function') {
    throw new TypeError('derivePoint: 必须注入 callLLM(prompt, maxTokens)')
  }
  const { callLLM, maxTokens = 16384, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  const basePrompt = buildPointPrompt(input)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验。请重新输出：只给最终一行 JSON，不要任何推理或额外文字。`
    const text = await callLLM(prompt, maxTokens)
    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`derivePoint LLM 返回失败串：${out.slice(0, 60)}`)
      continue
    }
    const parsed = parsePointResult(out)
    if (parsed) {
      log(`  ✓ 派生 point（attempt ${attempt + 1}）：${parsed.point}`)
      return { point: parsed.point, attempts: attempt + 1 }
    }
    log(`  ⚠️ derivePoint 第 ${attempt + 1} 次校验未通过（${out.slice(0, 60)}），重试...`)
  }
  throw new Error(`derivePoint ${attempts} 次尝试后仍无有效判定`)
}

// ───────────────────────── 3.5 能指（aliases：捡回被卸除的能指） ─────────────────────────


export function buildAliasInstruction() {
  return [
    '你是 CoRead 的「会意系统」，为本段讨论生成补充检索描述 aliases，每条是可独立理解的一个重要侧面，用于语义检索。',
    'point 已表达核心问题；aliases 只补充它没有覆盖、但本段深入展开且有独立检索价值的侧面，不穷尽所有可以总结成知识点的内容。',
    '先筛重要性：用户持续追问、反驳、修正或补充过，或后续推理实质依赖的侧面优先；偶然提到的人物、顺手举例和一次性术语解释不单列。',
    '再筛检索价值：用户将来是否可能从这个侧面想起本次讨论？只换说法重复 point 或其他条目的，舍弃或合并。',
    '根据各侧面的实质讨论篇幅和推进程度分配条数：短讨论通常少写，长讨论只有多个重要侧面真正展开时才增加；不要按字数机械凑数，不把 AI 单次长篇解释当作重要性的证明。',
    '每条写清具体对象和讨论展开的关系、问题或观点；不写孤立关键词，不依赖其他条目才能理解，不以「它」「上述」省略必要对象。',
    '保留观点归属、否定、分歧和不确定程度：AI 提出但用户未接受的解释不能写成共同结论；被反驳的解释可以作为检索侧面，但须写明质疑或反驳。',
    '只写本段实际讨论的内容，不引入外部知识。没有重要且独立的补充侧面时返回空数组，不为凑数生成。',
    '只输出一行 JSON：{"aliases":[]}；有补充时 aliases 为字符串数组，每条一个侧面。',
  ].join('\n')
}

/**
 * 组装拾取被卸除的能指的判定材料：条目 point + 讨论问题 + **全部讨论内容（excerpts，
 * 不截取）**。被卸除的能指（背景对象及其展开内容）都在讨论原文里——提供全量
 * 交锋原文，不许截断；展开过几个背景面也从中取，不许发明讨论里没有的面。
 * @param {object} input { point: string, question?: string, excerpts?: Array<{q, a}> }
 */
export function buildAliasPrompt(input) {
  const point = String(input?.point || '').trim()
  const question = String(input?.question || '').trim()
  const excerpts = Array.isArray(input?.excerpts) ? input.excerpts.filter((e) => e?.q || e?.a) : []
  // 2026-10 结构定调：公共前缀 + 段全文（全量，不截取）+ 任务尾（point/question 锚 + 指令）。
  // 全文与归纳/point 同字节前置，命中同一缓存前缀。
  // 2026-10 覆盖修复：长判据被压到全文之后会降低"覆盖展开面"的遵从（实测条数减半、丢
  // 文本锚面）——任务尾开头加一条浓缩要点（内容与判据正文重复，重复在文后正是为加强遵从）。
  const tail = [`条目 point："${point}"`]
  if (question) tail.push(`讨论问题："${question}"`)
  tail.push('', buildAliasInstruction())
  return buildConsolidatePrompt(excerpts, tail.join('\n'))
}

/**
 * 从 LLM 回复里提取能指（aliases）：{"aliases": [string, ...]}。
 * 去空去重；允许明确返回空数组，非空输入清洗后全为空则仍判失败。
 * @returns {{aliases: Array<string>}|null}
 */
export function parseAliasesResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (!Array.isArray(d.aliases) || d.aliases.some((a) => typeof a !== 'string')) return null
  const cleaned = cleanAliases(d.aliases)
  if (d.aliases.length && !cleaned.length) return null
  return { aliases: cleaned }
}

/**
 * 派生被卸除的能指主入口：point + 讨论内容（全量）→ 能指数组（数量不限）。
 * 2026-11：只保留重要且有独立检索价值的侧面，不穷尽背景内容；无补充可返回空数组。
 * 节点创建时调用一次（固化直建，节点不可变，不再有聚合并入路径）。
 * @param {object} input { point: string, question?: string, excerpts?: Array<{q, a}> }
 * @param {object} deps { callLLM 必填, maxTokens?, attempts?, log? }
 * @returns {Promise<{aliases: Array<string>, attempts: number}>}
 * @throws 内容缺省 / 未注入 callLLM → TypeError；重试耗尽仍无有效判定 → Error
 */
export async function deriveAliases(input, deps = {}) {
  const point = String(input?.point || '').trim()
  if (!point) throw new TypeError('deriveAliases: 需要条目 point')
  if (typeof deps.callLLM !== 'function') {
    throw new TypeError('deriveAliases: 必须注入 callLLM(prompt, maxTokens)')
  }
  const { callLLM, maxTokens = 2048, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  const basePrompt = buildAliasPrompt(input)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验。请重新输出：只给最终一行 JSON，不要任何推理或额外文字。`
    const text = await callLLM(prompt, maxTokens)
    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`deriveAliases LLM 返回失败串：${out.slice(0, 60)}`)
      continue
    }
    const parsed = parseAliasesResult(out)
    if (parsed) {
      log(`  ✓ 拾取被卸除的能指（attempt ${attempt + 1}）：${parsed.aliases.join('；')}`)
      return { aliases: parsed.aliases, attempts: attempt + 1 }
    }
    log(`  ⚠️ deriveAliases 第 ${attempt + 1} 次校验未通过（${out.slice(0, 60)}），重试...`)
  }
  throw new Error(`deriveAliases ${attempts} 次尝试后仍无有效判定`)
}

/**
 * 改写节点能指（aliases，可删可改——用户审阅时收窄/增补；整表替换，不增量合并；
 * 与 updateNodePoint 同级的手动入口，§5.5 维护操作）。
 * @param {object} graph
 * @param {string} nodeId
 * @param {string|string[]} aliases 新能指表（去空去重）
 * @returns {object|null} 更新后的节点；节点不存在返回 null
 */
export function updateNodeAliases(graph, nodeId, aliases) {
  const n = graph.nodes.find((x) => x.id === nodeId)
  if (!n) return null
  n.aliases = cleanAliases(aliases)
  n.updatedAt = Date.now()
  return n
}

// ───────────────────────── 3. 引用解析（动作③） ─────────────────────────

/**
 * 引用解析的判据提示词（topic-library-design.md §5.4③ + topic-library-ops.md §3）。
 * 一次发言可命中多个节点；命中即建边，不需要用户轻确认；未命中不建边。
 * 匹配依据含节点 aliases（被卸除的能指，deriveAliases 在节点创建时生成）——
 * 用户可能用对话内部的词引用，而不是收口问题。
 *
 * 2026-08-29 判据修订（用户定调：去节点合并、引用解析加强）：
 * - 加强：语义匹配——说法的内容线索与节点身份是同一个知识点即可，能指词面命中
 *   不再是必要条件（描述性指认可解析）。
 * - 底线：内容线索必须有——纯指示代词 / 纯时间指代（不透露指认哪个知识点的空指）
 *   不解析，不惯着用户。
 * - 防误保留：指认意图（恰好提到的偶然词不算引用）、宁漏勿误、不许发明。
 */
export function buildReferenceInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在执行动作③「引用解析」：在用户发言中找出指认旧知识点的说法，并匹配到已有节点。',
    '',
    '引用 = 用户提到之前聊过的知识点（例："我想到我们之前说的『苏联的工业化史』""前面聊过的『哥萨克的身份政治』""上次说的那个北欧模式"）。',
    '',
    '判定标准：',
    '- 找出发言中所有指认旧知识点的说法并匹配到节点（找引用和匹配是一件事）：一个说法被判定为指认旧知识点，当且仅当它同时满足下面三点——',
    '  ① 触发方式（两条路，命中其一即可）：',
    '     显式 · 指认性表述：用户用指认性表述提到之前聊过的知识点（"之前/上次/我们聊过/那个……"）；只是恰好提到相关词、没有指认意图的，不按显式算。',
    '     隐式 · 说的就是那件事：用户没说"之前"，但这一问**主张/追问的那个说法**就是某个节点的话题——'
      + '问的是那件事本身，而不是顺带提了一个词。判据：把这一问的说法（它主张什么、在追问哪种判断）抽出来，'
      + '与节点 point/能指的说法比对；对得上 → 命中；主题是别的事、只是句中出现了相关词 → 不命中'
      + '（2026-10-21 用户定调：显式与隐式都算触发；节点的身份是一个**说法/命题**，不是单个名词，'
      + '所以比对的是说法，不是关键词）。',
    '  ② 内容线索（底线）：说法透露了指认的是哪个知识点的信息——能指词（point/aliases/讨论过的问题里的词）、话题词、或对讨论内容的描述；纯指示代词（"上次那个""那个问题"）或纯时间指代（"就和我们上次聊的一样"）没透露任何线索 → 不解析、不匹配。',
    '  ③ 语义匹配：线索与节点身份是同一个知识点（例："苏联工业化" 与节点「苏联的工业化史」是同一个；"聊过的那个货币和政权信用的事" 与节点「顿河流通券信用背后的政权存亡逻辑」是同一个）——允许同义、简称、换表述、话题描述、概括转述，能指词面命中不是必要条件。复述结论/立场/转变也算命中（2026-09 修订）：用户用指认性表述（"我之前和你提过的""上次说的""我们聊过的"）复述之前讨论中得出的结论、立场、转变或做法，即使措辞与节点完全不同，只要内容线索能对应某节点 point/能指描述的话题，也应判定命中。例："这也是我之前和你提过的我的转变——摒弃启蒙的思想" 与节点 n_d_xue_4 的能指"能做的是\'启蒙以外\'的工作：共同性+物质性"是同一个知识点（都是"不对他人做启蒙式教导、做启蒙以外的工作"）。',
    '- 匹配必须逐条通读每个节点的"能指"（aliases）全文：大量结论性说法只存在于能指里、不在 point 中（例：n_d_xue_4 的 point 是"阶级关系定位"，"启蒙以外的工作"只在能指里）。不能只盯着 point 找词面或语义对应。',
    '- 一次发言可指认多个，全部找出，不要只取第一个。',
    '- 未命中：说法匹配不上任何节点（用户可能记错、节点尚未建立、或线索不属于任何节点）→ 不输出该条。',
    '- 宁漏勿误（校准）：只适用于无线索的空指/模糊指代（纯"那个""上次说的"）——这类不输出。有明确指认性表述且内容线索能对应某节点 point/能指的话题域时，应倾向命中而不是漏掉；拿不准时比较该节点能指与线索的话题重合度，重合即命中。',
    '- 不许发明：nodeId 只能取节点列表里实际出现的 id。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"hits":["n_xxx","n_yyy"]}',
    '字段：hits 数组（可为空），元素 = 命中的节点 id（列表里实际出现的）。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

/**
 * 组装引用解析判定材料：用户发言 + 节点列表（id + point + aliases + 节点内 question）。
 * **不放讨论原文（excerpts）**（2026-08-27 用户定调）：匹配只依据条目的身份——
 * point（收口问题归纳）、aliases（被卸除的能指——节点创建时从全量讨论派生的
 * 背景内容说法，引用短语已收进能指）、节点内讨论过的问题。引用短语能否指认条目
 * 就靠这三样，不需要读原文；提示词因此大幅变小（全量节点判定可行）。
 * @param {object} input { message: string, nodes: [{id, point, aliases?, questions?}] }
 *   discussions: 忽略（不渲染）——节点材料不含讨论原文
 */
export function buildReferencePrompt(input) {
  const message = String(input?.message || '').trim()
  const nodes = Array.isArray(input?.nodes) ? input.nodes : []
  // 顺序（2026-09 缓存定调）：指令 → 节点列表 → 用户发言在**最后**。
  // 前缀缓存按"从头连续相同"命中：节点列表是静态大头（55 节点全量），用户发言
  // 每次必变——发言在前会让断点提前、节点列表全失配（实测 0%）；发言在最后则
  // 节点列表全命中（实测 92%+）。与判同一性等判定的"材料在前、问题在后"一致。
  const lines = [buildReferenceInstruction(), '', '知识点节点：']
  if (nodes.length === 0) {
    lines.push('（无）——输出 {"hits":[]}')
  } else {
    for (const n of nodes) {
      // 新节点只用统一描述匹配；point 是展示标题，避免把旧标题的结论再当索引。
      if (Array.isArray(n.descriptions)) {
        lines.push(`- ${n.id}：检索描述：${JSON.stringify(n.descriptions)}`)
        continue
      }
      const al = Array.isArray(n.aliases) && n.aliases.length
        ? `（能指：${n.aliases.map((a) => `"${a}"`).join('；')}）`
        : ''
      const qs = Array.isArray(n.questions) && n.questions.length
        ? `（讨论过：${n.questions.map((q) => `"${q}"`).join('；')}）`
        : ''
      lines.push(`- ${n.id}：「${n.point}」${al}${qs}`)
    }
  }
  lines.push('', `用户发言："${message}"`)
  return lines.join('\n')
}

/**
 * 从 LLM 回复里提取引用解析结果：{"hits":["n_xxx","n_yyy"]}（id 数组，可为空）。
 * 容错：去空去重保序；条目不是字符串（旧对象格式等协议不符）→ 整体无效（重试）。
 * id 不在节点列表里的由调用方过滤。
 * @returns {{hits: Array<string>}|null}
 */
export function parseReferenceResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.hits)) return null
  const hits = []
  const seen = new Set()
  for (const h of d.hits) {
    if (typeof h !== 'string') return null   // 协议不符（如旧 {nodeId} 对象格式）→ 整体无效
    const id = h.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      hits.push(id)
    }
  }
  return { hits }
}

/**
 * 引用解析主入口（动作③）。用户发言 → 命中的节点 id 列表（可多个）→ 调用方取上下文
 * （命中节点的 root→recent 路径并集，L3）并把引用暂存；**建边延后到固化时**——
 * 当前讨论固化出节点后按暂存引用批量建 user 边（2026-08-27 定调：命中与建边解耦，
 * 会话中当前讨论尚未固化出节点，会话只需要上下文）。
 *
 * 判定（2026-08-27 定调：**纯 LLM 语义判定，一次判定**——无粗召回、无覆盖判定、
 * 无重试；材料只放条目身份，不放讨论原文；2026-08-29 加强：语义匹配，内容线索
 * 是底线——空指不解析，不惯着用户）：
 *   对**全量节点**做精判断（依据 point + aliases 能指 + questions；允许同义、
 *   简称、换表述、话题描述——能指词面命中不是必要条件；一次可命中多个；拿不准
 *   不输出，宁漏勿误）。
 *   多引用漏判静默接受（宁漏勿误：漏了无痛，用户以后会再引用）。
 *
 * @param {object} input { message: string（用户发言）, nodes: [{id, point, aliases?, questions?}] }
 * @param {object} deps { callLLM 必填, maxTokens?, attempts?, log? }
 * @returns {Promise<{hits: Array<string>, attempts: number}>}
 *   hits：命中的节点 id（可多个/可为空）
 * @throws 内容缺省 / 未注入 callLLM → TypeError；重试耗尽仍无有效判定 → Error
 */
export async function resolveReferences(input, deps = {}) {
  const message = String(input?.message || '').trim()
  if (!message) throw new TypeError('resolveReferences: 需要用户发言（message）')
  const nodes = Array.isArray(input?.nodes) ? input.nodes : []
  if (typeof deps.callLLM !== 'function') {
    throw new TypeError('resolveReferences: 必须注入 callLLM(prompt, maxTokens)')
  }
  const { callLLM, maxTokens = 8192, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  const basePrompt = buildReferencePrompt({ message, nodes })
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验。请重新输出：只给最终一行 JSON，不要任何推理或额外文字。`
    const text = await callLLM(prompt, maxTokens)
    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`resolveReferences LLM 返回失败串：${out.slice(0, 60)}`)
      continue
    }
    const parsed = parseReferenceResult(out)
    if (parsed) {
      log(`  ✓ 引用解析（attempt ${attempt + 1}，全量 ${nodes.length} 节点）：命中 ${parsed.hits.length} 个节点`)
      return { hits: parsed.hits, attempts: attempt + 1 }
    }
    log(`  ⚠️ 引用解析第 ${attempt + 1} 次校验未通过（${out.slice(0, 60)}），重试...`)
  }
  throw new Error(`resolveReferences ${attempts} 次尝试后仍无有效判定`)
}

// ───────────────────────── 4.5 衍生关联（对话连续性的拓扑边） ─────────────────────────
// 2026-10 用户定调：live 收口路径已去掉本判定——同栈收口切出的相邻段之间**无条件**建
// derived 边（思维连续链的机械产物，不替用户思考）。judgeDerivation 保留：供离线重判/
// 历史工具使用，live 固化不再调用。

/**
 * 衍生关联的判据提示词（离线/历史判定用）。拓扑边的第二条来源：**对话连续性**——后一条
 * 讨论从前一条讨论的思考中衍生出来（追问、延伸、对比、联想），即使用户没有说"我们之前
 * 说过A"这类显式引用句式。例：「为什么列宁最初分化哥萨克的策略没有奏效？」讨论中想到
 * 「中国为什么没孕育出哥萨克式角色」——后者的提问显然从前者的思考中长出来。
 * 宁漏勿误：拿不准 → 不建边（漏了无痛，用户以后显式引用时补上；错了污染拓扑）。
 */
export function buildDerivationInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在执行「衍生关联」：判断两条在对话中相邻的专题化讨论，后一条是不是从前一条的思考中衍生出来的。',
    '',
    '衍生 = 后一条讨论的问题显然从前一条讨论的思考中长出来——追问的延伸、换对象/换角度的联想、被前一条讨论引出/激发的对比。**不要求用户说"我们之前说过A"这类显式引用句式**——衍生是思考的连续性，不是引用的显式性。',
    '',
    '判定标准：',
    '- 衍生（linked=true）：后一条讨论承接前一条的思考继续追（例：讨论「列宁分化哥萨克的策略为什么没奏效」→ 想到「中国历史为什么没孕育出哥萨克式角色」——后一问题显然从前一问题的思考中长出来）。',
    '- 不衍生（linked=false）：两条讨论只是时间上挨着，后一条与前一条的思考无关（换了个完全不相关的话题）。',
    '- 宁漏勿误：拿不准 → linked=false。漏了无痛（用户以后显式引用时补上），错了污染拓扑（把不相关的讨论连起来）。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"linked":true,"reason":"一句话理由"}',
    '字段：linked 布尔；reason 字符串（建边时作为核对证据）。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

/**
 * 组装衍生关联判定材料：前一条讨论（question + 收尾轮次）+ 后一条讨论（question + 开头轮次）。
 * @param {object} input { prev: {question, excerpts?}, next: {question, excerpts?} }
 */
export function buildDerivationPrompt(input) {
  const prev = input?.prev || {}
  const next = input?.next || {}
  const prevQ = String(prev.question || '').trim()
  const nextQ = String(next.question || '').trim()
  const lines = [
    buildDerivationInstruction(),
    '',
    `前一条讨论的问题："${prevQ}"`,
    '前一条讨论的收尾轮次：',
    ...tailExcerpts(prev.excerpts),
    '',
    `后一条讨论的问题："${nextQ}"`,
    '后一条讨论的开头轮次：',
    ...tailExcerpts(next.excerpts, 1),
  ]
  return lines.join('\n')
}

// 取 excerpts 的收尾轮次（默认最后 2 轮，每轮 q/a 截断）
function tailExcerpts(excerpts, fromEnd = 2) {
  const list = Array.isArray(excerpts) ? excerpts.slice(-fromEnd) : []
  if (list.length === 0) return ['（无）']
  const out = []
  for (const e of list) {
    const q = String(e?.q || '').trim()
    const a = String(e?.a || '').trim()
    if (q) out.push(`  用户："${q.slice(0, 200)}"`)
    if (a) out.push(`  AI："${a.slice(0, 300)}"`)
  }
  return out.length > 0 ? out : ['（无）']
}

/**
 * 从 LLM 回复里提取衍生判定：{"linked": bool, "reason": string}。
 * @returns {{linked: boolean, reason: string}|null}
 */
export function parseDerivationResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (typeof d.linked !== 'boolean') return null
  return { linked: d.linked, reason: String(d.reason || '').trim() }
}

/**
 * 衍生关联主入口：对话相邻的两条讨论 → 后一条是否从前一条的思考中衍生。
 * 命中 → 调用方建 kind:"derived" 边（from=前一条所在节点，to=后一条所在节点）。
 *
 * @param {object} input { prev: {question, excerpts?}, next: {question, excerpts?} }
 * @param {object} deps { callLLM 必填, maxTokens?, attempts?, log? }
 * @returns {Promise<{linked: boolean, reason: string, attempts: number}>}
 * @throws 内容缺省 / 未注入 callLLM → TypeError；重试耗尽仍无有效判定 → Error
 */
export async function judgeDerivation(input, deps = {}) {
  const prevQ = String(input?.prev?.question || '').trim()
  const nextQ = String(input?.next?.question || '').trim()
  if (!prevQ || !nextQ) {
    throw new TypeError('judgeDerivation: 需要 prev 与 next 的问题（question）')
  }
  if (typeof deps.callLLM !== 'function') {
    throw new TypeError('judgeDerivation: 必须注入 callLLM(prompt, maxTokens)')
  }
  const { callLLM, maxTokens = 2048, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  const basePrompt = buildDerivationPrompt(input)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验。请重新输出：只给最终一行 JSON，不要任何推理或额外文字。`
    const text = await callLLM(prompt, maxTokens)
    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`judgeDerivation LLM 返回失败串：${out.slice(0, 60)}`)
      continue
    }
    const parsed = parseDerivationResult(out)
    if (parsed) {
      log(`  ✓ 衍生关联（attempt ${attempt + 1}）：${parsed.linked ? '衍生' : '不衍生'}（${parsed.reason.slice(0, 40)}）`)
      return { linked: parsed.linked, reason: parsed.reason, attempts: attempt + 1 }
    }
    log(`  ⚠️ 衍生关联第 ${attempt + 1} 次校验未通过（${out.slice(0, 60)}），重试...`)
  }
  throw new Error(`judgeDerivation ${attempts} 次尝试后仍无有效判定`)
}
