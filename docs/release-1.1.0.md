# TraceFind 1.1.0 发布说明

更名版本：**TraceFind → TraceFind**，并换上新的品牌图标。功能与 1.0.0 一致，另含一处数据迁移修复。

## 改名与数据迁移

| 项 | 1.0.0 | 1.1.0 |
|---|---|---|
| 产品名 | TraceFind | **TraceFind** |
| 可执行文件 | aura-search.exe | **tracefind.exe** |
| 应用标识 | com.tracefind.desktop | **com.tracefind.desktop** |
| 数据目录 | `%APPDATA%\com.tracefind.desktop` | `%APPDATA%\com.tracefind.desktop` |

**首次启动会尝试迁移**。目标目录尚无 `index.db` 且旧数据目录存在时，程序会尝试复制索引、设置与模型缓存。请先退出 TraceFind，再启动 TraceFind，并检查索引和设置是否已迁入。旧目录会保留。

## 品牌

- 应用图标 / 托盘图标 / 任务栏图标：文件夹轮廓 + 取景框四角 + 中心点，薄荷色描边配深色圆角底
- 窗口左上角品牌标记换成同一套图形的内联 SVG，14–17px 下依然清晰
- 图标生成脚本：`tools/make-icons.py`（从 `docs/assets/tracefind-logo.png` 生成各尺寸 PNG 与多档 ICO）

## 功能（与 1.0.0 相同）

文件名 / 拼音 / 正文 / OCR / 语义五路检索，排序与类型筛选，分页预览与语法高亮，检索增强问答（云端模型，不提供本地大模型）。

## 性能

未变化：冷启动 118 ms，唤起 P50 18 ms / P95 31 ms，搜索 P50 27 ms / P95 51 ms，exe 约 44 MB。

## 已知限制

与 1.0.0 相同，见 `docs/release-1.0.0.md`。

## 升级

- 解压新版本并运行 `TraceFind.exe`，按上面的条件检查迁移结果
- 索引与配置都在用户目录，回退到 1.0.0 也能继续用旧目录
