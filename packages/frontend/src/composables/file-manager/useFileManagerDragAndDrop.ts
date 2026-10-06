import { ref, type Ref } from 'vue';
import type { FileListItem } from '../../types/sftp.types';

// 定义跨窗格/内部 SFTP 拖拽数据项
export interface NexusSftpDragItem {
  filename: string;
  fullPath: string;
  isDirectory: boolean;
  size: number;
}

// 定义跨窗格/内部 SFTP 拖拽载荷
export interface NexusSftpDragPayload {
  sessionId: string;
  instanceId: string;
  sourceDirectory: string;
  items: NexusSftpDragItem[];
}

// 全局内存共享状态，跨所有 FileManager 实例和组件通信
export const activeSftpDragPayload = ref<NexusSftpDragPayload | null>(null);

// 定义 Composable 的输入参数类型
export interface UseFileManagerDragAndDropOptions {
  sessionId: Ref<string>;
  instanceId: string;
  isConnected: Ref<boolean>;
  currentPath: Ref<string>;
  fileListContainerRef: Ref<HTMLDivElement | null>;
  selectedItems: Ref<Set<string>>;
  fileList: Ref<Readonly<FileListItem[]>>;
  joinPath: (base: string, target: string) => string;
  onFileUpload: (file: File, relativePath?: string) => void;
  onItemMove?: (sourceItem: FileListItem, newFullPath: string) => void;
  onMoveItems: (sourcePaths: string[], destinationDir: string, sourceDir?: string) => void;
}

export function useFileManagerDragAndDrop(options: UseFileManagerDragAndDropOptions) {
  const {
    sessionId,
    instanceId,
    isConnected,
    currentPath,
    fileListContainerRef,
    joinPath,
    onFileUpload,
    onMoveItems,
    selectedItems,
    fileList,
  } = options;

  // --- 拖放状态 Refs ---
  const showExternalDropOverlay = ref(false); // 控制外部桌面文件拖拽上传蒙版的显示
  const draggedItem = ref<FileListItem | null>(null); // 当前实例发起的内部拖拽项
  const dragOverTarget = ref<string | null>(null); // 悬停的目标文件夹名称 (用于行高亮)
  const isContainerDropTarget = ref(false); // 跨窗格拖到当前列表空白区域的高亮状态
  const scrollIntervalId = ref<number | null>(null); // 自动滚动计时器 ID

  // --- 自动滚动常量 ---
  const SCROLL_ZONE_HEIGHT = 50; // px
  const SCROLL_SPEED = 10; // px per interval

  // --- 辅助函数：计算父目录 ---
  const getParentPath = (path: string): string => {
    if (path === '/' || !path) return '/';
    const lastSlashIndex = path.lastIndexOf('/');
    if (lastSlashIndex <= 0) return '/';
    return path.substring(0, lastSlashIndex);
  };

  // --- 辅助函数：停止自动滚动 ---
  const stopAutoScroll = () => {
    if (scrollIntervalId.value !== null) {
      clearInterval(scrollIntervalId.value);
      scrollIntervalId.value = null;
    }
  };

  // --- 辅助函数：检测并触发边缘平滑自动滚动 ---
  const checkAndTriggerAutoScroll = (event: DragEvent) => {
    const container = fileListContainerRef.value;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseY = event.clientY - rect.top;

    if (mouseY < SCROLL_ZONE_HEIGHT) {
      if (scrollIntervalId.value === null) {
        scrollIntervalId.value = window.setInterval(() => {
          if (container.scrollTop > 0) {
            container.scrollTop -= SCROLL_SPEED;
          } else {
            stopAutoScroll();
          }
        }, 30);
      }
    } else if (mouseY > container.clientHeight - SCROLL_ZONE_HEIGHT) {
      if (scrollIntervalId.value === null) {
        scrollIntervalId.value = window.setInterval(() => {
          if (container.scrollTop < container.scrollHeight - container.clientHeight) {
            container.scrollTop += SCROLL_SPEED;
          } else {
            stopAutoScroll();
          }
        }, 30);
      }
    } else {
      stopAutoScroll();
    }
  };

  // --- 辅助函数：从 DragEvent 解析拖拽载荷 ---
  const extractDragPayload = (event: DragEvent): NexusSftpDragPayload | null => {
    if (activeSftpDragPayload.value) {
      return activeSftpDragPayload.value;
    }
    const rawData = event.dataTransfer?.getData('application/x-nexus-sftp-items');
    if (rawData) {
      try {
        return JSON.parse(rawData) as NexusSftpDragPayload;
      } catch (err) {
        console.warn('[DragDrop] Failed to parse sftp drag payload JSON:', err);
      }
    }
    return null;
  };

  // --- 事件处理函数：DragEnter ---
  const handleDragEnter = (event: DragEvent) => {
    if (!isConnected.value) return;

    const payload = extractDragPayload(event);
    const isExternalFileDrag = !payload && (event.dataTransfer?.types.includes('Files') ?? false);

    if (isExternalFileDrag) {
      showExternalDropOverlay.value = true;
      return;
    }

    if (payload) {
      // 属于 SFTP 项目拖拽（跨窗格或本窗格）
      const targetElement = event.target as HTMLElement;
      const targetRow = targetElement.closest('tr');
      if (!targetRow && payload.sourceDirectory !== currentPath.value) {
        isContainerDropTarget.value = true;
      }
    }
  };

  // --- 事件处理函数：DragOver (容器级别) ---
  const handleDragOver = (event: DragEvent) => {
    const payload = extractDragPayload(event);
    const isExternalFileDrag = !payload && (event.dataTransfer?.types.includes('Files') ?? false);

    // 1. 外部文件拖拽：由蒙版接管
    if (isExternalFileDrag && isConnected.value) {
      showExternalDropOverlay.value = true;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      stopAutoScroll();
      return;
    }

    // 2. SFTP 项目拖拽（本窗格或跨窗格）
    if (payload && isConnected.value) {
      event.preventDefault();
      const targetElement = event.target as HTMLElement;
      const targetRow = targetElement.closest('tr');

      if (!targetRow) {
        // 鼠标在行之外的列表空白区域
        dragOverTarget.value = null;
        if (payload.sourceDirectory !== currentPath.value) {
          isContainerDropTarget.value = true;
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        } else {
          isContainerDropTarget.value = false;
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
        }
      } else if (event.dataTransfer) {
        // 鼠标在某行上：如果跨窗格拖拽，始终允许放置到当前目录
        if (payload.sourceDirectory !== currentPath.value) {
          isContainerDropTarget.value = true;
          event.dataTransfer.dropEffect = 'move';
        }
      }

      checkAndTriggerAutoScroll(event);
      return;
    }

    // 3. 其他情况
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    stopAutoScroll();
  };

  // --- 事件处理函数：DragLeave ---
  const handleDragLeave = (event: DragEvent) => {
    const target = event.relatedTarget as Node | null;
    const container = event.currentTarget as HTMLElement;

    if (!target || !container.contains(target)) {
      if (showExternalDropOverlay.value) {
        showExternalDropOverlay.value = false;
      }
      dragOverTarget.value = null;
      isContainerDropTarget.value = false;
      stopAutoScroll();
    } else {
      const payload = extractDragPayload(event);
      if (payload) {
        const relatedRow = (target instanceof HTMLElement) ? target.closest('tr') : null;
        if (!relatedRow) {
          dragOverTarget.value = null;
        }
      }
    }
  };

  // --- 递归遍历外部文件夹树 ---
  const traverseFileTree = (item: FileSystemEntry, path = '') => {
    path = path || '';
    if (item.isFile) {
      (item as FileSystemFileEntry).file((file) => {
        onFileUpload(file, path);
      }, (err) => {
        console.error(`[DragDrop] Error getting file from entry: ${path}${item.name}`, err);
      });
    } else if (item.isDirectory) {
      const dirReader = (item as FileSystemDirectoryEntry).createReader();
      dirReader.readEntries((entries) => {
        entries.forEach((entry) => {
          traverseFileTree(entry, path + item.name + '/');
        });
      }, (err) => {
        console.error(`[DragDrop] Error reading directory entries: ${path}${item.name}`, err);
      });
    }
  };

  // --- 蒙版上的外部 Drop 处理 ---
  const handleOverlayDrop = (event: DragEvent) => {
    event.preventDefault();
    showExternalDropOverlay.value = false;
    stopAutoScroll();

    const items = event.dataTransfer?.items;
    if (!items || items.length === 0 || !isConnected.value) {
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          traverseFileTree(entry);
        }
      }
    }
  };

  // --- 容器空白处的 Drop 处理 (支持跨窗格移动到当前目录) ---
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    showExternalDropOverlay.value = false;
    isContainerDropTarget.value = false;
    dragOverTarget.value = null;
    stopAutoScroll();

    const payload = extractDragPayload(event);
    if (!payload || !isConnected.value) {
      draggedItem.value = null;
      activeSftpDragPayload.value = null;
      return;
    }

    const targetDirectory = currentPath.value;
    // 如果源目录就是当前目录，说明是在同一目录内放到了空白处，无需操作
    if (payload.sourceDirectory === targetDirectory) {
      draggedItem.value = null;
      activeSftpDragPayload.value = null;
      return;
    }

    const sourcePaths = payload.items.map(it => it.fullPath);
    console.log(`[DragDrop] 跨窗格移动 ${sourcePaths.length} 个项目到当前目录: ${targetDirectory}`);
    onMoveItems(sourcePaths, targetDirectory, payload.sourceDirectory);

    draggedItem.value = null;
    activeSftpDragPayload.value = null;
  };

  // --- 开始拖拽 (支持多选和向终端输入路径) ---
  const handleDragStart = (item: FileListItem, event: DragEvent) => {
    if (item.filename === '..') return;

    let itemsToDrag: FileListItem[] = [];
    if (selectedItems.value.has(item.filename)) {
      itemsToDrag = Array.from(selectedItems.value)
        .map(fn => fileList.value.find(f => f.filename === fn))
        .filter(Boolean) as FileListItem[];
    } else {
      itemsToDrag = [item];
    }

    if (itemsToDrag.length === 0) {
      itemsToDrag = [item];
    }

    draggedItem.value = item;

    const payload: NexusSftpDragPayload = {
      sessionId: sessionId.value,
      instanceId,
      sourceDirectory: currentPath.value,
      items: itemsToDrag.map(it => ({
        filename: it.filename,
        fullPath: joinPath(currentPath.value, it.filename),
        isDirectory: it.attrs.isDirectory,
        size: it.attrs.size,
      })),
    };

    activeSftpDragPayload.value = payload;

    if (event.dataTransfer) {
      // 1. 设置纯文本格式：双引号包裹绝对路径 + 空格结尾，专门供终端、文本编辑器接收
      // 例如："/var/log/nginx/access.log" 
      const terminalText = payload.items.map(it => `"${it.fullPath}"`).join(' ') + ' ';
      event.dataTransfer.setData('text/plain', terminalText);

      // 2. 设置专属 JSON 载荷供跨窗格/内部文件管理器识别
      event.dataTransfer.setData('application/x-nexus-sftp-items', JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'copyMove';
    }
  };

  // --- 拖拽结束清理 ---
  const handleDragEnd = () => {
    draggedItem.value = null;
    dragOverTarget.value = null;
    isContainerDropTarget.value = false;
    activeSftpDragPayload.value = null;
    stopAutoScroll();
  };

  // --- 行悬停处理 ---
  const handleDragOverRow = (targetItem: FileListItem, event: DragEvent) => {
    event.preventDefault();

    const payload = extractDragPayload(event);
    if (!payload || !isConnected.value) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      dragOverTarget.value = null;
      return;
    }

    // 触发边缘平滑自动滚动（即使列表产生滚动条且鼠标悬停在行上，也能上下滚动）
    checkAndTriggerAutoScroll(event);

    const isTargetDir = targetItem.filename === '..' || targetItem.attrs.isDirectory;

    // 跨窗格拖拽场景
    if (payload.sourceDirectory !== currentPath.value) {
      if (isTargetDir) {
        // 跨窗格拖拽到目标文件夹或 ..
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        dragOverTarget.value = targetItem.filename;
        isContainerDropTarget.value = false;
      } else {
        // 跨窗格拖拽到普通文件行 -> 目标为当前窗格的当前目录！
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        dragOverTarget.value = null;
        isContainerDropTarget.value = true;
      }
      return;
    }

    // 同窗格内拖拽场景：必须是文件夹或 '..'
    if (!isTargetDir) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      dragOverTarget.value = null;
      isContainerDropTarget.value = false;
      return;
    }

    // 同窗格内不能拖到自身
    if (payload.items.some(it => it.filename === targetItem.filename)) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      dragOverTarget.value = null;
      isContainerDropTarget.value = false;
      return;
    }

    // 有效放置目标（子文件夹或 '..'）
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dragOverTarget.value = targetItem.filename;
    isContainerDropTarget.value = false;
  };

  // --- 离开行 ---
  const handleDragLeaveRow = (targetItem: FileListItem) => {
    if (dragOverTarget.value === targetItem.filename) {
      dragOverTarget.value = null;
    }
  };

  // --- 放置在具体某行上 (子文件夹、.. 或跨窗格落在普通文件行) ---
  const handleDropOnRow = (targetItem: FileListItem, event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const payload = extractDragPayload(event);
    dragOverTarget.value = null;
    isContainerDropTarget.value = false;
    stopAutoScroll();

    if (!payload || !isConnected.value) {
      draggedItem.value = null;
      activeSftpDragPayload.value = null;
      return;
    }

    const isTargetDir = targetItem.filename === '..' || targetItem.attrs.isDirectory;

    // 计算放置的目标目录
    let targetDirectory = '';
    if (targetItem.filename === '..') {
      targetDirectory = getParentPath(currentPath.value);
    } else if (targetItem.attrs.isDirectory) {
      targetDirectory = joinPath(currentPath.value, targetItem.filename);
    } else {
      // 目标是普通文件行
      if (payload.sourceDirectory !== currentPath.value) {
        // 跨窗格拖拽落在普通文件行上，意图为移动到当前窗格的当前目录！
        targetDirectory = currentPath.value;
      } else {
        // 同窗格内拖到普通文件行，无操作
        draggedItem.value = null;
        activeSftpDragPayload.value = null;
        return;
      }
    }

    // 不能移动到源目录相同的子目录（自身）
    if (payload.sourceDirectory === currentPath.value && payload.items.some(it => it.filename === targetItem.filename)) {
      draggedItem.value = null;
      activeSftpDragPayload.value = null;
      return;
    }

    const sourcePaths = payload.items.map(it => it.fullPath);
    console.log(`[DragDrop] 移动 ${sourcePaths.length} 个项目到目标目录: ${targetDirectory}`);
    onMoveItems(sourcePaths, targetDirectory, payload.sourceDirectory);

    draggedItem.value = null;
    activeSftpDragPayload.value = null;
  };

  return {
    showExternalDropOverlay,
    dragOverTarget,
    isContainerDropTarget,
    draggedItem,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleOverlayDrop,
    handleDragStart,
    handleDragEnd,
    handleDragOverRow,
    handleDragLeaveRow,
    handleDropOnRow,
  };
}