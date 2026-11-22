import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { writeFileAtomic } from './atomic-write.js'

const BATCH_SIZE = 10
const CONCURRENCY = 3
// 余弦相似度的门槛。查询和描述都已归一化，越接近 1 表示越相似。
const MIN_SIMILARITY = 0.48
export const MAX_CANDIDATES = 8
const RETRY_DELAY = 60_000

const keyOf = text => createHash('sha256').update(text).digest('hex')
const uniqueTexts = texts => [...new Set(texts.filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))]

export function graphSearchTexts(node) {
  // 新节点只索引统一描述。空数组是收口时有意不产出描述，不回退到展示标题。
  if (Array.isArray(node.descriptions)) return uniqueTexts(node.descriptions)
  const aliases = Array.isArray(node.aliases) ? node.aliases : []
  const questions = Array.isArray(node.discussions) ? node.discussions.map(d => d?.question) : []
  return uniqueTexts([node.point, ...aliases, ...questions])
}

function unitVector(values) {
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw new Error('向量内容无效')
  const len = Math.sqrt(values.reduce((s, x) => s + x * x, 0))
  if (!Number.isFinite(len) || !len) throw new Error('向量长度无效')
  return Float32Array.from(values, x => x / len)
}

export async function requestEmbeddings(config, input, fetchImpl = fetch) {
  const response = await fetchImpl(config.embedBase + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embedKey}` },
    body: JSON.stringify({ model: config.embedModel, input, encoding_format: 'float' }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`向量服务 HTTP ${response.status}`)
  const { data } = await response.json()
  if (!Array.isArray(data) || data.length !== input.length) throw new Error('向量条数不一致')
  const vectors = Array(input.length).fill(null)
  for (const row of data) {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= input.length || vectors[row.index]) {
      throw new Error('向量序号无效')
    }
    vectors[row.index] = unitVector(row.embedding)
  }
  if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('向量维数不一致')
  return vectors
}

function readCache(file, namespace) {
  const out = new Map()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed.namespace !== namespace || !Number.isInteger(parsed.dims) || parsed.dims <= 0) return out
    for (const [hash, encoded] of Object.entries(parsed.vectors)) {
      const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'))
      if (bytes.length !== parsed.dims * 4) return new Map()
      const vector = new Float32Array(bytes.buffer)
      if (!vector.every(Number.isFinite) || !vector.some(Boolean)) return new Map()
      out.set(hash, vector)
    }
  } catch { return new Map() }
  return out
}

export function createGraphVectorSearch({ cacheFile, fetchImpl = fetch, localEmbedding, log = () => {} } = {}) {
  let active
  const threshold = localEmbedding?.threshold ?? MIN_SIMILARITY
  const embed = (config, input) => localEmbedding
    ? localEmbedding.embed(input)
    : requestEmbeddings(config, input, fetchImpl)

  // 启动/图变动时在后台补算；回答前用 ready 等待准备完整。
  function prepare(nodes, config) {
    if (!localEmbedding && !config?.configured) { active = null; return null }
    const namespace = localEmbedding
      ? JSON.stringify([1, 'local', localEmbedding.id])
      : JSON.stringify([1, config.embedBase, config.embedModel])
    if (!active || active.namespace !== namespace || active.config?.embedKey !== config?.embedKey) {
      active = { namespace, config, vectors: readCache(cacheFile, namespace), pending: null, retryAt: 0, error: null }
    }
    const state = active
    const inputs = new Map()
    const entries = []
    for (const node of nodes) {
      if (typeof node?.id !== 'string' || !node.id) continue
      for (const text of graphSearchTexts(node)) {
        const hash = keyOf(text)
        inputs.set(hash, text)
        entries.push({ node, hash })
      }
    }
    const missing = [...inputs].filter(([hash]) => !state.vectors.has(hash))
    if (!missing.length && !state.pending) return { state, entries }
    if (!state.pending && Date.now() >= state.retryAt) {
      state.error = null
      const build = async () => {
        let next = 0
        let failure
        let dims = state.vectors.values().next().value?.length
        const worker = async () => {
          while (!failure && next < missing.length && active === state) {
            const from = next
            next += BATCH_SIZE
            const batch = missing.slice(from, from + BATCH_SIZE)
            try {
              const vectors = await embed(config, batch.map(([, text]) => text))
              dims ??= vectors[0].length
              if (vectors[0].length !== dims) {
                state.vectors.clear()
                throw new Error('向量维数已变，将重建索引')
              }
              if (!failure) batch.forEach(([hash], i) => state.vectors.set(hash, vectors[i]))
            } catch (e) { failure ??= e }
          }
        }
        await Promise.all(Array.from({ length: localEmbedding ? 1 : CONCURRENCY }, worker))
        if (active !== state) return
        if (failure) throw failure
        state.vectors = new Map([...inputs.keys()].map(hash => [hash, state.vectors.get(hash)]))
        if (cacheFile && !writeFileAtomic(cacheFile, JSON.stringify({
          namespace, dims,
          vectors: Object.fromEntries([...state.vectors].map(([hash, v]) => [hash, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')])),
        }))) log('向量索引保存失败，本次仍可使用')
        log(`向量索引就绪：${entries.length} 条描述，本次新增 ${missing.length} 条`)
      }
      state.pending = build().catch(e => {
        state.error = e
        state.retryAt = Date.now() + RETRY_DELAY
        log(`向量索引暂不可用：${e.message}`)
      }).finally(() => { state.pending = null })
    }
    return null
  }

  async function search(query, prepared) {
    const { state, entries } = prepared
    if (!entries.length) return []
    const [queryVector] = await embed(state.config, [query])
    const matches = new Map()
    for (const { node, hash } of entries) {
      const vector = state.vectors.get(hash)
      if (vector?.length !== queryVector.length) {
        state.vectors.clear()
        throw new Error('查询和索引的向量维数不同，将重建索引')
      }
      let score = 0
      for (let i = 0; i < vector.length; i++) score += vector[i] * queryVector[i]
      if (score >= threshold && score > (matches.get(node.id)?.score ?? -Infinity)) {
        matches.set(node.id, { node, score })
      }
    }
    // 同节点取描述的最高分。超额才用分数决定入选名单，交付时仍沿用图里的顺序。
    let selected = [...matches.values()]
    if (selected.length > MAX_CANDIDATES) {
      const strongest = [...selected].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES)
      const ids = new Set(strongest.map(({ node }) => node.id))
      selected = selected.filter(({ node }) => ids.has(node.id))
    }
    return selected.map(({ node }) => ({ id: node.id, descriptions: graphSearchTexts(node) }))
  }

  async function ready(nodes, config) {
    for (;;) {
      const prepared = prepare(nodes, config)
      if (prepared) return prepared
      const state = active
      if (!state) throw new Error('旧讨论查找尚未配置')
      if (state.pending) await state.pending
      if (active !== state) continue
      if (state.error) throw state.error
    }
  }

  return { prepare, ready, search, waitForIndex: async () => { await active?.pending } }
}
