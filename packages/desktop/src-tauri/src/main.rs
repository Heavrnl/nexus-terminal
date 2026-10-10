// packages/desktop/src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct AppState {
    #[allow(dead_code)]
    sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    server_port: u16,
    data_dir: PathBuf,
}

/// 读取本地持久化的窗口关闭行为配置 (返回: (close_behavior, remember_choice, action_to_execute))
fn get_saved_desktop_settings(data_dir: &Path) -> (String, bool, Option<String>) {
    let config_path = data_dir.join("desktop-settings.json");
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                let behavior = val
                    .get("closeBehavior")
                    .and_then(|v| v.as_str())
                    .unwrap_or("minimize_to_tray")
                    .to_string();
                let remember = val
                    .get("rememberCloseChoice")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let action_to_execute = val
                    .get("actionToExecute")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // 若存在弹窗刚刚确认的动作，清理标记写回磁盘，防止后续误触
                if action_to_execute.is_some() {
                    if let Some(map) = val.as_object_mut() {
                        map.remove("actionToExecute");
                        if let Ok(serialized) = serde_json::to_string_pretty(&val) {
                            let _ = std::fs::write(&config_path, serialized);
                        }
                    }
                }

                return (behavior, remember, action_to_execute);
            }
        }
    }
    ("minimize_to_tray".to_string(), false, None)
}

/// 持久化窗口关闭行为配置到本地 data 目录
fn save_close_settings(data_dir: &Path, behavior: &str, remember: bool) -> Result<(), String> {
    let config_path = data_dir.join("desktop-settings.json");
    let mut map = serde_json::Map::new();
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(serde_json::Value::Object(existing)) = serde_json::from_str(&content) {
                map = existing;
            }
        }
    }
    map.insert("closeBehavior".to_string(), serde_json::Value::String(behavior.to_string()));
    map.insert("rememberCloseChoice".to_string(), serde_json::Value::Bool(remember));
    let serialized = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, serialized).map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存当前窗口大小、坐标与最大化状态
fn save_window_state(data_dir: &Path, window: &tauri::WebviewWindow) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().unwrap_or_default();
    let position = window.outer_position().unwrap_or_default();

    let logical_size = size.to_logical::<f64>(scale_factor);
    let logical_pos = position.to_logical::<f64>(scale_factor);

    let config_path = data_dir.join("desktop-settings.json");
    let mut map = serde_json::Map::new();
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(serde_json::Value::Object(existing)) = serde_json::from_str(&content) {
                map = existing;
            }
        }
    }

    let mut ws = serde_json::Map::new();
    ws.insert("isMaximized".to_string(), serde_json::Value::Bool(is_maximized));
    if !is_maximized {
        // 未最大化时更新实际宽度、高度与屏幕坐标
        if logical_size.width >= 400.0 && logical_size.height >= 300.0 {
            ws.insert("width".to_string(), serde_json::json!(logical_size.width));
            ws.insert("height".to_string(), serde_json::json!(logical_size.height));
        }
        ws.insert("x".to_string(), serde_json::json!(logical_pos.x));
        ws.insert("y".to_string(), serde_json::json!(logical_pos.y));
    } else if let Some(serde_json::Value::Object(old_ws)) = map.get("windowState") {
        // 最大化时保留先前的普通窗口尺寸
        if let Some(w) = old_ws.get("width") { ws.insert("width".to_string(), w.clone()); }
        if let Some(h) = old_ws.get("height") { ws.insert("height".to_string(), h.clone()); }
        if let Some(x) = old_ws.get("x") { ws.insert("x".to_string(), x.clone()); }
        if let Some(y) = old_ws.get("y") { ws.insert("y".to_string(), y.clone()); }
    }
    map.insert("windowState".to_string(), serde_json::Value::Object(ws));

    if let Ok(serialized) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(&config_path, serialized);
    }
}

/// 启动时恢复窗口大小、坐标与最大化状态
fn restore_window_state(data_dir: &Path, window: &tauri::WebviewWindow) {
    let config_path = data_dir.join("desktop-settings.json");
    if !config_path.exists() {
        return;
    }

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ws) = val.get("windowState") {
                let is_maximized = ws.get("isMaximized").and_then(|v| v.as_bool()).unwrap_or(false);
                let width = ws.get("width").and_then(|v| v.as_f64());
                let height = ws.get("height").and_then(|v| v.as_f64());
                let x = ws.get("x").and_then(|v| v.as_f64());
                let y = ws.get("y").and_then(|v| v.as_f64());

                if let (Some(w), Some(h)) = (width, height) {
                    if w >= 600.0 && h >= 400.0 {
                        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                    }
                }

                if let (Some(pos_x), Some(pos_y)) = (x, y) {
                    // 仅当坐标不是异常负值且在合理屏幕范围内时还原
                    if pos_x >= -500.0 && pos_y >= 0.0 {
                        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(pos_x, pos_y)));
                    }
                }

                if is_maximized {
                    let _ = window.maximize();
                }
            }
        }
    }
}

#[tauri::command]
fn get_server_info(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "port": state.server_port,
        "url": format!("http://127.0.0.1:{}", state.server_port)
    }))
}

#[tauri::command]
fn get_desktop_settings(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let (behavior, remember, _) = get_saved_desktop_settings(&state.data_dir);
    Ok(serde_json::json!({
        "closeBehavior": behavior,
        "rememberCloseChoice": remember
    }))
}

#[tauri::command]
fn set_desktop_settings(
    state: tauri::State<AppState>,
    close_behavior: String,
    remember_close_choice: bool,
) -> Result<(), String> {
    save_close_settings(&state.data_dir, &close_behavior, remember_close_choice)
}

#[tauri::command]
fn hide_main_window(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        save_window_state(&state.data_dir, &window);
        let _ = window.hide();
        println!("📥 [Nexus Desktop] 前端触发隐藏主窗口至系统托盘");
    }
    Ok(())
}

#[tauri::command]
fn exit_desktop_app(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        save_window_state(&state.data_dir, &window);
    }
    println!("🚪 [Nexus Desktop] 前端触发退出应用");
    app.exit(0);
    Ok(())
}

/// 智能寻找后端服务入口脚本 dist/index.js
fn find_server_entry(app: &AppHandle) -> Option<PathBuf> {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let app_dir = current_exe.parent().unwrap_or_else(|| Path::new("."));
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| app_dir.to_path_buf());
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let candidates = [
        // 1. 已安装/Release 标准解压资源路径
        resource_dir.join("resources").join("server").join("dist").join("index.js"),
        resource_dir.join("server").join("dist").join("index.js"),
        // 2. 当前运行程序目录同级路径
        app_dir.join("resources").join("server").join("dist").join("index.js"),
        app_dir.join("server").join("dist").join("index.js"),
        // 3. 开发环境工作目录路径
        current_dir.join("src-tauri").join("resources").join("server").join("dist").join("index.js"),
        current_dir.join("resources").join("server").join("dist").join("index.js"),
        current_dir.join("..").join("backend").join("dist").join("index.js"),
    ];

    for path in &candidates {
        if path.exists() {
            println!("🎯 [Nexus Desktop] 找到后端服务入口: {:?}", path);
            return Some(path.clone());
        }
    }

    eprintln!("⚠️ [Nexus Desktop] 未找到可用的后端服务入口文件！已搜索路径:\n{:#?}", candidates);
    None
}

fn main() {
    let sidecar_child: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));
    let sidecar_child_for_manage = sidecar_child.clone();
    let sidecar_child_for_setup = sidecar_child.clone();

    // 自动动态获取空闲端口，避免与本地其他服务冲突
    let port = portpicker::pick_unused_port().unwrap_or(18111);
    println!("🚀 [Nexus Desktop] 选定后台服务端口: {}", port);

    // 便携模式优先：数据目录默认在安装目录 / 运行程序同级的 data 文件夹
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let app_dir = current_exe.parent().unwrap_or_else(|| Path::new("."));
    let portable_data_dir = app_dir.join("data");

    if !portable_data_dir.exists() {
        let _ = std::fs::create_dir_all(&portable_data_dir);
    }

    let app_data_dir = portable_data_dir.to_string_lossy().to_string();
    println!("📂 [Nexus Desktop] 数据存储目录 (就近便携优先): {}", app_data_dir);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            sidecar_child: sidecar_child_for_manage,
            server_port: port,
            data_dir: portable_data_dir.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            get_desktop_settings,
            set_desktop_settings,
            hide_main_window,
            exit_desktop_app
        ])
        .setup(move |app| {
            let handle: AppHandle = app.handle().clone();
            let sidecar_child = sidecar_child_for_setup;
            let sidecar_child_clone = sidecar_child.clone();

            // 1. 恢复主窗口上次记录的尺寸与位置
            if let Some(main_window) = app.get_webview_window("main") {
                restore_window_state(&portable_data_dir, &main_window);
            }

            // 2. 定位后端服务入口
            let server_entry = find_server_entry(&handle);

            if let Some(entry_path) = server_entry {
                let entry_str = entry_path.to_string_lossy().to_string();

                // 3. 启动 Node.js Sidecar 后端服务进程
                let sidecar_result = handle
                    .shell()
                    .sidecar("nexus-server")
                    .and_then(|cmd| {
                        cmd.arg(&entry_str)
                            .env("PORT", port.to_string())
                            .env("NEXUS_DATA_DIR", &app_data_dir)
                            .env("NODE_ENV", "production")
                            .spawn()
                    });

                match sidecar_result {
                    Ok((_rx, child)) => {
                        println!("✅ [Nexus Desktop] 后端 Sidecar 服务已成功启动！PID: {}", child.pid());
                        let mut lock = sidecar_child_clone.lock().unwrap();
                        *lock = Some(child);

                        // 4. 后台轮询健康检查，就绪后无缝将主窗口导航至本地同源服务
                        let handle_for_nav = handle.clone();
                        std::thread::spawn(move || {
                            let target_addr = format!("127.0.0.1:{}", port);
                            let mut server_ready = false;

                            for i in 1..=100 {
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                if std::net::TcpStream::connect(&target_addr).is_ok() {
                                    println!("🎉 [Nexus Desktop] 本地后端服务在第 {} 次尝试时就绪！", i);
                                    server_ready = true;
                                    break;
                                }
                            }

                            if server_ready {
                                // 缓冲 150ms 确保 HTTP 和 WebSocket 监听器完全进入稳定状态
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                if let Some(window) = handle_for_nav.get_webview_window("main") {
                                    let url_str = format!("http://127.0.0.1:{}?platform=desktop", port);
                                    if let Ok(target_url) = url_str.parse() {
                                        println!("🌐 [Nexus Desktop] 正在将主窗口无缝导航到本地服务: {}", url_str);
                                        let _ = window.navigate(target_url);
                                    }
                                }
                            } else {
                                eprintln!("❌ [Nexus Desktop] 后端服务就绪超时 (20秒内未响应端口 {})", port);
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("⚠️ [Nexus Desktop] 启动 Sidecar 失败: {}", err);
                    }
                }
            } else {
                eprintln!("❌ [Nexus Desktop] 无法启动后端: 未找到 entry 文件");
            }

            // 5. 配置系统托盘与托盘右键菜单 (极简现代风格)
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // 获取默认窗口图标，若无则从应用图标资源中获取 32px 尺寸
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .or_else(|| tauri::image::Image::from_app_icon_resource(32).ok())
                .expect("缺少应用窗口图标");

            let data_dir_for_tray = portable_data_dir.clone();
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip("Nexus Terminal")
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            println!("🚪 [Nexus Desktop] 用户从托盘菜单点击退出");
                            if let Some(window) = app.get_webview_window("main") {
                                save_window_state(&data_dir_for_tray, &window);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                let is_minimized = window.is_minimized().unwrap_or(false);
                                if is_visible && !is_minimized {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // 6. 监听主窗口关闭请求事件，实现记忆/弹窗询问逻辑
            if let Some(main_window) = app.get_webview_window("main") {
                let win_clone = main_window.clone();
                let data_dir_for_close = portable_data_dir.clone();
                let sidecar_for_close = sidecar_child.clone();

                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 记录当前窗口尺寸与位置
                        save_window_state(&data_dir_for_close, &win_clone);

                        let (behavior, remember, action_to_execute) = get_saved_desktop_settings(&data_dir_for_close);

                        // 优先检查是否存在刚刚弹窗点击【确定】产生的临时动作
                        if let Some(action) = action_to_execute {
                            if action == "minimize_to_tray" {
                                api.prevent_close();
                                let _ = win_clone.hide();
                                println!("📥 [Nexus Desktop] 接收到弹窗确认动作，主窗口已最小化至系统托盘");
                                return;
                            } else {
                                println!("🚪 [Nexus Desktop] 接收到弹窗确认动作，正在退出应用...");
                                let mut lock = sidecar_for_close.lock().unwrap();
                                if let Some(child) = lock.take() {
                                    let _ = child.kill();
                                    println!("🧹 [Nexus Desktop] Sidecar 进程清理完成！");
                                }
                                return;
                            }
                        }

                        if remember {
                            // 已勾选记住选择：直接按保存行为执行
                            if behavior == "minimize_to_tray" {
                                api.prevent_close();
                                let _ = win_clone.hide();
                                println!("📥 [Nexus Desktop] 窗口已按记住配置隐藏至托盘后台运行");
                            } else {
                                println!("🚪 [Nexus Desktop] 窗口已按记住配置直接退出，正在清理后台进程...");
                                let mut lock = sidecar_for_close.lock().unwrap();
                                if let Some(child) = lock.take() {
                                    let _ = child.kill();
                                    println!("🧹 [Nexus Desktop] Sidecar 进程清理完成！");
                                }
                            }
                        } else {
                            // 未勾选记住选择：阻止关闭，并向前端发送弹窗确认指令
                            api.prevent_close();
                            let _ = win_clone.show();
                            let _ = win_clone.unminimize();
                            let _ = win_clone.set_focus();

                            let eval_script = r#"
                                console.log('🔔 [Tauri Bridge] 触发窗口关闭确认逻辑');
                                if (typeof window.__NEXUS_SHOW_CLOSE_CONFIRM__ === 'function') {
                                    window.__NEXUS_SHOW_CLOSE_CONFIRM__();
                                } else {
                                    window.dispatchEvent(new CustomEvent('nexus:request-close'));
                                }
                            "#;
                            let _ = win_clone.eval(eval_script);
                            println!("❓ [Nexus Desktop] 窗口关闭拦截，已调起前端退出/最小化确认弹窗");
                        }
                    }
                });
            }

            // 7. 启动桌面端即时动作监听线程（毫秒级捕获弹窗点击【确定】事件，无需二次关闭）
            if let Some(main_window_ref) = app.get_webview_window("main") {
                let win_for_instant_action = main_window_ref.clone();
                let data_dir_for_instant_action = portable_data_dir.clone();
                let sidecar_for_instant_action = sidecar_child.clone();

                std::thread::spawn(move || {
                    let config_path = data_dir_for_instant_action.join("desktop-settings.json");
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));

                        if config_path.exists() {
                            if let Ok(content) = std::fs::read_to_string(&config_path) {
                                if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                                    if let Some(action) = val.get("actionToExecute").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                                        // 立即移除 actionToExecute 标记防止重复执行
                                        if let Some(map) = val.as_object_mut() {
                                            map.remove("actionToExecute");
                                            if let Ok(serialized) = serde_json::to_string_pretty(&val) {
                                                let _ = std::fs::write(&config_path, serialized);
                                            }
                                        }

                                        if action == "minimize_to_tray" {
                                            println!("📥 [Nexus Desktop] 毫秒级捕获到弹窗确认: 立即隐藏主窗口至系统托盘");
                                            save_window_state(&data_dir_for_instant_action, &win_for_instant_action);
                                            let _ = win_for_instant_action.hide();
                                        } else if action == "quit" {
                                            println!("🚪 [Nexus Desktop] 毫秒级捕获到弹窗确认: 立即彻底退出应用");
                                            save_window_state(&data_dir_for_instant_action, &win_for_instant_action);
                                            let mut lock = sidecar_for_instant_action.lock().unwrap();
                                            if let Some(child) = lock.take() {
                                                let _ = child.kill();
                                                println!("🧹 [Nexus Desktop] Sidecar 进程清理完成！");
                                            }
                                            std::process::exit(0);
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 Nexus Terminal 桌面端失败");

    // 7. 监听系统 Exit 事件，保障退出时 Sidecar 进程绝对被销毁
    let exit_sidecar_ref = sidecar_child.clone();
    app.run(move |_app_handle, event| match event {
        RunEvent::Exit => {
            println!("🚪 [Nexus Desktop] 应用收到 Exit 信号，确保清理 Sidecar 后台进程...");
            let mut lock = exit_sidecar_ref.lock().unwrap();
            if let Some(child) = lock.take() {
                let _ = child.kill();
                println!("🧹 [Nexus Desktop] Sidecar 进程已成功清理！");
            }
        }
        _ => {}
    });
}
