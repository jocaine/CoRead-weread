/**
 * 收件箱去重台账 + 游标语义单测（lib/inbox-dedupe.js）—— 内置 node:test。
 *
 * 回归点（2026-09-28《大国大城》实例）：288 条旧提问被重放，前 75 条答成重复回答，
 * 余额耗尽后 213 条各写一个 ⚠️ 402 气泡散进 5 本书的历史。两处根因：
 *   ① 旧格式台账把含换行的指纹原样 append → 跨重启按行读回来只剩碎片（本文件第 2、3 组测试）
 *   ② 游标"读失败"被兜底成 0 = 从第 0 行重扫（第 4、5 组测试）
 * 这些用例把修复口径钉住：格式必须一行一条、迁移必须还原完整指纹、未知游标绝不当作 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fingerprintOf, encodeRecord, serializeFingerprints, loadFingerprints,
  shouldSkip, parseCursorRaw, decideCursor, seedPlan,
} from '../lib/inbox-dedupe.js'

// 真实形态：[引用] 型消息正文第 15~66 字就是换行（所以指纹本身跨行）
const quoted = { timestamp: 1785908850179, content: '[引用]《静静的顿河：全三册  三十二》\n> "“小心点儿吧，伙计！"\n\n这段是在警惕什么？' }
const plain = { timestamp: 1785944626052, content: '哥萨克的政治立场到底是什么样的，属于富农吗' }

test('fingerprintOf：时间戳 + 正文前 80 字；缺字段不抛错', () => {
  assert.equal(fingerprintOf(plain), '1785944626052|哥萨克的政治立场到底是什么样的，属于富农吗')
  assert.match(fingerprintOf(quoted), /^1785908850179\|\[引用\]《/)
  assert.ok(fingerprintOf(quoted).includes('\n'), '引用型消息的指纹本身含换行——这正是旧格式的病根')
  assert.equal(fingerprintOf(null), '0|')
})

test('旧格式（原样 append）读回来必然失配：这是 2026-09-28 的根因', () => {
  const legacyText = [quoted, plain].map((m) => fingerprintOf(m) + '\n').join('')  // 旧写入方式
  const oldSet = new Set(legacyText.split('\n').filter(Boolean))                   // 旧读取方式
  assert.equal(oldSet.has(fingerprintOf(quoted)), false, '跨行指纹在旧读取方式下永远匹配不上')
  assert.equal(oldSet.has(fingerprintOf(plain)), true, '单行指纹不受影响——所以 153 条安然无恙、291 条集体失守')
})

test('新格式一行一条：换行被转义，写入再读回完全一致', () => {
  const text = serializeFingerprints(new Map([[fingerprintOf(quoted), true], [fingerprintOf(plain), true]]))
  assert.equal(text.split('\n').filter(Boolean).length, 2, '两条记录恒占两行（旧格式这里是 3 行）')
  const { states, stats } = loadFingerprints(text, [quoted, plain])
  assert.equal(stats.legacy, 0, '新格式不含旧行')
  assert.equal(shouldSkip(states, fingerprintOf(quoted)), true)
  assert.equal(shouldSkip(states, fingerprintOf(plain)), true)
})

test('迁移：旧文件的碎片按 chat_input 现有消息还原成完整指纹', () => {
  const legacyText = [quoted, plain].map((m) => fingerprintOf(m) + '\n').join('')
  const { states, stats } = loadFingerprints(legacyText, [quoted, plain])
  assert.ok(stats.legacy > 0, '识别出旧行')
  assert.equal(stats.restored, 1, '只有跨行那条需要靠"首行碎片"还原')
  assert.equal(stats.complete, 1, '单行那条本来就是完整记录')
  assert.equal(shouldSkip(states, fingerprintOf(quoted)), true, '还原后跨行消息不再被重发')
  assert.equal(shouldSkip(states, fingerprintOf(plain)), true)
})

test('迁移不冤屈新消息：队列里从没回复过的提问必须保持"待回答"', () => {
  const legacyText = fingerprintOf(quoted) + '\n'
  const fresh = { timestamp: 1790533000000, content: '这是 agent 关机期间提的新问题' }
  const { states } = loadFingerprints(legacyText, [quoted, fresh])
  assert.equal(shouldSkip(states, fingerprintOf(fresh)), false, '没有碎片支撑 → 不当作已回复')
})

test('失败记录可重试：ok=false 不跳过，且后写的记录覆盖先写的', () => {
  const fp = fingerprintOf(plain)
  const failed = serializeFingerprints(new Map([[fp, false]]))
  assert.equal(shouldSkip(loadFingerprints(failed, []).states, fp), false, '试过但失败 → 下次仍要重试')

  const both = encodeRecord(fp, true) + '\n' + encodeRecord(fp, false) + '\n'
  assert.equal(shouldSkip(loadFingerprints(both, []).states, fp), false, '最后一次记录生效（先成功后被改判失败）')
  const reversed = encodeRecord(fp, false) + '\n' + encodeRecord(fp, true) + '\n'
  assert.equal(shouldSkip(loadFingerprints(reversed, []).states, fp), true, '失败后重试成功 → 不再重发')
})

test('兼容历史中间格式："一行一条 JSON 字符串"也认作已回复', () => {
  const fp = fingerprintOf(quoted)
  const text = JSON.stringify(fp) + '\n'
  const { states, stats } = loadFingerprints(text, [])
  assert.equal(stats.legacy, 0)
  assert.equal(shouldSkip(states, fp), true)
})

test('parseCursorRaw：读失败（null）是"未知"，不是 0', () => {
  assert.deepEqual(parseCursorRaw(null), { ok: false, value: 0 }, 'null = 读失败（共享冲突/权限/rename 空窗）')
  assert.deepEqual(parseCursorRaw(undefined), { ok: false, value: 0 })
  assert.deepEqual(parseCursorRaw(''), { ok: true, value: 0 }, '文件为空 = 首次运行，这个 0 是合法的')
  assert.deepEqual(parseCursorRaw(' 12 \n'), { ok: true, value: 12 })
  assert.deepEqual(parseCursorRaw('abc'), { ok: true, value: 0 }, '内容坏了也不当故障')
})

test('decideCursor：读失败 / 游标未知 / 空读 一律"本轮跳过"，绝不写游标', () => {
  assert.deepEqual(decideCursor({ readFailed: true, cursorOk: true, cursor: 446, lineCount: 446 }),
    { action: 'retry-later', reason: 'read-failed' })
  assert.deepEqual(decideCursor({ cursorOk: false, cursor: 0, lineCount: 444 }),
    { action: 'retry-later', reason: 'cursor-unknown' }, '游标读失败被兜底成 0 就是 2026-09-28 的重放起点')
  assert.deepEqual(decideCursor({ cursorOk: true, cursor: 446, lineCount: 0 }),
    { action: 'retry-later', reason: 'empty-read' }, '写入方正在原地重写时的半截读：跳过，不把 446 钳成 0')
  assert.deepEqual(decideCursor({ cursorOk: true, cursor: 0, lineCount: 0 }), { action: 'idle' })
})

test('decideCursor：越界才钳位（钳到行数、不归零），正常情况从游标处处理', () => {
  assert.deepEqual(decideCursor({ cursorOk: true, cursor: 446, lineCount: 444 }),
    { action: 'clamp', value: 444, reason: 'cursor-beyond-eof' }, '文件被删过：钳到当前行数（AI-011：不要归零重扫）')
  assert.deepEqual(decideCursor({ cursorOk: true, cursor: 444, lineCount: 444 }), { action: 'idle' })
  assert.deepEqual(decideCursor({ cursorOk: true, cursor: 440, lineCount: 444 }), { action: 'process', from: 440 })
})

test('seedPlan：台账丢失时只把"游标之前"的消息当作已处理，游标之后的仍会回答', () => {
  assert.deepEqual(seedPlan({ lineCount: 444, cursor: { ok: true, value: 440 } }), { upto: 440 },
    '关机期间攒下的 4 条提问不能被种子吞掉')
  assert.deepEqual(seedPlan({ lineCount: 444, cursor: { ok: false, value: 0 } }), { upto: 444 },
    '游标不可信时保守处理：全部当作已处理，避免全量重放')
  assert.deepEqual(seedPlan({ lineCount: 444, cursor: { ok: true, value: 0 } }), { upto: 444 })
  assert.deepEqual(seedPlan({ lineCount: 0, cursor: { ok: true, value: 0 } }), { upto: 0 })
})
