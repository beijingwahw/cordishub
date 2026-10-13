# CordisHub Desktop

桌面端 = **Tauri 2 壳 + JSON-RPC 内核桥**（L4）。UI 与桌面壳共享同一份
`ui/index.html`——浏览器预览与 WebView 是同一个东西，这正是选 Tauri 的意义。

## 三种运行形态

### 1. 浏览器预览（零构建，今天可用）

```bash
cordishub desktop            # 内核 serve 同源托管 UI + 拉起系统浏览器
```

### 2. Tauri 壳（需 Rust 工具链）

```bash
cordishub serve --port 8433 &   # 先起内核桥（UI 在非 http 环境自动回退到该地址）
cd packages/desktop && npm run tauri   # cargo build（debug）
./src-tauri/target/debug/cordishub-desktop.exe
```

### 3. 打包分发

```bash
cd packages/desktop/src-tauri && cargo tauri build   # 需 tauri-cli；产物 < 10MB
```

## 架构说明

- UI 全部经 JSON-RPC 方法表访问内核（14 方法），不直连 service；
- 浏览器形态：内核同源托管 UI（`GET /`），免 CORS；
- Tauri 形态：`frontendDist: ../ui` 编译期嵌入；`tauri://` 环境下 fetch 端点
  自动切换为 `http://127.0.0.1:8433`；
- 已知限制：内核桥需手动先行启动（sidecar 自动编排属 v1.x）。
