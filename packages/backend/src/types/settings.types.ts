// packages/backend/src/types/settings.types.ts

// Define PaneName here as it's logically related to layout/sidebar settings
export type PaneName = 'connections' | 'terminal' | 'commandBar' | 'fileManager' | 'editor' | 'statusMonitor' | 'commandHistory' | 'quickCommands' | 'dockerManager' | 'suspendedSshSessions' | 'multiLineCommandInput' | 'portForward';

/**
 * 布局节点接口 (Mirrors frontend definition for backend use)
 */
export interface LayoutNode {
  id: string; // 唯一 ID (Note: Backend might not always use/store this)
  type: 'pane' | 'container'; // 节点类型：面板或容器
  component?: PaneName; // 如果 type 是 'pane'，指定要渲染的组件
  direction?: 'horizontal' | 'vertical'; // 如果 type 是 'container'，指定分割方向
  children?: LayoutNode[]; // 如果 type 是 'container'，包含子节点数组
  size?: number; // 节点在父容器中的大小比例 (例如 20, 50, 30)
}

/**
 * 侧栏配置数据结构 (Managed by Settings Repository/Service)
 */
export interface SidebarConfig {
    left: PaneName[];
    right: PaneName[];
}

/**
 * 用于更新侧栏配置的 DTO
 */
export interface UpdateSidebarConfigDto extends SidebarConfig {} // Simple alias for now, can add validation later

// You can add other settings-related types here if needed
/**
 * CAPTCHA 提供商类型
 */
export type CaptchaProvider = 'hcaptcha' | 'recaptcha' | 'none';

/**
 * CAPTCHA 设置接口
 */
export interface CaptchaSettings {
    enabled: boolean; // 是否启用 CAPTCHA
    provider: CaptchaProvider; // 当前选择的提供商
    hcaptchaSiteKey?: string; // hCaptcha 站点密钥 (公开)
    hcaptchaSecretKey?: string; // hCaptcha 秘密密钥 (保密) - 后端存储和使用
    recaptchaSiteKey?: string; // Google reCAPTCHA v2 站点密钥 (公开)
    recaptchaSecretKey?: string; // Google reCAPTCHA v2 秘密密钥 (保密) - 后端存储和使用
}

/**
 * 用于更新 CAPTCHA 设置的 DTO
 * (可以添加验证规则)
 */
export interface UpdateCaptchaSettingsDto {
    enabled?: boolean;
    provider?: CaptchaProvider;
    hcaptchaSiteKey?: string;
    hcaptchaSecretKey?: string;
    recaptchaSiteKey?: string;
    recaptchaSecretKey?: string;
}

/**
 * OIDC 提供商配置（多个可并存，如 Keycloak / Authentik / Auth0 ...）
 *
 * 注意：clientSecret 在**返回给前端时永远不回填**，改为 hasClientSecret: boolean。
 * 更新时 clientSecret 留空（undefined 或 ''）表示「保留原密钥」。
 */
export interface OidcProviderConfig {
    /** 稳定标识，服务端生成的 UUID，创建后不可变 */
    id: string;
    /** 显示名，如 "Keycloak" */
    name: string;
    /** 关掉后不出现在登录页 */
    enabled: boolean;
    /** 如 https://kc.example.com/realms/myrealm（不带尾部斜杠） */
    issuerUrl: string;
    clientId: string;
    /** 明文仅存在于内存；落库前 encrypt()。前端读取时被替换为 hasClientSecret */
    clientSecret: string;
    /** 空格分隔，默认 "openid profile email" */
    scopes: string;
    /** 登录时若未绑定是否自动建号 */
    autoCreateUser: boolean;
    /** 逗号分隔的邮箱域名白名单，空字符串 = 不限制 */
    allowedEmailDomains: string;
    /** 可选，空字符串 = 不显示图标 */
    iconUrl: string;
    /** epoch seconds */
    createdAt: number;
}

/** 返回给前端的 provider 视图：抹掉 clientSecret，只保留是否已配置 */
export interface OidcProviderPublicConfig extends Omit<OidcProviderConfig, 'clientSecret'> {
    hasClientSecret: boolean;
}

/** 前端提交的 provider DTO：clientSecret 可缺省/空串表示保留原值 */
export interface UpdateOidcProviderDto extends Partial<Omit<OidcProviderConfig, 'id' | 'createdAt'>> {
    id?: string;
}

/** OIDC 账号绑定记录 */
export interface OidcLink {
    id: number;
    userId: number;
    providerId: string;
    subject: string;
    email: string | null;
    issuer: string | null;
    createdAt: number;
    lastLoginAt: number | null;
}

/** 新建绑定 */
export interface NewOidcLink {
    userId: number;
    providerId: string;
    subject: string;
    email?: string | null;
    issuer?: string | null;
}

/** 登录页用的最小 provider 信息 */
export interface OidcProviderSummary {
    id: string;
    name: string;
    iconUrl: string;
}

/**
 * 完整的应用设置接口 (聚合所有设置类型)
 * 注意：这只是一个示例结构，实际可能需要根据 SettingsRepository 的实现调整
 */
export interface AppSettings {
    sidebar?: SidebarConfig;
    captcha?: CaptchaSettings;
    oidc?: OidcProviderConfig[];
    showStatusMonitorIpAddress?: boolean; // 是否在状态监视器中显示IP地址
    // 可以添加其他设置模块，例如：
    // security?: SecuritySettings;
    // general?: GeneralSettings;
}