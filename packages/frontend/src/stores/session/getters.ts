// packages/frontend/src/stores/session/getters.ts

import { computed } from 'vue';
import { sessions, activeSessionId, sessionOrder } from './state';
import type { SessionState, SessionTabInfoWithStatus } from './types';

const toTabInfo = (session: SessionState): SessionTabInfoWithStatus => ({
  sessionId: session.sessionId,
  connectionName: session.connectionName,
  // 远程会话没有 SSH 通道，状态取画面自己的 remoteStatus
  status: session.remoteStatus ? session.remoteStatus.value : session.wsManager.connectionStatus.value,
  isMarkedForSuspend: session.isMarkedForSuspend,
  kind: session.kind,
  hostingMode: session.hostingMode,
  isUnreachablePlaceholder: session.isUnreachablePlaceholder,
});

export const sessionTabs = computed(() => {
  return Array.from(sessions.value.values())
    .filter(session => !session.headless)
    .map(session => ({
      sessionId: session.sessionId,
      connectionName: session.connectionName,
      kind: session.kind,
    }));
});

// 包含状态的标签页信息
export const sessionTabsWithStatus = computed((): SessionTabInfoWithStatus[] => {
  const order = sessionOrder.value || [];
  // 无终端会话是文件管理器的私有通道，任何面向用户的会话列表都不该看见它
  const sessionList = Array.from(sessions.value.values()).filter(session => !session.headless);

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
      .map(toTabInfo);
  } else {
    // 如果没有自定义顺序，则按照创建时间排序
    return sessionList
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toTabInfo);
  }
});

export const activeSession = computed((): SessionState | null => {
  if (!activeSessionId.value) return null;
  return sessions.value.get(activeSessionId.value) || null;
});
