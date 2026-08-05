/**
 * Fire-and-forget push to the Telegram bot's /notify webhook, so a task assigned
 * in the web UI also pings the assignee in Telegram. No-op unless BOT_NOTIFY_URL
 * is configured (e.g. http://127.0.0.1:8080/notify), so the platform runs fine
 * with the bot offline.
 */
export function notifyBot(toPid: number, text: string): void {
  const url = process.env.BOT_NOTIFY_URL;
  if (!url) return;
  const secret = process.env.BOT_NOTIFY_SECRET;

  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Notify-Secret": secret } : {}),
    },
    body: JSON.stringify({ to_pid: toPid, text }),
  }).catch(() => {
    /* bot offline or unreachable — the web UI already reflects the change */
  });
}
