<template>
  <div class="suspended-ssh-sessions-view p-2 flex flex-col h-full" style="container-type: inline-size; container-name: suspended-sessions-view-pane;">
    <div class="view-header mb-2 flex items-center gap-1.5">
      <div class="relative flex-1 min-w-0">
        <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <i class="fas fa-search text-text-secondary"></i>
        </span>
        <input
          type="text"
          v-model="searchTerm"
          :placeholder="$t('suspendedSshSessions.searchPlaceholder')"
          class="w-full pl-10 pr-12 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
          @input="filterSessions"
        />
        <span class="sss-hint-count">{{ filteredSessions.length }}</span>
      </div>
      <button
        type="button"
        @click="openScanModal"
        :title="$t('remoteAgent.scan.buttonTooltip', '扫描目标主机上存活或遗留的托管会话')"
        class="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border/70 bg-background hover:bg-muted/60 text-foreground inline-flex items-center gap-1.5 transition-colors cursor-pointer"
      >
        <i class="fas fa-satellite-dish text-primary text-xs"></i>
        <span class="hidden sm:inline">{{ $t('remoteAgent.scan.button', '扫描目标机') }}</span>
      </button>
    </div>

    <div class="session-list-container flex-grow overflow-y-auto">
      <!-- 首屏骨架：只有「从没拉到过数据」时才出现。拿到过一次之后，
           轮询与重新打开都走静默刷新，列表原地更新，不再整块切成转圈。 -->
      <div v-if="showInitialLoading" class="sss-skeleton" role="status" :aria-label="$t('suspendedSshSessions.loading')">
        <div v-for="i in 3" :key="i" class="sss-skeleton-item">
          <div class="sss-skeleton-line sss-skeleton-line--title"></div>
          <div class="sss-skeleton-line sss-skeleton-line--sub"></div>
          <div class="sss-skeleton-line sss-skeleton-line--time"></div>
        </div>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="text-center p-4">
        <p>{{ $t('suspendedSshSessions.noResults') }}</p>
      </div>
      <ul v-else class="list-none p-0 m-0">
        <li
          v-for="session in filteredSessions"
          :key="session.suspendSessionId"
          class="session-item p-3 mb-2 border border-border/70 rounded-md bg-surface-ground"
          :class="{
            'opacity-60': session.backendSshStatus === 'disconnected_by_backend',
            'sss-item--paused': session.manuallySuspended && session.backendSshStatus === 'hanging',
          }"
        >
          <div class="flex justify-between items-center">
            <div class="session-info flex-grow mr-2">
              <div class="font-bold text-lg flex items-center flex-wrap gap-x-2 gap-y-1">
                <span
                  v-if="editingSuspendSessionId !== session.suspendSessionId"
                  class="cursor-pointer hover:text-primary"
                  :title="$t('suspendedSshSessions.tooltip.editName')"
                  @click="startEditingName(session)"
                >
                  {{ session.customSuspendName || session.connectionName }}
                </span>
                <input
                  v-else
                  ref="nameInputRef"
                  v-model="currentEditingNameValue"
                  type="text"
                  class="text-lg font-bold w-full px-1 py-0.5 border border-primary rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  @blur="finishEditingName()"
                  @keydown.enter.prevent="finishEditingName()"
                  @keydown.esc.prevent="cancelEditingName()"
                />
                <!-- 目标机自托管徽标：区分于传统后端内存挂起 -->
                <span
                  v-if="session.hostingMode === 'remote-agent'"
                  class="sss-badge sss-badge--remote"
                  :title="$t('remoteAgent.badge.remoteHostedTooltip', '由目标主机本地 nexus-mux 代理独立托管，Web 端与桌面端均可无缝接管')"
                >
                  <i class="fas fa-server"></i>
                  <span>{{ $t('remoteAgent.badge.remoteHosted', '目标机托管') }}</span>
                </span>
                <!-- 挂起模式徽标：明确告诉用户"这不是断开，是挂起" -->
                <span
                  v-if="session.manuallySuspended"
                  class="sss-badge sss-badge--paused"
                  :title="$t('suspendedSshSessions.badge.manualTooltip')"
                >
                  <i class="fas fa-pause"></i>
                  <span>{{ $t('suspendedSshSessions.badge.manual') }}</span>
                </span>
                <span
                  class="sss-badge"
                  :class="session.backendSshStatus === 'hanging' ? 'sss-badge--live' : 'sss-badge--dead'"
                >
                  {{ session.backendSshStatus === 'hanging' ? $t('suspendedSshSessions.status.hanging') : $t('suspendedSshSessions.status.disconnected') }}
                </span>
                <span
                  v-if="session.exitCode !== undefined && session.exitCode !== null"
                  class="sss-badge sss-badge--exit"
                >
                  exit {{ session.exitCode }}
                </span>
              </div>
              <div class="text-sm text-muted-color">
                {{ $t('suspendedSshSessions.label.originalConnection') }}: {{ session.connectionName }}
              </div>
              <div class="text-xs text-muted-color mt-1">
                {{ $t('suspendedSshSessions.label.suspendedAt') }}: {{ formatDateTime(session.suspendStartTime) }}
              </div>
              <div
                v-if="session.backendSshStatus === 'disconnected_by_backend' && session.disconnectionTimestamp"
                class="text-xs text-orange-500 mt-1"
              >
                {{ $t('suspendedSshSessions.disconnectedAt', { time: formatDateTime(session.disconnectionTimestamp) }) }}
              </div>
            </div>

            <div class="session-status-actions flex flex-col items-end">
              
              <div class="actions flex flex-col space-y-2 mt-1">
                <button
                  v-if="session.backendSshStatus === 'hanging'"
                  @click="resumeSession(session)"
                  :title="$t('suspendedSshSessions.action.resume')"
                  class="responsive-button-padding py-1.5 text-sm font-medium rounded-md text-button-text bg-button hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition-colors duration-150 inline-flex items-center"
                >
                  <i class="fas fa-play action-icon" style="color: var(--button-text-color, white);"></i> <!-- Assuming icon color should also match button text -->
                  <span class="button-session-text">{{ $t('suspendedSshSessions.action.resume') }}</span>
                </button>
                <button
                  @click="removeSession(session)"
                  :title="$t('suspendedSshSessions.action.remove')"
                  class="responsive-button-padding py-1.5 text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors duration-150 inline-flex items-center"
                >
                  <i class="fas fa-trash-alt action-icon" style="color: white;"></i>
                  <span class="button-session-text">{{ $t('suspendedSshSessions.action.remove') }}</span>
                </button>
               <button
                 v-if="session.hostingMode !== 'remote-agent' && (session.backendSshStatus === 'disconnected_by_backend' || session.backendSshStatus === 'hanging')"
                 @click="exportLog(session)"
                 :title="$t('suspendedSshSessions.action.exportLog')"
                 class="responsive-button-padding py-1.5 text-sm font-medium rounded-md text-button-text bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-150 inline-flex items-center"
               >
                 <i class="fas fa-download action-icon" style="color: var(--button-text-color, white);"></i>
                 <span class="button-session-text">{{ $t('suspendedSshSessions.action.exportLog') }}</span>
               </button>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <!-- 扫描目标机托管会话弹窗 -->
    <Teleport to="body">
      <div
        v-if="showScanModal"
        class="fixed inset-0 z-[9990] flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-4"
        @click.self="closeScanModal"
      >
        <div
          class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden"
          style="background-color: var(--app-bg-color);"
        >
          <div class="flex items-center justify-between px-5 py-3.5 border-b border-border/60">
            <div class="flex items-center gap-2">
              <i class="fas fa-satellite-dish text-primary"></i>
              <h3 class="text-sm sm:text-base font-semibold">
                {{ $t('remoteAgent.scan.modalTitle', '扫描目标机托管会话') }}
              </h3>
            </div>
            <button
              type="button"
              @click="closeScanModal"
              class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/50 cursor-pointer"
            >
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>

          <div class="p-4 sm:p-5 space-y-3 overflow-y-auto flex-1 min-h-0">
            <div class="flex flex-col sm:flex-row gap-2">
              <select
                v-model="selectedScanConnectionId"
                class="flex-1 h-9 px-3 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option :value="null" disabled>
                  {{ $t('remoteAgent.scan.selectHostPlaceholder', '请选择要扫描的 SSH 主机...') }}
                </option>
                <option v-for="conn in sshConnections" :key="conn.id" :value="conn.id">
                  {{ conn.name || conn.host }} ({{ conn.username }}@{{ conn.host }}:{{ conn.port }})
                </option>
              </select>
              <button
                type="button"
                :disabled="!selectedScanConnectionId || isScanning"
                @click="runRemoteScan"
                class="h-9 px-4 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs sm:text-sm font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <i :class="isScanning ? 'fas fa-spinner fa-spin' : 'fas fa-search'"></i>
                <span>{{ isScanning ? $t('remoteAgent.scan.scanning', '扫描中...') : $t('remoteAgent.scan.startScan', '开始扫描') }}</span>
              </button>
            </div>

            <label class="inline-flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
              <input type="checkbox" v-model="scanIncludeAllNamespaces" class="rounded border-border" />
              <span>{{ $t('remoteAgent.scan.includeAllNamespaces', '包含同系统用户下的全部托管会话（排查其他账号/历史孤儿会话）') }}</span>
            </label>

            <div v-if="scanError" class="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500">
              {{ scanError }}
            </div>

            <div v-else-if="scanCompleted && scannedSessions.length === 0" class="text-center py-6 text-xs text-text-secondary">
              {{ $t('remoteAgent.scan.emptyResult', '该目标机当前没有发现运行中或保留期内的托管会话。') }}
            </div>

            <ul v-else-if="scannedSessions.length > 0" class="space-y-2 list-none p-0 m-0">
              <li
                v-for="item in scannedSessions"
                :key="item.sessionId"
                class="p-3 rounded-xl border border-border/70 bg-muted/15 flex items-center justify-between gap-3"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="font-semibold text-sm truncate">{{ item.title || item.sessionId }}</span>
                    <span
                      class="sss-badge"
                      :class="item.status === 'running' ? 'sss-badge--live' : 'sss-badge--dead'"
                    >
                      {{ item.status === 'running' ? $t('remoteAgent.scan.statusRunning', '运行中') : $t('remoteAgent.scan.statusExited', '已退出') }}
                    </span>
                    <span v-if="item.attached" class="sss-badge sss-badge--paused">
                      {{ $t('remoteAgent.scan.attachedBadge', '已附着') }}
                    </span>
                    <span v-if="item.exitCode !== undefined && item.exitCode !== null" class="sss-badge sss-badge--exit">
                      exit {{ item.exitCode }}
                    </span>
                  </div>
                  <div class="text-[11px] text-text-secondary mt-1 font-mono truncate">
                    ID: {{ item.sessionId }} · {{ item.cols }}×{{ item.rows }}
                  </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    @click="claimScannedSession(item)"
                    class="px-2.5 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-medium cursor-pointer inline-flex items-center gap-1"
                  >
                    <i class="fas fa-plug text-[10px]"></i>
                    <span>{{ $t('remoteAgent.scan.claimAction', '接管') }}</span>
                  </button>
                  <button
                    type="button"
                    :disabled="killingScannedId === item.sessionId"
                    @click="killScannedSession(item)"
                    class="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                  >
                    <i :class="killingScannedId === item.sessionId ? 'fas fa-spinner fa-spin text-[10px]' : 'fas fa-trash-alt text-[10px]'"></i>
                    <span>{{ $t('remoteAgent.scan.killAction', '终止') }}</span>
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'; // +++ 导入 nextTick, watch 和 onUnmounted +++
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useConnectionsStore } from '../stores/connections.store'; // +++ 导入 Connections Store +++
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import apiClient from '../utils/apiClient';
import type { SuspendedSshSession } from '../types/ssh-suspend.types';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents'; // +++ 导入事件发射器 +++

const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++
const sessionStore = useSessionStore();
const connectionsStore = useConnectionsStore();
const uiNotificationsStore = useUiNotificationsStore();
const { suspendedSshSessions: storeSuspendedSshSessions, isLoadingSuspendedSessions: isLoading, suspendedSshSessionsLoaded } = storeToRefs(sessionStore);

// --- 扫描目标机托管会话状态 ---
interface ScannedRemoteSession {
  remoteSessionId: string;
  sessionId: string;
  ownerNamespace: string;
  title?: string;
  exited: boolean;
  status: 'running' | 'exited';
  exitCode?: number | null;
  attached: boolean;
  cols: number;
  rows: number;
  createdAt?: number;
  lastActiveAt?: number;
}
const showScanModal = ref(false);
const selectedScanConnectionId = ref<number | null>(null);
const scanIncludeAllNamespaces = ref(false);
const isScanning = ref(false);
const scanCompleted = ref(false);
const scanError = ref<string | null>(null);
const scannedSessions = ref<ScannedRemoteSession[]>([]);
const killingScannedId = ref<string | null>(null);

const sshConnections = computed(() =>
  connectionsStore.connections.filter((c) => c.type === 'SSH')
);

const openScanModal = async () => {
  showScanModal.value = true;
  scanError.value = null;
  if (connectionsStore.connections.length === 0) {
    try {
      await connectionsStore.fetchConnections();
    } catch {}
  }
  if (!selectedScanConnectionId.value && sshConnections.value.length > 0) {
    selectedScanConnectionId.value = sshConnections.value[0].id;
  }
};

const closeScanModal = () => {
  showScanModal.value = false;
};

const runRemoteScan = async () => {
  if (!selectedScanConnectionId.value || isScanning.value) return;
  isScanning.value = true;
  scanError.value = null;
  scanCompleted.value = false;
  try {
    const res = await apiClient.post(`/connections/${selectedScanConnectionId.value}/remote-agent/scan`, {
      includeAllNamespaces: scanIncludeAllNamespaces.value,
    });
    const rawList = Array.isArray(res.data?.data?.sessions) ? res.data.data.sessions : [];
    scannedSessions.value = rawList.map((item: any) => {
      const sid = String(item.remoteSessionId || item.sessionId || '');
      const exited = typeof item.exited === 'boolean' ? item.exited : item.status === 'exited';
      return {
        ...item,
        remoteSessionId: sid,
        sessionId: sid,
        exited,
        status: exited ? 'exited' : 'running',
      };
    });
    scanCompleted.value = true;
  } catch (err: any) {
    scanError.value = err?.response?.data?.message || err?.message || t('errors.unknown', '未知错误');
    scannedSessions.value = [];
  } finally {
    isScanning.value = false;
  }
};

const claimScannedSession = (item: ScannedRemoteSession) => {
  if (!selectedScanConnectionId.value) return;
  sessionStore.openNewSession(selectedScanConnectionId.value, undefined, true, {
    remoteSessionId: item.sessionId,
  });
  showScanModal.value = false;
  emitWorkspaceEvent('suspendedSession:actionCompleted');
};

const killScannedSession = async (item: ScannedRemoteSession) => {
  if (!selectedScanConnectionId.value || killingScannedId.value) return;
  killingScannedId.value = item.sessionId;
  try {
    await apiClient.delete(
      `/connections/${selectedScanConnectionId.value}/remote-agent/sessions/${encodeURIComponent(item.sessionId)}`,
      { data: { forceAnyNamespace: scanIncludeAllNamespaces.value } }
    );
    scannedSessions.value = scannedSessions.value.filter((s) => s.sessionId !== item.sessionId);
    uiNotificationsStore.showSuccess(t('remoteAgent.scan.killSuccess', '已终止目标机托管会话'));
    void sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
  } catch (err: any) {
    const msg = err?.response?.data?.message || err?.message || t('errors.unknown', '未知错误');
    uiNotificationsStore.showError(t('remoteAgent.scan.killFailed', { error: msg }));
  } finally {
    killingScannedId.value = null;
  }
};

const searchTerm = ref('');

// +++ 组件级编辑状态 +++
const editingSuspendSessionId = ref<string | null>(null);
const currentEditingNameValue = ref<string>('');
const nameInputRef = ref<HTMLInputElement | null>(null);

const props = withDefaults(defineProps<{
  /** 面板是否处于展示状态。挂起时停掉轮询，重新展示时立刻静默对齐一次 */
  isActive?: boolean;
}>(), {
  isActive: true,
});

/** 只有「从没成功拉到过列表」才走首屏骨架，之后的刷新全是静默的 */
const showInitialLoading = computed(() => isLoading.value && !suspendedSshSessionsLoaded.value);

// +++ 监听编辑ID变化以聚焦输入框 +++
watch(editingSuspendSessionId, async (newId) => {
  if (newId !== null) {
    await nextTick(); // 确保DOM已更新，输入框已渲染
    if (nameInputRef.value && typeof nameInputRef.value.focus === 'function') {
      nameInputRef.value.focus();
      // nameInputRef.value.select(); // 可选：如果希望选中所有文本
    } else {
      console.warn('[SuspendedSshSessionsView] Watcher: nameInputRef.value is not a focusable input after nextTick.');
    }
  }
});

// filteredSessions 现在直接基于 storeSuspendedSshSessions
const filteredSessions = computed(() => {
  if (!searchTerm.value.trim()) {
    return storeSuspendedSshSessions.value;
  }
  const lowerSearchTerm = searchTerm.value.toLowerCase();
  return storeSuspendedSshSessions.value.filter((session: SuspendedSshSession) =>
    (session.customSuspendName?.toLowerCase() || '').includes(lowerSearchTerm) ||
    session.connectionName.toLowerCase().includes(lowerSearchTerm)
  );
});

const filterSessions = () => {
  // 计算属性会自动处理过滤
};

const formatDateTime = (isoString?: string) => {
  if (!isoString) return t('time.unknown');
  try {
    return new Date(isoString).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return t('time.invalidDate');
  }
};

const startEditingName = (session: SuspendedSshSession) => { // async 不再需要，聚焦由 watcher 处理
  editingSuspendSessionId.value = session.suspendSessionId;
  currentEditingNameValue.value = session.customSuspendName || session.connectionName;
  // 聚焦逻辑已移至 watcher
};

const finishEditingName = () => {
  if (editingSuspendSessionId.value === null) return;

  const sessionId = editingSuspendSessionId.value;
  const newName = currentEditingNameValue.value.trim();

  const originalSession = storeSuspendedSshSessions.value.find(s => s.suspendSessionId === sessionId);
  if (!originalSession) {
    editingSuspendSessionId.value = null; // 重置状态
    return;
  }

  editingSuspendSessionId.value = null; // 退出编辑模式

  if (newName && newName !== (originalSession.customSuspendName || originalSession.connectionName)) {
    sessionStore.editSshSessionName(sessionId, newName);
  }
  // 如果名称未变或为空，则无需操作，因为 currentEditingNameValue 不会持久化
};

const cancelEditingName = () => {
  editingSuspendSessionId.value = null;
  // currentEditingNameValue 不需要显式重置，因为它会在下次 startEditingName 时被新值覆盖
};

const resumeSession = async (session: SuspendedSshSession) => { // 参数类型改为 SuspendedSshSession
  console.log(`[SuspendedSshSessionsView] Attempting to resume session ID: ${session.suspendSessionId}, Name: ${session.customSuspendName || session.connectionName}`);
  // 使用 JSON.parse(JSON.stringify()) 来记录会话对象的一个快照，避免在异步操作后因对象被修改而导致日志不准确
  console.log('[SuspendedSshSessionsView] Session details snapshot:', JSON.parse(JSON.stringify(session)));

  try {
    // 假设 sessionStore.resumeSshSession 返回一个 Promise。
    // 如果它不返回 Promise (例如，它是一个同步的 action dispatch)，await 仍然是安全的，result 将会是 undefined。
    // 为了获取详细信息（如是否真正恢复、历史日志），sessionStore.resumeSshSession 可能需要被修改以返回一个包含这些信息的对象。
    const result = await sessionStore.resumeSshSession(session.suspendSessionId);

    console.log('[SuspendedSshSessionsView] Call to sessionStore.resumeSshSession completed.');

    // 检查 result 是否是包含期望信息的对象结构
    // @ts-ignore (因为我们不确定 result 的确切类型，并且这是在 Vue 文件中)
    if (result && typeof result === 'object' && ('isResumed' in result || 'historicalOutput' in result || 'message' in result)) {
      console.log('[SuspendedSshSessionsView] Result from resumeSshSession:', result);
      // @ts-ignore
      console.log(`[SuspendedSshSessionsView] Is session truly resumed (based on backend response)? : ${result.isResumed ? 'Yes, existing session resumed.' : 'No, a new session was likely opened (or status unknown from response).'}`);
      // @ts-ignore
      console.log('[SuspendedSshSessionsView] Historical terminal log from backend:', result.historicalOutput || 'Not provided or empty.');
      // @ts-ignore
      if (result.message) {
        // @ts-ignore
        console.log('[SuspendedSshSessionsView] Backend message:', result.message);
      }
    } else {
      console.log('[SuspendedSshSessionsView] sessionStore.resumeSshSession did not return the expected detailed information object (e.g., { isResumed: boolean, historicalOutput?: string, message?: string }). The action was dispatched.');
      console.log('[SuspendedSshSessionsView] To get client-side confirmation of session state and historical logs, the sessionStore.resumeSshSession action might need to be updated to return this data.');
      console.log('[SuspendedSshSessionsView] For now, please check browser developer console (network tab for backend responses) or backend logs for details on session restoration and historical log loading.');
      if (result !== undefined) {
          console.log('[SuspendedSshSessionsView] Actual value returned by resumeSshSession (if any):', result);
      }
    }
  } catch (error) {
    console.error(`[SuspendedSshSessionsView] Error during resumeSession for ${session.suspendSessionId}:`, error);
  }
  // 无论成功与否（或者仅在成功时，取决于需求），都可能需要通知模态框关闭
  // 为了简化，这里假设操作已发起，具体成功状态由 store 或后端处理
  emitWorkspaceEvent('suspendedSession:actionCompleted');
};

const removeSession = (session: SuspendedSshSession) => { // 参数类型改为 SuspendedSshSession
  if (session.backendSshStatus === 'hanging') {
    sessionStore.terminateAndRemoveSshSession(session.suspendSessionId);
  } else if (session.backendSshStatus === 'disconnected_by_backend') {
    sessionStore.removeSshSessionEntry(session.suspendSessionId);
  }
  emitWorkspaceEvent('suspendedSession:actionCompleted');
};

const exportLog = async (session: SuspendedSshSession) => {
 console.log(`[SuspendedSshSessionsView] Attempting to export log for session ID: ${session.suspendSessionId}`);
 await sessionStore.exportSshSessionLog(session.suspendSessionId);
 // 不需要 emitWorkspaceEvent，因为导出日志通常不关闭模态框
};

let fetchIntervalId: number | undefined;

const startPolling = () => {
  if (fetchIntervalId) return;
  fetchIntervalId = window.setInterval(() => {
    // 轮询永远静默：列表留在原地更新，不亮加载态
    void sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
  }, 3000);
};

const stopPolling = () => {
  if (fetchIntervalId) {
    clearInterval(fetchIntervalId);
    fetchIntervalId = undefined;
  }
};

onMounted(async () => {
  const connectionsStore = useConnectionsStore();

  // 先取列表，不等连接列表：连接只是「恢复」时才用得到，
  // 放在首屏前面只会把骨架多拖几百毫秒。
  await sessionStore.fetchSuspendedSshSessions();
  void connectionsStore.fetchConnections().catch((error) => {
    console.error('[SuspendedSshSessionsView] Error fetching connections:', error);
  });

  if (props.isActive) {
    startPolling();
  }
});

// 面板重新展示：先静默对齐一次（关闭期间轮询是停的），再恢复轮询
watch(() => props.isActive, (active) => {
  if (!active) {
    stopPolling();
    return;
  }
  searchTerm.value = '';
  void sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
  startPolling();
});

onUnmounted(() => {
  stopPolling();
});

</script>

<style scoped>
.suspended-ssh-sessions-view {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif,
    'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
}

.session-item {
  transition: background-color 0.2s ease-in-out;
}
.session-item:hover {
  background-color: var(--surface-hover); /* PrimeVue hover color */
}

/* ---- 挂起标识 ----
 * 项目没有 .dark 类（主题靠 :root 变量整体替换），所以这里一律用语义变量 + color-mix，
 * 浅色/深色两套主题下都能读出对比度。
 */
.sss-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  border: 1px solid transparent;
}

/* 全局 `i, .fas` 没进 @layer，会盖掉徽标自己的配色 */
.sss-badge i {
  color: inherit;
  font-size: 0.625rem;
}

.sss-badge--live {
  color: color-mix(in oklab, var(--color-success) 78%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-success) 14%, transparent);
  border-color: color-mix(in oklab, var(--color-success) 34%, transparent);
}

.sss-badge--dead {
  color: color-mix(in oklab, var(--color-warning) 70%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-warning) 16%, transparent);
  border-color: color-mix(in oklab, var(--color-warning) 34%, transparent);
}

/* 「挂起模式」：手动关标签进来的会话，和环境不同，用蓝色系区分 */
.sss-badge--paused {
  color: color-mix(in oklab, #2563eb 76%, var(--text-color));
  background-color: color-mix(in oklab, #2563eb 14%, transparent);
  border-color: color-mix(in oklab, #2563eb 36%, transparent);
}

/* 「目标机托管」：由目标主机本地 nexus-mux 托管的跨端会话，用紫色系区分 */
.sss-badge--remote {
  color: color-mix(in oklab, #7c3aed 78%, var(--text-color));
  background-color: color-mix(in oklab, #7c3aed 14%, transparent);
  border-color: color-mix(in oklab, #7c3aed 36%, transparent);
}

/* 进程退出码徽标 */
.sss-badge--exit {
  color: var(--text-color);
  background-color: color-mix(in oklab, var(--text-color) 10%, transparent);
  border-color: color-mix(in oklab, var(--text-color) 20%, transparent);
  font-family: monospace;
}

.sss-item--paused {
  border-left: 3px solid color-mix(in oklab, #2563eb 70%, transparent);
}

/* 搜索结果计数：贴在搜索框右侧，不额外占一行 */
.sss-hint-count {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  padding: 0 0.375rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  line-height: 1.4;
  font-weight: 600;
  pointer-events: none;
  color: var(--text-color);
  background-color: color-mix(in oklab, var(--text-color) 8%, transparent);
}

/* 首屏骨架：只在真正的第一次加载时出现，形状和真实条目一致，
 * 数据到了直接替换，不会出现「转圈 → 空列表 → 列表」两段跳。 */
.sss-skeleton {
  padding: 0.25rem 0 0;
}

.sss-skeleton-item {
  padding: 0.75rem;
  margin-bottom: 0.5rem;
  border: 1px solid color-mix(in oklab, var(--text-color) 12%, transparent);
  border-radius: 0.375rem;
}

.sss-skeleton-line {
  height: 0.625rem;
  border-radius: 9999px;
  background-color: color-mix(in oklab, var(--text-color) 9%, transparent);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in oklab, var(--text-color) 7%, transparent) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sss-shimmer 1.4s ease-in-out infinite;
}

.sss-skeleton-line + .sss-skeleton-line {
  margin-top: 0.5rem;
}

.sss-skeleton-line--title {
  width: 46%;
  height: 0.875rem;
}

.sss-skeleton-line--sub {
  width: 68%;
}

.sss-skeleton-line--time {
  width: 34%;
}

@keyframes sss-shimmer {
  0% {
    background-position: 140% 0;
  }
  100% {
    background-position: -40% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sss-skeleton-line {
    animation: none;
  }
}

/* 保持与 QuickCommandsView 类似的简洁风格 */
.p-inputtext-sm {
  padding: 0.375rem 0.5rem; /* 调整输入框大小 */
  font-size: 0.875rem;
}

.responsive-button-padding {
  padding-left: 0.75rem; /* px-3 */
  padding-right: 0.75rem; /* px-3 */
}

.action-icon {
  margin-right: 0.375rem; /* mr-1.5 */
}

.button-session-text {
  display: inline;
}

/* Apply styles when the container 'suspended-sessions-view-pane' is narrower than 480px */
@container suspended-sessions-view-pane (max-width: 300px) {
  .button-session-text {
    display: none;
  }

  .action-icon {
    margin-right: 0;
  }

  .responsive-button-padding {
    padding-left: 0.5rem; /* px-2 */
    padding-right: 0.5rem; /* px-2 */
  }

  /* Adjust list item layout for narrow view - Now we want to keep the two-column layout */
  /* .session-item > .flex { */ /* Targeting the main flex container inside session-item */
    /* flex-direction: column; */ /* REMOVED to keep horizontal layout */
    /* align-items: stretch; */   /* REMOVED */
  /* } */

  /* .session-item .session-info { */
    /* margin-right: 0; */ /* REMOVED */
    /* margin-bottom: 0.5rem; */ /* mb-2 */ /* REMOVED */
  /* } */

  .session-item .session-status-actions {
    /* 按钮组总是垂直排列并靠右 */
    /* margin-top: 0.5rem; */ /* This might still be useful if .session-info was above it, but now they are side-by-side */
    align-items: flex-end; /* 按钮组整体靠右 - KEEPING THIS */
  }
  
  .session-item .session-status-actions .actions {
     /* 按钮组垂直排列，内部元素（按钮）靠右对齐（如果容器宽度大于按钮）或充满（如果按钮宽度100%）*/
     /* For flex-col, align-items controls cross-axis (horizontal), justify-content controls main-axis (vertical) */
     /* We want buttons to be aligned to the end (right) of their vertical container if they are not full width */
    align-items: flex-end; /* This will align buttons to the right if they are not full width */
    /* justify-content: flex-end; */ /* This was for horizontal flex, for vertical, it would push to bottom */
  }

  /* 在窄视图下，确保按钮容器占满宽度，使按钮能正确对齐 */
  /* The nested container query might not be needed or needs simplification */
  @container suspended-sessions-view-pane (max-width: 320px) {
    .session-item .session-info .font-bold.text-lg { /* 针对名称和状态标签的容器 */
        flex-wrap: wrap; /* 如果名称和状态标签加起来太长，允许状态标签换行 - This is still good */
    }
    /* .session-item .session-status-actions { */
        /* 保持按钮在右侧 */
        /* align-items: flex-end; */ /* Already set above */
    /* } */
    .session-item .session-status-actions .actions {
      /* width: 100%; */ /* 让按钮容器占满，以便按钮可以靠左或靠右 - May not be needed if align-items: flex-end works */
      /* justify-content: flex-start; */ /* 在极窄情况下，按钮靠左可能更好 - REMOVED, we want them right-aligned or as per their container */
      align-items: flex-end; /* Ensure buttons themselves are right-aligned within their vertical stack */
    }
  }
}
</style>