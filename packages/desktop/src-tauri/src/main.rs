// 在 Windows release 构建下隐藏控制台窗口。
// 不加这行，双击运行应用时会额外弹出一个黑色 cmd 终端，影响用户体验。
// debug_assertions 为 false 时（即 release 模式）才生效，开发期调试仍保留控制台。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 调用 lib.rs 中定义的 run()，它负责构建并启动 Tauri 应用。
    // 将启动逻辑放到 lib crate 而非直接写在 main 里，是为了让 iOS/Android
    // 等移动平台能通过 mobile_entry_point 宏复用同一套初始化代码。
    subgen_desktop_lib::run()
}
