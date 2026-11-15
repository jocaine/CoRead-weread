// 重新生成旧节点的检索描述。中间结果可续跑；--apply 才写正式图。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { GRAPH_FILE, DEVDATA_DIR, DATA_BACKUPS_DIR } from '../lib/paths.js'
import { resolveApiConfig, isConfigured } from '../lib/api-config.js'
import { completionOnce } from '../lib/llm-api.js'
import { deriveDescriptions, DESCRIPTION_VERSION, DESCRIPTION_INSTRUCTIONS } from '../lib/retrieval-descriptions.js'

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const file = path.join(DEVDATA_DIR, 'scratch', 'description-migration.json')
fs.mkdirSync(path.dirname(file), { recursive: true })
const config = resolveApiConfig()
if (!isConfigured(config)) throw new Error('模型配置不完整')
const promptHash = digest(DESCRIPTION_INSTRUCTIONS)
let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
if (!state) {
  const bytes = fs.readFileSync(GRAPH_FILE)
  fs.mkdirSync(DATA_BACKUPS_DIR, { recursive: true })
  const backup = path.join(DATA_BACKUPS_DIR, `knowledge-graph-before-descriptions-${Date.now()}.json`)
  fs.writeFileSync(backup, bytes, { flag: 'wx' })
  state = { model: config.model, promptHash, version: DESCRIPTION_VERSION, backup, started: new Date().toISOString(), results: {} }
}
if (state.model !== config.model || state.promptHash !== promptHash) throw new Error('模型或提示词已改变，不可混用旧中间结果')
const save = () => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(file + '.tmp', file)
}
save()
const graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'))
if (process.argv.includes('--apply')) {
  // 同步读、校验、写：不跨网络等待；应在停止正式进程后执行。
  for (const node of graph.nodes) {
    const r = state.results[node.id]
    if (!r || r.error || r.sourceHash !== digest(node.discussions)) throw new Error('结果缺失或原文变化：' + node.id)
  }
  const backup = path.join(DATA_BACKUPS_DIR, `knowledge-graph-before-apply-${Date.now()}.json`)
  fs.copyFileSync(GRAPH_FILE, backup, fs.constants.COPYFILE_EXCL)
  for (const node of graph.nodes) {
    const r = state.results[node.id]
    node.descriptions = r.descriptions
    node.aliases = [...r.descriptions] // 现有图界面、引用匹配读端兼容。
    node.descriptionVersion = DESCRIPTION_VERSION
    node.updatedAt = Date.now()
  }
  fs.writeFileSync(GRAPH_FILE + '.tmp', JSON.stringify(graph, null, 2), 'utf8')
  fs.renameSync(GRAPH_FILE + '.tmp', GRAPH_FILE)
  state.applied = { at: new Date().toISOString(), nodes: graph.nodes.length, edges: graph.edges.length, backup }
  save()
  console.log(JSON.stringify(state.applied))
} else {
  let cursor = 0
  let completed = 0
  async function worker() {
    while (cursor < graph.nodes.length) {
      const node = graph.nodes[cursor++]
      const sourceHash = digest(node.discussions)
      if (state.results[node.id]?.sourceHash === sourceHash && !state.results[node.id].error) { completed++; continue }
      const excerpts = (node.discussions || []).flatMap(d => d.excerpts || [])
      const start = Date.now()
      try {
        const { descriptions } = await deriveDescriptions(excerpts, {
          callLLM: async (prompt, maxTokens) => {
            const response = await completionOnce({ ...config, system: '你只负责按用户的指令输出要求格式的结果，不附加任何解释。', prompt, maxTokens, temperature: 0 })
            if (!response.ok) throw new Error('模型输出截断')
            return response.text
          },
        })
        state.results[node.id] = { sourceHash, descriptions, ms: Date.now() - start }
      } catch (e) {
        state.results[node.id] = { sourceHash, error: e.message, ms: Date.now() - start }
      }
      completed++
      save()
      if (completed % 10 === 0 || completed === graph.nodes.length) console.log(JSON.stringify({ completed, total: graph.nodes.length, errors: Object.values(state.results).filter(r => r.error).length }))
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()))
  console.log(JSON.stringify({ staged: Object.keys(state.results).length, errors: Object.values(state.results).filter(r => r.error).length, backup: state.backup, file }))
}
