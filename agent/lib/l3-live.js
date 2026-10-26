#!/usr/bin/env node
/**
 * 「上一轮有效来路节点」的跨轮记忆（2026-10-26 用户定）。
 *
 * 为什么需要它：新路径的材料与登记**只活在这一轮**（不进历史），于是同一场讨论里的第二问之后，
 * 那几个当时真交付过料的旧节点对新路径彻底消失，只能靠上一轮回答的复述。用户定的补救：
 * **同一段讨论里，上一轮「最终成功上报」的来路节点，并在本轮命中里，针对当前提问重跑一遍。**
 *
 * 记忆只有几十字节：{ [conv]: { ts, nodes: [节点 id] } }。
 * 什么时候用：
 *   · 同一段讨论继续（栈动作 pushed）→ 读出来并进本轮命中；
 *   · 这一问导致弹栈（closed_and_pushed）、或根本没入栈（ignored）→ 不继承；
 *   · 弹栈时把这条记忆清掉（那段讨论结束了）。
 *
 * 永不抛：这份记忆读不到就当没有，绝不影响这一轮回答。
 */
import fs from 'node:fs'
import path from 'node:path'
import { RUNTIME_DIR } from './paths.js'

const FILE = path.join(RUNTIME_DIR, 'l3-live.json')

function readAll() {
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}

function writeAll(obj) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 1))
    return true
  } catch (e) {
    console.log(`  [l3-live] 写不进去（不影响本轮）：${e.message}`)
    return false
  }
}

/** 上一轮的有效来路节点（没有就返回空数组）。 */
export function readLive(conv) {
  const rec = readAll()[String(conv || '')]
  return Array.isArray(rec?.nodes) ? rec.nodes.filter((x) => typeof x === 'string' && x) : []
}

/** 记下这一轮的有效来路节点；空数组等于清掉。 */
export function writeLive(conv, nodes) {
  const key = String(conv || '')
  if (!key) return false
  const all = readAll()
  const list = (Array.isArray(nodes) ? nodes : []).filter((x) => typeof x === 'string' && x)
  if (!list.length) delete all[key]
  else all[key] = { ts: Date.now(), nodes: [...new Set(list)] }
  return writeAll(all)
}

/** 这段讨论结束（弹栈/换书）时清掉。 */
export function clearLive(conv) {
  const key = String(conv || '')
  if (!key) return false
  const all = readAll()
  if (!all[key]) return true
  delete all[key]
  return writeAll(all)
}
