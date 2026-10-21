/**
 * 模型 API 配置弹窗的预设地址 / 模型（2026-10-21）
 *
 * ── 候选值写在哪 ────────────────────────────────────────────────────────────
 * **只写在 sidebar.html 的两条 <datalist> 里**（`#api-base-presets` / `#api-model-presets`），
 * 本文件从 DOM 读，不另存一份表：两处各存一份迟早分叉，而分叉的表现是
 * "下拉里能选到的值，保存后跑不通"。加一家服务商 = 在 HTML 里加一行 <option>，不用改代码。
 *
 * ── 为什么要自己画那个箭头（原生的不可靠）──────────────────────────────────
 * `<input list>` 是原生 combobox：能点开选、也能直接输。但 **Chrome 不保证画出那个下拉箭头**
 * （2026-10-21 实测：Chrome 154 里，有值、有焦点、有候选项，输入框右端仍然什么都没有）。
 * 于是"这里能选预设"这件事在界面上完全看不出来 —— 用户只会以为这是个普通输入框。
 * 所以：输入框保持普通输入框（照样能打字、照样有原生提示），
 * 另外**加一个看得见的箭头按钮**，点开我们自己的一块列表。datalist 仍是唯一数据源。
 *
 * 箭头与列表都是本文件在 install() 时挂出来的，不是写死在 HTML 里：
 * 万一本文件没加载成功，用户看到的就是一个干净的输入框 —— 功能照旧，只是没有预设，
 * 而不是一个点了没反应的死按钮。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 * 这段逻辑只碰 #api-config 里的两个输入框和那两条 datalist，与侧栏别的状态无关。
 * 抽出来之后，才能在没有后端、没有 chrome 的普通页面上拿**这一份真文件**跑一遍
 * （生成脚本见 test/scratch/make-api-modal-preview.mjs）。
 */
;(function () {
  const BASE_LIST = '#api-base-presets'
  const MODEL_LIST = '#api-model-presets'
  const input = (id) => document.getElementById(id)
  const optionEls = (sel) => Array.from(document.querySelectorAll(sel))

  /** 预设地址（顺序 = HTML 里的书写顺序，第一个就是默认值） */
  function bases() {
    return optionEls(BASE_LIST + ' option').map((o) => o.value).filter(Boolean)
  }

  /** 某个地址下的预设模型；不传地址 = 全部预设模型 */
  function models(base) {
    const b = String(base || '').trim()
    return optionEls(MODEL_LIST + ' option')
      .filter((o) => !b || o.dataset.base === b)
      .map((o) => o.value)
      .filter(Boolean)
  }

  /** 这个模型名属于哪个预设地址（不是预设值 → 空串） */
  function baseOf(model) {
    const v = String(model || '').trim()
    if (!v) return ''
    const hit = optionEls(MODEL_LIST + ' option').find((o) => o.value === v)
    return hit ? (hit.dataset.base || '') : ''
  }

  /** 空着的字段补预设：地址 = 第一个预设，模型 = 那个地址的第一个模型 */
  function applyDefaults() {
    const baseEl = input('api-base')
    const modelEl = input('api-model')
    if (!baseEl || !modelEl) return
    if (!baseEl.value.trim()) {
      const list = bases()
      if (list.length) baseEl.value = list[0]
    }
    if (!modelEl.value.trim()) {
      const list = models(baseEl.value.trim())
      if (list.length) modelEl.value = list[0]
    }
  }

  /**
   * 地址变了：地址是预设的、而模型空着或是**别家**的预设模型时，换成这一家的第一个。
   * 手填的模型名一律不动 —— 自建代理常常用着同一家的模型名。
   */
  function syncModelToBase() {
    const baseEl = input('api-base')
    const modelEl = input('api-model')
    if (!baseEl || !modelEl) return
    const base = baseEl.value.trim()
    const wanted = models(base)
    if (!wanted.length) return                  // 不是预设地址 → 一个手指头都不碰
    const cur = modelEl.value.trim()
    const curBase = baseOf(cur)
    if (!cur || (curBase && curBase !== base)) modelEl.value = wanted[0]
  }

  /** 模型变了：地址空着、或本来就是某个预设地址时，补成它所属的那一个 */
  function syncBaseToModel() {
    const baseEl = input('api-base')
    const modelEl = input('api-model')
    if (!baseEl || !modelEl) return
    const owner = baseOf(modelEl.value)
    if (!owner) return                          // 手填的模型名 → 地址不动
    const cur = baseEl.value.trim()
    if (!cur || bases().includes(cur)) baseEl.value = owner
  }

  // ── 下拉：看得见的箭头 + 我们自己画的列表 ──────────────────────────────────
  const CARET = '<svg viewBox="0 0 12 12" aria-hidden="true">'
    + '<path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const el = (kind) => input(kind === 'base' ? 'api-base' : 'api-model')

  /** 给输入框套上外壳、加箭头按钮与列表容器（已存在则不重复加） */
  function ensureCombo(kind) {
    const box = el(kind)
    if (!box) return null
    let wrap = box.closest('.api-combo')
    if (!wrap) {
      wrap = document.createElement('div')
      wrap.className = 'api-combo'
      box.parentNode.insertBefore(wrap, box)
      wrap.appendChild(box)
    }
    if (wrap.querySelector('.api-combo-btn')) return wrap
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'api-combo-btn'
    btn.id = 'api-' + kind + '-btn'
    btn.setAttribute('aria-haspopup', 'listbox')
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-label', kind === 'base' ? '选择预设地址' : '选择预设模型')
    btn.innerHTML = CARET
    btn.addEventListener('click', (e) => { e.preventDefault(); toggleMenu(kind) })
    const pop = document.createElement('div')
    pop.className = 'api-combo-pop'
    pop.id = 'api-' + kind + '-menu'
    pop.setAttribute('role', 'listbox')
    pop.hidden = true
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...pop.querySelectorAll('.api-combo-item')]
      const i = items.indexOf(document.activeElement)
      const next = Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      if (items[next]) items[next].focus()
    })
    wrap.appendChild(btn)
    wrap.appendChild(pop)
    return wrap
  }

  /** 列表里该出现哪些值：地址永远显示全部；模型优先只显示当前地址那一家 */
  function menuValues(kind) {
    if (kind === 'base') return bases()
    const b = (input('api-base')?.value || '').trim()
    const own = models(b)
    return own.length ? own : models()      // 地址不是预设值（自建代理）→ 给全部预设模型
  }

  function fillMenu(kind, pop) {
    pop.replaceChildren()
    const list = menuValues(kind)
    if (!list.length) {
      const empty = document.createElement('div')
      empty.className = 'api-combo-empty'
      empty.textContent = '没有预设值'
      pop.appendChild(empty)
      return
    }
    for (const v of list) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'api-combo-item'
      item.setAttribute('role', 'option')
      item.textContent = v
      item.addEventListener('click', () => pick(kind, v))
      pop.appendChild(item)
    }
  }

  function closeMenus() {
    for (const kind of ['base', 'model']) {
      const pop = document.getElementById('api-' + kind + '-menu')
      if (pop && !pop.hidden) pop.hidden = true
      const btn = document.getElementById('api-' + kind + '-btn')
      if (btn) btn.setAttribute('aria-expanded', 'false')
    }
  }

  function toggleMenu(kind) {
    const pop = document.getElementById('api-' + kind + '-menu')
    const btn = document.getElementById('api-' + kind + '-btn')
    if (!pop || !btn) return
    const opening = pop.hidden
    closeMenus()
    if (!opening) return
    fillMenu(kind, pop)                    // 每次打开都按当前地址重算
    pop.hidden = false
    /**
     * 下方放不下就往上翻。两个真实约束（2026-10-21 都在截图里撞到过）：
     *   ① 弹窗面板是可滚动的（.api-panel 有 overflow-y:auto），往下展开的列表会被面板
     *      底边**裁掉**；
     *   ② 就算没被裁，它也会正好盖住「保存」—— 下拉列表压住主按钮，用户会以为没有保存。
     * 所以判据取"输入框到按钮顶边"的距离，而不是面板底边：列表只能占用按钮上方的空间。
     */
    const box = el(kind)
    const panel = pop.closest('.api-panel') || pop.offsetParent
    if (box && panel) {
      const actions = panel.querySelector('.api-actions')
      const limit = actions ? actions.getBoundingClientRect().top : panel.getBoundingClientRect().bottom
      const room = limit - box.getBoundingClientRect().bottom
      pop.classList.toggle('up', room < pop.offsetHeight + 4)
    }
    btn.setAttribute('aria-expanded', 'true')
    pop.querySelector('.api-combo-item')?.focus()
  }

  function pick(kind, value) {
    const box = el(kind)
    if (!box) return
    box.value = value
    // 走一遍 input 事件：地址↔模型的联动只有这一处规则，不再另写一份
    box.dispatchEvent(new Event('input', { bubbles: true }))
    closeMenus()
    box.focus()
  }

  /**
   * 接线：两个输入框的联动 + 两个下拉。sidebar.js 与预览页都调它 ——
   * 只写在这一处，免得"预览里好好的、真面板里没接上"。重复调用是空操作。
   */
  let wired = false
  function install() {
    if (wired) return
    const baseEl = input('api-base')
    const modelEl = input('api-model')
    if (!baseEl || !modelEl) return
    baseEl.addEventListener('input', () => { closeMenus(); syncModelToBase() })
    modelEl.addEventListener('input', () => { closeMenus(); syncBaseToModel() })
    ensureCombo('base')
    ensureCombo('model')
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.api-combo')) return
      closeMenus()
    })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus() })
    wired = true
  }

  window.CoreadApiPresets = {
    bases, models, baseOf, applyDefaults, syncModelToBase, syncBaseToModel, install,
    closeMenus, toggleMenu,
  }
})()
