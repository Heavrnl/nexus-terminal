<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useCommandHistoryStore, CommandHistoryEntryFE } from '../stores/commandHistory.store';
import { useSessionStore } from '../stores/session.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const commandHistoryStore = useCommandHistoryStore();
const sessionStore = useSessionStore();
const uiNotificationsStore = useUiNotificationsStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const { showConfirmDialog } = useConfirmDialog();

const { activeSessionId } = storeToRefs(sessionStore);
const { filteredHistory, isLoading } = storeToRefs(commandHistoryStore);

// 本地搜索输入
const searchInput = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const listContainerRef = ref<HTMLDivElement | null>(null);
const copiedId = ref<number | null>(null);

// 分页增量显示（防止大量历史在移动端渲染卡顿）
const displayLimit = ref(40);
const displayedHistory = computed(() => {
  return filteredHistory.value.slice(0, displayLimit.value);
});

// 监听搜索词并同步到 Store (带轻量防抖)
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const handleSearchInput = (e: Event) => {
  const val = (e.target as HTMLInputElement).value;
  searchInput.value = val;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    commandHistoryStore.setSearchTerm(val);
    displayLimit.value = 40;
    debounceTimer = null;
  }, 120);
};

// 一键清空搜索
const clearSearch = () => {
  searchInput.value = '';
  commandHistoryStore.setSearchTerm('');
  displayLimit.value = 40;
  nextTick(() => {
    searchInputRef.value?.focus();
  });
};

// 列表触底增量加载
const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  if (target && target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
    if (displayLimit.value < filteredHistory.value.length) {
      displayLimit.value += 30;
    }
  }
};

// 关闭底部抽屉
const closeModal = () => {
  emit('close');
};

// 复制单条命令
const copyCommand = async (entry: CommandHistoryEntryFE) => {
  try {
    await navigator.clipboard.writeText(entry.command);
    copiedId.value = entry.id;
    uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板'));
    setTimeout(() => {
      if (copiedId.value === entry.id) {
        copiedId.value = null;
      }
    }, 1500);
  } catch (err) {
    console.error('复制命令失败:', err);
    uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败'));
  }
};

// 填入命令到当前会话输入框（支持多行输入框与单行输入框）
const fillCommand = (cmd: string) => {
  emitWorkspaceEvent('commandInput:fill', { command: cmd });
  uiNotificationsStore.showSuccess(t('commandHistory.filled', '已填入输入框'));
  closeModal();
};

// 直接执行命令发送至终端
const executeCommand = (cmd: string) => {
  if (!cmd.trim()) return;
  emitWorkspaceEvent('terminal:sendCommand', { command: cmd });
  closeModal();
};

// 删除单条命令
const deleteCommand = (id: number) => {
  commandHistoryStore.deleteCommand(id);
};

// 清空所有历史
const confirmClearAll = async () => {
  const confirmed = await showConfirmDialog({
    message: t('commandHistory.confirmClear', '确定要清空所有历史记录吗？')
  });
  if (confirmed) {
    commandHistoryStore.clearAllHistory();
  }
};

// 时间戳友好展示
const formatTimestamp = (timestamp?: number): string => {
  if (!timestamp) return '';
  const now = Date.now();
  const date = new Date(timestamp * 1000);
  const diffMinutes = Math.floor((now - date.getTime()) / 60000);

  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} 天前`;

  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  return `${m}-${d} ${hh}:${mm}`;
};

// 键盘 Esc 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    closeModal();
  }
};

watch(() => props.isVisible, (val) => {
  if (val) {
    document.addEventListener('keydown', handleKeydown);
    // 打开时拉取历史或重置搜索
    if (commandHistoryStore.historyList.length === 0) {
      commandHistoryStore.fetchHistory();
    }
    searchInput.value = commandHistoryStore.searchTerm;
    displayLimit.value = 40;
  } else {
    document.removeEventListener('keydown', handleKeydown);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
}, { immediate: true });

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="bottom-sheet-overlay fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="closeModal"
      >
        <!-- 移动端底部滑出面板 (Bottom Sheet) -->
        <div
          class="mobile-history-sheet w-full h-[72vh] max-h-[80vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <!-- 顶部拖拽手柄与点击快速收起指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="closeModal"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与操作区 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <i class="fas fa-history text-sm"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('commandHistory.modalTitle', '命令历史') }}
              </h3>
              <span
                v-if="filteredHistory.length > 0"
                class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-border/40 text-text-secondary"
              >
                {{ filteredHistory.length }}
              </span>
            </div>

            <div class="flex items-center gap-1.5">
              <!-- 一键清空 -->
              <button
                v-if="filteredHistory.length > 0"
                @click="confirmClearAll"
                class="flex items-center gap-1 px-2.5 py-1 text-xs text-text-secondary hover:text-error hover:bg-error/10 active:scale-95 rounded-lg transition-all cursor-pointer"
                :title="t('commandHistory.clear', '清空历史')"
              >
                <i class="fas fa-trash-alt text-xs"></i>
                <span>{{ t('commandHistory.clear', '清空') }}</span>
              </button>

              <!-- 收起按钮 -->
              <button
                @click="closeModal"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                :title="t('close', '收起')"
              >
                <i class="fas fa-chevron-down text-sm"></i>
              </button>
            </div>
          </div>

          <!-- 移动端搜索栏 -->
          <div class="sheet-search px-3.5 py-2 bg-background-secondary/20 border-b border-border/40 shrink-0">
            <div class="relative flex items-center w-full">
              <i class="fas fa-search absolute left-3 text-xs text-text-secondary/60 pointer-events-none"></i>
              <input
                ref="searchInputRef"
                type="text"
                :value="searchInput"
                @input="handleSearchInput"
                :placeholder="t('commandHistory.searchPlaceholder', '搜索历史记录...')"
                class="w-full pl-8 pr-8 py-2 text-xs sm:text-sm bg-input/80 border border-border/50 rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-text-secondary/50 transition-all font-mono"
              />
              <button
                v-if="searchInput"
                @click="clearSearch"
                class="absolute right-2.5 text-text-secondary/60 hover:text-foreground p-0.5 cursor-pointer"
              >
                <i class="fas fa-times-circle text-sm"></i>
              </button>
            </div>
          </div>

          <!-- 历史命令列表区域 -->
          <div
            ref="listContainerRef"
            class="sheet-body flex-grow overflow-y-auto p-3 space-y-2 overscroll-contain"
            @scroll="handleScroll"
          >
            <!-- 加载中状态 -->
            <div v-if="isLoading && filteredHistory.length === 0" class="flex flex-col items-center justify-center py-16 text-text-secondary">
              <i class="fas fa-circle-notch fa-spin text-2xl text-primary mb-2"></i>
              <p class="text-xs">{{ t('commandHistory.loading', '加载历史记录中...') }}</p>
            </div>

            <!-- 空状态：无历史记录 -->
            <div v-else-if="filteredHistory.length === 0" class="flex flex-col items-center justify-center py-16 text-text-secondary">
              <div class="w-12 h-12 rounded-full bg-border/30 flex items-center justify-center mb-2.5">
                <i class="fas fa-history text-xl text-text-secondary/60"></i>
              </div>
              <p class="text-sm font-medium text-foreground">
                {{ searchInput ? '未找到匹配的命令' : t('commandHistory.empty', '没有历史记录') }}
              </p>
              <p class="text-xs text-text-secondary/70 mt-1 text-center max-w-xs">
                {{ searchInput ? '尝试更换搜索关键词' : '在终端输入并执行命令后，会自动沉淀到这里' }}
              </p>
              <button
                v-if="searchInput"
                @click="clearSearch"
                class="mt-3 px-3 py-1 text-xs border border-border rounded-md hover:bg-border/40 text-primary cursor-pointer"
              >
                清除搜索
              </button>
            </div>

            <!-- 历史记录卡片列表 -->
            <template v-else>
              <div
                v-for="entry in displayedHistory"
                :key="entry.id"
                class="history-card group relative bg-background-secondary/35 border border-border/50 rounded-xl p-2.5 transition-all duration-150 active:scale-[0.99] hover:border-primary/40 flex flex-col gap-1.5 cursor-pointer"
                @click="executeCommand(entry.command)"
              >
                <!-- 命令文本正文 -->
                <div class="command-content font-mono text-xs sm:text-sm text-foreground font-medium leading-relaxed break-all select-text pr-1">
                  {{ entry.command }}
                </div>

                <!-- 底部操作按钮组 -->
                <div class="card-footer flex items-center justify-between pt-1 border-t border-border/30 shrink-0 mt-0.5" @click.stop>
                  <!-- 左侧：多久之前的时间戳 -->
                  <span v-if="entry.timestamp" class="text-[10px] text-text-secondary/60 font-sans select-none">
                    {{ formatTimestamp(entry.timestamp) }}
                  </span>
                  <span v-else></span>

                  <div class="flex items-center gap-1.5">
                    <!-- 填入按钮 -->
                    <button
                      @click="fillCommand(entry.command)"
                      class="action-pill px-2 py-1 text-[11px] rounded-md bg-border/40 hover:bg-border active:scale-95 text-foreground transition-all inline-flex items-center gap-1 cursor-pointer"
                      title="填入命令行"
                    >
                      <i class="fas fa-edit text-[10px]"></i>
                      <span>填入</span>
                    </button>

                    <!-- 复制按钮 -->
                    <button
                      @click="copyCommand(entry)"
                      class="action-pill px-2 py-1 text-[11px] rounded-md bg-border/40 hover:bg-border active:scale-95 text-foreground transition-all inline-flex items-center gap-1 cursor-pointer"
                      title="复制命令"
                    >
                      <i :class="copiedId === entry.id ? 'fas fa-check text-green-500' : 'fas fa-copy'" class="text-[10px]"></i>
                      <span>{{ copiedId === entry.id ? '已复制' : '复制' }}</span>
                    </button>

                    <!-- 单条删除按钮 -->
                    <button
                      @click="deleteCommand(entry.id)"
                      class="action-pill p-1 text-[11px] rounded-md text-text-secondary/70 hover:text-error hover:bg-error/10 active:scale-95 transition-all inline-flex items-center justify-center w-6 h-6 cursor-pointer"
                      title="删除"
                    >
                      <i class="fas fa-times text-xs"></i>
                    </button>

                    <!-- 快捷执行按钮 -->
                    <button
                      @click="executeCommand(entry.command)"
                      class="action-pill px-2.5 py-1 text-[11px] font-medium rounded-md bg-button text-button-text hover:bg-button-hover active:scale-95 transition-all inline-flex items-center gap-1 shadow-xs cursor-pointer ml-1"
                      title="立即发送执行"
                    >
                      <i class="fas fa-paper-plane text-[9px]"></i>
                      <span>执行</span>
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- 底部安全区垫片 -->
          <div class="sheet-safe-bottom shrink-0"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.24s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .mobile-history-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-history-sheet {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-history-sheet,
.bottom-sheet-leave-to .mobile-history-sheet {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}

.history-card {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
</style>
