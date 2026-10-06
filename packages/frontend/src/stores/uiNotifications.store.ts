import { defineStore } from 'pinia';
import { ref } from 'vue';

// 定义通知对象的接口
export interface UINotification {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  timeout?: number; // 可选的自动关闭超时时间 (毫秒)
}

export const useUiNotificationsStore = defineStore('uiNotifications', () => {
  const notifications = ref<UINotification[]>([]);
  const lastNotificationTimestamps = new Map<string, number>();
  let nextId = 0;

  /**
   * 添加一个新通知
   * @param notification - 通知对象 (至少包含 type 和 message)
   */
  const addNotification = (notification: Omit<UINotification, 'id'> & { timeout?: number }) => { // Ensure timeout is part of the input type for clarity
    // 500ms 内相同类型与内容的通知自动去重，杜绝多实例/事件并发导致的双重甚至多重提示
    const dedupeKey = `${notification.type}:${notification.message}`;
    const now = Date.now();
    const lastTime = lastNotificationTimestamps.get(dedupeKey) || 0;
    if (now - lastTime < 500) {
      return;
    }
    lastNotificationTimestamps.set(dedupeKey, now);

    const id = nextId++;
    // Force a 3-second timeout for all notifications
    const newNotification: UINotification = { ...notification, id, timeout: 3000 };
    notifications.value.push(newNotification);

    // Always set timeout to remove the notification after 3 seconds
    setTimeout(() => {
      removeNotification(id);
    }, 3000); // Use fixed 3000ms timeout
  };

  /**
   * 移除一个通知
   * @param id - 要移除的通知的 ID
   */
  const removeNotification = (id: number) => {
    notifications.value = notifications.value.filter(n => n.id !== id);
  };

  // 便捷方法
  const showError = (message: string) => { // Removed options
    addNotification({ type: 'error', message }); // Timeout is handled by addNotification
  };

  const showSuccess = (message: string) => { // Removed options
    addNotification({ type: 'success', message }); // Timeout is handled by addNotification
  };

  const showInfo = (message: string) => { // Removed options
    addNotification({ type: 'info', message }); // Timeout is handled by addNotification
  };

  const showWarning = (message: string) => { // Removed options
    addNotification({ type: 'warning', message }); // Timeout is handled by addNotification
  };


  return {
    notifications,
    addNotification,
    removeNotification,
    showError,
    showSuccess,
    showInfo,
    showWarning,
  };
});
