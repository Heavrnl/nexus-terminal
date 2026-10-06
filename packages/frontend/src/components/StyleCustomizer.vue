<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TerminalTheme } from '../types/terminal-theme.types';
import StyleCustomizerUiTab from './style-customizer/StyleCustomizerUiTab.vue';
import StyleCustomizerTerminalTab from './style-customizer/StyleCustomizerTerminalTab.vue';
import StyleCustomizerHighlightTab from './style-customizer/StyleCustomizerHighlightTab.vue';
import StyleCustomizerBackgroundTab from './style-customizer/StyleCustomizerBackgroundTab.vue';
import StyleCustomizerOtherTab from './style-customizer/StyleCustomizerOtherTab.vue'; 

const { t } = useI18n();
const uiTabRef = ref<InstanceType<typeof StyleCustomizerUiTab> | null>(null);



const isEditingTheme = ref(false);
const editingTheme = ref<TerminalTheme | null>(null);

const emit = defineEmits(['close']);

const closeCustomizer = () => {
  isEditingTheme.value = false;
  editingTheme.value = null;
  emit('close');
};

const currentTab = ref<'ui' | 'terminal' | 'highlight' | 'background' | 'other'>('ui');

// --- Processing Functions ---

const handleSaveUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleSaveUiTheme();
  }
};

const handleResetUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleResetUiTheme();
  }
};



const modalRootRef = ref<HTMLDivElement | null>(null);
const headerRef = ref<HTMLElement | null>(null);
const dialogContentRef = ref<HTMLDivElement | null>(null);

const draggableState = reactive({
  isDragging: false,
  startX: 0,
  startY: 0,
  initialLeft: 0,
  initialTop: 0,
});

onMounted(() => {
  const headerElement = headerRef.value;
  const dialogEl = dialogContentRef.value;
  const rootEl = modalRootRef.value;

  if (!headerElement || !dialogEl || !rootEl) {
    // console.warn("Draggable elements not found for StyleCustomizer modal."); // 用于调试的可选日志
    return;
  }
  
  nextTick(() => {
    //确保对话框已渲染且其尺寸可用
    if (dialogEl && rootEl) {
        dialogEl.style.position = 'absolute'; // 使对话框在rootEl内绝对定位
        const rootWidth = rootEl.clientWidth;
        const rootHeight = rootEl.clientHeight;
        const dialogWidth = dialogEl.offsetWidth;
        const dialogHeight = dialogEl.offsetHeight;

        // 使对话框居中
        dialogEl.style.left = `${Math.max(0, (rootWidth - dialogWidth) / 2)}px`;
        dialogEl.style.top = `${Math.max(0, (rootHeight - dialogHeight) / 2)}px`;
    }
  });

  const onMouseDown = (event: MouseEvent) => {
    if (!dialogEl) return;
    event.preventDefault(); // 防止文本选择等默认行为

    draggableState.isDragging = true;
    draggableState.startX = event.clientX;
    draggableState.startY = event.clientY;
    draggableState.initialLeft = dialogEl.offsetLeft;
    draggableState.initialTop = dialogEl.offsetTop;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!draggableState.isDragging || !dialogEl || !rootEl) return;

    const dx = event.clientX - draggableState.startX;
    const dy = event.clientY - draggableState.startY;

    let newLeft = draggableState.initialLeft + dx;
    let newTop = draggableState.initialTop + dy;

    // 边界检查，使对话框保持在 modalRootRef (视口) 内
    newLeft = Math.max(0, Math.min(newLeft, rootEl.clientWidth - dialogEl.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, rootEl.clientHeight - dialogEl.offsetHeight));
    
    dialogEl.style.left = `${newLeft}px`;
    dialogEl.style.top = `${newTop}px`;
  };

  const onMouseUp = () => {
    if (!draggableState.isDragging) return;
    draggableState.isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  headerElement.addEventListener('mousedown', onMouseDown);
  headerElement.style.cursor = 'move'; // 设置页眉鼠标样式为可拖动

  onUnmounted(() => {
    if (headerElement) {
      headerElement.removeEventListener('mousedown', onMouseDown);
      headerElement.style.cursor = ''; // 重置鼠标样式
    }
    // 清理全局监听器
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });
});


</script>


<template>
  <div ref="modalRootRef" class="fixed inset-0 z-[1000]" @click.self="closeCustomizer">
    <div ref="dialogContentRef" class="bg-background text-foreground rounded-lg shadow-[0px_0px_15px_rgb(0_0_0_/_0.15)] w-full h-full md:w-[90%] md:max-w-[800px] md:h-[85vh] md:max-h-[700px] flex flex-col overflow-hidden">
      <header ref="headerRef" class="flex justify-between items-center px-4 py-3 border-b border-border bg-header flex-shrink-0">
        <h2 class="m-0 text-lg md:text-xl text-foreground">{{ t('styleCustomizer.title') }}</h2>
        <button @click="closeCustomizer" class="bg-transparent border-none text-2xl md:text-3xl leading-none cursor-pointer text-text-secondary px-2 py-1 rounded hover:text-foreground hover:bg-black/10">&times;</button>
      </header>
      <div class="flex flex-grow overflow-hidden flex-col md:flex-row"> 
        
        <nav class="w-full md:w-[180px] border-b md:border-b-0 md:border-r border-border p-2 md:p-4 bg-header flex-shrink-0 overflow-y-auto flex flex-row md:flex-col flex-wrap md:flex-nowrap justify-center md:justify-start"> 
          <button
            @click="currentTab = 'ui'"
            :class="[
              'block w-auto md:w-full px-3 py-2 md:py-[0.7rem] mb-0 md:mb-2 mx-1 md:mx-0 text-center md:text-left bg-transparent border border-transparent rounded cursor-pointer text-foreground text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-text-secondary',
              { '!bg-button !text-button-text !font-bold': currentTab === 'ui' }
            ]"
          >
            {{ t('styleCustomizer.uiStyles') }}
          </button>
          <button
            @click="currentTab = 'terminal'"
            :class="[
              'block w-auto md:w-full px-3 py-2 md:py-[0.7rem] mb-0 md:mb-2 mx-1 md:mx-0 text-center md:text-left bg-transparent border border-transparent rounded cursor-pointer text-foreground text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-text-secondary',
              { '!bg-button !text-button-text !font-bold': currentTab === 'terminal' && !isEditingTheme } 
            ]"
            :disabled="isEditingTheme"
          >
            {{ t('styleCustomizer.terminalStyles') }}
          </button>
          <button
            @click="currentTab = 'highlight'"
            :class="[
              'block w-auto md:w-full px-3 py-2 md:py-[0.7rem] mb-0 md:mb-2 mx-1 md:mx-0 text-center md:text-left bg-transparent border border-transparent rounded cursor-pointer text-foreground text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-text-secondary',
              { '!bg-button !text-button-text !font-bold': currentTab === 'highlight' }
            ]"
            :disabled="isEditingTheme"
          >
            {{ t('styleCustomizer.terminalHighlight', '代码高亮') }}
          </button>
           <button
            @click="currentTab = 'background'"
            :class="[
              'block w-auto md:w-full px-3 py-2 md:py-[0.7rem] mb-0 md:mb-2 mx-1 md:mx-0 text-center md:text-left bg-transparent border border-transparent rounded cursor-pointer text-foreground text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-text-secondary',
              { '!bg-button !text-button-text !font-bold': currentTab === 'background' }
            ]"
            :disabled="isEditingTheme"
          >
            {{ t('styleCustomizer.backgroundSettings') }}
          </button>
          <button
            @click="currentTab = 'other'"
            :class="[
              'block w-auto md:w-full px-3 py-2 md:py-[0.7rem] mb-0 md:mb-2 mx-1 md:mx-0 text-center md:text-left bg-transparent border border-transparent rounded cursor-pointer text-foreground text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-text-secondary',
              { '!bg-button !text-button-text !font-bold': currentTab === 'other' } 
            ]"
            :disabled="isEditingTheme"
          >
            {{ t('styleCustomizer.otherSettings') }}
          </button>
        </nav>
        
        <main class="flex-grow p-3 md:p-4 md:px-6 overflow-y-auto min-h-0">
          <StyleCustomizerUiTab v-if="currentTab === 'ui'" ref="uiTabRef" />
          <StyleCustomizerTerminalTab
            v-if="currentTab === 'terminal'"
            :modal-root-ref="modalRootRef"
            :is-editing-theme="isEditingTheme"
            :editing-theme="editingTheme"
            @update:is-editing-theme="val => isEditingTheme = val"
            @update:editing-theme="val => editingTheme = val"
          />
          <StyleCustomizerHighlightTab v-if="currentTab === 'highlight'" />
          <StyleCustomizerBackgroundTab v-if="currentTab === 'background'" />
          <StyleCustomizerOtherTab v-if="currentTab === 'other'" />
       </main>
      </div>
      
      <footer class="flex justify-end p-3 md:p-4 border-t border-border bg-footer flex-shrink-0 flex-wrap gap-2"> 
        <button v-if="currentTab === 'ui'" @click="handleResetUiTheme" class="px-4 md:px-5 py-2 rounded font-bold ml-2 border border-border bg-header text-foreground hover:bg-border disabled:opacity-60 disabled:cursor-not-allowed text-sm md:text-base">{{ t('styleCustomizer.resetUiTheme') }}</button> 
        <button v-if="currentTab === 'ui'" @click="handleSaveUiTheme" class="px-4 md:px-5 py-2 rounded font-bold ml-2 border border-button bg-button text-button-text hover:bg-button-hover hover:border-button-hover disabled:opacity-60 disabled:cursor-not-allowed text-sm md:text-base">{{ t('styleCustomizer.saveUiTheme') }}</button> 
        <button @click="closeCustomizer" class="px-4 md:px-5 py-2 rounded font-bold ml-2 border border-border bg-header text-foreground hover:bg-border disabled:opacity-60 disabled:cursor-not-allowed text-sm md:text-base">{{ t('common.close') }}</button> 
      </footer>
    </div>
  </div>
</template>

