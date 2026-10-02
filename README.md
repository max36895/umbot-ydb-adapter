# umbot-ydb-adapter

[![npm version](https://img.shields.io/npm/v/umbot-ydb-adapter.svg)](https://www.npmjs.com/package/umbot-ydb-adapter)
[![npm downloads](https://img.shields.io/npm/dm/umbot-ydb-adapter.svg)](https://www.npmjs.com/package/umbot-ydb-adapter)
[![license](https://img.shields.io/npm/l/umbot-ydb-adapter.svg)](https://github.com/max36895/umbot-ydb-adapter/blob/main/LICENSE.md)
[![umbot](https://img.shields.io/badge/umbot-adapter-blue)](https://github.com/max36895/universal_bot-ts)

> YDB (Yandex Database) storage adapter for the [umbot](https://github.com/max36895/universal_bot-ts) bot framework:
> Alice skills and chat bots in Yandex Cloud Functions without a separate database server.

Адаптер [YDB](https://ydb.tech) для фреймворка [umbot](https://github.com/max36895/universal_bot-ts).

## Зачем

Главный сценарий — бот в **Yandex Cloud Functions**:

- у функции нет постоянного диска, поэтому `FileAdapter` там не работает;
- без адаптера БД `userData` на Telegram, VK, MAX и Viber живёт в памяти экземпляра функции и пропадает, когда
  запрос попадает в другой экземпляр (Алиса, Маруся и SmartApp хранят состояние в самом запросе — им БД нужна
  реже);
- кластер MongoDB или PostgreSQL — отдельный платный сервер, к которому из функций нужно ходить по сети с паролем.

YDB в режиме Serverless оплачивается за запросы, имеет бесплатный лимит и пускает функцию по её сервисному аккаунту —
паролей и токенов в коде нет.

## Возможности

- Хранит `UsersData`, `ImageTokens`, `SoundTokens` и данные ваших моделей.
- **Таблицы создаются сами.** Встроенные — всегда, ваши — по описанию в опции `tables`. Если схема уже готова, на
  холодном старте функции выполняется один запрос-проверка.
- Все значения уходят в запрос параметрами (`$p0`, `$p1`, ...), имена таблиц и колонок проверяются. `UPDATE` и
  `DELETE` без условий не выполняются.
- Ограниченные таймауты на подключение и на каждый запрос.
- Ошибки не бросаются: `select` возвращает `{ status: false, error }`, `insert`/`update`/`remove` — `false`.

## Требования

- Node.js `>= 20.19.0`
- `umbot >= 3.1.4` (peer-зависимость)

## Установка

```bash
npm install umbot umbot-ydb-adapter
```

## Быстрый старт: Yandex Cloud Functions

1. Создайте базу YDB в режиме **Serverless** и скопируйте её эндпоинт — строку вида
   `grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/b1g.../etn...`.
2. Создайте сервисный аккаунт с ролью `ydb.editor` (чтение, запись и создание таблиц).
3. В версии функции укажите этот сервисный аккаунт и переменную окружения `YDB_CONNECTION_STRING` с эндпоинтом.

```ts
import { Bot } from 'umbot';
import { fullPlatforms } from 'umbot/plugins';
import { YdbAdapter } from 'umbot-ydb-adapter';

const bot = new Bot();
bot.use(fullPlatforms);
// Строка подключения — из YDB_CONNECTION_STRING, токен — от сервисного аккаунта функции
bot.use(new YdbAdapter({ options: { credentials: 'metadata' } }));

export const handler = async (event: Record<string, unknown>) => {
    const rawBody = typeof event.body === 'string' ? event.body : '';
    const content =
        typeof event.body !== 'string'
            ? JSON.stringify(event.body ?? '')
            : event.isBase64Encoded === true
              ? Buffer.from(rawBody, 'base64').toString('utf8')
              : rawBody;
    const headers = (event.headers ?? {}) as Record<string, unknown>;
    const requestContext = event.requestContext as { identity?: { sourceIp?: string } } | undefined;
    const result = await bot.webhookEvent(content, headers, requestContext?.identity?.sourceIp);
    return {
        statusCode: result.statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? ''),
    };
};
```

Код `handler` повторяет раздел [Serverless](https://www.maxim-m.ru/docs/umbot/v-3.1/guides/deployment) документации
umbot. Проект с готовым `handler` и скриптом деплоя создаёт `npx umbot create from-flow flow.json --usecloud` —
останется добавить строку `bot.use(new YdbAdapter(...))`.

При первом запросе адаптер подключится к базе и создаст таблицы `UsersData`, `ImageTokens`, `SoundTokens`.

## Локальная разработка

**С облачной базой:** подставьте IAM-токен своего аккаунта Yandex Cloud.

```bash
export YDB_CONNECTION_STRING="grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/..."
export YDB_ACCESS_TOKEN_CREDENTIALS="$(yc iam create-token)"
```

```ts
bot.use(new YdbAdapter()); // авторизация по умолчанию — из переменных окружения
```

IAM-токен живёт ограниченное время — когда он истечёт, получите новый через `yc iam create-token`.

**С локальным YDB в Docker:**

```bash
docker run -d --rm --name ydb-local -h localhost -p 2135:2135 -p 2136:2136 -p 8765:8765 \
  -e GRPC_TLS_PORT=2135 -e GRPC_PORT=2136 -e MON_PORT=8765 ydbplatform/local-ydb:latest
```

```ts
bot.use(
    new YdbAdapter({
        host: 'grpc://localhost:2136',
        database: '/local',
        options: { credentials: 'anonymous' },
    }),
);
```

Веб-интерфейс локальной базы — `http://localhost:8765`.

## Подключение

Строка подключения выбирается так (первое заданное):

1. `options.connectionString`;
2. `host` + `database` — из конструктора или из `appConfig.db` (umbot заполняет его и из `DB_HOST` / `DB_NAME`);
3. переменная окружения `YDB_CONNECTION_STRING`.

```ts
new YdbAdapter({
    host: 'grpcs://ydb.serverless.yandexcloud.net:2135', // эндпоинт
    database: '/ru-central1/b1g.../etn...', // путь базы
    options: { credentials: 'metadata', queryTimeout: 3000 },
});
```

### Опции (`options`)

| Опция              | По умолчанию                                | Описание                                                               |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| `connectionString` | —                                           | Полная строка подключения                                              |
| `credentials`      | `user`/`pass`, если заданы, иначе `environ` | Способ авторизации (см. ниже)                                          |
| `tables`           | —                                           | Таблицы ваших моделей (см. «Свои таблицы»)                             |
| `ensureSchema`     | `true`                                      | Создавать недостающие таблицы, колонки и индексы после подключения     |
| `connectTimeout`   | `10000`                                     | Сколько ждать подключения (discovery, получение токена), мс            |
| `queryTimeout`     | `5000`                                      | Ограничение на запрос вместе с повторами SDK, мс; DDL — не меньше 30 с |
| `poolSize`         | `50` (значение SDK)                         | Максимум одновременных сессий YDB                                      |

### Авторизация (`credentials`)

| Значение        | Когда использовать                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `'metadata'`    | Cloud Functions и виртуальные машины Yandex Cloud: токен сервисного аккаунта из сервиса метаданных |
| `'environ'`     | Настройка переменными окружения YDB SDK (см. ниже)                                                 |
| `'anonymous'`   | Локальный YDB без авторизации                                                                      |
| `user` + `pass` | Логин и пароль пользователя YDB (не аккаунта Yandex Cloud)                                         |
| свой провайдер  | Любой `CredentialsProvider` из `@ydbjs/auth`                                                       |

Переменные для `'environ'` (берётся первая найденная):

- `YDB_ANONYMOUS_CREDENTIALS=1` — без авторизации;
- `YDB_METADATA_CREDENTIALS=1` — сервис метаданных;
- `YDB_ACCESS_TOKEN_CREDENTIALS=<токен>` — IAM-токен;
- `YDB_STATIC_CREDENTIALS_USER` / `YDB_STATIC_CREDENTIALS_PASSWORD` — логин и пароль YDB.

Не храните токены и пароли в коде, `serverless.yml` и `package.json`: передавайте их переменными окружения или через
Yandex Lockbox.

## Таблицы

### Встроенные

Создавать вручную не нужно: после подключения umbot вызывает `ensureSchema`, и адаптер создаёт недостающее.

| Таблица       | Первичный ключ       | Индекс                                    |
| ------------- | -------------------- | ----------------------------------------- |
| `UsersData`   | `(userId, platform)` | —                                         |
| `ImageTokens` | `imageToken`         | `idx_platform_path` по `(platform, path)` |
| `SoundTokens` | `soundToken`         | `idx_platform_path` по `(platform, path)` |

Все колонки — `Utf8`, колонки ключа — `NOT NULL`. Индексы синхронные (`GLOBAL SYNC`): токен, сохранённый через
`UPSERT`, сразу находится поиском по пути. YDB использует вторичный индекс только при явном `VIEW`, поэтому адаптер
сам добавляет `VIEW idx_platform_path` в поиск токена по `(platform, path)`.

Если таблица уже есть, адаптер добавляет недостающие колонки и индексы, но не меняет и не удаляет существующие.

### Свои таблицы

В отличие от MongoDB, YDB не создаёт таблицу при первой записи: у таблицы должны быть первичный ключ и типы колонок.
Опишите таблицы своих моделей в опции `tables` — адаптер создаст их вместе со встроенными:

```ts
new YdbAdapter({
    options: {
        credentials: 'metadata',
        tables: [
            {
                tableName: 'Orders',
                primaryKey: ['orderId'],
                columns: { orderId: 'Utf8', userId: 'Utf8', total: 'Double', paid: 'Bool' },
                indexes: [['userId']], // поиск по userId пойдёт через VIEW idx_userId
            },
        ],
    },
});
```

Типы колонок: `Utf8`, `Int64`, `Double`, `Bool`. Значения приводятся к типу колонки: число `42` в колонке `Utf8`
запишется строкой `'42'`.

Для таблиц, не описанных в `tables` (созданных миграцией или вручную), тип значения берётся из правил модели
(`rules()`), а если правила нет — из самого значения:

| Правило модели   | Без правила           | Колонка YDB |
| ---------------- | --------------------- | ----------- |
| `string`, `text` | строка                | `Utf8`      |
| `int`, `integer` | целое число, `bigint` | `Int64`     |
| —                | дробное число         | `Double`    |
| `bool`           | `boolean`             | `Bool`      |

Строки обрезаются по `max` из правил модели — так же, как во встроенных адаптерах umbot.

### Без прав на создание таблиц

Если у сервисного аккаунта нет прав на DDL, создайте таблицы заранее (например, миграцией) и выключите проверку:
`options: { ensureSchema: false }`. Описания из `tables` при этом всё равно используются для типов и индексов.

## Условия

| Оператор                     | Пример                                      | YQL                 |
| ---------------------------- | ------------------------------------------- | ------------------- |
| равенство                    | `{ platform: 'vk' }`                        | `platform = $p0`    |
| `null`                       | `{ meta: null }`                            | `meta IS NULL`      |
| `$gt`, `$gte`, `$lt`, `$lte` | `{ age: { $gte: 18 } }`                     | `age >= $p0`        |
| `$ne`                        | `{ status: { $ne: 'banned' } }`             | `status != $p0`     |
| `$in`, `$nin`                | `{ platform: { $in: ['vk', 'telegram'] } }` | `platform IN $p0`   |
| `$like`                      | `{ name: { $like: 'Ив%' } }`                | `name LIKE $p0`     |
| `$null`                      | `{ deletedAt: { $null: true } }`            | `deletedAt IS NULL` |

`$ne` следует правилам SQL: записи, где поле `NULL`, под условие не попадают. Неизвестный оператор не превращается в
равенство — запрос отклоняется с ошибкой.

## Произвольный запрос

`query()` даёт клиент запросов SDK и драйвер. Значения в шаблонной строке `sql` тоже передаются параметрами:

```ts
const stats = await new UsersData(appContext).query(async (sql) => {
    const [[row]] = await sql`SELECT COUNT(*) AS cnt FROM UsersData WHERE platform = ${'vk'}`;
    return { status: true, data: row };
});
```

## Поведение и ограничения

- **Вставка — `UPSERT`.** Повторная запись с тем же ключом перезаписывает строку, поэтому SDK может безопасно
  повторить запрос после временной ошибки сети.
- **Запись — в Serializable-транзакции**: так YDB требует для таблиц со вторичными индексами.
- **`UPDATE` не меняет колонки ключа**: YDB этого не позволяет, а модель umbot передаёт `platform` и в данных, и в
  условии.
- **`UPDATE` и `DELETE` по полям вне ключа** читают таблицу целиком: YDB не использует вторичный индекс в этих
  запросах. Встроенные модели umbot меняют и удаляют записи только по ключу.
- **`Int64` из ответа** приходит числом; значения больше `Number.MAX_SAFE_INTEGER` — строкой.
- **Таймауты.** Если база не ответила за `queryTimeout`, `select` вернёт `{ status: false, error }`, и umbot не
  перезапишет `userData` этого запроса.
- **Типы колонок** ограничены `Utf8`, `Int64`, `Double`, `Bool`. Даты, JSON и другие типы храните строкой или
  работайте с ними через `query()`.

## Проверка на настоящей базе

Юнит-тесты работают с моками SDK. Проверить адаптер на своей базе:

```bash
YDB_CONNECTION_STRING="grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/..." \
YDB_ACCESS_TOKEN_CREDENTIALS="$(yc iam create-token)" \
npm run live
```

Скрипт создаёт встроенные таблицы, если их нет, пишет, читает и удаляет тестовые записи с платформой
`umbot-ydb-live-check`. Другие данные не трогает.

## Ссылки

- [История изменений](CHANGELOG.md)
- [Документация umbot](https://www.maxim-m.ru/docs/umbot/)
- [Адаптеры БД в umbot](https://www.maxim-m.ru/docs/umbot/v-3.1/guides/adapter/dbAdapter)
- [Документация YDB](https://ydb.tech/docs/ru/)

## Лицензия

[MIT](LICENSE.md)
