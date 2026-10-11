# Spartan-3E bitstream: feasibility test (2026-10-10)

The first experiments towards an open toolchain for the Digilent Basys2 (Xilinx Spartan-3E
XC3S250E-4CP132), following the method in [docs/OPEN-TOOLCHAIN.md](../../docs/OPEN-TOOLCHAIN.md):
small test designs written in XDL, turned into bitstreams by ISE's command-line tools, and compared.

Tools: Xilinx ISE 14.7 (`xdl` P.20131013, `bitgen`), in a private Docker image (`xilinx/ise:14.7`,
linux/amd64, run under emulation on Apple Silicon: about 50 s per design); GHDL 7.0.0-dev and
Yosys 0.66 (`hdlc/ghdl:yosys` image); Node 22+.

## Files

| File | What it does |
|---|---|
| `bits.mjs` | Reads a `.bit`: header, configuration packets, the frame data written to FDRI; compares two bitstreams bit by bit |
| `run.sh` | Inside the ISE container: `xdl -xdl2ncd` + `bitgen -d -g CRC:Disable` for every `.xdl` of a folder, 4 at a time |
| `gen-lut.mjs`, `analyze-lut.mjs` | Step 2: LUT F / G memory bits of one slice (all-0, all-1 and 4 binary-coded designs per LUT) |
| `gen-sites.mjs`, `analyze-sites.mjs` | Step 2b: LUT F of several slices, one block of designs per slice |
| `top.v`, `top.ucf` | Step 4: the reference design, switch SW0 (pin P11) -> LED LD0 (pin M5) |
| `gen-e4.mjs`, `gen-e5.mjs`, `compose3.mjs` | Steps 3-4: the reference design taken apart (empty, pads, the net's pin connections, each routing switch in context), then rebuilt from those parts and compared with ISE's bitstream |

Inputs the scripts expect (not in the repository: they come from your own ISE installation):
`device.xdlrc` (or `XDLRC=…`) from `xdl -report xc3s250ecp132-4 device.xdlrc`, and in `ref/` the
reference design implemented by ISE (`top.xdl`, `top.bit`, from `top.v` / `top.ucf`).

| More files | |
|---|---|
| `lib.mjs` | Shared helpers (LUT equation from its 16 bits) |
| `gen-map.mjs`, `decode-map.mjs` | Stage A: one design with every slice numbered in its LUT F; the frame of every slice column and the bit of every slice row |
| `gen-slice.mjs`, `analyze-slice.mjs` | Stage B: the settings inside a slice (flip-flops, inverters, multiplexers, carry), one design per setting |
| `gen-harness.mjs`, `gen-hvar.mjs` | Stage B2: the slice under test with all its pins connected, routed once by ISE; one variant per setting |
| `db/xc3s250e-slice.json` | Result of stages B and C: the bits of each slice setting, per slice position (any slice) |
| `compare-sim.mjs` | Does the netlist of open synthesis behave like the design? Simulates both with Silinx |
| `db/xc3s250e-lut.json` | Result of stage A: where every LUT of the chip is in the bitstream |
| `xdlrc-graph.mjs`, `router.mjs` | The device's routing graph from `xdl -report -pips -all_conns` (cached), and a small router for test designs |
| `run-many.sh` | Inside the ISE container: `xdl -xdl2ncd -force` + `bitgen` for every `.xdl` of several folders, 3 at a time (`-c`: also with CRC) |
| `gen-pipdrop.mjs`, `gen-pipcover.mjs`, `gen-clock.mjs`, `ana-pipdrop.mjs`, `pips-to-db.mjs` | Stage C: routing switches in batches (variants remove PIPs by codewords); a design routed by ISE, designs routed by `router.mjs`, the global clock tree |
| `gen-iob.mjs`, `ana-pads.mjs`, `ana-iob.mjs`, `ana-io2.mjs` | Stage C: the I/O pads (direction, I/O standard, drive, slew, pull) |
| `gen-attrdrop.mjs`, `ana-attrdrop.mjs`, `gen-slicedb.mjs`, `gen-slicetable.mjs` | Stage C: slice settings in every slice position |
| `ana-residual.mjs`, `explain-diff.mjs` | What the database does not explain in designs implemented by ISE, per tile and feature |
| `gen-layout.mjs`, `merge-db.mjs`, `build-db.sh`, `db.mjs` | Build the database (`db/*.json`) from the experiments' results; the pads of the package (pin -> I/O tile) are not in it: `db.mjs` takes them from the device cache (`padsFromDevice`) |
| `measured/` | Results of the analyses that `build-db.sh` merges (slice harnesses, learned and corrected features: our own observations, no Xilinx files) |
| `learn-single.mjs`, `unify-io.mjs` | Features measured in the reference designs; shared switch boxes of the I/O tile types |
| `check-writer.mjs` | Acceptance test of the writer (`core/fpga/bitgen.js`): byte comparison with ISE's bitgen |
| `fuzz-remote.sh` | Stage D: `run-many.sh` on another machine with Docker and the ISE image (`SILINX_FUZZ_HOST=user@host`, set on the command line only) |
| `share-sb.mjs`, `gen-branch.mjs`, `ana-perpad.mjs`, `ise-impl.sh` | Stage D: the CLB switch box shared by the I/O, block-RAM and DCM tiles; PIPs measured as dead-end branches of routed nets; I/O settings per pad; designs implemented by ISE from HDL (reference designs) |
| `db/xc3s250e-layout.json`, `db/xc3s250e-tiles.json` | Result of stage C: where every tile is in the frame data; the bits of every measured feature (PIPs, site settings, pads) per tile type |

## Results

### Bitstream structure (XC3S250E)

Sync word `AA995566`, then Type 1 / Type 2 packets as documented in UG332: FLR = 72 (frames of
73 words = 2336 bits), IDCODE `01C1A093`, one FDRI Type 2 packet with all 578 frames (42 194
words). With `-g CRC:Disable` the checksum is the constant `DEFC`.

### Step 1: open synthesis

lab11 (VHDL: 5 entities) synthesized with GHDL + Yosys (`synth_xilinx -family xc3se -ise
-flatten`, then `delete t:$scopeinfo` before `write_edif`) and implemented by ISE's
ngdbuild / map / par / bitgen: complete, all signals routed. The netlist is larger than
XST's: 886 LUTs and 522 slices against 309 and 180 (59 flip-flops against 71).

The netlist behaves like the design (`compare-sim.mjs`: Yosys's Verilog netlist with Silinx's
UNISIM cell models against the VHDL, both simulated by Silinx, registers starting at 0 as on the
FPGA): lab11's test bench `test01` gives identical signals over the whole run, and random
stimulus gives identical outputs at every one of 3 x 50 000 clock cycles. (Without the power-up
zeros the VHDL's display counter, which has no initial value, stays unknown; and a clock-like input
changed at the same instant as the data races differently through the two netlists in a zero-delay
simulation: the stimulus keeps them apart, as real buttons and switches are.)

### Step 2: LUT memory bits

Each 4-input LUT is 16 consecutive bits of one frame, in address order (address = A4 A3 A2 A1),
**stored inverted**. LUT G is the 16 bits just before LUT F.

| Slice | Frame | LUT F bits |
|---|---|---|
| SLICE_X31Y47 | 236 | 736-751 (LUT G 720-735) |
| SLICE_X31Y45 | 236 | 800-815 |
| SLICE_X30Y46 | 233 | 768-783 |
| SLICE_X33Y47 | 255 | 736-751 |
| SLICE_X0Y0 | 24 | 2240-2255 |

Within a column: bit = 736 + 64 * (23 - floor(Y / 2)) + 32 * (Y even). Between CLB columns: 19
frames per column, with the block-RAM / clock columns in between; the slices with an even X are 3
frames before the odd ones. To do: the frame of every column (one sample per column).

### Steps 3-4: routing and a whole design

Switch -> LED (ISE's placement and routing): input pad P11, output pad M5, one net with 5 routing
switches (PIPs) along the bottom edge. Measured separately against the empty design:

| Part | Bits |
|---|---|
| The two pads (IBUF P11, IOB M5) | 8 |
| The net's connections to the pads, without routing | 13 |
| `BIOIS_X13Y0 W2END4 -> IOIS_G3_B0` | 3 |
| `BIOIS_X15Y0 W2END4 -> W2BEG4` | 3 |
| `BIOIS_X17Y0 W6END4 -> W2BEG4` | 2 |
| `BIOIS_X23Y0 I2_PINWIRE -> IOIS_Y2` | 0 |
| `BIOIS_X23Y0 IOIS_Y2 -> W6BEG4` | 2 |

The empty bitstream with these parts added is **identical to ISE's bitstream of the whole design,
byte for byte**.

Learned on the way: a routing switch on a net without pins is not programmed at all; routing
switches must be measured in context (the design with and without that switch). The 13 bits of
the net's connections were measured together; they still have to be split per pin.

### Stage A: where every LUT is (full project)

One design numbers every one of the 2448 slices in its LUT F; one bitstream locates them all:
2448 found, each exactly once, consistent (one frame per slice column, one offset per slice row).

- Rows: LUT F of slice row Y starts at bit 2240 - 32 * Y of the frame (Y = 0 … 67); LUT G is the
  16 bits before.
- Columns: slice columns X = 0 … 51 in frames 24, 27, 43, 46, … The two slices of a CLB are 3
  frames apart; CLB columns are 19 frames apart, except where the block-RAM and clock columns
  are, so the order follows the device's column addresses rather than X (table in
  `db/xc3s250e-lut.json`).

### Stage B: the settings inside a slice

Measured on one slice in isolation (`gen-slice.mjs`), most settings did not change the
bitstream: bitgen only programs an inverter, a carry-chain setting or a multiplexer when its
pin has a net. So the slice is measured in a **harness** (`gen-harness.mjs`): every input pin of
SLICE_X31Y47 is driven by its own driver slice, every output goes to a load slice, and the carry
chain comes from the slice below and goes to the one above. ISE's `par -p` routes it once
(placement kept, 58 routing switches); every variant (`gen-hvar.mjs`) is that routed XDL with only
the slice's settings changed, so the routing never changes between variants.

All settings but CYINIT were measured (`db/xc3s250e-slice.json`): the five inverters (clock,
enable, set/reset, BX, BY) are one bit each in the frame 2 after the LUT frame; the flip-flop
settings (initial value, set or reset, synchronous, latch), the D-input and output multiplexers
and the carry-chain settings (CYSEL, CY0 with a 3-bit code) are in the frame before. Still to do:
CYINIT, the X / Y outputs, and checking the same layout on SLICEM and on the lower slice of a CLB.

### Stage C: the bit database and the bitstream writer (2026-10-10)

**Result: Silinx's writer (`core/fpga/bitgen.js`) turns ISE's routed XDL of the switch -> LED
design, blinky and lab11 into `.bit` files byte-identical to the ones ISE's bitgen writes from the
same XDL, with `-g CRC:Disable` and with the default CRC** (`check-writer.mjs`).

**Packets and CRC.** The packet sequence is fixed (`core/fpga/bitstream.js`): sync, CMD RCRC, FLR
72, COR, IDCODE, MASK, CMD SWITCH, FAR 0, CMD WCFG, one Type 2 FDRI write of all 578 frames,
the CRC check word, CMD GRESTORE, CMD LFRM, one frame of NOOPs, CMD START, CTL 0, CRC, CMD
DESYNC, 4 NOOPs. COR = `000031E5` (+ `20000000` with the CRC off, + `00010000` for
`StartUpClk:JtagClk`). The CRC is a CRC-16 (polynomial 0x8005, bit-reversed 0xA001) fed with the
32 data bits then the 5 register-address bits of every register write, least significant bit first;
RCRC and the check word reset it; with the CRC off both check words are `DEFC`.

**Model.** A design is a set of *features*, each of a tile: a routing switch (`from->to`, on nets
with pins only), a site setting (`SLICE2:CYSELF:F`, `IOB1:…`, `BUFGMUX_X2Y11:…`), a pad's
direction and I/O standard (`@M5 O:LVCMOS33`), plus the LUT contents (stage A). Every feature sets
a few bits at fixed offsets from its tile's first frame and bit (`db/xc3s250e-layout.json`:
`cols[x]`, `rows[y]` by the X / Y of the tile name; the I/O columns are 21 frames at frames 3 and
366, frames 0-2 hold the centre clock columns). The frame data of an empty design has 18 bits set
(`defaults`). Features compose by OR (and a few clears), which is what makes batch measurements
possible.

**Routing switches, in batches.** `gen-pipdrop.mjs`: a design routed by ISE (lab11, the I/O
designs) with PIPs removed by codewords: each PIP gets w ones out of L variants, different
codewords in the same tile; a bit that changes in exactly the variants of a codeword belongs to
that PIP (`xdl -xdl2ncd -force` accepts the broken routes; bitgen still programs the rest of a net
that has pins). 20 variants measured all 4072 PIPs of lab11 at once. `gen-pipcover.mjs`: test
designs routed by `router.mjs` (breadth-first search over the device graph of
`xdl -report -pips -all_conns`): up to 4-10 PIPs under test per tile, in every tile of the chosen
types at once, each on its own net from a slice output through the PIP to a slice input; 8
variants per design. `gen-clock.mjs`: 8 global buffers driving clock pins above and below every
horizontal clock row. A PIP measured in several tiles must have the same bits in all (majority
kept, conflicts reported by `pips-to-db.mjs`). Coverage: 2570 of the 2840 PIPs of the CLB tile
(the 50 route-throughs excluded), the switches of the I/O, terminal, block-RAM interconnect, DCM
and clock tiles that the test designs and the reference designs use: about 7100 PIP features in
80 tile types. The I/O tiles of one side share their switch box (`unify-io.mjs`).

**Global clock.** The horizontal clock rows (GCLKH) use one bit per line and direction in the I/O
rows of the frame (bits 3, 2, 2334, 2335 for the rows of CLB Y 29, 21, 13, 5), frames 1-16 of
the column (`GCLKk -> UPk` / `DNk`); the vertical spines (GCLKVC) need no bits; the centre tiles
GCLKVML / GCLKVMR / CLKC are frames 0 / 1 / 2. The BUFGMUX settings used here (`I0_USED`,
`SINV:S_B`, `DISABLE_ATTR:LOW`) set no bits beyond the switches into and out of the buffer.

**Slices** (`db/xc3s250e-slice.json`, any slice: position i = 2 x (X odd) + (Y odd) of the CLB
tile). The harness results of the four positions (SLICEM / SLICEL, lower / upper), plus rules
found by comparing whole designs with ISE (`ana-residual.mjs`, `explain-diff.mjs`) and by removing
one setting per slice position from a routed design (`gen-attrdrop.mjs`): a used slice of a SLICEM
sets 2 bits (`USED`); an unused LUT of a used slice holds the constant 0; a used LUT whose path to
the X / Y output and to the flip-flop (DXMUX / DYMUX = 1) is unused sets its output multiplexer to
all ones (`FXMUX:#OFF`); flip-flops without a clock enable set the enable bit (`CEINV:#OFF`);
F5USED, FXUSED, F5MUX, F6MUX, XUSED, YUSED and the carry elements set no bits of their own.

**I/O pads.** The pads do not repeat one pattern per tile type: an I/O tile configures its pads
partly in the frames of the tile next to it. So every bonded pad (92) has its own absolute bits
per direction and standard (`ana-pads.mjs`), from designs with every third I/O tile used (every
bit near a used tile is its own) and designs with one pad index in every other tile (which pad
of the tile). LVCMOS33 and LVCMOS25 inputs set the same bits; outputs differ in one bit. Measured
for LVCMOS33 / LVCMOS25, DRIVE 12, SLEW SLOW, no pull (what the Basys2 designs use);
`gen-iob.mjs` also has variants for the other standards, drives, FAST and the pulls (`ana-iob.mjs`,
not in the database yet: several of them change bits of the neighbouring pads).

**Measured in the reference designs themselves.** 27 PIPs and a few settings were found only in
the reference designs (a tile with exactly one unknown feature: its differing bits are that
feature, `learn-single.mjs`), and a few corrections from `explain-diff.mjs` (`fix-*.json` in
`build-db.sh`): BY -> BX bounce, `_GND_SOURCE`, `YB1->OMUX0` (one observation), `FX1->Y1`
(clears one bit of the GYMUX default), the clock pins of the CLB_BRK rows (same bits as in the
other rows). So the acceptance designs are not fully independent of the database. Designs not used to build it
(other placements of lab11, blinky and the switch -> LED design, routed by ISE): two are
byte-identical (switch -> LED placed by Silinx, `s4/top`), the others differ in 39-97 bits of
the 1.35 million (unknown PIPs of block-RAM interconnect, DCM and I/O tiles, the carry chain of
SLICEMs, and the open SLICEM bits below); lab11 synthesized by Yosys differs in 276 bits.

Open at the end of stage C (solved in stage D): in a SLICEM of an F6 multiplexer tree, ISE
sometimes sets 2 more bits per slice (SLICE0: 1,55 1,57; SLICE1: 1,23 1,25) and sometimes not, with
the same settings in the XDL (they are set for a `_GND_SOURCE::Y` SLICEM).

**Runtime.** About 185 ISE runs (`xdl -xdl2ncd` + `bitgen`, 3 at a time, about 1 minute each under
emulation), about 4 hours of wall time in batches; the analyses run in seconds.

**Open problems.** PIPs not reachable by the test router (long lines, TBUF, some I/O switches) and
the route-throughs; block RAM, multipliers, DCM settings; I/O standards other than LVCMOS33 / 25
and DRIVE / SLEW / PULL changes; IFF / OFF registers in the IOBs; SLICEM as RAM / shift register;
BUFGMUX with I1 / S used. A design using one of these reports it (`unknown` features of
`bitgen()`), the bitstream is then incomplete.

### Stage D: designs placed and routed by Silinx, and the rest of the chip (2026-10-11)

**Result: blinky and lab11 placed and routed by Silinx's own placer and router are byte-identical
to ISE's bitgen from the same XDL, and so are all 12 other reference designs** (ISE's placements of
switch -> LED, blinky, lab11 and lab11 synthesized by Yosys, with and without CRC; designs with
distributed RAM and shift registers implemented by ISE: @@RAMRESULT@@).

**Where.** ISE ran on a faster machine (an Intel Mac with Docker: about 9x faster than emulation)
through `fuzz-remote.sh`; the host is given on the command line only (`SILINX_FUZZ_HOST`).
@@RUNS@@

**The PIPs of Silinx's own designs.** `gen-pipdrop.mjs` on Silinx's routed blinky and lab11 (20
variants each) measured all their 9370 PIPs at once.

**One switch box.** Every PIP measured both in a CLB and in an I/O, corner, block-RAM interconnect
or DCM tile has the same bits, at a fixed offset: the left I/O column 2 frames later, the top I/O row
16 bits further, the others none (`share-sb.mjs`; `makeDb`: `sameAs` + `shift`). The I/O tiles' own
pin wires are the CLB's under other names (`IOIS_X0` = `X0`, `IOIS_F1_B0` = `F1_B0`, `IOIS_VCC_WIRE` =
`VCC_PINWIRE`; not the clock pins `IOIS_CLK0-7`): `rename`. The I/O measurements without bits where
the CLB has bits were bits given to a neighbouring tile by the analysis (such as `W6END4->E2BEG4` of
the left I/O tiles): they are dropped. The four block-RAM interconnect tiles of a block RAM have the
same bits for the block-RAM pins (`unify-io.mjs`).

**PIPs without bits.** The terminal tiles' PIPs (…TERM…: thousands measured, none with bits of its
own; the few with bits were I/O bits in the same frames), the block-RAM site tiles' PIPs (pin wires),
the PIPs into the stub wires of the input-only I/O tiles, `VCC_PINWIRE -> pin` (the constant 1 is
the default) and the I/O sites' settings of standard / drive / slew / pull (their bits are the pad's
features) set no bits: `pipsWithoutBits`, `emptyFeatures`.

**New ways to reach PIPs.** `gen-pipcover.mjs`: the carry outputs XB / YB as sources (SLICEM: XBMUX
instead of XBUSED), clock pins as sinks, the tiles' VCC sites (nets of the constant 1), the long
lines, the block RAMs' and multipliers' pins (`--pins bram`), and `--nosink`: the PIP under test
ends its route (a net with only an output pin crashes `xdl -xdl2ncd`, so the net gets one unrouted
slice input): bitgen programs every PIP of a net with pins, also one that leads nowhere.
`gen-branch.mjs` adds PIPs as dead-end branches to the nets of a routed design: on the global clock
nets of `gen-clock.mjs` this measured the clock pins from every global line (`GCLKk->CLKn`, 32 per
CLB, and the I/O tiles' `GCLKk->IOIS_CLKn`). Measurements are cleaned of LUTs cleared by the
removal of their only route (`stripLutRuns`), and conflicting measurements are resolved by leaving
out such artefacts (`resolvePatterns`).

**The SLICEM bits (open in stage C).** A SLICEM site holds an instance of type SLICEM or SLICEL;
of 695 instances in SLICEM sites, the 142 of type SLICEM set the 2 bits (SLICE0 1,55 1,57; SLICE1
1,23 1,25), the 553 of type SLICEL do not: feature `SLICEk:SLICEM`. As found with RAMs, the 2 USED
bits of a SLICEM site mean "F / G is not a RAM", the 2 SLICEM bits "F / G is not a shift register".

**Slice settings.** XBUSED, YBUSED, XBMUX, YBMUX: no bits of their own (without them bitgen leaves
out the carry settings). SLICEM as RAM / shift register (`ise-impl.sh`: designs with RAM16X1S,
RAM16X1D, RAM32X1S, SRL16(E), SRLC16E and inferred distributed RAMs and shift registers implemented
by ISE; one setting changed per slice position, `gen-attrdrop.mjs ATTR=FROM>TO`): `F:#RAM`,
`F:#RAM:SHIFT_REG` (the LUT feature names the mode), `DIF_MUX`, `DIG_MUX`, `SLICEWE0USED`, `YBMUX:0`,
`WSGEN`; LUT initial values in hexadecimal (`D=0x…`).

**I/O.** `gen-iob.mjs --perpad`: every change of standard, drive, slew and pull on every pad, each
variant changing the pads of one index in every third I/O tile of each side; a changed bit belongs
to the changed pad whose own bits are nearest (a pad's bits are not always in its own tile's frames)
(`ana-perpad.mjs`). A standard is a whole pad feature (`O:LVCMOS18`), drive / slew / pull are changes
of the pad's bits (`O:DRIVE:8`, `O:SLEW:FAST`, `O:PULL:PULLUP`, `I:PULL:KEEPER`). Checked with all
92 pads at random settings: inputs of any standard with any pull, and LVCMOS33 outputs with any drive
/ slew / pull, are byte-identical; the drive and slew of another standard change other bits than
LVCMOS33's, so they are measured per standard (`--perstd`, features `O:LVTTL:DRIVE:8`…).
@@IOSTD@@

**Coverage.** @@COVERAGE@@

### Open synthesis on the board (2026-10-10)

lab11 and the blinky example, synthesized by Silinx's own front end (`core/synth-verilog.js`: the
elaborated design as Verilog) and Yosys (`synth_xilinx -family xc3se -ise -flatten`, no GHDL, no
XST), implemented by ISE's ngdbuild / map / par / bitgen (fully routed, timing constraints met:
lab11 393 slices, blinky 119), were programmed on a Digilent Basys2 and **work as the originals**.

## To do later: synthesis quality

Open synthesis (Silinx front end + Yosys `synth_xilinx -family xc3se`) is correct but its
netlists are much larger than XST's: lab11 needs 886 LUTs / 522 slices against XST's 309 / 180
(about 2.9x), mostly wide multiplexers built from many small LUTs (Yosys's Spartan-3E support is
marked experimental; no shift-register inference for xc3se either). Synthesis time is fine
(11 ms front end + 1.7 s Yosys for lab11, against XST's 5 s), but a larger circuit is slower
to place and route and slower on the chip. To improve later: Yosys options and scripts (ABC
settings, `-nowidelut`, `-widemux`, retiming), and / or Silinx's own mapping of multiplexers,
decoders and ROMs before Yosys. Measure on lab11 and the example designs against XST.

## Conclusion

The method works for this device: LUT contents, I/O pads and routing switches can be located by
comparing bitstreams, and they combine independently into a valid bitstream. Stage C built the
database for what the Basys2 designs use and a writer whose output is byte-identical to ISE's
bitgen for the switch -> LED design, blinky and lab11. Next: the open problems of stage C, then
Silinx's own placer and router feeding the writer.
