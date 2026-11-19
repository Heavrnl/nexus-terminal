import { useSessionStore } from '../session.store';
import { useLayoutStore } from '../layout.store';
import { useConnectionsStore } from '../connections.store';
import { useTerminalHighlightStore } from '../terminal-highlight.store';
import { getLocalStorageSafe, recordSessionIdAlias as recordAlias } from '../../utils/pendingRemoval';
import { cleanTrailingPromptForReconnect } from './terminalBuffer';
import { logSync, logSyncWarn } from './log';
import type { WorkspaceSnapshot } from './types';

/**
 * 从快照恢复会话列表并建立「旧 sessionId -> 新 sessionId」映射。
 *
 * 这是整个恢复流程里最绕的一段，几个必须保持的行为：
 *
 * 1. **连接匹配是三级降级**：uuid（跨端权威）→ 连接名（跨端对齐）→ 整数主键（同库兜底）。
 *    两端的本地自增 id 不同，只认 id 会把会话挂到错误的连接上。
 * 2. **挂起会话优先消费**：服务端还留着 SSH 连接时直接唤醒（保留进程状态），
 *    唤醒成功就**不要**再回放 buffer —— 后端会通过 logData 自己回放，重复写会叠两层。
 *    但「手动挂起」（关标签产生的，`manuallySuspended`）永远不参与恢复，
 *    它们只属于挂起面板，必须由用户手动恢复。
 * 3. **并发恢复但保持快照顺序**：`Promise.all` 只影响耗时，不影响 sessionOrder。
 * 4. **primaryTerminalPaneId 只记录不写入 manager**：会话树的 paneId 每次刷新都重新生成，
 *    写进 manager 会锁定一个不存在的分屏通道，命令直接发不出去。
 */
export interface RestoreSessionsDeps {
  snapshot: WorkspaceSnapshot;
  /**
   * 阶段 2 拉到的挂起会话池。**其中可自动认领的部分会被就地消费（splice）**，
   * 所以必须传同一个数组引用，否则后续会话会重复认领同一个挂起会话。
   * `manuallySuspended` 的条目会被跳过且不动，留在面板里。
   */
  availableSuspended: any[];
}

export async function restoreSessionsFromSnapshot(
  deps: RestoreSessionsDeps
): Promise<Map<string, string>> {
  const sessionStore = useSessionStore();
  const layoutStore = useLayoutStore();
  const connectionsStore = useConnectionsStore();
  const highlightStore = useTerminalHighlightStore();

  const { snapshot, availableSuspended } = deps;
  const sessionIdMap = new Map<string, string>();
  /** 并发兜底认领本地已有会话时的同步占位集，防止两个并发任务抢到同一个会话 */
  const claimedExistingIds = new Set<string>();

  if (!snapshot.sessions || snapshot.sessions.length === 0) {
    return sessionIdMap;
  }

  /**
   * 手动挂起的会话（用户主动关掉的标签）不参与工作区恢复。
   *
   * 这是「挂起功能」和「工作区实时同步」的分界线：
   * 刷新手动关掉的标签，它只应该躺在挂起面板里等你手动恢复，
   * 绝不能被恢复流程顺手认领回来 —— 否则关标签等于没关。
   *
   * 自动挂起的（刷新 / 被其它客户端接管时后端保活下来的）仍然是 true 的相反面，
   * 照旧在这里被认领，刷新后标签原样回来。
   */
  const autoClaimableSuspended = (availableSuspended || []).filter(
    // 只有后端仍在保活的（hanging）才认领得动。
    // `disconnected_by_backend` 的条目 resume 一定失败，而认领后失败会把刚恢复出来的
    // 标签连带关掉（resume 失败的会话会被前端回收）—— 所以宁可不认领，退回新建连接。
    (item) => !item?.manuallySuspended && item?.backendSshStatus === 'hanging'
  );
  const manualSuspendedCount = (availableSuspended || []).filter(
    (item) => !!item?.manuallySuspended
  ).length;
  const deadSuspendedCount =
    (availableSuspended?.length || 0) - autoClaimableSuspended.length - manualSuspendedCount;
  if (manualSuspendedCount > 0) {
    logSync(
      `跳过 ${manualSuspendedCount} 个手动挂起的会话（关标签产生的），它们只在挂起面板里等手动恢复`
    );
  }
  if (deadSuspendedCount > 0) {
    logSync(
      `跳过 ${deadSuspendedCount} 个后端已断开（disconnected_by_backend）的挂起条目，这些走新建连接恢复`
    );
  }

  // 预先识别云端选中的目标激活会话（未记录则默认第 0 个）
  const targetActiveSessionSnapshotId = snapshot.activeSessionId || snapshot.sessions[0]?.sessionId;

  /**
   * 「这条快照记录本身就是那条被关掉的标签」吗？
   *
   * 判据是 `originalSessionId`：手动挂起条目记着它挂起前的会话 ID，
   * 而快照里那条陈旧记录用的正是同一个 ID —— 命中就说明快照还留着"已经关掉的那张标签"，
   * 这种情况下绝不能恢复（否则关标签等于没关）。
   *
   * 注意**不能只看连接**：用户关掉标签后完全可能重新点开同一个连接（新会话、新 ID），
   * 那个标签是活的，该恢复；按连接一刀切会把正常标签也弄丢。
   */
  const manualSuspendedOriginalIds = new Set<string>();
  const manualSuspendedIds = new Set<string>();
  for (const item of availableSuspended || []) {
    if (!item?.manuallySuspended) continue;
    if (item.originalSessionId) manualSuspendedOriginalIds.add(String(item.originalSessionId));
    if (item.suspendSessionId) manualSuspendedIds.add(String(item.suspendSessionId));
  }
  const isSnapshotEntryManuallySuspended = (s: WorkspaceSnapshot['sessions'][number]) => {
    if (manualSuspendedOriginalIds.size === 0 && manualSuspendedIds.size === 0) return false;
    if (s.sessionId && manualSuspendedOriginalIds.has(String(s.sessionId))) return true;
    return !!s.suspendSessionId && manualSuspendedIds.has(String(s.suspendSessionId));
  };

  // 先同步匹配消费池，为并发恢复做预先规划
  const restorePlans = snapshot.sessions.map((s) => {
    // 多维三级匹配：1. UUID 跨库唯一标识 -> 2. 主机名称（跨端对齐）-> 3. 整数主键 ID（同库兜底）
    let connInfo = undefined;
    if (s.connectionUuid) {
      connInfo = connectionsStore.connections.find((c) => c.uuid && c.uuid === s.connectionUuid);
    }
    if (!connInfo && s.connectionName) {
      connInfo = connectionsStore.connections.find(
        (c) => c.name && c.name.trim().toLowerCase() === s.connectionName.trim().toLowerCase()
      );
    }
    if (!connInfo && s.connectionId !== undefined && s.connectionId !== null) {
      const connIdNum = Number(s.connectionId);
      connInfo = connectionsStore.connections.find((c) => c.id === connIdNum);
    }

    let matchedIdx = autoClaimableSuspended.findIndex(
      (item) => item.originalSessionId && item.originalSessionId === s.sessionId
    );

    if (matchedIdx === -1 && s.suspendSessionId) {
      matchedIdx = autoClaimableSuspended.findIndex(
        (item) => item.suspendSessionId === s.suspendSessionId
      );
    }

    if (matchedIdx === -1) {
      matchedIdx = autoClaimableSuspended.findIndex(
        (item) =>
          String(item.connectionId) === String(s.connectionId) ||
          item.connectionName === s.connectionName
      );
    }

    let matchedSuspended: any = undefined;
    if (matchedIdx !== -1) {
      matchedSuspended = autoClaimableSuspended[matchedIdx];
      autoClaimableSuspended.splice(matchedIdx, 1);
    }

    return {
      snapshotSession: s,
      connInfo,
      matchedSuspended,
      isTargetActive: s.sessionId === targetActiveSessionSnapshotId,
      // 这条快照记录就是用户关掉的那张标签（已手动挂起）→ 不恢复，交给挂起面板
      blockedByManualSuspend: !matchedSuspended && isSnapshotEntryManuallySuspended(s),
    };
  });

  // 严格保持快照中会话从左到右的原始顺序；并行恢复只为缩短耗时
  // 目标会话传 shouldActivate: true（第 0 毫秒聚焦），后台会话 false（静默加载）
  logSync(
    `开始全量并发恢复 ${restorePlans.length} 个会话（保持原始顺序），目标激活会话即时聚焦，其余会话静默后台加载...`
  );

  await Promise.all(
    restorePlans.map(async (plan) => {
      const s = plan.snapshotSession;
      let targetSessionId: string | null = null;
      let isResumed = false;
      const shouldActivateThis = plan.isTargetActive;

      // 这条快照记录就是用户关掉的那张标签（已手动挂起），标签归挂起面板管
      if (plan.blockedByManualSuspend) {
        logSync(
          `快照里的会话 ${s.sessionId} (${s.connectionName || s.connectionId}) 已手动挂起，跳过这次标签恢复（等用户在挂起面板手动恢复）`
        );
        return;
      }

      if (plan.matchedSuspended) {
        logSync(
          `发现匹配的挂起会话，正在并发唤醒接管: ${plan.matchedSuspended.suspendSessionId} (${plan.matchedSuspended.connectionName}, isTargetActive=${shouldActivateThis})`
        );
        try {
          targetSessionId = await sessionStore.resumeSshSession(
            plan.matchedSuspended.suspendSessionId,
            shouldActivateThis
          );
          if (targetSessionId) {
            isResumed = true;
            logSync(`挂起会话已并发唤醒，新会话 ID: ${targetSessionId}，由服务端接管回放`);
          }
        } catch (err) {
          logSyncWarn(`恢复挂起会话失败，降级为并发新建会话:`, err);
        }
      }

      // 无挂起或恢复失败：并发新建会话（用本地查到的有效主键 ID）
      if (!targetSessionId && plan.connInfo) {
        logSync(
          `重新开启连接会话 (并发): ${plan.connInfo.name || plan.connInfo.host} (本地连接 ID: ${plan.connInfo.id}, 快照原 ID: ${s.connectionId}, isTargetActive=${shouldActivateThis})`
        );
        targetSessionId =
          sessionStore.openNewSession(plan.connInfo.id, undefined, shouldActivateThis) || null;
      }

      // 仍无目标：看本地是否已有属于该连接且未被映射/未被占用的会话兜底
      if (!targetSessionId) {
        const matchedExisting = Array.from(sessionStore.sessions.values()).find(
          (existingSession) => {
            if (claimedExistingIds.has(existingSession.sessionId)) return false;
            if (Array.from(sessionIdMap.values()).includes(existingSession.sessionId)) return false;
            if (plan.connInfo && String(existingSession.connectionId) === String(plan.connInfo.id))
              return true;
            if (s.connectionName && existingSession.connectionName === s.connectionName) return true;
            return String(existingSession.connectionId) === String(s.connectionId);
          }
        );
        if (matchedExisting) {
          claimedExistingIds.add(matchedExisting.sessionId);
          targetSessionId = matchedExisting.sessionId;
          if (shouldActivateThis) {
            sessionStore.activateSession(targetSessionId);
          }
        }
      }

      if (!targetSessionId) return;

      sessionIdMap.set(s.sessionId, targetSessionId);
      // 记下"新 ID -> 快照旧 ID"，关闭会话时才能把快照里那份旧记录一起剔除
      recordAlias(targetSessionId, s.sessionId, getLocalStorageSafe());
      logSync(
        `建立会话 ID 映射: 旧 ${s.sessionId} -> 新 ${targetSessionId} (激活: ${shouldActivateThis})`
      );

      // 恢复单行命令输入框内容
      if (s.commandInputContent) {
        sessionStore.updateSessionCommandInput(targetSessionId, s.commandInputContent);
      }

      // 终端屏幕历史回放：resumeSshSession 唤醒的会话由后端 logData 自动回放，不能重复写
      if (s.terminalBuffer) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).lastTerminalBuffer = s.terminalBuffer;
          if (!isResumed) {
            logSync(
              `为新连接会话 ${targetSessionId} 回放快照保存的终端屏幕历史 (字符数: ${s.terminalBuffer.length})`
            );
            const cleanedBuffer = cleanTrailingPromptForReconnect(s.terminalBuffer);

            if (sessionState.terminalManager?.terminalInstance?.value) {
              const highlightedData: string = highlightStore.highlight(cleanedBuffer) as string;
              sessionState.terminalManager.terminalInstance.value.write(highlightedData);
              try {
                sessionState.terminalManager.terminalInstance.value.refresh(
                  0,
                  sessionState.terminalManager.terminalInstance.value.rows - 1
                );
              } catch {
                /* 终端尚未布局完成时 refresh 可能抛错，忽略 */
              }
            } else {
              // 终端尚未就绪时暂存原始未高亮文本，交由 handleTerminalReady 里的 mainWriteFilter 统一单次高亮，避免双重高亮
              if (!sessionState.pendingOutput) {
                sessionState.pendingOutput = [];
              }
              sessionState.pendingOutput.push(cleanedBuffer);
            }
          }
        }
      } else if (s.terminalBuffer === '') {
        // 快照记录"已清屏"：当前会话有终端实例就立刻同步清空视口
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          if (sessionState.terminalManager?.terminalInstance?.value) {
            sessionState.terminalManager.terminalInstance.value.clear();
          }
          sessionState.pendingOutput = [];
          logSync(`为会话 ${targetSessionId} 同步清空终端屏幕视口`);
        }
      }

      // 多终端分屏历史回放：写到 lastTerminalPanesBuffer，并向已挂载的副终端回放
      if (s.terminalPanesBuffer) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).lastTerminalPanesBuffer = s.terminalPanesBuffer;
          const tm = sessionState.terminalManager as any;
          if (tm?.terminalPanes?.value && !isResumed) {
            const panesMap = tm.terminalPanes.value as Map<string, any>;
            // 快照存的是 pane#0/pane#1 稳定序号，要换算成当前会话树的真实 paneId
            const order = layoutStore.getSessionTerminalPaneOrder(targetSessionId);
            Object.entries(s.terminalPanesBuffer).forEach(([key, buf]) => {
              const pId = key.startsWith('pane#') ? order[Number(key.slice(5))] : key;
              if (!pId || pId === 'primary') return;
              const paneEntry = panesMap.get(pId);
              // PaneTerminalInstance 持有的是 terminal 字段（非 instance.value）
              const paneTerminal = paneEntry?.terminal;
              if (paneTerminal && buf) {
                logSync(
                  `为分屏终端 ${pId} (会话 ${targetSessionId}) 回放快照保存的屏幕历史 (字符数: ${buf.length})`
                );
                const cleaned = cleanTrailingPromptForReconnect(buf);
                const highlighted = highlightStore.highlight(cleaned) as string;
                paneTerminal.write(highlighted);
                try {
                  paneTerminal.refresh(0, paneTerminal.rows - 1);
                } catch {
                  /* 同上 */
                }
              }
            });
          }
        }
      }

      // 恢复主终端记录（只留作参考，不要写进 manager）
      // 会话树每次刷新都会重新生成 paneId，把旧 paneId 写进 primaryPaneId
      // 会锁定一个并不存在的分屏通道，导致命令发不出去。
      // manager 会在终端就绪时按"当前布局树的先序第一个终端"自行确定。
      if (s.primaryTerminalPaneId) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).primaryTerminalPaneId = s.primaryTerminalPaneId;
        }
      }

      // 恢复"该会话上次聚焦的终端"，多终端分屏时切回来能直接落在正确的那一屏
      if (s.focusedTerminalPaneId) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          sessionState.focusedTerminalPaneId = s.focusedTerminalPaneId;
          // 布局树的焦点同步发生在会话挂载时（早于这里），所以补一次，
          // 否则 activeTerminalPaneId 会停在默认的第一个终端上。
          if (sessionStore.activeSessionId === targetSessionId) {
            layoutStore.setActiveTerminalPaneId(s.focusedTerminalPaneId);
          }
        }
      }
    })
  );

  return sessionIdMap;
}

/**
 * 恢复会话标签栏的排布顺序。
 *
 * 快照里的顺序是**旧 sessionId**，必须经映射表翻译；映射不到的（会话已不存在）丢弃。
 * 之后把本地新增的会话追加到末尾 —— 否则新开的会话会因为不在快照里而消失于标签栏。
 */
export function restoreSessionOrder(deps: {
  snapshot: WorkspaceSnapshot;
  sessionIdMap: Map<string, string>;
}): string[] {
  const sessionStore = useSessionStore();
  const { snapshot, sessionIdMap } = deps;

  const rawOrderList = snapshot.sessionOrder || snapshot.sessions?.map((s) => s.sessionId) || [];
  const restoredSessionOrder: string[] = [];
  rawOrderList.forEach((oldId) => {
    const newId = sessionIdMap.get(oldId) || (sessionStore.sessions.has(oldId) ? oldId : null);
    if (newId && !restoredSessionOrder.includes(newId)) {
      restoredSessionOrder.push(newId);
    }
  });
  sessionStore.sessions.forEach((_, sId) => {
    if (!restoredSessionOrder.includes(sId)) {
      restoredSessionOrder.push(sId);
    }
  });

  if (restoredSessionOrder.length > 0) {
    logSync('从云端快照恢复会话标签排布顺序:', restoredSessionOrder);
    sessionStore.setSessionOrder(restoredSessionOrder, false);
  }
  return restoredSessionOrder;
}

/**
 * 构造「快照旧 sessionId -> 当前 sessionId」的解析器。
 *
 * 降级顺序（每一步都可能救回一个会话）：
 *   1. 旧 id 本身还在（同一次会话内刷新）
 *   2. 映射表命中且目标仍存在
 *   3. 按 connectionId 找本地同连接的会话
 *   4. 按连接名（忽略大小写）找
 *   5. 只剩一个会话时直接用它（单会话用户的兜底）
 *   6. 退到当前激活会话
 */
export function createSessionIdResolver(deps: {
  snapshot: WorkspaceSnapshot;
  sessionIdMap: Map<string, string>;
}): (oldId?: string | null, fallbackConnId?: number | string) => string | null {
  const sessionStore = useSessionStore();
  const { snapshot, sessionIdMap } = deps;

  return (oldId?: string | null, fallbackConnId?: number | string): string | null => {
    if (oldId && sessionStore.sessions.has(oldId)) return oldId;
    if (oldId && sessionIdMap.has(oldId)) {
      const mapped = sessionIdMap.get(oldId)!;
      if (sessionStore.sessions.has(mapped)) return mapped;
    }

    // 未显式提供 fallbackConnId 时，从快照里反查 oldId 对应的 connectionId
    let targetConnId = fallbackConnId;
    if (targetConnId === undefined && oldId && snapshot.sessions) {
      const sItem = snapshot.sessions.find((s) => s.sessionId === oldId);
      if (sItem) {
        targetConnId = sItem.connectionId;
      }
    }
    if (targetConnId !== undefined) {
      const matched = Array.from(sessionStore.sessions.values()).find(
        (item) => String(item.connectionId) === String(targetConnId)
      );
      if (matched) return matched.sessionId;
    }

    if (oldId && snapshot.sessions) {
      const sItem = snapshot.sessions.find((s) => s.sessionId === oldId);
      if (sItem && sItem.connectionName) {
        const matchedByName = Array.from(sessionStore.sessions.values()).find(
          (item) =>
            item.connectionName &&
            item.connectionName.trim().toLowerCase() === sItem.connectionName.trim().toLowerCase()
        );
        if (matchedByName) return matchedByName.sessionId;
      }
    }

    if (sessionStore.sessions.size === 1) {
      return sessionStore.sessions.keys().next().value || null;
    }
    return sessionStore.activeSessionId || null;
  };
}
