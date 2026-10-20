#!/usr/bin/env node
/**
 * 历史恢复的两条硬约束（2026-11 修，按源码钉住）
 *
 * 回归背景：这两条都出过事，而且**故障形态是"什么都不报，只是忘事"**——
 * 用户看到的是"它怎么不记得我们聊到哪了"，日志里一行红都没有。所以用源码断言钉死。
 *
 * ① 取数范围只能由截尾点位（afterId）决定。
 *    旧实现 `loadTurns(key, { limit: 60 })` + `Math.min(histCutCursors[key], list.length)`
 *    跳过开头：LIMIT 数的是消息行（60 行 = 30 轮），而旧游标是"累计切掉条数"（一次截尾
 *    就跳 ~118）。两个坐标一减，游标一旦超过 60 就跳过整段 —— 实测两本书的游标 148 / 158
 *    正踩线上，**重启后整本书的历史为空**。
 *
 * ② hist 条目上的 `id` 绝不能发出去。
 *    `id` 是本机记截尾点位用的，不是对话内容。展开进 messages 会让请求体每条都多一个字段，
 *    而服务端前缀缓存是**按字节比对**的——命中率当场归零（DeepSeek-flash 命中/未命中差
 *    50 倍单价，见 docs 价格页）。在线时肉眼看不出任何异常，只是账单变厚。
 *
 * 跑法：node agent/test/hist-restore.test.js
 * （沙箱里 `node --test` 整目录会 EPERM，见 sidebar-reader-entry.test.js 的说明）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')

test('恢复历史：范围由 afterId 决定，禁止"固定取 N 条 + 按条数跳过"', () => {
  assert.match(SRC, /loadTurns\(key,\s*\{\s*afterId\s*\}\)/, '恢复必须按 afterId 取数')
  assert.doesNotMatch(SRC, /Math\.min\(histCutCursors/, '禁止再按"累计切掉条数"跳过开头（会整段清空）')
  assert.doesNotMatch(SRC, /histCutCursors\[key\]\s*\|\|\s*0/, '点位已是对象 { afterId }，不能再当数字用')
  assert.match(SRC, /function cursorAfterId/, '读点位必须走 cursorAfterId（统一处理旧格式数字）')
})

test('截尾点位：记的是消息 id，不是条数', () => {
  assert.match(SRC, /histCutCursors\[key\] = \{ afterId: lastId \}/, '截尾时记"切到哪条消息"')
  assert.doesNotMatch(SRC, /histCutCursors\[key\] = \(histCutCursors\[key\] \|\| 0\) \+/, '禁止再累加条数')
})

test('hist 条目上的 id 不发 API（多一个字段 = 前缀缓存全失配）', () => {
  assert.match(SRC, /function apiMessages\(list\)/, '必须有剥离函数')
  assert.match(SRC, /\{ role: m\.role, content: m\.content \}/, 'apiMessages 只留 role/content')
  const used = SRC.match(/\.\.\.apiMessages\(hist\)/g) || []
  assert.equal(used.length, 2, `两处 API 调用（callLLMOnce / callLLMStream）都要过 apiMessages，实际 ${used.length} 处`)
  assert.doesNotMatch(SRC, /messages:\s*\[[^\]]*\.\.\.hist/, '禁止再把 hist 原样展开进 messages')
})
