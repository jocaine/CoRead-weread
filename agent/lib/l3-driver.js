#!/usr/bin/env node
/**
 * L3 的装配层（2026-10-24）——决定"这一轮要不要带 L3、带哪一版"。
 *
 * 背景：旧路径（整条来路全量渲染）**保留不动**，新路径（课题组分包）并列加进来，
 * 两条要用同一个输入对比输出，所以"装配"这一步必须能切。
 *
 * 模式写在 `data/config/l3-mode`（一行纯文本，**每次调用现读**，改完不用重启）：
 *   full   旧路径：把 options.l3 作为一条消息插在 persona 之后（对照用，现在不走）
 *   tasks  正式路径：R1 草稿 → 派课题 → R3 判父 → R4 汇总 + 联网验证（实现见 lib/l3-tasks.js）
 *   off    不发 L3（用于"关掉 L3 看 miss 掉多少"的因果验证）
 *   both   两条都跑：新路径给用户看，旧路径另起一条气泡对照（**已经实现**，取值留着做对照实验）
 *
 * 2026-10-27 晚用户定：**切 tasks 做正式内容**，旧路径不再跑（`both` 那条对照气泡随之消失）。
 * 旧代码一行没删——把文件改回 `full` 或 `both` 就能退回去，下一句提问生效。
 *
 * 为什么缺文件/写错一律按 full：默认值必须是"能退回到已知行为"的那一档。这类开关最阴的故障是
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
 *   tasks  走课题组分包（**每轮都走**，没有命中时只是不派题，见下面的说明）
 *   both   两条同跑：旧路径的回答给用户看，两条终稿都进记录（对比用）
 *
 * **tasks 现在每轮都跑**（2026-10-27 改）：没有新命中时也走这条，只是不派题。
 *
 * 原来没有新命中就退成 bare（普通回复）。那时 tasks 只干派题一件事，退掉没什么损失。
 * 但联网验证接上之后，搜索是挂在 R1 大纲上的，而 R1 又被挂在"有命中"上——结果就是
 * **你问一个以前没读过的话题，系统连网都不查**，而那恰恰是最容易编造的一类问题。
 * 搜索不需要节点、只需要一句提问，所以这个门不该拦它。
 *
 * 代价（明确接受）：每轮多一次大纲调用（实测 4.5 秒 / 426 token）。换来的是：不管有没有
 * 旧讨论可接，这一轮都会先列判断、再拿「验」行去网上对一遍。
 *
 * both 也跟着改成每轮都跑（2026-10-27）：它是"两条同跑做对照"的模式，如果没命中时退回 full，
 * 那一轮用户看到的就只有旧路径——跟"新路径为主"直接矛盾，对照也断了一半。
 */
export function l3Path(mode, hits = []) {
  if (mode === 'off') return 'off'
  if (mode === 'tasks') return 'tasks'
  if (mode === 'both') return 'both'
  return 'full'
}

/**
 * 组装发给模型的 messages：历史 + persona + [L3] + [相处规则] + 本轮锚定消息。
 *
 * 顺序不能变（`test/l3-driver.test.js` 钉着，`l3-context.test.js` 钉渲染内容）：
 * 材料块必须夹在 persona 和相处规则之间，而相处规则紧贴本轮问题。
 *
 * 2026-10-27 用户定：相处规则从【背景档案】里拆出来，单独一条、放在提问之前。
 * 理由——它要解决的是"这次回答按什么方式来"，而【背景档案】的抬头写着
 * "不是用户本轮发言、只用于理解背景、不得转述或引用"，那是给"关于用户的资料"用的定性。
 * 一个说"不要当真"，一个说"照这个做"，套同一个框，后者必然被前者压掉。
 * 实测：只往里面加一条"多举例子"，下一轮 0 个例子——调完等于没调。
 *
 * @param {object} p {hist, persona, l3, agreement, anchored, mode}
 * @returns {Array<{role:string, content:string}>}
 */
export function assembleCallHist({ hist = [], persona = '', l3 = '', agreement = '', anchored = '', mode = 'full' }) {
  const l3Ctx = String(l3 || '').trim()
  const withL3 = effectiveMode(mode) !== 'off' && l3Ctx !== ''
  const agree = String(agreement || '').trim()
  return [
    ...hist,
    { role: 'user', content: persona },
    ...(withL3 ? [{ role: 'user', content: l3Ctx }] : []),
    ...(agree ? [{ role: 'user', content: agree }] : []),
    { role: 'user', content: anchored },
  ]
}
