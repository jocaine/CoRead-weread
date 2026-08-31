#!/usr/bin/env node
/** L3 真实体量分布：55 节点各自的 l3Block token（point + discussions 全量 excerpts） */
import fs from 'node:fs'

const g = JSON.parse(fs.readFileSync('agent/data/knowledge-graph.json', 'utf8'))
const R = 0.62
const tok = (s) => Math.ceil(String(s).length * R)

function nodeL3(n) {
  let t = tok(n.point)
  for (const d of n.discussions || []) {
    t += tok(`  · ${d.book || ''}${d.chapter || ''}：${d.question || ''}`)
    for (const e of d.excerpts || []) {
      if (e.q) t += tok(`    用户："${e.q}"`)
      if (e.a) t += tok(`    AI："${e.a}"`)
    }
  }
  return t
}

const sizes = g.nodes.map((n) => nodeL3(n)).sort((a, b) => a - b)
const sum = sizes.reduce((a, b) => a + b, 0)
const pct = (p) => sizes[Math.floor(sizes.length * p)]
console.log('55 个节点各自的 L3 体量（token，全量 excerpts）：')
console.log(`  min=${sizes[0]}  p25=${pct(0.25)}  中位=${pct(0.5)}  p90=${pct(0.9)}  max=${sizes[sizes.length - 1]}  均值=${Math.round(sum / sizes.length)}`)
console.log(`  discussions 数：max=${Math.max(...g.nodes.map((n) => (n.discussions || []).length))}  有 discussions 的节点数=${g.nodes.filter((n) => (n.discussions || []).length).length}`)

const heaviest = g.nodes.map((n) => ({ id: n.id, t: nodeL3(n), ds: (n.discussions || []).length })).sort((a, b) => b.t - a.t).slice(0, 5)
console.log(`  最重 5 节点：${heaviest.map((h) => `${h.id}(${h.t}t,${h.ds}讨论)`).join(' ')}`)

// 真实链示例：n_d_28 沿入边反向找 root，再沿出边走到 n_d_28
const edges = g.edges
function findRoot(id, seen = new Set()) {
  const froms = edges.filter((e) => e.to === id && !seen.has(e.from))
  if (!froms.length) return id
  seen.add(id)
  return findRoot(froms[0].from, seen)
}
const root = findRoot('n_d_28')
const path = []
let node = root
while (node && node !== 'n_d_28') {
  path.push(node)
  node = (edges.find((e) => e.from === node) || {}).to
}
path.push('n_d_28')
const pathTok = path.reduce((a, id) => a + nodeL3(g.nodes.find((x) => x.id === id)), 0)
console.log(`  示例链 ${path.join(' → ')} 的 L3 合计 ≈ ${pathTok} token（${(pathTok / 1000).toFixed(1)}K）`)
console.log(`  全部 55 节点并集（极端）≈ ${Math.round(sum)} token（${(sum / 1000).toFixed(1)}K）`)
