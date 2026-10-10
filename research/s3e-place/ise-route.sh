#!/bin/bash
# ISE's back end on Silinx's placed XDL: xdl -xdl2ncd (DRC), par -p (route only: the placement is
# kept), bitgen, netgen -sim (the routed design as a SIMPRIM VHDL model), xdl -ncd2xdl (to read
# back). Run inside the ISE container, in the folder of <name>.xdl:
#   docker run --rm --platform linux/amd64 -v <dir>:/w -w /w xilinx/ise:14.7 bash /w/ise-route.sh <name>
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
n="$1"
xdl -xdl2ncd "$n.xdl" "$n.ncd" > "$n.xdl2ncd.log" 2>&1 || { echo "xdl2ncd FAILED"; grep -iE "error|warning" "$n.xdl2ncd.log" | head -30; exit 1; }
grep -iE "^(ERROR|WARNING)" "$n.xdl2ncd.log" | head -10
par -w -p "$n.ncd" "${n}_r.ncd" > "$n.par.log" 2>&1 || { echo "par FAILED"; tail -30 "$n.par.log"; exit 1; }
grep -E "unrouted|completely routed|ERROR" "$n.par.log" | tail -3
bitgen -w -g CRC:Disable "${n}_r.ncd" "$n.bit" > "$n.bitgen.log" 2>&1 || { echo "bitgen FAILED"; grep -iE "error" "$n.bitgen.log" | head -20; }
grep -E "^ERROR|^WARNING:PhysDesignRules" "$n.bitgen.log" | head -10
netgen -w -sim -ofmt vhdl "${n}_r.ncd" "${n}_sim.vhd" > "$n.netgen.log" 2>&1 || { echo "netgen FAILED"; tail -20 "$n.netgen.log"; }
xdl -ncd2xdl "${n}_r.ncd" "${n}_r.xdl" > /dev/null 2>&1
echo "DONE $n"
