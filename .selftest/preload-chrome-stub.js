/**
 * 页面脚本执行前就注入的 chrome 替身（用 drive.mjs --preload= 传）。
 *
 * 为什么必须提前：reader.js 在**模块顶层**注册 chrome.runtime.onMessage 监听。
 * 替身要是等场景脚本才装，那次注册就已经错过了 —— 表现是"消息监听没注册"，
 * 看着像产品 bug，其实是自测时序问题（踩过）。
 */
;(function () {
  const store = {
    async get(key) {
      if (key === null) {
        const all = {}
        for (const k of Object.keys(localStorage)) {
          try { all[k] = JSON.parse(localStorage.getItem(k)) } catch (e) {}
        }
        return all
      }
      const k = typeof key === 'string' ? key : Object.keys(key)[0]
      const raw = localStorage.getItem(k)
      return raw ? { [k]: JSON.parse(raw) } : {}
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v)) },
  }

  window.__stubbedStorage = true
  window.__sent = []
  const listeners = []
  window.__msgListeners = listeners

  window.chrome = {
    storage: { local: store },
    runtime: {
      sendMessage: async (msg) => {
        window.__sent.push(msg)
        return { ok: true }
      },
      onMessage: {
        addListener: (fn) => { listeners.push(fn) },
        removeListener: (fn) => {
          const i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
        },
      },
      getURL: (p) => new URL(p, location.href).href,
      id: 'selftest',
    },
  }
})()
