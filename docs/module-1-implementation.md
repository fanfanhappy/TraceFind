# TraceFind · 模块一实现

按《TraceFind｜模块一视觉与交互设计方案 V1.0》落地的桌面外壳。
搜索、索引与 AI 能力按路线图属于后续模块，本阶段只交付"入口"本身。

- 技术栈：Tauri 2 + Rust（窗口/快捷键/托盘/生命周期）+ React 19 + TypeScript + Vite 7
- 目标平台：Windows 10 1809+ / Windows 11（WebView2）
- 当前版本：0.1.0（M1.1 + M1.2 + M1.3）

## 一、说明书条目对照

| 说明书条目 | 实现位置 | 状态 |
|---|---|---|
| 02 主窗口 800×540、无边框、圆角 16–20 | `src-tauri/tauri.conf.json`、`src/styles/glass.css`、`src/native.rs`（DWM 圆角） | 完成 |
| 02 品牌栏 48px / 搜索区 64px / 状态栏 44px | `src/styles/tokens.css`、`src/components/BrandBar.tsx`、`SearchField.tsx`、`StatusBar.tsx` | 完成 |
| 02 居中于当前活动显示器 | `src-tauri/src/windowing.rs`（光标所在显示器 + DPI 换算） | 完成 |
| 03 深色色板（#17191F / #22252E / #30343F / #414654 / #8B8CFF…） | `src/styles/tokens.css` | 完成 |
| 03 浅色主题重新校准（非反色） | 同上 `[data-theme="light"]` | 完成 |
| 03 Segoe UI Variable + 雅黑 UI、Lucide 1.75–2px、8px 栅格 | `tokens.css`、各组件 | 完成 |
| 04 Mica/Acrylic + Win10 降级 | `src-tauri/src/material.rs`（window-vibrancy）、`glass.css` | 完成 |
| 04 材质明暗跟随主题 | 前端解析 `system` → `set_window_dark` → 主/设置窗口同时重应用 | 完成 |
| 04 不用 backdrop-filter 冒充跨应用模糊 | `glass.css` 注释与实现（原生材质时不叠加 backdrop-filter） | 完成 |
| 05 空状态 3–5 项 | `src/components/EmptyState.tsx`（最近使用 3 项 + 快捷位置） | 完成 |
| 05 结果状态键盘操作 | `src/windows/Launcher.tsx` | 完成 |
| 05 快速预览仅预留接口 | `src/components/PreviewDrawer.tsx`（占位，模块六替换内部） | 预留 |
| 05 设置窗口 7 个分类 | `settings.html` + `src/windows/Settings.tsx` | 完成（后 3 类标注"后续"） |
| 05 设置窗口返回搜索 | 品牌栏左上角「←」+ `Esc`（`backToSearch()`） | 完成 |
| 05 索引状态 / 托盘菜单 | `StatusBar` 胶囊、`src-tauri/src/tray_manager.rs` | 完成（模块二已接入真实索引与暂停/继续） |
| 06 唤起 180ms / 隐藏 120ms / 轻弹簧 | `src/styles/animation.css`、`src/lib/bridge.ts` | 完成 |
| 06 失焦延迟 150–200ms 判定 | `src-tauri/src/lifecycle.rs`（190ms + 复核焦点 + 抑制窗口） | 完成 |
| 06 再次快捷键隐藏 / Esc / 关闭到托盘 | `lifecycle.rs`、`tauri.conf.json`、`main.rs` | 完成 |
| 07 Tauri 2 + Rust 管理真实状态 | `src-tauri/src/{lifecycle,state,windowing}.rs` | 完成 |
| 07 统一事件协议 | `launcher:show` / `launcher:hide` / `launcher:focus` / `launcher:animation-finished` | 完成 |
| 08 交互/视觉验收 | 见下方"验证" | 通过 |
| 08 P95 < 150ms | 实测 P95 = 12ms（40 次热唤起） | 达标 |

### 实测性能（release 构建，3840×2160 @150% DPI）

| 指标 | 结果 |
|---|---|
| 冷启动（进程启动 → 窗口可交互） | 102ms |
| 热唤起（触发 → 窗口已显示）P50 / P95 / Max | 8ms / 12ms / 12ms |
| 唤起动画时长（设计值 160–200ms）P50 / P95 | 180ms / 192ms |
| 隐藏动画（设计值 100–140ms） | 120ms（CSS 变量，未单独采样） |

测量方式：`node tools/measure-launcher-latency.mjs 9223 <log> 20`。
日志里的两个时间戳分别对应"窗口已显示（可交互）"和"唤起完成"，前者才是 150ms 指标的口径；
后者是说明书 06 规定的视觉动画时长，两者不应混为一谈。

## 二、事件协议与状态机

```
按键/托盘 ──► Rust lifecycle::show
                ├─ 记录 Showing
                ├─ 定位到光标所在显示器
                ├─ window.show() + set_focus()
                └─ emit launcher:show
                              │
React 收到 ──► 播放 show 动画（180ms）
                └─ onAnimationEnd → invoke launcher_animation_finished("show")
                              │
Rust         ──► Phase::Visible
```

隐藏方向对称：`launcher:hide` → 前端 120ms 退场 → `launcher_animation_finished("hide")` → `window.hide()`。
Rust 另有 320ms 兜底，前端因不可见而未触发 `animationend` 时也会收起。

**双份状态的分工**：Rust 持有 `Phase`（Hidden/Showing/Visible/Hiding）与真实窗口可见性；
React 只持有 `data-phase`（showing/visible/hiding）用于驱动 CSS 动画，不做业务判断。

## 二点五、主题与原生材质的一致性

Mica/Acrylic 的明暗是系统绘制的一层背景，必须与界面主题一致，否则浅色界面会套上深色
Mica，整窗呈灰紫色。`system` 只有在渲染进程里才能解析（`matchMedia`），所以：

```
useTheme 解析出 dark/light
        → invoke set_window_dark({ dark })
        → Rust 对 main + settings 两个窗口重应用材质
        → RuntimeInfo.windowDark 可断言
```

启动顺序也按此约定：前端先 `set_window_dark` 再 `frontend_ready`，窗口出现时就是对的颜色。

## 三、命令与权限

前端只通过以下命令访问系统能力（`src-tauri/src/commands.rs`）：

`get_settings` `patch_settings` `apply_hotkey` `get_runtime_info` `frontend_ready`
`launcher_animation_finished` `show_launcher` `hide_launcher` `toggle_launcher`
`open_settings` `close_settings` `quit_app` `open_path` `reveal_path`

窗口级权限收在 `src-tauri/capabilities/default.json`：仅放开拖拽、置顶、显隐、关闭、事件与两个插件。

## 四、验证

三套脚本，全部可复跑：

```powershell
# 1) 界面与键盘交互（无头 Chromium，16 项断言 + 9 张截图）
pnpm build
node tools/verify-ui.mjs http://127.0.0.1:1420/ shots

# 2) 生命周期状态机（需要运行中的桌面程序 + WebView2 调试端口）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
src-tauri\target\release\aura-search.exe
node tools/verify-lifecycle.mjs 9223

# 3) 设置窗口 / 开机启动 / 置顶
node tools/verify-settings-window.mjs 9223

# 3b) 设置窗口「返回搜索」按钮与 Esc 返回
node tools/verify-back-to-search.mjs 9223

# 4) 唤起延迟（P50/P95）
node tools/measure-launcher-latency.mjs 9223 "$env:LOCALAPPDATA\com.tracefind.desktop\logs\tracefind.log" 20
```

已通过的结果见 `shots/`：深色与浅色主界面、结果高亮、预览抽屉、设置窗口 4 个分类页。

## 五、已知限制（明说，不藏）

1. **Alt + Space 在本机被占用**：启动时注册失败会走冲突分支——状态栏出现「快捷键冲突」胶囊，
   设置 → 快捷键 可改绑，改绑先验证后替换、失败回滚。本机实测改用 `Ctrl+Alt+Space` 成功。
2. ~~列表是演示数据~~：模块二已替换为真实索引查询，见 `docs/module-2-implementation.md`。
3. **预览是占位**：`PreviewDrawer` 只保留布局与状态接口，模块六接入真实预览。
4. **P95 < 150ms 已实测达标**（12ms）；但冷启动 102ms 与动画 180ms 是不同口径，别混着引用。
5. **索引类设置**：设置窗口保留入口并标注"后续"，不提供空壳控件（说明书要求"显示为后续规划或隐藏"）。
