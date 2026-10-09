// packages/frontend/src/stores/session/getters.ts

import { computed } from 'vue';
import { sessions, activeSessionId, sessionOrder } from './state';
import type { SessionState, SessionTabInfoWithStatus } from './types';

export const sessionTabs = computed(() => {
  return Array.from(sessions.value.values()).map(session => ({
    sessionId: session.sessionId,
    connectionName: session.connectionName,
  }));
});

// 包含状态的标签页信息
export const sessionTabsWithStatus = computed((): SessionTabInfoWithStatus[] => {
  const order = sessionOrder.value || [];
  const sessionList = Array.from(sessions.value.values());

  if (order.length > 0) {
    // 按照响应式 sessionOrder 排序
    return sessionList
      .slice()
      .sort((a, b) => {
        const indexA = order.indexOf(a.sessionId);
        const indexB = order.indexOf(b.sessionId);
        if (indexA === -1 && indexB === -1) return a.createdAt - b.createdAt;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      })
      .map(session => ({
        sessionId: session.sessionId,
        connectionName: session.connectionName,
        status: session.wsManager.connectionStatus.value, // 从 wsManager 获取状态
        isMarkedForSuspend: session.isMarkedForSuspend,
      }));
  } else {
    // 如果没有自定义顺序，则按照创建时间排序
    return sessionList
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(session => ({
        sessionId: session.sessionId,
        connectionName: session.connectionName,
        status: session.wsManager.connectionStatus.value, // 从 wsManager 获取状态
        isMarkedForSuspend: session.isMarkedForSuspend,
      }));
  }
});

export const activeSession = computed((): SessionState | null => {
  if (!activeSessionId.value) return null;
  return sessions.value.get(activeSessionId.value) || null;
});