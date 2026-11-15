import test from 'node:test'
import assert from 'node:assert/strict'
import { groupExcerpts, discussionBlock } from '../lib/discussion-text.js'
import { buildQuestionPrompt } from '../lib/thread-question.js'
import { buildPointPrompt, buildAliasPrompt } from '../lib/knowledge-graph.js'

test('收口材料保留本轮划线与出处，不串到下一轮，也不改变旧问答格式', () => {
  const selected = { text: '他把信撕了，却仍然等着回信。', book: '示例书', chapter: '第三章' }
  const entries = [
    { role: 'user', content: '他为什么这样做？', selected },
    { role: 'assistant', content: '这里有矛盾。' },
    { role: 'user', content: '这种矛盾如何理解？' },
    { role: 'assistant', content: '可以继续分析。' },
  ]
  const excerpts = groupExcerpts(entries)
  assert.deepEqual(excerpts, [
    { q: entries[0].content, a: entries[1].content, selected },
    { q: entries[2].content, a: entries[3].content },
  ])
  assert.notEqual(excerpts[0].selected, selected)
  const material = discussionBlock(excerpts)
  assert.ok(material.includes(selected.text))
  assert.ok(material.includes('示例书 / 第三章'))
  assert.ok(material.includes('不代表用户观点'))
  assert.ok(material.indexOf(selected.text) < material.indexOf(entries[0].content))
  assert.equal(material.split(selected.text).length - 1, 1)

  // 三种总结动作必须读到完全相同的材料，不能只修标题而漏掉问题归纳。
  for (const prompt of [
    buildQuestionPrompt(entries),
    buildPointPrompt({ question: '矛盾是什么？', excerpts }),
    buildAliasPrompt({ point: '行为的矛盾', question: '矛盾是什么？', excerpts }),
  ]) assert.ok(prompt.includes(material))
})

test('旧记录没有划线、空划线，以及相邻提问不会借用上一条划线', () => {
  assert.equal(discussionBlock([{ q: '问题', a: '回答' }]),
    '讨论内容（收口讨论全文，全量提供，不截断）：\n用户："问题"\nAI："回答"')
  assert.deepEqual(groupExcerpts([
    { role: 'user', content: '旧问题', selected: { text: '旧划线' } },
    { role: 'user', content: '新问题', selected: { text: '   ' } },
    { role: 'assistant', content: '新回答' },
  ]), [{ q: '新问题', a: '新回答' }])
})
