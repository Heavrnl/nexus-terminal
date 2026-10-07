<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConnectionInfo } from '../stores/connections.store';
import { useAddConnectionForm } from '../composables/useAddConnectionForm';
import MobileConnectionFormBasicInfo from './connection/mobile/MobileConnectionFormBasicInfo.vue';
import MobileConnectionFormAuth from './connection/mobile/MobileConnectionFormAuth.vue';
import MobileConnectionFormAdvanced from './connection/mobile/MobileConnectionFormAdvanced.vue';
import { getTranslation } from '../utils/languageUtils';

// 定义 Props 与 Emits
interface Props {
  connectionToEdit: ConnectionInfo | null;
}
const props = defineProps<Props>();
const emit = defineEmits(['close', 'connection-added', 'connection-updated', 'connection-deleted']);

const { t, locale } = useI18n();
const scriptModeFormatInfo = ref(getTranslation('connections.form.scriptModeFormatInfo', locale.value));

const {
  formData,
  isLoading,
  testStatus,
  testResult,
  isScriptModeActive,
  scriptInputText,
  isEditMode,
  formTitle,
  submitButtonText,
  proxies,
  tags,
  connections,
  isProxyLoading,
  proxyStoreError,
  isTagLoading,
  tagStoreError,
  advancedConnectionMode,
  addJumpHost,
  removeJumpHost,
  handleSubmit,
  handleDeleteConnection,
  handleTestConnection,
  handleCreateTag,
  handleDeleteTag,
  latencyColor,
  testButtonText,
} = useAddConnectionForm(props, emit);

const handleAdvancedConnectionModeUpdate = (newMode: 'proxy' | 'jump') => {
  advancedConnectionMode.value = newMode;
};
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
    @click.self="emit('close')"
  >
    <div
      class="mobile-form-sheet w-full max-h-[92vh] h-[92vh] flex flex-col bg-background border-t border-border/50 rounded-t-2xl shadow-2xl overflow-hidden select-text"
    >
      <!-- 1. 顶部手柄条与导航栏 -->
      <div class="shrink-0 pt-2.5 pb-2.5 px-4 border-b border-border/40 bg-header/40 select-none">
        <!-- 顶部拖拽手柄条 -->
        <div class="w-10 h-1 bg-border/80 rounded-full mx-auto mb-2 cursor-pointer" @click="emit('close')"></div>

        <div class="flex items-center justify-between">
          <!-- 左侧收起按钮 (统一采用快捷指令面板移动端收起样式) -->
          <button
            type="button"
            @click="emit('close')"
            class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
            :title="t('common.close', '收起')"
            :aria-label="t('common.close', '收起')"
          >
            <i class="fas fa-chevron-down text-sm"></i>
          </button>

          <!-- 居中标题与协议徽章 -->
          <div class="flex items-center gap-1.5 min-w-0 px-1">
            <span class="text-sm font-semibold text-foreground tracking-tight truncate max-w-[140px]">
              {{ formTitle }}
            </span>
            <span
              class="px-1.5 py-0.5 rounded text-[10px] uppercase font-mono font-bold tracking-wider shrink-0"
              :class="formData.type === 'RDP'
                ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                : formData.type === 'VNC'
                  ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                  : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'"
            >
              {{ formData.type }}
            </span>
          </div>

          <!-- 右侧快捷保存按钮 -->
          <button
            type="button"
            @click="handleSubmit"
            :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
            class="px-3.5 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xs flex items-center gap-1.5 -mr-1 cursor-pointer whitespace-nowrap shrink-0"
          >
            <svg v-if="isLoading" class="animate-spin h-3.5 w-3.5 text-current shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>{{ isEditMode ? t('common.save', '保存') : t('common.add', '添加') }}</span>
          </button>
        </div>
      </div>

      <!-- 2. 表单滚动主体 (移动端卡片化深度适配) -->
      <div class="flex-grow overflow-y-auto px-3.5 py-3.5 space-y-3.5 overscroll-contain">
        <template v-if="!isScriptModeActive">
          <!-- 基本信息卡片 -->
          <MobileConnectionFormBasicInfo :form-data="formData" />

          <!-- 认证信息卡片 -->
          <MobileConnectionFormAuth :form-data="formData" :is-edit-mode="isEditMode" />

          <!-- 高级选项卡片 (代理、跳板机、标签、备注) -->
          <MobileConnectionFormAdvanced
            :form-data="formData"
            :proxies="proxies"
            :tags="tags"
            :connections="connections"
            :is-proxy-loading="isProxyLoading"
            :proxy-store-error="proxyStoreError"
            :is-tag-loading="isTagLoading"
            :tag-store-error="tagStoreError"
            :advanced-connection-mode="advancedConnectionMode"
            @update:advancedConnectionMode="handleAdvancedConnectionModeUpdate"
            :add-jump-host="addJumpHost"
            :remove-jump-host="removeJumpHost"
            @create-tag="handleCreateTag"
            @delete-tag="handleDeleteTag"
            :is-edit-mode="isEditMode"
          />
        </template>

        <!-- 3. 脚本导入模式 (仅在添加模式下可用) -->
        <div v-if="!isEditMode" class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs space-y-3">
          <div class="flex justify-between items-center">
            <div>
              <h4 class="text-xs font-semibold text-foreground">{{ t('connections.form.sectionScriptMode', '脚本批量导入模式') }}</h4>
              <p class="text-[11px] text-text-secondary/70">快速粘贴 SSH 命令批量解析导入</p>
            </div>
            <button
              type="button"
              @click="isScriptModeActive = !isScriptModeActive"
              class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
              :class="isScriptModeActive ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-700'"
              role="switch"
              :aria-checked="isScriptModeActive"
            >
              <span
                class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
                :class="isScriptModeActive ? 'translate-x-5' : 'translate-x-0'"
              ></span>
            </button>
          </div>

          <div v-if="isScriptModeActive" class="mt-2 space-y-2">
            <textarea
              id="m-conn-script-input"
              v-model="scriptInputText"
              rows="6"
              wrap="off"
              class="w-full p-3 border border-border/60 rounded-xl bg-header/20 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              :placeholder="t('connections.form.scriptModePlaceholder')"
            ></textarea>
            <p class="text-[11px] text-text-secondary/80 whitespace-pre-line leading-relaxed">
              {{ scriptModeFormatInfo }}
            </p>
          </div>
        </div>

        <!-- 4. 底部操作区 (测试连接、删除连接、主保存) -->
        <div class="pt-2 pb-6 space-y-3 border-t border-border/40">
          <!-- 测试连接状态行 (SSH模式且非脚本模式) -->
          <div
            v-if="formData.type === 'SSH' && !isScriptModeActive"
            class="flex items-center justify-between p-3 rounded-xl bg-header/30 border border-border/60 gap-2"
          >
            <button
              type="button"
              @click="handleTestConnection"
              :disabled="isLoading || testStatus === 'testing'"
              class="h-8 px-3 text-xs font-semibold rounded-lg border border-border/70 text-text-secondary bg-background/80 hover:bg-border/40 active:bg-border disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <svg v-if="testStatus === 'testing'" class="animate-spin h-3.5 w-3.5 text-text-secondary shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <i v-else class="fas fa-bolt text-xs text-amber-500 shrink-0"></i>
              <span>{{ testButtonText }}</span>
            </button>

            <div class="text-xs font-mono min-w-0 flex-1 text-right">
              <span v-if="testStatus === 'testing'" class="text-text-secondary animate-pulse text-[11px]">{{ t('connections.test.testingInProgress', '测试中...') }}</span>
              <span v-else-if="testStatus === 'success'" class="font-bold text-[11px]" :style="{ color: latencyColor }">✓ {{ testResult }}</span>
              <span v-else-if="testStatus === 'error'" class="text-red-400 font-medium truncate block text-[11px]" :title="String(testResult)">✗ {{ testResult }}</span>
            </div>
          </div>

          <!-- 主操作按钮组：编辑时有删除按钮，添加/保存全宽主按钮 -->
          <div class="flex items-center gap-2.5">
            <button
              v-if="isEditMode && !isScriptModeActive"
              type="button"
              @click="handleDeleteConnection"
              :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
              class="h-10 px-4 rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 active:scale-98 disabled:opacity-50 text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0"
            >
              <i class="fas fa-trash-alt text-xs shrink-0"></i>
              <span>{{ t('connections.actions.delete', '删除') }}</span>
            </button>

            <button
              type="button"
              @click="handleSubmit"
              :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
              class="flex-grow min-w-0 h-10 px-3 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-xs cursor-pointer"
            >
              <svg v-if="isLoading" class="animate-spin h-3.5 w-3.5 text-current shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span class="truncate">{{ submitButtonText }}</span>
            </button>
          </div>
        </div>

        <!-- 底部安全留白垫高 -->
        <div class="h-6 shrink-0"></div>
      </div>
    </div>
  </div>
</template>
