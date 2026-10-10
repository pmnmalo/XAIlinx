// The I/O sites of the package's pins: pad name -> [tile, index of the I/O site in the tile (0-2)],
// so that an IOB's settings can be stored once per tile type (features IOB<index>:…).
//   node gen-pads.mjs dev-full.xdlrc > pads.json
import { loadGraph } from './xdlrc-graph.mjs';

const g = loadGraph(process.argv[2]);
const pads = {};
for (const t of g.tiles) {
  let i = 0;
  for (const s of t.sites) {
    if (!/^(IOB|IBUF|DIFF[MS]I?)$/.test(s.type)) continue;
    if (s.bonded === 'bonded') pads[s.name] = [t.name, i];
    i++;
  }
}
console.log(JSON.stringify({ pads }));
