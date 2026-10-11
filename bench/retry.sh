#!/usr/bin/env bash
# Re-measure excluded-but-real sites with the corrected user agent, then rebuild the funnel.
set -euo pipefail
cd "$(dirname "$0")/.."
node bench/funnel.js
for s in head tail tw; do
  f=bench/strata/retry-$s.txt
  [ -s "$f" ] || continue
  node bench/coverage.js --domains "$f" --stratum "$s" --sites 100000 --pages home,inner --out "bench/results/$s-retry"
done
node bench/funnel.js
echo "RETRY DONE"
