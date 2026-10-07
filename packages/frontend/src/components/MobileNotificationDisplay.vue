<script setup lang="ts">
import { ref } from 'vue';
import { useUiNotificationsStore, type UINotification } from '../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';

const notificationsStore = useUiNotificationsStore();
const { notifications } = storeToRefs(notificationsStore);

const getNotificationStyle = (type: UINotification['type']) => {
  switch (type) {
    case 'success':
      return {
        icon: 'fas fa-check-circle',
        badgeClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
        cardBorder: 'border-emerald-500/30 shadow-emerald-500/5',
      };
    case 'error':
      return {
        icon: 'fas fa-times-circle',
        badgeClass: 'bg-red-500/15 text-red-500 border-red-500/30',
        cardBorder: 'border-red-500/30 shadow-red-500/5',
      };
    case 'warning':
      return {
        icon: 'fas fa-exclamation-triangle',
        badgeClass: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
        cardBorder: 'border-amber-500/30 shadow-amber-500/5',
      };
    case 'info':
    default:
      return {
        icon: 'fas fa-info-circle',
        badgeClass: 'bg-blue-500/15 text-blue-500 border-blue-500/30',
        cardBorder: 'border-blue-500/30 shadow-blue-500/5',
      };
  }
};

const handleDismiss = (id: number) => {
  notificationsStore.removeNotification(id);
};

// 移动端轻扫手势向上滑走关闭
let touchStartY = 0;
const handleTouchStart = (e: TouchEvent) => {
  touchStartY = e.touches[0].clientY;
};

const handleTouchEnd = (e: TouchEvent, id: number) => {
  const touchEndY = e.changedTouches[0].clientY;
  if (touchStartY - touchEndY > 25) {
    // 向上滑动超过 25px 判定为滑走关闭
    handleDismiss(id);
  }
};
</script>

<template>
  <div class="fixed top-3 inset-x-0 z-[1200] flex flex-col items-center pointer-events-none px-3 pt-[env(safe-area-inset-top,0px)] space-y-2 select-none">
    <transition-group
      name="mobile-toast"
      tag="div"
      class="w-full flex flex-col items-center space-y-2 pointer-events-none"
    >
      <div
        v-for="notification in notifications"
        :key="notification.id"
        @touchstart="handleTouchStart"
        @touchend="handleTouchEnd($event, notification.id)"
        class="pointer-events-auto w-full max-w-[390px] rounded-2xl bg-background/95 border backdrop-blur-md shadow-xl p-3 flex items-center justify-between gap-2.5 transition-all active:scale-[0.98]"
        :class="getNotificationStyle(notification.type).cardBorder"
      >
        <!-- 左侧类型专属图标徽章 -->
        <div
          class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-sm border"
          :class="getNotificationStyle(notification.type).badgeClass"
        >
          <i :class="getNotificationStyle(notification.type).icon"></i>
        </div>

        <!-- 中间通知文本 -->
        <div class="min-w-0 flex-1 py-0.5">
          <p class="text-xs font-medium text-foreground leading-snug break-words">
            {{ notification.message }}
          </p>
        </div>

        <!-- 右侧轻触关闭按钮 -->
        <button
          type="button"
          @click="handleDismiss(notification.id)"
          class="w-6 h-6 rounded-lg text-text-secondary/60 hover:text-foreground flex items-center justify-center shrink-0 cursor-pointer active:scale-90 transition-transform"
          title="关闭"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.mobile-toast-enter-active,
.mobile-toast-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.mobile-toast-enter-from {
  opacity: 0;
  transform: translateY(-20px) scale(0.92);
}

.mobile-toast-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.92);
}

.mobile-toast-move {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
