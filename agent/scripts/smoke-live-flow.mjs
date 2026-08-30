#!/usr/bin/env node
/**
 * 端到端冒烟：live agent（index.js）接入会意系统后的完整链路
 *
 * 场景（全部用假 API，不碰真实数据）：
 *   临时目录副本 agent/ + receiver/ → 预置种子图（n_seed 节点）→ 两阶段运行：
 *   阶段1：消息1 开栈（引用 n_seed 暂存）→ 消息2 换专题 → 收口组1 + **当场固化**（不等 .stop）→ .stop；
 *   阶段2：重启（同目录，验证跨会话恢复）→ 消息3 开新栈 → 消息4 换专题 →
 *           收口组2/组3 + 当场固化（derived 链靠 topic_lastgroup.json 的 nodeId 跨会话定位）。
 *   校验：无待归类桶（当场固化不需要桶）；knowledge-graph.json 节点/边正确。
 *
 * 运行：node scripts/smoke-live-flow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = path.resolve(__dirname, '..')
const ROOT = path.resolve(AGENT_DIR, '..')
const PORT = 17890 + Math.floor(Math.random() * 1000)

// ── 假 API 服务器：按提示词特征串返回协议 JSON（判定）；stream 走 SSE（say） ──
function dispatch(prompt) {
  const p = String(prompt || '')
  if (p.includes('可推进的问题内核')) return '{"topicized":true}'
  const newMsg = p.match(/新消息："([^"]+)"/)
  if (p.includes('是不是在延续')) {
    return newMsg && newMsg[1].includes('阶级分析') ? '{"same":true}' : '{"same":false}'
  }
  // 固化后分段判同一性（2026-08-28 新口径）：承认逻辑接续已成立，只判"追的具体问题
  // 是否还和当前组一致"——新轮次换方向 → 切段开新组（特征串：组首轮次锚定行）
  if (p.includes('当前组追的问题（组首轮次确立）')) {
    return newMsg && newMsg[1].includes('阶级分析') ? '{"same":false}' : '{"same":true}'
  }
  if (p.includes('找出指认旧知识点的说法')) return '{"hits":["n_seed"]}'
  const q = p.match(/讨论的具体问题："([^"]+)"/)
  if (p.includes('归纳知识点表述')) {
    if (p.includes('阶级分析')) return '{"point":"用阶级分析重新看身份问题"}'
    if (q && q[1].includes('中国')) return '{"point":"中国历史未孕育出哥萨克式角色的制度文化原因"}'
    if (q && q[1].includes('教会')) return '{"point":"教会拒绝为自杀者念经的规矩"}'
    if (q && q[1].includes('水兵')) return '{"point":"格里高利杀水兵时的身份转换"}'
    return '{"point":"哥萨克的身份政治"}'
  }
  if (p.includes('写可指认的说法')) return '{"aliases":["哥萨克的身份政治","哥萨克在革命中的立场"]}'
  if (p.includes('现在执行「衍生关联」')) return '{"linked":true,"reason":"后一条从前一条的思考中衍生"}'
  if (p.includes('归纳成一句提问')) {
    if (p.includes('中国')) return '{"question":"中国历史为何未孕育出哥萨克式角色？"}'
    if (p.includes('教会')) return '{"question":"教会为什么不给自杀者念经？"}'
    if (p.includes('水兵')) return '{"question":"格里高利为什么杀水兵像没事人？"}'
    return '{"question":"哥萨克在革命中的真实立场是什么？"}'
  }
  if (p.includes('请按行为规则')) return '好的，我们来讨论这条划线。\n【TAKEAWAY】哥萨克立场是身份问题。'
  return '嗯，继续说。'
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    const msgs = Array.isArray(payload.messages) ? payload.messages : []
    const prompt = msgs.length ? String(msgs[msgs.length - 1].content || '') : ''
    const reply = dispatch(prompt)
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = reply.match(/[\s\S]{1,8}/g) || []
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    }
  })
})

function copyDir(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory()) copyDir(s, d, skip)
    else fs.copyFileSync(s, d)
  }
}

function waitFor(label, fn, timeoutMs = 60000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false
      try { ok = fn() } catch {}
      if (ok) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`超时等待：${label}`))
      setTimeout(tick, 300)
    }
    tick()
  })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-smoke-'))
  const tmpAgent = path.join(tmp, 'agent')
  const tmpReceiver = path.join(tmp, 'receiver')
  console.log(`[smoke] 临时环境：${tmp}`)

  // 1. 副本（跳过真实数据/密钥/日志）
  copyDir(AGENT_DIR, tmpAgent, ['data', '.env', '.env.bak', 'session_journal.jsonl', 'session_journal.jsonl.bak-20260807', 'session_journal.jsonl.bak-replay'])
  fs.mkdirSync(path.join(tmpReceiver, 'inbox'), { recursive: true })
  fs.mkdirSync(path.join(tmpReceiver, 'books'), { recursive: true })
  fs.writeFileSync(path.join(tmpReceiver, 'inbox', 'annotations.jsonl'), '')
  fs.writeFileSync(path.join(tmpReceiver, 'inbox', 'chat_input.jsonl'), '')
  // 2. 种子图（1 个节点）
  const dataDir = path.join(tmpAgent, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dataDir, 'knowledge-graph.json'), JSON.stringify({
    nodes: [{
      id: 'n_seed', point: '阶级分析的手术刀与身份社会', aliases: ['阶级分析的手术刀'],
      discussions: [{ question: '阶级分析为何失灵？', book: '《静静的顿河》', chapter: '五', excerpts: [] }],
      createdAt: now, updatedAt: now,
    }],
    edges: [],
  }, null, 2))
  // 3. .env → 假 API
  fs.writeFileSync(path.join(tmpAgent, '.env'), `COREAD_API_KEY=fake\nCOREAD_API_BASE=http://127.0.0.1:${PORT}/v1\nCOREAD_MODEL=fake-model\n`)
  // 预置哑指纹：index.js 首次启动会把 chat_input 现有消息全部当"已回复"跳过（升级兼容逻辑），
  // 预置一个指纹让种子逻辑跳过，保证预置消息真的被处理
  fs.writeFileSync(path.join(tmpReceiver, 'inbox', '.chat_input_replied'), '0|dummy\n')

  await new Promise((resolve) => server.listen(PORT, resolve))
  console.log(`[smoke] 假 API 已在 :${PORT} 就绪`)

  // ── 两阶段运行（实时栈 + 收口固化）──
  // 验证：① 收口固化 = 新专题化弹栈旧讨论的时刻（当场聚合，不等 .stop）
  // ② 关闭/启动恢复不做收口固化（进行中的讨论留在栈里，topic_stack.json 跨会话恢复）
  // ③ 跨会话 derived 链（topic_lastgroup.json 的 nodeId）
  async function runPhase(label, msgs, expectNodes) {
    // 追加（真实系统语义）：chat_input 是 append-only，游标按行数推进
    fs.appendFileSync(path.join(tmpReceiver, 'inbox', 'chat_input.jsonl'),
      msgs.map((m) => JSON.stringify(m)).join('\n') + '\n')
    const child = spawn('node', ['--env-file-if-exists=.env', 'index.js'], {
      cwd: tmpAgent,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`))
    child.stderr.on('data', (d) => process.stdout.write(`[agent-err] ${d}`))
    const graphFile = path.join(dataDir, 'knowledge-graph.json')
    console.log(`[smoke] ${label}：index.js 已启动，等待收口固化至 ${expectNodes} 节点（收口即固化，不等 .stop）...`)
    await waitFor(`${label} 图文件达 ${expectNodes} 节点`, () => {
      if (!fs.existsSync(graphFile)) return false
      return JSON.parse(fs.readFileSync(graphFile, 'utf8')).nodes.length >= expectNodes
    })
    console.log(`[smoke] ${label}：✓ 收口固化（图 ${expectNodes} 节点），发送 .stop（关闭不做收口固化）...`)
    fs.writeFileSync(path.join(tmpAgent, '.stop'), '')
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => { console.log(`[smoke] ⚠️ ${label} 进程未在 40s 内退出，强杀`); child.kill('SIGKILL'); resolve(-1) }, 40000)
      child.on('exit', (code) => { clearTimeout(t); resolve(code) })
    })
    console.log(`[smoke] ${label} 退出码：${exitCode}`)
    if (exitCode !== 0) throw new Error(`${label} 异常退出：${exitCode}`)
  }

  // 阶段1：消息1 开栈；消息2 换专题 → 收口组1（消息1 讨论）当场固化 → 图 2 节点。
  // 消息2 的讨论留在栈里（未收口），.stop 关闭时不固化。
  await runPhase('阶段1', [
    { content: '为什么哥萨克在革命中的立场这么复杂？', timestamp: 1 },
    { content: '那中国为什么没有哥萨克？', timestamp: 2 },
  ], 2)
  // 阶段2：重启（栈恢复：消息2 讨论还在）→ 消息3 换专题 → 收口组2（消息2 讨论）当场固化
  // + 跨会话 derived（vs 组1）；消息4 换专题 → 收口组3（消息3 讨论）当场固化。图 4 节点。
  await runPhase('阶段2', [
    { content: '教会为什么不给自杀者念经？', timestamp: 3 },
    { content: '为什么格里高利杀水兵像没事人？', timestamp: 4 },
  ], 4)
  // 阶段3：重启（栈恢复：消息4 讨论还在）→ 消息5 承接（同问题入栈，实时判同一性 same:true）
  // → 消息6 换专题 → 收口组4（消息4+5 讨论）→ 固化后分段：消息5 换方向（阶级分析）≠ 组首
  // （水兵身份）→ 切成 2 个不可分割组 → 2 节点 + 1 条段间 derived 边。图 6 节点。
  await runPhase('阶段3', [
    { content: '那用阶级分析看，格里高利杀水兵算什么？', timestamp: 5 },
    { content: '那中国为什么没有哥萨克？', timestamp: 6 },
  ], 6)
  server.close()

  // ── 校验 ──
  const graph = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-graph.json'), 'utf8'))
  const fails = []
  const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails.push(msg) }

  check(!fs.existsSync(path.join(tmpAgent, 'topic_pending.jsonl')), '无待归类桶（收口即固化，不需要桶）')
  check(!fs.existsSync(path.join(tmpAgent, 'topic_flow.jsonl')), '无 topic_flow（消息由栈承载，不另存流水账）')
  check(!fs.existsSync(path.join(tmpAgent, 'topic_lastgroup.json')), '无 topic_lastgroup（derived 边只在同栈段间，不比对上一个收口讨论）')
  check(fs.existsSync(path.join(tmpAgent, 'topic_stack.json')), 'topic_stack.json 存在（进行中的讨论跨会话保留——消息4 讨论未收口）')
  // 收口固化：每组弹栈 → 固化后分段（单段或多段）→ 归纳问题 → 聚合；derived 只在同栈多段时出现
  const userEdges = graph.edges.filter((e) => e.kind === 'user')
  const derEdges = graph.edges.filter((e) => e.kind === 'derived')
  check(graph.nodes.length === 6, `图 6 节点（n_seed + 组1/2/3 + 阶段3 段1/段2，实际 ${graph.nodes.length}）`)
  check(userEdges.length === 5, `5 条 user 边（各组/段各引用 n_seed，实际 ${userEdges.length}）`)
  check(derEdges.length === 1, `1 条 derived 边（阶段3 收口栈切成 2 段，段间衍生，实际 ${derEdges.length}）`)

  console.log('')
  if (fails.length) {
    console.log(`❌ 冒烟失败 ${fails.length} 项：\n  - ${fails.join('\n  - ')}`)
    console.log(`临时环境保留：${tmp}`)
    process.exit(1)
  }
  console.log('✅ 冒烟通过：会意系统已接入 live 工作流（判专题化/同一性 → 收口(问题+衍生+引用暂存) → 固化直建 → 图文件）')
  fs.rmSync(tmp, { recursive: true, force: true })
}

main().catch((e) => { console.error('❌', e.message); process.exit(1) })
