#!/usr/bin/env node
/**
 * L3 命题递归的全过程记录（2026-10-24，调试用）
 *
 * 为什么要有它：流水线的 `log()` 只够看"有没有走通"，看不出"为什么这么走"——
 * R1 写了什么草稿、每个课题喂了哪段原话、报告得出的结论是哪句、R3 在哪些候选里挑了谁、
 * 最后 R4 手里到底有什么。调这套东西时真正要看的是**这棵树**，不是那几行摘要。
 *
 * 落点：`data/runtime/l3-trace/YYYY-MM-DDTHH-MM-SS.md`（runtime = 随时可删）。
 * **边跑边写**（每个事件追加一次）：一轮 30 秒，你能一边等一边看，崩了也不丢前面的。
 *
 * 本模块只做两件事：把事件渲染成 Markdown、把 Markdown 追加到文件。**永不抛**——
 * 调试记录写失败绝不能影响这一轮回答。
 */
import fs from 'node:fs'
import path from 'node:path'

const nf = new Intl.NumberFormat('en-US')
const str = (v) => (v == null ? '' : String(v))
/** 截断并注明原文长度（截断必须可见，否则看的人会以为原文就这么短） */
const clip = (v, n) => {
  const t = str(v)
  return t.length > n ? t.slice(0, n) + `…（共 ${nf.format(t.length)} 字）` : t
}
/** 代码围栏：正文里出现 ``` 时拆开，免得把整份文档截断 */
const fence = (v, lang = 'text') => '```' + lang + '\n' + str(v).replace(/```/g, '``\u200b`') + '\n```'
const h = (depth) => '#'.repeat(Math.min(3 + Math.max(0, Number(depth) || 0), 5))

/** 本地时间戳，既用于文件名也用于标题（不用 ISO：那是 UTC，看日志的人会错 8 小时） */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return {
    file: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`,
    human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  }
}

/** 文件头：一眼看清"这是什么、哪一轮、命中什么、问了什么" */
export function traceHeader(meta = {}) {
  const ts = meta.ts || localStamp().human
  const points = Array.isArray(meta.points) ? meta.points : []
  const lines = [
    '# L3 命题递归 · 全过程',
    '',
    `- 时间：${ts}`,
    `- 对话：\`${str(meta.conv) || '—'}\``,
    `- 路径：${str(meta.path) || '—'}（装配模式 \`${str(meta.mode) || '—'}\`）`,
    `- 本轮命中：${points.length} 个（编号即下文的根）`,
  ]
  for (const p of points) lines.push(`  - ${p.kid} 「${str(p.point)}」`)
  if (meta.question) lines.push('', '**本轮提问**（用户原话）', '', fence(clip(meta.question, 1200)))
  lines.push('', '> 这份文件是程序写的调试记录：每一步的输入/输出都照实抄，没有整理过。', '')
  return lines.join('\n') + '\n'
}

/**
 * 一个事件 → 一段 Markdown。事件由 lib/l3-tasks.js 发出（形状见各 case）。
 * 认不出的事件不报错、写一行注释（调试记录不该因为多了一种事件就断掉）。
 */
export function renderTraceEvent(evt) {
  const e = evt || {}
  switch (e.type) {
    case 'section':
      return `\n## ${str(e.text)}\n`

    case 'note':
      return `\n> ${str(e.text)}\n`

    case 'draft': {
      const dirs = Array.isArray(e.directions) ? e.directions : []
      return [
        `\n## ① R1 草稿（用户看不到，只给课题和汇总用）`,
        '',
        `- 篇幅：${nf.format(Number(e.chars) || 0)} 字｜${dirs.length} 个方向${e.ms != null ? `｜耗时 ${(e.ms / 1000).toFixed(1)}s` : ''}`,
        dirs.length ? `- 方向：${dirs.map((d) => `「${d}」`).join('、')}` : '- 方向：没解析出【方向：】标记（终稿照样能整合）',
        '',
        fence(e.raw),
        '',
      ].join('\n')
    }

    case 'report': {
      const depth = Number(e.depth) || 0
      const tag = depth === 0 ? '命中' : `来路 ${depth} 跳${e.askedBy ? ` · ${e.askedBy} 点题` : ''}`
      const lines = [
        '',
        `${h(depth)} ${e.kid} 「${clip(e.point, 120)}」`,
        '',
        `- 〔${tag}〕材料 ${nf.format(Number(e.materialChars) || 0)} 字${e.truncated ? '（**已截断**，只给了前段）' : ''}`
          + `${e.ms != null ? `｜R2 ${(e.ms / 1000).toFixed(1)}s` : ''}`,
      ]
      if (e.task) lines.push(`- 课题（${e.taskFrom || e.askedBy || '上游'} 派）：${clip(e.task, 300)}`)
      if (e.materialPreview) {
        lines.push('', '<details><summary>材料开头（前 300 字，完整原文见会意图谱）</summary>', '', fence(clip(e.materialPreview, 300)), '', '</details>')
      }
      const refused = !!e.refused
      if (e.ok === false || (!e.task && !e.body && !refused)) {
        lines.push('', '**R2 登记**：❌ 没拿到——' + (e.reason || '原因不明'))
        return lines.join('\n') + '\n'
      }
      lines.push('', refused ? `**R2 登记**：🛑 拒绝交付——${clip(e.refuseWhy || '这段没谈过这件事', 200)}` : '**R2 登记**')
      if (e.body) lines.push('', clip(e.body, 1200))
      if (refused) lines.push('', '> 拒绝＝这条旧讨论的正文里没有问的这件事。它进统计（point/alias 与实际内容不符），不进汇总。')
      return lines.join('\n') + '\n'
    }

    case 'ask': {
      const cands = Array.isArray(e.candidates) ? e.candidates : []
      const asks = new Map((Array.isArray(e.asks) ? e.asks : []).map((a) => [a.kid, a.question]))
      const head = e.failed
        ? `R3 派题 · ${e.kid}（**调用失败/被兜底闸拦下**：${str(e.reason)}——这一层没问下去，下面的候选不是"用不上"）`
        : e.skipped
          ? `R3 派题 · ${e.kid}（跳过：${str(e.skipped)}）`
          : `R3 派题 · ${e.kid}（${cands.length} 个候选父节点 → 派出 ${asks.size} 个问题）`
      const lines = ['', `${h((Number(e.depth) || 0) + 1)} ${head}`, '']
      if (!e.failed && !e.skipped) {
        lines.push('| 候选（子节点看过它的材料开头） | 派给它的具体问题 |', '|---|---|')
        for (const c of cands) {
          const q = asks.get(c.kid)
          lines.push(`| ${c.kid} ${clip(c.point, 60).replace(/\|/g, '\\|')} | ${q ? clip(q, 200).replace(/\|/g, '\\|') : '— 用不上'} |`)
        }
      } else if (cands.length) {
        // 「用不上」是明确判定，不是"没问成"——两者混在一句话里会让人以为这一枝白跑了
        lines.push((str(e.skipped) === '用不上' ? '候选（明确用不上）：' : '候选（没问成）：') +
          cands.map((c) => `${c.kid} ${clip(c.point, 30)}`).join('；'))
      } else if (str(e.skipped) === '用不上') {
        lines.push('这一条材料本轮不参与（派题侧写的是「用不上」）。')
      }
      if (e.raw) lines.push('', '<details><summary>模型原始输出</summary>', '', fence(clip(e.raw, 600)), '', '</details>')
      if (e.ms != null) lines.push('', `（R3 耗时 ${(e.ms / 1000).toFixed(1)}s）`)
      return lines.join('\n') + '\n'
    }

    case 'dispatch': {
      // 派题：这一层拿到的候选、以及给每条派的题（任务版 2026-10 起是每一层一次，不是老的 R3）
      const tasks = Array.isArray(e.tasks) ? e.tasks : []
      const lines = [
        '',
        `## ${h((Number(e.depth) || 0) + 1)} 派题 · ${str(e.kid)}（${tasks.length} 个候选 → ${tasks.filter((t) => t.task).length} 个有题）`,
        '',
      ]
      if (tasks.length) {
        lines.push('| 候选 | 派给它的题 |', '|---|---|')
        for (const t of tasks) {
          lines.push(`| ${t.kid} | ${t.task ? clip(t.task, 300).replace(/\|/g, '\\|') : '— 用不上（这一轮不参与）'} |`)
        }
      } else {
        lines.push('（这次派题没有给出任何一行——空了）')
      }
      if (e.raw) lines.push('', '<details><summary>模型原始输出</summary>', '', fence(clip(e.raw, 600)), '', '</details>')
      if (e.ms != null) lines.push('', `（派题耗时 ${(e.ms / 1000).toFixed(1)}s）`)
      return lines.join('\n') + '\n'
    }

    case 'mismatch':
      // 父节点答"无关"＝这条旧讨论的标题/别名承诺了正文里没有的东西（数据质量问题，不是这枝没用）
      return `\n> ⚠️ **概述与正文不一致**：上一条照 ${str(e.kid)} 的标题来问「${str(e.aspect)}」，而它正文里没有。这是旧讨论的元数据问题，不是这一枝没用。\n`

    case 'live': {
      const nodes = Array.isArray(e.nodes) ? e.nodes : []
      const failed = Array.isArray(e.failed) ? e.failed : []
      const parts = []
      parts.push(nodes.length ? `本轮有效来路 ${nodes.length} 个（下一轮同栈继续时继承）：${nodes.join('、')}` : '本轮没有新成功上报的来路节点')
      if (failed.length) parts.push(`本轮没起作用 ${failed.length} 个（交付被拒或判「用不上」，从继承集合里去掉）：${failed.join('、')}`)
      return `\n> ${parts.join('；')}\n`
    }

    case 'gate':
      return `\n> ⛔ 兜底闸触发：${str(e.reason)}——探索到此为止（不是出错，是保护）。\n`

    case 'aggregate':
      // 任务版：每一层回归时一次（中转记录）；老的整段来路版里，这个事件是 R4 的输入
      return [
        '',
        e.kid
          ? `## ${h(3)} 回归汇总 · ${str(e.kid)}（并成一段中转记录往上传，用户看不到）`
          : '## ③ R4 的输入（草稿 + 全部报告；用户看不到这一块）',
        '',
        fence(e.message),
        '',
      ].join('\n')

    case 'fallback':
      return `\n> ⚠️ 走不下去，退回旧的整段注入：${str(e.reason)}\n`

    case 'final': {
      // both 模式下会有两份终稿（A 旧路径给用户看、B 新路径没给），标题必须分得开
      const label = str(e.label) || '终稿（用户看到的就是这段）'
      const lines = ['', `## ④ ${label}`, '', e.text ? fence(e.text) : '（空）', '']
      const cov = Array.isArray(e.coverage) ? e.coverage : []
      if (cov.length) {
        lines.push('**R4 覆盖度**（报告结论的三元组有多少出现在终稿里——代理指标，不是判决）', '')
        lines.push('| 报告 | 覆盖度 | 判定 |', '|---|---|---|')
        for (const c of cov) lines.push(`| ${c.kid} | ${(c.ratio * 100).toFixed(0)}% | ${c.ratio < 0.2 ? '疑似丢弃' : '已整合'} |`)
        lines.push('')
      }
      if (e.note) lines.push(`> ${str(e.note)}`)
      return lines.join('\n') + '\n'
    }

    case 'stats':
      return `\n---\n\n${str(e.text)}\n`

    default:
      return `\n<!-- 未知事件：${str(e.type)} -->\n`
  }
}

/** 只留最近 N 份：调试开关忘了关、放几天也不会攒成几百份（文件名是按时间排的） */
export const TRACE_KEEP = 50
export function pruneTraces(dir, keep = TRACE_KEEP) {
  const names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}T.*\.md$/.test(n)).sort()
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.unlinkSync(path.join(dir, n)) } catch {}
  }
  return names.length
}

/**
 * 开一份全过程记录。返回 `{file, write(evt)}`；文件开不了时 `file` 为空、`write` 是空操作。
 * 每个事件立刻落盘（不缓冲）：一轮 30 秒，用户要能一边等一边看。
 *
 * @param {object} p {dir, meta, stamp?}  dir 由调用方给（paths.js 的 L3_TRACE_DIR）
 */
export function openL3Trace({ dir, meta = {}, stamp } = {}) {
  const ts = localStamp()
  const name = stamp || ts.file
  const file = dir ? path.join(dir, `${name}.md`) : ''
  let ok = !!file
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, traceHeader({ ...meta, ts: meta.ts || ts.human }))
    try { pruneTraces(dir) } catch {}
  } catch (e) {
    ok = false
    try { console.log(`  ⚠️ 全过程记录打不开（不影响回答）：${e.message}`) } catch {}
  }
  return {
    file: ok ? file : '',
    write(evt) {
      if (!ok) return
      try { fs.appendFileSync(file, renderTraceEvent(evt)) } catch { ok = false }
    },
  }
}
