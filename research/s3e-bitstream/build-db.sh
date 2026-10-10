#!/bin/bash
# Rebuilds db/xc3s250e-layout.json and db/xc3s250e-tiles.json from the experiments' results in $W
# (bitstreams made by run-many.sh; nothing of it is in the repository):
#   $W/dev-full.xdlrc        xdl -report -pips -all_conns xc3s250ecp132-4
#   $W/empty.bit             an empty design
#   $W/slice/*.json          slice harness results (analyze-slice.mjs)
#   $W/{p1,c1,c2,k1,iop/*}/  PIP batches (gen-pipdrop.mjs, gen-pipcover.mjs, gen-clock.mjs)
#   $W/io1/                  I/O settings (gen-iob.mjs)
#   $W/ref/                  designs implemented by ISE (routed XDL + .bit) for the residual analysis
set -e
W=${1:-/tmp/claude-501/bg}
cd "$(dirname "$0")"
node gen-layout.mjs "$W/empty.bit" > db/xc3s250e-layout.json
rm -f db/xc3s250e-tiles.json
node gen-slicedb.mjs "$W"/slice/*.json > "$W/slice-features.json"
echo '{"types":{"CENTER_SMALL_BRK":{"sameAs":"CENTER_SMALL"}}}' > "$W/brk.json"
node gen-pads.mjs "$W/dev-full.xdlrc" > "$W/pads.json"
PIPS=()
for d in p1 c1 c2 c3 c4 c5 k1 iop/O iop/I; do
  [ -f "$W/$d/key.json" ] && [ -f "$W/$d/BASE.bit" ] && [ "$(ls "$W/$d" | grep -c "^V.*bit$")" = "$(node -p "require(\"$W/$d/key.json\").L")" ] || continue
  [ -f "$W/$d/pips.json" ] || node ana-pipdrop.mjs "$W/$d" "$W/dev-full.xdlrc" > "$W/$d/pips.json"
  PIPS+=("$W/$d/pips.json")
done
node pips-to-db.mjs "${PIPS[@]}" > "$W/pip-features.json" 2> "$W/pip-report.txt"
tail -1 "$W/pip-report.txt"
node merge-db.mjs "$W/slice-features.json" "$W/brk.json" "$W/pads.json" "$W/pip-features.json"
for f in "$W"/learn-*.json; do [ -f "$f" ] && node merge-db.mjs --keep "$f"; done
# corrections found by comparing whole designs with ISE (check-writer.mjs, explain-diff.mjs)
for f in "$W"/fix-*.json; do [ -f "$f" ] && node merge-db.mjs "$f"; done
true
