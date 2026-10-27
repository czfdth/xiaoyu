; 小鱼 · Windows 安装程序（Inno Setup 6）
;
; 构建：installer\build.ps1  →  out\小鱼安装程序-<版本>.exe
; 依赖：Inno Setup 6（iscc.exe）。CI 上用 choco install innosetup 提供。
;
; 设计取舍：
;   · 装到 %LOCALAPPDATA%\xiaoyu，免管理员，和现有 install.ps1 一致
;   · 升级时只覆盖程序文件；state\ 与 config.json 不在 [Files] 里，永远不会被覆盖
;   · 卸载默认保留 state\（她的记忆），要删得自己动手

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "小鱼"
#define AppId "7E3F0C1A-2B4D-4E8F-9A11-5C6D7E8F9012"

[Setup]
AppId={{{#AppId}}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=小鱼
AppPublisherURL=https://github.com/czfdth/xiaoyu
DefaultDirName={localappdata}\xiaoyu
DefaultGroupName=小鱼
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\out
OutputBaseFilename=小鱼安装程序-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
; 不强制关掉正在跑的进程：她的桥接是独立进程，装完让用户自己重启
CloseApplications=no
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
; 中文界面靠下面 [Messages] 覆盖常用几句，避免依赖额外语言包文件

[Messages]
WelcomeLabel1=欢迎安装{#AppName}
WelcomeLabel2=会把{#AppName}装到你的用户目录（不需要管理员）。她的记忆（state 文件夹）不会被覆盖。
FinishedHeadingLabel=装好了
FinishedLabel=点下面的按钮就能打开管家。

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "快捷方式："
Name: "autostart"; Description: "开机自动启动（推荐）"; GroupDescription: "启动："

[Files]
; stage 由 build.ps1 铺：src / scripts / bin / gui\dist / roles / *.bat / *.ps1 / package.json 等
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 注意：state\、logs\、backups\、config.json、companion.json 一律不进 stage；
; 它们由程序首次运行时自己创建，升级时天然保留。

[Icons]
Name: "{group}\打开管家"; Filename: "{app}\打开管家.bat"; WorkingDir: "{app}"
Name: "{group}\启动她"; Filename: "{app}\启动她.bat"; WorkingDir: "{app}"
Name: "{group}\停止她"; Filename: "{app}\停止她.bat"; WorkingDir: "{app}"
Name: "{group}\查看状态"; Filename: "{app}\查看状态.bat"; WorkingDir: "{app}"
Name: "{group}\卸载{#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\小鱼管家"; Filename: "{app}\打开管家.bat"; WorkingDir: "{app}"; Tasks: desktopicon
; 开机自启用启动文件夹快捷方式（比写注册表更好排查、用户看得见）
Name: "{userstartup}\小鱼"; Filename: "{app}\启动她.bat"; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{app}\打开管家.bat"; Description: "现在打开管家"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
; 只清运行产物，绝不碰 state（记忆）与 config.json
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\tmp"
