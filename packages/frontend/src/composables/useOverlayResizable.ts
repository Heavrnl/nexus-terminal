import { ref, computed, onBeforeUnmount } from 'vue';

export interface UseOverlayResizableOptions {
  initialWidthRatio?: number; // 默认 0.75
  initialHeightRatio?: number; // 默认 0.85
  minWidth?: number; // 默认 400
  minHeight?: number; // 默认 300
  isMobile?: boolean;
  onClose?: () => void;
}

export function useOverlayResizable(options: UseOverlayResizableOptions = {}) {
  const {
    initialWidthRatio = 0.75,
    initialHeightRatio = 0.85,
    minWidth = 400,
    minHeight = 300,
    onClose,
  } = options;

  const popupWidthPx = ref(window.innerWidth * initialWidthRatio);
  const popupHeightPx = ref(window.innerHeight * initialHeightRatio);
  const isResizing = ref(false);
  const justFinishedResizing = ref(false);
  let resizeCooldownTimer: number | null = null;
  const isBackdropMouseDown = ref(false);
  const startX = ref(0);
  const startY = ref(0);
  const startWidthPx = ref(0);
  const startHeightPx = ref(0);

  const getPopupStyle = (isMobile: boolean = false) => {
    if (isMobile) {
      return {
        width: '100vw',
        height: '100vh',
        maxWidth: '100%',
        maxHeight: '100%',
        borderRadius: '0',
        transform: 'none',
        top: '0',
        left: '0',
      };
    }
    return {
      width: `${popupWidthPx.value}px`,
      height: `${popupHeightPx.value}px`,
      maxWidth: '95vw',
      maxHeight: '95vh',
    };
  };

  const handleResize = (event: MouseEvent) => {
    if (!isResizing.value) return;
    const diffX = event.clientX - startX.value;
    const diffY = event.clientY - startY.value;
    popupWidthPx.value = Math.max(minWidth, startWidthPx.value + diffX);
    popupHeightPx.value = Math.max(minHeight, startHeightPx.value + diffY);
  };

  const stopResize = () => {
    if (isResizing.value) {
      isResizing.value = false;
      isBackdropMouseDown.value = false;
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      justFinishedResizing.value = true;
      if (resizeCooldownTimer) clearTimeout(resizeCooldownTimer);
      resizeCooldownTimer = window.setTimeout(() => {
        justFinishedResizing.value = false;
        resizeCooldownTimer = null;
      }, 250);
    }
  };

  const startResize = (event: MouseEvent) => {
    isResizing.value = true;
    justFinishedResizing.value = false;
    isBackdropMouseDown.value = false;
    if (resizeCooldownTimer) {
      clearTimeout(resizeCooldownTimer);
      resizeCooldownTimer = null;
    }
    startX.value = event.clientX;
    startY.value = event.clientY;
    startWidthPx.value = popupWidthPx.value;
    startHeightPx.value = popupHeightPx.value;
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  };

  const handleBackdropMouseDown = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      isBackdropMouseDown.value = true;
    } else {
      isBackdropMouseDown.value = false;
    }
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) {
      isBackdropMouseDown.value = false;
      return;
    }
    if (!isBackdropMouseDown.value) {
      return;
    }
    if (isResizing.value || justFinishedResizing.value) {
      isBackdropMouseDown.value = false;
      return;
    }

    isBackdropMouseDown.value = false;
    if (onClose) {
      onClose();
    }
  };

  onBeforeUnmount(() => {
    stopResize();
    if (resizeCooldownTimer) {
      clearTimeout(resizeCooldownTimer);
      resizeCooldownTimer = null;
    }
  });

  return {
    popupWidthPx,
    popupHeightPx,
    isResizing,
    getPopupStyle,
    startResize,
    stopResize,
    handleBackdropMouseDown,
    handleBackdropClick,
  };
}
