/**
 * 译文对照面板（自包含组件）
 *
 * 位置：挂在 CoRead 侧栏里（不再占用阅读器页面的一栏 —— 那样开着侧栏就是两栏并排）。
 * 自包含：样式自己注入，只依赖传入的两个回调（send / onClose），
 * 所以它也能被 .selftest/notes.html 独立加载来测。
 *
 * 与阅读器的通信都经后台中继：
 *   本组件 → send({action:'readerCommand', type, id, text?})
 *   阅读器 → send({action:'readerSync', snapshot}) → 后台广播 → 本组件 update()
 */
;(function () {
  'use strict'

  const STYLE_ID = 'coread-notes-style'

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
.rn-wrap { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rn-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--line, #dfe3e8); font-weight: 600; flex: none; }
.rn-spacer { flex: 1; }
.rn-muted { color: var(--muted, #6b7280); font-weight: 400; font-size: 12px; }
.rn-book { padding: 6px 12px; font-size: 12px; color: var(--muted, #6b7280);
  border-bottom: 1px solid var(--line, #eef1f4); flex: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-list { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.rn-item { border: 1px solid var(--line, #dfe3e8); border-radius: 8px; padding: 8px 10px; background: #fff; }
.rn-item.is-active { border-color: #f0c070; background: #fffaf0; }
.rn-item.is-error { border-color: #e8b4b4; }
.rn-src { color: var(--muted, #6b7280); line-height: 1.5; max-height: 4.6em; overflow: hidden;
  cursor: pointer; border-left: 2px solid #d8e6dd; padding-left: 8px; margin-bottom: 6px; }
.rn-src:hover { color: #23262b; }
.rn-src.is-open { max-height: none; }
.rn-dst { line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.rn-pending { color: var(--muted, #6b7280); }
.rn-err { color: #9a3b3b; }
.rn-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
.rn-acts button { border: 1px solid var(--line, #dfe3e8); background: #fff; color: #3c4148;
  font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.rn-acts button:hover { background: #f2f4f7; }
.rn-acts button.rn-ref { border-color: #a8dcc0; color: #07883f; background: #f2fbf6; }
.rn-edit { margin-top: 8px; }
.rn-edit textarea { width: 100%; min-height: 72px; font: inherit; line-height: 1.5;
  border: 1px solid var(--line, #dfe3e8); border-radius: 6px; padding: 6px 8px; resize: vertical; }
.rn-edit-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.rn-empty { padding: 16px; color: var(--muted, #6b7280); line-height: 1.8; }
.rn-empty kbd { border: 1px solid var(--line, #dfe3e8); border-bottom-width: 2px; border-radius: 4px;
  padding: 0 4px; background: #fafbfc; font-family: inherit; }
`
    document.head.appendChild(s)
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true } catch (e) {}
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (e) { return false }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

  /**
   * 挂载。
   * @param {HTMLElement} root 容器
   * @param {{send:(msg:object)=>Promise<any>, onClose?:()=>void, toast?:(t:string,err?:boolean)=>void}} opts
   */
  function mount(root, opts) {
    injectStyle()
    const send = opts.send
    const toast = opts.toast || (() => {})
    let snapshot = { book: null, entries: [], activeId: '', page: 0, total: 0 }
    let editingId = ''

    root.classList.add('rn-wrap')
    root.replaceChildren()

    const head = el('div', 'rn-head')
    const title = el('span', null, '译文对照')
    const spacer = el('span', 'rn-spacer')
    const count = el('span', 'rn-muted', '0 条')
    const clearBtn = el('button', 'rn-muted', '清空')
    clearBtn.type = 'button'
    clearBtn.style.cssText = 'border:1px solid var(--line,#dfe3e8);background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit;font-size:12px'
    clearBtn.addEventListener('click', () => send({ action: 'readerCommand', type: 'clear' }))
    const closeBtn = el('button', 'rn-muted', '← 返回')
    closeBtn.type = 'button'
    closeBtn.title = '返回共读标注'
    closeBtn.style.cssText = 'border:0;background:transparent;cursor:pointer;font:inherit;padding:2px 6px'
    closeBtn.addEventListener('click', () => opts.onClose && opts.onClose())
    head.append(title, spacer, count, clearBtn, closeBtn)

    const bookLine = el('div', 'rn-book', '')
    const list = el('div', 'rn-list')
    const empty = el('div', 'rn-empty')
    empty.append(
      el('div', null, '划选一段原文按 Alt+T 翻译；扫描件用阅读器工具栏的「框选翻译」。'),
      el('div', null, '译文会显示在这里，并贴回原文位置。'),
    )
    root.append(head, bookLine, list, empty)

    function render() {
      const entries = snapshot.entries || []
      count.textContent = entries.length + ' 条'
      bookLine.textContent = snapshot.book
        ? snapshot.book.name + (snapshot.total ? '　第 ' + (snapshot.page || 1) + ' / ' + snapshot.total + ' 页' : '')
        : '未打开 PDF'
      empty.hidden = entries.length > 0
      list.replaceChildren()

      for (const e of entries) {
        const item = el('div', 'rn-item' + (e.id === snapshot.activeId ? ' is-active' : '') + (e.error ? ' is-error' : ''))
        item.dataset.id = e.id

        const src = el('div', 'rn-src', e.source || (e.kind === 'image' ? '（图片区域）' : ''))
        src.title = '点击跳到原文'
        src.addEventListener('click', () => {
          src.classList.toggle('is-open')
          send({ action: 'readerCommand', type: 'reveal', id: e.id })
        })

        const dst = el('div', 'rn-dst')
        if (e.pending) dst.append(el('span', 'rn-pending', '翻译中…'))
        else if (e.error) dst.append(el('span', 'rn-err', '失败：' + e.error))
        else dst.textContent = e.translation || ''

        item.append(src, dst)

        if (editingId === e.id) {
          const box = el('div', 'rn-edit')
          const ta = document.createElement('textarea')
          ta.value = e.source || ''
          ta.spellcheck = false
          const acts = el('div', 'rn-edit-acts')
          const okBtn = el('button', null, '重译')
          okBtn.type = 'button'
          okBtn.addEventListener('click', () => {
            const text = ta.value.trim()
            if (!text) return
            send({ action: 'readerCommand', type: 'retranslate', id: e.id, text })
            editingId = ''
            render()
          })
          const cancelBtn = el('button', null, '取消')
          cancelBtn.type = 'button'
          cancelBtn.addEventListener('click', () => { editingId = ''; render() })
          acts.append(cancelBtn, okBtn)
          box.append(ta, acts)
          item.append(box)
          setTimeout(() => ta.focus(), 0)
        } else {
          const acts = el('div', 'rn-acts')
          const mk = (label, fn, cls) => {
            const b = el('button', cls || null, label)
            b.type = 'button'
            b.addEventListener('click', fn)
            return b
          }
          acts.append(
            mk('跳到原文', () => send({ action: 'readerCommand', type: 'reveal', id: e.id })),
            mk('修改原文重译', () => { editingId = e.id; render() }),
            mk('复制译文', async () => {
              const ok = await copyText(e.translation || '')
              toast(ok ? '已复制' : '复制失败', !ok)
            }),
            mk('设为引用', async () => {
              const r = await send({ action: 'readerCommand', type: 'reference', id: e.id })
              toast(r && r.ok ? '已设为引用' : '设为引用失败：' + ((r && r.error && r.error.message) || '原因未知'),
                !(r && r.ok))
            }, 'rn-ref'),
            mk('删除', () => send({ action: 'readerCommand', type: 'remove', id: e.id })),
          )
          item.append(acts)
        }

        list.appendChild(item)
      }
    }

    render()

    return {
      update(next) {
        snapshot = Object.assign({}, snapshot, next || {})
        render()
      },
      getSnapshot() { return snapshot },
      /** 双击空白处收起（阅读器把双击事件转成 readerCommand:closeNotes） */
    }
  }

  window.CoReadNotes = { mount }
})()
