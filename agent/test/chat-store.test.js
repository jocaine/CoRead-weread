/**
 * 聊天存储 + JSONL 迁移单测（lib/chat-store.js / lib/chat-migrate.js）—— 内置 node:test。
 *
 * 回归背景：旧结构（chat_input/chat_output.jsonl + 游标 + 指纹台账）实测 63.2 MB 里
 * 97.1% 是流式快照，且没有主键/状态/归属，派生出去重指纹、整文件重写删除、配对启发式
 * 三套补丁。换 SQLite 后这三件事分别由 id、事务删除、reply_to 直接承担——本文件把它们钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openChatStore, rowToMessage } from '../lib/chat-store.js'
import { migrateJsonlToStore, exportStoreToJsonl } from '../lib/chat-migrate.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coread-store-'))
const at = (base, ms) => base + ms

test('存储：插入/查询/状态流转（pending → ok / failed）', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const uid = store.insertMessage({ conv: 'bookA', role: 'user', content: '问题一', ts: 1000, status: 'pending', bookId: 'bookA', selectedText: '划线' })
  assert.ok(uid > 0, '返回自增主键')
  assert.equal(store.stats().pending, 1)

  let queue = store.listPending()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].content, '问题一')
  assert.equal(queue[0].bookKey, 'bookA', 'rowToMessage 保持旧字段名（bookKey）便于消费者少改')
  assert.equal(queue[0].selectedText, '划线')

  const rid = store.insertMessage({ conv: 'bookA', role: 'assistant', content: '回答一', ts: 1100, replyTo: uid })
  store.updateMessage(uid, { status: 'ok', attempts: 1 })
  assert.equal(store.listPending().length, 0, '处理完就不再出现在队列里')
  assert.equal(store.getMessage(rid).reply_to, uid, '回答直接引用提问 id（配对不再是启发式）')

  const uid2 = store.insertMessage({ conv: 'bookA', role: 'user', content: '问题二', ts: 1200, status: 'pending' })
  store.updateMessage(uid2, { status: 'failed', error: 'LLM API 402: Insufficient Balance', attempts: 2 })
  const q2 = store.listPending()
  assert.equal(q2.length, 1, 'failed 仍会重试（旧系统"调用前记指纹"导致失败永不重试）')
  assert.equal(q2[0].attempts, 2)
  assert.match(q2[0].error, /402/)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('配对：优先 reply_to 直连；历史裸数据按时间回退且跳过 ⚠️ 失败气泡', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const u1 = store.insertMessage({ conv: 'b', role: 'user', content: '问一', ts: at(0, 100), status: 'ok' })
  store.insertMessage({ conv: 'b', role: 'assistant', content: '答一', ts: 200, replyTo: u1 })   // 直连
  const u2 = store.insertMessage({ conv: 'b', role: 'user', content: '问二', ts: 300, status: 'ok' })
  const u3 = store.insertMessage({ conv: 'b', role: 'user', content: '问三', ts: 400, status: 'ok' })
  store.insertMessage({ conv: 'b', role: 'assistant', content: '⚠️ LLM API 402: Insufficient Balance', ts: 500 })  // 失败气泡（无 reply_to）
  store.insertMessage({ conv: 'b', role: 'assistant', content: '答三', ts: 600 })                // 裸回答，无 reply_to

  const pairs = store.pairReplies({ conv: 'b' })
  assert.equal(pairs.get(u1).content, '答一', 'reply_to 直连优先')
  assert.equal(pairs.has(u2), false, '失败气泡不算回答（旧实现会把它认成回答）')
  assert.equal(pairs.get(u3) && pairs.get(u3).content, '答三', '裸回答按"最近前序提问"回退配对')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：按对话重建轮次，无回答的不成轮', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const a1 = store.insertMessage({ conv: 'x', role: 'user', content: 'Q1', ts: 100, status: 'ok' })
  store.insertMessage({ conv: 'x', role: 'assistant', content: 'A1', ts: 150, replyTo: a1 })
  store.insertMessage({ conv: 'x', role: 'user', content: 'Q2 等回复中', ts: 200, status: 'pending' })
  const turns = store.loadTurns('x')
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user.content, 'Q1')
  assert.equal(turns[0].assistant.content, 'A1')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('删除：按对话事务删除（不再整文件重写）；按 id 删除（清理失败气泡）', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const u1 = store.insertMessage({ conv: 'keep', role: 'user', content: 'q', ts: 1, status: 'ok' })
  store.insertMessage({ conv: 'drop', role: 'user', content: 'q2', ts: 2, status: 'ok' })
  store.insertMessage({ conv: 'drop', role: 'assistant', content: 'a2', ts: 3, replyTo: null })
  store.insertEvent({ conv: 'drop', kind: 'graph-hit', payload: { hits: ['n1'] } })
  const del = store.deleteConversation('drop')
  assert.deepEqual(del, { messages: 2, events: 1 })
  assert.equal(store.stats().messages, 1)
  assert.equal(store.getMessage(u1).conv, 'keep')
  assert.equal(store.deleteMessages([u1]), 1)
  assert.equal(store.stats().messages, 0)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('事件与增量水位线：SSE 推送只需 id > 水位线', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const before = store.lastMessageId()
  store.insertMessage({ conv: 'c', role: 'user', content: 'a', ts: 1, status: 'pending' })
  store.insertMessage({ conv: 'c', role: 'user', content: 'b', ts: 2, status: 'pending' })
  const fresh = store.listMessages({ sinceId: before })
  assert.equal(fresh.length, 2, '增量读：不重读整个库')
  store.insertEvent({ conv: 'c', kind: 'graph-hit', payload: { hits: ['n_seed'] } })
  assert.equal(store.lastEventId(), 1)
  assert.equal(store.listEvents({ sinceId: 0 })[0].payload.hits[0], 'n_seed')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── 迁移：旧 JSONL（含跨行指纹的旧台账）→ SQLite ────────────────────────────
function buildLegacyInbox(dir, { withSnapshots = true } = {}) {
  const inbox = path.join(dir, 'inbox')
  fs.mkdirSync(inbox, { recursive: true })
  const users = [
    { role: 'user', content: '[引用]《书  第一章》\n> "引文一"\n\n这什么意思？', timestamp: 1000, bookId: 'bookAk1234567890abcdef', bookTitle: '书' },
    { role: 'user', content: '普通提问二', timestamp: 2000, bookId: 'bookAk1234567890abcdef', bookTitle: '书' },
    { role: 'user', content: '从没被处理过的问题', timestamp: 3000, bookId: 'bookAk1234567890abcdef', bookTitle: '书' },
  ]
  fs.writeFileSync(path.join(inbox, 'chat_input.jsonl'), users.map((u) => JSON.stringify(u)).join('\n') + '\n')

  const outs = []
  if (withSnapshots) {
    outs.push({ role: 'assistant', content: '答', _stream: 0, timestamp: 1010, bookKey: 'bookA' })
    outs.push({ role: 'assistant', content: '答一全文', _stream: 1, timestamp: 1011, bookKey: 'bookA' })
    outs.push({ role: 'assistant', content: '', _stream: -1, timestamp: 1012, bookKey: 'bookA' })
  }
  outs.push({ role: 'assistant', content: '答一全文', timestamp: 1013, bookKey: 'bookA' })
  outs.push({ role: 'assistant', content: '答二全文', timestamp: 2010, bookKey: 'bookA' })
  outs.push({ role: 'graph-hit', hits: ['n_seed'], reason: '命中', timestamp: 2011, bookKey: 'bookA' })
  fs.writeFileSync(path.join(inbox, 'chat_output.jsonl'), outs.map((o) => JSON.stringify(o)).join('\n') + '\n')

  // 旧格式台账：第一条指纹跨行（正文第 22 字就是换行），第二条单行。第三条没有记录。
  const fp1 = `${users[0].timestamp}|${users[0].content.slice(0, 80)}`
  const fp2 = `${users[1].timestamp}|${users[1].content.slice(0, 80)}`
  fs.writeFileSync(path.join(inbox, '.chat_input_replied'), fp1 + '\n' + fp2 + '\n')
  return { inbox, users }
}

test('迁移：丢掉快照、回填状态、配对 answer→question、事件入表', () => {
  const dir = tmpDir()
  const { inbox } = buildLegacyInbox(dir)
  const store = openChatStore(path.join(dir, 'chat.db'))
  const logs = []
  const sum = migrateJsonlToStore({ inboxDir: inbox, store, log: (m) => logs.push(m) })
  assert.deepEqual(
    { users: sum.users, replies: sum.replies, events: sum.events, droppedSnapshots: sum.droppedSnapshots },
    { users: 3, replies: 2, events: 1, droppedSnapshots: 3 },
    '3 条提问 / 2 条回答 / 1 个事件；3 条流式记录不落库',
  )
  const stats = store.stats()
  assert.equal(stats.messages, 5, '库里只有 3 提问 + 2 回答（旧文件那 3 条快照彻底消失）')
  assert.equal(stats.pending, 1, '既无回答也无台账记录的第三条 → pending（会被回答）')
  assert.equal(stats.events, 1)

  const users = store.listMessages({ conv: 'bookA', roles: ['user'] })
  assert.equal(users[0].status, 'ok', '有回答 → ok')
  assert.equal(users[1].status, 'ok', '无回答但有台账记录 → ok（保持旧语义：不重发）')
  assert.equal(users[2].status, 'pending', '从没处理过 → 补答')
  assert.equal(users[0].attempts, 1)
  assert.equal(users[0].selectedText, undefined)

  const pairs = store.pairReplies({ conv: 'bookA' })
  assert.equal(pairs.get(users[0].id).content, '答一全文', '跨行内容的消息也能正确配对')
  assert.equal(pairs.get(users[1].id).content, '答二全文')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('迁移：留下"从未被回答"的提问清单（默认不补答）；重放指纹可被检出', () => {
  const dir = tmpDir()
  const { inbox, users } = buildLegacyInbox(dir)
  const agentDir = path.join(dir, 'agent')
  fs.mkdirSync(path.join(agentDir, 'data'), { recursive: true })
  // 模拟 2026-09-28 重放：第一条提问的指纹被重复追加一次
  const fp1 = `${users[0].timestamp}|${users[0].content.slice(0, 80)}`
  fs.appendFileSync(path.join(inbox, '.chat_input_replied'), fp1 + '\n')
  // 抹掉第一条的回答，模拟"回答是 ⚠️ 失败气泡、后来被清理掉"→ 这条从此没有回答
  const outFile = path.join(inbox, 'chat_output.jsonl')
  fs.writeFileSync(outFile, fs.readFileSync(outFile, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.includes('答一全文') && JSON.parse(l).role !== 'graph-hit').join('\n') + '\n')

  const store = openChatStore(path.join(dir, 'chat.db'))
  const sum = migrateJsonlToStore({ inboxDir: inbox, store, agentDir, log: () => {} })
  assert.equal(sum.unanswered, 2, '第一条（回答被清理）和第三条（从没处理过）都没有回答')
  assert.ok(sum.replayed >= 1, `重复追加的指纹应被检出（实际 ${sum.replayed}）`)
  const list = JSON.parse(fs.readFileSync(path.join(agentDir, 'data', 'unanswered-messages.json'), 'utf8'))
  assert.equal(list.count, 2)
  assert.equal(list.messages[0].replayed, true, '清单里标出第一条同时属于那次重放')
  const u = store.listMessages({ conv: 'bookA', roles: ['user'] })[0]
  assert.equal(u.status, 'ok', '默认保持现状：不自动补答（清单另行提供）')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('导出：库 → 旧 JSONL 形态（老脚本/人工查看仍可用）', () => {
  const dir = tmpDir()
  const { inbox } = buildLegacyInbox(dir)
  const store = openChatStore(path.join(dir, 'chat.db'))
  migrateJsonlToStore({ inboxDir: inbox, store, log: () => {} })
  const out = exportStoreToJsonl({ store, outDir: dir, log: () => {} })
  assert.equal(out.users, 3)
  assert.equal(out.outputs, 2)
  const lines = fs.readFileSync(out.outFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(lines[0]._stream, undefined, '导出不含流式快照')
  assert.equal(lines[0].bookKey, 'bookA')
  const inLines = fs.readFileSync(out.inFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(inLines[0].content.includes('引文一'), '提问内容与旧格式一致')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('迁移幂等：库里已有消息时拒绝重导', () => {
  const dir = tmpDir()
  const { inbox } = buildLegacyInbox(dir)
  const store = openChatStore(path.join(dir, 'chat.db'))
  migrateJsonlToStore({ inboxDir: inbox, store, log: () => {} })
  assert.throws(() => migrateJsonlToStore({ inboxDir: inbox, store, log: () => {} }), /库里已有消息/)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rowToMessage：字段名与旧 JSONL 对齐（消费者尽量少改）', () => {
  const m = rowToMessage({
    id: 7, conv: 'bookX', role: 'user', content: 'c', ts: 123, status: 'pending', attempts: 0,
    reply_to: null, error: null, book_id: 'b', book_title: 't', chapter: 'ch', chapter_uid: '9',
    selected_text: 'sel', refs: '["n1"]', payload: '{"archive":{"memory":true}}',
  })
  assert.equal(m.timestamp, 123)
  assert.equal(m.bookKey, 'bookX')
  assert.deepEqual(m.refs, ['n1'])
  assert.deepEqual(m.payload, { archive: { memory: true } })
})
