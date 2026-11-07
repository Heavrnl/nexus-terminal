import { ref, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../../utils/apiClient';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';

/** 后端返回的 provider 视图：无 clientSecret，只有 hasClientSecret（契约 §1.3） */
export interface OidcProviderPublicConfig {
    id: string;
    name: string;
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    scopes: string;
    autoCreateUser: boolean;
    allowedEmailDomains: string;
    iconUrl: string;
    createdAt: number;
    hasClientSecret: boolean;
}

/** 已绑定账号（契约 §2 第 4 条） */
export interface OidcLinkInfo {
    id: number;
    providerId: string;
    providerName: string;
    email: string | null;
    createdAt: number;
    lastLoginAt: number | null;
}

/**
 * 表单内的 provider 行。
 * `clientSecret` 为空串 = 不修改原密钥（新建时必须填写）。
 * `isNew` 标记后端尚未生成 id 的行，保存时**不提交 id**。
 */
export interface OidcProviderFormRow {
    id?: string;
    isNew: boolean;
    name: string;
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    hasClientSecret: boolean;
    scopes: string;
    autoCreateUser: boolean;
    allowedEmailDomains: string;
    iconUrl: string;
}

export const DEFAULT_OIDC_SCOPES = 'openid profile email';

/** 新建一行空白 provider */
export function createEmptyOidcProviderRow(): OidcProviderFormRow {
    return {
        isNew: true,
        name: '',
        enabled: true,
        issuerUrl: '',
        clientId: '',
        clientSecret: '',
        hasClientSecret: false,
        scopes: DEFAULT_OIDC_SCOPES,
        autoCreateUser: false,
        allowedEmailDomains: '',
        iconUrl: '',
    };
}

/** 后端 provider → 表单行（secret 永不回填） */
export function toFormRow(provider: OidcProviderPublicConfig): OidcProviderFormRow {
    return {
        id: provider.id,
        isNew: false,
        name: provider.name ?? '',
        enabled: provider.enabled ?? true,
        issuerUrl: provider.issuerUrl ?? '',
        clientId: provider.clientId ?? '',
        clientSecret: '', // 永不回填
        hasClientSecret: !!provider.hasClientSecret,
        scopes: provider.scopes || DEFAULT_OIDC_SCOPES,
        autoCreateUser: !!provider.autoCreateUser,
        allowedEmailDomains: provider.allowedEmailDomains ?? '',
        iconUrl: provider.iconUrl ?? '',
    };
}

/**
 * 表单行 → PUT 载荷（契约 §1.3 / §2 第 7 条）。
 * - 新建行不带 id（由后端生成 UUID）
 * - clientSecret 为空串时整个字段不出现 ⇒ 保留原密钥
 * - issuerUrl 去尾部斜杠；scopes 空则回退默认值
 */
export function toSubmitPayload(row: OidcProviderFormRow): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        name: row.name.trim(),
        enabled: row.enabled,
        issuerUrl: row.issuerUrl.trim().replace(/\/+$/, ''),
        clientId: row.clientId.trim(),
        scopes: row.scopes.trim() || DEFAULT_OIDC_SCOPES,
        autoCreateUser: row.autoCreateUser,
        allowedEmailDomains: row.allowedEmailDomains.trim(),
        iconUrl: row.iconUrl.trim(),
    };
    if (!row.isNew && row.id) {
        payload.id = row.id;
    }
    const secret = row.clientSecret.trim();
    if (secret) {
        payload.clientSecret = secret;
    }
    return payload;
}

/**
 * 行级校验（保存前）。返回错误文案键；合法返回 null。
 * 新建行必须填 secret，编辑行留空表示保留。
 */
export function validateRow(row: OidcProviderFormRow): string | null {
    if (!row.name.trim()) return 'settings.oidc.error.nameRequired';
    if (!row.issuerUrl.trim()) return 'settings.oidc.error.issuerRequired';
    if (!row.clientId.trim()) return 'settings.oidc.error.clientIdRequired';
    if (row.isNew && !row.clientSecret.trim()) return 'settings.oidc.error.clientSecretRequired';
    return null;
}

export function useOidcSettings() {
    const { t } = useI18n();
    const uiNotificationsStore = useUiNotificationsStore();

    const providers = reactive<OidcProviderFormRow[]>([]);
    const links = ref<OidcLinkInfo[]>([]);
    const loading = ref(false);
    const saving = ref(false);
    const errorMessage = ref('');

    const loadProviders = async () => {
        const response = await apiClient.get<{ providers: OidcProviderPublicConfig[] } | OidcProviderPublicConfig[]>(
            '/auth/oidc/settings',
        );
        const data: any = response.data;
        const list: OidcProviderPublicConfig[] = Array.isArray(data) ? data : (data?.providers ?? []);
        providers.splice(0, providers.length, ...list.map(toFormRow));
    };

    const loadLinks = async () => {
        const response = await apiClient.get<{ links: OidcLinkInfo[] }>('/auth/oidc/links');
        links.value = response.data?.links ?? [];
    };

    const loadAll = async () => {
        loading.value = true;
        errorMessage.value = '';
        try {
            await Promise.all([loadProviders(), loadLinks()]);
        } catch (error: any) {
            console.error('加载 OIDC 设置失败:', error);
            errorMessage.value = error.response?.data?.message || error.message || t('settings.oidc.error.loadFailed');
        } finally {
            loading.value = false;
        }
    };

    const addProvider = () => {
        providers.push(createEmptyOidcProviderRow());
    };

    const removeProvider = (index: number) => {
        providers.splice(index, 1);
    };

    /** 全量替换保存（契约 §2 第 7 条） */
    const saveProviders = async () => {
        errorMessage.value = '';
        for (const row of providers) {
            const bad = validateRow(row);
            if (bad) {
                errorMessage.value = t(bad);
                return false;
            }
        }

        saving.value = true;
        try {
            const payload = { providers: providers.map(toSubmitPayload) };
            const response = await apiClient.put<{ providers: OidcProviderPublicConfig[] } | OidcProviderPublicConfig[]>(
                '/auth/oidc/settings',
                payload,
            );
            const data: any = response.data;
            const list: OidcProviderPublicConfig[] | undefined = Array.isArray(data) ? data : data?.providers;
            // 后端若回填了新列表就采用，否则重新拉取，确保新建项拿到服务端 id
            if (Array.isArray(list)) {
                providers.splice(0, providers.length, ...list.map(toFormRow));
            } else {
                await loadProviders();
            }
            uiNotificationsStore.showSuccess(t('settings.oidc.success.saved'));
            return true;
        } catch (error: any) {
            console.error('保存 OIDC 设置失败:', error);
            errorMessage.value = error.response?.data?.message || error.message || t('settings.oidc.error.saveFailed');
            return false;
        } finally {
            saving.value = false;
        }
    };

    /** 绑定：整页跳转 authorize?mode=bind（契约 §5） */
    const bindProvider = (providerId: string) => {
        window.location.href = `/api/v1/auth/oidc/providers/${encodeURIComponent(providerId)}/authorize?mode=bind`;
    };

    const unlink = async (linkId: number) => {
        try {
            await apiClient.delete(`/auth/oidc/links/${linkId}`);
            uiNotificationsStore.showSuccess(t('settings.oidc.success.unlinked'));
            await loadLinks();
        } catch (error: any) {
            console.error('解绑 OIDC 失败:', error);
            uiNotificationsStore.showError(error.response?.data?.message || error.message || t('settings.oidc.error.unlinkFailed'));
        }
    };

    const formatDate = (value: number | null | undefined): string => {
        if (!value) return t('settings.oidc.never');
        try {
            return new Date(value * 1000).toLocaleString();
        } catch (_) {
            return t('settings.oidc.never');
        }
    };

    return {
        providers,
        links,
        loading,
        saving,
        errorMessage,
        loadAll,
        addProvider,
        removeProvider,
        saveProviders,
        bindProvider,
        unlink,
        formatDate,
    };
}
