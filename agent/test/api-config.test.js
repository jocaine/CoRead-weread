/**
 * 模型 API 配置（lib/api-config.js）单测：
 *   1. 校验：地址/Key/模型 空值与非法 URL 的报错；规范化去掉尾斜杠
 *   2. 落盘 → 读回（临时文件，绝不碰真实的 agent/api-config.json）
 *   3. 生效优先级：插件文件 > 进程环境变量 > agent/.env 文件
 *
 * 注意：resolveApiConfig 的 .env 回退读的是固定路径（agent/.env），因此断言只覆盖
 * "进程环境变量已提供" 的路径；文件优先级用显式 configFile 覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  validateApiConfigInput,
  writeApiConfig,
  readApiConfigFile,
  resolveApiConfig,
  isConfigured,
} from '../lib/api-config.js'

function tmpConfigFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-api-config-'))
  return path.join(dir, 'api-config.json')
}

test('validateApiConfigInput 拒绝空值与非法地址', () => {
  assert.equal(validateApiConfigInput({}).ok, false)
  assert.match(validateApiConfigInput({}).error, /API 地址/)
  assert.match(validateApiConfigInput({ apiBase: 'https://x/v1' }).error, /API Key/)
  assert.match(validateApiConfigInput({ apiBase: 'https://x/v1', apiKey: 'k' }).error, /模型/)
  assert.match(validateApiConfigInput({ apiBase: '不是地址', apiKey: 'k', model: 'm' }).error, /URL/)
  assert.match(validateApiConfigInput({ apiBase: 'ftp://x/v1', apiKey: 'k', model: 'm' }).error, /http/)
})

test('validateApiConfigInput 去空格与尾斜杠', () => {
  const r = validateApiConfigInput({ apiBase: ' https://api.deepseek.com/v1/ ', apiKey: ' sk-1 ', model: ' deepseek-chat ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-1', model: 'deepseek-chat' })
})

test('writeApiConfig / readApiConfigFile 往返（临时文件）', () => {
  const file = tmpConfigFile()
  assert.deepEqual(readApiConfigFile(file), {})
  writeApiConfig({ apiBase: 'https://api.deepseek.com/v1/', apiKey: 'sk-abc', model: 'deepseek-chat' }, file)
  assert.deepEqual(readApiConfigFile(file), {
    apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-abc', model: 'deepseek-chat',
  })
  fs.writeFileSync(file, '{ 坏 JSON')
  assert.deepEqual(readApiConfigFile(file), {})
})

test('resolveApiConfig：插件文件优先于进程环境变量', () => {
  const file = tmpConfigFile()
  writeApiConfig({ apiBase: 'https://plugin.example/v1', apiKey: 'plugin-key', model: 'plugin-model' }, file)
  const cfg = resolveApiConfig(
    { COREAD_API_BASE: 'https://env.example/v1', COREAD_API_KEY: 'env-key', COREAD_MODEL: 'env-model' },
    file, path.join(path.dirname(file), 'no-such.env'))
  assert.deepEqual(cfg, {
    apiBase: 'https://plugin.example/v1', apiKey: 'plugin-key', model: 'plugin-model', source: 'plugin',
  })
})

test('resolveApiConfig：文件里显式空值不再回退 .env（避免界面显示与实际取值不一致）', () => {
  const file = tmpConfigFile()
  writeApiConfig({ apiBase: '', apiKey: '', model: '' }, file)
  const cfg = resolveApiConfig(
    { COREAD_API_BASE: 'https://env.example/v1', COREAD_API_KEY: 'env-key' },
    file, path.join(path.dirname(file), 'no-such.env'))
  assert.equal(cfg.apiKey, '')
  assert.equal(cfg.apiBase, '')
  assert.equal(cfg.source, 'plugin')
  assert.equal(isConfigured(cfg), false)
})

test('resolveApiConfig：无插件文件时用进程环境变量，model 缺省回退 gpt-4o', () => {
  const file = tmpConfigFile()
  const cfg = resolveApiConfig(
    { COREAD_API_BASE: 'https://env.example/v1/', COREAD_API_KEY: 'env-key' },
    file, path.join(path.dirname(file), 'no-such.env'))
  assert.deepEqual(cfg, {
    apiBase: 'https://env.example/v1', apiKey: 'env-key', model: 'gpt-4o', source: 'env',
  })
  assert.equal(isConfigured(cfg), true)
})

test('resolveApiConfig：进程环境变量缺失时回退 agent/.env 文件（receiver 不带 --env-file 的场景）', () => {
  const file = tmpConfigFile()
  const envFile = path.join(path.dirname(file), '.env')
  fs.writeFileSync(envFile, [
    '# 注释行不参与解析',
    'COREAD_API_KEY=from-env-file',
    'export COREAD_API_BASE="https://dotenv.example/v1/"',
    'COREAD_MODEL=dotenv-model',
    '',
  ].join('\n'))
  const cfg = resolveApiConfig({}, file, envFile)
  assert.deepEqual(cfg, {
    apiBase: 'https://dotenv.example/v1', apiKey: 'from-env-file', model: 'dotenv-model', source: 'env',
  })
})

test('resolveApiConfig：什么都没有 → 未配置且 model 仍是默认值', () => {
  const file = tmpConfigFile()
  const cfg = resolveApiConfig({}, file, path.join(path.dirname(file), 'no-such.env'))
  assert.equal(cfg.source, 'none')
  assert.equal(isConfigured(cfg), false)
  assert.equal(cfg.model, 'gpt-4o')
})

test('isConfigured：地址或 key 缺一即为未配置（model 有默认值）', () => {
  assert.equal(isConfigured({ apiBase: 'https://x/v1', apiKey: 'k' }), true)
  assert.equal(isConfigured({ apiBase: '', apiKey: 'k' }), false)
  assert.equal(isConfigured({ apiBase: 'https://x/v1', apiKey: '' }), false)
  assert.equal(isConfigured(null), false)
})
