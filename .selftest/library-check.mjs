/**
 * 书库接口的真实验证：直接打 HTTP（含浏览器指纹头），不是模拟。
 * 用法：node .selftest/library-check.mjs [端口]
 */
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 7241)
const BASE = `http://127.0.0.1:${PORT}`
// 与扩展页面一致：带 Origin 与浏览器指纹，receiver 才放行
const HEADERS = {
  Origin: 'chrome-extension://selftest',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
}

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '   → ' + JSON.stringify(detail)))
}

const pdf = fs.readFileSync('.selftest/sample.pdf')
const hash = 'a'.repeat(64)          // 测试用的假哈希（十六进制 64 位）

try {
  // 1) 存原件
  const put = await fetch(`${BASE}/reader-book-file?hash=${hash}&name=${encodeURIComponent('sample.pdf')}`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/pdf' }, body: pdf,
  })
  const putBody = await put.json()
  check('存 PDF 返回 200 且 ok', put.status === 200 && putBody.ok, { status: put.status, body: putBody })

  // 2) 落盘了
  const onDisk = `receiver/books/${hash}/source.pdf`
  check('原件落在 receiver/books/<hash>/source.pdf', fs.existsSync(onDisk))
  check('落盘大小一致', fs.existsSync(onDisk) && fs.statSync(onDisk).size === pdf.length,
    { disk: fs.existsSync(onDisk) ? fs.statSync(onDisk).size : 0, src: pdf.length })

  // 3) 取回来，内容一致
  const got = await fetch(`${BASE}/reader-book-file?hash=${hash}`, { headers: HEADERS })
  const buf = Buffer.from(await got.arrayBuffer())
  check('取回返回 200 且是 PDF', got.status === 200 && buf.slice(0, 5).toString('latin1') === '%PDF-', got.status)
  check('取回内容与原件逐字节一致', buf.equals(pdf), { got: buf.length, src: pdf.length })

  // 4) 列表里有它
  const list = await (await fetch(`${BASE}/reader-books`, { headers: HEADERS })).json()
  const item = (list.books || []).find((b) => b.hash === hash)
  check('书库列表里有这本', !!item, (list.books || []).length)
  check('列表带书名/大小/页数', !!(item && item.name === 'sample.pdf' && item.size === pdf.length), item)

  // 5) 登记元信息（页数、打开时间）
  const metaRes = await fetch(`${BASE}/reader-book`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, name: 'sample.pdf', pages: 3, entries: 2, page: 2 }),
  })
  const metaBody = await metaRes.json()
  check('登记元信息返回 200', metaRes.status === 200 && metaBody.ok, metaBody.error)
  const list2 = await (await fetch(`${BASE}/reader-books`, { headers: HEADERS })).json()
  const item2 = (list2.books || []).find((b) => b.hash === hash)
  check('页数与译文条数写进去了', !!(item2 && item2.pages === 3 && item2.entries === 2), item2)
  check('列表按最近打开排序（这本排最前）', (list2.books || [])[0] && list2.books[0].hash === hash)

  // 6) 拒绝非 PDF
  const bad = await fetch(`${BASE}/reader-book-file?hash=${'b'.repeat(64)}`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/pdf' }, body: Buffer.from('not a pdf'),
  })
  check('非 PDF 被拒（400）', bad.status === 400, bad.status)

  // 7) 拒绝非法哈希（路径穿越）
  const bad2 = await fetch(`${BASE}/reader-book-file?hash=../etc&name=x`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/pdf' }, body: pdf,
  })
  check('非法哈希被拒（400）', bad2.status === 400, bad2.status)
  check('没有在 books 之外写出文件', !fs.existsSync('receiver/etc'))

  // 8) 取不存在的书 → 404
  const gone = await fetch(`${BASE}/reader-book-file?hash=${'c'.repeat(64)}`, { headers: HEADERS })
  check('取不存在的书返回 404', gone.status === 404, gone.status)

  // 9) 不带指纹头（普通网页/命令行）→ 403
  const noFp = await fetch(`${BASE}/reader-books`)
  check('不带浏览器指纹的请求被拒（403）', noFp.status === 403, noFp.status)

  // 10) 删除
  const del = await fetch(`${BASE}/reader-book-delete`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  })
  check('删除返回 200', del.status === 200 && (await del.json()).ok)
  check('原件已删掉', !fs.existsSync(onDisk))
} catch (e) {
  fail++
  console.log('  FAIL 异常：' + (e && e.message))
}

console.log(`\n合计：通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
