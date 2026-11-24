

import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useConnectionsStore, type ConnectionInfo } from '../../connections.store'; 
import { sessions, activeSessionId, sessionOrder, lastUserSwitchAt } from '../state';
import { sessionTabsWithStatus } from '../getters';
import { generateSessionId } from '../utils';
import type { SessionState, SessionKind, RemoteLinkStatus, SshTerminalInstance, StatusMonitorInstance, DockerManagerInstance, SftpManagerInstance, WsManagerInstance } from '../types';


import { createWebSocketConnectionManager } from '../../../composables/useWebSocketConnection';
import { createSshTerminalManager, type SshTerminalDependencies } from '../../../composables/useSshTerminal';
import { createStatusMonitorManager, type StatusMonitorDependencies } from '../../../composables/useStatusMonitor';
import { createDockerManager, type DockerManagerDependencies } from '../../../composables/useDockerManager';
import { registerSshSuspendHandlers } from './sshSuspendActions'; 
import { suspendSessionNow } from './suspendNow';
import apiClient from '../../../utils/apiClient';
import { useWorkspaceSyncStore, markSessionRemovedPendingSync } from '../../workspaceSync.store';
import { useUiNotificationsStore } from '../../uiNotifications.store';


// --- 辅助函数 (特定于此模块的 actions) ---
const findConnectionInfo = (connectionId: number | string, connectionsStore: ReturnType<typeof useConnectionsStore>): ConnectionInfo | undefined => {
  return connectionsStore.connections.find(c => c.id === Number(connectionId));
};

/**
 * 这条会话能不能当「当前活动会话」？
 *
 * 无终端会话（文件管理器绑定别的主机时开的私有 SFTP 通道）没有布局、不进标签栏，
 * 把它设成活动会话，工作区渲染出来的就是一片空白。
 */
const canBeActiveSession = (sessionId: string | null | undefined): boolean => {
  if (!sessionId) return false;
  const session = sessions.value.get(sessionId);
  return !!session && session.headless !== true;
};

/** 找出"这个连接的某个远程桌面会话"（远程会话不按连接去重 SSH 那套逻辑） */
const findSessionByConnection = (connectionId: number | string, kind: SessionKind): string | null => {
  const target = String(connectionId);
  for (const [sessionId, session] of sessions.value.entries()) {
    if (session.kind === kind && session.connectionId === target) return sessionId;
  }
  return null;
};

// --- Actions ---
export const openNewSession = (
    connectionOrId: ConnectionInfo | number | string,
    dependencies: {
        connectionsStore: ReturnType<typeof useConnectionsStore>;
        t: ReturnType<typeof useI18n>['t'];
    },
    existingSessionId?: string, // 可选的预定义会话 ID
    shouldActivate: boolean = true, // 是否在创建后立即激活此会话，默认为 true
    options?: {
        /**
         * 无终端会话：不激活、不进标签栏、不进 sessionOrder。
         * 目前只有「文件管理器绑定到一台没开终端的主机」会用到（见 fileManagerHosts.store）。
         */
        headless?: boolean;
        /** 目标机自托管模式：直接接管指定的远端托管会话 ID */
        remoteSessionId?: string;
        /** 目标机自托管模式：恢复分屏副终端对应的远端托管 ID 映射 */
        remotePaneSessionIds?: Record<string, string>;
        /** 仅尝试接管目标机已有托管会话，找不到时不自动新建 */
        attachOnly?: boolean;
    }
): string | undefined => {
  const { connectionsStore, t } = dependencies;
  let connInfo: ConnectionInfo | undefined;
  let connIdForLog: string | number;

  if (typeof connectionOrId === 'object' && connectionOrId !== null && 'id' in connectionOrId) {
    connInfo = connectionOrId as ConnectionInfo;
    connIdForLog = connInfo.id;
  } else {
    connIdForLog = connectionOrId as number | string;
    connInfo = findConnectionInfo(connIdForLog, connectionsStore);
  }

  console.log(`[SessionActions] 请求打开新会话: ${connIdForLog}${existingSessionId ? `, 使用预定义 ID: ${existingSessionId}` : ''}`);
  if (!connInfo) {
    console.error(`[SessionActions] 无法打开新会话：找不到 ID 为 ${connIdForLog} 的连接信息。`);
    // TODO: 向用户显示错误
    return;
  }

  const newSessionId = existingSessionId || generateSessionId();
  const dbConnId = String(connInfo.id); // connInfo is now guaranteed to be defined here

  /**
   * 会话类型由连接类型决定。
   * RDP / VNC 不再走浮动窗口，而是和 SSH 一样开一个会话标签，
   * 区别只是工作区里渲染的是占满整块的远程画面（RemoteSessionPane）。
   */
  const kind: SessionKind =
    connInfo.type === 'RDP' ? 'rdp' : connInfo.type === 'VNC' ? 'vnc' : 'ssh';
  const isRemoteSession = kind === 'rdp' || kind === 'vnc';

  // 1. 创建管理器实例
  const isResume = !!existingSessionId; // 如果提供了 existingSessionId，则为恢复流程

  // 稍后创建 wsManager，先创建 SessionState 对象的一部分
  const newSessionPartial: Omit<SessionState, 'wsManager' | 'sftpManagers' | 'terminalManager' | 'statusMonitorManager' | 'dockerManager'> & { wsManager?: WsManagerInstance } = {
      sessionId: newSessionId,
      connectionId: dbConnId,
      connectionName: connInfo.name || connInfo.host,
      kind,
      remoteStatus: isRemoteSession ? ref<RemoteLinkStatus>('connecting') : undefined,
      editorTabs: ref([]),
      activeEditorTabId: ref(null),
      commandInputContent: ref(''),
      isMarkedForSuspend: false,
      createdAt: Date.now(),
      headless: options?.headless === true,
      disposables: [],
      hostingMode: options?.remoteSessionId ? 'remote-agent' : undefined,
      remoteSessionId: options?.remoteSessionId,
      remotePaneSessionIds: options?.remotePaneSessionIds ? { ...options.remotePaneSessionIds } : undefined,
      isUnreachablePlaceholder: false,
  };

  const wsManager = createWebSocketConnectionManager(
      newSessionId, // 这个 sessionId 在 wsManager 内部使用，可能与 SessionState.sessionId 不同步（如果后者被后端更新）
      dbConnId,
      t,
      {
          isResumeFlow: isResume,
          // 无终端会话：告诉后端这条通道只用于文件管理器，接管工作区时不要把它挂进
          // 挂起池（用户从没在标签栏见过它，挂进池子就是「挂起列表里冒出我没打开过的连接」）
          isHeadless: options?.headless === true,
          initialRemoteSessionId: options?.remoteSessionId,
          attachOnly: options?.attachOnly === true,
          getIsMarkedForSuspend: () => {
              return !!newSessionPartial.isMarkedForSuspend;
          }
      }
  );
  newSessionPartial.wsManager = wsManager; // 将 wsManager 添加回部分对象

  const sshTerminalDeps: SshTerminalDependencies = {
      sendMessage: wsManager.sendMessage,
      onMessage: wsManager.onMessage,
      isConnected: wsManager.isConnected,
      // 断线时用户敲键盘 → 立即重连，不再干等退避定时器
      retryConnectionNow: () => { wsManager.retryNow('终端有键盘输入'); },
  };
  const terminalManager = createSshTerminalManager(newSessionId, sshTerminalDeps, t);
  const statusMonitorDeps: StatusMonitorDependencies = {
      onMessage: wsManager.onMessage,
      isConnected: wsManager.isConnected,
  };
  const statusMonitorManager = createStatusMonitorManager(newSessionId, statusMonitorDeps);
  const dockerManagerDeps: DockerManagerDependencies = {
      sendMessage: wsManager.sendMessage,
      onMessage: wsManager.onMessage,
      isConnected: wsManager.isConnected,
  };
  const dockerManager = createDockerManager(newSessionId, dockerManagerDeps, { t });

  // 2. 完成 SessionState 对象
  const newSession: SessionState = {
      ...newSessionPartial, // 包含 sessionId, connectionId, connectionName, wsManager, editorTabs, etc.
      wsManager: wsManager, // 确保 wsManager 被正确赋值
      sftpManagers: new Map<string, SftpManagerInstance>(),
      terminalManager: terminalManager,
      statusMonitorManager: statusMonitorManager,
      dockerManager: dockerManager,
      shouldActivateOnResume: shouldActivate, // 记录是否在唤醒/就绪后允许激活
  };
  // newSession.isMarkedForSuspend 已经在 newSessionPartial 中初始化为 false

  // 3. 添加到 Map 并根据 shouldActivate 决定是否立即激活
  const newSessionsMap = new Map(sessions.value);
  newSessionsMap.set(newSessionId, newSession);
  sessions.value = newSessionsMap;
  if (shouldActivate) {
    activeSessionId.value = newSessionId;
  }
  // 无终端会话不进 sessionOrder：它是文件管理器的私有通道，
  // 混进顺序表会被持久化到 localStorage，重启后变成"幽灵标签占位"。
  if (!options?.headless && !sessionOrder.value.includes(newSessionId)) {
    sessionOrder.value = [...sessionOrder.value, newSessionId];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sessionOrder', JSON.stringify(sessionOrder.value));
    }
  }
  console.log(`[SessionActions] 已创建新会话实例: ${newSessionId} for connection ${dbConnId} (shouldActivate: ${shouldActivate})`);

  // +++ 在连接前设置 ssh:connected 处理器以更新 sessionId +++
  let currentSessionKey = newSessionId; // 动态跟踪当前会话的 Key

  const unregisterConnectedHandler = wsManager.onMessage('ssh:connected', (connectedPayload: any) => {
    const backendSID = connectedPayload.sessionId as string;
    const backendCID = String(connectedPayload.connectionId);

    console.log(`[SessionActions/ssh:connected] 收到消息。当前会话Key: ${currentSessionKey}, 后端SID: ${backendSID}, 后端CID: ${backendCID}`);

    // 优先通过当前记录的 key 查找；如果找不到，通过 wsManager 引用在 Map 中定位
    let sessionToUpdate = sessions.value.get(currentSessionKey);
    let matchedKey = currentSessionKey;

    if (!sessionToUpdate) {
      for (const [key, s] of sessions.value.entries()) {
        if (s.wsManager === wsManager) {
          sessionToUpdate = s;
          matchedKey = key;
          break;
        }
      }
    }

    if (sessionToUpdate) {
      if (sessionToUpdate.connectionId !== backendCID) {
        console.warn(`[SessionActions/ssh:connected] 后端CID ${backendCID} 与会话 ${matchedKey} 的期望CID ${sessionToUpdate.connectionId} 不匹配。终止SID更新。`);
        return;
      }

      // 同步目标机托管元数据并清除离线占位态
      if (connectedPayload.hostingMode === 'remote-agent' || connectedPayload.hostingMode === 'legacy') {
        sessionToUpdate.hostingMode = connectedPayload.hostingMode;
      }
      if (typeof connectedPayload.remoteSessionId === 'string' && connectedPayload.remoteSessionId.trim()) {
        sessionToUpdate.remoteSessionId = connectedPayload.remoteSessionId.trim();
      }
      if (typeof connectedPayload.currentSeq === 'number') {
        sessionToUpdate.lastMuxSeq = connectedPayload.currentSeq;
      }
      if (typeof connectedPayload.persistenceWarning === 'string' && connectedPayload.persistenceWarning) {
        sessionToUpdate.persistenceWarning = connectedPayload.persistenceWarning;
      }
      sessionToUpdate.isUnreachablePlaceholder = false;
      sessionToUpdate.unreachableError = undefined;
      // 触发一次云端/本地快照沉淀，尽快把新分配的 remoteSessionId 写入工作区快照
      try {
        const wsSync = useWorkspaceSyncStore();
        if (wsSync.syncEnabled && !wsSync.isRestoring && !wsSync.isTakenOver) {
          wsSync.triggerDebouncedSave(500);
        }
      } catch {}

      if (backendSID && backendSID !== matchedKey) {
        console.log(`[SessionActions/ssh:connected] 会话ID需要更新：从 ${matchedKey} 到 ${backendSID}。`);
        const currentSessions = new Map(sessions.value);
        currentSessions.delete(matchedKey);

        sessionToUpdate.sessionId = backendSID; // 更新会话对象内部的sessionId

        currentSessions.set(backendSID, sessionToUpdate);
        sessions.value = currentSessions;

        if (activeSessionId.value === matchedKey) {
          activeSessionId.value = backendSID;
          console.log(`[SessionActions/ssh:connected] 活动会话ID已更新为 ${backendSID}。`);
        }
        currentSessionKey = backendSID; // 更新闭包中的跟踪键，确保后续重连能继续正确定位
        console.log(`[SessionActions/ssh:connected] 会话存储已更新，新键为 ${backendSID}。`);

        // 关键修复：同步将 sessionOrder 中的 matchedKey 原位替换为 backendSID，绝不破坏用户排好的顺序！
        // 无终端会话本来就不在 sessionOrder 里，这里同样一个字都别写进去。
        if (newSession.headless) {
          // no-op：文件管理器的私有会话不参与标签顺序
        } else if (sessionOrder.value.includes(matchedKey)) {
          const nextOrder = sessionOrder.value.map(id => id === matchedKey ? backendSID : id);
          sessionOrder.value = nextOrder;
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('sessionOrder', JSON.stringify(nextOrder));
          }
          console.log(`[SessionActions/ssh:connected] sessionOrder 已将 ${matchedKey} 原位替换为 ${backendSID}`);
        } else if (!sessionOrder.value.includes(backendSID)) {
          sessionOrder.value = [...sessionOrder.value, backendSID];
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('sessionOrder', JSON.stringify(sessionOrder.value));
          }
        }
      } else if (backendSID === matchedKey) {
        console.log(`[SessionActions/ssh:connected] 后端SID ${backendSID} 与前端当前Key匹配。无需重新键控。`);
      } else {
        console.error(`[SessionActions/ssh:connected] 从后端收到的 ssh:connected 消息中缺少有效的sessionId。Payload:`, connectedPayload);
      }
    } else {
      console.warn(`[SessionActions/ssh:connected] 当处理后端SID ${backendSID} 时，在存储中未找到对应的会话。`);
    }
  });

  if (newSession.disposables) {
    newSession.disposables.push(unregisterConnectedHandler);
    // 摘掉 online / visibilitychange 监听器与重连定时器：
    // 会话关了还留着监听器的话，开关几十次连接就会累积几十个
    newSession.disposables.push(() => wsManager.dispose());
  }


  // 4. 启动 WebSocket 连接
  //
  // RDP / VNC 会话只借用会话骨架（标签、顺序、清理流程），画面由浏览器内的
  // IronRDP / noVNC 自己连后端的远程隧道，跟 /ws/ 这条 SSH 通道无关——
  // 这里连了会白白把 RDP 端口当成 SSH 去握手，后端直接报错。
  if (isRemoteSession) {
    console.log(`[SessionActions] 会话 ${newSessionId} 是 ${kind.toUpperCase()} 远程桌面会话，跳过 SSH WebSocket 连接。`);
    return newSessionId;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHostAndPort = window.location.host;
  const wsUrl = `${protocol}//${wsHostAndPort}/ws/`;
  console.log(`[SessionActions] Generated WebSocket URL: ${wsUrl}`);
  wsManager.connect(wsUrl);
  console.log(`[SessionActions] 已为会话 ${newSessionId} 启动 WebSocket 连接。`);

  // 注册 SSH 挂起相关的 WebSocket 消息处理器
  // 确保只对 SSH 类型的连接注册 (虽然 wsManager 本身不包含类型信息，但 openNewSession 通常只为 SSH 调用)
  // 如果 connInfo 存在且类型为 SSH，则注册
  if (connInfo && connInfo.type === 'SSH') {
    registerSshSuspendHandlers(wsManager);
    console.log(`[SessionActions] 已为 SSH 会话 ${newSessionId} 注册 SSH 挂起处理器。`);
  } else if (connInfo) {
    console.log(`[SessionActions] 会话 ${newSessionId} 类型为 ${connInfo.type}，不注册 SSH 挂起处理器。`);
  }
  return newSessionId;
};

export const activateSession = (sessionId: string, opts?: { silent?: boolean }) => {
  if (sessions.value.has(sessionId)) {
    if (!opts?.silent) {
      // 记录"用户主动切换"，让异步的云端恢复流程知道不要再抢焦点
      lastUserSwitchAt.value = Date.now();
    }
    if (activeSessionId.value !== sessionId) {
      activeSessionId.value = sessionId;
      console.log(`[SessionActions] 已激活会话: ${sessionId}`);
    } else {
      console.log(`[SessionActions] 会话 ${sessionId} 已经是活动状态。`);
    }
  } else {
    console.warn(`[SessionActions] 尝试激活不存在的会话 ID: ${sessionId}`);
  }
};

/** 「已挂起」提示的节流时间戳：关闭其他/左侧/右侧标签时会连发几十次，不能一条条弹 */
let lastSuspendToastAt = 0;
const SUSPEND_TOAST_THROTTLE_MS = 800;

export const closeSession = async (
  sessionId: string,
  options?: {
    recordRemoval?: boolean;
    /**
     * 是否把 SSH 会话转入后台挂起（默认 false = 真断开）。
     *
     * 只有用户**主动**从标签右键菜单选「挂起会话」才传 true。
     * 关标签（点 X、关闭/关闭其他/左/右）一律按断开处理 —— 「关个标签连接还在后台活着」
     * 是很容易让人以为连接没关掉的行为，挂起必须是显式操作。
     */
    suspend?: boolean;
  },
  /**
   * 可选的 i18n 依赖。只有「挂起成功」这类需要给用户反馈的场景才用到，
   * 批量拆解（cleanupAllSessions）不传，避免逐条弹提示。
   */
  deps?: { t: ReturnType<typeof useI18n>['t'] },
) => {
  console.log(`[SessionActions] 请求关闭会话 ID: ${sessionId}`);
  const sessionToClose = sessions.value.get(sessionId);
  if (!sessionToClose) {
    console.warn(`[SessionActions] 尝试关闭不存在的会话 ID: ${sessionId}`);
    return;
  }

  // 远程桌面会话从来没有进过云端快照（RDP/VNC 不参与刷新恢复），
  // 所以既不需要记"待清理"，也不需要调后端原子销毁接口。
  const isRemoteSession = sessionToClose.kind === 'rdp' || sessionToClose.kind === 'vnc';

  // 关之前先把标签栏的真实顺序记下来。
  // 不能用 `sessions` 的 Map 顺序：里面混着无终端会话，而且 Map 顺序是"创建先后"，不是屏幕上看到的排布。
  const tabsBeforeClose = sessionTabsWithStatus.value.map(t => t.sessionId);

  // 0. 只有「挂起会话」这条显式路径才转入后台挂起（默认是直接断开）。
  //    必须在清理 wsManager / 终端实例之前做，并且要等后端确认真的接管了才敢放手：
  //    后端一旦接管，SSH 引用就从 ws 会话里摘走了，之后怎么关 ws 都杀不到它。
  let suspended = false;
  if (!isRemoteSession && options?.suspend === true) {
    const suspendResult = await suspendSessionNow(sessionToClose);
    suspended = suspendResult.ok;
    if (suspended) {
      console.log(`[SessionActions] 会话 ${sessionId} 已转入后台挂起，可在挂起面板恢复`);
      // 标签消失是有意的：告诉用户 SSH 还活着，只是进了挂起池，
      // 否则容易以为是"关个标签把连接关断了"。
      // 批量关标签（关闭其他/左侧/右侧）会连续走这里，节流成一条提示。
      const now = Date.now();
      if (deps?.t && now - lastSuspendToastAt > SUSPEND_TOAST_THROTTLE_MS) {
        lastSuspendToastAt = now;
        try {
          useUiNotificationsStore().showInfo(
            deps.t('suspendedSshSessions.tabSuspendedToast', {
              name: sessionToClose.connectionName || sessionId,
            })
          );
        } catch (notifyErr) {
          console.warn('[SessionActions] 挂起提示投递失败:', notifyErr);
        }
      }
    } else {
      console.log(`[SessionActions] 会话 ${sessionId} 挂起未成功 (${suspendResult.error})，按直接断开处理`);
    }
  }

  // 0. 先判断本次关闭能不能碰云端。
  //    接管遮罩里的 cleanupAllSessions() 会逐个走这里，那时候正在"准备从云端恢复"，
  //    不能删快照、也不能保存（否则接管回来一个会话都不剩）。
  let canTouchCloud = false;
  try {
    const workspaceSyncStore = useWorkspaceSyncStore();
    canTouchCloud = Boolean(
      workspaceSyncStore.syncEnabled
      && !workspaceSyncStore.isRestoring
      && !workspaceSyncStore.isTakenOver
      && !workspaceSyncStore.isUnloading
    );
  } catch (syncErr) {
    console.warn('[SessionActions] 读取工作区同步状态失败:', syncErr);
  }

  // 0.1 用户主动关掉的会话，一律先同步记一笔到本地。
  //     这是纯本地的"别再恢复它"标记，与能不能发网络请求无关：
  //     恢复刚结束（isRestoring 仍为 true）时关掉会话，网络请求会被跳过，
  //     若不记账，云端快照里还留着它，下次刷新就又打开了。
  //     只有"整页批量拆解"（卸载 / 接管前清场）才传 recordRemoval: false。
  if (options?.recordRemoval !== false && !isRemoteSession) {
    markSessionRemovedPendingSync(sessionId);
  }

  // 1. 调用实例上的清理和断开方法
  // 只有用户真正点关闭标签（非整页拆解/清场、且非挂起）时，才告知后端显式 KILL 目标机托管进程；
  // 刷新/路由切换/热接管清场（recordRemoval: false）或手动挂起一律优雅 DETACH 保活目标机进程。
  const shouldExplicitlyTerminateRemote = options?.recordRemoval !== false && !suspended;
  sessionToClose.wsManager.disconnect({ explicitClose: shouldExplicitlyTerminateRemote });
  console.log(`[SessionActions] 已为会话 ${sessionId} 调用 wsManager.disconnect(explicitClose=${shouldExplicitlyTerminateRemote})`);
  sessionToClose.sftpManagers.forEach((manager, instanceId) => {
      manager.cleanup();
      console.log(`[SessionActions] 已为会话 ${sessionId} 的 sftpManager (实例 ${instanceId}) 调用 cleanup()`);
  });
  sessionToClose.sftpManagers.clear();
  sessionToClose.terminalManager.cleanup();
  // 调用存储在会话中的所有清理函数
  if (sessionToClose.disposables && Array.isArray(sessionToClose.disposables)) {
    sessionToClose.disposables.forEach(dispose => {
      try {
        dispose();
      } catch (e) {
        console.error(`[SessionActions] 清理disposable时出错:`, e);
      }
    });
    sessionToClose.disposables = []; // 清空数组
    console.log(`[SessionActions] 已为会话 ${sessionId} 调用所有disposables。`);
  }
  console.log(`[SessionActions] 已为会话 ${sessionId} 调用 terminalManager.cleanup()`);
  sessionToClose.statusMonitorManager.cleanup();
  console.log(`[SessionActions] 已为会话 ${sessionId} 调用 statusMonitorManager.cleanup()`);
  sessionToClose.dockerManager.cleanup();
  console.log(`[SessionActions] 已为会话 ${sessionId} 调用 dockerManager.cleanup()`);

  // 2. 从 Map 中移除会话
  const newSessionsMap = new Map(sessions.value);
  newSessionsMap.delete(sessionId);
  sessions.value = newSessionsMap;
  console.log(`[SessionActions] 已从 Map 中移除会话: ${sessionId}`);

  // 同步从 sessionOrder 中移除
  if (sessionOrder.value.includes(sessionId)) {
    sessionOrder.value = sessionOrder.value.filter(id => id !== sessionId);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sessionOrder', JSON.stringify(sessionOrder.value));
    }
  }

  // 3. 切换活动标签页
  //
  // 三个必须守住的点：
  //   1. 下一个活动会话只能从**标签栏**里挑。`sessions` 里可能还有文件管理器开出来的
  //      无终端会话（headless）——它没有布局，选中它工作区就是整块空白，
  //      用户看到的是「关掉一个标签，整个工作区没了」，还得手点一下剩下的标签才恢复；
  //   2. 位置感：优先关掉那个标签的右边，没有就左边，符合"关掉一个、视线顺移"的直觉；
  //   3. 收尾兜底：活动会话必须是一个存在且非无终端的会话，否则退到第一个标签。
  //      （关掉非活动标签时活动会话本来就没变，这一步什么都不做。）
  if (!canBeActiveSession(activeSessionId.value)) {
    const closedTabIndex = tabsBeforeClose.indexOf(sessionId);
    const neighbourRight = closedTabIndex >= 0 ? tabsBeforeClose[closedTabIndex + 1] : undefined;
    const neighbourLeft = closedTabIndex > 0 ? tabsBeforeClose[closedTabIndex - 1] : undefined;
    const nextActiveId =
      [neighbourRight, neighbourLeft, ...tabsBeforeClose].find(
        (id) => id && id !== sessionId && canBeActiveSession(id)
      ) ?? null;
    activeSessionId.value = nextActiveId;
    console.log(`[SessionActions] 关闭会话后，活动标签切换为: ${nextActiveId}`);
  }

  // 4. 【核心强制销毁】立即调用后端原子销毁接口：强制切断SSH + 彻底清理挂起 + 强制从数据库快照剔除落盘（仅针对该 sessionId）
  //
  // 但如果前面已经成功挂起，**绝对不能**走这条路：原子销毁会把刚移交给挂起池的 SSH 一起 terminate 掉。
  // 挂起之后只需要把这条标签从云端快照里摘掉（第 5 步整体覆盖快照就够了），
  // 否则下次打开网页它又会被恢复成一个新连接。
  //
  // 注意：接管/恢复/卸载期间不能动云端（canTouchCloud 在第 0 步已判定）。
  if (canTouchCloud && !isRemoteSession) {
    const workspaceSyncStore = useWorkspaceSyncStore();
    if (!suspended) {
      // 携带本端租约 clientId，防止被接管旧端的在途删除请求篡改新端云端快照
      apiClient.delete(`/workspace-sync/sessions/${sessionId}`, {
        headers: {
          'X-Workspace-Client-Id': workspaceSyncStore.clientId,
        },
      }).then((res) => {
        console.log(`[SessionActions] 会话 ${sessionId} 已成功由后端原子销毁并落盘:`, res.data);
      }).catch((err) => {
        const respData = err?.response?.data?.data;
        if (err?.response?.status === 409 && respData?.accepted === false) {
          workspaceSyncStore.handleTakeoverKickout(respData.activeClientId || '');
          return;
        }
        console.warn(`[SessionActions] 调用后端原子销毁接口失败:`, err);
      });
    } else {
      console.log(`[SessionActions] 会话 ${sessionId} 已挂起，跳过原子销毁，仅从云端快照移除`);
    }

    // 5. 短防抖同步当前剩余会话至云端快照：单次关闭 150ms 落盘，批量关闭（关闭其他/左/右）自然合并为一次写入
    try {
      workspaceSyncStore.triggerDebouncedSave(150);
    } catch (syncErr) {
      console.warn('[SessionActions] 关闭会话后触发工作区云端持久化异常:', syncErr);
    }
  } else {
    console.log(`[SessionActions] 会话 ${sessionId} 关闭时跳过云端同步（恢复/接管/卸载中）`);
  }
};

export const handleConnectRequest = (
    connection: ConnectionInfo,
    dependencies: {
        connectionsStore: ReturnType<typeof useConnectionsStore>;
        router: ReturnType<typeof useRouter>;
        t: ReturnType<typeof useI18n>['t'];
    }
) => {
  const { connectionsStore, router, t } = dependencies;

  // 用户主动点连接 = 明确的操作意图。云端恢复是异步的，可能还在跑，
  // 不在这里打个时间戳，恢复收尾会把你刚打开的会话顶掉（远程桌面尤其明显：画面刚连上就变黑）。
  lastUserSwitchAt.value = Date.now();

  if (connection.type === 'RDP' || connection.type === 'VNC') {
    const kind: SessionKind = connection.type === 'RDP' ? 'rdp' : 'vnc';
    // 同一个连接已经开着？直接把标签切回来，别再拉第二条远程通道
    const existing = findSessionByConnection(connection.id, kind);
    if (existing) {
      console.log(`[SessionActions] 连接 ${connection.id} 已有 ${kind.toUpperCase()} 会话 ${existing}，直接激活。`);
      activateSession(existing);
    } else {
      openNewSession(connection, { connectionsStore, t });
    }
    router.push({ name: 'Workspace' });
    return;
  }

  {
    const connIdStr = String(connection.id);
    let activeAndDisconnected = false;

    if (activeSessionId.value) {
      const currentActiveSession = sessions.value.get(activeSessionId.value);
      if (currentActiveSession && currentActiveSession.connectionId === connIdStr) {
        const currentStatus = currentActiveSession.wsManager.connectionStatus.value;
        console.log(`[SessionActions] 点击的是当前活动会话 ${activeSessionId.value}，状态: ${currentStatus}`);
        if (currentStatus === 'disconnected' || currentStatus === 'error') {
          activeAndDisconnected = true;
          console.log(`[SessionActions] 活动会话 ${activeSessionId.value} 已断开或出错，尝试重连...`);
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsHostAndPort = window.location.host;
          const wsUrl = `${protocol}//${wsHostAndPort}/ws/`;
          console.log(`[SessionActions handleConnectRequest] Generated WebSocket URL for reconnect: ${wsUrl}`);
          currentActiveSession.wsManager.connect(wsUrl);
          activateSession(activeSessionId.value);
          router.push({ name: 'Workspace' });
        }
      }
    }

    if (!activeAndDisconnected) {
      console.log(`[SessionActions] 不满足重连条件或点击了其他连接，将打开新会话 for ID: ${connIdStr}`);
      openNewSession(connIdStr, { connectionsStore, t });
      router.push({ name: 'Workspace' });
    }
  }
};

/** 会话 WebSocket 的统一入口（与自动重连 / handleConnectRequest 用同一套规则） */
const buildSessionWsUrl = (): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/`;
};

/**
 * 主动断开一个 SSH 会话：只关掉 WebSocket / SSH 通道，会话实例和标签都保留。
 * 远程桌面（RDP/VNC）不走这里 —— 它们的隧道由 RemoteSessionPane 自己管。
 * @returns 是否真的处理了（非 SSH 会话返回 false）
 */
export const disconnectSession = (sessionId: string): boolean => {
  const session = sessions.value.get(sessionId);
  if (!session || session.kind !== 'ssh') return false;
  // disconnect() 内部会置 intentionalDisconnect，onclose 不会再去指数退避重连
  session.wsManager.disconnect();
  console.log(`[SessionActions] 已手动断开会话 ${sessionId}`);
  return true;
};

/**
 * 重新连接一个已断开的 SSH 会话。
 *
 * 复用同一个 sessionId / wsManager 实例（后端按 sessionId 续上新连接），
 * 所以终端历史、分屏布局都不用重建，连上后 useSshTerminal 会打一条重连分割线。
 *
 * ⚠️ 必须传 `fresh: true`：后端在 ws 关闭时就 cleanup 掉这个 sessionId 的会话了，
 * 只有重发 `ssh:connect` 才会重新建 SSH 通道。刷新页面恢复出来的会话是「恢复流程」
 * manager（默认不发 ssh:connect），不强制 fresh 的话 ws 会「假装连上」，
 * 而终端的 ssh:input 全被后端丢掉 —— 就是「重连后输入没反应」那个 bug。
 * @returns 是否发起了连接（已连接 / 非 SSH 会话返回 false）
 */
export const reconnectSession = (sessionId: string): boolean => {
  const session = sessions.value.get(sessionId);
  if (!session || session.kind !== 'ssh') return false;
  const status = session.wsManager.connectionStatus.value;
  if (status === 'connected' || status === 'connecting') {
    console.log(`[SessionActions] 会话 ${sessionId} 当前状态 ${status}，无需重连`);
    return false;
  }
  session.wsManager.connect(buildSessionWsUrl(), { fresh: true });
  console.log(`[SessionActions] 已发起会话 ${sessionId} 的重连（fresh 模式，重发 ssh:connect）`);
  return true;
};

export const handleOpenNewSession = (
    connectionId: number | string,
    dependencies: {
        connectionsStore: ReturnType<typeof useConnectionsStore>;
        t: ReturnType<typeof useI18n>['t'];
    }
) => {
  console.log(`[SessionActions] handleOpenNewSession called for ID: ${connectionId}`);
  lastUserSwitchAt.value = Date.now(); // 同上：用户主动打开，别被恢复流程顶掉
  openNewSession(connectionId, dependencies); // existingSessionId 将为 undefined，因此会生成新的
};

export const cleanupAllSessions = () => {
  console.log('[SessionActions] 清理所有会话...');
  sessions.value.forEach((_session, sessionId) => {
    // 整页拆解（页面卸载 / 接管前清场）不是"用户关掉了这些会话"，
    // 不能记进"待清理清单"——否则接管回来后它们会被当成已关闭而从快照里剔掉。
    // 同理也绝不能走挂起：这类场景要么后端自己会接管，要么整个页面就要没了，
    // 再挂起一遍只会在挂起池里堆出一串永远不会被恢复的僵尸条目。
    closeSession(sessionId, { recordRemoval: false, suspend: false });
  });
  // sessions.value.clear(); // closeSession 内部会逐个删除，这里不需要重复clear，但确认Map为空
  if (sessions.value.size > 0) { // 以防万一
    const newSessionsMap = new Map(sessions.value);
    newSessionsMap.clear();
    sessions.value = newSessionsMap;
  }
  activeSessionId.value = null;
};