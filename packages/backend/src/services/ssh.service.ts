import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { SocksClient, SocksClientOptions } from 'socks';
import http from 'http';
import net from 'net';
import * as ConnectionRepository from '../connections/connection.repository';
import *   as ProxyRepository from '../proxies/proxy.repository';
import { decrypt } from '../utils/crypto';
import * as SshKeyService from '../ssh_keys/ssh_key.service';

const CONNECT_TIMEOUT = 20000; // 连接超时时间 (毫秒)
const TEST_TIMEOUT = 15000; // 测试连接超时时间 (毫秒)


interface JumpHostRawConfig {
  id?: string | number; // Optional: an identifier for the hop from config
  name?: string;        // Optional: a name for the hop from config
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'key';
  encrypted_password?: string | null;
  ssh_key_id?: number | null;
  encrypted_private_key?: string | null;
  encrypted_passphrase?: string | null;
}

export interface JumpHostDetail {
  id: string; // Unique ID for this hop instance (e.g., generated or from config)
  name?: string; // Optional name for logging
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface DecryptedConnectionDetails {
    id: number;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string; // Decrypted
    privateKey?: string; // Decrypted
    passphrase?: string; // Decrypted
    proxy?: {
        id: number;
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string;
        password?: string; // Decrypted
    } | null;
    jump_chain?: JumpHostDetail[]; 
    connection_proxy_setting?: 'proxy' | 'jump' | null; 
    startup_command?: string | null;
    sftp_sudo_enabled?: boolean;
    sftp_sudo_password?: string | null; // 解密后的 sudo 密码
}

/**
 * 获取并解密指定 ID 的完整连接信息（包括代理）
 * @param connectionId 连接 ID
 * @returns Promise<DecryptedConnectionDetails> 解密后的连接详情
 * @throws Error 如果连接配置未找到或解密失败
 */
export const getConnectionDetails = async (connectionId: number): Promise<DecryptedConnectionDetails> => {
    console.log(`SshService: getConnectionDetails - 获取连接 ${connectionId} 的详细信息...`);
    const rawConnInfo = await ConnectionRepository.findFullConnectionById(connectionId);

    if (!rawConnInfo) {
        console.error(`SshService: 连接配置 ID ${connectionId} 未找到。`);
        throw new Error(`连接配置 ID ${connectionId} 未找到。`);
    }

    const typedRawConnInfo = rawConnInfo as typeof rawConnInfo & { jump_chain?: string | null; proxy_type?: 'proxy' | 'jump' | null };

    try {
        const fullConnInfo: DecryptedConnectionDetails = {
            id: typedRawConnInfo.id,
            name: typedRawConnInfo.name ?? (() => { throw new Error(`Connection ID ${connectionId} has null name.`); })(),
            host: typedRawConnInfo.host ?? (() => { throw new Error(`Connection ID ${connectionId} has null host.`); })(),
            port: typedRawConnInfo.port ?? (() => { throw new Error(`Connection ID ${connectionId} has null port.`); })(),
            username: typedRawConnInfo.username ?? (() => { throw new Error(`Connection ID ${connectionId} has null username.`); })(),
            auth_method: typedRawConnInfo.auth_method ?? (() => { throw new Error(`Connection ID ${connectionId} has null auth_method.`); })(),
            password: undefined,
            privateKey: undefined,
            passphrase: undefined,
            proxy: null,
            jump_chain: undefined,
            connection_proxy_setting: typedRawConnInfo.proxy_type ?? null,
            startup_command: typedRawConnInfo.startup_command ?? null,
            sftp_sudo_enabled: typedRawConnInfo.sftp_sudo_enabled ?? false,
            sftp_sudo_password: typedRawConnInfo.encrypted_sftp_sudo_password? decrypt(typedRawConnInfo.encrypted_sftp_sudo_password)
                : null,
        };

        if (fullConnInfo.auth_method === 'password' && rawConnInfo.encrypted_password) {
            fullConnInfo.password = decrypt(rawConnInfo.encrypted_password);
        }
        else if (fullConnInfo.auth_method === 'key') {
            if (typedRawConnInfo.ssh_key_id) {
                const storedKeyDetails = await SshKeyService.getDecryptedSshKeyById(typedRawConnInfo.ssh_key_id);
                if (!storedKeyDetails) {
                    console.error(`SshService: Error: Connection ${connectionId} references non-existent SSH key ID ${typedRawConnInfo.ssh_key_id}`);
                    throw new Error(`关联的 SSH 密钥 (ID: ${typedRawConnInfo.ssh_key_id}) 未找到。`);
                }
                fullConnInfo.privateKey = storedKeyDetails.privateKey;
                fullConnInfo.passphrase = storedKeyDetails.passphrase;
            } else if (typedRawConnInfo.encrypted_private_key) {
                fullConnInfo.privateKey = decrypt(typedRawConnInfo.encrypted_private_key);
                if (typedRawConnInfo.encrypted_passphrase) {
                    fullConnInfo.passphrase = decrypt(typedRawConnInfo.encrypted_passphrase);
                }
            } else {
                 console.warn(`SshService: Connection ${connectionId} uses key auth but has neither ssh_key_id nor encrypted_private_key.`);
            }
        }

        if (typedRawConnInfo.proxy_db_id) {
             const proxyName = typedRawConnInfo.proxy_name ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null name.`); })();
             const proxyType = typedRawConnInfo.actual_proxy_server_type ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} (actual_proxy_server_type) has null type.`); })();
             const proxyHost = typedRawConnInfo.proxy_host ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null host.`); })();
             const proxyPort = typedRawConnInfo.proxy_port ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null port.`); })();
             if (proxyType !== 'SOCKS5' && proxyType !== 'HTTP') {
                throw new Error(`Proxy for Connection ID ${connectionId} has invalid actual_proxy_server_type: ${proxyType}`);
             }
            fullConnInfo.proxy = {
                id: typedRawConnInfo.proxy_db_id,
                name: proxyName,
                type: proxyType,
                host: proxyHost,
                port: proxyPort,
                username: typedRawConnInfo.proxy_username || undefined,
                password: typedRawConnInfo.proxy_encrypted_password ? decrypt(typedRawConnInfo.proxy_encrypted_password) : undefined,
            };
        }

        // 修改条件判断和 JSON.parse 以使用正确的字段名 jump_chain
        if (typedRawConnInfo.jump_chain) {
            try {
                const jumpHostConnectionIds: number[] = JSON.parse(typedRawConnInfo.jump_chain);

                if (Array.isArray(jumpHostConnectionIds) && jumpHostConnectionIds.length > 0) {
                    fullConnInfo.jump_chain = []; // Initialize for JumpHostDetail objects

                    for (let i = 0; i < jumpHostConnectionIds.length; i++) {
                        const hopConnectionId = jumpHostConnectionIds[i];
                        if (typeof hopConnectionId !== 'number') {
                            throw new Error(`Jump host ID at index ${i} in jump_chain for connection ${connectionId} is not a number. Found: ${hopConnectionId}`);
                        }
                        if (hopConnectionId === connectionId) {
                            throw new Error(`Connection ${connectionId} cannot have itself (ID: ${hopConnectionId}) in its own jump_chain. This would cause a loop.`);
                        }


                        const hopTargetDetails: DecryptedConnectionDetails = await getConnectionDetails(hopConnectionId);

                        const decryptedHop: JumpHostDetail = {
                            id: `hop-${connectionId}-via-${hopConnectionId}-idx-${i}`, // A unique ID for this specific hop in this chain
                            name: hopTargetDetails.name || `Jump Host ${i + 1} (Conn ID ${hopConnectionId})`,
                            host: hopTargetDetails.host,
                            port: hopTargetDetails.port,
                            username: hopTargetDetails.username,
                            auth_method: hopTargetDetails.auth_method,
                            // Credentials should already be decrypted by the recursive call
                            password: hopTargetDetails.password,
                            privateKey: hopTargetDetails.privateKey,
                            passphrase: hopTargetDetails.passphrase,
                        };
                        
                        fullConnInfo.jump_chain.push(decryptedHop);
                    }
                } else {
                     console.log(`SshService: Parsed jump_chain for connection ${connectionId} is empty or not an array after parsing.`);
                }
            } catch (parseOrProcessError: any) {
                console.error(`SshService: Failed to parse or process jump_chain for connection ${connectionId}. Raw jump_chain: "${typedRawConnInfo.jump_chain}". Error:`, parseOrProcessError);
                throw new Error(`解析或处理跳板机配置失败 (连接ID ${connectionId}): ${parseOrProcessError.message}`);
            }
        }  else {
            console.log(`SshService: Connection ${connectionId} does not have jump_chain configuration in DB, or it is null/empty string.`);
        }

        return fullConnInfo;
    } catch (decryptError: any) {
        console.error(`SshService: 处理连接 ${connectionId} 凭证、代理或跳板机凭证失败:`, decryptError);
        throw new Error(`处理凭证或配置失败: ${decryptError.message}`);
    }
};

// --- Helper function to set up SSH client listeners and initiate connection ---
const _setupSshClientListenersAndConnect = (
    client: Client,
    config: ConnectConfig,
    isFinalClient: boolean,
    connectionIdForUpdate: number | null,
    connNameForLog: string
): Promise<Client> => {
    return new Promise((resolve, reject) => {
        const logPrefix = `SshService: Client for ${connNameForLog} (ID: ${connectionIdForUpdate ?? 'N/A'}, ${isFinalClient ? 'Final' : 'Intermediate'}) -`;

        const eventHandlers = {
            ready: async () => {
                console.log(`${logPrefix} SSH connection successful. Target: ${config.host || (config.sock ? 'stream-based' : 'unknown')}`);
                client.removeListener('error', eventHandlers.error);
                client.removeListener('close', eventHandlers.close);

                if (isFinalClient && connectionIdForUpdate !== null && connectionIdForUpdate !== -1) { // -1 for unsaved tests
                    try {
                        const currentTimeSeconds = Math.floor(Date.now() / 1000);
                        await ConnectionRepository.updateLastConnected(connectionIdForUpdate, currentTimeSeconds);
                    } catch (updateError) {
                        console.error(`SshService: Failed to update last_connected_at for connection ID ${connectionIdForUpdate}:`, updateError);
                    }
                }
                resolve(client);
            },
            error: (err: Error) => {
                client.removeListener('ready', eventHandlers.ready);
                client.removeListener('error', eventHandlers.error);
                client.removeListener('close', eventHandlers.close);
                console.error(`${logPrefix} SSH connection error:`, err);
                try { client.end(); } catch (e) { console.error(`${logPrefix} Error ending client in errorHandler:`, e); }
                reject(err);
            },
            close: () => {
                client.removeListener('ready', eventHandlers.ready);
                client.removeListener('error', eventHandlers.error);
                client.removeListener('close', eventHandlers.close);
                console.warn(`${logPrefix} SSH connection closed.`);
            }
        };

        client.once('ready', eventHandlers.ready);
        client.on('error', eventHandlers.error);
        client.on('close', eventHandlers.close);

        console.log(`${logPrefix} Attempting to connect... Config: host=${config.host}, port=${config.port}, user=${config.username}, sock=${!!config.sock}`);
        client.connect(config);
    });
};

// --- Helper function for direct SSH connection ---
const _establishDirectSshConnection = (
    connDetails: DecryptedConnectionDetails,
    timeout: number
): Promise<Client> => {
    const sshClient = new Client();
    const connectConfig: ConnectConfig = {
        host: connDetails.host,
        port: connDetails.port,
        username: connDetails.username,
        password: connDetails.password,
        privateKey: connDetails.privateKey,
        passphrase: connDetails.passphrase,
        readyTimeout: timeout,
        keepaliveInterval: 5000,
        keepaliveCountMax: 10,
    };

    return _setupSshClientListenersAndConnect(
        sshClient,
        connectConfig,
        true, // isFinalClient
        connDetails.id,
        connDetails.name
    );
};

// --- Helper functions for proxy connections ---
const _connectViaSocksProxy = (
    destinationHost: string,
    destinationPort: number,
    proxyDetails: NonNullable<DecryptedConnectionDetails['proxy']>,
    timeout: number
): Promise<net.Socket> => {
    return new Promise((resolve, reject) => {
        const socksOptions: SocksClientOptions = {
            proxy: {
                host: proxyDetails.host,
                port: proxyDetails.port,
                type: 5,
                userId: proxyDetails.username,
                password: proxyDetails.password
            },
            command: 'connect',
            destination: { host: destinationHost, port: destinationPort },
            timeout: timeout,
        };

        SocksClient.createConnection(socksOptions)
            .then(({ socket }) => {
                resolve(socket);
            })
            .catch(socksError => {
                const errMsg = `SOCKS5 proxy ${proxyDetails.host}:${proxyDetails.port} connection failed: ${socksError.message}`;
                console.error(`SshService: ${errMsg}`);
                reject(new Error(errMsg));
            });
    });
};

const _connectViaHttpProxy = (
    destinationHost: string,
    destinationPort: number,
    proxyDetails: NonNullable<DecryptedConnectionDetails['proxy']>,
    timeout: number
): Promise<net.Socket> => {
    return new Promise((resolve, reject) => {
        const reqOptions: http.RequestOptions = {
            method: 'CONNECT',
            host: proxyDetails.host,
            port: proxyDetails.port,
            path: `${destinationHost}:${destinationPort}`,
            timeout: timeout,
            agent: false
        };
        if (proxyDetails.username) {
            const auth = 'Basic ' + Buffer.from(proxyDetails.username + ':' + (proxyDetails.password || '')).toString('base64');
            reqOptions.headers = {
                ...reqOptions.headers,
                'Proxy-Authorization': auth,
                'Proxy-Connection': 'Keep-Alive',
                'Host': `${destinationHost}:${destinationPort}`
            };
        }

        const req = http.request(reqOptions);

        req.on('connect', (res, socket, head) => {
            if (res.statusCode === 200) {
                resolve(socket);
            } else {
                socket.destroy();
                const errMsg = `HTTP proxy ${proxyDetails.host}:${proxyDetails.port} connection failed (status: ${res.statusCode})`;
                console.error(`SshService: ${errMsg}`);
                reject(new Error(errMsg));
            }
        });
        req.on('error', (err) => {
            const errMsg = `HTTP proxy ${proxyDetails.host}:${proxyDetails.port} request error: ${err.message}`;
            console.error(`SshService: ${errMsg}`);
            reject(new Error(errMsg));
        });
        req.on('timeout', () => {
            req.destroy();
            const errMsg = `HTTP proxy ${proxyDetails.host}:${proxyDetails.port} connection timed out`;
            console.error(`SshService: ${errMsg}`);
            reject(new Error(errMsg));
        });
        req.end();
    });
};

const _establishProxyConnection = async (
    connDetails: DecryptedConnectionDetails,
    timeout: number
): Promise<Client> => {
    const proxy = connDetails.proxy!;

    const sshClient = new Client();
    const baseConnectConfig: ConnectConfig = {
        username: connDetails.username,
        password: connDetails.password,
        privateKey: connDetails.privateKey,
        passphrase: connDetails.passphrase,
        readyTimeout: timeout,
        keepaliveInterval: 5000,
        keepaliveCountMax: 10,
    };

    try {
        let proxySocket: net.Socket;
        if (proxy.type === 'SOCKS5') {
            proxySocket = await _connectViaSocksProxy(connDetails.host, connDetails.port, proxy, timeout);
        } else if (proxy.type === 'HTTP') {
            proxySocket = await _connectViaHttpProxy(connDetails.host, connDetails.port, proxy, timeout);
        } else {
            throw new Error(`Unsupported proxy type: ${proxy.type}`);
        }

        const connectConfigWithSocket: ConnectConfig = {
            ...baseConnectConfig,
            sock: proxySocket,
            // host and port are for the final destination; ssh2 uses sock if provided
            host: connDetails.host, // Kept for clarity/logging, not strictly needed by ssh2 with sock
            port: connDetails.port, // Kept for clarity/logging
        };

        return _setupSshClientListenersAndConnect(
            sshClient,
            connectConfigWithSocket,
            true, // isFinalClient
            connDetails.id,
            connDetails.name
        );

    } catch (proxyError: any) {
        console.error(`SshService: Proxy connection setup failed for ${connDetails.name}: ${proxyError.message}`);
        try { sshClient.end(); } catch(e) { /* ignore */ }
        throw proxyError;
    }
};

// --- Helper function for preparing ConnectConfig for each jump hop ---
function _prepareConnectConfigForHop(
    hopDetail: JumpHostDetail,
    previousStream: ClientChannel | null,
    timeout: number
): ConnectConfig {
    const config: ConnectConfig = {
        username: hopDetail.username,
        readyTimeout: timeout,
        keepaliveInterval: 5000,
        keepaliveCountMax: 10,
    };
    if (hopDetail.auth_method === 'password') {
        config.password = hopDetail.password;
    } else {
        config.privateKey = hopDetail.privateKey;
        config.passphrase = hopDetail.passphrase;
    }

    if (previousStream) {
        config.sock = previousStream as any; // ssh2 types ClientChannel, but it's a Duplex stream
    } else {
        config.host = hopDetail.host;
        config.port = hopDetail.port;
    }
    return config;
}

// --- Core recursive logic for multi-hop SSH connection ---
async function _establishConnectionViaJumpChainRecursive(
    hopIndex: number,
    previousStream: ClientChannel | null,
    jumpChainDetails: JumpHostDetail[],
    finalTargetDetails: DecryptedConnectionDetails,
    activeClients: Client[], // Stores successfully connected intermediate clients for cleanup
    timeoutPerHop: number
): Promise<Client> {
    return new Promise<Client>(async (resolveOuter, rejectOuter) => {
        const cleanupAndReject = (error: Error, clientOnError?: Client) => {
            console.error(`SshService: JumpChainCleanupAndReject (Hop ${hopIndex + 1}) for ${finalTargetDetails.name}. Error: ${error.message}`);
            if (clientOnError) {
                try {
                    clientOnError.end();
                } catch (e) {
                    console.error(`SshService: Error ending clientOnError during jump chain cleanup:`, (e as Error).message);
                }
            }
            activeClients.forEach(client => {
                try {
                    client.end();
                } catch (e) {
                    console.error(`SshService: Error ending an active client during jump chain cleanup:`, (e as Error).message);
                }
            });
            activeClients.length = 0; // Clear the array
            rejectOuter(error);
        };

        // Base case: All jump hosts are connected. Now connect to the final target.
        if (hopIndex === jumpChainDetails.length) {
            if (!previousStream) {
                console.error(`SshService: JumpHop[BaseCase] Error - Jump chain exhausted but no stream to final target for ${finalTargetDetails.name}.`);
                return cleanupAndReject(new Error("SshService: Jump chain exhausted but no stream to final target. This indicates an internal logic error."));
            }

            const finalClient = new Client();

            const finalConnectConfig: ConnectConfig = {
                sock: previousStream as any,
                username: finalTargetDetails.username,
                password: finalTargetDetails.password,
                privateKey: finalTargetDetails.privateKey,
                passphrase: finalTargetDetails.passphrase,
                readyTimeout: timeoutPerHop,
                keepaliveInterval: 5000,
                keepaliveCountMax: 10,
            };
            
            _setupSshClientListenersAndConnect(
                finalClient,
                finalConnectConfig,
                true, // isFinalClient
                finalTargetDetails.id,
                finalTargetDetails.name
            )
            .then(client => {
                resolveOuter(client); // Successfully connected to final target
            })
            .catch(err => {
                cleanupAndReject(new Error(`Final target connection error for ${finalTargetDetails.name} (via jump chain): ${err.message}`), finalClient);
            });
            return; // Exit promise executor
        }

        // Recursive step: Connect to the current jump host
        const currentJumpHostDetails = jumpChainDetails[hopIndex];
        const currentHopLogPrefix = `SshService: JumpHop[${hopIndex + 1}/${jumpChainDetails.length}] (${currentJumpHostDetails.name || currentJumpHostDetails.host}:${currentJumpHostDetails.port}) -> `;
        console.log(`${currentHopLogPrefix}Connecting to jump host: ${currentJumpHostDetails.host}:${currentJumpHostDetails.port} (User: ${currentJumpHostDetails.username}, Auth: ${currentJumpHostDetails.auth_method}). PreviousStream exists: ${!!previousStream}`);

        const currentHopClient = new Client();
        const connectConfigForThisHop = _prepareConnectConfigForHop(currentJumpHostDetails, previousStream, timeoutPerHop);
        console.log(`${currentHopLogPrefix}Prepared connect config for this hop: Host=${connectConfigForThisHop.host}, Port=${connectConfigForThisHop.port}, SockPresent=${!!connectConfigForThisHop.sock}`);
        
        // Define specific handlers for this intermediate hop
        const currentHopHandlers = {
            ready: () => {
                currentHopClient.removeListener('error', currentHopHandlers.error);
                currentHopClient.removeListener('close', currentHopHandlers.close);
                activeClients.push(currentHopClient); // Add to activeClients only AFTER successful connection

                console.log(`${currentHopLogPrefix}Successfully connected.`);

                const isLastJumpHost = hopIndex === jumpChainDetails.length - 1;
                const nextTargetHost = isLastJumpHost ? finalTargetDetails.host : jumpChainDetails[hopIndex + 1].host;
                const nextTargetPort = isLastJumpHost ? finalTargetDetails.port : jumpChainDetails[hopIndex + 1].port;

                console.log(`${currentHopLogPrefix}Attempting forwardOut to ${nextTargetHost}:${nextTargetPort}`);
                currentHopClient.forwardOut(
                    '127.0.0.1', 0, nextTargetHost, nextTargetPort, // Listen on any local port on the jump host
                    (err, nextStream) => {
                        if (err) {
                            console.error(`${currentHopLogPrefix}forwardOut to ${nextTargetHost}:${nextTargetPort} FAILED:`, err);
                            // currentHopClient is in activeClients, cleanupAndReject will handle it.
                            return cleanupAndReject(new Error(`${currentHopLogPrefix}forwardOut to ${nextTargetHost}:${nextTargetPort} failed: ${err.message}`), currentHopClient);
                        }
                        console.log(`${currentHopLogPrefix}forwardOut to ${nextTargetHost}:${nextTargetPort} successful. Proceeding to next hop or target with new stream.`);
                        _establishConnectionViaJumpChainRecursive(
                            hopIndex + 1, nextStream, jumpChainDetails, finalTargetDetails, activeClients, timeoutPerHop
                        )
                        .then(resolveOuter) // Propagate success
                        .catch(rejectOuter); // Propagate failure (cleanup handled by deeper calls or cleanupAndReject)
                    }
                );
            },
            error: (err: Error) => {
                console.error(`${currentHopLogPrefix}Connection ERROR:`, err);
                currentHopClient.removeListener('ready', currentHopHandlers.ready); // 'ready' is once
                currentHopClient.removeListener('close', currentHopHandlers.close);
                cleanupAndReject(new Error(`${currentHopLogPrefix}connection error: ${err.message}`), currentHopClient);
            },
            close: () => {
                currentHopClient.removeListener('ready', currentHopHandlers.ready); // 'ready' is once
                currentHopClient.removeListener('error', currentHopHandlers.error);
                console.warn(`${currentHopLogPrefix}Connection closed unexpectedly.`);
                // This might indicate the hop dropped. If the promise for this hop hasn't settled,
                // it should be an error. cleanupAndReject will handle this if it's called.
                // To be safe, if the outer promise hasn't been settled, reject it.
                // However, 'error' event usually precedes an unexpected close that causes failure.
                // If this 'close' happens after 'ready' and during 'forwardOut' or deeper recursion,
                // the failure will be caught by those stages or the final client.
            }
        };
        
        currentHopClient.once('ready', currentHopHandlers.ready);
        currentHopClient.on('error', currentHopHandlers.error);
        currentHopClient.on('close', currentHopHandlers.close);

        console.log(`${currentHopLogPrefix}Attempting to connect. Config: host=${connectConfigForThisHop.host}, port=${connectConfigForThisHop.port}, user=${connectConfigForThisHop.username}, sock=${!!connectConfigForThisHop.sock}`);
        currentHopClient.connect(connectConfigForThisHop);
    });
}


/**
 * 根据解密后的连接详情建立 SSH 连接（处理代理和跳板机）
 * @param connDetails - 解密后的连接详情
 * @param timeout - 连接超时时间 (毫秒)，可选
 * @returns Promise<Client> 连接成功的 SSH Client 实例
 * @throws Error 如果连接失败
 */
export const establishSshConnection = (
    connDetails: DecryptedConnectionDetails,
    timeout: number = CONNECT_TIMEOUT
): Promise<Client> => {

    if (connDetails.connection_proxy_setting === 'jump') {
        if (connDetails.jump_chain && connDetails.jump_chain.length > 0) {
            // Log details of each jump host
            connDetails.jump_chain.forEach((hop, index) => {
            });
            return _establishConnectionViaJumpChainRecursive(
                0, // hopIndex
                null, // previousStream
                connDetails.jump_chain,
                connDetails, // finalTargetDetails
                [], // activeClients (for cleanup of intermediate hops)
                timeout // timeoutPerHop (can be refined if needed per hop)
            );
        } else {
            console.warn(`SshService: Connection ${connDetails.name} set to 'jump' but jump_chain is MISSING or EMPTY. Attempting direct connection as fallback.`);
            return _establishDirectSshConnection(connDetails, timeout);
        }
    } else if (connDetails.connection_proxy_setting === 'proxy') {
        if (connDetails.proxy) {
            return _establishProxyConnection(connDetails, timeout);
        } else {
            console.warn(`SshService: Connection ${connDetails.name} set to 'proxy' but proxy details are MISSING. Attempting direct connection as fallback.`);
            return _establishDirectSshConnection(connDetails, timeout);
        }
    } else {
        if (connDetails.connection_proxy_setting && connDetails.connection_proxy_setting !== null && connDetails.connection_proxy_setting !== undefined) {
        }
        return _establishDirectSshConnection(connDetails, timeout);
    }
};


/**
 * 在已连接的 SSH Client 上打开 Shell 通道
 * @param sshClient - 已连接的 SSH Client 实例
 * @returns Promise<ClientChannel> Shell 通道实例
 * @throws Error 如果打开 Shell 失败
 */
export const openShell = (sshClient: Client): Promise<ClientChannel> => {
    return new Promise((resolve, reject) => {
        sshClient.shell((err, stream) => {
            if (err) {
                console.error(`SshService: 打开 Shell 失败:`, err);
                return reject(new Error(`打开 Shell 失败: ${err.message}`));
            }
            console.log(`SshService: Shell 通道已打开。`);
            resolve(stream);
        });
    });
};

/**
 * 测试给定 ID 的 SSH 连接（包括代理）
 * @param connectionId 连接 ID
 * @returns Promise<{ latency: number }> - 如果连接成功则 resolve 包含延迟的对象，否则 reject
 * @throws Error 如果连接失败或配置错误
 */
export const testConnection = async (connectionId: number): Promise<{ latency: number }> => {
    console.log(`SshService: 测试连接 ${connectionId}...`);
    let sshClient: Client | null = null;
    const startTime = Date.now();
    try {
        const connDetails = await getConnectionDetails(connectionId);
        sshClient = await establishSshConnection(connDetails, TEST_TIMEOUT);
        const endTime = Date.now();
        const latency = endTime - startTime;
        console.log(`SshService: 测试连接 ${connectionId} 成功，延迟: ${latency}ms。`);
        return { latency };
    } catch (error) {
        console.error(`SshService: 测试连接 ${connectionId} 失败:`, error);
        throw error;
    } finally {
        if (sshClient) {
            sshClient.end();
            console.log(`SshService: 测试连接 ${connectionId} 的客户端已关闭。`);
        }
    }
};


/**
 * 测试未保存的 SSH 连接信息（包括代理）
 * @param connectionConfig - 包含连接参数的对象
 * @returns Promise<{ latency: number }> - 如果连接成功则 resolve 包含延迟的对象，否则 reject
 * @throws Error 如果连接失败或配置错误
 */
export const testUnsavedConnection = async (connectionConfig: {
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string;
    private_key?: string;
    passphrase?: string;
    ssh_key_id?: number | null;
    proxy_id?: number | null;
}): Promise<{ latency: number }> => {
    console.log(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port}...`);
    let sshClient: Client | null = null;
    const startTime = Date.now();
    try {
        const tempConnDetails: DecryptedConnectionDetails = {
            id: -1, // Temporary ID for non-persistent connection
            name: `Test-${connectionConfig.host}`,
            host: connectionConfig.host,
            port: connectionConfig.port,
            username: connectionConfig.username,
            auth_method: connectionConfig.auth_method,
            password: undefined,
            privateKey: undefined,
            passphrase: undefined,
            proxy: null,
            connection_proxy_setting: connectionConfig.proxy_id ? 'proxy' : null,
        };

        if (tempConnDetails.auth_method === 'password') {
            tempConnDetails.password = connectionConfig.password;
        } else {
            if (connectionConfig.ssh_key_id) {
                console.log(`SshService: Testing unsaved connection using stored SSH key ID: ${connectionConfig.ssh_key_id}...`);
                const storedKeyDetails = await SshKeyService.getDecryptedSshKeyById(connectionConfig.ssh_key_id);
                if (!storedKeyDetails) {
                    throw new Error(`选择的 SSH 密钥 (ID: ${connectionConfig.ssh_key_id}) 未找到。`);
                }
                tempConnDetails.privateKey = storedKeyDetails.privateKey;
                tempConnDetails.passphrase = storedKeyDetails.passphrase;
            } else {
                tempConnDetails.privateKey = connectionConfig.private_key;
                tempConnDetails.passphrase = connectionConfig.passphrase;
            }
        }

        if (connectionConfig.proxy_id) {
            console.log(`SshService: 测试连接需要获取代理 ${connectionConfig.proxy_id} 的信息...`);
            const rawProxyInfo = await ProxyRepository.findProxyById(connectionConfig.proxy_id);
            if (!rawProxyInfo) {
                throw new Error(`代理 ID ${connectionConfig.proxy_id} 未找到。`);
            }
            try {
                 const proxyName = rawProxyInfo.name ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null name.`); })();
                 const proxyType = rawProxyInfo.type ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null type.`); })();
                 const proxyHost = rawProxyInfo.host ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null host.`); })();
                 const proxyPort = rawProxyInfo.port ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null port.`); })();

                 if (proxyType !== 'SOCKS5' && proxyType !== 'HTTP') {
                    throw new Error(`Proxy ID ${connectionConfig.proxy_id} has invalid type: ${proxyType}`);
                 }

                tempConnDetails.proxy = {
                    id: rawProxyInfo.id,
                    name: proxyName,
                    type: proxyType,
                    host: proxyHost,
                    port: proxyPort,
                    username: rawProxyInfo.username || undefined,
                    password: rawProxyInfo.encrypted_password ? decrypt(rawProxyInfo.encrypted_password) : undefined,
                };
                tempConnDetails.connection_proxy_setting = 'proxy'; // Ensure this is set
                console.log(`SshService: 代理 ${connectionConfig.proxy_id} 信息获取并解密成功。`);
            } catch (decryptError: any) {
                console.error(`SshService: 处理代理 ${connectionConfig.proxy_id} 凭证失败:`, decryptError);
                throw new Error(`处理代理凭证失败: ${decryptError.message}`);
            }
        } else {
            tempConnDetails.connection_proxy_setting = null; // Explicitly no proxy
        }

        sshClient = await establishSshConnection(tempConnDetails, TEST_TIMEOUT);

        const endTime = Date.now();
        const latency = endTime - startTime;
        console.log(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port} 成功，延迟: ${latency}ms。`);
        return { latency };
    } catch (error) {
        console.error(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port} 失败:`, error);
        throw error;
    } finally {
        if (sshClient) {
            sshClient.end();
            console.log(`SshService: 测试未保存连接的客户端已关闭。`);
        }
    }
};