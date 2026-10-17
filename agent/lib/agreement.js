#!/usr/bin/env node
/**
 * 相处规则 · 维护 ——用户对 AI 的相处要求，一份编号清单
 *
 * 落点：data\profile\agreement.md（路径真源见 lib/paths.js 的 AGREEMENT_FILE）。
 *
 * ── 为什么是"相处契约"，不是"AI 自画像"（2026-10 定调）────────────────────
 * 老设计里这份文件是"AI 自己的立场与自画像"，由会话结束固化整份重写。三个实测后果：
 *   · 固化把同一份讨论材料分别喂给 profile 与 soul 两个 prompt，两者只差一句视角
 *     → 内容必然高度重叠（健康版 soul 的「立场与原则」全是讨论中的立场，本就该在会意图里）；
 *   · 偏差自我固化：prompt 带"原内容"要求合并，写偏一次下次就以偏的版本为基准
 *     （2026-08-07 一次；2026-10-14 又一次——那次把整份冲成了 portrait.md 的副本）；
 *   · 无从核对：AI 的"立场连续性"已由会意图承担（节点不可变 + 引用时 L3 注入讨论原文），
 *     再存一份自画像是更差的重复品：无出处、会漂移、还占每轮上下文。
 *
 * 新角色只收**交互层**——AI 怎么跟用户说话、怎么纠偏、怎么陪他练（说话方式 / 互动方式 /
 * 明确不要做的事）。三层判据（2026-10 用户指出"分析方法不该算说话方式"后修正）：
 *   · 交互层：AI 怎么跟你说话、怎么相处        → **本文件**
 *   · 方法层：你怎么分析问题、怎么读文本、用什么标准判断 → portrait.md 的「知识背景与思维习惯」
 *   · 结论层：讨论出来的立场与判断             → 会意图
 * 老判据把"AI 该怎么分析"也算进"AI 该怎么做"，于是 4 条方法论（看动机也看功能、读官方研究当
 * 自辩说明书…）被错放进契约——2026-10-15 已移回画像。
 *
 * ── 谁写 ────────────────────────────────────────────────────────────────
 * **只有用户**，入口是侧栏 `/相处` 命令（见 index.js 消息循环）。AI 不写这份文件：
 * 讨论中冒出的要求不自动落盘——用户想起来就敲一条，忘了说明它没那么重要（合理的过滤，
 * 也是契约合法性的来源）。MEMORIZE 协议只服务背景画像，不再有 soul 分支。
 *
 * ── 用户说人话，AI 负责整理（2026-10 用户定调）─────────────────────────────
 * 用户不敲"加/删/改"这类命令，而是**直接说要求**："以后别老用比喻""角色扮演那两条并一下"。
 * 每一次这样的输入 = 一次判定调用（judgeLLM，temperature 0）：模型读全清单 + 用户这句话，
 * 输出**整理后的完整清单**，并报告三件事——新增了什么、合并了什么、哪里与新说的**冲突**。
 *
 * 为什么必须过一层 AI（而不是机械替换）：
 *   · 用户一句话常含多条要求，还可能顺手要求"把那两条合并"——机械替换做不到；
 *   · 重复只有语义层面能判（"别夸我"与"不要空洞鼓励"是同一条）；
 *   · 冲突不能自动裁决、但必须被看见——所以回执里单列"覆盖"，用户能改回来。
 * 收敛策略：与旧的重复 → 合并；与旧的相反 → 以用户**新说的**为准，并明确报告覆盖了哪句。
 * 机械层（parse / render / read / write / addRule）保留：格式、写盘、编号重排，以及**校验 AI 输出**
 * （空白条目、重复条目、超上限）——不合格就整份不写，宁可这次白整理一次。
 *
 * ── 膨胀怎么办 ───────────────────────────────────────────────────────────
 * 上限 MAX_RULES 条：满了**拒绝追加并提示先清理**，不静默丢弃、也不做自动压缩
 * （自动压缩就是回到"静默漂移"的老路）。
 *
 * 结构：纯函数（parse / render / add / remove / update）与文件 IO 分开——前者可单测。
 */

import fs from 'fs'
import { writeFileAtomic } from './atomic-write.js'
import { extractJsonObject } from './topicize.js'   // 判定输出解析（去围栏 + 配平截取，同其它判定模块）

/** 条目上限：满了拒绝追加（实测健康版 17 天净增约 2 条，25 条够用 8~10 个月） */
export const MAX_RULES = 25

const HEADER = [
  '# 相处规则',
  '',
  '> 用户对 AI 的相处要求（说话方式 / 互动方式 / 明确不要做的事）。',
  '> 由用户通过侧栏 /相处 命令维护——AI 不改写这份文件。',
  '',
  '',
].join('\n')

const USAGE = [
  '/相处                列出全部',
  '/相处 <直接说要求>   例：以后别老用比喻 / 我说错的时候直接说，别先夸我',
].join('\n')

/**
 * 解析清单文本 → 条目数组。只认行首的 "N. " / "N、"/ "N)" / "- " / "* "。
 * 标题行、引用块（>）、空行一律忽略。
 * @param {string} text 文件全文
 * @returns {string[]} 条目（保序；无条目返回空数组）
 */
export function parseRules(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    // 数字编号允许「3.」「3、」「3)」且点号后可有可无空格（中文习惯写「3、内容」）；
    // 短横/星号必须跟空白——否则 Markdown 分隔线 `---` 会被当成条目。
    const m = line.match(/^\s*(?:\d+\s*[.、)]\s*|[-*]\s+)(.+?)\s*$/)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * 条目数组 → 文件全文（编号每次重排，所以编号永远连续）。
 * @param {string[]} rules
 * @returns {string}
 */
export function renderRules(rules) {
  const list = (rules || []).map((r, i) => `${i + 1}. ${r}`)
  return HEADER + (list.length ? list.join('\n') + '\n' : '')
}

/** 把一条内容压成单行（侧栏消息可能带换行，多行会破坏"一行一条"） */
function oneLine(s) {
  return String(s || '').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * 追加一条（纯函数）。现在的用途是**校验 AI 的整理输出**：逐条喂进来，
 * 重复条目、空白条目、超上限都在这里被拦下——整理结果落盘前的最后一道关。
 * （/相处 没有"加/删/改"命令语法：用户直接说人话，由 organizeAgreement 整理。）
 * @returns {{ok: true, rules: string[]} | {ok: false, error: string}}
 */
export function addRule(rules, content) {
  const text = oneLine(content)
  if (!text) return { ok: false, error: '有空白条目' }
  if ((rules || []).length >= MAX_RULES) {
    return { ok: false, error: `超过 ${MAX_RULES} 条上限` }
  }
  if (rules.includes(text)) return { ok: false, error: '有条目重复' }
  return { ok: true, rules: [...rules, text] }
}

// ── 文件 IO（薄封装）────────────────────────────────────────────────────────

function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/**
 * 读清单。
 * @returns {{raw: string, rules: string[]}}
 */
export function readRules(file) {
  const raw = readRaw(file)
  return { raw, rules: parseRules(raw) }
}

/**
 * 写清单：先备份 .bak（只留最近一份），再原子替换（防半截文件被读到）。
 * @returns {boolean} 是否成功
 */
export function writeRules(file, rules) {
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak') } catch {}
  return writeFileAtomic(file, renderRules(rules))
}

// ── /相处：用户说人话，AI 整理 ──────────────────────────────────────────────
//
// 输出协议（只输出一行 JSON）：
//   { rules, added, merged, conflicts, note }
//   · rules    整理后的**完整清单**（调用方直接写盘）
//   · added    这次新增的条目
//   · merged   [{ from: [被合并掉的旧条目…], to: 合并后的条目 }]
//   · conflicts[{ old: 被覆盖的旧条目, neu: 改写后的条目 }]（键名用 neu —— new 是 JS 保留字）
//   · note     一句话说明（可空串）

function buildOrganizeInstruction() {
  return [
    '你是 CoRead 的「相处规则」维护员。这份清单是**用户对 AI 的相处要求**（说话方式、互动方式、明确不要做的事），',
    'AI 每一轮都会读到它并照着做。',
    '',
    '关键前提：**用户看不到这份清单**。他只会随口说出自己新想到的要求（一两句话，常常笼统、口语、带着当时那点情绪）。',
    '把他的话并进清单**是你的工作**：判断它跟已有条目的关系，该合并就合并、该覆盖就覆盖、该删就删。',
    '他不需要、也不会告诉你"把哪两条合并一下"——清单里有没有讲同一件事的条目，**只有你知道**。',
    '',
    '处理规则：',
    '- 逐条拆开：他一句话里可能有好几条要求，每条写成一条独立、可执行的指令（祈使式）；不加"用户希望"这类前缀，不加解释',
    '- 先判断新要求与已有条目的关系，再决定动作：',
    '  · **讲的是同一件事**（意思相同或高度重叠，哪怕措辞完全不同，例：已有"不要空洞鼓励"，他说"别老夸我"）→ **合并成一条**，保留更准确具体的措辞，绝不允许两条并存',
    '  · **同一类但有新内容**（他说的更宽、更窄，或补了一个侧面，例：已有"少用比喻"，他说"别用军事化的比喻"）→ 也合并成一条，把新内容并进去',
    '  · **意思相反**（不能同时成立，例：已有"先给结论，再给理由"，他说"先铺垫背景再下判断"）→ 以他**刚说的**为准改写该条，并在 conflicts 里报出被覆盖的旧句子',
    '  · **确实是新的** → 新增一条',
    '- 他的新要求若让某条旧条目变得多余（已经被涵盖）→ 删掉那条',
    '- 其余与这次无关的条目**原样保留**：不改措辞、不改顺序、不顺手润色',
    '- 不要新增他没说过的要求',
    '- 若他说的事清单里已经全有了（没有新内容）→ rules 原样返回、三个变化数组都留空，note 写成「这条已经在清单里了：第 N 条『那条的原文』」',
    `- 清单总数不得超过 ${MAX_RULES} 条`,
    '',
    '输出格式（只输出下面这一行 JSON，不要任何其他文字、代码块或推理过程）：',
    '{"rules":["整理后的完整清单"],"added":["新增的条目"],"merged":[{"from":["被并掉的旧条目"],"to":"并成的那条"}],"conflicts":[{"old":"被覆盖的旧条目","neu":"改写后的条目"}],"note":"一句话说明或空串"}',
    '字段说明：rules 是**整理后的完整清单**（不是增量，原样保留的条目也要写进去）；added / merged / conflicts 只记这次真正发生的变化，没有就输出空数组。',
    'note 只在"变化本身说不清楚"时才写一句（例：为什么判定他与某条是同一件事、你拿不准的地方）；能由 added / merged / conflicts 看清的，一律留空串——这句话会原样显示给用户，不要复述上面已有的内容。',
  ].join('\n')
}

/**
 * 组装整理材料。顺序：指令 → 现有清单 → 用户这次说的（判定对象在最后，同项目其它判定）。
 */
export function buildOrganizePrompt(rules, userText) {
  const list = rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '（清单现在是空的）'
  return [
    buildOrganizeInstruction(),
    '',
    `现有清单（${rules.length} 条）：`,
    list,
    '',
    '用户这次说的：',
    `"${String(userText || '').trim()}"`,
  ].join('\n')
}

/**
 * 解析整理结果。容忍前言回显/围栏/多余字段；rules 不是数组 → null。
 * 注意：rules 为空数组是**合法**的（用户可能要求清空），与"格式错"要分开。
 * @returns {{rules: string[], added: string[], merged: Array, conflicts: Array, note: string}|null}
 */
export function parseOrganizeResult(text) {
  const d = extractJsonObject(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (!Array.isArray(d.rules)) return null
  const strs = (v) => (Array.isArray(v) ? v.map((x) => oneLine(x)).filter(Boolean) : [])
  return {
    rules: strs(d.rules),
    added: strs(d.added),
    merged: (Array.isArray(d.merged) ? d.merged : [])
      .map((m) => ({ from: strs(m && m.from), to: oneLine(m && m.to) }))
      .filter((m) => m.to),
    conflicts: (Array.isArray(d.conflicts) ? d.conflicts : [])
      .map((c) => ({ old: oneLine(c && c.old), neu: oneLine(c && c.neu) }))
      .filter((c) => c.old || c.neu),
    note: oneLine(d.note || ''),
  }
}

/**
 * 整理主入口（判定调用，temperature 0 由调用方保证）。
 * @param {string[]} rules 现有清单
 * @param {string} userText 用户这次说的
 * @param {object} deps { callLLM(prompt, maxTokens) 必填, maxTokens?, attempts?, log? }
 * @returns {Promise<{rules, added, merged, conflicts, note, attempts}>}
 * @throws 未注入 callLLM / 内容为空 → TypeError；重试耗尽 → Error
 */
export async function organizeAgreement(rules, userText, deps = {}) {
  const { callLLM } = deps
  if (typeof callLLM !== 'function') throw new TypeError('organizeAgreement: 必须注入 callLLM(prompt, maxTokens)')
  const text = String(userText || '').trim()
  if (!text) throw new TypeError('organizeAgreement: 需要用户说的内容')

  const base = buildOrganizePrompt(rules, text)
  const { maxTokens = 4096, attempts = 3, log = () => {} } = deps
  let reason = ''
  for (let i = 0; i < attempts; i++) {
    const prompt = i === 0 ? base
      : `${base}\n\n上一次输出未通过校验（${reason}）。请重新只输出那一行 JSON，不要任何其他文字。`
    let out
    try {
      out = await callLLM(prompt, maxTokens)
    } catch (e) {
      reason = `调用失败（${(e && e.message) || e}）`
      log(`  ⚠️ 相处规则整理第 ${i + 1} 次调用失败：${reason}`)
      continue
    }
    const parsed = parseOrganizeResult(out)
    if (parsed) return { ...parsed, attempts: i + 1 }
    reason = `不是合法 JSON 或缺 rules 数组（${String(out || '').slice(0, 60)}）`
    log(`  ⚠️ 相处规则整理第 ${i + 1} 次校验未过：${reason}`)
  }
  throw new Error(`相处规则整理 ${attempts} 次尝试后仍无有效结果（${reason}）`)
}

// ── 回执与入口 ──────────────────────────────────────────────────────────────

function listReply(rules) {
  const head = rules.length
    ? `【相处规则】${rules.length} 条 / 上限 ${MAX_RULES}`
    : `【相处规则】还没有条目 / 上限 ${MAX_RULES}`
  const body = rules.length ? '\n\n' + rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : ''
  return `${head}${body}\n\n${USAGE}`
}

/**
 * 整理回执。原则（2026-10 用户要求）：**只说这次发生了什么**——
 * 每次贴一遍全清单和用法是噪音，要看全部他敲 /相处 就行。
 */
function renderReceipt(before, r) {
  const head = before.length === r.rules.length
    ? `✅ 相处规则已更新（${r.rules.length} 条）`
    : `✅ 相处规则已更新：${before.length} 条 → ${r.rules.length} 条`
  const lines = [head]
  if (r.added.length) {
    lines.push('', '新增：')
    for (const a of r.added) lines.push(`· ${a}`)
  }
  if (r.merged.length) {
    lines.push('', '合并：')
    for (const m of r.merged) lines.push(`· ${m.from.map((f) => `「${f}」`).join(' ＋ ')} → 「${m.to}」`)
  }
  if (r.conflicts.length) {
    lines.push('', '⚠️ 覆盖（与你这次说的冲突，已按新说的为准；要留旧的就说一声）：')
    for (const c of r.conflicts) lines.push(`· 旧：${c.old}`, `  新：${c.neu}`)
  }
  if (r.note) lines.push('', r.note)
  return lines.join('\n')
}

/**
 * 处理一条 /相处 参数，返回给用户看的回执（调用方把它当系统消息写回侧栏）。
 * - 无参数 → 只列清单（不调 LLM）
 * - 有参数 → 走 organizeAgreement 整理（用户说人话，AI 负责总结/合并/报冲突）
 * @param {string} arg 命令后的内容（空 = 只列清单）
 * @param {string} file 清单文件路径（AGREEMENT_FILE）
 * @param {object} deps { callLLM, maxTokens?, attempts?, log? }——有参数时必填 callLLM
 * @returns {Promise<{reply: string}>}
 */
export async function handleCommand(arg, file, deps = {}) {
  const { raw, rules } = readRules(file)
  const a = String(arg || '').trim()

  if (!a) return { reply: listReply(rules) }

  // 安全阀：文件里有内容却解析不出条目 = 旧版散文格式（不是清单）。
  // 此时任何写入都会把原内容整份覆盖，所以先拒绝，等一次性清洗做完再改。
  if (raw.trim() && !rules.length) {
    return {
      reply: '⚠️ 现有 agreement.md 不是条目清单（是旧版的散文格式），未做任何改动。\n' +
        '需要先清洗成清单（一次性），之后 /相处 才能改。',
    }
  }

  let r
  try {
    r = await organizeAgreement(rules, a, deps)
  } catch (e) {
    return { reply: `⚠️ 整理失败，文件未改动：${(e && e.message) || e}` }
  }

  // 用机械层过一遍 AI 的输出：空白条目、重复条目、超上限都在这里拦下——
  // 任何一条不合格就**整份不写**（宁可这次白整理，也不能把坏清单落盘）。
  let acc = []
  for (const rule of r.rules) {
    const res = addRule(acc, rule)
    if (!res.ok) {
      return { reply: `⚠️ 整理结果没通过校验（${res.error}），文件未改动。\n换种说法再说一次。` }
    }
    acc = res.rules
  }

  // 清单没变（他说的事已经在清单里了）→ 不写盘：写盘会覆盖 .bak，而这次没有任何改动。
  // 回执也只回一句（note 里模型会写清"第几条已经是这条"），不再重复贴清单。
  const unchanged = acc.length === rules.length && acc.every((r, i) => r === rules[i])
  if (unchanged) {
    return { reply: r.note || `清单没有变化（${rules.length} 条）` }
  }

  if (!writeRules(file, acc)) return { reply: '⚠️ 写入失败（文件被占用？），未改动。' }
  return { reply: renderReceipt(rules, { ...r, rules: acc }) }
}
