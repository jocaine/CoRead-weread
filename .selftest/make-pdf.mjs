/**
 * 生成一份最小但合法的 PDF，用来验证阅读器（文字层、选区、缩放、图片页）。
 * 不引依赖：手写 PDF 对象 + 自己算 xref 字节偏移；图片用 FlateDecode 原始像素，
 * 这样不需要任何图像编码库也能造出"只有图、没有文字"的页（模拟扫描件）。
 *
 *   node .selftest/make-pdf.mjs [输出路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT = process.argv[2] || path.join(import.meta.dirname, 'sample.pdf')
// --scan：整本都是图片页（模拟扫描件），用来验证"扫描件"提示这一支
const SCAN_ONLY = process.argv.includes('--scan')
// --repeat=N：把文字页重复 N 遍，用来造"很多页"的书（验证缩放只重画看得见的页）
const REPEAT = Number((process.argv.find((a) => a.startsWith('--repeat=')) || '').split('=')[1] || 1)

// 三页：短句（测选区）、长段落（测跨行与锚点）、纯图片（测图片解码与"扫描件"分支）
const BASE_TEXT_PAGES = SCAN_ONLY ? [] : [
  [
    'The quick brown fox jumps over the lazy dog.',
    'Second line of the sample document.',
    'Third line, kept short on purpose.',
  ],
  [
    'Reading foreign literature means meeting sentences that do not survive',
    'translation by themselves. A reader needs the original and the rendering',
    'side by side, on the same line of sight, without losing the place.',
    '',
    'This paragraph exists so the self test can select across several lines and',
    'check that the anchor (page number plus character offset) still resolves',
    'after the zoom level changes.',
  ],
]
const IMAGE_PAGE = true
const IMAGE_PAGE_COUNT = SCAN_ONLY ? 2 : 1   // 扫描件模式：两页都是图片

// 重复时把页码写进首行，方便一眼看出在第几页
const TEXT_PAGES = []
for (let r = 0; r < REPEAT; r++) {
  for (const lines of BASE_TEXT_PAGES) {
    TEXT_PAGES.push(REPEAT > 1 ? [`[page ${TEXT_PAGES.length + 1}]`, ...lines] : lines)
  }
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

function textStream(lines) {
  return lines
    .map((line, i) => (line ? `BT /F1 14 Tf 72 ${720 - i * 22} Td (${esc(line)}) Tj ET` : ''))
    .filter(Boolean)
    .join('\n')
}

/** 造一张 240×160 的彩色渐变图，压成 FlateDecode 的原始 RGB 数据 */
function makeImage() {
  const w = 240, h = 160
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      raw[i] = Math.round(255 * (x / w))          // 横向红→黑
      raw[i + 1] = Math.round(255 * (y / h))      // 纵向绿→黑
      raw[i + 2] = 180 - Math.round(120 * (x / w))
    }
  }
  return { w, h, data: zlib.deflateSync(raw) }
}

function buildPdf() {
  const objects = []
  const put = (num, body) => { objects[num] = body }
  const kids = []
  let next = 4            // 1 Catalog, 2 Pages, 3 Font

  const img = IMAGE_PAGE ? makeImage() : null
  const imgObjNum = img ? null : 0
  let imgNum = 0
  if (img) {
    imgNum = next++
    put(imgNum, null)     // 占位，稍后用真实长度填（需要先知道编号）
  }

  for (let p = 0; p < TEXT_PAGES.length; p++) {
    const pageNum = next++
    const contentNum = next++
    kids.push(`${pageNum} 0 R`)
    const stream = textStream(TEXT_PAGES[p])
    put(pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`)
    put(contentNum, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  }

  if (img) {
    for (let k = 0; k < IMAGE_PAGE_COUNT; k++) {
      kids.push(`${next} 0 R`)
      const pageNum = next++
      const contentNum = next++
      const stream = `q 360 0 0 240 126 ${320 - k * 60} cm /Im1 Do Q`
      put(pageNum,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /XObject << /Im1 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`)
      put(contentNum, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    }
  }

  put(1, '<< /Type /Catalog /Pages 2 0 R >>')
  put(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`)
  put(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  // 图像对象要单独处理：它的流是二进制，得按 latin1 写
  const binaries = {}
  if (img) {
    binaries[imgNum] =
      `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.data.length} >>\n` +
      `stream\n` + img.data.toString('latin1') + `\nendstream`
  }

  let pdf = '%PDF-1.4\n'
  const offsets = []
  const total = next
  for (let n = 1; n < total; n++) {
    if (objects[n] === undefined && binaries[n] === undefined) continue
    offsets[n] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${n} 0 obj\n${binaries[n] !== undefined ? binaries[n] : objects[n]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${total}\n`
  pdf += '0000000000 65535 f \n'
  for (let n = 1; n < total; n++) {
    pdf += (offsets[n] === undefined ? '0000000000 65535 f ' : String(offsets[n]).padStart(10, '0') + ' 00000 n ') + '\n'
  }
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const buf = buildPdf()
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, buf)
console.log(`写出 ${OUT}（${buf.length} 字节，${TEXT_PAGES.length + (IMAGE_PAGE ? IMAGE_PAGE_COUNT : 0)} 页）`)
