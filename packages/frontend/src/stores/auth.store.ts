import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import router from '../router'; // 引入 router 用于重定向
import { setLocale } from '../i18n'; // 导入 setLocale

// 扩展的用户信息接口，包含 2FA 状态和语言偏好
interface UserInfo {
    id: number;
    username: string;
    isTwoFactorEnabled?: boolean; // 后端 /status 接口会返回这个
    language?: 'en' | 'zh'; // 新增：用户偏好语言
}

// 新增：登录请求的载荷接口
interface LoginPayload {
    username: string;
    password: string;
    rememberMe?: boolean; // 可选的“记住我”标志
    enableAutoLoginForIp?: boolean; // 新增：为此IP启用自动登录
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

// Removed PasskeyInfo interface


// Auth Store State 接口
interface AuthState {
    isAuthenticated: boolean;
    user: UserInfo | null;
    isLoading: boolean;
    error: string | null;
    loginRequires2FA: boolean; // 新增状态：标记登录是否需要 2FA
    // 新增：存储 IP 黑名单数据 (虽然 actions 在这里，但 state 结构保持)
    ipBlacklist: {
        entries: any[]; // TODO: Define a proper type for blacklist entries
        total: number;
    };
    needsSetup: boolean; // 新增：是否需要初始设置
    publicCaptchaConfig: PublicCaptchaConfig | null; // NEW: Public CAPTCHA config
    // Removed Passkey state properties
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
        publicCaptchaConfig: null, // NEW: Initialize CAPTCHA config as null
        // Removed Passkey state initialization
    }),
    getters: {
        // 可以添加一些 getter，例如获取用户名
        loggedInUser: (state) => state.user?.username,
    },
    actions: {
        // 新增：清除错误状态
        clearError() {
            this.error = null;
        },
        // 新增：设置错误状态
        setError(errorMessage: string) {
            this.error = errorMessage;
        },

        // 新增：尝试自动登录 Action
        async attemptAutoLogin() {
            // 这个 action 不应该设置 isLoading，因为它应该在后台静默尝试
            // 也不应该在失败时设置全局 error，因为它不是用户直接操作的失败
            console.log('[AuthStore] Attempting auto login...');
            try {
                // 向 /auth/login 发送一个 POST 请求，后端 autoLoginMiddleware 会处理
                // 可以发送一个空对象作为 payload，或者根据后端需要发送特定标记
                const response = await apiClient.post<{ message: string; user?: UserInfo; requiresTwoFactor?: boolean }>('/auth/login', {});
                
                if (response.data.user && !response.data.requiresTwoFactor) {
                    // 自动登录成功 (且不需要2FA，对于自动登录场景通常是这样)
                    this.isAuthenticated = true;
                    this.user = response.data.user;
                    this.loginRequires2FA = false;
                    console.log('[AuthStore] Auto login successful:', this.user);
                    if (this.user?.language) {
                        setLocale(this.user.language);
                    }
                    return true; // 表明自动登录成功
                }
                // 如果响应表明需要2FA或没有用户信息，则认为自动登录未发生或不适用
                console.log('[AuthStore] Auto login did not occur or requires further steps.');
                return false;
            } catch (err: any) {
                // 捕获错误 (例如网络错误，或后端返回4xx/5xx但不是明确的“需要凭证”类型)
                // 对于自动登录尝试，我们通常不希望这些错误直接显示给用户或阻止应用加载
                console.warn('[AuthStore] Auto login attempt failed or was not applicable:', err.response?.data?.message || err.message);
                return false; // 表明自动登录未成功
            }
        },

        // 登录 Action - 更新为接受 LoginPayload + optional captchaToken + optional enableAutoLoginForIp
        async login(payload: LoginPayload & { captchaToken?: string; enableAutoLoginForIp?: boolean }) {
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
                    window.location.href = '/'; // 跳转到根路径并刷新
                    
                    // 如果勾选了 "为此 IP 启用自动登录"，则在登录成功后调用后端接口
                    if (payload.enableAutoLoginForIp && response.data.user) {
                        try {
                            console.log('[AuthStore] Login successful, attempting to enable auto-login for this IP...');
                            // 注意：后端需要一个新的API端点来处理这个请求
                            // 例如: POST /api/v1/auth/settings/enable-auto-login-ip
                            // 该请求应由后端获取当前请求的IP并添加到白名单
                            await apiClient.post('/auth/settings/enable-auto-login-ip');
                            console.log('[AuthStore] Successfully requested to enable auto-login for this IP.');
                        } catch (autoLoginEnableError: any) {
                            // 即便这个辅助请求失败，也不应影响主登录流程
                            console.warn('[AuthStore] Failed to request enabling auto-login for this IP:', autoLoginEnableError.response?.data?.message || autoLoginEnableError.message);
                        }
                    }
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
                window.location.href = '/'; // 跳转到根路径并刷新

                // 2FA 成功后，也检查是否需要启用自动登录 (如果 enableAutoLoginForIp 是在第一步登录时传递的)
                // 注意：这里的 payload 是 verifyLogin2FA 的 payload，不包含 enableAutoLoginForIp
                // 这个逻辑可能需要调整，例如在 session 中临时存储 enableAutoLoginForIp 的意图
                // 或者，更简单的方式是，如果用户在第一步勾选了，就在第一步登录成功后（如果不需要2FA）或2FA成功后统一处理。
                // 为了简化，我们假设如果需要2FA，则在2FA成功后不再自动添加IP。用户可以在设置中手动配置。
                // 或者，后端在 login 阶段就应该处理 enableAutoLoginForIp，即使需要2FA，也记录这个意图。
                // 当前实现：仅在非2FA登录成功时，前端会尝试调用 enable-auto-login-ip。
                // 如果希望2FA后也执行，后端 login 接口需要在session中标记这个意图，然后在 verifyLogin2FA 成功后检查并执行。

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

        // 新增：检查并更新认证状态 Action
        async checkAuthStatus() {
            this.isLoading = true;
            try {
                const response = await apiClient.get<{ isAuthenticated: boolean; user: UserInfo }>('/auth/status'); // 使用 apiClient
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
                    // Removed passkeys clear on unauthenticated
                }
            } catch (error: any) {
                // 如果获取状态失败 (例如 session 过期)，则认为未认证
                console.warn('检查认证状态失败:', error.response?.data?.message || error.message);
                this.isAuthenticated = false;
                this.user = null;
                this.loginRequires2FA = false;
                // Removed passkeys clear on error
                // 可选：如果不是 401 错误，可以记录更详细的日志
            } finally {
                this.isLoading = false;
            }
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

        // 新增：检查是否需要初始设置
        async checkSetupStatus() {
            // 不需要设置 isLoading，这个检查应该在后台快速完成
            try {
                const response = await apiClient.get<{ needsSetup: boolean }>('/auth/needs-setup'); // 使用 apiClient
                this.needsSetup = response.data.needsSetup;
                console.log(`[AuthStore] Needs setup status: ${this.needsSetup}`);
                return this.needsSetup; // 返回状态给调用者
            } catch (error: any) {
                console.error('检查设置状态失败:', error.response?.data?.message || error.message);
                // 如果检查失败，保守起见假设不需要设置，以避免卡在设置页面
                this.needsSetup = false;
                return false;
            }
        },

        // NEW: 获取公共 CAPTCHA 配置 (修改为从 /settings/captcha 获取)
        async fetchCaptchaConfig() {
            console.log('[AuthStore] fetchCaptchaConfig called. Current publicCaptchaConfig:', JSON.stringify(this.publicCaptchaConfig)); // 添加日志
            // Avoid refetching if already loaded
            if (this.publicCaptchaConfig !== null) {
              console.log('[AuthStore] publicCaptchaConfig is not null, returning early.'); // 添加日志
              return;
            }

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

        // --- Passkey Actions Removed ---
    },
    persist: true, // Revert to simple persistence to fix TS error for now
});
