# 发版流程

## 版本号在哪

**唯一真源：`extension/manifest.json` 里的 `version`。**

改这一个数字就够了，其它地方都会跟着走：

| 谁读它 | 用途 |
|---|---|
| Chrome | 判断插件要不要更新（**数字不变，用户浏览器就不会更新**） |
| `pack-portable-zip.ps1` | 生成的 zip 名字，如 `CoRead-0.3.1-portable.zip` |
| GitHub Actions | 校验 tag 与它是否一致，不一致直接报错 |

### 怎么进位

| 改了什么 | 新版本 |
|---|---|
| 修 bug、改文案、微调 | `0.3.0` → `0.3.1` |
| 加了新功能 | `0.3.1` → `0.4.0`（末位归零） |
| 大改、不兼容 | → `1.0.0` |

---

## 推荐流程：推 tag 自动发版

```powershell
# 1. 改 extension/manifest.json 里的 version，比如 0.3.0 → 0.3.1
# 2. 提交
git commit -am "release: v0.3.1"
# 3. 打 tag 并推送
git tag v0.3.1
git push origin main --tags
# 4. 完事
```

推上去之后 `.github/workflows/release.yml` 会自动：
打包便携包 → 校验 tag 与 manifest 版本一致 → 建 Release → 上传 zip。

---

## 仓库与远程（fork 工作流）

这个仓库是 **fork**：上游是 `lexielin99-code/CoRead-weread`，
自己的 fork 是 `jocaine/CoRead-weread`。

```
origin    → https://github.com/jocaine/CoRead-weread.git          （自己的 fork，推送目标）
upstream  → https://github.com/lexielin99-code/CoRead-weread.git  （上游，只读）
```

| 想做什么 | 命令 |
|---|---|
| 推自己的改动 | `git push origin main` |
| 拉上游的新提交 | `git fetch upstream && git merge upstream/main` |
| 给上游提改动 | 在 GitHub 上开 Pull Request（fork → upstream） |

CI 与 Release 都跑在**自己的 fork** 上，页面上看：
https://github.com/jocaine/CoRead-weread/actions

### 本仓库的 git 配置里有两条"解药"，别删

这台机器的全局 gitconfig 里有一条加速规则：

```ini
[url "https://gitclone.com/"]
	insteadOf = https://
```

它把所有 `https://` 地址改写成 `gitclone.com`（只读镜像），后果是**推送必然 502**。
（顺带说明：这个镜像只支持读取，不支持推送。）

**实测结论：`insteadOf` 是"最长匹配前缀优先"，所以仓库级的规则能盖住全局的。**
本仓库的 `.git/config` 里因此放了两条针对性配置：

```ini
; 用一条更长的、指向自己的规则盖住全局改写 → 推送才走 GitHub 真身
[url "https://github.com/jocaine/CoRead-weread"]
	insteadOf = https://github.com/jocaine/CoRead-weread

; 这台机器直连 github.com:443 不通（Ping 通但 TLS 被重置），走本地代理
[http "https://github.com"]
	proxy = http://127.0.0.1:7897
```

**换了新机器/新克隆要重新加这两条**，否则会看到 gitclone 的 502 或
`Failed to connect to github.com port 443`。

> 曾考虑过的两个办法都**实测无效**，别再试：
> · 命令行写完整地址（`git push https://github.com/...`）——`insteadOf` 对命令行
>   给的地址**同样生效**，照样被改写到镜像
> · 在仓库里加"把 github 映射成它自己"的更短前缀——`insteadOf` 是前缀替换，
>   全局规则先把 `https://` 换掉了，后面再匹配已经没意义

**去 https://github.com/jocaine/CoRead-weread/actions 看进度**，
失败的话日志里会写清哪一步出错。

> 目前这条链路**尚未实跑验证过**（写好后还没推过 tag）。第一次推 tag 时留意一下
> Actions 页面，如果报错把日志发出来。

---

## 本地手动打包（不开 CI 时）

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File installer\pack-portable-zip.ps1

# 产出：installer\build\out\CoRead-<版本>-portable.zip
```

然后去 https://github.com/jocaine/CoRead-weread/releases/new
建 Release：填 tag（`v0.3.1`）、标题、说明，把 zip 拖进附件区，发布。

### 打包脚本的可选参数

| 参数 | 用途 |
|---|---|
| `-NodeDir <目录>` | 用一个已含 `node.exe` 的目录，**不联网下载**（CI 用这个） |
| `-NodeVersion v24.15.0` | 指定要下载的 Node 版本 |
| `-OutDir <目录>` | 换输出目录 |
| `-WriteFolderLabels` | 生成 desktop.ini 中文显示名（**仅对自解压包有意义**，zip 解压会丢属性，见下） |

### 打出来的包里有什么

```
CoRead-<版本>-portable\
├── README-FIRST.txt         一分钟上手
├── data\                    用户数据（空壳 + README.txt + config\api-config.json 空模板）
├── extension\               浏览器插件
├── internal\                程序本体 + 双击入口
│   ├── Start-CoRead.vbs        ★用户双击这个启动（为什么不是 .bat 见下）
│   ├── node.exe  tray.ps1  stop.bat  unblock.bat  instructions-zh.txt
│   └── agent\  receiver\
├── builtin\                 内置图谱（knowledge-graph-results/demo.json）
└── logs\                    空目录（托盘与子进程的日志）
```

**入口为什么是 `.vbs` 而不是 `.bat`**：`.bat` 必被 cmd.exe 执行，而 cmd 是控制台程序 ——
双击一定闪黑窗口（旧版还会停 8 秒）。`.vbs` 由 `wscript.exe`（GUI 程序）执行，
零窗口，托盘因此能完全隐藏启动。2026-10 起删掉了 `01-START-CoRead.bat` 那层包装
与数字前缀。

脚本里三道闸门会在打包**中途失败**（不是打完才发现）：**`.ps1` 的 UTF-8 BOM 检查**、
**`.bat`/`.vbs` 纯 ASCII 检查**，以及**敏感数据闸门**
（`*.db`、`*.jsonl`、`*.env`、含 `sk-` 的配置、`data\` 下任何文件）。
zip 校验清单里现在包含 `internal\Start-CoRead.vbs`、`data\README.txt` 与 `data\` 各格，
少了会报 MISS。

### 本地怎么跑开发版

**和便携包同一个入口，同一个托盘**（2026-10 统一，理由见 `distribution-design.md` §6.4c）：

```powershell
# 在仓库根
.\Start-CoRead.vbs           # 双击也行：起托盘 + receiver + agent，全程后台、零窗口
# 退出：右键托盘图标 → 退出 CoRead（会先让 agent 保存记忆）
```

差异只有两处，由 `tray.ps1` 自动判断（判定信号：程序目录里有没有 `node.exe`）：

| | 便携包 | 开发目录 |
|---|---|---|
| node | 自带 `internal\node.exe` | PATH 里的 `node` |
| agent 输出 | `logs\agent.out.log` | 同样 `logs\agent.out.log` |

开发时**没有** `> ` 前台提示符（刻意如此：让开发也走生产那条启停路径）。
临时要看前台 REPL 时，先从托盘退出，再单独 `node agent\index.js`。

### 下载不动 node.exe 时

官方分发包在 GitHub 上，国内偶尔慢。设一个镜像前缀即可：

```powershell
$env:COREAD_NODE_MIRROR = 'https://registry.npmmirror.com/-/binary/node'
powershell -ExecutionPolicy Bypass -File installer\pack-portable-zip.ps1
```

CI 里则在仓库 Settings → Secrets and variables → Actions → Variables
加一个名为 `COREAD_NODE_MIRROR` 的变量，值同上。

---

## ⚠️ 打包时最容易踩的三件事

1. **不要在 `installer\build\` 里运行 CoRead。**
   那是构建目录，每次打包都会被清空——你从那里跑，程序会被删、聊天记录会留在
   一个"随时会消失"的地方，而且打包时文件被占用会直接失败。
   打包脚本会检测并拦住这种情况，但最好养成习惯：**包只在这里产出，运行请解压到别处**
   （比如 `D:\CoRead`）。

2. **不要把私人数据打进包。**
   `pack-portable-zip.ps1` 用的是白名单（逐个文件指定），并且有一道敏感数据闸门：
   发现 `*.db` / `*.jsonl` / `api-config.json` 里有密钥等情况会**直接中止**。
   如果你新增了需要随包分发的文件，记得加进白名单，否则它不会进包。

3. **`.bat` 与 `.vbs` 的执行部分必须纯 ASCII。**
   cmd 与 Windows Script Host 都按系统 ANSI（中文 Windows 是 GBK）读取，
   UTF-8 中文会变乱码；cmd 还是边读边执行，文中途 `chcp 65001` 会让解析错位、
   把乱码当命令执行。中文说明一律放 `.txt`。
   打包脚本会自动检查这一条，违规就中止。

---

## 已知限制

### zip 解压会丢掉文件夹属性

所以 `desktop.ini` 那套"中文显示名"在 zip 分发下**不生效**：资源管理器解压、
`Expand-Archive`、Shell COM 三种方式都会把文件夹属性重置成普通 Directory，
desktop.ini 于是不被读取。

更麻烦的是属性丢失后 desktop.ini 会从"隐藏"变成**可见**，用户解压完看到一堆
莫名其妙的 desktop.ini，比不加更乱。所以默认**不生成**它们
（`-WriteFolderLabels` 开关保留，给将来的自解压包用——那种能跑"解压后脚本"补属性）。

### 数据目录在包根 `data\`（2026-10 重构）

数据路径的**唯一真源是 `agent/lib/paths.js`**——agent、receiver、脚本全部 import 它，
不再各自 `path.join(__dirname, ...)`。落点：

```
<包根>\data\config\     设置：API 地址、模型名、密钥（含密钥明文）
<包根>\data\profile\    阅读画像、价值观侧写、知识图谱、冷启动标记
<包根>\data\sessions\   聊天库 chat.db、会话流水账、游标、讨论栈、停机哨兵
<包根>\data\reading\    划线标注、书库缓存（读过的章节原文）
<包根>\data\runtime\    处理状态（可随时删，启动自动重建）
<包根>\data\toolbox\    翻译记录
<包根>\builtin\         随包分发的内置图谱（不是用户数据，不参与备份）
<包根>\logs\            日志
```

打包时**建空目录即可**，升级时**绝不能覆盖**（升级只覆盖程序文件，`data/` 归用户）。

`paths.js` 怎么判断包根：看 agent 是不是装在 `internal\` 下——是，则包根 = 上一级
（便携包布局）；不是，则包根 = 仓库根（开发布局）。两种布局共用同一份代码路径，
不需要环境变量、不需要构建期改写。

> 历史（别再照做）：改造前数据散在 `internal\agent\data`、`internal\agent\`（根目录）、
> `internal\receiver\inbox|books|toolbox` 五处，备份方式写的是"拷整个程序文件夹"。
> 实测代价：用户要把数据搬到新版本时得读源码才知道该拷哪些，漏拷 `chat.db` 就是空历史；
> 只补拷主库、留着旧库的 `-wal`，SQLite 会把新库回滚成空库（941 条 → 0 条，实测复现）。
> 完整记录见 `distribution-design.md` §6.4b。

### 老用户升级：跑一次迁移

```powershell
node internal\agent\scripts\migrate-data-layout.mjs           # 演练，只打印计划
node internal\agent\scripts\migrate-data-layout.mjs --apply   # 真搬
```

规矩：先复制 → 校验字节数 → 通过才删源；关键文件（chat.db、图谱、讨论栈）留
`.pre-migrate` 备份。跑之前必须完全退出 CoRead，否则文件被占用会失败（脚本会报出来）。
agent 启动时会自动体检（`detectUnmigrated()`），发现旧数据没搬会在日志里提示——
**不能指望用户自己发现"记录变空了"**。

### 只发便携包（.exe 安装包路线已删除）

**分发包只有一种形态：`CoRead-<版本>-portable.zip`。** 用户解压后双击 `internal\Start-CoRead.vbs` 即可，
不需要安装、不需要管理员权限。

曾经有过一条 Inno Setup 的 `.exe` 安装包路线，2026-10-06 连同脚本一起删掉了
（`co-read.iss`、`pack-portable.ps1`、`build-installer.bat`、`verify-installer.ps1`）。
原因两条：① 未数字签名，编译出来的安装程序被火绒 HIPS 拦（报
`Setup was unable to create the directory ...\Temp\is-XXXX.tmp`），而代码签名证书要 100–400 美元/年；
② 它省下的只是"解压 + 双击"两步——装插件那步无论如何都得用户手动做（Chrome 不允许静默安装本地后端）。

需要恢复时从 git 历史取，删除前最后一次提交是 `498d8f5`；当年踩过的坑与验证结论
记在 `distribution-design.md` §6.5，恢复前值得先读。
