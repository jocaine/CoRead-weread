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
  stripVerify, parseVerifyLines,
  parseReport, buildAggregateMessage,
  coverageRatio, checkCoverage, renumberCitations, runTasksPipeline, TASK_LIMITS,
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

test('buildDraftBrief：机械档填空——先搭骨架，末尾附待查；不看命中标题', () => {
  const out = buildDraftBrief()
  assert.match(out, /不必顾虑措辞/)
  assert.match(out, /搭一张内部草稿/)
  assert.match(out, /不是写回答/)
  assert.doesNotMatch(out, /这一轮能接上的旧讨论/, '2026-10-29 起 R1 不看命中标题；派题那一步自己看候选目录')
  assert.doesNotMatch(out, /K-1/, '不把内部编号带进 R1')
  assert.doesNotMatch(out, /派题/, '派题是草稿之后单独一步，不塞在草稿说明里')
  assert.match(out, /这道汤/, '形状例子必须换话题')
  assert.match(out, /验：/, '"验"这一行是给搜索用的验证清单')
  assert.match(out, /待查/, '验和链拆开：末尾单独一块待查')
  assert.match(out, /一条一行/, '待查按事实逐条写')
  assert.match(out, /总：/, '骨架的第一行是总判断')
  assert.match(out, /第1步：/)
  assert.match(out, /收：/, '骨架最后一行是收口')
  assert.match(out, /几步/)
  assert.match(out, /步数由这一问的转折数决定/, '步数由内容决定，不设目标')
  assert.match(out, /不设目标/)
  assert.match(out, /只有真的多一个转折，才新开一步/, '覆盖优先并进现有步，不靠加步')
  assert.match(out, /写完删一遍/, '删冗余步、拆塞了两转折的步')
  assert.match(out, /写完对一遍提问/, '覆盖检查：问到的面 + 每个事实都有待查')
  assert.match(out, /不强求所有问题都写成一条已确定的因果链/)
  assert.match(out, /只输出下面这些行/)
  assert.doesNotMatch(out, /只输出编号的行/, '旧形状：一串编号判断，已被骨架取代')
  assert.doesNotMatch(out, /不确定：/, '不要自评标记')
})

test('buildDraftBrief：继承上一轮的主线，接着说时不要重头再来', () => {
  const out = buildDraftBrief()
  assert.match(out, /用户说"继续说\/然后\/接着"时/)
  assert.match(out, /从上一轮停下的地方开始/)
  assert.match(out, /前面已经立住一条主线时/)
  assert.match(out, /步数由这一问的转折数决定/)
})

test('buildDraftBrief：画像只用来定怎么搭，不决定搭什么；长期议题不是题目', () => {
  const out = buildDraftBrief()
  assert.match(out, /画像只用来定怎么搭/)
  assert.match(out, /他的逻辑偏好、理论背景、思维习惯/)
  assert.match(out, /长期议题只当背景/)
  assert.match(out, /不要围绕它们写/)
  assert.match(out, /题目永远是下面这条提问/)
})

test('stripVerify / parseVerifyLines：待查块不进派题，单独抽给联网验证', () => {
  const draft = [
    '总：判断甲',
    '第1步：乙',
    '第2步：丙',
    '收：丁',
    '待查：',
    '验：征地补偿按什么口径',
    '验：招拍挂是哪一年',
  ].join('\n')
  const clean = stripVerify(draft)
  assert.match(clean, /判断甲/)
  assert.doesNotMatch(clean, /征地补偿按什么口径/, '验行必须从派题输入里剥掉')
  assert.doesNotMatch(clean, /招拍挂是哪一年/, '验行必须从派题输入里剥掉')
  assert.doesNotMatch(clean, /待查/, '待查表头也剥掉——派题只需要看链条')

  assert.deepEqual(parseVerifyLines(draft), ['征地补偿按什么口径', '招拍挂是哪一年'])
  assert.deepEqual(parseVerifyLines('总：甲\n待查：无'), [], '「待查：无」不算')

  const brief = buildDispatchBrief({ question: '问题', points: [{ kid: 'K-1', point: '点' }], version: draft })
  assert.doesNotMatch(brief, /征地补偿按什么口径/, '派题看不到验行，否则会以为缺口已写明')
  assert.match(brief, /判断甲/)
})

test('parseDraft：解析【总/第N步/收】骨架；方向分段保留兼容', () => {
  const d = parseDraft('总：甲\n第1步：乙\n   验：无\n第2步：丙\n   验：无\n收：丁')
  assert.equal(d.thesis, '甲')
  assert.deepEqual(d.steps, ['乙', '丙'])
  assert.equal(d.closing, '丁')
  const alt = parseDraft('总判断：甲\n第1步：乙\n收口：丙')
  assert.equal(alt.thesis, '甲', '模型写成「总判断」也要认')
  assert.equal(alt.closing, '丙', '模型写成「收口」也要认')
  const legacy = parseDraft('【方向：甲】\n- 要点一\n\n【方向：乙】\n- 要点二')
  assert.deepEqual(legacy.directions.map((x) => x.name), ['甲', '乙'])
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
  assert.match(out, /【候选目录】/)
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
  assert.match(out, /<那一处没答到的>，要它交出能补上的那部分/)
  assert.doesNotMatch(out, /第几条/, '派题不再按编号点候选：题面里引「第几条」对旧讨论是空指针')
  assert.match(out, /题里不要出现条目编号/, '题面本身也不许出现第几条：被问的那条讨论看不到目录')
  assert.match(out, /每条候选占一行，顺序照上面/)
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
  assert.match(out, /哪句是你现在的判断/)
  assert.match(out, /草稿和【史料记录】对不上时，记录是对的/, '能推翻草稿的是史料记录')
  // 2026-10-29：草稿的链是假设，不是判决；R4 先串联、再检验，允许改一环/换总判断
  assert.match(out, /草稿的链是假设，不是判决/)
  assert.match(out, /站得住就顺着写/)
  assert.match(out, /哪一环站不住就改哪一环/)
  assert.match(out, /缺一环就补一环/)
  assert.match(out, /总判断被事实推翻就换总判断/)
  assert.match(out, /每一步接住上一步/, '每一步要接住上一步，不是并列的小节')
  assert.match(out, /允许比较多种解释或分别讨论不同观点/)
  assert.match(out, /不许说"两类"列五类/, '实测踩过的坑：开头说两类、下面列五类')
  // 材料是证据不是清单；事实能推翻推理，不许把事实压小
  assert.match(out, /材料是证据，不是清单/)
  assert.match(out, /只用在支撑或推翻某一步的地方/)
  assert.match(out, /先信事实再改推理/)
  assert.match(out, /不许为了保住原结论把事实说小/)
  assert.match(out, /记录和搜索里明确的事实对不上时，以事实为准/, '事实层级：明确事实 > 归纳 > 草稿')
  // 正文只写改后的论证，不写过程话
  assert.match(out, /正文只写改后的论证/)
  assert.match(out, /不写"草稿\/原来\/我改了"/)
  assert.match(out, /上一轮已经说过的只当已完成的步骤/, '接着说时不要重头再讲')
  // 2026-10-29 用户纠正：画像只用来定详略/切入，不是题目；不要为了贴合它改判断
  assert.match(out, /画像只用来定详略和切入/)
  assert.match(out, /草稿末尾的「待查」是查询清单，不是正文/, '待查不能当内容的写进回答')
  assert.match(out, /不要为了贴合它把判断改成它想听的/)
  // 没联网的回合：整块搜索结果（数据 + 用法说明）一起消失，一个字都不提
  // 2026-10-27 修：原来用法说明是无条件打印的，会指向一块没印出来的材料
  assert.doesNotMatch(out, /搜索结果/, '没查到就连"搜索结果"这个词都不该出现')
  assert.doesNotMatch(out, /校准用的材料/)
  assert.doesNotMatch(out, /就先按它来/, '不再把搜索结果当更高一级的事实源')
  assert.match(out, /别凭印象补一个数/, '没联网时也要管住编数')

  const withSearch = buildAggregateMessage({
    draft: { raw: 'x' }, reports: [],
    search: '· 1986 年《土地管理法》首次规定集体土地不得出让（来源：全国人大）',
  })
  assert.match(withSearch, /【搜索结果】（/, '联网了才印这一块')
  assert.match(withSearch, /全国人大/, '出处要原样带进去')
  assert.equal((withSearch.match(/【搜索结果】/g) || []).length, 1, '只有材料块用方头括号起头，用法说明改成句子——不然看着像两个块')
  // 2026-10-27 晚用户定：终稿里材料占的篇幅打断了阅读，正文改成主干逻辑 + 一个可点开的编号。
  // 所以"把是谁说的写进话里"这条旧规则被撤销了——它在逼模型把出处名、年份堆进正文。
  assert.match(withSearch, /搜索结果是\*\*凭据\*\*，不是要转述的内容/, '材料是凭据不是内容（2026-10-27 晚用户定）')
  assert.match(withSearch, /它不替你决定判断，但会改事实/, '搜索不决定判断，但事实能改推理（2026-10-29）')
  assert.match(withSearch, /先信事实，再改推理/, '事实与推理冲突时，事实优先')
  assert.match(withSearch, /就在那句话后面打一个 \[编号\]/, '用到了材料就在该处打编号，原话折在编号后面')
  assert.match(withSearch, /同一处判断只打一次/, '同一处判断不重复打')
  assert.match(withSearch, /不同判断可以重复引同一条材料/, '同一材料支撑两处判断时，可以重复引')
  assert.doesNotMatch(withSearch, /一条材料只在一个地方打一次/, '旧的“一条材料只打一次”已放宽')
  assert.match(withSearch, /不用把出处名、机关名、年份写进去/, '出处名、年份不再写进正文')
  assert.doesNotMatch(withSearch, /把是谁说的写进话里/, '旧规则已撤销，别再回来')
  assert.doesNotMatch(withSearch, /分得出两种话/, '有编号没编号本身就是区分，不用再让正文解释一遍')
  assert.match(withSearch, /可以照用，不必因为这一轮没再查到/, '上一轮查实的，下一轮要敢接着用')
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

test('renumberCitations：编号按正文出现先后重排，没引用的材料不进清单', () => {
  const items = [{ n: 1, title: 'A' }, { n: 2, title: 'B' }, { n: 5, title: 'C' }, { n: 7, title: 'D' }]
  // 模型先写 [2] 再写 [1]（实跑 2026-10-27 19:15 那轮就是这样）
  const r = renumberCitations('先[2]，再[1]，又[2]，最后[5][7]，编的[9]。', items)
  assert.equal(r.text, '先[1]，再[2]，又[1]，最后[3][4]，编的[9]。')
  assert.deepEqual(r.items.map((i) => [i.n, i.title]), [[1, 'B'], [2, 'A'], [3, 'C'], [4, 'D']])
  // 一条都没引用：清单为空（不该把整块材料塞进消息 payload）
  assert.deepEqual(renumberCitations('没有引用任何材料', items).items, [])
  // 认不出的编号不动，原来的数字也不动（没有材料可换号）
  assert.equal(renumberCitations('甲[9]乙', items).text, '甲[9]乙')
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
// dispatchSkip：顶层派题时对这几条写「无」（= 这一轮判它「用不上」），用来验图命中清单的过滤。
function fakeModel({ draft, reports = {}, ask = '请说清关于这一面当时讲过什么', answer = '终稿正文', hooks = {}, dispatchSkip = [] } = {}) {
  const calls = []
  const skip = new Set(dispatchSkip)
  const complete = async (o) => {
    const text = o.messages.map((m) => m.content).join('\n')
    calls.push({ kind: o.kind, text, system: o.system, maxTokens: o.maxTokens, thinking: o.thinking, contentOnly: o.contentOnly })
    if (o.kind === '课题草稿') return draft
    if (o.kind === '课题报告') {
      // 新提示词里不再出现节点编号（那是内部信息），按材料内容认这一枝是谁
      const kid = text.includes('再早的方向G') ? 'K-1.1.1'
        : text.includes('更早的方向P') ? 'K-1.1'
          : (text.includes('方向B') ? 'K-2' : 'K-1')
      const r = reports[kid]
      if (r === undefined) throw new Error(`假模型没有 ${kid} 的登记`)
      return r
    }
    if (o.kind === '课题汇总') return '（第 N 版回答：' + text.length + ' 字输入）'
    if (o.kind === '课题派题') {
      // 用来验"搜索与派题并行"：派题跑的时候搜索应该还挂着没回来（见下面的并发测试）
      if (typeof hooks.onDispatch === 'function') hooks.onDispatch(text)
      // 第一层派题：说明里有"刚写完"（草稿）；R3 派题：说明里有"【候选】"
      if (text.includes('【原始提问】')) {
        const kids = [...text.matchAll(/^[·-] ?(K-[\d.]+)「/gm)].map((m) => m[1])
        return kids.map((k) => skip.has(k) ? `${k}：无` : `${k}：草稿里「该往哪走」说得空 —— 交出这块料里关于「接住」的具体判据`).join('\n')
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
  assert.match(r4.text, /【原始草稿】/)
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

  // 图命中清单（2026-10-27 用户定）：图上只亮这一轮读过、交了料的节点。
  // 这里 A（命中）与 P（往下追读到的父节点）都交付了 → 两个都亮；hits 只含命中那条。
  const used = events.find((e) => e.type === 'used')
  assert.ok(used, '要有 used 事件（图命中按它点亮）')
  assert.deepEqual(used.nodes, ['A', 'P'], '本轮命中在前，往下追读到的父节点跟上')
  assert.deepEqual(used.hits, ['A'], 'hits 只含本轮命中（自由模式引用窗体按它自动并入）')
  assert.ok(events.findIndex((e) => e.type === 'used') < events.findIndex((e) => e.type === 'final'),
    'used 要在终稿之前发出：用户开始读答案时图已经亮着')
})

test('流水线：图上只亮「读过且交上了料」的节点——判「用不上」的、交付被拒的都不亮', async () => {
  // 两个命中：A 交付成功、B 被顶层派题判「用不上」（连材料都没读）。
  const model = fakeModel({
    draft: '1. 判断甲\n   验：无',
    reports: { 'K-1': REP() },
    dispatchSkip: ['K-2'],
    answer: '终稿正文',
  })
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A', 'B'],
    ...graphDeps({ parents: {} }),   // 不往下追：只看命中层
    complete: model.complete, stream: model.stream, log: () => {},
    onEvent: (e) => events.push(e),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  const used = events.find((e) => e.type === 'used')
  assert.deepEqual(used.nodes, ['A'], 'B 判了「用不上」→ 不上图')
  assert.deepEqual(used.hits, ['A'])

  // 交付被拒也算"这一轮没起作用"：读了材料，但交出来的不是能用的东西。
  const model2 = fakeModel({
    draft: '1. 判断甲\n   验：无',
    reports: { 'K-1': '拒绝：这段当时谈的是别的事' },
    dispatchSkip: ['K-2'],
    answer: '终稿正文',
  })
  const events2 = []
  const it2 = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A', 'B'],
    ...graphDeps({ parents: {} }),
    complete: model2.complete, stream: model2.stream, log: () => {},
    onEvent: (e) => events2.push(e),
  })
  let r2 = await it2.next()
  while (!r2.done) r2 = await it2.next()
  const used2 = events2.find((e) => e.type === 'used')
  assert.deepEqual(used2.nodes, [], 'A 交付被拒、B 用不上 → 图上什么都不亮')
  assert.deepEqual(used2.hits, [])
})

// ── 联网搜索（2026-10-27 接上：与派题并列的第二条路）───────────────────────────
test('草稿 brief：判断不写具体数据，「验」行必须带年代；已查到的不再重复搜', () => {
  const b = buildDraftBrief()
  assert.match(b, /总、步、收是简短的回答路线/)
  assert.match(b, /具体数据留给待查/)
  assert.match(b, /搜索读不懂"当时"/)
  assert.match(b, /没有具体事实就写"待查：无"/)
  assert.match(b, /已经落到具体出处的，不再列/)
})

test('流水线：联网搜索与派题**并行**，结果并进终稿', async () => {
  // 闸门：search 一直挂着不返回，只有派题开跑之后才放开。
  // 如果流水线写成"先等搜索再派题"，这里会直接卡住（测试超时）——这条就是并发性的证明。
  let release
  const gate = new Promise((res) => { release = res })
  let started = false
  let dispatchSawPending = false
  let seenPoints = null

  const model = fakeModel({
    draft: '1. 判断甲\n   验：2019年土地管理法第48条怎么算补偿\n2. 判断乙\n   验：无',
    reports: { 'K-1': REP() },
    answer: '按区片综合地价算[1]。',
    hooks: {
      onDispatch: () => {
        dispatchSawPending = started   // 派题开跑那一刻，搜索还挂着没回来
        release()                      // 现在才放它回去
      },
    },
  })
  const events = []
  const logs = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: (m) => logs.push(m),
    onEvent: (e) => events.push(e),
    search: async (points) => {
      started = true
      seenPoints = points
      await gate
      return {
        text: '· 2019年土地管理法第48条怎么算补偿\n  - [1] 按区片综合地价算（自然资源部）\n    https://www.mnr.gov.cn/x.html',
        items: [{ n: 1, query: '2019年土地管理法第48条怎么算补偿', title: '按区片综合地价算', site: '自然资源部', text: '按区片综合地价算', url: 'https://www.mnr.gov.cn/x.html' }],
        stats: { queries: 1, requests: 1, results: 5, kept: 1, chars: 120, ms: 420, error: '' },
      }
    },
  })
  let r = await it.next()
  while (!r.done) r = await it.next()

  assert.equal(dispatchSawPending, true, '派题开跑时搜索必须还没回来——这才叫并行')
  assert.deepEqual(seenPoints, ['2019年土地管理法第48条怎么算补偿'], '「验：无」不该拿去搜')
  const r4 = model.calls.at(-1).text
  assert.match(r4, /【搜索结果】（/)
  assert.match(r4, /按区片综合地价算/, '查到的结果要进终稿')
  assert.match(r4, /www\.mnr\.gov\.cn/, '出处要带进去')
  assert.match(r4, /原话中间的「\.\.\.」是省略，不要补上/, 'snippet 是原样摘的，只需提醒它别补全省略号')
  assert.match(r4, /分属不同年代/, '同一件事不同年代答案不同，要按年份挑')
  const ev = events.find((e) => e.type === 'search')
  assert.ok(ev, '要记一笔联网事件（事后能答"这轮到底查没查"）')
  assert.equal(ev.kept, 1)
  assert.equal(ev.text, undefined, '事件里不带全文，只带计数')
  // 条目单独交出去：侧栏点开正文里的 [1] 要看的就是这一份（2026-10-27）。
  // 不交出去，正文里的编号就只能是纯文字，读者点不出原话。
  const src = events.find((e) => e.type === 'sources')
  assert.ok(src, '材料条目要单独发一个事件')
  assert.equal(r.value, '按区片综合地价算[1]。', '正文原样交出去（这一轮编号本来就是顺序的）')
  assert.deepEqual(src.items.map((i) => i.n), [1])
  assert.equal(src.items[0].url, 'https://www.mnr.gov.cn/x.html')
  // 顺序：final 先、sources 后——条目要等正文出来才知道引了哪几条、该编成几号
  assert.ok(events.findIndex((e) => e.type === 'final') < events.findIndex((e) => e.type === 'sources'), '条目必须排在终稿之后')
  // 编号对不上只记日志、不改正文（模型编了一个不存在的号 = 该亮的信号）
  assert.ok(logs.some((m) => /终稿引到 1 条材料/.test(m)), '终稿引了几条材料要记一笔')
})

test('流水线：搜索失败不影响这一轮——整块不出现，退回原来的优先链', async () => {
  const model = fakeModel({ draft: '1. 判断甲\n   验：某件要去网上查的事', reports: { 'K-1': REP() }, answer: '终稿正文' })
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {},
    onEvent: (e) => events.push(e),
    search: async () => { throw new Error('搜索接口 HTTP 402: Insufficient Balance') },
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '终稿正文', '搜索挂了也必须照常交答案')
  assert.doesNotMatch(model.calls.at(-1).text, /【搜索结果】（/)
  const ev = events.find((e) => e.type === 'search')
  assert.match(ev.error, /402/, '失败要留痕，别让"没查"和"查了没结果"分不清')
})

test('流水线：编出来的编号只记日志；对得上的按出现先后重排', async () => {
  const model = fakeModel({
    draft: '1. 判断甲\n   验：某件要去网上查的事',
    answer: '判断甲[1]，另一处[9]。',
  })
  const logs = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: (m) => logs.push(m),
    search: async () => ({
      text: '· 某件要去网上查的事\n  - [1] 某文件（某站）\n    https://e.com/a',
      items: [{ n: 1, query: '某件要去网上查的事', title: '某文件', site: '某站', text: '原文', url: 'https://e.com/a' }],
      stats: { queries: 1, requests: 1, results: 1, kept: 1, chars: 40, ms: 300, error: '' },
    }),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '判断甲[1]，另一处[9]。', '编出来的 [9] 原样留着（能看见才查得了），[1] 本来就是 1 号')
  assert.ok(logs.some((m) => /编号对不上材料（9）/.test(m)), '对不上的编号要在日志里亮出来')
  assert.ok(logs.some((m) => /终稿引到 1 条材料/.test(m)), '引到几条也要记一笔')
})

test('流水线：正文编号按出现先后重排，条目跟着换号（点开对得上）', async () => {
  const model = fakeModel({
    draft: '1. 判断甲\n   验：某件要去网上查的事',
    // 模型按它在材料块里挑东西的顺序写：先引第 2 条、再引第 1 条。
    // 读者看到第一个标记是 [2] 就是错位，所以要按出现先后改成 [1]、[2]。
    answer: '先说这条[2]，再说那条[1]，回头又提一次这条[2]。',
  })
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {},
    onEvent: (e) => events.push(e),
    search: async () => ({
      text: '· 某件要去网上查的事\n  - [1] 前一条（甲站）\n    https://e.com/1\n  - [2] 后一条（乙站）\n    https://e.com/2',
      items: [
        { n: 1, query: '某件要去网上查的事', title: '前一条', site: '甲站', text: '原文一', url: 'https://e.com/1' },
        { n: 2, query: '某件要去网上查的事', title: '后一条', site: '乙站', text: '原文二', url: 'https://e.com/2' },
      ],
      stats: { queries: 1, requests: 1, results: 2, kept: 2, chars: 90, ms: 300, error: '' },
    }),
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '先说这条[1]，再说那条[2]，回头又提一次这条[1]。', '正文按出现先后重排，重复出现的还是同一个号')
  const src = events.find((e) => e.type === 'sources')
  assert.deepEqual(src.items.map((i) => i.title), ['后一条', '前一条'], '条目跟着换号：新 [1] 是原来那条 [2]')
  assert.deepEqual(src.items.map((i) => i.n), [1, 2])
})

test('流水线：没传 search / 没有验行 → 一次都不联网', async () => {
  for (const search of [null, async () => { throw new Error('不该被调用') }]) {
    const model = fakeModel({ draft: '1. 判断甲\n   验：无', reports: { 'K-1': REP() }, answer: '终稿正文' })
    const events = []
    const it = runTasksPipeline({
      hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'], ...graphDeps(),
      complete: model.complete, stream: model.stream, log: () => {},
      onEvent: (e) => events.push(e),
      search,
    })
    let r = await it.next()
    while (!r.done) r = await it.next()
    assert.equal(r.value, '终稿正文')
    assert.equal(events.find((e) => e.type === 'search'), undefined, '没有验行就不该发搜索事件')
  }
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

test('流水线：maxDepth=2（默认）→ 命中、父、祖父都读，祖父不再往下派', async () => {
  // A（命中）→ P（父，1 层）→ G（祖父，2 层）；G 到上限就停，不再去找它的更早讨论。
  const nodes = {
    A: NODE('A', '方向A'), B: NODE('B', '方向B'),
    P: NODE('P', '更早的方向P'), G: NODE('G', '再早的方向G'),
  }
  const parents = { A: ['P'], P: ['G'] }
  const model = fakeModel({
    draft: '【方向：甲】\n- 要点',
    reports: {
      'K-1': REP(),
      'K-1.1': REP('父那一段说的是承载三条件当时怎么被拆开，缺一会让另外两个退化。'),
      'K-1.1.1': REP('祖父那一段更早，讲的是这套结构最早在什么场合被提出来，以及当时争的是什么。'),
    },
  })
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A'],
    nodeOf: (id) => nodes[id] || null, parentsOf: (id) => parents[id] || [],
    complete: model.complete, stream: model.stream, log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.deepEqual(model.calls.map((c) => c.kind), [
    '课题草稿', '课题派题', '课题报告',        // 草稿 → 命中 A
    '课题派题', '课题报告',                    // A → 父 P
    '课题派题', '课题报告',                    // P → 祖父 G
    '课题汇总', '课题汇总',                    // G 回来并进 P、P 回来并进 A
    'R4',
  ])
  assert.match(model.calls[6].text, /再早的方向G/)   // 第三次交付读的是祖父
  assert.equal(r.value, '终稿正文')
})

test('流水线：没有兜底闸——命中几个就跑几个，不由程序数着花销喊停', async () => {
  // 2026-10-26 用户定：删掉那三道闸（调用数/材料 token/墙钟）。这里钉住"两个命中都真的跑到了"。
  const model = fakeModel({ draft: '【方向：甲】\n- 要点', reports: { 'K-1': REP(), 'K-2': REP() } })
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A', 'B'], ...graphDeps(),
    complete: model.complete, stream: model.stream, log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  const kinds = model.calls.map((c) => c.kind)
  assert.equal(kinds.filter((k) => k === '课题报告').length, 3, '两个命中 + A 的父 P 都要读，不许被闸掐掉')
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

test('本轮作答范围同时交给草稿、正文和脑图，不增加调用', async () => {
  const model = fakeModel({ draft: '总：示例\n第1步：说明原因\n收：答够了', answer: '正文' })
  const events = []
  const it = runTasksPipeline({ anchored: '本轮原问', hits: [], complete: model.complete, stream: model.stream,
    answerForm: { brief: true, request: '简述孔孟的看法' },
    onEvent: e => events.push(e),
  })
  for await (const piece of it) {}
  assert.equal(model.calls.length, 2)
  const instruction = events.find(e => e.type === 'draft').assignment
  assert.match(instruction, /150～250字/)
  assert.match(instruction, /简述孔孟的看法/)
  for (const call of model.calls) assert.ok(call.text.endsWith(instruction))
})

test('流水线：相处规则只进终稿、不进 R1（2026-10-27 用户定）', async () => {
  const model = fakeModel({ draft: '1. 判断甲\n   验：无', reports: { 'K-1': REP() }, answer: '终稿正文' })
  const it = runTasksPipeline({
    hist: [], persona: '【背景档案】P', agreement: '【相处规则】1. 直接给判断',
    anchored: '【本轮消息】A', question: 'q',
    hits: ['A'], ...graphDeps(), complete: model.complete, stream: model.stream, log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '终稿正文')
  assert.doesNotMatch(model.calls[0].text, /相处规则/, 'R1 只负责列判断，不看相处规则')
  const msgs = model.calls.at(-1).messages
  assert.equal(msgs.at(-1).content, '【本轮消息】A', '问题永远是最后一条')
  assert.match(msgs.at(-2).content, /相处规则/, '相处规则紧贴提问——它要的是"照这个说"')
  assert.match(msgs.at(-3).content, /【这次要写的是回答/, '再往前才是材料与写法规矩')
})

test('流水线：没有命中 → 不派题，但照样列大纲、照样联网（2026-10-27 用户定）', async () => {
  // 原来的行为是"直接回一句普通答案"。那等于"你没读过的话题一律不查网"，
  // 而政策/史料类问题恰恰常常是新话题——最该查的时候反而不查。
  const calls = []
  const searched = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: [], nodeOf: () => null, parentsOf: () => [],
    complete: async (o) => {
      calls.push({ kind: o.kind, text: o.messages.map((m) => m.content).join('\n') })
      if (o.kind === '课题草稿') return '1. 判断甲\n   验：2019年土地管理法第48条怎么算补偿'
      throw new Error(`没有命中时不该有「${o.kind}」`)
    },
    stream: async function* (o) {
      calls.push({ kind: 'R4', text: o.messages.map((m) => m.content).join('\n') })
      yield { chunk: 'x', accumulated: '终稿正文' }
    },
    search: async (points) => {
      searched.push(...points)
      return { text: '· 2019年土地管理法第48条怎么算补偿\n  - 按区片综合地价算（自然资源部）', stats: { queries: 1, requests: 1, results: 3, kept: 1, chars: 60, ms: 380, split: 0, error: '' } }
    },
    log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()

  assert.equal(r.value, '终稿正文')
  assert.deepEqual(calls.map((c) => c.kind), ['课题草稿', 'R4'], '只该有大纲和终稿，不该有派题/登记/汇总')
  assert.deepEqual(searched, ['2019年土地管理法第48条怎么算补偿'], '没有命中也要联网')
  assert.match(calls[1].text, /按区片综合地价算/, '查到的结果要进终稿')
  assert.match(calls[1].text, /【搜索结果】（/)
})

test('流水线：R1 失败仍然回答，图上只亮已有的引用', async () => {
  const events = []
  const it = runTasksPipeline({
    hist: [], persona: 'P', anchored: 'A', question: 'q', hits: ['A', 'B'], fallbackHits: ['A'], ...graphDeps(),
    complete: async () => { throw new Error('LLM API 500') },
    stream: async function* () { throw new Error('不该走 R4') },
    fallback: async function* () { yield { chunk: '兜底', accumulated: '兜底答案' } },
    onEvent: event => events.push(event),
    log: () => {},
  })
  let r = await it.next()
  while (!r.done) r = await it.next()
  assert.equal(r.value, '兜底答案')
  assert.deepEqual(events.find(event => event.type === 'used'), { type: 'used', nodes: ['A'], hits: ['A'] })
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
test('l3Path：五条路各就各位；tasks 每轮都跑（没命中也不许退回 full 拿那 47k）', () => {
  assert.equal(l3Path('full', []), 'full')
  assert.equal(l3Path('off', ['A']), 'off')
  assert.equal(l3Path('tasks', ['A']), 'tasks')
  // 2026-10-27 改：没有新命中时仍走 tasks（只列大纲 + 联网，不派题）。
  // 原来这里退成 bare，等于"没读过的话题一律不查网"。绝不能退成 full——那会把整段来路再发一遍。
  assert.equal(l3Path('tasks', []), 'tasks')
  assert.notEqual(l3Path('tasks', []), 'full', '退回 full 就又把 47k 发一遍')
  assert.equal(l3Path('both', ['A']), 'both')
  // 2026-10-27：both 也每轮都跑。没命中时退回 full 的话，那一轮用户看到的只有旧路径，
  // 跟"新路径为主"矛盾，对照也断一半。
  assert.equal(l3Path('both', []), 'both')
  assert.notEqual(l3Path('both', []), 'full', '退回 full 就只剩旧路径给用户看了')
})

test('源码：元任务（_meta 记忆合并）不走 L3——"每轮都跑"别把记忆合并卷进命题递归', () => {
  // 2026-10-27 实况：data/runtime/l3-trace 里出现了 `_meta` 的全过程记录（路径 both、0 命中）——
  // 会话结束的合并请求被当成一道提问去列大纲、联网、写终稿，既贵又答非所问。
  // 合并要的是"照提示词一次写完整份结果"，不该有派题/终稿。
  assert.match(SRC, /const path = key === '_meta' \? 'off' : l3Path\(l3Mode, l3Hits\)/)
})

test('源码：say() 真的走新路径，旧路径一行没删', () => {
  assert.match(SRC, /import \{ runTasksPipeline \} from '\.\/lib\/l3-tasks\.js'/)
  assert.match(SRC, /runTasksPipeline\(tasksDeps\)/)
  assert.match(SRC, /question: storeText \|\| userText/, '当前提问要传进去（不是节点里的旧问题）')
  assert.match(SRC, /userAncestry\(graph, seeds\)/, '旧路径的来路闭包必须保留（A/B 基线）')
  assert.match(SRC, /l3Block\(ancestry\)/)
  assert.doesNotMatch(SRC, /l3-refusals\.jsonl/, '拒绝结果现在不落盘')
  assert.doesNotMatch(SRC, /onRefusal: \(rec\)/, '拒绝回调没有接线')
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
  // 图命中（2026-10-27 换口径）：图只亮"这一轮读过、交了料"的节点，所以事件不能在提问后
  // 立刻写（那时还没判），而是等流水线的 used 事件；旧路径（full/off）没有逐节点判定 → 立刻写。
  assert.match(SRC, /e\.type === 'used' && \(path === 'tasks' \|\| path === 'both'\)/)
  assert.match(SRC, /appendGraphHit\(ids, ids\.map\(hitLabel\)\.join\('、'\), key, options\.replyToTs, \{/)
  assert.match(SRC, /appendGraphHit\(l3Hits, l3Hits\.map\(hitLabel\)\.join\('、'\), key, options\.replyToTs\)/,
    '旧路径 full/off 仍要立刻点亮（它们没有逐节点判定）')
  assert.doesNotMatch(SRC, /appendGraphHit\(hitsThisRound/, '提问后立刻写的老口径已撤（新路径要等 used）')
  assert.doesNotMatch(SRC, /appendGraphHit\(valid,/)
  // 流水线要交出 used 事件，而且排在终稿之前（用户开始读答案时图已经亮着）
  assert.match(LIB_SRC, /emit\(\{ type: 'used', nodes: usedIds, hits: usedHits \}\)/)
  assert.match(LIB_SRC, /if \(r\.summary && !usedSeen\.has\(args\.id\)\)/)
  assert.ok(LIB_SRC.lastIndexOf("emit({ type: 'used',") < LIB_SRC.indexOf('full = yield* relay('),
    'used 必须在终稿流式之前发出')
  // 常驻口径（2026-10-27 第二版）：这一轮真用上的节点记进讨论栈（user 条目的 used），
  // /stack-hits 取最近一轮 → 回答结束后打开图画的还是这一份，而不是累积的 cites。
  assert.match(SRC, /options\.turnUsed = ids\.slice\(\)/)
  assert.match(SRC, /applyStackTurn\(key, stackUnit, reply, stackDecision, sayOpts\.turnUsed\)/)
  assert.match(SRC, /\.\.\.\(used \? \{ used \} : \{\}\)/)
  assert.match(SRC, /options\.turnUsed = l3Hits\.slice\(\)/, '旧路径也要记一份（它按全部命中算）')
  // 判栈失败要清继承记录（说不清有没有换话题时，不带旧来路跨话题）
  assert.match(SRC, /判栈失败 → 继承记录已清/)
  // both 模式：2026-10-27 起**新路径为主**（流式给用户看），旧路径另起一条只显示、不进历史
  assert.match(SRC, /〔A · 旧路径〕/, '副气泡标的是旧路径')
  assert.match(SRC, /payload: \{ l3variant: 'A' \}/)
  assert.doesNotMatch(SRC, /〔B · 新路径〕/, '新路径不再以"另一条气泡"的形式出现——它就是回答本身')
  // 主/副对调后，停止信号必须归主路径（新的那条）；旧的 if (path === 'both') return 要撤掉
  assert.doesNotMatch(SRC, /if \(path === 'both'\) return\n\s+if \(consumeSessionStop/)
  // 顶层「用不上」被整轮屏蔽的节点要留日志（先只观察，不改行为）——这段在流水线里
  assert.match(LIB_SRC, /因顶层「用不上」被整轮屏蔽/)
  assert.match(LIB_SRC, /unusedHits\.add\(p\.id\)/)
  // 被拒的、以及顶层判「用不上」的，都要在 live 事件里交出来（否则集合只增不减）
  assert.match(LIB_SRC, /refused: true/)
  assert.match(LIB_SRC, /const deadNodes = new Set\(\[\.\.\.refusedNodes, \.\.\.unusedHits\]\)/)
  assert.match(LIB_SRC, /failed: \[\.\.\.deadNodes\]/)
})
