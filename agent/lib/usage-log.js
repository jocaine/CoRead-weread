#!/usr/bin/env node
/**
 * 模型调用用量记账（2026-10 诊断）——每次 API 调用落一行 JSON，记"命中 / 未命中 / 输出"。
 *
 * 为什么要有它：DeepSeek 的上下文缓存不是"有共同前缀就按共同部分扣费"，而是
 * **完整匹配一个「缓存前缀单元」才算命中**（见 https://api-docs.deepseek.com/zh-cn/guides/kv_cache/），
 * 而命中与未命中的单价差几十倍。加这个文件之前，程序**请求了 usage 却把它丢掉**
 *（`stream_options.include_usage` 发了，解析时只读 `choices[0].delta`），所以
 * "命中率低不低、低在哪一类调用上"只能看平台面板那个按小时的聚合数字——
 * 它分不出「主回复 / 引用解析 / 判专题化」各花了多少。
 *
 * 落点：`data/runtime/usage.jsonl`（见 lib/paths.js 的 USAGE_FILE），一行一条，只追加。
 * 为什么放 runtime\：它是过程数据，删了不影响任何用户数据（接着跑就又有了）。
 *
 * 字段口径（全部来自服务商返回的 usage，本模块不做任何估算）：
 *   input  = prompt_tokens                 本次请求发出去的输入 token（含命中的部分）
 *   hit    = prompt_cache_hit_tokens       其中从缓存里直接读到的
 *   miss   = prompt_cache_miss_tokens      其中真正算了一遍的
 *   output = completion_tokens             模型生成的（推理模型的思考链也算在这里）
 *
 * 兼容性：DeepSeek 报 prompt_cache_hit_tokens / prompt_cache_miss_tokens；OpenAI / Kimi 这类
 * 只报 prompt_tokens_details.cached_tokens（没有 miss，用 input - hit 补）。
 * 服务商完全不报缓存字段时，hit/miss 记 **null** —— 不许编 0，否则报表会把"没报"读成"全未命中"。
 */
import fs from 'node:fs'
import { USAGE_FILE } from './paths.js'

// ── 从一次响应里取用量 ───────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/**
 * 从 OpenAI 兼容的响应体（非流式就是整个 body；流式是最后一帧）里取用量。
 * 那些帧的 `choices` 是空数组，所以调用方**不能**用"有没有 choices"判断该不该看它。
 * @param {object} payload 解析后的 JSON（可能为 null）
 * @returns {{input:number|null, output:number|null, hit:number|null, miss:number|null}|null}
 *   null = 这份响应没带 usage（被中止、服务商没回、或不是终帧）
 */
export function readUsage(payload) {
  const u = payload && payload.usage
  if (!u || typeof u !== 'object') return null
  const input = num(u.prompt_tokens)
  const output = num(u.completion_tokens)
  let hit = num(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens)
  let miss = num(u.prompt_cache_miss_tokens)
  // 只报了一半时补另一半：两个数都缺（服务商不支持缓存统计）就都留 null
  if (input != null) {
    if (hit == null && miss != null) hit = Math.max(0, input - miss)
    if (miss == null && hit != null) miss = Math.max(0, input - hit)
  }
  if (hit == null && miss == null && input == null && output == null) return null
  return { input, output, hit, miss }
}

// ── 调用类型标签 ─────────────────────────────────────────────────────────────

/**
 * 判定类调用共用同一个 `judgeLLM` 入口（注入给 lib/ 各模块的 `callLLM`），拿不到调用方名字，
 * 所以按**判定指令的首句**认类型。标记都取自各指令文件的第一句：
 *   lib/topicize.js / lib/topic-stack.js / lib/segment-stack.js / lib/thread-question.js
 *   lib/knowledge-graph.js / lib/agreement.js
 *
 * ⚠️ 这是**只影响报表分档**的诊断标记，不是逻辑分支：改了判定指令的字面，最坏结果是这类
 * 调用被记成「判定」（少一档细分），**不会**影响任何判定结果。改指令时顺手改一下这张表。
 */
const KIND_MARKERS = [
  ['引用解析', '动作③「引用解析」'],
  ['判专题化', '动作①「判专题化」'],
  ['分段判同一性', '现在做固化后分段'],
  ['判同一性', '现在判断：下面这条新消息'],
  ['归纳问题', '下面是一次专题化讨论的完整对话'],
  ['派生point', '归纳知识点表述（point）'],
  ['派生能指', '写可指认的说法（aliases）'],
  ['相处规则', '「相处规则」维护员'],
  ['记忆固化', '以下是讨论的记录（每条前面已标注'],
]

/** 从一次判定调用的 prompt 里认类型；认不出记「判定」。 */
export function inferKind(prompt) {
  const p = String(prompt || '')
  if (!p) return '判定'
  for (const [kind, marker] of KIND_MARKERS) {
    if (p.includes(marker)) return kind
  }
  return '判定'
}

// ── 落盘 + 控制台 ────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-US')   // 千分位固定用英文格式：不受系统区域设置影响
const pct = (hit, input) => (input ? `${((hit / input) * 100).toFixed(1)}%` : '—')
const secs = (ms) => (Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : '')

/**
 * 追加一行用量记录（**不打印**，供测试与批量导入用）。
 * @param {object} rec {ts, kind, conv?, model?, stream?, ms?, input, output, hit, miss}
 * @param {string} [file] 默认 USAGE_FILE
 * @returns {object|null} 实际写进去的那条记录（ts 缺省时补当前时间）；写失败返回 null
 */
export function appendUsage(rec, file = USAGE_FILE) {
  const row = {
    ts: Number(rec?.ts) || Date.now(),
    kind: String(rec?.kind || '判定'),
    ...(rec?.conv ? { conv: String(rec.conv) } : {}),
    ...(rec?.model ? { model: String(rec.model) } : {}),
    stream: !!rec?.stream,
    ms: num(rec?.ms),
    input: num(rec?.input),
    hit: num(rec?.hit),
    miss: num(rec?.miss),
    output: num(rec?.output),
  }
  try {
    fs.appendFileSync(file, JSON.stringify(row) + '\n')
    return row
  } catch (e) {
    // 记账失败绝不影响对话：这条流水只是诊断用，磁盘满了/目录没了都不该让用户答不上话
    try { console.log(`  ⚠️ usage 记账失败（不影响对话）：${e.message}`) } catch {}
    return null
  }
}

/**
 * 记一次调用的用量：落盘 + 控制台一行。
 *
 * **本函数永不抛**——它跑在流式解析的循环里，抛一次就会把当前这一帧的正文一起吞掉
 *（那一段文字会从回复里消失，用户只看到回答缺了一句）。所有异常在这里就地吃掉。
 *
 * @param {object} rec 见 appendUsage；`usage` 可直接传 readUsage 的结果（null = 这次没拿到）
 * @param {object} [opts] {file} 换落点（测试用）
 * @returns {object|null} 写进去的那条记录；出异常时 null
 */
export function recordUsage(rec, opts = {}) {
  try {
    const u = rec?.usage || {}
    const row = appendUsage({
      ts: rec?.ts,
      kind: rec?.kind,
      conv: rec?.conv,
      model: rec?.model,
      stream: rec?.stream,
      ms: rec?.ms,
      input: rec?.input ?? u.input,
      output: rec?.output ?? u.output,
      hit: rec?.hit ?? u.hit,
      miss: rec?.miss ?? u.miss,
    }, opts.file)
    if (!row) return null   // 写失败（appendUsage 已打过警告）
    try { console.log(`  [usage] ${row.kind} · ${describeUsage(row)}`) } catch {}
    return row
  } catch (e) {
    try { console.log(`  ⚠️ usage 记账失败（不影响对话）：${(e && e.message) || e}`) } catch {}
    return null
  }
}

/** 一行可读的用量描述（报表脚本也复用它）。 */
export function describeUsage(row) {
  const parts = []
  if (row.input != null) parts.push(`输入 ${nf.format(row.input)}`)
  if (row.hit != null && row.miss != null) {
    parts.push(`命中 ${nf.format(row.hit)} / 未命中 ${nf.format(row.miss)}（${pct(row.hit, row.hit + row.miss)}）`)
  } else if (row.hit != null) {
    parts.push(`命中 ${nf.format(row.hit)}`)
  } else {
    parts.push('该服务商未回报缓存命中数')
  }
  if (row.output != null) parts.push(`输出 ${nf.format(row.output)}`)
  if (row.ms != null) parts.push(secs(row.ms))
  return parts.join(' · ')
}
