# Spartan-3E packing and placement, checked with ISE (2026-10-10)

Silinx's packer and placer (`core/fpga/`) take the netlist of open synthesis (Silinx front end +
Yosys `synth_xilinx -family xc3se -ise -flatten`) and produce a **placed XDL**: every slice, pad and
clock buffer on a site of the XC3S250E-4CP132 (Digilent Basys2), with the configuration strings
ISE itself writes, and every net with its site pins, without routing. ISE's back end is then used
only to check it: `xdl -xdl2ncd` must accept it, `par -p` must route it without moving anything,
and the routed design, written by `netgen -sim` as a SIMPRIM simulation model, must behave like
the original design when Silinx simulates both. Method: [docs/OPEN-TOOLCHAIN.md](../../docs/OPEN-TOOLCHAIN.md)
(ISE's documented tools are run as a user runs them; only their outputs are read).

## The pieces (core/fpga)

| File | |
|---|---|
| `netlist.js` | `readYosysJson(json, { top })`: Yosys's `write_json` as cells (type, parameters, pins -> nets) and nets (driver, loads; nets 0 / 1 are the constants), ports by bit with UCF names (`led<3>`) |
| `lut.js` | `initToEquation(init, k, pins)` / `equationToInit(eq, k, pins)`: a LUT cell's INIT <-> the XDL equation (`#LUT:D=…` in A1..A4, the site pins), for any assignment of the cell's inputs to pins |
| `pack.js` | `pack(netlist, { ucf, part })`: cells into SLICEL / IBUF / IOB / BUFGMUX instances with their cfg strings, site-pin nets, and the groups that must keep their shape (`macros`) |
| `place.js` | `deviceSites(parseXdlrc(text))`, `place(packed, dev, { seed, effort, timing })`, `placedXdl(packed, placement)` |
| `xdl-write.js` | `writeXdl(design)`: the design in `parseXdl`'s shape as XDL text (core/xdl.js reads it back) |

What the packer does:

- **Slices**: a LUT and the flip-flop it feeds go together (D through DXMUX / DYMUX); other
  flip-flops take D through BX / BY; slices are filled by shared nets. The two flip-flops of a
  slice share one control set (clock and its inversion, clock enable, set/reset and its
  synchronous or asynchronous mode); each keeps its own INIT and SRHIGH / SRLOW. FDRE / FDSE /
  FDCE / FDPE (and `_1`), LDCE / LDPE.
- **Carry chains** (MUXCY / XORCY): two stages per slice, up one slice column (COUT -> CIN), the
  chain starting through CYINIT = BX (the constant from a gnd / vcc net, as ISE does). DI comes
  from a constant (CY0 = 0 / 1 with the GND / VDD element ISE adds), from pin 1 of the stage's LUT
  (the LUT's inputs are permuted, or DI is added as an input the function ignores), or BX / BY.
  When the first stage needs BX for DI, a stage of its own brings the carry in. The sums leave
  through FXMUX / GYMUX = FXOR / GXOR and feed the slice's flip-flops; a carry used outside leaves
  through XB / YB. A S input not driven by a LUT gets a route-through LUT (D=A1), as ISE's
  `_rt` LUTs.
- **Wide multiplexers**: MUXF5 in every slice (LUT F = I1, selected by BX = 1); F6 / F7 / F8 in
  their fixed slices, with the pattern ISE uses (measured with `wide-mux.mjs` on lab11):

  | FiMUX | slice of the CLB | FXINA (I1) from | FXINB (I0) from |
  |---|---|---|---|
  | F6 | S0 (x even, y even), S2 (x odd, y even) | F5 of its own slice | F5 of the slice above |
  | F7 | S1 (x even, y odd) | FX of S0 | FX of S2 |
  | F8 | S3 (x odd, y odd) | FX of S1 | FX of S1 of the CLB above |

  A multiplexer that does not fit the pattern becomes a LUT3.
- **Pads**: an input is an `IBUF` instance (on any pad site), an output an `IOB` (`OMUX::O1`), with
  IOSTANDARD (default LVCMOS25 as ISE), DRIVE (12), SLEW (SLOW) and PULLUP / PULLDOWN / KEEPER from
  the UCF; LOCs fixed. BUFG -> `BUFGMUX` (I0, S tied high, `SINV::S_B`, as ISE's map writes it).
- **Latches** take `CLKINV::CLK_B` for an active-high gate: the slice latch is open while CLKINV
  gives 0 (first packed with CLK: the netgen model showed an inverter on the gate and the
  simulation differed; fixed).

The placer: simulated annealing over slices, groups (carry chains, F6 / F7 / F8 patterns, moved
as one with their alignment: F6 on an even row, F7 / F8 on a CLB) and pads without LOC; cost =
half-perimeter wirelength with VPR's correction for nets with many pins, each net weighted by
`1 + timing x criticality^4` (criticality from a rough static timing estimate, recomputed at every
temperature); clock nets (from a BUFGMUX) are left out. BUFGMUX: on the edge of the pad that drives
it (B8 -> BUFGMUX_X2Y11, as ISE). Deterministic: the same seed gives the same placement.

## Scripts

| File | |
|---|---|
| `synth.mjs` | Silinx front end + Yosys: `<top>.json`, `<top>.edf`, `<top>_ys.v` |
| `flow.mjs` | pack + place a Yosys JSON netlist -> placed XDL (`seed`, `effort`, `timing`) |
| `ise-route.sh` | in the ISE container: `xdl -xdl2ncd`, `par -w -p`, `bitgen`, `netgen -sim -ofmt vhdl`, `xdl -ncd2xdl` |
| `ise-ref.sh` | in the ISE container: ISE's own implementation of the same Yosys EDIF (ngdbuild, map, par) for comparison |
| `compare.mjs` | the routed netgen model against the RTL, simulated by Silinx with the same random stimulus, outputs compared every cycle |
| `validate.mjs` | all of the above for one design (`sims/*.json`) |
| `check-pack.mjs` | the packed design against its netlist in the small simulators of `test/fpga-sim.js` (no ISE) |
| `wide-mux.mjs`, `carry-rows.mjs` | how ISE places wide multiplexers and carry chains (from its placed XDL) |
| `fixtures.mjs`, `designs/` | the small netlists of the unit tests (`test/fixtures/fpga/*.json`) |
| `gen-test-device.mjs` | the made-up device of the unit tests (`test/fixtures/fpga/place-device.xdlrc`) |
| `try-pack.mjs`, `show-net.mjs`, `count.cjs`, `devinfo.mjs` | inspection helpers |

`node validate.mjs sims/lab11.json /tmp/work` (needs `yosys`, the private `xilinx/ise:14.7`
image, and the device report `XDLRC=…`, default `/tmp/claude-501/xdl/dev.xdlrc`).

## Results

Every design below: **accepted by `xdl -xdl2ncd`** (no DRC errors; the only warnings are that
the nets are not routed yet), **routed completely by `par -p`** with the placement kept,
**bitgen** without errors, and the **netgen model identical to the RTL** in simulation at every
cycle of the run.

| Design | Slices (Silinx) | Slices (ISE map, same netlist) | Routed | Simulation (cycles, distinct output states) | par's best clock period: Silinx / ISE |
|---|---|---|---|---|---|
| switch -> LED (`s3e-bitstream/top.v`) | 0 (2 pads) | 0 | yes | identical (200) | - |
| blinky (`examples/blinky`) | 104 | 119 | yes | identical (3 000; the prescaler divides by 2^22, 4 states) | 9.72 ns / 12.30 ns (*) |
| blinky, generics reduced (`test/fixtures/designs/blinky`) | 89 | - | yes | identical (20 000, 256 states) | 10.24 ns |
| lab11 (`~/Silinx-projects/lab11`) | 384 | 391 | yes | identical (20 000, 391 states) | 18.38 ns (wirelength only), 18.22 ns (default: timing 1), 17.87 ns (effort 3, timing 4) / 16.67 ns |
| counter + comparator (`designs/counter.v`) | 9 | - | yes | identical (5 000, 461 states) | 3.47 ns |
| flip-flop kinds (`designs/ffs.v`) | 5 | - | yes | identical (5 000, 28 states) | - |
| 64:1 mux, MUXF5..F8 (`designs/mux64.v`) | 64 | - | yes | identical (5 000) | - |
| 32:1 + 8:1 mux (`designs/widemux.v`) | 19 | - | yes | identical (5 000) | - |
| latches (`designs/latches.v`) | 3 | - | yes | identical (5 000, 15 states), after the CLKINV fix | - |

(*) ISE's run had the UCF's 20 ns PERIOD constraint and stops improving once it is met; the
Silinx runs have no constraint (par then reports the best period it reaches for each clock).
XST's own netlist of lab11 needs 180 slices: the difference is open synthesis, not packing
(see `s3e-bitstream/README.md`).

Times (Apple Silicon, Node 25): packing 40-80 ms, placement 0.3 s (blinky) to 2 s (lab11) at
effort 1; ISE under emulation 4-6 minutes per design (xdl2ncd, par, bitgen, netgen).

Timing: lab11's critical path after par is 7-10% longer than with ISE's own placement of the same
netlist: 18.38 ns with wirelength only, 18.22 ns with the default timing weight, 17.87 ns with
`effort 3, timing 4` (5.4 s of placement), against 16.67 ns. All three routed and identical in
simulation. The wirelength is about the same (2 927 / 2 984 / 2 901 CLB units).

## Open problems

- **netgen's port names**: an NCD made from XDL has no port information, so netgen names the
  ports after the pad instances (`led_0_OUTBUF_OUT`, `clk_PAD_PAD`); `compare.mjs` maps them. The
  BUS_INFO / PIN_INFO properties ISE's map writes into the design's cfg (written by the packer)
  are not enough.
- **Not packed yet**: block RAM (RAMB16_*), multipliers (MULT18X18*), distributed RAM and shift
  registers (RAM16X1S / D, RAM64X1S, SRL16: SLICEM), tristate and bidirectional pads (OBUFT,
  IOBUF), registers in the IOBs (IFF / OFF), DCMs, BUFGMUX used as a multiplexer. The packer
  reports them.
- **Carry chains longer than a slice column** segment are not split (a column of the XC3S250E
  has 68 slices, or 16 at the block-RAM columns: 136 / 32 bits); chains run across the clock
  rows, as ISE's (`carry-rows.mjs`).
- **Clock buffer choice** follows the pad's edge with ISE's order (X2Y11 first at the top, X2Y1 at
  the bottom); the dedicated pad -> BUFGMUX routes of every GCLK pin are not known yet (par routes
  a non-dedicated one through general routing).
- **Timing**: the timing term uses a rough delay model (a LUT 1, a connection 0.6 + 0.12 per CLB).
  Real delays (from ISE's timing reports, or the router's) would make it better.
- **Packing density**: LUT + flip-flop pairs are chosen greedily; a flip-flop alone could also fill
  the free flip-flop of a carry or multiplexer slice through BX / BY.
- FDSE / FDPE without an initial value (Yosys INIT = x) start at 0, as Silinx's simulator starts
  registers; ISE would start an FDSE at 1.
