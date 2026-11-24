export interface ConnectionBase {
    id: number;
    name: string | null;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    proxy_id: number | null;
    proxy_type?: 'proxy' | 'jump' | null; 
    created_at: number;
    updated_at: number;
    last_connected_at: number | null;
    notes?: string | null;
    jump_chain: number[] | null;
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    /** 连接级启动命令：终端连上后自动执行，空字符串表示不执行 */
    startup_command?: string;
    /** 是否用 `sudo sftp-server` 开 SFTP 通道（读写 root 才能碰的路径） */
    sftp_sudo_enabled?: number | boolean;
    /** 只读：是否已存了 sudo 密码（密码本身永不回传前端） */
    has_sudo_password?: number | boolean;
    /** 目标机会话托管模式：auto=跟随全局自动使用 nexus-mux（失败自动降级），legacy=强制传统后端托管 */
    session_hosting_mode?: 'auto' | 'legacy' | null;
}

export interface ConnectionWithFolders extends ConnectionBase {
    folder_ids: number[];
}


export interface CreateConnectionInput {
    name?: string;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port?: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string; 
    private_key?: string; 
    passphrase?: string;
    ssh_key_id?: number | null; 
    proxy_id?: number | null;
    proxy_type?: 'proxy' | 'jump' | null; 
    folder_ids?: number[];
    notes?: string | null;
    jump_chain?: number[] | null;
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    startup_command?: string;
    sftp_sudo_enabled?: boolean;
    /** 明文 sudo 密码，后端负责加密落库；不传/空串表示不设置 */
    sudo_password?: string;
    session_hosting_mode?: 'auto' | 'legacy' | null;
}


export interface UpdateConnectionInput {
    name?: string;
    type?: 'SSH' | 'RDP' | 'VNC';
    host?: string;
    port?: number;
    username?: string;
    auth_method?: 'password' | 'key';
    password?: string;
    private_key?: string;
    passphrase?: string;
    ssh_key_id?: number | null;
    proxy_id?: number | null;
    proxy_type?: 'proxy' | 'jump' | null;
    notes?: string | null;
    folder_ids?: number[];
    jump_chain?: number[] | null;
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    startup_command?: string;
    sftp_sudo_enabled?: boolean;
    /** 明文 sudo 密码，后端负责加密落库；不传/空串表示维持原值 */
    sudo_password?: string;
    session_hosting_mode?: 'auto' | 'legacy' | null;
}


export interface FullConnectionData {
    id: number;
    name: string | null;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    encrypted_password: string | null;
    encrypted_private_key: string | null;
    encrypted_passphrase: string | null;
    ssh_key_id?: number | null; 
    proxy_id: number | null;
    proxy_type?: 'proxy' | 'jump' | null; 
    created_at: number;
    notes: string | null;
    updated_at: number;
    last_connected_at: number | null;
    jump_chain: number[] | null;
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    startup_command?: string;
    sftp_sudo_enabled?: number | boolean;
    encrypted_sudo_password?: string | null;
    session_hosting_mode?: 'auto' | 'legacy' | null;
}

export interface DecryptedConnectionCredentials {
    decryptedPassword?: string;
    decryptedPrivateKey?: string;
    decryptedPassphrase?: string;
    decryptedSudoPassword?: string;
}