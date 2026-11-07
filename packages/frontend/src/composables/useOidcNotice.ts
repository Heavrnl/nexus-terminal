import { onMounted } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

/**
 * OIDC 回调落点提示（契约 §3.1 / §5）。
 *
 * 后端回调结束后会 302 到带 query 的页面，前端负责把它翻成 toast 并清掉 query：
 *   - 绑定成功/冲突：`/settings?tab=security&oidc=bound|conflict`
 *   - 登录失败：`/login?oidc_error=<code>`
 *
 * 这两个映射表是纯数据，单独导出以便被单测直接覆盖（不依赖组件挂载）。
 */

/** `?oidc=` 的取值 → 文案键 + 提示级别 */
export const OIDC_NOTICE_MAP: Record<string, { key: string; type: 'success' | 'error' }> = {
  bound: { key: 'settings.oidc.notice.bound', type: 'success' },
  conflict: { key: 'settings.oidc.notice.conflict', type: 'error' },
};

/** `?oidc_error=` 的错误码 → 文案键（契约 §3.1 的 code 全集） */
export const OIDC_ERROR_MAP: Record<string, string> = {
  state_mismatch: 'login.oidcError.stateMismatch',
  token_exchange_failed: 'login.oidcError.tokenExchangeFailed',
  invalid_id_token: 'login.oidcError.invalidIdToken',
  provider_not_found: 'login.oidcError.providerNotFound',
  provider_disabled: 'login.oidcError.providerDisabled',
  not_linked: 'login.oidcError.notLinked',
  conflict: 'login.oidcError.conflict',
  server_error: 'login.oidcError.serverError',
};

/** 未知错误码统一兜底文案键 */
export const OIDC_ERROR_FALLBACK_KEY = 'login.oidcError.unknown';

/**
 * 解析 query 里的 OIDC 提示。
 * @returns 命中的提示；两个参数都没有（或值不认识）时返回 null。
 */
export function resolveOidcNotice(query: Record<string, unknown>): { key: string; type: 'success' | 'error' } | null {
  const rawNotice = query.oidc;
  const notice = Array.isArray(rawNotice) ? rawNotice[0] : rawNotice;
  if (typeof notice === 'string' && notice) {
    // 必须用 hasOwn 判定：普通对象下标查找会命中原型链，
    // 让 ?oidc=constructor 取到 Object 构造函数（真值）而误判为「命中」。
    if (Object.hasOwn(OIDC_NOTICE_MAP, notice)) return OIDC_NOTICE_MAP[notice];
  }

  const rawError = query.oidc_error;
  const oidcError = Array.isArray(rawError) ? rawError[0] : rawError;
  if (typeof oidcError === 'string' && oidcError) {
    // 同上：`OIDC_ERROR_MAP['__proto__']` 取到原型对象而非 undefined，
    // 会让 `?? 兜底` 失效并把非字符串交给 t()，vue-i18n 对 object key 直接抛 SyntaxError。
    const key = Object.hasOwn(OIDC_ERROR_MAP, oidcError) ? OIDC_ERROR_MAP[oidcError] : OIDC_ERROR_FALLBACK_KEY;
    return { key, type: 'error' };
  }

  return null;
}

/** 从 query 中剔除 OIDC 相关参数，返回新的 query（不改原对象） */
export function stripOidcQuery(query: Record<string, unknown>): LocationQueryRaw {
  const next: LocationQueryRaw = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'oidc' || key === 'oidc_error') continue;
    if (typeof value === 'string' || value === null) {
      next[key] = value;
    } else if (Array.isArray(value)) {
      next[key] = value.filter((v): v is string => typeof v === 'string');
    }
  }
  return next;
}

/**
 * 挂载时读取 `?oidc=` / `?oidc_error=` 并弹出 toast，随后用 router.replace 清掉 query。
 * 清理 query 是为了避免用户刷新页面时重复弹提示。
 */
export function useOidcNotice() {
  const route = useRoute();
  const router = useRouter();
  const { t } = useI18n();
  const uiNotificationsStore = useUiNotificationsStore();

  onMounted(() => {
    const hit = resolveOidcNotice(route.query as Record<string, unknown>);
    if (!hit) return;

    const message = t(hit.key);
    if (hit.type === 'success') {
      uiNotificationsStore.showSuccess(message);
    } else {
      uiNotificationsStore.showError(message);
    }

    const cleaned = stripOidcQuery(route.query as Record<string, unknown>);
    router.replace({ path: route.path, query: cleaned }).catch(() => {
      /* 导航被中断（例如守卫重定向）时忽略即可，提示已经弹过 */
    });
  });
}
