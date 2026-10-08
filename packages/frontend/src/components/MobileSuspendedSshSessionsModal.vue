<script setup lang="ts">
import { defineProps, defineEmits, watch, onMounted, onUnmounted } from 'vue';
import SuspendedSshSessionsView from '../views/SuspendedSshSessionsView.vue'; // 导入视图
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // 导入事件订阅器和取消订阅器
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();

const closeModal = () => {
  emit('close');
};

// 键盘监听 Esc 关闭
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeModal();
  }
};

watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    document.addEventListener('keydown', handleKeydown);
  } else {
    document.removeEventListener('keydown', handleKeydown);
  }
});

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff(); // 获取取消订阅函数

// 挂起会话操作完成后自动关闭抽屉
const handleSuspendedSessionActionCompleted = () => {
  console.log('[SuspendedSshSessionsModal] Received suspendedSession:actionCompleted event, closing sheet.');
  closeModal();
};

onMounted(() => {
  onWorkspaceEvent('suspendedSession:actionCompleted', handleSuspendedSessionActionCompleted);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  offWorkspaceEvent('suspendedSession:actionCompleted', handleSuspendedSessionActionCompleted);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="bottom-sheet-overlay fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="closeModal"
      >
        <!-- 移动端底部滑出面板 (Bottom Sheet) -->
        <div
          class="bottom-sheet-panel w-full h-[72vh] max-h-[80vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <!-- 顶部拖拽手柄与点击快速收起指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="closeModal"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与操作区 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <i class="fas fa-pause-circle text-sm"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('suspendedSshSessions.modalTitle', '挂起的 SSH 会话') }}
              </h3>
            </div>

            <!-- 收起按钮 -->
            <button
              @click="closeModal"
              class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
              :title="t('close', '收起')"
            >
              <i class="fas fa-chevron-down text-sm"></i>
            </button>
          </div>

          <!-- 嵌入挂起会话视图主体 -->
          <div class="flex-grow overflow-hidden flex flex-col bg-background">
            <SuspendedSshSessionsView />
          </div>

          <!-- 底部安全区垫片 -->
          <div class="sheet-safe-bottom shrink-0"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.24s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .bottom-sheet-panel {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .bottom-sheet-panel {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .bottom-sheet-panel,
.bottom-sheet-leave-to .bottom-sheet-panel {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>