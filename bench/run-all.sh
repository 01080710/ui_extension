#!/usr/bin/env bash
# Stratified B1 pipeline. Run after the head (home-page) pass has finished.
#   audit (screenshots for human labels) → head inner pages → tail → tw
set -euo pipefail
cd "$(dirname "$0")/.."
R=bench/results
S=bench/strata

node -e 'const r=require("./'$R'/raw.json");console.log(r.filter(x=>x.status==="ok").map(x=>x.domain).join("\n"))' > $S/head-ok.txt

node bench/audit-sample.js --head $R/raw.json --strata $S --out $S/audit.txt
node bench/coverage.js --domains $S/audit.txt --stratum audit --sites 20 --pages home \
  --screens dark/A,brutalism/B --out $R/audit
echo "AUDIT READY"

node bench/coverage.js --domains $S/head-ok.txt --stratum head --sites 100 --pages inner --out $R/head-inner
node bench/coverage.js --domains $S/tail.txt --stratum tail --sites 100 --pages home,inner --out $R/tail
node bench/coverage.js --domains $S/tw.txt --stratum tw --sites 50 --pages home,inner --out $R/tw
echo "ALL STRATA DONE"
