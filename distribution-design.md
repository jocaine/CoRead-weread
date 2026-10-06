# 分发方案对比：从"自用"到"别人能用"

> 起因：想知道能不能直接上 Chrome 应用商店（CWS）让别人下载使用。
> 结论：**上架在技术上可行，但会砍掉产品的核心价值**。本文把依赖关系、三条路的成本与风险摊开。

---

## 一、先把依赖关系说清

### 1.1 现在的运行时结构

```
微信读书网页版
  │ 划线 / 章节切换
  ▼
Chrome 扩展（extension/）
  │ POST /annotation  POST /content  POST /chapter-complete ...
  ▼
本地接收端 receiver/index.js :7239        ← 1152 行
  │ 写 receiver/inbox/annotations.jsonl
  │ 写 receiver/books/{bookId}/chapters/{uid}.txt
  │ SSE 推送给侧栏
  ▼
Agent agent/index.js                       ← 2226 行
  │ 每 300ms 轮询 annotations.jsonl（游标跳过已处理）
  │ 调 LLM（OpenAI 兼容协议）
  │ 写回复 → SSE → 侧栏
  │ 会话结束：蒸馏进 profile.md / soul.md
  └─ 会意图谱 knowledge-graph.json（1.9 MB）
```

两个运行进程：**receiver（无状态服务）+ agent（长跑的命令行交互程序）**。

### 1.2 接收端当初为什么被拆出来

| # | 动因 | 是否决定性 |
|---|---|---|
| 1 | 接收端必须**永远在线**，agent 不是——你没开 agent 时划线也得能存下来 | **决定性** |
| 2 | agent 是建在 stdin/stdout 上的**命令行交互进程**（提示符 `> `、`/exit`、`/收口`），形态上不能当服务器 | **决定性** |
| 3 | 侧栏打字机效果靠 **SSE 长连接**，得挂在常驻进程上 | 重要 |
| 4 | agent 要能随时重启而不丢数据（数据留在接收端的文件里） | 重要 |
| 5 | `127.0.0.1:7239` 是三方汇合点（扩展、agent、selftest），扩展不用知道 agent 在哪 | 便利 |

**关键推论**：动因 1、3、4 只要求"有个常驻服务"，**不要求它是独立进程**。所以接收端理论上可以并进扩展；**但并进去解决不了上架问题**，因为搬不动的是 agent。

### 1.3 agent 搬不进扩展的三条硬约束

| 约束 | 具体表现 | 代码证据 |
|---|---|---|
| **生命周期** | MV3 的 background service worker 空闲约 30 秒被浏览器回收；agent 需要长期驻留 | `agent/index.js:2010` 300ms 轮询循环 |
| **长耗时任务** | 一次 LLM 调用几十秒到几分钟；会话结束的画像蒸馏可能跑一分钟 | `saveSessionMemory()`、收口固化 |
| **文件系统 + Node 能力** | 章节缓存、图谱、画像、`node:sqlite`、子进程 | `node:sqlite` 浏览器无对应物 |

### 1.4 扩展对本地服务的真实调用（26 个路由）

按依赖强度分三档：

**A 档：只依赖文件读写，与 agent 无关**（这些能脱离 agent 工作）

```
/annotation  /annotation-delete  /annotations
/content  /chapter-complete  /progress
/books  /book-create  /book-delete  /find-chapter
/reader-book  /reader-books  /reader-book-file  /reader-book-delete
/tool-record  /tool-records  /tool-records-clear
/api-config
```

**B 档：需要 agent 在线才有数据**（agent 不在时返回空）

```
/chat          侧栏发问、取回复
/history       历史消息
/events        SSE 推送（打字机效果）
/graph         会意图谱拓扑视图
/free-conversations  自由模式对话列表
/free-archive  归档对话
/stack-hits    实时讨论栈命中
/debug
```

**C 档：一次性/运维**

```
/book-delete 后台清理、selftest 专用端点
```

> **这意味着**：把 A 档并进扩展是可行的；B 档全部是"agent 的产物"，没有 agent 就没有内容。

---

## 二、三条路的成本与风险

### 路 C：桌面应用化（保住共读，用户装一个 exe）

**做法**：Electron 或 Tauri 套壳，把 agent + receiver 包进一个桌面程序；加托盘图标、开机自启、图形界面替掉命令行。

| 项 | 评估 |
|---|---|
| 用户门槛 | 装一个 `.exe`，**不用装 Node、不用敲命令** |
| 保住的能力 | 全部（共读、记忆、图谱、隐私设计） |
| 安装包体积 | Electron 约 150 MB；Tauri 约 10–20 MB（但要 Rust 工具链） |
| 工作量 | **大**：要从零写 GUI（现在 agent 是命令行交互，有 `/收口` 等一堆命令要变成按钮/菜单）；打包与自启逻辑；跨平台签名 |
| 主要风险 | GUI 化的工作量可能超过共读逻辑本身；Electron 内存占用比纯 Node 高 |
| 上架商店 | ❌ 不能。扩展仍需本地加载或自签 `.crx` 分发 |

**为什么 Tauri 值得考虑**：你的后端是纯 Node、零依赖，Tauri 可以把 Node 作为 sidecar 进程带进去，体积比 Electron 小一个量级。

### 路 B：商店上架"轻量版"（翻译 + 阅读器，不依赖本机后端）

**做法**：拆出一个独立扩展，只保留**本来就不依赖 receiver 的部分**——翻译和阅读器。

**关键事实**：翻译的**模型调用**是直连的，但**其余六件事仍依赖 receiver**。逐条核对 `translate-background.js`：

| 行 | 调用 | 用途 | 脱离 receiver 后怎么办 |
|---|---|---|---|
| L418 | `fetch(chatCompletionsUrl(cfg.apiBase))` | **调模型翻译** | ✅ 本来就不走 receiver |
| L301 | `/api-config` | 读模型配置（复用 agent 那份） | 改成扩展内自填（侧栏已有这套 UI） |
| L621 | `/tool-records` | 读翻译记录（贴回本页） | 改存 `chrome.storage.local` |
| L766 | `/tool-record` | 写翻译记录 | 同上 |
| L819 | `/tool-records-clear` | 清翻译记录 | 同上 |
| L871 | `/books` | 查已读书籍（判断当前页属于哪本书） | **需要重做**：书籍元数据来自 receiver/books |
| L902 | `/annotation` | 把翻译原文存成标注 | **需要重做或砍掉** |

所以这条路的工作量比我原先估计的多一档：**不是"摘出来"，而是"去掉 6 处 receiver 依赖"**，其中 `/books` 和 `/annotation` 涉及与共读数据的联动，砍掉会掉功能。

| 项 | 评估 |
|---|---|
| 用户门槛 | 最低：商店一键安装，填个 API key 就能用 |
| 能上架吗 | ✅ 能，前提是功能自洽、有图标、有隐私政策 |
| 保住的能力 | ❌ 只有翻译 + PDF 阅读器 + 划词。**没有共读、没有记忆、没有图谱**；与书籍的联动会弱化 |
| 工作量 | **中偏大**：拆代码；6 处 receiver 调用要各自找替代（4 处改本地存储、2 处要重做或砍）；补图标/隐私政策/商店素材 |
| 主要风险 | 商店里已有大量翻译扩展，**没有差异化**；用户装完可能以为是完整的 CoRead，发现侧栏是空的 → 差评 |
| 上架商店 | ✅ 这条的唯一目的 |

**审核要点**（已扫过，这几项你是干净的）：
- ✅ 无 `eval` / `new Function` / 远程脚本注入（CWS 红线）
- ✅ AI 回复经 `esc()` 转义 + 自研 markdown 转换，不是把远程 HTML 直接塞进 DOM
- ⚠️ `optional_host_permissions` 申请 `https://*/*` 是审核重点。若固定用一家模型服务，应改成具体域名（如 `https://api.deepseek.com/*`），阻力大降
- ✅ 图标已补齐（2026-10）：`extension/icons/icon{16,32,48,128}.png`，manifest 的 `icons` 与 `action.default_icon` 都已声明；托盘图标另有 `assets/icons/coread.ico`（含 16/32/48/128/256 五档）。生成脚本 `tools/make-icons.ps1`，设计是"蓝底 + 白书页 + 暖橙书签"，取向为**小尺寸优先**（托盘只有 16×16）
- ❌ 缺隐私政策（处理阅读数据 + 调外部模型，属重点审查对象）

### 路 A：搬上云端做 SaaS

**做法**：agent + receiver 全部搬到你的服务器，扩展只当客户端。

| 项 | 评估 |
|---|---|
| 用户门槛 | 最低：装完即用，不用填 key（如果费用你出） |
| 上架商店 | ✅ 最顺 |
| 保住的能力 | 功能都在，**但性质变了** |
| 工作量 | **最大**：服务器、账号体系、计费或限流、多租户隔离、数据迁移 |
| 主要风险 | ⚠️ **与现有隐私设计直接冲突**。README 现在写的是"所有数据存在你的机器上""章节正文缓存在本地，不上传任何服务器"。改 SaaS 后这些表述全部失效，要重写隐私叙事 |
| 长期成本 | 持续租服务器 + 用户 LLM 费用谁承担（自掏则成本无上限） |

---

## 三、横向对比

| 维度 | 路 C 桌面应用 | 路 B 轻量上架 | 路 A 云端 SaaS |
|---|---|---|---|
| 用户安装难度 | 低（装 exe） | 最低（商店） | 最低（商店） |
| 共读核心能力 | ✅ 完整 | ❌ 砍掉 | ✅ 完整 |
| 隐私叙事 | ✅ 不变 | ✅ 不变（只传片段给模型） | ❌ 必须重写 |
| 工作量 | 大 | 中偏大 | 最大 |
| 持续成本 | 无 | 无 | 服务器 + 可能代付 API |
| 能进 CWS | ❌ | ✅ | ✅ |
| 与现有设计冲突 | 无 | 无（只是砍功能） | **有** |

---

## 四、建议

**推荐路 C，理由不是它最省事，而是它唯一同时满足两个条件**：保住"陪了几个月的共读伙伴"这个核心价值，且不让用户碰命令行。

路 B 虽然能上架，但它上架的是一个**跟你的产品定位无关的翻译工具**。商店里这种扩展一抓一大把，你既拿不到差异化，又会因为"以为是完整版"收到差评。除非你的目标是"先用小工具在商店占位、积累用户"，那它才成立。

路 A 我建议先排除：它要求你把"数据不出本机"这个卖点亲手拆掉，而这是你现在最有辨识度的设计。

**如果两个都想要**，可以并行但分开命名：共读完整版走桌面应用；商店里放一个明确叫"CoRead 翻译"的独立小扩展，描述里写清它不含共读。两个产品各自诚实，不会互相拖累。

---

## 五、选路 C 的话，第一步做什么

先做**最小可用闭环**验证可行性，不要一上来就写完整 GUI：

1. **验证 Node 作为 sidecar 能跑通**：用 Tauri 或 Electron 拉起现在的 `receiver/index.js` + `agent/index.js`，确认端口、路径、stdin 交互都能工作（agent 从 stdin 读命令这点要改成从 GUI 收指令）
2. **把 agent 的交互接口从 stdin 改成可编程控制**：现在靠 readline（`agent/index.js:1961`），GUI 需要一个替代入口（比如本地控制端口或 IPC）
3. **写最小 GUI**：托盘图标 + "启动/停止" + 一个输入框转发给 agent
4. 跑通后再补：开机自启、打包签名、扩展随包分发

**这个第 2 步是真正的工作量所在**，也是这条路的主要风险点，建议先单独评估它有多大。

---

## 六、决策更新（已定）

前五节的"桌面应用 + Rust/Electron"路子**已排除**，原因见下。当前方向以本节的实测结论为准。

### 6.1 方向修正：界面必须在用户自己的浏览器里

原第五节的思路是把整个应用做成桌面程序，这**与用户需求冲突**：界面（侧栏、翻译浮层、阅读器）本来就跑在用户常用的浏览器里，做成桌面窗口等于让用户换地方用。

修正后的分工：

| 部分 | 跑在哪 | 状态 |
|---|---|---|
| 界面（侧栏 / 翻译浮层 / 阅读器） | 用户的浏览器 | ✅ 已有 |
| 共读引擎 + 接收端 | 用户电脑后台，**无界面** | 需打包分发 |

**连带结论**：不需要 WebView，所以 Tauri 与 Electron 都不需要，Rust 工具链也不用装。桌面端只需要"托盘图标 + 开机自启"。

### 6.2 Chrome 应用商店：不作为主要分发渠道

用户提出的问题很关键：**商店扩展装不上本地后端**。核实后确认这是 Chrome 的安全边界，绕不过去：

| 扩展能否… | 结论 |
|---|---|
| 静默安装一个本地程序 | ❌ 做不到（正是 Chrome 要防的） |
| 触发一次下载，用户自己双击安装 | ✅ 可以 |
| 拉起一个已注册的本地程序（Native Messaging） | ✅ 但"注册"本身仍需先手动装一次 |

**结论**：无论如何，"装后端"这一步必须用户手动完成。商店只能解决"装扩展"，不能解决"装后端"。

另外，**商店值不值得走，关键在自动更新而非下载**：扩展与后端有 26 个接口耦合，版本必须配套。非商店安装的扩展不会自动更新，用户会永远停在旧版本。（可能的技术出路：`update_url` + 启动 Chrome 时带 `--extensions-update-frequency`，**未验证**。）

### 6.3 已实测验证：便携包可行 ✅

**验证目标**：证明一个自带 Node 运行时的目录，能在**完全没有安装 Node** 的机器上跑起来。

**验证方法**：把便携目录放进一个 `PATH` 指向空目录的环境（用 `env` 精确构造，排除系统 Node / nvm 干扰），再启动两个进程。

**验证结果**：

```
环境 PATH: <空目录>（确认 where node 找不到 node）

receiver（PID 13536）  ✅ 存活
  CoRead receiver listening on http://localhost:7239
  Inbox: ...\coread-portable\receiver\inbox
  Books: ...\coread-portable\receiver\books

agent（PID 18080）     ✅ 启动成功，正确读到便携目录内的路径
  📖 CoRead 共读 agent 已启动
     监听标注：...\coread-portable\receiver\inbox\annotations.jsonl
  （停在"是否加载阅读画像 (y/n)"等待输入，属预期）

HTTP 实测：
  GET /books       → 200（12 字节）
  GET /api-config  → 200（78 字节）
  GET /graph       → 200（170,641 字节）
  GET /history     → 200（2 字节）

数据隔离：便携目录内自建 chat.db，未触碰开发机上的真实库
```

**便携目录实测构成**：

| 组成 | 大小 |
|---|---|
| `node.exe`（官方分发包，仅此一个文件） | 87.4 MB |
| `agent/`（index.js + lib + 运行时数据） | 0.8 MB |
| `receiver/`（index.js + package.json） | 0.1 MB |
| `extension/`（插件文件，供安装向导指向） | 5.8 MB |
| **合计** | **94.3 MB / 256 个文件** |

**两个关键发现**：

1. **官方 Node 分发包里只有 `node.exe` 是运行必需的**。包里另有 `node_modules/`（11 MB，是 npm 自己）和一堆命令行脚本（`npm`、`npx`、`corepack` 等），本项目零第三方依赖，**这些全部可以不带**。
2. **`node:sqlite` 是编译进 `node.exe` 的**，不需要任何外部文件。已用"空白临时目录"单独验证过。

### 6.4 打包时必须注意的路径规则（实测得出）

盲拷整个目录会**把开发机上的个人数据一起打包**——实测中第一次就误带进了 12 本真实书籍、聊天库、API Key。正确的包含/排除清单（**2026-10 目录重构后**）：

| 必须带上 | 必须排除 |
|---|---|
| `node.exe` + Node 自己的 LICENSE | `data/config/env`、`data/config/api-config.json`（含 API Key 明文）——**只放空模板** |
| `agent/index.js`、`agent/package.json`、`agent/lib/`、`agent/.env.example` | `data/` 下各格（用户数据）——**全部建空目录** |
| `agent/scripts/data/` 里的冒烟用例（`smoke-*`、`judge-smoke-*`） | `agent/scripts/` 下其余文件（开发脚本，4.2 MB；含作者个人的判例与图谱产物） |
| `agent/scripts/data/knowledge-graph-{results,demo}.json` → **`builtin/`**（图谱回退源与演示图，运行时会被读） | 作者的 `judge-real-*`、`derive-*` 等真实读数产物 |
| `receiver/index.js`、`package.json`、`graph-data.js` | 老布局残留：`receiver/books/`、`receiver/inbox/`、`receiver/toolbox/`、`agent/data/` |
| `extension/`（排除 `test/`） | `agent/test/`、`agent/*.md`、`*.bak*`、`*.out` |

**⚠️ 升级时的红线**：升级只能覆盖程序文件，**绝对不能碰** `data/`（用户数据全在这里）。否则一次升级就把读者几个月的阅读记录和聊天历史清空。

打包脚本里有一道**敏感数据闸门**（`installer/pack-portable-zip.ps1`）：`*.db`、`*.jsonl`、`*.env`、含 `sk-` 的配置、以及 `data/` 下任何非空文件，检出即中止。`builtin/` 另有一条更细的规则——只放行两个通用图谱文件，且逐个与仓库源文件做 SHA256 比对。

### 6.4b 数据目录重构（2026-10-06，已实施）

**改之前**：数据路径散在 5 个文件的 10 处定义里，落点跟着代码走——

```
internal\agent\data\        会意图谱、自由对话列表、未答提问清单
internal\agent\（根目录）   讨论栈、会话流水账、截尾游标、API 配置、三份画像、冷启动标记
internal\receiver\inbox\    聊天库、标注、标注游标、已删标注存档、调试日志
internal\receiver\books\    书库缓存
internal\receiver\toolbox\  翻译记录
```

**为什么必须改**（不是审美问题，是实测踩出来的）：

1. **用户无法凭目录判断该备份什么**。2026-10-06 实测：用户要把自己的数据搬到新版本，按"看起来像数据目录"的两个文件夹（`agent\data\`、`receiver\books\`）复制，结果 11 个文件没拷过去；`chat.db` 没拷 → 侧栏聊天记录全空。
2. **只补拷主库会毁数据**。把 `chat.db` 单独拷到已经跑过旧版的目标目录，旁边还留着旧库的 `chat.db-wal`，SQLite 会按那份旧日志把新库**回滚成空库**——实测复现：725 页 → 13 页，941 条消息清零。这个坑对用户完全不可见（"我明明拷了 2.9 MB 的文件"）。
3. **托盘"优雅停机"从来没生效过**。`tray.ps1` 写哨兵到 `<包根>\data\agent\.stop`，而 agent 查的是 `internal\agent\.stop`——两个路径对不上（同一份代码里两处各自拼路径的直接后果）。日志实证：写哨兵后 3 秒强杀进程，最后一场对话的记忆不固化。**修数据路径这件事顺手把这个 bug 消掉了**：现在两边都从 `agent/lib/paths.js` 取 `STOP_FILE`。
4. 那行错路径还**凭空造了一个 `<包根>\data\agent\` 空目录**——正是本文件 6.1 节写明"不要去造"的那种误导性空壳（"会让用户以为数据在那、实际不在"）。

**改之后**：

```
<包根>\
├── data\            用户数据，按类型分格（备份 = 复制这一个文件夹）
│   ├── config\        设置（含密钥，单独一格便于剔除）
│   ├── profile\       画像、价值观侧写、知识图谱
│   ├── sessions\      聊天库、流水账、游标、讨论栈
│   ├── reading\       标注、书库缓存
│   ├── runtime\       处理状态（可随时删）
│   └── toolbox\       翻译记录
├── builtin\         随包分发的内置图谱（不是用户数据）
├── extension\       浏览器插件
├── internal\        程序本体（不含任何用户数据）
└── logs\            日志
```

**实现要点**：

| 项 | 做法 |
|---|---|
| 路径真源 | `agent/lib/paths.js` 一个文件；agent、receiver、脚本全部 import 它，不再各自 `path.join(__dirname, ...)` |
| 包根判定 | `PARENT_NAME === 'internal'` → 便携包布局，包根 = 上一级；否则开发布局，包根 = 仓库根。规则只有一条，检查的是**我们自己的安装布局**而不是"仓库长什么样" |
| 开发 vs 分发 | 两种布局共用同一份代码路径，不需要环境变量、不需要构建期改写 |
| 老用户升级 | `agent/scripts/migrate-data-layout.mjs`（默认演练，`--apply` 才动文件；先复制→校验字节数→通过才删源→关键文件留 `.pre-migrate` 备份）。agent 启动时用 `detectUnmigrated()` 体检并打印指路提示——**不迁移就是静默的空库，必须显式提醒** |
| 升级红线 | 升级只覆盖程序文件；`data/` 归用户，见 §6.5 |

**没做的事（如实记录）**：

- **没有"自动迁移"**。老用户升级要手动跑一次迁移脚本（启动时会告警指路）。不做自动的原因：迁移是"复制 → 校验字节数 → 通过才删源"的写操作，必须在程序完全退出时执行、且要能逐项报出失败；塞进启动流程后一旦中途失败，就是"数据搬了一半、程序也起不来"。
- **开发目录第一次启动时 `data/` 由迁移脚本或 `ensureDirs()` 创建**；全新 clone 的仓库没有 `data/`（`.gitignore` 已排除内容，只留 `README.txt`）。

### 6.4c 启动入口统一：开发与发行共用一套（2026-10-06，已实施）

**改之前**：开发目录有自己的一对 `start.bat` / `stop.bat`（仓库根，前台跑 agent、直接 `taskkill` 收尾），
便携包有另一套（`01-START-CoRead.bat` + `internal\tray.ps1` + `internal\stop.bat`，托盘驱动、全程隐藏）。
两套并存的问题不是"重复"，而是**开发期走不到生产的那条路**：
| 生产路径 | 开发期是否被执行过 |
|---|---|
| 写停机哨兵 → 等 agent 保存记忆自己退出 → 关聊天库 | ❌ 从来没有（开发用 `taskkill /F` 直接杀） |
| 端口 7239 冲突检测 + 明确提示 | ❌ |
| 崩溃自愈（某一半掉了自动拉起） | ❌ |
| 哨兵路径本身 | ❌ —— 结果托盘那处路径写歪了**两个月没人发现**（见 §6.5 与 `tray.ps1` 的 Stop-All 注释） |

**改之后**：一个入口、一份托盘代码，两种布局自动适配。

```
Start-CoRead.vbs （双击它；唯一的入口文件，检查+隐藏启动+失败弹窗都在里面）
   └─ powershell -File tray.ps1 -AppDir <包根> [-NodeExe <node.exe>]
```

**为什么入口是 `.vbs` 而不是 `.bat`**：`.bat` 必然被 cmd.exe 执行，而 cmd 是控制台程序 ——
双击一定闪一个黑窗口（旧版把 echo 与两处 `timeout` 放在 .bat 里，窗口停留约 8 秒）。
`.vbs` 由 `wscript.exe`（GUI 程序）执行，**零窗口**，托盘也因此能完全隐藏启动。
2026-10 之前那个 `01-START-CoRead.bat` 只是一行转交（实测仍要占 125 ms），
用户要求去掉数字前缀并删掉包装，于是入口现在就叫 `Start-CoRead.vbs`。

| | 便携包 | 开发目录 |
|---|---|---|
| 入口 | `<包根>\internal\Start-CoRead.vbs` | `<仓库根>\Start-CoRead.vbs`（同名） |
| tray.ps1 | `internal\tray.ps1` | `installer\launcher\tray.ps1`（同一份文件） |
| node | 自带 `internal\node.exe` | PATH 里的 `node` |
| 程序目录 | `internal\` | 仓库根 |
| 数据 | `<包根>\data\` | `<仓库根>\data\`（同一个相对位置） |

**两条判定规则互为镜像**，都只看一个信号：

- `tray.ps1`：程序目录里**有没有 node.exe** → 有 = 便携包 → 子进程脚本在 `internal\` 下
- `paths.js`：agent 的父目录**叫不叫 internal** → 是 = 便携包 → 数据在包根 `data\`

⚠️ **VBS 里 `progDir` 与 `appRoot` 必须分开**：前者是 tray.ps1/node.exe 所在处（包里 =
`internal\`），后者是包根（有 `data\`、`logs\` 的那层），`-AppDir` 只能传后者。
第一版把 `internal\` 当成了包根，表现是"托盘进程起来了、但日志不写、数据找不到"，
而且不报任何错 —— 靠桩脚本打印收到的参数才发现（实测记录见下）。

⚠️ **`.vbs` 有退场时间表**：VBScript 已在 2023-10 被微软废弃，三阶段退场
（Win11 24H2 起是"预装且默认启用"的可选功能 → 约 2027 默认禁用 → 未定日期彻底移除）。
换掉它的两条路都更贵：`.cmd` + PowerShell 会把黑框带回来；编无控制台的小 exe 会撞上
未签名的 SmartScreen 与杀软误报（正是删掉 Inno 安装包的原因）。所以现阶段保留 `.vbs`，
并在说明书里写了排查话术（"双击没反应 → 检查「可选功能」里有没有 VBScript"）。

**代价（明确接受）**：开发时 agent 也跑在后台，没有 `> ` 前台提示符；输出进
`logs\agent.out.log`。需要前台 REPL 时先从托盘退出、再单独 `node agent\index.js`。
换来的是"开发期每次起停都在跑生产代码路径"。

**实测验证**（2026-10-06）：

```
【开发布局】从仓库根双击 Start-CoRead.vbs（.vbs 本身不产生任何控制台窗口）
  tray.log        : 已启动（dev 布局，node = node）
  进程            : receiver\index.js + agent\index.js（都用 PATH 里的 node）
  端口 7239       : LISTENING
写 data\sessions\stop-request（等价托盘点退出）
  7 秒后 agent 自己退出，哨兵被它删掉
  agent.out.log   : 收到停止请求 → 正在固化本次会话记忆 → profile/soul 已合并重写 → 已保存
  data\profile\portrait.md / values-portrait.md 时间戳更新，并留下 .bak

【便携包布局】解压 zip 后双击包里的 internal\Start-CoRead.vbs（node.exe 与 tray.ps1 换成自证桩）
  桩收到的参数    : AppDir = <解压包根>（不是 internal\）、NodeExe = internal\node.exe
  桩自查          : data\ 在、logs\ 在、能写 logs\、builtin\ 在、extension\ 在
```

**顺带废掉的四个文件**：仓库根 `start.bat`、`stop.bat`（"清残留哨兵"的职责并入
`tray.ps1` 启动流程与 `paths.js` 统一路径）、`installer\launcher\run-hidden.vbs`
（职责被 `Start-CoRead.vbs` 取代）、以及两个 `01-START-CoRead.bat` 包装
（删掉数字前缀，入口直接就是 `Start-CoRead.vbs`）。

### 6.5 安装包（.exe / Inno Setup）路线已删除

**状态：这条路线已放弃，相关代码在 2026-10-06 从仓库里删掉了。**

删掉的文件（需要时从 git 历史恢复，删除前最后一次提交是 `498d8f5`）：

| 文件 | 当初的作用 |
|---|---|
| `installer/co-read.iss` | Inno Setup 安装脚本（向导 + 装插件教程页 + 升级保数据 + 卸载询问） |
| `installer/pack-portable.ps1` | 生成安装包用的暂存目录 |
| `installer/build-installer.bat` | 一键构建：读 manifest 版本 → 暂存 → 编译 |
| `installer/verify-installer.ps1` | 自检脚本：安装 → 核对 → 覆盖升级验数据 → 卸载 |
| `installer/launcher/.keep` | 占位文件（让安装包建出空的用户数据目录） |

**保留**的是两条分发链路都在用的那部分 `installer/launcher/`：`tray.ps1`、`stop.bat`、`api-config.template.json`、`LICENSE.node.txt`。

**为什么放弃**（两条，任一条都够）：

1. **被火绒 HIPS 拦截**。编译出来的 `CoRead-Setup-0.3.0.exe`（25.5 MB，编译本身是成功的）在这台机器上跑不起来，报 `Setup was unable to create the directory ...\Temp\is-XXXX.tmp`。根因是**未数字签名**，而代码签名证书约 100–400 美元/年。当前发**便携包 zip**就没有这个问题。
2. **用户还得手动装插件**。Chrome 的安全边界决定了"静默安装本地后端"做不到，所以安装包省下的只是"解压 + 双击"这两步，却要多养一套构建链路、一套 Inno 脚本、一套自检脚本，并长期承担签名费用与杀软误报。

**历史记录（这些坑是真的踩过，将来若恢复这条路线值得先看）**：

| 现象 | 根因 | 修法 |
|---|---|---|
| 安装包编译报 `Column 12` 语法错 | `.iss` 也需要 UTF-8 BOM，否则中文串被截断成非法引号 | 加 BOM |
| 编译报从 `installer\installer\...` 找不到文件 | `.iss` 的相对路径以**脚本所在目录**为基准，不是当前工作目录 | 把占位文件放进暂存目录再引用 |
| 安装静默失败（退出码 1、什么都不装） | 在 `InitializeWizard` 里展开 `{app}` 常量 → fatal 异常 | 改用 `CurPageChanged` 里赋值 |
| 编译报 `String error` | Pascal 用花括号作注释定界符，注释里写 `{app}` 会把注释提前闭合 | 注释里不写花括号常量名 |
| `SetClipboardText` / `GlobalAlloc` / `SizeOf(Char)` 不可用 | Inno 7 的 Pascal Script 没有这些 | 写临时文件 + PowerShell；用 `Length(S) * 2` |
| 自启项即使用户没勾也会写入 | `[Tasks]` 里 `autostart` 缺 `unchecked` | 补上 `unchecked` |
| 构建脚本认不出已安装的 Inno Setup | 只找了 6.x 路径，官方已出 7.1.0 | 6/7 路径都认 |
| **静默安装在自动化环境里跑不起来** | 二分定位到：极简安装包也失败、GUI 模式却正常 → 是环境干扰 GUI 子系统，**不是安装包的问题**。但因此这条链路始终没能自动验证 | 只能人工双击验证（现已无此必要） |
| `verify-installer.ps1` 报"用户数据全部保留 ✅"却是假阳性 | 第 1 步安装失败后脚本继续往下跑，那步验的数据其实写在未被覆盖的目录里 | 加门：安装失败立即中止 |

### 6.6 便携包链路的构建坑（记录备查）

| 现象 | 根因 | 修法 |
|---|---|---|
| `git add` 被拒 | 早先的 `.gitignore` 规则 `*.diag-*.mjs` 误伤了正式工具 `chat.db.diag-wal.mjs` | 改成只忽略点开头的临时文件 |
| `.ps1` 中文全乱、语法崩 | Windows PowerShell 5.1 把无 BOM 的 UTF-8 当系统 ANSI(GBK) 读 | 给所有 `.ps1` 加 UTF-8 BOM |
| zip 校验假报"缺 data\config\" | **只有空目录才会在 zip 里有条目**，有内容的目录不单独出现 | 校验清单里改写成目录内的具体文件名 |
| 打包中途被自己的闸门拦下 | 数据目录搬到 `data\` 后，闸门还在按旧路径判断"这一格应该全空" | 闸门跟着更新：放行空模板与说明文件，其余一律中止 |
| 本地包比 CI 包多文件 | `agent/scripts/data/` 被 `.gitignore` 排除，本地有、CI 没有 | 白名单只留通用文件，并对 `builtin\` 里的图谱逐个做 SHA256 比对 |

### 6.8 其余待办

- [ ] **验证非商店扩展能否自动更新**（`update_url` + `--extensions-update-frequency`）——这一步结果决定要不要回头补商店
- [ ] Windows SmartScreen：未签名会有警告，考虑代码签名证书（约 100–400 美元/年）
- [ ] 托盘换成正式 exe（现在是 PowerShell 版，架构已留好接口）

---

## 七、原待决策（部分已由第六节取代）

- [x] ~~走哪条路（C / B / A / C+B 并行）~~ → 走"本机后端 + 用户自带 API Key"，界面留在用户浏览器
- [x] ~~Electron 还是 Tauri~~ → 都不需要（无界面，无需 WebView）
- [ ] 若走路 B：轻量版叫什么名字、是否与主产品共用 branding
