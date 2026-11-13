# TraceFind 开发指南

TraceFind 是 Windows 桌面应用。前端使用 React、TypeScript 和 Vite，桌面层使用 Tauri 2 与 Rust。文件索引存储在 SQLite，正文使用 FTS5，实时更新由文件系统监听驱动。

## 本地开发

准备 Node.js、pnpm、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2 Runtime。在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

只看前端界面时可运行 `pnpm dev:web`，访问 `http://127.0.0.1:1420`。浏览器预览使用演示数据，原生窗口、托盘和实际索引在桌面模式验证。

## 构建与验证

```powershell
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm build:desktop
```

Windows Release 产物为 `src-tauri/target/release/tracefind.exe`。从已构建的 EXE 打包 1.1.0：

```powershell
powershell -File tools/package-release.ps1 -Version 1.1.0
```

产物位于 `release/`，含 ZIP 和 SHA-256 校验文件。桌面端的索引回归可使用 `tools/run-isolated.ps1`。运行前检查脚本使用的 EXE 路径及隔离目录是否与当前版本一致。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `src/windows/` | 搜索窗口与设置窗口 |
| `src/components/` | 搜索结果、预览、状态栏与问答面板 |
| `src/lib/bridge.ts` | 前端与 Tauri 的通信 |
| `src-tauri/src/scanner.rs`、`watcher.rs` | 目录扫描与增量更新 |
| `src-tauri/src/index.rs` | SQLite、拼音、FTS5 和向量存储 |
| `src-tauri/src/docindex.rs`、`extract.rs`、`ocr.rs` | 正文提取与 OCR |
| `src-tauri/src/semantic.rs`、`commands.rs` | 嵌入、检索与桌面命令 |

反馈时请附 TraceFind 版本、Windows 版本、复现步骤和预期结果。日志片段请先移除私人路径、搜索词和密钥。