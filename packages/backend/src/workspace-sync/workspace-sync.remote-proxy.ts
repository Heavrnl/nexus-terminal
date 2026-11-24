import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { isDesktopRuntime } from '../auth/desktop-bootstrap';
import { getDataDir } from '../services/storage-path.service';
import { settingsRepository } from '../settings/settings.repository';
import { assertSafeSyncOutboundUrl } from '../sync/outbound-url';
import * as workspaceSyncRepo from './workspace-sync.repository';
import { workspaceSyncService, WorkspaceSyncStatePayload } from './workspace-sync.service';
import { alignWorkspaceOwnerIdFromCloud } from '../remote-agent/owner-namespace.service';
import { broadcastFrontendEvent } from '../websocket/frontend-events';

export type WorkspaceSyncRuntimeMode =
  | 'web_cloud'
  | 'desktop_cloud_synced'
  | 'desktop_cloud_offline'
  | 'desktop_local_only';

export interface CloudSyncTarget {
  vpsUrl: string;
  apiKey: string;
}

const CLOUD_PROXY_TIMEOUT_MS = 6500;

/**
 * 桌面端工作区同步代理层（运行于本机 Node.js Sidecar 内）：
 * 1. 已配置云端同步且开启桌面端工作区同步时，将前端对本机 `/api/v1/workspace-sync/*` 的请求
 *    透明代理到云端 VPS（附带 X-Sync-API-Key，绝不向前端泄露明文密钥）；
 * 2. 每次成功从云端读写快照时，在本地 SQLite `workspace_sync` 表落一份离线兜底缓存，并自动对齐 `workspaceOwnerId`；
 * 3. 若云端 VPS 临时不可达（断网/维护），静默切入「本地离线态」继续提供本地工作区读写（不阻塞局域网直连）；
 * 4. 当 `/ws/sync` 恢复连通后，自动与云端比对租约：未换主则静默续传，已被他端接管则推送温和冲突事件给前端。
 */
class WorkspaceSyncRemoteProxy {
  private isCloudOffline = false;
  private hasOfflineDirtyChanges = false;
  private lastKnownLocalClientId: string | null = null;
  private lastKnownCloudOwnerClientId: string | null = null;

  public setLocalClientId(clientId: string): void {
    if (clientId && clientId.trim()) {
      this.lastKnownLocalClientId = clientId.trim();
    }
  }

  public getLocalClientId(): string | null {
    return this.lastKnownLocalClientId;
  }

  public async getCloudSyncTarget(): Promise<CloudSyncTarget | null> {
    if (!isDesktopRuntime()) return null;

    let vpsUrl = '';
    let apiKey = '';

    try {
      const cfgRaw = await settingsRepository.getSetting('desktop_sync_config');
      if (cfgRaw) {
        const parsed = JSON.parse(cfgRaw);
        vpsUrl = String(parsed.vpsUrl || '').trim();
        apiKey = String(parsed.apiKey || '').trim();
      }
    } catch {}

    if (!vpsUrl || !apiKey) {
      try {
        const jsonPath = path.join(getDataDir(), 'desktop-settings.json');
        if (fs.existsSync(jsonPath)) {
          const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          if (parsed.syncVpsUrl && parsed.syncApiKey) {
            vpsUrl = String(parsed.syncVpsUrl).trim();
            apiKey = String(parsed.syncApiKey).trim();
          }
        }
      } catch {}
    }

    if (!vpsUrl) vpsUrl = (process.env.SYNC_VPS_URL || '').trim();
    if (!apiKey) apiKey = (process.env.SYNC_API_KEY || '').trim();

    if (!vpsUrl || !apiKey) return null;

    try {
      let candidate = vpsUrl;
      if (!/^https?:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
      }
      const parsed = assertSafeSyncOutboundUrl(candidate);
      const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
      return { vpsUrl: base, apiKey };
    } catch {
      return null;
    }
  }

  public async getRuntimeMode(): Promise<{
    mode: WorkspaceSyncRuntimeMode;
    cloudConfigured: boolean;
    offlineMode: boolean;
    hasOfflineDirtyChanges: boolean;
  }> {
    if (!isDesktopRuntime()) {
      return {
        mode: 'web_cloud',
        cloudConfigured: false,
        offlineMode: false,
        hasOfflineDirtyChanges: false,
      };
    }
    const target = await this.getCloudSyncTarget();
    if (!target) {
      return {
        mode: 'desktop_local_only',
        cloudConfigured: false,
        offlineMode: false,
        hasOfflineDirtyChanges: false,
      };
    }
    return {
      mode: this.isCloudOffline ? 'desktop_cloud_offline' : 'desktop_cloud_synced',
      cloudConfigured: true,
      offlineMode: this.isCloudOffline,
      hasOfflineDirtyChanges: this.hasOfflineDirtyChanges,
    };
  }

  private buildHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
    return {
      'x-sync-api-key': apiKey,
      'x-api-key': apiKey,
      ...(extra || {}),
    };
  }

  private markOnline(): void {
    if (this.isCloudOffline) {
      this.isCloudOffline = false;
      broadcastFrontendEvent({
        type: 'workspace:mode_changed',
        payload: { mode: 'desktop_cloud_synced', offlineMode: false },
      });
    }
  }

  private markOffline(reason?: string): void {
    if (!this.isCloudOffline) {
      this.isCloudOffline = true;
      console.warn(`[WorkspaceSyncProxy] 云端 VPS 不可达，静默切换至本地离线缓存态: ${reason || 'network error'}`);
      broadcastFrontendEvent({
        type: 'workspace:mode_changed',
        payload: { mode: 'desktop_cloud_offline', offlineMode: true, reason },
      });
    }
  }

  /** 获取工作区状态（桌面端优先读云端并缓存到本地，断网自动回退本地缓存） */
  public async getState(userId: number): Promise<{
    state: WorkspaceSyncStatePayload | null;
    activeClientId: string | null;
    updatedAt: number | null;
    workspaceOwnerId?: string;
    offlineMode?: boolean;
    syncSource?: WorkspaceSyncRuntimeMode;
  }> {
    const target = await this.getCloudSyncTarget();
    if (!target) {
      const local = await workspaceSyncService.getState(userId);
      return { ...local, offlineMode: false, syncSource: isDesktopRuntime() ? 'desktop_local_only' : 'web_cloud' };
    }

    try {
      const resp = await axios.get(`${target.vpsUrl}/api/v1/workspace-sync`, {
        headers: this.buildHeaders(target.apiKey),
        timeout: CLOUD_PROXY_TIMEOUT_MS,
      });
      if (resp.data?.success && resp.data?.data) {
        this.markOnline();
        const cloudData = resp.data.data;
        if (typeof cloudData.workspaceOwnerId === 'string' && cloudData.workspaceOwnerId.trim()) {
          await alignWorkspaceOwnerIdFromCloud(cloudData.workspaceOwnerId).catch(() => {});
        }
        this.lastKnownCloudOwnerClientId = cloudData.activeClientId || null;
        // 同步刷新本地离线兜底缓存
        if (cloudData.state) {
          await workspaceSyncRepo
            .saveWorkspaceSyncRecord(userId, JSON.stringify(cloudData.state), cloudData.activeClientId || 'cloud')
            .catch(() => {});
        }
        return {
          state: cloudData.state ?? null,
          activeClientId: cloudData.activeClientId ?? null,
          updatedAt: cloudData.updatedAt ?? null,
          workspaceOwnerId: cloudData.workspaceOwnerId,
          offlineMode: false,
          syncSource: 'desktop_cloud_synced',
        };
      }
      throw new Error(resp.data?.message || '云端返回非预期响应');
    } catch (err: any) {
      this.markOffline(err?.message);
      const local = await workspaceSyncService.getState(userId);
      return {
        ...local,
        offlineMode: true,
        syncSource: 'desktop_cloud_offline',
      };
    }
  }

  /** 声明接管租约（转发云端并同步对齐本地缓存与 ownerNamespace） */
  public async claimLease(
    userId: number,
    clientId: string
  ): Promise<{ activeClientId: string; workspaceOwnerId?: string; offlineMode: boolean }> {
    this.setLocalClientId(clientId);
    const target = await this.getCloudSyncTarget();
    if (!target) {
      await workspaceSyncService.claimLease(userId, clientId);
      return { activeClientId: clientId, offlineMode: false };
    }

    try {
      const resp = await axios.post(
        `${target.vpsUrl}/api/v1/workspace-sync/claim`,
        { clientId },
        {
          headers: this.buildHeaders(target.apiKey, { 'Content-Type': 'application/json' }),
          timeout: CLOUD_PROXY_TIMEOUT_MS,
        }
      );
      if (resp.data?.success) {
        this.markOnline();
        this.hasOfflineDirtyChanges = false;
        this.lastKnownCloudOwnerClientId = clientId;
        const cloudOwnerId = resp.data?.data?.workspaceOwnerId;
        if (typeof cloudOwnerId === 'string' && cloudOwnerId.trim()) {
          await alignWorkspaceOwnerIdFromCloud(cloudOwnerId).catch(() => {});
        }
        await workspaceSyncRepo.claimWorkspaceLease(userId, clientId).catch(() => {});
        return { activeClientId: clientId, workspaceOwnerId: cloudOwnerId, offlineMode: false };
      }
      throw new Error(resp.data?.message || '云端接管租约失败');
    } catch (err: any) {
      this.markOffline(err?.message);
      await workspaceSyncService.claimLease(userId, clientId).catch(() => {});
      return { activeClientId: clientId, offlineMode: true };
    }
  }

  /** 保存工作区快照（本地落缓存 + 透传云端；若被云端拒绝则返回 accepted=false 让前端进入遮罩） */
  public async saveState(
    userId: number,
    clientId: string,
    state: WorkspaceSyncStatePayload,
    saveSeq?: number
  ): Promise<{ accepted: boolean; activeClientId: string | null; staleIgnored?: boolean; offlineMode: boolean }> {
    this.setLocalClientId(clientId);
    const target = await this.getCloudSyncTarget();
    if (!target) {
      const localRes = await workspaceSyncService.saveState(userId, clientId, state, saveSeq);
      return { ...localRes, offlineMode: false };
    }

    try {
      const resp = await axios.post(
        `${target.vpsUrl}/api/v1/workspace-sync/save`,
        { clientId, saveSeq, state },
        {
          headers: this.buildHeaders(target.apiKey, { 'Content-Type': 'application/json' }),
          timeout: CLOUD_PROXY_TIMEOUT_MS,
        }
      );
      if (resp.data?.success && resp.data?.data) {
        this.markOnline();
        const data = resp.data.data;
        if (data.accepted !== false) {
          this.hasOfflineDirtyChanges = false;
          this.lastKnownCloudOwnerClientId = clientId;
          // 云端接受后再同步刷新本地离线缓存
          await workspaceSyncRepo
            .saveWorkspaceSyncRecord(userId, JSON.stringify(state), clientId)
            .catch(() => {});
        } else {
          this.lastKnownCloudOwnerClientId = data.activeClientId || null;
        }
        return {
          accepted: data.accepted !== false,
          activeClientId: data.activeClientId ?? null,
          staleIgnored: data.staleIgnored === true,
          offlineMode: false,
        };
      }
      throw new Error(resp.data?.message || '云端保存快照失败');
    } catch (err: any) {
      this.markOffline(err?.message);
      this.hasOfflineDirtyChanges = true;
      // 离线态继续落本地 SQLite，确保重启桌面端不丢当前本地改动
      await workspaceSyncRepo
        .saveWorkspaceSyncRecord(userId, JSON.stringify(state), clientId)
        .catch(() => {});
      return { accepted: true, activeClientId: clientId, offlineMode: true };
    }
  }

  /** 彻底销毁指定会话（先杀本机 SSH/目标机 PTY，再同步从云端快照剔除） */
  public async destroySession(
    userId: number,
    sessionId: string,
    clientId?: string
  ): Promise<{ success: boolean; accepted?: boolean; activeClientId?: string | null; remainingSessionsCount: number; offlineMode: boolean }> {
    if (clientId) this.setLocalClientId(clientId);
    const target = await this.getCloudSyncTarget();
    // 1. 无论是否配置云端，本机持有的该会话必须立即 KILL 销毁并从本地缓存剔除
    const localRes = await workspaceSyncService.destroySessionCompletely(userId, sessionId, clientId);
    if (!target) {
      return { ...localRes, offlineMode: false };
    }

    try {
      const resp = await axios.delete(
        `${target.vpsUrl}/api/v1/workspace-sync/sessions/${encodeURIComponent(sessionId)}`,
        {
          headers: this.buildHeaders(target.apiKey, clientId ? { 'x-workspace-client-id': clientId } : undefined),
          timeout: CLOUD_PROXY_TIMEOUT_MS,
          validateStatus: (s) => s < 500,
        }
      );
      this.markOnline();
      if (resp.status === 409) {
        return {
          success: false,
          accepted: false,
          activeClientId: resp.data?.data?.activeClientId ?? null,
          remainingSessionsCount: resp.data?.data?.remainingSessionsCount ?? localRes.remainingSessionsCount,
          offlineMode: false,
        };
      }
      return {
        success: Boolean(resp.data?.success),
        accepted: resp.data?.data?.accepted !== false,
        activeClientId: resp.data?.data?.activeClientId ?? clientId ?? null,
        remainingSessionsCount: resp.data?.data?.remainingSessionsCount ?? localRes.remainingSessionsCount,
        offlineMode: false,
      };
    } catch (err: any) {
      this.markOffline(err?.message);
      this.hasOfflineDirtyChanges = true;
      return { ...localRes, offlineMode: true };
    }
  }

  /**
   * 当桌面端 /ws/sync 从断网恢复重连到云端时自动触发租约比对：
   * - 若离线期间没有其他端接管（云端租约仍归本端或为空），静默通知前端续传离线期间的脏改动；
   * - 若离线期间已被另一设备接管，向桌面端前端推送温和冲突事件，由用户选择「拉取云端最新」或「以当前覆盖接管」。
   */
  public async reconcileAfterCloudReconnect(): Promise<void> {
    if (!isDesktopRuntime()) return;
    const wasOffline = this.isCloudOffline || this.hasOfflineDirtyChanges;
    const target = await this.getCloudSyncTarget();
    if (!target) return;

    try {
      const resp = await axios.get(`${target.vpsUrl}/api/v1/workspace-sync`, {
        headers: this.buildHeaders(target.apiKey),
        timeout: CLOUD_PROXY_TIMEOUT_MS,
      });
      if (!resp.data?.success || !resp.data?.data) return;
      this.markOnline();

      const cloudData = resp.data.data;
      if (typeof cloudData.workspaceOwnerId === 'string' && cloudData.workspaceOwnerId.trim()) {
        await alignWorkspaceOwnerIdFromCloud(cloudData.workspaceOwnerId).catch(() => {});
      }

      const cloudOwner: string | null = cloudData.activeClientId || null;
      const localCid = this.lastKnownLocalClientId;

      if (!wasOffline) {
        this.lastKnownCloudOwnerClientId = cloudOwner;
        return;
      }

      if (localCid && cloudOwner && cloudOwner !== localCid) {
        console.log(
          `[WorkspaceSyncProxy] 云端恢复连通：检测到离线期间工作区已被 ${cloudOwner} 接管，推送温和冲突选择弹窗给前端。`
        );
        broadcastFrontendEvent({
          type: 'workspace:offline_conflict',
          payload: {
            cloudActiveClientId: cloudOwner,
            cloudUpdatedAt: cloudData.updatedAt || null,
            localClientId: localCid,
            hasOfflineDirtyChanges: this.hasOfflineDirtyChanges,
          },
        });
      } else {
        console.log('[WorkspaceSyncProxy] 云端恢复连通且租约未被他端占用，通知前端静默续传本地最新状态。');
        broadcastFrontendEvent({
          type: 'workspace:cloud_reconnected',
          payload: {
            shouldFlushSave: this.hasOfflineDirtyChanges,
            activeClientId: cloudOwner || localCid,
          },
        });
      }
      this.lastKnownCloudOwnerClientId = cloudOwner;
    } catch (err: any) {
      this.markOffline(err?.message);
    }
  }
}

export const workspaceSyncRemoteProxy = new WorkspaceSyncRemoteProxy();
