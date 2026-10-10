// flip-flop kinds: synchronous set / reset, asynchronous clear / preset, clock enable, falling edge
module ffs(input clk, input a, input b, input r, input ce, output reg q1, output reg q2, output reg q3, output reg q4, output reg q5);
  always @(posedge clk) if (r) q1 <= 1'b0; else if (ce) q1 <= a ^ b;
  always @(posedge clk) if (r) q2 <= 1'b1; else q2 <= a & b;
  always @(posedge clk or posedge r) if (r) q3 <= 1'b0; else q3 <= a | b;
  always @(posedge clk or posedge r) if (r) q4 <= 1'b1; else if (ce) q4 <= a;
  always @(negedge clk) q5 <= b;
endmodule
