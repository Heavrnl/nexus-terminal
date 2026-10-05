<template>
  <div class="flex flex-col bg-background border border-border rounded shadow-lg overflow-hidden">
    <div class="flex items-center p-2 border-b border-border bg-header">
      <input
        type="text"
        :placeholder="$t('commandHistory.searchPlaceholder', '搜索历史记录...')"
        :value="localSearchTerm"
        @input="updateSearchTerm($event)"
        class="flex-grow px-2 py-1 border border-border rounded-sm bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
      />
      <button @click="confirmClearAll" class="ml-2 p-1 text-text-secondary hover:text-error transition-colors duration-150" :title="$t('commandHistory.clear', '清空')">
        <i class="fas fa-trash-alt text-base"></i>
      </button>
    </div>
    <div class="max-h-80 overflow-y-auto" ref="listContainer"> <!-- Adjusted max-height -->
      <ul v-if="displayedHistory.length > 0" class="list-none p-0 m-0">
        <li
          v-for="entry in displayedHistory"
          :key="entry.id"
          class="group flex justify-between items-center px-3 py-2 cursor-pointer border-b border-border last:border-b-0 hover:bg-header/50 transition-colors duration-150"
          @mouseover="hoveredItemId = entry.id"
          @mouseleave="hoveredItemId = null"
          @click="selectCommand(entry.command)"
        >
          <span class="truncate mr-2 flex-grow font-mono text-sm text-foreground">{{ entry.command }}</span>
          <div class="flex items-center flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <button @click.stop="copyCommand(entry.command)" class="p-1 text-text-secondary hover:text-primary transition-colors duration-150" :title="$t('commandHistory.copy', '复制')">
              <i class="fas fa-copy text-xs"></i>
            </button>
            <button @click.stop="deleteSingleCommand(entry.id)" class="ml-1 p-1 text-text-secondary hover:text-error transition-colors duration-150" :title="$t('commandHistory.delete', '删除')">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        </li>
      </ul>
      <div v-else-if="isLoading" class="p-5 text-center text-text-secondary text-sm">
        {{ $t('commandHistory.loading', '加载中...') }}
      </div>
      <div v-else class="p-5 text-center text-text-secondary text-sm">
        {{ $t('commandHistory.empty', '没有历史记录') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useCommandHistoryStore, CommandHistoryEntryFE } from '../stores/commandHistory.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const commandHistoryStore = useCommandHistoryStore();
const uiNotificationsStore = useUiNotificationsStore();
const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const hoveredItemId = ref<number | null>(null);
const listContainer = ref<HTMLElement | null>(null);

const localSearchTerm = ref(commandHistoryStore.searchTerm);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// --- 从 Store 获取状态和 Getter ---
const searchTerm = computed(() => commandHistoryStore.searchTerm);
const filteredHistory = computed(() => commandHistoryStore.filteredHistory);
const displayedHistory = computed(() => filteredHistory.value.slice(0, 60));
const isLoading = computed(() => commandHistoryStore.isLoading);

watch(searchTerm, (newVal) => {
  if (newVal !== localSearchTerm.value) {
    localSearchTerm.value = newVal;
  }
});

// --- 事件定义 ---
// 定义组件发出的事件
const emit = defineEmits<{
  (e: 'select-command', command: string): void;
}>();

// --- 生命周期钩子 ---
onMounted(() => {
  commandHistoryStore.fetchHistory(); // 组件挂载时获取历史记录
});

onBeforeUnmount(() => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
});

// --- 事件处理 ---

// 更新搜索词 (带 120ms 防抖)
const updateSearchTerm = (event: Event) => {
  const target = event.target as HTMLInputElement;
  localSearchTerm.value = target.value;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    commandHistoryStore.setSearchTerm(localSearchTerm.value);
    searchDebounceTimer = null;
  }, 120);
};

// 确认清空所有历史记录
const confirmClearAll = async () => { // 注意 async，并替换为实际函数名
  const confirmed = await showConfirmDialog({
    message: t('commandHistory.confirmClear', '确定要清空所有历史记录吗？')
  });
  if (confirmed) {
    commandHistoryStore.clearAllHistory();
  }
};

// 复制命令到剪贴板
const copyCommand = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command);
    // 可以选择性地显示一个复制成功的提示
    uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板')); // 使用独立的 uiNotificationsStore
  } catch (err) {
    console.error('复制命令失败:', err);
    uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败')); // 使用独立的 uiNotificationsStore
  }
};

// 删除单条历史记录
const deleteSingleCommand = (id: number) => {
  // 可以选择性地添加确认对话框
  commandHistoryStore.deleteCommand(id);
};

// 选中命令 (通知父组件)
const selectCommand = (command: string) => {
  emit('select-command', command);
};

</script>

