import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import { ref, computed, onScopeDispose } from 'vue';
import { useUiNotificationsStore } from './uiNotifications.store'; // 用于显示通知
import { subscribeGlobalEvent } from '../composables/useGlobalSyncListener';
import {
    deduplicateAndSortHistory,
    reconcileHistoryWithPending,
    type CommandHistoryEntryLike,
    type PendingCommandAdd,
    type PendingCommandDelete,
} from '../utils/commandHistorySync';

// 后端返回的原始历史记录条目接口
interface CommandHistoryEntryBE {
    id: number;
    command: string;
    timestamp: number; // Unix 时间戳 (秒)
}

// 前端使用的历史记录条目接口
export interface CommandHistoryEntryFE extends CommandHistoryEntryLike {
}

const CACHE_KEY = 'commandHistoryCache';
const MAX_STORED_HISTORY = 300;
const RETRY_DELAYS_MS = [1500, 4000, 10000];

export const useCommandHistoryStore = defineStore('commandHistory', () => {
    const historyList = ref<CommandHistoryEntryFE[]>([]);
    const searchTerm = ref('');
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const hasLoadedFromServer = ref(false);
    const uiNotificationsStore = useUiNotificationsStore();
    const selectedIndex = ref<number>(-1);

    // 并发控制与待确认队列状态
    let fetchGeneration = 0;
    let mutationSeq = 0;
    let tempIdCounter = 0;
    let pendingClearOpSeq: number | null = null;
    let lastClearSeq = 0;
    const pendingAdds = new Map<string, PendingCommandAdd>();
    const pendingDeletes = new Map<string, PendingCommandDelete>();
    const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // --- Getters ---

    // 计算属性：根据搜索词过滤历史记录
    const filteredHistory = computed(() => {
        const term = searchTerm.value.toLowerCase().trim();
        if (!term) {
            return historyList.value;
        }
        return historyList.value.filter(entry =>
            entry.command.toLowerCase().includes(term)
        );
    });

    // --- Actions ---

    const selectNextCommand = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value + 1) % history.length;
    };

    const selectPreviousCommand = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value - 1 + history.length) % history.length;
    };

    const clearRetryTimer = (command: string) => {
        const timer = retryTimers.get(command);
        if (timer) {
            clearTimeout(timer);
            retryTimers.delete(command);
        }
    };

    const clearAllRetryTimers = () => {
        for (const timer of retryTimers.values()) {
            clearTimeout(timer);
        }
        retryTimers.clear();
    };

    // 辅助函数：安全写入本地缓存（始终去重并按时间降序保存）
    const saveToCache = (list: readonly CommandHistoryEntryFE[]) => {
        try {
            const normalized = deduplicateAndSortHistory(list, MAX_STORED_HISTORY);
            localStorage.setItem(CACHE_KEY, JSON.stringify(normalized));
        } catch (e) {
            console.warn('[CmdHistoryStore] 写入本地历史缓存失败:', e);
        }
    };

    // 从后端获取历史记录 (代数淘汰旧响应 + 待同步队列防覆盖归并)
    const fetchHistory = async (force: boolean = false) => {
        const currentGen = ++fetchGeneration;
        error.value = null;

        // 1. 仅在尚未从服务端同步完成且非强制刷新时，先展示本地缓存，避免覆盖已有的最新状态
        if (!force && !hasLoadedFromServer.value) {
            try {
                const cachedData = localStorage.getItem(CACHE_KEY);
                if (cachedData) {
                    const parsed = JSON.parse(cachedData);
                    if (Array.isArray(parsed)) {
                        const reconciledCache = reconcileHistoryWithPending(
                            parsed,
                            pendingAdds,
                            pendingDeletes,
                            pendingClearOpSeq !== null,
                            MAX_STORED_HISTORY
                        );
                        if (reconciledCache) {
                            historyList.value = reconciledCache;
                        }
                        isLoading.value = false;
                    }
                } else if (historyList.value.length === 0) {
                    isLoading.value = true;
                }
            } catch (e) {
                console.error('[CmdHistoryStore] Failed to load or parse history cache:', e);
                localStorage.removeItem(CACHE_KEY);
                if (historyList.value.length === 0) {
                    isLoading.value = true;
                }
            }
        }

        // 2. 向后端请求最新数据
        try {
            const response = await apiClient.get<CommandHistoryEntryBE[]>('/command-history?limit=300');

            // 如果期间已经发起了更新的 fetchHistory，丢弃过期响应
            if (currentGen !== fetchGeneration) {
                return;
            }

            // 后端返回升序，反转为降序（最新在前）并与本地待确认状态归并
            const rawDescending = Array.isArray(response.data) ? [...response.data].reverse() : [];
            const reconciled = reconcileHistoryWithPending(
                rawDescending,
                pendingAdds,
                pendingDeletes,
                pendingClearOpSeq !== null,
                MAX_STORED_HISTORY
            );

            if (reconciled !== null) {
                const current = historyList.value;
                const hasChanged =
                    force ||
                    current.length !== reconciled.length ||
                    JSON.stringify(current) !== JSON.stringify(reconciled);

                if (hasChanged) {
                    historyList.value = reconciled;
                    saveToCache(reconciled);
                }
                hasLoadedFromServer.value = true;
            }
            error.value = null;
        } catch (err: any) {
            if (currentGen !== fetchGeneration) {
                return;
            }
            console.error('[CmdHistoryStore] 获取命令历史记录失败:', err);
            error.value = err.response?.data?.message || '获取历史记录时发生错误';
            if (historyList.value.length === 0) {
                uiNotificationsStore.showError(error.value ?? '未知错误');
            }
        } finally {
            if (currentGen === fetchGeneration) {
                isLoading.value = false;
            }
        }
    };

    // 后台上报单个待提交命令，支持乱序删除补偿与指数退避重试
    const submitAddCommand = async (trimmed: string, opSeq: number) => {
        clearRetryTimer(trimmed);

        try {
            const response = await apiClient.post<{ id: number; command?: string; timestamp?: number }>(
                '/command-history',
                { command: trimmed }
            );
            const serverId = response.data?.id;
            const serverTs = response.data?.timestamp;

            // 判断 POST 飞行途中是否已被用户删除或清空
            const pendingDel = pendingDeletes.get(trimmed);
            const latestDeleteOrClearSeq = Math.max(pendingDel?.opSeq ?? 0, lastClearSeq);
            const currentPendingAdd = pendingAdds.get(trimmed);
            const hasNewerAddAfterDelete = Boolean(
                currentPendingAdd && currentPendingAdd.opSeq > latestDeleteOrClearSeq
            );

            if (latestDeleteOrClearSeq > opSeq && !hasNewerAddAfterDelete) {
                if (currentPendingAdd && currentPendingAdd.opSeq === opSeq) {
                    pendingAdds.delete(trimmed);
                }
                if (typeof serverId === 'number' && serverId > 0) {
                    try {
                        await apiClient.delete(`/command-history/${serverId}`);
                    } catch {
                        // 忽略补偿删除 404 等非致命异常
                    }
                    if (pendingDel && pendingDeletes.get(trimmed)?.opSeq === pendingDel.opSeq) {
                        pendingDeletes.delete(trimmed);
                    }
                }
                return;
            }

            if (currentPendingAdd && currentPendingAdd.opSeq === opSeq) {
                pendingAdds.delete(trimmed);
            }

            if (typeof serverId === 'number' && serverId > 0) {
                const idx = historyList.value.findIndex(entry => entry.command === trimmed);
                if (idx !== -1) {
                    historyList.value[idx].id = serverId;
                    if (typeof serverTs === 'number' && serverTs > 0) {
                        historyList.value[idx].timestamp = Math.max(
                            historyList.value[idx].timestamp,
                            serverTs
                        );
                    }
                } else if (!pendingDel || pendingDel.opSeq < opSeq) {
                    historyList.value.unshift({
                        id: serverId,
                        command: trimmed,
                        timestamp:
                            typeof serverTs === 'number' && serverTs > 0
                                ? serverTs
                                : currentPendingAdd?.timestamp || Math.floor(Date.now() / 1000),
                    });
                }

                historyList.value = deduplicateAndSortHistory(historyList.value, MAX_STORED_HISTORY);
                saveToCache(historyList.value);
            }
        } catch (err: any) {
            console.warn('[CmdHistoryStore] 后台同步历史记录失败，准备重试:', err?.message || err);

            const pendingDel = pendingDeletes.get(trimmed);
            const latestDeleteOrClearSeq = Math.max(pendingDel?.opSeq ?? 0, lastClearSeq);
            const currentPendingAdd = pendingAdds.get(trimmed);
            const hasNewerAddAfterDelete = Boolean(
                currentPendingAdd && currentPendingAdd.opSeq > latestDeleteOrClearSeq
            );

            if (latestDeleteOrClearSeq > opSeq && !hasNewerAddAfterDelete) {
                if (currentPendingAdd && currentPendingAdd.opSeq === opSeq) {
                    pendingAdds.delete(trimmed);
                }
                return;
            }

            if (!currentPendingAdd || currentPendingAdd.opSeq !== opSeq) {
                return;
            }

            currentPendingAdd.status = 'failed';
            currentPendingAdd.attempts += 1;

            if (currentPendingAdd.attempts <= RETRY_DELAYS_MS.length) {
                const delay = RETRY_DELAYS_MS[currentPendingAdd.attempts - 1];
                const timer = setTimeout(() => {
                    retryTimers.delete(trimmed);
                    const latest = pendingAdds.get(trimmed);
                    if (latest && latest.opSeq === opSeq) {
                        latest.status = 'in_flight';
                        void submitAddCommand(trimmed, opSeq);
                    }
                }, delay);
                retryTimers.set(trimmed, timer);
            }
        }
    };

    // 网络恢复或显式触发时，重传所有失败待上传的历史命令
    const flushPendingAdds = () => {
        for (const [cmd, pending] of pendingAdds.entries()) {
            if (pending.status === 'failed') {
                pending.status = 'in_flight';
                pending.attempts = 0;
                void submitAddCommand(cmd, pending.opSeq);
            }
        }
    };

    // 添加命令到历史记录 (乐观更新：严格全量去重并置顶，带异步重试与防覆盖保护)
    const addCommand = async (command: string) => {
        // 过滤 Ctrl+C 等终端控制信号
        if (command === '\x03') {
            return;
        }
        const trimmed = typeof command === 'string' ? command.trim() : '';
        if (!trimmed) {
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const opSeq = ++mutationSeq;

        // 移除同命令的旧待删除标记与重试定时器
        pendingDeletes.delete(trimmed);
        clearRetryTimer(trimmed);

        // 若当前列表中已存在同一命令的正式正数 ID，则直接复用该正式 ID 避免生成临时负数 ID
        const existingPositive = historyList.value.find(
            entry => entry.command === trimmed && entry.id > 0
        );
        const existingAny = historyList.value.find(entry => entry.command === trimmed);
        const retainedId = existingPositive
            ? existingPositive.id
            : existingAny && existingAny.id < 0
              ? existingAny.id
              : --tempIdCounter;

        // 从内存中彻底移除所有相同 command 的旧项，杜绝列表残留多条重复
        const remaining = historyList.value.filter(entry => entry.command !== trimmed);
        const updatedEntry: CommandHistoryEntryFE = {
            id: retainedId,
            command: trimmed,
            timestamp: nowSec,
        };

        historyList.value = deduplicateAndSortHistory(
            [updatedEntry, ...remaining],
            MAX_STORED_HISTORY
        );
        saveToCache(historyList.value);

        pendingAdds.set(trimmed, {
            command: trimmed,
            tempId: retainedId,
            timestamp: nowSec,
            opSeq,
            status: 'in_flight',
            attempts: 0,
        });

        await submitAddCommand(trimmed, opSeq);
    };

    // 删除单条历史记录 (乐观删除 + 临时 ID 延迟补偿删除)
    const deleteCommand = async (id: number) => {
        const target = historyList.value.find(entry => entry.id === id);
        const targetCommand = target?.command;
        const opSeq = ++mutationSeq;

        // 1. 乐观从本地列表及缓存移除
        historyList.value = historyList.value.filter(
            entry => entry.id !== id && (!targetCommand || entry.command !== targetCommand)
        );
        saveToCache(historyList.value);

        if (targetCommand) {
            clearRetryTimer(targetCommand);
            pendingAdds.delete(targetCommand);
            pendingDeletes.set(targetCommand, { id, command: targetCommand, opSeq });
        }

        // 2. 如果是尚未拿回后端正式 ID 的临时条目，等在途 POST 返回后由补偿逻辑自动删除，避免无谓 404
        if (id <= 0) {
            uiNotificationsStore.showSuccess('历史记录已删除');
            return;
        }

        try {
            await apiClient.delete(`/command-history/${id}`);
            if (targetCommand && pendingDeletes.get(targetCommand)?.opSeq === opSeq) {
                pendingDeletes.delete(targetCommand);
            }
            uiNotificationsStore.showSuccess('历史记录已删除');
        } catch (err: any) {
            if (err?.response?.status === 404) {
                if (targetCommand && pendingDeletes.get(targetCommand)?.opSeq === opSeq) {
                    pendingDeletes.delete(targetCommand);
                }
                uiNotificationsStore.showSuccess('历史记录已删除');
                return;
            }
            console.error('删除命令历史记录失败:', err);
            if (targetCommand && pendingDeletes.get(targetCommand)?.opSeq === opSeq) {
                pendingDeletes.delete(targetCommand);
            }
            const message = err.response?.data?.message || '删除历史记录时发生错误';
            uiNotificationsStore.showError(message);
            void fetchHistory(true);
        }
    };

    // 清空所有历史记录
    const clearAllHistory = async () => {
        const clearOpSeq = ++mutationSeq;
        pendingClearOpSeq = clearOpSeq;
        lastClearSeq = clearOpSeq;

        clearAllRetryTimers();
        pendingAdds.clear();
        pendingDeletes.clear();
        historyList.value = [];
        try {
            localStorage.removeItem(CACHE_KEY);
        } catch {}

        try {
            await apiClient.delete('/command-history');
            uiNotificationsStore.showSuccess('所有历史记录已清空');
        } catch (err: any) {
            console.error('清空命令历史记录失败:', err);
            const message = err.response?.data?.message || '清空历史记录时发生错误';
            uiNotificationsStore.showError(message);
        } finally {
            if (pendingClearOpSeq === clearOpSeq) {
                pendingClearOpSeq = null;
            }
        }
    };

    const setSearchTerm = (term: string) => {
        searchTerm.value = term;
        selectedIndex.value = -1;
    };

    const resetSelection = () => {
        selectedIndex.value = -1;
    };

    // 订阅后端同节点轻量化实时变更广播（300ms 防抖同步多标签页）
    let changeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeGlobal = subscribeGlobalEvent('command_history:changed', () => {
        if (changeRefreshTimer) {
            clearTimeout(changeRefreshTimer);
        }
        changeRefreshTimer = setTimeout(() => {
            changeRefreshTimer = null;
            void fetchHistory(true);
        }, 300);
    });

    const handleOnline = () => {
        flushPendingAdds();
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', handleOnline);
    }

    onScopeDispose(() => {
        unsubscribeGlobal();
        clearAllRetryTimers();
        if (changeRefreshTimer) {
            clearTimeout(changeRefreshTimer);
            changeRefreshTimer = null;
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('online', handleOnline);
        }
    });

    return {
        historyList,
        searchTerm,
        isLoading,
        error,
        hasLoadedFromServer,
        filteredHistory,
        selectedIndex,
        fetchHistory,
        addCommand,
        deleteCommand,
        clearAllHistory,
        flushPendingAdds,
        setSearchTerm,
        selectNextCommand,
        selectPreviousCommand,
        resetSelection,
    };
});
