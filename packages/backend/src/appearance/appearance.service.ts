import fs from 'fs/promises'; // 使用 promises API
import fsSync from 'fs';
import path from 'path';
import * as appearanceRepository from './appearance.repository';
import { AppearanceSettings, UpdateAppearanceDto } from '../types/appearance.types';
import * as terminalThemeRepository from '../terminal-themes/terminal-theme.repository';
import axios from 'axios';
import sanitize from 'sanitize-filename'; // 用于清理文件名
import { getCustomHtmlThemesDir, getDataPath } from '../services/storage-path.service';

/**
 * 智能定位预设 HTML 主题的只读存储路径
 */
export const getPresetHtmlThemesDir = (): string => {
    if (process.env.NEXUS_HTML_PRESETS_DIR && fsSync.existsSync(process.env.NEXUS_HTML_PRESETS_DIR)) {
        return process.env.NEXUS_HTML_PRESETS_DIR;
    }
    const candidates = [
        path.resolve(__dirname, '../../html-presets'),
        path.resolve(__dirname, '../../../html-presets'),
        path.resolve(__dirname, '../html-presets'),
        path.resolve(process.cwd(), 'html-presets'),
        path.resolve(process.cwd(), 'server/html-presets'),
        path.resolve(process.cwd(), 'resources/server/html-presets'),
        path.resolve(process.cwd(), 'dist/html-presets'),
    ];
    for (const dir of candidates) {
        if (fsSync.existsSync(dir)) {
            return dir;
        }
    }
    return path.resolve(__dirname, '../../html-presets');
};

/**
 * 获取用户自定义 HTML 主题的读写持久化路径 (收敛至便携 data 目录)
 */
export const getUserCustomHtmlThemesDir = (): string => {
    return getCustomHtmlThemesDir();
};

// 确保预设 html-themes 目录存在
const ensurePresetHtmlThemesDirExists = async () => {
    const dir = getPresetHtmlThemesDir();
    try {
        await fs.access(dir);
    } catch (error) {
        // 目录不存在，创建它
        await fs.mkdir(dir, { recursive: true });
        console.log(`[AppearanceService] Created preset html-themes directory at ${dir}`);
    }
};
// 在服务初始化时确保目录存在
ensurePresetHtmlThemesDirExists();

// 确保用户自定义 custom_html_theme 目录存在
const ensureUserCustomHtmlThemesDirExists = async () => {
    const dir = getUserCustomHtmlThemesDir();
    try {
        await fs.access(dir);
    } catch (error) {
        // 目录不存在，创建它
        await fs.mkdir(dir, { recursive: true });
        console.log(`[AppearanceService] Created user custom_html_theme directory at ${dir}`);
    }
};
// 在服务初始化时确保目录存在
ensureUserCustomHtmlThemesDirExists();


/**
 * 获取外观设置
 * @returns Promise<AppearanceSettings>
 */
export const getSettings = async (): Promise<AppearanceSettings> => {
  const settings = await appearanceRepository.getAppearanceSettings();
  // 为 terminalBackgroundOverlayOpacity 提供默认值
  if (settings.terminalBackgroundOverlayOpacity === undefined || settings.terminalBackgroundOverlayOpacity === null) {
    settings.terminalBackgroundOverlayOpacity = 0.5; // 默认透明度为 0.5
  }
  return settings;
};

/**
 * 更新外观设置
 * @param settingsDto 更新数据
 * @returns Promise<boolean> 是否成功更新
 */
export const updateSettings = async (settingsDto: UpdateAppearanceDto): Promise<boolean> => {
  // 验证 activeTerminalThemeId (如果提供了)
  if (settingsDto.activeTerminalThemeId !== undefined && settingsDto.activeTerminalThemeId !== null) {
      const themeIdNum = settingsDto.activeTerminalThemeId; // ID is now number | null
      // 验证 ID 是否为有效的数字
      if (typeof themeIdNum !== 'number') {
           console.error(`[AppearanceService] 收到的 activeTerminalThemeId 不是有效的数字: ${themeIdNum}`);
           throw new Error(`无效的终端主题 ID 类型，应为数字。`);
      }
      try {
          // 直接使用数字 ID 调用 findThemeById 进行验证
          const themeExists = await terminalThemeRepository.findThemeById(themeIdNum);
          if (!themeExists) {
              console.warn(`[AppearanceService] 尝试更新为不存在的终端主题数字 ID: ${themeIdNum}`);
              throw new Error(`指定的终端主题 ID 不存在: ${themeIdNum}`);
          }
          console.log(`[AppearanceService] 终端主题数字 ID ${themeIdNum} 验证通过。`);
      } catch (e: any) {
          console.error(`[AppearanceService] 验证终端主题数字 ID (${themeIdNum}) 时出错:`, e.message);
          throw new Error(`验证终端主题 ID 时出错: ${e.message || themeIdNum}`);
      }
  } else if (settingsDto.hasOwnProperty('activeTerminalThemeId') && settingsDto.activeTerminalThemeId === null) {
      // 处理显式设置为 null (表示重置为默认/无用户主题)
      console.log(`[AppearanceService] 接收到将 activeTerminalThemeId 设置为 null 的请求。`);
      // 仓库层会处理 null
  }

  // 验证 terminalFontSize (如果提供了)
  if (settingsDto.terminalFontSize !== undefined && settingsDto.terminalFontSize !== null) {
      const size = Number(settingsDto.terminalFontSize);
      if (isNaN(size) || size <= 0) {
          throw new Error(`无效的终端字体大小: ${settingsDto.terminalFontSize}。必须是一个正数。`);
      }
      // 可以选择将验证后的数字类型赋值回 DTO，以确保类型正确传递给仓库层
      settingsDto.terminalFontSize = size;
  }

  // 验证 terminalFontSizeMobile (如果提供了)
  if (settingsDto.terminalFontSizeMobile !== undefined && settingsDto.terminalFontSizeMobile !== null) {
      const size = Number(settingsDto.terminalFontSizeMobile);
      if (isNaN(size) || size <= 0) {
          throw new Error(`无效的移动端终端字体大小: ${settingsDto.terminalFontSizeMobile}。必须是一个正数。`);
      }
      // 确保类型正确传递给仓库层
      settingsDto.terminalFontSizeMobile = size;
  }

  // 验证 editorFontSize (如果提供了)
  if (settingsDto.editorFontSize !== undefined && settingsDto.editorFontSize !== null) {
      const size = Number(settingsDto.editorFontSize);
      if (isNaN(size) || size <= 0) {
          throw new Error(`无效的编辑器字体大小: ${settingsDto.editorFontSize}。必须是一个正数。`);
      }
      // 确保类型正确传递给仓库层
      settingsDto.editorFontSize = size;
  }

  // 验证 mobileEditorFontSize (如果提供了)
  if (settingsDto.mobileEditorFontSize !== undefined && settingsDto.mobileEditorFontSize !== null) {
      const size = Number(settingsDto.mobileEditorFontSize);
      if (isNaN(size) || size <= 0) {
          throw new Error(`无效的移动端编辑器字体大小: ${settingsDto.mobileEditorFontSize}。必须是一个正数。`);
      }
      // 确保类型正确传递给仓库层
      settingsDto.mobileEditorFontSize = size;
  }

  // 验证 editorFontFamily (如果提供了)
  if (settingsDto.hasOwnProperty('editorFontFamily')) {
    if (settingsDto.editorFontFamily === null) {
      // 允许用户将字体设置为空 (null)，表示重置或使用默认
      // 无需额外操作，仓库层会处理 null
    } else if (typeof settingsDto.editorFontFamily === 'string') {
      const fontFamily = settingsDto.editorFontFamily;
      // 校验字体名称格式和长度
      if (fontFamily.length > 255) {
        throw new Error('编辑器字体名称过长，最多允许 255 个字符。');
      }

      if (fontFamily.trim() === '' && fontFamily !== '') {
  
      }
 
    } else {
      // 如果提供了 editorFontFamily 但不是 string 或 null
      throw new Error('无效的编辑器字体名称类型，应为字符串或 null。');
    }
  }

  // 验证 terminalBackgroundOverlayOpacity (如果提供了)
  if (settingsDto.terminalBackgroundOverlayOpacity !== undefined && settingsDto.terminalBackgroundOverlayOpacity !== null) {
    const opacity = Number(settingsDto.terminalBackgroundOverlayOpacity);
    if (isNaN(opacity) || opacity < 0 || opacity > 1) {
      throw new Error(`无效的终端背景蒙版透明度: ${settingsDto.terminalBackgroundOverlayOpacity}。必须是一个 0 到 1 之间的数字。`);
    }
    settingsDto.terminalBackgroundOverlayOpacity = opacity; // 确保类型正确
  }



  // 验证 terminal_custom_html (如果提供了)
  if (settingsDto.hasOwnProperty('terminal_custom_html')) {
    if (settingsDto.terminal_custom_html === null || settingsDto.terminal_custom_html === undefined || typeof settingsDto.terminal_custom_html === 'string') {
      // 允许为空字符串、null 或 undefined (将被视为空)
      if (typeof settingsDto.terminal_custom_html === 'string' && settingsDto.terminal_custom_html.length > 10240) { // 10KB 限制
        throw new Error('自定义终端 HTML 过长，最多允许 10240 个字符。');
      }
    } else {
      throw new Error('无效的自定义终端 HTML 类型，应为字符串。');
    }
  }

  // 验证 remoteHtmlPresetsUrl (如果提供了)
  if (settingsDto.hasOwnProperty('remoteHtmlPresetsUrl')) {
    const url = settingsDto.remoteHtmlPresetsUrl;
    if (url === null || url === undefined) {
      // 允许设置为 null 或 undefined (将被视为空)
      settingsDto.remoteHtmlPresetsUrl = null; // 统一为 null
    } else if (typeof url === 'string') {
      if (url.trim() === '') {
        settingsDto.remoteHtmlPresetsUrl = null; // 空字符串也视为空
      } else {
        // 可选：添加更严格的 URL 格式验证
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          // 暂时只做简单检查，允许非 GitHub URL，因为前端可能有其他用途
          // throw new Error('无效的远程 HTML 主题仓库链接格式，应以 http:// 或 https:// 开头。');
        }
        if (url.length > 1024) { // 限制 URL 长度
          throw new Error('远程 HTML 主题仓库链接过长，最多允许 1024 个字符。');
        }
      }
    } else {
      throw new Error('无效的远程 HTML 主题仓库链接类型，应为字符串或 null。');
    }
  }

  return appearanceRepository.updateAppearanceSettings(settingsDto);
};
/**
 * 移除页面背景图片
 * 1. 获取当前设置中的文件路径
 * 2. 如果路径存在，删除文件系统中的文件
 * 3. 更新数据库中的路径为空字符串
 */
export const removePageBackground = async (): Promise<boolean> => {
    const currentSettings = await getSettings();
    const filePath = currentSettings.pageBackgroundImage;

    if (filePath) {
        // 构建便携存储目录下的文件绝对路径
        const filename = filePath.startsWith('/api/v1/appearance/background/file/')
            ? filePath.replace('/api/v1/appearance/background/file/', '')
            : path.basename(filePath);
        const absolutePath = path.join(getDataPath('background'), filename);

        try {
            await fs.unlink(absolutePath);
            console.log(`[AppearanceService] 已删除页面背景文件: ${absolutePath}`);
        } catch (error: any) {
            // 如果文件不存在或其他删除错误，记录日志但继续执行以清空数据库记录
            if (error.code === 'ENOENT') {
                console.warn(`[AppearanceService] 尝试删除页面背景文件但未找到: ${absolutePath}`);
            } else {
                console.error(`[AppearanceService] 删除页面背景文件时出错 (${absolutePath}):`, error);
                // 可以选择抛出错误，或者仅记录并继续
                // throw new Error(`删除页面背景文件失败: ${error.message}`);
            }
        }
    } else {
        console.log('[AppearanceService] 没有页面背景文件路径需要删除。');
    }

    // 无论文件删除是否成功（或文件是否存在），都尝试清空数据库记录
    return updateSettings({ pageBackgroundImage: '' });
};

/**
 * 移除终端背景图片
 * 1. 获取当前设置中的文件路径
 * 2. 如果路径存在，删除文件系统中的文件
 * 3. 更新数据库中的路径为空字符串
 */
export const removeTerminalBackground = async (): Promise<boolean> => {
    const currentSettings = await getSettings();
    const filePath = currentSettings.terminalBackgroundImage;

    if (filePath) {
        const filename = filePath.startsWith('/api/v1/appearance/background/file/')
            ? filePath.replace('/api/v1/appearance/background/file/', '')
            : path.basename(filePath);
        const absolutePath = path.join(getDataPath('background'), filename);

        try {
            await fs.unlink(absolutePath);
            console.log(`[AppearanceService] 已删除终端背景文件: ${absolutePath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.warn(`[AppearanceService] 尝试删除终端背景文件但未找到: ${absolutePath}`);
            } else {
                console.error(`[AppearanceService] 删除终端背景文件时出错 (${absolutePath}):`, error);
                // throw new Error(`删除终端背景文件失败: ${error.message}`);
            }
        }
    } else {
         console.log('[AppearanceService] 没有终端背景文件路径需要删除。');
    }

    // 无论文件删除是否成功（或文件是否存在），都尝试清空数据库记录
    return updateSettings({ terminalBackgroundImage: '' });
};


// --- 自定义 HTML 背景主题服务方法 ---

// -- 本地 HTML 主题管理 --

/**
 * 验证并清理主题文件名 (通用函数)
 * @param themeName 原始主题文件名
 * @returns 清理后的安全文件名
 * @throws Error 如果文件名无效或包含路径遍历字符
 */
const sanitizeThemeNameInternal = (themeName: string): string => { // Renamed for clarity
    if (!themeName || typeof themeName !== 'string') {
        throw new Error('主题文件名不能为空且必须是字符串。');
    }
    // 进一步清理，确保文件名安全
    const safeName = sanitize(themeName);
    if (safeName !== themeName || themeName.includes('/') || themeName.includes('\\') || themeName.includes('..')) {
        // Sanitize 会移除或替换非法字符，如果清理后的名字和原名不同，或原名包含路径字符，则认为非法。
        // 额外检查 '..' 防止即使 sanitize 未移除（不太可能）的情况。
        console.warn(`[AppearanceService] 检测到潜在不安全的主题文件名: ${themeName}, 清理后: ${safeName}`);
        throw new Error(`主题文件名 "${themeName}" 包含非法字符或路径。`);
    }
    if (!safeName.endsWith('.html')) {
        throw new Error('主题文件名必须以 .html 结尾。');
    }
    if (safeName.length > 255) { // 合理的文件名长度限制
        throw new Error('主题文件名过长。');
    }
    return safeName;
};


/**
 * 获取所有预设 HTML 主题的名称列表
 * @returns Promise<Array<{ name: string, type: 'preset' }>> 主题对象列表
 */
export const listPresetHtmlThemes = async (): Promise<Array<{ name: string, type: 'preset' }>> => {
    try {
        await ensurePresetHtmlThemesDirExists(); // 确保目录存在
        const dir = getPresetHtmlThemesDir();
        const files = await fs.readdir(dir);
        return files
            .filter(file => file.endsWith('.html'))
            .map(name => ({ name, type: 'preset' as const })); // Add type
    } catch (error: any) {
        console.error('[AppearanceService] 列出预设 HTML 主题失败:', error);
        if (error.code === 'ENOENT') {
            // 目录不存在
             console.warn(`[AppearanceService] 预设 HTML 主题目录 (${getPresetHtmlThemesDir()}) 未找到。`);
            return [];
        }
        throw new Error('无法列出预设 HTML 主题。');
    }
};

/**
 * 获取指定预设 HTML 主题的内容
 * @param themeName 主题文件名 (例如: my-theme.html)
 * @returns Promise<string> 主题的 HTML 内容
 */
export const getPresetHtmlThemeContent = async (themeName: string): Promise<string> => { // Renamed
    const safeThemeName = sanitizeThemeNameInternal(themeName); // Use internal sanitizer
    const dir = getPresetHtmlThemesDir();
    const filePath = path.join(dir, safeThemeName);
    try {
        await ensurePresetHtmlThemesDirExists(); // 确保目录存在
        return await fs.readFile(filePath, 'utf-8');
    } catch (error: any) {
        console.error(`[AppearanceService] 获取预设 HTML 主题 "${safeThemeName}" 内容失败:`, error);
        if (error.code === 'ENOENT') {
            throw new Error(`预设 HTML 主题 "${safeThemeName}" 未找到。`);
        }
        throw new Error(`无法获取预设 HTML 主题 "${safeThemeName}" 的内容。`);
    }
};

// -- 用户自定义 HTML 主题管理 --

/**
 * 获取所有用户自定义 HTML 主题的名称列表
 * @returns Promise<Array<{ name: string, type: 'custom' }>> 主题对象列表
 */
export const listUserCustomHtmlThemes = async (): Promise<Array<{ name: string, type: 'custom' }>> => {
    try {
        await ensureUserCustomHtmlThemesDirExists();
        const dir = getUserCustomHtmlThemesDir();
        const files = await fs.readdir(dir);
        return files
            .filter(file => file.endsWith('.html'))
            .map(name => ({ name, type: 'custom' as const })); // Add type
    } catch (error: any) {
        console.error('[AppearanceService] 列出用户自定义 HTML 主题失败:', error);
        if (error.code === 'ENOENT') {
            console.warn(`[AppearanceService] 用户自定义 HTML 主题目录 (${getUserCustomHtmlThemesDir()}) 未找到。`);
            return [];
        }
        throw new Error('无法列出用户自定义 HTML 主题。');
    }
};

/**
 * 获取指定用户自定义 HTML 主题的内容
 * @param themeName 主题文件名 (例如: my-custom-theme.html)
 * @returns Promise<string> 主题的 HTML 内容
 */
export const getUserCustomHtmlThemeContent = async (themeName: string): Promise<string> => {
    const safeThemeName = sanitizeThemeNameInternal(themeName);
    const dir = getUserCustomHtmlThemesDir();
    const filePath = path.join(dir, safeThemeName);
    try {
        await ensureUserCustomHtmlThemesDirExists();
        return await fs.readFile(filePath, 'utf-8');
    } catch (error: any) {
        console.error(`[AppearanceService] 获取用户自定义 HTML 主题 "${safeThemeName}" 内容失败:`, error);
        if (error.code === 'ENOENT') {
            throw new Error(`用户自定义 HTML 主题 "${safeThemeName}" 未找到。`);
        }
        throw new Error(`无法获取用户自定义 HTML 主题 "${safeThemeName}" 的内容。`);
    }
};

/**
 * 创建新的用户自定义 HTML 主题
 * @param themeName 主题文件名 (例如: my-custom-theme.html)
 * @param content HTML 内容
 * @returns Promise<void>
 */
export const createUserCustomHtmlTheme = async (themeName: string, content: string): Promise<void> => {
    const safeThemeName = sanitizeThemeNameInternal(themeName);
    const dir = getUserCustomHtmlThemesDir();
    const filePath = path.join(dir, safeThemeName);
    try {
        await ensureUserCustomHtmlThemesDirExists(); // 确保目录存在
        // 检查文件是否已存在
        try {
            await fs.access(filePath);
            // 文件已存在
            throw new Error(`用户自定义 HTML 主题 "${safeThemeName}" 已存在。`);
        } catch (accessError: any) {
            // 文件不存在，可以创建
            if (accessError.code !== 'ENOENT') {
                throw accessError; // 其他 access 错误
            }
        }
        await fs.writeFile(filePath, content, 'utf-8');
        console.log(`[AppearanceService] 用户自定义 HTML 主题 "${safeThemeName}" 创建成功。`);
    } catch (error: any) {
        console.error(`[AppearanceService] 创建用户自定义 HTML 主题 "${safeThemeName}" 失败:`, error);
        throw error; // 重新抛出原始错误或包装后的错误
    }
};

/**
 * 更新指定用户自定义 HTML 主题的内容
 * @param themeName 主题文件名 (例如: my-custom-theme.html)
 * @param content 新的 HTML 内容
 * @returns Promise<void>
 */
export const updateUserCustomHtmlTheme = async (themeName: string, content: string): Promise<void> => {
    const safeThemeName = sanitizeThemeNameInternal(themeName);
    const dir = getUserCustomHtmlThemesDir();
    const filePath = path.join(dir, safeThemeName);
    try {
        await ensureUserCustomHtmlThemesDirExists(); // 确保目录存在
        // 确保文件存在才能更新
        try {
            await fs.access(filePath);
        } catch (accessError: any) {
            if (accessError.code === 'ENOENT') {
                throw new Error(`用户自定义 HTML 主题 "${safeThemeName}" 未找到，无法更新。`);
            }
            throw accessError;
        }
        await fs.writeFile(filePath, content, 'utf-8');
        console.log(`[AppearanceService] 用户自定义 HTML 主题 "${safeThemeName}" 更新成功。`);
    } catch (error: any) {
        console.error(`[AppearanceService] 更新用户自定义 HTML 主题 "${safeThemeName}" 失败:`, error);
        throw error;
    }
};

/**
 * 删除指定的用户自定义 HTML 主题文件
 * @param themeName 主题文件名 (例如: my-custom-theme.html)
 * @returns Promise<void>
 */
export const deleteUserCustomHtmlTheme = async (themeName: string): Promise<void> => {
    const safeThemeName = sanitizeThemeNameInternal(themeName);
    const dir = getUserCustomHtmlThemesDir();
    const filePath = path.join(dir, safeThemeName);
    try {
        await ensureUserCustomHtmlThemesDirExists(); // 确保目录存在
        await fs.unlink(filePath);
        console.log(`[AppearanceService] 用户自定义 HTML 主题 "${safeThemeName}" 删除成功。`);
    } catch (error: any) {
        console.error(`[AppearanceService] 删除用户自定义 HTML 主题 "${safeThemeName}" 失败:`, error);
        if (error.code === 'ENOENT') {
            throw new Error(`用户自定义 HTML 主题 "${safeThemeName}" 未找到，无法删除。`);
        }
        throw new Error(`无法删除用户自定义 HTML 主题 "${safeThemeName}"。`);
    }
};

// -- 合并主题列表 --

/**
 * 获取所有 HTML 主题 (预设和用户自定义)
 * @returns Promise<Array<{ name: string, type: 'preset' | 'custom' }>>
 */
export const listAllHtmlThemes = async (): Promise<Array<{ name: string, type: 'preset' | 'custom' }>> => {
    try {
        const presetThemes = await listPresetHtmlThemes();
        const customThemes = await listUserCustomHtmlThemes();
        return [...presetThemes, ...customThemes];
    } catch (error) {
        console.error('[AppearanceService] 列出所有 HTML 主题失败:', error);
        throw new Error('无法列出所有 HTML 主题。');
    }
};


// --- 现有本地 HTML 主题函数调整/重命名 ---
// 为了兼容现有的 appearance.store.ts 调用，暂时保留这些导出名，但内部调用新的对应函数。
// 建议后续步骤修改 appearance.store.ts 去调用新的、更明确的函数名 (e.g., listPresetHtmlThemes, createUserCustomHtmlTheme).

/**
 * @deprecated Use createUserCustomHtmlTheme instead. This function now creates a USER CUSTOM theme.
 *             The 'local' in its name is misleading under the new system.
 */
export const createLocalHtmlPreset = async (themeName: string, content: string): Promise<void> => {
    console.warn("[AppearanceService] createLocalHtmlPreset is deprecated and now operates on user custom themes. Consider using createUserCustomHtmlTheme.");
    return createUserCustomHtmlTheme(themeName, content);
};

/**
 * @deprecated Use updateUserCustomHtmlTheme instead. This function now updates a USER CUSTOM theme.
 *             The 'local' in its name is misleading under the new system.
 */
export const updateLocalHtmlPreset = async (themeName: string, content: string): Promise<void> => {
    console.warn("[AppearanceService] updateLocalHtmlPreset is deprecated and now operates on user custom themes. Consider using updateUserCustomHtmlTheme.");
    return updateUserCustomHtmlTheme(themeName, content);
};

/**
 * @deprecated Use deleteUserCustomHtmlTheme instead. This function now deletes a USER CUSTOM theme.
 *             The 'local' in its name is misleading under the new system.
 */
export const deleteLocalHtmlPreset = async (themeName: string): Promise<void> => {
    console.warn("[AppearanceService] deleteLocalHtmlPreset is deprecated and now operates on user custom themes. Consider using deleteUserCustomHtmlTheme.");
    return deleteUserCustomHtmlTheme(themeName);
};


// -- 远程 GitHub HTML 主题管理 --

/**
 * 获取当前存储的远程仓库链接
 * @returns Promise<string | null> 远程仓库 URL 或 null
 */
export const getRemoteHtmlPresetsRepositoryUrl = async (): Promise<string | null> => {
    try {
        const settings = await getSettings();
        return settings.remoteHtmlPresetsUrl !== undefined ? settings.remoteHtmlPresetsUrl : null;
    } catch (error: any) {
        console.error('[AppearanceService] 获取远程 HTML 主题仓库链接失败:', error);
        throw new Error('无法获取远程 HTML 主题仓库链接。');
    }
};

/**
 * 更新远程仓库链接
 * @param url 新的远程仓库 URL (可以是 null 或空字符串来清除)
 * @returns Promise<void>
 */
export const updateRemoteHtmlPresetsRepositoryUrl = async (url: string | null): Promise<void> => {
    try {
        // 验证 URL 格式 (可选, 但推荐)
        if (url && typeof url === 'string' && url.trim() !== '') {
            // 简单的 URL 验证，可以根据需要增强
             if (!url.startsWith('https://github.com/') && !url.startsWith('http://github.com/')) {
                // 允许其他 git 仓库源？目前按计划仅 GitHub
                // throw new Error('无效的 GitHub 仓库链接格式。应形如 https://github.com/user/repo/tree/branch/path');
            }
        } else if (url === '') {
            // 如果是空字符串，则视为 null，表示清除
            url = null;
        } else if (url !== null) {
            throw new Error('无效的 URL 值。');
        }

        await updateSettings({ remoteHtmlPresetsUrl: url });
        console.log(`[AppearanceService] 远程 HTML 主题仓库链接更新为: ${url}`);
    } catch (error: any) {
        console.error('[AppearanceService] 更新远程 HTML 主题仓库链接失败:', error);
        throw error; // 重新抛出，让控制器处理
    }
};


/**
 * 解析 GitHub 仓库 URL，提取 user, repo, path 和 ref (分支/tag/commit)
 * @param repoUrl 例如: https://github.com/user/repo/tree/main/path/to/themes
 * @returns { user: string, repo: string, path: string, ref: string } 或 null
 */
const parseGitHubRepoUrl = (repoUrl: string): { user: string; repo: string; repoPath: string; ref: string } | null => {
    // 改进的正则表达式以更好地处理不同的 GitHub URL 格式
    const githubUrlRegex = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/?(.*?)|\/?(.*))?$/;
    const match = repoUrl.match(githubUrlRegex);

    if (match) {
        const user = match[1];
        const repo = match[2];
        let ref = match[3]; // 分支/tag 从 /tree/部分提取
        let repoPath = match[4]; // 路径在 /tree/之后

        if (ref === undefined && repoPath === undefined) {
            // 处理 https://github.com/user/repo 这种形式, ref 和 path 从第五个捕获组获取
             ref = 'HEAD'; // 默认为 HEAD (通常是默认分支)
             repoPath = match[5] || ''; // 如果路径为空，则为空字符串
        } else {
            // 如果 /tree/ 部分存在
            ref = ref || 'HEAD'; // 如果 ref 未定义（例如 URL 以 /tree/ 结尾），默认为 HEAD
            repoPath = repoPath || ''; // 如果路径为空，则为空字符串
        }
        // 移除路径末尾的斜杠
        repoPath = repoPath.replace(/\/$/, '');

        return { user, repo, ref, repoPath };
    }
    return null;
};


/**
 * 获取远程仓库的主题列表 (文件名)
 * @param repoUrl 可选的仓库 URL。如果不提供，则使用已保存的链接。
 * @returns Promise<Array<{ name: string, downloadUrl: string | null }>> 主题对象列表
 */
export const listRemoteHtmlPresets = async (repoUrl?: string): Promise<Array<{ name: string, downloadUrl: string | null }>> => {
    let urlToFetch = repoUrl;
    if (!urlToFetch) {
        const savedUrl = await getRemoteHtmlPresetsRepositoryUrl();
        if (!savedUrl) {
            throw new Error('未提供远程仓库链接，且未找到已保存的链接。');
        }
        urlToFetch = savedUrl;
    }

    const parsed = parseGitHubRepoUrl(urlToFetch);
    if (!parsed) {
        throw new Error(`无效的 GitHub 仓库链接格式: ${urlToFetch}`);
    }

    const { user, repo, ref, repoPath } = parsed;
    // GitHub API 端点获取目录内容
    const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${repoPath}?ref=${ref}`;

    try {
        console.log(`[AppearanceService] 正在从 GitHub API 获取远程主题列表: ${apiUrl}`);
        const response = await axios.get(apiUrl, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
            // 对于公共仓库，通常不需要 token
        });

        if (response.status === 200 && Array.isArray(response.data)) {
            const htmlFiles = response.data
                .filter(item => item.type === 'file' && item.name.endsWith('.html'))
                .map(item => ({
                    name: item.name,
                    downloadUrl: item.download_url // GitHub API 通常会提供 download_url
                }));
            console.log(`[AppearanceService] 成功获取 ${htmlFiles.length} 个远程 HTML 主题。`);
            return htmlFiles;
        } else {
            console.error(`[AppearanceService] 从 GitHub API 获取主题列表失败: 状态 ${response.status}`, response.data);
            throw new Error(`无法从 GitHub (${urlToFetch}) 获取主题列表。状态: ${response.status}`);
        }
    } catch (error: any) {
        console.error(`[AppearanceService] 请求 GitHub API (${apiUrl}) 时出错:`, error.response?.data || error.message);
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            throw new Error(`远程仓库路径未找到: ${urlToFetch} (API: ${apiUrl})`);
        }
        throw new Error(`请求 GitHub API 获取主题列表时出错: ${error.message}`);
    }
};

/**
 * 获取远程仓库中指定主题的 HTML 内容
 * @param fileUrl GitHub API 返回的 download_url 或可构造的 raw 文件链接
 * @returns Promise<string> 主题的 HTML 内容
 */
export const getRemoteHtmlPresetContent = async (fileUrl: string): Promise<string> => {
    if (!fileUrl || typeof fileUrl !== 'string') {
        throw new Error('无效的远程文件 URL。');
    }
    // 基本的 URL 校验，确保它看起来像一个可下载的链接
    if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
        throw new Error('文件 URL 必须是有效的 HTTP/HTTPS 链接。');
    }

    try {
        console.log(`[AppearanceService] 正在从远程 URL 获取主题内容: ${fileUrl}`);
        const response = await axios.get(fileUrl, {
            responseType: 'text', // 确保获取的是文本内容
        });

        if (response.status === 200 && typeof response.data === 'string') {
            console.log(`[AppearanceService] 成功从 ${fileUrl} 获取主题内容。`);
            return response.data;
        } else {
            console.error(`[AppearanceService] 从 ${fileUrl} 获取内容失败: 状态 ${response.status}`, response.data);
            throw new Error(`无法从远程 URL (${fileUrl}) 获取内容。状态: ${response.status}`);
        }
    } catch (error: any) {
        console.error(`[AppearanceService] 请求远程文件内容 (${fileUrl}) 时出错:`, error.response?.data || error.message);
        throw new Error(`请求远程文件内容时出错: ${error.message}`);
    }
};


