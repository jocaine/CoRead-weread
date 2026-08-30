#!/usr/bin/env node
/**
 * 母题形状：语法抽象 + 判同 + 母题派生（话题库 §5.3 / §5.4②③）单元测试 — 内置 node:test。
 * 运行：node --test test/motif-shape.test.js
 *
 * 测试口径：
 * - 抽象有损（shape 只做索引），档案无损（hits 保存原文与 fill）→ 测 abstractGrammar / fills
 * - 判同二元等价 + 对称；不确定判不同（宁漏勿误）→ 测 judgeSame / 阈值 / 判别词门槛
 * - 二次实例出生、三次实例挂钩并修正形状、出生复核桶、近失记 negatives、essence 恒为 null
 *   → 测 MotifDeriver
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_THRESHOLD,
  NEAR_MISS_FLOOR,
  normalizeQuestion,
  abstractGrammar,
  judgeSame,
  commonGrammar,
  aggregateShape,
  MotifDeriver,
} from '../lib/motif-shape.js'

// ── 归一化 ────────────────────────────────────────────────────────────────────
test('归一化：到底是→究竟，没有/不能/难以→未能，为何→为什么', () => {
  assert.equal(normalizeQuestion('到底是怎么一回事'), '究竟怎么一回事')
  assert.equal(normalizeQuestion('姿态到底算是什么'), '姿态究竟算是什么', '「到底是」不吞「算」后面的「是」')
  assert.equal(normalizeQuestion('为什么没有奏效，不能适用，难以维持'), '为什么未能奏效，未能适用，未能维持')
  assert.equal(normalizeQuestion('为何失败'), '为什么失败')
})

// ── 语法抽象 ──────────────────────────────────────────────────────────────────
test('抽象：内容进槽位、结构词保留、原文入 fills', () => {
  const g = abstractGrammar('为什么哥萨克会把苏维埃和共产党分开算？')
  assert.ok(g.tokens.includes('为什么'), '结构词「为什么」应保留')
  assert.ok(g.tokens.includes('把'), '结构词「把」应保留')
  assert.ok(g.tokens.includes('和'), '结构词「和」应保留')
  assert.ok(!g.tokens.some((t) => t.includes('哥萨克')), '内容词不应残留在语法里')
  assert.equal(g.fills.X1, '哥萨克')
  assert.equal(g.fills.X2, '苏维埃')
  assert.equal(g.fills.X3, '共产党分开')
})

test('抽象：单字结构词不拆坏内容词（中国/格里高利保持完整）', () => {
  const g = abstractGrammar('为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？')
  assert.equal(g.fills.X1, '中国', '「中」不应拆开「中国」')
  const g2 = abstractGrammar('为什么格里高利家没有被当作反革命家庭处理？')
  assert.ok(Object.values(g2.fills).some((v) => v.includes('格里高利')), '「里」不应拆开「格里高利」')
})

test('抽象：相邻内容 run 归并为一个槽位', () => {
  const g = abstractGrammar('为什么列宁分化哥萨克失败？')
  assert.ok(g.tokens.includes('为什么'))
  assert.equal(g.fills.X1, '列宁分化哥萨克失败')
})

test('抽象：形状词（母题承重词）原样保留', () => {
  const g = abstractGrammar('北欧的高福利和制度优势，究竟是靠内部制度维持的，还是完全依附于外部国际位置和条件？')
  for (const w of ['究竟', '靠', '内部', '维持', '还是', '依附', '外部']) {
    assert.ok(g.tokens.includes(w), `形状词/结构词「${w}」应保留在语法里`)
  }
})

// ── 判同 ─────────────────────────────────────────────────────────────────────
test('判同：同形状不同内容 → 判同（为什么 X 没能立住家族）', () => {
  const a = '为什么列宁最初分化哥萨克的策略没有奏效？'
  const b = '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？'
  const r = judgeSame(a, b)
  assert.equal(r.same, true, `score=${r.score} 应判同（同形状不放过）`)
  assert.ok(r.score >= DEFAULT_THRESHOLD)
})

test('判同：内容不同且形状不同 → 判不同', () => {
  const a = '为什么列宁最初分化哥萨克的策略没有奏效？'
  const c = '肖洛霍夫这样安排娜塔莉亚的死，并故意隐去她临终前对儿子说的那句话，究竟是出于什么用意？'
  const r = judgeSame(a, c)
  assert.equal(r.same, false, `score=${r.score} 应判不同`)
})

test('判同：对称性（A vs B === B vs A）', () => {
  const a = '为什么列宁最初分化哥萨克的策略没有奏效？'
  const b = '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？'
  assert.equal(judgeSame(a, b).same, judgeSame(b, a).same)
  assert.equal(judgeSame(a, b).score, judgeSame(b, a).score)
})

test('判同：不确定判不同（宁漏勿误）——近失不应误判', () => {
  // 「格里高利家没被处理」与「策略没奏效」同有 为什么/未能，但形状不同，分数在阈值下
  const r = judgeSame('为什么格里高利家没有被当作反革命家庭处理？', '为什么列宁最初分化哥萨克的策略没有奏效？')
  assert.equal(r.same, false, `score=${r.score} 应判不同（宁漏勿误）`)
  assert.ok(r.score >= NEAR_MISS_FLOOR && r.score < DEFAULT_THRESHOLD, '该对应是近失：≥近失下限且<阈值')
})

test('判同：通用骨架不误合并（协约国援助性质 vs 策略没奏效家族）', () => {
  // 只共享「X 的 Y」骨架，无共同判别词 → 判不同（防空筐）
  const r = judgeSame('协约国的援助属于什么性质？', '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？')
  assert.equal(r.same, false, `score=${r.score} 不应仅凭「X 的 Y」骨架判同`)
})

// ── 共同语法 / 槽位轨迹 ──────────────────────────────────────────────────────
test('共同语法：多次实例的 LCS 交（形状随实例收缩）', () => {
  const g1 = abstractGrammar('为什么列宁最初分化哥萨克的策略没有奏效？')
  const g2 = abstractGrammar('为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？')
  const agg = commonGrammar([g1.tokens, g2.tokens])
  assert.ok(agg.includes('为什么'), '共同语法应保留共同结构词')
  assert.ok(agg.includes('未能'), '共同语法应保留共同否定词')
  assert.ok(agg.includes('SLOT'), '共同语法应保留槽位')
  assert.ok(agg.length <= g1.tokens.length, '共同语法不应比任一实例更长')
})

test('槽位填值轨迹：同位置 SLOT 聚合出多次实例的填值', () => {
  const q1 = '为什么列宁最初分化哥萨克的策略没有奏效？'
  const q2 = '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？'
  const g1 = abstractGrammar(q1)
  const g2 = abstractGrammar(q2)
  const agg = aggregateShape([
    { _tokens: g1.tokens, fill: g1.fills },
    { _tokens: g2.tokens, fill: g2.fills },
  ])
  assert.ok(agg.grammar.length > 0)
  const allValues = Object.values(agg.slots).flat()
  assert.ok(allValues.length >= 2, '应有至少一个槽位记录了两次实例的填值轨迹')
})

// ── MotifDeriver：话题库生命周期 ──────────────────────────────────────────────
test('生命周期：首实例进桶 → 二次实例出生 → 三次实例挂钩', () => {
  const d = new MotifDeriver()
  const r1 = d.ingest({ id: 'd_a', question: '为什么列宁最初分化哥萨克的策略没有奏效？' })
  assert.equal(r1.action, 'draft', '首实例应进待归类桶')
  assert.equal(d.summary.drafts, 1)

  const r2 = d.ingest({ id: 'd_b', question: '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？' })
  assert.equal(r2.action, 'born', '二次实例应转正出生')
  assert.equal(d.summary.topics, 1)
  assert.equal(d.summary.drafts, 0, '出生后桶应清空该条目')

  const r3 = d.ingest({ id: 'd_c', question: '为什么顿河流通券的信用还不如已经倒台的克伦斯基票子？' })
  assert.equal(r3.action, 'hook', '三次实例应勾住已有话题')
  assert.equal(d.summary.topics, 1)
  assert.equal(d.topics[0].hits.length, 3)

  const t = d.topics[0]
  assert.ok(t.born.includes('二次实例'))
  assert.equal(t.essence, null, 'essence 恒为 null（裂缝的本质侧永不存储）')
  assert.ok(t.openEnd.includes('克伦斯基票子'), 'openEnd 应指向最近一次实例')
  assert.ok(t.shape.grammar.includes('为什么') && t.shape.grammar.includes('SLOT'), '形状应为共同语法（三次实例交后可能收缩掉「未能」）')
})

test('出生复核：话题出生时，桶内同形状实例补挂钩', () => {
  const d = new MotifDeriver()
  // d_a 首实例进桶；「格里高利家」与 d_a 0.29 分（低于阈值）也进桶
  d.ingest({ id: 'd_a', question: '为什么列宁最初分化哥萨克的策略没有奏效？' })
  d.ingest({ id: 'd_x', question: '为什么格里高利家没有被当作反革命家庭处理？' })
  // 合作社问题勾住桶内 d_a → 出生；复核应把桶内「格里高利家」也勾进来
  const r = d.ingest({ id: 'd_e', question: '为什么中国的合作社运动没能成功？' })
  assert.equal(r.action, 'born')
  const t = d.topics[0]
  const hooked = t.hits.map((h) => h.d)
  assert.ok(hooked.includes('d_x'), '出生复核应把桶内同形状实例补挂钩')
  assert.equal(d.summary.drafts, 0, '补挂钩后桶应清空')
  assert.equal(t.hits.length, 3)
})

test('近失：分数在 [floor, threshold) 的提问记入 negatives，不挂钩', () => {
  const d = new MotifDeriver()
  d.ingest({ id: 'd_a', question: '为什么列宁最初分化哥萨克的策略没有奏效？' })
  d.ingest({ id: 'd_b', question: '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？' })
  const r = d.ingest({ id: 'd_x', question: '为什么格里高利家没有被当作反革命家庭处理？' })
  assert.equal(r.action, 'draft', '近失不应挂钩')
  const t = d.topics[0]
  assert.ok(t.shape.negatives.some((n) => n.d === 'd_x'), '近失应记入话题 negatives')
  const n = t.shape.negatives.find((x) => x.d === 'd_x')
  assert.ok(n.score >= NEAR_MISS_FLOOR && n.score < DEFAULT_THRESHOLD)
})

test('独立母题：不同形状的二次实例各自出生为不同话题', () => {
  const d = new MotifDeriver()
  d.ingest({ id: 'd_a', question: '为什么列宁最初分化哥萨克的策略没有奏效？' })
  d.ingest({ id: 'd_b', question: '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？' })
  d.ingest({ id: 'd_c', question: '协约国的援助属于什么性质？' })
  const r = d.ingest({ id: 'd_d', question: '白军对暴动军的援助属于什么性质？' })
  assert.equal(r.action, 'born')
  assert.equal(d.summary.topics, 2, '两种形状应派生为两个话题')
  const ids = d.topics.map((t) => t.id)
  assert.equal(new Set(ids).size, 2)
})

test('序列化格式：id/born/shape{grammar,slots,negatives}/hits/openEnd/essence', () => {
  const d = new MotifDeriver()
  d.ingest({ id: 'd_a', question: '为什么列宁最初分化哥萨克的策略没有奏效？', meta: { facet: '四十' } })
  d.ingest({ id: 'd_b', question: '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？', meta: { facet: '四十' } })
  const t = d.topics[0]
  assert.deepEqual(Object.keys(t).sort(), ['born', 'essence', 'hits', 'id', 'openEnd', 'shape'].sort())
  assert.deepEqual(Object.keys(t.shape).sort(), ['grammar', 'negatives', 'slots'].sort())
  assert.deepEqual(Object.keys(t.hits[0]).sort(), ['d', 'facet', 'fill', 'question'].sort())
  assert.ok(Object.values(t.shape.slots).length > 0, '槽位轨迹应非空')
  assert.equal(t.hits[0].fill.X1, '列宁')
  assert.equal(t.hits[0].facet, '四十')
})
