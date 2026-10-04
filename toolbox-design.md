# CoRead 工具箱与翻译工具（toolbox）：产品设计方案

> 状态：**已被 `screenshot-translate-design.md` 取代**，本文件保留作历史方案。
> 取代原因：翻译改为在线多模态模型直读图片，本地 OCR 与旁路工具通道不再需要；工具与共读解耦为独立扩展。
> 原定位：**通用翻译工具**——不绑书、不绑站点，快捷键召唤；共读是它的下游之一。

## 1. 产品概述

一句话定位：**在任何页面上，按一下键，把选中的文字或框选的屏幕区域变成中文**（目标语言可切）。

三条入口：

| 入口 | 触发 | 输入 | 输出位置 |
|---|---|---|---|
| 快捷键 `Alt+T` | 选中文字后按键 | 当前选区 | 页面内浮标 |
| 快捷键 `Alt+S` | 按键后拖拽框选 | 框选区域的截图 | 页面内浮标 |
| 侧栏 `🧰` 面板 | 点 header 图标 | 粘贴文本 / `Ctrl+V` 粘图 / 读取选中引用 | 侧栏面板 |

三类输入：选中文字、框选截图、粘贴图片（从浏览器外的任何程序截图后粘入）。

工具箱的状态与共读系统正交：工具箱不依赖当前是否在读书，不依赖当前页是否属于某本书，也不需要先建书。

## 2. 现状与约束

可复用的部分：

- `receiver/index.js` 是唯一服务端（`127.0.0.1:7239`），已在 `manifest.json` 的 `host_permissions` 内，扩展页可直接 POST。
- `receiver/index.js` 已 import `agent/lib/api-config.js`，跨层共用库有先例。
- `extension/sidebar.html` 已有浮层壳（`#graph-overlay` / `#book-picker` / `#api-config`）与 header 图标位（`#graph-btn` `#more-btn`）。
- `extension/sidebar.js` 已有 `RECEIVER` 常量、SSE 订阅、`toast` 反馈、`effectiveBookBase()` 当前书判定、`FREE_KEY = '__coread_free_mode__'` 自由模式。
- `extension/service_worker.js` 已有消息路由与 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`：点扩展图标打开侧栏，`popup.html` 无实际入口，工具箱主面板放侧栏。

约束：

1. **receiver 的 POST 来源白名单**（`receiver/index.js:558`）只放行 weread / marxists / bilibili / 扩展页。工具箱在任意网站使用，页面脚本直接 POST 会 403。
2. **`activeTab` 由快捷键授予**。用户手势（工具栏图标、右键菜单、`chrome.commands` 快捷键、omnibox）触发时授予本站访问权。侧栏面板内的按钮点击不在此列。
3. **`chrome.tabs.captureVisibleTab` 只能截当前标签页的可见区域**。浏览器外的窗口、PDF 阅读器、其他程序截不到。
4. **`captureVisibleTab` 有频率上限**（`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2`）。
5. **扩展单页 API 调用会串行排队**：`agent/index.js` 单进程轮询，共读讨论与工具请求共用它会互相阻塞。

## 3. 设计决策

### 3.1 翻译走旁路，不进共读链路

`/chat` 每条消息会触发：引用解析 → `topic_stack` 专题化入栈 → 实时收口固化 → `knowledge-graph` 建边 → `session_journal` 落盘 → `MEMORIZE` 记忆合并 → `profile.md` / `soul.md` 重写。

翻译请求不走 `/chat`，只走独立端点。三条硬规矩：

- 翻译不建边。
- 翻译不入 `topic_stack`。
- 翻译不触发 `MEMORIZE`。

只有用户点「带去讨论」才进 `/chat`。

### 3.2 请求由扩展页发出

页面脚本（`toolbox-overlay.js`）只做两件事：读选区、画遮罩。真正的 HTTP 请求由 service worker 或侧栏发出。

收益：receiver 的来源白名单零改动；任意网页无法诱导调用本机的模型 API Key。

### 3.3 截图翻译用多模态模型

裁剪后的图片直接作为 `image_url` + `data:` URL 送上游，由模型一次输出「原文 + 译文」。不引入本地 OCR 依赖。

上游模型需支持图片输入。`agent/lib/api-config.js` 新增可选字段 `toolModel`，留空时回退主模型。

### 3.4 缓存不绑书

缓存键只由内容与参数决定，不绑定书籍。同一段文字在任何页面翻译一次，之后命中本地缓存。

`bookId` 可选，只用于命中书级术语表与历史标记。

## 4. 交互设计

### 4.1 快捷键

```
Alt+T + 有选区（顶层 frame）
  → 读选区文字与选区 rect
      ├─ 选区长度 > 1500 字符 → 按段落切批，串行请求，逐批渲染
      └─ 选区长度 ≤ 1500 字符 → 单次请求
  → 在选区下方 8px 渲染结果浮标

Alt+T + 无选区
  → toast「未检测到选中文字：选中后重试，或在侧栏工具箱里 Ctrl+V 粘贴」

Alt+S
  → 进入框选遮罩 → 截图 → 裁剪 → 请求 → 在框选区域下方渲染结果浮标

Esc
  → 关闭浮标 / 退出框选遮罩
```

浮标内容与操作：

- 状态区：请求中显示加载占位块；完成后显示「原文（可折叠）→ 译文」。
- 按钮：复制译文 / 带去讨论 / 打开侧栏工具箱 / 关闭。
- 尺寸：宽 360–520px，正文最高 320px 后内部滚动。
- 位置：超出视口时自动上移或左移，不遮挡选区。

浮标不做「选中即自动弹出」。选中文字触发 UI 会干扰正常的复制与搜索，与快捷键召唤式的权限姿态一致。

### 4.2 侧栏工具箱面板

```
header #toolbox-btn（🧰，位于 #graph-btn 与 #more-btn 之间）
  → #toolbox-overlay（复用 #graph-overlay 的浮层壳）
      ├─ 输入区：文本域（支持 Ctrl+V 粘贴图片）+ 目标语言切换 + 「译」
      ├─ 结果区：原文 / 译文对照，可复制
      ├─ 历史区：最近 50 条，点击回填
      └─ 设置区：工具模型（视觉模型）输入框 + 清空缓存 + 快捷键说明
```

面板内的 `Ctrl+V` 走 `paste` 事件的 `clipboardData`，不申请 `clipboardRead` 权限。

面板内不提供「截图」按钮。`activeTab` 由快捷键授予，面板点击不授予本站访问权（约束 2）。面板设置区显示一行说明：「截图翻译：在页面上按 Alt+S」。

### 4.3 与共读的接口

```
结果卡片「带去讨论」
  → 有当前书（effectiveBookBase() 非空）
      → POST /chat，bookId = 当前书
  → 无当前书
      → POST /chat，bookId = '__coread_free_mode__'
      → toast「已送入自由模式」

content 组装：
  [引用]《书名》
  > 原文

  > 译文

  （用户在面板输入区写的追问，可空）
```

自由模式是多对话沙盒（2026-11）：未绑定书的讨论进**当前那场自由对话**（其 key 即 bookId；无当前对话时用默认对话 `__coread_free_mode__`），对话内容默认不固化进正式图、不进长期记忆——要在归档时勾选「保存记忆 / 收编进拓扑图」才会留下产物（agent/topic-library-design.md §8）。

## 5. 数据流

```
快捷键 / 面板
  → extension/toolbox-overlay.js（读选区 rect+text，或画遮罩取 rect）
  → chrome.runtime.sendMessage → service_worker.js
      ├─ Alt+S → chrome.tabs.captureVisibleTab → OffscreenCanvas 裁剪与缩放
      └─ 组装请求体
  → POST http://127.0.0.1:7239/tool/translate（SW 或侧栏发出）
  → receiver
      ├─ 命中缓存 → 直接返回
      └─ 未命中 → agent/lib/llm-call.js → 上游模型 → 写缓存 → 返回
  → 响应回 SW → chrome.scripting.executeScript 渲染浮标 / 面板渲染
```

截图链路：

```
Alt+S（快捷键授予 activeTab）
  → executeScript 注入防腐遮罩
      ├─ Esc 或右键 → 移除遮罩，结束
      └─ 拖出矩形松开 → 回报 { x, y, w, h }（CSS px）+ 视口宽高
  → chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 })
      └─ 失败（每秒上限 2 次）→ toast「截图过于频繁，稍后重试」
  → OffscreenCanvas 裁剪
      ├─ 倍率 = bitmap.width / 视口宽（兼容页面缩放，不用 devicePixelRatio）
      ├─ 最长边 > 1600px → 等比缩放
      └─ 输出 image/jpeg q=0.85
  → POST /tool/translate（kind=image）
  → 渲染浮标
```

## 6. 接口契约

### 6.1 POST /tool/translate

请求：

```json
{
  "kind": "text",
  "text": "…",
  "imageBase64": "…",
  "mimeType": "image/jpeg",
  "target": "zh",
  "mode": "bilingual",
  "context": "…",
  "bookId": "…",
  "source": { "url": "…", "title": "…" }
}
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `kind` | 是 | `text` \| `image` |
| `text` | `kind=text` 必填 | 1–1500 字符。客户端负责按段落切批 |
| `imageBase64` | `kind=image` 必填 | 不含 `data:` 前缀，base64 长度 ≤ 4MB |
| `mimeType` | `kind=image` 必填 | `image/jpeg` \| `image/png` |
| `target` | 否 | `zh` \| `en`，默认 `zh` |
| `mode` | 否 | `bilingual` \| `plain` \| `explain`，默认 `bilingual` |
| `context` | 否 | ≤ 500 字符。长文分批时传上一批译文的尾部 |
| `bookId` | 否 | 命中书级术语表；写入历史 |
| `source` | 否 | 只用于历史展示，不进 prompt |

响应 200：

```json
{
  "ok": true,
  "id": "t_1759…",
  "cacheKey": "…",
  "cached": false,
  "kind": "text",
  "original": "…",
  "translation": "…",
  "terms": [{ "src": "…", "dst": "…" }],
  "model": "gpt-4o",
  "usage": { "promptTokens": 0, "completionTokens": 0 },
  "elapsedMs": 4120
}
```

响应非 200：

```json
{ "ok": false, "error": { "code": "MODEL_NO_VISION", "message": "…" } }
```

### 6.2 其他端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/tool/history?limit=50&bookId=…` | GET | 历史列表，倒序 |
| `/tool/cache/stats` | GET | `{ count, bytes }` |
| `/tool/cache/clear` | POST | `{ ok: true, removed: n }` |

GET 与 POST 的来源校验沿用 `originAllowed` / `isExtensionOnly`。

### 6.3 缓存键

```
cacheKey = sha1(
  kind + "\0" +
  (kind === 'text' ? text : sha1(imageBytes)) + "\0" +
  target + "\0" + mode + "\0" +
  model + "\0" + TOOL_PROMPT_VERSION + "\0" + glossaryVersion
)
```

`TOOL_PROMPT_VERSION` 是常量，prompt 改动时手动加一。`glossaryVersion` 从术语表文件内容算。

### 6.4 错误码

| code | 触发 | 客户端文案 |
|---|---|---|
| `NOT_CONFIGURED` | `resolveApiConfig()` 缺少 apiBase 或 apiKey | 本地没有配置模型 API，请在侧栏「⋯ → 模型 API 配置」里填写 |
| `BAD_REQUEST` | 字段缺失或超限 | 输入不合法：{字段} |
| `TOO_LARGE` | 文本 > 1500 字符，或图片 base64 > 4MB | 内容过大，请缩小范围后重试 |
| `MODEL_NO_VISION` | `kind=image` 且上游 4xx 提示不支持图片 | 当前模型不支持图片输入，请在工具箱设置里把「工具模型」改为支持视觉的模型 |
| `UPSTREAM_ERROR` | 上游 5xx 或网络错误 | 模型服务返回错误：{简要信息} |
| `TIMEOUT` | 上游 45s 未返回 | 模型响应超时，请重试 |
| `PARSE_ERROR` | 输出不符合约定 JSON 格式，重试 1 次后仍失败 | 翻译结果解析失败，请重试 |
| `RECEIVER_DOWN` | 客户端 fetch 失败 | 本地接收端未启动（`node receiver/index.js`） |

### 6.5 配置字段

```
agent/lib/api-config.js
  CONFIG_KEYS     += 'toolModel'
  validateApiConfigInput：toolModel 可空，非空时长度 ≤ 200
  writeApiConfig  ：写回 toolModel 字段，空串照写
  resolveApiConfig：返回 toolModel；toolModel 为空 → 回退 model
GET /api-config 的响应体加 toolModel
```

空串语义遵循现有规则：文件里出现该字段就以文件为准。`toolModel` 为空表示使用主模型。

## 7. 存储

```
receiver/toolbox/
├── cache/{cacheKey}.json     翻译结果
├── blobs/{cacheKey}.jpg      kind=image 的输入图片
├── items.jsonl               历史，一行一次调用
└── glossary.json             全局术语表（v2）
```

`items.jsonl` 行结构：

```json
{
  "id": "t_…", "at": 1759000000000, "kind": "text", "target": "zh", "mode": "bilingual",
  "bookId": "", "sourceUrl": "", "sourceTitle": "",
  "inputPreview": "≤120 字", "outputPreview": "≤200 字",
  "cacheKey": "…", "cached": false, "model": "gpt-4o", "elapsedMs": 4120
}
```

上限与清理：

- `cache/` 最多 2000 条，超出时按 `items.jsonl` 里最久未使用的顺序删除，`blobs/` 同步删除。
- 面板提供「清空缓存」按钮（`POST /tool/cache/clear`）。

隔离断言：`/tool/*` 的全部写入落在 `receiver/toolbox/` 内。测试用内容快照比对 `inbox/chat_input.jsonl`、`agent/topic_stack.json`、`agent/data/knowledge-graph.json`、`agent/session_journal.jsonl` 在调用前后不变。

## 8. 翻译质量规格

### 8.1 分段与分批

- 客户端按段落边界切分，每批 ≤ 1500 字符且 ≤ 12 段。不按字符硬切。
- 每批把上一批译文的尾部 200 字符作为 `context` 传入，保证批次衔接。
- 批次串行执行，逐批渲染。每批独立缓存。

### 8.2 输出协议

上游必须返回严格 JSON：

```json
{ "original": "…", "translation": "…", "terms": [{ "src": "…", "dst": "…" }] }
```

`kind=image` 时 `original` 由模型 OCR 得到。JSON 解析失败重试 1 次，仍失败返回 `PARSE_ERROR`。

### 8.3 Prompt 组装

```
system（固定）          任务声明 + 输出协议 + 模式（bilingual / plain / explain）
user（可变，稳定材料在前）
  ├─ 术语约束：全局术语表命中项 + 书级术语表命中项，格式 "- src → dst"
  ├─ context：上一批译文尾部
  └─ 待译内容：text，或 image_url + data:URL
```

参数：`temperature = 0.2`，`max_tokens = min(4096, ceil(输入字符数 × 2))`，上游超时 45s。

### 8.4 术语一致性

v1 不提供术语表编辑界面，仅预留注入路径与 `glossaryVersion`。模型每次返回的 `terms` 累积写入 `receiver/toolbox/glossary.json`（同 `src` 保留首次译法）。

## 9. 权限与 manifest 变更

```json
"permissions": ["storage", "sidePanel", "tabs", "unlimitedStorage", "activeTab", "scripting"],
"commands": {
  "toolbox-translate-selection": {
    "suggested_key": { "default": "Alt+T" },
    "description": "翻译选中文字"
  },
  "toolbox-translate-screenshot": {
    "suggested_key": { "default": "Alt+S" },
    "description": "截图翻译"
  }
}
```

- 不新增 `host_permissions`。
- 不声明 `<all_urls>`。
- 不申请 `clipboardRead`（粘贴走 `paste` 事件）。
- `host_permissions` 已含 `http://127.0.0.1:7239/*`，service worker 可 POST。

## 10. 隐私

- 请求只发送当前选区、当前框选截图或粘贴的图片，不发送整页内容或书库。
- 图片与译文缓存在本地 `receiver/toolbox/`，不上传任何服务器（用户配置的模型 API 除外）。
- 截图内容会发往用户配置的模型 API。README「隐私」段补充这一条。

## 11. 实现落点

| 文件 | 改动 |
|---|---|
| `extension/manifest.json` | 加 `activeTab` `scripting` 权限与两个 `commands` |
| `extension/service_worker.js` | `chrome.commands.onCommand` 分支、截图裁剪、转调 receiver、消息路由 |
| `extension/toolbox-overlay.js`（新） | 页面内浮标 + 截图遮罩。注入幂等（`window.__coreadToolbox` 守卫） |
| `extension/sidebar.html` | `#toolbox-btn`、`#toolbox-overlay`、api-config 弹窗加 `toolModel` 输入框 |
| `extension/sidebar.js` | 工具箱面板逻辑、Ctrl+V 粘图、带去讨论、历史渲染、clear cache |
| `receiver/toolbox.js`（新） | 缓存键、缓存读写、上游调用、错误码映射 |
| `receiver/index.js` | `/tool/translate`、`/tool/history`、`/tool/cache/stats`、`/tool/cache/clear` 分支 |
| `agent/lib/llm-call.js`（新） | OpenAI 兼容调用（支持 `image_url` content），receiver 与 agent 共用 |
| `agent/lib/api-config.js` | `toolModel` 字段 |
| `agent/lib/error-classify.js` | `MODEL_NO_VISION` 的判定与文案 |
| `README.md` | 功能、目录结构、隐私三段更新 |

`agent/index.js` 主链路不改。

## 12. 测试与验收

单元测试：

- `agent/test/api-config.test.js` 扩展：`toolModel` 解析、空串回退主模型、写回不丢字段。
- `receiver/test/toolbox.test.js`（新，`node --test`）：缓存键稳定；缓存命中不发上游（注入 fake fetch 计数）；隔离断言（四个文件内容与 mtime 不变）；文本与图片超限返回 `TOO_LARGE`；术语约束出现在 prompt 内。

手动验收：

1. 任意英文网页选中一段，`Alt+T`，3 秒内浮标出译文。
2. 打开一篇含公式或双栏排版的英文页面，`Alt+S` 框选，译文与原文对应无错位。
3. 从 PDF 阅读器截图后在侧栏工具箱 `Ctrl+V`，完成翻译。
4. 点「带去讨论」：有当前书时该条消息出现在该书会话；无当前书时进入自由模式。翻译前后 `agent/topic_stack.json` 与 `agent/data/knowledge-graph.json` 内容不变。

## 13. 实现前需验证的前提

以下四条是方案的承载假设，实现第一步在目标 Chrome 版本上验证：

1. `chrome.commands` 快捷键授予 `activeTab`（Chromium 提交记录：Make extension commands grant the activeTab permission）。不成立时回退方案：先点扩展图标打开侧栏（授予 `activeTab`）再按 `Alt+S`，或改用 `optional_host_permissions`。
2. `OffscreenCanvas` + `createImageBitmap` + `convertToBlob` 在 MV3 service worker 内可用。
3. `captureVisibleTab` 每秒上限为 2 次。
4. 配置的模型支持 `image_url` 输入。

## 14. 待定项

- 面板内「截图」按钮：声明 `optional_host_permissions: ["<all_urls>"]`，点击时 `chrome.permissions.request`。
- 流式输出：receiver SSE 增加 `requestId` 关联与侧栏事件分发。
- 术语表编辑界面与书级覆盖。
- 整章翻译与双语 `.md` 导出。
- 系统级截图（`chrome.desktopCapture`）。
- 视频字幕翻译（`bilibili.com` 已在 manifest 匹配范围内）。
- 划词自动浮标开关（默认关）。
