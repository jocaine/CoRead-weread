#!/usr/bin/env node
/**
 * 用量报表：把 data/runtime/usage.jsonl 按「天 × 调用类型」汇总，看缓存命中花在哪。
 *
 * 跑法：
 *   node agent/scripts/usage-report.mjs            # 最近 7 天
 *   node agent/scripts/usage-report.mjs --days 1   # 只看今天
 *   node agent/scripts/usage-report.mjs --kind 引用解析
 *   node agent/scripts/usage-report.mjs --file <别的 usage.jsonl>   # 读拷贝/样本
 *
 * 三个数怎么读（口径同 lib/usage-log.js 头部）：
 *   输入   = 这次请求发出去的输入 token（命中 + 未命中）
 *   命中率 = 命中 / 输入 —— 它低不低，取决于这条调用"能不能复用上一次的前缀"，见 README 的说明
 *   输出   = 模型生成的 token（推理模型的思考链也算在这里）
 * 服务商没回报缓存字段的调用，命中率显示 "—"，并单独计数——不要把"没报"当成 0%。
 */
import fs from 'node:fs'
import { USAGE_FILE } from '../lib/paths.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const days = Number(argOf('--days', '7'))
const onlyKind = argOf('--kind')
const file = argOf('--file', USAGE_FILE)
const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400_000 : 0

if (!fs.existsSync(file)) {
  console.log(`还没有用量流水：${file}`)
  console.log('（agent 至少跑过一次模型调用后才会出现；改了记账代码要重启 agent 才生效）')
  process.exit(0)
}

const rows = []
let bad = 0
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    if (r && typeof r === 'object' && Number(r.ts) >= since) rows.push(r)
  } catch { bad++ }
}

if (!rows.length) {
  console.log(`没有落在最近 ${days} 天里的记录（文件共 ${fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length} 行）`)
  process.exit(0)
}

const nf = new Intl.NumberFormat('en-US')
const dayOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const bump = (map, key, r) => {
  const b = map.get(key) || { n: 0, input: 0, hit: 0, miss: 0, out: 0, stat: 0 }
  b.n++
  if (r.input != null) b.input += r.input
  if (r.output != null) b.out += r.output
  if (r.hit != null && r.miss != null) { b.hit += r.hit; b.miss += r.miss; b.stat++ }
  map.set(key, b)
}

const byDay = new Map()      // day -> {n,input,hit,miss,out,noStat}
const byDayKind = new Map()  // `${day} ${kind}` -> bucket
const byKind = new Map()     // kind -> bucket
for (const r of rows) {
  if (onlyKind && r.kind !== onlyKind) continue
  const day = dayOf(r.ts)
  bump(byDay, day, r)
  bump(byDayKind, `${day} ${r.kind || '判定'}`, r)
  bump(byKind, r.kind || '判定', r)
}
if (!byDay.size) {
  console.log(`最近 ${days} 天里没有 ${onlyKind} 这类调用`)
  process.exit(0)
}

const rate = (b) => (b.hit + b.miss > 0 ? `${((b.hit / (b.hit + b.miss)) * 100).toFixed(1)}%` : '—')
const num = (v, b) => (b.stat > 0 && v != null ? nf.format(v) : '—')
const pad = (s, w) => { const t = String(s); const n = w - [...t].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0); return t + ' '.repeat(Math.max(0, n)) }
const rowOut = (label, b) =>
  `${pad(label, 22)}${pad(b.n, 5)}${pad(nf.format(b.input), 12)}${pad(num(b.hit, b), 12)}${pad(num(b.miss, b), 11)}${pad(rate(b), 8)}${pad(nf.format(b.out), 10)}${b.stat < b.n ? `  （${b.n - b.stat} 次未回报缓存）` : ''}`

console.log(`用量报表 · 最近 ${days} 天 · ${file}${onlyKind ? ` · 只看「${onlyKind}」` : ''}\n`)
console.log(pad('日期 / 调用类型', 22) + pad('次数', 5) + pad('输入', 12) + pad('命中', 12) + pad('未命中', 11) + pad('命中率', 8) + pad('输出', 10))
console.log('─'.repeat(80))
for (const day of [...byDay.keys()].sort()) {
  console.log(rowOut(day, byDay.get(day)))
  const kinds = [...byDayKind.keys()].filter((k) => k.startsWith(day + ' '))
    .sort((a, b) => byDayKind.get(b).input - byDayKind.get(a).input)
  for (const k of kinds) console.log('  ' + rowOut('  ' + k.slice(day.length + 1), byDayKind.get(k)))
}
console.log('─'.repeat(80))
console.log(rowOut('合计', [...byDay.values()].reduce((a, b) => ({
  n: a.n + b.n, input: a.input + b.input, hit: a.hit + b.hit, miss: a.miss + b.miss, out: a.out + b.out, stat: a.stat + b.stat,
}), { n: 0, input: 0, hit: 0, miss: 0, out: 0, stat: 0 })))

console.log('\n按调用类型（全期）：')
for (const [kind, b] of [...byKind.entries()].sort((a, b) => b[1].input - a[1].input)) {
  console.log('  ' + rowOut(kind, b))
}
if (bad) console.log(`\n⚠️ 有 ${bad} 行读不懂（写入被打断/文件被改过），已跳过——记账是尽力而为，不影响对话。`)
