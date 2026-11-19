<!-- packages/frontend/src/components/desktop/CloseConfirmModal.vue -->
<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      @keydown.esc="handleCancel"
    >
      <div
        class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all animate-scale-up"
        style="background-color: var(--app-bg-color);"
      >
        <!-- 弹窗头部：一体化无色差 -->
        <div class="px-5 py-3.5 border-b border-border/50 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs">
              <i class="fas fa-power-off"></i>
            </div>
            <h3 class="text-sm font-semibold text-foreground">
              {{ $t('desktop.closeConfirm.title', '关闭') }}
            </h3>
          </div>
          <button
            @click="handleCancel"
            class="text-text-secondary hover:text-foreground text-sm p-1 rounded-md transition-colors"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- 弹窗内容 (极简无冗余说明) -->
        <div class="p-5 space-y-4">
          <!-- 选项组 -->
          <div class="space-y-3">
            <!-- 最小化到系统托盘 -->
            <label class="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="radio"
                name="desktopCloseAction"
                value="minimize_to_tray"
                v-model="selectedAction"
                class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <span class="text-sm text-foreground">
                {{ $t('desktop.closeConfirm.minimizeTitle', '最小化到系统托盘') }}
              </span>
            </label>

            <!-- 退出 Nexus Terminal -->
            <label class="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="radio"
                name="desktopCloseAction"
                value="quit"
                v-model="selectedAction"
                class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <span class="text-sm text-foreground">
                {{ $t('desktop.closeConfirm.quitTitle', '退出 Nexus Terminal') }}
              </span>
            </label>
          </div>

          <!-- 记住选择复选框 -->
          <div class="pt-3 border-t border-border/50">
            <label class="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                v-model="rememberChoice"
                class="rounded border-border text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <span class="text-sm text-foreground">
                {{ $t('desktop.closeConfirm.rememberChoice', '记住我的选择') }}
              </span>
            </label>
          </div>
        </div>

        <!-- 弹窗底部操作按钮 -->
        <div class="px-5 py-3.5 bg-muted/20 border-t border-border/60 flex items-center justify-end gap-3">
          <button
            type="button"
            @click="handleCancel"
            :disabled="isSubmitting"
            class="px-4 py-1.5 text-sm font-medium text-text-secondary hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
          >
            {{ $t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="handleConfirm"
            :disabled="isSubmitting"
            class="px-5 py-1.5 text-sm font-medium text-white bg-primary hover:bg-primary/90 active:scale-95 rounded-lg shadow-sm transition-all flex items-center gap-2"
          >
            {{ $t('common.confirm', '确定') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import axios from 'axios';
import { isDesktopApp } from '../../utils/platform';

const { t } = useI18n();
const isDesktop = isDesktopApp();

const visible = ref(false);
const selectedAction = ref<'minimize_to_tray' | 'quit'>('minimize_to_tray');
const rememberChoice = ref(false);
const isSubmitting = ref(false);

// 初始化读取配置（仅在桌面端运行时请求）
const loadInitialSettings = async () => {
  if (!isDesktop) return;
  try {
    const res = await axios.get('/api/v1/desktop/settings');
    if (res.data) {
      if (res.data.closeBehavior) {
        selectedAction.value = res.data.closeBehavior;
      }
      if (typeof res.data.rememberCloseChoice === 'boolean') {
        rememberChoice.value = res.data.rememberCloseChoice;
      }
    }
  } catch (e) {
    const cached = localStorage.getItem('nexus_close_behavior');
    if (cached === 'quit' || cached === 'minimize_to_tray') {
      selectedAction.value = cached;
    }
  }
};

const handleCancel = () => {
  visible.value = false;
};

const handleConfirm = async () => {
  isSubmitting.value = true;
  try {
    // 1. 本地缓存持久化配置
    localStorage.setItem('nexus_close_behavior', selectedAction.value);
    localStorage.setItem('nexus_remember_close_choice', String(rememberChoice.value));

    // 2. 尝试通过后端接口持久化（未登录时 401 不阻断桌面窗口关闭/隐藏动作）
    try {
      await axios.put('/api/v1/desktop/settings', {
        closeBehavior: selectedAction.value,
        rememberCloseChoice: rememberChoice.value,
        actionToExecute: selectedAction.value,
      });
    } catch (apiErr) {
      console.warn('[CloseConfirmModal] 同步关闭配置到后端失败，将继续执行原生窗口动作:', apiErr);
    }

    // 3. 调用原生 Tauri IPC 持久化配置并执行窗口动作
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri?.core?.invoke) {
        await tauri.core.invoke('set_desktop_settings', {
          closeBehavior: selectedAction.value,
          rememberCloseChoice: rememberChoice.value,
        }).catch(() => {});
        if (selectedAction.value === 'minimize_to_tray') {
          await tauri.core.invoke('hide_main_window');
        } else {
          await tauri.core.invoke('exit_desktop_app');
        }
      }
    } catch {}

    visible.value = false;
  } catch (err) {
    console.error('[CloseConfirmModal] 提交关闭选择失败:', err);
    visible.value = false;
  } finally {
    isSubmitting.value = false;
  }
};

const showModal = () => {
  console.log('🔔 [Nexus Desktop] 接收到关闭指令，弹出确认窗口');
  loadInitialSettings();
  visible.value = true;
};

onMounted(() => {
  if (!isDesktop) return;
  loadInitialSettings();

  // 1. 全局挂载唤起钩子，供 Tauri 主进程在 CloseRequested 触发时直接调用
  (window as any).__NEXUS_SHOW_CLOSE_CONFIRM__ = showModal;

  // 2. 监听自定义事件唤起
  window.addEventListener('nexus:request-close', showModal);
});

onUnmounted(() => {
  if (typeof window !== 'undefined' && isDesktop) {
    delete (window as any).__NEXUS_SHOW_CLOSE_CONFIRM__;
    window.removeEventListener('nexus:request-close', showModal);
  }
});
</script>

<style scoped>
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleUp {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.animate-fade-in {
  animation: fadeIn 0.15s ease-out forwards;
}

.animate-scale-up {
  animation: scaleUp 0.18s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
</style>
