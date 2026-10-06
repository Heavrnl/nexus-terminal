import { ref, computed, watch } from 'vue';

export interface ToolbarItemDefinition {
  id: string;
  name: string;
  i18nKey: string;
  icon: string;
  description: string;
}

// 全部可选的移动端工具栏按钮元数据定义
export const ALL_TOOLBAR_ITEMS: Record<string, ToolbarItemDefinition> = {
  clearTerminal: {
    id: 'clearTerminal',
    name: '清空终端',
    i18nKey: 'commandInputBar.clearTerminal',
    icon: 'fas fa-eraser',
    description: '清除当前终端屏幕上的所有内容',
  },
  quickCommands: {
    id: 'quickCommands',
    name: '快捷指令',
    i18nKey: 'quickCommands.title',
    icon: 'fas fa-bolt',
    description: '快速发送预先保存的脚本或指令',
  },
  commandHistory: {
    id: 'commandHistory',
    name: '命令历史',
    i18nKey: 'commandHistory.title',
    icon: 'fas fa-history',
    description: '查看并重放过去执行过的历史命令',
  },
  terminalBufferText: {
    id: 'terminalBufferText',
    name: '终端复制',
    i18nKey: 'terminal.bufferText.title',
    icon: 'fas fa-copy',
    description: '提取终端输出文本，支持手机原生划选与复制',
  },
  multiLine: {
    id: 'multiLine',
    name: '命令输入',
    i18nKey: 'commandInputBar.openMultiLine',
    icon: 'fas fa-terminal',
    description: '展开多行命令输入与批量执行面板',
  },
  suspendedSessions: {
    id: 'suspendedSessions',
    name: '挂起会话',
    i18nKey: 'suspendedSshSessions.title',
    icon: 'fas fa-pause-circle',
    description: '查看与恢复后端常驻挂起的后台会话',
  },
  virtualKeyboard: {
    id: 'virtualKeyboard',
    name: '虚拟按键',
    i18nKey: 'commandInputBar.showKeyboard',
    icon: 'fas fa-keyboard',
    description: '呼出专为移动端特化的 Ctrl/Alt/Esc 按键栏',
  },
  fileManager: {
    id: 'fileManager',
    name: '文件管理',
    i18nKey: 'fileManager.modalTitle',
    icon: 'fas fa-folder',
    description: '浏览、上传、下载与管理远端服务器文件',
  },
  fileEditor: {
    id: 'fileEditor',
    name: '文件编辑',
    i18nKey: 'fileEditor.title',
    icon: 'fas fa-edit',
    description: '在移动端打开并编辑远端代码与文本文件',
  },
  statusMonitor: {
    id: 'statusMonitor',
    name: '状态监视',
    i18nKey: 'statusMonitor.title',
    icon: 'fas fa-tachometer-alt',
    description: '实时监控服务器 CPU、内存、网络及磁盘运行指标',
  },
  dockerManager: {
    id: 'dockerManager',
    name: 'Docker',
    i18nKey: 'dockerManager.title',
    icon: 'fab fa-docker',
    description: '在移动端管理容器运行状态、启动停止与实时日志',
  },
  toggleHeader: {
    id: 'toggleHeader',
    name: '显隐导航',
    i18nKey: 'terminalTabBar.hideHeaderTooltip',
    icon: 'fas fa-eye-slash',
    description: '快速隐藏或显示顶部系统导航栏',
  },
  transferProgress: {
    id: 'transferProgress',
    name: '传输进度',
    i18nKey: 'terminalTabBar.showTransferProgressTooltip',
    icon: 'fas fa-tasks',
    description: '查看当前正在进行的 SFTP 文件上传/下载进度',
  },
  scrollBottom: {
    id: 'scrollBottom',
    name: '滚到底部',
    i18nKey: 'commandInputBar.scrollToBottom',
    icon: 'fas fa-arrow-down',
    description: '快速滚动终端视口至最新输出内容',
  },
};

// 默认工具栏激活项顺序
export const DEFAULT_ACTIVE_TOOLBAR_IDS: string[] = [
  'clearTerminal',
  'quickCommands',
  'commandHistory',
  'terminalBufferText',
  'multiLine',
  'statusMonitor',
  'dockerManager',
  'suspendedSessions',
  'virtualKeyboard',
  'fileManager',
  'fileEditor',
  'toggleHeader',
  'transferProgress',
];

const STORAGE_KEY = 'nexus_mobile_terminal_toolbar_items';

// 单例状态，保证全局状态同步
const activeItemIds = ref<string[]>([...DEFAULT_ACTIVE_TOOLBAR_IDS]);

// 从本地存储加载配置
const loadConfigFromStorage = () => {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 过滤掉已失效的废弃 ID
        const validIds = parsed.filter(id => typeof id === 'string' && id in ALL_TOOLBAR_ITEMS);
        if (validIds.length > 0) {
          activeItemIds.value = validIds;
          return;
        }
      }
    }
  } catch (err) {
    console.warn('[useMobileToolbarConfig] 加载本地配置失败，采用默认值:', err);
  }
  activeItemIds.value = [...DEFAULT_ACTIVE_TOOLBAR_IDS];
};

// 持久化到本地存储
const saveConfigToStorage = () => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(activeItemIds.value));
  } catch (err) {
    console.warn('[useMobileToolbarConfig] 保存本地配置失败:', err);
  }
};

// 初始化
loadConfigFromStorage();

export function useMobileToolbarConfig() {
  // 当前处于工具栏中的按钮定义列表（保持激活顺序）
  const activeItems = computed<ToolbarItemDefinition[]>(() => {
    return activeItemIds.value
      .map(id => ALL_TOOLBAR_ITEMS[id])
      .filter((item): item is ToolbarItemDefinition => !!item);
  });

  // 仓库中未放置到工具栏的备用按钮列表
  const warehouseItems = computed<ToolbarItemDefinition[]>(() => {
    const activeSet = new Set(activeItemIds.value);
    return Object.values(ALL_TOOLBAR_ITEMS).filter(item => !activeSet.has(item.id));
  });

  // 从仓库添加按钮到当前工具栏末尾
  const addToActive = (itemId: string) => {
    if (!ALL_TOOLBAR_ITEMS[itemId]) return;
    if (!activeItemIds.value.includes(itemId)) {
      activeItemIds.value = [...activeItemIds.value, itemId];
      saveConfigToStorage();
    }
  };

  // 从当前工具栏移除按钮（退回仓库）
  const removeFromActive = (itemId: string) => {
    if (activeItemIds.value.includes(itemId)) {
      activeItemIds.value = activeItemIds.value.filter(id => id !== itemId);
      saveConfigToStorage();
    }
  };

  // 在当前工具栏内部调整顺序（从 fromIndex 移动到 toIndex）
  const moveActiveItem = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || fromIndex >= activeItemIds.value.length) return;
    if (toIndex < 0 || toIndex >= activeItemIds.value.length) return;
    if (fromIndex === toIndex) return;

    const list = [...activeItemIds.value];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    activeItemIds.value = list;
    saveConfigToStorage();
  };

  // 快捷左移一位
  const moveItemLeft = (index: number) => {
    if (index > 0) {
      moveActiveItem(index, index - 1);
    }
  };

  // 快捷右移一位
  const moveItemRight = (index: number) => {
    if (index < activeItemIds.value.length - 1) {
      moveActiveItem(index, index + 1);
    }
  };

  // 恢复默认配置
  const resetToDefault = () => {
    activeItemIds.value = [...DEFAULT_ACTIVE_TOOLBAR_IDS];
    saveConfigToStorage();
  };

  return {
    activeItemIds,
    activeItems,
    warehouseItems,
    addToActive,
    removeFromActive,
    moveActiveItem,
    moveItemLeft,
    moveItemRight,
    resetToDefault,
  };
}
