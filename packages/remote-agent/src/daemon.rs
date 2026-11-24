//! nexus-mux 常驻守护进程（Daemon）：
//! - 监听平台安全 IPC（Unix 0700 Socket / Windows Owner-only Named Pipe）
//! - 管理所有目标机托管 PTY 会话（按 ownerNamespace 逻辑隔离）
//! - 负责已退出会话清理、可选脱离空闲回收与空载 60 秒自动优雅退出

use crate::protocol::{
    decode_resize_payload, read_frame, write_frame, ErrorPayload, Frame, HelloAckPayload,
    HelloPayload, KillPayload, ListPayload, ListRespPayload, OpenOrAttachPayload, MSG_DATA,
    MSG_DETACH, MSG_ERROR, MSG_HELLO, MSG_HELLO_ACK, MSG_KILL, MSG_LIST, MSG_LIST_RESP,
    MSG_OPEN_OR_ATTACH, MSG_PING, MSG_PONG, MSG_RESIZE, MSG_STOP_DAEMON, PROTOCOL_VERSION,
};
use crate::session::{now_unix_secs, AttachedHandle, ClientOutbound, ManagedSession, SpawnSessionParams};
use crate::sys::{self, IpcListener, IpcStream};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub endpoint: String,
    /// 无任何会话且无活跃连接持续超过此秒数后 Daemon 自动退出（默认 60s；0 表示不自动退出）
    pub idle_exit_secs: u64,
    /// 进程已自然退出的会话保留历史屏幕/退出码时长（默认 24h）
    pub exited_ttl_secs: u64,
    /// 活跃运行中的脱离会话空闲强杀时长（默认 0 = 永不自动强杀）
    pub detached_idle_secs: u64,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            endpoint: sys::default_ipc_endpoint(),
            idle_exit_secs: 60,
            exited_ttl_secs: 24 * 3600,
            detached_idle_secs: 0,
        }
    }
}

struct DaemonState {
    sessions: Mutex<HashMap<String, Arc<ManagedSession>>>,
    next_conn_id: AtomicU64,
    active_clients: AtomicUsize,
    last_busy_at: AtomicU64,
    detached_idle_secs: AtomicU64,
    exited_ttl_secs: u64,
    idle_exit_secs: u64,
    persistence_warning: Option<String>,
    shutdown: Notify,
}

impl DaemonState {
    fn new(config: &DaemonConfig) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            active_clients: AtomicUsize::new(0),
            last_busy_at: AtomicU64::new(now_unix_secs()),
            detached_idle_secs: AtomicU64::new(config.detached_idle_secs),
            exited_ttl_secs: config.exited_ttl_secs,
            idle_exit_secs: config.idle_exit_secs,
            persistence_warning: sys::detect_persistence_warning(),
            shutdown: Notify::new(),
        }
    }

    fn touch_busy(&self) {
        self.last_busy_at.store(now_unix_secs(), Ordering::Relaxed);
    }

    /// 定时清理已超期会话，并在满足空载时长时触发 Daemon 优雅退出
    fn maintenance_tick(&self) -> bool {
        let now = now_unix_secs();
        let detached_idle = self.detached_idle_secs.load(Ordering::Relaxed);

        let to_kill: Vec<Arc<ManagedSession>>;
        let is_empty: bool;
        {
            let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let mut remove_ids = Vec::new();
            let mut kill_list = Vec::new();
            for (id, sess) in map.iter() {
                let (should_remove, need_kill) =
                    sess.should_reap(now, self.exited_ttl_secs, detached_idle);
                if should_remove {
                    remove_ids.push(id.clone());
                    if need_kill {
                        kill_list.push(sess.clone());
                    }
                }
            }
            for id in remove_ids {
                map.remove(&id);
            }
            to_kill = kill_list;
            is_empty = map.is_empty();
        }

        for sess in to_kill {
            sess.kill();
        }

        if !is_empty || self.active_clients.load(Ordering::Relaxed) > 0 {
            self.touch_busy();
            return false;
        }

        if self.idle_exit_secs > 0 {
            let idle_for = now.saturating_sub(self.last_busy_at.load(Ordering::Relaxed));
            if idle_for >= self.idle_exit_secs {
                return true;
            }
        }
        false
    }

    fn kill_all_sessions(&self) {
        let all: Vec<Arc<ManagedSession>> = {
            let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, s)| s).collect()
        };
        for sess in all {
            sess.kill();
        }
    }
}

/// 运行 Daemon 主循环（支持集成测试通过外部 shutdown 信号优雅停止）
pub async fn run_daemon(config: DaemonConfig) -> io::Result<()> {
    let listener = IpcListener::bind(&config.endpoint)?;
    let endpoint_cleanup = config.endpoint.clone();
    let state = Arc::new(DaemonState::new(&config));

    // 启动后台维护任务（每 5 秒检查过期会话与空载自动退出）
    let maint_state = state.clone();
    let maint_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            if maint_state.maintenance_tick() {
                maint_state.shutdown.notify_waiters();
                break;
            }
        }
    });

    loop {
        tokio::select! {
            _ = state.shutdown.notified() => {
                break;
            }
            accept_res = listener.accept() => {
                match accept_res {
                    Ok(stream) => {
                        let conn_state = state.clone();
                        tokio::spawn(async move {
                            handle_client_connection(conn_state, stream).await;
                        });
                    }
                    Err(err) => {
                        // 短暂退避避免错误风暴
                        let _ = err;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }

    maint_handle.abort();
    state.kill_all_sessions();
    sys::cleanup_ipc_endpoint(&endpoint_cleanup);
    Ok(())
}

async fn handle_client_connection(state: Arc<DaemonState>, stream: IpcStream) {
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);
    state.active_clients.fetch_add(1, Ordering::Relaxed);
    state.touch_busy();

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (outbound, mut out_rx, queued_bytes) = ClientOutbound::new();

    // 独立写任务：保证单个连接的所有出站帧严格 FIFO 串行写出
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let len = frame.payload.len();
            queued_bytes.fetch_sub(len, Ordering::Relaxed);
            if write_frame(&mut writer, &frame).await.is_err() {
                break;
            }
        }
    });

    let mut owner_namespace = String::from("default");
    // channel_id -> remote_session_id
    let mut bound_channels: HashMap<u32, String> = HashMap::new();

    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(Some(f)) => f,
            Ok(None) | Err(_) => break,
        };
        state.touch_busy();

        match frame.msg_type {
            MSG_HELLO => {
                match frame.parse_json::<HelloPayload>() {
                    Ok(hello) => {
                        if !hello.owner_namespace.trim().is_empty() {
                            owner_namespace = hello.owner_namespace.trim().to_string();
                        }
                        if let Some(hours) = hello.detached_idle_hours {
                            state
                                .detached_idle_secs
                                .store(hours.saturating_mul(3600), Ordering::Relaxed);
                        }
                        let (os, arch) = sys::platform_os_arch();
                        if let Ok(ack) = Frame::json(
                            MSG_HELLO_ACK,
                            0,
                            &HelloAckPayload {
                                protocol_version: PROTOCOL_VERSION,
                                agent_version: AGENT_VERSION.to_string(),
                                os: os.to_string(),
                                arch: arch.to_string(),
                                persistence_warning: state.persistence_warning.clone(),
                            },
                        ) {
                            outbound.send_control(ack);
                        }
                    }
                    Err(e) => {
                        send_error(&outbound, 0, "INVALID_HELLO", &e.to_string());
                    }
                }
            }

            MSG_OPEN_OR_ATTACH => {
                let channel_id = frame.channel_id;
                if channel_id == 0 {
                    send_error(&outbound, 0, "INVALID_CHANNEL", "OPEN_OR_ATTACH 需要非零 channel_id");
                    continue;
                }
                let req = match frame.parse_json::<OpenOrAttachPayload>() {
                    Ok(r) => r,
                    Err(e) => {
                        send_error(&outbound, channel_id, "INVALID_PAYLOAD", &e.to_string());
                        continue;
                    }
                };
                let remote_id = if req.remote_session_id.trim().is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    req.remote_session_id.trim().to_string()
                };

                // 若此 channel_id 之前绑定了别的会话，先优雅脱离
                if let Some(prev_id) = bound_channels.remove(&channel_id) {
                    if prev_id != remote_id {
                        let prev_sess = {
                            let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            map.get(&prev_id).cloned()
                        };
                        if let Some(s) = prev_sess {
                            s.detach_if_match(conn_id, channel_id, false);
                        }
                    }
                }

                // 查找既有会话或创建新会话
                let existing = {
                    let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    map.get(&remote_id).cloned()
                };

                let (session, created) = if let Some(sess) = existing {
                    // 安全边界：禁止跨命名空间未授权接管他人活会话（除非管理员显式携带 allow_cross_namespace）
                    if !req.allow_cross_namespace && sess.owner_namespace() != owner_namespace {
                        send_error(
                            &outbound,
                            channel_id,
                            "NAMESPACE_FORBIDDEN",
                            "禁止跨命名空间接管他人托管会话",
                        );
                        continue;
                    }
                    (sess, false)
                } else if req.attach_only {
                    send_error(
                        &outbound,
                        channel_id,
                        "SESSION_NOT_FOUND",
                        &format!("目标机不存在托管会话: {}", remote_id),
                    );
                    continue;
                } else {
                    match ManagedSession::spawn(SpawnSessionParams {
                        remote_session_id: remote_id.clone(),
                        owner_namespace: owner_namespace.clone(),
                        connection_uuid: req.connection_uuid.clone(),
                        title: req.title.unwrap_or_else(|| "Shell".to_string()),
                        cols: req.cols,
                        rows: req.rows,
                        term: req.term.clone(),
                        shell: req.shell.clone(),
                        cwd: req.cwd.clone(),
                    }) {
                        Ok(new_sess) => {
                            let mut map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            // 双重检查避免并发创建同 ID 会话
                            if let Some(raced) = map.get(&remote_id).cloned() {
                                drop(map);
                                new_sess.kill();
                                (raced, false)
                            } else {
                                map.insert(remote_id.clone(), new_sess.clone());
                                (new_sess, true)
                            }
                        }
                        Err(e) => {
                            send_error(&outbound, channel_id, "SPAWN_FAILED", &e.to_string());
                            continue;
                        }
                    }
                };

                let handle = AttachedHandle {
                    conn_id,
                    channel_id,
                    outbound: outbound.clone(),
                };
                match session.attach(
                    handle,
                    req.cols,
                    req.rows,
                    &req.replay,
                    req.last_seq,
                    created,
                ) {
                    Ok(()) => {
                        bound_channels.insert(channel_id, remote_id);
                    }
                    Err(e) => {
                        send_error(&outbound, channel_id, "ATTACH_FAILED", &e.to_string());
                    }
                }
            }

            MSG_DATA => {
                if let Some(remote_id) = bound_channels.get(&frame.channel_id) {
                    let sess = {
                        let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        map.get(remote_id).cloned()
                    };
                    if let Some(s) = sess {
                        if let Err(e) = s.write_input(&frame.payload) {
                            send_error(&outbound, frame.channel_id, "WRITE_FAILED", &e.to_string());
                        }
                    }
                }
            }

            MSG_RESIZE => {
                if let Ok((cols, rows)) = decode_resize_payload(&frame.payload) {
                    if let Some(remote_id) = bound_channels.get(&frame.channel_id) {
                        let sess = {
                            let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            map.get(remote_id).cloned()
                        };
                        if let Some(s) = sess {
                            let _ = s.resize(cols, rows);
                        }
                    }
                }
            }

            MSG_DETACH => {
                if let Some(remote_id) = bound_channels.remove(&frame.channel_id) {
                    let sess = {
                        let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        map.get(&remote_id).cloned()
                    };
                    if let Some(s) = sess {
                        s.detach_if_match(conn_id, frame.channel_id, true);
                    }
                }
            }

            MSG_KILL => {
                if frame.channel_id > 0 {
                    if let Some(remote_id) = bound_channels.remove(&frame.channel_id) {
                        let sess = {
                            let mut map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            map.remove(&remote_id)
                        };
                        if let Some(s) = sess {
                            s.kill();
                        }
                    }
                } else {
                    // channel_id = 0 允许按 remoteSessionId 直接终止未挂载的脱离会话
                    if let Ok(req) = frame.parse_json::<KillPayload>() {
                        if let Some(target_id) = req.remote_session_id {
                            let removed = {
                                let mut map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                                let allow = map.get(&target_id).map(|s| {
                                    req.force_any_namespace || s.owner_namespace() == owner_namespace
                                }).unwrap_or(false);
                                if allow {
                                    map.remove(&target_id)
                                } else {
                                    None
                                }
                            };
                            if let Some(s) = removed {
                                s.kill();
                            }
                        }
                    }
                }
            }

            MSG_LIST => {
                let req = if frame.payload.is_empty() {
                    ListPayload {
                        include_all_namespaces: false,
                    }
                } else {
                    frame.parse_json::<ListPayload>().unwrap_or(ListPayload {
                        include_all_namespaces: false,
                    })
                };

                let summaries = {
                    let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    let mut list: Vec<_> = map
                        .values()
                        .map(|s| s.summary())
                        .filter(|sum| {
                            req.include_all_namespaces || sum.owner_namespace == owner_namespace
                        })
                        .collect();
                    list.sort_by_key(|s| s.created_at);
                    list
                };

                if let Ok(resp) = Frame::json(
                    MSG_LIST_RESP,
                    frame.channel_id,
                    &ListRespPayload { sessions: summaries },
                ) {
                    outbound.send_control(resp);
                }
            }

            MSG_STOP_DAEMON => {
                state.kill_all_sessions();
                state.shutdown.notify_waiters();
                break;
            }

            MSG_PING => {
                outbound.send_control(Frame::new(MSG_PONG, frame.channel_id, frame.payload));
            }

            _ => {
                send_error(
                    &outbound,
                    frame.channel_id,
                    "UNKNOWN_MSG_TYPE",
                    &format!("未知帧类型: 0x{:02x}", frame.msg_type),
                );
            }
        }
    }

    // 连接断开时，将本连接挂载的所有会话转为脱离态（绝不杀目标机进程！）
    for (ch_id, remote_id) in bound_channels.drain() {
        let sess = {
            let map = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&remote_id).cloned()
        };
        if let Some(s) = sess {
            s.detach_if_match(conn_id, ch_id, false);
        }
    }

    drop(outbound);
    let _ = writer_task.await;
    state.active_clients.fetch_sub(1, Ordering::Relaxed);
    state.touch_busy();
}

fn send_error(outbound: &ClientOutbound, channel_id: u32, code: &str, message: &str) {
    if let Ok(frame) = Frame::json(
        MSG_ERROR,
        channel_id,
        &ErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        },
    ) {
        outbound.send_control(frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        decode_server_data_payload, AttachedPayload, DetachedPayload, MSG_ATTACHED, MSG_DETACHED,
        MSG_SNAPSHOT,
    };
    use std::time::Instant;

    fn test_endpoint(tag: &str) -> String {
        let uniq = format!("{}-{}", tag, uuid::Uuid::new_v4().simple());
        if cfg!(windows) {
            format!(r"\\.\pipe\nexus-mux-test-{}", uniq)
        } else {
            format!("/tmp/nexus-mux-test-{}.sock", uniq)
        }
    }

    async fn read_until_msg(
        stream: &mut IpcStream,
        channel_id: u32,
        msg_type: u8,
        timeout_secs: u64,
    ) -> Frame {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            let remain = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remain, read_frame(stream)).await {
                Ok(Ok(Some(f))) if f.channel_id == channel_id && f.msg_type == msg_type => {
                    return f;
                }
                Ok(Ok(Some(_))) => continue,
                other => panic!(
                    "等待 (ch={}, type=0x{:02x}) 帧失败: {:?}",
                    channel_id, msg_type, other
                ),
            }
        }
        panic!("等待 (ch={}, type=0x{:02x}) 帧超时", channel_id, msg_type);
    }

    async fn read_until_data_contains(
        stream: &mut IpcStream,
        channel_id: u32,
        needle: &str,
        timeout_secs: u64,
    ) -> (u64, String) {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        let mut acc = String::new();
        while Instant::now() < deadline {
            let remain = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remain, read_frame(stream)).await {
                Ok(Ok(Some(f))) if f.channel_id == channel_id && f.msg_type == MSG_DATA => {
                    let (seq, raw) = decode_server_data_payload(&f.payload).unwrap();
                    acc.push_str(&String::from_utf8_lossy(raw));
                    if acc.contains(needle) {
                        return (seq, acc);
                    }
                }
                Ok(Ok(Some(_))) => continue,
                _ => break,
            }
        }
        panic!("超时未收到预期输出 '{}'，实际累计输出: {:?}", needle, acc);
    }

    #[tokio::test]
    async fn test_daemon_spawn_detach_reattach_and_isolation() {
        let endpoint = test_endpoint("lifecycle");
        let cfg = DaemonConfig {
            endpoint: endpoint.clone(),
            idle_exit_secs: 0,
            exited_ttl_secs: 60,
            detached_idle_secs: 0,
        };

        let server_task = tokio::spawn(async move {
            let _ = run_daemon(cfg).await;
        });

        // 等待监听器就绪
        let mut c1 = loop {
            if let Ok(s) = sys::connect_ipc(&endpoint).await {
                break s;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        };

        // 1. 客户端 1 握手
        let hello = Frame::json(
            MSG_HELLO,
            0,
            &HelloPayload {
                protocol_version: PROTOCOL_VERSION,
                owner_namespace: "ns-alpha".into(),
                client_id: "c1".into(),
                detached_idle_hours: Some(0),
            },
        )
        .unwrap();
        write_frame(&mut c1, &hello).await.unwrap();
        let ack = read_frame(&mut c1).await.unwrap().unwrap();
        assert_eq!(ack.msg_type, MSG_HELLO_ACK);

        // 2. 在单连接上开主通道 (ch=1) 和分屏通道 (ch=2)
        let sid_main = format!("sess-main-{}", uuid::Uuid::new_v4().simple());
        let sid_pane = format!("sess-pane-{}", uuid::Uuid::new_v4().simple());
        for (ch, sid) in [(1u32, &sid_main), (2u32, &sid_pane)] {
            let open = Frame::json(
                MSG_OPEN_OR_ATTACH,
                ch,
                &OpenOrAttachPayload {
                    remote_session_id: sid.clone(),
                    cols: 80,
                    rows: 24,
                    term: "xterm-256color".into(),
                    shell: None,
                    cwd: None,
                    replay: "full".into(),
                    last_seq: None,
                    connection_uuid: Some("conn-uuid-1".into()),
                    title: Some(format!("Pane {}", ch)),
                    attach_only: false,
                    allow_cross_namespace: false,
                },
            )
            .unwrap();
            write_frame(&mut c1, &open).await.unwrap();
            let f_att = read_until_msg(&mut c1, ch, MSG_ATTACHED, 10).await;
            let att: AttachedPayload = f_att.parse_json().unwrap();
            assert!(att.created);
            let _f_snap = read_until_msg(&mut c1, ch, MSG_SNAPSHOT, 10).await;
        }

        // 3. 向主终端发送命令，确认 PTY 活着并回显标记
        let marker = "NEXUS_MUX_ALIVE_42";
        let cmd_str = format!("echo {}\r\n", marker);
        write_frame(&mut c1, &Frame::new(MSG_DATA, 1, cmd_str.into_bytes()))
            .await
            .unwrap();
        let (seq_after_marker, _) = read_until_data_contains(&mut c1, 1, marker, 10).await;
        assert!(seq_after_marker > 0);

        // 4. 客户端 2（同命名空间）抢占接管 sid_main（不先断 c1），验证独占踢出 + VT 快照还原
        let mut c2 = sys::connect_ipc(&endpoint).await.unwrap();
        write_frame(
            &mut c2,
            &Frame::json(
                MSG_HELLO,
                0,
                &HelloPayload {
                    protocol_version: PROTOCOL_VERSION,
                    owner_namespace: "ns-alpha".into(),
                    client_id: "c2".into(),
                    detached_idle_hours: None,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(read_frame(&mut c2).await.unwrap().unwrap().msg_type, MSG_HELLO_ACK);

        write_frame(
            &mut c2,
            &Frame::json(
                MSG_OPEN_OR_ATTACH,
                1,
                &OpenOrAttachPayload {
                    remote_session_id: sid_main.clone(),
                    cols: 100,
                    rows: 30,
                    term: "xterm-256color".into(),
                    shell: None,
                    cwd: None,
                    replay: "full".into(),
                    last_seq: None,
                    connection_uuid: None,
                    title: None,
                    attach_only: true,
                    allow_cross_namespace: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();

        let f_att2 = read_frame(&mut c2).await.unwrap().unwrap();
        assert_eq!(f_att2.msg_type, MSG_ATTACHED);
        let att2: AttachedPayload = f_att2.parse_json().unwrap();
        assert!(!att2.created, "应命中已存活会话而非新建");
        assert_eq!(att2.replay_mode, "full");

        let mut snap_buf = Vec::new();
        loop {
            let f = read_frame(&mut c2).await.unwrap().unwrap();
            if f.msg_type == MSG_SNAPSHOT {
                let flags = f.payload[0];
                snap_buf.extend_from_slice(&f.payload[1..]);
                if (flags & crate::protocol::SNAPSHOT_FLAG_LAST_CHUNK) != 0 {
                    break;
                }
            }
        }
        let mut verify_vt = vt100::Parser::new(
            std::num::NonZeroU16::new(30).unwrap(),
            std::num::NonZeroU16::new(100).unwrap(),
            2000,
        );
        verify_vt.process(&snap_buf);
        assert!(
            verify_vt.screen().contents().contains(marker),
            "接管后的 VT 快照应完整保留断线前输出 {}",
            marker
        );

        // 客户端 1 应收到针对 ch=1 的 DETACHED 抢占通知
        let mut got_detached = false;
        for _ in 0..20 {
            if let Ok(Ok(Some(f))) =
                tokio::time::timeout(Duration::from_millis(500), read_frame(&mut c1)).await
            {
                if f.channel_id == 1 && f.msg_type == MSG_DETACHED {
                    let det: DetachedPayload = f.parse_json().unwrap();
                    assert_eq!(det.reason, "taken_over_by_new_attach");
                    got_detached = true;
                    break;
                }
            } else {
                break;
            }
        }
        assert!(got_detached, "旧客户端 c1 应收到被抢占的 DETACHED 通知");

        // 5. 客户端 3（不同命名空间 ns-beta）调用 LIST，验证命名空间隔离
        let mut c3 = sys::connect_ipc(&endpoint).await.unwrap();
        write_frame(
            &mut c3,
            &Frame::json(
                MSG_HELLO,
                0,
                &HelloPayload {
                    protocol_version: PROTOCOL_VERSION,
                    owner_namespace: "ns-beta".into(),
                    client_id: "c3".into(),
                    detached_idle_hours: None,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let _ = read_frame(&mut c3).await.unwrap().unwrap();

        write_frame(
            &mut c3,
            &Frame::json(
                MSG_LIST,
                0,
                &ListPayload {
                    include_all_namespaces: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let list_isolated: ListRespPayload =
            read_frame(&mut c3).await.unwrap().unwrap().parse_json().unwrap();
        assert_eq!(list_isolated.sessions.len(), 0, "不同命名空间默认不可见");

        write_frame(
            &mut c3,
            &Frame::json(
                MSG_LIST,
                0,
                &ListPayload {
                    include_all_namespaces: true,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let list_all: ListRespPayload =
            read_frame(&mut c3).await.unwrap().unwrap().parse_json().unwrap();
        assert_eq!(list_all.sessions.len(), 2, "管理员开启 includeAllNamespaces 应可见全部 2 个会话");

        // 5.1 安全验证：跨命名空间未携带 allow_cross_namespace 尝试 OPEN_OR_ATTACH 必须被拒绝
        write_frame(
            &mut c3,
            &Frame::json(
                MSG_OPEN_OR_ATTACH,
                9,
                &OpenOrAttachPayload {
                    remote_session_id: sid_main.clone(),
                    cols: 80,
                    rows: 24,
                    term: "xterm-256color".into(),
                    shell: None,
                    cwd: None,
                    replay: "full".into(),
                    last_seq: None,
                    connection_uuid: None,
                    title: None,
                    attach_only: true,
                    allow_cross_namespace: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let err_frame = read_until_msg(&mut c3, 9, MSG_ERROR, 5).await;
        let err_payload: ErrorPayload = err_frame.parse_json().unwrap();
        assert_eq!(err_payload.code, "NAMESPACE_FORBIDDEN");

        // 6. 停止 Daemon 并清理
        write_frame(&mut c2, &Frame::new(MSG_STOP_DAEMON, 0, Vec::new()))
            .await
            .unwrap();
        drop(c1);
        drop(c2);
        drop(c3);
        let _ = tokio::time::timeout(Duration::from_secs(5), server_task).await;
    }

    #[tokio::test]
    async fn test_delta_reattach_remote_kill_and_idle_exit() {
        let endpoint = test_endpoint("delta-kill");
        let cfg = DaemonConfig {
            endpoint: endpoint.clone(),
            idle_exit_secs: 1,
            exited_ttl_secs: 60,
            detached_idle_secs: 0,
        };
        let server_task = tokio::spawn(async move {
            let _ = run_daemon(cfg).await;
        });

        let mut c1 = loop {
            if let Ok(s) = sys::connect_ipc(&endpoint).await {
                break s;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        };

        write_frame(
            &mut c1,
            &Frame::json(
                MSG_HELLO,
                0,
                &HelloPayload {
                    protocol_version: PROTOCOL_VERSION,
                    owner_namespace: "ns-delta".into(),
                    client_id: "c1".into(),
                    detached_idle_hours: Some(0),
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let _ = read_until_msg(&mut c1, 0, MSG_HELLO_ACK, 5).await;

        let sid = format!("sess-delta-{}", uuid::Uuid::new_v4().simple());
        write_frame(
            &mut c1,
            &Frame::json(
                MSG_OPEN_OR_ATTACH,
                1,
                &OpenOrAttachPayload {
                    remote_session_id: sid.clone(),
                    cols: 80,
                    rows: 24,
                    term: "xterm-256color".into(),
                    shell: None,
                    cwd: None,
                    replay: "full".into(),
                    last_seq: None,
                    connection_uuid: None,
                    title: Some("DeltaTest".into()),
                    attach_only: false,
                    allow_cross_namespace: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let _ = read_until_msg(&mut c1, 1, MSG_ATTACHED, 10).await;
        let _ = read_until_msg(&mut c1, 1, MSG_SNAPSHOT, 10).await;

        write_frame(&mut c1, &Frame::new(MSG_DATA, 1, b"echo BEFORE_DETACH\r\n".to_vec()))
            .await
            .unwrap();
        let (last_seq, _) = read_until_data_contains(&mut c1, 1, "BEFORE_DETACH", 10).await;

        // 在脱离前发一条带短暂延迟的命令，紧接着断开 c1，验证断线期间产生的输出可由 delta 完整接回
        let delayed_cmd = if cfg!(windows) {
            "ping -n 2 127.0.0.1 >nul && echo DURING_DETACH_99\r\n"
        } else {
            "sleep 0.3 && echo DURING_DETACH_99\r\n"
        };
        write_frame(&mut c1, &Frame::new(MSG_DATA, 1, delayed_cmd.as_bytes().to_vec()))
            .await
            .unwrap();
        write_frame(&mut c1, &Frame::new(MSG_DETACH, 1, Vec::new()))
            .await
            .unwrap();
        let _ = read_until_msg(&mut c1, 1, MSG_DETACHED, 5).await;
        drop(c1);

        tokio::time::sleep(Duration::from_millis(1500)).await;

        // c2 携带 last_seq 请求 delta 续传
        let mut c2 = sys::connect_ipc(&endpoint).await.unwrap();
        write_frame(
            &mut c2,
            &Frame::json(
                MSG_HELLO,
                0,
                &HelloPayload {
                    protocol_version: PROTOCOL_VERSION,
                    owner_namespace: "ns-delta".into(),
                    client_id: "c2".into(),
                    detached_idle_hours: None,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let _ = read_until_msg(&mut c2, 0, MSG_HELLO_ACK, 5).await;

        write_frame(
            &mut c2,
            &Frame::json(
                MSG_OPEN_OR_ATTACH,
                1,
                &OpenOrAttachPayload {
                    remote_session_id: sid.clone(),
                    cols: 80,
                    rows: 24,
                    term: "xterm-256color".into(),
                    shell: None,
                    cwd: None,
                    replay: "delta".into(),
                    last_seq: Some(last_seq),
                    connection_uuid: None,
                    title: None,
                    attach_only: true,
                    allow_cross_namespace: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();

        let att2: AttachedPayload = read_until_msg(&mut c2, 1, MSG_ATTACHED, 5)
            .await
            .parse_json()
            .unwrap();
        assert_eq!(att2.replay_mode, "delta");

        let mut delta_buf = Vec::new();
        loop {
            let f = read_until_msg(&mut c2, 1, MSG_SNAPSHOT, 5).await;
            let flags = f.payload[0];
            assert!((flags & crate::protocol::SNAPSHOT_FLAG_IS_DELTA) != 0);
            delta_buf.extend_from_slice(&f.payload[1..]);
            if (flags & crate::protocol::SNAPSHOT_FLAG_LAST_CHUNK) != 0 {
                break;
            }
        }
        let delta_text = String::from_utf8_lossy(&delta_buf).to_string();
        if !delta_text.contains("DURING_DETACH_99") {
            let (_, more) = read_until_data_contains(&mut c2, 1, "DURING_DETACH_99", 10).await;
            assert!(more.contains("DURING_DETACH_99"));
        }

        // 先脱离，再通过 channel_id = 0 远程 KILL 该脱离会话
        write_frame(&mut c2, &Frame::new(MSG_DETACH, 1, Vec::new()))
            .await
            .unwrap();
        let _ = read_until_msg(&mut c2, 1, MSG_DETACHED, 5).await;

        write_frame(
            &mut c2,
            &Frame::json(
                MSG_KILL,
                0,
                &KillPayload {
                    remote_session_id: Some(sid.clone()),
                    force_any_namespace: false,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();

        write_frame(
            &mut c2,
            &Frame::json(
                MSG_LIST,
                0,
                &ListPayload {
                    include_all_namespaces: true,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let list_after: ListRespPayload = read_until_msg(&mut c2, 0, MSG_LIST_RESP, 5)
            .await
            .parse_json()
            .unwrap();
        assert!(list_after.sessions.is_empty(), "远程 KILL 后列表应清空");

        // 断开所有客户端后，Daemon 应在空载维护滴答内自动优雅退出
        drop(c2);
        tokio::time::timeout(Duration::from_secs(10), server_task)
            .await
            .expect("无会话且无客户端后 Daemon 应自动优雅退出")
            .unwrap();
    }
}
