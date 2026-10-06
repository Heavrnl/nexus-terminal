<template>
  <!-- 移动端：底部滑出抽屉 (Bottom Sheet) -->
  <Teleport to="body" v-if="isMobile">
    <Transition name="bottom-sheet">
      <div
        class="bottom-sheet-overlay fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="closeForm"
      >
        <div
          class="mobile-form-sheet w-full h-[85vh] max-h-[92vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <!-- 顶部拖拽手柄与点击快速收起指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="closeForm"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与关闭按钮 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <i :class="isEditing ? 'fas fa-edit' : 'fas fa-plus'" class="text-sm"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ isEditing ? t('quickCommands.form.titleEdit', '编辑快捷指令') : t('quickCommands.form.titleAdd', '添加快捷指令') }}
              </h3>
            </div>

            <div class="flex items-center gap-2">
              <!-- 快捷保存按钮（键盘弹起或随时可用） -->
              <button
                type="button"
                @click="handleSubmit"
                :disabled="isSubmitting || !!commandError"
                class="px-2.5 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all flex items-center gap-1 cursor-pointer"
                :title="isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')"
              >
                <i class="fas fa-check text-[11px]"></i>
                <span>{{ isSubmitting ? t('common.saving', '保存中...') : (isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')) }}</span>
              </button>

              <!-- 收起按钮 -->
              <button
                @click="closeForm"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                :title="t('close', '收起')"
              >
                <i class="fas fa-chevron-down text-sm"></i>
              </button>
            </div>
          </div>

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

            <!-- 3. 标签分类 -->
            <div>
              <label for="m-qc-tags" class="block mb-1.5 text-xs font-semibold text-text-secondary">
                {{ t('quickCommands.form.tags', '标签:') }}
              </label>
              <TagInput
                id="m-qc-tags"
                v-model="formData.tagIds"
                :available-tags="quickCommandTagsStore.tags"
                :placeholder="t('quickCommands.form.tagsPlaceholder', '添加或选择标签...')"
                @create-tag="handleCreateTag"
                :allow-create="true"
                :allow-delete="true"
                @delete-tag="handleDeleteTag"
                class="w-full"
              />
            </div>

            <!-- 4. 变量管理 -->
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
              <div v-else class="space-y-2">
                <div
                  v-for="variable in localVariables"
                  :key="variable.id"
                  class="p-2.5 border border-border/50 rounded-xl bg-background-secondary/30 space-y-2"
                >
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      v-model="variable.name"
                      :placeholder="t('quickCommands.form.variableNamePlaceholder', '变量名')"
                      class="flex-grow px-2.5 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-xs font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                      type="button"
                      @click="deleteVariable(variable.id)"
                      class="p-1.5 text-text-secondary hover:text-error active:scale-90 rounded-lg hover:bg-error/10 transition-colors cursor-pointer shrink-0"
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
            </div>

            <!-- 底部流式操作区 (自然跟随内容滚动，不占常驻屏幕视野，软键盘激活时绝不遮挡) -->
            <div class="pt-4 pb-6 space-y-2.5 border-t border-border/40">
              <button
                type="button"
                @click="handleSubmit"
                :disabled="isSubmitting || !!commandError"
                class="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-98 disabled:opacity-50 disabled:pointer-events-none transition-all shadow-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <i class="fas fa-check text-xs"></i>
                <span>{{ isSubmitting ? t('common.saving', '保存中...') : (isEditing ? t('common.save', '保存快捷指令') : t('quickCommands.form.add', '确认添加快捷指令')) }}</span>
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
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 桌面端：经典 Resizable 左右双栏弹窗 -->
  <div v-else class="fixed inset-0 bg-overlay flex justify-center items-center z-50">
    <div
      ref="modalContentRef"
      class="bg-background text-foreground p-6 rounded-xl border border-border/50 shadow-2xl flex flex-col"
      :style="{
        width: resizableWidth ? `${resizableWidth}px` : undefined,
        height: resizableHeight ? `${resizableHeight}px` : undefined,
      }"
    >
      <h2 class="m-0 mb-6 text-center text-xl font-semibold">
        {{ isEditing ? t('quickCommands.form.titleEdit', '编辑快捷指令') : t('quickCommands.form.titleAdd', '添加快捷指令') }}
      </h2>
      <div class="flex-grow flex space-x-6 min-h-0">
        <!-- 左侧：变量管理 -->
        <div class="w-1/3 border-r border-border/30 pr-6 flex flex-col overflow-y-auto">
          <h3 class="text-md font-medium mb-3 text-text-secondary">{{ t('quickCommands.form.variablesTitle', '变量管理') }}</h3>
          <div class="space-y-3 overflow-y-auto flex-grow pr-1 pb-2">
            <div v-if="localVariables.length === 0" class="text-sm text-text-tertiary p-2 border border-dashed border-border/30 rounded-md">
              {{ t('quickCommands.form.noVariables', '暂无变量。点击下方按钮添加。') }}
            </div>
            <div v-for="variable in localVariables" :key="variable.id" class="p-2.5 border border-border/40 rounded-lg bg-input/30 space-y-2">
              <input
                type="text"
                v-model="variable.name"
                :placeholder="t('quickCommands.form.variableNamePlaceholder', '变量名')"
                class="w-full px-3 py-1.5 border border-border/50 rounded-md bg-input text-foreground text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary"
              />
              <textarea
                v-model="variable.value"
                :placeholder="t('quickCommands.form.variableValuePlaceholder', '变量值')"
                rows="2"
                class="w-full px-3 py-1.5 border border-border/50 rounded-md bg-input text-foreground text-xs resize-y min-h-[40px] shadow-sm focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary"
              ></textarea>
              <button
                type="button"
                @click="deleteVariable(variable.id)"
                class="w-full py-1 px-3 text-xs text-error hover:bg-error/10 border border-error/50 rounded-md transition-colors duration-150"
              >
                {{ t('common.delete', '删除') }}
              </button>
            </div>
          </div>
          <button type="button" @click="addVariable" class="mt-3 w-full py-2 px-4 border border-primary/50 text-primary text-sm rounded-md hover:bg-primary/10 transition-colors duration-150">
            {{ t('quickCommands.form.addVariable', '+ 添加变量') }}
          </button>
        </div>

        <!-- 右侧：现有表单 -->
        <form @submit.prevent="handleSubmit" class="w-2/3 space-y-5 flex flex-col">
          <div class="flex-grow space-y-5 pr-1 flex flex-col">
            <div>
              <label for="qc-name" class="block mb-1.5 text-sm font-medium text-text-secondary">{{ t('quickCommands.form.name', '名称:') }}</label>
              <input
                id="qc-name"
                type="text"
                v-model="formData.name"
                :placeholder="t('quickCommands.form.namePlaceholder', '可选，用于快速识别')"
                class="w-full px-4 py-2 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
              />
            </div>
            <div class="flex flex-col flex-grow">
              <label for="qc-command" class="block mb-1.5 text-sm font-medium text-text-secondary">{{ t('quickCommands.form.command', '指令:') }} <span class="text-error">*</span></label>
              <textarea
                id="qc-command"
                v-model="formData.command"
                required
                :placeholder="placeholder"
                class="w-full px-4 py-2 border border-border/50 rounded-lg bg-input text-foreground text-sm min-h-[80px] shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out whitespace-nowrap overflow-x-auto flex-grow"
              ></textarea>
              <small v-if="commandError" class="text-error text-xs mt-1 block">{{ commandError }}</small>
            </div>
            <!-- 标签输入区 -->
            <div>
              <label for="qc-tags" class="block mb-1.5 text-sm font-medium text-text-secondary">{{ t('quickCommands.form.tags', '标签:') }}</label>
              <TagInput
                id="qc-tags"
                v-model="formData.tagIds"
                :available-tags="quickCommandTagsStore.tags"
                :placeholder="t('quickCommands.form.tagsPlaceholder', '添加或选择标签...')"
                @create-tag="handleCreateTag"
                :allow-create="true"
                :allow-delete="true"
                @delete-tag="handleDeleteTag"
                class="w-full"
              />
            </div>
          </div>
          <!-- 底部按钮区 -->
          <div class="flex justify-end mt-auto pt-4 border-t border-border/50">
            <button type="button" @click="closeForm" class="py-2 px-5 rounded-lg text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground mr-3">{{ t('common.cancel', '取消') }}</button>
            <button type="button" @click="handleExecute" class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-[var(--color-success)] text-white border-none shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-success)] mr-3">
              {{ t('quickCommands.form.execute', '执行') }}
            </button>
            <button type="submit" :disabled="isSubmitting || !!commandError" class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-primary text-white border-none shadow-md hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">
              {{ isSubmitting ? t('common.saving', '保存中...') : (isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')) }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useResizable } from '../composables/useResizable';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useI18n } from 'vue-i18n';
import { useQuickCommandsStore, type QuickCommandFE } from '../stores/quickCommands.store';
import { useQuickCommandTagsStore } from '../stores/quickCommandTags.store';
import { useSessionStore } from '../stores/session.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store'; 
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents'; 
import TagInput from './TagInput.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog'; 

const props = defineProps<{
    commandToEdit?: QuickCommandFE | null; // 接收要编辑的指令对象 (应包含标签ID和变量)
}>();

const emit = defineEmits(['close']);

const { isMobile } = useDeviceDetection();
const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog(); 
const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore(); 
const sessionStore = useSessionStore(); 
const uiNotificationsStore = useUiNotificationsStore(); 
const emitWorkspaceEvent = useWorkspaceEventEmitter(); 
const isSubmitting = ref(false);

const modalContentRef = ref<HTMLElement | null>(null);
const R_MIN_WIDTH = 800; // 可调整大小的最小宽度 (像素)
const R_MIN_HEIGHT = 700; // 可调整大小的最小高度 (像素)
const placeholder = t('quickCommands.form.commandPlaceholder') + 'echo "Hello,\${USERNAME}"';

const { width: resizableWidth, height: resizableHeight } = useResizable(modalContentRef, {
  minWidth: R_MIN_WIDTH,
  minHeight: R_MIN_HEIGHT,
});

const isEditing = computed(() => !!props.commandToEdit);

const formData = reactive({
    name: '',
    command: '',
    tagIds: [] as number[],
});
const localVariables = ref<{ name: string; value: string; id: string }[]>([]);

const commandError = ref<string | null>(null);

// 监听指令内容变化，进行校验
watch(() => formData.command, (newCommand) => {
  if (!newCommand || newCommand.trim().length === 0) {
    commandError.value = t('quickCommands.form.errorCommandRequired', '指令内容不能为空');
  } else {
    commandError.value = null;
  }
});

// 初始化表单数据
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

  if (isEditing.value && props.commandToEdit) {
    formData.name = props.commandToEdit.name ?? '';
    formData.command = props.commandToEdit.command;
    formData.tagIds = props.commandToEdit.tagIds ? [...props.commandToEdit.tagIds] : [];
    if (props.commandToEdit.variables) {
      localVariables.value = Object.entries(props.commandToEdit.variables).map(([name, value]) => ({
        name,
        value,
        id: `var-${Date.now()}-${Math.random().toString(36).substring(7)}`
      }));
    } else {
      localVariables.value = [];
    }
  }
});

const handleCreateTag = async (tagName: string) => {
    if (!tagName || tagName.trim().length === 0) return;
    const newTag = await quickCommandTagsStore.addTag(tagName.trim());
    if (newTag && !formData.tagIds.includes(newTag.id)) {
        formData.tagIds.push(newTag.id);
    }
};

const handleDeleteTag = async (tagId: number) => {
    const tagToDelete = quickCommandTagsStore.tags.find(t => t.id === tagId);
    if (!tagToDelete) return;

    const confirmed = await showConfirmDialog({
        message: t('tags.prompts.confirmDelete', { name: tagToDelete.name })
    });
    if (confirmed) {
        const success = await quickCommandTagsStore.deleteTag(tagId);
        if (success) {
            const index = formData.tagIds.indexOf(tagId);
            if (index > -1) {
                 formData.tagIds.splice(index, 1);
            }
        } else {
             showAlertDialog({ title: t('common.error', '错误'), message: t('tags.errorDelete', { error: quickCommandTagsStore.error || '未知错误' }) });
        }
    }
};

const handleSubmit = async () => {
  if (commandError.value) return;

  isSubmitting.value = true;
  let success = false;

  const finalName = formData.name.trim().length > 0 ? formData.name.trim() : null;

  const variablesToSave: Record<string, string> = localVariables.value.reduce((acc, curr) => {
    if (curr.name.trim()) {
      acc[curr.name.trim()] = curr.value;
    }
    return acc;
  }, {} as Record<string, string>);

  if (isEditing.value && props.commandToEdit) {
    success = await quickCommandsStore.updateQuickCommand(props.commandToEdit.id, finalName, formData.command.trim(), formData.tagIds, variablesToSave);
  } else {
    success = await quickCommandsStore.addQuickCommand(finalName, formData.command.trim(), formData.tagIds, variablesToSave);
  }

  isSubmitting.value = false;
  if (success) {
    closeForm();
  }
};

const closeForm = () => {
  emit('close');
};

const addVariable = () => {
  localVariables.value.push({
    name: '',
    value: '',
    id: `var-${Date.now()}-${Math.random().toString(36).substring(7)}`
  });
};

const deleteVariable = (variableId: string) => {
  localVariables.value = localVariables.value.filter(v => v.id !== variableId);
};

const handleExecute = () => {
  let processedCommand = formData.command;
  const currentVariables = localVariables.value.reduce((acc, curr) => {
    if (curr.name.trim()) {
      acc[curr.name.trim()] = curr.value;
    }
    return acc;
  }, {} as Record<string, string>);

  for (const varName in currentVariables) {
    const placeholder = new RegExp(`\\$\\{${varName}\\}`, 'g');
    processedCommand = processedCommand.replace(placeholder, currentVariables[varName]);
  }

  const variablePlaceholders = formData.command.match(/\$\{[^\}]+\}/g) || [];
  const undefinedVariables: string[] = [];
  variablePlaceholders.forEach(placeholder => {
    const varName = placeholder.substring(2, placeholder.length - 1);
    if (!currentVariables.hasOwnProperty(varName)) {
      undefinedVariables.push(varName);
    }
  });

  if (undefinedVariables.length > 0) {
    uiNotificationsStore.showWarning(
      t('quickCommands.form.warningUndefinedVariables', { variables: undefinedVariables.join(', ') })
    );
  }

  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) {
    uiNotificationsStore.showError(t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。'));
    return;
  }

  emitWorkspaceEvent('quickCommand:executeProcessed', {
    command: processedCommand,
    sessionId: activeSessionId
  });

  closeForm(); 
};
</script>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}

/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.24s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .mobile-form-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-form-sheet {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-form-sheet,
.bottom-sheet-leave-to .mobile-form-sheet {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
