#!/usr/bin/env node
/**
 * 自由对话 · 中途弹栈的旧讨论暂存（2026-11 修）
 *
 * 背景（真实事故）：读书模式里讨论栈一旦"换了问题"弹栈，当场就固化进图；自由模式不行——
 * 它的产物只在归档时生成，所以弹栈的那几段原本**只打一行日志就被丢掉**
 *（旧代码：`不固化——产物在归档时由用户勾选决定`）。后果是一场长自由对话里被判
 *"换了问题"的前半段永远进不了图，归档只收到最后留在栈里的那一段——用户看到的
 * 节点数因此偏少（实况：22 轮的一场对话只出一个节点）。
 *
 * 现在：弹栈的旧讨论按 bookKey 攒在这里，归档勾"收口进拓扑图"时逐段收口，
 * 有几段就出几个节点。不勾收口或删除对话时，暂存随对话一起作废（内容本来就要删）。
 *
 * 数据：data\sessions\free-closed-stacks.json
 *   { "<freeKey>": [ { ts: number, entries: [ { role, content, selected?, cites? } ] } ] }
 *   entries 的口径与 topic-stack.json 完全一致（含 cites）——收口链路直接吃。
 *
 * 纯文件 IO + 纯函数，无进程内状态；文件路径可注入（单测用临时目录）。
 * 与 topic-stack.json 分开存的原因：topic_stack 是 agent 内存态整份回写的，
 * 两个写入方共用一份文件会互相覆盖。
 */
import fs from 'fs'
import path from 'path'
import { FREE_CLOSED_STACKS_FILE } from './paths.js'

/** 读全部暂存。文件缺失/损坏 → 空对象（调用方按"没有暂存"处理，不抛错）。 */
export function readFreeClosedStacks(file = FREE_CLOSED_STACKS_FILE) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch { return {} }
}

/** 写全部暂存（先备份后写，与 topic_stack / 图谱同款闭环）。 */
export function saveFreeClosedStacks(all, file = FREE_CLOSED_STACKS_FILE) {
  const out = all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
    fs.writeFileSync(file, JSON.stringify(out, null, 2))
  } catch { /* 暂存失败不该影响主回复：归档时拿不到就少收一段，不致命 */ }
  return out
}

/**
 * 暂存一段弹栈讨论（只给自由对话用）。
 * @returns {number} 该对话累计攒了几段（0 = 没暂存：key/entries 不合法）
 */
export function stashFreeClosedStack(key, entries, { file = FREE_CLOSED_STACKS_FILE, now = Date.now() } = {}) {
  const k = String(key || '')
  if (!k || !Array.isArray(entries) || !entries.length) return 0
  const all = readFreeClosedStacks(file)
  const list = Array.isArray(all[k]) ? all[k] : []
  list.push({ ts: now, entries })
  all[k] = list
  saveFreeClosedStacks(all, file)
  return list.length
}

/** 取某场对话攒下的全部段（按暂存顺序 = 弹栈顺序）。没有 → []（不建键）。 */
export function closedStacksOf(key, file = FREE_CLOSED_STACKS_FILE) {
  const list = readFreeClosedStacks(file)[String(key || '')]
  return Array.isArray(list)
    ? list.filter((s) => s && Array.isArray(s.entries) && s.entries.length)
    : []
}

/** 清掉某场对话的暂存（归档/删除时调用）。返回是否真的清了东西。 */
export function dropFreeClosedStacks(key, file = FREE_CLOSED_STACKS_FILE) {
  const k = String(key || '')
  const all = readFreeClosedStacks(file)
  if (!k || !all[k]) return false
  delete all[k]
  saveFreeClosedStacks(all, file)
  return true
}
