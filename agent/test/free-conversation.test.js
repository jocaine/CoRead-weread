#!/usr/bin/env node
/**
 * 自由模式多对话（2026-11 用户定调）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/free-conversation.test.js
 *
 * 覆盖：key 生成/校验（默认哨兵 + 新建对话两类都认，别的书 key 不认）、
 * 注册表读写（新建/补登记/改名/活动登记/归档墓碑/彻底删除）、
 * 消息清理（按 bookId / bookKey 精确过滤，不误删别的书）。
 * 全部在临时目录里跑（不碰 agent/data 与 receiver/inbox 的真实数据）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LEGACY_FREE_KEY,
  isFreeKey,
  newFreeKey,
  deriveTitle,
  freeConversationFile,
  readRegistry,
  writeRegistry,
  activeConversations,
  archivedConversations,
  findConversation,
  createConversation,
  ensureLegacyConversation,
  renameConversation,
  touchConversation,
  archiveConversation,
  dropConversation,
  deleteConversationMessages,
} from '../lib/free-conversation.js'

// ── 测试辅助 ────────────────────────────────────────────────────────────────
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-free-'))
  fs.mkdirSync(path.join(d, 'data'), { recursive: true })
  fs.mkdirSync(path.join(d, 'inbox'), { recursive: true })
  return d
}
function cleanup(d) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
}
const seqRand = (hex) => {
  let i = 0
  return () => parseInt(hex[i++ % hex.length], 16) / 16
}

// ── key 生成与校验 ──────────────────────────────────────────────────────────
test('isFreeKey：默认哨兵与新建对话 key 都认，真实书 / 其它哨兵不认', () => {
  assert.equal(isFreeKey(LEGACY_FREE_KEY), true, '默认自由对话（历史哨兵）')
  assert.equal(isFreeKey('__coread_free_0123abcd__'), true, '新建对话 key')
  assert.equal(isFreeKey('__coread_free_xyz__'), false, '非 8 位十六进制不认')
  assert.equal(isFreeKey('__coread_free_0123ABCD__'), false, '大写十六进制不认（生成侧只产小写）')
  assert.equal(isFreeKey('__coread_free_'), false, '前缀本身不是 key')
  assert.equal(isFreeKey('__coread_other__'), false)
  assert.equal(isFreeKey('ee442b83643425f356d563865'), false, '真实书 ID')
  assert.equal(isFreeKey('_common'), false)
  assert.equal(isFreeKey(''), false)
  assert.equal(isFreeKey(null), false)
})

test('newFreeKey：形如 __coread_free_<8hex>__，且不撞默认哨兵', () => {
  const k = newFreeKey()
  assert.match(k, /^__coread_free_[0-9a-f]{8}__$/)
  assert.notEqual(k, LEGACY_FREE_KEY)
  assert.equal(isFreeKey(k), true)
  // 伪随机数固定时结果可复现（同一注入 rand 两次给同一个 key → 由调用方去重）
  const r = seqRand('0123456789abcdef')
  assert.equal(newFreeKey(r), '__coread_free_01234567__')
})

test('deriveTitle：压平空白、截断加省略号、空串保持空', () => {
  assert.equal(deriveTitle('  你好   世界  '), '你好 世界')
  assert.equal(deriveTitle(''), '')
  assert.equal(deriveTitle(null), '')
  assert.equal(deriveTitle('一'.repeat(30)).length, 25, '24 字 + 省略号')
  assert.ok(deriveTitle('一'.repeat(30)).endsWith('…'))
  assert.equal(deriveTitle('短'), '短')
})

// ── 注册表 ──────────────────────────────────────────────────────────────────
test('readRegistry：文件缺失 / 结构损坏 → 空注册表（不抛错）', () => {
  const d = tmpDir()
  try {
    assert.deepEqual(readRegistry(d).conversations, [])
    fs.mkdirSync(path.join(d, 'data'), { recursive: true })
    fs.writeFileSync(freeConversationFile(d), '{ not json')
    assert.deepEqual(readRegistry(d).conversations, [])
    fs.writeFileSync(freeConversationFile(d), JSON.stringify({ conversations: 'nope' }))
    assert.deepEqual(readRegistry(d).conversations, [])
    cleanup(d)
  } catch (e) { cleanup(d); throw e }
})

test('readRegistry：过滤掉非自由 key 的脏条目（真实书 ID 混进来时不认）', () => {
  const d = tmpDir()
  try {
    writeRegistry(d, { conversations: [
      { key: LEGACY_FREE_KEY, title: '默认对话', status: 'active' },
      { key: 'ee442b83643425f', title: '混进来的书', status: 'active' },
    ] })
    const r = readRegistry(d)
    assert.equal(r.conversations.length, 1)
    assert.equal(r.conversations[0].key, LEGACY_FREE_KEY)
  } finally { cleanup(d) }
})

test('createConversation：落盘、状态 active、可被活动清单列出', () => {
  const d = tmpDir()
  try {
    const { key, conversation } = createConversation(d, { now: 1000, rand: seqRand('abcdef0123456789') })
    assert.equal(key, '__coread_free_abcdef01__')
    assert.equal(conversation.status, 'active')
    assert.equal(conversation.createdAt, 1000)
    const r = readRegistry(d)
    assert.equal(r.conversations.length, 1)
    assert.equal(findConversation(r, key).title, '')
    assert.equal(activeConversations(r).length, 1)
    // 再建两个：key 不重复
    const b = createConversation(d, { now: 2000, rand: seqRand('abcdef0123456789') })  // 撞第一个 key
    assert.notEqual(b.key, key, '撞 key 时自动换一个')
    assert.equal(activeConversations(readRegistry(d)).length, 2)
  } finally { cleanup(d) }
})

test('ensureLegacyConversation：首次补登记默认对话，第二次原样返回', () => {
  const d = tmpDir()
  try {
    const a = ensureLegacyConversation(d, { now: 500 })
    assert.equal(a.conversation.key, LEGACY_FREE_KEY)
    assert.equal(a.conversation.status, 'active')
    const firstCreatedAt = readRegistry(d).conversations[0].createdAt
    const b = ensureLegacyConversation(d, { now: 9999 })
    assert.equal(b.conversation.createdAt, firstCreatedAt, '已存在时不重建（时间戳不变）')
    assert.equal(readRegistry(d).conversations.length, 1)
  } finally { cleanup(d) }
})

test('activeConversations：已归档不进活动清单，按最近活跃倒序', () => {
  const d = tmpDir()
  try {
    const a = createConversation(d, { now: 100, rand: seqRand('1111111122222222') })
    const b = createConversation(d, { now: 200, rand: seqRand('3333333344444444') })
    const c = createConversation(d, { now: 300, rand: seqRand('5555555566666666') })
    archiveConversation(d, b.key, { now: 400, archive: { memory: false, graph: false }, note: '已归档' })
    const r = readRegistry(d)
    const act = activeConversations(r)
    assert.deepEqual(act.map((x) => x.key), [c.key, a.key], '归档的 b 不在活动清单')
    assert.deepEqual(archivedConversations(r).map((x) => x.key), [b.key])
    // 活动登记刷新时间 → 排序跟着变
    touchConversation(d, a.key, { now: 500 })
    assert.deepEqual(activeConversations(readRegistry(d)).map((x) => x.key), [a.key, c.key])
  } finally { cleanup(d) }
})

test('touchConversation：刷新活跃时间；标题只在为空时用首条消息补齐', () => {
  const d = tmpDir()
  try {
    const { key } = createConversation(d, { now: 100 })
    touchConversation(d, key, { title: '第一句提问', now: 200 })
    let c = findConversation(readRegistry(d), key)
    assert.equal(c.title, '第一句提问')
    assert.equal(c.updatedAt, 200)
    // 再发一条：标题不被覆盖（用户可能已手动改名）
    touchConversation(d, key, { title: '第二条消息', now: 300 })
    c = findConversation(readRegistry(d), key)
    assert.equal(c.title, '第一句提问')
    assert.equal(c.updatedAt, 300)
    // 非自由 key 不登记
    assert.equal(touchConversation(d, 'ee442b83643425f', { title: 'x' }), null)
    assert.equal(readRegistry(d).conversations.length, 1)
  } finally { cleanup(d) }
})

test('touchConversation：历史遗留默认对话（注册表里没有）首次发言自动补登记', () => {
  const d = tmpDir()
  try {
    const c = touchConversation(d, LEGACY_FREE_KEY, { title: '老对话第一句', now: 700 })
    assert.equal(c.key, LEGACY_FREE_KEY)
    assert.equal(c.title, '老对话第一句')
    assert.equal(c.createdAt, 700, '补登记时用当次时间打底')
    assert.equal(readRegistry(d).conversations.length, 1)
  } finally { cleanup(d) }
})

test('renameConversation：改名 / 截断 / 空串回退 / 找不到返回 null', () => {
  const d = tmpDir()
  try {
    const { key } = createConversation(d, { now: 100 })
    assert.equal(renameConversation(d, key, '  新   名字 ').title, '新 名字', '空白压平')
    assert.equal(renameConversation(d, key, '').title, '')
    assert.equal(renameConversation(d, key, 'x'.repeat(60)).title.length, 40, '上限 40 字')
    assert.equal(renameConversation(d, '__coread_free_deadbeef__', 'x'), null)
  } finally { cleanup(d) }
})

test('archiveConversation：留墓碑记录（状态 / 时间 / 产物去向），活动清单不再含它', () => {
  const d = tmpDir()
  try {
    const { key } = createConversation(d, { now: 100, rand: seqRand('7777777788888888') })
    const c = archiveConversation(d, key, {
      now: 900,
      archive: { memory: true, graph: true },
      note: '已保存记忆（profile / soul）；已收编进拓扑图（新增 2 个知识点节点）',
    })
    assert.equal(c.status, 'archived')
    assert.equal(c.archivedAt, 900)
    assert.equal(c.archive.memory, true)
    assert.equal(c.archive.graph, true)
    assert.match(c.archive.note, /已收编进拓扑图/)
    assert.equal(activeConversations(readRegistry(d)).length, 0)
    assert.equal(archivedConversations(readRegistry(d)).length, 1)
    // 重复归档：仍是同一条（不重复插）
    archiveConversation(d, key, { now: 1000 })
    assert.equal(readRegistry(d).conversations.length, 1)
    assert.equal(findConversation(readRegistry(d), key).archivedAt, 1000)
  } finally { cleanup(d) }
})

test('dropConversation：删条目（含墓碑）；不存在的 key 返回 false', () => {
  const d = tmpDir()
  try {
    const { key } = createConversation(d, { now: 100 })
    assert.equal(dropConversation(d, key), true)
    assert.equal(readRegistry(d).conversations.length, 0)
    assert.equal(dropConversation(d, key), false)
  } finally { cleanup(d) }
})

// ── 消息清理（归档即删除）──────────────────────────────────────────────────
test('deleteConversationMessages：按 bookId/bookKey 精确删该对话的消息，别的书不动', () => {
  const d = tmpDir()
  try {
    const conv = '__coread_free_aaaaaaaa__'
    const other = '__coread_free_bbbbbbbb__'
    const book = 'ee442b83643425f356d563865'
    const inputLines = [
      { role: 'user', content: '对话一 提问1', timestamp: 1, bookId: conv },
      { role: 'user', content: '别的对话 提问', timestamp: 2, bookId: other },
      { role: 'user', content: '读书提问', timestamp: 3, bookId: book },
      { role: 'user', content: '无归属', timestamp: 4 },
    ]
    const outputLines = [
      { role: 'assistant', content: '对话一 回复', timestamp: 5, bookKey: conv },
      { role: 'assistant', content: '别的对话 回复', timestamp: 6, bookKey: other },
      { role: 'assistant', content: '读书回复', timestamp: 7, bookKey: book },
      { role: 'assistant', content: '', _stream: 0, timestamp: 8, bookKey: conv },
      { role: 'graph-hit', hits: ['n_1'], timestamp: 9, bookKey: conv },
    ]
    fs.writeFileSync(path.join(d, 'inbox', 'chat_input.jsonl'), inputLines.map((x) => JSON.stringify(x)).join('\n') + '\n')
    fs.writeFileSync(path.join(d, 'inbox', 'chat_output.jsonl'), outputLines.map((x) => JSON.stringify(x)).join('\n') + '\n')

    const del = deleteConversationMessages(path.join(d, 'inbox'), conv)
    assert.deepEqual(del, { input: 1, output: 3 }, '该对话的 input 1 条 / output 3 条（含流式与命中行）')

    const keptIn = fs.readFileSync(path.join(d, 'inbox', 'chat_input.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(keptIn.map((x) => x.content), ['别的对话 提问', '读书提问', '无归属'])
    const keptOut = fs.readFileSync(path.join(d, 'inbox', 'chat_output.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(keptOut.map((x) => x.content), ['别的对话 回复', '读书回复'])
    assert.equal(keptOut.length, 2, '流式行与命中行同属该对话，一并清掉')

    // 删除前留了备份（误删可人工恢复）
    assert.ok(fs.existsSync(path.join(d, 'inbox', 'chat_input.jsonl.bak-conv-delete')))

    // 再删一次：该对话已无消息，不动文件
    assert.deepEqual(deleteConversationMessages(path.join(d, 'inbox'), conv), { input: 0, output: 0 })
    // 空 key：直接返回零，绝不清空整档
    assert.deepEqual(deleteConversationMessages(path.join(d, 'inbox'), ''), { input: 0, output: 0 })
    assert.equal(fs.readFileSync(path.join(d, 'inbox', 'chat_input.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length, 3)
  } finally { cleanup(d) }
})

test('deleteConversationMessages：文件不存在 → 零结果（不抛错）', () => {
  const d = tmpDir()
  try {
    assert.deepEqual(deleteConversationMessages(path.join(d, 'inbox'), '__coread_free_cccccccc__'), { input: 0, output: 0 })
  } finally { cleanup(d) }
})

test('注册表写入：先备份后写（.bak 可恢复上一次清单）', () => {
  const d = tmpDir()
  try {
    createConversation(d, { now: 100, rand: seqRand('99999999aaaaaaaa') })
    createConversation(d, { now: 200, rand: seqRand('bbbbbbbbcccccccc') })
    const bak = JSON.parse(fs.readFileSync(freeConversationFile(d) + '.bak', 'utf8'))
    assert.equal(bak.conversations.length, 1, '备份里是上一次（1 条）的清单')
    assert.equal(readRegistry(d).conversations.length, 2)
  } finally { cleanup(d) }
})
