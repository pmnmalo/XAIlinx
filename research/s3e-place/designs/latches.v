// latches: gate with enable and asynchronous clear, active-low gate with preset, registered copy
module latches(input clk, input g, input ge, input clr, input pre, input g2, input [1:0] d, output reg [1:0] q1, output reg q2, output reg r);
  always @* if (clr) q1 = 2'b00; else if (g && ge) q1 = d;
  always @* if (pre) q2 = 1'b1; else if (!g2) q2 = d[0] ^ d[1];
  always @(posedge clk) r <= q1[0] & q2;
endmodule
