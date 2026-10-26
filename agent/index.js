#!/usr/bin/env node
/**
 * CoRead 共读 agent —— 常驻进程，由托盘拉起（开发与便携包同一个入口）
 *
 * 它不自带界面：用户的界面是浏览器侧栏，命令行提示符只用于开发期调试。
 * 输入来自标准输入（开发时人工敲命令），输出写进日志与聊天库，经 receiver 的 SSE
 * 推到侧栏。
 *
 * 启动：
 *   Start-CoRead.vbs     # 推荐：托盘 + receiver + agent，全程后台（用户双击的也是它）
 *   node --env-file-if-exists=data/config/env agent/index.js   # 开发期要看前台 REPL 时
 * 模型 API 在插件侧栏「⋯ → 模型 API 配置」里填（推荐）；也可写 data\config\env。
 */

import fs from 'fs'
import net from 'net'
import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { processStackMessage, makeStackEntry, collectStackCites } from './lib/topic-stack.js'
import { createGraph, userAncestry, userParents, resolveReferences, hotNodes, mergeNodeMetadata } from './lib/knowledge-graph.js'
import { consolidateThreadQuestion } from './lib/thread-question.js'
import { consolidateDiscussion, addDerivedEdge, addCitationEdges, pruneRedundantCitationEdges, groupExcerpts, segmentBook } from './lib/graph-consolidate.js'
import { segmentStack } from './lib/segment-stack.js'
import { l3Block } from './lib/l3-context.js'  // L3 上下文渲染（2026-10 定调：来源见模块头）
// 相处规则（2026-10 定调）：用户对 AI 的长期要求，唯一入口是侧栏 /相处 命令。
// 增删改全是机械操作（不调 LLM），见 lib/agreement.js 头部——AI 自己**不写**这份文件。
import { handleCommand as handleAgreement } from './lib/agreement.js'
import { parseMessage, splitQuotedQuestion } from './lib/chat-input.js'  // 引用解析输入剥离引文：只认用户自己的话（见 resolveCitations）
import { resolveApiConfig, isConfigured } from './lib/api-config.js'  // 模型 API 配置：插件侧栏可写，.env 为回退
// 聊天存储（2026-10-02 方案 B）：SQLite 取代 chat_input/chat_output.jsonl + 游标 + 指纹台账。
// id = 队列游标；status = 已回复/待重试；reply_to = 提问↔回答的直接引用。见 lib/chat-store.js 头部。
import { openChatStore } from './lib/chat-store.js'
// 自由模式多对话（2026-11 用户定调）：每个自由对话 = 一个独立 bookKey（隔离链路复用
// "按书隔离"），注册表管标题/活跃时间/归档状态；归档时可选择保存记忆、收编进正式拓扑图。
import { isFreeKey, LEGACY_FREE_KEY, archiveConversation } from './lib/free-conversation.js'
import { stashFreeClosedStack, closedStacksOf, dropFreeClosedStacks } from './lib/free-closed-stacks.js'  // 自由对话中途弹栈的旧讨论暂存（2026-11 修）
// agent 身份应答（2026-11）：单实例管道兼职"问话"通道，托盘拨一次就知道"有没有 agent、
// 是不是它那一份"。协议与托盘侧的 Get-AgentPipeInfo 是一份跨语言契约，见该模块头部。
import { AGENT_PIPE_NAME, serveHello } from './lib/agent-identity.js'
// 错误分类（2026-10）：网络层失败（fetch failed / ECONNRESET / 超时）此前一次都不重试，
// 成因与机制见 lib/error-classify.js 头部注释
import { canRetryError, isNetworkError, networkErrorMessage, isFatalConfigError, fatalErrorMessage } from './lib/error-classify.js'
// 引用自带的「划线附近原文」（PDF 阅读器那条路）：微读的书靠 chapters\ 正文取上下文，
// PDF 没有正文，上下文随标注一起来 —— 认领规则见该模块头部注释。
import { annotationContextFor, annotationRefFor } from './lib/annotation-context.js'
// 译文引用的原文块（2026-10-24）：判定这条引用是不是译文、该拿哪份原文做对照。
// 纯函数，被 agent/test/ref-source.test.js 钉住。
import { clipRefSource, isTranslatedRef, refSourceOf } from './lib/ref-source.js'
// 停止信号的目标判定（2026-11）：信号只按对话分文件，必须再认"发给哪一轮"，否则过期信号
// 会把下一条消息整轮吃掉。判定是纯函数，被 agent/test/session-stop.test.js 钉住。
import { stopTargetsTurn, isStaleStop } from './lib/session-stop.js'
// 用量记账（2026-10 诊断）：每次 API 调用把服务商回来的 usage 落一行 JSON，只记不判断。
// 为什么现在才有：`stream_options.include_usage` 早就发着了，但解析时只读 delta、把 usage
// 丢掉了 —— 于是"缓存命中率低不低、低在哪一类调用上"只能看平台面板那个按小时的聚合数。
// 记账点只有两个（callLLMOnce / callLLMStream），见 lib/usage-log.js 头部。
import { recordUsage, readUsage, inferKind } from './lib/usage-log.js'
// L3 装配（2026-10-24）：旧路径（全量来路，每轮重发）保留，新路径（课题组分包）并列加，
// 用 data\config\l3-mode 切换——切换不需要重启，每轮现读。旧路径一行没删。
import { readL3Mode, assembleCallHist, l3Path } from './lib/l3-driver.js'
// L3 新路径（2026-10-24）：课题组分包 R1 草稿 → 派课题 → R3 判父 → R4 汇总。
// 纯逻辑（材料渲染、提示词、报告解析、流水线），LLM 调用与图查询都由 say() 注入，
// 所以能拿假模型跑整条链路（test/l3-tasks.test.js）。
import { runTasksPipeline } from './lib/l3-tasks.js'
// 「上一轮有效来路节点」的跨轮记忆（2026-10-26）：同一段讨论继续时，把它们并在本轮命中里重跑。
import { readLive, writeLive, clearLive } from './lib/l3-live.js'
// L3 全过程记录（2026-10-24，调试用）：把命题递归的每一步照实写成 Markdown，
// 一轮一份、边跑边写（data\runtime\l3-trace\）。开关见 l3DebugWanted。
import { openL3Trace, localStamp } from './lib/l3-trace.js'
// 同一份事件的**脑图**版本（自包含 HTML + 内联 SVG，无外部依赖）：跑完自动在浏览器里打开。
// 为什么要两份：脑图看形状（哪枝断了），Markdown 看细节（报告原文、R4 的输入全文）。
import { openL3Tree } from './lib/l3-tree.js'
// `/l3` 指令（2026-10-24）：切 full/tasks/both/off + 开关调试。开关本来是文件，
// 但"找目录、写对、记住下一句生效"这套太麻烦——收进一条指令，回执还会念一遍当前状态。
import { handleL3Command } from './lib/l3-cmd.js'
// 收件箱去重台账 + 游标语义（2026-09-30 机制级修复）已随 SQLite 存储层退役：
// "这条处理过没有"现在是 messages.status 一列，"到哪了"是自增 id——游标文件、指纹台账、
// decideCursor 判定全部不再需要。lib/inbox-dedupe.js 仍留着（迁移脚本用），运行时不再引用。

// ── 数据路径：全部来自 lib/paths.js（唯一真源，agent 与 receiver 共用）────────
// 2026-10 目录重构：数据不再跟着代码散在各个 __dirname 下，而是集中在 <包根>\data\，
// 按数据类型分格（config / profile / sessions / reading / runtime / toolbox）。
// 迁移缘由与分格依据见 lib/paths.js 头部；这里只取常量，不再自己拼路径。
import {
  AGENT_DIR, BOOKS_DIR, CHAT_DB, STREAM_FILE,
  AGENT_STATE_FILE, STOP_FILE, JOURNAL_FILE, TOPIC_STACK_FILE, GRAPH_FILE,
  BUILTIN_GRAPH_RESULTS_FILE, PROFILE_FILE, AGREEMENT_FILE,
  HIST_CURSOR_FILE, SESSIONS_DIR, LOGS_DIR, LAYOUT_KIND, layoutSummary,
  L3_DUMP_FILE, L3_DUMP_JSON, L3_DEBUG_FILE, L3_TRACE_DIR, L3_MODE_FILE,
  ensureDirs, migrateRenamedFiles, detectUnmigrated, scriptCommand,
  sessionStopFile, listSessionStopFiles,
  PACKAGE_ROOT,
} from './lib/paths.js'

// 数据目录可能还不存在（全新安装、或用户直接跑 agent）：先建齐。
// receiver 启动时也会调一次，幂等。
ensureDirs()

// 同目录内改过名的用户数据自动跟上（幂等）：老用户升级后不会"丢掉"相处规则。
// 2026-10 起：values-portrait.md → agreement.md（角色从"AI 自画像"换成"相处契约"）。
// 新名已存在就一个字都不动（规则见 lib/paths.js 的 migrateRenamedFiles）。
const _renamed = migrateRenamedFiles()
for (const d of _renamed.done) console.log(`  ✓ 数据文件已改名：${d}`)
for (const f of _renamed.failed) console.log(`  ⚠️ 数据文件改名失败：${f}`)

// ── 单实例保护（2026-10-07）──────────────────────────────────────────────
// 为什么需要：托盘的自愈逻辑在"以为 agent 掉了"时会再拉一个（它的判据曾被 WMI 挡住，
// 见 installer/launcher/tray.ps1 的注释）。agent 自己不设防时，两个进程会同时读同一个
// 聊天库、各回一条 —— 用户看到的就是**同一条消息被回复两次**。
// 2026-10-07 实测：25 秒内被拉起 3 个（logs/agent.log 里记着三次「启动」）。
//
// 用什么：**命名管道** `\\.\pipe\CoReadAgent`。它就是 Windows 内核命名对象那一族，
// 和托盘用的具名互斥体同一个原理：
//   · 抢的时候是原子的 —— 内核保证，第二次绑定必定失败（本机实测 EADDRINUSE）
//   · 进程无论怎么死，内核都会释放它 —— **不留文件，也没有 PID 复用问题**
// 为什么不用端口当锁：端口会被无关程序占坑，那时我们会误判成"已有实例"而**拒绝启动**；
// 管道名只可能被我们自己占用。
// 为什么用全局作用域（不带会话前缀）：data\ 是整机一份，跨用户跑两个 agent 会写同一个库。
//
// 拿不到锁就直接退出：宁可这个进程不启动，也不能两个一起回话。
//
// 2026-11 追加：这把锁**兼职应答**。以前连接回调是 `(sock) => sock.destroy()`，谁拨进来都
// 只说不上话，于是托盘只能靠"我记得我启动过"来猜 —— 上一班托盘留下的 agent、另一份 CoRead
// 文件夹的 agent，它都看不见，状态就瞎报（用户报过"启动后托盘显示未运行/已停止"）。
// 现在回一行 JSON：{role,v,pid,root}，托盘拨一次就知道"有没有 agent、是不是它那一份"。
// 占线状态本身就是权威判据（名字全机唯一），协议与格式化在 lib/agent-identity.js，
// 托盘那一侧是 installer/launcher/tray.ps1 的 Get-AgentPipeInfo，两边有测试盯着。
const AGENT_LOCK_PIPE = AGENT_PIPE_NAME
const lockResult = await new Promise((resolve) => {
  const srv = net.createServer((sock) => serveHello(sock, PACKAGE_ROOT))
  srv.once('error', (err) => resolve({ srv: null, err }))
  srv.listen(AGENT_LOCK_PIPE, () => resolve({ srv, err: null }))
})
if (lockResult.err) {
  if (lockResult.err.code === 'EADDRINUSE') {
    // 落一条**不会被覆盖**的痕迹：多个 agent 共用 logs\agent.out.log，新实例的
    // Start-Process 重定向会把它清空 —— 今天就是因为这个，事后什么都查不到。
    try {
      fs.appendFileSync(
        path.join(LOGS_DIR, 'agent-instances.log'),
        `[${new Date().toISOString()}] 拒绝启动：${AGENT_LOCK_PIPE} 已被占用（本进程 PID ${process.pid}）\n`
      )
    } catch {}
    console.error(`⚠️ 已经有 CoRead agent 在运行（${AGENT_LOCK_PIPE} 被占用），本进程退出。`)
    console.error('   要另开一个（调试用）请先从托盘退出 CoRead。')
    process.exit(0)
  }
  // 锁本身出错不该让程序起不来：宁可漏挡，也不要误拒（与托盘那条同样的取舍）
  console.error(`⚠️ 单实例锁创建失败（${lockResult.err.code || lockResult.err.message}）：跳过这道检查继续启动。`)
}

const RESULTS_GRAPH_FILE = BUILTIN_GRAPH_RESULTS_FILE  // 内置回退图（builtin\，随包分发，非用户数据）
let _store = null
function chatStore() {
  if (!_store) _store = openChatStore(CHAT_DB)
  return _store
}
/**
 * 退出前关掉聊天库。**每次退出都必须走这里。**
 * 为什么：SQLite 在最后一个连接正常 close() 时，会自动把暂存本（-wal）搬回主库、
 * 并删掉 -wal 与 -shm。不 close 直接 process.exit(0) 的话这两个文件会一直留着，
 * 主库停在旧版本（本机实测过：300 条插入全留在 1.2 MB 的暂存本里）。
 * 数据不会因此损坏（下次连接会自动恢复），但"干净退出"这道安全网就失效了。
 */
function closeChatStore() {
  if (!_store) return
  try { _store.close() } catch (e) { console.error(`⚠️ 关闭聊天库失败：${e.message}`) }
  _store = null
}
function resetStreamFile() {
  try { fs.writeFileSync(STREAM_FILE, '') } catch {}
}
// 处理步骤状态（2026-10）：侧栏"正在…"文案数据源。独立文件——不入库，纯瞬态。
// 致命故障（余额/鉴权）暂存：say() 捕获时登记，poller 读到后中止本轮队列并暂停。
// 用"取走即清空"的语义，避免一次故障被后续消息重复归因。
let _lastFatalError = null
function takeFatalError() {
  const e = _lastFatalError
  _lastFatalError = null
  return e
}
// ── 数据路径（承接上方 import；此处只做"给旧名字起别名"，定义都在 lib/paths.js）──
// 自由模式（2026-09 定调；2026-11 扩为多对话）：侧栏里的独立上下文，每个自由对话
// 一个 bookKey（__coread_free_<8hex>__，默认对话沿用历史哨兵 __coread_free_mode__，
// 见 lib/free-conversation.js），对话之间历史/讨论栈/命中全隔离。对话内容默认是
// 临时的（不写 journal、不收口固化）——归档时由用户勾选：保存记忆（背景画像）、
// 收编进正式拓扑图（完整固化）、或都不留（见 archiveFreeConversation）。
const FREE_KEY = LEGACY_FREE_KEY

// 模型 API 配置（2026-10）：真源 = agent/api-config.json（插件侧栏「⋯ → 模型 API 配置」
// 经 receiver 写入），.env 的 COREAD_* 作为回退（见 lib/api-config.js）。
// 每次 LLM 调用前重读 → 插件里改完立即生效，不需要重启 agent。
// 未配置时**不再启动即退出**：旧行为会让 agent 直接死掉，用户在插件里填好配置也没人应答；
// 现在改为启动告警 + 调用时报错（requireApiConfig），配置补齐后下一次提问即可用。
if (!isConfigured(resolveApiConfig())) {
  console.warn('⚠️  模型 API 未配置：请在插件侧栏右上角「⋯ → 模型 API 配置」里填写；')
  console.warn('    或在 agent/.env 里设置 COREAD_API_BASE / COREAD_API_KEY（可选 COREAD_MODEL）。')
}

// ── 文件读取 ────────────────────────────────────────────────────────────────
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}
// 「读失败」与「文件不存在 / 内容为空」必须分开（2026-09-30 机制级修复）：
// 瞬时故障（Windows 共享冲突 / 权限 / rename 空窗）返回 null，调用方据此**跳过本轮**；
// 绝不能像 readIfExists 那样把它们吞成 ''，再被下游兜底成 0——0 在队列语义里等于
// "从第 0 行重扫"，2026-09-28 正是这样重放了 288 条旧提问（见 lib/inbox-dedupe.js 头部）。
function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return ''    // 文件不存在 = 空，不是故障
    console.log(`  ⚠️ 读取失败（按"未知"处理，不当作空值）: ${p} — ${(e && (e.code || e.message)) || e}`)
    return null
  }
}

// ── 用户书籍足迹（跨书联动的轻量数据源） ──────────────────────────────────
// 只统计真实微信读书的书（meta.json 里有 wereadBookId），自动排除测试书。
// 跨书联动不依赖原文检索/分词，直接让 AI 用自身知识库对这些书名做主题关联。
function userBookTitles() {
  const titles = []
  try {
    for (const name of fs.readdirSync(BOOKS_DIR)) {
      const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json'))
      if (!meta || !meta.wereadBookId || !meta.bookTitle) continue
      titles.push(String(meta.bookTitle).replace(/\s+/g, ' ').trim())
    }
  } catch {}
  return [...new Set(titles)].sort()
}

// ── 上下文加载（启动时一次性构建；system 只含静态内容，不再重建） ────────────
// 2026-09 画像下沉：画像/相处规则/书籍足迹从 system 移到 personaBlock（本次消息头部）。
// system 只剩【重要】头 + AGENT.md（静态）——会话结束固化
// （saveSessionMemory 重写 profile）、新书足迹都不再触碰 system；
// 前缀缓存因此稳定：跨会话恢复历史后，[静态S + 恢复历史] 前缀可跨会话命中。
function buildSystemInstruction() {
  const rules = readIfExists(path.join(AGENT_DIR, 'AGENT.md'))   // 人格规则是程序文件，仍随代码走
  return [
    '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n',
    rules,
  ].join('')
}

// 易变人格块（画像下沉，2026-09）：每次 say 组装时动态读文件拼入本次消息头部。
// 变化只落在"本次消息"（每次本来就是新内容），不触碰历史前缀。
// 2026-09 防跑题（09-07 火星报段落教训）：整块以【背景档案】身份出现，明确"不是用户
// 本轮发言"——此前画像原样拼在提问前，模型把"自述/自陈"式概括当成用户本轮原话，
// 答非所问并编造"你自己说过…"。档案内容禁止被转述/引用为用户原话（AGENT.md 同款规则）。
function personaBlock() {
  const profile = readIfExists(PROFILE_FILE)
  const agreement = readIfExists(AGREEMENT_FILE)
  const titles = userBookTitles()
  const bookSection = titles.length
    ? '\n\n【用户书籍足迹】（已添加引用/划线的书，用于跨书联想）\n' + titles.map((t) => `- 《${t}》`).join('\n')
    : ''
  return '【背景档案】（用户画像 / 相处规则 / 书籍足迹的内容——不是用户本轮发言，' +
    '只用于理解用户背景；即使出现"自述/自陈/你说过"式表述，也不得转述或引用为用户原话）\n\n' +
    // 相处规则（2026-10）：它是**对 AI 的行为要求**，不是背景资料——块内定性写明"请遵守"，
    // 否则模型会把它当"用户的兴趣描述"读过去（老版块名「你的自画像」正是这个毛病）。
    `【用户画像】\n${profile}\n\n【相处规则】（用户对你（AI）的长期要求，请遵守）\n${agreement || '（暂无）'}${bookSection}`
}

// ── 侧栏聊天 I/O（SQLite）────────────────────────────────────────────────────
// 一条消息 = 库里一行。bookKey 就是 conversations.key（删除据此精确清理，不再靠 bookKey 过滤重写文件）。
// opts: { status='ok'|'failed', error, replyTo, bookId/bookTitle/chapter/chapterUid/selectedText }
function appendChatOutput(role, content, bookKey, opts = {}) {
  const row = {
    conv: String(bookKey || '_common'),
    role,
    content: stripCodeBlocks(content),
    ts: Date.now(),
    status: opts.status || 'ok',
    error: opts.error,
    replyTo: opts.replyTo,
    bookId: opts.bookId, bookTitle: opts.bookTitle, chapter: opts.chapter,
    chapterUid: opts.chapterUid, selectedText: opts.selectedText,
  }
  try {
    return chatStore().insertMessage(row)
  } catch (e) {
    // 外键兜底（2026-11 修）：reply_to 指向的那条消息可能在本条写库前就被删了——
    // /归档 正是这条路径（archiveFreeConversation 第③步先删掉这场对话的全部消息，
    // 调用方才把回执写回来，而回执的 reply_to 指的是刚被删掉的 /归档 指令行）。
    // chat-store 开着 PRAGMA foreign_keys=ON，这种插入会整条失败 → 回执彻底丢失：
    // 用户既没有 toast 也没有系统气泡，界面上"什么都没有发生"（实测踩到，
    // data/sessions/chat.db 里连一行 system 都没留下）。
    // reply_to 只是给侧栏做提问/回复配对用的显示字段，丢了不影响内容——回执必须送到。
    if (row.replyTo && /FOREIGN KEY/i.test(String(e.message || ''))) {
      console.log(`  ⚠️ 写库撞外键（reply_to=${row.replyTo} 已被删）——去掉配对重写一次，保住回执`)
      try {
        return chatStore().insertMessage({ ...row, replyTo: undefined })
      } catch (e2) {
        console.log(`  ⚠️ 写库失败：${e2.message}`)
        return 0
      }
    }
    console.log(`  ⚠️ 写库失败：${e.message}`)
    return 0
  }
}

// 流式快照 → 瞬态通道（不入档）。content 存累计文本，侧栏据 _stream 渲染打字机；
// 接收端按字节偏移 tail，收到 seq=-1 把气泡标记完成。
//
// replyToTs = **这一轮提问落库的 timestamp**，也就是侧栏那边的"哪一轮"身份证（2026-11）。
// 为什么非带不可：用户点「停止」时侧栏是本地先收尾的（提问与半截回答两颗气泡当场删掉），
// 而 agent 这一头可能还在生成——实测模型第一个 token 能晚到 **8.6 秒**（点停止 19:58:08.982，
// 第一片 19:58:17.611）。那一片照样被写进瞬态通道、接收端照样转给侧栏，而侧栏此刻已经
// "当没问过"了：它只能新建一颗气泡把那半句画上，且这一轮**永远不会有完整回答再落库**来补它
// → 屏幕上留下一颗没有提问的小气泡（用户报的「小气泡里写着'这句话'」）。
// 带上身份证后，侧栏认得出"这片属于已弃掉的那一轮"，直接丢掉。
let _streamSeq = 0
/** 瞬态流记录的归属字段：哪场对话（bookKey）+ 哪一轮（replyToTs）。 */
function streamTurnFields(bookKey, replyToTs) {
  return {
    ...(bookKey ? { bookKey } : {}),
    ...(replyToTs ? { replyToTs: Number(replyToTs) } : {}),
  }
}
function appendChatOutputStream(content, bookKey, replyToTs) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify({
      role: 'assistant',
      content: stripCodeBlocks(content),
      _stream: _streamSeq++,
      timestamp: Date.now(),
      ...streamTurnFields(bookKey, replyToTs),
    }) + '\n')
  } catch {}
}
// 流结束标记：侧栏收到 _stream === -1 后把该条流标记为完成
function appendChatOutputStreamEnd(bookKey, replyToTs) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify({
      role: 'assistant', content: '', _stream: -1, timestamp: Date.now(),
      ...streamTurnFields(bookKey, replyToTs),
    }) + '\n')
  } catch {}
}

// 会意图命中事件（topic-library-design.md §5.4④）：引用解析命中旧知识点 → 记一条事件
// （events 表，不进 messages——它没有正文，混在消息里会污染配对与 /history）。
// bookKey = 命中所属书；侧栏图视图据此高亮命中节点的 root→recent 路径并集。
//
// replyToTs（2026-11）= 这一轮提问落库的 timestamp。为什么要带：命中是在**生成回答之前**
// 写出来的，而用户可能刚好在"引用判定"这几秒里点了停止 —— 事件照样被推到侧栏、把图点亮，
// 而那一轮已经被弃掉了（提问行、栈里都没有它）。带上身份证，侧栏才认得出"这波命中属于
// 已弃的那一轮"，直接不点亮（判定规则与流式分片同源，见 extension/sidebar.js 的 _discardedTurnTs）。
function appendGraphHit(hits, reason, bookKey, replyToTs) {
  try {
    chatStore().insertEvent({
      conv: String(bookKey || ''),
      kind: 'graph-hit',
      payload: {
        hits: hits || [],
        reason: String(reason || '').slice(0, 200),
        bookKey: String(bookKey || ''),
        ...(replyToTs ? { replyToTs: Number(replyToTs) } : {}),
      },
    })
  } catch {}
}

// 处理步骤状态行（2026-10）：agent 当前处理步骤 → receiver 轮询转发 SSE（type=agent-state）
// → 侧栏思考气泡按步骤显示文案（resolve=检索旧知识点 / answer=组织回答）。
// 瞬态行：累计 100 次后裁剪保留最近 100 行（防无限增长）。
let _stateAppends = 0
function appendAgentState(step, bookKey) {
  try {
    fs.appendFileSync(AGENT_STATE_FILE, JSON.stringify({ step, bookKey: String(bookKey || ''), timestamp: Date.now() }) + '\n')
    if (++_stateAppends % 100 === 0) {
      const lines = (readIfExists(AGENT_STATE_FILE) || '').trim().split('\n').filter(Boolean)
      if (lines.length > 200) fs.writeFileSync(AGENT_STATE_FILE, lines.slice(-100).join('\n') + '\n')
    }
  } catch {}
}
// 侧栏消息队列 = 库里"待处理"的行。旧实现读文件 + 游标 + 指纹台账三件套来判断"哪条还没答"，
// 现在就是一条 SQL：status IN ('pending','failed') 按 id 升序（id 即到达顺序）。
// failed 也入队 = 失败会重试（旧实现"调用前记指纹"导致失败的消息永不重试，2026-09-28 的 213 条就是这样）。
function readPendingMessages(limit = 10) {
  try { return chatStore().listPending({ limit }) } catch (e) {
    console.log(`  ⚠️ 读取待处理消息失败：${e.message}`)
    return []
  }
}
function markMessage(id, fields) {
  try { chatStore().updateMessage(id, fields) } catch (e) { console.log(`  ⚠️ 更新消息状态失败：${e.message}`) }
}

// ── 停止当前回答（2026-02 用户定调）─────────────────────────────────────────
// 侧栏点「停止」→ receiver 写一个按对话区分的信号文件 → agent 在处理中读到就**弃掉这一轮**：
// 屏幕上提问与半截回答都删、库里也不留行、记忆标作废、讨论栈与图谱完全不碰，
// 只有原文由侧栏回填进输入框。
//
// 为什么做成"信号文件"而不是掐断请求：receiver 与 agent 是两个进程，
// 能让 fetch 中断的 AbortController 是 agent 进程内的对象，另一个进程够不着。
const ABORTED_CODE = 'COREAD_USER_STOPPED'   // 专用标记：与 HTTP 状态码区分（err.status 已被 401/402/403 判定占用）
// say() 在"用户停止"时返回这个标记（而不是 ⚠️ 串）：调用方据此跳过入栈、走弃轮清理。
// 用标记而不是抛异常：say() 是"永远返回字符串"的既有契约，改契约会牵动所有调用点。
const ABORTED_REPLY = '\u0000COREAD_ABORTED'
function isAbortedReply(reply) { return String(reply) === ABORTED_REPLY }
function isAborted(e) { return !!e && e.code === ABORTED_CODE }
function abortedError() {
  const e = new Error('用户停止了本轮回答')
  e.code = ABORTED_CODE
  return e
}
/**
 * 读走本对话的停止信号（读到即删）。agent 在**三道闸**上调用它（位置都在 say() 里，按出现顺序）：
 *
 *   ① 队列每条开始前（processChat 里）——"这条还没开始处理，直接整轮弃掉"（不解析、不生成、不入栈）。
 *   ② 流式循环里、**等下一次返回之前**——别再多等一片、别再多花一份钱。
 *   ③ 流式循环里、**每次返回之后**（在 `result.done` 判断**之前**）——用户点的停止多半就落在
 *      这段等待里（实测等了 8.6 秒）；不拦的话这一片会照样被写出去、侧栏照样画出来。
 *      ⚠️ 位置不能往下挪到"写之前"：最后一圈拿到的是 `{done:true}`，会走 break 直接出循环，
 *      放在写入口等于"收尾那一圈永远不看停止"，而那段等待可能很长。
 *      **这是落库前的最后一眼**：它之后只有同步代码，直到记忆合并里那次 `await`
 *      —— 而那一段的点停止按"来晚了"处理（合并有副作用、撤不回，见下面收尾处的注释）。
 *      所以循环外不需要第四道闸。
 *
 * 三个位置各覆盖一段：②③ 在循环里（只在"这一圈被走到"时执行），① 在循环之前；
 * 循环退出之后只剩同步代码，因此不需要第四道闸。
 * 信号是"一次性的"：谁先读到谁删，删掉之后后续检查点自然放行，不会误伤下一轮。
 *
 * 2026-11：**只消费发给这一轮的那条**（turnTs = 本轮提问落库的 timestamp）。原先读到就删、
 * 不看目标，于是过期信号（模型调用失败 / 答案已落库之后才点停止）会被**下一条消息**的闸门吃掉，
 * 把那条消息整轮弃掉——用户看到的是"刚问的问题凭空消失"。判定逻辑见 lib/session-stop.js。
 */
function consumeSessionStop(conv, turnTs) {
  const f = sessionStopFile(conv)
  try {
    if (!fs.existsSync(f)) return false
    let signal = null
    try { signal = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
    if (!stopTargetsTurn(signal, turnTs)) {
      // 目标轮次已经过去：这条信号永远不会再被用上，顺手清掉（否则越积越多，还会误导排查）
      if (isStaleStop(signal, turnTs)) { try { fs.unlinkSync(f) } catch {} }
      return false
    }
    fs.unlinkSync(f)
    return true
  } catch { return false }
}
/** 启动清场：runtime 里的停止信号是瞬态文件，跨进程残留一律丢弃（同 stream.jsonl 的处理） */
function clearSessionStops(reason = '') {
  const files = listSessionStopFiles()
  for (const f of files) { try { fs.unlinkSync(f) } catch {} }
  if (files.length && reason) console.log(`  🧹 清理残留停止信号 ×${files.length}（${reason}）`)
}
/** 该提问是否已有完整回答（用于"停止来晚了"的判定：答完了就不再回头删） */
function hasReplyTo(id) {
  try {
    for (const rep of chatStore().pairReplies({}).values()) {
      if (Number(rep.replyTo) === Number(id)) return true
    }
  } catch {}
  return false
}
/**
 * 弃掉被用户停止的那一轮：屏幕上与库里都不留痕。
 *   · 提问行：整条删（留着的话面板重开时气泡会从历史里长回来）
 *   · 图谱命中事件：删（用户看不见的暗账，留着还会在断线重连时把高亮推回来）
 *   · 历史与 journal：由调用方与 say() 负责（它们在自己的作用域里）
 * 若发现该提问其实已经有完整回答（停止来晚了），就什么都不删——只把信号消费掉。
 * @returns {boolean} 是否真的弃掉了（false = 停止来晚了/找不到这条）
 */
function discardStoppedTurn({ conv, questionId }) {
  try {
    const id = Number(questionId || 0)
    if (!id) return false
    const row = chatStore().getMessage(id)
    if (!row) return false
    if (hasReplyTo(id)) {
      console.log(`  ⏹ 停止信号到达时这一轮已有完成回答（id ${id}）：不改动，仅消费信号`)
      return false
    }
    const del = chatStore().deleteMessages([id])
    const ev = chatStore().deleteEvents({ conv: String(conv || ''), kind: 'graph-hit' })
    console.log(`  ⏹ 本轮已停止：提问行与命中事件已删（messages ×${del} / events ×${ev}）`)
    return true
  } catch (e) {
    console.log(`  ⚠️ 停止清理失败（不影响后续）: ${e.message}`)
    return false
  }
}

// ── 标注队列（2026-10-17 整段删除）────────────────────────────────────────────
// 这里原本是"划线即讨论"的入口：readAnnotations 读 annotations.jsonl、getCursor/setCursor
// 记处理进度、processNewAnnotations 把没见过的划线交给 buildAnnotationPrompt 拼成
// 【新划线】prompt、再 say() 出回复。AI-010 之后这条路没有入口了（接收端不通知 agent、
// 标注全是 setRef / bookmark-sync），实测 298 条标注 0 条能进，于是连同三个工具函数一起删。
// 现在划线只做"设为当前引用"，讨论一律由用户在侧栏提问触发（见 processChat）。
// 游标文件 runtime\agent-cursor 不再读写；paths.js 里那条迁移映射留着（它只是把旧文件搬过去）。

// ── 章节原文上下文 ───────────────────────────────────────────────────────────
function chapterFileName(chapter) {
  return chapter ? chapter.replace(/[^\w一-龥]/g, '_').slice(0, 40) : ''
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

function bookDirNames(bookId, bookTitle = '') {
  if (!bookId) return []
  const baseId = baseBookId(bookId)
  // 归一化后的 baseId 是权威目录，排在第一位
  const names = [baseId]
  const targetTitle = normalizeText(bookTitle)

  try {
    // 向后兼容：扫描已有的 k-suffix 历史目录（迁移前的遗留数据）
    const legacyDirs = fs.readdirSync(BOOKS_DIR)
      .filter(name => name !== baseId && name.startsWith(`${baseId}k`))
      .map(name => {
        const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json')) || {}
        return { name, updatedAt: meta.updatedAt || 0 }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => s.name)
    names.push(...legacyDirs)
  } catch {}

  // 书名模糊匹配（用于 bookId 未知但知道书名的场景）
  if (targetTitle) {
    try {
      const titleMatches = fs.readdirSync(BOOKS_DIR)
        .filter(name => !names.includes(name))
        .filter(name => {
          const meta = readJsonIfExists(path.join(BOOKS_DIR, name, 'meta.json')) || {}
          return normalizeText(meta.bookTitle) === targetTitle
        })
      names.push(...titleMatches)
    } catch {}
  }

  return [...new Set(names)]
}

function readChapterText(bookId, chapterUid, chapter, selectedText, bookTitle = '') {
  if (!bookId) return ''
  const exactMatches = []
  const fuzzyMatches = []
  for (const dirName of bookDirNames(bookId, bookTitle)) {
    const dir = path.join(BOOKS_DIR, dirName, 'chapters')
    const candidates = [
      chapterUid && path.join(dir, `${chapterUid}.txt`),
      chapter && path.join(dir, `${chapterFileName(chapter)}.txt`),
    ].filter(Boolean)

    for (const file of candidates) {
      const text = readIfExists(file)
      if (!text) continue
      if (hasExactSelection(text, selectedText)) exactMatches.push(text)
      else if (textHasSelection(text, selectedText)) fuzzyMatches.push(text)
    }

    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue
        const text = readIfExists(path.join(dir, name))
        if (!selectedText) continue
        if (hasExactSelection(text, selectedText)) exactMatches.push(text)
        else if (textHasSelection(text, selectedText)) fuzzyMatches.push(text)
      }
    } catch {}
  }

  return exactMatches[0] || fuzzyMatches[0] || ''
}

// 2026-10-17 删掉 chapterTexts / readProgress / readProgressContext（只服务于已停用的"划线即讨论"）。
// 它们只为"AI 主动讨论新划线"那条路拼 [本章已读进度概览] + [当前进度前文窗口]（引用点之前 1500 字）。
// 那条路自 AI-010 起没有入口：接收端 /annotation 只写盘推事件、不通知 agent
// （receiver/index.js:1538），agent 侧的 processNewAnnotations 也会跳过 setRef / bookmark-sync
// （那个函数同日一并删除），实测 298 条标注里 0 条能进。于是这 1500 字只通过两条路共用的
// assembleBookContext 混进了"侧栏提问"，把 7 个字的提问埋到 2000 字原文后面（2026-10-17 用户反馈）。
// 真要恢复"划线即讨论"，得从接收端重新接线、并按"提问优先"重排上下文，不是把这几个函数抄回来就行。

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function selectedNeedles(selectedText) {
  const source = String(selectedText || '')
  const pieces = source
    .split(/[。！？；，,.!?:：;、“”"'\n\r\t（）()]+/)
    .map(s => normalizeText(s))
    .filter(s => s.length >= 10)
  const words = source.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []
  return [...new Set([normalizeText(source), ...pieces, ...words])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

function textHasSelection(text, selectedText) {
  if (!selectedText) return true
  const compact = normalizeText(text)
  return selectedNeedles(selectedText).some(needle => compact.includes(normalizeText(needle)))
}

function hasExactSelection(text, selectedText) {
  if (!selectedText) return true
  return normalizeText(text).includes(normalizeText(selectedText))
}

function looseIndexOf(text, needle) {
  if (!needle) return -1
  const exact = text.indexOf(needle)
  if (exact !== -1) return exact

  const compactNeedle = normalizeText(needle)
  if (!compactNeedle) return -1

  let compact = ''
  const positions = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    positions.push(i)
    compact += text[i]
  }
  const compactIdx = compact.indexOf(compactNeedle)
  return compactIdx === -1 ? -1 : positions[compactIdx]
}

function selectionMatch(text, selectedText) {
  for (const needle of selectedNeedles(selectedText)) {
    const idx = looseIndexOf(text, needle)
    if (idx !== -1) return { idx, length: needle.length }
  }
  return { idx: -1, length: 0 }
}

function chapterWindow(bookId, chapterUid, selectedText, chapter, bookTitle = '') {
  const text = readChapterText(bookId, chapterUid, chapter, selectedText, bookTitle)
  if (!text) return ''
  const match = selectionMatch(text, selectedText)
  const idx = match.idx
  if (idx === -1) return text.slice(0, 600)
  const start = Math.max(0, idx - 300)
  const end = Math.min(text.length, idx + Math.max(match.length, selectedText.length) + 300)
  return text.slice(start, end)
}

// ── LLM API ──────────────────────────────────────────────────────────────────
let SYSTEM = buildSystemInstruction()

// 会话上下文按书隔离（AI-001）：key = baseBookId | '_common' | '_meta'
// 读书 X 时的标注讨论、书绑定聊天、自由消息都进 history[X]；切书后互不污染。
// 无书签消息进 '_common'；记忆重写这类元任务进 '_meta'，不进任何书的上下文。
const histories = new Map()  // key -> [{ role: 'user'|'assistant', content: string, id?: number }]
//                                                          ↑ id 只是截尾点位标记，发 API 前剥掉
function histFor(key) {
  if (!histories.has(key)) histories.set(key, [])
  return histories.get(key)
}
let currentBookKey = ''  // 后端跟踪的"正在读的书"（baseBookId），自由消息归属用

// ── 历史惰性截尾（2026-09 用户定调 + 缓存实测）───────────────────────────────
// 前缀缓存只认"从头连续相同"：历史必须**追加式**（每次 = 上次 + 末尾新消息），
// 命中率实测 95%+；每轮滑一条的窗口会让全部历史失配（实测 0%），不可取。
// 输入有界靠"惰性截尾"：平时纯追加（缓存友好），总 token 超预算（64K ≈100 轮）
// 时才从最老处整条切掉一批、切到裁剪目标（40 轮 ≈25.7K）——留 ~60 轮增长余量，
// 避免"切完紧贴预算、追加一条又触发"（那样裁剪频率 = 滑动窗口，失配全废）。
// 被切的是最老消息，长期价值已被会意图（L3 全量带回）/ 会意栈（跨会话持久化）/
// 背景画像兜底，不丢数据。
// 参数（2026-09 用户拍板）：BUDGET 64K（1M 窗口下请求体量主开关，占 92% 是历史）；
// TRIM 40 轮（承接下限仍充裕：单章讨论 3~10 轮）。裁剪间隔 ≈ (64K-25.7K)/643 ≈ 60 轮。
const HIST_TOKEN_BUDGET = 64000            // 预算上限：超过才触发裁剪（≈99 轮）
const HIST_TRIM_TARGET = 25720             // 裁剪目标：40 轮 × 实测每轮 643 token（≈40 轮）
const TOKEN_PER_CHAR = 0.62                // 实测校准：真实历史 19.9 万字符 = 12.2 万 token（字符/token≈1.6）
// 截尾点位（2026-11 修：从"累计切掉条数"改成"切到哪条消息"）：
//   { bookKey: { afterId: <被切掉部分里最后一条消息的 id> } }
// 为什么不再按条数记：条数是**计数**，它假设库里的消息只增不减——可这个库里会删行
// （停止一轮删提问、归档删整场、清 ⚠️ 的脚本删失败气泡），删一条后面全部错位，点位就指歪了。
// 消息 id 只增不减，删行不会让 `id > afterId` 这个判据失效。
// 旧格式（number）无法映射成 id，读到就按 afterId=0 全量恢复，等下一次截尾重新记点位。
// 历史截尾点位文件定义在 lib/paths.js（HIST_CURSOR_FILE = sessions\hist-cursors.json）
let histCutCursors = {}   // 运行时态：{ bookKey: { afterId } }；main 启动时 loadHistCursors() 加载
/** 取某本书的截尾点位（0 = 全量恢复）。旧格式数字 → 0，并提示重新记点位。 */
function cursorAfterId(key) {
  const c = histCutCursors[key]
  const n = Number(c && typeof c === 'object' ? c.afterId : NaN)
  return Number.isFinite(n) && n > 0 ? n : 0
}
function loadHistCursors() {
  try {
    const o = JSON.parse(readIfExists(HIST_CURSOR_FILE))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch { return {} }
}
function saveHistCursors() {
  try { fs.writeFileSync(HIST_CURSOR_FILE, JSON.stringify(histCutCursors)) } catch {}
}
function estimateTokens(text) {
  // 校准后的 token 估算（2026-09 实测）：中文为主的混合文本 1 字符 ≈ 0.62 token
  return Math.ceil(String(text || '').length * TOKEN_PER_CHAR)
}
function trimHistoryByBudget(key, hist) {
  if (!hist.length) return
  let total = 0
  for (const m of hist) total += estimateTokens(m.content)
  if (total <= HIST_TOKEN_BUDGET) return   // 未超预算：纯追加，不动序列（缓存前缀保持，95%+ 命中）
  // 超预算：从最新往前数，保留最近一组 ≤ TRIM_TARGET 的消息，更老的全部整条切掉（最新一条永不切）
  let acc = 0
  let cut = 0
  for (let i = hist.length - 1; i >= 0; i--) {
    acc += estimateTokens(hist[i].content)
    if (acc > HIST_TRIM_TARGET && i < hist.length - 1) { cut = i + 1; break }
  }
  if (cut > 0) {
    if (cut % 2 === 1) cut += 1   // 切偶数条：保留段必须从 user 消息开始（消息序列 user/assistant 交替，
                                  // 恢复时按整轮取数，切半轮会让首条变成 assistant、配不成对）
    const removed = hist.splice(0, cut)
    // 截尾点位 = 被切掉部分的**最后一条消息 id**（2026-11）：恢复时取 `id > afterId`，
    // 拿回来正好是"在线时还留在内存里的那一段"。取不到 id（如 _meta 这类不落库的历史）
    // 就不更新点位——宁可不记，也不要记一个错的数把历史切歪。
    const last = removed[removed.length - 1]
    const lastId = Number(last && last.id)
    if (Number.isFinite(lastId) && lastId > 0) {
      histCutCursors[key] = { afterId: lastId }
      saveHistCursors()
    }
    console.log(`  [hist] ${key} 惰性截尾 ${removed.length} 条（预算 ${HIST_TOKEN_BUDGET}，切至 ${HIST_TRIM_TARGET}，剩 ${hist.length} 条，点位 afterId ${cursorAfterId(key)}）——长期内容由会意图 L3 / 栈 / 画像兜底`)
  }
}

function totalHistoryLength() {
  let n = 0
  for (const [k, h] of histories) {
    if (k !== '_meta') n += h.length
  }
  return n
}

// ── 历史启动恢复（2026-09 用户定调：跨会话需要旧消息）────────────────────────
// histories 是内存态、重启即空——跨会话承接断裂（进行中讨论的轮次在主回复
// prompt 里丢失，模型不知道之前聊到哪）。启动时从聊天库重建每本书的轮次。
// 恢复范围 = 截尾点位之后（2026-11 修）：在线每次惰性截尾都把"切到哪条消息"落盘，
// 恢复时取 `回答 id > afterId`——拿回来正好是"在线时还留在内存里的那一段"，
// 跨会话前缀可命中（system 已画像下沉，静态稳定）。
//
// ⚠️ 这里**不能**再出现"固定取最近 N 条"：2026-11 之前是 `loadTurns(key, {limit:60})`
// 再用 `Math.min(游标, list.length)` 跳过开头。LIMIT 数的是消息行（60 行 = 30 轮），
// 而游标是按累计切掉条数涨的（一次截尾就跳 ~118）——两个坐标系一减，游标一超过 60
// 就跳过整段，**整本书的历史在重启后全空**（实测两本书的游标 148 / 158 正踩线上）。
// 现在范围完全由 afterId 决定，没有任何魔法数字。
function restoreHistories() {
  try {
    const store = chatStore()
    const convs = Object.keys(store.countByConv())
    // storeText 与 say() / 旧文件版完全同款构造（AI-017：不含章节窗口，防书摘录当用户的话）
    const storeTextOf = (u) => (u.selectedText
      ? `【划线】《${u.bookTitle || ''}》${u.chapter || ''}\n划线原文：${u.selectedText}\n我的提问：${u.content}`
      : u.content)
    for (const key of convs) {
      if (key === '_meta') continue
      const legacy = histCutCursors[key] != null && typeof histCutCursors[key] !== 'object'
      if (legacy) {
        console.log(`  [hist] ${key} 旧版截尾记录（按条数记）对不上任何消息——本次全量恢复，下次截尾重新记点位`)
      }
      const afterId = cursorAfterId(key)
      // 成轮的才有 user+assistant 一对（reply_to 直连；未配对的提问不成轮）
      const turns = store.loadTurns(key, { afterId })
      if (!turns.length) continue
      const hist = histFor(key)
      for (const t of turns) {
        // id 随条目一起带着：trimHistoryByBudget 靠它记截尾点位（不发 API，见 apiMessages）
        hist.push({ role: 'user', content: storeTextOf(t.user), id: Number(t.user.id) || undefined })
        hist.push({ role: 'assistant', content: stripCodeBlocks(stripMemorize(t.assistant.content)), id: Number(t.assistant.id) || undefined })
      }
      // 兜底：点位之后的内容若已超预算（比如离线期间攒了很多），这里再按预算裁一次并更新点位
      trimHistoryByBudget(key, hist)
      if (hist.length) console.log(`  [hist] ${key} 启动恢复 ${hist.length} 条（${Math.round(hist.length / 2)} 轮，afterId ${afterId}）`)
    }
  } catch (e) {
    console.log(`  ⚠️ 历史启动恢复失败（不影响运行）: ${e.message}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function htmlTitle(text) {
  const match = String(text || '').match(/<h1[^>]*>(.*?)<\/h1>/i)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

// 取当前生效的模型 API 配置；未配置时给出可操作的报错（侧栏按普通回复失败展示）。
// 每次调用现取：插件里改完配置，下一次提问就生效。
function requireApiConfig() {
  const cfg = resolveApiConfig()
  if (!isConfigured(cfg)) {
    throw new Error('模型 API 未配置：请在侧栏右上角「⋯ → 模型 API 配置」里填写 API 地址与 Key')
  }
  return cfg
}

/**
 * 发给 API 的 messages 只留 role / content。
 *
 * 为什么非剥不可（2026-11）：hist 条目上多挂了一个 `id`——它是本机用来记截尾点位的
 * （见 trimHistoryByBudget / restoreHistories），不是对话内容。直接展开出去，
 * 请求体就会多出一个字段，而服务端前缀缓存是**按字节比对**的：多一个字段等于每条
 * 消息都不一样，95%+ 的命中率当场归零（DeepSeek-flash 命中/未命中差 50 倍单价）。
 */
function apiMessages(list) {
  return list.map((m) => ({ role: m.role, content: m.content }))
}

async function callLLMOnce(maxTokens = 8192, hist = [], opts = {}) {
  const { apiKey, apiBase, model } = requireApiConfig()
  const system = opts.system !== undefined ? opts.system : SYSTEM  // 判定调用可覆盖 SYSTEM（避免阅读助手指令干扰判定）
  // 用量记账的类型：判定类调用共用这一个入口（judgeLLM），拿不到调用方名字 → 按指令首句认。
  // 只影响报表分档，不影响任何判定（见 lib/usage-log.js 的 inferKind）。
  const usageKind = opts.kind || inferKind(hist.map((m) => m.content).join('\n'))
  // 截断机制（2026-08-28，lib/llm-api.js 同款）：finish_reason:length 视为失败——
  // 预算不足 → 升级到 MAX_JUDGE_TOKENS 重发同 body 一次；仍截断 → 抛错（宁漏勿误，
  // 截断产物/思考草稿绝不当作输出，d_14 point="..." 教训）。
  const MAX_JUDGE_TOKENS = 16384
  let budget = maxTokens
  for (let round = 1; round <= 2; round++) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...apiMessages(hist)],
      max_tokens: budget,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      // 机械调用（课题报告/派题）关掉思考：实测同一份报告，思考占 93% 的输出、耗时从 1.5s 涨到 14s，
      // 而正文长度几乎不变（235 → 232 字）。只有 `thinking.type=disabled` 有效，
      // `reasoning_effort: low` 反而想得更多（见 docs §9.1）。
      ...(opts.thinking === false ? { thinking: { type: 'disabled' } } : {}),
      tool_choice: 'none',
    })

    // 防止 fetch 永久挂起导致 agent 卡死
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)
    const startedAt = Date.now()

    let resp
    try {
      resp = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const raw = await resp.text()
    let data
    try { data = JSON.parse(raw) } catch { data = null }

    // 用量记账（先于所有抛错分支）：这一份响应已经扣过费了，哪怕后面按"截断/报错"处理，
    // 也得记下来——否则报表上少掉的正是最贵的那几次（超长判定被截断后升预算重发 = 两份钱）。
    // 只记"带 usage 的响应"：429/500 的错误体没有 usage，那些请求根本没进模型，不该占一行。
    const usage = data ? readUsage(data) : null
    if (usage) recordUsage({
      kind: usageKind, model, conv: opts.conv, stream: false,
      usage, ms: Date.now() - startedAt,
    })

    if (!resp.ok) {
      const brief = data?.error?.message || htmlTitle(raw) || raw.slice(0, 120).replace(/\s+/g, ' ').trim()
      const err = new Error(`LLM API ${resp.status}: ${brief || '请求失败'}`)
      err.status = resp.status
      throw err
    }
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const msg = data.choices?.[0]?.message
    const finish = data.choices?.[0]?.finish_reason

    if (finish === 'length') {
      if (budget < MAX_JUDGE_TOKENS) {
        budget = MAX_JUDGE_TOKENS  // 预算升级，重发同 body（模型没收到过修正，原样重发）
        continue
      }
      throw new Error('LLM 输出被截断（finish_reason: length，16384 预算仍不够）')
    }

    // content 优先作为回复；若为空则回退到 reasoning_content（少数推理模型会把回复放这里）。
    // 注意：截断分支已提前返回——reasoning_content 只允许在**完整输出**时作回退。
    // contentOnly：课题报告/判父这类"机器要解析"的调用不许拿思考链顶替（思考不是答案，
    // 拿去解析只会得到"不是合法报告"，反而把真正的原因盖住）。
    const text = msg?.content?.trim() || (opts.contentOnly ? '' : msg?.reasoning_content?.trim())
    if (!text) throw new Error('模型无回应：' + JSON.stringify(data).slice(0, 200))
    return text
  }
  throw new Error('LLM 输出被截断（finish_reason: length）')
}

// ── 流式调用 LLM ────────────────────────────────────────────────────────────
// opts.kind / opts.conv 只用于用量记账（kind = 报表分档，conv = 哪场对话）；不参与请求体。
async function* callLLMStream(maxTokens = 8192, hist = [], opts = {}) {
  const { apiKey, apiBase, model } = requireApiConfig()
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: SYSTEM }, ...apiMessages(hist)],
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)

  let resp
  try {
    resp = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!resp.ok) {
    const raw = await resp.text()
    let data
    try { data = JSON.parse(raw) } catch { data = null }
    const brief = data?.error?.message || raw.slice(0, 120)
    const err = new Error(`LLM API ${resp.status}: ${brief}`)
    err.status = resp.status
    throw err
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let fullReasoning = ''
  // 流式响应的 usage 在**最后一帧**（那一帧 choices 是空数组），所以不能用 delta 判断要不要看它。
  // 只在拿到时记一笔：被用户点停/中途断掉的那次没有终帧，按"拿不到用量"处理（不记假账）。
  const usageKind = opts.kind || '主回复'
  const t0 = Date.now()
  let usageDone = false

  // 流中途停滞保护：长时间没有新 chunk（推理模型静默思考 / 连接卡死）就 abort，
  // 避免侧栏永远停在"思考中"。上面的 180s 超时只覆盖响应头阶段，管不到 body 流。
  let stallTimer = null
  const STALL_TIMEOUT = 150_000
  const resetStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT)
  }
  resetStall()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetStall()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data: ')) continue
        const json = s.slice(6)
        if (json === '[DONE]') continue

        try {
          const parsed = JSON.parse(json)
          // 终帧（usage）先记：它不带 choices，下面那条 delta 分支永远不会走到它
          if (!usageDone && parsed.usage) {
            usageDone = true
            recordUsage({
              kind: usageKind, model, conv: opts.conv, stream: true,
              usage: readUsage(parsed), ms: Date.now() - t0,
            })
          }
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) {
            fullContent += delta.content
            yield { chunk: delta.content, accumulated: fullContent }
          } else if (delta?.reasoning_content) {
            // 推理模型的思考链（reasoning_content）绝不作为回复发出：
            // 只在控制台留痕，防止思考内容（含对画像上下文的引用）泄漏进侧栏。
            fullReasoning += delta.reasoning_content
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(stallTimer)
  }

  if (!fullContent.trim()) {
    // 推理模型只输出思考、没有正文（reasoning_content 非空但 content 为空）：
    // 一律按空流处理触发重试，绝不把思考链当回复返回（思考含画像上下文引用，会泄漏给用户）。
    if (fullReasoning.trim()) console.log('  ⚠️ 模型仅输出思考链（reasoning_content），无正文，按空流重试')
    throw new Error('模型无回应（空流）')
  }

  return fullContent
}

async function callLLM(maxTokens = 8192, hist = [], opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callLLMOnce(maxTokens, hist, opts)
    } catch (e) {
      // 网络层失败原样抛出 → 抛前换成中文可诊断文案（带 cause.code），
      // 否则侧栏只会出现 `⚠️ fetch failed` 这种既看不懂也无法定位的串
      lastErr = isNetworkError(e) ? new Error(networkErrorMessage(e)) : e
      // 超时、网络错误、服务端错误均可重试（判定见 lib/error-classify.js）
      if (!canRetryError(e) || attempt === 3) break
      console.log(`  ⚠️ API 调用失败 (attempt ${attempt}/3): ${e.message}`)
      await sleep(1500 * attempt)
    }
  }
  throw lastErr
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
}

// 带重试的流式调用：只在「一个 chunk 都没产出」前重试（429/5xx/超时/网络层失败/空流），
// 已经吐出部分内容后的失败不重试（重发会造成内容错乱），直接向上抛。
async function* callLLMStreamWithRetry(maxTokens, hist, opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    const it = callLLMStream(maxTokens, hist, opts)
    let yielded = false
    try {
      while (true) {
        const { done, value } = await it.next()
        if (done) {
          // 生成器以 return 结束：已 yield 过 → 返回累计结果；
          // 未 yield 过但有返回值（纯推理模型把回复放在 return 的 fullReasoning）→ 也返回，
          // 否则会被当成空流重试 3 次后丢弃。只有既无 chunk 也无返回值（真·空流）才重试。
          if (yielded || value) return value
          break
        }
        yielded = true
        yield value
      }
    } catch (e) {
      if (yielded) throw e  // 中途失败：不重试（canRetryError 的 yielded 形参同样兜底）
      // 网络层失败：抛前换成中文可诊断文案（带 cause.code）；已是本模块产物则不重复包装
      lastErr = isNetworkError(e) ? new Error(networkErrorMessage(e)) : e
      if (!canRetryError(e) || attempt === 3) throw lastErr
      console.log(`  ⚠️ 流式调用失败 (attempt ${attempt}/3): ${e.message}`)
      await sleep(1500 * attempt)
      continue
    }
    lastErr = lastErr || new Error('模型无回应（空流）')
    if (attempt === 3) throw lastErr
    console.log(`  ⚠️ 空流重试 (attempt ${attempt}/3)`)
    await sleep(1500 * attempt)
  }
  throw lastErr
}

/**
 * L3 调试开关（2026-10-24）：`data\config\l3-debug` 存在 = 开（内容随便）。老名字 `l3-dump` 等价。
 *
 * 开了以后：
 *   ① 有**新命中**的那一轮存一份真实输入 → data\config\l3-dump.json（供 scripts/l3-ab.mjs 重放）；
 *   ② 走**命题递归**的那一轮写一份全过程 → data\runtime\l3-trace\<时间>.md（见 lib/l3-trace.js）。
 * 为什么要抓输入：线上先后问同一个问题做不到"同一个输入"——第二轮的历史里已经有第一轮的回答了。
 * 每轮现读，删文件即关，不用重启。
 */
function l3DebugWanted() {
  try {
    return fs.existsSync(L3_DEBUG_FILE) || fs.existsSync(L3_DUMP_FILE)
  } catch { return false }
}

/**
 * 存本轮输入（A/B 重放用）。只在该轮真的走 L3 时调用，由 l3DebugWanted 把关。
 * 永不抛：抓取失败绝不影响这一轮对话。
 */
function dumpL3Input(payload) {
  try {
    fs.writeFileSync(L3_DUMP_JSON, JSON.stringify({ ...payload, ts: Date.now() }, null, 1))
    console.log(`  [l3] 已存本轮输入 → ${L3_DUMP_JSON}（供 scripts/l3-ab.mjs 重放）`)
  } catch (e) {
    console.log(`  [l3] 抓取本轮输入失败（不影响本轮）：${e.message}`)
  }
}

/**
 * 用系统默认程序打开一个文件（这里只用它打开脑图 .html）。
 * 失败只打一行日志：看不了图不该影响回答。
 */
function openInBrowser(file) {
  try {
    if (process.platform === 'win32') {
      // `start` 是 cmd 的内置命令；第一个空参数是窗口标题占位（否则带空格的路径会被当标题）
      const child = spawn('cmd', ['/c', 'start', '', file], { stdio: 'ignore', detached: true, windowsHide: true })
      child.unref()
    } else {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore', detached: true })
      child.unref()
    }
  } catch (e) {
    console.log(`  [l3] 打开脑图失败（文件还在）：${e.message}`)
  }
}

// 产出最终完整回复的流式入口：边收边把累计文本写进 chat_output（~100ms 节流），
// 收尾写 -1 结束标记 + 最终完整记录。chat_output 的写入由本函数独占，
// 调用方不再各自 appendChatOutput，保证每条回复只产生一组流记录 + 一条最终记录。
async function say(userText, options = {}) {
  // AI-001：写入归属书/上下文的历史；元任务（记忆重写）由调用方显式传 _meta
  const key = options.bookKey || currentBookKey || '_common'
  const hist = histFor(key)
  // AI-017：hist/journal 只存调用方给的入库文本（storeText：用户原话，或"划线原文引用+提问/批注"），
  // 侧栏 enriched（[正在共读] 前缀+章节窗口）只在本次调用注入 callHist，防止书摘录当"用户的话"入库
  const storeText = options.storeText != null ? options.storeText : userText
  hist.push({ role: 'user', content: storeText, id: Number(options.replyTo) || undefined })
  // ↑ id 只是本机的截尾点位标记（该提问在库里的行号），发 API 前由 apiMessages 剥掉
  trimHistoryByBudget(key, hist)  // 2026-09 惰性截尾：追加式保缓存前缀，超预算才从最老切
  // 自由模式（任意自由对话 key）不写 journal：对话内容默认是临时的，不进
  // session_journal（从而不进记忆固化）；归档时勾选「保存记忆」才
  // 单独把这场对话喂给记忆合并（见 archiveFreeConversation）。
  if (key !== '_meta' && !isFreeKey(key)) journalAppend({ kind: 'msg', bookKey: key, role: 'user', content: storeText })  // 同步落盘，强杀也不丢
  let fullContent = ''
  let displayContent = ''  // 展示文本（历史遗留的 MEMORIZE 标记会被剥掉，见 stripMemorize）
  let started = false  // 是否已写过流式记录
  let replyRowId = 0   // 本轮回答落库的行 id：hist 的截尾点位要它（apiMessages 发出去前会剥掉）

  try {
    // 本次调用喂 enriched（userText）：历史（hist，原话 storeText）整体保留，
    // 画像独立成块插在历史与当轮消息之间（2026-10 缓存修复）：
    //   [S, u1, a1, ..., uN(storeText), persona, U_N]
    // 下一轮 = 上一轮 + [aN, uN+1(storeText), persona, U_N+1]——前缀（全部历史，
    // 含 uN）连续命中；不再用 slice(0,-1) 替换（那会让上一轮的 user 从请求里消失、
    // 且 persona+U_N 与下一轮历史的 uN(storeText) 分叉，每轮固定失配最近 2~3 轮，
    // 短会话/跨会话首轮命中率降到 50%~70%）。
    // persona 独立块：画像/相处规则/足迹变化只失配当轮 persona 块，不碰历史前缀。
    // 2026-09 防跑题（09-07 火星报段落教训）：persona 已带【背景档案】"非发言"标注；
    // 当轮输入前再加【本轮消息】锚定行，把"当前要回答什么"在语义上钉死——模型不得
    // 顺着旧主题代答、不得把档案/历史内容当成这轮的用户发言。_meta 记忆合并保持原状
    // （产物另有校验兜底，见 rewriteWithRetry）。
    const persona = personaBlock()
    // 2026-10-17：后半句原来写的是"若含引文+提问，先围绕引文本身回答"——那正是"重心放到引用上"
    // 的源头之一（用户反馈《国家与革命》#1312）。现在把顺序反过来：提问是题目，引文是材料。
    const anchored = key !== '_meta'
      ? '【本轮消息】（上面历史与【背景档案】都只是背景——本行以下是用户当前要你直接回应的内容：含引文时，引文只是材料，回答以提问为准）\n' + userText
      : userText
    // L3 图路径上下文（可选）：独立成一条消息插在锚定消息**之前**——生成点前最后读到
    // 的永远是 anchored（本轮问题/划线本身），而不是一大段旧讨论（2026-10 定调）。
    // 2026-10-24：装配交给 lib/l3-driver.js 分流（full / tasks / bare / off 四条路）。
    // **旧路径一行没删**：full 模式下产出的 messages 与改造前逐字节相同（回归测试钉着）。
    // 模式每轮现读 data\config\l3-mode，改文件就生效，不用重启。
    const l3Mode = readL3Mode()
    const l3Hits = Array.isArray(options.l3Hits) ? options.l3Hits : []
    const path = l3Path(l3Mode, l3Hits)
    if (l3Mode === 'both') console.log('  [l3] both 模式尚未实现，本轮按 full 处理（开关文件：data\\config\\l3-mode）')
    if (path === 'bare') console.log('  [l3] tasks：本轮没有新命中 → 不带 L3（栈里的旧引用不重跑课题，理由见 l3Path 注释）')
    // 调试（data\config\l3-debug 存在时开）：
    //   ① 本轮**有新命中**才存输入（供 scripts/l3-ab.mjs 重放）——否则随便一句追问就会把它
    //     覆盖掉，A/B 抓到的就成了"没有命中的那一轮"；
    //   ② 只在走命题递归时开全过程记录（一轮一份，不像 ① 会互相覆盖）。
    const debugOn = l3DebugWanted()
    let trace = null
    let tree = null
    if (debugOn) {
      if (l3Hits.length) {
        dumpL3Input({ conv: key, mode: l3Mode, path, hist, persona, anchored, l3: options.l3, hits: l3Hits })
      }
      if (path === 'tasks') {
        // 编号必须与流水线里的课题号一致（命中顺序 → K-1、K-2），否则记录里的 K-1 对不上
        const tracePoints = l3Hits
          .map((id) => graph.nodes.find((n) => n.id === id))
          .filter(Boolean)
          .map((n, i) => ({ kid: `K-${i + 1}`, point: n.point }))
        // 两份产物共用一个时间戳（脑图里那个"同名 .md"链接就是靠它指过去的）
        const st = localStamp()
        trace = openL3Trace({
          dir: L3_TRACE_DIR, stamp: st.file,
          meta: { ts: st.human, conv: key, mode: l3Mode, path, points: tracePoints, question: storeText },
        })
        tree = openL3Tree({ dir: L3_TRACE_DIR, stamp: st.file, meta: { conv: key, question: storeText } })
        if (trace.file) console.log(`  [l3] 全过程记录 → ${trace.file}`)
      } else {
        console.log(`  [l3] 调试已开，但本轮不是命题递归（path=${path}）——只存输入，不写全过程`)
      }
    }
    // kind/conv 只进用量流水：_meta 是"记忆合并"这类元任务（同一入口，但报表里要分开看，
    // 否则画像重写那几笔大输入会被算进"读书问答"里，看不出是哪一类在花钱）
    const usageKind = key === '_meta' ? '记忆固化' : '主回复'
    // 新路径的依赖（tasks / both 共用一份，保证两条路吃到的输入完全一样）
    const tasksDeps = {
      hist, persona, anchored,
      // 当前提问（用户这一轮真的问的那句）：整套课题都锚在它上面，不是节点里的旧问题
      question: storeText || userText,
      hits: l3Hits,
      // 图查询：节点在图上才派课题（命中 id 可能来自已删节点，这里再校验一次）
      nodeOf: (id) => graph.nodes.find((n) => n.id === id) || null,
      parentsOf: (id) => userParents(graph, id),
      // 每次调用都必须自己报预算——这里**不给默认值**。
      // 以前是 `o.maxTokens || 1024`：汇总那次没传，就静默拿到 1024，思考写掉 2,847 字、
      // 正文一个字没出来（实测 2026-10-26）。忘了传参数就该当场报错，不该变成一个更小的预算。
      complete: (o) => {
        if (!Number.isFinite(o.maxTokens) || o.maxTokens <= 0) {
          throw new Error(`流水线调用「${o.kind || '?'}」没给 maxTokens：预算必须由调用点自己定`)
        }
        return callLLM(o.maxTokens, o.messages, {
          ...(o.system !== undefined ? { system: o.system } : {}),
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
          // 这两个开关由流水线按"这是哪种调用"传进来：机械调用不思考、只要正文
          ...(o.contentOnly ? { contentOnly: true } : {}),
          ...(o.thinking === false ? { thinking: false } : {}),
          kind: o.kind, conv: key,
        })
      },
      stream: (o) => callLLMStreamWithRetry(options.maxTokens || 8192, o.messages, {
        // both 模式下 B 的终稿不是给用户看的那份，报表里分开放，才能算出"各花了多少"
        kind: path === 'both' ? '课题汇总' : usageKind, conv: key,
      }),
      // 兜底：R1 起不来（网络/截断/空流）就退回旧路径的整段注入——引用轮不能没有答案
      fallback: () => callLLMStreamWithRetry(options.maxTokens || 8192, assembleCallHist({
        hist, persona, l3: options.l3, anchored, mode: 'full',
      }), { kind: usageKind, conv: key }),
      judgeSystem: JUDGE_SYSTEM,
      checkStop: () => {
        // both 模式下停止信号只给 A 用：信号是"读到即删"（见 consumeSessionStop），
        // B 也来读的话会把 A 那份抢走——表现就是"点了停止，回答继续往下流"。
        if (path === 'both') return
        if (consumeSessionStop(key, options.replyToTs)) throw abortedError()
      },
      log: (m) => console.log(`  [l3] ${m}`),
      // 全过程事件（调试开关打开时才有人接收，关着就是空操作）：Markdown 与脑图各收一份
      onEvent: (e) => {
        if (trace) trace.write(e); if (tree) tree.write(e)
        // 这一轮「成功上报的来路节点」→ 记成下一轮可继承的清单（同栈继续时才会用到）
        if (e && e.type === 'live') writeLive(key, e.nodes)
      },
      // 拒绝交付 = 这条旧讨论的 point/alias 与实际内容不符（用户后面去修图谱）。
      // 单独落一个文件，攒够了一次性看哪些节点在吹牛。
      onRefusal: (rec) => {
        try {
          fs.appendFileSync(path.join(path.dirname(L3_TRACE_DIR), 'l3-refusals.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n')
        } catch {}
      },
      opts: {
        // both：B 的终稿不是用户看到的那份，记录里必须标清楚（否则两份终稿分不出谁是谁）
        ...(path === 'both' ? { finalLabel: 'B 新路径（这次没给用户看）', finalShown: false } : {}),
      },
    }
    const fullHist = () => assembleCallHist({ hist, persona, l3: options.l3, anchored, mode: 'full' })
    // both：两条同时跑。**给用户看的仍然是旧路径（A）**——debug 模式不该把阅读体验换掉；
    // 新路径（B）在后台跑，跑完并排画进脑图。用户要是觉得 B 更好，再 /l3 tasks 把它扶正。
    let altTask = null
    if (path === 'both') {
      altTask = (async () => {
        let text = ''
        for await (const piece of runTasksPipeline(tasksDeps)) if (piece && piece.accumulated) text = piece.accumulated
        return text
      })().catch((e) => {
        console.log(`  [l3] A/B：新路径失败（不影响这一轮回答）：${e.message}`)
        return ''
      })
    }
    const stream = path === 'tasks'
      ? runTasksPipeline(tasksDeps)
      : callLLMStreamWithRetry(options.maxTokens || 8192,
        path === 'full' || path === 'both' ? fullHist() : assembleCallHist({ hist, persona, l3: options.l3, anchored, mode: 'off' }),
        { kind: usageKind, conv: key })
    let lastWrite = 0
    let result
    while (true) {
      // 停止信号·第②道闸（2026-02）：每收一段就瞄一眼——这一眼是"别再多等一片"，
      // 不是"已经收下的那片要不要写"（那是等回来之后的第③道闸，见下面）。
      // 2026-11：带上本轮的身份证，只停发给我们这一轮的信号（见 consumeSessionStop）。
      if (consumeSessionStop(key, options.replyToTs)) throw abortedError()
      result = await stream.next()
      // 停止信号·第③道闸（2026-11）：**模型每返回一次，先看停止，再决定做什么**。
      // 位置放在 done 判断**之前**是有意的（最初放在下面"写之前"，被 break 绕过去了）：
      // 最后一圈拿到的是 `{done:true}`，走 break 直接出循环，放在写入口就等于"收尾那一圈
      // 永远不看停止"——那段等待恰恰可能很长（模型吐完最后一片到报"说完了"之间）。
      // ② 管"别再多等一片"，③ 管"已经等回来的这一下要不要用"，两者都在等待的两端。
      if (consumeSessionStop(key, options.replyToTs)) throw abortedError()
      if (result.done) {
        fullContent = result.value || fullContent
        break
      }
      const now = Date.now()
      const accumulated = (result.value && result.value.accumulated) || ''
      fullContent = accumulated
      // 节流：约 100ms 一条（content 是累计文本，中间跳过的写会在下一条覆盖）。
      // 流式时先剥历史遗留的 MEMORIZE 标记（新协议已不发它，只为老数据兜底）；_meta 不写库
      if (key !== '_meta' && (!started || now - lastWrite >= 100)) {
        appendChatOutputStream(stripMemorize(accumulated), key, options.replyToTs)
        started = true
        lastWrite = now
      }
    }

    // 调试：这一轮的命题递归已经跑完，脑图直接在浏览器里打开（只有 data\config\l3-debug 开着时才走到这里）
    // both 模式要等后台那条新路径跑完再开图，否则图上只有一半
    if (altTask) {
      const ALT_WAIT_MS = 120_000
      const alt = await Promise.race([altTask, sleep(ALT_WAIT_MS).then(() => '')])
      if (tree) tree.write({ type: 'final', label: 'A 旧路径（用户看到的就是这段）', text: displayContent, coverage: [], shown: true })
      console.log(`  [l3] A/B 同输入：旧路径 ${displayContent.length} 字｜新路径 ${alt ? `${alt.length} 字` : '没跑完（超时）'}｜两份都在 data\\runtime\\l3-trace\\`)
      if (!tree) console.log('  [l3] 注意：both 模式下没开调试（/l3 debug on），新路径那份没地方看——只在上面这行日志里')
    }
    if (tree && tree.file) openInBrowser(tree.file)

    // 为什么不在这里再查一次停止：③ 就在上面几行，中间只有 `break` 和一次赋值 —— 纯同步代码，
    // 用户不可能在这个窗口里点停止。
    // 原来这里有一道"落库前再看一眼"的闸，2026-11 把 ③ 挪到 done 判断之前以后它就永远
    // 触发不了（③ 之后到这个位置没有任何 await），所以删掉了：留着会让人以为"落库这段有保护"。
    // 曾经这里还有一条缝：会话中实时记忆的 `await runMemoryMerge(...)` 要跑几秒，期间点的停止
    // 抓不到。2026-10-18 删掉实时记忆之后，从这个位置到落库是纯同步的，那条缝一起没了。

    // 2026-10 移除"引用跑题自愈"（用户定调：流式已显示的内容不能被事后替换）：
    // 原机制在答完后用**无历史**的判定 LLM 复查"回复有没有碰引文"，判成跑题就用
    // **无历史、无画像**的加固 prompt 重答一次、覆盖已显示的气泡。实测两个结构性问题：
    //   ① 判定输入没有历史，分不出"接着说上一轮"和"跑到别的话题"，且结论靠"输出里
    //      第一个 是/否 字符"取（推理型模型把思考写进 content 时近乎掷硬币）→ 误判；
    //   ② 重答刻意剥离历史与画像（当初跑题根因是长上下文的旧主题磁吸），一旦误判，
    //      用户看到的就是"答案突然换成另一段、且只对着引文讲，像忘了刚才在聊什么"
    //      （2026-09-24 14:33《大国大城》实例：a 1350 字接着用户的话讲，35 秒后被
    //      874 字的"冷启动式"引文解释覆盖）。
    // 现在**答完即定稿**：流式显示什么、最终记录就是什么（除历史遗留标记的剥离）。
    // 防跑题回到事前：AGENT.md 的【本轮消息】规则 + say() 里的 persona/anchored 锚定块。

    // 收尾展示文本：剥掉历史遗留的 MEMORIZE 标记（新协议已不发它）
    displayContent = stripMemorize(fullContent)

    if (key !== '_meta') {
      // 2026-10-18 删除「会话中实时记忆」：模型不再发 MEMORIZE 标记，这里不再立即重写画像、
      // 不再追加"（CoRead 记住了你的话）"回执。画像只在两个时机更新——会话结束固化
      // （saveSessionMemory）与自由对话归档时勾选「保存记忆」。
      // 删的理由：① 实时合并要求模型输出整份画像、上限 400 字，实测会把程序填的
      // 「他长期关注的议题」整块挤掉（2026-10-18 15:32 实况：8 条议题消失，只剩 .bak）；
      // ② 那段 await 在流式结束之后，这几秒里点停止抓不到；③ 产品说明（README / 教程）
      // 本来就只承诺"每次共读结束合并重写一遍"，实时这条从来没写进对用户的话里。
      appendChatOutputStreamEnd(key, options.replyToTs)
      replyRowId = appendChatOutput('assistant', displayContent, key, { replyTo: options.replyTo })
    }
  } catch (e) {
    // 用户停止（2026-02 用户定调"当没问过"）：不写失败气泡、不加 ⚠️、不标作废入库，
    // 只把这一轮留下的痕迹收干净，然后返回中止标记让调用方跳过入栈那一步。
    // 与下面普通失败的区别：失败是"还欠用户一个答案"（入库 + 下轮重试），
    // 停止是"这一轮不存在"（什么都不留）。
    if (isAborted(e)) {
      // 这一步的 -1 也带身份证：侧栏据此知道"这条流属于已弃掉的那一轮"，收尾时不画气泡
      if (key !== '_meta' && started) appendChatOutputStreamEnd(key, options.replyToTs)
      hist.pop()                                                        // 半句话不进上下文
      if (key !== '_meta' && !isFreeKey(key)) voidJournalUserMsg(key, storeText)  // 用户原话不进画像
      console.log('  ⏹ 本轮已停止（回答丢弃、记忆作废、不入栈）')
      return ABORTED_REPLY
    }
    // 出错也要收尾：流已吐过一部分时补 -1 + 错误记录，避免侧栏气泡卡在思考动画。
    // 元任务（_meta）不写库，避免在侧栏产生记忆合并过程的伪气泡。
    // 失败回答以 status='failed' 入库：它不参与配对（pairReplies 跳过 ⚠️/failed），
    // 也不影响提问的重试状态（提问的 status 由 poller 决定）。
    if (key !== '_meta') {
      if (started) appendChatOutputStreamEnd(key, options.replyToTs)
      appendChatOutput('assistant', `⚠️ ${e.message}`, key, {
        status: 'failed', error: String(e.message).slice(0, 200), replyTo: options.replyTo,
      })
    }
    // 余额/鉴权类致命错误：登记给 poller → 中止本轮队列 + 暂停（否则队列里每条消息都会
    // 各写一个 ⚠️ 气泡，2026-09-28 一次刷了 213 个）
    if (isFatalConfigError(e)) _lastFatalError = e
    hist.pop()
    return `⚠️ ${e.message}`
  }

  hist.push({ role: 'assistant', content: stripCodeBlocks(displayContent), id: Number(replyRowId) || undefined })
  // 注意：历史里的 assistant 与 chat_output 落盘/启动恢复保持一致（都 stripCodeBlocks）——
  // 否则回复含代码块时，跨会话恢复的历史与在线历史从那条起失配，缓存前缀全部断裂（2026-10）
  if (key !== '_meta' && !isFreeKey(key)) journalAppend({ kind: 'msg', bookKey: key, role: 'assistant', content: displayContent, ...(options.assistantSelected ? { assistantSelected: options.assistantSelected } : {}) })
  return stripCodeBlocks(displayContent)
}

// ── 持久化 ───────────────────────────────────────────────────────────────────

// ── 会意系统 · 实时栈 + 收口固化（2026-08-28 用户定调）──────────────────────
// 聊天时：消息/回复实时喂栈（判专题化入口 + 判同一性切段，lib/topic-stack.js）；
// 引用解析命中 → L3 上下文 + 引用暂存（挂当前讨论）。
// **收口固化（唯一固化时机）**：新的专题化讨论到来，旧的全体弹栈（closed_and_pushed）
// → 当场对弹出的旧讨论：归纳问题 → 固化（节点）→ 段间无条件 derived 边 → user 边 → 写图。
// 关闭 / 启动恢复**不做**收口固化——只是保存/恢复进行中的讨论（栈跨会话持久化），
// 讨论没被新专题化弹栈就不收口。

// callLLM(maxTokens, hist, opts) 与模块约定的 callLLM(prompt, maxTokens) 参数顺序相反，包一层。
// 判定调用不带阅读助手 SYSTEM（避免人格与记忆指令干扰判定格式），用最小判定系统；
// temperature: 0 保证判定确定性（与冒烟脚本一致）。
const JUDGE_SYSTEM = '你只负责按用户的指令输出要求格式的结果，不附加任何解释。'
function judgeLLM(prompt, maxTokens) {
  return callLLM(maxTokens || 2048, [{ role: 'user', content: prompt }], { system: JUDGE_SYSTEM, temperature: 0 })
}

// 从聊天消息提取划线结构体 { text, book, chapter }（无划线返回 undefined）。供 selected / journal 记录复用。
function selectionFromMsg(msg) {
  return msg && msg.selectedText
    ? { text: msg.selectedText, book: msg.bookTitle || '', chapter: msg.chapter || '' }
    : undefined
}

// ── 会意图运行时态：图加载/保存 + 引用解析（L3 上下文） ──
let graph = createGraph()  // 会意图（§5.3）：启动时从 GRAPH_FILE 加载，收口固化时写回
//（2026-11 自由模式多对话：自由对话不再有独立沙盒图——收编进正式图与否由归档弹窗
//  决定，见 archiveFreeConversation；沙盒只服务引用解析的只读基线，已无写入方）

// 图文件"盘上签名"（mtime+size）：用来发现**别人改过图文件**。
// 为什么需要：agent 把整张图读进内存，只在自己收口时整份写回。任何人在这之间动过
// GRAPH_FILE（回填书名、手工修 point、清理脚本），下一次收口都会拿内存里的旧图把它
// 无声盖掉 —— 2026-11 一次书名回填就这样被覆盖，用户在图上看到"改了又变回灰色"。
// 写盘前发现签名变了 → 先把盘上已经存在的节点合回内存（见 lib/knowledge-graph.js 的
// mergeNodeMetadata：节点不可变，盘上那份只可能更新）。
let graphDiskSig = ''
function graphFileSig() {
  try { const s = fs.statSync(GRAPH_FILE); return s.mtimeMs + ':' + s.size } catch { return '' }
}

// 读图文件：主文件损坏/缺失 → 回退 .bak（写盘总是先备份，读取失败用备份闭环）。
// 返回 null = 文件不存在或结构不可用（调用方决定下一步）。
function readGraphFile(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return obj
    return null
  } catch {
    return null
  }
}

function loadGraph() {
  const main = readGraphFile(GRAPH_FILE)
  if (main) { graph = main; graphDiskSig = graphFileSig(); return }
  if (fs.existsSync(GRAPH_FILE + '.bak')) {
    const bak = readGraphFile(GRAPH_FILE + '.bak')
    if (bak) {
      console.log(`  ⚠️ ${path.basename(GRAPH_FILE)} 读取失败，已从 .bak 恢复（${bak.nodes.length} 节点 / ${bak.edges.length} 边）`)
      graph = bak
      graphDiskSig = graphFileSig()
      return
    }
  }
  // 回退：离线固化脚本产出的有效图（与 receiver /graph 的三级回退一致）——live
  // 收口固化尚未落盘时，引用解析也能命中真实知识点节点（2026-08-31 修复：此前
  // 正式图缺失 → 空图 → resolveCitations 空图短路，所有模式都永远没有命中事件）。
  // 首次收口固化会把该图连同新节点一起写回正式图文件（saveGraph 全量落盘）。
  const results = readResultsGraph()
  if (results) {
    graph = results
    console.log(`  ⚠️ 正式图缺失，已回退离线固化图（${results.nodes.length} 节点 / ${results.edges.length} 边，scripts/data/knowledge-graph-results.json）`)
    return
  }
  graph = createGraph()
}

// 离线固化产物图：scripts/data/knowledge-graph-results.json（{ graph: {nodes,edges} } 或顶层直接是图）
function readResultsGraph() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RESULTS_GRAPH_FILE, 'utf8'))
    const g = parsed && parsed.graph && typeof parsed.graph === 'object' ? parsed.graph : parsed
    if (!g || !Array.isArray(g.nodes)) return null
    return { nodes: g.nodes, edges: Array.isArray(g.edges) ? g.edges : [] }
  } catch {
    return null
  }
}

function saveGraph() {
  try {
    fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true })
    // 盘上的图被别人改过（回填书名 / 手工修正 / 清理脚本）→ 先合进来再写，
    // 否则内存里的旧图会把那次修正整份覆盖（2026-11 实际发生过）。
    const sig = graphFileSig()
    if (sig && graphDiskSig && sig !== graphDiskSig) {
      try {
        const disk = readGraphFile(GRAPH_FILE)
        const merged = disk ? mergeNodeMetadata(graph, disk.nodes) : 0
        if (merged) console.log(`  [会意图] 图文件被外部改过：已合入 ${merged} 个已存在节点（不覆盖外部修正）`)
        else if (!disk) console.log('  [会意图] ⚠️ 图文件被外部改过但读不出来：按内存里的图写回')
      } catch (e) {
        console.log(`  [会意图] 外部改动合入失败（按内存里的图写回）: ${e.message}`)
      }
    }
    if (fs.existsSync(GRAPH_FILE)) fs.copyFileSync(GRAPH_FILE, GRAPH_FILE + '.bak')  // 先备份，后读写（用户本地数据）
    fs.writeFileSync(GRAPH_FILE, JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2))
    graphDiskSig = graphFileSig()
  } catch (e) {
    console.log(`  ⚠️ 会意图写入失败: ${e.message}`)
  }
}

// 说明（2026-11 自由模式多对话）：自由对话**不再**产出沙盒图产物——收编与否由归档
// 弹窗决定，收编就直接写正式图（见 archiveFreeConversation）。receiver 的
// `/graph?free=1` 与 knowledge-graph.free.json 只作为旧产物的只读入口保留
//（历史文件可随时手删；文件不存在时该入口回退正式图）。

// 从收口组 entries（user/assistant 轮次）提取交锋轮次 {q, a}（lib/graph-consolidate.js 导出）


// 会话中引用解析：发言 → 命中节点 id[] + L3 块。图空 / 异常 → 空，不影响主回复。
// 命中只取上下文 + 暂存引用；**不建边**（建边在固化时，2026-08-27 定调命中与建边解耦）。
// 2026-11 输入口径修复：判定材料只留用户自己的话（note），**剥掉引文块**（[引用] 头 +
// > 划线原文）。引用解析判的是"用户是否在指认旧知识点"，而引文是正在读的书的内容——
// 把引文喂进语义匹配，会把"引文主题词撞上同源节点"判成"引用"，产生假阳性
// （实例：对《怎么办？》引文文风的元评论"这到底是翻译的问题，还是列宁说话就是这样啊"
// 因引文含"少数领导者/工人/政治警察"而命中 4 个同书同章节点；剥掉后无指认话术 → 0 命中）。
// 纯文本消息 parseMessage 原样回传（note = 全文），带 [引用] 块的消息只留块后的提问，
// 与判专题化 messageUnit 同口径。REPL/标注路径传入的已是用户原话，行为不变。
async function resolveCitations(userText, bookKey, replyToTs) {
  const note = parseMessage({ content: String(userText || '') }).note
  const text = String(note || '').trim()
  if (!text || !graph.nodes.length) return { hits: [], l3: '' }
  try {
    const nodeBriefs = graph.nodes.map((n) => ({
      id: n.id,
      point: n.point,
      aliases: n.aliases,
      questions: (n.discussions || []).map((d) => d.question),
    }))
    const { hits } = await resolveReferences({ message: text, nodes: nodeBriefs }, {
      callLLM: judgeLLM,
      maxTokens: 16384,
      log: (m) => console.log(`  [引用解析] ${m}`),
    })
    const valid = hits.filter((id) => graph.nodes.some((n) => n.id === id))
    if (valid.length) {
      // AI-020 命中事件：写 chat_output（role=graph-hit，不带 content/_stream——
      // 不渲染为消息、不参与回复配对），receiver 按既有通道转发为 SSE，侧栏图视图
      // 据此高亮命中节点的闭包。reason = 命中的知识点 point 列表；
      // bookKey = 本次讨论归属书，侧栏按当前上下文过滤（命中脉络按书隔离）。
      const reason = valid
        .map((id) => { const n = graph.nodes.find((x) => x.id === id); return n ? `「${n.point}」` : id })
        .join('、')
      appendGraphHit(valid, reason, bookKey, replyToTs)
    }
    // L3 种子 = 本轮命中 ∪ **本场实时栈已挂的全部引用**（2026-10 用户定调）。理由与前端图
    // 高亮同一条：实时栈收口**之前**它们同属一场讨论——固化时同一段消息的 cites 会一起变成
    // 同一个节点的 user 边，所以不是两类东西。于是「图上亮的」与「模型拿到的」严格一致
    // （前端 computeHitLayers 用同一组种子）。种子非空就注入：这场讨论有引用 → 每轮都带上它的来路。
    const seeds = [...new Set([...valid, ...collectStackCites(topicStacks[bookKey || currentBookKey])])]
    const ancestry = seeds.length ? userAncestry(graph, seeds) : []
    return { hits: valid, l3: ancestry.length ? l3Block(ancestry) : '' }
  } catch (e) {
    console.log(`  [引用解析] 本轮跳过（不影响主回复）: ${e.message}`)
    return { hits: [], l3: '' }
  }
}

// ── 会意讨论栈（实时，跨会话持久化）─────────────────────────────────────────
// topic_stack.json 存栈（按书隔离：{ bookKey: 栈 }，bookKey = baseBookId | '_common'）。
// 栈 = 进行中的专题化讨论：跨会话持久化（讨论没被新专题化弹栈就不收口，
// 关闭/启动恢复不做收口固化——只是保存/恢复栈）。
// 读栈文件：主文件损坏/缺失 → 回退 .bak（写盘总是先备份，读取失败用备份闭环）。
// 返回 null = 文件不存在或内容不可用（调用方决定下一步）。
function readStackFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const out = {}
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) out[k] = v
    return out
  } catch {
    return null
  }
}

function readTopicStacks() {
  const main = readStackFile(TOPIC_STACK_FILE)
  if (main) return main
  if (fs.existsSync(TOPIC_STACK_FILE + '.bak')) {
    const bak = readStackFile(TOPIC_STACK_FILE + '.bak')
    if (bak) {
      console.log(`  ⚠️ ${path.basename(TOPIC_STACK_FILE)} 读取失败，已从 .bak 恢复（${Object.keys(bak).length} 个书栈）`)
      return bak
    }
  }
  return {}
}

function saveTopicStacks(stacks) {
  try {
    if (fs.existsSync(TOPIC_STACK_FILE)) fs.copyFileSync(TOPIC_STACK_FILE, TOPIC_STACK_FILE + '.bak')  // 先备份，后读写（用户本地数据）
    fs.writeFileSync(TOPIC_STACK_FILE, JSON.stringify(stacks, null, 2))
  } catch (e) {
    console.log(`  ⚠️ 栈写入失败: ${e.message}`)
  }
}

// ── 自由对话中途弹栈的旧讨论（2026-11 修）────────────────────────────────────
// 实现搬到 lib/free-closed-stacks.js（纯 IO + 可注入路径 → 有单测）。这里只留说明：
// 读书模式弹栈 = 当场固化；自由模式的产物只在归档时生成，所以弹栈的旧讨论不能丢，
// 先按 key 攒起来，归档勾了"收口进拓扑图"时逐段收口，有几段就出几个节点。

// 从会话流水账恢复"上一轮 AI 回复"（按书隔离）：每本书各自最近一条 assistant 消息
// （以及它针对的划线，如果有）——判专题化降级判定的同书上下文。
function lastAssistantByBookFromJournal() {
  const out = {}
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8')
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e?.kind === 'msg' && e?.role === 'assistant' && String(e?.content || '').trim()
          && e?.bookKey && !(e.bookKey in out)) {
        out[e.bookKey] = {
          content: String(e.content),
          selected: e.assistantSelected && String(e.assistantSelected.text || '').trim() ? e.assistantSelected : undefined,
        }
      }
    }
  } catch {}
  return out
}

// 把聊天消息组装成栈模块协议：{ userNote, selected?, bookId?, bookTitle?, chapter?, assistantContext? }
function buildTopicUnit(msg, lastReply, lastReplySelected) {
  const unit = { userNote: msg.content }
  const sel = selectionFromMsg(msg)
  if (sel) unit.selected = sel
  // 这条消息当时在读哪本书：收口时节点靠它记"属于哪本书"（图上一个节点的颜色 = 那本书的颜色）。
  // 与 selected 分开记——划线只在带划线时有，**纯打字提问也要带书名**，否则那一收出来的
  // 节点在图上没有书，只能涂默认灰（2026-11 用户报"这本的节点怎么是灰的"）。
  // 自由对话（msg.bookId 是 free key）不记：自由对话的节点按设计恒为"无所属书籍"。
  if (msg.bookId && !isFreeKey(msg.bookId)) {
    unit.bookId = msg.bookId
    if (msg.bookTitle) unit.bookTitle = String(msg.bookTitle)
    if (msg.chapter) unit.chapter = String(msg.chapter)
  }
  if (lastReply) {
    unit.assistantContext = { content: lastReply }
    if (lastReplySelected) unit.assistantContext.selected = lastReplySelected
  }
  return unit
}

let topicStacks = {}  // 会意讨论栈运行时态（按书隔离）：{ bookKey: 栈 }；main 启动时 readTopicStacks() 加载
let lastReplyByBook = {}  // 每本书最近一轮 AI 回复 { bookKey: { content, selected? } }：判专题化降级判定的同书上下文

// 喂一条用户消息进**它所属书**的会意栈；AI 回复追加进栈；引用命中挂消息条目（随栈持久化）。
// **收口固化（唯一固化时机，2026-08-28 用户定调）**：新的专题化讨论到来、旧栈全体弹栈
// （closed_and_pushed）→ 当场**固化后分段**（lib/segment-stack.js：先判专题化、再判同一性，
// 把栈内发散的具体问题细切成多个不可分割组）→ 每段：归纳问题 → 固化（派生 point/能指
// → 新建节点，**节点不可变**——2026-08-29 用户定调：去聚合判同）→ user 边；
// **derived 边只存在于固化后的分段逻辑中**：同一栈内相邻段之间**无条件**建 derived 边
//（2026-10 用户定调：去掉段间衍生 LLM 判定——同栈弹出的相邻段是思维连续链的机械产物；
// 不替用户思考，user 边仍只来自用户显式引用），**不比对上一个收口专题讨论**。
// 关闭 / 启动恢复不做收口固化。任何异常都不影响主回复（try/catch 隔离）。
// 收口固化（实时收口 closed_and_pushed 与 /收口 手动收口共用，2026-09）：
// 对被弹出的讨论做固化后分段 → 每段归纳问题 → 固化节点 → user 边 → 段间 derived
// 边 → 冗余 user 边清理（上游命中被段间 derived 链覆盖则删，内容不变）→ 写图。
// 返回 { keptClosed, sameFailed }：0 节点产出且非 noTopicized（LLM 故障）时保留
// 被收口讨论，调用方压回栈顶下次重试；noTopicized（整栈无专题化）不保留。
// sameFailed = 分段判同一性失败次数（>0 表示这次分段是降级结果，调用方要写进回执）。
//
// 目标图由 opts 决定（2026-11 自由模式多对话）：
//   · 读书模式：（默认）正式图 graph —— 完整固化
//   · 自由对话归档 + 用户勾选「收口进拓扑图」：同样落**正式图**（isFree:false），并且
//     跑的是**同一套正常程序**（判专题化 → 判同一性分段 → 逐段归纳/派生/建边）——
//     产出是"分段那么多个"知识点节点，不是压成一个占位节点。
//   · 自由对话不勾选收口：零产物（连线都不建），对话内容随归档一并删除。
// 收口固化（实时收口 closed_and_pushed 与 /收口 手动收口共用，2026-09）：
async function consolidateClosed(closed, opts = {}) {
  const { isFree = false, targetGraph = graph, logTag = '', bookKey = '' } = opts
  // 自由对话的节点恒无书名（图上灰色）；读书模式必须有书名，取不到才空着。
  // 不给 bookKey（老调用方）时按读书模式处理，退回"只认划线"的老行为，不静默丢书名。
  const bookless = bookKey ? isFreeKey(bookKey) : false
  let keptClosed = null
  let sameFailed = 0   // 分段判同一性失败次数（isFree 分支恒 0；上报给调用方/归档回执）
      if (isFree) {
        // 自由对话且用户没勾"收口进拓扑图"：什么都不做。2026-11 用户定调——自由对话
        // 默认是临时的，只有归档时勾了才走正常收口程序；不勾就零产物。
        console.log(`  [会意栈]${logTag} 自由对话不收编：零产物（对话内容不落图）`)
      } else {
      // ① 固化后分段：先判专题化（识别知识点轮次；无内核轮次**不做过滤处理**，跟随并入
      //    当前组，2026-08-28 定调），再判同一性（细切发散的具体问题）
      const { segments, noTopicized, degraded, sameFailed: segFailed } = await segmentStack(closed.entries, {
        callLLM: judgeLLM,
        log: (m) => console.log(`  [会意栈]${logTag} ${m}`),
      })
      sameFailed = segFailed
      if (degraded) {
        // 判同一性失败 → 已按"切段"处理（见 lib/segment-stack.js 的 catch）。必须留痕：
        // 以前这种失败被静默兜成"并入"，结果是一场长对话收成一个节点、还没人知道。
        console.log(`  [会意栈]${logTag} ⚠️ 分段判定有 ${segFailed} 次失败（已按切段处理，结果可能偏细）`)
      }
      console.log(`  [会意栈] 收口弹出 ${closed.entries.length} 轮 → 分段 ${segments.length} 个不可分割组`)
      // ② 每段：归纳问题（分段之后）→ 固化（派生 point/能指 → 新建节点，节点不可变）→ user 边
      const segResults = []  // {nodeId, question, excerpts}
      for (const seg of segments) {
        let question = ''
        try {
          const qr = await consolidateThreadQuestion(seg.entries, {
            callLLM: judgeLLM, maxTokens: 384, attempts: 5, log: () => {},
          })
          question = qr.question
        } catch (e) {
          console.log(`  [会意栈] 一段问题归纳失败，弃组（宁漏勿误）: ${e.message}`)
        }
        if (!question) continue
        const { book, chapter } = segmentBook(seg.entries, { bookless })
        const discussion = {
          question,
          book,
          chapter,
          excerpts: groupExcerpts(seg.entries),
        }
        try {
          const cons = await consolidateDiscussion(targetGraph, discussion, {
            callLLM: judgeLLM,
            log: (m) => console.log(`  [会意栈] ${m}`),
          })
          // user 边：段内消息挂的引用（按触发回合归属 → 本段节点）
          if (seg.cites.length) {
            const n = addCitationEdges(targetGraph, seg.cites, cons.nodeId)
            if (n) console.log(`  [会意栈] user 边 ×${n} → ${cons.nodeId}`)
          }
          segResults.push({ nodeId: cons.nodeId, question, excerpts: groupExcerpts(seg.entries) })
          console.log(`  [会意栈] 段 → ${cons.nodeId}（新建: ${cons.point}）`)
        } catch (e) {
          console.log(`  [会意栈] 一段固化失败，弃组（宁漏勿误）: ${e.message}`)
        }
      }
      // ③ derived 边：同一栈内相邻段**无条件**建边（2026-10 用户定调：去掉段间衍生 LLM
      // 判定——同一栈收口弹出的相邻段处于同一条思维连续链，衍生是收口分段的机械结果；
      // 不替用户思考规定语义关系，user 边仍只来自用户显式引用。不比对上一个收口专题）
      for (let i = 1; i < segResults.length; i++) {
        const n = addDerivedEdge(targetGraph, segResults[i - 1].nodeId, segResults[i].nodeId)
        if (n) console.log(`  [会意栈] derived 边：${segResults[i - 1].nodeId} → ${segResults[i].nodeId}（同栈相邻段，无条件）`)
      // ④ 冗余 user 边清理（2026-09 用户定调）：段间 derived 边建完后，一段命中
      // 的脉络上游节点若已能沿 上游→…→前一段命中脉络→前一段(derived)→本段 到达
      // 本段，其内容（root→自身路径）已被本段上下文完整覆盖，对应 user 边冗余 →
      // 删除（例：脉络 a→c→b，A 命中 {a,b} 折叠成 b→A；B 命中 c 且 A→B 衍生成立
      // → c 沿 c→b→A→B 已到 B，c→B 与 b→A+A→B 效果相同，删 c→B）。
      try {
        const pruned = pruneRedundantCitationEdges(targetGraph, segResults.map((r) => r.nodeId))
        if (pruned) console.log(`  [会意栈] 冗余 user 边清理 ×${pruned}（内容已被段间 derived 链覆盖）`)
      } catch (e) {
        console.log(`  [会意栈] 冗余 user 边清理失败（不影响主回复）: ${e.message}`)
      }

      }
      // 收口固化整体失败（0 节点产出，如 LLM API 持续故障时各段归纳/派生全部失败）：
      // 被收口的讨论不能就此从栈里消失——它一旦弹掉就永不重试（原文只残留在
      // session_journal 流水账里，需人工恢复）。0 产出时把整场讨论压回栈顶，下次收口
      // 整体重试；讨论内容随栈跨会话持久化，期间不丢。部分成功（≥1 节点）维持
      // "失败段弃组"（宁漏勿误）。
      if (segResults.length === 0) {
        if (noTopicized) {
          // 2026-09：整栈无专题化轮次（如"引用命中消息"开的单条栈）——命中不替代
          // 专题化判断，不构成知识点：零产物且不保留重试（重试只会重复同样的判定）。
          // 讨论栈结束 → 其命中展示随之结束（实时栈命中生命周期，2026-09 定调）。
          console.log('  [会意栈] 收口 0 节点产出（整栈无专题化轮次，命中不替代专题化判断）：不保留重试')
        } else {
          keptClosed = closed.entries
          console.log(`  [会意栈] ⚠️ 收口固化 0 节点产出，被收口讨论保留回栈（${closed.entries.length} 轮，下次收口重试）`)
        }
      }
      // 正式图收口固化 → 写正式图文件（自由对话归档勾选"收编"时同样落正式图）
      saveGraph()
      }
  return { keptClosed, sameFailed }
}

// /收口：手动收口当前书（或指定书）的讨论栈（2026-09 用户定调——读完一本书时使用）。
// 与实时收口走同一固化链路；成功后清空该栈（栈结束 → 命中展示随之结束）。
async function forceConsolidate(bookKey) {
  const stack = topicStacks[bookKey] || []
  if (!stack.length) return { reply: '当前没有进行中的讨论可收口。' }
  // 自由对话（任意自由 key）：收编与否是**归档时的用户选择**，不走 /收口 ——
  // 否则会出现"没勾选收编却在对话中偷偷写图"的隐性固化。
  if (isFreeKey(bookKey)) return { reply: '自由对话请在「归档」时选择要不要收口进拓扑图（对话条右侧 ⤓ 归档）。' }
  const closed = { ts: Date.now(), entries: stack }
  try {
    const { keptClosed } = await consolidateClosed(closed, { isFree: false, targetGraph: graph, bookKey })
    if (keptClosed && keptClosed.length) {
      topicStacks[bookKey] = keptClosed
      saveTopicStacks(topicStacks)
      return { reply: '收口未完成（固化 0 节点产出），讨论已保留，稍后重试 /收口。' }
    }
    topicStacks[bookKey] = []
    saveTopicStacks(topicStacks)
    return { reply: '本书讨论已收口（' + closed.entries.length + ' 轮）。' }
  } catch (e) {
    console.log('  [会意栈] /收口 固化失败: ' + e.message)
    return { reply: '收口失败：' + e.message }
  }
}

/**
 * 判栈：**只判，不落盘**。
 *
 * 2026-10-26 用户定：这一步从"回答之后"提到"回答之前"——因为"这一问会不会弹栈"决定
 * 要不要继承上一轮的有效来路节点（见 lib/l3-live.js）。判完不写盘、不做收口固化，
 * 那些都留给 applyStackTurn（此时 reply 已经拿到）。
 */
async function judgeStackTurn(bookKey, unit, cites) {
  const stack = topicStacks[bookKey] || []
  const isFree = isFreeKey(bookKey)
  const freeTag = isFree ? '[自由模式]' : ''
  const logTag = freeTag || (bookKey ? `[${bookKey}]` : '')
  const citesList = Array.isArray(cites) ? cites : []
  try {
    let r = await processStackMessage(stack, unit, {
      callLLM: judgeLLM,
      maxTokens: 2048,
      log: (m) => console.log(`  [会意栈]${logTag} ${m}`),
    })
    // 引用命中（cites 非空）的消息直接入栈——引用是讨论线索，不随专题化判定丢弃
    if (r.action === 'ignored') {
      if (!citesList.length) return { action: 'ignored', stack: r.stack, closed: null, citesList, isFree, freeTag, logTag }
      if (r.stack.length === 0) {
        r = { action: 'pushed', stack: [makeStackEntry(unit)] }
        console.log('  [会意栈] 引用命中消息（非专题化）直接入栈开新栈（cites ×' + citesList.length + '）')
      } else {
        r = { action: 'closed_and_pushed', closed: { ts: Date.now(), entries: r.stack }, stack: [makeStackEntry(unit)] }
        console.log('  [会意栈] 引用命中消息（不同问题·非专题化）：旧栈弹栈收口 + 新消息开新栈（cites ×' + citesList.length + '）')
      }
    }
    return { action: r.action, stack: r.stack, closed: r.closed || null, citesList, isFree, freeTag, logTag }
  } catch (e) {
    console.log(`  [会意栈] 本轮跳过（不影响主回复）: ${e.message}`)
    return null
  }
}

/** 落盘：用判好的结果 + 本轮回复，写栈、必要时收口固化。 */
async function applyStackTurn(bookKey, unit, reply, decision) {
  if (!decision) return
  const { action, stack, closed, citesList, isFree, freeTag } = decision
  try {
    const lastUserIdx = stack.reduce((acc, e, i) => (e.role === 'user' ? i : acc), -1)
    const savedStack = stack.map((e, i) => (i === lastUserIdx && citesList.length ? { ...e, cites: citesList } : e))
    let keptClosed = null  // 收口固化 0 节点产出时保留被收口讨论（压回栈顶，下次收口重试）
    if (action === 'closed_and_pushed' && closed) {
      // 自由对话：弹栈旧讨论不**当场**固化（产物只在归档时生成），但也不能丢——暂存起来
      // 读书模式：弹栈即固化进正式图（行为不变）
      if (!isFree) {
        keptClosed = (await consolidateClosed(closed, { isFree: false, targetGraph: graph, bookKey })).keptClosed
      } else {
        const n = stashFreeClosedStack(bookKey, closed.entries)
        console.log(`  [会意栈]${freeTag} 旧讨论弹栈（${closed.entries.length} 轮）：暂存待归档收口（该对话已攒 ${n} 段）`)
      }
    }
    // 只有"同一段讨论继续"的轮次才配保留继承记忆：弹栈（那段讨论结束）或压根没入栈
    // （这一问不属于任何讨论）都清掉，免得几小时之后的一场新讨论继承到旧的来路。
    if (action !== 'pushed') clearLive(bookKey)
    topicStacks[bookKey] = [...(keptClosed || []), ...savedStack, { role: 'assistant', content: String(reply || '').trim(), ...(unit.selected ? { selected: unit.selected } : {}) }]
    saveTopicStacks(topicStacks)
  } catch (e) {
    console.log(`  [会意栈] 本轮跳过（不影响主回复）: ${e.message}`)
  }
}

/** 一次跑完（判 + 落盘）：给不需要提前拿决策的调用点用。 */
async function driveTopicStack(bookKey, unit, reply, cites) {
  const decision = await judgeStackTurn(bookKey, unit, cites)
  await applyStackTurn(bookKey, unit, reply, decision)
}
// ── 自由对话归档（2026-11 用户定调）──────────────────────────────────────────
// 侧栏归档弹窗两项**默认都勾上**（可取消，取消的选择会被记住），随归档请求一并送到：
//   · 保存记忆 memory：把这场对话（histories[key] 的完整轮次）交给 profile 合并
//     ——走的就是 saveSessionMemory 的同一套 specs/校验/备份闭环，只是材料换成这场
//     自由对话（自由对话不进 session_journal，所以不能复用 journal 那条路）。
//   · 收口进拓扑图 graph：这场讨论跑**读书模式那套一模一样的正常程序**——判专题化 →
//     判同一性分段 → 逐段归纳问题 → 派生 point/能指 → 新建节点 → 引用边 → 段间
//     derived 边 → 冗余 user 边清理，写**正式图**（knowledge-graph.json）。
//     产出是"分段那么多个"知识点节点，**不是压成一个占位节点**（那是 2026-09 测试沙盒
//     的旧实现，已废弃；UI 文案也已按真实逻辑改写）。
// 归档即删除：无论勾没勾，归档完成后清空该对话的讨论栈、LLM 历史、会话历史与
// 聊天库里属于它的消息；注册表只留一条墓碑记录（产物去向说明）。
async function archiveFreeConversation(key, opts = {}) {
  const wantMemory = !!(opts && opts.memory)
  const wantGraph = !!(opts && opts.graph)
  const lines = []     // 本次归档真正做过/跳过的事（进系统气泡与墓碑记录）
  const skipped = []   // 用户没勾的项（墓碑里也要写清楚"没做什么"）
  let memoryOk = false
  let nodeCount = 0
  let edgeCount = 0
  let newPoints = []   // 本次收口新建节点的 point（让用户看见"收出了什么"，而不只是一个数字）

  // ① 记忆：这场对话的全部轮次
  if (wantMemory) {
    const hist = (histories.get(key) || []).filter((m) => String(m.content || '').trim())
    if (hist.length >= 2) {
      try {
        const ok = await saveMemoryFromTranscript(
          hist.map((m) => ({ role: m.role, bookKey: key, content: m.content })),
          { label: '这场自由对话' },
        )
        memoryOk = ok
        lines.push(ok ? '已保存记忆（背景画像）' : '记忆合并未通过校验，已保留原文件')
      } catch (e) {
        lines.push('记忆保存失败：' + e.message)
      }
    } else {
      lines.push('对话太短，未保存记忆')
    }
  } else {
    skipped.push('未保存记忆')
  }

  // ② 拓扑图：这场讨论收口 → **读书模式那套一模一样的正常程序**（判专题化 → 判同一性
  //    分段 → 逐段归纳问题 → 派生 point/能指 → 新建节点 → user 边 → 段间无条件 derived
  //    边 → 冗余 user 边清理），写正式图。这里不做任何"压成一个占位节点"的简化——
  //    自由对话的收口产物与读书模式收口出来的东西同构，用户看到的节点数就是分段的段数。
  //
  //    2026-11 修（"把自由会话收口成一个节点是错误的"）：要收的**不只是留在栈里的最后一段**。
  //    对话过程中被判"换了问题"而弹栈的旧讨论原本被就地丢掉（只打一行日志），于是长对话
  //    里前半段永远进不了图、用户只看到最后一段收出来的节点。现在那些弹栈讨论攒在
  //    free-closed-stacks.json 里，这里按时间顺序逐段收口，最后再收当前栈——有几段就出几个
  //    节点（每段内部仍按分段判定细切，段与段之间不建 derived 边：它们本来就是被判定为
  //    不同问题的两场讨论）。
  const stack = topicStacks[key] || []
  const stashed = closedStacksOf(key)
  const workStacks = [...stashed.map((s) => s.entries), ...(stack.length ? [stack] : [])]
  const nodesBefore = graph.nodes.length
  const edgeKeysBefore = new Set(graph.edges.map((e) => `${e.from}|${e.to}|${e.kind || 'user'}`))
  if (wantGraph) {
    if (!workStacks.length) {
      lines.push('无讨论内容可收口（对话太短：栈内没有轮到归纳）')
    } else {
      try {
        let kept = 0
        let segFailedTotal = 0
        for (const entries of workStacks) {
          const { keptClosed, sameFailed } = await consolidateClosed(
            { ts: Date.now(), entries },
            { isFree: false, targetGraph: graph, logTag: '[自由·归档]', bookKey: key },
          )
          if (keptClosed && keptClosed.length) kept++
          segFailedTotal += sameFailed || 0
        }
        if (stashed.length) console.log(`  [自由模式] 归档含中途弹栈旧讨论 ${stashed.length} 段（已一并收口）`)
        if (kept) {
          lines.push(`收口未完成（${kept} 段固化 0 节点产出）—— 对话内容仍会随归档删除`)
        }
        const newNodes = graph.nodes.slice(nodesBefore)
        nodeCount = newNodes.length
        newPoints = newNodes.map((n) => String(n.point || '')).filter(Boolean)
        // 边没有 id，按 from|to|kind 记差集（同 pair 去重边不会重复计入）
        edgeCount = graph.edges.filter((e) => !edgeKeysBefore.has(`${e.from}|${e.to}|${e.kind || 'user'}`)).length
        if (!kept) {
          lines.push(nodeCount
            ? `已收口进拓扑图（${nodeCount} 个知识点节点 / ${edgeCount} 条边）`
            : '已收口进拓扑图（整场无专题化轮次，未产出知识点节点）')
        }
        // 降级要说出来（2026-11）：分段判定失败被按"切段"处理，产出可能偏细——
        // 以前这种情况完全静默，用户只能看到"1 个节点"这个结果，无从判断对不对。
        if (segFailedTotal) lines.push(`注意：分段判定有 ${segFailedTotal} 次失败，已按切分处理（节点可能偏细）`)
      } catch (e) {
        lines.push('收口失败：' + e.message)
      }
    }
  } else {
    skipped.push('未收口进拓扑图')
  }

  // ③ 清理 + 墓碑：归档即删除（含中途弹栈的暂存——已收口的清掉；没收口的也随之作废，
  //    因为它们属于这场即将被删掉的对话）
  topicStacks[key] = []
  saveTopicStacks(topicStacks)
  if (dropFreeClosedStacks(key)) console.log(`  [自由模式] 归档清掉中途弹栈暂存 ${key}`)
  histories.delete(key)
  lastReplyByBook && delete lastReplyByBook[key]
  if (histCutCursors && key in histCutCursors) { delete histCutCursors[key]; saveHistCursors() }
  // 删这场对话在聊天库里的消息与事件（事务删除；旧实现是整文件重写两遍 jsonl）
  const del = (() => {
    try { const r = chatStore().deleteConversation(key); return { input: r.messages, output: r.events } } catch (e) {
      console.log(`  ⚠️ 归档清理失败：${e.message}`)
      return { input: 0, output: 0 }
    }
  })()
  const note = lines.join('；') || '已归档'
  archiveConversation(SESSIONS_DIR, key, { archive: { memory: memoryOk, graph: wantGraph && nodeCount > 0 }, note, now: Date.now() })

  const head = `对话已归档并删除${skipped.length ? '（' + skipped.join('、') + '）' : ''}。`
  // 把收口产出的知识点列出来（最多 5 条）：用户要看的是"收成了什么"，
  // 一个节点数说明不了问题——读书模式收口出来的是分段的多个节点，这里同构。
  const pointLine = newPoints.length
    ? `\n收口出的知识点：\n` + newPoints.slice(0, 5).map((p) => '· ' + p).join('\n') +
      (newPoints.length > 5 ? `\n· …等 ${newPoints.length} 个` : '')
    : ''
  console.log(`  [自由模式] 归档 ${key}：${lines.join('；') || '零产物'}（清理消息 input×${del.input} output×${del.output}）`)
  return { reply: head + (lines.length ? lines.join('；') + '。' : '') + pointLine }
}

// ── 长期记忆（画像）的语义定义 ───────────────────────────────────────────────
// 只在**会话结束固化**（saveSessionMemory）与自由对话归档勾选「保存记忆」时使用。
// 会话中的实时记忆（模型发 【MEMORIZE:profile】→ 立即重写画像 + 回一句"记住了你的话"）
// 已于 2026-10-18 整条删除，理由见 say() 里落库那段的注释。

// 这张表（AI-013）：合并时把"这个文件是什么、能写什么"喂给 LLM。
// 2026-10 起这张表**只剩 profile**（背景画像）：soul 已换角色为「相处规则」，
// 唯一写入者是用户的 /相处 命令（见 lib/agreement.js），AI 不再有任何写它的路径。
// 历史故障备忘：soul.md 曾被用户画像整段覆盖——根因是会话结束固化把同一份讨论材料
// 分喂两个 prompt、视角只差一句，必然串味；2026-10-14 那次整份成了 portrait.md 的副本。
const MEMORY_SPECS = {
  profile: {
    file: 'profile.md',
    filePath: PROFILE_FILE,          // 实际落点：data\profile\portrait.md（文件名与提示词里的名字分开，见 lib/paths.js）
    maxChars: 400,
    // 用途式定位（2026-10 用户定调）：**不罗列"应该装什么"**——罗列式会让模型凑内容。
    // 实测代价：旧 purpose 写着"品味、关注主题、思维习惯、知识背景"，长出来的却是 500 字政治立场，
    // 而"品味"一个字都没产出过。画像只负责一件事：让 AI 每轮知道它在跟谁说话。
    purpose: '让 AI 知道它在跟谁说话：这个人的背景与处境、正在做的事、怎么看问题、哪些东西他熟哪些不熟（用来定回复详略）、大致关心哪些生活面、以及他反复回到哪些议题（议题那一块由程序从会意图直接填，不归你写）。只写能确认的；没有就少写或留空——不要求填满',
    // 边界（2026-10 用户定调）：
    // ① 材料只取"关于他自己"的：他的处境、他周围发生的事、他说自己怎么想。
    // ② 问题域可写、结论不写：可以写他关心什么问题，不写他对这个问题下的结论
    //    （结论在会意图里，有原文，用户引用时会自动带进上下文）。
    // ③ 关心面用日常词，不用学科术语（"钱和产业往哪走""工人过得怎么样"，而不是
    //    "国家与阶级的关系"）——多数用户不读理论书，学科语言对他们不成立。
    // ④「他是谁」不点书名、不点话题（2026-10 用户指出：那一节塞进了一堆具体话题）。
    // ⑤「他的知识结构」是**详略地图**，不是书目清单：以用户**自述**为主，不因他讨论得多就推断他熟。
    // ⑥ **两块别混**（2026-10 用户点破的关键区分）：「他大致关心什么」= 宽泛的生活面向，**只看用户
    //    在对话里提了什么问**来判断；「他长期关注的议题」= 具体议题，由程序从会意图直接填。
    //    之前把 point 当材料去生成"关心什么"，方向就错了——一块从提问读，一块从图里取，互不生成。
    scope: '分三块写（第四块「他长期关注的议题」由程序直接填，你不要写、不要碰）：' +
      '「他是谁」（身份、处境、经历、正在做的事、怎么看问题）、' +
      '「他的知识结构」（三档：直接说 / 拆开讲 / 半熟在补，外加一个**默认档**"其余一切按他能跟上"——AI 据此定回复详略）、' +
      '「他大致关心什么」（注意力投向哪些生活面，1~3 个方向，日常语言）。' +
      '「他是谁」里不点具体书名、不点具体话题：要提知识只用一句概括（"理论底子厚""历史知识有缺口"）；拿掉专有名词（列宁、辩证法、拉美史）后那句话还成立，才算写对。' +
      '「他大致关心什么」**只看用户在对话里提了什么问、问的是哪一类事**来判断（他问钱、问制度、问工人的处境，就说明注意力在那一面）；不要拿他读了什么书、讨论了什么学问当依据。' +
      '判断"知识结构"以他的**自述**为主（"我不懂金融""我对教育社会学比较熟"）；不要因为他讨论得多就推断他熟。' +
      '材料只取用户消息里关于他自己的内容；AI 回复中对用户的转述、推断、脑补一律不得当作事实；细节若查无实据就不要写。' +
      '用日常词，不用学科术语。',
  },
}
const MEMORY_SPEC_LIST = Object.keys(MEMORY_SPECS).map(type => ({ type, ...MEMORY_SPECS[type] }))

// 历史遗留兜底：老版本协议会让模型在回复末尾写 【MEMORIZE:profile|soul】标记。
// 新协议已不发它（2026-10-18 删除实时记忆），但老数据（备份恢复、旧流水账）里可能还带着，
// 所以显示/入库前照旧剥掉——用户不该看见标记本身。
function stripMemorize(text) {
  return String(text || '').replace(/【MEMORIZE:(?:profile|soul)】[\s\S]*$/, '').trim()
}

// ── 会话流水账（session_journal.jsonl） ────────────────────────────────────
// 每条对话同步落盘（fs.appendFileSync 为同步写，硬杀/断电也不丢）。
// checkpoint 标记"此处之前的对话已合并进 profile"，之后的即"未合并"。
function journalAppend(entry) {
  try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ t: Date.now(), ...entry }) + '\n') } catch {}
}

function readJournalLines() {
  const raw = readIfExists(JOURNAL_FILE)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

/**
 * 把某场对话里"用户说了什么"的流水行标成作废（2026-02 用户停止一轮时调用）。
 *
 * 为什么需要：journal 那行是**用户按下发送的瞬间就同步落盘**的（防强杀丢话），
 * 中止时必须把它作废，否则用户的原话照样会被会话结束时的记忆固化写进 profile。
 *
 * 为什么就地改写而不删行：流水账保持"只追加、可整文件重写（checkpoint 就是这么干的）"
 * 这个性质更好核对；作废行留着也便于事后排查"这轮为什么没进记忆"。
 * 只改**最新**那条匹配行：中止的那轮总是最近一轮。
 *
 * @returns {boolean} 是否标上了
 */
function voidJournalUserMsg(bookKey, content) {
  try {
    const raw = readIfExists(JOURNAL_FILE)
    if (!raw) return false
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (!o || o.kind !== 'msg' || o.role !== 'user') continue
      if (String(o.bookKey || '') !== String(bookKey || '')) continue
      if (String(o.content || '') !== String(content || '')) continue
      if (o.voided) return true          // 已经是作废态
      o.voided = true
      o.voidedAt = Date.now()
      lines[i] = JSON.stringify(o)
      fs.writeFileSync(JOURNAL_FILE, lines.join('\n'))
      return true
    }
  } catch (e) {
    console.log(`  ⚠️ 流水账作废标记失败（不影响主流程）: ${e.message}`)
  }
  return false
}

// 上一次 checkpoint 之后的全部对话消息（尚未固化进 profile 的部分）。
// **跳过作废行**：被用户停止的那一轮不该进画像（2026-02 用户定调）。
function unmergedJournalMsgs() {
  const lines = readJournalLines()
  let lastCp = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].kind === 'checkpoint') lastCp = i
  return lines.slice(lastCp + 1).filter(l => l.kind === 'msg' && !l.voided)
}

// 把对话记录压成可喂给 LLM 的文本：区分说话人（用户/AI），不截断——
// 记忆固化要基于全量对话（AI-017）。书摘录已不入库（见 say()），这里只含用户原话与 AI 回复。
function transcriptText(msgs) {
  return msgs.map(m => {
    const who = m.role === 'assistant' ? 'AI' : '用户'
    return `──── ${who}（${m.bookKey || 'common'}）────\n${m.content}`
  }).join('\n\n')
}

// 合并成功后打 checkpoint，并顺带把 journal 轮转成一行（旧对话已蒸馏进 profile，可弃）
function journalCheckpoint() {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify({ t: Date.now(), kind: 'checkpoint' }) + '\n')
  } catch {}
}

// 会话结束 / 启动恢复时，把"尚未固化"的对话合并重写进 profile。
// 对话来源是 session_journal.jsonl（比内存 history 更稳：强杀后启动也能恢复，
// 也顺带修复了 AI-001 把记忆重写隔离进空 _meta 历史、导致模型看不到本次讨论的问题）。
async function saveSessionMemory({ minMsgs = 2 } = {}) {
  const msgs = unmergedJournalMsgs()
  if (msgs.length < minMsgs) {
    console.log(`（待固化对话 ${msgs.length} 条 < ${minMsgs}，跳过记忆合并）`)
    return
  }
  console.log(`\n正在固化本次会话记忆（${msgs.length} 条对话）...`)
  // 记忆合并本体抽成 saveMemoryFromTranscript：自由对话归档（勾选「保存记忆」）走
  // 的是同一套 specs / 校验 / 备份闭环，只是材料换成那一场自由对话的轮次
  //（自由对话不进 session_journal，不能复用 journal 那条入口）。
  const anyWritten = await saveMemoryFromTranscript(msgs, { label: '本次会话' })
  // 至少一个文件成功合并才打 checkpoint；全失败则保留未合并记录，下次启动再试
  if (anyWritten) {
    journalCheckpoint()
  } else {
    console.log('  ⚠️ 本次未写入任何记忆，未合并对话将保留，下次启动时重试')
  }
}

/** 剥掉模型可能自己写的「他长期关注的议题」那一节——它不归模型写（见 renderTopicsSection） */
function stripTopicsSection(text) {
  return String(text || '').replace(/\n*##\s*他长期关注的议题[\s\S]*$/, '').trimEnd()
}

/**
 * 「他长期关注的议题」：**程序直接从会意图填，不经模型**（2026-10 用户定调）。
 *
 * 它跟「他大致关心什么」是**两块**，别混：那一块是宽泛的生活面向、只看用户提了什么问；
 * 这一块是具体议题，直接取会意图热点节点（hotNodes 三层：超级招 → 统招 → 普招）的 point 原文。
 * 图空 / 还没有被引用过的节点 → 写一行"暂无"，让用户知道这一块存在，而不是悄悄没有。
 */
function renderTopicsSection(graph) {
  let list = []
  try {
    const hot = hotNodes(graph)
    list = [...hot.super, ...hot.qualified, ...hot.general]
    // 达线却没拿到统招名额 → 留一行痕。将来翻日志看到它，就知道门槛该往上调了，
    // 而不是一直以为写进画像的议题是完整的。
    if (hot.overflow > 0) {
      console.log(`  · 热点：达线 ${hot.qualified.length + hot.overflow} 个，统招只取了前 ${hot.qualified.length} 个（门槛该往上调了？）`)
    }
  } catch (e) {
    console.log(`  ⚠️ 热点计算失败，本次不填议题块：${e.message}`)
    return ''
  }
  if (!list.length) return '## 他长期关注的议题\n（暂无——还没有被反复引用的议题）'
  return '## 他长期关注的议题\n' + list.map((h) => `- ${h.point}`).join('\n')
}

// 记忆合并本体：把 msgs（[{ role:'user'|'assistant', bookKey?, content }]）压成记录文本，
// 逐个人格文件（目前只有 profile）提炼 + 合并重写。返回是否有文件被成功写入。
// 注意：本函数**不打 journal checkpoint**——checkpoint 只对 session_journal 有意义
//（调用方 saveSessionMemory 负责）；自由对话归档借用本函数时不碰流水账游标。
async function saveMemoryFromTranscript(msgs, { label = '本次讨论' } = {}) {
  const transcript = transcriptText(msgs)

  const specs = MEMORY_SPEC_LIST
  let anyWritten = false

  for (const { type, file, maxChars, purpose, scope, filePath } of specs) {
    const oldContent = readIfExists(filePath)

    // 备份旧文件（上一份 .bak 会被覆盖，只留最近一份供人工恢复）
    if (oldContent) {
      try { fs.copyFileSync(filePath, filePath + '.bak') } catch {}
    }

    const prompt = `${label}已结束。以下是讨论的记录（每条前面已标注来自"用户"还是"AI"）：\n\n${transcript}\n\n` +
      `请从上面的讨论中提炼出属于 ${file}（${purpose}）的新内容，与以下原内容合并，` +
      `输出完整的重写版本（删去被覆盖的旧条目，保持精简）。\n\n` +
      `要求：${scope}。\n\n` +
      `重要：① 只能把【用户】消息里**关于他自己**的内容记为画像（他的处境、他周围发生的事、他说自己怎么想）；【AI】消息中对用户的转述、推断、脑补（尤其是跑题回复）一律不是用户事实。② 若原内容里混着"他对某个问题的结论或立场"，这次一并清出画像、不要保留——那属于会意图，不属于画像。\n\n` +
      `只输出合并后的完整 ${file} 内容（≤${maxChars}字），不要输出任何其他文字、标记或说明。\n` +
      `本次讨论若没有属于 ${file} 的新内容，则原样输出原内容。\n\n原内容：\n${oldContent || '（尚无记录）'}`

    let content = await rewriteWithRetry(type, prompt, maxChars)
    if (content) {
      // 「他长期关注的议题」由**程序直接从会意图填**（2026-10 用户定调）：那是具体议题，
      // 跟「他大致关心什么」那块宽泛方向是**两块**——一块从用户的提问读、一块从图里取，
      // 互不生成。所以模型只写前三块，这一块在这里拼上去；它若自己写了一个，剥掉、用程序填的。
      const body = type === 'profile'
        ? stripTopicsSection(content) + '\n\n' + renderTopicsSection(graph)
        : content
      fs.writeFileSync(filePath, body.trimEnd() + '\n')
      anyWritten = true
      console.log(`  ✓ ${file} 已合并重写`)
    } else {
      console.log(`  ⚠️ ${file} 重试后仍未通过校验，保留旧文件`)
    }
  }
  return anyWritten
}

// 强杀/断电兜底：启动时若发现上次会话有未固化的对话，自动恢复合并
async function recoverUnmergedMemory() {
  const msgs = unmergedJournalMsgs()
  if (msgs.length < 4) return
  console.log(`📦 检测到上次会话有 ${msgs.length} 条未合并的对话，正在恢复记忆（请稍候）...`)
  await saveSessionMemory({ minMsgs: 4 })
  console.log('✅ 记忆恢复完成。\n')
}

// AI-012：推理型模型偶尔把思考草稿当成最终输出返回（明显长于目标上限，或复述了任务指令）。
// 此类内容绝不能写进 profile（会覆盖长期记忆），判为"垃圾输出"并触发重试。
function isMergeOutputGarbage(text, maxChars) {
  const t = String(text || '')
  if (t.replace(/\s/g, '').length > maxChars * 3) return true  // 远超目标上限 → 是思考草稿而非精简产物
  if (t.includes('原内容：') || t.includes('注意字数限制') || t.includes('maxChars')) return true  // 复述了任务指令
  return false
}

async function rewriteWithRetry(type, prompt, maxChars) {
  const MIN_LEN = 30  // 去空白后最少 30 字
  const META = '_meta'  // AI-001：记忆重写是元任务，用独立历史，不污染任何书的上下文

  for (let attempt = 0; attempt < 2; attempt++) {
    // AI-012：maxTokens 从 1200 提到 4096——推理型模型先思考再输出，1200 常被思考耗尽、
    // 最终产物还没写完就被截断（截断的思考草稿正是 soul.md 被写乱的原因）。
    const resp = await say(prompt, { maxTokens: 4096, bookKey: META })
    // say() 成功时把 {role:'user'} + {role:'assistant'} 推入了 META 历史；
    // say() 失败时返回 "⚠️ ..." 且已自行 pop 掉它 push 的 user 消息（净变化 0）。
    // 下面是 LLM 对单任务的回复，整段即是目标内容，无需正则切割。

    const content = resp.trim()
    // LLM 调用失败：错误串绝不能写进 profile（会覆盖长期记忆），只重试不写入
    if (/^⚠️/.test(content)) {
      console.log(`  ⚠️ ${type} 第 ${attempt + 1} 次 LLM 调用失败（${content.slice(0, 40)}），重试...`)
      continue  // META 历史已被 say() 平衡，无需清理
    }

    const stripped = content.replace(/\s/g, '')
    if (stripped.length >= MIN_LEN && !isMergeOutputGarbage(content, maxChars)) return content

    // 校验失败（太短 / 思考草稿）：从 META 历史里摘掉这次的 user+assistant 再重试。
    // 只有 say() 成功时 META 历史才多了这两条；失败路径已在 say() 内平衡，不能 pop，
    // 否则会删掉上一轮真实对话。
    const reason = stripped.length < MIN_LEN
      ? `去空白仅 ${stripped.length} 字，太短`
      : '输出像思考草稿（字数远超上限或复述了任务指令）'
    console.log(`  ⚠️ ${type} 第 ${attempt + 1} 次校验未通过（${reason}），重试...`)
    const metaHist = histFor(META)
    metaHist.pop()  // 移除这次的 assistant 回复
    metaHist.pop()  // 移除这次的 user 消息
    prompt = `上一次的输出未通过校验（${reason}）。请重新输出合并后的完整内容（≤${maxChars}字）：直接给最终结果，不要任何推理过程、字数计算或说明。`
  }

  return null
}

// ── 书藉上下文组装（公共） ───────────────────────────────────────────────────
// 只给"引用处前后各 300 字"（chapterWindow）；没有章节正文（PDF）时用随引用报上来的
// 划线附近原文兜底。2026-10-17：原先这里还会拼 [本章已读进度概览] + 1500 字前文窗口，
// 那套为"AI 主动讨论划线"准备的上下文已随该功能停用整条删除（原因见 normalizeText 上方的注释）。
function assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText) {
  let ctx = ''
  const win = chapterWindow(bookId, chapterUid, selectedText, chapter, bookTitle)
  if (win) {
    ctx += `\n${win}\n`
  } else {
    // 没有章节正文（PDF 阅读器那条路）→ 用**随引用一起报上来的**划线附近原文
    // （阅读器算的前后各 300 字，见 extension/reader.js 的 contextAround）。
    // 认不到才说"暂无足迹"——这句话本身没错，只是以前把 PDF 也算进去了。
    const near = annotationContextFor(bookId, selectedText, { normalizeBookId: baseBookId })
    if (near) {
      ctx += `\n[划线附近的原文]\n${near}\n`
    } else {
      ctx += `\n（暂无这本书的原文足迹。如果作者在后文对这个问题有新的回应，我们到时再一起讨论。）\n`
    }
  }
  return ctx
}

// ── 标注讨论 prompt（2026-10-17 删除）────────────────────────────────────────
// buildAnnotationPrompt 只为"划线即讨论"拼 【新划线】…请按行为规则开始讨论这条划线。
// 那条路已停用（见上方"标注队列"处的说明），保留它只会让后来的人以为它还在跑。

// 为带书籍元数据的聊天消息补全上下文（章节窗口、摘要）
// 来自共读弹窗的消息已包含引文，这里只补全书级的上下文信息
// （2026-09：L1 本章标注讨论已删——61 轮历史窗口覆盖本章讨论，L1 与历史重复，
//   独特价值仅"未讨论标注的弱提示"，宁缺毋滥）
//
// 2026-10-17 重心修复（用户反馈"带引用的提问，AI 把重心放到引用上"）：
// 旧拼法 = [正在共读] + 1500 字前文窗口 + 628 字引用处窗口 + 引文 + 提问。
// 《国家与革命》#1312 实测：整条 2270 字，其中 2128 字是书里的原文，提问"来说说代表机构"
// 只有 7 字压在最后——模型于是把那段原文当题目来评论（答复开头是"这句话在反驳谁"），
// 用户的提问成了附注。现在：
//   ① 提问提到最前并标明【我的提问】（模型先看到"要办的事"，原文是材料）；
//   ② 1500 字前文窗口整条删掉（不是只对提问关掉：它服务的"划线即讨论"已停用，见上方注释）；
//   ③ 引文本身只留 `> "…"`，书名章节由 [正在共读] 那行交代，不重复。
// 拆句见 lib/chat-input.js 的 splitQuotedQuestion（按空行分块，多行划线也拆得对）。
//
// 2026-10-24 译文引用（PDF 阅读器）：用户在译文卡片里划一句设成引用，引文块是**中文译文**，
// 而原文（整张卡片的源文）躺在 msg.selectedText 里一直没用上。现在这类引用单独走一支：
// 引文照旧是用户读到的那句，后面再挂一块【这段译文的原文】，并明说"只讨论引文对应的那句"。
// 不做逐句对齐——卡片内没有字符锚点，硬切会切错；由模型自己把中文那句对到英文段上。
// 判定与取哪份原文的纯逻辑在 lib/ref-source.js（有单测）。
function translatedRefInfo(msg, material) {
  const ref = annotationRefFor(msg.bookId, msg.selectedText, { normalizeBookId: baseBookId })
  if (!isTranslatedRef({ ref, selectedText: msg.selectedText, material })) return null
  return { source: clipRefSource(refSourceOf({ ref, selectedText: msg.selectedText })) }
}

function enrichChatMessage(msg) {
  if (!msg.bookId || !msg.selectedText) return msg.content

  const { bookId, bookTitle, chapter, chapterUid, selectedText } = msg
  const { material, question } = splitQuotedQuestion(msg.content, selectedText)
  const trans = translatedRefInfo(msg, material)

  const parts = [`[正在共读]《${bookTitle}》${chapter || ''}`]
  if (question) parts.push(`【我的提问】${question}`)

  if (trans) {
    if (material) parts.push(`【我引用的译文】\n${material}`)
    if (trans.source) {
      parts.push(`【这段译文的原文】\n${trans.source}`)
      parts.push('【说明】引文是译文；请把讨论集中在引文对应的那一句上，原文块只用于对照（可能来自截图识别，个别字有误）。')
    } else {
      // 引用身份为空（极少见）：不能挂一块空的"原文"，也不能让说明指向不存在的块
      parts.push('【说明】引文是译文；这次没拿到对应的原文，请按译文讨论。')
    }
  } else {
    if (material) parts.push(`【我引用的原文】\n${material}`)
    const ctx = assembleBookContext(bookId, bookTitle, chapter, chapterUid, selectedText)
    if (ctx.trim()) parts.push(`【引用处上下文】\n${ctx.trim()}`)
  }
  if (parts.length === 1) return msg.content
  return parts.join('\n\n')
}

// ── 首次启动 ─────────────────────────────────────────────────────────────────
// 2026-10-06 删掉了"引导冷启动"整段：它会在启动时问一句
//   「是否现在加载？需要 WEREAD_API_KEY（y/n）」
// 那在"人在终端前"的时代是合理的（当时的入口是 tmux / start.bat 前台跑 agent），
// 但 2026-10-04 起 agent 由托盘**隐藏启动**，整条链上没有任何控制台 ——
// rl.question 的回调永不触发，await 永远等下去，**全新用户第一次启动就永久卡住**，
// 而托盘的健康判据只是"进程在不在"，于是照样显示"运行中 ✅"。
//
// 连带删掉的还有它背后的"用微信读书历史生成画像初稿"那条路（scripts/coldstart.js：
// 走 i.weread.qq.com 的 gateway 全量拉书架/划线/想法）。原因：WEREAD_API_KEY 在便携包里
// 根本没有来源（全项目只有读、没有写；托盘启动 node 时也不带 --env-file），
// 所以就算有人能答上那个 y，也只会得到"请在 .env 里添加"。
//
// **画像功能本身没有消失**：它的写入者是会话结束固化（saveSessionMemory，语义见
// MEMORY_SPECS.profile）与自由对话归档，会把讨论中用户明确表达过的内容合并进
// data\profile\portrait.md。
// 删掉的只是"开局从微信读书拉一份初稿"这一步，新用户从零开始积累。

// ── 当前划线（书归属锚点）────────────────────────────────────────────────────
// 2026-10-17：processNewAnnotations 整段删除（"划线即讨论"的入口与实现，见上方说明）。
// currentAnn 留着：书绑定提问时由 processChat 赋值，REPL 的普通回复靠它把讨论归到当前书。
let currentAnn = null

// ── REPL ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📖 CoRead 共读 agent 已启动')
  console.log(`   ${layoutSummary()}`)
  // L3 装配模式（2026-10-24）：每轮现读 data\config\l3-mode，这里只把"当前生效的是哪种"打出来，
  // 免得改完文件不知道有没有生效。缺文件/写错按 full（= 今天的行为）。
  console.log(`   L3 装配模式：${readL3Mode()}（data\\config\\l3-mode；full=旧路径整段注入，tasks=课题组分包，both=两条同跑，off=不发；侧栏发 /l3 切换）`)
  // 升级告警（2026-10 目录重构）：老用户的数据还在旧位置、还没迁移时，新库会**静默地空**——
  // 用户只会觉得"我的记录没了"。所以这里显式拦住并指路，别让人对着空历史猜。
  const unmigrated = detectUnmigrated()
  if (unmigrated.length) {
    console.log('\n⚠️  检测到旧目录里还有数据，但新数据目录里没有：')
    for (const line of unmigrated.slice(0, 6)) console.log(`     · ${line}`)
    if (unmigrated.length > 6) console.log(`     · …另有 ${unmigrated.length - 6} 项`)
    console.log('   这些数据**不会自动搬过来**。请先退出，然后运行一次迁移：')
    // 命令按当前布局生成：便携包里 node 不在 PATH、脚本也在 internal\ 下，
    // 硬编码开发目录那套写法会让用户照抄后撞上"node 不是内部或外部命令"。
    console.log(`     ${scriptCommand('migrate-data-layout.mjs')} --apply`)
    console.log('   （先不加 --apply 跑一遍是演练，只打印计划、不动文件）\n')
  }
  console.log('   输入 /exit 退出\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

  // 强杀/断电兜底：上次会话未固化的对话在启动时恢复合并
  await recoverUnmergedMemory()

  // 聊天存储：打开（必要时建表）并把上次崩溃残留的"处理中"状态清干净。
  // 瞬态打字机通道每次启动清空——它不入档，留着只会让侧栏看到上次的半截气泡。
  resetStreamFile()
  // 停止信号也是瞬态文件：上次运行（尤其崩溃）残留的一律丢弃。
  // 进程内正常流程是"读到即删"，跨进程崩溃才会残留；留着只会在下一轮启动时
  // 误弃一条无关的提问，所以这里无条件清场。
  clearSessionStops('启动清场')
  try {
    const st = chatStore().stats()
    console.log(`   聊天库：${CHAT_DB}（${st.messages} 条消息 / ${st.conversations} 个对话 / 待处理 ${st.pending} / 失败待重试 ${st.failed}）`)
    if (st.pending || st.failed) console.log(`   队列里有 ${st.pending + st.failed} 条待处理消息（含失败重试）`)
  } catch (e) {
    console.log(`  ⚠️ 聊天库打开失败：${e.message}`)
    console.log('     若还没有迁移，请先跑：node agent/scripts/migrate-chat-to-sqlite.mjs --apply')
  }

  // 2026-09 用户定调（跨会话需要旧消息）：histories 是内存态、重启即空，
  // 跨会话承接会断裂（进行中讨论的轮次在主回复 prompt 里丢失）——
  // 启动时从聊天库重建每本书的最近轮次（受 BUDGET 约束，reply_to 直接配对）。
  // 截尾游标先加载：恢复从游标处续推，保证与在线末尾一致（2026-10）。
  histCutCursors = loadHistCursors()
  restoreHistories()

  // 会意系统运行时态：会意图（L3 数据源）+ 会意栈（按书隔离，跨会话恢复）
  // + 每本书的上一轮 AI 回复（判专题化降级判定材料）
  // 关闭/启动恢复**不做收口固化**——只恢复进行中的讨论（讨论没被新专题化弹栈就不收口）
  loadGraph()
  topicStacks = readTopicStacks()
  lastReplyByBook = lastAssistantByBookFromJournal()

  rl.prompt()

  let busy = false
  // 致命故障（401/402/403：余额不足 / 鉴权失败）后暂停队列的截止时间戳。逐条重试只会把同一句
  // 错误刷满整本书的历史（2026-09-28：重放的 213 条各写一个 ⚠️ 气泡），所以识别到这类错误就
  // 中止本轮并暂停：充值/改配置后自动继续，重启 agent 立即恢复。
  const FATAL_PAUSE_MS = 10 * 60 * 1000
  const RETRY_PAUSE_MS = 60 * 1000   // 非致命失败（网络/截断/空流）也歇一会儿，避免热循环
  let queuePausedUntil = 0

  // 清掉上次残留的停机哨兵（2026-10 修）。哨兵是"请求**正在跑的** agent 停机"的信号；
  // 若上一次停机时 agent 已经死了，写下的哨兵就没人消费，留在磁盘上——新 agent 启动后
  // 轮询第一轮（≤3 秒）读到它就会**立刻自杀**。实测：18:04 启动 → 秒退，用户看到的是
  // "CoRead 打不开"（侧栏发消息没人应答），托盘要等自愈间隔才重新拉起（那次等了 34 分钟）。
  // 判据用 mtime：只清**早于本进程启动时刻**的哨兵——启动之后写的照常生效（用户此刻正要点退出）。
  const START_TS = Date.now() - Math.round(process.uptime() * 1000)   // 本进程真实启动时刻
  try {
    if (fs.statSync(STOP_FILE).mtimeMs < START_TS) {
      fs.unlinkSync(STOP_FILE)
      console.log('  🧹 清掉一个上次残留的停机哨兵（否则本进程会在 3 秒内退出）')
    }
  } catch {}   // 文件不存在 = 正常情况（绝大多数启动都是这样）

  // 每 3 秒轮询新标注 + 侧栏用户消息
  const poller = setInterval(async () => {
    if (busy) return

    // 优雅停机：stop.bat 写入 .stop 哨兵 → 保存记忆后退出（"正在保存，请稍候"）。
    // 放在 busy 判断之后：若正在调 LLM，等这条回复收尾才保存，避免并发写。
    if (fs.existsSync(STOP_FILE)) {
      clearInterval(poller)
      rl.pause()
      console.log('\n🛑 收到停止请求，正在保存记忆，请稍候…')
      try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
      // 关闭不做收口固化：进行中的讨论留在栈里（topic_stack.json 已实时保存），下次恢复
      try { fs.unlinkSync(STOP_FILE) } catch {}
      closeChatStore()
      console.log('👋 已保存，共读会话结束。')
      process.exit(0)
    }

    // 队列暂停中（刚发生致命故障 / 连续失败）：本轮不调模型、不刷气泡。
    // 停机哨兵在上面已处理，所以暂停期间 stop.bat 照常工作。
    if (Date.now() < queuePausedUntil) return

    // 处理来自侧栏的用户消息 = 库里 status IN ('pending','failed') 的行（按 id 升序）。
    // 旧实现要读文件 + 比游标 + 查指纹台账，还要防"读到空文件→游标归零→全量重放"；
    // 现在"哪条没答"是数据库查询，"答到哪了"是自增 id，那一整类事故从结构上消失。
    const pending = readPendingMessages()
    if (!pending.length) return
    busy = true
    rl.pause()
    try {
      for (const msg of pending) {
        // AI-001：消息归属当前书——有 bookId 用其书（自由消息也带书签，见 sidebar submit），
        // 无 bookId 则沿用"正在读的书"（currentBookKey），否则进 _common。
        const key = msg.bookId ? baseBookId(msg.bookId) : (msg.conv || currentBookKey || '_common')
        // 停止信号·正确性闸②（2026-02 用户定调）：本条开始处理前先看一眼。
        // 它兜住的是"信号到达时这条已经被捡进队列"的情形——命中就整轮弃掉，不解析、不生成、不入栈。
        // 这里**不用动历史**：say() 还没被调用，这条消息从未进过 histories。
        // 2026-11：只认发给**这一条**的信号（msg.timestamp 是它落库时的 timestamp）；
        // 否则上一条留下的过期信号会把这条消息原封不动地弃掉（连提问行一起删）。
        if (consumeSessionStop(key, msg.timestamp)) {
          discardStoppedTurn({ conv: msg.conv, questionId: msg.id })
          continue
        }
        // /收口：手动收口本书讨论（2026-09 用户定调——读完一本书时使用）。
        // 指令消息不进栈/不进会话历史/不触发 LLM，只执行收口并回复确认。
        if (String(msg.content || '').trim() === '/收口') {
          const cr = await forceConsolidate(key)
          // 系统提示：role=system（侧栏以系统样式渲染 + toast，不参与引用回复配对）
          appendChatOutput('system', cr.reply, key, { replyTo: msg.id })
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + cr.reply + '\n')
          continue
        }
        // /l3：L3 装配模式与调试开关（2026-10-24）。指令不进历史、不进栈、不调模型，
        // 回执用系统消息（侧栏按系统气泡渲染）——与 /相处 同一种通道。
        if (/^\/l3(?:\s|$)/.test(String(msg.content || '').trim())) {
          const arg = String(msg.content || '').trim().replace(/^\/l3\s*/, '')
          const r = handleL3Command(arg, {
            modeFile: L3_MODE_FILE, debugFile: L3_DEBUG_FILE,
            log: (m) => console.log(`  [l3] ${m}`),
          })
          appendChatOutput('system', r.reply, key, { replyTo: msg.id })
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + r.reply + '\n')
          continue
        }
        // /归档：归档一场自由对话（2026-11 用户定调）。侧栏归档弹窗发出——请求带
        // archive = { key, memory, graph }（勾选项，现在由「聊天库」承载在 payload 里，
        // 老版本是顶层 msg.archive，两个位置都认）。归档 = 这场对话结束并删除：默认勾选的
        // 两项 = 保存记忆 + 收口进正式拓扑图（读书模式那套正常程序）；完成后清栈、清消息、
        // 注册表留墓碑。
        if (String(msg.content || '').trim() === '/归档') {
          const ar = (msg.payload && msg.payload.archive) || msg.archive || {}
          const target = ar.key ? baseBookId(ar.key) : key
          const reply = isFreeKey(target)
            ? (await archiveFreeConversation(target, ar)).reply
            : '只能归档自由模式的对话（读书模式的讨论用 /收口）。'
          // 不带 replyTo（2026-11 修）：archiveFreeConversation 已经把这场对话的消息
          // 连这条 /归档 指令一起删了，再引用它就会撞外键、回执整条丢失。
          appendChatOutput('system', reply, target)
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + reply + '\n')
          continue
        }
        // /相处：相处规则（agreement.md）的**唯一入口**（2026-10 定调）。指令消息不进栈、
        // 不进会话历史。用户说人话，AI 负责整理（见 lib/agreement.js）：
        //   · 无参数 → 只列清单（不调模型）
        //   · 有参数 → 一次判定调用（judgeLLM，temperature 0）：总结要求 / 合并重复 / 报告冲突
        // 回执用系统消息写回侧栏（侧栏按系统气泡渲染）。
        if (/^\/相处(?:\s|$)/.test(String(msg.content || '').trim())) {
          const arg = String(msg.content || '').trim().replace(/^\/相处\s*/, '')
          const sr = await handleAgreement(arg, AGREEMENT_FILE, {
            callLLM: judgeLLM,
            log: (m) => console.log(`  [相处] ${m}`),
          })
          appendChatOutput('system', sr.reply, key, { replyTo: msg.id })
          markMessage(msg.id, { status: 'ok' })
          console.log('\n[侧栏] ' + sr.reply + '\n')
          continue
        }
        // 自由对话（任意自由 key）不改变"正在读的书"：对话结束后，后续无 bookId 的
        // 自由消息仍应归属真实阅读的书，而不是滞留在自由模式
        if (msg.bookId && key !== currentBookKey && !isFreeKey(key)) {
          // 切书：旧书的讨论周期结束，避免 currentAnn 残留污染新书
          currentBookKey = key
          currentAnn = null
        }
        // 带书籍元数据的消息：绑定到该书讨论（补全书上下文）。
        // 不带 selectedText 的自由消息不绑定书级讨论，但仍进入该书的会话上下文。
        const bookScoped = msg.bookId && msg.selectedText
        if (bookScoped) {
          currentAnn = {
            bookId: msg.bookId, bookTitle: msg.bookTitle,
            chapter: msg.chapter, chapterUid: msg.chapterUid,
            selectedText: msg.selectedText, userNote: msg.content,
          }
        }
        // 引用解析（会话中）：命中 → L3 图路径上下文注入；引用挂消息（固化后按组建边）。
        // 自由模式（2026-09）：引用以侧栏窗体为准——msg.refs = 语义命中自动并入 +
        // 用户手动从拓扑图选取的节点清单（用户可在窗体上取消任意条）。带 refs 字段
        // 就用它（校验节点存在），不带则回退语义解析命中（老版本侧栏/其他入口）。
        // 处理步骤状态：图非空时引用解析才真调 LLM，步骤先行（侧栏"正在…"文案）
        if (graph.nodes.length) appendAgentState('resolve', key)
        const citesR = await resolveCitations(msg.content, key, msg.timestamp)
        let citesFinal = citesR.hits
        if (isFreeKey(key) && Array.isArray(msg.refs)) {
          citesFinal = msg.refs.filter((id) => graph.nodes.some((n) => n.id === id))
          console.log(`  [自由模式] 引用以窗体为准（${citesFinal.length} 条）${citesFinal.length ? '：' + citesFinal.join('、') : ''}`)
        }
        const userMsg = enrichChatMessage(msg)
        // AI-017：侧栏入库只留"划线原文(引用) + 你的提问"，不含 [正在共读] 章节窗口；自由消息保持原话。
        // bookTitle 用 || '' 兜底——与 restoreHistories 的 storeText 构造完全一致（否则缺书名时
        // 在线历史《undefined》与恢复历史《》不同，跨会话缓存前缀断裂，2026-10）
        const storeText = msg.selectedText
          ? `【划线】《${msg.bookTitle || ''}》${msg.chapter || ''}\n划线原文：${msg.selectedText}\n我的提问：${msg.content}`
          : msg.content
        appendAgentState('answer', key)
        // 判栈提到**生成回答之前**（2026-10-26 用户定）：这一问会不会弹栈，决定要不要继承
        // 上一轮的有效来路节点。判栈只判不落盘，落盘在回答之后（applyStackTurn）。
        const lastR = lastReplyByBook[key]
        const stackUnit = buildTopicUnit(msg, lastR ? lastR.content : null, lastR ? lastR.selected : undefined)
        const stackDecision = await judgeStackTurn(key, stackUnit, citesFinal)
        // 继承：同一段讨论继续（pushed）才继承；弹栈、或不入栈都不继承（见 lib/l3-live.js）
        const inherited = stackDecision && stackDecision.action === 'pushed' ? readLive(key) : []
        if (inherited.length) console.log(`  [l3] 继承上一轮有效来路 ${inherited.length} 个：${inherited.join('、')}`)
        const hitsThisRound = [...new Set([...citesFinal, ...inherited])]
        // replyTo = 这条提问的 id：回答入库时直接挂上引用（配对从"时间序推断"变成"外键"）
        // replyToTs = 这条提问落库的 timestamp：侧栏用它当"哪一轮"的身份证（停止收尾后
        // 晚到的流式分片靠它认领，见 appendChatOutputStream 的注释）
        // l3Hits = 本轮新命中 ∪ 同栈上一轮有效来路：tasks 路径拿它派课题。
        const reply = await say(userMsg, { bookKey: key, storeText, assistantSelected: selectionFromMsg(msg), l3: citesR.l3, l3Hits: hitsThisRound, replyTo: msg.id, replyToTs: msg.timestamp })
        // 用户停止（2026-02 用户定调"当没问过"）：say() 已经把历史与流水账收干净了，
        // 这里再弃掉库里的提问行与命中事件，然后**直接进入下一条**——
        // 不标 ok、不标 failed、不入栈判同一、不记账。判同一根本轮不到被踩。
        if (isAbortedReply(reply)) {
          discardStoppedTurn({ conv: msg.conv, questionId: msg.id })
          continue   // 瞬态流的收尾由 say() 独占写（那里已补 -1），此处不再重复写
        }
        // 致命配置/额度错误（401/402/403）：中止本轮 + 暂停队列 + 只留一条 system 提示。
        // 该消息保持 pending（不标 ok）→ 充值/改配置后会重新回答；也不再逐条试
        // （旧行为会刷出几百个 ⚠️ 气泡，2026-09-28 一次刷了 213 个）。
        const fatal = takeFatalError()
        if (fatal) {
          const note = fatalErrorMessage(fatal)
          appendChatOutput('system', note, key)
          console.log('\n[侧栏] ' + note + '\n')
          queuePausedUntil = Date.now() + FATAL_PAUSE_MS
          break
        }
        if (/^⚠️/.test(reply)) {
          // 非致命失败（网络/截断/空流）：status=failed → 下一轮/下次启动仍会重试；
          // 歇 60s 再继续，避免对着一台坏掉的 API 热循环。
          markMessage(msg.id, { status: 'failed', error: String(reply).slice(0, 200) })
          queuePausedUntil = Date.now() + RETRY_PAUSE_MS
          break
        }
        markMessage(msg.id, { status: 'ok' })
        console.log('\n[侧栏] ' + stripCodeBlocks(reply) + '\n')
        // 会意栈（按书隔离）：喂该消息所属书的栈；以上一轮**同书** AI 回复为降级上下文；
        // 入栈消息的引用暂存，**收口固化**（新专题化弹栈旧讨论）时建 user 边 + 段间无条件 derived 边。
        // 判已经在生成之前做完了（judgeStackTurn），这里只落盘 + 必要时收口。
        await applyStackTurn(key, stackUnit, reply, stackDecision)
        lastReplyByBook[key] = { content: stripCodeBlocks(reply), selected: selectionFromMsg(msg) }
      }
    } catch (e) { console.log(`⚠️ ${e.message}\n`) }
    busy = false
    rl.resume()
    rl.prompt()
  }, 300)

  rl.on('line', async (raw) => {
    const line = raw.trim()
    if (!line) { rl.prompt(); return }
    if (busy) return

    if (line === '/exit' || line === '/quit') { rl.close(); return }

    busy = true
    rl.pause()
    try {
      if (line.startsWith('/l3')) {
        // REPL 里也能切（开发时不用去翻文件）；回执直接打终端
        const r = handleL3Command(line.replace(/^\/l3\s*/, ''), {
          modeFile: L3_MODE_FILE, debugFile: L3_DEBUG_FILE,
          log: (m) => console.log(`  [l3] ${m}`),
        })
        console.log('\n' + r.reply + '\n')
      } else if (line.startsWith('【章节完成】')) {
        // AI-001：章节总结归属当前讨论的书，否则进通用上下文
        const reply = await say(line, { bookKey: currentBookKey || '_common' })
        console.log('\n' + stripCodeBlocks(reply) + '\n')
      } else {
        // 普通用户回复
        // AI-001：有当前书讨论锚点归该书，否则归"正在读的书"或通用上下文
        const key = currentAnn ? baseBookId(currentAnn.bookId) : (currentBookKey || '_common')
        // 引用解析（会话中）：命中 → L3 图路径上下文注入；引用挂消息（固化后按组建边）；
        // 命中事件带书归属（key），侧栏按当前上下文过滤显示
        const citesR = await resolveCitations(line, key)
        const reply = await say(line, { bookKey: key, l3: citesR.l3, l3Hits: citesR.hits })
        console.log('\n' + stripCodeBlocks(reply) + '\n')
        // 会意栈（按书隔离）：REPL 输入也是用户追问，喂进该书（key）的栈；REPL 无划线，selected 恒缺省
        const lastR = lastReplyByBook[key]
        await driveTopicStack(key, buildTopicUnit({ content: line }, lastR ? lastR.content : null, lastR ? lastR.selected : undefined), reply, citesR.hits)
        lastReplyByBook[key] = { content: stripCodeBlocks(reply), selected: undefined }
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}\n`)
    }
    busy = false
    rl.resume()
    rl.prompt()
  })

  async function shutdown() {
    clearInterval(poller)
    // 若正在调 LLM，等它收尾再固化，避免并发写 profile
    let waited = 0
    while (busy && waited < 15000) { await sleep(100); waited += 100 }
    try { await saveSessionMemory({ minMsgs: 2 }) } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
    // 关闭不做收口固化：进行中的讨论留在栈里（已实时保存），下次恢复
    closeChatStore()
    console.log('👋 共读会话结束。')
    process.exit(0)
  }

  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => { console.error('❌', e.message); closeChatStore(); process.exit(1) })
