# 发布流程

这个项目是单人维护的 Windows 桌面应用：单 exe、无安装器、无自动更新。发布的作用只有一个——**给用户一个可下载、可回滚、说得清的版本**。

## 什么时候发

| 变更类型 | 发 release？ |
|---|---|
| 新功能、行为变化、用户能感知的修复 | ✅ 攒批后发 |
| 重构、文档、CI、内部性能优化 | ❌ 只进 main |
| 启动失败、索引损坏、隐私/安全 | ✅ 立即发，不等批次 |

**攒批规则**：同一周内的多个小修合成一个版本（例如 v2.0.1 收 3–5 个修复）。版本号跟语义走，不跟日期走。

## tag 与 release 解耦

- **tag**：每个可构建点都可以打，成本低、不通知关注者
- **release**：按批次创建，先 draft，自测通过再 publish
- 这样避免"发了又改"，也避免旧版本堆积（发之前删掉上一轮的 draft）

## 版本号

三处必须一致：

```
package.json        "version": "2.0.0"
src-tauri/Cargo.toml  version = "2.0.0"
src-tauri/tauri.conf.json  "version": "2.0.0"
```

- PATCH：修复，可以不单独发布
- MINOR：一组功能，一次发布
- MAJOR：架构或数据格式变化（例如加 schema 迁移、改名）

## 流程

1. **改版本号**：上面三处 + `docs/release-<版本>.md` 发布说明
2. **自测**：`cargo test`、启动应用、跑一遍关键路径
3. **打包**：`tools/package-release.ps1 -Version <版本>`，产物在 `release/`
4. **更新 README**：发布说明链接、界面截图（有 UI 变化时重拍）
5. **提交并打 tag**：`git tag v<版本>` 指向本次提交
6. **建 draft release**：上传 zip 与 `.sha256`
7. **验收**：`tools/check-release.ps1` 全绿之后再 publish
8. **publish 后**：确认 GitHub 上 `Latest` 指向新版本，旧版本按需删除

## 验收清单

| 项 | 怎么查 |
|---|---|
| 三处版本号一致 | `tools/check-release.ps1` |
| tag 存在且指向仓库提交 | 同上 |
| zip 与 `.sha256` 匹配 | 同上 |
| Release 已上传且资产名正确 | 同上 |
| 远端资产 sha256 与本地一致 | `check-release.ps1 -VerifyDownload` |
| README 链接指向存在的说明文件 | 同上 |
| `latest` 指向本版本 | 同上 |
| 界面截图是最新界面 | 人工：`docs/screens` 与当前 UI 对照 |

## 截图与隐私

- 截图必须来自隔离假语料，不能出现真实文件名、路径、用户名
- 引导页这类会显示系统目录的界面，截图前把路径替换成 `C:\Users\demo\…`，并在 README 标注"示例路径"
- 详见 [contributing.md](contributing.md) 的自查清单

## 将来接自动更新时

`tauri-plugin-updater` 会让 release 从"新闻"变成分发基础设施：更新检查读的就是 release 资产。届时规则改为：

```
稳定通道   latest 指向正式版，每个对外版本都必须有 release
预览通道   单独 tag（如 v2.1.0-beta.1），标记 prerelease
```

在接之前，仍按上面的批量发布节奏。
