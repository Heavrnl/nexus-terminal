<script setup lang="ts">
import { ref, watch, nextTick, type PropType, onUnmounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SendFilesModal from './SendFilesModal.vue';
import MobileFileManagerContextMenu from './MobileFileManagerContextMenu.vue';
import type { ContextMenuItem } from '../composables/file-manager/useFileManagerContextMenu';
import type { FileListItem } from '../types/sftp.types';
import { useDeviceDetection } from '../composables/useDeviceDetection';
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
  activeContextItem: { // Item that was right-clicked
    type: Object as PropType<FileListItem | null>,
    default: null,
  },
  selectedFileItems: { // Items currently selected in the file manager
    type: Array as PropType<FileListItem[]>,
    default: () => [],
  },
  currentDirectoryPath: { // Current path of the file manager
    type: String,
    required: true,
  }
});

const { isMobile } = useDeviceDetection();
const { t } = useI18n();
const sessionStore = useSessionStore(); // +++ 使用 session store +++
const showSendFilesModal = ref(false);
// Update the type for itemsToSendData
const itemsToSendData = ref<{ name: string; path: string; type: 'file' | 'directory' }[]>([]);
const sourceConnectionId = computed(() => { // +++ 获取并转换源服务器 ID +++
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
      // 仅当菜单从不可见变为可见，或当菜单可见时其初始位置改变时，才进行位置计算
      // oldPosition 可能为 undefined，所以需要检查
      const positionChangedWhileVisible = oldIsVisible && oldPosition && (newPosition.x !== oldPosition.x || newPosition.y !== oldPosition.y);
      
      if (!oldIsVisible || positionChangedWhileVisible) {
        computedRenderPosition.value = { ...newPosition }; // 设置初始位置为当前点击位置

        nextTick(() => {
          if (contextMenuRef.value) {
            const menuElement = contextMenuRef.value;
            const menuRect = menuElement.getBoundingClientRect();

            // 如果菜单没有实际尺寸 (例如，内容为空或未渲染)，则不进行调整
            if (menuRect.width === 0 && menuRect.height === 0) {
              // console.debug("[FileManagerContextMenu] Menu dimensions are zero, sticking to initial position.");
              return;
            }

            let finalX = newPosition.x;
            let finalY = newPosition.y;
            const menuWidth = menuRect.width;
            const menuHeight = menuRect.height;
            const margin = 10; // 距离窗口边缘的最小间距

            // console.debug(`[FileManagerContextMenu] Initial pos: (${finalX}, ${finalY}), Menu size: (${menuWidth}x${menuHeight}), Window: (${window.innerWidth}x${window.innerHeight})`);

            // 调整水平位置，防止溢出右侧
            if (finalX + menuWidth > window.innerWidth) {
              finalX = window.innerWidth - menuWidth - margin;
            }

            // 调整垂直位置，防止溢出底部
            if (finalY + menuHeight > window.innerHeight) {
              finalY = window.innerHeight - menuHeight - margin;
            }

            // 确保菜单不超出屏幕左上角
            finalX = Math.max(margin, finalX);
            finalY = Math.max(margin, finalY);
            
            // console.debug(`[FileManagerContextMenu] Adjusted pos: (${finalX}, ${finalY})`);
            computedRenderPosition.value = { x: finalX, y: finalY };
          }
        });
      }
    } else {
      // 如果菜单不可见，确保 computedRenderPosition 与 props.position 同步，为下次显示做准备
      computedRenderPosition.value = { ...newPosition };
    }
  },
  { deep: true, immediate: true } // immediate 确保初始状态（如果isVisible为true）也设置正确
);

// 点击其他地方自动关闭菜单
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

// 隐藏菜单的逻辑由 useFileManagerContextMenu 中的全局点击监听器处理
// 但我们仍然需要触发菜单项的 action，并通知父组件关闭菜单
const emit = defineEmits(['item-click', 'close-request']); // 添加 close-request

const handleItemClick = (item: ContextMenuItem) => {
  if (item.action) {
    item.action(); // 只有当 action 存在时才执行
    emit('close-request'); // <-- 发出关闭请求
  }
};

const handleSendToClick = () => {
  const itemsToSend: { name: string; path: string; type: 'file' | 'directory' }[] = [];

  // 优先使用多选的项目
  if (props.selectedFileItems && props.selectedFileItems.length > 0) {
    props.selectedFileItems.forEach(item => {
      const type = item.attrs.isDirectory ? 'directory' : 'file';
      let fullPath = props.currentDirectoryPath;
      if (!fullPath.endsWith('/')) {
        fullPath += '/';
      }
      fullPath += item.filename;
      fullPath = fullPath.replace(/(?<!:)\/\//g, '/'); // Normalize path

      itemsToSend.push({
        name: item.filename,
        path: fullPath,
        type: type,
      });
    });
  } else if (props.activeContextItem) { // 如果没有多选项目，则使用右键点击的单个项目
    const item = props.activeContextItem;
    const type = item.attrs.isDirectory ? 'directory' : 'file';
    let fullPath = props.currentDirectoryPath;
    if (!fullPath.endsWith('/')) {
      fullPath += '/';
    }
    fullPath += item.filename;
    fullPath = fullPath.replace(/(?<!:)\/\//g, '/'); // Normalize path

    itemsToSend.push({
      name: item.filename,
      path: fullPath,
      type: type,
    });
  }
  // else {
    // 如果两者都为空，itemsToSend 将保持为空数组
  // }

  itemsToSendData.value = itemsToSend;
  showSendFilesModal.value = true;
  emit('close-request');
};

const handleFilesSent = (payload: any) => {
  console.log('Files to send (from FileManagerContextMenu):', payload);
  // 实际发送逻辑可以后续添加或委派
};



// 管理二级菜单的展开状态
const expandedSubmenu = ref<string | null>(null);
let closeTimeout: NodeJS.Timeout | null = null;

const showSubmenu = (label: string) => {
  if (closeTimeout) {
    clearTimeout(closeTimeout);
    closeTimeout = null;
  }
  expandedSubmenu.value = label;
};

const hideSubmenu = () => {
  closeTimeout = setTimeout(() => {
    expandedSubmenu.value = null;
    closeTimeout = null;
  }, 300); // 延迟300ms关闭
};

onUnmounted(() => {
  if (closeTimeout) {
    clearTimeout(closeTimeout);
  }
});
</script>

<template>
  <!-- 移动端专属上下文右键触控菜单 -->
  <MobileFileManagerContextMenu
    v-if="isMobile"
    :is-visible="isVisible"
    :position="position"
    :items="items"
    :active-context-item="activeContextItem"
    :selected-file-items="selectedFileItems"
    :current-directory-path="currentDirectoryPath"
    @item-click="(item) => emit('item-click', item)"
    @close-request="emit('close-request')"
  />

  <!-- 桌面端全功能鼠标悬浮二级右键菜单 -->
  <template v-else>
    <div
      ref="contextMenuRef"
      v-if="isVisible"
      class="fixed bg-background border border-border shadow-lg rounded-md z-[1002] min-w-[150px]"
      :style="{ top: `${computedRenderPosition.y}px`, left: `${computedRenderPosition.x}px` }"
      @click.stop
    >
      <ul class="list-none p-1 m-0">
        <template v-for="(menuItem, index) in items" :key="index">
          <li v-if="menuItem.separator" class="border-t border-border/50 my-1 mx-1"></li>

          <!-- 普通一级菜单项 -->
          <li
            v-else-if="!menuItem.submenu"
            @click.stop="handleItemClick(menuItem)"
            :class="[
              'px-4 py-1.5 cursor-pointer text-foreground text-sm flex items-center transition-colors duration-150 rounded mx-1',
              'hover:bg-primary/10 hover:text-primary'
            ]"
          >
            {{ menuItem.label }}
          </li>

          <!-- 普通压缩项后的“发送到”快捷项 -->
          <template v-if="!menuItem.submenu && menuItem.label === t('fileManager.contextMenu.compress')">
            <li
              @click.stop="handleSendToClick"
              :class="[
                'px-4 py-1.5 cursor-pointer text-foreground text-sm flex items-center transition-colors duration-150 rounded mx-1',
                'hover:bg-primary/10 hover:text-primary'
              ]"
            >
              {{ t('fileManager.contextMenu.sendTo', 'Send to...') }}
            </li>
          </template>

          <!-- 桌面端带子菜单的项：悬浮 hover 展开二级菜单 -->
          <li
            v-if="menuItem.submenu"
            class="px-4 py-1.5 text-foreground text-sm flex items-center justify-between transition-colors duration-150 rounded mx-1 hover:bg-primary/10 hover:text-primary relative"
            @mouseenter="showSubmenu(menuItem.label)"
            @mouseleave="hideSubmenu()"
          >
            {{ menuItem.label }}
            <span class="ml-2">›</span>
            <ul
              v-if="expandedSubmenu === menuItem.label"
              class="absolute left-full top-0 mt-0 ml-1 bg-background border border-border shadow-lg rounded-md z-[1003] min-w-[150px] list-none p-1"
              @mouseenter="showSubmenu(menuItem.label)"
              @mouseleave="hideSubmenu()"
            >
              <li
                v-for="(subItem, subIndex) in menuItem.submenu"
                :key="subIndex"
                @click.stop="handleItemClick(subItem)"
                :class="[
                  'px-4 py-1.5 cursor-pointer text-foreground text-sm flex items-center transition-colors duration-150 rounded mx-1',
                  'hover:bg-primary/10 hover:text-primary'
                ]"
              >
                {{ subItem.label }}
              </li>
            </ul>
          </li>

          <!-- 桌面端带子菜单的压缩项后的“发送到”快捷项 -->
          <template v-if="menuItem.submenu && menuItem.label === t('fileManager.contextMenu.compress')">
            <li
              @click.stop="handleSendToClick"
              :class="[
                'px-4 py-1.5 cursor-pointer text-foreground text-sm flex items-center transition-colors duration-150 rounded mx-1',
                'hover:bg-primary/10 hover:text-primary'
              ]"
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
</template>
