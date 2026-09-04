-- poe2Notif: схема БД для VPS (vanilla PostgreSQL, без pg_cron/pg_net)
-- Применить: psql -U poe2notif -d poe2notif -f migrate.sql

create table if not exists watched_accounts (
  id bigint generated always as identity primary key,
  telegram_chat_id bigint not null,
  account_name text not null,
  league text not null default 'Runes of Aldur',
  active boolean not null default true,
  poll_filters jsonb,
  report_pending boolean not null default true,
  created_at timestamptz not null default now(),
  unique (telegram_chat_id, account_name, league)
);

create table if not exists listed_items (
  id bigint generated always as identity primary key,
  account_id bigint not null references watched_accounts(id) on delete cascade,
  item_hash text not null,
  name text,
  base_type text,
  rarity text,
  icon text,
  price_amount numeric,
  price_currency text,
  details jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missed_count integer not null default 0,
  is_active boolean not null default true,
  unique (account_id, item_hash)
);

create table if not exists sales (
  id bigint generated always as identity primary key,
  item_id bigint references listed_items(id) on delete set null,
  account_id bigint references watched_accounts(id) on delete cascade,
  item_name text,
  base_type text,
  icon text,
  price_amount numeric,
  price_currency text,
  description text,
  listed_at timestamptz,
  sold_at timestamptz not null default now(),
  notified boolean not null default false
);

create index if not exists listed_items_active_idx on listed_items (account_id) where is_active;
create index if not exists sales_unnotified_idx on sales (account_id) where not notified;
