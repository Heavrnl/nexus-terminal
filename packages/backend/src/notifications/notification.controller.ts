import { Request, Response } from 'express';
import { NotificationSettingsRepository } from './notification.repository'; // Use repository
import { NotificationSetting, NotificationChannelType, NotificationChannelConfig, WebhookConfig, EmailConfig, TelegramConfig, NotificationEvent } from '../types/notification.types';
// import { AuditLogService } from '../services/audit.service'; // Keep for now if other parts use it - Removed as eventService is used
import { AppEventType, default as eventService } from '../services/event.service'; // Import event service
import i18next from '../i18n'; // Import the i18next instance

// Remove sender imports as they are no longer called directly for testing
// import telegramSenderService from '../services/senders/telegram.sender.service';
// import emailSenderService from '../services/senders/email.sender.service';
// import webhookSenderService from '../services/senders/webhook.sender.service';
// import { ProcessedNotification } from '../services/notification.processor.service'; // Not needed here

// Removed escapeTelegramMarkdownV2 helper function

// const auditLogService = new AuditLogService(); // Removed as eventService is used

export class NotificationController {
    private repository: NotificationSettingsRepository; // Use repository

    constructor() {
        this.repository = new NotificationSettingsRepository(); // Instantiate repository
    }

    // GET /api/v1/notifications
    getAll = async (req: Request, res: Response): Promise<void> => {
        try {
            const settings = await this.repository.getAll(); // Use repository
            res.status(200).json(settings);
        } catch (error: any) {
          // Use i18next.t for i18n
          res.status(500).json({ message: i18next.t('notificationController.errorFetchSettings'), error: error.message });
      }
  };

    // POST /api/v1/notifications
    create = async (req: Request, res: Response): Promise<void> => {
        const settingData: Omit<NotificationSetting, 'id' | 'created_at' | 'updated_at'> = req.body;

        if (!settingData.channel_type || !settingData.name || !settingData.config) {
           // Use i18next.t for i18n
           res.status(400).json({ message: i18next.t('notificationController.errorMissingFields') });
           return;
      }

        try {
            const newSettingId = await this.repository.create(settingData); // Use repository
            const newSetting = await this.repository.getById(newSettingId);
            // 记录审计日志 (Use event service)
            if (newSetting) {
                 eventService.emitEvent(AppEventType.NotificationSettingCreated, {
                     userId: (req.session as any).userId, // Assuming userId is in session
                     details: { settingId: newSetting.id, name: newSetting.name, type: newSetting.channel_type }
                 });
            }
            res.status(201).json(newSetting);
        } catch (error: any) {
          // Use i18next.t for i18n
          res.status(500).json({ message: i18next.t('notificationController.errorCreateSetting'), error: error.message });
      }
  };

    // PUT /api/v1/notifications/:id
    update = async (req: Request, res: Response): Promise<void> => {
        const id = parseInt(req.params.id, 10);
        const settingData: Partial<Omit<NotificationSetting, 'id' | 'created_at' | 'updated_at'>> = req.body;

        if (isNaN(id)) {
          // Use i18next.t for i18n
          res.status(400).json({ message: i18next.t('notificationController.errorInvalidId') });
          return;
      }
        if (Object.keys(settingData).length === 0) {
          // Use i18next.t for i18n
          res.status(400).json({ message: i18next.t('notificationController.errorNoUpdateData') });
          return;
      }

        try {
            const success = await this.repository.update(id, settingData); // Use repository
            if (success) {
                const updatedSetting = await this.repository.getById(id);
                // 记录审计日志 (Use event service)
                 eventService.emitEvent(AppEventType.NotificationSettingUpdated, {
                     userId: (req.session as any).userId,
                     details: { settingId: id, updatedFields: Object.keys(settingData) }
                 });
                res.status(200).json(updatedSetting);
            } else {
              // Use i18next.t for i18n with interpolation
              res.status(404).json({ message: i18next.t('notificationController.errorNotFound', { id }) });
          }
      } catch (error: any) {
          // Use i18next.t for i18n
          res.status(500).json({ message: i18next.t('notificationController.errorUpdateSetting'), error: error.message });
      }
  };

    // DELETE /api/v1/notifications/:id
    delete = async (req: Request, res: Response): Promise<void> => {
        const id = parseInt(req.params.id, 10);

        if (isNaN(id)) {
          // Use i18next.t for i18n
          res.status(400).json({ message: i18next.t('notificationController.errorInvalidId') });
          return;
      }

        try {
            const settingToDelete = await this.repository.getById(id); // Get details before deleting for audit log
            if (!settingToDelete) {
               // Use i18next.t for i18n with interpolation
               res.status(404).json({ message: i18next.t('notificationController.errorNotFound', { id }) });
               return;
          }
            const success = await this.repository.delete(id); // Use repository
            if (success) {
                // 记录审计日志 (Use event service)
                 eventService.emitEvent(AppEventType.NotificationSettingDeleted, {
                     userId: (req.session as any).userId,
                     details: { settingId: id, name: settingToDelete.name, type: settingToDelete.channel_type } // Include name/type in audit
                 });
                res.status(204).send(); // No Content
            } else {
              // Should not happen if getById succeeded, but handle defensively
              // Use i18next.t for i18n with interpolation
              res.status(404).json({ message: i18next.t('notificationController.errorDeleteNotFound', { id }) });
          }
      } catch (error: any) {
          // Use i18next.t for i18n
          res.status(500).json({ message: i18next.t('notificationController.errorDeleteSetting'), error: error.message });
      }
  };

    // --- Refactored Test Endpoints ---

    // Removed executeTestSend method as testing now goes through the event system

    // POST /api/v1/notifications/:id/test
    // Tests an existing, saved setting configuration by triggering a test event
    testSetting = async (req: Request, res: Response): Promise<void> => {
        const id = parseInt(req.params.id, 10);

        if (isNaN(id)) {
          // Use i18next.t for i18n
          res.status(400).json({ message: i18next.t('notificationController.errorInvalidId') });
          return;
      }

        try {
            const settingToTest = await this.repository.getById(id);
            if (!settingToTest) {
              // Use i18next.t for i18n with interpolation
              res.status(404).json({ message: i18next.t('notificationController.errorNotFound', { id }) });
              return;
          }

            // Trigger the standard test event, passing the config to be used by the processor
            eventService.emitEvent(AppEventType.TestNotification, {
                userId: (req.session as any).userId, // Optional: associate test with user
              details: {
                 // Use i18next.t for i18n with interpolation
                 message: i18next.t('notificationController.testMessageSaved', { id, name: settingToTest.name }),
                },
                testTargetConfig: settingToTest.config,
                testTargetChannelType: settingToTest.channel_type
            });

          // Respond immediately confirming the event was triggered
         // Use i18next.t for i18n
         res.status(200).json({ message: i18next.t('notificationController.testEventTriggered') });

     } catch (error: any) {
          console.error(`[NotificationController] Error triggering test for setting ${id}:`, error);
         // Use i18next.t for i18n
         res.status(500).json({ message: i18next.t('notificationController.errorTriggerTest'), error: error.message });
     }
 };

    // POST /api/v1/notifications/test-unsaved
    // Tests configuration data provided in the request body by triggering a test event
    testUnsavedSetting = async (req: Request, res: Response): Promise<void> => {
        const { channel_type, config } = req.body as { channel_type: NotificationChannelType, config: NotificationChannelConfig };

      if (!channel_type || !config) {
         // Use i18next.t for i18n
         res.status(400).json({ message: i18next.t('notificationController.errorMissingTestInfo') });
         return;
     }

      if (!['webhook', 'email', 'telegram'].includes(channel_type)) {
          // Use i18next.t for i18n
          res.status(400).json({ message: i18next.t('notificationController.errorInvalidChannelType') });
          return;
     }

        try {
            // Trigger the standard test event, passing the unsaved config to be used by the processor
            eventService.emitEvent(AppEventType.TestNotification, {
                userId: (req.session as any).userId,
              details: {
                 // Use i18next.t for i18n with interpolation
                 message: i18next.t('notificationController.testMessageUnsaved', { channelType: channel_type }),
                },
                testTargetConfig: config,
                testTargetChannelType: channel_type
            });

           // Respond immediately confirming the event was triggered
          // Use i18next.t for i18n
         res.status(200).json({ message: i18next.t('notificationController.testEventTriggered') });

     } catch (error: any) {
           console.error(`[NotificationController] Error triggering test for unsaved ${channel_type}:`, error);
          // Use i18next.t for i18n
         res.status(500).json({ message: i18next.t('notificationController.errorTriggerTest'), error: error.message });
     }
 };
}
