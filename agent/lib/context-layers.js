#!/usr/bin/env node
/**
 * 会意系统 · 上下文分层组装（L1 本章标注讨论 + L2 全书热点标注）
 *
 * 对应 topic-library-design.md §4.1 的四层上下文组装：
 *   L1 本章标注讨论：范围 = 当前书、当前章节内全部标注及其讨论沉淀；
 *   L2 全书热点标注：范围 = 全书中被讨论次数 ≥ n 的标注（n 初始 3）。
 * （L3 图路径上下文在 knowledge-graph.js / index.js；滚动窗口在 index.js 的历史里。）
 *
 * 数据源（现有记录，不新增持久化）：
 * - annotations.jsonl（inbox）：全部标注 {bookId, chapter, selectedText, userNote, ...}
 * - books/<dir>/discussions.jsonl：每轮讨论的 TAKEAWAY 沉淀 {selectedText, takeaway, timestamp}
 *   ——标注问答线程的持久形态 = 每轮收口时的 takeaway 沉淀；完整轮次只在会话内历史。
 *
 * 纯函数 + 可注入路径：不读环境变量、不写文件，测试直接喂临时目录。
 */

import fs from 'node:fs'
import path from 'node:path'

// bookId 归一化（与 index.js 同款）：去掉 k-suffix 得权威目录名
export function baseBookIdOf(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{16,}$/i, '')
}

export function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

// 一本书的目录名集合：权威 baseId 目录 + 迁移前的 k-suffix 历史目录
export function bookDirs(booksDir, bookId) {
  if (!bookId) return []
  const baseId = baseBookIdOf(bookId)
  const names = [baseId]
  try {
    for (const name of fs.readdirSync(booksDir)) {
      if (name !== baseId && name.startsWith(`${baseId}k`)) names.push(name)
    }
  } catch {}
  return names
}

function readDiscussions(booksDir, bookId) {
  const out = []
  for (const dir of bookDirs(booksDir, bookId)) {
    out.push(...readJsonLines(path.join(booksDir, dir, 'discussions.jsonl')))
  }
  return out
}

// 章节名归一化比较（" 六 " ≡ "六"）
function chapterMatches(a, b) {
  const na = String(a || '').replace(/\s+/g, '')
  const nb = String(b || '').replace(/\s+/g, '')
  return na === nb
}

const sliceText = (s, n) => {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * L1 本章标注讨论：当前书 + 章节内的标注及其讨论沉淀。
 * 每条标注：划线原文 + 第一反应（userNote）+ 讨论沉淀（该划线的 takeaway，按时间取最近几条）。
 * 有界：标注条数上限 max（按时间取最新）、文本截断。
 * @param {object} input { annotationsPath, booksDir, bookId, chapter?, max? }
 * @returns {string} 上下文块；无数据返回 ''
 */
export function assembleL1({ annotationsPath, booksDir, bookId, chapter = '', max = 8 }) {
  if (!annotationsPath || !booksDir || !bookId) return ''
  const baseId = baseBookIdOf(bookId)
  const anns = readJsonLines(annotationsPath)
    .filter((a) => baseBookIdOf(a.bookId) === baseId && chapterMatches(a.chapter, chapter))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-max)
  if (anns.length === 0) return ''

  const discussions = readDiscussions(booksDir, bookId)
  const lines = [`[本章标注讨论]《${anns[anns.length - 1]?.bookTitle || ''}》${chapter || ''}（${anns.length} 条标注）`]
  for (const a of anns) {
    const takes = discussions
      .filter((d) => d.selectedText === a.selectedText)
      .sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0))
      .slice(0, 2)
      .map((d) => d.takeaway)
      .filter(Boolean)
    const note = String(a.userNote || '').trim() ? `；第一反应：${sliceText(a.userNote, 80)}` : ''
    const takeText = takes.length ? `；讨论沉淀：${takes.map((t) => sliceText(t, 60)).join(' / ')}` : ''
    lines.push(`- 划线："${sliceText(a.selectedText, 80)}"${note}${takeText}`)
  }
  return lines.join('\n')
}

/**
 * L2 全书热点标注：全书中被讨论（有 takeaway 沉淀）次数 ≥ min 的标注。
 * 每条：划线原文 + 讨论次数 + 沉淀摘要（各次 takeaway）。
 * 有界：条数上限 max（按讨论次数降序）、文本截断。
 * @param {object} input { annotationsPath, booksDir, bookId, min?, max? }
 * @returns {string} 上下文块；无数据返回 ''
 */
export function assembleL2({ annotationsPath, booksDir, bookId, min = 3, max = 5 }) {
  if (!annotationsPath || !booksDir || !bookId) return ''
  const discussions = readDiscussions(booksDir, bookId)
  const byText = new Map()   // selectedText → { count, takes: [] }
  for (const d of discussions) {
    if (!d.selectedText || !d.takeaway) continue
    const rec = byText.get(d.selectedText) || { count: 0, takes: [] }
    rec.count++
    rec.takes.push(d.takeaway)
    byText.set(d.selectedText, rec)
  }
  const hot = [...byText.entries()]
    .filter(([, rec]) => rec.count >= min)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, max)
  if (hot.length === 0) return ''

  const anns = readJsonLines(annotationsPath)
  const textToAnn = new Map()
  for (const a of anns) if (a.selectedText) textToAnn.set(a.selectedText, a)

  const lines = [`[全书热点标注]（被讨论 ≥${min} 次的划线，共 ${hot.length} 条）`]
  for (const [text, rec] of hot) {
    const ann = textToAnn.get(text)
    const book = ann?.bookTitle ? `《${ann.bookTitle}》` : ''
    const takes = rec.takes.slice(-3).map((t) => sliceText(t, 60)).join(' / ')
    lines.push(`- ${book}划线："${sliceText(text, 80)}"（讨论 ${rec.count} 次）沉淀：${takes}`)
  }
  return lines.join('\n')
}
