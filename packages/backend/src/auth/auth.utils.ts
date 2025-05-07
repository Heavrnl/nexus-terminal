import { Request } from 'express';
// import { AuditLogService } from '../services/audit.service'; // 用于记录审计日志 - 已移除
// import { NotificationService } from '../services/notification.service'; // 用于发送通知 - 已移除
import { ipBlacklistService } from '../services/ip-blacklist.service'; // 用于重置IP尝试次数

// 实例化服务
// const auditLogService = new AuditLogService(); // 已移除
// const notificationService = new NotificationService(); // 已移除

/**
 * 为指定用户创建会话。
 * @param req - Express Request 对象
 * @param userId - 要为其创建会话的用户 ID
 * @param username - 要为其创建会话的用户名
 * @param loginMethod - 登录方式，例如 'Cloudflare' 或 'IP Whitelist'
 */
export const createSessionForUser = async (req: Request, userId: number, username: string, loginMethod: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        // 确保会话存在
        if (!req.session) {
            console.error('[AuthUtils] Session object is undefined. Cannot create session.');
            return reject(new Error('Session not available.'));
        }

        req.session.regenerate((err) => {
            if (err) {
                console.error('[AuthUtils] Error regenerating session:', err);
                return reject(err);
            }

            req.session.userId = userId;
            req.session.username = username;
            req.session.requiresTwoFactor = false; // 自动登录跳过 2FA

            // 对于自动登录，通常我们希望会话持久化，类似于 "rememberMe"
            // 如果会话存储配置为持久化，则不需要显式设置 maxAge，它会遵循存储的策略
            // 如果需要确保 cookie 持久，可以设置一个较长的 maxAge
            // req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 例如 30 天

            console.log(`[AuthUtils] Session created for user ID ${userId} (${username}) via ${loginMethod}.`);

            const clientIp = (req.headers['cf-connecting-ip'] as string) || req.ip || req.socket?.remoteAddress || 'unknown';
            
            // 重置该 IP 的登录失败尝试次数
            ipBlacklistService.resetAttempts(clientIp);

            // 记录审计日志 - 已移除
            // auditLogService.logAction('AUTOLOGIN_SUCCESS', { userId, username, ip: clientIp, method: loginMethod });
            
            // 发送通知 - 已移除
            // notificationService.sendNotification('AUTOLOGIN_SUCCESS', { userId, username, ip: clientIp, method: loginMethod });
            
            // 保存会话更改
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[AuthUtils] Error saving session:', saveErr);
                    return reject(saveErr);
                }
                resolve();
            });
        });
    });
};