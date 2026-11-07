import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * OIDC 前端纯函数单测（表单载荷契约 + 回调提示映射）。
 *
 * ## 为什么这里有一个 loader 钩子
 *
 * 与后端那份测试同样的原因（详见 `packages/backend/tests/oidc-unit.test.ts` 顶部注释）：
 * 仓库既有的 `node --experimental-strip-types --test` 口径下，源码里的**相对导入一律省略
 * 扩展名**，直接 import 会报 `Cannot find module`。`useOidcSettings.ts` 还会拉进
 * `utils/apiClient` → `../router` → 11 处 `.vue` 动态导入，这条链在 node 下根本走不通。
 *
 * 所以测试侧用 `module.registerHooks` **补相对导入的 `.ts` 扩展名**，并把 `utils/apiClient`
 * 换成内存桩。被测的 `toSubmitPayload` / `validateRow` / `toFormRow` / `resolveOidcNotice` /
 * `stripOidcQuery` 全部是真实源码。
 */

const API_CLIENT_STUB = `
const ok = async () => ({ data: {} });
export default { get: ok, post: ok, put: ok, delete: ok, patch: ok };
`;

registerHooks({
    resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) {
        if (specifier.includes('utils/apiClient')) {
            return { url: `data:text/javascript,${encodeURIComponent(API_CLIENT_STUB)}`, shortCircuit: true };
        }
        if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
            for (const suffix of ['.ts', '/index.ts']) {
                try {
                    return nextResolve(specifier + suffix, context);
                } catch {
                    /* 换下一个后缀 */
                }
            }
        }
        return nextResolve(specifier, context);
    },
} as never);

const loadSettings = () => import('../src/composables/settings/useOidcSettings.ts');
const loadNotice = () => import('../src/composables/useOidcNotice.ts');

// --- createEmptyOidcProviderRow ---

test('createEmptyOidcProviderRow：新建行默认 enabled、无 id、scopes 用默认值', async () => {
    const { createEmptyOidcProviderRow, DEFAULT_OIDC_SCOPES } = await loadSettings();
    const row = createEmptyOidcProviderRow();
    assert.equal(row.isNew, true);
    assert.equal(row.id, undefined, '新建行不能带 id');
    assert.equal(row.enabled, true, '新建 provider 默认启用');
    assert.equal(row.autoCreateUser, false, '自动建号默认关闭（安全默认）');
    assert.equal(row.hasClientSecret, false);
    assert.equal(row.clientSecret, '');
    assert.equal(row.scopes, DEFAULT_OIDC_SCOPES);
    // 每次调用都是新对象，不能共享引用
    assert.notEqual(createEmptyOidcProviderRow(), row);
});

// --- toFormRow ---

test('toFormRow：clientSecret 永不回填，hasClientSecret 用后端布尔值', async () => {
    const { toFormRow } = await loadSettings();
    const row = toFormRow({
        id: 'p1', name: 'Keycloak', enabled: true, issuerUrl: 'https://kc.example.com',
        clientId: 'cid', scopes: 'openid', autoCreateUser: true,
        allowedEmailDomains: 'example.com', iconUrl: '', createdAt: 1700000000,
        hasClientSecret: true,
    });
    assert.equal(row.isNew, false);
    assert.equal(row.id, 'p1');
    assert.equal(row.clientSecret, '', '即使后端有密钥也不能回填到表单');
    assert.equal(row.hasClientSecret, true);
    assert.equal(row.enabled, true);
    assert.equal(row.autoCreateUser, true);
});

test('toFormRow：scopes 为空回退默认值，缺省字段有兜底', async () => {
    const { toFormRow, DEFAULT_OIDC_SCOPES } = await loadSettings();
    const row = toFormRow({
        id: 'p1', name: '', enabled: false, issuerUrl: '', clientId: '',
        scopes: '', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
        createdAt: 0, hasClientSecret: false,
    });
    assert.equal(row.scopes, DEFAULT_OIDC_SCOPES);
    assert.equal(row.enabled, false);
    assert.equal(row.hasClientSecret, false);
});

// --- toSubmitPayload：契约 §1.3「留空 = 保留原密钥」 ---

test('toSubmitPayload：clientSecret 留空时该字段必须整个不出现（不是空串）', async () => {
    const { toSubmitPayload, toFormRow } = await loadSettings();
    const row = toFormRow({
        id: 'p1', name: 'Keycloak', enabled: true, issuerUrl: 'https://kc.example.com',
        clientId: 'cid', scopes: 'openid', autoCreateUser: false,
        allowedEmailDomains: '', iconUrl: '', createdAt: 1, hasClientSecret: true,
    });
    const payload = toSubmitPayload(row);

    // 这一条是"留空 = 保留原密钥"契约的实现基础：字段一旦出现（哪怕是空串），
    // 后端就可能把用户已存的密钥覆盖掉。
    assert.equal('clientSecret' in payload, false, '留空时 clientSecret 不能出现在载荷里');
    assert.equal(JSON.stringify(payload).includes('clientSecret'), false);
});

test('toSubmitPayload：纯空白 clientSecret 同样视为留空', async () => {
    const { toSubmitPayload, createEmptyOidcProviderRow } = await loadSettings();
    const row = { ...createEmptyOidcProviderRow(), name: 'K', issuerUrl: 'https://kc.test', clientId: 'c', clientSecret: '   ' };
    assert.equal('clientSecret' in toSubmitPayload(row), false);
});

test('toSubmitPayload：clientSecret 非空时提交 trim 后的值', async () => {
    const { toSubmitPayload, createEmptyOidcProviderRow } = await loadSettings();
    const row = { ...createEmptyOidcProviderRow(), name: 'K', issuerUrl: 'https://kc.test', clientId: 'c', clientSecret: '  s3cret  ' };
    assert.equal(toSubmitPayload(row).clientSecret, 's3cret');
});

test('toSubmitPayload：新建行不提交 id，编辑行提交原 id', async () => {
    const { toSubmitPayload, createEmptyOidcProviderRow, toFormRow } = await loadSettings();

    const newRow = { ...createEmptyOidcProviderRow(), name: 'K', issuerUrl: 'https://kc.test', clientId: 'c', clientSecret: 's' };
    assert.equal('id' in toSubmitPayload(newRow), false, '新建行的 id 必须由后端生成');

    const editRow = toFormRow({
        id: 'existing-id', name: 'K', enabled: true, issuerUrl: 'https://kc.test', clientId: 'c',
        scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
        createdAt: 1, hasClientSecret: true,
    });
    assert.equal(toSubmitPayload(editRow).id, 'existing-id');
});

test('toSubmitPayload：issuerUrl 去尾部斜杠、scopes 空回退默认值', async () => {
    const { toSubmitPayload, createEmptyOidcProviderRow, DEFAULT_OIDC_SCOPES } = await loadSettings();
    const row = {
        ...createEmptyOidcProviderRow(),
        name: 'K', issuerUrl: '  https://kc.test/realms/r///  ', clientId: 'c',
        clientSecret: 's', scopes: '',
    };
    const payload = toSubmitPayload(row);
    assert.equal(payload.issuerUrl, 'https://kc.test/realms/r');
    assert.equal(payload.scopes, DEFAULT_OIDC_SCOPES);
});

test('toSubmitPayload：文本字段一律 trim', async () => {
    const { toSubmitPayload, createEmptyOidcProviderRow } = await loadSettings();
    const row = {
        ...createEmptyOidcProviderRow(),
        name: '  Keycloak  ', issuerUrl: 'https://kc.test', clientId: '  cid  ',
        clientSecret: 's', scopes: '  openid  ', allowedEmailDomains: '  example.com  ',
        iconUrl: '  https://kc.test/i.png  ',
    };
    const payload = toSubmitPayload(row);
    assert.equal(payload.name, 'Keycloak');
    assert.equal(payload.clientId, 'cid');
    assert.equal(payload.scopes, 'openid');
    assert.equal(payload.allowedEmailDomains, 'example.com');
    assert.equal(payload.iconUrl, 'https://kc.test/i.png');
});

// --- validateRow ---

test('validateRow：必填项逐个校验，合法行返回 null', async () => {
    const { validateRow, createEmptyOidcProviderRow } = await loadSettings();
    const base = { ...createEmptyOidcProviderRow(), name: 'K', issuerUrl: 'https://kc.test', clientId: 'c', clientSecret: 's' };
    assert.equal(validateRow(base), null);

    assert.equal(validateRow({ ...base, name: '' }), 'settings.oidc.error.nameRequired');
    assert.equal(validateRow({ ...base, name: '   ' }), 'settings.oidc.error.nameRequired');
    assert.equal(validateRow({ ...base, issuerUrl: '' }), 'settings.oidc.error.issuerRequired');
    assert.equal(validateRow({ ...base, clientId: '  ' }), 'settings.oidc.error.clientIdRequired');
});

test('validateRow：新建行必须填密钥，编辑行留空表示保留', async () => {
    const { validateRow, createEmptyOidcProviderRow, toFormRow } = await loadSettings();
    const newRow = { ...createEmptyOidcProviderRow(), name: 'K', issuerUrl: 'https://kc.test', clientId: 'c', clientSecret: '' };
    assert.equal(validateRow(newRow), 'settings.oidc.error.clientSecretRequired');

    const editRow = { ...toFormRow({
        id: 'p1', name: 'K', enabled: true, issuerUrl: 'https://kc.test', clientId: 'c',
        scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
        createdAt: 1, hasClientSecret: true,
    }) };
    assert.equal(editRow.clientSecret, '');
    assert.equal(validateRow(editRow), null, '编辑行留空密钥应通过校验');
});

// --- resolveOidcNotice ---

test('resolveOidcNotice：?oidc= 只认 bound / conflict', async () => {
    const { resolveOidcNotice, OIDC_NOTICE_MAP } = await loadNotice();
    assert.deepEqual(resolveOidcNotice({ oidc: 'bound' }), { key: 'settings.oidc.notice.bound', type: 'success' });
    assert.deepEqual(resolveOidcNotice({ oidc: 'conflict' }), { key: 'settings.oidc.notice.conflict', type: 'error' });
    // 不认识的取值不能误报成功
    assert.equal(resolveOidcNotice({ oidc: 'whatever' }), null);
    assert.equal(resolveOidcNotice({ oidc: '' }), null);
    assert.equal(resolveOidcNotice({}), null);
    assert.deepEqual(Object.keys(OIDC_NOTICE_MAP).sort(), ['bound', 'conflict']);
});

test('resolveOidcNotice：8 个错误码全部映射到非 fallback 的键', async () => {
    const { resolveOidcNotice, OIDC_ERROR_MAP, OIDC_ERROR_FALLBACK_KEY } = await loadNotice();
    const codes = [
        'state_mismatch', 'token_exchange_failed', 'invalid_id_token', 'provider_not_found',
        'provider_disabled', 'not_linked', 'conflict', 'server_error',
    ] as const;
    assert.equal(codes.length, 8, '契约 §3.1 的错误码集合必须恰好是这 8 个');
    assert.deepEqual(Object.keys(OIDC_ERROR_MAP).sort(), [...codes].sort(), '映射表必须与契约全集一一对应');

    for (const code of codes) {
        const hit = resolveOidcNotice({ oidc_error: code });
        assert.equal(hit?.type, 'error', `${code} 必须是 error 级提示`);
        assert.equal(hit?.key, OIDC_ERROR_MAP[code]);
        assert.notEqual(hit?.key, OIDC_ERROR_FALLBACK_KEY, `${code} 不应落到 fallback`);
    }
});

test('resolveOidcNotice：未知错误码走兜底键，空值返回 null', async () => {
    const { resolveOidcNotice, OIDC_ERROR_FALLBACK_KEY } = await loadNotice();
    assert.deepEqual(resolveOidcNotice({ oidc_error: 'some_new_code' }), { key: OIDC_ERROR_FALLBACK_KEY, type: 'error' });
    assert.equal(resolveOidcNotice({ oidc_error: '' }), null);
    assert.equal(resolveOidcNotice({ oidc_error: 123 }), null);
    assert.equal(resolveOidcNotice({ oidc_error: null }), null);
});

test('resolveOidcNotice：query 值为数组时取第一个元素（vue-router 可重复参数）', async () => {
    const { resolveOidcNotice } = await loadNotice();
    assert.deepEqual(resolveOidcNotice({ oidc: ['bound', 'conflict'] }), { key: 'settings.oidc.notice.bound', type: 'success' });
    assert.deepEqual(resolveOidcNotice({ oidc_error: ['not_linked'] }), { key: 'login.oidcError.notLinked', type: 'error' });
});

test('resolveOidcNotice：oidc 优先于 oidc_error', async () => {
    const { resolveOidcNotice } = await loadNotice();
    assert.deepEqual(
        resolveOidcNotice({ oidc: 'bound', oidc_error: 'server_error' }),
        { key: 'settings.oidc.notice.bound', type: 'success' },
    );
    // oidc 不认识时仍应继续看 oidc_error
    assert.deepEqual(
        resolveOidcNotice({ oidc: 'nope', oidc_error: 'server_error' }),
        { key: 'login.oidcError.serverError', type: 'error' },
    );
});

// --- stripOidcQuery ---

// --- 回归：映射表的原型链污染（曾是一个真实缺陷，已修） ---

/**
 * 回归测试。`OIDC_NOTICE_MAP` / `OIDC_ERROR_MAP` 是普通对象字面量，用下标查找时会命中
 * 原型链上的键：`?oidc_error=constructor` 时 `OIDC_ERROR_MAP['constructor']` 返回
 * `Object` 构造函数而不是 `undefined`，`?? OIDC_ERROR_FALLBACK_KEY` 不生效，返回
 * `{ key: <function>, type: 'error' }`；`useOidcNotice` 再把这个非字符串 key 交给 `t()`，
 * vue-i18n 对 object 类型的 key 直接抛 `SyntaxError: Invalid arguments`（function 类型则
 * 静默返回 undefined，用户看不到任何文案）。
 *
 * 可达路径不是理论推演：两个视图都挂了该 composable（LoginView.vue:116 /
 * SettingsView.vue:143），而 `?oidc_error=` 是后端失败时**直接 302 拼出来**的
 * （oidc.controller.ts:46），用户可以把 URL 里的码改成任意字符串。
 *
 * 修法：查找前用 `Object.hasOwn(MAP, k)` 做自有键判定（已在 useOidcNotice.ts 落地）。
 */
test('回归：?oidc_error / ?oidc= 传入原型链键名时必须走兜底而非命中原型', async () => {
    const { resolveOidcNotice, OIDC_ERROR_FALLBACK_KEY } = await loadNotice();
    for (const protoKey of ['constructor', 'toString', '__proto__']) {
        const hit = resolveOidcNotice({ oidc_error: protoKey });
        assert.equal(hit?.key, OIDC_ERROR_FALLBACK_KEY, `oidc_error=${protoKey} 应落到兜底键`);
    }
    // ?oidc= 侧同样会命中：返回的是函数/对象，而不是 null
    for (const protoKey of ['constructor', '__proto__']) {
        assert.equal(resolveOidcNotice({ oidc: protoKey }), null, `oidc=${protoKey} 应返回 null`);
    }
});

test('stripOidcQuery：剔除 oidc/oidc_error，保留其它参数，不改原对象', async () => {
    const { stripOidcQuery } = await loadNotice();
    const original = { tab: 'security', oidc: 'bound', oidc_error: 'server_error', page: '2' };
    const cleaned = stripOidcQuery(original);

    assert.deepEqual(cleaned, { tab: 'security', page: '2' });
    assert.deepEqual(original, { tab: 'security', oidc: 'bound', oidc_error: 'server_error', page: '2' }, '不得修改入参');
});

test('stripOidcQuery：数组值过滤成纯字符串数组，null 保留', async () => {
    const { stripOidcQuery } = await loadNotice();
    const cleaned = stripOidcQuery({ tags: ['a', 'b'], empty: null, mixed: ['x', 1, 'y'] });
    assert.deepEqual(cleaned, { tags: ['a', 'b'], empty: null, mixed: ['x', 'y'] });
});

test('stripOidcQuery：没有 OIDC 参数时原样返回', async () => {
    const { stripOidcQuery } = await loadNotice();
    assert.deepEqual(stripOidcQuery({ tab: 'security' }), { tab: 'security' });
    assert.deepEqual(stripOidcQuery({}), {});
});
