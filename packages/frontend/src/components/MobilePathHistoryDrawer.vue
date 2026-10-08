<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { usePathHistoryStore, type PathHistoryEntryFE } from '../stores/pathHistory.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { copyToClipboard } from '../utils/clipboard';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = defineProps<{
  isVisible: boolean;
  currentPath: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'navigate-to-path', path: string): void;
}>();

const { t } = useI18n();
const pathHistoryStore = usePathHistoryStore();
const { showConfirmDialog } = useConfirmDialog();

const { filteredHistory, isLoading } = storeToRefs(pathHistoryStore);

const inputPath = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const copiedId = ref<number | null>(null);

// 监听弹窗显示与路径更新
watch(
  () => props.isVisible,
  (visible) => {
    if (visible) {
      inputPath.value = props.currentPath || '/';
      pathHistoryStore.setSearchTerm(inputPath.value);
      if (pathHistoryStore.historyList.length === 0) {
        pathHistoryStore.fetchHistory();
      }
      nextTick(() => {
        if (inputRef.value) {
          inputRef.value.focus();
          inputRef.value.select();
        }
      });
    } else {
      pathHistoryStore.resetSelection();
      pathHistoryStore.setSearchTerm('');
    }
  },
  { immediate: true }
);

const handleInputChange = () => {
  pathHistoryStore.setSearchTerm(inputPath.value);
};

const handleClearInput = () => {
  inputPath.value = '';
  pathHistoryStore.setSearchTerm('');
  inputRef.value?.focus();
};

const handlePasteFromClipboard = async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        inputPath.value = text.trim();
        handleInputChange();
      }
    }
  } catch (err) {
    console.warn('[MobilePathHistory] 从剪贴板粘贴失败:', err);
  }
};

const handleConfirm = (targetPath?: string) => {
  const path = (targetPath !== undefined ? targetPath : inputPath.value).trim();
  if (!path) return;
  emit('navigate-to-path', path);
  emit('close');
};

const handleSelectEntry = (entry: PathHistoryEntryFE) => {
  handleConfirm(entry.path);
};

const handleCopyEntry = async (entry: PathHistoryEntryFE) => {
  const success = await copyToClipboard(entry.path);
  if (success) {
    copiedId.value = entry.id;
    setTimeout(() => {
      if (copiedId.value === entry.id) {
        copiedId.value = null;
      }
    }, 1500);
  }
};

const handleDeleteEntry = async (entry: PathHistoryEntryFE) => {
  await pathHistoryStore.deletePath(entry.id);
};

const handleClearAll = async () => {
  const confirmed = await showConfirmDialog({
    title: t('pathHistory.clearTitle', '清空历史路径'),
    message: t('pathHistory.clearConfirm', '确定要清空全部访问历史记录吗？'),
    confirmText: t('common.clear', '清空'),
  });
  if (confirmed) {
    await pathHistoryStore.clearAllHistory();
  }
};

const handleClose = () => {
  emit('close');
};
</script>

<template>
  <MobileBottomSheet
    :visible="isVisible"
    height="h-[82vh]"
    max-height="max-h-[82vh]"
    @close="handleClose"
  >
    <!-- 顶栏左侧标题与副标题 -->
    <template #header-left>
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <i class="fas fa-history text-sm"></i>
        </div>
        <div>
          <h3 class="text-sm font-semibold text-foreground leading-tight">
            {{ t('pathHistory.title', '历史路径与跳转') }}
          </h3>
          <p class="text-[11px] text-text-secondary leading-tight mt-0.5">
            {{ t('pathHistory.subtitle', '直接编辑路径或快速选取历史记录') }}
          </p>
        </div>
      </div>
    </template>

    <!-- 顶栏右侧清空全部按钮 -->
    <template #header-actions>
      <button
        v-if="pathHistoryStore.historyList.length > 0"
        @click="handleClearAll"
        type="button"
        class="px-2 py-1 text-xs text-text-secondary hover:text-error active:bg-header rounded-md transition-colors cursor-pointer"
        :title="t('pathHistory.clearAllTooltip', '清空全部历史记录')"
      >
        <i class="far fa-trash-alt mr-1"></i>
        <span>{{ t('pathHistory.clearAll', '清空') }}</span>
      </button>
    </template>

    <!-- 路径输入与直达区 -->
    <template #sub-header>
      <div class="px-4 py-2.5 flex items-center gap-2 shrink-0 border-b border-border/40 bg-header/10">
        <div class="relative flex-grow">
          <i class="fas fa-folder-open absolute left-3 top-1/2 -translate-y-1/2 text-xs text-primary/80 pointer-events-none"></i>
          <input
            ref="inputRef"
            type="text"
            v-model="inputPath"
            @input="handleInputChange"
            @keydown.enter="handleConfirm()"
            placeholder="/path/to/directory"
            class="w-full h-10 bg-input border border-border rounded-xl pl-8.5 pr-14 font-mono text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          />
          <!-- 输入框内部操作：清空与粘贴 -->
          <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              v-if="inputPath"
              type="button"
              @click="handleClearInput"
              class="w-5 h-5 rounded-full flex items-center justify-center text-text-secondary hover:text-foreground bg-border/40 hover:bg-border active:scale-95 transition-all cursor-pointer"
              title="清空输入"
            >
              <i class="fas fa-times text-[10px]"></i>
            </button>
            <button
              type="button"
              @click="handlePasteFromClipboard"
              class="w-6 h-6 rounded flex items-center justify-center text-text-secondary hover:text-primary active:scale-95 transition-all cursor-pointer"
              title="从剪贴板粘贴"
            >
              <i class="far fa-clipboard text-xs"></i>
            </button>
          </div>
        </div>

        <!-- 前往按钮 -->
        <button
          type="button"
          @click="handleConfirm()"
          class="h-10 px-3.5 flex items-center justify-center gap-1.5 bg-primary text-white rounded-xl text-xs font-semibold active:scale-95 transition-all shadow-md shrink-0 cursor-pointer"
        >
          <span>{{ t('pathHistory.go', '前往') }}</span>
          <i class="fas fa-arrow-right text-[11px]"></i>
        </button>
      </div>
    </template>

    <!-- 历史路径列表区 -->
    <div class="overflow-y-auto flex-grow space-y-2 p-4 overscroll-contain">
      <!-- 加载中状态 -->
      <div
        v-if="isLoading && filteredHistory.length === 0"
        class="py-8 flex flex-col items-center justify-center text-text-secondary gap-2 text-xs"
      >
        <i class="fas fa-spinner fa-spin text-lg text-primary"></i>
        <span>{{ t('pathHistory.loading', '正在加载历史记录...') }}</span>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="filteredHistory.length === 0"
        class="py-10 text-center text-text-secondary text-xs"
      >
        <i class="fas fa-history text-2xl text-text-secondary/40 block mb-2"></i>
        <span>{{ inputPath.trim() ? t('pathHistory.noMatches', '未找到匹配的历史路径') : t('pathHistory.empty', '暂无访问历史记录') }}</span>
      </div>

      <!-- 历史列表项 -->
      <div
        v-else
        v-for="entry in filteredHistory"
        :key="entry.id"
        class="w-full flex items-center justify-between p-2.5 rounded-xl bg-header/40 border border-border/40 hover:bg-header/70 active:bg-primary/10 transition-colors cursor-pointer"
        @click="handleSelectEntry(entry)"
      >
        <!-- 路径信息 -->
        <div class="min-w-0 flex-1 mr-2 flex items-center gap-2">
          <i class="fas fa-clock text-xs text-text-secondary/60 shrink-0"></i>
          <span class="font-mono text-xs text-foreground truncate select-all">
            {{ entry.path }}
          </span>
        </div>

        <!-- 右侧操作按钮组 -->
        <div class="flex items-center gap-1 shrink-0" @click.stop>
          <!-- 复制按钮 -->
          <button
            type="button"
            @click="handleCopyEntry(entry)"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header active:scale-95 transition-all cursor-pointer"
            :title="t('pathHistory.copy', '复制路径')"
          >
            <i v-if="copiedId !== entry.id" class="far fa-copy text-xs"></i>
            <i v-else class="fas fa-check text-xs text-emerald-500"></i>
          </button>

          <!-- 删除单条按钮 -->
          <button
            type="button"
            @click="handleDeleteEntry(entry)"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-error active:bg-header active:scale-95 transition-all cursor-pointer"
            :title="t('pathHistory.delete', '删除此条历史')"
          >
            <i class="far fa-trash-alt text-xs"></i>
          </button>
        </div>
      </div>
    </div>
  </MobileBottomSheet>
</template>
