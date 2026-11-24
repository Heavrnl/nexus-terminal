<script setup lang="ts">
import { ref, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import FolderSelect from '../../FolderSelect.vue';
import MobileSelectDrawer, { type MobileSelectOption } from '../../common/MobileSelectDrawer.vue';
import ToggleSwitch from '../../common/ToggleSwitch.vue';
import type { ProxyInfo } from '../../../stores/proxies.store';
import type { FolderInfo } from '../../../stores/folders.store';
import type { ConnectionInfo } from '../../../stores/connections.store';
import apiClient from '../../../utils/apiClient';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { useConfirmDialog } from '../../../composables/useConfirmDialog';

// 定义 Props
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
  folders: { type: Array as PropType<FolderInfo[]>, required: true },
  isProxyLoading: { type: Boolean, required: true },
  proxyStoreError: { type: String as PropType<string | null>, required: false, default: null },
  isFolderLoading: { type: Boolean, required: true },
  folderStoreError: { type: String as PropType<string | null>, required: false, default: null },
  advancedConnectionMode: { type: String as PropType<'proxy' | 'jump'>, required: true },
  addJumpHost: { type: Function as PropType<() => void>, required: true },
  removeJumpHost: { type: Function as PropType<(index: number) => void>, required: true },
  isEditMode: { type: Boolean, default: false }
});

// 定义 Emits
const emit = defineEmits<{
  (e: 'create-folder', folderName: string): void;
  (e: 'delete-folder', folderId: number): void;
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

// 高级选项折叠状态 (移动端默认展开，用户亦可随时折叠)
const isExpanded = ref(true);

const handleCreateFolderEvent = (folderName: string) => {
  emit('create-folder', folderName);
};

// 所属文件夹单选：跟桌面端一致，一个连接只属于一个文件夹（数据层仍是 folder_ids 数组，这里只取第一个）
const selectedFolderId = computed({
  get: () => (props.formData.folder_ids && props.formData.folder_ids.length > 0 ? props.formData.folder_ids[0] : null),
  set: (val: number | null) => {
    props.formData.folder_ids = val !== null ? [val] : [];
  },
});

const setConnectionMode = (mode: 'proxy' | 'jump') => {
  if (props.advancedConnectionMode === mode) return;
  emit('update:advancedConnectionMode', mode);
};

// 代理选项格式化为移动端抽屉选择器选项
const proxyOptions = computed<MobileSelectOption[]>(() => {
  return [
    {
      value: null,
      label: t('connections.form.noProxy', '不使用代理 (直连)'),
      sublabel: '通过当前网络直接发起连接',
      icon: 'fas fa-unlink',
    },
    ...props.proxies.map(p => ({
      value: p.id,
      label: p.name,
      sublabel: `${p.host}:${p.port}`,
      badge: p.type,
      icon: 'fas fa-network-wired',
    })),
  ];
});

// 计算特定跳板机层级可用的连接节点
const getAvailableJumpHostsForIndex = (currentIndex: number): ConnectionInfo[] => {
  return props.connections.filter(conn => {
    if (conn.type !== 'SSH') return false;
    if (props.isEditMode && props.formData.id === conn.id) return false;
    return !props.formData.jump_chain?.some((jumpHostId, index) => {
      return index !== currentIndex && jumpHostId === conn.id;
    });
  });
};

// 跳板机选项格式化为移动端抽屉选择器选项
const getJumpHostOptionsForIndex = (currentIndex: number): MobileSelectOption[] => {
  const available = getAvailableJumpHostsForIndex(currentIndex);
  return [
    {
      value: null,
      label: t('connections.form.selectJumpHost', '请选择跳板机节点'),
      sublabel: '点击选择可用的一级 SSH 节点',
      icon: 'fas fa-server',
    },
    ...available.map(h => ({
      value: h.id,
      label: h.name || h.host,
      sublabel: `${h.username ? h.username + '@' : ''}${h.host}:${h.port}`,
      badge: h.type,
      icon: 'fas fa-terminal',
    })),
  ];
};
</script>

<template>
  <div class="surface-raised border border-border/60 rounded-2xl shadow-2xs overflow-hidden">
    <!-- 折叠标题栏 -->
    <button
      type="button"
      @click="isExpanded = !isExpanded"
      class="w-full p-3.5 flex items-center justify-between text-left cursor-pointer active:bg-muted/40 transition-colors select-none gap-2"
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-xs shrink-0">
          <i class="fas fa-sliders-h"></i>
        </div>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-foreground tracking-tight leading-tight">
            {{ t('connections.form.sectionAdvanced', '高级选项') }}
          </div>
          <div class="text-[10px] text-text-secondary/70 truncate mt-0.5 max-w-[190px]">
            代理、跳板机、文件夹、备注
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1.5 text-text-secondary shrink-0">
        <span class="text-xs">{{ isExpanded ? '收起' : '展开' }}</span>
        <i :class="['fas text-xs transition-transform duration-200', isExpanded ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </div>
    </button>

    <!-- 折叠内容区 -->
    <div v-show="isExpanded" class="px-4 pb-4 pt-1 space-y-4 border-t border-border/40">
      <!-- 1. 网络穿透方式（网络代理 SSH/RDP/VNC 都支持；跳板机链只支持 SSH） -->
      <div v-if="props.formData.type === 'SSH' || props.advancedConnectionMode === 'proxy'" class="space-y-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.connectionMode', '网络连接路由方式') }}
          </label>
          <div
            class="grid gap-1.5 p-1 bg-muted/40 border border-border/60 rounded-xl"
            :class="props.formData.type === 'SSH' ? 'grid-cols-2' : 'grid-cols-1'"
          >
            <button
              type="button"
              @click="setConnectionMode('proxy')"
              class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer min-w-0 px-1.5"
              :class="props.advancedConnectionMode === 'proxy'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-text-secondary hover:text-foreground active:bg-border/30'"
            >
              <i class="fas fa-globe text-xs shrink-0"></i>
              <span class="truncate">{{ t('connections.form.connectionModeProxy', '正向代理') }}</span>
            </button>

            <button
              v-if="props.formData.type === 'SSH'"
              type="button"
              @click="setConnectionMode('jump')"
              class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer min-w-0 px-1.5"
              :class="props.advancedConnectionMode === 'jump'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-text-secondary hover:text-foreground active:bg-border/30'"
            >
              <i class="fas fa-random text-xs shrink-0"></i>
              <span class="truncate">{{ t('connections.form.connectionModeJumpHost', '跳板机链') }}</span>
            </button>
          </div>
        </div>

        <!-- 移动端抽屉式代理选择器 (模式为 proxy 时) -->
        <div v-if="props.advancedConnectionMode === 'proxy'" class="space-y-1.5">
          <label class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.proxy', '指定代理服务器') }}
          </label>
          <MobileSelectDrawer
            v-model="props.formData.proxy_id"
            :options="proxyOptions"
            title="选择代理服务器"
            placeholder="点击选择代理服务器 (支持直连)"
            :disabled="props.isProxyLoading && props.proxies.length === 0"
            icon="fas fa-globe"
            :allow-clear="true"
          />
          <div v-if="props.isProxyLoading && props.proxies.length === 0" class="text-[11px] text-text-secondary">{{ t('proxies.loading', '加载代理列表中...') }}</div>
          <div v-if="props.proxyStoreError" class="text-[11px] text-red-400">{{ t('proxies.error', { error: props.proxyStoreError }) }}</div>
        </div>

        <!-- 跳板机链配置 (模式为 jump 时) -->
        <div v-if="props.advancedConnectionMode === 'jump'" class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="block text-xs font-medium text-text-secondary">
              {{ t('connections.form.jumpHostsTitle', '跳板机链配置') }}
            </label>
            <span class="text-[11px] text-text-secondary/70">自上而下顺序穿透</span>
          </div>

          <!-- 跳板机列表 -->
          <div v-if="props.formData.jump_chain && props.formData.jump_chain.length > 0" class="space-y-2">
            <div
              v-for="(jumpHostId, index) in props.formData.jump_chain"
              :key="index"
              class="flex items-center gap-2 p-2.5 bg-muted/30 border border-border/60 rounded-xl"
            >
              <span class="w-6 h-6 rounded-full bg-primary/20 text-primary text-[11px] font-bold flex items-center justify-center shrink-0">
                {{ index + 1 }}
              </span>

              <div class="flex-grow min-w-0">
                <MobileSelectDrawer
                  v-model="props.formData.jump_chain[index]"
                  :options="getJumpHostOptionsForIndex(index)"
                  title="选择跳板机节点"
                  placeholder="点击选择跳板机..."
                  icon="fas fa-server"
                  :allow-clear="true"
                />
              </div>

              <!-- 移除此级跳板机 -->
              <button
                type="button"
                @click="props.removeJumpHost(index)"
                class="w-10 h-10 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 active:scale-95 flex items-center justify-center shrink-0 transition-all cursor-pointer shadow-2xs"
                :title="t('connections.form.removeJumpHostTitle', '移除此跳板机')"
              >
                <i class="fas fa-trash-alt text-xs"></i>
              </button>
            </div>
          </div>

          <!-- 添加下一级跳板机按钮 -->
          <button
            type="button"
            @click="props.addJumpHost()"
            class="w-full h-10 rounded-xl border border-dashed border-primary/50 text-primary bg-primary/5 hover:bg-primary/10 active:scale-98 flex items-center justify-center gap-2 text-xs font-medium transition-all cursor-pointer"
          >
            <i class="fas fa-plus text-xs"></i>
            <span>{{ t('connections.form.addJumpHost', '添加跳板机') }}</span>
          </button>

          <div
            v-if="props.connections.filter(c => c.type === 'SSH' && (!props.isEditMode || c.id !== props.formData.id)).length === 0"
            class="text-[11px] text-amber-500 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl leading-relaxed"
          >
            {{ t('connections.form.noAvailableSshConnectionsForJump', '暂无可用的 SSH 主机作为跳板机，请先添加其他 SSH 主机。') }}
          </div>
        </div>
      </div>

      <!-- 移动端文件传输协议选择 (仅 SSH 支持) -->
      <div v-if="props.formData.type === 'SSH'" class="space-y-1.5">
        <label class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.fileProtocol', '文件传输协议') }}
        </label>
        <div class="grid grid-cols-3 gap-1.5 p-1 rounded-xl border border-border/70 bg-input">
          <button
            type="button"
            @click="props.formData.file_protocol = 'auto'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer min-w-0 px-1"
            :class="(!props.formData.file_protocol || props.formData.file_protocol === 'auto')
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-magic text-[10px]"></i>
            <span class="truncate">{{ t('connections.form.fileProtocolAuto', '自动探测') }}</span>
          </button>
          <button
            type="button"
            @click="props.formData.file_protocol = 'sftp'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer min-w-0 px-1"
            :class="props.formData.file_protocol === 'sftp'
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-server text-[10px]"></i>
            <span class="truncate">SFTP</span>
          </button>
          <button
            type="button"
            @click="props.formData.file_protocol = 'scp'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer min-w-0 px-1"
            :class="props.formData.file_protocol === 'scp'
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-network-wired text-[10px]"></i>
            <span class="truncate">SCP</span>
          </button>
        </div>
      </div>

      <!-- 2. 所属文件夹（单选，与桌面端一致） -->
      <div class="space-y-1.5 pt-1">
        <label class="block text-xs font-medium text-text-secondary">
          <i class="fas fa-folder text-amber-400 mr-1"></i>
          {{ t('connections.form.folders', '所属文件夹') }}
        </label>
        <FolderSelect
          v-model="selectedFolderId"
          :folders="props.folders"
          :allow-create="true"
          @create-folder="handleCreateFolderEvent"
          :placeholder="t('folders.selectPlaceholder', '选择所属文件夹...')"
        />
        <div v-if="props.isFolderLoading && props.folders.length === 0" class="text-[11px] text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        <div v-if="props.folderStoreError" class="text-[11px] text-red-400">{{ t('folders.error', { error: props.folderStoreError }) }}</div>
      </div>

      <!-- 2.5 连接级启动命令（仅 SSH） -->
      <div v-if="props.formData.type === 'SSH'" class="space-y-1.5 pt-1">
        <label for="m-conn-startup-command" class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.startupCommand', '启动命令') }}
        </label>
        <input
          id="m-conn-startup-command"
          v-model="props.formData.startup_command"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('connections.form.startupCommandPlaceholder', '连上后自动执行，例如 sudo -i')"
          class="w-full px-3 py-2.5 text-xs bg-muted/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors font-mono"
        />
        <p class="text-[11px] leading-snug text-text-secondary/80">
          {{ t('connections.form.startupCommandHint', '每次连接终端时自动执行。布局里为窗格配的「自启指令」是独立的一份，两边都配了就都执行。') }}
        </p>
      </div>

      <!-- 2.6 SFTP sudo 提权（仅 SSH） -->
      <div v-if="props.formData.type === 'SSH'" class="space-y-1.5 pt-1">
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
          v-model="props.formData.sudo_password"
          type="password"
          autocomplete="new-password"
          :placeholder="t('connections.form.sftpSudoPasswordPlaceholder', '留空则使用免密 sudo')"
          class="w-full px-3 py-2.5 text-xs bg-muted/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        />
        <p v-if="props.formData.sftp_sudo_enabled" class="text-[11px] leading-snug text-text-secondary/80">
          {{
            props.formData.has_sudo_password && !props.formData.sudo_password
              ? t('connections.form.sftpSudoPasswordSaved', '已保存过密码，留空表示不修改。')
              : t('connections.form.sftpSudoHint', '用上面的密码以 sudo 启动 sftp-server，从而读写 root 路径。留空时要求服务器允许免密 sudo。')
          }}
        </p>
      </div>

      <!-- 2.7 SSH 会话托管模式与代理清理（仅 SSH） -->
      <div v-if="props.formData.type === 'SSH'" class="space-y-1.5 pt-1">
        <label class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.sessionHostingMode', 'SSH 会话托管模式') }}
        </label>
        <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl border border-border/70 bg-input">
          <button
            type="button"
            @click="props.formData.session_hosting_mode = 'auto'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer min-w-0 px-1.5"
            :class="(!props.formData.session_hosting_mode || props.formData.session_hosting_mode === 'auto')
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-microchip text-[10px] shrink-0"></i>
            <span class="truncate">{{ t('connections.form.sessionHostingModeAuto', '自动（目标机托管）') }}</span>
          </button>
          <button
            type="button"
            @click="props.formData.session_hosting_mode = 'legacy'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all cursor-pointer min-w-0 px-1.5"
            :class="props.formData.session_hosting_mode === 'legacy'
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-terminal text-[10px] shrink-0"></i>
            <span class="truncate">{{ t('connections.form.sessionHostingModeLegacy', '仅传统直连模式') }}</span>
          </button>
        </div>
        <p class="text-[11px] leading-snug text-text-secondary/80">
          {{ t('connections.form.sessionHostingModeHint', '自动模式下遵循全局设置：优先由目标机轻量代理托管会话以支持跨端无缝接管；不支持时自动静默降级。') }}
        </p>
        <button
          v-if="props.isEditMode && props.formData.id"
          type="button"
          :disabled="isUninstallingAgent"
          @click="handleUninstallRemoteAgent"
          class="w-full h-9 rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
        >
          <i :class="isUninstallingAgent ? 'fas fa-spinner fa-spin' : 'fas fa-broom'"></i>
          <span>{{ t('remoteAgent.uninstall.button', '卸载目标机代理') }}</span>
        </button>
      </div>

      <!-- 3. 备注信息 -->
      <div class="space-y-1.5 pt-1">
        <label for="m-conn-notes" class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.notes', '备注与描述') }}
        </label>
        <textarea
          id="m-conn-notes"
          v-model="props.formData.notes"
          rows="3"
          placeholder="记录关于该服务器的用途、维护提醒等..."
          class="w-full p-3 text-xs bg-muted/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors leading-relaxed"
        ></textarea>
      </div>
    </div>
  </div>
</template>
