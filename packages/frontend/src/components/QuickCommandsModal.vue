<script setup lang="ts">
import { defineProps, defineEmits, watch, onMounted, onBeforeUnmount } from 'vue';
import QuickCommandsView from '../views/QuickCommandsView.vue'; // 导入视图
import { useWorkspaceEventSubscriber } from '../composables/workspaceEvents'; // 导入事件订阅器

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'execute-command', command: string): void;
}>();

const closeModal = () => {
  emit('close');
};

// 处理从 QuickCommandsView 传来的事件
const handleCommandExecute = (command: string) => {
  emit('execute-command', command);
  closeModal(); // 选择指令后自动关闭
};

// Add keyboard listener to close on Esc key
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

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
});

const onWorkspaceEvent = useWorkspaceEventSubscriber(); // 获取事件订阅器

onMounted(() => {
  // 监听 terminal:sendCommand 事件以关闭模态框
  onWorkspaceEvent('terminal:sendCommand', () => {
    closeModal();
  });
});

</script>

<template>
  <div v-if="isVisible" class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4" @click.self="closeModal">
    <div class="bg-background text-foreground p-4 rounded-lg shadow-xl border border-border w-full max-w-lg max-h-[85vh] flex flex-col relative">
      <!-- Close Button -->
      <button class="absolute top-2 right-2 p-1 text-text-secondary hover:text-foreground z-10" @click="closeModal" title="关闭">
         <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
           <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
         </svg>
      </button>
      <!-- Title -->
      <h3 class="text-lg font-semibold text-center mb-3 flex-shrink-0">快捷指令</h3>
      <!-- Quick Commands View Embedded -->
      <div class="flex-grow overflow-y-auto border border-border rounded">
        <QuickCommandsView @execute-command="handleCommandExecute" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Add any specific modal styles if needed */
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}
</style>