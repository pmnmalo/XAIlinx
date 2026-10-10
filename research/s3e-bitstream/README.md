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
| `gen-layout.mjs`, `gen-pads.mjs`, `merge-db.mjs`, `build-db.sh`, `db.mjs` | Build the database (`db/*.json`) from the experiments' results |
| `check-writer.mjs` | Acceptance test of the writer (`core/fpga/bitgen.js`): byte comparison with ISE's bitgen |
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
comparing bitstreams, and they combine independently into a valid bitstream. The next stages
(not started) are the frame of every column, the remaining slice settings (multiplexers,
flip-flops, carry), every routing switch of every tile type, the I/O settings, then a placer, a
router and the bitstream writer in Silinx.
