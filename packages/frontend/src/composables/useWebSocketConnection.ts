import { ref, shallowRef, computed, readonly } from 'vue';
import { useI18n } from 'vue-i18n'; // +++ Add import for useI18n +++
import { workspaceEmitter } from './workspaceEvents';
// 从 websocket.types.ts 导入并重新导出 ConnectionStatus
import type { ConnectionStatus as WsConnectionStatusType, MessagePayload, WebSocketMessage, MessageHandler } from '../types/websocket.types';

// 导出类型别名，以便其他模块可以使用
export type WsConnectionStatus = WsConnectionStatusType;

/**
 * 创建并管理单个 WebSocket 连接实例。
 * 每个实例对应一个会话 (Session)。
 *
 * @param {string} sessionId - 此 WebSocket 连接关联的会话 ID (用于日志记录)。
 * @param {string} dbConnectionId - 此 WebSocket 连接关联的数据库连接 ID (用于后端识别)。
 * @param {Function} t - i18n 翻译函数，从父组件传入
 * @param {object} [options] - 可选参数对象
 * @param {boolean} [options.isResumeFlow=false] - 指示此连接是否用于 SSH 恢复流程
 * @returns 一个包含状态和方法的 WebSocket 连接管理器对象。
 */
export function createWebSocketConnectionManager(
    sessionId: string,
    dbConnectionId: string,
    t: ReturnType<typeof useI18n>['t'],
    options?: { isResumeFlow?: boolean; getIsMarkedForSuspend?: () => boolean }
) {
    // --- Instance State ---
    // 每个实例拥有独立的 WebSocket 对象、状态和消息处理器
    const ws = shallowRef<WebSocket | null>(null); // WebSocket 实例
    const isResumeFlow = options?.isResumeFlow ?? false; // 获取恢复流程标志
    const connectionStatus = ref<WsConnectionStatus>('disconnected'); // 连接状态 (使用导出的类型)
    const statusMessage = ref<string>(''); // 状态描述文本
    const isSftpReady = ref<boolean>(false); // SFTP 是否就绪
    const messageHandlers = new Map<string, Set<MessageHandler>>(); // 此实例的消息处理器注册表
    const instanceSessionId = sessionId; // 保存会话 ID 用于日志
    const instanceDbConnectionId = dbConnectionId; // 保存数据库连接 ID
    const getIsMarkedForSuspend = options?.getIsMarkedForSuspend; // +++ 获取回调函数 +++
    let reconnectAttempts = 0; // 重连尝试次数
    const maxReconnectAttempts = 5; // 最大重连次数
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null; // 重连定时器 ID
    let lastUrl = ''; // 保存上次连接的 URL
    let intentionalDisconnect = false; // 标记是否为用户主动断开


    /**
     * 安全地获取状态文本的辅助函数
     * @param {string} statusKey - i18n 键名 (例如 'connectingWs')
     * @param {Record<string, unknown>} [params] - i18n 插值参数
     * @returns {string} 翻译后的文本或键名本身 (如果翻译失败)
     */
    const getStatusText = (statusKey: string, params?: Record<string, unknown>): string => {
        try {
            const translated = t(`workspace.status.${statusKey}`, params || {});
            return translated === `workspace.status.${statusKey}` ? statusKey : translated;
        } catch (e) {
            console.warn(`[WebSocket ${instanceSessionId}] i18n 错误 (键: workspace.status.${statusKey}):`, e);
            return statusKey;
        }
    };

    /**
     * 将收到的消息分发给已注册的处理器
     * @param {string} type - 消息类型
     * @param {MessagePayload} payload - 消息负载
     * @param {WebSocketMessage} fullMessage - 完整的消息对象
     */
    const dispatchMessage = (type: string, payload: MessagePayload, fullMessage: WebSocketMessage) => {
        if (messageHandlers.has(type)) {
            messageHandlers.get(type)?.forEach(handler => {
                try {
                    handler(payload, fullMessage);
                } catch (e) {
                    console.error(`[WebSocket ${instanceSessionId}] 消息处理器错误 (类型: "${type}"):`, e);
                }
            });
        }
    };

    /**
     * 安排 WebSocket 重连尝试
     */
    const scheduleReconnect = () => {
        if (intentionalDisconnect) {
            return; // 如果是主动断开，则不重连
        }

        // +++ 检查是否标记为待挂起 +++
        if (getIsMarkedForSuspend && getIsMarkedForSuspend()) {
            statusMessage.value = getStatusText('markedForSuspendNoReconnect'); // 可以为此添加新的i18n文本
            connectionStatus.value = 'disconnected'; // 保持断开状态或设为特定状态
            return;
        }

        if (reconnectAttempts >= maxReconnectAttempts) {
            statusMessage.value = getStatusText('reconnectFailed');
            connectionStatus.value = 'error'; // 标记为错误状态
            return;
        }

        reconnectAttempts++;
        // 指数退避延迟 (例如: 2s, 4s, 8s, 16s, 32s)
        const delay = Math.pow(2, reconnectAttempts) * 1000;
        statusMessage.value = getStatusText('reconnecting', { attempt: reconnectAttempts, delay: delay / 1000 });
        connectionStatus.value = 'connecting'; // 更新状态为正在连接

        if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId); // 清除旧的定时器

        reconnectTimeoutId = setTimeout(() => {
            if (!intentionalDisconnect && lastUrl) { // 再次检查是否主动断开
                connect(lastUrl);
            }
        }, delay);
    };

    /**
     * 建立 WebSocket 连接
     * @param {string} url - WebSocket 服务器 URL
     */
    const connect = (url: string) => {
        lastUrl = url; // 保存 URL 以便重连
        intentionalDisconnect = false; // 重置主动断开标记
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId); // 清除可能存在的重连定时器
            reconnectTimeoutId = null;
        }

        // --- 修改后的检查逻辑 ---
        // 只有当 ws 实例存在，且其状态为 OPEN 或 CONNECTING，
        // 并且我们自己维护的状态也是 connected 或 connecting 时，才阻止连接。
        if (ws.value &&
            (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING) &&
            (connectionStatus.value === 'connected' || connectionStatus.value === 'connecting')
           ) {
            console.warn(`[WebSocket ${instanceSessionId}] 连接已打开或正在连接中 (readyState: ${ws.value.readyState}, status: ${connectionStatus.value})。 阻止重复连接。`);
            return;
        }

        // 处理状态不一致或旧连接未完全关闭的情况
        if (ws.value && (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)) {
             // readyState 是 OPEN/CONNECTING 但 connectionStatus 是 disconnected/error
             console.warn(`[WebSocket ${instanceSessionId}] 检测到状态不一致 (readyState: ${ws.value.readyState}, status: ${connectionStatus.value})。尝试关闭旧连接并继续...`);
             // 临时标记为主动断开，防止 onclose 触发 scheduleReconnect
             const oldWs = ws.value; // 保存旧 ws 引用
             const previousIntentionalDisconnect = intentionalDisconnect;
             intentionalDisconnect = true;
             // 在关闭前移除监听器，防止旧的 onclose 干扰
             if (oldWs) {
                 console.log(`[WebSocket ${instanceSessionId}] 移除旧连接的事件监听器...`);
                 oldWs.onopen = null;
                 oldWs.onmessage = null;
                 oldWs.onerror = null;
                 oldWs.onclose = null; // 阻止旧的 onclose 干扰
                 console.log(`[WebSocket ${instanceSessionId}] 关闭旧连接 (强制)...`);
                 oldWs.close(1000, '状态不一致，强制重连');
             }
             ws.value = null; // 清理 shallowRef 中的引用
             intentionalDisconnect = previousIntentionalDisconnect; // 恢复标记
             console.log(`[WebSocket ${instanceSessionId}] 旧连接处理完毕。`);
        } else if (ws.value && ws.value.readyState === WebSocket.CLOSING) {
             console.log(`[WebSocket ${instanceSessionId}] 检测到旧连接正在关闭 (readyState: ${ws.value.readyState})。清理引用并继续创建新连接...`);
             ws.value = null; // 清理引用，让后续逻辑创建新的
        }
        // 如果 ws.value 存在且 readyState 是 CLOSED，它应该已经在 onclose 中被设为 null

        statusMessage.value = getStatusText('connectingWs', { url });
        connectionStatus.value = 'connecting'; // 确保状态设置为 connecting
        isSftpReady.value = false; // 重置 SFTP 状态

        try {
            // --- 根据页面协议调整 WebSocket URL ---
            let secureUrl = url;
            if (window.location.protocol === 'https:') {
                secureUrl = url.replace(/^ws:/, 'wss:');
                console.log(`[WebSocket ${instanceSessionId}] HTTPS detected, upgrading WebSocket URL to: ${secureUrl}`);
            } else {
                 console.log(`[WebSocket ${instanceSessionId}] HTTP detected, using WebSocket URL: ${secureUrl}`);
            }
            // --- 使用调整后的 URL ---
            ws.value = new WebSocket(secureUrl);

            ws.value.onopen = () => {
                reconnectAttempts = 0; // 连接成功，重置尝试次数
                statusMessage.value = getStatusText('wsConnected');
                // 绑定当前客户端唯一标识
                try {
                    const cid = sessionStorage.getItem('nexus_workspace_sync_client_id');
                    if (cid) {
                        sendMessage({ type: 'workspace:bind_client', payload: { clientId: cid } });
                    }
                } catch (e) {
                    // ignore
                }
                // 状态保持 'connecting' 直到收到 ssh:connected
                if (!isResumeFlow) {
                    // 对于普通连接，发送 ssh:connect 并等待 ssh:connected 来更新状态
                    sendMessage({ type: 'ssh:connect', payload: { connectionId: instanceDbConnectionId } });
                } else {
                    // 对于恢复流程，WebSocket 打开即表示连接基础已建立
                    // 后续的 SSH_SUSPEND_RESUME_REQUEST 会完成会话的恢复
                    connectionStatus.value = 'connected';
                }
                dispatchMessage('internal:opened', {}, { type: 'internal:opened' }); // 触发内部打开事件
            };

            ws.value.onmessage = (event: MessageEvent) => {
                try {
                    const rawData = event.data;
                    const message: WebSocketMessage = JSON.parse(rawData.toString());

                    // --- 检查是否为工作区被接管踢出通知 ---
                    if (message.type === 'workspace:takeover_kickout') {
                        const targetActiveClientId = (message.payload as any)?.activeClientId;
                        workspaceEmitter.emit('workspace:takeoverKickout', { activeClientId: targetActiveClientId });
                        return;
                    }

                    // --- 更新此实例的连接状态 ---
                    if (message.type === 'ssh:connected') {
                        if (connectionStatus.value !== 'connected') {
                            connectionStatus.value = 'connected';
                            statusMessage.value = getStatusText('connected');
                        }
                    } else if (message.type === 'ssh:disconnected') {
                        if (connectionStatus.value !== 'disconnected') {
                            connectionStatus.value = 'disconnected';
                            statusMessage.value = getStatusText('disconnected', { reason: message.payload || '未知原因' });
                            isSftpReady.value = false; // SSH 断开，SFTP 也应不可用
                        }
                    } else if (message.type === 'ssh:error' || message.type === 'error') {
                        if (connectionStatus.value !== 'disconnected' && connectionStatus.value !== 'error') {
                            connectionStatus.value = 'error';
                            let errorMsg = message.payload || '未知错误';
                            if (typeof errorMsg === 'object' && errorMsg.message) errorMsg = errorMsg.message;
                            statusMessage.value = getStatusText('error', { message: errorMsg });
                            isSftpReady.value = false;
                        }
                    } else if (message.type === 'sftp_ready') {
                        console.log(`[WebSocket ${instanceSessionId}] SFTP 会话已就绪。`);
                        isSftpReady.value = true;
                    }
                    // --- 状态更新结束 ---

                    // 分发消息给此实例的处理器
                    dispatchMessage(message.type, message.payload, message);

                } catch (e) {
                    console.error(`[WebSocket ${instanceSessionId}] 处理消息时出错:`, e, '原始数据:', event.data);
                    dispatchMessage('internal:raw', event.data, { type: 'internal:raw' });
                }
            };

            ws.value.onerror = (event) => {
                if (connectionStatus.value !== 'disconnected' && connectionStatus.value !== 'error') { // Don't override if already explicitly disconnected
                    connectionStatus.value = 'error';
                    statusMessage.value = getStatusText('wsError');
                } else {
                }
                dispatchMessage('internal:error', event, { type: 'internal:error' });
                isSftpReady.value = false;
                ws.value = null; // 清理实例
                // 如果不是主动断开，尝试重连
                if (!intentionalDisconnect) {
                    scheduleReconnect();
                }
            };

            ws.value.onclose = (event) => {
                // 只有在非错误状态下才更新为 disconnected
                if (connectionStatus.value !== 'error' && connectionStatus.value !== 'disconnected') { // Avoid redundant sets or overriding 'error'
                    connectionStatus.value = 'disconnected';
                    // 如果不是主动断开，显示尝试重连的消息
                    if (!intentionalDisconnect && event.code !== 1000) { // 1000 is normal closure
                         statusMessage.value = getStatusText('wsClosedWillRetry', { code: event.code });
                    } else {
                         statusMessage.value = getStatusText('wsClosed', { code: event.code });
                    }
                }
                dispatchMessage('internal:closed', { code: event.code, reason: event.reason }, { type: 'internal:closed' });
                isSftpReady.value = false;
                ws.value = null; // 清理实例引用

                // 如果不是主动断开 (code 1000)，尝试重连
                if (!intentionalDisconnect && event.code !== 1000) { // 1000 is normal closure
                    scheduleReconnect();
                }
            };
        } catch (err) {
             connectionStatus.value = 'error';
             statusMessage.value = getStatusText('wsError');
             isSftpReady.value = false;
             ws.value = null;
        }
    };

    /**
     * 手动断开此 WebSocket 连接
     */
    const disconnect = () => {
        intentionalDisconnect = true; // 标记为主动断开
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId); // 清除重连定时器
            reconnectTimeoutId = null;
        }
        if (ws.value) {
            if (connectionStatus.value !== 'disconnected') {
                 connectionStatus.value = 'disconnected';
                 statusMessage.value = getStatusText('disconnected', { reason: '手动断开' });
            }
             ws.value.close(1000, '客户端主动断开'); // 使用标准代码和原因
             ws.value = null;
             isSftpReady.value = false;
             // 手动断开时可以考虑清除处理器，取决于是否需要重连逻辑
             // messageHandlers.clear();
        }
    };

    /**
     * 发送 WebSocket 消息
     * @param {WebSocketMessage} message - 要发送的消息对象
     */
    const sendMessage = (message: WebSocketMessage) => {
        if (ws.value && ws.value.readyState === WebSocket.OPEN) {
            try {
                const messageString = JSON.stringify(message);
                ws.value.send(messageString);
            } catch (e) {
                console.error(`[WebSocket ${instanceSessionId}] 序列化或发送消息失败:`, e, message);
            }
        } else {
            console.warn(`[WebSocket ${instanceSessionId}] 无法发送消息，连接未打开。状态: ${connectionStatus.value}, ReadyState: ${ws.value?.readyState}`);
        }
    };

    /**
     * 注册一个消息处理器
     * @param {string} type - 要监听的消息类型
     * @param {MessageHandler} handler - 处理函数
     * @returns {Function} 一个用于注销此处理器的函数
     */
    const onMessage = (type: string, handler: MessageHandler): (() => void) => {
        if (!messageHandlers.has(type)) {
            messageHandlers.set(type, new Set());
        }
        const handlersSet = messageHandlers.get(type);
        if (handlersSet) {
             handlersSet.add(handler);
             // console.debug(`[WebSocket ${instanceSessionId}] 已注册处理器: ${type}`);
        }

        // 返回注销函数
        return () => {
            const currentSet = messageHandlers.get(type);
            if (currentSet) {
                currentSet.delete(handler);
                // console.debug(`[WebSocket ${instanceSessionId}] 已注销处理器: ${type}`);
                if (currentSet.size === 0) {
                    messageHandlers.delete(type);
                }
            }
        };
    };

    // 注意：没有在此处使用 onUnmounted。
    // disconnect 方法需要由外部调用者 (例如 WorkspaceView) 在会话关闭时显式调用。

    // 返回此实例的状态和方法
    return {
        // 状态 (只读引用)
        isConnected: computed(() => connectionStatus.value === 'connected'),
        isSftpReady: readonly(isSftpReady),
        connectionStatus: readonly(connectionStatus),
        statusMessage: readonly(statusMessage),

        // 方法
        connect,
        disconnect,
        sendMessage,
        onMessage,
    };
}
