/**
 * translate-protocol.js 的单测：只覆盖纯函数，不涉及 chrome.* 与 DOM。
 * 运行：node --test extension/test/　或　node extension/test/translate-protocol.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_PROMPT,
  RELOCATE_PROMPT,
  RETRANSLATE_PROMPT,
  RETRY_PROMPT,
  SELECTION_PROMPT,
  PROMPT_VERSION,
  buildChatBody,
  buildImageContent,
  buildRelocatePrompt,
  buildTextContent,
  chatCompletionsUrl,
  classifyFetchError,
  classifyHttpError,
  extractReplyText,
  isVisionUnsupported,
  normalizeApiBase,
  originPattern,
  parseRelocateReply,
  parseTranslation,
  relocateSnippet,
  stripCodeFence,
} from '../translate-protocol.js'

// ── prompt ────────────────────────────────────────────────────────────────────
test('IMAGE_PROMPT 要求 JSON 输出并锁定 original/translation 两个字段', () => {
  assert.match(IMAGE_PROMPT, /original/)
  assert.match(IMAGE_PROMPT, /translation/)
  assert.match(IMAGE_PROMPT, /JSON/)
  assert.match(IMAGE_PROMPT, /简体中文/)
  assert.ok(PROMPT_VERSION >= 1)
})

test('三个 prompt 都是非空字符串', () => {
  for (const p of [IMAGE_PROMPT, RETRANSLATE_PROMPT, SELECTION_PROMPT, RETRY_PROMPT]) {
    assert.equal(typeof p, 'string')
    assert.ok(p.trim().length > 20)
  }
})

test('SELECTION_PROMPT 只要求 translation，且不提截图识别误差', () => {
  assert.match(SELECTION_PROMPT, /translation/)
  assert.match(SELECTION_PROMPT, /简体中文/)
  assert.doesNotMatch(SELECTION_PROMPT, /截图/)
  // 划词来源是页面真实文本，与重译 prompt 必须是两个不同的常量
  assert.notEqual(SELECTION_PROMPT, RETRANSLATE_PROMPT)
  assert.match(RETRANSLATE_PROMPT, /截图/)
})

// ── 地址与请求体 ──────────────────────────────────────────────────────────────
test('normalizeApiBase 去掉尾部斜杠与空白', () => {
  assert.equal(normalizeApiBase(' https://api.deepseek.com/v1/ '), 'https://api.deepseek.com/v1')
  assert.equal(normalizeApiBase(undefined), '')
})

test('chatCompletionsUrl 拼出 /chat/completions', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
})

test('originPattern 产出 chrome.permissions.request 需要的 origin 模式', () => {
  assert.equal(originPattern('https://api.deepseek.com/v1'), 'https://api.deepseek.com/*')
  assert.equal(originPattern('http://localhost:11434/v1'), 'http://localhost:11434/*')
})

test('originPattern 对非法地址抛错', () => {
  assert.throws(() => originPattern('not-a-url'))
})

test('buildChatBody 只放 user 消息，图片不会落到 system', () => {
  const body = buildChatBody({ model: 'deepseek-flash', content: [{ type: 'text', text: 'hi' }] })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 2048)
})

test('buildImageContent 产出 text + image_url 两个块', () => {
  const content = buildImageContent(IMAGE_PROMPT, 'data:image/png;base64,AAA')
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAA')
})

test('buildTextContent 把 prompt 与正文拼在一个文本块里', () => {
  const content = buildTextContent('翻译下面', 'hello')
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.includes('翻译下面'))
  assert.ok(content[0].text.includes('hello'))
})

// ── 取回复 ────────────────────────────────────────────────────────────────────
test('extractReplyText 取字符串正文', () => {
  const payload = { choices: [{ message: { content: '  译文  ' } }] }
  assert.equal(extractReplyText(payload), '译文')
})

test('extractReplyText 支持数组形态的 content', () => {
  const payload = { choices: [{ message: { content: [{ text: 'A' }, { text: 'B' }] } }] }
  assert.equal(extractReplyText(payload), 'AB')
})

test('extractReplyText 在 content 为空时回退 reasoning_content', () => {
  const payload = { choices: [{ message: { content: '', reasoning_content: '思考' } }] }
  assert.equal(extractReplyText(payload), '思考')
})

test('extractReplyText 拿不到内容时返回空串', () => {
  assert.equal(extractReplyText({}), '')
  assert.equal(extractReplyText({ choices: [{ message: { content: '   ' } }] }), '')
  assert.equal(extractReplyText(null), '')
})

// ── 解析译文 ──────────────────────────────────────────────────────────────────
test('parseTranslation 解析标准 JSON', () => {
  const out = parseTranslation('{"original":"Hello","translation":"你好"}')
  assert.deepEqual(out, { original: 'Hello', translation: '你好' })
})

test('parseTranslation 容忍代码块包裹', () => {
  const raw = '```json\n{"original":"Hello","translation":"你好"}\n```'
  assert.deepEqual(parseTranslation(raw), { original: 'Hello', translation: '你好' })
})

test('stripCodeFence 只剥掉最外层围栏', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}')
})

test('parseTranslation 容忍 JSON 前后有多余文字', () => {
  const raw = '好的，结果是：{"original":"Hello","translation":"你好"} 以上。'
  assert.deepEqual(parseTranslation(raw), { original: 'Hello', translation: '你好' })
})

test('parseTranslation 缺 original 时返回空串，不抛错', () => {
  // 重译路径只回 translation
  assert.deepEqual(parseTranslation('{"translation":"你好"}'), { original: '', translation: '你好' })
})

test('parseTranslation 三种失败都抛 PARSE_ERROR', () => {
  for (const raw of ['没有 JSON', '{"original":"Hello"}', '{"translation":"   "}', '[1,2]']) {
    assert.throws(() => parseTranslation(raw), (e) => e.code === 'PARSE_ERROR', 'raw=' + raw)
  }
})

// ── 错误分类 ──────────────────────────────────────────────────────────────────
test('isVisionUnsupported 只看 400/404/422 且正文提到图片', () => {
  assert.equal(isVisionUnsupported(400, 'this model does not support image input'), true)
  assert.equal(isVisionUnsupported(400, '不支持图片输入'), true)
  assert.equal(isVisionUnsupported(400, 'invalid request: temperature'), false)
  assert.equal(isVisionUnsupported(401, 'image not allowed'), false)
})

test('classifyHttpError 把 400 图片不支持映射成 MODEL_NO_VISION', () => {
  const out = classifyHttpError(400, '{"error":{"message":"This model does not support image input"}}')
  assert.equal(out.code, 'MODEL_NO_VISION')
  assert.match(out.message, /自定义模型配置/)
  assert.match(out.message, /支持图片/)
})

test('classifyHttpError 覆盖 401 / 404 / 413 / 429 / 5xx', () => {
  assert.equal(classifyHttpError(401, 'unauthorized').code, 'BAD_KEY')
  assert.equal(classifyHttpError(403, 'forbidden').code, 'BAD_KEY')
  assert.equal(classifyHttpError(404, 'model not found').code, 'BAD_ENDPOINT')
  assert.equal(classifyHttpError(413, 'too large').code, 'TOO_LARGE')
  assert.equal(classifyHttpError(429, 'rate limited').code, 'RATE_LIMIT')
  assert.equal(classifyHttpError(500, 'boom').code, 'UPSTREAM')
  assert.equal(classifyHttpError(400, 'bad temperature').code, 'UPSTREAM')
})

test('classifyHttpError 截断过长的上游正文', () => {
  const out = classifyHttpError(500, 'x'.repeat(5000))
  assert.ok(out.detail.length <= 200)
})

test('classifyFetchError 区分超时、连不上与未知', () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(classifyFetchError(abort).code, 'TIMEOUT')

  const netErr = new TypeError('Failed to fetch')
  assert.equal(classifyFetchError(netErr).code, 'NETWORK')
  assert.match(classifyFetchError(netErr).message, /授权/)

  assert.equal(classifyFetchError(new Error('怪错')).code, 'UNKNOWN')
})

// ── 重新定位（画布书专用：让模型看着屏幕找文字）──────────────────────────────
test('buildRelocatePrompt 把原文与位置提示都填进去', () => {
  const p = buildRelocatePrompt('the quick brown fox', { x: 0.25, y: 0.5 })
  assert.ok(p.includes('the quick brown fox'))
  assert.ok(p.includes('x=0.250'))
  assert.ok(p.includes('y=0.500'))
  assert.ok(!p.includes('{text}') && !p.includes('{hx}') && !p.includes('{hy}'))
})

test('buildRelocatePrompt 截断超长原文并夹紧非法提示坐标', () => {
  const p = buildRelocatePrompt('あ'.repeat(900), { x: 9, y: -3 })
  assert.ok(!p.includes('あ'.repeat(301)))
  assert.ok(p.includes('x=1.000'))
  assert.ok(p.includes('y=0.000'))
  // 没给提示也不能出现占位符残留
  const bare = buildRelocatePrompt('hello world')
  assert.ok(!/\{h[xy]\}/.test(bare))
})

test('RELOCATE_PROMPT 要求只输出比例坐标 JSON', () => {
  assert.match(RELOCATE_PROMPT, /JSON/)
  assert.match(RELOCATE_PROMPT, /0~1/)
  assert.match(RELOCATE_PROMPT, /不要输出任何解释/)
})

test('parseRelocateReply 解析标准输出与代码块包裹', () => {
  assert.deepEqual(parseRelocateReply('{"x":0.1,"y":0.2,"w":0.5,"h":0.06}').box,
    { x: 0.1, y: 0.2, w: 0.5, h: 0.06 })
  const fenced = '```json\n{"x":0,"y":0.5,"w":1,"h":0.1}\n```'
  const r = parseRelocateReply(fenced)
  assert.equal(r.reason, 'ok')
  assert.deepEqual(r.box, { x: 0, y: 0.5, w: 1, h: 0.1 })
})

test('parseRelocateReply 容忍前后多余文字并夹紧越界坐标', () => {
  const out = parseRelocateReply('好的，结果是：{"x":-0.2,"y":1.4,"w":2,"h":0.05}')
  assert.equal(out.reason, 'ok')
  assert.deepEqual(out.box, { x: 0, y: 1, w: 1, h: 0.05 })
})

test('parseRelocateReply 把"画面上看不到"（全 0）与格式错误分开', () => {
  // 全 0 = 模型明确说看不到 → 要提示用户滚动，而不是"格式错误"
  const none = parseRelocateReply('{"x":0,"y":0,"w":0,"h":0}')
  assert.equal(none.reason, 'notvisible')
  assert.equal(none.box, null)

  for (const bad of ['{"x":0.1,"y":0.2,"w":0.5}', '没有找到这段文字', '', null, '{不是 JSON}']) {
    const r = parseRelocateReply(bad)
    assert.equal(r.reason, 'badformat', JSON.stringify(bad))
    assert.equal(r.box, null)
  }
})

test('parseRelocateReply 拒绝过小的框（避免把噪点当结果）', () => {
  assert.equal(parseRelocateReply('{"x":0.5,"y":0.5,"w":0.001,"h":0.05}').reason, 'badformat')
  assert.equal(parseRelocateReply('{"x":0.5,"y":0.5,"w":0.3,"h":0.0001}').reason, 'badformat')
  assert.equal(parseRelocateReply('{"x":0.5,"y":0.5,"w":0.02,"h":0.01}').reason, 'ok')
})

test('parseRelocateReply 保留模型原话供排查，且截断', () => {
  assert.equal(parseRelocateReply('我找不到').raw, '我找不到')
  assert.ok(parseRelocateReply('x'.repeat(900)).raw.length <= 200)
})

test('relocateSnippet 折叠空白并在词边界截断', () => {
  assert.equal(relocateSnippet('  a\n\n b   c '), 'a b c')
  assert.equal(relocateSnippet('short'), 'short')
  // 80 字以内原样返回；超长在空格处断，不留半个单词
  const long = 'word '.repeat(40).trim()          // 199 字
  const cut = relocateSnippet(long, 80)
  assert.ok(cut.length <= 80)
  assert.ok(!cut.endsWith(' '))
  assert.ok(long.startsWith(cut + ' '))
  // 一整串没有空格的（中日文）就直接切
  assert.equal(relocateSnippet('あ'.repeat(200), 80).length, 80)
})

test('buildRelocatePrompt 用的是短片段而不是整段原文', () => {
  const p = buildRelocatePrompt('word '.repeat(60), { x: 0.1, y: 0.2 })
  assert.ok(!p.includes('word '.repeat(60).trim()))
  assert.ok(p.includes(relocateSnippet('word '.repeat(60))))
  assert.match(p, /开头一部分/)
})
