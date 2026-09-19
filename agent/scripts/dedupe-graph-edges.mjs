#!/usr/bin/env node
/**
 * 会意图 · 同脉络多边回填清理（2026-09 用户定调）
 *
 * 背景：收口固化建 user 边的新规则 = "同一固化节点命中同一条脉络（root→recent 路径）
 * 上的多个节点时，只按脉络上最后（recent 侧）的一个命中节点建一条边"（见
 * lib/graph-consolidate.js addCitationEdges）。规则 2026-09 生效前已固化进正式图的
 * 同脉络多边不会自动消失——本脚本对存量图做一次等价回填：
 *
 *   对每个 to 节点，取它全部入边中 kind=user 的 from 集合（≈ 该节点固化时的命中列表，
 *   user 边只由 addCitationEdges 建立），沿图边判可达（lib/knowledge-graph.js
 *   isReachable，user + derived 全 kind，与 L3 上下文/前端命中链同一口径）：
 *   - from X 能沿边到达另一 from Y → X 是 Y 脉络上的较早节点（内容被 Y 完整包含）→
 *     删除 X → to 的全部 user 边；
 *   - 保留的 = 各脉络上最后（recent 侧）的命中节点 → 各自只留一条 user 边。
 * 边界与固化规则一致：只在各 to 节点自己的命中列表内折叠，不越过列表接脉络更晚的
 * 节点；derived 边（脉络自身的边）一律不动；同 pair 可能共存的 user/derived 各自独立；
 * 成环等异常图（互相可达、无法定序）不动。
 *
 * 写回前自动备份为 <file>.bak-dedup（存在则不覆盖）。结果可重复运行：跑完再跑
 * 零改动（幂等）。
 *
 * 用法：node scripts/dedupe-graph-edges.mjs [图文件路径] [--dry]
 *   默认图文件 = agent/data/knowledge-graph.json（正式图）；--dry 只预演不改文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReachable } from '../lib/knowledge-graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const graphFile = path.resolve(
  __dirname,
  '..',
  'data',
  args.filter((a) => a !== '--dry')[0] || 'knowledge-graph.json',
)

if (!fs.existsSync(graphFile)) {
  console.error('图文件不存在：' + graphFile)
  process.exit(1)
}
const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'))
if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
  console.error('图文件结构异常（需要 { nodes, edges }）：' + graphFile)
  process.exit(1)
}

// ① 按 to 节点收集入边 user 边的 from（保留图内实际顺序首现去重）
const byTo = new Map()
for (const e of graph.edges) {
  if (e.kind !== 'user' || !e.from || !e.to) continue
  if (!byTo.has(e.to)) byTo.set(e.to, [])
  const list = byTo.get(e.to)
  if (!list.includes(e.from)) list.push(e.from)
}

// ② 逐 to 节点判定：keep = 不被其它 from 沿边到达（各脉络最后命中节点）；
//    drop = keep 之外的 from（较早命中节点）。判定用同一张图快照（删边不影响判序，
//    且 user 入边不构成 from 间的路径——成环例外，见文件头）。
const decisions = []  // { to, keep: [], drop: [], edgeN }
for (const [to, froms] of byTo) {
  if (froms.length < 2) continue
  const keep = froms.filter((f) => !froms.some((h) => h !== f && isReachable(graph, f, h)))
  if (!keep.length) continue  // 成环等异常：无法定序，不动
  const drop = froms.filter((f) => !keep.includes(f))
  if (!drop.length) continue
  const dropSet = new Set(drop)
  const edgeN = graph.edges.filter((e) => e.kind === 'user' && e.to === to && dropSet.has(e.from)).length
  decisions.push({ to, keep, drop, edgeN })
}

if (!decisions.length) {
  console.log('无需清理：存量图不存在同脉络多边（幂等）——' + graphFile)
  process.exit(0)
}

// ③ 汇报 + 执行
for (const d of decisions) {
  console.log(
    'TO ' + d.to +
    '  命中列表(' + (d.drop.length + d.keep.length) + '): ' + [...d.drop, ...d.keep].join(',') +
    '  → 保留最后命中节点边: ' + d.keep.join(',') +
    '  删除较早命中节点边 ×' + d.edgeN + ': ' + d.drop.join(','),
  )
}
const totalEdges = decisions.reduce((s, d) => s + d.edgeN, 0)
console.log('共 ' + decisions.length + ' 个 to 节点受影响，删除 user 边 ' + totalEdges + ' 条（derived 边不动）')
if (dry) {
  console.log('[--dry] 预演结束，未写任何文件。')
  process.exit(0)
}

// 备份（不覆盖已有备份）
const bak = graphFile + '.bak-dedup'
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, JSON.stringify(graph, null, 2) + String.fromCharCode(10))
  console.log('已备份原图 → ' + path.basename(bak))
}
const dropByTo = new Map(decisions.map((d) => [d.to, new Set(d.drop)]))
const before = graph.edges.length
graph.edges = graph.edges.filter((e) => {
  if (e.kind !== 'user') return true
  const set = dropByTo.get(e.to)
  return !(set && set.has(e.from))
})
fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2) + String.fromCharCode(10))
console.log('写回 ' + path.basename(graphFile) + '：边 ' + before + ' → ' + graph.edges.length + '（删 ' + (before - graph.edges.length) + '）')
