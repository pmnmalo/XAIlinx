// The offline check's recording proxy (test/ui/harness.js startRecordingProxy): requests to other
// hosts are refused and recorded, and a connection the browser resets never crashes the test process
// (Chrome on macOS resets the ones it is refused: ECONNRESET as an uncaught exception, CI 72a07cf).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { startRecordingProxy } from './ui/harness.js';

const once = (em, ev) => new Promise((r) => em.once(ev, r));

test('recording proxy: other hosts refused and recorded; local ones pass; resets are harmless', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const local = http.createServer((req, res) => res.end('local ok'));
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const proxy = await startRecordingProxy();
  const port = +new URL(proxy.url).port;
  try {
    // a plain request to this computer goes through
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `http://127.0.0.1:${local.address().port}/x` }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(t)); }).on('error', reject);
    });
    assert.equal(body, 'local ok');
    // CONNECT to another host, reset by the client at once (as Chrome does)
    for (let k = 0; k < 5; k++) {
      const s = net.connect(port, '127.0.0.1');
      await once(s, 'connect');
      s.write('CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n');
      s.resetAndDestroy();
    }
    // a request to another host, reset in the middle
    const s2 = net.connect(port, '127.0.0.1');
    await once(s2, 'connect');
    s2.write('GET http://example.org/a HTTP/1.1\r\nHost: example.org\r\n\r\n');
    s2.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(uncaught, []);
    assert.ok(proxy.requests.includes('CONNECT example.org:443'), proxy.requests.join(', '));
    assert.ok(!proxy.requests.some((r) => r.includes('127.0.0.1')));
  } finally {
    process.off('uncaughtException', onUncaught);
    proxy.close(); local.close();
  }
});
