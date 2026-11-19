import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, nextTick, shallowRef, watch } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import apiClient from '../utils/apiClient';
import { isDesktopApp } from '../utils/platform';
import { useSessionStore } from './session.store';
import { lastUserSwitchAt } from './session/state';
import { useFileEditorStore, type FileTab } from './fileEditor.store';
import { useConnectionsStore } from './connections.store';
import { useUiNotificationsStore } from './uiNotifications.store';
import { useLayoutStore, type LayoutNode, type PaneName } from './layout.store';
import { workspaceEmitter } from '../composables/workspaceEvents';
import { filterRemovedSessions, resolveSnapshotSessionId } from '../utils/workspaceSnapshot';
import { gzipText } from '../utils/compression';
import {
  isValidFileManagerSyncPath,
  type SyncedFileManagerInfo,
  type SyncedFileManagerInstanceState,
  type SyncedFileTabInfo,
  type SyncedMultiLineCommandInfo,
  type SyncedSessionInfo,
  type WorkspaceSnapshot,
} from './workspaceSync/types';
import { collectWorkspaceSnapshot } from './workspaceSync/collectSnapshot';
import { logSync, logSyncError, logSyncWarn } from './workspaceSync/log';
import { restoreEditorsFromSnapshot } from './workspaceSync/restoreEditors';
import { restoreFileManagersFromSnapshot } from './workspaceSync/restoreFileManagers';
import { cleanTrailingPromptForReconnect } from './workspaceSync/terminalBuffer';
import {
  createSessionIdResolver,
  restoreSessionOrder,
  restoreSessionsFromSnapshot,
} from './workspaceSync/restoreSessions';
import { waitForSessionSftpReady } from './workspaceSync/waitForSftp';
import { registerPrewarm, usePrewarm, PREWARM_KEYS } from '../utils/prewarm';
import { suspendedSshSessions } from './session/state';

// 快照类型是所有快照读写方的公共契约，这里重新导出，既有 import 路径保持不变。
export type {
  SyncedFileManagerInfo,
  SyncedFileManagerInstanceState,
  SyncedFileTabInfo,
  SyncedMultiLineCommandInfo,
  SyncedSessionInfo,
  WorkspaceSnapshot,
} from './workspaceSync/types';
import {
  getLocalStorageSafe,
  markSessionRemovedPendingSync as markSessionRemovedPendingSyncIn,
  readPendingRemovedSessions as readPendingRemovedSessionsIn,
  readSessionIdAliases as readSessionIdAliasesIn,
  recordSessionIdAlias as recordSessionIdAliasIn,
  removePendingRemovedSessions as removePendingRemovedSessionsIn,
} from '../utils/pendingRemoval';

const SYNC_ENABLED_STORAGE_KEY = 'nexus_workspace_sync_enabled';
const CLIENT_ID_SESSION_KEY = 'nexus_workspace_sync_client_id';

/**
 * "已关闭、但可能还没同步到云端" 的会话清单。
 *
 * 关掉一个会话后立刻刷新页面时，closeSession 发出的两个请求
 * （DELETE /workspace-sync/sessions/:id、POST /workspace-sync/save）都还在路上，
 * 页面的下一次 GET 会先读到"还带着这个会话"的旧快照 → 已关闭的会话又活过来了。
 * 所以关闭的那一刻就同步写一份清单到 localStorage，加载快照时先把这些会话剔除掉。
 *
 * 具体实现（含存储 key、上限、别名表）在 utils/pendingRemoval.ts，那里可被单测直接覆盖。
 */

// --- 「已关闭待清理」清单与 ID 别名表（实现见 utils/pendingRemoval.ts）---
const storage = () => getLocalStorageSafe();

const readPendingRemovedSessions = (): string[] => readPendingRemovedSessionsIn(storage());

/** 记录一个"已关闭待清理"的会话（同步写入，页面立刻刷新也不会丢） */
export const markSessionRemovedPendingSync = (sessionId: string): void => {
  markSessionRemovedPendingSyncIn(sessionId, storage(), resolveSnapshotSessionId);
};

const readSessionIdAliases = (): Record<string, string> => readSessionIdAliasesIn(storage());

const recordSessionIdAlias = (localId: string, snapshotId: string): void => {
  recordSessionIdAliasIn(localId, snapshotId, storage());
};

/** 保存成功后，移除"本次保存之前就已记录"的条目（保存途中新关掉的会话不会被误清） */
const removePendingRemovedSessions = (ids: string[]): void => {
  removePendingRemovedSessionsIn(ids, storage());
};

// 诊断日志统一格式见 stores/workspaceSync/log.ts

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

/** 工作区实时同步是否开启（桌面端恒为 false）。可脱离组件上下文调用。 */
export const isWorkspaceSyncEnabled = (): boolean => {
  if (isDesktopApp()) return false;
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) !== 'false';
};

/** 预取 key 统一放在 utils/prewarm.ts 的 PREWARM_KEYS 里 */

let prewarmTask: Promise<void> | null = null;

/**
 * 挂载前预取「恢复工作区要用的四个往返」。
 *
 * 这是"打开网页就无缝恢复"的关键一招：`main.ts` 在 `app.mount()` 之前调用它，
 * 与路由懒加载的 chunk 下载并行跑。挂载后的恢复流程取用这些已 resolve 的 promise，
 * 于是它只剩微任务 —— 会话在首帧绘制前就进了 store，用户不会先看到一个空工作区。
 *
 * 不依赖 pinia / 组件上下文（`session.store` 用了 `useI18n`/`useRouter`，
 * 在组件外实例化会抛错，所以这里只用 apiClient 发原始请求）。
 */
export const prewarmWorkspaceSync = (): Promise<void> => {
  if (prewarmTask) return prewarmTask;
  if (!isWorkspaceSyncEnabled()) {
    prewarmTask = Promise.resolve();
    return prewarmTask;
  }

  logSync('（挂载前）并行预取工作区快照 / 接管租约 / 挂起会话 / 连接列表...');

  const snapshot = registerPrewarm(
    PREWARM_KEYS.snapshot,
    apiClient
      .get('/workspace-sync')
      .then((res) => (res.data?.success && res.data?.data ? res.data.data : null))
      .catch(() => null),
  );

  // ⚠️ 接管租约必须**无条件**抢，不能等快照里看到 syncEnabled 再抢：
  //    云端快照为空（首次使用 / 上一个客户端存了个空 state）时同样要立住租约，
  //    否则租约一直留在旧 clientId 手上，本端每一次保存都会被后端判成「已被接管」直接丢掉，
  //    表现就是「打开新页面 → 会话关不掉也存不下」。这条和原 initSync 的语义一致。
  const claim = registerPrewarm(
    PREWARM_KEYS.claim,
    apiClient
      .post('/workspace-sync/claim', { clientId: getOrCreateClientId() })
      .then((res) => !!res.data?.success)
      .catch(() => false),
  );

  // 挂起列表必须排在 claim 之后：正是这次 claim 让后端把旧端的会话挂起来的。
  const suspended = registerPrewarm(
    PREWARM_KEYS.suspended,
    claim.then(() =>
      apiClient
        .get('ssh-suspend/suspended-sessions')
        .then((res) => res.data ?? null)
        .catch(() => null),
    ),
  );

  // 连接列表与上面几件事没有依赖，最早就能并行下去
  const connections = registerPrewarm(
    PREWARM_KEYS.connections,
    apiClient
      .get('/connections')
      .then((res) => res.data ?? null)
      .catch(() => null),
  );

  prewarmTask = Promise.all([snapshot, claim, suspended, connections]).then(() => {
    logSync('（挂载前）预取完成。');
  });
  return prewarmTask;
};

export const useWorkspaceSyncStore = defineStore('workspaceSync', () => {
  const sessionStore = useSessionStore();

  // 1. 同步开关：桌面端强制禁用 (false)，Web端默认开启 (true)
  const syncEnabled = ref<boolean>(
    isDesktopApp()
      ? false
      : (typeof localStorage !== 'undefined'
          ? localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) !== 'false'
          : true)
  );

  // 2. 客户端唯一标识 (基于 sessionStorage，保证单标签页刷新保持、多标签/跨设备互斥)
  const clientId = ref<string>(getOrCreateClientId());

  // 3. 被接管与遮罩状态
  const isTakenOver = ref<boolean>(false);
  const takeoverByClientId = ref<string | null>(null);

  // 4. 正在同步、恢复与初始化标记 (防止死循环与空快照冲刷)
  const isInitialized = ref<boolean>(false);
  const isSyncing = ref<boolean>(false);
  const isRestoring = ref<boolean>(false);
  /**
   * 页面正在卸载（刷新/关闭标签）。
   *
   * 卸载时 `cleanupAllSessions()` 会清空会话列表，如果这期间的 watcher 又触发了一次
   * "保存工作区"，就会把**空的会话列表**写进云端快照 —— 刷新后会话全没了。
   */
  const isUnloading = ref<boolean>(false);
  /** 是否已经成功从云端恢复过一次（用于阻止"恢复前空会话覆盖快照"） */
  let hasRestoredOnce = false;
  /**
   * 挂载前预取时"欠着"的慢活儿（等 SFTP、编辑器/文件管理器面板、弹窗显隐）。
   * 它们不影响「标签栏长什么样」，所以可以等首帧画完再补。
   */
  let pendingWorkspaceTail: (() => Promise<void>) | null = null;
  /** 预取是否已经把「首屏该长什么样」定下来了（initSync 据此不再重复拉快照） */
  let prefetchedRestore = false;
  /** 预取任务本身（重复调用只跑一次） */
  let prefetchTask: Promise<boolean> | null = null;
  /** 正在跑的收尾任务（重复调用只跑一次） */
  let tailTask: Promise<void> | null = null;
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
    if (isDesktopApp()) return;
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
  // 采集实现见 stores/workspaceSync/collectSnapshot.ts（204 行）
  const collectCurrentWorkspaceState = (): WorkspaceSnapshot =>
    collectWorkspaceSnapshot({
      syncEnabled: syncEnabled.value,
      fileManagerState: fileManagerState.value,
      fileManagerInstances: fileManagerInstances.value,
      multiLineCommandState: multiLineCommandState.value,
    });

  // 防抖计时器与串行保存队列（弱网乱序防护）
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本客户端单调递增的快照保存序号，用于后端拦截弱网迟到的旧快照 */
  let localSaveSeq = 0;
  /** 当前是否有正在飞行中的云端保存请求 */
  let inFlightSavePromise: Promise<boolean> | null = null;
  /** 飞行期间是否又有新的状态变更待补发（合并为结束后的一次最新快照） */
  let pendingResaveRequested = false;

  const triggerDebouncedSave = (delayMs: number = 800) => {
    if (isDesktopApp() || !syncEnabled.value || !isInitialized.value || isRestoring.value || isTakenOver.value || isUnloading.value) return;

    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await saveWorkspaceToCloud();
    }, delayMs);
  };

  // 保存工作区到云端 (仅 Web 端有效；内置串行队列 + 单调 saveSeq 彻底防止弱网乱序覆盖)
  const saveWorkspaceToCloud = async (): Promise<boolean> => {
    if (isDesktopApp() || !syncEnabled.value || !isInitialized.value || isRestoring.value || isTakenOver.value || isUnloading.value) return false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    // 已有保存请求在途：只记脏，等当前请求结束后自动用最新状态补发一次，绝不并发竞态
    if (inFlightSavePromise) {
      pendingResaveRequested = true;
      return inFlightSavePromise;
    }

    const executeSave = async (): Promise<boolean> => {
      let lastResult = false;
      do {
        pendingResaveRequested = false;
        if (isDesktopApp() || !syncEnabled.value || !isInitialized.value || isRestoring.value || isTakenOver.value || isUnloading.value) {
          break;
        }
        try {
          const snapshot = collectCurrentWorkspaceState();
          // 本次保存真正落地后，这一批"已关闭待清理"记录就没用了（只清本次保存之前记下的）
          const pendingAtSaveStart = readPendingRemovedSessions();
          // 首屏/恢复前的"空会话"绝不允许覆盖云端已有的快照。
          // 否则页面刚加载、会话还没恢复完时，任意一次 watcher 触发都会把空列表写上去，
          // 下次刷新就"会话全没了"（这个问题以前随机出现，就是这个空窗期）。
          if (snapshot.sessions.length === 0 && !hasRestoredOnce) {
            logSync('跳过空快照保存：尚未完成首次恢复');
            lastResult = false;
            continue;
          }
          isSyncing.value = true;
          const seq = ++localSaveSeq;
          logSync('正在将工作区快照保存至云端...', {
            saveSeq: seq,
            sessionsCount: snapshot.sessions.length,
            tabsCount: snapshot.fileEditor.tabs.length,
            tabs: snapshot.fileEditor.tabs.map(t => `${t.filename}(${t.selectedEncoding})`),
            fileManagerPath: snapshot.fileManager.currentPath,
          });

          // 保存到后端数据库（带单调 saveSeq 供后端防乱序覆盖）
          const requestBody = { clientId: clientId.value, saveSeq: seq, state: snapshot };
          const json = JSON.stringify(requestBody);
          const compressed = await gzipText(json);
          // 空工作区这类极小的快照压完反而更大，此时直接用明文
          const useCompressed = Boolean(compressed && compressed.byteLength < json.length);
          if (compressed && useCompressed) {
            logSync(
              `快照压缩上传: ${(json.length / 1024).toFixed(0)}KB -> ${(compressed.byteLength / 1024).toFixed(0)}KB `
              + `(${(json.length / compressed.byteLength).toFixed(1)}x)`
            );
          }
          const res = useCompressed
            ? await apiClient.post('/workspace-sync/save', compressed!, {
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Encoding': 'gzip',
                },
                transformRequest: [(data) => data],
              })
            : await apiClient.post('/workspace-sync/save', requestBody);

          if (res.data?.success) {
            const payload = res.data.data as { accepted?: boolean; activeClientId?: string | null } | undefined;
            if (payload && payload.accepted === false) {
              /**
               * 租约已被接管的客户端调用过 claim，本次写入被后端拒绝。
               * 这里必须让本端立刻进入遮罩：否则被接管的旧页面还会继续用"旧状态"覆盖云端，
               * 表现就是——在另一个页面关掉的会话，刷新后又回来了。
               */
              logSyncWarn(`本次保存被拒绝：工作区租约已归 ${payload.activeClientId || '其它客户端'}，当前端进入接管遮罩`);
              isTakenOver.value = true;
              takeoverByClientId.value = payload.activeClientId || null;
              pendingResaveRequested = false;
              if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
              }
              lastResult = false;
              break;
            }
            lastSyncTime.value = Date.now();
            removePendingRemovedSessions(pendingAtSaveStart);
            logSync('工作区快照已成功持久化至云端数据库！时间:', new Date().toLocaleTimeString());
            lastResult = true;
          } else {
            lastResult = false;
          }
        } catch (err: any) {
          logSyncWarn('保存工作区到云端失败:', err.message);
          lastResult = false;
        } finally {
          isSyncing.value = false;
        }
      } while (pendingResaveRequested);
      return lastResult;
    };

    inFlightSavePromise = executeSave().finally(() => {
      inFlightSavePromise = null;
    });
    return inFlightSavePromise;
  };

  // 声明接管 (Claim Lease) (仅 Web 端有效)
  const claimTakeover = async (): Promise<boolean> => {
    if (isDesktopApp()) return false;
    try {
      logSync(`当前客户端 (${clientId.value}) 正在声明工作区接管权...`);

      // 挂载前预取时已经发过这一枪，这里直接复用（没有预取的路径照旧现场发）
      const claimed = await usePrewarm<boolean>(PREWARM_KEYS.claim, () =>
        apiClient
          .post('/workspace-sync/claim', { clientId: clientId.value })
          .then((res) => !!res.data?.success),
      );

      if (claimed) {
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

  // 处理被其它客户端接管的踢出通知 (仅 Web 端有效)
  const handleTakeoverKickout = (targetActiveClientId: string) => {
    if (isDesktopApp()) return;
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

  /** 恢复解锁兜底计时器（仅用于 deferTail 后调用方长时间未触发 runPendingWorkspaceTail 的极端兜底） */
  let restoreUnlockTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 真正完成恢复（含 SFTP、编辑器、文件管理器收尾）后解除 `isRestoring` 锁，并触发沉淀保存。
   * 绝不能在 `runPendingWorkspaceTail` 完成前用固定 1.5s 提前解锁 —— 否则慢 SFTP 场景下会把尚未恢复出来的
   * 空编辑器标签和空文件管理器路径覆盖写回云端数据库。
   */
  const scheduleRestoreUnlock = (delayMs: number = 300) => {
    if (restoreUnlockTimer) {
      clearTimeout(restoreUnlockTimer);
      restoreUnlockTimer = null;
    }
    const notifStore = useUiNotificationsStore();
    restoreUnlockTimer = setTimeout(() => {
      restoreUnlockTimer = null;
      isRestoring.value = false;
      notifStore.setSilenced(false);
      if (syncEnabled.value && !isTakenOver.value && !isUnloading.value) {
        triggerDebouncedSave(300);
      }
    }, delayMs);
  };

  // 恢复工作区状态快照到前端各个模块
  /**
   * 应用"已关闭待清理"清单：把快照里那些刚被关掉、但删除/保存请求还没到账的会话剔除。
   *
   * 用户关掉会话后立刻刷新时，云端 GET 往往还返回旧快照（带着那个会话），
   * 直接恢复就等于"关掉的会话又回来了"。这里在恢复前先按本地记录剔除。
   */
  const consumePendingRemovedSessions = <T extends WorkspaceSnapshot>(snapshot: T): T => {
    const pending = readPendingRemovedSessions();
    if (!pending.length) return snapshot;

    const { snapshot: filtered, removedCount } = filterRemovedSessions(snapshot, pending);
    if (removedCount > 0) {
      logSyncWarn(`云端快照里还留着 ${removedCount} 个刚关闭的会话（关闭后立即刷新导致），已在恢复前剔除`);
    }
    return filtered;
  };

  const restoreWorkspaceFromSnapshot = async (
    snapshot: WorkspaceSnapshot,
    opts?: {
      /**
       * 只做「决定首屏长什么样」的那一段（会话/顺序/激活/文件管理器状态），
       * 把等 SFTP、恢复编辑器与面板这些慢活儿丢到后台继续。
       * 挂载前调用时用它 —— 首帧就该是正确的，不必先画一个空工作区再填。
       */
      deferTail?: boolean;
    },
  ) => {
    if (!snapshot) return;

    const sessionStore = useSessionStore();
    const fileEditorStore = useFileEditorStore();
    const connectionsStore = useConnectionsStore();
    const notifStore = useUiNotificationsStore();
    const layoutStore = useLayoutStore();

    isRestoring.value = true;
    // 记录恢复起点：之后只要用户手动切过标签（lastUserSwitchAt > 这个值），
    // 整个恢复流程就不再抢焦点。
    const restoreStartedAt = Date.now();
    notifStore.setSilenced(true);
    logSync('开始从云端快照恢复工作区全量状态...', {
      sessionsCount: snapshot.sessions?.length || 0,
      tabsCount: snapshot.fileEditor?.tabs?.length || 0,
      activeSessionId: snapshot.activeSessionId,
      fileManagerPath: snapshot.fileManager?.currentPath,
    });

    try {
      // 0. 布局与侧栏不再从工作区快照恢复 —— 它们有自己的持久化（settings.layout / layoutPresets），
      //    快照里的副本是"上一次保存时"的旧值（布局变更后快照要 1.5s 才落库）。
      //    以前在这里 updateLayoutTree(snapshot.layout.layoutTree) 会用旧尺寸把刚调好的布局盖回去，
      //    表现为"改完立刻刷新 → 先变回旧的，等 SSH 恢复后又跳回新的"。
      //    现在布局只认 layout store 自己加载的 settings.layout，快照只负责会话/编辑器/文件管理器。

      // 1+2. 接管租约与连接列表互不依赖，并行发起；挂起会话必须等接管之后才有意义。
      //      以前这里是「依次 await 三次网络往返」，白白把首屏推后两三个 RTT。
      const connectionsTask = (async () => {
        if (connectionsStore.connections && connectionsStore.connections.length > 0) return;
        try {
          await connectionsStore.fetchConnections();
          logSync(`已加载可用连接列表，总数: ${connectionsStore.connections.length}`);
        } catch (e) {
          logSyncWarn('加载连接列表失败:', e);
        }
      })();
      await Promise.all([claimTakeover(), connectionsTask]);

      // 3. 检查云端挂起会话（旧端被接管时会自动挂起）
      let availableSuspended: any[] = [];
      try {
        // 预取里已经有这一枪（而且它排在 claim 之后，挂起列表是完整的）
        const prefetchedSuspended = await usePrewarm<any[] | null>(
          PREWARM_KEYS.suspended,
          async () => {
            await sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
            return null;
          },
        );
        if (prefetchedSuspended) {
          // 恢复流程依赖这份列表（resumeSshSession 要按挂起 ID 查），写回同一份 state
          suspendedSshSessions.value = prefetchedSuspended;
        }
        availableSuspended = [...(sessionStore.suspendedSshSessions || [])];
        logSync(`已拉取挂起会话列表，可用挂起数: ${availableSuspended.length}`, availableSuspended);
      } catch (e) {
        logSyncWarn('获取挂起会话列表失败:', e);
      }

      // 3. 恢复会话列表并建立 ID 映射（实现见 stores/workspaceSync/restoreSessions.ts）
      const sessionIdMap = await restoreSessionsFromSnapshot({ snapshot, availableSuspended });

      // 同步全局 activeSessionIdMap
      activeSessionIdMap.value = new Map(sessionIdMap);

      // 4. 恢复会话标签排布顺序（实现见 stores/workspaceSync/restoreSessions.ts）
      restoreSessionOrder({ snapshot, sessionIdMap });

      // 会话 ID 解析器（降级顺序见 createSessionIdResolver）
      const resolveSessionId = createSessionIdResolver({ snapshot, sessionIdMap });

      // 恢复激活会话 ID (优先通过 sessionIdMap，次选通过快照中记录的 connectionId)
      if (snapshot.activeSessionId) {
        const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
        const fallbackConnId = activeSessionSnapshot?.connectionId;
        const mappedActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
        if (mappedActiveId) {
          if (sessionStore.activeSessionId !== mappedActiveId) {
            if (lastUserSwitchAt.value > restoreStartedAt) {
              logSync('恢复过程中用户已手动切换会话，跳过激活对齐');
            } else {
              sessionStore.activateSession(mappedActiveId, { silent: true });
              logSync(`已对齐激活目标会话: ${mappedActiveId}`);
            }
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
        logSync(`已恢复多行命令输入框草稿内容`);
      }

      /**
       * 慢活儿：等 SFTP、恢复编辑器与文件管理器面板、弹窗显隐。
       * 它们只影响 pane 里的内容，不影响「标签栏长什么样」，所以完全可以放到首帧之后。
       */
      const runTail = async () => {
        // 3.5 等待所有会话的 SFTP 就绪（最多等待 8 秒，保障文件管理器与编辑器平稳对接）
        const activeSessions = Array.from(sessionStore.sessions.values());
        if (activeSessions.length > 0) {
          logSync('正在等待会话 SFTP 就绪...');
          await Promise.all(activeSessions.map(sess => waitForSessionSftpReady(sess, 8000)));
          logSync('会话 SFTP 就绪阶段完成');
        }

        // 4/4.1 编辑器标签恢复（实现见 stores/workspaceSync/restoreEditors.ts）
        restoreEditorsFromSnapshot({ snapshot, resolveSessionId });

        // 5/5.1 文件管理器恢复（实现见 stores/workspaceSync/restoreFileManagers.ts）
        restoreFileManagersFromSnapshot({
          snapshot,
          resolveSessionId,
          activeSessionId: sessionStore.activeSessionId,
          fileManagerState,
          fileManagerInstances,
        });

        // 7. 最终确保工作区精准切换到上次激活的会话（防止异步加载与渲染过程中被其它事件打断）
        //    但如果用户在恢复期间已经手动点过标签，就必须尊重用户的选择，不能把他拽回去。
        if (snapshot.activeSessionId) {
          const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
          const fallbackConnId = activeSessionSnapshot?.connectionId;
          const finalActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
          if (finalActiveId) {
            await nextTick();
            if (sessionStore.activeSessionId !== finalActiveId) {
              if (lastUserSwitchAt.value > restoreStartedAt) {
                logSync('恢复收尾：检测到用户已手动切换会话，跳过最终激活对齐');
              } else {
                logSync(`恢复收尾，最终对齐激活会话至: ${finalActiveId}`);
                sessionStore.activateSession(finalActiveId, { silent: true });
              }
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

        logSync('工作区面板内容恢复完成。');
      };

      // 首屏要的东西（标签栏 / 激活 / 文件管理器路径）到这里就齐了。
      // 挂载前预取时把慢活儿欠着，等首帧画完再补 —— 这样"打开网页"和"拉云端状态"
      // 两件事是并行的，而不是先给用户看一个空工作区、再花几百毫秒往里填。
      if (opts?.deferTail) {
        pendingWorkspaceTail = runTail;
        // 兜底：若始终未进入工作区调用 runPendingWorkspaceTail，12s 后自动释放恢复锁
        scheduleRestoreUnlock(12000);
      } else {
        await runTail();
        scheduleRestoreUnlock(300);
      }

      hasRestoredOnce = true;
      logSync('工作区首屏状态已就位（会话/顺序/激活/文件管理器路径）。');
    } catch (err: any) {
      logSyncError('恢复工作区发生错误:', err);
      scheduleRestoreUnlock(300);
    }
  };

  /**
   * 补跑恢复流程里「欠着」的慢活儿（等 SFTP / 编辑器 / 文件管理器面板 / 弹窗显隐）。
   * 幂等：同一批只跑一次。收尾完成后才真正解除 `isRestoring` 锁。
   */
  const runPendingWorkspaceTail = async (): Promise<void> => {
    if (tailTask) return tailTask;
    const task = pendingWorkspaceTail;
    if (!task) return;
    pendingWorkspaceTail = null;
    tailTask = (async () => {
      // 让首帧先真正画出来，再开始动 pane 里的东西
      await nextTick();
      try {
        await task();
      } catch (err: any) {
        logSyncError('恢复收尾（SFTP/编辑器/文件管理器）失败:', err);
      } finally {
        tailTask = null;
        scheduleRestoreUnlock(300);
      }
    })();
    return tailTask;
  };

  /**
   * 拉快照并恢复「决定首屏长什么样」的那一段（会话 / 顺序 / 激活 / 文件管理器路径）。
   *
   * 真正的请求由 `prewarmWorkspaceSync()` 在 `app.mount()` 之前就发出去了，
   * 与路由 chunk 的下载并行；这里只是取用那份已经 resolve 的结果。
   * 于是本函数里的每个 `await` 都是微任务 —— 会话在首帧绘制前就进了 store，
   * 用户不会先看到一个"没有任何会话"的空工作区。
   *
   * 幂等：重复调用返回同一个 promise。
   */
  const prefetchWorkspaceSnapshot = (): Promise<boolean> => {
    if (isDesktopApp() || !syncEnabled.value) return Promise.resolve(false);
    if (prefetchTask) return prefetchTask;

    prefetchTask = (async () => {
      try {
        logSync('正在取用云端工作区快照...');
        // 挂载前预取过就直接用那一枪的结果（它此刻早已 resolve，恢复流程只剩微任务）
        const data = await usePrewarm<any | null>(PREWARM_KEYS.snapshot, () =>
          apiClient
            .get('/workspace-sync')
            .then((res) => (res.data?.success && res.data?.data ? res.data.data : null)),
        );
        if (!data) return false;

        const { state: cloudState, activeClientId } = data;
        logSync(`获取到云端快照，最后活跃客户端: ${activeClientId}，当前客户端: ${clientId.value}`);

        if (!cloudState || !cloudState.syncEnabled) {
          logSync('云端快照未开启同步或为空，跳过状态恢复');
          return false;
        }

        // 接管租约在 restore 内部与「连接列表」并行发起，别在这里再叠加一次网络往返
        await restoreWorkspaceFromSnapshot(consumePendingRemovedSessions(cloudState), {
          deferTail: true,
        });
        prefetchedRestore = true;
        return true;
      } catch (err: any) {
        logSyncWarn('（挂载前）预取工作区快照失败:', err?.message);
        return false;
      }
    })();

    return prefetchTask;
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

  // 监听布局与侧栏结构变化，自动触发工作区防抖保存
  const layoutStore = useLayoutStore();
  watch(
    () => [layoutStore.layoutTree, layoutStore.sidebarPanes],
    () => {
      if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
        logSync('检测到工作区布局或侧栏配置调整，安排云端状态防抖同步');
        triggerDebouncedSave(1500);
      }
    },
    { deep: true }
  );

  // 初始化同步服务 (页面加载时调用，仅 Web 端有效)
  const initSync = async () => {
    if (isDesktopApp() || !syncEnabled.value) {
      isInitialized.value = true;
      return;
    }

    try {
      /**
       * 挂载前已经预取并恢复过：这里绝对不能再拉一次快照。
       * 再拉一次会让后端把租约重新算一遍、还会拿同一份数据重新建会话，
       * 而首屏早就正确了 —— 此时唯一还没做的只有收尾慢活儿。
       */
      if (prefetchedRestore) {
        logSync('工作区已在挂载前预取恢复，跳过重复拉取，仅补跑收尾');
        void runPendingWorkspaceTail();
        return;
      }

      // 没有预取（例如直接落在 /connections 再切进工作区，或预取时弱网失败）：这里补上，语义与预取一致
      const restored = await prefetchWorkspaceSnapshot();
      if (restored) {
        void runPendingWorkspaceTail();
      } else {
        // 快照为空或首屏预取失败时，仍需补一次接管租约，避免本端成为无租约客户端被后续保存误判踢出
        await claimTakeover();
        hasRestoredOnce = true;
      }
    } catch (err: any) {
      logSyncWarn('初始化工作区同步失败:', err.message);
    } finally {
      isInitialized.value = true;
      logSync('工作区同步初始化完毕，isInitialized 状态锁已放行。');
    }
  };

  // 从云端获取最新快照并无缝恢复 (仅 Web 端有效)
  const restoreWorkspaceFromCloud = async (): Promise<boolean> => {
    if (isDesktopApp()) return false;
    try {
      logSync('正在从云端拉取最新工作区快照进行恢复...');
      const res = await apiClient.get('/workspace-sync');
      if (res.data?.success && res.data?.data) {
        const { state: cloudState } = res.data.data;
        if (cloudState && cloudState.syncEnabled) {
          await restoreWorkspaceFromSnapshot(consumePendingRemovedSessions(cloudState));
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
    isUnloading,
    markUnloading: () => {
      isUnloading.value = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    },
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
    prefetchWorkspaceSnapshot,
    runPendingWorkspaceTail,
    initSync,
  };
});
