/**
 * Проверка адаптера на настоящем YDB: npm run live.
 *
 * Строка подключения — из YDB_CONNECTION_STRING, авторизация — из переменных окружения YDB SDK
 * (YDB_ACCESS_TOKEN_CREDENTIALS=$(yc iam create-token), YDB_METADATA_CREDENTIALS=1 и т.д.).
 * Создаёт встроенные таблицы umbot, если их нет, пишет и удаляет тестовые записи
 * с платформой "umbot-ydb-live-check". Для проверки опции tables создаёт таблицу
 * UmbotYdbLiveCheck и удаляет её в конце. Другие данные не трогает.
 */
const { DB_TABLES_SCHEMA } = require('umbot');
const { YdbAdapter } = require('../dist');

const PLATFORM = 'umbot-ydb-live-check';
const CUSTOM_TABLE = 'UmbotYdbLiveCheck';
const results = [];

const ctx = {
    appConfig: {},
    database: { databaseInfo: {} },
    log: (msg) => console.log(msg),
    logError: (msg) => console.error(msg),
};

const q = (tableName, primaryKeyName, extra = {}) => ({
    tableName,
    primaryKeyName,
    query: null,
    data: null,
    rules: [],
    ...extra,
});

function check(name, ok, details) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(details)}`}`);
}

async function main() {
    if (!process.env.YDB_CONNECTION_STRING) {
        console.error('Задайте YDB_CONNECTION_STRING (и переменные авторизации YDB SDK).');
        process.exit(2);
    }
    const adapter = new YdbAdapter({
        options: {
            credentials: 'environ',
            tables: [
                {
                    tableName: CUSTOM_TABLE,
                    primaryKey: ['id'],
                    columns: {
                        id: 'Utf8',
                        userId: 'Utf8',
                        qty: 'Int64',
                        total: 'Double',
                        paid: 'Bool',
                    },
                    indexes: [['userId']],
                },
            ],
        },
    });
    adapter.init(ctx);
    try {
        check('connect', await adapter.connect());
        check('ensureSchema (создание или проверка)', await adapter.ensureSchema(DB_TABLES_SCHEMA));
        check('ensureSchema (повторно)', await adapter.ensureSchema(DB_TABLES_SCHEMA));

        const userKey = { userId: 'live-1', platform: PLATFORM };
        check(
            'UPSERT пользователя',
            await adapter.insert(
                q('UsersData', 'userId', { data: { ...userKey, meta: null, data: '{"step":1}' } }),
            ),
        );
        let res = await adapter.select(q('UsersData', 'userId'), userKey, true);
        check('SELECT по ключу', res.status && res.data.data === '{"step":1}', res);

        check(
            'UPDATE по составному ключу',
            await adapter.update(
                q('UsersData', 'userId', {
                    query: userKey,
                    data: { ...userKey, data: '{"step":2}' },
                }),
            ),
        );
        res = await adapter.select(q('UsersData', 'userId'), userKey, true);
        check('SELECT после UPDATE', res.status && res.data.data === '{"step":2}', res);

        res = await adapter.select(
            q('UsersData', 'userId'),
            { platform: { $in: [PLATFORM] } },
            false,
        );
        check('SELECT с $in', res.status && res.data.length === 1, res);

        const token = { imageToken: 'live-token-1', path: '/live/check.png', platform: PLATFORM };
        check(
            'UPSERT токена',
            await adapter.insert(q('ImageTokens', 'imageToken', { data: token })),
        );
        res = await adapter.select(
            q('ImageTokens', 'imageToken'),
            { path: token.path, platform: PLATFORM },
            true,
        );
        check(
            'SELECT токена через индекс',
            res.status && res.data.imageToken === token.imageToken,
            res,
        );

        check(
            'DELETE токена',
            await adapter.remove(
                q('ImageTokens', 'imageToken', { query: { imageToken: token.imageToken } }),
            ),
        );
        check(
            'DELETE пользователя',
            await adapter.remove(q('UsersData', 'userId', { query: userKey })),
        );
        res = await adapter.select(q('UsersData', 'userId'), userKey, true);
        check('после DELETE запись не находится', res.status === false && !res.error, res);

        check(
            'UPSERT в свою таблицу (Int64, Double, Bool)',
            await adapter.insert(
                q(CUSTOM_TABLE, 'id', {
                    data: { id: 'o1', userId: 'u1', qty: 3, total: 9.5, paid: true },
                }),
            ),
        );
        res = await adapter.select(q(CUSTOM_TABLE, 'id'), { userId: 'u1', qty: { $gte: 2 } }, true);
        check(
            'SELECT из своей таблицы через индекс',
            res.status && res.data.qty === 3 && res.data.total === 9.5 && res.data.paid === true,
            res,
        );

        const count = await adapter.query(async (sql) => {
            const [[row]] = await sql`SELECT COUNT(*) AS cnt FROM UsersData`;
            return { status: true, data: row };
        });
        check('query() с клиентом SDK', count !== null, count);
        check('isConnected', await adapter.isConnected());
    } finally {
        await adapter
            .query(async (sql) => {
                await sql`DROP TABLE ${sql.identifier(CUSTOM_TABLE)}`;
                return { status: true, data: {} };
            })
            .catch(() => null);
        await adapter.destroy();
    }
    const failed = results.filter((ok) => !ok).length;
    console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
