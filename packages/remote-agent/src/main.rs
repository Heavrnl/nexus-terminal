//! nexus-mux 入口程序：单二进制支持 stdio 透明桥接、daemon 守护、list/kill/stop-daemon/version 子命令

mod daemon;
mod protocol;
mod session;
mod sys;
mod vt_buffer;

use crate::daemon::{run_daemon, DaemonConfig, AGENT_VERSION};
use crate::protocol::{
    read_frame, write_frame, Frame, HelloPayload, KillPayload, ListPayload, ListRespPayload,
    MSG_HELLO, MSG_HELLO_ACK, MSG_KILL, MSG_LIST, MSG_LIST_RESP, MSG_STOP_DAEMON, PROTOCOL_VERSION,
};
use std::env;
use std::io;
use std::process;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("stdio");

    let result = match cmd {
        "version" | "--version" | "-V" => {
            let (os, arch) = sys::platform_os_arch();
            println!(
                "nexus-mux {} (protocol={} os={} arch={})",
                AGENT_VERSION, PROTOCOL_VERSION, os, arch
            );
            Ok(())
        }
        "stdio" => run_stdio(&args[2..]).await,
        "daemon" => run_daemon_cmd(&args[2..]).await,
        "list" => run_list_cmd(&args[2..]).await,
        "kill" => run_kill_cmd(&args[2..]).await,
        "stop-daemon" => run_stop_daemon_cmd(&args[2..]).await,
        "-h" | "--help" | "help" => {
            print_help();
            Ok(())
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("未知子命令: {}（使用 --help 查看用法）", other),
        )),
    };

    if let Err(err) = result {
        eprintln!("[nexus-mux] 错误: {}", err);
        process::exit(1);
    }
}

fn print_help() {
    println!(
        "nexus-mux {} - Nexus Terminal 目标机 SSH 会话自托管守护代理\n\
         用法:\n\
           nexus-mux stdio [--socket <path>]                SSH exec 二进制帧透明转发入口（自动拉起 daemon）\n\
           nexus-mux daemon [--socket <path>] [--idle-exit-secs 60] [--exited-ttl-secs 86400] [--detached-idle-secs 0]\n\
           nexus-mux list [--socket <path>] [--namespace <ns>] [--all]\n\
           nexus-mux kill <remoteSessionId> [--socket <path>] [--namespace <ns>] [--force]\n\
           nexus-mux stop-daemon [--socket <path>]\n\
           nexus-mux version",
        AGENT_VERSION
    );
}

fn parse_flag_value(args: &[String], flag: &str) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            return args.get(i + 1).cloned();
        }
        if let Some(v) = args[i].strip_prefix(&format!("{}=", flag)) {
            return Some(v.to_string());
        }
        i += 1;
    }
    None
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn resolve_endpoint(args: &[String]) -> String {
    parse_flag_value(args, "--socket").unwrap_or_else(sys::default_ipc_endpoint)
}

async fn run_daemon_cmd(args: &[String]) -> io::Result<()> {
    sys::prepare_daemon_process();
    let mut cfg = DaemonConfig::default();
    cfg.endpoint = resolve_endpoint(args);
    if let Some(v) = parse_flag_value(args, "--idle-exit-secs").and_then(|s| s.parse().ok()) {
        cfg.idle_exit_secs = v;
    }
    if let Some(v) = parse_flag_value(args, "--exited-ttl-secs").and_then(|s| s.parse().ok()) {
        cfg.exited_ttl_secs = v;
    }
    if let Some(v) = parse_flag_value(args, "--detached-idle-secs").and_then(|s| s.parse().ok()) {
        cfg.detached_idle_secs = v;
    }
    run_daemon(cfg).await
}

/// SSH exec 透明转发桥：自动拉起后台 Daemon，在 stdin/stdout 与本机安全 IPC 之间全双工直传二进制帧
async fn run_stdio(args: &[String]) -> io::Result<()> {
    let endpoint = resolve_endpoint(args);
    let exe_path = env::current_exe()?;
    let ipc = sys::connect_or_spawn_daemon(&exe_path, &endpoint).await?;

    let (mut ipc_read, mut ipc_write) = tokio::io::split(ipc);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    let to_daemon = async {
        let _ = tokio::io::copy(&mut stdin, &mut ipc_write).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut ipc_write).await;
    };
    let to_client = async {
        let _ = tokio::io::copy(&mut ipc_read, &mut stdout).await;
        let _ = tokio::io::AsyncWriteExt::flush(&mut stdout).await;
    };

    tokio::select! {
        _ = to_daemon => {}
        _ = to_client => {}
    }

    Ok(())
}

async fn run_list_cmd(args: &[String]) -> io::Result<()> {
    let endpoint = resolve_endpoint(args);
    let mut stream = match sys::connect_ipc(&endpoint).await {
        Ok(s) => s,
        Err(_) => {
            // Daemon 未运行说明当前无托管会话，直接返回空 JSON
            println!(r#"{{"sessions":[]}}"#);
            return Ok(());
        }
    };

    let ns = parse_flag_value(args, "--namespace").unwrap_or_else(|| "default".to_string());
    let include_all = has_flag(args, "--all");

    write_frame(
        &mut stream,
        &Frame::json(
            MSG_HELLO,
            0,
            &HelloPayload {
                protocol_version: PROTOCOL_VERSION,
                owner_namespace: ns,
                client_id: "cli-list".to_string(),
                detached_idle_hours: None,
            },
        )?,
    )
    .await?;
    let ack = read_frame(&mut stream).await?;
    if ack.map(|f| f.msg_type) != Some(MSG_HELLO_ACK) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Daemon 握手失败"));
    }

    write_frame(
        &mut stream,
        &Frame::json(
            MSG_LIST,
            0,
            &ListPayload {
                include_all_namespaces: include_all,
            },
        )?,
    )
    .await?;
    if let Some(resp) = read_frame(&mut stream).await? {
        if resp.msg_type == MSG_LIST_RESP {
            let parsed: ListRespPayload = resp.parse_json()?;
            println!("{}", serde_json::to_string(&parsed).unwrap_or_else(|_| r#"{"sessions":[]}"#.into()));
            return Ok(());
        }
    }
    println!(r#"{{"sessions":[]}}"#);
    Ok(())
}

async fn run_kill_cmd(args: &[String]) -> io::Result<()> {
    let target_id = args
        .first()
        .filter(|s| !s.starts_with("--"))
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缺少要终止的 remoteSessionId"))?;
    let endpoint = resolve_endpoint(args);
    let mut stream = match sys::connect_ipc(&endpoint).await {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let ns = parse_flag_value(args, "--namespace").unwrap_or_else(|| "default".to_string());
    let force = has_flag(args, "--force");

    write_frame(
        &mut stream,
        &Frame::json(
            MSG_HELLO,
            0,
            &HelloPayload {
                protocol_version: PROTOCOL_VERSION,
                owner_namespace: ns,
                client_id: "cli-kill".to_string(),
                detached_idle_hours: None,
            },
        )?,
    )
    .await?;
    let _ = read_frame(&mut stream).await?;

    write_frame(
        &mut stream,
        &Frame::json(
            MSG_KILL,
            0,
            &KillPayload {
                remote_session_id: Some(target_id),
                force_any_namespace: force,
            },
        )?,
    )
    .await?;
    Ok(())
}

async fn run_stop_daemon_cmd(args: &[String]) -> io::Result<()> {
    let endpoint = resolve_endpoint(args);
    if let Ok(mut stream) = sys::connect_ipc(&endpoint).await {
        let _ = write_frame(&mut stream, &Frame::new(MSG_STOP_DAEMON, 0, Vec::new())).await;
    }
    sys::cleanup_ipc_endpoint(&endpoint);
    Ok(())
}
