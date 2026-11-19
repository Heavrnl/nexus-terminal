import { ref, readonly, toRaw, type Ref, ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessions as globalSessionsRef, activeSessionId as activeSessionIdRef } from '../stores/session/state'; // +++ 导入全局 sessions state +++
// import { useWebSocketConnection } from './useWebSocketConnection'; // 移除全局导入
import type { Terminal } from 'xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'; // *** 移除 ISearchResult 导入 ***
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';
import { useTerminalHighlightStore } from '../stores/terminal-highlight.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useLayoutStore, getTerminalPaneIdsInLayout } from '../stores/layout.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useWorkspaceEventEmitter } from './workspaceEvents';
import {
    scanSearchBuffer,
    type TerminalSearchMatch,
    type TerminalSearchOptions,
} from '../utils/terminalSearch';
import { createTerminalStreamFilter, type TerminalStreamFilter } from '../utils/terminal-stream';
import { writeTerminalReplay } from '../utils/terminalReplaySilence';

// 定义与 WebSocket 相关的依赖接口
export interface SshTerminalDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: (payload: any, fullMessage?: WebSocketMessage) => void) => () => void;
    isConnected: ComputedRef<boolean>;
    /**
     * 跳过退避定时器立刻重连。
     *
     * 断线后 ws 要等退避定时器才重连（最长 5s，以前的实现能到 32s）。用户此刻敲键盘
     * 就说明人在、网也活了，没必要继续等 —— 敲下第一个键就去连，比盯着黄灯等快得多。
     */
    retryConnectionNow?: () => void;
}

// 多终端分屏实例状态
export interface PaneTerminalInstance {
    paneId: string;
    terminal: Terminal;
    searchAddon: SearchAddon | null;
    serializeAddon?: SerializeAddon | null;
    isReady: boolean;
}

/**
 * 会话重连成功的顶部浮窗通知聚合器。
 *
 * 手机息屏亮屏或网络抖动恢复时，多个会话会在短时间内陆续收到 `ssh:connected`。
 * 不再往终端屏幕内写入绿色恢复提示（会破坏 TUI 画面与光标并污染快照），
 * 统一改为顶部浮窗通知，并在短窗口内聚合多会话同时恢复事件，避免刷屏。
 */
const RECONNECT_TOAST_AGGREGATE_MS = 250;
let reconnectToastTimer: ReturnType<typeof setTimeout> | null = null;
const pendingReconnectEntries = new Map<string, { name: string; isActive: boolean; message: string }>();

const enqueueReconnectedToast = (sid: string, name: string, isActive: boolean, reconnectedText: string) => {
    pendingReconnectEntries.set(sid, { name, isActive, message: reconnectedText });
    if (reconnectToastTimer) return;
    reconnectToastTimer = setTimeout(() => {
        reconnectToastTimer = null;
        const entries = Array.from(pendingReconnectEntries.values());
        pendingReconnectEntries.clear();
        if (entries.length === 0) return;

        // 优先展示当前正在查看的活动会话名称
        entries.sort((a, b) => Number(b.isActive) - Number(a.isActive));
        const primary = entries[0];
        const toastText = entries.length === 1
            ? (primary.name ? `${primary.name} · ${primary.message}` : primary.message)
            : (primary.name ? `${primary.name} (+${entries.length - 1}) · ${primary.message}` : `${primary.message} (${entries.length})`);

        try {
            useUiNotificationsStore().showSuccess(toastText);
        } catch (err) {
            console.warn('[SSH终端模块] 投递重连成功浮窗通知失败:', err);
        }
    }, RECONNECT_TOAST_AGGREGATE_MS);
};

/**
 * 创建一个 SSH 终端管理器实例
 * @param sessionId 会话唯一标识符
 * @param wsDeps WebSocket 依赖对象
 * @param t i18n 翻译函数，从父组件传入
 * @returns SSH 终端管理器实例
 */
export function createSshTerminalManager(sessionId: string, wsDeps: SshTerminalDependencies, t: ReturnType<typeof useI18n>['t']) { // +++ Update type of t +++
    // 使用依赖注入的 WebSocket 函数
    const { sendMessage, onMessage, isConnected, retryConnectionNow } = wsDeps;
    const highlightStore = useTerminalHighlightStore();

    // 多终端分屏实例 Map (支持同一连接挂载多个终端窗口)
    const terminalPanes = ref(new Map<string, PaneTerminalInstance>());
    const primaryPaneId = ref<string | null>(null);

    const terminalInstance = ref<Terminal | null>(null);
    const searchAddon = ref<SearchAddon | null>(null); // Keep searchAddon ref
    const serializeAddon = ref<SerializeAddon | null>(null); // 保存 SerializeAddon 实例

    /**
     * 快照里终端内容的行数上限（安全阀，不是功能限制）。
     *
     * 默认 scrollback 是 5000 行，实测全量序列化约 40ms —— 不会产生长任务，
     * 所以这里**完整保存**，不截断用户的终端历史。
     *
     * 但 scrollback 设置允许用户填更大的值（0 表示不限），buffer 无限增长时
     * addon-serialize 的逐 cell 成本会线性上升（2 万行约 160ms，5 万行约 400ms），
     * 每次自动保存都卡一下。所以留一个 2 万行的上限兜底：正常使用永远碰不到，
     * 只有把 scrollback 调到极端值时才生效。
     */
    const SNAPSHOT_MAX_LINES = 20000;

    /** 同一次采集内的序列化结果缓存（微任务清除，不会返回过期内容） */
    let panesSerializeCache: Record<string, string> | null = null;
    let panesCacheClearScheduled = false;
    /** 按 paneId 维护的终端内容脏版本号与序列化结果缓存，避免多标签页下未变动终端反复全量 serialize() */
    const paneDirtyVersions = new Map<string, number>();
    const paneSerializedMemo = new Map<string, { version: number; cols: number; rows: number; text: string }>();
    const paneWriteParsedDisposables = new Map<string, { dispose: () => void }>();
    const markPaneDirty = (paneId: string) => {
        paneDirtyVersions.set(paneId, (paneDirtyVersions.get(paneId) || 0) + 1);
    };
    // Removed search result state refs
    // const searchResultCount = ref(0);
    // const currentSearchResultIndex = ref(-1);
    const terminalOutputBuffer = ref<(string | Uint8Array)[]>([]); // 缓冲 WebSocket 消息直到终端准备好
    const isSshConnected = ref(false); // 跟踪 SSH 连接状态
    const hasConnectedBefore = ref(false); // 跟踪是否曾经连接过（用于识别重连事件）

    /**
     * 输出写入过滤器（每个终端一份）。
     *
     * PTY 的分块边界是随机的，一条 OSC 8 超链接 / 一段 24bit SGR / 一个中文字符
     * 都可能被切成两半。逐块单独做高亮，会把半截的控制序列当纯文本、往中间插 SGR，
     * 终端把序列提前截断 → 画面上多出肉眼可见的地址/参数文本，光标位置也偏，
     * 之后 TUI 每帧按错位的行数重绘，就表现为「偶尔重复出几行」。
     * 过滤器把跨块的尾巴攒到下一块，保证高亮只作用于纯文本。
     */
    const paneWriteFilters = new Map<string, TerminalStreamFilter>();
    const createWriteFilter = () =>
        createTerminalStreamFilter({
            highlight: (text) => highlightStore.highlight(text) as string,
            // 退出备用屏后补 SGR/清屏（见 sanitizeTuiTransition 注释）
            sanitize: (text) => sanitizeTuiTransition(text),
        });
    const mainWriteFilter = createWriteFilter();
    const getPaneWriteFilter = (paneId: string): TerminalStreamFilter => {
        let filter = paneWriteFilters.get(paneId);
        if (!filter) {
            filter = createWriteFilter();
            paneWriteFilters.set(paneId, filter);
        }
        return filter;
    };

    // 终端数据流防抖同步至云端工作区 (输出停歇后触发；高频刷屏时不再每包 clearTimeout/setTimeout 重建)
    let terminalSyncTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTerminalOutputAt = 0;
    let scheduledSyncDelayMs = 1500;
    const scheduleTerminalSync = (delayMs: number = 1500) => {
        lastTerminalOutputAt = Date.now();
        scheduledSyncDelayMs = delayMs;
        if (terminalSyncTimer) return;
        const arm = (waitMs: number) => {
            terminalSyncTimer = setTimeout(() => {
                terminalSyncTimer = null;
                const remaining = scheduledSyncDelayMs - (Date.now() - lastTerminalOutputAt);
                if (remaining > 50) {
                    arm(remaining);
                    return;
                }
                try {
                    const workspaceSyncStore = useWorkspaceSyncStore();
                    if (workspaceSyncStore.syncEnabled && !workspaceSyncStore.isRestoring && !workspaceSyncStore.isTakenOver) {
                        workspaceSyncStore.triggerDebouncedSave(0);
                    }
                } catch {
                    // Pinia 上下文未就绪时安全忽略
                }
            }, waitMs);
        };
        arm(delayMs);
    };

    // 辅助函数：获取终端消息文本
    const getTerminalText = (key: string, params?: Record<string, any>): string => {
        // 确保 i18n key 存在，否则返回原始 key
        const translationKey = `workspace.terminal.${key}`;
        const translated = t(translationKey, params || {});
        return translated === translationKey ? key : translated;
    };

    // --- 终端事件处理 ---

    const handleTerminalReady = (payload: { sessionId?: string; terminal: Terminal; searchAddon: SearchAddon | null; serializeAddon?: SerializeAddon | null; paneId?: string }) => {
        const { terminal: term, searchAddon: addon, serializeAddon: sAddon, paneId } = payload;
        const effectivePaneId = paneId || 'primary';
        const activeSid = payload.sessionId || sessionId;
        console.log(`[会话 ${activeSid}][SSH终端模块] 终端实例已就绪 (paneId: ${effectivePaneId})。SearchAddon: ${addon ? '存在' : '不存在'}, SerializeAddon: ${sAddon ? '存在' : '不存在'}`);

        const entry: PaneTerminalInstance = {
            paneId: effectivePaneId,
            terminal: term,
            searchAddon: addon,
            serializeAddon: sAddon || null,
            isReady: false
        };
        terminalPanes.value.set(effectivePaneId, entry);
        markPaneDirty(effectivePaneId);
        // 监听 xterm 解析完成事件推进脏版本：确保任意路径写入/清屏都能自动失效序列化缓存
        const prevDisposable = paneWriteParsedDisposables.get(effectivePaneId);
        if (prevDisposable) {
            try { prevDisposable.dispose(); } catch {}
        }
        if (typeof term.onWriteParsed === 'function') {
            paneWriteParsedDisposables.set(
                effectivePaneId,
                term.onWriteParsed(() => markPaneDirty(effectivePaneId))
            );
        }

        // 兜底：旧快照可能把"备用屏（TUI）"状态一起存了下来。
        // 这里先强制切回主屏，避免刷新后 Ctrl+C 退出 TUI 时回到一个空的备用屏、整块变黑。
        restoreMainScreenBuffer(term);

        const currentSessionState = globalSessionsRef.value.get(activeSid) ?? globalSessionsRef.value.get(sessionId);

        // --- 主终端锁定 ---
        // 优先取本会话专属布局树的终端顺序（即使本会话此刻在后台静默分批挂载，也能拿到自己的树）；
        // 其次才回退到当前活动布局树，且必须校验树里确实包含 effectivePaneId，
        // 避免后台挂载非活动会话时把「前台活动会话的 paneId」误锁成自己的主终端。
        let treeTerminalIds: string[] = [];
        try {
            const layoutStore = useLayoutStore();
            const ownOrder = layoutStore.getSessionTerminalPaneOrder(activeSid);
            if (ownOrder.length > 0 && ownOrder.includes(effectivePaneId)) {
                treeTerminalIds = ownOrder;
            } else {
                const activeTreeIds = getTerminalPaneIdsInLayout(layoutStore.getActiveLayoutTree());
                if (activeTreeIds.includes(effectivePaneId)) {
                    treeTerminalIds = activeTreeIds;
                }
            }
        } catch {
            // 忽略 store 异常
        }

        if (!primaryPaneId.value) {
            const recorded = (currentSessionState as any)?.primaryTerminalPaneId as string | undefined;
            primaryPaneId.value = (recorded && treeTerminalIds.includes(recorded) ? recorded : undefined)
                ?? treeTerminalIds[0]
                ?? effectivePaneId;
            if (currentSessionState) {
                (currentSessionState as any).primaryTerminalPaneId = primaryPaneId.value;
            }
            console.log(`[会话 ${sessionId}][SSH终端模块] 确定主终端 primaryPaneId 为: ${primaryPaneId.value} (当前就绪终端: ${effectivePaneId})`);
        } else if (treeTerminalIds.length > 0 && !treeTerminalIds.includes(primaryPaneId.value)) {
            // 已锁定的主终端在当前布局树里根本不存在了
            // （会话从 localStorage/后端恢复后布局树会重新生成 ID，或用户改过布局）
            console.warn(`[会话 ${sessionId}][SSH终端模块] 主终端 ${primaryPaneId.value} 已不在当前布局树中，重新选定为 ${effectivePaneId}`);
            primaryPaneId.value = effectivePaneId;
            if (currentSessionState) {
                (currentSessionState as any).primaryTerminalPaneId = primaryPaneId.value;
            }
        }

        // 如果是主终端，写入历史缓冲
        if (effectivePaneId === primaryPaneId.value) {
            terminalInstance.value = term;
            searchAddon.value = addon;
            serializeAddon.value = sAddon || null;

            // 1. 处理 SessionState.pendingOutput (来自 SSH_OUTPUT_CACHED_CHUNK 的早期数据)
            if (currentSessionState && currentSessionState.pendingOutput && currentSessionState.pendingOutput.length > 0) {
                currentSessionState.pendingOutput.forEach(data => {
                    // 回放数据走静默回放通道，既保留原始字节排版语义，又防止任何历史查询序列触发回包
                    writeTerminalReplay(term as any, mainWriteFilter.write(data));
                });
                const tail = mainWriteFilter.flush();
                if (tail) {
                    writeTerminalReplay(term as any, tail);
                }
                currentSessionState.pendingOutput = []; // 清空
                if (currentSessionState.isResuming) {
                    currentSessionState.isResuming = false;
                }
            }

            // 2. 将此管理器内部缓冲的输出 (terminalOutputBuffer, 来自 ssh:output) 写入终端
            if (terminalOutputBuffer.value.length > 0) {
                terminalOutputBuffer.value.forEach(data => {
                    term.write(mainWriteFilter.write(data));
                });
                terminalOutputBuffer.value = []; // 清空内部缓冲区
            }
        } else {
            // 如果是分屏副终端，检查是否从云端同步中缓存了历史屏幕缓冲
            // 快照里存的是 pane#0/pane#1 这类稳定序号键（会话树每次刷新都会重编 paneId），
            // 先按序号换算，再退回按 paneId 直接取。
            const paneBufMap = (currentSessionState as any)?.lastTerminalPanesBuffer;
            let cachedPaneBuffer = paneBufMap?.[effectivePaneId];
            const usedKeys: string[] = cachedPaneBuffer ? [effectivePaneId] : [];
            if (!cachedPaneBuffer && paneBufMap) {
                try {
                    const layoutStore = useLayoutStore();
                    const order = layoutStore.getSessionTerminalPaneOrder(sessionId);
                    const idx = order.indexOf(effectivePaneId);
                    if (idx >= 0) {
                        cachedPaneBuffer = paneBufMap[`pane#${idx}`];
                        if (cachedPaneBuffer) usedKeys.push(`pane#${idx}`);
                    }
                } catch {
                    /* 忽略 store 异常 */
                }
            }
            if (cachedPaneBuffer && typeof cachedPaneBuffer === 'string' && cachedPaneBuffer.length > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] 正在为分屏副终端 ${effectivePaneId} 回放云端同步历史缓冲 (长度: ${cachedPaneBuffer.length})...`);
                const paneFilter = getPaneWriteFilter(effectivePaneId);
                writeTerminalReplay(term as any, paneFilter.write(cachedPaneBuffer.replace(/(\r\n)+$/, '')) + paneFilter.flush());
                // 消费掉这段缓存：workspaceSync 里还有一条"panes 已就绪时立即回放"的路径，
                // 不清掉会写第二遍，表现为刷新后终端里多出好几个重复的提示符。
                usedKeys.forEach((k) => {
                    try {
                        delete paneBufMap[k];
                    } catch {
                        /* noop */
                    }
                });
            }

            // 向后端请求开辟/复用独立的 Shell 通道（附带稳定先序序号 paneIndex，刷新重编 paneId 后仍可精准复用保活通道）
            let paneIndex: number | undefined = undefined;
            try {
                const layoutStore = useLayoutStore();
                const idx = layoutStore.getSessionTerminalPaneOrder(activeSid).indexOf(effectivePaneId);
                if (idx >= 0) paneIndex = idx;
            } catch {}
            console.log(`[会话 ${activeSid}][SSH终端模块] 请求后端为分屏终端 ${effectivePaneId} (paneIndex=${paneIndex ?? 'n/a'}) 打开/复用独立 Shell 通道...`);
            sendMessage({
                type: 'ssh:pane_open',
                sessionId: activeSid,
                payload: {
                    sessionId: activeSid,
                    paneId: effectivePaneId,
                    paneIndex,
                    cols: term.cols || 80,
                    rows: term.rows || 24,
                }
            });
        }
    };

    /**
     * 校验外部传入的 paneId 是否真的属于本会话。
     *
     * 命令输入栏 / 快捷指令传的是全局 layoutStore.activeTerminalPaneId，
     * 会话切换瞬间它可能还停留在别的会话的 paneId 上。若原样发给后端，
     * handleSshPaneInput 找不到 pane 会直接 return —— 数据静默丢失，
     * 用户看到的就是"新会话里发不出命令，点一下终端才好"。
     */
    const resolvePaneIdForSession = (paneId?: string): string | undefined => {
        if (paneId && !terminalPanes.value.has(paneId)) {
            console.warn(`[会话 ${sessionId}][SSH终端模块] paneId ${paneId} 不属于本会话，回退到主终端 ${primaryPaneId.value ?? '(none)'}`);
            return undefined;
        }
        return paneId;
    };

    const handleTerminalData = (data: string, paneId?: string) => {
        // 链路没通时这次输入注定发不出去（sendMessage 只会打一句 warn），
        // 但用户敲键本身是个强信号：人在，网大概也回来了 —— 顺手把重连提前。
        if (!isConnected.value) {
            retryConnectionNow?.();
        }
        const targetPaneId = resolvePaneIdForSession(paneId) || primaryPaneId.value;
        if (targetPaneId && targetPaneId !== primaryPaneId.value) {
            // 分屏副终端走专属通道输入
            sendMessage({ type: 'ssh:pane_input', sessionId, payload: { sessionId, paneId: targetPaneId, data } });
        } else {
            // 主终端走标准主流输入
            sendMessage({ type: 'ssh:input', sessionId, payload: { sessionId, data } });
        }
    };

    const handleTerminalResize = (dimensions: { cols: number; rows: number }, paneId?: string) => {
        if (!isConnected.value) {
            console.log(`[SSH ${sessionId}] WebSocket not connected, skipping resize.`);
            return;
        }
        const targetPaneId = resolvePaneIdForSession(paneId) || primaryPaneId.value;
        if (targetPaneId && targetPaneId !== primaryPaneId.value) {
            sendMessage({ type: 'ssh:pane_resize', sessionId, payload: { sessionId, paneId: targetPaneId, cols: dimensions.cols, rows: dimensions.rows } });
        } else {
            sendMessage({ type: 'ssh:resize', sessionId, payload: { sessionId, ...dimensions } });
        }
    };

    const handleTerminalDispose = (paneId?: string) => {
        if (!paneId) return;
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到终端注销请求: ${paneId}`);
        if (terminalPanes.value.has(paneId)) {
            terminalPanes.value.delete(paneId);
            paneWriteFilters.delete(paneId);
            paneDirtyVersions.delete(paneId);
            paneSerializedMemo.delete(paneId);
            const wpDisp = paneWriteParsedDisposables.get(paneId);
            if (wpDisp) {
                try { wpDisp.dispose(); } catch {}
                paneWriteParsedDisposables.delete(paneId);
            }
            if (paneId !== primaryPaneId.value) {
                sendMessage({ type: 'ssh:pane_close', sessionId, payload: { sessionId, paneId } });
            } else {
                // 如果主终端注销，但还有其他分屏终端，接替成为新主终端
                const remaining = Array.from(terminalPanes.value.values());
                if (remaining.length > 0) {
                    const nextPrimary = remaining[0];
                    primaryPaneId.value = nextPrimary.paneId;
                    terminalInstance.value = nextPrimary.terminal;
                    searchAddon.value = nextPrimary.searchAddon;
                    serializeAddon.value = nextPrimary.serializeAddon || null;
                    console.log(`[会话 ${sessionId}][SSH终端模块] 原主终端注销，推选 ${nextPrimary.paneId} 为新主终端`);
                } else {
                    primaryPaneId.value = null;
                    terminalInstance.value = null;
                    searchAddon.value = null;
                    serializeAddon.value = null;
                }
            }
        }
    };

    // --- WebSocket 消息处理 ---

    /**
     * 退出全屏 TUI（备用屏）时，程序通常先设置背景色再清屏，
     * `\e[2J` 就会用那块黑色填满整屏，背景图被一整块黑盖住。
     *
     * 这里在 `\e[?1049l` / `\e[?47l`（退出备用屏）之后立刻注入 SGR 重置，
     * 保证紧接着的清屏用的是默认背景（配合 Terminal 里的透明 theme）。
     */
    const sanitizeTuiTransition = <T extends string | Uint8Array>(raw: T): T => {
        if (typeof raw !== 'string' || !raw || raw.indexOf('\x1b[?') === -1) return raw;
        // 退出备用屏后：重置 SGR → 主动清屏 → 光标归位。
        // 主动清屏是为了覆盖"TUI 先设黑色背景、再清屏、最后才发 1049l"这种顺序，
        // 否则那块黑色会留在屏幕上（用户看到的"满屏黑"）。
        return raw.replace(/\x1b\[\?(?:1049|47)l/g, (m) => `${m}\x1b[0m\x1b[2J\x1b[H`) as T;
    };

    /**
     * 让处于全屏 TUI 的终端整屏重绘。
     *
     * TUI（btop/vim）只在收到 SIGWINCH（PTY 尺寸变化）时才重绘；
     * 刷新后前端只拿到增量数据，画面就会残缺。这里制造一次 cols+1 → cols 的尺寸抖动，
     * 后端 pty 收到新尺寸后会给 TUI 发 SIGWINCH，它就会整屏重画。
     */
    const forceTuiRedraw = (term: Terminal | null | undefined, delay = 400) => {
        if (!term) return;
        const run = () => {
            try {
                if (term.buffer.active.type !== 'alternate') return;
                const { cols, rows } = term;
                if (cols < 3) return;
                console.log(`[会话 ${sessionId}][SSH终端模块] 检测到全屏 TUI，触发尺寸抖动以强制整屏重绘`);
                // 用 +1 而不是 -1：减一可能让 TUI 判定"终端太小"（btop 会直接报 width too small）
                term.resize(cols + 1, rows);
                setTimeout(() => {
                    try { term.resize(cols, rows); } catch { /* noop */ }
                }, 150);
            } catch {
                /* noop */
            }
        };
        if (delay > 0) setTimeout(run, delay);
        else run();
    };

    /**
     * 把终端从备用屏（全屏 TUI）强行切回主屏。
     *
     * 为什么需要：备用屏是靠程序自己发 `\e[?1049l` 退出的。一旦程序没机会发
     * （dd 断流、screen/btop 被 kill、SSH 通道先断），xterm 就会永远停在备用屏上。
     * 备用屏**没有回滚历史**（`buffer.active.baseY` 恒为 0），表现正是：
     * 右侧滚动条消失、鼠标滚轮/拖动都滚不上去，而主屏里原有历史其实还在，只是被压住。
     *
     * 所以只要确认"通道已经死了、不可能再有程序接管屏幕"，就补一发 1049l：
     * 画面回到主屏，滚动条和历史一起回来。
     *
     * @returns 是否真的做过切换（调用方可据此决定是否要补清屏/补提示）
     */
    const restoreMainScreenBuffer = (term: Terminal | null | undefined): boolean => {
        if (!term) return false;
        try {
            if (term.buffer.active.type !== 'alternate') return false;
            // 只退备用屏 + 重置 SGR：故意不带 `\e[2J`，
            // 清屏会把手动恢复出来的主屏历史内容抹掉，那不是我们要的。
            term.write('\x1b[?1049l\x1b[0m');
            return true;
        } catch {
            return false;
        }
    };

    const handleSshOutput = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        let outputData = payload;
        // 检查是否为 Base64 编码 (需要后端配合发送 encoding 字段)
        if (message?.encoding === 'base64' && typeof outputData === 'string') {
            try {
                // 使用更安全的Base64解码方式，保证中文字符正确解码
                const base64String = outputData;
                // 先用atob获取二进制字符串
                const binaryString = atob(base64String);
                // 创建Uint8Array存储二进制数据
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                // 直接使用原始二进制数据作为 Uint8Array 写入终端，避免编码转换问题
                outputData = bytes;
            } catch (e) {
                console.error(`[会话 ${sessionId}][SSH终端模块] Base64 解码失败:`, e, '原始数据:', message.payload);
                outputData = `\r\n[解码错误: ${e}]\r\n`; // 在终端显示解码错误
            }
        }
        // 如果不是 base64 或解码失败，确保它是字符串
        else if (typeof outputData !== 'string') {
             console.warn(`[会话 ${sessionId}][SSH终端模块] 收到非字符串 ssh:output payload:`, outputData);
             try {
                 outputData = JSON.stringify(outputData); // 尝试序列化
             } catch {
                 outputData = String(outputData); // 最后手段：强制转字符串
             }
        }

        // 由于直接使用原始二进制数据，不再需要过滤 OSC 184 序列
        // 相关代码已移除

        // --- 添加前端日志 ---
        // console.log(`[会话 ${sessionId}][SSH前端] 收到 ssh:output 原始 payload (解码前):`, payload);
        // console.log(`[会话 ${sessionId}][SSH前端] 解码后的数据 (尝试写入):`, outputData);
        // --------------------

        if (terminalInstance.value) {
            terminalInstance.value.write(mainWriteFilter.write(outputData));
            // 终端数据输出写入后安排 1.5s 防抖同步至云端工作区
            scheduleTerminalSync(2500);
        } else {
            // 如果终端还没准备好，先缓冲输出
            terminalOutputBuffer.value.push(outputData);
        }
    };

    const handleSshConnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        isSshConnected.value = true; // 更新状态

        // 刷新/重连后，服务端如果还停在 btop 这类全屏 TUI 里，
        // 前端只会收到"增量"重绘数据，画面就是残缺的（缺面板、错位）。
        // TUI 只在收到 SIGWINCH 时才会整屏重绘，这里制造一次尺寸抖动触发它。
        // 注意：要覆盖**所有** pane，不能只处理主终端 —— 用户反馈第一个终端能自动矫正、
        // 其他终端不行，就是因为这里以前只拿了 terminalInstance（主终端）。
        setTimeout(() => {
            for (const [, entry] of terminalPanes.value.entries()) {
                forceTuiRedraw(entry.terminal, 0);
            }
        }, 800);

        // 主连接就绪，立刻为所有已挂载的分屏副终端打开独立 Shell 通道
        if (terminalPanes.value.size > 1) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 主会话已连接，正在为 ${terminalPanes.value.size - 1} 个分屏副终端打开独立 Shell...`);
            for (const [pId, entry] of terminalPanes.value.entries()) {
                if (pId !== primaryPaneId.value) {
                    let paneIndex: number | undefined = undefined;
                    try {
                        const layoutStore = useLayoutStore();
                        const idx = layoutStore.getSessionTerminalPaneOrder(incomingSessionId || sessionId).indexOf(pId);
                        if (idx >= 0) paneIndex = idx;
                    } catch {}
                    sendMessage({
                        type: 'ssh:pane_open',
                        sessionId,
                        payload: {
                            sessionId,
                            paneId: pId,
                            paneIndex,
                            cols: entry.terminal.cols || 80,
                            rows: entry.terminal.rows || 24,
                        }
                    });
                }
            }
        }
        // 连接成功后聚焦终端 (仅桌面端自动聚焦，避免手机端自动弹出输入法)
        const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (!isMobileDevice) {
            terminalInstance.value?.focus();
        }

        const isReconnected = hasConnectedBefore.value;
        hasConnectedBefore.value = true;

        // 之前已连接过且重新连上时，通过顶部浮窗通知提示，不再向终端缓冲区写入绿色文字
        if (isReconnected) {
            const activeSid = incomingSessionId || sessionId;
            const currentSessionState = globalSessionsRef.value.get(activeSid) ?? globalSessionsRef.value.get(sessionId);
            if (!currentSessionState?.headless) {
                enqueueReconnectedToast(
                    activeSid,
                    currentSessionState?.connectionName || '',
                    activeSessionIdRef.value === activeSid,
                    getTerminalText('reconnectedMsg')
                );
            }
        }

        if (terminalInstance.value) {
            const currentDimensions = { cols: terminalInstance.value.cols, rows: terminalInstance.value.rows };
            // 检查尺寸是否有效
            if (currentDimensions.cols > 0 && currentDimensions.rows > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，主动发送初始尺寸:`, currentDimensions);
                sendMessage({ type: 'ssh:resize', sessionId, payload: currentDimensions });
            } else {
                console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但获取到的初始尺寸无效，跳过发送 resize:`, currentDimensions);
            }
        } else {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但 terminalInstance 不可用，无法发送初始 resize。`);
        }


        // 清空可能存在的旧缓冲（虽然理论上此时应该已经 ready 了）
        if (terminalOutputBuffer.value.length > 0) {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接时仍有缓冲数据，正在写入...`);
             terminalOutputBuffer.value.forEach(data => terminalInstance.value?.write(mainWriteFilter.write(data)));
             terminalOutputBuffer.value = [];
        }
    };

    const handleSshDisconnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const reason = payload || t('workspace.terminal.unknownReason'); // 使用 i18n 获取未知原因文本
        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已断开:`, reason);
        isSshConnected.value = false; // 更新状态

        // 通道已确认关闭 = 远端 pty 没了，不可能再有全屏程序"合法占用"备用屏。
        // 若此刻仍停在备用屏，说明退出序列随连接一起丢了（screen/btop 被 kill 的典型后果）。
        // 必须在这里补切回主屏，否则用户失去全部回滚历史：滚动条消失、怎么都滚不上去。
        if (terminalPanes.value.size > 0) {
            for (const [, entry] of terminalPanes.value.entries()) {
                if (restoreMainScreenBuffer(entry.terminal)) {
                    console.log(`[会话 ${sessionId}][SSH终端模块] 检测到 ${entry.paneId} 停在备用屏，已强制切回主屏以恢复回滚历史`);
                    // 主屏内容会"跳回"进入 TUI 之前的样子（TUI 画的那些行本来就不在回滚历史里），
                    // 不解释一句用户会以为输出被清掉了。
                    entry.terminal.writeln(`\r\n\x1b[33m${getTerminalText('altScreenRestoredMsg')}\x1b[0m`);
                }
            }
        } else {
            if (restoreMainScreenBuffer(terminalInstance.value)) {
                terminalInstance.value?.writeln(`\r\n\x1b[33m${getTerminalText('altScreenRestoredMsg')}\x1b[0m`);
            }
        }

        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('disconnectMsg', { reason })}\x1b[0m`);
        // 可以在这里添加其他清理逻辑，例如禁用输入
    };

    const handleSshError = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const errorMsg = payload || t('workspace.terminal.unknownSshError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] SSH 错误:`, errorMsg);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('genericErrorMsg', { message: errorMsg })}\x1b[0m`);
    };

    const handleSshStatus = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 这个消息现在由 useWebSocketConnection 处理以更新全局状态栏消息
        // 这里可以保留日志或用于其他特定于终端的 UI 更新（如果需要）
        const statusKey = payload?.key || 'unknown';
        const statusParams = payload?.params || {};
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到 SSH 状态更新:`, statusKey, statusParams);
        // 可以在终端打印一些状态信息吗？
        // terminalInstance.value?.writeln(`\r\n\x1b[34m[状态: ${statusKey}]\x1b[0m`);
    };

    const handleInfoMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] 收到后端信息:`, payload);
        terminalInstance.value?.writeln(`\r\n\x1b[34m${getTerminalText('infoPrefix')} ${payload}\x1b[0m`);
    };

    const handleErrorMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 通用错误也可能需要显示在终端
        const errorMsg = payload || t('workspace.terminal.unknownGenericError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] 收到后端通用错误:`, errorMsg);
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('errorPrefix')} ${errorMsg}\x1b[0m`);
    };

    // --- 多终端分屏 WebSocket 消息处理 ---

    const handleSshPaneOutput = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        const rawData = payload?.data;
        if (!paneId || !rawData) return;

        const paneEntry = terminalPanes.value.get(paneId);
        if (!paneEntry || !paneEntry.terminal) return;

        let outputData: string | Uint8Array = rawData;
        if (message?.encoding === 'base64' && typeof rawData === 'string') {
            try {
                const binaryString = atob(rawData);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                outputData = bytes;
            } catch (e) {
                console.error(`[会话 ${sessionId}][分屏终端 ${paneId}] Base64 解码失败:`, e);
                outputData = `\r\n[分屏解码错误: ${e}]\r\n`;
            }
        }

        paneEntry.terminal.write(getPaneWriteFilter(paneId).write(outputData));
        scheduleTerminalSync(2500);
    };

    const handleSshPaneReady = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        console.log(`[会话 ${sessionId}][SSH终端模块] 后端分屏终端 ${paneId} Shell 独立通道就绪`);
        const paneEntry = terminalPanes.value.get(paneId);
        if (paneEntry) {
            paneEntry.isReady = true;
            // 副终端如果是复用后端保活的 Shell（刷新前在跑 btop），前端同样只收到增量数据，
            // 画面会残缺。通道就绪后立刻抖动一次，让它整屏重绘。
            forceTuiRedraw(paneEntry.terminal, 500);
            // 通道就绪，立即向后端同步一次实际尺寸，触发服务端 PTY 更新尺寸
            if (paneEntry.terminal && paneEntry.terminal.cols > 0 && paneEntry.terminal.rows > 0) {
                sendMessage({
                    type: 'ssh:pane_resize',
                    sessionId,
                    payload: {
                        sessionId,
                        paneId,
                        cols: paneEntry.terminal.cols,
                        rows: paneEntry.terminal.rows,
                    }
                });
            }
        }
    };

    const handleSshPaneClosed = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        console.log(`[会话 ${sessionId}][SSH终端模块] 分屏终端 ${paneId} Shell 通道已关闭`);
        const paneEntry = terminalPanes.value.get(paneId);
        if (paneEntry && paneEntry.terminal) {
            // 同 handleSshDisconnected：分屏的 pty 也没了，先补退出备用屏再写提示，
            // 否则这个 pane 会永久停在备用屏（滚动条消失 + 无法回看历史）。
            restoreMainScreenBuffer(paneEntry.terminal);
            paneEntry.terminal.writeln(`\r\n\x1b[31m--- [${getTerminalText('disconnectMsg', { reason: '分屏会话已结束' })}] ---\x1b[0m\r\n`);
        }
    };

    // --- 注册 WebSocket 消息处理器 ---
    const unregisterHandlers: (() => void)[] = [];

    const registerSshHandlers = () => {
        unregisterHandlers.push(onMessage('ssh:output', handleSshOutput));
        unregisterHandlers.push(onMessage('ssh:connected', handleSshConnected));
        unregisterHandlers.push(onMessage('ssh:disconnected', handleSshDisconnected));
        unregisterHandlers.push(onMessage('ssh:error', handleSshError));
        unregisterHandlers.push(onMessage('ssh:status', handleSshStatus));
        unregisterHandlers.push(onMessage('info', handleInfoMessage));
        unregisterHandlers.push(onMessage('error', handleErrorMessage)); // 也处理通用错误
        // 注册分屏终端事件
        unregisterHandlers.push(onMessage('ssh:pane_output', handleSshPaneOutput));
        unregisterHandlers.push(onMessage('ssh:pane_ready', handleSshPaneReady));
        unregisterHandlers.push(onMessage('ssh:pane_closed', handleSshPaneClosed));
        console.log(`[会话 ${sessionId}][SSH终端模块] 已注册 SSH 相关消息处理器（含分屏）。`);
    };

    const unregisterAllSshHandlers = () => {
        console.log(`[会话 ${sessionId}][SSH终端模块] 注销 SSH 相关消息处理器...`);
        unregisterHandlers.forEach(unregister => unregister?.());
        unregisterHandlers.length = 0; // 清空数组
    };

    // 初始化时自动注册处理程序
    registerSshHandlers();

    // --- 清理函数 ---
    const cleanup = () => {
        if (terminalSyncTimer) {
            clearTimeout(terminalSyncTimer);
            terminalSyncTimer = null;
        }
        unregisterAllSshHandlers();
        // 释放所有 pane 的搜索状态（装饰 / viewport 监听 / 定时器）
        Array.from(searchStates.keys()).forEach((paneId) => disposeSearchState(paneId));
        // terminalInstance.value?.dispose(); // 终端实例的销毁由 TerminalComponent 负责
        terminalInstance.value = null;
        if (terminalSyncTimer) {
            clearTimeout(terminalSyncTimer);
            terminalSyncTimer = null;
        }
        for (const [, disp] of paneWriteParsedDisposables.entries()) {
            try { disp.dispose(); } catch {}
        }
        paneWriteParsedDisposables.clear();
        paneDirtyVersions.clear();
        paneSerializedMemo.clear();
        terminalPanes.value.clear();
        paneWriteFilters.clear();
        primaryPaneId.value = null;
        console.log(`[会话 ${sessionId}][SSH终端模块] 已清理。`);
    };

    /**
     * 直接发送数据到 SSH 会话 (例如，从命令输入栏)
     * @param data 要发送的字符串数据
     * @param paneId 目标分屏终端 ID，缺省时发往主终端
     */
    const sendData = (data: string, paneId?: string) => {
        handleTerminalData(data, paneId);
    };

    // 获取目标终端实例（支持分屏路由）
    const getTargetPaneEntry = (targetPaneId?: string | null): PaneTerminalInstance | null => {
        let pid = targetPaneId;
        if (!pid) {
            try {
                const layoutStore = useLayoutStore();
                pid = layoutStore.activeTerminalPaneId;
            } catch {}
        }
        if (!pid) {
            pid = primaryPaneId.value;
        }

        if (pid && terminalPanes.value.has(pid)) {
            return terminalPanes.value.get(pid)!;
        }
        if (primaryPaneId.value && terminalPanes.value.has(primaryPaneId.value)) {
            return terminalPanes.value.get(primaryPaneId.value)!;
        }
        const first = terminalPanes.value.values().next();
        return first.done ? null : first.value;
    };

    const clearTerminal = (targetPaneId?: string | null) => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (entry?.terminal && typeof entry.terminal.clear === 'function') {
            console.log(`[会话 ${sessionId}][SSH终端模块] 正在清空终端 (paneId: ${entry.paneId})`);
            entry.terminal.clear();
            markPaneDirty(entry.paneId);
            paneSerializedMemo.delete(entry.paneId);
            return true;
        }
        if (terminalInstance.value && typeof terminalInstance.value.clear === 'function') {
            terminalInstance.value.clear();
            if (primaryPaneId.value) {
                markPaneDirty(primaryPaneId.value);
                paneSerializedMemo.delete(primaryPaneId.value);
            }
            return true;
        }
        return false;
    };

    const scrollToBottom = (targetPaneId?: string | null) => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (entry?.terminal && typeof entry.terminal.scrollToBottom === 'function') {
            entry.terminal.scrollToBottom();
            return;
        }
        terminalInstance.value?.scrollToBottom();
    };

    // --- 搜索相关方法（自研高亮） ---
    //
    // 为什么不用 @xterm/addon-search 做高亮：
    // 它每次搜索词变化都要全量扫 buffer（3000 行实测 235ms，稀疏命中时最慢），
    // 而且不暴露命中行号 —— 滚动条标记还得再扫一遍，等于双倍开销。
    // 这里改成"扫一次 → 自己建 decoration"：扫描分片可取消，装饰只覆盖可视区附近，
    // 翻页直接用已有的 matches，不再触发任何扫描。

    const emitWorkspaceEvent = useWorkspaceEventEmitter();

    /** 搜索词变化后的扫描防抖：正常打字间隔 100~200ms，200ms 保证"打字过程中不扫" */
    const SEARCH_DEBOUNCE_MS = 200;
    /*
     * xterm 的 decoration 只接受 `#RRGGBB`（DOM renderer 会把 rgba 的 alpha 直接丢掉，
     * 渲染成不透明纯色，实测黄色会刺眼到看不清字），所以这里用中等亮度的暗色：
     * 深色主题下白字可读，浅色主题下黑字也能辨认。
     */
    const SEARCH_MATCH_BG = '#8a6d1f';
    const SEARCH_ACTIVE_BG = '#b91c1c';

    interface PaneSearchState {
        terminal: PaneTerminalInstance['terminal'];
        term: string;
        options: TerminalSearchOptions;
        matches: TerminalSearchMatch[];
        matchLines: number[];
        totalLines: number;
        index: number;
        token: number;
        decorations: Array<{ dispose: () => void }>;
        viewport: HTMLElement | null;
        viewportListener: (() => void) | null;
        rebuildTimer: ReturnType<typeof setTimeout> | null;
        scanTimer: ReturnType<typeof setTimeout> | null;
    }

    const searchStates = new Map<string, PaneSearchState>();

    /**
     * 清掉装饰并强制重绘一屏。
     *
     * 只 dispose 装饰不够：xterm 的 DOM renderer 把 decoration 背景色直接写在字符 span 上，
     * 元素移除后这些 span 的底色要等下一次重绘才会恢复。终端没有新输出时不会重绘，
     * 表现就是"关闭搜索后黄色还留着"（实测复现）。
     */
    const disposeSearchDecorations = (state: PaneSearchState, term?: PaneTerminalInstance['terminal']) => {
        state.decorations.forEach((d) => {
            try {
                d.dispose();
            } catch {}
        });
        state.decorations = [];
        if (term) {
            /*
             * 只 dispose 我们持有的引用不够：xterm 的 DOM renderer 在 refresh 时会
             * 从 DecorationService 里重新把 decoration 渲染出来（实测关闭搜索后高亮复活）。
             * 直接 reset 整个装饰服务：我们就是唯一的 decoration 使用者（addon 已不用），
             * 这样字符 span 上的底色也能随重绘一起恢复。
             */
            try {
                (term as any)?._core?._decorationService?.reset?.();
            } catch {}
            try {
                term.refresh(0, term.rows - 1);
            } catch {}
        }
    };

    /**
     * 只给"可视区上下各一屏"的命中建装饰。
     * 全 buffer 建（几百上千个）正是 addon 慢的原因，而用户能看到的只有当前屏。
     */
    const applySearchDecorations = (pane: PaneTerminalInstance, state: PaneSearchState) => {
        disposeSearchDecorations(state, pane.terminal);
        const term = pane.terminal;
        const buffer = term.buffer.active;
        // 备用屏（vim / less / btop）坐标体系不同，不画；退出 TUI 后靠滚动/再搜索重建
        if (buffer.type === 'alternate' || !state.matches.length) return;

        const cursorAbs = buffer.baseY + buffer.cursorY;
        const from = Math.max(0, buffer.viewportY - term.rows);
        const to = buffer.viewportY + term.rows * 2;

        for (let i = 0; i < state.matches.length; i++) {
            const m = state.matches[i];
            if (m.row < from || m.row > to) continue;

            // registerMarker 的入参是"相对光标的行偏移"，传错会让高亮整体错位
            const marker = term.registerMarker(m.row - cursorAbs);
            if (!marker) continue;

            const deco = term.registerDecoration({
                marker,
                x: m.col,
                width: m.length,
                backgroundColor: i === state.index ? SEARCH_ACTIVE_BG : SEARCH_MATCH_BG,
            });
            if (deco) state.decorations.push(deco);
        }
    };

    const emitSearchState = (pane: PaneTerminalInstance, state: PaneSearchState) => {
        emitWorkspaceEvent('search:markers', {
            sessionId,
            paneId: pane.paneId,
            matchLines: state.matchLines,
            totalLines: state.totalLines,
            index: state.index,
        });
        emitWorkspaceEvent('search:results', {
            sessionId,
            paneId: pane.paneId,
            index: state.index,
            count: state.matches.length,
        });
    };

    const jumpToSearchMatch = (
        pane: PaneTerminalInstance,
        state: PaneSearchState,
        index: number
    ) => {
        if (!state.matches.length) return;
        const total = state.matches.length;
        // 循环翻页：-1 -> 最后一个，total -> 0
        state.index = ((index % total) + total) % total;

        const m = state.matches[state.index];
        const term = pane.terminal;
        term.scrollToLine(m.row);
        // 不调用 term.select()：selection 的渲染优先级高于 bottom 层装饰，
        // 会把当前匹配的红色盖成主题的选区蓝，看起来像"高亮没生效"。
        applySearchDecorations(pane, state);
        emitSearchState(pane, state);
    };

    const ensureSearchState = (pane: PaneTerminalInstance): PaneSearchState => {
        const existing = searchStates.get(pane.paneId);
        if (existing) return existing;

        const state: PaneSearchState = {
            terminal: pane.terminal,
            term: '',
            options: {},
            matches: [],
            matchLines: [],
            totalLines: 1,
            index: -1,
            token: 0,
            decorations: [],
            viewport: null,
            viewportListener: null,
            rebuildTimer: null,
            scanTimer: null,
        };
        searchStates.set(pane.paneId, state);

        // 滚轮滚动走 .xterm-viewport 的原生 scroll，**不会触发 xterm 的 onScroll**，
        // 所以标记/高亮重建必须监听这个元素（与滚动条组件同一套判据）。
        const viewport = pane.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null;
        if (viewport) {
            const listener = () => {
                if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
                state.rebuildTimer = setTimeout(() => {
                    state.rebuildTimer = null;
                    if (searchStates.get(pane.paneId) === state) {
                        applySearchDecorations(pane, state);
                    }
                }, 120);
            };
            viewport.addEventListener('scroll', listener, { passive: true });
            state.viewport = viewport;
            state.viewportListener = listener;
        }
        return state;
    };

    const disposeSearchState = (paneId: string) => {
        const state = searchStates.get(paneId);
        if (!state) return;
        state.token++;
        if (state.scanTimer) clearTimeout(state.scanTimer);
        if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
        disposeSearchDecorations(state, state.terminal);
        if (state.viewport && state.viewportListener) {
            state.viewport.removeEventListener('scroll', state.viewportListener);
        }
        searchStates.delete(paneId);
    };

    /**
     * 搜索入口。同一个词只翻页（不重扫），词/选项变化才重新扫描。
     */
    const runTerminalSearch = (
        pane: PaneTerminalInstance,
        term: string,
        options: TerminalSearchOptions,
        direction: 'next' | 'previous'
    ): boolean => {
        const state = ensureSearchState(pane);
        const sameQuery =
            state.term === term &&
            state.options.regex === options.regex &&
            state.options.wholeWord === options.wholeWord &&
            state.options.caseSensitive === options.caseSensitive;

        if (sameQuery && state.matches.length > 0) {
            jumpToSearchMatch(pane, state, state.index + (direction === 'next' ? 1 : -1));
            return true;
        }

        // 新查询：作废上一轮扫描，先清掉旧高亮（否则旧词的高亮会挂着误导）
        state.token++;
        const token = state.token;
        if (state.scanTimer) clearTimeout(state.scanTimer);
        // 必须传 terminal：新查询时要连字符 span 的底色一起清掉，否则旧高亮会挂着
        disposeSearchDecorations(state, pane.terminal);
        state.term = term;
        state.options = options;
        state.matches = [];
        state.matchLines = [];
        state.index = -1;

        if (!term) {
            emitSearchState(pane, state);
            return false;
        }

        state.scanTimer = setTimeout(async () => {
            state.scanTimer = null;
            const buffer = pane.terminal?.buffer?.active;
            if (!buffer) return;

            const result = await scanSearchBuffer(buffer, term, options, () => token !== state.token);
            if (token !== state.token) return; // 已被更新的搜索取代

            state.matches = result.matches;
            state.matchLines = result.matchLines;
            state.totalLines = result.totalLines;

            if (!state.matches.length) {
                state.index = -1;
                emitSearchState(pane, state);
                return;
            }

            // 从"当前视口顶部往后"的第一个命中开始，符合"从正在看的位置往下找"的直觉
            let start = state.matches.findIndex((m) => m.row >= buffer.viewportY);
            if (start < 0) start = 0;
            jumpToSearchMatch(pane, state, start);
        }, SEARCH_DEBOUNCE_MS);

        return true;
    };

    const searchNext = (term: string, options?: ISearchOptions, targetPaneId?: string | null): boolean => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (!entry) {
            console.warn(`[会话 ${sessionId}][SSH终端模块] searchNext 调用失败，未找到有效终端。`);
            return false;
        }
        return runTerminalSearch(
            entry,
            term,
            {
                regex: options?.regex,
                wholeWord: options?.wholeWord,
                caseSensitive: options?.caseSensitive,
            },
            'next'
        );
    };

    const searchPrevious = (term: string, options?: ISearchOptions, targetPaneId?: string | null): boolean => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (!entry) {
            console.warn(`[会话 ${sessionId}][SSH终端模块] searchPrevious 调用失败，未找到有效终端。`);
            return false;
        }
        return runTerminalSearch(
            entry,
            term,
            {
                regex: options?.regex,
                wholeWord: options?.wholeWord,
                caseSensitive: options?.caseSensitive,
            },
            'previous'
        );
    };

    const clearTerminalSearch = (targetPaneId?: string | null) => {
        /*
         * 这里**不按 paneId 精确清理**。
         *
         * 布局刷新时会话树的 paneId 会重新生成（terminal-0 / terminal-1），
         * 用调用方传进来的 activeTerminalPaneId 去 searchStates 里找，
         * 很容易找的是"重建后的新 ID"，而真正挂着装饰的 state 还挂在旧 ID 上 ——
         * 表现就是"关闭搜索后高亮还在"（实测复现）。
         *
         * 搜索本身是全局单实例交互，任何时刻最多只有一个 pane 有高亮，直接清全部最稳。
         */
        Array.from(searchStates.keys()).forEach((paneId) => disposeSearchState(paneId));

        terminalPanes.value.forEach((pane) => {
            pane.terminal.clearSelection();
            // 兼容：老路径可能还在用 addon 的装饰
            pane.searchAddon?.clearDecorations();
        });

        emitWorkspaceEvent('search:markers', {
            sessionId,
            paneId: targetPaneId || undefined,
            matchLines: [],
            totalLines: 1,
            index: -1,
        });
        emitWorkspaceEvent('search:results', {
            sessionId,
            paneId: targetPaneId || undefined,
            index: -1,
            count: 0,
        });
    };

        // --- 序列化方法 (带完整 ANSI 样式) ---
    //
    // 三个必须注意的点（5000 行 buffer 实测出来的）：
    // 1. **完整保存，不截断历史**。addon-serialize 是逐 cell 生成 ANSI，成本与行数线性相关；
    //    默认 5000 行一次约 40ms（toRaw 之后），不会产生长任务。只有 SNAPSHOT_MAX_LINES
    //    这个安全阀在 scrollback 被调到极端值时才会生效。
    // 2. **必须 toRaw**。terminalPanes 是 ref(Map)，entries() 出来的是 Vue 代理，
    //    addon 内部逐 cell 读 buffer 时每次属性访问都要走 BaseReactiveHandler.get +
    //    toRawType（profile 里这两项合计约 900ms）。
    // 3. **主终端不要单独再序列化一次**。serializeAllPanes 已经包含主终端，
    //    collectSnapshot 同时调用两个方法时，同一个 buffer 会被完整序列化两遍。
    const serializeAllPanesImpl = (): Record<string, string> => {
        // 同一次采集里 serializeTerminal 会接着调用，复用结果避免重复序列化。
        // 用微任务清除缓存：只在当前同步调用栈内有效，不会返回过期内容。
        if (panesSerializeCache) return panesSerializeCache;

        const result: Record<string, string> = {};
        for (const [pId, entry] of terminalPanes.value.entries()) {
            const rawEntry = toRaw(entry);
            // 终端在尺寸可信之前会把写入暂存起来（见 Terminal.vue），此时 buffer 是空的，
            // 直接把暂存的原始流当成屏幕内容交出去（绝不要为了采集而提前 flush）。
            try {
                const pendingText = (rawEntry.terminal as any)?.getPendingWriteText?.();
                if (typeof pendingText === 'string' && pendingText.length > 0) {
                    result[pId] = pendingText;
                    continue;
                }
            } catch {
                /* 忽略：终端可能已销毁 */
            }
            // 同上：备用屏（TUI）不参与快照，避免刷新后停在备用屏
            if (rawEntry.terminal?.buffer?.active?.type === 'alternate') {
                console.log(`[会话 ${sessionId}][分屏终端 ${pId}] 处于 TUI 备用屏，跳过序列化`);
                continue;
            }
            // 脏版本缓存命中：内容与尺寸均未变化时 0ms 直接复用上次序列化结果
            const curVersion = paneDirtyVersions.get(pId) || 0;
            const curCols = rawEntry.terminal?.cols ?? 0;
            const curRows = rawEntry.terminal?.rows ?? 0;
            const memo = paneSerializedMemo.get(pId);
            if (memo && memo.version === curVersion && memo.cols === curCols && memo.rows === curRows) {
                if (memo.text.length > 0) {
                    result[pId] = memo.text;
                }
                continue;
            }
            if (rawEntry.serializeAddon) {
                try {
                    const s = toRaw(rawEntry.serializeAddon).serialize({ scrollback: SNAPSHOT_MAX_LINES });
                    if (typeof s === 'string' && s.length > 0) {
                        paneSerializedMemo.set(pId, { version: curVersion, cols: curCols, rows: curRows, text: s });
                        result[pId] = s;
                        continue;
                    }
                    paneSerializedMemo.set(pId, { version: curVersion, cols: curCols, rows: curRows, text: '' });
                } catch (e) {
                    console.warn(`[会话 ${sessionId}][分屏终端 ${pId}] 序列化失败:`, e);
                }
            }
            // 降级使用 buffer 遍历（同样只取最近 N 行，否则和上面的成本一样）
            if (rawEntry.terminal) {
                const buffer = rawEntry.terminal.buffer.active;
                const fromRow = Math.max(0, buffer.length - SNAPSHOT_MAX_LINES);
                let lastNonEmpty = -1;
                for (let i = buffer.length - 1; i >= fromRow; i--) {
                    const line = buffer.getLine(i);
                    if (line && line.translateToString(true).trim() !== '') {
                        lastNonEmpty = i;
                        break;
                    }
                }
                if (lastNonEmpty !== -1) {
                    let text = '';
                    for (let i = fromRow; i <= lastNonEmpty; i++) {
                        const line = buffer.getLine(i);
                        if (!line) continue;
                        const next = i < lastNonEmpty ? buffer.getLine(i + 1) : null;
                        if (next?.isWrapped) {
                            text += line.translateToString(false);
                        } else {
                            text += line.translateToString(true);
                            if (i < lastNonEmpty) text += '\r\n';
                        }
                    }
                    if (text) result[pId] = text;
                }
            }
        }

        panesSerializeCache = result;
        if (!panesCacheClearScheduled) {
            panesCacheClearScheduled = true;
            queueMicrotask(() => {
                panesSerializeCache = null;
                panesCacheClearScheduled = false;
            });
        }
        return result;
    };

    const serializeTerminalImpl = (): string | null => {
        // 终端在尺寸可信前会把写入暂存（见 Terminal.vue），此时 buffer 为空，
        // 直接把暂存的原始流当成屏幕内容返回（绝不要为了采集而提前 flush）。
        try {
            const pendingText = (terminalInstance.value as any)?.getPendingWriteText?.();
            if (typeof pendingText === 'string' && pendingText.length > 0) return pendingText;
        } catch {
            /* 忽略 */
        }
        // 处于备用屏（btop / vim / less 等全屏 TUI）时不要序列化。
        // 否则恢复出来的终端会停在备用屏里，用户退出 TUI（Ctrl+C）后回到空的正常屏，
        // 整块区域被"当前 SGR 背景"填满 —— 表现为刷新后终端变成一块黑。
        if (terminalInstance.value?.buffer?.active?.type === 'alternate') {
            console.log(`[会话 ${sessionId}][SSH终端模块] 当前处于 TUI 备用屏，跳过屏幕内容序列化`);
            return '';
        }

        // 复用 allPanes 的结果（主终端本来就在 terminalPanes 里，不必再序列化一遍）
        const primary = primaryPaneId.value;
        if (primary) {
            const panes = serializeAllPanesImpl();
            const buf = panes[primary];
            if (typeof buf === 'string') return buf;
        }

        if (serializeAddon.value) {
            try {
                return toRaw(serializeAddon.value).serialize({ scrollback: SNAPSHOT_MAX_LINES });
            } catch (e) {
                console.warn(`[会话 ${sessionId}][SSH终端模块] 序列化终端内容失败:`, e);
            }
        }
        return null;
    };

    // 返回工厂实例
    return {
        // 公共接口
        handleTerminalReady,
        handleTerminalData, // 这个处理来自 xterm.js 的输入
        handleTerminalResize,
        handleTerminalDispose,
        sendData, // 允许外部直接发送数据
        cleanup,
        // --- 清空与控制 ---
        clearTerminal,
        scrollToBottom,
        getTargetPaneEntry,
        // --- 搜索方法 ---
        searchNext,
        searchPrevious,
        clearTerminalSearch,
        // --- 序列化（实现见上方的 serializeTerminalImpl / serializeAllPanesImpl）---
        serializeTerminal: serializeTerminalImpl,
        serializeAllPanes: serializeAllPanesImpl,
        serializeAddon,
        // --- 暴露状态与多终端 Map ---
        isSshConnected: readonly(isSshConnected), // 暴露 SSH 连接状态 (只读)
        terminalInstance, // 暴露主 terminal 实例，以便 WorkspaceView 写入提示信息
        terminalPanes,
        primaryPaneId,
    };
}

// 保留兼容旧代码的函数（将在完全迁移后移除）
export function useSshTerminal(t: (key: string) => string) {
    console.warn('⚠️ 使用已弃用的 useSshTerminal() 全局单例。请迁移到 createSshTerminalManager() 工厂函数。');
    
    const terminalInstance = ref<Terminal | null>(null);
    
    const handleTerminalReady = (term: Terminal) => {
        console.log('[SSH终端模块][旧] 终端实例已就绪，但使用了已弃用的单例模式。');
        terminalInstance.value = term;
    };
    
    const handleTerminalData = (data: string) => {
        console.warn('[SSH终端模块][旧] 收到终端数据，但使用了已弃用的单例模式，无法发送。');
    };
    
    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        console.warn('[SSH终端模块][旧] 收到终端大小调整，但使用了已弃用的单例模式，无法发送。');
    };
    
    // 返回与旧接口兼容的空函数，以避免错误
    return {
        terminalInstance,
        handleTerminalReady,
        handleTerminalData,
        handleTerminalResize,
        registerSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 registerSshHandlers'),
        unregisterAllSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 unregisterAllSshHandlers'),
    };
}
