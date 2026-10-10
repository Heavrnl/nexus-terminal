import { Request, Response } from 'express';
import * as appearanceService from './appearance.service';
import { UpdateAppearanceDto } from '../types/appearance.types';
import multer from 'multer';
import path from 'path';
import fs from 'fs'; // Keep fs for sync operations if needed, add promises for async
import fsp from 'fs/promises'; // Use fs.promises for async file operations
import { getDataPath } from '../services/storage-path.service';

// --- 背景图片上传配置 (便携式存储优先) ---
const backgroundStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = getDataPath('background');
        // 确保目录存在
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, uniqueSuffix + '-' + safeOriginalName);
    }
});

const backgroundUpload = multer({
    storage: backgroundStorage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传图片文件 (JPEG, PNG, GIF, WebP, SVG)！'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 } // 限制文件大小为 5MB
});


/**
 * 获取外观设置 (保持不变)
 */
export const getAppearanceSettingsController = async (req: Request, res: Response): Promise<void> => {
    try {
        const settings = await appearanceService.getSettings();
        res.status(200).json(settings);
    } catch (error: any) {
        res.status(500).json({ message: '获取外观设置失败', error: error.message });
    }
};

/**
 * 更新外观设置 (保持不变)
 */
export const updateAppearanceSettingsController = async (req: Request, res: Response): Promise<void> => {
    try {
        const settingsDto: UpdateAppearanceDto = req.body;
        const success = await appearanceService.updateSettings(settingsDto);
        if (success) {
            const updatedSettings = await appearanceService.getSettings();
            res.status(200).json(updatedSettings);
        } else {
            res.status(500).json({ message: '更新外观设置似乎失败了' });
        }
    } catch (error: any) {
        res.status(400).json({ message: '更新外观设置失败', error: error.message });
    }
};


/**
 * 上传页面背景图片 (修改返回路径)
 */
export const uploadPageBackgroundController = async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).json({ message: '没有上传文件' });
        return;
    }
    try {
        // 构建新的 API 路径
        const apiPath = `/api/v1/appearance/background/file/${req.file.filename}`;

        // 更新数据库中的设置，保存 API 路径
        await appearanceService.updateSettings({ pageBackgroundImage: apiPath });

        // 返回新的 API 路径给前端
        res.status(200).json({ message: '页面背景上传成功', filePath: apiPath });
    } catch (error: any) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("删除上传失败的背景文件时出错:", err);
            });
        }
        res.status(500).json({ message: '上传页面背景失败', error: error.message });
    }
};

/**
 * 上传终端背景图片 (修改返回路径)
 */
export const uploadTerminalBackgroundController = async (req: Request, res: Response): Promise<void> => {
     if (!req.file) {
        res.status(400).json({ message: '没有上传文件' });
        return;
    }
    try {
        // 构建新的 API 路径
        const apiPath = `/api/v1/appearance/background/file/${req.file.filename}`;

        // 更新数据库中的设置，保存 API 路径
        await appearanceService.updateSettings({ terminalBackgroundImage: apiPath });

        // 返回新的 API 路径给前端
        res.status(200).json({ message: '终端背景上传成功', filePath: apiPath });
    } catch (error: any) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("删除上传失败的背景文件时出错:", err);
            });
        }
        res.status(500).json({ message: '上传终端背景失败', error: error.message });
    }
};

/**
 * 获取背景图片文件
 */
export const getBackgroundFileController = async (req: Request, res: Response): Promise<void> => {
    const filename = req.params.filename;

    // 基本安全检查，防止路径遍历等
    if (!filename || typeof filename !== 'string' || filename.includes('..') || filename.includes('/')) {
        res.status(400).json({ message: '无效的文件名' });
        return;
    }

    try {
        // 构建文件的绝对路径 (基于便携数据目录)
        const absolutePath = path.join(getDataPath('background'), filename);

        // 检查文件是否存在且可读
        await fsp.access(absolutePath, fs.constants.R_OK);

        // 发送文件
        res.sendFile(absolutePath, (err) => {
             if (err) {
                console.error(`[AppearanceController] 发送文件时出错 (${absolutePath}):`, err);
                // 避免在已发送响应头后再次发送
                if (!res.headersSent) {
                     res.status(500).json({ message: '发送文件时出错' });
                }
             }
        });

    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.warn(`[AppearanceController] 请求的背景文件未找到: ${filename}`);
            res.status(404).json({ message: '文件未找到' });
        } else {
            console.error(`[AppearanceController] 获取背景文件时出错 (${filename}):`, error);
            res.status(500).json({ message: '获取背景文件时出错', error: error.message });
        }
    }
};


// 导出 multer 中间件以便在路由中使用 (保持不变)
export const uploadPageBackgroundMiddleware = backgroundUpload.single('pageBackgroundFile');
export const uploadTerminalBackgroundMiddleware = backgroundUpload.single('terminalBackgroundFile');

/**
 * 移除页面背景图片 (保持不变，Service 层会处理路径解析)
 */
export const removePageBackgroundController = async (req: Request, res: Response): Promise<void> => {
    try {
        await appearanceService.removePageBackground();
        res.status(200).json({ message: '页面背景已移除' });
    } catch (error: any) {
        res.status(500).json({ message: '移除页面背景失败', error: error.message });
    }
};

/**
 * 移除终端背景图片 (保持不变，Service 层会处理路径解析)
 */
export const removeTerminalBackgroundController = async (req: Request, res: Response): Promise<void> => {
    try {
        await appearanceService.removeTerminalBackground();
        res.status(200).json({ message: '终端背景已移除' });
    } catch (error: any) {
        res.status(500).json({ message: '移除终端背景失败', error: error.message });
    }
};

// --- HTML 预设主题控制器方法 ---

// GET /api/v1/appearance/html-presets/local
export const listLocalHtmlPresetsController = async (req: Request, res: Response): Promise<void> => {
    try {
        // 现在获取所有主题，包括预设和自定义，它们将带有 type 属性
        const allThemes = await appearanceService.listAllHtmlThemes();
        res.status(200).json(allThemes); // 直接返回带有 type 的列表
    } catch (error: any) {
        res.status(500).json({ message: '获取 HTML 主题列表失败', error: error.message });
    }
};

// GET /api/v1/appearance/html-presets/local/:themeName
export const getLocalHtmlPresetContentController = async (req: Request, res: Response): Promise<void> => {
    try {
        const themeName = req.params.themeName;
        let content: string | null = null;
        let found = false;

        // 1. 尝试作为用户自定义主题获取
        try {
            content = await appearanceService.getUserCustomHtmlThemeContent(themeName);
            found = true;
        } catch (customError: any) {
            if (!customError.message.includes('未找到')) {
                // 如果不是 "未找到" 错误，则直接抛出
                throw customError;
            }
            // 如果是 "未找到"，则继续尝试预设主题
        }

        // 2. 如果用户自定义主题未找到，尝试作为预设主题获取
        if (!found) {
            try {
                content = await appearanceService.getPresetHtmlThemeContent(themeName);
                found = true;
            } catch (presetError: any) {
                if (!presetError.message.includes('未找到')) {
                    throw presetError;
                }
                // 如果预设也未找到，此时才真正是 404
            }
        }

        if (found && content !== null) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(200).send(content);
        } else {
            res.status(404).json({ message: `主题 '${themeName}' 未找到` });
        }
    } catch (error: any) {
        // 通用错误处理
        res.status(500).json({ message: `获取主题 '${req.params.themeName}' 内容失败`, error: error.message });
    }
};

// POST /api/v1/appearance/html-presets/local
export const createLocalHtmlPresetController = async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, content } = req.body;
        if (!name || !content) {
            res.status(400).json({ message: '主题名称和内容不能为空' });
            return;
        }
        // "本地创建" 现在总是创建用户自定义主题
        await appearanceService.createUserCustomHtmlTheme(name, content);
        res.status(201).json({ message: '用户自定义 HTML 主题创建成功' });
    } catch (error: any) {
        res.status(500).json({ message: '创建用户自定义 HTML 主题失败', error: error.message });
    }
};

// PUT /api/v1/appearance/html-presets/local/:themeName
export const updateLocalHtmlPresetController = async (req: Request, res: Response): Promise<void> => {
    try {
        const themeName = req.params.themeName;
        const { content } = req.body;
        if (content === undefined) {
            res.status(400).json({ message: '主题内容不能为空' });
            return;
        }
        // "本地更新" 现在总是更新用户自定义主题
        await appearanceService.updateUserCustomHtmlTheme(themeName, content);
        res.status(200).json({ message: '用户自定义 HTML 主题更新成功' });
    } catch (error: any) {
        if (error.message.includes('未找到')) {
            res.status(404).json({ message: error.message });
        } else {
            res.status(500).json({ message: '更新用户自定义 HTML 主题失败', error: error.message });
        }
    }
};

// DELETE /api/v1/appearance/html-presets/local/:themeName
export const deleteLocalHtmlPresetController = async (req: Request, res: Response): Promise<void> => {
    try {
        const themeName = req.params.themeName;
        // "本地删除" 现在总是删除用户自定义主题
        await appearanceService.deleteUserCustomHtmlTheme(themeName);
        res.status(200).json({ message: '用户自定义 HTML 主题删除成功' });
    } catch (error: any) {
        if (error.message.includes('未找到')) {
            res.status(404).json({ message: error.message });
        } else {
            res.status(500).json({ message: '删除用户自定义 HTML 主题失败', error: error.message });
        }
    }
};

// GET /api/v1/appearance/html-presets/remote/repository-url
export const getRemoteHtmlPresetsRepositoryUrlController = async (req: Request, res: Response): Promise<void> => {
    try {
        const url = await appearanceService.getRemoteHtmlPresetsRepositoryUrl();
        res.status(200).json({ url });
    } catch (error: any) {
        res.status(500).json({ message: '获取远程 HTML 主题仓库链接失败', error: error.message });
    }
};

// PUT /api/v1/appearance/html-presets/remote/repository-url
export const updateRemoteHtmlPresetsRepositoryUrlController = async (req: Request, res: Response): Promise<void> => {
    try {
        const { url } = req.body;
        // 注意：允许 url 为 null 或空字符串以清除设置
        if (url === undefined) {
            res.status(400).json({ message: 'URL 不能为空或 undefined' });
            return;
        }
        await appearanceService.updateRemoteHtmlPresetsRepositoryUrl(url);
        res.status(200).json({ message: '远程 HTML 主题仓库链接更新成功' });
    } catch (error: any) {
        res.status(500).json({ message: '更新远程 HTML 主题仓库链接失败', error: error.message });
    }
};

// GET /api/v1/appearance/html-presets/remote/list
export const listRemoteHtmlPresetsController = async (req: Request, res: Response): Promise<void> => {
    try {
        const repoUrl = req.query.repoUrl as string | undefined;
        const presets = await appearanceService.listRemoteHtmlPresets(repoUrl);
        res.status(200).json(presets);
    } catch (error: any) {
        res.status(500).json({ message: '获取远程 HTML 主题列表失败', error: error.message });
    }
};

// GET /api/v1/appearance/html-presets/remote/content
export const getRemoteHtmlPresetContentController = async (req: Request, res: Response): Promise<void> => {
    try {
        const fileUrl = req.query.fileUrl as string;
        if (!fileUrl) {
            res.status(400).json({ message: 'fileUrl 查询参数不能为空' });
            return;
        }
        const content = await appearanceService.getRemoteHtmlPresetContent(fileUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(content);
    } catch (error: any) {
        res.status(500).json({ message: '获取远程 HTML 主题内容失败', error: error.message });
    }
};
