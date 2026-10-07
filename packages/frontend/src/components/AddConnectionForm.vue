<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { ConnectionInfo } from '../stores/connections.store';
import { useAddConnectionForm } from '../composables/useAddConnectionForm';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import AddConnectionFormBasicInfo from './AddConnectionFormBasicInfo.vue';
import AddConnectionFormAuth from './AddConnectionFormAuth.vue';
import AddConnectionFormAdvanced from './AddConnectionFormAdvanced.vue';
import MobileAddConnectionModal from './MobileAddConnectionModal.vue';
import { getTranslation } from '../utils/languageUtils';

// 定义组件发出的事件
const emit = defineEmits(['close', 'connection-added', 'connection-updated', 'connection-deleted']);

// 定义 Props
interface Props {
  connectionToEdit: ConnectionInfo | null;
  isMobile?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isMobile: undefined,
});

const { t, locale } = useI18n();
const { isMobile: detectedMobile } = useDeviceDetection();
const scriptModeFormatInfo = ref(getTranslation('connections.form.scriptModeFormatInfo', locale.value));

// 视口尺寸响应式监听
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

onMounted(() => {
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
});

const isMobileMode = computed(() => {
  if (typeof props.isMobile === 'boolean') {
    return props.isMobile;
  }
  return detectedMobile.value || windowWidth.value < 768;
});

const {
  formData,
  isLoading,
  testStatus,
  testResult,
  testLatency,
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
  <Teleport to="body">
    <!-- ==================== 移动端特化视图 (独立解耦组件) ==================== -->
    <Transition name="bottom-sheet">
      <MobileAddConnectionModal
        v-if="isMobileMode"
        :connection-to-edit="props.connectionToEdit"
        @close="emit('close')"
        @connection-added="emit('connection-added')"
        @connection-updated="emit('connection-updated')"
        @connection-deleted="emit('connection-deleted')"
      />
    </Transition>

    <!-- ==================== 桌面端原有视图 (居中固定模态框) ==================== -->
    <div v-if="!isMobileMode" class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4">
      <div class="bg-background text-foreground p-6 rounded-lg shadow-xl border border-border w-full max-w-2xl max-h-[90vh] flex flex-col">
        <h3 class="text-xl font-semibold text-center mb-6 flex-shrink-0">{{ formTitle }}</h3>
        <form @submit.prevent="handleSubmit" class="flex-grow overflow-y-auto pr-2 space-y-6">
          <template v-if="!isScriptModeActive">
            <AddConnectionFormBasicInfo :form-data="formData" />
            <AddConnectionFormAuth :form-data="formData" :is-edit-mode="isEditMode" />
            <AddConnectionFormAdvanced
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
            />
          </template>
         
          <div v-if="!isEditMode" class="space-y-4 p-4 border border-border rounded-md bg-header/30 mt-6">
            <div class="flex justify-between items-center">
              <h4 class="text-base font-semibold">{{ t('connections.form.sectionScriptMode', '脚本模式') }}</h4>
              <button
                type="button"
                @click="isScriptModeActive = !isScriptModeActive"
                :class="[
                  'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
                  isScriptModeActive ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                ]"
                role="switch"
                :aria-checked="isScriptModeActive"
              >
                <span
                  aria-hidden="true"
                  :class="[
                    'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                    isScriptModeActive ? 'translate-x-5' : 'translate-x-0'
                  ]"
                ></span>
              </button>
            </div>
            <div v-if="isScriptModeActive" class="mt-4">
              <textarea
                id="conn-script-input"
                v-model="scriptInputText"
                rows="10"
                wrap="off"
                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                :placeholder="t('connections.form.scriptModePlaceholder')"
              ></textarea>
              <p class="mt-1 text-xs text-text-secondary whitespace-pre-line">
                {{ scriptModeFormatInfo }}
              </p>
            </div>
          </div>
        </form>

        <div class="flex justify-between items-center pt-5 mt-6 flex-shrink-0">
          <div v-if="formData.type === 'SSH' && !isScriptModeActive" class="flex flex-col items-start gap-1">
            <div class="flex items-center gap-2">
              <button type="button" @click="handleTestConnection" :disabled="isLoading || testStatus === 'testing'"
                      class="px-3 py-1.5 border border-border rounded-md text-sm font-medium text-text-secondary bg-background hover:bg-border focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center transition-colors duration-150">
                <svg v-if="testStatus === 'testing'" class="animate-spin -ml-0.5 mr-2 h-4 w-4 text-text-secondary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ testButtonText }}
              </button>
              <div class="relative group">
                <i class="fas fa-info-circle text-text-secondary cursor-help"></i>
                <span class="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-max max-w-xs p-2 text-xs text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-pre-wrap">
                  {{ t('connections.test.latencyTooltip') }}
                </span>
              </div>
            </div>
            <div class="min-h-[1.2em] pl-1 text-xs">
              <div v-if="testStatus === 'testing'" class="text-text-secondary animate-pulse">
                {{ t('connections.test.testingInProgress', '测试中...') }}
              </div>
              <div v-else-if="testStatus === 'success'" class="font-medium" :style="{ color: latencyColor }">
                {{ testResult }}
              </div>
              <div v-else-if="testStatus === 'error'" class="text-error font-medium">
                {{ t('connections.test.errorPrefix', '错误:') }} {{ testResult }}
              </div>
            </div>
          </div>
          <div v-else-if="!isScriptModeActive" class="flex-1"></div>
          <div v-else class="flex-1"></div>
          <div class="flex space-x-3">
            <button v-if="isEditMode && !isScriptModeActive" type="button" @click="handleDeleteConnection" :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
                    class="px-4 py-2 bg-transparent text-red-600 border border-red-500 rounded-md shadow-sm hover:bg-red-500/10 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out">
              {{ t('connections.actions.delete') }}
            </button>
            <button type="submit" @click="handleSubmit" :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
                    class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out">
              {{ submitButtonText }}
            </button>
            <button type="button" @click="emit('close')" :disabled="isLoading || (formData.type === 'SSH' && testStatus === 'testing')"
                    class="px-4 py-2 bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out">
              {{ t('connections.form.cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
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
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px);
}
</style>
