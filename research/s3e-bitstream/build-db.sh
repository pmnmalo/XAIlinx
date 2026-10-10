#!/bin/bash
# Rebuilds db/xc3s250e-layout.json and db/xc3s250e-tiles.json from the experiments' results in $W
# (bitstreams made by run-many.sh; nothing of it is in the repository):
#   $W/dev-full.xdlrc        xdl -report -pips -all_conns xc3s250ecp132-4
#   $W/empty.bit             an empty design
#   measured/slice/*.json    slice harness results (analyze-slice.mjs), in the repository
#   measured/learn-*, fix-*  features found by ana-residual / ana-attrdrop / ana-pads / learn-single /
#                            explain-diff (see README), in the repository
#   $W/{p1,c1,c2,k1,iop/*}/  PIP batches (gen-pipdrop.mjs, gen-pipcover.mjs, gen-clock.mjs)
#   $W/{d1,d2}/              PIP batches on blinky and lab11 placed and routed by Silinx (gen-pipdrop.mjs)
#   $W/{c6…c10,n1,n2,b-*}/   PIP batches of stage D (gen-pipcover.mjs: carry outputs, clock pins, the
#                            constant 1, long lines, terminal tiles, I/O and block-RAM pins)
#   $W/io1/                  I/O settings (gen-iob.mjs)
#   $W/io4/                  I/O settings per pad (gen-iob.mjs --perpad)
#   $W/ref/                  designs implemented by ISE (routed XDL + .bit) for the residual analysis
set -e
W=${1:-/tmp/claude-501/bg}
cd "$(dirname "$0")"
node gen-layout.mjs "$W/empty.bit" > db/xc3s250e-layout.json
rm -f db/xc3s250e-tiles.json
node gen-slicedb.mjs measured/slice/*.json > "$W/slice-features.json"
echo '{"types":{"CENTER_SMALL_BRK":{"sameAs":"CENTER_SMALL"}}}' > "$W/brk.json"
PIPS=()
for d in p1 c1 c2 c3 c4 c5 k1 iop/O iop/I d1 d2 c6 c7 c8 c9 c10 n1 n2 b-k1 b-g b-c1 b-d2; do
  [ -f "$W/$d/key.json" ] && [ -f "$W/$d/BASE.bit" ] && [ "$(ls "$W/$d" | grep -c "^V.*bit$")" = "$(node -p "require(\"$W/$d/key.json\").L")" ] || continue
  [ -f "$W/$d/pips.json" ] || node ana-pipdrop.mjs "$W/$d" "$W/dev-full.xdlrc" > "$W/$d/pips.json"
  PIPS+=("$W/$d/pips.json")
done
node pips-to-db.mjs "${PIPS[@]}" > "$W/pip-features.json" 2> "$W/pip-report.txt"
tail -1 "$W/pip-report.txt"
node merge-db.mjs "$W/slice-features.json" "$W/brk.json" "$W/pip-features.json"
for f in measured/learn-*.json; do [ -f "$f" ] && node merge-db.mjs --keep "$f"; done
node unify-io.mjs
# the I/O, corner, block-RAM interconnect and DCM tiles share the CLB's switch box (stage D)
node share-sb.mjs
# I/O standards, drive, slew and pull per pad (gen-iob.mjs --perpad, stage D)
if [ -f "$W/io4/key.json" ]; then node ana-perpad.mjs "$W/io4" > "$W/perpad.json" && node merge-db.mjs "$W/perpad.json"; fi
# corrections found by comparing whole designs with ISE (check-writer.mjs, explain-diff.mjs)
for f in measured/fix-*.json; do [ -f "$f" ] && node merge-db.mjs "$f"; done

node gen-slicetable.mjs > db/xc3s250e-slice.json
