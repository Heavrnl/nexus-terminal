<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useLayoutStore } from '../stores/layout.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import { useMobileToolbarConfig } from '../composables/useMobileToolbarConfig';
import { useFileEditorStore } from '../stores/fileEditor.store';

import MobileQuickCommandsModal from './MobileQuickCommandsModal.vue';
import MobileCommandHistoryModal from './MobileCommandHistoryModal.vue';
import MobileSuspendedSshSessionsModal from './MobileSuspendedSshSessionsModal.vue';
import MobileToolbarConfigModal from './MobileToolbarConfigModal.vue';
import MobileStatusMonitorModal from './MobileStatusMonitorModal.vue';
import MobileDockerManagerModal from './MobileDockerManagerModal.vue';
import MobileTerminalTextModal from './MobileTerminalTextModal.vue';
import MultiLineCommandInput from './MultiLineCommandInput.vue';

const props = defineProps<{
  isVirtualKeyboardVisible?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-virtual-keyboard'): void;
}>();

const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

const sessionStore = useSessionStore();
const layoutStore = useLayoutStore();
const focusSwitcherStore = useFocusSwitcherStore();
const fileEditorStore = useFileEditorStore();
const workspaceSyncStore = useWorkspaceSyncStore();
const { isHeaderVisible } = storeToRefs(layoutStore);
const { activeSessionId } = storeToRefs(sessionStore);
const { syncEnabled, isSyncing } = storeToRefs(workspaceSyncStore);
const { toggleSyncEnabled } = workspaceSyncStore;

const syncButtonTitle = computed(() => {
  if (isSyncing.value) return t('workspaceSync.syncing', '正在同步工作区...');
  return syncEnabled.value
    ? t('workspaceSync.disableSync', '工作区实时同步已开启 (点击关闭)')
    : t('workspaceSync.enableSync', '工作区实时同步已关闭 (点击开启)');
});

const { activeItemIds } = useMobileToolbarConfig();

// --- 移动端弹窗与多行输入状态 ---
const showQuickCommands = ref(false);
const showCommandHistoryModal = ref(false);
const showSuspendedSshSessionsModal = ref(false);
const showToolbarConfigModal = ref(false);
const showMobileStatusMonitorModal = ref(false);
const showMobileDockerManagerModal = ref(false);
const showTerminalTextModal = ref(false);
const isMobileMultiLineOpen = ref(false);

const toggleHeader = () => {
  layoutStore.toggleHeaderVisibility();
};

const openTransferProgressModal = () => {
  emitWorkspaceEvent('ui:openTransferProgressModal');
};

const scrollToBottom = () => {
  if (activeSessionId.value) {
    emitWorkspaceEvent('terminal:scrollToBottomRequest', { sessionId: activeSessionId.value });
  }
};

const toggleMobileMultiLine = () => {
  isMobileMultiLineOpen.value = !isMobileMultiLineOpen.value;
};

const toggleQuickCommandsModal = () => {
  showQuickCommands.value = !showQuickCommands.value;
};

const closeQuickCommandsModal = () => {
  showQuickCommands.value = false;
};

const toggleCommandHistoryModal = () => {
  showCommandHistoryModal.value = !showCommandHistoryModal.value;
};

const closeCommandHistoryModal = () => {
  showCommandHistoryModal.value = false;
};

const toggleSuspendedSshSessionsModal = () => {
  showSuspendedSshSessionsModal.value = !showSuspendedSshSessionsModal.value;
};

const closeSuspendedSshSessionsModal = () => {
  showSuspendedSshSessionsModal.value = false;
};

const openFileManagerModal = () => {
  if (activeSessionId.value) {
    emitWorkspaceEvent('fileManager:openModalRequest', { sessionId: activeSessionId.value });
  }
};

const openFileEditorModal = () => {
  if (activeSessionId.value) {
    fileEditorStore.triggerPopup('', activeSessionId.value);
  }
};

const handleQuickCommandExecute = (command: string) => {
  emitWorkspaceEvent('terminal:sendCommand', { command });
  closeQuickCommandsModal();
};

// 监听填入命令与聚焦：移动端自动展开多行命令输入框
const handleCommandFill = () => {
  isMobileMultiLineOpen.value = true;
};

const focusCommandInput = (): boolean => {
  if (!isMobileMultiLineOpen.value) {
    isMobileMultiLineOpen.value = true;
  }
  return true;
};

defineExpose({ focusCommandInput });

let unregisterCommandInputFocus: (() => void) | null = null;

onMounted(() => {
  unregisterCommandInputFocus = focusSwitcherStore.registerFocusAction('commandInput', focusCommandInput);
  onWorkspaceEvent('commandInput:fill', handleCommandFill);
});

onBeforeUnmount(() => {
  if (unregisterCommandInputFocus) {
    unregisterCommandInputFocus();
  }
  offWorkspaceEvent('commandInput:fill', handleCommandFill);
});

// 移动端按钮基础样式
const getBarButtonClass = (isActive: boolean = false) => [
  'flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 active:scale-95',
  isActive
    ? 'bg-primary/15 text-primary border border-primary/30 shadow-xs'
    : 'text-text-secondary hover:text-foreground hover:bg-border/30 active:bg-border/40'
];
</script>

<template>
  <div class="mobile-command-input-bar flex flex-col bg-header border-t border-border/20">
    <!-- 移动端工具栏 (扁平单层滚动，编辑按钮置于最右侧) -->
    <div class="flex items-center py-1.5 px-2 bg-transparent relative gap-1 w-full overflow-x-auto no-scrollbar">
      <template v-for="itemId in activeItemIds" :key="itemId">
        <!-- 清空终端 -->
        <button
          v-if="itemId === 'clearTerminal'"
          @click="emitWorkspaceEvent('terminal:clear')"
          :class="getBarButtonClass()"
          :title="t('commandInputBar.clearTerminal', '清空终端')"
        >
          <i class="fas fa-eraser text-base"></i>
        </button>

        <!-- 快捷指令 -->
        <button
          v-else-if="itemId === 'quickCommands'"
          @click="toggleQuickCommandsModal"
          :class="getBarButtonClass(showQuickCommands)"
          :title="t('quickCommands.title', '快捷指令')"
        >
          <i class="fas fa-bolt text-base"></i>
        </button>

        <!-- 命令历史 -->
        <button
          v-else-if="itemId === 'commandHistory'"
          @click="toggleCommandHistoryModal"
          :class="getBarButtonClass(showCommandHistoryModal)"
          :title="t('commandHistory.title', '命令历史')"
        >
          <i class="fas fa-history text-base"></i>
        </button>

        <!-- 终端复制 -->
        <button
          v-else-if="itemId === 'terminalBufferText'"
          @click="showTerminalTextModal = true"
          :class="getBarButtonClass(showTerminalTextModal)"
          :title="t('terminal.bufferText.title', '终端复制')"
        >
          <i class="fas fa-copy text-base"></i>
        </button>

        <!-- 多行命令输入 -->
        <button
          v-else-if="itemId === 'multiLine'"
          @click="toggleMobileMultiLine"
          :class="getBarButtonClass(isMobileMultiLineOpen)"
          :title="isMobileMultiLineOpen ? t('commandInputBar.closeMultiLine', '收起多行命令输入框') : t('commandInputBar.openMultiLine', '展开多行命令输入框')"
        >
          <i class="fas fa-terminal text-base"></i>
        </button>

        <!-- 云端同步 -->
        <button
          v-else-if="itemId === 'workspaceSync'"
          @click="toggleSyncEnabled()"
          :class="getBarButtonClass(syncEnabled)"
          :title="syncButtonTitle"
        >
          <span class="relative inline-flex items-center justify-center">
            <i class="fas fa-cloud text-base" :class="syncEnabled ? 'text-emerald-500' : 'text-text-secondary'"></i>
            <!-- 开启状态：右下角绿色实心圆点 -->
            <span
              v-if="syncEnabled"
              class="absolute -bottom-0.5 -right-1 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-header shadow-sm"
            ></span>
            <!-- 关闭状态：带留白的对角斜杠横穿云朵图标 -->
            <span
              v-else
              class="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
              <span class="absolute w-[150%] h-[3px] bg-header rotate-45 transform origin-center"></span>
              <span class="absolute w-[135%] h-[1.5px] bg-text-secondary rotate-45 transform origin-center rounded-full"></span>
            </span>
          </span>
        </button>

        <!-- 挂起会话 -->
        <button
          v-else-if="itemId === 'suspendedSessions'"
          @click="toggleSuspendedSshSessionsModal"
          :class="getBarButtonClass(showSuspendedSshSessionsModal)"
          :title="t('suspendedSshSessions.title', '挂起会话')"
        >
          <i class="fas fa-pause-circle text-base"></i>
        </button>

        <!-- 虚拟按键 -->
        <button
          v-else-if="itemId === 'virtualKeyboard'"
          @click="emit('toggle-virtual-keyboard')"
          :class="getBarButtonClass(props.isVirtualKeyboardVisible)"
          :title="props.isVirtualKeyboardVisible ? t('commandInputBar.hideKeyboard', '隐藏虚拟键盘') : t('commandInputBar.showKeyboard', '显示虚拟键盘')"
        >
          <i class="fas fa-keyboard text-base" :class="{ 'opacity-50': !props.isVirtualKeyboardVisible }"></i>
        </button>

        <!-- 文件管理 -->
        <button
          v-else-if="itemId === 'fileManager'"
          @click="openFileManagerModal"
          :class="getBarButtonClass()"
          :title="t('fileManager.modalTitle', '文件管理器')"
        >
          <i class="fas fa-folder text-base"></i>
        </button>

        <!-- 文件编辑 -->
        <button
          v-else-if="itemId === 'fileEditor'"
          @click="openFileEditorModal"
          :class="getBarButtonClass()"
          :title="t('fileEditor.title', '文件编辑')"
        >
          <i class="fas fa-edit text-base"></i>
        </button>

        <!-- 状态监视器 -->
        <button
          v-else-if="itemId === 'statusMonitor'"
          @click="showMobileStatusMonitorModal = true"
          :class="getBarButtonClass(showMobileStatusMonitorModal)"
          :title="t('statusMonitor.title', '状态监视')"
        >
          <i class="fas fa-tachometer-alt text-base"></i>
        </button>

        <!-- Docker 管理器 -->
        <button
          v-else-if="itemId === 'dockerManager'"
          @click="showMobileDockerManagerModal = true"
          :class="getBarButtonClass(showMobileDockerManagerModal)"
          :title="t('dockerManager.title', 'Docker 管理器')"
        >
          <i class="fab fa-docker text-base"></i>
        </button>

        <!-- 显隐导航栏 -->
        <button
          v-else-if="itemId === 'toggleHeader'"
          @click="toggleHeader"
          :class="getBarButtonClass(!isHeaderVisible)"
          :title="isHeaderVisible ? t('terminalTabBar.hideHeaderTooltip', '隐藏导航栏') : t('terminalTabBar.showHeaderTooltip', '显示导航栏')"
        >
          <i :class="[isHeaderVisible ? 'fa-eye-slash' : 'fa-eye', 'fas text-base']"></i>
        </button>

        <!-- 传输进度 -->
        <button
          v-else-if="itemId === 'transferProgress'"
          @click="openTransferProgressModal"
          :class="getBarButtonClass()"
          :title="t('terminalTabBar.showTransferProgressTooltip', '查看传输进度')"
        >
          <i class="fas fa-tasks text-base"></i>
        </button>

        <!-- 滚到底部 -->
        <button
          v-else-if="itemId === 'scrollBottom'"
          @click="scrollToBottom"
          :class="getBarButtonClass()"
          :title="t('commandInputBar.scrollToBottom', '滚到底部')"
        >
          <i class="fas fa-arrow-down text-base"></i>
        </button>
      </template>

      <!-- 编辑按钮：置于工具栏内最右侧 -->
      <button
        @click="showToolbarConfigModal = true"
        class="flex-shrink-0 flex items-center justify-center gap-1 px-2.5 h-8 rounded-lg border border-dashed border-primary/70 bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all shadow-xs cursor-pointer ml-0.5"
        :title="t('mobileToolbar.title', '自定义工具栏')"
      >
        <i class="fas fa-sliders-h text-xs"></i>
        <span class="text-xs font-semibold tracking-tight">编辑</span>
      </button>
    </div>

    <!-- 移动端多行命令输入组件展开区域 -->
    <div
      v-show="isMobileMultiLineOpen"
      class="w-full max-h-[38vh] h-44 bg-background border-t border-border/50 shrink-0 overflow-hidden"
    >
      <MultiLineCommandInput :is-mobile="true" class="h-full w-full" />
    </div>

    <!-- 移动端弹窗集合 -->
    <MobileQuickCommandsModal
      :is-visible="showQuickCommands"
      @close="closeQuickCommandsModal"
      @execute-command="handleQuickCommandExecute"
    />
    <MobileCommandHistoryModal
      :is-visible="showCommandHistoryModal"
      @close="closeCommandHistoryModal"
    />
    <MobileSuspendedSshSessionsModal
      :is-visible="showSuspendedSshSessionsModal"
      @close="closeSuspendedSshSessionsModal"
    />
    <MobileToolbarConfigModal
      :is-visible="showToolbarConfigModal"
      @close="showToolbarConfigModal = false"
    />
    <MobileStatusMonitorModal
      :is-visible="showMobileStatusMonitorModal"
      :active-session-id="activeSessionId"
      @close="showMobileStatusMonitorModal = false"
    />
    <MobileDockerManagerModal
      :is-visible="showMobileDockerManagerModal"
      @close="showMobileDockerManagerModal = false"
    />
    <MobileTerminalTextModal
      :is-visible="showTerminalTextModal"
      @close="showTerminalTextModal = false"
    />
  </div>
</template>
