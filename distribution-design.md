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
- ❌ 缺图标（`manifest.icons` 是 `null`，目录里一个图标文件都没有）
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

盲拷整个目录会**把开发机上的个人数据一起打包**——实测中第一次就误带进了 12 本真实书籍、聊天库、API Key。正确的包含/排除清单：

| 必须带上 | 必须排除 |
|---|---|
| `node.exe` + Node 自己的 LICENSE | `agent/.env`、`agent/api-config.json`（含 API Key 明文） |
| `agent/index.js`、`agent/package.json`、`agent/lib/`、`agent/.env.example` | `agent/data/`（用户数据：图谱、画像、对话）——**建空目录** |
| `agent/scripts/data/`（图谱回退源、演示图，**运行时会被读**） | `agent/scripts/` 下其余文件（开发脚本，4.2 MB） |
| `receiver/index.js`、`package.json`、`graph-data.js` | `receiver/books/`、`receiver/inbox/`、`receiver/toolbox/`——**建空目录** |
| `extension/`（排除 `test/`） | `agent/test/`、`agent/*.md`、`*.bak*`、`*.out` |

**⚠️ 升级时的红线**：安装包升级只能覆盖程序文件，**绝对不能碰** `agent/data/`、`receiver/books/`、`receiver/inbox/`、`receiver/toolbox/`。否则一次升级就把读者几个月的阅读记录和聊天历史清空。

### 6.5 安装包已实现（Inno Setup）

安装包已经写好并**编译通过**，产物 `installer/build/out/CoRead-Setup-0.3.0.exe` = **25.5 MB**（94.3 MB 压到 25.5 MB，压缩率 73%，LZMA2/max）。

**文件构成**：

| 文件 | 作用 |
|---|---|
| `installer/co-read.iss` | Inno Setup 脚本（安装向导 + 装插件教程页 + 升级保数据 + 卸载询问） |
| `installer/pack-portable.ps1` | 生成干净的暂存目录（含**敏感数据闸门**，检出个人数据就中止） |
| `installer/build-installer.bat` | 一键构建：读 manifest 版本 → 暂存 → 编译 |
| `installer/launcher/tray.ps1` | 托盘程序（PowerShell + WinForms，零额外依赖）：启动/停止两个进程、状态显示、崩溃自愈、开机自启 |
| `installer/launcher/run-hidden.vbs` | **无窗口启动器**——这是"读者看不到黑窗口"的实现点 |
| `installer/launcher/stop.bat` | 停止脚本（先写 `.stop` 哨兵让 agent 优雅保存记忆） |
| `installer/launcher/api-config.template.json` | API 配置模板（空值，避免把开发机的 Key 带出去） |
| `installer/verify-installer.ps1` | 自检脚本：安装 → 核对 → **覆盖升级验数据** → 卸载，六步全自动 |

**关键设计（都踩过坑才定下来）**：

1. **装到用户目录、不需要管理员**（`PrivilegesRequired=lowest`）。因为程序要往安装目录写运行时数据（`agent/data`、`receiver/inbox`）。
2. **升级绝不覆盖用户数据**：`agent/data`、`agent/api-config.json`、`receiver/inbox`、`receiver/books`、`receiver/toolbox` 用 `onlyifdoesntexist` 创建，升级时一律跳过。
3. **卸载询问是否删数据**，默认保留；另支持 `/KEEPUSERDATA` 静默保留。
4. **托盘而不是命令行**：读者不会看到 `> ` 提示符；用 VBS 隐藏启动 PowerShell，连窗口闪一下都没有。
5. **版本号从 `extension/manifest.json` 读**，插件与安装包版本永不脱节。

### 6.6 构建过程中修掉的坑（记录备查）

| 现象 | 根因 | 修法 |
|---|---|---|
| `git add` 被拒 | 早先的 `.gitignore` 规则 `*.diag-*.mjs` 误伤了正式工具 `chat.db.diag-wal.mjs` | 改成只忽略点开头的临时文件 |
| `.ps1` 中文全乱、语法崩 | Windows PowerShell 5.1 把无 BOM 的 UTF-8 当系统 ANSI(GBK) 读 | 给所有 `.ps1` 加 UTF-8 BOM |
| 编译报 `Column 12` 语法错 | 同上，`.iss` 也需要 BOM，否则中文串被截断成非法引号 | 加 BOM（构建脚本会保证） |
| 编译报从 `installer\installer\...` 找不到文件 | `.iss` 的相对路径以**脚本所在目录**为基准，不是当前工作目录 | 把占位文件放进暂存目录再引用 |
| 安装静默失败（退出码 1、什么都不装） | 在 `InitializeWizard` 里展开 `{app}` 常量 → fatal 异常 | 改用 `CurPageChanged` 里赋值 |
| 编译报 `String error` | Pascal 用花括号作注释定界符，注释里写了 `{app}` 把注释提前闭合 | 注释里不写花括号常量名 |
| `SetClipboardText` / `GlobalAlloc` 不可用 | Inno 7 的 Pascal Script 没有这些 | 改为写临时文件 + PowerShell `Set-Clipboard` |
| `SizeOf(Char)` 报 Type mismatch | Pascal Script 没有 `Char` 类型 | 改用 `Length(S) * 2` |
| 自启项即使用户没勾也会写入 | `[Tasks]` 里 `autostart` 缺 `unchecked` | 补上 `unchecked` |
| 构建脚本认不出已安装的 Inno Setup | 只找了 6.x 路径，而官方已出 7.1.0 | 6/7 路径都认 |

### 6.7 还没验证的部分（如实记录）

#### 静默安装在自动化环境里跑不起来（已定位到环境，不是安装包的问题）

实测现象：**Inno 编译出的安装程序，在这个 DSH 会话里无法以静默模式运行**。退出码 1、不生成日志、不创建目录，即"在写下第一行日志之前就被终止"。

做了完整的二分定位：

| 测试 | 结果 |
|---|---|
| 编译安装脚本 | ✅ 成功（25.5 MB） |
| 安装包文件完整性（MZ 头、大小、无 Zone.Identifier 互联网标记） | ✅ 正常 |
| 编译一个**全新极简安装包**（不装文件、不写注册表、不启动进程） | ✅ 编译成功 |
| 运行那个极简安装包（静默） | ❌ **同样失败** |
| **不带参数运行（GUI 模式）** | ✅ **能正常启动并保持运行** |
| 参数逐项测试 | 不稳定：`/VERYSILENT` → 卡住；`/VERYSILENT /NORESTART` → 退出码 1 |

**判定依据**：连"什么都不做"的极简 Inno 安装包都以同样方式失败，说明与安装脚本的配置无关；而 GUI 模式能正常起来，说明安装包本身是好的。同一 exe 在"卡住"与"退出码 1"之间摇摆，是环境干扰 GUI 子系统的特征。

**结论**：这是自动化环境的限制，**不能据此判定安装包有问题，但也不能算已验证**。

#### 因此下面三条仍未实测

- [ ] 安装向导的"装插件教程页"实际长什么样、按钮能否打开 `chrome://extensions`
- [ ] 完整安装 → 覆盖升级 → 数据保留 → 卸载 全流程
- [ ] 托盘程序实际运行效果（图标、菜单、崩溃自愈）

#### 正确的验证方式

**不要依赖静默模式**——直接双击安装包走向导，这是最可靠的验证路径：

```
installer\build\out\CoRead-Setup-0.3.0.exe
```

看三件事：① 向导能正常走完；② 最后一页的"装插件四步教程"是否清楚、两个按钮是否可用；③ 装完托盘图标是否出现。

如果双击也没反应，那就是机器上有安全软件在拦（Windows Defender / 其他杀软 / 组策略），那是另一类问题。

#### verify-installer.ps1 的已知缺陷（已修）

第一版有个会误导人的问题：**第 1 步安装失败后它继续往下跑**，导致第 4 步"用户数据全部保留 ✅"成为假阳性——那份数据其实写在未被安装覆盖的目录里，跟"升级保数据"无关。实测被这个假阳性骗过一次。

现已加门：**安装失败立即中止**，并打印排查线索（目录是否创建、日志是否生成、日志尾部），不再产出误导性结论。同时把 `/TASKS=`（空值）改为 `/TASKS=desktopicon`（一个无害的任务名）——空值在某些环境下会让安装程序行为异常。

### 6.8 其余待办

- [ ] 装插件教程页补**截图**（现在只有文字步骤；图文并茂是读者能否走完的决定性因素）
- [ ] **验证非商店扩展能否自动更新**（`update_url` + `--extensions-update-frequency`）——这一步结果决定要不要回头补商店
- [ ] Windows SmartScreen：未签名会有警告，考虑代码签名证书（约 100–400 美元/年）
- [ ] 托盘换成正式 exe（现在是 PowerShell 版，架构已留好接口）

---

## 七、原待决策（部分已由第六节取代）

- [x] ~~走哪条路（C / B / A / C+B 并行）~~ → 走"本机后端 + 用户自带 API Key"，界面留在用户浏览器
- [x] ~~Electron 还是 Tauri~~ → 都不需要（无界面，无需 WebView）
- [ ] 若走路 B：轻量版叫什么名字、是否与主产品共用 branding
