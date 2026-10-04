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

// ───────────────────────── 3. 派生 point / 能指（固化用） ─────────────────────────

/**
 * 派生 point（固化 create_node 的一步）：从讨论的具体问题归纳
 * 知识点的狭隘范畴表述（一句话名词短语，如「孕育出哥萨克式角色的历史条件与契机」）。
 * 判据：狭隘范畴——不拔高成母题/抽象主题（那是"系统不猜母题"的禁区），
 * 也不细到单次提问的原文。允许换表述、允许跨书同一知识点。
 *
 * 2026-08-26 修正（重心规则）：point 的重心必须落在问题的**主体/主语**上，
 * 不许发生重心置换。「为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？」
 * 的重心是中国（中国的政治历史环境与民族问题为什么没产生这个角色），
 * 归纳为「哥萨克的社会角色」就是把重心从中国翻到了哥萨克——语义范围越界，
 * 会导致它被错误聚合进哥萨克侧节点。
 *
 * 2026-08-26 修正（表达清楚 + 抓住主要矛盾，用户定调）：
 * - 表达清楚：point 要说清"谁 + 在什么语境 + 追问什么"，不许用模糊标签糊弄。
 *   例：「那几个水兵的特殊性」是模糊标签 → 应为「苏联水兵在革命中的特殊地位」。
 *   「妲丽亚举动背后的动机」是模糊标签 → 应为「妲丽亚自己行为不检点害了病
 *   不高兴却还要刺激无辜的娜塔莎背后的动机」——把矛盾关系写进 point。
 * - 抓住主要矛盾：讨论本身有矛盾/错位/悖论结构时，point 要体现它，不停在表面
 *   对象。例：「顿河流通券的信用」停在表面对象 → 应为「货币有效性与当前政权
 *   的矛盾」——流通券信用崩盘实质是政权信用问题。**没有矛盾结构的讨论
 *   不必强造矛盾**（2026-08-26 用户修正："矛盾关系字面在场"过头了）。
 */
export function buildPointInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在为一条收口的专题化讨论归纳知识点表述（point）。',
    '',
    '知识点 = 这条讨论要求补上的解释所在的狭隘范畴——point 是名词短语形态（不是疑问句、不是完整句子），重心是讨论在追的那个机制/条件/契机/矛盾/关系/立场，不是被当作已知背景的对象；可以长，只要把落点说全。',
    '',
    '判定标准：',
    '- 从讨论的具体问题（question）归纳：这个讨论在追哪个知识点。',
    '- **重心规则（钉死）**：point 的重心落在**问题要求补上的解释**上，不是句法主语。',
    '  判定程序（写 point 前在心里走一遍）：',
    '  1. 列出问题当作**已知背景**使用的概念（被点名、被当作既定事实的：对象/场景/比较项）；',
    '  2. 找出问题**要求补上的解释**——"为什么/怎么会/凭什么"的落点（缺的是哪个机制/条件/关系/立场）；',
    '  3. 重心 = 解释的落点；point 写成"落点的机制/条件/关系"，不写成背景。',
    '  先按程序判定，再用例子对照检查——例子是检查工具，不是判定起点。',
    '  · 例一：「为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？」——已知背景：中国、哥萨克、',
    '    "中国没有哥萨克"；解释落点：孕育出哥萨克式角色的机制 → point 应为「孕育出哥萨克式角色的历史',
    '    条件与契机」一类；写成「中国历史为何未孕育出哥萨克式角色」（落在背景上）或「哥萨克的',
    '    社会角色」（停在对象本身，没落在孕育机制上）都失败。',
    '  · 例二：「为什么拉丁美洲的资本品工业建立不起来？」——已知背景：拉丁美洲、资本品工业；',
    '    解释落点：建立不起来的机制 → point 应为「拉丁美洲资本品工业建立不起来的原因」一类；',
    '    写成「拉丁美洲的工业化」（停在对象本身，没落在建立机制上）失败。',
    '- **表达清楚（钉死）**：point 要说清"谁 + 在什么语境 + 追问什么"，不许用模糊标签糊弄。',
    '  · 例：「那几个水兵的特殊性」是模糊标签（谁的水兵？什么语境？特殊性指什么？）→ 应为「苏联水兵在革命中的特殊地位」——主体（苏联水兵）、语境（革命中）、追问（特殊地位）都点明。',
    '  · 例：「妲丽亚举动背后的动机」是模糊标签 → 应为「妲丽亚自己行为不检点害了病不高兴却还要刺激无辜的娜塔莎背后的动机」——把讨论的核心矛盾关系（自己受害却刺激无辜者）字面写进 point，不许缩成"动机的善恶之辨"这种抽象化。',
    '- **抓住主要矛盾（钉死）**：point 不停在表面对象，要落在讨论真正在追的那个问题/张力上。',
    '  · 先判别：这条讨论有没有核心张力（矛盾/错位/悖论/倒挂）？',
    '    - 有 → point 必须落在张力上：例「顿河流通券的信用」停在表面对象 → 应为「货币有效性与当前政权的矛盾」——流通券信用崩盘实质是政权信用问题（"票子信用是政权存亡的即时报"）；「哥萨克被划为富农」停在归类动作 → 应为「阶级归类与身份共同体的错位」。写成「流通券信用不及克伦斯基票子的原因」仍是表面描述，没体现张力，失败。',
    '    - 没有（如单纯的原因追问）→ 不强造矛盾：按**重心规则**落在解释落点上即可，不需要在 point 里制造矛盾结构。',
    '  · 检查方法：写完 point 后自问"这条讨论的核心张力是什么？point 落在它上面了吗？"——讨论有张力而 point 没体现，就是停在表面对象，失败。',
    '- 狭隘范畴：字面/主题级，可跨书同一知识点换表述；不许拔高成母题或抽象主题（例：不得写「秩序如何被制造与维持」这种母题级表述）。',
    '- 不许写成具体问题的原文（例：不得写「北欧福利究竟是靠内部制度维持还是依附外部位置」——这是问题，不是知识点）。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"point":"孕育出哥萨克式角色的历史条件与契机"}',
    '字段：point 字符串，狭隘范畴知识点表述。只输出这一个 JSON 对象，前后不要有任何字符。',
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
  const point = String(d.point || '').trim()
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

/**
 * 拾取被卸除的能指的判据提示词（topic-library-design.md §5.3 / §5.4③）。
 *
 * 2026-08-29 定调（用户：point 定位改变后，能指的定位重新思考）：
 * **aliases = 讨论里被 point 卸除的能指**——point 抓住讨论真正追的解释（落点，
 * 重心规则），而讨论中作为已知背景被带出的对象及其展开的内容在 point 里退场了
 * （例：追「孕育出哥萨克式角色的历史条件与契机」时，"哥萨克"和"中国"被当作
 * 已知事物）；aliases 把它们**捡回来**，留在节点上为能指链的漂移**保留接驳材料**
 * （用户以后从这些对象滑向新话题时，节点能被命中；系统不预设漂移方向）。
 * 重心与 point 对称：point 重心在落点，aliases 重心在背景对象；不是 point 的换表述。
 *
 * 旧逻辑废弃（2026-08-27）：aliases 曾是"备选标题：陈述完整、不追求概括性"——
 * point 变长后它退化为 point 的换表述（"同义复述 point 不算"永远无法满足），
 * 且引用解析加强为语义匹配后"能指过滤层"已废除。引用命中只建边（不记引用词）。
 */
export function buildAliasInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在为一个知识点条目写可指认的说法（aliases）。',
    '',
    'point 写讨论追的解释（落点）；讨论里作为已知背景展开过的对象（例："中国为什么没有孕育出哥萨克式角色"里的"中国""哥萨克"）及其内容，point 没写——aliases 补上，供用户以后从这些对象指认这个节点。',
    '',
    '判定标准：',
    '- 每条写一个已知背景对象及其讨论展开的内容，不写 point 的换说法（例：point「中国历史未孕育出哥萨克式角色的制度文化原因」→ 写"中国的国家形态：户籍-官僚-科举体系在土地上不留制度裂缝""中俄边疆逻辑的对比"这类背景内容；写"未孕育出的制度文化原因"是重复 point，失败）。',
    '- 写清楚：对象是什么、讨论展开的内容是什么，读这条能把握这条内容；不许压缩成看不出内容的短提法。',
    '- 只写讨论里实际展开过的，不许发明。',
    '- 能单独指认；展开过几个就写几条，数量不限。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"aliases":["中国历史没酝酿出哥萨克，根源不在文化而在国家形态：强国家的户籍-官僚-科举体系在土地上不留制度裂缝，而俄国的农奴-领地-边疆体系处处是裂缝","长城不是防线而是哲学：中国对边境的控制意愿太强，用卫所军户把国家编制硬嵌进去，而俄国对顿河放任不管，边疆长出来的东西自然不同"]}',
    '字段：aliases 数组（数量不限），每条独立可用的称呼。只输出这一个 JSON 对象，前后不要有任何字符。',
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
  tail.push(
    '',
    '【要点】数量不限：讨论里展开过几个背景面就写几条，宁可多写、不要为了精简合并掉独立的面；',
    '每条写清"对象是什么 + 讨论展开的内容"，能单独指认；不许压缩成看不出内容的短提法；',
    '只写讨论里实际展开过的，不许发明。',
    '讨论中实际展开过的具体人物、历史文本、国别/制度对比对象也都是独立的背景面，各成一条，不要漏掉或合并掉。',
    '',
    buildAliasInstruction(),
  )
  return buildConsolidatePrompt(excerpts, tail.join('\n'))
}

/**
 * 从 LLM 回复里提取能指（aliases）：{"aliases": [string, ...]}。
 * 容错：去空去重（数量不限，2026-08-29 用户定调：不做条数限制）；至少 1 条才算有效。
 * @returns {{aliases: Array<string>}|null}
 */
export function parseAliasesResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const cleaned = cleanAliases(Array.isArray(d.aliases) ? d.aliases : [])
  return cleaned.length >= 1 ? { aliases: cleaned } : null
}

/**
 * 派生被卸除的能指主入口：point + 讨论内容（全量）→ 能指数组（数量不限）。
 * 2026-08-29 定调：**捡回被 point 卸除的能指**——重心在背景对象（讨论里展开过的
 * 背景内容），与 point 的落点重心对称；留在节点上为能指链的漂移保留接驳材料。
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
    '  ① 指认性表述：用户用指认性表述提到之前聊过的知识点（"之前/上次/我们聊过/那个……"）；只是恰好提到相关词、没有指认意图的，不是引用。',
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
