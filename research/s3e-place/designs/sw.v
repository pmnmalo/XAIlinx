// switch -> LED, and a constant output
module sw(input sw, output led, output one);
  assign led = sw;
  assign one = 1'b1;
endmodule
