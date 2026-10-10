#!/bin/bash
# Inside the ISE container: xdl -xdl2ncd + bitgen for every .xdl of one or more folders, P at a time.
#   run-many.sh [-P 3] [-g "CRC:Disable"] [-c] dir…      (-c: also a bitstream with CRC, name.crc.bit)
# -force: a design whose routing is incomplete (PIPs removed) is converted in spite of DRC errors.
# Run the container with --network none: bitgen's usage report then gives up at once instead of
# waiting for the network.
ARGS=("$@"); set --   # settings64.sh reads the positional parameters
source /opt/Xilinx/14.7/ISE_DS/settings64.sh >/dev/null 2>&1
set -- "${ARGS[@]}"
P=3; G="CRC:Disable"; CRC=0
while getopts "P:g:c" o; do case $o in P) P=$OPTARG;; g) G=$OPTARG;; c) CRC=1;; esac; done
shift $((OPTIND-1))
one() {
  d=$(dirname "$1"); b=$(basename "${1%.xdl}")
  cd "$d" || return
  [ -s "$b.bit" ] && return
  xdl -xdl2ncd -force "$b.xdl" "$b.ncd" > "$b.xlog" 2>&1 || { echo "FAILED xdl $d/$b"; return; }
  bitgen -w -d -g $G "$b.ncd" "$b.bit" > "$b.blog" 2>&1 || echo "FAILED bitgen $d/$b"
  if [ "$CRC" = 1 ]; then cp "$b.ncd" "$b.crc.ncd"; bitgen -w -d "$b.crc.ncd" "$b.crc.bit" > "$b.crc.blog" 2>&1 || echo "FAILED bitgen-crc $d/$b"; fi
  rm -f "$b"_bitgen.xwbt "$b".bgn "$b".drc "$b".crc_bitgen.xwbt
}
export -f one; export G CRC
for d in "$@"; do ls "$d"/*.xdl; done | xargs -P "$P" -I{} bash -c 'one {}'
echo DONE
