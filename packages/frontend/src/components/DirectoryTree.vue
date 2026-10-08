<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SftpManagerInstance } from '../composables/useSftpActions';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useComponentStateStore } from '../stores/componentState.store';
import { useLayoutStore } from '../stores/layout.store';

const props = withDefaults(
  defineProps<{
    instanceId?: string;
    currentPath: string;
    isConnected: boolean;
    isSftpReady?: boolean;
    sftpManager: SftpManagerInstance | null;
    width?: number;
    showFiles?: boolean;
  }>(),
  {
    instanceId: 'default',
    width: 220,
    isSftpReady: false,
    showFiles: undefined,
  }
);

const emit = defineEmits<{
  (e: 'select-directory', path: string): void;
  (e: 'select-file', path: string, filename: string): void;
  (e: 'update:showFiles', value: boolean): void;
}>();

const { t } = useI18n();

interface TreeNode {
  path: string;
  name: string;
  depth: number;
  isDirectory: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  children: string[] | null; // 子项的完整路径列表
  hasChildren: boolean;
}

// 设备检测与组件实例存储 Key
const { isMobile: isMobileDevice } = useDeviceDetection();
const isMobile = computed(() => isMobileDevice.value || (typeof window !== 'undefined' && window.innerWidth < 768));
const platform = computed<'mobile' | 'desktop'>(() => isMobile.value ? 'mobile' : 'desktop');

const componentStateStore = useComponentStateStore();
const layoutStore = useLayoutStore();

// 独立实例与分端存储的 Key
const storageKey = computed(() => `tree_show_files:${platform.value}:${props.instanceId || 'default'}`);

// 响应式版本号，确保 Map 内节点对象变更能被 computed 追踪
const treeVersion = ref(0);

// 内部维护显示文件状态（跟随组件实例与分端后端存储）
const internalShowFiles = ref<boolean>(
  componentStateStore.getState<boolean>(storageKey.value, false)
);

// 监听 storageKey 变动（如分端切换或实例切换）自动同步
watch(storageKey, (newKey) => {
  internalShowFiles.value = componentStateStore.getState<boolean>(newKey, false);
});

// 后端异步拉取完成时，更新至最新持久化设置
watch(() => componentStateStore.isLoaded, () => {
  internalShowFiles.value = componentStateStore.getState<boolean>(storageKey.value, internalShowFiles.value);
});

const isShowingFiles = computed<boolean>(() => {
  return props.showFiles !== undefined ? props.showFiles : internalShowFiles.value;
});

// 路径 -> 节点映射表
const nodesMap = ref<Map<string, TreeNode>>(new Map());
const treeContainerRef = ref<HTMLDivElement | null>(null);

// 保证节点存在
const ensureNode = (path: string, name: string, depth: number, isDirectory = true): TreeNode => {
  let node = nodesMap.value.get(path);
  if (!node) {
    node = {
      path,
      name,
      depth,
      isDirectory,
      isExpanded: path === '/', // 根目录默认展开
      isLoading: false,
      children: isDirectory ? null : [],
      hasChildren: isDirectory, // 目录初始假设可能有子项，加载后更新；普通文件没有子项
    };
    nodesMap.value.set(path, node);
  } else {
    node.isDirectory = isDirectory;
  }
  return node;
};

// 格式化目录路径
const normalizePath = (path: string): string => {
  if (!path || path === '/') return '/';
  return path.replace(/\/+$/, '') || '/';
};

// 获取父路径
const getParentPath = (path: string): string => {
  const norm = normalizePath(path);
  if (norm === '/') return '/';
  const lastSlash = norm.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : norm.substring(0, lastSlash);
};

// 获取文件图标与颜色类名
const getFileIconClass = (filename: string): { icon: string; color: string } => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (['js', 'ts', 'jsx', 'tsx', 'vue', 'json', 'html', 'css', 'scss', 'py', 'sh', 'c', 'cpp', 'rs', 'go', 'java', 'sql', 'php'].includes(ext)) {
    return { icon: 'fas fa-file-code', color: 'text-sky-400' };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) {
    return { icon: 'far fa-file-image', color: 'text-emerald-400' };
  }
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz'].includes(ext)) {
    return { icon: 'far fa-file-zipper', color: 'text-purple-400' };
  }
  if (['md', 'txt', 'log', 'conf', 'ini', 'yaml', 'yml', 'env', 'config'].includes(ext)) {
    return { icon: 'far fa-file-lines', color: 'text-amber-400' };
  }
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
    return { icon: 'far fa-file-audio', color: 'text-pink-400' };
  }
  if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) {
    return { icon: 'far fa-file-video', color: 'text-rose-400' };
  }
  if (['pdf'].includes(ext)) {
    return { icon: 'far fa-file-pdf', color: 'text-red-400' };
  }
  return { icon: 'far fa-file', color: 'text-text-secondary/70' };
};

// 加载指定路径的子项目
const loadChildren = async (node: TreeNode, forceRefresh = false): Promise<void> => {
  if (!node.isDirectory) return;
  if (!props.sftpManager || !props.isConnected || !props.isSftpReady) return;
  if (!forceRefresh && node.children !== null) return;

  node.isLoading = true;
  treeVersion.value++;
  try {
    const rawItems = await props.sftpManager.listDirectoryContents(node.path);
    // 过滤掉 '.' 和 '..'
    let validItems = rawItems.filter((item) => item.filename !== '.' && item.filename !== '..');

    if (!isShowingFiles.value) {
      // 仅保留文件夹
      validItems = validItems.filter((item) => item.attrs.isDirectory);
    }

    // 排序：文件夹优先，同类型按名称字母序
    validItems.sort((a, b) => {
      if (a.attrs.isDirectory && !b.attrs.isDirectory) return -1;
      if (!a.attrs.isDirectory && b.attrs.isDirectory) return 1;
      return a.filename.localeCompare(b.filename);
    });

    const childPaths: string[] = [];
    for (const item of validItems) {
      const subPath = node.path === '/' ? `/${item.filename}` : `${node.path}/${item.filename}`;
      ensureNode(subPath, item.filename, node.depth + 1, item.attrs.isDirectory);
      childPaths.push(subPath);
    }

    node.children = childPaths;
    node.hasChildren = childPaths.length > 0;
  } catch (error) {
    console.warn(`[DirectoryTree] 加载目录 ${node.path} 失败:`, error);
    // 未就绪或网络抖动时不硬编码写死为空，保持 null 以便重试
    node.children = null;
  } finally {
    node.isLoading = false;
    treeVersion.value++;
  }
};

// 展开/收起某个节点
const toggleExpand = async (node: TreeNode, event?: MouseEvent) => {
  if (event) event.stopPropagation();
  if (!node.isDirectory) return;

  if (node.isExpanded) {
    node.isExpanded = false;
    treeVersion.value++;
  } else {
    node.isExpanded = true;
    if (node.children === null) {
      await loadChildren(node);
    } else {
      treeVersion.value++;
    }
  }
};

// 点击节点项：目录则展开并跳转，文件则触发选中打开
const handleSelectNode = async (node: TreeNode) => {
  if (node.isDirectory) {
    if (!node.isExpanded && node.hasChildren) {
      node.isExpanded = true;
      if (node.children === null) {
        await loadChildren(node);
      } else {
        treeVersion.value++;
      }
    }
    emit('select-directory', node.path);
  } else {
    emit('select-file', node.path, node.name);
  }
};

// 展开并确保所有祖先路径就绪
const expandAncestors = async (targetPath: string) => {
  if (!props.isSftpReady) return;
  const norm = normalizePath(targetPath);
  const segments = norm === '/' ? [] : norm.split('/').filter(Boolean);

  let accumulated = '';
  const pathsToExpand = ['/'];

  for (const seg of segments) {
    accumulated += `/${seg}`;
    pathsToExpand.push(accumulated);
  }

  for (let i = 0; i < pathsToExpand.length; i++) {
    const p = pathsToExpand[i];
    const parentP = getParentPath(p);
    const parentNode = nodesMap.value.get(parentP);

    if (parentNode && parentNode.children === null) {
      await loadChildren(parentNode);
    }

    const currentNode = nodesMap.value.get(p);
    if (currentNode && i < pathsToExpand.length - 1) {
      currentNode.isExpanded = true;
      if (currentNode.children === null) {
        await loadChildren(currentNode);
      }
    }
  }

  treeVersion.value++;

  // 滚动到当前高亮节点
  nextTick(() => {
    const activeEl = treeContainerRef.value?.querySelector('.active-tree-node');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
};

// 拍平渲染的可见节点列表
const visibleNodes = computed<TreeNode[]>(() => {
  // 显式依赖版本号，确保状态变化必然重新触发计算
  void treeVersion.value;

  const list: TreeNode[] = [];

  const traverse = (nodePath: string) => {
    const node = nodesMap.value.get(nodePath);
    if (!node) return;

    list.push(node);

    if (node.isDirectory && node.isExpanded && node.children) {
      for (const childPath of node.children) {
        traverse(childPath);
      }
    }
  };

  traverse('/');
  return list;
});

// 刷新整个树
const refreshTree = async () => {
  if (!props.isSftpReady) return;
  nodesMap.value.clear();
  const root = ensureNode('/', '/', 0, true);
  await loadChildren(root, true);
  await expandAncestors(props.currentPath);
};

// 切换显示文件模式 (组件实例独立 + 分端 + 后端持久化)
const toggleShowFiles = async () => {
  const nextValue = !isShowingFiles.value;
  internalShowFiles.value = nextValue;
  componentStateStore.setState(storageKey.value, nextValue);
  emit('update:showFiles', nextValue);
  await refreshTree();
};

// 监听当前路径变化，自动展开对应树枝
watch(
  () => props.currentPath,
  (newPath) => {
    if (newPath && props.isSftpReady) {
      expandAncestors(newPath);
    }
  }
);

// 监听 SFTP 会话就绪状态
watch(
  () => props.isSftpReady,
  (ready) => {
    if (ready) {
      refreshTree();
    }
  },
  { immediate: true }
);

// 外部属性改变时同步刷新
watch(
  () => props.showFiles,
  (newVal) => {
    if (newVal !== undefined && newVal !== internalShowFiles.value) {
      internalShowFiles.value = newVal;
      refreshTree();
    }
  }
);

onMounted(() => {
  componentStateStore.initialize();
  ensureNode('/', '/', 0, true);
  if (props.isSftpReady) {
    refreshTree();
  }
});

onBeforeUnmount(() => {
  // 当检测不到该组件存在于布局中时，移除该存储项（独立实例垃圾回收）
  const instance = props.instanceId;
  const permanentList = ['modal', 'default', 'sidebar-left', 'sidebar-right'];
  if (instance && !permanentList.includes(instance)) {
    try {
      const activeIds = layoutStore.getAllActivePaneIds ? layoutStore.getAllActivePaneIds() : new Set<string>();
      if (!activeIds.has(instance)) {
        void componentStateStore.removeState(`tree_show_files:desktop:${instance}`);
        void componentStateStore.removeState(`tree_show_files:mobile:${instance}`);
      }
    } catch (e) {
      console.warn('[DirectoryTree] 卸载时清理组件状态失败:', e);
    }
  }
});

defineExpose({
  refreshTree,
  toggleShowFiles,
});
</script>

<template>
  <aside
    class="flex-shrink-0 flex flex-col border-r border-border/50 bg-background/50 select-none overflow-hidden transition-all duration-100"
    :style="{ width: `${width || 220}px` }"
  >
    <!-- 顶部标题工具栏（“目录树”栏） -->
    <div class="px-2.5 py-1.5 text-[11px] font-semibold text-text-secondary flex items-center justify-between border-b border-border/40 bg-header/40 flex-shrink-0">
      <span class="flex items-center gap-1.5 tracking-wider truncate">
        <i :class="isShowingFiles ? 'fas fa-folder-tree text-primary/80' : 'fas fa-sitemap text-primary/80'"></i>
        <span>{{ isShowingFiles ? t('fileManager.fileTree', '文件树') : t('fileManager.directoryTree', '目录树') }}</span>
      </span>

      <!-- 右侧操作工具按钮组 -->
      <div class="flex items-center gap-1 flex-shrink-0">
        <!-- 切换是否显示普通文件 -->
        <button
          type="button"
          @click="toggleShowFiles"
          class="w-5 h-5 rounded flex items-center justify-center transition-colors"
          :class="isShowingFiles ? 'text-primary bg-primary/20 hover:bg-primary/25 font-bold' : 'text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10'"
          :title="isShowingFiles ? t('fileManager.actions.hideFiles', '仅显示目录') : t('fileManager.actions.showFiles', '显示文件')"
        >
          <i :class="isShowingFiles ? 'fas fa-file-lines text-[10px]' : 'far fa-file text-[10px]'"></i>
        </button>

        <!-- 刷新目录树 -->
        <button
          type="button"
          @click="refreshTree"
          class="w-5 h-5 rounded flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          :title="t('fileManager.actions.refresh', '刷新目录树')"
        >
          <i class="fas fa-rotate-right text-[10px]"></i>
        </button>
      </div>
    </div>

    <!-- 树节点滚动列表 -->
    <div
      ref="treeContainerRef"
      class="flex-1 overflow-y-auto overflow-x-hidden p-1 space-y-0.5 text-xs font-mono"
    >
      <div
        v-for="node in visibleNodes"
        :key="node.path"
        @click="handleSelectNode(node)"
        class="group flex items-center py-1 px-1.5 rounded cursor-pointer transition-colors duration-100"
        :class="[
          node.isDirectory && normalizePath(props.currentPath) === normalizePath(node.path)
            ? 'active-tree-node bg-primary/15 text-primary border-r-2 border-primary font-medium'
            : 'text-text-secondary hover:text-foreground hover:bg-header/70',
        ]"
        :style="{ paddingLeft: `${node.depth * 14 + 6}px` }"
        :title="node.path"
      >
        <!-- 展开/折叠箭头（文件节点占位留白） -->
        <span
          class="w-4 h-4 flex items-center justify-center mr-1 text-text-secondary/70 hover:text-foreground transition-transform"
          @click.stop="toggleExpand(node, $event)"
        >
          <template v-if="node.isDirectory">
            <i
              v-if="node.isLoading"
              class="fas fa-circle-notch fa-spin text-[10px] text-primary"
            ></i>
            <i
              v-else-if="node.hasChildren"
              class="fas fa-chevron-right text-[9px] transition-transform duration-150"
              :class="{ 'rotate-90': node.isExpanded }"
            ></i>
            <span
              v-else
              class="inline-block w-1 h-1 rounded-full bg-border"
            ></span>
          </template>
          <span v-else class="inline-block w-1.5 h-1.5 rounded-full bg-border/40"></span>
        </span>

        <!-- 图标：文件夹或文件对应类型图标 -->
        <template v-if="node.isDirectory">
          <i
            class="fas mr-1.5 text-xs flex-shrink-0"
            :class="[
              node.isExpanded
                ? 'fa-folder-open text-amber-500/90'
                : 'fa-folder text-amber-500/80',
            ]"
          ></i>
        </template>
        <template v-else>
          <i
            class="mr-1.5 text-xs flex-shrink-0"
            :class="[getFileIconClass(node.name).icon, getFileIconClass(node.name).color]"
          ></i>
        </template>

        <!-- 名称 -->
        <span class="truncate flex-1 select-none text-[11px] leading-tight">
          {{ node.path === '/' ? '/' : node.name }}
        </span>
      </div>

      <!-- 空目录或未就绪 -->
      <div
        v-if="visibleNodes.length === 0"
        class="py-6 text-center text-text-secondary/60 text-xs italic"
      >
        {{ t('fileManager.loading', '正在加载目录...') }}
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 确保高亮条显示完整 */
.active-tree-node {
  box-shadow: inset 0 0 0 1px rgba(var(--color-primary-rgb, 56, 189, 248), 0.1);
}
</style>
