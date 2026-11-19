import { useSessionStore } from '../session.store';
import { useFileEditorStore } from '../fileEditor.store';
import { useLayoutStore } from '../layout.store';
import { useConnectionsStore } from '../connections.store';
import { normalizePaneBuffers, stripPrimaryPaneBuffer } from '../../utils/workspaceSnapshot';
import {
  isValidFileManagerSyncPath,
  type SyncedFileManagerInfo,
  type SyncedFileManagerInstanceState,
  type SyncedFileTabInfo,
  type SyncedMultiLineCommandInfo,
  type SyncedSessionInfo,
  type WorkspaceSnapshot,
} from './types';

/**
 * 采集当前工作区快照（从 workspaceSync.store 抽出，204 行）。
 *
 * 这里有几个不显然但必须保留的约束，都是线上问题换来的：
 *
 * 1. **会话顺序按标签栏真实排布**，不是 Map 的插入顺序 —— 否则刷新后标签会乱序。
 * 2. **全屏 TUI（btop/vim/less）的备用屏不能存**。界面文字没有保存价值，
 *    存下来会让刷新后的终端变成一块静态 UI，退出 TUI 时还会留一片黑。
 * 3. **分屏 buffer 的 key 必须是先序序号**（pane#0 / pane#1）。
 *    会话树的 paneId 每次刷新都会重新生成，直接拿 paneId 当 key，恢复时必然全部 miss。
 * 4. **无终端（headless）会话不能存**。它是文件管理器绑定别的主机时开的私有 SFTP 通道，
 *    没有标签、没有终端内容。一旦写进快照，恢复时会按快照会话当标签恢复 ——
 *    用户看到的就是「我刚关掉的连接又自己回来了」，而快照里 sessionsCount=1 / tabsCount=0
 *    正是这种「有会话、没标签」的形态。
 */
export interface CollectSnapshotDeps {
  syncEnabled: boolean;
  fileManagerState: SyncedFileManagerInfo;
  fileManagerInstances: Record<string, SyncedFileManagerInstanceState>;
  multiLineCommandState: SyncedMultiLineCommandInfo;
}

export function collectWorkspaceSnapshot(deps: CollectSnapshotDeps): WorkspaceSnapshot {
  const sessionStore = useSessionStore();
  const fileEditorStore = useFileEditorStore();
  const layoutStore = useLayoutStore();
  const connectionsStore = useConnectionsStore();

  // 1. 收集会话信息（严格按照当前标签栏真实的排布顺序收集！）
  //
  // RDP / VNC 会话**不进快照**：它们没有 SSH 通道、没有终端 buffer，
  // 票据是每次连接现签的一次性凭据，恢复时也不可能"续上"。
  // 若照原样写进快照，刷新后 restoreSessions 会拿 RDP 端口去开 SSH 会话。
  const isRemoteSession = (s: { kind?: string } | undefined) => s?.kind === 'rdp' || s?.kind === 'vnc';

  /**
   * 无终端会话（文件管理器绑定主机的私有通道）**不进快照**。
   *
   * 它不在标签栏里、也没有终端内容，恢复时却会被当成一条普通快照会话开成标签 ——
   * 「关掉的连接自己又回来了」的根因就在这里。文件管理器需要通道时自己会再建一条。
   */
  const isHeadlessSession = (s: { headless?: boolean } | undefined) => s?.headless === true;

  const orderedTabs = sessionStore.sessionTabsWithStatus || [];
  const orderedSessionIds = orderedTabs.map((t) => t.sessionId);
  const allSessionIds = Array.from(sessionStore.sessions.keys()).filter((id) => {
    const s = sessionStore.sessions.get(id);
    return !isRemoteSession(s) && !isHeadlessSession(s);
  });
  const sortedSessionIds = [
    ...orderedSessionIds.filter((id) => allSessionIds.includes(id)),
    ...allSessionIds.filter((id) => !orderedSessionIds.includes(id)),
  ];

  const sessionsList: SyncedSessionInfo[] = [];
  sortedSessionIds.forEach((sId) => {
    const s = sessionStore.sessions.get(sId);
    if (!s || isRemoteSession(s) || isHeadlessSession(s)) return;
    // 终端屏幕缓冲区：优先用 SerializeAddon（带完整 ANSI 转义、RGB 真彩与格式）
    let terminalBuffer = '';
    if (s.terminalManager && typeof (s.terminalManager as any).serializeTerminal === 'function') {
      const serialized = (s.terminalManager as any).serializeTerminal();
      if (typeof serialized === 'string') {
        terminalBuffer = serialized;
      }
    }

    // SerializeAddon 未激活或未输出时，降级用文本缓冲区提取兜底
    if (!terminalBuffer && s.terminalManager?.terminalInstance?.value) {
      const term = s.terminalManager.terminalInstance.value;
      const buffer = term.buffer.active;
      // 全屏 TUI 正在使用备用屏：界面文字没有保存价值，
      // 存下来反而会让刷新后的终端变成一块静态 UI，退出 TUI 时还会留下一片黑。
      if (buffer.type !== 'alternate') {
        let lastNonEmptyLineIndex = -1;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const line = buffer.getLine(i);
          if (line && line.translateToString(true).trim() !== '') {
            lastNonEmptyLineIndex = i;
            break;
          }
        }
        if (lastNonEmptyLineIndex !== -1) {
          let result = '';
          for (let i = 0; i <= lastNonEmptyLineIndex; i++) {
            const line = buffer.getLine(i);
            if (!line) continue;
            const nextLine = i < lastNonEmptyLineIndex ? buffer.getLine(i + 1) : null;
            const isNextWrapped = nextLine ? nextLine.isWrapped : false;
            if (isNextWrapped) {
              result += line.translateToString(false);
            } else {
              result += line.translateToString(true);
              if (i < lastNonEmptyLineIndex) {
                result += '\r\n';
              }
            }
          }
          terminalBuffer = result;
        }
      }
    }

    const isAlternateScreen = s.terminalManager?.terminalInstance?.value?.buffer?.active?.type === 'alternate';

    if (terminalBuffer && !isAlternateScreen) {
      // 主屏采集成功时刷新兜底缓存，供后续进入全屏 TUI 备用屏时保留进入前的历史
      (s as any).lastTerminalBuffer = terminalBuffer;
    } else if (!terminalBuffer && (s as any).lastTerminalBuffer) {
      // 处于全屏 TUI 备用屏（如 btop/vim）或终端尚未就绪时，回退保留最近一次主屏历史，
      // 避免写成空串 '' 在降级恢复时被误判为「主动清屏」
      terminalBuffer = (s as any).lastTerminalBuffer;
    }

    // 多终端分屏各 pane 独立序列化 buffer
    //
    // primaryPaneId 可能是 ref，也可能已被 Vue 的 reactive 解包成普通字符串，
    // 两种形态都要兼容（只写 .value 会在解包后拿到 undefined，去重静默失效）。
    const primaryRef = (s.terminalManager as any)?.primaryPaneId;
    const primaryId: string | undefined =
      (s as any).primaryTerminalPaneId
      || (primaryRef && typeof primaryRef === 'object' ? primaryRef.value : primaryRef)
      || undefined;
    const paneOrder = layoutStore.getSessionTerminalPaneOrder(sId);
    // 主终端在字典里的稳定键（pane#0 之类）；顺序表里没有就退回原始 paneId
    const orderIndex = primaryId !== undefined ? paneOrder.indexOf(primaryId) : -1;
    const primaryPaneKey =
      primaryId !== undefined ? (orderIndex >= 0 ? `pane#${orderIndex}` : primaryId) : undefined;

    let terminalPanesBuffer: Record<string, string> | undefined = undefined;
    if (s.terminalManager && typeof (s.terminalManager as any).serializeAllPanes === 'function') {
      // 规整（换稳定键 + 摘掉主终端，主终端内容由 terminalBuffer 单独承载）
      terminalPanesBuffer = normalizePaneBuffers(
        (s.terminalManager as any).serializeAllPanes(),
        paneOrder,
        primaryId
      );
    }
    if (!terminalPanesBuffer && (s as any).lastTerminalPanesBuffer) {
      // 兜底值可能来自升级前的版本，那时字典里还带着主终端，按稳定键再摘一次
      terminalPanesBuffer = stripPrimaryPaneBuffer(
        (s as any).lastTerminalPanesBuffer,
        primaryPaneKey
      );
    }
    // 只剩主终端时清掉兜底缓存，否则下次采集又会把含主终端的旧字典捡回来
    (s as any).lastTerminalPanesBuffer = terminalPanesBuffer;

    // 会话自身独立的编辑器标签页（shareFileEditorTabs=false 时）
    let sessionSpecificTabs: SyncedFileTabInfo[] | undefined = undefined;
    if (s.editorTabs?.value && Array.isArray(s.editorTabs.value) && s.editorTabs.value.length > 0) {
      sessionSpecificTabs = s.editorTabs.value.map((tab) => ({
        id: tab.id,
        sessionId: tab.sessionId || sId,
        filePath: tab.filePath,
        filename: tab.filename,
        content: tab.content,
        rawContentBase64: tab.rawContentBase64 || null,
        isModified: tab.isModified,
        language: tab.language,
        selectedEncoding: tab.selectedEncoding,
        scrollTop: tab.scrollTop || 0,
        scrollLeft: tab.scrollLeft || 0,
      }));
    }

    const matchedConn = connectionsStore.connections.find(
      (c) => String(c.id) === String(s.connectionId)
    );
    sessionsList.push({
      sessionId: sId,
      connectionId: s.connectionId,
      connectionName: s.connectionName,
      connectionUuid: matchedConn?.uuid,
      commandInputContent: s.commandInputContent.value || '',
      suspendSessionId: (s as any).suspendSessionId,
      terminalBuffer: terminalBuffer !== undefined ? terminalBuffer : '',
      terminalPanesBuffer,
      primaryTerminalPaneId:
        (s as any).primaryTerminalPaneId || s.terminalManager?.primaryPaneId?.value || undefined,
      focusedTerminalPaneId: s.focusedTerminalPaneId || undefined,
      editorTabs: sessionSpecificTabs,
      activeEditorTabId: s.activeEditorTabId?.value || null,
    });
  });

  // 2. 收集全局编辑器标签（共享模式及全局数据池）
  const editorTabsList: SyncedFileTabInfo[] = fileEditorStore.orderedTabs.map((tab) => ({
    id: tab.id,
    sessionId: tab.sessionId,
    filePath: tab.filePath,
    filename: tab.filename,
    content: tab.content,
    rawContentBase64: tab.rawContentBase64 || null,
    isModified: tab.isModified,
    language: tab.language,
    selectedEncoding: tab.selectedEncoding,
    scrollTop: tab.scrollTop || 0,
    scrollLeft: tab.scrollLeft || 0,
  }));

  // 3. 收集所有会话的所有文件管理器实例
  //
  // 无终端会话的实例不收集：它不会随快照恢复（会话本身就不进快照），
  // 留在字典里只会变成恢复时找不到宿主的孤儿条目。
  const allFileManagers: Record<string, SyncedFileManagerInstanceState> = {};
  sessionStore.sessions.forEach((s, sId) => {
    if (isHeadlessSession(s)) return;
    if (s.sftpManagers) {
      s.sftpManagers.forEach((mgr, instId) => {
        const key = `${sId}:${instId}`;
        const cached = deps.fileManagerInstances[key] || ({} as SyncedFileManagerInstanceState);
        const realPath =
          mgr.currentPath?.value && isValidFileManagerSyncPath(mgr.currentPath.value)
            ? mgr.currentPath.value
            : cached.currentPath && isValidFileManagerSyncPath(cached.currentPath)
              ? cached.currentPath
              : '';
        allFileManagers[key] = {
          sessionId: sId,
          instanceId: instId,
          currentPath: realPath,
          isSearchActive: cached.isSearchActive || false,
          searchQuery: cached.searchQuery || '',
          scrollTop: cached.scrollTop || 0,
          scrollRatio: typeof cached.scrollRatio === 'number' ? cached.scrollRatio : 0,
        };
      });
    }
  });

  // 确定主文件管理器兼容路径
  let realFmPath = deps.fileManagerState.currentPath;
  const currentActiveSession = sessionStore.activeSessionId
    ? sessionStore.sessions.get(sessionStore.activeSessionId)
    : null;
  if (currentActiveSession?.sftpManagers) {
    for (const mgr of currentActiveSession.sftpManagers.values()) {
      const p = mgr.currentPath?.value;
      if (p && isValidFileManagerSyncPath(p)) {
        realFmPath = p;
        break;
      }
    }
  }

  /**
   * 快照里的"当前活动会话"必须是快照里真实存在的那个。
   *
   * 远程桌面会话不进快照，如果它恰好是当前标签，直接写它的 id 会让恢复时
   * 所有会话都判定为"非目标"（shouldActivate=false），恢复完一个焦点都没有。
   */
  const activeSessionSnapshotId =
    sessionStore.activeSessionId && !isRemoteSession(sessionStore.sessions.get(sessionStore.activeSessionId))
      ? sessionStore.activeSessionId
      : (sortedSessionIds[0] ?? null);

  return {
    syncEnabled: deps.syncEnabled,
    activeSessionId: activeSessionSnapshotId,
    sessions: sessionsList,
    sessionOrder: sortedSessionIds,
    layout: {
      layoutTree: layoutStore.layoutTree ? JSON.parse(JSON.stringify(layoutStore.layoutTree)) : null,
      sidebarPanes: layoutStore.sidebarPanes
        ? JSON.parse(JSON.stringify(layoutStore.sidebarPanes))
        : undefined,
    },
    fileEditor: {
      isOpen: fileEditorStore.isPopupOpen,
      activeTabId: fileEditorStore.activeTabId,
      tabs: editorTabsList,
    },
    fileManager: {
      ...deps.fileManagerState,
      currentPath: realFmPath,
    },
    fileManagers: allFileManagers,
    multiLineCommandInput: { ...deps.multiLineCommandState },
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
