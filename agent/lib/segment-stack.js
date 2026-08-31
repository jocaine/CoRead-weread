#!/usr/bin/env node
/**
 * 会意系统 · 固化后分段（收口弹栈后的细分割，2026-08-28 用户定调）
 *
 * 实时栈分割（会话中）只做**有限判断同一性**：承接就算同一、入栈，不细究——所以
 * 同一个栈里的对话必然有思维关系（= 边），但具体问题可能随讨论发散，一个栈里可能
 * 装了几个发散的具体问题。
 *
 * 固化后分段（收口弹栈后、归纳问题前）**先判专题化，再判同一性**（顺序与实时栈
 * 不同）——把栈内发散开的具体问题细切成多个**不可分割**的讨论组：
 *   - 先判专题化：识别知识点轮次（专题化 = 有可推进内核）——它是后续判同一的对象；
 *     **无内核轮次不做过滤处理**（不滤掉、不 ignored），它们不构成知识点、不参与
 *     判同一，跟随并入当前组（2026-08-28 用户定调）
 *   - 再判同一性（分段专用口径，不复用实时栈的判同一性）：分段的前提是逻辑接续
 *     已成立（同栈内、专题化已过），要分辨的不是"是否承接"，而是**追的具体问题是
 *     否还和当前组一致**——一致入组，不一致切段开新组
 *   - 结尾：开着的组收口
 * 归纳问题发生在分段**之后**，对每个不可分割的组做（调用方职责）。
 *
 * 纯判定：callLLM 由调用方注入；不读写文件。
 */

import { judgeTopicization } from './topicize.js'
import { formatStackContext, parseSameResult, STACK_CONTEXT_ROUNDS } from './topic-stack.js'

export const MAX_ATTEMPTS = 3

// ── 分段专用判同一性（2026-08-28 用户确认的口径）────────────────────────────

// 分段判同一性标准提示词。与实时栈判同一性（buildSameProblemInstruction）的差异：
// 实时栈口径是"新消息是不是在延续当前讨论正在追的同一个问题"（承接就算同一，
// 宽松入栈）；分段口径是"承认逻辑接续已成立的前提下，追的具体问题是否还和当前
// 组一致"——由当前讨论引出的新问题（前文某个概念带出来的方向）只要不再是当前组
// 那一个具体问题，就要切段。这是分段的侧重点：分辨发散方向，不是判断承接。
export function buildSegmentSameInstruction() {
  return [
    '你是 CoRead 的「会意系统」，现在做固化后分段：把一段收口的连续讨论（同一栈内、逻辑接续已成立）细切成多个不可分割的知识点组。',
    '',
    '前提（不需要再判断）：这条新轮次与前面轮次**逻辑接续已成立**——它在同一场讨论里顺着前文推进。分段要判断的不是"是否承接"，而是"它追的具体问题是否还和当前组一致"。',
    '',
    '判断标准：新轮次追的具体问题/知识点方向，与当前组正在追的是否一致？',
    '- **一致（并入当前组）**：新轮次还在推进当前组那一个具体问题——追问细节、反驳论证、换角度检验同一问题都算推进。',
    '- **不一致（切段，开新组）**：新轮次追的具体问题变了——即使它由当前讨论引出（前文某个概念/话题带出来的新问题），只要追的不是当前组那一个具体问题，就切段。',
    '  · 例：当前组在追"庇隆主义被推翻的阶级矛盾必然性"，新轮次问"为啥拉丁美洲的资本品工业建立不起来"——由讨论引出，但追的是另一个具体问题 → 切段。',
    '  · 例：当前组在追"资本品工业建立不起来的原因"，新轮次问"剪刀差"——换了具体问题 → 切段。',
    '  · 例：当前组在追"庇隆主义如何被推翻"，新轮次追问"IAPI 失衡的阶级矛盾必然性"——还在追同一问题的深处 → 不切段。',
    '',
    '只判断"追的具体问题是否一致"。不命名、不归类、不判断有没有可推进内核（专题化在分段前已判过）。',
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"same":true}',
    '字段：same 布尔；true=一致（并入当前组），false=换了方向（切段开新组）。只输出这一个 JSON 对象，前后不要有任何字符。',
  ].join('\n')
}

// 组装分段判同一性 prompt：指令 + 当前组上下文（组首轮次锚定"当前组追的问题"，
// 最近 N 轮提供接续语境）+ 新消息。
export function buildSegmentSamePrompt(message, group) {
  const userNote = String(message.userNote || '').trim()
  const lines = [
    buildSegmentSameInstruction(),
    '',
    '当前组追的问题（组首轮次确立）：',
    formatStackContext(group.slice(0, 1)),
    '',
    `当前组最近 ${Math.min(group.length, STACK_CONTEXT_ROUNDS)} 轮：`,
    formatStackContext(group),
    '',
    `新消息："${userNote}"`,
  ]
  return lines.join('\n')
}

function errMsg(e) {
  if (e instanceof Error) return e.message || String(e)
  if (typeof e === 'string') return e
  try { return String(e || '未知错误') } catch { return '未知错误' }
}

/**
 * 分段专用判同一性：新轮次 vs 当前组——追的具体问题是否一致。
 * 与 judgeSameProblem（实时栈）同构，但用分段口径的 prompt；解析复用 parseSameResult。
 *
 * @param {object} message 新轮次：{ userNote（必填）, selected?: { text } }
 * @param {Array}  group 当前组（非空，组首轮次 = 组追的问题锚点）
 * @param {object} deps { callLLM（必填）, maxTokens?, attempts?, log? }
 * @returns {Promise<{same:boolean, attempts:number}>}
 * @throws 参数缺省 → TypeError；重试耗尽仍无有效判定 → Error
 */
export async function judgeSegmentSame(message, group, deps = {}) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('judgeSegmentSame: message 必须是消息对象')
  }
  const userNote = String(message.userNote || '').trim()
  if (!userNote) throw new TypeError('judgeSegmentSame: 需要新轮次内容（userNote 非空）')
  if (!Array.isArray(group) || group.length === 0) {
    throw new TypeError('judgeSegmentSame: 需要非空当前组——组首轮次锚定组追的问题')
  }
  const { callLLM, maxTokens = 2048, attempts = MAX_ATTEMPTS, log = () => {} } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('judgeSegmentSame: 必须注入 callLLM(prompt, maxTokens)')
  }

  const basePrompt = buildSegmentSamePrompt(message, group)
  let logReason = ''    // 最近一次失败原因：进日志、也是最终报错的内容
  let promptHint = ''   // 拼进重试 prompt 的修正提示：只在"输出非法"时写。
                        // 网络失败/⚠️ 失败串时模型没收到过上一个 prompt（或 ⚠️ 串非模型产出），
                        // 带原因重发是噪音（模型无可修正），原样重发 basePrompt。
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0 || !promptHint
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过校验（${promptHint}）。请重新输出：只给最终一行判定，不要任何推理、字数计算、示例或额外文字。`

    let text
    try {
      text = await callLLM(prompt, maxTokens)
    } catch (e) {
      // 网络失败不带修正提示——模型没收到上一个 prompt，原样重发即可。
      if (attempt === attempts - 1) {
        throw new Error(`分段判同一性 LLM 调用失败：${errMsg(e)}`, { cause: e })
      }
      logReason = `LLM 调用失败（${errMsg(e)}）`
      log(`  ⚠️ 分段判同一性调用失败 (attempt ${attempt + 1}/${attempts}): ${errMsg(e)}`)
      continue
    }

    const out = String(text || '').trim()
    if (/^⚠️/.test(out)) {
      if (attempt === attempts - 1) throw new Error(`分段判同一性 LLM 返回失败串：${out.slice(0, 60)}`)
      logReason = 'LLM 返回失败串'
      continue
    }

    const parsed = parseSameResult(out)
    if (parsed) {
      log(`  ✓ 分段判同一性（attempt ${attempt + 1}）：${parsed.same ? '一致（并入）' : '换方向（切段）'}`)
      return { same: parsed.same, attempts: attempt + 1 }
    }

    promptHint = logReason = `输出不是合法 JSON 或缺少 same 字段（${out.slice(0, 60)}）`
    log(`  ⚠️ 分段判同一性第 ${attempt + 1} 次校验未通过（${logReason}），重试...`)
  }

  throw new Error(`分段判同一性 ${attempts} 次尝试后仍无有效判定（${logReason}）`)
}

/**
 * 对弹出的栈（思维连续的段）做固化后分段。
 * @param {Array} entries 弹出的栈轮次 [{role:'user'|'assistant', content, selected?, cites?}]
 * @param {object} deps { callLLM 必填, log?, attempts?, verdictOf? }
 * @returns {Promise<{segments: Array, ignored: number, noTopicized?: boolean}>}
 *   segments: [{ entries: [{role, content, selected?}], cites: string[] }]（不可分割的讨论组）
 *   ignored：恒 0（无内核轮次不做过滤处理——有当前组则跟随并入；无当前组则挂起，
 *     等后续专题化轮次开组时并入。2026-08-28 定调 + 2026-09：命中不替代专题化判断）
 *   noTopicized：整栈没有任何专题化轮次（全部挂起）→ 零产物，调用方不保留重试
 */
export async function segmentStack(entries, deps = {}) {
  const { callLLM, log = () => {}, attempts = MAX_ATTEMPTS, verdictOf } = deps
  if (typeof callLLM !== 'function') {
    throw new TypeError('segmentStack: 必须注入 callLLM(prompt, maxTokens)')
  }
  // verdictOf（可选，离线复用）：(entry) => boolean | undefined——已判过的专题化结论
  // 直接复用（不重复调 LLM）；undefined → 走 judgeTopicization。live 路径不传，行为不变。
  if (verdictOf !== undefined && typeof verdictOf !== 'function') {
    throw new TypeError('segmentStack: verdictOf 必须是函数 (entry) => boolean | undefined')
  }
  const segments = []
  let ignored = 0
  let cur = []        // 当前组（user + assistant 轮次）
  let curCites = []   // 当前组内 user 轮次的引用（去重）
  let pending = []        // 无当前组时的非专题化挂起轮次（不独自成组，2026-09）
  let pendingCites = []   // 挂起轮次的引用（并入首个专题化组时收集）
  let sawTopicized = false  // 整栈是否有专题化轮次（无 → noTopicized，零产物不重试）
  let prevAssist = null  // 组内/栈内前一条 assistant（判专题化降级材料）

  const flush = () => {
    if (!cur.length) return
    segments.push({ entries: cur, cites: [...new Set(curCites)] })
    cur = []
    curCites = []
  }

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    if (e.role === 'assistant') {
      const content = String(e.content || '').trim()
      if (content) {
        prevAssist = { content, ...(e.selected && String(e.selected.text || '').trim() ? { selected: e.selected } : {}) }
        if (cur.length) {
          // 保留原条目的额外字段（如离线管线的 _caseId），段内条目不丢归属信息
          cur.push({ ...e, role: 'assistant', content, ...(e.selected && String(e.selected.text || '').trim() ? { selected: e.selected } : {}) })
        }
      }
      continue
    }
    const userNote = String(e.content || '').trim()
    if (!userNote) continue

    // ① 先判专题化：把内容分割成**不可分割的知识点**——专题化轮次 = 知识点，
    //    参与后续判同一（知识点之间的判定）；**无内核轮次不做过滤处理**（不滤掉、
    //    不 ignored），它们不是知识点、不参与判同一，跟随当前组。
    //    verdictOf 命中 → 复用已判结论；否则走 judgeTopicization（含降级）。
    let topicized = false
    const pre = verdictOf ? verdictOf(e) : undefined
    if (pre !== undefined) {
      topicized = pre
    } else {
      try {
        const r = await judgeTopicization(
          {
            userNote,
            ...(e.selected && String(e.selected.text || '').trim() ? { selected: e.selected } : {}),
            ...(prevAssist ? { assistantContext: prevAssist } : {}),
          },
          { callLLM, maxTokens: 2048, attempts, log },
        )
        topicized = r.topicized
      } catch (err) {
        log(`  ⚠️ 分段判专题化失败（按不专题化处理，跟随当前组）: ${err.message}`)
      }
    }

    // 保留原条目的额外字段（如离线管线的 _caseId），段内条目不丢归属信息
    const entry = { ...e, role: 'user', content: userNote, ...(e.selected && String(e.selected.text || '').trim() ? { selected: e.selected } : {}) }
    const cites = Array.isArray(e.cites) ? e.cites : []
    if (!topicized) {
      // 无内核轮次：不做过滤处理——命中不替代专题化判断（2026-09 定调）：
      // 非专题化轮次不独自成组（不构成知识点、不参与归纳问题）。有当前组 →
      // 跟随并入（只贡献 cites）；无当前组 → 挂起，等后续专题化轮次开组时并入。
      if (cur.length === 0) {
        pending.push(entry)
        pendingCites.push(...cites)
      } else {
        cur.push(entry)
        curCites.push(...cites)
      }
      continue
    }
    sawTopicized = true
    if (cur.length === 0) {
      // 专题化轮次开组：先并入挂起的非专题化跟随者（含其 cites），再做首条
      cur = [...pending, entry]
      curCites = [...pendingCites, ...cites]
      pending = []
      pendingCites = []
      continue
    }

    // ② 再判同一性（分段专用口径）：一致入组；不一致 → 当前组收口（切段完成），开新组
    let same = false
    try {
      const r = await judgeSegmentSame(
        { userNote, ...(e.selected && String(e.selected.text || '').trim() ? { selected: e.selected } : {}) },
        cur,
        { callLLM, maxTokens: 2048, attempts, log },
      )
      same = r.same
    } catch (err) {
      log(`  ⚠️ 分段判同一性失败（不切断，按一致入组）: ${err.message}`)
      same = true
    }
    if (same) {
      cur.push(entry)
      curCites.push(...cites)
    } else {
      flush()
      cur = [entry]
      curCites = cites
    }
  }
  flush()  // 结尾：开着的组收口
  return { segments, ignored, noTopicized: !sawTopicized }
}
