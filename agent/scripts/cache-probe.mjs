#!/usr/bin/env node
/**
 * 交错调用缓存实验：不同种类调用挨个调用后，同类请求是否还能命中。
 *
 * 场景模拟真实调用序列：
 *   C1 引用解析（JUDGE_SYSTEM + 指令 + 节点 + 发言X）
 *   D1 主回复   （完整 SYSTEM + 历史 + 消息1）
 *   D2 主回复   （完整 SYSTEM + 历史+消息1 + 消息2，追加式）
 *   C2 引用解析（JUDGE_SYSTEM + 指令 + 节点 + 发言Y）← 与 C1 同类，中间隔了 D1/D2
 *
 * 若缓存是"全局多链、按内容+位置寻址"：C2 应命中 C1 的节点列表（≈92%）。
 * 若缓存是"只留最近一条链"：C2 只会和 D2 比，命中 ≈ 0%。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env')
const env = {}
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Z_]+)\s*=\s*(.+)$/)
    if (m) env[m[1]] = m[2].trim()
  }
}
const API_KEY = env.COREAD_API_KEY || ''
const API_BASE = (env.COREAD_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = env.COREAD_MODEL || 'deepseek-chat'

const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
const FULL_SYSTEM = '你是长期共读伙伴。' + ('行为规则与用户画像：' + '保持交锋、不空谈、落到具体机制。').repeat(40) // 模拟完整 SYSTEM 的体量
const INSTRUCTION = '你是 CoRead 的「会意系统」，现在执行动作③「引用解析」。判定标准：① 指认性表述；② 内容线索；③ 语义匹配。宁漏勿误，不许发明。'
const nodeList = Array.from({ length: 55 }, (_, i) => `- n_d_${i}：「知识点 ${i} 的收口问题描述，包含若干能指与讨论过的问题」`).join('\n')
const sayX = '用户发言：我想到我们之前说的苏联工业化历史，它与南美工业化改革有相似走向。'
const sayY = '用户发言：我们再来谈谈芬兰建国的历史条件吧，上次聊到的白色政权框架。'
const histMsg = (n) => `这是历史消息第 ${n} 条，讨论内容 ${n}：` + `承接上文的讨论要点${n}。`.repeat(60)
const userMsg = (n) => `用户本次提问 ${n}：` + `这个问题怎么看${n}？`.repeat(20)

async function call(label, system, content) {
  const t0 = Date.now()
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content }], max_tokens: 4, temperature: 0, tool_choice: 'none' }),
  })
  const data = await resp.json()
  const u = data.usage || {}
  const hit = u.prompt_cache_hit_tokens != null
    ? u.prompt_cache_hit_tokens
    : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  const total = u.prompt_tokens || 0
  console.log(`${label.padEnd(30)} total=${String(total).padEnd(6)} hit=${String(hit).padEnd(6)} 命中率=${total ? (100 * hit / total).toFixed(1) : '-'}%  (${Date.now() - t0}ms)`)
}

async function main() {
  if (!API_KEY) { console.log('无 COREAD_API_KEY，跳过实测'); return }
  console.log(`model=${MODEL}\n`)

  // 引用解析模板：JUDGE_SYSTEM + 指令 + 节点列表 + 发言（节点在前）
  const judgeC = (say) => `${INSTRUCTION}\n\n知识点节点：\n${nodeList}\n\n${say}`

  await call('C1 引用解析(发言X)', JUDGE_SYSTEM, judgeC(sayX))
  await sleep(5000)
  await call('D1 主回复(历史1)', FULL_SYSTEM, histMsg(1) + '\n' + userMsg(1))
  await sleep(5000)
  await call('D2 主回复(历史1+2)', FULL_SYSTEM, histMsg(1) + '\n' + histMsg(2) + '\n' + userMsg(2))
  await sleep(5000)
  await call('C2 引用解析(发言Y)', JUDGE_SYSTEM, judgeC(sayY))   // 同类，中间隔了 D1/D2，且留足落盘时间
  await sleep(5000)
  await call('C3 引用解析(发言Z)', JUDGE_SYSTEM, judgeC('用户发言：再来一个完全不同的问题。'))

  console.log('\n预期（全局多链 + 落盘延迟）：C2 命中 ≈ C1 的节点列表（1408）；C3 命中 ≈ C2。')
  console.log('若 C2 仍 ≈0：说明缓存只保留最近一条链，多链不成立。')
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
main().catch((e) => { console.error('实验失败:', e.message); process.exit(1) })
