<script setup lang="ts">
import { defineProps, defineEmits, watch, onMounted, onUnmounted } from 'vue';
import CommandHistoryView from '../views/CommandHistoryView.vue';
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
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
const offWorkspaceEvent = useWorkspaceEventOff();

// 当点击历史命令发送时（触发 terminal:sendCommand），自动关闭模态框
const handleSendCommand = () => {
  closeModal();
};

onMounted(() => {
  onWorkspaceEvent('terminal:sendCommand', handleSendCommand);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  offWorkspaceEvent('terminal:sendCommand', handleSendCommand);
});
</script>

<template>
  <div v-if="isVisible" class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4" @click.self="closeModal">
    <div class="bg-background text-foreground p-4 rounded-lg shadow-xl border border-border w-full max-w-lg h-[80vh] max-h-[85vh] flex flex-col relative">
      <!-- 关闭按钮 -->
      <button class="absolute top-2 right-2 p-1 text-text-secondary hover:text-foreground z-10" @click="closeModal" :title="t('close', '关闭')">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <!-- 标题 -->
      <h3 class="text-lg font-semibold text-center mb-3 flex-shrink-0">{{ t('commandHistory.modalTitle', '命令历史') }}</h3>
      <!-- 嵌入命令历史视图 -->
      <div class="flex-grow overflow-hidden border border-border rounded">
        <CommandHistoryView />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}
</style>
