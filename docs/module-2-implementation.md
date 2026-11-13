# TraceFind · 模块二实现（本地文件名索引）

把模块一的演示数据换成真实的文件系统索引：目录扫描、持久化元数据、中文拼音、排序权重。
对应产品方案 P0 的剩余部分（文件名/路径搜索），全文内容检索仍留给后续模块。

- 版本：0.2.0（M2）
- 索引库：`%APPDATA%\com.tracefind.desktop\index.db`（SQLite，WAL）
- 前端：不再有 `demoFiles`，搜索走 `search_files` / `recent_files` 命令

## 一、数据模型

```sql
CREATE TABLE files (
  path    TEXT PRIMARY KEY,   -- 绝对路径，唯一键
  name    TEXT NOT NULL,
  name_lc TEXT NOT NULL,      -- 小写名，用于 LIKE 与排序
  dir     TEXT NOT NULL,
  ext     TEXT NOT NULL,
  kind    TEXT NOT NULL,      -- pdf/doc/sheet/slide/image/archive/video/audio/code/binary/other/folder
  size    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,   -- Unix 秒
  depth   INTEGER NOT NULL,   -- 相对扫描根
  py      TEXT NOT NULL,      -- 拼音全拼（ASCII 原样小写）
  pyf     TEXT NOT NULL,      -- 拼音首字母（ASCII 原样）
  gen     INTEGER NOT NULL    -- 扫描代数
);
```

拼音字段在**写入时**算好，不在查询时算：

| 名字 | py | pyf |
|---|---|---|
| 财务预算报告.docx | `caiwuyusuanbaogaodocx` | `cwysbgdocx` |
| TraceFind.md | `tracefindmd` | `tracefindmd` |

匹配覆盖四条通路：`name_lc`、`path`、`py`、`pyf`，多个词之间是 AND。

## 二、扫描

- 默认范围：桌面 / 下载 / 文档（首次运行写入设置，之后可在设置里增删）
- 硬跳过：`node_modules`、`target`、`.git`、`AppData`、`Windows`、`Program Files`、
  `__pycache__`、`.venv` 等；点开头或 `$` 开头的目录也跳过
- 不跟随符号链接，最大深度 16，单次上限 40 万条
- 批 256 条一个事务；每 200 条发一次 `index:progress`（含已扫描数、当前目录）
- **代数清理**：每轮扫描 `gen+1`，写库时带上新代数；扫完 `DELETE WHERE gen != 当前`，
  文件被删除或移走会自然消失，不需要单独对账
- 暂停只停遍历、不中断事务；恢复后继续（`scan_paused` 原子开关注入等待循环）

启动策略：空库立刻扫描；非空且距上次扫描超过 12 小时才后台刷新，避免每次开机都全盘走一遍。

## 三、排序权重

SQL 先按 `mtime DESC` 取 800 条候选，再在 Rust 里精排（`index.rs::score`）：

| 命中位置 | 基础分 |
|---|---|
| 文件名完全相等 | 1200 |
| 文件名前缀 | 900 |
| 文件名词边界前缀 | 760 |
| 文件名包含 | 620 |
| 首字母前缀 / 全拼前缀 | 680 / 660 |
| 首字母包含 / 全拼包含 | 480 / 440 |
| 仅路径包含 | 300 |

修正项：名字越短加分（最多 +60）、层级每深一层 −6、1 天内 +90 / 7 天内 +45 / 30 天内 +18。

**首字母子序列召回**：`cwbg` 能命中「财务预算报告」——SQL 的 LIKE 拿不到这种跳字匹配，
所以在结果偏少（<3）且输入是 2–8 位纯字母时，额外拉一批以首字母开头的候选做子序列判定。

## 四、命令与事件

| 命令 | 说明 |
|---|---|
| `search_files(query, scope?, limit?)` | 搜索，`scope` 是目录前缀（范围过滤） |
| `recent_files(scope?, limit?)` | 最近修改的文件，用于空状态 |
| `index_status` | 状态、条目数、已扫描数、当前目录、上次扫描时间 |
| `start_index` / `pause_index` / `resume_index` | 扫描控制 |
| `add_root` / `remove_root` | 增删扫描目录（写设置并广播） |
| `open_path` / `reveal_path` | 系统默认程序打开 / 资源管理器定位 |

事件：`index:progress`（扫描中每 200 条 + 完成时）、`index:done`。

## 五、实测（本机，3840×2160 @150%）

| 指标 | 结果 |
|---|---|
| 索引条目 | 14,596（桌面 + 下载 + 文档） |
| 全量扫描耗时 | 约 0.45 s |
| 索引库体积 | 8.4 MB |
| 搜索耗时 P50 / P95（40 次混合查询） | **9.2 ms / 14.9 ms** |
| 首屏最近文件查询 | < 10 ms |

## 六、验证

```powershell
# 桌面端真实数据端到端（造中文文件 → 扫描 → 检索 → 清理）
node tools/verify-m2.mjs 9223

# 搜索耗时
node tools/measure-search.mjs 9223 40

# 界面行为（浏览器，演示数据）
node tools/verify-ui.mjs http://127.0.0.1:4176/ shots
```

`verify-m2.mjs` 覆盖：中文关键词、拼音全拼、首字母前缀、首字母子序列、中英混合、
路径关键词、范围过滤、排序首位、删除后清理。全部通过。

## 七、已知边界

1. **无文件监听**：新文件要等下次扫描（或手动「重新扫描」）才进索引；`notify` 监听留给下一阶段。
2. **LIKE 全表扫描**：4 万条以内 P95 仍在 15ms 级；再大需要 FTS5 或 Tantivy，属于全文模块的活。
3. **不索引文件内容**：搜索结果只有名字/路径/大小/时间，没有正文片段。
4. **预览仍是占位**：`PreviewDrawer` 只显示路径与大小，真实预览在模块六。
5. 索引范围默认取系统「桌面/下载/文档」，其他盘符需要手动添加。
