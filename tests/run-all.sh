#!/usr/bin/env bash
# Run e2e suites against a local relay (pm2 device-relay on :3000), restarting the fake phone before each suite.
# Usage: tests/run-all.sh [suite.sh ...]   (default: all)   → summary + /tmp/e2e-all.txt
cd "$(dirname "$0")/.."
suites=("$@"); [[ ${#suites[@]} -eq 0 ]] && suites=(e2e.sh e2e-v15.sh e2e-v16.sh e2e-v17.sh e2e-v18.sh e2e-v19.sh e2e-v20.sh e2e-v21.sh e2e-v22.sh e2e-v23.sh e2e-v24.sh e2e-v25.sh e2e-v41.sh e2e-v42.sh e2e-v43.sh e2e-v44.sh e2e-v45.sh e2e-v46.sh e2e-v47.sh e2e-v473.sh e2e-v48.sh)
out=/tmp/e2e-all.txt; : > $out
for s in "${suites[@]}"; do
  for p in $(pgrep -f "node tests/fake-phone"); do kill $p 2>/dev/null; done; sleep 1
  TTL_MS=120000 nohup node tests/fake-phone.mjs > /tmp/fp.log 2>&1 &
  sleep 2
  echo "### $s" >> $out
  timeout 110 bash tests/$s >> $out 2>&1
done
echo DONE >> $out
grep -h "PASSED" $out | awk '{p+=$2; f+=$4} END {print "TOTAL PASSED " p "  FAILED " f}'
