import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * OIDC 后端纯函数 / 配置收敛单测。
 *
 * ## 为什么这里有一个 loader 钩子
 *
 * `oidc.service.ts` 顶层 import 了 `settings/settings.repository`，而后者会一路拉进
 * `database/connection` → `schema.registry` → `terminal-theme.repository` →
 * `types/terminal-theme.types`。在仓库既有的 `node --experimental-strip-types --test`
 * 口径下这条链**根本加载不了**（两个都是仓库里早就存在的既有限制，不是 OIDC 引入的）：
 *
 *   1. `types/terminal-theme.types.ts` 只导出 interface/type，strip-types 会把文件体抹成空，
 *      于是 `import { CreateTerminalThemeDto }` 在运行时报
 *      "does not provide an export named 'CreateTerminalThemeDto'"；
 *   2. `import { Database } from 'sqlite3'` 的具名导入在 CJS 互操作下拿不到 `Database`。
 *
 * 这两条都不是本任务该改的源码（且任务硬约束禁止改既有文件），所以测试侧用
 * `module.registerHooks` 做两件事：**补相对导入的 `.ts` 扩展名**，并把
 * `settings.repository` 换成内存桩。被替换的只是一个 key/value 存取器，被测的
 * `saveProviders` / `coerceProvider` / `toPublicConfig` 逻辑全部是真实源码。
 *
 * 钩子必须在任何相对导入**之前**同步注册；因此下面所有源码都走动态 `import()`，
 * 测试本身仍在模块顶层同步注册（不依赖 top-level await）。
 */

/** 内存设置表：桩模块通过 globalThis 共享，避免 data: 模块无法闭包捕获局部变量 */
const settingsStore = new Map<string, string>();
(globalThis as unknown as { __oidcSettingsStore: Map<string, string> }).__oidcSettingsStore = settingsStore;

const SETTINGS_STUB = `
export const settingsRepository = {
    async getSetting(key) { return globalThis.__oidcSettingsStore.get(key) ?? null; },
    async setSetting(key, value) { globalThis.__oidcSettingsStore.set(key, value); },
};
`;
const SETTINGS_STUB_URL = `data:text/javascript,${encodeURIComponent(SETTINGS_STUB)}`;

registerHooks({
    resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) {
        // 只替换 OIDC 服务用到的那一个设置仓储
        if (specifier.includes('settings.repository')) {
            return { url: SETTINGS_STUB_URL, shortCircuit: true };
        }
        // 源码里的相对导入一律省略扩展名（tsc NodeNext 才要求写全），补 .ts / /index.ts
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

const loadService = () => import('../src/oidc/oidc.service.ts');
const loadErrors = () => import('../src/oidc/oidc.errors.ts');

/** 32 字节 hex，`utils/crypto.ts` 的 encrypt/decrypt 需要它 */
const TEST_ENCRYPTION_KEY = 'ab'.repeat(32);

// --- issuerUrl / scopes 归一化 ---

test('normalizeIssuerUrl：去掉尾部斜杠与空白，非字符串安全降级为空串', async () => {
    const { normalizeIssuerUrl } = await loadService();
    assert.equal(normalizeIssuerUrl('https://kc.example.com/realms/myrealm'), 'https://kc.example.com/realms/myrealm');
    assert.equal(normalizeIssuerUrl('https://kc.example.com/realms/myrealm/'), 'https://kc.example.com/realms/myrealm');
    assert.equal(normalizeIssuerUrl('https://kc.example.com/realms/myrealm///'), 'https://kc.example.com/realms/myrealm');
    assert.equal(normalizeIssuerUrl('  https://kc.example.com/realms/myrealm/  '), 'https://kc.example.com/realms/myrealm');
    // 只砍尾部斜杠，不能碰路径中间的
    assert.equal(normalizeIssuerUrl('https://host/a/b/'), 'https://host/a/b');
    assert.equal(normalizeIssuerUrl(''), '');
    assert.equal(normalizeIssuerUrl(undefined), '');
    assert.equal(normalizeIssuerUrl(null), '');
    assert.equal(normalizeIssuerUrl(42), '42');
});

test('normalizeOidcScopes：空值回退契约默认值，非空原样保留', async () => {
    const { normalizeOidcScopes, DEFAULT_OIDC_SCOPES } = await loadService();
    assert.equal(DEFAULT_OIDC_SCOPES, 'openid profile email');
    assert.equal(normalizeOidcScopes(''), DEFAULT_OIDC_SCOPES);
    assert.equal(normalizeOidcScopes('   '), DEFAULT_OIDC_SCOPES);
    assert.equal(normalizeOidcScopes(undefined), DEFAULT_OIDC_SCOPES);
    assert.equal(normalizeOidcScopes(null), DEFAULT_OIDC_SCOPES);
    assert.equal(normalizeOidcScopes('openid'), 'openid');
    assert.equal(normalizeOidcScopes('  openid groups  '), 'openid groups');
});

// --- 邮箱域名白名单（安全边界） ---

test('isEmailDomainAllowed：白名单为空 = 不限制', async () => {
    const { isEmailDomainAllowed } = await loadService();
    assert.equal(isEmailDomainAllowed('anyone@wherever.test', ''), true);
    assert.equal(isEmailDomainAllowed('anyone@wherever.test', undefined), true);
    assert.equal(isEmailDomainAllowed('anyone@wherever.test', null), true);
    // 只有逗号/空白 = 空白名单
    assert.equal(isEmailDomainAllowed('anyone@wherever.test', ' , , '), true);
    // 不限制时邮箱缺失也放行（没有规则可违反）
    assert.equal(isEmailDomainAllowed(null, ''), true);
});

test('isEmailDomainAllowed：精确域名匹配，刻意不做子域通配', async () => {
    const { isEmailDomainAllowed } = await loadService();
    assert.equal(isEmailDomainAllowed('alice@example.com', 'example.com'), true);
    // 这条是白名单的核心安全语义：endsWith 式的隐式通配会把边界悄悄放大
    assert.equal(isEmailDomainAllowed('alice@sub.example.com', 'example.com'), false);
    assert.equal(isEmailDomainAllowed('alice@notexample.com', 'example.com'), false);
    assert.equal(isEmailDomainAllowed('alice@example.com.evil.test', 'example.com'), false);
    // 管理员显式列出子域才放行
    assert.equal(isEmailDomainAllowed('alice@sub.example.com', 'example.com,sub.example.com'), true);
});

test('isEmailDomainAllowed：大小写与空白归一', async () => {
    const { isEmailDomainAllowed } = await loadService();
    assert.equal(isEmailDomainAllowed('Alice@EXAMPLE.com', 'example.com'), true);
    assert.equal(isEmailDomainAllowed('alice@example.com', ' EXAMPLE.COM '), true);
    assert.equal(isEmailDomainAllowed('alice@example.com', 'other.test, example.com ,third.test'), true);
});

test('isEmailDomainAllowed：白名单非空但邮箱缺失/畸形一律拒绝', async () => {
    const { isEmailDomainAllowed } = await loadService();
    // 无法验证的账号不应被自动创建
    assert.equal(isEmailDomainAllowed(null, 'example.com'), false);
    assert.equal(isEmailDomainAllowed(undefined, 'example.com'), false);
    assert.equal(isEmailDomainAllowed('', 'example.com'), false);
    assert.equal(isEmailDomainAllowed('no-at-sign', 'example.com'), false);
    assert.equal(isEmailDomainAllowed('trailing@', 'example.com'), false);
    assert.equal(isEmailDomainAllowed('@example.com', 'example.com'), true); // 空 local-part 但域名合法
    assert.equal(isEmailDomainAllowed('weird@sub@example.com', 'example.com'), true); // 取最后一个 @
});

// --- 用户名推导 ---

test('sanitizeOidcUsername：收窄字符集、去前导分隔符、截断 32 字符', async () => {
    const { sanitizeOidcUsername } = await loadService();
    assert.equal(sanitizeOidcUsername('alice'), 'alice');
    assert.equal(sanitizeOidcUsername('alice.smith-01_ok'), 'alice.smith-01_ok');
    assert.equal(sanitizeOidcUsername('al ice@example.com'), 'aliceexample.com'); // 空格与 @ 被抹掉，`.` 保留
    assert.equal(sanitizeOidcUsername('...alice'), 'alice');
    assert.equal(sanitizeOidcUsername('_-alice'), 'alice');
    assert.equal(sanitizeOidcUsername('a'.repeat(40)).length, 32);
    assert.equal(sanitizeOidcUsername(''), '');
    assert.equal(sanitizeOidcUsername(undefined), '');
    // NFKC 归一：全角字母先折叠成半角再清洗
    assert.equal(sanitizeOidcUsername('ａｌｉｃｅ'), 'alice');
});

test('suggestOidcUsername：邮箱 local-part 优先，退化到 oidc-<sub 前 8 位>', async () => {
    const { suggestOidcUsername } = await loadService();
    assert.equal(suggestOidcUsername({ subject: 'abc', email: 'alice@example.com' }), 'alice');
    // 注意 `.` 是合法字符，只有 `+` 被抹掉
    assert.equal(suggestOidcUsername({ subject: 'abc', email: 'alice.smith+tag@example.com' }), 'alice.smithtag');
    // 无邮箱 → 用 subject 前 8 位
    assert.equal(suggestOidcUsername({ subject: '0123456789abcdef', email: null }), 'oidc-01234567');
    assert.equal(suggestOidcUsername({ subject: 'short', email: null }), 'oidc-short');
    // 邮箱存在但 local-part 清洗后为空 → 也退到 subject
    assert.equal(suggestOidcUsername({ subject: 'sub12345', email: '@example.com' }), 'oidc-sub12345');
    // subject 也空 → 拼出的是 'oidc-'（清洗后非空），不会走到随机兜底
    assert.equal(suggestOidcUsername({ subject: '', email: null }), 'oidc-');
    // 邮箱有 @ 且 local-part 只由前导分隔符组成（清洗后为空）、subject 也空 → 才掉到随机分支
    const random = suggestOidcUsername({ subject: '', email: '..@example.com' });
    assert.match(random, /^oidc-[0-9a-f]{4}$/);
});

// --- coerceProvider：落库/读回的兜底值 ---

test('coerceProvider：缺字段时布尔开关一律为 false，不把真值字符串当 true', async () => {
    const { coerceProvider } = await loadService();
    const empty = coerceProvider({});
    assert.equal(empty.enabled, false);
    assert.equal(empty.autoCreateUser, false);
    assert.equal(typeof empty.id, 'string');
    assert.ok(empty.id.length > 0);
    assert.equal(empty.name, '');
    assert.equal(empty.issuerUrl, '');
    assert.equal(empty.clientId, '');
    assert.equal(empty.clientSecret, '');
    assert.equal(empty.allowedEmailDomains, '');
    assert.equal(empty.iconUrl, '');

    // 严格 === true：字符串/数字不能把 provider 打开
    assert.equal(coerceProvider({ enabled: 'true' }).enabled, false);
    assert.equal(coerceProvider({ enabled: 1 }).enabled, false);
    assert.equal(coerceProvider({ enabled: true }).enabled, true);
    assert.equal(coerceProvider({ autoCreateUser: 'yes' }).autoCreateUser, false);
    assert.equal(coerceProvider({ autoCreateUser: true }).autoCreateUser, true);
});

test('coerceProvider：归一化 issuerUrl/scopes，保留显式字段', async () => {
    const { coerceProvider, DEFAULT_OIDC_SCOPES } = await loadService();
    const p = coerceProvider({
        id: 'fixed-id',
        name: 'Keycloak',
        enabled: true,
        issuerUrl: 'https://kc.example.com/realms/r///',
        clientId: 'cid',
        clientSecret: 'cipher-text',
        scopes: 'openid',
        autoCreateUser: true,
        allowedEmailDomains: 'example.com',
        iconUrl: 'https://kc.example.com/icon.png',
        createdAt: 1700000000,
    });
    assert.equal(p.id, 'fixed-id');
    assert.equal(p.issuerUrl, 'https://kc.example.com/realms/r');
    assert.equal(p.scopes, 'openid');
    assert.equal(p.createdAt, 1700000000);
    assert.equal(coerceProvider({ scopes: '' }).scopes, DEFAULT_OIDC_SCOPES);
});

test('coerceProvider：createdAt 非法时回退到当前秒', async () => {
    const { coerceProvider } = await loadService();
    const before = Math.floor(Date.now() / 1000);
    for (const bad of [0, -1, NaN, Infinity, 'abc', null, undefined, {}]) {
        const p = coerceProvider({ createdAt: bad });
        assert.ok(p.createdAt >= before && p.createdAt <= before + 5, `createdAt 未回退：${String(bad)}`);
    }
    // 合法但带小数 → 向下取整
    assert.equal(coerceProvider({ createdAt: 1700000000.9 }).createdAt, 1700000000);
});

// --- toPublicConfig：密钥不外泄的唯一出口 ---

test('toPublicConfig：clientSecret 必须整个字段消失，只留 hasClientSecret', async () => {
    const { toPublicConfig, coerceProvider } = await loadService();
    const publicConfig = toPublicConfig(coerceProvider({
        id: 'p1', name: 'Keycloak', enabled: true, issuerUrl: 'https://kc.example.com',
        clientId: 'cid', clientSecret: 'super-secret-ciphertext', scopes: 'openid',
        autoCreateUser: true, allowedEmailDomains: 'example.com', iconUrl: '', createdAt: 1700000000,
    }));

    assert.equal('clientSecret' in publicConfig, false, 'clientSecret 绝不能出现在回给前端的对象里');
    assert.equal(JSON.stringify(publicConfig).includes('super-secret-ciphertext'), false);
    assert.equal(publicConfig.hasClientSecret, true);
    // 其余字段原样透传
    assert.equal(publicConfig.id, 'p1');
    assert.equal(publicConfig.name, 'Keycloak');
    assert.equal(publicConfig.enabled, true);
    assert.equal(publicConfig.issuerUrl, 'https://kc.example.com');
    assert.equal(publicConfig.clientId, 'cid');
    assert.equal(publicConfig.scopes, 'openid');
    assert.equal(publicConfig.autoCreateUser, true);
    assert.equal(publicConfig.allowedEmailDomains, 'example.com');
    assert.equal(publicConfig.createdAt, 1700000000);
});

test('toPublicConfig：空密钥 → hasClientSecret 为 false', async () => {
    const { toPublicConfig, coerceProvider } = await loadService();
    assert.equal(toPublicConfig(coerceProvider({ clientSecret: '' })).hasClientSecret, false);
    assert.equal(toPublicConfig(coerceProvider({})).hasClientSecret, false);
});

// --- saveProviders：密钥留空 = 保留原值（契约 §1.3） ---

test('saveProviders：新建 provider 生成 id、加密落库、回包不含密钥', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    const result = await oidcService.saveProviders([{
        name: 'Keycloak',
        enabled: true,
        issuerUrl: 'https://kc.example.com/realms/myrealm/',
        clientId: 'nexus-terminal',
        clientSecret: 'super-secret',
        scopes: '',
        autoCreateUser: true,
        allowedEmailDomains: 'example.com',
        iconUrl: '',
    }]);

    assert.equal(result.length, 1);
    assert.equal(typeof result[0].id, 'string');
    assert.ok(result[0].id.length > 0);
    assert.equal(result[0].hasClientSecret, true);
    assert.equal('clientSecret' in result[0], false);
    // 归一化生效
    assert.equal(result[0].issuerUrl, 'https://kc.example.com/realms/myrealm');
    assert.equal(result[0].scopes, 'openid profile email');

    // 落库的是密文，明文不得出现在 settings 表里
    const raw = settingsStore.get('oidcProviders');
    assert.ok(typeof raw === 'string' && raw.length > 0, 'oidcProviders 应已写入设置表');
    assert.equal(raw.includes('super-secret'), false, '明文密钥绝不能落库');
    // 读回时能解出明文，证明加密可逆
    const decrypted = await oidcService.getProviders();
    assert.equal(decrypted[0].clientSecret, 'super-secret');
});

test('saveProviders：clientSecret 留空/缺省 → 保留原密钥，不静默清空', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    const [created] = await oidcService.saveProviders([{
        name: 'Keycloak', enabled: true, issuerUrl: 'https://kc.example.com',
        clientId: 'cid', clientSecret: 'original-secret', scopes: 'openid',
        autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
    }]);
    // saveProviders 是全量替换，每次都会把整个数组重新序列化；所以只比密钥密文本身，
    // 不能拿整段 JSON 去比（其它字段本来就被这次保存改掉了）。
    const originalCipher = (JSON.parse(settingsStore.get('oidcProviders')!) as Array<{ clientSecret: string }>)[0].clientSecret;
    assert.ok(originalCipher.length > 0);

    // 三种"不修改密钥"的写法都必须保留原值
    for (const secret of ['', undefined, null] as const) {
        const [updated] = await oidcService.saveProviders([{
            id: created.id, name: 'Keycloak 改名', enabled: false, issuerUrl: 'https://kc.example.com/',
            clientId: 'cid', clientSecret: secret as never, scopes: 'openid',
            autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
        }]);
        assert.equal(updated.id, created.id, 'id 创建后不可变');
        assert.equal(updated.createdAt, created.createdAt, 'createdAt 不可变');
        assert.equal(updated.name, 'Keycloak 改名', '其它字段应正常更新');
        assert.equal(updated.enabled, false);
        assert.equal(updated.hasClientSecret, true, `留空(${String(secret)})后仍应保留密钥`);
        const storedCipher = (JSON.parse(settingsStore.get('oidcProviders')!) as Array<{ clientSecret: string }>)[0].clientSecret;
        assert.equal(storedCipher, originalCipher, '密钥密文本身不应被改写');
    }

    const decrypted = await oidcService.getProviders();
    assert.equal(decrypted[0].clientSecret, 'original-secret');
});

test('saveProviders：显式非空 clientSecret 才覆盖原密钥', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    const [created] = await oidcService.saveProviders([{
        name: 'K', enabled: true, issuerUrl: 'https://kc.example.com', clientId: 'cid',
        clientSecret: 'first-secret', scopes: 'openid', autoCreateUser: false,
        allowedEmailDomains: '', iconUrl: '',
    }]);
    await oidcService.saveProviders([{
        id: created.id, name: 'K', enabled: true, issuerUrl: 'https://kc.example.com', clientId: 'cid',
        clientSecret: 'second-secret', scopes: 'openid', autoCreateUser: false,
        allowedEmailDomains: '', iconUrl: '',
    }]);

    const decrypted = await oidcService.getProviders();
    assert.equal(decrypted[0].clientSecret, 'second-secret');
    assert.equal(settingsStore.get('oidcProviders')!.includes('second-secret'), false);
});

test('saveProviders：新建行留空密钥 → hasClientSecret 为 false（后端不替前端兜底）', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    const [created] = await oidcService.saveProviders([{
        name: 'K', enabled: true, issuerUrl: 'https://kc.example.com', clientId: 'cid',
        clientSecret: '', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
    }]);
    assert.equal(created.hasClientSecret, false);
});

test('saveProviders：全量替换会删掉未提交的 provider', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    const created = await oidcService.saveProviders([
        { name: 'A', enabled: true, issuerUrl: 'https://a.test', clientId: 'a', clientSecret: 'sa', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '' },
        { name: 'B', enabled: true, issuerUrl: 'https://b.test', clientId: 'b', clientSecret: 'sb', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '' },
    ]);
    assert.equal(created.length, 2);

    const kept = await oidcService.saveProviders([{
        id: created[1].id, name: 'B', enabled: true, issuerUrl: 'https://b.test', clientId: 'b',
        clientSecret: '', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '',
    }]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, created[1].id);
    // A 的密钥也应随之消失
    const stored = JSON.parse(settingsStore.get('oidcProviders')!);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, created[1].id);
});

// --- 读取路径的容错与过滤 ---

test('getStoredProviders：设置项不是合法 JSON / 不是数组时按空列表处理', async () => {
    const { oidcService } = await loadService();
    settingsStore.clear();

    assert.deepEqual(await oidcService.getStoredProviders(), []);
    settingsStore.set('oidcProviders', '{ not json');
    assert.deepEqual(await oidcService.getStoredProviders(), []);
    settingsStore.set('oidcProviders', '{"providers":[]}');
    assert.deepEqual(await oidcService.getStoredProviders(), []);
    settingsStore.set('oidcProviders', '"a string"');
    assert.deepEqual(await oidcService.getStoredProviders(), []);
});

test('getEnabledProviderSummaries：只回 enabled 的 provider，且只暴露 id/name/iconUrl', async () => {
    const { oidcService } = await loadService();
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    settingsStore.clear();

    await oidcService.saveProviders([
        { name: 'On', enabled: true, issuerUrl: 'https://on.test', clientId: 'on', clientSecret: 's1', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: 'https://on.test/i.png' },
        { name: 'Off', enabled: false, issuerUrl: 'https://off.test', clientId: 'off', clientSecret: 's2', scopes: 'openid', autoCreateUser: false, allowedEmailDomains: '', iconUrl: '' },
    ]);

    const summaries = await oidcService.getEnabledProviderSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].name, 'On');
    assert.deepEqual(Object.keys(summaries[0]).sort(), ['iconUrl', 'id', 'name']);
    assert.equal(JSON.stringify(summaries).includes('s1'), false);

    const names = await oidcService.getProviderNameMap();
    assert.equal(names.get(summaries[0].id), 'On');
    assert.equal(names.size, 2);
});

// --- 协议错误 → 契约错误码映射 ---

test('mapAuthorizationCodeGrantError：已是 OidcError 时原样透传', async () => {
    const { mapAuthorizationCodeGrantError } = await loadService();
    const { OidcError } = await loadErrors();
    const original = new OidcError('not_linked', '未绑定');
    assert.equal(mapAuthorizationCodeGrantError(original), original);
});

test('mapAuthorizationCodeGrantError：state 校验失败 → state_mismatch', async () => {
    const { mapAuthorizationCodeGrantError } = await loadService();
    const err = new Error('unexpected "state" response parameter value');
    assert.equal(mapAuthorizationCodeGrantError(err).code, 'state_mismatch');
});

test('mapAuthorizationCodeGrantError：state 被整个剥离（CSRF 形态）也必须 → state_mismatch', async () => {
    // oauth4webapi 对 state 缺失抛的是 'response parameter "state" missing'，
    // 词序与「值被篡改」的 'unexpected "state" response parameter value' 相反。
    // 只匹配前者的实现会把 state 缺失误报成 token_exchange_failed（安全相关的码错误）。
    const { mapAuthorizationCodeGrantError } = await loadService();
    const err = new Error('response parameter "state" missing');
    assert.equal(mapAuthorizationCodeGrantError(err).code, 'state_mismatch');
});

test('mapAuthorizationCodeGrantError：id_token 相关 OAUTH_* 码 → invalid_id_token', async () => {
    const { mapAuthorizationCodeGrantError } = await loadService();
    for (const code of [
        'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
        'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
        'OAUTH_KEY_SELECTION_FAILED',
        'OAUTH_PARSE_ERROR',
    ]) {
        const err = Object.assign(new Error('jwt check failed'), { code });
        assert.equal(mapAuthorizationCodeGrantError(err).code, 'invalid_id_token', `code=${code} 应映射为 invalid_id_token`);
    }
});

test('mapAuthorizationCodeGrantError：OAUTH_INVALID_RESPONSE 按文案细分', async () => {
    const { mapAuthorizationCodeGrantError } = await loadService();
    const noCode = Object.assign(new Error('response is missing the "authorization code"'), { code: 'OAUTH_INVALID_RESPONSE' });
    assert.equal(mapAuthorizationCodeGrantError(noCode).code, 'token_exchange_failed');

    const badJwt = Object.assign(new Error('ID Token is invalid'), { code: 'OAUTH_INVALID_RESPONSE' });
    assert.equal(mapAuthorizationCodeGrantError(badJwt).code, 'invalid_id_token');
});

test('mapAuthorizationCodeGrantError：未知异常一律 token_exchange_failed，不泄露内部细节', async () => {
    const { mapAuthorizationCodeGrantError } = await loadService();
    assert.equal(mapAuthorizationCodeGrantError(new Error('socket hang up')).code, 'token_exchange_failed');
    assert.equal(mapAuthorizationCodeGrantError('a string').code, 'token_exchange_failed');
    assert.equal(mapAuthorizationCodeGrantError(undefined).code, 'token_exchange_failed');
    assert.equal(mapAuthorizationCodeGrantError(null).code, 'token_exchange_failed');
    assert.equal(mapAuthorizationCodeGrantError({ code: 'ECONNREFUSED' }).code, 'token_exchange_failed');
});

// --- 错误码封闭联合 ---

test('OidcError：name/code/message 正确，缺省 message 用 code 兜底', async () => {
    const { OidcError } = await loadErrors();
    const withMessage = new OidcError('state_mismatch', '状态不匹配');
    assert.equal(withMessage.name, 'OidcError');
    assert.equal(withMessage.code, 'state_mismatch');
    assert.equal(withMessage.message, '状态不匹配');
    assert.ok(withMessage instanceof Error);

    const bare = new OidcError('server_error');
    assert.equal(bare.message, 'server_error');
});

test('toOidcErrorCode：OidcError 保留码，其余一律 server_error', async () => {
    const { toOidcErrorCode, OidcError } = await loadErrors();
    const codes = [
        'state_mismatch', 'token_exchange_failed', 'invalid_id_token', 'provider_not_found',
        'provider_disabled', 'not_linked', 'conflict', 'server_error',
    ] as const;
    for (const code of codes) {
        assert.equal(toOidcErrorCode(new OidcError(code)), code);
    }
    assert.equal(codes.length, 8, '契约 §3.1 的错误码集合必须恰好是这 8 个');
    assert.equal(toOidcErrorCode(new Error('boom')), 'server_error');
    assert.equal(toOidcErrorCode('boom'), 'server_error');
    assert.equal(toOidcErrorCode(null), 'server_error');
    // 伪装成 OidcError 的普通对象不算数
    assert.equal(toOidcErrorCode({ name: 'OidcError', code: 'not_linked' }), 'server_error');
});
