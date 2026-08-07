// 运行在页面主世界，拦截 weread 的 clipboard 调用和章节正文 API
;(function () {
  function strUrl(url) {
    return typeof url === 'string' ? url : (url && url.url) || ''
  }

  function shouldDiscoverUrl(url) {
    var text = String(url || '')
    return text.indexOf('/web/') !== -1 && text.indexOf('127.0.0.1:7239') === -1
  }

  function shouldCaptureChapterUrl(url) {
    return String(url || '').indexOf('/web/book/chapter') !== -1
  }

  function shouldCaptureProgressUrl(url) {
    return String(url || '').indexOf('/web/book/getProgress') !== -1
  }

  function shouldCaptureBookmarkUrl(url) {
    return String(url || '').indexOf('/web/book/bookmarklist') !== -1
  }

  function shouldCaptureAddBookmarkUrl(url) {
    return String(url || '').indexOf('/web/book/addBookmark') !== -1
  }

  function shouldCaptureRemoveBookmarkUrl(url) {
    return String(url || '').indexOf('/web/book/removeBookmark') !== -1
  }

  // ── 跳转定位目标（canvas 阅读器） ──────────────────────────────────────────
  // canvas 书（如《静静的顿河》）正文画在画布上、不进 DOM，DOM 高亮定位不到引文。
  // 微信读书用 getProgress 恢复阅读位置（book.chapterUid + book.chapterOffset 字符偏移），
  // 而引文的 bookmarkRange 正是同基准的字符偏移——侧栏跳转 URL 带 ?crj=uid:start，
  // 这里在 document_start 解析，改写首次 getProgress 响应让阅读器直接定位到引文；
  // 改写一次即消费，不影响后续正常进度语义。改写只对 getProgress + 有目标时生效，
  // 其它响应 / 正常阅读完全不受影响（目标消费后 rewriteProgressBody 直接原样返回）。
  var jumpTarget = null
  var crjDiag = { search: String(location.search || '').slice(0, 120), parsed: false }
  try {
    var crjM = /[?&]crj=([^&]+)/.exec(location.search || '')
    if (crjM) {
      var crjRaw = decodeURIComponent(crjM[1]).split(':')
      var crjUid = parseInt(crjRaw[0], 10)
      var crjStart = parseInt(crjRaw[1], 10)
      if (crjUid > 0 && Number.isFinite(crjStart) && crjStart >= 0) {
        jumpTarget = { chapterUid: crjUid, offset: crjStart }
        crjDiag.parsed = true
        crjDiag.uid = crjUid
        crjDiag.offset = crjStart
      }
    }
  } catch (_) {}
  // 诊断：把 crj 解析结果 / getProgress 拦截情况上报给 receiver（content.js 转发）。
  // page_hook 在 document_start 运行、content.js 在 document_end 才监听，postMessage
  // 会丢早期消息——同时写进 window.__crjDiagLog，content.js 加载时统一补发。
  function postCrjDebug(obj) {
    try {
      window.__crjDiagLog = window.__crjDiagLog || []
      window.__crjDiagLog.push(obj)
      window.postMessage({ __cr: 'crj-debug', diag: obj }, '*')
    } catch (_) {}
  }
  postCrjDebug(crjDiag)
  // content.js 在 document_end（isolated world）读不到 MAIN world 的 window.__crjDiagLog，
  // document_start 阶段的早期诊断 postMessage 又会丢。content.js 加载完会 dispatch 一个
  // DOM CustomEvent（跨 world 可达），这里把缓存的诊断补发出去。
  try {
    window.addEventListener('coread-flush-crj', function () {
      try {
        var log = window.__crjDiagLog || []
        window.__crjDiagLog = []
        for (var i = 0; i < log.length; i++) window.postMessage({ __cr: 'crj-debug', diag: log[i] }, '*')
      } catch (_) {}
    })
  } catch (_) {}

  function rewriteProgressBody(raw) {
    if (!jumpTarget || typeof raw !== 'string') return raw
    try {
      var data = JSON.parse(raw)
      if (data && data.book && typeof data.book === 'object') {
        data.book.chapterUid = jumpTarget.chapterUid
        data.book.chapterIdx = jumpTarget.chapterUid
        data.book.chapterOffset = jumpTarget.offset
        postCrjDebug({ intercepted: true, wroteUid: jumpTarget.chapterUid, wroteOffset: jumpTarget.offset, rawLen: raw.length })
        jumpTarget = null  // 只消费一次
        // 诊断：改写已送达。轮询几秒 URL，看微信读书是否真的 pushState 导航到目标章
        //（落到 172 则 pathname 会带 k{encode(172)} 后缀），判断 getProgress 恢复是否生效。
        try {
          var _polls = 0
          var _iv = setInterval(function () {
            _polls++
            try {
              window.postMessage({ __cr: 'crj-url-poll', path: location.pathname, search: String(location.search || '').slice(0, 60) }, '*')
            } catch (_) {}
            if (_polls >= 6) clearInterval(_iv)
          }, 1000)
        } catch (_) {}
        return JSON.stringify(data)
      }
    } catch (_) {}
    return raw
  }

  function reportNetworkMeta(url, raw, source) {
    if (!shouldDiscoverUrl(url)) return
    window.postMessage({
      __cr: 'network-meta',
      url: String(url || ''),
      source: source,
      rawLength: String(raw || '').length,
      preview: cleanText(String(raw || '').slice(0, 300)),
    }, '*')
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim()
  }

  function selectionContext() {
    var sel = document.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    var range = sel.getRangeAt(0)
    var node = range.commonAncestorContainer
    var el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    var candidates = []
    var cur = el
    while (cur && cur !== document.body && candidates.length < 8) {
      var text = cleanText(cur.textContent || '')
      if (text) candidates.push(text)
      cur = cur.parentElement
    }
    candidates.sort(function (a, b) { return a.length - b.length })
    var selected = cleanText(sel.toString())
    var context = candidates.find(function (text) {
      return text.length >= selected.length && text.indexOf(selected) !== -1
    }) || candidates[0] || ''
    return {
      text: selected,
      context: context.slice(0, 4000),
      contextLength: context.length,
      ancestorTag: el?.tagName || '',
      ancestorClass: el?.className || '',
    }
  }

  // ── clipboard 拦截 ──────────────────────────────────────────────────────────
  var orig = navigator.clipboard?.writeText?.bind(navigator.clipboard)
  if (orig) {
    navigator.clipboard.writeText = function (text) {
      var ctx = selectionContext()
      window.postMessage({ __cr: 'copy', text: text, selection: ctx }, '*')
      return orig(text)
    }
  }
  var oe = document.execCommand.bind(document)
  document.execCommand = function (cmd) {
    var r = oe.apply(document, arguments)
    if (cmd === 'copy') {
      var t = document.getSelection?.()?.toString?.() || ''
      if (t) window.postMessage({ __cr: 'copy', text: t, selection: selectionContext() }, '*')
    }
    return r
  }

  // ── 章节正文 API 拦截 ────────────────────────────────────────────────────────
  var origFetch = window.fetch
  window.fetch = function (input, init) {
    var url = strUrl(input)
    var addBody = null
    var rmBody = null
    if (shouldCaptureAddBookmarkUrl(url)) {
      // 画微信读书划线 = addBookmark POST，请求体含新划线位置（chapterUid/range/markText）
      try { if (init && init.body !== undefined) addBody = typeof init.body === 'string' ? init.body : String(init.body || '') } catch (_) {}
    }
    if (shouldCaptureRemoveBookmarkUrl(url)) {
      // 删除划线请求体：学习微信读书的真实删除格式
      try { if (init && init.body !== undefined) rmBody = typeof init.body === 'string' ? init.body : String(init.body || '') } catch (_) {}
    }
    var result = origFetch.apply(this, arguments)
    if (addBody) {
      window.postMessage({ __cr: 'add-bookmark', url: url, body: addBody }, '*')
    }
    if (rmBody) {
      window.postMessage({ __cr: 'remove-bookmark-req', url: url, body: rmBody }, '*')
    }
    // canvas 跳转：改写 getProgress 响应返回给微信读书（只改写一次，消费 jumpTarget）。
    // 正常阅读无 jumpTarget 时走下面的普通捕获路径，行为不变。
    if (shouldCaptureProgressUrl(url) && jumpTarget) {
      return result.then(function (response) {
        // 用 clone 读正文：原 response 的 body 只能消费一次。改写失败（返回原 body）时
        // 把未消费的 response 还给调用方仍可正常读取；否则这里 text() 消费后 WeRead
        // 再读会抛 "Response body is already used"。
        return response.clone().text().then(function (raw) {
          window.postMessage({ __cr: 'progress', url: url, raw: raw }, '*')
          var rewritten = rewriteProgressBody(raw)
          if (rewritten === raw) return response
          // 改写后 body 长度可能变化 / 已解压：去掉会过期的 Content-Length / Content-Encoding
          var hdrs = new Headers(response.headers)
          hdrs.delete('Content-Length')
          hdrs.delete('Content-Encoding')
          return new Response(rewritten, {
            status: response.status,
            statusText: response.statusText,
            headers: hdrs,
          })
        })
      }).catch(function () { return result })
    }
    if (shouldDiscoverUrl(url)) {
      result.then(function (response) {
        response.clone().text().then(function (raw) {
          reportNetworkMeta(url, raw, 'fetch')
          if (shouldCaptureChapterUrl(url)) {
            window.postMessage({ __cr: 'chapter', url: url, raw: raw }, '*')
          }
          if (shouldCaptureProgressUrl(url)) {
            window.postMessage({ __cr: 'progress', url: url, raw: raw }, '*')
          }
          if (shouldCaptureBookmarkUrl(url)) {
            window.postMessage({ __cr: 'bookmarks', url: url, raw: raw }, '*')
          }
          if (shouldCaptureAddBookmarkUrl(url)) {
            window.postMessage({ __cr: 'add-bookmark-response', url: url, raw: raw }, '*')
          }
        }).catch(function () {})
      }).catch(function () {})
    }
    return result
  }

  var origOpen = XMLHttpRequest.prototype.open
  var origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__crUrl = url
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this
    if (shouldCaptureProgressUrl(this.__crUrl) && jumpTarget) {
      // canvas 跳转：改写 getProgress 响应。XHR 的 response 在微信读书自己的 load
      // 处理器里读，先注册的监听器可能先读到原始值，故在 send 时就给实例装一个
      // 拦截 getter（惰性求值，响应到达后读取才触发）。
      // 注意：content.js 自己的 capture 监听器（下方 load 里读 this.responseText）可能
      // 比微信读书先读——getter 在消费 jumpTarget 改写的同时，把原始 progress 也 post
      // 给 content.js 追踪（避免 content.js 把改写后的 chapterUid/offset 存成阅读位置）。
      try {
        var _rtDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText')
        var _rDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response')
        // 把原始 progress 交给 content.js 追踪（避免 content.js 收到改写后的值污染
        // _chapterUidInt/阅读位置）。responseType 'json' 时 responseText 为空字符串，
        // 不能 post 空值；object（纯 JSON）时 post JSON.stringify 后的原始串。
        var postOriginal = function (real) {
          try {
            if (xhr.__crProgressPosted) return
            xhr.__crProgressPosted = true
            if (typeof real === 'string') {
              if (real.length) window.postMessage({ __cr: 'progress', url: xhr.__crUrl, raw: real }, '*')
            } else if (real && typeof real === 'object') {
              try { window.postMessage({ __cr: 'progress', url: xhr.__crUrl, raw: JSON.stringify(real) }, '*') } catch (_) {}
            }
          } catch (_) {}
        }
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get: function () {
            var real = _rtDesc ? _rtDesc.get.call(xhr) : ''
            if (typeof real === 'string' && real.length) postOriginal(real)
            return rewriteProgressBody(real)
          },
        })
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () {
            var real = _rDesc ? _rDesc.get.call(xhr) : ''
            if (typeof real === 'string') {
              postOriginal(real)
              return rewriteProgressBody(real)
            }
            if (real && typeof real === 'object' && jumpTarget) {
              try {
                // 只处理纯 JSON 对象（responseType 'json'）；Blob/ArrayBuffer 走 JSON.stringify
                // 会得到 {}，损坏读取（F5），这里直接放行原始对象。
                if (real instanceof Blob || real instanceof ArrayBuffer ||
                    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(real))) {
                  return real
                }
                postOriginal(real)  // responseType 'json'：post 原始 JSON 对象
                var s = rewriteProgressBody(JSON.stringify(real))
                return JSON.parse(s)
              } catch (_) { return real }
            }
            return real
          },
        })
      } catch (_) {}
    }
    if (shouldCaptureAddBookmarkUrl(this.__crUrl)) {
      try {
        if (body !== undefined && body !== null) window.postMessage({ __cr: 'add-bookmark', url: this.__crUrl, body: String(body) }, '*')
      } catch (_) {}
    }
    if (shouldCaptureRemoveBookmarkUrl(this.__crUrl)) {
      try {
        if (body !== undefined && body !== null) window.postMessage({ __cr: 'remove-bookmark-req', url: this.__crUrl, body: String(body) }, '*')
      } catch (_) {}
    }
    if (shouldDiscoverUrl(this.__crUrl)) {
      this.addEventListener('load', function () {
        try {
          var raw = this.responseText || ''
          if (raw) {
            reportNetworkMeta(this.__crUrl, raw, 'xhr')
            if (shouldCaptureChapterUrl(this.__crUrl)) {
              window.postMessage({ __cr: 'chapter', url: this.__crUrl, raw: raw }, '*')
            }
            if (shouldCaptureProgressUrl(this.__crUrl) && !this.__crProgressPosted) {
              // getter 已把原始 progress 发给 content.js 时跳过（避免它收到改写后的值）
              window.postMessage({ __cr: 'progress', url: this.__crUrl, raw: raw }, '*')
            }
            if (shouldCaptureBookmarkUrl(this.__crUrl)) {
              window.postMessage({ __cr: 'bookmarks', url: this.__crUrl, raw: raw }, '*')
            }
            if (shouldCaptureAddBookmarkUrl(this.__crUrl)) {
              window.postMessage({ __cr: 'add-bookmark-response', url: this.__crUrl, raw: raw }, '*')
            }
          }
        } catch (_) {}
      })
    }
    return origSend.apply(this, arguments)
  }

  // ── 调用微信读书内部定位（精确到段落） ──────────────────────────────────
  // 侧栏点跳转 → content.js 转发 {__cr:'coread-internal-jump'} → 这里在 MAIN world
  // 找到 Vue reader 组件，调 changeSection({sectionIdx, searchItem})，微信读书自己按
  // 字符偏移在 canvas 里定位（对应它自己划线跳转用的 highLightDomsAndScrollTo）。
  // 脆弱点：依赖 Vue 组件结构/方法名，微信读书升级可能失效；findReaderVm 找不到时
  // 返回 ok:false，侧栏回退到 URL 章节跳转。
  // 遍历所有 DOM 元素找 Vue 组件实例（Vue2 用 __vue__，Vue3 用 __vueParentComponent），
  // 命中带 highLightDomsAndScrollTo 或 changeSection 方法的 reader 组件。
  // 阅读器组件里可能用于"删除划线"的方法名。canvas 阅读器各版本命名不一，
  // 多收集几种，找到哪个调哪个。diag 记录探索过程，便于定位为何找不到。
  var REMOVE_BOOKMARK_METHODS = [
    'removeBookmark', 'deleteBookmark', 'delBookmark', 'removeMark', 'deleteMark',
    'removeHighlight', 'deleteHighlight', 'removeHighlights', 'onRemoveBookmark',
  ]

  // 返回 { vm, method, diag }；method 为在 vm 上找到的删除方法名（找不到为 ''）。
  // 探测元素上的框架标记，并尝试从 Vue/React 组件树里找到带删除方法的 reader 组件。
  function findReaderVm() {
    function has(vm, name) { return vm && typeof vm[name] === 'function' }
    function firstMethod(vm) {
      for (var i = 0; i < REMOVE_BOOKMARK_METHODS.length; i++) {
        if (has(vm, REMOVE_BOOKMARK_METHODS[i])) return REMOVE_BOOKMARK_METHODS[i]
      }
      return ''
    }
    var diag = { totalEls: 0, vue2: 0, vue3: 0, react: 0, canvas: 0, winGlobals: [], readerGlobals: [], components: [] }
    var all
    try {
      all = document.querySelectorAll('*')
      diag.totalEls = all.length
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.tagName === 'CANVAS') diag.canvas++
        var vm2 = el.__vue__
        if (vm2) {
          diag.vue2++
          var m2 = firstMethod(vm2)
          if (m2) return { vm: vm2, method: m2, diag: diag }
        }
        var vm3 = el.__vueParentComponent
        if (vm3) {
          diag.vue3++
          var m3 = firstMethod(vm3)
          if (m3) return { vm: vm3, method: m3, diag: diag }
        }
        // React 17+：元素上有 __reactFiber$xxx / __reactProps$xxx
        if (!diag.react) {
          for (var k in el) {
            if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance') === 0) { diag.react++; break }
            if (k.indexOf('__reactProps$') === 0) { diag.react++; break }
          }
        }
      }
      // 框架全局探测
      var wg = []
      if (window.__VUE__) wg.push('__VUE__')
      if (window.Vue) wg.push('Vue')
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) wg.push('REACT_HOOK')
      if (document.getElementById && document.getElementById('app')) wg.push('#app-exists')
      if (wg.length) diag.winGlobals = diag.winGlobals.concat(['globals:' + wg.join(',')])
      // 阅读器/书签相关全局，便于判断 canvas 阅读器的暴露接口
      try {
        for (var wk in window) {
          if (/reader|bookmark|highlight|weread|wxreader|pageReader|wr$/i.test(wk)) {
            try { diag.readerGlobals.push(wk + ':' + typeof window[wk]) } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (_) {}

    // Vue 3：应用实例挂在挂载元素上（element.__vue_app__），从 app._instance 遍历 vnode 树找组件
    try {
      var appEl = document.getElementById('app')
      var app = appEl && appEl.__vue_app__
      if (!app && all) {
        // 也可能挂在其它元素上
        for (var a2 = 0; a2 < all.length; a2++) { if (all[a2].__vue_app__) { app = all[a2].__vue_app__; break } }
      }
      if (app) {
        diag.winGlobals.push('vue3-app-found')
        var foundApp = findInVue3Tree(app, diag)
        if (foundApp && foundApp.method) return { vm: foundApp.vm, method: foundApp.method, diag: diag }
      }
    } catch (_) {}
    return { vm: null, method: '', diag: diag }
  }

  // 遍历 Vue 3 vnode 树，找带删除划线方法的组件
  function findInVue3Tree(app, diag) {
    try {
      var root = app._instance
      if (!root) return null
      var seen = new Set()
      var stack = [root.subTree]
      while (stack.length) {
        var vnode = stack.pop()
        if (!vnode || seen.has(vnode)) continue
        seen.add(vnode)
        var comp = vnode.component
        if (comp && comp.proxy) {
          for (var i = 0; i < REMOVE_BOOKMARK_METHODS.length; i++) {
            var n = REMOVE_BOOKMARK_METHODS[i]
            if (typeof comp.proxy[n] === 'function') {
              if (diag) diag.components.push('vue3tree:' + n)
              return { vm: comp.proxy, method: n }
            }
          }
          if (comp.subTree) stack.push(comp.subTree)
        }
        var kids = vnode.children
        if (Array.isArray(kids)) for (var k = kids.length - 1; k >= 0; k--) stack.push(kids[k])
      }
    } catch (_) {}
    return null
  }

  function coreadInternalJump(d) {
    var found = findReaderVm()
    var vm = found.vm
    if (!vm) return { ok: false, reason: 'no-vm', diag: found.diag }
    var uid = Number(d.chapterUidInt) || 0
    var parts = String(d.range || '').split('-').map(function (x) { return parseInt(x, 10) })
    var s = parts[0], en = parts[1]
    var text = String(d.text || '')
    if (!uid || !Number.isFinite(s) || !Number.isFinite(en)) return { ok: false, reason: 'bad-range:' + d.range, diag: found.diag }
    var searchItem = {
      chapterUid: uid,
      absStart: s,
      absEnd: en,
      abstract: text,
      text: text,
      keyword: text ? [text] : [],
      matchWords: text ? [{ word: text }] : [],
    }
    try {
      // 目标章节已加载（含当前章节）→ 直接定位，瞬时滚动，不重载章节
      // （微信读书自己跳当前章节的划线就是这样）。未加载的章节才走章节导航。
      var hasScroll = typeof vm.highLightDomsAndScrollTo === 'function'
      var hasChange = typeof vm.changeSection === 'function'
      var mode = 'nav'
      if (hasScroll) {
        var targetSec = (typeof vm.getSectionIdxWithOffset === 'function') ? vm.getSectionIdxWithOffset(s) : -1
        if (targetSec >= 0) {
          mode = 'scroll'
          vm.highLightDomsAndScrollTo(searchItem)
        } else {
          if (hasChange) vm.changeSection({ sectionIdx: uid, searchItem: searchItem })
          else { vm.highLightDomsAndScrollTo(searchItem); mode = 'scroll-nofallback' }
        }
      } else if (hasChange) {
        vm.changeSection({ sectionIdx: uid, searchItem: searchItem })
      } else {
        return { ok: false, reason: 'no-method', diag: found.diag }
      }
      return { ok: true, mode: mode, targetSec: typeof vm.getSectionIdxWithOffset === 'function' ? vm.getSectionIdxWithOffset(s) : -1 }
    } catch (e) {
      return { ok: false, reason: 'throw:' + (e && e.message), diag: found.diag }
    }
  }

  // 删除微信读书划线：调 reader 组件自身的删除划线方法（走微信读书封装好的删除请求，
  // 会更新阅读器本地 store 并重绘画布，划线即刻消失）。找不到组件时返回 no-vm + diag。
  function coreadRemoveBookmark(bookmarkId) {
    var found = findReaderVm()
    var vm = found.vm
    var method = found.method || ''
    if (!vm || !method) return { ok: false, reason: 'no-vm', diag: found.diag, method: '' }
    try {
      vm[method]([String(bookmarkId)])
      return { ok: true, method: method, diag: found.diag }
    } catch (e) {
      return { ok: false, reason: 'throw:' + (e && e.message), method: method, diag: found.diag }
    }
  }

  window.addEventListener('message', function (e) {
    if (!e.data) return
    if (e.data.__cr === 'coread-internal-jump') {
      var result = coreadInternalJump(e.data)
      try {
        window.postMessage({
          __cr: 'coread-internal-jump-result',
          ok: !!result.ok, reason: result.reason || '',
          mode: result.mode || '', targetSec: result.targetSec ?? -1,
          diag: result.diag || null,
        }, '*')
      } catch (_) {}
      return
    }
    if (e.data.__cr === 'coread-remove-bookmark') {
      var rr = coreadRemoveBookmark(e.data.bookmarkId)
      try {
        window.postMessage({
          __cr: 'coread-remove-bookmark-result', ok: !!rr.ok, reason: rr.reason || '',
          method: rr.method || '', diag: rr.diag || null,
        }, '*')
      } catch (_) {}
      return
    }
    if (e.data.__cr === 'coread-scan-reader') {
      // 主动诊断：侧栏删除前先扫一遍阅读器环境，看删除方法 / 全局接口是否存在
      var fr = findReaderVm()
      try {
        window.postMessage({
          __cr: 'coread-scan-reader-result',
          ok: !!fr.vm, method: fr.method || '',
          diag: fr.diag || null,
        }, '*')
      } catch (_) {}
    }
  })
})()
