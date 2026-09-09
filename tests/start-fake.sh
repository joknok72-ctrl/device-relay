#!/usr/bin/env bash
# (Re)start the fake phone in the background for manual testing. Usage: tests/start-fake.sh [ttlMs]
cd "$(dirname "$0")/.."
for p in $(pgrep -f "fake-phone.mjs"); do [[ $p != $$ ]] && kill $p 2>/dev/null; done
sleep 1
TTL_MS=${1:-300000} nohup node tests/fake-phone.mjs > /tmp/fp.log 2>&1 &
disown
sleep 2
echo "fake phone pid $! (log /tmp/fp.log)"
