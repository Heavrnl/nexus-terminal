<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import draggable from 'vuedraggable';
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
const draggableSessions = ref<SessionTabInfoWithStatus[]>([]);

watch(
  () => props.sessions,
  (newSessions) => {
    draggableSessions.value = [...newSessions];
  },
  { immediate: true, deep: true }
);

const handleSessionsUpdate = (newSessions: SessionTabInfoWithStatus[]) => {
  const newOrder = newSessions.map(s => s.sessionId);
  sessionStore.setSessionOrder(newOrder);
};

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

// 触屏长按会话触发待挂起/取消挂起（与拖拽排序精准解耦）
let touchTimeout: number | null = null;
const touchDuration = 800;
let touchedSessionId: string | null = null;
let touchStartX = 0;
let touchStartY = 0;
let isTouchMoved = false;

const handleTouchStart = (event: TouchEvent, sessionId: string) => {
  if (event.touches.length > 0) {
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  }
  isTouchMoved = false;
  touchedSessionId = sessionId;
  if (touchTimeout) {
    clearTimeout(touchTimeout);
  }
  touchTimeout = window.setTimeout(() => {
    if (touchedSessionId === sessionId && !isTouchMoved) {
      const sessionState = sessionStore.sessions.get(sessionId);
      if (sessionState && sessionState.isMarkedForSuspend) {
        sessionStore.requestUnmarkSshSuspend(sessionId);
      } else if (sessionState) {
        sessionStore.requestStartSshSuspend(sessionId);
      }
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(40);
      }
    }
    touchTimeout = null;
  }, touchDuration);
};

const handleTouchMove = (event: TouchEvent) => {
  if (!touchTimeout) return;
  if (event.touches.length > 0) {
    const dx = Math.abs(event.touches[0].clientX - touchStartX);
    const dy = Math.abs(event.touches[0].clientY - touchStartY);
    // 超过 8 像素的位移立即判定为滑动/拖拽，取消长按挂起定时器
    if (dx > 8 || dy > 8) {
      isTouchMoved = true;
      clearTimeout(touchTimeout);
      touchTimeout = null;
      touchedSessionId = null;
    }
  }
};

const handleTouchEnd = () => {
  if (touchTimeout) {
    clearTimeout(touchTimeout);
    touchTimeout = null;
  }
  touchedSessionId = null;
};

// 移动端当前活动标签自动滚动：仅在 Tab 不在容器当前可视范围时才平滑滚动进入视野
const scrollToActiveTab = (activeEl: HTMLElement) => {
  const container = mobileTabsContainerRef.value;
  if (!container) return;

  const containerScrollLeft = container.scrollLeft;
  const containerWidth = container.clientWidth;
  const elLeft = activeEl.offsetLeft;
  const elWidth = activeEl.offsetWidth;

  // 如果当前 Tab 已经完整显示在可视范围内，不做任何位移滚动，保持界面绝对稳定
  if (elLeft >= containerScrollLeft && elLeft + elWidth <= containerScrollLeft + containerWidth) {
    return;
  }

  // 只有超出可视区时才进行最小位移平滑滚动
  if (elLeft < containerScrollLeft) {
    container.scrollTo({ left: Math.max(0, elLeft - 8), behavior: 'smooth' });
  } else if (elLeft + elWidth > containerScrollLeft + containerWidth) {
    container.scrollTo({ left: elLeft + elWidth - containerWidth + 8, behavior: 'smooth' });
  }
};

watch(() => props.activeSessionId, async (newId) => {
  if (newId) {
    await nextTick();
    const activeEl = mobileTabsContainerRef.value?.querySelector(`[data-tab-id="${newId}"]`) as HTMLElement | null;
    if (activeEl) {
      scrollToActiveTab(activeEl);
    }
  }
});
</script>

<template>
  <div class="mobile-terminal-tab-bar flex items-center w-full h-9 px-2 bg-header border-t border-border/40 select-none relative shrink-0 overflow-hidden">
    <!-- + 号按键：最左侧轻羽图标按键 -->
    <button
      @click="togglePopup"
      class="flex-shrink-0 flex items-center justify-center w-6.5 h-6.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-colors mr-1 cursor-pointer"
      :title="t('tabs.newTabTooltip')"
    >
      <i class="fas fa-plus text-xs"></i>
    </button>

    <!-- 纵向分割微线 -->
    <div class="h-3.5 w-[1px] bg-border/40 mr-1.5 flex-shrink-0"></div>

    <!-- 会话胶囊标签横向滚动列表 (无滚动条，支持横向平滑滑动与触屏拖拽排序) -->
    <div
      ref="mobileTabsContainerRef"
      class="mobile-tabs-scroll-container flex items-center overflow-x-auto overflow-y-hidden no-scrollbar scroll-smooth flex-grow h-full py-0.5 min-w-0"
      style="-webkit-touch-callout: none;"
      @contextmenu.prevent
    >
      <draggable
        v-model="draggableSessions"
        item-key="sessionId"
        tag="div"
        class="flex items-center gap-1.5 h-full flex-shrink-0"
        @update:modelValue="handleSessionsUpdate"
        ghost-class="opacity-50"
        drag-class="opacity-75"
        animation="150"
        :delay="120"
        :delay-on-touch-only="true"
        :touch-action="'pan-x'"
      >
        <template #item="{ element: session }">
          <div
            :key="session.sessionId"
            :data-tab-id="session.sessionId"
            class="flex items-center px-2.5 h-6.5 rounded-md cursor-pointer flex-shrink-0 transition-colors duration-150 select-none max-w-[150px] font-medium border"
            :class="session.sessionId === props.activeSessionId
              ? 'bg-background text-primary border-primary/40 shadow-xs'
              : 'bg-background/30 text-text-secondary border-border/40 hover:bg-background/50 hover:text-foreground active:bg-background/70'"
            @click="activateSession(session.sessionId)"
            @contextmenu.prevent
            @touchstart="handleTouchStart($event, session.sessionId)"
            @touchmove="handleTouchMove($event)"
            @touchend="handleTouchEnd"
            @touchcancel="handleTouchEnd"
            :title="session.connectionName"
            style="-webkit-touch-callout: none;"
          >
            <!-- 状态指示灯 -->
            <span
              :class="[
                'w-2 h-2 rounded-full mr-1.5 flex-shrink-0 transition-colors',
                session.isMarkedForSuspend ? 'bg-blue-400' :
                session.status === 'connected' ? (session.sessionId === props.activeSessionId ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-emerald-500/70') :
                session.status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                session.status === 'disconnected' ? 'bg-rose-500/80' : 'bg-gray-400/80'
              ]"
            ></span>

            <!-- 会话名称 -->
            <span class="truncate text-xs tracking-tight flex-grow min-w-0">
              {{ session.connectionName }}
            </span>

            <!-- 关闭小叉号 (常驻占位，通过透明度显隐，彻底杜绝切换时 Tab 尺寸伸缩互挤) -->
            <button
              class="ml-1.5 -mr-0.5 w-4 h-4 rounded-full flex items-center justify-center transition-opacity duration-150 flex-shrink-0 cursor-pointer"
              :class="session.sessionId === props.activeSessionId
                ? 'opacity-100 pointer-events-auto text-primary/70 hover:text-primary hover:bg-primary/20 active:bg-primary/30'
                : 'opacity-0 pointer-events-none'"
              @click.stop="closeSession($event, session.sessionId)"
              :title="t('tabs.closeTabTooltip')"
              tabindex="-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </template>
      </draggable>
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
