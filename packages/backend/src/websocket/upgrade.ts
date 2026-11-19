import http from 'http';
import url from 'url';
import { Request, RequestHandler } from 'express';
import { WebSocketServer } from 'ws';
import { AuthenticatedWebSocket } from './types';
import { handleSyncWsConnection, handleFrontendEventsConnection } from '../sync/sync.ws-broadcaster';
import { getServerSyncApiKey, safeCompare } from '../sync/sync.middleware';
import { isLocalRequest } from '../auth/desktop-bootstrap';
import { consumeTicket } from '../remote/remote-session.store';
import { handleRdpTunnel } from '../remote/rdp-tunnel';
import { handleVncTunnel } from '../remote/vnc-tunnel';

/**
 * 给远程桌面隧道补上心跳应答处理。
 *
 * 所有 WebSocket 都挂在同一个 wss 上，心跳定时器轮询的是 `wss.clients`；
 * 但标准连接是走 `wss.emit('connection')` 注册的，而隧道是 `handleUpgrade` 里
 * 直接交出去的，因此拿不到 `isAlive = true` 初始化和 `pong` 处理器。
 * 结果就是心跳每 15s 把 `isAlive` 置 false 却永远没人置回 true，
 * 累计 2 次（30s）后判定"客户端无响应"直接 `terminate()` ——
 * 表现为远程桌面 / VNC 连上一会儿就自己断了。这里补齐同样的握手。
 */
function attachTunnelHeartbeat(ws: AuthenticatedWebSocket): void {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
}

export function initializeUpgradeHandler(
    server: http.Server,
    wss: WebSocketServer,
    sessionParser: RequestHandler
): void {
    server.on('upgrade', (request: Request, socket, head) => {
        console.log('[WebSocket Upgrade] Received upgrade request.');

        const parsedUrl = url.parse(request.url || '', true); // Parse URL and query string
        const pathname = parsedUrl.pathname;

        // --- 修改：尝试从头部获取 IP，并处理 X-Forwarded-For 列表 ---
        let ipAddress: string | undefined;
        const xForwardedFor = request.headers['x-forwarded-for'];
        const xRealIp = request.headers['x-real-ip'];

        if (xForwardedFor) {
            // 如果 X-Forwarded-For 存在，取列表中的第一个 IP
            const ips = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor.split(',')[0];
            ipAddress = ips?.trim();
            console.log(`[WebSocket Upgrade] Using first IP from X-Forwarded-For: ${ipAddress}`);
        } else if (xRealIp) {
            // 否则，尝试 X-Real-IP
            ipAddress = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp.trim();
            console.log(`[WebSocket Upgrade] Using IP from X-Real-IP: ${ipAddress}`);
        } else {
            // 最后回退到 socket.remoteAddress 或 request.ip
            ipAddress = request.socket.remoteAddress || request.ip;
            console.log(`[WebSocket Upgrade] Using fallback IP: ${ipAddress}`);
        }

        // 确保 ipAddress 不是 undefined 或空字符串，否则设为 'unknown'
        ipAddress = ipAddress || 'unknown';
        console.log(`[WebSocket Upgrade] Determined IP Address: ${ipAddress}`);
        

        console.log(`WebSocket: 升级请求来自 IP: ${ipAddress}, Path: ${pathname}`); // 使用新获取的 ipAddress

        // --- 双端实时同步长连接专用路由 (/ws/sync 或 /sync) ---
        if (pathname === '/ws/sync' || pathname === '/sync') {
            const rawApiKey = (parsedUrl.query.apiKey as string) || (request.headers['x-sync-api-key'] as string);
            getServerSyncApiKey().then(serverApiKey => {
                if (!serverApiKey || !rawApiKey || !safeCompare(String(rawApiKey).trim(), serverApiKey)) {
                    console.warn(`[Sync WS] 鉴权失败，拒绝来自 ${ipAddress} 的同步长连接。`);
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                console.log(`[Sync WS] 鉴权成功，升级建立双端同步实时广播通道 (来自 IP: ${ipAddress})。`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    handleSyncWsConnection(ws, request);
                });
            }).catch(err => {
                console.error('[Sync WS] 鉴权流程异常:', err);
                socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                socket.destroy();
            });
            return;
        }

        // --- 前端 UI 全局实时事件长连接专用路由 (/ws/events 或 /events) ---
        if (pathname === '/ws/events' || pathname === '/events') {
            // @ts-ignore Express-session 类型问题
            sessionParser(request, {} as any, () => {
                // 必须使用不可伪造的 socket.remoteAddress 判定本机连接，严禁采信可伪造的 X-Forwarded-For
                const isLocal = isLocalRequest(request);
                const isAuthed = !!(request.session && request.session.userId);
                if (!isAuthed && !isLocal) {
                    console.warn(`[FrontendEvents] 拒绝未登录且非本地的前端事件连接 (来自 IP: ${ipAddress})。`);
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                console.log(`[FrontendEvents] 鉴权通过，建立前端 UI 全局事件订阅通道 (来自 IP: ${ipAddress})。`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    handleFrontendEventsConnection(ws, request);
                });
            });
            return;
        }

        // @ts-ignore Express-session 类型问题
        sessionParser(request, {} as any, () => {
            // --- 认证检查 ---
            if (!request.session || !request.session.userId) {
                console.log(`WebSocket 认证失败 (Path: ${pathname})：未找到会话或用户未登录。`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            console.log(`WebSocket 认证成功 (Path: ${pathname})：用户 ${request.session.username} (ID: ${request.session.userId})`);

            // --- 远程桌面（RDP / VNC）隧道：凭据只认一次性票据，不认 URL 参数 ---
            if (pathname === '/ws/remote/rdp' || pathname === '/ws/remote/vnc') {
                const ticket = String(parsedUrl.query.ticket || '');
                const session = consumeTicket(ticket, Number(request.session.userId));
                if (!session) {
                    console.warn(`[Remote] 票据无效或已过期 (Path: ${pathname}, IP: ${ipAddress})`);
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const expected = pathname.endsWith('/rdp') ? 'rdp' : 'vnc';
                if (session.protocol !== expected) {
                    console.warn(`[Remote] 票据协议(${session.protocol})与端点(${expected})不一致`);
                    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                    socket.destroy();
                    return;
                }
                (request as any).clientIpAddress = ipAddress;
                wss.handleUpgrade(request, socket, head, (ws) => {
                    attachTunnelHeartbeat(ws as AuthenticatedWebSocket);
                    if (session.protocol === 'rdp') handleRdpTunnel(ws, session);
                    else handleVncTunnel(ws, session);
                });
                return;
            }

            // --- 其余路径 (SSH, SFTP, Docker etc.) ---
            // RDP / VNC 已改走 /ws/remote/* 的字节隧道，不再有 /rdp-proxy 转发到 guacd 的分支
            console.log(`WebSocket: Handling standard upgrade for user ${request.session.username}`);
            wss.handleUpgrade(request, socket, head, (ws) => {
                const extWs = ws as AuthenticatedWebSocket;
                extWs.userId = request.session.userId;
                extWs.username = request.session.username;
                (request as any).clientIpAddress = ipAddress;
                wss.emit('connection', extWs, request);
            });
        });
    });
    console.log('WebSocket upgrade handler initialized.');
}