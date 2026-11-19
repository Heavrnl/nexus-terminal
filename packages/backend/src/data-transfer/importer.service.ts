import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { allDb, getDbInstance, runDb } from '../database/connection';
import { encrypt } from '../utils/crypto';
import { DATASETS, resolveDatasetOrder, DatasetSpec, TableSpec } from './datasets';
import {
    EXPORT_ENTRY_MANIFEST,
    EXPORT_ENTRY_PAYLOAD,
    ExportManifest,
    InvalidPackageError,
    decryptPayload,
    sha256Hex,
    validateManifest,
} from './format';
import {
    ConflictStrategy,
    DatasetPlan,
    aggregatePlan,
    buildDuplicateName,
    buildIdentityKey,
    isBlankIdentity,
    normalizeIdentityValue,
} from './plan';
import { ExportPayload, toPlainColumn } from './exporter.service';
import {
    generateDeterministicCommandUuid,
    normalizeCommandText,
} from '../command-history/command-history.pure';

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 200_000;
const SESSION_TTL_MS = 5 * 60 * 1000;

export interface ImportSession {
    token: string;
    payload: ExportPayload;
    manifest: ExportManifest;
    plans: DatasetPlan[];
    createdAt: number;
}

const sessions = new Map<string, ImportSession>();

function sweepSessions(): void {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
    }
}

export interface AnalyzeResult {
    token: string;
    manifest: Omit<ExportManifest, 'payload' | 'kdf' | 'cipher'> & {
        payloadBytes: number;
    };
    plans: DatasetPlan[];
    totals: { incoming: number; create: number; conflict: number; invalid: number };
    /** 包里出现、但当前程序不认识的数据集 key */
    unknownDatasets: string[];
}

/**
 * 读包 → 校验 → 解密 → 出预览计划。**这一步不写任何数据**。
 *
 * 预览结果缓存 5 分钟，执行时凭 token 取回同一份 payload ——
 * 这样浏览器不需要把解密后的明文再上传一次。
 */
export async function analyzePackage(buffer: Buffer, password: string): Promise<AnalyzeResult> {
    if (buffer.length > MAX_PACKAGE_BYTES) {
        throw new InvalidPackageError('notObject', 'PACKAGE_TOO_LARGE');
    }

    let zip: AdmZip;
    try {
        zip = new AdmZip(buffer);
    } catch {
        throw new InvalidPackageError('notObject', 'NOT_A_ZIP');
    }

    const manifestEntry = zip.getEntry(EXPORT_ENTRY_MANIFEST);
    if (!manifestEntry) throw new InvalidPackageError('notObject', 'MANIFEST_MISSING');

    let rawManifest: unknown;
    try {
        rawManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch {
        throw new InvalidPackageError('notObject', 'MANIFEST_INVALID');
    }

    const { manifest, salt, iv, tag } = validateManifest(rawManifest);

    const payloadEntry = zip.getEntry(manifest.payload.entry || EXPORT_ENTRY_PAYLOAD);
    if (!payloadEntry) throw new InvalidPackageError('missingPayload', 'PAYLOAD_MISSING');

    const cipherBytes = payloadEntry.getData();
    if (cipherBytes.length > MAX_PAYLOAD_BYTES) {
        throw new InvalidPackageError('missingPayload', 'PAYLOAD_TOO_LARGE');
    }
    if (manifest.payload.sha256 && sha256Hex(cipherBytes) !== manifest.payload.sha256) {
        throw new InvalidPackageError('missingPayload', 'CHECKSUM_MISMATCH');
    }

    const plain = decryptPayload(cipherBytes, password, salt, iv, tag);

    let parsed: any;
    try {
        parsed = JSON.parse(plain.toString('utf8'));
    } catch {
        throw new InvalidPackageError('notObject', 'PAYLOAD_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.datasets !== 'object' || parsed.datasets === null) {
        throw new InvalidPackageError('notObject', 'PAYLOAD_INVALID');
    }

    const payload: ExportPayload = { datasets: {} };
    const unknownDatasets: string[] = [];
    for (const [key, value] of Object.entries(parsed.datasets as Record<string, any>)) {
        if (!DATASETS[key]) {
            unknownDatasets.push(key);
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        const tables: Record<string, Array<Record<string, any>>> = {};
        for (const [tableName, rows] of Object.entries(value as Record<string, any>)) {
            if (!Array.isArray(rows)) continue;
            if (rows.length > MAX_ROWS_PER_TABLE) {
                throw new InvalidPackageError('missingDatasets', 'ROWS_TOO_MANY');
            }
            tables[tableName] = rows.filter(
                (row) => row && typeof row === 'object' && !Array.isArray(row)
            ) as Array<Record<string, any>>;
        }
        payload.datasets[key] = tables;
    }

    const db = await getDbInstance();
    const plans: DatasetPlan[] = [];
    for (const key of resolveDatasetOrder(Object.keys(payload.datasets))) {
        const spec = DATASETS[key];
        for (const tableSpec of spec.tables) {
            const rows = payload.datasets[key]?.[tableSpec.table] || [];
            const index = await loadIdentityIndex(db, tableSpec);
            const plan = aggregatePlan(key, rows, tableSpec.identity, new Set(index.keys()));
            plans.push(plan);
        }
    }

    // 同一个数据集理论上只有一张表；多表时合并展示，避免预览里出现两行同名
    const merged = mergePlans(plans);

    sweepSessions();
    const token = crypto.randomUUID();
    sessions.set(token, {
        token,
        payload,
        manifest,
        plans: merged,
        createdAt: Date.now(),
    });

    const totals = merged.reduce(
        (acc, plan) => ({
            incoming: acc.incoming + plan.incoming,
            create: acc.create + plan.create,
            conflict: acc.conflict + plan.conflict,
            invalid: acc.invalid + plan.invalid,
        }),
        { incoming: 0, create: 0, conflict: 0, invalid: 0 }
    );

    return {
        token,
        manifest: {
            format: manifest.format,
            schemaVersion: manifest.schemaVersion,
            appVersion: manifest.appVersion,
            exportedAt: manifest.exportedAt,
            secretMode: manifest.secretMode,
            datasets: manifest.datasets,
            payloadBytes: manifest.payload.bytes,
        },
        plans: merged,
        totals,
        unknownDatasets,
    };
}

function mergePlans(plans: DatasetPlan[]): DatasetPlan[] {
    const byKey = new Map<string, DatasetPlan>();
    for (const plan of plans) {
        const existing = byKey.get(plan.key);
        if (!existing) {
            byKey.set(plan.key, { ...plan, errors: [...plan.errors] });
            continue;
        }
        existing.incoming += plan.incoming;
        existing.create += plan.create;
        existing.conflict += plan.conflict;
        existing.invalid += plan.invalid;
        existing.errors.push(...plan.errors);
        existing.errors = existing.errors.slice(0, 50);
    }
    return [...byKey.values()];
}

async function loadIdentityIndex(
    db: any,
    tableSpec: TableSpec
): Promise<Map<string, number>> {
    const columns = tableSpec.identity.join(', ');
    const rows = await allDb<Record<string, any>>(
        db,
        `SELECT ${tableSpec.idColumn ? `${tableSpec.idColumn}, ` : ''}${columns} FROM ${tableSpec.table}`
    );
    const index = new Map<string, number>();
    for (const row of rows) {
        const key = buildIdentityKey(tableSpec.identity, row);
        const id = tableSpec.idColumn ? Number(row[tableSpec.idColumn]) : 0;
        if (!index.has(key)) index.set(key, id);
    }
    return index;
}

/** duplicate 策略下要避开已存在的名字，否则撞 UNIQUE 约束 */
async function loadExistingNames(db: any, table: string): Promise<Set<string>> {
    try {
        const rows = await allDb<Record<string, any>>(db, `SELECT name FROM ${table}`);
        return new Set(rows.map((row) => normalizeIdentityValue(row.name)));
    } catch {
        return new Set();
    }
}

export interface DatasetReport {
    key: string;
    incoming: number;
    created: number;
    updated: number;
    skipped: number;
    invalid: number;
    errors: Array<{ index: number; message: string }>;
}

export interface ImportReport {
    startedAt: string;
    finishedAt: string;
    datasets: DatasetReport[];
    totals: {
        incoming: number;
        created: number;
        updated: number;
        skipped: number;
        invalid: number;
    };
}

export class ImportSessionError extends Error {
    readonly reason: 'unknownToken' | 'expired' | 'alreadyUsed';

    constructor(reason: 'unknownToken' | 'expired' | 'alreadyUsed') {
        super(reason);
        this.name = 'ImportSessionError';
        this.reason = reason;
    }
}

export async function executeImport(
    token: string,
    strategies: Partial<Record<string, ConflictStrategy>>
): Promise<ImportReport> {
    sweepSessions();
    const session = sessions.get(token);
    if (!session) throw new ImportSessionError('unknownToken');
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        throw new ImportSessionError('expired');
    }
    // 一次性：拿到就删，避免同一份预览被点两次导入
    sessions.delete(token);

    const db = await getDbInstance();
    const startedAt = new Date().toISOString();
    const idMaps = new Map<string, Map<number, number>>();
    const reports: DatasetReport[] = [];
    const keysInPackage = Object.keys(session.payload.datasets);

    for (const key of resolveDatasetOrder(keysInPackage)) {
        const spec = DATASETS[key];
        const strategy = normalizeStrategy(strategies[key]);
        const report: DatasetReport = {
            key,
            incoming: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            invalid: 0,
            errors: [],
        };

        for (const tableSpec of spec.tables) {
            const rows = session.payload.datasets[key]?.[tableSpec.table] || [];
            if (rows.length === 0) continue;

            report.incoming += rows.length;
            const index = await loadIdentityIndex(db, tableSpec);
            const isJunction = !tableSpec.idColumn && !tableSpec.keyColumn;

            await runDb(db, 'BEGIN');
            try {
                for (let i = 0; i < rows.length; i++) {
                    const outcome = await importRow({
                        db,
                        tableSpec,
                        spec,
                        row: rows[i],
                        index,
                        strategy,
                        idMaps,
                        isJunction,
                    });
                    if (outcome.status === 'created') report.created++;
                    else if (outcome.status === 'updated') report.updated++;
                    else if (outcome.status === 'skipped') report.skipped++;
                    else {
                        report.invalid++;
                        if (report.errors.length < 50) {
                            report.errors.push({ index: i, message: outcome.message });
                        }
                    }                }
                await runDb(db, 'COMMIT');
            } catch (error: any) {
                try {
                    await runDb(db, 'ROLLBACK');
                } catch {
                    /* 已经回滚或事务未开启 */
                }
                report.invalid += rows.length;
                report.created = report.updated = report.skipped = 0;
                report.errors.push({ index: -1, message: error?.message || 'TRANSACTION_FAILED' });
            }
        }

        if (report.incoming > 0) reports.push(report);
    }

    const totals = reports.reduce(
        (acc, r) => ({
            incoming: acc.incoming + r.incoming,
            created: acc.created + r.created,
            updated: acc.updated + r.updated,
            skipped: acc.skipped + r.skipped,
            invalid: acc.invalid + r.invalid,
        }),
        { incoming: 0, created: 0, updated: 0, skipped: 0, invalid: 0 }
    );

    return {
        startedAt,
        finishedAt: new Date().toISOString(),
        datasets: reports,
        totals,
    };
}

function normalizeStrategy(value: unknown): ConflictStrategy {
    if (value === 'overwrite' || value === 'duplicate' || value === 'skip') return value;
    return 'skip';
}

type RowOutcome =
    | { status: 'created' }
    | { status: 'updated' }
    | { status: 'skipped' }
    | { status: 'invalid'; message: string };

async function importRow(input: {
    db: any;
    tableSpec: TableSpec;
    spec: DatasetSpec;
    row: Record<string, any>;
    index: Map<string, number>;
    strategy: ConflictStrategy;
    idMaps: Map<string, Map<number, number>>;
    isJunction: boolean;
}): Promise<RowOutcome> {
    const { db, tableSpec, spec, index, strategy, idMaps, isJunction } = input;
    const row: Record<string, any> = { ...input.row };
    const sourceId = tableSpec.idColumn ? Number(row[tableSpec.idColumn]) : null;

    // 1. 加密列：包里的 plain_* 明文，落库前用本机 ENCRYPTION_KEY 重新加密
    for (const column of tableSpec.encryptedColumns || []) {
        const plainColumn = toPlainColumn(column);
        const plainValue = row[plainColumn];
        delete row[plainColumn];
        if (plainValue === null || plainValue === undefined || plainValue === '') {
            row[column] = null;
        } else {
            row[column] = encrypt(String(plainValue));
        }
    }
    // 包里可能还有没声明为加密列的 plain_* 残留（老版本包），一并清掉
    for (const column of Object.keys(row)) {
        if (column.startsWith('plain_')) delete row[column];
    }

    // 2. 外键：源机 id -> 本机 id。找不到就置 null；关联表 / 声明了 requiredRefs 的整行作废
    const requiredRefs = new Set(tableSpec.requiredRefs || []);
    for (const ref of tableSpec.refs || []) {
        const mustResolve = isJunction || requiredRefs.has(ref.column);
        const sourceRefId = row[ref.column];
        if (sourceRefId === null || sourceRefId === undefined || sourceRefId === '') {
            if (mustResolve) return { status: 'invalid', message: `missingReference:${ref.dataset}` };
            row[ref.column] = null;
            continue;
        }
        const mapped = idMaps.get(ref.dataset)?.get(Number(sourceRefId));
        if (mapped === undefined || mapped === 0) {
            if (mustResolve) return { status: 'invalid', message: `missingReference:${ref.dataset}` };
            row[ref.column] = null;
        } else {
            row[ref.column] = mapped;
        }
    }

    // 3. 身份
    if (tableSpec.table === 'command_history') {
        row.command = normalizeCommandText(row.command);
        if (row.command) {
            row.uuid = generateDeterministicCommandUuid(row.command);
        }
    }
    if (isBlankIdentity(tableSpec.identity, row)) {
        return { status: 'invalid', message: 'missingIdentity' };
    }
    let identityKey = buildIdentityKey(tableSpec.identity, row);
    const existingId = index.get(identityKey);

    // 4. 策略
    if (existingId !== undefined && strategy === 'skip') {
        if (sourceId !== null && existingId > 0) rememberId(idMaps, spec.key, sourceId, existingId);
        return { status: 'skipped' };
    }

    if (existingId !== undefined && strategy === 'overwrite') {
        if (tableSpec.keyColumn) {
            await runDb(db, buildInsertOrReplaceSql(tableSpec, row), buildInsertParams(tableSpec, row));
            if (sourceId !== null) rememberId(idMaps, spec.key, sourceId, Number(row[tableSpec.keyColumn]));
            return { status: 'updated' };
        }
        if (isJunction) {
            // 关联表没有可更新的列，重复即为跳过
            return { status: 'skipped' };
        }
        const update = buildUpdateStatement(tableSpec, row);
        await runDb(db, update.sql, update.params);
        if (sourceId !== null) rememberId(idMaps, spec.key, sourceId, existingId);
        return { status: 'updated' };
    }

    if (existingId !== undefined && strategy === 'duplicate') {
        // 关联表 / 命令历史（存在 UNIQUE(command) 约束）不存在两份副本的概念，重复直接跳过
        if (isJunction || tableSpec.table === 'command_history') return { status: 'skipped' };

        // 只有真的有 name 列才能改名。settings / appearance / workspace 这类
        // KV 表以 key 为身份，duplicate 退化成覆盖（下面走 INSERT OR REPLACE）。
        if (Object.prototype.hasOwnProperty.call(row, 'name')) {
            const names = await loadExistingNames(db, tableSpec.table);
            row.name = buildDuplicateName(row.name, names);
            // 名字变了身份就变了，必须重算，否则写进 index 的是改名前的 key
            identityKey = buildIdentityKey(tableSpec.identity, row);
        }
    }

    // 5. 插入
    // 只有新增才补 uuid：覆盖已有行时改 uuid 会让别的设备看到「旧行消失、新行出现」
    if (tableSpec.generateUuid && !row.uuid) row.uuid = crypto.randomUUID();

    if (tableSpec.keyColumn) {
        await runDb(db, buildInsertOrReplaceSql(tableSpec, row), buildInsertParams(tableSpec, row));
        if (sourceId !== null) rememberId(idMaps, spec.key, sourceId, Number(row[tableSpec.keyColumn]));
        return { status: 'created' };
    }

    const insert = buildInsertStatement(tableSpec, row);
    const result = await runDb(db, insert.sql, insert.params);
    const newId = Number(result.lastID);
    if (sourceId !== null && Number.isFinite(newId) && newId > 0) {
        rememberId(idMaps, spec.key, sourceId, newId);
    }
    if (tableSpec.idColumn) index.set(identityKey, newId);
    return { status: 'created' };
}

function rememberId(
    idMaps: Map<string, Map<number, number>>,
    datasetKey: string,
    sourceId: number,
    targetId: number
): void {
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return;
    let map = idMaps.get(datasetKey);
    if (!map) {
        map = new Map();
        idMaps.set(datasetKey, map);
    }
    map.set(sourceId, targetId);
}

function writableColumns(tableSpec: TableSpec, row: Record<string, any>): string[] {
    return Object.keys(row).filter((column) => column !== tableSpec.idColumn);
}

function buildInsertStatement(
    tableSpec: TableSpec,
    row: Record<string, any>
): { sql: string; params: any[] } {
    const columns = writableColumns(tableSpec, row);
    return {
        sql: `INSERT INTO ${tableSpec.table} (${columns.join(', ')}) VALUES (${columns
            .map(() => '?')
            .join(', ')})`,
        params: columns.map((column) => row[column]),
    };
}

function buildInsertOrReplaceSql(tableSpec: TableSpec, row: Record<string, any>): string {
    const columns = writableColumns(tableSpec, row);
    return `INSERT OR REPLACE INTO ${tableSpec.table} (${columns.join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`;
}

function buildInsertParams(tableSpec: TableSpec, row: Record<string, any>): any[] {
    return writableColumns(tableSpec, row).map((column) => row[column]);
}

function buildUpdateStatement(
    tableSpec: TableSpec,
    row: Record<string, any>
): { sql: string; params: any[] } {
    const columns = writableColumns(tableSpec, row);
    const updatable = columns.filter((column) => !tableSpec.identity.includes(column));
    const setClause = updatable.map((column) => `${column} = ?`).join(', ');
    // 用 IS 而不是 =，让 NULL 也能参与比较（name 这类列允许为空）
    const whereClause = tableSpec.identity.map((column) => `${column} IS ?`).join(' AND ');
    return {
        sql: `UPDATE ${tableSpec.table} SET ${setClause} WHERE ${whereClause}`,
        params: [
            ...updatable.map((column) => row[column]),
            ...tableSpec.identity.map((column) => row[column]),
        ],
    };
}
