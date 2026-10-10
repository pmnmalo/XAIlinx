// 32:1 and 8:1 multiplexers (MUXF5 .. MUXF8), one registered
module widemux(input clk, input [31:0] d, input [4:0] s, input [7:0] e, input [2:0] t, output y, output reg z);
  assign y = d[s];
  always @(posedge clk) z <= e[t];
endmodule
