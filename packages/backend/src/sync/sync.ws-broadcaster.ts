// packages/backend/src/sync/sync.ws-broadcaster.ts
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import {
  broadcastFrontendEvent,
  getFrontendEventClientCount,
  registerFrontendEventClient,
  unregisterFrontendEventClient,
} from '../websocket/frontend-events';

/**
 * 已连接并鉴权成功的同步客户端连接池 (如桌面端后台连到云端)
 */
const syncWsClients = new Set<WebSocket>();

/**
 * 处理通过 /ws/sync 鉴权成功的 WebSocket 连接
 */
export function handleSyncWsConnection(ws: WebSocket, req: IncomingMessage): void {
  syncWsClients.add(ws);
  (ws as any).isAlive = true;
  (ws as any).isSyncOrEventChannel = true;
  (ws as any).channelType = 'sync';
  (ws as any).missedPongs = 0;

  console.log(`[SyncBroadcaster] 新增同步长连接客户端，当前活跃客户端总数: ${syncWsClients.size}`);

  // 连接握手成功后立即向客户端发送 ready 信号
  try {
    ws.send(JSON.stringify({
      type: 'sync:ready',
      message: '双端实时同步长连接就绪',
      timestamp: Date.now()
    }));
  } catch (err) {
    console.warn('[SyncBroadcaster] 发送 ready 消息异常:', err);
  }

  // 监听底层 pong 帧 (响应 heartbeat.ts 发送的底层 ping 探测)
  ws.on('pong', () => {
    (ws as any).isAlive = true;
    (ws as any).missedPongs = 0;
  });

  // 心跳响应与协议消息处理
  ws.on('message', (data: any) => {
    try {
      const msgStr = data.toString();
      const msg = JSON.parse(msgStr);
      if (msg.type === 'ping' || msg.type === 'sync:ping') {
        (ws as any).isAlive = true;
        (ws as any).missedPongs = 0;
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'sync:notify') {
        console.log(`[SyncBroadcaster] 收到客户端主动广播请求 (seq: ${msg.seq ?? 'latest'})`);
        broadcastSyncInvalidated(msg.seq);
      }
    } catch {
      // 容错非 JSON 消息
    }
  });

  ws.on('close', () => {
    syncWsClients.delete(ws);
    console.log(`[SyncBroadcaster] 同步长连接客户端断开，当前活跃客户端数: ${syncWsClients.size}`);
  });

  ws.on('error', (err) => {
    console.warn('[SyncBroadcaster] 同步客户端连接异常:', err.message);
    syncWsClients.delete(ws);
  });
}

/**
 * 广播同步失效/变更信号至所有在线的客户端
 * 当云端或本地数据库产生新变更时触发，毫秒级唤醒远端对齐
 */
export function broadcastSyncInvalidated(maxSeq?: number): void {
  if (syncWsClients.size === 0) return;

  const payload = JSON.stringify({
    type: 'sync:invalidated',
    seq: maxSeq,
    timestamp: Date.now()
  });

  let broadcastCount = 0;
  for (const client of syncWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
        broadcastCount++;
      } catch (e: any) {
        console.warn('[SyncBroadcaster] 广播同步信号异常:', e.message);
      }
    }
  }

  if (broadcastCount > 0) {
    console.log(`[SyncBroadcaster] 已向 ${broadcastCount} 个在线同步客户端广播实时变更失效信号 (seq: ${maxSeq ?? 'latest'})。`);
  }
}

/**
 * 向所有在线的桌面端同步长连接（/ws/sync）广播工作区租约接管通知，
 * 令旧桌面端即时弹出接管遮罩并优雅 DETACH 其本地持有的目标机托管会话。
 */
export function broadcastWorkspaceTakeover(activeClientId: string): void {
  if (syncWsClients.size === 0) return;

  const payload = JSON.stringify({
    type: 'workspace:takeover_kickout',
    activeClientId,
    reason: 'taken_over_by_another_device',
    timestamp: Date.now(),
  });

  let sent = 0;
  for (const client of syncWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
        sent++;
      } catch (e: any) {
        console.warn('[SyncBroadcaster] 广播工作区接管通知异常:', e?.message || e);
      }
    }
  }
  if (sent > 0) {
    console.log(`[SyncBroadcaster] 已向 ${sent} 个在线桌面端同步连接广播工作区接管信号 (activeClientId=${activeClientId})。`);
  }
}

/* 前端 UI 实时事件连接池已抽到 websocket/frontend-events.ts（leaf 模块，供 sftp 等其他层推事件） */

/**
 * 处理通过 /ws/events 连接的前端 UI 全局事件订阅
 */
export function handleFrontendEventsConnection(ws: WebSocket, req: IncomingMessage): void {
  registerFrontendEventClient(ws);
  (ws as any).isAlive = true;
  (ws as any).isSyncOrEventChannel = true;
  (ws as any).channelType = 'events';
  (ws as any).missedPongs = 0;

  console.log(`[FrontendEvents] 新增前端 UI 事件订阅长连接，当前活跃页面数: ${getFrontendEventClientCount()}`);

  // 连接握手成功后立即向前端发送 welcome 确认
  try {
    ws.send(JSON.stringify({
      type: 'frontend:connected',
      message: '前端全局实时事件通道已连通',
      timestamp: Date.now()
    }));
  } catch {}

  // 监听底层 pong 帧 (响应 heartbeat.ts 发送的底层 ping 探测)
  ws.on('pong', () => {
    (ws as any).isAlive = true;
    (ws as any).missedPongs = 0;
  });

  // 监听心跳与消息
  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        (ws as any).isAlive = true;
        (ws as any).missedPongs = 0;
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'test:trigger_notify' || msg.type === 'frontend:broadcast_refresh') {
        notifyLocalFrontendSyncDone(msg.payload);
      }
    } catch {}
  });

  ws.on('close', () => {
    unregisterFrontendEventClient(ws);
    console.log(`[FrontendEvents] 前端 UI 事件连接关闭，当前活跃页面数: ${getFrontendEventClientCount()}`);
  });

  ws.on('error', (err) => {
    unregisterFrontendEventClient(ws);
  });
}

import { clientStates } from '../websocket/state';

/**
 * 当本地调度器完成同步拉取或推送后，通知当前打开的桌面端 Web 前端刷新 Store
 */
export function notifyLocalFrontendSyncDone(stats?: { pushed: number; pulled: number }): void {
  const msg = JSON.stringify({
    type: 'sync:completed',
    payload: stats || { pushed: 0, pulled: 0 },
    timestamp: Date.now()
  });

  // 1. 优先通知所有订阅了 /ws/events 的前端 UI 页面
  let notifiedCount = broadcastFrontendEvent({ type: 'sync:completed', payload: stats || { pushed: 0, pulled: 0 } });

  // 2. 同时通知所有处于活动状态的终端会话连接
  for (const [_sessionId, state] of clientStates) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(msg);
        notifiedCount++;
      } catch {}
    }
  }

  console.log(`[SyncBroadcaster] 本地同步已完成，已通知 ${notifiedCount} 个前端界面实时刷新面板数据。`);
}

/**
 * 获取当前活跃连接数
 */
export function getActiveSyncClientsCount(): number {
  return syncWsClients.size;
}

/**
 * 获取当前活跃前端事件连接数
 */
export function getActiveFrontendClientsCount(): number {
  return getFrontendEventClientCount();
}
