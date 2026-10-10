// Shared helpers for the server / CLI tests: scratch environment, in-process app, fake tool binaries.
//
// Every fake is a small POSIX sh script written into a temporary bin directory that the tests put
// first on PATH. They emulate the outputs of the Xilinx ISE tools (from the fixture reports in
// test/fixtures/ise and test/fixtures/server), docker, ssh, the JTAG programmers and adepttool, so the
// whole implementation / programming flow runs without any real tool or hardware.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const FIX_ISE = path.join(HERE, 'fixtures', 'ise');
export const FIX_SERVER = path.join(HERE, 'fixtures', 'server');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * `skip` reason of the tests that run the fake tools (POSIX sh scripts started through their #!
 * line) or rely on POSIX signals: Windows runs neither. What they cover there is the same code.
 */
export const POSIX_ONLY = process.platform === 'win32' ? 'fake tools are POSIX shell scripts (and POSIX signals): not on Windows' : false;

/** A minimal but valid Xilinx .bit file. */
export function makeBit({ design = 'top.ncd;UserID=0xFFFFFFFF', part = '3s250ecp132', date = '2025/10/01', time = '10:11:20', data = Buffer.from([0xff, 0xff, 0xaa, 0x99]) } = {}) {
  const field = (k, s) => { const b = Buffer.from(s + '\0', 'latin1'); const h = Buffer.alloc(3); h[0] = k.charCodeAt(0); h.writeUInt16BE(b.length, 1); return Buffer.concat([h, b]); };
  const e = Buffer.alloc(5); e[0] = 'e'.charCodeAt(0); e.writeUInt32BE(data.length, 1);
  return Buffer.concat([
    Buffer.from([0x00, 0x09, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x00, 0x00, 0x01]),
    field('a', design), field('b', part), field('c', date), field('d', time), e, data,
  ]);
}

/** Scratch dirs + env: workspace, config dir and HOME all under one temp folder. */
export async function scratchEnv(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.SILINX_WORKSPACE = path.join(tmp, 'ws');
  process.env.SILINX_CONFIG_DIR = path.join(tmp, 'cfg');
  await fs.mkdir(process.env.SILINX_CONFIG_DIR, { recursive: true });
  return tmp;
}

export async function writeConfig(cfg) {
  await fs.mkdir(process.env.SILINX_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'), JSON.stringify(cfg));
}

// ------------------------------------------------------------------------------------------------
// In-process app
// ------------------------------------------------------------------------------------------------

export async function startApp(opts = {}) {
  const { createApp } = await import('../server/server.js');
  const app = await createApp(opts);
  let srv;
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', r); });
  const port = srv.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api`;
  /** JSON / text / zip request through fetch; returns { status, headers, body } (json parsed, else Buffer). */
  const call = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === 'string') { init.body = body; init.headers['content-type'] ||= 'text/plain'; }
      else if (body instanceof Uint8Array) { init.body = body; init.headers['content-type'] ||= 'application/zip'; }
      else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    }
    const r = await fetch(base + url, init);
    const type = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed = buf;
    if (type.includes('json')) parsed = JSON.parse(buf.toString('utf8'));
    else if (type.startsWith('text/') || type.includes('xml')) parsed = buf.toString('utf8');
    return { status: r.status, headers: r.headers, body: parsed };
  };
  /** Raw http request with full header control (Host, Origin). */
  const raw = (method, url, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method, path: url, headers, setHost: !('host' in headers) }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let b = d;
        try { b = JSON.parse(d); } catch { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, body: b });
      });
    });
    rq.on('error', reject);
    if (body !== undefined) rq.write(body);
    rq.end();
  });
  const close = async () => {
    srv.closeAllConnections?.();
    await new Promise(r => srv.close(r));
  };
  return { app, srv, port, origin, base, call, raw, close };
}

/** Poll a job (through the jobs module) until it is no longer running. */
export async function waitJob(jobs, id, { timeoutMs = 10000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.getJob(id);
    if (!j) throw new Error(`job ${id} vanished`);
    if (j.status !== 'running') return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still running after ${timeoutMs} ms:\n${j.lines.join('\n')}`);
    await sleep(10);
  }
}

/** Wait until a job log line matches `re`. */
export async function waitLine(jobs, id, re, { timeoutMs = 10000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.getJob(id);
    if (j.lines.some(l => re.test(l))) return j;
    if (j.status !== 'running') throw new Error(`job ended (${j.status}) before ${re}:\n${j.lines.join('\n')}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`no ${re} after ${timeoutMs} ms:\n${j.lines.join('\n')}`);
    await sleep(10);
  }
}

// ------------------------------------------------------------------------------------------------
// Fake binaries
// ------------------------------------------------------------------------------------------------

// Xilinx ISE command-line tools. Env: FAKE_ISE_FIXTURES (report dir), FAKE_ISE_FAIL (tool that fails),
// FAKE_ISE_SLEEP (tool that hangs, for cancel tests), FAKE_ISE_LOG (file receiving each command line).
const FAKE_ISE = `#!/bin/sh
tool=$(basename "$0")
F="$FAKE_ISE_FIXTURES"
[ -n "$FAKE_ISE_LOG" ] && echo "$tool $*" >> "$FAKE_ISE_LOG"
echo "Release 14.7 - $tool P.20131013 (fake)"
if [ "$tool" = "$FAKE_ISE_SLEEP" ]; then echo "fake $tool waiting"; sleep 30; fi
if [ "$tool" = "$FAKE_ISE_FAIL" ]; then echo "ERROR:$tool - fake failure" >&2; exit 2; fi
for a in "$@"; do last="$a"; done
case "$tool" in
  xst) cp "$F/top.syr" top.syr; : > top.ngc ;;
  ngdbuild) : > top.ngd ;;
  map) cp "$F/top_map.mrp" top_map.mrp; : > top_map.ncd; : > top.pcf ;;
  par) cp "$F/top.par" top.par; : > top.ncd ;;
  trce) cp "$F/top.twr" top.twr ;;
  bitgen) case "$last" in *.bit) out="$last" ;; *) out=top.bit ;; esac; cp "$F/top.bit" "$out" ;;
  netgen) mkdir -p "$(dirname "$last")"; echo "-- fake netgen model" > "$last" ;;
  pin2ucf) echo 'NET "clk" LOC = "B8" ;' > "$last" ;;
  xpwr) cp "$F/top.pwr" top.pwr ;;
  partgen)
    printf 'version 7\\npin IO_L01P_0 P1 0 N.A. IO_L01P_0\\npin IO_L01N_0 P2 0 N.A. IO_L01N_0\\npin IP_0 P3 0 N.A. IP_GCLK0\\npin IO_1 P4 1 N.A. IO_1\\npin IO_2 P5 1 N.A. IO_2\\npin IO_3 P6 1 N.A. IO_3\\npin IO_4 P7 1 N.A. IO_4\\n' > fake.pkg ;;
esac
echo "$tool done"
exit 0
`;

// docker: "image inspect" (FAKE_DOCKER_NO_IMAGE makes it fail) and "run ... -v <dir>:/work ... <image> cmd...",
// which runs cmd in <dir> on this machine (so the fake ISE tools above do the work).
const FAKE_DOCKER = `#!/bin/sh
[ -n "$FAKE_DOCKER_LOG" ] && echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = image ]; then
  if [ -n "$FAKE_DOCKER_NO_IMAGE" ]; then echo "Error: No such image" >&2; exit 1; fi
  echo "sha256:0123456789abcdef"; exit 0
fi
[ "$1" = run ] || { echo "fake docker: unsupported command $1" >&2; exit 125; }
shift
dir=
while [ $# -gt 0 ]; do
  case "$1" in
    --rm) shift ;;
    -v) dir="\${2%:/work}"; shift 2 ;;
    --platform|-w|-e|--user) shift 2 ;;
    *) shift; break ;;
  esac
done
cd "$dir" || exit 125
exec "$@"
`;

// ssh: runs the remote command locally under $FAKE_SSH_HOME (the "remote home").
const FAKE_SSH = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o|-p|-i) shift 2 ;;
    *) shift ;;
  esac
done
target="$1"; shift
[ -n "$FAKE_SSH_LOG" ] && echo "$target $*" >> "$FAKE_SSH_LOG"
[ -n "$FAKE_SSH_FAIL" ] && { echo "ssh: connect to host $target: Connection refused" >&2; exit 255; }
mkdir -p "$FAKE_SSH_HOME" && cd "$FAKE_SSH_HOME" || exit 255
exec sh -c "$1"
`;

// JTAG programmers. FAKE_PROG_FAIL=<tool> -> exit 1 ; FAKE_IMPACT_MODE=silent|error ; FAKE_PROG_LOG.
const FAKE_PROG = `#!/bin/sh
tool=$(basename "$0")
[ -n "$FAKE_PROG_LOG" ] && echo "$tool $*" >> "$FAKE_PROG_LOG"
if [ "$tool" = "$FAKE_PROG_FAIL" ]; then echo "fake $tool: no cable found" >&2; exit 1; fi
for a in "$@"; do last="$a"; done
case "$tool" in
  openFPGALoader)
    case "$*" in
      *--Version*) echo "openFPGALoader v0.12.1"; exit 0 ;;
      *--detect*) echo "index 0:"; echo "	idcode 0x41c22093"; echo "	manufacturer xilinx"; echo "	family spartan3e"; echo "	model  xc3s500e"; exit 0 ;;
    esac
    echo "Load SRAM: [==================================================] 100.00%"; echo "Done" ;;
  xc3sprog)
    if [ "$1" = -h ]; then echo "XC3SPROG (c) 2004-2011 xc3sprog project \\$Rev: 795 \\$ OS: Linux"; exit 1; fi
    if [ "$last" = -j ]; then
      echo "JTAG loc.:   0  IDCODE: 0x41c22093  Desc:                      XC3S500E Rev: E  IR length:  6"
      echo "JTAG loc.:   1  IDCODE: 0xf5046093  Desc:                        XCF04S Rev: F  IR length:  8"
    else echo "Programming: done"; fi ;;
  djtgcfg)
    case "$1" in
      --version) echo "djtgcfg v2.4.3" ;;
      enum) echo "Found 1 device(s)"; echo ""; echo "Device: Nexys2"; echo "    Product Name:   Nexys2 - 500" ;;
      init) echo "Initializing scan chain..."; echo "Found 2 device(s):"; echo ""; echo "Device 0: XC3S500E"; echo "Device 1: XCF04S" ;;
      prog) echo "Programming device. Do not touch your board. This may take a few minutes..."; echo "Programming succeeded." ;;
    esac ;;
  impact)
    echo "Release 14.7 - iMPACT P.20131013 (fake)"
    if grep -q '^Program' "$last" 2>/dev/null; then
      case "$FAKE_IMPACT_MODE" in
        silent) echo "INFO:iMPACT - nothing happened" ;;
        error) echo "ERROR:iMPACT:583 - '1': The idcode read from the device does not match"; echo "INFO:iMPACT - '1': Programmed successfully." ;;
        *) echo "INFO:iMPACT - '1': Programmed successfully." ;;
      esac
    else
      echo "INFO:iMPACT:1777 - Reading /opt/Xilinx/14.7/ISE_DS/ISE/spartan3e/data/xc3s500e.bsd..."
      echo "'1': : Manufacturer's ID = Xilinx xc3s500e, Version : 1"
    fi ;;
esac
exit 0
`;

// Python of the adepttool virtualenv: list.py, basys2_prog.py and scripts/xcf_prog.py.
// FAKE_ADEPT_NODONE: configuration never reaches DONE ; FAKE_XCF_NOVERIFY: no "verify OK" ; FAKE_ADEPT_FAIL: exit 3.
const FAKE_PYTHON = `#!/bin/sh
script=$(basename "$1"); shift
[ -n "$FAKE_PROG_LOG" ] && echo "python $script $*" >> "$FAKE_PROG_LOG"
[ -n "$FAKE_ADEPT_FAIL" ] && { echo "usb.core.USBError: [Errno 19] No such device" >&2; exit 3; }
case "$script" in
  list.py) echo "Device 0: Basys2 (serial 1234)"; echo "JTAG IDCODE 11c1a093 [XC3S250E]"; echo "JTAG IDCODE f5045093 [XCF02S]" ;;
  basys2_prog.py)
    echo "Configuring FPGA..."
    if [ -n "$FAKE_ADEPT_NODONE" ]; then echo "STATUS: INIT_B=0 (configuration not finished)"; else echo "STATUS: INIT_B=1 DONE"; fi ;;
  xcf_prog.py)
    op="$3"
    echo "xcf_prog $op"
    case "$op" in
      program|verify) [ -z "$FAKE_XCF_NOVERIFY" ] && echo "verify OK" ;;
      read) printf 'PROMDATA' > "$4"; echo "read 8 bytes" ;;
      erase) echo "erased" ;;
    esac
    case " $* " in *" --reconfigure "*) [ -z "$FAKE_ADEPT_NODONE" ] && echo "STATUS: DONE" ;; esac
    [ "$op" = reconfigure ] && [ -z "$FAKE_ADEPT_NODONE" ] && echo "STATUS: DONE"
    ;;
esac
exit 0
`;

// browser openers (openBrowser): record the URL.
const FAKE_OPEN = `#!/bin/sh
[ -n "$FAKE_OPEN_LOG" ] && echo "$(basename "$0") $*" >> "$FAKE_OPEN_LOG"
exit 0
`;

export const ISE_FAKES = ['xst', 'ngdbuild', 'map', 'par', 'trce', 'bitgen', 'netgen', 'pin2ucf', 'xpwr', 'partgen'];
export const PROG_FAKES = ['openFPGALoader', 'xc3sprog', 'djtgcfg', 'impact'];

async function script(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

/**
 * Write the fake tools under `<tmp>/fakes`:
 *   ise/      the ISE command-line tools          prog/   JTAG programmers
 *   docker/   docker                               ssh/    ssh
 *   open/     open + xdg-open                      adept/  adepttool tree (src/*.py + venv/bin/python)
 *   fix/      report fixtures (+ top.bit, top.pwr)
 * Returns the directory map; callers decide which ones go on PATH.
 */
export async function makeFakes(tmp) {
  const root = path.join(tmp, 'fakes');
  const d = {
    root, ise: path.join(root, 'ise'), prog: path.join(root, 'prog'), docker: path.join(root, 'docker'),
    ssh: path.join(root, 'ssh'), open: path.join(root, 'open'), adept: path.join(root, 'adept'), fix: path.join(root, 'fix'),
  };
  for (const t of ISE_FAKES) await script(path.join(d.ise, t), FAKE_ISE);
  for (const t of PROG_FAKES) await script(path.join(d.prog, t), FAKE_PROG);
  await script(path.join(d.docker, 'docker'), FAKE_DOCKER);
  await script(path.join(d.ssh, 'ssh'), FAKE_SSH);
  for (const t of ['open', 'xdg-open']) await script(path.join(d.open, t), FAKE_OPEN);
  await script(path.join(d.adept, 'venv', 'bin', 'python'), FAKE_PYTHON);
  for (const s of ['basys2_prog.py', 'list.py']) await script(path.join(d.adept, 'src', s), '# fake\n');
  await fs.mkdir(d.fix, { recursive: true });
  for (const f of await fs.readdir(FIX_ISE)) await fs.copyFile(path.join(FIX_ISE, f), path.join(d.fix, f));
  await fs.copyFile(path.join(FIX_SERVER, 'top.pwr'), path.join(d.fix, 'top.pwr'));
  await fs.writeFile(path.join(d.fix, 'top.bit'), makeBit());
  return d;
}

/** PATH with the given directories first, then only the system directories (no user-installed tools). */
export function isolatedPath(...dirs) {
  const sys = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...dirs, ...sys].join(path.delimiter);
}
