// Checks that the repository holds no data that must not be published: personal data (e-mail
// addresses, home folders with a user name, logins such as user@host), computer names and IP
// addresses of a network, passwords, keys and access tokens, and Xilinx files (ISE's binary outputs,
// licences, device reports). Run by test/private-data.test.js on every tracked file.
//
//   node scripts/check-private-data.mjs              the tracked files
//   node scripts/check-private-data.mjs --history    also every line added in the git history and
//                                                    every commit message
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Known, harmless matches: [file (or a RegExp of files), the matched text (or a RegExp), why]
export const ALLOW = [
  [/^(THIRD-PARTY-NOTICES\.md|scripts\/licences\/[^/]+\.txt)$/, /@/, 'the licence texts of the third-party packages name their authors'],
  [/./, /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|255\.255\.255\.255)$/, 'loopback / any address / broadcast'],
  [/./, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/, 'documentation addresses (RFC 5737)'],
  [/./, /@(example\.(com|org|net)|[\w.-]+\.(example|test|invalid))$/, 'example domains (RFC 2606)'],
  [/./, /^(noreply@anthropic\.com|[\w.+-]+@users\.noreply\.github\.com)$/, 'no-reply addresses (the Co-Authored-By line of commits)'],
  ['test/corpus/vloghammer-gen.mjs', 'claire@yosyshq.com', 'the copyright notice of VlogHammer (ISC licence), which a port must keep'],
  ['test/lang-vhdl-types.test.js', '6.4.2.3', 'a section of the VHDL standard'],
  ['test/server-api.test.js', 'fpga-lab.local', 'a made-up computer name for the Host header test'],
  ['test/impl.test.js', /^(dev@)?10\.0\.0\.2$/, 'a made-up address of an example (in the history only)'],
  // ISE's text reports and simulation models of our own test designs (no personal data in them):
  // the fixtures of the report parsers and of the netgen simulation
  [/^test\/fixtures\/(ise|netgen)\//, 'Xilinx file', 'ISE reports / netgen models of test designs, kept as parser fixtures'],
];

// the rules themselves and their tests hold examples of what they look for
export const SELF = ['scripts/check-private-data.mjs', 'test/private-data.test.js'];

const allowed = (file, text) => ALLOW.some(([f, t]) =>
  (typeof f === 'string' ? f === file : f.test(file)) && (typeof t === 'string' ? t === text : t.test(text)));

// placeholders that may follow /Users/, /home/ or C:\Users\ in documentation
const PLACEHOLDER_USERS = /^(<[^>]+>|\$\w+|\$\{\w+\}|%\w+%|you|me|user|username|name|runner|USER|USERNAME|\.\.\.|…)$/;

/** Private / link-local IPv4 ranges (a home or office network). */
const isNetworkIp = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); };

/** The rules: { kind, re, check?(match) -> the text to report or null }. */
export const RULES = [
  { kind: 'e-mail address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  // an IPv4 address (not part of a longer dotted number such as a version)
  { kind: 'IP address', re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.]*\d)/g },
  { kind: 'login (user@address)', re: /\b[A-Za-z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: 'computer name', re: /(?:\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\.local\b|(?:@|:\/\/)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal|home\.arpa)\b)/g,
    check: (m) => m[0].replace(/^(@|:\/\/)/, '') },
  { kind: 'home folder with a user name', re: /(?:\/Users\/|\/home\/|[A-Za-z]:\\+(?:Users|Documents and Settings)\\+)([^/\\\s"'`)<>]+)/g,
    check: (m) => (PLACEHOLDER_USERS.test(m[1]) || /^Shared$/i.test(m[1]) ? null : m[0]) },
  { kind: 'credentials in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s@'"]+@[^\s'"]+/gi },
  { kind: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----/g },
  { kind: 'access token', re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/g },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // a password / secret written as a value (not a placeholder, an empty value or code)
  { kind: 'password or secret', re: /\b(?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{4,})["']/gi,
    check: (m) => (/^(<[^>]+>|\*+|x+|\.\.\.|…|changeme|password|secret|your[_-]?\w*|example\w*|test\w*|dummy\w*|fake\w*|\$\{?\w+\}?)$/i.test(m[1]) ? null : m[0]) },
];

// files that must never be in the repository: ISE's binary outputs and licences, keys, environments
const FORBIDDEN_FILES = [
  [/\.(bit|ncd|ngd|ngc|ngm|ncd|bld|pcf|mcs|prm|ace|svf|jed|isc)$/i, 'Xilinx binary / programming file'],
  [/(^|\/)Xilinx\.lic$|\.lic$/i, 'licence file'],
  [/(^|\/)(id_rsa|id_ecdsa|id_ed25519|id_dsa)(\.pub)?$|\.(pem|key|p12|pfx|keychain|kdbx)$/i, 'key or keychain'],
  [/(^|\/)\.env(\.|$)|(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.pgpass$|(^|\/)credentials(\.json)?$/i, 'environment / credentials file'],
];
// text files written by ISE: they start with ISE's banner; only the allowed fixtures may
const ISE_BANNER = /Copyright \(c\) 1995-20\d\d Xilinx, Inc\.\s+All rights reserved|^XDL REPORT MODE|^# XDL REPORT MODE/m;

/** The problems of one file: [{ file, line, kind, text }]. `whole`: text is the whole file (not a line
 *  of a diff), so that a file written by ISE can be recognized by its banner. */
export function scanText(file, text, { whole = true } = {}) {
  const out = [];
  for (const [re, kind] of FORBIDDEN_FILES) if (re.test(file)) { out.push({ file, line: 0, kind, text: path.basename(file) }); break; }
  if (whole && /\.(xdlrc|xdl|syr|srp|par|twr|mrp|map|vhd|v)$/i.test(file) && ISE_BANNER.test(text.slice(0, 4000))
      && !/hand-made|made-up/i.test(text.slice(0, 600)) && !allowed(file, 'Xilinx file')) {
    out.push({ file, line: 1, kind: 'file written by Xilinx ISE', text: text.slice(0, 80).split('\n')[0] });
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 20000) continue;   // minified / data lines
    for (const r of RULES) {
      for (const m of line.matchAll(r.re)) {
        const t = r.check ? r.check(m) : m[0];
        if (!t) continue;
        if (r.kind === 'IP address' && !isNetworkIp(t) && allowed(file, t)) continue;
        if (allowed(file, t)) continue;
        out.push({ file, line: i + 1, kind: r.kind, text: t });
      }
    }
  }
  return out;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Every tracked file of the repository (git ls-files). */
export function scanRepo(root = ROOT) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    if (SELF.includes(f)) continue;
    const p = path.join(root, f);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    const buf = fs.readFileSync(p);
    out.push(...scanText(f, isBinary(buf) ? '' : buf.toString('utf8')));
  }
  return out;
}

/** Every line added in the history and every commit message (all branches). */
export function scanHistory(root = ROOT) {
  const out = [];
  const log = execFileSync('git', ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=@@COMMIT %H%n%B@@END'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
  let commit = '', file = '', msg = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@COMMIT ')) { commit = line.slice(9, 16); msg = []; continue; }
    if (msg) { if (line === '@@END') { out.push(...scanText(`(message of ${commit})`, msg.join('\n')).map((x) => ({ ...x, commit }))); msg = null; } else msg.push(line); continue; }
    if (line.startsWith('+++ b/')) { file = SELF.includes(line.slice(6)) ? null : line.slice(6); if (!file) continue; out.push(...scanText(file, '', { whole: false }).filter((x) => x.line === 0).map((x) => ({ ...x, commit }))); continue; }
    if (file && line.startsWith('+') && !line.startsWith('+++')) out.push(...scanText(file, line.slice(1), { whole: false }).filter((x) => x.line).map((x) => ({ ...x, commit })));
  }
  // one report per finding
  const seen = new Set();
  return out.filter((x) => { const k = `${x.file}|${x.kind}|${x.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const found = [...scanRepo(), ...(process.argv.includes('--history') ? scanHistory() : [])];
  for (const x of found) console.log(`${x.commit ? `${x.commit} ` : ''}${x.file}${x.line ? `:${x.line}` : ''}: ${x.kind}: ${x.text}`);
  console.log(found.length ? `${found.length} problem(s)` : 'no private data found');
  process.exit(found.length ? 1 : 0);
}
