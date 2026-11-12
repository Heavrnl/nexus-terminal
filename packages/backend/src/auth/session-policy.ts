import type { Request } from 'express';

/**
 * 会话持久化策略（纯函数，不依赖数据库 / 环境初始化，可直接单测）。
 *
 * 背景：Web 端"每隔一段时间就要重新登录"的根因就在这个策略里 ——
 * 以前它只区分"桌面端本机"和"其他"，而"其他"一律写 `maxAge = undefined`，
 * 也就是会话 cookie。见 `getSessionMaxAgeMs()` 的注释。
 */

/**
 * 桌面端本机会话的有效期：1 年。
 * 桌面端应该「常驻登录」——关掉应用再打开不该重新登录一遍。
 */
export const DESKTOP_SESSION_MAX_AGE_MS = 315360000000;

/**
 * Web / Docker 部署的会话有效期：180 天。
 *
 * 以前 Web 端登录**从不**写 maxAge —— `login()` 里只有 `rememberMe` 为真才设置
 * 持久 cookie，而登录页的「记住我」默认是未勾选的。于是浏览器拿到的
 * `connect.sid` 是一个「会话 cookie」：浏览器一关就没了，就算不关，
 * session-file-store 也会按 `options.ttl`（见 index.ts）在服务端把会话文件回收。
 * 用户感受到的就是"每隔一段时间都要重新登录一遍"。
 *
 * 现在 Web 端默认就发持久 cookie。180 天是个折中：足够长，用户基本感知不到；
 * 又不至于让一个被遗忘的浏览器永远持有有效凭据。
 */
export const WEB_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** 后端是否跑在桌面客户端里（由 Tauri 启动 sidecar 时注入） */
export function isDesktopRuntime(): boolean {
    const raw = (process.env.NEXUS_DESKTOP || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * 请求是否来自本机。
 *
 * ⚠️ 必须用 socket.remoteAddress，不能用 req.ip：index.ts 里 `app.set('trust proxy', true)`，
 * req.ip 会采信客户端自己发来的 X-Forwarded-For，任何远程请求都能伪造成 127.0.0.1。
 * socket 上的对端地址无法伪造。
 */
export function isLocalRequest(req: Request): boolean {
    const addr = req.socket?.remoteAddress || '';
    if (addr === '::1') return true;
    // IPv4-mapped IPv6：::ffff:127.0.0.1
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return /^127\./.test(v4);
}

/**
 * 当前登录应该写多长的持久 cookie（毫秒）。
 *
 * - 桌面端 + 本机请求：1 年，开机即用、常驻登录；
 * - 其他情况（Web / Docker，或桌面端但来自局域网）：180 天。
 *
 * 这个函数不再返回「要不要持久」，而是统一返回**持久时长**：
 * 「永远用会话 cookie」这条分支本身就是 Web 端反复掉登录的根因，
 * 所以现在所有成功登录都必须落到一个明确的 maxAge 上。
 * 显式勾选了「记住我」的用户仍然得到更长/同等的待遇，语义不会被削弱。
 */
export function getSessionMaxAgeMs(req: Request, rememberMe?: boolean): number {
    // 「记住我」是用户显式表达的长期登录意愿，桌面端和 Web 端都按 1 年处理
    if (rememberMe) return DESKTOP_SESSION_MAX_AGE_MS;
    if (isDesktopRuntime() && isLocalRequest(req)) return DESKTOP_SESSION_MAX_AGE_MS;
    return WEB_SESSION_MAX_AGE_MS;
}

/**
 * 当前登录是否要写成持久 cookie（关掉浏览器/WebView 也保留）。
 *
 * @deprecated 保留是为了不破坏既有调用方；新代码请直接用 `getSessionMaxAgeMs()`。
 * 注意它的返回值已经变了：以前 Web 端返回 false（= 会话 cookie），
 * 现在 Web 端也返回 true —— 那正是要修的那个 bug。
 */
export function shouldPersistSession(req: Request): boolean {
    return getSessionMaxAgeMs(req) > 0;
}

/** hashed_password 为空串 == 该账号没有设置密码 */
export const NO_PASSWORD = '';

export function isPasswordSet(hashedPassword: string | null | undefined): boolean {
    return typeof hashedPassword === 'string' && hashedPassword.length > 0;
}
