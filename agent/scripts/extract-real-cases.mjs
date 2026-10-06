#!/usr/bin/env node
/**
 * 从微信读书聊天流（receiver/inbox/chat_input.jsonl）提取某本书的真实讨论单元，
 * 生成 judge-real-cases.json 的 cases 段（纯数据文件，结果在 judge-real-results.json）。
 * 可重复运行：已有 results 按 timestamp 保留（id 可能因插入新消息而移位）。
 *
 * 判定材料 = 用户真实提问（判专题化必须 userNote）；划线仅用于解析提问中的指代。
 * 数据文件忠实保留数据源行结构（role/content/timestamp/bookId/bookTitle/chapter/chapterUid/selectedText）
 * + 位置 id；note/sel/chapter/quoted 等派生字段由 lib/chat-input.js 在读取时解析，
 * 不进数据文件（保证数据文件结构与真实数据源一致）。
 *
 * 用法：node --env-file-if-exists=.env scripts/extract-real-cases.mjs [bookIdPrefix,...]
 * 默认提取《静静的顿河》（ee442b...f24）；多个前缀用逗号分隔（多书全量）。
 *
 * 数据源（2026-10 目录重构后）：`data\backups\chat_input.export.jsonl`
 * —— 老路径 `receiver\inbox\chat_input.jsonl` 已不在线。缺文件时先跑
 * `node agent/scripts/export-chat.mjs` 导一份只读副本（脚本会提示）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { requireExportedJsonl, DEVDATA_DIR } from '../lib/paths.js'  // 数据路径唯一真源
import { parseMessage } from '../lib/chat-input.js'

const INBOX = requireExportedJsonl('input')
// 产物落在仓库根的 devdata\（2026-10 从 agent/scripts/data/ 挪出来：私人语料不该躺在
// 打包源目录隔壁）。详见 lib/paths.js 里 DEVDATA_DIR 的注释。
const DATA = path.join(DEVDATA_DIR, 'judge-real-cases.json')

// 默认《静静的顿河》；可用参数覆盖（逗号分隔多个 baseBookId 前缀，如 'ee442b83,6f742a63,54a42df3'）
const PREFIXES = (process.argv[2] || 'ee442b83643425f356d5638653338624e334c58373064373159317268353955f24')
  .split(',').map((s) => s.trim()).filter(Boolean)

// 全局规则：个人数据先备份后读写（单份最新备份，与 portrait.md.bak 同约定）
fs.copyFileSync(INBOX, `${INBOX}.bak`)

const cases = []
const seenTs = new Set()
for (const line of fs.readFileSync(INBOX, 'utf-8').split('\n')) {
  if (!line.trim()) continue
  let d
  try { d = JSON.parse(line) } catch { continue }
  if (!PREFIXES.some((p) => String(d.bookId || '').startsWith(p))) continue
  const ts = d.timestamp
  if (seenTs.has(ts)) continue  // 同一条消息重复落盘去重
  seenTs.add(ts)
  if (!parseMessage(d).note) continue  // 无提问内容的跳过（如纯空）
  cases.push({ ...d, id: cases.length + 1 })
}
cases.sort((a, b) => a.timestamp - b.timestamp)
cases.forEach((c, i) => { c.id = i + 1 })

const out = {
  book: '多书（' + PREFIXES.join(',') + '）',
  source: `${INBOX}（${PREFIXES.join(',')}，${cases.length} 条用户消息）`,
  cases,
}
fs.mkdirSync(path.dirname(DATA), { recursive: true })
fs.copyFileSync(DATA, DATA + '.bak')  // 先备份，后写回
fs.writeFileSync(DATA, JSON.stringify(out, null, 2) + '\n', 'utf-8')

// 结果文件（judge-real-results.json）不在此写：results 是瞬态中间数据，由 judge 写、group 消费后丢弃；
// 分组输出按 timestamp 关联，重提取后 id 移位不影响（judge 从分组输出重建判专题化结论）。
console.log(`已提取 ${cases.length} 条真实讨论单元（引用 ${cases.filter((c) => parseMessage(c).quoted).length} / 纯提问 ${cases.filter((c) => !parseMessage(c).quoted).length}）→ ${path.relative(process.cwd(), DATA)}`)
