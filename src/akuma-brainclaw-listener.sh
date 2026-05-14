#!/bin/bash
# Brainclaw persistent listener for Akuma (acer machine)
# Stays connected 24/7, receives all team broadcasts
# Auto-reconnects on disconnect
#
# Run: bash akuma-brainclaw-listener.sh
# Or as systemd service: ~/.config/systemd/user/brainclaw-listener@akuma.service

BRAINCLAW_URL="${BRAINCLAW_URL:-ws://100.82.67.48:3002}"
CHANNEL="${CHANNEL:-team}"
AGENT="${AGENT:-akuma}"
LABEL="${LABEL:-Akuma-acer}"

CONNECTED=0

echo "[$AGENT] Brainclaw persistent listener starting..."
echo "[$AGENT] Target: $BRAINCLAW_URL | Channel: #$CHANNEL"

send_ws() {
  echo "$1"
}

receive_loop() {
  while true; do
    MSG=$(timeout 5 websocat -n1 "$BRAINCLAW_URL" 2>/dev/null || echo "")
    if [ -n "$MSG" ]; then
      echo "$MSG"
    fi
  done
}

# Register and subscribe, then listen
(
  echo '{"type":"register","agentId":"'"$AGENT"'","label":"'"$LABEL"'"}'
  echo '{"type":"subscribe","channel":"'"$CHANNEL"'"}'
  receive_loop
) | websocat --text "$BRAINCLAW_URL" 2>&1 | while read -r line; do
  echo "[$AGENT] $line"
done &
LISTENER_PID=$!

# Keep alive with periodic pings
while true; do
  sleep 30
  if kill -0 $LISTENER_PID 2>/dev/null; then
    echo "[$AGENT] listener alive (pid $LISTENER_PID)"
  else
    echo "[$AGENT] listener died, restarting in 5s..."
    sleep 5
    bash "$0" &
    exit 0
  fi
done
