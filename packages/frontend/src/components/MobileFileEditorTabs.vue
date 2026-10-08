<script setup lang="ts">
import { ref, computed, type PropType, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileTab } from '../stores/fileEditor.store';
import TabBarContextMenu from './TabBarContextMenu.vue';

const props = defineProps({
  tabs: {
    type: Array as PropType<FileTab[]>,
    required: true,
  },
  activeTabId: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const emit = defineEmits<{
  (e: 'activate-tab', tabId: string): void;
  (e: 'close-tab', tabId: string): void;
  (e: 'close-other-tabs', tabId: string): void;
  (e: 'close-tabs-to-right', tabId: string): void;
  (e: 'close-tabs-to-left', tabId: string): void;
  (e: 'split-right', tabId: string): void;
  (e: 'split-down', tabId: string): void;
}>();

const { t } = useI18n();

// 触屏长按呼出右键菜单 (350ms)
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextTargetTabId = ref<string | null>(null);
const menuTargetId = ref<string | null>(null);

let touchTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
let isLongPressTriggered = false;

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextTargetTabId.value = null;
  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
};

const closeContextMenuOnClickOutside = () => {
  closeContextMenu();
};

const handleTouchStart = (event: TouchEvent, tabId: string) => {
  const touch = event.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  isLongPressTriggered = false;

  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    isLongPressTriggered = true;
    if (navigator.vibrate) navigator.vibrate(40);
    contextTargetTabId.value = tabId;
    menuTargetId.value = tabId;
    contextMenuPosition.value = { x: touch.clientX, y: touch.clientY };
    contextMenuVisible.value = true;
    document.addEventListener('click', closeContextMenuOnClickOutside, { capture: true, once: true });
  }, 350);
};

const handleTouchMove = (event: TouchEvent) => {
  if (!touchTimer) return;
  const touch = event.touches[0];
  if (Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY) > 10) {
    clearTimeout(touchTimer);
    touchTimer = null;
  }
};

const handleTouchEnd = () => {
  if (touchTimer) {
    clearTimeout(touchTimer);
    touchTimer = null;
  }
};

const handleActivate = (tabId: string) => {
  if (isLongPressTriggered) {
    isLongPressTriggered = false;
    return;
  }
  emit('activate-tab', tabId);
};

const handleClose = (event: MouseEvent | TouchEvent, tabId: string) => {
  event.stopPropagation();
  emit('close-tab', tabId);
};

const handleContextMenuAction = (payload: { action: string; targetId: string | number | null }) => {
  const { action, targetId } = payload;
  if (!targetId || typeof targetId !== 'string') return;

  switch (action) {
    case 'close':
      emit('close-tab', targetId);
      break;
    case 'close-others':
      emit('close-other-tabs', targetId);
      break;
    case 'close-right':
      emit('close-tabs-to-right', targetId);
      break;
    case 'close-left':
      emit('close-tabs-to-left', targetId);
      break;
    case 'split-right':
      emit('split-right', targetId);
      break;
    case 'split-down':
      emit('split-down', targetId);
      break;
  }
};

const contextMenuItems = computed(() => {
  const targetId = contextTargetTabId.value;
  if (!targetId) return [];

  const currentIndex = props.tabs.findIndex(t => t.id === targetId);
  const totalTabs = props.tabs.length;
  const items = [];

  items.push({ label: 'tabs.contextMenu.close', action: 'close' });

  if (totalTabs > 1) {
    items.push({ label: 'tabs.contextMenu.closeOthers', action: 'close-others' });
  }

  if (currentIndex < totalTabs - 1) {
    items.push({ label: 'tabs.contextMenu.closeRight', action: 'close-right' });
  }

  if (currentIndex > 0) {
    items.push({ label: 'tabs.contextMenu.closeLeft', action: 'close-left' });
  }

  return items;
});

onBeforeUnmount(() => {
  if (touchTimer) clearTimeout(touchTimer);
  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
});
</script>

<template>
  <div class="mobile-file-editor-tabs flex flex-nowrap overflow-x-auto overflow-y-hidden select-none flex-shrink-0">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="mobile-tab-item flex items-center shrink-0 cursor-pointer relative"
      :class="{ active: tab.id === activeTabId }"
      @click="handleActivate(tab.id)"
      @touchstart="handleTouchStart($event, tab.id)"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
      @touchcancel="handleTouchEnd"
      :title="tab.filePath"
    >
      <span class="mobile-tab-filename truncate">{{ tab.filename }}</span>
      <span v-if="tab.isModified" class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 mx-1"></span>
      <button
        class="mobile-close-tab-btn flex items-center justify-center shrink-0"
        @click.stop="handleClose($event, tab.id)"
        :title="t('fileManager.actions.closeTab')"
      >
        ×
      </button>
    </div>

    <div v-if="tabs.length === 0" class="flex-grow"></div>

    <TabBarContextMenu
      :visible="contextMenuVisible"
      :position="contextMenuPosition"
      :items="contextMenuItems"
      :target-id="menuTargetId"
      @menu-action="handleContextMenuAction"
      @close="closeContextMenu"
    />
  </div>
</template>

<style scoped>
.mobile-file-editor-tabs {
  height: 38px;
  background-color: #1c1c1e;
  border-bottom: 1px solid #333336;
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-overflow-scrolling: touch;
}

.mobile-file-editor-tabs::-webkit-scrollbar {
  display: none;
}

.mobile-tab-item {
  height: 38px;
  padding: 0 8px 0 12px;
  border-right: 1px solid #2d2d30;
  font-size: 12px;
  color: #cccccc;
  background-color: #222225;
  transition: background-color 0.1s ease;
}

.mobile-tab-item:active {
  background-color: #2a2a2e;
}

.mobile-tab-item.active {
  background-color: #18181a;
  color: #ffffff;
  border-bottom: 2px solid var(--nexus-primary, #3b82f6);
}

.mobile-tab-filename {
  max-width: 120px;
  font-weight: 500;
}

.mobile-close-tab-btn {
  width: 24px;
  height: 24px;
  font-size: 15px;
  line-height: 1;
  padding: 0;
  margin-left: 6px;
  border-radius: 6px;
  color: #a1a1aa;
  opacity: 0.85;
}

.mobile-tab-item.active .mobile-close-tab-btn {
  opacity: 1;
  color: #ffffff;
}

.mobile-close-tab-btn:active {
  background-color: rgba(255, 255, 255, 0.2);
  color: #ff6b6b;
}
</style>
