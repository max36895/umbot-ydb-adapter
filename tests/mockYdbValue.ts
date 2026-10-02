/**
 * Замена классов значений `@ydbjs/value` для тестов: SDK распространяется только как ESM,
 * а Jest собирает тесты в CommonJS. Каждое значение хранит тип колонки и JS-значение.
 */
export interface IMockValue {
    kind: string;
    value: unknown;
}

/**
 * Фабрика для `jest.mock('@ydbjs/value/primitive', ...)`.
 */
export function mockPrimitive(): Record<string, unknown> {
    const make = (kind: string): unknown =>
        class {
            kind = kind;
            value: unknown;
            constructor(value: unknown) {
                this.value = value;
            }
        };
    return { Text: make('Utf8'), Int64: make('Int64'), Double: make('Double'), Bool: make('Bool') };
}

/**
 * Фабрика для `jest.mock('@ydbjs/value/list', ...)`.
 */
export function mockList(): Record<string, unknown> {
    return {
        List: class {
            kind = 'List';
            value: unknown[];
            constructor(...items: unknown[]) {
                this.value = items;
            }
        },
    };
}
