/**
 * 模型 API 配置（2026-10）：插件侧栏「⋯ → 模型 API 配置」写入，agent 与脚本读取。
 *
 * 真源两级，插件优先：
 *   1. data\config\api-config.json —— 侧栏经 receiver 写入（本机单用户工具，字段明文）。
 *      文件里一旦出现某字段，该字段就以文件为准（**即使是空串**）——避免用户在插件里
 *      清空 key 后又被 .env 的旧值「复活」，保证界面显示与实际取值永远一致。
 *   2. COREAD_* 配置 —— 先看进程环境变量，再看 data\config\env 文件本身。
 *      receiver 启动时不带环境变量文件，靠这里兜底解析，让「到底配没配」在插件界面里显示一致。
 *
 * 位置由 lib/paths.js 决定（唯一真源）：2026-10 目录重构后落在 <包根>\data\config\，
 * 与阅读数据分开一格——因为这里面有**密钥明文**，备份分享时要能单独剔除。
 *
 * 调用方在每次 LLM 请求前 resolveApiConfig()：在插件里改完配置无需重启 agent。
 * 本模块只读写本机文件，不发网络请求，也不打印任何 key。
 */

import fs from 'fs'
import path from 'path'
import { API_CONFIG_FILE, ENV_FILE } from './paths.js'

export { API_CONFIG_FILE, ENV_FILE }
export const DEFAULT_MODEL = 'gpt-4o'
export const CONFIG_KEYS = ['apiBase', 'apiKey', 'model']

/**
 * 读插件写入的配置文件；不存在/坏 JSON 都当空对象（调用方回退 .env）。
 */
export function readApiConfigFile(file = API_CONFIG_FILE) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {}
  } catch { return {} }
}

/**
 * 解析 agent/.env（极简 dotenv 子集：KEY=VALUE，可选 export 前缀与成对引号）。
 * 注释行、空行、非 KEY= 的行一律跳过；值只做去引号，不做变量展开。
 */
export function readEnvFile(envFile = ENV_FILE) {
  const out = {}
  let raw = ''
  try { raw = fs.readFileSync(envFile, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

/**
 * 校验插件提交的配置；通过时返回规范化后的值（apiBase 去掉尾斜杠）。
 * @returns {{ok: true, value: {apiBase: string, apiKey: string, model: string}} | {ok: false, error: string}}
 */
export function validateApiConfigInput(data) {
  const apiBase = String(data?.apiBase ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(data?.apiKey ?? '').trim()
  const model = String(data?.model ?? '').trim()

  if (!apiBase) return { ok: false, error: '请填写 API 地址' }
  let url = null
  try { url = new URL(apiBase) } catch { return { ok: false, error: 'API 地址不是合法的 URL' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'API 地址只支持 http / https' }
  }
  if (!apiKey) return { ok: false, error: '请填写 API Key' }
  if (!model) return { ok: false, error: '请填写模型名' }

  return { ok: true, value: { apiBase, apiKey, model } }
}

/**
 * 落盘插件配置（apiBase/apiKey/model 三个字段整体覆盖）。
 * POSIX 下按 0600 写（只有本用户可读）；Windows 上 mode 基本被忽略。
 */
export function writeApiConfig(value, file = API_CONFIG_FILE) {
  const payload = {
    apiBase: String(value?.apiBase ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(value?.apiKey ?? '').trim(),
    model: String(value?.model ?? '').trim(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
  return payload
}

/**
 * 生效配置 = 配置文件（若该字段存在）> 进程环境变量 > agent/.env 文件。
 * model 缺省回退 DEFAULT_MODEL，保持与旧版 COREAD_MODEL || 'gpt-4o' 一致。
 * configFile / envFile 可注入，便于单测不碰真实文件。
 * @returns {{apiBase: string, apiKey: string, model: string, source: 'plugin'|'env'|'none'}}
 */
export function resolveApiConfig(env = process.env, configFile = API_CONFIG_FILE, envFile = ENV_FILE) {
  const file = readApiConfigFile(configFile)
  const fileEnv = readEnvFile(envFile)
  const from = (key, envKey) => {
    if (Object.prototype.hasOwnProperty.call(file, key)) return String(file[key] ?? '').trim()
    const fromProcess = env && env[envKey] != null ? String(env[envKey]).trim() : ''
    if (fromProcess) return fromProcess
    return String(fileEnv[envKey] ?? '').trim()
  }

  const apiBase = from('apiBase', 'COREAD_API_BASE').replace(/\/+$/, '')
  const apiKey = from('apiKey', 'COREAD_API_KEY')
  const model = from('model', 'COREAD_MODEL') || DEFAULT_MODEL

  const hasFileConfig = CONFIG_KEYS.some((k) => Object.prototype.hasOwnProperty.call(file, k))
  const source = hasFileConfig ? 'plugin' : ((apiKey || apiBase) ? 'env' : 'none')
  return { apiBase, apiKey, model, source }
}

/**
 * 「配置齐了吗」：地址 + key 是最低要求（model 有默认值）。
 * 未配置时 agent 照常运行（等插件写入），只有真正调用 LLM 时才报错。
 */
export function isConfigured(cfg) {
  return !!(cfg && cfg.apiKey && cfg.apiBase)
}
