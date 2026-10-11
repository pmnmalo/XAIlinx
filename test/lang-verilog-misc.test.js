// Verilog conformance: further details — #0, x results of division by zero, signedness of
// part-selects and concatenations, real variables, SystemVerilog conveniences the parser accepts,
// parameters with ranges, instance arrays, multi-dimensional memories, race-free clocking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, sim, vinit, vlog, diags } from './lang-util.js';

test('division and modulus by zero give x; x operands make arithmetic results all x', () => {
  const r = out(vinit(`
    a = 8'd7; b = 0;
    q = a / b; m = a % b; $display("%b %b", q, m);
    b = 8'bx; s = a + b; $display("%b", s);
    i = 5 / 0; $display("%0d", i);`,
  `reg [7:0] a, b, q, m, s; integer i;`));
  assert.deepEqual(r, ['xxxxxxxx xxxxxxxx', 'xxxxxxxx', 'x']);
});

test('part-selects and concatenations are unsigned even of signed operands; $signed restores the sign', () => {
  const r = out(vinit(`
    s = -4;
    w = s[3:0]; $display("%0d", w);
    w = {s}; $display("%0d", w);
    w = $signed(s[3:0]); $display("%0d", w);
    w = s; $display("%0d", w);
    $display("%0d", s[3:0] < 0);`,
  `reg signed [3:0] s; reg signed [7:0] w;`));
  // s[3:0] is the unsigned 4'b1100 (12), zero-extended
  assert.deepEqual(r, ['12', '12', '-4', '-4', '0']);
});

test('#0 delays: the process resumes in the same time step after the other active processes', () => {
  const r = out(vlog(`
  reg a = 0;
  initial begin #0 $display("a=%0d", a); end
  initial a = 1;`));
  assert.deepEqual(r, ['a=1']);
});

test('real variables: arithmetic, comparisons, conversion when assigned to integers and regs; %f / %g', () => {
  const r = out(vinit(`
    x = 1.5; y = x * 2 + 0.25; $display("%f %0.2f", y, y / 2);
    i = y; v = x * 3; $display("%0d %0d", i, v);
    $display("%0d %0d", x < y, x == 1.5);`,
  `real x, y; integer i; reg [7:0] v;`));
  // 3.25 -> 3; 4.5 -> 5 (round half away from zero)
  assert.deepEqual(r, ['3.250000 1.63', '3 5', '1 1']);
});

test('parameters with a range or a type, localparam expressions, parameters in widths and loops', () => {
  const r = out(vlog(`
  parameter [3:0] P = 5'h1F;
  parameter integer N = 3;
  parameter signed [7:0] S = -2;
  localparam M = N * 2 + P;
  reg [M-1:0] r;
  initial $display("%0d %0d %0d %0d %0d", P, N, S, M, $bits(r));`));
  // P is truncated to its 4-bit range
  assert.deepEqual(r, ['15 3 -2 21 21']);
});

test('SystemVerilog conveniences accepted: logic, always_ff / always_comb, ++ / += in loops, \'0 / \'1 fills', () => {
  const r = out(vlog(`
  logic clk = 0; logic [3:0] q = '0; logic [3:0] c;
  always_ff @(posedge clk) q <= q + 1;
  always_comb c = ~q;
  integer i, s;
  initial begin
    s = 0; for (int k = 0; k < 4; k++) s += k;
    for (i = 0; i < 3; i++) begin clk = 1; #1 clk = 0; #1; end
    $display("%0d %0d %b %b", s, q, c, '1 & 4'b1010);
  end`));
  assert.deepEqual(r, ['6 3 1100 1010']);
});

test('instance arrays (u[3:0]) connect one bit of each vector actual per instance', { todo: 'arrays of instances are not supported by the Verilog parser' }, () => {
  const r = out(`
module inv(input a, output y); assign y = ~a; endmodule
module tb; reg [3:0] a = 4'b1010; wire [3:0] y; inv u[3:0] (.a(a), .y(y)); initial #1 $display("%b", y); endmodule`);
  assert.deepEqual(r, ['0101']);
});

test('multi-dimensional memories (reg [7:0] m [0:1][0:3])', () => {
  const r = out(vinit(`
    for (i = 0; i < 2; i = i + 1) for (j = 0; j < 4; j = j + 1) m[i][j] = i * 16 + j;
    m[1][2] = 8'hAB; m[0][3][7] = 1'b1;
    $display("%h %h %h %h", m[1][2], m[1][3], m[0][3], m[0][0]);`, `reg [7:0] m [0:1][0:3]; integer i, j;`));
  assert.deepEqual(r, ['ab 13 83 00']);
});

test('clocking is race-free with non-blocking assignments across modules (pipeline of registers)', () => {
  const r = out(`
module ff(input clk, input [3:0] d, output reg [3:0] q); always @(posedge clk) q <= d; endmodule
module tb; reg clk = 0; reg [3:0] d = 0; wire [3:0] q1, q2, q3;
  ff a(clk, d, q1); ff b(clk, q1, q2); ff c(clk, q2, q3);
  always #5 clk = ~clk;
  always @(posedge clk) d <= d + 1;
  initial begin #42 $display("%0d %0d %0d %0d", d, q1, q2, q3); $finish; end
endmodule`);
  // edges at 5, 15, 25, 35: d counts 4 times; each stage lags by one edge
  assert.deepEqual(r, ['4 3 2 1']);
});

test('strings: comparison, concatenation into a vector, %s of a reg; $sformatf-free formatting with $display', () => {
  const r = out(vinit(`
    s = "ab"; t = {s, "c"};
    $display("%s %0d %0d", t, s == "ab", s == "ba");`,
  `reg [15:0] s; reg [23:0] t;`));
  assert.deepEqual(r, ['abc 1 0']);
});

test('functions with a range return and signed / integer arguments; task enabling with no arguments', () => {
  const r = out(vlog(`
  function signed [7:0] neg(input signed [7:0] v); neg = -v; endfunction
  function [3:0] low(input [7:0] v); low = v[3:0]; endfunction
  integer calls = 0;
  task bump; calls = calls + 1; endtask
  initial begin bump; bump; $display("%0d %0d %h", neg(-8'sd5), calls, low(8'hA7)); end`));
  assert.deepEqual(r, ['5 2 7']);
});

test('always blocks with event lists on vector bits and expressions; @(a or b) wakes once per time step change', () => {
  const r = out(vlog(`
  reg [3:0] v; integer n = 0, m = 0, n0, m0;
  always @(v[1]) n = n + 1;
  always @(v[0] or v[3]) m = m + 1;
  initial begin
    #1 n0 = n; m0 = m;   // (counts from here: whether a block also runs at time 0 is left aside)
    v = 0; #1 v = 4'b0001; #1 v = 4'b0011; #1 v = 4'b1011; #1 v = 4'b1011; #1 $display("%0d %0d", n - n0, m - m0);
  end`));
  // x -> 0 at 1 wakes both; then v[1] changes at 3, v[0] at 2, v[3] at 4 (rewriting the same value is no change)
  assert.deepEqual(r, ['2 3']);
});

test('continuous assignment delays: inertial (a pulse shorter than the delay is filtered)', () => {
  const r = sim(vlog(`
  reg a = 0; wire y; assign #3 y = a;
  initial begin #10 a = 1; #1 a = 0; #10 a = 1; #5 a = 0; #10 $finish; end`));
  const y = r.design.signals.find(s => s.name === 'y');
  // y becomes 0 at 3 ns; the 1 ns pulse at 10 ns is filtered; the 5 ns pulse at 21 ns appears at 24 ns .. 29 ns
  assert.deepEqual(y.wave.t, [0, 3000, 24000, 29000]);
});

test('concatenation as a continuous-assignment target (carry out of an adder); active-low asynchronous reset', () => {
  const r = out(vlog(`
  reg [3:0] a = 9, b = 8; reg cin = 1; wire [3:0] s; wire co;
  assign {co, s} = a + b + cin;
  reg clk = 0, rst_n = 0; reg [1:0] q;
  always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= q + 1;
  always #5 clk = ~clk;
  initial begin #1 $display("%b %b", co, s); #11 rst_n = 1; #30 $display("%0d", q); $finish; end`));
  // 9 + 8 + 1 = 18 = 1_0010; rising edges at 15, 25, 35 ns after the reset is released
  assert.deepEqual(r, ['1 0010', '3']);
});

test('file output tasks write to the log ($fopen / $fdisplay / $fwrite / $fclose); $sformat and $sformatf', () => {
  const r = out(vlog(`
  integer f; reg [8*10:1] s;
  initial begin
    f = $fopen("out.txt", "w");
    $fdisplay(f, "v=%0d", 7); $fwrite(f, "a"); $fwrite(f, "b\\n"); $fclose(f);
    $sformat(s, "%0d-%0d", 3, 4); $display("%0s", s);
    $display("%s", $sformatf("<%h>", 8'hA5));
  end`));
  assert.deepEqual(r, ['v=7', 'ab', '3-4', '<a5>']);
});

test('integer arrays, forever @(posedge), specify blocks are ignored, .* connections, genvar declared in the loop, $realtime', () => {
  const r = sim(`\`timescale 1ns/1ps
module inv(input a, output y); assign y = ~a; specify (a => y) = 1; endspecify endmodule
module tb;
  integer arr [0:3]; integer i, n = 0; reg clk = 0; reg a = 1; wire y; wire [3:0] w;
  inv u(.*);
  generate for (genvar g = 0; g < 4; g = g + 1) begin : gb assign w[g] = g[0]; end endgenerate
  always #5 clk = ~clk;
  initial begin
    for (i = 0; i < 4; i = i + 1) arr[i] = i * i - 2;
    #1 $display("%0d %0d %b %b", arr[0], arr[3], y, w);
    #0.5 $display("%0.1f", $realtime);
    forever @(posedge clk) begin n = n + 1; if (n == 3) begin $display("%0t", $time); $finish; end end
  end
endmodule`).out;
  assert.deepEqual(r, ['-2 7 0 1010', '1.5', '25']);
});

test('integer overflow wraps around; ** with negative exponents (1, -1, 0 and other bases)', () => {
  const r = out(vinit(`
    i = 2147483647; i = i + 1; $display("%0d", i);
    $display("%0d %0d %0d %0d %0d", 2 ** -1, 1 ** -2, (-1) ** -3, (-1) ** -2, 0 ** -1);`,
  'integer i;'));
  assert.deepEqual(r, ['-2147483648', '0 1 -1 1 x']);
});

// Regressions found by comparing Silinx with Yosys on Yosys's own test designs (test/corpus:
// tests/simple hierarchy.v, hierdefparam.v, scopes.v, verilog_primitives.v, defvalue.sv,
// realexpr.v, various/pmux2shiftx.v).
test('a port reads with its own signedness, not its actual\'s (an unsigned port on a signed wire)', () => {
  const r = out(`module sub(input [3:0] b, output [7:0] y); assign y = b; endmodule
module tb; reg signed [3:0] b = -4'sd8; wire [7:0] y; sub u(.b(b), .y(y));
initial #1 $display("%b", y); endmodule`);
  assert.deepEqual(r, ['00001000']);
});

test('defparam through generate blocks (foo.mod_a.bar[0].mod_b.p)', () => {
  const r = out(`module b #(parameter [7:0] v = 44) (output [7:0] y); assign y = v; endmodule
module a(output [7:0] y0, y1); genvar i; wire [7:0] w0, w1;
  generate for (i = 0; i < 2; i = i + 1) begin: bar wire [7:0] o; b mod_b(.y(o)); end endgenerate
  assign y0 = bar[0].o, y1 = bar[1].o; endmodule
module tb; wire [7:0] y0, y1;
  generate begin: foo a mod_a(.y0(y0), .y1(y1)); end endgenerate
  defparam foo.mod_a.bar[0].mod_b.v = 42;
  defparam foo.mod_a.bar[1].mod_b.v = 43;
  initial #1 $display("%0d %0d", y0, y1); endmodule`);
  assert.deepEqual(r, ['42 43']);
});

test('declarations in functions, tasks and named blocks are local, even with the name of a module port', () => {
  const r = out(`module m(input [3:0] k, output reg [15:0] x, y);
  function [15:0] f(input [15:0] x, y); begin f = x + y; begin: blk reg [15:0] x; x = y; f = f ^ x; end f = f ^ x; end endfunction
  task t(input [3:0] a); reg [15:0] y; begin y = a * 23; x = x + y; end endtask
  always @* begin x = f(11, 22); y = 7; t(k); end
endmodule
module tb; wire [15:0] x, y; m u(.k(4'd10), .x(x), .y(y)); initial #1 $display("%0d %0d", x, y); endmodule`);
  // f: (11 + 22) ^ 22 ^ 11 = 60; t's y is its own: x = 60 + 230, the port y stays 7
  assert.deepEqual(r, ['290 7']);
});

test('not / buf gates with several outputs (every terminal but the last is an output)', () => {
  const r = out(`module tb; reg i = 1; wire o1, o2, o3, b1, b2;
  not n(o1, o2, o3, i); buf b(b1, b2, i);
  initial #1 $display("%b%b%b %b%b", o1, o2, o3, b1, b2); endmodule`);
  assert.deepEqual(r, ['000 11']);
});

test('an undeclared gate input is an implicit net (asicworld full_subtracter_gates)', () => {
  const r = out(`module tb; wire o, p; and g(o, 1'b1, undeclared); or h(p, 1'b1, other);
  initial #1 $display("%b %b", o, p); endmodule`);
  assert.deepEqual(r, ['x 1']);
});

test('a port declared twice is an error', () => {
  const d = diags('module tb(input [3:0] a, a, output y); endmodule');
  assert.ok(d.some(x => x.severity === 'error' && /port 'a' is declared twice/.test(x.message)), JSON.stringify(d));
});

test('port initializers: an output variable starts at its value, an unconnected input takes its default', () => {
  const r = out(`module cnt #(parameter integer init = 0) (input clk, output logic [3:0] q = init, input [3:0] d = 10);
  always @(posedge clk) q <= q + d; endmodule
module tb; reg clk = 0; wire [3:0] q1, q2;
  cnt #(1) a(.clk(clk), .q(q1), .d(4'd4)); cnt #(2) b(.clk(clk), .q(q2));
  initial begin #1 $display("%0d %0d", q1, q2); clk = 1; #1 $display("%0d %0d", q1, q2); end endmodule`);
  assert.deepEqual(r, ['1 2', '5 12']);
});

test('?: with a real operand is real (1 ? -1 : 1.0 assigned to a 64-bit vector is -1)', () => {
  const r = out(vinit(`
    y = 1 ? -1 : 'd0 ? 1.5 : 0.0; $display("%h", y);
    y = 1 ? -1 : 'd0; $display("%h", y);`,
  `reg [63:0] y;`));
  // the second: an unsigned ?: ('d0 is unsigned), -1 zero-extended from 32 bits
  assert.deepEqual(r, ['ffffffffffffffff', '00000000ffffffff']);
});
