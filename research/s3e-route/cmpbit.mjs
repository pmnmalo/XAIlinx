// Compare the configuration frames of two bitstreams (headers and CRC ignored).
//   node research/s3e-route/cmpbit.mjs a.bit b.bit
import { readBit, diffBits } from '../s3e-bitstream/bits.mjs';

const [a, b] = process.argv.slice(2);
const A = readBit(a), B = readBit(b);
const d = diffBits(A.fdri, B.fdri, A.flr + 1);
console.log(`${a} vs ${b}: ${d.length} frame bits differ`);
for (const x of d.slice(0, 20)) console.log('  ' + JSON.stringify(x));
