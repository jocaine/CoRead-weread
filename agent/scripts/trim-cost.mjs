#!/usr/bin/env node
/**
 * 惰性截尾的成本模型：裁剪间隔 n 轮、每轮平均费用、与"理想缓存（纯追加无裁剪）"的差距。
 *
 * 价格（DeepSeek，元/百万 token）：
 *   缓存命中 0.05，未命中 1.5
 *
 * 模型（每轮一次请求，窗口追加式）：
 *   裁剪后第 1 轮：hit = SYSTEM，miss = T + r（整窗全价重算——这就是裁剪的代价）
 *   第 k 轮（k=2..n）：hit = SYSTEM + T + (k-1)×r（前缀命中），miss = r（只新增）
 *   窗口到 BUDGET 触发下次裁剪：n = floor((BUDGET - T) / r)
 *   理想基准（无裁剪纯追加）：每轮 hit ≈ SYSTEM + T，miss = r
 */
const HIT_PRICE = 0.05      // 元 / 百万 token
const MISS_PRICE = 1.5
const SYSTEM_TOKENS = 4000  // SYSTEM 指令 ~4K（恒定命中）
const R_PER_TURN = 1045     // 真实统计：每轮 ≈1045 token（user 224 + assistant 821）

function perTurnCost(hit, miss) {
  return (hit * HIT_PRICE + miss * MISS_PRICE) / 1e6   // 元
}

function evaluate(budget, trimPct) {
  const T = Math.floor(budget * trimPct)
  const n = Math.max(1, Math.floor((budget - T) / R_PER_TURN))
  // 周期内每轮费用
  let cycle = 0
  for (let k = 1; k <= n; k++) {
    const hit = k === 1 ? SYSTEM_TOKENS : SYSTEM_TOKENS + T + (k - 1) * R_PER_TURN
    const miss = k === 1 ? T + R_PER_TURN : R_PER_TURN
    cycle += perTurnCost(hit, miss)
  }
  const avg = cycle / n
  // 理想基准：无裁剪、窗口恒为 T 级别（前缀全命中，只付新增）
  const ideal = perTurnCost(SYSTEM_TOKENS + T, R_PER_TURN)
  const extraPct = (avg - ideal) / ideal * 100
  // 裁剪一次的实际代价（第 1 轮 vs 理想第 1 轮）
  const trimCost = perTurnCost(SYSTEM_TOKENS, T + R_PER_TURN) - perTurnCost(SYSTEM_TOKENS + T, R_PER_TURN)
  return { T, n, avg, ideal, extraPct, trimCost }
}

console.log('每轮增量 r = ' + R_PER_TURN + ' token；价格：命中 0.05 / 未命中 1.5（元/百万 token）\n')
console.log('BUDGET      TRIM(比例)   切后token  裁剪间隔n  每轮费用(元)  理想基准(元)   额外%     裁剪一次代价(元)')
for (const budget of [64000, 96000, 128000, 192000, 256000]) {
  for (const pct of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const { T, n, avg, ideal, extraPct, trimCost } = evaluate(budget, pct)
    const flag = extraPct <= 10 ? ' ✓' : extraPct <= 25 ? ' ~' : ''
    console.log(
      String(budget).padStart(8) + '   ' +
      String(pct * 100 + '%').padStart(8) + '   ' +
      String(T).padStart(9) + '   ' +
      String(n + '轮').padStart(7) + '   ' +
      avg.toFixed(6).padStart(12) + '   ' +
      ideal.toFixed(6).padStart(12) + '   ' +
      extraPct.toFixed(1).padStart(7) + '%' +
      trimCost.toFixed(6).padStart(16) + flag
    )
  }
  console.log('')
}
console.log('✓ = 额外 ≤10%  ~ = ≤25%；裁剪一次代价 = 该次请求比"理想缓存"多付的钱')
