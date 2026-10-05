import { ref, computed, nextTick, type Ref, type ComputedRef } from 'vue';
import type { FileListItem } from '../../types/sftp.types';

// 定义 Composable 的输入参数类型
export interface UseFileManagerKeyboardNavigationOptions {
  // 响应式引用
  filteredFileList: ComputedRef<Readonly<FileListItem[]>>; // 当前显示的（已过滤/排序）文件列表
  currentPath: Ref<string>; // 当前路径 (用于判断是否显示 '..')
  fileListContainerRef: Ref<HTMLDivElement | null>; // 文件列表容器的引用 (用于滚动)

  // 回调函数
  onEnterPress: (item: FileListItem) => void; // 按下 Enter 键时触发的回调
  onScrollToIndex?: (index: number) => void; // 虚拟滚动对齐回调
}

export function useFileManagerKeyboardNavigation(options: UseFileManagerKeyboardNavigationOptions) {
  const {
    filteredFileList,
    currentPath,
    fileListContainerRef,
    onEnterPress,
    onScrollToIndex,
  } = options;

  // --- 状态 Refs ---
  const selectedIndex = ref<number>(-1); // 键盘选中索引 (-1 表示未选中, 0 代表 '..', 1+ 代表 filteredList 的 index + 1)

  // --- 计算属性 ---
  // 是否显示 '..' 行
  const hasParentLink = computed(() => currentPath.value !== '/');
  // 列表总项目数 (包括 '..')
  const totalItems = computed(() => filteredFileList.value.length + (hasParentLink.value ? 1 : 0));

  // --- 滚动到选中项 ---
  const scrollToSelected = async () => {
    if (selectedIndex.value < 0) return;
    if (onScrollToIndex) {
      onScrollToIndex(selectedIndex.value);
      return;
    }

    await nextTick();
    if (!fileListContainerRef.value) return;

    const container = fileListContainerRef.value;
    const rows = container.querySelectorAll('tbody > tr');
    if (selectedIndex.value >= rows.length) return;

    const selectedRow = rows[selectedIndex.value] as HTMLElement;
    if (selectedRow) {
      selectedRow.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  };

  // --- 键盘事件处理 ---
  const handleKeydown = (event: KeyboardEvent) => {
    if (totalItems.value === 0) return;

    let currentEffectiveIndex = selectedIndex.value;

    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            currentEffectiveIndex = (currentEffectiveIndex + 1) % totalItems.value;
            selectedIndex.value = currentEffectiveIndex;
            scrollToSelected();
            break;
        case 'ArrowUp':
            event.preventDefault();
            currentEffectiveIndex = (currentEffectiveIndex - 1 + totalItems.value) % totalItems.value;
            selectedIndex.value = currentEffectiveIndex;
            scrollToSelected();
            break;
        case 'Enter':
            event.preventDefault();
            if (selectedIndex.value === 0 && hasParentLink.value) {
                // 选中 '..'
                // 创建一个临时的 '..' FileListItem 对象传递给回调
                onEnterPress({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } });
            } else if (selectedIndex.value > 0) {
                // 选中列表中的项
                const itemIndexInFilteredList = selectedIndex.value - (hasParentLink.value ? 1 : 0);
                if (itemIndexInFilteredList >= 0 && itemIndexInFilteredList < filteredFileList.value.length) {
                    onEnterPress(filteredFileList.value[itemIndexInFilteredList]);
                }
            }
            break;
    }
  };

  // --- 重置索引的 Watchers (移至 FileManager.vue 中，因为它需要监听更多状态) ---
  // watch(currentPath, () => { selectedIndex.value = -1; });
  // watch(searchQuery, () => { selectedIndex.value = -1; });
  // watch(sortKey, () => { selectedIndex.value = -1; });
  // watch(sortDirection, () => { selectedIndex.value = -1; });

  // --- 返回状态和处理函数 ---
  return {
    selectedIndex, // 暴露键盘选中索引
    handleKeydown, // 暴露键盘事件处理器
    // scrollToSelected, // 内部使用，通常不需要暴露
  };
}