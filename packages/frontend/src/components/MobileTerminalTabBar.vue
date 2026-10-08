<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileServerSelectionDrawer from './MobileServerSelectionDrawer.vue';
import { useSessionStore } from '../stores/session.store';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import type { SessionTabInfoWithStatus } from '../stores/session/types';

const props = defineProps<{
  sessions: SessionTabInfoWithStatus[];
  activeSessionId?: string | null;
}>();

const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const sessionStore = useSessionStore();
const connectionsStore = useConnectionsStore();

const showConnectionListPopup = ref(false);
const mobileTabsContainerRef = ref<HTMLElement | null>(null);

const togglePopup = () => {
  showConnectionListPopup.value = !showConnectionListPopup.value;
};

const activateSession = (sessionId: string) => {
  if (sessionId !== props.activeSessionId) {
    emitWorkspaceEvent('session:activate', { sessionId });
  }
};

const closeSession = (event: MouseEvent, sessionId: string) => {
  event.stopPropagation();
  emitWorkspaceEvent('session:close', { sessionId });
};

// 处理从弹出列表中选择连接的事件
const handlePopupConnect = (connectionId: number) => {
  const connectionInfo = connectionsStore.connections.find(c => c.id === connectionId);
  if (!connectionInfo) {
    console.error(`[MobileTabBar] 未找到 ID 为 ${connectionId} 的连接信息。`);
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

// 触屏长按会话触发待挂起/取消挂起
let touchTimeout: number | null = null;
const touchDuration = 800;
let touchedSessionId: string | null = null;

const handleTouchStart = (event: TouchEvent, sessionId: string) => {
  touchedSessionId = sessionId;
  if (touchTimeout) {
    clearTimeout(touchTimeout);
  }
  touchTimeout = window.setTimeout(() => {
    if (touchedSessionId === sessionId) {
      const sessionState = sessionStore.sessions.get(sessionId);
      if (sessionState && sessionState.isMarkedForSuspend) {
        sessionStore.requestUnmarkSshSuspend(sessionId);
      } else if (sessionState) {
        sessionStore.requestStartSshSuspend(sessionId);
      }
    }
    touchTimeout = null;
  }, touchDuration);
};

const handleTouchEnd = (event: TouchEvent) => {
  if (touchTimeout) {
    clearTimeout(touchTimeout);
    touchTimeout = null;
  }
  touchedSessionId = null;
};

// 移动端当前活动标签自动居中平滑滚动
watch(() => props.activeSessionId, async (newId) => {
  if (newId) {
    await nextTick();
    const activeEl = mobileTabsContainerRef.value?.querySelector(`[data-tab-id="${newId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
});
</script>

<template>
  <div class="mobile-terminal-tab-bar flex items-center w-full h-9 px-2 bg-header border-t border-border/40 select-none relative shrink-0 overflow-hidden">
    <!-- + 号按键：最左侧轻羽图标按键 -->
    <button
      @click="togglePopup"
      class="flex-shrink-0 flex items-center justify-center w-6.5 h-6.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all mr-1"
      :title="t('tabs.newTabTooltip')"
    >
      <i class="fas fa-plus text-xs"></i>
    </button>

    <!-- 纵向分割微线 -->
    <div class="h-3.5 w-[1px] bg-border/40 mr-1.5 flex-shrink-0"></div>

    <!-- 会话胶囊标签横向滚动列表 (无滚动条，支持横向平滑滑动) -->
    <div
      ref="mobileTabsContainerRef"
      class="mobile-tabs-scroll-container flex items-center gap-1 overflow-x-auto overflow-y-hidden no-scrollbar scroll-smooth flex-grow h-full py-0.5 min-w-0"
      style="-webkit-touch-callout: none;"
      @contextmenu.prevent
    >
      <div
        v-for="session in props.sessions"
        :key="session.sessionId"
        :data-tab-id="session.sessionId"
        class="flex items-center px-2 h-6.5 rounded-md cursor-pointer flex-shrink-0 transition-all duration-150 select-none max-w-[150px]"
        :class="session.sessionId === props.activeSessionId
          ? 'bg-background text-primary border border-primary/30 font-medium shadow-xs'
          : 'text-text-secondary hover:text-foreground hover:bg-background/40 active:bg-background/60 border border-transparent'"
        @click="activateSession(session.sessionId)"
        @contextmenu.prevent
        @touchstart="handleTouchStart($event, session.sessionId)"
        @touchend="handleTouchEnd($event)"
        :title="session.connectionName"
        style="-webkit-touch-callout: none;"
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
          v-if="session.sessionId === props.activeSessionId"
          class="ml-1.5 -mr-0.5 w-4 h-4 rounded-full flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0"
          @click.stop="closeSession($event, session.sessionId)"
          :title="t('tabs.closeTabTooltip')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 移动端专属选择服务器抽屉 -->
    <MobileServerSelectionDrawer
      :visible="showConnectionListPopup"
      @close="showConnectionListPopup = false"
      @select-connection="handlePopupConnect"
      @request-add-connection="handleRequestAddFromPopup"
      @request-edit-connection="handleRequestEditFromPopup"
    />
  </div>
</template>

<style scoped>
.mobile-tabs-scroll-container {
  overflow-x: auto !important;
  overflow-y: hidden !important;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  -webkit-overflow-scrolling: touch;
}

.mobile-tabs-scroll-container::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  opacity: 0 !important;
  background: transparent !important;
}
</style>
