import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { LOCAL_EMBEDDING_DIR } from '../lib/paths.js'
import {
  LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION, LOCAL_EMBEDDING_RUNTIME,
  LOCAL_EMBEDDING_FILES, LOCAL_EMBEDDING_BINDING, localGraphEmbedding,
} from '../lib/local-embedding.js'

const [option, stage] = process.argv.slice(2)
if (option && (option !== '--stage' || !stage)) throw Error('用法：prepare-local-embedding.mjs [--stage 便携包模型目录]')
if (stage && (process.platform !== 'win32' || process.arch !== 'x64')) throw Error('便携包的本地模型组件需要在 Windows x64 上准备')

const modelDir = path.join(LOCAL_EMBEDDING_DIR, LOCAL_EMBEDDING_MODEL)
const assetPath = `Xenova/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}`
const checksum = (file) => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
for (const [name, expected] of Object.entries(LOCAL_EMBEDDING_FILES)) {
  const file = path.join(modelDir, name)
  if (checksum(file) === expected) continue
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
      const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
      const result = spawnSync(curl, ['-fLsS', '--connect-timeout', '8', '--max-time', '75', '-o', temp, `${host}/${assetPath}/${name}`], { stdio: 'inherit' })
      if (result.status === 0 && checksum(temp) === expected) {
        fs.renameSync(temp, file)
        break
      }
    }
    if (checksum(file) !== expected) throw Error(`无法准备模型文件：${name}`)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

const modules = path.join(LOCAL_EMBEDDING_DIR, 'node_modules')
const runtime = path.join(LOCAL_EMBEDDING_DIR, LOCAL_EMBEDDING_RUNTIME)
const binding = path.join(LOCAL_EMBEDDING_DIR, LOCAL_EMBEDDING_BINDING)
if (!fs.existsSync(runtime) || !fs.existsSync(binding)) {
  const windows = process.platform === 'win32'
  const command = windows ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const args = windows
    ? ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund']
    : ['ci', '--omit=dev', '--no-audit', '--no-fund']
  const npm = spawnSync(command, args, { cwd: LOCAL_EMBEDDING_DIR, stdio: 'inherit' })
  if (npm.status !== 0) throw Error('本地模型组件安装失败，请检查 Node.js、npm 和网络连接')
}

if (stage) {
  const dest = path.resolve(stage)
  if (dest === path.resolve(LOCAL_EMBEDDING_DIR)) throw Error('便携包模型目录必须与开发目录分开')
  for (const name of Object.keys(LOCAL_EMBEDDING_FILES)) {
    const file = path.join(dest, LOCAL_EMBEDDING_MODEL, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(path.join(modelDir, name), file)
  }
  fs.copyFileSync(path.join(LOCAL_EMBEDDING_DIR, 'LICENSE-BGE.txt'), path.join(dest, 'LICENSE-BGE.txt'))
  // 已验证 Windows CPU 运行只用这一份平台组件和 Node 的 ESM 入口。
  fs.cpSync(modules, path.join(dest, 'node_modules'), { recursive: true, filter(file) {
    const name = path.relative(modules, file).split(path.sep).join('/')
    if (/^(\.bin|\.package-lock\.json|onnxruntime-web|@types)(\/|$)/.test(name)) return false
    if (/^onnxruntime-node\/bin\/napi-v3\/(linux|darwin|win32\/arm64)(\/|$)/.test(name)) return false
    if (/^@huggingface\/transformers\/(src|types)(\/|$)/.test(name)) return false
    if (name.startsWith('@huggingface/transformers/dist/')) return name.endsWith('/transformers.node.mjs')
    return true
  } })
}

await localGraphEmbedding.embed(['会意检索模型检查'])
console.log(`本地会意检索模型就绪：${stage || modelDir}`)
