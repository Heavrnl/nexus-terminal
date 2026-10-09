<script setup lang="ts">
import { ref, computed, PropType, onMounted, onBeforeUnmount, watch } from 'vue';
import draggable from 'vuedraggable';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import WorkspaceConnectionListComponent from './WorkspaceConnectionList.vue';
import TabBarContextMenu from './TabBarContextMenu.vue';
import MobileTerminalTabBar from './MobileTerminalTabBar.vue';
import { useSessionStore } from '../stores/session.store';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useLayoutStore } from '../stores/layout.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import type { SessionTabInfoWithStatus } from '../stores/session/types';

const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();
const layoutStore = useLayoutStore();
const connectionsStore = useConnectionsStore();
const workspaceSyncStore = useWorkspaceSyncStore();
const { isHeaderVisible } = storeToRefs(layoutStore);
const { syncEnabled, isSyncing } = storeToRefs(workspaceSyncStore);
const { toggleSyncEnabled } = workspaceSyncStore;
const route = useRoute();

const props = defineProps({
  sessions: {
    type: Array as PropType<SessionTabInfoWithStatus[]>,
    required: true,
  },
  activeSessionId: {
    type: String as PropType<string | null>,
    required: false,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  (e: 'update:sessions', newSessions: SessionTabInfoWithStatus[]): void;
}>();

const activateSession = (sessionId: string) => {
  if (sessionId !== props.activeSessionId) {
    emitWorkspaceEvent('session:activate', { sessionId });
  }
};

const closeSession = (event: MouseEvent, sessionId: string) => {
  event.stopPropagation();
  emitWorkspaceEvent('session:close', { sessionId });
};

// --- 桌面端本地状态 ---
const sessionStore = useSessionStore();
const showConnectionListPopup = ref(false);
const draggableSessions = ref<SessionTabInfoWithStatus[]>([]);

watch(() => props.sessions, (newSessions) => {
  draggableSessions.value = [...newSessions];
}, { immediate: true, deep: true });

// --- 右键菜单状态 ---
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextTargetSessionId = ref<string | null>(null);
const menuTargetId = ref<string | null>(null);

const togglePopup = () => {
  showConnectionListPopup.value = !showConnectionListPopup.value;
};

const handlePopupConnect = (connectionId: number) => {
  const connectionInfo = connectionsStore.connections.find(c => c.id === connectionId);
  if (!connectionInfo) {
    console.error(`[TabBar] handlePopupConnect: 未找到 ID 为 ${connectionId} 的连接信息。`);
    showConnectionListPopup.value = false;
    return;
  }

  if (connectionInfo.type === 'RDP') {
    sessionStore.openRdpModal(connectionInfo);
  } else {
    sessionStore.handleConnectRequest(connectionInfo);
  }
  showConnectionListPopup.value = false;
};

const handleRequestAddFromPopup = () => {
  showConnectionListPopup.value = false;
  emitWorkspaceEvent('connection:requestAdd');
};

const handleRequestEditFromPopup = (connection: ConnectionInfo) => {
  showConnectionListPopup.value = false;
  emitWorkspaceEvent('connection:requestEdit', { connectionInfo: connection });
};

const showContextMenu = (event: MouseEvent, sessionId: string) => {
  event.preventDefault();
  event.stopPropagation();

  contextTargetSessionId.value = sessionId;
  menuTargetId.value = sessionId;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  contextMenuVisible.value = true;

  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
  document.addEventListener('click', closeContextMenuOnClickOutside, { capture: true });
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextTargetSessionId.value = null;
  menuTargetId.value = null;
  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
};

const closeContextMenuOnClickOutside = (event: MouseEvent) => {
  const menuElement = document.querySelector('.tab-bar-context-menu');
  if (menuElement && !menuElement.contains(event.target as Node)) {
    closeContextMenu();
  }
};

const handleContextMenuAction = (payload: { action: string; targetId: string | number | null }) => {
  const { action, targetId } = payload;
  if (!targetId || typeof targetId !== 'string') {
    console.warn('[TabBar] handleContextMenuAction called but targetId is null or not a string.');
    return;
  }

  switch (action) {
    case 'close':
      emitWorkspaceEvent('session:close', { sessionId: targetId });
      break;
    case 'close-others':
      emitWorkspaceEvent('session:closeOthers', { targetSessionId: targetId });
      break;
    case 'close-right':
      emitWorkspaceEvent('session:closeToRight', { targetSessionId: targetId });
      break;
    case 'close-left':
      emitWorkspaceEvent('session:closeToLeft', { targetSessionId: targetId });
      break;
    case 'mark-for-suspend':
      sessionStore.requestStartSshSuspend(targetId);
      break;
    case 'unmark-for-suspend':
      sessionStore.requestUnmarkSshSuspend(targetId);
      break;
    default:
      console.warn(`[TabBar] 未知的菜单操作: ${action}`);
  }
};

const contextMenuItems = computed(() => {
  const items = [];
  const targetSessionIdValue = contextTargetSessionId.value;
  if (!targetSessionIdValue) return [];

  const targetSessionState = sessionStore.sessions.get(targetSessionIdValue);
  if (!targetSessionState) return [];

  const connectionIdNum = parseInt(targetSessionState.connectionId, 10);
  const connectionInfo = connectionsStore.connections.find(c => c.id === connectionIdNum);

  const currentIndex = props.sessions.findIndex(s => s.sessionId === targetSessionIdValue);
  const totalTabs = props.sessions.length;

  if (connectionInfo && connectionInfo.type === 'SSH') {
    const isActiveSession = targetSessionState.wsManager.isConnected.value;
    if (isActiveSession) {
      if (targetSessionState.isMarkedForSuspend) {
        items.push({ label: 'tabs.contextMenu.unmarkForSuspend', action: 'unmark-for-suspend' });
      } else {
        items.push({ label: 'tabs.contextMenu.suspendSession', action: 'mark-for-suspend' });
      }
      items.push({ label: '', action: '', isSeparator: true });
    }
  }

  items.push({ label: 'tabs.contextMenu.close', action: 'close' });

  if (totalTabs > 1) {
    items.push({ label: 'tabs.contextMenu.closeOthers', action: 'close-others' });
  }

  if (currentIndex < totalTabs - 1 && totalTabs > 1) {
    items.push({ label: 'tabs.contextMenu.closeRight', action: 'close-right' });
  }

  if (currentIndex > 0 && totalTabs > 1) {
    items.push({ label: 'tabs.contextMenu.closeLeft', action: 'close-left' });
  }

  if (items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.isSeparator) {
      items.pop();
    }
  }

  return items;
});

const openLayoutConfigurator = () => {
  emitWorkspaceEvent('ui:openLayoutConfigurator');
};

const isWorkspaceRoute = ref(route.path === '/workspace');

watch(() => route.path, (newPath) => {
  isWorkspaceRoute.value = newPath === '/workspace';
});

const handleSessionsUpdate = (newSessions: SessionTabInfoWithStatus[]) => {
  emit('update:sessions', newSessions);
  const sessionOrder = newSessions.map(session => session.sessionId);
  sessionStore.setSessionOrder(sessionOrder);
};

const toggleHeader = () => {
  if (isWorkspaceRoute.value) {
    layoutStore.toggleHeaderVisibility();
  }
};

const eyeIconClass = computed(() => isHeaderVisible.value ? 'fas fa-eye' : 'fas fa-eye-slash');

const toggleButtonTitle = computed(() =>
  isHeaderVisible.value ? t('header.hide', '隐藏顶部导航') : t('header.show', '显示顶部导航')
);

const syncButtonTitle = computed(() => {
  if (!syncEnabled.value) {
    return t('workspaceSync.disabledTooltip', '工作区实时云端同步 (已关闭，点击开启)');
  }
  if (isSyncing.value) {
    return t('workspaceSync.syncingTooltip', '正在同步工作区到云端...');
  }
  return t('workspaceSync.enabledTooltip', '工作区实时云端同步 (已开启，点击可关闭)');
});

const handleDragStart = (event: DragEvent) => {
  if (event.dataTransfer) {
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    event.dataTransfer.setDragImage(img, 0, 0);
  }
};

const handleWheel: EventListener = (event: Event) => {
  const wheelEvent = event as WheelEvent;
  const container = wheelEvent.currentTarget as HTMLElement;
  if (container) {
    container.scrollLeft += wheelEvent.deltaY > 0 ? 50 : -50;
    wheelEvent.preventDefault();
  }
};

onMounted(() => {
  if (!props.isMobile) {
    const tabContainer = document.querySelector('.overflow-x-auto');
    if (tabContainer) {
      tabContainer.addEventListener('wheel', handleWheel as EventListener, { passive: false });
    }

    onWorkspaceEvent('connection:connect', (payload) => {
      handlePopupConnect(payload.connectionId);
    });

    onBeforeUnmount(() => {
      const container = document.querySelector('.overflow-x-auto');
      if (container) {
        container.removeEventListener('wheel', handleWheel as EventListener);
      }
    });
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
});
</script>

<template>
  <!-- 移动端视图：委托给独立的 MobileTerminalTabBar -->
  <MobileTerminalTabBar
    v-if="props.isMobile"
    :sessions="props.sessions"
    :active-session-id="props.activeSessionId"
  />

  <!-- 桌面端视图：带拖拽、右键菜单和标题栏控制的桌面标签栏 -->
  <div
    v-else
    class="flex items-center bg-header border border-border overflow-hidden rounded-t-md mx-2 mt-2 h-10 select-none relative"
  >
    <div class="flex items-center overflow-x-auto flex-shrink min-w-0 h-full">
      <draggable
        v-model="draggableSessions"
        item-key="sessionId"
        tag="ul"
        class="flex list-none p-0 m-0 h-full flex-shrink-0"
        @update:modelValue="handleSessionsUpdate"
        ghost-class="opacity-50"
        drag-class="opacity-75"
        animation="150"
      >
        <template #item="{ element: session }">
          <li
            :key="session.sessionId"
            :class="['flex items-center px-3 h-full cursor-pointer border-r border-border transition-colors duration-150 relative group',
                     session.sessionId === activeSessionId ? 'bg-background text-foreground' : 'bg-header text-text-secondary hover:bg-border']"
            @click="activateSession(session.sessionId)"
            @contextmenu.prevent="showContextMenu($event, session.sessionId)"
            @dragstart="handleDragStart"
            :title="session.connectionName"
          >
            <!-- 状态指示灯 -->
            <span :class="['w-2 h-2 rounded-full mr-2 flex-shrink-0',
                           session.isMarkedForSuspend ? 'bg-blue-500' :
                           session.status === 'connected' ? 'bg-green-500' :
                           session.status === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                           session.status === 'disconnected' ? 'bg-red-500' : 'bg-gray-400']"></span>
            <span class="truncate text-sm" style="transform: translateY(-1px);">{{ session.connectionName }}</span>
            <button
              class="ml-2 p-0.5 rounded-full text-text-secondary hover:bg-border hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-150"
              :class="{'text-foreground hover:bg-header': session.sessionId === activeSessionId}"
              @click="closeSession($event, session.sessionId)"
              :title="$t('tabs.closeTabTooltip')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </li>
        </template>
      </draggable>

      <!-- 新建标签按钮 -->
      <button
        class="flex items-center justify-center w-8 h-full text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0"
        @click="togglePopup"
        :title="$t('tabs.newTabTooltip')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>

    <!-- 桌面端右侧控制按钮区 -->
    <div class="ml-auto flex items-center h-full flex-shrink-0">
      <!-- 实时同步工作区按钮 -->
      <button
        class="group flex items-center justify-center px-3 h-full border-l border-border transition-colors duration-150 cursor-pointer"
        :class="syncEnabled ? 'text-emerald-500 hover:text-emerald-400 hover:bg-border' : 'text-text-secondary hover:text-foreground hover:bg-border'"
        @click="toggleSyncEnabled()"
        :title="syncButtonTitle"
      >
        <span class="relative inline-flex items-center justify-center">
          <i class="fas fa-cloud text-sm"></i>
          <!-- 开启状态：右下角绿色实心圆点 -->
          <span
            v-if="syncEnabled"
            class="absolute -bottom-0.5 -right-1 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-header shadow-sm"
          ></span>
          <!-- 关闭状态：一条带背景镂空间距的斜杠横穿云朵图标 -->
          <span
            v-else
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <!-- 视觉切割底层：使用与按钮背景严格同步的遮罩色 (常态 bg-header，悬停 group-hover:bg-border)，宽度高度充分隔离产生清晰留白切口 -->
            <span class="absolute w-[150%] h-[5px] bg-header group-hover:bg-border rotate-45 transform origin-center transition-colors duration-150"></span>
            <!-- 斜杠主体线：细线居中叠加 -->
            <span class="absolute w-[135%] h-[1.5px] bg-text-secondary group-hover:bg-foreground rotate-45 transform origin-center rounded-full transition-colors duration-150"></span>
          </span>
        </span>
      </button>

      <!-- 显隐导航栏按钮 -->
      <button
        class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
        :class="{ 'opacity-50 cursor-not-allowed': !isWorkspaceRoute }"
        :disabled="!isWorkspaceRoute"
        @click="toggleHeader"
        :title="toggleButtonTitle"
      >
        <i :class="eyeIconClass"></i>
      </button>

      <!-- 查看传输进度按钮 -->
      <button
        class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
        @click="emitWorkspaceEvent('ui:openTransferProgressModal')"
        :title="$t('terminalTabBar.showTransferProgressTooltip', '查看传输进度')"
      >
        <i class="fas fa-tasks text-sm"></i>
      </button>

      <!-- 布局配置器按钮 -->
      <button
        class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
        @click="openLayoutConfigurator"
        :title="$t('layout.configureButtonTooltip')"
      >
        <i class="fas fa-th-large text-sm"></i>
      </button>
    </div>

    <!-- 桌面端连接列表弹出层 -->
    <div
      v-if="showConnectionListPopup"
      class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4"
      @click.self="togglePopup"
    >
      <div class="bg-background rounded-lg shadow-xl border border-border w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        <div class="flex justify-between items-center p-4 border-b border-border">
          <h3 class="text-lg font-semibold text-foreground">{{ $t('tabs.selectConnection') }}</h3>
          <button @click="togglePopup" class="text-text-secondary hover:text-foreground">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="flex-grow overflow-y-auto p-4">
          <WorkspaceConnectionListComponent
            @connect="handlePopupConnect"
            @request-add-connection="handleRequestAddFromPopup"
            @request-edit-connection="handleRequestEditFromPopup"
          />
        </div>
      </div>
    </div>

    <!-- 右键上下文菜单 -->
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
