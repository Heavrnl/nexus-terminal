import { Request, Response } from 'express';
import { settingsService } from './settings.service';
import { AuditLogService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service'; 
import { ipBlacklistService } from '../auth/ip-blacklist.service';
import { UpdateSidebarConfigDto, UpdateCaptchaSettingsDto, CaptchaSettings } from '../types/settings.types'; 
import { AppearanceSettings, UpdateAppearanceDto } from '../types/appearance.types';
import { getAppearanceSettings, updateAppearanceSettings as updateAppearanceSettingsInRepo } from '../appearance/appearance.repository';
import { getServerSyncApiKey } from '../sync/sync.middleware';
import { settingsRepository } from './settings.repository';
import { isWritableSettingKey } from './settings.schema';

const auditLogService = new AuditLogService();
const notificationService = new NotificationService(); 

/**
 * OIDC 提供商列表在 settings 表里的键。
 * 该键的值含加密后的 client_secret，只能经 /auth/oidc/settings 专用接口进出，
 * 通用 GET /settings 必须剥掉、通用 PUT /settings 必须拒绝（见 settings.schema.data.json 的 writable:false）。
 */
const OIDC_PROVIDERS_KEY = 'oidcProviders';

export const settingsController = {
/**
   * 获取外观设置
   */
  async getAppearanceSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await getAppearanceSettings();
      res.json(settings);
    } catch (error: any) {
      console.error('获取外观设置时出错:', error);
      res.status(500).json({ message: '获取外观设置失败', error: error.message });
    }
  },
/**
   * 更新外观设置
   */
  async updateAppearanceSettings(req: Request, res: Response): Promise<void> {
    try {
      const settingsDto: UpdateAppearanceDto = req.body;
      // 可在此处添加 DTO 验证逻辑
      if (typeof settingsDto !== 'object' || settingsDto === null) {
        res.status(400).json({ message: '无效的请求体，应为 JSON 对象' });
        return;
      }

      const result = await updateAppearanceSettingsInRepo(settingsDto);
      if (result) {
        res.status(200).json({ message: '外观设置已成功更新' });
      } else {
        // 如果仓库层返回 false，可能表示没有实际更改或更新失败
        res.status(200).json({ message: '外观设置未发生更改或更新失败' });
      }
    } catch (error: any) {
      console.error('更新外观设置时出错:', error);
      res.status(500).json({ message: '更新外观设置失败', error: error.message });
    }
  },
  /**
   * 获取所有设置项
   */
  async getAllSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await settingsService.getAllSettings();
      // oidcProviders 里存的是加密后的 client_secret 密文，属于服务端凭据，
      // 不能经通用设置接口回传（前端拿到密文后会原样写回，也会把密文暴露给
      // 任何能读设置的浏览器上下文）。它有自己的脱敏接口：
      //   GET /api/v1/auth/oidc/settings  → clientSecret 被替换为 hasClientSecret
      //   PUT /api/v1/auth/oidc/settings  → 唯一写入入口（schema 里已标 writable:false）
      delete (settings as Record<string, unknown>)[OIDC_PROVIDERS_KEY];
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

      // 白名单来自 settings.schema.json（唯一来源，见 settings.schema.ts）。
      //
      // 这里以前是硬编码数组，而且是"静默过滤"：不在名单里的键被悄悄丢掉，
      // 接口仍返回 200。结果是前端开关能点、刷新就复原，没有任何报错，
      // 排查成本极高（新增设置项时踩过一次）。
      // 现在被拒绝的键会原样回传，前端发现 rejected 非空会直接 console.error。
      const filteredSettings: Record<string, string> = {};
      const rejectedKeys: string[] = [];
      for (const key in settingsToUpdate) {
          if (isWritableSettingKey(key)) {
              filteredSettings[key] = settingsToUpdate[key];
          } else {
              rejectedKeys.push(key);
          }
      }

      if (rejectedKeys.length > 0) {
          console.warn('[Settings] 拒绝写入未在 schema 中声明的设置键:', rejectedKeys.join(', '));
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
      res.status(200).json({ message: '设置已成功更新', updatedKeys, rejectedKeys });
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
      const sequence = await settingsService.getFocusSwitcherSequence();
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
    try {
      // +++ 修改：获取请求体并验证其是否符合 FocusSwitcherFullConfig 结构 +++
      const fullConfig = req.body;
      console.log('[控制器] 请求体 fullConfig:', JSON.stringify(fullConfig));

      // +++ 验证 FocusSwitcherFullConfig 结构 +++
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

      
      // +++ 传递验证后的 fullConfig 给服务层 +++
      await settingsService.setFocusSwitcherSequence(fullConfig);
      

      
  
      
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
     const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
     const isVisible = await settingsService.getNavBarVisibility(platform);
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
   try {
     const { visible, platform } = req.body;
     console.log('[控制器] 请求体 visible:', visible);

     if (typeof visible !== 'boolean') {
       console.warn('[控制器] 收到无效的 visible 格式:', visible);
       res.status(400).json({ message: '无效的请求体，"visible" 必须是一个布尔值' });
       return;
     }

     
     await settingsService.setNavBarVisibility(visible, typeof platform === 'string' ? platform : undefined);
     


     
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
      const layoutJson = await settingsService.getLayoutTree();
      if (layoutJson) {
        try {
          const layout = JSON.parse(layoutJson);
          
          res.json(layout);
        } catch (parseError) {
          console.error('[控制器] 从数据库解析布局树 JSON 失败:', parseError);
          res.status(500).json({ message: '获取布局树失败：存储的数据格式无效' });
        }
      } else {
        
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
    try {
      const layoutTree = req.body;

      if (typeof layoutTree !== 'object' || layoutTree === null) {
         console.warn('[控制器] 收到无效的布局树格式 (非对象):', layoutTree);
         res.status(400).json({ message: '无效的请求体，应为 JSON 对象格式的布局树' });
         return;
      }

      const layoutJson = JSON.stringify(layoutTree);

      
      await settingsService.setLayoutTree(layoutJson);
      

      // auditLogService.logAction('LAYOUT_TREE_UPDATED');

      
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
   * 获取布局预设（多套预设 / 默认预设 / 连接绑定映射）
   */
  async getLayoutPresets(req: Request, res: Response): Promise<void> {
    try {
      const presetsJson = await settingsService.getLayoutPresets();
      if (!presetsJson) {
        res.json(null);
        return;
      }
      try {
        res.json(JSON.parse(presetsJson));
      } catch (parseError) {
        console.error('[控制器] 解析布局预设 JSON 失败:', parseError);
        res.status(500).json({ message: '获取布局预设失败：存储的数据格式无效' });
      }
    } catch (error: any) {
      console.error('[控制器] 获取布局预设时出错:', error);
      res.status(500).json({ message: '获取布局预设失败', error: error.message });
    }
  },

  /**
   * 保存布局预设
   */
  async setLayoutPresets(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.presets)) {
        res.status(400).json({ message: '无效的请求体，应包含 presets 数组' });
        return;
      }
      await settingsService.setLayoutPresets(JSON.stringify(payload));
      res.status(200).json({ message: '布局预设已成功更新' });
    } catch (error: any) {
      console.error('[控制器] 保存布局预设时出错:', error);
      res.status(500).json({ message: '保存布局预设失败', error: error.message });
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
      const isEnabled = await settingsService.getAutoCopyOnSelect();
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
    try {
      const { enabled } = req.body;
      console.log('[控制器] 请求体 enabled:', enabled);

      if (typeof enabled !== 'boolean') {
        console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
        res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
        return;
      }

      
      await settingsService.setAutoCopyOnSelect(enabled);
      


      
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

         
         await settingsService.setSidebarConfig(configDto);
         


         
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
    try {
        const configDto: UpdateCaptchaSettingsDto = req.body;
        console.log('[控制器] 请求体 (DTO, 密钥已屏蔽):', { ...configDto, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' });

        if (!configDto || typeof configDto !== 'object') {
            console.warn('[控制器] 收到无效的 CAPTCHA 配置格式 (非对象):', configDto);
            res.status(400).json({ message: '无效的请求体，应为 JSON 对象' });
            return;
        }


        
        await settingsService.setCaptchaConfig(configDto);
        


        
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

 // --- Show Connection Folders ---
 async getShowConnectionFolders(req: Request, res: Response): Promise<void> {
   try {
     const isEnabled = await settingsService.getShowConnectionFolders();
     res.json({ enabled: isEnabled });
   } catch (error: any) {
     console.error('[控制器] 获取“显示连接文件夹”设置时出错:', error);
     res.status(500).json({ message: '获取“连接文件夹分组”设置失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 async setShowConnectionFolders(req: Request, res: Response): Promise<void> {
   try {
     const { enabled } = req.body;
     console.log('[控制器] 请求体 enabled:', enabled);

     if (typeof enabled !== 'boolean') {
       console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
       res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
       return;
     }

     
     await settingsService.setShowConnectionFolders(enabled);
     

     auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys: ['showConnectionFolders'] });
     notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys: ['showConnectionFolders'] });

     
     res.status(200).json({ message: '“连接文件夹分组”设置已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置“显示连接文件夹”时出错:', error);
     res.status(500).json({ message: '设置“连接文件夹分组”失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 // --- Show Quick Command Folders ---
 async getShowQuickCommandFolders(req: Request, res: Response): Promise<void> {
   try {
     const isEnabled = await settingsService.getShowQuickCommandFolders();
     res.json({ enabled: isEnabled });
   } catch (error: any) {
     console.error('[控制器] 获取“显示快捷指令文件夹”设置时出错:', error);
     res.status(500).json({ message: '获取“快捷指令文件夹分组”设置失败', error: error.message });
   }
 }, // *** 确保这里有逗号 ***

 async setShowQuickCommandFolders(req: Request, res: Response): Promise<void> {
   try {
     const { enabled } = req.body;
     console.log('[控制器] 请求体 enabled:', enabled);

     if (typeof enabled !== 'boolean') {
       console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
       res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
       return;
     }

     
     await settingsService.setShowQuickCommandFolders(enabled);
     

     auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys: ['showQuickCommandFolders'] });
     notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys: ['showQuickCommandFolders'] });

     
     res.status(200).json({ message: '“快捷指令文件夹分组”设置已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置“显示快捷指令文件夹”时出错:', error);
     res.status(500).json({ message: '设置“快捷指令文件夹分组”失败', error: error.message });
   }
 }, 

 // --- Show Status Monitor IP Address ---
 async getShowStatusMonitorIpAddress(req: Request, res: Response): Promise<void> {
   try {
     const isEnabled = await settingsService.getShowStatusMonitorIpAddress();
     res.json({ enabled: isEnabled });
   } catch (error: any) {
     console.error('[控制器] 获取“显示状态监视器IP地址”设置时出错:', error);
     res.status(500).json({ message: '获取“显示状态监视器IP地址”设置失败', error: error.message });
   }
 },

 async setShowStatusMonitorIpAddress(req: Request, res: Response): Promise<void> {
   try {
     const { enabled } = req.body;
     console.log('[控制器] 请求体 enabled:', enabled);

     if (typeof enabled !== 'boolean') {
       console.warn('[控制器] 收到无效的 enabled 格式:', enabled);
       res.status(400).json({ message: '无效的请求体，"enabled" 必须是一个布尔值' });
       return;
     }

     
     await settingsService.setShowStatusMonitorIpAddress(enabled);
     

     auditLogService.logAction('SETTINGS_UPDATED', { updatedKeys: ['showStatusMonitorIpAddress'] });
     notificationService.sendNotification('SETTINGS_UPDATED', { updatedKeys: ['showStatusMonitorIpAddress'] });

     
     res.status(200).json({ message: '“显示状态监视器IP地址”设置已成功更新' });
   } catch (error: any) {
     console.error('[控制器] 设置“显示状态监视器IP地址”时出错:', error);
     res.status(500).json({ message: '设置“显示状态监视器IP地址”失败', error: error.message });
   }
 }, // <-- Add comma here

/**
   * 获取所有组件实例状态
   */
  async getComponentInstanceStates(req: Request, res: Response): Promise<void> {
    try {
      const states = await settingsService.getComponentInstanceStates();
      res.json(states);
    } catch (error: any) {
      console.error('[控制器] 获取组件实例状态失败:', error);
      res.status(500).json({ message: '获取组件状态失败', error: error.message });
    }
  },

  /**
   * 局部更新或保存组件实例状态
   */
  async updateComponentInstanceStates(req: Request, res: Response): Promise<void> {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ message: '无效的更新数据，应为对象' });
        return;
      }
      const result = await settingsService.updateComponentInstanceStates(updates);
      res.json(result);
    } catch (error: any) {
      console.error('[控制器] 更新组件实例状态失败:', error);
      res.status(500).json({ message: '更新组件状态失败', error: error.message });
    }
  },

  /**
   * 清理指定的不存在/孤立组件实例存储项
   */
  async cleanupComponentInstanceStates(req: Request, res: Response): Promise<void> {
    try {
      const { keysToDelete } = req.body;
      if (!Array.isArray(keysToDelete)) {
        res.status(400).json({ message: 'keysToDelete 应为数组' });
        return;
      }
      const result = await settingsService.removeComponentInstanceStates(keysToDelete);
      res.json(result);
    } catch (error: any) {
      console.error('[控制器] 清理组件实例状态失败:', error);
      res.status(500).json({ message: '清理组件状态失败', error: error.message });
    }
  },

  /**
   * 获取当前云端服务端的同步 API Key (完全存库)
   */
  async getSyncApiKey(req: Request, res: Response): Promise<void> {
    try {
      const apiKey = await getServerSyncApiKey();
      res.json({ success: true, apiKey });
    } catch (error: any) {
      console.error('获取同步 API Key 时出错:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * 更新云端服务端的同步 API Key 到数据库 settings 表
   */
  async setSyncApiKey(req: Request, res: Response): Promise<void> {
    try {
      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        res.status(400).json({ success: false, error: 'API Key 不能为空' });
        return;
      }
      await settingsRepository.setSetting('syncApiKey', apiKey.trim());
      res.json({ success: true, message: '同步 API Key 已成功保存至数据库' });
    } catch (error: any) {
      console.error('更新同步 API Key 时出错:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
};
