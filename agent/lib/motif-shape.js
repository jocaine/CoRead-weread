#!/usr/bin/env node
/**
 * 会意系统 · 母题形状：语法抽象 + 判同 + 母题派生（话题库 §5.3 / §5.4②③ 的确定性原型）
 *
 * 对应设计文档（agent/topic-library-design.md）：
 * - topic.motif 的表示 = shape（形状）+ hits（实例族）+ essence（永远为 null）
 * - 动作②归类挂钩：判同 = 与话题既有 thread.question 比对；不确定判不同（宁漏勿误）
 * - 动作③派生母题：二次实例出生（转正）；三次以上实例修正形状（共同语法，即 LCS 交）；
 *   话题出生时对待归类桶做一次复核（对应文档"复核时机 = 观察推进后合适时机"）
 * - 判同的可靠性来自重复（第三次实例会再次触发），不来自单次判断质量
 *
 * 本模块是确定性原型：无 LLM 调用，词典是"结构词 + 形状词"的规则式分词，用于把
 * 「语法抽象 → 判同 → 派生/挂钩」机制落成可单测的代码骨架；真实判同的语义质量
 * 由会意系统（LLM 提示词，§5.4② 归类挂钩）承担，本模块的规则只提供机制与默认值。
 *
 * 关键口径（与用户定调一致）：
 * - 系统永远不说"这堵墙是什么"（essence 恒为 null），只说"这和那一样"（判同）。
 * - 抽象允许有损（shape 只做索引），档案必须无损（hits 保存问题原文与逐槽位 fill）。
 * - 错误不对称：漏判自愈（第三次实例重新触发），误判致命（异质合并成空筐）→ 阈值宁高勿低。
 *
 * 判同机制（确定性替代品，三项防误合并）：
 * 1. 加权 LCS：结构词精确匹配 = 1，SLOT 匹配 = SLOT_MATCH_WEIGHT（0.38）——防止
 *    通用"X 的 Y 的 Z"骨架过度计分；
 * 2. 判别词门槛：同形状还必须至少共现一个"形状词/追问信号词"（为什么/未能/究竟/
 *    维持/靠/性质/属于…），否则判不同；
 * 3. 阈值宁高勿低（默认 0.34，近失下限 0.28）——不确定判不同，近失只记 negatives。
 * 以上数值是本语料上调校的原型默认值；语义判同的最终质量由 LLM 路径承担。
 */

export const DEFAULT_THRESHOLD = 0.32 // 判同阈值：低于此判不同（宁漏勿误）
export const NEAR_MISS_FLOOR = 0.26 // 近失下限：score ∈ [floor, threshold) 记入话题 negatives
export const SLOT_MATCH_WEIGHT = 0.35 // SLOT 匹配权重（结构词精确匹配 = 1）

// ── 归一化：近义结构词统一，抽象前执行（长词在前，顺序敏感）──────────────────
// 注意：不要引入"究竟是→究竟"这类规则——它会吞掉"究竟是什么"里的"是"。
const NORMALIZE = [
  ['到底是', '究竟'],
  ['到底', '究竟'],
  ['为何', '为什么'],
  ['没有', '未能'],
  ['没能', '未能'],
  ['不能', '未能'],
  ['无法', '未能'],
  ['难以', '未能'],
  ['没法', '未能'],
]

const PUNCT = '，。？！；：、""\'\'“”‘’（）()…—·～'

// ── 结构词：句法骨架，原样保留进语法（按长度降序匹配）────────────────────────
// 注意：单字结构词只保留不会出现在内容词内部的（中/里/上/下/后/前/时/来/去/着/过/
// 由/向/出/用 会拆坏"中国/格里高利/出来"等，已剔除，其多字形式保留）。
const STRUCTURAL_WORDS = [
  '从根本上说', '换句话说', '也就是说', '总而言之', '归根结底', '说到底',
  '什么样', '怎么样', '为什么', '怎么', '什么', '如何', '怎样', '是否', '哪些', '是不是',
  '哪', '谁', '究竟', '真的', '吗', '呢', '的', '了', '在', '和', '与', '而', '但', '却',
  '就', '也', '会', '能', '可以', '由', '被', '把', '对', '从', '向', '于', '之', '其',
  '这', '那', '一个', '一种', '一', '不', '我', '你', '他', '她', '我们', '你们', '他们',
  '她们', '这种', '那样', '还', '又', '都', '只', '才', '再', '最', '很', '更', '像', '如',
  '同', '等', '吧', '啊', '呀', '嘛', '以及', '甚至', '反而', '但是', '可是', '不过',
  '其实', '原来', '明明', '竟然', '居然', '这么', '那么', '如此', '这样', '一些', '一点',
  '一段', '那些', '这个', '那个', '这些', '并', '且', '已经', '正在', '现在', '如果',
  '将', '要', '想', '认为', '觉得', '可能', '应该', '完全', '根本', '直接', '间接',
  '实际上', '事实上', '表面上', '名义上', '处于', '属于', '算', '不如', '还是', '或者',
  '或', '另外', '别的', '其他', '其余', '偏偏', '反倒', '便', '挺', '相当', '比较',
  '稍微', '有点', '太', '极', '非常', '十分', '格外', '特别', '尤其', '关于', '对于',
  '至于', '针对', '相比', '比起', '相对', '同样', '一样', '各自', '分别', '往往', '常常',
  '经常', '通常', '偶尔', '有时', '随时', '从未', '曾经', '尚未', '即将', '马上', '立刻',
  '顿时', '忽然', '突然', '渐渐', '逐渐', '慢慢', '多少', '多么', '难道', '莫非', '恐怕',
  '大概', '也许', '或许', '的确', '确实', '实在', '果然', '果真', '显然', '明显', '自然',
  '当然', '必然', '肯定', '一定', '必定', '势必', '绝对', '毫不', '丝毫', '压根', '简直',
  '就是', '便是', '亦', '而已', '罢了', '而是', '不是', '以及', '及其', '跟', '及',
  '并且', '而且', '况且', '何况', '不仅', '不但', '不光', '不只', '既然', '由于', '因为',
  '所以', '因而', '因此', '于是', '从而', '以致', '致使', '使得', '导致', '造成', '引起',
  '只要', '只有', '无论', '不管', '不论', '任凭', '哪怕', '即使', '即便', '纵然', '就算',
  '尽管', '虽然', '虽说', '固然', '除非', '则', '然后', '接着', '随后', '之后', '以后',
  '此前', '之前', '以前', '从前', '起初', '最初', '一开始', '先', '首先', '其次', '最后',
  '最终', '终于', '本质上', '说白了', '总之', '基本上', '是', '未能',
]

// ── 形状词：母题的承重词，抽象时保留原词（本语料调校的原型词典；
//    真实路径由会意系统在派生母题时按抽象层级生成，本表只是确定性的替代品）────────
const SHAPE_WORDS = [
  '立场', '姿态', '性质', '概括', '归类', '维持', '依附', '支撑', '依靠', '靠', '外部',
  '内部', '信用', '规矩', '反叛', '清算', '处理', '用意', '隐情', '区别', '不一样',
  '奏效', '适用', '酝酿',
]

// ── 判别词：判同必须共现至少一个（防"X 的 Y 的 Z"通用骨架误合并）──────────────
// 注意：为什么 在本语料里是默认提问形式（22 条里 16 条以"为什么"开头），是弱判别词；
// 它只在阈值足够高（0.30，其余"为什么"配对分数均 < 0.30）时不会放水。
const DISCRIMINATORS = new Set([
  ...SHAPE_WORDS,
  '未能', '不如', '属于', '算', '为什么',
])

// 排序：长词优先（长度降序，稳定）
const ALL_WORDS = [...SHAPE_WORDS, ...STRUCTURAL_WORDS].sort((a, b) => b.length - a.length)

// ── 归一化 ───────────────────────────────────────────────────────────────────
export function normalizeQuestion(text) {
  let s = text
  for (const [from, to] of NORMALIZE) s = s.split(from).join(to)
  return s
}

function matchWord(text, i) {
  for (const w of ALL_WORDS) {
    if (text.startsWith(w, i)) return w
  }
  return null
}

// ── 语法抽象：内容 run → SLOT，结构词/形状词/标点原样保留 ────────────────────
// 返回 { question, tokens, grammar, fills }；fills 为按出现顺序的槽位原文（X1, X2, …）。
// 相邻内容 run 归并为一个 SLOT（fills 对应合并），这是"有损抽象"的确定性版本：
// 语法只做索引与判同，原文由调用方（discussions/excerpts）无损存档。
export function abstractGrammar(question) {
  const text = normalizeQuestion(question)
  const tokens = []
  const fillTexts = []
  let i = 0
  while (i < text.length) {
    const w = matchWord(text, i)
    if (w) {
      tokens.push(w)
      i += w.length
      continue
    }
    const ch = text[i]
    if (PUNCT.includes(ch)) {
      // 标点只做切分，不进语法（句末问号等是通用噪音，不参与判同）
      i += 1
      continue
    }
    // 内容 run：直到下一个结构词/形状词/标点
    let j = i
    while (j < text.length) {
      if (matchWord(text, j)) break
      if (PUNCT.includes(text[j])) break
      j += 1
    }
    const run = text.slice(i, j)
    if (tokens[tokens.length - 1] === 'SLOT') {
      fillTexts[fillTexts.length - 1] += run // 相邻 run 归并
    } else {
      tokens.push('SLOT')
      fillTexts.push(run)
    }
    i = j
  }
  const fills = Object.fromEntries(fillTexts.map((t, idx) => [`X${idx + 1}`, t]))
  return { question, tokens, grammar: tokens.join(' '), fills }
}

function matchWeight(a, b, slotWeight = SLOT_MATCH_WEIGHT) {
  if (a === 'SLOT' && b === 'SLOT') return slotWeight
  if (a === b) return 1
  return 0
}

// ── 加权 LCS 对齐：返回 pairs [{a, b}]，a/b 为两序列下标，null 表示该侧跳过 ──
export function lcsAlign(a, b, slotWeight = SLOT_MATCH_WEIGHT) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = Math.max(
        dp[i + 1][j + 1] + matchWeight(a[i], b[j], slotWeight),
        dp[i + 1][j],
        dp[i][j + 1],
      )
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (matchWeight(a[i], b[j], slotWeight) > 0 && dp[i][j] === dp[i + 1][j + 1] + matchWeight(a[i], b[j], slotWeight)) {
      pairs.push({ a: i, b: j })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({ a: i, b: null })
      i += 1
    } else {
      pairs.push({ a: null, b: j })
      j += 1
    }
  }
  while (i < n) {
    pairs.push({ a: i, b: null })
    i += 1
  }
  while (j < m) {
    pairs.push({ a: null, b: j })
    j += 1
  }
  return pairs
}

// ── 相似度：加权 LCS 归一化，∈ [0, 1] ────────────────────────────────────────
export function tokenSimilarity(a, b, slotWeight = SLOT_MATCH_WEIGHT) {
  const pairs = lcsAlign(a, b, slotWeight)
  let weightSum = 0
  let lcs = 0
  for (const p of pairs) {
    if (p.a !== null && p.b !== null) {
      lcs += 1
      weightSum += matchWeight(a[p.a], b[p.b], slotWeight)
    }
  }
  const max = Math.max(a.length, b.length)
  return { score: weightSum / max, lcs, pairs }
}

// ── 判别词共现：同形状还必须共享至少一个形状词/追问信号词 ────────────────────
export function sharesDiscriminator(a, b) {
  const set = new Set(b)
  return a.some((t) => DISCRIMINATORS.has(t) && set.has(t))
}

// ── 判同：二元等价判断（对应 §5.4② 归类挂钩的确定性版本）──────────────────────
export function judgeSame(q1, q2, { threshold = DEFAULT_THRESHOLD, slotWeight = SLOT_MATCH_WEIGHT } = {}) {
  const g1 = abstractGrammar(q1)
  const g2 = abstractGrammar(q2)
  const { score } = tokenSimilarity(g1.tokens, g2.tokens, slotWeight)
  const same = score >= threshold && sharesDiscriminator(g1.tokens, g2.tokens)
  return { same, score, grammarA: g1.grammar, grammarB: g2.grammar }
}

// ── 共同语法：多次实例的加权 LCS 交（形状随实例收缩、修正）────────────────────
export function commonGrammar(tokensList, slotWeight = SLOT_MATCH_WEIGHT) {
  if (tokensList.length === 0) return []
  let agg = tokensList[0]
  for (let k = 1; k < tokensList.length; k++) {
    const pairs = lcsAlign(agg, tokensList[k], slotWeight)
    const next = []
    for (const p of pairs) {
      if (p.a !== null && p.b !== null) next.push(agg[p.a])
    }
    agg = next
  }
  return agg
}

// 槽位填值轨迹：对齐每个实例到共同语法，聚合同一 SLOT 位置的填值
// 返回 { grammar, slots }；slots = { S1: [...], S2: [...] }，S 序号对应共同语法中 SLOT 的出现顺序。
export function aggregateShape(hits, slotWeight = SLOT_MATCH_WEIGHT) {
  const tokensList = hits.map((h) => h._tokens)
  const grammar = commonGrammar(tokensList, slotWeight)
  const slotValues = new Map() // 共同语法中 SLOT 位置序号 → 填值列表
  for (const h of hits) {
    // token 下标 → fill 键（X1..Xn 是槽位序号，不是 token 下标）
    const slotKeyAt = new Map()
    let seq = 0
    h._tokens.forEach((t, idx) => {
      if (t === 'SLOT') {
        seq += 1
        slotKeyAt.set(idx, `X${seq}`)
      }
    })
    const pairs = lcsAlign(grammar, h._tokens, slotWeight)
    let slotSeq = 0
    for (const p of pairs) {
      if (p.a !== null && p.b !== null && grammar[p.a] === 'SLOT' && h._tokens[p.b] === 'SLOT') {
        slotSeq += 1
        const key = `S${slotSeq}`
        if (!slotValues.has(key)) slotValues.set(key, [])
        slotValues.get(key).push(h.fill[slotKeyAt.get(p.b)])
      }
    }
  }
  const slots = Object.fromEntries([...slotValues.entries()].map(([k, v]) => [k, v]))
  return { grammar: grammar.join(' '), slots }
}

// ── 话题（已转正的母题条目）──────────────────────────────────────────────────
class Topic {
  constructor({ id, born, slotWeight = SLOT_MATCH_WEIGHT }) {
    this.id = id
    this.born = born // "d_a + d_b 二次实例"
    this.hits = [] // { d, question, fill, facet, _tokens }
    this.negatives = [] // { d, question, score }
    this.essence = null // 设计纪律：裂缝的本质侧永不存储
    this.openEnd = null
    this.shape = { grammar: '', slots: {}, negatives: [] }
    this.slotWeight = slotWeight
  }

  addHit({ id, question, grammar, meta }) {
    this.hits.push({
      d: id,
      question,
      fill: grammar.fills,
      facet: meta.facet ?? null,
      _tokens: grammar.tokens,
    })
    this.#refresh()
  }

  addNegative({ id, question, score }) {
    if (!this.negatives.some((n) => n.d === id)) {
      this.negatives.push({ d: id, question, score: Math.round(score * 100) / 100 })
    }
  }

  // 判挂钩 = 与话题既有 thread.question 逐条比对取最大（对应 §5.4②：勾住已有母题）
  bestScore(grammar) {
    let best = { score: 0, against: null }
    for (const h of this.hits) {
      const { score } = tokenSimilarity(grammar.tokens, h._tokens, this.slotWeight)
      if (score > best.score) best = { score, against: h.d }
    }
    return best
  }

  #refresh() {
    const agg = aggregateShape(this.hits, this.slotWeight)
    this.shape.grammar = agg.grammar
    this.shape.slots = agg.slots
    this.shape.negatives = this.negatives
    this.openEnd = `上次停在：${this.hits[this.hits.length - 1].question}——未决`
  }

  toJSON() {
    return {
      id: this.id,
      born: this.born,
      shape: this.shape,
      hits: this.hits.map(({ d, question, fill, facet }) => ({ d, question, fill, facet })),
      openEnd: this.openEnd,
      essence: this.essence,
    }
  }
}

// ── 母题派生器：话题库（§5.3）的确定性原型 ────────────────────────────────────
// ingest 顺序即阅读顺序；首实例进待归类桶（draft），二次实例出生（born），
// 三次以上实例挂钩（hook）；话题出生时对待归类桶复核一次（勾住的实例补挂钩，
// 近失补记 negatives）；近失（score ∈ [floor, threshold)）记入话题 negatives。
export class MotifDeriver {
  constructor({ threshold = DEFAULT_THRESHOLD, nearMissFloor = NEAR_MISS_FLOOR, slotWeight = SLOT_MATCH_WEIGHT } = {}) {
    this.threshold = threshold
    this.nearMissFloor = nearMissFloor
    this.slotWeight = slotWeight
  }

  #topics = []
  #drafts = new Map() // id → { id, question, grammar, meta }
  #seq = 0

  #nextId(grammar) {
    this.#seq += 1
    const hint = SLUG_HINTS
    const keys = grammar
      .split(' ')
      .filter((t) => t !== 'SLOT' && !PUNCT.includes(t))
      .map((t) => hint[t] ?? null)
      .filter(Boolean)
      .slice(0, 2)
    return `t_${hintBase(keys.join('_')) || this.#seq}`
  }

  // 出生时对桶复核：新话题勾住桶内实例 → 补挂钩；近失 → 补记 negatives
  #recheckBucket(topic) {
    const ids = [...this.#drafts.keys()]
    const topicTokens = topic.hits.flatMap((h) => h._tokens)
    for (const did of ids) {
      const d = this.#drafts.get(did)
      if (!d) continue
      const best = topic.bestScore(d.grammar)
      if (best.score >= this.threshold && sharesDiscriminator(d.grammar.tokens, topicTokens)) {
        topic.addHit(d)
        this.#drafts.delete(did)
      } else if (best.score >= this.nearMissFloor && best.score < this.threshold) {
        topic.addNegative({ id: d.id, question: d.question, score: best.score })
      }
    }
  }

  ingest({ id, question, meta = {} }) {
    const grammar = abstractGrammar(question)
    // ① 勾已有话题
    for (const t of this.#topics) {
      const best = t.bestScore(grammar)
      if (best.score >= this.threshold && sharesDiscriminator(grammar.tokens, t.hits.flatMap((h) => h._tokens))) {
        t.addHit({ id, question, grammar, meta })
        return { action: 'hook', topic: t.id, score: Math.round(best.score * 100) / 100 }
      }
    }
    // ② 勾待归类桶 → 二次实例出生（转正）
    for (const [did, d] of this.#drafts) {
      const { score } = tokenSimilarity(grammar.tokens, d.grammar.tokens, this.slotWeight)
      if (score >= this.threshold && sharesDiscriminator(grammar.tokens, d.grammar.tokens)) {
        const t = new Topic({ id: this.#nextId(grammar.grammar), born: `${did} + ${id} 二次实例`, slotWeight: this.slotWeight })
        t.addHit({ ...d })
        t.addHit({ id, question, grammar, meta })
        this.#drafts.delete(did)
        this.#recheckBucket(t) // 出生复核：桶内其他实例若同形状，补挂钩
        this.#topics.push(t)
        return { action: 'born', topic: t.id, score: Math.round(score * 100) / 100 }
      }
    }
    // ③ 近失记入话题 negatives（宁漏勿误的痕迹）
    for (const t of this.#topics) {
      const best = t.bestScore(grammar)
      if (best.score >= this.nearMissFloor && best.score < this.threshold) {
        t.addNegative({ id, question, score: best.score })
      }
    }
    // ④ 进待归类桶
    this.#drafts.set(id, { id, question, grammar, meta })
    return { action: 'draft', topic: null, score: null }
  }

  get topics() {
    return this.#topics.map((t) => t.toJSON())
  }

  get drafts() {
    return [...this.#drafts.values()].map((d) => ({
      id: d.id,
      question: d.question,
      grammar: d.grammar.grammar,
      facet: d.meta.facet ?? null,
    }))
  }

  get summary() {
    return {
      questions: this.#topics.reduce((n, t) => n + t.hits.length, 0) + this.#drafts.size,
      topics: this.#topics.length,
      hookedHits: this.#topics.reduce((n, t) => n + t.hits.length, 0),
      drafts: this.#drafts.size,
      threshold: this.threshold,
      nearMissFloor: this.nearMissFloor,
      slotWeight: this.slotWeight,
    }
  }
}

// id 提示词转写（仅外观，真实语义 slug 由 LLM 路径生成）
const SLUG_HINTS = {
  为什么: 'why', 未能: 'not', 什么: 'what', 究竟: 'afterall', 算: 'counts',
  属于: 'belongs', 维持: 'holds', 靠: 'by', 外部: 'external', 内部: 'internal',
  立场: 'stance', 姿态: 'posture', 性质: 'nature', 区别: 'differs', 奏效: 'fails',
  酝酿: 'brews', 信用: 'credit', 处理: 'handled', 清算: 'liquidated', 反叛: 'rebels',
}
const hintBase = (s) => (s ? s.replace(/[^a-z0-9_]/g, '').slice(0, 40) : '')
