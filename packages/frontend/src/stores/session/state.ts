// packages/frontend/src/stores/session/state.ts

import { ref, shallowRef } from 'vue';
import type { SessionState } from './types';
// 修正导入路径
import type { ConnectionInfo } from '../connections.store'; // 路径: packages/frontend/src/stores/connections.store.ts
import type { SuspendedSshSession } from '../../types/ssh-suspend.types'; // 路径: packages/frontend/src/types/ssh-suspend.types.ts

// 使用 shallowRef 避免深度响应性问题，保留管理器实例内部的响应性
export const sessions = shallowRef<Map<string, SessionState>>(new Map());
export const activeSessionId = ref<string | null>(null);
const initialSessionOrder: string[] = (() => {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('sessionOrder');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // ignore JSON parse error
      }
    }
  }
  return [];
})();
export const sessionOrder = ref<string[]>(initialSessionOrder);

// --- RDP Modal State ---
export const isRdpModalOpen = ref(false);
export const rdpConnectionInfo = ref<ConnectionInfo | null>(null);

// --- VNC Modal State ---
export const isVncModalOpen = ref(false);
export const vncConnectionInfo = ref<ConnectionInfo | null>(null);

// --- SSH Suspend Mode State ---
export const suspendedSshSessions = ref<SuspendedSshSession[]>([]);
export const isLoadingSuspendedSessions = ref<boolean>(false);