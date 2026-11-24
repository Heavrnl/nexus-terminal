//! 目标机 PTY 托管会话实现：
//! - 使用 portable-pty 统一兼容 Unix openpty 与 Windows ConPTY
//! - 读写锁分离，杜绝 PTY 写背压阻塞读取与控制面
//! - 持有互斥锁完成「挂接新客户端 + 同步排入 ATTACHED/SNAPSHOT 帧」，从结构上杜绝交接丢字节/乱序竞态

use crate::protocol::{
    encode_server_data_payload, AttachedPayload, DetachedPayload, ExitedPayload, Frame,
    HostedSessionSummary, MSG_ATTACHED, MSG_DATA, MSG_DETACHED, MSG_EXITED, MSG_SNAPSHOT,
    SNAPSHOT_CHUNK_BYTES, SNAPSHOT_FLAG_IS_DELTA, SNAPSHOT_FLAG_LAST_CHUNK,
};
use crate::sys::{self, PtyKiller, PtyResizer, PtySpawnSpec};
use crate::vt_buffer::VtRingBuffer;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// 单客户端未刷出实时 DATA 缓冲上限（16MB），防止极慢连接导致目标机 OOM
const MAX_CLIENT_QUEUED_BYTES: usize = 16 * 1024 * 1024;

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 指向单个已连接客户端的有序发送句柄
#[derive(Clone)]
pub struct ClientOutbound {
    tx: mpsc::UnboundedSender<Frame>,
    queued_bytes: Arc<AtomicUsize>,
}

impl ClientOutbound {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Frame>, Arc<AtomicUsize>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        (
            Self {
                tx,
                queued_bytes: queued_bytes.clone(),
            },
            rx,
            queued_bytes,
        )
    }

    /// 发送控制/快照关键帧（绝不丢弃）
    pub fn send_control(&self, frame: Frame) -> bool {
        let len = frame.payload.len();
        self.queued_bytes.fetch_add(len, Ordering::Relaxed);
        if self.tx.send(frame).is_err() {
            self.queued_bytes.fetch_sub(len, Ordering::Relaxed);
            return false;
        }
        true
    }

    /// 发送实时 DATA 帧（若对端积压超限则跳过实时推送，避免内存膨胀，VT 状态机仍保持最新）
    pub fn send_data(&self, frame: Frame) -> bool {
        if self.queued_bytes.load(Ordering::Relaxed) >= MAX_CLIENT_QUEUED_BYTES {
            return true;
        }
        self.send_control(frame)
    }
}

#[derive(Clone)]
pub struct AttachedHandle {
    pub conn_id: u64,
    pub channel_id: u32,
    pub outbound: ClientOutbound,
}

struct SessionInner {
    owner_namespace: String,
    connection_uuid: Option<String>,
    title: String,
    created_at: u64,
    last_active_at: u64,
    detached_at: Option<u64>,
    exited: bool,
    exit_code: Option<i32>,
    exited_at: Option<u64>,
    killed: bool,
    vt: VtRingBuffer,
    attached: Option<AttachedHandle>,
}

pub struct ManagedSession {
    pub remote_session_id: String,
    inner: Arc<Mutex<SessionInner>>,
    pty_resizer: Mutex<Box<dyn PtyResizer + Send>>,
    pty_writer: Mutex<Box<dyn Write + Send>>,
    pty_killer: Mutex<Box<dyn PtyKiller + Send + Sync>>,
}

pub struct SpawnSessionParams {
    pub remote_session_id: String,
    pub owner_namespace: String,
    pub connection_uuid: Option<String>,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub term: String,
    pub shell: Option<String>,
    pub cwd: Option<String>,
}

impl ManagedSession {
    /// 启动新的目标机 PTY 与交互式 Shell，并拉起后台读取与退出监听线程
    pub fn spawn(params: SpawnSessionParams) -> io::Result<Arc<Self>> {
        let cols = params.cols.clamp(2, 1000);
        let rows = params.rows.clamp(1, 500);

        let (shell_prog, default_args) = match params
            .shell
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(custom) => (custom.to_string(), Vec::new()),
            None => sys::resolve_default_shell(),
        };

        let term = if params.term.trim().is_empty() {
            "xterm-256color"
        } else {
            params.term.trim()
        };
        let cwd = params.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty());

        let spawned = sys::spawn_pty(&PtySpawnSpec {
            program: &shell_prog,
            args: &default_args,
            term,
            session_id: &params.remote_session_id,
            cwd,
            cols,
            rows,
        })?;

        let mut reader = spawned.reader;
        let writer = spawned.writer;
        let mut waiter = spawned.waiter;
        let pty_resizer = spawned.resizer;
        let pty_killer = spawned.killer;

        let now = now_unix_secs();
        let inner = Arc::new(Mutex::new(SessionInner {
            owner_namespace: params.owner_namespace,
            connection_uuid: params.connection_uuid,
            title: params.title,
            created_at: now,
            last_active_at: now,
            detached_at: None,
            exited: false,
            exit_code: None,
            exited_at: None,
            killed: false,
            vt: VtRingBuffer::new(cols, rows),
            attached: None,
        }));

        // 1. 后台 PTY 输出读取线程：无论是否有客户端挂载，始终实时更新目标机 VT 与序号环
        let reader_inner = inner.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{}", &params.remote_session_id[..params.remote_session_id.len().min(8)]))
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            let mut guard = match reader_inner.lock() {
                                Ok(g) => g,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                            if guard.killed {
                                break;
                            }
                            let seq = guard.vt.feed(chunk);
                            guard.last_active_at = now_unix_secs();
                            if let Some(ref handle) = guard.attached {
                                let frame = Frame::new(
                                    MSG_DATA,
                                    handle.channel_id,
                                    encode_server_data_payload(seq, chunk),
                                );
                                if !handle.outbound.send_data(frame) {
                                    // 对端发送通道已关闭，自动转为脱离态
                                    guard.attached = None;
                                    guard.detached_at = Some(now_unix_secs());
                                }
                            }
                        }
                        Err(err) => {
                            if err.kind() == io::ErrorKind::Interrupted {
                                continue;
                            }
                            break;
                        }
                    }
                }
            })?;

        // 2. 后台子进程退出监听线程：记录退出码与时间戳，并通知当前挂载客户端
        let waiter_inner = inner.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{}", &params.remote_session_id[..params.remote_session_id.len().min(8)]))
            .stack_size(512 * 1024)
            .spawn(move || {
                let exit_code = waiter.wait();
                let mut guard = match waiter_inner.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.exited = true;
                guard.exit_code = exit_code;
                guard.exited_at = Some(now_unix_secs());
                if !guard.killed {
                    if let Some(ref handle) = guard.attached {
                        if let Ok(frame) = Frame::json(
                            MSG_EXITED,
                            handle.channel_id,
                            &ExitedPayload {
                                exit_code,
                                signal: None,
                            },
                        ) {
                            let _ = handle.outbound.send_control(frame);
                        }
                    }
                }
            })?;

        Ok(Arc::new(Self {
            remote_session_id: params.remote_session_id,
            inner,
            pty_resizer: Mutex::new(pty_resizer),
            pty_writer: Mutex::new(writer),
            pty_killer: Mutex::new(pty_killer),
        }))
    }

    /// 校验该会话是否归属目标命名空间（或允许跨命名空间访问）
    pub fn owner_namespace(&self) -> String {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.owner_namespace.clone()
    }

    /// 独占挂载新客户端（若已有旧客户端挂载则优雅踢出旧句柄），并在同一临界区内按序发送 ATTACHED + SNAPSHOT
    pub fn attach(
        &self,
        new_handle: AttachedHandle,
        cols: u16,
        rows: u16,
        replay: &str,
        last_seq: Option<u64>,
        created: bool,
    ) -> io::Result<()> {
        let safe_cols = cols.clamp(2, 1000);
        let safe_rows = rows.clamp(1, 500);

        // 先在未持 inner 锁前准备可能需要的 PTY resize（仅在会话未退出时执行）
        let should_resize = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            !guard.exited && guard.vt.dimensions() != (safe_cols, safe_rows)
        };
        if should_resize {
            if let Ok(resizer) = self.pty_resizer.lock() {
                let _ = resizer.resize(safe_cols, safe_rows);
            }
        }

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if should_resize && !guard.exited {
            guard.vt.resize(safe_cols, safe_rows);
        }

        // 若已有其他连接挂载，优雅踢出旧挂载句柄（不终止 PTY）
        if let Some(old) = guard.attached.take() {
            if old.conn_id != new_handle.conn_id || old.channel_id != new_handle.channel_id {
                if let Ok(frame) = Frame::json(
                    MSG_DETACHED,
                    old.channel_id,
                    &DetachedPayload {
                        reason: "taken_over_by_new_attach".to_string(),
                    },
                ) {
                    let _ = old.outbound.send_control(frame);
                }
            }
        }

        // 根据请求策略生成回放数据：delta 命中序号环则零闪烁增量补发，否则平滑走 VT full 纯净快照
        let (actual_mode, snapshot_bytes) = if created {
            ("full".to_string(), Vec::new())
        } else if replay == "delta" {
            if let Some(seq) = last_seq {
                if let Some(delta) = guard.vt.slice_delta(seq) {
                    ("delta".to_string(), delta)
                } else {
                    ("full".to_string(), guard.vt.serialize_full())
                }
            } else {
                ("full".to_string(), guard.vt.serialize_full())
            }
        } else {
            ("full".to_string(), guard.vt.serialize_full())
        };

        let (cur_cols, cur_rows) = guard.vt.dimensions();
        let current_seq = guard.vt.current_seq();
        let exited = guard.exited;
        let exit_code = guard.exit_code;

        // 在持有 inner 锁期间先把 ATTACHED + SNAPSHOT 帧排入新客户端的有序发送队列，
        // 保证 reader 线程后续产生的任何 DATA 帧都严格位于 SNAPSHOT 之后！
        let attached_frame = Frame::json(
            MSG_ATTACHED,
            new_handle.channel_id,
            &AttachedPayload {
                remote_session_id: self.remote_session_id.clone(),
                created,
                exited,
                exit_code,
                current_seq,
                replay_mode: actual_mode.clone(),
                cols: cur_cols,
                rows: cur_rows,
            },
        )?;
        new_handle.outbound.send_control(attached_frame);

        let is_delta_flag = if actual_mode == "delta" {
            SNAPSHOT_FLAG_IS_DELTA
        } else {
            0
        };

        if snapshot_bytes.is_empty() {
            // 即便快照为空也发送最后一帧结束标记，让前端明确完成快照阶段切换至实时流
            let empty_snap = Frame::new(
                MSG_SNAPSHOT,
                new_handle.channel_id,
                vec![SNAPSHOT_FLAG_LAST_CHUNK | is_delta_flag],
            );
            new_handle.outbound.send_control(empty_snap);
        } else {
            let total = snapshot_bytes.len();
            let mut offset = 0;
            while offset < total {
                let end = (offset + SNAPSHOT_CHUNK_BYTES).min(total);
                let is_last = end >= total;
                let mut payload = Vec::with_capacity(1 + (end - offset));
                let mut flags = is_delta_flag;
                if is_last {
                    flags |= SNAPSHOT_FLAG_LAST_CHUNK;
                }
                payload.push(flags);
                payload.extend_from_slice(&snapshot_bytes[offset..end]);
                new_handle
                    .outbound
                    .send_control(Frame::new(MSG_SNAPSHOT, new_handle.channel_id, payload));
                offset = end;
            }
        }

        if exited {
            if let Ok(exited_frame) = Frame::json(
                MSG_EXITED,
                new_handle.channel_id,
                &ExitedPayload {
                    exit_code,
                    signal: None,
                },
            ) {
                new_handle.outbound.send_control(exited_frame);
            }
        }

        guard.attached = Some(new_handle);
        guard.detached_at = None;
        guard.last_active_at = now_unix_secs();
        Ok(())
    }

    /// 向 PTY 标准输入写入原始字节
    pub fn write_input(&self, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.exited || guard.killed {
                return Ok(());
            }
            guard.last_active_at = now_unix_secs();
        }
        let mut writer = self.pty_writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(data)?;
        writer.flush()
    }

    /// 调整 PTY 与内置 VT 窗口尺寸
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let safe_cols = cols.clamp(2, 1000);
        let safe_rows = rows.clamp(1, 500);
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.exited || guard.killed {
                return Ok(());
            }
            guard.vt.resize(safe_cols, safe_rows);
            guard.last_active_at = now_unix_secs();
        }
        let resizer = self.pty_resizer.lock().unwrap_or_else(|e| e.into_inner());
        resizer
            .resize(safe_cols, safe_rows)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("调整 PTY 尺寸失败: {}", e)))
    }

    /// 仅当当前挂载者匹配指定 (conn_id, channel_id) 时优雅脱离（不终止 PTY）
    pub fn detach_if_match(&self, conn_id: u64, channel_id: u32, notify_client: bool) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let matched = guard
            .attached
            .as_ref()
            .map(|h| h.conn_id == conn_id && h.channel_id == channel_id)
            .unwrap_or(false);
        if matched {
            if let Some(old) = guard.attached.take() {
                if notify_client {
                    if let Ok(frame) = Frame::json(
                        MSG_DETACHED,
                        old.channel_id,
                        &DetachedPayload {
                            reason: "client_detach".to_string(),
                        },
                    ) {
                        let _ = old.outbound.send_control(frame);
                    }
                }
            }
            guard.detached_at = Some(now_unix_secs());
        }
    }

    /// 强制彻底终止 PTY 进程树并通知当前挂载客户端
    pub fn kill(&self) {
        let old_handle = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.killed = true;
            guard.exited = true;
            guard.exited_at = Some(now_unix_secs());
            guard.attached.take()
        };

        if let Some(old) = old_handle {
            if let Ok(frame) = Frame::json(
                MSG_DETACHED,
                old.channel_id,
                &DetachedPayload {
                    reason: "killed".to_string(),
                },
            ) {
                let _ = old.outbound.send_control(frame);
            }
        }

        if let Ok(mut killer) = self.pty_killer.lock() {
            killer.kill_tree();
        }
    }

    /// 判断是否达到定时回收条件
    pub fn should_reap(&self, now: u64, exited_ttl_secs: u64, detached_idle_secs: u64) -> (bool, bool) {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.killed {
            return (true, false);
        }
        // 已自然退出且无挂载，超过保留查看期（默认 24h）自动移除
        if guard.exited && guard.attached.is_none() {
            if let Some(exited_at) = guard.exited_at {
                if now.saturating_sub(exited_at) >= exited_ttl_secs {
                    return (true, false);
                }
            }
        }
        // 活跃运行中的脱离会话：仅当用户显式配置了 detached_idle_secs > 0 时才超时强杀
        if detached_idle_secs > 0 && !guard.exited && guard.attached.is_none() {
            if let Some(detached_at) = guard.detached_at {
                if now.saturating_sub(detached_at) >= detached_idle_secs {
                    return (true, true);
                }
            }
        }
        (false, false)
    }

    /// 导出会话摘要（用于 LIST / 孤儿扫描）
    pub fn summary(&self) -> HostedSessionSummary {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (cols, rows) = guard.vt.dimensions();
        HostedSessionSummary {
            remote_session_id: self.remote_session_id.clone(),
            owner_namespace: guard.owner_namespace.clone(),
            connection_uuid: guard.connection_uuid.clone(),
            title: guard.title.clone(),
            created_at: guard.created_at,
            last_active_at: guard.last_active_at,
            detached_at: guard.detached_at,
            attached: guard.attached.is_some(),
            exited: guard.exited,
            exit_code: guard.exit_code,
            cols,
            rows,
        }
    }
}
