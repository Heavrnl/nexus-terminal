<template>
  <div class="path-history-dropdown absolute z-40 w-full rounded-md bg-background shadow-lg border border-border/50 max-h-60 overflow-y-auto text-sm">
    <!-- Loading State -->
    <div v-if="isLoading && filteredHistory.length === 0" class="p-3 text-center text-text-secondary">
      <i class="fas fa-spinner fa-spin mr-2"></i>
      {{ $t('pathHistory.loading', '加载中...') }}
    </div>
    <!-- Empty State -->
    <div v-else-if="filteredHistory.length === 0" class="p-3 text-center text-text-secondary">
      <i class="fas fa-history mr-2"></i>
      {{ $t('pathHistory.empty', '没有路径历史记录') }}
    </div>
    <!-- History List -->
    <ul v-else ref="historyListRef" class="list-none p-1 m-0">
      <li
        v-for="(entry, index) in filteredHistory"
        :key="entry.id"
        :ref="el => { if (el) itemRefs[index] = el as HTMLLIElement }"
        class="group flex justify-between items-center px-3 py-0.1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
        :class="{ 'bg-primary/20 font-medium text-primary-foreground': index === storeSelectedIndex }"
        @click="handleItemClick(entry.path)"
        @mouseenter="hoveredItemId = entry.id"
        @mouseleave="hoveredItemId = null"
        :title="entry.path"
      >
        <!-- Path Text -->
        <span class="truncate mr-2 flex-grow font-mono text-sm text-foreground">{{ entry.path }}</span>
        <!-- Actions (Show on Hover) -->
        <div
          class="flex items-center flex-shrink-0 transition-opacity duration-150"
          :class="{ 'opacity-100': hoveredItemId === entry.id || isTouchDevice, 'opacity-0 group-hover:opacity-100 focus-within:opacity-100': !isTouchDevice }"
        >
          <!-- Copy Button -->
          <button
            @click.stop="copyPathToClipboard(entry.path)"
            class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 text-text-secondary hover:text-primary"
            :title="$t('pathHistory.copy', '复制路径')"
          >
            <i class="fas fa-copy text-xs"></i>
          </button>
          <!-- Delete Button -->
          <button
            @click.stop="deleteHistoryEntry(entry.id)"
            class="ml-1 p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 text-text-secondary hover:text-error"
            :title="$t('pathHistory.delete', '删除此条历史')"
          >
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import { usePathHistoryStore, PathHistoryEntryFE } from '../stores/pathHistory.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useI18n } from 'vue-i18n';
import { copyToClipboard } from '../utils/clipboard';

const pathHistoryStore = usePathHistoryStore();
const uiNotificationsStore = useUiNotificationsStore();
const { t } = useI18n();

const emit = defineEmits(['pathSelected', 'closeDropdown']);

// --- Store State and Getters ---
const {
  filteredHistory,
  isLoading,
  selectedIndex: storeSelectedIndex,
} = storeToRefs(pathHistoryStore);

const historyListRef = ref<HTMLUListElement | null>(null);
const itemRefs = ref<HTMLLIElement[]>([]);
const hoveredItemId = ref<number | null>(null);
const isTouchDevice = ref(false);

onMounted(() => {
  isTouchDevice.value = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Reset itemRefs before each update to avoid stale references
  watch(filteredHistory, () => {
    itemRefs.value = [];
  }, { flush: 'pre' });
});


// --- Actions ---
const handleItemClick = (path: string) => {
  emit('pathSelected', path);
  // No need to call addPath here, parent component will handle it after navigation
};

const copyPathToClipboard = async (path: string) => {
  const success = await copyToClipboard(path);
  if (success) {
    uiNotificationsStore.showSuccess(t('pathHistory.copiedSuccess', '路径已复制到剪贴板'));
  } else {
    uiNotificationsStore.showError(t('pathHistory.copiedError', '复制路径失败'));
  }
};

const deleteHistoryEntry = (id: number) => {
  pathHistoryStore.deletePath(id);
};

// --- Scroll to Selected Item ---
const scrollToSelected = async () => {
  await nextTick();
  if (storeSelectedIndex.value < 0 || !historyListRef.value || !itemRefs.value[storeSelectedIndex.value]) return;

  const selectedItem = itemRefs.value[storeSelectedIndex.value];
  if (selectedItem) {
    selectedItem.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }
};

// Watch for changes in the store's selectedIndex and scroll
watch(storeSelectedIndex, () => {
  scrollToSelected();
});

// Expose for parent component to call if needed, e.g., when dropdown opens
defineExpose({
  scrollToSelected,
  focusList: () => {
    historyListRef.value?.focus();
  }
});

</script>

<style scoped>
.path-history-dropdown {
  /* Ensures dropdown appears above other elements */
  /* Further styling can be added if needed */
}
</style>