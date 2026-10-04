#!/usr/bin/env node
/**
 * L3 预览：用**真实代码路径**（lib/knowledge-graph.js 的 userAncestry ＋ lib/l3-context.js
 * 的 l3Block）算出某本书"当前这一轮"会带进主回复的 L3 块，打印清单与体量。
 *
 * 用法：
 *   node scripts/l3-size.mjs              # 取 topic_stack.json 里最后一个非空书栈
 *   node scripts/l3-size.mjs <bookKey>    # 指定书（baseBookId）
 *   node scripts/l3-size.mjs <bookKey> --full   # additionally dump 整块到 .l3-preview.txt
 *
 * 口径（topic-library-design.md §5.4④，2026-10 定调）：L3 = 本轮引用解析命中的节点
 * ＋ 命中节点的 user 入边闭包（来路）；只渲染 point 标题行 + excerpts 原话全文。
 */
import fs from 'node:fs'
import { userAncestry } from '../lib/knowledge-graph.js'
import { l3Block } from '../lib/l3-context.js'

const graph = JSON.parse(fs.readFileSync(new URL('../data/knowledge-graph.json', import.meta.url), 'utf8'))
const stacks = JSON.parse(fs.readFileSync(new URL('../topic_stack.json', import.meta.url), 'utf8'))
const TOKEN_PER_CHAR = 0.62

const args = process.argv.slice(2)
const wantFull = args.includes('--full')
const key = args.find((a) => !a.startsWith('--'))
  || Object.entries(stacks).reverse().find(([, v]) => Array.isArray(v) && v.length) ?.[0]
if (!key || !Array.isArray(stacks[key]) || !stacks[key].length) {
  console.error(`没有可用的书栈（key=${key || '未指定'}）`)
  process.exit(1)
}

const users = stacks[key].filter((e) => e.role === 'user')
const hits = [...new Set(users.at(-1)?.cites || [])]
console.log(`书栈 ${key}｜最后一条提问：${String(users.at(-1)?.content || '').replace(/\s+/g, ' ').slice(0, 60)}`)
console.log(`本轮引用解析命中：${hits.length ? hits.join(', ') : '（无 —— 不进 L3）'}`)
if (!hits.length) process.exit(0)

const ancestry = userAncestry(graph, hits)
const block = l3Block(ancestry)
const HEADER_LEN = l3Block([]).length
console.log('\nL3 清单：')
for (const e of ancestry) {
  const c = l3Block([e]).length - HEADER_LEN
  console.log(`  ${(e.hit ? '命中  ' : `来路${e.hops}跳`).padEnd(8)} ${e.id.padEnd(16)} ${String(c).padStart(6)} 字  ${e.node.point.slice(0, 40)}`)
}
console.log(`\n  ${ancestry.length} 节点 / ${block.length} 字（含块头 ${HEADER_LEN} 字）≈ ${Math.ceil(block.length * TOKEN_PER_CHAR)} token`)
console.log(`  块尾节点（紧邻本轮问题）：${ancestry.at(-1).id}`)

if (wantFull) {
  const out = '.l3-preview.txt'
  fs.writeFileSync(out, block)
  console.log(`  整块已写出：${out}`)
} else {
  console.log('\n--- 块头 ---\n' + block.slice(0, 420))
  console.log('\n--- 块尾 420 字 ---\n' + block.slice(-420))
}
