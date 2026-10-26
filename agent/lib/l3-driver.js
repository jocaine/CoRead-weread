#!/usr/bin/env node
/**
 * L3 的装配层（2026-10-24）——决定"这一轮要不要带 L3、带哪一版"。
 *
 * 背景：旧路径（整条来路全量渲染）**保留不动**，新路径（课题组分包）并列加进来，
 * 两条要用同一个输入对比输出，所以"装配"这一步必须能切。
 *
 * 模式写在 `data/config/l3-mode`（一行纯文本，**每次调用现读**，改完不用重启）：
 *   full   旧路径：把 options.l3 作为一条消息插在 persona 之后（= 今天的行为，默认）
 *   tasks  新路径：R1 草稿 → 派课题 → R3 判父 → R4 汇总（实现见 lib/l3-tasks.js）
 *   off    不发 L3（用于"关掉 L3 看 miss 掉多少"的因果验证）
 *   both   两条都跑，一条给用户、一条写日志（**尚未实现**，取值先占位，暂按 full）
 *
 * 为什么缺文件/写错一律按 full：默认值必须是"今天的行为"。这类开关最阴的故障是
 * 写错一个字符就悄悄改了线上表现，而且不报错——只有把兜底压到 full 才安全。
 */
import fs from 'node:fs'
import { L3_MODE_FILE } from './paths.js'

export const L3_MODES = ['full', 'tasks', 'off', 'both']

/**
 * 读当前模式。文件缺失、为空、值不认识 → 一律 'full'。
 * @param {string} [file] 默认 data/config/l3-mode（测试可传临时文件）
 */
export function readL3Mode(file = L3_MODE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim().toLowerCase()
    if (L3_MODES.includes(raw)) return raw
  } catch {}
  return 'full'
}

/**
 * `assembleCallHist` 只实现两种形状：full / off。tasks 不走它——index.js 在装配之前就
 * 分流到 lib/l3-tasks.js 的流水线了，这里把 tasks 当 full 是**兜底语义**：万一哪里漏判了，
 * 结果是"按旧路径带上 L3"，而不是"悄悄没有 L3"。
 */
export function effectiveMode(mode) {
  return mode === 'off' ? 'off' : 'full'
}

/**
 * 这一轮走哪条路。五种返回：
 *   full   L3 按旧路径整段注入
 *   bare   不发 L3，只发历史 + 画像 + 本轮问题
 *   off    same as bare（第 0 步因果验证用；分开命名只是为了让日志说得清是"关掉"还是"没有"）
 *   tasks  走课题组分包
 *   both   两条同跑：旧路径的回答给用户看，两条终稿都进记录（对比用）
 *
 * **tasks 只在"本轮有新命中"时才跑**：栈里挂着的旧引用不重复跑一遍。理由——
 * 报告里的结论已经写进上一轮给用户的回答，那段回答就在历史里；再跑一遍等于把
 * "每轮重发"的病根换个地方长出来（旧路径正是每轮都重发那 47k）。
 * both 同理：没有新命中的话，两条路的 messages 完全一样，跑两遍纯浪费。
 */
export function l3Path(mode, hits = []) {
  const has = Array.isArray(hits) && hits.length > 0
  if (mode === 'off') return 'off'
  if (mode === 'tasks') return has ? 'tasks' : 'bare'
  if (mode === 'both') return has ? 'both' : 'full'
  return 'full'
}

/**
 * 组装发给模型的 messages：历史 + persona + [L3] + 本轮锚定消息。
 *
 * 顺序不能变（`test/l3-driver.test.js` 钉着，`l3-context.test.js` 钉渲染内容）：
 * L3 必须夹在 persona 和本轮锚定消息之间——2026-10 定调"块尾紧贴本轮问题"。
 *
 * @param {object} p {hist, persona, l3, anchored, mode}
 * @returns {Array<{role:string, content:string}>}
 */
export function assembleCallHist({ hist = [], persona = '', l3 = '', anchored = '', mode = 'full' }) {
  const l3Ctx = String(l3 || '').trim()
  const withL3 = effectiveMode(mode) !== 'off' && l3Ctx !== ''
  return [
    ...hist,
    { role: 'user', content: persona },
    ...(withL3 ? [{ role: 'user', content: l3Ctx }] : []),
    { role: 'user', content: anchored },
  ]
}
