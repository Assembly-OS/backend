#!/bin/bash
#
# Держит публичный адрес платформы живым.
#
# Бесплатный туннель trycloudflare выдаёт временное имя и обрывается сам по
# себе — за один рабочий день это случилось трижды. Каждый обрыв выглядит
# одинаково: Mini App перестаёт открываться, потому что кнопка в Telegram
# ведёт на адрес, которого больше нет.
#
# Скрипт закрывает разрыв целиком: поднимает туннель, ждёт адрес, прописывает
# его боту, обновляет кнопку меню в Telegram и перезапускает бота. Дальше
# каждую минуту проверяет, что адрес ещё отвечает, и при обрыве повторяет всё
# сначала — уже с новым именем.
#
# Это не замена постоянному домену, а способ дожить до него без ручной
# перенастройки после каждого обрыва.
#
# Запуск:  bash scripts/tunnel-keeper.sh
# Остановка: Ctrl+C — туннель гасится вместе со скриптом.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOT_DIR="$ROOT/bot"
BOT_ENV="$BOT_DIR/.env"
LOG_DIR="${TUNNEL_LOG_DIR:-$ROOT/data/logs}"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
BOT_LOG="$LOG_DIR/bot.log"
LOCAL_URL="${PLATFORM_LOCAL_URL:-http://localhost:3000}"
CHECK_EVERY="${TUNNEL_CHECK_SECONDS:-20}"

mkdir -p "$LOG_DIR"

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$1"; }

# Ctrl+C гасит всё: человек за клавиатурой останавливает работу целиком.
#
# А вот SIGTERM — это обычно перезапуск самого надзора, и туннель при нём надо
# оставить жить. Раньше здесь стояло одно на оба сигнала, и перезапуск скрипта
# убивал исправный туннель: адрес менялся на пустом месте, а вместе с ним
# умирали все кнопки в ранее отправленных сообщениях бота.
on_interrupt() {
  log "останавливаю туннель"
  pkill -f "cloudflared tunnel --url $LOCAL_URL" 2>/dev/null
  exit 0
}
on_terminate() {
  log "выхожу, туннель оставляю работать"
  exit 0
}
trap on_interrupt INT
trap on_terminate TERM

bot_token() { grep '^BOT_TOKEN=' "$BOT_ENV" | cut -d= -f2- | tr -d '[:space:]'; }

# Адрес считается живым, только если отвечает страница входа. Один лишь
# процесс cloudflared ничего не доказывает: он остаётся запущенным и после
# того, как соединение с Cloudflare развалилось.
probe() {
  local url="$1" host="${1#https://}" ip code
  # Локальный DNS в офисе не отдаёт домены trycloudflare — резолвим через
  # публичный резолвер, иначе проверка вечно падала бы на исправном туннеле.
  ip="$(dig +short @1.1.1.1 "$host" 2>/dev/null | head -1)"
  [ -z "$ip" ] && return 1
  code="$(curl -s --resolve "$host:443:$ip" -o /dev/null -w '%{http_code}' \
          --max-time 15 "$url/login" 2>/dev/null)"
  [ "$code" = "200" ]
}

# Мёртвым адрес считается только после трёх неудач подряд.
#
# Одиночная проверка объявляла смерть при любой заминке — не успел
# распространиться свежий DNS, подвисла одна попытка — и надзор менял
# исправный туннель на новый. Адрес прыгал каждую минуту, а вместе с ним
# умирали все кнопки в уже отправленных сообщениях. Лишние десять секунд
# ожидания здесь дешевле, чем смена имени на ровном месте.
alive() {
  local url="$1"
  for _ in 1 2 3; do
    probe "$url" && return 0
    sleep 5
  done
  return 1
}

start_tunnel() {
  pkill -f "cloudflared tunnel --url $LOCAL_URL" 2>/dev/null
  sleep 2
  : > "$TUNNEL_LOG"
  # http2, не quic: на этой сети QUIC поднимается, а через несколько минут
  # роняет управляющий поток — «control stream encountered a failure».
  # Четыре соединения вместо одного. В журнале было видно, что туннель держал
  # ровно одно (connIndex=0), и каждый обрыв — а эта сеть рвёт их каждые
  # полторы минуты — убивал туннель целиком вместе с адресом. С запасом
  # соединений разрыв одного переживается молча.
  nohup cloudflared tunnel --url "$LOCAL_URL" --protocol http2 --no-autoupdate \
    --ha-connections 4 --retries 10 --grace-period 30s \
    >> "$TUNNEL_LOG" 2>&1 &

  local url=""
  for _ in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -z "$url" ] && { log "не удалось получить адрес"; return 1; }

  for _ in $(seq 1 20); do
    alive "$url" && break
    sleep 5
  done
  alive "$url" || { log "адрес $url не отвечает"; return 1; }

  printf '%s' "$url"
}

# Бот узнаёт адрес двумя путями: из .env при запуске и через кнопку меню,
# которую Telegram хранит у себя. Обновлять надо оба — иначе кнопка останется
# на мёртвом адресе, даже когда сам бот уже знает новый.
rewire_bot() {
  local url="$1" token
  token="$(bot_token)"

  sed -i '' "s|^PLATFORM_URL=.*|PLATFORM_URL=$url|" "$BOT_ENV"

  pkill -f "bot.py" 2>/dev/null
  sleep 2
  # Вебхук уведомлений держит 8080; если прошлый процесс не отпустил порт,
  # новый упадёт на старте с «address already in use».
  lsof -ti tcp:8080 2>/dev/null | xargs -r kill -9
  sleep 1

  ( cd "$BOT_DIR" && nohup .venv/bin/python bot.py >> "$BOT_LOG" 2>&1 & )
  sleep 6

  if [ -n "$token" ]; then
    curl -s -X POST "https://api.telegram.org/bot$token/setChatMenuButton" \
      -H 'Content-Type: application/json' \
      -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Platforma\",\"web_app\":{\"url\":\"$url/login\"}}}" \
      -o /dev/null
  fi

  pgrep -f bot.py >/dev/null && log "бот перезапущен на $url" \
                             || log "бот НЕ поднялся — смотри $BOT_LOG"
}

# Перезапуск надзора не должен менять адрес. Если туннель уже поднят и
# отвечает, он подхватывается как есть: каждая смена имени убивает все кнопки
# в ранее отправленных сообщениях бота, и делать это без нужды — значит
# ломать работающее ради перезапуска служебного скрипта.
current=""
if [ -f "$TUNNEL_LOG" ] && pgrep -f "cloudflared tunnel --url $LOCAL_URL" >/dev/null; then
  existing="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)"
  if [ -n "$existing" ] && alive "$existing"; then
    current="$existing"
    log "подхватил живой туннель: $current"
    rewire_bot "$current"
  fi
fi

while true; do
  if [ -z "$current" ] || ! alive "$current"; then
    [ -n "$current" ] && log "адрес $current перестал отвечать"
    if new_url="$(start_tunnel)" && [ -n "$new_url" ]; then
      current="$new_url"
      log "туннель поднят: $current"
      rewire_bot "$current"
    else
      log "повтор через 30 с"
      sleep 30
      continue
    fi
  fi
  sleep "$CHECK_EVERY"
done
