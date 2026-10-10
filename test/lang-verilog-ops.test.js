// Verilog conformance: operators and the expression width / signedness rules
// (IEEE 1364-2005 §5: operators, §5.4 bit lengths, §5.5 signed expressions, 4-state logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, vinit } from './lang-util.js';

test('arithmetic operators + - * / % ** and unary minus on unsigned vectors (results wrap to the context width)', () => {
  const r = out(vinit(`
    a = 200; b = 100;
    s8 = a + b; s9 = a + b; $display("%0d %0d", s8, s9);
    s8 = b - a; $display("%0d", s8);
    s16 = a * b; $display("%0d", s16);
    $display("%0d %0d %0d", a / 7, a % 7, 2 ** 10);
    s8 = -a; $display("%0d", s8);
    $display("%0d", 8'd7 / 8'd0 === 8'bx);`,
  `reg [7:0] a, b, s8; reg [8:0] s9; reg [15:0] s16;`));
  // 200 + 100 = 300: 44 in 8 bits, 300 in 9; 100 - 200 = -100 = 156; x / 0 is x
  assert.deepEqual(r, ['44 300', '156', '20000', '28 4 1024', '56', '1']);
});

test('expression width: the context (LHS) width extends the operands before the operation', () => {
  const r = out(vinit(`
    a = 8'hFF; b = 8'h01;
    s9 = a + b; $display("%h", s9);
    s9 = (a + b) >> 1; $display("%h", s9);
    s8 = (a + b) >> 1; $display("%h", s8);
    $display("%h", {a + b});
    s16 = a << 4; $display("%h", s16);
    s9 = ~a; $display("%b", s9);`,
  `reg [7:0] a, b, s8; reg [8:0] s9; reg [15:0] s16;`));
  // {a + b} is self-determined (8 bits); ~a in a 9-bit context is ~(9'h0FF)
  // (a + b) >> 1 in an 8-bit context loses the carry before the shift
  assert.deepEqual(r, ['100', '080', '00', '00', '0ff0', '100000000']);
});

test('signed arithmetic: signed regs, integer, $signed / $unsigned, mixing signed and unsigned makes the expression unsigned', () => {
  const r = out(vinit(`
    sa = -8'sd5; sb = 8'sd3;
    $display("%0d %0d %0d %0d", sa + sb, sa * sb, sa / sb, sa % sb);
    s16 = sa; $display("%0d %h", s16, s16);
    u16 = sa; $display("%h", u16);
    u16 = sa + ub; $display("%h", u16);
    $display("%0d", $signed(4'b1100));
    $display("%0d", $unsigned(sa));
    i = -7; $display("%0d %0d %0d", i / 2, i % 2, i >>> 1);
    $display("%0d", sa < 0);
    $display("%0d", sa < ub);`,
  `reg signed [7:0] sa, sb; reg [7:0] ub = 1; reg signed [15:0] s16; reg [15:0] u16; integer i;`));
  // sa is sign-extended into a wider target; sa + ub is unsigned (sa read as 251)
  assert.deepEqual(r, ['-2 -15 -1 -2', '-5 fffb', 'fffb', '00fc', '-4', '251', '-3 -1 -4', '1', '0']);
});

test('relational and equality operators, including x / z: == gives x, === compares exactly', () => {
  const r = out(vinit(`
    $display("%b %b %b %b", a < b, a <= b, a > b, a >= b);
    $display("%b %b %b %b", a == 4'b0011, a != 4'b0011, x == 4'b1x01, x != 4'b0000);
    $display("%b %b %b", x === 4'b1x01, x !== 4'b1x01, z === 4'bzzzz);
    $display("%b", x < 4'b1111);`,
  `reg [3:0] a = 3, b = 5, x = 4'b1x01, z = 4'bz;`));
  // x != 0000 is a definite 1 (bit 3 differs); x < 1111 is x
  assert.deepEqual(r, ['1 1 0 0', '1 0 x 1', '1 0 1', 'x']);
});

test('logical operators && || ! with x operands, and short-circuit evaluation', () => {
  const r = out(vinit(`
    $display("%b %b %b %b", 2'b10 && 1'b1, 2'b00 || 1'b0, !4'b0000, !4'b0100);
    $display("%b %b %b %b", 1'bx && 1'b0, 1'bx && 1'b1, 1'bx || 1'b1, !1'bx);
    k = 0; if (0 && f(1)) ; if (1 || f(1)) ; $display("%0d", k);`,
  `integer k; function f(input x); begin k = k + 1; f = x; end endfunction`));
  assert.deepEqual(r, ['1 0 1 0', '0 x 1 x', '0']);
});

test('bitwise operators & | ^ ~^ ^~ ~ with x and z bits', () => {
  const r = out(vinit(`
    $display("%b %b %b %b %b", a & b, a | b, a ^ b, a ~^ b, ~a);
    $display("%b %b %b", c & d, c | d, c ^ d);`,
  `reg [3:0] a = 4'b1100, b = 4'b1010, c = 4'b01xz, d = 4'b1100;`));
  // 0 & x = 0, 1 | x = 1, z behaves as x
  assert.deepEqual(r, ['1000 1110 0110 1001 0011', '0100 11xx 10xx']);
});

test('reduction operators & ~& | ~| ^ ~^ including x bits', () => {
  const r = out(vinit(`
    $display("%b%b%b%b%b%b", &a, ~&a, |a, ~|a, ^a, ~^a);
    $display("%b%b%b%b", &b, |b, ^b, &c);`,
  `reg [3:0] a = 4'b1101, b = 4'b10x1, c = 4'b0x11;`));
  assert.deepEqual(r, ['011010', '01x0']);
});

test('shift operators << >> <<< >>>: arithmetic right shift only for signed operands', () => {
  const r = out(vinit(`
    $display("%b %b %b %b", u << 2, u >> 2, u <<< 1, u >>> 1);
    $display("%b %b", s >>> 2, s >> 2);
    $display("%b %b", u << n, u >> 5);`,
  `reg [7:0] u = 8'b1001_0110; reg signed [7:0] s = 8'sb1001_0110; reg [2:0] n = 3'bx1x;`));
  // a shift by an x amount gives x
  assert.deepEqual(r, ['01011000 00100101 00101100 01001011', '11100101 00100101', 'xxxxxxxx 00000100']);
});

test('conditional operator, nested; an x condition merges the two values bit by bit', () => {
  const r = out(vinit(`
    $display("%h %h", c ? a : b, !c ? a : b);
    $display("%b", cx ? 4'b1100 : 4'b1010);
    $display("%0d", a > b ? (a > 8'd100 ? 2 : 1) : 0);`,
  `reg c = 1, cx = 1'bx; reg [7:0] a = 8'hAA, b = 8'h55;`));
  assert.deepEqual(r, ['aa 55', '1xx0', '2']);
});

test('concatenation and replication: {a, b}, {n{x}}, nested, as an assignment target', () => {
  const r = out(vinit(`
    $display("%b", {a, b});
    $display("%b", {3{a}});
    $display("%b", {2{a, 1'b0}});
    $display("%h", {{4{b[1]}}, b});
    {c, d} = 6'b101011; $display("%b %b", c, d);
    {c, d} = {d, c}; $display("%b %b", c, d);`,
  `reg [1:0] a = 2'b10; reg [3:0] b = 4'b0110; reg [2:0] c, d;`));
  assert.deepEqual(r, ['100110', '101010', '100100', 'f6', '101 011', '011 101']);
});

test('part-selects: constant [m:n], indexed +: and -:, bit-selects with variable index, out of range reads give x', () => {
  const r = out(vinit(`
    $display("%h %h %b %b", v[15:8], v[7:0], v[0], v[15]);
    i = 4; $display("%h %h", v[i +: 8], v[i + 7 -: 8]);
    $display("%h %h", w[0 +: 8], w[15 -: 4]);
    v[11:8] = 4'h0; $display("%h", v);
    v[i +: 4] = 4'hF; $display("%h", v);
    v[i] = 1'b0; $display("%h", v);
    $display("%b %b", v[16], v[i + 20]);`,
  `reg [15:0] v = 16'hA5C3; reg [0:15] w = 16'h1234; integer i;`));
  // w is declared [0:15]: w[0 +: 8] is w[0:7], the leftmost byte
  assert.deepEqual(r, ['a5 c3 1 1', '5c 5c', '12 4', 'a0c3', 'a0f3', 'a0e3', 'x x']);
});

test('integer, real and time types; real to integer conversion rounds', () => {
  const r = out(vinit(`
    i = 7 / 2; r = 7 / 2; s = 7.0 / 2; $display("%0d %0d %f", i, r, s);
    i = 2.5; j = -2.5; $display("%0d %0d", i, j);
    t = 10; $display("%0d %0t", t, t);
    $display("%0d %0d %f", $rtoi(3.9), $rtoi(-3.9), $itor(5) / 2);`,
  `integer i, j, r; real s; time t;`));
  // 7 / 2 is an integer division; a real assigned to an integer is rounded away from zero
  // $rtoi truncates toward zero
  assert.deepEqual(r, ['3 3 3.500000', '3 -3', '10 10', '3 -3 2.500000']);
});

test('operator precedence (unary > ** > * / % > + - > shifts > relational > equality > & > ^ > | > && > || > ?:)', () => {
  const r = out(vinit(`
    $display("%0d %0d %0d", 2 + 3 * 4, 2 * 3 ** 2, 1 << 2 + 1);
    $display("%0d %0d %0d", 1 | 2 & 3, 4'b1100 ^ 4'b1010 | 4'b0001, 1 + 2 == 3);
    $display("%0d %0d", 1 || 0 && 0, -2 ** 2);`));
  assert.deepEqual(r, ['14 18 8', '3 7 1', '1 4']);
});

test('sized and unsized literals, based literals with x / z / ?, underscores, negative sized literals', () => {
  const r = out(vinit(`
    $display("%b %b %b %h", 4'd5, 4'b1x0z, 4'b10?1, 16'hdead_beef);
    $display("%h %h %b", 'hFF, 12'o7777, 8'bz);
    $display("%0d %h", -8'd1, -8'd1);
    a = 'bx; $display("%b", a);
    a = 'bz; $display("%b", a);
    a = 1'bx; $display("%b", a);`,
  `reg [7:0] a;`));
  // 16'hdeadbeef is truncated to 16 bits; 'bx fills the whole 8-bit target; 1'bx is zero-extended
  assert.deepEqual(r, ['0101 1x0z 10z1 beef', '000000ff fff zzzzzzzz', '255 ff', 'xxxxxxxx', 'zzzzzzzz', '0000000x']);
});

test('string literals are packed 8-bit characters; %s prints them', () => {
  const r = out(vinit(`
    s = "Hi!"; $display("%s|%h|%0d", s, s, $bits(s));
    t = "ab"; $display("%s %0d", t, t == 16'h6162);`,
  `reg [8*3-1:0] s; reg [15:0] t;`));
  assert.deepEqual(r, ['Hi!|486921|24', 'ab 1']);
});

// Regressions found by differential testing against Yosys (test/corpus/vloghammer.mjs, a port of
// VlogHammer's generator): IEEE 1364-2005 5.5 signedness rules.
test('a signed operand of an unsigned comparison, shift or ?: is zero-extended (the expression type propagates to the operands)', () => {
  const r = out(vinit(`
    a = 42; b = 5'sd22 - 5'sd32; c = -4'sd1; s = 1;
    $display("%b %b", a <= b, a <= (s ? b : c));
    s8 = c >> 1; $display("%b", s8);
    s8 = s ? c : 4'd0; $display("%b", s8);
    s8 = c >>> 1; $display("%b", s8);`,
  `reg [5:0] a; reg signed [4:0] b; reg signed [3:0] c; reg s; reg [7:0] s8;`));
  // b = -10 (10110) and c = -1 (1111) become 6-bit 010110 = 22 and 001111 = 15 next to the unsigned a;
  // c >> 1 in an 8-bit context: 11111111 >> 1 (c alone is signed: sign-extended to the target width);
  // s ? c : 4'd0 is unsigned: 00001111; c >>> 1: c is signed, an arithmetic shift of 11111111
  assert.deepEqual(r, ['0 0', '01111111', '00001111', '11111111']);
});

test('nested context-determined operands take the sign of the whole expression: u + (s1 + s2) adds zero-extended s1, s2', () => {
  const r = out(vinit(`
    u = 42; s1 = 5'sd22 - 5'sd32; s2 = -4'sd1;
    y = u + (s1 + s2); $display("%0d", y);
    sy = s1 + s2; $display("%0d", sy);
    y = u + -s2; $display("%0d", y);
    y = u + ~s2; $display("%0d", y);`,
  `reg [5:0] u; reg signed [4:0] s1; reg signed [3:0] s2; reg [7:0] y; reg signed [7:0] sy;`));
  // u + (22 + 15) = 79 (not 42 + (-10) + (-1) = 31); all signed: -11; -s2 at 8 unsigned bits:
  // 0 - 00001111 = 241, + 42 = 283 -> 27; ~s2 at 8 bits: ~00001111 = 240, + 42 = 282 -> 26
  assert.deepEqual(r, ['79', '-11', '27', '26']);
});

test('?: with a signed and an unsigned operand of the same width is unsigned', () => {
  const r = out(vinit(`
    s = 1; y = s ? $signed(1'b1) : 1'b0; $display("%b", y);
    y = s ? $signed(1'b1) : 1'sb0; $display("%b", y);
    y = s ? 2'sb11 : 2'b00; $display("%b", y);`,
  `reg s; reg [4:0] y;`));
  assert.deepEqual(r, ['00001', '11111', '00011']);
});

test('case: the expression and the items are extended to the widest, as signed only when all are signed', () => {
  const r = out(vinit(`
    c = -4'sd1;
    case (c) 6'd15: $display("u15"); 6'sd63: $display("bad"); default: $display("none"); endcase
    case (c) -6'sd1: $display("s-1"); default: $display("none"); endcase
    n = 2'b00;
    case (n) 3'b100: $display("bad"); 3'b000: $display("zero"); default: $display("none"); endcase`,
  `reg signed [3:0] c; reg [1:0] n;`));
  // with an unsigned item, c is zero-extended (001111 = 15); with only signed items, sign-extended;
  // 3'b100 does not match a 2-bit 00 (the case expression is extended, the item not truncated)
  assert.deepEqual(r, ['u15', 's-1', 'zero']);
});
