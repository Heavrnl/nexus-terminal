<script setup lang="ts">
import { ref, computed, PropType, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import draggable from 'vuedraggable';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import WorkspaceConnectionListComponent from './WorkspaceConnectionList.vue';
import TabBarContextMenu from './TabBarContextMenu.vue';
import TransferProgressModal from './TransferProgressModal.vue';
import { useSessionStore } from '../stores/session.store';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useLayoutStore, type PaneName } from '../stores/layout.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // +++ 导入 useWorkspaceEventOff +++

import type { SessionTabInfoWithStatus } from '../stores/session/types'; // 路径修正


const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++
const onWorkspaceEvent = useWorkspaceEventSubscriber(); // +++ 获取事件订阅器 +++
const offWorkspaceEvent = useWorkspaceEventOff(); // +++ 获取事件取消订阅器 +++
const layoutStore = useLayoutStore(); // 初始化布局 store
const connectionsStore = useConnectionsStore();
const { isHeaderVisible } = storeToRefs(layoutStore); // 从 layout store 获取主导航栏可见状态
const route = useRoute(); // 获取路由实例

// 定义 Props
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

// 定义事件 (保留 update:sessions 用于 v-model)
const emit = defineEmits<{
  (e: 'update:sessions', newSessions: SessionTabInfoWithStatus[]): void;
}>();


const activateSession = (sessionId: string) => {
  if (sessionId !== props.activeSessionId) {
    emitWorkspaceEvent('session:activate', { sessionId });
  }
};

const closeSession = (event: MouseEvent, sessionId: string) => {
  event.stopPropagation(); // 阻止事件冒泡到标签点击事件
  emitWorkspaceEvent('session:close', { sessionId });
};

// --- 本地状态 ---
const sessionStore = useSessionStore(); // Session store 保持不变
const showConnectionListPopup = ref(false); // 连接列表弹出状态
const draggableSessions = ref<SessionTabInfoWithStatus[]>([]); // + Local state for draggable
const showTransferProgressModal = ref(false); // 控制传输进度模态框的显示状态

// + Watch prop changes to update local state
watch(() => props.sessions, (newSessions) => {
  // Create a shallow copy to avoid modifying the prop directly
  draggableSessions.value = [...newSessions];
}, { immediate: true, deep: true });

// +++ 右键菜单状态 +++
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextTargetSessionId = ref<string | null>(null); // Keep for logic inside this component if needed elsewhere
const menuTargetId = ref<string | null>(null); // + Ref specifically for passing to the menu prop

const togglePopup = () => {
  showConnectionListPopup.value = !showConnectionListPopup.value;
};

// 处理从弹出列表中选择连接的事件
const handlePopupConnect = (connectionId: number) => {
  console.log(`[TabBar] Popup connect request for ID: ${connectionId}`);
  const connectionInfo = connectionsStore.connections.find(c => c.id === connectionId);
  if (!connectionInfo) {
    console.error(`[TabBar] handlePopupConnect: 未找到 ID 为 ${connectionId} 的连接信息。`);
    showConnectionListPopup.value = false; // 关闭弹出窗口
    return;
  }

  // --- 修改：根据类型决定调用哪个 Action ---
  if (connectionInfo.type === 'RDP') {
    console.log(`[TabBar] Popup RDP connect request for ID: ${connectionId}. Calling sessionStore.openRdpModal.`);
    sessionStore.openRdpModal(connectionInfo);
  } else {
    console.log(`[TabBar] Popup non-RDP connect request for ID: ${connectionId}. Calling sessionStore.handleConnectRequest.`);
    sessionStore.handleConnectRequest(connectionInfo); // 非 RDP 保持原逻辑
  }
  showConnectionListPopup.value = false; // 关闭弹出窗口
};

// 处理从弹窗内部发出的添加连接请求
const handleRequestAddFromPopup = () => {
  console.log('[TabBar] Received request-add-connection from popup component.');
  showConnectionListPopup.value = false; // 关闭弹窗
  emitWorkspaceEvent('connection:requestAdd'); // 向上发出事件
};

// 处理从弹窗内部发出的编辑连接请求
const handleRequestEditFromPopup = (connection: ConnectionInfo) => { // 假设 WorkspaceConnectionList 传递了连接对象
  console.log('[TabBar] Received request-edit-connection from popup component for connection:', connection);
  showConnectionListPopup.value = false; // 关闭弹窗
  // 向上发出事件，并携带连接信息
  emitWorkspaceEvent('connection:requestEdit', { connectionInfo: connection });
};

// --- 移除 handleRequestRdpFromPopup 方法 ---
// const handleRequestRdpFromPopup = (connection: ConnectionInfo) => { ... };

// +++ 右键菜单方法 +++
const showContextMenu = (event: MouseEvent, sessionId: string) => {
  event.preventDefault();
  event.stopPropagation();
  contextTargetSessionId.value = sessionId; // Still set the original ref if needed elsewhere
  menuTargetId.value = sessionId; // + Set the dedicated ref for the prop
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  contextMenuVisible.value = true;
  // 添加全局监听器以关闭菜单
  document.addEventListener('click', closeContextMenuOnClickOutside, { capture: true, once: true });
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextTargetSessionId.value = null; // Clear original ref if needed
  // menuTargetId.value = null; // -- REMOVE THIS LINE -- Let the value persist until next show
  // 移除监听器（如果它仍然存在）
  document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
};

// 用于全局点击监听器的函数
const closeContextMenuOnClickOutside = (event: MouseEvent) => {
    // 检查点击是否发生在菜单内部，如果是，则不关闭
    // 这个检查在 TabBarContextMenu 组件内部通过 @click.stop 完成了
    // 所以这里可以直接关闭
    closeContextMenu();
};


// + Update function signature to receive payload
const handleContextMenuAction = (payload: { action: string; targetId: string | number | null }) => {
  const { action, targetId } = payload;
  console.log(`[TabBar] handleContextMenuAction received payload:`, JSON.stringify(payload)); // + Log received payload
  // const targetId = contextTargetSessionId.value; // No longer needed
  if (!targetId || typeof targetId !== 'string') { // Ensure targetId is a string (session ID)
      console.warn('[TabBar] handleContextMenuAction called but targetId is null or not a string.');
      return;
  }

  console.log(`[TabBar] Context menu action '${action}' requested for session ID: ${targetId}`); // Keep original log

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
      // 注意：关闭左侧通常不包括当前标签本身
      emitWorkspaceEvent('session:closeToLeft', { targetSessionId: targetId });
      break;
    case 'mark-for-suspend': // +++ 修改 action 名称 +++
      if (typeof targetId === 'string') {
        console.log(`[TabBar] Context menu action 'mark-for-suspend' requested for session ID: ${targetId}`);
        sessionStore.requestStartSshSuspend(targetId); // 这个 action 现在是标记
      } else {
        console.warn(`[TabBar] 'mark-for-suspend' action called with invalid targetId:`, targetId);
      }
      break;
    case 'unmark-for-suspend': 
      if (typeof targetId === 'string') {
        console.log(`[TabBar] Context menu action 'unmark-for-suspend' requested for session ID: ${targetId}`);
        sessionStore.requestUnmarkSshSuspend(targetId);
      } else {
        console.warn(`[TabBar] 'unmark-for-suspend' action called with invalid targetId:`, targetId);
      }
      break;
    default:
      console.warn(`[TabBar] Unknown context menu action: ${action}`);
  }
  // closeContextMenu(); // TabBarContextMenu 内部点击后会触发 close 事件
};

// 计算右键菜单项
const contextMenuItems = computed(() => {
  const items = [];
  const targetSessionIdValue = contextTargetSessionId.value; // 使用局部变量以避免多次访问 .value
  if (!targetSessionIdValue) return [];

  const targetSessionState = sessionStore.sessions.get(targetSessionIdValue);
  if (!targetSessionState) return []; // 如果找不到会话状态，则不显示菜单

  const connectionIdNum = parseInt(targetSessionState.connectionId, 10);
  const connectionInfo = connectionsStore.connections.find(c => c.id === connectionIdNum);

  const currentIndex = props.sessions.findIndex(s => s.sessionId === targetSessionIdValue);
  const totalTabs = props.sessions.length;

  // 添加标记/取消标记挂起会话菜单项（如果适用）
  if (connectionInfo && connectionInfo.type === 'SSH') {
    const isActiveSession = targetSessionState.wsManager.isConnected.value;
    if (isActiveSession) { // 只对活动的SSH会话显示相关操作
      if (targetSessionState.isMarkedForSuspend) {
        items.push({ label: 'tabs.contextMenu.unmarkForSuspend', action: 'unmark-for-suspend' });
      } else {
        // 当未标记时，显示原来的“挂起”文本，但 action 触发新的标记流程
        items.push({ label: 'tabs.contextMenu.suspendSession', action: 'mark-for-suspend' });
      }
      items.push({ label: '', action: '', isSeparator: true }); // 分隔符
    }
  }

  items.push({ label: 'tabs.contextMenu.close', action: 'close' });

  if (totalTabs > 1) {
    items.push({ label: 'tabs.contextMenu.closeOthers', action: 'close-others' });
  }

  if (currentIndex < totalTabs - 1 && totalTabs > 1) { // 仅当有右侧标签时显示
    items.push({ label: 'tabs.contextMenu.closeRight', action: 'close-right' });
  }

  if (currentIndex > 0 && totalTabs > 1) { // 仅当有左侧标签时显示
    items.push({ label: 'tabs.contextMenu.closeLeft', action: 'close-left' });
  }
  
  // 移除末尾可能存在的分隔符（如果它是最后一项）
  // 确保在 pop 之前检查 items[items.length - 1] 是否真的存在并且是分隔符
  if (items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.isSeparator) {
        items.pop();
    }
  }

  return items;
});


// 处理打开布局配置器的事件
const openLayoutConfigurator = () => {
  console.log('[TabBar] Emitting open-layout-configurator event');
  emitWorkspaceEvent('ui:openLayoutConfigurator'); // 发出事件
};

// --- Header Visibility Logic ---
const isWorkspaceRoute = ref(route.path === '/workspace'); // 检查是否在 /workspace 路由

// 监视路由变化
watch(() => route.path, (newPath) => {
  isWorkspaceRoute.value = newPath === '/workspace';
  if (isWorkspaceRoute.value) {
    // 进入 /workspace 时，不需要在这里加载 Header 状态，App.vue 会处理
    console.log('[TabBar] Entered /workspace route. Header toggle button is now active.');
  }
});

// 组件挂载时检查一次
onMounted(() => {
  isWorkspaceRoute.value = route.path === '/workspace';
  if (isWorkspaceRoute.value) {
    // 初始加载时，不需要在这里加载 Header 状态，App.vue 会处理
    console.log('[TabBar] Mounted on /workspace route. Header toggle button is now active.');
  }
  // 监听连接事件
  onWorkspaceEvent('connection:connect', (payload) => {
    console.log('[TabBar] Received connection:connect event:', payload);
    handlePopupConnect(payload.connectionId);
  });

  // +++ 监听打开传输进度模态框事件 +++
  const handleOpenTransferProgressModal = () => {
    console.log('[TabBar] Received ui:openTransferProgressModal event, opening modal.');
    showTransferProgressModal.value = true;
  };
  onWorkspaceEvent('ui:openTransferProgressModal', handleOpenTransferProgressModal);

  // 在组件卸载前取消订阅
  onBeforeUnmount(() => {
    offWorkspaceEvent('ui:openTransferProgressModal', handleOpenTransferProgressModal); // +++ 正确取消订阅 +++
  });
});

// +++ 组件卸载前移除全局监听器 +++
// onBeforeUnmount is imported now
onBeforeUnmount(() => {
    document.removeEventListener('click', closeContextMenuOnClickOutside, { capture: true });
});


// 切换主导航栏可见性 (只在 workspace 路由下生效)
// + Handler for when draggable updates the model
const handleSessionsUpdate = (newSessions: SessionTabInfoWithStatus[]) => {
  // v-model handles updating draggableSessions.value automatically
  emit('update:sessions', newSessions);
  // 保存用户自定义顺序到本地存储
  const sessionOrder = newSessions.map(session => session.sessionId);
  localStorage.setItem('sessionOrder', JSON.stringify(sessionOrder));
  console.log('[TabBar] 已保存用户自定义标签顺序到本地存储');
};
const toggleHeader = () => {
  if (isWorkspaceRoute.value) {
    console.log('[TabBar] Toggling header visibility');
    // 调用 store action
    layoutStore.toggleHeaderVisibility();
  } else {
    console.log('[TabBar] Not on /workspace route, toggle ignored.');
  }
};

// 计算属性，用于确定眼睛图标的类
const eyeIconClass = computed(() => {
  // 默认显示眼睛图标，如果主导航栏不可见，则显示斜杠眼睛
  // 注意：这里假设 isHeaderVisible 为 true 时是可见的
  return isHeaderVisible.value ? 'fas fa-eye' : 'fas fa-eye-slash';
});

// 计算属性，用于按钮的 title
const toggleButtonTitle = computed(() => {
  // 调整 i18n key 和默认文本
  return isHeaderVisible.value ? t('header.hide', '隐藏顶部导航') : t('header.show', '显示顶部导航');
});

// + Handler to hide the default drag image
const handleDragStart = (event: DragEvent) => {
  if (event.dataTransfer) {
    // Use a 1x1 transparent pixel as the drag image to hide the default ghost
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    event.dataTransfer.setDragImage(img, 0, 0);
  }
};

// 处理长按事件以在手机模式下触发挂起和取消挂起
let touchTimeout: number | null = null;
const touchDuration = 800; // 长按时间阈值，单位毫秒
let touchedSessionId: string | null = null;

const handleTouchStart = (event: TouchEvent, sessionId: string) => {
  if (props.isMobile) {
    touchedSessionId = sessionId;
    if (touchTimeout) {
      clearTimeout(touchTimeout);
    }
    touchTimeout = window.setTimeout(() => {
      if (touchedSessionId === sessionId) {
        const sessionState = sessionStore.sessions.get(sessionId);
        if (sessionState && sessionState.isMarkedForSuspend) {
          console.log(`[TabBar] Long press to unmark suspend for session ID: ${sessionId}`);
          sessionStore.requestUnmarkSshSuspend(sessionId);
        } else if (sessionState) {
          console.log(`[TabBar] Long press to mark suspend for session ID: ${sessionId}`);
          sessionStore.requestStartSshSuspend(sessionId);
        }
      }
      touchTimeout = null;
    }, touchDuration);
  }
};

const handleTouchEnd = (event: TouchEvent) => {
  if (touchTimeout) {
    clearTimeout(touchTimeout);
    touchTimeout = null;
  }
  touchedSessionId = null;
};
 // 处理鼠标滚轮事件以支持水平滚动
const handleWheel: EventListener = (event: Event) => {
  const wheelEvent = event as WheelEvent;
  const container = wheelEvent.currentTarget as HTMLElement;
  if (container) {
    // 根据滚轮方向调整水平滚动位置
    container.scrollLeft += wheelEvent.deltaY > 0 ? 50 : -50;
    wheelEvent.preventDefault(); // 阻止默认的垂直滚动
  }
};

// 在组件挂载时添加滚轮事件监听
onMounted(() => {
  const tabContainer = document.querySelector('.overflow-x-auto');
  if (tabContainer) {
    tabContainer.addEventListener('wheel', handleWheel as EventListener, { passive: false });
  }
});

// 在组件卸载时移除滚轮事件监听
onBeforeUnmount(() => {
  const tabContainer = document.querySelector('.overflow-x-auto');
  if (tabContainer) {
    tabContainer.removeEventListener('wheel', handleWheel as EventListener);
  }
});

// +++ 移动端标签容器与激活项居中滚动 +++
const mobileTabsContainerRef = ref<HTMLElement | null>(null);

watch(() => props.activeSessionId, async (newId) => {
  if (newId && props.isMobile) {
    await nextTick();
    const activeEl = mobileTabsContainerRef.value?.querySelector(`[data-tab-id="${newId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
});

</script>

<template>
  <!-- 外层容器：桌面端带边框圆角，移动端为一体化底控舱的上半部会话行 -->
  <div :class="[
    props.isMobile
      ? 'flex items-center w-full h-9 px-2 bg-header border-t border-border/40 select-none relative shrink-0'
      : 'flex items-center bg-header border border-border overflow-hidden rounded-t-md mx-2 mt-2 h-10 select-none relative'
  ]">
    <!-- ==================== 移动端特化视图 ==================== -->
    <template v-if="props.isMobile">
      <!-- + 号按键：最左侧轻羽图标按键 -->
      <button
        @click="togglePopup"
        class="flex-shrink-0 flex items-center justify-center w-6.5 h-6.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all mr-1"
        :title="$t('tabs.newTabTooltip')"
      >
        <i class="fas fa-plus text-xs"></i>
      </button>

      <!-- 纵向分割微线 -->
      <div class="h-3.5 w-[1px] bg-border/40 mr-1.5 flex-shrink-0"></div>

      <!-- 会话胶囊标签横向滚动列表 -->
      <div
        ref="mobileTabsContainerRef"
        class="flex items-center gap-1 overflow-x-auto no-scrollbar scroll-smooth flex-grow h-full py-0.5 min-w-0"
      >
        <div
          v-for="session in draggableSessions"
          :key="session.sessionId"
          :data-tab-id="session.sessionId"
          class="flex items-center px-2 h-6.5 rounded-md cursor-pointer flex-shrink-0 transition-all duration-150 select-none max-w-[150px]"
          :class="session.sessionId === activeSessionId
            ? 'bg-background text-primary border border-primary/30 font-medium shadow-xs'
            : 'text-text-secondary hover:text-foreground hover:bg-background/40 active:bg-background/60 border border-transparent'"
          @click="activateSession(session.sessionId)"
          @contextmenu.prevent="showContextMenu($event, session.sessionId)"
          @touchstart="handleTouchStart($event, session.sessionId)"
          @touchend="handleTouchEnd($event)"
          :title="session.connectionName"
        >
          <!-- 状态指示灯 -->
          <span
            :class="[
              'w-2 h-2 rounded-full mr-1.5 flex-shrink-0 transition-colors',
              session.isMarkedForSuspend ? 'bg-blue-500' :
              session.status === 'connected' ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]' :
              session.status === 'connecting' ? 'bg-yellow-500 animate-pulse' :
              session.status === 'disconnected' ? 'bg-red-500' : 'bg-gray-400'
            ]"
          ></span>

          <!-- 会话名称 -->
          <span class="truncate text-xs tracking-tight flex-grow min-w-0">
            {{ session.connectionName }}
          </span>

          <!-- 仅在激活的 Tab 上显示常驻关闭小叉号 -->
          <button
            v-if="session.sessionId === activeSessionId"
            class="ml-1.5 -mr-0.5 w-4 h-4 rounded-full flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0"
            @click.stop="closeSession($event, session.sessionId)"
            :title="$t('tabs.closeTabTooltip')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </template>

    <!-- ==================== 桌面端原有视图 ==================== -->
    <template v-else>
      <div class="flex items-center overflow-x-auto flex-shrink min-w-0 h-full"> <!-- Ensure inner div has h-full -->
      <draggable
        v-model="draggableSessions"
        item-key="sessionId"
        tag="ul"
        class="flex list-none p-0 m-0 h-full flex-shrink-0"
        @update:modelValue="handleSessionsUpdate"
        ghost-class="opacity-50"
        drag-class="opacity-75"
        animation="150"
        :disabled="props.isMobile"
      >
        <template #item="{ element: session }">
          <li
            :key="session.sessionId"
            :class="['flex items-center px-3 h-full cursor-pointer border-r border-border transition-colors duration-150 relative group',
                     session.sessionId === activeSessionId ? 'bg-background text-foreground' : 'bg-header text-text-secondary hover:bg-border']"
            @click="activateSession(session.sessionId)"
            @contextmenu.prevent="showContextMenu($event, session.sessionId)"
            @touchstart="handleTouchStart($event, session.sessionId)"
            @touchend="handleTouchEnd($event)"
            @dragstart="handleDragStart"
            :title="session.connectionName"
        >
          <!-- Status dot -->
          <span :class="['w-2 h-2 rounded-full mr-2 flex-shrink-0',
                         session.isMarkedForSuspend ? 'bg-blue-500' : // +++ 如果已标记待挂起，则为蓝色 +++
                         session.status === 'connected' ? 'bg-green-500' :
                         session.status === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                         session.status === 'disconnected' ? 'bg-red-500' : 'bg-gray-400']"></span>
          <span class="truncate text-sm" style="transform: translateY(-1px);">{{ session.connectionName }}</span>
          <button class="ml-2 p-0.5 rounded-full text-text-secondary hover:bg-border hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                  :class="{'text-foreground hover:bg-header': session.sessionId === activeSessionId}"
                  @click="closeSession($event, session.sessionId)" :title="$t('tabs.closeTabTooltip')">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            </button>
          </li>
        </template>
      </draggable>
      <!-- Add Tab Button -->
      <button class="flex items-center justify-center px-3 h-full border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0"
              @click="togglePopup" :title="$t('tabs.newTabTooltip')">
        <i class="fas fa-plus text-sm"></i>
      </button>
    </div>
    <!-- Action Buttons -->
    <div class="flex items-center ml-auto h-full flex-shrink-0">
        <button
          v-if="isWorkspaceRoute"
          class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
          @click="toggleHeader"
          :title="toggleButtonTitle"
        >
          <i :class="[eyeIconClass, 'text-sm']"></i>
        </button>
        <!-- 查看传输进度按钮 (移除 v-if="!isMobile" 以在移动端显示) -->
        <button
                class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
                @click="showTransferProgressModal = true"
                :title="t('terminalTabBar.showTransferProgressTooltip', '查看传输进度')">
          <i class="fas fa-tasks text-sm"></i>
        </button>
        <!-- +++ 使用 v-if 隐藏移动端的布局按钮 +++ -->
        <button v-if="!isMobile" class="flex items-center justify-center px-3 h-full border-l border-border text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150"
                @click="openLayoutConfigurator" :title="t('layout.configure', '配置布局')">
          <i class="fas fa-th-large text-sm"></i>
        </button>
    </div>
    </template>
    <!-- Connection List Popup -->
    <Teleport to="body">
      <div v-if="showConnectionListPopup" class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4" @click.self="togglePopup">
        <div class="bg-background text-foreground p-6 rounded-lg shadow-xl border border-border w-full max-w-md max-h-[80vh] flex flex-col relative">
          <button class="absolute top-2 right-2 p-1 text-text-secondary hover:text-foreground" @click="togglePopup">
             <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
               <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
             </svg>
          </button>
          <h3 class="text-lg font-semibold text-center mb-4">{{ t('terminalTabBar.selectServerTitle') }}</h3>
          <div class="flex-grow overflow-y-auto border border-border rounded">
              <WorkspaceConnectionListComponent
                @connect-request="handlePopupConnect"
                @open-new-session="handlePopupConnect"
                @request-add-connection="handleRequestAddFromPopup"
                @request-edit-connection="handleRequestEditFromPopup"
                class="popup-connection-list"
              />
          </div>
        </div>
      </div>
    </Teleport>
    <!-- +++ Context Menu Instance (Ensure it's present) +++ -->
    <TabBarContextMenu
      :visible="contextMenuVisible"
      :position="contextMenuPosition"
      :items="contextMenuItems"
      :target-id="menuTargetId"
      @menu-action="handleContextMenuAction"
      @close="closeContextMenu"
    />
    <!-- 传输进度模态框 -->
    <TransferProgressModal v-model:visible="showTransferProgressModal" />
  </div>
</template>
