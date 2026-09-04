import { q } from "./db.ts";
import { sendTelegramMessage } from "./telegram.ts";
import { pollAccountById } from "./poller.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const DEFAULT_LEAGUE = Deno.env.get("DEFAULT_LEAGUE") ?? "Runes of Aldur";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ACCOUNT_RE = /^\S+#\d+$/;

const HELP_TEXT =
  "Команды:\n" +
  "/watch Name#1234 [лига] - отслеживать продажи аккаунта\n" +
  "/unwatch Name#1234 - прекратить отслеживание\n" +
  "/list - список отслеживаемых аккаунтов\n" +
  `/help - эта справка\n\nЛига по умолчанию: ${DEFAULT_LEAGUE}`;

async function handleMessage(msg: any): Promise<void> {
  const chatId: number = msg.chat.id;
  const parts = String(msg.text).trim().split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  const reply = (text: string) => sendTelegramMessage(BOT_TOKEN, chatId, text);

  if (command === "/start" || command === "/help") {
    await reply(HELP_TEXT);
    return;
  }

  if (command === "/watch") {
    const accountName = args[0] ?? "";
    const league = args.slice(1).join(" ") || DEFAULT_LEAGUE;
    if (!ACCOUNT_RE.test(accountName)) {
      await reply("Формат: /watch Name#1234 [лига]\nПример: /watch SomePlayer#1234");
      return;
    }
    const { rows } = await q(
      `insert into watched_accounts (telegram_chat_id, account_name, league, active, poll_filters, report_pending)
       values ($1, $2, $3, true, null, true)
       on conflict (telegram_chat_id, account_name, league) do update set
         active = true, poll_filters = null, report_pending = true
       returning id`,
      [chatId, accountName, league],
    );
    await reply(
      `⏳ Аккаунт ${accountName} (лига: ${league}) добавлен.\n` +
        `Запускаю первичный опрос - по завершении пришлю количество отслеживаемых лотов. ` +
        `У крупных магазинов это может занять пару минут.`,
    );
    // Немедленный опрос в фоне - отчёт пришлёт сам поллер (report_pending)
    pollAccountById(rows[0].id).catch((e) => console.error("manual poll failed:", e));
    return;
  }

  if (command === "/unwatch") {
    const accountName = args[0] ?? "";
    if (!ACCOUNT_RE.test(accountName)) {
      await reply("Формат: /unwatch Name#1234");
      return;
    }
    const { rows } = await q(
      `update watched_accounts set active = false
       where telegram_chat_id = $1 and account_name = $2
       returning id`,
      [chatId, accountName],
    );
    if (rows.length === 0) {
      await reply(`Аккаунт ${accountName} не найден в списке.`);
      return;
    }
    // Сразу чистим отслеживаемые лоты (история продаж остаётся)
    await q("delete from listed_items where account_id = any($1::bigint[])", [rows.map((r: any) => r.id)]);
    await reply(`🛑 Аккаунт ${accountName} отключён, данные опроса удалены из базы.`);
    return;
  }

  if (command === "/list") {
    const { rows } = await q(
      "select account_name, league, active from watched_accounts where telegram_chat_id = $1 order by created_at",
      [chatId],
    );
    if (rows.length === 0) {
      await reply("Список пуст. Добавь аккаунт: /watch Name#1234");
    } else {
      const lines = rows.map((a: any) => `${a.active ? "✅" : "🛑"} ${a.account_name} - ${a.league}`);
      await reply("Отслеживаемые аккаунты:\n" + lines.join("\n"));
    }
    return;
  }

  await reply("Неизвестная команда.\n\n" + HELP_TEXT);
}

export async function runBot(stop: () => boolean): Promise<void> {
  // На случай, если раньше был webhook - long polling с ним несовместим
  await fetch(`${API}/deleteWebhook`).catch(() => {});

  let offset = 0;
  while (!stop()) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (!data.ok) {
        console.error("getUpdates failed:", JSON.stringify(data).slice(0, 200));
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const upd of data.result) {
        offset = upd.update_id + 1;
        if (upd.message?.text && upd.message.chat?.id) {
          handleMessage(upd.message).catch((e) => console.error("handleMessage:", e));
        }
      }
    } catch (e) {
      console.error("getUpdates threw:", e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
