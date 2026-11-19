// packages/backend/src/sync/sync.scheduler.ts
import { getDbInstance, runDb, getDb, allDb, registerSyncChangeNotifier, isDbInTransaction, acquireApplyLock, applyContext } from '../database/connection';
import { syncV2Service } from './sync.v2.service';
import { settingsRepository } from '../settings/settings.repository';
import { generateDeterministicCommandUuid, normalizeCommandText } from '../command-history/command-history.pure';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../services/storage-path.service';
import { getServerSyncApiKey } from './sync.middleware';
import { broadcastSyncInvalidated, notifyLocalFrontendSyncDone } from './sync.ws-broadcaster';

/**
 * 定时兜底同步间隔。
 *
 * 增量同步原本只靠两条腿触发：本地写入（debounce）和云端 WS 长连接的实时通知。
 * WS 在很多真实部署里是断的（反向代理没开 `Upgrade`、防火墙只放行 HTTP、容器前面有 CDN），
 * 那时设备只要自己没改过东西，就永远拉不到另一端的变化。定时兜底把「最终一致」
 * 从「取决于 WS 通不通」变成「最迟一分钟」。
 */
const PERIODIC_SYNC_INTERVAL_MS = 60 * 1000;

/**
 * 这类触发源本身就是「把云端的变化拉下来」，本地没有任何变更也必须跑一轮。
 *
 * 之前这份名单只有 `manual / scheduled / ws_*`，于是启动时那次 `catchup_initial`
 * 在「这台机器自己什么都没改过」的情况下直接空转 —— 正好是最常见的场景：
 * 设备离线期间另一端改了东西，重启后既没有本地变更来触发同步，
 * 也等不到那次启动补拉，只能等用户手动点一次同步。
 */
const forcesSyncRun = (reason: string): boolean =>
  reason === 'manual' ||
  reason === 'periodic' ||
  reason === 'scheduled' ||
  reason.startsWith('ws_') ||
  reason.startsWith('catchup');

export class SyncThrottleScheduler {
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private firstNotifyTime: number = 0;
  private isFlushing: boolean = false;
  private dirtyWhileRunning: boolean = false;
  private isPaused: boolean = false;

  private retryCount: number = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  /** 单飞锁期间被「必须跑」的触发源吞掉时置位，空闲后重跑必须同样强制 */
  private forceNextRun: boolean = false;
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor() {
    // 挂接数据库写入网关唤醒器
    registerSyncChangeNotifier(() => {
      this.notifyChange();
    });
  }

  /**
   * 唤醒调度器 (每次写入成功后调用，不解析 SQL)
   */
  public notifyChange(): void {
    if (this.isPaused) return;

    const now = Date.now();
    if (!this.firstNotifyTime) {
      this.firstNotifyTime = now;
    }

    // 向在线的客户端广播实时变动失效信号 (若当前节点有在线客户端)
    broadcastSyncInvalidated();

    // 重置 1 秒防抖计时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush('debounce');
    }, 1000);

    // 设置 3 秒封顶等待，防止持续密集写入无限期推迟同步
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.flush('max_wait_cap');
      }, 3000);
    }
  }

  /**
   * 暂停/恢复调度器 (用于大批量导入)
   */
  public pause(): void {
    this.isPaused = true;
  }

  public resume(): void {
    this.isPaused = false;
    this.notifyChange();
  }

  /**
   * 执行 Flush 周期
   */
  public async flush(reason: string = 'manual'): Promise<void> {
    // 清理计时器
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.firstNotifyTime = 0;

    // 单飞锁：若本轮正在执行，置 dirtyWhileRunning 标志并在结束后自动重跑
    if (this.isFlushing) {
      this.dirtyWhileRunning = true;
      // 吞掉的是「必须跑」的触发源（启动补拉 / WS 刚连上）时，重跑也得强制，
      // 否则重跑用的 'dirty_rerun' 会因为本地没有变更而空转，这次补拉就彻底丢了
      if (forcesSyncRun(reason)) this.forceNextRun = true;
      return;
    }

    // 事务未提交延后防护：绝不在未提交的事务中执行 flush
    if (isDbInTransaction()) {
      // 重试时保留原触发源：换成 'retry_after_transaction' 会让「必须跑」的
      // 启动补拉 / WS 补拉在重试这一步退化成「本地无变更就空转」
      setTimeout(() => this.flush(reason), 100);
      return;
    }

    this.isFlushing = true;

    try {
      const db = await getDbInstance();

      // 检查当前是否配置了同步目标
      const syncConfigSetting = await settingsRepository.getSetting('desktop_sync_config');
      let vpsUrl = '';
      let apiKey = '';
      if (syncConfigSetting) {
        try {
          const cfg = JSON.parse(syncConfigSetting);
          vpsUrl = cfg.vpsUrl || '';
          apiKey = cfg.apiKey || '';
        } catch {}
      }

      // 若未从 settings 表读取到，尝试从 desktop-settings.json 文件读取
      if (!vpsUrl) {
        try {
          const jsonPath = path.join(getDataDir(), 'desktop-settings.json');
          if (fs.existsSync(jsonPath)) {
            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (parsed.syncVpsUrl && parsed.syncApiKey) {
              vpsUrl = parsed.syncVpsUrl;
              apiKey = parsed.syncApiKey;
            }
          }
        } catch {}
      }

      // 若仍未读取到，尝试环境变量
      if (!vpsUrl) vpsUrl = process.env.SYNC_VPS_URL || '';
      if (!apiKey) apiKey = (await getServerSyncApiKey()) || '';

      if (!vpsUrl || !apiKey) {
        // 未配置远程 VPS 地址或密钥，无需发起网络同步
        this.isFlushing = false;
        return;
      }

      // 检查是否有本地新增变更 (seq > push_cursor)
      const stateRow = await getDb<{ push_cursor: number; enabled: number }>(db, `SELECT push_cursor, enabled FROM sync_state WHERE id = 1`);
      if (!stateRow || stateRow.enabled === 0) {
        // 同步熔断中，不执行自动网络同步
        this.isFlushing = false;
        return;
      }

      const pushCursor = stateRow.push_cursor || 0;
      const maxLocalSeqRow = await getDb<{ maxSeq: number }>(
        db,
        `SELECT MAX(seq) as maxSeq FROM sync_changes WHERE seq > ? AND origin IS NULL`,
        [pushCursor]
      );

      const hasLocalChanges = maxLocalSeqRow?.maxSeq && maxLocalSeqRow.maxSeq > pushCursor;

      // 检查当前配置的同步模式 + 同步范围（细项）
      let currentSyncMode = 'bidirectional';
      let currentSyncItems: string[] | undefined;
      try {
        const jsonPath = path.join(getDataDir(), 'desktop-settings.json');
        if (fs.existsSync(jsonPath)) {
          const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          if (parsed.syncMode) currentSyncMode = parsed.syncMode;
          // 自动同步必须和手动同步用同一套范围，否则「手动只同步布局」之后，
          // 后台自动同步会把用户关掉的连接/命令历史又全推上去。
          if (Array.isArray(parsed.syncItems) && parsed.syncItems.length > 0) {
            currentSyncItems = parsed.syncItems.filter((v: unknown): v is string => typeof v === 'string');
          }
        }
      } catch {}

      // 核心门禁：如果用户设置了以云端为准覆盖本地 (cloud_to_local)，
      // 绝对禁止自动调用 executeSyncCycle 反向向云端推送本地变更！
      if (currentSyncMode === 'cloud_to_local') {
        if (hasLocalChanges && reason !== 'scheduled') {
          console.log('[SyncScheduler] 当前模式为以云端为准覆盖本地 (cloud_to_local)，安全拦截向云端推送本地变更。');
          this.isFlushing = false;
          return;
        }
      }

      // 如果有本地变更，或者触发源本身就要求「去云端拉一次」，发起一轮同步
      if (hasLocalChanges || forcesSyncRun(reason)) {
        const stats = await syncV2Service.executeSyncCycle(vpsUrl, apiKey, apiKey, currentSyncItems);
        if (stats.pushed > 0 || stats.pulled > 0) {
          console.log(`[SyncScheduler] 自动同步完成 (触发源: ${reason})，推送: ${stats.pushed}，拉取: ${stats.pulled}`);
          notifyLocalFrontendSyncDone(stats);
        }
      }

      // 同步成功，重置退避计数
      this.retryCount = 0;
    } catch (err: any) {
      console.warn(`[SyncScheduler] 自动同步执行遇到告警: ${err.message}`);
      // 触发指数退避重试 (2s, 4s, 8s, 16s, 上限 60s)
      this.retryCount = Math.min(this.retryCount + 1, 5);
      const backoffDelay = Math.min(Math.pow(2, this.retryCount) * 1000, 60000);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.flush('retry_backoff');
      }, backoffDelay);
    } finally {
      this.isFlushing = false;
      if (this.dirtyWhileRunning) {
        this.dirtyWhileRunning = false;
        const rerunReason = this.forceNextRun ? 'catchup_after_busy' : 'dirty_rerun';
        this.forceNextRun = false;
        setTimeout(() => this.flush(rerunReason), 100);
      }
    }
  }

  /**
   * 熔断激活与存量数据对齐补录 (Reconciliation Catch-up)
   */
  public async activateAndCatchup(): Promise<void> {
    const db = await getDbInstance();
    console.log('[SyncScheduler] 正在执行 Reconciliation Catch-up 存量数据对齐补录...');

    // 补齐在触发器启用前（或历史遗留流程）写入的 command_history 缺失的确定性 UUID 与 updated_hlc，
    // 防止因 uuid 为空永远进不了 sync_changes 而丢失记录
    const releaseLock = await acquireApplyLock();
    try {
      await applyContext.run({ isApplying: true }, async () => {
        await runDb(db, `UPDATE sync_state SET applying = 1 WHERE id = 1`);
        try {
          const missingCmdRows = await allDb<{
            id: number;
            command: string;
            timestamp: number;
            uuid: string | null;
            updated_hlc: string | null;
          }>(
            db,
            `SELECT id, command, timestamp, uuid, updated_hlc
             FROM command_history
             WHERE uuid IS NULL OR uuid = '' OR updated_hlc IS NULL OR updated_hlc = ''`
          );

          if (missingCmdRows.length > 0) {
            const stateRow = await getDb<{ device_id: string; hlc_ms: number; hlc_ctr: number }>(
              db,
              `SELECT device_id, hlc_ms, hlc_ctr FROM sync_state WHERE id = 1`
            );
            const devId = stateRow?.device_id || 'local';
            const baseMs = Math.max(Number(stateRow?.hlc_ms) || 0, Date.now());
            let ctr = Number(stateRow?.hlc_ctr) || 0;

            for (const row of missingCmdRows) {
              const normalized = normalizeCommandText(row.command);
              if (!normalized) {
                await runDb(db, `DELETE FROM command_history WHERE id = ?`, [row.id]);
                continue;
              }
              const detUuid = generateDeterministicCommandUuid(normalized);
              const existingOther = await getDb<{ id: number; timestamp: number; updated_hlc: string | null }>(
                db,
                `SELECT id, timestamp, updated_hlc FROM command_history WHERE command = ? AND id != ? LIMIT 1`,
                [normalized, row.id]
              );
              if (existingOther) {
                const mergedTs = Math.max(Number(row.timestamp) || 0, Number(existingOther.timestamp) || 0);
                ctr++;
                const hlc =
                  (row.updated_hlc && row.updated_hlc.trim()) ||
                  (existingOther.updated_hlc && existingOther.updated_hlc.trim()) ||
                  `${String(baseMs).padStart(13, '0')}-${String(ctr).padStart(5, '0')}-${devId}`;
                await runDb(
                  db,
                  `UPDATE command_history SET timestamp = ?, uuid = ?, updated_hlc = ? WHERE id = ?`,
                  [mergedTs, detUuid, hlc, existingOther.id]
                );
                await runDb(db, `DELETE FROM command_history WHERE id = ?`, [row.id]);
              } else {
                ctr++;
                const hlc =
                  row.updated_hlc && row.updated_hlc.trim() !== ''
                    ? row.updated_hlc
                    : `${String(baseMs).padStart(13, '0')}-${String(ctr).padStart(5, '0')}-${devId}`;
                await runDb(
                  db,
                  `UPDATE command_history SET command = ?, uuid = ?, updated_hlc = ? WHERE id = ?`,
                  [normalized, detUuid, hlc, row.id]
                );
              }
            }

            await runDb(
              db,
              `UPDATE sync_state SET hlc_ms = MAX(hlc_ms, ?), hlc_ctr = ? WHERE id = 1`,
              [baseMs, ctr]
            );
          }
        } finally {
          await runDb(db, `UPDATE sync_state SET applying = 0 WHERE id = 1`);
        }
      });
    } finally {
      releaseLock();
    }

    const tables = [
      'connections', 'proxies', 'ssh_keys', 'folders', 'quick_commands', 'quick_command_folders',
      'command_history', 'port_forwards',
      // 这三张以前只走 v1（手动全量），首次激活时必须补录一次，否则老数据永远上不了云
      'appearance_settings', 'terminal_themes', 'favorite_paths'
    ];
    let totalCatchup = 0;

    for (const tbl of tables) {
      // 内置 preset 主题（400+ 条）两端一致，只同步自定义主题，否则激活时一次补录几百条垃圾变更
      const onlyUserThemes = tbl === 'terminal_themes' ? ` AND theme_type = 'user'` : '';
      // 查出尚未记录在 sync_changes 中的本地记录
      const unrecordedRows = await allDb<{ uuid: string }>(
        db,
        `SELECT uuid FROM ${tbl}
         WHERE uuid IS NOT NULL AND uuid != ''
           ${onlyUserThemes}
           AND uuid NOT IN (SELECT row_id FROM sync_changes WHERE tbl = '${tbl}')`
      );

      for (const r of unrecordedRows) {
        if (r.uuid) {
          await runDb(db, `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'U', NULL)`, [tbl, r.uuid]);
          totalCatchup++;
        }
      }
    }

    // 针对 folders, quick_command_folders, quick_commands 中带有自定义颜色的存量记录，
    // 若当前没有排队的待推送变更，主动补录一条更新日志，确保旧版本遗漏的文件夹颜色自动上云
    const colorTables = ['folders', 'quick_command_folders', 'quick_commands'];
    for (const tbl of colorTables) {
      const coloredRows = await allDb<{ uuid: string }>(
        db,
        `SELECT uuid FROM ${tbl}
         WHERE background_color IS NOT NULL AND background_color != ''
           AND uuid NOT IN (
             SELECT sc.row_id FROM sync_changes sc
             CROSS JOIN sync_state ss ON ss.id = 1
             WHERE sc.tbl = '${tbl}' AND sc.seq > ss.push_cursor
           )`
      );
      for (const r of coloredRows) {
        if (r.uuid) {
          await runDb(db, `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'U', NULL)`, [tbl, r.uuid]);
          totalCatchup++;
        }
      }
    }

    // 激活触发器熔断开关
    await runDb(db, `UPDATE sync_state SET enabled = 1 WHERE id = 1`);
    console.log(`[SyncScheduler] 触发器已正式激活 (enabled = 1)！共补录 ${totalCatchup} 条存量记录至变更日志。`);

    // 启动后 500ms 自动触发首次同步刷新（本地无变更也会真去云端拉一轮）
    setTimeout(() => {
      this.flush('catchup_initial');
    }, 500);

    // 定时兜底：WS 不通 / 断过之后没接回来时，最迟一分钟也能把云端的变化拉下来
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        void this.flush('periodic');
      }, PERIODIC_SYNC_INTERVAL_MS);
      // 不让这个定时器把进程钉住（测试 / 优雅退出时能正常结束）
      this.periodicTimer.unref?.();
    }

    // 启动每 24 小时一次的墓碑 GC 与变更日志压缩定时器
    setInterval(async () => {
      try {
        await syncV2Service.cleanOldTombstonesAndCompressChanges(30);
      } catch (err: any) {
        console.warn('[SyncScheduler] 定期 GC 执行异常:', err.message);
      }
    }, 24 * 60 * 60 * 1000);
  }
}

// 全局单例调度器
export const syncThrottleScheduler = new SyncThrottleScheduler();
