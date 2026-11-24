import { v4 as uuidv4 } from 'uuid';
import { settingsRepository } from '../settings/settings.repository';
import { deriveOwnerNamespace } from './probe.pure';

const WORKSPACE_OWNER_ID_KEY = 'workspaceOwnerId';

export { deriveOwnerNamespace };

/**
 * 获取或首次生成本实例的持久化 workspaceOwnerId，并返回派生后的 ownerNamespace。
 */
export async function getOrCreateOwnerNamespace(): Promise<{
  workspaceOwnerId: string;
  ownerNamespace: string;
}> {
  let ownerId = await settingsRepository.getSetting(WORKSPACE_OWNER_ID_KEY);
  if (!ownerId || !ownerId.trim()) {
    ownerId = uuidv4();
    try {
      await settingsRepository.setSetting(WORKSPACE_OWNER_ID_KEY, ownerId);
    } catch (err: any) {
      console.warn('[OwnerNamespace] 持久化 workspaceOwnerId 失败:', err?.message || err);
    }
  }
  const clean = ownerId.trim();
  return {
    workspaceOwnerId: clean,
    ownerNamespace: deriveOwnerNamespace(clean),
  };
}

/**
 * 当桌面端从云端同步/握手获取到云端的 workspaceOwnerId 时，覆盖对齐本机标识，
 * 确保桌面端与云端 Web 端在目标机上共享完全一致的命名空间。
 */
export async function alignWorkspaceOwnerIdFromCloud(cloudOwnerId: string): Promise<void> {
  const clean = (cloudOwnerId || '').trim();
  if (!clean) return;
  const current = await settingsRepository.getSetting(WORKSPACE_OWNER_ID_KEY);
  if (current?.trim() === clean) return;
  await settingsRepository.setSetting(WORKSPACE_OWNER_ID_KEY, clean);
  console.log('[OwnerNamespace] 已与云端对齐 workspaceOwnerId，跨端目标机会话命名空间已统一。');
}
