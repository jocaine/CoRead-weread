import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_EMBEDDING_DIR } from './paths.js'

export const LOCAL_EMBEDDING_MODEL = 'bge-small-zh-v1.5'
export const LOCAL_EMBEDDING_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
export const LOCAL_EMBEDDING_RUNTIME = 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'
export const LOCAL_EMBEDDING_FILES = {
  'config.json': 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'tokenizer_config.json': 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  'onnx/model_quantized.onnx': '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
}
export const LOCAL_EMBEDDING_BINDING = path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3', process.platform, process.arch, 'onnxruntime_binding.node')

export function localEmbeddingStatus(dir = LOCAL_EMBEDDING_DIR) {
  const fileSize = (file) => {
    try {
      const stat = fs.statSync(path.join(dir, file), { throwIfNoEntry: false })
      return stat?.isFile() ? stat.size : 0
    } catch { return 0 }
  }
  const sizes = Object.keys(LOCAL_EMBEDDING_FILES).map(file => fileSize(path.join(LOCAL_EMBEDDING_MODEL, file)))
  const modelFiles = sizes.every(Boolean)
  const runtimeFiles = Boolean(fileSize(LOCAL_EMBEDDING_RUNTIME) && fileSize(LOCAL_EMBEDDING_BINDING)
    && (process.platform !== 'win32' || fileSize(path.join(path.dirname(LOCAL_EMBEDDING_BINDING), 'onnxruntime.dll'))))
  return {
    model: LOCAL_EMBEDDING_MODEL,
    modelFiles,
    runtimeFiles,
    modelBytes: modelFiles ? sizes.reduce((sum, size) => sum + size, 0) : null,
    threshold: localGraphEmbedding.threshold,
  }
}

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
