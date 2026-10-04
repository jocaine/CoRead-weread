/** 一致性自检：reader.html 里的 id / class 是否都被 reader.js 引用（防手误改名） */
import fs from 'node:fs'

const html = fs.readFileSync('extension/reader.html', 'utf8')
const js = fs.readFileSync('extension/reader.js', 'utf8')

const ids = [...html.matchAll(/id="([a-zA-Z0-9-]+)"/g)].map((m) => m[1])
// 纯展示用的容器 id 不需要 JS 引用
const PRESENTATIONAL = new Set(['rd-library'])
const missingIds = ids.filter((id) => !js.includes(`'${id}'`) && !PRESENTATIONAL.has(id))

console.log('HTML 里的 id：' + ids.length + ' 个')
console.log('JS 未引用的 id：' + (missingIds.length ? missingIds.join(', ') : '(无)'))

// JS 里 els.xxx 用到的 id 是否都在 HTML 里存在
const elsBlock = js.slice(js.indexOf('const els = {'), js.indexOf('const state = {'))
const usedIds = [...elsBlock.matchAll(/\$\('([a-zA-Z0-9-]+)'\)/g)].map((m) => m[1])
const dangling = usedIds.filter((id) => !ids.includes(id))
console.log('JS 取了但 HTML 没有的 id：' + (dangling.length ? dangling.join(', ') : '(无)'))

// 关键 class 是否两边都有
const classes = ['rd-panel', 'rd-chip', 'rd-entry', 'rd-mark', 'rd-marquee', 'rd-tip', 'rd-toast', 'rd-page', 'textLayer']
for (const c of classes) {
  const inHtml = html.includes(c)
  const inJs = js.includes(c)
  const inCss = fs.readFileSync('extension/reader.css', 'utf8').includes('.' + c)
  console.log(`${c.padEnd(12)} html=${inHtml ? 'Y' : '-'} js=${inJs ? 'Y' : '-'} css=${inCss ? 'Y' : '-'}`)
}

process.exit(missingIds.length + dangling.length === 0 ? 0 : 1)
