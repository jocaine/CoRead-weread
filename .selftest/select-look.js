/** 只做一件事：确认真实拖拽后的选区存在，好让截图里能看到选中效果 */
const sel = window.getSelection()
const text = sel ? sel.toString() : ''
const tip = document.getElementById('rd-tip')
return {
  ok: text.trim().length > 3,
  checks: [
    { name: '拖拽选中了文字', ok: text.trim().length > 3, detail: text.slice(0, 40) },
    { name: '划词浮标出现了', ok: tip.hidden === false, detail: getComputedStyle(tip).display },
  ],
  errors: [],
  summary: { selected: text.slice(0, 40), scale: window.__readerTest.state.scale },
}
