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

即使模型训练知识里有后文的答案，agent 也不会用。它只引用 `data/reading/books/{bookId}/chapters/` 里实际存在的章节缓存——那些是你真正读过、由浏览器扩展静默缓存下来的内容。它可以说"这个问题书的后面会回应，读到再聊"，但不会越界。

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
- **框选 / 划词翻译**：`Alt+S` 框选屏幕一块区域、`Alt+T` 翻译页面上选中的文字，气泡里出「原文 + 译文」；译文可复制，也可以点「**设为引用**」把这段原文设成侧栏的当前引用（不直接发问，之后在侧栏输入框里自己问；需当前页关联了某本书）。气泡标题显示译文开头一截，一眼能对上是哪一段；可手动拖动、**右下角拖拽调整尺寸**、**📌 固定**（不随滚动、不自动收起，鼠标移开时收成只显示译文的小卡）、折叠成小标记；截图模式的原文可改，改完点「重译」（或 Ctrl+Enter）手动重新翻译——原文没改动时按钮是灰的。**翻过的原文留淡绿高亮**（点高亮展开/收起译文），气泡留在页面上（一页多个并存，各自锚在原文位置，可折叠成小标记、可拖动、鼠标移开后半透明），滚走再滚回来还在；译文同时记进 `data/toolbox/translation-history.jsonl`，工具箱里可「贴回页面」或「清除」。走在线多模态模型。入口是侧栏「⋯ → 🧰 工具箱 → 翻译」：里面有启用/禁用开关、快捷键设置，以及可选的自定义模型配置（默认沿用 CoRead 那一份，填哪项覆盖哪项）。工具箱按 tab 分页，以后的小工具都放这里。原先独立的 `screenshot-translate` 扩展已并入本扩展
- **放入文件**：侧栏可直接放入 .md/.txt 文档（「📎」或「📄」菜单），文档存为本地"文档书"，切换后即可与 AI 讨论全文
- **完全本地**：所有数据存在你的机器上

---

## 架构

```
微信读书网页版
  │  划线 / 章节切换 / 正文
  ▼
Chrome 扩展（extension/）—— 界面也在这里：侧栏、翻译浮层、PDF 阅读器
  │  POST /annotation  POST /content  POST /chapter-complete
  ▼
本机接收端 receiver/index.js  （127.0.0.1:7239）
  │  写 data/reading/annotations.jsonl（划线）
  │  写 data/reading/books/{bookId}/chapters/{chapterUid}.txt（章节正文缓存）
  │  放入文件 POST /import → data/reading/books/doc_xxx/（文档书）
  │  SSE 推送 → 浏览器侧栏
  ▼
共读引擎 agent/index.js
  │  轮询标注（游标跳过已处理的）
  │  会意系统：引用解析命中旧知识点 → L3 路径上下文；收口固化 → 会意图
  │  调用 LLM API（OpenAI 兼容）
  │  写 data/sessions/chat.db → 经 SSE 推到侧栏
  │  会意图 GET /graph → 侧栏拓扑视图
  └─ 会话结束：合并重写 data/profile/portrait.md 与 values-portrait.md
```

三个组件，没有云端服务。数据落在包根的 `data/` 与 `logs/`（聊天记录是本机 SQLite 库
`data/sessions/chat.db`），路径的唯一真源是 `agent/lib/paths.js`。

---

## 安装（普通用户：下载即用）

不需要装 Node，不需要敲任何命令。**目前只支持 Windows 10/11 + Chrome 或 Edge。**

1. 到 [Releases](https://github.com/jocaine/CoRead-weread/releases) 下载最新的
   `CoRead-<版本>-portable.zip`
2. 解压到任意普通文件夹 —— **不要放 `C:\Program Files`**，那里程序写不进自己的数据
3. 双击 `internal\Start-CoRead.vbs`，右下角出现托盘图标就是启动了
4. 装浏览器插件：**右键托盘图标 →「装浏览器插件」**，照它弹出的三步做
5. 填模型 API Key：打开[微信读书网页版](https://weread.qq.com)，右侧会出现 CoRead 侧栏，
   点右上角「⋯」→「模型 API 配置」，填入 API 地址、Key、模型名

包内的三份说明：`README-FIRST.txt`（一分钟上手）、`data\README.txt`（数据在哪、哪一格能删、
怎么备份）、`internal\instructions-zh.txt`（出问题时的排查手册）。

> **升级**：先从托盘退出 CoRead，再把新版本的 zip **解压到原来那个文件夹上覆盖**即可。
> 包里不含任何 `data\` 下的文件（只有空目录壳），覆盖的只是程序本身，你的记录不会被碰。
> 这一条是打包时强制校验的：`data\` 各格里出现任何一个文件，打包就直接中止。

---

## 从源码运行（开发者）

**前置要求**：Node.js **24+**（根 `package.json` 的 `engines` 要求）、Chrome、
任意 OpenAI 兼容的 LLM API Key（DeepSeek / Kimi / GPT-4o / 本地 Ollama 都行）、
微信读书网页版账号。

本仓库是 [`lexielin99-code/CoRead-weread`](https://github.com/lexielin99-code/CoRead-weread) 的 fork。

```bash
git clone https://github.com/jocaine/CoRead-weread.git
cd CoRead-weread
```

**开发与发行共用同一个入口**（2026-10 统一，理由见 `distribution-design.md` §6.4c）：
`Start-CoRead.vbs` 会拉起托盘 + 接收端 + 共读引擎，全程后台、零窗口。
与便携包唯一的区别：开发目录不自带 `node.exe`，node 取 PATH 里的。

```powershell
.\Start-CoRead.vbs        # 启动（和用户双击的是同一个脚本，只是没有自带 node）
# 退出：右键托盘图标 →「退出 CoRead」（会先让 agent 把本次记忆固化再退）
```

开发时**没有**前台 `> ` 提示符，这是刻意的：让开发也走生产那条启停路径
（写停机哨兵 → 等 agent 自退 → 关库）。输出进 `logs\agent.out.log`。
确实需要前台 REPL 时，先从托盘退出，再单独跑：

```bash
node --env-file-if-exists=data/config/env agent/index.js
```

### 模型 API 配置

两种方式，**插件里保存的优先**：

1. **插件侧栏**（推荐）：侧栏 →「⋯」→「模型 API 配置」。
   未配置时打开侧栏会自动弹这个窗。保存后立即生效，**不需要重启 agent**。
   落盘在 `data\config\api-config.json`。
2. **配置文件**：`data\config\env`（CLI / 无插件场景）。内容示例：

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

### 加载扩展

1. 打开扩展管理页（Chrome 是 `chrome://extensions/`，Edge 是 `edge://extensions/`）
2. 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `extension/` 目录
4. 打开 [weread.qq.com](https://weread.qq.com) 进入任意书籍的阅读页

### 测试

```bash
npm test          # 共读引擎的单测
npm run test:ext  # 扩展的单测（翻译协议解析 + 阅读器锚点）
```

### 开始共读

在正文里选中一段文字，点工具栏「共读」，确认后该段划入侧栏引用列表并设为当前引用
（侧栏自动打开），之后在侧栏输入框里提问即可。

顺带可用：`Alt+S` 框选屏幕一块区域翻译，`Alt+T` 翻译当前选中的文字（快捷键在浏览器的
扩展管理页里改）。工具箱入口是侧栏头部的「⋯ → 🧰 工具箱」，翻译是里面的一个 tab。

---

## 目录结构

```
CoRead-weread/
├── extension/          # Chrome MV3 扩展（界面 + 采集 + 翻译 + PDF 阅读器）
│   ├── manifest.json
│   ├── content.js      # 标注弹窗、章节切换检测、注入工具栏「共读 / 查引用」按钮
│   ├── service_worker.js   # 侧栏行为、章节正文网络拦截、装配翻译能力
│   ├── sidebar.html/js     # 侧边栏聊天 UI（含「放入文件」导入 .md/.txt、翻译面板、拓扑图）
│   ├── popup.html/js   # 点扩展图标的小弹窗（只有一句接收端健康检查）
│   ├── page_hook.js    # MAIN world 注入，拦截 clipboard
│   ├── graph-view.js   # 会意图拓扑视图（侧栏「◎」打开）
│   ├── reader*.js/css  # 自建 PDF 阅读器（vendor/pdfjs 是 PDF.js，第三方）
│   ├── translate-protocol.js    # 翻译纯函数层：prompt / 请求体 / 回复解析 / 错误分类
│   ├── translate-background.js  # 翻译的 service worker 部分：截图、调用多模态模型
│   ├── translate-overlay.js/css # 页面内遮罩框选与译文气泡（按需注入，Shadow DOM）
│   ├── source-mia.js   # 网页阅读源适配（中文马克思主义文库 / B 站）
│   ├── test/                    # 单测（node:test；打包时排除）
│   └── THIRD-PARTY.md           # 译文气泡的移植来源与 MIT 声明（源自 bssm-oss/img-to-translate）
│
├── receiver/           # 本机 HTTP 接收端（127.0.0.1:7239）
│   ├── index.js
│   └── graph-data.js   # 图谱视图的数据层（正式图 → 回退 → 空图三级）
│                       # 注意：接收端**只有代码**，数据全在包根 data\ 下
│
├── agent/              # 共读引擎
│   ├── index.js        # 主进程：轮询标注 → 调 LLM → 写库/推送
│   ├── AGENT.md        # agent 的行为规则（系统提示词）
│   ├── lib/            # 会意系统、聊天库、图谱、路径真源 lib/paths.js
│   ├── scripts/        # 维护脚本（迁移 / 备份 / 诊断 / 冒烟 / 图谱派生）
│   └── *.md            # 会意图、自画像等设计文档
│
├── installer/          # 打包与启动链路
│   ├── launcher/tray.ps1      # 托盘程序（起停、状态、端口冲突检测、崩溃自愈）
│   ├── portable/              # 随包的说明文件（README-FIRST / instructions-zh / DATA-README）
│   └── pack-portable-zip.ps1  # 打包便携包 zip（含三道编码与敏感数据闸门）
│
├── Start-CoRead.vbs    # 开发入口（与包内 internal\Start-CoRead.vbs 同一个脚本）
│
├── devdata/            # 【开发期数据，不进包】judge / 图谱脚本的输入与产物。
│                       # 全是本人真实阅读语料，已 gitignore（只有 README.txt 入库）
│
└── 运行时生成（已 gitignore）：data\（你的全部数据）、logs\、builtin\（空目录）
```

### 数据在这几个格子里（都在包根 `data\`）

```
data\config\     设置：API 地址、模型名、密钥（含密钥明文，别外发）
data\profile\    阅读画像 portrait.md、价值观侧写 values-portrait.md、知识图谱
data\sessions\   聊天库 chat.db、会话流水账、讨论栈、历史游标
data\reading\    划线 annotations.jsonl、书库缓存 books\{bookId}\chapters\
data\runtime\    处理状态（可随时删，启动自动重建）
data\toolbox\    翻译记录 translation-history.jsonl
data\backups\    备份产物
```

**备份 = 复制 `data\` 这一个文件夹。** 哪一格能删、怎么搬家见 `data\README.txt`。

---

## Token 控制

读的书越多，上下文不会线性膨胀：

- **标注游标**：已处理的标注通过游标跳过，不重复读取（`data/runtime/agent-cursor`）
- **按需加载**：每次讨论只加载当前书的章节窗口（±300字）和摘要，其他书不进上下文
- **跨书检索**：其他书的记忆按需带入——用户引用旧知识点时（引用解析命中），只带命中节点的 root→recent 路径（L3，见 `agent/topic-library-design.md` §5）
- **记忆合并**：`portrait.md` / `values-portrait.md` 每次会话结束合并重写而非追加，长度保持稳定

---

## 隐私

所有数据都存在本机包根的 `data\` 里：章节正文缓存、划线、聊天库、以及你与 agent 的长期记忆。
程序不连任何自建服务器，没有账号体系，也没有云端存储。

调用模型时，发给你**自己在「模型 API 配置」里填的那个服务商**的内容是：这次讨论需要的
章节正文片段、你的提问、以及你的长期阅读画像（`data\profile\`）。**不会把整个书库发出去**，
也不会发往你配置之外的任何地址。标注只进本机，不写入微信读书的公开想法 / 划线。

翻译功能同理：框选截图（整屏截图）或划词翻译的原文会发往同一个模型服务商。

**备份 = 复制 `data\` 这一个文件夹**；其中 `data\config\` 含密钥明文，外发前先清掉。

---

## License

MIT。本仓库是 [`lexielin99-code/CoRead-weread`](https://github.com/lexielin99-code/CoRead-weread)
的 fork，在上游基础上做了数据目录重构（用户数据集中到 `data\`）、启动入口统一
（`Start-CoRead.vbs` + 托盘驱动）、便携包打包链路与托盘/插件图标等工作。
第三方组件的许可声明见 `extension/THIRD-PARTY.md` 与 `installer/launcher/LICENSE.node.txt`。
