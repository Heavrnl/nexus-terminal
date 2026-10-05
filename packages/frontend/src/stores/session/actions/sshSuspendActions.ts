
import { v4 as uuidv4 } from 'uuid';
import { sessions, suspendedSshSessions, isLoadingSuspendedSessions, activeSessionId } from '../state';
import type {
  MessagePayload,
  SshMarkForSuspendReqMessage,
  SshUnmarkForSuspendReqMessage, 
  SshSuspendResumeReqMessage,
  SshSuspendTerminateReqMessage,
  SshSuspendRemoveEntryReqMessage,
  
  
  SshMarkedForSuspendAckPayload,
  SshUnmarkedForSuspendAckPayload, 
  SshSuspendListResponsePayload,
  SshSuspendResumedNotifPayload,
  SshOutputCachedChunkPayload,
  SshSuspendTerminatedRespPayload,
  SshSuspendEntryRemovedRespPayload,
  
  SshSuspendAutoTerminatedNotifPayload,
} from '../../../types/websocket.types'; 
import type { WsManagerInstance, SessionState } from '../types'; 
import { closeSession as closeSessionAction, activateSession as activateSessionAction, openNewSession, closeSession } from './sessionActions'; 
import { useConnectionsStore } from '../../connections.store'; 
import { useUiNotificationsStore } from '../../uiNotifications.store'; 
import type { SuspendedSshSession } from '../../../types/ssh-suspend.types'; 
import i18n from '../../../i18n'; 
import type { ComposerTranslation } from 'vue-i18n'; 
import apiClient from '../../../utils/apiClient'; 

const t: ComposerTranslation = i18n.global.t; 

// 辅助函数：获取一个可用的 WebSocket 管理器
// 优先使用当前激活的会话，或者任意一个已连接的 SSH 会话
// 注意：此函数主要用于那些仍然需要 WebSocket 的操作 (如 resume, terminate)
const getActiveWsManager = (): WsManagerInstance | null => {

  const firstSessionKey = sessions.value.size > 0 ? sessions.value.keys().next().value : null;
  // console.log(`[getActiveWsManager] 尝试使用第一个会话 Key (如果存在): ${firstSessionKey}`);

  if (firstSessionKey) {
    const session = sessions.value.get(firstSessionKey);
    // console.log(`[getActiveWsManager]   第一个会话 (ID: ${firstSessionKey}): WS Manager 存在: ${!!session?.wsManager}, WS 已连接: ${session?.wsManager?.isConnected?.value}`);
    if (session && session.wsManager && session.wsManager.isConnected.value) {
      // console.log(`[getActiveWsManager] 使用第一个会话 (ID: ${firstSessionKey}) 的 WebSocket。`);
      return session.wsManager;
    }
  }

  // console.log('[getActiveWsManager] 第一个会话的 WebSocket 不可用或不存在，开始遍历所有会话...');
  for (const [sessionId, session] of sessions.value) {
    // console.log(`[getActiveWsManager]   遍历中 - 检查会话 ID: ${sessionId}, WS Manager 存在: ${!!session.wsManager}, WS 已连接: ${session.wsManager?.isConnected?.value}`);
    if (session.wsManager && session.wsManager.isConnected.value) {
      // console.log(`[getActiveWsManager]   遍历成功，使用会话 (ID: ${sessionId}) 的 WebSocket。`);
      return session.wsManager;
    }
  }

  // console.warn('[getActiveWsManager] 遍历结束，仍未找到可用的 WebSocket 连接来发送 SSH 挂起相关请求。');
  return null;
};


/**
 * 请求启动 SSH 会话挂起
 * @param sessionId 要挂起的活动会话 ID
 */
export const requestStartSshSuspend = (sessionId: string): void => {
  const session = sessions.value.get(sessionId);
  if (session && session.wsManager) {
    if (!session.wsManager.isConnected.value) {
      console.warn(`[${t('term.sshSuspend')}] WebSocket 未连接，无法请求标记挂起 (会话 ID: ${sessionId})。`);
      useUiNotificationsStore().addNotification({ type: 'error', message: t('sshSuspend.notifications.wsNotConnectedError') });
      return;
    }

    let initialBuffer = '';
    if (session.terminalManager && session.terminalManager.terminalInstance && session.terminalManager.terminalInstance.value) {
      const term = session.terminalManager.terminalInstance.value;
      const buffer = term.buffer.active;
      
      let lastNonEmptyLineIndex = -1;
      // 从下往上找到最后一个非空行
      for (let i = buffer.length - 1; i >= 0; i--) {
        const line = buffer.getLine(i);
        // translateToString(true) 会移除行尾空白，再 trim() 判断是否整行都是空白
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

          // 检查下一行是否是自动折行 (isWrapped)
          const nextLine = i < lastNonEmptyLineIndex ? buffer.getLine(i + 1) : null;
          const isNextWrapped = nextLine ? nextLine.isWrapped : false;

          if (isNextWrapped) {
            // 下一行由折行产生：当前行填满列宽，保留全部字符且不插入换行符
            result += line.translateToString(false);
          } else {
            // 普通独立行：移除行尾空白，自然行之间使用标准 CRLF 换行
            result += line.translateToString(true);
            if (i < lastNonEmptyLineIndex) {
              result += '\r\n';
            }
          }
        }
        initialBuffer = result;
      }

    } else {
      console.warn(`[${t('term.sshSuspend')}] 未能获取会话 ${sessionId} 的终端实例以提取初始缓冲区。`);
    }

    const message: SshMarkForSuspendReqMessage = {
      type: 'SSH_MARK_FOR_SUSPEND',
      payload: { sessionId, initialBuffer: initialBuffer || undefined }, // +++ 将 initialBuffer 添加到 payload +++
    };
    session.wsManager.sendMessage(message);
    console.log(`[${t('term.sshSuspend')}] 已发送 SSH_MARK_FOR_SUSPEND 请求 (会话 ID: ${sessionId}, 包含初始缓冲区: ${!!initialBuffer})`);
    // 前端在发送此请求后，会话应保持活动状态，直到用户关闭标签页或网络断开。
    // 后端会在 WebSocket 关闭时处理实际的挂起。
    // 用户界面上可以给一个提示，表明“此会话已标记，关闭后将尝试挂起”。
    useUiNotificationsStore().addNotification({
      type: 'info',
      message: t('sshSuspend.notifications.markedForSuspendInfo', { id: sessionId.slice(0,8) }),
      timeout: 5000, // +++ 修改：duration -> timeout +++
    });

  } else {
    console.warn(`[${t('term.sshSuspend')}] 未找到会话或 WebSocket 管理器 (会话 ID: ${sessionId})，无法请求标记挂起。`);
    useUiNotificationsStore().addNotification({ type: 'error', message: t('sshSuspend.notifications.sessionNotFoundError') });
  }
};

/**
 * 请求取消标记一个会话为待挂起
 * @param sessionId 要取消标记的活动会话 ID
 */
export const requestUnmarkSshSuspend = (sessionId: string): void => {
  const session = sessions.value.get(sessionId);
  if (session && session.wsManager) {
    if (!session.wsManager.isConnected.value) {
      console.warn(`[${t('term.sshSuspend')}] WebSocket 未连接，无法请求取消标记挂起 (会话 ID: ${sessionId})。`);
      useUiNotificationsStore().addNotification({ type: 'error', message: t('sshSuspend.notifications.wsNotConnectedError') });
      return;
    }
    if (!session.isMarkedForSuspend) {
      console.warn(`[${t('term.sshSuspend')}] 会话 ${sessionId} 并未被标记为待挂起，无需取消。`);
      // 可以选择不发送请求或发送一个让后端确认的请求
      // 为保持简单，如果前端状态已经是未标记，则不执行操作或仅给用户提示
      useUiNotificationsStore().addNotification({ type: 'info', message: t('sshSuspend.notifications.notMarkedWarning') });
      return;
    }

    const message: SshUnmarkForSuspendReqMessage = {
      type: 'SSH_UNMARK_FOR_SUSPEND',
      payload: { sessionId },
    };
    session.wsManager.sendMessage(message);
    console.log(`[${t('term.sshSuspend')}] 已发送 SSH_UNMARK_FOR_SUSPEND 请求 (会话 ID: ${sessionId})`);
  } else {
    console.warn(`[${t('term.sshSuspend')}] 未找到会话或 WebSocket 管理器 (会话 ID: ${sessionId})，无法请求取消标记挂起。`);
    useUiNotificationsStore().addNotification({ type: 'error', message: t('sshSuspend.notifications.sessionNotFoundError') });
  }
};

/**
 * 获取挂起的 SSH 会话列表 (通过 HTTP API)
 */
export const fetchSuspendedSshSessions = async (options?: { showLoadingIndicator?: boolean }): Promise<void> => {
  const shouldShowLoading = options?.showLoadingIndicator ?? true;

  if (shouldShowLoading) {
    isLoadingSuspendedSessions.value = true;
  }
  try {
    // 假设后端 API 端点为 /api/ssh/suspended-sessions
    // 并且它返回 SuspendedSshSession[] 类型的数据
    const response = await apiClient.get<SuspendedSshSession[]>('ssh-suspend/suspended-sessions');
    suspendedSshSessions.value = response.data;
    console.log(`[${t('term.sshSuspend')}] 已通过 HTTP 获取挂起列表，数量: ${response.data.length}`);
  } catch (error) {
    console.error(`[${t('term.sshSuspend')}] 通过 HTTP 获取挂起列表失败:`, error);
    // 可选：通知用户错误
    const uiNotificationsStore = useUiNotificationsStore();
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.fetchListError', { error: String(error) }),
    });
    // 即使失败，也可能需要清空旧数据或保留旧数据，具体取决于产品需求
    // suspendedSshSessions.value = []; // 例如，失败时清空
  } finally {
    if (shouldShowLoading) {
      isLoadingSuspendedSessions.value = false;
    }
  }
};

/**
 * 请求恢复指定的挂起 SSH 会话
 * @param suspendSessionId 要恢复的挂起会话的 ID
 */
export const resumeSshSession = async (suspendSessionId: string): Promise<void> => {
  const uiNotificationsStore = useUiNotificationsStore();
  const connectionsStore = useConnectionsStore();
  // const { t } = useI18n(); // t 已经在模块顶部定义

  const sessionToResumeInfo = suspendedSshSessions.value.find(s => s.suspendSessionId === suspendSessionId);
  if (!sessionToResumeInfo) {
    console.error(`[${t('term.sshSuspend')}] 恢复操作失败：在挂起列表中未找到会话 ${suspendSessionId}`);
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.resumeErrorInfoNotFound', { id: suspendSessionId.slice(0, 8) }),
    });
    return;
  }

  const originalConnectionId = parseInt(sessionToResumeInfo.connectionId, 10);
  if (isNaN(originalConnectionId)) {
    console.error(`[${t('term.sshSuspend')}] 恢复操作失败：无效的原始连接 ID ${sessionToResumeInfo.connectionId}`);
    uiNotificationsStore.addNotification({ type: 'error', message: t('sshSuspend.notifications.resumeErrorConnectionConfigNotFound', { id: sessionToResumeInfo.connectionId }) });
    return;
  }

  const newFrontendSessionId = uuidv4(); // 为恢复的会话生成新的前端 ID

  try {
    // +++ 先从 connectionsStore 获取完整的 ConnectionInfo +++
    const connectionInfo = connectionsStore.connections.find(c => c.id === originalConnectionId);
    if (!connectionInfo) {
      console.error(`[${t('term.sshSuspend')}] 恢复操作失败：在 Connection Store 中未找到原始连接配置 (ID: ${originalConnectionId})。`);
      uiNotificationsStore.addNotification({ type: 'error', message: t('sshSuspend.notifications.resumeErrorConnectionConfigNotFound', { id: String(originalConnectionId) }) });
      return;
    }
    console.log(`[${t('term.sshSuspend')}] 已找到原始连接配置 (ID: ${originalConnectionId})，准备使用它恢复会话 ${suspendSessionId}。将创建新前端会话 ${newFrontendSessionId} 并连接 WebSocket。`);
    
    // 1. 调用 openNewSession 创建前端会话状态、WebSocket 连接等，传入完整的 connectionInfo
    openNewSession(
      connectionInfo, // +++ 传入完整的 ConnectionInfo 对象 +++
      { connectionsStore, t }, // 传递依赖
      newFrontendSessionId    // 将 newFrontendSessionId 作为 existingSessionId 传递
    );

    // 2. 获取新创建会话的 wsManager
    const newSessionState = sessions.value.get(newFrontendSessionId);
    if (!newSessionState || !newSessionState.wsManager) {
      console.error(`[${t('term.sshSuspend')}] 调用 openNewSession 后未能获取会话 ${newFrontendSessionId} 或其 wsManager。`);
      uiNotificationsStore.addNotification({ type: 'error', message: t('sshSuspend.notifications.resumeErrorGeneric', { error: '无法初始化新会话界面组件' }) });
      return;
    }
    const wsManager = newSessionState.wsManager;

    // 3. 等待 WebSocket 连接成功
    const MAX_WAIT_ITERATIONS = 25; // 25 * 200ms = 5 seconds
    let iterations = 0;
    while (!wsManager.isConnected.value && iterations < MAX_WAIT_ITERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 200));
      iterations++;
    }

    if (!wsManager.isConnected.value) {
      console.error(`[${t('term.sshSuspend')}] 新创建的会话 ${newFrontendSessionId} 的 WebSocket 未能连接。无法发送恢复请求。`);
      uiNotificationsStore.addNotification({ type: 'error', message: t('sshSuspend.notifications.resumeErrorGeneric', { error: '无法连接到服务器以恢复会话' }) });
      if (sessions.value.has(newFrontendSessionId)) {
        closeSession(newFrontendSessionId); // 清理未成功连接的会话
      }
      return;
    }
    
    // 4. 发送恢复请求
    console.log(`[${t('term.sshSuspend')}] 会话 ${newFrontendSessionId} 的 WebSocket 已连接，准备发送恢复请求。`);
    const message: SshSuspendResumeReqMessage = {
      type: 'SSH_SUSPEND_RESUME_REQUEST',
      payload: { suspendSessionId, newFrontendSessionId },
    };
    // console.log(`[${t('term.sshSuspend')}] resumeSshSession: 准备通过 wsManager (会话 ${newFrontendSessionId}) 发送消息: ${JSON.stringify(message)}`);
    wsManager.sendMessage(message);
    // console.log(`[${t('term.sshSuspend')}] resumeSshSession: 已调用 wsManager.sendMessage 发送 SSH_SUSPEND_RESUME_REQ (挂起 ID: ${suspendSessionId}, 新前端ID: ${newFrontendSessionId})`);

    // 后续流程由 handleSshSuspendResumedNotif 处理
    // 它会使用 newFrontendSessionId，并将 isResuming 标记设置到这个会话上。
    // 成功后，它内部应该会调用 fetchSuspendedSshSessions() 来更新列表。

  } catch (error) {
    console.error(`[${t('term.sshSuspend')}] 恢复会话 ${suspendSessionId} 过程中发生顶层错误:`, error);
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.resumeErrorGeneric', { error: String(error) }),
    });
    // 如果 newFrontendSessionId 对应的会话已创建但恢复失败，也需要清理
    if (sessions.value.has(newFrontendSessionId)) {
      closeSession(newFrontendSessionId);
    }
  }
};

/**
 * 请求终止并移除一个活跃的挂起 SSH 会话
 * @param suspendSessionId 要终止并移除的挂起会话 ID
 */
export const terminateAndRemoveSshSession = async (suspendSessionId: string): Promise<void> => {
  console.log(`[${t('term.sshSuspend')}] 请求通过 HTTP API 终止并移除挂起会话 (ID: ${suspendSessionId})`);
  const uiNotificationsStore = useUiNotificationsStore();
  try {
    // 假设后端 API 返回成功时状态码为 200/204，失败时返回错误信息
    await apiClient.delete(`ssh-suspend/terminate/${suspendSessionId}`);
    console.log(`[${t('term.sshSuspend')}] HTTP API 终止并移除会话 ${suspendSessionId} 成功。`);

    // 复用或直接实现 handleSshSuspendTerminatedResp 的逻辑
    const index = suspendedSshSessions.value.findIndex(s => s.suspendSessionId === suspendSessionId);
    if (index !== -1) {
      const removedSession = suspendedSshSessions.value.splice(index, 1)[0];
      uiNotificationsStore.addNotification({
        type: 'info',
        message: t('sshSuspend.notifications.terminatedSuccess', { name: removedSession.customSuspendName || removedSession.connectionName }),
      });
    }
  } catch (error: any) {
    console.error(`[${t('term.sshSuspend')}] 通过 HTTP API 终止并移除会话 ${suspendSessionId} 失败:`, error);
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.terminateError', { error: error.response?.data?.message || error.message || t('term.unknownError') }),
    });
  }
};

/**
 * 请求移除一个已断开的挂起 SSH 会话条目
 * @param suspendSessionId 要移除的挂起会话条目 ID
 */
export const removeSshSessionEntry = async (suspendSessionId: string): Promise<void> => {
  console.log(`[${t('term.sshSuspend')}] 请求通过 HTTP API 移除已断开的挂起条目 (ID: ${suspendSessionId})`);
  const uiNotificationsStore = useUiNotificationsStore();
  try {
    await apiClient.delete(`ssh-suspend/entry/${suspendSessionId}`);
    console.log(`[${t('term.sshSuspend')}] HTTP API 移除已断开条目 ${suspendSessionId} 成功。`);

    // 复用或直接实现 handleSshSuspendEntryRemovedResp 的逻辑
    const index = suspendedSshSessions.value.findIndex(s => s.suspendSessionId === suspendSessionId);
    if (index !== -1) {
      const removedSession = suspendedSshSessions.value.splice(index, 1)[0];
      uiNotificationsStore.addNotification({
        type: 'info',
        message: t('sshSuspend.notifications.entryRemovedSuccess', { name: removedSession.customSuspendName || removedSession.connectionName }),
      });
    }
  } catch (error: any) {
    console.error(`[${t('term.sshSuspend')}] 通过 HTTP API 移除已断开条目 ${suspendSessionId} 失败:`, error);
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.entryRemovedError', { error: error.response?.data?.message || error.message || t('term.unknownError') }),
    });
  }
};

/**
 * 请求编辑挂起 SSH 会话的自定义名称 (通过 HTTP API)
 * @param suspendSessionId 要编辑的挂起会话 ID
 * @param newCustomName 新的自定义名称
 */
export const editSshSessionName = async (suspendSessionId: string, newCustomName: string): Promise<void> => {
  console.log(`[${t('term.sshSuspend')}] 请求通过 HTTP API 编辑挂起会话名称 (ID: ${suspendSessionId}, 新名称: "${newCustomName}")`);
  const uiNotificationsStore = useUiNotificationsStore();
  try {
    // 假设后端 API 端点为 /api/ssh-suspend/name/:suspendSessionId
    // 并且它接受一个包含 { customName: string } 的 PUT 请求体
    // 并返回包含 { message: string, customName: string } 的成功响应
    const response = await apiClient.put<{ message: string, customName: string }>(
      `ssh-suspend/name/${suspendSessionId}`,
      { customName: newCustomName }
    );

    console.log(`[${t('term.sshSuspend')}] HTTP API 编辑名称 ${suspendSessionId} 成功:`, response.data);

    // 更新前端状态
    const session = suspendedSshSessions.value.find(s => s.suspendSessionId === suspendSessionId);
    if (session) {
      session.customSuspendName = response.data.customName; // 使用后端返回的名称确保一致性
      uiNotificationsStore.addNotification({
        type: 'success',
        message: t('sshSuspend.notifications.nameEditedSuccess', { name: response.data.customName }),
      });
    } else {
      // 如果会话在前端列表中找不到了（理论上不应该发生，因为是先找到再编辑的）
      // 也可以选择重新获取列表
      fetchSuspendedSshSessions();
    }
  } catch (error: any) {
    console.error(`[${t('term.sshSuspend')}] 通过 HTTP API 编辑名称 ${suspendSessionId} 失败:`, error);
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.nameEditedError', { error: error.response?.data?.message || error.message || t('term.unknownError') }),
    });
  }
};

/**
 * 请求导出指定挂起 SSH 会话的日志
 * @param suspendSessionId 要导出日志的挂起会话 ID
 */
export const exportSshSessionLog = async (suspendSessionId: string): Promise<void> => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 请求导出挂起会话日志 (ID: ${suspendSessionId})`);

  try {
    // API 端点为 /api/v1/ssh-suspend/log/:suspendSessionId
    // apiClient.get会自动处理Blob响应类型，并尝试触发下载
    // 我们需要获取建议的文件名，后端会在 Content-Disposition 头中提供
    const response = await apiClient.get<Blob>(`ssh-suspend/log/${suspendSessionId}`, {
      responseType: 'blob', // 重要：期望响应为 Blob
      // 我们可以传递一个 onDownloadProgress 回调（如果 apiClient 支持的话）
    });

    // 从 Content-Disposition 获取文件名
    const contentDisposition = response.headers['content-disposition'];
    let filename = `ssh_log_${suspendSessionId}.log`; // 默认文件名
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
      if (filenameMatch && filenameMatch.length > 1) {
        filename = filenameMatch[1];
      }
    }

    // 创建一个下载链接并点击它
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename); // 设置下载文件名
    document.body.appendChild(link);
    link.click();

    // 清理
    link.parentNode?.removeChild(link);
    window.URL.revokeObjectURL(url);

    uiNotificationsStore.addNotification({
      type: 'success',
      message: t('sshSuspend.notifications.logExportSuccess', { name: filename }),
    });
    console.log(`[${t('term.sshSuspend')}] 挂起会话日志 ${filename} (ID: ${suspendSessionId}) 已开始下载。`);

  } catch (error: any) {
    console.error(`[${t('term.sshSuspend')}] 导出挂起会话日志 ${suspendSessionId} 失败:`, error);
    let errorMessage = t('term.unknownError');
    if (error.response && error.response.data) {
      // 如果响应是 Blob 但我们期望 JSON 错误信息，需要特殊处理
      // 假设错误时后端会返回 JSON
      if (error.response.data instanceof Blob && error.response.headers['content-type']?.includes('application/json')) {
        try {
          const errorJson = JSON.parse(await error.response.data.text());
          errorMessage = errorJson.message || errorMessage;
        } catch (e) {
          // Blob 不是有效的 JSON，使用通用错误
        }
      } else if (typeof error.response.data === 'object') {
        errorMessage = error.response.data.message || error.message;
      } else {
        errorMessage = error.message;
      }
    } else {
      errorMessage = error.message || String(error);
    }
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.logExportError', { error: errorMessage }),
    });
  }
};

// --- S2C Message Handlers ---

// 旧的 handleSshSuspendStartedResp 不再需要，因为流程已改变
// const handleSshSuspendStartedResp = (payload: SshSuspendStartedRespPayload): void => { ... };

const handleSshMarkedForSuspendAck = (payload: SshMarkedForSuspendAckPayload): void => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_MARKED_FOR_SUSPEND_ACK:`, payload);
  if (payload.success) {
    // 标记成功，用户可以继续使用会话，关闭时会自动尝试挂起。
    // requestStartSshSuspend 中已经给过一个提示了。
    // 这里可以再给一个更持久的提示，或者更新UI状态（例如在标签页上加个小图标）
    // uiNotificationsStore.addNotification({
    //   type: 'success',
    //   message: t('sshSuspend.notifications.markedForSuspendSuccess', { id: payload.sessionId.slice(0,8) }),
    // });
    // 注意：此时不关闭会话，也不刷新挂起列表。实际挂起发生在后端WebSocket断开时。
    // 可以在 sessions.value 中对应会话的状态里加一个标记 isMarkedForSuspend = true
    const session = sessions.value.get(payload.sessionId);
    if (session) {
      session.isMarkedForSuspend = true; // 假设 SessionState 有此字段
      sessions.value = new Map(sessions.value); // 强制更新 Map
    }

  } else {
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.markForSuspendError', { error: payload.error || t('term.unknownError') }),
    });
    console.error(`[${t('term.sshSuspend')}] 标记会话 ${payload.sessionId} 失败: ${payload.error}`);
    const session = sessions.value.get(payload.sessionId);
    if (session) {
      session.isMarkedForSuspend = false; // 确保标记被清除
      sessions.value = new Map(sessions.value); // 强制更新 Map
    }
  }
};

const handleSshUnmarkedForSuspendAck = (payload: SshUnmarkedForSuspendAckPayload): void => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_UNMARKED_FOR_SUSPEND_ACK:`, payload);
  const session = sessions.value.get(payload.sessionId);

  if (payload.success) {
    if (session) {
      session.isMarkedForSuspend = false;
      sessions.value = new Map(sessions.value); // 强制更新 Map
    }
    uiNotificationsStore.addNotification({
      type: 'success',
      message: t('sshSuspend.notifications.unmarkedSuccess', { id: payload.sessionId.slice(0,8) }),
    });
  } else {
    // 即便后端失败，如果前端之前是标记状态，也最好保持一致或提示用户检查
    // 但通常后端失败意味着前端状态可能与后端不一致，提示错误让用户知晓
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.unmarkError', { error: payload.error || t('term.unknownError') }),
    });
    console.error(`[${t('term.sshSuspend')}] 取消标记会话 ${payload.sessionId} 失败: ${payload.error}`);
    // 此处不自动回滚前端的 isMarkedForSuspend 状态，因为后端是权威源。
    // 如果后端说操作失败，那么会话可能仍然被后端认为是标记的（尽管这不应该发生，因为后端会先清除标记）。
  }
};

const handleSshSuspendListResponse = (payload: SshSuspendListResponsePayload): void => {
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_SUSPEND_LIST_RESPONSE，数量: ${payload.suspendSessions.length}`);
  suspendedSshSessions.value = payload.suspendSessions;
  isLoadingSuspendedSessions.value = false;
};

const handleSshSuspendResumedNotif = async (payload: SshSuspendResumedNotifPayload): Promise<void> => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_SUSPEND_RESUMED_NOTIF:`, payload);

  if (payload.success) {
    const suspendedSession = suspendedSshSessions.value.find(s => s.suspendSessionId === payload.suspendSessionId);
    // suspendedSession 主要用于显示通知的友好名称。如果找不到，恢复流程仍可继续，但通知可能不那么具体。
    if (!suspendedSession) {
      console.warn(`[${t('term.sshSuspend')}] 处理 SSH_SUSPEND_RESUMED_NOTIF 时：在挂起列表中未找到会话 ${payload.suspendSessionId} 的详细信息。通知消息可能不完整。`);
    }

    try {
      // 会话应该已由 resumeSshSession action 通过调用 openNewSession 创建。
      // 它包含了所有必要的管理器和 WebSocket 连接。
      const sessionToUpdate = sessions.value.get(payload.newFrontendSessionId) as SessionState | undefined;

      if (!sessionToUpdate) {
        console.error(`[${t('term.sshSuspend')}] 处理 SSH_SUSPEND_RESUMED_NOTIF 失败：未找到 ID 为 ${payload.newFrontendSessionId} 的预创建会话。`);
        uiNotificationsStore.addNotification({
          type: 'error',
          message: t('sshSuspend.notifications.resumeErrorGeneric', { error: '无法找到已初始化的恢复会话界面组件。' }),
        });
        // 如果会话未找到，可能意味着 resumeSshSession 中的 openNewSession 失败或被意外清理
        return;
      }
      
      // 确保 wsManager 存在，理论上它应该由 openNewSession 创建
      if (!sessionToUpdate.wsManager) {
        console.error(`[${t('term.sshSuspend')}] 会话 ${payload.newFrontendSessionId} 存在但缺少 wsManager。`);
        uiNotificationsStore.addNotification({ type: 'error', message: '恢复失败：会话状态不完整。'});
        return;
      }

      sessionToUpdate.isResuming = true; // 标记会话为正在恢复
      // (可选) 如果需要在 SessionState 中存储原始挂起ID:
      // sessionToUpdate.originalSuspendId = payload.suspendSessionId;

      console.log(`[${t('term.sshSuspend')}] 会话 ${payload.newFrontendSessionId} 已标记为正在恢复。`);
      activateSessionAction(payload.newFrontendSessionId); // 激活标签页

      let notificationName = t('sshSuspend.notifications.defaultSessionName'); // 使用 i18n 获取默认名
      if (suspendedSession) {
        notificationName = suspendedSession.customSuspendName || suspendedSession.connectionName || notificationName;
      }
      uiNotificationsStore.addNotification({
        type: 'success',
        message: t('sshSuspend.notifications.resumeSuccess', { name: notificationName }),
      });
      // 后端会通过与此 sessionToUpdate.wsManager 关联的 WebSocket 连接发送 SSH_OUTPUT_CACHED_CHUNK
    } catch (error) {
      console.error(`[${t('term.sshSuspend')}] 处理会话恢复通知时出错:`, error);
      uiNotificationsStore.addNotification({
        type: 'error',
        message: t('sshSuspend.notifications.resumeErrorGeneric', { error: String(error) }),
      });
    }
    // 成功恢复后，立即从前端挂起列表中移除
    const resumedSessionIndex = suspendedSshSessions.value.findIndex(s => s.suspendSessionId === payload.suspendSessionId);
    if (resumedSessionIndex !== -1) {
      suspendedSshSessions.value.splice(resumedSessionIndex, 1);
      console.log(`[${t('term.sshSuspend')}] Successfully resumed and removed session ${payload.suspendSessionId} from the frontend list.`);
    }
    // 可选：fetchSuspendedSshSessions(); // 如果仍然需要与后端同步最新列表，可以保留，但即时性由上面的 splice 保证
  } else {
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.resumeErrorBackend', { error: payload.error || t('term.unknownError') }),
    });
    console.error(`[${t('term.sshSuspend')}] 后端报告恢复会话失败 (挂起 ID: ${payload.suspendSessionId}): ${payload.error}`);
    // 如果后端报告恢复失败，可能需要关闭由 resumeSshSession 创建的前端会话
    if (sessions.value.has(payload.newFrontendSessionId)) {
        console.log(`[${t('term.sshSuspend')}] 因后端恢复失败，正在关闭前端会话 ${payload.newFrontendSessionId}`);
        closeSession(payload.newFrontendSessionId);
    }
  }
};

const handleSshOutputCachedChunk = (payload: SshOutputCachedChunkPayload): void => {
  const session = sessions.value.get(payload.frontendSessionId) as SessionState | undefined;
  if (session && session.terminalManager) {
    // 规范化换行符：确保回放数据中的换行使用标准 CRLF (\r\n)，避免由于缺失 \r 触发 VT100 阶梯效应
    const rawData = payload.data;
    const normalizedData = typeof rawData === 'string'
      ? rawData.replace(/\r?\n/g, '\r\n')
      : rawData;

    if (session.terminalManager.terminalInstance.value) {
      // 终端实例已就绪，直接写入
      console.log('[SSH Suspend Frontend] Received cached chunk data (writing to terminal):', normalizedData);
      session.terminalManager.terminalInstance.value.write(normalizedData);
    } else {
      // 终端实例尚未就绪，暂存输出
      if (!session.pendingOutput) {
        session.pendingOutput = [];
      }
      console.log('[SSH Suspend Frontend] Received cached chunk data (buffering):', normalizedData);
      session.pendingOutput.push(normalizedData);
      // console.log(`[${t('term.sshSuspend')}] (会话: ${payload.frontendSessionId}) 终端实例未就绪，已暂存数据块 (长度: ${normalizedData.length})。当前暂存块数: ${session.pendingOutput.length}`);
    }

    // isLastChunk 逻辑应该在数据被处理（写入或暂存）后执行
    if (payload.isLastChunk) {
      console.log(`[${t('term.sshSuspend')}] (会话: ${payload.frontendSessionId}) 已接收所有缓存输出的最后一个数据块标记。`);
      if (session.isResuming === true) {
        // 如果终端实例还未就绪，isResuming 状态的解除可能需要等到 pendingOutput 被清空时
        // 但如果 isLastChunk 到了，至少可以认为后端数据发送完毕
        // 实际的 isResuming = false 最好在 pendingOutput 被写入终端后处理
        // 这里只记录日志，具体状态变更由 Terminal.vue 或相关 manager 负责
        console.log(`[${t('term.sshSuspend')}] (会话: ${payload.frontendSessionId}) isResuming 标记仍为 true，等待终端处理暂存数据（如有）。`);
      }
    }
  } else {
    console.warn(`[${t('term.sshSuspend')}] 收到缓存数据块，但找不到对应会话或其终端管理器 (ID: ${payload.frontendSessionId})`);
  }
};

const handleSshSuspendTerminatedResp = (payload: SshSuspendTerminatedRespPayload): void => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_SUSPEND_TERMINATED_RESP:`, payload);
  if (payload.success) {
    const index = suspendedSshSessions.value.findIndex(s => s.suspendSessionId === payload.suspendSessionId);
    if (index !== -1) {
      const removedSession = suspendedSshSessions.value.splice(index, 1)[0];
      uiNotificationsStore.addNotification({
        type: 'info',
        message: t('sshSuspend.notifications.terminatedSuccess', { name: removedSession.customSuspendName || removedSession.connectionName }),
      });
    }
  } else {
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.terminateError', { error: payload.error || t('term.unknownError') }),
    });
    console.error(`[${t('term.sshSuspend')}] 终止挂起会话失败 (ID: ${payload.suspendSessionId}): ${payload.error}`);
  }
};

const handleSshSuspendEntryRemovedResp = (payload: SshSuspendEntryRemovedRespPayload): void => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_SUSPEND_ENTRY_REMOVED_RESP:`, payload);
  if (payload.success) {
    const index = suspendedSshSessions.value.findIndex(s => s.suspendSessionId === payload.suspendSessionId);
    if (index !== -1) {
      const removedSession = suspendedSshSessions.value.splice(index, 1)[0];
      uiNotificationsStore.addNotification({
        type: 'info',
        message: t('sshSuspend.notifications.entryRemovedSuccess', { name: removedSession.customSuspendName || removedSession.connectionName }),
      });
    }
  } else {
    uiNotificationsStore.addNotification({
      type: 'error',
      message: t('sshSuspend.notifications.entryRemovedError', { error: payload.error || t('term.unknownError') }),
    });
    console.error(`[${t('term.sshSuspend')}] 移除挂起条目失败 (ID: ${payload.suspendSessionId}): ${payload.error}`);
  }
};

// handleSshSuspendNameEditedResp removed as edit is now via HTTP

const handleSshSuspendAutoTerminatedNotif = (payload: SshSuspendAutoTerminatedNotifPayload): void => {
  const uiNotificationsStore = useUiNotificationsStore();
  console.log(`[${t('term.sshSuspend')}] 接到 SSH_SUSPEND_AUTO_TERMINATED_NOTIF:`, payload);
  const session = suspendedSshSessions.value.find(s => s.suspendSessionId === payload.suspendSessionId);
  if (session) {
    session.backendSshStatus = 'disconnected_by_backend'; // 使用正确的字段名
    session.disconnectionTimestamp = new Date().toISOString(); // 更新为 ISO 字符串
    // 可以在 SuspendedSshSession 类型中添加 disconnectionReason 字段
    // session.disconnectionReason = payload.reason;
    uiNotificationsStore.addNotification({
      type: 'warning',
      message: t('sshSuspend.notifications.autoTerminated', { name: session.customSuspendName || session.connectionName, reason: payload.reason }),
    });
  }
};

/**
 * 注册 SSH 挂起相关的 WebSocket 消息处理器。
 * 此函数应在 WebSocket 连接建立后，针对每个会话的 wsManager 实例调用。
 * @param wsManager 与特定 SSH 会话关联的 WebSocket 管理器实例
 */
export const registerSshSuspendHandlers = (wsManager: WsManagerInstance): void => {
  console.log(`[${t('term.sshSuspend')}] 尝试为 WebSocket 管理器注册 SSH 挂起处理器...`);

  if (!wsManager) {
    console.error(`[${t('term.sshSuspend')}] 注册处理器失败：wsManager 未定义。`);
    return;
  }

  // 注意：wsManager.onMessage 返回一个注销函数，如果需要，可以收集它们并在会话关闭时调用。
  // 但通常这些处理器会随 wsManager 实例的生命周期一起存在。
  // wsManager.onMessage('SSH_SUSPEND_STARTED_RESP', (p: MessagePayload) => handleSshSuspendStartedResp(p as SshSuspendStartedRespPayload));
  wsManager.onMessage('SSH_MARKED_FOR_SUSPEND_ACK', (p: MessagePayload) => handleSshMarkedForSuspendAck(p as SshMarkedForSuspendAckPayload));
  wsManager.onMessage('SSH_UNMARKED_FOR_SUSPEND_ACK', (p: MessagePayload) => handleSshUnmarkedForSuspendAck(p as SshUnmarkedForSuspendAckPayload)); 
  wsManager.onMessage('SSH_SUSPEND_LIST_RESPONSE', (p: MessagePayload) => handleSshSuspendListResponse(p as SshSuspendListResponsePayload));
  wsManager.onMessage('SSH_SUSPEND_RESUMED_NOTIF', (p: MessagePayload) => handleSshSuspendResumedNotif(p as SshSuspendResumedNotifPayload));
  wsManager.onMessage('SSH_OUTPUT_CACHED_CHUNK', (p: MessagePayload) => handleSshOutputCachedChunk(p as SshOutputCachedChunkPayload));
  wsManager.onMessage('SSH_SUSPEND_TERMINATED_RESP', (p: MessagePayload) => handleSshSuspendTerminatedResp(p as SshSuspendTerminatedRespPayload));
  wsManager.onMessage('SSH_SUSPEND_ENTRY_REMOVED_RESP', (p: MessagePayload) => handleSshSuspendEntryRemovedResp(p as SshSuspendEntryRemovedRespPayload));
  // SSH_SUSPEND_NAME_EDITED_RESP handler removed
  wsManager.onMessage('SSH_SUSPEND_AUTO_TERMINATED_NOTIF', (p: MessagePayload) => handleSshSuspendAutoTerminatedNotif(p as SshSuspendAutoTerminatedNotifPayload));

  console.log(`[${t('term.sshSuspend')}] SSH 挂起模式的 WebSocket 消息处理器已注册 (移除了名称编辑相关的处理器)。`);

  // 连接建立后，主动获取一次挂起列表
  // 考虑：是否应该在这里做，或者在应用启动时做一次？
  // 如果 wsManager 是针对某个具体会话的，那么每个会话连接时都获取列表可能不是最优。
  // 更好的地方可能是在 App.vue 或主会话 store 初始化时，通过一个“全局”的 wsManager (如果存在) 或其中一个 wsManager 获取。
  // 但如果挂起列表只通过当前连接的 ws 通道获取，那这里是合适的。
  // 假设 getActiveWsManager 能取到这个 wsManager 实例，那 actions.ts 里的 fetchSuspendedSshSessions() 会用它
  // 这里直接调用 fetchSuspendedSshSessions() 也可以
  fetchSuspendedSshSessions();
};