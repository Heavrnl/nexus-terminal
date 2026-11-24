import { ref, reactive, watch, computed, onMounted, toRefs } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore, ConnectionInfo } from '../stores/connections.store';
import { useProxiesStore } from '../stores/proxies.store';
import { useFoldersStore } from '../stores/folders.store';
import { useSshKeysStore } from '../stores/sshKeys.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from './useConfirmDialog';
import { useAlertDialog } from './useAlertDialog';
import { parseScriptText } from '../utils/scriptConnectionParser';

// Define Props interface based on the component's props
interface AddConnectionFormProps {
  connectionToEdit: ConnectionInfo | null;
}

// Define Emits type based on the component's emits
type AddConnectionFormEmits = {
  (e: 'close'): void;
  (e: 'connection-added'): void;
  (e: 'connection-updated'): void;
  (e: 'connection-deleted'): void;
};

export function useAddConnectionForm(props: AddConnectionFormProps, emit: AddConnectionFormEmits) {
  const { connectionToEdit } = toRefs(props);

  const { t, te } = useI18n();
  const { showConfirmDialog } = useConfirmDialog();
  const { showAlertDialog } = useAlertDialog();
  const connectionsStore = useConnectionsStore();
  const proxiesStore = useProxiesStore();
  const foldersStore = useFoldersStore();
  const sshKeysStore = useSshKeysStore();
  const uiNotificationsStore = useUiNotificationsStore();

  const { isLoading: isConnLoading, error: connStoreError, connections } = storeToRefs(connectionsStore);
  const { proxies, isLoading: isProxyLoading, error: proxyStoreError } = storeToRefs(proxiesStore);
  const { folders, isLoading: isFolderLoading, error: folderStoreError } = storeToRefs(foldersStore);
  const { sshKeys, isLoading: isSshKeyLoading, error: sshKeyStoreError } = storeToRefs(sshKeysStore);

  // 表单数据模型
  const initialFormData = {
    id: undefined as number | undefined,
    type: 'SSH' as 'SSH' | 'RDP' | 'VNC',
    name: '',
    host: '',
    port: 22,
    username: '',
    auth_method: 'password' as 'password' | 'key',
    password: '',
    private_key: '',
    passphrase: '',
    /** 内联新建密钥时的名称（留空自动取名），随连接一起提交 */
    ssh_key_name: '',
    selected_ssh_key_id: null as number | null,
    proxy_id: null as number | null,
    jump_chain: null as Array<any> | null, 
    proxy_type: null as 'proxy' | 'jump' | null, 
    folder_ids: [] as number[],
    notes: '',
    vncPassword: '',
    custom_background_color: false,
    background_color: '#3b82f6',
    file_protocol: 'auto' as 'auto' | 'sftp' | 'scp',
    /** 连接级启动命令：连上终端后自动执行；布局里的「自启指令」是另一份，两边都配了就都执行 */
    startup_command: '',
    /** SFTP sudo 提权：用 `sudo sftp-server` 开文件通道，能读写 root 路径。默认开启，失败会自动退回普通 SFTP */
    sftp_sudo_enabled: true,
    /** sudo 密码明文，只在提交时上行一次；编辑时不回显（留空 = 不改） */
    sudo_password: '',
    /** 只读：后端是否已存了 sudo 密码 */
    has_sudo_password: false,
    /** 目标机自托管策略：auto 跟随全局设置，legacy 强制传统 SSH 模式 */
    session_hosting_mode: 'auto' as 'auto' | 'legacy',
  };
  const formData = reactive({ ...initialFormData });

  /**
   * 用户在「SSH 密钥」卡片里就地粘了私钥（而不是选已有密钥）。
   * 这种模式下提交时要先把私钥存成一把正式密钥，再带着它的 id 去建连接。
   */
  const hasInlineSshKey = computed(
    () => formData.type === 'SSH'
      && formData.auth_method === 'key'
      && (formData.private_key || '').trim().length > 0
  );

  const formError = ref<string | null>(null); // 表单级别的错误信息
  const advancedConnectionMode = ref<'proxy' | 'jump'>('proxy');

  // 合并所有 store 的加载和错误状态
  // ⚠️ 这个只表示「表单依赖的数据（连接/代理/标签/密钥）是否在拉取」，**不是**提交态。
  // 切屏回来、或别的设备改动了数据时，全局同步会后台刷新这些 store（isLoading 闪一下 true），
  // 如果拿它当提交态，底部按钮就会瞬间变成「正在添加…」并把自己置灰。
  const isLoading = computed(() => isConnLoading.value || isProxyLoading.value || isFolderLoading.value || isSshKeyLoading.value); // +++ Include SSH Key loading +++
  const storeError = computed(() => connStoreError.value || proxyStoreError.value || folderStoreError.value || sshKeyStoreError.value); // +++ Include SSH Key error +++

  /**
   * 表单自己的提交态：只有用户点「确认添加 / 保存」真正在等后端时才为 true。
   * 提交按钮的禁用、转圈、文案都必须只看这个，不能看 store 的 isLoading。
   */
  const isSubmitting = ref(false);

  // 测试连接状态
  const testStatus = ref<'idle' | 'testing' | 'success' | 'error'>('idle');
  const testResult = ref<string | number | null>(null); // 存储延迟或错误信息
  const testLatency = ref<number | null>(null); // 单独存储延迟用于颜色计算

  // Script Mode State
  const isScriptModeActive = ref(false);
  const scriptInputText = ref('');

  // 计算属性判断是否为编辑模式
  const isEditMode = computed(() => !!connectionToEdit.value);

  // When switching to edit mode, disable script mode
  watch(isEditMode, (editing) => {
    if (editing) {
      isScriptModeActive.value = false;
    }
  });

  // 计算属性动态设置表单标题
  const formTitle = computed(() => {
      return isEditMode.value ? t('connections.form.titleEdit') : t('connections.form.title');
  });

  // 提交按钮文案：固定，不做「正在添加…」这类过渡态（提交期间只靠 disabled 表达）
  const submitButtonText = computed(() =>
      isEditMode.value ? t('connections.form.confirmEdit') : t('connections.form.confirm')
  );

  // 监听 prop 变化以填充或重置表单
  watch(connectionToEdit, (newVal) => {
      formError.value = null; // 清除错误
      if (newVal) {
          formData.id = newVal.id;
          formData.type = newVal.type as 'SSH' | 'RDP' | 'VNC';
          formData.name = newVal.name;
          formData.host = newVal.host;
          formData.port = newVal.port;
          formData.username = newVal.username;
          formData.auth_method = newVal.auth_method;
          formData.proxy_id = newVal.proxy_id ?? null;
          formData.proxy_type = newVal.proxy_type ?? null; 
          formData.jump_chain = newVal.jump_chain ? JSON.parse(JSON.stringify(newVal.jump_chain)) : null; 
          console.log('[Debug] watch connectionToEdit - newVal.jump_chain:', newVal.jump_chain);
          console.log('[Debug] watch connectionToEdit - formData.jump_chain initialized:', formData.jump_chain);
          formData.notes = newVal.notes ?? '';
          formData.folder_ids = newVal.folder_ids ? [...newVal.folder_ids] : [];

          if (newVal.type === 'SSH' && newVal.auth_method === 'key') {
              formData.selected_ssh_key_id = newVal.ssh_key_id ?? null;
          } else {
              formData.selected_ssh_key_id = null;
          }

          if (newVal.proxy_type === 'jump' && newVal.jump_chain && newVal.jump_chain.length > 0) {
              advancedConnectionMode.value = 'jump';
          } else if (newVal.proxy_type === 'proxy' && newVal.proxy_id !== null && newVal.proxy_id !== undefined) {
              advancedConnectionMode.value = 'proxy';
          }
          else if (newVal.jump_chain && newVal.jump_chain.length > 0 && (newVal.proxy_id === null || newVal.proxy_id === undefined)) {
             advancedConnectionMode.value = 'jump';
          } else {
             advancedConnectionMode.value = 'proxy';
          }

          formData.password = '';
          formData.private_key = '';
          formData.passphrase = '';
          formData.ssh_key_name = '';
          if (newVal.type !== 'VNC') {
               formData.vncPassword = '';
          } else {
              formData.vncPassword = ''; // 保持原逻辑或根据需求调整
          }
          if (newVal.background_color) {
              formData.custom_background_color = true;
              formData.background_color = newVal.background_color;
          } else {
              formData.custom_background_color = false;
              formData.background_color = '#3b82f6';
          }
          formData.file_protocol = newVal.file_protocol ?? 'auto';
          formData.startup_command = newVal.startup_command ?? '';
          formData.sftp_sudo_enabled = !!newVal.sftp_sudo_enabled;
          formData.sudo_password = '';
          formData.has_sudo_password = !!newVal.has_sudo_password;
          formData.session_hosting_mode = newVal.session_hosting_mode === 'legacy' ? 'legacy' : 'auto';
     } else {
         Object.assign(formData, initialFormData);
         formData.folder_ids = [];
         formData.selected_ssh_key_id = null;
         formData.notes = '';
         formData.vncPassword = '';
         formData.jump_chain = null; 
         formData.proxy_type = null;
         formData.custom_background_color = false;
         formData.background_color = '#3b82f6';
         formData.file_protocol = 'auto';
         formData.startup_command = '';
         formData.sftp_sudo_enabled = true;
         formData.sudo_password = '';
         formData.has_sudo_password = false;
         formData.session_hosting_mode = 'auto';
         console.log('[Debug] watch connectionToEdit - formData.jump_chain reset');
         advancedConnectionMode.value = 'proxy'; 
    }
  }, { immediate: true });

  // 组件挂载时获取代理、标签和 SSH 密钥列表
  onMounted(() => {
      proxiesStore.fetchProxies();
      foldersStore.fetchFolders();
      sshKeysStore.fetchSshKeys();
  });

  // 监听连接类型变化，动态调整默认端口
  watch(() => formData.type, (newType) => {
      if (newType === 'RDP') {
          if (formData.port === 22 || formData.port === 5900 || formData.port === 5901) formData.port = 3389;
          formData.auth_method = 'password';
          formData.selected_ssh_key_id = null;
      } else if (newType === 'SSH') {
          if (formData.port === 3389 || formData.port === 5900 || formData.port === 5901) formData.port = 22;
      } else if (newType === 'VNC') {
          if (formData.port === 22 || formData.port === 3389) formData.port = 5900;
          formData.auth_method = 'password';
          formData.selected_ssh_key_id = null;
      }
      // 跳板机链只有 SSH 支持（RDP/VNC 不支持在跳板机上开 direct-tcpip 通道），
      // 切到非 SSH 类型时把模式拨回「网络代理」，否则会卡在 jump 上、代理选项永远不出现
      if (newType !== 'SSH' && advancedConnectionMode.value === 'jump') {
          advancedConnectionMode.value = 'proxy';
      }
  });

  
  watch([() => formData.type, advancedConnectionMode], ([newType, newAdvMode], [oldType, oldAdvMode]) => {
    if (newAdvMode === 'proxy') {
      // 网络代理 SSH / RDP / VNC 都支持：远程桌面在服务端建立 TCP 时套 SOCKS5 / HTTP CONNECT
      formData.proxy_type = 'proxy';
    } else if (newType === 'SSH' && newAdvMode === 'jump') {
      formData.proxy_type = 'jump';
    } else {
      formData.proxy_type = null;
    }
    console.log(`[Debug] useAddConnectionForm: proxy_type set to ${formData.proxy_type} (type: ${newType}, mode: ${newAdvMode})`);
  }, { immediate: true });

  // Helper function to parse IP range
  const parseIpRange = (ipRangeStr: string): string[] | { error: string } => {
    if (!ipRangeStr.includes('~')) {
        return { error: 'not_a_range' };
    }
    const parts = ipRangeStr.split('~');
    if (parts.length !== 2) {
        return { error: t('connections.form.errorInvalidIpRangeFormat', 'IP 范围格式应为 start_ip~end_ip') };
    }

    const [startIpStr, endIpStr] = parts.map(p => p.trim());

    const ipRegex = /^((\d{1,3}\.){3})\d{1,3}$/;
    if (!ipRegex.test(startIpStr) || !ipRegex.test(endIpStr)) {
        return { error: t('connections.form.errorInvalidIpFormat', '起始或结束 IP 地址格式无效') };
    }

    const startIpParts = startIpStr.split('.');
    const endIpParts = endIpStr.split('.');

    if (startIpParts.slice(0, 3).join('.') !== endIpParts.slice(0, 3).join('.')) {
        return { error: t('connections.form.errorIpRangeNotSameSubnet', 'IP 范围必须在同一个C段子网中 (例如 1.2.3.x ~ 1.2.3.y)') };
    }

    const startSuffix = parseInt(startIpParts[3], 10);
    const endSuffix = parseInt(endIpParts[3], 10);

    if (isNaN(startSuffix) || isNaN(endSuffix) || startSuffix < 0 || startSuffix > 255 || endSuffix < 0 || endSuffix > 255) {
        return { error: t('connections.form.errorInvalidIpSuffix', 'IP 地址最后一段必须是 0-255 之间的数字') };
    }

    if (startSuffix > endSuffix) {
        return { error: t('connections.form.errorIpRangeStartAfterEnd', 'IP 范围的起始 IP 不能大于结束 IP') };
    }

    const numIps = endSuffix - startSuffix + 1;
    if (numIps <= 0) {
         return { error: t('connections.form.errorIpRangeEmpty', 'IP 范围不能为空。') };
    }

    const baseIp = startIpParts.slice(0, 3).join('.');
    const ips: string[] = [];
    for (let i = startSuffix; i <= endSuffix; i++) {
        ips.push(`${baseIp}.${i}`);
    }
    return ips;
  };

  /**
   * 脚本模式的报错翻译：解析器只给错误码 + 参数，文案在这里落地。
   * 语言包里没有对应 key 时退回解析器自带的中文兜底。
   */
  const scriptErrorText = (
    code?: string,
    params?: Record<string, string | number>,
    fallback?: string
  ): string => {
    if (code) {
      const key = `connections.script.err.${code}`;
      if (te(key)) return t(key, params ?? {});
    }
    return fallback || t('errors.unknown', '未知错误');
  };

  // 脚本模式批量添加处理
  const handleScriptModeSubmit = async () => {
    const rawText = scriptInputText.value.trim();
    if (!rawText) {
      uiNotificationsStore.showError(t('connections.form.scriptModeEmpty', '脚本输入不能为空。'));
      return;
    }

    const { validConnections, rows } = parseScriptText(rawText);
    const errorRows = rows.filter((r) => !!r.errorCode);

    if (validConnections.length === 0) {
      if (errorRows.length > 0) {
        uiNotificationsStore.showError(
          t('connections.script.errorInLine', {
            line: errorRows[0].lineIndex,
            error: scriptErrorText(errorRows[0].errorCode, errorRows[0].errorParams, errorRows[0].error),
          })
        );
      } else {
        uiNotificationsStore.showError(t('connections.form.scriptModeEmpty', '没有找到可导入的有效主机配置。'));
      }
      return;
    }

    // 有格式错误的行：明确说清跳过几行、还剩多少能导
    if (errorRows.length > 0) {
      uiNotificationsStore.showWarning(
        t('connections.script.partialSkipped', {
          errors: errorRows.length,
          ok: validConnections.length,
          line: errorRows[0].lineIndex,
          error: scriptErrorText(errorRows[0].errorCode, errorRows[0].errorParams, errorRows[0].error),
        })
      );
    }

    uiNotificationsStore.showInfo(t('connections.form.scriptModeAddingConnections', { count: validConnections.length }));

    let successCount = 0;
    let errorCount = 0;
    let firstErrorEncountered: string | null = null;

    // 文件夹按名字懒建，且一次批量内只建一次
    const folderIdCache = new Map<string, number>();
    const resolveFolderId = async (name: string): Promise<number | null> => {
      const cached = folderIdCache.get(name);
      if (cached !== undefined) return cached;
      let found = folders.value.find((x) => x.name === name) || null;
      if (!found) {
        const created = await foldersStore.addFolder(name);
        if (created) {
          found = created;
          await foldersStore.fetchFolders();
        }
      }
      if (!found) return null;
      folderIdCache.set(name, found.id);
      return found.id;
    };

    const jumpIdByName = new Map<string, number>();
    for (const c of connections.value) jumpIdByName.set(c.name, c.id);

    for (const parsed of validConnections) {
      try {
        const connectionData: any = {
          type: parsed.type,
          name: parsed.name || `${parsed.username}@${parsed.host}`,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          notes: parsed.note || '',
          file_protocol: parsed.fileProtocol || 'auto',
        };

        if (parsed.backgroundColor) {
          connectionData.background_color = parsed.backgroundColor;
        }

        // 文件夹（脚本里 -folders 给了多个时都建上）
        if (parsed.folders && parsed.folders.length > 0) {
          const folderIds: number[] = [];
          for (const folderName of parsed.folders) {
            const id = await resolveFolderId(folderName);
            if (id) folderIds.push(id);
          }
          connectionData.folder_ids = folderIds;
        } else {
          connectionData.folder_ids = [];
        }

        // 网络代理（按名称）
        if (parsed.proxyName) {
          const foundProxy = proxies.value.find((p) => p.name === parsed.proxyName);
          if (foundProxy) {
            connectionData.proxy_id = foundProxy.id;
            connectionData.proxy_type = 'proxy';
          } else {
            errorCount++;
            if (!firstErrorEncountered) {
              firstErrorEncountered = t('connections.script.err.proxyNotFound', { name: parsed.proxyName });
            }
            continue;
          }
        }

        // 跳板机链（按连接名，仅 SSH）
        if (parsed.jumpNames && parsed.jumpNames.length > 0) {
          if (parsed.type !== 'SSH') {
            errorCount++;
            if (!firstErrorEncountered) {
              firstErrorEncountered = t('connections.script.err.jumpSshOnly', '跳板机链只支持 SSH 主机');
            }
            continue;
          }
          const jumpIds: number[] = [];
          let missing: string | null = null;
          for (const name of parsed.jumpNames) {
            const id = jumpIdByName.get(name);
            if (id === undefined) {
              missing = name;
              break;
            }
            jumpIds.push(id);
          }
          if (missing) {
            errorCount++;
            if (!firstErrorEncountered) {
              firstErrorEncountered = t('connections.script.err.jumpNotFound', { name: missing });
            }
            continue;
          }
          connectionData.proxy_type = 'jump';
          connectionData.jump_chain = jumpIds;
        }

        // 认证方式与密钥/密码
        if (parsed.type === 'SSH') {
          if (parsed.keyName) {
            const foundKey = sshKeys.value.find((k) => k.name === parsed.keyName);
            if (foundKey) {
              connectionData.auth_method = 'key';
              connectionData.ssh_key_id = foundKey.id;
            } else if (parsed.password) {
              // 找不到密钥但有密码：退回密码模式
              connectionData.auth_method = 'password';
              connectionData.password = parsed.password;
            } else {
              errorCount++;
              if (!firstErrorEncountered) {
                firstErrorEncountered = t('connections.script.err.keyNotFound', { name: parsed.keyName });
              }
              continue;
            }
          } else {
            connectionData.auth_method = 'password';
            connectionData.password = parsed.password || '';
          }
        } else {
          connectionData.password = parsed.password || '';
        }

        const success = await connectionsStore.addConnection(connectionData);
        if (success) {
          successCount++;
        } else {
          errorCount++;
          if (!firstErrorEncountered) {
            firstErrorEncountered = connectionsStore.error || t('errors.unknown', '未知错误');
          }
        }
      } catch (err: any) {
        errorCount++;
        if (!firstErrorEncountered) {
          firstErrorEncountered = err?.message || t('errors.unknown', '未知错误');
        }
      }
    }

    if (errorCount > 0 || errorRows.length > 0) {
      const message = t('connections.form.errorBatchAddResult', {
        successCount,
        errorCount: errorCount + errorRows.length,
        firstErrorEncountered:
          firstErrorEncountered ||
          scriptErrorText(errorRows[0]?.errorCode, errorRows[0]?.errorParams, errorRows[0]?.error) ||
          t('errors.unknown', '未知错误'),
      });
      if (successCount > 0) {
        uiNotificationsStore.showWarning(message);
      } else {
        uiNotificationsStore.showError(message);
      }
    }

    if (successCount > 0) {
      if (errorCount === 0 && errorRows.length === 0) {
        uiNotificationsStore.showSuccess(t('connections.form.successBatchAddResult', { successCount }));
      }
      emit('connection-added');
      if (errorCount === 0 && errorRows.length === 0) {
        scriptInputText.value = '';
      }
    }
    // 一条都没建成时保留输入，用户改完可以直接重试
  };

  // --- 内联新建 SSH 密钥（在「SSH 密钥」字段里就地粘贴私钥的那条路径，没有保存按钮） ---

  /** 留空时用的兜底密钥名：连接名 → 主机 → 用户名，后缀 `-key` */
  function resolveInlineKeyName(): string {
    const explicit = (formData.ssh_key_name || '').trim();
    if (explicit) return explicit;
    const base = (formData.name || '').trim()
      || (formData.host || '').trim()
      || (formData.username || '').trim()
      || 'ssh';
    return `${base}-key`;
  }

  /**
   * 提交前把内联表单里的私钥落库成一把正式密钥。
   * 成功后把 `selected_ssh_key_id` 指向它并清空明文 —— 这样后续（重试、批量循环）
   * 都走「已选密钥」的老路径，不会因为重试又建出第二把重复密钥。
   */
  async function persistInlineSshKey(): Promise<{ ok: boolean; id: number | null; name: string }> {
    if (!hasInlineSshKey.value) return { ok: true, id: null, name: '' };

    const name = resolveInlineKeyName();
    const created = await sshKeysStore.createSshKey({
      name,
      private_key: (formData.private_key || '').trim(),
      ...(formData.passphrase ? { passphrase: formData.passphrase } : {}),
    });

    if (!created) {
      uiNotificationsStore.showError(
        t('connections.form.inlineKeySaveFailed', { error: sshKeysStore.error || t('errors.unknown', '未知错误') })
      );
      return { ok: false, id: null, name };
    }

    formData.selected_ssh_key_id = created.id;
    formData.private_key = '';
    formData.passphrase = '';
    formData.ssh_key_name = '';
    return { ok: true, id: created.id, name: created.name };
  }

  /** 连接一个都没建成时回收刚自动创建的密钥，别在密钥库里留孤儿 */
  async function rollbackInlineSshKey(keyId: number | null) {
    if (!keyId) return;
    await sshKeysStore.deleteSshKey(keyId);
    if (formData.selected_ssh_key_id === keyId) formData.selected_ssh_key_id = null;
  }

  /**
   * 提交入口：只负责维护「提交态」这一件事。
   * 真正的校验/请求拆到 submitConnection()，这样任何一条 early return（校验不通过）
   * 都能靠 finally 把按钮恢复原样，不会卡在「正在添加…」。
   */
  const handleSubmit = async () => {
    if (isSubmitting.value) return; // 防连点（也防脚本模式重入）
    isSubmitting.value = true;
    try {
      await submitConnection();
    } finally {
      isSubmitting.value = false;
    }
  };

  async function submitConnection() {
    if (isScriptModeActive.value) {
      await handleScriptModeSubmit();
      return;
    }

    formError.value = null;
    connectionsStore.error = null;
    proxiesStore.error = null;

    const availableFolderIds = folders.value.map(t_ => t_.id);
    const currentSelectedValidFolderIds = formData.folder_ids.filter(id => availableFolderIds.includes(id));

    if (!formData.host || !formData.host.trim()) {
      uiNotificationsStore.showError(t('connections.form.errorRequiredFields'));
      return;
    }
    const effectiveUsername = formData.username?.trim() || 'root';
    if (formData.port <= 0 || formData.port > 65535) {
        uiNotificationsStore.showError(t('connections.form.errorPort'));
        return;
    }

    if (formData.type === 'SSH') {
        if (!isEditMode.value) {
            if (formData.auth_method === 'password' && !formData.password && !formData.host.includes('~')) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequired'));
                return;
            }
            if (formData.auth_method === 'key' && !formData.selected_ssh_key_id && !hasInlineSshKey.value && !formData.host.includes('~')) {
                uiNotificationsStore.showError(t('connections.form.errorSshKeyRequired'));
                return;
            }
        } else {
            if (formData.auth_method === 'password' && !formData.password && connectionToEdit.value?.auth_method !== 'password') {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredOnSwitch'));
                return;
            }
            if (formData.auth_method === 'key' && !formData.selected_ssh_key_id && !hasInlineSshKey.value && connectionToEdit.value?.auth_method !== 'key') {
                 uiNotificationsStore.showError(t('connections.form.errorSshKeyRequiredOnSwitch'));
                 return;
             }
        }
    } else if (formData.type === 'RDP') {
        if (!isEditMode.value && !formData.password && !formData.host.includes('~')) {
            uiNotificationsStore.showError(t('connections.form.errorPasswordRequired'));
            return;
        }
    } else if (formData.type === 'VNC') {
        if (!isEditMode.value && !formData.vncPassword && !formData.host.includes('~')) {
            uiNotificationsStore.showError(t('connections.form.errorVncPasswordRequired', 'VNC 密码是必填项。'));
            return;
        }
    }

    if (!isEditMode.value && formData.host.includes('~')) {
        const parsedIpsResult = parseIpRange(formData.host);

        if (Array.isArray(parsedIpsResult)) {
            const ips = parsedIpsResult;
            if (formData.type === 'SSH' && formData.auth_method === 'key' && !formData.selected_ssh_key_id && !hasInlineSshKey.value) {
                uiNotificationsStore.showError(t('connections.form.errorSshKeyRequiredForBatch', '批量添加 SSH (密钥认证) 主机时，必须选择一个 SSH 密钥。'));
                return;
            }
            if (formData.type === 'SSH' && formData.auth_method === 'password' && !formData.password) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredForBatchSSH', '批量添加 SSH (密码认证) 主机时，必须提供密码。'));
                return;
            }
            if (formData.type === 'RDP' && !formData.password) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredForBatchRDP', '批量添加 RDP 主机时，必须提供密码。'));
                return;
            }
            if (formData.type === 'VNC' && !formData.vncPassword) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredForBatchVNC', '批量添加 VNC 主机时，必须提供 VNC 密码。'));
                return;
            }

            let successCount = 0;
            let errorCount = 0;
            let firstErrorEncountered: string | null = null;

            // 内联粘贴的私钥先落库（整批共用同一把），失败就直接终止
            const inlineKey = await persistInlineSshKey();
            if (!inlineKey.ok) return;

            for (let i = 0; i < ips.length; i++) {
                const currentIp = ips[i];
                const ipSuffix = currentIp.split('.').pop() || `${i + 1}`;
                
                const dataForThisIp: any = {
                    type: formData.type,
                    name: formData.name ? `${formData.name}-${ipSuffix}` : currentIp,
                    host: currentIp,
                    port: formData.port,
                    username: effectiveUsername,
                    notes: formData.notes,
                    proxy_id: formData.proxy_id || null,
                    folder_ids: currentSelectedValidFolderIds,
                    proxy_type: formData.proxy_type,
                    background_color: formData.custom_background_color ? (formData.background_color || null) : null,
                    file_protocol: formData.file_protocol || 'auto',
                    ...(formData.type === 'SSH' ? {
                        startup_command: (formData.startup_command || '').trim(),
                        sftp_sudo_enabled: formData.sftp_sudo_enabled,
                        session_hosting_mode: formData.session_hosting_mode || 'auto',
                        ...(formData.sudo_password ? { sudo_password: formData.sudo_password } : {}),
                    } : {}),
                };

                if (formData.type === 'SSH') {
                    dataForThisIp.auth_method = formData.auth_method;
                    if (formData.auth_method === 'password') {
                        dataForThisIp.password = formData.password;
                    } else if (formData.auth_method === 'key') {
                        dataForThisIp.ssh_key_id = formData.selected_ssh_key_id;
                    }
                } else if (formData.type === 'RDP') {
                    dataForThisIp.password = formData.password;
                    delete dataForThisIp.auth_method;
                } else if (formData.type === 'VNC') {
                    dataForThisIp.password = formData.vncPassword;
                    delete dataForThisIp.auth_method;
                }
                
                if (dataForThisIp.type !== 'SSH' || dataForThisIp.auth_method !== 'key') delete dataForThisIp.ssh_key_id;
                if (dataForThisIp.type === 'SSH' && dataForThisIp.auth_method === 'key') delete dataForThisIp.password;
                if (dataForThisIp.type !== 'SSH') delete dataForThisIp.auth_method;

                const success = await connectionsStore.addConnection(dataForThisIp);
                if (success) {
                    successCount++;
                } else {
                    errorCount++;
                    if (!firstErrorEncountered) {
                        firstErrorEncountered = connectionsStore.error || t('errors.unknown', '未知错误');
                    }
                }
            }

            // 内联密钥收尾：一个都没建成 → 回收；有建成的 → 提醒一句已自动保存
            if (successCount === 0) {
                await rollbackInlineSshKey(inlineKey.id);
            } else if (inlineKey.id) {
                uiNotificationsStore.showSuccess(
                    t('connections.form.inlineKeySaved', { name: inlineKey.name })
                );
            }

            if (errorCount > 0) {
                const message = t('connections.form.errorBatchAddResult', { successCount, errorCount, firstErrorEncountered: firstErrorEncountered || t('errors.unknown', '未知错误') });
                if (successCount > 0) {
                  uiNotificationsStore.showWarning(message);
                } else {
                  uiNotificationsStore.showError(message);
                }
            } else if (successCount > 0) {
                uiNotificationsStore.showSuccess(t('connections.form.successBatchAddResult', { successCount }));
                emit('connection-added');
            }
            return;
        } else if (parsedIpsResult.error && parsedIpsResult.error !== 'not_a_range') {
            uiNotificationsStore.showError(parsedIpsResult.error);
            return;
        }
    }
    
    if (isEditMode.value && formData.host.includes('~')) {
        uiNotificationsStore.showError(t('connections.form.errorIpRangeNotAllowedInEditMode', '编辑模式下不支持 IP 范围。请使用单个 IP 地址。'));
        return;
    }

    // 内联粘贴的私钥先落库，拿到 id 再建/改连接
    const inlineKey = await persistInlineSshKey();
    if (!inlineKey.ok) return;

    const dataToSend: any = {
        type: formData.type,
        name: formData.name,
        host: formData.host.trim(),
        port: formData.port,
        notes: formData.notes,
        username: effectiveUsername,
        proxy_id: formData.proxy_id || null,
        proxy_type: formData.proxy_type,
        folder_ids: currentSelectedValidFolderIds,
        jump_chain: formData.jump_chain ? JSON.parse(JSON.stringify(formData.jump_chain)) : null,
        background_color: formData.custom_background_color ? (formData.background_color || null) : null,
        file_protocol: formData.file_protocol || 'auto',
        // 启动命令与 SFTP sudo 提权只对 SSH 有意义。
        // sudo 密码只在用户填了才上行 —— 留空表示"不改"，这样编辑连接时不必重输密码。
        ...(formData.type === 'SSH' ? {
            startup_command: (formData.startup_command || '').trim(),
            sftp_sudo_enabled: formData.sftp_sudo_enabled,
            session_hosting_mode: formData.session_hosting_mode || 'auto',
            ...(formData.sudo_password ? { sudo_password: formData.sudo_password } : {}),
        } : {}),
    };

    if (formData.type === 'SSH') {
        dataToSend.auth_method = formData.auth_method;
        if (formData.auth_method === 'password') {
            if (formData.password) dataToSend.password = formData.password;
        } else if (formData.auth_method === 'key') {
            if (formData.selected_ssh_key_id) {
                dataToSend.ssh_key_id = formData.selected_ssh_key_id;
            }
        }
    } else if (formData.type === 'RDP') {
        if (formData.password) dataToSend.password = formData.password;
        delete dataToSend.auth_method;
    } else if (formData.type === 'VNC') {
        if (formData.vncPassword) dataToSend.password = formData.vncPassword;
        delete dataToSend.auth_method;
    }
    
    if (dataToSend.type !== 'SSH' || dataToSend.auth_method !== 'key') delete dataToSend.ssh_key_id;
    if (dataToSend.type === 'SSH' && dataToSend.auth_method === 'key') delete dataToSend.password;
    if (dataToSend.type !== 'SSH') delete dataToSend.auth_method;

    let success = false;
    if (isEditMode.value && connectionToEdit.value) {
        success = await connectionsStore.updateConnection(connectionToEdit.value.id, dataToSend);
        if (success) {
            emit('connection-updated');
        } else {
            uiNotificationsStore.showError(t('connections.form.errorUpdate', { error: connectionsStore.error || '未知错误' }));
        }
    } else {
        success = await connectionsStore.addConnection(dataToSend);
        if (success) {
            emit('connection-added');
        } else {
            uiNotificationsStore.showError(t('connections.form.errorAdd', { error: connectionsStore.error || '未知错误' }));
        }
    }

    // 内联密钥收尾：建成 → 提醒一句已自动保存；没建成 → 把它删掉，别留孤儿
    if (success) {
        if (inlineKey.id) {
            uiNotificationsStore.showSuccess(
                t('connections.form.inlineKeySaved', { name: inlineKey.name })
            );
        }
    } else {
        await rollbackInlineSshKey(inlineKey.id);
    }
  }

  // 处理删除连接
  const handleDeleteConnection = async () => {
    if (!isEditMode.value || !connectionToEdit.value) return;

    const connectionName = connectionToEdit.value.name || `ID: ${connectionToEdit.value.id}`;
    const confirmedDeleteConnection = await showConfirmDialog({
      message: t('connections.prompts.confirmDelete', { name: connectionName })
    });
    if (!confirmedDeleteConnection) {
        return;
    }

    formError.value = null;
    connectionsStore.error = null;

    const success = await connectionsStore.deleteConnection(connectionToEdit.value.id);
    if (success) {
      emit('connection-deleted');
      emit('close');
    } else {
      uiNotificationsStore.showError(t('connections.form.errorDelete', { error: connectionsStore.error || t('errors.unknown', '未知错误') }));
    }
  };

  // --- Folder Creation/Deletion Handling ---
  const handleCreateFolder = async (folderName: string) => {
      if (!folderName || folderName.trim().length === 0) return;
      const newFolder = await foldersStore.addFolder(folderName.trim());
      if (newFolder) {
          formData.folder_ids = [newFolder.id];
      }
  };

  const handleDeleteFolder = async (folderId: number) => {
      const folderToDelete = folders.value.find(t_ => t_.id === folderId);
      if (!folderToDelete) return;

      const confirmedDeleteFolder = await showConfirmDialog({
        message: t('folders.prompts.confirmDelete', { name: folderToDelete.name })
      });
      if (confirmedDeleteFolder) {
          const success = await foldersStore.deleteFolder(folderId);
          if (!success) {
              showAlertDialog({ title: t('common.error', '错误'), message: t('folders.errorDelete', { error: foldersStore.error || '未知错误' }) });
          }
      }
  };

  // 处理测试连接
  const handleTestConnection = async () => {
    testStatus.value = 'testing';
    testResult.value = null;
    testLatency.value = null;

    try {
      let response;
      if (isEditMode.value && connectionToEdit.value) {
        response = await apiClient.post(`/connections/${connectionToEdit.value.id}/test`);
      } else {
        const effectiveUsername = formData.username?.trim() || 'root';
        const dataToSend = {
            host: formData.host,
            port: formData.port,
            username: effectiveUsername,
            auth_method: formData.auth_method,
            password: formData.auth_method === 'password' ? formData.password : undefined,
            proxy_id: formData.proxy_id || null,
            ssh_key_id: formData.auth_method === 'key' ? formData.selected_ssh_key_id : undefined,
            // 内联刚粘贴、还没落库的私钥直接送去测（后端 test-unsaved 支持 private_key）
            private_key: formData.auth_method === 'key' && hasInlineSshKey.value
                ? (formData.private_key || '').trim()
                : undefined,
            passphrase: formData.auth_method === 'key' && hasInlineSshKey.value
                ? (formData.passphrase || undefined)
                : undefined,
        };

        if (!dataToSend.host || !dataToSend.port || !dataToSend.auth_method) {
          throw new Error(t('connections.test.errorMissingFields'));
        }
        if (dataToSend.auth_method === 'password' && !formData.password) {
           throw new Error(t('connections.form.errorPasswordRequired'));
       }
       if (dataToSend.auth_method === 'key' && !dataToSend.ssh_key_id && !dataToSend.private_key) {
          throw new Error(t('connections.form.errorSshKeyRequired'));
       }
        response = await apiClient.post('/connections/test-unsaved', dataToSend);
      }

      if (response.data.success) {
        testStatus.value = 'success';
        testLatency.value = response.data.latency;
        testResult.value = `${response.data.latency} ms`;
      } else {
        testStatus.value = 'error';
        const errorMessage = response.data.message || t('connections.test.errorUnknown');
        testResult.value = errorMessage;
        uiNotificationsStore.showError(errorMessage);
      }

    } catch (error: any) {
      console.error('测试连接失败:', error);
      testStatus.value = 'error';
      let errorMessageToShow: string;
      if (error.response && error.response.data && error.response.data.message) {
        errorMessageToShow = error.response.data.message;
      } else {
        errorMessageToShow = error.message || t('connections.test.errorNetwork');
      }
      testResult.value = errorMessageToShow;
      uiNotificationsStore.showError(errorMessageToShow);
    }
  };

  // 计算延迟颜色
  const latencyColor = computed(() => {
    if (testStatus.value !== 'success' || testLatency.value === null) {
      return 'inherit';
    }
    const latency = testLatency.value;
    if (latency < 100) return 'var(--color-success, #28a745)';
    if (latency < 500) return 'var(--color-warning, #ffc107)';
    return 'var(--color-danger, #dc3545)';
  });

  // 计算测试按钮文本
  const testButtonText = computed(() => {
      if (testStatus.value === 'testing') {
          return t('connections.form.testing');
      }
      return t('connections.form.testConnection');
  });

  // --- Jump Host Chain Management ---
  const addJumpHost = () => {
    if (formData.jump_chain === null || formData.jump_chain === undefined) {
      formData.jump_chain = [];
    }
    formData.jump_chain.push(null);
  };

  const removeJumpHost = (index: number) => {
    if (formData.jump_chain && index >= 0 && index < formData.jump_chain.length) {
      formData.jump_chain.splice(index, 1);
    }
  };

  return {
    formData,
    isLoading,
    /** 表单提交态：按钮的禁用 / 转圈 / 文案只看它 */
    isSubmitting,
    testStatus,
    testResult,
    testLatency,
    isScriptModeActive,
    scriptInputText,
    isEditMode,
    formTitle,
    submitButtonText,
    proxies, // for <select>
    folders,    // for <FolderInput :available-folders="folders">
    isProxyLoading,
    proxyStoreError,
    isFolderLoading,
    folderStoreError,
    handleSubmit,
    handleDeleteConnection,
    handleTestConnection,
    handleCreateFolder,
    handleDeleteFolder,
    latencyColor,
    testButtonText,
    advancedConnectionMode, 
    addJumpHost,         
    removeJumpHost,         
    connections,
  };
}