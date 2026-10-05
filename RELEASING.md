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

**去 https://github.com/lexielin99-code/CoRead-weread/actions 看进度**，
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

然后去 https://github.com/lexielin99-code/CoRead-weread/releases/new
建 Release：填 tag（`v0.3.1`）、标题、说明，把 zip 拖进附件区，发布。

### 打包脚本的可选参数

| 参数 | 用途 |
|---|---|
| `-NodeDir <目录>` | 用一个已含 `node.exe` 的目录，**不联网下载**（CI 用这个） |
| `-NodeVersion v24.15.0` | 指定要下载的 Node 版本 |
| `-OutDir <目录>` | 换输出目录 |
| `-WriteFolderLabels` | 生成 desktop.ini 中文显示名（**仅对自解压包有意义**，zip 解压会丢属性，见下） |

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

### 数据目录跟着代码走

数据路径是代码里写死的（`agent/index.js` 用 `__dirname`、`receiver/index.js` 用
`__dirname/inbox`），所以它们在：

```
internal\agent\data\        阅读画像、知识图谱、API 配置
internal\receiver\inbox\    聊天记录、标注
internal\receiver\books\    书库缓存
internal\receiver\toolbox\  翻译记录
```

曾考虑把数据挪到根目录一个显眼的 `data\`，但那需要给代码加环境变量、改 16 处路径；
用目录联接（junction）又会让"备份只拷 data\"落空。最后选择**如实呈现**：
说明书直接写明位置，备份方式是"拷整个程序文件夹"——不多造一层抽象，
也不放会误导人的空壳目录。

### 安装包（.exe）暂不可用

`installer/co-read.iss` 那套 Inno Setup 安装包能编译出来，但**被火绒 HIPS 拦截**
（报 `Setup was unable to create the directory ...\Temp\is-XXXX.tmp`）。
根因是未数字签名。所以当前只发便携包。

将来若拿到代码签名证书（参考 SignPath Foundation 对开源项目免费，
但要求项目已有一定可验证的声誉），再启用安装包链路。
