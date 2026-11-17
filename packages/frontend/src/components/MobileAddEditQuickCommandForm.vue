<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { QuickCommandFE } from '../stores/quickCommands.store';
import { useQuickCommandForm } from '../composables/quickCommands/useQuickCommandForm';
import { useQuickCommandFoldersStore } from '../stores/quickCommandFolders.store';
import { PRESET_COLORS } from '../utils/colorUtils';
import FolderSelect from './FolderSelect.vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = withDefaults(
  defineProps<{
    commandToEdit?: QuickCommandFE | null;
    initialCommand?: string;
    visible?: boolean;
  }>(),
  {
    commandToEdit: null,
    initialCommand: '',
    visible: true,
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
// 模板里的颜色选择器直接用到了 folders store
const quickCommandFoldersStore = useQuickCommandFoldersStore();

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

const placeholder = computed(() => {
  return t('quickCommands.form.commandPlaceholder', '例如：\necho "Hello World"\n支持变量：${VARIABLE_NAME}');
});

onMounted(() => {
  initForm();
});
</script>

<template>
  <MobileBottomSheet
    :visible="props.visible"
    height="h-[85vh]"
    max-height="max-h-[92vh]"
    @close="closeForm"
  >
    <!-- 顶栏左侧标题与图标 -->
    <template #header-left>
      <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <i :class="isEditing ? 'fas fa-edit' : 'fas fa-plus'" class="text-sm"></i>
      </div>
      <h3 class="text-base font-semibold text-foreground tracking-tight">
        {{ isEditing ? t('quickCommands.form.titleEdit', '编辑快捷指令') : t('quickCommands.form.titleAdd', '添加快捷指令') }}
      </h3>
    </template>

    <!-- 顶栏右侧快捷保存按钮 -->
    <template #header-actions>
      <button
        type="button"
        @click="handleSubmit"
        :disabled="isSubmitting || !!commandError"
        class="px-2.5 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all flex items-center gap-1 cursor-pointer"
        :title="isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')"
      >
        <i class="fas fa-check text-[11px]"></i>
        <span>{{ isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加') }}</span>
      </button>
    </template>

    <!-- 移动端表单可滚动内容区 -->
    <div class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-4 overscroll-contain">
            <!-- 1. 指令内容 (核心必填) -->
            <div>
              <label for="m-qc-command" class="block mb-1.5 text-xs font-semibold text-text-secondary">
                {{ t('quickCommands.form.command', '指令:') }} <span class="text-error">*</span>
              </label>
              <textarea
                id="m-qc-command"
                v-model="formData.command"
                required
                rows="3"
                :placeholder="placeholder"
                class="w-full px-3 py-2 border border-border/60 rounded-xl bg-input text-foreground font-mono text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary leading-relaxed whitespace-pre-wrap break-all"
              ></textarea>
              <small v-if="commandError" class="text-error text-xs mt-1 block">{{ commandError }}</small>
            </div>

            <!-- 2. 指令名称 (可选) -->
            <div>
              <label for="m-qc-name" class="block mb-1.5 text-xs font-semibold text-text-secondary">
                {{ t('quickCommands.form.name', '名称:') }}
              </label>
              <input
                id="m-qc-name"
                type="text"
                v-model="formData.name"
                :placeholder="t('quickCommands.form.namePlaceholder', '可选，用于快速识别')"
                class="w-full px-3 py-2 border border-border/60 rounded-xl bg-input text-foreground text-xs sm:text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition duration-150"
              />
            </div>

            <!-- 3. 所属文件夹 -->
            <div>
              <label class="block mb-1.5 text-xs font-semibold text-text-secondary">
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

            <!-- 4. 独立背景颜色配置 -->
            <div class="p-3 bg-card/60 border border-border/70 rounded-xl space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span
                    class="w-4 h-4 rounded-full border border-white/20 shadow-xs inline-block transition-colors"
                    :style="{ backgroundColor: formData.custom_background_color ? formData.background_color : 'transparent' }"
                    :class="!formData.custom_background_color ? 'border-dashed border-border' : ''"
                  ></span>
                  <label class="text-xs font-semibold text-foreground">
                    {{ t('folders.customColor', '独立背景颜色') }}
                  </label>
                </div>
                <button
                  type="button"
                  @click="toggleCustomColor"
                  class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
                  :class="formData.custom_background_color ? 'bg-primary' : 'bg-input/80'"
                >
                  <span
                    class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
                    :class="formData.custom_background_color ? 'translate-x-4' : 'translate-x-0'"
                  />
                </button>
              </div>

              <!-- 展开的调色板区域 -->
              <div v-if="formData.custom_background_color" class="pt-2 border-t border-border/50 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-medium text-text-secondary">{{ t('common.selectColor', '选择颜色') }}</span>
                  <button
                    type="button"
                    @click="handleRandomColor"
                    class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-header hover:bg-border/60 text-foreground border border-border/70 flex items-center gap-1 active:scale-95 shadow-xs"
                  >
                    <i class="fas fa-dice text-primary text-xs"></i>
                    <span>{{ t('common.randomColor', '随机') }}</span>
                  </button>
                </div>

                <!-- 预设色块 -->
                <div class="flex items-center flex-wrap gap-1.5">
                  <button
                    v-for="color in PRESET_COLORS"
                    :key="color"
                    type="button"
                    @click="formData.background_color = color"
                    class="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110 active:scale-95 focus:outline-none relative shadow-xs"
                    :style="{ backgroundColor: color }"
                    :class="formData.background_color?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''"
                  >
                    <i
                      v-if="formData.background_color?.toLowerCase() === color.toLowerCase()"
                      class="fas fa-check text-[10px] text-white drop-shadow-md"
                    ></i>
                  </button>
                </div>

                <!-- 原生拾色器与 HEX 输入框 -->
                <div class="flex items-center gap-2 pt-1">
                  <input
                    type="color"
                    v-model="formData.background_color"
                    class="w-7 h-7 rounded cursor-pointer border border-border/70 bg-transparent p-0.5"
                  />
                  <input
                    type="text"
                    v-model="formData.background_color"
                    placeholder="#3b82f6"
                    class="flex-1 px-2 py-1 text-xs font-mono border border-border/70 rounded-md bg-input text-foreground uppercase focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  />
                </div>
              </div>
            </div>

            <!-- 5. 变量管理 -->
            <div class="pt-2 border-t border-border/40">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-semibold text-text-secondary">
                  {{ t('quickCommands.form.variablesTitle', '变量管理') }}
                </span>
                <button
                  type="button"
                  @click="addVariable"
                  class="px-2.5 py-1 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all inline-flex items-center gap-1 cursor-pointer"
                >
                  <i class="fas fa-plus text-[10px]"></i>
                  <span>{{ t('quickCommands.form.addVariable', '添加变量') }}</span>
                </button>
              </div>

              <!-- 变量为空提示 -->
              <div
                v-if="localVariables.length === 0"
                class="text-xs text-text-secondary/70 p-3 border border-dashed border-border/50 rounded-xl text-center bg-background-secondary/20"
              >
                {{ t('quickCommands.form.noVariables', '暂无变量。点击上方按钮添加。') }}
              </div>

              <!-- 变量卡片列表 -->
              <div v-else class="space-y-2.5">
                <div
                  v-for="variable in localVariables"
                  :key="variable.id"
                  class="p-3 border border-border/50 rounded-xl bg-background-secondary/20 space-y-2 shadow-xs"
                >
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      v-model="variable.name"
                      :placeholder="t('quickCommands.form.variableNamePlaceholder', '变量名')"
                      class="flex-1 px-2.5 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-xs font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                      type="button"
                      @click="deleteVariable(variable.id)"
                      class="w-7 h-7 flex items-center justify-center text-text-secondary hover:text-error hover:bg-error/10 active:scale-95 rounded-lg transition-all cursor-pointer"
                      :title="t('common.delete', '删除')"
                    >
                      <i class="fas fa-trash-alt text-xs"></i>
                    </button>
                  </div>
                  <textarea
                    v-model="variable.value"
                    :placeholder="t('quickCommands.form.variableValuePlaceholder', '变量值')"
                    rows="2"
                    class="w-full px-2.5 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-xs font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  ></textarea>
                </div>
              </div>

              <!-- 忽略的非变量占位符设置 -->
              <div
                v-if="detectedUnignoredPlaceholders.length > 0 || ignoredVariables.length > 0"
                class="mt-3 pt-2.5 border-t border-border/40 space-y-2"
              >
                <div v-if="detectedUnignoredPlaceholders.length > 0" class="space-y-1">
                  <span class="block text-[11px] font-medium text-text-secondary">
                    {{ t('quickCommands.form.detectedPlaceholders', '未定义占位符（点击设为非变量）') }}
                  </span>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="name in detectedUnignoredPlaceholders"
                      :key="`m-detect-${name}`"
                      type="button"
                      @click="ignoreVariablePlaceholder(name)"
                      class="px-2 py-1 text-[11px] font-mono rounded-lg border border-border/60 bg-input/40 text-text-secondary active:scale-95 transition-all inline-flex items-center gap-1 cursor-pointer"
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
                      :key="`m-ignored-${name}`"
                      class="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono rounded-lg border border-border/60 bg-header/40 text-text-secondary"
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

            <!-- 底部流式操作区 -->
            <div class="pt-4 pb-6 space-y-2.5 border-t border-border/40">
              <button
                type="button"
                @click="handleSubmit"
                :disabled="isSubmitting || !!commandError"
                class="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-98 disabled:opacity-50 disabled:pointer-events-none transition-all shadow-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <i class="fas fa-check text-xs"></i>
                <span>{{ isEditing ? t('common.save', '保存快捷指令') : t('quickCommands.form.add', '确认添加快捷指令') }}</span>
              </button>
              <button
                type="button"
                @click="handleExecute"
                class="w-full py-2 px-4 rounded-xl text-xs font-semibold bg-[var(--color-success)] text-white hover:opacity-90 active:scale-98 transition-all shadow-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <i class="fas fa-play text-xs"></i>
                <span>{{ t('quickCommands.form.execute', '执行快捷指令') }}</span>
              </button>
              <button
                type="button"
                @click="closeForm"
                class="w-full py-2 px-4 rounded-xl text-xs font-medium bg-background border border-border/60 text-text-secondary hover:bg-border/30 active:scale-98 transition-all cursor-pointer"
              >
                {{ t('common.cancel', '取消') }}
              </button>
              <div class="sheet-safe-bottom"></div>
            </div>
          </div>
  </MobileBottomSheet>
</template>

<style scoped>
.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
