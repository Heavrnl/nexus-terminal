import { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';
import { userRepository } from '../repositories/user.repository';
import { createSessionForUser } from './auth.utils';

export const autoLoginMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => { // 显式声明返回 Promise<void>
    console.log('[AutoLoginMiddleware] 自动登录检查开始...');

    const autoLoginSettings = await settingsService.getAutoLoginSettings();

    // 1. Cloudflare Access + 固定 IP 自动登录
    if (autoLoginSettings.cloudflare?.enabled) {
        console.log('[AutoLoginMiddleware] Cloudflare 自动登录已启用，开始检查...');
        const cfAuthenticatedUserEmail = req.headers['cf-access-authenticated-user-email'] as string;
        const cfJwtAssertion = req.headers['cf-access-jwt-assertion'] as string; // 可用于进一步验证JWT的有效性（此处暂不实现）
        const clientIp = req.headers['cf-connecting-ip'] as string || req.ip || req.socket?.remoteAddress;

        console.log(`[AutoLoginMiddleware] Cloudflare Headers: Email='${cfAuthenticatedUserEmail}', JWT Assertion present=${!!cfJwtAssertion}, Client IP='${clientIp}'`);

        if (cfAuthenticatedUserEmail && clientIp) { // 简单检查邮件是否存在，实际应用中可能需要验证邮件是否为管理员邮件
            if (autoLoginSettings.cloudflare.trustedIPs.includes(clientIp)) {
                console.log(`[AutoLoginMiddleware] Cloudflare 验证通过，IP '${clientIp}' 在信任列表中。尝试自动登录...`);
                try {
                    // 假设系统只有一个管理员用户，且其 username/id 是固定的或可配置的
                    // 此处简化为直接获取第一个用户作为管理员
                    const adminUser = await userRepository.findAdminUser();
                    if (adminUser) {
                        // 在 autoLogin.middleware.ts 中调用 createSessionForUser 时传递 username
                        await createSessionForUser(req, adminUser.id, adminUser.username, 'Cloudflare');
                        console.log(`[AutoLoginMiddleware] 已为管理员 '${adminUser.username}' 创建会话 (Cloudflare)。`);
                        res.status(200).json({
                            message: '通过 Cloudflare Access 自动登录成功。',
                            user: { id: adminUser.id, username: adminUser.username }
                        });
                        return; // 函数在此处结束执行
                    } else {
                        console.warn('[AutoLoginMiddleware] Cloudflare 验证通过但未找到管理员用户。');
                    }
                } catch (error) {
                    console.error('[AutoLoginMiddleware] Cloudflare 自动登录过程中创建会话失败:', error);
                    // 即使失败，也继续到下一个检查或标准登录，而不是阻止请求
                }
            } else {
                console.log(`[AutoLoginMiddleware] Cloudflare 验证通过，但 IP '${clientIp}' 不在信任列表中。`);
            }
        } else {
            console.log('[AutoLoginMiddleware] 未通过 Cloudflare Access 验证 (缺少必要 headers 或 IP)。');
        }
    } else {
        console.log('[AutoLoginMiddleware] Cloudflare 自动登录已禁用。');
    }

    // 2. 应用自身 IP 白名单自动登录
    if (autoLoginSettings.ipWhitelist?.enabled) {
        console.log('[AutoLoginMiddleware] 应用 IP 白名单自动登录已启用，开始检查...');
        // 如果请求已通过 Cloudflare，CF-Connecting-IP 应该是更可靠的真实 IP
        const clientIp = req.headers['cf-connecting-ip'] as string || req.ip || req.socket?.remoteAddress;
        console.log(`[AutoLoginMiddleware] 检查 IP 白名单，客户端 IP: '${clientIp}'`);

        if (clientIp && autoLoginSettings.ipWhitelist.allowedIPs.includes(clientIp)) {
            console.log(`[AutoLoginMiddleware] IP '${clientIp}' 在应用 IP 白名单中。尝试自动登录...`);
            try {
                const adminUser = await userRepository.findAdminUser();
                if (adminUser) {
                     // 在 autoLogin.middleware.ts 中调用 createSessionForUser 时传递 username
                    await createSessionForUser(req, adminUser.id, adminUser.username, 'IP Whitelist');
                    console.log(`[AutoLoginMiddleware] 已为管理员 '${adminUser.username}' 创建会话 (IP 白名单)。`);
                    res.status(200).json({
                        message: '通过 IP 白名单自动登录成功。',
                        user: { id: adminUser.id, username: adminUser.username }
                    });
                    return; // 函数在此处结束执行
                } else {
                    console.warn('[AutoLoginMiddleware] IP 白名单验证通过但未找到管理员用户。');
                }
            } catch (error) {
                console.error('[AutoLoginMiddleware] IP 白名单自动登录过程中创建会话失败:', error);
            }
        } else {
            console.log(`[AutoLoginMiddleware] IP '${clientIp}' 不在应用 IP 白名单中或无法获取 IP。`);
        }
    } else {
        console.log('[AutoLoginMiddleware] 应用 IP 白名单自动登录已禁用。');
    }

    // 3. 如果以上自动登录条件都不满足，则继续到标准登录流程
    console.log('[AutoLoginMiddleware] 未满足自动登录条件，继续执行后续中间件...');
    next();
};