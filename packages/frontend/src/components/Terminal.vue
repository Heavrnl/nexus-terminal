<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { Terminal, ITerminalAddon, IDisposable } from 'xterm';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useAppearanceStore } from '../stores/appearance.store';
import { useSettingsStore } from '../stores/settings.store';
import { storeToRefs } from 'pinia';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import 'xterm/css/xterm.css';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents'; 


// 定义 props 和 emits
const props = defineProps<{
  sessionId: string; // 会话 ID
  isActive: boolean; // 标记此终端是否为活动标签页
  stream?: ReadableStream<string>; // 用于接收来自 WebSocket 的数据流 (可选)
  options?: object; // xterm 的配置选项
}>();



const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++

const terminalRef = ref<HTMLElement | null>(null); // xterm 挂载点的引用 (内部容器)
const terminalOuterWrapperRef = ref<HTMLElement | null>(null); // 最外层容器的引用，用于背景图
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null; // *** 添加 searchAddon 变量 ***
let resizeObserver: ResizeObserver | null = null;
let observedElement: HTMLElement | null = null; // +++ Store the observed element +++
let debounceTimer: number | null = null; // 用于防抖的计时器 ID
let selectionListenerDisposable: IDisposable | null = null; // +++ 提升声明并添加类型 +++
// const fontSize = ref(14); // 移除本地字体大小状态，将由 store 管理


const { isMobile } = useDeviceDetection(); // 设备检测

let initialPinchDistance = 0;
let currentFontSizeOnPinchStart = 0;

// --- Appearance Store ---
const appearanceStore = useAppearanceStore();
const {
  effectiveTerminalTheme,
  currentTerminalFontFamily,
  terminalBackgroundImage,
  currentTerminalFontSize,
  isTerminalBackgroundEnabled,
  currentTerminalBackgroundOverlayOpacity, // 获取蒙版透明度
} = storeToRefs(appearanceStore);
 
// --- Settings Store ---
const settingsStore = useSettingsStore(); // +++ 实例化设置 store +++
const {
  autoCopyOnSelectBoolean,
  terminalScrollbackLimitNumber, //  Import scrollback limit getter
  terminalEnableRightClickPasteBoolean, //  Import right-click paste setting getter
} = storeToRefs(settingsStore); // +++ 获取设置状态 +++

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
            console.log(`[Terminal ${props.sessionId}] Terminal refreshed after debounced resize.`);
        } catch (e) {
            console.warn(`[Terminal ${props.sessionId}] Terminal refresh failed:`, e);
        }
    } else {
        console.log(`[Terminal ${props.sessionId}] Debounced resize skipped (inactive).`);
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
            console.log(`[Terminal ${props.sessionId}] Immediate resize emit:`, dimensions);
            emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: dimensions });

            // *** 恢复：仅使用 nextTick 触发 window resize ***
            // 使用 nextTick 确保 fit() 的效果已反映，再触发 resize
            nextTick(() => {
                // 再次检查终端实例是否仍然存在
                // terminalRef 现在指向内部容器
                if (terminal && terminalRef.value) {
                    console.log(`[Terminal ${props.sessionId}] Triggering window resize event after immediate fit.`);
                    window.dispatchEvent(new Event('resize'));
                }
            });
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
      // 将粘贴的文本发送到后端
      emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data: text });
      console.log('[Terminal] Pasted via Right Click');
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
      disableStdin: false,
      convertEol: true,
      scrollback: getScrollbackValue(terminalScrollbackLimitNumber.value), //  Use setting from store
      scrollOnUserInput: true, // 输入时滚动到底部
      ...props.options, // 合并外部传入的选项
    });
    
    // 注意: 终端数据的解码已在useSshTerminal.ts中进行处理

    // 加载插件
    fitAddon = new FitAddon();
    searchAddon = new SearchAddon(); // *** 创建 SearchAddon 实例 ***
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(searchAddon); // *** 加载 SearchAddon ***

    // 将终端附加到 DOM
    terminal.open(terminalRef.value);

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
            // Only process if the terminal is active
            if (!props.isActive || !terminal) return;

            const entry = entries[0];
            const { height, width } = entry.contentRect; // 获取宽度和高度
            // console.log(`[Terminal ${props.sessionId}] ResizeObserver triggered. Size: ${width}x${height}, isActive: ${props.isActive}`);
            if (height > 0 && width > 0) { // 确保宽度和高度都有效
                try {
                  // *** 恢复：立即调用 fit() 来适应前端容器 ***
                  fitAddon?.fit();
                  // 触发防抖的 resize 发送，通知后端潜在的尺寸变化
                  debouncedEmitResize(terminal);
                 } catch (e) {
                    console.warn("Fit addon resize failed (observer):", e);
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
                // Perform fit after a delay to ensure visibility and layout stability
                nextTick(() => {
                    setTimeout(() => {
                        // Re-check if still active and terminal exists
                        // 检查内部容器 terminalRef
                        if (props.isActive && terminal && terminalRef.value && terminalRef.value.offsetHeight > 0) {
                            fitAndEmitResizeNow(terminal);
                            // Also ensure focus when becoming active
                            terminal.focus();
                        } else {
                            console.log(`[Terminal ${props.sessionId}] Skipped delayed fit (inactive, destroyed, or not visible).`);
                        }
                    }, 50); // 50ms delay
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
                // Optionally clear debounce timer if resize was pending for this inactive terminal
                // (debouncedEmitResize already checks isActive, so maybe not strictly needed)
                // if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            }
        } else {
            console.warn(`[Terminal ${props.sessionId}] Cannot handle isActive change: resizeObserver or observedElement missing.`);
        }
    });

    // // 监听 fitAddon 的 resize 事件，获取新的尺寸并触发 emit
    // // 注意：fitAddon 本身不直接触发 resize 事件，我们需要在 fit() 后手动获取
    // const originalFit = fitAddon.fit.bind(fitAddon);
    // fitAddon.fit = () => {
    //     originalFit();
    //     if (terminal) {
    //         emit('resize', { cols: terminal.cols, rows: terminal.rows });
    //     }
    // };


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
                    // console.log('[Terminal] 文本已自动复制到剪贴板:', newSelection); // 可选：成功日志
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

    // 监听背景图片和启用状态的变化
    watch([terminalBackgroundImage, isTerminalBackgroundEnabled], () => {
        console.log(`[Terminal Watcher] Background image or enabled status changed. Image: ${terminalBackgroundImage.value}, Enabled: ${isTerminalBackgroundEnabled.value}`);
        applyTerminalBackground();
    }, { immediate: true }); // 强制立即执行一次
    // 移除 onMounted 中的 applyTerminalBackground 调用，完全依赖 watch
    // applyTerminalBackground(); // 初始应用一次

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
                        // 将粘贴的文本发送到后端，模拟用户输入
                        emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data: text });
                        console.log('[Terminal] Pasted via Ctrl+Shift+V');
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
    //     // 只在按下Ctrl键时才触发缩放
    //     if (event.ctrlKey) {
    //       event.preventDefault(); // 阻止默认的滚动行为
          
    //       // 根据滚轮方向调整字体大小
    //       if (event.deltaY < 0) {
    //         // 向上滚动，增大字体
    //         fontSize.value = Math.min(fontSize.value + 1, 40); // 设置最大字体大小为40
    //       } else {
    //         // 向下滚动，减小字体
    //         fontSize.value = Math.max(fontSize.value - 1, 8); // 设置最小字体大小为8
    //       }
          
    //       // 更新终端字体大小
    //       if (terminal) {
    //         terminal.options.fontSize = fontSize.value;
    //         // 调整终端大小以适应新的字体大小
    //         fitAddon?.fit();
    //         emit('resize', { cols: terminal.cols, rows: terminal.rows });
    //       }
        // 只在按下Ctrl键时才触发缩放
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
                // 立即更新视觉效果 - fitAndEmitResizeNow 会处理
                // terminal.options.fontSize = newSize; // fitAndEmitResizeNow 内部会设置
                // fitAddon?.fit(); // fitAndEmitResizeNow 会处理

                // *** 修改：调用 fitAndEmitResizeNow 来处理 fit 和事件触发 ***
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
  
    // terminalRef 是内部容器，不需要特别处理
    // if (terminalRef.value) {
    // }
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
 
 
// --- 应用终端背景 ---
const applyTerminalBackground = () => {
    // 背景应用到 terminalOuterWrapperRef
    if (terminalOuterWrapperRef.value) {
        if (!isTerminalBackgroundEnabled.value) {
            nextTick(() => {
                 if (terminalOuterWrapperRef.value) {
                    terminalOuterWrapperRef.value.style.backgroundImage = 'none';
                    terminalOuterWrapperRef.value.classList.remove('has-terminal-background');
                 }
            });
            console.log(`[Terminal ${props.sessionId}] 终端背景已禁用，移除背景。`);
            return;
        }
 
        if (terminalBackgroundImage.value) {
            const backendUrl = import.meta.env.VITE_API_BASE_URL || '';
            const imagePath = terminalBackgroundImage.value;
            const fullImageUrl = `${backendUrl}${imagePath}`;
            nextTick(() => {
                if (terminalOuterWrapperRef.value) {
                    terminalOuterWrapperRef.value.style.backgroundImage = `url(${fullImageUrl})`;
                    terminalOuterWrapperRef.value.style.backgroundSize = 'cover';
                    terminalOuterWrapperRef.value.style.backgroundPosition = 'center';
                    terminalOuterWrapperRef.value.style.backgroundRepeat = 'no-repeat';
                    terminalOuterWrapperRef.value.classList.add('has-terminal-background');
                }
            });
            console.log(`[Terminal ${props.sessionId}] 应用终端背景图片: ${terminalBackgroundImage.value}`);
        } else {
            nextTick(() => {
                 if (terminalOuterWrapperRef.value) {
                    terminalOuterWrapperRef.value.style.backgroundImage = 'none';
                    terminalOuterWrapperRef.value.classList.remove('has-terminal-background');
                 }
            });
             console.log(`[Terminal ${props.sessionId}] 移除终端背景图片。`);
        }
    }
};

</script>

<template>
  <div ref="terminalOuterWrapperRef" class="terminal-outer-wrapper">
    <!-- 蒙版层 -->
    <div
      v-if="isTerminalBackgroundEnabled && terminalBackgroundImage"
      class="terminal-background-overlay"
      :style="{ backgroundColor: `rgba(0, 0, 0, ${currentTerminalBackgroundOverlayOpacity})` }"
    ></div>
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

.terminal-background-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none; /* 允许鼠标事件穿透 */
  z-index: 1; /* 在背景图之上 */
}

.terminal-inner-container {
  width: 100%;
  height: 100%;
  position: relative; /* 使 z-index 生效 */
  z-index: 2; /* 在蒙版之上 */
}

/* 当最外层容器有背景图时，强制内部 xterm 视口和屏幕背景透明 */
.terminal-outer-wrapper.has-terminal-background .terminal-inner-container :deep(.xterm-viewport),
.terminal-outer-wrapper.has-terminal-background .terminal-inner-container :deep(.xterm-screen) {
  background-color: transparent !important;
}
</style>

