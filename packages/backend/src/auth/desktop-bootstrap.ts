import { getDbInstance, runDb, getDb } from '../database/connection';
import { AuditLogService } from '../audit/audit.service';
import { NO_PASSWORD, isDesktopRuntime } from './session-policy';

/**
 * 桌面端「开机即用」：首次启动自动建一个 admin，密码为空。
 *
 * 为什么只对桌面端做：桌面端的后端是随安装包一起跑的 sidecar，用户打开软件就是想
 * 立刻用，不应该先被一个建账号向导拦住。Web / Docker 部署是暴露在网络里的服务，
 * 必须由部署者自己设密码，所以那条路继续走 needs-setup。
 *
 * 「密码为空」的存储方式：hashed_password 存空串。不用 bcrypt('') 是因为那样
 * 空密码会变成一个合法的密码值——任何人输空密码都能过。存空串让「没设置密码」
 * 成为一个可判定的状态，比「碰巧等于空密码的哈希」安全得多。
 *
 * 注：会话持久化策略（含 Web 端 180 天持久 cookie 的修复）在 ./session-policy.ts，
 * 那边是纯函数、可在不拉起数据库的情况下单测；这里统一转出去，保持既有 import 路径可用。
 */

export {
    NO_PASSWORD,
    DESKTOP_SESSION_MAX_AGE_MS,
    WEB_SESSION_MAX_AGE_MS,
    getSessionMaxAgeMs,
    shouldPersistSession,
    isPasswordSet,
    isDesktopRuntime,
    isLocalRequest,
} from './session-policy';

/**
 * 桌面端首次启动时创建默认账号。已经存在任何用户就什么都不做。
 * 失败不阻断启动——建不出账号顶多回到「需要初始设置」的老流程。
 */
export async function ensureDesktopAdmin(): Promise<void> {
    if (!isDesktopRuntime()) return;

    try {
        const db = await getDbInstance();
        const row = await getDb<{ count: number }>(db, 'SELECT COUNT(*) as count FROM users');
        if ((row?.count ?? 0) > 0) return;

        const now = Math.floor(Date.now() / 1000);
        const result = await runDb(
            db,
            `INSERT INTO users (username, hashed_password, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ['admin', NO_PASSWORD, now, now]
        );

        console.log(`[Desktop] 首次启动，已自动创建默认账号 admin (ID: ${result.lastID})，当前未设置密码。`);
        new AuditLogService().logAction('ADMIN_AUTO_CREATED', {
            userId: result.lastID,
            username: 'admin',
            reason: 'desktop first run',
        });
    } catch (error: any) {
        console.error('[Desktop] 自动创建默认账号失败，将回退到初始设置流程:', error?.message || error);
    }
}
