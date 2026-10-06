<template>
  <div ref="editorRef" class="codemirror-mobile-editor-container" :style="{ fontSize: currentFontSize + 'px', fontFamily: editorFontFamily }"></div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef, computed } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { useAppearanceStore } from '../stores/appearance.store';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from '@codemirror/search'; // + Import search functionalities

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  language: {
    type: String,
    default: 'plaintext', 
  },
});

const emit = defineEmits(['update:modelValue', 'request-save']);

const appearanceStore = useAppearanceStore();
const editorRef = ref<HTMLDivElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const languageCompartment = new Compartment();
const currentFontSize = ref(appearanceStore.currentMobileEditorFontSize);
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;
let lastPinchDistance = 0;
const debounceTimeout = ref<number | null>(null);
const DEBOUNCE_DELAY = 500; // 500ms 防抖延迟

const editorFontFamily = computed(() => appearanceStore.currentEditorFontFamily);

const getDistance = (touches: TouchList): number => {
  if (touches.length < 2) return 0;
  const touch1 = touches[0];
  const touch2 = touches[1];
  return Math.sqrt(
    Math.pow(touch2.pageX - touch1.pageX, 2) +
    Math.pow(touch2.pageY - touch1.pageY, 2)
  );
};

const onTouchStart = (event: TouchEvent) => {
  if (editorRef.value && editorRef.value.contains(event.target as Node)) {
    if (event.touches.length === 2) {
      event.preventDefault();
      lastPinchDistance = getDistance(event.touches);
    }
  }
};

const debouncedSetMobileEditorFontSize = (size: number) => {
  if (debounceTimeout.value !== null) {
    clearTimeout(debounceTimeout.value);
  }
  debounceTimeout.value = window.setTimeout(() => {
    appearanceStore.setMobileEditorFontSize(size);
  }, DEBOUNCE_DELAY);
};

const onTouchMove = (event: TouchEvent) => {
  if (editorRef.value && editorRef.value.contains(event.target as Node)) {
    if (event.touches.length === 2) {
      event.preventDefault();
      const newPinchDistance = getDistance(event.touches);
      if (lastPinchDistance > 0 && newPinchDistance > 0) {
        const scale = newPinchDistance / lastPinchDistance;
        let newFontSize = currentFontSize.value * scale;
        newFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, newFontSize));
        
        if (Math.abs(currentFontSize.value - newFontSize) > 0.1) { 
            currentFontSize.value = newFontSize;
            debouncedSetMobileEditorFontSize(newFontSize);
        }
      }
      if (newPinchDistance > 0) {
        lastPinchDistance = newPinchDistance;
      } else if (event.touches.length === 2) { 
        lastPinchDistance = getDistance(event.touches);
      }
    }
  }
};

const onTouchEnd = (event: TouchEvent) => {
  if (event.touches.length < 2) {
    lastPinchDistance = 0;
  }
};
const createEditorState = (doc: string, languageExtension: any) => {
  return EditorState.create({
    doc,
    extensions: [
      languageCompartment.of(languageExtension), 
      vscodeDark,
      lineNumbers(), 
      history(),
      highlightActiveLineGutter(),
      foldGutter(), 
      drawSelection(), 
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(), 
      bracketMatching(), 
      highlightActiveLine(),
      closeBrackets(), 
      autocompletion(),
      highlightSelectionMatches(), 
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString());
        }
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap, // + Add search keymap
        { key: "Mod-s", run: () => { emit('request-save'); return true; } }
      ]),
    ],
  });
};

const getLanguageExtension = async (lang: string) => {
  if (lang === 'javascript') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript();
  }
  if (lang === 'css') {
    try {
      const cssModule = await import('@codemirror/lang-css');
      if (cssModule && typeof cssModule.css === 'function') {
        const cssExtension = cssModule.css();
        return cssExtension;
      } else {
        return [];
      }
    } catch (error) {
      return [];
    }
  }
  if (lang === 'html') {
    const { html } = await import('@codemirror/lang-html');
    return html();
  }
  if (lang === 'python') {
    const { python } = await import('@codemirror/lang-python');
    return python();
  }
  if (lang === 'java') {
    const { java } = await import('@codemirror/lang-java');
    return java();
  }
  if (lang === 'cpp') {
    const { cpp } = await import('@codemirror/lang-cpp');
    return cpp();
  }
  if (lang === 'php') {
    const { php } = await import('@codemirror/lang-php');
    return php();
  }
  if (lang === 'go') {
    const { go } = await import('@codemirror/lang-go');
    return go();
  }
  if (lang === 'rust') {
    const { rust } = await import('@codemirror/lang-rust');
    return rust();
  }
  if (lang === 'sql') {
    const { sql } = await import('@codemirror/lang-sql');
    return sql();
  }
  if (lang === 'json') {
    const { json } = await import('@codemirror/lang-json');
    return json();
  }
  if (lang === 'yaml') {
    const { yaml } = await import('@codemirror/lang-yaml');
    return yaml();
  }
  if (lang === 'xml') {
    const { xml } = await import('@codemirror/lang-xml');
    return xml();
  }
  if (lang === 'shell' || lang === 'bash') {
    const { StreamLanguage } = await import('@codemirror/language');
    const { shell } = await import('@codemirror/legacy-modes/mode/shell');
    return StreamLanguage.define(shell);
  }
  if (lang === 'markdown') {
    const { markdown, commonmarkLanguage } = await import('@codemirror/lang-markdown');
    const { GFM } = await import('@lezer/markdown');
    return markdown({
        base: commonmarkLanguage, 
        extensions: GFM 
    });
  }
  if (lang === 'typescript' || lang === 'ts' || lang === 'tsx') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ typescript: true, jsx: true });
  }
  return [];
};


onMounted(async () => {
  // Initialize font size from store
  currentFontSize.value = appearanceStore.currentMobileEditorFontSize;

  if (editorRef.value) {
    const langExt = await getLanguageExtension(props.language);
    console.log('[CodeMirrorMobileEditor DEBUG] onMounted - Initial language:', props.language, 'Fetched langExt:', langExt);
    const startState = createEditorState(props.modelValue, langExt);
    
    view.value = new EditorView({
      state: startState,
      parent: editorRef.value,
    });
    editorRef.value.addEventListener('touchstart', onTouchStart, { passive: false });
    editorRef.value.addEventListener('touchmove', onTouchMove, { passive: false });
    editorRef.value.addEventListener('touchend', onTouchEnd, { passive: false });
  }
});

onBeforeUnmount(() => {
  if (view.value) {
    view.value.destroy();
    view.value = null;
  }
  if (editorRef.value) {
    editorRef.value.removeEventListener('touchstart', onTouchStart);
    editorRef.value.removeEventListener('touchmove', onTouchMove);
    editorRef.value.removeEventListener('touchend', onTouchEnd);
  }
  if (debounceTimeout.value !== null) {
    clearTimeout(debounceTimeout.value);
  }
});

watch(() => props.modelValue, (newValue) => {
  if (view.value && newValue !== view.value.state.doc.toString()) {
    view.value.dispatch({
      changes: { from: 0, to: view.value.state.doc.length, insert: newValue },
    });
  }
});

watch(() => props.language, async (newLanguage, oldLanguage) => {
  if (view.value && newLanguage !== oldLanguage) {
    const langExt = await getLanguageExtension(newLanguage);
    view.value.dispatch({
      effects: languageCompartment.reconfigure(langExt)
    });
  }
});

watch(() => appearanceStore.currentMobileEditorFontSize, (newSize) => {
  if (newSize !== currentFontSize.value) {
    currentFontSize.value = newSize;
  }
});

const openSearch = () => {
  if (view.value) {
    openSearchPanel(view.value);
  }
};

defineExpose({
  focus: () => view.value?.focus(),
  openSearch, // + Expose openSearch method
});

</script>

<style scoped>
.codemirror-mobile-editor-container {
  width: 100%;
  height: 100%;
  min-height: 200px;
  text-align: left;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

.codemirror-mobile-editor-container :deep(.cm-scroller) {
  -webkit-overflow-scrolling: touch;
}

/* 底部防输入法软键盘与手势小白条遮挡的呼吸空间 */
.codemirror-mobile-editor-container :deep(.cm-content) {
  padding-bottom: 80px !important;
}

/* 移动端紧凑行号栏，最大化横向可用字符宽度 */
.codemirror-mobile-editor-container :deep(.cm-gutters) {
  background-color: #1a1a1c !important;
  color: #71717a !important;
  border-right: 1px solid #2e2e32 !important;
}

.codemirror-mobile-editor-container :deep(.cm-lineNumbers .cm-gutterElement) {
  padding: 0 4px 0 3px !important;
  min-width: 22px;
}

.codemirror-mobile-editor-container :deep(.cm-selectionBackground) {
  background-color: #3b82f640 !important;
}
</style>
