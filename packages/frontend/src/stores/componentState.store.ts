import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../utils/apiClient';

const LS_COMPONENT_STATES_KEY = 'nexus_component_instance_states';

export const useComponentStateStore = defineStore('componentState', () => {
  // 状态字典：存储如 "qc_view_mode:desktop:pane-1": "grid"
  const states = ref<Record<string, any>>({});
  const isLoaded = ref(false);

  // 初始化：先从 localStorage 加载缓存，然后从后端拉取最新数据
  const initialize = async () => {
    try {
      if (typeof localStorage !== 'undefined') {
        const localCached = localStorage.getItem(LS_COMPONENT_STATES_KEY);
        if (localCached) {
          try {
            states.value = { ...JSON.parse(localCached), ...states.value };
          } catch {
            // ignore
          }
        }
      }

      const response = await apiClient.get<Record<string, any>>('/settings/component-instance-states');
      if (response && response.data && typeof response.data === 'object') {
        states.value = { ...states.value, ...response.data };
        syncToLocalStorage();
      }
    } catch (error) {
      console.warn('[ComponentStateStore] 获取后端组件状态失败，使用本地缓存:', error);
    } finally {
      isLoaded.value = true;
    }
  };

  const syncToLocalStorage = () => {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LS_COMPONENT_STATES_KEY, JSON.stringify(states.value));
      } catch (e) {
        console.warn('[ComponentStateStore] 无法同步到 localStorage:', e);
      }
    }
  };

  /**
   * 获取组件状态项
   */
  const getState = <T = any>(key: string, defaultValue?: T): T => {
    if (key in states.value && states.value[key] !== undefined && states.value[key] !== null) {
      return states.value[key] as T;
    }
    // 降级尝试 localStorage
    if (typeof localStorage !== 'undefined') {
      const fallbackLocal = localStorage.getItem(`comp_state:${key}`);
      if (fallbackLocal !== null) {
        try {
          return JSON.parse(fallbackLocal) as T;
        } catch {
          return fallbackLocal as unknown as T;
        }
      }
    }
    return defaultValue as T;
  };

  // 防抖后端保存队列
  let pendingUpdates: Record<string, any> = {};
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const flushUpdatesToBackend = async () => {
    if (Object.keys(pendingUpdates).length === 0) return;
    const toSend = { ...pendingUpdates };
    pendingUpdates = {};
    try {
      await apiClient.put('/settings/component-instance-states', toSend);
    } catch (error) {
      console.error('[ComponentStateStore] 同步组件状态至后端失败:', error);
    }
  };

  /**
   * 设置组件状态项（本地即时响应 + 异步持久化至后端）
   */
  const setState = (key: string, value: any) => {
    states.value[key] = value;
    syncToLocalStorage();
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`comp_state:${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      } catch {}
    }

    pendingUpdates[key] = value;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushUpdatesToBackend, 300);
  };

  /**
   * 移除指定组件状态项
   */
  const removeState = async (key: string) => {
    delete states.value[key];
    syncToLocalStorage();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`comp_state:${key}`);
    }

    pendingUpdates[key] = null; // null 通知后端删除
    if (saveTimer) clearTimeout(saveTimer);
    await flushUpdatesToBackend();
  };

  /**
   * 清理孤立/不存在的组件实例存储项
   * @param activeInstanceIds 当前存活的 instanceId 集合
   * @param prefixes 需要受检的前缀列表，如 ['qc_view_mode', 'tree_show_files']
   */
  const cleanupOrphanedStates = async (activeInstanceIds: Set<string>, prefixes: string[] = ['qc_view_mode', 'tree_show_files', 'fm_view_mode', 'fm_col_order']) => {
    const keysToDelete: string[] = [];

    for (const key of Object.keys(states.value)) {
      // 匹配 key 结构：prefix:platform:instanceId
      for (const prefix of prefixes) {
        if (key.startsWith(`${prefix}:`)) {
          const parts = key.split(':');
          if (parts.length >= 3) {
            const instanceId = parts.slice(2).join(':'); // 还原 instanceId
            // 白名单内置实例不清理：如 modal、default、sidebar-left、sidebar-right
            const isPermanent = ['modal', 'default', 'sidebar-left', 'sidebar-right'].includes(instanceId);
            if (!isPermanent && !activeInstanceIds.has(instanceId)) {
              keysToDelete.push(key);
            }
          }
          break;
        }
      }
    }

    if (keysToDelete.length > 0) {
      console.log('[ComponentStateStore] 检测到不存在的组件实例，正在清理孤立项:', keysToDelete);
      for (const k of keysToDelete) {
        delete states.value[k];
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(`comp_state:${k}`);
        }
      }
      syncToLocalStorage();
      try {
        await apiClient.post('/settings/component-instance-states/cleanup', { keysToDelete });
        console.log('[ComponentStateStore] 成功从后端移除孤立组件存储项');
      } catch (err) {
        console.error('[ComponentStateStore] 调用后端清理接口失败:', err);
      }
    }
  };

  return {
    states,
    isLoaded,
    initialize,
    getState,
    setState,
    removeState,
    cleanupOrphanedStates,
  };
});
