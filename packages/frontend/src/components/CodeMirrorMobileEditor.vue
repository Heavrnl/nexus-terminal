<template>
  <div class="codemirror-mobile-editor-container flex flex-col w-full h-full relative overflow-hidden">
    <!-- 移动端专属优雅搜索控制台 -->
    <transition name="slide-down">
      <div v-if="isSearchOpen" class="mobile-search-panel" @click.stop>
        <!-- 搜索主行 -->
        <div class="search-main-row flex items-center gap-1.5 w-full">
          <!-- 展开/折叠替换按钮 -->
          <button
            class="search-tool-btn replace-toggle-btn"
            :class="{ 'is-active': showReplace }"
            :title="showReplace ? '收起替换' : '展开替换'"
            @click="showReplace = !showReplace"
          >
            <i class="fas fa-chevron-right text-[11px] transition-transform duration-150" :class="{ 'rotate-90': showReplace }"></i>
          </button>

          <!-- 搜索输入框包裹器 -->
          <div class="search-input-wrapper flex-1 relative flex items-center">
            <i class="fas fa-search search-input-icon text-muted-foreground text-xs pointer-events-none"></i>
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              class="search-input"
              placeholder="搜索..."
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              @input="handleSearchInput"
              @keydown="handleSearchKeydown"
            />
            <!-- 清空按钮 -->
            <button
              v-if="searchQuery"
              class="clear-query-btn"
              title="清空"
              @click="clearSearch"
            >
              <i class="fas fa-times-circle text-xs"></i>
            </button>
            <!-- 匹配结果计数 -->
            <span v-if="searchQuery" class="match-count-badge">
              {{ totalMatches > 0 ? `${matchIndex}/${totalMatches}` : '0/0' }}
            </span>
          </div>

          <!-- 模式切换按钮 (区分大小写、全词、正则) -->
          <div class="search-options-group flex items-center gap-0.5">
            <button
              class="search-tool-btn option-btn"
              :class="{ 'is-active': caseSensitive }"
              title="区分大小写"
              @click="toggleCaseSensitive"
            >
              <span class="text-xs font-semibold">Aa</span>
            </button>
            <button
              class="search-tool-btn option-btn"
              :class="{ 'is-active': matchWholeWord }"
              title="全词匹配"
              @click="toggleWholeWord"
            >
              <span class="text-xs font-semibold">\b</span>
            </button>
            <button
              class="search-tool-btn option-btn"
              :class="{ 'is-active': isRegex }"
              title="正则表达式"
              @click="toggleRegex"
            >
              <span class="text-xs font-semibold">.*</span>
            </button>
          </div>

          <!-- 导航与关闭按钮 -->
          <div class="search-nav-group flex items-center gap-0.5">
            <button
              class="search-tool-btn nav-btn"
              :disabled="totalMatches === 0"
              title="上一个 (Shift+Enter)"
              @click="handlePrev"
            >
              <i class="fas fa-arrow-up text-xs"></i>
            </button>
            <button
              class="search-tool-btn nav-btn"
              :disabled="totalMatches === 0"
              title="下一个 (Enter)"
              @click="handleNext"
            >
              <i class="fas fa-arrow-down text-xs"></i>
            </button>
            <button
              class="search-tool-btn close-btn"
              title="关闭 (Esc)"
              @click="closeSearch"
            >
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        </div>

        <!-- 替换扩展行 (点击左侧替换箭头后展开) -->
        <transition name="fade">
          <div v-if="showReplace" class="replace-row flex items-center gap-1.5 w-full mt-1.5 pt-1.5 border-t border-border/30">
            <div class="search-input-wrapper flex-1 relative flex items-center">
              <i class="fas fa-exchange-alt search-input-icon text-muted-foreground text-xs pointer-events-none"></i>
              <input
                v-model="replaceQuery"
                type="text"
                class="search-input"
                placeholder="替换为..."
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                @keydown.enter="handleReplace"
              />
              <button
                v-if="replaceQuery"
                class="clear-query-btn"
                title="清空"
                @click="replaceQuery = ''"
              >
                <i class="fas fa-times-circle text-xs"></i>
              </button>
            </div>

            <div class="replace-actions-group flex items-center gap-1">
              <button
                class="replace-action-btn"
                :disabled="totalMatches === 0"
                title="替换当前匹配项"
                @click="handleReplace"
              >
                <span>替换</span>
              </button>
              <button
                class="replace-action-btn"
                :disabled="totalMatches === 0"
                title="替换所有匹配项"
                @click="handleReplaceAll"
              >
                <span>全部</span>
              </button>
            </div>
          </div>
        </transition>
      </div>
    </transition>

    <!-- CodeMirror 实际编辑器挂载节点 -->
    <div
      ref="editorRef"
      class="cm-editor-view-host flex-1 w-full min-h-0 overflow-auto"
      :style="{ fontSize: currentFontSize + 'px', fontFamily: editorFontFamily }"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef, computed, nextTick } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { useAppearanceStore } from '../stores/appearance.store';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  search,
  highlightSelectionMatches,
  searchKeymap,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search';

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
      search({ top: true }),
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
        ...searchKeymap,
        { key: "Mod-f", run: () => { openSearch(); return true; } },
        { key: "Escape", run: () => { if (isSearchOpen.value) { closeSearch(); return true; } return false; } },
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

// --- 移动端搜索核心状态与交互逻辑 ---
const searchInputRef = ref<HTMLInputElement | null>(null);
const isSearchOpen = ref(false);
const searchQuery = ref('');
const replaceQuery = ref('');
const showReplace = ref(false);
const caseSensitive = ref(false);
const isRegex = ref(false);
const matchWholeWord = ref(false);
const totalMatches = ref(0);
const matchIndex = ref(0);

// 构建当前 SearchQuery
const buildCurrentQuery = (customSearch?: string): SearchQuery | null => {
  const text = customSearch !== undefined ? customSearch : searchQuery.value;
  if (!text) return null;
  try {
    return new SearchQuery({
      search: text,
      replace: replaceQuery.value,
      caseSensitive: caseSensitive.value,
      regexp: isRegex.value,
      wholeWord: matchWholeWord.value,
    });
  } catch (err) {
    // 正则表达式错误等情况防御
    return null;
  }
};

// 计算总匹配数量及当前光标所在序号
const updateMatchCounts = (customQuery?: SearchQuery | null) => {
  if (!view.value) return;
  const q = customQuery !== undefined ? customQuery : buildCurrentQuery();
  if (!q || !q.search) {
    totalMatches.value = 0;
    matchIndex.value = 0;
    return;
  }

  try {
    const cursor = q.getCursor(view.value.state);
    let count = 0;
    let activeIdx = 0;
    const currentSelection = view.value.state.selection.main;
    const currentFrom = currentSelection.from;
    const currentTo = currentSelection.to;

    let item = cursor.next();
    while (!item.done && item.value) {
      count++;
      if (item.value.from === currentFrom && item.value.to === currentTo) {
        activeIdx = count;
      } else if (!activeIdx && item.value.from >= currentFrom) {
        activeIdx = count;
      }
      item = cursor.next();
    }
    totalMatches.value = count;
    matchIndex.value = count > 0 ? (activeIdx > 0 ? activeIdx : 1) : 0;
  } catch (err) {
    totalMatches.value = 0;
    matchIndex.value = 0;
  }
};

// 执行搜索更新并同步至 CodeMirror
const applySearch = () => {
  if (!view.value) return;
  const q = buildCurrentQuery();
  if (!q) {
    view.value.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: '' })),
    });
    totalMatches.value = 0;
    matchIndex.value = 0;
    return;
  }

  view.value.dispatch({
    effects: setSearchQuery.of(q),
  });
  updateMatchCounts(q);
};

const handleSearchInput = () => {
  applySearch();
};

const handleSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) {
      handlePrev();
    } else {
      handleNext();
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
  }
};

const handleNext = () => {
  if (!view.value) return;
  findNext(view.value);
  updateMatchCounts();
};

const handlePrev = () => {
  if (!view.value) return;
  findPrevious(view.value);
  updateMatchCounts();
};

const handleReplace = () => {
  if (!view.value) return;
  replaceNext(view.value);
  updateMatchCounts();
};

const handleReplaceAll = () => {
  if (!view.value) return;
  replaceAll(view.value);
  updateMatchCounts();
};

const toggleCaseSensitive = () => {
  caseSensitive.value = !caseSensitive.value;
  applySearch();
};

const toggleRegex = () => {
  isRegex.value = !isRegex.value;
  applySearch();
};

const toggleWholeWord = () => {
  matchWholeWord.value = !matchWholeWord.value;
  applySearch();
};

const clearSearch = () => {
  searchQuery.value = '';
  applySearch();
  searchInputRef.value?.focus();
};

const openSearch = () => {
  isSearchOpen.value = true;
  nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
  if (searchQuery.value) {
    applySearch();
  }
};

const closeSearch = () => {
  isSearchOpen.value = false;
  if (view.value) {
    view.value.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: '' })),
    });
    view.value.focus();
  }
  totalMatches.value = 0;
  matchIndex.value = 0;
};

const toggleSearch = () => {
  if (isSearchOpen.value) {
    closeSearch();
  } else {
    openSearch();
  }
};

defineExpose({
  focus: () => view.value?.focus(),
  openSearch,
  closeSearch,
  toggleSearch,
});

</script>

<style scoped>
.codemirror-mobile-editor-container {
  width: 100%;
  height: 100%;
  min-height: 200px;
  text-align: left;
  background-color: #1e1e1e;
}

/* 移动端专属悬浮搜索栏样式 */
.mobile-search-panel {
  flex-shrink: 0;
  width: 100%;
  padding: 8px 10px;
  background-color: #1a1a1e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  z-index: 30;
}

.search-input-wrapper {
  position: relative;
  background-color: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  padding: 0 8px 0 26px;
  height: 32px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.search-input-wrapper:focus-within {
  border-color: var(--primary-color, #38bdf8);
  box-shadow: 0 0 0 1px var(--primary-color, #38bdf8);
}

.search-input-icon {
  position: absolute;
  left: 8px;
}

.search-input {
  width: 100%;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: #f3f4f6;
  font-size: 13px;
  line-height: 1;
}

.clear-query-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  padding: 0 4px;
  border: none;
  background: transparent;
  cursor: pointer;
}

.clear-query-btn:active {
  color: #ffffff;
}

.match-count-badge {
  font-size: 11px;
  font-weight: 500;
  color: #9ca3af;
  margin-left: 4px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.search-tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 4px;
  border-radius: 4px;
  background-color: transparent;
  color: #9ca3af;
  border: none;
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 0.15s ease, color 0.15s ease;
  user-select: none;
}

.search-tool-btn:active:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.search-tool-btn.is-active {
  background-color: rgba(56, 189, 248, 0.2);
  color: var(--primary-color, #38bdf8);
  font-weight: 600;
}

.search-tool-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.replace-action-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e5e7eb;
  touch-action: manipulation;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.replace-action-btn:active:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.24);
}

.replace-action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 动效 */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(-8px);
  opacity: 0;
}

.cm-editor-view-host {
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}

.cm-editor-view-host :deep(.cm-editor) {
  height: 100%;
}

.cm-editor-view-host :deep(.cm-scroller) {
  -webkit-overflow-scrolling: touch;
}

/* 底部防输入法软键盘与手势小白条遮挡的呼吸空间 */
.cm-editor-view-host :deep(.cm-content) {
  padding-bottom: 80px !important;
}

/* 移动端紧凑行号栏，最大化横向可用字符宽度 */
.cm-editor-view-host :deep(.cm-gutters) {
  background-color: #1a1a1c !important;
  color: #71717a !important;
  border-right: 1px solid #2e2e32 !important;
}

.cm-editor-view-host :deep(.cm-lineNumbers .cm-gutterElement) {
  padding: 0 4px 0 3px !important;
  min-width: 22px;
}

.cm-editor-view-host :deep(.cm-selectionBackground) {
  background-color: #3b82f640 !important;
}

/* CodeMirror 搜索匹配高亮视觉适配 */
.cm-editor-view-host :deep(.cm-searchMatch) {
  background-color: rgba(234, 179, 8, 0.35) !important;
  border-radius: 2px;
}

.cm-editor-view-host :deep(.cm-searchMatch-selected) {
  background-color: rgba(249, 115, 22, 0.75) !important;
  outline: 1px solid rgba(251, 146, 60, 0.9);
  border-radius: 2px;
}
</style>
