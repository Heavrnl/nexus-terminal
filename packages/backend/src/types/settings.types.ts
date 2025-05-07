// packages/backend/src/types/settings.types.ts

// Define PaneName here as it's logically related to layout/sidebar settings
export type PaneName = 'connections' | 'terminal' | 'commandBar' | 'fileManager' | 'editor' | 'statusMonitor' | 'commandHistory' | 'quickCommands' | 'dockerManager';

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
 * Cloudflare Access 自动登录设置
 */
export interface AutoLoginCloudflareSettings {
    enabled: boolean;
    trustedIPs: string[]; // 将从逗号分隔的字符串解析而来
}

/**
 * IP 白名单自动登录设置
 */
export interface AutoLoginIpWhitelistSettings {
    enabled: boolean;
    allowedIPs: string[]; // 将从逗号分隔的字符串解析而来
}

/**
 * 自动登录总设置
 */
export interface AutoLoginSettings {
    cloudflare?: AutoLoginCloudflareSettings;
    ipWhitelist?: AutoLoginIpWhitelistSettings;
}

/**
 * 完整的应用设置接口 (聚合所有设置类型)
 * 注意：这只是一个示例结构，实际可能需要根据 SettingsRepository 的实现调整
 */
export interface AppSettings {
    sidebar?: SidebarConfig;
    captcha?: CaptchaSettings;
    autoLogin?: AutoLoginSettings;
    // 可以添加其他设置模块，例如：
    // security?: SecuritySettings;
    // general?: GeneralSettings;
}