#!/bin/bash
# Inside the ISE container: check designs routed by Silinx with ISE's own tools.
#   ise-check.sh <folder> name...      (for each name: <name>.xdl in the folder)
# For each design: xdl -xdl2ncd (XDL -> NCD), drc (ISE's design rule check: unrouted nets,
# antennas, ...), bitgen (which runs the DRC again before writing the bitstream).
# With <name>.pcf (the constraints of ISE's map, for the same design), trce reports the timing.
# Results: <name>.xlog, <name>.drc, <name>.blog, <name>.bit (and <name>.twr); a summary line per design.
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
cd "$1" || exit 1
shift
for b in "$@"; do
  rm -f "$b.ncd" "$b.bit"
  xdl -xdl2ncd "$b.xdl" "$b.ncd" > "$b.xlog" 2>&1 || { echo "$b: xdl2ncd FAILED"; tail -5 "$b.xlog"; continue; }
  drc -z "$b.ncd" > "$b.drc" 2>&1
  bitgen -w -g CRC:Disable "$b.ncd" "$b.bit" > "$b.blog" 2>&1
  echo "$b: xdl2ncd ok ($(grep -c 'WARNING' "$b.xlog") warnings); drc: $(grep -h 'DRC detected' "$b.drc" | head -1); bitgen: $([ -s "$b.bit" ] && echo "bitstream $(stat -c %s "$b.bit") bytes" || echo FAILED) $(grep -hc 'ERROR' "$b.blog") errors, $(grep -hc 'WARNING' "$b.blog") warnings"
  if [ -s "$b.pcf" ]; then
    trce -v 3 "$b.ncd" "$b.pcf" -o "$b.twr" > /dev/null 2>&1
    echo "$b: timing: $(grep -h 'Timing errors' "$b.twr" | head -1); $(grep -h 'Minimum period' "$b.twr" | head -1 | sed 's/^ *//')"
  fi
done
