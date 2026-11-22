import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDispatchBrief } from '../lib/l3-tasks.js'
import { retrievalTurn, retrieveDiscussion } from '../lib/retrieval-query.js'

const excerpt = '城市只付当期工资，\n养老成本由农村家庭承担。'

test('查旧讨论时只保存简答要求，忽略旧版名单', async () => {
  for (const brief of [true, false]) {
    const question = brief ? '请简短说说孔孟怎么看' : '孔孟各自怎么看'
    const result = await retrieveDiscussion({ question }, {
      rewrite: () => JSON.stringify({ query: null, brief, subjectsFrom: ['孔孟'], subjects: ['孔子', '孟子'] }),
      search: () => assert.fail('没有检索目标'), fallback: () => assert.fail('有效的改写'),
    })
    assert.deepEqual(result.answerForm, brief ? { brief: true, request: question } : undefined)
  }
})

test('侧栏、弹窗、手打引文都把「我没懂」与所指对象分开', () => {
  const variants = [
    { content: `[引用]《示例》\n> "${excerpt.replace('\n', '\n> ')}"\n\n我没懂`, selectedText: '译文所对应的原文' },
    { content: '我没懂', selectedText: excerpt },
    { content: `‘引用：${excerpt}’我没懂` },
    { content: `’引用：${excerpt}‘我没懂` },
    { content: `引用：“${excerpt}”\n我没懂` },
    { content: `> ${excerpt.replace('\n', '\n> ')}\n\n我没懂` },
  ]
  for (const msg of variants) assert.deepEqual(retrievalTurn(msg), { question: '我没懂', quote: excerpt, previous: null })
  assert.equal(retrievalTurn({ content: '「引用：所谓“历史”是这样讲的」我没懂' }).quote, '所谓“历史”是这样讲的')
})

test('带引文的追问只改写一次并查一次向量，查到的节点作为回答备选', async () => {
  const turn = retrievalTurn({ content: '我没懂', selectedText: excerpt })
  const calls = []
  const query = '城市支付当期工资、农村家庭承担养老的分工如何理解'
  const result = await retrieveDiscussion(turn, {
    rewrite: async prompt => {
      calls.push('rewrite')
      assert.deepEqual(JSON.parse(prompt.split('待处理输入：').at(-1)), turn)
      return JSON.stringify({ query })
    },
    search: async input => {
      calls.push('search')
      assert.equal(input, query)
      return [{ id: 'first' }, { id: 'second' }]
    },
    fallback: () => assert.fail('不应走旧解析'),
  })
  assert.deepEqual(calls, ['rewrite', 'search'])
  assert.deepEqual(result, { hits: [], candidates: ['first', 'second'], retrievalQuery: query })
})

test('只贴引文和无可查对象都不送向量；没有候选也不另找命中', async () => {
  const never = () => assert.fail('该步骤不应调用')
  const empty = { hits: [], candidates: [] }
  assert.deepEqual(await retrieveDiscussion(retrievalTurn({ content: '引用：“某句话”' }), {
    rewrite: never, search: never, fallback: never,
  }), empty)
  assert.equal(retrievalTurn({ content: '> 某句话' }).question, '')
  const turn = retrievalTurn({ content: '这是翻译的问题吗？', selectedText: excerpt })
  assert.deepEqual(await retrieveDiscussion(turn, {
    rewrite: () => '{"query":null}', search: never, fallback: never,
  }), empty)
  assert.deepEqual(await retrieveDiscussion(turn, {
    rewrite: () => '{"query":"引文的译法"}', search: () => [], fallback: never,
  }), { ...empty, retrievalQuery: '引文的译法' })
})

test('索引不可用、改写失败或向量异常都返回空材料，绝不调用文字模型命中兜底', async () => {
  const turn = retrievalTurn({ content: '这是翻译的问题吗？', selectedText: excerpt })
  let fallbackCalls = 0
  const fallback = () => { fallbackCalls++; return ['legacy'] }
  const never = () => assert.fail('该步骤不应调用')
  const unavailable = () => { throw new Error('服务不可用') }
  const cases = [
    { rewrite: never },
    { rewrite: () => '{"query":""}', search: never },
    { rewrite: () => '不是有效格式', search: never },
    { rewrite: unavailable, search: never },
    { rewrite: () => '{"query":"引文的译法"}', search: unavailable },
    { rewrite: () => '{"query":"","brief":true}', search: never, brief: true },
  ]
  for (const { brief, ...deps } of cases) {
    const logs = []
    const result = await retrieveDiscussion(turn, { ...deps, fallback, log: message => logs.push(message) })
    assert.deepEqual(result, {
      hits: [], candidates: [],
      ...(brief ? { answerForm: { brief: true, request: turn.question } } : {}),
    })
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('本轮不提供自动检索材料'))
  }
  assert.equal(fallbackCalls, 0)
})

test('检索描述与原话一起进入首轮和后续派题；失败时不添加描述', async () => {
  const question = '我没懂'
  const query = '城市付工资、农村承担养老是什么意思'
  for (const fail of [false, true]) {
    const result = await retrieveDiscussion({ question }, {
      rewrite: () => JSON.stringify({ query }),
      search: () => { if (fail) throw new Error('不可用'); return [{ id: 'n' }] },
      fallback: () => [],
    })
    for (const layer of [0, 1]) {
      const brief = buildDispatchBrief({ question, retrievalQuery: result.retrievalQuery, layer, prevTasks: ['解释分担'], version: '草稿' })
      assert.ok(brief.includes('『我没懂』'))
      assert.equal(brief.includes(query), !fail)
      assert.equal(brief.includes('以原始提问为准'), !fail)
    }
  }
})
