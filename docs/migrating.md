# 从 AURA Search 迁移

TraceFind 在 1.1.0 更名（原 AURA Search）。如果你从旧版升级，数据会自动迁移，也可以手动处理。

## 自动迁移

首次启动时，如果**新数据目录还没有 `index.db`**、而旧数据目录存在，程序会尝试复制索引、设置与模型缓存。

| 项 | 旧版（AURA Search） | 现在（TraceFind） |
|---|---|---|
| 可执行文件 | `aura-search.exe` | `tracefind.exe` |
| 应用标识 | `com.aurasearch.desktop` | `com.tracefind.desktop` |
| 数据目录 | `%APPDATA%\com.aurasearch.desktop` | `%APPDATA%\com.tracefind.desktop` |
| 日志 | `%LOCALAPPDATA%\com.aurasearch.desktop\logs` | `%LOCALAPPDATA%\com.tracefind.desktop\logs` |

步骤：

1. 先退出旧版（托盘图标右键退出，避免文件占用）
2. 启动 TraceFind
3. 检查索引条数与设置是否已迁入；旧目录**会保留**，确认无误后可自行删除

## 迁移失败时

- 目标目录已有 `index.db` 时不会自动覆盖，避免把新数据冲掉
- 需要重来：退出 TraceFind，删除 `%APPDATA%\com.tracefind.desktop\index.db`，再启动
- 只想要设置：把旧目录的 `settings.json` 复制到新目录即可（API Key 是 DPAPI 加密的，必须同一 Windows 账户）

## 环境变量（隔离运行）

调试或多实例时可用：

| 变量 | 作用 |
|---|---|
| `TRACEFIND_DATA_DIR` | 索引库所在目录 |
| `TRACEFIND_CONFIG_DIR` | `settings.json` 所在目录 |
| `WEBVIEW2_USER_DATA_FOLDER` | WebView2 缓存目录 |

旧前缀 `AURA_*` 仍然兼容。
