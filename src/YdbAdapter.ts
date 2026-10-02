import { BaseDbAdapter } from 'umbot/plugins';
import { DB_TABLES_SCHEMA } from 'umbot';
import type {
    IAppDB,
    IDatabaseInfo,
    IDbTableSchema,
    IModelRes,
    IQuery,
    IQueryData,
    TQueryCb,
} from 'umbot';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import type { QueryClient } from '@ydbjs/query';
import type { CredentialsProvider } from '@ydbjs/auth';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { StaticCredentialsProvider } from '@ydbjs/auth/static';
import type { SecureContextOptions } from 'node:tls';
import {
    buildAddColumn,
    buildAddIndex,
    buildColumnCheck,
    buildCreateTable,
    buildDelete,
    buildIndexCheck,
    buildSchemaCheck,
    buildSelect,
    buildUpdate,
    buildUpsert,
    escapeYqlString,
    normalizeRow,
    tableInfoFromDefinition,
    tableInfoFromSchema,
} from './yql';
import type { IYdbTableDefinition, IYdbTableInfo, IYqlContext, IYqlStatement } from './yql';

const DEFAULT_CONNECT_TIMEOUT = 10000;
const DEFAULT_QUERY_TIMEOUT = 5000;
// Создание таблицы или индекса в serverless YDB может идти дольше обычного запроса
const MIN_DDL_TIMEOUT = 30000;
const CONNECTION_STRING_ENV = 'YDB_CONNECTION_STRING';

/**
 * Способ авторизации в YDB.
 * - `environ` — по переменным окружения YDB SDK (`YDB_METADATA_CREDENTIALS=1`,
 *   `YDB_ACCESS_TOKEN_CREDENTIALS`, `YDB_STATIC_CREDENTIALS_USER`/`_PASSWORD`, `YDB_ANONYMOUS_CREDENTIALS=1`);
 * - `metadata` — сервисный аккаунт из сервиса метаданных (Cloud Functions, виртуальные машины Yandex Cloud);
 * - `anonymous` — без авторизации (локальный YDB в Docker);
 * - свой провайдер из `@ydbjs/auth`.
 */
export type TYdbCredentials = 'environ' | 'metadata' | 'anonymous' | CredentialsProvider;

/**
 * Опции адаптера, передаются в `IAppDB.options`.
 *
 * @example
 * ```ts
 * new YdbAdapter({
 *     host: 'grpcs://ydb.serverless.yandexcloud.net:2135',
 *     database: '/ru-central1/b1g.../etn...',
 *     options: { credentials: 'metadata', queryTimeout: 3000 },
 * });
 * ```
 */
export interface IYdbOptions {
    /**
     * Полная строка подключения (`grpcs://host:2135/?database=/ru-central1/...`).
     * Если задана, `host` и `database` не используются.
     */
    connectionString?: string;
    /**
     * Способ авторизации. По умолчанию: `user`/`pass` из конфигурации — логин и пароль YDB,
     * иначе `environ`.
     */
    credentials?: TYdbCredentials;
    /** Сколько ждать подключения (discovery и получение токена), мс. По умолчанию 10000 */
    connectTimeout?: number;
    /** Ограничение на один запрос вместе с повторами SDK, мс. По умолчанию 5000 */
    queryTimeout?: number;
    /**
     * Создавать недостающие таблицы, колонки и индексы после подключения. По умолчанию true.
     * Выключите, если схему создаёт миграция, а у сервисного аккаунта нет прав на DDL.
     */
    ensureSchema?: boolean;
    /** Максимум одновременных сессий YDB. По умолчанию — значение SDK (50) */
    poolSize?: number;
    /**
     * Таблицы ваших моделей. Адаптер создаёт их вместе со встроенными (`ensureSchema`),
     * приводит значения к типам колонок и ищет по их индексам через `VIEW`.
     */
    tables?: readonly IYdbTableDefinition[];
}

/**
 * Параметры конструктора адаптера. Все поля необязательны: без них строка подключения
 * берётся из `appConfig.db` или из переменной окружения `YDB_CONNECTION_STRING`.
 *
 * @example
 * ```ts
 * const config: IYdbAdapterConfig = { options: { credentials: 'metadata' } };
 * ```
 */
export interface IYdbAdapterConfig {
    /** Эндпоинт: `grpcs://ydb.serverless.yandexcloud.net:2135` */
    host?: string;
    /** Путь базы: `/ru-central1/b1g.../etn...` */
    database?: string;
    /** Логин пользователя YDB (не Yandex Cloud) */
    user?: string;
    /** Пароль пользователя YDB */
    pass?: string;
    /** Опции адаптера */
    options?: IYdbOptions;
}

/**
 * Информация о подключении, которую адаптер хранит в `appContext.database.databaseInfo`.
 */
export interface IYdbDbInfo extends IDatabaseInfo {
    /** Драйвер YDB */
    driver?: Driver;
    /** Клиент запросов: `` sql`SELECT 1` `` */
    sql?: QueryClient;
}

/**
 * Адаптер umbot для YDB (Yandex Database).
 *
 * Хранит `UsersData`, `ImageTokens`, `SoundTokens` и данные своих моделей. Таблицы
 * встроенных моделей создаёт сам (`ensureSchema`). Все значения уходят в запрос
 * параметрами (`$p0`, `$p1`, ...): конкатенации пользовательских данных в YQL нет.
 *
 * @example
 * ```ts
 * import { Bot } from 'umbot';
 * import { YdbAdapter } from 'umbot-ydb-adapter';
 *
 * // Строка подключения — из YDB_CONNECTION_STRING, авторизация — из окружения
 * const bot = new Bot().use(new YdbAdapter());
 * ```
 */
export class YdbAdapter extends BaseDbAdapter<IYdbDbInfo> {
    dbFormat: string = 'ydb';
    #driver: Driver | undefined;
    #sql: QueryClient | undefined;
    #tables = new Map<string, IYdbTableInfo>();

    /**
     * @param config Параметры подключения (см. {@link IYdbAdapterConfig}). Без них строка подключения
     *   берётся из `appConfig.db` или из `YDB_CONNECTION_STRING`.
     */
    constructor(config?: IYdbAdapterConfig) {
        // Пустые host/database не мешают: при выборе строки подключения пустое значение пропускается
        super(
            config
                ? ({ host: '', database: '', ...config, options: config.options } as IAppDB)
                : undefined,
        );
        // Схема встроенных таблиц нужна и без ensureSchema: по ней выбираются типы и индексы
        for (const schema of DB_TABLES_SCHEMA) {
            this.#tables.set(schema.tableName, tableInfoFromSchema(schema));
        }
    }

    /**
     * Опции адаптера из параметров конструктора или из `appConfig.db.options`.
     */
    #getOptions(): IYdbOptions {
        const options = this._dbOptions?.options ?? this._appContext.appConfig.db?.options;
        return (options ?? {}) as IYdbOptions;
    }

    /**
     * Строка подключения: `options.connectionString`, затем `host` + `database`,
     * затем переменная окружения `YDB_CONNECTION_STRING`.
     */
    #getConnectionString(): string | undefined {
        const options = this.#getOptions();
        if (options.connectionString) {
            return options.connectionString;
        }
        const host = this._dbOptions?.host || this._appContext.appConfig.db?.host;
        const database = this._dbOptions?.database || this._appContext.appConfig.db?.database;
        if (host && database) {
            const base = host.replace(/\/+$/, '');
            return `${base}/?database=${encodeURIComponent(database)}`;
        }
        return process.env[CONNECTION_STRING_ENV] || undefined;
    }

    /**
     * Провайдер авторизации и TLS-опции для драйвера.
     */
    #getCredentials(connectionString: string): {
        provider: CredentialsProvider;
        secureOptions?: SecureContextOptions | undefined;
    } {
        const credentials = this.#getOptions().credentials;
        if (credentials && typeof credentials === 'object') {
            return { provider: credentials };
        }
        switch (credentials) {
            case 'metadata':
                return { provider: new MetadataCredentialsProvider() };
            case 'anonymous':
                return { provider: new AnonymousCredentialsProvider() };
        }
        const user = this._dbOptions?.user || this._appContext.appConfig.db?.user;
        const pass = this._dbOptions?.pass || this._appContext.appConfig.db?.pass;
        if (credentials !== 'environ' && user && pass) {
            // Без TLS-контекста провайдер открыл бы незащищённый канал и для grpcs
            const secureOptions = connectionString.startsWith('grpcs:') ? {} : undefined;
            return {
                provider: new StaticCredentialsProvider(
                    { username: user, password: pass },
                    connectionString,
                    secureOptions,
                ),
            };
        }
        const environ = new EnvironCredentialsProvider(connectionString);
        return { provider: environ, secureOptions: environ.secureOptions };
    }

    /**
     * Подключается к YDB: создаёт драйвер и ждёт discovery не дольше `connectTimeout`.
     * Повторный вызов закрывает предыдущее подключение.
     * @returns true при успешном подключении
     */
    async connect(): Promise<boolean> {
        await this.#closeDriver();
        const connectionString = this.#getConnectionString();
        if (!connectionString) {
            this._saveLog(
                `Не задана строка подключения: укажите host и database, options.connectionString или переменную ${CONNECTION_STRING_ENV}.`,
            );
            return false;
        }
        const options = this.#getOptions();
        const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
        let driver: Driver | undefined;
        try {
            for (const info of this.#customTables()) {
                this.#tables.set(info.tableName, info);
            }
            const { provider, secureOptions } = this.#getCredentials(connectionString);
            driver = new Driver(connectionString, {
                credentialsProvider: provider,
                secureOptions,
                'ydb.sdk.ready_timeout_ms': connectTimeout,
            });
            await driver.ready(AbortSignal.timeout(connectTimeout));
            const sql =
                options.poolSize === undefined
                    ? query(driver)
                    : query(driver, { poolOptions: { maxSize: options.poolSize } });
            this.#driver = driver;
            this.#sql = sql;
            const databaseInfo = (this._appContext.database.databaseInfo ??= {});
            databaseInfo.driver = driver;
            databaseInfo.sql = sql;
            this._appContext.log('YDB: подключение установлено');
            return true;
        } catch (error) {
            driver?.close();
            // Строку подключения не логируем целиком: в query-параметрах бывают служебные данные
            this._saveLog('Не удалось подключиться к базе данных', error);
            return false;
        }
    }

    /**
     * Описания своих таблиц из опции `tables`.
     * @returns Описания таблиц; бросает YqlBuildError, если описание некорректно
     */
    #customTables(): IYdbTableInfo[] {
        return (this.#getOptions().tables ?? []).map(tableInfoFromDefinition);
    }

    /**
     * Создаёт недостающие таблицы, колонки и индексы встроенных моделей и таблиц из опции `tables`.
     *
     * Сначала выполняется один запрос-проверка (`SELECT ... LIMIT 0` по всем таблицам и индексам).
     * Если схема уже готова — на этом всё: в Cloud Functions метод вызывается на каждом холодном
     * старте, и DDL на каждый старт стоил бы заметного времени.
     * @param tables Описание таблиц (`DB_TABLES_SCHEMA`)
     * @returns true, если схема готова
     */
    async ensureSchema(tables: readonly IDbTableSchema[]): Promise<boolean> {
        let infos: IYdbTableInfo[];
        try {
            infos = [...tables.map(tableInfoFromSchema), ...this.#customTables()];
        } catch (error) {
            this._saveLog('ensureSchema: некорректное описание таблицы', error);
            return false;
        }
        for (const info of infos) {
            this.#tables.set(info.tableName, info);
        }
        if (this.#getOptions().ensureSchema === false || !infos.length) {
            return true;
        }
        if (!this.#sql) {
            this._saveLog('ensureSchema: нет подключения к базе данных');
            return false;
        }
        const check = infos.map(buildSchemaCheck).join('\n');
        if (await this.#tryExecute(check)) {
            return true;
        }
        try {
            for (const info of infos) {
                await this.#prepareTable(info);
            }
            return true;
        } catch (error) {
            this._saveLog('ensureSchema: не удалось подготовить таблицы', error);
            return false;
        }
    }

    /**
     * Создаёт таблицу, если её нет, и добавляет недостающие колонки и индексы.
     */
    async #prepareTable(info: IYdbTableInfo): Promise<void> {
        await this.#executeDdl(buildCreateTable(info));
        for (const [column, type] of info.columns) {
            if (!(await this.#tryExecute(buildColumnCheck(info.tableName, column)))) {
                await this.#executeDdl(buildAddColumn(info.tableName, column, type));
            }
        }
        for (const index of info.indexes) {
            if (!(await this.#tryExecute(buildIndexCheck(info.tableName, index)))) {
                await this.#executeDdl(buildAddIndex(info.tableName, index));
            }
        }
    }

    /**
     * Выполняет DDL-запрос с таймаутом не меньше 30 с и без повторов SDK.
     */
    async #executeDdl(text: string): Promise<void> {
        const timeout = Math.max(this.#getQueryTimeout(), MIN_DDL_TIMEOUT);
        await this.#execute({ text, params: {} }, { idempotent: false, timeout });
    }

    /**
     * Таймаут обычного запроса из опций.
     */
    #getQueryTimeout(): number {
        return this.#getOptions().queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    }

    /**
     * Выполняет запрос-проверку схемы.
     * @returns true, если запрос прошёл без ошибок
     */
    async #tryExecute(text: string): Promise<boolean> {
        try {
            await this.#execute({ text, params: {} });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Выполняет запрос с ограничением по времени (вместе с повторами SDK).
     * @param statement Текст и параметры
     * @param options `idempotent` — можно ли SDK повторить запрос (по умолчанию да);
     *   `timeout` — мс, по умолчанию `queryTimeout`; `write` — изменение данных
     * @returns Наборы строк результата
     */
    async #execute(
        statement: IYqlStatement,
        options: { idempotent?: boolean; timeout?: number; write?: boolean } = {},
    ): Promise<unknown[][]> {
        const sql = this.#sql;
        if (!sql) {
            throw new Error('Нет подключения к базе данных');
        }
        let q = sql(statement.text);
        for (const name of Object.keys(statement.params)) {
            q = q.parameter(name, statement.params[name]);
        }
        if (options.write) {
            // YDB меняет таблицы с вторичными индексами только в Serializable-транзакции
            q = q.isolation('serializableReadWrite');
        }
        const timeout = options.timeout ?? this.#getQueryTimeout();
        return (await q.idempotent(options.idempotent ?? true).timeout(timeout)) as unknown[][];
    }

    /**
     * Контекст сборки запроса: схема таблицы и правила модели.
     */
    #context(data: IQuery): IYqlContext {
        return { table: this.#tables.get(data.tableName), rules: data.rules };
    }

    /**
     * Выполняет SELECT.
     *
     * Контракт umbot: при `isOne` в `data` — сама запись (не массив); пустая выборка —
     * `{ status: false }` без `error`; сбой — `{ status: false, error }`.
     * @param selectData Информация о таблице
     * @param where Условия выборки
     * @param isOne Вернуть только одну запись
     * @returns Результат выборки
     */
    public async _select(
        selectData: IQuery,
        where: IQueryData | null,
        isOne: boolean,
    ): Promise<IModelRes> {
        try {
            const statement = buildSelect(
                selectData.tableName,
                where,
                isOne,
                this.#context(selectData),
            );
            const [rows = []] = await this.#execute(statement);
            if (!rows.length) {
                return { status: false };
            }
            const data = (rows as Record<string, unknown>[]).map(normalizeRow);
            return { status: true, data: isOne ? (data[0] as Record<string, unknown>) : data };
        } catch (error) {
            this._saveLog(`Ошибка SELECT из таблицы "${selectData.tableName}"`, error);
            return { status: false, error: getErrorMessage(error) };
        }
    }

    /**
     * Добавляет запись (UPSERT): повторная запись с тем же ключом перезаписывает строку,
     * поэтому SDK может безопасно повторить запрос после временной ошибки сети.
     * @param insertData Запрос с данными в `data`
     * @returns true при успехе
     */
    public async _insert(insertData: IQuery): Promise<boolean> {
        try {
            const statement = buildUpsert(
                insertData.tableName,
                insertData.data ?? {},
                this.#context(insertData),
            );
            await this.#execute(statement, { write: true });
            return true;
        } catch (error) {
            this._saveLog(`Ошибка записи в таблицу "${insertData.tableName}"`, error);
            return false;
        }
    }

    /**
     * Обновляет записи по условию `query`. Без условий запрос не выполняется.
     * @param updateData Запрос: условия в `query`, новые значения в `data`
     * @returns true при успехе (в том числе если под условие не попало ни одной записи)
     */
    public async _update(updateData: IQuery): Promise<boolean> {
        try {
            const statement = buildUpdate(
                updateData.tableName,
                updateData.data ?? {},
                updateData.query,
                this.#context(updateData),
            );
            if (statement) {
                await this.#execute(statement, { write: true });
            }
            return true;
        } catch (error) {
            this._saveLog(`Ошибка UPDATE таблицы "${updateData.tableName}"`, error);
            return false;
        }
    }

    /**
     * Удаляет записи по условию `query`. Без условий запрос не выполняется.
     * @param removeData Запрос: условия в `query`
     * @returns true при успехе
     */
    public async _remove(removeData: IQuery): Promise<boolean> {
        try {
            const statement = buildDelete(
                removeData.tableName,
                removeData.query,
                this.#context(removeData),
            );
            await this.#execute(statement, { write: true });
            return true;
        } catch (error) {
            this._saveLog(`Ошибка DELETE из таблицы "${removeData.tableName}"`, error);
            return false;
        }
    }

    /**
     * Выполняет произвольный запрос: callback получает клиент запросов и драйвер.
     *
     * @example
     * ```ts
     * const count = await usersData.query(async (sql) => {
     *     const [[row]] = await sql`SELECT COUNT(*) AS cnt FROM UsersData`;
     *     return { status: true, data: row };
     * });
     * ```
     * @param callback Функция с запросом
     * @returns `data` из результата callback или null при ошибке
     */
    public async _query(callback: TQueryCb<QueryClient, Driver>): Promise<unknown> {
        if (!this.#sql || !this.#driver) {
            this._saveLog('Нет подключения к базе данных');
            return null;
        }
        try {
            const res = await callback(this.#sql, this.#driver);
            if (res.status) {
                return res.data;
            }
            this._saveLog(String(res.error));
            return null;
        } catch (error) {
            this._saveLog('Ошибка в query()', error);
            return null;
        }
    }

    /**
     * Выполняет произвольный запрос (см. `_query`).
     * @param callback Функция с запросом
     * @returns `data` из результата callback или null при ошибке
     */
    public query(callback: TQueryCb<QueryClient, Driver>): Promise<unknown> {
        return this._query(callback);
    }

    /**
     * Экранирует строку для своего запроса: результат можно поставить внутрь `'...'` в YQL.
     * Адаптер этим методом не пользуется — значения уходят параметрами; для своих запросов
     * тоже лучше параметры (`` sql`... ${value}` `` в `query()`).
     * @param str Значение
     * @returns Экранированная строка
     */
    public escapeString(str: string | number): string {
        return escapeYqlString(str);
    }

    /**
     * Проверяет соединение запросом `SELECT 1`.
     * @returns true, если база отвечает
     */
    public async isConnected(): Promise<boolean> {
        if (!this.#sql) {
            return false;
        }
        try {
            await this.#execute({ text: 'SELECT 1', params: {} });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Закрывает драйвер и очищает `databaseInfo`. Безопасен к повторному вызову.
     */
    public async destroy(): Promise<void> {
        await super.destroy();
        await this.#closeDriver();
    }

    /**
     * Закрывает пул сессий и драйвер, убирает ссылки на них из контекста приложения.
     */
    async #closeDriver(): Promise<void> {
        const driver = this.#driver;
        const sql = this.#sql;
        this.#driver = undefined;
        this.#sql = undefined;
        const databaseInfo = this._appContext?.database?.databaseInfo;
        if (databaseInfo) {
            delete databaseInfo.driver;
            delete databaseInfo.sql;
        }
        try {
            // Пул сессий закрывается до драйвера: иначе сессии на сервере живут до своего таймаута
            await sql?.[Symbol.asyncDispose]();
        } catch (error) {
            this._saveLog('Ошибка при закрытии пула сессий', error);
        }
        driver?.close();
    }

    /**
     * Пишет ошибку в лог umbot (секреты маскирует логгер фреймворка).
     * @param message Текст ошибки
     * @param error Исключение
     */
    protected _saveLog(message: string, error?: unknown): void {
        const text = error === undefined ? message : `${message}: ${getErrorMessage(error)}`;
        this._appContext?.logError(`YDB: ${text}`, error === undefined ? {} : { error });
    }
}

/**
 * Текст ошибки для лога и поля `error` результата.
 */
function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
