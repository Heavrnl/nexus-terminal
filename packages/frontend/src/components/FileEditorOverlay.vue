<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'; // + nextTick
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import MonacoEditor from './MonacoEditor.vue';
import CodeMirrorMobileEditor from './CodeMirrorMobileEditor.vue'; // +++ Import new mobile editor
import FileEditorTabs from './FileEditorTabs.vue';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSessionStore } from '../stores/session.store';
import { useAppearanceStore } from '../stores/appearance.store';


const { t } = useI18n();
const fileEditorStore = useFileEditorStore();
const settingsStore = useSettingsStore();
const sessionStore = useSessionStore();
const appearanceStore = useAppearanceStore(); 

// --- 本地状态控制弹窗显示 ---
const isVisible = ref(false);

// 接收 isMobile 属性
const props = defineProps<{
  isMobile?: boolean;
}>();

// --- 从 Store 获取状态 ---
// 全局 Store (用于共享模式和触发器)
const {
    popupTrigger,
    popupFileInfo, // 包含 sessionId 和 filePath
    activeTabId: globalActiveTabIdRef, // 获取全局 activeTabId
    // tabs: globalTabsRef, // 不再使用 storeToRefs 获取 tabs
} = storeToRefs(fileEditorStore);

// 设置 Store (用于判断模式)
const { showPopupFileEditorBoolean, shareFileEditorTabsBoolean } = storeToRefs(settingsStore);

// 从 Appearance Store 获取编辑器字体大小和字体
const { currentEditorFontSize, currentEditorFontFamily } = storeToRefs(appearanceStore);

// --- 从 Store 获取方法 ---
// 全局 Store Actions (用于共享模式)
const {
   saveFile: saveGlobalFile,
   closeTab: closeGlobalTab,
   setActiveTab: setGlobalActiveTab,
   updateFileContent: updateGlobalFileContent,
   // + 添加右键菜单操作 actions
   closeOtherTabs, // 修正：移除 Global 后缀
   closeTabsToTheRight, // 修正：移除 Global 后缀
   closeTabsToTheLeft, // 修正：移除 Global 后缀
   changeEncoding: changeGlobalEncoding, // +++ 全局编码更改 action +++
   updateTabScrollPosition, // 全局滚动位置更新 action
} = fileEditorStore;

// 会话 Store Actions (用于非共享模式)
const {
   saveFileInSession,
   closeEditorTabInSession,
   setActiveEditorTabInSession,
   updateFileContentInSession,
   // + 添加右键菜单操作 actions
   closeOtherTabsInSession,
   closeTabsToTheRightInSession,
   closeTabsToTheLeftInSession,
   changeEncodingInSession, // +++ 会话编码更改 action +++
   updateTabScrollPositionInSession, // 会话滚动位置更新 action
} = sessionStore;

// --- 移除本地文件状态 ---
// const popupFilePath = ref<string | null>(null);
// const popupSessionId = ref<string | null>(null);
// const popupFilename = ref<string>('');
// const popupContent = ref<string>('');
// const popupOriginalContent = ref<string>('');
// const popupLanguage = ref<string>('plaintext');
// const popupIsLoading = ref<boolean>(false);
// const popupLoadingError = ref<string | null>(null);
// const popupIsSaving = ref<boolean>(false);
// const popupSaveStatus = ref<SaveStatus>('idle');
// const popupSaveError = ref<string | null>(null);
// const popupIsModified = computed(() => popupContent.value !== popupOriginalContent.value);

// --- 弹窗尺寸和拖拽状态 ---
const popupWidthPx = ref(window.innerWidth * 0.75); // 初始宽度 75vw (像素)
const popupHeightPx = ref(window.innerHeight * 0.85); // 初始高度 85vh (像素)
const isResizing = ref(false);
const startX = ref(0);
const startY = ref(0);
const startWidthPx = ref(0);
const startHeightPx = ref(0);
const minWidth = 400; // 最小宽度
const minHeight = 300; // 最小高度
const encodingSelectRef = ref<HTMLSelectElement | null>(null); // +++ Ref for the select element +++
const codeMirrorMobileEditorRef = ref<InstanceType<typeof CodeMirrorMobileEditor> | null>(null); // +++ Ref for CodeMirrorMobileEditor +++

// --- 计算属性，用于模板绑定 ---
const popupStyle = computed(() => {
    if (props.isMobile) {
        return {
            width: '100vw',
            height: '100vh',
            maxWidth: '100%',
            maxHeight: '100%',
            borderRadius: '0',
        };
    } else {
        return {
            width: `${popupWidthPx.value}px`,
            height: `${popupHeightPx.value}px`,
        };
    }
});

// --- 动态计算属性 (根据模式选择数据源) ---

// +++ Function to calculate and set the select width (copied from FileEditorContainer) +++
const updateSelectWidth = () => {
  nextTick(() => { // Ensure DOM is updated before measuring
    if (!encodingSelectRef.value) return;

    const selectElement = encodingSelectRef.value;
    const selectedOption = selectElement.options[selectElement.selectedIndex];

    if (!selectedOption) return;

    // Create a temporary span to measure text width
    const tempSpan = document.createElement('span');
    // Copy relevant styles (adjust as needed for accurate measurement)
    const styles = window.getComputedStyle(selectElement);
    tempSpan.style.fontSize = styles.fontSize;
    tempSpan.style.fontFamily = styles.fontFamily;
    tempSpan.style.fontWeight = styles.fontWeight;
    tempSpan.style.letterSpacing = styles.letterSpacing;
    tempSpan.style.paddingLeft = styles.paddingLeft; // Include padding for accuracy
    tempSpan.style.paddingRight = styles.paddingRight;
    tempSpan.style.visibility = 'hidden'; // Make it invisible
    tempSpan.style.position = 'absolute'; // Prevent layout shift
    tempSpan.style.whiteSpace = 'nowrap'; // Prevent wrapping
    tempSpan.style.left = '-9999px'; // Move off-screen

    tempSpan.textContent = selectedOption.text;
    document.body.appendChild(tempSpan);

    const textWidth = tempSpan.offsetWidth;
    document.body.removeChild(tempSpan);

    // Set the select width (add extra space for dropdown arrow, adjust as needed)
    const arrowPadding = 25; // Increased padding for arrow and visual spacing
    selectElement.style.width = `${textWidth + arrowPadding}px`;
    // console.log(`[EditorOverlay] Setting select width for "${selectedOption.text}" to ${textWidth + arrowPadding}px`);
  });
};

// 获取当前弹窗关联的会话 (仅非共享模式需要)
const currentSession = computed(() => {
    if (shareFileEditorTabsBoolean.value || !popupFileInfo.value?.sessionId) {
        return null;
    }
    return sessionStore.sessions.get(popupFileInfo.value.sessionId) ?? null;
});

// 获取当前模式下的标签页列表
const orderedTabs = computed(() => {
    // 直接访问 store.tabs
    if (shareFileEditorTabsBoolean.value) {
        return Array.from(fileEditorStore.tabs.values()); // 直接访问 store
    } else {
        // 非共享模式保持不变，因为它依赖 sessionStore
        return currentSession.value?.editorTabs.value ?? [];
    }
});

// 获取当前模式下的活动标签页 ID
const activeTabId = computed(() => {
    if (shareFileEditorTabsBoolean.value) {
        return globalActiveTabIdRef.value; // 全局 Store
    } else {
        return currentSession.value?.activeEditorTabId.value ?? null; // 会话 Store
    }
});

// 获取当前模式下的活动标签页对象
const activeTab = computed((): FileTab | null => {
    const currentId = activeTabId.value;
    if (!currentId) return null;

    // 直接访问 store.tabs
    if (shareFileEditorTabsBoolean.value) {
        return fileEditorStore.tabs.get(currentId) ?? null; // 直接访问 store
    } else {
        // 非共享模式保持不变
        return currentSession.value?.editorTabs.value.find(tab => tab.id === currentId) ?? null;
    }
});

// Monaco 编辑器内容绑定 (根据模式调用不同 action)
const activeEditorContent = computed({
    get: () => activeTab.value?.content ?? '',
    set: (value) => {
        const currentActiveTab = activeTab.value; // 缓存当前活动标签
        if (!currentActiveTab) return;

        if (shareFileEditorTabsBoolean.value) {
            updateGlobalFileContent(currentActiveTab.id, value); // 全局 Store
        } else {
            // 非共享模式需要 sessionId
            const sessionId = popupFileInfo.value?.sessionId;
            if (sessionId) {
                updateFileContentInSession(sessionId, currentActiveTab.id, value); // 会话 Store
            } else {
                console.error("[FileEditorOverlay] 无法更新内容：非共享模式下缺少 sessionId。");
            }
        }
    },
});


// --- 从 activeTab 派生的计算属性 (保持不变，因为 activeTab 已动态化) ---
const currentTabIsLoading = computed(() => activeTab.value?.isLoading ?? false);
const currentTabLoadingError = computed(() => activeTab.value?.loadingError ?? null);
const currentTabIsSaving = computed(() => activeTab.value?.isSaving ?? false);
const currentTabSaveStatus = computed(() => activeTab.value?.saveStatus ?? 'idle');
const currentTabSaveError = computed(() => activeTab.value?.saveError ?? null);
const currentTabLanguage = computed(() => activeTab.value?.language ?? 'plaintext');
const currentTabFilePath = computed(() => activeTab.value?.filePath ?? '');
const currentTabIsModified = computed(() => activeTab.value?.isModified ?? false);
// +++ 计算当前选择的编码 (与 Container 逻辑一致) +++
const currentSelectedEncoding = computed(() => activeTab.value?.selectedEncoding ?? 'utf-8');
// +++ 计算当前活动标签的会话名称 (与 Container 逻辑一致) +++
const currentTabSessionName = computed(() => {
  const sessionId = activeTab.value?.sessionId;
  if (!sessionId) return null;
  // sessionStore 已在 setup 中实例化
  return sessionStore.sessions.get(sessionId)?.connectionName ?? null; // 修正：使用 connectionName
});

// --- 事件处理 (根据模式调用不同 action) ---

// +++ 编码选项 (copied from FileEditorContainer) +++
// 注意：这里的 value 需要与 iconv-lite 支持的标签匹配 (后端使用)
const encodingOptions = ref([
  // Unicode
  { value: 'utf-8', text: 'UTF-8' },
  { value: 'utf-16le', text: 'UTF-16 LE' },
  { value: 'utf-16be', text: 'UTF-16 BE' },
  // Chinese
  { value: 'gbk', text: 'GBK' },
  { value: 'gb18030', text: 'GB18030' },
  { value: 'big5', text: 'Big5 (Traditional Chinese)' },
  // Japanese
  { value: 'shift_jis', text: 'Shift-JIS' },
  { value: 'euc-jp', text: 'EUC-JP' },
  // Korean
  { value: 'euc-kr', text: 'EUC-KR' },
  // Western European
  { value: 'iso-8859-1', text: 'ISO-8859-1 (Latin-1)' },
  { value: 'iso-8859-15', text: 'ISO-8859-15 (Latin-9)' },
  { value: 'cp1252', text: 'Windows-1252' }, // Western European
  // Central European
  { value: 'iso-8859-2', text: 'ISO-8859-2 (Latin-2)' },
  { value: 'cp1250', text: 'Windows-1250' }, // Central European
  // Cyrillic
  { value: 'iso-8859-5', text: 'ISO-8859-5 (Cyrillic)' },
  { value: 'cp1251', text: 'Windows-1251 (Cyrillic)' },
  { value: 'koi8-r', text: 'KOI8-R' },
  { value: 'koi8-u', text: 'KOI8-U' },
  // Greek
  { value: 'iso-8859-7', text: 'ISO-8859-7 (Greek)' },
  { value: 'cp1253', text: 'Windows-1253 (Greek)' },
  // Turkish
  { value: 'iso-8859-9', text: 'ISO-8859-9 (Turkish)' },
  { value: 'cp1254', text: 'Windows-1254 (Turkish)' },
  // Hebrew
  { value: 'iso-8859-8', text: 'ISO-8859-8 (Hebrew)' },
  { value: 'cp1255', text: 'Windows-1255 (Hebrew)' },
  // Arabic
  { value: 'iso-8859-6', text: 'ISO-8859-6 (Arabic)' },
  { value: 'cp1256', text: 'Windows-1256 (Arabic)' },
  // Baltic
  { value: 'iso-8859-4', text: 'ISO-8859-4 (Baltic)' }, // Latin-4
  { value: 'iso-8859-13', text: 'ISO-8859-13 (Baltic)' }, // Latin-7
  { value: 'cp1257', text: 'Windows-1257 (Baltic)' },
  // Vietnamese
  { value: 'cp1258', text: 'Windows-1258 (Vietnamese)' },
  // Thai
  { value: 'tis-620', text: 'TIS-620 (Thai)' }, // Often cp874
  { value: 'cp874', text: 'Windows-874 (Thai)' },
]);

// 保存当前激活的标签页
const handleSaveRequest = () => {
    const currentActiveTab = activeTab.value;
    if (!currentActiveTab) return;

    if (shareFileEditorTabsBoolean.value) {
        saveGlobalFile(currentActiveTab.id); // 全局 Store
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            saveFileInSession(sessionId, currentActiveTab.id); // 会话 Store
        } else {
             console.error("[FileEditorOverlay] 无法保存：非共享模式下缺少 sessionId。");
        }
    }
};

// 激活标签页
const handleActivateTab = (tabId: string) => {
    if (shareFileEditorTabsBoolean.value) {
        setGlobalActiveTab(tabId); // 全局 Store
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            setActiveEditorTabInSession(sessionId, tabId); // 会话 Store
        } else {
             console.error("[FileEditorOverlay] 无法激活标签页：非共享模式下缺少 sessionId。");
        }
    }
};

// 关闭标签页
const handleCloseTab = (tabId: string) => {
     if (shareFileEditorTabsBoolean.value) {
        closeGlobalTab(tabId); // 全局 Store
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            closeEditorTabInSession(sessionId, tabId); // 会话 Store
        } else {
             console.error("[FileEditorOverlay] 无法关闭标签页：非共享模式下缺少 sessionId。");
        }
    }
};

// +++ 处理右键菜单事件 +++
const handleCloseOtherTabs = (targetTabId: string) => {
    console.log(`[FileEditorOverlay] handleCloseOtherTabs called for target: ${targetTabId}`); // Add log
    if (shareFileEditorTabsBoolean.value) {
        closeOtherTabs(targetTabId); 
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            closeOtherTabsInSession(sessionId, targetTabId); // 会话 Store
        } else {
            console.error("[FileEditorOverlay] 无法关闭其他标签页：非共享模式下缺少 sessionId。");
        }
    }
};

const handleCloseRightTabs = (targetTabId: string) => {
    console.log(`[FileEditorOverlay] handleCloseRightTabs called for target: ${targetTabId}`); // Add log
    if (shareFileEditorTabsBoolean.value) {
        closeTabsToTheRight(targetTabId); 
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            closeTabsToTheRightInSession(sessionId, targetTabId); // 会话 Store
        } else {
            console.error("[FileEditorOverlay] 无法关闭右侧标签页：非共享模式下缺少 sessionId。");
        }
    }
};

const handleCloseLeftTabs = (targetTabId: string) => {
    console.log(`[FileEditorOverlay] handleCloseLeftTabs called for target: ${targetTabId}`); // Add log
    if (shareFileEditorTabsBoolean.value) {
        closeTabsToTheLeft(targetTabId); // 修正：调用正确的 action 名称
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            closeTabsToTheLeftInSession(sessionId, targetTabId); // 会话 Store
        } else {
            console.error("[FileEditorOverlay] 无法关闭左侧标签页：非共享模式下缺少 sessionId。");
        }
    }
};

// +++ 处理编码更改事件 +++
const handleEncodingChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  const newEncoding = target.value;
  const currentActiveTab = activeTab.value;

  if (currentActiveTab && newEncoding && newEncoding !== currentSelectedEncoding.value) {
    console.log(`[EditorOverlay] Encoding changed to ${newEncoding} for tab ${currentActiveTab.id}`);
    if (shareFileEditorTabsBoolean.value) {
        changeGlobalEncoding(currentActiveTab.id, newEncoding); // 全局 Store
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            changeEncodingInSession(sessionId, currentActiveTab.id, newEncoding); // 会话 Store
        } else {
             console.error("[FileEditorOverlay] 无法更改编码：非共享模式下缺少 sessionId。");
        }
    }
  }
};

// +++ 处理编辑器滚动事件 +++
const handleEditorScroll = ({ scrollTop, scrollLeft }: { scrollTop: number; scrollLeft: number }) => {
    const currentActiveTab = activeTab.value;
    if (!currentActiveTab) return;

    if (shareFileEditorTabsBoolean.value) {
        // 全局 Store
        updateTabScrollPosition(currentActiveTab.id, scrollTop, scrollLeft);
    } else {
        // 非共享模式需要 sessionId
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            // 会话 Store
            updateTabScrollPositionInSession(sessionId, currentActiveTab.id, scrollTop, scrollLeft);
        } else {
            console.error("[FileEditorOverlay] 无法更新滚动位置：非共享模式下缺少 sessionId。");
        }
    }
};

// +++ 处理编辑器字体大小更新事件 +++
const handleEditorFontSizeUpdate = (newSize: number) => {
    appearanceStore.setEditorFontSize(newSize);
};

// +++ 打开搜索面板 +++
const handleOpenSearch = () => {
  if (codeMirrorMobileEditorRef.value) {
    codeMirrorMobileEditorRef.value.openSearch();
  }
};
 
// 关闭弹窗 (保持不变)
const handleCloseContainer = () => {
    isVisible.value = false;
};

// 外部冲突解决动作
const handleResolveReload = async () => {
    if (!activeTab.value) return;
    const tabId = activeTab.value.id;
    if (shareFileEditorTabsBoolean.value) {
        await fileEditorStore.resolveConflictReload(tabId);
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            await sessionStore.resolveConflictReloadInSession(sessionId, tabId);
        }
    }
};

const handleResolveOverwrite = async () => {
    if (!activeTab.value) return;
    const tabId = activeTab.value.id;
    if (shareFileEditorTabsBoolean.value) {
        await fileEditorStore.resolveConflictOverwrite(tabId);
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            await sessionStore.resolveConflictOverwriteInSession(sessionId, tabId);
        }
    }
};

const handleResolveIgnore = () => {
    if (!activeTab.value) return;
    const tabId = activeTab.value.id;
    if (shareFileEditorTabsBoolean.value) {
        fileEditorStore.resolveConflictIgnore(tabId);
    } else {
        const sessionId = popupFileInfo.value?.sessionId;
        if (sessionId) {
            sessionStore.resolveConflictIgnoreInSession(sessionId, tabId);
        }
    }
};


// --- 拖拽调整大小逻辑 ---
const startResize = (event: MouseEvent) => {
    isResizing.value = true;
    startX.value = event.clientX;
    startY.value = event.clientY;
    startWidthPx.value = popupWidthPx.value;
    startHeightPx.value = popupHeightPx.value;
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'nwse-resize'; // 设置拖拽光标
    document.body.style.userSelect = 'none'; // 禁止拖拽时选中文本
};

const handleResize = (event: MouseEvent) => {
    if (!isResizing.value) return;
    const diffX = event.clientX - startX.value;
    const diffY = event.clientY - startY.value;
    popupWidthPx.value = Math.max(minWidth, startWidthPx.value + diffX);
    popupHeightPx.value = Math.max(minHeight, startHeightPx.value + diffY);
};

const stopResize = () => {
    if (isResizing.value) {
        isResizing.value = false;
        document.removeEventListener('mousemove', handleResize);
        document.removeEventListener('mouseup', stopResize);
        document.body.style.cursor = ''; // 恢复默认光标
    document.body.style.userSelect = ''; // 恢复文本选择
    }
};

// 监听 popupTrigger 的变化来显示弹窗
watch(popupTrigger, () => {
    if (!showPopupFileEditorBoolean.value || !popupFileInfo.value) {
        console.log('[FileEditorOverlay] Popup trigger changed, but overlay is disabled or file info is missing.');
        isVisible.value = false;
        return;
    }

    const { filePath, sessionId } = popupFileInfo.value;
    console.log(`[FileEditorOverlay] Triggered for file: ${filePath} in session: ${sessionId}`);

    isVisible.value = true;


});

// +++ 监听 activeTab 的变化，更新 select 宽度 +++
watch(activeTab, () => {
    updateSelectWidth();
}, { immediate: true }); // immediate: true ensures it runs on initial load too

watch(currentSelectedEncoding, () => {
  updateSelectWidth();
});


// 组件卸载时清理事件监听器
onBeforeUnmount(() => {
    stopResize(); // 确保移除监听器
});

</script>

<template>
  <!-- 使用本地 isVisible 控制显示 (App.vue 中已有 v-if="showPopupFileEditorBoolean") -->
  <div v-if="isVisible" class="editor-overlay-backdrop" @click.self="handleCloseContainer"> <!-- 恢复点击背景关闭 -->
    <!-- 编辑器弹窗/容器，应用动态样式 -->
    <div class="editor-popup" :style="popupStyle">

      <!-- 标签栏 (使用动态计算属性和事件处理器) -->
      <FileEditorTabs
        :tabs="orderedTabs"
        :active-tab-id="activeTabId"
        @activate-tab="handleActivateTab"
        @close-tab="handleCloseTab"
        @close-other-tabs="handleCloseOtherTabs"
        @close-tabs-to-right="handleCloseRightTabs"
        @close-tabs-to-left="handleCloseLeftTabs"
      />

      <!-- 编辑器头部 (使用动态计算属性) -->
      <div v-if="activeTab" class="editor-header" :class="{ 'is-mobile': props.isMobile }">
        <span>
          {{ t('fileManager.editingFile') }}<template v-if="shareFileEditorTabsBoolean && currentTabSessionName">({{ currentTabSessionName }})</template>: {{ currentTabFilePath }}
          <span v-if="currentTabIsModified" class="modified-indicator">*</span>
        </span>
        <div class="editor-actions">
          <!-- +++ 编码选择下拉菜单 +++ -->
          <div class="encoding-select-wrapper" v-if="activeTab && !currentTabIsLoading">
            <select
              ref="encodingSelectRef"
              :value="currentSelectedEncoding"
              @change="handleEncodingChange"
              class="encoding-select"
              :title="t('fileManager.changeEncodingTooltip', '更改文件编码')"
            >
              <option v-for="option in encodingOptions" :key="option.value" :value="option.value">
                {{ option.text }}
              </option>
            </select>
          </div>
          <span v-else-if="activeTab" class="encoding-select-placeholder">{{ t('fileManager.loadingEncoding', '加载中...') }}</span>


          <span v-if="currentTabSaveStatus === 'saving'" class="save-status saving">{{ t('fileManager.saving') }}...</span>
          <span v-if="currentTabSaveStatus === 'success'" class="save-status success">✅ {{ t('fileManager.saveSuccess') }}</span>
          <span v-if="currentTabSaveStatus === 'error'" class="save-status error">❌ {{ t('fileManager.saveError') }}: {{ currentTabSaveError }}</span>
          <!-- +++ 移动端搜索按钮 (Font Awesome) +++ -->
          <button
            v-if="props.isMobile && activeTab && !currentTabIsLoading"
            @click="handleOpenSearch"
            class="search-btn"
            :title="t('fileManager.actions.search', 'Search')"
          >
            <i class="fas fa-search"></i>
          </button>
          <button @click="handleSaveRequest" :disabled="currentTabIsSaving || currentTabIsLoading || !!currentTabLoadingError || !activeTab" class="save-btn">
            {{ t('fileManager.actions.save') }}
          </button>

          <button v-if="!props.isMobile" @click="handleCloseContainer" class="close-editor-btn" :title="t('fileManager.actions.closeEditor')">✖</button>
        </div>
        <button v-if="props.isMobile" @click="handleCloseContainer" class="close-editor-btn" :title="t('fileManager.actions.closeEditor')">✖</button>
      </div>
       <!-- 如果没有活动标签页 -->
      <div v-else class="editor-header editor-header-placeholder" :class="{ 'is-mobile': props.isMobile }">
        <span>{{ t('fileManager.noOpenFile') }}</span>
         <button @click="handleCloseContainer" class="close-editor-btn" :title="t('fileManager.actions.closeEditor')">✖</button>
      </div>

      <!-- 外部修改冲突保护横幅 -->
      <div v-if="activeTab?.hasExternalConflict" class="conflict-banner">
        <div class="conflict-message">
          <i class="fas fa-exclamation-triangle"></i>
          <span>{{ t('fileManager.conflictWarning', '文件已在终端或远端被修改，本地有未保存内容。') }}</span>
        </div>
        <div class="conflict-actions">
          <button @click="handleResolveReload" class="conflict-btn reload-btn" :title="t('fileManager.conflictReloadTooltip', '放弃本地未保存更改，拉取远端最新内容')">
            {{ t('fileManager.actions.reloadRemote', '以远端内容载入') }}
          </button>
          <button @click="handleResolveOverwrite" class="conflict-btn overwrite-btn" :title="t('fileManager.conflictOverwriteTooltip', '将本地修改强制保存并覆盖远端')">
            {{ t('fileManager.actions.overwriteRemote', '覆盖保存到远端') }}
          </button>
          <button @click="handleResolveIgnore" class="conflict-btn ignore-btn" :title="t('fileManager.conflictIgnoreTooltip', '保留本地更改，暂不提示')">
            {{ t('fileManager.actions.ignoreConflict', '忽略') }}
          </button>
        </div>
      </div>

      <!-- 编辑器内容区域 (现在基于 activeTab) -->
      <div class="editor-content-area">
        <div v-if="currentTabIsLoading" class="editor-loading">{{ t('fileManager.loadingFile') }}</div>
        <div v-else-if="currentTabLoadingError" class="editor-error">{{ currentTabLoadingError }}</div>
        
        <!-- Desktop Editor -->
        <MonacoEditor
          v-else-if="activeTab && !props.isMobile"
          :key="`monaco-${activeTab.id}`"
          v-model="activeEditorContent"
          :language="currentTabLanguage"
          :font-family="currentEditorFontFamily"
          theme="vs-dark"
          class="editor-instance"
          :font-size="currentEditorFontSize"
          @request-save="handleSaveRequest"
          @update:fontSize="handleEditorFontSizeUpdate"
          :initialScrollTop="activeTab?.scrollTop ?? 0"
          :initialScrollLeft="activeTab?.scrollLeft ?? 0"
          @update:scrollPosition="handleEditorScroll"
        />
        <!-- Mobile Editor -->
        <CodeMirrorMobileEditor
          v-else-if="activeTab && props.isMobile"
          :key="`cm-${activeTab.id}`"
          v-model="activeEditorContent"
          :language="currentTabLanguage"
          class="editor-instance"
          @request-save="handleSaveRequest"
          ref="codeMirrorMobileEditorRef"
        />
         <!-- 如果容器可见但没有活动标签页 -->
        <div v-else class="editor-placeholder">{{ t('fileManager.selectFileToEdit') }}</div>
      </div>

      <!-- 添加拖拽手柄 -->
      <div class="resize-handle" @mousedown.prevent="startResize"></div>

    </div> <!-- 关闭 editor-popup -->
  </div> <!-- 关闭 editor-overlay-backdrop -->

   <!-- 可以添加一个最小化状态的显示 -->
   <!--
   <div v-if="editorVisibleState === 'minimized'" class="editor-minimized-bar" @click="setEditorVisibility('visible')">
       <span>File Editor</span>
       <button @click.stop="handleCloseContainer">✖</button>
   </div>
   -->
</template>

<style scoped>
/* 样式基本保持不变，但可能需要为标签栏和新状态调整 */
.editor-overlay-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: center;
}

.editor-popup {
  width: 75%; /* 可以适当调整大小 */
  height: 85%;
  background-color: #2d2d2d;
  border-radius: 8px;
  box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  color: #f0f0f0;
  overflow: hidden;
  position: relative; /* 为拖拽手柄定位 */
}

/* 移动设备上布满屏幕 */
/* @media (max-width: 768px) 的部分样式会通过 .is-mobile 类处理 */
@media (max-width: 768px) {
  .editor-popup {
    width: 100vw;
    height: 100vh;
    max-width: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}

/* 适配横向旋转 */
@media (orientation: landscape) and (max-width: 1024px) {
  .editor-popup {
    width: 100vw;
    height: 100vh;
    max-width: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}


.editor-header {
  display: flex;
  padding: 0.5rem 1rem;
  background-color: #333;
  border-bottom: 1px solid #555;
  font-size: 0.9em;
  flex-shrink: 0;
}

.editor-header.is-mobile {
  flex-direction: column;
  align-items: flex-start;
  position: relative; 
  padding: 1.5rem 2.5rem 0.5rem 1rem;
}

.editor-header:not(.is-mobile) {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.editor-header-placeholder {
    color: #888;
}

.editor-header-placeholder.is-mobile {
  flex-direction: column;
  align-items: flex-start;
  position: relative;
}

.editor-header-placeholder:not(.is-mobile) {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.modified-indicator {
    color: #ffeb3b;
    margin-left: 4px;
    font-weight: bold;
}

.close-editor-btn {
  background: none;
  border: none;
  color: #ccc;
  font-size: 1.2em;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
}
.close-editor-btn:hover {
  color: white;
}


.editor-header:not(.is-mobile) .editor-actions .close-editor-btn {
  position: static; 
}


.editor-header.is-mobile > .close-editor-btn {
  position: absolute;
  top: 1.5rem; 
  right: 1rem; 
  z-index: 10;
}


.editor-header-placeholder.is-mobile > .close-editor-btn {
  position: absolute;
  top: 1.5rem; 
  right: 1rem;
  z-index: 10;
}


.editor-header-placeholder:not(.is-mobile) > .close-editor-btn {
  position: static;
}

/* 编辑器内容区域，包含加载、错误、编辑器实例 */
.editor-content-area {
    flex-grow: 1;
    display: flex; /* 使内部元素能填充 */
    flex-direction: column;
    overflow: hidden; /* 内部编辑器滚动 */
    position: relative; /* 用于占位符定位 */
}

.editor-loading, .editor-error, .editor-placeholder {
  padding: 2rem;
  text-align: center;
  font-size: 1.1em;
  flex-grow: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
}
.editor-error {
    color: #ff8a8a;
}
.editor-placeholder {
    color: #666;
}


.editor-actions {
    display: flex;
    align-items: center;
    gap: 0.8rem;
}

.editor-header.is-mobile .editor-actions {
    flex-wrap: wrap;
    max-width: 100%;
    justify-content: flex-start;
    margin-top: 1rem;
}

.editor-header:not(.is-mobile) .editor-actions {
    margin-top: 0; 
}

.save-btn {
    background-color: #4CAF50;
    color: white;
    border: none;
    padding: 0.4rem 0.8rem;
    cursor: pointer;
    border-radius: 3px;
    font-size: 0.9em;
}
.save-btn:disabled {
    background-color: #aaa;
    cursor: not-allowed;
}
.save-btn:hover:not(:disabled) {
    background-color: #45a049;
}

.search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem; 
  height: 1.75rem; 
  background-color: transparent;
  border: none;
  border-radius: 0.25rem; 
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s; 
  padding: 0; 
  color: #ccc;
}
.search-btn:hover {
  background-color: rgba(0, 0, 0, 0.1); 
  color: #f0f0f0; 
}
.search-btn i {
  font-size: 1rem;
  line-height: 1; 
}

.save-status {
    font-size: 0.9em;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    white-space: nowrap;
}
.save-status.saving { color: #888; }
.save-status.success { color: #4CAF50; background-color: #e8f5e9; }
.save-status.error { color: #f44336; background-color: #ffebee; }

.editor-instance {
  flex-grow: 1;
  min-height: 0;
}

/* 拖拽手柄样式 */
.resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 15px;
    height: 15px;
    background-color: rgba(255, 255, 255, 0.2); /* 半透明手柄 */
    border-top: 1px solid #555;
    border-left: 1px solid #555;
    cursor: nwse-resize; /* 斜向拖拽光标 */
    z-index: 1001; /* 确保在内容之上 */
}
.resize-handle:hover {
    background-color: rgba(255, 255, 255, 0.4);
}



.encoding-select-wrapper {
  display: inline-block; /* 让 wrapper 包裹内容 */
  vertical-align: middle; /* 垂直居中对齐 */
}

.encoding-select {
  background-color: #444;
  color: #f0f0f0;
  border: 1px solid #666;
  padding: 0.3rem 0.5rem; /* 恢复内边距 */
  border-radius: 3px;
  font-size: 0.85em;
  cursor: pointer;
  outline: none;
}

.encoding-select:hover {
  background-color: #555;
}

.encoding-select:focus {
  border-color: #888;
}

.encoding-select-placeholder {
    font-size: 0.85em;
    color: #888;
    padding: 0.3rem 0.5rem;
    display: inline-block;
    min-width: 80px; /* 与 select 大致对齐 */
    text-align: center;
}

/* 外部冲突横幅样式 */
.conflict-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: rgba(234, 179, 8, 0.15);
  border-bottom: 1px solid rgba(234, 179, 8, 0.4);
  padding: 0.5rem 1rem;
  color: #facc15;
  font-size: 0.85rem;
  z-index: 10;
  flex-shrink: 0;
}

.conflict-message {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.conflict-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.conflict-btn {
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  font-weight: 500;
}

.conflict-btn.reload-btn {
  background: #ca8a04;
  color: #ffffff;
  border-color: #a16207;
}

.conflict-btn.reload-btn:hover {
  background: #eab308;
}

.conflict-btn.overwrite-btn {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.4);
}

.conflict-btn.overwrite-btn:hover {
  background: rgba(239, 68, 68, 0.35);
  color: #ffffff;
}

.conflict-btn.ignore-btn {
  background: transparent;
  color: #d1d5db;
  border-color: #4b5563;
}

.conflict-btn.ignore-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
</style>
