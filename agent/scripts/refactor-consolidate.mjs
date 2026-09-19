// 临时重构脚本：把 driveTopicStack 内的收口固化块抽成 consolidateClosed，
// 并新增 forceConsolidate（/收口 手动收口入口）。跑完可删。
import fs from 'fs'

const file = 'C:/Users/lengdrug/CoRead-weread/agent/index.js'
const src = fs.readFileSync(file, 'utf8')
const eol = src.includes('\r\n') ? '\r\n' : '\n'
const lines = src.split(/\r?\n/)

const si = lines.findIndex((l) => l.includes('let keptClosed = null'))
if (si < 0) throw new Error('start line not found')
const ei = lines.findIndex((l, i) => i > si && l.includes('topicStacks[bookKey] = [...(keptClosed || []), ...savedStack,'))
if (ei < 0) throw new Error('after line not found')
// 块 = [si, ei)，末行是 if 块收尾的 '    }'
const blockLines = lines.slice(si, ei)
const bodyLines = blockLines.slice(3, -1)
const block = blockLines.join(eol)
const body = bodyLines.join(eol)

const fn = [
  '// 收口固化（实时收口 closed_and_pushed 与 /收口 手动收口共用，2026-09）：',
  '// 对被弹出的讨论做固化后分段 → 每段归纳问题 → 固化节点 → user 边 → 段间 derived',
  '// 边 → 写图。返回 { keptClosed }：0 节点产出且非 noTopicized（LLM 故障）时保留',
  '// 被收口讨论，调用方压回栈顶下次重试；noTopicized（整栈无专题化）不保留。',
  'async function consolidateClosed(closed, isFree, targetGraph) {',
  '  let keptClosed = null',
  body,
  '  return { keptClosed }',
  '}',
  '',
  '// /收口：手动收口当前书（或指定书）的讨论栈（2026-09 用户定调——读完一本书时使用）。',
  '// 与实时收口走同一固化链路；成功后清空该栈（栈结束 → 命中展示随之结束）。',
  'async function forceConsolidate(bookKey) {',
  '  const stack = topicStacks[bookKey] || []',
  "  if (!stack.length) return { reply: '当前没有进行中的讨论可收口。' }",
  "  if (bookKey === FREE_KEY) return { reply: '自由模式不固化（测试对话）；退出自由模式后对正式书使用 /收口。' }",
  '  const closed = { ts: Date.now(), entries: stack }',
  '  try {',
  '    const { keptClosed } = await consolidateClosed(closed, false, graph)',
  '    if (keptClosed && keptClosed.length) {',
  '      topicStacks[bookKey] = keptClosed',
  '      saveTopicStacks(topicStacks)',
  "      return { reply: '收口未完成（固化 0 节点产出），讨论已保留，稍后重试 /收口。' }",
  '    }',
  '    topicStacks[bookKey] = []',
  '    saveTopicStacks(topicStacks)',
  "    return { reply: '本书讨论已收口（' + closed.entries.length + ' 轮）。' }",
  '  } catch (e) {',
  "    console.log('  [会意栈] /收口 固化失败: ' + e.message)",
  "    return { reply: '收口失败：' + e.message }",
  '  }',
  '}',
  '',
].join(eol)

const newBlock = [
  '    let keptClosed = null  // 收口固化 0 节点产出时保留被收口讨论（压回栈顶，下次收口重试）',
  "    if (r.action === 'closed_and_pushed' && r.closed) {",
  '      keptClosed = (await consolidateClosed(r.closed, isFree, targetGraph)).keptClosed',
  '    }',
].join(eol)

let out = src.replace(block, newBlock)
const anchor = 'async function driveTopicStack(bookKey, unit, reply, cites) {'
if (!out.includes(anchor)) throw new Error('driveTopicStack anchor not found')
out = out.replace(anchor, fn + eol + anchor)
fs.writeFileSync(file, out, 'utf8')
console.log('refactor done; block lines moved:', blockLines.length, '→ body lines:', bodyLines.length)
