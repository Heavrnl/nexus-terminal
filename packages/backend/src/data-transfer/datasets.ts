/**
 * 数据集定义。导出、预览、导入三处共用同一份声明，避免"导出的字段"和"导入的字段"漂移。
 *
 * 每条 TableSpec 描述「一张表怎么参与导入导出」：
 *   identity          判断"是不是同一条记录"的列（不含自增 id，id 到目标机必然不同）
 *   encryptedColumns  源机用 ENCRYPTION_KEY 加密的列。导出时解密成明文放进包，
 *                     导入时用目标机的 key 重新加密 —— 否则换台机器就解不开。
 *   refs              指向别的数据集的外键列，导入时要换成本机 id
 *   keyColumn         非自增主键（KV 表用）
 *   dropColumns       导出时直接丢掉的列（同步游标、租约持有者之类）
 */

export interface TableSpec {
    table: string;
    idColumn?: string;
    keyColumn?: string;
    identity: string[];
    encryptedColumns?: string[];
    dropColumns?: string[];
    refs?: Array<{ column: string; dataset: string }>;
    /**
     * 这些外键列必须能解析到本机记录，否则整行作废。
     * 用在「外键 NOT NULL」的从表上：父记录没被选中时置 null 只会撞约束，
     * 与其让整张表的事务回滚，不如把这一行标成 invalid 让用户看见。
     */
    requiredRefs?: string[];
    /**
     * 该表的 uuid 是跨端同步身份，包里不带（跨机会撞），
     * 导入时由本机重新生成 —— 否则这些行永远不进同步。
     */
    generateUuid?: boolean;
}

export interface DatasetSpec {
    key: string;
    /** 导入执行顺序，小的先来。外键依赖必须靠这个保证。 */
    order: number;
    defaultSelected: boolean;
    /** 含凭据，UI 上要标出来 */
    sensitive: boolean;
    tables: TableSpec[];
}

const DATASET_LIST: DatasetSpec[] = [
    {
        key: 'folders',
        order: 10,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'folders',
                idColumn: 'id',
                identity: ['name'],
                dropColumns: [],
            },
        ],
    },
    {
        key: 'proxies',
        order: 10,
        defaultSelected: true,
        sensitive: true,
        tables: [
            {
                table: 'proxies',
                idColumn: 'id',
                identity: ['type', 'host', 'port', 'name'],
                encryptedColumns: [
                    'encrypted_password',
                    'encrypted_private_key',
                    'encrypted_passphrase',
                ],
            },
        ],
    },
    {
        key: 'sshKeys',
        order: 10,
        defaultSelected: true,
        sensitive: true,
        tables: [
            {
                table: 'ssh_keys',
                idColumn: 'id',
                identity: ['name'],
                encryptedColumns: ['encrypted_private_key', 'encrypted_passphrase'],
            },
        ],
    },
    {
        key: 'terminalThemes',
        order: 10,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'terminal_themes',
                idColumn: 'id',
                identity: ['name'],
            },
        ],
    },
    {
        key: 'quickCommandFolders',
        order: 10,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'quick_command_folders',
                idColumn: 'id',
                identity: ['name'],
            },
        ],
    },
    {
        key: 'favoritePaths',
        order: 10,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'favorite_paths',
                idColumn: 'id',
                identity: ['path', 'name'],
            },
        ],
    },
    {
        key: 'connectionFolders',
        order: 30,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'connection_folders',
                identity: ['connection_id', 'folder_id'],
                refs: [
                    { column: 'connection_id', dataset: 'connections' },
                    { column: 'folder_id', dataset: 'folders' },
                ],
            },
        ],
    },
    {
        key: 'quickCommandFolderAssociations',
        order: 30,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'quick_command_folder_associations',
                identity: ['quick_command_id', 'folder_id'],
                refs: [
                    { column: 'quick_command_id', dataset: 'quickCommands' },
                    { column: 'folder_id', dataset: 'quickCommandFolders' },
                ],
            },
        ],
    },
    {
        key: 'connections',
        order: 20,
        defaultSelected: true,
        sensitive: true,
        tables: [
            {
                table: 'connections',
                idColumn: 'id',
                // name 必须参与判定：同一个 host:port 上挂两条不同用途的连接很常见
                // （比如同一台机器既跑 shell 又跑文件传输），只用地址会把它们合并成一条。
                identity: ['name', 'type', 'host', 'port', 'username'],
                encryptedColumns: [
                    'encrypted_password',
                    'encrypted_private_key',
                    'encrypted_passphrase',
                ],
                refs: [
                    { column: 'proxy_id', dataset: 'proxies' },
                    { column: 'ssh_key_id', dataset: 'sshKeys' },
                ],
            },
        ],
    },
    {
        key: 'quickCommands',
        order: 20,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'quick_commands',
                idColumn: 'id',
                identity: ['name', 'command'],
            },
        ],
    },
    {
        key: 'portForwards',
        // 必须在 connections 之后：连接就是它的外键
        order: 30,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'port_forwards',
                idColumn: 'id',
                // 一个监听位在同一时刻只能用一条规则，拿监听点当身份最稳
                identity: ['connection_id', 'type', 'bind_host', 'bind_port'],
                // uuid / updated_hlc 是跨端同步游标，跟着导入会把同步状态搞乱
                dropColumns: ['uuid', 'updated_hlc'],
                refs: [{ column: 'connection_id', dataset: 'connections' }],
                requiredRefs: ['connection_id'],
                generateUuid: true,
            },
        ],
    },
    {
        key: 'fileColorHighlights',
        order: 30,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'file_color_highlights',
                idColumn: 'id',
                identity: ['connection_id', 'path'],
                dropColumns: ['uuid', 'updated_hlc'],
                refs: [{ column: 'connection_id', dataset: 'connections' }],
                // connection_id NOT NULL：连接没被选中时置 null 会撞约束，整表事务回滚
                requiredRefs: ['connection_id'],
            },
        ],
    },
    {
        key: 'settings',
        order: 40,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'settings',
                keyColumn: 'key',
                identity: ['key'],
                // uuid / updated_hlc 是跨端同步的版本游标，跟着导入会把同步状态搞乱
                dropColumns: ['uuid', 'updated_hlc'],
            },
        ],
    },
    {
        key: 'appearance',
        order: 40,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'appearance_settings',
                keyColumn: 'key',
                identity: ['key'],
            },
        ],
    },
    {
        key: 'workspace',
        order: 40,
        defaultSelected: true,
        sensitive: false,
        tables: [
            {
                table: 'workspace_sync',
                keyColumn: 'user_id',
                identity: ['user_id'],
                // active_client_id 是快照写租约的持有者标记，导过去等于让新机器抢锁
                dropColumns: ['active_client_id'],
            },
        ],
    },
    {
        key: 'notificationSettings',
        order: 40,
        defaultSelected: false,
        sensitive: true,
        tables: [
            {
                table: 'notification_settings',
                idColumn: 'id',
                identity: ['channel_type', 'name'],
            },
        ],
    },
    {
        key: 'commandHistory',
        order: 50,
        defaultSelected: false,
        sensitive: true,
        tables: [
            {
                table: 'command_history',
                idColumn: 'id',
                identity: ['command'],
                dropColumns: ['uuid', 'updated_hlc'],
            },
        ],
    },
    {
        key: 'pathHistory',
        order: 50,
        defaultSelected: false,
        sensitive: true,
        tables: [
            {
                table: 'path_history',
                idColumn: 'id',
                identity: ['path', 'timestamp'],
            },
        ],
    },
];

export const DATASETS: Record<string, DatasetSpec> = Object.fromEntries(
    DATASET_LIST.map((spec) => [spec.key, spec])
);

/** 按导入顺序排好的数据集 key */
export const DATASET_KEYS_BY_ORDER: string[] = [...DATASET_LIST]
    .sort((a, b) => a.order - b.order)
    .map((spec) => spec.key);

/**
 * 明确不导出的表。写在这里是为了让"为什么没导"有答案，而不是靠人记。
 * users / passkeys / audit_logs 属于账号与安全审计，任何情况下都不该跟着配置文件走。
 */
export const NEVER_EXPORT_TABLES = [
    'users',
    'passkeys',
    'audit_logs',
    'ip_blacklist',
    'sync_tombstones',
];

/** settings 表里绝不能出现在导出包中的键（同步凭据、桌面端配置） */
export const SETTINGS_EXCLUDED_KEYS = ['syncApiKey', 'desktop_sync_config'];

const SENSITIVE_SETTING_KEY_RE = /(password|passwd|token|secret|api[_-]?key|credential)/i;

export function isExcludedSettingKey(key: unknown): boolean {
    if (typeof key !== 'string') return true;
    const trimmed = key.trim();
    if (trimmed.length === 0) return true;
    if (SETTINGS_EXCLUDED_KEYS.includes(trimmed)) return true;
    return SENSITIVE_SETTING_KEY_RE.test(trimmed);
}

/** 给前端用的数据集清单（不含任何表结构细节） */
export interface DatasetDescriptor {
    key: string;
    defaultSelected: boolean;
    sensitive: boolean;
}

export function listDatasets(): DatasetDescriptor[] {
    return DATASET_LIST.map((spec) => ({
        key: spec.key,
        defaultSelected: spec.defaultSelected,
        sensitive: spec.sensitive,
    }));
}

export function resolveDatasetOrder(keys: string[]): string[] {
    const wanted = new Set(keys);
    return DATASET_KEYS_BY_ORDER.filter((key) => wanted.has(key));
}
