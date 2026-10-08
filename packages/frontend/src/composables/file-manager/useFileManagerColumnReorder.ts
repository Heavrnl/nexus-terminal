import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue';
import type { useComponentStateStore } from '../../stores/componentState.store';

export type FileManagerColumnKey = 'type' | 'name' | 'size' | 'permissions' | 'modified';

export const DEFAULT_COLUMN_ORDER: FileManagerColumnKey[] = ['type', 'name', 'size', 'permissions', 'modified'];

export interface ColumnMeta {
  key: FileManagerColumnKey;
  sortKey: 'type' | 'filename' | 'size' | 'mtime' | null;
  labelKey: string;
}

export const COLUMN_CONFIG_MAP: Record<FileManagerColumnKey, ColumnMeta> = {
  type: { key: 'type', sortKey: 'type', labelKey: 'fileManager.headers.type' },
  name: { key: 'name', sortKey: 'filename', labelKey: 'fileManager.headers.name' },
  size: { key: 'size', sortKey: 'size', labelKey: 'fileManager.headers.size' },
  permissions: { key: 'permissions', sortKey: null, labelKey: 'fileManager.headers.permissions' },
  modified: { key: 'modified', sortKey: 'mtime', labelKey: 'fileManager.headers.modified' },
};

export function useFileManagerColumnReorder(options: {
  instanceId: string;
  componentStateStore: ReturnType<typeof useComponentStateStore>;
  isResizing: Ref<boolean>;
  onSort: (key: 'type' | 'filename' | 'size' | 'mtime') => void;
}) {
  const { instanceId, componentStateStore, isResizing, onSort } = options;

  const colOrderStateKey = computed(() => `fm_col_order:desktop:${instanceId}`);
  const columnOrder = ref<FileManagerColumnKey[]>([...DEFAULT_COLUMN_ORDER]);

  // 从 store 中初始化列顺序
  const initColumnOrder = () => {
    const saved = componentStateStore.getState<FileManagerColumnKey[]>(colOrderStateKey.value);
    if (Array.isArray(saved) && saved.length > 0) {
      const validKeys = saved.filter(k => DEFAULT_COLUMN_ORDER.includes(k));
      for (const key of DEFAULT_COLUMN_ORDER) {
        if (!validKeys.includes(key)) {
          validKeys.push(key);
        }
      }
      columnOrder.value = validKeys;
    } else {
      columnOrder.value = [...DEFAULT_COLUMN_ORDER];
    }
  };

  watch(
    [() => instanceId, () => componentStateStore.isLoaded],
    () => {
      initColumnOrder();
    },
    { immediate: true }
  );

  const saveColumnOrder = (newOrder: FileManagerColumnKey[]) => {
    columnOrder.value = [...newOrder];
    componentStateStore.setState(colOrderStateKey.value, newOrder);
  };

  // 拖拽换序状态
  const isDraggingColumn = ref(false);
  const dragSourceCol = ref<FileManagerColumnKey | null>(null);
  const dragOverCol = ref<FileManagerColumnKey | null>(null);
  const dropPosition = ref<'before' | 'after'>('before');
  const dragMouseX = ref(0);
  const dragMouseY = ref(0);

  let startX = 0;
  let startY = 0;
  let isPointerDown = false;
  let pendingColKey: FileManagerColumnKey | null = null;
  let pendingSortKey: 'type' | 'filename' | 'size' | 'mtime' | null = null;

  const startColumnDrag = (colKey: FileManagerColumnKey) => {
    isDraggingColumn.value = true;
    dragSourceCol.value = colKey;
    dragOverCol.value = colKey;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  };

  const updateDropTarget = (clientX: number, clientY: number) => {
    dragMouseX.value = clientX;
    dragMouseY.value = clientY;

    const el = document.elementFromPoint(clientX, clientY);
    const th = el?.closest('th[data-col-key]') as HTMLElement | null;
    if (th) {
      const targetCol = th.getAttribute('data-col-key') as FileManagerColumnKey | null;
      if (targetCol && DEFAULT_COLUMN_ORDER.includes(targetCol)) {
        dragOverCol.value = targetCol;
        const rect = th.getBoundingClientRect();
        dropPosition.value = clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }
    }
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isPointerDown) return;

    dragMouseX.value = e.clientX;
    dragMouseY.value = e.clientY;

    if (!isDraggingColumn.value) {
      if (pendingColKey && Math.hypot(e.clientX - startX, e.clientY - startY) > 3) {
        startColumnDrag(pendingColKey);
        updateDropTarget(e.clientX, e.clientY);
      }
    } else {
      updateDropTarget(e.clientX, e.clientY);
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isPointerDown) return;
    isPointerDown = false;

    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (isDraggingColumn.value) {
      const source = dragSourceCol.value;
      const target = dragOverCol.value;
      const position = dropPosition.value;

      if (source && target && source !== target) {
        const newOrder = [...columnOrder.value];
        const sourceIndex = newOrder.indexOf(source);
        if (sourceIndex !== -1) {
          newOrder.splice(sourceIndex, 1);
          const targetIndex = newOrder.indexOf(target);
          if (targetIndex !== -1) {
            const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
            newOrder.splice(insertIndex, 0, source);
            saveColumnOrder(newOrder);
          }
        }
      }

      isDraggingColumn.value = false;
      dragSourceCol.value = null;
      dragOverCol.value = null;
    } else {
      // 原地释放（移动不超过 3px）：判定为点击排序
      if (pendingSortKey) {
        onSort(pendingSortKey);
      }
    }

    pendingColKey = null;
    pendingSortKey = null;
  };

  const handleHeaderPointerDown = (
    event: PointerEvent,
    colKey: FileManagerColumnKey,
    sortKey: 'type' | 'filename' | 'size' | 'mtime' | null
  ) => {
    if (isResizing.value || event.button !== 0) return;

    isPointerDown = true;
    startX = event.clientX;
    startY = event.clientY;
    dragMouseX.value = event.clientX;
    dragMouseY.value = event.clientY;
    pendingColKey = colKey;
    pendingSortKey = sortKey;

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  const cleanup = () => {
    isPointerDown = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  onBeforeUnmount(cleanup);

  return {
    columnOrder,
    isDraggingColumn,
    dragSourceCol,
    dragOverCol,
    dropPosition,
    dragMouseX,
    dragMouseY,
    handleHeaderPointerDown,
    saveColumnOrder,
    cleanup,
  };
}
