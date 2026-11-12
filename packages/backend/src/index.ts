import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs'; // fs is needed for early env loading if data/.env is checked

// --- 开始环境变量的早期加载 ---
// 1. 加载根目录的 .env 文件 (定义部署模式等)
// 注意: __dirname 在 dist/src 中，所以需要回退三级到项目根目录
const projectRootEnvPath = path.resolve(__dirname, '../../../.env');
const rootConfigResult = dotenv.config({ path: projectRootEnvPath });

if (rootConfigResult.error && (rootConfigResult.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`[ENV Init Early] Warning: Could not load root .env file from ${projectRootEnvPath}. Error: ${rootConfigResult.error.message}`);
} else if (!rootConfigResult.error) {
    console.log(`[ENV Init Early] Loaded environment variables from root .env file: ${projectRootEnvPath}`);
} else {
    console.log(`[ENV Init Early] Root .env file not found at ${projectRootEnvPath}, proceeding without it.`);
}

import { getDataEnvPath, getSessionsDir, getLogsDir } from './services/storage-path.service';

// --- 配置服务运行日志落盘 (持久化到 data/logs/server.log，便于桌面端排查) ---
function setupFileLogging() {
  try {
    const logsDir = getLogsDir();
    const logFilePath = path.join(logsDir, 'server.log');
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function formatMessage(level: string, args: any[]) {
      const timestamp = new Date().toISOString();
      const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
      return `[${timestamp}] [${level}] ${msg}\n`;
    }

    console.log = (...args: any[]) => {
      originalLog.apply(console, args);
      try { logStream.write(formatMessage('INFO', args)); } catch {}
    };

    console.warn = (...args: any[]) => {
      originalWarn.apply(console, args);
      try { logStream.write(formatMessage('WARN', args)); } catch {}
    };

    console.error = (...args: any[]) => {
      originalError.apply(console, args);
      try { logStream.write(formatMessage('ERROR', args)); } catch {}
    };

    console.log('[Logging] 后台服务日志落盘已启用:', logFilePath);
  } catch (err: any) {
    console.warn('[Logging] 启用日志落盘失败:', err.message);
  }
}
setupFileLogging();

// 2. 加载 data/.env 文件 (定义密钥等，支持便携式与桌面端动态路径)
const dataEnvPathGlobal = getDataEnvPath();
const dataConfigResultGlobal = dotenv.config({ path: dataEnvPathGlobal });

if (dataConfigResultGlobal.error && (dataConfigResultGlobal.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`[ENV Init Early] Warning: Could not load data .env file from ${dataEnvPathGlobal}. Error: ${dataConfigResultGlobal.error.message}`);
} else if (!dataConfigResultGlobal.error) {
     console.log(`[ENV Init Early] Loaded environment variables from data .env file: ${dataEnvPathGlobal}`);
}


import express = require('express');
import { Request, Response, NextFunction, RequestHandler } from 'express';
import http from 'http';


import crypto from 'crypto';

import session from 'express-session';
import sessionFileStore from 'session-file-store';
import { getDbInstance } from './database/connection';
import authRouter from './auth/auth.routes';
import connectionsRouter from './connections/connections.routes';
import sftpRouter from './sftp/sftp.routes';
import proxyRoutes from './proxies/proxies.routes';
import foldersRouter from './folders/folders.routes';
import settingsRoutes from './settings/settings.routes';
import notificationRoutes from './notifications/notification.routes';
import auditRoutes from './audit/audit.routes';
import commandHistoryRoutes from './command-history/command-history.routes';
import quickCommandsRoutes from './quick-commands/quick-commands.routes';
import terminalThemeRoutes from './terminal-themes/terminal-theme.routes';
import appearanceRoutes from './appearance/appearance.routes';
import sshKeysRouter from './ssh_keys/ssh_keys.routes'; 
import { migrateLegacyDesktopSettings } from './settings/legacy-settings.migration';
import quickCommandFolderRoutes from './quick-command-folders/quick-command-folder.routes'; 
import sshSuspendRouter from './ssh-suspend/ssh-suspend.routes';
import { transfersRoutes } from './transfers/transfers.routes';
import pathHistoryRoutes from './path-history/path-history.routes';
import favoritePathsRouter from './favorite-paths/favorite-paths.routes';
import portForwardRouter from './port-forward/port-forward.routes';
import workspaceSyncRouter from './workspace-sync/workspace-sync.routes';
import desktopRouter from './settings/desktop.routes';
import syncRouter from './sync/sync.routes';
import syncV2Router from './sync/sync.v2.routes';
import fileColorHighlightsRouter from './file-color-highlights/file-color-highlights.routes';
import dataTransferRouter from './data-transfer/data-transfer.routes';
import debugRouter from './debug/debug.routes';
import { syncThrottleScheduler } from './sync/sync.scheduler';
import { syncWsClient } from './sync/sync.ws-client';
import { initializeWebSocket } from './websocket';
import { ipWhitelistMiddleware } from './auth/ipWhitelist.middleware';
import { ensureDesktopAdmin, isDesktopRuntime } from './auth/desktop-bootstrap';
import { listAutoStartRules } from './port-forward/port-forward.repository';
import { restoreAutoStart } from './port-forward/port-forward.service';


import './services/event.service'; 
import './notifications/notification.processor.service'; 
import './notifications/notification.dispatcher.service'; 



// --- 全局错误处理 ---
// 捕获未处理的 Promise Rejection
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('---未处理的 Promise Rejection---');
    console.error('原因:', reason);
  });
  
  // 捕获未捕获的同步异常
  process.on('uncaughtException', (error: Error) => {
    console.error('---未捕获的异常---');
    console.error('错误:', error);
  });

  

const initializeEnvironment = async () => {

    const dataEnvPath = dataEnvPathGlobal; 
    let keysGenerated = false;
    let keysToAppend = '';

    // 检查 ENCRYPTION_KEY (process.env should be populated by early loading)
    if (!process.env.ENCRYPTION_KEY) {
        console.log('[ENV Init] ENCRYPTION_KEY 未设置，正在生成...');
        const newEncryptionKey = crypto.randomBytes(32).toString('hex');
        process.env.ENCRYPTION_KEY = newEncryptionKey; // 更新当前进程环境
        keysToAppend += `\nENCRYPTION_KEY=${newEncryptionKey}`;
        keysGenerated = true;
    }

    // 3. 检查 SESSION_SECRET
    if (!process.env.SESSION_SECRET) {
        console.log('[ENV Init] SESSION_SECRET 未设置，正在生成...');
        const newSessionSecret = crypto.randomBytes(64).toString('hex');
        process.env.SESSION_SECRET = newSessionSecret; // 更新当前进程环境
        keysToAppend += `\nSESSION_SECRET=${newSessionSecret}`;
        keysGenerated = true;
    }

    // 4. 远程桌面（RDP / VNC）不再依赖 guacd：RDP 走自研 RDCleanPath 代理，
    //    VNC 走纯 WebSocket→TCP 桥，所以这里不再需要 GUACD_HOST / GUACD_PORT。

    // 5. 如果生成了新密钥或添加了默认值，则追加到 .env 文件
    if (keysGenerated) {
        try {
            // 确保追加前有换行符 (如果文件非空) - Use dataEnvPath here
            let prefix = '';
            if (fs.existsSync(dataEnvPath)) { // Use dataEnvPath
                const content = fs.readFileSync(dataEnvPath, 'utf-8'); // Use dataEnvPath
                if (content.trim().length > 0 && !content.endsWith('\n')) {
                    prefix = '\n';
                }
            }
            fs.appendFileSync(dataEnvPath, prefix + keysToAppend.trim()); // Use dataEnvPath, trim() 移除开头的换行符
            console.warn(`[ENV Init] 已自动生成密钥并保存到 ${dataEnvPath}`); // Use dataEnvPath
            console.warn('[ENV Init] !!! 重要：请务必备份此 data/.env 文件，并在生产环境中妥善保管 !!!');
        } catch (error) {
            console.error(`[ENV Init] 无法写入密钥到 ${dataEnvPath}:`, error); // Use dataEnvPath
            console.error('[ENV Init] 请检查文件权限或手动创建 data/.env 文件并添加生成的密钥。');
            // 即使写入失败，密钥已在 process.env 中，程序可以继续运行本次
        }
    }

    // 5. 生产环境最终检查 (虽然理论上已被覆盖，但作为保险)
    if (process.env.NODE_ENV === 'production') {
        if (!process.env.ENCRYPTION_KEY) {
            console.error('错误：生产环境中 ENCRYPTION_KEY 最终未能设置！');
            process.exit(1);
        }
        if (!process.env.SESSION_SECRET) {
            console.error('错误：生产环境中 SESSION_SECRET 最终未能设置！');
            process.exit(1);
        }
    }

    // 6. 最终检查 (包括 Guacamole 相关)
    if (process.env.NODE_ENV === 'production') {
        if (!process.env.ENCRYPTION_KEY) {
            console.error('错误：生产环境中 ENCRYPTION_KEY 最终未能设置！');
            process.exit(1);
        }
        if (!process.env.SESSION_SECRET) {
            console.error('错误：生产环境中 SESSION_SECRET 最终未能设置！');
            process.exit(1);
        }
        // Guacd host/port are less critical to halt on, defaults might work
    }

};
// --- 结束环境变量和密钥初始化 ---


// 基础 Express 应用设置
const app = express();
const server = http.createServer(app);

// --- 信任代理设置 ---
app.set('trust proxy', true);

// --- 中间件 ---

/**
 * 请求体压缩格式白名单。
 *
 * `express.json()` 默认 `inflate: true`，会按 `Content-Encoding` 解压请求体，
 * 而 body-parser 2.x 支持 `br` —— 也就是任何匿名请求都能把任意 Brotli 数据喂给
 * Node 的 Brotli 解码器。2026-10 的安全公告里 CVE-2026-111497 正是解码器越界写
 * （可导致 RCE），而 /api/v1/auth/login 这类接口在鉴权之前就会走到这里。
 *
 * 我们只在前端上传工作区快照时用到 `Content-Encoding: gzip`（见 utils/compression.ts），
 * 从来不需要 `br`，所以直接在应用层挡掉：即使运行时 Node 没升级，也走不到解码器。
 * 这和「升级 Node 到 22.23.4+」是两道独立的保险。
 */
const ALLOWED_CONTENT_ENCODINGS = new Set(['identity', 'gzip', 'x-gzip', 'deflate']);
app.use((req, res, next) => {
    const raw = String(req.headers['content-encoding'] || '').trim().toLowerCase();
    if (!raw) {
        next();
        return;
    }
    const unsupported = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .find((item) => !ALLOWED_CONTENT_ENCODINGS.has(item));
    if (unsupported) {
        res.status(415).json({ message: `不支持的请求体压缩格式: ${unsupported}` });
        return;
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 静态文件服务 ---
const uploadsPath = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsPath)) { // 确保 uploads 目录存在
    fs.mkdirSync(uploadsPath, { recursive: true });
}
// app.use('/uploads', express.static(uploadsPath)); // 不再需要，文件通过 API 提供


// 扩展 Express Request 类型
declare module 'express-session' {
    interface SessionData {
        userId?: number;
        username?: string;
    }
}

const port = process.env.PORT || 3001;

// 初始化数据库
const initializeDatabase = async () => {
  try {
    const db = await getDbInstance();
    console.log('[Index] 正在检查用户数量...');
    const userCount = await new Promise<number>((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', (err: Error | null, row: { count: number }) => {
        if (err) {
          console.error('检查 users 表时出错:', err.message);
          return reject(err);
        }
        resolve(row.count);
      });
    });
    console.log(`[Index] 用户数量检查完成。找到 ${userCount} 个用户。`);
  } catch (error) {
    console.error('数据库初始化或检查失败:', error);
    process.exit(1);
  }
};

// 启动服务器
const startServer = () => {
    // --- 会话中间件配置 ---
    const FileStore = sessionFileStore(session);
    const sessionsPath = getSessionsDir();
    /**
     * session-file-store 的 `ttl`（秒）是**服务端**的回收期限，和 cookie 的 maxAge 是两回事：
     * 它按 `session.cookie.originalMaxAge ?? ttl*1000` 判定过期（见 session-file-helpers.isExpired）。
     * 也就是说 Web 端登录时 `maxAge = undefined` → 落到这里的 `ttl`。
     *
     * 以前这里是 1 年，而 cookie 又是会话 cookie —— 用户关掉浏览器，cookie 没了，
     * 服务端那个会话文件却还留着一年，纯粹是垃圾；反过来不关浏览器的用户，
     * 服务端一年后也会把会话回收掉。现在统一按 180 天（和 WEB_SESSION_MAX_AGE_MS 一致），
     * 让「cookie 寿命」和「服务端文件寿命」对得上。
     */
    const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 天
    const sessionMiddleware = session({
        store: new FileStore({
            path: sessionsPath,
            ttl: SESSION_TTL_SECONDS,
            // 回收间隔默认 1 小时，按 ttl 同步放大到 1 天，减少无谓的目录扫描
            reapInterval: 24 * 60 * 60,
        }),
        // 直接从 process.env 读取，initializeEnvironment 已确保其存在
        secret: process.env.SESSION_SECRET as string,
        resave: false,
        saveUninitialized: false,
        /**
         * rolling: true —— 每次请求都重新下发 cookie 并刷新过期时间。
         *
         * 没有它的话，maxAge 是从「登录那一刻」开始算的固定截止时间：
         * 用户天天在用，第 180 天照样被踢出去重新登录。开启后只要还在活动，
         * 过期时间就一路往后滚，真正体现「记住登录状态」。
         */
        rolling: true,
        /**
         * unset: 'destroy' —— 登出必须真的把会话从 store 里删掉。
         *
         * express-session 默认 `unset: 'keep'`，于是 `shouldDestroy()` **恒为 false**
         * （它要求 `opts.unset === 'destroy'`）。控制器里 `req.session.destroy()` 确实
         * 删了会话文件，但紧接着 express-session 在响应收尾时又走到
         * `shouldTouch()` → `store.touch()`，而 session-file-store **实现了 touch**
         * （touch = 读出来再写回去），于是刚删掉的会话文件被原样写了回来。
         *
         * 后果不是"偶尔多留一个文件"，而是**登出形同虚设**：cookie 虽然被清了，
         * 但只要旧 cookie 还在（另一个标签页、被复制、浏览器没清干净），
         * 带着它请求依然 200，用户会以为"退了但没退干净"。
         *
         * 已用 scripts/verify-web-session.cjs 复现并锁死这个行为。
         */
        unset: 'destroy',
        proxy: true, // 信任反向代理设置的 X-Forwarded-Proto 头
        cookie: {
            httpOnly: true,
            // 同一站点（含反代下的 https）下才发送；不使用 SameSite=None 以保持 http 直连部署可用
            sameSite: 'lax',
            // 不写 secure：部署方式可能是 http 直连（如 http://ip:18111），
            // 写了 secure 浏览器会直接丢弃 cookie，反而变成"永远登录不上"。
            path: '/',
        },
    });
    app.use(sessionMiddleware);
    // --- 结束会话中间件配置 ---


    // --- 应用 API 路由 ---
    app.use('/api/v1/auth', authRouter);
    app.use('/api/v1/connections', connectionsRouter);
    app.use('/api/v1/sftp', sftpRouter);
    app.use('/api/v1/proxies', proxyRoutes);
    app.use('/api/v1/folders', foldersRouter);
    app.use('/api/v1/settings', settingsRoutes);
    app.use('/api/v1/notifications', notificationRoutes);
    app.use('/api/v1/audit-logs', auditRoutes);
    app.use('/api/v1/command-history', commandHistoryRoutes);
    app.use('/api/v1/quick-commands', quickCommandsRoutes);
    app.use('/api/v1/terminal-themes', terminalThemeRoutes);
    app.use('/api/v1/appearance', appearanceRoutes);
    app.use('/api/v1/ssh-keys', sshKeysRouter); 
    app.use('/api/v1/quick-command-folders', quickCommandFolderRoutes);
    app.use('/api/v1/ssh-suspend', sshSuspendRouter); 
    app.use('/api/v1/transfers', transfersRoutes());
    app.use('/api/v1/path-history', pathHistoryRoutes);
    app.use('/api/v1/favorite-paths', favoritePathsRouter);
    app.use('/api/v1/port-forwards', portForwardRouter);
    app.use('/api/v1/workspace-sync', workspaceSyncRouter);
    app.use('/api/v1/desktop', desktopRouter);
    app.use('/api/v1/sync', syncRouter);
    app.use('/api/sync/v2', syncV2Router);
    app.use('/api/v1/connections/:connectionId/file-color-highlights', fileColorHighlightsRouter);
    app.use('/api/v1/file-color-highlights', fileColorHighlightsRouter);
    app.use('/api/v1/data-transfer', dataTransferRouter);

    // 开发期前端日志接收（生产环境不挂载，也不暴露任何调试面）
    if (process.env.NODE_ENV !== 'production') {
        app.use('/api/v1/debug', debugRouter);
        console.log('[Index] 调试端点已启用: /api/v1/debug/log');
    }
    
    // 状态检查接口

    app.get('/api/v1/status', (req: Request, res: Response) => {
      res.json({ status: '后端服务运行中！' });
    });
    // --- 结束 API 路由 ---

    // --- 前端静态资源托管与 SPA 回退 ---
    const candidateFrontendDirs = [
      process.env.NEXUS_FRONTEND_DIR,
      path.resolve(__dirname, 'public'),
      path.resolve(__dirname, '../public'),
      path.resolve(__dirname, '../../public'),
      path.resolve(__dirname, 'frontend/dist'),
      path.resolve(__dirname, '../../../frontend/dist'),
      path.resolve(__dirname, '../../frontend/dist'),
      path.resolve(process.cwd(), 'resources/server/public'),
      path.resolve(process.cwd(), 'server/public'),
      path.resolve(process.cwd(), 'public'),
      path.resolve(process.cwd(), 'frontend/dist')
    ].filter((dir): dir is string => Boolean(dir && fs.existsSync(path.join(dir, 'index.html'))));

    if (candidateFrontendDirs.length > 0) {
      const frontendStaticDir = candidateFrontendDirs[0];
      console.log(`[Frontend Static] 已检测到前端静态资源，正在托管: ${frontendStaticDir}`);
      
      // 托管静态资产，对 index.html 禁用强缓存，确保每次热重载和版本更新即时生效
      app.use(express.static(frontendStaticDir, {
        setHeaders: (res: Response, filePath: string) => {
          /**
           * Vite 产出的 `assets/` 文件名里带内容 hash（`index-CcbmsMuy.js`），
           * 内容一变文件名就变 —— 这种文件可以放心长缓存。
           *
           * 以前这里只特殊处理了 index.html，其余文件走 express 默认的
           * `public, max-age=0`，等于**每次打开都要为几百个资源各发一次
           * revalidate 请求**：字节是 304 拿不到，但弱网下那几百个 RTT 就是几秒，
           * 用户感受就是"每次进工作区都把前端重新下一遍"。
           */
          const normalized = filePath.replace(/\\/g, '/');
          if (normalized.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return;
          }
          if (/\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css|woff2?|ttf|png|jpe?g|svg|webp|avif|wasm)$/.test(normalized)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return;
          }
          // 其余（sw.js、图标等）保持"可缓存但要校验"，改了立刻能生效
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
      }));

      // SPA 路由回退 (所有未匹配的 GET 请求返回 index.html)
      app.use((req: Request, res: Response, next: NextFunction): void => {
        if (req.method !== 'GET') {
          return next();
        }
        if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
          res.status(404).json({ error: 'Not Found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(path.join(frontendStaticDir, 'index.html'));
      });
    } else {
      console.log('[Frontend Static] 未检测到前端构建产物，仅提供 API 与 WebSocket 服务。');
    }

    const host = process.env.HOST || '0.0.0.0';
    server.listen(Number(port), host, () => {
        console.log(`后端服务器正在监听 http://${host}:${port}`);
        initializeWebSocket(server, sessionMiddleware as RequestHandler); // Initialize existing WebSocket
    });
};

// --- 主程序启动流程 ---
const main = async () => {
    await initializeEnvironment(); // 首先初始化环境和密钥
    migrateLegacyDesktopSettings(); // 「标签 → 文件夹」改名：搬掉 desktop-settings.json 里的旧同步范围 key
    await initializeDatabase();   // 然后初始化数据库
    await ensureDesktopAdmin();   // 桌面端首次启动：自动建默认账号（无密码）
    startServer();                // 最后启动服务器

    // 桌面端：把上次开着的端口转发拉起来（面板只在桌面端可见）
    if (isDesktopRuntime()) {
        try {
            await restoreAutoStart(await listAutoStartRules());
        } catch (err: any) {
            console.warn('[PortForward] 恢复自动转发失败:', err?.message);
        }
    }

    // 激活双端增量同步调度器与存量数据对齐 (Reconciliation Catch-up)
    try {
        await syncThrottleScheduler.activateAndCatchup();
    } catch (syncErr: any) {
        console.warn('[Sync] 调度器初始化激活告警:', syncErr.message);
    }

    // 启动桌面端到云端的 WebSocket 实时同步长连接守护客户端
    try {
        void syncWsClient.start();
    } catch (wsErr: any) {
        console.warn('[Sync] 启动实时长连接客户端告警:', wsErr.message);
    }
};

main().catch(error => {
    console.error("启动过程中发生未处理的错误:", error);
    process.exit(1);
});

