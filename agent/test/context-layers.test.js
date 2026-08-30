#!/usr/bin/env node
/**
 * 上下文分层组装（L1 本章标注讨论 / L2 全书热点标注）单元测试 — 内置 node:test。
 * 运行：node test/context-layers.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { assembleL1, assembleL2, baseBookIdOf, bookDirs } from '../lib/context-layers.js'

// 临时目录：annotations.jsonl + books/<dir>/discussions.jsonl
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-ctx-'))
  const base = '54a42df3643425f414b55357679357a5233314937354137356a323175483278399'
  const bookDir = path.join(root, 'books', base)
  fs.mkdirSync(bookDir, { recursive: true })
  const ann = (o) => ({ bookId: `${base}k98f3284021498f137082c2e`, bookTitle: '静静的顿河', chapter: '六', selectedText: 'S1', userNote: '', timestamp: 1, ...o })
  const lines = [
    JSON.stringify(ann({ chapter: '六', selectedText: '划线甲', userNote: '这里不对劲', timestamp: 100 })),
    JSON.stringify(ann({ chapter: '六', selectedText: '划线乙', timestamp: 200 })),
    JSON.stringify(ann({ chapter: '七', selectedText: '划线丙', timestamp: 300 })),  // 别的章节
    JSON.stringify(ann({ chapter: '', selectedText: '划线丁', timestamp: 400 })),   // 无章节
  ]
  fs.writeFileSync(path.join(root, 'annotations.jsonl'), lines.join('\n') + '\n')
  const disc = (o) => ({ bookId: `${base}k...`, selectedText: '划线甲', takeaway: 'T', timestamp: 1, ...o })
  const dlines = [
    JSON.stringify(disc({ selectedText: '划线甲', takeaway: '沉淀一', timestamp: 10 })),
    JSON.stringify(disc({ selectedText: '划线甲', takeaway: '沉淀二', timestamp: 20 })),
    JSON.stringify(disc({ selectedText: '划线乙', takeaway: '沉淀乙一', timestamp: 30 })),
    JSON.stringify(disc({ selectedText: '划线乙', takeaway: '沉淀乙二', timestamp: 40 })),
    JSON.stringify(disc({ selectedText: '划线乙', takeaway: '沉淀乙三', timestamp: 50 })),
    JSON.stringify(disc({ selectedText: '划线丙', takeaway: '沉淀丙', timestamp: 60 })),
  ]
  fs.writeFileSync(path.join(bookDir, 'discussions.jsonl'), dlines.join('\n') + '\n')
  return root
}

test('L1：当前书 + 章节的标注，带第一反应与讨论沉淀（取最近 2 条）', () => {
  const root = makeFixture()
  const out = assembleL1({ annotationsPath: path.join(root, 'annotations.jsonl'), booksDir: path.join(root, 'books'), bookId: '54a42df3643425f414b55357679357a5233314937354137356a323175483278399', chapter: '六' })
  assert.ok(out.includes('[本章标注讨论]《静静的顿河》六（2 条标注）'))
  assert.ok(out.includes('划线甲'), '章节内标注在')
  assert.ok(out.includes('第一反应：这里不对劲'), 'userNote 在')
  assert.ok(out.includes('沉淀一'), 'takeaway 按时间取最近 2 条')
  assert.ok(out.includes('沉淀二'))
  assert.ok(!out.includes('划线丙'), '别的章节不混入')
  assert.ok(!out.includes('划线丁'), '无章节的不混入')
  assert.ok(!out.includes('沉淀乙一'), '别的标注的沉淀不混入')
})

test('L1：无该章节标注 → 返回空串', () => {
  const root = makeFixture()
  assert.equal(assembleL1({ annotationsPath: path.join(root, 'annotations.jsonl'), booksDir: path.join(root, 'books'), bookId: 'x', chapter: '六' }), '')
  assert.equal(assembleL1({ annotationsPath: path.join(root, 'annotations.jsonl'), booksDir: path.join(root, 'books'), bookId: '54a42df3643425f414b55357679357a5233314937354137356a323175483278399', chapter: '不存在的章节' }), '')
  assert.equal(assembleL1({ annotationsPath: '/不存在的文件', booksDir: path.join(root, 'books'), bookId: 'x', chapter: '六' }), '')
})

test('L2：全书被讨论 ≥min 次的标注（按次数降序，沉淀取最近 3 条）', () => {
  const root = makeFixture()
  const out = assembleL2({ annotationsPath: path.join(root, 'annotations.jsonl'), booksDir: path.join(root, 'books'), bookId: '54a42df3643425f414b55357679357a5233314937354137356a323175483278399', min: 2 })
  assert.ok(out.includes('[全书热点标注]（被讨论 ≥2 次的划线，共 2 条）'))
  assert.ok(out.includes('划线乙"（讨论 3 次）'), '次数最多的在前')
  assert.ok(out.includes('沉淀乙三') && out.includes('沉淀乙二') && out.includes('沉淀乙一'), '沉淀取最近 3 条')
  assert.ok(out.includes('划线甲"（讨论 2 次）'))
  assert.ok(!out.includes('划线丙'), '讨论 1 次的不算热点')
})

test('L2：没有达标标注 → 返回空串', () => {
  const root = makeFixture()
  assert.equal(assembleL2({ annotationsPath: path.join(root, 'annotations.jsonl'), booksDir: path.join(root, 'books'), bookId: '54a42df3643425f414b55357679357a5233314937354137356a323175483278399', min: 99 }), '')
})

test('工具：baseBookIdOf 去 k-suffix；bookDirs 含权威目录 + 历史 k 目录', () => {
  assert.equal(baseBookIdOf('abc123k98f3284021498f137082c2e'), 'abc123')
  assert.equal(baseBookIdOf('abc123'), 'abc123')
  const root = makeFixture()
  const books = path.join(root, 'books')
  const legacy = path.join(books, '54a42df3643425f414b55357679357a5233314937354137356a323175483278399k1234567890123456')
  fs.mkdirSync(legacy)
  const dirs = bookDirs(books, '54a42df3643425f414b55357679357a5233314937354137356a323175483278399k98f3284021498f137082c2e')
  assert.deepEqual(dirs, ['54a42df3643425f414b55357679357a5233314937354137356a323175483278399', '54a42df3643425f414b55357679357a5233314937354137356a323175483278399k1234567890123456'], '权威目录在前，历史 k 目录在后')
})
