# poe2Notif

Уведомления в Telegram о проданных предметах на PoE2 Trade. Сервис опрашивает
официальный trade API pathofexile.com по списку аккаунтов и, когда предмет
пропадает из листинга (продан или снят), присылает в Telegram карточку:
иконка предмета, полное описание (как в попапе на сайте) и цена лота.

Telegram bot that notifies you when listed items disappear from a PoE2 trade
account (i.e. presumably sold) - with item icon, full description and price.
[English version below](#english).

## Возможности

- Слежение за любым количеством аккаунтов (не только своими)
- Карточка продажи: картинка, полные свойства и моды, цена, время листинга
- Первичный отчёт после подписки: сколько лотов отслеживается
- Самовосстановление: дискавери бакетов, редискавери при росте магазина,
  защита от ложных срабатываний при ошибках API и 429

## Команды бота

| Команда | Действие |
|---|---|
| `/watch Name#1234` | Отслеживать аккаунт в лиге по умолчанию |
| `/watch Name#1234 Runes of Aldur` | Отслеживать аккаунт в указанной лиге |
| `/unwatch Name#1234` | Отключить аккаунт и удалить его лоты из БД |
| `/list` | Список отслеживаемых аккаунтов |
| `/help` | Справка |

### Как указывать лигу

- Лига - это **весь текст после ника аккаунта**, пробелы допустимы:
  `/watch SomePlayer#1234 Runes of Aldur`
- Указывайте **точное английское название лиги**, как на сайте
  pathofexile.com/trade2 (например `Runes of Aldur`, `Standard`).
- Если лигу не указать - используется `DEFAULT_LEAGUE` из конфига сервиса.
- Смена лиги для уже отслеживаемого аккаунта: `/unwatch`, затем `/watch`
  с новой лигой (это разные записи - можно следить за одним аккаунтом
  в нескольких лигах одновременно).
- Ник аккаунта указывается в формате `Name#1234` (с дискриминатором),
  как в профиле на сайте.

## Как это работает

- Опрос каждые 15 минут (scheduler внутри процесса).
- Search API отдаёт максимум 100 лотов за запрос, и при равных ценах состав
  выдачи нестабилен (рандомные тай-брейки). Поэтому лоты аккаунта дробятся
  на **бакеты ≤100**: категория → редкость → бисекция по ilvl. Такой бакет
  отдаётся целиком одним запросом, и исчезновение лота из него - надёжный
  сигнал. Набор бакетов вычисляется дискавери при первом опросе и хранится
  в `watched_accounts.poll_filters`; переросший бакет запускает редискавери.
- Детали (иконка, описание, цена) тянутся через fetch API только для новых
  лотов. Если лот переоценили, в уведомлении будет цена на момент появления.
- Лот считается проданным, когда его нет в выдаче на очередном опросе
  (`MISSES_TO_SELL = 1`). Записи в `sales` дедуплицируются по лоту.
- Любая ошибка API (429, 5xx, сеть, таймаут 15 с) → аккаунт пропускается
  целиком, лоты **не** помечаются проданными.
- Rate limits GGG: пауза 3 с между поисками, 2 с между fetch, цикл 15 минут.

## Развёртывание (Linux + PostgreSQL)

Требования: VPS с Linux, PostgreSQL, systemd. Наружу нужны только исходящие
соединения (бот работает на long polling, публичный endpoint не нужен).

1. **БД**: создать пользователя и базу, применить схему:
   ```bash
   sudo -u postgres psql -c "CREATE USER poe2notif WITH PASSWORD '<пароль>';"
   sudo -u postgres psql -c "CREATE DATABASE poe2notif OWNER poe2notif;"
   psql "$DATABASE_URL" -f service/migrate.sql
   ```
2. **Deno**: скачать бинарник с https://github.com/denoland/deno/releases.
3. **Конфиг** (`/opt/poe2notif/secrets.env`, права 640):
   ```
   DATABASE_URL=postgres://poe2notif:<пароль>@127.0.0.1:5432/poe2notif
   TELEGRAM_BOT_TOKEN=<токен от @BotFather>
   DEFAULT_LEAGUE=Runes of Aldur
   ```
4. **systemd unit** (`/etc/systemd/system/poe2notif.service`):
   ```ini
   [Unit]
   Description=poe2Notif - PoE2 trade sale notifier
   After=network-online.target postgresql.service

   [Service]
   Type=simple
   User=poe2notif
   WorkingDirectory=/opt/poe2notif/app
   Environment=DENO_DIR=/opt/poe2notif/.deno-cache
   Environment=HOME=/opt/poe2notif
   EnvironmentFile=/opt/poe2notif/secrets.env
   ExecStart=/opt/poe2notif/deno run --allow-net --allow-env --allow-read service/main.ts
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl daemon-reload && systemctl enable --now poe2notif
   journalctl -u poe2notif -f
   ```

## Обновление кода

```bash
scp service/*.ts deno.json user@host:/opt/poe2notif/app/service/
ssh user@host systemctl restart poe2notif
```

## Rate limits GGG

Лимиты считаются **по IP** и отдаются в заголовках ответа
(`X-Rate-Limit-Ip`, `X-Rate-Limit-Ip-State`). Формат правила:
`запросы:окно_сек:бан_сек`. Актуальные значения для trade search API:

| Правило | Окно | Бан при превышении |
|---|---|---|
| 5 запросов | 10 сек | 60 сек |
| 15 запросов | 1 мин | 5 мин |
| 30 запросов | 5 мин | 30 мин |
| 600 запросов | 6 ч | 1 час |

Отдельный (более мягкий) пул лимитов у fetch API. При бане сервер отвечает
HTTP 429 с заголовком `Retry-After`.

Как сервис их соблюдает: пауза 3 с между search-запросами, 2 с между fetch,
цикл опроса 15 минут, при 429 аккаунт пропускается до следующего цикла.
Поэтому не уменьшайте интервалы без необходимости: для типичного аккаунта
(≤100 лотов) цикл стоит 1–2 запроса, для крупного магазина - по 1–2 запроса
на бакет (см. «Как это работает»).

## Ограничения

- «Пропал из листинга» ≠ гарантированная продажа: предмет могли снять вручную.
- Цена в уведомлении - последняя известная цена лота, не факт сделки.
- >100 лотов одной категории+редкости+ilvl - бакет неделим, покрытие частичное.
- Trade API неофициальный; соблюдайте rate limits GGG.

## Структура

```
service/
  main.ts        - точка входа: scheduler + бот + graceful shutdown
  poller.ts      - опрос trade API, бакеты, diff, уведомления
  bot.ts         - long polling, команды /watch /unwatch /list
  db.ts          - пул pg
  telegram.ts    - отправка сообщений/фото в Telegram
  format.ts      - рендер описания предмета «как на сайте»
  migrate.sql    - схема БД
deno.json        - deno task start / check
```

---

## English

Telegram notifications for sold items on the official Path of Exile 2 trade
site. A Deno service polls the trade API for watched accounts; when a listing
disappears (presumably sold), it sends a Telegram card with the item icon,
full description (like the in-site popup) and the listed price.

### Features

- Watch any number of accounts (not just your own)
- Sale card: icon, full properties/mods, price, listing time
- Initial report after subscribing: how many listings are tracked
- Self-healing: bucket discovery, re-discovery when a shop grows,
  false-positive protection on API errors and 429s

### Bot commands

| Command | Action |
|---|---|
| `/watch Name#1234` | Track account in the default league |
| `/watch Name#1234 Runes of Aldur` | Track account in the given league |
| `/unwatch Name#1234` | Stop tracking and delete its listings from the DB |
| `/list` | List tracked accounts |
| `/help` | Help |

**League syntax:** the league is everything after the account name, spaces
allowed - `/watch SomePlayer#1234 Runes of Aldur`. Use the exact English
league name as shown on pathofexile.com/trade2. If omitted, `DEFAULT_LEAGUE`
from the server config is used. One account can be watched in several leagues
at once (each league is a separate entry). Account names use the `Name#1234`
format (with discriminator), as shown in the website profile.

### How it works

- Polls every 15 minutes (in-process scheduler).
- The search API returns at most 100 listings per query, and tie-breaking on
  equal prices is unstable. So listings are split into **buckets of ≤100**:
  category → rarity → ilvl bisection. Such a bucket is returned in full by a
  single query, making disappearance a reliable signal. Buckets are computed
  by discovery on first poll and stored in `watched_accounts.poll_filters`;
  an overgrown bucket triggers re-discovery.
- Details (icon, description, price) are fetched only for new listings; if a
  listing is re-priced, the notification shows the price as first seen.
- A listing counts as sold after missing from one poll (`MISSES_TO_SELL = 1`);
  `sales` rows are deduplicated per listing.
- Any API error (429, 5xx, network, 15 s timeout) → the account is skipped
  entirely, nothing is marked sold.
- GGG rate limits: 3 s between searches, 2 s between fetches, 15-min cycle.

### Deployment (Linux + PostgreSQL)

Requirements: a Linux VPS with PostgreSQL and systemd. Only outbound
connectivity is required - the bot uses long polling, so no public endpoint,
nginx or TLS certificate is needed.

1. **Database**: create the user and database, apply the schema:
   ```bash
   sudo -u postgres psql -c "CREATE USER poe2notif WITH PASSWORD '<password>';"
   sudo -u postgres psql -c "CREATE DATABASE poe2notif OWNER poe2notif;"
   psql "$DATABASE_URL" -f service/migrate.sql
   ```
2. **Deno**: download the binary from https://github.com/denoland/deno/releases.
3. **Config** (`/opt/poe2notif/secrets.env`, mode 640):
   ```
   DATABASE_URL=postgres://poe2notif:<password>@127.0.0.1:5432/poe2notif
   TELEGRAM_BOT_TOKEN=<token from @BotFather>
   DEFAULT_LEAGUE=Runes of Aldur
   ```
4. **systemd unit** (`/etc/systemd/system/poe2notif.service`):
   ```ini
   [Unit]
   Description=poe2Notif - PoE2 trade sale notifier
   After=network-online.target postgresql.service

   [Service]
   Type=simple
   User=poe2notif
   WorkingDirectory=/opt/poe2notif/app
   Environment=DENO_DIR=/opt/poe2notif/.deno-cache
   Environment=HOME=/opt/poe2notif
   EnvironmentFile=/opt/poe2notif/secrets.env
   ExecStart=/opt/poe2notif/deno run --allow-net --allow-env --allow-read service/main.ts
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl daemon-reload && systemctl enable --now poe2notif
   journalctl -u poe2notif -f
   ```

### Updating the code

```bash
scp service/*.ts deno.json user@host:/opt/poe2notif/app/service/
ssh user@host systemctl restart poe2notif
```

### GGG rate limits

Limits are enforced **per IP** and reported in response headers
(`X-Rate-Limit-Ip`, `X-Rate-Limit-Ip-State`). Rule format:
`requests:window_seconds:ban_seconds`. Current values for the trade search API:

| Rule | Window | Ban when exceeded |
|---|---|---|
| 5 requests | 10 s | 60 s |
| 15 requests | 1 min | 5 min |
| 30 requests | 5 min | 30 min |
| 600 requests | 6 h | 1 hour |

The fetch API has its own, more lenient limit pool. When banned, the server
responds with HTTP 429 and a `Retry-After` header.

How the service stays within them: 3 s between search requests, 2 s between
fetches, a 15-minute poll cycle, and on 429 the account is skipped until the
next cycle. Don't shorten the intervals without need: a typical account
(≤100 listings) costs 1–2 requests per cycle; a large shop costs 1–2 requests
per bucket (see "How it works").

### Limitations

- A disappeared listing is not necessarily a sale (it may be delisted).
- The notified price is the last known listing price, not the deal price.
- >100 listings with the same category+rarity+ilvl make a bucket indivisible
  - partial coverage only.
- The trade API is unofficial; respect GGG's rate limits.

### Project structure

```
service/
  main.ts        - entry point: scheduler + bot + graceful shutdown
  poller.ts      - trade API polling, buckets, diff, notifications
  bot.ts         - long polling, /watch /unwatch /list commands
  db.ts          - pg pool
  telegram.ts    - Telegram message/photo sending
  format.ts      - item description rendering (like the in-site popup)
  migrate.sql    - DB schema
deno.json        - deno task start / check
```
