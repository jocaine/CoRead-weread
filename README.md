# CoRead — AI 共读伙伴

> *We read to know we are not alone.*

---

## 它是什么

大多数 AI 阅读工具的逻辑是：你问，它答，调用全库知识。

CoRead 不是这样。

它和你一起读——**只知道你读过的内容**，不知道后文，不会剧透，不会用它的训练知识抢答你还没读到的部分。你读到哪一页，它的认知边界就在哪一页。

你在微信读书网页版划一段话，写下你的第一反应（或什么都不写），几秒后它在侧栏接话：给出它自己的观点，不是复述，可以不同意你，会交锋。同一问题的讨论它会接着追（进行中的讨论跨会话保存），话题翻篇时旧讨论收口固化进会意图——每个知识点节点保留整场讨论，你以后提到它时自动接上。没聊透的话题它记下来，等时机合适再提。

读的书越多，它越懂你。它有两个长期记忆文件：一个记你——你的阅读品味、关注主题、思维习惯；一个记它自己——在讨论中形成的立场、你们之间的共识与分歧、它学会的与你相处的方式。每次共读结束后这两个文件都会更新，不追加，合并重写，永远是当下最准确的快照。

**这是一个对等的讨论伙伴，不是问答工具。**

---

## 核心设计决策

**进度门控（Progress Gating）是产品特性，不是技术妥协。**

即使模型训练知识里有后文的答案，agent 也不会用。它只引用 `receiver/books/{bookId}/chapters/` 里实际存在的章节缓存——那些是你真正读过、由浏览器扩展静默缓存下来的内容。它可以说"这个问题书的后面会回应，读到再聊"，但不会越界。

**你的标注是私密的。**

划线和批注只进入本地系统，不写入微信读书的公开想法/划线。章节正文缓存在本地，不上传任何服务器。

---

## 功能

- **划线设为当前引用**：选中文字 → 点击工具栏「共读」→ 该段划入侧栏引用列表并设为当前引用，之后再在侧栏里向 AI 提问
- **进度门控**：AI 只知道你读过的内容，不剧透后文，是读到同一页的伙伴
- **跨书记忆**：换书再聊同一知识点时，引用解析命中旧知识点，自动带回 root→recent 拓扑路径（会意图 L3）
- **长期记忆生长**：阅读画像（profile）和 agent 自画像（soul）随每次共读更新，越来越懂你
- **会意图拓扑视图**：侧栏「◎」打开知识点拓扑图（Obsidian 式浏览：缩放/平移/悬停/点选详情/搜索），对话命中旧知识点时自动高亮 root→recent 拓扑脉络
- **侧栏 UI**：Chrome Side Panel 原生展示，不遮挡正文
- **框选 / 划词翻译**：`Alt+S` 框选屏幕一块区域、`Alt+T` 翻译页面上选中的文字，气泡里出「原文 + 译文」；译文可复制，也可以点「**设为引用**」把这段原文设成侧栏的当前引用（不直接发问，之后在侧栏输入框里自己问；需当前页关联了某本书）。气泡标题显示译文开头一截，一眼能对上是哪一段；可手动拖动、**右下角拖拽调整尺寸**、**📌 固定**（不随滚动、不自动收起，鼠标移开时收成只显示译文的小卡）、折叠成小标记；截图模式的原文可改，改完点「重译」（或 Ctrl+Enter）手动重新翻译——原文没改动时按钮是灰的。**翻过的原文留淡绿高亮**（点高亮展开/收起译文），气泡留在页面上（一页多个并存，各自锚在原文位置，可折叠成小标记、可拖动、鼠标移开后半透明），滚走再滚回来还在；译文同时记进 `receiver/toolbox/history.jsonl`，工具箱里可「贴回页面」或「清除」。走在线多模态模型。入口是侧栏「⋯ → 🧰 工具箱 → 翻译」：里面有启用/禁用开关、快捷键设置，以及可选的自定义模型配置（默认沿用 CoRead 那一份，填哪项覆盖哪项）。工具箱按 tab 分页，以后的小工具都放这里。原先独立的 `screenshot-translate` 扩展已并入本扩展，设计与边界见 `screenshot-translate-design.md`
- **放入文件**：侧栏可直接放入 .md/.txt 文档（「📎」或「📄」菜单），文档存为本地"文档书"，切换后即可与 AI 讨论全文
- **完全本地**：所有数据存在你的机器上

---

## 架构

```
微信读书网页版
  │  划线 / 章节切换
  ▼
Chrome Extension (extension/)
  │  POST /annotation  POST /content  POST /chapter-complete
  ▼
本地接收端 receiver/index.js  :7239
  │  写 inbox/annotations.jsonl
  │  写 books/{bookId}/chapters/{chapterUid}.txt
  │  放入文件 POST /import → books/doc_xxx/（文档书）
  │  SSE 推送 → Chrome Side Panel
  ▼
Agent  agent/index.js
  │  轮询 annotations.jsonl（游标跳过已处理）
  │  会意系统：引用解析命中旧知识点 → L3 路径上下文；收口固化 → 会意图
  │  调用 LLM API（OpenAI 兼容）
  │  写 chat_output.jsonl → SSE → 侧栏显示
  │  会意图 GET /graph → 侧栏拓扑视图（AI-020）
  └─ 会话结束：合并重写 profile.md / soul.md
```

三个组件，没有云端服务，没有数据库。

---

## 快速开始

**前置要求**：Node.js 18+，Chrome，任意 OpenAI 兼容的 LLM API Key（支持 GPT-4o、DeepSeek、Kimi、Ollama 本地等），微信读书网页版账号

### 1. 克隆项目

```bash
git clone https://github.com/lexielin99-code/CoRead-weread.git
cd coread
```

### 2. 启动本地接收端

```bash
cd receiver
npm install
node index.js
# 监听 http://localhost:7239
```

### 3. 配置并启动 Agent

```bash
cd agent
npm install
npm start
```

模型 API 在**插件侧栏**里配置：打开侧栏 → 右上角「⋯」→「🔑 模型 API 配置」→ 填 API 地址 / API Key / 模型
（当前未配置时，打开侧栏会自动弹出这个弹窗）。保存后立即生效，**不需要重启 agent**。
配置写在本机 `agent/api-config.json`，支持任何 OpenAI 兼容协议的服务商（GPT-4o、DeepSeek、Kimi、Ollama 本地等）。

也可以继续用 `agent/.env`（CLI / 无插件场景）：`cp .env.example .env`。两侧都填时，
**插件里保存的配置优先**。`.env` 示例：

```env
# DeepSeek
COREAD_API_KEY=sk-xxx
COREAD_API_BASE=https://api.deepseek.com/v1
COREAD_MODEL=deepseek-chat

# 本地 Ollama（无需 key）
COREAD_API_KEY=ollama
COREAD_API_BASE=http://localhost:11434/v1
COREAD_MODEL=qwen2.5:14b
```

### 4. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 目录
4. 打开 [weread.qq.com](https://weread.qq.com) 进入任意书籍阅读页

### 5. 开始共读

在正文里选中一段文字，点击工具栏「共读」，弹出确认窗口；确认后该段划入侧栏引用列表并设为当前引用（Side Panel 自动打开），之后在侧栏输入框里向 AI 提问即可。

顺带可用：`Alt+S` 框选屏幕一块区域翻译，`Alt+T` 翻译当前选中的文字（快捷键可在 `chrome://extensions/shortcuts` 改）。工具箱入口是侧栏头部的「⋯ → 🧰 工具箱」，翻译是里面的一个 tab。

---

## 目录结构

```
coread/
├── extension/          # Chrome MV3 扩展
│   ├── manifest.json
│   ├── content.js      # 标注弹窗、章节切换检测
│   ├── service_worker.js   # 章节正文网络拦截 + 装配翻译能力
│   ├── sidebar.html/js     # Chrome Side Panel 聊天 UI（含「放入文件」导入 .md/.txt、翻译面板）
│   ├── page_hook.js    # MAIN world 注入，拦截 clipboard
│   ├── translate-protocol.js    # 翻译纯函数层：prompt / 请求体 / 回复解析 / 错误分类
│   ├── translate-background.js  # 翻译的 service worker 部分：截图、调用多模态模型
│   ├── translate-overlay.js/css # 页面内遮罩框选与译文气泡（按需注入，Shadow DOM）
│   ├── test/                    # translate-protocol.js 的单测（node:test）
│   └── THIRD-PARTY.md           # 译文气泡的移植来源与 MIT 声明（源自 bssm-oss/img-to-translate）
│
├── receiver/           # 本地 HTTP 接收端（localhost:7239）
│   ├── index.js
│   ├── inbox/          # annotations.jsonl / chat_*.jsonl
│   ├── toolbox/        # history.jsonl 翻译记录（多气泡「贴回页面」的数据源）
│   └── books/
│       └── {bookId}/
│           ├── chapters/       # 章节正文缓存 .txt
│           └── discussions.jsonl   # 讨论记录（TAKEAWAY 机制已移除，文件仅存历史数据）
│
└── agent/              # AI Agent
    ├── index.js        # 主进程：轮询 → LLM → 输出
    ├── AGENT.md        # Agent 行为规则（系统提示词）
    ├── profile.md      # 你的阅读画像（自动维护，gitignored）
    ├── soul.md         # Agent 的立场与记忆（自动维护，gitignored）
    └── scripts/
        ├── coldstart.js    # 冷启动：从微信读书 API 拉取历史
        └── inject.sh       # tmux 消息注入
```

---

## Token 控制

读的书越多，上下文不会线性膨胀：

- **Inbox 游标**：已处理的标注通过游标跳过，不重复读取
- **按需加载**：每次讨论只加载当前书的章节窗口（±300字）和摘要，其他书不进上下文
- **跨书检索**：其他书的记忆按需带入——用户引用旧知识点时（引用解析命中），只带命中节点的 root→recent 路径（L3，见 agent/topic-library-design.md §5）；`recall.js` 关键词检索因中文分词无法落地已禁用
- **记忆合并**：`profile.md` / `soul.md` 每次会话结束合并重写而非追加，长度保持稳定

---

## 隐私

所有数据（章节正文、标注、对话记录）存储在本地 `receiver/` 目录。LLM API 调用只发送当前讨论片段，不发送完整书库。标注不写入微信读书公开系统。

翻译功能例外：框选截图或划词翻译时，截图内容或选中文字会发往你在「模型 API 配置」里填的模型服务；除此之外不发往任何地址。

---

## License

MIT
