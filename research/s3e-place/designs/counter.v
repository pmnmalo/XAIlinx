// 8-bit counter with enable and synchronous reset, and a comparator: carry chains, FDRE
module counter(input clk, input rst, input en, input [7:0] lim, output [7:0] q, output hit);
  reg [7:0] c = 0;
  always @(posedge clk) if (rst) c <= 0; else if (en) c <= c + 1;
  assign q = c;
  assign hit = c > lim;
endmodule
