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

import { addNode, addEdge, derivePoint, deriveAliases } from './knowledge-graph.js'

// 节点 id 生成：n_<base36 时间戳>_<进程内序号>（同进程内唯一；不同进程时间戳打底）
let _idSeq = 0
export function nextNodeId(now = Date.now()) {
  _idSeq++
  return `n_${now.toString(36)}_${_idSeq}`
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
 * derived 边：收口时判定的衍生关联（同一本书内"前一条收口讨论 → 当前收口讨论"）。
 * @returns {number} 建边条数（0 = 节点缺失或同节点，跳过）
 */
export function addDerivedEdge(graph, fromNodeId, toNodeId) {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return 0
  if (!graph.nodes.some((n) => n.id === fromNodeId) || !graph.nodes.some((n) => n.id === toNodeId)) return 0
  addEdge(graph, { from: fromNodeId, to: toNodeId, kind: 'derived' })
  return 1
}

/**
 * user 边：会话中暂存、固化时批量建的引用边（from = 被引用的旧节点，to = 当前固化节点）。
 * 引用短语不落库（2026-08-27 定调），边只记 from/to；同 pair 已存在则跳过（去重）。
 * @returns {number} 建边条数（from 缺失/同节点/已存在跳过）
 */
export function addCitationEdges(graph, fromIds, toNodeId) {
  if (!graph.nodes.some((n) => n.id === toNodeId)) return 0
  let n = 0
  for (const from of Array.isArray(fromIds) ? fromIds : []) {
    if (!from || from === toNodeId) continue
    if (!graph.nodes.some((x) => x.id === from)) continue
    if (graph.edges.some((e) => e.from === from && e.to === toNodeId && e.kind !== 'derived')) continue  // 同 pair 去重
    addEdge(graph, { from, to: toNodeId })
    n++
  }
  return n
}

// 从收口组 entries（user/assistant 轮次）提取交锋轮次 {q, a}
export function groupExcerpts(entries) {
  const out = []
  let q = ''
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    if (e.role === 'user') q = String(e.content || '').trim()
    else if (e.role === 'assistant' && q) {
      const a = String(e.content || '').trim()
      if (a) out.push({ q, a })
      q = ''
    }
  }
  return out
}
