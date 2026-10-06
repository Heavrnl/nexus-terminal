<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const { activeSessionId } = storeToRefs(sessionStore);

const terminalText = ref('');
const lineCount = ref(0);
const textContainerRef = ref<HTMLDivElement | null>(null);

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

const closeModal = () => {
  emit('close');
};

// 键盘 Esc 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    closeModal();
  }
};

watch(
  () => props.isVisible,
  (val) => {
    if (val) {
      document.addEventListener('keydown', handleKeydown);
      extractTerminalText();
      // 打开时自动平滑滚动到底部，展现最新终端输出
      nextTick(() => {
        if (textContainerRef.value) {
          textContainerRef.value.scrollTop = textContainerRef.value.scrollHeight;
        }
      });
    } else {
      document.removeEventListener('keydown', handleKeydown);
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
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="bottom-sheet-overlay fixed inset-0 z-50 flex flex-col justify-end bg-black/65 backdrop-blur-xs select-none"
        @click.self="closeModal"
      >
        <!-- 移动端原生文本提取抽屉 (Bottom Sheet) -->
        <div
          class="mobile-text-sheet w-full h-[78vh] max-h-[85vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
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
            class="flex-grow min-h-0 overflow-y-auto overscroll-contain px-4 py-3 bg-zinc-950/70 [scrollbar-width:thin]"
          >
            <!-- 文本展示区 -->
            <pre
              v-if="terminalText"
              class="font-mono text-[12.5px] leading-relaxed text-zinc-200 select-text whitespace-pre-wrap break-words selection:bg-primary/40 selection:text-white"
            ><code>{{ terminalText }}</code></pre>

            <!-- 空白状态提示 -->
            <div
              v-else
              class="h-full py-20 flex flex-col items-center justify-center gap-2.5 text-text-secondary"
            >
              <div class="w-12 h-12 rounded-2xl bg-header/40 border border-border/50 flex items-center justify-center text-text-secondary/60 text-xl">
                <i class="fas fa-terminal"></i>
              </div>
              <p class="text-xs font-medium text-foreground/70">
                {{ t('terminal.bufferText.empty', '当前终端暂无输出文本') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 允许代码块内部自由进行原生文本划选与长按选择 */
pre, code {
  user-select: text !important;
  -webkit-user-select: text !important;
}

.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

.bottom-sheet-enter-active .mobile-text-sheet,
.bottom-sheet-leave-active .mobile-text-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from .mobile-text-sheet,
.bottom-sheet-leave-to .mobile-text-sheet {
  transform: translateY(100%);
}
</style>
