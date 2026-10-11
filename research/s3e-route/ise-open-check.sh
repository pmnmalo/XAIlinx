#!/bin/bash
# Inside the ISE container: ISE as the oracle of the fully open flow (open-flow.mjs).
#   ise-open-check.sh <folder> name...      (for each name: <name>/routed.xdl in the folder)
# For each design: xdl -xdl2ncd, drc (must report 0 errors), bitgen -g StartUpClk:JtagClk with the
# default CRC (ise.bit) and with -g CRC:Disable (ise-nocrc.bit), trce -a (no constraints: the
# longest paths), reportgen -delay (routed.dly: the delay of every connection). Compare ISE's .bit with Silinx's: research/s3e-bitstream/check-writer.mjs.
# Remote run (the host only on the command line, never in a file):
#   rsync -a <scratch>/{blinky,lab11} "$SILINX_ISE_HOST:silinx-route/open/"
#   ssh -o BatchMode=yes "$SILINX_ISE_HOST" 'export PATH="$PATH:/usr/local/bin"; docker run --rm \
#     -v "$HOME/silinx-route":/w xilinx/ise:14.7 bash /w/ise-open-check.sh /w/open blinky lab11'
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
cd "$1" || exit 1
shift
for b in "$@"; do
  (
    cd "$b" || exit 1
    rm -f routed.ncd ise.bit ise-nocrc.bit
    xdl -xdl2ncd routed.xdl routed.ncd > xdl2ncd.log 2>&1 || { echo "$b: xdl2ncd FAILED"; tail -5 xdl2ncd.log; exit 1; }
    drc -z routed.ncd > drc.log 2>&1
    bitgen -w -g StartUpClk:JtagClk routed.ncd ise.bit > bitgen.log 2>&1
    bitgen -w -g StartUpClk:JtagClk -g CRC:Disable routed.ncd ise-nocrc.bit > bitgen-nocrc.log 2>&1
    trce -a -v 3 routed.ncd -o routed.twr > trce.log 2>&1
    reportgen -delay routed.ncd > reportgen.log 2>&1
    echo "$b: xdl2ncd ok ($(grep -c WARNING xdl2ncd.log) warnings); drc: $(grep -h 'PhysDesignRules results' drc.log | head -1); bitgen: $([ -s ise.bit ] && [ -s ise-nocrc.bit ] && echo ok || echo FAILED)"
    echo "$b: timing: $(grep -h 'Minimum period\|Maximum path delay\|Maximum combinational' routed.twr | head -3 | sed 's/^ *//' | tr '\n' ' ')"
  )
done
