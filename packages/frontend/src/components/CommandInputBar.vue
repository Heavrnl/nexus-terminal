<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, defineExpose, computed, defineOptions } from 'vue'; // Import defineOptions
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store'; 
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useSettingsStore } from '../stores/settings.store';
import { useQuickCommandsStore } from '../stores/quickCommands.store';
import { useCommandHistoryStore } from '../stores/commandHistory.store';
import QuickCommandsModal from './QuickCommandsModal.vue'; 
import CommandHistoryModal from './CommandHistoryModal.vue';
import SuspendedSshSessionsModal from './SuspendedSshSessionsModal.vue'; 
import MobileToolbarConfigModal from './MobileToolbarConfigModal.vue';
import MobileStatusMonitorModal from './MobileStatusMonitorModal.vue';
import MobileDockerManagerModal from './MobileDockerManagerModal.vue';
import { useMobileToolbarConfig } from '../composables/useMobileToolbarConfig';
import { useFileEditorStore } from '../stores/fileEditor.store'; 
import { useLayoutStore } from '../stores/layout.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import MultiLineCommandInput from './MultiLineCommandInput.vue';


defineOptions({ inheritAttrs: false });

const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++
const emit = defineEmits(['toggle-virtual-keyboard']);

const { t } = useI18n();
const focusSwitcherStore = useFocusSwitcherStore();
const settingsStore = useSettingsStore();
const quickCommandsStore = useQuickCommandsStore();
const commandHistoryStore = useCommandHistoryStore();
const sessionStore = useSessionStore(); // +++ 初始化 Session Store +++
const fileEditorStore = useFileEditorStore(); // +++ Initialize File Editor Store +++
const layoutStore = useLayoutStore(); // +++ Initialize Layout Store +++
const { isHeaderVisible } = storeToRefs(layoutStore);

const toggleHeader = () => {
  layoutStore.toggleHeaderVisibility();
};

const openTransferProgressModal = () => {
  emitWorkspaceEvent('ui:openTransferProgressModal');
};

// Get reactive setting from store
const { commandInputSyncTarget, showPopupFileManagerBoolean, showPopupFileEditorBoolean } = storeToRefs(settingsStore); // +++ Import showPopupFileEditorBoolean +++
// Get reactive state and actions from quick commands store
const { selectedIndex: quickCommandsSelectedIndex, flatVisibleCommands: quickCommandsFiltered } = storeToRefs(quickCommandsStore);
const { resetSelection: resetQuickCommandsSelection } = quickCommandsStore;
// Get reactive state and actions from command history store
const { selectedIndex: historySelectedIndex, filteredHistory: historyFiltered } = storeToRefs(commandHistoryStore);
const { resetSelection: resetHistorySelection } = commandHistoryStore;
// +++ Get active session ID from session store +++
const { activeSessionId } = storeToRefs(sessionStore);
const { updateSessionCommandInput } = sessionStore;

// Props definition is now empty as search results are no longer handled here
const props = defineProps<{
  // No props defined here currently
  isMobile?: boolean;
  isVirtualKeyboardVisible?: boolean; // +++ Add prop to receive state +++
}>();
// --- 移除本地 commandInput ref ---
// const commandInput = ref('');
const isSearching = ref(false);
const searchTerm = ref('');
const showQuickCommands = ref(false); // +++ Add state for modal visibility +++
const showCommandHistoryModal = ref(false); // +++ Add state for command history modal +++
const showSuspendedSshSessionsModal = ref(false); // +++ Add state for suspended SSH sessions modal +++
const showToolbarConfigModal = ref(false); // +++ 移动端自定义工具栏抽屉可见性 +++
const showMobileStatusMonitorModal = ref(false); // +++ 移动端状态监视器抽屉可见性 +++
const showMobileDockerManagerModal = ref(false); // +++ 移动端 Docker 管理器抽屉可见性 +++

const { activeItemIds } = useMobileToolbarConfig();

const scrollToBottom = () => {
  if (activeSessionId.value) {
    emitWorkspaceEvent('terminal:scrollToBottomRequest', { sessionId: activeSessionId.value });
  }
};

// +++ 计算属性，用于获取和设置当前活动会话的命令输入 +++
const currentSessionCommandInput = computed({
  get: () => {
    if (!activeSessionId.value) return '';
    const session = sessionStore.sessions.get(activeSessionId.value);
    return session ? session.commandInputContent.value : '';
  },
  set: (newValue) => {
    if (activeSessionId.value) {
      updateSessionCommandInput(activeSessionId.value, newValue);
    }
  }
});

const sendCommand = () => {
  const command = currentSessionCommandInput.value; // 使用计算属性获取值
  console.log(`[CommandInputBar] Sending command: ${command || '<Enter>'} `);
  emitWorkspaceEvent('terminal:sendCommand', { command });

  // 如果是空回车，并且有活动会话，则请求滚动到底部
  if (command.trim() === '' && activeSessionId.value) {
    console.log(`[CommandInputBar] Empty Enter detected. Requesting scroll to bottom for session: ${activeSessionId.value}`);
    emitWorkspaceEvent('terminal:scrollToBottomRequest', { sessionId: activeSessionId.value });
  }

  // 清空 store 中的值
  if (activeSessionId.value) {
    updateSessionCommandInput(activeSessionId.value, '');
  }
};

const toggleSearch = () => {
  isSearching.value = !isSearching.value;
  if (!isSearching.value) {
    searchTerm.value = ''; // 关闭搜索时清空
    emitWorkspaceEvent('search:close'); // 通知父组件关闭搜索
  } else {
    // 可以在这里聚焦搜索输入框
    // nextTick(() => searchInputRef.value?.focus());
  }
};

const performSearch = () => {
  emitWorkspaceEvent('search:start', { term: searchTerm.value });
  // 实际的计数更新逻辑应该由父组件通过 props 或事件传递回来
};

const findNext = () => {
  emitWorkspaceEvent('search:findNext');
};

const findPrevious = () => {
  emitWorkspaceEvent('search:findPrevious');
};

// 监听搜索词变化，执行搜索
watch(searchTerm, (newValue) => {
  if (isSearching.value) {
    performSearch();
  }
});

//  Watch currentSessionCommandInput and sync searchTerm based on settings
watch(currentSessionCommandInput, (newValue) => { // 监听计算属性
  const target = commandInputSyncTarget.value;
  if (target === 'quickCommands') {
    quickCommandsStore.setSearchTerm(newValue);
  } else if (target === 'commandHistory') {
    commandHistoryStore.setSearchTerm(newValue);
  }
  // If target is 'none', do nothing
});

// 可以在这里添加一个 ref 用于聚焦搜索框
const searchInputRef = ref<HTMLInputElement | null>(null);
const commandInputRef = ref<HTMLInputElement | null>(null); // Ref for command input

// Removed debug computed property

const handleCommandInputKeydown = (event: KeyboardEvent) => {
  // --- 移动到外部：优先处理 Enter 键执行选中项 ---
  if (!event.altKey && event.key === 'Enter') {
    const target = commandInputSyncTarget.value;
    let selectedCommand: string | undefined;
    let resetSelection: (() => void) | undefined;

    if (target === 'quickCommands' && quickCommandsSelectedIndex.value >= 0) {
      const commands = quickCommandsFiltered.value;
      if (quickCommandsSelectedIndex.value < commands.length) {
        selectedCommand = commands[quickCommandsSelectedIndex.value].command;
        resetSelection = resetQuickCommandsSelection;
      }
    } else if (target === 'commandHistory' && historySelectedIndex.value >= 0) {
      const history = historyFiltered.value;
      if (historySelectedIndex.value < history.length) {
        selectedCommand = history[historySelectedIndex.value].command;
        resetSelection = resetHistorySelection;
      }
    }

    if (selectedCommand !== undefined) {
      event.preventDefault();
      console.log(`[CommandInputBar] Enter detected with selection. Sending selected command: ${selectedCommand}`);
      emitWorkspaceEvent('terminal:sendCommand', { command: selectedCommand }); // 发送选中命令
      if (activeSessionId.value) {
        updateSessionCommandInput(activeSessionId.value, ''); // 清空输入框
      }
      resetSelection?.(); // 重置列表选中状态
      return; // 阻止后续的 Enter 处理
    }
    // 如果没有选中项，则继续执行下面的默认 Enter 逻辑
  }
  // --- 结束：优先处理 Enter 键执行选中项 ---

  if (event.ctrlKey && event.key === 'f') {
    event.preventDefault(); // 阻止浏览器默认的查找行为
    isSearching.value = true;
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  } else if (event.key === 'ArrowUp') {
    const target = commandInputSyncTarget.value;
    if (target === 'quickCommands') {
      event.preventDefault();
      quickCommandsStore.selectPreviousCommand();
    } else if (target === 'commandHistory') {
      event.preventDefault();
      commandHistoryStore.selectPreviousCommand();
    }
  } else if (event.key === 'ArrowDown') {
    const target = commandInputSyncTarget.value;
    if (target === 'quickCommands') {
      event.preventDefault();
      quickCommandsStore.selectNextCommand();
    } else if (target === 'commandHistory') {
      event.preventDefault();
      commandHistoryStore.selectNextCommand();
    }
  } else if (event.ctrlKey && event.key === 'c' && currentSessionCommandInput.value === '') { // 检查计算属性的值
    // Handle Ctrl+C when input is empty
    event.preventDefault();
    console.log('[CommandInputBar] Ctrl+C detected with empty input. Sending SIGINT.');
    emitWorkspaceEvent('terminal:sendCommand', { command: '\x03' }); // Send ETX character (Ctrl+C)
  } else if (!event.altKey && event.key === 'Enter') {
     // Handle regular Enter key press - send current input (empty or not)
     event.preventDefault(); // Prevent default if needed, e.g., form submission
     sendCommand(); // Call the existing sendCommand function
 } else {
   // --- 处理其他按键，取消列表选中状态 ---
   // 检查按下的键是否是普通输入键或删除键等，而不是导航键或修饰键
   if (!['ArrowUp', 'ArrowDown', 'Enter', 'Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(event.key)) {
       const target = commandInputSyncTarget.value;
       if (target === 'quickCommands' && quickCommandsSelectedIndex.value >= 0) {
           resetQuickCommandsSelection();
       } else if (target === 'commandHistory' && historySelectedIndex.value >= 0) {
           resetHistorySelection();
       }
   }
 }
};

//  Handle blur event on command input
const handleCommandInputBlur = () => {
    // Reset selection in the target store when input loses focus
    const target = commandInputSyncTarget.value;
    if (target === 'quickCommands') {
        resetQuickCommandsSelection();
    } else if (target === 'commandHistory') {
        resetHistorySelection();
    }
};

// +++ 监听 Store 中的触发器以激活终端搜索 +++
watch(() => focusSwitcherStore.activateTerminalSearchTrigger, () => {
    if (focusSwitcherStore.activateTerminalSearchTrigger > 0 && !isSearching.value) {
        console.log('[CommandInputBar] Received terminal search activation trigger from store.');
        toggleSearch(); // 调用组件内部的切换搜索方法来激活
    }
});

// --- 移动端多行命令输入状态 ---
const isMobileMultiLineOpen = ref(false);

// 切换移动端多行输入框展开/收回
const toggleMobileMultiLine = () => {
  isMobileMultiLineOpen.value = !isMobileMultiLineOpen.value;
};

// --- Focus Actions ---
const focusCommandInput = (): boolean => {
  if (props.isMobile) {
    if (!isMobileMultiLineOpen.value) {
      isMobileMultiLineOpen.value = true;
    }
    return true;
  }
  if (commandInputRef.value) {
    commandInputRef.value.focus();
    return true;
  }
  return false;
};

const focusSearchInput = (): boolean => {
  if (!isSearching.value) {
    // If search is not active, activate it first
    toggleSearch(); // This might need nextTick if toggleSearch is async
    nextTick(() => { // Ensure DOM is updated after toggleSearch
        if (searchInputRef.value) {
            searchInputRef.value.focus();
        }
    });
    // Since focusing might be async after toggle, we optimistically return true
    // or adjust based on toggleSearch's behavior. For simplicity, assume it works.
    return true;
  } else if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true;
  }
  return false;
};

defineExpose({ focusCommandInput, focusSearchInput });

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

// 监听填入命令事件：移动端自动展开多行命令输入框；桌面端更新单行输入框
const handleCommandFill = (payload: { command: string }) => {
  if (props.isMobile) {
    isMobileMultiLineOpen.value = true;
  } else {
    if (activeSessionId.value) {
      updateSessionCommandInput(activeSessionId.value, payload.command);
    }
  }
};

// --- Register/Unregister Focus Actions ---
let unregisterCommandInputFocus: (() => void) | null = null;
let unregisterTerminalSearchFocus: (() => void) | null = null;

onMounted(() => {
  unregisterCommandInputFocus = focusSwitcherStore.registerFocusAction('commandInput', focusCommandInput);
  unregisterTerminalSearchFocus = focusSwitcherStore.registerFocusAction('terminalSearch', focusSearchInput);
  onWorkspaceEvent('commandInput:fill', handleCommandFill);
});

onBeforeUnmount(() => {
  if (unregisterCommandInputFocus) {
    unregisterCommandInputFocus();
  }
  if (unregisterTerminalSearchFocus) {
    unregisterTerminalSearchFocus();
  }
  offWorkspaceEvent('commandInput:fill', handleCommandFill);
});

// +++ Functions to control the quick commands modal / bottom sheet +++
const toggleQuickCommandsModal = () => {
  showQuickCommands.value = !showQuickCommands.value;
};

const openQuickCommandsModal = () => {
  showQuickCommands.value = true;
};

const closeQuickCommandsModal = () => {
  showQuickCommands.value = false;
};

// +++ Functions to control the command history modal / bottom sheet +++
const toggleCommandHistoryModal = () => {
  showCommandHistoryModal.value = !showCommandHistoryModal.value;
};

const openCommandHistoryModal = () => {
  showCommandHistoryModal.value = true;
};

const closeCommandHistoryModal = () => {
  showCommandHistoryModal.value = false;
};

// +++ Functions to control the suspended SSH sessions modal / bottom sheet +++
const toggleSuspendedSshSessionsModal = () => {
  showSuspendedSshSessionsModal.value = !showSuspendedSshSessionsModal.value;
};

const openSuspendedSshSessionsModal = () => {
  showSuspendedSshSessionsModal.value = true;
};

const closeSuspendedSshSessionsModal = () => {
  showSuspendedSshSessionsModal.value = false;
};

// +++ Function to request opening the file manager modal via event bus +++
const openFileManagerModal = () => {
  if (activeSessionId.value) {
    console.log(`[CommandInputBar] Emitting fileManager:openModalRequest for session: ${activeSessionId.value}`);
    emitWorkspaceEvent('fileManager:openModalRequest', { sessionId: activeSessionId.value });
  } else {
    console.warn('[CommandInputBar] Cannot open file manager modal: No active session ID.');
    // Optionally, show a notification to the user
  }
};

// +++ Function to request opening the file editor modal +++
const openFileEditorModal = () => {
 if (activeSessionId.value) {
   console.log(`[CommandInputBar] Triggering popup editor for session: ${activeSessionId.value}`);
   fileEditorStore.triggerPopup('', activeSessionId.value); // Call store action directly
 } else {
   console.warn('[CommandInputBar] Cannot open file editor modal: No active session ID.');
   // Optionally, show a notification to the user
 }
};

// +++ Handler for command execution from the modal +++
const handleQuickCommandExecute = (command: string) => {
  console.log(`[CommandInputBar] Executing quick command: ${command}`);
  emitWorkspaceEvent('terminal:sendCommand', { command }); // Emit the command to the parent
  closeQuickCommandsModal(); // Close the modal after selection
};

// +++ 移动端/桌面端按钮基础样式生成 +++
const getBarButtonClass = (isActive: boolean = false) => {
  if (props.isMobile) {
    return [
      'flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 active:scale-95',
      isActive
        ? 'bg-primary/15 text-primary border border-primary/30 shadow-xs'
        : 'text-text-secondary hover:text-foreground hover:bg-border/30 active:bg-border/40'
    ];
  }
  return [
    'flex-shrink-0 flex items-center justify-center w-8 h-8 border rounded-lg transition-colors duration-200',
    isActive
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-border/50 text-text-secondary hover:bg-border hover:text-foreground'
  ];
};
</script>

<template>
  <div :class="[$attrs.class, 'flex flex-col', props.isMobile ? 'bg-header border-t border-border/20' : 'bg-background border-t border-border/30']">
    
    <!-- ==================== 移动端工具栏 (扁平单层滚动，编辑按钮置于最右侧) ==================== -->
    <div v-if="props.isMobile" class="flex items-center py-1.5 px-2 bg-transparent relative gap-1 w-full overflow-x-auto no-scrollbar">
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

        <!-- 多行命令输入 -->
        <button
          v-else-if="itemId === 'multiLine'"
          @click="toggleMobileMultiLine"
          :class="getBarButtonClass(isMobileMultiLineOpen)"
          :title="isMobileMultiLineOpen ? t('commandInputBar.closeMultiLine', '收起多行命令输入框') : t('commandInputBar.openMultiLine', '展开多行命令输入框')"
        >
          <i class="fas fa-terminal text-base"></i>
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

      <!-- 专属样式的编辑按钮：置于工具栏内最右侧，样式独特一眼识别 -->
      <button
        @click="showToolbarConfigModal = true"
        class="flex-shrink-0 flex items-center justify-center gap-1 px-2.5 h-8 rounded-lg border border-dashed border-primary/70 bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all shadow-xs cursor-pointer ml-0.5"
        :title="t('mobileToolbar.title', '自定义工具栏')"
      >
        <i class="fas fa-sliders-h text-xs"></i>
        <span class="text-xs font-semibold tracking-tight">编辑</span>
      </button>
    </div>

    <!-- ==================== 桌面端工具栏 (100% 保持原有布局) ==================== -->
    <div v-else class="flex items-center py-1.5 px-2 bg-transparent relative gap-1 w-full overflow-x-auto no-scrollbar">
      <!-- Clear Terminal Button -->
      <button
        @click="emitWorkspaceEvent('terminal:clear')"
        :class="getBarButtonClass()"
        :title="t('commandInputBar.clearTerminal', '清空终端')"
      >
        <i class="fas fa-eraser text-base"></i>
      </button>
      <!-- Focus Switcher Config Button (Hide on mobile) -->
      <button
        @click="focusSwitcherStore.toggleConfigurator(true)"
        :class="getBarButtonClass()"
        :title="t('commandInputBar.configureFocusSwitch', '配置焦点切换')"
      >
        <i class="fas fa-keyboard text-base"></i>
      </button>
      <!-- Desktop: Command Input -->
      <input
        type="text"
        v-model="currentSessionCommandInput"
        :placeholder="t('commandInputBar.placeholder')"
        class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all duration-300 ease-in-out"
        :class="{
          'basis-3/4': isSearching,
          'basis-full': !isSearching,
        }"
        ref="commandInputRef"
        data-focus-id="commandInput"
        @keydown="handleCommandInputKeydown"
        @blur="handleCommandInputBlur"
      />

      <!-- Desktop: Search Input (Show when searching) -->
      <input
        v-if="isSearching"
        type="text"
        v-model="searchTerm"
        :placeholder="t('commandInputBar.searchPlaceholder')"
        class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all duration-300 ease-in-out basis-1/4"
        data-focus-id="terminalSearch"
        @keydown.enter.prevent="findNext"
        @keydown.shift.enter.prevent="findPrevious"
        @keydown.up.prevent="findPrevious"
        @keydown.down.prevent="findNext"
        ref="searchInputRef"
      />

      <!-- Search Controls -->
      <div class="flex items-center gap-1 flex-shrink-0">
        <!-- Search Toggle Button -->
        <button
          @click="toggleSearch"
          :class="getBarButtonClass(isSearching)"
          :title="isSearching ? t('commandInputBar.closeSearch') : t('commandInputBar.openSearch')"
        >
          <i v-if="!isSearching" class="fas fa-search text-base"></i>
          <i v-else class="fas fa-times text-base"></i>
        </button>

        <!-- Search navigation buttons -->
        <template v-if="isSearching">
          <button
            @click="findPrevious"
            class="flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
            :title="t('commandInputBar.findPrevious')"
          >
            <i class="fas fa-arrow-up text-base"></i>
          </button>
          <button
            @click="findNext"
            class="flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
            :title="t('commandInputBar.findNext')"
          >
            <i class="fas fa-arrow-down text-base"></i>
          </button>
        </template>
        <!-- File Manager Button -->
        <button
          v-if="showPopupFileManagerBoolean"
          @click="openFileManagerModal"
          :class="getBarButtonClass()"
        >
          <i class="fas fa-folder text-base"></i>
        </button>
        <!-- File Editor Button -->
        <button
          v-if="showPopupFileEditorBoolean"
          @click="openFileEditorModal"
          :class="getBarButtonClass()"
          :title="t('fileEditor.title', '文件编辑')"
        >
          <i class="fas fa-edit text-base"></i>
        </button>
      </div>
    </div>

    <!-- 移动端多行命令输入组件展开区域 (点击上方图标展开/再次点击收回) -->
    <div
      v-if="props.isMobile"
      v-show="isMobileMultiLineOpen"
      class="w-full max-h-[38vh] h-44 p-1.5 bg-background border-t border-border/50 shrink-0"
    >
      <MultiLineCommandInput :is-mobile="props.isMobile" class="h-full w-full" />
    </div>
  </div>
  <!-- +++ Quick Commands Modal Instance +++ -->
  <QuickCommandsModal
    :is-visible="showQuickCommands"
    @close="closeQuickCommandsModal"
    @execute-command="handleQuickCommandExecute"
  />
  <!-- +++ Command History Modal Instance +++ -->
  <CommandHistoryModal
    :is-visible="showCommandHistoryModal"
    @close="closeCommandHistoryModal"
  />
  <!-- +++ Suspended SSH Sessions Modal Instance +++ -->
  <SuspendedSshSessionsModal
    :is-visible="showSuspendedSshSessionsModal"
    @close="closeSuspendedSshSessionsModal"
  />
  <!-- +++ Mobile Toolbar Config Modal Instance +++ -->
  <MobileToolbarConfigModal
    v-if="props.isMobile"
    :is-visible="showToolbarConfigModal"
    @close="showToolbarConfigModal = false"
  />
  <!-- +++ Mobile Status Monitor Modal Instance +++ -->
  <MobileStatusMonitorModal
    v-if="props.isMobile"
    :is-visible="showMobileStatusMonitorModal"
    :active-session-id="activeSessionId"
    @close="showMobileStatusMonitorModal = false"
  />
  <!-- +++ Mobile Docker Manager Modal Instance +++ -->
  <MobileDockerManagerModal
    v-if="props.isMobile"
    :is-visible="showMobileDockerManagerModal"
    @close="showMobileDockerManagerModal = false"
  />
  <!-- File Manager Modal is now handled by a listener for 'fileManager:openModalRequest' event -->
</template>

<style scoped>
/* Scoped styles removed for Tailwind CSS refactoring */
</style>
