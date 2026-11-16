import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_EMBEDDING_DIR } from './paths.js'

export const LOCAL_EMBEDDING_MODEL = 'bge-small-zh-v1.5'
export const LOCAL_EMBEDDING_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
export const LOCAL_EMBEDDING_RUNTIME = 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'

let loading

async function loadModel() {
  const runtime = pathToFileURL(path.join(LOCAL_EMBEDDING_DIR, LOCAL_EMBEDDING_RUNTIME))
  const { env, pipeline } = await import(runtime.href)
  env.allowRemoteModels = false
  env.localModelPath = LOCAL_EMBEDDING_DIR + path.sep
  return pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, {
    device: 'cpu', dtype: 'q8', session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
  })
}

export const localGraphEmbedding = {
  id: `${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_REVISION}:q8-cls`,
  threshold: 0.59,
  async embed(texts) {
    loading ??= loadModel().catch(error => {
      loading = undefined
      throw error
    })
    const model = await loading
    const rows = (await model(texts, { pooling: 'cls', normalize: true })).tolist()
    if (rows.length !== texts.length || rows.some(row => row.length !== 512 || !row.every(Number.isFinite))) {
      throw new Error('本地模型返回了无效的向量')
    }
    return rows.map(row => Float32Array.from(row))
  },
}
