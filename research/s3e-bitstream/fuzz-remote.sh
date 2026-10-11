#!/bin/bash
# Runs run-many.sh on another machine with Docker and the ISE image (faster than emulation): copies
# the folders' .xdl files there, runs ISE in a container, copies the .bit files and logs back.
#   SILINX_FUZZ_HOST=user@host fuzz-remote.sh [-P 3] [-c] dir…      (dirs under $W)
# W: the local experiments folder (default /tmp/claude-501/bg); RW: the folder on the remote machine
# (default silinx-fuzz in its home), mounted as /w in the container like $W locally.
set -e
: "${SILINX_FUZZ_HOST:?set SILINX_FUZZ_HOST=user@host}"
W=${W:-/tmp/claude-501/bg}; RW=${RW:-silinx-fuzz}
OPTS=(); while [[ "$1" == -* ]]; do OPTS+=("$1"); [[ "$1" == -P || "$1" == -g ]] && { OPTS+=("$2"); shift; }; shift; done
SSH=(ssh -o BatchMode=yes "$SILINX_FUZZ_HOST")
"${SSH[@]}" "mkdir -p $RW"
rsync -a -e "ssh -o BatchMode=yes" "$(dirname "$0")/run-many.sh" "$SILINX_FUZZ_HOST:$RW/"
for d in "$@"; do
  "${SSH[@]}" "mkdir -p $RW/$d"
  rsync -a -e "ssh -o BatchMode=yes" --include='*.xdl' --exclude='*' "$W/$d/" "$SILINX_FUZZ_HOST:$RW/$d/"
done
start=$(date +%s)
"${SSH[@]}" "export PATH=\"\$PATH:/usr/local/bin\"; docker run --rm --network none -v \"\$HOME/$RW\":/w xilinx/ise:14.7 bash /w/run-many.sh ${OPTS[*]} $(printf '/w/%s ' "$@")" | grep -v '^DONE' || true
for d in "$@"; do
  rsync -a -e "ssh -o BatchMode=yes" --include='*.bit' --include='*log' --exclude='*' "$SILINX_FUZZ_HOST:$RW/$d/" "$W/$d/"
  "${SSH[@]}" "rm -f $RW/$d/*.ncd"
done
echo "$(ls $(printf "$W/%s/*.xdl " "$@") | wc -l | tr -d ' ') designs, $(( $(date +%s) - start )) s"
