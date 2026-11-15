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

test('loadTurns：`l3 both` 的 B 答案只显示、不进历史（不能把 A 顶掉）', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const q = store.insertMessage({ conv: 'x', role: 'user', content: 'Q1', ts: 100, status: 'ok' })
  store.insertMessage({ conv: 'x', role: 'assistant', content: 'A 旧路径的答案', ts: 150, replyTo: q })
  store.insertMessage({
    conv: 'x', role: 'assistant', content: '〔B · 新路径〕\n\nB 新路径的答案', ts: 160,
    replyTo: q, payload: { l3variant: 'B' },
  })
  const turns = store.loadTurns('x')
  assert.equal(turns.length, 1, '同一提问仍然只成一轮')
  assert.equal(turns[0].assistant.content, 'A 旧路径的答案', '历史里必须是 A（B 和 A 指向同一条提问，B 放进来会顶掉 A）')
  // 但两条都在库里、都会被 receiver 推给侧栏显示
  const all = store.listMessages({ conv: 'x' })
  assert.equal(all.filter((m) => m.role === 'assistant').length, 2)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：A/B 对调之后（主 = 新路径、副 = 旧路径）只认主答案进历史', () => {
  // 2026-10-27 的排列：主答案是新路径 B（不带 l3variant），副是旧路径 A（带 l3variant:'A'）。
  // 副那份后写，pairReplies 若只认 'B' 当对照，就会让 A 顶掉 B —— 下一轮接着聊的是用户没在看的那份。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const q = store.insertMessage({ conv: 'x', role: 'user', content: 'Q1', ts: 100, status: 'ok' })
  store.insertMessage({
    conv: 'x', role: 'assistant', content: 'B 新路径的答案[1]', ts: 150,
    replyTo: q, payload: { sources: [{ n: 1, title: '某文件', site: '某站', text: '原文', url: 'https://e.com/a' }] },
  })
  store.insertMessage({
    conv: 'x', role: 'assistant', content: '〔A · 旧路径〕\n\nA 旧路径的答案', ts: 160,
    replyTo: q, payload: { l3variant: 'A' },
  })
  const turns = store.loadTurns('x')
  assert.equal(turns.length, 1, '同一提问仍然只成一轮')
  assert.equal(turns[0].assistant.content, 'B 新路径的答案[1]', '进历史的必须是用户在看的那一份')
  assert.deepEqual(turns[0].assistant.payload.sources.map((s) => s.n), [1], '材料条目跟着消息一起回来')
  assert.equal(store.listMessages({ conv: 'x' }).filter((m) => m.role === 'assistant').length, 2, '两条都在库里、都会被推给侧栏')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：范围由 afterId 决定，不是"固定取最近 N 条"', () => {
  // 回归背景（2026-11）：旧实现 `ORDER BY id DESC LIMIT 60`——LIMIT 数的是消息行（60 行 = 30 轮），
  // 而恢复调用方拿这个结果再 `Math.min(游标, list.length)` 跳过开头。游标是"累计切掉条数"
  // （一次截尾就跳 ~118），一超过 60 就跳过整段，**整本书的历史在重启后全空**。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const ids = []
  for (let i = 1; i <= 40; i++) {
    const u = store.insertMessage({ conv: 'long', role: 'user', content: `Q${i}`, ts: i * 10, status: 'ok' })
    const a = store.insertMessage({ conv: 'long', role: 'assistant', content: `A${i}`, ts: i * 10 + 5, replyTo: u })
    ids.push({ u, a })
  }

  const all = store.loadTurns('long')
  assert.equal(all.length, 40, '默认全量：上限由调用方点位与 token 预算决定，不在这里截')

  // 截尾点位 = 第 30 轮的回答 id（在线把前 30 轮切掉了）→ 恢复的正好是后 10 轮
  const rest = store.loadTurns('long', { afterId: ids[29].a })
  assert.equal(rest.length, 10, '只取点位之后的轮次')
  assert.equal(rest[0].user.content, 'Q31')
  assert.equal(rest[9].assistant.content, 'A40')

  assert.equal(store.loadTurns('long', { afterId: ids[39].a }).length, 0, '点位在最末尾 → 没有可恢复的轮次')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：顺序按回答落库时间——重试轮排到末尾，不回到它提问的位置', () => {
  // 内存里 hist.push 发生在回答生成完之后：提问失败时那半轮被 pop 掉，重试成功才从末尾推回。
  // 所以"回答时间"才是它在内存里的位置；按提问 id 排序会把重试轮排回当初的位置，
  // 恢复出来的序列与关掉前不一致（缓存前缀、上下文承接都跟着错）。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const u1 = store.insertMessage({ conv: 'r', role: 'user', content: 'Q1', ts: 100, status: 'ok' })
  store.insertMessage({ conv: 'r', role: 'assistant', content: '⚠️ 失败', ts: 150, status: 'failed', replyTo: u1 })
  const u2 = store.insertMessage({ conv: 'r', role: 'user', content: 'Q2', ts: 200, status: 'ok' })
  store.insertMessage({ conv: 'r', role: 'assistant', content: 'A2', ts: 250, replyTo: u2 })
  store.insertMessage({ conv: 'r', role: 'assistant', content: 'A1', ts: 300, replyTo: u1 })   // Q1 重试成功

  const turns = store.loadTurns('r')
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map((t) => t.user.content), ['Q2', 'Q1'], '重试成功的 Q1 排在末尾')
  assert.deepEqual(turns.map((t) => t.assistant.content), ['A2', 'A1'], '失败气泡不算回答，取最终成功那条')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：只认 assistant 回答——/相处、/归档 这类系统回执不成轮', () => {
  // 指令回执是 role='system' 的行，由 appendChatOutput 直接写库、**从不进内存 hist**。
  // 恢复时把它当成一轮，就会凭空多出内存里从来没有的条目。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const u1 = store.insertMessage({ conv: 's', role: 'user', content: '/相处 多举例子', ts: 100, status: 'ok' })
  store.insertMessage({ conv: 's', role: 'system', content: '已记录：多举例子', ts: 150, replyTo: u1 })
  const u2 = store.insertMessage({ conv: 's', role: 'user', content: 'Q2', ts: 200, status: 'ok' })
  store.insertMessage({ conv: 's', role: 'assistant', content: 'A2', ts: 250, replyTo: u2 })
  const turns = store.loadTurns('s')
  assert.equal(turns.length, 1, '系统回执那一轮不该被恢复')
  assert.equal(turns[0].user.content, 'Q2')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadTurns：assistant 字段完整（回归：二次 rowToMessage 会把 timestamp/bookId 转丢）', () => {
  // 旧实现里 pairReplies 已经把数据库行转成消息对象，loadTurns 又套了一次 rowToMessage——
  // 而 rowToMessage 认的是数据库列名（ts / book_id），转换过的对象上这些字段已改名，
  // 结果 assistant.timestamp 变成 NaN、bookId/chapter/selectedText 全丢。以前只读 content
  // 所以没暴露；现在排序要读 timestamp，必须钉住。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const u1 = store.insertMessage({ conv: 'f', role: 'user', content: 'Q', ts: 100, status: 'ok', bookId: 'bk1', chapter: '第一章' })
  store.insertMessage({ conv: 'f', role: 'assistant', content: 'A', ts: 150, replyTo: u1, bookId: 'bk1' })
  const [t] = store.loadTurns('f')
  assert.ok(Number.isFinite(t.assistant.timestamp), 'assistant.timestamp 不能是 NaN（排序靠它）')
  assert.equal(t.assistant.timestamp, 150)
  assert.equal(t.assistant.bookId, 'bk1', 'assistant 的书籍字段不能丢')
  assert.equal(t.user.chapter, '第一章', 'user 的章节字段不能丢')
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

test('latestGraphHit：取某场对话最近一条图命中（/stack-hits 迁移兜底用）', () => {
  // 为什么需要它：图命中只画"当前这一轮真用上的节点"。讨论栈的新条目自带 used，
  // 但升级前写的老栈没有——这时退回最近一条 graph-hit 里的 hits（它记的正是那一轮的有效节点），
  // 用户不必等再问一轮才看到正确的高亮。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  assert.equal(store.latestGraphHit('bookA'), null, '没有事件时返回 null，不是抛错')
  store.insertEvent({ conv: 'bookA', kind: 'graph-hit', payload: { hits: ['n_old'], cites: ['n_old'] } })
  store.insertEvent({ conv: 'bookA', kind: 'graph-hit', payload: { hits: ['n_new', 'n_parent'], cites: ['n_new'] } })
  store.insertEvent({ conv: 'bookB', kind: 'graph-hit', payload: { hits: ['n_b'], cites: ['n_b'] } })
  const ev = store.latestGraphHit('bookA')
  assert.ok(ev && ev.payload, '要能读回 payload')
  assert.deepEqual(ev.payload.hits, ['n_new', 'n_parent'], '同一场对话取**最近**一条，不是第一条')
  assert.deepEqual(ev.payload.cites, ['n_new'], 'cites 也一并带回来（调用方用它判断是不是这场讨论的）')
  assert.equal(store.latestGraphHit('bookB').payload.hits[0], 'n_b', '按对话隔离')
  assert.equal(store.latestGraphHit('bookC'), null)
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

test('listMessagesForBook：整书会话 + 各章节会话一起取，不误伤相邻书', () => {
  // 回归背景（2026-10-25）：/history 只回全库最近 500 条，旧书整本滑出窗口后
  // 侧栏点开是空的。按书补拉要能取到"这本书的全部"，且不能把相邻书带进来
  //（conv 用 base + 'k' + 哈希，`LIKE base || 'k%'` 会把 base 里的 `_` 当通配符）。
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  const base = 'mia_8a66411378a3f8d9116f'
  store.insertMessage({ conv: base, role: 'user', content: '整书 Q', ts: 100 })
  store.insertMessage({ conv: base, role: 'assistant', content: '整书 A', ts: 150 })
  store.insertMessage({ conv: base + 'kc4c329b011c4ca4238a0201', role: 'user', content: '章节 Q', ts: 200 })
  store.insertMessage({ conv: 'mia_8a66411378a3f8d9117f', role: 'user', content: '别的书', ts: 300 })
  store.insertMessage({ conv: base + '2', role: 'user', content: '同前缀但不是 k 后缀', ts: 400 })

  const all = store.listMessagesForBook(base)
  assert.deepEqual(all.map((m) => m.content), ['整书 Q', '整书 A', '章节 Q'], '按 ts 升序，且只取这本书')
  assert.equal(all[0].bookKey, base, '字段名与 listMessages 一致')

  const tail = store.listMessagesForBook(base, { limit: 1 })
  assert.deepEqual(tail.map((m) => m.content), ['章节 Q'], 'limit 取最近 N 条（从尾部）')

  assert.deepEqual(store.listMessagesForBook(''), [], '空 base 不查库')
  assert.deepEqual(store.listMessagesForBook('不存在的书'), [], '没有会话 → 空数组')
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

test('deleteGraphHit：只撤本轮，不碰同一场对话里别的轮次（2026-10-27 修）', () => {
  const dir = tmpDir()
  const store = openChatStore(path.join(dir, 'chat.db'))
  // 同一场对话里三轮各写了一条命中事件（payload 里带着各自的 replyToTs）
  store.insertEvent({ conv: 'bookA', kind: 'graph-hit', payload: { hits: ['n1'], replyToTs: 100 } })
  store.insertEvent({ conv: 'bookA', kind: 'graph-hit', payload: { hits: ['n2'], replyToTs: 200 } })
  store.insertEvent({ conv: 'bookA', kind: 'graph-hit', payload: { hits: ['n3'], replyToTs: 300 } })
  // 另一场对话的同类事件不许被牵连
  store.insertEvent({ conv: 'bookB', kind: 'graph-hit', payload: { hits: ['n9'], replyToTs: 200 } })
  assert.equal(store.stats().events, 4)

  const n = store.deleteGraphHit('bookA', 200)
  assert.equal(n, 1, '只删这一轮那一条')
  assert.equal(store.stats().events, 3)
  // 别的轮次与别的对话都还在——这正是"停一轮不该清空整本书命中历史"的判据
  const left = store.listEvents({ sinceId: 0, limit: 50, kind: 'graph-hit' })
  assert.deepEqual(left.map((e) => e.payload.hits[0]), ['n1', 'n3', 'n9'])

  // 认不出是哪一轮（没给 ts / 对不上）→ 一条都不删，绝不退化成"全删"
  assert.equal(store.deleteGraphHit('bookA', 0), 0)
  assert.equal(store.deleteGraphHit('bookA', 999), 0)
  assert.equal(store.stats().events, 3)
})
