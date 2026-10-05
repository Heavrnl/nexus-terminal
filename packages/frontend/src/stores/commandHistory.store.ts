import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import { ref, computed } from 'vue';
import { useUiNotificationsStore } from './uiNotifications.store'; // 用于显示通知

// 后端返回的原始历史记录条目接口
interface CommandHistoryEntryBE {
    id: number;
    command: string;
    timestamp: number; // Unix 时间戳 (秒)
}

// 前端使用的历史记录条目接口 (可能需要添加其他字段)
export interface CommandHistoryEntryFE extends CommandHistoryEntryBE {
    // 可以根据需要添加前端特定的字段
}

export const useCommandHistoryStore = defineStore('commandHistory', () => {
    const historyList = ref<CommandHistoryEntryFE[]>([]);
    const searchTerm = ref('');
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const uiNotificationsStore = useUiNotificationsStore();
    const selectedIndex = ref<number>(-1); //  Index of the selected command in the filtered list

    // --- Getters ---

    // 计算属性：根据搜索词过滤历史记录
    const filteredHistory = computed(() => {
        const term = searchTerm.value.toLowerCase().trim();
        if (!term) {
            return historyList.value; // 没有搜索词则返回全部
        }
        return historyList.value.filter(entry =>
            entry.command.toLowerCase().includes(term)
        );
    });

    // --- Actions ---

    //  Action to select the next command in the filtered list
    const selectNextCommand = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value + 1) % history.length;
    };

    //  Action to select the previous command in the filtered list
    const selectPreviousCommand = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value - 1 + history.length) % history.length;
    };

    const CACHE_KEY = 'commandHistoryCache';
    const MAX_STORED_HISTORY = 300;

    // 辅助函数：安全写入本地缓存
    const saveToCache = (list: CommandHistoryEntryFE[]) => {
        try {
            const trimmedList = list.slice(0, MAX_STORED_HISTORY);
            localStorage.setItem(CACHE_KEY, JSON.stringify(trimmedList));
        } catch (e) {
            console.warn('[CmdHistoryStore] 写入本地历史缓存失败:', e);
        }
    };

    // 从后端获取历史记录 (带缓存)
    const fetchHistory = async () => {
        error.value = null; // 重置错误

        // 1. 尝试从 localStorage 加载缓存
        try {
            const cachedData = localStorage.getItem(CACHE_KEY);
            if (cachedData) {
                const parsed = JSON.parse(cachedData);
                if (Array.isArray(parsed)) {
                    historyList.value = parsed.slice(0, MAX_STORED_HISTORY);
                    isLoading.value = false; // 先显示缓存
                }
            } else {
                isLoading.value = true; // 无缓存，初始加载
            }
        } catch (e) {
            console.error('[CmdHistoryStore] Failed to load or parse history cache:', e);
            localStorage.removeItem(CACHE_KEY);
            isLoading.value = true;
        }

        // 2. 后台获取最新数据
        try {
            const response = await apiClient.get<CommandHistoryEntryBE[]>('/command-history?limit=300');
            // 后端返回升序，前端需要降序（最新在前）
            const freshData = response.data.reverse().slice(0, MAX_STORED_HISTORY);

            // 3. 避免大数组 JSON.stringify 全量深度比对，使用轻量指纹快速检查是否有变动
            const current = historyList.value;
            const hasChanged = current.length !== freshData.length ||
                (freshData.length > 0 && current.length > 0 && (
                    current[0]?.id !== freshData[0]?.id ||
                    current[0]?.command !== freshData[0]?.command ||
                    current[current.length - 1]?.id !== freshData[freshData.length - 1]?.id
                )) || (current.length === 0 && freshData.length > 0);

            if (hasChanged) {
                historyList.value = freshData;
                saveToCache(freshData);
            }
            error.value = null;
        } catch (err: any) {
            console.error('[CmdHistoryStore] 获取命令历史记录失败:', err);
            error.value = err.response?.data?.message || '获取历史记录时发生错误';
            // 保留缓存数据，若没有缓存数据则提示用户
            if (historyList.value.length === 0) {
                uiNotificationsStore.showError(error.value ?? '未知错误');
            }
        } finally {
            isLoading.value = false;
        }
    };

    // 添加命令到历史记录 (乐观更新：即时内存去重并置顶，静默异步提交服务端)
    const addCommand = async (command: string) => {
        // 过滤 Ctrl+C 等终端控制信号
        if (command === '\x03') {
            return;
        }
        const trimmed = command ? command.trim() : '';
        if (!trimmed) {
            return;
        }

        // 1. 乐观更新本地内存：如果已存在则置顶，否则头部新增
        const existingIndex = historyList.value.findIndex(entry => entry.command === trimmed);
        let updatedEntry: CommandHistoryEntryFE;

        if (existingIndex !== -1) {
            // 如果已经在第一位且更新时间相近，无需重复操作
            const [existing] = historyList.value.splice(existingIndex, 1);
            existing.timestamp = Math.floor(Date.now() / 1000);
            updatedEntry = existing;
        } else {
            // 新指令，使用临时负数 ID 占位
            updatedEntry = {
                id: -Date.now(),
                command: trimmed,
                timestamp: Math.floor(Date.now() / 1000)
            };
        }

        // 插入到最前面（最新在前）
        historyList.value.unshift(updatedEntry);

        // 限制最大历史条数
        if (historyList.value.length > MAX_STORED_HISTORY) {
            historyList.value.length = MAX_STORED_HISTORY;
        }

        // 同步持久化到本地缓存
        saveToCache(historyList.value);

        // 2. 异步静默上报后端持久化，不阻塞、不再触发全量 fetchHistory()
        try {
            const response = await apiClient.post<{ id: number; command?: string; timestamp?: number }>(
                '/command-history',
                { command: trimmed }
            );
            if (response.data?.id) {
                // 回填后端生成的正式 ID
                updatedEntry.id = response.data.id;
                if (response.data.timestamp) {
                    updatedEntry.timestamp = response.data.timestamp;
                }
                saveToCache(historyList.value);
            }
        } catch (err: any) {
            console.warn('[CmdHistoryStore] 后台同步历史记录失败:', err?.message || err);
        }
    };

    // 删除单条历史记录 (乐观删除)
    const deleteCommand = async (id: number) => {
        // 1. 乐观更新本地内存与缓存
        const index = historyList.value.findIndex(entry => entry.id === id);
        if (index !== -1) {
            historyList.value.splice(index, 1);
            saveToCache(historyList.value);
        }

        // 2. 同步后端
        try {
            await apiClient.delete(`/command-history/${id}`);
            uiNotificationsStore.showSuccess('历史记录已删除');
        } catch (err: any) {
            console.error('删除命令历史记录失败:', err);
            const message = err.response?.data?.message || '删除历史记录时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 清空所有历史记录
    const clearAllHistory = async () => {
        historyList.value = [];
        localStorage.removeItem(CACHE_KEY);

        try {
            await apiClient.delete('/command-history');
            uiNotificationsStore.showSuccess('所有历史记录已清空');
        } catch (err: any) {
            console.error('清空命令历史记录失败:', err);
            const message = err.response?.data?.message || '清空历史记录时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 设置搜索词
    const setSearchTerm = (term: string) => {
        searchTerm.value = term;
        selectedIndex.value = -1; // Reset selection when search term changes
    };

    //  Action to reset the selection (Moved before return)
    const resetSelection = () => {
        selectedIndex.value = -1;
    };

    return {
        historyList,
        searchTerm,
        isLoading,
        error,
        filteredHistory,
        selectedIndex, //  Expose selected index
        fetchHistory,
        addCommand, // 导出 addCommand
        deleteCommand,
        clearAllHistory,
        setSearchTerm,
        selectNextCommand, //  Expose action
        selectPreviousCommand, //  Expose action
        resetSelection, // Ensure resetSelection is exported
    };

    // REMOVED resetSelection definition from here

    // REMOVED duplicate return block
});
