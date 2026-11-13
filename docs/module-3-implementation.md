# TraceFind · 模块三实现（实时更新）

模块二解决"有索引"，模块三解决"索引不过期"：监听文件系统变化，增量写回 SQLite，
新建 / 改名 / 删除立刻可搜，不需要等下一次全量扫描。

- 版本：0.3.0（M3）
- 依赖：`notify 8`（Windows 上是 `ReadDirectoryChangesW`，不是轮询）
- 入口：`src-tauri/src/watcher.rs`

## 一、数据流

```
文件系统变化
   │ ReadDirectoryChangesW（递归监听每个扫描根）
   ▼
notify 回调 → mpsc channel → 监听线程
   │ 攒 320ms 或满 256 条
   ▼
判定路径：存在？
   ├─ 是文件 → OwnedEntry::from_path → upsert_batch（沿用当前代数）
   ├─ 是目录 → 递归补扫该子树（深度 8，上限 5000 条）
   └─ 不存在 → delete_paths（自身 + `path\%` 子树）
   ▼
index::count → 更新状态 → emit index:changed
   ▼
前端收到事件 → 静默刷新最近列表 / 当前查询
```

## 二、几个关键取舍

**为什么要"代数"**：增量写入必须沿用当前 `gen`，否则下一次全量扫描的
`DELETE WHERE gen != 当前` 会把这些新行当成过期数据删掉。

**扫描进行中直接丢事件**：全量扫描会用新代数重写整张表，两边同时写同一批行没有意义，
还会互相覆盖。代价是扫描那 0.5 秒内的变化要等扫描结果——可以接受。

**目录变更要递归补扫**：Windows 只报告"目录被创建/改名"，不会补报里面已有的文件；
拖一个文件夹进来只处理目录本身会漏掉全部内容。

**忽略规则与扫描共用**：`scanner::ignored_path` 同时被扫描器和监听器调用，
保证两边对"什么该索引"的判断一致——包括 `node_modules`、`AppData`、隐藏项，
以及 `~$` 开头的 Office 锁文件、`.tmp` / `.crdownload` 这类未完成下载。

**防抖窗口**：解压或 `npm install` 会在几百毫秒内产生上千个事件。
攒 320ms 或满 256 条就落库一次，避免每个文件一个事务把磁盘打满。

## 三、实测（本机 14,596 条索引）

`tools/verify-m3.mjs` 的实测结果：

| 场景 | 从操作到可搜到 |
|---|---|
| 新建文件 | 12 ms |
| 文件改名（旧名消失） | 473 ms |
| 文件改名（新名出现） | 37 ms |
| 新目录里放文件 | 38 ms |
| 删除文件 | 538 ms |
| 删除整个目录（子树） | 526 ms |

多数操作在第一次轮询（200ms 间隔）内就命中；改名/删除这两项接近防抖窗口的 320ms + 落库开销。

## 四、命令与事件

| 事件 | 触发时机 | 载荷 |
|---|---|---|
| `index:progress` | 全量扫描中每 200 条 + 完成 | 完整 `IndexStatus` |
| `index:changed` | 增量写入/删除完成后 | `{ files, changed }` |

`get_runtime_info` 增加 `watching: bool`，设置页「索引与扫描」显示「实时监听：已开启/未启用」。

监听随扫描范围变化重启：`patch_settings` / `add_root` / `remove_root` 里调用 `restart_watcher`；
退出时 `watcher::stop()` 释放目录句柄。

## 五、验证

```powershell
node tools/verify-m3.mjs 9223      # 新建/改名/子目录/删除/删目录
node tools/verify-m2.mjs 9223      # 扫描与检索回归
node tools/verify-ui.mjs http://127.0.0.1:4176/ shots
```

## 六、已知边界

1. **网络盘与部分虚拟盘**：`ReadDirectoryChangesW` 在部分 SMB/虚拟文件系统上不保证事件，
   这类目录仍靠定时全量扫描兜底。
2. **事件丢失**：系统缓冲区溢出时 notify 会报错，当前只忽略该错误，不做补偿——
   兜底是 12 小时一次的全量扫描。
3. **批量操作**：上万文件的解压仍会让监听线程忙一阵（每批 256 条），期间搜索不受影响。
4. **索引库自身不在监听范围**（位于 `%APPDATA%`），不会形成自触发循环。
