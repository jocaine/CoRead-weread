// 探针：用真实消息跑一次引用解析，验证新判据（临时脚本）
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveReferences } from '../lib/knowledge-graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = path.join(__dirname, '..')

const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const API_KEY = process.env.COREAD_API_KEY
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'

const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
async function judgeLLM(prompt, maxTokens) {
  const resp = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxTokens || 2048, temperature: 0 }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + JSON.stringify(data).slice(0, 200))
  const msg = data.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

// 图谱节点 brief（与 index.js resolveCitations 一致）
const g = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'data', 'knowledge-graph.json'), 'utf8'))
const nodeBriefs = g.nodes.map((n) => ({
  id: n.id,
  point: n.point,
  aliases: n.aliases,
  questions: (n.discussions || []).map((d) => d.question),
}))

// 取 chat_input.jsonl 最后一条（16:03 那条）
const lines = fs.readFileSync(path.join(AGENT_DIR, '..', 'receiver', 'inbox', 'chat_input.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
const last = JSON.parse(lines[lines.length - 1])
const message = last.content
console.log('消息（ts=' + last.timestamp + '）：' + message.slice(0, 80) + '…')

console.time('resolve')
try {
  const { hits } = await resolveReferences({ message, nodes: nodeBriefs }, {
    callLLM: judgeLLM,
    maxTokens: 16384,
    log: (m) => console.log('  ' + m),
  })
  console.timeEnd('resolve')
  console.log('命中：' + (hits.length ? hits.join(', ') : '(无)'))
  for (const id of hits) {
    const n = g.nodes.find((x) => x.id === id)
    if (n) console.log('  → ' + id + '：「' + n.point + '」')
  }
} catch (e) {
  console.timeEnd('resolve')
  console.log('解析失败：' + e.message)
}
