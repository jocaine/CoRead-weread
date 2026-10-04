/**
 * 原子写（2026-09-30）：给"整文件重写"类的存档加一层保护。
 *
 * 背景（2026-09-28 实例）：`fs.writeFileSync(file, …)` 是"先截断到 0 字节，再写入"。
 * chat_input.jsonl 有多个原地重写的写入方（删书 /book-delete、自由对话删除、
 * selftest 收尾 restore），而 agent 每 300ms 轮询读同一个文件——读到 0 行或半截内容时，
 * 游标被钳成 0，把 288 条旧提问重发给了模型（见 lib/inbox-dedupe.js 头部）。
 * 改成"写临时文件 + rename 替换"后，读取方要么看到旧内容、要么看到新内容，永远看不到半截。
 *
 * 同目录 rename：POSIX 上原子；Windows 上 Node 走 MoveFileEx(REPLACE_EXISTING)，
 * 目标存在时也能整体替换，但杀软/索引器短暂占用会抛 EPERM/EBUSY → 退避重试几次。
 *
 * 只做本机文件操作，不发网络请求。
 */

import fs from 'fs'
import path from 'path'

const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {}
}

/**
 * 原子替换写入：内容先落临时文件（同目录，保证 rename 不跨卷），再 rename 覆盖目标。
 * @param {string} file 目标文件
 * @param {string|Buffer} data 内容
 * @param {{retries?: number}} [opts] rename 失败重试次数（默认 4）
 * @returns {boolean} 是否成功（失败时已清理临时文件并返回 false，不抛错——存档写入不该拖垮调用方）
 */
export function writeFileAtomic(file, data, opts = {}) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : 4
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  )
  try {
    fs.writeFileSync(tmp, data)
  } catch {
    return false
  }
  for (let i = 0; i <= retries; i++) {
    try {
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      if (i === retries) {
        try { fs.unlinkSync(tmp) } catch {}
        return false
      }
      sleepSync(20 * (i + 1))
    }
  }
  return false
}
