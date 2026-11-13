# 贡献与截图规范

## 截图必须用假语料

仓库里的界面截图会公开，**禁止使用任何真实文件、路径或用户名**。统一用隔离脚本生成：

```powershell
# 启动临时实例（假语料 + 独立数据目录 + 独立 WebView2 目录），自动截两张图
powershell -File tools/capture-screens.ps1
```

脚本会：
1. 调用 `tools/make-demo-corpus.ps1` 在 `%TEMP%\tf-shots\corpus` 生成虚构文件（季度预算报告、会议纪要等）
2. 用 `TRACEFIND_DATA_DIR` / `TRACEFIND_CONFIG_DIR` / `WEBVIEW2_USER_DATA_FOLDER` 指向临时目录，**不触碰真实索引**
3. 截图输出到 `docs/screens/`

## 提交前自查

```powershell
# 不应有输出
git grep -n -I 'C:\\Users\\|Administrator|Documents\\|Desktop\\' -- . ':!docs/screens'
```

## 其它约定

- 提交信息用中文，前缀 `feat(...)` / `fix(...)` / `chore(...)`
- 每次改动附带可复跑的验证：`cargo test`、`node tools/verify-*.mjs`、`tools/run-isolated.ps1`
- 发布：`tools/package-release.ps1` 打包，`tools/publish-release.ps1` 上传（需 `gh auth login`）