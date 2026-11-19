// packages/backend/src/sync/sync.events.ts
import { Response } from 'express';

export interface SseClient {
  deviceId: string;
  res: Response;
  connectedAt: number;
}

class SyncEventsManager {
  private clients: Map<string, SseClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * 注册客户端 SSE 连接
   */
  public registerClient(deviceId: string, res: Response): void {
    // 若同一设备已有连接，先优雅关闭旧连接
    if (this.clients.has(deviceId)) {
      try {
        const oldClient = this.clients.get(deviceId);
        oldClient?.res.end();
      } catch (e) {
        // 忽略
      }
    }

    this.clients.set(deviceId, {
      deviceId,
      res,
      connectedAt: Date.now()
    });

    console.log(`[SyncEvents] 客户端 ${deviceId} 已建立 SSE 变更通知通道，当前在线监听客户端数: ${this.clients.size}`);

    // 连接断开监听
    res.on('close', () => {
      this.clients.delete(deviceId);
      console.log(`[SyncEvents] 客户端 ${deviceId} 断开 SSE 连接，剩余监听客户端数: ${this.clients.size}`);
    });
  }

  /**
   * 广播最新变更 seq 给所有除 originDeviceId 外的在线客户端
   */
  public broadcastChange(latestSeq: number, originDeviceId?: string): void {
    if (this.clients.size === 0) return;

    const payload = JSON.stringify({
      latest_seq: latestSeq,
      timestamp: Date.now()
    });

    let count = 0;
    for (const [devId, client] of this.clients.entries()) {
      if (originDeviceId && devId === originDeviceId) {
        continue;
      }
      try {
        client.res.write(`event: change\ndata: ${payload}\n\n`);
        count++;
      } catch (err: any) {
        console.warn(`[SyncEvents] 向客户端 ${devId} 推送 SSE 事件失败:`, err.message);
        this.clients.delete(devId);
      }
    }

    if (count > 0) {
      console.log(`[SyncEvents] 已向 ${count} 个在线客户端广播最新变更通知 (seq=${latestSeq})`);
    }
  }

  /**
   * 25 秒心跳保活，防止云服务器或反向代理超时切断连接
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      for (const [devId, client] of this.clients.entries()) {
        try {
          client.res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          this.clients.delete(devId);
        }
      }
    }, 25000);
    this.heartbeatInterval.unref?.();
  }
}

export const syncEventsManager = new SyncEventsManager();
