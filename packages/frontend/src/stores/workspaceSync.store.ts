import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, nextTick, shallowRef, watch } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import apiClient from '../utils/apiClient';
import { useSessionStore } from './session.store';
import { useFileEditorStore, type FileTab } from './fileEditor.store';
import { useConnectionsStore } from './connections.store';
import { useUiNotificationsStore } from './uiNotifications.store';
import { useTerminalHighlightStore } from './terminal-highlight.store';
import { workspaceEmitter } from '../composables/workspaceEvents';

const SYNC_ENABLED_STORAGE_KEY = 'nexus_workspace_sync_enabled';
const CLIENT_ID_SESSION_KEY = 'nexus_workspace_sync_client_id';

// 统一的高可视度控制台诊断日志
const logSync = (message: string, ...args: any[]) => {
  console.log(`%c[WorkspaceSync] ${message}`, 'color: #10b981; font-weight: bold;', ...args);
};
const logSyncWarn = (message: string, ...args: any[]) => {
  console.warn(`%c[WorkspaceSync] ${message}`, 'color: #f59e0b; font-weight: bold;', ...args);
};
const logSyncError = (message: string, ...args: any[]) => {
  console.error(`%c[WorkspaceSync] ${message}`, 'color: #ef4444; font-weight: bold;', ...args);
};

/**
 * 清理快照终端文本末尾悬空的 Shell 提示符行（用于新建立 SSH 连接时，防止旧 Prompt 与新 Shell 登录 Prompt 重复叠加）
 */
const cleanTrailingPromptForReconnect = (text: string): string => {
  if (!text) return '';
  const normalized = text.replace(/\r?\n/g, '\r\n');
  const lines = normalized.split('\r\n');
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    // 剥离 ANSI 转义序列后判断是否为悬空的 shell 提示符（例如 root@localhost:~# 或 user@host:~$ ）
    const plainLastLine = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
    if (plainLastLine && /[#$%>]\s*$/.test(plainLastLine)) {
      lines.pop(); // 裁剪掉末尾尚未执行命令的旧提示符行，留给新连接的远程 Shell 真实输出
      return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
    }
  }
  return normalized;
};

export interface SyncedSessionInfo {
  sessionId: string;
  connectionId: number | string;
  connectionName: string;
  commandInputContent?: string;
  suspendSessionId?: string;
  terminalBuffer?: string;
  editorTabs?: SyncedFileTabInfo[]; // 每个会话自己独立的编辑器标签页 (当 shareFileEditorTabs=false 时)
  activeEditorTabId?: string | null;
}

export interface SyncedFileTabInfo {
  id: string;
  sessionId: string;
  filePath: string;
  filename: string;
  content: string;
  rawContentBase64?: string | null;
  isModified: boolean;
  language: string;
  selectedEncoding: string;
  scrollTop?: number;
  scrollLeft?: number;
}

export interface SyncedFileManagerInfo {
  currentPath: string;
  isSearchActive: boolean;
  searchQuery: string;
  scrollTop?: number;
  scrollRatio?: number;
}

export interface SyncedFileManagerInstanceState {
  instanceId: string;
  sessionId: string;
  currentPath: string;
  isSearchActive: boolean;
  searchQuery: string;
  scrollTop?: number;
  scrollRatio?: number;
}

export interface SyncedMultiLineCommandInfo {
  currentContent: string;
  sessionDrafts: Record<string, string>;
}

export interface WorkspaceSnapshot {
  syncEnabled: boolean;
  activeSessionId: string | null;
  sessions: SyncedSessionInfo[];
  sessionOrder?: string[]; // 会话标签栏排布顺序
  fileEditor: {
    isOpen?: boolean; // 弹窗编辑器是否处于打开状态
    activeTabId: string | null;
    tabs: SyncedFileTabInfo[];
  };
  fileManager: SyncedFileManagerInfo; // 兼容单实例旧快照
  fileManagers?: Record<string, SyncedFileManagerInstanceState>; // 精准适配多实例 (key: `${sessionId}:${instanceId}`)
  multiLineCommandInput: SyncedMultiLineCommandInfo;
  updatedAt: number;
}

export const useWorkspaceSyncStore = defineStore('workspaceSync', () => {
  const sessionStore = useSessionStore();

  // 1. 同步开关：默认开启 (true)
  const syncEnabled = ref<boolean>(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) !== 'false'
      : true
  );

  // 2. 客户端唯一标识 (基于 sessionStorage，保证单标签页刷新保持、多标签/跨设备互斥)
  const getOrCreateClientId = (): string => {
    if (typeof sessionStorage !== 'undefined') {
      let cid = sessionStorage.getItem(CLIENT_ID_SESSION_KEY);
      if (!cid) {
        cid = `client_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
        sessionStorage.setItem(CLIENT_ID_SESSION_KEY, cid);
      }
      return cid;
    }
    return `client_${Date.now()}`;
  };

  const clientId = ref<string>(getOrCreateClientId());

  // 3. 被接管与遮罩状态
  const isTakenOver = ref<boolean>(false);
  const takeoverByClientId = ref<string | null>(null);

  // 4. 正在同步或恢复标记 (防止死循环与覆盖)
  const isSyncing = ref<boolean>(false);
  const isRestoring = ref<boolean>(false);
  const lastSyncTime = ref<number | null>(null);

  // 5. 文件管理器当前状态缓存（全局兼容层）
  const fileManagerState = ref<SyncedFileManagerInfo>({
    currentPath: '',
    isSearchActive: false,
    searchQuery: '',
    scrollTop: 0,
  });

  // 5.1 多实例文件管理器状态映射 (key: `${sessionId}:${instanceId}`)
  const fileManagerInstances = ref<Record<string, SyncedFileManagerInstanceState>>({});

  // 6. 多行命令输入框状态缓存
  const multiLineCommandState = ref<SyncedMultiLineCommandInfo>({
    currentContent: '',
    sessionDrafts: {},
  });

  // 7. 会话映射表 (旧 sessionId -> 新 sessionId)
  const activeSessionIdMap = ref<Map<string, string>>(new Map());

  const getOriginalSessionId = (currentSessionId: string): string | null => {
    for (const [origId, newId] of activeSessionIdMap.value.entries()) {
      if (newId === currentSessionId) return origId;
    }
    return null;
  };

  // 获取特定会话与实例的文件管理器保存状态
  const getSavedFileManagerInstanceState = (sessionId: string, instanceId: string): SyncedFileManagerInstanceState | null => {
    const key = `${sessionId}:${instanceId}`;
    if (fileManagerInstances.value[key]) {
      return fileManagerInstances.value[key];
    }
    // 尝试通过 session 映射反查原始会话 ID
    const origSessionId = getOriginalSessionId(sessionId);
    if (origSessionId) {
      const origKey = `${origSessionId}:${instanceId}`;
      if (fileManagerInstances.value[origKey]) {
        return fileManagerInstances.value[origKey];
      }
    }
    // 回退到同会话任意实例或全局默认
    for (const [k, v] of Object.entries(fileManagerInstances.value)) {
      if (k.startsWith(`${sessionId}:`) || (origSessionId && k.startsWith(`${origSessionId}:`))) return v;
    }
    return null;
  };

  // 辅助函数：判断文件管理器路径是否为有效同步路径（必须为绝对路径，杜绝相对路径如 . 或 ./.gemini）
  const isValidFileManagerSyncPath = (p?: string | null): boolean => {
    if (!p) return false;
    const s = p.trim();
    return s.startsWith('/') && s !== '';
  };

  // 获取特定会话与实例的有效保存路径（仅对有快照保存记录的会话有效，新会话严格返回 null）
  const getSavedFileManagerPath = (sessionId: string, instanceId: string): string | null => {
    const inst = getSavedFileManagerInstanceState(sessionId, instanceId);
    if (inst?.currentPath && isValidFileManagerSyncPath(inst.currentPath)) {
      return inst.currentPath;
    }
    // 严禁回退到全局 fileManagerState.value.currentPath，避免用户新创建的独立会话被错误继承旧会话的路径
    return null;
  };

  // 更新特定文件管理器实例的状态
  const updateFileManagerInstanceState = (
    sessionId: string,
    instanceId: string,
    partial: Partial<SyncedFileManagerInstanceState>
  ) => {
    const key = `${sessionId}:${instanceId}`;
    const current = fileManagerInstances.value[key] || {
      instanceId,
      sessionId,
      currentPath: '',
      isSearchActive: false,
      searchQuery: '',
      scrollTop: 0,
      scrollRatio: 0,
    };
    fileManagerInstances.value[key] = { ...current, ...partial };

    // 跨端双向映射同步保障：
    // 当移动端模态框 (fm-modal-) 或任意实例更新路径/滚动时，同步对齐该会话下的所有关联实例
    const origSessionId = getOriginalSessionId(sessionId);
    for (const [k, inst] of Object.entries(fileManagerInstances.value)) {
      if (k !== key && (k.startsWith(`${sessionId}:`) || (origSessionId && k.startsWith(`${origSessionId}:`)))) {
        fileManagerInstances.value[k] = {
          ...inst,
          ...(partial.currentPath ? { currentPath: partial.currentPath } : {}),
          ...(partial.scrollTop !== undefined ? { scrollTop: partial.scrollTop } : {}),
          ...(partial.scrollRatio !== undefined ? { scrollRatio: partial.scrollRatio } : {}),
        };
      }
    }

    // 如果是当前活动会话的实例，同步更新单实例兼容层
    const sessionStore = useSessionStore();
    if (sessionStore.activeSessionId === sessionId) {
      fileManagerState.value = {
        currentPath: fileManagerInstances.value[key].currentPath,
        isSearchActive: fileManagerInstances.value[key].isSearchActive,
        searchQuery: fileManagerInstances.value[key].searchQuery,
        scrollTop: fileManagerInstances.value[key].scrollTop,
        scrollRatio: fileManagerInstances.value[key].scrollRatio,
      };
    }

    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 更新文件管理器状态 (兼容单实例调用)
  const updateFileManagerState = (partial: Partial<SyncedFileManagerInfo>) => {
    fileManagerState.value = { ...fileManagerState.value, ...partial };
    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 更新多行命令状态
  const updateMultiLineCommandState = (partial: Partial<SyncedMultiLineCommandInfo>) => {
    multiLineCommandState.value = { ...multiLineCommandState.value, ...partial };
    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 切换同步开关
  const toggleSyncEnabled = async () => {
    syncEnabled.value = !syncEnabled.value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SYNC_ENABLED_STORAGE_KEY, String(syncEnabled.value));
    }
    if (syncEnabled.value) {
      logSync('用户开启工作区实时云端同步');
      // 开启时立即声明接管并保存一次当前工作区
      await claimTakeover();
      triggerDebouncedSave(0);
    } else {
      logSync('用户关闭工作区实时云端同步');
    }
  };

  // 收集当前整个工作区完整快照
  const collectCurrentWorkspaceState = (): WorkspaceSnapshot => {
    const sessionStore = useSessionStore();
    const fileEditorStore = useFileEditorStore();

    // 1. 收集会话信息（严格按照当前标签栏真实的排布顺序收集！）
    const orderedTabs = sessionStore.sessionTabsWithStatus || [];
    const orderedSessionIds = orderedTabs.map(t => t.sessionId);
    const allSessionIds = Array.from(sessionStore.sessions.keys());
    const sortedSessionIds = [
      ...orderedSessionIds.filter(id => allSessionIds.includes(id)),
      ...allSessionIds.filter(id => !orderedSessionIds.includes(id)),
    ];

    const sessionsList: SyncedSessionInfo[] = [];
    sortedSessionIds.forEach((sId) => {
      const s = sessionStore.sessions.get(sId);
      if (!s) return;
      // 提取终端屏幕缓冲区 (优先使用官方 SerializeAddon 提取带完整 ANSI 转义序列、RGB真色彩与格式的数据)
      let terminalBuffer = '';
      if (s.terminalManager && typeof (s.terminalManager as any).serializeTerminal === 'function') {
        const serialized = (s.terminalManager as any).serializeTerminal();
        if (typeof serialized === 'string') {
          terminalBuffer = serialized;
        }
      }

      // 若 SerializeAddon 未激活或未输出，降级使用文本缓冲区提取算法保底
      if (!terminalBuffer && s.terminalManager?.terminalInstance?.value) {
        const term = s.terminalManager.terminalInstance.value;
        const buffer = term.buffer.active;
        let lastNonEmptyLineIndex = -1;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const line = buffer.getLine(i);
          if (line && line.translateToString(true).trim() !== '') {
            lastNonEmptyLineIndex = i;
            break;
          }
        }
        if (lastNonEmptyLineIndex !== -1) {
          let result = '';
          for (let i = 0; i <= lastNonEmptyLineIndex; i++) {
            const line = buffer.getLine(i);
            if (!line) continue;
            const nextLine = i < lastNonEmptyLineIndex ? buffer.getLine(i + 1) : null;
            const isNextWrapped = nextLine ? nextLine.isWrapped : false;
            if (isNextWrapped) {
              result += line.translateToString(false);
            } else {
              result += line.translateToString(true);
              if (i < lastNonEmptyLineIndex) {
                result += '\r\n';
              }
            }
          }
          terminalBuffer = result;
        }
      }

      // 提取会话自身独立的编辑器标签页 (当 shareFileEditorTabs=false 时)
      let sessionSpecificTabs: SyncedFileTabInfo[] | undefined = undefined;
      if (s.editorTabs?.value && Array.isArray(s.editorTabs.value) && s.editorTabs.value.length > 0) {
        sessionSpecificTabs = s.editorTabs.value.map(tab => ({
          id: tab.id,
          sessionId: tab.sessionId || sId,
          filePath: tab.filePath,
          filename: tab.filename,
          content: tab.content,
          rawContentBase64: tab.rawContentBase64 || null,
          isModified: tab.isModified,
          language: tab.language,
          selectedEncoding: tab.selectedEncoding,
          scrollTop: tab.scrollTop || 0,
          scrollLeft: tab.scrollLeft || 0,
        }));
      }

      sessionsList.push({
        sessionId: sId,
        connectionId: s.connectionId,
        connectionName: s.connectionName,
        commandInputContent: s.commandInputContent.value || '',
        suspendSessionId: (s as any).suspendSessionId,
        terminalBuffer: terminalBuffer !== undefined ? terminalBuffer : '',
        editorTabs: sessionSpecificTabs,
        activeEditorTabId: s.activeEditorTabId?.value || null,
      });
    });

    // 2. 收集全局编辑器标签（共享模式及全局数据池）
    const editorTabsList: SyncedFileTabInfo[] = fileEditorStore.orderedTabs.map(tab => ({
      id: tab.id,
      sessionId: tab.sessionId,
      filePath: tab.filePath,
      filename: tab.filename,
      content: tab.content,
      rawContentBase64: tab.rawContentBase64 || null,
      isModified: tab.isModified,
      language: tab.language,
      selectedEncoding: tab.selectedEncoding,
      scrollTop: tab.scrollTop || 0,
      scrollLeft: tab.scrollLeft || 0,
    }));

    // 3. 收集所有会话的所有文件管理器实例
    const allFileManagers: Record<string, SyncedFileManagerInstanceState> = {};
    sessionStore.sessions.forEach((s, sId) => {
      if (s.sftpManagers) {
        s.sftpManagers.forEach((mgr, instId) => {
          const key = `${sId}:${instId}`;
          const cached = fileManagerInstances.value[key] || {};
          const realPath = (mgr.currentPath?.value && isValidFileManagerSyncPath(mgr.currentPath.value))
            ? mgr.currentPath.value
            : (cached.currentPath && isValidFileManagerSyncPath(cached.currentPath) ? cached.currentPath : '');
          allFileManagers[key] = {
            sessionId: sId,
            instanceId: instId,
            currentPath: realPath,
            isSearchActive: cached.isSearchActive || false,
            searchQuery: cached.searchQuery || '',
            scrollTop: cached.scrollTop || 0,
            scrollRatio: typeof cached.scrollRatio === 'number' ? cached.scrollRatio : 0,
          };
        });
      }
    });

    // 确定主文件管理器兼容路径
    let realFmPath = fileManagerState.value.currentPath;
    const currentActiveSession = sessionStore.activeSessionId ? sessionStore.sessions.get(sessionStore.activeSessionId) : null;
    if (currentActiveSession?.sftpManagers) {
      for (const mgr of currentActiveSession.sftpManagers.values()) {
        const p = mgr.currentPath?.value;
        if (p && isValidFileManagerSyncPath(p)) {
          realFmPath = p;
          break;
        }
      }
    }

    return {
      syncEnabled: syncEnabled.value,
      activeSessionId: sessionStore.activeSessionId,
      sessions: sessionsList,
      sessionOrder: sortedSessionIds,
      fileEditor: {
        isOpen: fileEditorStore.isPopupOpen,
        activeTabId: fileEditorStore.activeTabId,
        tabs: editorTabsList,
      },
      fileManager: {
        ...fileManagerState.value,
        currentPath: realFmPath,
      },
      fileManagers: allFileManagers,
      multiLineCommandInput: { ...multiLineCommandState.value },
      updatedAt: Math.floor(Date.now() / 1000),
    };
  };

  // 防抖计时器
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerDebouncedSave = (delayMs: number = 800) => {
    if (!syncEnabled.value || isRestoring.value || isTakenOver.value) return;

    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(async () => {
      await saveWorkspaceToCloud();
    }, delayMs);
  };

  // 保存工作区到云端
  const saveWorkspaceToCloud = async (): Promise<boolean> => {
    if (!syncEnabled.value || isRestoring.value || isTakenOver.value) return false;
    try {
      isSyncing.value = true;
      const snapshot = collectCurrentWorkspaceState();
      logSync('正在将工作区快照保存至云端...', {
        sessionsCount: snapshot.sessions.length,
        tabsCount: snapshot.fileEditor.tabs.length,
        tabs: snapshot.fileEditor.tabs.map(t => `${t.filename}(${t.selectedEncoding})`),
        fileManagerPath: snapshot.fileManager.currentPath,
      });

      const res = await apiClient.post('/workspace-sync/save', {
        clientId: clientId.value,
        state: snapshot,
      });
      if (res.data?.success) {
        lastSyncTime.value = Date.now();
        logSync('工作区快照已成功持久化至云端数据库！时间:', new Date().toLocaleTimeString());
        return true;
      }
      return false;
    } catch (err: any) {
      logSyncWarn('保存工作区到云端失败:', err.message);
      return false;
    } finally {
      isSyncing.value = false;
    }
  };

  // 声明接管 (Claim Lease)
  const claimTakeover = async (): Promise<boolean> => {
    try {
      logSync(`当前客户端 (${clientId.value}) 正在声明工作区接管权...`);
      const res = await apiClient.post('/workspace-sync/claim', {
        clientId: clientId.value,
      });
      if (res.data?.success) {
        isTakenOver.value = false;
        takeoverByClientId.value = null;
        logSync(`接管权声明成功！当前客户端独占工作区操作。`);
        return true;
      }
      return false;
    } catch (err: any) {
      logSyncError('声明接管租约失败:', err);
      return false;
    }
  };

  // 处理被其它客户端接管的踢出通知
  const handleTakeoverKickout = (targetActiveClientId: string) => {
    if (targetActiveClientId && targetActiveClientId !== clientId.value) {
      logSyncWarn(`工作区已被新客户端 (${targetActiveClientId}) 接管，当前客户端进入全局遮罩模式`);
      isTakenOver.value = true;
      takeoverByClientId.value = targetActiveClientId;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    }
  };

  // 等待会话 SFTP 状态就绪的辅助方法
  const waitForSessionSftpReady = (session: any, timeoutMs: number = 8000): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!session || !session.wsManager) {
        return resolve(false);
      }
      if (session.wsManager.isSftpReady?.value) {
        return resolve(true);
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopWatch: (() => void) | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (stopWatch) stopWatch();
      };

      timer = setTimeout(() => {
        cleanup();
        logSyncWarn(`等待会话 ${session.sessionId} SFTP 就绪超时 (${timeoutMs}ms)`);
        resolve(false);
      }, timeoutMs);

      stopWatch = watch(
        () => session.wsManager.isSftpReady?.value,
        (ready) => {
          if (ready) {
            cleanup();
            resolve(true);
          }
        },
        { immediate: true }
      );
    });
  };

  // 恢复工作区状态快照到前端各个模块
  const restoreWorkspaceFromSnapshot = async (snapshot: WorkspaceSnapshot) => {
    if (!snapshot) return;

    const sessionStore = useSessionStore();
    const fileEditorStore = useFileEditorStore();
    const connectionsStore = useConnectionsStore();
    const notifStore = useUiNotificationsStore();
    const highlightStore = useTerminalHighlightStore();

    isRestoring.value = true;
    notifStore.setSilenced(true);
    logSync('开始从云端快照恢复工作区全量状态...', {
      sessionsCount: snapshot.sessions?.length || 0,
      tabsCount: snapshot.fileEditor?.tabs?.length || 0,
      activeSessionId: snapshot.activeSessionId,
      fileManagerPath: snapshot.fileManager?.currentPath,
    });

    try {
      // 1. 确保连接配置已加载
      if (!connectionsStore.connections || connectionsStore.connections.length === 0) {
        try {
          await connectionsStore.fetchConnections();
          logSync(`已加载可用连接列表，总数: ${connectionsStore.connections.length}`);
        } catch (e) {
          logSyncWarn('加载连接列表失败:', e);
        }
      }

      // 2. 检查云端挂起会话（旧端被接管时会自动挂起）
      let availableSuspended: any[] = [];
      try {
        await sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
        availableSuspended = [...(sessionStore.suspendedSshSessions || [])];
        logSync(`已拉取挂起会话列表，可用挂起数: ${availableSuspended.length}`, availableSuspended);
      } catch (e) {
        logSyncWarn('获取挂起会话列表失败:', e);
      }

      // 3. 恢复会话列表并建立会话 ID 映射 (快照旧 sessionId -> 当前实际 sessionId)
      const sessionIdMap = new Map<string, string>();

      if (snapshot.sessions && snapshot.sessions.length > 0) {
        // 预先识别云端选中的目标激活会话（若未记录则默认第 0 个）
        const targetActiveSessionSnapshotId = snapshot.activeSessionId || snapshot.sessions[0]?.sessionId;

        // 先同步匹配消费池，为并发恢复做预先规划
        const restorePlans = snapshot.sessions.map((s) => {
          const connIdNum = Number(s.connectionId);
          const connInfo = connectionsStore.connections.find(c => c.id === connIdNum);

          let matchedIdx = availableSuspended.findIndex(
            item => item.originalSessionId && item.originalSessionId === s.sessionId
          );

          if (matchedIdx === -1 && s.suspendSessionId) {
            matchedIdx = availableSuspended.findIndex(
              item => item.suspendSessionId === s.suspendSessionId
            );
          }

          if (matchedIdx === -1) {
            matchedIdx = availableSuspended.findIndex(
              item => String(item.connectionId) === String(s.connectionId) || item.connectionName === s.connectionName
            );
          }

          let matchedSuspended: any = undefined;
          if (matchedIdx !== -1) {
            matchedSuspended = availableSuspended[matchedIdx];
            availableSuspended.splice(matchedIdx, 1);
          }

          const isTargetActive = (s.sessionId === targetActiveSessionSnapshotId);

          return {
            snapshotSession: s,
            connInfo,
            matchedSuspended,
            isTargetActive,
          };
        });

        // 严格保持快照中会话从左到右的原始顺序，杜绝打乱会话栏排列
        // 并行恢复所有会话：目标会话传入 shouldActivate: true（从第 0 毫秒即刻聚焦），后台会话传入 shouldActivate: false（静默并发）
        logSync(`开始全量并发恢复 ${restorePlans.length} 个会话（保持原始顺序），目标激活会话即时聚焦，其余会话静默后台加载...`);
        await Promise.all(
          restorePlans.map(async (plan) => {
            const s = plan.snapshotSession;
            let targetSessionId: string | null = null;
            let isResumed = false;
            const shouldActivateThis = plan.isTargetActive;

            if (plan.matchedSuspended) {
              logSync(`发现匹配的挂起会话，正在并发唤醒接管: ${plan.matchedSuspended.suspendSessionId} (${plan.matchedSuspended.connectionName}, isTargetActive=${shouldActivateThis})`);
              try {
                targetSessionId = await sessionStore.resumeSshSession(plan.matchedSuspended.suspendSessionId, shouldActivateThis);
                if (targetSessionId) {
                  isResumed = true;
                  logSync(`挂起会话已并发唤醒，新会话 ID: ${targetSessionId}，由服务端接管回放`);
                }
              } catch (err) {
                logSyncWarn(`恢复挂起会话失败，降级为并发新建会话:`, err);
              }
            }

            // 若无挂起或恢复失败，则并发新建会话
            if (!targetSessionId && plan.connInfo) {
              logSync(`重新开启连接会话 (并发): ${plan.connInfo.name || plan.connInfo.host} (旧会话 ID: ${s.sessionId}, isTargetActive=${shouldActivateThis})`);
              targetSessionId = sessionStore.openNewSession(plan.connInfo.id, undefined, shouldActivateThis) || null;
            }

            // 若仍无 targetSessionId，检查本地是否已有属于该连接且未被映射的会话兜底
            if (!targetSessionId) {
              const matchedExisting = Array.from(sessionStore.sessions.values()).find(
                existingSession => String(existingSession.connectionId) === String(s.connectionId) && !Array.from(sessionIdMap.values()).includes(existingSession.sessionId)
              );
              if (matchedExisting) {
                targetSessionId = matchedExisting.sessionId;
                if (shouldActivateThis) {
                  sessionStore.activateSession(targetSessionId);
                }
              }
            }

            if (targetSessionId) {
              sessionIdMap.set(s.sessionId, targetSessionId);
              logSync(`建立会话 ID 映射: 旧 ${s.sessionId} -> 新 ${targetSessionId} (激活: ${shouldActivateThis})`);

              // 恢复单行命令输入框内容
              if (s.commandInputContent) {
                sessionStore.updateSessionCommandInput(targetSessionId, s.commandInputContent);
              }

              // 终端屏幕历史回放：如果是 resumeSshSession 唤醒的，后端会通过 logData 自动回放，此处无需重复写入
              if (!isResumed && s.terminalBuffer) {
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  logSync(`为新连接会话 ${targetSessionId} 回放快照保存的终端屏幕历史 (字符数: ${s.terminalBuffer.length})`);
                  // 对于重新建立的新连接，智能去除末尾悬空的旧提示符，避免与新 Shell 登录提示符重叠多出一行
                  const cleanedBuffer = cleanTrailingPromptForReconnect(s.terminalBuffer);
                  const highlightedData: string = highlightStore.highlight(cleanedBuffer) as string;

                  if (sessionState.terminalManager?.terminalInstance?.value) {
                    sessionState.terminalManager.terminalInstance.value.write(highlightedData);
                  } else {
                    if (!sessionState.pendingOutput) {
                      sessionState.pendingOutput = [];
                    }
                    sessionState.pendingOutput.push(highlightedData);
                  }
                }
              } else if (s.terminalBuffer === '') {
                // 快照中记录终端已清屏，若当前会话存在终端实例则立即同步清空视口
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  if (sessionState.terminalManager?.terminalInstance?.value) {
                    sessionState.terminalManager.terminalInstance.value.clear();
                  }
                  sessionState.pendingOutput = [];
                  logSync(`为会话 ${targetSessionId} 同步清空终端屏幕视口`);
                }
              }
            }
          })
        );
      }

      // 同步全局 activeSessionIdMap
      activeSessionIdMap.value = new Map(sessionIdMap);

      // 4. 同步恢复快照中的会话标签排布顺序至本地 sessionOrder (映射旧 sessionId 为新 sessionId)
      const rawOrderList = snapshot.sessionOrder || snapshot.sessions?.map(s => s.sessionId) || [];
      const restoredSessionOrder: string[] = [];
      rawOrderList.forEach(oldId => {
        const newId = sessionIdMap.get(oldId) || (sessionStore.sessions.has(oldId) ? oldId : null);
        if (newId && !restoredSessionOrder.includes(newId)) {
          restoredSessionOrder.push(newId);
        }
      });
      sessionStore.sessions.forEach((_, sId) => {
        if (!restoredSessionOrder.includes(sId)) {
          restoredSessionOrder.push(sId);
        }
      });
      if (restoredSessionOrder.length > 0) {
        logSync('从云端快照恢复会话标签排布顺序:', restoredSessionOrder);
        sessionStore.setSessionOrder(restoredSessionOrder, false);
      }

      // 会话 SessionId 解析器 (解决新设备/重连后会话 ID 重新生成的问题)
      const resolveSessionId = (oldId?: string | null, fallbackConnId?: number | string): string | null => {
        if (oldId && sessionStore.sessions.has(oldId)) return oldId;
        if (oldId && sessionIdMap.has(oldId)) {
          const mapped = sessionIdMap.get(oldId)!;
          if (sessionStore.sessions.has(mapped)) return mapped;
        }
        // 如果未显式提供 fallbackConnId，尝试从快照 sessions 中自动反查 oldId 对应的 connectionId
        let targetConnId = fallbackConnId;
        if (targetConnId === undefined && oldId && snapshot.sessions) {
          const sItem = snapshot.sessions.find(s => s.sessionId === oldId);
          if (sItem) {
            targetConnId = sItem.connectionId;
          }
        }
        if (targetConnId !== undefined) {
          const matched = Array.from(sessionStore.sessions.values()).find(
            item => String(item.connectionId) === String(targetConnId)
          );
          if (matched) return matched.sessionId;
        }
        if (sessionStore.sessions.size === 1) {
          return sessionStore.sessions.keys().next().value || null;
        }
        return sessionStore.activeSessionId || null;
      };

      // 恢复激活会话 ID (优先通过 sessionIdMap，次选通过快照中记录的 connectionId)
      if (snapshot.activeSessionId) {
        const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
        const fallbackConnId = activeSessionSnapshot?.connectionId;
        const mappedActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
        if (mappedActiveId) {
          if (sessionStore.activeSessionId !== mappedActiveId) {
            sessionStore.activateSession(mappedActiveId);
            logSync(`已对齐激活目标会话: ${mappedActiveId}`);
          } else {
            logSync(`目标会话在启动时已先行聚焦激活: ${mappedActiveId}，无需重复切换`);
          }
        }
      } else if (sessionStore.sessions.size > 0 && !sessionStore.activeSessionId) {
        const firstId = sessionStore.sessions.keys().next().value;
        if (firstId) {
          sessionStore.activateSession(firstId);
          logSync(`快照未指定激活会话，默认激活第一个会话: ${firstId}`);
        }
      }

      // 3.2 预先迁移并填充文件管理器和多行命令状态，确保组件在挂载时即可立即感知目标路径
      if (snapshot.fileManager) {
        fileManagerState.value = { ...snapshot.fileManager };
      }
      if (snapshot.fileManagers && Object.keys(snapshot.fileManagers).length > 0) {
        for (const item of Object.values(snapshot.fileManagers)) {
          const targetSessionId = resolveSessionId(item.sessionId);
          if (targetSessionId) {
            const newKey = `${targetSessionId}:${item.instanceId}`;
            fileManagerInstances.value[newKey] = {
              ...item,
              sessionId: targetSessionId,
            };
          }
        }
      }
      if (snapshot.multiLineCommandInput) {
        multiLineCommandState.value = { ...snapshot.multiLineCommandInput };
      }

      // 3.5 等待所有会话的 SFTP 就绪（最多等待 8 秒，保障文件管理器与编辑器平稳对接）
      const activeSessions = Array.from(sessionStore.sessions.values());
      if (activeSessions.length > 0) {
        logSync('正在等待会话 SFTP 就绪...');
        await Promise.all(activeSessions.map(sess => waitForSessionSftpReady(sess, 8000)));
        logSync('会话 SFTP 就绪阶段完成');
      }

      // 4. 恢复编辑器标签与滚动位置 (即时秒开呈现 + 保持未保存状态)
      if (snapshot.fileEditor && snapshot.fileEditor.tabs && snapshot.fileEditor.tabs.length > 0) {
        logSync(`正在恢复 ${snapshot.fileEditor.tabs.length} 个编辑器标签...`);
        for (const tab of snapshot.fileEditor.tabs) {
          const targetSessionId = resolveSessionId(tab.sessionId);
          if (!targetSessionId) {
            logSyncWarn(`无法解析标签 ${tab.filePath} 对应的会话 ID，跳过`);
            continue;
          }

          // 即时秒开呈现标签页，杜绝未就绪时报错与白屏
          const tabId = fileEditorStore.restoreTabFromSnapshot({
            ...tab,
            sessionId: targetSessionId,
          });

          // 恢复未保存内容
          if (tab.content) {
            fileEditorStore.updateFileContent(tabId, tab.content);
          }
          // 恢复滚动位置
          if (typeof tab.scrollTop === 'number' || typeof tab.scrollLeft === 'number') {
            fileEditorStore.updateTabScrollPosition(tabId, tab.scrollTop || 0, tab.scrollLeft || 0);
          }

          // SFTP 就绪后，对未修改的标签在后台静默 reload 校验远程最新数据
          if (!tab.isModified) {
            fileEditorStore.reloadFile(tabId, true).catch(() => {});
          }
          logSync(`成功恢复编辑器标签: ${tab.filename} (Tab ID: ${tabId}, 编码: ${tab.selectedEncoding})`);
        }

        // 激活原编辑器活动标签
        if (snapshot.fileEditor.activeTabId) {
          const origParts = snapshot.fileEditor.activeTabId.split(':');
          const origSessionId = origParts[0];
          const origFilePath = snapshot.fileEditor.activeTabId.substring(origSessionId.length + 1);
          const mappedSessionId = resolveSessionId(origSessionId);
          if (mappedSessionId && origFilePath) {
            fileEditorStore.setActiveTab(`${mappedSessionId}:${origFilePath}`);
            logSync(`激活全局编辑器活动标签: ${mappedSessionId}:${origFilePath}`);
          }
        }
      }

      // 4.1 恢复每个会话各自独立的标签页与激活状态 (供 shareFileEditorTabs=false 独立模式使用)
      if (snapshot.sessions && snapshot.sessions.length > 0) {
        for (const s of snapshot.sessions) {
          const targetSessionId = resolveSessionId(s.sessionId);
          if (!targetSessionId) continue;
          const currentSession = sessionStore.sessions.get(targetSessionId);
          if (!currentSession || !currentSession.editorTabs) continue;

          // 获取该会话要恢复的标签列表（优先从 s.editorTabs，若无则从 snapshot.fileEditor.tabs 中过滤出属于该会话的标签）
          const tabsForThisSession: SyncedFileTabInfo[] = (s.editorTabs && s.editorTabs.length > 0)
            ? s.editorTabs
            : (snapshot.fileEditor?.tabs || []).filter(t => t.sessionId === s.sessionId);

          if (tabsForThisSession.length > 0) {
            logSync(`正在恢复会话 ${targetSessionId} 的独立编辑器标签 (${tabsForThisSession.length} 个)...`);
            for (const tab of tabsForThisSession) {
              const tabId = `${targetSessionId}:${tab.filePath}`;
              const existing = currentSession.editorTabs.value.find(t => t.id === tabId || t.filePath === tab.filePath);
              if (existing) {
                if (typeof tab.content === 'string') existing.content = tab.content;
                if (tab.rawContentBase64) existing.rawContentBase64 = tab.rawContentBase64;
                if (typeof tab.isModified === 'boolean') existing.isModified = tab.isModified;
                if (typeof tab.scrollTop === 'number') existing.scrollTop = tab.scrollTop;
                if (typeof tab.scrollLeft === 'number') existing.scrollLeft = tab.scrollLeft;
              } else {
                currentSession.editorTabs.value.push({
                  id: tabId,
                  sessionId: targetSessionId,
                  filePath: tab.filePath,
                  filename: tab.filename || tab.filePath.split('/').pop() || '',
                  content: tab.content || '',
                  originalContent: tab.isModified ? '' : (tab.content || ''),
                  rawContentBase64: tab.rawContentBase64 || null,
                  language: tab.language || 'plaintext',
                  selectedEncoding: tab.selectedEncoding || 'utf-8',
                  isLoading: false,
                  loadingError: null,
                  isSaving: false,
                  saveStatus: 'idle',
                  saveError: null,
                  isModified: !!tab.isModified,
                  scrollTop: tab.scrollTop || 0,
                  scrollLeft: tab.scrollLeft || 0,
                  remoteMtime: undefined,
                  remoteSize: undefined,
                  hasExternalConflict: false,
                });
              }
            }
            // 激活会话自身的活动标签
            if (s.activeEditorTabId) {
              const origParts = s.activeEditorTabId.split(':');
              const origSessionId = origParts[0];
              const origFilePath = s.activeEditorTabId.substring(origSessionId.length + 1);
              currentSession.activeEditorTabId.value = `${targetSessionId}:${origFilePath}`;
              logSync(`激活会话 ${targetSessionId} 独立活动标签: ${currentSession.activeEditorTabId.value}`);
            }
          }
        }
      }

      // 5. 恢复文件管理器状态 (在 SFTP 就绪后平稳触发)
      if (snapshot.fileManager) {
        fileManagerState.value = { ...snapshot.fileManager };
        // 只有当快照中保存的路径有效且非根目录占位时，才平稳导航
        if (snapshot.fileManager.currentPath && isValidFileManagerSyncPath(snapshot.fileManager.currentPath)) {
          const fmSessionId = resolveSessionId(sessionStore.activeSessionId || undefined);
          logSync(`正在恢复文件管理器全局兼容路径: ${snapshot.fileManager.currentPath} (会话: ${fmSessionId || 'all'})`);
          workspaceEmitter.emit('fileManager:navigateToPath', {
            path: snapshot.fileManager.currentPath,
            sessionId: fmSessionId || undefined,
          });
        }
      }

      // 5.1 恢复每个文件管理器实例的专属路径、搜索与滚动状态
      if (snapshot.fileManagers && Object.keys(snapshot.fileManagers).length > 0) {
        logSync(`正在恢复 ${Object.keys(snapshot.fileManagers).length} 个文件管理器实例状态...`);
        for (const item of Object.values(snapshot.fileManagers)) {
          const targetSessionId = resolveSessionId(item.sessionId);
          if (!targetSessionId) continue;
          const newKey = `${targetSessionId}:${item.instanceId}`;
          fileManagerInstances.value[newKey] = {
            ...item,
            sessionId: targetSessionId,
          };
          if (item.sessionId !== targetSessionId) {
            fileManagerInstances.value[`${item.sessionId}:${item.instanceId}`] = { ...item };
          }
          if (item.currentPath && isValidFileManagerSyncPath(item.currentPath)) {
            logSync(`正在恢复文件管理器实例 [会话: ${targetSessionId}, 实例: ${item.instanceId}] 路径: ${item.currentPath}, scrollTop: ${item.scrollTop ?? 0}`);
            workspaceEmitter.emit('fileManager:navigateToPath', {
              path: item.currentPath,
              sessionId: targetSessionId,
              instanceId: item.instanceId,
            });
          }
        }
      }

      // 6. 恢复多行命令输入框状态
      if (snapshot.multiLineCommandInput) {
        multiLineCommandState.value = { ...snapshot.multiLineCommandInput };
        logSync(`已恢复多行命令输入框草稿内容`);
      }

      // 7. 最终确保工作区精准切换到上次激活的会话（防止异步加载与渲染过程中被其它事件打断）
      if (snapshot.activeSessionId) {
        const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
        const fallbackConnId = activeSessionSnapshot?.connectionId;
        const finalActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
        if (finalActiveId) {
          await nextTick();
          if (sessionStore.activeSessionId !== finalActiveId) {
            logSync(`恢复收尾，最终对齐激活会话至: ${finalActiveId}`);
            sessionStore.activateSession(finalActiveId);
          }
        }
      }

      // 8. 恢复弹窗编辑器显隐状态
      if (snapshot.fileEditor?.isOpen) {
        const targetSessionId = resolveSessionId(snapshot.activeSessionId) || sessionStore.activeSessionId;
        logSync(`从云端快照恢复弹窗编辑器为打开状态 (sessionId: ${targetSessionId})`);
        fileEditorStore.openPopup('', targetSessionId);
      } else {
        fileEditorStore.closePopup();
        logSync('从云端快照恢复弹窗编辑器为关闭状态');
      }

      logSync('恭喜！工作区全量状态无缝恢复完成！');
    } catch (err: any) {
      logSyncError('恢复工作区发生错误:', err);
    } finally {
      setTimeout(() => {
        isRestoring.value = false;
        notifStore.setSilenced(false);
      }, 1500);
    }
  };

  // 监听活动会话切换，自动触发云端状态防抖保存
  watch(
    () => sessionStore.activeSessionId,
    (newActiveId, oldActiveId) => {
      if (newActiveId && newActiveId !== oldActiveId && syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
        logSync(`检测到活动会话切换为: ${newActiveId}，安排云端状态防抖同步`);
        triggerDebouncedSave();
      }
    }
  );

  // 初始化同步服务 (页面加载时调用)
  const initSync = async () => {
    if (!syncEnabled.value) return;

    try {
      logSync('正在拉取云端工作区快照进行初始化...');
      const res = await apiClient.get('/workspace-sync');
      if (res.data?.success && res.data?.data) {
        const { state: cloudState, activeClientId } = res.data.data;
        logSync(`获取到云端快照，最后活跃客户端: ${activeClientId}，当前客户端: ${clientId.value}`);

        // 声明接管（后端会自动挂起旧端活动会话）
        await claimTakeover();

        if (cloudState && cloudState.syncEnabled) {
          await restoreWorkspaceFromSnapshot(cloudState);
        } else {
          logSync('云端快照未开启同步或为空，跳过状态恢复');
        }
      }
    } catch (err: any) {
      logSyncWarn('初始化工作区同步失败:', err.message);
    }
  };

  // 从云端获取最新快照并无缝恢复
  const restoreWorkspaceFromCloud = async (): Promise<boolean> => {
    try {
      logSync('正在从云端拉取最新工作区快照进行恢复...');
      const res = await apiClient.get('/workspace-sync');
      if (res.data?.success && res.data?.data) {
        const { state: cloudState } = res.data.data;
        if (cloudState && cloudState.syncEnabled) {
          await restoreWorkspaceFromSnapshot(cloudState);
          return true;
        }
      }
      return false;
    } catch (err: any) {
      logSyncWarn('从云端恢复工作区快照失败:', err.message);
      return false;
    }
  };

  return {
    syncEnabled,
    clientId,
    isTakenOver,
    takeoverByClientId,
    isSyncing,
    isRestoring,
    lastSyncTime,
    fileManagerState,
    fileManagerInstances,
    multiLineCommandState,
    getSavedFileManagerInstanceState,
    getSavedFileManagerPath,
    updateFileManagerInstanceState,
    updateFileManagerState,
    updateMultiLineCommandState,
    toggleSyncEnabled,
    collectCurrentWorkspaceState,
    triggerDebouncedSave,
    saveWorkspaceToCloud,
    claimTakeover,
    handleTakeoverKickout,
    restoreWorkspaceFromSnapshot,
    restoreWorkspaceFromCloud,
    initSync,
  };
});
