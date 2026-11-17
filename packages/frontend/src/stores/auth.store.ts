import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; 
import router from '../router'; 
import { setLocale } from '../i18n'; 
import { isDesktopApp } from '../utils/platform';

function getLoginRedirectTarget(): string {
    const lastRoute = localStorage.getItem('nexus_last_route');
    if (lastRoute && lastRoute !== '/' && !lastRoute.includes('/login') && !lastRoute.includes('/setup')) {
        return lastRoute;
    }
    return '/';
} 

// 扩展的用户信息接口，包含 2FA 状态和语言偏好
interface UserInfo {
    id: number;
    username: string;
    isTwoFactorEnabled?: boolean; // 后端 /status 接口会返回这个
    hasPassword?: boolean; // 桌面端默认账号没有密码，后端 /status 会返回 false
    language?: 'en' | 'zh'; // 用户偏好语言
}

// Passkey Information Interface
export interface PasskeyInfo { // + Export 接口
    credentialID: string;
    publicKey: string; // Or a more specific type if available
    counter: number;
    transports?: AuthenticatorTransport[]; // e.g., "usb", "nfc", "ble", "internal"
    creationDate: string; // ISO date string
    lastUsedDate: string; // ISO date string
    name?: string; // User-friendly name for the passkey
    // Add other relevant fields from your backend response
}

// 登录请求的载荷接口
interface LoginPayload {
    username: string;
    password: string;
    rememberMe?: boolean; // 可选的“记住我”标志
}

// OIDC 登录页用的最小 provider 信息（契约 §1.1 / §2 第 1 条）
export interface OidcProviderSummary {
    id: string;
    name: string;
    iconUrl: string;
}

// Public CAPTCHA Config Interface (mirrors backend public config)
interface PublicCaptchaConfig {
    enabled: boolean;
    provider: 'hcaptcha' | 'recaptcha' | 'none';
    hcaptchaSiteKey?: string;
    recaptchaSiteKey?: string;
}

// Backend's full CAPTCHA Settings Interface (as returned by /settings/captcha)
interface FullCaptchaSettings {
    enabled: boolean;
    provider: 'hcaptcha' | 'recaptcha' | 'none';
    hcaptchaSiteKey?: string;
    hcaptchaSecretKey?: string; // We won't use this in authStore
    recaptchaSiteKey?: string;
    recaptchaSecretKey?: string; // We won't use this in authStore
}


// Auth Store State 接口
interface AuthState {
    isAuthenticated: boolean;
    user: UserInfo | null;
    isLoading: boolean;
    error: string | null;
    loginRequires2FA: boolean; 
    // 存储 IP 黑名单数据 (虽然 actions 在这里，但 state 结构保持)
    ipBlacklist: {
        entries: any[]; // TODO: Define a proper type for blacklist entries
        total: number;
    };
    needsSetup: boolean; // 是否需要初始设置
    publicCaptchaConfig: PublicCaptchaConfig | null;
    passkeys: PasskeyInfo[] | null; 
    passkeysLoading: boolean; 
    hasPasskeysAvailable: boolean; 
    oidcProviders: OidcProviderSummary[]; // 登录页可用的 OIDC 提供商（仅 enabled）
}

export const useAuthStore = defineStore('auth', {
    state: (): AuthState => ({
        isAuthenticated: false, // 初始为未登录
        user: null,
        isLoading: false,
        error: null,
        loginRequires2FA: false, // 初始为不需要
        ipBlacklist: { entries: [], total: 0 }, // 初始化黑名单状态
        needsSetup: false, // 初始假设不需要设置
        publicCaptchaConfig: null, //  Initialize CAPTCHA config as null
        passkeys: null, // Initialize passkeys as null
        passkeysLoading: false, // Initialize passkeysLoading as false
        hasPasskeysAvailable: false, // Initialize as false
        oidcProviders: [], // Initialize OIDC providers as empty
    }),
    getters: {
        // 可以添加一些 getter，例如获取用户名
        loggedInUser: (state) => state.user?.username,
    },
    actions: {
        // 清除错误状态
        clearError() {
            this.error = null;
        },
        // 设置错误状态
        setError(errorMessage: string) {
            this.error = errorMessage;
        },

        // 登录 Action - 更新为接受 LoginPayload + optional captchaToken
        async login(payload: LoginPayload & { captchaToken?: string }) { // Add captchaToken to payload
            this.isLoading = true;
            this.error = null;
            this.loginRequires2FA = false; // 重置 2FA 状态
            try {
                // 后端可能返回 user 或 requiresTwoFactor
                // 将完整的 payload (包含 rememberMe 和 captchaToken) 发送给后端
                const response = await apiClient.post<{ message: string; user?: UserInfo; requiresTwoFactor?: boolean }>('/auth/login', payload); // 使用 apiClient

                if (response.data.requiresTwoFactor) {
                    // 需要 2FA 验证
                    console.log('登录需要 2FA 验证');
                    this.loginRequires2FA = true;
                    // 不设置 isAuthenticated 和 user，等待 2FA 验证
                    return { requiresTwoFactor: true }; // 返回特殊状态给调用者
                } else if (response.data.user) {
                    // 登录成功 (无 2FA)
                    this.isAuthenticated = true;
                    this.user = response.data.user;
                    console.log('登录成功 (无 2FA):', this.user);
                    // 设置语言
                    if (this.user?.language) {
                        setLocale(this.user.language);
                    }
                    // await router.push({ name: 'Workspace' }); // 改为页面刷新
                    window.location.href = getLoginRedirectTarget(); // 跳转到上次停留页面或根路径并刷新
                    return { success: true };
                } else {
                    // 不应该发生，但作为防御性编程
                    throw new Error('登录响应无效');
                }
            } catch (err: any) {
                console.error('登录失败:', err);
                this.isAuthenticated = false;
                this.user = null;
                this.loginRequires2FA = false;
                this.error = err.response?.data?.message || err.message || '登录时发生未知错误。';
                return { success: false, error: this.error };
            } finally {
                this.isLoading = false;
            }
        },

        // 登录时的 2FA 验证 Action
        async verifyLogin2FA(token: string) {
            if (!this.loginRequires2FA) {
                throw new Error('当前登录流程不需要 2FA 验证。');
            }
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.post<{ message: string; user: UserInfo }>('/auth/login/2fa', { token }); // 使用 apiClient
                // 2FA 验证成功
                this.isAuthenticated = true;
                this.user = response.data.user;
                this.loginRequires2FA = false; // 重置状态
                console.log('2FA 验证成功，登录完成:', this.user);
                // 设置语言
                if (this.user?.language) {
                    setLocale(this.user.language);
                }
                // await router.push({ name: 'Workspace' }); // 改为页面刷新
                window.location.href = getLoginRedirectTarget(); // 跳转到上次停留页面或根路径并刷新
                return { success: true };
            } catch (err: any) {
                console.error('2FA 验证失败:', err);
                // 不清除 isAuthenticated 或 user，因为用户可能只是输错了验证码
                this.error = err.response?.data?.message || err.message || '2FA 验证时发生未知错误。';
                return { success: false, error: this.error };
            } finally {
                this.isLoading = false;
            }
        },


        // 登出 Action
        async logout() {
            this.isLoading = true;
            this.error = null;
            this.loginRequires2FA = false; // 重置 2FA 状态
            try {
                // 调用后端的登出 API
                await apiClient.post('/auth/logout'); // 使用 apiClient

                // 清除本地状态
                this.isAuthenticated = false;
                this.user = null;
                // Removed passkeys clear on logout
                console.log('已登出');
                // 登出后重定向到登录页
                await router.push({ name: 'Login' });
            } catch (err: any) {
                console.error('登出失败:', err);
                this.error = err.response?.data?.message || err.message || '登出时发生未知错误。';
            } finally {
                this.isLoading = false;
            }
        },

        // 检查并更新认证状态 Action (增加网络就绪屏障与重试机制)
        async checkAuthStatus() {
            this.isLoading = true;
            let maxAttempts = 3;
            while (maxAttempts > 0) {
                try {
                    const response = await apiClient.get<{ isAuthenticated: boolean; user: UserInfo }>('/auth/status');
                    if (response.data.isAuthenticated && response.data.user) {
                        this.isAuthenticated = true;
                        this.user = response.data.user; // 更新用户信息，包含 isTwoFactorEnabled 和 language
                        this.loginRequires2FA = false; // 确保重置
                        console.log('认证状态已更新:', this.user);
                        // 设置语言
                        if (this.user?.language) {
                            setLocale(this.user.language);
                        }
                    } else {
                        this.isAuthenticated = false;
                        this.user = null;
                        this.loginRequires2FA = false;
                    }
                    break;
                } catch (error: any) {
                    // 若收到 HTTP 响应 (如 401 / 403)，说明后端服务明确判定未认证，直接采信并不再重试
                    if (error.response) {
                        this.isAuthenticated = false;
                        this.user = null;
                        this.loginRequires2FA = false;
                        break;
                    }
                    // 若无响应 (连接被拒绝 / 端口正处于拉起过渡期)，等待 150ms 优雅重试
                    maxAttempts--;
                    if (maxAttempts > 0) {
                        console.log(`[AuthStore] 后端服务连接中，正在进行认证就绪重试 (剩余 ${maxAttempts} 次)...`);
                        await new Promise((resolve) => setTimeout(resolve, 150));
                        continue;
                    }
                    console.warn('检查认证状态网络不可达:', error.message);
                    this.isAuthenticated = false;
                    this.user = null;
                    this.loginRequires2FA = false;
                }
            }

            // 桌面端：没设置密码的账号打开软件就是登录状态，不弹登录页
            if (!this.isAuthenticated && isDesktopApp()) {
                try {
                    const res = await apiClient.post<{ autoLogin: boolean; user?: UserInfo }>('/auth/auto-login');
                    if (res.data?.autoLogin && res.data.user) {
                        this.isAuthenticated = true;
                        this.user = res.data.user;
                        this.loginRequires2FA = false;
                        console.log('[AuthStore] 桌面端已自动登录:', this.user);
                    }
                } catch (autoErr: any) {
                    // 后端还没就绪 / 非桌面端 / 账号有密码，都按未登录处理即可
                    console.log('[AuthStore] 桌面端自动登录未生效:', autoErr?.message);
                }
            }

            this.isLoading = false;
        },

        // 修改密码 Action
        async changePassword(currentPassword: string, newPassword: string) {
            if (!this.isAuthenticated) {
                throw new Error('用户未登录，无法修改密码。');
            }
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.put<{ message: string }>('/auth/password', { // 使用 apiClient
                    currentPassword,
                    newPassword,
                });
                console.log('密码修改成功:', response.data.message);
                // 密码修改成功后，通常不需要更新本地状态，但可以清除错误
                return true;
            } catch (err: any) {
                console.error('修改密码失败:', err);
                this.error = err.response?.data?.message || err.message || '修改密码时发生未知错误。';
                // 抛出错误，以便组件可以捕获并显示 (提供默认消息以防 this.error 为 null)
                throw new Error(this.error ?? '修改密码时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        // --- IP 黑名单管理 Actions ---
        /**
         * 获取 IP 黑名单列表
         * @param limit 每页数量
         * @param offset 偏移量
         */
        async fetchIpBlacklist(limit: number = 50, offset: number = 0) {
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.get('/settings/ip-blacklist', { // 使用 apiClient
                    params: { limit, offset }
                });
                // 更新本地状态
                this.ipBlacklist.entries = response.data.entries;
                this.ipBlacklist.total = response.data.total;
                console.log('获取 IP 黑名单成功:', response.data);
                return response.data; // { entries: [], total: number }
            } catch (err: any) {
                console.error('获取 IP 黑名单失败:', err);
                this.error = err.response?.data?.message || err.message || '获取 IP 黑名单时发生未知错误。';
                // 确保抛出 Error 时提供字符串消息
                throw new Error(this.error ?? '获取 IP 黑名单时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * 从 IP 黑名单中删除一个 IP
         * @param ip 要删除的 IP 地址
         */
        async deleteIpFromBlacklist(ip: string) {
            this.isLoading = true;
            this.error = null;
            try {
                await apiClient.delete(`/settings/ip-blacklist/${encodeURIComponent(ip)}`); // 使用 apiClient
                console.log(`IP ${ip} 已从黑名单删除`);
                // 从本地 state 中移除 (或者重新获取列表)
                this.ipBlacklist.entries = this.ipBlacklist.entries.filter(entry => entry.ip !== ip);
                this.ipBlacklist.total = Math.max(0, this.ipBlacklist.total - 1);
                return true;
            } catch (err: any) {
                console.error(`删除 IP ${ip} 失败:`, err);
                this.error = err.response?.data?.message || err.message || '删除 IP 时发生未知错误。';
                 // 确保抛出 Error 时提供字符串消息
                throw new Error(this.error ?? '删除 IP 时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        // 检查是否需要初始设置 (增加网络过渡期重试)
        async checkSetupStatus() {
            let maxAttempts = 3;
            while (maxAttempts > 0) {
                try {
                    const response = await apiClient.get<{ needsSetup: boolean }>('/auth/needs-setup'); // 使用 apiClient
                    this.needsSetup = response.data.needsSetup;
                    console.log(`[AuthStore] Needs setup status: ${this.needsSetup}`);
                    return this.needsSetup; // 返回状态给调用者
                } catch (error: any) {
                    if (error.response) {
                        this.needsSetup = false;
                        return false;
                    }
                    maxAttempts--;
                    if (maxAttempts > 0) {
                        await new Promise((resolve) => setTimeout(resolve, 150));
                        continue;
                    }
                    console.error('检查设置状态失败:', error.response?.data?.message || error.message);
                    this.needsSetup = false;
                    return false;
                }
            }
            return false;
        },

        //  获取公共 CAPTCHA 配置 (修改为从 /settings/captcha 获取)
        async fetchCaptchaConfig() {
            console.log('[AuthStore] fetchCaptchaConfig called. Forcing refetch.'); // 更新日志，表明强制刷新

            // Don't set isLoading for this, it should be quick background fetch
            try {
                console.log('[AuthStore] Fetching CAPTCHA config from /settings/captcha...');
                // 修改 API 端点
                const response = await apiClient.get<FullCaptchaSettings>('/settings/captcha');
                const fullConfig = response.data;

                // 从完整配置中提取公共部分
                this.publicCaptchaConfig = {
                    enabled: fullConfig.enabled,
                    provider: fullConfig.provider,
                    hcaptchaSiteKey: fullConfig.hcaptchaSiteKey,
                    recaptchaSiteKey: fullConfig.recaptchaSiteKey,
                };

                console.log('[AuthStore] Public CAPTCHA config derived from /settings/captcha:', this.publicCaptchaConfig);
            } catch (error: any) {
                console.error('获取 CAPTCHA 配置失败 (from /settings/captcha):', error.response?.data?.message || error.message);
                // Set a default disabled config on error to prevent blocking login UI
                this.publicCaptchaConfig = {
                    enabled: false,
                    provider: 'none',
                };
            }
        },

        // --- Passkey Actions ---
        async loginWithPasskey(username: string, assertionResponse: any) {
            this.isLoading = true;
            this.error = null;
            this.loginRequires2FA = false; // Passkey login bypasses traditional 2FA
            try {
                const response = await apiClient.post<{ message: string; user: UserInfo }>('/auth/passkey/authenticate', {
                    username,
                    assertionResponse,
                });

                this.isAuthenticated = true;
                this.user = response.data.user;
                console.log('Passkey 登录成功:', this.user);
                if (this.user?.language) {
                    setLocale(this.user.language);
                }
                window.location.href = getLoginRedirectTarget(); // 跳转到上次停留页面或根路径并刷新
                return { success: true };

            } catch (err: any) {
                console.error('Passkey 登录失败:', err);
                this.isAuthenticated = false;
                this.user = null;
                this.error = err.response?.data?.message || err.message || 'Passkey 登录时发生未知错误。';
                return { success: false, error: this.error };
            } finally {
                this.isLoading = false;
            }
        },

        async getPasskeyRegistrationOptions(username: string) {
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.post('/auth/passkey/registration-options', { username });
                return response.data; // Returns FIDO2 creation options
            } catch (err: any) {
                console.error('获取 Passkey 注册选项失败:', err);
                this.error = err.response?.data?.message || err.message || '获取 Passkey 注册选项失败。';
                throw new Error(this.error ?? '获取 Passkey 注册选项失败。');
            } finally {
                this.isLoading = false;
            }
        },

        async registerPasskey(username: string, registrationResponse: any) {
            this.isLoading = true;
            this.error = null;
            try {
                await apiClient.post('/auth/passkey/register', {
                    username,
                    registrationResponse,
                });
                console.log('Passkey 注册成功');
                // Optionally, refresh user data or passkeys list if applicable
                return { success: true };
            } catch (err: any) {
                console.error('Passkey 注册失败:', err);
                this.error = err.response?.data?.message || err.message || 'Passkey 注册失败。';
                throw new Error(this.error ?? 'Passkey 注册失败。');
            } finally {
                this.isLoading = false;
            }
        },

        // Action to fetch user's passkeys
        async fetchPasskeys() {
            if (!this.isAuthenticated) {
                console.warn('User not authenticated. Cannot fetch passkeys.');
                this.passkeys = null;
                return;
            }
            this.passkeysLoading = true;
            this.error = null; // Clear previous errors
            try {
                // Define an interface for the backend response structure
                interface BackendPasskeyInfo {
                    credential_id: string;
                    public_key: string;
                    counter: number;
                    transports?: AuthenticatorTransport[];
                    created_at: string; // Backend uses snake_case
                    last_used_at: string; // Backend uses snake_case
                    name?: string;
                }
                const response = await apiClient.get<BackendPasskeyInfo[]>('/auth/user/passkeys');
                // Map backend response to frontend PasskeyInfo structure
                this.passkeys = response.data.map(pk => ({
                    credentialID: pk.credential_id,
                    publicKey: pk.public_key,
                    counter: pk.counter,
                    transports: pk.transports,
                    creationDate: pk.created_at, // Map created_at to creationDate
                    lastUsedDate: pk.last_used_at, // Map last_used_at to lastUsedDate
                    name: pk.name,
                }));
                console.log('Passkeys fetched and mapped successfully:', this.passkeys);
            } catch (err: any) {
                console.error('Failed to fetch passkeys:', err);
                this.error = err.response?.data?.message || err.message || 'Failed to load passkeys.';
                this.passkeys = null; // Clear passkeys on error
            } finally {
                this.passkeysLoading = false;
            }
        },

        // Action to delete a passkey
        async deletePasskey(credentialID: string) {
            if (!this.isAuthenticated) {
                throw new Error('User not authenticated. Cannot delete passkey.');
            }
            this.isLoading = true; // Use general isLoading or a specific one for this action
            this.error = null;
            try {
                await apiClient.delete(`/auth/user/passkeys/${credentialID}`);
                console.log(`Passkey ${credentialID} deleted successfully.`);
                // Refresh the passkey list
                await this.fetchPasskeys();
                return { success: true };
            } catch (err: any) {
                console.error(`Failed to delete passkey ${credentialID}:`, err);
                this.error = err.response?.data?.message || err.message || 'Failed to delete passkey.';
                throw new Error(this.error ?? 'Failed to delete passkey.');
            } finally {
                this.isLoading = false;
            }
        },

        // Action to update a passkey's name
        async updatePasskeyName(credentialID: string, newName: string) {
            if (!this.isAuthenticated) {
                throw new Error('User not authenticated. Cannot update passkey name.');
            }
            // Consider using a specific loading state for this if needed, e.g., this.passkeyNameUpdateLoading = true;
            this.error = null;
            try {
                await apiClient.put(`/auth/user/passkeys/${credentialID}/name`, { name: newName });
                console.log(`Passkey ${credentialID} name updated to "${newName}".`);
                // Refresh the passkey list to show the new name
                await this.fetchPasskeys();
                return { success: true };
            } catch (err: any) {
                console.error(`Failed to update passkey ${credentialID} name:`, err);
                this.error = err.response?.data?.message || err.message || 'Failed to update passkey name.';
                throw new Error(this.error ?? 'Failed to update passkey name.');
            } finally {
                // if using specific loading state: this.passkeyNameUpdateLoading = false;
            }
        },

        // Action to check if passkeys are configured (for login page)
        async checkHasPasskeysConfigured(username?: string) {
            // This action should not set isLoading to true, as it's a quick check
            // and primarily used to determine UI elements on the login page.
            try {
                const params = username ? { username } : {};
                const response = await apiClient.get<{ hasPasskeys: boolean }>('/auth/passkey/has-configured', { params });
                this.hasPasskeysAvailable = response.data.hasPasskeys;
                console.log(`[AuthStore] Passkeys available for ${username || 'any user'}: ${this.hasPasskeysAvailable}`);
                return this.hasPasskeysAvailable;
            } catch (error: any) {
                console.error('Failed to check if passkeys are configured:', error.response?.data?.message || error.message);
                this.hasPasskeysAvailable = false; // Default to false on error
                return false;
            }
        },

        // --- OIDC Actions ---
        /**
         * 拉取登录页可用的 OIDC 提供商（公开接口，仅返回 enabled 的）。
         * 兼容两种响应信封：裸数组 或 { providers: [...] }。
         */
        async fetchOidcProviders() {
            // 这是登录页的后台快速拉取，不设置 isLoading，避免影响登录按钮状态
            try {
                const response = await apiClient.get<OidcProviderSummary[] | { providers: OidcProviderSummary[] }>('/auth/oidc/providers');
                const data: any = response.data;
                const list: OidcProviderSummary[] = Array.isArray(data) ? data : (data?.providers ?? []);
                this.oidcProviders = Array.isArray(list) ? list : [];
                console.log('[AuthStore] OIDC providers fetched:', this.oidcProviders);
                return this.oidcProviders;
            } catch (error: any) {
                console.error('Failed to fetch OIDC providers:', error.response?.data?.message || error.message);
                this.oidcProviders = []; // Default to empty on error (登录页不显示 OIDC 按钮)
                return this.oidcProviders;
            }
        },

        /**
         * 发起 OIDC 登录：整页跳转到后端 authorize 端点（契约 §5，非 fetch）。
         */
        startOidcLogin(providerId: string) {
            window.location.href = `/api/v1/auth/oidc/providers/${encodeURIComponent(providerId)}/authorize?mode=login`;
        },
    },
    persist: true, // Revert to simple persistence to fix TS error for now
});
