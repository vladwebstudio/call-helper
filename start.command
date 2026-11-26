#!/bin/bash
# Запуск помічника розмови: whisper (локально) + сервер. Закрий вікно, щоб усе зупинити.
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
set -a; . ./.env; set +a

# 1) сертифікат для https (потрібен, щоб мікрофон працював на телефоні)
if [ ! -f certs/cert.pem ]; then
  mkdir -p certs
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=helper" -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
fi

# 2) whisper-server (безкоштовне розпізнавання на цьому Mac)
WPID=""
if [ "${STT_PROVIDER:-local}" = "local" ]; then
  WDIR="${WHISPER_DIR:-$(cd .. && pwd)/Транскрипция/whisper-bin}"
  BIN=$(ls "$WDIR"/whisper-server "$WDIR"/build/bin/whisper-server 2>/dev/null | head -1)
  MODEL="${WHISPER_MODEL:-$WDIR/models/ggml-small.bin}"
  if [ -n "$BIN" ] && [ -f "$MODEL" ]; then
    "$BIN" -m "$MODEL" -l "${STT_LANGUAGE:-uk}" --port 8178 -t "${WHISPER_THREADS:-6}" \
      --prompt "Розмова з клієнтом про курс, ціну, клієнти, реклама, дохід, оплата, подумати, дорого, немає часу." >/tmp/whisper-server.log 2>&1 &
    WPID=$!
    echo "Whisper запущено (pid $WPID), чекаю завантаження моделі…"; sleep 4
  else
    echo "⚠ whisper-server або модель не знайдено в: $WDIR"
    echo "  Вкажи WHISPER_DIR / WHISPER_MODEL у .env або перейди на STT_PROVIDER=groq."
  fi
fi
trap '[ -n "$WPID" ] && kill $WPID 2>/dev/null' EXIT INT TERM

( sleep 2; open "http://localhost:${LOCAL_PORT:-8080}" ) &
node server.mjs
