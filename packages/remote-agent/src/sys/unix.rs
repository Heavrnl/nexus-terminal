//! Unix（Linux / macOS / BSD）平台实现：
//! - 权限 0700 Unix Domain Socket
//! - setsid 脱离控制终端 + 可选 systemd-run --user --scope 脱离 SSH login cgroup
//! - KillUserProcesses 风险探测
//! - 进程组级 SIGTERM -> SIGKILL 清理

use std::fs::{self, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};

pub type IpcStream = UnixStream;

pub struct IpcListener {
    inner: UnixListener,
    /// 持有排他 flock 文件句柄直至 daemon 退出，彻底杜绝并发冷启动互相覆写 Socket 引发脑裂；
    /// 若进程被 kill -9 强杀，内核会原子释放该锁，保障下次启动仍能自动清理 Stale Socket。
    _lock_file: fs::File,
}

impl IpcListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let path = PathBuf::from(endpoint);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            // 仅对专属运行目录收紧为 0700，避免误改系统公共目录（如 /tmp）权限
            if parent != Path::new("/tmp") && parent != Path::new("/var/tmp") {
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }

        let lock_path = format!("{}.lock", endpoint);
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&lock_path)?;

        let lock_rc = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if lock_rc != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("已有存活的 nexus-mux daemon 持有锁: {}", lock_path),
            ));
        }

        // 已独占排他锁：若此前残留死 socket（例如 kill -9），此刻可 100% 安全清理
        if path.exists() {
            let _ = fs::remove_file(&path);
        }

        let inner = UnixListener::bind(&path)?;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        Ok(Self {
            inner,
            _lock_file: lock_file,
        })
    }

    pub async fn accept(&self) -> io::Result<IpcStream> {
        let (stream, _) = self.inner.accept().await?;
        Ok(stream)
    }
}

pub async fn connect_ipc(endpoint: &str) -> io::Result<IpcStream> {
    UnixStream::connect(endpoint).await
}

pub fn cleanup_ipc_endpoint(endpoint: &str) {
    let path = Path::new(endpoint);
    if path.exists() {
        let _ = fs::remove_file(path);
    }
}

/// 确定 Unix Domain Socket 路径：
/// 1. NEXUS_MUX_SOCKET 环境变量覆盖
/// 2. $XDG_RUNTIME_DIR/nexus-mux/v1.sock（若存在且可写）
/// 3. $HOME/.nexus-terminal/run/v1.sock
/// 4. /tmp/nexus-mux-<uid>/v1.sock
pub fn default_ipc_endpoint() -> String {
    if let Some(custom) = super::env_override_endpoint() {
        return custom;
    }

    let uid = unsafe { libc::geteuid() };

    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            let dir = PathBuf::from(trimmed).join("nexus-mux");
            if fs::create_dir_all(&dir).is_ok() {
                let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
                return dir.join("v1.sock").to_string_lossy().to_string();
            }
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            let dir = PathBuf::from(trimmed).join(".nexus-terminal").join("run");
            if fs::create_dir_all(&dir).is_ok() {
                let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
                return dir.join("v1.sock").to_string_lossy().to_string();
            }
        }
    }

    let dir = PathBuf::from(format!("/tmp/nexus-mux-{}", uid));
    let _ = fs::create_dir_all(&dir);
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    dir.join("v1.sock").to_string_lossy().to_string()
}

/// Daemon 子进程初始化：脱离控制终端、忽略 SIGHUP，避免 SSH 断开信号误杀
pub fn prepare_daemon_process() {
    unsafe {
        let _ = libc::setsid();
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
}

/// 探测是否可用 systemd-run --user --scope 脱离 SSH session cgroup
fn can_use_systemd_user_scope() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    Command::new("systemd-run")
        .args(["--user", "--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        && std::env::var("XDG_RUNTIME_DIR")
            .map(|d| Path::new(&d).join("systemd").exists())
            .unwrap_or(false)
}

/// 启动后台 Daemon 并轮询等待 Unix Socket 就绪
/// 注意：绝不在客户端无锁删除 endpoint，死 Socket 清理完全交由持 flock 排他锁的 Daemon 执行，
/// 从而避免并发冷启动多个 stdio 客户端时误删刚绑定好的活跃 Socket。
pub async fn ensure_daemon_running(exe_path: &Path, endpoint: &str) -> io::Result<()> {
    if connect_ipc(endpoint).await.is_ok() {
        return Ok(());
    }

    let mut spawned = false;
    if can_use_systemd_user_scope() {
        let res = Command::new("systemd-run")
            .args([
                "--user",
                "--scope",
                "--quiet",
                "--description=Nexus Terminal Session Mux Daemon",
            ])
            .arg(exe_path)
            .args(["daemon", "--socket", endpoint])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if res.is_ok() {
            spawned = true;
        }
    }

    if !spawned {
        Command::new(exe_path)
            .args(["daemon", "--socket", endpoint])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
    }

    // 轮询等待 socket 就绪（最多 3 秒）
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if connect_ipc(endpoint).await.is_ok() {
            return Ok(());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("启动 nexus-mux daemon 超时（endpoint: {}）", endpoint),
    ))
}

/// 探测是否存在 systemd KillUserProcesses=yes 且未开启 linger 的风险
pub fn detect_persistence_warning() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }

    // 读取 /etc/systemd/logind.conf 与 /etc/systemd/logind.conf.d/*.conf
    let mut kill_user_processes = false;
    let mut conf_files = vec![PathBuf::from("/etc/systemd/logind.conf")];
    if let Ok(entries) = fs::read_dir("/etc/systemd/logind.conf.d") {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("conf") {
                conf_files.push(p);
            }
        }
    }
    for file in conf_files {
        if let Ok(text) = fs::read_to_string(&file) {
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('#') || trimmed.is_empty() {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    if k.trim().eq_ignore_ascii_case("KillUserProcesses") {
                        let val = v.trim().to_ascii_lowercase();
                        kill_user_processes = matches!(val.as_str(), "yes" | "true" | "1");
                    }
                }
            }
        }
    }

    if !kill_user_processes {
        return None;
    }

    // 检查当前用户是否已经开启 linger
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    if !user.is_empty() && Path::new("/var/lib/systemd/linger").join(&user).exists() {
        return None;
    }

    Some(format!(
        "systemd_kill_user_processes:检测到目标机启用了 KillUserProcesses=yes 且用户 {} 未开启 linger，SSH 全部断开后后台会话可能被系统终止；建议执行 sudo loginctl enable-linger {}",
        if user.is_empty() { "$USER" } else { &user },
        if user.is_empty() { "$USER" } else { &user }
    ))
}

/// 解析目标 Unix 主机默认交互式 Shell
pub fn resolve_default_shell() -> (String, Vec<String>) {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return (trimmed.to_string(), Vec::new());
        }
    }
    for candidate in ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/ash", "/bin/sh"] {
        if Path::new(candidate).exists() {
            return (candidate.to_string(), Vec::new());
        }
    }
    ("/bin/sh".to_string(), Vec::new())
}

/// 优雅终止并兜底强杀 PTY 子进程组
pub fn kill_process_tree(pid: Option<u32>, killer: &mut dyn portable_pty::ChildKiller) {
    if let Some(p) = pid {
        let pgid = p as libc::pid_t;
        unsafe {
            // 先向整个进程组发 SIGTERM
            let _ = libc::kill(-pgid, libc::SIGTERM);
        }
    }
    let _ = killer.kill();
    if let Some(p) = pid {
        let pgid = p as libc::pid_t;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            }
        });
    }
}
