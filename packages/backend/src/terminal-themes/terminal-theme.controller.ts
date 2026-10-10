import { Request, Response } from 'express';
import * as terminalThemeService from './terminal-theme.service';
import { CreateTerminalThemeDto, UpdateTerminalThemeDto } from '../types/terminal-theme.types';
import type { ITheme } from 'xterm';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { getTempUploadsDir } from '../services/storage-path.service';

// 配置 multer 用于处理 JSON 文件上传 (导入)
const upload = multer({
    dest: getTempUploadsDir(), // 统一收归至 data/temp-uploads 目录
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传 JSON 文件！'));
        }
    },
    limits: { fileSize: 1024 * 1024 } // 限制文件大小为 1MB
});

/**
 * 获取所有终端主题
 */
export const getAllThemesController = async (req: Request, res: Response): Promise<void> => {
    try {
        const themes = await terminalThemeService.getAllThemes();
        res.status(200).json(themes);
    } catch (error: any) {
        res.status(500).json({ message: '获取终端主题列表失败', error: error.message });
    }
};

/**
 * 根据 ID 获取单个终端主题
 */
export const getThemeByIdController = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            res.status(400).json({ message: '无效的主题 ID' });
            return;
        }
        const theme = await terminalThemeService.getThemeById(id);
        if (theme) {
            res.status(200).json(theme);
        } else {
            res.status(404).json({ message: '未找到指定的主题' });
        }
    } catch (error: any) {
        res.status(500).json({ message: '获取终端主题失败', error: error.message });
    }
};

/**
 * 创建新终端主题
 */
export const createThemeController = async (req: Request, res: Response): Promise<void> => {
    try {
        const themeDto: CreateTerminalThemeDto = req.body;
        // 基本验证
        if (!themeDto.name || !themeDto.themeData) {
             res.status(400).json({ message: '缺少主题名称或主题数据' });
             return;
        }
        const newTheme = await terminalThemeService.createNewTheme(themeDto);
        res.status(201).json(newTheme);
    } catch (error: any) {
        // 检查是否是名称重复错误
        if (error.message.includes('已存在')) {
             res.status(409).json({ message: error.message }); // 409 Conflict
        } else {
             res.status(400).json({ message: '创建终端主题失败', error: error.message });
        }
    }
};

/**
 * 更新终端主题
 */
export const updateThemeController = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = parseInt(req.params.id, 10);
         if (isNaN(id)) {
            res.status(400).json({ message: '无效的主题 ID' });
            return;
        }
        const themeDto: UpdateTerminalThemeDto = req.body;
         // 基本验证
        if (!themeDto.name || !themeDto.themeData) {
             res.status(400).json({ message: '缺少主题名称或主题数据' });
             return;
        }
        const success = await terminalThemeService.updateExistingTheme(id, themeDto);
        if (success) {
            res.status(200).json({ message: '主题更新成功' });
        } else {
            // 可能因为 ID 不存在或主题是预设主题而更新失败
            res.status(404).json({ message: '未找到可更新的主题或该主题为预设主题' });
        }
    } catch (error: any) {
         if (error.message.includes('已存在')) {
             res.status(409).json({ message: error.message }); // 409 Conflict
        } else {
            res.status(400).json({ message: '更新终端主题失败', error: error.message });
        }
    }
};

/**
 * 删除终端主题
 */
export const deleteThemeController = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = parseInt(req.params.id, 10);
         if (isNaN(id)) {
            res.status(400).json({ message: '无效的主题 ID' });
            return;
        }
        const success = await terminalThemeService.deleteExistingTheme(id);
        if (success) {
            res.status(200).json({ message: '主题删除成功' });
        } else {
            // 可能因为 ID 不存在或主题是预设主题而删除失败
            res.status(404).json({ message: '未找到可删除的主题或该主题为预设主题' });
        }
    } catch (error: any) {
        res.status(500).json({ message: '删除终端主题失败', error: error.message });
    }
};

/**
 * 导入终端主题 (处理文件上传)
 */
export const importThemeController = async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).json({ message: '没有上传文件' });
        return;
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    // 尝试从文件名中提取名称 (去除 .json 后缀)
    const defaultName = originalName.endsWith('.json') ? originalName.slice(0, -5) : originalName;
    // 允许用户通过 body 传递 name，否则使用文件名
    const themeName = req.body.name || defaultName;

    try {
        const fileContent = await fs.promises.readFile(filePath, 'utf-8');
        const themeData: ITheme = JSON.parse(fileContent);

        // 调用 service 进行导入
        const importedTheme = await terminalThemeService.importTheme(themeData, themeName);

        // 删除临时文件
        await fs.promises.unlink(filePath);

        res.status(201).json(importedTheme);

    } catch (error: any) {
        // 确保即使出错也删除临时文件
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath).catch(unlinkErr => console.error("删除临时导入文件失败:", unlinkErr));
        }

        if (error instanceof SyntaxError) {
            res.status(400).json({ message: '导入失败：文件不是有效的 JSON 格式', error: error.message });
        } else if (error.message.includes('已存在')) {
             res.status(409).json({ message: `导入失败: ${error.message}` }); // 409 Conflict
        } else {
            res.status(400).json({ message: '导入终端主题失败', error: error.message });
        }
    }
};

/**
 * 导出终端主题
 */
export const exportThemeController = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            res.status(400).json({ message: '无效的主题 ID' });
            return;
        }
        const theme = await terminalThemeService.getThemeById(id);
        if (theme) {
            const themeJson = JSON.stringify(theme.themeData, null, 2); // 格式化 JSON 输出
            const fileName = `${theme.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`; // 创建安全的文件名

            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', 'application/json');
            res.status(200).send(themeJson);
        } else {
            res.status(404).json({ message: '未找到指定的主题' });
        }
    } catch (error: any) {
        res.status(500).json({ message: '导出终端主题失败', error: error.message });
    }
};

// 将 upload 中间件导出，以便在路由中使用
export const uploadMiddleware = upload;
