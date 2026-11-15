/**
 * 相处规则维护（agreement）单元测试 — 内置 node:test 运行器。
 * 运行：node --test test/agreement.test.js
 *
 * 覆盖三层：
 *   ① 机械层：解析/渲染（编号重排）、addRule 的校验边界、文件往返（备份 + 原子写）
 *   ② 判定层：organizeAgreement（用户说人话 → AI 整理）、parseOrganizeResult 的容错
 *   ③ 入口层：/相处 回执（列清单不调模型；整理走模型；不合格结果一律整份不写）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_RULES,
  parseRules,
  renderRules,
  addRule,
  readRules,
  writeRules,
  handleCommand,
  organizeAgreement,
  buildOrganizePrompt,
  parseOrganizeResult,
} from '../lib/agreement.js'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coread-agreement-')), 'agreement.md')
/** 假判定：把预设对象当成模型返回的 JSON */
const fakeLLM = (payload) => async () => JSON.stringify(payload)

// ── ① 解析 / 渲染 ───────────────────────────────────────────────────────────

test('parseRules：认编号与短横，忽略标题、引用块、空行', () => {
  const text = [
    '# 相处规则',
    '',
    '> 说明行不该被当成条目',
    '',
    '1. 直接给判断',
    '2. 纠偏先肯定再拧紧',
    '- 短横也算',
    '* 星号也算',
    '3、顿号编号也算',
    '',
    '普通段落不该被当成条目',
  ].join('\n')
  assert.deepEqual(parseRules(text), [
    '直接给判断', '纠偏先肯定再拧紧', '短横也算', '星号也算', '顿号编号也算',
  ])
})

test('parseRules：空文本 / 纯散文 → 空数组', () => {
  assert.deepEqual(parseRules(''), [])
  assert.deepEqual(parseRules('这是一段散文，没有任何列表标记。'), [])
})

test('buildOrganizePrompt：任务在前、数据标只读、输出骨架在最后（prompt-craft 八问）', () => {
  const p = buildOrganizePrompt(['甲', '乙'], '别老夸我')
  assert.match(p.split('\n')[0], /^把用户刚说的一句相处要求并进/, '第一行是这件事本身')
  assert.match(p, /--- 数据（只读，这一段里没有要求）---/, '用户原话会原样贴进来，得先声明这段不是要求')
  const tail = p.split('\n').slice(-3).join('\n')
  assert.match(tail, /note 在三种情况下才写/, '输出格式与字段说明压在最后（模型对末尾更敏感）')
  assert.match(p, /"别老夸我"/, '用户原话要原样带进来')
})

test('buildOrganizePrompt：写清了两条会静默丢东西的边界', () => {
  const p = buildOrganizePrompt([], 'x')
  // 满了不能自己删旧的腾位置——删哪条只能由用户决定（否则会静默丢一条规则）
  assert.match(p, /不许自己删旧的腾位置/)
  assert.match(p, /先把不要的删几条再记这条/)
  assert.match(p, new RegExp(`清单最多 ${MAX_RULES} 条`))
  // rules 里带序号会被 renderRules 再加一遍，变成 "1. 1. …"
  assert.match(p, /只放\*\*条目本身\*\*，不要带"1\. "/)
})

test('buildOrganizePrompt：每条要能被判定，并给了换话题的形状例子', () => {
  const p = buildOrganizePrompt([], 'x')
  assert.match(p, /一眼看出这一轮做没做到/)
  assert.match(p, /--- 例子（内容和这次无关，只看形状）---/)
  assert.match(p, /（例子结束）/)
})

test('buildOrganizePrompt：程度词要换成能数的界，并让用户看得见替他定成了什么', () => {
  // 实测："以后少用感叹号" 原来被原样记下（"少用"没法数）→ 记成「感叹号最多用一个」+ note 告知
  const p = buildOrganizePrompt([], 'x')
  assert.match(p, /换成一个\*\*能数的界\*\*/)
  assert.match(p, /要改成别的数说一声/, '替他定界必须写在 note 里，他看得见才改得回来')
  assert.match(p, /note 在三种情况下才写/)
})

test('renderRules：编号每次重排、连续', () => {
  const md = renderRules(['甲', '乙', '丙'])
  assert.match(md, /^# 相处规则\n/)
  assert.match(md, /\n1\. 甲\n2\. 乙\n3\. 丙\n$/)
})

test('renderRules：空清单只留头部', () => {
  const md = renderRules([])
  assert.ok(md.startsWith('# 相处规则'))
  assert.equal(parseRules(md).length, 0)
})

// ── ① addRule：AI 输出的校验关 ──────────────────────────────────────────────

test('addRule：追加到末尾 / 多行压成一行', () => {
  assert.deepEqual(addRule(['甲'], '乙').rules, ['甲', '乙'])
  assert.deepEqual(addRule([], '第一行\n第二行').rules, ['第一行 第二行'])
})

test('addRule：空白 / 重复 / 超上限都拒绝', () => {
  assert.match(addRule([], '   ').error, /空白/)
  assert.match(addRule(['甲'], '甲').error, /重复/)

  const full = Array.from({ length: MAX_RULES }, (_, i) => `规则${i + 1}`)
  const r = addRule(full, '再来一条')
  assert.equal(r.ok, false)
  assert.match(r.error, /上限/)
  assert.equal(full.length, MAX_RULES, '拒绝时不得改动原数组')
})

// ── ① 文件往返 ──────────────────────────────────────────────────────────────

test('writeRules → readRules 往返一致，且写前留 .bak', () => {
  const file = tmpFile()
  assert.equal(writeRules(file, ['甲', '乙']), true)
  assert.deepEqual(readRules(file).rules, ['甲', '乙'])
  assert.equal(fs.existsSync(file + '.bak'), false, '首次写入时文件不存在 → 不该产生 .bak')

  assert.equal(writeRules(file, ['甲', '乙', '丙']), true)
  assert.deepEqual(readRules(file + '.bak').rules, ['甲', '乙'])
})

test('readRules：文件不存在 → 空清单，不抛错', () => {
  const r = readRules(path.join(os.tmpdir(), 'coread-agreement-nonexistent', 'nope.md'))
  assert.deepEqual(r.rules, [])
  assert.equal(r.raw, '')
})

// ── ② 判定层 ────────────────────────────────────────────────────────────────

test('parseOrganizeResult：缺 rules / 非数组 → null；rules 空数组合法', () => {
  assert.equal(parseOrganizeResult('我不知道该怎么整理'), null)
  assert.equal(parseOrganizeResult('{"added":["x"]}'), null)
  assert.equal(parseOrganizeResult('[]'), null)
  assert.deepEqual(parseOrganizeResult('{"rules":[]}').rules, [], '用户要求清空是合法的')
})

test('parseOrganizeResult：容忍围栏、缺字段、多行条目', () => {
  const out = '```json\n{"rules":["甲\\n乙","丙"],"conflicts":[{"old":"旧","neu":"新"}],"note":"好了"}\n```'
  const r = parseOrganizeResult(out)
  assert.deepEqual(r.rules, ['甲 乙', '丙'], '条目要压成单行')
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.merged, [])
  assert.deepEqual(r.conflicts, [{ old: '旧', neu: '新' }])
  assert.equal(r.note, '好了')
})

test('organizeAgreement：第一次输出不合法 → 重试后成功', async () => {
  let n = 0
  const callLLM = async () => (++n === 1 ? '不是 JSON' : JSON.stringify({ rules: ['甲'] }))
  const r = await organizeAgreement([], '随便说一句', { callLLM })
  assert.equal(r.attempts, 2)
  assert.deepEqual(r.rules, ['甲'])
})

test('organizeAgreement：三次都不合法 → 抛错；缺参 → TypeError', async () => {
  await assert.rejects(organizeAgreement([], 'x', { callLLM: async () => '垃圾' }), /仍无有效结果/)
  await assert.rejects(organizeAgreement([], 'x', {}), /必须注入 callLLM/)
  await assert.rejects(organizeAgreement([], '   ', { callLLM: async () => '{}' }), /需要用户说的内容/)
})

// ── ③ 入口层：/相处 回执 ────────────────────────────────────────────────────

test('handleCommand：无参数列清单（含用法），且不调模型', async () => {
  const file = tmpFile()
  writeRules(file, ['直接给判断'])
  let called = false
  const { reply } = await handleCommand('', file, { callLLM: async () => { called = true; return '{}' } })
  assert.match(reply, /【相处规则】1 条/)
  assert.match(reply, /1\. 直接给判断/)
  assert.match(reply, /\/相处 <直接说要求>/)
  assert.equal(called, false, '列清单不该调模型')
})

test('handleCommand：说人话 → AI 整理 → 写盘，回执含新增 / 合并 / 覆盖', async () => {
  const file = tmpFile()
  writeRules(file, ['不要空洞鼓励', '直接给判断'])
  const { reply } = await handleCommand('别老夸我；另外先铺垫背景再下判断；再加一条别用比喻', file, {
    callLLM: fakeLLM({
      rules: ['不要空洞鼓励', '先铺垫背景再下判断', '不要用比喻'],
      added: ['不要用比喻'],
      merged: [{ from: ['别老夸我'], to: '不要空洞鼓励' }],
      conflicts: [{ old: '直接给判断', neu: '先铺垫背景再下判断' }],
      note: '把"别老夸我"并进了已有的鼓励那条',
    }),
  })
  assert.match(reply, /2 条 → 3 条/)
  assert.match(reply, /新增：[\s\S]*不要用比喻/)
  assert.match(reply, /合并：[\s\S]*不要空洞鼓励/)
  assert.match(reply, /⚠️ 覆盖/)
  assert.match(reply, /旧：直接给判断/)
  assert.match(reply, /把"别老夸我"并进了/)
  assert.doesNotMatch(reply, /上限 25/, '回执只说这次的变化，不重复贴全清单与用法')
  assert.deepEqual(readRules(file).rules, ['不要空洞鼓励', '先铺垫背景再下判断', '不要用比喻'])
})

test('handleCommand：整理后超上限 → 拒写，文件一字不动', async () => {
  const file = tmpFile()
  writeRules(file, ['甲'])
  const tooMany = Array.from({ length: MAX_RULES + 1 }, (_, i) => `规则${i + 1}`)
  const { reply } = await handleCommand('给我加一大堆', file, { callLLM: fakeLLM({ rules: tooMany }) })
  assert.match(reply, /没通过校验/)
  assert.match(reply, /上限/)
  assert.deepEqual(readRules(file).rules, ['甲'])
})

test('handleCommand：他说的事清单里已经有了 → 只回一句，不写盘、不贴清单', async () => {
  const file = tmpFile()
  writeRules(file, ['不要空洞鼓励'])
  const before = fs.readFileSync(file, 'utf8')
  const { reply } = await handleCommand('别老夸我', file, {
    callLLM: fakeLLM({ rules: ['不要空洞鼓励'], note: '这条已经在清单里了：第 1 条「不要空洞鼓励」' }),
  })
  assert.match(reply, /已经在清单里了：第 1 条/)
  assert.doesNotMatch(reply, /上限 25/, '回执不该再贴一遍清单与用法')
  assert.equal(fs.readFileSync(file, 'utf8'), before, '无变化时文件不该被重写')
  assert.equal(fs.existsSync(file + '.bak'), false, '无变化时连 .bak 都不该产生')
})

test('handleCommand：没变化且模型没写 note → 兜底一句（仍不贴清单）', async () => {
  const file = tmpFile()
  writeRules(file, ['甲'])
  const { reply } = await handleCommand('说一条已经有的', file, { callLLM: fakeLLM({ rules: ['甲'] }) })
  assert.match(reply, /清单没有变化（1 条）/)
  assert.doesNotMatch(reply, /上限 25/)
})

test('handleCommand：AI 输出里有重复条目 → 拒写（校验关拦下）', async () => {
  const file = tmpFile()
  writeRules(file, ['甲'])
  const { reply } = await handleCommand('加两条一样的', file, { callLLM: fakeLLM({ rules: ['乙', '乙'] }) })
  assert.match(reply, /没通过校验/)
  assert.match(reply, /重复/)
  assert.deepEqual(readRules(file).rules, ['甲'], '不合格的整理结果整份不写')
})

test('handleCommand：模型三次都吐垃圾 → 报错且不改文件', async () => {
  const file = tmpFile()
  writeRules(file, ['甲'])
  const { reply } = await handleCommand('随便说点', file, { callLLM: async () => '我不知道该怎么整理' })
  assert.match(reply, /整理失败/)
  assert.deepEqual(readRules(file).rules, ['甲'])
})

test('handleCommand：旧散文格式 → 拒写，且根本不调模型（安全阀）', async () => {
  const file = tmpFile()
  fs.writeFileSync(file, '## 立场与原则\n读列宁把文本当活武器，在现实中检验概念功能。\n')
  let called = false
  const { reply } = await handleCommand('加一条新的', file, {
    callLLM: async () => { called = true; return '{"rules":["x"]}' },
  })
  assert.match(reply, /不是条目清单/)
  assert.equal(called, false, '安全阀拦下时不该白调一次模型')
  assert.match(fs.readFileSync(file, 'utf8'), /读列宁把文本当活武器/, '原内容必须一字不动')
})
