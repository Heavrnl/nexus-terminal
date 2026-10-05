import { ref, computed, readonly, watch, nextTick } from 'vue'; 
import { defineStore } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from './session.store'; 
import type { SaveStatus, SftpReadFileSuccessPayload } from '../types/sftp.types'; 
import * as iconv from '@vscode/iconv-lite-umd'; 
import { Buffer } from 'buffer/'; 

// --- 类型定义 ---
// 文件信息，用于打开文件操作
export interface FileInfo {
  name: string;
  fullPath: string;
}

// 编辑器标签页状态
// 编辑器标签页状态 (简化)
export interface FileTab {
    id: string;
    sessionId: string;
    filePath: string;
    filename: string;
    content: string; // 当前解码后的内容 (前端解码)
    originalContent: string; // 初始加载或上次保存时解码后的内容 (前端解码)
    rawContentBase64: string | null; // +++ 存储原始 Base64 数据 +++
    language: string;
    selectedEncoding: string; // 当前选择或自动检测到的编码
    isLoading: boolean;
    loadingError: string | null;
    isSaving: boolean;
    saveStatus: SaveStatus;
    saveError: string | null;
    isModified: boolean;
    scrollTop?: number; // 编辑器垂直滚动位置
    scrollLeft?: number; // 编辑器水平滚动位置
    remoteMtime?: number; // 最近一次已知的远端修改时间戳 (ms)
    remoteSize?: number; // 最近一次已知的远端文件大小 (bytes)
    hasExternalConflict?: boolean; // 远端变动且本地有未保存编辑时的冲突标记
}

// --- 辅助函数 (移到外部并导出) ---
export const getLanguageFromFilename = (filename: string): string => {
    const extension = filename.split('.').pop()?.toLowerCase();
    switch (extension) {
        case 'js': return 'javascript';
        case 'ts': return 'typescript';
        case 'json': return 'json';
        case 'html': return 'html';
        case 'css': return 'css';
        case 'scss': return 'scss';
        case 'less': return 'less';
        case 'py': return 'python';
        case 'java': return 'java';
        case 'c': return 'c';
        case 'cpp': return 'cpp';
        case 'cs': return 'csharp';
        case 'go': return 'go';
        case 'php': return 'php';
        case 'rb': return 'ruby';
        case 'rs': return 'rust';
        case 'sql': return 'sql';
        case 'sh': return 'shell';
        case 'yaml': case 'yml': return 'yaml';
        case 'md': return 'markdown';
        case 'xml': return 'xml';
        case 'ini': return 'ini';
        case 'conf': return 'ini';
        case 'bat': return 'bat';
        case 'dockerfile': return 'dockerfile';
        default: return 'plaintext';
    }
};

export const getFilenameFromPath = (filePath: string): string => {
    return filePath.split('/').pop() || filePath;
};

// +++ 前端解码辅助函数 +++
const decodeRawContent = (rawContentBase64: string, encoding: string): string => {
    try {
        const buffer = Buffer.from(rawContentBase64, 'base64');
        const normalizedEncoding = encoding.toLowerCase().replace(/[^a-z0-9]/g, ''); // Normalize encoding name

        // 优先使用 TextDecoder 处理标准编码
        if (['utf8', 'utf16le', 'utf16be'].includes(normalizedEncoding)) {
            const decoder = new TextDecoder(encoding); // Use original encoding name for TextDecoder
            return decoder.decode(buffer);
        }
        // 使用 iconv-lite 处理其他编码
        else if (iconv.encodingExists(normalizedEncoding)) {
            return iconv.decode(buffer, normalizedEncoding);
        }
        // 如果 iconv-lite 也不支持，回退到 UTF-8 并警告
        else {
            console.warn(`[decodeRawContent] Unsupported encoding "${encoding}" requested. Falling back to UTF-8.`);
            const decoder = new TextDecoder('utf-8');
            return decoder.decode(buffer);
        }
    } catch (error: any) {
        console.error(`[decodeRawContent] Error decoding content with encoding "${encoding}":`, error);
        return `// Error decoding content: ${error.message}`; // 返回错误信息
    }
};


export const useFileEditorStore = defineStore('fileEditor', () => {
    const { t } = useI18n();
    const sessionStore = useSessionStore();

    // --- 多标签状态 ---
    const tabs = ref(new Map<string, FileTab>()); // 存储所有打开的标签页 (使用 FileTab)
    const activeTabId = ref<string | null>(null); // 当前激活的标签页 ID
    // const editorVisibleState = ref<'visible' | 'minimized' | 'closed'>('closed'); // 移除，面板可见性由布局控制
    const popupTrigger = ref(0); // 用于触发弹窗显示的信号
    const popupFileInfo = ref<{ filePath: string; sessionId: string } | null>(null); // 存储弹窗文件信息

    // --- 计算属性 ---
    const orderedTabs = computed(() => Array.from(tabs.value.values())); // 获取标签页数组，用于渲染
    const activeTab = computed(() => {
        if (!activeTabId.value) return null;
        return tabs.value.get(activeTabId.value) || null;
    });
    // 提供给 MonacoEditor 的内容绑定
    const activeEditorContent = computed({
        get: () => activeTab.value?.content ?? '',
        set: (value) => {
            if (activeTab.value) {
                // 调用新的 updateFileContent action，并传递 tabId
                updateFileContent(activeTab.value.id, value);
            }
        },
    });

    // --- 移除 decodeBase64Content 辅助方法 ---


    // --- 核心方法 ---

    // 修改：triggerPopup 接收文件信息并存储
    const triggerPopup = (filePath: string, sessionId: string) => {
        console.log(`[文件编辑器 Store] Triggering popup for ${filePath} in session ${sessionId}.`);
        popupFileInfo.value = { filePath, sessionId };
        popupTrigger.value++; // 增加触发器值以通知监听者
    };

    // 移除内部的 getSftpManager 辅助函数，将直接使用 sessionStore.getOrCreateSftpManager
    // const getSftpManager = (sessionId: string | null) => { ... };

    // 移除 setEditorVisibility 方法
    // const setEditorVisibility = ...

    // 打开或切换到文件标签页
    // 修改：添加 instanceId 参数
    const openFile = async (targetFilePath: string, sessionId: string, instanceId: string) => {
        // 在共享模式下，我们仍然需要 sessionId 来构建唯一的 tabId
        // 并与 SFTP 管理器关联
        const tabId = `${sessionId}:${targetFilePath}`; // Tab ID 仍然基于 sessionId 和 filePath 保持唯一性
        console.log(`[文件编辑器 Store - 共享模式] 尝试打开文件: ${targetFilePath} (会话: ${sessionId}, 实例: ${instanceId}, Tab ID: ${tabId})`);

        // 移除确保编辑器可见的逻辑
        // if (editorVisibleState.value === 'closed') {
        //     setEditorVisibility('visible');
        // }

        // 如果标签页已存在，则激活它
        if (tabs.value.has(tabId)) {
            console.log(`[文件编辑器 Store] 标签页 ${tabId} 已存在，激活它。`);
            setActiveTab(tabId);
            // 触发弹窗 (如果设置允许)
            popupTrigger.value++;
            return;
        }

        // 创建新标签页 (使用简化后的 FileTab)
        const newTab: FileTab = {
            id: tabId,
            sessionId: sessionId,
            filePath: targetFilePath,
            filename: getFilenameFromPath(targetFilePath),
            content: '', // 将在加载后由前端解码填充
            originalContent: '', // 将在加载后由前端解码填充
            rawContentBase64: null, // +++ 初始化为 null +++
            language: getLanguageFromFilename(targetFilePath),
            selectedEncoding: 'utf-8', // 初始默认，将由后端更新
            isLoading: true,
            loadingError: null,
            isSaving: false,
            saveStatus: 'idle',
            saveError: null,
            isModified: false,
            scrollTop: 0, // 初始化滚动位置
            scrollLeft: 0, // 初始化滚动位置
        };
        tabs.value.set(tabId, newTab);
        // setActiveTab(tabId); // 移除同步激活

        // 使用 nextTick 延迟激活，给 DOM 更新留出时间
        nextTick(() => {
            setActiveTab(tabId);
        });

        // 不再在这里触发弹窗
        // popupTrigger.value++;

        // 获取 SFTP 管理器 - 修改：使用 sessionStore.getOrCreateSftpManager 并传入 instanceId
        const sftpManager = sessionStore.getOrCreateSftpManager(sessionId, instanceId);
        if (!sftpManager) {
            // 错误消息保持不变，但现在知道是哪个实例找不到管理器
            console.error(`[文件编辑器 Store] 无法找到会话 ${sessionId} (实例 ${instanceId}) 的 SFTP 管理器。`);
            const tabToUpdate = tabs.value.get(tabId);
            if (tabToUpdate) {
                tabToUpdate.isLoading = false;
                tabToUpdate.loadingError = t('fileManager.errors.sftpManagerNotFound'); // 可以考虑添加 instanceId 到错误消息
            }
            return;
        }

        // 读取文件内容
        try {
            // 调用 sftpManager.readFile 获取原始数据和编码
            const fileData: SftpReadFileSuccessPayload = await sftpManager.readFile(targetFilePath);
            console.log(`[文件编辑器 Store] 文件 ${targetFilePath} 原始数据读取成功。后端使用编码: ${fileData.encodingUsed}`);

            const tabToUpdate = tabs.value.get(tabId);
            if (!tabToUpdate) {
                 console.error(`[文件编辑器 Store] 无法更新标签页 ${tabId}，因为它在加载完成前被关闭了。`);
                 return;
            }

            // +++ 前端解码 +++
            const initialContent = decodeRawContent(fileData.rawContentBase64, fileData.encodingUsed);

            // 更新标签页状态
            const updatedTab: FileTab = {
                ...tabToUpdate,
                rawContentBase64: fileData.rawContentBase64, // 存储原始数据
                content: initialContent,
                originalContent: initialContent, // 初始原始内容
                selectedEncoding: fileData.encodingUsed, // 存储后端实际使用的编码
                isLoading: false,
                isModified: false,
                loadingError: null,
            };
            tabs.value.set(tabId, updatedTab); // 替换以确保响应性

            console.log(`[文件编辑器 Store] 文件 ${targetFilePath} 内容已解码 (${fileData.encodingUsed}) 并设置到标签页 ${tabId}。`);

            sftpManager.stat(targetFilePath).then((stats) => {
                const cur = tabs.value.get(tabId);
                if (cur) {
                    cur.remoteMtime = stats.mtime;
                    cur.remoteSize = stats.size;
                }
            }).catch(() => {
                const cur = tabs.value.get(tabId);
                if (cur) {
                    cur.remoteMtime = Date.now();
                }
            }).finally(() => {
                startFileWatcher();
            });

        } catch (err: any) {
            console.error(`[文件编辑器 Store] 读取文件 ${targetFilePath} 失败:`, err);
            const errorMsg = `${t('fileManager.errors.readFileFailed')}: ${err.message || err}`;
            const tabToUpdate = tabs.value.get(tabId);
            if (tabToUpdate) {
                tabToUpdate.isLoading = false;
                tabToUpdate.loadingError = errorMsg;
                tabToUpdate.content = `// ${errorMsg}`; // 在编辑器中显示错误
            }
        }
    };

    // 保存指定（或当前激活）标签页的文件
    const saveFile = async (tabIdToSave?: string) => {
        const targetTabId = tabIdToSave ?? activeTabId.value;
        if (!targetTabId) {
            console.warn('[文件编辑器 Store] 保存失败：没有活动的标签页。');
            return;
        }

        const tab = tabs.value.get(targetTabId);
        if (!tab) {
            console.warn(`[文件编辑器 Store] 保存失败：找不到标签页 ${targetTabId}。`);
            return;
        }

        if (tab.isSaving || tab.isLoading || tab.loadingError) {
            console.warn(`[文件编辑器 Store] 保存条件不满足 for ${tab.filePath}，无法保存。`, { tab });
            return;
        }

        // 检查会话是否存在且连接
        const session = sessionStore.sessions.get(tab.sessionId);
        if (!session || !session.wsManager.isConnected.value || !session.wsManager.isSftpReady.value) {
            console.error(`[文件编辑器 Store] 保存失败：会话 ${tab.sessionId} 无效或未连接/SFTP 未就绪。`);
            tab.saveStatus = 'error';
            tab.saveError = t('fileManager.errors.sessionInvalidOrNotReady'); // 需要添加新的翻译
             // 可以在这里添加一个短暂的错误提示
            setTimeout(() => {
                if (tab.saveStatus === 'error') {
                    tab.saveStatus = 'idle';
                    tab.saveError = null;
                }
            }, 5000);
            return;
        }

        // 修改：从 sftpManagers Map 获取第一个可用的管理器
        const sftpManagersMap = session.sftpManagers;
        if (!sftpManagersMap || sftpManagersMap.size === 0) {
             console.error(`[文件编辑器 Store] 保存失败：会话 ${tab.sessionId} 没有可用的 SFTP 管理器实例。`);
             tab.saveStatus = 'error';
             tab.saveError = t('fileManager.errors.sftpManagerNotFound'); // 复用错误消息
             // 添加短暂错误提示
             setTimeout(() => {
                 if (tab.saveStatus === 'error') {
                     tab.saveStatus = 'idle';
                     tab.saveError = null;
                 }
             }, 5000);
             return;
        }
        // 获取 Map 中的第一个条目 [instanceId, sftpManager]
        const firstEntry = sftpManagersMap.entries().next().value;

        // +++ 检查是否成功获取到条目 +++
        if (!firstEntry || firstEntry.length < 2) {
            console.error(`[文件编辑器 Store] 保存失败：无法从会话 ${tab.sessionId} 的 sftpManagers Map 中获取任何 SFTP 管理器条目。`);
            tab.saveStatus = 'error';
            tab.saveError = t('fileManager.errors.sftpManagerNotFound'); // 复用错误消息
            // 添加短暂错误提示
            setTimeout(() => {
                if (tab.saveStatus === 'error') {
                    tab.saveStatus = 'idle';
                    tab.saveError = null;
                }
            }, 5000);
            return;
        }

        const [instanceId, sftpManager] = firstEntry; // 解构获取 instanceId 和 sftpManager

        // +++ 再次检查 sftpManager 是否有效 (虽然理论上 Map 不应存储 undefined 值) +++
        if (!sftpManager) {
             console.error(`[文件编辑器 Store] 保存失败：从会话 ${tab.sessionId} 的 sftpManagers Map 获取到的 SFTP 管理器实例无效 (instanceId: ${instanceId})。`);
             tab.saveStatus = 'error';
             tab.saveError = t('fileManager.errors.sftpManagerNotFound');
             setTimeout(() => { if (tab.saveStatus === 'error') { tab.saveStatus = 'idle'; tab.saveError = null; } }, 5000);
             return;
        }
        // --- 检查结束 ---

        console.log(`[文件编辑器 Store] 开始保存文件: ${tab.filePath} (Tab ID: ${tab.id}) 使用实例 ${instanceId}`); // 使用解构出的 instanceId
        tab.isSaving = true;
        tab.saveStatus = 'saving';
        tab.saveError = null;

        const contentToSave = tab.content;
        const encodingToUse = tab.selectedEncoding; // 获取选定的编码

        try {
            // --- 修改：传递 selectedEncoding 给 writeFile ---
            await sftpManager.writeFile(tab.filePath, contentToSave, encodingToUse);
            console.log(`[文件编辑器 Store] 文件 ${tab.filePath} 使用编码 ${encodingToUse} 保存成功。`);
            tab.isSaving = false;
            tab.saveStatus = 'success';
            tab.saveError = null;
            tab.originalContent = contentToSave; // 更新原始内容
            tab.isModified = false; // 重置修改状态
            tab.hasExternalConflict = false; // 清除冲突标记

            // 刷新本地已知的远端状态，避免自保存被误判为外部变动
            sftpManager.stat(tab.filePath).then((stats) => {
                tab.remoteMtime = stats.mtime;
                tab.remoteSize = stats.size;
            }).catch(() => {
                tab.remoteMtime = Date.now();
            });

            setTimeout(() => {
                if (tab.saveStatus === 'success') {
                    tab.saveStatus = 'idle';
                }
            }, 2000);

        } catch (err: any) {
            console.error(`[文件编辑器 Store] 保存文件 ${tab.filePath} 失败:`, err);
            tab.isSaving = false;
            tab.saveStatus = 'error';
            tab.saveError = `${t('fileManager.errors.saveFailed')}: ${err.message || err}`;

            setTimeout(() => {
                if (tab.saveStatus === 'error') {
                    tab.saveStatus = 'idle';
                    tab.saveError = null;
                }
            }, 5000);
        }
    };

    // 关闭指定标签页
    const closeTab = (tabId: string) => {
        const tabToClose = tabs.value.get(tabId);
        if (!tabToClose) return;

        // 简单处理：如果修改过，提醒用户（实际应用可能需要更复杂的确认对话框）
        if (tabToClose.isModified) {
            // 这里可以集成 UI 通知库来提示
            console.warn(`[文件编辑器 Store] 标签页 ${tabId} (${tabToClose.filename}) 已修改但未保存。正在关闭...`);
        }

        console.log(`[文件编辑器 Store] 关闭标签页: ${tabId}`);
        tabs.value.delete(tabId);

        // 如果关闭的是当前激活的标签页，则切换到另一个标签页
        if (activeTabId.value === tabId) {
            const remainingTabs = Array.from(tabs.value.keys());
            if (remainingTabs.length > 0) {
                // 简单切换到最后一个标签页
                 setActiveTab(remainingTabs[remainingTabs.length - 1]);
             } else {
                 activeTabId.value = null; // 没有标签页了
                 // setEditorVisibility('closed'); // 移除：容器可见性由外部控制
             }
         }
         // 如果关闭的不是活动标签页，或者活动标签页已成功切换，检查是否需要关闭容器
         else if (tabs.value.size === 0) {
              // setEditorVisibility('closed'); // 移除：容器可见性由外部控制
         }
     };

    // 关闭所有标签页
    const closeAllTabs = () => {
        // 简单处理：直接关闭所有，不检查修改状态（实际应用需要确认）
         console.log('[文件编辑器 Store] 关闭所有标签页...');
         tabs.value.clear();
         activeTabId.value = null;
         // setEditorVisibility('closed'); // 移除：容器可见性由外部控制
     };

   // +++ 关闭其他标签页 +++
   const closeOtherTabs = (targetTabId: string) => {
       console.log(`[文件编辑器 Store] closeOtherTabs: Action called. Current keys in tabs map:`, Array.from(tabs.value.keys())); // ++ Log current keys at start
       if (!tabs.value.has(targetTabId)) {
           console.warn(`[文件编辑器 Store] closeOtherTabs: 目标 ID ${targetTabId} 在 Map 中不存在。`); // Updated warning
           return;
       }
       console.log(`[文件编辑器 Store] closeOtherTabs: 开始关闭除 ${targetTabId} 之外的所有标签页...`);
       const tabsToClose = Array.from(tabs.value.keys()).filter(id => id !== targetTabId);
       console.log(`[文件编辑器 Store] closeOtherTabs: 将要关闭的标签页 IDs:`, tabsToClose); // + Log IDs to close
       tabsToClose.forEach(id => {
           console.log(`[文件编辑器 Store] closeOtherTabs: 正在调用 closeTab 关闭 ${id}`); // + Log loop iteration
           closeTab(id);
       });
   };

   // +++ 关闭右侧标签页 +++
   const closeTabsToTheRight = (targetTabId: string) => {
       const tabsArray = Array.from(tabs.value.values());
       const targetIndex = tabsArray.findIndex(tab => tab.id === targetTabId);
       console.log(`[文件编辑器 Store] closeTabsToTheRight: Action called. Current keys in tabs map:`, Array.from(tabs.value.keys())); // ++ Log current keys at start
       if (targetIndex === -1) {
            console.warn(`[文件编辑器 Store] closeTabsToTheRight: 目标 ID ${targetTabId} 未找到索引。`);
           return;
       }
       console.log(`[文件编辑器 Store] closeTabsToTheRight: 开始关闭 ${targetTabId} (索引 ${targetIndex}) 右侧的所有标签页...`);
       const tabsToClose = tabsArray.slice(targetIndex + 1).map(tab => tab.id);
        console.log(`[文件编辑器 Store] closeTabsToTheRight: 将要关闭的标签页 IDs:`, tabsToClose); // + Log IDs to close
       tabsToClose.forEach(id => {
           console.log(`[文件编辑器 Store] closeTabsToTheRight: 正在调用 closeTab 关闭 ${id}`); // + Log loop iteration
           closeTab(id);
       });
   };

   // +++ 关闭左侧标签页 +++
   const closeTabsToTheLeft = (targetTabId: string) => {
       const tabsArray = Array.from(tabs.value.values());
       const targetIndex = tabsArray.findIndex(tab => tab.id === targetTabId);
        console.log(`[文件编辑器 Store] closeTabsToTheLeft: Action called. Current keys in tabs map:`, Array.from(tabs.value.keys())); // ++ Log current keys at start
        if (targetIndex === -1) {
           console.warn(`[文件编辑器 Store] closeTabsToTheLeft: 目标 ID ${targetTabId} 未找到索引。`);
           return;
       }
       console.log(`[文件编辑器 Store] closeTabsToTheLeft: 开始关闭 ${targetTabId} (索引 ${targetIndex}) 左侧的所有标签页...`);
       const tabsToClose = tabsArray.slice(0, targetIndex).map(tab => tab.id);
       console.log(`[文件编辑器 Store] closeTabsToTheLeft: 将要关闭的标签页 IDs:`, tabsToClose); // + Log IDs to close
       tabsToClose.forEach(id => {
           console.log(`[文件编辑器 Store] closeTabsToTheLeft: 正在调用 closeTab 关闭 ${id}`); // + Log loop iteration
           closeTab(id);
       });
   };


   // 设置当前激活的标签页
   const setActiveTab = (tabId: string) => {
        if (tabs.value.has(tabId)) {
            activeTabId.value = tabId;
            console.log(`[文件编辑器 Store] 激活标签页: ${tabId}`);
            // 移除：切换标签不应改变容器可见性状态
            // if (editorVisibleState.value === 'closed' || editorVisibleState.value === 'minimized') {
            //     setEditorVisibility('visible');
            // }
        } else {
            console.warn(`[文件编辑器 Store] 尝试激活不存在的标签页: ${tabId}`);
        }
    };

    // 更新指定标签页的内容 (由 FileEditorContainer 的 v-model 触发)
    const updateFileContent = (tabId: string, newContent: string) => {
        const tab = tabs.value.get(tabId);
        if (tab && !tab.isLoading) {
            tab.content = newContent;
            // 检查是否修改
            tab.isModified = tab.content !== tab.originalContent;
            // 当用户编辑时，重置保存状态
            if (tab.saveStatus === 'success' || tab.saveStatus === 'error') {
                tab.saveStatus = 'idle';
                tab.saveError = null;
            }
        }
    };

    // +++ 修改：更改文件编码（通过请求后端重新读取） +++
    // +++ 修改：changeEncoding 现在在前端解码 +++
    const changeEncoding = (tabId: string, newEncoding: string) => {
        const tab = tabs.value.get(tabId);
        if (!tab) {
            console.warn(`[文件编辑器 Store] 尝试更改不存在的标签页 ${tabId} 的编码。`);
            return;
        }
        if (!tab.rawContentBase64) {
            console.error(`[文件编辑器 Store] 无法更改编码：标签页 ${tabId} 没有原始文件数据。`);
            // 可以设置错误状态
            tab.loadingError = '缺少原始文件数据，无法更改编码';
            return;
        }
        if (tab.selectedEncoding === newEncoding) {
            console.log(`[文件编辑器 Store] 编码已经是 ${newEncoding}，无需更改。`);
            return;
        }

        console.log(`[文件编辑器 Store] 使用新编码 "${newEncoding}" 在前端重新解码文件: ${tab.filePath} (Tab ID: ${tabId})`);

        // 设置加载状态（可选，解码通常很快，但可以防止 UI 闪烁）
        // tab.isLoading = true;
        // tab.loadingError = null;

        try {
            // 使用新编码解码存储的原始数据
            const newContent = decodeRawContent(tab.rawContentBase64, newEncoding);

            // 更新标签页状态
            const updatedTab: FileTab = {
                ...tab,
                content: newContent,
                selectedEncoding: newEncoding, // 更新选择的编码
                isLoading: false, // 解码完成
                loadingError: null,
                // isModified 状态保持不变
            };
            tabs.value.set(tabId, updatedTab);
            console.log(`[文件编辑器 Store] 文件 ${tab.filePath} 使用新编码 "${newEncoding}" 解码完成。`);

        } catch (err: any) { // catch 应该在 decodeRawContent 内部处理了，但以防万一
            console.error(`[文件编辑器 Store] 使用编码 "${newEncoding}" 在前端解码文件 ${tab.filePath} 失败:`, err);
            const errorMsg = `前端解码失败 (编码: ${newEncoding}): ${err.message || err}`;
            // 更新错误状态
             const errorTab: FileTab = {
                ...tab,
                isLoading: false,
                loadingError: errorMsg,
            };
            tabs.value.set(tabId, errorTab);
        }
        // finally {
        //     if (tab) tab.isLoading = false; // 确保加载状态被重置
        // }
    };

    // +++ 更新标签页滚动位置 +++
    const updateTabScrollPosition = (tabId: string, scrollTop: number, scrollLeft: number) => {
        const tab = tabs.value.get(tabId);
        if (tab) {
            tab.scrollTop = scrollTop;
            tab.scrollLeft = scrollLeft;
        }
    };

    // +++ 重新加载文件（从远端拉取最新数据） +++
    const reloadFile = async (tabId: string, silent = false): Promise<boolean> => {
        const tab = tabs.value.get(tabId);
        if (!tab) return false;

        const session = sessionStore.sessions.get(tab.sessionId);
        if (!session) return false;

        const sftpManagersMap = session.sftpManagers;
        if (!sftpManagersMap || sftpManagersMap.size === 0) return false;
        const firstEntry = sftpManagersMap.entries().next().value;
        if (!firstEntry || !firstEntry[1]) return false;
        const sftpManager = firstEntry[1];

        try {
            const fileData: SftpReadFileSuccessPayload = await sftpManager.readFile(tab.filePath, tab.selectedEncoding);
            const currentTab = tabs.value.get(tabId);
            if (!currentTab) return false;

            const newContent = decodeRawContent(fileData.rawContentBase64, fileData.encodingUsed);

            currentTab.rawContentBase64 = fileData.rawContentBase64;
            currentTab.content = newContent;
            currentTab.originalContent = newContent;
            currentTab.isModified = false;
            currentTab.hasExternalConflict = false;

            // 同步刷新远端 mtime 和 size
            sftpManager.stat(tab.filePath).then((stats) => {
                const cur = tabs.value.get(tabId);
                if (cur) {
                    cur.remoteMtime = stats.mtime;
                    cur.remoteSize = stats.size;
                }
            }).catch(() => {
                const cur = tabs.value.get(tabId);
                if (cur) {
                    cur.remoteMtime = Date.now();
                }
            });

            console.log(`[文件编辑器 Store] 文件 ${tab.filePath} 已从远端重新加载 (静默: ${silent})。`);
            return true;
        } catch (err: any) {
            console.error(`[文件编辑器 Store] 重新加载文件 ${tab.filePath} 失败:`, err);
            return false;
        }
    };

    // +++ 探测特定文件的外部修改状态 +++
    const isCheckingExternalRef = ref(false);
    const checkFileExternalChanges = async (tabId: string) => {
        if (isCheckingExternalRef.value) return;
        const tab = tabs.value.get(tabId);
        if (!tab || tab.isLoading || tab.isSaving) return;

        const session = sessionStore.sessions.get(tab.sessionId);
        if (!session || !session.wsManager.isConnected.value || !session.wsManager.isSftpReady.value) {
            return;
        }

        const sftpManagersMap = session.sftpManagers;
        if (!sftpManagersMap || sftpManagersMap.size === 0) return;
        const firstEntry = sftpManagersMap.entries().next().value;
        if (!firstEntry || !firstEntry[1]) return false;
        const sftpManager = firstEntry[1];

        isCheckingExternalRef.value = true;
        try {
            const stats = await sftpManager.stat(tab.filePath);
            const currentTab = tabs.value.get(tabId);
            if (!currentTab) return;

            // 首次未记录，初始化基准
            if (currentTab.remoteMtime === undefined) {
                currentTab.remoteMtime = stats.mtime;
                currentTab.remoteSize = stats.size;
                return;
            }

            // 判断远端是否已被修改（mtime 晚于已知时间戳，或大小发生变化）
            const isMtimeChanged = stats.mtime > currentTab.remoteMtime;
            const isSizeChanged = currentTab.remoteSize !== undefined && stats.size !== currentTab.remoteSize;

            if (isMtimeChanged || isSizeChanged) {
                console.log(`[文件编辑器 Store] 检测到远端文件 ${currentTab.filePath} 已发生外部变动 (已知mtime: ${currentTab.remoteMtime}, 远端mtime: ${stats.mtime})`);

                if (!currentTab.isModified) {
                    // 本地干净（无未保存修改）：自动静默热重载！
                    await reloadFile(tabId, true);
                } else {
                    // 本地有脏数据：标记冲突，保护用户代码不被覆盖！
                    currentTab.hasExternalConflict = true;
                    currentTab.remoteMtime = stats.mtime;
                    currentTab.remoteSize = stats.size;
                }
            }
        } catch {
            // 静默忽略检查异常
        } finally {
            isCheckingExternalRef.value = false;
        }
    };

    // +++ 冲突解决：以远端内容重新加载 +++
    const resolveConflictReload = async (tabId: string) => {
        await reloadFile(tabId, false);
    };

    // +++ 冲突解决：强制本地覆盖远端 +++
    const resolveConflictOverwrite = async (tabId: string) => {
        await saveFile(tabId);
    };

    // +++ 冲突解决：忽略本次外部改动 +++
    const resolveConflictIgnore = (tabId: string) => {
        const tab = tabs.value.get(tabId);
        if (tab) {
            tab.hasExternalConflict = false;
        }
    };

    // --- 实时监听调度器 (仅对 activeTab 进行高频轻量探针，开箱即用) ---
    let watcherTimerId: any = null;

    const startFileWatcher = () => {
        if (watcherTimerId) return;
        watcherTimerId = setInterval(() => {
            if (activeTabId.value && tabs.value.size > 0) {
                checkFileExternalChanges(activeTabId.value);
            }
        }, 1500);
    };

    const stopFileWatcher = () => {
        if (watcherTimerId) {
            clearInterval(watcherTimerId);
            watcherTimerId = null;
        }
    };

    // 窗口聚焦时即刻探测（用户在终端修改后切回编辑器的瞬间）
    const handleWindowFocus = () => {
        if (activeTabId.value && tabs.value.size > 0) {
            checkFileExternalChanges(activeTabId.value);
        }
    };

    // 切换活动标签页时立即主动检查一次
    watch(activeTabId, (newId) => {
        if (newId) {
            checkFileExternalChanges(newId);
        }
    });

    // 根据是否有打开标签页自动启停探针（监听 tabs.value.size）
    watch(() => tabs.value.size, (newSize) => {
        if (newSize > 0) {
            startFileWatcher();
        } else {
            stopFileWatcher();
        }
    }, { immediate: true });

    if (typeof window !== 'undefined') {
        window.addEventListener('focus', handleWindowFocus);
        // 初始若有标签也启动
        if (tabs.value.size > 0) {
            startFileWatcher();
        }
    }

    // 监听会话关闭事件，移除相关标签页
    watch(() => sessionStore.sessions, (newSessions, oldSessions) => {
        const closedSessionIds = new Set<string>();
        oldSessions.forEach((_, sessionId) => {
            if (!newSessions.has(sessionId)) {
                closedSessionIds.add(sessionId);
            }
        });

        if (closedSessionIds.size > 0) {
            console.log('[文件编辑器 Store] 检测到会话关闭:', Array.from(closedSessionIds));
            const tabsToRemove = Array.from(tabs.value.values()).filter(tab => closedSessionIds.has(tab.sessionId));
            tabsToRemove.forEach(tab => {
                console.log(`[文件编辑器 Store] 移除与已关闭会话 ${tab.sessionId} 相关的标签页: ${tab.id}`);
                // 这里不调用 closeTab 以避免潜在的修改提示，直接移除
                tabs.value.delete(tab.id);
                 // 如果移除的是活动标签页，需要重新设置活动标签页
                if (activeTabId.value === tab.id) {
                    const remainingTabs = Array.from(tabs.value.keys());
                    if (remainingTabs.length > 0) {
                        activeTabId.value = remainingTabs[remainingTabs.length - 1];
                    } else {
                        activeTabId.value = null;
                    }
                }
            });
             // 如果移除后没有标签页了
            if (tabs.value.size === 0) {
                // setEditorVisibility('closed'); // 移除：容器可见性由外部控制
            } else if (!activeTabId.value && tabs.value.size > 0) {
                 // 如果活动标签页被移除且没有自动设置新的，手动设置一个
                 activeTabId.value = Array.from(tabs.value.keys())[0];
            }
        }
    }, { deep: false }); // 只监听 Map 本身的增删


    return {
        // 状态
        tabs: readonly(tabs), // 只读 Map
        activeTabId: readonly(activeTabId),
        // editorVisibleState: readonly(editorVisibleState), // 移除
        popupTrigger: readonly(popupTrigger), // 暴露触发器 (只读)
        popupFileInfo: readonly(popupFileInfo), // 暴露弹窗文件信息 (只读)

        // 计算属性
        orderedTabs,
        activeTab, // 只读的当前激活标签页对象
        activeEditorContent, // 用于 v-model 绑定到 MonacoEditor

        // 方法
        openFile,
        saveFile,
        closeTab,
        closeOtherTabs, // +++ 暴露新 action +++
        closeTabsToTheRight, // +++ 暴露新 action +++
        closeTabsToTheLeft, // +++ 暴露新 action +++
        closeAllTabs,
        setActiveTab,
        updateFileContent, // 暴露新的更新方法
        changeEncoding, // +++ 暴露更改编码的方法 +++
        triggerPopup, // 暴露新的触发方法
        // setEditorVisibility, // 移除
        updateTabScrollPosition, // +++ 暴露更新滚动位置的方法 +++
        reloadFile,
        checkFileExternalChanges,
        resolveConflictReload,
        resolveConflictOverwrite,
        resolveConflictIgnore,
    };
});
