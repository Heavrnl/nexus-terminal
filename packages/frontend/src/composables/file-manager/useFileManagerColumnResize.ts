import { ref, onBeforeUnmount } from 'vue';

export interface ColumnWidths {
  type: number;
  name: number;
  size: number;
  permissions: number;
  modified: number;
}

export function useFileManagerColumnResize(
  initialWidths?: Partial<ColumnWidths>,
  onResizeEnd?: () => void
) {
  const colWidths = ref<ColumnWidths>({
    type: 50,
    name: 300,
    size: 100,
    permissions: 120,
    modified: 180,
    ...initialWidths,
  });

  const isResizing = ref(false);
  const resizingColumnIndex = ref(-1);
  const startX = ref(0);
  const startWidth = ref(0);

  const getColumnKeyByIndex = (index: number): keyof ColumnWidths | null => {
    const keys = Object.keys(colWidths.value) as Array<keyof ColumnWidths>;
    return keys[index] ?? null;
  };

  const handleResize = (event: MouseEvent) => {
    if (!isResizing.value || resizingColumnIndex.value < 0) return;
    const currentX = event.clientX;
    const diffX = currentX - startX.value;
    const newWidth = Math.max(30, startWidth.value + diffX);
    const colKey = getColumnKeyByIndex(resizingColumnIndex.value);
    if (colKey) {
      colWidths.value[colKey] = newWidth;
    }
  };

  const stopResize = () => {
    if (isResizing.value) {
      isResizing.value = false;
      resizingColumnIndex.value = -1;
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResizeEnd?.();
    }
  };

  const startResize = (event: MouseEvent, index: number) => {
    event.stopPropagation();
    event.preventDefault();
    isResizing.value = true;
    resizingColumnIndex.value = index;
    startX.value = event.clientX;
    const colKey = getColumnKeyByIndex(index);
    if (colKey) {
      startWidth.value = colWidths.value[colKey];
    } else {
      const thElement = (event.target as HTMLElement).closest('th');
      startWidth.value = thElement?.offsetWidth ?? 100;
    }
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const cleanup = () => {
    if (isResizing.value) {
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  onBeforeUnmount(cleanup);

  return {
    colWidths,
    isResizing,
    resizingColumnIndex,
    startResize,
    cleanup,
  };
}
