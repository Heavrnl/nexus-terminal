//! Windows OpenSSH 平台实现：
//! - 受当前用户 SID DACL 保护的 Named Pipe（\\.\pipe\nexus-mux-v1-<userHash>）
//! - CREATE_BREAKAWAY_FROM_JOB + DETACHED_PROCESS 启动后台 Daemon
//! - 脱离 Job 失败时通过一次性用户级计划任务（schtasks）自动加固脱离 sshd Job Object
//! - ConPTY 进程清理与默认 PowerShell / CMD 探测

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::ptr;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{LocalFree, ERROR_PIPE_BUSY, HLOCAL};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
};

/// 仅允许创建者 Owner 与 LocalSystem 完全访问该 Named Pipe，拒绝其他本地用户
const OWNER_ONLY_SDDL: &str = "D:(A;;GA;;;OW)(A;;GA;;;SY)";

/// 统一包装 NamedPipeServer / NamedPipeClient 为 IpcStream
pub enum IpcStream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

impl AsyncRead for IpcStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            IpcStream::Server(s) => Pin::new(s).poll_read(cx, buf),
            IpcStream::Client(c) => Pin::new(c).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for IpcStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            IpcStream::Server(s) => Pin::new(s).poll_write(cx, buf),
            IpcStream::Client(c) => Pin::new(c).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            IpcStream::Server(s) => Pin::new(s).poll_flush(cx),
            IpcStream::Client(c) => Pin::new(c).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            IpcStream::Server(s) => Pin::new(s).poll_shutdown(cx),
            IpcStream::Client(c) => Pin::new(c).poll_shutdown(cx),
        }
    }
}

/// 使用 SDDL DACL 创建受 Owner-only 保护的 NamedPipeServer 实例
fn create_secure_pipe_instance(pipe_name: &str, first_instance: bool) -> io::Result<NamedPipeServer> {
    let mut sddl_wide: Vec<u16> = OsStr::new(OWNER_ONLY_SDDL).encode_wide().collect();
    sddl_wide.push(0);

    let mut sd_ptr: *mut std::ffi::c_void = ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut sd_ptr,
            ptr::null_mut(),
        )
    };

    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first_instance)
        .reject_remote_clients(true)
        .in_buffer_size(64 * 1024)
        .out_buffer_size(64 * 1024);

    if ok != 0 && !sd_ptr.is_null() {
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: 0,
        };
        let res = unsafe {
            opts.create_with_security_attributes_raw(
                pipe_name,
                (&mut sa as *mut SECURITY_ATTRIBUTES).cast(),
            )
        };
        unsafe {
            LocalFree(sd_ptr as HLOCAL);
        }
        res
    } else {
        // SDDL 构造异常时回退默认安全属性（仍启用 reject_remote_clients）
        opts.create(pipe_name)
    }
}

pub struct IpcListener {
    endpoint: String,
    current_server: tokio::sync::Mutex<NamedPipeServer>,
}

impl IpcListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let first = create_secure_pipe_instance(endpoint, true)?;
        Ok(Self {
            endpoint: endpoint.to_string(),
            current_server: tokio::sync::Mutex::new(first),
        })
    }

    pub async fn accept(&self) -> io::Result<IpcStream> {
        let mut guard = self.current_server.lock().await;
        guard.connect().await?;
        // 立刻创建下一个监听实例替换，避免并发接入出现短暂无实例窗口
        let next = create_secure_pipe_instance(&self.endpoint, false)?;
        let connected = std::mem::replace(&mut *guard, next);
        Ok(IpcStream::Server(connected))
    }
}

pub async fn connect_ipc(endpoint: &str) -> io::Result<IpcStream> {
    let mut attempts = 0;
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(IpcStream::Client(client)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && attempts < 40 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn cleanup_ipc_endpoint(_endpoint: &str) {
    // Windows Named Pipe 由内核引用计数自动回收，无需删除磁盘文件
}

/// 生成按当前登录用户隔离的 Named Pipe 路径
pub fn default_ipc_endpoint() -> String {
    if let Some(custom) = super::env_override_endpoint() {
        return custom;
    }
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let hash = super::short_sha256(&format!("{}\\{}", domain.to_lowercase(), user.to_lowercase()));
    format!(r"\\.\pipe\nexus-mux-v1-{}", hash)
}

pub fn prepare_daemon_process() {
    // Windows 下已在 CreateProcess 标志中启用 DETACHED_PROCESS | CREATE_NO_WINDOW
}

/// 尝试通过一次性用户级计划任务脱离 sshd Job Object 拉起 Daemon（自动加固）
fn try_spawn_via_schtasks(exe_path: &Path, endpoint: &str) -> bool {
    let task_name = format!("NexusMuxDaemon_{}", super::short_sha256(endpoint));
    let exe_str = exe_path.to_string_lossy();
    let task_cmd = format!("\"{}\" daemon --socket \"{}\"", exe_str, endpoint);

    // 先静默清理可能残留的同名任务
    let _ = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", &task_name, "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let created = Command::new("schtasks.exe")
        .args([
            "/Create",
            "/TN",
            &task_name,
            "/TR",
            &task_cmd,
            "/SC",
            "ONCE",
            "/ST",
            "00:00",
            "/F",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !created {
        return false;
    }

    let ran = Command::new("schtasks.exe")
        .args(["/Run", "/TN", &task_name])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    // 任务一旦拉起即可移除计划定义，不在系统中留存常驻计划任务垃圾
    let _ = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", &task_name, "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    ran
}

/// 启动 Windows 后台 Daemon（三级策略：Breakaway -> SchTasks 自动加固 -> 降级并透传告警）
pub async fn ensure_daemon_running(exe_path: &Path, endpoint: &str) -> io::Result<()> {
    if connect_ipc(endpoint).await.is_ok() {
        return Ok(());
    }

    let breakaway_flags =
        CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW;
    let normal_flags = CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW;

    // 策略 1：优先尝试直接脱离父 Job Object
    let breakaway_res = Command::new(exe_path)
        .args(["daemon", "--socket", endpoint])
        .creation_flags(breakaway_flags)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if breakaway_res.is_err() {
        // 策略 2：若处于受限 sshd Job Object，尝试通过一次性用户级计划任务自动加固拉起
        let schtasks_ok = try_spawn_via_schtasks(exe_path, endpoint);
        if !schtasks_ok {
            // 策略 3：回退普通脱离启动，并通过环境变量通知 Daemon 上报持久化风险提示
            Command::new(exe_path)
                .args(["daemon", "--socket", endpoint])
                .env(
                    "NEXUS_MUX_PERSISTENCE_WARNING",
                    "windows_job_restricted:当前 Windows OpenSSH 会话限制了进程脱离 Job Object 且无法创建计划任务，断开全部 SSH 后后台会话可能被终止",
                )
                .creation_flags(normal_flags)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
        }
    }

    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if connect_ipc(endpoint).await.is_ok() {
            return Ok(());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("启动 Windows nexus-mux daemon 超时（pipe: {}）", endpoint),
    ))
}

pub fn detect_persistence_warning() -> Option<String> {
    std::env::var("NEXUS_MUX_PERSISTENCE_WARNING")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 解析 Windows 默认交互式 Shell（优先 PowerShell 7 / Windows PowerShell，兜底 CMD）
pub fn resolve_default_shell() -> (String, Vec<String>) {
    if let Ok(comspec) = std::env::var("NEXUS_MUX_SHELL") {
        let trimmed = comspec.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), Vec::new());
        }
    }

    // 探测 PATH 中的 pwsh.exe / powershell.exe
    if let Ok(path_env) = std::env::var("PATH") {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            for dir in std::env::split_paths(&path_env) {
                let full = dir.join(candidate);
                if full.is_file() {
                    return (
                        full.to_string_lossy().to_string(),
                        vec!["-NoLogo".to_string()],
                    );
                }
            }
        }
    }

    let cmd = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    (cmd, Vec::new())
}

pub fn kill_process_tree(pid: Option<u32>, killer: &mut dyn portable_pty::ChildKiller) {
    let _ = killer.kill();
    if let Some(p) = pid {
        // 使用 taskkill /T /F 确保杀掉 ConPTY 下的整棵子进程树
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &p.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}
