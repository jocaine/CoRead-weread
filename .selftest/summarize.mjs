/** 把 .selftest/last-report.json 摘要成一行一项。用法：node .selftest/summarize.mjs [文件] */
import fs from 'node:fs'

const file = process.argv[2] || '.selftest/last-report.json'
const data = JSON.parse(fs.readFileSync(file, 'utf8'))

const show = (title, r) => {
  if (!r) return
  console.log('--- ' + title + '   ok=' + r.ok)
  if (r.context) console.log('  环境 ' + r.context + (r.storageKind ? '  ·  ' + r.storageKind : ''))
  for (const c of r.checks || []) {
    console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + (c.ok || c.detail === '' ? '' : '   → ' + JSON.stringify(c.detail)))
  }
  if (r.errors && r.errors.length) console.log('  ERRORS ' + JSON.stringify(r.errors, null, 2))
  if (r.summary) console.log('  summary ' + JSON.stringify(r.summary))
}

show('第一段：打开 → 划词 → 翻译 → 高亮 → 缩放', data.report)
show('第二段：刷新页面后重新打开（持久化）', data.report2)

console.log('--- 页面报错 ---')
const errs = (data.consoleErrors || []).filter((e) => !/favicon/i.test(e))
console.log(errs.length ? errs.join('\n') : '(无)')
