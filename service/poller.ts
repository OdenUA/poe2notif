import { q } from "./db.ts";
import { sendTelegramItemCard, sendTelegramMessage } from "./telegram.ts";
import { describeItem } from "./format.ts";

const POE_BASE = "https://www.pathofexile.com";
const POE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const FETCH_BATCH = 10;
const REQUEST_DELAY_MS = 2000; // между fetch-запросами
const SEARCH_DELAY_MS = 3000; // между search-запросами (лимит 5/10с)
const BUCKET_CAP = 100; // бакет ≤100 детерминирован: search отдаёт его целиком
const MISSES_TO_SELL = 1; // сколько опросов подряд лот отсутствует → «продан»
const REQUEST_TIMEOUT_MS = 15_000;

// Категории type_filters, через которые дробим на первом уровне
const CATEGORIES = [
  "weapon", "armour", "accessory", "jewel", "gem",
  "map", "currency", "flask", "card", "sanctum",
];
// Второй уровень дробления - редкость
const RARITIES = ["unique", "rare", "magic", "normal"];

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

export interface Bucket {
  category?: string;
  rarity?: string;
  ilvl_min?: number;
  ilvl_max?: number;
}

export interface DiscoveryState {
  done: boolean;
  buckets: Bucket[];
  queue: Bucket[];
}

export interface WatchedAccount {
  id: number;
  telegram_chat_id: number;
  account_name: string;
  league: string;
  poll_filters: DiscoveryState | null;
  report_pending: boolean;
}

interface SearchResult {
  id: string;
  result: string[];
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poeRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", POE_UA);
  headers.set("Accept", "application/json");
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Referer", `${POE_BASE}/trade2/search/poe2`);
  // При 429 не ждём inline - выходим и продолжим на следующем цикле
  return await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function buildBody(account: WatchedAccount, bucket: Bucket, sortDir: "asc" | "desc") {
  const typeFilters: Record<string, unknown> = {};
  if (bucket.category) typeFilters.category = { option: bucket.category };
  if (bucket.rarity) typeFilters.rarity = { option: bucket.rarity };
  if (bucket.ilvl_min !== undefined || bucket.ilvl_max !== undefined) {
    typeFilters.ilvl = {
      ...(bucket.ilvl_min !== undefined ? { min: bucket.ilvl_min } : {}),
      ...(bucket.ilvl_max !== undefined ? { max: bucket.ilvl_max } : {}),
    };
  }
  return {
    query: {
      status: { option: "any" },
      filters: {
        trade_filters: { filters: { account: { input: account.account_name } } },
        ...(Object.keys(typeFilters).length > 0
          ? { type_filters: { filters: typeFilters } }
          : {}),
      },
      stats: [{ type: "and", filters: [] }],
    },
    sort: { price: sortDir },
  };
}

async function searchAccount(
  account: WatchedAccount,
  bucket: Bucket,
  sortDir: "asc" | "desc" = "asc",
): Promise<SearchResult | null> {
  const url = `${POE_BASE}/api/trade2/search/poe2/${encodeURIComponent(account.league)}`;
  let res: Response;
  try {
    res = await poeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(account, bucket, sortDir)),
    });
  } catch (e) {
    console.warn(`search ${JSON.stringify(bucket)} threw: ${e}`);
    return null;
  }
  if (!res.ok) {
    console.warn(
      `search(${sortDir}, ${JSON.stringify(bucket)}) ${account.account_name}: HTTP ${res.status}`,
      `rate-limit-state: ${res.headers.get("x-rate-limit-ip-state")}`,
    );
    return null;
  }
  return await res.json();
}

async function fetchListings(queryId: string, hashes: string[]): Promise<any[] | null> {
  const all: any[] = [];
  for (let i = 0; i < hashes.length; i += FETCH_BATCH) {
    const batch = hashes.slice(i, i + FETCH_BATCH);
    const url = `${POE_BASE}/api/trade2/fetch/${batch.join(",")}?query=${queryId}&realm=poe2`;
    let res: Response;
    try {
      res = await poeRequest(url);
    } catch (e) {
      console.warn(`fetch batch threw: ${e}`);
      return null;
    }
    if (!res.ok) {
      console.warn(
        `fetch failed: HTTP ${res.status}`,
        `rate-limit-state: ${res.headers.get("x-rate-limit-ip-state")}`,
      );
      return null;
    }
    const data = await res.json();
    all.push(...(data.result ?? []));
    if (i + FETCH_BATCH < hashes.length) await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

// Дискавери бакетов: узел > BUCKET_CAP дробится категория → редкость →
// бисекция по ilvl. Бакет ≤100 детерминирован: search отдаёт его целиком.
// Дедлайн формальный - на VPS нет wall-clock лимита, оставлен как страховка.
async function processDiscovery(
  account: WatchedAccount,
  state: DiscoveryState,
  deadline: number,
): Promise<DiscoveryState | null> {
  let first = true;

  while (state.queue.length > 0 && Date.now() < deadline) {
    const node = state.queue.shift()!;
    if (!first) await sleep(SEARCH_DELAY_MS);
    first = false;

    const r = await searchAccount(account, node);
    if (!r) {
      state.queue.unshift(node); // ошибка/429 - узел обратно, продолжим позже
      break;
    }

    if (r.total === 0) continue;
    if (r.total <= BUCKET_CAP) {
      state.buckets.push(node);
      continue;
    }
    if (!node.category) {
      for (const c of CATEGORIES) state.queue.push({ category: c });
    } else if (!node.rarity) {
      for (const rar of RARITIES) state.queue.push({ ...node, rarity: rar });
    } else if (node.ilvl_min === undefined) {
      state.queue.push(
        { ...node, ilvl_min: 0, ilvl_max: 49 },
        { ...node, ilvl_min: 50, ilvl_max: 100 },
      );
    } else if (node.ilvl_min! < node.ilvl_max!) {
      const mid = Math.floor((node.ilvl_min! + node.ilvl_max!) / 2);
      state.queue.push(
        { ...node, ilvl_max: mid },
        { ...node, ilvl_min: mid + 1 },
      );
    } else {
      console.warn(
        `${account.account_name}: неразделимый бакет ${JSON.stringify(node)} = ${r.total}, покрытие частичное`,
      );
      state.buckets.push(node);
    }
  }

  state.done = state.queue.length === 0;
  return state;
}

async function notifySale(account: WatchedAccount, sale: any): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set, skipping notification");
    return;
  }
  const caption =
    `💰 Предмет пропал из листинга (вероятно, продан)\n` +
    `${sale.item_name ?? sale.base_type ?? "?"}\n` +
    `Цена: ${sale.price_amount ?? "?"} ${sale.price_currency ?? ""}\n` +
    `Аккаунт: ${account.account_name} | Лига: ${account.league}`;

  const ok = await sendTelegramItemCard(
    BOT_TOKEN,
    account.telegram_chat_id,
    sale.icon,
    caption,
    sale.description ?? caption,
  );
  if (ok) {
    await q("update sales set notified = true where id = $1", [sale.id]);
  }
}

// Защита от параллельного опроса одного аккаунта (cron + ручной триггер)
const pollingNow = new Set<number>();

export async function pollAccount(account: WatchedAccount, budgetMs = 15 * 60_000): Promise<void> {
  if (pollingNow.has(account.id)) {
    console.log(`${account.account_name}: уже опрашивается, пропуск`);
    return;
  }
  pollingNow.add(account.id);
  try {
    await pollAccountInner(account, budgetMs);
  } finally {
    pollingNow.delete(account.id);
  }
}

async function pollAccountInner(account: WatchedAccount, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let state = account.poll_filters;

  while (!state || !state.done) {
    const prevQueue = state ? state.queue.length + state.buckets.length : -1;
    const next = await processDiscovery(
      account,
      state ?? { done: false, buckets: [], queue: [{}] },
      deadline,
    );
    if (!next) return;
    state = next;
    await q("update watched_accounts set poll_filters = $1 where id = $2", [
      JSON.stringify(state),
      account.id,
    ]);
    console.log(
      `${account.account_name}: discovery done=${state.done}, buckets=${state.buckets.length}, queue=${state.queue.length}`,
    );
    if (!state.done) {
      const nowQueue = state.queue.length + state.buckets.length;
      // Нет прогресса (429/сеть) - выходим и ждём следующий цикл планировщика,
      // а не долбим API в цикле
      if (Date.now() >= deadline || nowQueue === prevQueue) return;
      await sleep(SEARCH_DELAY_MS);
    }
  }
  if (Date.now() >= deadline) return;

  // Собираем хеши по всем бакетам. Бакет ≤100 отдаётся целиком одним
  // запросом; если бакет перерос - asc+desc как запасной вариант + редискавери.
  const allHashes = new Set<string>();
  let queryId: string | null = null;
  let rediscover = false;

  for (const bucket of state.buckets) {
    const asc = await searchAccount(account, bucket, "asc");
    if (!asc) return; // ошибка API - ничего не трогаем, чтобы не было ложных «продаж»
    queryId ??= asc.id;
    const bucketHashes = new Set(asc.result);

    if (asc.total > BUCKET_CAP) {
      const splittable = !bucket.category || !bucket.rarity ||
        bucket.ilvl_min === undefined || bucket.ilvl_min !== bucket.ilvl_max;
      if (splittable) rediscover = true;
      await sleep(SEARCH_DELAY_MS);
      const desc = await searchAccount(account, bucket, "desc");
      if (!desc) return;
      for (const h of desc.result) bucketHashes.add(h);
      console.warn(
        `${account.account_name}: бакет ${JSON.stringify(bucket)} перерос: ${asc.total}, покрыто ${bucketHashes.size}`,
      );
    }
    for (const h of bucketHashes) allHashes.add(h);
    await sleep(SEARCH_DELAY_MS);
  }

  if (rediscover) {
    await q("update watched_accounts set poll_filters = null where id = $1", [account.id]);
  }

  const now = new Date().toISOString();

  // Все известные нам лоты аккаунта
  const { rows: tracked } = await q(
    `select id, item_hash, is_active, name, base_type, icon,
            price_amount, price_currency, details, first_seen_at, missed_count
     from listed_items where account_id = $1`,
    [account.id],
  );
  const trackedByHash = new Map(tracked.map((r: any) => [r.item_hash, r]));

  // Известные лоты, увиденные сейчас: last_seen, сброс счётчиков.
  // Детали заново не тянем - fetch только для новых лотов.
  const seenIds = tracked
    .filter((r: any) => allHashes.has(r.item_hash))
    .map((r: any) => r.id);
  if (seenIds.length > 0) {
    await q(
      "update listed_items set last_seen_at = $1, missed_count = 0, is_active = true where id = any($2::bigint[])",
      [now, seenIds],
    );
  }

  // Новые лоты: забираем детали (картинка, описание, цена)
  const newHashes = [...allHashes].filter((h) => !trackedByHash.has(h));
  if (newHashes.length > 0) {
    const listings = await fetchListings(queryId!, newHashes);
    if (listings === null) return; // fetch сломался - diff не делаем
    if (listings.length > 0) {
      const cols = [
        "account_id", "item_hash", "name", "base_type", "rarity", "icon",
        "price_amount", "price_currency", "details",
        "first_seen_at", "last_seen_at", "is_active", "missed_count",
      ];
      const params: unknown[] = [];
      const values = listings.map((entry, i) => {
        const base = i * cols.length;
        params.push(
          account.id,
          entry.id,
          entry.item?.name || null,
          entry.item?.typeLine ?? entry.item?.baseType ?? null,
          entry.item?.rarity ?? null,
          entry.item?.icon ?? null,
          entry.listing?.price?.amount ?? null,
          entry.listing?.price?.currency ?? null,
          JSON.stringify({ item: entry.item ?? null, listing: entry.listing ?? null }),
          now,
          now,
          true,
          0,
        );
        return `(${cols.map((_, j) => `$${base + j + 1}`).join(",")})`;
      });
      await q(
        `insert into listed_items (${cols.join(",")}) values ${values.join(",")}
         on conflict (account_id, item_hash) do update set
           last_seen_at = excluded.last_seen_at, is_active = true, missed_count = 0`,
        params,
      );
    }
  }

  // Diff: активные в БД, но отсутствующие в свежей выдаче.
  // Помечаем проданным только после MISSES_TO_SELL подряд пропусков.
  const missing = tracked.filter((r: any) => r.is_active && !allHashes.has(r.item_hash));
  const gone = [];
  for (const m of missing) {
    const misses = m.missed_count + 1;
    if (misses < MISSES_TO_SELL) {
      await q("update listed_items set missed_count = $1 where id = $2", [misses, m.id]);
    } else {
      gone.push(m);
    }
  }

  for (const g of gone) {
    await q("update listed_items set is_active = false, missed_count = 0 where id = $1", [g.id]);

    // Дедупликация: запись о продаже этого лота уже могла существовать
    const { rows: existing } = await q("select id from sales where item_id = $1 limit 1", [g.id]);
    if (existing.length > 0) continue;

    const description = g.details
      ? describeItem(g.details.item, g.details.listing)
      : (g.name ?? g.base_type ?? "Unknown item");

    const { rows: inserted } = await q(
      `insert into sales (item_id, account_id, item_name, base_type, icon,
                          price_amount, price_currency, description, listed_at, sold_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        g.id, account.id, g.name || g.base_type, g.base_type, g.icon,
        g.price_amount, g.price_currency, description, g.first_seen_at, now,
      ],
    );
    await notifySale(account, inserted[0]);
  }

  console.log(
    `${account.account_name}: seen=${seenIds.length}, new=${newHashes.length}, missing=${missing.length}, sold=${gone.length}`,
  );

  // Первый полный опрос после подписки - отчёт в Telegram
  if (account.report_pending) {
    const { rows } = await q(
      "select count(*)::int n from listed_items where account_id = $1 and is_active",
      [account.id],
    );
    await sendTelegramMessage(
      BOT_TOKEN,
      account.telegram_chat_id,
      `✅ ${account.account_name} (лига: ${account.league}): отслеживается ${rows[0].n} лотов.\n` +
        `Опрос - каждые 15 минут. При продаже пришлю карточку предмета.`,
    );
    await q("update watched_accounts set report_pending = false where id = $1", [account.id]);
  }
}

export async function pollAll(): Promise<void> {
  const { rows: accounts } = await q(
    "select id, telegram_chat_id, account_name, league, poll_filters, report_pending from watched_accounts where active",
  );
  for (const account of accounts) {
    try {
      await pollAccount(account);
    } catch (e) {
      console.error(`poll failed for ${account.account_name}:`, e);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

export async function pollAccountById(id: number): Promise<void> {
  const { rows } = await q(
    "select id, telegram_chat_id, account_name, league, poll_filters, report_pending from watched_accounts where id = $1 and active",
    [id],
  );
  if (rows.length > 0) await pollAccount(rows[0]);
}
