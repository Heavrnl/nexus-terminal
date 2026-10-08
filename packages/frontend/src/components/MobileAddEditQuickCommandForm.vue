<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TagInput from './TagInput.vue';
import { useQuickCommandsStore, type QuickCommandFE } from '../stores/quickCommands.store';
import { useQuickCommandTagsStore } from '../stores/quickCommandTags.store';
import { useSessionStore } from '../stores/session.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

interface LocalVariable {
  id: string;
  name: string;
  value: string;
}

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
const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore();
const sessionStore = useSessionStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();
const emitWorkspaceEvent = useWorkspaceEventEmitter();

const isEditing = computed(() => !!(props.commandToEdit && props.commandToEdit.id > 0));
const isSubmitting = ref(false);
const commandError = ref<string | null>(null);

const formData = reactive({
  name: '',
  command: '',
  tagIds: [] as number[],
});

const localVariables = ref<LocalVariable[]>([]);

const placeholder = computed(() => {
  return t('quickCommands.form.commandPlaceholder', '例如：\necho "Hello World"\n支持变量：${VARIABLE_NAME}');
});

watch(() => formData.command, (newCommand) => {
  if (!newCommand || newCommand.trim().length === 0) {
    commandError.value = t('quickCommands.form.errorCommandRequired', '指令内容不能为空');
  } else {
    commandError.value = null;
  }
});

onMounted(() => {
  if (isEditing.value && props.commandToEdit) {
    formData.name = props.commandToEdit.name ?? '';
    formData.command = props.commandToEdit.command;
    formData.tagIds = props.commandToEdit.tagIds ? [...props.commandToEdit.tagIds] : [];
    if (props.commandToEdit.variables) {
      localVariables.value = Object.entries(props.commandToEdit.variables).map(([name, value]) => ({
        name,
        value: String(value ?? ''),
        id: `var-${Date.now()}-${Math.random().toString(36).substring(7)}`
      }));
    } else {
      localVariables.value = [];
    }
  } else if (props.initialCommand) {
    formData.command = props.initialCommand;
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

const closeForm = () => {
  emit('close');
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
        <span>{{ isSubmitting ? t('common.saving', '保存中...') : (isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')) }}</span>
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
  </MobileBottomSheet>
</template>

<style scoped>
.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
