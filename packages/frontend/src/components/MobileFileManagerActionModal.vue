<script setup lang="ts">
import { ref, computed, watch, type PropType, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  actionType: {
    type: String as PropType<'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder' | null>,
    default: null,
  },
  item: {
    type: Object as PropType<FileListItem | null>,
    default: null,
  },
  items: {
    type: Array as PropType<FileListItem[]>,
    default: () => [],
  },
  initialValue: {
    type: String,
    default: '',
  },
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', value?: string): void;
}>();

const { t } = useI18n();
const inputValue = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

// 监听可见性状态并自动聚焦输入框
watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    inputValue.value = props.initialValue || '';
    nextTick(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
  }
});

const modalTitle = computed(() => {
  switch (props.actionType) {
    case 'delete':
      if (props.items.length > 1) {
        return t('fileManager.modals.titles.deleteMultiple', { count: props.items.length });
      } else if (props.items.length === 1) {
        return t('fileManager.modals.titles.delete', { name: props.items[0]?.filename || '' });
      } else {
        return t('fileManager.modals.titles.delete', { name: '' });
      }
    case 'rename':
      return t('fileManager.modals.titles.rename', { name: props.item?.filename || '' });
    case 'chmod':
      return t('fileManager.modals.titles.chmod', { name: props.item?.filename || '' });
    case 'newFile':
      return t('fileManager.modals.titles.newFile', '新建文件');
    case 'newFolder':
      return t('fileManager.modals.titles.newFolder', '新建文件夹');
    default:
      return '';
  }
});

// 操作类型对应图标
const actionIconClass = computed(() => {
  switch (props.actionType) {
    case 'delete':
      return 'fas fa-trash-alt text-rose-500';
    case 'rename':
      return 'fas fa-signature text-amber-500';
    case 'chmod':
      return 'fas fa-key text-teal-500';
    case 'newFile':
      return 'far fa-file-alt text-primary';
    case 'newFolder':
      return 'fas fa-folder-plus text-amber-500';
    default:
      return 'fas fa-info-circle text-primary';
  }
});

const confirmButtonText = computed(() => {
  switch (props.actionType) {
    case 'delete':
      return t('fileManager.modals.buttons.delete', '删除');
    case 'rename':
      return t('fileManager.modals.buttons.rename', '重命名');
    case 'chmod':
      return t('fileManager.modals.buttons.changePermissions', '修改权限');
    case 'newFile':
    case 'newFolder':
      return t('fileManager.modals.buttons.create', '创建');
    default:
      return t('fileManager.modals.buttons.confirm', '确认');
  }
});

const messageText = computed(() => {
  if (props.actionType === 'delete') {
    if (props.items.length > 1) {
      const names = props.items.map(i => i.filename).join(', ');
      return t('fileManager.modals.messages.confirmDeleteMultiple', { count: props.items.length, names: names });
    } else if (props.items.length === 1 && props.items[0]) {
      const singleItem = props.items[0];
      const type = singleItem.attrs.isDirectory
        ? t('fileManager.modals.labels.folder', '文件夹')
        : t('fileManager.modals.labels.文件', '文件');
      return t('fileManager.modals.messages.confirmDelete', { type: type, name: singleItem.filename });
    }
  }
  return '';
});

const showInput = computed(() => {
  return ['rename', 'chmod', 'newFile', 'newFolder'].includes(props.actionType || '');
});

const inputLabel = computed(() => {
  switch (props.actionType) {
    case 'rename':
      return t('fileManager.modals.labels.newName', '新名称：');
    case 'chmod':
      return t('fileManager.modals.labels.newPermissions', '权限数值 (8进制)：');
    case 'newFile':
      return t('fileManager.modals.labels.fileName', '文件名：');
    case 'newFolder':
      return t('fileManager.modals.labels.folderName', '文件夹名：');
    default:
      return '';
  }
});

const inputPlaceholder = computed(() => {
  switch (props.actionType) {
    case 'rename':
      return props.item?.filename || t('fileManager.modals.placeholders.newName', '请输入新名称');
    case 'chmod':
      return props.initialValue || '0755';
    case 'newFile':
      return t('fileManager.modals.placeholders.newFile', '请输入文件名');
    case 'newFolder':
      return t('fileManager.modals.placeholders.newFolder', '请输入文件夹名');
    default:
      return '';
  }
});

const isConfirmDisabled = computed(() => {
  if (!showInput.value) return false;
  if (!inputValue.value.trim()) return true;
  if (props.actionType === 'rename' && inputValue.value.trim() === props.item?.filename) return true;
  if (props.actionType === 'chmod' && !/^[0-7]{3,4}$/.test(inputValue.value.trim())) return true;
  return false;
});

const closeModal = () => {
  emit('close');
};

const confirmAction = () => {
  if (isConfirmDisabled.value && showInput.value) return;
  if (props.actionType === 'chmod' && inputValue.value.trim() && !/^[0-7]{3,4}$/.test(inputValue.value.trim())) {
    console.warn('Invalid chmod format submitted');
    return;
  }
  emit('confirm', inputValue.value.trim());
};
</script>

<template>
  <div v-if="props.isVisible" class="fixed inset-0 z-[100]">
    <div
      class="fixed inset-0 bg-black/60 backdrop-blur-xs flex flex-col justify-end select-none"
      @click.self="closeModal"
    >
      <div class="w-full bg-background rounded-t-2xl border-t border-border/80 shadow-2xl p-4 flex flex-col max-h-[85vh] overflow-y-auto">
        <!-- 顶部药丸手柄 -->
        <div class="pt-1 pb-2 flex justify-center cursor-pointer" @click="closeModal">
          <div class="w-10 h-1 bg-border/80 rounded-full"></div>
        </div>

        <!-- 顶栏标题 -->
        <div class="flex items-center justify-between pb-3 border-b border-border/40">
          <h3 class="text-base font-semibold text-foreground flex items-center gap-2">
            <i :class="actionIconClass"></i>
            <span>{{ modalTitle }}</span>
          </h3>
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header"
            @click="closeModal"
          >
            <i class="fas fa-times text-sm"></i>
          </button>
        </div>

        <!-- 表单内容区 -->
        <div class="py-4">
          <p v-if="actionType === 'delete'" class="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {{ messageText }}
          </p>

          <div v-if="showInput" class="space-y-2">
            <label :for="`fileManagerActionInput-mobile-${actionType}`" class="block text-xs font-medium text-text-secondary">
              {{ inputLabel }}
            </label>
            <input
              :id="`fileManagerActionInput-mobile-${actionType}`"
              ref="inputRef"
              type="text"
              v-model="inputValue"
              :placeholder="inputPlaceholder"
              class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
            />
            <p v-if="actionType === 'chmod' && inputValue.trim() && !/^[0-7]{3,4}$/.test(inputValue.trim())" class="text-xs text-rose-500">
              {{ t('fileManager.errors.invalidPermissionsFormat', '请输入有效的 8 进制权限格式 (例如 755 或 0755)') }}
            </p>
            <p v-else-if="actionType === 'chmod'" class="text-xs text-text-secondary">
              {{ t('fileManager.modals.chmodHelp', '格式为 3 或 4 位八进制数字，如 755 (rwxr-xr-x) 或 644 (rw-r--r--)') }}
            </p>
          </div>
        </div>

        <!-- 底部双大按钮并排操作区 -->
        <div class="flex items-center gap-3 pt-2">
          <button
            @click="closeModal"
            type="button"
            class="flex-1 h-11 rounded-xl bg-header/60 border border-border/80 text-foreground font-medium text-sm active:scale-95 transition-transform"
          >
            {{ t('fileManager.modals.buttons.cancel', '取消') }}
          </button>
          <button
            @click="confirmAction"
            type="button"
            :disabled="isConfirmDisabled"
            class="flex-1 h-11 rounded-xl font-medium text-sm text-white active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
            :class="{
              'bg-rose-600 active:bg-rose-700': actionType === 'delete',
              'bg-primary active:bg-primary-hover': actionType !== 'delete'
            }"
          >
            {{ confirmButtonText }}
          </button>
        </div>

        <!-- 底部安全区占位 -->
        <div class="h-[max(env(safe-area-inset-bottom,0px),8px)]"></div>
      </div>
    </div>
  </div>
</template>
