jest.mock('@ydbjs/value/primitive', () => require('./mockYdbValue').mockPrimitive());
jest.mock('@ydbjs/value/list', () => require('./mockYdbValue').mockList());

interface IMockExecuted {
    text: string;
    params: Record<string, { kind: string; value: unknown }>;
    idempotent?: boolean;
    timeout?: number;
    isolation?: string;
}

interface IMockDriver {
    cs: string;
    opts: Record<string, unknown>;
    closed: boolean;
}

// Состояние моков SDK: фабрики jest.mock видят только переменные с префиксом mock
const mockState = {
    drivers: [] as IMockDriver[],
    readyError: null as Error | null,
    driverError: null as Error | null,
    handler: (_text: string): unknown[][] => [[]],
    executed: [] as IMockExecuted[],
    disposed: 0,
    poolOptions: undefined as unknown,
    environSecure: undefined as unknown,
};

jest.mock('@ydbjs/core', () => ({
    Driver: class {
        cs: string;
        opts: Record<string, unknown>;
        closed = false;
        constructor(cs: string, opts: Record<string, unknown>) {
            if (mockState.driverError) {
                throw mockState.driverError;
            }
            this.cs = cs;
            this.opts = opts;
            mockState.drivers.push(this);
        }
        ready(): Promise<void> {
            return mockState.readyError ? Promise.reject(mockState.readyError) : Promise.resolve();
        }
        close(): void {
            this.closed = true;
        }
    },
}));

jest.mock('@ydbjs/query', () => ({
    query: (_driver: unknown, options?: unknown): unknown => {
        mockState.poolOptions = options;
        const sql = (text: string): unknown => {
            const entry: IMockExecuted = { text, params: {} };
            const q = {
                parameter(name: string, value: { kind: string; value: unknown }): unknown {
                    entry.params[name] = value;
                    return q;
                },
                idempotent(value: boolean): unknown {
                    entry.idempotent = value;
                    return q;
                },
                isolation(mode: string): unknown {
                    entry.isolation = mode;
                    return q;
                },
                timeout(ms: number): unknown {
                    entry.timeout = ms;
                    return q;
                },
                then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown): unknown {
                    mockState.executed.push(entry);
                    return Promise.resolve()
                        .then(() => mockState.handler(entry.text))
                        .then(resolve, reject);
                },
            };
            return q;
        };
        (sql as unknown as Record<symbol, unknown>)[Symbol.asyncDispose] =
            async (): Promise<void> => {
                mockState.disposed++;
            };
        return sql;
    },
}));

jest.mock('@ydbjs/auth/metadata', () => ({
    MetadataCredentialsProvider: class {
        kind = 'metadata';
    },
}));
jest.mock('@ydbjs/auth/anonymous', () => ({
    AnonymousCredentialsProvider: class {
        kind = 'anonymous';
    },
}));
jest.mock('@ydbjs/auth/environ', () => ({
    EnvironCredentialsProvider: class {
        kind = 'environ';
        secureOptions = mockState.environSecure;
        args: unknown[];
        constructor(...args: unknown[]) {
            this.args = args;
        }
    },
}));
jest.mock('@ydbjs/auth/static', () => ({
    StaticCredentialsProvider: class {
        kind = 'static';
        args: unknown[];
        constructor(...args: unknown[]) {
            this.args = args;
        }
    },
}));

import { DB_TABLES_SCHEMA, UsersData } from 'umbot';
import type { AppContext, IAppDB, IQuery } from 'umbot';
import type { CredentialsProvider } from '@ydbjs/auth';
import { YdbAdapter } from '../src';
import type { IYdbAdapterConfig, IYdbOptions, IYdbTableDefinition, TYdbCredentials } from '../src';

const CS = 'grpcs://ydb.serverless.yandexcloud.net:2135/?database=%2Fru-central1%2Fb1g%2Fetn';

interface IMockContext {
    appConfig: { db?: IAppDB };
    database: { adapter?: unknown; databaseInfo: Record<string, unknown> };
    log: jest.Mock;
    logError: jest.Mock;
}

let ctx: IMockContext;
let adapter: YdbAdapter;

const createAdapter = (options?: IYdbAdapterConfig): YdbAdapter => {
    adapter = new YdbAdapter(options);
    adapter.init(ctx as unknown as AppContext);
    return adapter;
};

const connected = async (options: IYdbOptions = {}): Promise<YdbAdapter> => {
    createAdapter({
        host: 'grpcs://ydb.serverless.yandexcloud.net:2135',
        database: '/db',
        options,
    });
    expect(await adapter.connect()).toBe(true);
    mockState.executed = [];
    return adapter;
};

const query = (tableName: string, extra: Partial<IQuery> = {}): IQuery => ({
    tableName,
    primaryKeyName: null,
    query: null,
    data: null,
    rules: [],
    ...extra,
});

const lastDriver = (): IMockDriver => {
    const driver = mockState.drivers[mockState.drivers.length - 1];
    if (!driver) {
        throw new Error('Драйвер не создан');
    }
    return driver;
};

const credentialsKind = (): string =>
    (lastDriver().opts.credentialsProvider as { kind: string }).kind;

beforeEach(() => {
    mockState.drivers = [];
    mockState.readyError = null;
    mockState.driverError = null;
    mockState.handler = () => [[]];
    mockState.executed = [];
    mockState.disposed = 0;
    mockState.poolOptions = undefined;
    mockState.environSecure = undefined;
    delete process.env.YDB_CONNECTION_STRING;
    ctx = {
        appConfig: {},
        database: { databaseInfo: {} },
        log: jest.fn(),
        logError: jest.fn(),
    };
});

afterEach(async () => {
    await adapter?.destroy();
});

describe('connect', () => {
    it('без строки подключения возвращает false и пишет понятную ошибку', async () => {
        createAdapter();
        expect(await adapter.connect()).toBe(false);
        expect(ctx.logError).toHaveBeenCalledWith(
            expect.stringContaining('YDB_CONNECTION_STRING'),
            {},
        );
        expect(mockState.drivers).toHaveLength(0);
    });

    it('собирает строку подключения из host и database', async () => {
        createAdapter({
            host: 'grpcs://ydb.serverless.yandexcloud.net:2135/',
            database: '/ru-central1/b1g/etn',
        });
        expect(await adapter.connect()).toBe(true);
        expect(lastDriver().cs).toBe(CS);
        expect(ctx.log).toHaveBeenCalledWith('YDB: подключение установлено');
    });

    it('options.connectionString важнее host и database', async () => {
        createAdapter({
            host: 'grpc://other:2136',
            database: '/x',
            options: { connectionString: CS },
        });
        await adapter.connect();
        expect(lastDriver().cs).toBe(CS);
    });

    it('берёт параметры из appConfig.db, если в конструктор ничего не передано', async () => {
        ctx.appConfig.db = {
            host: 'grpc://localhost:2136',
            database: '/local',
            options: { queryTimeout: 100 },
        };
        createAdapter();
        await adapter.connect();
        expect(lastDriver().cs).toBe('grpc://localhost:2136/?database=%2Flocal');
    });

    it('только с опциями (без host и database) берёт строку из YDB_CONNECTION_STRING', async () => {
        process.env.YDB_CONNECTION_STRING = CS;
        createAdapter({ options: { credentials: 'metadata' } });
        expect(await adapter.connect()).toBe(true);
        expect(lastDriver().cs).toBe(CS);
        expect(credentialsKind()).toBe('metadata');
    });

    it('без параметров берёт строку из YDB_CONNECTION_STRING', async () => {
        process.env.YDB_CONNECTION_STRING = CS;
        createAdapter();
        expect(await adapter.connect()).toBe(true);
        expect(lastDriver().cs).toBe(CS);
    });

    it('передаёт таймаут подключения и размер пула', async () => {
        await connected({ connectTimeout: 3000, poolSize: 7 });
        expect(lastDriver().opts['ydb.sdk.ready_timeout_ms']).toBe(3000);
        expect(mockState.poolOptions).toEqual({ poolOptions: { maxSize: 7 } });
    });

    it('при ошибке discovery закрывает драйвер и возвращает false', async () => {
        mockState.readyError = new Error('deadline exceeded');
        createAdapter({ host: 'grpc://localhost:2136', database: '/local' });
        expect(await adapter.connect()).toBe(false);
        expect(lastDriver().closed).toBe(true);
        expect(ctx.logError).toHaveBeenCalledWith(
            'YDB: Не удалось подключиться к базе данных: deadline exceeded',
            expect.objectContaining({ error: mockState.readyError }),
        );
        expect(ctx.database.databaseInfo.driver).toBeUndefined();
    });

    it('некорректная строка подключения не бросает исключение', async () => {
        mockState.driverError = new Error('Invalid connection string');
        createAdapter({ host: 'ftp://x', database: '/x' });
        expect(await adapter.connect()).toBe(false);
    });

    it('кладёт драйвер и клиент в databaseInfo', async () => {
        await connected();
        expect(ctx.database.databaseInfo.driver).toBe(lastDriver());
        expect(typeof ctx.database.databaseInfo.sql).toBe('function');
    });

    it('повторный connect закрывает прежний пул и драйвер', async () => {
        await connected();
        const first = lastDriver();
        expect(await adapter.connect()).toBe(true);
        expect(first.closed).toBe(true);
        expect(mockState.disposed).toBe(1);
        expect(mockState.drivers).toHaveLength(2);
    });
});

describe('авторизация', () => {
    const host = { host: 'grpcs://ydb.serverless.yandexcloud.net:2135', database: '/db' };

    it('по умолчанию — из переменных окружения, с их TLS-опциями', async () => {
        mockState.environSecure = { ca: 'pem' };
        createAdapter(host);
        await adapter.connect();
        expect(credentialsKind()).toBe('environ');
        expect(lastDriver().opts.secureOptions).toEqual({ ca: 'pem' });
    });

    it.each(['metadata', 'anonymous'])('credentials: %s', async (kind) => {
        createAdapter({ ...host, options: { credentials: kind as TYdbCredentials } });
        await adapter.connect();
        expect(credentialsKind()).toBe(kind);
    });

    it('свой провайдер передаётся как есть', async () => {
        const provider = { kind: 'custom' } as unknown as CredentialsProvider;
        createAdapter({ ...host, options: { credentials: provider } });
        await adapter.connect();
        expect(lastDriver().opts.credentialsProvider).toBe(provider);
    });

    it('user и pass — логин и пароль YDB, для grpcs с TLS', async () => {
        createAdapter({ ...host, user: 'bot', pass: 'secret' });
        await adapter.connect();
        const provider = lastDriver().opts.credentialsProvider as { kind: string; args: unknown[] };
        expect(provider.kind).toBe('static');
        expect(provider.args).toEqual([
            { username: 'bot', password: 'secret' },
            expect.stringMatching(/^grpcs:/),
            {},
        ]);
    });

    it('для grpc без TLS логин и пароль идут без secureOptions', async () => {
        createAdapter({ host: 'grpc://localhost:2136', database: '/local', user: 'u', pass: 'p' });
        await adapter.connect();
        const provider = lastDriver().opts.credentialsProvider as { args: unknown[] };
        expect(provider.args[2]).toBeUndefined();
    });

    it('credentials: environ важнее user и pass', async () => {
        createAdapter({ ...host, user: 'u', pass: 'p', options: { credentials: 'environ' } });
        await adapter.connect();
        expect(credentialsKind()).toBe('environ');
    });
});

describe('_select', () => {
    it('isOne: возвращает одну запись и приводит bigint к number', async () => {
        await connected();
        mockState.handler = () => [[{ userId: 'u1', platform: 'vk', counter: 5n }]];
        const res = await adapter.select(
            query('UsersData'),
            { userId: 'u1', platform: 'vk' },
            true,
        );
        expect(res).toEqual({ status: true, data: { userId: 'u1', platform: 'vk', counter: 5 } });
        expect(mockState.executed[0]).toMatchObject({
            text: 'SELECT * FROM `UsersData` WHERE `userId` = $p0 AND `platform` = $p1 LIMIT 1',
            idempotent: true,
            timeout: 5000,
        });
        expect(mockState.executed[0]?.isolation).toBeUndefined();
    });

    it('возвращает все записи массивом', async () => {
        await connected();
        mockState.handler = () => [[{ a: 1 }, { a: 2 }]];
        const res = await adapter.select(query('Custom'), null, false);
        expect(res).toEqual({ status: true, data: [{ a: 1 }, { a: 2 }] });
    });

    it('пустая выборка — status: false без error', async () => {
        await connected();
        expect(
            await adapter.select(query('UsersData'), { userId: 'x', platform: 'vk' }, true),
        ).toEqual({
            status: false,
        });
        mockState.handler = () => [];
        expect(await adapter.select(query('UsersData'), null, false)).toEqual({ status: false });
    });

    it('сбой базы — status: false с error, без исключения', async () => {
        await connected();
        mockState.handler = () => {
            throw new Error('UNAVAILABLE');
        };
        const res = await adapter.select(query('UsersData'), { userId: 'x', platform: 'vk' }, true);
        expect(res).toEqual({ status: false, error: 'UNAVAILABLE' });
        expect(ctx.logError).toHaveBeenCalled();
    });

    it('некорректное условие не уходит в базу', async () => {
        await connected();
        const res = await adapter.select(query('Custom'), { a: { $where: 'x' } }, false);
        expect(res.status).toBe(false);
        expect(res.error).toContain('Неизвестный оператор');
        expect(mockState.executed).toHaveLength(0);
    });

    it('без подключения — status: false с error', async () => {
        createAdapter();
        const res = await adapter.select(query('Custom'), null, false);
        expect(res).toEqual({ status: false, error: 'Нет подключения к базе данных' });
    });

    it('применяет queryTimeout из опций', async () => {
        await connected({ queryTimeout: 1500 });
        await adapter.select(query('Custom'), null, false);
        expect(mockState.executed[0]?.timeout).toBe(1500);
    });
});

describe('_insert / _update / _remove', () => {
    it('_insert делает UPSERT', async () => {
        await connected();
        const ok = await adapter.insert(
            query('ImageTokens', { data: { imageToken: 't1', path: '/a.png', platform: 'alisa' } }),
        );
        expect(ok).toBe(true);
        expect(mockState.executed[0]).toMatchObject({
            text: 'UPSERT INTO `ImageTokens` (`imageToken`, `path`, `platform`) VALUES ($p0, $p1, $p2)',
            isolation: 'serializableReadWrite',
            idempotent: true,
        });
    });

    it('_insert без ключа и при сбое возвращает false', async () => {
        await connected();
        expect(await adapter.insert(query('ImageTokens', { data: { path: '/a.png' } }))).toBe(
            false,
        );
        expect(mockState.executed).toHaveLength(0);
        mockState.handler = () => {
            throw new Error('fail');
        };
        expect(await adapter.insert(query('Custom', { data: { a: 1 } }))).toBe(false);
    });

    it('_update: меняет только не-ключевые колонки', async () => {
        await connected();
        const ok = await adapter.update(
            query('UsersData', {
                query: { userId: 'u1', platform: 'vk' },
                data: { platform: 'vk', data: '{"a":1}' },
            }),
        );
        expect(ok).toBe(true);
        expect(mockState.executed[0]).toMatchObject({
            text: 'UPDATE `UsersData` SET `data` = $p0 WHERE `userId` = $p1 AND `platform` = $p2',
            isolation: 'serializableReadWrite',
        });
    });

    it('_update: нечего менять — true без запроса', async () => {
        await connected();
        const ok = await adapter.update(
            query('UsersData', {
                query: { userId: 'u1', platform: 'vk' },
                data: { platform: 'vk' },
            }),
        );
        expect(ok).toBe(true);
        expect(mockState.executed).toHaveLength(0);
    });

    it('_update и _remove без условий возвращают false', async () => {
        await connected();
        expect(await adapter.update(query('Custom', { data: { a: 1 } }))).toBe(false);
        expect(await adapter.remove(query('Custom'))).toBe(false);
        expect(mockState.executed).toHaveLength(0);
    });

    it('_remove удаляет по условию, при сбое — false', async () => {
        await connected();
        expect(await adapter.remove(query('ImageTokens', { query: { imageToken: 't1' } }))).toBe(
            true,
        );
        expect(mockState.executed[0]?.text).toBe(
            'DELETE FROM `ImageTokens` WHERE `imageToken` = $p0',
        );
        mockState.handler = () => {
            throw new Error('fail');
        };
        expect(await adapter.remove(query('ImageTokens', { query: { imageToken: 't1' } }))).toBe(
            false,
        );
    });
});

describe('ensureSchema', () => {
    it('схема готова — один запрос-проверка без DDL', async () => {
        await connected();
        expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(true);
        expect(mockState.executed).toHaveLength(1);
        expect(mockState.executed[0]?.text).toContain('VIEW `idx_platform_path` LIMIT 0;');
        expect(mockState.executed[0]?.text).not.toContain('CREATE');
    });

    it('создаёт таблицы и добавляет недостающие колонку и индекс', async () => {
        await connected();
        mockState.handler = (text) => {
            const missing =
                text.includes('LIMIT 0;') || // общий запрос-проверка
                text === 'SELECT `meta` FROM `UsersData` LIMIT 0' ||
                (text.includes('VIEW `idx_platform_path` LIMIT 0') &&
                    text.includes('`SoundTokens`'));
            if (missing) {
                throw new Error('not found');
            }
            return [];
        };
        expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(true);
        const ddl = mockState.executed
            .map((entry) => entry.text)
            .filter((text) => !text.startsWith('SELECT'));
        expect(ddl).toEqual([
            expect.stringContaining('CREATE TABLE IF NOT EXISTS `UsersData`'),
            'ALTER TABLE `UsersData` ADD COLUMN `meta` Utf8',
            expect.stringContaining('CREATE TABLE IF NOT EXISTS `ImageTokens`'),
            expect.stringContaining('CREATE TABLE IF NOT EXISTS `SoundTokens`'),
            'ALTER TABLE `SoundTokens` ADD INDEX `idx_platform_path` GLOBAL SYNC ON (`platform`, `path`)',
        ]);
        const createEntry = mockState.executed.find((entry) => entry.text.startsWith('CREATE'));
        expect(createEntry).toMatchObject({ idempotent: false, timeout: 30000 });
        // DDL не выполняется внутри транзакции
        expect(createEntry?.isolation).toBeUndefined();
        const probe = mockState.executed.find((entry) => entry.text.startsWith('SELECT `meta`'));
        expect(probe?.timeout).toBe(5000);
    });

    it('DDL получает queryTimeout, если он больше 30 с', async () => {
        await connected({ queryTimeout: 45000 });
        mockState.handler = (text) => {
            if (text.includes('LIMIT 0;')) {
                throw new Error('not found');
            }
            return [];
        };
        await adapter.ensureSchema(DB_TABLES_SCHEMA);
        const createEntry = mockState.executed.find((entry) => entry.text.startsWith('CREATE'));
        expect(createEntry?.timeout).toBe(45000);
    });

    it('ошибка DDL — false и запись в лог', async () => {
        await connected();
        mockState.handler = () => {
            throw new Error('ACCESS_DENIED');
        };
        expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(false);
        expect(ctx.logError).toHaveBeenCalledWith(
            'YDB: ensureSchema: не удалось подготовить таблицы: ACCESS_DENIED',
            expect.anything(),
        );
    });

    it('ensureSchema: false — без запросов к базе', async () => {
        await connected({ ensureSchema: false });
        expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(true);
        expect(mockState.executed).toHaveLength(0);
    });

    it('без подключения — false', async () => {
        createAdapter();
        expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(false);
    });

    it('пустой список таблиц — true без запросов', async () => {
        await connected();
        expect(await adapter.ensureSchema([])).toBe(true);
        expect(mockState.executed).toHaveLength(0);
    });

    describe('опция tables', () => {
        const tables = [
            {
                tableName: 'Orders',
                primaryKey: ['orderId'],
                columns: { orderId: 'Utf8', userId: 'Utf8', qty: 'Int64' },
                indexes: [['userId']],
            },
        ] as const;

        it('создаёт свои таблицы вместе со встроенными', async () => {
            await connected({ tables });
            expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(true);
            expect(mockState.executed[0]?.text).toContain(
                'SELECT `orderId`, `userId`, `qty` FROM `Orders` LIMIT 0;',
            );
            mockState.executed = [];
            mockState.handler = (text) => {
                if (text.includes('LIMIT 0;')) {
                    throw new Error('not found');
                }
                return [];
            };
            expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(true);
            expect(mockState.executed.map((entry) => entry.text)).toContainEqual(
                expect.stringContaining('CREATE TABLE IF NOT EXISTS `Orders`'),
            );
        });

        it('после подключения приводит значения к типам колонок и ищет через VIEW', async () => {
            await connected({ tables });
            await adapter.select(query('Orders'), { userId: 42, qty: { $gt: '3' } }, false);
            const entry = mockState.executed[0];
            expect(entry?.text).toBe(
                'SELECT * FROM `Orders` VIEW `idx_userId` WHERE `userId` = $p0 AND `qty` > $p1',
            );
            expect(entry?.params).toEqual({
                $p0: { kind: 'Utf8', value: '42' },
                $p1: { kind: 'Int64', value: 3n },
            });
        });

        it('некорректное описание: connect и ensureSchema возвращают false', async () => {
            const broken: IYdbTableDefinition[] = [
                { tableName: 'Orders', primaryKey: ['id'], columns: { x: 'Utf8' } },
            ];
            createAdapter({
                host: 'grpc://localhost:2136',
                database: '/local',
                options: { tables: broken },
            });
            expect(await adapter.connect()).toBe(false);
            expect(ctx.logError).toHaveBeenCalledWith(
                expect.stringContaining('Колонка "id" таблицы "Orders"'),
                expect.anything(),
            );
            expect(await adapter.ensureSchema(DB_TABLES_SCHEMA)).toBe(false);
        });
    });

    it('запоминает переданную схему: поиск по индексу своей таблицы идёт через VIEW', async () => {
        await connected({ ensureSchema: false });
        await adapter.ensureSchema([
            {
                tableName: 'Orders',
                primaryKeyName: 'id',
                uniqueKeys: [],
                fields: { id: { type: 'string' }, userId: { type: 'string' } },
                indexes: [['userId']],
            },
        ]);
        await adapter.select(query('Orders'), { userId: 'u1' }, false);
        expect(mockState.executed[0]?.text).toBe(
            'SELECT * FROM `Orders` VIEW `idx_userId` WHERE `userId` = $p0',
        );
    });
});

describe('query / isConnected / destroy', () => {
    it('query передаёт клиент и драйвер, возвращает data', async () => {
        await connected();
        const callback = jest.fn(async () => ({ status: true, data: { cnt: 3 } }));
        expect(await adapter.query(callback)).toEqual({ cnt: 3 });
        expect(callback).toHaveBeenCalledWith(ctx.database.databaseInfo.sql, lastDriver());
    });

    it('query: status false, исключение или нет подключения — null', async () => {
        await connected();
        expect(await adapter.query(async () => ({ status: false, error: 'bad' }))).toBeNull();
        expect(ctx.logError).toHaveBeenCalledWith('YDB: bad', {});
        expect(
            await adapter.query(async () => {
                throw new Error('boom');
            }),
        ).toBeNull();
        await adapter.destroy();
        expect(await adapter.query(async () => ({ status: true, data: { a: 1 } }))).toBeNull();
    });

    it('escapeString экранирует строку для YQL-литерала', () => {
        createAdapter();
        expect(adapter.escapeString("it's")).toBe(String.raw`it\'s`);
    });

    it('isConnected проверяет базу запросом SELECT 1', async () => {
        createAdapter();
        expect(await adapter.isConnected()).toBe(false);
        await connected();
        expect(await adapter.isConnected()).toBe(true);
        expect(mockState.executed[0]?.text).toBe('SELECT 1');
        mockState.handler = () => {
            throw new Error('down');
        };
        expect(await adapter.isConnected()).toBe(false);
    });

    it('ошибка закрытия пула сессий не мешает закрыть драйвер', async () => {
        await connected();
        const driver = lastDriver();
        const sql = ctx.database.databaseInfo.sql as Record<symbol, unknown>;
        sql[Symbol.asyncDispose] = async () => {
            throw new Error('dispose failed');
        };
        await adapter.destroy();
        expect(driver.closed).toBe(true);
        expect(ctx.logError).toHaveBeenCalledWith(
            'YDB: Ошибка при закрытии пула сессий: dispose failed',
            expect.anything(),
        );
    });

    it('в лог попадает текст и не-Error исключения', async () => {
        await connected();
        mockState.handler = () => {
            throw 'plain string';
        };
        const res = await adapter.select(query('Custom'), null, false);
        expect(res).toEqual({ status: false, error: 'plain string' });
    });

    it('destroy закрывает пул и драйвер, очищает databaseInfo; повторный вызов безопасен', async () => {
        await connected();
        const driver = lastDriver();
        await adapter.destroy();
        expect(driver.closed).toBe(true);
        expect(mockState.disposed).toBe(1);
        expect(ctx.database.databaseInfo.driver).toBeUndefined();
        expect(ctx.database.databaseInfo.sql).toBeUndefined();
        await adapter.destroy();
        expect(mockState.disposed).toBe(1);
        expect(await adapter.isConnected()).toBe(false);
    });
});

describe('работа с моделью UsersData', () => {
    it('сохраняет нового пользователя и находит его по ключу', async () => {
        await connected();
        const model = new UsersData(ctx as unknown as AppContext);
        model.userId = 12345;
        model.platform = 'telegram';
        model.data = { step: 1 };
        expect(await model.save(true)).toBe(true);
        const upsert = mockState.executed[0];
        expect(upsert?.text).toBe(
            'UPSERT INTO `UsersData` (`meta`, `data`, `platform`, `userId`) VALUES (NULL, $p0, $p1, $p2)',
        );
        expect(upsert?.params.$p2).toEqual({ kind: 'Utf8', value: '12345' });

        mockState.handler = () => [
            [{ userId: '12345', platform: 'telegram', meta: null, data: '{"step":1}' }],
        ];
        const found = new UsersData(ctx as unknown as AppContext);
        expect(await found.whereOne({ userId: 12345, platform: 'telegram' })).toBe(true);
        expect(found.data).toEqual({ step: 1 });
    });

    it('save() существующего пользователя делает UPDATE по составному ключу', async () => {
        await connected();
        mockState.handler = (text) =>
            text.startsWith('SELECT') ? [[{ userId: 'u1', platform: 'vk' }]] : [];
        const model = new UsersData(ctx as unknown as AppContext);
        model.userId = 'u1';
        model.platform = 'vk';
        model.data = { step: 2 };
        expect(await model.save()).toBe(true);
        expect(mockState.executed.map((entry) => entry.text)).toEqual([
            'SELECT * FROM `UsersData` WHERE `userId` = $p0 AND `platform` = $p1 LIMIT 1',
            'UPDATE `UsersData` SET `meta` = NULL, `data` = $p0 WHERE `userId` = $p1 AND `platform` = $p2',
        ]);
    });
});
