#!/usr/bin/env node
/**
 * 母题派生 · 真实数据跑批：对 judge-real-results.json 的专题化讨论问题做
 * 一次语法抽象 + 判同，按「形状 + 实例族 + 空本质」格式输出母题结果。
 *
 * 输入：agent/scripts/data/judge-real-results.json（discussions 数组，取带 question 的条目）
 * 输出：agent/scripts/data/motif-results.json
 * 运行：node scripts/derive-motifs.mjs
 *
 * 说明：本跑批是确定性原型（agent/lib/motif-shape.js），判同语义质量由会意系统
 * （LLM 路径）承担；这里演示的是机制：首实例进桶、二次实例出生、三次实例挂钩、
 * 近失记 negatives、essence 恒为 null。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MotifDeriver } from '../lib/motif-shape.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_FILE = join(HERE, 'data', 'judge-real-results.json')
const OUT_FILE = join(HERE, 'data', 'motif-results.json')

const src = JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
const discussions = src.discussions.filter((d) => d.question)
if (discussions.length === 0) {
  console.error('未找到带 question 的讨论，退出')
  process.exit(1)
}

const deriver = new MotifDeriver()
const trace = []
for (const d of discussions) {
  const r = deriver.ingest({
    id: d.id,
    question: d.question,
    meta: { facet: d.chapter ?? null, book: d.book ?? null },
  })
  trace.push({
    id: d.id,
    question: d.question,
    action: r.action,
    topic: r.topic ?? null,
    score: r.score,
  })
}

const out = {
  generatedAt: new Date().toISOString(),
  source: 'agent/scripts/data/judge-real-results.json',
  params: { threshold: deriver.threshold, nearMissFloor: deriver.nearMissFloor, slotWeight: deriver.slotWeight },
  summary: deriver.summary,
  topics: deriver.topics,
  drafts: deriver.drafts,
  trace,
}

writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`)

// ── 控制台摘要 ────────────────────────────────────────────────────────────────
console.log(`输入：${discussions.length} 条专题化讨论（${src.book ?? '静静的顿河'}）`)
console.log(`参数：threshold=${deriver.threshold}，nearMissFloor=${deriver.nearMissFloor}，slotWeight=${deriver.slotWeight}（宁漏勿误）`)
console.log('')
for (const t of deriver.topics) {
  console.log(`【话题】${t.id}（${t.born}）`)
  console.log(`  共同语法：${t.shape.grammar}`)
  for (const h of t.hits) console.log(`  · ${h.d} ${h.question}`)
  if (t.shape.negatives.length) {
    console.log(`  近失（未挂钩）：${t.shape.negatives.map((n) => `${n.d}(${n.score})`).join('，')}`)
  }
  console.log('')
}
console.log(`待归类桶（${deriver.drafts.length} 条首实例，未转正）：`)
for (const d of deriver.drafts) console.log(`  · ${d.id} ${d.question}`)
console.log('')
console.log(`输出：${OUT_FILE}`)
