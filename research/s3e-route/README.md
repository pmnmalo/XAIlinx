# Spartan-3E routing: device graph and router (2026-10-10)

Silinx's router for the Xilinx Spartan-3E XC3S250E-4CP132 (Digilent Basys2), checked against
Xilinx ISE 14.7, following the method in [docs/OPEN-TOOLCHAIN.md](../../docs/OPEN-TOOLCHAIN.md).

- `core/fpga/device.js`: the routing graph of the device (browser + Node).
- `core/fpga/device-node.js`: its cache file (Node only).
- `core/fpga/route.js`: the router (PathFinder) and a routing check.
- `core/xdl.js` `writeXdl()`: a design back to XDL text.

| Script | What it does |
|---|---|
| `build-device.mjs` | Builds the graph cache from the full device report; prints sizes and load time |
| `route.mjs` | Removes a design's PIPs, routes it, writes the XDL, checks it against the graph |
| `check.mjs` | Checks the routing of an XDL design (ISE's or Silinx's) against the graph |
| `gen-controls.mjs` | Control designs: all PIPs removed, one antenna added, bidirectional PIPs flipped, rewritten unchanged |
| `ise-check.sh` | Inside the ISE container: `xdl -xdl2ncd`, `drc`, `bitgen`, `trce` for each design |
| `cmpbit.mjs` | Compares the configuration frames of two bitstreams |

Tools: ISE 14.7 (`xdl` P.20131013, `drc`, `bitgen`, `trce`) in the private Docker image
`xilinx/ise:14.7` (linux/amd64 under emulation); Node 22+.

## The device graph

**Source.** `xdl -report -pips -all_conns xc3s250ecp132-4 dev-full.xdlrc` (1 min 50 s): 204 MB of
text, 1419 tiles, 4615 sites, 569 094 tile wires, 2 139 368 PIPs. It comes from each user's own ISE
installation and is **not in the repository**, nor is anything derived from it (open legal question
in docs/OPEN-TOOLCHAIN.md): each user builds the cache once.

```
node research/s3e-route/build-device.mjs dev-full.xdlrc      # -> ~/.silinx/devices/xc3s250ecp132-4.json.gz
```

**Representation.** Most tiles of a kind are identical, so the graph is stored as *templates*:
each distinct tile content (wires, PIPs, sites with the tile wire of each pin) once, by local
index; each tile names its template, position and site names. The connections across tiles are
stored as *nodes*: sets of tile wires joined by metal (union of the report's `conn` lists),
varint-coded. 293 templates (576 CLBs share one), 200 181 nodes.

| | Size |
|---|---|
| Report (text) | 204 MB |
| Packed graph, JSON | 6.6 MB (templates 5.1, nodes 1.2, tiles 0.1, wire names 0.1) |
| Packed graph, gzip (the cache) | **1.96 MB** (templates 1.6, nodes 0.32) |
| Build (stream parse + pack + gzip) | 3.4 s |
| Load (gunzip 12 ms, JSON.parse 7 ms, `loadDevice` ~70 ms) | ~90 ms |
| Node-level edge arrays (`routingEdges()`, on first use) | 35 ms, 2.1 M edges, ~26 MB |
| Memory after load + edges | ~85 MB heap |

**Facts learned from the report and ISE's designs** (needed by the bitstream writer too):

- PIP directions in the report: `->` (2 134 376) and `=-` (4 992, bidirectional, buffered both
  ways: BX/BY of the CLBs and BRAM_FAN_BX/BY). Each bidirectional PIP is listed in both
  orientations, but a routed design names it in one only, whatever the direction of the signal
  (lab11 has `BY0 =- BX2` carrying BX2 to BY0 in one CLB and BY0 to BX2 in another): the wire with
  the lower number first (`BX0 =- BY1`, `BY0 =- BX2`, `BX1 =- BY3`, `BY2 =- BX3`). Writing them the
  other way round gives the **same bitstream** (lab11, 14 PIPs flipped: 0 frame bits differ).
- Route-through PIPs (`(pip T A -> B (_ROUTETHROUGH-A-B SITETYPE))`): through a LUT (F1..F4 -> X,
  G1..G4 -> Y), F5 -> X, FX -> Y, CIN -> X, COUT -> YB, SHIFTOUT -> XB, BUFGMUX I0 -> O. ISE uses
  COUT -> YB when a carry chain ends in a LUT input (blinky: `CLB_X14Y17 COUT3 -> YB3`). The
  comment ISE writes after it in XDL is not needed (blinky written back without it: same bitstream).
- Carry chains: COUT -> CIN is an ordinary PIP (`COUT0 -> CIN2` inside a CLB, `COUT2 -> COUT_N1`
  joined to the CIN of the CLB above).
- Global clocks: BUFGMUX `O` -> `CLKT_GCLK_PINWIRE0 -> CLKT_GCLK_MAIN0` -> CLKC -> GCLKVM -> GCLKVC ->
  GCLKH -> the CLBs' `GCLK0..7 -> CLK0..3`; every wire of that network has GCLK in its name. The
  slices' CLK pins can also be reached from general routing (and the GCLK network leaks into general
  routing), so a clock net must be kept on it explicitly.
- Constants: ISE ties VCC to a VCC site (in every CLB and I/O tile; pin VCCOUT; `VCC_PINWIRE`,
  `IOIS_VCC_WIRE`…) and GND to the Y output of an unused slice, naming the source
  `XDL_DUMMY_<tile>_<site>` (e.g. `outpin "XDL_DUMMY_CLB_X9Y1_SLICE_X17Y1" Y`); `xdl -xdl2ncd`
  accepts these (ISE's lab11 written back by Silinx gives ISE's bitstream, 0 frame bits differ).

## The router

PathFinder: each net is a tree over the nodes; each sink (nearest first) is found by A* from the
whole tree (cost per node `(1 + history) x (1 + present factor x other nets on it)`, estimate
0.3 per tile of distance to the sink). Nets may share nodes at first; after each pass the shared
nodes cost more (present factor x1.6 per pass, history +0.5 per extra net), and only the nets on
shared nodes are rerouted, until no node is shared. Clock nets (driven by a BUFGMUX) search only
GCLK nodes, falling back to general routing for a sink the global network cannot reach. Pins belong
to their net (no other net routes through them). Route-throughs only out of the net's own source
site onto a free pin. VCC / GND nets without a source get ISE-style dummy sources.

```
node research/s3e-route/route.mjs in.xdl out.xdl     # strip the PIPs, route, write, check
node research/s3e-route/check.mjs design.xdl         # check a routed design against the graph
```

## Validation with ISE

`ise-check.sh` (inside the container): `xdl -xdl2ncd`, then `drc -z` (ISE's design rule check),
`bitgen` (which runs the DRC again) and, with the PCF of ISE's map, `trce`. Controls show the
checks are meaningful: lab11 with all PIPs removed -> DRC: 372 errors ("completely unrouted"), and
`xdl2ncd` already warns; lab11 with one extra hanging PIP -> DRC: 1 error, "has an antenna. Routing
is incomplete", no bitstream.

First, the graph against ISE's own routing (`check.mjs`): every PIP exists, every sink is reached,
no antenna, no node shared, for lab11 (410 nets, 4072 PIPs), blinky (241 nets, 1651 PIPs) and the
switch -> LED design (5 PIPs).

Then ISE's placement with the PIPs removed and the nets routed by Silinx:

| Design | Nets routed | Passes | Time | PIPs (ISE) | xdl2ncd | DRC | bitgen | Timing (ISE's routing) |
|---|---|---|---|---|---|---|---|---|
| switch -> LED (`research/s3e-bitstream/top.v`) | 1 | 1 | 41 ms | 5 (5) | ok | 0 errors, 0 warnings | ok | (no constraint) |
| blinky (examples/blinky, XST) | 226 | 3 | 0.2 s | 1592 (1651) | ok | 0 errors, 0 warnings | ok | 6.746 ns, met (6.701 ns) |
| lab11 (XST) | 377 | 4 | 0.9 s | 3892 (4072) | ok | 0 errors, 0 warnings | ok | no constraint; clk -> clk 11.70 ns (10.91 ns) |

The placer's first outputs (open synthesis, placed by Silinx, `/tmp/claude-501/place/run`, not
routed by anyone before), routed by Silinx:

| Design | Nets routed | Passes | Time | PIPs | xdl2ncd | DRC | bitgen |
|---|---|---|---|---|---|---|---|
| blinky (placer's, 2026-10-10 18:38) | 264 | 4 | 0.3 s | 1607 | ok | 0 errors, 0 warnings | ok |
| lab11 (placer's, 2026-10-10 18:38) | 760 | 4 | 2.8 s | 7697 | ok | 0 errors, 0 warnings | ok |

Both have constant nets without a source (the placer's `GLOBAL_LOGIC0` / `GLOBAL_LOGIC1`), tied by
the router to ISE-style dummy sources. The first attempt failed in `xdl -xdl2ncd` ("undefined net
instance 'XDL_DUMMY_…'"): ISE also declares each dummy source as an instance
(`cfg "_NO_USER_LOGIC:: _GND_SOURCE::Y "`, or `_VCC_SOURCE::VCCOUT` on a VCC site), which the
router now writes too.

Writer check: ISE's lab11 and blinky, parsed and written back by `writeXdl()` without any change,
give ISE's bitstream (0 frame bits differ, `cmpbit.mjs`), so the writer loses nothing ISE needs.

## On the board

2026-10-10: blinky and lab11 synthesized by Silinx + Yosys, packed, placed and routed by Silinx
(`core/fpga/`), with ISE only converting the XDL (`xdl -xdl2ncd`), checking it (`drc`: 0 errors,
0 warnings) and writing the bitstream (`bitgen -g StartUpClk:JtagClk`), both work on a Basys2
(XC3S250E-CP132): the first bitstreams in which no ISE tool chose a cell, a site or a wire.

## Open problems

- Timing is not considered: the router minimises wire count and congestion, not delay. It met
  blinky's 20 ns constraint with a period close to ISE's; critical-path-aware costs (PathFinder's
  criticality term) are the next step.
- GND / VCC sources: the made-up `XDL_DUMMY` source is understood by `xdl -xdl2ncd`; the bitstream
  writer will have to program what ISE programs for it (the unused slice's G LUT and Y output).
- Route-throughs are used only out of the source site (COUT -> YB). LUT route-throughs (to reach
  a pin otherwise unreachable) are never used.
- Only the XC3S250E has been checked; other Spartan-3E parts need their own report (same code).
- The 293 templates are most of the cache; many differ only slightly (BRAM / clock variants) and
  could share their PIP lists if the cache must get smaller.
