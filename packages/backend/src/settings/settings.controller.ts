import { Request, Response } from 'express';
import { settingsService } from '../services/settings.service';
import { AuditLogService } from '../services/audit.service';
import { NotificationService } from '../services/notification.service'; // 添加导入
import { ipBlacklistService } from '../services/ip-blacklist.service';
import { UpdateSidebarConfigDto, UpdateCaptchaSettingsDto, CaptchaSettings } from '../types/settings.types'; // <-- Import CAPTCHA types
import i18next from '../i18n'; //  Import i18next 

const auditLogService = new AuditLogService();
const notificationService = new NotificationService(); // 添加实例

export const settingsController = {
  /**
   * 获取所有设置项
   */
  async getAllSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await settingsService.getAllSettings();
      res.json(settings);
    } catch (error: any) {
      console.error('获取所有设置时出错:', error);
      res.status(500).json({ message: '获取设置失败', error: error.message });
    }
  },

  /**
   * 批量更新设置项
   */
  async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const settingsToUpdate: Record<string, string> = req.body;
      if (typeof settingsToUpdate !== 'object' || settingsToUpdate === null) {
        res.status(400).json({ message: '无效的请求体，应为 JSON 对象' });
        return;
      }

      const allowedSettingsKeys = [
          'language', 'ipWhitelist', 'maxLoginAttempts', 'loginBanDuration',
          'showPopupFileEditor', 'shareFileEditorTabs', 'ipWhitelistEnabled',
          'autoCopyOnSelect', 'dockerStatusIntervalSeconds', 'dockerDefaultExpand',
          'statusMonitorIntervalSeconds', //  添加状态监控间隔键 
          'workspaceSidebarPersistent', //  添加侧边栏固定键 
          'sidebarPaneWidths', //  添加侧边栏宽度对象键 
          'fileManagerRowSizeMultiplier', //  添加文件管理器行大小键 
          'fileManagerColWidths', //  添加文件管理器列宽键 
          'commandInputSyncTarget', //  添加命令输入同步目标键 
          'timezone', // 添加时区键
          'rdpModalWidth', // 添加 RDP 模态框宽度键
          'rdpModalHeight', // 添加 RDP 模态框高度键
          'ipBlacklistEnabled', // 添加 IP 黑名单启用键
          'layoutLocked', // 添加布局锁定键
          'terminalScrollbackLimit', // 添加终端回滚行数键
          'fileManagerShowDeleteConfirmation', // 添加文件管理器删除确认键
          'autoLoginIpWhitelistEnabled',
          'autoLoginIpWhitelistAllowedIPs'
      ];
      const filteredSettings: Record<string, string> = {};
      for (const key in settingsToUpdate) {
          if (allowedSettingsKeys.includes(key)) {
              filteredSettings[key] = settingsToUpdate[key];
          }
      }

      if (Object.keys(filteredSettings).length > 0) {
          await settingsService.setMultipleSettings(filteredSettings);
      }

      const updatedKeys = Object.keys(filteredSettings);
      if (updatedKeys.length > 0) {
          if (updatedKeys.includes('ipWhitelist') || updatedKeys.includes('ipWhitelistEnabled')) {
              auditLogService.logAction('IP_WHITELIST_UPDATED', { updatedKeys });
          } else {
              auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys });
              notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys }); // 添加通知调用
            }
        }
      res.status(200).json({ message: '设置已成功更新' });
    } catch (error: any) {
      console.error('更新设置时出错:', error);
      res.status(500).json({ message: '更新设置失败', error: error.message });
    }
  },

  /**
   * 获取焦点切换顺序
   */
  async getFocusSwitcherSequence(req: Request, res: Response): Promise<void> {
    try {
      console.log('[控制器] 收到获取焦点切换顺序的请求。');
      const sequence = await settingsService.getFocusSwitcherSequence();
      console.log('[控制器] 向客户端发送焦点切换顺序:', JSON.stringify(sequence));
      res.json(sequence);
    } catch (error: any) {
      console.error('[控制器] 获取焦点切换顺序时出错:', error);
      res.status(500).json({ message: '获取焦点切换顺序失败', error: error.message });
    }
  },

  /**
   * 设置焦点切换顺序
   */
  async setFocusSwitcherSequence(req: Request, res: Response): Promise<void> {
    console.log('[控制器] 收到设置焦点切换顺序的请求。');
    try {
      //  修改：获取请求体并验证其是否符合 FocusSwitcherFullConfig 结构 
      const fullConfig = req.body;
      console.log('[控制器] 请求体 fullConfig:', JSON.stringify(fullConfig));

      //  验证 FocusSwitcherFullConfig 结构 
      if (
          !(typeof fullConfig === 'object' && fullConfig !== null &&
          Array.isArray(fullConfig.sequence) && fullConfig.sequence.every((item: any) => typeof item === 'string') &&
          typeof fullConfig.shortcuts === 'object' && fullConfig.shortcuts !== null &&
          Object.values(fullConfig.shortcuts).every((sc: any) => typeof sc === 'object' && sc !== null && (sc.shortcut === undefined || typeof sc.shortcut === 'string')))
      ) {
        console.warn('[控制器] 收到无效的完整焦点配置格式:', fullConfig);
        res.status(400).json({ message: '无效的请求体，必须是包含 sequence (string[]) 和 shortcuts (Record<string, {shortcut?: string}>) 的对象' });
        return;
      }

      console.log('[控制器] 使用验证后的完整配置调用 settingsService.setFocusSwitcherSequence...');
      //  传递验证后的 fullConfig 给服务层 
      await settingsService.setFocusSwitcherSequence(fullConfig);
      console.log('[控制器] settingsService.setFocusSwitcherSequence 成功完成。');

      console.log('[控制器] 记录审计操作: FOCUS_SWITCHER_SEQUENCE_UPDATED');
  
      console.log('[控制器] 发送成功响应。');
      res.status(200).json({ message: '焦点切换顺序已成功更新' });
    } catch (error: any) {
      console.error('[控制器] 设置焦点切换顺序时出错:', error);
      if (error.message === 'Invalid sequence format provided.') {
          res.status(400).json({ message: '设置焦点切换顺序失败: 无效的格式', error: error.message });
      } else {
          res.status(500).json({ message: '设置焦点切换顺序失败', error: error.message });
      }
    }
  },

 /**
  * 获取导航栏可见性设置
  */
 async getNavBarVisibility(req: Request, res: Response): Promise<void> {
   try {
     console.log('[控制器] 收到获取导航栏可见性的请求。');
     const isVisible = await settingsService.getNavBarVisibility();
     console.log(`[控制器] 向客户端发送导航栏可见性: ${isVisible}`);
     res.json({ visible: isVisible });
   } catch (error: any) {
     console.error('[控制器] 获取导航栏可见性时出错:', error);
     res.status(500).json({ message: '获取导航栏可见性失败', error: error.message });
   }
 },

 /**
  * 设置导航栏可见性
  */
 async setNavBarVisibility(req: Request, res: Response): Promise<void> {
   console.log('[控制器] 收到设置导航栏可见性的请求。');
   try {
     const { visible } = req.body;
     console.log('[控制器] 请求体 visible:', visible);

     if (typeof visible !== 'boolean') {
       console.warn('[控制器] 收到无效的 visible 格式:', visible);
       res.status(400).json({ message: '无效的请求体，"visible" 必须是一个布尔值' });
       return;
     }

     console.log('[控制器] 调用 settingsService.setNavBarVisibility...');
     await settingsService.setNavBarVisibility(visible);
     console.log('[控制器] settingsService.setNavBarVisibility 成功完成。');


     console.log('[控制器] 发送成功响应。');
     res.status(200).json({ message: '导航栏可见性已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置导航栏可见性时出错:', error);
     res.status(500).json({ message: '设置导航栏可见性失败', error: error.message });
   }
 },

  /**
   * 获取布局树设置
   */
  async getLayoutTree(req: Request, res: Response): Promise<void> {
    try {
      console.log('[控制器] 收到获取布局树的请求。');
      const layoutJson = await settingsService.getLayoutTree();
      if (layoutJson) {
        try {
          const layout = JSON.parse(layoutJson);
          console.log('[控制器] 向客户端发送布局树。');
          res.json(layout);
        } catch (parseError) {
          console.error('[控制器] 从数据库解析布局树 JSON 失败:', parseError);
          res.status(500).json({ message: '获取布局树失败：存储的数据格式无效' });
        }
      } else {
        console.log('[控制器] 在设置中未找到布局树，发送 null。');
        res.json(null);
      }
    } catch (error: any) {
      console.error('[控制器] 获取布局树时出错:', error);
      res.status(500).json({ message: '获取布局树失败', error: error.message });
    }
  },

  /**
   * 设置布局树
   */
  async setLayoutTree(req: Request, res: Response): Promise<void> {
    console.log('[控制器] 收到设置布局树的请求。');
    try {
      const layoutTree = req.body;

      if (typeof layoutTree !== 'object' || layoutTree === null) {
         console.warn('[控制器] 收到无效的布局树格式 (非对象):', layoutTree);
         res.status(400).json({ message: '无效的请求体，应为 JSON 对象格式的布局树' });
         return;
      }

      const layoutJson = JSON.stringify(layoutTree);

      console.log('[控制器] 调用 settingsService.setLayoutTree...');
      await settingsService.setLayoutTree(layoutJson);
      console.log('[控制器] settingsService.setLayoutTree 成功完成。');

      // auditLogService.logAction('LAYOUT_TREE_UPDATED');

      console.log('[控制器] 发送成功响应。');
      res.status(200).json({ message: '布局树已成功更新' });
    } catch (error: any) {
      console.error('[控制器] 设置布局树时出错:', error);
       if (error.message === 'Invalid layout tree JSON format.') {
           res.status(400).json({ message: '设置布局树失败: 无效的 JSON 格式', error: error.message });
       } else {
           res.status(500).json({ message: '设置布局树失败', error: error.message });
       }
    }
  },

 /**
  * 获取 IP 黑名单列表 (分页)
   */
  async getIpBlacklist(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string || '50', 10);
      const offset = parseInt(req.query.offset as string || '0', 10);
      const result = await ipBlacklistService.getBlacklist(limit, offset);
      res.json(result);
    } catch (error: any) {
      console.error('获取 IP 黑名单时出错:', error);
      res.status(500).json({ message: '获取 IP 黑名单失败', error: error.message });
    }
  },

  /**
   * 从 IP 黑名单中删除一个 IP
   */
  async deleteIpFromBlacklist(req: Request, res: Response): Promise<void> {
    try {
      const ipToDelete = req.params.ip;
      if (!ipToDelete) {
        res.status(400).json({ message: '缺少要删除的 IP 地址' });
        return;
      }
      await ipBlacklistService.removeFromBlacklist(ipToDelete);
      res.status(200).json({ message: `IP 地址 ${ipToDelete} 已从黑名单中移除` });
    } catch (error: any) {
      console.error(`从 IP 黑名单删除 ${req.params.ip} 时出错:`, error);
      res.status(500).json({ message: '从 IP 黑名单删除失败', error: error.message });
    }
  }, // *** 确保这里有逗号 ***

  /**
   * 获取终端选中自动复制设置
   */
  async getAutoCopyOnSelect(req: Request, res: Response): Promise<void> {
    try {
      console.log('[控制器] 收到获取“选中时自动复制”设置的请求。');
      const isEnabled = await settingsService.getAutoCopyOnSelect();
      console.log(`[控制器] 向客户端发送“选中时自动复制”设置: ${isEnabled}`);
      res.json({ enabled: isEnabled });
    } catch (error: any) {
      console.error('[控制器] 获取终端选中自动复制设置时出错:', error);
      res.status(500).json({ message: '获取终端选中自动复制设置失败', error: error.message });
    }
  }, // *** 确保这里有逗号 ***

  /**
   * 设置终端选中自动复制
   */
  async setAutoCopyOnSelect(req: Request, res: Response): Promise<void> {
    console.log('[控制器] 收到设置“选中时自动复制”设置的请求。');
    try {
      const { enabled } = req.body;
      console.log('[控制器] 请求体 enabled:', enabled);

      if (typeof enabled !== 'boolean') {
        console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
        res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
        return;
      }

      console.log('[控制器] 调用 settingsService.setAutoCopyOnSelect...');
      await settingsService.setAutoCopyOnSelect(enabled);
      console.log('[控制器] settingsService.setAutoCopyOnSelect 成功完成。');


      console.log('[控制器] 发送成功响应。');
      res.status(200).json({ message: '终端选中自动复制设置已成功更新' });
    } catch (error: any) {
      console.error('[控制器] 设置终端选中自动复制时出错:', error);
      res.status(500).json({ message: '设置终端选中自动复制失败', error: error.message });
    }
  },


 /**
  * 获取侧栏配置
  */
 async getSidebarConfig(req: Request, res: Response): Promise<void> {
     try {
         console.log('[控制器] 收到获取侧边栏配置的请求。');
         const config = await settingsService.getSidebarConfig();
         console.log('[控制器] 向客户端发送侧边栏配置:', config);
         res.json(config);
     } catch (error: any) {
         console.error('[控制器] 获取侧栏配置时出错:', error);
         res.status(500).json({ message: '获取侧栏配置失败', error: error.message });
     }
 },

 /**
  * 设置侧栏配置
  */
 async setSidebarConfig(req: Request, res: Response): Promise<void> {
     console.log('[控制器] 收到设置侧边栏配置的请求。');
     try {
         const configDto: UpdateSidebarConfigDto = req.body;
         console.log('[控制器] 请求体:', configDto);

         // --- DTO Validation (Basic) ---
         // More specific validation happens in the service layer
         if (!configDto || typeof configDto !== 'object' || !Array.isArray(configDto.left) || !Array.isArray(configDto.right)) {
             console.warn('[控制器] 收到无效的侧边栏配置格式:', configDto);
             res.status(400).json({ message: '无效的请求体，应为包含 left 和 right 数组的 JSON 对象' });
             return;
         }

         console.log('[控制器] 调用 settingsService.setSidebarConfig...');
         await settingsService.setSidebarConfig(configDto);
         console.log('[控制器] settingsService.setSidebarConfig 成功完成。');


         console.log('[控制器] 发送成功响应。');
         res.status(200).json({ message: '侧栏配置已成功更新' });
     } catch (error: any) {
         console.error('[控制器] 设置侧栏配置时出错:', error);
         // Handle specific validation errors from the service
         if (error.message.includes('无效的面板名称') || error.message.includes('无效的侧栏配置格式')) {
              res.status(400).json({ message: `设置侧栏配置失败: ${error.message}` });
         } else {
              res.status(500).json({ message: '设置侧栏配置失败', error: error.message });
         }
     }
}, 

/**
 * 获取公共 CAPTCHA 配置 (不含密钥)
 */
async getCaptchaConfig(req: Request, res: Response): Promise<void> {
    try {
        console.log('[控制器] 收到获取 CAPTCHA 配置的请求。');
        const fullConfig = await settingsService.getCaptchaConfig();

        const publicConfig = {
            enabled: fullConfig.enabled,
            provider: fullConfig.provider,
            hcaptchaSiteKey: fullConfig.hcaptchaSiteKey,
            recaptchaSiteKey: fullConfig.recaptchaSiteKey,
        };

        console.log('[控制器] 向客户端发送公共 CAPTCHA 配置:', publicConfig);
        res.json(publicConfig);
    } catch (error: any) {
        console.error('[控制器] 获取 CAPTCHA 配置时出错:', error);
        res.status(500).json({ message: '获取 CAPTCHA 配置失败', error: error.message });
    }
},

/**
 * 设置 CAPTCHA 配置
 */
async setCaptchaConfig(req: Request, res: Response): Promise<void> {
    console.log('[控制器] 收到设置 CAPTCHA 配置的请求。');
    try {
        const configDto: UpdateCaptchaSettingsDto = req.body;
        console.log('[控制器] 请求体 (DTO, 密钥已屏蔽):', { ...configDto, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' });

        if (!configDto || typeof configDto !== 'object') {
            console.warn('[控制器] 收到无效的 CAPTCHA 配置格式 (非对象):', configDto);
            res.status(400).json({ message: '无效的请求体，应为 JSON 对象' });
            return;
        }


        console.log('[控制器] 调用 settingsService.setCaptchaConfig...');
        await settingsService.setCaptchaConfig(configDto);
        console.log('[控制器] settingsService.setCaptchaConfig 成功完成。');


        console.log('[控制器] 发送成功响应。');
        res.status(200).json({ message: 'CAPTCHA 配置已成功更新' });
    } catch (error: any) {
        console.error('[控制器] 设置 CAPTCHA 配置时出错:', error);
        // Handle specific validation errors from the service
        if (error.message.includes('无效的') || error.message.includes('必须是')) { 
             res.status(400).json({ message: `设置 CAPTCHA 配置失败: ${error.message}` });
        } else {
             res.status(500).json({ message: '设置 CAPTCHA 配置失败', error: error.message });
        }
    }
}, // <-- Add comma here

 // --- Show Connection Tags ---
 async getShowConnectionTags(req: Request, res: Response): Promise<void> {
   try {
     console.log('[控制器] 收到获取“显示连接标签”设置的请求。');
     const isEnabled = await settingsService.getShowConnectionTags();
     console.log(`[控制器] 向客户端发送“显示连接标签”设置: ${isEnabled}`);
     res.json({ enabled: isEnabled });
   } catch (error: any) {
     console.error('[控制器] 获取“显示连接标签”设置时出错:', error);
     res.status(500).json({ message: '获取“显示连接标签”设置失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 async setShowConnectionTags(req: Request, res: Response): Promise<void> {
   console.log('[控制器] 收到设置“显示连接标签”设置的请求。');
   try {
     const { enabled } = req.body;
     console.log('[控制器] 请求体 enabled:', enabled);

     if (typeof enabled !== 'boolean') {
       console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
       res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
       return;
     }

     console.log('[控制器] 调用 settingsService.setShowConnectionTags...');
     await settingsService.setShowConnectionTags(enabled);
     console.log('[控制器] settingsService.setShowConnectionTags 成功完成。');

     auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys: ['showConnectionTags'] });
     notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys: ['showConnectionTags'] });

     console.log('[控制器] 发送成功响应。');
     res.status(200).json({ message: '“显示连接标签”设置已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置“显示连接标签”时出错:', error);
     res.status(500).json({ message: '设置“显示连接标签”失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 // --- Show Quick Command Tags ---
 async getShowQuickCommandTags(req: Request, res: Response): Promise<void> {
   try {
     console.log('[控制器] 收到获取“显示快捷指令标签”设置的请求。');
     const isEnabled = await settingsService.getShowQuickCommandTags();
     console.log(`[控制器] 向客户端发送“显示快捷指令标签”设置: ${isEnabled}`);
     res.json({ enabled: isEnabled });
   } catch (error: any) {
     console.error('[控制器] 获取“显示快捷指令标签”设置时出错:', error);
     res.status(500).json({ message: '获取“显示快捷指令标签”设置失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 async setShowQuickCommandTags(req: Request, res: Response): Promise<void> {
   console.log('[控制器] 收到设置“显示快捷指令标签”设置的请求。');
   try {
     const { enabled } = req.body;
     console.log('[控制器] 请求体 enabled:', enabled);

     if (typeof enabled !== 'boolean') {
       console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
       res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
       return;
     }

     console.log('[控制器] 调用 settingsService.setShowQuickCommandTags...');
     await settingsService.setShowQuickCommandTags(enabled);
     console.log('[控制器] settingsService.setShowQuickCommandTags 成功完成。');

     auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys: ['showQuickCommandTags'] });
     notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys: ['showQuickCommandTags'] });

     console.log('[控制器] 发送成功响应。');
     res.status(200).json({ message: '“显示快捷指令标签”设置已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置“显示快捷指令标签”时出错:', error);
     res.status(500).json({ message: '设置“显示快捷指令标签”失败', error: error.message });
   }
 } // <-- No comma after the last method

};
