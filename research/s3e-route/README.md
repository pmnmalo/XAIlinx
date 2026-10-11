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
| `timing-fit.mjs` | Fits the wire delay model of `core/fpga/timing.js` to ISE's `reportgen -delay` of routed designs |
| `route.mjs` | Removes a design's PIPs, routes it, writes the XDL, checks it against the graph (`--known`: only PIPs of known bits) |
| `open-flow.mjs` | The fully open flow for a project: synthesis (Silinx + Yosys), pack, place, route on known PIPs, Silinx's bitgen |
| `ise-open-check.sh` | Inside the ISE container, the oracle of the open flow: `xdl -xdl2ncd`, `drc`, `bitgen` (CRC on / off), `trce -a`, `reportgen -delay` |
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

## Fully open bitstreams (2026-10-10)

**Result: blinky and lab11 go from their VHDL / Verilog sources to a `.bit` file with no Xilinx
tool in the flow** — Silinx's front end + Yosys, Silinx's packer, placer, router and bitgen — and
the bitstream is byte-identical to the one ISE's bitgen writes from the same routed XDL.

```
node research/s3e-route/open-flow.mjs examples/blinky out/blinky     # -> out/blinky/top.bit
node research/s3e-route/open-flow.mjs ~/Silinx-projects/lab11 out/lab11
```

What it took, besides chaining the steps:

- **Router restricted to known switches** (`routeDesign(design, device, knownRouting(db))`,
  `core/fpga/bitgen.js`): a PIP may be used only if its feature `from->to` (wires in the direction
  of the signal, so a bidirectional `BX0 =- BY1` is checked the way it is used) is in the database
  for the tile's type (named as bitgen names it: `CLB` -> `CENTER_SMALL` / `CENTER_SMALL_BRK`…) and
  the layout knows the tile. A feature with no bits counts only for dedicated wires (carry chain,
  pin wires, clock spines, terminations), not for a switch into a general routing wire: the
  database has 253 such empty entries in the I/O and corner tiles and at least one is wrong (below).
  GND sources only on slices whose `USED` and `_GND_SOURCE:Y` are known (SLICEL positions 2 / 3);
  VCC sources (VCC sites, no settings) only through allowed PIPs. A net that cannot be routed on
  known PIPs fails, with its unreached sinks listed (`unreached`), never through an unknown switch.
- **Carry chains:** the four carry PIPs of a CLB as the device names them are `COUT0->CIN2`,
  `COUT1->CIN3`, `COUT2->COUT_N1`, `COUT3->COUT_N3`; none sets bits (the database had the first
  three; `COUT2->COUT_N1` added, `measured/fix-9carry.json`: the Silinx-routed blinky's tiles whose
  only unknown feature it was had no bit different from ISE's bitgen).
- **Carry out read by logic** (blinky's comparators): the packer's `carryOut: 'xor'` brings it out
  through one more chain stage, XOR with a LUT giving 0, and the X / Y output (FXOR / GXOR), instead
  of the XB / YB pins (`XBUSED`, `XB->OMUX`, `COUT->YB` are not measured). Simulated against the
  netlist in the unit tests; the default stays `'pin'`, as ISE does.
- The placer reads its sites from the device cache (`deviceSites(device)`, same result as from the
  204 MB report), so the flow needs only the cache.

Checked with ISE as the oracle (`ise-open-check.sh`, one job at a time on an Intel Mac mini):

| Design | Placement | Nets | PIPs | Unknown features | DRC | bitgen vs Silinx (CRC on / off) | trce (no constraint) |
|---|---|---|---|---|---|---|---|
| blinky | seed 1 (default) | 265 | 1627 | 0 | 0 errors, 0 warnings | byte-identical / byte-identical | 12.12 ns |
| blinky | seeds 2, 3, 4 | 265 | | 0 | 0 / 0 | byte-identical / byte-identical | 13.30, 11.93, 12.22 ns |
| lab11 | seed 1 (default) | 777 | 7773 | 0 | 0 errors, 0 warnings | byte-identical / byte-identical | clk 22.85 ns |
| lab11 | seeds 3, 4 | 777 | | 0 | 0 / 0 | byte-identical / byte-identical | clk 24.02, 23.09 ns |
| lab11 | seed 2, effort 3, timing 4 | 777 | 7770 | 0 | 0 / 0 | byte-identical / byte-identical | clk 20.57 ns |

(blinky's own constraint is 20 ns.) The restriction costs little: lab11's default placement routed
on all PIPs takes 7764 PIPs and 23.86 ns (it is the one routed earlier and run on the board), on
known PIPs 7773 PIPs and 22.85 ns. Before the restriction, the same designs used 31 (blinky) / 36
(lab11) features the database does not know and differed from ISE's bitgen in 39 / 66 bits.

A first run of the slower lab11 placement (seed 2, effort 3, timing 4) still differed in 4 bits
with 0 unknown features: it used `W6END4->E2BEG4` and `LH6->E6BEG0` of a left I/O tile, which the
database lists with no bits, while ISE sets 17,25 17,26 for the first (the second: 18,59 and one bit
at frame offset 19). Hence the rule above on empty switches into general wires.

The open bitstreams for the board: `~/Silinx-projects/open-flow/blinky-open.bit`,
`lab11-open.bit` (default placement) and `lab11-open-fast.bit` (seed 2, effort 3, timing 4).

Still missing for every placement to route (for the measurement of the database):

- **Clock pins:** only 13 of the 32 `GCLKk -> CLKn` switches of a CLB are known (`GCLK4` reaches
  all four slices; missing: GCLK0->CLK2, GCLK1->CLK0/2/3, GCLK2->CLK0/1/3, GCLK3->CLK1/2/3,
  GCLK5->CLK0/2/3, GCLK6->CLK0/1/3, GCLK7->CLK1/2/3). A second clock on another line fails when a
  flip-flop of it lands in a slice its line cannot reach with known switches: lab11 with seed 2, and
  with seed 1 effort 3 timing 4 (`bit_ready -> …CLK`), fail this way.
- XB / YB -> OMUX (only `YB1->OMUX0` known), `XBUSED` / `YBUSED`, `COUTk->YBk` route-throughs (only
  `COUT1->YB1`): avoided by `carryOut: 'xor'`, needed for a carry chain read in the middle.
- The 253 empty switches into general wires of the I/O and corner tiles (BIOIS, LIOIS*, RIOIS*,
  TIOIS, LIBUFS*, RIBUFS*, TIBUFS, BIBUFS, LL / LR / UL / UR), refused by the router until measured.
- `VCC_PINWIRE->BX0` (BX1, BX3 known), `SLICE0:_GND_SOURCE:Y` (SLICEM GND sources), long lines and
  hexes through I/O, block RAM and DCM tiles that the earlier routes used.
- `measured/learn-7carry.json` lists carry PIPs the device does not have (`COUT0->CIN0`,
  `COUT1->CIN1`, `COUT0->COUT_N0`, `COUT1->COUT_N1`, `COUT2->COUT_N2`); harmless, never used.

## Timing (2026-10-11)

**Result: lab11 at 17.2 ns (58 MHz) by ISE's own timing analyzer, under the board's 20 ns, from
21.3-23.9 ns; blinky 11.5 ns from 12.1-13.3 ns** — still fully open (known PIPs only, bitstream
complete, byte-identical to ISE's bitgen, DRC clean). Pieces:

- `core/fpga/timing.js`: a delay model of the XC3S250E -4 and a static timing analysis (STA).
- `core/fpga/route.js`: timing-driven routing (`routeDesign(…, { timing: true })`), the default of
  `open-flow.mjs` (`--timing-route 0` turns it off); `clockReach()`.
- `core/fpga/place.js`: the timing term in ns with the same model; `clockSites` keeps each clock's
  flip-flops on the slices its global line reaches through known switches.
- `timing-fit.mjs`: fits the wire model; `scripts/check-open-flow.mjs` now takes open-flow options
  per project and, with `SILINX_KEEP=1`, keeps ISE's `routed.twr` (`trce -a -v 3`) and
  `routed.dly` (`reportgen -delay`: the delay of every connection) next to each `routed.xdl`.

**Delay model: measured, not copied.** Only our own fitted numbers are in the code; no Xilinx file.

- *Wires.* Each node of the device graph gets a class from the names of its wires: OMUX, double,
  hex, long line, input multiplexer (`F1_B…`, `BX…`), clock, I/O, site pin. A routed connection's
  delay = base + Σ over its nodes (after the driver's pin) of (class delay + class branch load x the
  branches the net takes off the node) + a load term at the driver. Fitted (non-negative least
  squares) to ISE's `reportgen -delay` of the same routed designs: 10 486 connections of 7 Silinx
  routings of blinky and lab11 (with and without timing), **rms error 0.099 ns, 95% within 0.19 ns,
  worst 0.51 ns**. Fitted values (ns): OMUX 0.345, double 0.269, hex 0.350, long 0.445, input mux
  0.208 (+0.213 per extra branch), base -0.103, driver +0.049 per extra branch. Splitting doubles /
  hexes by the tap they are left at, the fanout and an Elmore-like subtree load did not improve the
  fit. A connection with no general wire (carry chain, F5 / FX -> FXIN) takes 0, as trce says.
- *Logic.* Every logic element of every path of the `trce -v 3` reports (16 reports of Silinx's
  routings), keyed by the path through the slice and its settings: LUT (Tilo 0.704 / 0.759 ns,
  SLICEL / SLICEM), F5 / F6..F8 multiplexers, carry chain (a LUT pin that is also the carry's data
  input `CY0F` / `CY0G`, BX / BY as data input or `CYINIT`), XOR outputs, flip-flop clock-to-out,
  setup through X / Y (+0.133) or from BX / BY (0.308), SR. SLICEM and SLICEL differ (the packer
  writes `SLICEL` everywhere: the site decides). After the fit all but two arcs match trce
  exactly; Topcyg is 0.888 or 1.131 for the same settings (kept as the data-input rule). A few arcs
  never seen on a reported path are marked *est.* in `SPEED_4`.

**STA against trce** (minimum period of the main clock, same routed design; `-`: Silinx lower):

| Designs | n | Error |
|---|---|---|
| lab11 (9 routings: wirelength and timing-driven, 4 placements) | 9 | -1.8% .. +1.9% |
| blinky (8 routings) | 8 | -4.0% .. +0.8% |
| lab11 second clock (`bit_ready`, 2.3-3.0 ns) | 9 | within 0.13 ns |
| all main clocks | 21 | mean \|error\| 1.4%, worst 4.0% (0.46 ns) |

STA of lab11: 15-50 ms.

**Timing-driven routing.** VPR's criticality term in PathFinder: for a connection of criticality c,
a node costs c x its delay / 0.3 ns + (1 - c) x its congestion cost, and the A* search starts from
each tree node at c x its delay from the source, so a critical load gets a direct, fast path and the
others share wires. Criticality = (1 - slack / period)^k, k from 1 to 8 over the passes, at most
0.99; first from the distances (placement estimate), then from the STA of the routed delays after
every pass. The most critical loads of a net are routed first. Once legal, 2 more passes reroute
the nets of connections with criticality > 0.5; the best legal routing (by the STA) is returned.
Without it, lab11's 220-262-fanout nets were routed as long chains of doubles (5.1-5.5 ns to
the critical load).

**Placement.** The placer's timing term used made-up units (a LUT 1, a connection 0.6 + 0.12 / CLB);
it now uses the model in ns (the slice arcs, a distance estimate: 0.55 + 0.1 ns / tile up to 12
tiles, then 0.03, fitted to the delays above; carry / multiplexer links 0) and analyses flip-flop
to flip-flop paths, as trce's period. Gains are small next to the router's (lab11 by the STA: 17.5
ns with timing 0, 17.1-17.5 with the default). `clockSites` fixes a failure: with the timing
placer, seeds 1 and 2 of lab11 put a `bit_ready` flip-flop on a slice its clock line reaches only
through an unknown `GCLKk -> CLKn` switch (no bitstream); now the placer keeps each clock's flip-flops
on the slices `clockReach(device, bufgmux, allowPip)` finds.

Checked with ISE as the oracle (`SILINX_ISE_HOST=… node scripts/check-open-flow.mjs …`, Intel Mac
mini, one job at a time; every design: DRC 0 errors 0 warnings, `.bit` byte-identical to ISE's
bitgen with CRC on and off):

| Design | Placement | Routing | trce (ns) | Silinx STA (ns) | Route time |
|---|---|---|---|---|---|
| lab11 | old placer, seed 1 | wirelength (before) | 21.273 | 21.499 | 2.6 s |
| lab11 | old placer, seed 1 | timing | 17.491 | 17.647 | 3.3 s |
| lab11 | old placer, seed 2, effort 3, timing 4 | wirelength (before) | 19.649 | 19.556 | |
| lab11 | old placer, seed 2, effort 3, timing 4 | timing | 17.620 | 17.687 | |
| lab11 | new placer, seed 1 (default) | wirelength | 20.313 | 20.533 | |
| **lab11** | **new placer, seed 1 (default)** | **timing (default)** | **17.188** | 17.493 | 3.2-4.3 s |
| lab11 | new placer, seed 3 | timing | 16.889 | 16.869 | |
| blinky | old placer, seed 1 | wirelength (before) | 12.667 | 12.497 | 0.4 s |
| blinky | old placer, seed 1 | timing | 12.024 | 11.562 | 0.45 s |
| **blinky** | **new placer, seed 1 (default)** | **timing (default)** | **11.494** | 11.030 | 0.35 s |
| blinky | new placer, seed 2 | timing | 11.404 | 11.165 | |

For comparison, ISE's own par of the same Yosys netlist of lab11 reached 16.67 ns
(`research/s3e-place/README.md`). The router takes about 25% longer on lab11 (9-12 passes instead
of 4; the A* estimate of the delay part is 0.1 ns / tile, a little above the fastest wires', to
keep the search short).

On the board (to test): `~/Silinx-projects/open-flow/lab11-open-timing.bit` (default flow, 17.19
ns), `lab11-open-timing-s3.bit` (seed 3, 16.89 ns), `blinky-open-timing.bit` (11.49 ns).

Not done / next: hold-time analysis and clock skew (trce's skew was 0-0.02 ns here), pad-to-pad
and OFFSET paths (`instArcs` has rough pad delays only), the branch loads in the router's cost (the
STA has them), more designs for the fit (the carry XOR / BY arcs marked *est.*).

## Open problems

- Timing: no timing constraints (UCF PERIOD) are read yet; the router and the placer minimise the
  critical path by the model, with no target.
- GND / VCC sources: the made-up `XDL_DUMMY` source is understood by `xdl -xdl2ncd`, and Silinx's
  bitgen programs what ISE programs for it on SLICEL positions (byte-identical above); SLICEM
  positions as GND sources are not measured (`SLICE0:_GND_SOURCE:Y`).
- The placer keeps each clock's flip-flops on the slices its line reaches with known switches
  (`clockSites`, above); it could also choose the global buffer by it.
- Route-throughs are used only out of the source site (COUT -> YB). LUT route-throughs (to reach
  a pin otherwise unreachable) are never used.
- Only the XC3S250E has been checked; other Spartan-3E parts need their own report (same code).
- The 293 templates are most of the cache; many differ only slightly (BRAM / clock variants) and
  could share their PIP lists if the cache must get smaller.
