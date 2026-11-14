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

Windows Release 产物为 `src-tauri/target/release/tracefind.exe`。从已构建的 EXE 打包 1.1.1：

```powershell
powershell -File tools/package-release.ps1 -Version 1.1.1
```

产物位于 `release/`，含 ZIP 和 SHA-256 校验文件。当前打包脚本固定复制 1.1.0 发布说明，打包 1.1.1 时须核对 ZIP 内的 `RELEASE-NOTES.md`。发布脚本使用 GitHub CLI，调用前应显式指定版本。桌面端的索引回归可使用 `tools/run-isolated.ps1`。运行前检查脚本使用的 EXE 路径及隔离目录是否与当前版本一致。

## 数据如何流动

1. **发现文件。** 扫描器遍历所选目录，把路径、文件名、大小、修改时间及拼音字段写入 SQLite。数据库使用 WAL，实时监听负责提交增量变更。
2. **提取正文。** 后台任务使用 `zip` 和 `quick-xml` 读取 Office 文档，使用 `pdf-extract` 读取 PDF 文本层，并通过 `encoding_rs` 处理部分文本编码。开启 OCR 后，图片和符合条件的扫描件可走 Windows 识别。
3. **召回与排序。** 文件名和路径走元数据查询，正文走 FTS5。相关度模式下，本地结果按倒数排名融合（RRF）合并。语义候选异步返回，界面按路径去重后追加。
4. **生成向量。** 后台把正文切成重叠文本块。默认本地方案使用 FastEmbed 加载 BGE-small-zh-v1.5，将向量写入 SQLite。查询经同一模型编码，再与候选向量比较余弦相似度。首次启用本地模型时可能需要下载。
5. **文件问答。** 本地召回提供正文片段与引用来源，云端接口负责生成回答。问答与云端嵌入的数据范围见[数据与隐私](DATA-AND-PRIVACY.md)。

## 桌面集成与预览

- React 通过 `src/lib/bridge.ts` 调用 Tauri IPC，并订阅窗口、索引与搜索事件。Tauri 插件负责托盘、快捷键与开机启动，`window-vibrancy` 负责应用窗口材质。
- 文档预览复用正文提取逻辑，文本分页返回并缓存，代码高亮在前端完成。图片以 data URL 传给预览组件。
- Windows DPAPI 用于保护持久化的云端 API Key。设置响应会脱敏，实际请求由 Rust 桌面层发送。

## 宣传视频工具

宣传片页面位于 `docs/assets/promo-film.html`。`tools/make-film.ps1` 调用 `tools/render-film.mjs`，用 Edge 无头模式逐帧截图，再通过 FFmpeg 编码为 H.264。该流程用于生成宣传素材，产物位于 `release/promo/`。

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