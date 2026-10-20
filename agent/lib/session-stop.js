/**
 * 「停止当前回答」信号：这条信号是不是发给**这一轮**的（2026-11）。
 *
 * 为什么单独成一个模块：判定逻辑是纯的，能被测试钉住。留在 agent/index.js 里就只能靠人手验，
 * 而它出错时的现象很吓人 —— 用户看到的不是"停止没生效"，是"我刚问的问题凭空消失了"。
 *
 * 背景（实测到的两个坑）：
 *   ① 信号文件只按**对话**分（runtime/session-stop-<hash>.json），内容里只有一个 targetTs。
 *      原先 agent 读到就删、不问目标 —— 于是"目标那一轮早就结束/失败了"留下的过期信号，
 *      会被**下一条消息**的闸门吃掉：那条消息被整轮弃掉（提问行也删），既没有回答也没有报错。
 *      会留下过期信号的路径至少两条：模型调用失败（流循环一次都没跑，没人来消费）、
 *      以及"答案已经落库之后才点停止"。
 *   ② 修法就是认身份证：信号里的 targetTs 与这轮提问落库的 timestamp 对上才消费。
 *      （侧栏 POST /session-stop 时就带着它，见 receiver/index.js 的 /session-stop。）
 */

/**
 * @param {{targetTs?: number}|null} signal 信号文件内容（解析失败传 null）
 * @param {number} turnTs 这一轮提问落库的 timestamp
 * @returns {boolean} 该不该把它当成"停这一轮"
 */
export function stopTargetsTurn(signal, turnTs) {
  const target = Number((signal && signal.targetTs) || 0)
  const ts = Number(turnTs || 0)
  // 没带目标（老版本侧栏 / 侧栏还没拿到 POST 回执就点了停止）→ 维持原行为：照停不误。
  // 宁可多停一轮，也不能让"点了停止却什么也没发生"。
  if (!target) return true
  // 调用方不知道自己是哪一轮（_meta 记忆重写、REPL 手输）：无从比对，同样放行。
  if (!ts) return true
  return target === ts
}

/**
 * 过期信号（目标轮次比当前这条更早）= 垃圾，可以删。
 *
 * 为什么敢删：agent 是**串行**处理消息的（按 id = 落库顺序），所以目标那一轮若比当前这条更早，
 * 它早就被处理完了 —— 这条信号再也不会等到它该停的那一轮。留着只会占盘、并让下一次排查
 * 误以为"有停止在排队"。
 * @param {{targetTs?: number}|null} signal
 * @param {number} turnTs 当前正在处理的那条消息的 timestamp
 */
export function isStaleStop(signal, turnTs) {
  const target = Number((signal && signal.targetTs) || 0)
  const ts = Number(turnTs || 0)
  return !!(target && ts && target < ts)
}
