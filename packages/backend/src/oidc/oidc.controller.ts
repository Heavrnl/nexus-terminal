import { Request, Response } from 'express';
import crypto from 'crypto';
import { getDbInstance, runDb } from '../database/connection';
import { AuditLogService } from '../audit/audit.service';
import { userRepository } from '../user/user.repository';
import { NO_PASSWORD, shouldPersistSession, DESKTOP_SESSION_MAX_AGE_MS } from '../auth/desktop-bootstrap';
import { oidcRepository } from './oidc.repository';
import {
    oidcService,
    isEmailDomainAllowed,
    suggestOidcUsername,
    type OidcFlowState,
} from './oidc.service';
import { OidcError, toOidcErrorCode, type OidcErrorCode } from './oidc.errors';
import type { UpdateOidcProviderDto } from '../types/settings.types';

const auditLogService = new AuditLogService();

/**
 * 授权流程的一次性参数暂存在 session 里（契约 §3）。
 * 单飞语义：每次发起新流程都整体覆盖旧值，不存在并发流程互相污染的可能。
 */
declare module 'express-session' {
    interface SessionData {
        oidcFlow?: OidcFlowState;
    }
}

const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/providers';

function getOrigin(req: Request): string {
    // 后端已 app.set('trust proxy', true) 且 session proxy: true，反代下 protocol/host 可信
    return `${req.protocol}://${req.get('host')}`;
}

function buildRedirectUri(req: Request, providerId: string): string {
    return `${getOrigin(req)}${OIDC_CALLBACK_PATH}/${providerId}/callback`;
}

function getClientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** 失败统一 302 到登录页并带上契约 §3.1 的封闭错误码 */
function redirectOidcError(res: Response, code: OidcErrorCode): void {
    res.redirect(`/login?oidc_error=${encodeURIComponent(code)}`);
}

/** 清掉一次性流程参数，防止回调被重放 */
function clearFlow(req: Request): void {
    if (req.session) delete req.session.oidcFlow;
}

/** 登录态写入方式与密码登录/Passkey 成功分支保持同形（auth.controller.ts:473-482） */
function establishSession(req: Request, user: { id: number; username: string }): void {
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.requiresTwoFactor = false;
    if (shouldPersistSession(req)) {
        req.session.cookie.maxAge = DESKTOP_SESSION_MAX_AGE_MS;
    } else {
        req.session.cookie.maxAge = undefined;
    }
}

/**
 * 建一个 OIDC 专用账号。
 *
 * `hashed_password` 写 NO_PASSWORD（空串）而不是 bcrypt('')：空串让「未设置密码」成为
 * 可判定状态，而 bcrypt('') 会让空密码变成合法密码（见 desktop-bootstrap.ts 的说明）。
 * 用户名冲突时按契约 §3.1 追加 `-oidc-<4hex>` 后缀重试。
 */
async function createOidcUser(baseUsername: string): Promise<{ id: number; username: string }> {
    const db = await getDbInstance();
    let candidate = baseUsername;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await userRepository.findUserByUsername(candidate);
        if (!existing) {
            // 显式写时间戳，与 setupAdmin（auth.controller.ts:917）保持一致。
            // users 表的 created_at/updated_at 虽有 DEFAULT，但不该把正确性寄托在 schema 默认值上。
            const now = Math.floor(Date.now() / 1000);
            const { lastID } = await runDb(
                db,
                'INSERT INTO users (username, hashed_password, created_at, updated_at) VALUES (?, ?, ?, ?)',
                [candidate, NO_PASSWORD, now, now]
            );
            return { id: lastID, username: candidate };
        }
        candidate = `${baseUsername}-oidc-${crypto.randomBytes(2).toString('hex')}`;
    }
    throw new OidcError('server_error', '无法为 OIDC 用户生成唯一的用户名。');
}

// --- 路由处理器 ---

/** GET /api/v1/auth/oidc/providers —— 公开，登录页用（契约 §2 第 1 条） */
export const getOidcProvidersHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
        const providers = await oidcService.getEnabledProviderSummaries();
        res.json(providers);
    } catch (error) {
        console.error('[OIDC] 读取 provider 列表失败：', error);
        res.status(500).json({ message: '读取 OIDC 提供商列表失败。' });
    }
};

/** GET /api/v1/auth/oidc/providers/:id/authorize —— 公开，302 到 IdP（契约 §2 第 2 条） */
export const oidcAuthorizeHandler = async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params.id);
    const mode = req.query.mode === 'bind' ? 'bind' : 'login';

    // mode=bind 必须先登录，否则绑定没有归属主体
    if (mode === 'bind' && !req.session.userId) {
        res.redirect('/login');
        return;
    }

    try {
        const provider = await oidcService.getProviderById(providerId);
        if (!provider) {
            redirectOidcError(res, 'provider_not_found');
            return;
        }
        if (!provider.enabled) {
            redirectOidcError(res, 'provider_disabled');
            return;
        }

        const { url, flow } = await oidcService.buildAuthorizationRequest(
            provider,
            buildRedirectUri(req, provider.id),
            mode
        );
        // 单飞：整体覆盖旧流程
        req.session.oidcFlow = flow;
        // 显式保存后再跳转，避免浏览器抢先跟随 302 导致回调读不到流程参数
        req.session.save((saveError) => {
            if (saveError) {
                console.error('[OIDC] 保存授权流程 session 失败：', saveError);
                redirectOidcError(res, 'server_error');
                return;
            }
            res.redirect(url);
        });
    } catch (error) {
        console.error('[OIDC] 构造授权 URL 失败：', error);
        redirectOidcError(res, toOidcErrorCode(error));
    }
};

/** GET /api/v1/auth/oidc/providers/:id/callback —— 公开，IdP 回调（契约 §3 / §3.1） */
export const oidcCallbackHandler = async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params.id);
    const flow = req.session?.oidcFlow;

    // 没有流程参数，或回调落到了另一个 provider：状态对不上
    if (!flow || flow.providerId !== providerId) {
        clearFlow(req);
        redirectOidcError(res, 'state_mismatch');
        return;
    }

    // 一次性消费，重放同一个回调不会再走一遍
    clearFlow(req);

    try {
        const provider = await oidcService.getProviderById(providerId);
        if (!provider) {
            redirectOidcError(res, 'provider_not_found');
            return;
        }
        if (!provider.enabled) {
            redirectOidcError(res, 'provider_disabled');
            return;
        }

        const currentUrl = new URL(req.originalUrl, getOrigin(req));
        const identity = await oidcService.exchangeAuthorizationCode(provider, currentUrl, flow);

        // --- 分支 1：绑定（session 仍登录） ---
        if (flow.mode === 'bind' && req.session.userId) {
            const userId = req.session.userId;
            const existing = await oidcRepository.getLinkByProviderSubject(providerId, identity.subject);

            if (existing && existing.userId !== userId) {
                // 该身份已被别人绑定
                auditLogService.logAction('OIDC_ACCOUNT_LINKED', {
                    userId,
                    providerId,
                    subject: identity.subject,
                    outcome: 'conflict',
                    ip: getClientIp(req),
                });
                res.redirect('/settings?tab=security&oidc=conflict');
                return;
            }

            if (existing && existing.userId === userId) {
                // 已经绑在自己名下，刷新邮箱/issuer 即可
                await oidcRepository.updateLink(existing.id, {
                    email: identity.email,
                    issuer: identity.issuer,
                });
            } else {
                // 同一用户对同一 provider 只保留一条：先清掉可能存在的旧 subject
                const previous = await oidcRepository.getLinkByUserAndProvider(userId, providerId);
                if (previous) {
                    await oidcRepository.deleteLinkById(previous.id);
                }
                await oidcRepository.createLink({
                    userId,
                    providerId,
                    subject: identity.subject,
                    email: identity.email,
                    issuer: identity.issuer,
                });
            }

            auditLogService.logAction('OIDC_ACCOUNT_LINKED', {
                userId,
                providerId,
                subject: identity.subject,
                ip: getClientIp(req),
            });
            res.redirect('/settings?tab=security&oidc=bound');
            return;
        }

        // --- 分支 2：登录（mode=login，或 mode=bind 但 session 掉线） ---
        const link = await oidcRepository.getLinkByProviderSubject(providerId, identity.subject);

        if (link) {
            const user = await userRepository.findUserById(link.userId);
            if (!user) {
                // 有链接却没有用户：外键级联应已清理，这里视为数据不一致
                throw new OidcError('server_error', 'OIDC 绑定指向的用户不存在。');
            }
            await oidcRepository.updateLastLogin(link.id);
            establishSession(req, user);
            auditLogService.logAction('OIDC_LOGIN_SUCCESS', {
                userId: user.id,
                username: user.username,
                providerId,
                method: 'oidc',
                ip: getClientIp(req),
            });
            res.redirect('/');
            return;
        }

        // 未绑定：只有 provider 允许自动建号、且邮箱域名在白名单内才建
        if (provider.autoCreateUser) {
            if (!isEmailDomainAllowed(identity.email, provider.allowedEmailDomains)) {
                auditLogService.logAction('OIDC_LOGIN_FAILURE', {
                    providerId,
                    subject: identity.subject,
                    email: identity.email,
                    reason: 'email_domain_not_allowed',
                    ip: getClientIp(req),
                });
                redirectOidcError(res, 'not_linked');
                return;
            }

            const created = await createOidcUser(suggestOidcUsername(identity));
            await oidcRepository.createLink({
                userId: created.id,
                providerId,
                subject: identity.subject,
                email: identity.email,
                issuer: identity.issuer,
            });
            establishSession(req, created);
            auditLogService.logAction('OIDC_LOGIN_SUCCESS', {
                userId: created.id,
                username: created.username,
                providerId,
                method: 'oidc',
                autoCreated: true,
                ip: getClientIp(req),
            });
            res.redirect('/');
            return;
        }

        auditLogService.logAction('OIDC_LOGIN_FAILURE', {
            providerId,
            subject: identity.subject,
            reason: 'not_linked',
            ip: getClientIp(req),
        });
        redirectOidcError(res, 'not_linked');
    } catch (error) {
        const code = toOidcErrorCode(error);
        console.warn(`[OIDC] 回调处理失败（provider=${providerId}, code=${code}）：`, error);
        auditLogService.logAction('OIDC_LOGIN_FAILURE', {
            providerId,
            reason: code,
            ip: getClientIp(req),
        });
        redirectOidcError(res, code);
    }
};

/** GET /api/v1/auth/oidc/links —— 需登录（契约 §2 第 4 条） */
export const getOidcLinksHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    if (!userId) {
        res.status(401).json({ message: '未授权：请先登录。' });
        return;
    }

    try {
        const [links, providerNames] = await Promise.all([
            oidcRepository.getLinksByUserId(userId),
            oidcService.getProviderNameMap(),
        ]);
        res.json({
            links: links.map((link) => ({
                id: link.id,
                providerId: link.providerId,
                // provider 已被删除时回退成 id，前端仍能显示「已失效」条目
                providerName: providerNames.get(link.providerId) ?? link.providerId,
                email: link.email,
                createdAt: link.createdAt,
                lastLoginAt: link.lastLoginAt,
            })),
        });
    } catch (error) {
        console.error('[OIDC] 读取绑定列表失败：', error);
        res.status(500).json({ message: '读取 OIDC 绑定列表失败。' });
    }
};

/** DELETE /api/v1/auth/oidc/links/:linkId —— 需登录，只能删自己的（契约 §2 第 5 条） */
export const deleteOidcLinkHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    if (!userId) {
        res.status(401).json({ message: '未授权：请先登录。' });
        return;
    }

    const linkId = Number.parseInt(String(req.params.linkId), 10);
    if (!Number.isFinite(linkId)) {
        res.status(404).json({ message: '未找到该 OIDC 绑定。' });
        return;
    }

    try {
        // repository 的 WHERE 带 user_id：不属于自己的链接会删 0 行 → 404
        const removed = await oidcRepository.deleteLink(linkId, userId);
        if (!removed) {
            res.status(404).json({ message: '未找到该 OIDC 绑定。' });
            return;
        }

        auditLogService.logAction('OIDC_ACCOUNT_UNLINKED', {
            userId,
            linkId,
            ip: getClientIp(req),
        });
        res.json({ message: '已解绑该 OIDC 账号。' });
    } catch (error) {
        console.error('[OIDC] 解绑失败：', error);
        res.status(500).json({ message: '解绑 OIDC 账号失败。' });
    }
};

/** GET /api/v1/auth/oidc/settings —— 需登录，密钥屏蔽（契约 §2 第 6 条） */
export const getOidcSettingsHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
        const providers = await oidcService.getProviderPublicConfigs();
        res.json({ providers });
    } catch (error) {
        console.error('[OIDC] 读取 OIDC 设置失败：', error);
        res.status(500).json({ message: '读取 OIDC 设置失败。' });
    }
};

/** PUT /api/v1/auth/oidc/settings —— 需登录，全量替换（契约 §2 第 7 条） */
export const updateOidcSettingsHandler = async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { providers?: unknown };
    if (!Array.isArray(body.providers)) {
        res.status(400).json({ message: '请求体必须包含 providers 数组。' });
        return;
    }

    try {
        const providers = await oidcService.saveProviders(body.providers as UpdateOidcProviderDto[]);
        auditLogService.logAction('OIDC_SETTINGS_UPDATED', {
            userId: req.session.userId,
            providerCount: providers.length,
            ip: getClientIp(req),
        });
        res.json({ providers });
    } catch (error) {
        console.error('[OIDC] 保存 OIDC 设置失败：', error);
        res.status(500).json({ message: '保存 OIDC 设置失败。' });
    }
};
