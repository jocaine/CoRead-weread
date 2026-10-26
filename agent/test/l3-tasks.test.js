#!/usr/bin/env node
/**
 * 课题分包（lib/l3-tasks.js）的契约测试
 *
 * 2026-10-25 定稿的语义（用户五次校准后的样子）：
 *   ① 锚点是**当前提问**（用户这一轮问的那句），不是节点里的旧问题；
 *   ② 命中层自己认「课题」= 当前提问要这条旧料在回答里**干什么**（角色 + 用哪块料），
 *      只点料不算，复述提问也不算；更早的讨论由子节点出题时把课题定好，它不再报一遍；
 *   ③ 回答是**一段话**：成果、到哪儿为止、还没定什么、你当时的态度——不分点（分点会切碎语义）；
 *   ④ **没有"覆盖"这种自评**。父节点尽可能交付；相关的东西少，就把篇幅放在"只知道这些/你当时的态度"上；
 *      确实没谈过这件事 → 第一行写「拒绝：…」，这是事实，进统计（point/alias 有问题，用户去修图谱）；
 *   ⑤ 要不要往更早找，由下一步看父节点材料开头来判断，不由节点给自己打分。
 *
 * 跑法：node agent/test/l3-tasks.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMaterials, buildDraftBrief, buildDispatchBrief, parseDraft, parseDraftTasks, buildTaskPrompt,
  parseReport, buildAggregateMessage,
  coverageRatio, checkCoverage, runTasksPipeline, TASK_LIMITS,
} from '../lib/l3-tasks.js'
import { createGraph, addNode, addEdge, userParents } from '../lib/knowledge-graph.js'
import { l3Path } from '../lib/l3-driver.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
const LIB_SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'l3-tasks.js'), 'utf8')

const NODE = (id, point) => ({
  id, point,
  discussions: [{ question: `${point}这场讨论追的问题`, excerpts: [{ q: '用户原话一句', a: 'AI 原话一句' }] }],
})

// ── 材料 / 草稿 ─────────────────────────────────────────────────────────────
test('buildMaterials：只渲染原话（point/问题/问答），不渲染 aliases', () => {
  const out = buildMaterials(NODE('n1', '方向甲'))
  assert.match(out, /〔知识点〕方向甲/)
  assert.match(out, /用户：用户原话一句/)
  assert.doesNotMatch(out, /aliases/)
})

test('buildMaterials：默认**绝不截取**（6 万字正文原样给模型）', () => {
  const big = { point: 'P', discussions: [{ question: 'Q', excerpts: [{ q: 'a'.repeat(30000), a: 'b'.repeat(30000) }] }] }
  const out = buildMaterials(big)
  assert.ok(out.length > 60000, '整段都要在，' + out.length)
  assert.doesNotMatch(out, /已截断/)
})

test('buildMaterials：超长截断并写明原文长度（截断要可见）', () => {
  const out = buildMaterials({ point: 'p', discussions: [{ question: 'q', excerpts: [{ a: 'x'.repeat(5000) }] }] }, { maxChars: 1000 })
  assert.ok(out.length < 1200)
  assert.match(out, /材料过长已截断：原文 \d+ 字符/)
})

test('buildDraftBrief：不带索引、不要求体面，只要求写得便于理解（内部工作稿，没人读）', () => {
  const out = buildDraftBrief()
  assert.doesNotMatch(out, /L3 索引/, '草稿这一步不需要索引（索引是派题用的）')
  assert.doesNotMatch(out, /方向甲/)
  assert.match(out, /没人会读它，所以不必顾虑措辞、体面、语气/)
  assert.match(out, /写清楚比写好看重要得多/)
  assert.doesNotMatch(out, /派题/, '派题是草稿之后单独一步，不塞在草稿说明里')

  assert.match(out, /越具体越好/)
  assert.doesNotMatch(out, /不确定：/, '不要自评标记')
  assert.match(out, /一个判断写一条/)
})

test('parseDraft：按【方向：】分段；认不出标记时 raw 照样可用', () => {
  const d = parseDraft('【方向：甲】\n- 要点一\n\n【方向：乙】\n- 要点二')
  assert.deepEqual(d.directions.map((x) => x.name), ['甲', '乙'])
  assert.equal(parseDraft('没有标记').directions.length, 0)
})

// ── R2 命中层：锚在"当前提问"，课题 = 角色 + 料 ────────────────────────────────
// ── R2：唯一的一种提示词（材料 + 一道题）────────────────────────────────────
test('buildTaskPrompt：材料在前、题在后；只要交付，不评价、不引申', () => {
  const out = buildTaskPrompt({
    askedBy: 'K-1', task: '用「承载三条件」量「组织是不是已经接不住」',
    material: '〔知识点〕材料正文',
  })
  assert.ok(out.indexOf('材料正文') < out.indexOf('【任务】'), '材料必须先出现：前缀一致才有缓存')
  assert.match(out, /你是这条旧讨论的登记员/)
  assert.match(out, /给你的题：『用「承载三条件」量「组织是不是已经接不住」』/)
  assert.match(out, /K-1 给这条旧讨论派了一道题/)
  assert.match(out, /不分点、不列条/)
})

test('buildTaskPrompt：先判拒绝（标准唯一），拒绝了就停笔', () => {
  const out = buildTaskPrompt({ task: 'q', material: 'm' })
  assert.match(out, /有没有一句直接谈这道题的/)
  assert.match(out, /「拒绝：这段当时谈的是<…>」/)
  assert.match(out, /不要勉强交付/)
  assert.doesNotMatch(out, /覆盖/, '不许再让模型给自己打分')
})

test('buildTaskPrompt：同一份材料、不同的题，前缀完全一致（缓存靠这个）', () => {
  const a = buildTaskPrompt({ task: '题甲', material: 'M-固定' })
  const b = buildTaskPrompt({ task: '题乙', material: 'M-固定' })
  const head = (x) => x.split('【任务】')[0]
  assert.equal(head(a), head(b))
})

test('buildDispatchBrief：派题要把节点的别名全给出来（别名就是“这块料是什么、能用它回答什么”）', () => {
  const out = buildDispatchBrief({
    points: [{ kid: 'K-1', point: '方向甲', aliases: ['哈夫纳《一个德国人的故事》：1933年前后的亲历记录', '克伦佩勒《第三帝国的语言》：逐条记录纳粹改造德语'] }],
    draft: '草稿',
  })
  assert.match(out, /哈夫纳《一个德国人的故事》/)
  assert.match(out, /克伦佩勒《第三帝国的语言》/)
  assert.match(out, /【候选材料】/) 
})

test('buildDispatchBrief：派题要同时看到提问与草稿，按「补不足 / 用旧料」两条判据派', () => {
  const out = buildDispatchBrief({ question: '我应该去看什么', points: [{ kid: 'K-1', point: '方向甲' }], version: '草稿正文：我觉得该往接住那块走' })
  assert.match(out, /【原始提问】是所有派生问题最终要辅助回答的那句话/)
  assert.match(out, /『我应该去看什么』/)
  assert.match(out, /草稿正文：我觉得该往接住那块走/)
  assert.match(out, /【原始草稿】相对【原始提问】，还差在哪一处/) 
 
  assert.match(out, /写「K-x：无」/)
  assert.match(out, /【原始草稿】这是目前对【原始提问】的第一次回答/)
  assert.match(out, /· K-1「方向甲」/)
  assert.match(out, /只许要它交自己已经说过的话|只许落在它已经说过的话上/, '题只许落在材料里已有的话上')
  assert.match(out, /<那一处没答到的> —— <用它的第几条>，要它交出能补上的那部分/)
  assert.match(out, /每条材料占一行，顺序照上面/)
})

test('流水线：派题侧写「无」→ 该节点不派、不调 R2，但 R4 照跑', async () => {
  const model = fakeModel({ draft: '【方向：甲】\n- 要点', reports: {} })
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: async (o) => {
      model.calls.push({ kind: o.kind })
      if (o.kind === '课题草稿') return '【方向：甲】\n- 要点'
      if (o.kind === '课题派题') return 'K-1：无'
      throw new Error('不该有 ' + o.kind)
    },
    stream: model.stream, log: () => {}, onEvent: (e) => events.push(e),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(model.calls.filter((c) => c.kind === '课题报告').length, 0, '派题说无就不该调 R2')
  assert.ok(events.some((e) => e.type === 'ask' && e.skipped === '用不上'))
  assert.equal(r.value, '终稿正文')
})

test('parseDraftTasks：从派题输出里取「K-1：题」；认不出就交空 Map（流水线不派）', () => {
  const d = 'K-1：用承载三条件量「是不是已经接不住」\nK-2：拿资格线当反例\n'
  const m = parseDraftTasks(d, ['K-1', 'K-2'])
  assert.match(m.get('K-1'), /量「是不是已经接不住」/)
  assert.equal(m.size, 2)
  assert.equal(parseDraftTasks('什么也没写', ['K-1']).size, 0)
  assert.equal(parseDraftTasks(d, ['K-9']).size, 0, '只认索引里出现过的编号')
  assert.equal(parseDraftTasks('K-1：无', ['K-1']).get('K-1'), '', '「无」是空串：明确不派')
})

// ── 解析 ────────────────────────────────────────────────────────────────────
test('parseReport：一段正文（题由上层给，模型写"课题："会被当噪声丢掉）', () => {
  const r = parseReport('课题：用承载三条件当尺子，判是不是已经接不住\n那次讨论把承载拆成三条，并指出缺一让另外两个退化；这个结论只到判断当下承载为止；还没定的是发证权算内部还是对外；当时的态度是接受并反复追问。', 'K-9')
  assert.equal(r.aspect, undefined, '题不再由 R2 认')
  assert.match(r.body, /缺一让另外两个退化/)
  assert.equal(r.refused, false)
})

test('parseReport：正文折行要接上；"边界：…"这类提示词规矩不许混进正文', () => {
  const r = parseReport('那次讨论先说了 A 这一段，\n接着说了 B 这一段，两段之间有因果。\n边界：只登记材料里有的。', 'K-1')
  assert.match(r.body, /A 这一段， 接着说了 B 这一段/)
  assert.doesNotMatch(r.body, /边界/)
})

test('parseReport：拒绝是事实（进统计），不是自评', () => {
  const r = parseReport('拒绝：这段当时谈的是战壕经历与修辞的关系\n那段材料里没有问到的事。', 'K-1')
  assert.equal(r.refused, true)
  assert.match(r.refuseWhy, /战壕经历/)
})

test('parseReport：既没正文也没拒绝 → null（模型跑偏了，重试）', () => {
  assert.equal(parseReport('我不太确定该说什么', 'K-1'), null)
  assert.equal(parseReport('', 'K-1'), null)
})

test('parseReport：老 JSON 输出仍然能读（课题/正文/拒绝）', () => {
  const r = parseReport(JSON.stringify({ 课题: '甲', 正文: '某说' }), 'K-1')
  assert.equal(r.body, '某说', 'JSON 里的课题也当噪声')
  assert.equal(r.body, '某说')
  assert.equal(parseReport(JSON.stringify({ 拒绝: '没谈过' }), 'K-1').refused, true)
})

// ── R4 ─────────────────────────────────────────────────────────────────────
test('buildAggregateMessage：按条列出记录；新的推进归这一轮，但要说清哪句是旧的', () => {
  const out = buildAggregateMessage({
    draft: { raw: '【方向：甲】\n- 要点' },
    reports: [{ kid: 'K-1', task: '用承载三条件量「是不是已经接不住」', body: '缺一让另外两个退化' }],
  })
  assert.match(out, /· K-1｜题：用承载三条件量「是不是已经接不住」/)
  assert.match(out, /缺一让另外两个退化/)
  assert.match(out, /新的推进由你来做/)
  assert.match(out, /不许把新判断说成"我们当时说过"/)
  // 没有题就别印「｜题：（没给题）」——终稿拿到的多半是整枝合并后的中转记录，不对应单一题
  const noTask = buildAggregateMessage({ draft: { raw: 'x' }, reports: [{ kid: 'K-2', task: '', body: '那段话' }] })
  assert.match(noTask, /· K-2\n/)
  assert.doesNotMatch(noTask, /没给题/)
})

test('coverageRatio / checkCoverage：照抄 → 1；拒绝的不算丢弃', () => {
  const body = '货币有效性与当前政权信用是一件事，流通券崩盘只是表象'
  assert.equal(coverageRatio(body, body), 1)
  assert.ok(coverageRatio('今天天气不错', body) < 0.2)
  const cov = checkCoverage(body, [{ kid: 'K-1', body }])
  assert.equal(cov.ratios.length, 1)
  assert.deepEqual(cov.dropped, [])
  const refused = checkCoverage(body, [{ kid: 'K-2', refused: true, body: '完全无关的一段' }])
  assert.equal(refused.ratios.length, 0)
})

// ── 图 ─────────────────────────────────────────────────────────────────────
test('userParents：只取 user 入边、去重、悬空边忽略、只给上一层', () => {
  const g = createGraph()
  addNode(g, { id: 'a', point: 'A' })
  addNode(g, { id: 'b', point: 'B' })
  addNode(g, { id: 'c', point: 'C' })
  addEdge(g, { from: 'a', to: 'c', kind: 'user' })
  addEdge(g, { from: 'b', to: 'c', kind: 'user' })
  addEdge(g, { from: 'b', to: 'a', kind: 'derived' })
  g.edges.push({ from: 'ghost', to: 'c', kind: 'user' })
  assert.deepEqual(userParents(g, 'c'), ['a', 'b'])
  assert.deepEqual(userParents(g, 'a'), [])
})

// ── 流水线（假模型）────────────────────────────────────────────────────────
function fakeModel({ draft, reports = {}, ask = '请说清关于这一面当时讲过什么', answer = '终稿正文' } = {}) {
  const calls = []
  const complete = async (o) => {
    const text = o.messages.map((m) => m.content).join('\n')
    calls.push({ kind: o.kind, text, system: o.system, maxTokens: o.maxTokens, thinking: o.thinking, contentOnly: o.contentOnly })
    if (o.kind === '课题草稿') return draft
    if (o.kind === '课题报告') {
      // 新提示词里不再出现节点编号（那是内部信息），按材料内容认这一枝是谁
      const kid = text.includes('更早的方向P') ? 'K-1.1' : (text.includes('方向B') ? 'K-2' : 'K-1')
      const r = reports[kid]
      if (r === undefined) throw new Error(`假模型没有 ${kid} 的登记`)
      return r
    }
    if (o.kind === '课题汇总') return '（第 N 版回答：' + text.length + ' 字输入）'
    if (o.kind === '课题派题') {
      // 第一层派题：说明里有"刚写完"（草稿）；R3 派题：说明里有"【候选】"
      if (text.includes('【原始提问】')) {
        const kids = [...text.matchAll(/^[·-] ?(K-[\d.]+)「/gm)].map((m) => m[1])
        return kids.map((k) => `${k}：草稿里「该往哪走」说得空 —— 交出这块料里关于「接住」的具体判据`).join('\n')
      }
      const kids = [...text.matchAll(/^(K-[\d.]+) 「/gm)].map((m) => m[1])
      return kids.map((k) => `${k}：${ask}`).join('\n')
    }
    throw new Error(o.kind)
  }
  const stream = async function* (o) {
    calls.push({ kind: 'R4', text: o.messages.map((m) => m.content).join('\n'), messages: o.messages })
    yield { chunk: '终稿', accumulated: answer }
  }
  return { calls, complete, stream }
}

const REP = (body = '那次讨论把承载拆成三条，并指出缺一会让另外两个退化，所以断在账本这一环最常见。') => body

function graphDeps({ parents = { A: ['P'] } } = {}) {
  const table = {}
  for (const id of ['A', 'B']) table[id] = NODE(id, `方向${id}`)
  table.P = NODE('P', '更早的方向P')
  return { nodeOf: (id) => table[id] || null, parentsOf: (id) => parents[id] || [] }
}

test('流水线：登记 → 派题 → 更早的讨论交付 → R4', async () => {
  const model = fakeModel({
    draft: '【方向：甲】\n- 要点一\n没底：旧讨论怎么说\n【课题】\n- K-1：用方向甲这块料量「要不要换路」',
    reports: { 'K-1': REP('那次讨论把承载拆成三条，缺一会让另外两个退化，所以断在账本最常见。'), 'K-1.1': REP('更早那条说得更具体：第二次凑人凑不齐，名单也留不下来，事后什么都没剩下。') },
    answer: '终稿正文',
  })
  const events = []
  const it = runTasksPipeline({
    hist: [{ role: 'user', content: '上一轮提问' }],
    persona: '【背景档案】',
    anchored: '【本轮消息】\n怎么判断组织接不住话？',
    question: '怎么判断组织接不住话？',
    hits: ['A'],
    ...graphDeps(),
    complete: model.complete,
    stream: model.stream,
    judgeSystem: '判定系统',
    log: () => {},
    onEvent: (e) => events.push(e),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '终稿正文')
  assert.deepEqual(model.calls.map((c) => c.kind), ['课题草稿', '课题派题', '课题报告', '课题派题', '课题报告', '课题汇总', 'R4'])

  const r2 = model.calls[2]
  assert.match(r2.text, /给你的题：『草稿里「该往哪走」说得空 —— 交出这块料里关于「接住」的具体判据』/)
  assert.equal(r2.thinking, false, 'R2 是机械调用：不思考')
  assert.equal(r2.contentOnly, true)
  assert.equal(model.calls[0].thinking, false, '草稿也不思考（它只是判断清单，不是回答）')
  assert.equal(model.calls[0].contentOnly, true)
  // 终稿拿到的骨架得标明"这不是回答"，否则它按汇总写
  const r4 = model.calls[6]
  assert.match(r4.text, /【草稿骨架】/)
  assert.match(r4.text, /【这次要写的是回答，不是汇总】/)
  assert.match(r2.system, /判定系统/, '判定纪律还在')
  assert.match(r2.system, /你是一条更早的讨论/, '身份写在 system 里（权威比 user 高，材料里夹的指令句盖不掉）')

  // 派题那次也一样：身份在 system，数据/判据在 user
  assert.match(model.calls[1].system, /取料员/)

  // 第 4 次调用 = K-1.1（更早那一层的交付）
  const r2b = model.calls[4].text
  assert.match(r2b, /【任务】/)
  assert.match(r2b, /给你的题：『/)

  // 第 6 次调用 = K-1 的回归合并（中转记录，不是回答）：本节点交付 + 父节点回来的那段
  const merge = model.calls[5].text
  assert.match(merge, /【本节点交出的那段话】/)
  assert.match(merge, /【更早的讨论回来这几段】/)
  assert.match(merge, /· K-1\.1/)
  assert.match(merge, /更早那条说得更具体/)
  assert.match(merge, /中转记录/)
  // 汇总走判定档：只喂要并的段落，不带人格 / 历史 / 本轮提问（2026-10-26 用户定，方案 B）
  assert.match(model.calls[5].system, /判定系统/)
  assert.match(model.calls[5].system, /你负责把几段交上来的内容并成一段中转记录/)
  assert.doesNotMatch(merge, /【背景档案】|上一轮提问|【本轮消息】/)
  assert.doesNotMatch(merge, /相处规则/)
  assert.match(merge, /不称呼读者，不做总结式收尾/)

  // 预算：每次非流式调用都得自己报（汇总曾落到兜底 1024，思考把正文挤没了）
  for (const c of model.calls.filter((x) => x.kind !== 'R4')) {
    assert.ok(Number.isFinite(c.maxTokens) && c.maxTokens > 0, `${c.kind} 没给 maxTokens`)
  }
  assert.equal(model.calls[5].maxTokens, TASK_LIMITS.reportTokens)
  assert.equal(model.calls[5].contentOnly, true, '正文空时不许把思考链当中转记录')

  // 这一轮「成功上报的来路节点」要交出去（下一轮同栈继续时继承它们重跑）。
  // 只记 depth ≥ 1 的：命中节点本身每轮由引用解析重新决定要不要跑。
  const live = events.find((e) => e.type === 'live')
  assert.ok(live, '要有 live 事件')
  assert.deepEqual(live.nodes, ['P'], 'K-1.1（depth 1、交付成功）才进 live')
})

test('流水线：拒绝 → 记统计 + 回调 + 不进汇总 + 不再往上找', async () => {
  const model = fakeModel({
    draft: '【方向：甲】\n- 要点',
    reports: {
      'K-1': REP('那次讨论把承载拆成三条，缺一会让另外两个退化，所以断在账本最常见。'),
      'K-1.1': '拒绝：这段当时谈的是战壕经历与修辞的关系',
    },
  })
  const refusals = []
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {},
    onEvent: (e) => events.push(e),
    onRefusal: (rec) => refusals.push(rec),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(refusals.length, 1)
  assert.match(refusals[0].why, /战壕经历/)
  assert.equal(refusals[0].nodeId, 'P', '要能定位到是哪个节点在吹牛')
  const rep = events.find((e) => e.type === 'report' && e.kid === 'K-1.1')
  assert.equal(rep.refused, true)
  assert.doesNotMatch(model.calls.at(-1).text, /· K-1\.1/, '拒绝的不进汇总')
  assert.equal(model.calls.filter((c) => c.kind === '课题派题').length, 2, '派题只该有两次：第一层一次 + K-1 一次（K-1.1 拒绝后不再派）')
})

test('流水线：maxDepth=0 时只跑命中层', async () => {
  const model = fakeModel({ draft: '【方向：甲】\n- 要点', reports: { 'K-1': REP() } })
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {}, opts: { maxDepth: 0 },
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.deepEqual(model.calls.map((c) => c.kind), ['课题草稿', '课题派题', '课题报告', 'R4'])
})

test('流水线：兜底闸到顶 → 不再发探索调用，但 R4 照跑', async () => {
  const model = fakeModel({ draft: '【方向：甲】\n- 要点', reports: { 'K-1': REP(), 'K-2': REP() } })
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A', 'B'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {}, opts: { maxCalls: 1 },
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  const kinds = model.calls.map((c) => c.kind)
  assert.ok(kinds.filter((k) => k === '课题报告').length <= 1, '闸到顶后不该再多跑')
  assert.equal(kinds.at(-1), 'R4')
})

test('流水线：登记不可用 → 重试一次；再不行就跳过（不阻塞 R4）', async () => {
  let n = 0
  const complete = async (o) => {
    if (o.kind === '课题草稿') return '【方向：甲】\n- 要点'
    if (o.kind === '课题派题') return 'K-1：说清这一面'
    if (o.kind === '课题报告') { n++; return '' }
    throw new Error('不该有 ' + o.kind)
  }
  const stream = async function* () { yield { chunk: 'x', accumulated: 'x' } }
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps({ parents: {} }),
    complete, stream, log: () => {}, onEvent: (e) => events.push(e),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(n, 2, '一次原始 + 一次重试')
  const rep = events.find((e) => e.type === 'report')
  assert.equal(rep.ok, false)
})

test('流水线：命中节点全不在图上 → 一次普通回复（不派课题）', async () => {
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['ghost'], nodeOf: () => null, parentsOf: () => [],
    complete: async () => { throw new Error('不该有这一步') },
    stream: async function* () { yield { chunk: 'x', accumulated: '普通回复' } },
    log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '普通回复')
})

test('流水线：R1 失败 → 退回旧的整段注入（引用轮不能没有答案）', async () => {
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: async () => { throw new Error('LLM API 500') },
    stream: async function* () { throw new Error('不该走 R4') },
    fallback: async function* () { yield { chunk: '兜底', accumulated: '兜底答案' } },
    log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '兜底答案')
})

test('流水线：用户点停止 → 抛错', async () => {
  const model = fakeModel({ draft: 'd', reports: {} })
  const err = Object.assign(new Error('用户停止了本轮回答'), { code: 'COREAD_USER_STOPPED' })
  let n = 0
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream,
    checkStop: () => { if (++n === 2) throw err },
  })
  await assert.rejects(async () => { let r = await it.next(); while (!r.done) r = await it.next() }, /用户停止了本轮回答/)
})

// ── 分流 ────────────────────────────────────────────────────────────────────
test('l3Path：五条路各就各位；tasks 没命中时不许退回 full（否则又发那 47k）', () => {
  assert.equal(l3Path('full', []), 'full')
  assert.equal(l3Path('off', ['A']), 'off')
  assert.equal(l3Path('tasks', ['A']), 'tasks')
  assert.equal(l3Path('tasks', []), 'bare')
  assert.equal(l3Path('both', ['A']), 'both')
  assert.equal(l3Path('both', []), 'full')
})

test('源码：say() 真的走新路径，旧路径一行没删，拒绝有落盘统计', () => {
  assert.match(SRC, /import \{ runTasksPipeline \} from '\.\/lib\/l3-tasks\.js'/)
  assert.match(SRC, /runTasksPipeline\(tasksDeps\)/)
  assert.match(SRC, /question: storeText \|\| userText/, '当前提问要传进去（不是节点里的旧问题）')
  assert.match(SRC, /userAncestry\(graph, seeds\)/, '旧路径的来路闭包必须保留（A/B 基线）')
  assert.match(SRC, /l3Block\(ancestry\)/)
  assert.match(SRC, /onRefusal: \(rec\) =>/)
  assert.match(SRC, /l3-refusals\.jsonl/, '拒绝要落成统计文件，用户后面去修图谱')
})

test('源码：流水线的 complete 不再给默认预算——忘了传必须当场报错', () => {
  // 2026-10-26 实跑踩过：汇总那次没传 maxTokens，落到 `|| 1024`，思考写掉 2,847 字、正文空，
  // 终稿只剩草稿。默认值把"忘了传"咽了下去，所以这里钉住它不许再回来。
  assert.doesNotMatch(SRC, /callLLM\(o\.maxTokens \|\|/, '不许再给默认 maxTokens')
  assert.match(SRC, /没给 maxTokens/, '忘了传要报错，不是悄悄换成更小的预算')
})

test('源码：跨轮继承的接线（判栈提前 → 同栈才继承 → 累积减拒绝 → 弹栈清掉）', () => {
  assert.match(SRC, /import \{ readLive, writeLive, clearLive \} from '\.\/lib\/l3-live\.js'/)
  // 累积（以前 live 过的都留着）+ 减法（这一轮被拒的去掉）——用户定"这一轮无效的不再继承"
  assert.match(SRC, /const drop = new Set\(Array\.isArray\(e\.failed\)/)
  assert.match(SRC, /writeLive\(key, keep\)/)
  assert.match(SRC, /stackDecision\.action === 'pushed' \? readLive\(key\) : \[\]/, '只有同栈继续才继承')
  // 判栈必须在 say 之前（弹栈那一轮不许继承）
  assert.ok(SRC.indexOf('await judgeStackTurn(key, stackUnit, citesFinal)') < SRC.indexOf('await say(userMsg'),
    '判栈要提到生成回答之前')
  assert.match(SRC, /clearLive\(bookKey\)/, '弹栈要把这段讨论的继承记忆清掉')
  // 图上亮的 = 本轮真正交给模型的（命中 ∪ 继承）；不再只记本轮引用命中
  assert.match(SRC, /appendGraphHit\(hitsThisRound, reason, key, msg\.timestamp\)/)
  assert.doesNotMatch(SRC, /appendGraphHit\(valid,/)
  // 判栈失败要清继承记录（说不清有没有换话题时，不带旧来路跨话题）
  assert.match(SRC, /判栈失败 → 继承记录已清/)
  // 顶层「用不上」被整轮屏蔽的节点要留日志（先只观察，不改行为）——这段在流水线里
  assert.match(LIB_SRC, /因顶层「用不上」被整轮屏蔽/)
  assert.match(LIB_SRC, /unusedHits\.add\(p\.id\)/)
  // 被拒的、以及顶层判「用不上」的，都要在 live 事件里交出来（否则集合只增不减）
  assert.match(LIB_SRC, /refused: true/)
  assert.match(LIB_SRC, /const deadNodes = new Set\(\[\.\.\.refusedNodes, \.\.\.unusedHits\]\)/)
  assert.match(LIB_SRC, /failed: \[\.\.\.deadNodes\]/)
})
