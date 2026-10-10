#!/bin/bash
# Inside the ISE container: implement HDL designs with ISE (xst, ngdbuild, map, par) for the XC3S250E
# CP132 and write the routed XDL and the bitstream (-g CRC:Disable), as reference designs for the
# residual analysis (ana-residual.mjs, learn-single.mjs) and check-writer.mjs.
#   ise-impl.sh dir…     (each dir: top.vhd and / or top.v, top.ucf; top entity / module "top")
# Run the container with --network none.
ARGS=("$@"); set --
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
P=xc3s250e-cp132-4
for d in "${ARGS[@]}"; do
  (
    cd "$d" || exit 1
    [ -s top.bit ] && exit 0
    : > top.prj
    for f in *.vhd; do [ -f "$f" ] && echo "vhdl work \"$f\"" >> top.prj; done
    for f in *.v; do [ -f "$f" ] && echo "verilog work \"$f\"" >> top.prj; done
    echo "run -ifn top.prj -ifmt mixed -ofn top.ngc -ofmt NGC -p $P -top top -opt_mode Speed -opt_level 1" > top.xst
    mkdir -p xst/tmp; echo "set -tmpdir xst/tmp" | cat - top.xst > top2.xst
    xst -ifn top2.xst -ofn top.syr > xst.log 2>&1 || { echo "$d: xst FAILED"; exit 1; }
    ngdbuild -p $P -uc top.ucf top.ngc top.ngd > ngd.log 2>&1 || { echo "$d: ngdbuild FAILED"; exit 1; }
    map -p $P -o top_map.ncd top.ngd top.pcf > map.log 2>&1 || { echo "$d: map FAILED"; exit 1; }
    par -w top_map.ncd top.ncd top.pcf > par.log 2>&1 || { echo "$d: par FAILED"; exit 1; }
    xdl -ncd2xdl top.ncd top.xdl > n2x.log 2>&1
    bitgen -w -d -g CRC:Disable top.ncd top.bit > bitgen.log 2>&1
    echo "$d: $([ -s top.bit ] && echo ok || echo FAILED) $(grep -h 'Number of occupied Slices' map.log | head -1 | sed 's/  */ /g')"
  )
done
