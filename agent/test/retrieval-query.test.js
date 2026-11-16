import test from 'node:test'
import assert from 'node:assert/strict'
import { retrievalTurn, retrieveDiscussion } from '../lib/retrieval-query.js'

const excerpt = '城市只付当期工资，\n养老成本由农村家庭承担。'

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
  assert.deepEqual(result, { hits: [], candidates: ['first', 'second'] })
})

test('只贴引文和无可查对象都不送向量；坏输出/向量异常才退回原问题', async () => {
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
  }), empty)
  const fallback = question => {
    assert.equal(question, '这是翻译的问题吗？')
    return ['legacy']
  }
  const legacy = { hits: ['legacy'], candidates: [] }
  assert.deepEqual(await retrieveDiscussion(turn, { rewrite: () => '{"query":""}', search: never, fallback }), legacy)
  assert.deepEqual(await retrieveDiscussion(turn, {
    rewrite: () => '{"query":"引文的译法"}', search: () => { throw new Error('网络失败') }, fallback,
  }), legacy)
  assert.deepEqual(await retrieveDiscussion(turn, { rewrite: never, fallback }), legacy)
})
