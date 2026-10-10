# Changelog

What changed in each version of Silinx ISE. The newest version is first. Each section is also
the "What's new" text of its GitHub release.

## 15.10.1

- The modern interface shows the version after "Silinx ISE" in its header, as the classic title bar does.
- *Help ▸ About* and the README: Silinx ISE is described as developed to support the teaching of
  Digital Systems, without naming an institution (Silinx is the work of Pedro Maló, in his own time).
- Fixed: exporting a Xilinx ISE project with several schematics could report identical custom
  symbols as different ("custom symbol … differs"), when the export took more than a second.
- **Synthesis front end** (`core/synth-verilog.js`, first version): Silinx writes the elaborated
  VHDL / Verilog design as one flat synthesizable SystemVerilog module for Yosys, so that synthesis
  needs neither GHDL nor ISE (and can run in the browser). lab11 and the blinky example go through
  Yosys to a Spartan-3E netlist that behaves as the original in simulation.
  It also handles initial blocks (initial values of registers and memories) and Xilinx primitives
  instantiated by name (block RAMs, clock buffers, DCMs, shift registers): every test design
  synthesizes to a netlist that behaves as the original.
- **Packer and placer** for the Spartan-3E (`core/fpga/`, first version): Yosys's netlist packed
  into slices (LUTs, flip-flops, latches, carry chains, F5-F8 multiplexers), I/O pads and global
  clock buffers, and placed by simulated annealing; checked with ISE (routing of our placement and
  simulation of the result) on lab11 and blinky.
- **Router** for the Spartan-3E (`core/fpga/route.js`, first version): PathFinder over the device's
  routing graph (built once per computer from ISE's device report, never shipped). lab11 and blinky,
  synthesized, packed, placed and routed by Silinx, with ISE only writing the bitstream, pass ISE's
  design rule check and work on a Basys2.
- *Toolchain Settings*: the SSH mode (now *Remote host with Xilinx ISE via SSH*) can run the ISE flow in a Docker
  image on the remote host (*Docker image on the remote host*), so another machine with the
  Silinx ISE image can build, e.g. an Intel Mac, where ISE runs natively instead of emulated as on
  Apple Silicon (lab11: about 70 s instead of 10 minutes).
- FPGA view: selecting a site or a net no longer rebuilds the list of nets (a click takes half the
  time, with less memory churn in Safari).
- Memory tests (`test/ui/memory.test.js`): opening and closing the FPGA view, the editors, ISim and
  the board emulator, selecting in the FPGA view and switching projects many times must leave
  nothing behind (JS heap, DOM nodes and event listeners after garbage collection), and the page
  must stay within a memory budget. The same scenarios also run in WebKit, Safari's engine
  (`npm run test:webkit`, with Playwright), within a memory budget.
- Verilog: SystemVerilog size casts `W'(expr)`.
- How the open toolchain for the Spartan-3E is being developed: `docs/OPEN-TOOLCHAIN.md`, and the
  first experiments in `research/s3e-bitstream`.

## 15.10.0

- **A new, modern interface** (the default), alongside the classic Xilinx ISE one (*View ▸
  Interface*, remembered by the browser; both have every feature). It has a header with the
  project and a search box; an activity bar for Start / Design / Files / Libraries; document tabs
  above the editor; and labelled buttons for the design flow (Check, Simulate, Implement, Emulate,
  Program). Dialogs, menus and controls follow current design practice, the whole interface is
  usable from the keyboard, and the window adapts to small screens.
- **Light and dark themes** in the modern interface: they follow the system by default, or are
  chosen with *View ▸ Theme* or the header button. Diagram sheets stay light paper; the HDL editor,
  ISim and every panel follow the theme.
- **Command palette** (Ctrl+K / Cmd+K, or Ctrl+Shift+P): search any menu command or project file by
  name and run or open it from the keyboard. In Portuguese it finds commands by their Portuguese
  or English names.
- **View Implemented Design (FPGA)**: how ISE placed and routed the design inside the chip
  (*Processes ▸ Implement Design ▸ Place & Route*, or *Tools*).
  - The device as its grid of logic blocks, I/O pads, block RAMs, multipliers, clock buffers and
    DCMs, with the used sites coloured by module (at any hierarchy level) and the utilisation.
  - Click a site to see its logic: LUT equations with the names of their input signals,
    flip-flops (clock, enable, set / reset, initial value), carry chain and multiplexers; for a
    pad, its port, package pin, direction, I/O standard, drive and slew rate.
  - **Inside a slice** (Spartan-3 / Spartan-3E): a diagram of the slice with the parts the design
    uses (LUTs F and G, F5 multiplexer, carry chain, output multiplexers, flip-flops FFX and FFY)
    in the module's colour and the pins that carry signals; the other slices of the same CLB.
  - **How each function is implemented**: a LUT is a 16-bit memory. The view shows the truth
    table it holds, with the names of its input signals, its 16 memory bits and the INIT value,
    and marks the LUTs that only pass a signal through (route-thru).
  - Nets: what a net connects and the tiles its routing goes through; a site's connections;
    the global clock network; search by name.
  - The Design hierarchy and the chip select each other's modules.
  - Zoom and pan. The view reads the routed design with ISE's `xdl` (a new `fpgaview` step that
    only runs Place & Route first when needed).
- **Board emulator: the power switch works.** Off stops the board (LEDs, displays and LCD go
  dark); on starts the design again from time 0, as configuring the FPGA at power-up does.
  Switches moved while the board is off are read at power-up.
- **Clear Recent Projects** (*File ▸ Recent Projects*, and a link on the Start page). The projects
  themselves are kept.
- Fixed: Check, Simulate, Emulate and Program stayed disabled while an implementation was running;
  only Implement has to wait for it (also for *Run* in the right-click menu of the processes).
- Fixed: the Design Summary could not be reopened from the Processes panel once closed, unless a
  module was selected in the Implementation view. *Design Summary/Reports* is now there whatever is
  selected, in both views.
- *Help ▸ About* describes what Silinx does today (schematics with live simulation, FSM and ASM
  editors, truth tables and Karnaugh maps, wizards, netlist simulation, board emulator).

## 15.9.3

- **Remove from Project keeps the file** in the project folder, as in ISE. The file leaves the
  project (hierarchy, compilation, simulation, synthesis) and is listed as *Not in project* in the
  Files view; right-click ▸ *Add to Project* brings it back.
- **Undo / Redo of Remove from Project**: the toolbar Undo / Redo buttons, *Edit ▸ Undo / Redo*
  and Ctrl+Z / Ctrl+Y (Cmd+Z / Cmd+Shift+Z on a Mac) outside an editor, and the *Undo* button of the
  message shown after removing.
- **Top-Level Source Type** in the New Project wizard: HDL, Schematic, State Machine (FSM),
  State Machine (ASM) or Truth Table. A non-HDL type starts the project with that document and its
  synchronized HDL module `top`.
- **Release notes**: this changelog; each GitHub release and the update dialog show what is new.
- Fixed: two project reloads close together could leave the older file list on screen.
- **Licence: GNU AGPL-3.0** (was Apache-2.0), with an additional permission to combine Silinx
  with elkjs (EPL-2.0); *Help ▸ About* shows the licence, the no-warranty notice and the source code link.
- **Licence notices**: NOTICE and THIRD-PARTY-NOTICES.md (the open-source components Silinx ships
  and their licences), also embedded in Silinx-ISE.html; *Help ▸ About* shows the copyright and the
  components.

## 15.9.2

- **Tri-state buffers** in the schematic library (category *Tri-State*): BUFE, BUFE4, BUFE8,
  BUFE16, BUFT, BUFT4, BUFT8, BUFT16. Several tri-state outputs and inout markers may share a bus;
  live simulation shows Z (blue) and conflicts (red); Symbol Info datasheets with Z in the truth table.
- Exported ISE schematics write tri-state buffers as Silinx symbols with their HDL (ISE's FPGA
  libraries have no BUFE/BUFT); checked with ISE 14.7 for Spartan-3E.

## 15.9.1

- New Source: *State Machine (FSM)* is listed before *State Machine (ASM)*.

## 15.9.0

- **State Machine (FSM) editor**: Moore and Mealy bubble diagrams with plain-language checks
  (unreachable states, overlapping or incomplete conditions), state / transition / encoded tables,
  truth tables of the next-state logic, a step-by-step simulation panel, and VHDL / Verilog kept in
  sync both ways; conversion to and from ASM charts.
- **Beginner-friendly messages and design checks**: every error keeps its ISE message, followed by
  an explanation and how to fix it (English and Portuguese); warnings for latches, missing
  sensitivity entries, two drivers, combinational loops, unused or unassigned signals, clock misuse
  and more. *Edit ▸ Design Checks* turns the warnings off; `-- silinx: ignore` silences one line.
- **Symbol Info**: a datasheet for every schematic symbol (description, pins, parameters, the
  truth / mode table, the equivalent VHDL and Verilog).
- **New Source reorganised**: Truth Table, Module (HDL), Module (Wizard), Schematic (Diagram),
  Schematic (Wizard), State Machines, Test Bench (HDL), Test Bench (Wizard), constraints, memory files.
- **Module Wizard** and **Schematic Wizard**: ports (inputs, outputs, inout), combinational or
  sequential templates with clock / reset, ready-placed I/O markers.
- **Inout ports** in the Module, Schematic and Test Bench wizards; Test Bench Wizard *No vectors*
  mode (a skeleton to write the stimulus yourself).
- No simulation top any more: *Simulate* runs the module selected in the Simulation view.
- Creating a file that already exists asks whether to replace it.
- *Implementation only* association in *Add Copy of Source*.
- The app checks for a newer release when it starts.
- Files are saved atomically (no half-written file after a crash).

## 15.8.0

- **Live schematic simulation** (like Logisim): *Simulate* in the schematic editor; click inputs,
  step or run clocks, wires coloured by their value, outputs and stored values shown.
- **Truth Table / Karnaugh Map tool**: tables of up to 6 inputs, K-maps with the groups drawn,
  minimal SOP / POS, canonical forms, a check of your own expression, and a linked VHDL / Verilog
  module kept in sync both ways; gate schematics generated from the table.
- I/O Pin Planning leaves the I/O standard at *default* unless one is chosen.

## 15.7.0

- **Test Bench Wizard**: self-checking test benches (exhaustive, random, counting, walking or typed
  vectors; expected values typed in or taken from the current design); every mismatch is reported,
  then TEST PASSED / TEST FAILED. The benches also run in Xilinx ISim.

## 15.6.1

- 1-bit vector ports are written as `x<0>` in the UCF; latch gates get global clock pins;
  schematic flip-flops with unconnected CLR / CE generate valid HDL; Files view can rename and
  delete folders.

## 15.6.0

- Many simulator fixes and additions found by a large new test suite (VHDL records, 2-D arrays,
  overloading, case-generate; Verilog macros with arguments, `include`, defparam, named events …).
- Netlists from the real ISE 14.7 are checked against their RTL for 13 designs.
- The board emulator no longer jumps up and down (seen on Safari); knob turns are never lost.
- About and README: Silinx ISE was developed to support the teaching of Digital Systems,
  because AMD/Xilinx discontinued Xilinx ISE.

## 15.5.0

- **Board emulator**: run the design on a drawing of the real board (Basys2, Nexys2, Spartan-3E
  Starter Kit with its LCD and rotary knob); the timing of slow designs is scaled so they visibly run.
- **Netlist simulation**: simulate and emulate the post-synthesis, post-translate, post-map and
  post-place & route models from ISE; technology schematic, timing, power and pin reports.
- DCMs synthesize their real output frequencies; many more Xilinx primitive models.
- A full audit: fixes in the simulator, schematics, ASM charts, UCF handling, server and web UI.

## 15.4.0

- *Help ▸ Check for Updates*; About shows the GitHub project and the developers.
- *Add Copy of Source* only (Add Source removed); New Source left the File menu.

## 15.3.0

- Import / Export of Silinx ISE projects and of Xilinx ISE projects (.zip).
- ASM charts: case (multi-way) boxes and bit / slice conditions; printing and Save PNG.
- Processes panel with ISE-style expand / collapse that remembers its state.

## 15.2.4

- RTL schematic: *Up* and *Push into* buttons.

## 15.2.3

- Distribution files renamed: `Silinx-ISE.html`, `silinx-ise-<version>.zip`.

## 15.2.2

- Maintenance release.

## 15.2.1

- Schematic and ASM editors: Backspace deletes the selection again (as Delete).

## 15.2.0

- The project is renamed **Silinx ISE** (it was XAIlinx ISE).

## 15.1.0

- Schematic editor: T and JK flip-flops, the full D flip-flop family, inverted-input gates,
  decoders, encoders, demultiplexers; moving components keeps their connections.
- The version is shown in the title bar.

## 15.0.2

- ASM charts: registers power up with their reset values.

## 15.0.1

- Window titles without the version number.

## 15.0.0

- Version numbering in the style of ISE (15.x); the project is called *XAIlinx ISE*.

## 0.3.0

- Beginner-friendly start: double-click launchers and a step-by-step guide.

## 0.2.0

- README: download section.

## 0.1.0

- First release: ISE-style projects with VHDL / Verilog, a syntax-checking editor, the schematic
  editor and ASM state-machine charts kept in sync with HDL, ISE schematic import / export,
  behavioural simulation with waveforms, Xilinx ISE 14.7 implementation (Docker / local / ssh),
  UCF checks, ISE project import, English and Portuguese interface.
