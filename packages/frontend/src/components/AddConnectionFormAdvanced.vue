<script setup lang="ts">
import { ref, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProxyInfo } from '../stores/proxies.store';
import type { ConnectionInfo } from '../stores/connections.store';
import apiClient from '../utils/apiClient';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import AppSelect from './common/AppSelect.vue';
import ToggleSwitch from './common/ToggleSwitch.vue';

// Define Props
const props = defineProps({
  formData: {
    type: Object as PropType<{
      id?: number;
      type: 'SSH' | 'RDP' | 'VNC';
      proxy_id: number | null;
      jump_chain: Array<number | null> | null;
      proxy_type?: 'proxy' | 'jump' | null;
      folder_ids: number[];
      notes: string;
      file_protocol?: 'auto' | 'sftp' | 'scp';
      startup_command?: string;
      sftp_sudo_enabled?: boolean;
      sudo_password?: string;
      has_sudo_password?: boolean;
      session_hosting_mode?: 'auto' | 'legacy';
    }>,
    required: true
  },
  proxies: { type: Array as PropType<ProxyInfo[]>, required: true },
  connections: { type: Array as PropType<ConnectionInfo[]>, required: true }, 
  isProxyLoading: { type: Boolean, required: true },
  proxyStoreError: { type: String as PropType<string | null>, required: false, default: null },
  advancedConnectionMode: { type: String as PropType<'proxy' | 'jump'>, required: true },
  addJumpHost: { type: Function as PropType<() => void>, required: true },
  removeJumpHost: { type: Function as PropType<(index: number) => void>, required: true },
  isEditMode: { type: Boolean, default: false } 
});

// Define Emits
const emit = defineEmits<{
  (e: 'update:advancedConnectionMode', mode: 'proxy' | 'jump'): void;
}>();

const { t } = useI18n();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();
const isUninstallingAgent = ref(false);

const handleUninstallRemoteAgent = async () => {
  if (!props.formData.id || isUninstallingAgent.value) return;
  const confirmed = await showConfirmDialog({
    title: t('remoteAgent.uninstall.confirmTitle', '卸载目标机托管代理'),
    message: t(
      'remoteAgent.uninstall.confirmMessage',
      '将停止该主机上的 nexus-mux 守护进程并清理其二进制与运行时文件（正在该主机后台保活的托管会话也会随之结束）。确认继续吗？'
    ),
  });
  if (!confirmed) return;

  isUninstallingAgent.value = true;
  try {
    await apiClient.post(`/connections/${props.formData.id}/remote-agent/uninstall`);
    uiNotificationsStore.showSuccess(t('remoteAgent.uninstall.success', '已成功卸载并清理目标机托管代理'));
  } catch (err: any) {
    const msg = err?.response?.data?.message || err?.message || t('errors.unknown', '未知错误');
    uiNotificationsStore.showError(t('remoteAgent.uninstall.failed', { error: msg }));
  } finally {
    isUninstallingAgent.value = false;
  }
};

const setConnectionMode = (mode: 'proxy' | 'jump') => {
  if (props.advancedConnectionMode === mode) return; // Access directly
  emit('update:advancedConnectionMode', mode);

};


const getAvailableJumpHostsForIndex = (currentIndex: number): ConnectionInfo[] => {
  return props.connections.filter(conn => {
    if (conn.type !== 'SSH') return false;
    if (props.isEditMode && props.formData.id === conn.id) return false;
    return !props.formData.jump_chain?.some((jumpHostId, index) => {
      return index !== currentIndex && jumpHostId === conn.id;
    });
  });
};
</script>

<template>
  <!-- 高级配置卡片：立体卡片 -->
  <div
    class="rounded-2xl border border-border/70 surface-raised p-4 md:p-5 space-y-4 shadow-sm"
  >
    <div class="flex items-center justify-between pb-2.5 border-b border-border/50">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-md bg-purple-500/15 text-purple-400 flex items-center justify-center text-xs">
          <i class="fas fa-sliders-h"></i>
        </div>
        <h4 class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('connections.form.sectionAdvanced', '高级选项') }}</h4>
      </div>
    </div>

    <!-- 连接方式切换（网络代理 SSH/RDP/VNC 都支持；跳板机链只支持 SSH） -->
    <div>
      <label class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.connectionMode', '网络穿透方式') }}</label>
      <div
        class="grid gap-1.5 p-1 rounded-xl border border-border/70 bg-input"
        :class="props.formData.type === 'SSH' ? 'grid-cols-2' : 'grid-cols-1'"
      >
        <button
          type="button"
          @click="setConnectionMode('proxy')"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.advancedConnectionMode === 'proxy' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-shield-alt text-[10px]"></i>
          <span>{{ t('connections.form.connectionModeProxy', '网络代理') }}</span>
        </button>
        <button
          v-if="props.formData.type === 'SSH'"
          type="button"
          @click="setConnectionMode('jump')"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.advancedConnectionMode === 'jump' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-random text-[10px]"></i>
          <span>{{ t('connections.form.connectionModeJumpHost', '跳板机链') }}</span>
        </button>
      </div>
    </div>

    <!-- 代理选择（SSH / RDP / VNC 都支持 SOCKS5 与 HTTP CONNECT） -->
    <div v-if="props.advancedConnectionMode === 'proxy'">
      <label for="conn-proxy" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.proxy') }}</label>
      <AppSelect
        id="conn-proxy"
        v-model="props.formData.proxy_id"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary appearance-none bg-no-repeat bg-right pr-8 transition-all shadow-2xs"
      >
        <option :value="null">{{ t('connections.form.noProxy', '不使用代理 (直连)') }}</option>
        <option v-for="proxy in props.proxies" :key="proxy.id" :value="proxy.id">
          {{ proxy.name }} ({{ proxy.type }} - {{ proxy.host }}:{{ proxy.port }})
        </option>
      </AppSelect>
      <div v-if="props.isProxyLoading && props.proxies.length === 0" class="mt-1 text-xs text-text-secondary">{{ t('proxies.loading') }}</div>
      <div v-if="props.proxyStoreError" class="mt-1 text-xs text-error">{{ t('proxies.error', { error: props.proxyStoreError }) }}</div>
    </div>

    <!-- 跳板机链配置 -->
    <div v-if="props.formData.type === 'SSH' && props.advancedConnectionMode === 'jump'" class="space-y-2.5">
      <label class="block text-xs font-medium text-text-secondary mb-1">{{ t('connections.form.jumpHostsTitle', '跳板机链配置') }}</label>
      <template v-if="props.formData.jump_chain">
        <div
          v-for="(jumpHostId, index) in props.formData.jump_chain"
          :key="index"
          class="flex items-center space-x-2 p-2 border border-border/70 rounded-xl bg-input"
        >
          <span class="text-xs font-medium text-text-secondary whitespace-nowrap pl-1">{{ t('connections.form.jumpHostLabel', '跳板机') }} {{ index + 1 }}:</span>
          <AppSelect
            v-model="props.formData.jump_chain[index]"
            class="flex-grow px-3 py-1.5 text-xs border border-border/60 rounded-lg text-foreground bg-background focus:outline-none focus:ring-1 focus:ring-primary appearance-none bg-no-repeat bg-right pr-8"
          >
            <option :value="null">{{ t('connections.form.selectJumpHost', '请选择跳板机') }}</option>
            <option v-for="host in getAvailableJumpHostsForIndex(index)" :key="host.id" :value="host.id">
              {{ host.name }}
            </option>
          </AppSelect>
          <button
            type="button"
            @click="props.removeJumpHost(index)"
            class="p-1.5 text-error hover:bg-error/10 focus:outline-none rounded-lg transition-colors cursor-pointer"
            :title="t('connections.form.removeJumpHostTitle', '移除此跳板机')"
          >
            <i class="fas fa-trash-alt text-xs"></i>
          </button>
        </div>
      </template>
      <button
        type="button"
        @click="props.addJumpHost()"
        class="w-full flex items-center justify-center space-x-2 px-3 py-2 border border-dashed border-primary/50 text-primary text-xs font-medium rounded-xl hover:bg-primary/10 focus:outline-none transition-colors cursor-pointer"
      >
        <i class="fas fa-plus text-xs"></i>
        <span>{{ t('connections.form.addJumpHost', '添加跳板机节点') }}</span>
      </button>
      <div
        v-if="props.connections.filter(c => c.type === 'SSH' && (!props.isEditMode || c.id !== props.formData.id)).length === 0"
        class="text-xs text-text-secondary p-2.5 border border-border/70 rounded-xl bg-input"
      >
        {{ t('connections.form.noAvailableSshConnectionsForJump', '暂无可用的 SSH 主机作为跳板机') }}
      </div>
    </div>

    <!-- 文件传输协议选择 (仅 SSH 支持) -->
    <div v-if="props.formData.type === 'SSH'">
      <label class="block text-xs font-medium text-text-secondary mb-1.5">
        {{ t('connections.form.fileProtocol', '文件传输协议') }}
      </label>
      <div class="grid grid-cols-3 gap-1.5 p-1 rounded-xl border border-border/70 bg-input">
        <button
          type="button"
          @click="props.formData.file_protocol = 'auto'"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer"
          :class="(!props.formData.file_protocol || props.formData.file_protocol === 'auto') ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-magic text-[10px]"></i>
          <span>{{ t('connections.form.fileProtocolAuto', '自动探测') }}</span>
        </button>
        <button
          type="button"
          @click="props.formData.file_protocol = 'sftp'"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer"
          :class="props.formData.file_protocol === 'sftp' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-server text-[10px]"></i>
          <span>SFTP</span>
        </button>
        <button
          type="button"
          @click="props.formData.file_protocol = 'scp'"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer"
          :class="props.formData.file_protocol === 'scp' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-network-wired text-[10px]"></i>
          <span>SCP</span>
        </button>
      </div>
    </div>

    <!-- 连接级启动命令（仅 SSH） -->
    <div v-if="props.formData.type === 'SSH'">
      <label for="conn-startup-command" class="block text-xs font-medium text-text-secondary mb-1.5">
        {{ t('connections.form.startupCommand', '启动命令') }}
      </label>
      <input
        id="conn-startup-command"
        v-model="props.formData.startup_command"
        type="text"
        spellcheck="false"
        autocomplete="off"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs font-mono"
        :placeholder="t('connections.form.startupCommandPlaceholder', '连上后自动执行，例如 sudo -i')"
      />
      <p class="mt-1 text-[11px] leading-snug text-text-secondary/80">
        {{ t('connections.form.startupCommandHint', '每次连接终端时自动执行。布局里为窗格配的「自启指令」是独立的一份，两边都配了就都执行。') }}
      </p>
    </div>

    <!-- SFTP sudo 提权（仅 SSH） -->
    <div v-if="props.formData.type === 'SSH'" class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <label class="text-xs font-medium text-text-secondary">
          {{ t('connections.form.sftpSudoEnabled', '开启 SFTP sudo 提权') }}
        </label>
        <ToggleSwitch
          :model-value="!!props.formData.sftp_sudo_enabled"
          size="sm"
          :aria-label="t('connections.form.sftpSudoEnabled', '开启 SFTP sudo 提权')"
          @update:model-value="(v: boolean) => (props.formData.sftp_sudo_enabled = v)"
        />
      </div>
      <input
        v-if="props.formData.sftp_sudo_enabled"
        :id="'conn-sudo-password'"
        v-model="props.formData.sudo_password"
        type="password"
        autocomplete="new-password"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        :placeholder="t('connections.form.sftpSudoPasswordPlaceholder', '留空则使用免密 sudo')"
      />
      <p v-if="props.formData.sftp_sudo_enabled" class="text-[11px] leading-snug text-text-secondary/80">
        {{
          props.formData.has_sudo_password && !props.formData.sudo_password
            ? t('connections.form.sftpSudoPasswordSaved', '已保存过密码，留空表示不修改。')
            : t('connections.form.sftpSudoHint', '用上面的密码以 sudo 启动 sftp-server，从而读写 root 路径。留空时要求服务器允许免密 sudo。')
        }}
      </p>
    </div>

    <!-- 会话托管模式与代理清理（仅 SSH） -->
    <div v-if="props.formData.type === 'SSH'" class="space-y-2">
      <label class="block text-xs font-medium text-text-secondary">
        {{ t('connections.form.sessionHostingMode', 'SSH 会话托管模式') }}
      </label>
      <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl border border-border/70 bg-input">
        <button
          type="button"
          @click="props.formData.session_hosting_mode = 'auto'"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="(!props.formData.session_hosting_mode || props.formData.session_hosting_mode === 'auto') ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-microchip text-[10px]"></i>
          <span>{{ t('connections.form.sessionHostingModeAuto', '自动（目标机托管）') }}</span>
        </button>
        <button
          type="button"
          @click="props.formData.session_hosting_mode = 'legacy'"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.formData.session_hosting_mode === 'legacy' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-terminal text-[10px]"></i>
          <span>{{ t('connections.form.sessionHostingModeLegacy', '仅传统直连模式') }}</span>
        </button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] leading-snug text-text-secondary/80">
          {{ t('connections.form.sessionHostingModeHint', '自动模式下遵循全局设置：优先由目标机轻量代理托管会话以支持跨端无缝接管；不支持时自动静默降级。') }}
        </p>
        <button
          v-if="props.isEditMode && props.formData.id"
          type="button"
          :disabled="isUninstallingAgent"
          @click="handleUninstallRemoteAgent"
          class="shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
        >
          <i :class="isUninstallingAgent ? 'fas fa-spinner fa-spin' : 'fas fa-broom'"></i>
          <span>{{ t('remoteAgent.uninstall.button', '卸载目标机代理') }}</span>
        </button>
      </div>
    </div>

    <!-- 备注信息 -->
    <div>
      <label for="conn-notes" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.notes', '备注说明') }}</label>
      <textarea
        id="conn-notes"
        v-model="props.formData.notes"
        rows="2"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        :placeholder="t('connections.form.notesPlaceholder', '可选，输入主机补充说明...')"
      ></textarea>
    </div>
  </div>
</template>