#!/usr/bin/env node
/**
 * 会意图（有向图拓扑）：图结构 + 路径上下文 + 引用解析 单元测试 — 内置 node:test。
 * 运行：node test/knowledge-graph.test.js
 *
 * 测试口径（对应 topic-library-design.md §5.3 / §5.4②③④）：
 * - 图结构：节点/边 CRUD、边必须有 from/to、root/recent 语义 → 测 createGraph/addNode/addEdge/removeEdge/updateEdge
 *   （节点不可变：固化直建，addNode 对已存在 id 抛错——2026-08-29 用户定调：去聚合判同）
 * - 路径上下文：root→recent 拓扑序、多引用并集去重、未命中返回空 → 测 contextOf
 * - 引用解析：一次发言多命中、未命中输出空、非法输出重试 → 测 resolveReferences
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createGraph,
  addNode,
  updateNodePoint,
  addEdge,
  removeEdge,
  updateEdge,
  findNode,
  isReachable,
  contextOf,
  derivePoint,
  deriveAliases,
  updateNodeAliases,
  judgeDerivation,
  resolveReferences,
  parseReferenceResult,
  parseAliasesResult,
  buildAliasPrompt,
  buildReferencePrompt,
  buildPointInstruction,
} from '../lib/knowledge-graph.js'

// 假 LLM：按队列吐预设文本（沿用 topicize 测试的注入模式）
function makeLLM(results) {
  let i = 0
  return async () => {
    if (i >= results.length) throw new Error('假 LLM 队列耗尽')
    return results[i++]
  }
}

// ── 图结构 ────────────────────────────────────────────────────────────────────
test('图结构：建边（kind：user/derived）、findNode', () => {
  const g = createGraph()
  const n1 = addNode(g, { id: 'n_nordic', point: '北欧制度的历史位置', discussion: { question: '北欧福利靠内部还是外部？', book: '《静静的顿河》', chapter: '六' } })
  const n2 = addNode(g, { id: 'n_cossack', point: '哥萨克的身份政治', discussion: { question: '哥萨克在革命中的真实立场是什么？' } })
  assert.equal(g.nodes.length, 2)
  assert.equal(n1.discussions.length, 1)
  assert.equal(n2.discussions[0].question, '哥萨克在革命中的真实立场是什么？')

  assert.throws(() => addEdge(g, { from: 'n_nordic' }), /from|to/, '边必须带 from 与 to')
  const e = addEdge(g, { from: 'n_nordic', to: 'n_cossack' })
  assert.equal(e.kind, 'user', '默认 user 边（显式引用）')
  assert.equal('quote' in e, false, '边不落 quote 字段（2026-08-27 定调：追溯/删改触发未实现，字段暂删）')
  const e2 = addEdge(g, { from: 'n_nordic', to: 'n_cossack', kind: 'derived' })
  assert.equal(e2.kind, 'derived', 'derived 边（对话连续性衍生）')
  assert.equal(g.edges.length, 2)
  // 悬空边防护（评审 P5）：from/to 必须是已有节点
  assert.throws(() => addEdge(g, { from: 'n_nordic', to: 'n_missing' }), /不存在/, 'to 节点不存在抛错（不允许悬空边）')
  assert.throws(() => addEdge(g, { from: 'n_missing', to: 'n_nordic' }), /不存在/, 'from 节点不存在抛错（不允许悬空边）')
  assert.equal(g.edges.length, 2, '抛错后不产生边')
  assert.equal(findNode(g, 'n_nordic').point, '北欧制度的历史位置')
  assert.equal(findNode(g, 'n_missing'), null)
})

test('图结构：节点不可变（固化直建——addNode 对已存在 id 抛错），显式改写走 updateNodePoint', () => {
  const g = createGraph()
  addNode(g, { id: 'n_nordic', point: '北欧制度的历史位置', discussion: { question: '北欧福利靠内部还是外部？' } })
  // 节点不可变：同一 id 再 addNode → 抛错（2026-08-29 用户定调：去聚合判同，不并入、不追加）
  assert.throws(() => addNode(g, { id: 'n_nordic', point: '不应覆盖的新表述', discussion: { question: '北欧地基在哪？' } }), /不可变/, '已存在 id 抛错，不聚合')
  const n = findNode(g, 'n_nordic')
  assert.equal(n.point, '北欧制度的历史位置', 'point 未被改写')
  assert.equal(n.discussions.length, 1, '讨论未追加')
  // 显式改写
  updateNodePoint(g, 'n_nordic', '北欧福利国家的内部制度与外部依附')
  assert.equal(findNode(g, 'n_nordic').point, '北欧福利国家的内部制度与外部依附')
  assert.equal(updateNodePoint(g, 'n_missing', 'x'), null, '节点不存在返回 null')
  assert.throws(() => updateNodePoint(g, 'n_nordic', ' '), /point/)
})

test('图结构：节点不可变（新建时生成的 aliases 不被系统追加，手动入口 updateNodeAliases）', () => {
  const g = createGraph()
  addNode(g, { id: 'n_lenin', point: '列宁分化哥萨克的策略', aliases: ['阶级分析的手术刀', '军役等级'], discussion: { question: '为什么列宁分化哥萨克的策略没有奏效？' } })
  // 无聚合路径：同一 id 再次添加直接抛错，不存在 aliases 合并
  assert.throws(() => addNode(g, { id: 'n_lenin', aliases: ['马和枪是身份的支柱'], discussion: { question: '为什么同是革命暴力？' } }), /不可变/)
  const n = findNode(g, 'n_lenin')
  assert.deepEqual(n.aliases, ['阶级分析的手术刀', '军役等级'], 'aliases 保持创建时形态')
  assert.equal(n.discussions.length, 1)
})

test('图结构：新建节点缺 id/point 抛错；讨论缺 question 抛错', () => {
  const g = createGraph()
  assert.throws(() => addNode(g, { point: 'x' }), /id/)
  assert.throws(() => addNode(g, { id: 'n_x', point: 'x', discussion: { book: 'B' } }), /question/, '带 discussion 时缺 question 抛错')
})

test('图结构：删边（按 from+to，同 pair 全删）与改边', () => {
  const g = createGraph()
  addNode(g, { id: 'n_a', point: 'A' })
  addNode(g, { id: 'n_b', point: 'B' })
  addNode(g, { id: 'n_c', point: 'C' })
  addEdge(g, { from: 'n_a', to: 'n_b' })
  addEdge(g, { from: 'n_a', to: 'n_b' })
  addEdge(g, { from: 'n_a', to: 'n_c' })

  assert.equal(removeEdge(g, { from: 'n_a', to: 'n_x' }), 0, '不存在的 pair 删 0 条')
  assert.equal(removeEdge(g, { from: 'n_a', to: 'n_b' }), 2, '同 from→to 多条边全部删除')
  assert.equal(g.edges.length, 1)

  assert.equal(updateEdge(g, { from: 'n_a', to: 'n_c', newTo: 'n_b' }), 1)
  assert.equal(g.edges[0].to, 'n_b')
  assert.equal(updateEdge(g, { from: 'n_a', to: 'n_b', newFrom: 'n_c' }), 1)
  assert.equal(g.edges[0].from, 'n_c')
  assert.throws(() => updateEdge(g, { from: 'n_a', to: 'n_c' }), /newFrom|newTo/)
})

test('图结构：isReachable（沿边可达 = 同脉络祖先，user/derived 全算）', () => {
  const g = createGraph()
  for (const id of ['n_a', 'n_b', 'n_c', 'n_x', 'n_y']) addNode(g, { id, point: id })
  addEdge(g, { from: 'n_a', to: 'n_b', kind: 'derived' })  // 脉络：a→b→c（derived 链）
  addEdge(g, { from: 'n_b', to: 'n_c', kind: 'derived' })
  addEdge(g, { from: 'n_a', to: 'n_x' })                   // user 边（引用方向）：x 引用 a
  assert.equal(isReachable(g, 'n_a', 'n_c'), true, '同脉络祖先可达（隔中间节点）')
  assert.equal(isReachable(g, 'n_b', 'n_c'), true)
  assert.equal(isReachable(g, 'n_c', 'n_a'), false, '方向不对（沿边方向不可达）')
  assert.equal(isReachable(g, 'n_a', 'n_x'), true, 'user 边也构成脉络')
  assert.equal(isReachable(g, 'n_b', 'n_x'), false, '不同脉络分支互不可达')
  assert.equal(isReachable(g, 'n_a', 'n_a'), false, '自身不算可达（同节点不构成祖先）')
  assert.equal(isReachable(g, 'n_a', 'n_missing'), false, '缺失节点返回 false')
  assert.equal(isReachable(g, null, 'n_a'), false)
  // 无边的孤立节点
  addNode(g, { id: 'n_alone', point: 'A' })
  assert.equal(isReachable(g, 'n_alone', 'n_a'), false)
})

// ── 路径上下文（root → recent） ───────────────────────────────────────────────
test('路径上下文：单链 root→recent 拓扑序，不截断', () => {
  const g = createGraph()
  addNode(g, { id: 'n_root', point: '最早的根节点', discussion: { question: '最初的追问？' } })
  addNode(g, { id: 'n_mid', point: '中间节点', discussion: { question: '中间追问？' } })
  addNode(g, { id: 'n_recent', point: '当前节点', discussion: { question: '当前追问？' } })
  addEdge(g, { from: 'n_root', to: 'n_mid' })
  addEdge(g, { from: 'n_mid', to: 'n_recent' })

  const path = contextOf(g, 'n_recent')
  assert.deepEqual(path.map((n) => n.id), ['n_root', 'n_mid', 'n_recent'], 'root 在前，recent 在后')
})

test('路径上下文：多引用取并集去重（两个 root 分支汇到 recent）', () => {
  const g = createGraph()
  addNode(g, { id: 'n_r1', point: '苏联的工业化史', discussion: { question: '苏联工业化为何这样走？' } })
  addNode(g, { id: 'n_r2', point: '哥萨克的身份政治', discussion: { question: '哥萨克立场为何这样？' } })
  addNode(g, { id: 'n_recent', point: '南美的工业化', discussion: { question: '南美为何走向不同？' } })
  addEdge(g, { from: 'n_r1', to: 'n_recent' })
  addEdge(g, { from: 'n_r2', to: 'n_recent' })

  const path = contextOf(g, 'n_recent')
  assert.equal(path.length, 3, '并集去重：r1 + r2 + recent')
  assert.equal(path[2].id, 'n_recent', 'recent 恒在最后')
  assert.ok(path.slice(0, 2).map((n) => n.id).sort().join(',') === 'n_r1,n_r2', '两个 root 在前')
})

test('路径上下文：深层引用只取可达祖先（不取无关节点）；未命中返回空', () => {
  const g = createGraph()
  addNode(g, { id: 'n_a', point: 'A', discussion: { question: 'A？' } })
  addNode(g, { id: 'n_b', point: 'B', discussion: { question: 'B？' } })
  addNode(g, { id: 'n_c', point: 'C', discussion: { question: 'C？' } })
  addEdge(g, { from: 'n_a', to: 'n_b' })
  // n_c 与 n_b 无连接——不应进入 n_b 的路径
  assert.deepEqual(contextOf(g, 'n_b').map((n) => n.id), ['n_a', 'n_b'])
  assert.deepEqual(contextOf(g, 'n_missing'), [], '未命中返回空')
})

// ── 派生 point（动作②伴生：新建节点时归纳狭隘范畴） ─────────────────────────
test('派生 point：归纳狭隘范畴表述；缺 question / 未注入 callLLM 抛 TypeError', async () => {
  const llm = makeLLM(['{"point":"北欧制度的历史位置"}'])
  const r = await derivePoint({ question: '北欧福利究竟是靠内部制度还是外部位置？' }, { callLLM: llm })
  assert.equal(r.point, '北欧制度的历史位置')
  await assert.rejects(() => derivePoint({}, { callLLM: makeLLM(['{}']) }), /question/)
  await assert.rejects(() => derivePoint({ question: 'Q？' }), /callLLM/)
})

test('派生 point：截断失败串（⚠️）→ 重试；耗尽后抛错（宁漏勿误，不建节点）', async () => {
  // 截断失败串不解析，重试（d_14 教训：截断产物/思考草稿绝不当作输出）
  const llm1 = makeLLM(['⚠️ 输出被截断（finish_reason: length）', '{"point":"协约国援助作为旧政权债务链条的性质"}'])
  const r1 = await derivePoint({ question: '协约国的援助属于什么性质？' }, { callLLM: llm1 })
  assert.equal(r1.point, '协约国援助作为旧政权债务链条的性质')
  // 全部失败串 → 耗尽抛错 → 上层 catch 后弃组（不建垃圾节点）
  await assert.rejects(
    () => derivePoint({ question: '协约国的援助属于什么性质？' }, { callLLM: makeLLM(['⚠️ 输出被截断（finish_reason: length）', '⚠️ 输出被截断（finish_reason: length）', '⚠️ 输出被截断（finish_reason: length）']) }),
    /返回失败串/,
  )
})

test('派生 point：parsePointResult 内容有效性——占位残片/过短/纯标点 → 无效', async () => {
  // 截断产物或思考草稿里"碰巧"抠出的 JSON 可能是残片：宁漏勿误（拦下只少建一个节点，
  // 放行会污染知识图谱）。d_14 的 point="..." 即此类。
  for (const bad of [
    '{"point":"..."}',
    '{"point":"…"}',
    '{"point":"。"}',
    '{"point":".、"}',
    '{"point":""}',
    '{"point":null}',
  ]) {
    // 残片被拒绝后重试，重试给出有效 point → 成功
    const r = await derivePoint({ question: 'Q？' }, { callLLM: makeLLM([bad, '{"point":"有效知识点表述"}']) })
    assert.equal(r.point, '有效知识点表述', `残片 ${bad} 被拒后由有效输出接管`)
    assert.equal(r.attempts, 2, `残片 ${bad} 首试被校验拦下`)
  }
  // 全是残片 → 耗尽抛错
  await assert.rejects(
    () => derivePoint({ question: 'Q？' }, { callLLM: makeLLM(['{"point":"..."}', '{"point":"…"}', '{"point":"。"}']) }),
    /仍无有效判定/,
  )
})

// ── 能指（aliases：2026-08-29 定调——被卸除的能指，捡回 point 卸下的背景内容） ────
test('能指：updateNodeAliases 整表改写（可删可改）；节点不存在返回 null', () => {
  const g = createGraph()
  addNode(g, { id: 'n_nordic', point: '北欧制度的历史位置', aliases: ['泵和阀', '北欧福利的承重墙'], discussion: { question: '北欧福利靠内部还是外部？' } })
  assert.deepEqual(findNode(g, 'n_nordic').aliases, ['泵和阀', '北欧福利的承重墙'])
  updateNodeAliases(g, 'n_nordic', ['泵和阀'])
  assert.deepEqual(findNode(g, 'n_nordic').aliases, ['泵和阀'], '整表替换，可收窄')
  updateNodeAliases(g, 'n_nordic', [])
  assert.deepEqual(findNode(g, 'n_nordic').aliases, [], '可清空')
  assert.equal(updateNodeAliases(g, 'n_missing', ['x']), null, '节点不存在返回 null')
})

test('能指：deriveAliases 调 LLM 解析（数量不限）；非法输出重试；缺 point/未注入抛 TypeError', async () => {
  const llm = makeLLM(['{"aliases":["列宁分化哥萨克的策略","阶级分析的手术刀与军役身份社会","顿河哥萨克的对策"]}'])
  const r = await deriveAliases({ point: '列宁分化哥萨克的策略', question: '为什么列宁分化哥萨克的策略没有奏效？' }, { callLLM: llm })
  assert.equal(r.aliases.length, 3)
  assert.equal(r.aliases[0], '列宁分化哥萨克的策略')
  assert.equal(r.attempts, 1)

  const retry = makeLLM(['不是JSON', '{"aliases":["只看一个角度"]}'])
  const r2 = await deriveAliases({ point: 'P' }, { callLLM: retry, attempts: 2 })
  assert.equal(r2.attempts, 2, '非法输出重试后成功')

  await assert.rejects(() => deriveAliases({}, { callLLM: makeLLM(['{}']) }), /point/)
  await assert.rejects(() => deriveAliases({ point: 'P' }), /callLLM/)
  await assert.rejects(
    () => deriveAliases({ point: 'P' }, { callLLM: makeLLM(['垃圾', '还是垃圾']), attempts: 2 }),
    /无有效判定/,
  )
})

test('能指：parseAliasesResult 容错（去空去重、数量不限、围栏/前言）', () => {
  assert.deepEqual(parseAliasesResult('```json\n{"aliases":["A","B","A",""]}\n```'), { aliases: ['A', 'B'] })
  assert.deepEqual(parseAliasesResult('结果如下：{"aliases":["A","B","C","D","E"]}'), { aliases: ['A', 'B', 'C', 'D', 'E'] }, '数量不限（2026-08-29 定调：不做条数限制）')
  assert.equal(parseAliasesResult('{"aliases":[]}'), null, '空表无效')
  assert.equal(parseAliasesResult('{"aliases":"A"}'), null, 'aliases 必须是数组')
  assert.equal(parseAliasesResult('不是JSON'), null)
})

test('能指：提示词术语精确可操作（已知背景 + 不写 point 换说法 + 例子锚 + 数量不限）', () => {
  const p = buildAliasPrompt({ point: '列宁分化哥萨克的策略', question: '为什么列宁分化哥萨克的策略没有奏效？' })
  assert.ok(p.includes('可指认的说法'), '任务名：写可指认的说法')
  assert.ok(p.includes('已知背景'), '精确术语：已知背景（与 point 提示词重心规则一致）')
  assert.ok(p.includes('不写 point 的换说法'), '判据一：不写 point 换说法')
  assert.ok(p.includes('重复 point'), '失败例：写 point 的换说法')
  assert.ok(p.includes('中国的国家形态'), '例子锚：背景对象（防字面对照）')
  assert.ok(p.includes('中俄边疆逻辑'), '例子锚：另一背景面')
  assert.ok(p.includes('写清楚'), '每条写清楚')
  assert.ok(p.includes('不许压缩成看不出内容的短提法'), '不许抽象短提法')
  assert.ok(p.includes('不许发明'), '不造面')
  assert.ok(p.includes('展开过几个就写几条'), '数量随展开面走')
  assert.ok(p.includes('数量不限'), '条数不限（2026-08-29 用户定调）')
  assert.ok(p.includes('条目 point："列宁分化哥萨克的策略"'))
})

test('能指：提示词材料全量提供（excerpts 不截取、全部轮次都在）', () => {
  const longA = '长回复' + '很长的讨论内容'.repeat(80) + '【TAIL_MARKER】尾部也要在'
  const p = buildAliasPrompt({
    point: 'P',
    question: 'Q？',
    excerpts: [
      { q: '第一轮提问', a: '第一轮回复' },
      { q: '第二轮提问', a: longA },
      { q: '第三轮提问', a: '第三轮回复' },
    ],
  })
  assert.ok(p.includes('第一轮提问') && p.includes('第三轮提问'), '全部轮次都提供，不只取末 2 轮')
  assert.ok(p.includes('【TAIL_MARKER】尾部也要在'), '回复不截断（旧逻辑 300 字截断会切掉尾部）')
  assert.ok(!p.includes('…'), '没有截断省略号')
})

// ── 引用解析（动作③，纯 LLM 判定——2026-08-27 定调：去掉字符串粗召回） ───────
test('引用解析：一次发言命中多个节点（全量精判断，单次判定）', async () => {
  const llm = makeLLM(['{"hits":["n_soviet","n_cossack"]}'])
  const r = await resolveReferences(
    { message: '我想到我们之前说的『苏联的工业化史』，还有哥萨克的身份政治，为什么南美走向不同？', nodes: [{ id: 'n_soviet', point: '苏联的工业化史' }, { id: 'n_cossack', point: '哥萨克的身份政治' }] },
    { callLLM: llm },
  )
  assert.deepEqual(r.hits, ['n_soviet', 'n_cossack'])
  assert.equal(r.attempts, 1, '一次判定，无重试')
})

test('引用解析：能指命中（LLM 读 aliases 判定）；解析去空去重', async () => {
  const llm = makeLLM(['{"hits":["n_lenin","","n_lenin"]}'])
  const r = await resolveReferences(
    { message: '我想到我们之前说的「阶级分析的手术刀」', nodes: [{ id: 'n_lenin', point: '列宁分化哥萨克的策略', aliases: ['阶级分析的手术刀'], questions: [] }, { id: 'n_other', point: '教会规矩', aliases: [], questions: [] }] },
    { callLLM: llm },
  )
  assert.deepEqual(r.hits, ['n_lenin'], '解析层去空去重；不在列表里的 id 由调用方过滤')
})

test('引用解析：未命中输出空 hits（宁漏勿误）；非法输出重试', async () => {
  const llm = makeLLM(['不是JSON', '{"hits":[]}'])
  const r = await resolveReferences({ message: '随便聊聊天气', nodes: [{ id: 'n_soviet', point: '苏联的工业化史' }] }, { callLLM: llm })
  assert.equal(r.hits.length, 0)
  assert.equal(r.attempts, 2, '非法输出重试后接受有效判定')
})

test('引用解析：0 命中即接受，不重试（能指过滤层语义——没进能指的词不命中）', async () => {
  let calls = 0
  const llm = async () => {
    calls++
    return '{"hits":[]}'
  }
  const r = await resolveReferences(
    {
      message: '我想到我们之前说的「泵和阀」',
      nodes: [
        { id: 'n_lenin', point: '列宁分化哥萨克的策略', aliases: ['阶级手术刀'], questions: [] },
        { id: 'n_nordic', point: '北欧制度的历史位置', aliases: ['泵和阀'], questions: [] },
      ],
    },
    { callLLM: llm },
  )
  assert.equal(r.hits.length, 0, 'LLM 判定不命中 → 直接接受（没有覆盖判定逼着重试）')
  assert.equal(calls, 1)
})

test('引用解析：缺 message / 未注入 callLLM 抛 TypeError', async () => {
  await assert.rejects(() => resolveReferences({ nodes: [] }, { callLLM: makeLLM(['{}']) }), /message/)
  await assert.rejects(() => resolveReferences({ message: 'M？' }), /callLLM/)
})

// ── 衍生关联（对话连续性的拓扑边） ─────────────────────────────────────────
test('衍生关联：后一讨论从前一讨论思考中衍生（无显式引用句式也算）', async () => {
  const llm = makeLLM(['{"linked":true,"reason":"后一问题显然从前一讨论的思考中长出来：从列宁策略失败联想到中国为何没孕育出哥萨克"}'])
  const r = await judgeDerivation(
    {
      prev: { question: '为什么列宁最初分化哥萨克的策略没有奏效？', excerpts: [{ q: '策略为何失败', a: '因为身份社会错用了阶级手术刀' }] },
      next: { question: '为什么中国那么长久的历史没有酝酿出哥萨克这样的角色？', excerpts: [{ q: '中国为什么没有', a: '这要从制度文化看' }] },
    },
    { callLLM: llm },
  )
  assert.equal(r.linked, true)
  assert.ok(r.reason.includes('从前一讨论的思考中长出来'), 'reason 是建边核对证据')
})

test('衍生关联：时间相邻但思考无关 → 不衍生（宁漏勿误）；缺输入/未注入抛 TypeError', async () => {
  const llm = makeLLM(['{"linked":false,"reason":"前后两条讨论的思考无关"}'])
  const r = await judgeDerivation(
    { prev: { question: '为什么列宁策略没奏效？' }, next: { question: '为什么格里高利抽打同乡时像没事人？' } },
    { callLLM: llm },
  )
  assert.equal(r.linked, false)
  await assert.rejects(() => judgeDerivation({ prev: { question: 'A' } }, { callLLM: makeLLM(['{}']) }), /next/)
  await assert.rejects(() => judgeDerivation({ prev: { question: 'A' }, next: { question: 'B' } }), /callLLM/)
})

// ── 提示词组装（冒烟：关键判据确实进提示词） ─────────────────────────────────
test('提示词：派生 point 重心规则是"解释落点"程序版（不是句式分类）', () => {
  const p = buildPointInstruction()
  assert.ok(p.includes('重心落在**问题要求补上的解释**上'), '重心 = 解释落点，不是句法主语')
  assert.ok(p.includes('已知背景'), '程序第 1 步：列已知背景')
  assert.ok(p.includes('要求补上的解释'), '程序第 2 步：找解释落点')
  assert.ok(p.includes('不写成背景'), '程序第 3 步：point 不落在背景')
  assert.ok(p.includes('落在背景上'), '反例：滑向参照系（中国侧）失败')
  assert.ok(p.includes('停在对象本身'), '反例：停在表面对象失败')
  assert.ok(p.includes('拉丁美洲资本品工业建立不起来的原因'), '例二 = 跨书例子（摩托日记语境），对比结构保持')
  assert.ok(p.includes('孕育出哥萨克式角色的机制'), '例一落点指代统一（哥萨克式角色）')
  assert.ok(!p.includes('问题在问"谁/什么怎么样"'), '旧的"重心=主语"句法规则已移除')
  // 抓主要矛盾段与重心规则不打架：无张力分支指向重心规则，不再自带旧例子
  assert.ok(p.includes('不强造矛盾：按**重心规则**落在解释落点上即可'), '无张力分支引用重心规则')
  assert.ok(!p.includes('中国历史未酝酿出哥萨克式角色的制度文化原因'), '旧的无张力例子（重心落背景，与重心规则例一冲突）已移除')
  // 开头定义 + 输出示例与重心规则一致：不再用旧"对象侧"例子
  assert.ok(p.includes('这条讨论要求补上的解释所在的狭隘范畴'), '定义句 = 解释落点（不是"追的范畴"）')
  assert.ok(p.includes('机制/条件/契机/矛盾/关系/立场'), '定义句枚举含"契机"（与例一正确产物对齐，例子不溢出定义）')
  assert.ok(p.includes('例子是检查工具，不是判定起点'), '程序与例子之间加缝：防模型模仿例子而非执行程序')
  assert.ok(!p.includes('北欧制度的历史位置'), '旧对象侧示例已从派生 point 指令移除')
  assert.ok(!p.includes('哥萨克的身份政治」）'), '旧对象侧示例已从定义句移除（例二的反例保留）')
  assert.ok(p.includes('{"point":"孕育出哥萨克式角色的历史条件与契机"}'), '输出示例 = 重心规则的正确产物')
})

test('提示词：引用解析判据（指认意图 + 内容线索底线 + 语义匹配 + 宁漏勿误）在提示词里', () => {
  const rp = buildReferencePrompt({ message: 'M？', nodes: [{ id: 'n_a', point: 'A' }] })
  assert.ok(rp.includes('一次发言可指认多个'))
  assert.ok(rp.includes('指认性表述'), '指认意图判据（偶然提及不算引用）')
  assert.ok(rp.includes('内容线索（底线）'), '内容线索底线在提示词里')
  assert.ok(rp.includes('就和我们上次聊的一样'), '空指例子在提示词里（不惯着用户）')
  assert.ok(rp.includes('能指词面命中不是必要条件'), '语义匹配：能指词面不再是必要条件')
  assert.ok(rp.includes('不许发明'))
  assert.ok(rp.includes('宁漏勿误'))
  assert.ok(!rp.includes('能指是过滤层'), '旧"能指是过滤层"表述已改为指认意图 + 内容线索判据')
})

test('提示词：引用解析节点材料只含身份（point/能指/问题），不放讨论原文', () => {
  const rp = buildReferencePrompt({
    message: 'M？',
    nodes: [{
      id: 'n_a',
      point: 'A',
      aliases: ['a1'],
      questions: ['Q1？'],
      discussions: [{ question: 'Q1？', excerpts: [{ q: '不该出现的原文', a: '也不该出现' }] }],
    }],
  })
  assert.ok(rp.includes('- n_a：「A」'), '节点 = id + point')
  assert.ok(rp.includes('（能指："a1"）'), '能指在')
  assert.ok(rp.includes('（讨论过："Q1？"）'), '讨论过的问题在')
  assert.ok(!rp.includes('不该出现的原文'), '讨论原文不进提示词（2026-08-27 定调）')
  // 2026-09 缓存定调：节点列表（静态大头）在用户发言（每次必变）**之前**——
  // 前缀缓存只认"从头连续相同"，发言在最后才能让节点列表全命中（实测 0%→92%）
  assert.ok(rp.indexOf('知识点节点：') < rp.indexOf('用户发言："M？"'),
    '节点材料在用户发言之前（前缀缓存：静态在前、可变在最后）')
})

test('解析：parseReferenceResult 容错（围栏、前言）', () => {
  assert.deepEqual(parseReferenceResult('{"hits":[]}'), { hits: [] })
  assert.deepEqual(parseReferenceResult('{"hits":["n_x","","n_x","n_y"]}'), { hits: ['n_x', 'n_y'] }, '去空去重保序')
  assert.equal(parseReferenceResult('{"hits":[{"nodeId":"n_x"}]}'), null, 'hits 必须是 id 数组（2026-08-27 定调：协议去掉 quote 对象）')
})
