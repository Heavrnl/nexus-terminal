import crypto from 'crypto';
import { getDbInstance, allDb, getDb, runDb } from '../database/connection';

export type RemoteHostedStatus = 'hanging' | 'exited' | 'unreachable';

export interface RemoteHostedSessionRecord {
  id: number;
  uuid: string;
  remote_session_id: string;
  connection_uuid: string | null;
  connection_id: number | null;
  connection_name: string;
  custom_name: string | null;
  manually_suspended: number;
  status: RemoteHostedStatus;
  exit_code: number | null;
  owner_namespace: string | null;
  created_at: number;
  updated_at: number;
  updated_hlc: string;
}

export interface UpsertRemoteHostedSessionInput {
  remoteSessionId: string;
  connectionUuid?: string | null;
  connectionId?: number | null;
  connectionName: string;
  customName?: string | null;
  manuallySuspended: boolean;
  status?: RemoteHostedStatus;
  exitCode?: number | null;
  ownerNamespace?: string | null;
}

/** 生成基于 remoteSessionId 的确定性 UUID v5，保证多端重复写入同一条托管会话时天然合并 */
export function deterministicHostedSessionUuid(remoteSessionId: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(`nexus-remote-hosted:${remoteSessionId.trim()}`, 'utf8')
    .digest('hex');
  const p1 = hash.substring(0, 8);
  const p2 = hash.substring(8, 12);
  const p3 = '5' + hash.substring(13, 16);
  const p4 =
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
    hash.substring(18, 20);
  const p5 = hash.substring(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export const remoteHostedSessionRepository = {
  async upsert(input: UpsertRemoteHostedSessionInput): Promise<RemoteHostedSessionRecord | null> {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    const uuid = deterministicHostedSessionUuid(input.remoteSessionId);
    const existing = await getDb<RemoteHostedSessionRecord>(
      db,
      `SELECT * FROM remote_hosted_sessions WHERE remote_session_id = ? LIMIT 1`,
      [input.remoteSessionId]
    );

    if (existing) {
      await runDb(
        db,
        `UPDATE remote_hosted_sessions
         SET connection_uuid = COALESCE(?, connection_uuid),
             connection_id = COALESCE(?, connection_id),
             connection_name = ?,
             custom_name = COALESCE(?, custom_name),
             manually_suspended = ?,
             status = ?,
             exit_code = ?,
             owner_namespace = COALESCE(?, owner_namespace),
             updated_at = ?
         WHERE remote_session_id = ?`,
        [
          input.connectionUuid ?? null,
          input.connectionId ?? null,
          input.connectionName,
          input.customName ?? null,
          input.manuallySuspended ? 1 : 0,
          input.status ?? existing.status ?? 'hanging',
          input.exitCode !== undefined ? input.exitCode : existing.exit_code,
          input.ownerNamespace ?? null,
          now,
          input.remoteSessionId,
        ]
      );
    } else {
      await runDb(
        db,
        `INSERT INTO remote_hosted_sessions (
           uuid, remote_session_id, connection_uuid, connection_id, connection_name,
           custom_name, manually_suspended, status, exit_code, owner_namespace,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid,
          input.remoteSessionId,
          input.connectionUuid ?? null,
          input.connectionId ?? null,
          input.connectionName,
          input.customName ?? null,
          input.manuallySuspended ? 1 : 0,
          input.status ?? 'hanging',
          input.exitCode ?? null,
          input.ownerNamespace ?? null,
          now,
          now,
        ]
      );
    }

    const row = await getDb<RemoteHostedSessionRecord>(
      db,
      `SELECT * FROM remote_hosted_sessions WHERE remote_session_id = ? LIMIT 1`,
      [input.remoteSessionId]
    );
    return row || null;
  },

  async findByRemoteSessionId(remoteSessionId: string): Promise<RemoteHostedSessionRecord | null> {
    const db = await getDbInstance();
    const row = await getDb<RemoteHostedSessionRecord>(
      db,
      `SELECT * FROM remote_hosted_sessions WHERE remote_session_id = ? LIMIT 1`,
      [remoteSessionId]
    );
    return row || null;
  },

  async listAll(): Promise<RemoteHostedSessionRecord[]> {
    const db = await getDbInstance();
    return allDb<RemoteHostedSessionRecord>(
      db,
      `SELECT * FROM remote_hosted_sessions ORDER BY updated_at DESC`
    );
  },

  async updateCustomName(remoteSessionId: string, customName: string): Promise<boolean> {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    const res = await runDb(
      db,
      `UPDATE remote_hosted_sessions SET custom_name = ?, updated_at = ? WHERE remote_session_id = ?`,
      [customName, now, remoteSessionId]
    );
    return res.changes > 0;
  },

  async updateStatus(
    remoteSessionId: string,
    status: RemoteHostedStatus,
    exitCode?: number | null
  ): Promise<boolean> {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    const res = await runDb(
      db,
      `UPDATE remote_hosted_sessions SET status = ?, exit_code = COALESCE(?, exit_code), updated_at = ? WHERE remote_session_id = ?`,
      [status, exitCode ?? null, now, remoteSessionId]
    );
    return res.changes > 0;
  },

  async deleteByRemoteSessionId(remoteSessionId: string): Promise<boolean> {
    const db = await getDbInstance();
    const res = await runDb(
      db,
      `DELETE FROM remote_hosted_sessions WHERE remote_session_id = ?`,
      [remoteSessionId]
    );
    return res.changes > 0;
  },
};
