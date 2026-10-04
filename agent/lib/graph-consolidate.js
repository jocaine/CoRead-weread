#!/usr/bin/env node
/**
 * 会意系统 · 收口讨论 → 会意图的固化（live agent 版）
 *
 * 对应 topic-library-design.md §5.5「会话固化」：topic_pending.jsonl 里的收口讨论组
 * （已含收口时归纳的 question、收口时判定的衍生关联 derivation、会话中暂存的引用
 * citations），逐个固化进会意图：
 *   1. derivePoint（重心/表达清楚/主要矛盾）→ point
 *   2. deriveAliases（捡回被卸除的能指，重心在背景对象）→ aliases
 *   3. 新建节点（**节点不可变**，2026-08-29 用户定调：去聚合判同——每次固化都
 *      新建节点，不再判断"属于哪个已有节点"，建成后不并入、不追加、不改写）
 *   4. derived 边（收口时判定的衍生关联）+ user 边（会话中暂存的引用）由调用方按需调用
 *
 * 纯判定 + 纯图操作：不读写文件（IO 在 index.js），callLLM 由调用方注入。
 */

import { addNode, addEdge, derivePoint, deriveAliases, isReachable } from './knowledge-graph.js'
// groupExcerpts 迁到 lib/discussion-text.js（2026-10：收口三段判定共用同一份段全文渲染），
// 此处 re-export 保持既有导入面（index.js / 测试）。
export { groupExcerpts } from './discussion-text.js'

// 节点 id 生成：n_<base36 时间戳>_<进程内序号>（同进程内唯一；不同进程时间戳打底）
let _idSeq = 0
export function nextNodeId(now = Date.now()) {
  _idSeq++
  return `n_${now.toString(36)}_${_idSeq}`
}

/**
 * 深拷贝整张图（nodes + edges）。自由模式沙盒用（2026-09 定调：自由模式的固化
 * 完整链路跑在正式图的副本上，测试产物不碰正式图）。节点/边都是纯 JSON 结构，
 * 深拷贝后副本与原件互不影响。
 * @param {object} graph 会意图（{nodes, edges}）
 * @returns {{nodes: Array, edges: Array}} 独立副本
 */
export function cloneGraph(graph) {
  return {
    nodes: JSON.parse(JSON.stringify(Array.isArray(graph?.nodes) ? graph.nodes : [])),
    edges: JSON.parse(JSON.stringify(Array.isArray(graph?.edges) ? graph.edges : [])),
  }
}

/**
 * 固化一条收口讨论：派生 point → 拾取被卸除的能指 → 新建节点（节点不可变）。
 * @param {object} graph 会意图（{nodes, edges}）
 * @param {object} discussion { question（收口时归纳，必填）, book?, chapter?, excerpts? }
 * @param {object} deps { callLLM 必填, log?, attempts?, pointMaxTokens?, aliasMaxTokens? }
 * @returns {Promise<{nodeId: string, point: string}>}
 * @throws 缺 question / 未注入 callLLM → TypeError；判定重试耗尽 → Error
 */
export async function consolidateDiscussion(graph, discussion, deps = {}) {
  const { callLLM, log = () => {}, attempts = 3 } = deps
  const question = String(discussion?.question || '').trim()
  if (!question) throw new TypeError('consolidateDiscussion: 需要讨论 question（收口时归纳）')
  if (typeof callLLM !== 'function') {
    throw new TypeError('consolidateDiscussion: 必须注入 callLLM(prompt, maxTokens)')
  }
  const excerpts = Array.isArray(discussion.excerpts) ? discussion.excerpts : []

  // 1. 派生 point（推理模型预算给足：d_14 证据 4096 仍截断，默认提到上限 16384）
  const { point } = await derivePoint(
    { question, excerpts },
    { callLLM, maxTokens: deps.pointMaxTokens || 16384, attempts, log },
  )

  // 2. 拾取被卸除的能指（重心在背景对象；节点创建时拾取一次，之后不再改）
  const { aliases } = await deriveAliases(
    { point, question, excerpts },
    { callLLM, maxTokens: deps.aliasMaxTokens || 8192, attempts, log },
  )

  // 3. 新建节点（节点不可变：每次固化都新建，不判同、不并入）
  const newId = nextNodeId()
  addNode(graph, { id: newId, point, aliases, discussion })
  log(`  ✓ 新建节点：${newId}（${point}）`)
  return { nodeId: newId, point }
}

/**
 * derived 边：收口时同栈相邻段之间**无条件建立**的衍生关联（2026-10 用户定调：去掉段间
 * 衍生 LLM 判定——同一栈收口弹出的相邻段是思维连续链的机械产物；不替用户思考，user 边
 * 仍只来自用户显式引用）。
 * 同 pair 已有 derived 边则跳过（去重，2026-08-30 评审 P5：崩溃重放/重复判定
 * 不建重复 derived 边；user 边与 derived 边语义不同，可同 pair 共存）。
 * @returns {number} 建边条数（0 = 节点缺失/同节点/已存在，跳过）
 */
export function addDerivedEdge(graph, fromNodeId, toNodeId) {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return 0
  if (!graph.nodes.some((n) => n.id === fromNodeId) || !graph.nodes.some((n) => n.id === toNodeId)) return 0
  if (graph.edges.some((e) => e.from === fromNodeId && e.to === toNodeId && e.kind === 'derived')) return 0
  addEdge(graph, { from: fromNodeId, to: toNodeId, kind: 'derived' })
  return 1
}

/**
 * user 边：会话中暂存、固化时批量建的引用边（from = 被引用的旧节点，to = 当前固化节点）。
 * 引用短语不落库（2026-08-27 定调），边只记 from/to；同 pair 已存在则跳过（去重）。
 *
 * **同脉络多命中折叠（2026-09 用户定调；2026-10 收窄判据）**：一个固化节点命中同一条脉络
 * （root→recent 路径）上的多个节点时，只按脉络上**最后**（最靠 recent 侧）的一个
 * 命中节点建边——较早命中节点是后者的脉络祖先，多建边只是拓扑图上的视觉噪音。
 * **判据只认 user 边（2026-10）**：折叠的正当理由是"将来回溯后者时会顺带把前者带出来"，
 * 而 L3 自 2026-10 起**只沿 user 入边**取来路（lib/knowledge-graph.js userAncestry）。
 * 若两个命中节点之间靠 derived 边相连（同栈相邻段），回溯时**带不出来** ⇒ 那时不能折叠，
 * 两条边都要建（宁可拓扑多一条线，不能让 L3 丢来路）。
 * 折叠只在**本次命中列表内**做：绝不越过命中列表接到脉络更靠 recent 的节点——
 * 例：脉络 a→b→c，本段命中 a、b → 只建 b 边，不建 c 边（c 若被同栈其它段命中，
 * 由那段固化时自建自己的边）；脉络自身的边原样保留。
 * @param {object} graph 会意图（{nodes, edges}）——用于沿 user 边判脉络祖先（isReachable）
 * @param {Array<string>} fromIds 本次命中的旧节点 id 列表（可含重复/缺失 id）
 * @param {string} toNodeId 当前固化节点 id
 * @returns {number} 建边条数（from 缺失/同节点/已存在/被同脉络更晚命中节点折叠 → 跳过）
 */
export function addCitationEdges(graph, fromIds, toNodeId) {
  if (!graph.nodes.some((n) => n.id === toNodeId)) return 0
  // ① 有效 + 去重（保留原顺序首现）
  const froms = []
  const seen = new Set()
  for (const from of Array.isArray(fromIds) ? fromIds : []) {
    if (!from || from === toNodeId) continue
    if (!graph.nodes.some((x) => x.id === from)) continue
    if (seen.has(from)) continue
    seen.add(from)
    froms.push(from)
  }
  // ② 同脉络折叠：能沿 **user 边**到达另一命中节点的 = 较早节点（L3 回溯后者时能带出
  //    前者）→ 丢弃，只保留"最后"命中节点建边。derived 相连不算（L3 不走 derived）。
  //    成环等异常图（互相可达）不折叠，退回全建。
  const keep = froms.filter((f) => !froms.some((g) => g !== f && isReachable(graph, f, g, ['user'])))
  let n = 0
  for (const from of keep.length ? keep : froms) {
    if (graph.edges.some((e) => e.from === from && e.to === toNodeId && e.kind !== 'derived')) continue  // 同 pair 去重
    addEdge(graph, { from, to: toNodeId })
    n++
  }
  return n
}

/**
 * 冗余 user 边清理（2026-09 用户定调；2026-10 收窄判据）。
 *
 * 对本次收口新建的节点做"命中列表外"的最后一层折叠：一条 user 边 from→to，若去掉它
 * 之后 from 仍能到达 to，则认为这条边冗余 → 删除（拓扑更净）。**判据只认 user 边
 * （2026-10）**：原来的理由（借道段间 derived 边也算覆盖）建立在"L3 取 root→recent
 * 全路径"之上；L3 自 2026-10 起只沿 user 入边取来路，借道 derived 的覆盖不再成立 ⇒
 * 只有"只沿 user 边仍可达"才可删，否则宁可留着（删了 L3 就永远拿不到这条来路）。
 *   例（可删）：a→c→b 全是 user 边，A 命中 {a,b} 只建 b→A；B 命中 c 建 c→B →
 *    c 沿 user 边 c→b→A 已能到达 B → c→B 冗余，删除（L3 回溯 B 时经 A、b 仍能拿到 c）。
 *   例（不可删，2026-10 修正）：同上但 A→B 是 derived 边 → L3 不走 derived，回溯 B
 *   时到不了 c → c→B 必须保留。
 *
 * 边界：只处理 nodeIds 指定（本次收口新建）节点的入 user 边；derived 边与其它
 * 节点的边一律不动；找不到 user 替代路径 → 不删（宁漏勿删：漏了只是多一条边，
 * 删错会丢来路）。
 * 迭代到不动点：删除一条边可能使另一条边失去替代路径（理论成环场景），逐轮重判。
 * @param {object} graph 会意图（{nodes, edges}）
 * @param {Array<string>} nodeIds 本次收口新建的节点 id（只清理指向它们的 user 边）
 * @returns {number} 删除的 user 边条数
 */
export function pruneRedundantCitationEdges(graph, nodeIds) {
  const targets = new Set(
    (Array.isArray(nodeIds) ? nodeIds : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id),
  )
  if (!targets.size) return 0
  let removed = 0
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < graph.edges.length; i++) {
      const e = graph.edges[i]
      if (e.kind !== 'user') continue
      if (!targets.has(e.to)) continue
      // 去掉本条边后，from 是否仍能沿其它 **user** 边到达 to（来路已被覆盖 → 本条边冗余）。
      // 只认 user：L3 不走 derived，借道 derived 的覆盖对 L3 不成立（见函数注释）。
      const rest = graph.edges.filter((x, j) => j !== i)
      if (isReachable({ nodes: graph.nodes, edges: rest }, e.from, e.to, ['user'])) {
        graph.edges = rest
        removed++
        changed = true
        break
      }
    }
  }
  return removed
}

// groupExcerpts：由 lib/discussion-text.js 提供并 re-export（见文件头）。
