<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { marked } from 'marked';

// 配置 marked 解析选项：支持 GitHub Flavored Markdown 和自动换行
marked.setOptions({
  gfm: true,
  breaks: true,
});

const props = withDefaults(
  defineProps<{
    content: string;
    fontSize?: number;
  }>(),
  {
    content: '',
    fontSize: 14,
  }
);

// 防抖实时解析 Markdown HTML
const parsedHtml = ref('');
let debounceTimer: number | null = null;

const renderMarkdown = (rawContent: string) => {
  if (!rawContent || rawContent.trim() === '') {
    parsedHtml.value = '';
    return;
  }
  try {
    const htmlResult = marked.parse(rawContent);
    if (htmlResult instanceof Promise) {
      htmlResult.then(h => { parsedHtml.value = h; });
    } else {
      parsedHtml.value = htmlResult;
    }
  } catch (err) {
    console.error('[MarkdownPreview] 解析 Markdown 出错:', err);
    parsedHtml.value = `<div class="text-red-400 p-4">Markdown 渲染出错: ${err}</div>`;
  }
};

watch(
  () => props.content,
  (newContent) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      renderMarkdown(newContent);
    }, 60); // 60ms 轻量防抖，既实时又保证输入平滑
  },
  { immediate: true }
);

const previewContainerRef = ref<HTMLElement | null>(null);

const emit = defineEmits<{
  (e: 'scroll', payload: { scrollTop: number; scrollHeight: number; clientHeight: number }): void;
}>();

const handleScroll = (event: Event) => {
  const target = event.currentTarget as HTMLElement;
  if (!target) return;
  emit('scroll', {
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
  });
};

const setScrollTop = (top: number) => {
  if (previewContainerRef.value) {
    previewContainerRef.value.scrollTop = top;
  }
};

const getScrollInfo = () => {
  if (!previewContainerRef.value) {
    return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  }
  return {
    scrollTop: previewContainerRef.value.scrollTop,
    scrollHeight: previewContainerRef.value.scrollHeight,
    clientHeight: previewContainerRef.value.clientHeight,
  };
};

defineExpose({
  previewContainerRef,
  setScrollTop,
  getScrollInfo,
});
</script>

<template>
  <div
    ref="previewContainerRef"
    class="markdown-preview-container h-full overflow-y-auto select-text px-6 py-6 font-sans transition-colors duration-150"
    :style="{ fontSize: `${props.fontSize}px` }"
    @scroll="handleScroll"
  >
    <!-- 空文档占位 -->
    <div
      v-if="!parsedHtml"
      class="h-full flex flex-col items-center justify-center text-text-secondary/60 italic text-sm select-none py-12"
    >
      <i class="fab fa-markdown text-4xl mb-3 text-text-secondary/40"></i>
      <span>Markdown 预览区域（暂无内容）</span>
    </div>

    <!-- 渲染后的 HTML 视图 -->
    <div
      v-else
      class="markdown-body"
      v-html="parsedHtml"
    ></div>
  </div>
</template>

<style scoped>
.markdown-preview-container {
  background-color: #1e1e1e;
  color: #d4d4d4;
  line-height: 1.6;
}

/* 自定义优美滚动条 */
.markdown-preview-container::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.markdown-preview-container::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.markdown-preview-container::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.28);
}
.markdown-preview-container::-webkit-scrollbar-track {
  background-color: transparent;
}

/* GitHub Dark 风格精致 Markdown 排版规则 */
:deep(.markdown-body) {
  word-break: break-word;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4),
:deep(.markdown-body h5),
:deep(.markdown-body h6) {
  margin-top: 1.4em;
  margin-bottom: 0.6em;
  font-weight: 600;
  line-height: 1.25;
  color: #ffffff;
}

:deep(.markdown-body h1:first-child),
:deep(.markdown-body h2:first-child),
:deep(.markdown-body h3:first-child) {
  margin-top: 0;
}

:deep(.markdown-body h1) {
  font-size: 1.85em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
}

:deep(.markdown-body h2) {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

:deep(.markdown-body h3) {
  font-size: 1.25em;
}

:deep(.markdown-body h4) {
  font-size: 1.1em;
}

:deep(.markdown-body p) {
  margin-top: 0;
  margin-bottom: 1em;
  line-height: 1.65;
}

:deep(.markdown-body blockquote) {
  margin: 1em 0;
  padding: 0.5em 1em;
  color: #9ca3af;
  border-left: 4px solid var(--color-primary, #3b82f6);
  background-color: rgba(255, 255, 255, 0.03);
  border-radius: 0 4px 4px 0;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  margin-top: 0;
  margin-bottom: 1em;
  padding-left: 2em;
}

:deep(.markdown-body ul) {
  list-style-type: disc;
}

:deep(.markdown-body ol) {
  list-style-type: decimal;
}

:deep(.markdown-body li) {
  margin-top: 0.25em;
  margin-bottom: 0.25em;
}

:deep(.markdown-body li > ul),
:deep(.markdown-body li > ol) {
  margin-top: 0.25em;
  margin-bottom: 0.25em;
}

:deep(.markdown-body hr) {
  height: 1px;
  padding: 0;
  margin: 1.5em 0;
  background-color: rgba(255, 255, 255, 0.15);
  border: 0;
}

:deep(.markdown-body a) {
  color: var(--color-primary, #60a5fa);
  text-decoration: none;
}

:deep(.markdown-body a:hover) {
  text-decoration: underline;
}

:deep(.markdown-body strong) {
  font-weight: 600;
  color: #ffffff;
}

:deep(.markdown-body em) {
  font-style: italic;
}

:deep(.markdown-body del) {
  text-decoration: line-through;
  opacity: 0.7;
}

/* 行内代码 */
:deep(.markdown-body code:not(pre code)) {
  padding: 0.2em 0.45em;
  margin: 0 0.2em;
  font-size: 0.88em;
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: #f87171;
}

/* 独立代码块 */
:deep(.markdown-body pre) {
  margin-top: 0.8em;
  margin-bottom: 1.2em;
  padding: 1em;
  overflow-x: auto;
  font-size: 0.9em;
  line-height: 1.45;
  background-color: #181818;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
}

:deep(.markdown-body pre code) {
  display: block;
  padding: 0;
  font-size: 100%;
  color: #e5e7eb;
  background-color: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  word-break: normal;
  white-space: pre;
}

/* 表格样式 */
:deep(.markdown-body table) {
  width: 100%;
  margin-top: 0.8em;
  margin-bottom: 1.2em;
  border-collapse: collapse;
  overflow-x: auto;
  display: block;
}

:deep(.markdown-body th),
:deep(.markdown-body td) {
  padding: 0.6em 1em;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

:deep(.markdown-body th) {
  font-weight: 600;
  background-color: rgba(255, 255, 255, 0.07);
  color: #ffffff;
}

:deep(.markdown-body tr:nth-child(2n)) {
  background-color: rgba(255, 255, 255, 0.02);
}

/* 任务列表 checkbox */
:deep(.markdown-body input[type="checkbox"]) {
  margin-right: 0.5em;
  vertical-align: middle;
  accent-color: var(--color-primary, #3b82f6);
}

/* 图片展示 */
:deep(.markdown-body img) {
  max-width: 100%;
  border-radius: 6px;
  margin: 0.8em 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
</style>
