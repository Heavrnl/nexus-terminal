<template>
  <!-- 移动端专属抽屉视图 -->
  <MobileAddEditQuickCommandForm
    v-if="isMobile"
    :command-to-edit="props.commandToEdit"
    :initial-command="props.initialCommand"
    @close="closeForm"
  />

  <!-- 桌面端：经典一体化大卡片弹窗 (Unified Card Modal) -->
  <div v-else class="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/60 backdrop-blur-xs select-none animate-fadeIn" @click.self="closeForm">
    <div
      ref="modalContentRef"
      class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl p-6 flex flex-col overflow-hidden max-w-5xl"
      :style="{
        width: resizableWidth ? `${resizableWidth}px` : '880px',
        height: resizableHeight ? `${resizableHeight}px` : '700px',
      }"
      @click.stop
    >
      <!-- 卡片顶部：内嵌式标题栏 -->
      <div class="flex items-center justify-between pb-4 mb-4 border-b border-border/50 flex-shrink-0 select-none">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center text-primary">
            <i :class="isEditing ? 'fas fa-edit' : 'fas fa-terminal'" class="text-sm"></i>
          </div>
          <div class="flex items-center gap-2">
            <h2 class="text-base md:text-lg font-bold text-foreground tracking-tight leading-none">
              {{ isEditing ? t('quickCommands.form.titleEdit', '编辑快捷指令') : t('quickCommands.form.titleAdd', '添加快捷指令') }}
            </h2>
            <span
              class="text-[11px] px-2 py-0.5 rounded-full font-semibold border bg-primary/15 text-primary border-primary/25"
            >
              {{ isEditing ? t('common.edit', '编辑') : t('common.new', '新建') }}
            </span>
          </div>
        </div>

        <button
          type="button"
          @click="closeForm"
          class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          title="Esc"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>

      <!-- 卡片主体：一体化双栏工作区 -->
      <div class="flex-1 overflow-hidden flex flex-col md:flex-row gap-6 min-h-0">
        <!-- 左侧：变量管理 -->
        <div class="w-full md:w-72 lg:w-80 flex-shrink-0 flex flex-col overflow-hidden md:border-r md:border-border/50 md:pr-6">
          <div class="flex items-center justify-between mb-3 flex-shrink-0">
            <div class="flex items-center gap-1.5">
              <i class="fas fa-sliders-h text-primary text-xs"></i>
              <h3 class="text-xs font-bold text-foreground uppercase tracking-wider">{{ t('quickCommands.form.variablesTitle', '变量管理') }}</h3>
            </div>
            <button
              type="button"
              @click="addVariable"
              class="px-2 py-1 text-xs font-semibold rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all flex items-center gap-1 cursor-pointer"
            >
              <i class="fas fa-plus text-[10px]"></i>
              <span>{{ t('quickCommands.form.addVariable', '添加变量') }}</span>
            </button>
          </div>

          <div class="space-y-2.5 overflow-y-auto flex-1 pr-1 pb-1">
            <div v-if="localVariables.length === 0" class="text-xs text-text-tertiary p-4 border border-dashed border-border/50 rounded-xl text-center bg-input/10">
              {{ t('quickCommands.form.noVariables', '暂无变量。点击上方按钮添加。') }}
            </div>
            <div
              v-for="variable in localVariables"
              :key="variable.id"
              class="p-2.5 border border-border/60 rounded-xl bg-input/20 space-y-2 group hover:border-primary/50 transition-colors"
            >
              <input
                type="text"
                v-model="variable.name"
                :placeholder="t('quickCommands.form.variableNamePlaceholder', '变量名')"
                class="w-full px-2.5 py-1.5 border border-border/60 rounded-lg bg-input text-foreground text-xs shadow-2xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <textarea
                v-model="variable.value"
                :placeholder="t('quickCommands.form.variableValuePlaceholder', '变量值')"
                rows="2"
                class="w-full px-2.5 py-1.5 border border-border/60 rounded-lg bg-input text-foreground text-xs resize-y min-h-[38px] shadow-2xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              ></textarea>
              <div class="flex justify-end">
                <button
                  type="button"
                  @click="deleteVariable(variable.id)"
                  class="px-2 py-0.5 text-[11px] text-error hover:bg-error/10 border border-error/30 rounded-md transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <i class="fas fa-trash-alt text-[9px]"></i>
                  <span>{{ t('common.delete', '删除') }}</span>
                </button>
              </div>
            </div>

            <!-- 忽略的非变量占位符设置 -->
            <div
              v-if="detectedUnignoredPlaceholders.length > 0 || ignoredVariables.length > 0"
              class="pt-2 border-t border-border/40 space-y-2"
            >
              <div v-if="detectedUnignoredPlaceholders.length > 0" class="space-y-1">
                <span class="block text-[11px] font-medium text-text-secondary">
                  {{ t('quickCommands.form.detectedPlaceholders', '未定义占位符（点击设为非变量）') }}
                </span>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="name in detectedUnignoredPlaceholders"
                    :key="`detect-${name}`"
                    type="button"
                    @click="ignoreVariablePlaceholder(name)"
                    class="px-2 py-0.5 text-[11px] font-mono rounded-md border border-border/60 bg-input/40 text-text-secondary hover:text-foreground hover:border-primary/50 transition-colors cursor-pointer flex items-center gap-1"
                    :title="t('quickCommands.variablePrompt.notVariableHint', '按字面量原样发送，下次不再提示填写')"
                  >
                    <span>{{ '${' + name + '}' }}</span>
                    <span class="text-[10px] text-primary">{{ t('quickCommands.form.markAsNotVar', '忽略') }}</span>
                  </button>
                </div>
              </div>

              <div v-if="ignoredVariables.length > 0" class="space-y-1">
                <span class="block text-[11px] font-medium text-text-secondary">
                  {{ t('quickCommands.form.ignoredVariablesTitle', '已忽略（按原样发送，不弹窗）') }}
                </span>
                <div class="flex flex-wrap gap-1.5">
                  <span
                    v-for="name in ignoredVariables"
                    :key="`ignored-${name}`"
                    class="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border border-border/60 bg-header/40 text-text-secondary"
                  >
                    <span>{{ '${' + name + '}' }}</span>
                    <button
                      type="button"
                      @click="unignoreVariablePlaceholder(name)"
                      class="text-text-tertiary hover:text-error transition-colors cursor-pointer leading-none"
                      :title="t('quickCommands.form.restoreVariable', '取消忽略')"
                    >
                      <i class="fas fa-times text-[10px]"></i>
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：指令配置表单 -->
        <form @submit.prevent="handleSubmit" class="flex-1 flex flex-col overflow-y-auto min-w-0 space-y-4">
          <!-- 名称 -->
          <div>
            <label for="qc-name" class="block mb-1 text-xs font-semibold text-text-secondary">{{ t('quickCommands.form.name', '指令名称') }}</label>
            <input
              id="qc-name"
              type="text"
              v-model="formData.name"
              :placeholder="t('quickCommands.form.namePlaceholder', '可选，用于快速识别')"
              class="w-full px-3.5 py-2 border border-border/60 rounded-lg bg-input text-foreground text-sm shadow-2xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition duration-150"
            />
          </div>

          <!-- 指令内容 -->
          <div class="flex flex-col flex-1 min-h-[140px]">
            <div class="flex items-center justify-between mb-1">
              <label for="qc-command" class="text-xs font-semibold text-text-secondary">
                {{ t('quickCommands.form.command', '执行指令') }} <span class="text-error">*</span>
              </label>
              <span class="text-[11px] text-text-tertiary">支持 ${变量名} 插值</span>
            </div>
            <textarea
              id="qc-command"
              v-model="formData.command"
              required
              :placeholder="placeholder"
              class="w-full px-3.5 py-2.5 border border-border/60 rounded-lg bg-input text-foreground font-mono text-xs md:text-sm shadow-2xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition duration-150 whitespace-pre overflow-x-auto flex-1 min-h-[110px]"
            ></textarea>
            <small v-if="commandError" class="text-error text-xs mt-1 block">{{ commandError }}</small>
          </div>

          <!-- 所属文件夹选择区 -->
          <div>
            <label class="block mb-1 text-xs font-semibold text-text-secondary">
              <i class="fas fa-folder text-amber-400 mr-1.5"></i>
              {{ t('folders.title', '所属文件夹') }}
            </label>
            <FolderSelect
              v-model="selectedFolderId"
              :folders="quickCommandFoldersStore.folders"
              :allow-create="true"
              @create-folder="handleCreateFolder"
              :placeholder="t('folders.selectPlaceholder', '选择所属文件夹...')"
            />
          </div>

          <!-- 独立背景颜色设置区 -->
          <div class="p-3 bg-input/20 border border-border/50 rounded-xl space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <i class="fas fa-palette text-primary text-xs"></i>
                <div>
                  <span class="text-xs font-semibold text-foreground">{{ t('quickCommands.form.customBackgroundColor', '独立背景颜色') }}</span>
                  <p class="text-[11px] text-text-secondary">{{ t('quickCommands.form.customBackgroundColorTip', '设定独立背景颜色（优先级高于所属文件夹）') }}</p>
                </div>
              </div>
              <!-- 开关 -->
              <button
                type="button"
                role="switch"
                :aria-checked="formData.custom_background_color"
                @click="toggleCustomColor"
                class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
                :class="formData.custom_background_color ? 'bg-primary' : 'bg-muted-foreground/30'"
              >
                <span
                  class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
                  :class="formData.custom_background_color ? 'translate-x-4' : 'translate-x-0'"
                />
              </button>
            </div>

            <!-- 展开的调色板区域 -->
            <div v-if="formData.custom_background_color" class="pt-2 border-t border-border/40 space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-[11px] font-semibold text-text-secondary">{{ t('common.selectColor', '选择颜色') }}</label>
                <button
                  type="button"
                  @click="handleRandomColor"
                  class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-muted/30 hover:bg-muted/60 text-foreground border border-border/70 flex items-center gap-1.5 transition-all active:scale-95 shadow-2xs cursor-pointer"
                  :title="t('common.randomColorTip', '随机抽取一个颜色')"
                >
                  <i class="fas fa-dice text-primary"></i>
                  <span>{{ t('common.randomColor', '随机颜色') }}</span>
                </button>
              </div>

              <!-- 预设色块 -->
              <div class="flex items-center flex-wrap gap-2">
                <button
                  v-for="color in PRESET_COLORS"
                  :key="color"
                  type="button"
                  @click="formData.background_color = color"
                  class="w-5 h-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none relative shadow-2xs cursor-pointer"
                  :style="{ backgroundColor: color }"
                  :class="formData.background_color?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''"
                  :title="color"
                >
                  <i
                    v-if="formData.background_color?.toLowerCase() === color.toLowerCase()"
                    class="fas fa-check text-[9px] text-white drop-shadow-md"
                  ></i>
                </button>
              </div>

              <!-- 原生拾色器与 HEX 输入框 -->
              <div class="flex items-center gap-2 pt-0.5">
                <input
                  type="color"
                  v-model="formData.background_color"
                  class="w-6 h-6 rounded cursor-pointer border border-border/70 bg-transparent p-0.5"
                />
                <input
                  type="text"
                  v-model="formData.background_color"
                  placeholder="#3b82f6"
                  class="flex-1 px-2.5 py-1 text-xs font-mono border border-border/70 rounded-md bg-input text-foreground uppercase focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
            </div>
          </div>

          <!-- 卡片底部：内嵌式操作行 -->
          <div class="pt-4 border-t border-border/50 flex justify-between items-center mt-auto flex-shrink-0 select-none">
            <button
              type="button"
              @click="handleExecute"
              class="h-9 px-4 rounded-lg text-xs md:text-sm font-semibold transition-all bg-[var(--color-success)] text-white hover:brightness-110 shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <i class="fas fa-play text-xs"></i>
              <span>{{ t('quickCommands.form.execute', '执行') }}</span>
            </button>

            <div class="flex items-center gap-2.5">
              <button
                type="button"
                @click="closeForm"
                class="h-9 px-4 rounded-lg text-xs md:text-sm font-medium transition-colors bg-input/40 border border-border/60 text-text-secondary hover:text-foreground hover:bg-input/60 cursor-pointer"
              >
                {{ t('common.cancel', '取消') }}
              </button>
              <button
                type="submit"
                :disabled="isSubmitting || !!commandError"
                class="h-9 px-5 rounded-lg text-xs md:text-sm font-semibold transition-all bg-primary text-white hover:bg-primary-hover shadow-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
              >
                <i class="fas fa-check text-xs"></i>
                <span>{{ isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加') }}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { QuickCommandFE } from '../stores/quickCommands.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useResizable } from '../composables/useResizable';
import { useQuickCommandForm } from '../composables/quickCommands/useQuickCommandForm';
import { useQuickCommandFoldersStore } from '../stores/quickCommandFolders.store';
import { PRESET_COLORS } from '../utils/colorUtils';
import FolderSelect from './FolderSelect.vue';
import MobileAddEditQuickCommandForm from './MobileAddEditQuickCommandForm.vue';

const props = defineProps<{
  commandToEdit?: QuickCommandFE | null; // 接收要编辑的指令对象 (应包含标签ID和变量)
  initialCommand?: string; // 初始命令文本（新增时预填）
  initialFolderId?: number | null; // 新增时预选的所属文件夹ID
}>();

const emit = defineEmits(['close']);

const { isMobile } = useDeviceDetection();
const { t } = useI18n();
// 模板里的颜色选择器直接用到了 folders store
const quickCommandFoldersStore = useQuickCommandFoldersStore();

// 桌面端可调整尺寸的弹窗
const modalContentRef = ref<HTMLElement | null>(null);
const R_MIN_WIDTH = 800; // 可调整大小的最小宽度 (像素)
const R_MIN_HEIGHT = 700; // 可调整大小的最小高度 (像素)
const placeholder = t('quickCommands.form.commandPlaceholder') + 'echo "Hello,${USERNAME}"';

const { width: resizableWidth, height: resizableHeight } = useResizable(modalContentRef, {
  minWidth: R_MIN_WIDTH,
  minHeight: R_MIN_HEIGHT,
});

// 表单逻辑两端共用（见 composables/quickCommands/useQuickCommandForm.ts）
const {
  isSubmitting,
  isEditing,
  formData,
  localVariables,
  ignoredVariables,
  detectedUnignoredPlaceholders,
  commandError,
  selectedFolderId,
  toggleCustomColor,
  handleRandomColor,
  initForm,
  handleCreateFolder,
  handleDeleteFolder,
  handleSubmit,
  closeForm,
  addVariable,
  deleteVariable,
  ignoreVariablePlaceholder,
  unignoreVariablePlaceholder,
  handleExecute,
} = useQuickCommandForm(props, emit);

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !isSubmitting.value) {
    closeForm();
  }
};

onMounted(() => {
  // 仅在桌面端应用 resizable 尺寸初始化
  if (typeof window !== 'undefined' && !isMobile.value) {
    let initialW = Math.min(window.innerWidth * 0.9, 1152); // 目标 90vw，最大 1152px
    let initialH = window.innerHeight * 0.85; // 目标 85vh

    initialW = Math.max(R_MIN_WIDTH, initialW);
    initialH = Math.max(R_MIN_HEIGHT, initialH);

    resizableWidth.value = initialW;
    resizableHeight.value = initialH;
  }

  initForm();
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}
</style>
