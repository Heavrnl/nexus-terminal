<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileMultiLineCommandInput from './MobileMultiLineCommandInput.vue';

const props = defineProps<{
  isMobile?: boolean;
}>();

const { isMobile: detectedMobile } = useDeviceDetection();
const isMobile = computed(() => props.isMobile ?? detectedMobile.value);

const { t } = useI18n();
const sessionStore = useSessionStore();
const focusSwitcherStore = useFocusSwitcherStore();
const workspaceSyncStore = useWorkspaceSyncStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();

const { activeSessionId } = storeToRefs(sessionStore);

// --- 本地配置持久化 ---
const STORAGE_KEY_APPEND_ENTER = 'nexus_multiline_append_enter';
const STORAGE_KEY_CLEAR_AFTER_SEND = 'nexus_multiline_clear_after_send';

const appendEnter = ref<boolean>(
  localStorage.getItem(STORAGE_KEY_APPEND_ENTER) !== 'false'
);
const clearAfterSend = ref<boolean>(
  localStorage.getItem(STORAGE_KEY_CLEAR_AFTER_SEND) === 'true'
);

watch(appendEnter, (val) => {
  localStorage.setItem(STORAGE_KEY_APPEND_ENTER, String(val));
});
watch(clearAfterSend, (val) => {
  localStorage.setItem(STORAGE_KEY_CLEAR_AFTER_SEND, String(val));
});

// 使用模块级对象存储会话草稿，避免 Proxy 循环响应并保证组件重挂载时不丢失草稿
const globalSessionDrafts: Record<string, string> = {};

// --- 状态定义 ---
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const currentContent = ref(activeSessionId.value ? (globalSessionDrafts[activeSessionId.value] || '') : '');
const selectedText = ref('');
const copySuccess = ref(false);

// 监听会话变更，保存旧草稿，加载新草稿
watch(activeSessionId, (newId, oldId) => {
  if (oldId) {
    globalSessionDrafts[oldId] = currentContent.value;
  }
  if (newId) {
    currentContent.value = globalSessionDrafts[newId] || '';
  } else {
    currentContent.value = '';
  }
  selectedText.value = '';
});

// 监听当前内容变化并同步至云端工作区
watch(currentContent, (newVal) => {
  if (activeSessionId.value) {
    globalSessionDrafts[activeSessionId.value] = newVal;
  }
  workspaceSyncStore.updateMultiLineCommandState({
    currentContent: newVal,
    sessionDrafts: { ...globalSessionDrafts },
  });
});

onMounted(() => {
  // 从云端工作区快照恢复多行命令草稿
  if (workspaceSyncStore.syncEnabled && workspaceSyncStore.multiLineCommandState) {
    if (workspaceSyncStore.multiLineCommandState.sessionDrafts) {
      Object.assign(globalSessionDrafts, workspaceSyncStore.multiLineCommandState.sessionDrafts);
    }
    if (activeSessionId.value && globalSessionDrafts[activeSessionId.value]) {
      currentContent.value = globalSessionDrafts[activeSessionId.value];
    } else if (workspaceSyncStore.multiLineCommandState.currentContent) {
      currentContent.value = workspaceSyncStore.multiLineCommandState.currentContent;
    }
  }
});

// 更新选区
const updateSelection = () => {
  if (!textareaRef.value) return;
  const el = textareaRef.value;
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;

  if (start !== end) {
    selectedText.value = el.value.substring(start, end);
  } else {
    selectedText.value = '';
  }
};

// 键盘事件：Tab 插入 2 个空格，Ctrl+Enter 发送
const handleKeyDown = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    handleSend();
    return;
  }

  if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    const el = textareaRef.value;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const tabSpaces = '  ';
    currentContent.value = el.value.substring(0, start) + tabSpaces + el.value.substring(end);

    nextTick(() => {
      el.selectionStart = el.selectionEnd = start + tabSpaces.length;
      updateSelection();
    });
  }
};

// 发送命令
const handleSend = () => {
  if (!activeSessionId.value) return;

  const rawText = selectedText.value.trim() ? selectedText.value : currentContent.value;
  if (!rawText.trim()) return;

  // 将多行之间的换行统一转为 \r，确保 Linux shell 终端逐行执行
  const normalizedText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedText.split('\n');
  let commandToSend = lines.join('\r');
  if (commandToSend.endsWith('\r')) {
    commandToSend = commandToSend.slice(0, -1);
  }

  emitWorkspaceEvent('terminal:sendCommand', {
    command: commandToSend,
    sessionId: activeSessionId.value
  });

  if (clearAfterSend.value && !selectedText.value) {
    currentContent.value = '';
    if (activeSessionId.value) {
      globalSessionDrafts[activeSessionId.value] = '';
    }
  }

  updateSelection();
};

// 清空内容
const handleClear = () => {
  currentContent.value = '';
  if (activeSessionId.value) {
    globalSessionDrafts[activeSessionId.value] = '';
  }
  selectedText.value = '';
  textareaRef.value?.focus();
};

// 复制
const handleCopy = async () => {
  const text = selectedText.value || currentContent.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 1500);
  } catch (err) {
    console.error('Copy failed:', err);
  }
};

// 粘贴
const handlePaste = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;

    if (!textareaRef.value) {
      currentContent.value += text;
      return;
    }

    const el = textareaRef.value;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    currentContent.value = el.value.substring(0, start) + text + el.value.substring(end);

    nextTick(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
      updateSelection();
      el.focus();
    });
  } catch (err) {
    console.warn('Clipboard read failed:', err);
  }
};

// 焦点动作
const focusInput = (): boolean => {
  if (textareaRef.value) {
    textareaRef.value.focus();
    return true;
  }
  return false;
};

defineExpose({ focusInput });

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

// 监听填入命令事件，将内容写入多行输入框并聚焦光标到末尾
const handleFillCommand = (payload: { command: string }) => {
  currentContent.value = payload.command;
  if (activeSessionId.value) {
    globalSessionDrafts[activeSessionId.value] = payload.command;
  }
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.focus();
      const len = payload.command.length;
      textareaRef.value.selectionStart = textareaRef.value.selectionEnd = len;
      updateSelection();
    }
  });
};

let unregisterFocus: (() => void) | null = null;
onMounted(() => {
  unregisterFocus = focusSwitcherStore.registerFocusAction('multiLineCommandInput', focusInput);
  onWorkspaceEvent('commandInput:fill', handleFillCommand);
});
onBeforeUnmount(() => {
  if (unregisterFocus) {
    unregisterFocus();
  }
  offWorkspaceEvent('commandInput:fill', handleFillCommand);
});
</script>

<template>
  <!-- 移动端专属模式 -->
  <MobileMultiLineCommandInput v-if="isMobile" />

  <!-- 桌面端常规模式 -->
  <div
    v-else
    class="multi-line-panel flex flex-col h-full w-full min-w-0 min-h-0 bg-background select-none overflow-hidden border border-border/50 rounded-lg"
  >
    <!-- 顶部操作栏 -->
    <div class="panel-header flex items-center justify-between gap-1 px-2 py-1 border-b border-border/50 bg-background-secondary/40 shrink-0 min-w-0 overflow-hidden">
      <!-- 左侧操作组：复制、粘贴、清空 -->
      <div class="flex items-center gap-1 min-w-0 shrink">
        <!-- 复制 -->
        <button
          @click="handleCopy"
          :disabled="!currentContent"
          class="action-btn inline-flex items-center justify-center px-1.5 py-1 text-xs border border-border/60 rounded hover:bg-border/60 hover:text-foreground text-text-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
          title="复制内容"
        >
          <i :class="copySuccess ? 'fas fa-check text-green-500' : 'fas fa-copy'" class="text-xs"></i>
          <span class="btn-text ml-1">{{ copySuccess ? '已复制' : '复制' }}</span>
        </button>

        <!-- 粘贴 -->
        <button
          @click="handlePaste"
          class="action-btn inline-flex items-center justify-center px-1.5 py-1 text-xs border border-border/60 rounded hover:bg-border/60 hover:text-foreground text-text-secondary transition-colors shrink-0"
          title="粘贴"
        >
          <i class="fas fa-paste text-xs"></i>
          <span class="btn-text ml-1">粘贴</span>
        </button>

        <!-- 清空 -->
        <button
          @click="handleClear"
          :disabled="!currentContent"
          class="action-btn inline-flex items-center justify-center px-1.5 py-1 text-xs border border-border/60 rounded hover:bg-destructive/20 hover:text-destructive text-text-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
          title="清空输入框"
        >
          <i class="fas fa-trash-alt text-xs"></i>
          <span class="btn-text ml-1">清空</span>
        </button>
      </div>

      <!-- 右侧：发送主按钮 -->
      <button
        @click="handleSend"
        :disabled="!activeSessionId || !currentContent.trim()"
        class="send-btn inline-flex items-center justify-center px-2 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:pointer-events-none shadow-sm transition-all shrink-0 cursor-pointer whitespace-nowrap ml-auto"
        :title="activeSessionId ? '发送至当前终端 (快捷键: Ctrl+Enter)' : '请先连接终端会话'"
      >
        <i class="fas fa-paper-plane text-xs"></i>
        <span class="send-text ml-1.5">{{ selectedText ? '发送选中' : '发送' }}</span>
      </button>
    </div>

    <!-- 核心多行编辑区：无行号，纯净代码文本输入 -->
    <div class="panel-body relative flex-grow flex min-h-0 min-w-0 overflow-hidden bg-background">
      <textarea
        ref="textareaRef"
        v-model="currentContent"
        @input="updateSelection"
        @keydown="handleKeyDown"
        @keyup="updateSelection"
        @mouseup="updateSelection"
        @select="updateSelection"
        placeholder="输入多行命令/脚本... (Ctrl+Enter 发送)"
        class="editor-textarea flex-grow h-full w-full p-2 bg-transparent text-foreground font-mono text-xs leading-5 resize-none outline-none focus:ring-0 overflow-auto whitespace-pre-wrap break-all placeholder:text-text-secondary/40"
        spellcheck="false"
        data-focus-id="multiLineCommandInput"
      ></textarea>
    </div>

    <!-- 底部选项栏 -->
    <div class="panel-footer flex items-center justify-between gap-1.5 px-2 py-1 border-t border-border/50 bg-background-secondary/40 text-[11px] text-text-secondary shrink-0 min-w-0">
      <!-- 复选框组 -->
      <div class="footer-options flex items-center gap-2 shrink-0 flex-wrap">
        <!-- 末尾追加回车 -->
        <label class="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors whitespace-nowrap select-none" title="发送时自动补齐换行回车">
          <input
            type="checkbox"
            v-model="appendEnter"
            class="rounded border-border/70 text-primary focus:ring-primary/40 h-3 w-3 cursor-pointer shrink-0"
          />
          <span class="option-label">追加回车</span>
        </label>

        <!-- 发送后清空 -->
        <label class="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors whitespace-nowrap select-none" title="命令成功发送后自动清空输入框">
          <input
            type="checkbox"
            v-model="clearAfterSend"
            class="rounded border-border/70 text-primary focus:ring-primary/40 h-3 w-3 cursor-pointer shrink-0"
          />
          <span class="option-label">发送后清空</span>
        </label>
      </div>

      <!-- 桌面端：快捷键提示 -->
      <span class="shortcut-hint text-text-secondary/50 shrink-0 whitespace-nowrap ml-auto">
        Ctrl+Enter ↵
      </span>
    </div>
  </div>
</template>

<style scoped>
.multi-line-panel {
  container-type: inline-size;
}

textarea {
  tab-size: 2;
}

/* 容器查询自适应规则：当面板宽度小于 280px 时优化排版 */
@container (max-width: 280px) {
  .btn-text {
    display: none;
  }
  .action-btn {
    padding-left: 0.375rem;
    padding-right: 0.375rem;
  }
  .shortcut-hint {
    display: none;
  }
}

/* 容器查询自适应规则：当面板宽度极窄（小于 200px）时 */
@container (max-width: 200px) {
  .send-text {
    display: none;
  }
  .send-btn {
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  .panel-footer {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
  }
  .footer-options {
    gap: 0.5rem;
  }
  .option-label {
    font-size: 10px;
  }
}
</style>
