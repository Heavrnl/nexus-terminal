import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { NotificationService } from '../notifications/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { ipBlacklistService } from '../auth/ip-blacklist.service';
import { captchaService } from '../auth/captcha.service';
import { settingsService } from '../settings/settings.service';
import { passkeyService } from '../passkey/passkey.service'; // +++ Passkey Service
import { passkeyRepository } from '../passkey/passkey.repository'; // +++ Passkey Repository
import { userRepository } from '../user/user.repository'; // For passkey auth success
import { isPasswordSet, isLocalRequest, isDesktopRuntime, getSessionMaxAgeMs, DESKTOP_SESSION_MAX_AGE_MS, NO_PASSWORD } from './desktop-bootstrap';

const notificationService = new NotificationService();
const auditLogService = new AuditLogService();

export interface User { 
    id: number;
    username: string;
    hashed_password: string; 
    two_factor_secret?: string | null;
}

declare module 'express-session' {
    interface SessionData {
        userId?: number;
        username?: string;
        tempTwoFactorSecret?: string;
        requiresTwoFactor?: boolean;
        currentChallenge?: string; // +++ For Passkey challenge storage
        passkeyUserHandle?: string; // +++ For Passkey user handle (user ID as string)
        rememberMe?: boolean;
    }
}

// --- Passkey Controller Methods ---

/**
 * 生成 Passkey 注册选项 (POST /api/v1/auth/passkey/registration-options)
 */
export const generatePasskeyRegistrationOptionsHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username;

    if (!userId || !username) {
        res.status(401).json({ message: '用户未认证。' });
        return;
    }

    try {
        // PasskeyService's generateRegistrationOptions expects userId as number
        const options = await passkeyService.generateRegistrationOptions(username, userId);
        
        req.session.currentChallenge = options.challenge;
        // The user.id from options is a Uint8Array. We need to store the original string userId for userHandle.
        req.session.passkeyUserHandle = userId.toString(); 

        console.log(`[AuthController] Generated Passkey registration options for user ${username}, challenge: ${options.challenge.substring(0,10)}...`);
        res.json(options);
    } catch (error: any) {
        console.error(`[AuthController] 生成 Passkey 注册选项时出错 (用户: ${username}):`, error.message, error.stack);
        res.status(500).json({ message: '生成 Passkey 注册选项失败。', error: error.message });
    }
};

/**
 * 验证并保存新的 Passkey (POST /api/v1/auth/passkey/register)
 */
export const verifyPasskeyRegistrationHandler = async (req: Request, res: Response): Promise<void> => {
    const registrationResponse = req.body; // The whole body is the response from @simplewebauthn/browser
    const expectedChallenge = req.session.currentChallenge;
    const userHandle = req.session.passkeyUserHandle; 

    if (!registrationResponse) {
        res.status(400).json({ message: '注册响应不能为空。' });
        return;
    }
    if (!expectedChallenge) {
        res.status(400).json({ message: '会话中未找到质询信息，请重试注册流程。' });
        return;
    }
    if (!userHandle) {
        res.status(400).json({ message: '会话中未找到用户句柄，请重试注册流程。' });
        return;
    }

    try {
        const verification = await passkeyService.verifyRegistration(
            registrationResponse,
            expectedChallenge,
            userHandle // userHandle is userId as string
        );

        if (verification.verified && verification.newPasskeyToSave) {
            await passkeyRepository.createPasskey(verification.newPasskeyToSave);
            const userIdNum = parseInt(userHandle, 10);
            console.log(`[AuthController] 用户 ${userHandle} 的 Passkey 注册成功并已保存。 CredentialID: ${verification.newPasskeyToSave.credential_id}`);
            auditLogService.logAction('PASSKEY_REGISTERED', { userId: userIdNum, credentialId: verification.newPasskeyToSave.credential_id });
            notificationService.sendNotification('PASSKEY_REGISTERED', { userId: userIdNum, username: req.session.username, credentialId: verification.newPasskeyToSave.credential_id });
            
            delete req.session.currentChallenge;
            delete req.session.passkeyUserHandle;
            res.status(201).json({ verified: true, message: 'Passkey 注册成功。' });
        } else {
            console.warn(`[AuthController] Passkey 注册验证失败 (用户: ${userHandle}):`, verification);
            res.status(400).json({ verified: false, message: 'Passkey 注册验证失败。', error: (verification as any).error?.message || 'Unknown verification error' });
        }
    } catch (error: any) {
        console.error(`[AuthController] 验证 Passkey 注册时出错 (用户: ${userHandle}):`, error.message, error.stack);
        res.status(500).json({ verified: false, message: '验证 Passkey 注册失败。', error: error.message });
    }
};

/**
 * 生成 Passkey 认证选项 (POST /api/v1/auth/passkey/authentication-options)
 */
export const generatePasskeyAuthenticationOptionsHandler = async (req: Request, res: Response): Promise<void> => {
    const { username } = req.body; // Can be initiated by username (if not logged in) or for currently logged-in user

    try {
        // PasskeyService's generateAuthenticationOptions can optionally take a username
        const options = await passkeyService.generateAuthenticationOptions(username);
        
        req.session.currentChallenge = options.challenge;
        // For authentication, userHandle is not strictly needed in session beforehand if RP ID is specific enough
        // or if allowCredentials is used. We'll clear any old one just in case.
        delete req.session.passkeyUserHandle; 

        console.log(`[AuthController] Generated Passkey authentication options (username: ${username || 'any'}), challenge: ${options.challenge.substring(0,10)}...`);
        res.json(options);
    } catch (error: any) {
        console.error(`[AuthController] 生成 Passkey 认证选项时出错 (username: ${username || 'any'}):`, error.message, error.stack);
        res.status(500).json({ message: '生成 Passkey 认证选项失败。', error: error.message });
    }
};

/**
 * 验证 Passkey 凭据并登录用户 (POST /api/v1/auth/passkey/authenticate)
 */
export const verifyPasskeyAuthenticationHandler = async (req: Request, res: Response): Promise<void> => {
    // Extract assertionResponse and rememberMe from the request body
    const { assertionResponse, rememberMe } = req.body;
    const expectedChallenge = req.session.currentChallenge;

    // Rename assertionResponse to authenticationResponseJSON for clarity within this scope
    const authenticationResponseJSON = assertionResponse;

    if (!authenticationResponseJSON) {
        res.status(400).json({ message: '认证响应 (assertionResponse) 不能为空。' });
        return;
    }
    if (!expectedChallenge) {
        res.status(400).json({ message: '会话中未找到质询信息，请重试认证流程。' });
        return;
    }

    try {
        // Pass the extracted authenticationResponseJSON to the service
        const verification = await passkeyService.verifyAuthentication(
            authenticationResponseJSON,
            expectedChallenge
        );

        if (verification.verified && verification.userId && verification.passkey) {
            const user = await userRepository.findUserById(verification.userId);
            if (!user) {
                // This should ideally not happen if passkey verification was successful
                console.error(`[AuthController] Passkey 认证成功但未找到用户 ID: ${verification.userId}`);
                auditLogService.logAction('PASSKEY_AUTH_FAILURE', { credentialId: verification.passkey.credential_id, reason: 'User not found after verification' });
                res.status(401).json({ verified: false, message: 'Passkey 认证失败：用户数据错误。' });
                return;
            }

            console.log(`[AuthController] 用户 ${user.username} (ID: ${user.id}) 通过 Passkey (ID: ${verification.passkey.id}) 认证成功。`);
            
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
            auditLogService.logAction('PASSKEY_AUTH_SUCCESS', { userId: user.id, username: user.username, credentialId: verification.passkey.credential_id, ip: clientIp });
            notificationService.sendNotification('LOGIN_SUCCESS', { userId: user.id, username: user.username, ip: clientIp, method: 'Passkey' });

            // Setup session similar to password login
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.requiresTwoFactor = false; // Passkey implies 2FA characteristics

            // Passkey 登录同样走统一策略：以前这里是硬编码的 maxAge，
            // 而且 rememberMe 为假时会退化成会话 cookie（Web 端关浏览器即掉登录）。
            req.session.cookie.maxAge = getSessionMaxAgeMs(req, rememberMe);
            
            delete req.session.currentChallenge;
            delete req.session.passkeyUserHandle;

            res.status(200).json({
                verified: true,
                message: 'Passkey 认证成功。',
                user: { id: user.id, username: user.username }
            });

        } else {
            console.warn(`[AuthController] Passkey 认证验证失败:`, verification);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
            auditLogService.logAction('PASSKEY_AUTH_FAILURE', {
                credentialId: authenticationResponseJSON?.id || 'unknown', // Use the extracted object
                reason: 'Verification failed',
                ip: clientIp
            });
            notificationService.sendNotification('PASSKEY_AUTH_FAILURE', { credentialId: authenticationResponseJSON?.id || 'unknown', reason: 'Verification failed', ip: clientIp });
            res.status(401).json({ verified: false, message: 'Passkey 认证失败。' });
        }
    } catch (error: any) {
        console.error(`[AuthController] 验证 Passkey 认证时出错:`, error.message, error.stack);
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        auditLogService.logAction('PASSKEY_AUTH_FAILURE', {
            credentialId: authenticationResponseJSON?.id || 'unknown', // Use the extracted object
            reason: error.message,
            ip: clientIp
        });
        notificationService.sendNotification('PASSKEY_AUTH_FAILURE', { credentialId: authenticationResponseJSON?.id || 'unknown', reason: error.message, ip: clientIp });
        res.status(500).json({ verified: false, message: '验证 Passkey 认证失败。', error: error.message });
    }
};


/**
 * 获取当前认证用户的所有 Passkey (GET /api/v1/user/passkeys)
 */
export const listUserPasskeysHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username;

    if (!userId || !username) {
        res.status(401).json({ message: '用户未认证。' });
        return;
    }

    try {
        const passkeys = await passkeyService.listPasskeysByUserId(userId);
        console.log(`[AuthController] 用户 ${username} (ID: ${userId}) 获取了 Passkey 列表，数量: ${passkeys.length}`);
        res.status(200).json(passkeys);
    } catch (error: any) {
        console.error(`[AuthController] 用户 ${username} (ID: ${userId}) 获取 Passkey 列表时出错:`, error.message, error.stack);
        res.status(500).json({ message: '获取 Passkey 列表失败。', error: error.message });
    }
};

/**
 * 删除当前认证用户指定的 Passkey (DELETE /api/v1/user/passkeys/:credentialID)
 */
export const deleteUserPasskeyHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username;
    const { credentialID } = req.params;

    if (!userId || !username) {
        res.status(401).json({ message: '用户未认证。' });
        return;
    }

    if (!credentialID) {
        res.status(400).json({ message: '必须提供 Passkey 的 CredentialID。' });
        return;
    }

    try {
        const wasDeleted = await passkeyService.deletePasskey(userId, credentialID);
        if (wasDeleted) {
            console.log(`[AuthController] 用户 ${username} (ID: ${userId}) 成功删除了 Passkey (CredentialID: ${credentialID})。`);
            auditLogService.logAction('PASSKEY_DELETED', { userId, username, credentialId: credentialID });
            notificationService.sendNotification('PASSKEY_DELETED', { userId, username, credentialId: credentialID });
            res.status(200).json({ message: 'Passkey 删除成功。' });
        } else {
            // 这通常不应该发生，因为 service 层会在找不到或权限不足时抛出错误
            console.warn(`[AuthController] 用户 ${username} (ID: ${userId}) 删除 Passkey (CredentialID: ${credentialID}) 失败，但未抛出错误。`);
            res.status(404).json({ message: 'Passkey 未找到或无法删除。' });
        }
    } catch (error: any) {
        console.error(`[AuthController] 用户 ${username} (ID: ${userId}) 删除 Passkey (CredentialID: ${credentialID}) 时出错:`, error.message, error.stack);
        if (error.message === 'Passkey not found.') {
            res.status(404).json({ message: '指定的 Passkey 未找到。' });
        } else if (error.message === 'Unauthorized to delete this passkey.') {
            auditLogService.logAction('PASSKEY_DELETE_UNAUTHORIZED', { userId, username, credentialIdAttempted: credentialID });
            res.status(403).json({ message: '无权删除此 Passkey。' });
        } else {
            res.status(500).json({ message: '删除 Passkey 失败。', error: error.message });
        }
    }
};

/**
 * 更新当前认证用户指定的 Passkey 名称 (PUT /api/v1/user/passkeys/:credentialID/name)
 */
export const updateUserPasskeyNameHandler = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username;
    const { credentialID } = req.params;
    const { name } = req.body;

    if (!userId || !username) {
        res.status(401).json({ message: '用户未认证。' });
        return;
    }

    if (!credentialID) {
        res.status(400).json({ message: '必须提供 Passkey 的 CredentialID。' });
        return;
    }

    if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ message: 'Passkey 名称不能为空。' });
        return;
    }

    const trimmedName = name.trim();

    try {
        await passkeyService.updatePasskeyName(userId, credentialID, trimmedName);
        console.log(`[AuthController] 用户 ${username} (ID: ${userId}) 成功更新了 Passkey (CredentialID: ${credentialID}) 的名称为 "${trimmedName}"。`);
        auditLogService.logAction('PASSKEY_NAME_UPDATED', { userId, username, credentialId: credentialID, newName: trimmedName });
        // Optionally send a notification if desired
        // notificationService.sendNotification('PASSKEY_NAME_UPDATED', { userId, username, credentialId: credentialID, newName: trimmedName });
        res.status(200).json({ message: 'Passkey 名称更新成功。' });

    } catch (error: any) {
        console.error(`[AuthController] 用户 ${username} (ID: ${userId}) 更新 Passkey (CredentialID: ${credentialID}) 名称时出错:`, error.message, error.stack);
        if (error.message === 'Passkey not found.') {
            res.status(404).json({ message: '指定的 Passkey 未找到。' });
        } else if (error.message === 'Unauthorized to update this passkey name.') {
            auditLogService.logAction('PASSKEY_NAME_UPDATE_UNAUTHORIZED', { userId, username, credentialIdAttempted: credentialID });
            res.status(403).json({ message: '无权更新此 Passkey 名称。' });
        } else {
            res.status(500).json({ message: '更新 Passkey 名称失败。', error: error.message });
        }
    }
};
 
 
/**
 * 处理用户登录请求 (POST /api/v1/auth/login)
 */
export const login = async (req: Request, res: Response): Promise<void> => {
    // 从请求体中解构 username, password 和可选的 rememberMe
    const { username, password, rememberMe } = req.body;

    // 密码允许为空：桌面端首次启动的 admin 账号未设置密码，直接回车即可进入。
    // 是否真的接受空密码，由下面「该账号有没有设置密码」决定，不由这里决定。
    const passwordInput = typeof password === 'string' ? password : '';

    if (!username) {
        res.status(400).json({ message: '用户名不能为空。' });
        return;
    }

    try {
        // --- CAPTCHA Verification Step ---
        const captchaConfig = await settingsService.getCaptchaConfig();
        if (captchaConfig.enabled) {
            const { captchaToken } = req.body;
            if (!captchaToken) {
                res.status(400).json({ message: '需要提供 CAPTCHA 令牌。' });
                return; 
            }
            try {
                const isCaptchaValid = await captchaService.verifyToken(captchaToken);
                if (!isCaptchaValid) {
                    console.log(`[AuthController] 登录尝试失败: CAPTCHA 验证失败 - ${username}`);
                    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
                    ipBlacklistService.recordFailedAttempt(clientIp);
                    auditLogService.logAction('LOGIN_FAILURE', { username, reason: 'Invalid CAPTCHA token', ip: clientIp });
                    notificationService.sendNotification('LOGIN_FAILURE', { username, reason: 'Invalid CAPTCHA token', ip: clientIp }); 
                    res.status(401).json({ message: 'CAPTCHA 验证失败。' });
                    return;
                }
                console.log(`[AuthController] CAPTCHA 验证成功 - ${username}`);
            } catch (captchaError: any) {
                console.error(`[AuthController] CAPTCHA 验证过程中出错 (${username}):`, captchaError.message);
                res.status(500).json({ message: 'CAPTCHA 验证服务出错，请稍后重试或检查配置。' });
                return;
            }
        } else {
            console.log(`[AuthController] CAPTCHA 未启用，跳过验证 - ${username}`);
        }


        const db = await getDbInstance(); 
        const user = await getDb<User>(db, 'SELECT id, username, hashed_password, two_factor_secret FROM users WHERE username = ?', [username]);

     

        if (!user) {
            console.log(`登录尝试失败: 用户未找到 - ${username}`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
            ipBlacklistService.recordFailedAttempt(clientIp);
            auditLogService.logAction('LOGIN_FAILURE', { username, reason: 'User not found', ip: clientIp });
            notificationService.sendNotification('LOGIN_FAILURE', { username, reason: 'User not found', ip: clientIp }); 
            res.status(401).json({ message: '无效的凭据。' });
            return;
        }

        // 账号没设置密码（桌面端默认 admin）：只接受空密码，且只接受本机请求。
        // 桌面端后端仍监听 0.0.0.0，不做这个限制等于把机器开放给同网段任何人。
        if (!isPasswordSet(user.hashed_password)) {
            if (!isLocalRequest(req)) {
                console.log(`登录尝试失败: 账号未设置密码且来源非本机 - ${username}`);
                res.status(403).json({
                    message: '该账号尚未设置密码，只能在本机登录。请在本机登录后到 设置 → 安全 里设置密码。',
                });
                return;
            }
            if (passwordInput !== '') {
                console.log(`登录尝试失败: 账号未设置密码但提交了非空密码 - ${username}`);
                const failIp = req.ip || req.socket?.remoteAddress || 'unknown';
                ipBlacklistService.recordFailedAttempt(failIp);
                auditLogService.logAction('LOGIN_FAILURE', { username, reason: 'Password not set', ip: failIp });
                res.status(401).json({ message: '无效的凭据。' });
                return;
            }

            // 免密不等于免二次验证：这个账号可能先前开过 2FA
            if (user.two_factor_secret) {
                console.log(`登录需要两步验证 (本机免密): ${username}`);
                req.session.userId = user.id;
                req.session.requiresTwoFactor = true;
                req.session.rememberMe = rememberMe;
                res.status(200).json({ message: '需要进行两步验证。', requiresTwoFactor: true });
                return;
            }

            console.log(`登录成功 (本机免密): ${username}`);
            const localIp = req.ip || req.socket?.remoteAddress || 'unknown';
            ipBlacklistService.resetAttempts(localIp);
            auditLogService.logAction('LOGIN_SUCCESS', { userId: user.id, username, ip: localIp, method: 'local-no-password' });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.requiresTwoFactor = false;
            req.session.cookie.maxAge = getSessionMaxAgeMs(req, rememberMe);
            res.status(200).json({
                message: '登录成功。',
                user: { id: user.id, username: user.username, isTwoFactorEnabled: false },
            });
            return;
        }

        const isMatch = await bcrypt.compare(passwordInput, user.hashed_password);

        if (!isMatch) {
            console.log(`登录尝试失败: 密码错误 - ${username}`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
            ipBlacklistService.recordFailedAttempt(clientIp);
            auditLogService.logAction('LOGIN_FAILURE', { username, reason: 'Invalid password', ip: clientIp });
            notificationService.sendNotification('LOGIN_FAILURE', { username, reason: 'Invalid password', ip: clientIp }); 
            res.status(401).json({ message: '无效的凭据。' });
            return;
        }

        // 检查是否启用了 2FA
        if (user.two_factor_secret) {
            console.log(`用户 ${username} 已启用 2FA，需要进行二次验证。`);
            req.session.userId = user.id; 
            req.session.requiresTwoFactor = true;
            req.session.rememberMe = rememberMe; 
            res.status(200).json({ message: '需要进行两步验证。', requiresTwoFactor: true });
        } else {
            console.log(`登录成功 (无 2FA): ${username}`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
            ipBlacklistService.resetAttempts(clientIp);
            auditLogService.logAction('LOGIN_SUCCESS', { userId: user.id, username, ip: clientIp });
            notificationService.sendNotification('LOGIN_SUCCESS', { userId: user.id, username, ip: clientIp }); 
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.requiresTwoFactor = false; 

            // 统一持久会话策略：桌面端本机 / 勾了「记住我」= 1 年，Web 端默认 180 天。
            // 这里以前在未勾选时写 `maxAge = undefined`，正是 Web 端反复要重新登录的原因。
            req.session.cookie.maxAge = getSessionMaxAgeMs(req, rememberMe);

            res.status(200).json({
                message: '登录成功。',
                user: { id: user.id, username: user.username }
            });
        }

    } catch (error) {
        console.error('登录时出错:', error);
        res.status(500).json({ message: '登录过程中发生内部服务器错误。' });
    }
};

/**
 * 获取当前用户的认证状态 (GET /api/v1/auth/status)
 */
export const getAuthStatus = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username;

    if (!userId || !username || req.session.requiresTwoFactor) {
        res.status(401).json({ isAuthenticated: false });
        return;
    }

    try {
        const db = await getDbInstance(); 
        const user = await getDb<{ two_factor_secret: string | null; hashed_password: string }>(
            db, 'SELECT two_factor_secret, hashed_password FROM users WHERE id = ?', [userId]);

        if (!user) {
             res.status(401).json({ isAuthenticated: false });
             return;
        }

        res.status(200).json({
            isAuthenticated: true,
            user: {
                id: userId,
                username: username,
                isTwoFactorEnabled: !!user.two_factor_secret,
                // 桌面端默认账号没有密码，前端据此把「修改密码」渲染成「设置密码」
                hasPassword: isPasswordSet(user.hashed_password),
            }
        });

    } catch (error) {
        console.error(`获取用户 ${userId} 状态时发生内部错误:`, error);
        res.status(500).json({ message: '获取认证状态时发生内部服务器错误。' });
    }
};
/**
 * 处理登录时的 2FA 验证 (POST /api/v1/auth/login/2fa)
 */
export const verifyLogin2FA = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body;
    const userId = req.session.userId; 

    if (!userId || !req.session.requiresTwoFactor) {
        res.status(400).json({ message: '无效的请求或会话状态。' });
        return;
    }

    if (!token) {
        res.status(400).json({ message: '验证码不能为空。' });
        return;
    }

    try {
        const db = await getDbInstance();
        const user = await getDb<User>(db, 'SELECT id, username, two_factor_secret FROM users WHERE id = ?', [userId]);

    

        if (!user || !user.two_factor_secret) {
            console.error(`2FA 验证错误: 未找到用户 ${userId} 或未设置密钥。`);
            res.status(400).json({ message: '无法验证，请重新登录。' });
            return;
        }

        const verified = speakeasy.totp.verify({
            secret: user.two_factor_secret,
            encoding: 'base32',
            token: token,
            window: 1 
        });

        if (verified) {
            console.log(`用户 ${user.username} 2FA 验证成功。`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
            ipBlacklistService.resetAttempts(clientIp);
            auditLogService.logAction('LOGIN_SUCCESS', { userId: user.id, username: user.username, ip: clientIp, twoFactor: true });
            notificationService.sendNotification('LOGIN_SUCCESS', { userId: user.id, username: user.username, ip: clientIp, twoFactor: true }); 
            req.session.username = user.username;
            req.session.requiresTwoFactor = false; 

            // 走完 2FA 才算真正登录成功，此时才按统一策略落持久 cookie。
            // rememberMe 是登录第一步（密码校验）时存进 session 的，这里取出来用。
            req.session.cookie.maxAge = getSessionMaxAgeMs(req, req.session.rememberMe);
            delete req.session.rememberMe;

            res.status(200).json({
                message: '登录成功。',
                user: { id: user.id, username: user.username }
            });
        } else {
            console.log(`用户 ${user.username} 2FA 验证失败: 验证码错误。`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
            ipBlacklistService.recordFailedAttempt(clientIp);
            auditLogService.logAction('LOGIN_FAILURE', { userId: user.id, username: user.username, reason: 'Invalid 2FA token', ip: clientIp });
            notificationService.sendNotification('LOGIN_FAILURE', { userId: user.id, username: user.username, reason: 'Invalid 2FA token', ip: clientIp }); 
            res.status(401).json({ message: '验证码无效。' });
        }

    } catch (error) {
        console.error(`用户 ${userId} 2FA 验证时发生内部错误:`, error);
        res.status(500).json({ message: '两步验证过程中发生内部服务器错误。' });
    }
};


/**
 * 处理修改密码请求 (PUT /api/v1/auth/password)
 */
export const changePassword = async (req: Request, res: Response): Promise<void> => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.userId; 

    if (!userId || req.session.requiresTwoFactor) {
        res.status(401).json({ message: '用户未认证或认证未完成，请先登录。' });
        return;
    }

    // 当前密码可以为空：桌面端默认账号本来就没有密码，这里做的是「设置密码」而不是「改密码」
    const oldPassword = typeof currentPassword === 'string' ? currentPassword : '';

    if (!newPassword || typeof newPassword !== 'string') {
        res.status(400).json({ message: '新密码不能为空。' });
        return;
    }
    if (newPassword.length < 8) {
        res.status(400).json({ message: '新密码长度至少需要 8 位。' });
        return;
    }

    try {
        const db = await getDbInstance(); 
        const user = await getDb<User>(db, 'SELECT id, hashed_password FROM users WHERE id = ?', [userId]);



        if (!user) {
            console.error(`修改密码错误: 未找到 ID 为 ${userId} 的用户。`);
            res.status(404).json({ message: '用户不存在。' });
            return;
        }

        // 已有密码：必须验旧密码，且新旧不能相同。没有密码：跳过这两项校验（等同首次设置）。
        if (isPasswordSet(user.hashed_password)) {
            if (!oldPassword) {
                res.status(400).json({ message: '当前密码不能为空。' });
                return;
            }
            const isMatch = await bcrypt.compare(oldPassword, user.hashed_password);
            if (!isMatch) {
                console.log(`修改密码尝试失败: 当前密码错误 - 用户 ID ${userId}`);
                res.status(400).json({ message: '当前密码不正确。' });
                return;
            }
            if (oldPassword === newPassword) {
                res.status(400).json({ message: '新密码不能与当前密码相同。' });
                return;
            }
        }

        const saltRounds = 10;
        const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);
        const now = Math.floor(Date.now() / 1000);


        const result = await runDb(db,
            'UPDATE users SET hashed_password = ?, updated_at = ? WHERE id = ?',
            [newHashedPassword, now, userId]
        );

        if (result.changes === 0) {
            console.error(`修改密码错误: 更新影响行数为 0 - 用户 ID ${userId}`);
            throw new Error('未找到要更新的用户'); 
        }

        console.log(`用户 ${userId} 密码已成功修改。`);
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown'; 
        auditLogService.logAction('PASSWORD_CHANGED', { userId, ip: clientIp });
        notificationService.sendNotification('PASSWORD_CHANGED', { userId, ip: clientIp }); 

        res.status(200).json({ message: '密码已成功修改。' });

    } catch (error) {
        console.error(`修改用户 ${userId} 密码时发生内部错误:`, error);
        res.status(500).json({ message: '修改密码过程中发生内部服务器错误。' });
    }
};

/**
 * 开始 2FA 设置流程 (POST /api/v1/auth/2fa/setup)
 * 生成临时密钥和二维码
 */
export const setup2FA = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const username = req.session.username; 

    if (!userId || !username || req.session.requiresTwoFactor) {
        res.status(401).json({ message: '用户未认证或认证未完成。' });
        return;
    }

    try {
        const db = await getDbInstance();
        const user = await getDb<{ two_factor_secret: string | null }>(db, 'SELECT two_factor_secret FROM users WHERE id = ?', [userId]);
        const existingSecret = user ? user.two_factor_secret : null;

    
        if (existingSecret) {
            res.status(400).json({ message: '两步验证已启用。如需重置，请先禁用。' });
            return;
        }

        const secret = speakeasy.generateSecret({
            length: 20,
            name: `NexusTerminal (${username})` 
        });

        req.session.tempTwoFactorSecret = secret.base32;

        if (!secret.otpauth_url) {
            throw new Error('无法生成 OTP Auth URL');
        }

        qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
            if (err) {
                console.error('生成二维码时出错:', err);
                throw new Error('生成二维码失败');
            }
            res.json({
                secret: secret.base32, 
                qrCodeUrl: data_url    
            });
        });

    } catch (error: any) {
        console.error(`用户 ${userId} 设置 2FA 时出错:`, error);
        res.status(500).json({ message: '设置两步验证时发生错误。', error: error.message });
    }
};




/**
 * 验证并激活 2FA (POST /api/v1/auth/2fa/verify)
 */
export const verifyAndActivate2FA = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body;
    const userId = req.session.userId;
    const tempSecret = req.session.tempTwoFactorSecret; 

    if (!userId || req.session.requiresTwoFactor) {
        res.status(401).json({ message: '用户未认证或认证未完成。' });
        return;
    }

    if (!tempSecret) {
        res.status(400).json({ message: '未找到临时密钥，请重新开始设置流程。' });
        return;
    }

    if (!token) {
        res.status(400).json({ message: '验证码不能为空。' });
        return;
    }

    try {
        const db = await getDbInstance();
        const verified = speakeasy.totp.verify({
            secret: tempSecret,
            encoding: 'base32',
            token: token,
            window: 1 
        });

        if (verified) {
            const now = Math.floor(Date.now() / 1000);
            const result = await runDb(db,
                'UPDATE users SET two_factor_secret = ?, updated_at = ? WHERE id = ?',
                [tempSecret, now, userId]
            );

            if (result.changes === 0) {
                console.error(`激活 2FA 错误: 更新影响行数为 0 - 用户 ID ${userId}`);
                throw new Error('未找到要更新的用户');
            }

            console.log(`用户 ${userId} 已成功激活两步验证。`);
            const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
            auditLogService.logAction('2FA_ENABLED', { userId, ip: clientIp });
            notificationService.sendNotification('2FA_ENABLED', { userId, ip: clientIp }); 

            delete req.session.tempTwoFactorSecret;

            res.status(200).json({ message: '两步验证已成功激活！' });
        } else {
            console.log(`用户 ${userId} 2FA 激活失败: 验证码错误。`);
            res.status(400).json({ message: '验证码无效。' });
        }

    } catch (error: any) {
        console.error(`用户 ${userId} 验证并激活 2FA 时出错:`, error);
        res.status(500).json({ message: '验证两步验证码时发生错误。', error: error.message });
    }
};

/**
 * 禁用 2FA (DELETE /api/v1/auth/2fa)
 */
export const disable2FA = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const { password } = req.body; 

    if (!userId || req.session.requiresTwoFactor) {
        res.status(401).json({ message: '用户未认证或认证未完成。' });
        return;
    }

    if (!password) {
        res.status(400).json({ message: '需要提供当前密码才能禁用两步验证。' });
        return;
    }

    try {
        const db = await getDbInstance(); 
        const user = await getDb<User>(db, 'SELECT id, hashed_password FROM users WHERE id = ?', [userId]);

        if (!user) {
            res.status(404).json({ message: '用户不存在。' }); return;
        }
        // 没有密码的账号无法用密码验证身份，先让用户去设置密码
        if (!isPasswordSet(user.hashed_password)) {
            res.status(400).json({ message: '当前账号尚未设置密码，请先在安全设置里设置密码后再关闭两步验证。' }); return;
        }
        const isMatch = await bcrypt.compare(password, user.hashed_password);
        if (!isMatch) {
            res.status(400).json({ message: '当前密码不正确。' }); return;
        }

        const now = Math.floor(Date.now() / 1000);
        const result = await runDb(db,
            'UPDATE users SET two_factor_secret = NULL, updated_at = ? WHERE id = ?',
            [now, userId]
        );

        if (result.changes === 0) {
            console.error(`禁用 2FA 错误: 更新影响行数为 0 - 用户 ID ${userId}`);
            throw new Error('未找到要更新的用户');
        }

        console.log(`用户 ${userId} 已成功禁用两步验证。`);
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        auditLogService.logAction('2FA_DISABLED', { userId, ip: clientIp });
        notificationService.sendNotification('2FA_DISABLED', { userId, ip: clientIp }); 

        res.status(200).json({ message: '两步验证已成功禁用。' });

    } catch (error: any) {
        console.error(`用户 ${userId} 禁用 2FA 时出错:`, error);
        res.status(500).json({ message: '禁用两步验证时发生错误。', error: error.message });
    }
};

/**
 * 检查是否需要进行初始设置 (GET /api/v1/auth/needs-setup)
 * 如果数据库中没有用户，则需要设置。
 */
export const needsSetup = async (req: Request, res: Response): Promise<void> => {
    try {
        const db = await getDbInstance(); 
        const row = await getDb<{ count: number }>(db, 'SELECT COUNT(*) as count FROM users');
        const userCount = row ? row.count : 0;

        res.status(200).json({ needsSetup: userCount === 0 });

    } catch (error) {
        console.error('检查设置状态时发生内部错误:', error);
        res.status(500).json({ message: '检查设置状态时发生错误。', needsSetup: false });
    }
};

/**
 * 处理初始管理员账号设置请求 (POST /api/v1/auth/setup)
 */
export const setupAdmin = async (req: Request, res: Response): Promise<void> => {
    const { username, password, confirmPassword } = req.body;

    if (!username || !password || !confirmPassword) {
        res.status(400).json({ message: '用户名、密码和确认密码不能为空。' });
        return;
    }
    if (password !== confirmPassword) {
        res.status(400).json({ message: '两次输入的密码不匹配。' });
        return;
    }
     if (password.length < 8) {
        res.status(400).json({ message: '密码长度至少需要 8 位。' });
        return;
    }


    try {
        const db = await getDbInstance();
        const row = await getDb<{ count: number }>(db, 'SELECT COUNT(*) as count FROM users');
        const userCount = row ? row.count : 0;

        if (userCount > 0) {
            console.warn('尝试在已有用户的情况下执行初始设置。');
            res.status(403).json({ message: '设置已完成，无法重复执行。' });
            return;
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const now = Math.floor(Date.now() / 1000);

        const result = await runDb(db,
            `INSERT INTO users (username, hashed_password, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            [username, hashedPassword, now, now]
        );

        if (typeof result.lastID !== 'number' || result.lastID <= 0) {
             console.error('创建初始管理员后未能获取有效的 lastID。可能原因：用户名已存在或其他数据库错误。');
             throw new Error('创建初始管理员失败，可能用户名已存在。');
        }
        const newUser = { id: result.lastID };


        console.log(`初始管理员账号 '${username}' (ID: ${newUser.id}) 已成功创建。`);
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        auditLogService.logAction('ADMIN_SETUP_COMPLETE', { userId: newUser.id, username, ip: clientIp });
        notificationService.sendNotification('ADMIN_SETUP_COMPLETE', { userId: newUser.id, username, ip: clientIp }); 

        res.status(201).json({ message: '初始管理员账号创建成功！' });

    } catch (error: any) {
        console.error('初始设置过程中发生内部错误:', error);
        res.status(500).json({ message: error.message || '初始设置过程中发生内部服务器错误。' });
    }
};

/**
 * 桌面端自动登录 (POST /api/v1/auth/auto-login)
 *
 * 只对「桌面端 + 本机 + 账号没有密码」成立：打开软件直接就是登录状态，不弹登录页。
 * 设了密码的账号不走这里——它们登录过一次之后靠持久 cookie 常驻。
 */
export const desktopAutoLogin = async (req: Request, res: Response): Promise<void> => {
    // 非桌面端不暴露这个入口，免得 Web 部署被当成后门
    if (!isDesktopRuntime()) {
        res.status(404).json({ message: 'Not Found' });
        return;
    }
    if (!isLocalRequest(req)) {
        res.status(403).json({ autoLogin: false, message: '仅限本机。' });
        return;
    }

    try {
        const db = await getDbInstance();
        const user = await getDb<User>(db,
            `SELECT id, username, hashed_password, two_factor_secret FROM users
             WHERE hashed_password = ? ORDER BY id LIMIT 1`,
            [NO_PASSWORD]);

        // 没有免密账号，或该账号还开着 2FA → 老老实实走登录页
        if (!user || user.two_factor_secret) {
            res.status(200).json({ autoLogin: false });
            return;
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.requiresTwoFactor = false;
        req.session.cookie.maxAge = DESKTOP_SESSION_MAX_AGE_MS;

        console.log(`[Desktop] 已自动登录免密账号: ${user.username}`);
        res.status(200).json({
            autoLogin: true,
            user: { id: user.id, username: user.username, isTwoFactorEnabled: false, hasPassword: false },
        });
    } catch (error: any) {
        console.error('桌面端自动登录失败:', error);
        res.status(500).json({ autoLogin: false, message: '自动登录失败。' });
    }
};

/**
 * 处理用户登出请求 (POST /api/v1/auth/logout)
 */
export const logout = (req: Request, res: Response): void => {
    const userId = req.session.userId;
    const username = req.session.username;

    req.session.destroy((err) => {
        if (err) {
            console.error(`销毁用户 ${userId} (${username}) 的会话时出错:`, err);
            res.status(500).json({ message: '登出时发生服务器内部错误。' });
        } else {
            /**
             * 关键：把 req.session 置空，否则 express-session 会在响应收尾时把会话写回去。
             *
             * `req.session.destroy()` 只负责删 store 里的记录；它**没有**被 express-session
             * 包装（只包装了 reload/save），所以 destroy 之后 `req.session` 仍然指向那个对象，
             * `shouldDestroy()` 依然是 false。响应收尾时 `shouldTouch()` 判定为真 ——
             * 而 session-file-store 实现了 `touch`（读出来再写回去）—— 刚删掉的会话文件
             * 就被原样复活了。
             *
             * 表现：cookie 清掉了，但旧 cookie（另一个标签页、被复制走的、没清干净的）
             * 依然能 200 通过认证。配合 index.ts 里的 `unset: 'destroy'`，
             * 这里置空后 express-session 才会真正走 destroy 分支。
             */
            (req as any).session = null;
            console.log(`用户 ${userId} (${username}) 已成功登出。`);
            /**
             * 清除 cookie 必须带上与会话中间件**完全一致**的 path/同站属性，
             * 否则浏览器认为这是另一个 cookie，旧的 connect.sid 会原地留着 ——
             * 表现为「点了登出，刷新一下又进去了」。
             */
            res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax' });
            if (userId) { 
                 const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
                 auditLogService.logAction('LOGOUT', { userId, username, ip: clientIp });
                 notificationService.sendNotification('LOGOUT', { userId, username, ip: clientIp }); 
            }
            res.status(200).json({ message: '已成功登出。' });
        }
    });
};

/**
 * 获取公共 CAPTCHA 配置 (GET /api/v1/auth/captcha/config)
 * 返回给前端用于显示 CAPTCHA 小部件所需的信息 (不含密钥)。
 */
export const getPublicCaptchaConfig = async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('[AuthController] Received request for public CAPTCHA config.');
        const fullConfig = await settingsService.getCaptchaConfig();

        const publicConfig = {
            enabled: fullConfig.enabled,
            provider: fullConfig.provider,
            hcaptchaSiteKey: fullConfig.hcaptchaSiteKey,
            recaptchaSiteKey: fullConfig.recaptchaSiteKey,
        };

        console.log('[AuthController] Sending public CAPTCHA config to client:', publicConfig);
        res.status(200).json(publicConfig);
    } catch (error: any) {
        console.error('[AuthController] 获取公共 CAPTCHA 配置时出错:', error);
        res.status(500).json({
             enabled: false,
             provider: 'none',
             hcaptchaSiteKey: '',
             recaptchaSiteKey: '',
             error: '获取 CAPTCHA 配置失败'
        });
    }
};

/**
 * 检查系统中是否配置了任何 Passkey (GET /api/v1/auth/passkey/has-configured)
 * 或者特定用户是否配置了 Passkey (GET /api/v1/auth/passkey/has-configured?username=xxx)
 * 公开访问，用于登录页面判断是否显示 Passkey 登录按钮。
 */
export const checkHasPasskeys = async (req: Request, res: Response): Promise<void> => {
    const username = req.query.username as string | undefined;
    try {
        const hasPasskeys = await passkeyService.hasPasskeysConfigured(username);
        res.status(200).json({ hasPasskeys });
    } catch (error: any) {
        console.error(`[AuthController] 检查 Passkey 配置状态时出错 (username: ${username || 'any'}):`, error.message);
        // 即使出错，也返回 false，避免登录流程中断
        res.status(200).json({ hasPasskeys: false, error: '检查 Passkey 配置时出错。' });
    }
};
