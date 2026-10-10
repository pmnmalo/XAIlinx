// Cell types of Yosys JSON netlists: node count.cjs a.json b.json
for (const f of process.argv.slice(2)) {
  const j = require(require('path').resolve(f));
  for (const [n, m] of Object.entries(j.modules)) {
    if (m.attributes?.blackbox) continue;
    const c = {};
    for (const x of Object.values(m.cells)) c[x.type] = (c[x.type] || 0) + 1;
    console.log(f, n, JSON.stringify(c));
  }
}
