// 64:1 multiplexer with a registered output (MUXF5 .. MUXF8 trees)
module mux64(input clk, input [63:0] d, input [5:0] s, output reg y);
  always @(posedge clk) y <= d[s];
endmodule
