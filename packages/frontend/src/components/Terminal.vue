<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick, watchEffect } from 'vue';
import { Terminal, ITerminalAddon, IDisposable } from 'xterm';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useAppearanceStore } from '../stores/appearance.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSessionStore } from '../stores/session.store'; 
import { storeToRefs } from 'pinia';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import 'xterm/css/xterm.css';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // +++ Import subscriber and off


// 定义 props 和 emits
const props = defineProps<{
  sessionId: string; // 会话 ID
  isActive: boolean; // 标记此终端是否为活动标签页
  stream?: ReadableStream<string>; // 用于接收来自 WebSocket 的数据流 (可选)
  options?: object; // xterm 的配置选项
}>();



const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++
const subscribeToWorkspaceEvent = useWorkspaceEventSubscriber(); // +++ 获取事件订阅器 +++
const unsubscribeFromWorkspaceEvent = useWorkspaceEventOff(); // +++ 获取事件取消订阅器 +++

const terminalRef = ref<HTMLElement | null>(null); // xterm 挂载点的引用 (内部容器)
const terminalOuterWrapperRef = ref<HTMLElement | null>(null); // 最外层容器的引用，用于背景图
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null; // *** 添加 searchAddon 变量 ***
let resizeObserver: ResizeObserver | null = null;
let observedElement: HTMLElement | null = null; // +++ Store the observed element +++
let debounceTimer: number | null = null; // 用于防抖的计时器 ID
let selectionListenerDisposable: IDisposable | null = null; // +++ 提升声明并添加类型 +++
let lastResizeObserverWidth = 0;
let lastResizeObserverHeight = 0;
const RESIZE_THRESHOLD = 0.5; // px


const { isMobile } = useDeviceDetection(); // 设备检测

let initialPinchDistance = 0;
let currentFontSizeOnPinchStart = 0;

// --- Appearance Store ---
const appearanceStore = useAppearanceStore();
const {
  effectiveTerminalTheme,
  currentTerminalFontFamily,
  currentTerminalFontSize,
  // --- 文字描边和阴影状态 ---
  terminalTextStrokeEnabled,
  terminalTextStrokeWidth,
  terminalTextStrokeColor,
  terminalTextShadowEnabled,
  terminalTextShadowOffsetX,
  terminalTextShadowOffsetY,
  terminalTextShadowBlur,
  terminalTextShadowColor,
  initialAppearanceDataLoaded, 
} = storeToRefs(appearanceStore);
 
const isTerminalDomReady = ref(false); 
 
// --- Settings Store ---
const settingsStore = useSettingsStore(); // +++ 实例化设置 store +++
const sessionStore = useSessionStore(); // +++ 实例化会话 store +++
const {
  autoCopyOnSelectBoolean,
  terminalScrollbackLimitNumber, 
  terminalEnableRightClickPasteBoolean, 
} = storeToRefs(settingsStore); 

// 防抖函数
const debounce = (func: Function, delay: number) => {
  let timeoutId: number | null = null; // Use a local variable for the timeout ID
  return (...args: any[]) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delay);
  };
};

// 防抖处理由 ResizeObserver 触发的 resize 事件
const debouncedEmitResize = debounce((term: Terminal) => {
    if (term && props.isActive) { // 仅当标签仍处于活动状态时才发送防抖后的 resize
        const dimensions = { cols: term.cols, rows: term.rows };
        console.log(`[Terminal ${props.sessionId}] Debounced resize emit (from ResizeObserver):`, dimensions);
        emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: dimensions });
        // *** 尝试在发送 resize 后强制刷新终端显示 ***
        try {
            term.refresh(0, term.rows - 1); // Refresh entire viewport
        } catch (e) {
            console.warn(`[Terminal ${props.sessionId}] Terminal refresh failed:`, e);
        }
    }
}, 150); // 150ms 防抖延迟

// 立即执行 Fit 并发送 Resize 的函数
const fitAndEmitResizeNow = (term: Terminal) => {
    // terminalRef 现在指向内部容器，检查它即可
    if (!term || !terminalRef.value) return;
    try {
        // 确保容器可见且有尺寸
        if (terminalRef.value.offsetHeight > 0 && terminalRef.value.offsetWidth > 0) {
            fitAddon?.fit();
            const dimensions = { cols: term.cols, rows: term.rows };
            emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: dimensions });
            // 发出稳定尺寸事件
            if (terminalRef.value) {
              const stableWidth = terminalRef.value.offsetWidth;
              const stableHeight = terminalRef.value.offsetHeight;
              emitWorkspaceEvent('terminal:stabilizedResize', { sessionId: props.sessionId, width: stableWidth, height: stableHeight });
            }
        } else {
             console.log(`[Terminal ${props.sessionId}] Immediate fit skipped (container not visible or has no dimensions).`);
        }
    } catch (e) {
        console.warn("Immediate fit/resize failed:", e);
    }
};

// 创建防抖版的字体大小保存函数 (区分设备)
const debouncedSaveFontSize = debounce(async (size: number) => {
    try {
        if (isMobile.value) {
            await appearanceStore.setTerminalFontSizeMobile(size);
            console.log(`[Terminal ${props.sessionId}] Debounced MOBILE font size saved: ${size}`);
        } else {
            await appearanceStore.setTerminalFontSize(size);
            console.log(`[Terminal ${props.sessionId}] Debounced DESKTOP font size saved: ${size}`);
        }
    } catch (error) {
        console.error(`[Terminal ${props.sessionId}] Debounced font size save failed:`, error);
        // Optionally show an error to the user
    }
}, 500); // 500ms 防抖延迟，可以调整

//  Helper function to convert setting value to xterm scrollback value
const getScrollbackValue = (limit: number): number => {
  if (limit === 0) {
    return Infinity; // 0 means unlimited for xterm
  }
  return Math.max(0, limit); // Ensure non-negative, return the number otherwise
};

// --- 右键粘贴功能 ---
const handleContextMenuPaste = async (event: MouseEvent) => {
  event.preventDefault(); // 阻止默认右键菜单
  try {
    const text = await navigator.clipboard.readText();
    if (text && terminal) {
      const processedText = text.replace(/\r\n?/g, '\n');
      emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data: processedText });
    }
  } catch (err) {
    console.error('[Terminal] Failed to paste via Right Click:', err);
  }
};

const addContextMenuListener = () => {
  if (terminalRef.value) {
    terminalRef.value.addEventListener('contextmenu', handleContextMenuPaste);
  }
};

const removeContextMenuListener = () => {
  if (terminalRef.value) {
    terminalRef.value.removeEventListener('contextmenu', handleContextMenuPaste);
  }
};


// --- 移动端模式下通过双指放大缩小终端字号 ---
const getDistanceBetweenTouches = (touches: TouchList): number => {
  const touch1 = touches[0];
  const touch2 = touches[1];
  return Math.sqrt(
    Math.pow(touch2.clientX - touch1.clientX, 2) +
    Math.pow(touch2.clientY - touch1.clientY, 2)
  );
};

const handleTouchStart = (event: TouchEvent) => {
  if (event.touches.length === 2 && terminal) {
    event.preventDefault(); 
    initialPinchDistance = getDistanceBetweenTouches(event.touches);
    currentFontSizeOnPinchStart = terminal.options.fontSize || currentTerminalFontSize.value;
  }
};

const handleTouchMove = (event: TouchEvent) => {
  if (event.touches.length === 2 && terminal && initialPinchDistance > 0) {
    event.preventDefault();
    const currentDistance = getDistanceBetweenTouches(event.touches);
    if (currentDistance > 0) {
      const scale = currentDistance / initialPinchDistance;
      let newSize = Math.round(currentFontSizeOnPinchStart * scale);
      newSize = Math.max(8, Math.min(newSize, 72)); 

      const currentTerminalOptFontSize = terminal.options.fontSize ?? currentTerminalFontSize.value;
      if (newSize !== currentTerminalOptFontSize) {
        terminal.options.fontSize = newSize;
        fitAndEmitResizeNow(terminal);
        debouncedSaveFontSize(newSize); // 使用新的区分设备的保存函数
      }
    }
  }
};

const handleTouchEnd = (event: TouchEvent) => {
  if (event.touches.length < 2) {
    initialPinchDistance = 0; // Reset pinch distance
  }
};

// 初始化终端
onMounted(() => {
  // xterm 挂载到 terminalRef (内部容器)
  if (terminalRef.value) {
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: currentTerminalFontSize.value, 
      fontFamily: currentTerminalFontFamily.value, // 使用 store 中的字体设置
      theme: effectiveTerminalTheme.value, // 使用 store 中的当前 xterm 主题 (now effectiveTerminalTheme)
      rows: 24, // 初始行数
      cols: 80, // 初始列数
      allowTransparency: true,
      allowProposedApi: true, // 必须开启以支持 Unicode 11 和高级扩展
      disableStdin: false,
      convertEol: false, // 禁用 convertEol，保持规范的 VT100/ANSI 光标控制，防止 TUI (如 agy cli) 渲染错位
      rescaleOverlappingGlyphs: true, // 允许特殊字符与宽字符自动缩放，防止字形溢出
      letterSpacing: 0,
      lineHeight: 1.1,
      scrollback: getScrollbackValue(terminalScrollbackLimitNumber.value), //  Use setting from store
      scrollOnUserInput: true, // 输入时滚动到底部
      ...props.options, // 合并外部传入的选项
    } as any);
    
    // 注意: 终端数据的解码已在useSshTerminal.ts中进行处理

    // 加载插件
    fitAddon = new FitAddon();
    searchAddon = new SearchAddon(); // *** 创建 SearchAddon 实例 ***
    const unicode11Addon = new Unicode11Addon(); // 支持 Unicode 11 现代宽字符规范
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(searchAddon); // *** 加载 SearchAddon ***
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11'; // 激活 Unicode 11 版本支持

    // 将终端附加到 DOM
    terminal.open(terminalRef.value);
    // terminal.open() 同步执行完毕后，可以认为 Xterm 已尝试附加到 DOM
    isTerminalDomReady.value = true; // +++ 直接在此处设置 DOM 准备就绪状态 +++
    console.log(`[Terminal ${props.sessionId}] Xterm open() called, considering DOM ready for initial style checks.`);
 
    // 适应容器大小
    fitAddon.fit();
    emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: { cols: terminal.cols, rows: terminal.rows } }); // 触发初始 resize 事件

    // 监听用户输入
    terminal.onData((data) => {
      emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data });
    });

    // 监听终端大小变化 (通过 ResizeObserver) - 主要处理浏览器窗口大小变化等
    // ResizeObserver 观察内部容器 terminalRef
    if (terminalRef.value) {
        observedElement = terminalRef.value;
        resizeObserver = new ResizeObserver((entries) => {
            if (!props.isActive || !terminal || !terminalRef.value) return;

            const entry = entries[0];
            const { height: rectHeight, width: rectWidth } = entry.contentRect;
            const offsetW = terminalRef.value.offsetWidth;
            const offsetH = terminalRef.value.offsetHeight;

            // --- 阈值判断逻辑 ---
            const widthChangedSignificantly = Math.abs(rectWidth - lastResizeObserverWidth) >= RESIZE_THRESHOLD;
            const heightChangedSignificantly = Math.abs(rectHeight - lastResizeObserverHeight) >= RESIZE_THRESHOLD;

            if (!widthChangedSignificantly && !heightChangedSignificantly) {
              console.log(`[TerminalResizeObserver sessionId=${props.sessionId}] Size change below threshold (${RESIZE_THRESHOLD}px). rectWidth: ${rectWidth.toFixed(2)}, rectHeight: ${rectHeight.toFixed(2)}, lastWidth: ${lastResizeObserverWidth.toFixed(2)}, lastHeight: ${lastResizeObserverHeight.toFixed(2)}. Skipping fit.`);
              return;
            }
            
            console.log(`[TerminalResizeObserver sessionId=${props.sessionId}] Size change AT or ABOVE threshold (${RESIZE_THRESHOLD}px). rectWidth: ${rectWidth.toFixed(2)}, rectHeight: ${rectHeight.toFixed(2)}, lastWidth: ${lastResizeObserverWidth.toFixed(2)}, lastHeight: ${lastResizeObserverHeight.toFixed(2)}. Proceeding with fit.`);
            
            const roundedWidth = Math.round(rectWidth);
            const roundedHeight = Math.round(rectHeight);

            // 更新 lastResizeObserverWidth/Height 为取整后的值
            lastResizeObserverWidth = roundedWidth;
            lastResizeObserverHeight = roundedHeight;
            // --- 阈值判断逻辑结束 ---

            console.log(`[TerminalResizeObserver sessionId=${props.sessionId}] Triggered. Observed contentRect: ${rectWidth.toFixed(2)}w x ${rectHeight.toFixed(2)}h (rounded to ${roundedWidth}x${roundedHeight}). terminalRef offset: ${offsetW}w x ${offsetH}h.`);
            if (entry.target && terminalRef.value) {
              const targetBoundingClientRect = entry.target.getBoundingClientRect();
              const terminalRefBoundingClientRect = terminalRef.value.getBoundingClientRect();
              console.log(`[TerminalResizeObserver sessionId=${props.sessionId}] target.getBoundingClientRect(): ${targetBoundingClientRect.width.toFixed(2)}w x ${targetBoundingClientRect.height.toFixed(2)}h, top: ${targetBoundingClientRect.top.toFixed(2)}, left: ${targetBoundingClientRect.left.toFixed(2)}`);
              console.log(`[TerminalResizeObserver sessionId=${props.sessionId}] terminalRef.getBoundingClientRect(): ${terminalRefBoundingClientRect.width.toFixed(2)}w x ${terminalRefBoundingClientRect.height.toFixed(2)}h, top: ${terminalRefBoundingClientRect.top.toFixed(2)}, left: ${terminalRefBoundingClientRect.left.toFixed(2)}`);
            }

            if (rectHeight > 0 && rectWidth > 0) {
                try {
                  fitAddon?.fit();
                  debouncedEmitResize(terminal); // This will log the cols/rows after debouncing
                  emitWorkspaceEvent('terminal:stabilizedResize', { sessionId: props.sessionId, width: roundedWidth, height: roundedHeight });
                 } catch (e) {
                    console.warn(`[TerminalResizeObserver sessionId=${props.sessionId}] Fit addon or debouncedEmitResize failed:`, e);
                 }
            }
        });
        // Observe only if initially active (or becomes active later)
        if (props.isActive) {
            resizeObserver.observe(observedElement);
            console.log(`[Terminal ${props.sessionId}] Initial observe.`);
        }
    }


    // 监听 isActive prop 的变化
    watch(() => props.isActive, (newValue, oldValue) => {
        console.log(`[Terminal ${props.sessionId}] isActive changed from ${oldValue} to ${newValue}`);
        if (resizeObserver && observedElement) {
            if (newValue) {
                // --- Become Active ---
                console.log(`[Terminal ${props.sessionId}] Becoming active. Observing element and fitting.`);
                // Start observing
                try {
                    resizeObserver.observe(observedElement);
                } catch (e) {
                     console.warn(`[Terminal ${props.sessionId}] Error observing element:`, e);
                }
                // 在 DOM 更新后立即执行 fit 并聚焦，消除 50ms 延迟
                nextTick(() => {
                    if (props.isActive && terminal && terminalRef.value && terminalRef.value.offsetHeight > 0) {
                        fitAndEmitResizeNow(terminal);
                        terminal.focus();
                    }
                });
            } else {
                // --- Become Inactive ---
                console.log(`[Terminal ${props.sessionId}] Becoming inactive. Unobserving element.`);
                // Stop observing
                try {
                    resizeObserver.unobserve(observedElement);
                } catch (e) {
                     console.warn(`[Terminal ${props.sessionId}] Error unobserving element:`, e);
                }
 
            }
        } else {
            console.warn(`[Terminal ${props.sessionId}] Cannot handle isActive change: resizeObserver or observedElement missing.`);
        }
    });



    // 处理传入的数据流 (如果提供了 stream prop)
    watch(() => props.stream, async (newStream) => {
      if (newStream) {
        const reader = newStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (terminal && value) {
              terminal.write(value); // 将流数据写入终端
              // 移除此处不必要的 fit() 调用
            }
          }
        } catch (error) {
          console.error('读取终端流时出错:', error);
        } finally {
          reader.releaseLock();
        }
      }
    }, { immediate: true }); // 立即执行一次 watch

    // 触发 ready 事件，传递 sessionId, terminal 和 searchAddon 实例
    if (terminal) {
        emitWorkspaceEvent('terminal:ready', { sessionId: props.sessionId, terminal: terminal, searchAddon: searchAddon });
    }

    // --- 监听并处理选中即复制 ---
    let currentSelection = ''; // 存储当前选区内容，避免重复复制空内容
    const handleSelectionChange = () => {
        if (terminal && autoCopyOnSelectBoolean.value) {
            const newSelection = terminal.getSelection();
            // 仅在选区内容发生变化且不为空时执行复制
            if (newSelection && newSelection !== currentSelection) {
                currentSelection = newSelection;
                navigator.clipboard.writeText(newSelection).then(() => {
                }).catch(err => {
                    console.error('[Terminal] 自动复制到剪贴板失败:', err);
                    // 可以在这里向用户显示一个短暂的错误提示
                });
            } else if (!newSelection) {
                // 如果新选区为空，重置 currentSelection
                currentSelection = '';
            }
        } else {
            // 如果设置关闭，也重置 currentSelection
            currentSelection = '';
        }
    };

    // 添加防抖以避免过于频繁地触发 handleSelectionChange
    const debouncedSelectionChange = debounce(handleSelectionChange, 50); // 50ms 防抖

    // 监听 xterm 的 selectionChange 事件
    selectionListenerDisposable = terminal.onSelectionChange(debouncedSelectionChange); // Assign to outer variable

    // 监听设置变化，如果关闭了自动复制，确保清除可能存在的旧选区状态
    watch(autoCopyOnSelectBoolean, (newValue) => {
        if (!newValue) {
            currentSelection = '';
        }
    });

    // --- 监听外观变化 ---
    watch(effectiveTerminalTheme, (newTheme) => { // Changed from currentTerminalTheme
      if (terminal) {
        console.log(`[Terminal ${props.sessionId}] 应用新终端主题 (effective)。`);
        // 直接修改 options 对象
        terminal.options.theme = newTheme;
        // 修改选项后需要刷新终端才能生效
        try {
            // 刷新整个视口
            terminal.refresh(0, terminal.rows - 1);
            console.log(`[Terminal ${props.sessionId}] 终端已刷新以应用新主题。`);
        } catch (e) {
            console.warn(`[Terminal ${props.sessionId}] 刷新终端以应用主题时出错:`, e);
        }
      }
    }, { deep: true });

    watch(currentTerminalFontFamily, (newFontFamily) => {
        if (terminal) {
            console.log(`[Terminal ${props.sessionId}] 应用新终端字体: ${newFontFamily}`);
            terminal.options.fontFamily = newFontFamily;
            // 字体变化可能影响尺寸，重新 fit
            fitAndEmitResizeNow(terminal);
        }
    });

    // 监听字体大小变化
    watch(currentTerminalFontSize, (newSize) => {
        if (terminal) {
            console.log(`[Terminal ${props.sessionId}] 应用新终端字体大小: ${newSize}`);
            terminal.options.fontSize = newSize;
            // 字体大小变化需要重新 fit
            fitAndEmitResizeNow(terminal);
        }
    });

    // 聚焦终端 (添加 null check)
    if (terminal) {
        terminal.focus();
    }

    // --- 添加 Ctrl+Shift+C/V 复制粘贴 ---
    if (terminal && terminal.textarea) { // 确保 terminal 和 textarea 存在
        terminal.textarea.addEventListener('keydown', async (event: KeyboardEvent) => {
            // Ctrl+Shift+C for Copy
            if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
                event.preventDefault(); // 阻止默认行为 (例如浏览器开发者工具)
                event.stopPropagation(); // 阻止事件冒泡
                const selection = terminal?.getSelection();
                if (selection) {
                    try {
                        await navigator.clipboard.writeText(selection);
                        console.log('[Terminal] Copied via Ctrl+Shift+C:', selection);
                    } catch (err) {
                        console.error('[Terminal] Failed to copy via Ctrl+Shift+C:', err);
                        // 可以考虑添加 UI 提示
                    }
                }
            }
            // Ctrl+Shift+V for Paste
            else if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
                event.preventDefault();
                event.stopPropagation();
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        const processedText = text.replace(/\r\n?/g, '\n');
                        emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data: processedText });
                    }
                } catch (err) {
                    console.error('[Terminal] Failed to paste via Ctrl+Shift+V:', err);
                    // 检查权限问题，例如 navigator.clipboard.readText 需要用户授权或安全上下文
                    // 可以考虑添加 UI 提示
                }
            }
        });
    }

    // 根据初始设置添加监听器
    if (terminalEnableRightClickPasteBoolean.value) {
      addContextMenuListener();
    }

    // 监听设置变化
    watch(terminalEnableRightClickPasteBoolean, (newValue) => {
      if (newValue) {
        addContextMenuListener();
      } else {
        removeContextMenuListener();
      }
    });


    // 重新添加鼠标滚轮缩放功能到内部容器 terminalRef
    if (terminalRef.value) {
      terminalRef.value.addEventListener('wheel', (event: WheelEvent) => {
        if (event.ctrlKey) {
          event.preventDefault(); // 阻止默认的滚动行为

          if (terminal) {
            let newSize;
            const currentSize = terminal.options.fontSize ?? currentTerminalFontSize.value;
            if (event.deltaY < 0) {
              // 向上滚动，增大字体
              newSize = Math.min(currentSize + 1, 40);
            } else {
              // 向下滚动，减小字体
              newSize = Math.max(currentSize - 1, 8);
            }

            if (newSize !== currentSize) { // 仅在字体大小实际改变时执行
                console.log(`[Terminal ${props.sessionId}] Font size changed via wheel: ${newSize}`);
                terminal.options.fontSize = newSize; // 先更新选项
                fitAndEmitResizeNow(terminal); // 调用统一函数

                // 调用防抖函数来保存设置
                debouncedSaveFontSize(newSize); // 使用新的区分设备的保存函数
            }
          }
        }
      });
    }

    // Add touch listeners for pinch zoom on mobile
    if (isMobile.value && terminalRef.value && terminal) {
      console.log(`[Terminal ${props.sessionId}] Adding touch listeners for mobile pinch zoom.`);
      terminalRef.value.addEventListener('touchstart', handleTouchStart, { passive: false });
      terminalRef.value.addEventListener('touchmove', handleTouchMove, { passive: false });
      terminalRef.value.addEventListener('touchend', handleTouchEnd, { passive: false });
      terminalRef.value.addEventListener('touchcancel', handleTouchEnd, { passive: false }); // Also handle cancel
    }


  }
});

// 组件卸载前清理资源
onBeforeUnmount(() => {
  // Ensure observer is cleaned up
  if (resizeObserver && observedElement) {
      try {
          resizeObserver.unobserve(observedElement);
          console.log(`[Terminal ${props.sessionId}] Unobserved on unmount.`);
      } catch (e) {
          console.warn(`[Terminal ${props.sessionId}] Error unobserving on unmount:`, e);
      }
      resizeObserver.disconnect(); // Fully disconnect observer
      console.log(`[Terminal ${props.sessionId}] ResizeObserver disconnected.`);
  }
  resizeObserver = null;
  observedElement = null;

  if (terminal) {
    console.log(`[Terminal ${props.sessionId}] Disposing terminal instance.`);
    terminal.dispose();
    terminal = null;
  }

  // 在卸载前清理选择监听器
  if (selectionListenerDisposable) {
      selectionListenerDisposable.dispose();
  }

  
    // 确保在卸载时移除右键监听器
    removeContextMenuListener();

    // Remove touch listeners on unmount
    if (isMobile.value && terminalRef.value) {
        console.log(`[Terminal ${props.sessionId}] Removing touch listeners.`);
        terminalRef.value.removeEventListener('touchstart', handleTouchStart);
        terminalRef.value.removeEventListener('touchmove', handleTouchMove);
        terminalRef.value.removeEventListener('touchend', handleTouchEnd);
        terminalRef.value.removeEventListener('touchcancel', handleTouchEnd);
    }



  });
// 暴露 write 方法给父组件 (可选)
const write = (data: string | Uint8Array) => {
    terminal?.write(data);
};

// *** 暴露搜索方法 ***
const findNext = (term: string, options?: ISearchOptions): boolean => {
  if (searchAddon) {
    return searchAddon.findNext(term, options);
  }
  return false;
};

const findPrevious = (term: string, options?: ISearchOptions): boolean => {
  if (searchAddon) {
    return searchAddon.findPrevious(term, options);
  }
  return false;
};

const clearSearch = () => {
  searchAddon?.clearDecorations();
};

// +++  clear 方法 +++
const clear = () => {
  terminal?.clear();
};

defineExpose({ write, findNext, findPrevious, clearSearch, clear }); // 暴露 clear 方法


// --- 文字描边和阴影 ---
const applyTerminalTextStyles = () => {
  if (terminalRef.value && terminal?.element) {
    const hostElement = terminalRef.value; // .terminal-inner-container

    // 清理类名
    hostElement.classList.remove('has-text-stroke', 'has-text-shadow');

    // 文字描边
    if (terminalTextStrokeEnabled.value) {
      hostElement.classList.add('has-text-stroke');
      hostElement.style.setProperty('--terminal-stroke-width', `${terminalTextStrokeWidth.value}px`);
      hostElement.style.setProperty('--terminal-stroke-color', terminalTextStrokeColor.value);
    } else {
      hostElement.style.removeProperty('--terminal-stroke-width');
      hostElement.style.removeProperty('--terminal-stroke-color');
    }

    // 文字阴影
    if (terminalTextShadowEnabled.value) {
      hostElement.classList.add('has-text-shadow');
      const shadowValue = `${terminalTextShadowOffsetX.value}px ${terminalTextShadowOffsetY.value}px ${terminalTextShadowBlur.value}px ${terminalTextShadowColor.value}`;
      hostElement.style.setProperty('--terminal-shadow', shadowValue);
    } else {
      hostElement.style.removeProperty('--terminal-shadow');
    }
    // console.log('[Terminal] Applied text styles. Stroke enabled:', terminalTextStrokeEnabled.value, 'Shadow enabled:', terminalTextShadowEnabled.value);
  }
};

// 监听文字描边和阴影设置的变化
watch(
  [
    terminalTextStrokeEnabled,
    terminalTextStrokeWidth,
    terminalTextStrokeColor,
    terminalTextShadowEnabled,
    terminalTextShadowOffsetX,
    terminalTextShadowOffsetY,
    terminalTextShadowBlur,
    terminalTextShadowColor,
  ],
  () => {
    // console.log('[Terminal] Text style settings changed, applying new styles.');
    // 这个 watch 现在主要负责响应运行时的更改
    // 初始加载由下面的 watchEffect 处理
    if (isTerminalDomReady.value && initialAppearanceDataLoaded.value) {
      nextTick(() => {
        applyTerminalTextStyles();
      });
    }
  },
  { deep: true }
);
 
// watchEffect 用于处理初始样式应用 +++
watchEffect(() => {
  if (isTerminalDomReady.value && initialAppearanceDataLoaded.value && terminalRef.value && terminal?.element) {
    console.log(`[Terminal ${props.sessionId}] Initial style application: DOM ready and appearance data loaded. Applying text styles.`);
    nextTick(() => {
      applyTerminalTextStyles();
    });
  }
});
 
</script>

<template>
  <div ref="terminalOuterWrapperRef" class="terminal-outer-wrapper">
    <!-- xterm 实际挂载点 -->
    <div ref="terminalRef" class="terminal-inner-container"></div>
  </div>
</template>

<style scoped>
.terminal-outer-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.terminal-inner-container {
  width: 100%;
  height: 100%;
  /* position: relative;  移除了 position relative */
  /* z-index 调整或移除，因为背景层不再在此组件内 */
}

/* 文字描边和阴影样式 */
.terminal-inner-container.has-text-stroke :deep(.xterm-rows span),
.terminal-inner-container.has-text-stroke :deep(.xterm-rows div > span), /* 更具体地针对嵌套 span */
.terminal-inner-container.has-text-stroke :deep(.xterm-rows div) { /* 针对直接包含文本的 div */
  -webkit-text-stroke-width: var(--terminal-stroke-width);
  -webkit-text-stroke-color: var(--terminal-stroke-color);
  text-stroke-width: var(--terminal-stroke-width);
  text-stroke-color: var(--terminal-stroke-color);
  /* 确保描边在填充之下，这样填充色仍然可见 */
  paint-order: stroke fill;
  -webkit-paint-order: stroke fill; /* 兼容 WebKit */
}

.terminal-inner-container.has-text-shadow :deep(.xterm-rows span),
.terminal-inner-container.has-text-shadow :deep(.xterm-rows div > span),
.terminal-inner-container.has-text-shadow :deep(.xterm-rows div) {
  text-shadow: var(--terminal-shadow);
}

/*
  移除以下样式，因为它依赖于本组件内部管理的 .has-terminal-background 类，
  该逻辑已移至 LayoutRenderer.vue
*/
</style>

