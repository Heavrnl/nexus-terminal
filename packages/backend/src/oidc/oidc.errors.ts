/**
 * OIDC 错误码 —— 与契约 §3.1 的 `?oidc_error=<code>` 取值域逐字对应。
 *
 * 刻意收窄成一个封闭联合：回调分支只允许落到这 8 个码之一，
 * 多一个码就意味着前端 i18n 文案表会漏键（契约 §5 要求前端把错误码映射成文案）。
 */
export type OidcErrorCode =
    | 'state_mismatch'
    | 'token_exchange_failed'
    | 'invalid_id_token'
    | 'provider_not_found'
    | 'provider_disabled'
    | 'not_linked'
    | 'conflict'
    | 'server_error';

export class OidcError extends Error {
    readonly code: OidcErrorCode;

    constructor(code: OidcErrorCode, message?: string) {
        super(message ?? code);
        this.name = 'OidcError';
        this.code = code;
    }
}

/** 任意异常 → 契约错误码。非 OidcError 一律归为 server_error（不向外泄露内部细节）。 */
export function toOidcErrorCode(error: unknown): OidcErrorCode {
    return error instanceof OidcError ? error.code : 'server_error';
}
