import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; 
import { ref, computed, watch } from 'vue'; 
import { useUiNotificationsStore } from './uiNotifications.store';
import { useQuickCommandTagsStore, type QuickCommandTag } from './quickCommandTags.store'; 
import { useI18n } from 'vue-i18n'; 



// 定义前端使用的快捷指令接口 (包含 tagIds)
export interface QuickCommandFE { // Renamed from QuickCommand if necessary
    id: number;
    name: string | null;
    command: string;
    usage_count: number;
    created_at: number;
    updated_at: number;
    tagIds: number[]; // +++ Add tagIds +++
    variables?: Record<string, string>; // New: Add variables
}

// 定义排序类型
export type QuickCommandSortByType = 'name' | 'usage_count' | 'last_used';

// 定义分组后的数据结构
export interface GroupedQuickCommands {
    groupName: string;
    tagId: number | null; // null for "Untagged" group
    commands: QuickCommandFE[];
}

// +++ localStorage key for expanded groups +++
const EXPANDED_GROUPS_STORAGE_KEY = 'quickCommandsExpandedGroups';

export const useQuickCommandsStore = defineStore('quickCommands', () => {
    const quickCommandsList = ref<QuickCommandFE[]>([]); // Should now contain QuickCommandFE with tagIds
    const searchTerm = ref('');
    const sortBy = ref<QuickCommandSortByType>('name'); // 默认按名称排序
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const uiNotificationsStore = useUiNotificationsStore();
    const quickCommandTagsStore = useQuickCommandTagsStore(); // +++ Inject new tag store +++
    const { t } = useI18n(); // +++ For "Untagged" translation +++
    const selectedIndex = ref<number>(-1); // Index in the flatVisibleCommands list

    // +++ State for expanded groups +++
    const expandedGroups = ref<Record<string, boolean>>({});

    // --- Getters ---

    // +++ 重写 Getter: 过滤、分组、排序指令 +++
    const filteredAndGroupedCommands = computed((): GroupedQuickCommands[] => {
        const term = searchTerm.value.toLowerCase().trim();
        const allTags = quickCommandTagsStore.tags; // 获取快捷指令专属标签
        const tagMap = new Map(allTags.map(tag => [tag.id, tag.name]));
        const untaggedGroupName = t('quickCommands.untagged', '未标记'); // 获取 "未标记" 的翻译

        // 1. 过滤 (New logic: filter by command name, command content, OR tag name)
        let filtered = quickCommandsList.value;
        if (term) {
            filtered = filtered.filter(cmd => {
                // Check command name
                if (cmd.name && cmd.name.toLowerCase().includes(term)) {
                    return true;
                }
                // Check command content
                if (cmd.command.toLowerCase().includes(term)) {
                    return true;
                }
                // Check associated tag names
                if (cmd.tagIds && cmd.tagIds.length > 0) {
                    for (const tagId of cmd.tagIds) {
                        const tagName = tagMap.get(tagId);
                        if (tagName && tagName.toLowerCase().includes(term)) {
                            return true; // Match found in tag name
                        }
                    }
                }
                // No match found
                return false;
            });
        }

        // 2. 分组
        const groups: Record<string, { commands: QuickCommandFE[], tagId: number | null }> = {};
        const untaggedCommands: QuickCommandFE[] = [];

        filtered.forEach(cmd => {
            let isTagged = false;
            if (cmd.tagIds && cmd.tagIds.length > 0) {
                cmd.tagIds.forEach(tagId => {
                    const tagName = tagMap.get(tagId);
                    if (tagName) {
                        if (!groups[tagName]) {
                            groups[tagName] = { commands: [], tagId: tagId };
                            // 初始化展开状态 (如果未定义，默认为 true)
                            if (expandedGroups.value[tagName] === undefined) {
                                expandedGroups.value[tagName] = true;
                            }
                        }
                        // 避免重复添加（如果一个指令有多个相同标签ID? 不太可能但做个防御）
                        if (!groups[tagName].commands.some(c => c.id === cmd.id)) {
                             groups[tagName].commands.push(cmd);
                        }
                        isTagged = true;
                    }
                });
            }
            if (!isTagged) {
                untaggedCommands.push(cmd);
            }
        });

        // 3. 排序分组内指令 & 格式化输出
        const sortedGroupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
        const result: GroupedQuickCommands[] = sortedGroupNames.map(groupName => {
            const groupData = groups[groupName];
            // 组内排序
            groupData.commands.sort((a, b) => {
                 if (sortBy.value === 'usage_count') {
                     if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
                 } else if (sortBy.value === 'last_used') {
                     if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
                 }
                 const nameA = a.name ?? a.command; // Fallback to command if name is null
                 const nameB = b.name ?? b.command;
                 return nameA.localeCompare(nameB);
            });
            return {
                groupName: groupName,
                tagId: groupData.tagId,
                commands: groupData.commands
            };
        });

        // 4. 处理未标记的分组
        if (untaggedCommands.length > 0) {
             // 初始化展开状态 (如果未定义，默认为 true)
             if (expandedGroups.value[untaggedGroupName] === undefined) {
                 expandedGroups.value[untaggedGroupName] = true;
             }
             // 组内排序
             untaggedCommands.sort((a, b) => {
                 if (sortBy.value === 'usage_count') {
                     if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
                 } else if (sortBy.value === 'last_used') {
                     if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
                 }
                 const nameA = a.name ?? a.command;
                 const nameB = b.name ?? b.command;
                 return nameA.localeCompare(nameB);
             });
             result.push({
                 groupName: untaggedGroupName,
                 tagId: null,
                 commands: untaggedCommands
             });
        }

        return result;
    });

    // +++ Getter: 获取当前可见的扁平指令列表 (用于键盘导航) +++
    const flatVisibleCommands = computed((): QuickCommandFE[] => {
        const flatList: QuickCommandFE[] = [];
        filteredAndGroupedCommands.value.forEach(group => {
            // 只添加已展开分组中的指令
            if (expandedGroups.value[group.groupName]) {
                flatList.push(...group.commands);
            }
        });
        return flatList;
    });


    // --- Actions ---

    // +++ Load initial expanded groups state from localStorage +++
    const loadExpandedGroups = () => {
        try {
            const storedState = localStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
            if (storedState) {
                const parsedState = JSON.parse(storedState);
                if (typeof parsedState === 'object' && parsedState !== null) {
                    expandedGroups.value = parsedState;
                    console.log('[QuickCmdStore] Loaded expanded groups state from localStorage.');
                    return;
                }
            }
        } catch (e) {
            console.error('[QuickCmdStore] Failed to load or parse expanded groups state:', e);
            localStorage.removeItem(EXPANDED_GROUPS_STORAGE_KEY);
        }
        // Default to empty object if no valid state found
        expandedGroups.value = {};
    };

    // +++ Save expanded groups state to localStorage +++
    const saveExpandedGroups = () => {
        try {
            localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify(expandedGroups.value));
        } catch (e) {
            console.error('[QuickCmdStore] Failed to save expanded groups state:', e);
        }
    };

    // +++ Watch for changes and save +++
    watch(expandedGroups, saveExpandedGroups, { deep: true });

    // +++ Action to toggle group expansion +++
    const toggleGroup = (groupName: string) => {
        // Ensure the group exists in the state before toggling
        if (expandedGroups.value[groupName] === undefined) {
             // Default to true if toggling a group that wasn't explicitly set (e.g., newly appeared group)
             expandedGroups.value[groupName] = false; // Start collapsed if toggled first time? Or true? Let's start true.
        } else {
             expandedGroups.value[groupName] = !expandedGroups.value[groupName];
        }
         // The watcher will automatically save the state
         // Reset selection when a group is toggled? Maybe not necessary.
         // selectedIndex.value = -1;
    };

    // Action to select the next command in the *visible* flat list
    const selectNextCommand = () => {
        const commands = flatVisibleCommands.value; // Use the flat visible list
        if (commands.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value + 1) % commands.length;
    };

    // Action to select the previous command in the *visible* flat list
    const selectPreviousCommand = () => {
        const commands = flatVisibleCommands.value; // Use the flat visible list
        if (commands.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value - 1 + commands.length) % commands.length;
    };

    // 从后端获取快捷指令 (包含 tagIds，不再发送 sortBy)
    const fetchQuickCommands = async () => {
        // 简化缓存：只缓存原始列表，不再区分排序
        const cacheKey = 'quickCommandsListCache';
        error.value = null;

        // 辅助函数：安全更新本地缓存
        const saveToCache = (list: QuickCommandFE[]) => {
            try {
                localStorage.setItem(cacheKey, JSON.stringify(list));
            } catch (e) {
                console.warn('[QuickCmdStore] 写入快捷指令缓存失败:', e);
            }
        };

        // 1. 尝试从 localStorage 加载缓存
        try {
            const cachedData = localStorage.getItem(cacheKey);
            if (cachedData) {
                const parsedData = JSON.parse(cachedData) as QuickCommandFE[];
                if (Array.isArray(parsedData)) {
                    quickCommandsList.value = parsedData;
                    isLoading.value = false;
                }
            } else {
                isLoading.value = true;
            }
        } catch (e) {
            console.error('[QuickCmdStore] Failed to load or parse commands cache:', e);
            localStorage.removeItem(cacheKey);
            isLoading.value = true;
        }

        // 2. 后台获取最新数据
        try {
            const response = await apiClient.get<QuickCommandFE[]>('/quick-commands');
            const freshData = response.data.map(cmd => ({
                ...cmd,
                tagIds: Array.isArray(cmd.tagIds) ? cmd.tagIds : [],
                variables: typeof cmd.variables === 'object' ? cmd.variables : undefined
            }));

            // 3. 轻量指纹快速比对，避免大数组深度 JSON.stringify
            const current = quickCommandsList.value;
            const hasChanged = current.length !== freshData.length ||
                (freshData.length > 0 && current.length > 0 && (
                    current[0]?.id !== freshData[0]?.id ||
                    current[0]?.updated_at !== freshData[0]?.updated_at ||
                    current[current.length - 1]?.id !== freshData[freshData.length - 1]?.id
                )) || (current.length === 0 && freshData.length > 0);

            if (hasChanged) {
                quickCommandsList.value = freshData;
                saveToCache(freshData);
            }
            error.value = null;
        } catch (err: any) {
            console.error('[QuickCmdStore] 获取快捷指令失败:', err);
            error.value = err.response?.data?.message || '获取快捷指令时发生错误';
            if (quickCommandsList.value.length === 0 && error.value) {
                uiNotificationsStore.showError(error.value);
            }
        } finally {
            isLoading.value = false;
        }
    };

    // 清除快捷指令列表缓存
    const clearQuickCommandsCache = () => {
        localStorage.removeItem('quickCommandsListCache');
    };

    // 添加快捷指令 (原地追加，避免全量重新请求)
    const addQuickCommand = async (name: string | null, command: string, tagIds?: number[], variables?: Record<string, string>): Promise<boolean> => {
        try {
            const response = await apiClient.post<{ message: string, command: QuickCommandFE }>('/quick-commands', { name, command, tagIds, variables });
            if (response.data?.command) {
                const newCmd: QuickCommandFE = {
                    ...response.data.command,
                    tagIds: Array.isArray(response.data.command.tagIds) ? response.data.command.tagIds : (tagIds || []),
                    variables: response.data.command.variables || variables
                };
                quickCommandsList.value.push(newCmd);
                try {
                    localStorage.setItem('quickCommandsListCache', JSON.stringify(quickCommandsList.value));
                } catch (e) {}
            }
            uiNotificationsStore.showSuccess('快捷指令已添加');
            return true;
        } catch (err: any) {
            console.error('添加快捷指令失败:', err);
            const message = err.response?.data?.message || '添加快捷指令时发生错误';
            uiNotificationsStore.showError(message);
            return false;
        }
    };

    // 更新快捷指令 (原地替换，避免全量重新请求)
    const updateQuickCommand = async (id: number, name: string | null, command: string, tagIds?: number[], variables?: Record<string, string>): Promise<boolean> => {
         try {
            const response = await apiClient.put<{ message: string, command: QuickCommandFE }>(`/quick-commands/${id}`, { name, command, tagIds, variables });
            const index = quickCommandsList.value.findIndex(cmd => cmd.id === id);
            if (index !== -1 && response.data?.command) {
                quickCommandsList.value[index] = {
                    ...quickCommandsList.value[index],
                    ...response.data.command,
                    tagIds: Array.isArray(response.data.command.tagIds) ? response.data.command.tagIds : (tagIds || []),
                    variables: response.data.command.variables || variables
                };
                try {
                    localStorage.setItem('quickCommandsListCache', JSON.stringify(quickCommandsList.value));
                } catch (e) {}
            }
            uiNotificationsStore.showSuccess('快捷指令已更新');
            return true;
        } catch (err: any) {
            console.error('更新快捷指令失败:', err);
            const message = err.response?.data?.message || '更新快捷指令时发生错误';
            uiNotificationsStore.showError(message);
            return false;
        }
    };

    // 删除快捷指令 (本地优先响应)
    const deleteQuickCommand = async (id: number) => {
        // 1. 本地立即移除
        const index = quickCommandsList.value.findIndex(cmd => cmd.id === id);
        if (index !== -1) {
            quickCommandsList.value.splice(index, 1);
            try {
                localStorage.setItem('quickCommandsListCache', JSON.stringify(quickCommandsList.value));
            } catch (e) {}
        }

        // 2. 异步同步后端
        try {
            await apiClient.delete(`/quick-commands/${id}`);
            uiNotificationsStore.showSuccess('快捷指令已删除');
        } catch (err: any) {
            console.error('删除快捷指令失败:', err);
            const message = err.response?.data?.message || '删除快捷指令时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 增加使用次数 (本地响应式自增，彻底消除全量重拉，静默上报后台)
    const incrementUsage = async (id: number) => {
        const command = quickCommandsList.value.find(cmd => cmd.id === id);
        if (command) {
            command.usage_count += 1;
            command.updated_at = Math.floor(Date.now() / 1000);
            try {
                localStorage.setItem('quickCommandsListCache', JSON.stringify(quickCommandsList.value));
            } catch (e) {}
        }
        // 静默异步上报后台，无额外等待与网络抖动
        apiClient.post(`/quick-commands/${id}/increment-usage`).catch(err => {
            console.warn('[QuickCmdStore] 增加使用次数同步失败:', err?.message || err);
        });
    };

    // 设置搜索词
    const setSearchTerm = (term: string) => {
        searchTerm.value = term;
        selectedIndex.value = -1; // Reset selection when search term changes
    };

    // 设置排序方式 (只更新本地状态，不再重新获取数据)
    const setSortBy = (newSortBy: QuickCommandSortByType) => {
        if (sortBy.value !== newSortBy) {
            sortBy.value = newSortBy;
            // 排序现在由 filteredAndGroupedCommands getter 处理，无需重新 fetch
            selectedIndex.value = -1; // Reset selection when sort changes
        }
    };

    //  Action to reset the selection
    const resetSelection = () => {
        selectedIndex.value = -1;
    };

    // Removed duplicate resetSelection definition

    return {
        quickCommandsList,
        searchTerm,
        sortBy,
        isLoading,
        error,
        filteredAndGroupedCommands, // Expose the grouped data
        flatVisibleCommands, // Expose the flat visible list for navigation logic if needed outside
        selectedIndex, // Index within flatVisibleCommands
        expandedGroups, // Expose expanded groups state
        fetchQuickCommands,
        addQuickCommand,
        updateQuickCommand,
        deleteQuickCommand,
        incrementUsage,
        setSearchTerm,
        setSortBy,
        selectNextCommand,
        selectPreviousCommand,
        resetSelection,
        toggleGroup, // +++ Expose toggleGroup action +++
        loadExpandedGroups, // +++ Expose load action +++

        // +++ Action to assign a tag to multiple commands +++
        async assignCommandsToTagAction(commandIds: number[], tagId: number): Promise<boolean> {
            if (!commandIds || commandIds.length === 0) {
                console.warn('[Store] assignCommandsToTagAction: No command IDs provided.');
                return false;
            }
            isLoading.value = true; // Use the store's isLoading state
            error.value = null; // Use the store's error state
            try {
                const response = await apiClient.post('/quick-commands/bulk-assign-tag', { commandIds, tagId });
                if (response.data.success) {
                    console.log(`[Store] Successfully assigned tag ${tagId} to ${commandIds.length} commands via API.`);

                    // --- Manual state update for immediate UI feedback ---
                    let updatedCount = 0;
                    commandIds.forEach(cmdId => {
                        const commandIndex = quickCommandsList.value.findIndex(cmd => cmd.id === cmdId);
                        if (commandIndex !== -1) {
                            const command = quickCommandsList.value[commandIndex];
                            // Ensure tagIds exists and add the new tagId if not already present
                            if (!Array.isArray(command.tagIds)) {
                                command.tagIds = [];
                            }
                            if (!command.tagIds.includes(tagId)) {
                                command.tagIds.push(tagId);
                                updatedCount++;
                            }
                        } else {
                             console.warn(`[Store] assignCommandsToTagAction: Command ID ${cmdId} not found in local list for manual update.`);
                        }
                    });
                    console.log(`[Store] Manually updated tagIds for ${updatedCount} commands in local state.`);

                    // Optionally, still fetch for full consistency, but UI should update based on manual change first.
                    // clearQuickCommandsCache();
                    // await fetchQuickCommands();
                    return true;
                } else {
                    // This case might not happen if backend throws errors instead
                    error.value = response.data.message || '批量分配标签失败 (未知)';
                    if (error.value) uiNotificationsStore.showError(error.value); // Check if error.value is not null
                    return false;
                }
            } catch (err: any) {
                console.error('[Store] Error assigning tag to commands:', err);
                error.value = err.response?.data?.message || err.message || '批量分配标签时发生网络或服务器错误';
                if (error.value) uiNotificationsStore.showError(error.value); // Check if error.value is not null
                return false;
            } finally {
                isLoading.value = false;
            }
        },
    };
});
