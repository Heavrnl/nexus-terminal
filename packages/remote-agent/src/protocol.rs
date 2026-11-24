//! nexus-mux 二进制帧协议（Wire Protocol v1）
//!
//! 帧结构（大端序）：
//!   [4B payload_len][1B msg_type][4B channel_id][payload_len B payload]
//!
//! - channel_id = 0 表示控制面帧（HELLO / LIST / PING / 全局 KILL）
//! - channel_id >= 1 表示某条逻辑 PTY 通道（主终端与多终端分屏复用同一条 SSH exec 隧道）

use serde::{Deserialize, Serialize};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const FRAME_HEADER_LEN: usize = 9;
/// 单帧最大负载上限（16MB），防止损坏流或恶意帧导致 OOM
pub const MAX_FRAME_PAYLOAD_LEN: usize = 16 * 1024 * 1024;
/// 快照分片大小（64KB）
pub const SNAPSHOT_CHUNK_BYTES: usize = 64 * 1024;

// --- 帧类型常量 ---
pub const MSG_HELLO: u8 = 0x01;
pub const MSG_HELLO_ACK: u8 = 0x02;
pub const MSG_OPEN_OR_ATTACH: u8 = 0x10;
pub const MSG_ATTACHED: u8 = 0x11;
pub const MSG_SNAPSHOT: u8 = 0x12;
pub const MSG_DATA: u8 = 0x13;
pub const MSG_RESIZE: u8 = 0x14;
pub const MSG_DETACH: u8 = 0x15;
pub const MSG_DETACHED: u8 = 0x16;
pub const MSG_KILL: u8 = 0x17;
pub const MSG_EXITED: u8 = 0x18;
pub const MSG_LIST: u8 = 0x20;
pub const MSG_LIST_RESP: u8 = 0x21;
pub const MSG_STOP_DAEMON: u8 = 0x2F;
pub const MSG_PING: u8 = 0x30;
pub const MSG_PONG: u8 = 0x31;
pub const MSG_ERROR: u8 = 0x7F;

// --- 快照分片标志位 ---
pub const SNAPSHOT_FLAG_LAST_CHUNK: u8 = 0x01;
pub const SNAPSHOT_FLAG_IS_DELTA: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub msg_type: u8,
    pub channel_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(msg_type: u8, channel_id: u32, payload: Vec<u8>) -> Self {
        Self {
            msg_type,
            channel_id,
            payload,
        }
    }

    pub fn json<T: Serialize>(msg_type: u8, channel_id: u32, value: &T) -> io::Result<Self> {
        let payload = serde_json::to_vec(value)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(Self::new(msg_type, channel_id, payload))
    }

    pub fn parse_json<T: for<'de> Deserialize<'de>>(&self) -> io::Result<T> {
        serde_json::from_slice(&self.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// 编码为连续字节缓冲
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        if self.payload.len() > MAX_FRAME_PAYLOAD_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("帧负载超出上限: {} bytes", self.payload.len()),
            ));
        }
        let mut buf = Vec::with_capacity(FRAME_HEADER_LEN + self.payload.len());
        buf.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        buf.push(self.msg_type);
        buf.extend_from_slice(&self.channel_id.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        Ok(buf)
    }
}

/// 从异步流读取一帧；对端正常 EOF 时返回 Ok(None)
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut header = [0u8; FRAME_HEADER_LEN];
    let mut read_so_far = 0;
    while read_so_far < FRAME_HEADER_LEN {
        let n = reader.read(&mut header[read_so_far..]).await?;
        if n == 0 {
            if read_so_far == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "读取帧头时遇到意外 EOF",
            ));
        }
        read_so_far += n;
    }

    let payload_len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if payload_len > MAX_FRAME_PAYLOAD_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("收到非法超大帧: {} bytes", payload_len),
        ));
    }
    let msg_type = header[4];
    let channel_id = u32::from_be_bytes([header[5], header[6], header[7], header[8]]);

    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        reader.read_exact(&mut payload).await?;
    }

    Ok(Some(Frame {
        msg_type,
        channel_id,
        payload,
    }))
}

/// 向异步流写入一帧并 flush
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> io::Result<()> {
    let encoded = frame.encode()?;
    writer.write_all(&encoded).await?;
    writer.flush().await
}

/// 构造服务端下发的 DATA 帧负载（前 8 字节大端 seq + 原始字节）
pub fn encode_server_data_payload(seq: u64, raw: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + raw.len());
    payload.extend_from_slice(&seq.to_be_bytes());
    payload.extend_from_slice(raw);
    payload
}

/// 解析服务端下发的 DATA 帧负载
#[cfg(test)]
pub fn decode_server_data_payload(payload: &[u8]) -> io::Result<(u64, &[u8])> {
    if payload.len() < 8 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "DATA 帧长度不足 8 字节",
        ));
    }
    let seq = u64::from_be_bytes([
        payload[0], payload[1], payload[2], payload[3], payload[4], payload[5], payload[6],
        payload[7],
    ]);
    Ok((seq, &payload[8..]))
}

/// 构造 RESIZE 帧负载（2 字节 cols + 2 字节 rows）
#[cfg(test)]
pub fn encode_resize_payload(cols: u16, rows: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4);
    payload.extend_from_slice(&cols.to_be_bytes());
    payload.extend_from_slice(&rows.to_be_bytes());
    payload
}

/// 解析 RESIZE 帧负载
pub fn decode_resize_payload(payload: &[u8]) -> io::Result<(u16, u16)> {
    if payload.len() != 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "RESIZE 帧长度必须为 4 字节",
        ));
    }
    let cols = u16::from_be_bytes([payload[0], payload[1]]);
    let rows = u16::from_be_bytes([payload[2], payload[3]]);
    Ok((cols, rows))
}

// --- JSON 载荷结构定义 ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPayload {
    pub protocol_version: u32,
    #[serde(default)]
    pub owner_namespace: String,
    #[serde(default)]
    pub client_id: String,
    /// 可选：全局脱离会话空闲超时（小时，0 表示活跃会话永不自动强杀）
    #[serde(default)]
    pub detached_idle_hours: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAckPayload {
    pub protocol_version: u32,
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistence_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrAttachPayload {
    pub remote_session_id: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_term")]
    pub term: String,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// "full"（默认，走 VT 纯净快照）或 "delta"（弱网断线就地增量续传）
    #[serde(default = "default_replay_mode")]
    pub replay: String,
    #[serde(default)]
    pub last_seq: Option<u64>,
    #[serde(default)]
    pub connection_uuid: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// 若为 true，仅在已存在会话时 attach，不自动创建新 PTY
    #[serde(default)]
    pub attach_only: bool,
    /// 若为 true，允许管理员在孤儿排查场景下显式认领其他命名空间的会话；默认 false 严格隔离
    #[serde(default)]
    pub allow_cross_namespace: bool,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}
fn default_term() -> String {
    "xterm-256color".to_string()
}
fn default_replay_mode() -> String {
    "full".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedPayload {
    pub remote_session_id: String,
    pub created: bool,
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub current_seq: u64,
    pub replay_mode: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPayload {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillPayload {
    #[serde(default)]
    pub remote_session_id: Option<String>,
    #[serde(default)]
    pub force_any_namespace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitedPayload {
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPayload {
    #[serde(default)]
    pub include_all_namespaces: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedSessionSummary {
    pub remote_session_id: String,
    pub owner_namespace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_uuid: Option<String>,
    pub title: String,
    pub created_at: u64,
    pub last_active_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached_at: Option<u64>,
    pub attached: bool,
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRespPayload {
    pub sessions: Vec<HostedSessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn test_frame_roundtrip_and_eof() {
        let f1 = Frame::json(
            MSG_HELLO,
            0,
            &HelloPayload {
                protocol_version: PROTOCOL_VERSION,
                owner_namespace: "ns-abc".into(),
                client_id: "client-1".into(),
                detached_idle_hours: Some(0),
            },
        )
        .unwrap();
        let f2 = Frame::new(MSG_DATA, 3, encode_server_data_payload(42, b"hello \xe4\xb8\xad\xe6\x96\x87"));
        let f3 = Frame::new(MSG_RESIZE, 3, encode_resize_payload(120, 40));

        let mut buf = Vec::new();
        write_frame(&mut buf, &f1).await.unwrap();
        write_frame(&mut buf, &f2).await.unwrap();
        write_frame(&mut buf, &f3).await.unwrap();

        let mut cursor = Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).await.unwrap(), Some(f1));

        let r2 = read_frame(&mut cursor).await.unwrap().unwrap();
        assert_eq!(r2.msg_type, MSG_DATA);
        assert_eq!(r2.channel_id, 3);
        let (seq, data) = decode_server_data_payload(&r2.payload).unwrap();
        assert_eq!(seq, 42);
        assert_eq!(data, "hello 中文".as_bytes());

        let r3 = read_frame(&mut cursor).await.unwrap().unwrap();
        assert_eq!(decode_resize_payload(&r3.payload).unwrap(), (120, 40));

        assert_eq!(read_frame(&mut cursor).await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_reject_oversized_frame() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&((MAX_FRAME_PAYLOAD_LEN as u32) + 1).to_be_bytes());
        raw.push(MSG_DATA);
        raw.extend_from_slice(&1u32.to_be_bytes());
        let mut cursor = Cursor::new(raw);
        let err = read_frame(&mut cursor).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
