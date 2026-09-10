#!/bin/sh
# Clears anything left over from a previous dev run.
#
# Two things can survive a closed terminal and block the next start:
#   1. An orphaned nodemon (reparented to PID 1) that keeps watching this
#      project's files and respawning a server on the same port.
#   2. Whatever process currently holds the port.
#
# Both are handled here: TERM first, KILL only for what refuses to go.

set -u

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PORT=$(grep -E '^[[:space:]]*PORT=' "$PROJECT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-5011}

# 1. Orphaned nodemon watchers belonging to this project.
NODEMON_PIDS=$(pgrep -f "$PROJECT_DIR/node_modules/.bin/nodemon" 2>/dev/null || true)
if [ -n "$NODEMON_PIDS" ]; then
  echo "Stopping leftover nodemon watcher(s): $NODEMON_PIDS"
  kill $NODEMON_PIDS 2>/dev/null || true
  sleep 1
  STILL=$(pgrep -f "$PROJECT_DIR/node_modules/.bin/nodemon" 2>/dev/null || true)
  [ -n "$STILL" ] && kill -9 $STILL 2>/dev/null || true
fi

# 2. Whatever is listening on the port.
PORT_PIDS=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
if [ -n "$PORT_PIDS" ]; then
  echo "Freeing port $PORT (pid: $PORT_PIDS)"
  kill $PORT_PIDS 2>/dev/null || true
  sleep 1
  STILL=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
  if [ -n "$STILL" ]; then
    echo "Force killing $STILL"
    kill -9 $STILL 2>/dev/null || true
    sleep 1
  fi
fi

if [ -n "$(lsof -ti "tcp:$PORT" 2>/dev/null || true)" ]; then
  echo "Port $PORT is still occupied by another user's process. Not touching it."
  exit 1
fi

echo "Port $PORT is free."
exit 0
