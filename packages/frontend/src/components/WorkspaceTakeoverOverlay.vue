<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useRouter } from 'vue-router';

import { useSessionStore } from '../stores/session.store';
import { useFileEditorStore } from '../stores/fileEditor.store';

const { t } = useI18n();
const router = useRouter();
const workspaceSyncStore = useWorkspaceSyncStore();
const sessionStore = useSessionStore();
const fileEditorStore = useFileEditorStore();

const isReclaiming = ref(false);

const handleReclaim = async () => {
  if (isReclaiming.value) return;
  isReclaiming.value = true;
  try {
    // 1. 声明独占接管权（后端会将其余客户端的活动 SSH 会话自动挂起）
    const claimSuccess = await workspaceSyncStore.claimTakeover();
    if (!claimSuccess) {
      throw new Error('声明接管租约失败');
    }

    // 2. 清理当前页面旧会话与编辑器残留，释放旧连接
    sessionStore.cleanupAllSessions();
    fileEditorStore.closeAllTabs();
    fileEditorStore.closePopup();

    // 3. 从云端拉取最新工作区快照并无缝恢复
    const restoreSuccess = await workspaceSyncStore.restoreWorkspaceFromCloud();
    if (restoreSuccess) {
      workspaceSyncStore.isTakenOver = false;
      workspaceSyncStore.takeoverByClientId = null;
      workspaceSyncStore.triggerDebouncedSave(500);
    } else {
      // 容灾保底：若热恢复异常，降级为刷新重载
      window.location.reload();
    }
  } catch (err) {
    console.error('接管并热重置工作区失败，降级为页面重载:', err);
    window.location.reload();
  } finally {
    isReclaiming.value = false;
  }
};

const handleGoHome = () => {
  router.push('/');
};
</script>

<template>
  <Transition name="fade">
    <div
      v-if="workspaceSyncStore.isTakenOver"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-4 select-none"
      @click.stop
      @keydown.stop
    >
      <div class="relative max-w-sm sm:max-w-md w-full bg-surface border border-border/80 rounded-2xl p-5 sm:p-8 shadow-2xl flex flex-col items-center text-center animate-scale-in mx-2">
        <!-- 动态发光图标 -->
        <div class="relative flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-primary/10 border border-primary/30 text-primary mb-4 sm:mb-6 shadow-inner">
          <i class="fas fa-desktop text-2xl sm:text-3xl animate-pulse"></i>
          <span class="absolute -top-1 -right-1 flex h-3.5 w-3.5 sm:h-4 sm:w-4">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3.5 w-3.5 sm:h-4 sm:w-4 bg-amber-500"></span>
          </span>
        </div>

        <!-- 标题与描述 -->
        <h2 class="text-lg sm:text-2xl font-bold text-foreground mb-2 sm:mb-3">
          {{ t('workspaceSync.takeoverTitle', '工作区已在其它设备接管') }}
        </h2>
        <p class="text-xs sm:text-sm text-text-secondary leading-relaxed mb-5 sm:mb-6 px-1 sm:px-0">
          {{ t('workspaceSync.takeoverDesc', '检测到您的工作区已在新的浏览器标签页或设备中打开。为了保证终端和编辑内容的一致性，当前页面已进入挂起待机状态。') }}
        </p>

        <!-- 操作按钮 -->
        <div class="flex flex-col sm:flex-row gap-2.5 sm:gap-3 w-full">
          <button
            class="flex-1 inline-flex items-center justify-center px-4 py-2.5 sm:px-5 sm:py-3 rounded-xl bg-primary hover:bg-primary-hover text-white text-sm sm:text-base font-medium shadow-lg hover:shadow-primary/30 active:scale-98 transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            :disabled="isReclaiming"
            @click="handleReclaim"
          >
            <i v-if="isReclaiming" class="fas fa-spinner fa-spin mr-2"></i>
            <i v-else class="fas fa-hand-paper mr-2"></i>
            {{ isReclaiming ? t('workspaceSync.reclaiming', '正在接管工作区...') : t('workspaceSync.reclaimButton', '接管并同步工作区') }}
          </button>

          <button
            class="inline-flex items-center justify-center px-4 py-2.5 sm:py-3 rounded-xl bg-surface-secondary hover:bg-border text-text-secondary hover:text-foreground text-sm sm:text-base font-medium border border-border transition-all duration-150 cursor-pointer"
            @click="handleGoHome"
          >
            <i class="fas fa-home mr-1.5 text-xs"></i>
            {{ t('workspaceSync.backToHome', '返回首页') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.animate-scale-in {
  animation: scaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
