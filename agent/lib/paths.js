/**
 * CoRead 数据路径 —— 全项目**唯一真源**（2026-10 目录重构）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────────
 * 2026-10 之前，数据路径散在 5 个文件的 10 处定义里（agent/index.js、receiver/index.js、
 * receiver/graph-data.js、agent/lib/api-config.js、agent/lib/free-conversation.js），
 * 落点跟着代码走，结果是：
 *     internal\agent\data\        会意图谱、画像
 *     internal\agent\（根目录）   讨论栈、流水账、游标、API 配置（和 index.js 混在一层）
 *     internal\receiver\inbox\    聊天库、标注、游标
 *     internal\receiver\books\    书库缓存
 *     internal\receiver\toolbox\  翻译记录
 * 代价（2026-10-06 实测踩到）：用户想把自己的数据搬到新版本上，**必须读源码才知道要拷哪些**，
 * 漏拷一个游标就重放旧对话；把 chat.db 单独拷过去、留着旧库的 -wal，SQLite 会把新库
 * 回滚成空库（实测复现：725 页 → 13 页，941 条消息清零）。
 *
 * ── 现在的规矩 ───────────────────────────────────────────────────────────────
 * 1. **用户数据只在一个地方**：`<包根>\data\`。备份 = 复制这一个文件夹。它不在 internal\ 里，
 *    因为 internal\ 的定位是"程序，用户别动"（说明书原话），数据关在里面就违背这个定位。
 * 2. **只有用户数据进 data\**。日志（debug.jsonl）进 `logs\`（可随时清空），
 *    内置的回退图谱进 `builtin\`（不属于用户，不参与备份）。
 * 3. **按数据类型分格**，不按代码模块分格。分格依据是"这份数据代表什么"，
 *    顺带回答用户最关心的那个问题——哪些删了会丢东西：
 *
 *     data\
 *     ├── config\     设置：模型地址、密钥          ← 删了要重填
 *     ├── profile\    对用户的长期理解（画像、图谱） ← 删了 AI 不认识你
 *     ├── sessions\   对话、讨论、游标              ← 删了聊天记录和讨论进度没了
 *     ├── reading\    书、正文缓存、划线标注        ← 删了记录没了（书能重新拉）
 *     ├── runtime\    处理状态（可随时删）          ← 启动自动重建
 *     └── toolbox\    翻译记录                      ← 删了翻译历史没了
 *
 * 4. **开发目录与便携包结构一致**：数据都在"agent 与 receiver 的父目录"下的 `data\`。
 *    仓库根布局：  <repo>\agent\        →  <repo>\data\
 *    便携包布局：  <pkg>\internal\agent\ →  <pkg>\data\
 *    所以本模块用 PARENT_NAME === 'internal' 区分两种布局——便携包的 internal\ 是打包脚本
 *    （installer\pack-portable-zip.ps1）建的，这个事实是稳定的。
 *    没走"检测 installer\ 目录是否存在"那条路：那种探测器耦合的是仓库长什么样；
 *    而 PARENT_NAME === 'internal' 检查的是**我们自己的安装布局**，而且规则只有一条。
 *
 * ── 谁在用 ───────────────────────────────────────────────────────────────────
 * agent/index.js、receiver/index.js、receiver/graph-data.js、agent/lib/api-config.js、
 * agent/lib/free-conversation.js、agent/scripts/migrate-data-layout.mjs
 * 都从这里取路径，不再自己 path.join(__dirname, ...)。
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** agent 目录（本文件在 agent/lib/ 下，往上两级） */
export const AGENT_DIR = path.join(__dirname, '..')
/** agent 与 receiver 的共同父目录：开发时是仓库根，便携包里是 internal\ */
export const PARENT_DIR = path.join(AGENT_DIR, '..')
/** receiver 目录（与 agent 同级；agent 靠它找 inbox，见下方结构说明） */
export const RECEIVER_DIR = path.join(PARENT_DIR, 'receiver')

const PARENT_NAME = path.basename(PARENT_DIR).toLowerCase()

/**
 * 布局判定：便携包（agent 装在 internal\ 下）还是开发目录（agent 就在仓库根下）。
 * 这个判断决定**包根**在哪，进而决定 data\ 在哪。
 * @returns {{kind: 'package'|'dev', packageRoot: string, reason: string}}
 */
export function resolveLayout() {
  if (PARENT_NAME === 'internal') {
    return {
      kind: 'package',
      packageRoot: path.join(PARENT_DIR, '..'),
      reason: "程序装在 internal\\ 下 → 便携包布局，数据在 <包根>\\data",
    }
  }
  return {
    kind: 'dev',
    packageRoot: PARENT_DIR,
    reason: "程序直接在仓库根下 → 开发布局，数据在 <仓库根>\\data",
  }
}

const LAYOUT = resolveLayout()
export const LAYOUT_KIND = LAYOUT.kind
export const PACKAGE_ROOT = LAYOUT.packageRoot
export const LAYOUT_REASON = LAYOUT.reason

/**
 * 「怎么再跑一次某个脚本」——按当前布局给出**用户真能照着敲**的命令。
 *
 * 为什么要有这个函数（2026-10 实测的坑）：程序里几处提示（agent 启动时的升级告警、
 * 迁移脚本自己打印的下一步）以前硬编码 `node agent/scripts/xxx.mjs`，那是**开发目录**
 * 的写法。而便携包里：① node 不在 PATH —— 自带的是 `internal\node.exe`；
 * ② 脚本在 `internal\agent\scripts\` 下。用户照抄的结果是
 * 「'node' 不是内部或外部命令」或者 Cannot find module，然后就卡住了。
 *
 * 判定复用同一份布局信号（PARENT_NAME === 'internal'），不引入第二个真相。
 * @param {string} scriptFile 脚本文件名，如 'migrate-data-layout.mjs'
 */
export function scriptCommand(scriptFile) {
  return LAYOUT_KIND === 'package'
    ? `internal\\node.exe internal\\agent\\scripts\\${scriptFile}`
    : `node agent/scripts/${scriptFile}`
}

/** data\ 根目录（用户数据的唯一落点） */
export const DATA_DIR = path.join(PACKAGE_ROOT, 'data')
/** 程序内置数据（回退图谱、演示图）：不属于用户，不参与备份 */
export const BUILTIN_DIR = path.join(PACKAGE_ROOT, 'builtin')
/** 日志（托盘输出、侧栏调试上报）：可随时清空 */
export const LOGS_DIR = path.join(PACKAGE_ROOT, 'logs')

/**
 * 开发期数据（**不进包、用户机器上不存在**）：judge/图谱那几个离线脚本的输入与产物。
 *
 * 目录名 `test\`（2026-10-07 用户定规）：**所有"非正式/过程性"文件统一放这一格** ——
 * 跑批产物、临时脚本、诊断输出、截图、一次性抽取。用户明确表示**不查看这一格**，
 * 看到 `test\` 就知道是 AI 操作留下的东西。规矩原文见仓库根 `AGENTS.md` 第 7 条。
 * （⚠️ 名字叫 test 不代表它是测试夹具：这一格里有作者的**真实阅读语料**。）
 *
 * 为什么必须离开打包源目录（2026-10 整理）：这些东西以前放在 `agent/scripts/data/`，
 * 也就是**打包源目录的隔壁** —— 而它们是作者的私人语料（真实讨论单元、评判结果、读书会意图谱，
 * 实测 4.4 MB，且都被 .gitignore 排除、只存在于本机）。风险很实在：打包脚本早先就
 * 真把作者的知识图谱打进过发行包（本地打包带出去、CI 反而躲过，见 pack-portable-zip.ps1 注释）。
 * 挪出 `agent\scripts\` 之后，"整目录拷"这种手滑再也不会捎带私人数据 ——
 * 从"靠闸门拦"变成"物理上不在那儿"。
 *
 * 常量名保留 DEVDATA_DIR：它描述语义（开发期数据），而目录名服务于用户的查看习惯。
 *
 * 注意：便携包里这个路径不存在，也不要往里写用户数据。
 */
export const DEVDATA_DIR = path.join(PACKAGE_ROOT, 'test')

// ── data\ 下的各格 ──────────────────────────────────────────────────────────
export const CONFIG_DIR = path.join(DATA_DIR, 'config')
export const PROFILE_DIR = path.join(DATA_DIR, 'profile')
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const READING_DIR = path.join(DATA_DIR, 'reading')
export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime')
export const TOOLBOX_DIR = path.join(DATA_DIR, 'toolbox')
/** 备份（脚本 backup-chat.mjs 产出）——放在 data\ 里，用户复制 data\ 时备份一起走 */
export const DATA_BACKUPS_DIR = path.join(DATA_DIR, 'backups')

// ── 具体文件 ────────────────────────────────────────────────────────────────
// config\：设置（含密钥明文，见 data\README.txt 的警告）
export const API_CONFIG_FILE = path.join(CONFIG_DIR, 'api-config.json')
export const ENV_FILE = path.join(CONFIG_DIR, 'env')

// profile\：对用户的长期理解
export const GRAPH_FILE = path.join(PROFILE_DIR, 'knowledge-graph.json')
export const SELF_PORTRAIT_FILE = path.join(PROFILE_DIR, 'self-portrait.md')
export const PROFILE_FILE = path.join(PROFILE_DIR, 'portrait.md')
export const SOUL_FILE = path.join(PROFILE_DIR, 'values-portrait.md')
export const UNANSWERED_QUESTIONS_FILE = path.join(PROFILE_DIR, 'unanswered-questions.json')
// 2026-10-06 删掉了 COLDSTART_MARKER_FILE（profile\coldstart-done）：
// 它只是用来记住"别再问是否加载微信读书历史"，而那句提问连同它背后的
// scripts/coldstart.js 一起删了（原因见 agent/index.js 里那段注释）。
// 老安装里可能残留一个 0 字节的 profile\coldstart-done，没有任何代码读它，可以直接删。
/** 内置回退图谱（随包分发；用户数据缺失时图视图显示它） */
export const BUILTIN_GRAPH_RESULTS_FILE = path.join(BUILTIN_DIR, 'knowledge-graph-results.json')
/** 演示拓扑的事件序列（随包分发；?demo=1 用） */
export const BUILTIN_GRAPH_DEMO_FILE = path.join(BUILTIN_DIR, 'knowledge-graph-demo.json')

// sessions\：对话与讨论（跨会话承接的数据都在这）
export const CHAT_DB = path.join(SESSIONS_DIR, 'chat.db')
export const JOURNAL_FILE = path.join(SESSIONS_DIR, 'journal.jsonl')
export const HIST_CURSOR_FILE = path.join(SESSIONS_DIR, 'hist-cursors.json')
export const LAST_ANSWERED_FILE = path.join(SESSIONS_DIR, 'last-answered.json')
export const TOPIC_STACK_FILE = path.join(SESSIONS_DIR, 'topic-stack.json')
export const FREE_CONVERSATIONS_FILE = path.join(SESSIONS_DIR, 'free-conversations.json')
/** 优雅停机哨兵：托盘 / stop.bat 写，agent 轮询到就保存记忆退出。
 *  ⚠️ 历史上这处路径写歪过（2026-10 修）：tray.ps1 曾写 <包根>\data\agent\.stop，
 *  而 agent 查的是 internal\agent\.stop，两边对不上 → 托盘退出永远走强制杀进程、
 *  记忆不固化。**改这里必须同时改 installer\launcher\tray.ps1 和 stop.bat。** */
export const STOP_FILE = path.join(SESSIONS_DIR, 'stop-request')

// reading\：书、正文缓存、划线标注
export const ANNOTATIONS_FILE = path.join(READING_DIR, 'annotations.jsonl')
export const BOOKS_DIR = path.join(READING_DIR, 'books')
export const DELETED_ANNOTATIONS_FILE = path.join(READING_DIR, 'deleted-annotations.json')

// runtime\：处理状态与瞬态通道（删了无害，启动自动重建）
export const AGENT_CURSOR_FILE = path.join(RUNTIME_DIR, 'agent-cursor')
export const AGENT_STATE_FILE = path.join(RUNTIME_DIR, 'agent-state.jsonl')
export const STREAM_FILE = path.join(RUNTIME_DIR, 'stream.jsonl')

// ── 浏览器插件的扩展 ID（2026-10：托盘「打开 CoRead 阅读器」用）───────────────
// 它是干什么的：CoRead 自带的阅读器是**扩展自己的页面**，地址形如
//     chrome-extension://<32 位扩展 ID>/reader.html
// 托盘（tray.ps1）要拼这个地址，就得知道那份 ID。
//
// ⚠️ 2026-10-07 修正：**托盘的主路是自己算，不是读这个文件**。
//   扩展 ID 就是"扩展目录绝对路径"的 SHA256 前 16 字节（十六进制再映射成 a~p），
//   算法固定、可复现 —— 托盘直接算得出来，不需要问任何人。这个文件只是**回退**：
//   万一哪天浏览器改了 ID 派生算法，浏览器亲口报的这个值更可信。
//   为什么当初没这么设计：第一版拿"插件报到 → 接收端写文件 → 托盘读"当主路，
//   而插件只在浏览器启动 / 插件重载 / 装上时报一次 —— 文件一旦缺失（比如被清理掉），
//   用户浏览器又一直开着，就**再也不会有第二次机会**补上，功能直接断（实测踩到）。
//
// 为什么放 runtime\：它是"当前那份插件叫什么"，删了不影响任何用户数据，
// 正是 runtime\ 这一格的定位（见文件头第 3 条分格依据）。
//
// 读取方式：**不要自己拼路径**（tray.ps1 读它；读不到时的降级行为由托盘自己处理）。
export const EXTENSION_ID_FILE = path.join(RUNTIME_DIR, 'extension-id')

/**
 * Chrome 内核浏览器的扩展 ID 形状：**恰好 32 个字符，且只用 a~p 十六个字母**
 * （ID 是公钥哈希的十六进制，再把 0-9a-f 映射到 a-p）。
 * 校验它有两个用处：① 挡掉写进文件名/URL 里的怪字符串；② 托盘据此确认"这份 ID 是可信的"。
 */
const EXTENSION_ID_RE = /^[a-p]{32}$/

/**
 * 这个字符串像不像一个合法的扩展 ID。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isExtensionId(id) {
  return typeof id === 'string' && EXTENSION_ID_RE.test(id)
}

/**
 * 由扩展 ID 拼出「CoRead 阅读器」的页面地址。
 * 托盘（tray.ps1 的 Get-ReaderUrl）算出来后拼的是**同一个地址**，
 * 改这里就要改那里 —— 两处必须给出一样的结果。
 * @param {unknown} id
 * @returns {string} 合法则返回地址；不合法返回空串（调用方自己决定怎么提示）
 */
export function extensionReaderUrl(id) {
  return isExtensionId(id) ? `chrome-extension://${id}/reader.html` : ''
}

// ── 停止当前回答（2026-02 用户定调）──────────────────────────────────────────
// 侧栏点「停止」→ receiver 写信号文件 → agent 在处理中读到就弃掉这一轮。
// 为什么要落文件而不是别的：receiver 与 agent 是两个进程，能让 fetch 中断的
// AbortController 是 agent 进程内的对象，另一个进程够不着，只能留一条信号让它自己看见。
//
// 文件名**按对话区分**（对话 key 的短 hash）：共用一个文件名的话，
// 在 A 对话点停止会在 agent 处理 B 对话时被误判。hash 同时挡住路径穿越——
// key 来自请求体，不能直接拼进文件名。
const SESSION_STOP_RE = /^session-stop-[0-9a-f]{16}\.json$/
export function sessionStopFile(conv) {
  const h = createHash('sha256').update(String(conv || '')).digest('hex').slice(0, 16)
  return path.join(RUNTIME_DIR, `session-stop-${h}.json`)
}
/** runtime\ 下现存的全部停止信号（启动清场用；文件是瞬态的，删了无害） */
export function listSessionStopFiles() {
  try {
    return fs.readdirSync(RUNTIME_DIR)
      .filter((n) => SESSION_STOP_RE.test(n))
      .map((n) => path.join(RUNTIME_DIR, n))
  } catch { return [] }
}

// toolbox\：翻译记录
export const TOOL_HISTORY_FILE = path.join(TOOLBOX_DIR, 'translation-history.jsonl')

// logs\：不属于用户数据
export const DEBUG_LOG = path.join(LOGS_DIR, 'debug.jsonl')

/**
 * 旧布局的落点（2026-10 重构之前）。
 * 只给迁移脚本和"缺数据时的告警"用——**运行时绝不读写这里**。
 * 迁移脚本 migrate-data-layout.mjs 按这些路径把老用户的数据搬进 data\。
 * @returns {Array<{from: string, to: string, kind: 'file'|'dir', note: string}>}
 */
export function legacyLocations() {
  const legacyAgent = AGENT_DIR
  const legacyInbox = path.join(RECEIVER_DIR, 'inbox')
  return [
    { from: path.join(legacyAgent, 'api-config.json'), to: API_CONFIG_FILE, kind: 'file', note: '模型 API 配置（含密钥）' },
    { from: path.join(legacyAgent, '.env'), to: ENV_FILE, kind: 'file', note: '环境变量配置（含密钥）' },
    // 注意：旧的 agent\.coldstart_skipped **不再搬进来**。它只是个"别再问我"的标记，
    // 而那句提问连同 coldstart.js 已于 2026-10-06 删除，搬过来只会造出一个没人读的死文件。
    // 它仍在 migrate-data-layout.mjs 的残渣清单里，--clean-legacy 会顺手删掉。
    { from: path.join(legacyAgent, 'data', 'knowledge-graph.json'), to: GRAPH_FILE, kind: 'file', note: '会意图谱' },
    { from: path.join(legacyAgent, 'data', 'knowledge-graph.free.json'), to: path.join(PROFILE_DIR, 'knowledge-graph.free.json'), kind: 'file', note: '自由模式沙盒图（测试产物）' },
    { from: path.join(legacyAgent, 'self-portrait.md'), to: SELF_PORTRAIT_FILE, kind: 'file', note: '观念画像' },
    { from: path.join(legacyAgent, 'profile.md'), to: PROFILE_FILE, kind: 'file', note: '阅读画像' },
    { from: path.join(legacyAgent, 'soul.md'), to: SOUL_FILE, kind: 'file', note: '价值观侧写' },
    { from: path.join(legacyAgent, 'data', 'unanswered-messages.json'), to: UNANSWERED_QUESTIONS_FILE, kind: 'file', note: '未答提问清单' },
    { from: path.join(legacyInbox, 'chat.db'), to: CHAT_DB, kind: 'file', note: '聊天记录（唯一真源）' },
    { from: path.join(legacyAgent, 'session_journal.jsonl'), to: JOURNAL_FILE, kind: 'file', note: '会话流水账' },
    { from: path.join(legacyAgent, 'hist_cursors.json'), to: HIST_CURSOR_FILE, kind: 'file', note: '历史截尾游标' },
    { from: path.join(legacyAgent, 'topic_stack.json'), to: TOPIC_STACK_FILE, kind: 'file', note: '进行中的讨论栈' },
    { from: path.join(legacyAgent, 'data', 'free-conversations.json'), to: FREE_CONVERSATIONS_FILE, kind: 'file', note: '自由对话列表' },
    { from: path.join(legacyInbox, '.agent_cursor'), to: AGENT_CURSOR_FILE, kind: 'file', note: '标注处理游标' },
    { from: path.join(legacyInbox, 'agent_state.jsonl'), to: AGENT_STATE_FILE, kind: 'file', note: '处理步骤状态（可重建）' },
    { from: path.join(legacyInbox, 'annotations.jsonl'), to: ANNOTATIONS_FILE, kind: 'file', note: '划线标注' },
    { from: path.join(legacyInbox, 'deleted-messages.1790934387507.json'), to: DELETED_ANNOTATIONS_FILE, kind: 'file', note: '已删标注存档' },
    { from: path.join(RECEIVER_DIR, 'books'), to: BOOKS_DIR, kind: 'dir', note: '书库缓存（书目 + 章节正文）' },
    { from: path.join(RECEIVER_DIR, 'toolbox', 'history.jsonl'), to: TOOL_HISTORY_FILE, kind: 'file', note: '翻译记录' },
    // 聊天库备份（scripts/backup-chat.mjs 的产物）。2026-10 前在 receiver\backups\，
    // 现在跟备份对象同在 data\ 下——备份不该分两处放，复制 data\ 时要一起走。
    { from: path.join(RECEIVER_DIR, 'backups'), to: DATA_BACKUPS_DIR, kind: 'dir', note: '聊天库备份' },
  ]
}

/**
 * 旧布局里的自由对话注册表路径。
 * 给"读旧数据"的场景用（迁移脚本解析老的 agentDir；free-conversation.js 的回退也认它）。
 */
export function legacyFreeConversationsFile() {
  return path.join(AGENT_DIR, 'data', 'free-conversations.json')
}

/**
 * 建好运行需要的目录（幂等）。
 * receiver 启动时调用；agent 单独起来时也调一次——否则用户直接跑 agent 会因为目录不存在报错。
 */
export function ensureDirs() {
  for (const d of [DATA_DIR, CONFIG_DIR, PROFILE_DIR, SESSIONS_DIR, READING_DIR, RUNTIME_DIR, TOOLBOX_DIR, DATA_BACKUPS_DIR, LOGS_DIR]) {
    fs.mkdirSync(d, { recursive: true })
  }
}

/**
 * 老数据体检：新位置还没有数据，但旧位置有 —— 说明是"升级上来的老用户，还没迁移"。
 * 这个判断存在的理由：如果没有它，升级后聊天记录会是**静默的空**（新库自动建表、0 条消息），
 * 用户只会觉得"我的记录没了"，而不知道要跑一次迁移。启动时据此打一条显眼告警。
 * @returns {string[]} 命中的说明行（空数组 = 无需迁移）
 */
export function detectUnmigrated() {
  const hits = []
  for (const m of legacyLocations()) {
    if (!fs.existsSync(m.from)) continue
    if (fs.existsSync(m.to)) continue          // 新位置已有：不是没迁移，是双份，不管
    hits.push(`${m.note}：${m.from}`)
  }
  return hits
}

/** 一行式布局摘要，启动时打印，出问题时一眼看出程序在用哪个目录 */
export function layoutSummary() {
  return `数据目录：${DATA_DIR}（${LAYOUT_REASON}）`
}

/**
 * 数据文件的"逻辑名 → 路径"对照表。
 * 给**维护脚本**用（agent/scripts/ 下的工具）：
 *   import { DATA_FILES } from '../lib/paths.js'
 *   const graphPath = DATA_FILES['knowledge-graph']
 * 为什么要有它：这些脚本以前各自写死 `path.join(AGENT_DIR, 'data', 'knowledge-graph.json')`
 * 之类的路径，2026-10 目录重构时全失效了（文件不存在 → ENOENT）。
 * 让它们按**逻辑名**取路径，以后路径再动，这里改一处就行。
 * 键名故意不带扩展名、不带目录——脚本关心的是"哪份数据"，不是"放在哪一层"。
 */
export const DATA_FILES = {  'knowledge-graph': GRAPH_FILE,
  'knowledge-graph-fallback': BUILTIN_GRAPH_RESULTS_FILE,
  'knowledge-graph-demo': BUILTIN_GRAPH_DEMO_FILE,
  'knowledge-graph-free': path.join(PROFILE_DIR, 'knowledge-graph.free.json'),
  'self-portrait': SELF_PORTRAIT_FILE,
  portrait: PROFILE_FILE,
  'values-portrait': SOUL_FILE,
  'unanswered-questions': UNANSWERED_QUESTIONS_FILE,
  'chat-db': CHAT_DB,
  journal: JOURNAL_FILE,
  'hist-cursors': HIST_CURSOR_FILE,
  'last-answered': LAST_ANSWERED_FILE,
  'topic-stack': TOPIC_STACK_FILE,
  'free-conversations': FREE_CONVERSATIONS_FILE,
  'stop-request': STOP_FILE,
  annotations: ANNOTATIONS_FILE,
  'deleted-annotations': DELETED_ANNOTATIONS_FILE,
  'agent-cursor': AGENT_CURSOR_FILE,
  'agent-state': AGENT_STATE_FILE,
  stream: STREAM_FILE,
  'extension-id': EXTENSION_ID_FILE,
  'tool-history': TOOL_HISTORY_FILE,
  'api-config': API_CONFIG_FILE,
  env: ENV_FILE,
  'debug-log': DEBUG_LOG,
}

/**
 * 老 JSONL 形态的聊天流在哪。
 *
 * 2026-10 目录重构之前，`receiver\inbox\chat_input.jsonl` / `chat_output.jsonl` 是在线数据；
 * 现在在线真源是 SQLite（`data\sessions\chat.db`），那两份 jsonl 已随迁移搬到
 * `data\reading\deleted-annotations.json` 之外的**备份区**，默认不生成。
 * 还在读它们的维护脚本请走这里取值——它会在缺失时给出可执行的提示，
 * 而不是抛一个 `ENOENT: receiver\inbox\...` 让人以为是路径写错了。
 *
 * @param {'input'|'output'} which
 * @returns {string} 文件路径（**不保证存在**，调用方用 requireExportedJsonl 检查）
 */
export function exportedJsonlFile(which) {
  return path.join(DATA_BACKUPS_DIR, which === 'output' ? 'chat_output.export.jsonl' : 'chat_input.export.jsonl')
}

/**
 * 取老 JSONL 聊天流；不存在就打印可执行的修复步骤并退出。
 * 用法：
 *   import { requireExportedJsonl } from '../lib/paths.js'
 *   const CHAT_IN = requireExportedJsonl('input')
 * @param {'input'|'output'} which
 */
export function requireExportedJsonl(which) {
  const p = exportedJsonlFile(which)
  if (fs.existsSync(p)) return p
  console.error(`\n✗ 找不到 ${path.basename(p)}`)
  console.error('  2026-10 目录重构后，老的两份 jsonl 已不在线（在线真源是 SQLite）。')
  console.error('  先导出一份只读副本，再重跑本脚本：')
  console.error('    node agent/scripts/export-chat.mjs')
  console.error(`  （导出位置：${DATA_BACKUPS_DIR}）\n`)
  process.exit(1)
}

