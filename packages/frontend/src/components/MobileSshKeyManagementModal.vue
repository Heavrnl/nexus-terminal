<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSshKeysStore, type SshKeyBasicInfo, type SshKeyInput } from '../stores/sshKeys.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const emit = defineEmits(['close']);

const { t } = useI18n();
const sshKeysStore = useSshKeysStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const keys = computed(() => sshKeysStore.sshKeys);
const isLoading = computed(() => sshKeysStore.isLoading);

// 视图切换：列表 vs 表单
const isAddEditFormVisible = ref(false);
const keyToEdit = ref<SshKeyBasicInfo | null>(null);

// 密码眼睛切换
const showPassphrase = ref(false);

// 表单数据
const initialFormData: SshKeyInput = {
  name: '',
  private_key: '',
  passphrase: '',
};
const formData = reactive({ ...initialFormData });
const formError = ref<string | null>(null);

onMounted(() => {
  sshKeysStore.fetchSshKeys();
});

// 打开新建密钥表单
const showAddForm = () => {
  keyToEdit.value = null;
  Object.assign(formData, initialFormData);
  formError.value = null;
  showPassphrase.value = false;
  isAddEditFormVisible.value = true;
};

// 打开编辑密钥表单
const showEditForm = async (key: SshKeyBasicInfo) => {
  formError.value = null;
  keyToEdit.value = key;
  showPassphrase.value = false;

  const details = await sshKeysStore.fetchDecryptedSshKey(key.id);
  if (details) {
    formData.name = details.name;
    formData.private_key = ''; // 留空表示不修改
    formData.passphrase = '';
    isAddEditFormVisible.value = true;
  } else {
    uiNotificationsStore.addNotification({
      message: t('sshKeys.modal.errorFetchDetails', '获取密钥详情失败'),
      type: 'error'
    });
    keyToEdit.value = null;
  }
};

// 返回密钥列表
const cancelForm = () => {
  isAddEditFormVisible.value = false;
  keyToEdit.value = null;
  formError.value = null;
};

// 一键粘贴剪贴板中的私钥
const pastePrivateKeyFromClipboard = async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        formData.private_key = text;
        uiNotificationsStore.showSuccess('已从剪贴板粘贴私钥内容');
      } else {
        uiNotificationsStore.showWarning('剪贴板内容为空');
      }
    } else {
      uiNotificationsStore.showWarning('当前浏览器环境不支持一键读取剪贴板，请手动长按粘贴');
    }
  } catch (err: any) {
    uiNotificationsStore.showWarning('读取剪贴板失败，请手动长按粘贴');
  }
};

// 提交表单
const handleSubmit = async () => {
  formError.value = null;
  if (!formData.name || (!keyToEdit.value && !formData.private_key)) {
    formError.value = t('sshKeys.modal.errorRequiredFields', '请填写所有必填字段');
    return;
  }

  let success = false;
  const dataToSend: Partial<SshKeyInput> = {
    name: formData.name.trim(),
  };

  if (formData.private_key.trim()) {
    dataToSend.private_key = formData.private_key.trim();
  }
  if (formData.passphrase) {
    dataToSend.passphrase = formData.passphrase;
  }

  if (keyToEdit.value) {
    success = await sshKeysStore.updateSshKey(keyToEdit.value.id, dataToSend);
  } else {
    success = await sshKeysStore.addSshKey(dataToSend as SshKeyInput);
  }

  if (success) {
    isAddEditFormVisible.value = false;
    keyToEdit.value = null;
  } else {
    formError.value = sshKeysStore.error;
  }
};

// 删除密钥
const handleDelete = async (key: SshKeyBasicInfo) => {
  const confirmed = await showConfirmDialog({
    message: t('sshKeys.modal.confirmDelete', { name: key.name }, `确定要删除 SSH 密钥“${key.name}”吗？此操作无法撤销。`)
  });
  if (confirmed) {
    const success = await sshKeysStore.deleteSshKey(key.id);
    if (success && keyToEdit.value?.id === key.id) {
      isAddEditFormVisible.value = false;
      keyToEdit.value = null;
    }
  }
};
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
    @click.self="emit('close')"
  >
    <div
      class="mobile-ssh-key-sheet w-full max-h-[92vh] h-[92vh] flex flex-col bg-background border-t border-border/50 rounded-t-2xl shadow-2xl overflow-hidden select-text"
    >
      <!-- 1. 吸顶顶栏 -->
      <div class="shrink-0 pt-2.5 pb-2.5 px-4 border-b border-border/40 bg-header/40 select-none">
        <!-- 拖拽手柄条 -->
        <div class="w-10 h-1 bg-border/80 rounded-full mx-auto mb-2 cursor-pointer" @click="emit('close')"></div>

        <div class="flex items-center justify-between">
          <!-- 表单模式：返回列表按钮；列表模式：收起抽屉按钮 -->
          <button
            v-if="isAddEditFormVisible"
            type="button"
            @click="cancelForm"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/60 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 transition-all cursor-pointer -ml-1 shrink-0"
            :title="t('common.back', '返回列表')"
            :aria-label="t('common.back', '返回列表')"
          >
            <i class="fas fa-chevron-left text-xs"></i>
          </button>
          <button
            v-else
            type="button"
            @click="emit('close')"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/60 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 transition-all cursor-pointer -ml-1 shrink-0"
            :title="t('common.close', '关闭')"
            :aria-label="t('common.close', '关闭')"
          >
            <i class="fas fa-chevron-down text-xs"></i>
          </button>

          <!-- 居中标题 -->
          <div class="flex items-center gap-1.5 min-w-0 px-2">
            <span class="text-sm font-semibold text-foreground tracking-tight truncate max-w-[150px]">
              {{ isAddEditFormVisible
                ? (keyToEdit ? t('sshKeys.modal.editTitle', '编辑 SSH 密钥') : t('sshKeys.modal.addTitle', '添加 SSH 密钥'))
                : t('sshKeys.modal.title', 'SSH 密钥管理') }}
            </span>
          </div>

          <!-- 右侧动作按钮：表单模式下为保存；列表模式下为新建 -->
          <button
            v-if="isAddEditFormVisible"
            type="button"
            @click="handleSubmit"
            :disabled="isLoading"
            class="px-3.5 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 disabled:opacity-50 transition-all shadow-xs flex items-center gap-1.5 -mr-1 cursor-pointer whitespace-nowrap shrink-0"
          >
            <i v-if="isLoading" class="fas fa-spinner fa-spin text-xs shrink-0"></i>
            <span>{{ keyToEdit ? t('common.save', '保存') : t('common.add', '添加') }}</span>
          </button>
          <button
            v-else
            type="button"
            @click="showAddForm"
            :disabled="isLoading"
            class="w-8 h-8 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 disabled:opacity-50 transition-all shadow-xs flex items-center justify-center -mr-1 cursor-pointer shrink-0"
            :title="t('sshKeys.modal.addKey', '新建密钥')"
            :aria-label="t('sshKeys.modal.addKey', '新建密钥')"
          >
            <i class="fas fa-plus text-xs"></i>
          </button>
        </div>
      </div>

      <!-- 2. 内容主体 -->
      <div class="flex-grow overflow-y-auto px-4 py-3.5 overscroll-contain">
        <!-- ==================== 视图 A：密钥列表卡片流 ==================== -->
        <div v-if="!isAddEditFormVisible" class="space-y-3 pb-8">
          <div v-if="isLoading && keys.length === 0" class="py-16 text-center text-xs text-text-secondary">
            <i class="fas fa-spinner fa-spin text-lg mb-2 block text-primary"></i>
            <span>{{ t('sshKeys.modal.loading', '加载密钥列表中...') }}</span>
          </div>

          <div v-else-if="keys.length === 0" class="py-16 text-center space-y-3">
            <div class="w-12 h-12 rounded-2xl bg-header/60 text-text-secondary flex items-center justify-center mx-auto text-xl">
              <i class="fas fa-key"></i>
            </div>
            <div class="text-xs text-text-secondary">{{ t('sshKeys.modal.noKeys', '暂无存储的 SSH 密钥') }}</div>
            <button
              type="button"
              @click="showAddForm"
              class="h-9 px-4 rounded-xl bg-primary/10 text-primary font-semibold text-xs hover:bg-primary/20 active:scale-95 transition-all inline-flex items-center gap-1.5 cursor-pointer"
            >
              <i class="fas fa-plus text-xs"></i>
              <span>创建第一个密钥</span>
            </button>
          </div>

          <div v-else class="space-y-2.5">
            <div
              v-for="key in keys"
              :key="key.id"
              class="p-3.5 bg-background border border-border/60 rounded-2xl shadow-2xs flex items-center justify-between gap-3 transition-colors active:bg-header/20"
            >
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center text-sm shrink-0">
                  <i class="fas fa-id-badge"></i>
                </div>
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-foreground truncate">
                    {{ key.name }}
                  </div>
                  <div class="text-[11px] text-text-secondary/70 mt-0.5 font-mono">
                    ID: {{ key.id }}
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  @click="showEditForm(key)"
                  :disabled="isLoading"
                  class="w-8 h-8 rounded-xl bg-header/60 hover:bg-header text-text-secondary hover:text-foreground active:scale-95 flex items-center justify-center transition-all cursor-pointer shrink-0"
                  :title="t('sshKeys.modal.edit', '编辑')"
                  :aria-label="t('sshKeys.modal.edit', '编辑')"
                >
                  <i class="fas fa-pencil-alt text-xs text-primary"></i>
                </button>
                <button
                  type="button"
                  @click="handleDelete(key)"
                  :disabled="isLoading"
                  class="w-8 h-8 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500 active:scale-95 flex items-center justify-center transition-all cursor-pointer shrink-0"
                  :title="t('sshKeys.modal.delete', '删除')"
                  :aria-label="t('sshKeys.modal.delete', '删除')"
                >
                  <i class="fas fa-trash-alt text-xs shrink-0"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ==================== 视图 B：添加 / 编辑密钥表单 ==================== -->
        <div v-else class="space-y-4 pb-8">
          <!-- 错误提示 -->
          <div v-if="formError" class="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs font-medium">
            {{ formError }}
          </div>

          <!-- 密钥名称 -->
          <div class="space-y-1.5">
            <label for="m-key-name" class="block text-xs font-medium text-text-secondary">
              {{ t('sshKeys.modal.keyName', '密钥名称') }} <span class="text-red-400">*</span>
            </label>
            <input
              type="text"
              id="m-key-name"
              v-model="formData.name"
              required
              placeholder="例如：id_rsa / 公司跳板机密钥"
              class="w-full h-10 px-3 text-xs bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
            />
          </div>

          <!-- 私钥文本域 -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label for="m-key-private" class="block text-xs font-medium text-text-secondary">
                {{ t('sshKeys.modal.privateKey', '私钥内容') }}
                <span v-if="!keyToEdit" class="text-red-400">*</span>
                <span v-else class="text-[11px] text-text-secondary/70 ml-1">(留空保持原私钥)</span>
              </label>

              <!-- 便捷粘贴与清空工具条 -->
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  @click="pastePrivateKeyFromClipboard"
                  class="text-[11px] text-primary flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-primary/10 active:scale-95 transition-all cursor-pointer whitespace-nowrap shrink-0"
                >
                  <i class="fas fa-paste text-[10px] shrink-0"></i>
                  <span>粘贴剪贴板</span>
                </button>
                <button
                  v-if="formData.private_key"
                  type="button"
                  @click="formData.private_key = ''"
                  class="text-[11px] text-text-secondary hover:text-red-400 px-1.5 py-0.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  清空
                </button>
              </div>
            </div>

            <textarea
              id="m-key-private"
              v-model="formData.private_key"
              rows="7"
              :required="!keyToEdit"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
              class="w-full p-3 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors leading-relaxed"
            ></textarea>
          </div>

          <!-- 密码短语 Passphrase -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label for="m-key-passphrase" class="block text-xs font-medium text-text-secondary">
                {{ t('sshKeys.modal.passphrase', '密钥口令短语') }}
              </label>
              <span class="text-[11px] text-text-secondary/70">可选，若密钥未加密请留空</span>
            </div>

            <div class="relative flex items-center">
              <input
                :type="showPassphrase ? 'text' : 'password'"
                id="m-key-passphrase"
                v-model="formData.passphrase"
                autocomplete="new-password"
                placeholder="私钥解锁口令 (如果有)"
                class="w-full h-10 pl-3 pr-10 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
              />
              <button
                type="button"
                @click="showPassphrase = !showPassphrase"
                class="absolute right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 cursor-pointer"
                :title="showPassphrase ? '隐藏口令' : '显示口令'"
              >
                <i :class="['fas text-xs', showPassphrase ? 'fa-eye-slash text-primary' : 'fa-eye']"></i>
              </button>
            </div>
          </div>

          <!-- 底部确认提交按钮 -->
          <div class="pt-3">
            <button
              type="button"
              @click="handleSubmit"
              :disabled="isLoading"
              class="w-full h-10 rounded-xl bg-primary text-primary-foreground font-semibold text-xs shadow-xs hover:bg-primary/90 active:scale-98 disabled:opacity-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <i v-if="isLoading" class="fas fa-spinner fa-spin text-xs"></i>
              <span>{{ keyToEdit ? t('sshKeys.modal.saveChanges', '保存更改') : t('sshKeys.modal.addKey', '添加密钥') }}</span>
            </button>
          </div>
        </div>

        <!-- 底部手势安全垫高 -->
        <div class="h-6 shrink-0"></div>
      </div>
    </div>
  </div>
</template>
