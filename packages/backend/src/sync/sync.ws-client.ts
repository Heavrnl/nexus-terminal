// packages/backend/src/sync/sync.ws-client.ts
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../services/storage-path.service';
import { settingsRepository } from '../settings/settings.repository';
import { syncThrottleScheduler } from './sync.scheduler';
import { assertSafeSyncOutboundUrl, createPinnedLookup } from './outbound-url';

/**
 * 桌面端常驻后台的 WebSocket 实时同步长连接客户端
 * 负责主动连接云端 /ws/sync，接收云端毫秒级变更通知并触发本地调度器拉取
 */
export class SyncWsClient {
  private ws: WebSocket | null = null;
  private isDestroyed: boolean = false;
  private isConnecting: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt: number = 0;
  private currentVpsUrl: string = '';
  private currentApiKey: string = '';

  /**
   * 启动后台客户端守护
   */
  public async start(): Promise<void> {
    this.isDestroyed = false;
    await this.connect();
  }

  /**
   * 停止并清理客户端
   */
  public stop(): void {
    this.isDestroyed = true;
    this.cleanup();
  }

  /**
   * 配置变更时重新连接
   */
  public async restart(): Promise<void> {
    this.cleanup();
    this.reconnectAttempt = 0;
    this.isDestroyed = false;
    await this.connect();
  }

  /**
   * 读取本地配置的云端 VPS 目标地址与 API Key
   */
  private async getTargetConfig(): Promise<{ vpsUrl: string; apiKey: string }> {
    let vpsUrl = '';
    let apiKey = '';

    // 1. 从 settings 表读取
    try {
      const syncConfigSetting = await settingsRepository.getSetting('desktop_sync_config');
      if (syncConfigSetting) {
        const cfg = JSON.parse(syncConfigSetting);
        vpsUrl = cfg.vpsUrl || '';
        apiKey = cfg.apiKey || '';
      }
    } catch {}

    // 2. 从 desktop-settings.json 读取
    if (!vpsUrl) {
      try {
        const jsonPath = path.join(getDataDir(), 'desktop-settings.json');
        if (fs.existsSync(jsonPath)) {
          const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          if (parsed.syncVpsUrl && parsed.syncApiKey) {
            vpsUrl = parsed.syncVpsUrl;
            apiKey = parsed.syncApiKey;
          }
        }
      } catch {}
    }

    // 3. 从环境变量回退（仅使用显式配置的 SYNC_API_KEY，严禁回退泄露本地服务端 syncApiKey）
    if (!vpsUrl) vpsUrl = (process.env.SYNC_VPS_URL || '').trim();
    if (!apiKey) apiKey = (process.env.SYNC_API_KEY || '').trim();

    return { vpsUrl, apiKey };
  }

  /**
   * 将校验通过的 HTTP/HTTPS VPS URL 转化为 WS/WSS 同步长连接地址
   */
  private buildWsUrl(parsed: URL, apiKey: string): string | null {
    if (!apiKey) return null;

    try {
      const isSecure = parsed.protocol === 'https:';
      const wsProtocol = isSecure ? 'wss:' : 'ws:';
      const host = parsed.host;
      const cleanPathname = parsed.pathname.replace(/\/+$/, '');
      const baseWsPath = cleanPathname === '/' ? '' : cleanPathname;

      return `${wsProtocol}//${host}${baseWsPath}/ws/sync`;
    } catch (e: any) {
      console.warn('[SyncWsClient] 构建 WebSocket 连接地址失败:', e.message);
      return null;
    }
  }

  /**
   * 建立连接
   */
  private async connect(): Promise<void> {
    if (this.isDestroyed || this.isConnecting) return;

    const { vpsUrl, apiKey } = await this.getTargetConfig();
    this.currentVpsUrl = vpsUrl;
    this.currentApiKey = apiKey;

    if (!vpsUrl || !apiKey) {
      // 未配置远程云端，每隔 15 秒静默检测一次配置
      this.scheduleReconnect(15000);
      return;
    }

    // 发起出站 WebSocket 连接前强制执行 SSRF 安全校验，阻断内网/回环与 DNS Rebinding
    let verifiedTarget;
    try {
      let candidateUrl = vpsUrl.trim();
      if (!/^https?:\/\//i.test(candidateUrl)) {
        candidateUrl = `https://${candidateUrl}`;
      }
      verifiedTarget = await assertSafeSyncOutboundUrl(candidateUrl);
    } catch (err: any) {
      console.warn(`[SyncWsClient] 拒绝连接不安全的同步目标地址 (${vpsUrl}): ${err.message}`);
      this.scheduleReconnect(30000);
      return;
    }

    const wsUrl = this.buildWsUrl(verifiedTarget.url, apiKey);
    if (!wsUrl) {
      this.scheduleReconnect(15000);
      return;
    }

    const pinnedLookup = createPinnedLookup(verifiedTarget);

    this.isConnecting = true;
    try {
      console.log(`[SyncWsClient] 正在尝试建立双端实时长连接通道... (${verifiedTarget.url.origin})`);
      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: 8000,
        ...(pinnedLookup ? { lookup: pinnedLookup } : {}),
        headers: {
          'x-sync-api-key': apiKey
        }
      });

      this.ws = ws;

      // 监听云端底层 ping 帧探测并即时回复 pong
      ws.on('ping', () => {
        try {
          ws.pong();
        } catch {}
      });

      ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempt = 0;
        console.log('[SyncWsClient] 双端实时长连接已连通云端！秒级变更推送已激活。');

        // 启动 15 秒心跳保活
        this.startHeartbeat();

        // 连接建立瞬间，执行一次 Catch-up 检查，拉取离线期间所有云端变更
        setTimeout(() => {
          syncThrottleScheduler.flush('ws_connected_catchup');
        }, 300);
      });

      ws.on('message', (data: any) => {
        try {
          const msgStr = data.toString();
          const msg = JSON.parse(msgStr);

          if (msg.type === 'sync:invalidated') {
            console.log(`[SyncWsClient] 收到云端实时变更失效信号 (seq: ${msg.seq ?? 'latest'})，即刻唤醒本地拉取！`);
            // 毫秒级唤醒本地调度器拉取
            syncThrottleScheduler.flush('ws_remote_notify');
          } else if (msg.type === 'sync:ready') {
            console.log('[SyncWsClient] 云端确认就绪:', msg.message);
          } else if (msg.type === 'pong') {
            // 心跳应答正常
          }
        } catch (e: any) {
          console.warn('[SyncWsClient] 解析云端推送消息异常:', e.message);
        }
      });

      ws.on('close', (code, reason) => {
        this.isConnecting = false;
        this.cleanupSocketOnly();
        if (!this.isDestroyed) {
          console.log(`[SyncWsClient] 与云端的实时长连接已关闭 (code: ${code}, reason: ${reason.toString() || 'normal'})，将在稍后自动重连...`);
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        this.isConnecting = false;
        console.warn(`[SyncWsClient] 实时长连接连接异常: ${err.message}`);
        // error 会随后触发 close 事件进行重连调度
      });

    } catch (err: any) {
      this.isConnecting = false;
      console.warn(`[SyncWsClient] 创建 WebSocket 客户端异常: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * 安排指数退避重连
   */
  private scheduleReconnect(explicitDelay?: number): void {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectAttempt++;
    // 指数退避重试 (3s, 6s, 12s, 上限 30s)
    const delay = explicitDelay || Math.min(Math.pow(2, Math.min(this.reconnectAttempt, 4)) * 1500, 30000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          this.ws.ping(() => {});
        } catch {
          // 心跳发送失败
        }
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanupSocketOnly(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
  }

  private cleanup(): void {
    this.cleanupSocketOnly();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isConnecting = false;
  }
}

// 全局单例
export const syncWsClient = new SyncWsClient();
