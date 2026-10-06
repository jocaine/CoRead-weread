#!/usr/bin/env node
/**
 * 会意图图数据读取（AI-020）：receiver 的 /graph 端点专用
 *
 * 会意图（topic-library-design.md §5）= 一张有向图一个文件：节点（知识点 point /
 * 能指 aliases / 节点讨论 discussions）+ 边（用户问题意识轨迹：from → to，
 * kind = user 用户引用 / derived 对话衍生）。
 *
 * 数据源三级回退（由图视图实时取用）：
 *   1. data\profile\knowledge-graph.json   —— 会意系统固化产物（正式，一张图一个文件）
 *   2. builtin\knowledge-graph-results.json（graph 字段）—— 冒烟/派生脚本
 *      产出的有效图，节点带 aliases + discussions，固化未落盘时先展示它
 *   3. ?demo=1 → buildDemoGraph() 从 builtin\knowledge-graph-demo.json 的事件序列重建演示拓扑
 *
 * buildDemoGraph：把 demo 文件的「过程事件」（aggregate / edge 事件序列）还原成成品图，
 * 并补入 contextPath 里更规范的 point / aliases——demo 文件记录的是演示输入与产物，
 * 不是成品图结构，需重建。
 */

import fs from 'fs'
import path from 'path'
import {
  GRAPH_FILE, BUILTIN_GRAPH_RESULTS_FILE, BUILTIN_GRAPH_DEMO_FILE, PROFILE_DIR,
} from '../agent/lib/paths.js'

// 路径全部来自 agent/lib/paths.js（唯一真源）。2026-10 目录重构后的落点：
//   GRAPH_FILE         → data\profile\knowledge-graph.json（用户数据）
//   GRAPH_RESULTS_FILE → builtin\knowledge-graph-results.json（随包分发的回退图）
//   GRAPH_DEMO_FILE    → builtin\knowledge-graph-demo.json（随包分发的演示事件序列）
export const GRAPH_RESULTS_FILE = BUILTIN_GRAPH_RESULTS_FILE
export const GRAPH_DEMO_FILE = BUILTIN_GRAPH_DEMO_FILE
/** 自由模式沙盒图（测试产物）：跟正式图谱同一格 */
export const FREE_GRAPH_FILE = path.join(PROFILE_DIR, 'knowledge-graph.free.json')

export { GRAPH_FILE }

/**
 * 读自由模式沙盒图（测试产物，2026-09）：agent 自由模式的收口固化只落在沙盒
 * （正式图深拷贝），导出到 FREE_GRAPH_FILE 供侧栏图视图查看测试结果。
 * 文件不存在/非法 → null（调用方回退正式图）。
 * @returns {{nodes: Array, edges: Array, updatedAt: number, demo: boolean, free: boolean, source: string}|null}
 */
export function readFreeGraphFile() {
  try {
    const g = JSON.parse(fs.readFileSync(FREE_GRAPH_FILE, 'utf8'))
    if (!g || !Array.isArray(g.nodes)) return null
    let updatedAt = 0
    try { updatedAt = fs.statSync(FREE_GRAPH_FILE).mtimeMs } catch {}
    return {
      nodes: g.nodes,
      edges: Array.isArray(g.edges) ? g.edges : [],
      updatedAt,
      demo: false,
      free: true,
      source: 'free',
    }
  } catch {
    return null
  }
}

/**
 * 读成品图文件（优先固化，回退冒烟有效图）。
 * @returns {{nodes: Array, edges: Array, updatedAt: number, demo: boolean, source: string}}
 *   source: file（固化图）| results（冒烟有效图）| none（无）
 */
export function readGraphFile() {
  let raw = ''
  try { raw = fs.readFileSync(GRAPH_FILE, 'utf8') } catch {}
  if (raw) {
    try {
      const g = JSON.parse(raw)
      const nodes = Array.isArray(g.nodes) ? g.nodes : []
      const edges = Array.isArray(g.edges) ? g.edges : []
      let updatedAt = 0
      try { updatedAt = fs.statSync(GRAPH_FILE).mtimeMs } catch {}
      return { nodes, edges, updatedAt, demo: false, source: 'file' }
    } catch {}
  }
  // 回退：冒烟/派生脚本产出的有效图（节点带 aliases + discussions）
  const res = readResultsGraph()
  if (res) return res
  return { nodes: [], edges: [], updatedAt: 0, demo: false, source: 'none' }
}

/**
 * 读冒烟有效图：{ graph: { nodes, edges } }（兼容顶层直接是图）。
 * 补齐节点缺失字段并保证 id/point 非空，前端渲染更稳。
 * @returns {{nodes: Array, edges: Array, updatedAt: number, demo: boolean, source: string}|null}
 */
export function readResultsGraph() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GRAPH_RESULTS_FILE, 'utf8'))
    const g = parsed && parsed.graph && typeof parsed.graph === 'object' ? parsed.graph : parsed
    if (!g || !Array.isArray(g.nodes)) return null
    let updatedAt = 0
    try { updatedAt = fs.statSync(GRAPH_RESULTS_FILE).mtimeMs } catch {}
    const now = Date.now()
    const filled = g.nodes.map((n) => ({
      id: n && n.id,
      point: String((n && n.point) || (n && n.id) || ''),
      aliases: Array.isArray(n && n.aliases) ? n.aliases : [],
      discussions: Array.isArray(n && n.discussions) ? n.discussions : [],
      createdAt: (n && n.createdAt) || now,
      updatedAt: (n && n.updatedAt) || now,
    })).filter((n) => n.id)
    return { nodes: filled, edges: Array.isArray(g.edges) ? g.edges : [], updatedAt, demo: false, source: 'results' }
  } catch {
    return null
  }
}

/**
 * 重建演示拓扑（demo 文件 = 事件序列 + demoOnly + contextPath，非成品图）。
 * 失败（文件缺失/非法）→ null。
 * @returns {{nodes: Array, edges: Array}|null}
 */
export function buildDemoGraph() {
  let raw
  try { raw = JSON.parse(fs.readFileSync(GRAPH_DEMO_FILE, 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const nodes = new Map()
  const edges = []
  const now = Date.now()
  const seed = (id, point) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, point: point || id, aliases: [], discussions: [], createdAt: now, updatedAt: now })
    }
  }
  // aggregate 事件 = 节点（新建/命中都保证节点存在）；edge 事件 = 边（from → to，kind）
  const events = Array.isArray(raw.events) ? raw.events : []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.event === 'aggregate' && ev.nodeId) seed(ev.nodeId, ev.point)
    else if (ev.event === 'edge' && ev.from && ev.to) {
      edges.push({ from: ev.from, to: ev.to, kind: ev.kind === 'derived' ? 'derived' : 'user' })
    }
  }
  // demoOnly = 演示完整状态（当前讨论节点 + 对应边），结构已是成品
  const demoOnly = raw.demoOnly || {}
  for (const n of Array.isArray(demoOnly.nodes) ? demoOnly.nodes : []) {
    if (n && n.id) {
      nodes.set(n.id, {
        ...n,
        aliases: Array.isArray(n.aliases) ? n.aliases : [],
        discussions: Array.isArray(n.discussions) ? n.discussions : [],
      })
    }
  }
  for (const e of Array.isArray(demoOnly.edges) ? demoOnly.edges : []) {
    if (e && e.from && e.to) edges.push({ from: e.from, to: e.to, kind: e.kind === 'derived' ? 'derived' : 'user' })
  }
  // 演示读取路径（contextPath）里的节点可能带更规范的 point（知识点表述）与
  // 能指（aliases）——补进对应节点，让演示更接近真实形态（标题是知识点而非问句）
  const paths = Array.isArray(raw.contextPath) ? raw.contextPath : []
  for (const p of paths) {
    if (!p || !p.id || !nodes.has(p.id)) continue
    const node = nodes.get(p.id)
    if (p.point) node.point = p.point
    if (Array.isArray(p.aliases) && p.aliases.length) {
      const al = Array.isArray(node.aliases) ? node.aliases.slice() : []
      const seen = new Set(al)
      for (const a of p.aliases) {
        if (a && !seen.has(a)) { seen.add(a); al.push(a) }
      }
      node.aliases = al
    }
  }
  // 只保留两端都在节点集里的边（防悬空引用）
  const validEdges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to))
  return { nodes: [...nodes.values()], edges: validEdges }
}
