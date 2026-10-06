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
import { useFileEditorStore } from '../stores/fileEditor.store'; 
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
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
// *** 移除本地的搜索结果 ref ***
// const searchResultCount = ref(0);
// const currentSearchResultIndex = ref(0);

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

// --- Register/Unregister Focus Actions ---
let unregisterCommandInputFocus: (() => void) | null = null;
let unregisterTerminalSearchFocus: (() => void) | null = null;

onMounted(() => {
  unregisterCommandInputFocus = focusSwitcherStore.registerFocusAction('commandInput', focusCommandInput);
  unregisterTerminalSearchFocus = focusSwitcherStore.registerFocusAction('terminalSearch', focusSearchInput);
});

onBeforeUnmount(() => {
  if (unregisterCommandInputFocus) {
    unregisterCommandInputFocus();
  }
  if (unregisterTerminalSearchFocus) {
    unregisterTerminalSearchFocus();
  }
});

// +++ Functions to control the quick commands modal +++
const openQuickCommandsModal = () => {
  showQuickCommands.value = true;
};

const closeQuickCommandsModal = () => {
  showQuickCommands.value = false;
};

// +++ Functions to control the command history modal +++
const openCommandHistoryModal = () => {
  showCommandHistoryModal.value = true;
};

const closeCommandHistoryModal = () => {
  showCommandHistoryModal.value = false;
};

// +++ Functions to control the suspended SSH sessions modal +++
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
</script>

<template>
  <div :class="$attrs.class" class="flex flex-col bg-background border-t border-border/30">
    <div class="flex items-center py-1.5 px-2 bg-transparent relative gap-1 w-full">
      <!-- Clear Terminal Button -->
      <button
        @click="emitWorkspaceEvent('terminal:clear')"
        class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        :title="t('commandInputBar.clearTerminal', '清空终端')"
      >
        <i class="fas fa-eraser text-base"></i>
      </button>
       <!-- +++ Quick Commands Button (Mobile only) +++ -->
       <button
        v-if="props.isMobile"
        @click="openQuickCommandsModal"
        class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        :title="t('quickCommands.title', '快捷指令')"
      >
        <i class="fas fa-bolt text-base"></i>
      </button>
       <!-- +++ Command History Button (Mobile only) +++ -->
       <button
        v-if="props.isMobile"
        @click="openCommandHistoryModal"
        class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        :title="t('commandHistory.title', '命令历史')"
      >
        <i class="fas fa-history text-base"></i>
      </button>
      <!-- Focus Switcher Config Button (Hide on mobile) -->
      <button
        v-if="!props.isMobile"
        @click="focusSwitcherStore.toggleConfigurator(true)"
        class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        :title="t('commandInputBar.configureFocusSwitch', '配置焦点切换')"
      >
        <i class="fas fa-keyboard text-base"></i> <!-- Removed text-primary -->
      </button>
      <!-- Desktop: Command Input -->
      <input
        v-if="!props.isMobile"
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

      <!-- Mobile: 命令输入按钮 (仅图标，点击展开/收回多行输入框) -->
      <button
        v-else
        @click="toggleMobileMultiLine"
        class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        :class="isMobileMultiLineOpen ? 'border-primary bg-primary/10 text-primary' : ''"
        :title="isMobileMultiLineOpen ? t('commandInputBar.closeMultiLine', '收起多行命令输入框') : t('commandInputBar.openMultiLine', '展开多行命令输入框')"
      >
        <i class="fas fa-terminal text-base"></i>
      </button>

      <!-- Desktop: Search Input (Show when searching) -->
      <input
        v-if="isSearching && !props.isMobile"
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
        <!-- +++ Toggle Virtual Keyboard Button (Moved here, Mobile only) +++ -->
        <!-- +++ Suspended SSH Sessions Button (Mobile only, new position) +++ -->
        <button
          v-if="props.isMobile"
          @click="openSuspendedSshSessionsModal"
          class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
          :title="t('suspendedSshSessions.title', '挂起会话')"
        >
          <i class="fas fa-pause-circle text-base"></i>
        </button>
        <!-- +++ Toggle Virtual Keyboard Button (Mobile only) +++ -->
        <button
          v-if="props.isMobile"
          @click="emit('toggle-virtual-keyboard')"
          class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
          :title="props.isVirtualKeyboardVisible ? t('commandInputBar.hideKeyboard', '隐藏虚拟键盘') : t('commandInputBar.showKeyboard', '显示虚拟键盘')"
        >
          <i class="fas fa-keyboard text-base" :class="{ 'opacity-50': !props.isVirtualKeyboardVisible }"></i>
        </button>
        <!-- Search Toggle Button -->
        <button
          v-if="!props.isMobile"
          @click="toggleSearch"
          class="flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
          :title="isSearching ? t('commandInputBar.closeSearch') : t('commandInputBar.openSearch')"
        >
          <i v-if="!isSearching" class="fas fa-search text-base"></i>
          <i v-else class="fas fa-times text-base"></i>
        </button>

        <!-- Search navigation buttons (Hide on mobile when searching) -->
        <template v-if="isSearching && !props.isMobile"> <!-- +++ Add !props.isMobile condition +++ -->
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
          v-if="showPopupFileManagerBoolean || props.isMobile"
          @click="openFileManagerModal"
          class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        >
          <i class="fas fa-folder text-base"></i>
        </button>
        <!-- File Editor Button -->
        <button
          v-if="showPopupFileEditorBoolean || props.isMobile"
          @click="openFileEditorModal"
          class="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
        >
          <i class="fas fa-edit text-base"></i>
        </button>
        <!-- Note: On mobile, when searching, only the close button (inside toggleSearch button logic) will be effectively visible in this control group -->
      </div>
    </div>

    <!-- 移动端多行命令输入组件展开区域 (点击上方图标展开/再次点击收回) -->
    <div
      v-if="props.isMobile && isMobileMultiLineOpen"
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
  <!-- File Manager Modal is now handled by a listener for 'fileManager:openModalRequest' event -->
</template>

<style scoped>
/* Scoped styles removed for Tailwind CSS refactoring */
</style>
