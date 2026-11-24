<script setup lang="ts">
import { ref, computed, PropType, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
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
import { isDesktopApp } from '../utils/platform';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import type { SessionTabInfoWithStatus } from '../stores/session/types';
import { activeSftpDragPayload } from '../composables/file-manager/useFileManagerDragAndDrop';

const { t } = useI18n();
const isDesktop = ref(isDesktopApp());
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();
const layoutStore = useLayoutStore();
const connectionsStore = useConnectionsStore();
const workspaceSyncStore = useWorkspaceSyncStore();
const { isHeaderVisible } = storeToRefs(layoutStore);
const { syncEnabled, isSyncing, runtimeMode, offlineMode } = storeToRefs(workspaceSyncStore);
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

// --- 拖拽文件到标签 = 切换到那个会话 ---
/**
 * 从文件管理器拖文件时，把鼠标移到某个会话标签上停一下，工作区就切到那个会话，
 * 接着往下移到它的文件管理器里松手即可 —— 不用先点标签再重新拖一次。
 *
 * 只认 SFTP 拖拽载荷：标签本身用 vuedraggable 排序，不能把它的拖拽吃进来。
 */
const DRAG_SWITCH_DELAY_MS = 350;
const dragOverTabId = ref<string | null>(null);
let dragSwitchTimer: ReturnType<typeof setTimeout> | null = null;

const isSftpDragEvent = (event: DragEvent): boolean => {
  if (activeSftpDragPayload.value) return true;
  return event.dataTransfer?.types?.includes('application/x-nexus-sftp-items') ?? false;
};

const clearDragTabState = () => {
  if (dragSwitchTimer) {
    clearTimeout(dragSwitchTimer);
    dragSwitchTimer = null;
  }
  dragOverTabId.value = null;
};

const onTabDragOver = (sessionId: string, event: DragEvent) => {
  if (!isSftpDragEvent(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  if (dragOverTabId.value === sessionId) return;

  clearDragTabState();
  dragOverTabId.value = sessionId;
  // 停留一下再切：鼠标扫过整条标签栏时不应该一路开着新会话
  dragSwitchTimer = setTimeout(() => {
    dragSwitchTimer = null;
    if (dragOverTabId.value !== sessionId) return;
    if (sessionId !== sessionStore.activeSessionId) {
      console.log(`[TabBar] 拖拽悬停，切换到会话 ${sessionId}`);
      activateSession(sessionId);
    }
  }, DRAG_SWITCH_DELAY_MS);
};

const onTabDragLeave = (sessionId: string, event: DragEvent) => {
  const related = event.relatedTarget as Node | null;
  const current = event.currentTarget as HTMLElement | null;
  if (related && current && current.contains(related)) return;
  if (dragOverTabId.value === sessionId) clearDragTabState();
};

const onTabDrop = async (sessionId: string, event: DragEvent) => {
  if (!isSftpDragEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();

  // 先抓一份载荷：等到下面把落下转交给文件管理器时，源标签的 dragend 可能已经把
  // 全局载荷清空了（DataTransfer 在 dragend 之后也进保护模式，读不出内容）
  const payloadSnapshot = activeSftpDragPayload.value
    ? JSON.parse(JSON.stringify(activeSftpDragPayload.value))
    : null;
  clearDragTabState();

  if (sessionId !== sessionStore.activeSessionId) {
    activateSession(sessionId);
    await nextTick();
    await nextTick();
  }

  // 直接松手在标签上也算数：把这次落下转交给刚刚变得可见的文件管理器，
  // 用的是它自己当前的路径，不猜。
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-fm-drop-target]'));
  const visible = targets.find(el => el.offsetParent !== null);
  if (!visible) {
    console.warn('[TabBar] 拖拽落在标签上，但没找到可见的文件管理器');
    return;
  }
  if (payloadSnapshot) activeSftpDragPayload.value = payloadSnapshot;
  visible.dispatchEvent(new DragEvent('drop', {
    dataTransfer: event.dataTransfer ?? undefined,
    bubbles: true,
    cancelable: true,
  }));
  // 转交那一刻的 DataTransfer 已经进保护模式（dragend 之后 getData 读不出内容），
  // 所以刚才把载荷塞回了全局；用完立刻撤掉，否则下一次拖动任何东西都会被当成
  // SFTP 拖拽（isSftpDragEvent 优先看全局载荷）。
  if (payloadSnapshot && activeSftpDragPayload.value === payloadSnapshot) {
    activeSftpDragPayload.value = null;
  }
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

  // SSH / RDP / VNC 一律走同一个入口：远程桌面现在是普通会话标签，不再弹窗
  sessionStore.handleConnectRequest(connectionInfo);
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
    case 'edit-connection': {
      // 右键的标签 → 找到它对应的连接 → 直接打开编辑窗口
      const session = sessionStore.sessions.get(targetId);
      const connIdNum = session ? parseInt(session.connectionId, 10) : NaN;
      const conn = Number.isNaN(connIdNum)
        ? undefined
        : connectionsStore.connections.find(c => c.id === connIdNum);
      if (conn) {
        emitWorkspaceEvent('connection:requestEdit', { connectionInfo: conn });
      } else {
        console.warn(`[TabBar] 找不到会话 ${targetId} 对应的连接，无法编辑`);
      }
      break;
    }
    case 'disconnect':
      // 只断通道、保留标签：SSH 由 WorkspaceView 处理，RDP/VNC 由 RemoteSessionPane 处理
      emitWorkspaceEvent('session:disconnect', { sessionId: targetId });
      break;
    case 'reconnect':
      emitWorkspaceEvent('session:reconnect', { sessionId: targetId });
      break;
    case 'suspend':
      // 先让后端当场接管 SSH，ACK 回来才清标签（内部会弹「已挂起」提示）
      sessionStore.closeSession(targetId, { suspend: true });
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

  // 编辑连接：任何能解析到连接的会话都给（SSH / RDP / VNC 都支持）
  if (connectionInfo) {
    items.push({ label: 'tabs.contextMenu.editConnection', action: 'edit-connection' });
    items.push({ label: '', action: '', isSeparator: true });
  }

  // 断开 / 重连：SSH 看 wsManager，远程桌面看画面自己的 remoteStatus。
  // 两项常驻，只把当前状态下用不上的那个置灰，菜单不至于忽隐忽现。
  const linkStatus = targetSessionState.kind === 'ssh'
    ? targetSessionState.wsManager.connectionStatus.value
    : (targetSessionState.remoteStatus?.value ?? 'disconnected');
  const canDisconnect = linkStatus === 'connected' || linkStatus === 'connecting';
  const canReconnect = linkStatus === 'disconnected' || linkStatus === 'error';
  items.push({ label: 'tabs.contextMenu.disconnect', action: 'disconnect', disabled: !canDisconnect });
  items.push({ label: 'tabs.contextMenu.reconnect', action: 'reconnect', disabled: !canReconnect });
  items.push({ label: '', action: '', isSeparator: true });

  // 挂起必须是显式操作：关标签只断开，想留连接就走这里。
  // 只给连着的 SSH 会话（断开状态下没什么可挂，RDP/VNC 也不支持挂起）。
  if (connectionInfo && connectionInfo.type === 'SSH' && targetSessionState.kind === 'ssh') {
    if (targetSessionState.wsManager.isConnected.value) {
      items.push({ label: 'tabs.contextMenu.suspendSession', action: 'suspend' });
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

// --- 工作区同步按钮状态判定（Web 与桌面端统一启用，桌面端细分云端在线 / 云端离线 / 本地恢复三态） ---
const isSyncActive = computed(() => syncEnabled.value);
const isSyncInProgress = computed(() => isSyncing.value);

const syncStatusDotClass = computed(() => {
  if (!syncEnabled.value) return '';
  if (offlineMode.value || runtimeMode.value === 'desktop_cloud_offline') {
    return 'bg-amber-500';
  }
  if (runtimeMode.value === 'desktop_local_only') {
    return 'bg-sky-500';
  }
  return 'bg-emerald-500';
});

const syncButtonColorClass = computed(() => {
  if (!syncEnabled.value) {
    return 'text-text-secondary hover:text-foreground hover:bg-border cursor-pointer';
  }
  if (offlineMode.value || runtimeMode.value === 'desktop_cloud_offline') {
    return 'text-amber-500 hover:text-amber-400 hover:bg-border cursor-pointer';
  }
  if (runtimeMode.value === 'desktop_local_only') {
    return 'text-sky-500 hover:text-sky-400 hover:bg-border cursor-pointer';
  }
  return 'text-emerald-500 hover:text-emerald-400 hover:bg-border cursor-pointer';
});

const syncButtonTitle = computed(() => {
  if (!syncEnabled.value) {
    return t('workspaceSync.disabledTooltip', '工作区实时云端同步 (已关闭，点击开启)');
  }
  if (isSyncing.value) {
    return t('workspaceSync.syncingTooltip', '正在同步工作区到云端...');
  }
  if (offlineMode.value || runtimeMode.value === 'desktop_cloud_offline') {
    return t('workspaceSync.offlineTooltip', '云端服务暂时不可达，已切换为本地离线缓存（恢复连通后自动同步）');
  }
  if (runtimeMode.value === 'desktop_local_only') {
    return t('workspaceSync.desktopLocalTooltip', '桌面端本地工作区恢复已开启（配置云端同步后自动升级为跨端实时同步）');
  }
  return t('workspaceSync.enabledTooltip', '工作区实时云端同步 (已开启，点击可关闭)');
});

const handleSyncButtonClick = () => {
  toggleSyncEnabled();
};

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
    :class="[
      'flex items-center bg-header overflow-hidden h-10 select-none relative transition-all duration-150',
      isHeaderVisible
        ? 'border border-border rounded-t-md mx-2 mt-2'
        : 'border-b border-border rounded-none m-0'
    ]"
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
                     session.sessionId === activeSessionId ? 'bg-background text-foreground' : 'bg-header text-text-secondary hover:bg-border',
                     dragOverTabId === session.sessionId ? 'ring-2 ring-primary/70 ring-inset bg-primary/10' : '']"
            @click="activateSession(session.sessionId)"
            @contextmenu.prevent="showContextMenu($event, session.sessionId)"
            @dragstart="handleDragStart"
            @dragover="onTabDragOver(session.sessionId, $event)"
            @dragleave="onTabDragLeave(session.sessionId, $event)"
            @drop="onTabDrop(session.sessionId, $event)"
            :title="session.isUnreachablePlaceholder ? `${session.connectionName} · ${$t('workspace.status.unreachablePlaceholderBadge', '离线占位（可右键重试）')}` : (session.hostingMode === 'remote-agent' ? `${session.connectionName} · ${$t('remoteAgent.badge.remoteHosted', '目标机托管')}` : session.connectionName)"
          >
            <!-- 状态指示灯 -->
            <span :class="['w-2 h-2 rounded-full mr-2 flex-shrink-0',
                           session.isUnreachablePlaceholder ? 'bg-amber-500' :
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
      <!-- 实时同步工作区按钮（Web 端与桌面端平权展示） -->
      <button
        class="group flex items-center justify-center px-3 h-full border-l border-border transition-colors duration-150"
        :class="syncButtonColorClass"
        @click="handleSyncButtonClick"
        :title="syncButtonTitle"
      >
        <span class="relative inline-flex items-center justify-center">
          <i class="text-sm fas fa-cloud"></i>
          <!-- 开启状态：右下角状态实心圆点（绿=云端同步，琥珀=离线降级，蓝=桌面本地恢复） -->
          <span
            v-if="isSyncActive"
            :class="['absolute -bottom-0.5 -right-1 w-2 h-2 rounded-full ring-2 ring-header shadow-sm', syncStatusDotClass]"
          ></span>
          <!-- 关闭状态：一条带背景镂空间距的斜杠横穿云朵图标 -->
          <span
            v-else
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <!-- 视觉切割底层：使用与按钮背景严格同步的遮罩色 (常态 bg-header，悬停 group-hover:bg-border) -->
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
