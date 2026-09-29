// Build the browser packages from the shared core (src/) and one platform folder (platform/<target>/).
//
//   node scripts/build.mjs              → all targets
//   node scripts/build.mjs firefox      → dist/firefox/ + web-ext-artifacts/audio_extender-firefox-<version>.zip
//   node scripts/build.mjs chrome       → dist/chrome/  + web-ext-artifacts/audio_extender-chrome-<version>.zip  (Chrome and Edge)
//   node scripts/build.mjs preview      → dist/preview/ — the popup as a plain page with demo data (design preview, tests)
//
// Rules:
//   - src/ is copied as is; platform/<target>/ is copied on top of it.
//   - A platform file may not have the same path as a core file: shared code is never copied or overridden.
//   - Each platform has its own version in its manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ARTIFACTS = path.join(ROOT, 'web-ext-artifacts');

const TARGETS = {
  firefox: { platform: 'firefox', zip: true },
  chrome: { platform: 'chrome', zip: true },
  // the design preview runs the Firefox build's popup as a plain page, plus the demo data
  preview: { platform: 'firefox', zip: false, preview: true },
};
const PREVIEW_ONLY = ['popup/preview.js']; // core files that never go into store packages

const skip = (name) => name.endsWith('.bkp') || name === '.DS_Store' || name === 'Thumbs.db';

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !skip(e.name)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  }).sort();
}

function copyFiles(fromDir, files, toDir) {
  for (const f of files) {
    const dst = path.join(toDir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(fromDir, f), dst);
  }
}

/* Minimal ZIP writer (deflate) — no external tools needed. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(dir, files) {
  const parts = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date → identical input gives an identical zip
  for (const name of files) {
    const data = fs.readFileSync(path.join(dir, name));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(DOS_TIME, 12); head.writeUInt16LE(DOS_DATE, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, packed);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

function build(name) {
  const t = TARGETS[name];
  const platformDir = path.join(ROOT, 'platform', t.platform);
  const out = path.join(ROOT, 'dist', name);

  const core = listFiles(SRC).filter((f) => t.preview || !PREVIEW_ONLY.includes(f));
  const own = listFiles(platformDir);
  const clash = own.filter((f) => core.includes(f) || PREVIEW_ONLY.includes(f));
  if (clash.length) throw new Error(`platform/${t.platform} must not override core files: ${clash.join(', ')}`);

  fs.rmSync(out, { recursive: true, force: true });
  copyFiles(SRC, core, out);
  copyFiles(platformDir, own, out);

  if (t.preview) {
    // load the demo data right after the real API (which stays inactive outside the extension)
    const html = path.join(out, 'popup', 'popup.html');
    const src = fs.readFileSync(html, 'utf8');
    const tag = '<script src="api.js"></script>';
    if (!src.includes(tag)) throw new Error('preview: api.js script tag not found in popup.html');
    fs.writeFileSync(html, src.replace(tag, tag + '\n<script src="preview.js"></script>'));
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const problems = check(out, t.platform);
  if (problems.length) throw new Error(`${name} package check failed:\n  - ${problems.join('\n  - ')}`);

  const files = listFiles(out);
  let line = `${name.padEnd(8)} ${manifest.version}  ${files.length} files → ${path.relative(ROOT, out)}`;
  if (t.zip) {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const zipPath = path.join(ARTIFACTS, `audio_extender-${name}-${manifest.version}.zip`);
    fs.writeFileSync(zipPath, zip(out, files));
    line += `  +  ${path.relative(ROOT, zipPath)} (${Math.round(fs.statSync(zipPath).size / 1024)} KB)`;
  }
  console.log(line);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(TARGETS);
for (const n of names) if (!TARGETS[n]) { console.error(`unknown target "${n}" — use: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }
try {
  for (const n of names) build(n);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
