<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import { getFileIconClass } from '../utils/fileIcons';
import { formatFileSize, formatFileMode, formatFileDate } from '../utils/fileFormatters';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

const props = defineProps<{
  isVisible: boolean;
  item: FileListItem | null;
  currentPath: string;
  isConnected: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'open-file': [item: FileListItem];
  download: [item: FileListItem];
  rename: [item: FileListItem];
  copy: [item: FileListItem];
  cut: [item: FileListItem];
  delete: [item: FileListItem];
  chmod: [item: FileListItem];
  'cd-terminal': [path: string];
  'download-dir': [item: FileListItem];
}>();

const { t } = useI18n();
const uiNotificationsStore = useUiNotificationsStore();

const isDirectory = computed(() => Boolean(props.item?.attrs.isDirectory));
const isFile = computed(() => Boolean(props.item?.attrs.isFile));
const isSymlink = computed(() => Boolean(props.item?.attrs.isSymbolicLink));

// 计算完整绝对路径
const fullPath = computed(() => {
  if (!props.item) return '';
  const base = props.currentPath.endsWith('/') ? props.currentPath : `${props.currentPath}/`;
  return `${base}${props.item.filename}`;
});

// 复制绝对路径到剪贴板
const copyFullPath = async () => {
  if (!fullPath.value) return;
  try {
    await navigator.clipboard.writeText(fullPath.value);
    uiNotificationsStore.showSuccess(t('common.copied', '已复制完整路径'));
    emit('close');
  } catch (err) {
    uiNotificationsStore.showError(t('common.copyFailed', '复制路径失败'));
  }
};

// 触发条目专属动作
const triggerAction = (actionName: 'open-file' | 'download' | 'rename' | 'copy' | 'cut' | 'delete' | 'chmod' | 'download-dir') => {
  if (!props.item) return;
  const targetItem = props.item;
  emit('close');
  switch (actionName) {
    case 'open-file':
      emit('open-file', targetItem);
      break;
    case 'download':
      emit('download', targetItem);
      break;
    case 'rename':
      emit('rename', targetItem);
      break;
    case 'copy':
      emit('copy', targetItem);
      break;
    case 'cut':
      emit('cut', targetItem);
      break;
    case 'delete':
      emit('delete', targetItem);
      break;
    case 'chmod':
      emit('chmod', targetItem);
      break;
    case 'download-dir':
      emit('download-dir', targetItem);
      break;
  }
};

// 触发在终端中打开
const triggerCdTerminal = () => {
  if (!fullPath.value) return;
  const path = fullPath.value;
  emit('close');
  emit('cd-terminal', path);
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible && item"
        class="fixed inset-0 z-[60] flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="emit('close')"
      >
        <!-- 移动端文件专属 Action Sheet 抽屉 -->
        <div class="w-full bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]">
          <!-- 顶部拖拽手柄指示条 -->
          <div
            class="pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="emit('close')"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶部文件概览卡片 -->
          <div class="px-4 py-3 border-b border-border/40 bg-header/20 flex items-center gap-3">
            <div class="w-12 h-12 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center shrink-0 shadow-2xs">
              <i
                :class="[
                  isDirectory ? 'fas fa-folder text-amber-400 text-2xl' :
                  isSymlink ? 'fas fa-link text-cyan-400 text-2xl' :
                  `${getFileIconClass(item.filename)} text-2xl`
                ]"
              ></i>
            </div>
            <div class="min-w-0 flex-1">
              <h4 class="text-sm font-bold text-foreground break-all line-clamp-1 tracking-tight">
                {{ item.filename }}
              </h4>
              <div class="flex items-center gap-2 text-[11px] text-text-secondary mt-0.5 flex-wrap">
                <span v-if="isFile" class="font-mono">{{ formatFileSize(item.attrs.size) }}</span>
                <span v-else class="text-primary font-medium">文件夹</span>
                <span>•</span>
                <span class="font-mono">{{ formatFileDate(item.attrs.mtime) }}</span>
                <span>•</span>
                <span class="font-mono font-medium">{{ formatFileMode(item.attrs.mode) }}</span>
              </div>
            </div>
          </div>

          <!-- 操作选项网格 (大拇指友好大触控热区) -->
          <div class="p-4 overflow-y-auto space-y-1.5 max-h-[60vh] overscroll-contain">
            <!-- 1. 打开编辑 (仅常规文件) -->
            <button
              v-if="isFile"
              type="button"
              @click="triggerAction('open-file')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center">
                  <i class="fas fa-edit text-xs"></i>
                </div>
                <span class="text-sm font-medium">编辑文件</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 2. 下载文件 / 下载文件夹 -->
            <button
              v-if="isFile"
              type="button"
              @click="triggerAction('download')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                  <i class="fas fa-download text-xs"></i>
                </div>
                <span class="text-sm font-medium">下载文件</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <button
              v-if="isDirectory"
              type="button"
              @click="triggerAction('download-dir')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                  <i class="fas fa-file-archive text-xs"></i>
                </div>
                <span class="text-sm font-medium">打包并下载目录 (ZIP)</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 3. 重命名 -->
            <button
              type="button"
              @click="triggerAction('rename')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
                  <i class="fas fa-signature text-xs"></i>
                </div>
                <span class="text-sm font-medium">重命名</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 4. 复制 -->
            <button
              type="button"
              @click="triggerAction('copy')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                  <i class="fas fa-copy text-xs"></i>
                </div>
                <span class="text-sm font-medium">复制到剪贴板</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 5. 剪切 -->
            <button
              type="button"
              @click="triggerAction('cut')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                  <i class="fas fa-cut text-xs"></i>
                </div>
                <span class="text-sm font-medium">剪切</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 6. 权限修改 (chmod) -->
            <button
              type="button"
              @click="triggerAction('chmod')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-teal-500/10 text-teal-400 flex items-center justify-center">
                  <i class="fas fa-key text-xs"></i>
                </div>
                <span class="text-sm font-medium">更改权限 (chmod)</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 7. 在终端中打开路径 / CD -->
            <button
              type="button"
              @click="triggerCdTerminal"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <i class="fas fa-terminal text-xs"></i>
                </div>
                <span class="text-sm font-medium">在终端切换至此目录</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-text-secondary/40"></i>
            </button>

            <!-- 8. 复制绝对路径 -->
            <button
              type="button"
              @click="copyFullPath"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-header/60 text-text-secondary flex items-center justify-center">
                  <i class="fas fa-link text-xs"></i>
                </div>
                <span class="text-sm font-medium">复制绝对路径</span>
              </div>
              <i class="fas fa-copy text-xs text-text-secondary/40"></i>
            </button>

            <!-- 分割线 -->
            <div class="h-px bg-border/40 my-1"></div>

            <!-- 9. 删除条目 (高危红色) -->
            <button
              type="button"
              @click="triggerAction('delete')"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-rose-500 hover:bg-rose-500/10 active:bg-rose-500/20 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center">
                  <i class="fas fa-trash-alt text-xs"></i>
                </div>
                <span class="text-sm font-medium">删除条目</span>
              </div>
              <i class="fas fa-chevron-right text-xs text-rose-500/40"></i>
            </button>
          </div>

          <!-- 取消大按钮 (单手一键关闭) -->
          <div class="p-4 pt-1 border-t border-border/30 bg-background">
            <button
              type="button"
              @click="emit('close')"
              class="w-full h-11 rounded-xl bg-header/40 border border-border/60 text-foreground font-semibold text-sm hover:bg-header/70 active:scale-[0.99] transition-all cursor-pointer"
            >
              取消
            </button>
            <div class="sheet-safe-bottom"></div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
}
</style>
