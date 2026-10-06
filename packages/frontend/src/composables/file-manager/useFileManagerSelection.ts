import { ref, type Ref } from 'vue';
import type { FileListItem } from '../../types/sftp.types'; // 确保路径正确

// 定义 Composable 的输入参数类型
export interface UseFileManagerSelectionOptions {
  // 注意：这里传入的应该是当前渲染在表格中的列表 (可能已排序/过滤)
  // 在 FileManager.vue 中，这通常是 filteredFileList 或 sortedFileList
  displayedFileList: Ref<Readonly<FileListItem[]>>;
  // 回调函数，当需要执行导航或打开文件时调用
  onItemAction: (item: FileListItem) => void;
  // 是否开启双击打开模式 (默认 false：单击打开)
  doubleClickToOpen?: Ref<boolean>;
}

export function useFileManagerSelection(options: UseFileManagerSelectionOptions) {
  const { displayedFileList, onItemAction, doubleClickToOpen } = options;

  const selectedItems = ref(new Set<string>());
  const lastClickedIndex = ref(-1); // 索引相对于 displayedFileList

  const handleItemClick = (event: MouseEvent, item: FileListItem) => {
    let shouldPerformAction = false; // 初始化标志
    const ctrlOrMeta = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;

    // 查找点击项在当前显示列表中的索引
    const itemIndex = displayedFileList.value.findIndex((f) => f.filename === item.filename);

    // 如果找不到项（理论上不应发生），或者点击的是 '..'
    if (itemIndex === -1) {
        if (item.filename === '..') {
            // 只有在没有修饰键时才执行 '..' 的动作
            if (!ctrlOrMeta && !shift) {
                selectedItems.value.clear();
                lastClickedIndex.value = -1;
                // 若开启双击打开，单击不触发动作
                if (!doubleClickToOpen?.value) {
                    shouldPerformAction = true;
                }
            }
        } else {
             // 如果不是 '..' 且找不到索引，则忽略无效点击
             return;
        }
        if (item.filename === '..' && (ctrlOrMeta || shift)) {
             return;
        }
        if (item.filename !== '..' && itemIndex === -1) {
             return;
        }
    }

    // --- 主要选择逻辑 ---
    if (ctrlOrMeta) { // 1. 检查 Ctrl/Meta
      event.preventDefault();
      event.stopPropagation(); // <-- 阻止冒泡
      if (selectedItems.value.has(item.filename)) {
        selectedItems.value.delete(item.filename);
      } else {
        selectedItems.value.add(item.filename);
      }
      lastClickedIndex.value = itemIndex; // 更新最后点击的索引
    } else if (shift) { // 2. 检查 Shift
      event.preventDefault();
      event.stopPropagation(); // <-- 阻止冒泡
      selectedItems.value.clear();
      const start = lastClickedIndex.value === -1 ? itemIndex : Math.min(lastClickedIndex.value, itemIndex);
      const end = lastClickedIndex.value === -1 ? itemIndex : Math.max(lastClickedIndex.value, itemIndex);
      for (let i = start; i <= end; i++) {
        const fileToAdd = displayedFileList.value[i];
        if (fileToAdd && fileToAdd.filename !== '..') {
          selectedItems.value.add(fileToAdd.filename);
        }
      }
      lastClickedIndex.value = itemIndex;
    } else { // 3. 处理普通单击 (没有修饰键)
      selectedItems.value.clear();
      if (item.filename !== '..') {
          selectedItems.value.add(item.filename);
          lastClickedIndex.value = itemIndex; // 更新最后点击的索引
      }
      // 只有在关闭双击打开时，普通单击才直接执行打开文件/进入目录
      if (!doubleClickToOpen?.value) {
        shouldPerformAction = true;
      }
    }

    // 在函数末尾根据标志决定是否执行动作
    if (shouldPerformAction) {
        onItemAction(item);
    }
  };

  // 双击事件处理器：无论何种模式，双击始终执行打开/进入操作
  const handleItemDoubleClick = (_event: MouseEvent, item: FileListItem) => {
    const itemIndex = displayedFileList.value.findIndex((f) => f.filename === item.filename);
    selectedItems.value.clear();
    if (item.filename !== '..') {
      selectedItems.value.add(item.filename);
      lastClickedIndex.value = itemIndex;
    } else {
      lastClickedIndex.value = -1;
    }
    onItemAction(item);
  };

  // 清空选择的辅助函数
  const clearSelection = () => {
      selectedItems.value.clear();
      lastClickedIndex.value = -1;
  };

  return {
    selectedItems,
    lastClickedIndex,
    handleItemClick,
    handleItemDoubleClick,
    clearSelection,
  };
}