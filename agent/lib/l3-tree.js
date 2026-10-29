#!/usr/bin/env node
/**
 * 命题递归的脑图（2026-10-24，调试用）
 *
 * 为什么是"图"不是"日志"：这套递归的形状是树——一个提问分出几个课题、每个课题沿来路追几层、
 * 哪几枝被 R3 判掉。日志是线性的，看树的结构很费劲；而脑图一眼就能看出"哪一枝断了、为什么断"。
 *
 * 产出：一个**自包含**的 HTML（内联 SVG，无外部依赖、无 JS）——双击就能看，断网也能看，
 * Ctrl+滚轮放大，Ctrl+P 打印。为什么不用交互式 JS：这东西要能在这台机器上一次成型，
 * 而纯静态 SVG 生成在 Node 里是**可测的**（布局算错测试会红），交互式页面反而只能靠眼睛验。
 *
 * 数据来自 lib/l3-tasks.js 的 onEvent 事件流（与 lib/l3-trace.js 的 Markdown 同源）。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 配色（浅色，与阅读器的纸色相近）────────────────────────────────────────
const C = {
  bg: '#fbfaf7', ink: '#1f2328', dim: '#6b7480', line: '#b9b3a4',
  root: { fill: '#2f3a46', stroke: '#2f3a46', text: '#ffffff', sub: '#cfd6de' },
  draft: { fill: '#f3eee3', stroke: '#b9ae97', text: '#3a352c', sub: '#6b6250' },
  ok: { fill: '#e8f2ea', stroke: '#4f8a5b', text: '#22402b', sub: '#4a6a52' },      // 补充
  fix: { fill: '#fdf0e0', stroke: '#c08a3e', text: '#4a3520', sub: '#7a6440' },     // 校正
  // 2026-10-27：辅助行的字号只有 10px，原来的 #7d7d76 在这张纸色上只有约 3.6:1，
  // 10px 下基本是灰雾。压深到约 5.3:1——仍然比正文淡，但要读得清。
  none: { fill: '#f1f1ef', stroke: '#a8a8a2', text: '#3f3f3a', sub: '#5c5c55' },    // 无
  // 虚线节点（没往下追的那几枝）本来就该退后，但不能退到看不清：#a8a8a0 只有 2.4:1
  ghost: { fill: '#fafaf8', stroke: '#cfcfc8', text: '#6f6f67', sub: '#7a7a72' },   // 未追
  answer: { fill: '#e9eefb', stroke: '#5b6fa8', text: '#1e2a44', sub: '#46557a' },
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const nf = new Intl.NumberFormat('en-US')
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t }
/** 视觉宽度：中日韩字符算 1，其余算 0.55（够用来折行，不需要真实字形度量） */
export const widthOf = (s) => [...String(s)].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0)
/** 按视觉宽度折行（SVG 不会自动换行，得自己折） */
function wrap(text, maxUnits, maxLines = 99) {
  const out = []
  let line = ''
  let w = 0
  for (const ch of String(text == null ? '' : text)) {
    const cw = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55
    if (w + cw > maxUnits && line) { out.push(line); line = ''; w = 0; if (out.length === maxLines) break }
    line += ch
    w += cw
  }
  if (line && out.length < maxLines) out.push(line)
  if (!out.length) return ['']
  if (out.length === maxLines) {
    const rest = out[maxLines - 1]
    if (widthOf(text) > maxUnits * maxLines) out[maxLines - 1] = clip(rest, Math.max(2, rest.length - 1)) + '…'
  }
  return out
}

// ── 事件流 → 树 ─────────────────────────────────────────────────────────────
/**
 * 把流水线事件还原成一棵树（**给渲染用的中间形状**，不是最终 SVG）。
 *
 * 节点的父子关系不靠顺序猜：子课题的报告里带 `askedBy`（K-1.1 是 K-1 点走的）。没派的候选
 * 也各生成一个 ghost 节点——**它们才是这张图的价值**：一眼看出哪一枝被剪掉、剪的是谁。
 */
export function buildTraceTree(events = [], meta = {}) {
  const draft = { type: 'draft', chars: 0, directions: [], spine: null, raw: '' }
  const nodes = new Map()          // kid → 节点
  const order = []                 // 根级课题（按命中顺序）
  const pendingKids = new Map()    // 判了"要追"、但报告还没来（撞闸/失败）的课题
  const answers = []               // 终稿：both 模式下有两份（A 旧路径 / B 新路径）
  const mismatches = []            // 概述与正文不一致的节点（标题/别名承诺了正文没有的东西）
  let stats = null
  let gate = ''
  let fallback = ''
  let aggregate = ''
  const ensureNode = (kid, fromKid) => {
    if (nodes.has(kid)) return nodes.get(kid)
    const n = { kid, fromKid: fromKid || '', children: [], ghost: false }
    nodes.set(kid, n)
    if (!fromKid) order.push(n)
    else {
      const p = ensureNode(fromKid, '')
      p.children.push(n)
    }
    return n
  }

  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'draft') {
      draft.raw = e.raw || ''
      draft.chars = e.chars || 0
      draft.directions = Array.isArray(e.directions) ? e.directions : []
      draft.spine = e.spine && typeof e.spine === 'object' ? e.spine : null
      draft.ms = e.ms
    } else if (e.type === 'report') {
      // 父子关系靠"谁点的题"（askedBy）：K-1.1 是 K-1 点走的
      const n = ensureNode(e.kid, e.askedBy || e.fromKid || '')
      Object.assign(n, {
        ok: e.ok !== false && e.relation !== undefined,
        point: e.point || '', depth: e.depth || 0,
        materialChars: e.materialChars || 0, truncated: !!e.truncated, ms: e.ms,
        relation: e.relation || '', conclusion: e.conclusion || '',
        task: e.task || '', taskFrom: e.taskFrom || '', body: e.body || '',
        refused: !!e.refused, refuseWhy: e.refuseWhy || '',
        materialPreview: e.materialPreview || '',
        // 这一枝"派的什么题"：命中层是固定那一问，往下是上游课题写好的具体问题
        question: e.question || '', askedBy: e.askedBy || '', reason: e.reason || '',
        material: e.material || '',
      })
      pendingKids.delete(e.kid)   // 报告来了，"等报告"的标记撤掉
    } else if (e.type === 'ask') {
      // 派题：有缺口的那个看过候选目录后，决定问谁、问什么
      const n = ensureNode(e.kid, '')
      // 命中层出现 skipped、而这个节点从没有过正文/拒绝 → 派题侧没给它派题（不是"问了没答"）
      if ((e.depth ?? 0) === 0 && e.skipped && !n.body && !n.refused) n.noTask = true
      n.ask = {
        candidates: Array.isArray(e.candidates) ? e.candidates : [],
        asks: Array.isArray(e.asks) ? e.asks : [],
        raw: e.raw || '', ms: e.ms, failed: !!e.failed, reason: e.reason || '', skipped: e.skipped || '',
      }
      const ok = !n.ask.failed && !n.ask.skipped
      const asked = new Map(n.ask.asks.map((a) => [a.kid, a.question]))
      for (const c of n.ask.candidates) {
        if (ok && asked.has(c.kid)) {
          // 派了题：等它的报告事件来了挂到自己位置；没来就在收尾时补成"未跑"
          if (!nodes.has(c.kid)) pendingKids.set(c.kid, { kid: c.kid, point: c.point, parentKid: n.kid })
        } else {
          // 没派（不合适 / 派题失败 / 没缺口）：虚线节点，图上看得出这里断了一枝。
          // 失败或没缺口时标"未判"：那是没问成，不是模型说用不上。
          n.children.push({ kid: c.kid, point: c.point, ghost: true, unjudged: !ok, children: [] })
        }
      }
    } else if (e.type === 'mismatch') {
      // 父节点答"无关"＝这条旧讨论的标题/别名承诺了正文里没有的东西（数据质量问题，不是这枝没用）
      const n = nodes.get(e.kid) || ensureNode(e.kid, e.point || '')
      n.mismatch = { aspect: e.aspect || '', point: e.point || '', question: e.question || '', body: e.body || '' }
      mismatches.push(n.mismatch)
    } else if (e.type === 'gate') {
      gate = e.reason || ''
    } else if (e.type === 'fallback') {
      fallback = e.reason || ''
    } else if (e.type === 'final') {
      answers.push({
        label: e.label || '', text: e.text || '',
        coverage: Array.isArray(e.coverage) ? e.coverage : [],
        shown: e.shown !== false, note: e.note || '',
      })
    } else if (e.type === 'aggregate') {
      aggregate = e.message || ''
    } else if (e.type === 'stats') {
      stats = e.text || ''
    }
  }

  // 判了"要追"却没跑出报告的（撞兜底闸/调用失败）也要画出来：否则图上看不出"这里还有一枝"
  for (const [kid, p] of pendingKids) {
    if (nodes.has(kid)) continue
    const parent = nodes.get(p.parentKid)
    const node = { kid, point: p.point, ghost: true, pending: true, children: [] }
    if (parent) parent.children.push(node)
    else order.push(node)
  }
  // 子节点按课题号排序（K-1.1、K-1.2 在前，ghost 在后），读起来跟文章顺序一致
  const sortKids = (list) => list.sort((a, b) => {
    if (!!a.ghost !== !!b.ghost) return a.ghost ? 1 : -1
    return String(a.kid).localeCompare(String(b.kid), 'zh-CN', { numeric: true })
  })
  const walk = (n) => { if (n.children.length) { sortKids(n.children); n.children.forEach(walk) } }
  order.forEach(walk)

  return {
    question: meta.question || '',
    conv: meta.conv || '',
    stamp: meta.stamp || '',
    draft, tasks: order,
    // 给用户看的那份排最前（both 模式下 B 的终稿是先跑完的，但用户看的是 A）
    answers: answers.sort((a, b) => (b.shown ? 1 : 0) - (a.shown ? 1 : 0)),
    answer: answers.find((a) => a.shown) || answers[0] || null,
    stats, gate, fallback, aggregate, mismatches,
  }
}

// ── 树 → SVG ────────────────────────────────────────────────────────────────
const NODE_W = 380
const PAD = 12
const LH = 17
const COL = 440
const GAP = 18

/**
 * 一行最多放几个"视觉单位"——**必须跟着字号算**（2026-10-27 修）。
 *
 * 原来这里全是写死的 30：13px 的字 30 字就是 390px，而框里只有 368px 可用，
 * 于是每一行 point 都撑出节点框、压到边框上。实测一份真实树里 32 行有 3 行溢出。
 * 现在按 (框宽 - 左右内边距 - 一点余量) / 字号 算，任何字号都不会溢出。
 */
const wrapUnits = (size) => Math.max(8, Math.floor((NODE_W - PAD * 2 - 6) / size))

/** 一个节点要画哪几行（同时决定高度）。返回 [{text,size,bold,color}] */
function linesOf(n) {
  const out = []
  const push = (text, size, color, bold = false) => out.push({ text, size, color, bold })
  /** 这个字号的折行宽度（见 wrapUnits：写死 30 会撑破框） */
  const W = wrapUnits
  if (n.kind === 'root') {
    push('本轮提问', 11, C.root.sub)
    // 提问可能很长：最多 4 行。根节点撑高会把整棵树往下拖
    const q = wrap(n.text, W(14))
    for (const l of q.slice(0, 4)) push(l, 14, C.root.text, true)
    if (q.length > 4) push('…（全文见下方）', 10, C.root.sub)
    return out
  }
  if (n.kind === 'draft') {
    const sp = n.spine && typeof n.spine === 'object' ? n.spine : {}
    const steps = Array.isArray(sp.steps) ? sp.steps.filter(Boolean) : []
    const hasSpine = Boolean(String(sp.thesis || '').trim() && steps.length)
    if (hasSpine) {
      // 2026-10-28：脑图先画骨架（总 → 几步 → 收），不再报"0 个方向"——
      // 「方向」是旧形状，现在的草稿根本没有这个标记，报 0 会让人以为草稿没写。
      push(`① R1 骨架 · ${nf.format(n.chars)} 字 · ${steps.length} 步`, 12, C.draft.sub, true)
      const thesis = String(sp.thesis || '').trim()
      for (const l of wrap(`总：${thesis}`, W(11), 2)) push(l, 11, C.draft.sub)
      return out
    }
    push(`① R1 草稿 · ${nf.format(n.chars)} 字 · ${n.directions.length} 个方向`, 12, C.draft.sub, true)
    const dirs = n.directions.length ? n.directions.join('、') : '（没解析出骨架）'
    for (const l of wrap(dirs, W(11), 2)) push(l, 11, C.draft.sub)
    return out
  }
  if (n.kind === 'direction') {
    for (const l of wrap(n.text, W(12), 3)) push(l, 12, C.draft.text)
    return out
  }
  if (n.kind === 'answer') {
    const head = n.label || '④ 终稿'
    push(`${head} · ${nf.format(n.chars)} 字`, 12, C.answer.sub, true)
    const full = wrap(n.text, W(11))
    for (const l of full.slice(0, n.shown ? 6 : 4)) push(l, 11, C.answer.sub)
    if (full.length > (n.shown ? 6 : 4)) push('（全文见下方「全文」区）', 10, C.answer.sub)
    if (n.coverage.length) push(`覆盖度 ${n.coverage.map((c) => `${c.kid} ${Math.round(c.ratio * 100)}%`).join(' · ')}`, 10, C.answer.sub)
    return out
  }
  // 课题 / ghost
  const tag = n.ghost
    ? (n.unjudged ? '未判' : n.pending ? '未跑' : '未追')
    : ((n.depth ?? 0) === 0 ? '命中' : `来路 ${n.depth} 跳${n.askedBy ? ` · ${n.askedBy} 点题` : ''}`)
  push(`${n.kid} 〔${tag}〕`, 11, n.ghost ? C.ghost.sub : C.none.sub, true)
  if (n.ghost) {
    // 被剪掉的枝只留一行：图上要的是"这里断了一枝 + 断的是谁"，不是它的全文
    for (const l of wrap(n.point || '', W(12))) push(l, 12, C.ghost.text)
    return out
  }
  for (const l of wrap(n.point || '', W(13))) push(l, 13, C.none.text, true)
  push(`材料 ${nf.format(n.materialChars)} 字${n.truncated ? '（已截断）' : ''}${n.ms != null ? ` · R2 ${(n.ms / 1000).toFixed(1)}s` : ''}`, 10, C.none.sub)
  // 派给它的**课题**：这是"这一枝在查什么"，没有它，图只能看出"查了哪个知识点"
  if (n.task) {
    // 每层都有一道题：命中层由 R1 派，更早的是子节点派的
    // 前缀**参与折行**：先 wrap 再拼前缀的话，第一行会多出七八个字、直接撑破框（实测过）
    const prefix = `课题（${n.taskFrom || '上游'} 派）：`
    const full = wrap(prefix + String(n.task).replace(/\*\*/g, ''), W(10))
    for (const l of full.slice(0, 5)) push(l, 10, C.fix.sub)
    if (full.length > 5) push('…（全文见下方）', 10, C.fix.sub)
  }
  // 这一面：当前提问要的是哪一面、这段够不够

  if (n.refused) push(`🛑 拒绝交付：${n.refuseWhy || '这段没谈过这件事'}（point/alias 与实际内容不符，待修）`, 10, '#a8452f', true)
  // 正文最多 8 行（2026-10-27）：R2 的登记常有二三百字，整段铺开会把节点拉成一条竖条，
  // 而这张图的用处是看结构；要看全在下面的「全文」区。
  // 正文前面加一条发丝线：一个框里堆着标题/材料/课题/正文四种字号，不分开扫不出层次。
  if (n.body) {
    out.push({ rule: true })
    const bLines = wrap(n.body, W(11))
    for (const l of bLines.slice(0, 8)) push(l, 11, C.none.text)
    if (bLines.length > 8) push('…（全文见下方「全文」区）', 10, C.none.sub)
  }
  if (n.mismatch) {
    for (const l of wrap(`⚠️ 概述与正文不一致：上一条照这里的标题来问「${n.mismatch.aspect}」，正文里没有`, W(10))) {
      push(l, 10, '#a8452f')
    }
  }
  if (n.noTask) { push('用不上：这块料补不上这一处（未派题）', 11, C.ghost.sub, true); return out }
  if (!n.task && !n.body) push(n.reason ? `❌ 没拿到登记（${n.reason}）` : '❌ 没拿到登记', 11, C.none.text, true)
  return out
}

function paletteOf(n) {
  if (n.kind === 'root') return C.root
  if (n.kind === 'draft' || n.kind === 'direction') return C.draft
  if (n.kind === 'answer') return C.answer
  if (n.ghost) return C.ghost
  if (n.refused) return C.fix
  return C.ok
}

/** 递归排版：叶子依次往下排，父节点在自己孩子的竖直中心 */
export function layoutTree(root) {
  let nextY = 0
  const shift = (n, dy) => {
    n.y += dy
    for (const c of n.children || []) shift(c, dy)
  }
  const place = (n, depth) => {
    const startY = nextY            // 这棵子树的起点：父节点不许跑到它上面去（会撞到上一个兄弟）
    n.lines = linesOf(n)
    n.w = NODE_W
    n.h = PAD * 2 + n.lines.length * LH
    n.x = depth * COL
    if (!n.children || !n.children.length) {
      n.y = nextY
      nextY += n.h + GAP
      return
    }
    for (const c of n.children) place(c, depth + 1)
    const first = n.children[0]
    const last = n.children[n.children.length - 1]
    // 父节点居中于孩子：孩子整体比父节点矮时，把整棵子树往下挪，而不是把父节点挤出中心
    // （把父节点往下 clamp 会让它落到第一个孩子的下方，连线会往回勾，图就变成一团）
    const mid = (first.y + last.y + last.h) / 2 - n.h / 2
    if (mid < startY) {
      const dy = startY - mid
      for (const c of n.children) shift(c, dy)
    }
    n.y = Math.max(mid, startY)
    nextY = Math.max(n.y + n.h, last.y + last.h) + GAP
  }
  place(root, 0)
  const nodes = allNodes(root)
  return {
    nodes,
    width: Math.max(...nodes.map((n) => n.x + n.w)),
    height: Math.max(...nodes.map((n) => n.y + n.h)),
  }
}

/**
 * 渲染中间形状：提问 → [草稿 → 方向…]，命中课题…，终稿。
 * 单独抽出来是为了能被测试直接量（节点会不会重叠、子节点是不是在父节点右边），
 * 靠肉眼看 SVG 是量不出来的。
 */
export function buildDisplayRoot(tree) {
  const t = tree || {}
  const root = { kind: 'root', text: t.question || '（没有抓到提问）', children: [] }
  const children = []
  const sp = t.draft && t.draft.spine && typeof t.draft.spine === 'object' ? t.draft.spine : {}
  const steps = Array.isArray(sp.steps) ? sp.steps.filter(Boolean) : []
  const hasSpine = Boolean(String(sp.thesis || '').trim() && steps.length)
  if (t.draft && (t.draft.chars || (t.draft.directions || []).length || hasSpine)) {
    // 有骨架：把「总 → 第N步 → 收」画成子节点，脑图上一眼能看出这一轮的主线；
    // 没有骨架（旧记录）：退回原来的方向列表。
    const spineChildren = hasSpine
      ? [
        ...steps.map((s, i) => ({ kind: 'direction', text: `第${i + 1}步：${s}` })),
        ...(String(sp.closing || '').trim() ? [{ kind: 'direction', text: `收：${String(sp.closing).trim()}` }] : []),
      ]
      : (t.draft.directions || []).map((d) => ({ kind: 'direction', text: d }))
    children.push({
      kind: 'draft', chars: t.draft.chars || 0, directions: t.draft.directions || [],
      spine: hasSpine ? { thesis: sp.thesis, steps, closing: sp.closing || '' } : null,
      children: spineChildren,
    })
  }
  for (const n of t.tasks || []) children.push(n)
  const answers = t.answers && t.answers.length ? t.answers : (t.answer ? [t.answer] : [])
  for (const a of answers) {
    children.push({
      kind: 'answer', label: a.label || '', shown: a.shown !== false,
      chars: (a.text || '').length, coverage: a.coverage || [],
      text: a.text || a.note || '',
    })
  }
  if (!children.length) children.push({ kind: 'direction', text: '这一轮没有走命题递归（没有命中，或还没跑完）' })
  root.children = children
  return root
}

/** 节点 → SVG 片段（含子节点与连线） */
function drawNode(n, out) {
  const p = paletteOf(n)
  const dash = n.ghost ? ' stroke-dasharray="5 4"' : ''
  out.push(`<g class="n"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${n.kind === 'root' ? 0 : 1.2}"${dash}/>`)
  let y = n.y + PAD + 12
  for (const l of n.lines) {
    // 发丝分隔线：把一个框里的"元信息 / 课题 / 正文"分开，扫的时候才有层次
    if (l.rule) {
      out.push(`<line x1="${n.x + PAD}" y1="${y - 11}" x2="${n.x + n.w - PAD}" y2="${y - 11}" stroke="#ddd7c9" stroke-width="1"/>`)
      y += LH
      continue
    }
    out.push(`<text x="${n.x + PAD}" y="${y}" font-size="${l.size}" font-weight="${l.bold ? 600 : 400}" fill="${l.color}">${esc(l.text)}</text>`)
    y += LH
  }
  out.push('</g>')
  for (const c of n.children || []) {
    const x1 = n.x + n.w
    const y1 = n.y + n.h / 2
    const x2 = c.x
    const y2 = c.y + c.h / 2
    const mx = (x1 + x2) / 2
    out.push(`<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${c.ghost ? '#d8d8d2' : C.line}" stroke-width="1.4"${c.ghost ? ' stroke-dasharray="4 4"' : ''}/>`)
  }
  for (const c of n.children || []) drawNode(c, out)
}

/**
 * 全文区：图上放不下的**原文**都在这里（2026-10-24 用户要求：图可以看骨架，但内容要能看全）。
 * 每个课题一块，含：派给它的题、喂进去的材料原文、报告各字段、以及 R4 的输入与终稿全文。
 */
function renderFullText(t) {
  const pre = (s) => `<pre>${esc(s)}</pre>`
  const block = (title, body, open = true) => `<details class="blk"${open ? ' open' : ''}><summary>${esc(title)}</summary>${body}</details>`
  const parts = ['<section class="full"><h2>全文</h2>']

  if (t.draft && t.draft.raw) parts.push(block(`① R1 草稿（${nf.format(String(t.draft.raw).length)} 字）`, pre(t.draft.raw)))

  const walk = (n) => {
    const tag = (n.depth ?? 0) === 0 ? '命中' : `来路 ${n.depth} 跳${n.askedBy ? ` · ${n.askedBy} 点题` : ''}`
    const r = []
    const put = (k, v) => { if (v) r.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`) }
    put('课题', esc(n.task || '（没给题）') + (n.taskFrom ? `（${esc(n.taskFrom)} 派）` : ''))
    put('材料', n.material ? `<span class="dim">${nf.format(n.materialChars)} 字${n.truncated ? '（已截断，模型也只看到这一段）' : ''}</span>${pre(n.material)}` : esc(`${nf.format(n.materialChars)} 字（这一轮没留下材料原文）`))
    const rep = []
    if (n.aspect) rep.push(`<b>方面</b>：${esc(n.aspect)}`)
    if (n.refused) rep.push(`<b>🛑 拒绝交付</b>：${esc(n.refuseWhy || '这段没谈过这件事')}（point/alias 与实际内容不符，待修）`)
    if (n.body) rep.push(`<b>那次讨论的状态</b>：${esc(n.body)}`)
    put('R2 登记', rep.length ? rep.join('<br>') : `❌ 没拿到登录${n.reason ? `——${esc(n.reason)}` : ''}`)
    parts.push(`<details class="blk" open><summary>${esc(n.kid)} 「${esc(n.point || '')}」〔${esc(tag)}〕</summary><dl>${r.join('')}</dl></details>`)
    for (const c of n.children || []) if (!c.ghost) walk(c)
  }
  for (const n of t.tasks || []) walk(n)

  const ghosts = []
  const collect = (n) => { for (const c of n.children || []) { if (c.ghost) ghosts.push(c); else collect(c) } }
  for (const n of t.tasks || []) collect(n)
  if (ghosts.length) {
    parts.push(`<p class="hint">没往下追的：${ghosts.map((g) => `${esc(g.kid)}〔${g.unjudged ? '未判' : g.pending ? '未跑' : '未追'}〕 ${esc(g.point || '')}`).join('<br>')}</p>`)
  }

  if (t.aggregate) parts.push(block('③ R4 的输入（全文）', pre(t.aggregate), false))
  for (const a of t.answers || []) {
    parts.push(block(`④ ${a.label || '终稿'}（${nf.format(String(a.text || '').length)} 字）`, a.text ? pre(a.text) : '（空）'))
  }
  parts.push('</section>')
  return parts.join('\n')
}

/** 树 → 完整 HTML（内联 SVG，无外部资源） */
export function renderTreeHtml({ tree, meta = {} } = {}) {
  const t = tree || buildTraceTree([], meta)
  const root = buildDisplayRoot(t)
  const { nodes, width, height } = layoutTree(root)
  const out = []
  drawNode(root, out)
  const W = Math.max(1200, width) + 60
  const H = Math.max(300, height) + 40

  const stamp = meta.stamp || t.stamp || ''
  const badges = [
    t.fallback ? `<span class="warn">⚠️ 兜底：${esc(t.fallback)}</span>` : '',
    t.gate ? `<span class="warn">⛔ 兜底闸：${esc(t.gate)}</span>` : '',
  ].join('')
  const reportCount = nodes.filter((n) => n.kind !== 'draft' && n.kind !== 'direction' && n.kind !== 'root' && n.kind !== 'answer' && !n.ghost).length
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>命题递归 · ${esc(stamp)}</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; background: ${C.bg}; color: ${C.ink};
    font-family: "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif }
  header { padding: 18px 22px 8px }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600 }
  .meta { font-size: 12px; color: ${C.dim}; line-height: 1.7 }
  .meta b { color: ${C.ink}; font-weight: 600 }
  .warn { display: inline-block; margin-right: 12px; color: #8a4b2f }
  .hint { font-size: 12px; color: ${C.dim}; margin: 4px 0 0 }
  .wrap { overflow: auto; padding: 8px 22px 24px }
  svg { display: block }
  footer { padding: 0 22px 26px; font-size: 12px; color: ${C.dim}; line-height: 1.7 }
  .full { padding: 6px 22px 30px; border-top: 1px solid #e3ddd0; margin-top: 10px }
  .full h2 { font-size: 15px; margin: 16px 0 10px }
  .blk { background: #fffdf8; border: 1px solid #e6e0d2; border-radius: 8px; margin: 8px 0; padding: 6px 12px }
  .blk > summary { cursor: pointer; font-size: 13px; font-weight: 600; padding: 4px 0 }
  .blk dl { margin: 4px 0 8px }
  .blk dt { font-size: 11px; color: ${C.dim}; margin-top: 8px }
  .blk dd { margin: 2px 0 0; font-size: 13px; line-height: 1.75 }
  .blk pre { white-space: pre-wrap; word-break: break-word; background: #f7f5ef; border-radius: 6px; padding: 8px 10px; font-size: 12.5px; line-height: 1.7; margin: 6px 0 0; font-family: inherit }
  .dim { color: ${C.dim}; font-size: 11px }
  a { color: #4a5f8f }
</style></head>
<body>
<header>
  <h1>命题递归 · 全过程</h1>
  <div class="meta">
    <b>${esc(stamp || '—')}</b>｜对话 <b>${esc(t.conv || '—')}</b>｜命中 <b>${(t.tasks || []).length}</b> 个｜
    R2 报告 <b>${reportCount}</b> 份
    ${badges}
  </div>
  ${t.stats ? `<div class="meta">${esc(t.stats)}</div>` : ''}
  <p class="hint">节点是课题（虚线＝派题判"不值得追"，这枝到此为止）。Ctrl+滚轮缩放，Ctrl+P 可打印。</p>
</header>
<div class="wrap">
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="命题递归脑图">
${out.join('\n')}
</svg>
</div>
${renderFullText(t)}
<footer>
  图的每一格都来自这一轮的真实调用：材料字数、报告结论、依据核对、R3 的判定。文字版更细（含 R4 的输入全文）：
  <a href="${esc((meta.mdName || (stamp ? stamp + '.md' : '')) || '#')}">同名 .md</a>。
</footer>
</body></html>`
}

function allNodes(n) {
  const out = [n]
  for (const c of n.children || []) out.push(...allNodes(c))
  return out
}

/**
 * 边跑边写的书写器：每个事件把 HTML 整份重写一次（一次递归最多几十个事件，几十 KB，无所谓）。
 * 好处是用户等的时候按 F5 就能看到走到哪了；坏处是没有——它不参与任何判定。
 */
export function openL3Tree({ dir, meta = {}, stamp } = {}) {
  const events = []
  const ts = stamp || new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
  const file = dir ? path.join(dir, `${ts}.html`) : ''
  let ok = !!file
  const render = () => {
    if (!ok) return
    try {
      const tree = buildTraceTree(events, { ...meta, stamp: ts, question: meta.question })
      fs.writeFileSync(file, renderTreeHtml({
        tree,
        // 图里那个"同名 .md"指向调用方指定的逐字记录（离线对拍时两者不同名）
        meta: { ...meta, stamp: ts, mdName: meta.mdName || `${ts}.md` },
      }))
    } catch (e) {
      ok = false
      try { console.log(`  ⚠️ 脑图写失败（不影响回答）：${e.message}`) } catch {}
    }
  }
  if (ok) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { ok = false }
    render()
  }
  return {
    file: ok ? file : '',
    write(evt) { events.push(evt); render() },
    render,
  }
}
