import axios, { AxiosRequestConfig } from "axios";
import { NotificationSettingsRepository } from "../notifications/notification.repository";
import {
  NotificationSetting,
  NotificationEvent,
  NotificationPayload,
  WebhookConfig,
  EmailConfig,
  TelegramConfig,
  NotificationChannelConfig,
  NotificationChannelType,
} from "../types/notification.types";
import * as nodemailer from "nodemailer";
import Mail from "nodemailer/lib/mailer";
import i18next, { defaultLng, supportedLngs } from "../i18n";
import { settingsService } from "../settings/settings.service";
import { formatInTimeZone } from "date-fns-tz";

const testSubjectKey = "testNotification.subject";
const testEmailBodyKey = "testNotification.email.body";
const testEmailBodyHtmlKey = "testNotification.email.bodyHtml";
const testWebhookDetailsKey = "testNotification.webhook.detailsMessage";
const testTelegramDetailsKey = "testNotification.telegram.detailsMessage";
const testTelegramBodyTemplateKey = "testNotification.telegram.bodyTemplate";

export class NotificationService {
  private repository: NotificationSettingsRepository;

  constructor() {
    this.repository = new NotificationSettingsRepository();
  }

  async getAllSettings(): Promise<NotificationSetting[]> {
    return this.repository.getAll();
  }

  async getSettingById(id: number): Promise<NotificationSetting | null> {
    return this.repository.getById(id);
  }

  async createSetting(
    settingData: Omit<NotificationSetting, "id" | "created_at" | "updated_at">
  ): Promise<number> {
    return this.repository.create(settingData);
  }

  async updateSetting(
    id: number,
    settingData: Partial<
      Omit<NotificationSetting, "id" | "created_at" | "updated_at">
    >
  ): Promise<boolean> {
    return this.repository.update(id, settingData);
  }

  async deleteSetting(id: number): Promise<boolean> {
    return this.repository.delete(id);
  }

  async testSetting(
    channelType: NotificationChannelType,
    config: NotificationChannelConfig
  ): Promise<{ success: boolean; message: string }> {
    switch (channelType) {
      case "email":
        return this._testEmailSetting(config as EmailConfig);
      case "webhook":
        return this._testWebhookSetting(config as WebhookConfig);
      case "telegram":
        return this._testTelegramSetting(config as TelegramConfig);
      default:
        console.warn(`[通知测试] 不支持的测试渠道类型: ${channelType}`);
        return {
          success: false,
          message: `不支持测试此渠道类型 (${channelType})`,
        };
    }
  }

  private async _testEmailSetting(
    config: EmailConfig
  ): Promise<{ success: boolean; message: string }> {
    console.log("[通知测试 - 邮件] 开始测试...");
    if (!config.to || !config.smtpHost || !config.smtpPort || !config.from) {
      console.error("[通知测试 - 邮件] 缺少必要的配置。");
      return {
        success: false,
        message:
          "测试邮件失败：缺少必要的 SMTP 配置信息 (收件人, 主机, 端口, 发件人)。",
      };
    }

    let userLang = defaultLng;
    try {
      const langSetting = await settingsService.getSetting("language");
      if (langSetting && supportedLngs.includes(langSetting)) {
        userLang = langSetting;
      }
      console.log(`[通知测试 - 邮件] 使用语言: ${userLang}`);
    } catch (error) {
      console.error(
        `[通知测试 - 邮件] 获取语言设置时出错，使用默认 (${defaultLng}):`,
        error
      );
    }

    const transporterOptions = {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure ?? true,
      auth:
        config.smtpUser || config.smtpPass
          ? {
              user: config.smtpUser,
              pass: config.smtpPass,
            }
          : undefined,
    };

    const transporter = nodemailer.createTransport(transporterOptions);

    const eventDisplayName = i18next.t(`event.SETTINGS_UPDATED`, {
      lng: userLang,
      defaultValue: "SETTINGS_UPDATED",
    });

    const mailOptions: Mail.Options = {
      from: config.from,
      to: config.to,
      subject: i18next.t(testSubjectKey, {
        lng: userLang,
        defaultValue: "Nexus Terminal Test Notification ({event})",
        eventDisplay: eventDisplayName,
      }),
      text: i18next.t(testEmailBodyKey, {
        lng: userLang,
        timestamp: new Date().toISOString(),
        defaultValue: `This is a test email from Nexus Terminal for event '{{event}}'.\n\nIf you received this, your SMTP configuration is working.\n\nTimestamp: {{timestamp}}`,
        eventDisplay: eventDisplayName,
      }),
      html: i18next.t(testEmailBodyHtmlKey, {
        lng: userLang,
        timestamp: new Date().toISOString(),
        defaultValue: `<p>This is a test email from <b>Nexus Terminal</b> for event '{{event}}'.</p><p>If you received this, your SMTP configuration is working.</p><p>Timestamp: {{timestamp}}</p>`,
        eventDisplay: eventDisplayName,
      }),
    };

    try {
      console.log(
        `[通知测试 - 邮件] 尝试通过 ${config.smtpHost}:${config.smtpPort} 发送测试邮件至 ${config.to}`
      );
      const info = await transporter.sendMail(mailOptions);
      console.log(`[通知测试 - 邮件] 测试邮件发送成功: ${info.messageId}`);
      return { success: true, message: "测试邮件发送成功！请检查收件箱。" };
    } catch (error: any) {
      console.error(`[通知测试 - 邮件] 发送测试邮件时出错:`, error);
      return {
        success: false,
        message: `测试邮件发送失败: ${error.message || "未知错误"}`,
      };
    }
  }

  private async _testWebhookSetting(
    config: WebhookConfig
  ): Promise<{ success: boolean; message: string }> {
    console.log("[通知测试 - Webhook] 开始测试...");
    if (!config.url) {
      console.error("[通知测试 - Webhook] 缺少 URL。");
      return { success: false, message: "测试 Webhook 失败：缺少 URL。" };
    }

    let userLang = defaultLng;
    try {
      const langSetting = await settingsService.getSetting("language");
      if (langSetting && supportedLngs.includes(langSetting)) {
        userLang = langSetting;
      }
      console.log(`[通知测试 - Webhook] 使用语言: ${userLang}`);
    } catch (error) {
      console.error(
        `[通知测试 - Webhook] 获取语言设置时出错，使用默认 (${defaultLng}):`,
        error
      );
    }

    const testPayload: NotificationPayload = {
      event: "SETTINGS_UPDATED",
      timestamp: Date.now(),
      details: {
        message: i18next.t(testWebhookDetailsKey, {
          lng: userLang,
          defaultValue:
            "This is a test notification from Nexus Terminal (Webhook).",
        }),
      },
    };
    const translatedWebhookMessage =
      typeof testPayload.details === "object" && testPayload.details?.message
        ? testPayload.details.message
        : "Details 不是带有 message 属性的对象";
    console.log(
      `[通知测试 - Webhook] 测试负载已创建。翻译后的 details.message:`,
      translatedWebhookMessage
    );

    const eventDisplayName = i18next.t(`event.${testPayload.event}`, {
      lng: userLang,
      defaultValue: testPayload.event,
    });
    const defaultBody = JSON.stringify(testPayload, null, 2);
    const defaultBodyTemplate = `Default: JSON payload. Use {event}, {timestamp}, {details}.`;

    const templateDataWebhookTest: Record<string, string> = {
      event: testPayload.event,
      eventDisplay: eventDisplayName,
      timestamp: new Date(testPayload.timestamp).toISOString(),

      details:
        typeof testPayload.details === "object" && testPayload.details?.message
          ? testPayload.details.message
          : typeof testPayload.details === "string"
          ? testPayload.details
          : JSON.stringify(testPayload.details || {}, null, 2),
    };
    const requestBody = this._renderTemplate(
      config.bodyTemplate || defaultBodyTemplate,
      templateDataWebhookTest,
      defaultBody
    );

    let requestData: any = requestBody;
    const isJsonHeader = (config.headers?.["Content-Type"] || "application/json").toLowerCase().includes("application/json");
    if (isJsonHeader) {
      try {
        requestData = JSON.parse(requestBody);
      } catch (e) {
        requestData = requestBody;
      }
    }

    const requestConfig: AxiosRequestConfig = {
      method: config.method || "POST",
      url: config.url,
      headers: {
        "Content-Type": "application/json",
        ...(config.headers || {}),
      },
      data: requestData,
      timeout: 15000,
    };

    try {
      console.log(`[通知测试 - Webhook] 发送测试 Webhook 到 ${config.url}`);
      const response = await axios(requestConfig);
      console.log(
        `[通知测试 - Webhook] 测试 Webhook 成功发送到 ${config.url}。状态: ${response.status}`
      );
      return {
        success: true,
        message: `测试 Webhook 发送成功 (状态码: ${response.status})。`,
      };
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.message ||
        error.response?.data ||
        error.message ||
        "未知错误";
      console.error(
        `[通知测试 - Webhook] 发送测试 Webhook 到 ${config.url} 时出错:`,
        errorMessage
      );
      return {
        success: false,
        message: `测试 Webhook 发送失败: ${errorMessage}`,
      };
    }
  }

  private async _testTelegramSetting(
    config: TelegramConfig
  ): Promise<{ success: boolean; message: string }> {
    console.log("[通知测试 - Telegram] 开始测试...");
    if (!config.botToken || !config.chatId) {
      console.error("[通知测试 - Telegram] 缺少 botToken 或 chatId。");
      return {
        success: false,
        message: "测试 Telegram 失败：缺少机器人 Token 或聊天 ID。",
      };
    }

    let userLang = defaultLng;
    try {
      const langSetting = await settingsService.getSetting("language");
      if (langSetting && supportedLngs.includes(langSetting)) {
        userLang = langSetting;
      }
      console.log(`[通知测试 - Telegram] 使用语言: ${userLang}`);
    } catch (error) {
      console.error(
        `[通知测试 - Telegram] 获取语言设置时出错，使用默认 (${defaultLng}):`,
        error
      );
    }

    const testPayload: NotificationPayload = {
      event: "SETTINGS_UPDATED",
      timestamp: Date.now(),
      details: undefined,
    };

    const detailsOptions = {
      lng: userLang,
      defaultValue:
        "Fallback: This is a test notification from Nexus Terminal (Telegram).",
    };
    const keyWithNamespace = `notifications:${testTelegramDetailsKey}`;
    const translatedDetailsMessage = i18next.t(
      keyWithNamespace,
      detailsOptions
    );

    testPayload.details = { message: translatedDetailsMessage };

    const messageFromPayload =
      typeof testPayload.details === "object" && testPayload.details?.message
        ? testPayload.details.message
        : "Details is not an object with message property";
    console.log(
      `[Notification Test - Telegram] Test payload created. Final details.message in payload:`,
      messageFromPayload
    );

    const templateKeyWithNamespace = `notifications:${testTelegramBodyTemplateKey}`;
    const defaultMessageTemplateFromI18n = i18next.t(templateKeyWithNamespace, {
      lng: userLang,
      defaultValue: `Fallback Template: *Nexus Terminal Test Notification*\nEvent: \`{event}\`\nTimestamp: {timestamp}\nDetails:\n\`\`\`\n{details}\n\`\`\``,
    });
    console.log(
      `[通知测试 - Telegram] 来自 i18n 的默认模板 (使用语言 '${userLang}', 键 '${templateKeyWithNamespace}'):`,
      defaultMessageTemplateFromI18n
    );

    const templateToUse =
      config.messageTemplate || defaultMessageTemplateFromI18n;
    console.log(`[通知测试 - Telegram] 要渲染的模板:`, templateToUse);

    const eventDisplayName = i18next.t(`event.${testPayload.event}`, {
      lng: userLang,
      defaultValue: testPayload.event,
    });

    const templateDataTelegramTest: Record<string, string> = {
      event: this._escapeBasicMarkdown(testPayload.event),
      eventDisplay: this._escapeBasicMarkdown(eventDisplayName),
      timestamp: new Date(testPayload.timestamp).toISOString(),

      details: this._escapeBasicMarkdown(messageFromPayload),
    };

    const messageText = this._renderTemplate(
      templateToUse,
      templateDataTelegramTest,
      defaultMessageTemplateFromI18n
    );
    console.log(`[通知测试 - Telegram] 渲染的消息文本:`, messageText);

    let baseApiUrl = "https://api.telegram.org";
    if (config.customDomain) {
        try {
            const url = new URL(config.customDomain);
            baseApiUrl = `${url.protocol}//${url.host}`;
            console.log(`[通知测试 - Telegram] 使用自定义域名: ${baseApiUrl}`);
        } catch (e) {
            console.warn(`[通知测试 - Telegram] 无效的自定义域名 URL: ${config.customDomain}。将回退到默认 Telegram API。`);
        }
    }
    const telegramApiUrl = `${baseApiUrl}/bot${config.botToken}/sendMessage`;

    try {
      console.log(
        `[通知测试 - Telegram] 发送测试 Telegram 消息到聊天 ID ${config.chatId}`
      );
      const response = await axios.post(
        telegramApiUrl,
        {
          chat_id: config.chatId,
          text: messageText,
          parse_mode: "Markdown",
        },
        { timeout: 15000 }
      );

      if (response.data?.ok) {
        console.log(`[通知测试 - Telegram] 测试 Telegram 消息发送成功。`);
        return { success: true, message: "测试 Telegram 消息发送成功！" };
      } else {
        console.error(
          `[通知测试 - Telegram] Telegram API 返回错误:`,
          response.data?.description
        );
        return {
          success: false,
          message: `测试 Telegram 发送失败: ${
            response.data?.description || "API 返回失败"
          }`,
        };
      }
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.description ||
        error.response?.data ||
        error.message ||
        "未知错误";
      console.error(
        `[通知测试 - Telegram] 发送测试 Telegram 消息时出错:`,
        errorMessage
      );
      return {
        success: false,
        message: `测试 Telegram 发送失败: ${errorMessage}`,
      };
    }
  }

  async sendNotification(
    event: NotificationEvent,
    details?: Record<string, any> | string
  ): Promise<void> {
    // console.log(`[通知] 事件触发: ${event}`, details || "");

    let userLang = defaultLng;
    let userTimezone = "UTC";
    try {
      const [langSetting, timezoneSetting] = await Promise.all([
        settingsService.getSetting("language"),
        settingsService.getSetting("timezone"),
      ]);
      if (langSetting && supportedLngs.includes(langSetting)) {
        userLang = langSetting;
      }

      if (timezoneSetting) {
        userTimezone = timezoneSetting;
      }
    } catch (error) {
      console.error(`[通知] 获取事件 ${event} 的语言或时区设置时出错:`, error);
    }
    console.log(
      `[通知] 事件 ${event} 使用语言 '${userLang}', 时区 '${userTimezone}'`
    );

    const payload: NotificationPayload = {
      event,
      timestamp: Date.now(),
      details: details || undefined,
    };

    try {
      const applicableSettings = await this.repository.getEnabledByEvent(event);
      console.log(
        `[通知] 找到 ${applicableSettings.length} 个适用于事件 ${event} 的设置`
      );

      if (applicableSettings.length === 0) {
        return; // 此事件没有启用的设置
      }

      const sendPromises = applicableSettings.map((setting) => {
        switch (setting.channel_type) {
          case "webhook":
            return this._sendWebhook(setting, payload, userLang, userTimezone);
          case "email":
            return this._sendEmail(setting, payload, userLang, userTimezone);
          case "telegram":
            return this._sendTelegram(setting, payload, userLang, userTimezone);
          default:
            console.warn(
              `[通知] 未知渠道类型: ${setting.channel_type} (设置 ID: ${setting.id})`
            );
            return Promise.resolve();
        }
      });

      await Promise.allSettled(sendPromises);
      console.log(`[通知] 完成尝试发送事件 ${event} 的通知`);
    } catch (error) {
      console.error(`[通知] 获取或处理事件 ${event} 的设置时出错:`, error);
    }
  }

  private _escapeBasicMarkdown(text: string): string {
    if (typeof text !== "string") return "";

    return text.replace(/([*_`\[])/g, "\\$1");
  }

  private _renderTemplate(
    template: string | undefined,
    data: Record<string, string>,
    defaultText: string
  ): string {
    if (!template) return defaultText;
    const trimmed = template.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
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
                result += JSON.stringify(String(rawVal)).slice(1, -1);
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

    let rendered = template;
    for (const key in data) {
      rendered = rendered.replace(new RegExp(`\\{${key}\\}`, "g"), data[key]);
    }
    return rendered;
  }

  private async _sendWebhook(
    setting: NotificationSetting,
    payload: NotificationPayload,
    userLang: string,
    userTimezone: string
  ): Promise<void> {
    const config = setting.config as WebhookConfig;
    if (!config.url) {
      console.error(`[通知] Webhook 设置 ID ${setting.id} 缺少 URL。`);
      return;
    }

    const eventDisplayName = i18next.t(`event.${payload.event}`, {
      lng: userLang,
      defaultValue: payload.event,
    });

    const translatedDetails = this._translatePayloadDetails(
      payload.details,
      userLang
    );
    const translatedPayload = { ...payload, details: translatedDetails };

    const defaultBody = JSON.stringify(translatedPayload, null, 2);
    const defaultBodyTemplate = `Default: JSON payload. Use {event}, {timestamp}, {details}.`;

    const templateDataWebhook: Record<string, string> = {
      event: translatedPayload.event,
      eventDisplay: eventDisplayName,

      timestamp: formatInTimeZone(
        new Date(translatedPayload.timestamp),
        userTimezone,
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"
      ),

      details:
        typeof translatedPayload.details === "object" &&
        translatedPayload.details?.message
          ? translatedPayload.details.message
          : typeof translatedPayload.details === "string"
          ? translatedPayload.details
          : JSON.stringify(translatedPayload.details || {}, null, 2),
    };
    let templateToRender = config.bodyTemplate || defaultBodyTemplate;
    let isCustomTemplate = !!config.bodyTemplate;

    if (isCustomTemplate) {
      console.log(
        `[_sendWebhook] Original custom body template for event ${payload.event}:`,
        templateToRender
      );

      templateToRender = templateToRender.replace(
        /\{event\}/g,
        "{eventDisplay}"
      );
      console.log(
        `[_sendWebhook] Pre-processed body template (replaced {event} with {eventDisplay}):`,
        templateToRender
      );
    } else {
      console.log(
        `[_sendWebhook] No custom body template found. Using default template for event ${payload.event}`
      );
    }

    const requestBody = this._renderTemplate(
      templateToRender,
      templateDataWebhook,
      defaultBody
    );

    let requestData: any = requestBody;
    const isJsonHeader = (config.headers?.["Content-Type"] || "application/json").toLowerCase().includes("application/json");
    if (isJsonHeader) {
      try {
        requestData = JSON.parse(requestBody);
      } catch (e) {
        requestData = requestBody;
      }
    }

    const requestConfig: AxiosRequestConfig = {
      method: config.method || "POST",
      url: config.url,
      headers: {
        "Content-Type": "application/json",
        ...(config.headers || {}),
      },
      data: requestData,
      timeout: 10000,
    };

    try {
      console.log(
        `[通知] 发送 Webhook 到 ${config.url} (事件: ${payload.event})`
      );
      const response = await axios(requestConfig);
      console.log(
        `[通知] Webhook 成功发送到 ${config.url}。状态: ${response.status}`
      );
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.message || error.response?.data || error.message;
      console.error(
        `[通知] 发送 Webhook 到 ${config.url} (设置 ID: ${setting.id}) 时出错:`,
        errorMessage
      );
    }
  }

  private async _sendEmail(
    setting: NotificationSetting,
    payload: NotificationPayload,
    userLang: string,
    userTimezone: string
  ): Promise<void> {
    const config = setting.config as EmailConfig;
    if (!config.to || !config.smtpHost || !config.smtpPort || !config.from) {
      console.error(
        `[通知] 邮件设置 ID ${setting.id} 缺少必要的 SMTP 配置 (to, smtpHost, smtpPort, from)。`
      );
      return;
    }

    const transporterOptions = {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure ?? true,
      auth:
        config.smtpUser || config.smtpPass
          ? {
              user: config.smtpUser,
              pass: config.smtpPass,
            }
          : undefined,
    };

    const transporter = nodemailer.createTransport(transporterOptions);

    const i18nOptions: Record<string, any> = { lng: userLang };
    if (payload.details && typeof payload.details === "object") {
      Object.assign(i18nOptions, payload.details);
    } else if (payload.details !== undefined) {
      i18nOptions.details = payload.details;
    }

    const eventDisplayName = i18next.t(`event.${payload.event}`, {
      lng: userLang,
      defaultValue: payload.event,
    });

    const subject = eventDisplayName;
    console.log(
      `[_sendEmail] Using fixed subject for event ${payload.event}: ${subject}`
    );

    const formattedTimestampForEmail = formatInTimeZone(
      new Date(payload.timestamp),
      userTimezone,
      "yyyy-MM-dd HH:mm:ss zzz"
    );
    const detailsString =
      typeof payload.details === "string"
        ? payload.details
        : JSON.stringify(payload.details || {}, null, 2);

    const templateDataEmailBody: Record<string, string> = {
      event: payload.event,
      eventDisplay: eventDisplayName,
      timestamp: formattedTimestampForEmail,
      details: detailsString,

      ...Object.entries(i18nOptions).reduce((acc, [key, value]) => {
        if (key !== "lng" && typeof value !== "object") {
          acc[key] = String(value);
        }
        return acc;
      }, {} as Record<string, string>),
    };
    console.log(
      `[_sendEmail] Prepared templateDataEmailBody for event ${payload.event}:`,
      templateDataEmailBody
    );

    let body = "";
    const defaultBodyText = `Event: ${eventDisplayName}\nTimestamp: ${formattedTimestampForEmail}\nDetails:\n${detailsString}`;

    if (config.bodyTemplate) {
      let templateToRender = config.bodyTemplate;
      console.log(
        `[_sendEmail] Original custom body template for event ${payload.event}:`,
        templateToRender
      );

      templateToRender = templateToRender.replace(
        /\{event\}/g,
        "{eventDisplay}"
      );
      console.log(
        `[_sendEmail] Pre-processed body template (replaced {event} with {eventDisplay}):`,
        templateToRender
      );

      body = this._renderTemplate(
        templateToRender,
        templateDataEmailBody,
        defaultBodyText
      );
    } else {
      console.log(
        `[_sendEmail] No custom body template found. Using default constructed body text for event ${payload.event}`
      );
      body = defaultBodyText;
    }
    console.log(
      `[_sendEmail] Final email body for event ${payload.event}:\n${body}`
    );

    const mailOptions: Mail.Options = {
      from: config.from,
      to: config.to,
      subject: subject,
      text: body,
    };

    try {
      console.log(
        `[通知] 通过 ${config.smtpHost}:${config.smtpPort} 发送邮件至 ${config.to} (事件: ${payload.event}, 主题: ${subject})`
      );
      const info = await transporter.sendMail(mailOptions);
      console.log(
        `[通知] 邮件成功发送至 ${config.to} (设置 ID: ${setting.id})。消息 ID: ${info.messageId}`
      );
    } catch (error: any) {
      console.error(
        `[通知] 通过 ${config.smtpHost} 发送邮件 (设置 ID: ${setting.id}) 时出错:`,
        error
      );
    }
  }

  private async _sendTelegram(
    setting: NotificationSetting,
    payload: NotificationPayload,
    userLang: string,
    userTimezone: string
  ): Promise<void> {
    console.log(
      `[_sendTelegram] Initiating for event: ${payload.event}, Setting ID: ${setting.id}, Lang: ${userLang}, Timezone: ${userTimezone}`
    );
    console.log(
      `[_sendTelegram] Received payload:`,
      JSON.stringify(payload, null, 2)
    );
    const config = setting.config as TelegramConfig;
    if (!config.botToken || !config.chatId) {
      console.error(
        `[通知] Telegram 设置 ID ${setting.id} 缺少 botToken 或 chatId。`
      );
      return;
    }

    let detailsText = "";
    if (payload.details) {
      if (
        payload.event === "SETTINGS_UPDATED" &&
        typeof payload.details === "object" &&
        Array.isArray(payload.details.updatedKeys)
      ) {
        detailsText = payload.details.updatedKeys.join(", ");
      } else if (typeof payload.details === "string") {
        detailsText = payload.details;
      } else {
        detailsText = JSON.stringify(payload.details);
      }
    }
    console.log(`[_sendTelegram] Formatted detailsText:`, detailsText);

    const translatedEventName = i18next.t(`event.${payload.event}`, {
      lng: userLang,
      defaultValue: payload.event,
    });

    const templateData: Record<string, string> = {
      event: translatedEventName,
      timestamp: formatInTimeZone(
        new Date(payload.timestamp),
        userTimezone,
        "yyyy-MM-dd HH:mm:ss zzz"
      ),
      details: detailsText,
    };
    console.log(
      `[_sendTelegram] Prepared templateData (NO escaping):`,
      JSON.stringify(templateData, null, 2)
    );

    let messageText = "";
    if (config.messageTemplate) {
      console.log(
        `[_sendTelegram] Using custom template:`,
        config.messageTemplate
      );
      const fallbackForCustom = `Event: ${templateData.event}, Details: ${templateData.details}`;
      messageText = this._renderTemplate(
        config.messageTemplate,
        templateData,
        fallbackForCustom
      );
    } else {
      const i18nKey = `eventBody.${payload.event}`;
      console.log(`[_sendTelegram] Using i18n template key:`, i18nKey);
      const fallbackBody = `*Fallback Notification*\nEvent: ${templateData.event}\nTime: \`${templateData.timestamp}\`\nDetails: ${templateData.details}`;
      messageText = i18next.t(i18nKey, {
        lng: userLang,
        ...templateData,
        defaultValue: fallbackBody,
      });
    }
    console.log(`[_sendTelegram] Final message text to send:`, messageText);

    let baseApiUrlSend = "https://api.telegram.org";
    if (config.customDomain) {
        try {
            const url = new URL(config.customDomain);
            baseApiUrlSend = `${url.protocol}//${url.host}`;
            console.log(`[_sendTelegram] 使用自定义域名: ${baseApiUrlSend} (事件: ${payload.event})`);
        } catch (e) {
            console.warn(`[_sendTelegram] 无效的自定义域名 URL: ${config.customDomain} (事件: ${payload.event})。将回退到默认 Telegram API。`);
        }
    }
    const telegramApiUrl = `${baseApiUrlSend}/bot${config.botToken}/sendMessage`;

    try {
      console.log(
        `[通知] 发送 Telegram 消息到聊天 ID ${config.chatId} (事件: ${payload.event})`
      );
      const requestBody = {
        chat_id: config.chatId,
        text: messageText,
        parse_mode: "Markdown",
      };
      console.log(
        `[_sendTelegram] Sending request to Telegram API:`,
        JSON.stringify(requestBody, null, 2)
      );
      const response = await axios.post(telegramApiUrl, requestBody, {
        timeout: 10000,
      });
      console.log(`[通知] Telegram 消息发送成功。响应 OK:`, response.data?.ok);
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.description ||
        error.response?.data ||
        error.message;
      console.error(
        `[通知] 发送 Telegram 消息 (设置 ID: ${setting.id}) 时出错:`,
        errorMessage
      );
    }
  }

  private _translatePayloadDetails(details: any, lng: string): any {
    if (!details || typeof details !== "object") {
      return details;
    }

    if (details.testResult === "success" && details.connectionName) {
      return {
        ...details,
        message: i18next.t("connection.testSuccess", {
          lng,
          name: details.connectionName,
          defaultValue: `Connection test successful for '${details.connectionName}'!`,
        }),
      };
    }
    if (
      details.testResult === "failed" &&
      details.connectionName &&
      details.error
    ) {
      return {
        ...details,
        message: i18next.t("connection.testFailed", {
          lng,
          name: details.connectionName,
          error: details.error,
          defaultValue: `Connection test failed for '${details.connectionName}': ${details.error}`,
        }),
      };
    }

    if (details.updatedKeys && Array.isArray(details.updatedKeys)) {
      if (details.updatedKeys.includes("ipWhitelist")) {
        return {
          ...details,
          message: i18next.t("settings.ipWhitelistUpdated", {
            lng,
            defaultValue: "IP Whitelist updated successfully.",
          }),
        };
      }
      return {
        ...details,
        message: i18next.t("settings.updated", {
          lng,
          defaultValue: "Settings updated successfully.",
        }),
      };
    }

    return details;
  }
}
