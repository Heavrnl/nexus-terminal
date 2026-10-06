import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import { AppearanceSettings, UpdateAppearanceDto } from '../types/appearance.types';
import { defaultUiTheme } from '../config/default-themes';
import { findThemeById as findTerminalThemeById } from '../terminal-themes/terminal-theme.repository';
import * as sqlite3 from 'sqlite3'; 

const TABLE_NAME = 'appearance_settings';


interface DbAppearanceSettingsRow {
    key: string;
    value: string;
    created_at: number;
    updated_at: number;
}


const mapRowsToAppearanceSettings = (rows: DbAppearanceSettingsRow[]): AppearanceSettings => {
    const settings: Partial<AppearanceSettings> = {};
    let latestUpdatedAt = 0;
    let terminalBackgroundEnabledFound = false; // 标记是否在数据库中找到该设置
    let terminalBackgroundOverlayOpacityFound = false; // 标记是否找到蒙版透明度设置
let terminalTextStrokeEnabledFound = false;
    let terminalTextStrokeWidthFound = false;
    let terminalTextStrokeColorFound = false;
    let terminalTextShadowEnabledFound = false;
    let terminalTextShadowOffsetXFound = false;
    let terminalTextShadowOffsetYFound = false;
    let terminalTextShadowBlurFound = false;
    let terminalTextShadowColorFound = false;
    let terminalHighlightEnabledFound = false;
    let terminalHighlightRulesFound = false;
 
    for (const row of rows) {
        // 更新 latestUpdatedAt
        if (row.updated_at > latestUpdatedAt) {
            latestUpdatedAt = row.updated_at;
        }

        switch (row.key) {
            case 'customUiTheme':
                settings.customUiTheme = row.value;
                break;
            case 'activeTerminalThemeId':
                const parsedId = parseInt(row.value, 10);
                settings.activeTerminalThemeId = isNaN(parsedId) ? null : parsedId;
                break;
            case 'terminalFontFamily':
                settings.terminalFontFamily = row.value;
                break;
            case 'terminalFontFamilyMobile':
                settings.terminalFontFamilyMobile = row.value;
                break;
            case 'terminalFontSize':
                settings.terminalFontSize = parseInt(row.value, 10);
                break;
            case 'terminalFontSizeMobile':
                settings.terminalFontSizeMobile = parseInt(row.value, 10);
                break;
            case 'editorFontSize':
                settings.editorFontSize = parseInt(row.value, 10);
                break;
            case 'mobileEditorFontSize':
                settings.mobileEditorFontSize = parseInt(row.value, 10);
                break;
            case 'terminalBackgroundImage':
                settings.terminalBackgroundImage = row.value || undefined;
                break;
            case 'pageBackgroundImage':
                settings.pageBackgroundImage = row.value || undefined;
                break;
            case 'terminalBackgroundEnabled':
                settings.terminalBackgroundEnabled = row.value === 'true'; // 将 'true'/'false' 字符串转为 boolean
                terminalBackgroundEnabledFound = true;
                break;
            case 'terminalBackgroundOverlayOpacity':
                settings.terminalBackgroundOverlayOpacity = parseFloat(row.value);
                terminalBackgroundOverlayOpacityFound = true;
                break;
            case 'editorFontFamily':
                settings.editorFontFamily = row.value || null; // 如果为空字符串，则视为 null
                break;
           case 'terminal_custom_html':
               settings.terminal_custom_html = row.value;
               break;
            case 'remote_html_presets_url':
                settings.remoteHtmlPresetsUrl = row.value || null; // 如果为空字符串，则视为 null
                break;
case 'terminalTextStrokeEnabled':
                settings.terminalTextStrokeEnabled = row.value === 'true';
                terminalTextStrokeEnabledFound = true;
                break;
            case 'terminalTextStrokeWidth':
                settings.terminalTextStrokeWidth = parseFloat(row.value);
                terminalTextStrokeWidthFound = true;
                break;
            case 'terminalTextStrokeColor':
                settings.terminalTextStrokeColor = row.value;
                terminalTextStrokeColorFound = true;
                break;
            case 'terminalTextShadowEnabled':
                settings.terminalTextShadowEnabled = row.value === 'true';
                terminalTextShadowEnabledFound = true;
                break;
            case 'terminalTextShadowOffsetX':
                settings.terminalTextShadowOffsetX = parseFloat(row.value);
                terminalTextShadowOffsetXFound = true;
                break;
            case 'terminalTextShadowOffsetY':
                settings.terminalTextShadowOffsetY = parseFloat(row.value);
                terminalTextShadowOffsetYFound = true;
                break;
            case 'terminalTextShadowBlur':
                settings.terminalTextShadowBlur = parseFloat(row.value);
                terminalTextShadowBlurFound = true;
                break;
            case 'terminalTextShadowColor':
                settings.terminalTextShadowColor = row.value;
                terminalTextShadowColorFound = true;
                break;
            case 'terminalHighlightEnabled':
                settings.terminalHighlightEnabled = row.value === 'true';
                terminalHighlightEnabledFound = true;
                break;
            case 'terminalHighlightRules':
                settings.terminalHighlightRules = row.value;
                terminalHighlightRulesFound = true;
                break;
        }
    }
 
    const defaults = getDefaultAppearanceSettings();
    return {
        _id: 'global_appearance', // 全局外观设置的固定 ID
        customUiTheme: settings.customUiTheme ?? defaults.customUiTheme,
        activeTerminalThemeId: settings.activeTerminalThemeId ?? defaults.activeTerminalThemeId,
        terminalFontFamily: settings.terminalFontFamily ?? defaults.terminalFontFamily,
        terminalFontFamilyMobile: settings.terminalFontFamilyMobile ?? defaults.terminalFontFamilyMobile,
        terminalFontSize: settings.terminalFontSize ?? defaults.terminalFontSize,
        terminalFontSizeMobile: settings.terminalFontSizeMobile ?? defaults.terminalFontSizeMobile,
        editorFontSize: settings.editorFontSize ?? defaults.editorFontSize,
        mobileEditorFontSize: settings.mobileEditorFontSize ?? defaults.mobileEditorFontSize, 
        editorFontFamily: settings.editorFontFamily ?? defaults.editorFontFamily,
        terminalBackgroundImage: settings.terminalBackgroundImage ?? defaults.terminalBackgroundImage,
        pageBackgroundImage: settings.pageBackgroundImage ?? defaults.pageBackgroundImage,
        // 只有当数据库中未找到记录时才使用默认值
        terminalBackgroundEnabled: terminalBackgroundEnabledFound
            ? settings.terminalBackgroundEnabled // 使用数据库找到的值 (true 或 false)
            : defaults.terminalBackgroundEnabled, // 否则使用默认值 (true)
        terminalBackgroundOverlayOpacity: terminalBackgroundOverlayOpacityFound
            ? settings.terminalBackgroundOverlayOpacity // 使用数据库找到的值
            : defaults.terminalBackgroundOverlayOpacity, // 否则使用默认值
       terminal_custom_html: settings.terminal_custom_html ?? defaults.terminal_custom_html,
       remoteHtmlPresetsUrl: settings.remoteHtmlPresetsUrl ?? defaults.remoteHtmlPresetsUrl,
        terminalTextStrokeEnabled: terminalTextStrokeEnabledFound
            ? settings.terminalTextStrokeEnabled
            : defaults.terminalTextStrokeEnabled,
        terminalTextStrokeWidth: terminalTextStrokeWidthFound
            ? settings.terminalTextStrokeWidth
            : defaults.terminalTextStrokeWidth,
        terminalTextStrokeColor: terminalTextStrokeColorFound
            ? settings.terminalTextStrokeColor
            : defaults.terminalTextStrokeColor,
        terminalTextShadowEnabled: terminalTextShadowEnabledFound
            ? settings.terminalTextShadowEnabled
            : defaults.terminalTextShadowEnabled,
        terminalTextShadowOffsetX: terminalTextShadowOffsetXFound
            ? settings.terminalTextShadowOffsetX
            : defaults.terminalTextShadowOffsetX,
        terminalTextShadowOffsetY: terminalTextShadowOffsetYFound
            ? settings.terminalTextShadowOffsetY
            : defaults.terminalTextShadowOffsetY,
        terminalTextShadowBlur: terminalTextShadowBlurFound
            ? settings.terminalTextShadowBlur
            : defaults.terminalTextShadowBlur,
        terminalTextShadowColor: terminalTextShadowColorFound
            ? settings.terminalTextShadowColor
            : defaults.terminalTextShadowColor,
        terminalHighlightEnabled: terminalHighlightEnabledFound
            ? settings.terminalHighlightEnabled
            : defaults.terminalHighlightEnabled,
        terminalHighlightRules: terminalHighlightRulesFound
            ? settings.terminalHighlightRules
            : defaults.terminalHighlightRules,
       updatedAt: latestUpdatedAt || defaults.updatedAt, // 使用最新的更新时间，否则使用默认时间戳
  };
};
 
 
// 获取默认外观设置 (已简化, _id 在此不再相关)
const getDefaultAppearanceSettings = (): Omit<AppearanceSettings, '_id'> => {
    return {
        customUiTheme: JSON.stringify(defaultUiTheme),
        activeTerminalThemeId: null, // 初始默认应为 null
        terminalFontFamily: 'Consolas, "Courier New", monospace, "Microsoft YaHei", "微软雅黑"',
        terminalFontFamilyMobile: '-apple-system-monospaced, "SF Mono", Menlo, Monaco, "Roboto Mono", "Noto Sans Mono", monospace',
        terminalFontSize: 14,
        terminalFontSizeMobile: 14, // 移动端默认字体大小
        editorFontSize: 14,
        mobileEditorFontSize: 16, //移动端编辑器默认字体大小
        editorFontFamily: 'Consolas, "Noto Sans SC", "Microsoft YaHei"',
        terminalBackgroundImage: undefined,
        pageBackgroundImage: undefined,
        terminalBackgroundEnabled: true, // 默认启用
        terminalBackgroundOverlayOpacity: 0.5, // 默认蒙版透明度
       terminal_custom_html: '', // 默认自定义 HTML 为空字符串
       remoteHtmlPresetsUrl: null, // 默认远程 HTML 预设 URL 为 null
        // 终端文本描边设置默认值
        terminalTextStrokeEnabled: false,
        terminalTextStrokeWidth: 1,
        terminalTextStrokeColor: '#000000',

        // 终端文本阴影设置默认值
        terminalTextShadowEnabled: false,
        terminalTextShadowOffsetX: 2,
        terminalTextShadowOffsetY: 2,
        terminalTextShadowBlur: 0,
        terminalTextShadowColor: '#000000',

        // 终端关键字高亮规则默认值
        terminalHighlightEnabled: false,
        terminalHighlightRules: '',
       updatedAt: Date.now(), // 提供默认时间戳
  };
};
 
 
/**
 * 确保默认设置存在于键值表中。
 * 此函数在数据库初始化期间调用。
 * @param db - 活动的数据库实例
 */
export const ensureDefaultSettingsExist = async (db: sqlite3.Database): Promise<void> => {
    const defaults = getDefaultAppearanceSettings();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sqlInsertOrIgnore = `INSERT OR IGNORE INTO ${TABLE_NAME} (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`;

    // 定义默认键值对以确保存在
    const defaultEntries: Array<{ key: keyof Omit<AppearanceSettings, '_id' | 'updatedAt'>, value: any }> = [
        { key: 'customUiTheme', value: defaults.customUiTheme },
        { key: 'activeTerminalThemeId', value: null }, // 以 null 开始
        { key: 'terminalFontFamily', value: defaults.terminalFontFamily },
        { key: 'terminalFontFamilyMobile', value: defaults.terminalFontFamilyMobile },
        { key: 'terminalFontSize', value: defaults.terminalFontSize },
        { key: 'terminalFontSizeMobile', value: defaults.terminalFontSizeMobile },
        { key: 'editorFontSize', value: defaults.editorFontSize },
        { key: 'mobileEditorFontSize', value: defaults.mobileEditorFontSize }, 
        { key: 'editorFontFamily', value: defaults.editorFontFamily },
        { key: 'terminalBackgroundImage', value: defaults.terminalBackgroundImage ?? '' }, // 数据库中使用空字符串
        { key: 'pageBackgroundImage', value: defaults.pageBackgroundImage ?? '' }, // 数据库中使用空字符串
        { key: 'terminalBackgroundEnabled', value: defaults.terminalBackgroundEnabled },
        { key: 'terminalBackgroundOverlayOpacity', value: defaults.terminalBackgroundOverlayOpacity },
        { key: 'terminal_custom_html', value: defaults.terminal_custom_html },
        { key: 'remoteHtmlPresetsUrl', value: defaults.remoteHtmlPresetsUrl },
        { key: 'terminalTextStrokeEnabled', value: defaults.terminalTextStrokeEnabled },
        { key: 'terminalTextStrokeWidth', value: defaults.terminalTextStrokeWidth },
        { key: 'terminalTextStrokeColor', value: defaults.terminalTextStrokeColor },
        { key: 'terminalTextShadowEnabled', value: defaults.terminalTextShadowEnabled },
        { key: 'terminalTextShadowOffsetX', value: defaults.terminalTextShadowOffsetX },
        { key: 'terminalTextShadowOffsetY', value: defaults.terminalTextShadowOffsetY },
        { key: 'terminalTextShadowBlur', value: defaults.terminalTextShadowBlur },
        { key: 'terminalTextShadowColor', value: defaults.terminalTextShadowColor },
        { key: 'terminalHighlightEnabled', value: defaults.terminalHighlightEnabled },
        { key: 'terminalHighlightRules', value: defaults.terminalHighlightRules },
    ];
 
    try {
        for (const entry of defaultEntries) {
            // 将值转换为字符串以存储到数据库，处理 null/undefined
            let dbValue: string;
            if (entry.value === null || entry.value === undefined) {
                dbValue = entry.key === 'activeTerminalThemeId' ? 'null' : ''; // 主题 ID 特殊存储为 'null'，其他情况为空字符串
            } else if (typeof entry.value === 'object') {
                dbValue = JSON.stringify(entry.value);
            } else {
                dbValue = String(entry.value);
            }

            // 对 activeTerminalThemeId 的特殊处理：将 null 存储为 'null' 字符串，或将数字存储为字符串
             if (entry.key === 'activeTerminalThemeId') {
                 dbValue = entry.value === null ? 'null' : String(entry.value);
             }


            await runDb(db, sqlInsertOrIgnore, [entry.key, dbValue, nowSeconds, nowSeconds]);
        }
        // console.log('[AppearanceRepo] 默认外观设置键值对检查完成。'); // 移除：信息不太关键

        // 确保键存在后，如果当前为 null，则尝试设置默认主题 ID
        await findAndSetDefaultThemeIdIfNull(db);

    } catch (err: any) {
         console.error(`[AppearanceRepo] 检查或插入默认外观设置键值对时出错:`, err.message);
         throw new Error(`检查或插入默认外观设置失败: ${err.message}`);
    }
};

/**
 * 查找默认终端主题 ID，并在 'activeTerminalThemeId' 设置当前为 null 时更新它。
 * @param db - 活动的数据库实例
 */
const findAndSetDefaultThemeIdIfNull = async (db: sqlite3.Database): Promise<void> => {
    try {
        // 检查 activeTerminalThemeId 的当前值
        const currentSetting = await getDb<{ value: string }>(db, `SELECT value FROM ${TABLE_NAME} WHERE key = ?`, ['activeTerminalThemeId']);

        // 仅当设置存在且其值为 'null' 字符串时继续
        if (currentSetting && currentSetting.value === 'null') {
            // 从 terminal_themes 表中查找默认主题（假设名称 'default' 标记为默认）
            const defaultThemeSql = `SELECT id FROM terminal_themes WHERE name = 'default' AND theme_type = 'preset' LIMIT 1`;
            const defaultThemeRow = await getDb<{ id: number }>(db, defaultThemeSql);

            if (defaultThemeRow) {
                const defaultThemeIdNum = defaultThemeRow.id;
                // console.log(`[AppearanceRepo] activeTerminalThemeId 为 null，尝试设置为默认主题 ID: ${defaultThemeIdNum}`); // 移除：信息不太关键
                // 使用 INSERT OR REPLACE 更新设置
                const sqlReplace = `INSERT OR REPLACE INTO ${TABLE_NAME} (key, value, updated_at) VALUES (?, ?, ?)`;
                await runDb(db, sqlReplace, ['activeTerminalThemeId', String(defaultThemeIdNum), Math.floor(Date.now() / 1000)]);
            } else {
                // console.warn("[AppearanceRepo] 未找到名为 'default' 的预设终端主题，无法设置默认 activeTerminalThemeId。");
            }
        }
        // 如果 activeTerminalThemeId 已设置或键不存在，则不执行任何操作
    } catch (error: any) {
        console.error("[AppearanceRepo] 设置默认终端主题 ID 时出错:", error.message);
        // 这里不抛出错误，只记录日志
    }
};


/**
 * 获取外观设置。
 * 从数据库中检索所有外观相关的键值对，并将它们映射到一个 AppearanceSettings 对象。
 * @returns {Promise<AppearanceSettings>} 返回包含当前外观设置的对象。
 * @throws {Error} 如果从数据库获取设置失败。
 */
export const getAppearanceSettings = async (): Promise<AppearanceSettings> => {
  try {
    const db = await getDbInstance();
    // 从键值表中获取所有行
    const rows = await allDb<DbAppearanceSettingsRow>(db, `SELECT key, value, updated_at FROM ${TABLE_NAME}`);
    const mappedSettings = mapRowsToAppearanceSettings(rows); // 将键值对映射到设置对象
    console.log(`[AppearanceRepo LOG] 映射后的 terminalBackgroundEnabled 值: ${mappedSettings.terminalBackgroundEnabled}`); // 添加映射后值的日志
    return mappedSettings;
  } catch (err: any) {
    console.error('[AppearanceRepo] 获取外观设置失败:', err.message);
    throw new Error('获取外观设置失败');
  }
};

/**
 * 更新外观设置 (公共 API)。
 * 接收一个包含要更新设置的 DTO，执行必要的验证，然后调用内部更新函数。
 * @param {UpdateAppearanceDto} settingsDto - 包含要更新设置的对象。
 * @returns {Promise<boolean>} 如果至少有一个设置被成功更新或插入，则返回 true，否则返回 false。
 * @throws {Error} 如果验证失败或内部更新过程中发生错误。
 */
export const updateAppearanceSettings = async (settingsDto: UpdateAppearanceDto): Promise<boolean> => {
    const db = await getDbInstance();
    // 在调用内部更新之前，如果需要，执行验证或复杂逻辑
    // 验证示例（已存在于服务中，但也可以在这里）：
    if (settingsDto.activeTerminalThemeId !== undefined && settingsDto.activeTerminalThemeId !== null) {
        try {
            const themeExists = await findTerminalThemeById(settingsDto.activeTerminalThemeId);
            if (!themeExists) {
                throw new Error(`指定的终端主题 ID 不存在: ${settingsDto.activeTerminalThemeId}`);
            }
        } catch (validationError: any) {
             console.error(`[AppearanceRepo] 验证主题 ID ${settingsDto.activeTerminalThemeId} 时出错:`, validationError.message);
             throw new Error(`验证主题 ID 失败: ${validationError.message}`);
        }
    }
    // ... 其他验证 ...

    return updateAppearanceSettingsInternal(db, settingsDto);
};

/**
 * 内部更新外观设置函数 (供内部调用，例如在初始化或公共 API 中)。
 * 此函数直接与数据库交互，使用 INSERT OR REPLACE 来更新或插入键值对。
 * @param {sqlite3.Database} db - 活动的数据库实例。
 * @param {UpdateAppearanceDto} settingsDto - 包含要更新设置的对象。
 * @returns {Promise<boolean>} 如果至少有一个设置被成功更新或插入，则返回 true，否则返回 false。
 * @throws {Error} 如果在数据库操作期间发生错误。
 */
// 在键值表中更新设置的内部函数
const updateAppearanceSettingsInternal = async (db: sqlite3.Database, settingsDto: UpdateAppearanceDto): Promise<boolean> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sqlReplace = `INSERT OR REPLACE INTO ${TABLE_NAME} (key, value, updated_at) VALUES (?, ?, ?)`;
  let changesMade = false;

  try {
      for (const dtoKey of Object.keys(settingsDto) as Array<keyof UpdateAppearanceDto>) {
          const value = settingsDto[dtoKey];
          let dbValue: string;
          let dbKey = dtoKey as string; // Default to DTO key

          // 将 DTO 键名映射到数据库键名
          if (dtoKey === 'remoteHtmlPresetsUrl') {
              dbKey = 'remote_html_presets_url';
          }
          // 如果将来还有其他 DTO 键名与数据库键名不一致的情况，在此添加映射
          // 例如: else if (dtoKey === 'someOtherDtoKey') { dbKey = 'some_other_db_key'; }

          // 将值转换为字符串以存储到数据库，处理 null/undefined
          if (value === null || value === undefined) {
               dbValue = dtoKey === 'activeTerminalThemeId' ? 'null' : ''; // 主题 ID 特殊存储为 'null'
          } else if (typeof value === 'object') {
               dbValue = JSON.stringify(value);
          } else if (typeof value === 'boolean') { // 处理布尔值
               dbValue = value ? 'true' : 'false';
          } else {
               dbValue = String(value);
          }

          // 对 activeTerminalThemeId 的特殊处理：存储 'null' 字符串或数字字符串 (基于 dtoKey 判断)
          if (dtoKey === 'activeTerminalThemeId') {
              dbValue = value === null ? 'null' : String(value);
          }


          // 保存前验证 active_terminal_theme_id 类型 (基于 dtoKey 判断)
          if (dtoKey === 'activeTerminalThemeId' && value !== null && typeof value !== 'number') {
               console.error(`[AppearanceRepo] 更新 activeTerminalThemeId 时收到无效类型值: ${value} (类型: ${typeof value})，应为数字或 null。跳过此字段。`);
               continue; // 跳过此键
          }

          // 对每个键值对执行 INSERT OR REPLACE，使用映射后的 dbKey
          console.log(`[AppearanceRepo LOG] 准备更新/插入数据库键: '${dbKey}', 值: '${dbValue}' (来自 DTO 键: '${dtoKey}')`);
          const result = await runDb(db, sqlReplace, [dbKey, dbValue, nowSeconds]);
          if (result.changes > 0) {
              console.log(`[AppearanceRepo LOG] 数据库键 '${dbKey}' 更新成功。`); // 添加成功日志
              changesMade = true;
          }
      }
      return changesMade; // 如果有任何行被插入或替换，则返回 true
  } catch (err: any) {
      console.error('[AppearanceRepo] 更新外观设置失败:', err.message);
      throw new Error('更新外观设置失败');
  }
};
