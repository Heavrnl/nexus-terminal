<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, defineExpose, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';

import { useI18n } from 'vue-i18n';

import { useConnectionsStore, ConnectionInfo } from '../stores/connections.store';
import { useTagsStore, TagInfo } from '../stores/tags.store'; // 确保 TagInfo 已导入
import { useSessionStore } from '../stores/session.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store'; // +++ 修正导入大小写 +++
import { useSettingsStore } from '../stores/settings.store'; 
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import ManageTagConnectionsModal from './ManageTagConnectionsModal.vue'; 
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { hexToRgba } from '../utils/colorUtils';

// 计算带背景颜色的连接项样式
const getConnectionItemStyle = (conn: ConnectionInfo, isHighlighted: boolean) => {
  if (!conn.background_color) return {};
  const bg = hexToRgba(conn.background_color, isHighlighted ? 0.28 : 0.12);
  const hoverBg = hexToRgba(conn.background_color, 0.22);
  const border = hexToRgba(conn.background_color, 0.25);
  return {
    '--conn-item-bg': bg,
    '--conn-item-hover-bg': hoverBg,
    '--conn-item-border': border,
  };
};

// 定义事件

const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++

const { t } = useI18n();
// const router = useRouter(); // 不再需要
const connectionsStore = useConnectionsStore();
const tagsStore = useTagsStore();
const sessionStore = useSessionStore(); // 获取 session store 实例
const focusSwitcherStore = useFocusSwitcherStore(); // +++ 实例化焦点切换 Store +++
const uiNotificationsStore = useUiNotificationsStore(); // +++ 修正实例化大小写 +++
const settingsStore = useSettingsStore(); // 实例化设置 store
const { showConfirmDialog } = useConfirmDialog();

const { connections, isLoading: connectionsLoading, error: connectionsError } = storeToRefs(connectionsStore);
const { tags, isLoading: tagsLoading, error: tagsError } = storeToRefs(tagsStore);
const { showConnectionTagsBoolean } = storeToRefs(settingsStore); // 获取设置项

// 搜索词
const searchTerm = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null); // 搜索输入框的 ref

// 右键菜单状态
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextTargetConnection = ref<ConnectionInfo | null>(null);

// 标签右键菜单状态
const tagContextMenuVisible = ref(false);
const tagContextMenuPosition = ref({ x: 0, y: 0 });
const contextTargetTagGroup = ref<(typeof filteredAndGroupedConnections.value)[0] | null>(null);

// +++ 管理标签模态框状态 +++
const showManageTagModal = ref(false);
const tagToManage = ref<TagInfo | null>(null);

// +++ 本地存储键名 +++
const EXPANDED_GROUPS_STORAGE_KEY = 'workspaceConnectionListExpandedGroups';

// +++ 加载初始分组展开状态 +++
const loadInitialExpandedGroups = (): Record<string, boolean> => {
  try {
    const storedState = localStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
    if (storedState) {
      const parsedState = JSON.parse(storedState);
      // 简单验证一下是否是对象
      if (typeof parsedState === 'object' && parsedState !== null) {
        return parsedState;
      }
    }
  } catch (e) {
    console.error('Failed to load or parse expanded groups state from localStorage:', e);
    localStorage.removeItem(EXPANDED_GROUPS_STORAGE_KEY); // 清除无效状态
  }
  // 默认返回空对象，让 computed 属性处理默认展开
  return {};
};

// 分组展开状态 - 从 localStorage 初始化
const expandedGroups = ref<Record<string, boolean>>(loadInitialExpandedGroups());

// --- 移除 RDP 模态框状态 ---
// const showRdpModal = ref(false);
// const selectedRdpConnection = ref<ConnectionInfo | null>(null);

// 键盘导航状态
const highlightedIndex = ref(-1); // -1 表示没有高亮项
const listAreaRef = ref<HTMLElement | null>(null); // 列表容器的 ref

// 计算属性：扁平化的、当前可见的连接列表（用于键盘导航）
// 注意：这个 flatVisibleConnections 依赖于 filteredAndGroupedConnections 和 expandedGroups
// 当 showConnectionTagsBoolean 为 false 时，它不会被直接使用，但键盘导航逻辑依赖它
const flatVisibleConnections = computed(() => {
  const flatList: ConnectionInfo[] = [];
  // 如果显示标签，则只包含展开分组的连接
  if (showConnectionTagsBoolean.value) {
      filteredAndGroupedConnections.value.forEach(group => {
        if (expandedGroups.value[group.groupName]) {
          flatList.push(...group.connections);
        }
      });
  } else {
      // 如果不显示标签，则包含所有过滤后的连接
      flatList.push(...flatFilteredConnections.value); // 使用下面定义的 flatFilteredConnections
  }
  return flatList;
});


// 计算属性：当前高亮连接的 ID
const highlightedConnectionId = computed(() => {
  if (highlightedIndex.value >= 0 && highlightedIndex.value < flatVisibleConnections.value.length) {
    return flatVisibleConnections.value[highlightedIndex.value].id;
  }
  return null;
});


// +++ 编辑标签状态 +++
// editingTagId: number -> 编辑现有标签, null -> 编辑 "未标记" 分组 (准备创建新标签)
const editingTagId = ref<number | null | 'untagged'>(null); // 使用 'untagged' 字符串更清晰地区分
const editedTagName = ref(''); // 存储 input 中的临时名称
// const tagInputRef = ref<HTMLInputElement | null>(null); // Removed single ref
const tagInputRefs = ref(new Map<string | number, HTMLInputElement | null>()); // Map to store refs

// Function to set refs in the map
const setTagInputRef = (el: any, id: string | number) => {
  if (el) {
    tagInputRefs.value.set(id, el as HTMLInputElement);
  } else {
    // Clean up the ref when the element is unmounted
    tagInputRefs.value.delete(id);
  }
};

// 计算属性：过滤并按标签分组连接 (仅在 showConnectionTagsBoolean 为 true 时使用)
const filteredAndGroupedConnections = computed(() => {
  const groups: Record<string, { connections: ConnectionInfo[], tagId: number | null }> = {}; // 修改：添加 tagId
  const untagged: ConnectionInfo[] = [];
  const tagMap = new Map(tags.value.map(tag => [tag.id, tag]));
  const lowerSearchTerm = searchTerm.value.toLowerCase();

  // 1. 过滤连接 (New logic: filter by connection name, host, OR tag name)
  const filteredConnections = connections.value.filter(conn => {
    // Check connection name
    if (conn.name && conn.name.toLowerCase().includes(lowerSearchTerm)) {
        return true;
    }
    // Check connection host
    if (conn.host.toLowerCase().includes(lowerSearchTerm)) {
        return true;
    }
    // Check associated tag names (Always check tags for filtering, regardless of display setting)
    if (conn.tag_ids && conn.tag_ids.length > 0) {
        for (const tagId of conn.tag_ids) {
            const tag = tagMap.get(tagId); // Use the existing tagMap
            if (tag && tag.name.toLowerCase().includes(lowerSearchTerm)) {
                return true; // Match found in tag name
            }
        }
    }
    // No match found
    return false;
  });

  // 2. 分组过滤后的连接
  filteredConnections.forEach(conn => {
    if (conn.tag_ids && conn.tag_ids.length > 0) {
      let tagged = false;
      conn.tag_ids.forEach(tagId => {
        const tag = tagMap.get(tagId);
        if (tag) {
          const groupName = tag.name;
          if (!groups[groupName]) {
            groups[groupName] = { connections: [], tagId: tag.id }; // 修改：存储 tagId
            // Initialize expanded state only if not already set
            if (expandedGroups.value[groupName] === undefined) {
               expandedGroups.value[groupName] = true; // Default to expanded
            }
          }
          // Avoid duplicates if a connection has multiple tags matching the search
          if (!groups[groupName].connections.some(c => c.id === conn.id)) {
              groups[groupName].connections.push(conn);
          }
          tagged = true;
        }
      });
      // If none of the tags were found in the tagMap (e.g., stale data), treat as untagged
      if (!tagged && !untagged.some(c => c.id === conn.id)) {
          untagged.push(conn);
      }
    } else {
      // Ensure untagged connections are not duplicated
      if (!untagged.some(c => c.id === conn.id)) {
          untagged.push(conn);
      }
    }
  });

  // 3. 排序和格式化输出
  for (const groupName in groups) {
      groups[groupName].connections.sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host));
  }
  untagged.sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host));

  const sortedGroupNames = Object.keys(groups).sort();
  // 修改：结果包含 tagId
  const result: { groupName: string; connections: ConnectionInfo[]; tagId: number | null }[] = sortedGroupNames.map(name => ({
      groupName: name,
      connections: groups[name].connections,
      tagId: groups[name].tagId // 添加 tagId
  }));

  if (untagged.length > 0) {
      const untaggedGroupName = t('workspaceConnectionList.untagged');
      // Initialize expanded state only if not already set
      if (expandedGroups.value[untaggedGroupName] === undefined) {
          expandedGroups.value[untaggedGroupName] = true; // Default to expanded
      }
      // 未标记的分组没有 tagId
      result.push({ groupName: untaggedGroupName, connections: untagged, tagId: null });
  }

  return result;
});

// 计算属性，仅过滤，不分组 (用于 showConnectionTagsBoolean 为 false 时)
const flatFilteredConnections = computed(() => {
  const lowerSearchTerm = searchTerm.value.toLowerCase();
  const tagMap = new Map(tags.value.map(tag => [tag.id, tag.name])); // 创建 tagMap 用于搜索

  const filtered = connections.value.filter(conn => {
    // Check connection name
    if (conn.name && conn.name.toLowerCase().includes(lowerSearchTerm)) {
        return true;
    }
    // Check connection host
    if (conn.host.toLowerCase().includes(lowerSearchTerm)) {
        return true;
    }
    // Check associated tag names (Always check tags for filtering)
    if (conn.tag_ids && conn.tag_ids.length > 0) {
        for (const tagId of conn.tag_ids) {
            const tagName = tagMap.get(tagId);
            if (tagName && tagName.toLowerCase().includes(lowerSearchTerm)) {
                return true; // Match found in tag name
            }
        }
    }
    // No match found
    return false;
  });

  // Sort the flat list
  return filtered.sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host));
});


  // +++ 监听分组状态变化并保存到 localStorage +++
  watch(expandedGroups, (newState) => {
    // Only save if tags are shown
    if (showConnectionTagsBoolean.value) {
        try {
          localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify(newState));
        } catch (e) {
          console.error('Failed to save expanded groups state to localStorage:', e);
        }
    }
  }, { deep: true });

  // 监听搜索词变化，重置高亮索引
  watch(searchTerm, () => {
    highlightedIndex.value = -1;
  });

  // 监听分组展开状态变化，重置高亮索引 (这个 watch 保留，用于重置高亮)
  watch(expandedGroups, () => {
      highlightedIndex.value = -1;
  }, { deep: true });

  // 监听显示模式变化，重置高亮索引
  watch(showConnectionTagsBoolean, () => {
      highlightedIndex.value = -1;
  });

  // +++ 监听编辑状态，自动聚焦输入框 +++
  watch(editingTagId, async (newId) => {
    if (newId !== null) {
      await nextTick();
      const inputRef = tagInputRefs.value.get(newId); // Get ref from map using the ID
      if (inputRef) {
        inputRef.focus();
        inputRef.select();
      } else {
        console.error(`[WkspConnList] Watcher: Input ref for ID ${newId} not found in map after nextTick.`);
      }
    }
  });

  // 切换分组展开/折叠
  const toggleGroup = (groupName: string) => {
    // 状态现在总是 boolean，直接切换
    expandedGroups.value[groupName] = !expandedGroups.value[groupName];
  };

  // 处理单击连接 (左键/Enter) - 使用 session store 处理连接请求
const handleConnect = (connectionId: number, event?: MouseEvent | KeyboardEvent) => {
  if (event instanceof MouseEvent && event.button !== 0) {
    console.log(`[WkspConnList] DEBUG: handleConnect called with non-left click (button: ${event.button}). Ignoring.`);
    return;
  }

  const connection = connections.value.find(c => c.id === connectionId);
  if (!connection) {
    console.error(`[WkspConnList] Connection with ID ${connectionId} not found.`);
    return;
  }

  closeContextMenu(); // 关闭右键菜单

  // 统一发出 connect-request 事件，让 sessionStore.handleConnectRequest 处理模态框和会话
  emitWorkspaceEvent('connection:connect', { connectionId });
};

// --- 移除 closeRdpModal 方法 ---
// const closeRdpModal = () => {
//   showRdpModal.value = false;
//   selectedRdpConnection.value = null;
// };

// 显示右键菜单
const showContextMenu = (event: MouseEvent, connection: ConnectionInfo) => {
console.log(`[WkspConnList] showContextMenu (右键) called for ID: ${connection.id}. Event:`, event);
event.preventDefault(); // 再次确保阻止默认行为
event.stopPropagation(); // 阻止事件冒泡
event.stopImmediatePropagation(); // 尝试更强力地阻止事件链
console.log('[WkspConnList] Right-click default prevented and propagation stopped.');
contextTargetConnection.value = connection;
contextMenuPosition.value = { x: event.clientX, y: event.clientY };
contextMenuVisible.value = true;
// 添加全局点击监听器以关闭菜单
document.addEventListener('click', closeContextMenu, { once: true });

// 使用 nextTick 获取菜单尺寸并调整位置以防止超出屏幕
nextTick(() => {
  const menuElement = document.querySelector('.context-menu') as HTMLElement;
  if (menuElement) {
    const menuRect = menuElement.getBoundingClientRect();
    let finalX = contextMenuPosition.value.x;
    let finalY = contextMenuPosition.value.y;
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;

    // 调整水平位置
    if (finalX + menuWidth > window.innerWidth) {
      finalX = window.innerWidth - menuWidth - 5;
    }

    // 调整垂直位置
    if (finalY + menuHeight > window.innerHeight) {
      finalY = window.innerHeight - menuHeight - 5;
    }

    // 确保菜单不超出屏幕左上角
    finalX = Math.max(5, finalX);
    finalY = Math.max(5, finalY);

    // 更新位置
    if (finalX !== contextMenuPosition.value.x || finalY !== contextMenuPosition.value.y) {
      console.log(`[WkspConnList] Adjusting context menu position: (${contextMenuPosition.value.x}, ${contextMenuPosition.value.y}) -> (${finalX}, ${finalY})`);
      contextMenuPosition.value = { x: finalX, y: finalY };
    }
  }
});

return false; // 彻底停止事件处理
};

// 关闭右键菜单
const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextTargetConnection.value = null;
  document.removeEventListener('click', closeContextMenu);
};

// 处理右键菜单操作
const handleMenuAction = async (action: 'add' | 'edit' | 'delete' | 'clone') => { // 添加 'clone' 类型
  const conn = contextTargetConnection.value;
  closeContextMenu(); // 先关闭菜单

  if (action === 'add') {
    console.log('[WorkspaceConnectionList] handleMenuAction called with action: add. Emitting request-add-connection...'); 
    // router.push('/connections/add'); // 改为触发事件
    emitWorkspaceEvent('connection:requestAdd');
  }else if (conn) {
    if (action === 'edit') {
      // router.push(`/connections/edit/${conn.id}`); // 改为触发事件
      emitWorkspaceEvent('connection:requestEdit', { connectionInfo: conn }); // 传递整个连接对象
    } else if (action === 'delete') {
      const confirmed = await showConfirmDialog({
        message: t('connections.prompts.confirmDelete', { name: conn.name || conn.host })
      });
      if (confirmed) {
        connectionsStore.deleteConnection(conn.id);
        // 注意：删除后列表会自动更新，因为 store 是响应式的
      }
    } else if (action === 'clone') {
        // 调用 store 中的 cloneConnection 方法
        // 需要先生成新名称
        const allConnections = connectionsStore.connections;
        let newName = `${conn.name} (1)`;
        let counter = 1;
        const baseName = conn.name;
        const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escapedBaseName} \\((\\d+)\\)$`);

        while (allConnections.some(c => c.name === newName)) {
            counter++;
            newName = `${baseName} (${counter})`;
        }
        if (counter === 1 && allConnections.some(c => c.name === baseName)) {
           // 处理原始名称已存在的情况
        }

        connectionsStore.cloneConnection(conn.id, newName)
          .catch(error => {
              // 可以在这里处理克隆失败的特定 UI 反馈，如果需要的话
              console.error("Cloning failed in component:", error);
          });
    }
  }
};

// 显示标签右键菜单
const showTagContextMenu = (event: MouseEvent, groupData: (typeof filteredAndGroupedConnections.value)[0]) => {
event.preventDefault();
event.stopPropagation(); // 阻止事件冒泡到上层，例如关闭连接右键菜单的 document click listener
closeContextMenu(); // 如果连接的右键菜单是打开的，先关闭它
contextTargetTagGroup.value = groupData;
tagContextMenuPosition.value = { x: event.clientX, y: event.clientY };
tagContextMenuVisible.value = true;
// 添加全局点击监听器以关闭菜单
document.addEventListener('click', closeTagContextMenu, { once: true });

// 使用 nextTick 获取菜单尺寸并调整位置以防止超出屏幕
nextTick(() => {
  const menuElement = document.querySelector('.tag-context-menu') as HTMLElement;
  if (menuElement) {
    const menuRect = menuElement.getBoundingClientRect();
    let finalX = tagContextMenuPosition.value.x;
    let finalY = tagContextMenuPosition.value.y;
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;

    // 调整水平位置
    if (finalX + menuWidth > window.innerWidth) {
      finalX = window.innerWidth - menuWidth - 5;
    }

    // 调整垂直位置
    if (finalY + menuHeight > window.innerHeight) {
      finalY = window.innerHeight - menuHeight - 5;
    }

    // 确保菜单不超出屏幕左上角
    finalX = Math.max(5, finalX);
    finalY = Math.max(5, finalY);

    // 更新位置
    if (finalX !== tagContextMenuPosition.value.x || finalY !== tagContextMenuPosition.value.y) {
      console.log(`[WkspConnList] Adjusting tag context menu position: (${tagContextMenuPosition.value.x}, ${tagContextMenuPosition.value.y}) -> (${finalX}, ${finalY})`);
      tagContextMenuPosition.value = { x: finalX, y: finalY };
    }
  }
});
};

// 关闭标签右键菜单
const closeTagContextMenu = () => {
  tagContextMenuVisible.value = false;
  // contextTargetTagGroup.value = null; // 保留 targetGroup 直到菜单完全消失，以便动画（如果未来添加）
  document.removeEventListener('click', closeTagContextMenu);
};

// 处理标签右键菜单操作
// 修改：允许直接传递 groupData，用于新的行内编辑按钮
const handleTagMenuAction = async (action: 'connectAll' | 'manageTag' | 'deleteAllConnections', directGroupData?: (typeof filteredAndGroupedConnections.value)[0]) => {
  const group = directGroupData || contextTargetTagGroup.value; // 优先使用直接传递的 groupData
  closeTagContextMenu(); // 先关闭菜单

  if (group && action === 'connectAll') {
    const sshConnections = group.connections.filter(conn => conn.type === 'SSH');

    if (sshConnections.length > 0) {
      sshConnections.forEach(conn => {
        emitWorkspaceEvent('connection:connect', { connectionId: conn.id });
      });
      uiNotificationsStore.addNotification({
        message: t('workspaceConnectionList.connectingAllSshInGroup', { count: sshConnections.length, groupName: group.groupName }),
        type: 'info',
      });
    } else {
      uiNotificationsStore.addNotification({
        message: t('workspaceConnectionList.noSshConnectionsInGroup', { groupName: group.groupName }),
        type: 'info',
      });
    }
  } else if (group && action === 'manageTag') {
    if (group.tagId !== null) { // 确保不是 "未标记" 分组
      tagToManage.value = {
        id: group.tagId,
        name: group.groupName,
        created_at: tags.value.find(t => t.id === group.tagId)?.created_at || Date.now() / 1000, // 尝试获取真实时间，否则用当前
        updated_at: tags.value.find(t => t.id === group.tagId)?.updated_at || Date.now() / 1000,
      };
      showManageTagModal.value = true;
    } else {
      uiNotificationsStore.addNotification({
        message: t('workspaceConnectionList.manageTags.cannotManageUntagged'), // 需要添加这个翻译
        type: 'warning',
      });
    }
  } else if (group && action === 'deleteAllConnections') {
    // 确保是已标记的组
    if (group.tagId === null) {
        uiNotificationsStore.addNotification({
            message: t('workspaceConnectionList.cannotDeleteFromUntagged'), 
            type: 'warning',
        });
        return;
    }
    // 确保组内有连接
    if (group.connections.length === 0) {
      uiNotificationsStore.addNotification({
        message: t('workspaceConnectionList.noConnectionsToDeleteInGroup', { groupName: group.groupName }), 
        type: 'info',
      });
      return;
    }

    const confirmed = await showConfirmDialog({
      message: t('workspaceConnectionList.confirmDeleteAllConnectionsInGroup', { count: group.connections.length, groupName: group.groupName })
    });
    if (confirmed) {
      const connectionIdsToDelete = group.connections.map(conn => conn.id);
      
      const deletePromises = connectionIdsToDelete.map(connId =>
        connectionsStore.deleteConnection(connId).catch(err => {
          console.error(`[WkspConnList] Failed to delete connection ${connId} in group ${group.groupName}:`, err);
          return Promise.reject({ connId, error: err });
        })
      );

      Promise.allSettled(deletePromises)
        .then(results => {
          const successfulDeletes = results.filter(result => result.status === 'fulfilled').length;
          const failedDeletes = results.filter(result => result.status === 'rejected').length;

          if (successfulDeletes > 0) {
            uiNotificationsStore.addNotification({
              message: t('workspaceConnectionList.allConnectionsInGroupDeletedSuccess', { count: successfulDeletes, groupName: group.groupName }),
              type: 'success',
            });
          }
          if (failedDeletes > 0) {
             uiNotificationsStore.addNotification({
              message: t('workspaceConnectionList.someConnectionsInGroupDeleteFailed', { count: failedDeletes, groupName: group.groupName }),
              type: 'error',
            });
          }
        });
    }
  }
};

const handleManageTagModalSaved = () => {
  connectionsStore.fetchConnections(); // 刷新连接列表
  tagsStore.fetchTags(); // 刷新标签列表，以防标签名称等有变动（虽然此模态框不直接改名）
};

 // 稍微延迟一下重置，以防是点击列表项导致的失焦
 // 如果用户点击了列表项，handleConnect 会先触发
 setTimeout(() => {
     // 检查此时是否仍然没有焦点在输入框上（避免误清除）
     if (document.activeElement !== searchInputRef.value) {
         highlightedIndex.value = -1;
     }
 }, 150); // 150ms 延迟可能更稳妥
// 处理失焦事件，清除高亮
const handleBlur = () => {
  // 稍微延迟一下重置，以防是点击列表项导致的失焦
  // 如果用户点击了列表项，handleConnect 会先触发
  setTimeout(() => {
      // 检查此时是否仍然没有焦点在输入框上（避免误清除）
      if (document.activeElement !== searchInputRef.value) {
          highlightedIndex.value = -1;
      }
  }, 150); // 150ms 延迟可能更稳妥
};

// 获取数据的 onMounted 调用已移至新的 onMounted 逻辑中

// +++ 注册/注销自定义聚焦动作 +++
let unregisterFocusAction: (() => void) | null = null; // 用于存储注销函数

onMounted(() => {
  // 调用新的 registerFocusAction 并存储返回的注销函数
  // focusSearchInput 返回 boolean，符合 () => boolean | Promise<boolean | undefined> 类型
  unregisterFocusAction = focusSwitcherStore.registerFocusAction('connectionListSearch', focusSearchInput);
  connectionsStore.fetchConnections(); // 移到 onMounted
  tagsStore.fetchTags(); // 移到 onMounted
  // Load initial expanded state after fetching tags/connections
  expandedGroups.value = loadInitialExpandedGroups();
});

onBeforeUnmount(() => {
  // 调用存储的注销函数
  if (unregisterFocusAction) {
    unregisterFocusAction();
    console.log(`[WkspConnList] Unregistered focus action on unmount.`);
  }
  unregisterFocusAction = null;
});

// 处理中键点击（在新标签页打开） - 功能已移除

// 暴露聚焦搜索框的方法
const focusSearchInput = (): boolean => {
  if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true; // 聚焦成功
  }
  return false; // 聚焦失败
};
defineExpose({ focusSearchInput });

// --- 键盘导航和确认 ---

const handleKeyDown = (event: KeyboardEvent) => {
  const list = flatVisibleConnections.value; // Always navigate the potentially flat list
  if (!list.length) return;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault(); // 阻止光标移动
      highlightedIndex.value = (highlightedIndex.value + 1) % list.length;
      scrollToHighlighted();
      break;
    case 'ArrowUp':
      event.preventDefault(); // 阻止光标移动
      highlightedIndex.value = (highlightedIndex.value - 1 + list.length) % list.length;
      scrollToHighlighted();
      break;
    case 'Enter':
      event.preventDefault(); // 阻止可能的表单提交
      if (highlightedConnectionId.value !== null) {
        handleConnect(highlightedConnectionId.value);
      }
      break;
  }
};

// 滚动到高亮项
const scrollToHighlighted = async () => {
  await nextTick(); // 等待 DOM 更新
  if (!listAreaRef.value || highlightedConnectionId.value === null) return;

  // Query selector needs to work for both grouped and flat lists
  const highlightedElement = listAreaRef.value.querySelector(`li[data-conn-id="${highlightedConnectionId.value}"]`);
  if (highlightedElement) {
    highlightedElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
};

// +++ 启动编辑标签 (或准备创建新标签) +++
const startEditingTag = (tagId: number | null, currentName: string) => { // Removed async
  // 如果 tagId 是 null，表示是 "未标记" 分组
  editingTagId.value = tagId === null ? 'untagged' : tagId;
  editedTagName.value = tagId === null ? '' : currentName; // 未标记组开始编辑时清空输入框
  // Focus logic moved to watcher
};

// +++ 完成编辑标签 (或创建新标签并分配) +++
const finishEditingTag = async () => {
  const currentEditingId = editingTagId.value;
  const newName = editedTagName.value.trim();
  const originalTag = typeof currentEditingId === 'number' ? tags.value.find(t => t.id === currentEditingId) : null;

  // 如果新名称为空 (除非是 'untagged' 状态，否则取消编辑)
  if (newName === '' && currentEditingId !== 'untagged') {
      editingTagId.value = null;
      return;
  }
  // 如果是 'untagged' 状态且新名称为空，也取消
  if (newName === '' && currentEditingId === 'untagged') {
       editingTagId.value = null;
       return;
   }

  let operationSuccess = false; // Track if the core operation (add/update) succeeded

  try {
      if (currentEditingId === 'untagged') {
          // --- 创建新标签并分配 ---
          const newTag = await tagsStore.addTag(newName); // Returns TagInfo | null
          if (newTag) {
              operationSuccess = true; // Core tag creation succeeded
              uiNotificationsStore.addNotification({ message: t('tags.createSuccess'), type: 'success' });
              const untaggedGroup = filteredAndGroupedConnections.value.find(g => g.tagId === null);
              const untaggedConnectionIds = untaggedGroup ? untaggedGroup.connections.map(c => c.id) : [];

              if (untaggedConnectionIds.length > 0) {
                  // 调用新的 action 批量添加标签
                  const assignSuccess = await connectionsStore.addTagToConnectionsAction(untaggedConnectionIds, newTag.id);
                  if (assignSuccess) {
                      uiNotificationsStore.addNotification({ message: t('workspaceConnectionList.allConnectionsTaggedSuccess'), type: 'success' });
                  }
                  // Assign failure notification is handled within the action
              } else {
                   uiNotificationsStore.addNotification({ message: t('workspaceConnectionList.noConnectionsToTag'), type: 'info' });
              }

              // 更新展开状态 only if tag creation was successful
              const untaggedGroupName = t('workspaceConnectionList.untagged');
              if (expandedGroups.value[untaggedGroupName] !== undefined) {
                  const currentState = expandedGroups.value[untaggedGroupName];
                  delete expandedGroups.value[untaggedGroupName];
                  expandedGroups.value[newName] = currentState;
              }
          }
          // If newTag is null, addTag failed (e.g., name exists), notification handled by store. operationSuccess remains false.
      } else if (typeof currentEditingId === 'number') {
          // --- 更新现有标签 ---
          if (!originalTag) {
             console.error(`Tag with ID ${currentEditingId} not found for update.`);
             // Exit edit mode in finally block
          } else if (originalTag.name === newName) {
              operationSuccess = true; // No change needed, consider it success for UI state
          } else {
              // 名称已改变，尝试更新
              const updateResult = await tagsStore.updateTag(currentEditingId, newName); // Returns boolean
              if (updateResult) {
                  operationSuccess = true; // Core tag update succeeded
                  uiNotificationsStore.addNotification({ message: t('tags.updateSuccess'), type: 'success' });
                  // 更新展开状态 only if tag update was successful
                  if (expandedGroups.value[originalTag.name] !== undefined) {
                      const currentState = expandedGroups.value[originalTag.name];
                      delete expandedGroups.value[originalTag.name];
                      expandedGroups.value[newName] = currentState;
                  }
              }
              // If updateResult is false, updateTag failed (e.g., name exists), notification handled by store. operationSuccess remains false.
          }
      }
  } catch (error: any) {
      // 捕获这两个流程中未被 store action 捕获的意外错误
      console.error("Error during finishEditingTag:", error);
      uiNotificationsStore.addNotification({ message: t('common.unexpectedError'), type: 'error' });
      // operationSuccess remains false
  } finally {
      // 无论核心操作成功与否，最终都退出编辑模式
      // 这样即使用户输入了重复名称，收到通知后，输入框也会消失，恢复原状
      editingTagId.value = null;
  }
};

// +++ 取消编辑（例如按 Esc 键） +++
const cancelEditingTag = () => {
  editingTagId.value = null;
};
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-background text-foreground">
    <!-- ... Loading/Error states ... -->
    <div v-if="(connectionsLoading || tagsLoading) && connections.length === 0 && tags.length === 0" class="flex items-center justify-center h-full text-text-secondary">
      <i class="fas fa-spinner fa-spin mr-2"></i> {{ t('common.loading') }}
    </div>
    <div v-else-if="connectionsError || (tagsError && tags.length === 0)" class="flex items-center justify-center h-full text-error px-4 text-center">
      <i class="fas fa-exclamation-triangle mr-2"></i> {{ connectionsError || tagsError }}
    </div>

    <!-- Main Content Area -->
    <div v-else class="flex flex-col h-full">
      <!-- Search and Add Bar -->
      <div class="flex p-2 border-b border-border/50"> <!-- Reduced padding p-3 to p-2 -->
        <input
          type="text"
          v-model="searchTerm"
          :placeholder="t('workspaceConnectionList.searchPlaceholder')"
          ref="searchInputRef"
          class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
          data-focus-id="connectionListSearch"
          @keydown="handleKeyDown"
          @blur="handleBlur"
        />
        <button
          class="ml-2 w-8 h-8 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-70 flex-shrink-0 flex items-center justify-center"
          @click="handleMenuAction('add')"
          :title="t('connections.addConnection')"
        >
          <i class="fas fa-plus text-white"></i>
        </button>
      </div>

      <!-- Connection List Area -->
      <div class="flex-grow overflow-y-auto p-2" ref="listAreaRef">
        <!-- No Results / No Connections State -->
        <!-- 修改 v-if 条件，考虑两种模式，并且仅在有搜索词时显示 "No Results" -->
        <div v-if="((showConnectionTagsBoolean && filteredAndGroupedConnections.length === 0) || (!showConnectionTagsBoolean && flatFilteredConnections.length === 0)) && connections.length > 0 && searchTerm" class="p-6 text-center text-text-secondary">
           <i class="fas fa-search text-xl mb-2"></i>
           <p>{{ t('workspaceConnectionList.noResults') }} "{{ searchTerm }}"</p>
        </div>
        <div v-else-if="connections.length === 0" class="p-6 text-center text-text-secondary">
           <i class="fas fa-plug text-xl mb-2"></i>
           <p>{{ t('connections.noConnections') }}</p>
           <button
             class="mt-4 px-4 py-2 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
             @click="handleMenuAction('add')"
           >
             {{ t('connections.addFirstConnection') }}
           </button>
        </div>

        <!-- Groups and Connections (Conditional Rendering) -->
        <div v-else>
          <!-- Grouped View -->
          <div v-if="showConnectionTagsBoolean">
            <div v-for="groupData in filteredAndGroupedConnections" :key="groupData.groupName" class="mb-1 last:mb-0">
              <!-- Group Header -->
              <div
              class="group px-3 py-2 font-semibold flex items-center text-foreground rounded-md hover:bg-header/80 transition-colors duration-150"
              :class="{ 'cursor-pointer': editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) }"
              @click="editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) ? toggleGroup(groupData.groupName) : null"
              @contextmenu.prevent="showTagContextMenu($event, groupData)"
            >
              <i
                :class="['fas', expandedGroups[groupData.groupName] ? 'fa-chevron-down' : 'fa-chevron-right', 'mr-2 w-4 text-center text-text-secondary group-hover:text-foreground transition-transform duration-200 ease-in-out', {'transform rotate-0': !expandedGroups[groupData.groupName]}]"
                @click.stop="toggleGroup(groupData.groupName)"
                class="cursor-pointer flex-shrink-0"
              ></i>
              <!-- 编辑状态 -->
              <input
                v-if="editingTagId === (groupData.tagId === null ? 'untagged' : groupData.tagId)"
                :key="groupData.tagId === null ? 'untagged-input' : `tag-input-${groupData.tagId}`"
                :ref="(el) => setTagInputRef(el, groupData.tagId === null ? 'untagged' : groupData.tagId)"
                type="text"
                v-model="editedTagName"
                class="text-sm bg-input border border-primary rounded px-1 py-0 w-full"
                @blur="finishEditingTag"
                @keydown.enter.prevent="finishEditingTag"
                @keydown.esc.prevent="cancelEditingTag"
                @click.stop
              />
              <!-- 显示状态 -->
              <span
                v-else
                class="text-sm inline-block overflow-hidden text-ellipsis whitespace-nowrap"
                :class="{ 'cursor-pointer hover:underline': true }"
                :title="t('workspaceConnectionList.clickToEditTag')"
                @click.stop="startEditingTag(groupData.tagId, groupData.groupName)"
              >
                {{ groupData.groupName }}
              </span>
              <!-- 占位符，占据剩余空间 -->
              <div class="flex-grow min-w-0"></div>
              <!-- 标签栏右侧的编辑按钮 -->
              <button
                v-if="groupData.tagId !== null && editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId)"
                @click.stop="handleTagMenuAction('manageTag', groupData)"
                class="ml-2 px-1 h-6 flex items-center justify-center rounded text-text-secondary hover:text-primary hover:bg-black/10 opacity-0 group-hover:opacity-100 transition-all duration-150 focus:outline-none"
                :title="t('workspaceConnectionList.manageTags.menuItem')"
              >
                <i class="fas fa-edit fa-xs"></i>
              </button>
           </div>
            <!-- Connection Items List -->
            <ul v-show="expandedGroups[groupData.groupName]" class="list-none p-0 m-0 pl-3">
              <!-- ... li v-for="conn in groupData.connections" ... -->
               <li
                 v-for="conn in groupData.connections"
                 :key="conn.id"
                 class="group my-0.5 py-2 pr-3 pl-4 cursor-pointer flex items-center rounded-md whitespace-nowrap overflow-hidden text-ellipsis text-foreground transition-all duration-150"
                 :class="[
                   conn.background_color ? 'connection-item-colored' : 'hover:bg-primary/10',
                   { 'bg-primary/20 font-medium': !conn.background_color && conn.id === highlightedConnectionId }
                 ]"
                 :style="getConnectionItemStyle(conn, conn.id === highlightedConnectionId)"
                 :data-conn-id="conn.id"
                 @click.left="handleConnect(conn.id)"
                 @click.right.prevent
                 @contextmenu.prevent="showContextMenu($event, conn)"
               >
                 <i
                   :class="['fas', conn.type === 'RDP' ? 'fa-desktop' : (conn.type === 'VNC' ? 'fa-plug' : 'fa-server'), 'mr-2.5 w-4 text-center', conn.background_color ? '' : 'text-text-secondary group-hover:text-primary', { 'text-white': !conn.background_color && conn.id === highlightedConnectionId }]"
                   :style="conn.background_color ? { color: conn.background_color } : {}"
                 ></i>
                 <span class="overflow-hidden text-ellipsis whitespace-nowrap flex-grow text-sm" :title="conn.name || conn.host">
                   {{ conn.name || conn.host }}
                 </span>
               </li>
            </ul>
            </div>
          </div>
          <!-- Flat View -->
          <ul v-else class="list-none p-0 m-0">
              <li
                v-for="conn in flatFilteredConnections"
                :key="conn.id"
                class="group my-0.5 py-2 pr-3 pl-4 cursor-pointer flex items-center rounded-md whitespace-nowrap overflow-hidden text-ellipsis text-foreground transition-all duration-150"
                :class="[
                  conn.background_color ? 'connection-item-colored' : 'hover:bg-primary/10',
                  { 'bg-primary/20 font-medium': !conn.background_color && conn.id === highlightedConnectionId }
                ]"
                :style="getConnectionItemStyle(conn, conn.id === highlightedConnectionId)"
                :data-conn-id="conn.id"
                @click.left="handleConnect(conn.id)"
                @click.right.prevent
                @contextmenu.prevent="showContextMenu($event, conn)"
              >
                <i
                  :class="['fas', conn.type === 'RDP' ? 'fa-desktop' : (conn.type === 'VNC' ? 'fa-chalkboard' : 'fa-server'), 'mr-2.5 w-4 text-center', conn.background_color ? '' : 'text-text-secondary group-hover:text-primary', { 'text-white': !conn.background_color && conn.id === highlightedConnectionId }]"
                  :style="conn.background_color ? { color: conn.background_color } : {}"
                ></i>
                <span class="overflow-hidden text-ellipsis whitespace-nowrap flex-grow text-sm" :title="conn.name || conn.host">
                  {{ conn.name || conn.host }}
                </span>
              </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Context Menu -->
    <teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="fixed bg-background border border-border/50 shadow-xl rounded-lg py-1.5 z-[9999] min-w-[180px] context-menu"
        :style="{ top: `${contextMenuPosition.y}px`, left: `${contextMenuPosition.x}px` }"
        @click.stop
      >
        <ul class="list-none p-0 m-0">
          <li class="group px-4 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1" @click="handleMenuAction('add')">
              <i class="fas fa-plus mr-3 w-4 text-center text-text-secondary group-hover:text-primary"></i>
              <span>{{ t('connections.addConnection') }}</span>
          </li>
          <li v-if="contextTargetConnection" class="group px-4 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1" @click="handleMenuAction('edit')">
              <i class="fas fa-edit mr-3 w-4 text-center text-text-secondary group-hover:text-primary"></i>
              <span>{{ t('connections.actions.edit') }}</span>
          </li>
          <li v-if="contextTargetConnection" class="group px-4 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1" @click="handleMenuAction('clone')">
              <i class="fas fa-clone mr-3 w-4 text-center text-text-secondary group-hover:text-primary"></i>
              <span>{{ t('connections.actions.clone') }}</span>
          </li>
          <li v-if="contextTargetConnection" class="group px-4 py-1.5 cursor-pointer flex items-center text-error hover:bg-error/10 text-sm transition-colors duration-150 rounded-md mx-1" @click="handleMenuAction('delete')">
              <i class="fas fa-trash-alt mr-3 w-4 text-center text-error/80 group-hover:text-error"></i>
              <span>{{ t('connections.actions.delete') }}</span>
          </li>
        </ul>
      </div>
    </teleport>

    <!-- 标签右键菜单 -->
    <teleport to="body">
      <div
        v-if="tagContextMenuVisible"
        class="fixed bg-background border border-border/50 shadow-xl rounded-lg py-1.5 z-[9999] min-w-[200px] tag-context-menu"
        :style="{ top: `${tagContextMenuPosition.y}px`, left: `${tagContextMenuPosition.x}px` }"
        @click.stop
      >
        <ul class="list-none p-0 m-0">
          <li
            v-if="contextTargetTagGroup && contextTargetTagGroup.connections.some((c: ConnectionInfo) => c.type === 'SSH')"
            class="group px-4 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1"
            @click="handleTagMenuAction('connectAll')"
          >
            <i class="fas fa-network-wired mr-3 w-4 text-center text-text-secondary group-hover:text-primary"></i>
            <span>{{ t('workspaceConnectionList.connectAllSshInGroupMenu') }}</span>
          </li>
           <li
            v-else-if="contextTargetTagGroup"
            class="group px-4 py-1.5 flex items-center text-text-disabled text-sm rounded-md mx-1 cursor-not-allowed"
          >
            <i class="fas fa-ban mr-3 w-4 text-center text-text-disabled"></i>
            <span>{{ t('workspaceConnectionList.noSshConnectionsToConnectMenu') }}</span>
          </li>
          <li class="my-1 border-t border-border/50" v-if="contextTargetTagGroup && contextTargetTagGroup.tagId !== null"></li>
          <li
            v-if="contextTargetTagGroup && contextTargetTagGroup.tagId !== null"
            class="group px-4 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1"
            @click="handleTagMenuAction('manageTag')"
          >
            <i class="fas fa-tags mr-3 w-4 text-center text-text-secondary group-hover:text-primary"></i>
            <span>{{ t('workspaceConnectionList.manageTags.menuItem') }}</span>
          </li>
          <li class="my-1 border-t border-border/50" v-if="contextTargetTagGroup && contextTargetTagGroup.tagId !== null && contextTargetTagGroup.connections.length > 0"></li>
          <li
            v-if="contextTargetTagGroup && contextTargetTagGroup.tagId !== null && contextTargetTagGroup.connections.length > 0"
            class="group px-4 py-1.5 cursor-pointer flex items-center text-error hover:bg-error/10 text-sm transition-colors duration-150 rounded-md mx-1"
            @click="handleTagMenuAction('deleteAllConnections')"
          >
            <i class="fas fa-trash-alt mr-3 w-4 text-center text-error/80 group-hover:text-error"></i>
            <span>{{ t('workspaceConnectionList.deleteAllConnectionsInGroupMenu') }}</span>
          </li>
        </ul>
      </div>
    </teleport>

   <teleport to="body">
     <ManageTagConnectionsModal
       :tag-info="tagToManage"
       v-model:visible="showManageTagModal"
       @saved="handleManageTagModalSaved"
     />
   </teleport>
 </div>
</template>

<style scoped>
.connection-item-colored {
  background-color: var(--conn-item-bg);
  border: 1px solid var(--conn-item-border);
}
.connection-item-colored:hover {
  background-color: var(--conn-item-hover-bg) !important;
}
</style>

