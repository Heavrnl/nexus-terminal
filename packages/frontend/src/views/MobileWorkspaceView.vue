<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted, onBeforeUnmount, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TerminalTabBar from '../components/TerminalTabBar.vue';
import CommandInputBar from '../components/CommandInputBar.vue';
import VirtualKeyboard from '../components/VirtualKeyboard.vue';
import LayoutRenderer from '../components/LayoutRenderer.vue';
import RecentConnectionsPanel from '../components/RecentConnectionsPanel.vue';
// 同 DesktopWorkspaceView：远程桌面客户端按需加载，别拖累移动端进终端的首屏。
const RemoteSessionPane = defineAsyncComponent(() => import('../components/remote/RemoteSessionPane.vue'));
import { useSessionStore } from '../stores/session.store';
import { useLayoutStore } from '../stores/layout.store';
import type { LayoutNode } from '../stores/layout.store';
import type { FileTab } from '../stores/fileEditor.store';
import type { SessionTabInfoWithStatus, SshTerminalInstance } from '../stores/session/types';
import type { ConnectionInfo } from '../stores/connections.store';

const props = defineProps<{
  sessions: SessionTabInfoWithStatus[];
  activeSessionId: string | null;
  layoutLocked: boolean;
  editorTabs: FileTab[];
  activeEditorTabId: string | null;
}>();

const emit = defineEmits<{
  (e: 'open-layout-configurator'): void;
  (e: 'request-add-connection'): void;
  (e: 'request-edit-connection', connection: ConnectionInfo): void;
  (e: 'send-command', command: string): void;
  (e: 'search', term: string): void;
  (e: 'find-next'): void;
  (e: 'find-previous'): void;
  (e: 'close-search'): void;
  (e: 'clear-terminal'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const layoutStore = useLayoutStore();

/**
 * 当前会话是不是 RDP / VNC。
 *
 * 远程桌面在移动端也占满整块视口，且没有终端可言 ——
 * 命令输入栏、虚拟键盘、焦点切换这些 SSH 专用件都要一起收起来。
 */
const activeSessionKind = computed(() => {
  if (!props.activeSessionId) return null;
  return sessionStore.sessions.get(props.activeSessionId)?.kind ?? null;
});
const isActiveRemoteSession = computed(() => activeSessionKind.value === 'rdp' || activeSessionKind.value === 'vnc');

/**
 * 为每个移动端会话缓存专属且稳定的单终端布局节点。
 *
 * LayoutRenderer 内部只渲染其所属单个会话的终端（保活由外层 v-show 负责），
 * 因此移动端必须与 DesktopWorkspaceView 一样为每个会话各自挂载独立的
 * LayoutRenderer / RemoteSessionPane；同时按 sessionId 隔离 paneId，
 * 避免多会话共享同一个 paneId 导致动态背景容器和调试桥互相覆盖。
 */
const mobileLayoutNodeMap = new Map<string, LayoutNode>();
const getMobileLayoutNode = (sessionId: string): LayoutNode => {
  let node = mobileLayoutNodeMap.get(sessionId);
  if (!node) {
    node = {
      id: `mobile-terminal-pane-${sessionId}`,
      type: 'pane' as const,
      component: 'terminal' as const,
      size: 100,
    };
    mobileLayoutNodeMap.set(sessionId, node);
  }
  return node;
};

/**
 * 移动端多会话沙箱的分批挂载（与 DesktopWorkspaceView 保持一致）：
 * 首帧立刻挂载当前活动会话，其余会话延迟分批补挂；切换会话通过纯 CSS v-show 实现 0ms 秒切。
 */
const renderedSessionIds = ref<Set<string>>(new Set());
const mountedSessions = computed(() => props.sessions.filter(s => renderedSessionIds.value.has(s.sessionId)));

const markSessionRendered = (sessionId: string) => {
  if (renderedSessionIds.value.has(sessionId)) return;
  const next = new Set(renderedSessionIds.value);
  next.add(sessionId);
  renderedSessionIds.value = next;
};

const pendingMountQueue: string[] = [];
let mountTimer: number | null = null;

const pumpMountQueue = () => {
  mountTimer = null;
  const id = pendingMountQueue.shift();
  if (!id) return;
  // 只挂载仍然存在的会话
  if (props.sessions.some(s => s.sessionId === id)) {
    markSessionRendered(id);
  }
  if (pendingMountQueue.length > 0) {
    mountTimer = window.setTimeout(pumpMountQueue, 30);
  }
};

const scheduleSessionMounts = () => {
  if (props.activeSessionId) markSessionRendered(props.activeSessionId);
  for (const s of props.sessions) {
    if (!renderedSessionIds.value.has(s.sessionId) && !pendingMountQueue.includes(s.sessionId)) {
      pendingMountQueue.push(s.sessionId);
    }
  }
  if (pendingMountQueue.length > 0 && mountTimer === null) {
    mountTimer = window.setTimeout(pumpMountQueue, 80);
  }
};

onMounted(() => scheduleSessionMounts());
onBeforeUnmount(() => {
  if (mountTimer !== null) window.clearTimeout(mountTimer);
  mountTimer = null;
  pendingMountQueue.length = 0;
  mobileLayoutNodeMap.clear();
});

watch(
  () => props.sessions.map(s => s.sessionId).join(','),
  () => {
    const currentIds = new Set(props.sessions.map(s => s.sessionId));
    // 清理已关闭会话的缓存节点与挂载记录
    for (const id of Array.from(mobileLayoutNodeMap.keys())) {
      if (!currentIds.has(id)) mobileLayoutNodeMap.delete(id);
    }
    let renderedChanged = false;
    const nextRendered = new Set(renderedSessionIds.value);
    for (const id of nextRendered) {
      if (!currentIds.has(id)) {
        nextRendered.delete(id);
        renderedChanged = true;
      }
    }
    if (renderedChanged) {
      renderedSessionIds.value = nextRendered;
    }
    for (let i = pendingMountQueue.length - 1; i >= 0; i--) {
      if (!currentIds.has(pendingMountQueue[i])) {
        pendingMountQueue.splice(i, 1);
      }
    }
    scheduleSessionMounts();
  }
);

watch(
  () => props.activeSessionId,
  (sid) => {
    if (sid) markSessionRendered(sid);
    // 切换会话（含首次进入 setup 阶段）立刻同步活动终端窗格，
    // 确保子组件 Terminal 挂载前 layoutStore.getActiveLayoutTree() 已指向当前会话节点，
    // 并且命令输入栏 / 搜索 / 清屏能准确命中当前会话的终端。
    if (!sid || isActiveRemoteSession.value) {
      layoutStore.syncActiveTerminalPaneFromTree(null, null, null);
      return;
    }
    const connId = sessionStore.sessions.get(sid)?.connectionId ?? null;
    layoutStore.syncActiveTerminalPaneFromTree(getMobileLayoutNode(sid), sid, connId);
  },
  { immediate: true }
);

// 虚拟键盘状态与手势
const isVirtualKeyboardVisible = ref(false);

const toggleVirtualKeyboard = () => {
  isVirtualKeyboardVisible.value = !isVirtualKeyboardVisible.value;
};

const handleVirtualKeyPress = (keySequence: string) => {
  if (!props.activeSessionId) return;
  const currentSession = sessionStore.sessions.get(props.activeSessionId);
  if (!currentSession) return;

  const terminalManager = currentSession.terminalManager as (SshTerminalInstance | undefined);
  if (terminalManager && typeof terminalManager.sendData === 'function') {
    terminalManager.sendData(keySequence);
  }
};

const handleCloseOtherSessions = (targetSessionId: string) => {
  const sessionsToClose = props.sessions
    .filter(tab => tab.sessionId !== targetSessionId)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToRight = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(targetIndex + 1)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToLeft = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(0, targetIndex)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleRequestEditConnectionFromPopup = (conn: ConnectionInfo) => {
  emit('request-edit-connection', conn);
};
</script>

<template>
  <div class="mobile-workspace-view flex flex-col flex-grow overflow-hidden">
    <!-- 移动端终端视口区域 -->
    <div class="mobile-content-area">
      <!-- 多会话独立常驻沙箱：每个会话独立挂载 LayoutRenderer / RemoteSessionPane，切换会话通过 v-show 秒切 -->
      <template v-if="props.sessions.length > 0">
        <div
          v-for="sessionTab in mountedSessions"
          :key="`mobile-session-box-${sessionTab.sessionId}`"
          v-show="sessionTab.sessionId === props.activeSessionId"
          class="layout-renderer-wrapper flex-grow flex flex-col overflow-hidden"
        >
          <RemoteSessionPane
            v-if="sessionTab.kind === 'rdp' || sessionTab.kind === 'vnc'"
            :session-id="sessionTab.sessionId"
            :active="sessionTab.sessionId === props.activeSessionId"
            :is-mobile="true"
            class="w-full h-full flex-grow"
          />
          <LayoutRenderer
            v-else
            :layout-node="getMobileLayoutNode(sessionTab.sessionId)"
            :active-session-id="sessionTab.sessionId"
            :is-root-renderer="false"
            :layout-locked="props.layoutLocked"
            class="flex-grow w-full h-full overflow-auto"
            :editor-tabs="props.editorTabs"
            :active-editor-tab-id="props.activeEditorTabId"
          />
        </div>
      </template>
      <!-- 没有会话时别给一块空白：直接列最近连接，点一下就能开 -->
      <RecentConnectionsPanel v-else :is-mobile="true" class="layout-renderer-wrapper flex-grow" />
    </div>

    <!-- 移动端会话标签栏：紧贴终端视口下方 -->
    <TerminalTabBar
      :sessions="props.sessions"
      :active-session-id="props.activeSessionId"
      :is-mobile="true"
      @activate-session="sessionStore.activateSession"
      @close-session="sessionStore.closeSession"
      @open-layout-configurator="emit('open-layout-configurator')"
      @request-add-connection-from-popup="emit('request-add-connection')"
      @request-edit-connection-from-popup="handleRequestEditConnectionFromPopup"
      @close-other-sessions="handleCloseOtherSessions"
      @close-sessions-to-right="handleCloseSessionsToRight"
      @close-sessions-to-left="handleCloseSessionsToLeft"
    />

    <!-- 移动端命令工具栏（远程桌面会话用不到终端输入） -->
    <CommandInputBar
      v-if="!isActiveRemoteSession"
      class="mobile-command-bar"
      :is-mobile="true"
      @send-command="(cmd: string) => emit('send-command', cmd)"
      @search="(term: string) => emit('search', term)"
      @find-next="emit('find-next')"
      @find-previous="emit('find-previous')"
      @close-search="emit('close-search')"
      @clear-terminal="emit('clear-terminal')"
      :is-virtual-keyboard-visible="isVirtualKeyboardVisible"
      @toggle-virtual-keyboard="toggleVirtualKeyboard"
    />

    <!-- 移动端软键盘 -->
    <VirtualKeyboard
      v-show="isVirtualKeyboardVisible && !isActiveRemoteSession"
      class="mobile-virtual-keyboard"
      @send-key="handleVirtualKeyPress"
    />
  </div>
</template>

<style scoped>
.mobile-workspace-view {
  width: 100%;
  height: 100%;
}

.mobile-content-area {
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
  width: 100%;
}

.mobile-command-bar {
  flex-shrink: 0;
  width: 100%;
  z-index: 20;
}

.mobile-virtual-keyboard {
  flex-shrink: 0;
  width: 100%;
  z-index: 20;
}

.layout-renderer-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.pane-placeholder {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  font-size: 1.1rem;
  color: var(--text-color-secondary, #888);
}
</style>
