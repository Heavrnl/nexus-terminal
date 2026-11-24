//! 跨平台操作系统抽象层（Unix: Linux / macOS；Windows: ConPTY + Named Pipe）

use std::io;
use std::path::Path;

#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
pub use unix::{
    cleanup_ipc_endpoint, connect_ipc, default_ipc_endpoint, detect_persistence_warning,
    ensure_daemon_running, kill_process_tree, prepare_daemon_process, resolve_default_shell,
    IpcListener, IpcStream,
};

#[cfg(windows)]
pub use windows::{
    cleanup_ipc_endpoint, connect_ipc, default_ipc_endpoint, detect_persistence_warning,
    ensure_daemon_running, kill_process_tree, prepare_daemon_process, resolve_default_shell,
    IpcListener, IpcStream,
};

/// 计算短 SHA256 十六进制指纹，用于隔离不同用户/端点路径
#[allow(dead_code)]
pub fn short_sha256(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for b in &digest[..8] {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// 返回标准化的 OS 与架构标签（与后端 manifest.json 对齐）
pub fn platform_os_arch() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        std::env::consts::OS
    };

    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        "arm" => "armv7",
        other => other,
    };

    (os, arch)
}

/// 检查环境变量覆盖的自定义 IPC 端点（测试与多实例隔离用）
pub fn env_override_endpoint() -> Option<String> {
    std::env::var("NEXUS_MUX_SOCKET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 供主入口调用：保证指定端点 Daemon 运行并连上 IPC 流
pub async fn connect_or_spawn_daemon(exe_path: &Path, endpoint: &str) -> io::Result<IpcStream> {
    if let Ok(stream) = connect_ipc(endpoint).await {
        return Ok(stream);
    }
    ensure_daemon_running(exe_path, endpoint).await?;
    connect_ipc(endpoint).await
}
