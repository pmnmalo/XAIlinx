#!/bin/bash
# ISE's own implementation of the open-synthesis netlist, for comparison with Silinx's packer and
# placer: ngdbuild (Yosys EDIF + UCF) -> map -> par -> xdl -ncd2xdl. Run inside the ISE container:
#   docker run --rm --platform linux/amd64 -v <dir>:/w -w /w xilinx/ise:14.7 bash /w/ise-ref.sh <top>
# (<dir> holds <top>.edf and <top>.ucf; results in <dir>/ref/)
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
top="$1"
mkdir -p ref && cd ref
cp "../$top.edf" "../$top.ucf" .
P=xc3s250e-cp132-4
ngdbuild -intstyle silent -p $P -uc "$top.ucf" "$top.edf" "$top.ngd" > ngdbuild.log 2>&1 || { echo "ngdbuild FAILED"; tail -20 ngdbuild.log; exit 1; }
map -w -intstyle silent -p $P -o "${top}_map.ncd" "$top.ngd" "$top.pcf" > map.log 2>&1 || { echo "map FAILED"; tail -20 map.log; exit 1; }
par -w -intstyle silent "${top}_map.ncd" "$top.ncd" "$top.pcf" > par.log 2>&1 || { echo "par FAILED"; tail -20 par.log; exit 1; }
xdl -ncd2xdl "$top.ncd" "$top.xdl" > xdl.log 2>&1
xdl -ncd2xdl "${top}_map.ncd" "${top}_map.xdl" >> xdl.log 2>&1
grep -E "Number of occupied Slices|Number of Slices containing|Number of 4 input LUTs|Number of Slice Flip Flops" map.log "$top.mrp" 2>/dev/null | head
grep -E "All signals are completely routed|unrouted" par.log | head -3
echo DONE
