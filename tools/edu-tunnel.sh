#!/bin/bash
# Roll fresh Cloudflare quick tunnels until the random hostname contains an
# educational word (college/institute/school/etc.). If none hits within the
# attempt budget, keeps the last tunnel alive and reports it as the fallback.
cd "/c/Users/zeqrY/Downloads/CHALK (Game Website" || exit 1

CF="/c/Program Files (x86)/cloudflared/cloudflared.exe"
[ -x "$CF" ] || CF="cloudflared"
LOG="tools/edu-tunnel-run.log"
: > "$LOG"

KEYWORDS='institute|college|education|educate|academy|school|university|campus|learning|scholar|scholarship|faculty|student|teacher|teach|lecture|science|sciences|mathematics|math|library|study|studies|knowledge|degree|graduate|classroom|textbook|tutor|semester|algebra|biology|physics|chemistry'

MAX=45
FALLBACK_URL=""
FALLBACK_PID=""
HIT_URL=""
HIT_PID=""

for i in $(seq 1 $MAX); do
  # kill previous attempt's tunnel if any
  if [ -n "$FALLBACK_PID" ] && kill -0 "$FALLBACK_PID" 2>/dev/null; then
    kill "$FALLBACK_PID" 2>/dev/null
    sleep 1
  fi

  TLOG="tools/edu-tunnel-raw.log"
  "$CF" tunnel --url http://127.0.0.1:4173 > "$TLOG" 2>&1 &
  PID=$!

  URL=""
  for w in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TLOG" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "[$i] no URL (cloudflared exited?)" | tee -a "$LOG"
    kill "$PID" 2>/dev/null
    sleep 1
    continue
  fi

  HOST=$(echo "$URL" | sed -E 's#https://([a-z0-9-]+)\.trycloudflare\.com#\1#')
  FALLBACK_URL="$URL"
  FALLBACK_PID="$PID"

  if echo "$HOST" | grep -qE "$KEYWORDS"; then
    echo "[$i] HIT: $URL  ($HOST)" | tee -a "$LOG"
    echo "RESULT=HIT" | tee -a "$LOG"
    echo "URL=$URL" | tee -a "$LOG"
    echo "PID=$PID" | tee -a "$LOG"
    exit 0
  fi

  echo "[$i] miss: $HOST" | tee -a "$LOG"
  sleep 1
done

# no hit in budget: keep the last tunnel running as fallback
echo "RESULT=FALLBACK (no educational hostname in $MAX rolls)" | tee -a "$LOG"
echo "URL=$FALLBACK_URL" | tee -a "$LOG"
echo "PID=$FALLBACK_PID" | tee -a "$LOG"
