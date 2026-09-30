// Checks a built package: node scripts/check.mjs <firefox|chrome> [dir]   (default dir: dist/<platform>)
//
// Both: every file the manifest, the service worker and the HTML pages reference exists,
// every __MSG_key__ is translated in every locale, the platform layer is loaded.
// Chrome: no Firefox-only keys, PNG icons, a service worker, at most 4 suggested shortcuts.
// Firefox: an add-on id and the background scripts. (`npx web-ext lint` checks the rest.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function check(dir, platform) {
  const problems = [];
  const clean = (rel) => rel.replace(/^\//, '').split(/[?#]/)[0];
  const exists = (rel) => fs.existsSync(path.join(dir, clean(rel)));
  const need = (rel, what) => { if (!exists(rel)) problems.push(`${what}: missing file ${rel}`); };

  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { return [`manifest.json: ${e.message}`]; }

  if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!/^\d+(\.\d+){0,3}$/.test(m.version || '')) problems.push(`version "${m.version}" is not dotted numbers`);
  need('platform.js', 'platform layer');

  // background: scripts (Firefox) or a service worker and what it imports (Chrome)
  const bg = m.background || {};
  const bgScripts = [...(bg.scripts || [])];
  if (bg.service_worker) {
    need(bg.service_worker, 'background.service_worker');
    if (exists(bg.service_worker)) {
      const src = fs.readFileSync(path.join(dir, clean(bg.service_worker)), 'utf8');
      for (const [, list] of src.matchAll(/importScripts\(([^)]*)\)/g)) for (const [, f] of list.matchAll(/['"]([^'"]+)['"]/g)) bgScripts.push(f);
    }
  }
  for (const f of bgScripts) need(f, 'background');
  const order = bgScripts.map(clean);
  if (order.indexOf('platform.js') < 0 || order.indexOf('platform.js') > order.indexOf('background.js')) problems.push('background must load platform.js before background.js');

  const icons = [...Object.values(m.icons || {}), ...Object.values((m.action && m.action.default_icon && typeof m.action.default_icon === 'object') ? m.action.default_icon : {})];
  if (m.action && typeof m.action.default_icon === 'string') icons.push(m.action.default_icon);
  for (const i of icons) need(i, 'icon');

  const pages = [m.action && m.action.default_popup, m.sidebar_action && m.sidebar_action.default_panel, m.side_panel && m.side_panel.default_path].filter(Boolean);
  for (const p of pages) need(p, 'page');
  for (const cs of m.content_scripts || []) for (const f of [...(cs.js || []), ...(cs.css || [])]) need(f, 'content_scripts');

  // files referenced from every HTML page in the package (also pages the manifest doesn't name, e.g. offscreen.html)
  const htmlFiles = (function walk(d, base = '') {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), base + e.name + '/') : e.name.endsWith('.html') ? [base + e.name] : []);
  })(dir);
  for (const page of new Set([...pages.map(clean), ...htmlFiles])) {
    if (!exists(page)) continue;
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) need(path.posix.join(path.posix.dirname(page), ref), page);
  }

  // every __MSG_key__ in every locale
  const keys = [...JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)].map((x) => x[1]);
  const locDir = path.join(dir, '_locales');
  if (!m.default_locale || !fs.existsSync(path.join(locDir, m.default_locale, 'messages.json'))) problems.push('default_locale messages.json missing');
  if (fs.existsSync(locDir)) {
    for (const loc of fs.readdirSync(locDir)) {
      let msgs;
      try { msgs = JSON.parse(fs.readFileSync(path.join(locDir, loc, 'messages.json'), 'utf8')); } catch (e) { problems.push(`_locales/${loc}: ${e.message}`); continue; }
      for (const k of keys) if (!msgs[k]) problems.push(`_locales/${loc}: no "${k}"`);
    }
  }

  if (platform === 'chrome') {
    for (const k of ['browser_specific_settings', 'sidebar_action', 'author']) if (k in m) problems.push(`Firefox-only key "${k}" in the Chrome manifest`);
    if (bg.scripts) problems.push('background.scripts is Firefox-only — use service_worker');
    if (!bg.service_worker) problems.push('background.service_worker missing');
    if (m.action && m.action.default_area) problems.push('action.default_area is Firefox-only');
    for (const i of icons) if (!/\.png$/i.test(i)) problems.push(`icon ${i}: Chrome needs PNG`);
    if (m.commands && Object.values(m.commands).filter((c) => c.suggested_key).length > 4) problems.push('Chrome allows at most 4 commands with suggested keys');
  }
  if (platform === 'firefox') {
    const g = m.browser_specific_settings && m.browser_specific_settings.gecko;
    if (!g || !g.id) problems.push('browser_specific_settings.gecko.id missing');
    if (!bg.scripts) problems.push('background.scripts missing');
  }
  return problems;
}

// run directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const platform = process.argv[2];
  if (!['firefox', 'chrome'].includes(platform)) { console.error('usage: node scripts/check.mjs <firefox|chrome> [dir]'); process.exit(1); }
  const dir = path.resolve(process.argv[3] || path.join(root, 'dist', platform));
  const problems = check(dir, platform);
  if (problems.length) { console.error('Problems:\n  - ' + problems.join('\n  - ')); process.exit(1); }
  console.log(`OK: ${path.relative(root, dir) || dir}`);
}
