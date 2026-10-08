<script setup lang="ts">
import { ref, watch, nextTick, type PropType, onUnmounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SendFilesModal from './SendFilesModal.vue';
import type { ContextMenuItem } from '../composables/file-manager/useFileManagerContextMenu';
import type { FileListItem } from '../types/sftp.types';
import { useSessionStore } from '../stores/session.store';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  position: {
    type: Object as PropType<{ x: number; y: number }>,
    required: true,
  },
  items: {
    type: Array as PropType<ContextMenuItem[]>,
    required: true,
  },
  activeContextItem: {
    type: Object as PropType<FileListItem | null>,
    default: null,
  },
  selectedFileItems: {
    type: Array as PropType<FileListItem[]>,
    default: () => [],
  },
  currentDirectoryPath: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(['item-click', 'close-request']);

const { t } = useI18n();
const sessionStore = useSessionStore();
const showSendFilesModal = ref(false);
const itemsToSendData = ref<{ name: string; path: string; type: 'file' | 'directory' }[]>([]);

const sourceConnectionId = computed(() => {
  const activeConnId = sessionStore.activeSession?.connectionId;
  if (activeConnId) {
    const parsedId = parseInt(activeConnId, 10);
    return isNaN(parsedId) ? null : parsedId;
  }
  return null;
});

const contextMenuRef = ref<HTMLDivElement | null>(null);
const computedRenderPosition = ref({ x: props.position.x, y: props.position.y });

watch(
  [() => props.isVisible, () => props.position],
  ([newIsVisible, newPosition], [oldIsVisible, oldPosition]) => {
    if (newIsVisible) {
      const positionChangedWhileVisible = oldIsVisible && oldPosition && (newPosition.x !== oldPosition.x || newPosition.y !== oldPosition.y);
      if (!oldIsVisible || positionChangedWhileVisible) {
        computedRenderPosition.value = { ...newPosition };

        nextTick(() => {
          if (contextMenuRef.value) {
            const menuElement = contextMenuRef.value;
            const menuRect = menuElement.getBoundingClientRect();

            if (menuRect.width === 0 && menuRect.height === 0) return;

            let finalX = newPosition.x;
            let finalY = newPosition.y;
            const menuWidth = menuRect.width;
            const menuHeight = menuRect.height;
            const margin = 12;

            if (finalX + menuWidth > window.innerWidth) {
              finalX = window.innerWidth - menuWidth - margin;
            }
            if (finalY + menuHeight > window.innerHeight) {
              finalY = window.innerHeight - menuHeight - margin;
            }

            finalX = Math.max(margin, finalX);
            finalY = Math.max(margin, finalY);

            computedRenderPosition.value = { x: finalX, y: finalY };
          }
        });
      }
    } else {
      computedRenderPosition.value = { ...newPosition };
    }
  },
  { deep: true, immediate: true }
);

const handleClickOutside = (event: MouseEvent) => {
  if (contextMenuRef.value && !contextMenuRef.value.contains(event.target as Node)) {
    emit('close-request');
  }
};

watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    document.addEventListener('click', handleClickOutside, { capture: true });
  } else {
    document.removeEventListener('click', handleClickOutside, { capture: true });
  }
}, { immediate: true });

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, { capture: true });
});

const handleItemClick = (item: ContextMenuItem) => {
  if (item.action) {
    item.action();
    emit('close-request');
  }
};

const handleSendToClick = () => {
  const itemsToSend: { name: string; path: string; type: 'file' | 'directory' }[] = [];

  if (props.selectedFileItems && props.selectedFileItems.length > 0) {
    props.selectedFileItems.forEach(item => {
      const type = item.attrs.isDirectory ? 'directory' : 'file';
      let fullPath = props.currentDirectoryPath;
      if (!fullPath.endsWith('/')) {
        fullPath += '/';
      }
      fullPath += item.filename;
      fullPath = fullPath.replace(/(?<!:)\/\//g, '/');

      itemsToSend.push({
        name: item.filename,
        path: fullPath,
        type: type,
      });
    });
  } else if (props.activeContextItem) {
    const item = props.activeContextItem;
    const type = item.attrs.isDirectory ? 'directory' : 'file';
    let fullPath = props.currentDirectoryPath;
    if (!fullPath.endsWith('/')) {
      fullPath += '/';
    }
    fullPath += item.filename;
    fullPath = fullPath.replace(/(?<!:)\/\//g, '/');

    itemsToSend.push({
      name: item.filename,
      path: fullPath,
      type: type,
    });
  }

  itemsToSendData.value = itemsToSend;
  showSendFilesModal.value = true;
  emit('close-request');
};

const handleFilesSent = (payload: any) => {
  console.log('Files to send (from MobileFileManagerContextMenu):', payload);
};
</script>

<template>
  <div
    v-if="isVisible"
    ref="contextMenuRef"
    class="mobile-context-menu fixed bg-background/95 backdrop-blur-md border border-border/80 shadow-2xl rounded-xl z-[1002] min-w-[180px] max-w-[280px] py-1.5 select-none animate-in fade-in zoom-in-95 duration-100"
    :style="{ top: `${computedRenderPosition.y}px`, left: `${computedRenderPosition.x}px` }"
    @click.stop
  >
    <ul class="list-none p-0 m-0">
      <template v-for="(menuItem, index) in items" :key="index">
        <li v-if="menuItem.separator" class="border-t border-border/60 my-1 mx-2"></li>

        <!-- 移动端子菜单平铺模式 -->
        <template v-else-if="menuItem.submenu && menuItem.submenu.length > 0">
          <li
            v-for="(subItem, subIndex) in menuItem.submenu"
            :key="`${index}-${subIndex}`"
            @click.stop="handleItemClick(subItem)"
            class="px-3.5 py-2.5 cursor-pointer text-foreground text-sm flex items-center active:bg-primary/20 transition-colors duration-100 rounded-lg mx-1"
          >
            {{ subItem.label }}
          </li>
          <!-- 压缩项后的“发送到”快捷项 -->
          <template v-if="menuItem.label === t('fileManager.contextMenu.compress')">
            <li
              @click.stop="handleSendToClick"
              class="px-3.5 py-2.5 cursor-pointer text-foreground text-sm flex items-center active:bg-primary/20 transition-colors duration-100 rounded-lg mx-1"
            >
              {{ t('fileManager.contextMenu.sendTo', 'Send to...') }}
            </li>
          </template>
        </template>

        <!-- 普通一级菜单项 -->
        <li
          v-else
          @click.stop="handleItemClick(menuItem)"
          class="px-3.5 py-2.5 cursor-pointer text-foreground text-sm flex items-center active:bg-primary/20 transition-colors duration-100 rounded-lg mx-1"
        >
          {{ menuItem.label }}
        </li>

        <!-- 普通压缩项后的“发送到”快捷项 -->
        <template v-if="!menuItem.submenu && menuItem.label === t('fileManager.contextMenu.compress')">
          <li
            @click.stop="handleSendToClick"
            class="px-3.5 py-2.5 cursor-pointer text-foreground text-sm flex items-center active:bg-primary/20 transition-colors duration-100 rounded-lg mx-1"
          >
            {{ t('fileManager.contextMenu.sendTo', 'Send to...') }}
          </li>
        </template>
      </template>
    </ul>
  </div>

  <SendFilesModal
    v-model:visible="showSendFilesModal"
    :items-to-send="itemsToSendData"
    :source-connection-id="sourceConnectionId"
    @send="handleFilesSent"
  />
</template>

<style scoped>
.mobile-context-menu {
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
}
</style>
