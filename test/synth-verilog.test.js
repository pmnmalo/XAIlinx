// core/synth-verilog.js: the synthesis front end (elaborated design -> one flat SystemVerilog
// module for Yosys). Every design is checked the same way: the generated Verilog is compiled and
// simulated by Silinx against the original, with random stimulus, and the outputs must be equal
// at every clock cycle (registers start at 0, as on the FPGA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile, elaborate } from '../core/compile.js';
import { Simulator } from '../core/simulator.js';
import * as V from '../core/values.js';
import { toVerilog, synthWidth, lit, SynthError } from '../core/synth-verilog.js';
import { UNISIM_SOURCE, primitiveSources } from '../core/unisim.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vhd = (text, p = 'd.vhd') => ({ path: p, lang: 'vhdl', text });
const vlog = (text, p = 'd.v') => ({ path: p, lang: 'verilog', text });

function build(sources, top) {
  const d = elaborate(compile(sources), top);
  const bad = [...d.lib.errors, ...d.diags].filter(x => x.severity !== 'warning');
  assert.deepEqual(bad.map(x => `${x.file}:${x.line} ${x.message}`), []);
  return d;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function powerUp(d) {
  const allX = v => v && !Array.isArray(v) && v.w > 0 && v.x === (1n << BigInt(v.w)) - 1n;
  for (const s of d.signals) {
    if (Array.isArray(s.val)) s.val = s.val.map(e => (allX(e) ? V.withSign(V.fromInt(0, e.w, false), e.s) : e));
    else if (allX(s.val)) s.val = V.withSign(V.fromInt(0, s.val.w, false), s.val.s);
  }
}
/** Outputs of `d` every cycle under seeded random inputs (`clock` driven, the reset `rst` high the first 2 cycles). */
function runRandom(d, { clock = 'clk', cycles = 400, seed = 7, reset = 'rst', ints = new Set() } = {}) {
  const s = new Simulator(d, { maxWaveEvents: 0 });
  powerUp(d);
  const ports = new Map(d.top.ports.map(p => [p.name.toLowerCase(), p]));
  const P = 20000;
  if (ports.has(clock)) s.addClock(ports.get(clock).sig, { period: P });
  const ins = d.top.ports.filter(p => p.dir === 'in' && p.name.toLowerCase() !== clock);
  const outs = d.top.ports.filter(p => p.dir !== 'in').sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  const r = rng(seed);
  const res = [];
  for (let k = 0; k < cycles; k++) {
    const R = P / 2 + k * P;
    s.run(R + P / 4);
    for (const p of ins) {
      const w = p.sig.t.w;
      let v = 0n;
      for (let i = 0; i < w; i += 16) v |= BigInt(Math.floor(r() * 65536)) << BigInt(i);
      v &= (1n << BigInt(w)) - 1n;
      if (p.name.toLowerCase() === reset) v = k < 2 || r() < 0.02 ? 1n : 0n;
      s.force(p.sig, V.mk(w, v));
    }
    s.run(R + P - 1000);
    // integers as numbers (synthesis gives an integer port the width of its range)
    res.push(outs.map(p => `${p.name}=${ints.has(p.name.toLowerCase()) ? (p.sig.val.x ? 'X' : V.toDec(p.sig.val, !!p.sig.val.s)) : V.toBin(p.sig.val)}`).join(' '));
  }
  return res;
}
/** The generated Verilog behaves as the original: same outputs every cycle. Returns the Verilog. */
function equivalent(sources, top, opts = {}) {
  const d = build(sources, top);
  const { text, top: vtop, warnings, primitives } = toVerilog(d);
  const g = build([...(primitives.length ? [UNISIM_SOURCE] : []), vlog(text, 'gen.v')], vtop);
  // integer ports (32 bits in simulation, the width of their range after synthesis): compared as numbers
  const ints = new Set(d.top.ports.filter(p => p.sig.t.kind === 'int').map(p => p.name.toLowerCase()));
  const a = runRandom(build(sources, top), { ...opts, ints }), b = runRandom(g, { ...opts, ints });
  const k = a.findIndex((x, i) => x !== b[i]);
  assert.equal(k, -1, k < 0 ? '' : `cycle ${k}:\n  original  ${a[k]}\n  generated ${b[k]}\n${text}`);
  assert.ok(new Set(a).size > (opts.minStates ?? 3), `the outputs change during the test (${new Set(a).size} states)`);
  return { text, warnings, primitives };
}

const PRE = 'library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;\n';

test('widths: integer signals get the width of their range; literals keep x and z bits', () => {
  assert.equal(synthWidth({ kind: 'int', w: 32, rlo: 0, rhi: 9 }), 4);
  assert.equal(synthWidth({ kind: 'int', w: 32, rlo: 0, rhi: 0 }), 1);
  assert.equal(synthWidth({ kind: 'int', w: 32, rlo: -4, rhi: 3 }), 3);
  assert.equal(synthWidth({ kind: 'int', w: 32, rlo: -1, rhi: 255 }), 9);
  assert.equal(synthWidth({ kind: 'int', w: 32 }), 32);
  assert.equal(synthWidth({ kind: 'logic', w: 8 }), 8);
  assert.equal(lit(V.fromInt(5, 4, false)), "4'h5");
  assert.equal(lit(V.fromBits('1x0z')), "4'b1x0z");
});

test('registers: asynchronous reset, clock enable, synchronous reset, falling edge, edge-conditional assignments', () => {
  equivalent([vhd(`${PRE}entity r is port (clk, rst, en, d : in std_logic; q1, q2, q3, q4, q5 : out std_logic); end r;
architecture a of r is signal s1, s2, s3, s4, s5 : std_logic; begin
  process (clk, rst) begin if rst = '1' then s1 <= '0'; elsif rising_edge(clk) then if en = '1' then s1 <= d; end if; end if; end process;
  process (clk) begin if rising_edge(clk) then if rst = '1' then s2 <= '1'; else s2 <= d xor s2; end if; end if; end process;
  process (clk) begin if falling_edge(clk) then s3 <= d; end if; end process;
  s4 <= d when rising_edge(clk);
  s5 <= '0' when rst = '1' else not s5 when clk'event and clk = '1';
  q1 <= s1; q2 <= s2; q3 <= s3; q4 <= s4; q5 <= s5;
end a;`)], 'r');
});

test('integers with ranges, enumerated state machine with case, outputs decoded from the state', () => {
  const { text } = equivalent([vhd(`${PRE}entity f is port (clk, rst, go, stop : in std_logic; busy : out std_logic; n : out integer range 0 to 9; st : out std_logic_vector(1 downto 0)); end f;
architecture a of f is
  type state_t is (idle, run, hold, done);
  signal s : state_t; signal c : integer range 0 to 9;
begin
  process (clk, rst) begin
    if rst = '1' then s <= idle; c <= 0;
    elsif rising_edge(clk) then
      case s is
        when idle => if go = '1' then s <= run; c <= 0; end if;
        when run => if stop = '1' then s <= hold; elsif c = 9 then s <= done; else c <= c + 1; end if;
        when hold => if go = '1' then s <= run; end if;
        when done => s <= idle;
      end case;
    end if;
  end process;
  busy <= '1' when s = run or s = hold else '0';
  n <= c;
  st <= std_logic_vector(to_unsigned(state_t'pos(s), 2));
end a;`)], 'f');
  assert.match(text, /logic \[3:0\] c;/, 'integer range 0 to 9 -> 4 bits');
});

test('arithmetic: unsigned / signed numeric_std, resize, comparisons, shifts, rotations, multiplication', () => {
  equivalent([vhd(`${PRE}entity m is port (a, b : in std_logic_vector(7 downto 0); s : in std_logic_vector(2 downto 0);
  sum : out std_logic_vector(8 downto 0); dif : out signed(8 downto 0); prod : out unsigned(15 downto 0); lt, slt : out std_logic;
  sh_l, sh_r, rot : out std_logic_vector(7 downto 0); neg : out signed(7 downto 0)); end m;
architecture x of m is begin
  sum <= std_logic_vector(resize(unsigned(a), 9) + unsigned(b));
  dif <= resize(signed(a), 9) - resize(signed(b), 9);
  prod <= unsigned(a) * unsigned(b);
  lt <= '1' when unsigned(a) < unsigned(b) else '0';
  slt <= '1' when signed(a) < signed(b) else '0';
  sh_l <= std_logic_vector(shift_left(unsigned(a), to_integer(unsigned(s))));
  sh_r <= std_logic_vector(shift_right(signed(a), to_integer(unsigned(s))));
  rot <= std_logic_vector(rotate_left(unsigned(a), 3));
  neg <= -signed(a);
end x;`)], 'm', { clock: 'none' });
});

test('functions, procedures with signal outputs, loops with exit, case with ranges, process variables', () => {
  equivalent([vhd(`${PRE}entity p is port (clk : in std_logic; x : in std_logic_vector(7 downto 0); ones, lead : out integer range 0 to 8;
  par, big : out std_logic; seg : out std_logic_vector(6 downto 0); acc : out unsigned(7 downto 0)); end p;
architecture a of p is
  function count_ones(v : std_logic_vector) return integer is variable n : integer := 0;
  begin for i in v'range loop if v(i) = '1' then n := n + 1; end if; end loop; return n; end function;
  procedure seg7(d : in std_logic_vector(3 downto 0); signal o : out std_logic_vector(6 downto 0)) is begin
    case d is when x"0" => o <= "1000000"; when x"1" => o <= "1111001"; when x"2" => o <= "0100100"; when others => o <= "0111111"; end case;
  end procedure;
  signal r : unsigned(7 downto 0) := (others => '0');
begin
  ones <= count_ones(x);
  process (x) variable k : integer range 0 to 8; begin
    k := 8;
    for i in 7 downto 0 loop if x(i) = '1' then k := 7 - i; exit; end if; end loop;
    lead <= k;
  end process;
  par <= x(0) xor x(1) xor x(2) xor x(3) xor x(4) xor x(5) xor x(6) xor x(7);
  process (x) begin
    case to_integer(unsigned(x)) is when 0 to 99 => big <= '0'; when 100 to 255 => big <= '1'; when others => big <= '0'; end case;
  end process;
  seg7(x(3 downto 0), seg);
  process (clk) variable t : unsigned(7 downto 0); begin
    if rising_edge(clk) then t := r + unsigned(x); r <= t xor (t srl 1); end if;
  end process;
  acc <= r;
end a;`)], 'p');
});

test('memories: a constant ROM and a RAM written on the clock', () => {
  equivalent([vhd(`${PRE}entity mem is port (clk, we : in std_logic; addr : in std_logic_vector(3 downto 0); din : in std_logic_vector(7 downto 0);
  rom_q, ram_q : out std_logic_vector(7 downto 0)); end mem;
architecture a of mem is
  type rom_t is array (0 to 15) of std_logic_vector(7 downto 0);
  constant ROM : rom_t := (x"00", x"11", x"22", x"33", x"44", x"55", x"66", x"77", x"88", x"99", x"AA", x"BB", x"CC", x"DD", x"EE", x"FF");
  type ram_t is array (0 to 15) of std_logic_vector(7 downto 0);
  signal ram : ram_t := (others => (others => '0'));
begin
  rom_q <= ROM(to_integer(unsigned(addr)));
  process (clk) begin if rising_edge(clk) then
    if we = '1' then ram(to_integer(unsigned(addr))) <= din; end if;
    ram_q <= ram(to_integer(unsigned(addr)));
  end if; end process;
end a;`)], 'mem');
});

test('Verilog: always @(posedge clk or negedge rstn), case, ternary, concatenation, a function', () => {
  equivalent([vlog(`module v(input clk, input rstn, input [3:0] a, input [1:0] op, output reg [7:0] q, output [4:0] s);
  function [4:0] add5(input [3:0] x, input [3:0] y); add5 = x + y; endfunction
  assign s = op[0] ? add5(a, q[3:0]) : {1'b0, a};
  always @(posedge clk or negedge rstn)
    if (!rstn) q <= 8'h01;
    else case (op)
      2'd0: q <= {q[6:0], q[7]};
      2'd1: q <= q + a;
      2'd2: q <= q ^ {a, a};
      default: q <= ~q;
    endcase
endmodule`)], 'v', { reset: 'none' });
});

test('the blinky example (mixed VHDL and Verilog) behaves the same after translation', () => {
  const dir = path.join(ROOT, 'examples', 'blinky');
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'silinx.json'), 'utf8'));
  const srcs = pj.files.filter(f => f.role !== 'sim').map(f => ({ path: f.path, lang: /\.vhdl?$/i.test(f.path) ? 'vhdl' : 'verilog', text: fs.readFileSync(path.join(dir, f.path), 'utf8') }));
  equivalent(srcs, pj.top, { cycles: 600, minStates: 1 });
});

test('what cannot be synthesized is reported with its line, not guessed', () => {
  const err = (src, top) => { try { toVerilog(build([vhd(src)], top)); return null; } catch (e) { assert.ok(e instanceof SynthError, e.stack); return e.message; } };
  assert.match(err(`${PRE}entity w is port (o : out std_logic); end w; architecture a of w is begin
  process begin o <= '0'; wait for 10 ns; o <= '1'; wait for 10 ns; end process; end a;`, 'w'), /waits cannot be synthesized|cannot be synthesized here/);
  assert.match(err(`${PRE}entity w is port (clk, d : in std_logic; o : out std_logic); end w; architecture a of w is begin
  process (clk) begin if rising_edge(clk) then o <= d; else o <= not d; end if; end process; end a;`, 'w'), /after the clock edge/);
});

test('Verilog front end: SystemVerilog size casts W\'(expr) truncate, extend by the sign and keep the signedness', () => {
  const d = build([vlog(`module c; wire [7:0] a = 8'hF5; wire signed [3:0] b = 4'sb1010; wire [3:0] x = 4'(a >> 4); wire [7:0] y = 8'(b);
  wire [7:0] z = 8'(4'(a)); endmodule`)], 'c');
  new Simulator(d).run(10);
  const val = n => V.toBin(d.top.signals.find(s => s.name === n).val);
  assert.equal(val('x'), '1111');
  assert.equal(val('y'), '11111010', 'sign extension of a signed value');
  assert.equal(val('z'), '00000101');
});

test('initial blocks: memory contents from a loop, registers, messages ignored; the values become initial values', () => {
  const { text } = equivalent([vlog(`module ib(input clk, input we, input [3:0] a, input [7:0] d, output reg [7:0] q, output reg [7:0] cnt);
  reg [7:0] mem [0:15];
  integer i;
  initial begin
    for (i = 0; i < 16; i = i + 1) mem[i] = i * 7 + 1;
    q = 8'h00;
    cnt = 8'h5a;
    $display("start");
  end
  always @(posedge clk) begin
    if (we) mem[a] <= d;
    q <= mem[a];
    cnt <= cnt + 1;
  end
endmodule`)], 'ib', { reset: 'none' });
  assert.match(text, /mem\[3\] = 8'h16;/, 'the contents computed by the loop');
  assert.match(text, /output logic \[7:0\] cnt = 8'h5a/, 'an output register with its initial value');
  assert.doesNotMatch(text, /\$display|always @\*\s*begin\s*end/);
});

test('initial values: a VHDL process that ends in a bare wait fills a memory', () => {
  equivalent([vhd(`${PRE}entity iv is port (clk : in std_logic; q : out std_logic_vector(7 downto 0)); end iv;
architecture a of iv is
  type ram_t is array (0 to 7) of unsigned(7 downto 0);
  signal ram : ram_t;
  signal k : unsigned(2 downto 0) := "000";
  signal r : unsigned(7 downto 0) := x"11";
begin
  process begin
    for i in 0 to 7 loop ram(i) <= to_unsigned(i * i + 3, 8); end loop;
    wait;
  end process;
  process (clk) begin if rising_edge(clk) then k <= k + 1; r <= r + ram(to_integer(k)); end if; end process;
  q <= std_logic_vector(r);
end a;`)], 'iv', { reset: 'none' });
});

test('initial blocks that cannot be synthesized are reported: delays, reading a driven signal, $readmemh', () => {
  const err = (src, top) => { try { toVerilog(build([vlog(src)], top)); return null; } catch (e) { assert.ok(e instanceof SynthError, e.stack); return e.message; } };
  assert.match(err('module e1(input clk, output reg q); initial begin q = 0; #5 q = 1; end endmodule', 'e1'), /waits cannot be synthesized \(line 1\)/);
  assert.match(err('module e2(input clk, input d, output reg q, output reg r); always @(posedge clk) q <= d; initial r = q; endmodule', 'e2'), /reads q, which another process drives/);
  assert.match(err('module e3(input [1:0] a, output [7:0] q); reg [7:0] m [0:3]; initial $readmemh("m.hex", m); assign q = m[a]; endmodule', 'e3'), /\$readmemh/);
});

test('process variables and loop flags are named without dots (Yosys takes a dotted name for a hierarchical one)', () => {
  const { text } = equivalent([vhd(`${PRE}entity n is port (clk : in std_logic; x : in std_logic_vector(7 downto 0); q : out unsigned(3 downto 0)); end n;
architecture a of n is begin
  process (clk) variable k : unsigned(3 downto 0); begin
    if rising_edge(clk) then
      k := x"0" + 8;
      for i in 0 to 7 loop if x(i) = '1' then k := to_unsigned(i, 4); exit; end if; end loop;
      q <= k;
    end if;
  end process;
end a;`)], 'n', { reset: 'none' });
  assert.match(text, /p\d+_v\d+/);
  assert.doesNotMatch(text, /\\p\d+\./);
});

test('Xilinx primitives instantiated by name stay instances with their generics; their simulation models are left out', () => {
  const src = vhd(`library ieee; use ieee.std_logic_1164.all; library unisim; use unisim.vcomponents.all;
entity pr is port (clk, d, ce : in std_logic; a : in std_logic_vector(3 downto 0); q, q2 : out std_logic); end pr;
architecture a of pr is signal clkb, s : std_logic; begin
  ub : BUFG port map (I => clk, O => clkb);
  us : SRL16E generic map (INIT => X"A5C3") port map (CLK => clkb, CE => ce, D => d, A0 => a(0), A1 => a(1), A2 => a(2), A3 => a(3), Q => s);
  q <= s;
  process (clkb) begin if rising_edge(clkb) then q2 <= s xor d; end if; end process;
end a;`);
  const { text, primitives } = equivalent([...primitiveSources([src]), src], 'pr', { reset: 'none' });
  assert.deepEqual(primitives.sort(), ['BUFG', 'SRL16E']);
  assert.match(text, /SRL16E #\(\n {4}\.INIT\(16'ha5c3\)\n {2}\) us \(/);
  assert.match(text, /BUFG ub \(\n {4}\.I\(clk\),\n {4}\.O\(clkb\)\n {2}\);/);
  assert.doesNotMatch(text, /started|rising_edge|\bus\.r\b/i, 'nothing of the simulation model');
});

// ---------------------------------------------------------------- the fixture designs
// test/fixtures/designs/<design>: sources and design.json (top, files, the `sim` section with the
// stimulus, as test/netgen-fixtures.test.js uses it). Each design is translated; the translation is
// simulated against the original; then, if Yosys is installed (not in CI), Yosys's netlist of the
// translation (synth_xilinx for the Spartan-3E) is simulated with Silinx's UNISIM models against the
// original too.
//
// A design with a bidirectional bus runs inside its harness (design.json sim.harness), which drives
// the bus when the design does not: left floating, the bus is 'Z' and a register that captures it
// holds 'Z' in the simulation of the original, a value no flip-flop can hold (an input buffer turns
// it into 'X' in the netlist). That difference is an artifact of simulating an undriven pin, not of
// the translation.
const DESIGNS = path.join(ROOT, 'test', 'fixtures', 'designs');
const fixtures = fs.readdirSync(DESIGNS).filter(n => fs.existsSync(path.join(DESIGNS, n, 'design.json'))).sort();
const langOf = f => (/\.(vhd|vhdl)$/i.test(f) ? 'vhdl' : 'verilog');

// deterministic pseudo-random numbers (mulberry32), seeded by the design name
function rngOf(seedText) {
  let a = [...seedText].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 0x9e3779b9);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Input values per cycle (the `sim` section of design.json, as in test/netgen-fixtures.test.js). */
function stimulus(name, sim, inputs, cycles) {
  const r = rngOf(name);
  const bits = w => { let v = 0n; for (let i = 0; i < w; i += 16) v |= BigInt(Math.floor(r() * 65536)) << BigInt(i); return v & ((1n << BigInt(w)) - 1n); };
  const out = [];
  let cur = {};
  for (let k = 0; k < cycles; k++) {
    if (k % (sim.hold || 1) === 0) {
      cur = {};
      for (const { name: p, w } of inputs) {
        if (sim.prob?.[p] !== undefined) cur[p] = r() < sim.prob[p] ? 1n : 0n;
        else if (sim.bitprob?.[p]) cur[p] = sim.bitprob[p].reduce((v, pr, i) => v | (r() < pr ? 1n << BigInt(i) : 0n), 0n);
        else if (sim.ranges?.[p]) { const [lo, hi] = sim.ranges[p]; cur[p] = BigInt(lo + Math.floor(r() * (hi - lo + 1))); }
        else cur[p] = bits(w);
      }
      for (const [a, b] of Object.entries(sim.equalBias || {})) if (r() < 0.2) cur[a] = cur[b];
      // ports of a dual-port memory that must not address the same word in the same cycle
      for (const d of sim.distinct || []) {
        const m = BigInt(d.mask), sa = BigInt(d.shiftA || 0), sb = BigInt(d.shiftB || 0);
        if (((cur[d.a] >> sa) & m) === ((cur[d.b] >> sb) & m)) cur[d.b] ^= 1n << sb;
      }
    }
    out.push(k < 3 && sim.start ? { ...cur, ...Object.fromEntries(Object.entries(sim.start).map(([p, v]) => [p, BigInt(v)])) } : cur);
  }
  return out;
}
/**
 * Outputs of `design` every cycle: the inputs of cycle k applied a quarter period after its rising
 * edge (the `late` ones three quarters), the outputs sampled 1 ns before the next one. `up`: the
 * registers without an initial value start at 0, as on the FPGA (not for a netlist: its flip-flops
 * have their INIT, and zeroing its combinational nets would make them disagree with their inputs
 * for a moment at time 0, long enough to open a latch).
 */
function runFixture(design, sim, stim, up = true) {
  const P = sim.period;
  const s = new Simulator(design, { maxWaveEvents: 0 });
  if (up) powerUp(design);
  const port = new Map(design.top.ports.map(p => [p.name.toLowerCase(), p]));
  s.addClock(port.get(sim.clock.toLowerCase()).sig, { period: P });
  for (const [c, o] of Object.entries(sim.clocks || {})) s.addClock(port.get(c.toLowerCase()).sig, { period: o.period, offset: o.offset || 0 });
  const late = new Set((sim.late || []).map(x => x.toLowerCase()));
  const outs = design.top.ports.filter(p => p.dir !== 'in').sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  const apply = (vals, which) => {
    for (const [p, v] of Object.entries(vals)) {
      if (which !== undefined && late.has(p.toLowerCase()) !== which) continue;
      const sig = port.get(p.toLowerCase()).sig;
      s.force(sig, V.mk(sig.t.w, v));
    }
  };
  apply(stim[0]);
  const res = [];
  for (let k = 0; k < stim.length; k++) {
    const R = P / 2 + k * P;
    s.run(R + P / 4); apply(stim[k], false);
    s.run(R + (3 * P) / 4); apply(stim[k], true);
    s.run(R + P - 1000);
    res.push(outs.map(p => `${p.name}=${V.toBin(p.sig.val)}`).join(' '));
  }
  return res;
}
/** A fixture: its sources, the original's outputs, and its translation (`over`: changes to its `sim`). */
const fixtureCache = new Map();
function fixture(name, over) {
  const key = `${name} ${JSON.stringify(over || {})}`;
  if (fixtureCache.has(key)) return fixtureCache.get(key);
  const dir = path.join(DESIGNS, name);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
  const sim = { ...spec.sim, ...over };
  const srcs = spec.files.map(f => ({ path: f, lang: langOf(f), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const harness = sim.harness ? [{ path: sim.harness, lang: 'vhdl', text: fs.readFileSync(path.join(dir, sim.harness), 'utf8') }] : [];
  const simTop = sim.harness ? 'harness' : spec.top;
  const original = () => build([...primitiveSources(srcs), ...srcs, ...harness], simTop);
  const d0 = original();
  const inputs = d0.top.ports.filter(p => p.dir === 'in' && p.name.toLowerCase() !== sim.clock.toLowerCase() && !(p.name in (sim.clocks || {})))
    .map(p => ({ name: p.name, w: p.sig.t.w }));
  const stim = stimulus(name, sim, inputs, Math.min(sim.cycles, 3000));
  const ref = runFixture(d0, sim, stim);
  const gen = toVerilog(build([...primitiveSources(srcs), ...srcs], spec.top));
  const f = { spec, sim, harness, simTop, stim, ref, gen };
  fixtureCache.set(key, f);
  return f;
}
function compare(f, got, what) {
  const k = f.ref.findIndex((x, i) => i >= (f.sim.skip || 0) && x !== got[i]);
  assert.equal(k, -1, k < 0 ? '' : `${what}: first difference at cycle ${k}\n  original ${f.ref[k]}\n  ${what} ${got[k]}`);
}

for (const name of fixtures) {
  test(`fixture ${name}: the generated Verilog simulates as the original`, () => {
    const f = fixture(name);
    const g = build([...(f.gen.primitives.length ? [UNISIM_SOURCE] : []), vlog(f.gen.text, `${name}.v`), ...f.harness], f.simTop);
    compare(f, runFixture(g, f.sim, f.stim), 'generated');
    assert.ok(new Set(f.ref).size > 3, 'the outputs change during the test');
  });
}

// Yosys connects the pad pin of each IOBUF to one bit of the inout port; Silinx elaborates an inout
// formal associated with part of a signal as an output only, so (as test/netgen-fixtures.test.js
// does for netgen's netlists, core/netlist-hier.js splitInoutBuffers) each IOBUF is simulated as
// the equivalent OBUFT (driving the pad) and IBUF (reading the resolved pad).
function splitIobufs(text) {
  return text.replace(/\bIOBUF\s+(\S+)\s*\(([^;]*)\);/g, (all, inst, body) => {
    const pin = Object.fromEntries([...body.matchAll(/\.(\w+)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map(m => [m[1], m[2].trim()]));
    if (!pin.IO) return all;
    return `OBUFT ${inst}_t (.I(${pin.I || ''}), .T(${pin.T || ''}), .O(${pin.IO}));\n  IBUF ${inst}_i (.I(${pin.IO}), .O(${pin.O || ''}));`;
  });
}
// Yosys puts the gate enable of the latch fixture in the LUT that drives the gate (ISE uses the
// latch's GE pin): ge changing at the same instant as d (which goes straight to the latch) then
// races with it in a zero-delay simulation, as it would on the chip. ge changes with the gate here.
const YOSYS_SIM = { latch: { late: ['g', 'ge', 'g3'] } };
const hasYosys = (() => { try { execFileSync('yosys', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('fixture designs through Yosys (synth_xilinx -family xc3se): the netlist simulates as the original', { skip: hasYosys ? false : 'yosys is not on PATH' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silinx-yosys-'));
  try {
    for (const name of fixtures) {
      await t.test(name, () => {
        const f = fixture(name, YOSYS_SIM[name]);
        fs.writeFileSync(path.join(tmp, `${name}.v`), f.gen.text);
        execFileSync('yosys', ['-q', '-p', `read_verilog -sv ${name}.v; synth_xilinx -family xc3se -ise -flatten -top ${f.gen.top}; delete t:$scopeinfo; write_verilog -noattr ${name}_net.v`],
          { cwd: tmp, stdio: ['ignore', 'ignore', 'pipe'] });
        const net = splitIobufs(fs.readFileSync(path.join(tmp, `${name}_net.v`), 'utf8'))
          // a flip-flop whose register had no initial value gets INIT x from Yosys: 0 in the bitstream
          .replace(/\.INIT\((\d+)'([bh])([0-9a-fx]+)\)/g, (_, w, b, d) => `.INIT(${w}'${b}${d.replace(/x/g, '0')})`);
        const d = build([UNISIM_SOURCE, vlog(net, `${name}_net.v`), ...f.harness], f.simTop);
        compare(f, runFixture(d, f.sim, f.stim, false), 'netlist');
      });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
