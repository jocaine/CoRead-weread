# 给 AI 编码助手的约定

本文件是**人类维护者**（CoRead 作者）对 AI 助手的要求，不是运行时给共读 agent 的行为规则。
共读 agent 的人格与对话规则在 `agent/AGENT.md`，两者不要混。

---

## 表达约定（最高优先级）

**凡是使用专业术语，必须在同一处、当场把它讲清楚。不允许只丢名词。**

这条没有例外：不要假设对方知道，也不要因为"这是常识"就跳过。用户是产品与设计的决策者，
需要看懂每个结论才能拍板；看不懂的名词会让整段说明失效。

具体要求：

1. **首次出现的术语 → 立刻用大白话解释**：它是什么、为什么需要它、在我们这个项目里具体指哪一行/哪个文件。
2. **用项目里的真实证据讲**，不要泛泛而谈。例：说"WAL 里还有未合并的写入"，就报出
   `chat.db 2896 KB` / `chat.db-wal 277.6 KB`，并指出主库比 WAL 旧了 33 分钟——让抽象概念落到一个能看见的数上。
3. **讲影响，不只讲定义**。用户真正要判断的是"这会不会让我丢数据 / 变慢 / 出故障"。
4. **中英混排的术语保留英文原词，但后面必须跟中文解释**（如 `checkpoint（把日志搬回主库的动作）`）。
5. **结论先行**：先说会怎样，再说为什么，最后才说机制细节。
6. **不要为了显得专业而堆术语**。能用"每次写入都要落一次磁盘"说清的，就不要写 "per-transaction fsync"。

### 反面例子

> 开了 WAL，`chat.db` + `chat.db-wal` + `chat.db-shm` 是一套，只备份单个 `.db` 会丢最近写入。

（问题：WAL / shm 是什么、为什么会丢、丢多少，全没说。）

### 正面例子

> 现在 `chat.db` 比 `chat.db-wal` 旧了 33 分钟。`-wal` 是"新数据的暂存区"：写入先落这里，
> 攒够了才搬回主库。所以此刻只拷 `chat.db`，那 33 分钟的对话不在里面。

---

## 回答技术问题时的其他要求

- **先读代码再下结论**。引用具体文件与行号（如 `agent/lib/chat-store.js:340`），不要凭文件名猜实现。
- **区分"设计如此"与"真实缺口"**。发现缺口要明说，并给出最小修复方案；不要替现状粉饰。
- **修正自己此前说错的话要显式说明**（"我上一轮说得不准，实际是……"），不要悄悄改口。
- **不要美化数字**。体积、行数、耗时按实测报，并说明统计口径（哪些算进去、哪些没算）。

---

## 改文件时的硬约束（都踩过，别再踩）

### 1. `.ps1` 改完必须确认还有 UTF-8 BOM

Windows PowerShell 5.1 把**无 BOM 的 UTF-8 当系统 ANSI（中文 Windows 是 GBK）**解析，
脚本里的中文注释会整体乱码、语法当场崩，而且报错行号完全对不上（实测：中文注释被当成
没闭合的字符串，错误报在十几行之后）。

**编辑器的"保存"经常把 BOM 吞掉**——本仓库已因此踩过三次。所以：

```
改完 .ps1 之后，永远跑一次检查：
  $b=[IO.File]::ReadAllBytes($f)
  ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)   # True 才算好
补 BOM：
  [IO.File]::WriteAllBytes($f, ([byte[]](0xEF,0xBB,0xBF) + $b))
```

`installer/pack-portable-zip.ps1` 开头已加**闸门**：仓库里任何 `.ps1` 缺 BOM，打包直接中止。
`.iss`（Inno 脚本）同样需要 BOM——该链路已删除，但若恢复要记得。

### 2. `.bat` / `.vbs` 里绝不能写中文（连注释也不行）

cmd.exe 与 Windows Script Host 按**系统 ANSI**（中文 Windows 是 GBK）读文件，
非 ASCII 会变乱码；更糟的是 cmd **边读边执行**，乱码行会被当成命令去跑。
实测踩过：一句中文注释被拆成 `'is' is not recognized`、`'step' is not recognized` 满屏报错。

所以这两个扩展名的文件一律**纯 ASCII**，中文说明写到 `.txt` / `.md` 里
（`installer\portable\instructions-zh.txt` 就是为此存在的）。

`installer/pack-portable-zip.ps1` 开头有闸门：仓库里任何 `.bat` / `.vbs` 含非 ASCII 字节，
打包直接中止（`.ps1` 的 BOM 也有同样的一道闸门）。**这两道闸门只覆盖打包时**——
`Start-CoRead.vbs` 与 `internal\*.bat` 都会进包，所以它们受管；
但你自己写的中文注释一旦混进去，报错会在**运行脚本的那一刻**出现，很吓人。

### 3. 不要用 `Get-Content` / `Set-Content` 读写本仓库的源文件

`agent/`、`receiver/`、`extension/` 下的 `.js` 是**无 BOM 的 UTF-8**。
PowerShell 5.1 的 `Get-Content -Raw` + `Set-Content` 会按 GBK 解码再写回，
**中文注释全部变成乱码、行尾也变**（实测把 `receiver/index.js` 从 1395 行写成 1224 行，
只能 `git checkout` 重来）。批量替换请用按 UTF-8 处理的编辑工具，或 `node` 脚本。

### 4. 改数据路径只改一个地方

`agent/lib/paths.js` 是**全项目唯一的路径真源**——agent、receiver、脚本全部 import 它。
不要在任何文件里再写 `path.join(__dirname, ...)` 去拼数据路径。
停机哨兵（`STOP_FILE`）另有两处**必须同步**（它们不是 Node，读不到 `paths.js`）：
`installer/launcher/tray.ps1:141` 与 `installer/launcher/stop.bat:22`。
改完搜一遍 `stop-request` 确认没有第三处 —— 2026-10 就是因为只改了托盘那处，
导致开发脚本长期删/写一个不存在的旧文件。

### 5. 启动入口只有一个：`Start-CoRead.vbs`（开发与发行共用，都在 `internal\` 或仓库根）

2026-10 起，仓库根与便携包 `internal\` **各有一个同名入口** `Start-CoRead.vbs`，
双击它启动。它自己干全部活：检查目录与 node → 隐藏启动 `tray.ps1` → 确认起来了，
失败用 `MsgBox` 报错。

```
Start-CoRead.vbs
   └─ powershell -File tray.ps1 -AppDir <包根> [-NodeExe <node.exe>]
        （开发：tray 在 installer\launcher\ 下；便携包：在 internal\ 下）
```

**为什么是 `.vbs` 而不是 `.bat`**：`.bat` 必被 cmd.exe 执行，而 cmd 是控制台程序 ——
双击必然闪一个黑窗口。`.vbs` 由 `wscript.exe`（GUI 程序）执行，**零窗口**。
2026-10 之前有个 `01-START-CoRead.bat` 做包装，已删除：它没有任何功能，
只是加回 125 ms 的闪窗。

**代价（明确接受）**：给用户的第一页要写"双击 `internal\Start-CoRead.vbs`"——
`.vbs` 是个陌生扩展名，所以 `README-FIRST.txt` 里专门解释了一句它是什么、为什么不是 .bat。

- **便携包**：传 `internal\node.exe`；程序在 `internal\` 下
- **开发目录**：不传 node（托盘用 PATH 里的）；程序就在仓库根下
- 判定规则唯一一条：**程序目录里有没有 node.exe**（`tray.ps1:44`）
- 数据路径那条规则与之对称：见 `lib/paths.js` 的 `PARENT_NAME === 'internal'`

⚠️ **VBS 里 `progDir` 与 `appRoot` 是两个不同的目录，别混**（这个文件就这么错过一次）：
`progDir` 是 tray.ps1 与 node.exe 所在处（包里 = `internal\`），
`appRoot` 是**包根**（有 `data\`、`logs\` 的那层），`-AppDir` 必须传 appRoot。
传错的表现是"托盘起来了但日志不写、数据找不到"，而且**不会报错**。

⚠️ **命名不要去加数字前缀**：曾用过 `01-START-CoRead.bat`（`01-` 是为了排在资源管理器
最前面）。用户明确要求去掉这个前缀，所以现在叫 `Start-CoRead.vbs`，
在根目录里按自然排序落在中部 —— 靠 `README-FIRST.txt` 指路，不靠文件名排序。

**为什么强制统一**：开发期因此跑的是与发行版**完全一样**的启动/停机路径
（写哨兵 → 等 agent 自退 → 关库、端口冲突检测、崩溃自愈）。这些以前在开发时走不到，
所以"托盘退出的哨兵写错地方、导致从来没有优雅过"这种 bug 能藏两个月。

**代价（明确接受）**：开发时 agent 也跑在后台、没有 `> ` 前台提示符。
要看输出就读 `logs\agent.out.log`；确实需要前台 REPL 做临时调试时，
先从托盘退出，再单独 `node agent\index.js`。
**不要为了"方便看输出"再写一个前台启动脚本** —— 那正是被废掉的老 `start.bat` 的路子。

### 6. `.vbs` 有退场时间表，别把它当成永久方案

VBScript 2023-10 被微软废弃，走三阶段：**阶段 1**（Win11 24H2 起）变成"可选功能"但
**预装且默认启用** → **阶段 2**（约 2027）默认禁用、需用户手动安装 → **阶段 3**（未定）
彻底移除。参考先例：同样降级为可选功能的 WMIC 已在 2026-08 彻底移除。

所以：`Start-CoRead.vbs` 在 Win10 和现役 Win11 上都正常，但**将来某天会静默失效**
（双击无反应 —— 最难排查的故障形态）。真要换时的三个方向与代价：

| 方向 | 代价 |
|---|---|
| 改用 `.cmd` + PowerShell 隐藏启动 | 黑框回来（cmd 是控制台程序）|
| 编一个无控制台的小 `winexe` | 未签名 exe 会撞 SmartScreen + 火绒误报（正是删掉 Inno 安装包的原因）|
| 继续用 `.vbs` | 2027 后新装机器上要用户手动启用该可选功能 |

已在 `README-FIRST.txt` 与 `instructions-zh.txt` 里写了排查话术：
"双击没反应 → 看设置 → 系统 → 可选功能里有没有 VBScript"。

### 7. 过程性文件一律放 `devdata\`，不许写在仓库根

**规矩**：只为一件事服务、用完就没用的文件——临时脚本、诊断输出、DOM 转储、跑批产物、截图、
审计中间件、一次性数据抽取——**都不许直接写在仓库根目录**。统一落在 `devdata\` 下：

- `devdata\` 顶层：跑批脚本按**固定文件名**读写的产物（清单见 `devdata\README.txt`）。路径是约定，别挪。
- `devdata\scratch\`：其它一切临时东西（脚本、输出、截图、抽取结果）。按需新建，随便放。

**为什么**：仓库根是"打开项目第一眼看到的东西"，应该只剩程序、文档、入口。
2026-10 清理时根目录攒了 8 件这类东西（`.diag3.cjs`、`.xzg-topo.cjs`、`_dom.txt`、`c.out`、
`sse.out`、`receiver.out`、`.review5\`、`.playwright-mcp\`，共 267 KB）——**每一件都要先判断能不能删**，
因为它们全被 `.gitignore` 排除，删错了没有 git 历史可救。放进 `devdata\` 就没有这个判断成本。

**`devdata\` 为什么是安全的落点**（三条同时成立，别的目录没有这个组合）：
1. 打包白名单不碰它 → 不会被寄给用户（这条有血的教训：作者的私人图谱曾被本地打包带出去过）；
2. `.gitignore` 排除 `devdata/*`、只留 `README.txt` → 不会被误提交；
3. 它不在 `agent\` / `receiver\` / `extension\` 里 → 不会被"整目录拷"捎带。

**故意不给它加 `.gitignore` 忽略规则**：根目录若冒出未跟踪文件，`git status` 会显示出来——
**那正是提醒信号**（同 `agent/scripts/data/` 那条的理由）。忽略掉等于把垃圾藏起来，
而"攒了一堆没人管的垃圾"正是 2026-10 两次清理的起因。代价是手滑 `git add -A` 时它会被提交；
取"看得见"舍"防手滑"，因为误提交可以 `git rm --cached` 补救，而攒了半年的垃圾没人会想起来清。

