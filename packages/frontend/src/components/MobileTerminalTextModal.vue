<script setup lang="ts">
import { ref, watch, computed, nextTick, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore();
const { activeSessionId } = storeToRefs(sessionStore);
const { terminalNoWrapBoolean } = storeToRefs(settingsStore);

const terminalText = ref('');
const lineCount = ref(0);
const textContainerRef = ref<HTMLDivElement | null>(null);

// 搜索栏状态
const searchQuery = ref('');
const isCaseSensitive = ref(false);
const isRegex = ref(false);
const currentMatchIndex = ref(0);
const regexError = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);

interface TextMatch {
  start: number;
  end: number;
  text: string;
}

const matches = ref<TextMatch[]>([]);

// HTML 字符实体安全转义
const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// 正则特殊字符安全转义
const escapeRegex = (text: string): string => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// 从当前活动会话的 xterm.js 实例中提取所有缓冲区纯文本
const extractTerminalText = () => {
  if (!activeSessionId.value) {
    terminalText.value = '';
    lineCount.value = 0;
    return;
  }

  const session = sessionStore.sessions.get(activeSessionId.value);
  const term = session?.terminalManager?.terminalInstance?.value;

  if (!term || !term.buffer?.active) {
    terminalText.value = '';
    lineCount.value = 0;
    return;
  }

  const buffer = term.buffer.active;
  const totalLength = buffer.length;
  const lines: string[] = [];

  for (let i = 0; i < totalLength; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  // 去除末尾大量无效空行
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  terminalText.value = lines.join('\n');
  lineCount.value = lines.length;
};

// 计算搜索匹配项
const computeMatches = () => {
  const query = searchQuery.value;
  regexError.value = false;

  if (!query) {
    matches.value = [];
    currentMatchIndex.value = 0;
    return;
  }

  let pattern = query;
  if (!isRegex.value) {
    pattern = escapeRegex(query);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, isCaseSensitive.value ? 'g' : 'gi');
  } catch {
    regexError.value = true;
    matches.value = [];
    currentMatchIndex.value = 0;
    return;
  }

  const raw = terminalText.value;
  const list: TextMatch[] = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(raw)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    list.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
    });
    // 防止灾难性回溯或海量匹配卡顿
    if (list.length >= 2500) break;
  }

  matches.value = list;
  if (list.length === 0) {
    currentMatchIndex.value = 0;
  } else if (currentMatchIndex.value >= list.length) {
    currentMatchIndex.value = 0;
  }
};

// 生成带高亮标记的 HTML 内容（保持极高性能并兼容原生长按划选复制）
const highlightedHtml = computed(() => {
  const raw = terminalText.value;
  if (!raw) return '';
  if (matches.value.length === 0) {
    return escapeHtml(raw);
  }

  const list = matches.value;
  const currIdx = currentMatchIndex.value;
  let lastIndex = 0;
  let html = '';

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const before = raw.slice(lastIndex, item.start);
    html += escapeHtml(before);

    const isCurrent = i === currIdx;
    const markClass = isCurrent
      ? 'bg-amber-400 text-black font-semibold ring-2 ring-amber-300 rounded-xs px-0.5 shadow-sm'
      : 'bg-yellow-500/35 text-amber-200 rounded-xs px-0.5';

    html += `<mark id="terminal-match-${i}" class="${markClass}">${escapeHtml(item.text)}</mark>`;
    lastIndex = item.end;
  }

  html += escapeHtml(raw.slice(lastIndex));
  return html;
});

// 平滑滚动定位至当前选中的匹配高亮项
const scrollToCurrentMatch = () => {
  nextTick(() => {
    if (matches.value.length === 0) return;
    const targetEl = textContainerRef.value?.querySelector(`#terminal-match-${currentMatchIndex.value}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
};

const goToPrevMatch = () => {
  if (matches.value.length === 0) return;
  currentMatchIndex.value = (currentMatchIndex.value - 1 + matches.value.length) % matches.value.length;
  scrollToCurrentMatch();
};

const goToNextMatch = () => {
  if (matches.value.length === 0) return;
  currentMatchIndex.value = (currentMatchIndex.value + 1) % matches.value.length;
  scrollToCurrentMatch();
};

const toggleCaseSensitive = () => {
  isCaseSensitive.value = !isCaseSensitive.value;
  computeMatches();
  scrollToCurrentMatch();
};

const toggleRegex = () => {
  isRegex.value = !isRegex.value;
  computeMatches();
  scrollToCurrentMatch();
};

const clearSearch = () => {
  searchQuery.value = '';
  matches.value = [];
  currentMatchIndex.value = 0;
  regexError.value = false;
  searchInputRef.value?.focus();
};

const handleSearchInput = () => {
  computeMatches();
  if (matches.value.length > 0) {
    currentMatchIndex.value = 0;
    scrollToCurrentMatch();
  }
};

const handleSearchKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      goToPrevMatch();
    } else {
      goToNextMatch();
    }
  } else if (e.key === 'Escape') {
    if (searchQuery.value) {
      e.stopPropagation();
      clearSearch();
    }
  }
};

const closeModal = () => {
  emit('close');
};

// 全局 Esc 快捷关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !searchQuery.value) {
    closeModal();
  }
};

const isTextReady = ref(false);

watch(
  () => props.isVisible,
  (val) => {
    if (val) {
      isTextReady.value = false;
      document.addEventListener('keydown', handleKeydown);
      extractTerminalText();
      computeMatches();
      // 在 DOM 挂载后立即将滚动条钉在底部，杜绝从顶部跳跃到底部的闪烁
      nextTick(() => {
        if (textContainerRef.value && !searchQuery.value) {
          textContainerRef.value.scrollTop = textContainerRef.value.scrollHeight;
        } else if (searchQuery.value && matches.value.length > 0) {
          scrollToCurrentMatch();
        }
        // 双重 rAF 确保浏览器首帧布局 Paint 发生在目标位置后，再无感展现
        requestAnimationFrame(() => {
          if (textContainerRef.value && !searchQuery.value) {
            textContainerRef.value.scrollTop = textContainerRef.value.scrollHeight;
          }
          isTextReady.value = true;
        });
      });
    } else {
      document.removeEventListener('keydown', handleKeydown);
      isTextReady.value = false;
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <!-- 1. 独立全屏遮罩 (纯透明度淡入淡出，绝对独立，绝无包含块与位移冲突) -->
    <Transition name="sheet-mask-fade">
      <div
        v-if="isVisible"
        class="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs select-none"
        @click="closeModal"
      />
    </Transition>

    <!-- 2. 独立底部滑出抽屉 (自身负责滑动，直接定位，Vue原生侦测动画生命周期) -->
    <Transition name="sheet-panel-slide">
      <div
        v-if="isVisible"
        class="fixed bottom-0 left-0 right-0 z-50 mobile-text-sheet w-full h-[82dvh] max-h-[88vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        <!-- 顶部拖拽手柄与点击快速收起指示条 -->
        <div
          class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
          @click="closeModal"
          title="点击收起"
        >
          <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
        </div>

        <!-- 顶栏标题与关闭操作 -->
        <div class="sheet-header flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <i class="fas fa-copy text-sm"></i>
            </div>
            <h3 class="text-base font-semibold text-foreground tracking-tight">
              {{ t('terminal.bufferText.title', '终端复制') }}
            </h3>
            <span
              v-if="lineCount > 0"
              class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-border/40 text-text-secondary"
            >
              {{ lineCount }} {{ t('terminal.bufferText.lines', '行') }}
            </span>
          </div>

          <!-- 收起关闭按钮 -->
          <button
            type="button"
            @click="closeModal"
            class="w-8 h-8 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
            :title="t('close', '收起')"
          >
            <i class="fas fa-times text-base"></i>
          </button>
        </div>

        <!-- 原生 HTML 文本内容区域（原生支持长按水滴选择、全选、复制手势） -->
        <div
          ref="textContainerRef"
          class="flex-grow min-h-0 overflow-y-auto overscroll-contain px-4 py-3 bg-zinc-950/70 [scrollbar-width:thin] transition-opacity duration-150"
          :class="{ 'opacity-0': !isTextReady, 'opacity-100': isTextReady }"
        >
            <!-- 文本展示区（v-html 支持搜索高亮渲染，长按直接调动系统水滴划选与系统复制） -->
            <pre
              v-if="terminalText"
              class="font-mono text-[12.5px] leading-relaxed text-zinc-200 select-text selection:bg-primary/40 selection:text-white"
              :class="terminalNoWrapBoolean ? 'whitespace-pre min-w-max' : 'whitespace-pre-wrap break-words'"
            ><code v-html="highlightedHtml"></code></pre>

            <!-- 空白状态提示 -->
            <div
              v-else
              class="h-full py-20 flex flex-col items-center justify-center gap-2.5 text-text-secondary"
            >
              <div class="w-12 h-12 rounded-2xl bg-header/40 border border-border/50 flex items-center justify-center text-text-secondary/60 text-xl">
                <i class="fas fa-terminal"></i>
              </div>
              <p class="text-xs font-medium text-foreground/70">
                {{ t('terminal.bufferText.empty', '当前终端暂无输出内容') }}
              </p>
            </div>
          </div>

          <!-- 底部专属搜索栏 -->
          <div class="sheet-search-bar px-3 py-2 bg-header/95 border-t border-border/80 flex items-center gap-1.5 shrink-0 select-none pb-safe">
            <!-- 搜索输入框与清除按钮 -->
            <div class="relative flex-1 flex items-center min-w-0">
              <i class="fas fa-search absolute left-2.5 text-xs text-text-secondary pointer-events-none"></i>
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                type="text"
                :placeholder="t('terminal.bufferText.searchPlaceholder', '在终端输出中搜索...')"
                class="w-full h-8 pl-7 pr-7 rounded-lg bg-background/80 border text-xs text-foreground placeholder:text-text-secondary/60 focus:outline-none transition-colors"
                :class="regexError ? 'border-red-500/80 focus:border-red-500' : 'border-border/70 focus:border-primary/80'"
                @input="handleSearchInput"
                @keydown="handleSearchKeydown"
              />
              <button
                v-if="searchQuery"
                @click="clearSearch"
                type="button"
                class="absolute right-2 text-text-secondary hover:text-foreground text-xs p-0.5 active:scale-90 transition-transform"
              >
                <i class="fas fa-times-circle"></i>
              </button>
            </div>

            <!-- 匹配计数器 -->
            <div
              v-if="searchQuery"
              class="text-[11px] font-mono px-1 py-0.5 rounded text-text-secondary whitespace-nowrap shrink-0"
              :class="regexError ? 'text-red-400 font-medium' : ''"
            >
              <span v-if="regexError">{{ t('terminal.bufferText.regexError', '正则错误') }}</span>
              <span v-else-if="matches.length > 0">{{ currentMatchIndex + 1 }}/{{ matches.length }}</span>
              <span v-else class="text-text-secondary/60">0/0</span>
            </div>

            <!-- 上一个 / 下一个导航箭头 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="goToPrevMatch"
                :disabled="matches.length === 0"
                class="w-7 h-7 flex items-center justify-center rounded-md border border-border/60 bg-background/50 text-text-secondary hover:text-foreground hover:bg-border/30 disabled:opacity-35 disabled:pointer-events-none active:scale-95 transition-all cursor-pointer"
                :title="t('terminal.bufferText.prevMatch', '上一个 (Shift+Enter)')"
              >
                <i class="fas fa-chevron-up text-xs"></i>
              </button>
              <button
                type="button"
                @click="goToNextMatch"
                :disabled="matches.length === 0"
                class="w-7 h-7 flex items-center justify-center rounded-md border border-border/60 bg-background/50 text-text-secondary hover:text-foreground hover:bg-border/30 disabled:opacity-35 disabled:pointer-events-none active:scale-95 transition-all cursor-pointer"
                :title="t('terminal.bufferText.nextMatch', '下一个 (Enter)')"
              >
                <i class="fas fa-chevron-down text-xs"></i>
              </button>
            </div>

            <!-- 选项开关组：大小写敏感(Aa)与正则表达式(.*) -->
            <div class="flex items-center gap-1 shrink-0">
              <!-- 大小写敏感切换 -->
              <button
                type="button"
                @click="toggleCaseSensitive"
                class="w-7 h-7 flex items-center justify-center rounded-md border text-xs font-semibold tracking-tighter active:scale-95 transition-all cursor-pointer"
                :class="isCaseSensitive
                  ? 'bg-primary/20 border-primary/60 text-primary'
                  : 'border-border/60 bg-background/50 text-text-secondary hover:text-foreground hover:bg-border/30'"
                :title="t('terminal.bufferText.matchCase', '区分大小写')"
              >
                Aa
              </button>

              <!-- 正则表达式切换 -->
              <button
                type="button"
                @click="toggleRegex"
                class="w-7 h-7 flex items-center justify-center rounded-md border text-xs font-mono font-bold active:scale-95 transition-all cursor-pointer"
                :class="isRegex
                  ? 'bg-primary/20 border-primary/60 text-primary'
                  : 'border-border/60 bg-background/50 text-text-secondary hover:text-foreground hover:bg-border/30'"
                :title="t('terminal.bufferText.useRegex', '使用正则表达式')"
              >
                .*
              </button>
            </div>
          </div>
        </div>
      </Transition>
  </Teleport>
</template>

<style scoped>
/* 允许代码块及高亮内部自由进行原生文本划选与长按选择 */
pre, code, mark {
  user-select: text !important;
  -webkit-user-select: text !important;
}

mark {
  transition: background-color 0.15s ease, color 0.15s ease;
}

/* 1. 遮罩层纯透明度淡入淡出动效 (绝无位移与重排，避免背景闪烁) */
.sheet-mask-fade-enter-active,
.sheet-mask-fade-leave-active {
  transition: opacity 0.24s ease;
}

.sheet-mask-fade-enter-from,
.sheet-mask-fade-leave-to {
  opacity: 0;
}

/* 2. 抽屉面板平滑滑动动效 (直接由抽屉自身承载transform，Vue原生侦测事件结束) */
.sheet-panel-slide-enter-active {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform;
}

.sheet-panel-slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
  will-change: transform;
}

.sheet-panel-slide-enter-from,
.sheet-panel-slide-leave-to {
  transform: translateY(100%);
}
</style>
