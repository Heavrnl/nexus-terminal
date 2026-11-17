import crypto from 'crypto';
import * as client from 'openid-client';
import { settingsRepository } from '../settings/settings.repository';
import { encrypt, decrypt } from '../utils/crypto';
import type {
    OidcProviderConfig,
    OidcProviderPublicConfig,
    OidcProviderSummary,
    UpdateOidcProviderDto,
} from '../types/settings.types';
import { OidcError } from './oidc.errors';

/**
 * OIDC 业务层。
 *
 * 职责边界（契约 §3）：**协议层全部交给 openid-client**（discovery / PKCE / 授权 URL /
 * 授权码交换 / id_token 验签 / nonce / state 校验）。本文件只写业务逻辑：
 * provider 配置的读写与 clientSecret 加解密、发现文档的进程内缓存、以及把库抛出的
 * 协议错误映射成契约 §3.1 的 8 个 `oidc_error` 码。
 *
 * 刻意**没有**手写任何 JWT 解析、JWKS 拉取、RSA 验签或 code_challenge 计算——
 * 那些是 openid-client 的职责，重复实现只会引入不一致的安全缺口。
 */

/** settings 表里存 provider 数组的 key（契约 §1.1） */
export const OIDC_PROVIDERS_SETTING_KEY = 'oidcProviders';

/** 契约 §1.1 的默认 scope */
export const DEFAULT_OIDC_SCOPES = 'openid profile email';

/** 发现文档进程内缓存 TTL（契约 §3：10 分钟） */
export const OIDC_DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** 对 IdP 的 HTTP 调用超时，避免 IdP 无响应时挂死请求线程 */
const OIDC_HTTP_TIMEOUT_MS = 15000;

/** 授权流程中暂存于 session 的一次性参数（契约 §3，单飞：新流程覆盖旧流程） */
export interface OidcFlowState {
    providerId: string;
    mode: 'login' | 'bind';
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    createdAt: number;
}

/** 从 id_token claims 中提取的、业务层需要的身份信息 */
export interface OidcIdentity {
    subject: string;
    email: string | null;
    issuer: string | null;
}

// --- 纯函数（导出以便单测，不依赖 DB 与网络） ---

/** 规范化 issuerUrl：去空白、去尾部斜杠（契约 §1.1 要求不带尾斜杠） */
export function normalizeIssuerUrl(raw: unknown): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

/** 规范化 scopes：空值兜底为契约默认值 */
export function normalizeOidcScopes(raw: unknown): string {
    const scopes = String(raw ?? '').trim();
    return scopes.length > 0 ? scopes : DEFAULT_OIDC_SCOPES;
}

/**
 * 邮箱域名白名单判定（契约 §1.1：逗号分隔，空 = 不限制）。
 *
 * 采用**精确域名匹配**（`user@example.com` 只匹配白名单里的 `example.com`），
 * 刻意不做子域通配——白名单是安全边界，宁可让管理员显式列出每个子域，
 * 也不要用一条隐式的 `endsWith` 规则把边界悄悄放大。
 *
 * 白名单非空但邮箱缺失时判为**不允许**：无法验证的账号不应被自动创建。
 */
export function isEmailDomainAllowed(email: string | null | undefined, allowedEmailDomains: unknown): boolean {
    const whitelist = String(allowedEmailDomains ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    if (whitelist.length === 0) return true;
    if (typeof email !== 'string' || email.length === 0) return false;
    const at = email.lastIndexOf('@');
    if (at < 0 || at === email.length - 1) return false;
    const domain = email.slice(at + 1).trim().toLowerCase();
    return whitelist.includes(domain);
}

/** 清洗出可用作用户名的字符集（用户名会写进 users.username，必须收窄） */
export function sanitizeOidcUsername(raw: unknown): string {
    return String(raw ?? '')
        .normalize('NFKC')
        .replace(/[^A-Za-z0-9._-]/g, '')
        .replace(/^[._-]+/, '')
        .slice(0, 32);
}

/**
 * 由 OIDC 身份推导用户名种子。
 * 优先用邮箱 local-part；没有邮箱时退化为 `oidc-<sub 前 8 位>`。
 * 唯一性由调用方处理（冲突时加 `-oidc-<4hex>` 后缀，见契约 §3.1）。
 */
export function suggestOidcUsername(identity: Pick<OidcIdentity, 'subject' | 'email'>): string {
    const email = typeof identity.email === 'string' ? identity.email : '';
    const at = email.lastIndexOf('@');
    const localPart = at > 0 ? email.slice(0, at) : '';
    const candidate = sanitizeOidcUsername(localPart || `oidc-${String(identity.subject ?? '').slice(0, 8)}`);
    if (candidate.length > 0) return candidate;
    return `oidc-${crypto.randomBytes(2).toString('hex')}`;
}

/** 缺 ENCRYPTION_KEY 或密文损坏时不要让整个设置页炸掉，降级为空密钥并告警 */
function safeDecryptSecret(ciphertext: string): string {
    if (!ciphertext) return '';
    try {
        return decrypt(ciphertext);
    } catch (error) {
        console.warn('[OIDC] clientSecret 解密失败，该 provider 将无法完成登录：', error);
        return '';
    }
}

/**
 * 把 DB 里读到的任意 JSON 形状收敛成完整的 OidcProviderConfig（缺字段补默认值）。
 *
 * 导出以便单测：它决定「落库/读回的到底是什么」，缺字段的兜底值（尤其 enabled、
 * autoCreateUser 这类布尔开关）是安全相关分支，不能只靠人工阅读保证。
 */
export function coerceProvider(input: unknown): OidcProviderConfig {
    const raw = (input ?? {}) as Record<string, unknown>;
    const createdAt = Number(raw.createdAt);
    return {
        id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : crypto.randomUUID(),
        name: typeof raw.name === 'string' ? raw.name : '',
        enabled: raw.enabled === true,
        issuerUrl: normalizeIssuerUrl(raw.issuerUrl),
        clientId: typeof raw.clientId === 'string' ? raw.clientId : '',
        clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : '',
        scopes: normalizeOidcScopes(raw.scopes),
        autoCreateUser: raw.autoCreateUser === true,
        allowedEmailDomains: typeof raw.allowedEmailDomains === 'string' ? raw.allowedEmailDomains : '',
        iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : '',
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Math.floor(Date.now() / 1000),
    };
}

/**
 * 屏蔽密钥，供 `/settings` 与 `PUT /settings` 回包使用（契约 §1.3）。
 *
 * 导出以便单测：这是密钥不外泄的**唯一**出口，一旦这里漏掉字段，密文就会随设置接口
 * 回到前端。安全性关键，必须有断言钉死。
 */
export function toPublicConfig(provider: OidcProviderConfig): OidcProviderPublicConfig {
    const { clientSecret, ...rest } = provider;
    return { ...rest, hasClientSecret: typeof clientSecret === 'string' && clientSecret.length > 0 };
}

interface CachedConfiguration {
    /** issuerUrl|clientId|clientSecret 的指纹：任一变化即视为缓存失效 */
    signature: string;
    config: client.Configuration;
    expiresAt: number;
}

export class OidcService {
    /** providerId → 发现结果缓存（契约 §3：按 issuerUrl 进程内缓存，TTL 10min） */
    private readonly configurationCache = new Map<string, CachedConfiguration>();

    /** 清空发现文档缓存（配置变更后或单测隔离用） */
    clearConfigurationCache(): void {
        this.configurationCache.clear();
    }

    // --- provider 配置读写 ---

    /** 读原始存储（clientSecret 仍是密文）。仅用于不需要密钥的场景，如取显示名。 */
    async getStoredProviders(): Promise<OidcProviderConfig[]> {
        const stored = await settingsRepository.getSetting(OIDC_PROVIDERS_SETTING_KEY);
        if (!stored) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(stored);
        } catch (error) {
            console.warn('[OIDC] oidcProviders 设置项不是合法 JSON，按空列表处理：', error);
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.map(coerceProvider);
    }

    /** 读 provider 列表并解密 clientSecret（登录流程内部使用，绝不直接回给前端） */
    async getProviders(): Promise<OidcProviderConfig[]> {
        const providers = await this.getStoredProviders();
        return providers.map((provider) => ({
            ...provider,
            clientSecret: safeDecryptSecret(provider.clientSecret),
        }));
    }

    async getProviderById(id: string): Promise<OidcProviderConfig | null> {
        const providers = await this.getProviders();
        return providers.find((provider) => provider.id === id) ?? null;
    }

    /** 登录页用：仅 enabled，只暴露 {id,name,iconUrl}（契约 §2 第 1 条） */
    async getEnabledProviderSummaries(): Promise<OidcProviderSummary[]> {
        const providers = await this.getStoredProviders();
        return providers
            .filter((provider) => provider.enabled)
            .map((provider) => ({ id: provider.id, name: provider.name, iconUrl: provider.iconUrl }));
    }

    /** 设置页用：全量配置，密钥被替换为 hasClientSecret（契约 §1.3） */
    async getProviderPublicConfigs(): Promise<OidcProviderPublicConfig[]> {
        const providers = await this.getStoredProviders();
        return providers.map(toPublicConfig);
    }

    /** 已绑定列表需要 provider 显示名；已删除的 provider 由调用方回退成 providerId */
    async getProviderNameMap(): Promise<Map<string, string>> {
        const providers = await this.getStoredProviders();
        return new Map(providers.map((provider) => [provider.id, provider.name]));
    }

    /**
     * 全量替换 provider 数组（契约 §2 第 7 条 + §1.3）。
     *
     * - 新建项（无 id，或 id 在现有配置里找不到）→ 服务端生成 crypto.randomUUID()。
     * - 已有项 → 沿用原 id 与 createdAt（id 创建后不可变）。
     * - clientSecret 为空串 / undefined / null / 不传 → **保留原密钥**；仅非空字符串才覆盖。
     */
    async saveProviders(inputs: UpdateOidcProviderDto[]): Promise<OidcProviderPublicConfig[]> {
        const existing = await this.getStoredProviders();
        const existingById = new Map(existing.map((provider) => [provider.id, provider]));
        const usedIds = new Set<string>();
        const next: OidcProviderConfig[] = [];

        for (const input of inputs) {
            const dto = (input ?? {}) as UpdateOidcProviderDto;
            const matched = dto.id ? existingById.get(dto.id) : undefined;
            const id = matched && !usedIds.has(matched.id) ? matched.id : crypto.randomUUID();
            usedIds.add(id);

            const previous = matched ?? existingById.get(id);
            const incomingSecret = dto.clientSecret;
            const clientSecret =
                typeof incomingSecret === 'string' && incomingSecret.length > 0
                    ? encrypt(incomingSecret)
                    : previous?.clientSecret ?? '';

            next.push({
                id,
                name: typeof dto.name === 'string' ? dto.name : previous?.name ?? '',
                enabled: dto.enabled === undefined ? previous?.enabled ?? false : dto.enabled === true,
                issuerUrl: normalizeIssuerUrl(dto.issuerUrl ?? previous?.issuerUrl ?? ''),
                clientId: typeof dto.clientId === 'string' ? dto.clientId : previous?.clientId ?? '',
                clientSecret,
                scopes: normalizeOidcScopes(dto.scopes ?? previous?.scopes),
                autoCreateUser:
                    dto.autoCreateUser === undefined
                        ? previous?.autoCreateUser ?? false
                        : dto.autoCreateUser === true,
                allowedEmailDomains:
                    typeof dto.allowedEmailDomains === 'string'
                        ? dto.allowedEmailDomains
                        : previous?.allowedEmailDomains ?? '',
                iconUrl: typeof dto.iconUrl === 'string' ? dto.iconUrl : previous?.iconUrl ?? '',
                createdAt: previous?.createdAt ?? Math.floor(Date.now() / 1000),
            });
        }

        await settingsRepository.setSetting(OIDC_PROVIDERS_SETTING_KEY, JSON.stringify(next));
        // 配置可能改了 issuer/clientId/secret，旧发现结果不能再用
        this.clearConfigurationCache();
        return next.map(toPublicConfig);
    }

    // --- openid-client 协议层封装 ---

    /**
     * 取得（并缓存）某个 provider 的 openid-client Configuration。
     *
     * 失败一律归为 `server_error`：发现文档拿不到说明 provider 配置有误或 IdP 不可达，
     * 这既不是「provider 不存在」也不是「被禁用」，不该复用那两个码。
     */
    async resolveConfiguration(provider: OidcProviderConfig): Promise<client.Configuration> {
        if (!provider.issuerUrl || !provider.clientId) {
            throw new OidcError('provider_not_found', '该 OIDC provider 尚未完成配置（缺少 issuerUrl 或 clientId）。');
        }

        let issuer: URL;
        try {
            issuer = new URL(provider.issuerUrl);
        } catch {
            throw new OidcError('provider_not_found', `issuerUrl 不是合法 URL：${provider.issuerUrl}`);
        }

        const signature = `${provider.issuerUrl}|${provider.clientId}|${provider.clientSecret}`;
        const now = Date.now();
        const cached = this.configurationCache.get(provider.id);
        if (cached && cached.signature === signature && cached.expiresAt > now) {
            return cached.config;
        }

        // 明文 http 的 issuer（本地 Keycloak 联调常见）需要显式放行，否则库会拒绝非 HTTPS。
        // 是否走明文完全由管理员填写的 issuerUrl 决定，不是全局开关。
        const allowInsecure = issuer.protocol === 'http:';

        // openid-client v6 **默认不校验 id_token 签名**（它认为 token endpoint 走 TLS，
        // issuer 已被 TLS 认证）。但 OIDC Core §3.1.3.7 把签名校验列为 MUST，且 TLS 只能
        // 证明「从对端拿到」，不能证明「token 是本 client 的 issuer 签的」。
        // 不开启的话，任何能拿到 code 的人都能自签一个 id_token 冒充任意用户。
        // 注意：每次**新建** Configuration 后都必须重新开启——它是挂在实例上的，
        // 不会随 discovery 结果或新实例自动继承。
        const harden = (target: client.Configuration): client.Configuration => {
            if (allowInsecure) client.allowInsecureRequests(target);
            client.enableNonRepudiationChecks(target);
            target.timeout = OIDC_HTTP_TIMEOUT_MS;
            return target;
        };

        try {
            let config = await client.discovery(
                issuer,
                provider.clientId,
                provider.clientSecret,
                undefined,
                allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined
            );
            harden(config);

            // token endpoint 认证方式协商：库默认 client_secret_post；若 IdP 只认 basic 则改用它。
            const methods = config.serverMetadata().token_endpoint_auth_methods_supported;
            if (
                Array.isArray(methods) &&
                methods.length > 0 &&
                !methods.includes('client_secret_post') &&
                methods.includes('client_secret_basic')
            ) {
                // 这是一个**全新对象**，旧 config 上的设置不会带过来，必须再过一次 harden()
                config = harden(
                    new client.Configuration(
                        config.serverMetadata(),
                        provider.clientId,
                        provider.clientSecret,
                        client.ClientSecretBasic(provider.clientSecret)
                    )
                );
            }

            this.configurationCache.set(provider.id, {
                signature,
                config,
                expiresAt: now + OIDC_DISCOVERY_TTL_MS,
            });
            return config;
        } catch (error) {
            console.warn(`[OIDC] provider ${provider.id} 发现文档获取失败：`, error);
            throw new OidcError('server_error', 'OIDC 发现文档获取失败。');
        }
    }

    /**
     * 构造授权跳转 URL，并返回需要存进 session 的一次性参数。
     * PKCE 的 verifier/challenge、state、nonce 全部由 openid-client 生成。
     */
    async buildAuthorizationRequest(
        provider: OidcProviderConfig,
        redirectUri: string,
        mode: 'login' | 'bind'
    ): Promise<{ url: string; flow: OidcFlowState }> {
        const config = await this.resolveConfiguration(provider);
        const codeVerifier = client.randomPKCECodeVerifier();
        const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
        const state = client.randomState();
        const nonce = client.randomNonce();

        const url = client.buildAuthorizationUrl(config, {
            redirect_uri: redirectUri,
            scope: provider.scopes,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state,
            nonce,
        });

        return {
            url: url.href,
            flow: {
                providerId: provider.id,
                mode,
                state,
                nonce,
                codeVerifier,
                redirectUri,
                createdAt: Math.floor(Date.now() / 1000),
            },
        };
    }

    /**
     * 用授权码换 token 并校验 id_token。
     * 签名、`iss`/`aud`/`exp`/`nonce` 校验全部由 openid-client（jose）完成。
     */
    async exchangeAuthorizationCode(
        provider: OidcProviderConfig,
        currentUrl: URL,
        flow: OidcFlowState
    ): Promise<OidcIdentity> {
        const config = await this.resolveConfiguration(provider);

        let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
        try {
            tokens = await client.authorizationCodeGrant(config, currentUrl, {
                pkceCodeVerifier: flow.codeVerifier,
                expectedState: flow.state,
                expectedNonce: flow.nonce,
                idTokenExpected: true,
            });
        } catch (error) {
            throw mapAuthorizationCodeGrantError(error);
        }

        const claims = tokens.claims();
        // 缺 sub 视为无效（契约 §3）
        if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
            throw new OidcError('invalid_id_token', 'id_token 缺少 sub 声明。');
        }

        return {
            subject: claims.sub,
            email: typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null,
            issuer: typeof claims.iss === 'string' ? claims.iss : null,
        };
    }
}

/**
 * 把 openid-client / oauth4webapi 抛出的协议错误映射成契约 §3.1 的封闭错误码。
 *
 * 判据来自 oauth4webapi 的稳定错误码常量（`OAUTH_*`）与错误类，而不是错误文案全文匹配——
 * 文案会随版本变，错误码不会。仅 state 那一处需要看文案，因为库没有为它单独设码。
 */
/**
 * 把错误及其 cause 链拍平成 { messages, codes }。
 *
 * 必须走 cause 链：openid-client 的 `errorHandler` 会把底层异常**重新包一层**
 * （`e('invalid response encountered', err, err.code)`，见 openid-client/build/index.js:114-138），
 * 于是顶层的 message 只有一句无信息量的 `invalid response encountered`，真正的
 * `JWT signature verification failed` / `"state" response parameter` 都藏在 `cause` 里。
 * 只看顶层会把这些全部归成兜底码，丢失契约 §3.1 要求的精确错误码。
 */
function flattenErrorChain(error: unknown): { messages: string; codes: string[] } {
    const messages: string[] = [];
    const codes: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current && depth < 8; depth += 1) {
        if (current instanceof Error) {
            if (current.message) messages.push(current.message);
        } else if (typeof current === 'string') {
            messages.push(current);
        }
        const code = (current as { code?: unknown } | null)?.code;
        if (typeof code === 'string') codes.push(code);
        current = (current as { cause?: unknown } | null)?.cause;
    }
    return { messages: messages.join(' | '), codes };
}

export function mapAuthorizationCodeGrantError(error: unknown): OidcError {
    if (error instanceof OidcError) return error;

    const topMessage = error instanceof Error ? error.message : String(error);
    const { messages, codes } = flattenErrorChain(error);

    // IdP 在授权响应里直接回绝（?error=access_denied ...）
    if (error instanceof client.AuthorizationResponseError) {
        return new OidcError('token_exchange_failed', topMessage);
    }

    // state 校验失败：库抛 OperationProcessingError，文案里带 "state" response parameter。
    // 注意这段文案可能在 cause 里，所以用拍平后的 messages。
    //
    // oauth4webapi 有三处 state 抛错，词序不同，必须两种都覆盖：
    //   `unexpected "state" response parameter value` / `... encountered`（值被篡改或多余）
    //   `response parameter "state" missing`（state 被整个剥离——CSRF 攻击形态）
    // 只匹配前者会把 state 缺失误报成 token_exchange_failed。
    if (messages.includes('"state" response parameter') || messages.includes('response parameter "state"')) {
        return new OidcError('state_mismatch', messages);
    }

    // id_token 的签名 / claims / 时间戳 / 密钥选择失败
    if (
        codes.includes('OAUTH_JWT_TIMESTAMP_CHECK_FAILED') ||
        codes.includes('OAUTH_JWT_CLAIM_COMPARISON_FAILED') ||
        codes.includes('OAUTH_KEY_SELECTION_FAILED') ||
        codes.includes('OAUTH_PARSE_ERROR')
    ) {
        return new OidcError('invalid_id_token', messages);
    }

    // 签名验不过、claims 缺失/类型不对、typ/alg 不对等，库统一归到 OAUTH_INVALID_RESPONSE，
    // 只能按文案细分。'JWT' 覆盖了 'JWT signature verification failed'、
    // 'unexpected JWT "typ"'、'JWT "nonce" claim missing' 等。
    if (messages.includes('JWT') || messages.includes('ID Token') || messages.includes('id_token')) {
        return new OidcError('invalid_id_token', messages);
    }

    // 回调里没有 code：是授权响应的问题，不是 id_token 的问题
    if (messages.includes('authorization code')) {
        return new OidcError('token_exchange_failed', messages);
    }

    // token endpoint 返回了错误响应（4xx/5xx）
    if (error instanceof client.ResponseBodyError || error instanceof client.WWWAuthenticateChallengeError) {
        return new OidcError('token_exchange_failed', messages);
    }

    // 网络不可达 / 超时 / 其它未预期异常：授权码没能换到 token
    return new OidcError('token_exchange_failed', messages || topMessage);
}

export const oidcService = new OidcService();
