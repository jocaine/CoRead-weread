/**
 * 自测用的静态服务：把仓库根目录当站点发布，另加一个 /report 接口。
 * 页面把测到的结构化结果 POST 到 /report，这里打到 stdout —— 这样无头浏览器里
 * 发生的事情可以直接在终端读到，不用靠看截图猜。
 *
 *   node .selftest/serve.mjs [端口]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 7301)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let pretty = body
      try { pretty = JSON.stringify(JSON.parse(body), null, 2) } catch {}
      console.log('\n===== REPORT =====\n' + pretty + '\n==================')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }

  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const filePath = path.join(ROOT, urlPath)
  // 只允许读仓库内的文件
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`404 ${urlPath}`)
      res.writeHead(404).end('not found')
      return
    }
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }
    // 扩展页面跑在 MV3 的 CSP 下（script-src 'self'; object-src 'self'）。
    // 无头 Chrome 现在加载不了扩展，所以用同样的响应头把这份 CSP 复现出来：
    // pdf.js 的主库、worker 与文字层必须在这个 CSP 下也能跑，否则真实扩展里就是坏的。
    if (urlPath.startsWith('/extension/')) {
      headers['Content-Security-Policy'] = "script-src 'self'; object-src 'self'"
    }
    res.writeHead(200, headers)
    res.end(data)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`selftest server on http://127.0.0.1:${PORT}/  (root=${ROOT})`)
})
