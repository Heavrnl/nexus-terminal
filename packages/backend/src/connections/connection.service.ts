import * as ConnectionRepository from './connection.repository';
import { encrypt, decrypt } from '../utils/crypto';
import { AuditLogService } from '../audit/audit.service';
import * as SshKeyService from '../ssh_keys/ssh_key.service'; 
import {
    ConnectionBase,
    ConnectionWithTags,
    CreateConnectionInput,
    UpdateConnectionInput,
    FullConnectionData,
    ConnectionWithTags as ConnectionWithTagsType // Alias to avoid conflict with variable name
} from '../types/connection.types';

export type { ConnectionBase, ConnectionWithTags, CreateConnectionInput, UpdateConnectionInput };

/**
 * 辅助函数：验证 jump_chain 并处理与 proxy_id 的互斥关系
 * @param jumpChain 输入的 jump_chain
 * @param proxyId 输入的 proxy_id
 * @param connectionId 当前正在操作的连接ID (仅在更新时提供)
 * @returns 处理过的 jump_chain (null 如果无效或应被忽略)
 * @throws Error 如果验证失败
 */
const _validateAndProcessJumpChain = async (
    jumpChain: number[] | null | undefined,
    proxyId: number | null | undefined,
    connectionId?: number
): Promise<number[] | null> => {

    if (!jumpChain || jumpChain.length === 0) {
        return null;
    }

    const validatedChain: number[] = [];
    for (const id of jumpChain) {
        if (typeof id !== 'number') {
            throw new Error('jump_chain 中的 ID 必须是数字。');
        }
        if (connectionId && id === connectionId) {
            throw new Error(`jump_chain 不能包含当前连接自身的 ID (${connectionId})。`);
        }
        const existingConnection = await ConnectionRepository.findConnectionByIdWithTags(id);
        if (!existingConnection) {
            throw new Error(`jump_chain 中的连接 ID ${id} 未找到。`);
        }
        if (existingConnection.type !== 'SSH') {
            throw new Error(`jump_chain 中的连接 ID ${id} (${existingConnection.name}) 不是 SSH 类型。`);
        }
        validatedChain.push(id);
    }
    return validatedChain.length > 0 ? validatedChain : null;
};


const auditLogService = new AuditLogService(); 

/**
 * 获取所有连接（包含标签）
 */
export const getAllConnections = async (): Promise<ConnectionWithTags[]> => {
    // Repository now returns ConnectionWithTags including 'type'
    // Explicit type assertion to ensure compatibility
    return ConnectionRepository.findAllConnectionsWithTags() as Promise<ConnectionWithTags[]>;
};

/**
 * 根据 ID 获取单个连接（包含标签）
 */
export const getConnectionById = async (id: number): Promise<ConnectionWithTags | null> => {
    // Repository now returns ConnectionWithTags including 'type'
    // Explicit type assertion to ensure compatibility
    return ConnectionRepository.findConnectionByIdWithTags(id) as Promise<ConnectionWithTags | null>;
};

/**
 * 创建新连接
 */
export const createConnection = async (input: CreateConnectionInput): Promise<ConnectionWithTags> => {
    // +++ Define a local type alias for clarity, including ssh_key_id +++
    type ConnectionDataForRepo = Omit<FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at' | 'tag_ids'> & { jump_chain?: number[] | null; proxy_type?: 'proxy' | 'jump' | null };

    console.log('[Service:createConnection] Received input:', JSON.stringify(input, null, 2)); // Log input

    // 0. 处理和验证 jump_chain
    const processedJumpChain = await _validateAndProcessJumpChain(input.jump_chain, input.proxy_id);


    // 1. 验证输入 (包含 type)
    // Convert type to uppercase for validation and consistency
    const connectionType = input.type?.toUpperCase() as 'SSH' | 'RDP' | 'VNC' | undefined; // Ensure type safety
    if (!connectionType || !['SSH', 'RDP', 'VNC'].includes(connectionType)) {
        throw new Error('必须提供有效的连接类型 (SSH, RDP 或 VNC)。');
    }
    if (!input.host || !input.username) {
        throw new Error('缺少必要的连接信息 (host, username)。');
    }
    // Type-specific validation using the uppercase version
    if (connectionType === 'SSH') {
        if (!input.auth_method || !['password', 'key'].includes(input.auth_method)) {
             throw new Error('SSH 连接必须提供有效的认证方式 (password 或 key)。');
        }
        if (input.auth_method === 'password' && !input.password) {
            throw new Error('SSH 密码认证方式需要提供 password。');
        }
        // If using ssh_key_id, private_key is not required in the input
        if (input.auth_method === 'key' && !input.ssh_key_id && !input.private_key) {
            throw new Error('SSH 密钥认证方式需要提供 private_key 或选择一个已保存的密钥 (ssh_key_id)。');
        }
        if (input.auth_method === 'key' && input.ssh_key_id && input.private_key) {
            throw new Error('不能同时提供 private_key 和 ssh_key_id。');
        }
    } else if (connectionType === 'RDP') {
        if (!input.password) {
             throw new Error('RDP 连接需要提供 password。');
        }
        // For RDP, we'll ignore auth_method, private_key, passphrase from input if provided
    } else if (connectionType === 'VNC') {
        if (!input.password) {
            throw new Error('VNC 连接需要提供 password。');
        }
        // For VNC, auth_method is implicitly 'password'.
        // ssh_key_id, private_key, passphrase are not applicable.
        if (input.auth_method && input.auth_method !== 'password') {
            throw new Error('VNC 连接的认证方式必须是 password。');
        }
        if (input.ssh_key_id || input.private_key) {
            throw new Error('VNC 连接不支持 SSH 密钥认证。');
        }
    }

    // 2. 处理凭证和 ssh_key_id (根据 type)
    let encryptedPassword = null;
    let encryptedPrivateKey = null;
    let encryptedPassphrase = null;
    let sshKeyIdToSave: number | null = null; // +++ Variable for ssh_key_id +++
    // Default to 'password' for DB compatibility, especially for RDP
    let authMethodForDb: 'password' | 'key' = 'password';

    if (connectionType === 'SSH') {
        authMethodForDb = input.auth_method!; // Already validated above
        if (input.auth_method === 'password') {
            encryptedPassword = encrypt(input.password!);
            sshKeyIdToSave = null; // Password auth cannot use ssh_key_id
        } else { // auth_method is 'key'
            if (input.ssh_key_id) {
                // Validate the provided ssh_key_id
                const keyExists = await SshKeyService.getSshKeyDbRowById(input.ssh_key_id);
                if (!keyExists) {
                    throw new Error(`提供的 SSH 密钥 ID ${input.ssh_key_id} 无效或不存在。`);
                }
                sshKeyIdToSave = input.ssh_key_id;
                // When using ssh_key_id, connection's own key fields should be null
                encryptedPrivateKey = null;
                encryptedPassphrase = null;
            } else if (input.private_key) {
                // Encrypt the provided private key and passphrase
                encryptedPrivateKey = encrypt(input.private_key!);
                if (input.passphrase) {
                    encryptedPassphrase = encrypt(input.passphrase);
                }
                sshKeyIdToSave = null; // Ensure ssh_key_id is null if providing key directly
            } else {
                 // This case should be caught by validation above, but as a safeguard:
                 throw new Error('SSH 密钥认证方式内部错误：未提供 private_key 或 ssh_key_id。');
            }
        }
    } else if (connectionType === 'RDP') { // RDP
        encryptedPassword = encrypt(input.password!);
        // authMethodForDb remains 'password' for RDP
        encryptedPrivateKey = null;
        encryptedPassphrase = null;
        sshKeyIdToSave = null;
    } else { // VNC
        encryptedPassword = encrypt(input.password!);
        authMethodForDb = 'password'; // VNC always uses password auth
        encryptedPrivateKey = null;
        encryptedPassphrase = null;
        sshKeyIdToSave = null;
    }

    // 3. 准备仓库数据
    let defaultPort = 22; // Default for SSH
    if (connectionType === 'RDP') {
        defaultPort = 3389;
    } else if (connectionType === 'VNC') {
        defaultPort = 5900; // Default VNC port
    }
    // +++ Explicitly type connectionData using the local alias +++
    const connectionData: ConnectionDataForRepo = {
        name: input.name || '',
        type: connectionType,
        host: input.host,
        port: input.port ?? defaultPort, // Use type-specific default port
        username: input.username,
        auth_method: authMethodForDb, // Use determined auth method
        encrypted_password: encryptedPassword,
        encrypted_private_key: encryptedPrivateKey, // Null if using ssh_key_id or RDP
        encrypted_passphrase: encryptedPassphrase, // Null if using ssh_key_id or RDP
        ssh_key_id: sshKeyIdToSave, // +++ Add ssh_key_id +++
notes: input.notes ?? null, // Add notes field
        proxy_id: input.proxy_id ?? null, // 直接使用输入的 proxy_id
        proxy_type: input.proxy_type ?? null, // 新增 proxy_type
        jump_chain: processedJumpChain,
        startup_command: input.startup_command ?? null,
        sftp_sudo_enabled: input.sftp_sudo_enabled ?? false,
        encrypted_sftp_sudo_password: input.sftp_sudo_password ? encrypt(input.sftp_sudo_password) : null,
    };
    // Remove ssh_key_id property if it's null before logging/saving if repository expects exact type match without optional nulls
    const finalConnectionData = { ...connectionData };
    if (finalConnectionData.ssh_key_id === null) {
        delete (finalConnectionData as any).ssh_key_id; // Adjust based on repository function signature if needed
    }
    console.log('[Service:createConnection] Data being passed to ConnectionRepository.createConnection:', JSON.stringify(finalConnectionData, null, 2)); // Log data before saving

    // 4. 在仓库中创建连接记录
    // Pass the potentially modified finalConnectionData
    const newConnectionId = await ConnectionRepository.createConnection(finalConnectionData as Omit<ConnectionRepository.FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at' | 'tag_ids'>);

    // 5. 处理标签
    const tagIds = input.tag_ids?.filter(id => typeof id === 'number' && id > 0) ?? [];
    if (tagIds.length > 0) {
        await ConnectionRepository.updateConnectionTags(newConnectionId, tagIds);
    }

    // 6. 记录审计操作
    const newConnection = await getConnectionById(newConnectionId);
    if (!newConnection) {
        // 如果创建成功，这理论上不应该发生
        console.error(`[Audit Log Error] Failed to retrieve connection ${newConnectionId} after creation.`);
        throw new Error('创建连接后无法检索到该连接。');
    }
    auditLogService.logAction('CONNECTION_CREATED', { connectionId: newConnection.id, type: newConnection.type, name: newConnection.name, host: newConnection.host }); // Add type to audit log

    // 7. 返回新创建的带标签的连接
    return newConnection;
};

/**
 * 更新连接信息
 */
export const updateConnection = async (id: number, input: UpdateConnectionInput): Promise<ConnectionWithTags | null> => {
    // 1. 获取当前连接数据（包括加密字段）以进行比较
    const currentFullConnection = await ConnectionRepository.findFullConnectionById(id);
    if (!currentFullConnection) {
        return null; // 未找到连接
    }

    // 2. 准备更新数据
    // Explicitly type dataToUpdate to match the repository's expected input, including ssh_key_id, jump_chain and proxy_type
    const dataToUpdate: Partial<Omit<ConnectionRepository.FullConnectionData & { ssh_key_id?: number | null; jump_chain?: number[] | null; proxy_type?: 'proxy' | 'jump' | null }, 'id' | 'created_at' | 'last_connected_at' | 'tag_ids'>> = {};
    let needsCredentialUpdate = false;
    // Determine the final type, converting input type to uppercase if provided
    const targetType = input.type?.toUpperCase() as 'SSH' | 'RDP' | 'VNC' | undefined || currentFullConnection.type;

    // 处理 jump_chain 和 proxy_id
    if (input.jump_chain !== undefined || input.proxy_id !== undefined) {
        const currentProxyId = input.proxy_id !== undefined ? input.proxy_id : currentFullConnection.proxy_id;
        
        let jumpChainFromDb: number[] | null = null;
        if (currentFullConnection.jump_chain) { // currentFullConnection.jump_chain is string | null
            try {
                jumpChainFromDb = JSON.parse(currentFullConnection.jump_chain) as number[];
            } catch (e) {
                console.error(`[Service:updateConnection] Failed to parse jump_chain from DB for connection ${id}: ${currentFullConnection.jump_chain}`, e);
                // Treat as null if parsing fails, or consider throwing an error
                jumpChainFromDb = null;
            }
        }
        const currentJumpChainForValidation: number[] | null | undefined = input.jump_chain !== undefined ? input.jump_chain : jumpChainFromDb;
        
        const processedJumpChain = await _validateAndProcessJumpChain(currentJumpChainForValidation, currentProxyId, id);
        
        dataToUpdate.jump_chain = processedJumpChain;
        // 直接使用 currentProxyId，不再因为 jump_chain 存在而将其设为 null
        dataToUpdate.proxy_id = currentProxyId;
    }


    // 更新非凭证字段
    if (input.name !== undefined) dataToUpdate.name = input.name || '';
    // Update type if changed, using the uppercase version
    if (input.type !== undefined && targetType !== currentFullConnection.type) dataToUpdate.type = targetType;
    if (input.host !== undefined) dataToUpdate.host = input.host;
    if (input.port !== undefined) dataToUpdate.port = input.port;
    if (input.username !== undefined) dataToUpdate.username = input.username;
    if (input.notes !== undefined) dataToUpdate.notes = input.notes; // Add notes update
    // proxy_id 的处理已移至 jump_chain 逻辑块中
    // if (input.proxy_id !== undefined) dataToUpdate.proxy_id = input.proxy_id;
    if (input.proxy_type !== undefined) dataToUpdate.proxy_type = input.proxy_type; // 新增 proxy_type 更新
    // Handle ssh_key_id update (can be set to null or a new ID)
    if (input.ssh_key_id !== undefined) dataToUpdate.ssh_key_id = input.ssh_key_id;
    if (input.startup_command !== undefined) dataToUpdate.startup_command = input.startup_command;
    if (input.sftp_sudo_enabled !== undefined) dataToUpdate.sftp_sudo_enabled = input.sftp_sudo_enabled;
    if (input.sftp_sudo_password !== undefined) {
        (dataToUpdate as any).encrypted_sftp_sudo_password = input.sftp_sudo_password ? encrypt(input.sftp_sudo_password) : null;
    }

    // 处理认证方法更改或凭证更新 (根据 targetType)
    // Use the validated targetType for logic
    if (targetType === 'SSH') {
        const currentAuthMethod = currentFullConnection.auth_method;
        const inputAuthMethod = input.auth_method;

        // Determine the final auth method for SSH
        const finalAuthMethod = inputAuthMethod || currentAuthMethod;
        if (finalAuthMethod !== currentAuthMethod) {
             dataToUpdate.auth_method = finalAuthMethod; // Update auth_method if it changed
        }

        if (finalAuthMethod === 'password') {
            // If switching to password or updating password
            if (input.password !== undefined) { // Check if password was provided in input
                 if (!input.password && finalAuthMethod !== currentAuthMethod) {
                     // Switching to password requires a password
                     throw new Error('切换到密码认证时需要提供 password。');
                 }
                 // Encrypt if password is not empty, otherwise set to null (to clear)
                 dataToUpdate.encrypted_password = input.password ? encrypt(input.password) : null;
                 needsCredentialUpdate = true;
            }
            // When switching to password, clear key fields and ssh_key_id
            if (finalAuthMethod !== currentAuthMethod) {
                dataToUpdate.encrypted_private_key = null;
                dataToUpdate.encrypted_passphrase = null;
                dataToUpdate.ssh_key_id = null; // Clear ssh_key_id when switching to password
            }
        } else { // finalAuthMethod is 'key'
            // Handle ssh_key_id selection or direct key input
            if (input.ssh_key_id !== undefined) {
                // User selected a stored key
                if (input.ssh_key_id === null) {
                    // User explicitly wants to clear the stored key association
                    dataToUpdate.ssh_key_id = null;
                    // If clearing ssh_key_id, we might need a direct key, but validation should handle this?
                    // Or assume clearing means switching back to direct key input (which might be empty)
                    // Let's assume clearing ssh_key_id means we expect a direct key or nothing
                    if (input.private_key === undefined) {
                        // If no direct key provided when clearing ssh_key_id, clear connection's key fields
                        dataToUpdate.encrypted_private_key = null;
                        dataToUpdate.encrypted_passphrase = null;
                    } else {
                        // Encrypt the direct key provided alongside clearing ssh_key_id
                        dataToUpdate.encrypted_private_key = input.private_key ? encrypt(input.private_key) : null;
                        dataToUpdate.encrypted_passphrase = input.passphrase ? encrypt(input.passphrase) : null;
                    }
                } else {
                    // Validate the provided ssh_key_id
                    const keyExists = await SshKeyService.getSshKeyDbRowById(input.ssh_key_id);
                    if (!keyExists) {
                        throw new Error(`提供的 SSH 密钥 ID ${input.ssh_key_id} 无效或不存在。`);
                    }
                    dataToUpdate.ssh_key_id = input.ssh_key_id;
                    // Clear direct key fields when selecting a stored key
                    dataToUpdate.encrypted_private_key = null;
                    dataToUpdate.encrypted_passphrase = null;
                }
                needsCredentialUpdate = true; // Changing key source is a credential update
            } else if (input.private_key !== undefined) {
                // User provided a direct key
                if (!input.private_key && finalAuthMethod !== currentAuthMethod) {
                    // Switching to key requires a private key if not using ssh_key_id
                    throw new Error('切换到密钥认证时需要提供 private_key 或选择一个已保存的密钥。');
                }
                // Encrypt if key is not empty, otherwise set to null (to clear)
                dataToUpdate.encrypted_private_key = input.private_key ? encrypt(input.private_key) : null;
                // Update passphrase only if direct key was provided OR passphrase itself was provided
                if (input.passphrase !== undefined) {
                    dataToUpdate.encrypted_passphrase = input.passphrase ? encrypt(input.passphrase) : null;
                } else if (input.private_key) {
                    // If only private_key is provided, clear passphrase
                    dataToUpdate.encrypted_passphrase = null;
                }
                dataToUpdate.ssh_key_id = null; // Clear ssh_key_id when providing direct key
                needsCredentialUpdate = true;
            } else if (input.passphrase !== undefined && !input.ssh_key_id && currentFullConnection.encrypted_private_key) {
                 // Only passphrase provided, and not using ssh_key_id, and a direct key already exists
                 dataToUpdate.encrypted_passphrase = input.passphrase ? encrypt(input.passphrase) : null;
                 needsCredentialUpdate = true;
            }

            // When switching to key, clear password field
            if (finalAuthMethod !== currentAuthMethod) {
                dataToUpdate.encrypted_password = null;
            }
        }
    } else if (targetType === 'RDP') { // targetType is 'RDP'
        // RDP only uses password
        if (input.password !== undefined) { // Check if password was provided
             dataToUpdate.encrypted_password = input.password ? encrypt(input.password) : null;
             needsCredentialUpdate = true;
        }
        // Ensure SSH specific fields are nullified if switching to RDP or updating RDP
        if (targetType !== currentFullConnection.type || needsCredentialUpdate || Object.keys(dataToUpdate).includes('type')) {
            dataToUpdate.auth_method = 'password'; // RDP uses password auth method in DB
            dataToUpdate.encrypted_private_key = null;
            dataToUpdate.encrypted_passphrase = null;
            dataToUpdate.ssh_key_id = null; // RDP cannot use ssh_key_id
        }
    } else { // targetType is 'VNC'
        // VNC only uses password
        if (input.password !== undefined) { // Check if password was provided
            dataToUpdate.encrypted_password = input.password ? encrypt(input.password) : null;
            needsCredentialUpdate = true;
        }
        // Ensure SSH specific fields are nullified if switching to VNC or updating VNC
        if (targetType !== currentFullConnection.type || needsCredentialUpdate || Object.keys(dataToUpdate).includes('type')) {
            dataToUpdate.auth_method = 'password'; // VNC uses password auth method in DB
            dataToUpdate.encrypted_private_key = null;
            dataToUpdate.encrypted_passphrase = null;
            dataToUpdate.ssh_key_id = null; // VNC cannot use ssh_key_id
        }
    }

    // 3. 如果有更改，则更新连接记录
    const hasNonTagChanges = Object.keys(dataToUpdate).length > 0;
    let updatedFieldsForAudit: string[] = []; // 跟踪审计日志的字段
    if (hasNonTagChanges) {
        updatedFieldsForAudit = Object.keys(dataToUpdate); // 在更新调用之前获取字段
        console.log(`[Service:updateConnection] Data being passed to ConnectionRepository.updateConnection for ID ${id}:`, JSON.stringify(dataToUpdate, null, 2)); // ADD THIS LOG
        const updated = await ConnectionRepository.updateConnection(id, dataToUpdate);
        if (!updated) {
            // 如果 findFullConnectionById 成功，则不应发生这种情况，但这是良好的实践
            throw new Error('更新连接记录失败。');
        }
    }

    // 4. 如果提供了 tag_ids，则处理标签更新
    if (input.tag_ids !== undefined) {
        const validTagIds = input.tag_ids.filter(tagId => typeof tagId === 'number' && tagId > 0);
        await ConnectionRepository.updateConnectionTags(id, validTagIds);
    }
    // 如果 tag_ids 已更新，则将其添加到审计日志
    if (input.tag_ids !== undefined) {
        updatedFieldsForAudit.push('tag_ids');
    }


    // 5. 如果进行了任何更改，则记录审计操作
    if (hasNonTagChanges || input.tag_ids !== undefined) {
         // Add type to audit log if it was updated
         const auditDetails: any = { connectionId: id, updatedFields: updatedFieldsForAudit };
         if (dataToUpdate.type) {
             auditDetails.newType = dataToUpdate.type;
         }
         auditLogService.logAction('CONNECTION_UPDATED', auditDetails);
    }

    // 6. 获取并返回更新后的连接
    return getConnectionById(id);
};


/**
 * 删除连接
 */
export const deleteConnection = async (id: number): Promise<boolean> => {
    const deleted = await ConnectionRepository.deleteConnection(id);
    if (deleted) {
        // 删除成功后记录审计操作
        auditLogService.logAction('CONNECTION_DELETED', { connectionId: id });
    }
    return deleted;
};

/**
 * 获取连接信息（包含标签）以及解密后的凭证（如果适用）
 * @param id 连接 ID
 * @returns 包含 ConnectionWithTags 和解密后密码/密钥的对象，或 null
 */
export const getConnectionWithDecryptedCredentials = async (
    id: number
): Promise<{ connection: ConnectionWithTags; decryptedPassword?: string; decryptedPrivateKey?: string; decryptedPassphrase?: string } | null> => {
    // 1. 获取完整的连接数据（包含加密字段和可能的 ssh_key_id）
    const fullConnectionDbRow = await ConnectionRepository.findFullConnectionById(id);
    if (!fullConnectionDbRow) {
        console.log(`[Service:getConnWithDecrypt] Connection not found for ID: ${id}`);
        return null;
    }
    // Convert DbRow to the stricter FullConnectionData type expected by the service/types file
    // Handle potential undefined by defaulting to null
    const fullConnection: FullConnectionData = {
        ...fullConnectionDbRow,
        encrypted_password: fullConnectionDbRow.encrypted_password ?? null,
        encrypted_private_key: fullConnectionDbRow.encrypted_private_key ?? null, // May be null if using ssh_key_id
        encrypted_passphrase: fullConnectionDbRow.encrypted_passphrase ?? null, // May be null if using ssh_key_id
        ssh_key_id: fullConnectionDbRow.ssh_key_id ?? null, // +++ Include ssh_key_id +++
        // Ensure other fields match FullConnectionData if necessary
    } as FullConnectionData & { ssh_key_id: number | null }; // Type assertion

    // 2. 获取带标签的连接数据（用于返回给调用者）
    const connectionWithTags: ConnectionWithTags | null = await ConnectionRepository.findConnectionByIdWithTags(id);
    if (!connectionWithTags) {
         // This shouldn't happen if findFullConnectionById succeeded, but good practice to check
         console.error(`[Service:getConnWithDecrypt] Mismatch: Full connection found but tagged connection not found for ID: ${id}`);
         // Consider throwing an error or returning a specific error state
         return null;
    }

    // 3. 解密凭证
    let decryptedPassword: string | undefined = undefined;
    let decryptedPrivateKey: string | undefined = undefined;
    let decryptedPassphrase: string | undefined = undefined;

    try {
        // Decrypt password if method is 'password' and encrypted password exists
        if (fullConnection.auth_method === 'password' && fullConnection.encrypted_password) {
            decryptedPassword = decrypt(fullConnection.encrypted_password);
        }
        // Decrypt key and passphrase if method is 'key'
        else if (fullConnection.auth_method === 'key') {
            if (fullConnection.ssh_key_id) {
                // +++ If using ssh_key_id, fetch and decrypt the stored key +++
                console.log(`[Service:getConnWithDecrypt] Connection ${id} uses stored SSH key ID: ${fullConnection.ssh_key_id}. Fetching key...`);
                const storedKeyDetails = await SshKeyService.getDecryptedSshKeyById(fullConnection.ssh_key_id);
                if (!storedKeyDetails) {
                    // This indicates an inconsistency, as the ssh_key_id should be valid
                    console.error(`[Service:getConnWithDecrypt] Error: Connection ${id} references non-existent SSH key ID ${fullConnection.ssh_key_id}`);
                    throw new Error(`关联的 SSH 密钥 (ID: ${fullConnection.ssh_key_id}) 未找到。`);
                }
                decryptedPrivateKey = storedKeyDetails.privateKey;
                decryptedPassphrase = storedKeyDetails.passphrase;
                console.log(`[Service:getConnWithDecrypt] Successfully fetched and decrypted stored SSH key ${fullConnection.ssh_key_id} for connection ${id}.`);
            } else if (fullConnection.encrypted_private_key) {
                // Decrypt the key stored directly in the connection record
                decryptedPrivateKey = decrypt(fullConnection.encrypted_private_key);
                // Only decrypt passphrase if it exists alongside the direct key
                if (fullConnection.encrypted_passphrase) {
                    decryptedPassphrase = decrypt(fullConnection.encrypted_passphrase);
                }
            } else {
                 console.warn(`[Service:getConnWithDecrypt] Connection ${id} uses key auth but has neither ssh_key_id nor encrypted_private_key.`);
                 // No key available to decrypt
            }
        }
    } catch (error: any) { // Catch decryption or key fetching errors
        console.error(`[Service:getConnWithDecrypt] Failed to decrypt credentials for connection ID ${id}:`, error);
        // Decide how to handle decryption errors. Throw? Return null password?
        // For now, we'll log and continue, returning undefined credentials.
        // Consider throwing an error if credentials are required but decryption fails.
        // Or return a specific error structure: return { error: 'Decryption failed' };
    }

    console.log(`[Service:getConnWithDecrypt] Returning data for ID: ${id}, Auth Method: ${fullConnection.auth_method}`);
    return {
        connection: connectionWithTags,
        decryptedPassword,
        decryptedPrivateKey,
        decryptedPassphrase,
    };
};
// 注意：testConnection、importConnections、exportConnections 逻辑
// 将分别移至 SshService 和 ImportExportService。


/**
 * 克隆连接
 * @param originalId 要克隆的原始连接 ID
 * @param newName 新连接的名称
 * @returns 克隆后的新连接信息（包含标签）
 */
export const cloneConnection = async (originalId: number, newName: string): Promise<ConnectionWithTags> => {
    // 1. 检查新名称是否已存在
    const existingByName = await ConnectionRepository.findConnectionByName(newName);
    if (existingByName) {
        throw new Error(`名称为 "${newName}" 的连接已存在。`);
    }

    // 2. 获取原始连接的完整数据（包括加密字段和 ssh_key_id）
    const originalFullConnection = await ConnectionRepository.findFullConnectionById(originalId);
    if (!originalFullConnection) {
        throw new Error(`ID 为 ${originalId} 的原始连接未找到。`);
    }

    // 3. 准备新连接的数据
    // 使用 Omit 来排除不需要的字段，并确保类型正确
    const dataForNewConnection: Omit<ConnectionRepository.FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at' | 'tag_ids'> = {
        name: newName,
        type: originalFullConnection.type,
        host: originalFullConnection.host,
        port: originalFullConnection.port,
        username: originalFullConnection.username,
        auth_method: originalFullConnection.auth_method,
        encrypted_password: originalFullConnection.encrypted_password ?? null,
        encrypted_private_key: originalFullConnection.encrypted_private_key ?? null,
        encrypted_passphrase: originalFullConnection.encrypted_passphrase ?? null,
        ssh_key_id: originalFullConnection.ssh_key_id ?? null, // 保留原始的 ssh_key_id
        proxy_id: originalFullConnection.proxy_id ?? null,
        proxy_type: originalFullConnection.proxy_type ?? null, // 新增 proxy_type 复制
        notes: originalFullConnection.notes ?? null, // 确保 notes 被复制
        jump_chain: originalFullConnection.jump_chain ? JSON.parse(originalFullConnection.jump_chain) as number[] : null, // 复制并解析 jump_chain
        // 移除不存在的 RDP 字段复制
        // ...(originalFullConnection.rdp_security && { rdp_security: originalFullConnection.rdp_security }),
        // ...(originalFullConnection.rdp_ignore_cert !== undefined && { rdp_ignore_cert: originalFullConnection.rdp_ignore_cert }),
    };

    // 4. 创建新连接记录
    const newConnectionId = await ConnectionRepository.createConnection(dataForNewConnection);

    // 5. 复制原始连接的标签
    const originalTags = await ConnectionRepository.findConnectionTags(originalId);
    if (originalTags.length > 0) {
        const tagIds = originalTags.map(tag => tag.id);
        await ConnectionRepository.updateConnectionTags(newConnectionId, tagIds);
    }

    // 6. 记录审计操作
    const clonedConnection = await getConnectionById(newConnectionId);
    if (!clonedConnection) {
        console.error(`[Audit Log Error] Failed to retrieve connection ${newConnectionId} after cloning from ${originalId}.`);
        throw new Error('克隆连接后无法检索到该连接。');
    }
    // 使用 CONNECTION_CREATED 事件，但添加额外信息表明是克隆操作
    auditLogService.logAction('CONNECTION_CREATED', {
        connectionId: clonedConnection.id,
        type: clonedConnection.type,
        name: clonedConnection.name,
        host: clonedConnection.host,
        clonedFromId: originalId // 添加克隆来源信息
    });

    // 7. 返回新创建的带标签的连接
    return clonedConnection;
};
// 注意：updateConnectionTags 现在主要由 updateConnection 内部调用，
// 或者可以保留用于单独更新单个连接标签的场景（如果需要的话）。
// 为了解决嵌套事务问题，我们添加一个新的批量添加函数。

/**
 * 为指定的一组连接添加一个标签
 * @param connectionIds 连接 ID 数组
 * @param tagId 要添加的标签 ID
 */
export const addTagToConnections = async (connectionIds: number[], tagId: number): Promise<void> => {
    // 1. 验证 tagId 是否有效（可选，但建议）
    // const tagExists = await TagRepository.findTagById(tagId); // 需要导入 TagRepository
    // if (!tagExists) {
    //     throw new Error(`标签 ID ${tagId} 不存在。`);
    // }

    // 2. 调用仓库层批量添加标签
    try {
        await ConnectionRepository.addTagToMultipleConnections(connectionIds, tagId);

        // 记录审计日志 (可以考虑为批量操作定义新的审计类型)
        // TODO: 定义 'CONNECTIONS_TAG_ADDED' 审计日志类型
        // auditLogService.logAction('CONNECTIONS_TAG_ADDED', { connectionIds, tagId });

    } catch (error: any) {
        console.error(`Service: 为连接 ${connectionIds.join(', ')} 添加标签 ${tagId} 时发生错误:`, error);
        throw error; // 重新抛出错误
    }
};

/**
 * 更新指定连接的标签关联 (保留此函数用于可能的其他用途，但主要逻辑转移到 addTagToConnections)
 * @param connectionId 连接 ID
 * @param tagIds 新的标签 ID 数组
 * @returns boolean 指示操作是否成功（找到连接并尝试更新）
 */
export const updateConnectionTags = async (connectionId: number, tagIds: number[]): Promise<boolean> => {
    try {
        const updated = await ConnectionRepository.updateConnectionTags(connectionId, tagIds);
        return updated;
    } catch (error: any) {
        console.error(`Service: 更新连接 ${connectionId} 的标签时发生错误:`, error);
        throw error;
    }
};
