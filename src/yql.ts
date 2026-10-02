import { Text as UmbotText } from 'umbot';
import type { IDbTableSchema, IModelRules, IQueryData } from 'umbot';
import type { Value } from '@ydbjs/value';
import { Bool, Double, Int64, Text } from '@ydbjs/value/primitive';
import { List } from '@ydbjs/value/list';

/**
 * Типы колонок YDB, которые понимает адаптер.
 */
export const YDB_COLUMN_TYPES = ['Utf8', 'Int64', 'Double', 'Bool'] as const;

/**
 * Тип колонки YDB: в него адаптер приводит значение параметра.
 */
export type TYdbColumnType = (typeof YDB_COLUMN_TYPES)[number];

/**
 * Вторичный индекс таблицы.
 */
export interface IYdbIndexInfo {
    /** Имя индекса (`idx_<поля>`) */
    name: string;
    /** Поля индекса в порядке объявления */
    fields: readonly string[];
}

/**
 * Что адаптер знает о таблице: ключ, типы колонок и индексы.
 */
export interface IYdbTableInfo {
    /** Имя таблицы */
    tableName: string;
    /** Колонки первичного ключа: `primaryKeyName` и `uniqueKeys` из схемы umbot */
    primaryKey: readonly string[];
    /** Типы колонок */
    columns: ReadonlyMap<string, TYdbColumnType>;
    /** Вторичные индексы (кроме тех, что совпадают с началом первичного ключа) */
    indexes: readonly IYdbIndexInfo[];
}

/**
 * Готовый к выполнению запрос: текст YQL и параметры `$pN`.
 */
export interface IYqlStatement {
    /** Текст запроса без `DECLARE`: SDK добавляет их сам по типам параметров */
    text: string;
    /** Параметры запроса */
    params: Record<string, Value>;
}

/**
 * Ошибка сборки запроса: некорректное имя, условие или значение.
 * Адаптер не отправляет такой запрос в базу, а возвращает ошибку вызывающему коду.
 */
export class YqlBuildError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'YqlBuildError';
    }
}

/**
 * Контекст сборки запроса: схема таблицы (если известна) и правила модели.
 */
export interface IYqlContext {
    /** Схема таблицы, если таблица встроенная или передана в `ensureSchema` */
    table?: IYdbTableInfo | undefined;
    /** Правила валидации модели (`IQuery.rules`) */
    rules?: readonly IModelRules[] | undefined;
}

// Сегмент пути таблицы: имя может содержать директории YDB (`bots/UsersData`)
const TABLE_SEGMENT_REGEXP = /^[A-Za-z_][\w-]*$/;
const COLUMN_NAME_REGEXP = /^[A-Za-z_]\w*$/;
// Через эти ключи можно добраться до прототипа: в имени колонки их быть не может
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const COMPARE_OPERATORS = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $like: 'LIKE',
} as const;

/**
 * Операторы условий, которые понимает адаптер.
 */
export const SUPPORTED_OPERATORS = [
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$ne',
    '$in',
    '$nin',
    '$like',
    '$null',
] as const;

type TOperator = (typeof SUPPORTED_OPERATORS)[number];

/**
 * Описание своей таблицы для опции `tables`: адаптер создаст её вместе со встроенными
 * и будет искать по её индексам через `VIEW`.
 *
 * @example
 * ```ts
 * const orders: IYdbTableDefinition = {
 *     tableName: 'Orders',
 *     primaryKey: ['orderId'],
 *     columns: { orderId: 'Utf8', userId: 'Utf8', total: 'Double', paid: 'Bool' },
 *     indexes: [['userId']],
 * };
 * ```
 */
export interface IYdbTableDefinition {
    /** Имя таблицы (можно с директорией: `bots/Orders`) */
    tableName: string;
    /** Колонки первичного ключа; каждая должна быть в `columns` */
    primaryKey: readonly string[];
    /** Колонки и их типы */
    columns: Readonly<Record<string, TYdbColumnType>>;
    /** Наборы колонок, по которым нужен вторичный индекс */
    indexes?: readonly (readonly string[])[];
}

/**
 * Вторичные индексы таблицы. Индекс, совпадающий с началом первичного ключа, не создаётся:
 * ключ уже даёт быстрый поиск по этим полям.
 */
function buildIndexes(
    primaryKey: readonly string[],
    indexes: readonly (readonly string[])[],
): IYdbIndexInfo[] {
    const result: IYdbIndexInfo[] = [];
    for (const fields of indexes) {
        const isKeyPrefix = fields.every((field, i) => primaryKey[i] === field);
        if (!isKeyPrefix) {
            result.push({ name: `idx_${fields.join('_')}`, fields: [...fields] });
        }
    }
    return result;
}

/**
 * Собирает описание таблицы из схемы umbot (`DB_TABLES_SCHEMA`).
 * Все поля встроенных таблиц строковые, поэтому колонки получают тип `Utf8`.
 * @param schema Описание таблицы
 * @returns Описание таблицы для адаптера
 */
export function tableInfoFromSchema(schema: IDbTableSchema): IYdbTableInfo {
    const primaryKey = [schema.primaryKeyName, ...schema.uniqueKeys];
    const columns = new Map<string, TYdbColumnType>();
    for (const name of Object.keys(schema.fields)) {
        columns.set(name, 'Utf8');
    }
    return {
        tableName: schema.tableName,
        primaryKey,
        columns,
        indexes: buildIndexes(primaryKey, schema.indexes),
    };
}

/**
 * Собирает описание своей таблицы из опции `tables` и проверяет его.
 * @param definition Описание таблицы
 * @returns Описание таблицы для адаптера
 */
export function tableInfoFromDefinition(definition: IYdbTableDefinition): IYdbTableInfo {
    const { tableName, primaryKey } = definition;
    const columns = new Map(Object.entries(definition.columns));
    quoteTable(tableName);
    if (!primaryKey.length) {
        throw new YqlBuildError(`У таблицы "${tableName}" не задан первичный ключ.`);
    }
    const indexes = definition.indexes ?? [];
    for (const column of [...primaryKey, ...indexes.flat()]) {
        if (!columns.has(column)) {
            throw new YqlBuildError(
                `Колонка "${column}" таблицы "${tableName}" используется в ключе или индексе, но не описана в columns.`,
            );
        }
    }
    for (const [column, type] of columns) {
        quoteColumn(column);
        if (!(YDB_COLUMN_TYPES as readonly string[]).includes(type)) {
            throw new YqlBuildError(
                `Неизвестный тип "${type}" колонки "${column}" таблицы "${tableName}". Поддерживаются: ${YDB_COLUMN_TYPES.join(', ')}.`,
            );
        }
    }
    return {
        tableName,
        primaryKey: [...primaryKey],
        columns,
        indexes: buildIndexes(primaryKey, indexes),
    };
}

/**
 * Проверяет имя таблицы и возвращает его в обратных кавычках.
 * @param name Имя таблицы
 * @returns Имя для подстановки в YQL
 */
export function quoteTable(name: string): string {
    if (!name.split('/').every((segment) => TABLE_SEGMENT_REGEXP.test(segment))) {
        throw new YqlBuildError(`Недопустимое имя таблицы: "${name}"`);
    }
    return `\`${name}\``;
}

/**
 * Проверяет имя колонки (или индекса) и возвращает его в обратных кавычках.
 * @param name Имя колонки
 * @returns Имя для подстановки в YQL
 */
export function quoteColumn(name: string): string {
    if (FORBIDDEN_KEYS.has(name) || !COLUMN_NAME_REGEXP.test(name)) {
        throw new YqlBuildError(`Недопустимое имя колонки: "${name}"`);
    }
    return `\`${name}\``;
}

/**
 * Набор параметров запроса: выдаёт имена `$p0`, `$p1`, ...
 */
class YqlParams {
    readonly params: Record<string, Value> = {};
    #index = 0;

    add(value: Value): string {
        const name = `$p${this.#index++}`;
        this.params[name] = value;
        return name;
    }
}

/**
 * Определяет тип колонки: из схемы таблицы, затем из правил модели.
 * @returns Тип колонки или undefined, если он неизвестен (тогда тип выводится из значения)
 */
function getColumnType(column: string, ctx: IYqlContext): TYdbColumnType | undefined {
    const fromSchema = ctx.table?.columns.get(column);
    if (fromSchema) {
        return fromSchema;
    }
    const rule = ctx.rules?.find((item) => item.name.includes(column));
    switch (rule?.type) {
        case 'string':
        case 'text':
            return 'Utf8';
        case 'int':
        case 'integer':
            return 'Int64';
        case 'bool':
            return 'Bool';
        default:
            return undefined;
    }
}

/**
 * Максимальная длина строки из правил модели (`max` у правил `string`/`text`).
 */
function getMaxLength(column: string, ctx: IYqlContext): number | undefined {
    const rule = ctx.rules?.find(
        (item) => (item.type === 'string' || item.type === 'text') && item.name.includes(column),
    );
    return rule?.max;
}

/**
 * Выводит тип колонки из JS-значения, когда ни схема, ни правила его не задают.
 */
function inferType(column: string, value: unknown): TYdbColumnType {
    switch (typeof value) {
        case 'string':
            return 'Utf8';
        case 'boolean':
            return 'Bool';
        case 'bigint':
            return 'Int64';
        case 'number':
            return Number.isInteger(value) ? 'Int64' : 'Double';
        default:
            throw new YqlBuildError(
                `Значение поля "${column}" имеет неподдерживаемый тип (${typeof value}). ` +
                    'Передайте строку, число или boolean, либо выполните запрос через query().',
            );
    }
}

/**
 * Приводит значение к целому для колонки Int64.
 */
function toBigInt(column: string, value: unknown): bigint {
    if (typeof value === 'bigint') {
        return value;
    }
    const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof num === 'number' && Number.isSafeInteger(num)) {
        return BigInt(num);
    }
    throw new YqlBuildError(`Поле "${column}" ожидает целое число, получено: ${String(value)}`);
}

/**
 * Приводит значение к строке для колонки Utf8 и обрезает его по `max` из правил модели.
 */
function toText(column: string, value: unknown, ctx: IYqlContext): string {
    const text =
        typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    const max = getMaxLength(column, ctx);
    return max === undefined ? text : UmbotText.resize(text, max);
}

/**
 * Превращает значение (не null и не undefined) в типизированное значение YDB.
 * @param column Имя колонки
 * @param value Значение
 * @param type Тип колонки
 * @param ctx Контекст запроса
 * @returns Значение для параметра запроса
 */
function toYdbValue(column: string, value: unknown, type: TYdbColumnType, ctx: IYqlContext): Value {
    switch (type) {
        case 'Utf8':
            return new Text(toText(column, value, ctx));
        case 'Int64':
            return new Int64(toBigInt(column, value));
        case 'Double': {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                throw new YqlBuildError(
                    `Поле "${column}" ожидает число, получено: ${String(value)}`,
                );
            }
            return new Double(num);
        }
        case 'Bool':
            return new Bool(value === true || value === 1 || value === '1' || value === 'true');
    }
}

/**
 * Добавляет значение колонки в параметры запроса.
 * @returns Имя параметра (`$pN`)
 */
function bindValue(column: string, value: unknown, ctx: IYqlContext, params: YqlParams): string {
    const type = getColumnType(column, ctx) ?? inferType(column, value);
    return params.add(toYdbValue(column, value, type, ctx));
}

/**
 * Собирает условие `IN` / `NOT IN` для списка значений.
 */
function buildInCondition(
    column: string,
    operator: '$in' | '$nin',
    value: unknown,
    ctx: IYqlContext,
    params: YqlParams,
): string {
    if (!Array.isArray(value)) {
        throw new YqlBuildError(`Оператор "${operator}" для поля "${column}" ожидает массив.`);
    }
    if (!value.length) {
        // Пустой список: IN не совпадает ни с чем, NOT IN — со всем
        return operator === '$in' ? 'FALSE' : 'TRUE';
    }
    if (value.some((item) => item === null || item === undefined)) {
        throw new YqlBuildError(
            `Оператор "${operator}" для поля "${column}" не принимает null; используйте $null.`,
        );
    }
    const type = getColumnType(column, ctx) ?? inferType(column, value[0]);
    const items = value.map((item: unknown) => toYdbValue(column, item, type, ctx));
    const name = params.add(new List(...items));
    return `${quoteColumn(column)} ${operator === '$in' ? 'IN' : 'NOT IN'} ${name}`;
}

/**
 * Собирает одно условие с оператором (`{ age: { $gt: 18 } }`).
 */
function buildOperatorCondition(
    column: string,
    operator: TOperator,
    value: unknown,
    ctx: IYqlContext,
    params: YqlParams,
): string {
    const quoted = quoteColumn(column);
    switch (operator) {
        case '$in':
        case '$nin':
            return buildInCondition(column, operator, value, ctx, params);
        case '$null':
            return `${quoted} ${value ? 'IS NULL' : 'IS NOT NULL'}`;
        case '$ne':
            if (value === null) {
                return `${quoted} IS NOT NULL`;
            }
            break;
    }
    if (value === null || value === undefined) {
        throw new YqlBuildError(`Оператор "${operator}" для поля "${column}" не принимает null.`);
    }
    return `${quoted} ${COMPARE_OPERATORS[operator]} ${bindValue(column, value, ctx, params)}`;
}

/**
 * Собирает условие для одного поля `IQueryData`.
 */
function buildFieldCondition(
    column: string,
    value: unknown,
    ctx: IYqlContext,
    params: YqlParams,
): string[] {
    if (value === undefined) {
        // «Условие», которого нет, для UPDATE/DELETE опаснее ошибки
        throw new YqlBuildError(`Условие для поля "${column}" не задано (undefined).`);
    }
    if (value === null) {
        return [`${quoteColumn(column)} IS NULL`];
    }
    if (Array.isArray(value)) {
        throw new YqlBuildError(
            `Условие для поля "${column}" — массив. Для списка значений используйте $in.`,
        );
    }
    if (typeof value !== 'object') {
        return [`${quoteColumn(column)} = ${bindValue(column, value, ctx, params)}`];
    }
    const conditions = value as Record<string, unknown>;
    const keys = Object.keys(conditions);
    if (!keys.length || !keys.every((key) => key.startsWith('$'))) {
        throw new YqlBuildError(
            `Условие для поля "${column}" не содержит операторов. Поддерживаются: ${SUPPORTED_OPERATORS.join(', ')}.`,
        );
    }
    return keys.map((key) => {
        if (!(SUPPORTED_OPERATORS as readonly string[]).includes(key)) {
            throw new YqlBuildError(
                `Неизвестный оператор "${key}" для поля "${column}". Поддерживаются: ${SUPPORTED_OPERATORS.join(', ')}.`,
            );
        }
        return buildOperatorCondition(column, key as TOperator, conditions[key], ctx, params);
    });
}

/**
 * Переводит условия `IQueryData` в выражение WHERE.
 * Скалярное значение — равенство, объект — набор операторов, null — `IS NULL`.
 * @returns Выражение без слова WHERE; пустая строка, если условий нет
 */
function buildWhere(where: IQueryData | null, ctx: IYqlContext, params: YqlParams): string {
    if (!where) {
        return '';
    }
    const parts: string[] = [];
    for (const column of Object.keys(where)) {
        parts.push(...buildFieldCondition(column, where[column], ctx, params));
    }
    return parts.join(' AND ');
}

/**
 * Поля, заданные в условии простым равенством с не-null значением.
 */
function getEqualityKeys(where: IQueryData | null): Set<string> {
    const keys = new Set<string>();
    if (where) {
        for (const key of Object.keys(where)) {
            const value = where[key];
            if (value !== null && value !== undefined && typeof value !== 'object') {
                keys.add(key);
            }
        }
    }
    return keys;
}

/**
 * Выбирает вторичный индекс для SELECT. YDB не использует индекс без явного `VIEW`,
 * поэтому поиск по (platform, path) в таблицах токенов без него шёл бы полным перебором.
 * @returns Имя индекса или undefined, если поиск идёт по первичному ключу или индекса нет
 */
export function chooseIndex(
    table: IYdbTableInfo | undefined,
    where: IQueryData | null,
): string | undefined {
    if (!table || !table.indexes.length) {
        return undefined;
    }
    const keys = getEqualityKeys(where);
    if (table.primaryKey.every((key) => keys.has(key))) {
        return undefined;
    }
    return table.indexes.find((index) => index.fields.every((field) => keys.has(field)))?.name;
}

/**
 * Собирает SELECT.
 * @param tableName Имя таблицы
 * @param where Условия выборки
 * @param isOne Нужна только одна запись
 * @param ctx Контекст запроса
 * @returns Запрос
 */
export function buildSelect(
    tableName: string,
    where: IQueryData | null,
    isOne: boolean,
    ctx: IYqlContext,
): IYqlStatement {
    const params = new YqlParams();
    const index = chooseIndex(ctx.table, where);
    const view = index ? ` VIEW ${quoteColumn(index)}` : '';
    const condition = buildWhere(where, ctx, params);
    const text =
        `SELECT * FROM ${quoteTable(tableName)}${view}` +
        (condition ? ` WHERE ${condition}` : '') +
        (isOne ? ' LIMIT 1' : '');
    return { text, params: params.params };
}

/**
 * Собирает UPSERT одной записи. Поля со значением undefined пропускаются,
 * null записывается как NULL.
 * @param tableName Имя таблицы
 * @param data Данные записи
 * @param ctx Контекст запроса
 * @returns Запрос
 */
export function buildUpsert(tableName: string, data: IQueryData, ctx: IYqlContext): IYqlStatement {
    const params = new YqlParams();
    const columns: string[] = [];
    const values: string[] = [];
    for (const column of Object.keys(data)) {
        const value = data[column];
        if (value === undefined) {
            continue;
        }
        columns.push(quoteColumn(column));
        values.push(value === null ? 'NULL' : bindValue(column, value, ctx, params));
    }
    for (const key of ctx.table?.primaryKey ?? []) {
        if (data[key] === undefined || data[key] === null) {
            throw new YqlBuildError(
                `Не задано поле первичного ключа "${key}" таблицы "${tableName}".`,
            );
        }
    }
    if (!columns.length) {
        throw new YqlBuildError(`Нет данных для записи в таблицу "${tableName}".`);
    }
    const text = `UPSERT INTO ${quoteTable(tableName)} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
    return { text, params: params.params };
}

/**
 * Собирает UPDATE. Колонки первичного ключа из SET убираются: YDB не меняет ключ
 * записи, а модель umbot передаёт `uniqueKeys` и в данных, и в условии.
 * @param tableName Имя таблицы
 * @param data Новые значения
 * @param where Условия (обязательны)
 * @param ctx Контекст запроса
 * @returns Запрос или null, если менять нечего
 */
export function buildUpdate(
    tableName: string,
    data: IQueryData,
    where: IQueryData | null,
    ctx: IYqlContext,
): IYqlStatement | null {
    const params = new YqlParams();
    const primaryKey = ctx.table?.primaryKey ?? [];
    const assignments: string[] = [];
    for (const column of Object.keys(data)) {
        const value = data[column];
        if (value === undefined || primaryKey.includes(column)) {
            continue;
        }
        const bound = value === null ? 'NULL' : bindValue(column, value, ctx, params);
        assignments.push(`${quoteColumn(column)} = ${bound}`);
    }
    const condition = buildWhere(where, ctx, params);
    if (!condition) {
        throw new YqlBuildError(`UPDATE таблицы "${tableName}" без условий запрещён.`);
    }
    if (!assignments.length) {
        return null;
    }
    const text = `UPDATE ${quoteTable(tableName)} SET ${assignments.join(', ')} WHERE ${condition}`;
    return { text, params: params.params };
}

/**
 * Собирает DELETE.
 * @param tableName Имя таблицы
 * @param where Условия (обязательны: удаление всей таблицы этим методом запрещено)
 * @param ctx Контекст запроса
 * @returns Запрос
 */
export function buildDelete(
    tableName: string,
    where: IQueryData | null,
    ctx: IYqlContext,
): IYqlStatement {
    const params = new YqlParams();
    const condition = buildWhere(where, ctx, params);
    if (!condition) {
        throw new YqlBuildError(`DELETE из таблицы "${tableName}" без условий запрещён.`);
    }
    return {
        text: `DELETE FROM ${quoteTable(tableName)} WHERE ${condition}`,
        params: params.params,
    };
}

/**
 * Описание вторичного индекса для CREATE TABLE / ALTER TABLE.
 * Индекс синхронный: запись, только что сохранённая через UPSERT, сразу видна в поиске по индексу.
 */
function indexDefinition(index: IYdbIndexInfo): string {
    return `INDEX ${quoteColumn(index.name)} GLOBAL SYNC ON (${index.fields.map(quoteColumn).join(', ')})`;
}

/**
 * Собирает CREATE TABLE IF NOT EXISTS. Колонки ключа объявляются NOT NULL.
 * @param table Описание таблицы
 * @returns Текст запроса
 */
export function buildCreateTable(table: IYdbTableInfo): string {
    const lines: string[] = [];
    for (const [column, type] of table.columns) {
        const notNull = table.primaryKey.includes(column) ? ' NOT NULL' : '';
        lines.push(`${quoteColumn(column)} ${type}${notNull}`);
    }
    for (const index of table.indexes) {
        lines.push(indexDefinition(index));
    }
    lines.push(`PRIMARY KEY (${table.primaryKey.map(quoteColumn).join(', ')})`);
    return `CREATE TABLE IF NOT EXISTS ${quoteTable(table.tableName)} (\n    ${lines.join(',\n    ')}\n)`;
}

/**
 * Собирает запрос-проверку: выполняется без ошибок, только если таблица, все её колонки
 * и индексы уже есть. Данные не читаются (`LIMIT 0`).
 * @param table Описание таблицы
 * @returns Текст запроса (несколько SELECT через `;`)
 */
export function buildSchemaCheck(table: IYdbTableInfo): string {
    const name = quoteTable(table.tableName);
    const columns = [...table.columns.keys()].map(quoteColumn).join(', ');
    const statements = [`SELECT ${columns} FROM ${name} LIMIT 0;`];
    for (const index of table.indexes) {
        const fields = index.fields.map(quoteColumn).join(', ');
        statements.push(`SELECT ${fields} FROM ${name} VIEW ${quoteColumn(index.name)} LIMIT 0;`);
    }
    return statements.join('\n');
}

/**
 * Собирает проверку наличия одной колонки.
 */
export function buildColumnCheck(tableName: string, column: string): string {
    return `SELECT ${quoteColumn(column)} FROM ${quoteTable(tableName)} LIMIT 0`;
}

/**
 * Собирает ALTER TABLE ... ADD COLUMN.
 */
export function buildAddColumn(tableName: string, column: string, type: TYdbColumnType): string {
    return `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} ${type}`;
}

/**
 * Собирает проверку наличия индекса.
 */
export function buildIndexCheck(tableName: string, index: IYdbIndexInfo): string {
    const fields = index.fields.map(quoteColumn).join(', ');
    return `SELECT ${fields} FROM ${quoteTable(tableName)} VIEW ${quoteColumn(index.name)} LIMIT 0`;
}

/**
 * Собирает ALTER TABLE ... ADD INDEX.
 */
export function buildAddIndex(tableName: string, index: IYdbIndexInfo): string {
    return `ALTER TABLE ${quoteTable(tableName)} ADD ${indexDefinition(index)}`;
}

/**
 * Экранирует строку для подстановки внутрь строкового литерала YQL (`'...'` или `"..."`).
 * Адаптер сам так не делает — все значения уходят параметрами; функция нужна тем,
 * кто собирает свой запрос через `model.escapeString()`.
 * @param value Значение
 * @returns Строка с экранированными обратным слешем, кавычками и управляющими символами
 */
export function escapeYqlString(value: string | number): string {
    return String(value).replace(/[\\'"\n\r\0]/g, (char) => {
        switch (char) {
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';
            case '\0':
                return '\\x00';
            default:
                return '\\' + char;
        }
    });
}

/**
 * Приводит значение из ответа YDB к виду, который понимают модели umbot:
 * Int64 приходит как bigint, а JSON.stringify и сравнения с числами на нём ломаются.
 * @param row Строка результата
 * @returns Строка с bigint, переведёнными в number (или в строку, если не помещаются)
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
        const value = row[key];
        if (typeof value === 'bigint') {
            const num = Number(value);
            result[key] = Number.isSafeInteger(num) ? num : value.toString();
        } else {
            result[key] = value;
        }
    }
    return result;
}
