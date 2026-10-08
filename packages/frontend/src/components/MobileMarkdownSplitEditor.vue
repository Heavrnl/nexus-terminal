<script setup lang="ts">
import { ref } from 'vue';
import CodeMirrorMobileEditor from './CodeMirrorMobileEditor.vue';
import MarkdownPreview from './MarkdownPreview.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: string;
    fontSize?: number;
    viewMode?: 'split' | 'edit' | 'preview';
  }>(),
  {
    modelValue: '',
    language: 'markdown',
    fontSize: 14,
    viewMode: 'edit',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'request-save'): void;
}>();

const codeMirrorMobileEditorRef = ref<InstanceType<typeof CodeMirrorMobileEditor> | null>(null);
const markdownPreviewRef = ref<InstanceType<typeof MarkdownPreview> | null>(null);

defineExpose({
  focus: () => {
    codeMirrorMobileEditorRef.value?.focus?.();
  },
  setScrollTop: (top: number) => {
    codeMirrorMobileEditorRef.value?.setScrollTop?.(top);
  },
  getScrollInfo: () => {
    return codeMirrorMobileEditorRef.value?.getScrollInfo?.() ?? { scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0 };
  },
  openSearch: () => {
    codeMirrorMobileEditorRef.value?.openSearch?.();
  },
  toggleSearch: () => {
    codeMirrorMobileEditorRef.value?.toggleSearch?.();
  },
});
</script>

<template>
  <div class="mobile-markdown-editor-root w-full h-full flex flex-col overflow-hidden">
    <!-- 1. 纯代码编辑模式 (移动端默认或切到 edit 时) -->
    <div v-if="props.viewMode === 'edit'" class="flex-grow w-full h-full overflow-hidden">
      <CodeMirrorMobileEditor
        ref="codeMirrorMobileEditorRef"
        :model-value="props.modelValue"
        :language="props.language"
        class="h-full w-full"
        @update:model-value="(val) => emit('update:modelValue', val)"
        @request-save="emit('request-save')"
      />
    </div>

    <!-- 2. 纯预览模式 -->
    <div v-else-if="props.viewMode === 'preview'" class="markdown-full-preview flex-grow w-full h-full overflow-y-auto p-3">
      <MarkdownPreview :content="props.modelValue" :font-size="props.fontSize" />
    </div>

    <!-- 3. 上下或紧凑分屏模式 (移动端视口下的回退模式) -->
    <div v-else class="mobile-split-container flex-grow w-full h-full flex flex-col overflow-hidden">
      <div class="h-1/2 w-full border-b border-border/50 overflow-hidden">
        <CodeMirrorMobileEditor
          ref="codeMirrorMobileEditorRef"
          :model-value="props.modelValue"
          :language="props.language"
          class="h-full w-full"
          @update:model-value="(val) => emit('update:modelValue', val)"
          @request-save="emit('request-save')"
        />
      </div>
      <div class="h-1/2 w-full overflow-y-auto p-2">
        <MarkdownPreview :content="props.modelValue" :font-size="props.fontSize" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mobile-markdown-editor-root {
  background-color: var(--nexus-bg-primary, #1e1e1e);
}
</style>
