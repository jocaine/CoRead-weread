#!/usr/bin/env node
/**
 * 命题递归脑图（HTML/SVG）的契约测试（2026-10-24）
 *
 * 这张图是"看一眼就知道递归长什么样"的唯一出口，所以三类错都必须被测试挡住：
 *   ① **结构错**：子课题没挂到点题的那个下面、没被点题的候选没画出来 → 图会骗人（比没有图更糟）；
 *   ② **几何错**：节点重叠、子节点跑到父节点左边 → 图上看不出层级；
 *   ③ **渲染错**：坐标 NaN、用户原文里的 `<script>` 没转义 → 打开是一片空白或者更糟。
 * 另外钉住 2026-10-24 定下的递归方向：**谁有缺口谁点题，谁有材料谁答题**——
 * 图上每个节点都要写明"派给它的那个题"是谁问的、问的是什么。
 *
 * 跑法：node agent/test/l3-tree.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTraceTree, buildDisplayRoot, layoutTree, renderTreeHtml, openL3Tree } from '../lib/l3-tree.js'

const EV = [
  { type: 'draft', raw: '【方向：甲】\n- 要点', chars: 12, directions: ['甲', '乙'], ms: 4200 },
  { type: 'section', text: '② 命题递归（子节点点题 → 父节点作答）' },
  {
    type: 'report', kid: 'K-1', point: '方向甲的知识点', depth: 0, question: '这条旧讨论里有哪些具体内容？', askedBy: '',
    materialChars: 8035, truncated: true, ms: 6100, task: '用承载三条件量「是不是已经接不住」', taskFrom: 'R1', 
    body: '缺账本，人散',
  },
  {
    type: 'ask', kid: 'K-1', depth: 0, ms: 2100,
    candidates: [{ kid: 'K-1.1', point: '被点题的父' }, { kid: 'K-1.2', point: '用不上的父' }],
    asks: [{ kid: 'K-1.1', question: '那段里有没有被反问的原文？' }], raw: 'K-1.1：那段里有没有被反问的原文？',
  },
  { type: 'report', kid: 'K-2', point: '方向乙的知识点', depth: 0, question: '这条旧讨论里有哪些具体内容？', askedBy: '', materialChars: 1200, aspect: '无关', refused: true, refuseWhy: '这段当时谈的是别的', body: '' },
  {
    type: 'report', kid: 'K-1.1', point: '更早的知识点', depth: 1, askedBy: 'K-1', question: '那段里有没有被反问的原文？',
    materialChars: 500, task: '请说清关于「是不是已经接不住」当时讲过什么', taskFrom: 'K-1', body: '第二次就凑不齐人，名单也留不下来。',
  },
  { type: 'gate', reason: '调用数 10/10' },
  { type: 'aggregate', message: '【草稿】…' },
  { type: 'final', text: '这是终稿', coverage: [{ kid: 'K-1', ratio: 0.61 }, { kid: 'K-1.1', ratio: 0.05 }] },
  { type: 'stats', text: '命中 2 个｜探索调用 4 次' },
]

test('buildTraceTree：子课题挂到"点它的那个"下面，不靠事件顺序猜', () => {
  const t = buildTraceTree(EV, { question: '提问', conv: 'c1' })
  assert.equal(t.tasks.length, 2, '根级只有两个命中课题')
  const k1 = t.tasks[0]
  assert.equal(k1.kid, 'K-1')
  assert.equal(k1.children.length, 2, '一个被点题 + 一个用不上')
  const child = k1.children.find((n) => n.kid === 'K-1.1')
  assert.equal(child.depth, 1)
  assert.equal(child.askedBy, 'K-1')
  assert.equal(child.question, '那段里有没有被反问的原文？')
  assert.match(child.body, /账本|凑不齐/)
})

test('buildTraceTree：没被点题的候选要留成 ghost（那才是"这枝断在哪"的证据）', () => {
  const t = buildTraceTree(EV, {})
  const ghosts = t.tasks[0].children.filter((n) => n.ghost)
  assert.equal(ghosts.length, 1)
  assert.equal(ghosts[0].kid, 'K-1.2')
  assert.equal(ghosts[0].point, '用不上的父')
  assert.equal(t.gate, '调用数 10/10')
  assert.match(t.stats, /探索调用 4 次/)
  assert.equal(t.answer.text, '这是终稿')
})

test('buildTraceTree：点了题却没跑出来的（撞闸/失败）画成"未跑"，不许悄悄消失', () => {
  const t = buildTraceTree([
    { type: 'report', kid: 'K-1', point: 'p', depth: 0,  body: 'c',  },
    { type: 'ask', kid: 'K-1', depth: 0, candidates: [{ kid: 'K-1.1', point: '父' }], asks: [{ kid: 'K-1.1', question: '问什么' }] },
  ], {})
  const kid = t.tasks[0].children.find((n) => n.kid === 'K-1.1')
  assert.ok(kid, '必须出现在图上')
  assert.equal(kid.pending, true)
})

test('buildTraceTree：派题失败要标"未判"（没问成 ≠ 用不上）', () => {
  const t = buildTraceTree([
    { type: 'report', kid: 'K-1', point: 'p', depth: 0,  body: 'c',  },
    { type: 'ask', kid: 'K-1', depth: 0, failed: true, reason: '只出了思考链', candidates: [{ kid: 'K-1.1', point: '父' }], asks: [] },
  ], {})
  const g = t.tasks[0].children[0]
  assert.equal(g.unjudged, true)
  const html = renderTreeHtml({ tree: t, meta: {} })
  assert.match(html, /K-1\.1 〔未判〕/)
  assert.doesNotMatch(html, /〔未追〕/)
})

test('buildTraceTree：子节点按课题号数字序（K-1.2 在 K-1.10 前面）', () => {
  const t = buildTraceTree([
    { type: 'report', kid: 'K-1', point: 'p', depth: 0,  body: 'c' },
    { type: 'report', kid: 'K-1.10', point: 'p10', depth: 1, askedBy: 'K-1',  body: 'c' },
    { type: 'report', kid: 'K-1.2', point: 'p2', depth: 1, askedBy: 'K-1',  body: 'c' },
  ], {})
  assert.deepEqual(t.tasks[0].children.map((n) => n.kid), ['K-1.2', 'K-1.10'])
})

test('buildTraceTree：空事件流也不炸（页面先打开、事件还没来）', () => {
  const t = buildTraceTree([], { question: '' })
  assert.deepEqual(t.tasks, [])
  assert.equal(t.answer, null)
  const html = renderTreeHtml({ tree: t, meta: {} })
  assert.match(html, /没有走命题递归/)
})

test('layoutTree：节点不重叠、子节点在父节点右边、坐标都是有限数', () => {
  const root = buildDisplayRoot(buildTraceTree(EV, { question: '提问' }))
  const { nodes, width, height } = layoutTree(root)
  for (const n of nodes) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(n[k]), `${n.kind} 的 ${k} 不是数`)
    assert.ok(n.w > 0 && n.h > 0)
  }
  for (const n of nodes) {
    for (const c of n.children || []) {
      assert.ok(c.x > n.x, '子节点必须更靠右（从左往右读）')
      if (n.children.length === 1) {
        assert.ok(c.y >= n.y && c.y + c.h <= n.y + n.h, '单孩子应当被父节点盖住')
      }
    }
    if ((n.children || []).length > 1) {
      const first = n.children[0]
      const last = n.children[n.children.length - 1]
      assert.ok(n.y + n.h > first.y && n.y < last.y + last.h, `${n.kid || n.kind} 不在孩子区间里，连线会往回勾`)
    }
  }
  const byCol = new Map()
  for (const n of nodes) {
    if (!byCol.has(n.x)) byCol.set(n.x, [])
    byCol.get(n.x).push(n)
  }
  for (const [x, list] of byCol) {
    list.sort((a, b) => a.y - b.y)
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].y >= list[i - 1].y + list[i - 1].h, `x=${x} 这一列有两个节点重叠`)
    }
  }
  assert.ok(width > 0 && height > 0)
})

test('renderTreeHtml：每个节点写明"派给它的课题"是谁问的（图不能只说查了哪个知识点）', () => {
  const t = buildTraceTree(EV, { question: '提问' })
  const html = renderTreeHtml({ tree: t, meta: {} })
  // 每层都有一道题：命中层由 R1 派
  assert.match(html, /课题（R1 派）：/)
  assert.match(html, /课题（K-1 派）：/)
  assert.match(html, /K-1\.1 〔来路 1 跳 · K-1 点题〕/)
  assert.match(html, /课题（R1 派）：/)
})

test('renderTreeHtml：用户原文必须转义（提问里放 <script> 不能直接进页面）', () => {
  const t = buildTraceTree(EV, { question: '<script>alert(1)</script> & "引号"' })
  const html = renderTreeHtml({ tree: t, meta: { stamp: 's1' } })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, '原文里的脚本标签必须被转义')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&amp; &quot;引号&quot;/)
})

test('renderTreeHtml：这一轮的关键结论都在图上（不然图就没用了）', () => {
  const t = buildTraceTree(EV, { question: '我想到之前聊过的那个机制', conv: 'book_x' })
  const html = renderTreeHtml({ tree: t, meta: { stamp: '2026-10-24T14-00-00' } })
  assert.match(html, /K-1 〔命中〕/)
  assert.match(html, /用承载三条件量「是不是已经接不住」/)
  assert.match(html, /拒绝交付/)
  assert.match(html, /K-1\.2 〔未追〕/, '没被点题的枝要看得出是"未追"')
  assert.match(html, /兜底闸：调用数 10\/10/)
  assert.match(html, /这是终稿/)
  assert.match(html, /覆盖度 K-1 61%/, '终稿节点要带覆盖度')
  assert.doesNotMatch(html, /NaN|undefined|\[object Object\]/)
})

test('renderTreeHtml：没有外部依赖（断网也能看）', () => {
  const html = renderTreeHtml({ tree: buildTraceTree(EV, { question: 'q' }), meta: {} })
  assert.doesNotMatch(html, /src="http|href="http|@import|fetch\(/)
})

test('renderTreeHtml：详情文字以 HTML 形式给出 .md 链接（同一次递归的两份产物）', () => {
  const html = renderTreeHtml({ tree: buildTraceTree(EV, { question: 'q' }), meta: { stamp: 'abc', mdName: 'abc.md' } })
  assert.match(html, /href="abc\.md"/)
})

test('both 模式：两份终稿都要画出来，给用户看的那份排最前', () => {
  const t = buildTraceTree([
    { type: 'report', kid: 'K-1', point: 'p', depth: 0,  body: 'c' },
    { type: 'final', label: 'B 新路径（这次没给用户看）', text: '新路径的正文', shown: false },
    { type: 'final', label: 'A 旧路径（用户看到的就是这段）', text: '旧路径的正文', shown: true },
  ], { question: '提问' })
  assert.equal(t.answers.length, 2)
  assert.equal(t.answers[0].shown, true, '给用户看的那份必须排第一，否则图上分不清哪份是他看到的')
  assert.equal(t.answer.text, '旧路径的正文')
  const html = renderTreeHtml({ tree: t, meta: { stamp: 's' } })
  assert.match(html, /A 旧路径（用户看到的就是这段）/)
  assert.match(html, /B 新路径（这次没给用户看）/)
  assert.ok(html.indexOf('A 旧路径') < html.indexOf('B 新路径'), 'A 的节点要画在上面')
})

test('openL3Tree：每来一个事件就重写一次（等的时候按 F5 能看到进度）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-tree-'))
  const t = openL3Tree({ dir, stamp: 'run1', meta: { question: '提问' } })
  assert.ok(t.file.endsWith('run1.html'))
  const size1 = fs.statSync(t.file).size
  t.write(EV[0])
  t.write(EV[2])
  t.write(EV[8])
  const html = fs.readFileSync(t.file, 'utf8')
  assert.ok(fs.statSync(t.file).size > size1)
  assert.match(html, /K-1 〔命中〕/)
  assert.match(html, /这是终稿/)
})

test('openL3Tree：目录不可用时静默降级（图画不出来，回答不能挂）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-tree-'))
  const blocker = path.join(dir, 'file-not-dir')
  fs.writeFileSync(blocker, 'x')
  const t = openL3Tree({ dir: blocker, meta: {} })
  assert.equal(t.file, '')
  assert.doesNotThrow(() => t.write({ type: 'draft', chars: 1, directions: [] }))
  assert.doesNotThrow(() => t.render())
})
