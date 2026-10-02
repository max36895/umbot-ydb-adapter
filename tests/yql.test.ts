jest.mock('@ydbjs/value/primitive', () => require('./mockYdbValue').mockPrimitive());
jest.mock('@ydbjs/value/list', () => require('./mockYdbValue').mockList());

import { DB_TABLES_SCHEMA } from 'umbot';
import type { IModelRules } from 'umbot';
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
    chooseIndex,
    escapeYqlString,
    normalizeRow,
    quoteColumn,
    quoteTable,
    tableInfoFromDefinition,
    tableInfoFromSchema,
    YqlBuildError,
} from '../src/yql';
import type { IYdbTableInfo, IYqlStatement } from '../src/yql';
import type { IMockValue } from './mockYdbValue';

const schema = (name: string): IYdbTableInfo => {
    const table = DB_TABLES_SCHEMA.find((item) => item.tableName === name);
    if (!table) {
        throw new Error(`Нет таблицы ${name}`);
    }
    return tableInfoFromSchema(table);
};

const users = schema('UsersData');
const images = schema('ImageTokens');

/** Параметры запроса в виде { $p0: ['Utf8', '42'] } */
const paramsOf = (statement: IYqlStatement): Record<string, [string, unknown]> => {
    const result: Record<string, [string, unknown]> = {};
    for (const [name, value] of Object.entries(statement.params)) {
        const mock = value as unknown as IMockValue;
        const inner = Array.isArray(mock.value)
            ? (mock.value as IMockValue[]).map((item) => [item.kind, item.value])
            : mock.value;
        result[name] = [mock.kind, inner];
    }
    return result;
};

describe('tableInfoFromSchema', () => {
    it('UsersData: ключ userId + platform, индекс по ключу не дублируется', () => {
        expect(users.primaryKey).toEqual(['userId', 'platform']);
        expect(users.indexes).toEqual([]);
        expect([...users.columns.values()].every((type) => type === 'Utf8')).toBe(true);
    });

    it('ImageTokens: ключ imageToken и индекс по (platform, path)', () => {
        expect(images.primaryKey).toEqual(['imageToken']);
        expect(images.indexes).toEqual([
            { name: 'idx_platform_path', fields: ['platform', 'path'] },
        ]);
    });
});

describe('tableInfoFromDefinition', () => {
    const orders = {
        tableName: 'shop/Orders',
        primaryKey: ['orderId'],
        columns: { orderId: 'Utf8', userId: 'Utf8', total: 'Double', paid: 'Bool', qty: 'Int64' },
        indexes: [['userId'], ['orderId']],
    } as const;

    it('берёт типы колонок и пропускает индекс, совпадающий с началом ключа', () => {
        const info = tableInfoFromDefinition(orders);
        expect(info.primaryKey).toEqual(['orderId']);
        expect(info.columns.get('total')).toBe('Double');
        expect(info.indexes).toEqual([{ name: 'idx_userId', fields: ['userId'] }]);
        expect(buildCreateTable(info)).toBe(
            [
                'CREATE TABLE IF NOT EXISTS `shop/Orders` (',
                '    `orderId` Utf8 NOT NULL,',
                '    `userId` Utf8,',
                '    `total` Double,',
                '    `paid` Bool,',
                '    `qty` Int64,',
                '    INDEX `idx_userId` GLOBAL SYNC ON (`userId`),',
                '    PRIMARY KEY (`orderId`)',
                ')',
            ].join('\n'),
        );
    });

    it('индексы необязательны', () => {
        const info = tableInfoFromDefinition({
            tableName: 'Logs',
            primaryKey: ['id'],
            columns: { id: 'Int64' },
        });
        expect(info.indexes).toEqual([]);
    });

    it.each([
        [{ ...orders, primaryKey: [] }, 'не задан первичный ключ'],
        [{ ...orders, primaryKey: ['nope'] }, 'Колонка "nope"'],
        [{ ...orders, indexes: [['missing']] }, 'Колонка "missing"'],
        [{ ...orders, columns: { ...orders.columns, extra: 'Json' } }, 'Неизвестный тип "Json"'],
        [{ ...orders, tableName: 'bad name' }, 'Недопустимое имя таблицы'],
        [
            { ...orders, columns: { ...orders.columns, 'bad-col': 'Utf8' } },
            'Недопустимое имя колонки',
        ],
    ])('отклоняет некорректное описание %#', (definition, message) => {
        expect(() => tableInfoFromDefinition(definition as never)).toThrow(message);
    });
});

describe('quoteTable / quoteColumn', () => {
    it('пропускает обычные имена и пути директорий', () => {
        expect(quoteTable('UsersData')).toBe('`UsersData`');
        expect(quoteTable('bots/my-bot/UsersData')).toBe('`bots/my-bot/UsersData`');
        expect(quoteColumn('user_id2')).toBe('`user_id2`');
    });

    it.each(['a`b', 'a b', 'users; DROP TABLE x', '', '1abc', '../x', 'a//b'])(
        'отклоняет имя таблицы %p',
        (name) => {
            expect(() => quoteTable(name)).toThrow(YqlBuildError);
        },
    );

    it.each(['__proto__', 'constructor', 'prototype', 'a-b', 'a`b', 'a.b'])(
        'отклоняет имя колонки %p',
        (name) => {
            expect(() => quoteColumn(name)).toThrow(YqlBuildError);
        },
    );
});

describe('buildSelect', () => {
    it('поиск по ключу UsersData: без VIEW, userId-число приводится к Utf8', () => {
        const statement = buildSelect('UsersData', { userId: 42, platform: 'telegram' }, true, {
            table: users,
        });
        expect(statement.text).toBe(
            'SELECT * FROM `UsersData` WHERE `userId` = $p0 AND `platform` = $p1 LIMIT 1',
        );
        expect(paramsOf(statement)).toEqual({ $p0: ['Utf8', '42'], $p1: ['Utf8', 'telegram'] });
    });

    it('поиск токена по platform + path идёт через индекс', () => {
        const statement = buildSelect(
            'ImageTokens',
            { path: '/img.png', platform: 'alisa' },
            true,
            {
                table: images,
            },
        );
        expect(statement.text).toBe(
            'SELECT * FROM `ImageTokens` VIEW `idx_platform_path` WHERE `path` = $p0 AND `platform` = $p1 LIMIT 1',
        );
    });

    it('поиск токена по ключу не использует индекс', () => {
        const statement = buildSelect('ImageTokens', { imageToken: 't1' }, false, {
            table: images,
        });
        expect(statement.text).toBe('SELECT * FROM `ImageTokens` WHERE `imageToken` = $p0');
    });

    it('без условий выбирает всю таблицу', () => {
        expect(buildSelect('UsersData', null, false, { table: users }).text).toBe(
            'SELECT * FROM `UsersData`',
        );
        expect(buildSelect('UsersData', {}, false, { table: users }).text).toBe(
            'SELECT * FROM `UsersData`',
        );
    });

    it('null в условии превращается в IS NULL', () => {
        const statement = buildSelect('UsersData', { meta: null }, false, { table: users });
        expect(statement.text).toBe('SELECT * FROM `UsersData` WHERE `meta` IS NULL');
        expect(statement.params).toEqual({});
    });

    it('операторы сравнения, LIKE и $null', () => {
        const statement = buildSelect(
            'Custom',
            {
                age: { $gt: 18, $lte: 65 },
                score: { $gte: 1.5, $lt: 10 },
                name: { $like: 'Ив%' },
                deleted: { $null: true },
                email: { $null: false },
            },
            false,
            {},
        );
        expect(statement.text).toBe(
            'SELECT * FROM `Custom` WHERE `age` > $p0 AND `age` <= $p1 AND `score` >= $p2 AND `score` < $p3' +
                ' AND `name` LIKE $p4 AND `deleted` IS NULL AND `email` IS NOT NULL',
        );
        expect(paramsOf(statement)).toEqual({
            $p0: ['Int64', 18n],
            $p1: ['Int64', 65n],
            $p2: ['Double', 1.5],
            $p3: ['Int64', 10n],
            $p4: ['Utf8', 'Ив%'],
        });
    });

    it('$ne: со значением — !=, с null — IS NOT NULL', () => {
        const statement = buildSelect('Custom', { a: { $ne: 'x' }, b: { $ne: null } }, false, {});
        expect(statement.text).toBe('SELECT * FROM `Custom` WHERE `a` != $p0 AND `b` IS NOT NULL');
    });

    it('$in / $nin передают список одним параметром', () => {
        const statement = buildSelect(
            'UsersData',
            { platform: { $in: ['alisa', 'vk'] }, userId: { $nin: [1, 2] } },
            false,
            { table: users },
        );
        expect(statement.text).toBe(
            'SELECT * FROM `UsersData` WHERE `platform` IN $p0 AND `userId` NOT IN $p1',
        );
        expect(paramsOf(statement)).toEqual({
            $p0: [
                'List',
                [
                    ['Utf8', 'alisa'],
                    ['Utf8', 'vk'],
                ],
            ],
            $p1: [
                'List',
                [
                    ['Utf8', '1'],
                    ['Utf8', '2'],
                ],
            ],
        });
    });

    it('пустой $in не совпадает ни с чем, пустой $nin — со всем', () => {
        const statement = buildSelect('Custom', { a: { $in: [] }, b: { $nin: [] } }, false, {});
        expect(statement.text).toBe('SELECT * FROM `Custom` WHERE FALSE AND TRUE');
    });

    it.each([
        [{ a: { $in: 'x' } }, 'ожидает массив'],
        [{ a: { $in: ['x', null] } }, 'не принимает null'],
        [{ a: { $regex: 'x' } }, 'Неизвестный оператор'],
        [{ a: { b: 1 } }, 'не содержит операторов'],
        [{ a: {} }, 'не содержит операторов'],
        [{ a: ['x'] }, 'используйте $in'],
        [{ a: undefined }, 'не задано'],
        [{ a: { $gt: null } }, 'не принимает null'],
        [{ a: { nested: true } }, 'не содержит операторов'],
        [{ 'a b': 1 }, 'Недопустимое имя колонки'],
        [{ a: new Date() }, 'не содержит операторов'],
    ])('отклоняет некорректное условие %p', (where, message) => {
        expect(() => buildSelect('Custom', where, false, {})).toThrow(message);
    });

    it('отклоняет значение неподдерживаемого типа', () => {
        expect(() => buildSelect('Custom', { a: { $gt: Symbol('x') } }, false, {})).toThrow(
            'неподдерживаемый тип',
        );
    });
});

describe('типизация значений', () => {
    const rules: IModelRules[] = [
        { name: ['title'], type: 'string', max: 5 },
        { name: ['count'], type: 'integer' },
        { name: ['active'], type: 'bool' },
        { name: ['created'], type: 'date' },
    ];

    it('берёт тип из правил модели и обрезает строку по max (как встроенные адаптеры — Text.resize)', () => {
        const statement = buildUpsert(
            'Custom',
            { title: 'Длинное название', count: '7', active: 'true', created: 1700000000 },
            { rules },
        );
        expect(paramsOf(statement)).toEqual({
            $p0: ['Utf8', 'Дл...'],
            $p1: ['Int64', 7n],
            $p2: ['Bool', true],
            $p3: ['Int64', 1700000000n],
        });
    });

    it('Bool: всё, кроме true / 1 / "1" / "true", — false', () => {
        const statement = buildUpsert('Custom', { active: 'false' }, { rules });
        expect(paramsOf(statement)).toEqual({ $p0: ['Bool', false] });
    });

    it('без схемы и правил выводит тип из значения', () => {
        const statement = buildUpsert(
            'Custom',
            { s: 'x', i: 3, f: 2.5, b: false, big: 9007199254740993n },
            {},
        );
        expect(paramsOf(statement)).toEqual({
            $p0: ['Utf8', 'x'],
            $p1: ['Int64', 3n],
            $p2: ['Double', 2.5],
            $p3: ['Bool', false],
            $p4: ['Int64', 9007199254740993n],
        });
    });

    it('объект в колонке Utf8 сохраняется как JSON', () => {
        const statement = buildUpsert(
            'UsersData',
            { userId: 'u1', platform: 'vk', data: { step: 2 } },
            { table: users },
        );
        expect(paramsOf(statement).$p2).toEqual(['Utf8', '{"step":2}']);
    });

    it.each([
        [{ count: 'abc' }, 'ожидает целое число'],
        [{ count: 1.5 }, 'ожидает целое число'],
        [{ count: '' }, 'ожидает целое число'],
    ])('отклоняет некорректное целое %p', (data, message) => {
        expect(() => buildUpsert('Custom', data, { rules })).toThrow(message);
    });

    it('отклоняет нечисловое значение для Double', () => {
        expect(() =>
            buildUpsert(
                'Custom',
                { f: 'x' },
                {
                    table: {
                        tableName: 'Custom',
                        primaryKey: [],
                        columns: new Map([['f', 'Double']]),
                        indexes: [],
                    },
                },
            ),
        ).toThrow('ожидает число');
    });
});

describe('buildUpsert', () => {
    it('пропускает undefined и записывает null как NULL', () => {
        const statement = buildUpsert(
            'UsersData',
            { userId: 'u1', platform: 'alisa', meta: null, data: undefined },
            { table: users },
        );
        expect(statement.text).toBe(
            'UPSERT INTO `UsersData` (`userId`, `platform`, `meta`) VALUES ($p0, $p1, NULL)',
        );
    });

    it('требует все поля первичного ключа', () => {
        expect(() =>
            buildUpsert('UsersData', { userId: 'u1', platform: null }, { table: users }),
        ).toThrow('первичного ключа "platform"');
        expect(() => buildUpsert('ImageTokens', { path: 'p' }, { table: images })).toThrow(
            'первичного ключа "imageToken"',
        );
    });

    it('отклоняет пустые данные', () => {
        expect(() => buildUpsert('Custom', { a: undefined }, {})).toThrow('Нет данных');
    });
});

describe('buildUpdate', () => {
    it('убирает колонки ключа из SET', () => {
        const statement = buildUpdate(
            'UsersData',
            { platform: 'vk', meta: null, data: '{}' },
            { userId: 'u1', platform: 'vk' },
            { table: users },
        );
        expect(statement?.text).toBe(
            'UPDATE `UsersData` SET `meta` = NULL, `data` = $p0 WHERE `userId` = $p1 AND `platform` = $p2',
        );
    });

    it('возвращает null, если менять нечего', () => {
        expect(
            buildUpdate(
                'UsersData',
                { platform: 'vk' },
                { userId: 'u1', platform: 'vk' },
                {
                    table: users,
                },
            ),
        ).toBeNull();
    });

    it('запрещает UPDATE без условий', () => {
        expect(() => buildUpdate('Custom', { a: 1 }, null, {})).toThrow('без условий');
        expect(() => buildUpdate('Custom', { a: 1 }, {}, {})).toThrow('без условий');
    });
});

describe('buildDelete', () => {
    it('удаляет по условию', () => {
        const statement = buildDelete('ImageTokens', { imageToken: 't1' }, { table: images });
        expect(statement.text).toBe('DELETE FROM `ImageTokens` WHERE `imageToken` = $p0');
    });

    it('запрещает DELETE без условий', () => {
        expect(() => buildDelete('Custom', null, {})).toThrow('без условий');
        expect(() => buildDelete('Custom', {}, {})).toThrow('без условий');
    });
});

describe('chooseIndex', () => {
    it('не выбирает индекс без схемы, без индексов и при неполном условии', () => {
        expect(chooseIndex(undefined, { a: 1 })).toBeUndefined();
        expect(chooseIndex(users, { platform: 'vk' })).toBeUndefined();
        expect(chooseIndex(images, { platform: 'vk' })).toBeUndefined();
        expect(chooseIndex(images, { platform: 'vk', path: { $in: ['a'] } })).toBeUndefined();
        expect(chooseIndex(images, { platform: 'vk', path: null })).toBeUndefined();
    });
});

describe('DDL', () => {
    it('CREATE TABLE: ключ NOT NULL, синхронный индекс', () => {
        expect(buildCreateTable(images)).toBe(
            'CREATE TABLE IF NOT EXISTS `ImageTokens` (\n' +
                '    `imageToken` Utf8 NOT NULL,\n' +
                '    `path` Utf8,\n' +
                '    `platform` Utf8,\n' +
                '    INDEX `idx_platform_path` GLOBAL SYNC ON (`platform`, `path`),\n' +
                '    PRIMARY KEY (`imageToken`)\n' +
                ')',
        );
        expect(buildCreateTable(users)).toContain('PRIMARY KEY (`userId`, `platform`)');
        expect(buildCreateTable(users)).toContain('`platform` Utf8 NOT NULL');
    });

    it('проверка схемы читает все колонки и индексы без данных', () => {
        expect(buildSchemaCheck(images)).toBe(
            'SELECT `imageToken`, `path`, `platform` FROM `ImageTokens` LIMIT 0;\n' +
                'SELECT `platform`, `path` FROM `ImageTokens` VIEW `idx_platform_path` LIMIT 0;',
        );
    });

    it('ALTER TABLE для колонки и индекса', () => {
        const index = images.indexes[0]!;
        expect(buildColumnCheck('UsersData', 'meta')).toBe(
            'SELECT `meta` FROM `UsersData` LIMIT 0',
        );
        expect(buildAddColumn('UsersData', 'meta', 'Utf8')).toBe(
            'ALTER TABLE `UsersData` ADD COLUMN `meta` Utf8',
        );
        expect(buildIndexCheck('ImageTokens', index)).toBe(
            'SELECT `platform`, `path` FROM `ImageTokens` VIEW `idx_platform_path` LIMIT 0',
        );
        expect(buildAddIndex('ImageTokens', index)).toBe(
            'ALTER TABLE `ImageTokens` ADD INDEX `idx_platform_path` GLOBAL SYNC ON (`platform`, `path`)',
        );
    });
});

describe('normalizeRow', () => {
    it('переводит bigint в number, а не помещающиеся — в строку', () => {
        expect(normalizeRow({ a: 5n, b: 9007199254740993n, c: 'x', d: null })).toEqual({
            a: 5,
            b: '9007199254740993',
            c: 'x',
            d: null,
        });
    });
});

describe('escapeYqlString', () => {
    it('экранирует обратный слеш, кавычки и управляющие символы', () => {
        const input = 'a\\b' + "'c" + '"d' + '\ne\rf\0g';
        expect(escapeYqlString(input)).toBe(String.raw`a\\b\'c\"d\ne\rf\x00g`);
        expect(escapeYqlString(42)).toBe('42');
        expect(escapeYqlString("x' OR '1'='1")).toBe(String.raw`x\' OR \'1\'=\'1`);
    });
});
