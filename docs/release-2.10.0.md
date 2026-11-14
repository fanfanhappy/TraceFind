# TraceFind 2.10.0

现在有正经安装包了：可以自选装在哪，快捷方式保留应用图标，卸载也走系统流程。

## 安装

下载 `TraceFind-2.10.0-win64-setup.exe` 运行：

1. 欢迎页 → **选择安装位置** → 选择是否创建桌面快捷方式 → 安装 → 完成
2. 默认目录是 `%LOCALAPPDATA%\Programs\TraceFind`，**不需要管理员权限**
3. 装完会创建开始菜单快捷方式，桌面快捷方式可选；两者都用应用自身的图标
4. 控制面板「应用和功能」里可以正常卸载

便携用法仍然保留：下载 `TraceFind-2.10.0-win64.zip` 解压直接跑 `TraceFind.exe`。

## 关于一键更新的位置

装到当前用户目录时，应用内的「下载并安装」可以直接替换程序。如果手动装到 `C:\Program Files` 这类受保护目录，替换需要管理员权限会失败，更新时请用安装包覆盖安装。

## 工程侧

- 新增 `tools/installer/installer.nsi` 与 `tools/build-installer.ps1`（复用 Tauri 缓存的 NSIS）
- `package-release.ps1` 同时产出 zip 与 setup.exe，各自生成 sha256
- `check-release.ps1` 增加安装包本地/远端校验（现在 21 项）

## 实测

- 静默安装到 `C:\Temp\tf-lzma`：`TraceFind.exe` + `uninstall.exe`，退出码 0
- 快捷方式：`TargetPath` 与 `IconLocation` 都指向安装目录的 `TraceFind.exe`
- 卸载后：目录、开始菜单、桌面快捷方式、注册表项全部清除

数据格式未变。