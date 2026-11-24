<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ConnectionInfo } from '../stores/connections.store';
import { useAddConnectionForm } from '../composables/useAddConnectionForm';
import AddConnectionFormBasicInfo from './AddConnectionFormBasicInfo.vue';
import AddConnectionFormAuth from './AddConnectionFormAuth.vue';
import AddConnectionFormAdvanced from './AddConnectionFormAdvanced.vue';
import ScriptImportPanel from './connection/ScriptImportPanel.vue';

// 定义组件发出的事件
const emit = defineEmits(['close', 'connection-added', 'connection-updated', 'connection-deleted']);

interface Props {
  connectionToEdit: ConnectionInfo | null;
}

const props = defineProps<Props>();

const { t } = useI18n();

const {
  formData,
  isSubmitting,
  testStatus,
  testResult,
  isScriptModeActive,
  scriptInputText,
  isEditMode,
  formTitle,
  submitButtonText,
  proxies,
  folders,
  connections,
  isProxyLoading,
  proxyStoreError,
  isFolderLoading,
  folderStoreError,
  advancedConnectionMode,
  addJumpHost,
  removeJumpHost,
  handleSubmit,
  handleDeleteConnection,
  handleTestConnection,
  handleCreateFolder,
  handleDeleteFolder,
  latencyColor,
  testButtonText,
} = useAddConnectionForm(props, emit);

const handleAdvancedConnectionModeUpdate = (newMode: 'proxy' | 'jump') => {
  advancedConnectionMode.value = newMode;
};

// 监听 Esc 键快速关闭弹窗
const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !isSubmitting.value && testStatus.value !== 'testing') {
    emit('close');
  }
};

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/60 backdrop-blur-xs select-none animate-fadeIn"
    @click.self="emit('close')"
  >
    <div
      class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] md:max-h-[86vh] flex flex-col overflow-hidden"
      style="background-color: var(--app-bg-color);"
      @click.stop
    >
      <!-- 顶部 Header 栏：与卡片浑然一体 -->
      <header class="flex justify-between items-center px-5 py-3.5 border-b border-border/50 flex-shrink-0 select-none">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center text-primary">
            <i :class="isEditMode ? 'fas fa-edit' : 'fas fa-plug'" class="text-sm"></i>
          </div>
          <div class="flex items-center gap-2">
            <h2 class="text-sm md:text-base font-bold text-foreground tracking-tight leading-none">
              {{ formTitle }}
            </h2>
            <span
              class="text-[11px] px-2 py-0.5 rounded-full font-semibold border"
              :class="formData.type === 'SSH' ? 'bg-primary/15 text-primary border-primary/25' : 'bg-muted text-text-secondary border-border/60'"
            >
              {{ formData.type }}
            </span>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <!-- 快捷脚本导入模式药丸切换 (仅新建模式可用) -->
          <button
            v-if="!isEditMode"
            type="button"
            @click="isScriptModeActive = !isScriptModeActive"
            class="px-2.5 py-1 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs"
            :class="isScriptModeActive
              ? 'bg-primary text-white border-primary shadow-xs font-semibold'
              : 'bg-muted/40 hover:bg-muted/80 text-text-secondary hover:text-foreground border-border/60'"
          >
            <i class="fas fa-file-code text-[11px]"></i>
            <span>{{ t('connections.form.sectionScriptMode', '脚本模式') }}</span>
          </button>

          <button
            type="button"
            @click="emit('close')"
            class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
            title="Esc"
          >
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>
      </header>

      <!-- 中间表单滚动区：与外壳浑然一体 -->
      <form
        @submit.prevent="handleSubmit"
        class="flex-grow overflow-y-auto p-4 md:p-5 space-y-4 min-h-0"
      >
        <!-- 正常表单卡片模式 -->
        <template v-if="!isScriptModeActive">
          <AddConnectionFormBasicInfo
            :form-data="formData"
            :folders="folders"
            :is-folder-loading="isFolderLoading"
            :folder-store-error="folderStoreError"
            @create-folder="handleCreateFolder"
          />
          <AddConnectionFormAuth :form-data="formData" :is-edit-mode="isEditMode" />
          <AddConnectionFormAdvanced
            :form-data="formData"
            :proxies="proxies"
            :connections="connections"
            :is-proxy-loading="isProxyLoading"
            :proxy-store-error="proxyStoreError"
            :advanced-connection-mode="advancedConnectionMode"
            @update:advancedConnectionMode="handleAdvancedConnectionModeUpdate"
            :add-jump-host="addJumpHost"
            :remove-jump-host="removeJumpHost"
            :is-edit-mode="isEditMode"
          />
        </template>

        <!-- 脚本批量导入卡片 -->
        <div
          v-else
          class="rounded-2xl border border-border/70 surface-raised p-4 md:p-5 space-y-3 shadow-sm"
        >
          <div class="flex items-center justify-between pb-2 border-b border-border/50">
            <div class="flex items-center gap-2">
              <div class="w-6 h-6 rounded-md bg-primary/15 text-primary flex items-center justify-center text-xs">
                <i class="fas fa-code"></i>
              </div>
              <h4 class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('connections.form.sectionScriptMode', '脚本模式批量导入') }}</h4>
            </div>
          </div>
          <ScriptImportPanel v-model="scriptInputText" />
        </div>
      </form>

      <!-- 底部 Footer 动作栏：与外壳浑然一体 -->
      <footer class="flex items-center justify-between px-5 py-3.5 border-t border-border/50 flex-shrink-0 select-none">
        <!-- 左侧：测试连通性状态 -->
        <div class="flex items-center gap-2 min-w-0">
          <template v-if="formData.type === 'SSH' && !isScriptModeActive">
            <button
              type="button"
              @click="handleTestConnection"
              :disabled="isSubmitting || testStatus === 'testing'"
              class="px-3 py-1.5 border border-border/60 rounded-xl text-xs font-medium text-text-secondary hover:text-foreground bg-muted/40 hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 transition-all shadow-2xs cursor-pointer active:scale-95"
            >
              <i v-if="testStatus === 'testing'" class="fas fa-spinner fa-spin text-primary text-xs"></i>
              <i v-else class="fas fa-satellite-dish text-primary text-xs"></i>
              <span>{{ testButtonText }}</span>
            </button>

            <!-- 测速结果徽标 -->
            <div v-if="testStatus === 'testing'" class="text-xs text-text-secondary animate-pulse flex items-center gap-1">
              <span>{{ t('connections.test.testingInProgress', '测试中...') }}</span>
            </div>
            <div
              v-else-if="testStatus === 'success'"
              class="text-xs font-semibold px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20"
              :style="{ color: latencyColor || '#10b981' }"
            >
              <i class="fas fa-check-circle mr-1"></i>
              <span>{{ testResult }}</span>
            </div>
            <div
              v-else-if="testStatus === 'error'"
              class="text-xs font-medium px-2 py-0.5 rounded-full border bg-error/10 border-error/20 text-error truncate max-w-[200px]"
              :title="testResult ? String(testResult) : undefined"
            >
              <i class="fas fa-exclamation-triangle mr-1"></i>
              <span>{{ testResult }}</span>
            </div>
          </template>
        </div>

        <!-- 右侧：取消、删除、提交操作组 -->
        <div class="flex items-center gap-2.5">
          <button
            type="button"
            @click="emit('close')"
            :disabled="isSubmitting || (formData.type === 'SSH' && testStatus === 'testing')"
            class="px-3.5 py-1.5 text-xs font-medium text-text-secondary hover:text-foreground hover:bg-muted/60 rounded-xl border border-border/70 transition-colors cursor-pointer"
          >
            {{ t('connections.form.cancel', '取消') }}
          </button>

          <button
            v-if="isEditMode && !isScriptModeActive"
            type="button"
            @click="handleDeleteConnection"
            :disabled="isSubmitting || (formData.type === 'SSH' && testStatus === 'testing')"
            class="px-3.5 py-1.5 text-xs font-medium text-error hover:bg-error/10 rounded-xl border border-error/40 transition-colors cursor-pointer disabled:opacity-50"
          >
            <i class="fas fa-trash-alt mr-1"></i>
            {{ t('connections.actions.delete', '删除') }}
          </button>

          <button
            type="button"
            @click="handleSubmit"
            :disabled="isSubmitting || (formData.type === 'SSH' && testStatus === 'testing')"
            class="px-4 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-primary-hover active:scale-95 rounded-xl shadow-xs hover:shadow-primary/30 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <i v-if="isEditMode" class="fas fa-check text-xs"></i>
            <i v-else class="fas fa-plus text-xs"></i>
            <span>{{ submitButtonText }}</span>
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
