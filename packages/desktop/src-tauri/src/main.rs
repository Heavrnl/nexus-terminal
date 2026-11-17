// packages/desktop/src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct AppState {
    #[allow(dead_code)]
    sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    #[allow(dead_code)]
    native_child: Arc<Mutex<Option<std::process::Child>>>,
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

/// 读取保存的上次停留页面路由，默认直达 /workspace，若显式关闭记忆则回退首页
fn get_saved_last_route(data_dir: &Path) -> String {
    let config_path = data_dir.join("desktop-settings.json");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            // 显式关闭页面记忆时，下次启动默认回退仪表盘首页
            if let Some(remember) = val.get("rememberLastRoute").and_then(|v| v.as_bool()) {
                if !remember {
                    return "/".to_string();
                }
            }
            if let Some(r) = val.get("lastRoute").and_then(|v| v.as_str()) {
                let trimmed = r.trim();
                if !trimmed.is_empty() && trimmed != "/" && !trimmed.contains("/login") && !trimmed.contains("/setup") {
                    if trimmed.starts_with('/') {
                        return trimmed.to_string();
                    } else {
                        return format!("/{}", trimmed);
                    }
                }
            }
        }
    }
    "/workspace".to_string() // 桌面端默认直达工作区！
}

/// 保存当前窗口大小、坐标与最大化/全屏状态
fn save_window_state(data_dir: &Path, window: &tauri::WebviewWindow) {
    // 窗口已隐藏（如最小化到托盘后从托盘退出）或处于最小化状态时，保留隐藏/最小化前已记录的状态，避免被无效坐标或状态覆盖
    if !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false) {
        return;
    }

    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
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
    ws.insert("isFullscreen".to_string(), serde_json::Value::Bool(is_fullscreen));
    if !is_maximized && !is_fullscreen {
        // 未最大化且未全屏时更新实际宽度、高度与屏幕坐标
        if logical_size.width >= 400.0 && logical_size.height >= 300.0 {
            ws.insert("width".to_string(), serde_json::json!(logical_size.width));
            ws.insert("height".to_string(), serde_json::json!(logical_size.height));
        }
        ws.insert("x".to_string(), serde_json::json!(logical_pos.x));
        ws.insert("y".to_string(), serde_json::json!(logical_pos.y));
    } else if let Some(serde_json::Value::Object(old_ws)) = map.get("windowState") {
        // 最大化或全屏时保留先前的普通窗口尺寸
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

/// 启动时恢复窗口大小、坐标与最大化/全屏状态
/// apply_maximize_state 为 false 时仅恢复普通尺寸与位置（用于窗口尚未 show 时）；
/// 窗口 show 之后再传入 true，避免 Windows 下对隐藏窗口调用 maximize() 后被 show() 重置。
fn restore_window_state(data_dir: &Path, window: &tauri::WebviewWindow, apply_maximize_state: bool) {
    let config_path = data_dir.join("desktop-settings.json");
    if !config_path.exists() {
        return;
    }

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ws) = val.get("windowState") {
                let is_maximized = ws.get("isMaximized").and_then(|v| v.as_bool()).unwrap_or(false);
                let is_fullscreen = ws.get("isFullscreen").and_then(|v| v.as_bool()).unwrap_or(false);
                let width = ws.get("width").and_then(|v| v.as_f64());
                let height = ws.get("height").and_then(|v| v.as_f64());
                let x = ws.get("x").and_then(|v| v.as_f64());
                let y = ws.get("y").and_then(|v| v.as_f64());

                if !apply_maximize_state {
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
                } else {
                    if is_fullscreen {
                        let _ = window.set_fullscreen(true);
                    } else if is_maximized && !window.is_maximized().unwrap_or(false) {
                        let _ = window.maximize();
                    }
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

/// 用系统默认程序打开一个**本地**文件 —— 桌面端"外部程序打开远程文件"的最后一公里。
///
/// 分工：远程文件由后端（/api/v1/sftp/open-external）下载成本地临时副本并返回路径，
/// 前端拿到 `localPath` 后再调用这里把它交给系统。
///
/// 实现选择：直接借 shell 插件的 open（内部走 open crate，Windows 上是 ShellExecute/explorer，
/// macOS 是 open、Linux 是 xdg-open），比自己在 Rust 里拼 `cmd /c start` 更稳。从 Rust 侧调用
/// 不经过 IPC 白名单校验，所以不受 capabilities 里 open scope 的限制。
#[tauri::command]
#[allow(deprecated)] // shell 的 open 官方建议迁去 opener 插件；为一个"交给系统"的动作再加插件不划算
fn open_local_path(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        open_path_trace("ERR\t路径为空");
        return Err("打开失败：路径为空".into());
    }
    if !Path::new(trimmed).exists() {
        open_path_trace(&format!("ERR\t文件不存在\t{}", trimmed));
        return Err(format!("打开失败：文件不存在 ({})", trimmed));
    }

    match app.shell().open(trimmed, None) {
        Ok(()) => {
            open_path_trace(&format!("OK\t{}", trimmed));
            Ok(())
        }
        Err(e) => {
            open_path_trace(&format!("ERR\t系统关联启动失败\t{}\t{}", trimmed, e));
            Err(format!("打开失败：无法启动系统默认程序 ({})", e))
        }
    }
}

/// 把「外部程序打开」的结果落到临时目录的日志里。
///
/// 为什么需要：桌面端 release 构建是 GUI 子系统，没有控制台，Rust 侧的 eprintln 和
/// 前端 console 都看不到。用户报"外部程序打开失败"时只能靠这份日志定位是
/// 路径问题、文件不存在，还是系统没有可用关联程序（ShellExecute 报错）。
fn open_path_trace(line: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("nexus-desktop-open.log");
    // 每次打开追加一行，长期用会慢慢变大：超过 64 KB 就重置一次，避免变成没人清的垃圾
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 64 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, line);
    }
}

/// 智能寻找后端服务入口脚本 dist/index.js

/// 移除 Windows 上的 UNC 扩展长路径前缀 (\\?\ 或 \\?\UNC\)，规避 Node.js 的 EISDIR 路径解析缺陷
fn clean_windows_path<P: AsRef<Path>>(path: P) -> PathBuf {
    #[cfg(windows)]
    {
        let path_ref = path.as_ref();
        let path_str = path_ref.to_string_lossy();
        if path_str.starts_with(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", &path_str[8..]));
        } else if path_str.starts_with(r"\\?\") {
            return PathBuf::from(&path_str[4..]);
        }
        return path_ref.to_path_buf();
    }
    #[cfg(not(windows))]
    {
        path.as_ref().to_path_buf()
    }
}

/// 智能寻找可用 Node 运行时 (便携版同级 nexus-server.exe / 资源目录 / 系统 PATH)
fn find_node_runtime(app: &AppHandle) -> Option<PathBuf> {
    let current_exe = clean_windows_path(std::env::current_exe().unwrap_or_else(|_| PathBuf::from(".")));
    let app_dir = clean_windows_path(current_exe.parent().unwrap_or_else(|| Path::new(".")));
    let resource_dir = clean_windows_path(app.path().resource_dir().unwrap_or_else(|_| app_dir.clone()));

    let candidates = [
        app_dir.join("nexus-server.exe"),
        app_dir.join("nexus-server-x86_64-pc-windows-msvc.exe"),
        app_dir.join("node.exe"),
        resource_dir.join("nexus-server.exe"),
        resource_dir.join("nexus-server-x86_64-pc-windows-msvc.exe"),
        resource_dir.join("binaries").join("nexus-server-x86_64-pc-windows-msvc.exe"),
    ];

    for path in &candidates {
        if path.exists() {
            println!("🎯 [Nexus Desktop] 找到原生 Node.js 运行时: {:?}", path);
            return Some(clean_windows_path(path));
        }
    }

    // 检查系统 PATH 中的 node
    #[cfg(windows)]
    if let Ok(output) = std::process::Command::new("where").arg("node").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = path_str.lines().next() {
                let p = clean_windows_path(PathBuf::from(first_line.trim()));
                if p.exists() {
                    println!("🎯 [Nexus Desktop] 使用系统环境 Node.js: {:?}", p);
                    return Some(p);
                }
            }
        }
    }

    None
}

fn find_server_entry(app: &AppHandle) -> Option<PathBuf> {
    let current_exe = clean_windows_path(std::env::current_exe().unwrap_or_else(|_| PathBuf::from(".")));
    let app_dir = clean_windows_path(current_exe.parent().unwrap_or_else(|| Path::new(".")));
    let resource_dir = clean_windows_path(app.path().resource_dir().unwrap_or_else(|_| app_dir.clone()));
    let current_dir = clean_windows_path(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

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
            return Some(clean_windows_path(path));
        }
    }

    eprintln!("⚠️ [Nexus Desktop] 未找到可用的后端服务入口文件！已搜索路径:\n{:#?}", candidates);
    None
}

fn main() {
    let sidecar_child: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));
    let sidecar_child_for_manage = sidecar_child.clone();
    let sidecar_child_for_setup = sidecar_child.clone();

    let native_child: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
    let native_child_for_manage = native_child.clone();
    let native_child_for_setup = native_child.clone();

    // 优先绑定稳定的默认便携端口 18111，保障 WebView 同源 LocalStorage 与 Session 跨次有效持久化；
    let default_port = 18111;
    let target_check = format!("127.0.0.1:{}", default_port);
    let mut server_already_running = false;

    // 先检查默认端口 18111 是否已有存活服务 (例如已有后台实例正在运行)
    if std::net::TcpStream::connect(&target_check).is_ok() {
        println!("💡 [Nexus Desktop] 检测到默认端口 {} 已有存活服务，直接复用该服务！", default_port);
        server_already_running = true;
    }

    let port = if server_already_running {
        default_port
    } else if std::net::TcpListener::bind(("127.0.0.1", default_port)).is_ok() {
        default_port
    } else {
        portpicker::pick_unused_port().unwrap_or(default_port)
    };
    println!("🚀 [Nexus Desktop] 选定后台服务端口: {} (复用状态: {})", port, server_already_running);

    // 便携模式优先：数据目录默认在安装目录 / 运行程序同级的 data 文件夹
    let current_exe = clean_windows_path(std::env::current_exe().unwrap_or_else(|_| PathBuf::from(".")));
    let app_dir = clean_windows_path(current_exe.parent().unwrap_or_else(|| Path::new(".")));
    let portable_data_dir = clean_windows_path(app_dir.join("data"));

    if !portable_data_dir.exists() {
        let _ = std::fs::create_dir_all(&portable_data_dir);
    }

    let app_data_dir = clean_windows_path(&portable_data_dir).to_string_lossy().to_string();
    println!("📂 [Nexus Desktop] 数据存储目录 (就近便携优先): {}", app_data_dir);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            println!("🔔 [Nexus Desktop] 检测到重复启动实例，正在激活已有窗口...");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            sidecar_child: sidecar_child_for_manage,
            native_child: native_child_for_manage,
            server_port: port,
            data_dir: portable_data_dir.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            get_desktop_settings,
            set_desktop_settings,
            hide_main_window,
            exit_desktop_app,
            open_local_path
        ])
        .setup(move |app| {
            let handle: AppHandle = app.handle().clone();
            let sidecar_child = sidecar_child_for_setup;
            let sidecar_child_clone = sidecar_child.clone();
            let native_child = native_child_for_setup;
            let native_child_clone = native_child.clone();

            // 1. 恢复主窗口上次记录的普通尺寸与位置（最大化/全屏状态待窗口 show 后再应用）
            if let Some(main_window) = app.get_webview_window("main") {
                restore_window_state(&portable_data_dir, &main_window, false);
            }

            let mut server_started = false;

            if server_already_running {
                println!("⚡ [Nexus Desktop] 发现现有后端服务已就绪，跳过拉起，直接接入！");
                server_started = true;
            } else {
                // 2. 定位后端服务入口
                let server_entry = find_server_entry(&handle);

                if let Some(entry_path) = server_entry {
                    let clean_entry = clean_windows_path(&entry_path);
                    let entry_str = clean_entry.to_string_lossy().to_string();
                    let server_dir = clean_windows_path(
                        clean_entry
                            .parent()
                            .and_then(|p| p.parent())
                            .map(|p| p.to_path_buf())
                            .unwrap_or_else(|| app_dir.join("server"))
                    );
                    let node_modules_dir = clean_windows_path(server_dir.join("node_modules"));
                    let clean_data_dir = clean_windows_path(&portable_data_dir).to_string_lossy().to_string();

                    println!("📂 [Nexus Desktop] 后端运行根目录: {:?}", server_dir);
                    println!("📦 [Nexus Desktop] 模块加载目录 NODE_PATH: {:?}", node_modules_dir);

                    // 3. 优先尝试启动 Tauri 官方 Sidecar
                    let sidecar_result = handle
                        .shell()
                        .sidecar("nexus-server")
                        .and_then(|cmd| {
                            cmd.arg(&entry_str)
                                .current_dir(&server_dir)
                                .env("PORT", port.to_string())
                                .env("NODE_PATH", node_modules_dir.to_string_lossy().to_string())
                                .env("NEXUS_DATA_DIR", &clean_data_dir)
                                .env("NODE_ENV", "production")
                                // 后端据此判断「这是桌面端」：首次启动免建账号，直接生成无密码 admin
                                .env("NEXUS_DESKTOP", "1")
                                .spawn()
                        });

                    match sidecar_result {
                        Ok((mut rx, child)) => {
                            println!("✅ [Nexus Desktop] 通过 Tauri Sidecar 成功启动后端！PID: {}", child.pid());
                            let mut lock = sidecar_child_clone.lock().unwrap();
                            *lock = Some(child);
                            server_started = true;

                            // 异步消费 Sidecar 输出流，输出到控制台与 data/server.log
                            let log_path = portable_data_dir.join("server.log");
                            tauri::async_runtime::spawn(async move {
                                use tauri_plugin_shell::process::CommandEvent;
                                use std::io::Write;
                                let mut log_file = std::fs::OpenOptions::new()
                                    .create(true)
                                    .write(true)
                                    .append(true)
                                    .open(&log_path)
                                    .ok();

                                while let Some(event) = rx.recv().await {
                                    match event {
                                        CommandEvent::Stdout(line) => {
                                            let text = String::from_utf8_lossy(&line);
                                            print!("[Backend Stdout] {}", text);
                                            if let Some(f) = &mut log_file {
                                                let _ = f.write_all(&line);
                                            }
                                        }
                                        CommandEvent::Stderr(line) => {
                                            let text = String::from_utf8_lossy(&line);
                                            eprint!("[Backend Stderr] {}", text);
                                            if let Some(f) = &mut log_file {
                                                let _ = f.write_all(&line);
                                            }
                                        }
                                        CommandEvent::Error(err) => {
                                            eprintln!("❌ [Backend Error] Sidecar 错误: {}", err);
                                            if let Some(f) = &mut log_file {
                                                let _ = writeln!(f, "[Error] {}", err);
                                            }
                                        }
                                        CommandEvent::Terminated(payload) => {
                                            println!("⚠️ [Backend Terminated] Sidecar 进程终止，退出码: {:?}", payload.code);
                                            if let Some(f) = &mut log_file {
                                                let _ = writeln!(f, "[Terminated] Code: {:?}", payload.code);
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            });
                        }
                        Err(err) => {
                            println!("⚠️ [Nexus Desktop] Tauri Sidecar 启动未命中 ({})，正在切换至原生进程引擎启动...", err);
                            if let Some(node_exe) = find_node_runtime(&handle) {
                                let clean_node = clean_windows_path(&node_exe);
                                let mut native_cmd = std::process::Command::new(&clean_node);
                                native_cmd
                                    .arg(&entry_str)
                                    .current_dir(&server_dir)
                                    .env("PORT", port.to_string())
                                    .env("NODE_PATH", node_modules_dir.to_string_lossy().to_string())
                                    .env("NEXUS_DATA_DIR", &clean_data_dir)
                                    .env("NODE_ENV", "production")
                                    // 同上：标记桌面端运行时
                                    .env("NEXUS_DESKTOP", "1");

                                let log_path = portable_data_dir.join("server.log");
                                if let Ok(file_out) = std::fs::OpenOptions::new()
                                    .create(true)
                                    .write(true)
                                    .append(true)
                                    .open(&log_path)
                                {
                                    if let Ok(file_err) = file_out.try_clone() {
                                        native_cmd.stdout(std::process::Stdio::from(file_out));
                                        native_cmd.stderr(std::process::Stdio::from(file_err));
                                    }
                                }

                                #[cfg(windows)]
                                native_cmd.creation_flags(CREATE_NO_WINDOW);

                                match native_cmd.spawn() {
                                    Ok(child) => {
                                        println!("✅ [Nexus Desktop] 原生引擎成功拉起后端服务！PID: {}", child.id());
                                        let mut lock = native_child_clone.lock().unwrap();
                                        *lock = Some(child);
                                        server_started = true;
                                    }
                                    Err(native_err) => {
                                        eprintln!("❌ [Nexus Desktop] 原生引擎拉起亦失败: {}", native_err);
                                    }
                                }
                            } else {
                                eprintln!("❌ [Nexus Desktop] 未找到可用的 node 运行时可执行文件！");
                            }
                        }
                    }
                } else {
                    eprintln!("❌ [Nexus Desktop] 无法启动后端: 未找到 entry 文件");
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }

            if server_started {
                // 4. 后台轮询健康检查，就绪后无缝将主窗口导航至本地同源服务并优雅显示
                let handle_for_nav = handle.clone();
                let data_dir_for_nav = portable_data_dir.clone();
                std::thread::spawn(move || {
                    let target_addr = format!("127.0.0.1:{}", port);
                    let mut server_ready = false;

                    // 优化轮询间隔为 100ms，大幅加速拉起感知 (最高等待 15 秒)
                    for i in 1..=150 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if std::net::TcpStream::connect(&target_addr).is_ok() {
                            println!("🎉 [Nexus Desktop] 本地后端服务在第 {} 次尝试时就绪 (约 {}ms)！", i, i * 100);
                            server_ready = true;
                            break;
                        }
                    }

                    if let Some(window) = handle_for_nav.get_webview_window("main") {
                        if server_ready {
                            // 缓冲 100ms 确保 HTTP 和 WebSocket 监听器完全进入稳定状态
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            let now_ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            let last_route = get_saved_last_route(&data_dir_for_nav);
                            let url_str = if last_route.contains('?') {
                                format!("http://127.0.0.1:{}{}&platform=desktop&_v={}", port, last_route, now_ts)
                            } else {
                                format!("http://127.0.0.1:{}{}?platform=desktop&_v={}", port, last_route, now_ts)
                            };
                            if let Ok(target_url) = url_str.parse() {
                                println!("🌐 [Nexus Desktop] 正在将主窗口无缝直达目标页面: {}", url_str);
                                let _ = window.navigate(target_url);
                            }
                            // 短暂缓冲 120ms 等待 WebView 同步首帧渲染，然后在主线程呈现窗口并恢复最大化/全屏状态
                            std::thread::sleep(std::time::Duration::from_millis(120));
                            let handle_for_show = handle_for_nav.clone();
                            let data_dir_for_show = data_dir_for_nav.clone();
                            let _ = handle_for_nav.run_on_main_thread(move || {
                                if let Some(win) = handle_for_show.get_webview_window("main") {
                                    let _ = win.show();
                                    restore_window_state(&data_dir_for_show, &win, true);
                                    let _ = win.set_focus();
                                }
                            });
                        } else {
                            eprintln!("❌ [Nexus Desktop] 后端服务就绪超时 (15秒内未响应端口 {})", port);
                            let handle_for_show = handle_for_nav.clone();
                            let data_dir_for_show = data_dir_for_nav.clone();
                            let _ = handle_for_nav.run_on_main_thread(move || {
                                if let Some(win) = handle_for_show.get_webview_window("main") {
                                    let _ = win.show();
                                    restore_window_state(&data_dir_for_show, &win, true);
                                }
                            });
                        }
                    }
                });
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
                let native_for_close = native_child.clone();

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
                                if let Ok(mut n_lock) = native_for_close.lock() {
                                    if let Some(mut child) = n_lock.take() {
                                        let _ = child.kill();
                                        println!("🧹 [Nexus Desktop] 原生子进程清理完成！");
                                    }
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
                                if let Ok(mut n_lock) = native_for_close.lock() {
                                    if let Some(mut child) = n_lock.take() {
                                        let _ = child.kill();
                                        println!("🧹 [Nexus Desktop] 原生子进程清理完成！");
                                    }
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
                let native_child_for_instant_action = native_child.clone();

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
                                            if let Ok(mut n_lock) = native_child_for_instant_action.lock() {
                                                if let Some(mut child) = n_lock.take() {
                                                    let _ = child.kill();
                                                    println!("🧹 [Nexus Desktop] 原生子进程清理完成！");
                                                }
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
    let exit_native_ref = native_child.clone();
    app.run(move |_app_handle, event| match event {
        RunEvent::Exit => {
            println!("🚪 [Nexus Desktop] 应用收到 Exit 信号，确保清理后台进程...");
            if let Ok(mut lock) = exit_sidecar_ref.lock() {
                if let Some(child) = lock.take() {
                    let _ = child.kill();
                    println!("🧹 [Nexus Desktop] Sidecar 进程清理完成！");
                }
            }
            if let Ok(mut lock) = exit_native_ref.lock() {
                if let Some(mut child) = lock.take() {
                    let _ = child.kill();
                    println!("🧹 [Nexus Desktop] 原生子进程清理完成！");
                }
            }
        }
        _ => {}
    });
}
