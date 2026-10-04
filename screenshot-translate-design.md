# 翻译能力（框选截图 / 划词）：实现方案

> 状态：**已实现，并已并入 CoRead 主扩展 `extension/`**。本文件记录该能力的设计与边界，代码不再独立成扩展。
> 合并记录见 §13。原定位是独立的 Chrome MV3 扩展，现在与共读共用同一个扩展、同一份模型配置。

## 1. 目标

一句话：**按键 → 框选 → 出「原文 + 译文」**。

v1 包含：

- 框选截图（快捷键 `Alt+S`，或点扩展图标 → 「框选」）
- 多模态模型直接读图翻译，无本地 OCR
- 气泡显示「原文 + 译文」，位置可拖拽，`Esc` 关闭
- 译文一键复制
- 原文可编辑，改完点「重译」（或 Ctrl+Enter）手动重新翻译；原文未改动时按钮置灰（纯文本请求）
- 复用 CoRead 的模型 API 配置

v1 不含（划词翻译已在 v1.1 追加，见 §11）：整页翻译、目标语言切换、历史记录、术语表、系统级截图、粘贴图片、朗读。

## 2. 技术选型

| 决策 | 结论 | 理由 |
|---|---|---|
| OCR | 不引入 | 模型直接读图，本地 OCR 的整条管线（语言包、wasm CSP、offscreen、中文精度）随之消失 |
| 翻译 | 在线多模态 LLM，OpenAI 兼容 `image_url` | 已有 DeepSeek 可用：`deepseek-flash` 吃 base64 data URL，格式按文件内容嗅探，每张图 token 上限 1024 |
| UI 主体 | 移植 `bssm-oss/img-to-translate`（MIT）的遮罩拖框、裁剪、气泡 | 已核实：仓库 24 个文件、纯原生 JS、无构建、MIT |
| 模型配置 | 读 CoRead receiver 的 `GET /api-config` | 用户选定 |
| 权限姿态 | 快捷键召唤式 | 安装时不出现「读取所有网站数据」警告 |

第三方依赖：**零**。全部为原生 JS。

## 3. 权限与 manifest

```json
{
  "manifest_version": 3,
  "name": "CoRead 截图翻译",
  "version": "0.1.0",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://127.0.0.1:7239/*"],
  "optional_host_permissions": ["https://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "commands": {
    "translate-region": {
      "suggested_key": { "default": "Alt+S" },
      "description": "截图翻译"
    }
  }
}
```

| 权限 | 用途 |
|---|---|
| `activeTab` | `captureVisibleTab` 与 `scripting.executeScript` 的前置条件 |
| `scripting` | 按需注入遮罩脚本 |
| `storage` | 缓存模型配置与用户设置 |
| `127.0.0.1:7239` | 读 CoRead 的模型 API 配置 |
| `optional_host_permissions` | 模型服务域名，保存配置时按实际 apiBase 申请 |

不声明 `<all_urls>`，不声明 content_scripts 静态注入，不申请 `offscreen`。

`captureVisibleTab` 要求 `activeTab` 或 `<all_urls>`。两条入口都构成用户手势：点扩展图标打开 popup 属于 action 触发，快捷键属于 `chrome.commands` 触发。

## 4. 交互流程

```
Alt+S ／ popup 的「框选」
  → chrome.scripting.executeScript 注入 overlay.js（window.__stLoaded 守卫，幂等）
  → overlay 画全屏遮罩，用户拖出矩形
      ├─ Esc 或右键 → 撤销遮罩，退出
      └─ 松开且宽高 ≥ 10px → 回报 { rect, dpr, viewportWidth }
  → SW 调 chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 })
      └─ 失败（每秒上限 2 次）→ 气泡提示「截图过于频繁，稍后重试」
  → overlay 用 canvas 裁剪
      ├─ 倍率 = bitmap.width / viewportWidth
      ├─ 最长边 > 1600px → 等比缩放
      └─ 输出 image/png 的 base64
  → overlay 把 base64 发给 SW
  → SW fetch 模型 API（经 host permission 放行）
  → 结果回 overlay → 气泡渲染
```

裁剪放在 content script，不放 service worker。该路径由 `img-to-translate` 实盘验证。service worker 内用 `OffscreenCanvas` 裁剪是后续优化项，省掉一次大体积消息传递。

遮罩与气泡挂在**闭合 Shadow DOM** 里。宿主页面的 CSS 重置（`box-sizing`、`*` 选择器）影响不到工具 UI。

## 5. 请求规格

端点：`{apiBase}/chat/completions`

```json
{
  "model": "<视觉模型>",
  "temperature": 0.2,
  "max_tokens": 2048,
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<PROMPT>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<B64>" } }
    ]
  }]
}
```

约束：图片只能出现在 `user` 消息。放入 `system` 或 `assistant` 会被上游以 400 拒绝。

输出协议（严格 JSON）：

```json
{ "original": "…", "translation": "…" }
```

`PROMPT` 固定为：

```
你是屏幕截图翻译器。图片是用户框选的一块屏幕区域。
1. original：逐字誊写图片中的正文，不改写、不补全、不总结，保留原有的段落分隔。
2. translation：把 original 译成简体中文，忠实原文，术语前后一致，保留段落分隔。
3. 图片可能包含界面元素、图标或截断的半行文字，只处理正文，忽略明显的界面噪声。
4. 只输出 JSON：{"original":"…","translation":"…"}，不要任何解释、前后缀或代码块。
```

解析失败重试 1 次（原样重发）。仍失败则气泡报「结果解析失败，请重试」。

重译请求：原文被编辑后，只发文本、不发图。请求体去掉 `image_url`，`PROMPT` 换成「把给定文字译成简体中文，只输出 JSON `{"translation":"…"}`」。

## 6. 配置来源

合并进 CoRead 后，模型配置默认只有一个真源：`agent/api-config.json`（即侧栏「⋯ → 🔑 模型 API 配置」写的那一份）。工具箱的翻译页提供三个**可选的按字段覆盖**：填了就用填的，留空的仍用 CoRead 的，所以只想换个视觉模型时只填「模型」一项即可。

```
每次翻译前
  → GET http://127.0.0.1:7239/api-config
      ├─ 200 且有 apiBase/apiKey → 用它，并刷新 chrome.storage.local 里的缓存
      └─ 失败或未配置 → 沿用缓存（receiver 没起来时翻译仍可用）
  → 应用覆盖项（stApiBaseOverride / stApiKeyOverride / stModelOverride，逐字段）
  → chrome.permissions.contains(生效 apiBase 的 origin)
      ├─ 已授权 → 发请求
      └─ 未授权 → 返回 NEED_GRANT，气泡与工具箱都提示去点「授权访问模型域名」
```

`chrome.permissions.request` 只能在用户手势里调用，所以授权入口有三个，都在工具箱的翻译页上：打开工具箱时自动检查、「框选截图」/「翻译选中文字」按钮点击时顺带申请、以及未授权时显示的「授权访问模型域名」按钮。快捷键路径没有面板可点，未授权时只报错并提示。

覆盖项改的是生效地址，所以授权按钮申请的也是新地址的 origin。

## 6.1 总开关与快捷键

翻译页顶部有一个启用开关（`chrome.storage.local` 的 `stEnabled`，缺省为启用）：

```
关掉开关
  → 两个快捷键仍会触发，但后台在 requireEnabled 处挡下并打「关」角标
  → 工具箱里的两个动作按钮置灰
  → 「测试连接」不受影响，关着也能验证配置
```

翻译页还显示两条快捷键的**实际绑定**（`chrome.commands.getAll()`），并提供「改快捷键」按钮打开 `chrome://extensions/shortcuts`。显示实际绑定而不是写死的默认值，是为了在改过键或与别的扩展冲突（此时绑定为空）时能直接看出来。

## 7. 文件结构（合并后）

独立扩展时期的文件已迁入 `extension/`，名字加 `translate-` 前缀：

```
extension/
├── manifest.json             权限、两个快捷键、web_accessible_resources（合并后）
├── service_worker.js         共读的 SW + 末尾两行装配翻译能力
├── translate-background.js   翻译的 SW 部分：命令与消息路由、截图、调用模型
├── translate-protocol.js     纯函数：prompt、请求体、回复解析、错误分类（可在 node 里单测）
├── translate-overlay.js      遮罩框选、裁剪、气泡（按需注入）
├── translate-overlay.css     Shadow DOM 内的样式
├── sidebar.html / sidebar.js 侧栏「⋯ → 🧰 工具箱」入口、tab 分页与翻译页（替代原来的 popup）
├── test/                     translate-protocol.js 的单测（node:test）
└── THIRD-PARTY.md            移植来源与 bssm-oss/img-to-translate 的 MIT 声明
```

原 popup 三件套被侧栏翻译面板取代，独立扩展时期的 `README.md` 内容并入仓库根 `README.md`，`LICENSE` 提到仓库根目录。

实现时的两处偏离本方案：

- **裁剪输出 PNG，不输出 JPEG q=0.9**。上游按图片尺寸换算 token（每张上限 1024），与体积无关，所以 PNG 不额外花钱；而 JPEG 在高对比度文字边缘会引入振铃，影响识别。
- **overlay 里加了会话世代守卫**（每次开始框选自增计数）。连续按两次 `Alt+S` 时，上一轮还在途中的截图与翻译回调会命中计数变化后直接丢弃，不会覆盖新一轮的选区。

## 8. 移植范围与必改项

移植（`bssm-oss/img-to-translate`，MIT）：

- `content.js` 的遮罩 `#ocr-translator-overlay` 与拖拽选框
- `cropImage()`：按 `img.width / window.innerWidth` 计算倍率后裁剪
- `createCommentBox()` / `updateCommentBox()` 的气泡结构与拖拽

必改：

1. **译文注入漏洞**。原文经 HTML 转义，译文直接进 `innerHTML`。全部改用 `textContent` 或等价转义。
2. 默认语言 `ocrLang: 'eng+kor'` / `targetLang: 'ko'` → 中文。
3. `chrome.storage.sync` → `chrome.storage.local`。
4. window 级热键监听（要求 content script 常驻）→ `chrome.commands` 按需注入。
5. 增加 Esc 与右键撤销。源项目只能靠松开修饰键退出。
6. 气泡拖拽挂的 `mousemove` / `mouseup` 监听在关闭时移除。源项目不移除。

## 9. 三条承载假设（已实测通过）

真 Chrome 实测：三条全部成立，回退分支未启用。保留分支记录，供日后 Chrome 版本变化时对照。

```
1. chrome.commands 快捷键授予 activeTab → 成立，Alt+S 直接可用
     └─ 若不成立 → 入口收敛为「点图标 → popup → 框选」（action 触发必定授予）

2. 独立扩展的 origin 通过 receiver 的 GET /api-config → 放行
   （receiver 的 isExtensionOnly 只校验 host 为回环 + origin 以 chrome-extension:// 开头）
     └─ 若 403 → 改为在 popup 里手动填写

3. chrome.permissions.request({ origins: [apiBase + '/*'] }) 在 popup 内成功 → 授权框正常弹出
```

## 10. 验收

1. 任意页面按 `Alt+S` 框选一段英文，气泡出原文与中文译文。
2. 改写气泡里的原文，点「重译」后译文更新（未改动时按钮置灰）。
3. 点复制，译文进入剪贴板。
4. 关掉 receiver 进程，工具仍能用缓存配置完成翻译。
5. 截图内容只发往配置的模型服务地址，不发往其他地址。

## 11. 划词翻译（v1.1 追加）

选中网页文字直接出译文，与截图模式共用气泡、共用请求层，不引入新权限。

```
Alt+T ／ popup 的「翻译选中文字」
  → executeScript(func: readSelectionInPage) 读选区文字与首行矩形
      ├─ 无选中 → 图标打感叹号角标，结束（不弹气泡）
      └─ 有选中 → 继续
  → 纯文本请求（SELECTION_PROMPT），不带图片，任何模型都支持
  → 注入 overlay.js（幂等）→ executeScript(func) 调 showText 渲染气泡
```

与截图模式的差异：

| | 截图翻译 | 划词翻译 |
|---|---|---|
| prompt | `IMAGE_PROMPT` | `SELECTION_PROMPT` |
| 请求体 | `image_url` + base64 | 纯文本 |
| 气泡内容 | 译文 + 原文（原文可编辑重译） | 只有译文 |
| 输入上限 | 选区最长边 1600px | 6000 字 |

实现要点：

- `readSelectionInPage` 作为 `func` 注入页面，必须自包含，不能引用 background.js 作用域里的任何标识符，参数只能通过 `args` 传。
- 输入框与文本域里的选中不属于文档选区（`window.getSelection()` 取不到），单独读 `selectionStart` / `selectionEnd`；`type="password"` 一律跳过。
- 选区矩形取 `getClientRects()` 里第一个非空矩形，只用来定位气泡；拿不到时退回视口左上角。
- 注入与动作拆成两步：先 `files: ['overlay.js']` 建 DOM（幂等），再用一次 `func` 调用指定动作。overlay.js 不再自动开始框选。

## 12. 待定项

按当前优先级排列，都未实现。

**1. 拍屏式框选（解决 PDF）**

Chrome 自带的 PDF 阅读器是内部组件页，扩展不能注入，划词与框选都失效。截图 API 能截到 PDF 页面，所以解法是把框选搬出页面：

```
点「PDF / 无法注入的页面」
  → chrome.tabs.captureVisibleTab 拍下当前可见区域
  → chrome.windows.create 弹一个扩展窗口，把这张图显示出来
  → 用户在图上拖框（复用现有气泡与请求层）
  → 结果在同一个窗口里出
```

不依赖注入，顺带覆盖 `chrome://` 页面、扩展商店页、禁止注入的站点。代价是多一个窗口、一次只能框当前一屏。`file:///…` 的 PDF 还需要用户先打开「允许访问文件网址」，`activeTab` 才会覆盖本机文件。

**2. 粘贴图片 / 粘贴文字**

侧栏翻译面板加 `paste` 监听：粘贴图片走同一套裁剪与请求；粘贴文字走纯文本请求。覆盖浏览器外的内容（PDF 阅读器、其他程序截图、系统截图工具）。不需要新权限。

**3. 目标语言切换**：现在写死简体中文，改成一个下拉加 prompt 里换词。

**4. 术语表**：读同一位作者的文献时保持术语一致，需要存储与 prompt 注入。

**5. 长文批量翻译**：一次框一大片或粘贴长文本，按段落分批、批次间传上下文。

**6. 历史记录**：翻过的结果可回看。

## 13. 多气泡、重排跟随与译文记录（2026-10 追加）

解决的问题：翻译完一处，去看别的地方再回来，得重新翻一遍。

### 13.1 多气泡并存

一页可以同时存在多个译文气泡，各自锚在自己的原文位置，新翻译不再顶掉旧的。

- **锚点存屏幕坐标 + 记一条「滚动容器链」**，靠链上滚动量的变化来移动气泡与高亮。

  为什么不能用页面坐标（视口 + `window.scrollY`）：微读这类阅读页的正文是在**内层容器**里滚的，文档滚动量恒为 0，按 window 算出来的补偿永远是 0，气泡与高亮就会钉在屏幕上、内容一滚就跑偏。做法是在锚点位置用 `elementsFromPoint`（跳过自己的宿主元素）命中一个页面元素，往上收集所有可滚动祖先，连文档一起记下当前滚动量；之后 `transform: translate(-Δx, -Δy)` 用这些容器的滚动增量之和。

  这条链**只在创建时记一次**：它代表"这段内容被谁滚"，之后气泡无论被拖到哪、折叠还是展开，都跟着同一块内容走。代价是记录里的 `pageX/pageY`（贴回用）仍是"视口 + 文档滚动量"的近似，在内层滚过的阅读页上贴回位置会不准——已知限制。
- **可折叠**成一个小绿标贴在原文左上角，点 `▸` 展开。翻十段的页面不会糊满气泡，但每段都还找得回来。
- **标题用译文开头那截**（前 14 字 + `…`），不再写死「截图翻译」：一页开好几个气泡时，只有这样才能一眼对上是哪一段；折叠成小标记后更是只剩标题，写死的话根本分不清。
- 可拖拽（拖到哪锚点就改到哪，整卡都能抓，只排除按钮/文本框/译文文本选区/尺寸把手）、可单独关闭；`Esc` 关最近打开的那个（框选进行中时 `Esc` 归框选）。
- **右下角把手可手动调整尺寸**（最小 240×120）。调过的尺寸会被记住，后面的新气泡沿用；折叠态自动摘掉这个尺寸（否则小标记会变成一条长条）。
- **📌 固定**：钉在当前屏幕位置，不随页面滚动，点别处也不会自动收起。取消固定时把当前屏幕位置换算回页面锚点，重新贴住原文。固定后**鼠标一离开就收成「只显示译文」的小卡**（隐藏标题栏、原文块与按钮，宽度 250px），移回来恢复完整形态。折叠态不显示 📌（小标记就那么点大）。
- **点气泡以外的地方自动收成小标记**，让开正文；点在某个气泡里只收别的（点哪个留哪个）。固定的气泡不收。
- 鼠标不在卡上时半透明（0.85），移上去恢复不透明，压着的正文仍看得见。
- 框选期间高亮与气泡一起 `pointer-events: none`：否则在已经翻译过的区域上按下时，事件被高亮吃掉，遮罩收不到 mousedown，新的框选起不来。
- 同页上限 10 个，超出时关掉最早的那个。

踩过的坑（都跟"点内/点外"的记账有关）：闭合影子根会把事件 target 重定向成宿主元素，所以 document 上看不到内部节点，只能靠气泡自己的 mousedown 记下"这一下点在哪个气泡里"。**任何在 mousedown 里 `stopPropagation()` 的控件都必须自己补上这条记账**——尺寸把手最初就是漏了这一步，被当成"点在外面"，气泡先被收成小标记，尺寸因此永远应用不上。

排查"改了代码但行为没变"：每次翻译都会往记录里写 `overlayV`（overlay 的版本号）。看最新一条记录的 `overlayV` 就知道页面里跑的是哪一版——它比默认值小，说明扩展没刷新或页面没刷新（已注入的旧实例会一直活着，`window.__coreadStOverlay` 守卫会让新注入的脚本直接返回）。

### 13.2 重排后重新定位（DOM Range 锚点）

打开侧栏、拉伸窗口、旋转屏幕都会让正文重排，像素锚点随之失效。解法是给气泡一个 **DOM Range 锚点**：浏览器重排后 `range.getClientRects()` 会直接给出新位置，高亮条数与位置都能跟着变。

- **划词**：Range 是现成的（选区就是），创建时核对文字一致就 `cloneRange()` 存下来，零匹配成本，精确。
- **截图**：没有现成 Range，拿模型誊写的 `original` 去页面文字里找一份。**搜索范围含同源 iframe**（最多两层）并穿透 shadow root——微读的正文就在 iframe 里，`content.js` 是靠 `all_frames` 才跑进去的，只搜顶层文档会一无所获（实测 `anchored:false` 就是这个原因）；跨源 iframe 读不到 `contentDocument`，跳过。

```
对每个能搜的文档：
  → TreeWalker 把正文压成"去空白字符串 + 每字符到 (文本节点, 原始偏移) 的映射"
     遍历时**穿透 shadow root**（WeRead 的正文可能渲染在 shadow root 里，
     content.js 就是因为这个才要穿透收集文本节点）
  → 先按整段找；模型誊写有出入时退一步用前 12 字找起点
  → 同一段文字可能重复：所有出现位置都比一遍，挑离框选位置最近的那个
  → 矩形换算到顶层视口坐标后比较远近（iframe 里的要加 iframe 链的偏移与边框）
  → **校验命中位置必须落在当初框选的区域里**（容差 40px）
```

**不要用 `body.textContent` 做"这段文字在不在这里"的预检**——`textContent` 看不到 shadow root 里的内容，会把"有"错判成"没有"并直接放弃。这个坑踩过：`anchored=false / reason=notfound` 排查到最后一层就是这个预检在作祟，连诊断函数都被它蒙住了。画布书本来就没有文字节点，那个预检省的这点开销不值得冒误判的风险，所以直接去掉。

那道校验是必须的，而不是保险起见。正文在**跨源 iframe 或 canvas** 里时搜不到，12 字探针会匹配到页头、目录之类的地方；锚错了比不锚更糟——气泡跳到错误位置，**而且滚动链也会在错误的地方采集，于是连滚动跟随都一起坏掉**。这个坑真踩过：第一版没有校验，症状就是"横坐标不对 + 滚动不跟了"。用"是否落在框内"而不是"距离多少像素"，是因为框选区域通常比文字本身大一圈。

- 找到 Range 时**立刻**按它的位置重新锚定（比像素锚点准），并在 `resize`（防抖 160ms）时用 `rangeRectsToTop` 重新测量（iframe 每帧重取偏移，因为它自己也会被滚动/重排）。
- 找不到 Range 时：**先重排后重新搜一次**（`refindAnchor`）——阅读器重排时可能把正文节点整个换掉，手里那个 Range 就失效了（`getClientRects` 返回空），而搜索是穿透 shadow root 的，重挂后的内容照样能找到。这一步是微信读书与普通网页的关键差别：普通网页的 Range 一直有效，微读的会被换掉。
- 连文字也找不回来时：**就地重记滚动基准**（`rebaseChain`），位置不动。为什么不能放着不管——页面变宽后正文变矮、文档总高度变小，浏览器会**钳制滚动位置**（比如从 16304 掉到 12000），而高亮还锚在旧的页面位置，于是被留在视口下方几千像素处，表现就是"宽度一变，截图框不见了"。重记基准后从 0 开始重新跟随，位置保持可见。

  这条也是"普通网页正常、微读不正常"的原因：普通网页文档短，宽度变化不会引起滚动钳制。
- 每次翻译都会把 `anchored`、`anchorReason` 与 `frames` 写进记录：`range` = 拿到了锚点；`notfound` = 文字没搜到；`rejected` = 搜到了但位置对不上。`frames` 是每个 frame 的 `{url, has, len, shadows}`，用来判断正文是不是在 iframe 或 shadow root 里（`shadows` 是被穿透的 shadow root 数），还是根本由 canvas 渲染。

**诊断不依赖 receiver**：同一份诊断同时写进 `chrome.storage.local`（键 `stLastDiag`），工具箱翻译页底部显示一行（鼠标悬停看完整 JSON）。原因是 receiver 是个**常驻 Node 进程**，改它的代码必须重启才生效——而"重启才能看到诊断"这种事只会拖慢排查。翻译与高亮本身也从不经过 receiver（模型请求由 service worker 直接发出；receiver 只负责读配置、存译文记录、设引用三件事）。

**滚动链持有的是元素引用，必须防"容器被换掉"**：页面重排时阅读器可能把滚动容器整个替换，新容器的 `scrollTop` 是 0、基准是旧容器的值，一减就是几千像素的假位移，会把气泡与高亮整体甩到屏幕外——表现就是"宽度一变，标记直接消失"。所以 `scrollDeltaOf` 跳过 `!isConnected` 的容器，`framesOffsetNow` 遇到失联的 iframe 直接放弃换算（宁可不动，也不要跳到错误位置）。

**链上的容器集合只在创建时定一次，之后只重记基准（`rebaseChainTo`），绝不重新采点。** 一度写成"每次重排都重新采点"，结果采点落空时（高亮正好盖住那个位置、锚点已被挪到视口外）会采成"只有文档"的退化链，内层滚动容器永久丢失——表现是"滚不动了、不跟随了"。只有当链上容器**全部**失联（页面把它们换掉了）时才回退到重新采一次。

**重排后 Range 失效时重新搜文字（`refindAnchor`）**：阅读器重排会把正文节点整体换掉，手里那个 Range 就失效了（`getClientRects` 返回空），而搜索是穿透 shadow root 的，重挂后的内容照样能找到。这一步是微读与普通网页的关键差别——普通网页的 Range 一直有效。

**连文字也找不回来时就地冻结（`freezeInPlace`）**：把当前屏幕位置固化成新的零点，位置不动，并给高亮加上**虚线 + 降透明度**的"可能不准"标记。因为页面变宽后正文变矮、文档总高度变小，浏览器会**钳制滚动位置**（例如从 16304 掉到 12000），而高亮还锚在旧的页面位置，于是被留在视口下方几千像素处——表现就是"宽度一变，截图框不见了"。普通网页文档短，不会触发这个钳制，所以只有微读出问题。重新锚定成功后这个标记会撤掉。

### 硬边界：画布书（正文画在 canvas 上）

实测结论（2026-10）：某本书在微读里是**画布书**——整章正文画在一张 `1918×7981` 的 canvas 上，顶层 frame 有 2.6 万字但全是界面文字，`shadows=0`，唯一的 iframe 是 0×0 的模板页。诊断字段：`canvas={"n":2,"maxW":1918,"maxH":7981}`。

**页面里没有任何文字节点 ⇒ 拿不到 Range ⇒ 宽度变化后无法用浏览器重排找回位置。** 这是方法本身的边界，不是实现缺陷。

能做的退让：把高亮位置记成**相对 canvas 的比例**（`captureCanvasAnchor`），重排后用 `reanchorToCanvas` 按 canvas 的新矩形映射回去。**但只在 canvas 是"纯缩放"时采用**（那时映射精确）：

```
canvas 固有尺寸没变（只是被 CSS 缩放）→ 用比例映射，精确
canvas 固有尺寸变了（内容在画布里重新折行）→ 不采用映射，就地冻结 + 虚线
```

重绘的情况下比例映射只是猜测，而且可能把高亮推到很远；"停在原地"反而更接近——用户正看着那段文字，它就在附近。实测这本微读书的 canvas 固有尺寸会随宽度从 1918 变 1518，属于重绘，所以走的是冻结分支。

**探测 canvas 有两个坑**（都踩过）：不能用 `elementsFromPoint`（它跳过 `pointer-events: none` 的元素，而画布书的 canvas 常常正是这种）；也不能只判断"选区某个角点是否在 canvas 内"（框选通常带外边距，角点可能刚好落在画布外）。正确做法是算**相交面积**、取重叠最大的那张。

比例**只在创建时记一次**，之后不重算：canvas 重绘后映射本就是近似，每次重排都从"已经近似的位置"再推一次会累积漂移。

诊断里的 `canvasAnchor`（拿到比例锚点没有）与 `canvasChanged`（canvas 是否被重绘过）用来判断这条退路走到了哪一步。

#### 兜底：按需让模型重新定位（v19）

到此为止四层本地手段（Range → 画布比例 → 重搜文字 → 就地冻结）在画布书上全部失效，只剩"看着渲染结果找"这一条路。做成**按需触发**，不自动跑：

```
布局变化 → 高亮冻结在原地并变虚线（现状）
        → 气泡上出现「重新定位」按钮（只在虚线状态下出现）
        → 用户点了才截当前屏幕，问模型这段文字在哪，返回比例坐标 → 高亮贴回去
```

为什么按需：一次调用 = 一次模型开销，而重排（拉窗口、开侧栏）很频繁；自动跑既费钱又会在用户没在看的时候把高亮挪走。

取景必须干净：截图前把 `.st-layer`（高亮 + 气泡都在里面）整体 `visibility: hidden`，等两帧再截。否则画面里就有那个位置不准的虚线框，模型十有八九把看到的框直接抄回来，白跑一次。藏起来期间用 `.st-layer` 之外的一个左下角小角标报进度（它会留在截图里，prompt 里已说明忽略它）——否则用户会盯着一个空页面十几秒，以为扩展坏了。

坐标是模型给的比例值，属于**近似**：拿到后按它重贴高亮，并**重记一次画布比例**（位置已被验证过，此后滚动跟随用新基准）。之后 `anchorReason` 记为 `relocated`，虚线撤掉。

发给模型的"要找的文字"取**开头 80 字的短片段**（`relocateSnippet`：折叠空白、词边界截断），不是整段原文。整段（几百字还带换行）让模型在画面里精确匹配太难，实测报"看不到"。

**"看不到"和"格式错"必须分开**（`parseRelocateReply` 返回 `reason`：`ok` / `notvisible` / `badformat`），因为补救办法不同：

```
notvisible（模型输出全 0）→ 窗口变窄后正文本就被挤出了可视区域，模型是对的
                          → 提示"先滚动到能看见它，再点一次"
badformat               → 模型没按约定输出 → 把模型原话回显出来，用来判断是 prompt 还是模型的问题
```

失败时把 `detail`（模型的原话，截断 120 字）**显示在气泡里**，并打到控制台。用户看不懂 F12，排查信息要能直接在界面上读到。

**诊断里的 `chain` 字段**是滚动链中内层容器的个数（不含文档自身）。它掉到 0 就意味着跟随退化成"只跟窗口滚动"——排查"滚不动了"先看这个数。

已知边界：**划词翻译只在顶层 frame 生效**——选区属于它所在文档，`window.getSelection()` 拿不到 iframe 里的选区。iframe 里的正文目前只能用截图翻译。

这条改动让"打开侧栏 → 页面变窄 → 高亮跑偏"这个最常见的场景不再出问题。

### 13.3 原文高亮

被翻译过的地方在原文上留一条淡绿色高亮，**长驻到气泡被关闭为止**（气泡收起时高亮留着，点高亮可以展开/收起对应译文）。

- 截图翻译：高亮就是框选的那块矩形
- 划词翻译：渲染时核对当前选区文字与送出去的是否一致，一致就用 `getRangeAt(0).getClientRects()` 的**全部矩形逐行画**（跨行就是多条），不一致就退回 SW 传来的那一个矩形，绝不标错地方
- 用覆盖层画，**不改页面 DOM**，因此不存在 `surroundContents` 那类破坏排版的风险
- 高亮不走 CSS Custom Highlight API：`::highlight()` 画出来的东西不能点，而这里需要"点高亮看译文"
- 记录里同时存 `pageW/pageH`，所以「贴回页面」能把高亮一起贴回来（旧记录没有这两个字段时只贴气泡，不画高亮）

### 13.4 译文记录（存 receiver）

每次翻译成功落一条记录，用于跨刷新、跨页找回。

```
receiver/toolbox/history.jsonl     一行一条：{ id, at, url, pageTitle, kind, original, translation, pageX, pageY }
```

| 端点 | 方法 | 说明 |
|---|---|---|
| `/tool-record` | POST | 落一条。缺 url 或 translation 返回 400 |
| `/tool-records?url=..&limit=..` | GET | 按页面地址读，新的在前，返回 `{ records, total }` |
| `/tool-records-clear` | POST | 清除某页的记录 |

记录是**旁路**：不写 `inbox/`、不触发 agent、不参与会意图。失败也不影响阅读（receiver 没起来时只是本条不记录）。

工具箱翻译页两个入口：**「贴回页面（N）」**（按记录的页面坐标把气泡还原回原位，贴回的气泡不再写回记录，否则每贴一次多一条）与**「清除」**（清记录，并顺手关掉页面上还开着的气泡）。

### 13.5 设为引用

气泡上的「设为引用」把这段原文设成侧栏的**当前引用**，**不直接发出提问**——用户在侧栏输入框里自己问，走正常的共读链路。

```
气泡「设为引用」
  → service worker（内容脚本不能跨域 POST，receiver 只认扩展与几个阅读源）
  → 解析当前页属于哪本书
      ├─ 微读：从 URL 路径 /web/reader/<bookId> 取
      ├─ 文库页（marxists / bilibili）：chrome.tabs.sendMessage(coreadBindingQuery) 问页面
      │   （source-mia.js 维护 miaBindings，本来就有这个接口）
      └─ 都不是 → 报 NO_BOOK，提示需要微读阅读页或已「加入一本书」的文库页
  → 拿不到书名时补一次 GET /books 按 base 找书名
  → POST /annotation（selectedText = 原文，setRef: true）
  → receiver 落 annotations.jsonl，并推 annotation-select 给侧栏
  → 侧栏把它加进引用列表并选中为当前引用（不触发 agent）
```

选 `/annotation` 而不是 `/chat` 的理由：划线共读的「设为当前引用」走的正是这条（receiver 里 `setRef` 分支只推 `annotation-select`，不触发讨论），复用它能保证行为与既有的划线共读完全一致，也不用给 receiver 加任何新逻辑。副作用是这条会真的落进 `annotations.jsonl`，成为该书的一条引用——与 CoRead"标注即引用"的模型一致；微读页面上的共读段落标记也可能会按这段文字去标原文。

### 13.6 与共读的关系

两条链路完全独立：翻译的模型请求由扩展 service worker 直接发出，不经过 receiver 也不经过 agent；共读仍然是 agent 单进程串行处理 `chat_input.jsonl`。唯一共享的是同一个 API Key 的并发额度——需要彻底隔离时，用翻译页的「自定义模型配置」给翻译单独配一家。

## 14. 合并进 CoRead 主扩展（已完成）

原本是一个独立扩展 `screenshot-translate/`，现在并入 `extension/`，同一个扩展、同一个图标、同一次安装。

| 项 | 独立扩展时期 | 合并后 |
|---|---|---|
| 扩展数 | 两个 | 一个 |
| 工具入口 | 点扩展图标开 popup | 侧栏「⋯ → 🧰 工具箱 → 翻译」；工具箱按 tab 分页，以后的小工具都放这里 |
| 模型配置 | 自己存一份（可手动填） | 默认用 `agent/api-config.json`，工具箱里可选按字段覆盖 |
| 域名授权 | popup 上「保存并授权」 | 工具箱的授权按钮 + 两个动作按钮点击时顺带申请 |
| 启用开关 | 无 | 工具箱翻译页顶部一个开关，关掉后快捷键与按钮都停用 |
| 气泡数量 | 一页一个，新翻译顶掉旧的 | 一页多个并存，各自锚定原文位置，可折叠成小标记 |
| 译文留存 | 关掉/刷新即丢 | 落 `receiver/toolbox/history.jsonl`，可按页贴回 |
| 后端代码 | 自己的 service worker | `service_worker.js` 末尾调 `installTranslateBackground()` 装配 |
| 权限 | activeTab / scripting / storage / 可选域名 | 并入 CoRead 的权限清单，另外新增 `activeTab` 与 `scripting` |
| UI 归属 | 独立 popup | 侧栏工具箱的第一个 tab；工具箱按 tab 分页，加工具只需加一个按钮 + 一个 `.tb-page`，切换逻辑通用 |

合并时保持不变的：气泡、遮罩、裁剪、prompt、错误分类、请求规格。共读逻辑一行未改，`service_worker.js` 只加了导入与一行装配调用（翻译的消息监听是独立的第二个监听器，只接管自己的 action）。

两条快捷键（`translate-region` = `Alt+S`、`translate-selection` = `Alt+T`）注册在同一个扩展上，`chrome.commands` 上限是 4 条，当前用了 2 条。
