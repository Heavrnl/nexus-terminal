<script setup lang="ts">
import { ref, computed, watch, type PropType, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

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
  <MobileBottomSheet
    :visible="props.isVisible"
    height="h-auto"
    max-height="max-h-[85vh]"
    :z-index="100"
    @close="closeModal"
  >
    <!-- 顶栏左侧标题与图标 -->
    <template #header-left>
      <div class="flex items-center gap-2">
        <i :class="actionIconClass"></i>
        <h3 class="text-base font-semibold text-foreground">{{ modalTitle }}</h3>
      </div>
    </template>

    <div class="px-4 py-3 space-y-3.5">
      <!-- 表单内容区 -->
      <div>
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
          class="flex-1 h-11 rounded-xl bg-header/60 border border-border/80 text-foreground font-medium text-sm active:scale-95 transition-transform cursor-pointer"
        >
          {{ t('fileManager.modals.buttons.cancel', '取消') }}
        </button>
        <button
          @click="confirmAction"
          type="button"
          :disabled="isConfirmDisabled"
          class="flex-1 h-11 rounded-xl font-medium text-sm text-white active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          :class="{
            'bg-rose-600 active:bg-rose-700': actionType === 'delete',
            'bg-primary active:bg-primary-hover': actionType !== 'delete'
          }"
        >
          {{ confirmButtonText }}
        </button>
      </div>
    </div>
  </MobileBottomSheet>
</template>
