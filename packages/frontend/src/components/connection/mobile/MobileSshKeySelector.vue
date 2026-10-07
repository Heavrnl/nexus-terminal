<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSshKeysStore } from '../../../stores/sshKeys.store';
import MobileSelectDrawer, { type MobileSelectOption } from '../../common/MobileSelectDrawer.vue';
import MobileSshKeyManagementModal from '../../MobileSshKeyManagementModal.vue';

const props = defineProps<{
  modelValue: number | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', val: number | null): void;
}>();

const { t } = useI18n();
const sshKeysStore = useSshKeysStore();

const isManagementModalOpen = ref(false);

const keys = computed(() => sshKeysStore.sshKeys);
const isLoading = computed(() => sshKeysStore.isLoading);

// 将密钥列表转换为移动端选择器选项
const keyOptions = computed<MobileSelectOption[]>(() => {
  return [
    {
      value: null,
      label: '未选择密钥 (请选择)',
      icon: 'fas fa-shield-alt',
    },
    ...keys.value.map(k => ({
      value: k.id,
      label: k.name,
      sublabel: `密钥 ID: ${k.id}`,
      icon: 'fas fa-key',
    })),
  ];
});

const handleValueUpdate = (val: number | null) => {
  emit('update:modelValue', val);
};

const openManagementModal = () => {
  isManagementModalOpen.value = true;
  sshKeysStore.fetchSshKeys();
};

const closeManagementModal = () => {
  isManagementModalOpen.value = false;
  sshKeysStore.fetchSshKeys();
};
</script>

<template>
  <div class="mobile-ssh-key-selector-wrapper flex items-center gap-2">
    <!-- 移动端抽屉选择器 -->
    <div class="flex-grow min-w-0">
      <MobileSelectDrawer
        :model-value="props.modelValue"
        :options="keyOptions"
        title="选择 SSH 登录密钥"
        placeholder="点击选择已存储的密钥..."
        :disabled="isLoading"
        icon="fas fa-key"
        :allow-clear="true"
        @update:model-value="handleValueUpdate"
      />
    </div>

    <!-- 管理密钥入口按钮 (大触控区) -->
    <button
      type="button"
      @click="openManagementModal"
      :disabled="isLoading"
      class="w-10 h-10 rounded-xl bg-header/40 border border-border/60 text-text-secondary hover:text-foreground active:scale-95 flex items-center justify-center shrink-0 transition-all cursor-pointer shadow-2xs"
      :title="t('sshKeys.selector.manageKeysTitle', '管理 SSH 密钥库')"
    >
      <i class="fas fa-cog text-xs"></i>
    </button>

    <!-- 移动端密钥管理抽屉 -->
    <MobileSshKeyManagementModal
      v-if="isManagementModalOpen"
      @close="closeManagementModal"
    />
  </div>
</template>
