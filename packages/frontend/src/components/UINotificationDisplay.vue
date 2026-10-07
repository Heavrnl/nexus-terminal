<script setup lang="ts">
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { storeToRefs } from 'pinia';
import MobileNotificationDisplay from './MobileNotificationDisplay.vue';

const { isMobile } = useDeviceDetection();
const notificationsStore = useUiNotificationsStore();
const { notifications } = storeToRefs(notificationsStore);

const getIconClass = (type: string) => {
  switch (type) {
    case 'success': return 'fas fa-check-circle';
    case 'error': return 'fas fa-times-circle';
    case 'info': return 'fas fa-info-circle';
    case 'warning': return 'fas fa-exclamation-triangle';
    default: return '';
  }
};

const getContainerClass = (type: string) => {
  return `notification-item notification-${type}`;
};
</script>

<template>
  <!-- 移动端专属悬浮胶囊通知 -->
  <MobileNotificationDisplay v-if="isMobile" />

  <!-- 桌面端原有右上角通知 (完全保持不变) -->
  <div v-else class="fixed top-4 right-4 z-[1100] flex flex-col items-end">
    <transition-group
      tag="div"
      enter-active-class="transition duration-500 ease-out"
      enter-from-class="transform translate-x-[30px] opacity-0"
      enter-to-class="transform translate-x-0 opacity-95"
      leave-active-class="transition duration-500 ease-in"
      leave-from-class="transform translate-x-0 opacity-95"
      leave-to-class="transform translate-x-[30px] opacity-0"
    >
      <div
        v-for="notification in notifications"
        :key="notification.id"
        :class="[
          'flex items-center p-3 mb-2 rounded shadow-md min-w-[250px] max-w-[400px] opacity-95 text-white', 
          {
            'bg-green-600': notification.type === 'success',
            'bg-red-600': notification.type === 'error',
            'bg-blue-600': notification.type === 'info',
            'bg-yellow-500 text-gray-800': notification.type === 'warning',
          }
        ]"
      >
        <i :class="['mr-3 text-lg relative top-px', getIconClass(notification.type)]"style="color: white !important;"></i>
        <span class="flex-grow break-words text-sm">{{ notification.message }}</span>
        <button
          class="ml-4 p-1 bg-transparent border-none text-white opacity-70 hover:opacity-100 cursor-pointer text-lg leading-none"
          @click="notificationsStore.removeNotification(notification.id)"
        >
          &times;
        </button>
      </div>
    </transition-group>
  </div>
</template>

