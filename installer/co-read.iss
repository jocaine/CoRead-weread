; 本文件含中文。Inno Setup 需要一个 UTF-8 BOM 才会按 UTF-8 解析；
; 没有 BOM 时它会按系统 ANSI（中文 Windows 上是 GBK）读，中文字符串被截断成
; 非法引号，报出莫名其妙的 "Column 12" 语法错。构建脚本会保证 BOM 存在。
; ============================================================================
; ============================================================================
;  CoRead 安装程序（Inno Setup 6+，实测 7.1.0）
;
;  设计要点（都是踩过坑才定下来的，改之前请先读注释）：
;
;  1. 默认装到用户目录、不需要管理员权限
;     理由：共读数据都在用户自己的账户下，装到 Program Files 反而会带来
;     写权限问题（程序要往 agent\data、receiver\inbox 里写东西）。
;
;  2. 升级时绝不覆盖用户数据
;     程序文件（node.exe / agent\*.js / receiver\*.js / extension\）每次覆盖，
;     但下面这几个目录只在不存在时创建，升级一律不碰：
;         agent\data  agent\api-config.json  receiver\inbox  receiver\books  receiver\toolbox
;     否则一次升级就把读者几个月的阅读记录和聊天历史清空。
;
;  3. 安装向导最后一页带"装插件四步教程"
;     因为 Chrome 商店装不了本地后端，扩展只能手动加载。这一页是读者体验的
;     决定性环节：提供"复制扩展目录路径"和"打开扩展管理页"两个按钮。
;
;  4. 启动方式：run-hidden.vbs（VBS 隐藏启动 powershell 托盘程序）
;     读者不会看到任何黑窗口。将来换成正式的托盘 exe，只要改 [Icons] 与 [Run]
;     里指向的文件即可，其余结构不用动。
; ============================================================================

#define AppName "CoRead"
#define AppNameCN "CoRead 共读"
#define AppPublisher "CoRead"
#define AppURL "https://github.com/lexielin99-code/CoRead-weread"
; 版本号由 build-installer.bat 从 extension\manifest.json 读入并传入，
; 避免插件版本和安装包版本对不上。直接编译本文件时回退到这行：
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8F3A2C41-7B6D-4E52-9A18-5C7E4D3B1F60}
AppName={#AppNameCN}
AppVersion={#AppVersion}
AppVerName={#AppNameCN} {#AppVersion}
AppPublisher={#AppPublisher}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppNameCN}
; 不需要管理员：装到用户自己的目录，程序也要往安装目录写运行时数据
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; 只提供简体中文界面
ShowLanguageDialog=no
OutputDir=build\out
OutputBaseFilename=CoRead-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
DisableProgramGroupPage=yes
; 托盘程序在跑时要能被关掉再升级
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#AppNameCN}
UninstallDisplayIcon={app}\node.exe
; 卸载时保留用户数据（另有指令行开关 /KEEPUSERDATA 强制保留）
; 注意：这里不列 agent\data 等目录，配合 CurUninstallStepChanged 里的判断

[Languages]
Name: "cn"; MessagesFile: "compiler:Default.isl"

[Tasks]
; 注意 autostart 必须带 unchecked：
;   不写 unchecked 时，Inno 会把它当成"默认已勾选"，于是用户即使没勾也会写注册表。
;   实测踩到过——安装程序因为写注册表失败的报错而整体回滚（Error 5: 拒绝访问）。
Name: "autostart"; Description: "开机自动启动 CoRead（推荐）"; GroupDescription: "启动选项："; Flags: unchecked
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
; ── Node 运行时：只需 node.exe 一个文件 ──────────────────────────────
; 本项目零第三方依赖（数据用 Node 内置的 node:sqlite），所以官方分发包里的
; node_modules（npm 自身，11 MB）和 npm/npx/corepack 等脚本全部不需要。
Source: "build\app\node.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "build\app\LICENSE.node.txt"; DestDir: "{app}"; Flags: ignoreversion

; ── 共读引擎（程序文件，升级时覆盖）──────────────────────────────────
Source: "build\app\agent\index.js";      DestDir: "{app}\agent"; Flags: ignoreversion
Source: "build\app\agent\package.json";  DestDir: "{app}\agent"; Flags: ignoreversion
Source: "build\app\agent\.env.example";  DestDir: "{app}\agent"; Flags: ignoreversion skipifsourcedoesntexist
Source: "build\app\agent\lib\*";         DestDir: "{app}\agent\lib"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "build\app\agent\scripts\data\*"; DestDir: "{app}\agent\scripts\data"; Flags: ignoreversion recursesubdirs createallsubdirs

; ── 接收端（程序文件，升级时覆盖）────────────────────────────────────
Source: "build\app\receiver\index.js";      DestDir: "{app}\receiver"; Flags: ignoreversion
Source: "build\app\receiver\package.json";  DestDir: "{app}\receiver"; Flags: ignoreversion
Source: "build\app\receiver\graph-data.js"; DestDir: "{app}\receiver"; Flags: ignoreversion skipifsourcedoesntexist

; ── 浏览器插件（随包分发，供向导页指向；升级时覆盖）──────────────────
Source: "build\app\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs

; ── 启动器 ───────────────────────────────────────────────────────────
Source: "build\app\run-hidden.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\app\tray.ps1";       DestDir: "{app}"; Flags: ignoreversion
Source: "build\app\stop.bat";       DestDir: "{app}"; Flags: ignoreversion

; ── 用户数据目录与配置：仅在不存在时创建，升级绝不覆盖 ★★★ ───────────
; 这就是上面设计要点 2 的落实处。onlyifdoesntexist 是关键。
Source: "build\app\agent\api-config.json"; DestDir: "{app}\agent"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "build\app\.keep"; DestDir: "{app}\agent\data";        Flags: onlyifdoesntexist uninsneveruninstall
Source: "build\app\.keep"; DestDir: "{app}\receiver\inbox";    Flags: onlyifdoesntexist uninsneveruninstall
Source: "build\app\.keep"; DestDir: "{app}\receiver\books";    Flags: onlyifdoesntexist uninsneveruninstall
Source: "build\app\.keep"; DestDir: "{app}\receiver\toolbox";  Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
; 开始菜单：主入口是"无窗口启动器"（双击即可，托盘里出现图标）
Name: "{group}\{#AppNameCN}";        Filename: "{app}\run-hidden.vbs"; IconFilename: "{app}\node.exe"; Comment: "启动 CoRead（在托盘中运行）"
Name: "{group}\停止 CoRead";         Filename: "{app}\stop.bat"; IconFilename: "{app}\node.exe"
Name: "{group}\浏览器插件文件夹";     Filename: "{app}\extension"
Name: "{group}\卸载 {#AppNameCN}";    Filename: "{uninstallexe}"
; 桌面快捷方式（可选任务）
Name: "{autodesktop}\{#AppNameCN}";  Filename: "{app}\run-hidden.vbs"; IconFilename: "{app}\node.exe"; Tasks: desktopicon

[Run]
; 开机自启：指向 VBS（不是 node.exe），所以开机也不会出现黑窗口
Filename: "{app}\run-hidden.vbs"; Description: "开机自动启动 CoRead"; Flags: runminimized; Tasks: autostart; Check: not IsAutoStartMarked
Filename: "{app}\run-hidden.vbs"; Description: "立即启动 CoRead";     Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前先停掉托盘与两个子进程
Filename: "{app}\stop.bat"; Flags: runhidden; RunOnceId: "StopCoRead"

[Registry]
; 开机自启：写 HKCU 的 Run 项（不需要管理员权限）。
; 指向 VBS 而不是 node.exe，这样开机也不会闪黑窗口。
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "CoRead"; \
  ValueData: """{app}\run-hidden.vbs"""; \
  Flags: uninsdeletevalue; Tasks: autostart

[UninstallDelete]
; 只删程序自己生成的、不属于用户数据的残留；用户数据交 CurUninstallStepChanged 判断
Type: files;          Name: "{app}\*.pid"
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  PluginPage: TInputOptionWizardPage;
  PathEdit: TNewEdit;
  CopyBtn: TButton;
  OpenExtBtn: TButton;

const
  CHROME_KEY = 'Software\Google\Chrome\BLBeacon';
  EDGE_KEY   = 'Software\Microsoft\Edge\BLBeacon';

{ ---------- 工具函数 ---------- }

{ 把文本放进剪贴板。
  为什么绕这么一圈（实测踩坑记录）：
    - Inno Setup 7 没有 SetClipboardText（编译报 Unknown identifier）
    - GlobalAlloc / GlobalLock 也不可用（同样 Unknown identifier）
    - Pascal Script 里没有 Char 类型，SizeOf(Char) 会报 Type mismatch
  所以改成：写临时文件（UTF-8 无 BOM）→ 让 PowerShell 用 -Encoding UTF8 读进剪贴板。
  这样中文和含空格的路径都不会出问题，也没有命令行转义的风险。 }
function PutClipboard(const S: String): Boolean;
var
  tmp, ps: String;
  code: Integer;
begin
  Result := False;
  tmp := ExpandConstant('{tmp}\coread-clip.txt');
  if not SaveStringToFile(tmp, S, False) then Exit;
  ps := '-NoProfile -ExecutionPolicy Bypass -Command ' +
        '"Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath ''' + tmp + ''')"';
  Result := Exec('powershell.exe', ps, '', SW_HIDE, ewWaitUntilTerminated, code);
end;

{ 检测是否装了 Chrome 或 Edge——两者都能加载这个扩展 }
function BrowserHint(): String;
var
  s: String;
begin
  Result := '未检测到 Chrome 或 Edge。本插件需要 Chromium 内核的浏览器（Chrome / Edge 均可）。';
  if RegQueryStringValue(HKCU, CHROME_KEY, 'version', s) then
    Result := '已检测到 Chrome（版本 ' + s + '）'
  else if RegQueryStringValue(HKCU, EDGE_KEY, 'version', s) then
    Result := '已检测到 Edge（版本 ' + s + '）';
end;

{ 是否已经写过开机自启项（避免重复添加） }
function IsAutoStartMarked(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\.autostart'));
end;

{ ---------- 装插件教程页 ---------- }

procedure CopyPathClick(Sender: TObject);
begin
  PutClipboard(PathEdit.Text);
  MsgBox('扩展目录路径已复制到剪贴板。' + #13#10 + #13#10 +
         '接下来在浏览器的扩展管理页点「加载已解压的扩展程序」，' + #13#10 +
         '在弹出的选择框地址栏里按 Ctrl+V 粘贴，回车即可。', mbInformation, MB_OK);
end;

procedure OpenExtPageClick(Sender: TObject);
var
  code: Integer;
begin
  { 用默认浏览器打开 chrome:// 是打不开的，所以显式指定 chrome.exe / msedge.exe }
  if Exec('cmd.exe', '/c start "" chrome.exe "chrome://extensions/"', '', SW_HIDE, ewNoWait, code) then
    Exit;
  if Exec('cmd.exe', '/c start "" msedge.exe "edge://extensions/"', '', SW_HIDE, ewNoWait, code) then
    Exit;
  MsgBox('没能自动打开扩展管理页。' + #13#10 + #13#10 +
         '请手动在浏览器地址栏输入：chrome://extensions/   （Edge 用 edge://extensions/）',
         mbInformation, MB_OK);
end;

procedure InitializeWizard();
var
  intro: TNewStaticText;
  y: Integer;
begin
  { 用完全自主的页面。
    为什么不省事用 CreateOutputMsgPage：实测 TOutputMsgWizardPage 在 Inno Setup 7
    里既没有 RichEditViewer，也没有 MsgText / Text / SubCaption 等属性（逐个试过，
    全部报 Unknown identifier）。自己放控件反而最稳。 }
  PluginPage := CreateInputOptionPage(wpSelectTasks,
    '最后一步：把浏览器插件装上',
    '共读的界面跑在你的浏览器里，需要手动加载一次（约 30 秒）',
    '', False, False);

  intro := TNewStaticText.Create(PluginPage);
  intro.Parent := PluginPage.Surface;
  intro.Left := 0;
  intro.Top := 0;
  intro.Width := PluginPage.SurfaceWidth;
  intro.AutoSize := False;
  intro.Height := 150;
  intro.WordWrap := True;
  intro.Caption :=
    BrowserHint() + #13#10 + #13#10 +
    '请按下面四步操作：' + #13#10 +
    '① 点下面的「打开扩展管理页」按钮' + #13#10 +
    '② 打开右上角的「开发者模式」开关' + #13#10 +
    '③ 点「加载已解压的扩展程序」' + #13#10 +
    '④ 在文件选择框的地址栏粘贴下面框里的路径，回车';

  y := 158;

  PathEdit := TNewEdit.Create(PluginPage);
  PathEdit.Parent := PluginPage.Surface;
  PathEdit.Left := 0;
  PathEdit.Top := y;
  PathEdit.Width := PluginPage.SurfaceWidth - 96;
  PathEdit.ReadOnly := True;
  { 注意：这里绝不能展开 app 常量！
    InitializeWizard 阶段安装目录还没确定，展开会抛 fatal 异常：
      An attempt was made to expand the app constant before it was initialized
    结果是安装程序静默失败（退出码 1、什么都不装）——实测踩过这个坑。
    所以赋值放到 CurPageChanged 里，等页面显示时再填。
    另注：Pascal 用花括号作注释定界符，所以注释里不能出现花括号常量名。 }

  CopyBtn := TButton.Create(PluginPage);
  CopyBtn.Parent := PluginPage.Surface;
  CopyBtn.Left := PathEdit.Left + PathEdit.Width + 6;
  CopyBtn.Top := PathEdit.Top - 1;
  CopyBtn.Width := 90;
  CopyBtn.Height := PathEdit.Height + 2;
  CopyBtn.Caption := '复制路径';
  CopyBtn.OnClick := @CopyPathClick;

  OpenExtBtn := TButton.Create(PluginPage);
  OpenExtBtn.Parent := PluginPage.Surface;
  OpenExtBtn.Left := 0;
  OpenExtBtn.Top := PathEdit.Top + PathEdit.Height + 12;
  OpenExtBtn.Width := 140;
  OpenExtBtn.Height := 26;
  OpenExtBtn.Caption := '打开扩展管理页';
  OpenExtBtn.OnClick := @OpenExtPageClick;
end;

{ 页面显示时才填路径——安装目录要到这时才可用（原因见 InitializeWizard 里的注释）}
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = PluginPage.ID) and (PathEdit <> nil) then
    PathEdit.Text := ExpandConstant('{app}\extension');
end;

{ ---------- 安装后：记录自启状态 ---------- }

procedure CurStepChanged(CurStep: TSetupStep);
var
  marker: String;
begin
  if CurStep = ssPostInstall then
  begin
    marker := ExpandConstant('{app}\.autostart');
    if IsTaskSelected('autostart') then
      SaveStringToFile(marker, '1', False)
    else
      DeleteFile(marker);
  end;
end;

{ ---------- 卸载：用户数据默认保留，可选择一并删除 ---------- }

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  r: Integer;
  dataDirs: TArrayOfString;
  i: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { 命令行走 /KEEPUSERDATA 时直接保留，不打扰 }
    if Pos('/KEEPUSERDATA', Uppercase(GetCmdTail)) > 0 then
      Exit;

    r := MsgBox('是否同时删除你的共读数据？' + #13#10 + #13#10 +
                '包括：阅读画像与自画像、会意图谱、聊天与讨论记录、' + #13#10 +
                '章节缓存、标注、翻译记录，以及模型 API 配置。' + #13#10 + #13#10 +
                '选「否」则保留这些数据（以后重装可以接着用）。' + #13#10 +
                '选「是」则全部删除，无法恢复。',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
    if r = IDYES then
    begin
      SetArrayLength(dataDirs, 5);
      dataDirs[0] := ExpandConstant('{app}\agent\data');
      dataDirs[1] := ExpandConstant('{app}\receiver\inbox');
      dataDirs[2] := ExpandConstant('{app}\receiver\books');
      dataDirs[3] := ExpandConstant('{app}\receiver\toolbox');
      dataDirs[4] := ExpandConstant('{app}\agent\api-config.json');
      for i := 0 to GetArrayLength(dataDirs) - 1 do
      begin
        if FileExists(dataDirs[i]) then
          DeleteFile(dataDirs[i])
        else
          DelTree(dataDirs[i], True, True, True);
      end;
    end;
  end;
end;
