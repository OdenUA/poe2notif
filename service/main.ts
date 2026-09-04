import { pollAll } from "./poller.ts";
import { runBot } from "./bot.ts";
import { pool } from "./db.ts";

const POLL_INTERVAL_MS = 15 * 60_000; // 15 минут

let stopped = false;
const stop = () => stopped;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => {
    console.log(`got ${sig}, shutting down`);
    stopped = true;
  });
}

async function scheduler(): Promise<void> {
  // Первый опрос почти сразу после старта
  await new Promise((r) => setTimeout(r, 5000));
  while (!stopped) {
    const started = Date.now();
    try {
      await pollAll();
    } catch (e) {
      console.error("pollAll failed:", e);
    }
    const elapsed = Date.now() - started;
    const wait = Math.max(POLL_INTERVAL_MS - elapsed, 10_000);
    console.log(`cycle done in ${Math.round(elapsed / 1000)}s, next in ${Math.round(wait / 60000)}min`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log("poe2notif service starting");
await Promise.all([scheduler(), runBot(stop)]);
await pool.end();
console.log("poe2notif service stopped");
