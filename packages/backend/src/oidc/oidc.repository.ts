import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import type { OidcLink, NewOidcLink } from '../types/settings.types';

/**
 * `user_oidc_links` 表的访问层（表由 migration id=32 建立，见 database/migrations.ts）。
 *
 * 命名约定与 passkey.repository.ts 保持一致：DB 用 snake_case，对外一律 camelCase。
 * sqlite3 驱动在部分路径会把 INTEGER 以字符串返回，所以统一走 toInt() 归一。
 */
interface OidcLinkRow {
    id: number;
    user_id: number;
    provider_id: string;
    subject: string;
    email: string | null;
    issuer: string | null;
    created_at: number;
    last_login_at: number | null;
}

function toInt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function mapLink(row: OidcLinkRow | undefined | null): OidcLink | null {
    if (!row) return null;
    return {
        id: toInt(row.id) ?? 0,
        userId: toInt(row.user_id) ?? 0,
        providerId: row.provider_id,
        subject: row.subject,
        email: row.email ?? null,
        issuer: row.issuer ?? null,
        createdAt: toInt(row.created_at) ?? 0,
        lastLoginAt: toInt(row.last_login_at),
    };
}

export interface OidcLinkPatch {
    userId?: number;
    subject?: string;
    email?: string | null;
    issuer?: string | null;
}

export class OidcRepository {
    async createLink(data: NewOidcLink): Promise<OidcLink> {
        const db = await getDbInstance();
        const sql = `
            INSERT INTO user_oidc_links (user_id, provider_id, subject, email, issuer, created_at)
            VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
        `;
        const { lastID } = await runDb(db, sql, [
            data.userId,
            data.providerId,
            data.subject,
            data.email ?? null,
            data.issuer ?? null,
        ]);
        const created = await this.getLinkById(lastID);
        if (!created) {
            throw new Error('创建 OIDC 绑定后无法回读该记录。');
        }
        return created;
    }

    async getLinkById(id: number): Promise<OidcLink | null> {
        const db = await getDbInstance();
        const row = await getDb<OidcLinkRow>(db, 'SELECT * FROM user_oidc_links WHERE id = ?', [id]);
        return mapLink(row);
    }

    /** 登录主路径：按 (provider_id, subject) 反查绑定，走 UNIQUE 索引。 */
    async getLinkByProviderSubject(providerId: string, subject: string): Promise<OidcLink | null> {
        const db = await getDbInstance();
        const row = await getDb<OidcLinkRow>(
            db,
            'SELECT * FROM user_oidc_links WHERE provider_id = ? AND subject = ?',
            [providerId, subject]
        );
        return mapLink(row);
    }

    /** 同一用户对同一 provider 只保留一条绑定，用它定位要被覆盖的旧 subject。 */
    async getLinkByUserAndProvider(userId: number, providerId: string): Promise<OidcLink | null> {
        const db = await getDbInstance();
        const row = await getDb<OidcLinkRow>(
            db,
            'SELECT * FROM user_oidc_links WHERE user_id = ? AND provider_id = ? ORDER BY id ASC LIMIT 1',
            [userId, providerId]
        );
        return mapLink(row);
    }

    async getLinksByUserId(userId: number): Promise<OidcLink[]> {
        const db = await getDbInstance();
        const rows = await allDb<OidcLinkRow>(
            db,
            'SELECT * FROM user_oidc_links WHERE user_id = ? ORDER BY created_at DESC, id DESC',
            [userId]
        );
        return rows.map((row) => mapLink(row) as OidcLink);
    }

    async updateLink(id: number, patch: OidcLinkPatch): Promise<boolean> {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (patch.userId !== undefined) {
            sets.push('user_id = ?');
            params.push(patch.userId);
        }
        if (patch.subject !== undefined) {
            sets.push('subject = ?');
            params.push(patch.subject);
        }
        if (patch.email !== undefined) {
            sets.push('email = ?');
            params.push(patch.email);
        }
        if (patch.issuer !== undefined) {
            sets.push('issuer = ?');
            params.push(patch.issuer);
        }
        if (sets.length === 0) return false;

        params.push(id);
        const db = await getDbInstance();
        const { changes } = await runDb(
            db,
            `UPDATE user_oidc_links SET ${sets.join(', ')} WHERE id = ?`,
            params
        );
        return changes > 0;
    }

    async updateLastLogin(id: number): Promise<boolean> {
        const db = await getDbInstance();
        const { changes } = await runDb(
            db,
            "UPDATE user_oidc_links SET last_login_at = strftime('%s','now') WHERE id = ?",
            [id]
        );
        return changes > 0;
    }

    /** 解绑：把 user_id 一起写进 WHERE，从 SQL 层保证「只能删自己的」。 */
    async deleteLink(linkId: number, userId: number): Promise<boolean> {
        const db = await getDbInstance();
        const { changes } = await runDb(
            db,
            'DELETE FROM user_oidc_links WHERE id = ? AND user_id = ?',
            [linkId, userId]
        );
        return changes > 0;
    }

    async deleteLinkById(linkId: number): Promise<boolean> {
        const db = await getDbInstance();
        const { changes } = await runDb(db, 'DELETE FROM user_oidc_links WHERE id = ?', [linkId]);
        return changes > 0;
    }

    async deleteLinksByUserId(userId: number): Promise<boolean> {
        const db = await getDbInstance();
        const { changes } = await runDb(db, 'DELETE FROM user_oidc_links WHERE user_id = ?', [userId]);
        return changes > 0;
    }

    async deleteLinksByUserAndProvider(userId: number, providerId: string): Promise<boolean> {
        const db = await getDbInstance();
        const { changes } = await runDb(
            db,
            'DELETE FROM user_oidc_links WHERE user_id = ? AND provider_id = ?',
            [userId, providerId]
        );
        return changes > 0;
    }
}

export const oidcRepository = new OidcRepository();
