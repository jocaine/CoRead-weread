/**
 * agent 的"身份应答"（2026-11）—— 单实例管道兼职"问话"通道。
 *
 * 背景：agent 用一个**全机唯一**的命名管道（\\.\pipe\CoReadAgent）做单实例锁：谁先绑上谁
 * 占着，第二个 agent 绑不上就自己退出（见 index.js 头部那段）。锁本身是可靠的，但托盘此前
 * **问不出任何东西** —— 它只能靠 ① 自己启动时留下的进程手柄 ② 扫全机找"长得像的"进程，
 * 两者都有盲区：
 *   · 上一班托盘留下的 agent（托盘被任务管理器结束过）→ 托盘看不见，状态瞎报"已停止"，
 *     还每 30 秒白拉一个（新 agent 撞锁即退，只刷日志）；
 *   · 另一份 CoRead 文件夹（或另一份旧版本）的 agent 占着锁 → 同样看不见。
 * 于是"托盘说没运行、插件却还能用"这类报告，从日志里根本查不出来。
 *
 * 现在：有人拨号进来，回一行 JSON 再挂断 —— 托盘拨一次就知道"有没有 agent、是不是它那一份"：
 *     {"role":"coread-agent","v":1,"pid":1234,"root":"D:\\CoRead"}
 *
 * 为什么"占线"能当权威判据：那个名字全机唯一，拨得通 = 一定有进程占着它；而唯一会来占这个
 * 名字的就是 agent 自己。回话里的 root（包根）用来分辨"我们这一份"还是"另一份安装"。
 *
 * ⚠️ 协议要与 installer/launcher/tray.ps1 的 Get-AgentPipeInfo 逐字对齐：role / v / pid /
 *    root 四个字段、一行 JSON、以 \n 结束。这条跨语言契约有测试盯着：
 *    agent/test/agent-pipe-protocol.test.js。改一边就必须改另一边 —— 对不上的后果是托盘
 *    把它当成"占着号但不答话"，退回旧行为（状态又说不清了）。
 *
 * ⚠️ 本模块**不许有副作用**（不绑管道、不读文件、不打印）：测试直接 import 它。
 */

/** 单实例锁 / 身份应答共用的那个管道名（不带会话前缀 = 全机唯一）。 */
export const AGENT_PIPE_NAME = '\\\\.\\pipe\\CoReadAgent'

/** 应答格式的版本号。将来字段有变就加一，托盘据此分辨对面是新版还是旧版。 */
export const AGENT_HELLO_VERSION = 1

/** 应答里的角色标识：托盘用它确认"对面是 CoRead 的 agent"，而不是别的程序占了这个名字。 */
export const AGENT_ROLE = 'coread-agent'

/** 包根路径的规范形式：去掉结尾的分隔符。托盘那边做同样的处理再比对（见 Test-SamePath）。 */
export function normalizeRoot(p) {
  return String(p == null ? '' : p).replace(/[\\/]+$/, '')
}

/** agent 的自我介绍：一行 JSON，\n 结尾（托盘按行读）。 */
export function agentHelloLine(root, pid = process.pid) {
  return JSON.stringify({
    role: AGENT_ROLE,
    v: AGENT_HELLO_VERSION,
    pid,
    root: normalizeRoot(root),
  }) + '\n'
}

/**
 * 挂到 net.createServer 的连接回调上：说一句再挂断。
 *
 * ⚠️ 必须给 socket 挂 error 处理：对端读完就断开、或连上立刻走人时，不挂会让 agent 抛出
 *    未处理的 'error' 事件直接崩掉 —— 为了回一句话把整个引擎搞崩，不值当。
 */
export function serveHello(sock, root) {
  try { sock.on('error', () => {}) } catch {}
  try {
    sock.end(agentHelloLine(root))
  } catch {
    try { sock.destroy() } catch {}
  }
}
