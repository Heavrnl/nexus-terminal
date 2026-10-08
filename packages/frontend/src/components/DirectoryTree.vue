<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SftpManagerInstance } from '../composables/useSftpActions';

const props = defineProps<{
  currentPath: string;
  isConnected: boolean;
  sftpManager: SftpManagerInstance | null;
  width?: number;
}>();

const emit = defineEmits<{
  (e: 'select-directory', path: string): void;
}>();

const { t } = useI18n();

interface TreeNode {
  path: string;
  name: string;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  children: string[] | null; // 子目录的完整路径列表
  hasChildren: boolean;
}

// 路径 -> 节点映射表
const nodesMap = ref<Map<string, TreeNode>>(new Map());
const treeContainerRef = ref<HTMLDivElement | null>(null);

// 保证节点存在
const ensureNode = (path: string, name: string, depth: number): TreeNode => {
  let node = nodesMap.value.get(path);
  if (!node) {
    node = {
      path,
      name,
      depth,
      isExpanded: path === '/', // 根目录默认展开
      isLoading: false,
      children: null,
      hasChildren: true, // 初始假设可能有子项，加载后更新
    };
    nodesMap.value.set(path, node);
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

// 加载指定路径的子目录
const loadChildren = async (node: TreeNode, forceRefresh = false): Promise<void> => {
  if (!props.sftpManager || !props.isConnected) return;
  if (!forceRefresh && node.children !== null) return;

  node.isLoading = true;
  try {
    const rawItems = await props.sftpManager.listDirectoryContents(node.path);
    // 仅保留文件夹，过滤掉普通文件和隐藏系统特异项
    const dirItems = rawItems
      .filter((item) => item.attrs.isDirectory && item.filename !== '.' && item.filename !== '..')
      .sort((a, b) => a.filename.localeCompare(b.filename));

    const childPaths: string[] = [];
    for (const item of dirItems) {
      const subPath = node.path === '/' ? `/${item.filename}` : `${node.path}/${item.filename}`;
      ensureNode(subPath, item.filename, node.depth + 1);
      childPaths.push(subPath);
    }

    node.children = childPaths;
    node.hasChildren = childPaths.length > 0;
  } catch (error) {
    console.warn(`[DirectoryTree] 加载目录 ${node.path} 失败:`, error);
    node.children = [];
    node.hasChildren = false;
  } finally {
    node.isLoading = false;
  }
};

// 展开/收起某个节点
const toggleExpand = async (node: TreeNode, event?: MouseEvent) => {
  if (event) event.stopPropagation();

  if (node.isExpanded) {
    node.isExpanded = false;
  } else {
    node.isExpanded = true;
    if (node.children === null) {
      await loadChildren(node);
    }
  }
};

// 点击目录项：展开并跳转
const handleSelectNode = async (node: TreeNode) => {
  if (!node.isExpanded && node.hasChildren) {
    node.isExpanded = true;
    if (node.children === null) {
      await loadChildren(node);
    }
  }
  emit('select-directory', node.path);
};

// 展开并确保所有祖先路径就绪
const expandAncestors = async (targetPath: string) => {
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
    }
  }

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
  const list: TreeNode[] = [];

  const traverse = (nodePath: string) => {
    const node = nodesMap.value.get(nodePath);
    if (!node) return;

    list.push(node);

    if (node.isExpanded && node.children) {
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
  const root = ensureNode('/', '/', 0);
  await loadChildren(root, true);
  await expandAncestors(props.currentPath);
};

// 监听当前路径变化，自动展开对应树枝
watch(
  () => props.currentPath,
  (newPath) => {
    if (newPath) {
      expandAncestors(newPath);
    }
  },
  { immediate: true }
);

// 监听连接状态
watch(
  () => props.isConnected,
  (connected) => {
    if (connected) {
      refreshTree();
    }
  }
);

onMounted(() => {
  ensureNode('/', '/', 0);
  if (props.isConnected) {
    refreshTree();
  }
});

defineExpose({
  refreshTree,
});
</script>

<template>
  <aside
    class="flex-shrink-0 flex flex-col border-r border-border/50 bg-background/50 select-none overflow-hidden transition-all duration-100"
    :style="{ width: `${width || 220}px` }"
  >
    <!-- 顶部标题工具栏 -->
    <div class="px-2.5 py-1.5 text-[11px] font-semibold text-text-secondary flex items-center justify-between border-b border-border/40 bg-header/40 flex-shrink-0">
      <span class="flex items-center gap-1.5 tracking-wider">
        <i class="fas fa-sitemap text-primary/80"></i>
        <span>{{ t('fileManager.directoryTree', '目录树') }}</span>
      </span>
      <button
        type="button"
        @click="refreshTree"
        class="w-5 h-5 rounded flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition"
        :title="t('fileManager.actions.refresh', '刷新目录树')"
      >
        <i class="fas fa-rotate-right text-[10px]"></i>
      </button>
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
          normalizePath(props.currentPath) === normalizePath(node.path)
            ? 'active-tree-node bg-primary/15 text-primary border-r-2 border-primary font-medium'
            : 'text-text-secondary hover:text-foreground hover:bg-header/70',
        ]"
        :style="{ paddingLeft: `${node.depth * 14 + 6}px` }"
        :title="node.path"
      >
        <!-- 展开/折叠箭头或小圆点 -->
        <span
          class="w-4 h-4 flex items-center justify-center mr-1 text-text-secondary/70 hover:text-foreground transition-transform"
          @click.stop="toggleExpand(node, $event)"
        >
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
        </span>

        <!-- 文件夹图标 -->
        <i
          class="fas mr-1.5 text-xs flex-shrink-0"
          :class="[
            node.isExpanded
              ? 'fa-folder-open text-amber-500/90'
              : 'fa-folder text-amber-500/80',
          ]"
        ></i>

        <!-- 文件夹名称 -->
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
