# История изменений

## [1.0.0]

Первая версия.

### Добавлено

- `YdbAdapter` — адаптер umbot для YDB (Yandex Database) на официальном SDK `@ydbjs` v6.
- Подключение по `host` + `database`, `options.connectionString` или переменной `YDB_CONNECTION_STRING`.
- Авторизация: сервис метаданных (Cloud Functions), переменные окружения YDB SDK, логин и пароль YDB, анонимно или
  свой `CredentialsProvider`.
- `ensureSchema`: создание таблиц `UsersData`, `ImageTokens`, `SoundTokens` с индексами, добавление недостающих
  колонок и индексов; при готовой схеме — один запрос-проверка.
- Опция `tables`: свои таблицы с типами `Utf8`, `Int64`, `Double`, `Bool` и индексами создаются вместе со
  встроенными.
- Поиск по вторичному индексу через `VIEW` (YDB не выбирает индекс сам).
- Операторы условий `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`, `$nin`, `$like`, `$null`.
- `escapeString` экранирует строку для литерала YQL — для своих запросов через `model.escapeString()`.
- Таймауты подключения (`connectTimeout`) и запросов (`queryTimeout`), запись в Serializable-транзакции.
- `npm run live` — проверка адаптера на настоящей базе.
