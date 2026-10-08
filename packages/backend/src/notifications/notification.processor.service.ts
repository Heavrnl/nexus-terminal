import eventService, { AppEventType, AppEventPayload } from '../services/event.service';
import { NotificationSettingsRepository } from '../notifications/notification.repository';
import { NotificationSetting, NotificationEvent, NotificationChannelType, WebhookConfig, EmailConfig, TelegramConfig, NotificationChannelConfig } from '../types/notification.types';
import i18next, { i18nInitializationPromise } from '../i18n';
import { EventEmitter } from 'events';

// 定义处理后的通知数据结构
export interface ProcessedNotification {
    channelType: NotificationChannelType;
    config: NotificationChannelConfig; // 包含发送所需的配置，如 URL, Token, SMTP 等
    subject?: string; // 主要用于 Email
    body: string; // 格式化后的通知内容主体
    rawPayload: AppEventPayload; // 原始事件负载，可能需要传递给发送器
}


class NotificationProcessorService extends EventEmitter {
    private repository: NotificationSettingsRepository;
    private isInitialized = false;

    constructor() {
        super();
        this.repository = new NotificationSettingsRepository();
        this.initialize();
        this.setMaxListeners(50);
    }

    private async initialize(): Promise<void> {
        try {
            console.log('[NotificationProcessor] 等待 i18n 初始化...');
            await i18nInitializationPromise;
            console.log('[NotificationProcessor] i18n 初始化完成。正在注册事件监听器...');
            this.registerEventListeners();
            this.isInitialized = true;
            console.log('[NotificationProcessor] 初始化完成。');
        } catch (error) {
            console.error('[NotificationProcessor] 因 i18n 错误导致初始化失败:', error);
        }
    }


    private registerEventListeners() {
        if (this.isInitialized) {
             console.warn('[NotificationProcessor] 尝试多次注册监听器。');
             return;
        }
        // 监听所有 AppEventType 事件
        Object.values(AppEventType).forEach(eventType => {
            if (eventType !== AppEventType.TestNotification) {
                eventService.onEvent(eventType, (payload) => {
                    // 使用 setImmediate 或 process.nextTick 避免阻塞事件循环
                    setImmediate(() => {
                        this.processStandardEvent(eventType, payload).catch(error => {
                            console.error(`[NotificationProcessor] 处理事件 ${eventType} 时出错:`, error);
                        });
                    });
                });
            }
        });
         eventService.onEvent(AppEventType.TestNotification, (payload) => {
             setImmediate(() => {
                 this.processTestEvent(payload).catch(error => {
                     console.error(`[NotificationProcessor] 处理测试事件时出错:`, error);
                 });
             });
        });
        console.log('[NotificationProcessor] 已注册监听器。');
    }

     private async processStandardEvent(eventType: AppEventType, payload: AppEventPayload) {
         if (!this.isInitialized) {
             console.warn(`[NotificationProcessor] 在初始化完成前收到事件 ${eventType}。跳过处理。`);
             return;
         }
        console.log(`[NotificationProcessor] 收到标准事件: ${eventType}`, payload);
        const eventKey = eventType as NotificationEvent; // 类型转换，假设 AppEventType 和 NotificationEvent 对应

        try {
            const applicableSettings = await this.repository.getEnabledByEvent(eventKey);
            console.log(`[NotificationProcessor] 找到 ${applicableSettings.length} 个适用于事件 ${eventKey} 的设置`);

            if (applicableSettings.length === 0) {
                return; // 没有配置需要处理
            }

            // TODO: 获取用户语言偏好，目前硬编码为 'zh-CN'
            const userLang = 'zh-CN'; // 后续应从用户设置或请求中获取

            // 1. 翻译事件名称
            const translatedEvent = i18next.t(`event.${eventKey}`, { lng: userLang, defaultValue: eventKey });


            for (const setting of applicableSettings) {
                 this.processSingleSetting(setting, eventType, payload, translatedEvent, userLang);
            }
        } catch (error) {
            console.error(`[NotificationProcessor] 获取事件 ${eventKey} 的设置失败:`, error);
        }
    }

    private async processTestEvent(payload: AppEventPayload) {
         if (!this.isInitialized) {
             console.warn(`[NotificationProcessor] 在初始化完成前收到测试事件。跳过处理。`);
             return;
         }
        console.log(`[NotificationProcessor] 收到测试事件`, payload);
        const testTargetConfig = payload.testTargetConfig || payload.details?.testTargetConfig;
        const testTargetChannelType = payload.testTargetChannelType || payload.details?.testTargetChannelType;

        if (!testTargetConfig || !testTargetChannelType) {
            console.error('[NotificationProcessor] 测试事件负载缺少 testTargetConfig 或 testTargetChannelType。');
            return;
        }

        const mockSetting: NotificationSetting = {
            id: -1,
            name: 'Test Setting',
            enabled: true,
            channel_type: testTargetChannelType,
            config: testTargetConfig,
            enabled_events: [AppEventType.TestNotification as NotificationEvent],
        };

        const userLang = 'zh-CN'; // TODO: Get user language preference
        const translatedEvent = i18next.t(`event.${AppEventType.TestNotification}`, { lng: userLang, defaultValue: AppEventType.TestNotification });


        this.processSingleSetting(mockSetting, AppEventType.TestNotification, payload, translatedEvent, userLang);
    }

     private processSingleSetting(
        setting: NotificationSetting,
        eventType: AppEventType,
        payload: AppEventPayload,
        translatedEvent: string,
        userLang: string
    ) {
         try {

            const processedNotification = this.prepareNotificationContent(
                setting,
                eventType,
                payload,
                translatedEvent,
                userLang
            );

            if (processedNotification) {
                this.emit('sendNotification', processedNotification);
                console.log(`[NotificationProcessor] 正在为 ${setting.channel_type} 发送 sendNotification (设置 ID: ${setting.id}, 事件: ${eventType})`);
            }
        } catch (error) {
            console.error(`[NotificationProcessor] 为设置 ID ${setting.id} 和事件 ${eventType} 准备通知时出错:`, error);
        }
    }


    private prepareNotificationContent(
        setting: NotificationSetting,
        eventType: AppEventType,
        payload: AppEventPayload,
        translatedEvent: string, // The already translated event name (e.g., "登录成功")
        lang: string
    ): ProcessedNotification | null {

        const cleanDetails = typeof payload.details === 'object' && payload.details !== null ? { ...payload.details } : {};
        delete cleanDetails.testTargetConfig;
        delete cleanDetails.testTargetChannelType;

        const detailsString = Object.keys(cleanDetails).length > 0
            ? (cleanDetails.message || JSON.stringify(cleanDetails, null, 2))
            : (typeof payload.details === 'string' ? payload.details : '');

        const baseInterpolationData: Record<string, any> = {
            event: translatedEvent,
            rawEvent: eventType,
            timestamp: payload.timestamp.toISOString(),
            details: detailsString,
            userId: payload.userId || 'N/A',
            ...cleanDetails,
            settingId: cleanDetails.settingId,
            settingName: cleanDetails.name,
            settingType: cleanDetails.type,
        };


        let subject: string | undefined = undefined;
        let body: string = '';

        const genericSubject = `通知: {event}`;
        const genericEmailBody = `<p>事件: {event}</p><p>时间: {timestamp}</p><p>用户ID: {userId}</p><p>详情:</p><pre>{details}</pre>`;
        const genericWebhookBody = JSON.stringify({ event: '{event}', timestamp: '{timestamp}', userId: '{userId}', details: '{details}' });
        const genericTelegramBody = `*{event}*\n时间: {timestamp}\n用户ID: {userId}\n详情:\n\`\`\`\n{details}\n\`\`\``;


        switch (setting.channel_type) {
            case 'email':
                const emailConfig = setting.config as EmailConfig;
                subject = translatedEvent;

                const bodyTemplate = emailConfig?.bodyTemplate || genericEmailBody;
                body = this.interpolate(bodyTemplate, baseInterpolationData);
                break;

            case 'webhook':
                const webhookConfig = setting.config as WebhookConfig;
                const webhookTemplate = webhookConfig.bodyTemplate || genericWebhookBody;
                const isJson = this.isJsonTemplate(webhookTemplate, webhookConfig.headers);
                body = isJson
                    ? this.interpolateJson(webhookTemplate, baseInterpolationData)
                    : this.interpolate(webhookTemplate, baseInterpolationData);
                break;

            case 'telegram':
                const telegramConfig = setting.config as TelegramConfig;
                const telegramTemplate = telegramConfig.messageTemplate || genericTelegramBody;
                body = this.interpolate(telegramTemplate, baseInterpolationData);
                break;

            default:
                console.warn(`[NotificationProcessor] 不支持的通道类型: ${setting.channel_type}`);
                return null;
        }

        return {
            channelType: setting.channel_type,
            config: setting.config,
            subject: subject,
            body: body,
            rawPayload: payload
        };
    }

    /**
     * 判断模板是否为 JSON 结构或声明为 JSON 请求头
     */
    private isJsonTemplate(template: string, headers?: Record<string, string>): boolean {
        const trimmed = (template || '').trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            return true;
        }
        if (headers) {
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === 'content-type' && headers[key].toLowerCase().includes('application/json')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * JSON 感知的安全模板插值
     */
    private interpolateJson(template: string, data: Record<string, any>): string {
        if (!template) return '';
        let result = '';
        let inString = false;
        let i = 0;

        while (i < template.length) {
            const char = template[i];

            if (inString) {
                if (char === '\\') {
                    result += char;
                    if (i + 1 < template.length) {
                        result += template[i + 1];
                        i += 2;
                        continue;
                    }
                } else if (char === '"') {
                    inString = false;
                    result += char;
                    i++;
                    continue;
                }
            } else {
                if (char === '"') {
                    inString = true;
                    result += char;
                    i++;
                    continue;
                }
            }

            if (char === '{') {
                const match = template.slice(i).match(/^\{(\w+)\}/);
                if (match) {
                    const key = match[1];
                    if (data.hasOwnProperty(key) && data[key] !== null && data[key] !== undefined) {
                        const rawVal = data[key];
                        if (inString) {
                            const strVal = typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal);
                            result += JSON.stringify(strVal).slice(1, -1);
                        } else {
                            result += JSON.stringify(rawVal);
                        }
                        i += match[0].length;
                        continue;
                    }
                }
            }

            result += char;
            i++;
        }

        return result;
    }

    /**
     * 简单的字符串模板插值替换
     * @param template 模板字符串，例如 "Hello {name}"
     * @param data 数据对象，例如 { name: "World" }
     * @returns 替换后的字符串
     */
    private interpolate(template: string, data: Record<string, any>): string {
        if (!template) return '';
        // 使用正则表达式全局替换 {key} 格式的占位符
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            // 如果 data 中存在对应的 key，则返回值，否则返回原始匹配（例如 "{unknownKey}"）
             return data.hasOwnProperty(key) && data[key] !== null && data[key] !== undefined ? String(data[key]) : match;
        });
    }
}

// 创建单例并导出
const notificationProcessorService = new NotificationProcessorService();

export default notificationProcessorService;