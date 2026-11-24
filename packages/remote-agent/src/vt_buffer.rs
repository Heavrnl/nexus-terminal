//! 双轨终端状态缓冲区：
//!   1. 内置轻量 VT100/xterm 状态机（默认 2000 行 scrollback）：
//!      跨端接管 / 刷新 / 恢复挂起时直接输出纯净渲染快照，天然剔除 DA1/DA2/OSC 10~12/DSR 等查询序列。
//!   2. 512KB 原始字节序号环形缓冲：
//!      短暂网络抖动就地重连时，按客户端 lastSeq 精确切片补发增量原始字节，实现零闪烁续传；
//!      若断网期间输出量超过 512KB，自动平滑降级为 VT 完整快照。

use std::collections::VecDeque;
use std::num::NonZeroU16;

pub const DEFAULT_SCROLLBACK_LEN: usize = 2000;
pub const MAX_RING_BYTES: usize = 512 * 1024;

fn nz(v: u16) -> NonZeroU16 {
    NonZeroU16::new(v.max(1)).expect("非零 u16")
}

#[derive(Debug)]
struct RingChunk {
    /// 此块包含的起始字节序号（左闭）
    start_seq: u64,
    /// 此块结束后的累计字节序号（右开，即 start_seq + data.len()）
    end_seq: u64,
    data: Vec<u8>,
}

pub struct VtRingBuffer {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    scrollback_limit: usize,
    has_output: bool,
    ring: VecDeque<RingChunk>,
    ring_bytes: usize,
    max_ring_bytes: usize,
    base_seq: u64,
    current_seq: u64,
}

impl VtRingBuffer {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_limits(cols, rows, DEFAULT_SCROLLBACK_LEN, MAX_RING_BYTES)
    }

    pub fn with_limits(cols: u16, rows: u16, scrollback: usize, max_ring_bytes: usize) -> Self {
        let safe_cols = cols.clamp(2, 1000);
        let safe_rows = rows.clamp(1, 500);
        Self {
            parser: vt100::Parser::new(nz(safe_rows), nz(safe_cols), scrollback),
            cols: safe_cols,
            rows: safe_rows,
            scrollback_limit: scrollback,
            has_output: false,
            ring: VecDeque::new(),
            ring_bytes: 0,
            max_ring_bytes: max_ring_bytes.max(1024),
            base_seq: 0,
            current_seq: 0,
        }
    }

    pub fn current_seq(&self) -> u64 {
        self.current_seq
    }

    pub fn dimensions(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    /// 喂入来自远端 PTY 的原始字节流，返回写入后的最新累计 seq
    pub fn feed(&mut self, bytes: &[u8]) -> u64 {
        if bytes.is_empty() {
            return self.current_seq;
        }
        self.has_output = true;
        self.parser.process(bytes);

        let start_seq = self.current_seq;
        let end_seq = start_seq + bytes.len() as u64;
        self.current_seq = end_seq;

        // 若单块本身超过环上限，仅保留尾部，防止单次大输出打爆内存
        if bytes.len() >= self.max_ring_bytes {
            let keep_from = bytes.len() - self.max_ring_bytes;
            let tail = bytes[keep_from..].to_vec();
            let kept_start = start_seq + keep_from as u64;
            self.ring.clear();
            self.ring_bytes = tail.len();
            self.base_seq = kept_start;
            self.ring.push_back(RingChunk {
                start_seq: kept_start,
                end_seq,
                data: tail,
            });
            return self.current_seq;
        }

        self.ring.push_back(RingChunk {
            start_seq,
            end_seq,
            data: bytes.to_vec(),
        });
        self.ring_bytes += bytes.len();

        while self.ring_bytes > self.max_ring_bytes {
            if let Some(popped) = self.ring.pop_front() {
                self.ring_bytes = self.ring_bytes.saturating_sub(popped.data.len());
                self.base_seq = popped.end_seq;
            } else {
                break;
            }
        }

        self.current_seq
    }

    /// 同步调整虚拟终端窗口尺寸
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let safe_cols = cols.clamp(2, 1000);
        let safe_rows = rows.clamp(1, 500);
        if safe_cols == self.cols && safe_rows == self.rows {
            return;
        }
        self.cols = safe_cols;
        self.rows = safe_rows;
        self.parser.screen_mut().set_size(nz(safe_rows), nz(safe_cols));
    }

    /// 尝试按客户端已消费的 last_seq 切片出增量原始字节。
    /// 若 last_seq 已被环形缓冲淘汰或非法，返回 None，调用方应平滑升级为 full 快照。
    pub fn slice_delta(&self, last_seq: u64) -> Option<Vec<u8>> {
        if last_seq == self.current_seq {
            return Some(Vec::new());
        }
        if last_seq < self.base_seq || last_seq > self.current_seq {
            return None;
        }
        let total = (self.current_seq - last_seq) as usize;
        let mut out = Vec::with_capacity(total);
        for chunk in &self.ring {
            if chunk.end_seq <= last_seq {
                continue;
            }
            if chunk.start_seq >= last_seq {
                out.extend_from_slice(&chunk.data);
            } else {
                let offset = (last_seq - chunk.start_seq) as usize;
                out.extend_from_slice(&chunk.data[offset..]);
            }
        }
        Some(out)
    }

    /// 序列化完整纯净屏幕状态（主屏 scrollback + 当前可见屏 + 备用屏 + 色彩 + 光标 + 模式）。
    /// 产物只包含纯渲染控制序列，绝不包含任何查询控制序列（DA1/DA2/OSC/DSR）。
    pub fn serialize_full(&mut self) -> Vec<u8> {
        if !self.has_output {
            return Vec::new();
        }

        let mut out = Vec::new();
        // 先归零 scrollback 视图确认当前是否处于备用屏（vim / htop / btop / less）
        self.parser.screen_mut().set_scrollback(0);
        let is_alt = self.parser.screen().alternate_screen();

        if is_alt {
            // 备用屏（全屏 TUI）：显式切入备用屏（?1049h），再还原备用屏完整渲染状态、模式与光标
            out.extend_from_slice(b"\x1b[?1049h\x1b[0m\x1b[2J\x1b[H");
            out.extend_from_slice(self.parser.screen().state_formatted().as_bytes());
            return out;
        }

        // 主屏模式：先重置样式并清屏（含旧回滚区），再按时间顺序写入 scrollback 历史行，最后落当前屏幕状态
        out.extend_from_slice(b"\x1b[0m\x1b[2J\x1b[3J\x1b[H");

        // 探测实际滚动历史行数（使用有限 scrollback_limit 避免溢出）
        self.parser.screen_mut().set_scrollback(self.scrollback_limit);
        let scrollback_len = self.parser.screen().scrollback();

        if scrollback_len > 0 {
            // 按页步进提取所有位于当前可见屏之上的历史行
            let page_rows = self.rows as usize;
            let mut remaining = scrollback_len;
            while remaining > 0 {
                self.parser.screen_mut().set_scrollback(remaining);
                let take_rows = remaining.min(page_rows);
                for row_str in self
                    .parser
                    .screen()
                    .rows_formatted(0, self.cols)
                    .take(take_rows)
                {
                    out.extend_from_slice(row_str.as_bytes());
                    out.extend_from_slice(b"\x1b[0m\r\n");
                }
                remaining = remaining.saturating_sub(take_rows);
            }
            for _ in 0..self.rows {
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(b"\x1b[2J\x1b[H");
        }

        // 归零 scrollback 并追加当前可见屏完整状态（内容 + SGR 属性 + 模式 + 光标位置）
        self.parser.screen_mut().set_scrollback(0);
        out.extend_from_slice(self.parser.screen().state_formatted().as_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delta_ring_exact_and_eviction() {
        let mut vt = VtRingBuffer::with_limits(80, 24, 200, 1024);
        let s1 = vt.feed(b"line1\r\n");
        let s2 = vt.feed(b"line2\r\n");
        let s3 = vt.feed(b"line3\r\n");

        assert_eq!(vt.slice_delta(s3), Some(Vec::new()));
        assert_eq!(vt.slice_delta(s1), Some(b"line2\r\nline3\r\n".to_vec()));
        assert_eq!(vt.slice_delta(s2), Some(b"line3\r\n".to_vec()));

        // 写入超过 1024 字节触发头部淘汰
        let bulk = vec![b'A'; 1200];
        let s4 = vt.feed(&bulk);
        assert!(vt.slice_delta(s1).is_none());
        assert!(vt.slice_delta(s3).is_none());
        // 最新的增量（从 s4 - 100 起）依然可切片
        let recent = vt.slice_delta(s4 - 100).unwrap();
        assert_eq!(recent.len(), 100);
        assert!(recent.iter().all(|&b| b == b'A'));
    }

    #[test]
    fn test_serialize_full_preserves_scrollback_color_and_strips_queries() {
        let mut vt = VtRingBuffer::with_limits(40, 5, 100, 64 * 1024);
        // 混入 DA1 (\x1b[c)、DSR (\x1b[6n)、OSC 10 查询 (\x1b]10;?\x07) 与中文/真彩输出
        vt.feed(b"\x1b[c\x1b[6n\x1b]10;?\x07");
        for i in 1..=10 {
            let line = format!("\x1b[38;2;0;255;128m第{:02}行 hello\x1b[0m\r\n", i);
            vt.feed(line.as_bytes());
        }
        vt.feed(b"prompt$ ");

        let snapshot = vt.serialize_full();
        let snap_str = String::from_utf8_lossy(&snapshot);
        // 查询序列必须完全被 VT 吞掉，绝不出现在快照中
        assert!(!snap_str.contains("\x1b[c"));
        assert!(!snap_str.contains("\x1b[6n"));
        assert!(!snap_str.contains("\x1b]10;?"));

        // 将快照喂给一个全新 VT，验证可见屏内容、光标和 scrollback 均被准确还原
        let mut restored = vt100::Parser::new(nz(5), nz(40), 100);
        restored.process(&snapshot);
        assert!(!restored.screen().alternate_screen());
        let visible = restored.screen().contents();
        assert!(visible.contains("第10行 hello"), "可见屏应含第10行: {}", visible);
        assert!(visible.contains("prompt$"), "可见屏应含提示符: {}", visible);

        restored.screen_mut().set_scrollback(100);
        assert!(restored.screen().scrollback() > 0, "历史回滚区应保留早期行");
        let early = restored.screen().contents();
        assert!(early.contains("第01行 hello"), "历史回滚区应含第01行: {}", early);
    }

    #[test]
    fn test_serialize_full_alternate_screen() {
        let mut vt = VtRingBuffer::new(40, 10);
        vt.feed(b"normal shell\r\n");
        // 进入备用屏（vim / htop 模式）
        vt.feed(b"\x1b[?1049h\x1b[2J\x1b[3;5H-- VIM INSERT --");

        let snapshot = vt.serialize_full();
        let mut restored = vt100::Parser::new(nz(10), nz(40), 100);
        restored.process(&snapshot);
        assert!(restored.screen().alternate_screen());
        assert!(restored.screen().contents().contains("-- VIM INSERT --"));
    }
}
