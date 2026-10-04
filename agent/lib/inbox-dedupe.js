/**
 * 收件箱去重台账（.chat_input_replied）+ 队列游标（.chat_input_cursor）的纯逻辑
 * —— 2026-09-30 机制级修复（2026-09-28《大国大城》213 条 402 实例）。
 *
 * 那次事故是两处缺陷叠加，把 288 条旧提问重放给了模型：前 75 条余额还在、答成了重复回答；
 * 01:46:57 余额耗尽后，余下 213 条每条失败都落一个 `⚠️ LLM API 402` 气泡，散进 5 本书的历史。
 *   ① 指纹格式有歧义：写入端 `appendFileSync(fp + '\n')` 原始追加，而 fp 是
 *      `${timestamp}|${正文前 80 字}`——`[引用]《…》\n> "…"` 这类消息正文第 15~66 字就有换行，
 *      一条记录占多行；读取端 `readIfExists(file).split('\n')` 按行切，多行指纹只剩首行碎片，
 *      于是重启后（跨进程重建 Set）`Set.has(完整指纹)` 恒为 false。444 条消息里 291 条是这种
 *      多行指纹，重启后集体失守；另 153 条单行指纹安然无恙——差别只在那一个换行符。
 *   ② 游标语义把"读失败"和"值就是 0"混为一谈：`readIfExists` 把所有读错误吞成 ''，
 *      `parseInt('')` 为 NaN，兜底成 0，而 0 在业务上等于"从第 0 行重扫整个队列"；
 *      写入方原地重写（writeFileSync 先截断）造成的空窗被 300ms 轮询撞上，钳位同样写出 0。
 *
 * 修复口径：
 *   - 台账改**一行一条 JSON 记录**（换行被 JSON 转义 ⇒ 一条记录恒占一行，格式自描述）；
 *     记录带 `ok`：true = 已回复，false = 试过但失败（**仍会重试**）。旧文件启动时迁移，
 *     多行碎片按 chat_input 现有消息还原成完整指纹（消息已不在队列里的碎片无风险，丢弃即可）。
 *   - 游标读取区分"读失败（未知）"与"空文件（=0）"：未知绝不当作 0，本轮直接跳过；
 *     chat_input 读到 0 行且游标 >0 视为瞬时半截读，同样不写游标。
 *
 * 纯函数，不读写文件、不发网络请求（读文件与写回由调用方负责），便于单测。
 */

/** 消息指纹：时间戳 + 正文前 80 字（与历史格式保持一致，便于迁移）。 */
export function fingerprintOf(msg) {
  return `${(msg && msg.timestamp) || 0}|${String((msg && msg.content) || '').slice(0, 80)}`
}

/** 一条台账记录（单行 JSON；fp 里的换行会被 JSON.stringify 转义成 \\n）。 */
export function encodeRecord(fp, ok = true) {
  return JSON.stringify({ fp: String(fp), ok: ok !== false })
}

/** 把内存台账整体序列化为文件内容（迁移/裁剪时用）。 */
export function serializeFingerprints(states) {
  const lines = []
  for (const [fp, ok] of states) lines.push(encodeRecord(fp, ok))
  return lines.length ? lines.join('\n') + '\n' : ''
}

/**
 * 解析台账文件并做旧格式迁移。
 * 可识别三种行：
 *   {"fp":"…","ok":true|false} → 新格式（最后一次记录生效）
 *   "…"                        → 曾短暂用过的"一行一条 JSON 字符串"（视作已回复）
 *   其它                        → 旧格式原始追加；既可能是完整单行指纹，也可能是多行记录被切开的碎片
 * 迁移：对 chat_input 里每条**仍在队列中**的消息，若其指纹首行出现在碎片里，说明以前记过 →
 * 补回完整指纹（这是唯一能还原的路径：碎片无法自行拼回整串）。
 * @returns {{states: Map<string, boolean>, stats: {typed: number, legacy: number, restored: number}}}
 */
export function loadFingerprints(raw, messages = []) {
  const states = new Map()
  const fragments = new Set()
  let typed = 0
  let legacy = 0
  for (const line of String(raw == null ? '' : raw).split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line)
        if (o && typeof o.fp === 'string') { states.set(o.fp, o.ok !== false); typed++; continue }
      } catch {}
    }
    if (line.startsWith('"')) {
      try {
        const s = JSON.parse(line)
        if (typeof s === 'string') { states.set(s, true); typed++; continue }
      } catch {}
    }
    fragments.add(line)
    legacy++
  }
  let restored = 0
  let complete = 0
  if (legacy) {
    for (const m of messages) {
      const fp = fingerprintOf(m)
      if (states.has(fp)) continue
      if (fragments.has(fp)) { states.set(fp, true); complete++; continue }        // 旧格式里的单行完整记录
      if (fragments.has(fp.split('\n')[0])) { states.set(fp, true); restored++ }   // 旧格式的跨行记录：靠首行碎片还原
    }
  }
  return { states, stats: { typed, legacy, restored, complete } }
}

/** 该不该跳过这条消息：只有"确实回复过"（ok=true）才跳过；失败记录照旧重试。 */
export function shouldSkip(states, fp) {
  return states.get(fp) === true
}

/**
 * 游标文件内容 → 语义化结果。
 * raw 为 null（读失败/共享冲突/权限等瞬时故障）→ { ok:false }：调用方必须跳过本轮，
 * 绝不能当成 0（0 = 从第一行重扫整个队列，2026-09-28 就是这么重放 288 条的）。
 * raw 为 ''（文件不存在 = 首次运行）→ { ok:true, value:0 }。
 */
export function parseCursorRaw(raw) {
  if (raw === null || raw === undefined) return { ok: false, value: 0 }
  const v = parseInt(String(raw).trim(), 10)
  return { ok: true, value: Number.isFinite(v) ? v : 0 }
}

/**
 * 本轮该怎么处理侧栏消息队列（纯判定，调用方据 action 执行）。
 *   retry-later : 本轮什么都不做（read-failed / cursor-unknown / empty-read）
 *   clamp       : 游标确实越界（文件被删过/截断过）→ 钳到当前行数后本轮不处理（与旧行为一致）
 *   idle        : 没有新消息
 *   process     : 从 from 行开始处理
 */
export function decideCursor({ readFailed = false, cursorOk = true, cursor = 0, lineCount = 0 } = {}) {
  if (readFailed) return { action: 'retry-later', reason: 'read-failed' }
  if (!cursorOk) return { action: 'retry-later', reason: 'cursor-unknown' }
  if (lineCount === 0) {
    // 读到 0 行但游标 >0：几乎一定是写入方正在原地重写（writeFileSync 先截断）时的半截读。
    // 照旧钳位就会写出 0 → 全量重放；这里改为本轮跳过、游标不动。
    if (cursor > 0) return { action: 'retry-later', reason: 'empty-read' }
    return { action: 'idle' }
  }
  if (cursor > lineCount) return { action: 'clamp', value: lineCount, reason: 'cursor-beyond-eof' }
  if (cursor >= lineCount) return { action: 'idle' }
  return { action: 'process', from: cursor }
}

/**
 * 台账文件缺失/为空时的"种子"策略：把已有的 chat_input 消息视作"以前处理过"，避免全量重放。
 * 游标有效且 >0 时只种到游标处——游标之后的消息是**还没回答**的（agent 关机期间用户提的），
 * 不能被种子静默吞掉。
 */
export function seedPlan({ lineCount = 0, cursor = { ok: true, value: 0 } } = {}) {
  if (cursor && cursor.ok && cursor.value > 0) return { upto: Math.min(cursor.value, lineCount) }
  return { upto: lineCount }
}
