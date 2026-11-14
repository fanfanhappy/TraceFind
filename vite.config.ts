import { defineConfig } from 'vite'

// Tauri 开发配置：固定 1420 端口，并让文件监听忽略 Rust 侧与产出的临时目录。
// （不加 ignored 时，编辑器/工具在 src-tauri 下创建的临时文件会让 watcher 抛 EBUSY 并退出。）
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/shots/**',
        '**/.ui-profile/**',
        '**/_dsh_acl_recovery/**',
        '**/dist/**',
        '**/target/**',
      ],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
        settings: 'settings.html',
        tray: 'tray-menu.html',
      },
    },
  },
})
