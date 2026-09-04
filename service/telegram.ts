const TELEGRAM_API = "https://api.telegram.org";

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;

export async function sendTelegramMessage(
  botToken: string,
  chatId: number | string,
  text: string,
): Promise<boolean> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, MESSAGE_LIMIT),
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error("sendMessage failed:", res.status, await res.text());
  }
  return res.ok;
}

/**
 * Фото с подписью. Если подпись длиннее лимита Telegram - шлёт фото
 * с короткой подписью, а полный текст отдельным сообщением.
 */
export async function sendTelegramItemCard(
  botToken: string,
  chatId: number | string,
  photoUrl: string | null,
  caption: string,
  fullText: string,
): Promise<boolean> {
  const shortCaption = caption.slice(0, CAPTION_LIMIT);
  const fitsInCaption = fullText.length <= CAPTION_LIMIT;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    caption: fitsInCaption ? fullText : shortCaption,
    disable_web_page_preview: true,
  };
  const method = photoUrl ? "sendPhoto" : "sendMessage";

  let res: Response;
  if (photoUrl) {
    res = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, photo: photoUrl }),
    });
  } else {
    res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: (fitsInCaption ? fullText : shortCaption).slice(0, MESSAGE_LIMIT),
        disable_web_page_preview: true,
      }),
    });
  }

  if (!res.ok) {
    console.error(`${method} failed:`, res.status, await res.text());
    // Если сервер не отдал картинку - пробуем хотя бы текстом.
    if (photoUrl) {
      return await sendTelegramMessage(botToken, chatId, fullText);
    }
    return false;
  }

  if (!fitsInCaption) {
    await sendTelegramMessage(botToken, chatId, fullText);
  }
  return true;
}
