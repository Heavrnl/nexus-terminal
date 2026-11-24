import { ref, shallowRef, computed, readonly } from 'vue';
import { useI18n } from 'vue-i18n'; // +++ Add import for useI18n +++
import { workspaceEmitter } from './workspaceEvents';
import { useGlobalSyncListener } from './useGlobalSyncListener';
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
 * @param {boolean} [options.isHeadless=false] - 是否「无终端会话」（文件管理器绑定的私有 SFTP 通道）
 * @returns 一个包含状态和方法的 WebSocket 连接管理器对象。
 */
export function createWebSocketConnectionManager(
    sessionId: string,
    dbConnectionId: string,
    t: ReturnType<typeof useI18n>['t'],
    options?: {
        isResumeFlow?: boolean;
        isHeadless?: boolean;
        getIsMarkedForSuspend?: () => boolean;
        /** 若指定则首次 ssh:connect 时直接请求目标机托管代理接管对应远端会话 */
        initialRemoteSessionId?: string;
        /** 仅尝试接管已有远端会话，找不到时不自动新建 */
        attachOnly?: boolean;
    }
) {
    // --- Instance State ---
    // 每个实例拥有独立的 WebSocket 对象、状态和消息处理器
    const ws = shallowRef<WebSocket | null>(null); // WebSocket 实例
    /**
     * 「下次连接是不是恢复流程」——**一次性**的。
     *
     * 恢复流程（刷新网页后从快照恢复）不自己发 `ssh:connect`，而是由
     * `resumeSshSession()` 在 ws 打开后发 `SSH_SUSPEND_RESUME_REQUEST`。
     * 但刷新之后这个 manager 实例会一直活着：用户右键「断开 → 重新连接」时如果还以为
     * 自己是恢复流程，就什么请求都不发 —— 后端在 ws 关闭时已经 cleanup 了会话，
     * 于是终端的 `ssh:input` 全被丢掉，表现就是「重连后输入没有任何反应」。
     * 所以它只对**本次**连接有效，用过就清掉；手动重连还会显式要求 fresh（见 reconnectSession）。
     */
    let resumeFlowPending = options?.isResumeFlow ?? false;
    const connectionStatus = ref<WsConnectionStatus>('disconnected'); // 连接状态 (使用导出的类型)
    const statusMessage = ref<string>(''); // 状态描述文本
    const isSftpReady = ref<boolean>(false); // SFTP 是否就绪
    /** 当前会话托管模式（remote-agent 表示由目标机 nexus-mux 托管） */
    const hostingMode = ref<'remote-agent' | 'legacy' | undefined>(
        options?.initialRemoteSessionId ? 'remote-agent' : undefined
    );
    /** 目标机托管会话 ID（nexus-mux session_id） */
    const remoteSessionId = ref<string | undefined>(options?.initialRemoteSessionId);
    /** 目标机托管通道最近收到的字节流序号（用于断线后零闪烁 delta 续传） */
    const lastMuxSeq = ref<number>(0);
    /** 本连接管理器是否曾成功完成过一次 ssh:connected 握手 */
    let hasConnectedSuccessfullyOnce = false;
    /** 后台保活降级提示（如无 root 无法开启 systemd linger）只弹一次 */
    let persistenceWarningNotified = false;
    /** 一次性透传给下一次 ssh:connect 的目标机托管参数 */
    let pendingRemoteConnectOpts: {
        remoteSessionId?: string;
        replay?: 'full' | 'delta';
        lastSeq?: number;
        attachOnly?: boolean;
    } | null = options?.initialRemoteSessionId
        ? {
              remoteSessionId: options.initialRemoteSessionId,
              replay: 'full',
              attachOnly: options.attachOnly === true,
          }
        : null;
    /** sudo 提权失败只提示一次（每次重连都会重新发 sftp_ready，不该刷屏） */
    let sudoFallbackNotified = false;
    const messageHandlers = new Map<string, Set<MessageHandler>>(); // 此实例的消息处理器注册表
    const instanceSessionId = sessionId; // 保存会话 ID 用于日志
    const instanceDbConnectionId = dbConnectionId; // 保存数据库连接 ID
    const getIsMarkedForSuspend = options?.getIsMarkedForSuspend; // +++ 获取回调函数 +++
    let reconnectAttempts = 0; // 重连尝试次数
    /**
     * 重连等待时长：500ms 起步、指数翻倍、封顶 5s。
     *
     * 原来是 2s/4s/8s/16s/32s，而 ws 断开的绝大多数场景是网络抖动（切 WiFi、笔记本
     * 休眠唤醒、代理抽风）—— 几秒内就恢复了，按 2 的幂爬到 16s/32s，用户看到的就是
     * 「网早就好了，标签还黄着」。而且原实现第 5 次之后直接置 error 不再重试：
     * 断网超过 62 秒（2+4+8+16+32）就再也不会自己连回来，只能手动刷新。
     */
    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 5000;
    /** 强制重试的最小间隔：狂敲键盘时不要每个键都去重建一条 ws */
    const FORCED_RETRY_MIN_GAP_MS = 1200;
    let lastForcedRetryAt = 0;
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null; // 重连定时器 ID
    let lastUrl = ''; // 保存上次连接的 URL
    let intentionalDisconnect = false; // 标记是否为用户主动断开
    /**
     * 「这次重连要不要先尝试接回原会话」。
     *
     * ws 一断，后端就会把 SSH 通道转进挂起池保活（见 cleanupClientConnection）。
     * 如果重连时闷头发 `ssh:connect`，就会在同一个标签里换成一个全新的 shell，
     * 而断网前那个 shell（cwd、跑着的进程、输出历史）留在后台变成僵尸。
     * 所以非主动断开后置位，重连时先发 SSH_REATTACH_REQUEST 问一句「还能接回吗」。
     */
    let awaitingReattach = false;
    /** 接回询问的兜底定时器：后端不回（或没有挂起条目）就退回新建连接 */
    let reattachTimeoutId: ReturnType<typeof setTimeout> | null = null;
    /** 接回询问的等待时长；超时即视为接不回来，不能把用户卡在这里 */
    const REATTACH_TIMEOUT_MS = 2500;

    const clearReattachTimeout = () => {
        if (reattachTimeoutId) {
            clearTimeout(reattachTimeoutId);
            reattachTimeoutId = null;
        }
    };

    /** 发起一次 SSH 连接（支持携带目标机托管会话 ID 与增量/全量回放选项） */
    const requestFreshSshConnection = (remoteOpts?: {
        remoteSessionId?: string;
        replay?: 'full' | 'delta';
        lastSeq?: number;
        attachOnly?: boolean;
    }) => {
        clearReattachTimeout();
        awaitingReattach = false;
        const effectiveRemoteOpts = remoteOpts ?? pendingRemoteConnectOpts ?? undefined;
        pendingRemoteConnectOpts = null;
        sendMessage({
            type: 'ssh:connect',
            payload: {
                connectionId: instanceDbConnectionId,
                sessionId: instanceSessionId, // 显式传递前端当前会话 ID，保证重连时会话 ID 稳定一致
                // 无终端会话：后端据此在「接管工作区」时跳过它，不往挂起池里塞
                headless: options?.isHeadless === true,
                ...(effectiveRemoteOpts?.remoteSessionId
                    ? {
                          remoteSessionId: effectiveRemoteOpts.remoteSessionId,
                          replay: effectiveRemoteOpts.replay || 'full',
                          ...(typeof effectiveRemoteOpts.lastSeq === 'number'
                              ? { lastSeq: effectiveRemoteOpts.lastSeq }
                              : {}),
                          ...(effectiveRemoteOpts.attachOnly ? { attachOnly: true } : {}),
                      }
                    : {}),
            },
        });
    };

    /**
     * 问后端「刚才那条会话还在挂起池里吗」，在就地接回。
     * 收到 SSH_REATTACH_RESULT 由消息处理器决定成功/退回；这里只负责超时兜底。
     */
    const requestReattach = () => {
        clearReattachTimeout();
        statusMessage.value = getStatusText('reattaching');
        sendMessage({ type: 'SSH_REATTACH_REQUEST', payload: { sessionId: instanceSessionId } });
        reattachTimeoutId = setTimeout(() => {
            reattachTimeoutId = null;
            if (!awaitingReattach) return;
            console.warn(`[WebSocket ${instanceSessionId}] 就地接回超时（${REATTACH_TIMEOUT_MS}ms 未收到确认），退回新建连接。`);
            requestFreshSshConnection();
        }, REATTACH_TIMEOUT_MS);
    };


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
     * 安排 WebSocket 重连尝试（指数退避，但封顶 5s，且永不放弃）
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

        /**
         * 已经排了一次就不要再排。
         *
         * 断线时 `onerror` 与 `onclose` 会先后触发，两边都会调到这里：原来每次都
         * `clearTimeout` 再重排，等于**一次断连把退避推两格**（2s → 8s），网络抖
         * 几下就把重连间隔顶到十几秒 —— 用户感知就是「网络早就恢复了，它还在等」。
         */
        if (reconnectTimeoutId) {
            return;
        }

        reconnectAttempts++;
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );
        // 0.5 / 1 / 2 / 4 / 5 ...；整数秒不要显示成 "5.0"
        const delaySeconds = delay % 1000 === 0 ? delay / 1000 : Number((delay / 1000).toFixed(1));
        statusMessage.value = getStatusText('reconnecting', { attempt: reconnectAttempts, delay: delaySeconds });
        connectionStatus.value = 'connecting'; // 更新状态为正在连接

        reconnectTimeoutId = setTimeout(() => {
            reconnectTimeoutId = null;
            if (!intentionalDisconnect && lastUrl) { // 再次检查是否主动断开
                connect(lastUrl);
            }
        }, delay);
    };

    /**
     * 立刻重连，不等退避定时器。
     *
     * 触发源是「有理由相信网络已经恢复」的时刻：系统 `online` 事件、页面重新可见、
     * 用户在终端里敲键。这些信号比定时器可靠得多 —— 用户已经回来干活了，就说明网活了。
     *
     * @param reason 触发原因，仅用于日志
     * @returns 是否真的发起了一次重连
     */
    const retryNow = (reason: string): boolean => {
        if (intentionalDisconnect || !lastUrl) return false;
        if (connectionStatus.value === 'connected') return false;
        // 已经在建连（CONNECTING）或已经打开（OPEN）时不用管，重复 new WebSocket 只会打架
        if (
            ws.value &&
            (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)
        ) {
            return false;
        }
        const now = Date.now();
        if (now - lastForcedRetryAt < FORCED_RETRY_MIN_GAP_MS) return false;
        lastForcedRetryAt = now;
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
        console.log(`[WebSocket ${instanceSessionId}] 立即重连（触发：${reason}）`);
        connect(lastUrl);
        return true;
    };

    // --- 浏览器层面的「网络可能恢复了」信号 ---
    const onBrowserOnline = () => {
        if (retryNow('系统报告网络恢复')) return;
        // 正在建连/已连上时无需处理；但如果连上后 SSH 侧还没就绪，这里也不能催，
        // 走正常的 ssh:connect / SSH_REATTACH 流程即可。
    };
    const onVisibilityChange = () => {
        // 手机锁屏 / 切到别的 App / 合盖休眠回来：定时器可能被节流甚至冻住，
        // 回来的瞬间补一次，比等 5s 的退避快得多
        if (document.visibilityState === 'visible') retryNow('页面重新可见');
    };
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('online', onBrowserOnline);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    /** 会话关闭时摘掉全局监听器，否则开关连接几十次后会累积一堆 */
    const dispose = () => {
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            window.removeEventListener('online', onBrowserOnline);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
        clearReattachTimeout();
    };

    /**
     * 建立 WebSocket 连接
     * @param {string} url - WebSocket 服务器 URL
     * @param {{ fresh?: boolean }} [connectOptions] - `fresh: true` 强制当作一次全新 SSH 连接
     *   （用户手动「重新连接」必须这样：后端在 ws 关闭时已经清掉了会话，必须重发 ssh:connect）
     */
    const connect = (url: string, connectOptions?: { fresh?: boolean }) => {
        lastUrl = url; // 保存 URL 以便重连
        if (connectOptions?.fresh) {
            resumeFlowPending = false;
            // 用户手动「重新连接」＝明确不要旧会话，别再问后端能不能接回
            awaitingReattach = false;
            clearReattachTimeout();
            if (hasConnectedSuccessfullyOnce) {
                // 曾经连上过又被用户手动断开后要求 fresh 重连：开启全新会话，不复用旧远端 ID
                pendingRemoteConnectOpts = null;
                remoteSessionId.value = undefined;
                lastMuxSeq.value = 0;
            } else if (remoteSessionId.value) {
                // 离线占位态（此前从未连上成功）点击重试：继续尝试接回快照里记录的目标机活会话
                pendingRemoteConnectOpts = {
                    remoteSessionId: remoteSessionId.value,
                    replay: 'full',
                };
            }
        }
        // 本次连接是否仍走「恢复流程」分支（不发 ssh:connect）
        const asResumeFlow = resumeFlowPending;
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
                if (!asResumeFlow) {
                    // 非主动断开后的自动重连：
                    // 1) 若当前为目标机托管模式（remote-agent），直接按 remoteSessionId + lastMuxSeq 请求 delta 增量续传，
                    //    无需经过后端内存挂起池，屏幕零闪烁无缝衔接；
                    // 2) 传统模式走 SSH_REATTACH_REQUEST 询问后端内存挂起池。
                    if (awaitingReattach) {
                        if (hostingMode.value === 'remote-agent' && remoteSessionId.value) {
                            statusMessage.value = getStatusText('reattaching');
                            requestFreshSshConnection({
                                remoteSessionId: remoteSessionId.value,
                                replay: hasConnectedSuccessfullyOnce ? 'delta' : 'full',
                                lastSeq: hasConnectedSuccessfullyOnce ? lastMuxSeq.value : undefined,
                            });
                        } else {
                            requestReattach();
                        }
                    } else {
                        // 对于普通连接（或首次携带 initialRemoteSessionId 的跨端接管），发送 ssh:connect 并等待 ssh:connected
                        requestFreshSshConnection();
                    }
                } else {
                    // 对于恢复流程，WebSocket 打开即表示连接基础已建立
                    // 后续的 SSH_SUSPEND_RESUME_REQUEST 会完成会话的恢复
                    connectionStatus.value = 'connected';
                    // 恢复流程只对这一次连接有效，清掉标记：之后（含手动重连）一律按新的 ssh:connect 走
                    resumeFlowPending = false;
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

                    // --- 检查是否为双端实时同步完成通知 ---
                    if (message.type === 'sync:completed' || message.type === 'sync:refreshed') {
                        console.log('[WebSocket] 收到后台同步完成通知，通过全局防抖通道统一刷新各模块 Store...');
                        useGlobalSyncListener().refreshNow();
                        return;
                    }

                    // --- 更新此实例的连接状态 ---
                    if (message.type === 'ssh:connected') {
                        clearReattachTimeout();
                        awaitingReattach = false;
                        hasConnectedSuccessfullyOnce = true;
                        const connectedPayload = message.payload as {
                            hostingMode?: 'remote-agent' | 'legacy';
                            remoteSessionId?: string;
                            currentSeq?: number;
                            persistenceWarning?: string;
                        } | undefined;
                        if (connectedPayload?.hostingMode === 'remote-agent' || connectedPayload?.hostingMode === 'legacy') {
                            hostingMode.value = connectedPayload.hostingMode;
                        }
                        if (connectedPayload?.remoteSessionId) {
                            remoteSessionId.value = connectedPayload.remoteSessionId;
                        }
                        if (typeof connectedPayload?.currentSeq === 'number' && connectedPayload.currentSeq >= 0) {
                            lastMuxSeq.value = connectedPayload.currentSeq;
                        }
                        if (connectedPayload?.persistenceWarning && !persistenceWarningNotified) {
                            persistenceWarningNotified = true;
                            const warnMsg = String(connectedPayload.persistenceWarning);
                            import('../stores/uiNotifications.store')
                                .then(({ useUiNotificationsStore }) => {
                                    useUiNotificationsStore().showWarning(warnMsg);
                                })
                                .catch(() => {});
                        }
                        if (connectionStatus.value !== 'connected') {
                            connectionStatus.value = 'connected';
                            statusMessage.value = getStatusText('connected');
                        }
                    } else if (message.type === 'ssh:output') {
                        if (typeof (message as any).seq === 'number' && (message as any).seq > lastMuxSeq.value) {
                            lastMuxSeq.value = (message as any).seq;
                        }
                    } else if (message.type === 'ssh:detached') {
                        // 目标机托管会话被另一客户端直接抢占脱离：停止自动重连，避免两端反复互相踢出
                        intentionalDisconnect = true;
                        awaitingReattach = false;
                        clearReattachTimeout();
                        if (reconnectTimeoutId) {
                            clearTimeout(reconnectTimeoutId);
                            reconnectTimeoutId = null;
                        }
                        connectionStatus.value = 'disconnected';
                        statusMessage.value = getStatusText('detachedByOtherClient');
                        isSftpReady.value = false;
                    } else if (message.type === 'SSH_REATTACH_RESULT') {
                        const reattachResult = message.payload as { sessionId?: string; success?: boolean; reason?: string } | undefined;
                        if (reattachResult?.success) {
                            clearReattachTimeout();
                            awaitingReattach = false;
                            console.log(`[WebSocket ${instanceSessionId}] 已就地接回原会话（保留 cwd / 运行中的进程 / 历史输出）。`);
                        } else {
                            // 没有可接回的挂起条目（远端已断开、或用户主动挂起的） → 老老实实新建一条
                            console.log(`[WebSocket ${instanceSessionId}] 就地接回未命中（${reattachResult?.reason || 'unknown'}），改为新建 SSH 连接。`);
                            requestFreshSshConnection();
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
                        // 开了 SFTP sudo 但提权失败时，后端会退回普通 SFTP ——
                        // 不提示的话用户只会觉得"明明开了提权，怎么还是没权限"。
                        const sudoFallback = (message.payload as any)?.sudoFallback;
                        if (sudoFallback && !sudoFallbackNotified) {
                            sudoFallbackNotified = true;
                            const reason = String(sudoFallback);
                            console.warn(`[WebSocket ${instanceSessionId}] SFTP sudo 提权失败，已退回普通权限：${reason}`);
                            import('../stores/uiNotifications.store')
                                .then(({ useUiNotificationsStore }) => {
                                    useUiNotificationsStore().showWarning(
                                        t('fileManager.sftpSudoFallback', { reason })
                                    );
                                })
                                .catch(() => { /* 拿不到通知 store 时至少后端日志里有 */ });
                        }
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
                    // 紧随其后的 onclose 也会调 scheduleReconnect（那边有去重，不会重复排队）。
                    // 这里先置位，是为了覆盖「只 error 不 close」的极端情况下也能接回原会话，
                    // 否则重连会闷头发 ssh:connect 换成一个全新的 shell。
                    awaitingReattach = true;
                    scheduleReconnect();
                }
            };

            ws.value.onclose = (event) => {
                // 只有在既非错误、也非已断开、又不在重连排期中时才更新为 disconnected。
                // 'connecting' 要把「第 N 次重试，Ns 后」的文案保留住 —— 否则 onerror 排好重连后
                // onclose 又把状态冲成「已关闭」，状态灯会黄→灰→黄地闪。
                if (
                    connectionStatus.value !== 'error' &&
                    connectionStatus.value !== 'disconnected' &&
                    connectionStatus.value !== 'connecting'
                ) { // Avoid redundant sets or overriding 'error'
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
                clearReattachTimeout();

                // 如果不是主动断开 (code 1000)，尝试重连
                if (!intentionalDisconnect && event.code !== 1000) { // 1000 is normal closure
                    // 后端此刻正把这条 SSH 通道转进挂起池；重连时优先接回它
                    awaitingReattach = true;
                    scheduleReconnect();
                }
            };
        } catch (err) {
             connectionStatus.value = 'error';
             statusMessage.value = getStatusText('wsError');
             isSftpReady.value = false;
             ws.value = null;
             // 构造阶段同步抛错（URL 非法、浏览器拒绝建连）时不会有 onerror / onclose，
             // 不在这里补一次重连就再也没人管这个会话了 —— 状态灯会永远停在出错。
             if (!intentionalDisconnect) {
                 awaitingReattach = true;
                 scheduleReconnect();
             }
        }
    };

    /**
     * 手动断开此 WebSocket 连接
     * @param disconnectOptions.explicitClose 为 true 表示用户显式关闭标签页（目标机托管模式应发 KILL 终止进程树）；
     *   默认 false 表示普通断开/清场/页面卸载（目标机托管模式仅优雅 DETACH 保持远端进程存活）。
     */
    const disconnect = (disconnectOptions?: { explicitClose?: boolean }) => {
        intentionalDisconnect = true; // 标记为主动断开
        awaitingReattach = false; // 主动断开不接回
        clearReattachTimeout();
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId); // 清除重连定时器
            reconnectTimeoutId = null;
        }
        if (ws.value) {
            if (connectionStatus.value !== 'disconnected') {
                 connectionStatus.value = 'disconnected';
                 statusMessage.value = getStatusText('disconnected', { reason: '手动断开' });
            }
            const closeReason = disconnectOptions?.explicitClose
                ? 'EXPLICIT_CLOSE_TERMINATE'
                : 'DETACH_KEEP_REMOTE';
            ws.value.close(1000, closeReason); // 使用标准代码和明确意图原因
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
        hostingMode: readonly(hostingMode),
        remoteSessionId: readonly(remoteSessionId),
        lastMuxSeq: readonly(lastMuxSeq),

        // 方法
        connect,
        disconnect,
        sendMessage,
        onMessage,
        /** 跳过退避等待，立刻重连（网络恢复 / 页面重新可见 / 用户开始敲键盘时调用） */
        retryNow,
        /** 会话关闭时调用：摘掉全局监听器与所有定时器 */
        dispose,
    };
}
