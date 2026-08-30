/**
 * 微信读书聊天流（receiver/inbox/chat_input.jsonl）消息解析（AI-016 判定数据层）。
 *
 * 数据源一行原始结构（judge-real-cases.json 的 cases 忠实保留这些字段）：
 *   { role, content, timestamp, bookId, bookTitle, chapter, chapterUid, selectedText }
 * 其中 content 可能是两种形态：
 *   - 引用格式：[引用]《书Title  章节》\n> "划线"\n\n提问…
 *   - 纯文本提问：提问全文
 * 判定管道需要把原始消息解析成 { chapter, note, sel, quoted }：
 *   note=提问文本（判专题化必须 userNote）、sel=划线、chapter=章节、quoted=是否带引用。
 * 解析只做字符串拆解，不调 API。
 *
 * AI 回复配对：用户消息在 chat_input.jsonl，AI 回复在 chat_output.jsonl（无 bookId）。
 * 策略：全时间线（所有 user + 所有 assistant 消息）按 ts 升序，每条 user 消息的回复 =
 * 该 user 消息之后、下一条 user 消息之前的**第一条不带 `_stream`** 的非空 assistant 内容。
 * 为什么取第一条不带 `_stream`：chat_output 的回复是流式累计快照（`_stream` 连续递增，
 * 每一条都含前一条全文，`_stream:-1` 是流结束标记）——这些快照都不是最终完整回复；
 * 真正的完整回复由 appendChatOutput 单独写一条**不带 `_stream`** 的记录。所以配对
 * 锚点是 `_stream` 字段：第一条不带它的 assistant 才是本 user 消息的回复。
 * （此前"最后一条非空 assistant"规则会抓到不属于本会话的孤儿回复——它的 user 消息
 * 不在 chat_input 里，配对不到；修正后孤儿回复不匹配任何 user 消息。）
 */
import fs from 'node:fs'

// 从 chat_input.jsonl + chat_output.jsonl 建立 user 消息 ts → AI 回复内容 的映射
export function loadReplyByTs({ inputPath, outputPath }) {
  const msgs = []
  const collect = (file, role) => {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      if (typeof d.timestamp !== 'number') continue
      msgs.push(role === 'assistant'
        ? { role, ts: d.timestamp, content: d.content, hasStream: typeof d._stream === 'number' }
        : { role, ts: d.timestamp })
    }
  }
  collect(inputPath, 'user')
  collect(outputPath, 'assistant')
  msgs.sort((a, b) => a.ts - b.ts)

  const replyByTs = new Map()
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue
    let reply = ''
    for (let j = i + 1; j < msgs.length; j++) {
      const n = msgs[j]
      if (n.role === 'user') break            // 下一条是用户消息 → 该用户消息无后续回复
      if (n.hasStream) continue               // 流式累计快照 / 流结束标记 → 不是完整回复
      if (n.content) { reply = n.content; break }  // 第一条不带 _stream 的完整回复
    }
    if (reply) replyByTs.set(msgs[i].ts, reply)
  }
  return replyByTs
}
export function chapterFromTitle(title = '') {
  const parts = title.split('  ')
  return parts.length > 1 ? parts[parts.length - 1].trim().replace(/》$/, '') : ''
}

// 解析一条原始消息 → { chapter, note, sel, quoted }
export function parseMessage(d) {
  const content = String(d.content || '').trim()
  const lines = content.split('\n')
  if (!lines[0].startsWith('[引用]')) {
    // 纯文本提问：note=全文；sel 取消息自带划线（如有）
    return {
      chapter: d.chapter || chapterFromTitle(d.bookTitle),
      note: content,
      sel: (d.selectedText || '').trim() || undefined,
      quoted: false,
    }
  }
  // 引用格式：[引用]《书  章节》 / > "划线" / 空行 / 提问
  const sel = (lines[1] || '').startsWith('> ') ? lines[1].slice(2).trim().replace(/^"|"$/g, '') : ''
  const note = lines.slice(2).join('\n').trim()
  return {
    chapter: chapterFromTitle(lines[0]),
    note,
    sel: sel || undefined,
    quoted: true,
  }
}

// 原始 case → 判专题化输入 { userNote, selected? }
export function messageUnit(c) {
  const { note, sel } = parseMessage(c)
  const unit = { userNote: note }
  if (sel) unit.selected = { text: sel }
  return unit
}
