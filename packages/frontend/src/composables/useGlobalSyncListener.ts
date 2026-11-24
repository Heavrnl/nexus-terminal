// packages/frontend/src/composables/useGlobalSyncListener.ts
import { ref } from 'vue';
import { useDesktopSyncStore } from '../stores/desktopSync.store';
import { workspaceEmitter } from './workspaceEvents';

let wsInstance: WebSocket | null = null;
let heartbeatTimer: any = null;
let reconnectTimer: any = null;
let refreshDebounceTimer: any = null;
let isInitialized = false;

const isConnected = ref(false);

type GlobalEventHandler = (message: any) => void;

/**
 * /ws/events 上自定义类型事件的订阅表。
 *
 * 这个通道原本只推 sync:completed，现在还要推「外部编辑器已回传 / 远程被改过」这类
 * 跟同步无关的界面通知。与其让每个功能都来改这个文件的 onmessage，不如开一个通用订阅口。
 */
const customEventHandlers = new Map<string, Set<GlobalEventHandler>>();

/**
 * 订阅某类全局事件（返回取消订阅函数）。
 * 需要在 initGlobalSyncListener 之前或之后调用都可以 —— 订阅表是模块级的。
 */
export function subscribeGlobalEvent(type: string, handler: GlobalEventHandler): () => void {
  let handlers = customEventHandlers.get(type);
  if (!handlers) {
    handlers = new Set();
    customEventHandlers.set(type, handlers);
  }
  handlers.add(handler);
  return () => {
    const current = customEventHandlers.get(type);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) customEventHandlers.delete(type);
  };
}

/**
 * 触发无感防抖全量 Store 重绘
 */
function scheduleStoreRefresh() {
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }
  refreshDebounceTimer = setTimeout(async () => {
    try {
      const desktopSyncStore = useDesktopSyncStore();
      await desktopSyncStore.refreshAllStores();
      workspaceEmitter.emit('sync:completed' as any, { timestamp: Date.now() });
    } catch (err: any) {
      console.warn('[GlobalSyncListener] 执行 Store 刷新异常:', err);
    }
  }, 250);
}

/**
 * 建立与后端的全局实时事件 WebSocket 连接 (/ws/events)
 */
function connect() {
  if (typeof window === 'undefined') return;

  // 清除未完成的重连定时器
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // 关闭旧连接
  if (wsInstance) {
    try {
      wsInstance.close();
    } catch {}
    wsInstance = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const url = `${protocol}//${host}/ws/events`;

  try {
    const ws = new WebSocket(url);
    wsInstance = ws;

    ws.onopen = () => {
      isConnected.value = true;
      console.log('[GlobalSyncListener] 全局 UI 实时事件长连接已建立 (/ws/events)');

      // 启动 15 秒心跳保活
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          } catch {}
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync:completed' || msg.type === 'sync:invalidated') {
          console.log('[GlobalSyncListener] 收到本地/云端实时同步完成信号，即刻无感刷新所有工作区面板！', msg);
          scheduleStoreRefresh();
        } else if (msg.type === 'workspace:takeover_kickout') {
          // 跨端接管踢出通知（桌面端由本地 Sidecar 从云端同步 WS 转发而来）
          const p = msg.payload || msg;
          const activeClientId = String(p.activeClientId || '');
          workspaceEmitter.emit('workspace:takeoverKickout', { activeClientId });
          import('../stores/workspaceSync.store')
            .then(({ useWorkspaceSyncStore }) => {
              useWorkspaceSyncStore().handleTakeoverKickout(activeClientId);
            })
            .catch(() => {});
        } else if (msg.type === 'workspace:offline_conflict') {
          const p = msg.payload || msg;
          import('../stores/workspaceSync.store')
            .then(({ useWorkspaceSyncStore }) => {
              useWorkspaceSyncStore().handleOfflineConflict({
                cloudActiveClientId: p.cloudActiveClientId ?? null,
                cloudUpdatedAt: Number(p.cloudUpdatedAt || 0),
                localClientId: p.localClientId ?? null,
                hasOfflineDirtyChanges: Boolean(p.hasOfflineDirtyChanges),
              });
            })
            .catch(() => {});
        } else if (msg.type === 'workspace:cloud_reconnected') {
          const p = msg.payload || msg;
          import('../stores/workspaceSync.store')
            .then(({ useWorkspaceSyncStore }) => {
              void useWorkspaceSyncStore().handleCloudReconnected({
                shouldFlushSave: Boolean(p.shouldFlushSave),
              });
            })
            .catch(() => {});
        } else if (msg.type === 'workspace:mode_changed') {
          const p = msg.payload || msg;
          import('../stores/workspaceSync.store')
            .then(({ useWorkspaceSyncStore }) => {
              useWorkspaceSyncStore().handleModeChanged({
                mode: p.mode,
                offlineMode: p.offlineMode,
              });
            })
            .catch(() => {});
        } else if (msg.type === 'frontend:connected') {
          console.log('[GlobalSyncListener] 后端确认事件通道就绪:', msg.message);
        } else {
          // 自定义事件（如 external-open:synced / external-open:conflict）
          const handlers = customEventHandlers.get(msg.type);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(msg);
              } catch (err) {
                console.warn(`[GlobalSyncListener] 处理事件 ${msg.type} 失败:`, err);
              }
            }
          }
        }
      } catch (err) {
        // 忽略非 JSON 消息
      }
    };

    ws.onclose = () => {
      isConnected.value = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // 2 秒后自动重连
      reconnectTimer = setTimeout(() => {
        connect();
      }, 2000);
    };

    ws.onerror = (err) => {
      // 容错处理
      try {
        ws.close();
      } catch {}
    };
  } catch (err: any) {
    console.warn('[GlobalSyncListener] 建立长连接失败，2秒后重试:', err.message);
    reconnectTimer = setTimeout(connect, 2000);
  }
}

/**
 * 初始化前端全局实时同步长连接监听器 (在 App.vue 挂载时调用，单例常驻)
 */
export function initGlobalSyncListener() {
  if (isInitialized) return;
  isInitialized = true;
  connect();

  if (typeof window !== 'undefined') {
    // 页面切回可见时，快速检查连接并静默刷新最新面板数据
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
          connect();
        }
        scheduleStoreRefresh();
      }
    });

    // 网络由离线恢复上线时，立即重连并刷新
    window.addEventListener('online', () => {
      connect();
      scheduleStoreRefresh();
    });
  }
}

/**
 * 获取全局同步长连接状态
 */
export function useGlobalSyncListener() {
  return {
    isConnected,
    refreshNow: scheduleStoreRefresh
  };
}
