<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, watchEffect } from 'vue';
import { Terminal, ITerminalAddon, IDisposable } from 'xterm';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useAppearanceStore } from '../stores/appearance.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSessionStore } from '../stores/session.store'; 
import { useConnectionsStore } from '../stores/connections.store';
import { storeToRefs } from 'pinia';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';
import 'xterm/css/xterm.css';
import TerminalScrollbar from './TerminalScrollbar.vue';
import TerminalContextMenu, { type TerminalMenuAction } from './TerminalContextMenu.vue';
import { useFileEditorStore, type FileInfo } from '../stores/fileEditor.store';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // +++ Import subscriber and off
import { useTerminalHighlightStore } from '../stores/terminal-highlight.store';
import { registerTerminal as registerDebugTerminal } from '../debug';
import { useTerminalContextMenu } from '../composables/terminal/useTerminalContextMenu';
import { useTerminalScrollbar } from '../composables/terminal/useTerminalScrollbar';
import { useTerminalPinchZoom } from '../composables/terminal/useTerminalPinchZoom';
import { buildSearchMarkers, DEFAULT_SEARCH_DECORATIONS } from '../utils/terminalSearch';
import { createReplaySilenceController } from '../utils/terminalReplaySilence';

const highlightStore = useTerminalHighlightStore();


// 定义 props 和 emits
const emit = defineEmits<{
  (e: 'focus'): void;
}>();

const props = defineProps<{
  sessionId: string; // 会话 ID
  isActive: boolean; // 标记此终端是否为活动标签页
  paneId?: string; // 终端所在布局面板的唯一 ID
  autoExecConfig?: {
    defaultCommand?: string;
    connectionCommands?: Record<string, string>;
  }; // 布局管理器中配置的连接就绪自动执行指令
  isPaneFocused?: boolean; // 标记此终端 Pane 是否处于聚焦激活态
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

// --- 终端搜索：命中计数 + 滚动条标记 ---
// 高亮由 addon 的 decoration 负责；这里只保存"扫描结果"和"当前第几个"，
// markers 用 computed 派生，翻页时不需要重新扫描 buffer。
const searchMatchIndex = ref(-1);
const searchMatchCount = ref(0);
const searchMatchLines = ref<number[]>([]);
const searchTotalLines = ref(1);
const searchMarkers = computed(() =>
  buildSearchMarkers(searchMatchLines.value, searchTotalLines.value, searchMatchIndex.value)
);

/** 会话管理器扫完 buffer 后广播命中行号（只认自己这个 pane，避免分屏串台） */
const handleSearchMarkers = (payload: {
  sessionId?: string;
  paneId?: string;
  matchLines: number[];
  totalLines: number;
  index?: number;
}) => {
  if (payload.sessionId && payload.sessionId !== props.sessionId) return;
  if (payload.paneId && props.paneId && payload.paneId !== props.paneId) return;
  searchMatchLines.value = payload.matchLines;
  searchTotalLines.value = payload.totalLines;
  if (typeof payload.index === 'number') {
    searchMatchIndex.value = payload.index;
    searchMatchCount.value = payload.matchLines.length;
  }
};
let serializeAddon: SerializeAddon | null = null; // 官方序列化插件，用于保存完整 ANSI 颜色与样式
let unregisterDebugTerminal: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedElement: HTMLElement | null = null; // +++ Store the observed element +++
let debounceTimer: number | null = null; // 用于防抖的计时器 ID
let selectionListenerDisposable: IDisposable | null = null; // +++ 提升声明并添加类型 +++
let lastResizeObserverWidth = 0;
let lastResizeObserverHeight = 0;
let resizeRafId: number | null = null;
/**
 * 内层容器（`proposeDimensions()` 的真正测量对象）的尺寸观察器。
 *
 * 会话沙箱是常驻 `v-show`：刷新恢复时非激活会话的终端在 `display:none` 的祖先里挂载，
 * 容器 0×0 → 终端退化成 xterm 默认 80×24。切回来时外层 wrapper 的盒子往往没变
 * （变的是内层被挤小再放开），外层 ResizeObserver 全程静默 → 终端定格在 80 列。
 * 直接盯内层，0 → N 的那次跃迁才能收到。
 */
let innerResizeObserver: ResizeObserver | null = null;
let lastInnerObserverWidth = 0;
let lastInnerObserverHeight = 0;
const RESIZE_THRESHOLD = 3.0; // px: 提升阈值至 3px，彻底过滤子像素抖动，消除Layout Thrashing振荡

// --- 尺寸未定时暂存写入（见 onMounted 里「把 write 包一层」的说明）---
/** 是否已经量到过一次真实尺寸（= 终端 cols/rows 可信，可以往里写内容了） */
let hasRealSize = false;
/** 尺寸可信之前收到的写入，按原顺序暂存（携带是否回放静默标记） */
let pendingWrites: Array<{ data: string | Uint8Array; silent: boolean }> = [];
let pendingWriteChars = 0;
/** 未经包装的原始 write，flush 时才用 */
let rawTerminalWrite: ((data: string | Uint8Array, cb?: () => void) => void) | null = null;
/** 历史回放静默屏障：拦截回放解析期间 xterm.js 自动发出的查询应答，放行真实用户输入 */
const replaySilence = createReplaySilenceController();
let userInputListenerDisposable: IDisposable | null = null;
/** 具名 DOM 监听器与宿主元素引用，卸载时统一 removeEventListener 防止闭包泄漏 */
let textareaKeydownEl: HTMLTextAreaElement | null = null;
let textareaKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
let containerWheelTouchEl: HTMLElement | null = null;
let containerWheelHandler: ((event: WheelEvent) => void) | null = null;
let hasBoundTouchListeners = false;
/** 暂存上限：隐藏会话一直不回前台时，超过这个量就认了，先写进去（不无限吃内存） */
const PENDING_WRITE_LIMIT = 8 * 1024 * 1024;


const { isMobile } = useDeviceDetection(); // 设备检测

// --- Appearance Store ---
const appearanceStore = useAppearanceStore();
const {
  effectiveTerminalTheme,
  isTerminalBackgroundEnabled,
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
const lastCwd = ref<string | null>(null);

watch(() => props.isPaneFocused, (focused) => {
  if (focused) {
    // 会话切换 / 新开终端后把键盘焦点交给 xterm，省掉"先点一下终端"这一步。
    // 但如果用户正在输入框里打字（命令输入栏等），不要抢走焦点。
    nextTick(() => {
      const ae = document.activeElement as HTMLElement | null;
      const userTypingElsewhere = !!ae && (
        ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.isContentEditable
      );
      // 移动端不自动聚焦，避免切换会话更新聚焦 paneId 时拉起系统软键盘
      if (!userTypingElsewhere && !isMobile.value && terminal) {
        terminal.focus();
      }
    });
  }
  if (focused && lastCwd.value) {
    emitWorkspaceEvent('terminal:cwdChanged', { sessionId: props.sessionId, cwd: lastCwd.value, paneId: props.paneId });
  }
}); 
 
// --- Settings Store ---
const settingsStore = useSettingsStore(); // +++ 实例化设置 store +++
const sessionStore = useSessionStore(); // +++ 实例化会话 store +++
const fileEditorStore = useFileEditorStore(); // 实例化文本编辑器 store
const {
  autoCopyOnSelectBoolean,
  terminalScrollbackLimitNumber, 
  terminalEnableRightClickPasteBoolean,
  terminalRightClickBehaviorString,
  terminalNoWrapBoolean, 
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
        console.log(`[Terminal ${props.sessionId}] Debounced resize emit (from ResizeObserver):`, dimensions, 'paneId:', props.paneId);
        // 必须带上 paneId：拖动分割条走的就是这条路径，漏了它 resize 永远只发给主终端，
        // 副终端的 PTY 尺寸不会更新 → TUI（btop）不重绘、排版错乱。
        emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: dimensions, paneId: props.paneId });
        // *** 尝试在发送 resize 后强制刷新终端显示 ***
        try {
            term.refresh(0, term.rows - 1); // Refresh entire viewport
        } catch (e) {
            console.warn(`[Terminal ${props.sessionId}] Terminal refresh failed:`, e);
        }
    }
}, 150); // 150ms 防抖延迟

// 计算终端尺寸 (支持“不换行”模式下超宽列数)
const calculateTerminalDimensions = (term: Terminal) => {
  const proposed = fitAddon?.proposeDimensions();
  const rows = proposed?.rows || term.rows;
  const visualCols = proposed?.cols || term.cols;
  // 开启不换行模式时提供充足列宽 (至少 500 列)，内容超出通过横向滚动条查看
  const cols = terminalNoWrapBoolean.value ? Math.max(500, visualCols) : visualCols;
  // `proposed` 为 undefined = 这次根本没量出来（容器没盒子 / 渲染器还没量字体），
  // 此时 cols/rows 是兜底出来的原值，拿它去「解锁写入」会把内容按错的列数写死。
  return { cols, rows, measured: !!proposed };
};

/**
 * 把「尺寸未定时」暂存的写入按原顺序真正写进终端。
 * 见 onMounted 里给 `write` 包一层的说明：内容一旦以 80 列写进去，
 * xterm 在 resize 时并不会把它重新折行（实测 5.3.0 的 reflow 对这批行不起作用），
 * 所以唯一可靠的办法是**等内容能按正确列数写的时候再写**。
 */
const flushPendingWrites = () => {
  if (!rawTerminalWrite || pendingWrites.length === 0) return;
  const queue = pendingWrites;
  pendingWrites = [];
  pendingWriteChars = 0;
  const write = rawTerminalWrite;
  for (const entry of queue) {
    try {
      if (entry.silent) {
        replaySilence.writeWithSilence(write, entry.data);
      } else {
        write(entry.data);
      }
    } catch (e) {
      console.warn(`[Terminal ${props.sessionId}] 补写暂存数据失败:`, e);
      break;
    }
  }
};

/**
 * 量到真实尺寸后解锁写入。只在第一次生效（后续靠 xterm 自己的 resize）。
 * 容器还没有盒子（会话在 `display:none` 的沙箱里）时直接返回，继续暂存。
 *
 * `measured` 必须传 `proposeDimensions()` 真的量出来了：容器刚拿到盒子的那一瞬间，
 * 渲染器还没量出字符宽高，proposeDimensions 会返回 undefined、cols 兜底成 80，
 * 这时候解锁就等于又按 80 列写一遍（实测就是这么翻车的）。
 */
const markRealSize = (reason: string, measured = true) => {
  if (hasRealSize) return;
  if (!measured) return;
  const el = terminalRef.value;
  if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return;
  hasRealSize = true;
  if (pendingWrites.length > 0) {
    console.log(
      `[Terminal ${props.sessionId}] 拿到真实尺寸(${el.offsetWidth}x${el.offsetHeight} via ${reason}, ${terminal?.cols}x${terminal?.rows})，补写 ${pendingWrites.length} 段暂存数据`
    );
    flushPendingWrites();
  }
};

// 立即执行 Fit 并发送 Resize 的函数
const fitAndEmitResizeNow = (term: Terminal) => {
    if (!term || !terminalRef.value) return;
    try {
        if (terminalRef.value.offsetHeight > 0 && terminalRef.value.offsetWidth > 0) {
            const dims = calculateTerminalDimensions(term);
            term.resize(dims.cols, dims.rows);
            markRealSize('fitNow', dims.measured);
            emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims, paneId: props.paneId });
            if (terminalRef.value) {
              const stableWidth = terminalOuterWrapperRef.value?.offsetWidth || terminalRef.value.offsetWidth;
              const stableHeight = terminalOuterWrapperRef.value?.offsetHeight || terminalRef.value.offsetHeight;
              emitWorkspaceEvent('terminal:stabilizedResize', { sessionId: props.sessionId, width: stableWidth, height: stableHeight, paneId: props.paneId });
            }
        } else {
             console.log(`[Terminal ${props.sessionId}] Immediate fit skipped (container not visible or has no dimensions).`);
        }
    } catch (e) {
        console.warn("Immediate fit/resize failed:", e);
    }
};

/**
 * 「量不出来就隔一会儿再量」。
 *
 * 元素从 0×0 变成有盒子、或祖先刚从 `display:none` 回来时，xterm 的渲染器还没量出
 * 字符宽高，`proposeDimensions()` 会返回 **undefined**，此时 cols 只能兜底成 80 ——
 * 既不能拿它 fit（会定格成 80 列），更不能拿它解锁写入（内容会被按 80 列折死）。
 * 这个窗口只有几十毫秒，量到就停，最多续 1.2s。
 */
let fitRetryIds: number[] = [];
const cancelFitRetries = () => {
    for (const id of fitRetryIds) clearTimeout(id);
    fitRetryIds = [];
};
const retryFitUntilMeasured = (term: Terminal) => {
    cancelFitRetries();
    for (const delay of [16, 50, 100, 180, 300, 450, 650, 900, 1200]) {
        fitRetryIds.push(window.setTimeout(() => {
            if (!terminal || !terminalRef.value) return;
            if (terminalRef.value.offsetWidth <= 0 || terminalRef.value.offsetHeight <= 0) return;
            if (!calculateTerminalDimensions(term).measured) return; // 还没量出来，等下一档
            cancelFitRetries();
            fitAndEmitResizeNow(term);
        }, delay));
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

// --- 右键菜单（实现见 composables/terminal/useTerminalContextMenu.ts）---
const {
  showContextMenu,
  contextMenuPosition,
  contextMenuSelectedText,
  handleContextMenuAction,
  addContextMenuListener,
  removeContextMenuListener,
} = useTerminalContextMenu({
  getTerminal: () => terminal,
  getSessionId: () => props.sessionId,
  containerRef: terminalRef,
});

// --- 右侧悬浮滚动条（实现见 composables/terminal/useTerminalScrollbar.ts）---
const {
  canScroll,
  scrollProgress,
  thumbHeightRatio,
  updateScrollState,
  handleScrollProgressChange,
  attachViewport,
  detachViewport,
} = useTerminalScrollbar({ getTerminal: () => terminal });

// --- 移动端双指缩放（实现见 composables/terminal/useTerminalPinchZoom.ts）---
const { handleTouchStart, handleTouchMove, handleTouchEnd } = useTerminalPinchZoom({
  getTerminal: () => terminal,
  getCurrentFontSize: () => currentTerminalFontSize.value,
  applyFontSize: (size: number) => {
    const term = terminal;
    if (term) fitAndEmitResizeNow(term);
    debouncedSaveFontSize(size);
  },
});

// 初始化终端
onMounted(() => {
  subscribeToWorkspaceEvent('search:markers', handleSearchMarkers);

  // xterm 挂载到 terminalRef (内部容器)
  if (terminalRef.value) {
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: currentTerminalFontSize.value, 
      fontFamily: currentTerminalFontFamily.value, // 使用 store 中的字体设置
      theme: {
        ...effectiveTerminalTheme.value,
        // 启用终端背景图/透明时，把 xterm 自己的底色也设为透明。
        // 否则 TUI（btop/vim 等）退出时的 `\e[2J` 会拿 theme.background 填满整屏，
        // 背景图被一整块黑盖住 —— 用户看到的就是"退出 btop 后终端被黑色填充"。
        ...(isTerminalBackgroundEnabled.value ? { background: 'rgba(0, 0, 0, 0)' } : {}),
      }, // 使用 store 中的当前 xterm 主题 (now effectiveTerminalTheme)
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
    /*
       * highlightLimit 直接决定搜索的峰值耗时：
       * 实测 3000 行 buffer，1000 个装饰 ≈ 222ms，100 个 ≈ 23ms（几乎线性）。
       * 可视区只有几十行，200 个足够覆盖"上下翻几屏"的视觉需求。
       */
    searchAddon = new SearchAddon({ highlightLimit: 200 });
    serializeAddon = new SerializeAddon(); // *** 创建 SerializeAddon 实例 ***
    const unicode11Addon = new Unicode11Addon(); // 支持 Unicode 11 现代宽字符规范
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(searchAddon); // *** 加载 SearchAddon ***
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(serializeAddon); // *** 加载 SerializeAddon ***
    terminal.unicode.activeVersion = '11'; // 激活 Unicode 11 版本支持

    // 将终端附加到 DOM
    terminal.open(terminalRef.value);

    /**
     * 尺寸可信之前，先把写入攒起来（见下方 fit 处）。
     *
     * 为什么非这样不可：每个会话的工作区是个常驻 `v-show` 沙箱，刷新恢复时非激活会话的
     * 终端是在 `display:none` 的祖先里挂载的 —— 容器 0×0，`proposeDimensions()` 返回 undefined，
     * 终端只能是 xterm 默认的 80×24。这时后端把回放数据灌进来，200 多列的长行就会被
     * **按 80 列折行**写进 buffer。等切到该标签、fit 到 164 列时，xterm 5.3.0 的 reflow
     * 并不会把这批行重新合并（实测：`resize` 前后行宽都是 80，`isWrapped` 原样保留），
     * 于是屏幕上的旧内容永远只占左边 80 列 —— 用户看到的"文本挤在左上一小部分"。
     *
     * 唯一可靠的做法是：**等终端真的量到尺寸了再写**。所以这里把 `write` 包一层，
     * 在 `hasRealSize` 之前只入队；`markRealSize()` 在 fit 成功后按顺序补写。
     */
    rawTerminalWrite = terminal.write.bind(terminal);
    const enqueueOrWrite = (data: string | Uint8Array, silent: boolean, cb?: () => void) => {
      if (hasRealSize) {
        if (silent) {
          replaySilence.writeWithSilence(rawTerminalWrite!, data, cb);
        } else {
          rawTerminalWrite!(data, cb);
        }
        return;
      }
      pendingWrites.push({ data, silent });
      pendingWriteChars += data.length;
      if (pendingWriteChars >= PENDING_WRITE_LIMIT) {
        console.warn(
          `[Terminal ${props.sessionId}] 暂存写入超过 ${PENDING_WRITE_LIMIT} 字符仍没等到尺寸，先按当前 ${terminal?.cols}x${terminal?.rows} 写进去`
        );
        hasRealSize = true;
        flushPendingWrites();
      }
    };
    (terminal as any).write = ((data: string | Uint8Array, cb?: () => void) => {
      enqueueOrWrite(data, false, cb);
    }) as any;
    (terminal as any).writeReplay = ((data: string | Uint8Array, cb?: () => void) => {
      enqueueOrWrite(data, true, cb);
    }) as any;
    // 采集快照时如果数据还压在队里（这个会话从没露过面），直接把原始字节流交出去：
    // 此刻 buffer 还是空的，这份流就是它的全部内容；等它真被切到、fit 到正确列数后
    // 再写进去，折行位置才对。**绝不能为了采集而提前 flush** —— 那等于按 80 列写一遍，
    // 又回到"内容只有 80 列宽"的老问题。
    (terminal as any).getPendingWriteText = () => {
      if (pendingWrites.length === 0) return null;
      let text = '';
      for (const entry of pendingWrites) {
        text += typeof entry.data === 'string' ? entry.data : new TextDecoder().decode(entry.data as Uint8Array);
      }
      return text;
    };
    // 开发期：把 xterm 实例交给调试桥，AI 可直接读 buffer 判断"黑屏/断连/回显缺失"
    unregisterDebugTerminal = registerDebugTerminal({
      id: props.paneId || props.sessionId,
      sessionId: props.sessionId,
      label: props.paneId ? `${props.sessionId}@${props.paneId}` : props.sessionId,
      term: terminal,
      meta: { paneId: props.paneId, isActive: props.isActive, isMobile: isMobile.value },
    });
    // terminal.open() 同步执行完毕后，可以认为 Xterm 已尝试附加到 DOM
    isTerminalDomReady.value = true; // +++ 直接在此处设置 DOM 准备就绪状态 +++
    console.log(`[Terminal ${props.sessionId}] Xterm open() called, considering DOM ready for initial style checks.`);
 
    // 适应容器大小
    const initDims = calculateTerminalDimensions(terminal);
    terminal.resize(initDims.cols, initDims.rows);
    // 容器有盒子（当前标签就是激活的）→ 立刻解锁写入；隐藏沙箱里则继续攒着
    markRealSize('mounted', initDims.measured);
    // 有盒子但渲染器还没量出字符宽高 → 过一会儿重量（量到就停）
    if (!initDims.measured && terminalRef.value.offsetWidth > 0) retryFitUntilMeasured(terminal);
    emitWorkspaceEvent('terminal:resize', { sessionId: props.sessionId, dims: { cols: terminal.cols, rows: terminal.rows }, paneId: props.paneId }); // 触发初始 resize 事件

    // 注册自定义按键处理器：拦截并放行分屏终端切换快捷键，防止被 xterm.js 吞噬
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const switchShortcut = settingsStore.terminalSwitchPaneShortcutString || 'Alt+`';
      if (isShortcutMatched(event, switchShortcut)) {
        return false; // 返回 false 让 xterm 忽略此按键，事件冒泡至 window 全局处理
      }
      return true;
    });

    // 订阅 xterm 内部真实用户输入信号，确保回放静默窗口内只拦截 parser 自动回包、不丢任何真实按键/粘贴
    try {
      const coreUserInputEvent = (terminal as any)?._core?.coreService?.onUserInput;
      if (typeof coreUserInputEvent === 'function') {
        userInputListenerDisposable = coreUserInputEvent(() => {
          replaySilence.markUserInput();
        });
      }
    } catch {
      /* 非标准 xterm 实例时安全忽略 */
    }

    // 监听用户输入
    terminal.onData((data) => {
      if (replaySilence.shouldSuppressOnData()) {
        return;
      }
      emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, paneId: props.paneId, data });
    });

    // 监听 OSC 7 当前工作目录通告序列 (Operating System Command 7: CWD)
    // 格式形如: file://hostname/path/to/dir 或 /path/to/dir
    terminal.parser.registerOscHandler(7, (data: string) => {
      try {
        let path = data.trim();
        if (path.startsWith('file://')) {
          const urlStr = path.replace(/^file:\/\/[^\/]*/, '');
          path = urlStr ? decodeURIComponent(urlStr) : '/';
        }
        if (path && path.startsWith('/')) {
          lastCwd.value = path;
          console.log(`[Terminal ${props.sessionId}][pane: ${props.paneId}] 捕获到 OSC 7 工作目录通告: ${path}`);
          emitWorkspaceEvent('terminal:cwdChanged', { sessionId: props.sessionId, cwd: path, paneId: props.paneId });
        }
      } catch (err) {
        console.warn(`[Terminal ${props.sessionId}] 解析 OSC 7 序列失败:`, err, data);
      }
      return true; // 返回 true 表示已消费此 OSC，不向屏幕输出控制码
    });

    // 监听终端大小变化 (通过 ResizeObserver) - 主要处理浏览器窗口大小变化等
    // ResizeObserver 优先观察外层视口容器 terminalOuterWrapperRef，防止不换行模式超宽展开破坏视口尺寸
    if (terminalOuterWrapperRef.value || terminalRef.value) {
        observedElement = (terminalOuterWrapperRef.value || terminalRef.value) as HTMLElement;
        resizeObserver = new ResizeObserver((entries) => {
            if (!props.isActive || !terminal || !terminalRef.value) return;

            const entry = entries[0];
            const { height: rectHeight, width: rectWidth } = entry.contentRect;

            // --- 阈值判断逻辑 ---
            const widthChangedSignificantly = Math.abs(rectWidth - lastResizeObserverWidth) >= RESIZE_THRESHOLD;
            const heightChangedSignificantly = Math.abs(rectHeight - lastResizeObserverHeight) >= RESIZE_THRESHOLD;

            if (!widthChangedSignificantly && !heightChangedSignificantly) {
              return;
            }

            const roundedWidth = Math.round(rectWidth);
            const roundedHeight = Math.round(rectHeight);

            // 更新已记录的尺寸阈值
            lastResizeObserverWidth = roundedWidth;
            lastResizeObserverHeight = roundedHeight;

            if (rectHeight <= 0 || rectWidth <= 0) return;

            // 使用 requestAnimationFrame 防抖批处理，彻底根除 Layout Thrashing 与每帧连续强制重排
            if (resizeRafId !== null) {
              cancelAnimationFrame(resizeRafId);
            }
            resizeRafId = requestAnimationFrame(() => {
              resizeRafId = null;
              if (!props.isActive || !terminal || !terminalRef.value) return;
              try {
                const dims = calculateTerminalDimensions(terminal);
                if (dims.cols !== terminal.cols || dims.rows !== terminal.rows) {
                  terminal.resize(dims.cols, dims.rows);
                  debouncedEmitResize(terminal);
                }
                markRealSize('outerRO', dims.measured);
                const viewportWidth = roundedWidth;
                const viewportHeight = roundedHeight;
                emitWorkspaceEvent('terminal:stabilizedResize', { sessionId: props.sessionId, width: viewportWidth, height: viewportHeight, paneId: props.paneId });
              } catch (e) {
                console.warn(`[TerminalResizeObserver sessionId=${props.sessionId}] Fit addon or debouncedEmitResize failed:`, e);
              }
            });
        });
        // Observe only if initially active (or becomes active later)
        if (props.isActive) {
            resizeObserver.observe(observedElement);
            console.log(`[Terminal ${props.sessionId}] Initial observe.`);
        }

        /**
         * 再盯住真正的 fit 目标 `.terminal-inner-container`。
         *
         * `proposeDimensions()` 量的是 xterm 的**直接父级**，也就是内层容器；
         * 而外层 wrapper 在某些情况下并不跟着变（内层被 padding / 滚动条 / 临时约束挤小再放开），
         * 这时外层 ResizeObserver 全程静默 → 终端定格在小尺寸。
         * 内层自己变了就重新 fit，才能覆盖所有"盒子先小后大"的时序。
         *
         * ⚠️「不换行」模式下内层是 `width: max-content`：拿它的宽度去 fit 会
         * fit 出更宽 → 内层更宽 → 再 fit，互相喂成死循环。那个模式必须跳过。
         */
        if (terminalRef.value) {
            innerResizeObserver = new ResizeObserver((entries) => {
                if (!props.isActive || !terminal || !terminalRef.value) return;
                if (terminalNoWrapBoolean.value) return; // 见上：不换行模式会让内外互喂
                const rect = entries[0]?.contentRect;
                if (!rect) return;
                const w = Math.round(rect.width);
                const h = Math.round(rect.height);
                if (w <= 0 || h <= 0) return;
                if (Math.abs(w - lastInnerObserverWidth) < RESIZE_THRESHOLD &&
                    Math.abs(h - lastInnerObserverHeight) < RESIZE_THRESHOLD) return;
                lastInnerObserverWidth = w;
                lastInnerObserverHeight = h;
                const dims = calculateTerminalDimensions(terminal);
                if (dims.cols === terminal.cols && dims.rows === terminal.rows) {
                    if (!dims.measured) retryFitUntilMeasured(terminal);
                    else markRealSize('innerRO', true);
                    return;
                }
                console.log(
                    `[Terminal ${props.sessionId}] 内层容器变化，重新 fit: ${terminal.cols}x${terminal.rows} -> ${dims.cols}x${dims.rows} (容器 ${w}x${h})`
                );
                terminal.resize(dims.cols, dims.rows);
                markRealSize('innerRO', dims.measured);
                debouncedEmitResize(terminal);
            });
            innerResizeObserver.observe(terminalRef.value);
        }

    }


    // 监听 isActive prop 的变化
    watch(() => props.isActive, (newValue, oldValue) => {
        console.log(`[Terminal ${props.sessionId}] isActive changed from ${oldValue} to ${newValue}`);
        if (resizeObserver && observedElement) {
            if (newValue) {
                // --- Become Active ---
                console.log(`[Terminal ${props.sessionId}] Becoming active. Observing element and fitting.`);
                // 基线清零：否则 RO 的首次回调会拿"上一轮活跃时的尺寸"做比较，
                // 判定"没变化"→ 直接 return，把这一次切标签的 fit 吃掉。
                lastResizeObserverWidth = 0;
                lastResizeObserverHeight = 0;
                // Start observing
                try {
                    resizeObserver.observe(observedElement);
                } catch (e) {
                     console.warn(`[Terminal ${props.sessionId}] Error observing element:`, e);
                }
                nextTick(() => {
                    if (props.isActive && terminal && terminalRef.value && terminalRef.value.offsetHeight > 0) {
                        // 立刻 fit 一次；量不出来（渲染器还没量字符宽高）就过一会儿重量。
                        // 内容解锁交给 fit 内部（markRealSize 只在 proposeDimensions 真的量出来时才生效）。
                        fitAndEmitResizeNow(terminal);
                        if (!calculateTerminalDimensions(terminal).measured) retryFitUntilMeasured(terminal);
                        // 移动端不自动聚焦，避免每次激活会话自动弹起输入法
                        if (!isMobile.value) {
                            terminal.focus();
                        }
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
              terminal.write(highlightStore.highlight(value)); // 将流数据写入终端
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

    // 触发 ready 事件，传递 sessionId, terminal, searchAddon 和 serializeAddon 实例
    if (terminal) {
        emitWorkspaceEvent('terminal:ready', {
          sessionId: props.sessionId,
          terminal: terminal,
          searchAddon: searchAddon,
          serializeAddon: serializeAddon,
          paneId: props.paneId,
        });
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
    watch(terminalNoWrapBoolean, (noWrap) => {
      if (terminal && terminalRef.value && props.isActive) {
        console.log(`[Terminal ${props.sessionId}] terminalNoWrap changed to ${noWrap}, updating terminal dimensions.`);
        nextTick(() => {
          if (terminal) {
            fitAndEmitResizeNow(terminal);
          }
        });
      }
    });

    watch([effectiveTerminalTheme, isTerminalBackgroundEnabled], ([newTheme]) => {
      if (terminal) {
        console.log(`[Terminal ${props.sessionId}] 应用新终端主题 (effective)。`);
        // 直接修改 options 对象（背景启用时保持透明底色，避免清屏后盖住背景图）
        terminal.options.theme = isTerminalBackgroundEnabled.value
          ? { ...newTheme, background: 'rgba(0, 0, 0, 0)' }
          : newTheme;
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

    // 聚焦终端 (仅桌面端自动聚焦，避免手机端打开新会话时自动弹出输入法)
    if (terminal && !isMobile.value) {
        terminal.focus();
    }

    // --- 添加 Ctrl+Shift+C/V 复制粘贴 ---
    if (terminal && terminal.textarea) { // 确保 terminal 和 textarea 存在
        textareaKeydownEl = terminal.textarea;
        textareaKeydownHandler = async (event: KeyboardEvent) => {
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
                    if (text && terminal) {
                        terminal.paste(text);
                    }
                } catch (err) {
                    console.error('[Terminal] Failed to paste via Ctrl+Shift+V:', err);
                    // 检查权限问题，例如 navigator.clipboard.readText 需要用户授权或安全上下文
                    // 可以考虑添加 UI 提示
                }
            }
        };
        textareaKeydownEl.addEventListener('keydown', textareaKeydownHandler);
    }

    // 根据初始设置添加右键交互监听器
    if (terminalRightClickBehaviorString.value !== 'none') {
      addContextMenuListener();
    }

    // 监听右键设置变化
    watch(terminalRightClickBehaviorString, (newValue) => {
      if (newValue !== 'none') {
        removeContextMenuListener();
        addContextMenuListener();
      } else {
        removeContextMenuListener();
      }
    });


    // 重新添加鼠标滚轮缩放功能到内部容器 terminalRef
    if (terminalRef.value) {
      containerWheelTouchEl = terminalRef.value;
      containerWheelHandler = (event: WheelEvent) => {
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
      };
      containerWheelTouchEl.addEventListener('wheel', containerWheelHandler);
    }

    // Add touch listeners for pinch zoom on mobile
    if (isMobile.value && terminalRef.value && terminal) {
      console.log(`[Terminal ${props.sessionId}] Adding touch listeners for mobile pinch zoom.`);
      containerWheelTouchEl = terminalRef.value;
      containerWheelTouchEl.addEventListener('touchstart', handleTouchStart, { passive: false });
      containerWheelTouchEl.addEventListener('touchmove', handleTouchMove, { passive: false });
      containerWheelTouchEl.addEventListener('touchend', handleTouchEnd, { passive: false });
      containerWheelTouchEl.addEventListener('touchcancel', handleTouchEnd, { passive: false }); // Also handle cancel
      hasBoundTouchListeners = true;
    }

    // 监听终端滚动、输出解析与尺寸变化，动态刷新滚动条显示与位置
    if (terminal) {
      terminal.onScroll(() => {
        updateScrollState();
      });
      terminal.onWriteParsed(() => {
        updateScrollState();
      });
      terminal.onResize(() => {
        updateScrollState();
      });
      // ★ 鼠标滚轮滚的是 .xterm-viewport 的原生 scrollTop，xterm 这个版本不会为它发 onScroll，
      //   只监听 onScroll 就会出现"滚轮滚了、右侧滚动条不动"。补一条原生 scroll 监听。
      const viewportEl = (terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null) ?? null;
      if (viewportEl) {
        attachViewport(viewportEl);
      }
      nextTick(() => {
        updateScrollState();
      });
    }

  }
});

// 组件卸载前清理资源
onBeforeUnmount(() => {
  unsubscribeFromWorkspaceEvent('search:markers', handleSearchMarkers);
  if (unregisterDebugTerminal) {
    unregisterDebugTerminal();
    unregisterDebugTerminal = null;
  }
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
    resizeRafId = null;
  }
  detachViewport();
  emitWorkspaceEvent('terminal:dispose', { sessionId: props.sessionId, paneId: props.paneId });
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
  // 丢弃还没写出去的暂存数据：终端马上要销毁了，写进去也没有意义
  if (pendingWrites.length > 0) {
    console.log(`[Terminal ${props.sessionId}] 卸载时丢弃 ${pendingWrites.length} 段未解锁的暂存数据`);
  }
  pendingWrites = [];
  pendingWriteChars = 0;
  rawTerminalWrite = null;
  if (userInputListenerDisposable) {
    try {
      userInputListenerDisposable.dispose();
    } catch {
      /* ignore */
    }
    userInputListenerDisposable = null;
  }
  if (textareaKeydownEl && textareaKeydownHandler) {
    textareaKeydownEl.removeEventListener('keydown', textareaKeydownHandler);
    textareaKeydownEl = null;
    textareaKeydownHandler = null;
  }
  if (containerWheelTouchEl && containerWheelHandler) {
    containerWheelTouchEl.removeEventListener('wheel', containerWheelHandler);
    containerWheelHandler = null;
  }
  if (containerWheelTouchEl && hasBoundTouchListeners) {
    containerWheelTouchEl.removeEventListener('touchstart', handleTouchStart);
    containerWheelTouchEl.removeEventListener('touchmove', handleTouchMove);
    containerWheelTouchEl.removeEventListener('touchend', handleTouchEnd);
    containerWheelTouchEl.removeEventListener('touchcancel', handleTouchEnd);
    hasBoundTouchListeners = false;
  }
  containerWheelTouchEl = null;
  replaySilence.reset();
  cancelFitRetries();
  cancelFitRetries();
  if (innerResizeObserver) {
    try {
      innerResizeObserver.disconnect();
    } catch (e) {
      // ignore
    }
    innerResizeObserver = null;
  }
  observedElement = null;

  if (serializeAddon) {
    try {
      serializeAddon.dispose();
    } catch (e) {
      // ignore
    }
    serializeAddon = null;
  }

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
    terminal?.write(highlightStore.highlight(data));
};

// *** 暴露搜索方法 ***
// 保留这两个公开方法（父组件仍可能调用）。默认带 decorations，
// 否则调用方忘了传就只有"当前选中"，没有全量高亮。
const findNext = (term: string, options?: ISearchOptions): boolean => {
  if (searchAddon) {
    return searchAddon.findNext(term, { ...options, decorations: options?.decorations ?? DEFAULT_SEARCH_DECORATIONS });
  }
  return false;
};

const findPrevious = (term: string, options?: ISearchOptions): boolean => {
  if (searchAddon) {
    return searchAddon.findPrevious(term, { ...options, decorations: options?.decorations ?? DEFAULT_SEARCH_DECORATIONS });
  }
  return false;
};

const clearSearch = () => {
  searchAddon?.clearDecorations();
  searchMatchIndex.value = -1;
  searchMatchCount.value = 0;
  searchMatchLines.value = [];
  searchTotalLines.value = 1;
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

// --- 支持拖拽文件/文件夹直接在终端输入路径 ---
const isDraggingOverTerminal = ref(false);

const handleTerminalDragEnter = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes('text/plain') || event.dataTransfer?.types.includes('Files') || event.dataTransfer?.types.includes('application/x-nexus-sftp-items')) {
    event.preventDefault();
    isDraggingOverTerminal.value = true;
  }
};

const handleTerminalDragOver = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes('text/plain') || event.dataTransfer?.types.includes('Files') || event.dataTransfer?.types.includes('application/x-nexus-sftp-items')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    isDraggingOverTerminal.value = true;
  }
};

const handleTerminalDragLeave = (event: DragEvent) => {
  const related = event.relatedTarget as Node | null;
  if (!terminalOuterWrapperRef.value || !related || !terminalOuterWrapperRef.value.contains(related)) {
    isDraggingOverTerminal.value = false;
  }
};

const handleTerminalDrop = (event: DragEvent) => {
  isDraggingOverTerminal.value = false;
  event.preventDefault();

  // 1. 优先读取 text/plain（FileManager 会放入带引号的绝对路径，格式如 "/var/log/nginx" ）
  let textToInsert = event.dataTransfer?.getData('text/plain') || '';

  // 2. 如果是从外部拖拽的文件，拼接其文件名并加上空格
  if (!textToInsert && event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
    textToInsert = Array.from(event.dataTransfer.files).map(f => `"${f.name}"`).join(' ') + ' ';
  }

  if (textToInsert) {
    // 像用户打字一样，直接发送到终端
    const activeSession = sessionStore.sessions.get(props.sessionId);
    if (activeSession?.terminalManager) {
      activeSession.terminalManager.sendData(textToInsert);
    } else {
      emitWorkspaceEvent('terminal:input', { sessionId: props.sessionId, data: textToInsert });
    }
    // 聚焦回终端
    terminal?.focus();
  }
};


// --- 终端多窗格聚焦与自动执行指令支持 ---
const currentSession = computed(() => sessionStore.sessions.get(props.sessionId));
const terminalManagerInstance = computed(() => currentSession.value?.terminalManager);
const connectionsStore = useConnectionsStore();

// 辅助函数：匹配按键与自定义快捷键规则
const isShortcutMatched = (e: KeyboardEvent, shortcutStr: string): boolean => {
  if (!shortcutStr) return false;
  const parts = shortcutStr.toLowerCase().split('+').map(p => p.trim());
  const needsCtrl = parts.includes('ctrl') || parts.includes('control');
  const needsAlt = parts.includes('alt');
  const needsShift = parts.includes('shift');
  const needsMeta = parts.includes('meta') || parts.includes('cmd') || parts.includes('win');

  if (e.ctrlKey !== needsCtrl) return false;
  if (e.altKey !== needsAlt) return false;
  if (e.shiftKey !== needsShift) return false;
  if (e.metaKey !== needsMeta) return false;

  const keyPart = parts.find(p => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'win'].includes(p));
  if (!keyPart) return true;

  const eventKey = (e.key || '').toLowerCase();
  const eventCode = (e.code || '').toLowerCase();

  if (keyPart === '`' || keyPart === '~' || keyPart === 'backquote') {
    return eventKey === '`' || eventKey === '~' || eventCode === 'backquote';
  }

  return eventKey === keyPart || eventCode === `key${keyPart}` || eventCode === keyPart;
};

// 监听 SSH 连接就绪状态并自动执行配置的指令
const hasExecutedAutoCmd = ref(false);

const checkAndExecuteAutoCmd = () => {
  if (hasExecutedAutoCmd.value) return;
  const isConnected = terminalManagerInstance.value?.isSshConnected?.value;
  if (!isConnected) return;

  // 如果是分屏副终端，等待其独立通道就绪
  if (props.paneId && props.paneId !== terminalManagerInstance.value?.primaryPaneId?.value) {
    const paneEntry = terminalManagerInstance.value?.terminalPanes?.value?.get(props.paneId);
    if (!paneEntry?.isReady) return;
  }

  const targetConnId = String(currentSession.value?.connectionId || '');

  // 两份配置互不覆盖，都配了就都执行：
  //   · 连接级「启动命令」——这台机器一律先做的事（比如 sudo -i、cd /app）
  //   · 布局级「自启指令」——这个窗格额外要做的（按连接 id 命中的规则或默认值）
  // 顺序上连接级在前，布局指令能落在它建好的环境里。
  const conn = connectionsStore.connections.find((c) => String(c.id) === targetConnId);
  const connCmd = typeof conn?.startup_command === 'string' ? conn.startup_command.trim() : '';
  const layoutRaw = props.autoExecConfig?.connectionCommands?.[targetConnId] ?? props.autoExecConfig?.defaultCommand;
  const layoutCmd = typeof layoutRaw === 'string' ? layoutRaw.trim() : '';

  // 两边写的是同一条时只发一次 —— 否则 `sudo -i` 会被塞进两个甚至三个 shell 层
  const cmds: string[] = [];
  for (const cmd of [connCmd, layoutCmd]) {
    if (cmd && !cmds.includes(cmd)) cmds.push(cmd);
  }
  if (cmds.length === 0) return;

  hasExecutedAutoCmd.value = true;
  cmds.forEach((cmdToExec, index) => {
    // 逐条发、每条留出执行时间：一次性把 "sudo -i\rcd /app\r" 灌进去，
    // 后一条会在 sudo 还没切完 shell 时丢掉。
    setTimeout(() => {
      if (terminalManagerInstance.value && typeof terminalManagerInstance.value.sendData === 'function') {
        console.log(`[Terminal Pane ${props.paneId || 'default'}] 触发 SSH 连接自动执行指令: ${cmdToExec}`);
        terminal?.writeln(`\r\n\x1b[35m⚡ [自动执行指令]: ${cmdToExec}\x1b[0m\r\n`);
        terminalManagerInstance.value.sendData(cmdToExec + '\r', props.paneId);
      }
    }, 350 + index * 450);
  });
};

watch(() => terminalManagerInstance.value?.isSshConnected?.value, (connected) => {
  if (connected) {
    checkAndExecuteAutoCmd();
  } else {
    hasExecutedAutoCmd.value = false;
  }
}, { immediate: true });

// 监听分屏通道就绪状态
watch(() => terminalManagerInstance.value?.terminalPanes?.value?.get(props.paneId || '')?.isReady, (ready) => {
  if (ready) {
    checkAndExecuteAutoCmd();
  }
});

// 用户主动点击终端画面时通知布局管理器更新活动窗格并聚焦
const handleTerminalClick = (event?: MouseEvent) => {
  // 拖动或点击右侧滚动条时不重新聚焦终端，避免移动端收起输入法后误触发拉起软键盘
  const target = event?.target as HTMLElement | null;
  if (target?.closest('.terminal-scrollbar-track')) {
    return;
  }
  emit('focus');
  if (terminal) {
    terminal.focus();
  }
};
</script>

<template>
  <div
    ref="terminalOuterWrapperRef"
    class="terminal-outer-wrapper transition-shadow duration-150 relative"
    :class="{
      'ring-2 ring-primary ring-inset': isDraggingOverTerminal,
      'is-mobile': isMobile,
      'gutter-scroll': !isMobile,
      'force-transparent-bg': isTerminalBackgroundEnabled
    }"
    @click="handleTerminalClick"
    @mousedown="handleTerminalClick"
    @dragenter="handleTerminalDragEnter"
    @dragover="handleTerminalDragOver"
    @dragleave="handleTerminalDragLeave"
    @drop="handleTerminalDrop"
  >
    <!-- 拖拽悬停视觉提示 -->
    <div
      v-if="isDraggingOverTerminal"
      class="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 pointer-events-none backdrop-blur-[1px]"
    >
      <div class="px-3.5 py-1.5 rounded-lg bg-header/90 border border-primary/50 text-foreground text-xs font-mono shadow-xl flex items-center gap-2">
        <i class="fas fa-terminal text-primary animate-pulse"></i>
        <span>松开在终端中输入绝对路径</span>
      </div>
    </div>

    <!-- 内部横向滚动视口容器 (与右侧滚动条解耦，横向滑动时不漂移) -->
    <div class="terminal-view-row">
      <div
        class="terminal-scroll-viewport"
        :class="{ 'no-wrap': terminalNoWrapBoolean }"
      >
        <!-- xterm 实际挂载点 -->
        <div ref="terminalRef" class="terminal-inner-container"></div>
      </div>

      <!-- 桌面端：滚动条占右侧独立一列，浮层压力归零（不再压住终端内容/背景图） -->
      <TerminalScrollbar
        v-if="!isMobile"
        variant="gutter"
        :can-scroll="canScroll"
        :scroll-progress="scrollProgress"
        :thumb-height-ratio="thumbHeightRatio"
        :search-markers="searchMarkers"
        @scroll-progress="handleScrollProgressChange"
      />
    </div>

    <!-- 移动端专属右侧悬浮滚动条 (独立解耦组件) -->
    <TerminalScrollbar
      v-if="isMobile && canScroll"
      variant="floating"
      :can-scroll="canScroll"
      :scroll-progress="scrollProgress"
      :thumb-height-ratio="thumbHeightRatio"
      :search-markers="searchMarkers"
      @scroll-progress="handleScrollProgressChange"
    />

    <!-- 终端右键菜单 -->
    <TerminalContextMenu
      :visible="showContextMenu"
      :x="contextMenuPosition.x"
      :y="contextMenuPosition.y"
      :selected-text="contextMenuSelectedText"
      :menu-config="settingsStore.terminalContextMenuItemsObject"
      @select="handleContextMenuAction"
      @close="showContextMenu = false"
    />
  </div>
</template>

<style scoped>
/* 启用终端背景图时，强制 xterm 的各个渲染层透明。
   这几层是 xterm 运行时创建的，没有 Vue 的 scope id，必须用 :deep()；
   之前靠父组件（LayoutRenderer）的 scoped 规则根本选不中，
   于是清屏/退出 TUI 后整块区域会露出不透明的黑底，把背景图盖住。 */
.terminal-outer-wrapper.force-transparent-bg :deep(.xterm),
.terminal-outer-wrapper.force-transparent-bg :deep(.xterm-viewport),
.terminal-outer-wrapper.force-transparent-bg :deep(.xterm-screen),
.terminal-outer-wrapper.force-transparent-bg :deep(.xterm-rows) {
  background-color: transparent !important;
}

.terminal-outer-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: transparent !important;
}

.terminal-scroll-viewport {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: transparent !important;
}

/* 终端视口与滚动条同层并排：滚动条占独立一列，不再叠在终端上方 */
.terminal-view-row {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: stretch;
}

.terminal-view-row > .terminal-scroll-viewport {
  width: auto;
  flex: 1 1 auto;
  min-width: 0;
}

/* 桌面端隐藏 xterm 自带滚动条（它是绝对定位的浮层，会压住终端右边缘），改由旁列滚动条接管 */
.terminal-outer-wrapper.gutter-scroll :deep(.xterm-viewport) {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
.terminal-outer-wrapper.gutter-scroll :deep(.xterm-viewport::-webkit-scrollbar) {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

.terminal-scroll-viewport.no-wrap {
  overflow-x: auto !important;
  overflow-y: hidden !important;
  -webkit-overflow-scrolling: touch;
  background-color: transparent !important;
}

.terminal-scroll-viewport.no-wrap .terminal-inner-container {
  width: max-content !important;
  min-width: 100% !important;
  background-color: transparent !important;
}

.terminal-inner-container {
  width: 100%;
  height: 100%;
  background-color: transparent !important;
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

/* 移动端终端隐藏原生浏览器粗糙滚动条，由移动端专属胶囊滚动条统一呈现 */
.terminal-outer-wrapper.is-mobile :deep(.xterm-viewport) {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
.terminal-outer-wrapper.is-mobile :deep(.xterm-viewport::-webkit-scrollbar) {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

</style>

