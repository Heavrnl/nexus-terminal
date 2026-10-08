<script setup lang="ts">
import { defineProps, defineEmits, watch, onMounted, onBeforeUnmount } from 'vue';
import MobileQuickCommandsView from '../views/MobileQuickCommandsView.vue'; // 导入移动端快捷指令视图
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // 导入事件订阅器
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'execute-command', command: string): void;
}>();

const { t } = useI18n();

const closeModal = () => {
  emit('close');
};

// 处理从 QuickCommandsView 传来的事件
const handleCommandExecute = (command: string) => {
  emit('execute-command', command);
  closeModal(); // 选择指令后自动关闭
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
}, { immediate: true });

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

// 当发送命令时自动关闭抽屉
const handleSendCommand = () => {
  closeModal();
};

onMounted(() => {
  onWorkspaceEvent('terminal:sendCommand', handleSendCommand);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
  offWorkspaceEvent('terminal:sendCommand', handleSendCommand);
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
                <i class="fas fa-bolt text-sm"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('quickCommands.title', '快捷指令') }}
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

          <!-- 嵌入快捷指令视图主体 (直接使用移动端独立解耦组件) -->
          <div class="flex-grow overflow-hidden flex flex-col bg-background">
            <MobileQuickCommandsView :instance-id="'modal'" @execute-command="handleCommandExecute" />
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