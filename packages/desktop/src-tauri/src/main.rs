// CordisHub Desktop — Tauri 2 壳。
// UI（../ui/index.html，编译期嵌入）通过 JSON-RPC 访问内核：
// 运行壳之前先启动内核桥 `cordishub serve --port 8433`（UI 在非 http 环境下
// 自动回退到 http://127.0.0.1:8433）。sidecar 自动拉起属后续工作。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running cordishub desktop");
}
