/* =========================================================
   Audio Extender — background script (MV3 event page)
   - tells content scripts which site (top-level tab) they belong to
   - toolbar badge with the current gain
   - keyboard shortcuts
   - sidebar mode
   - "lower other tabs while audio plays here"
   - install / update: settings migration, injection into open tabs

   The event page is unloaded when idle and started again by events,
   so every handler waits for `ready` and nothing lives only in memory.
   ========================================================= */
'use strict';

const DUCK_FACTOR = 0.3;
const GAIN_STEP = 10;
const SCRIPTS_MAIN = ['content/chain.js', 'content/page.js'];
const SCRIPTS_ISOLATED = ['shared/settings.js', 'content/speed.js', 'content/content.js'];

let data = AE.normalize({});
let ready = loadData();

async function loadData() {
  data = AE.normalize(await browser.storage.local.get(AE.KEYS));
  return data;
}

/* ---------- content scripts in already open tabs ---------- */
async function injectTab(tabId) {
  try {
    const target = { tabId, allFrames: true };
    await browser.scripting.executeScript({ target, files: SCRIPTS_MAIN, world: 'MAIN', injectImmediately: true });
    await browser.scripting.executeScript({ target, files: SCRIPTS_ISOLATED, injectImmediately: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function injectAll() {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  await Promise.all(tabs.filter((t) => !t.discarded).map((t) => injectTab(t.id)));
}

/* ---------- messages ---------- */
function handleMessage(msg, sender) {
  if (!msg) return undefined;
  if (msg.type === 'hello') {
    const tabId = sender.tab && sender.tab.id;
    // bypass: the platform processes this tab's whole output itself (Chrome deep mode)
    const cap = PLATFORM.capture;
    const host = sender.tab ? AE.hostOf(sender.tab.url) : null;
    return Promise.all([getDuck(tabId), cap && tabId !== undefined ? cap.isOn(tabId) : false, getTabGain(tabId, host)])
      .then(([duck, bypass, tabGain]) => ({ host, duck, bypass, tabGain }));
  }
  // Popup edits are persisted here so they survive the popup closing mid-save.
  if (msg.type === 'persist' && msg.patch) {
    const patch = {};
    for (const k of AE.KEYS) if (k in msg.patch) patch[k] = msg.patch[k];
    return browser.storage.local.set(patch);
  }
  if (msg.type === 'inject' && typeof msg.tabId === 'number') return injectTab(msg.tabId);
  if (msg.type === 'tab-gain' && typeof msg.tabId === 'number') return setTabGain(msg.tabId, msg.gain);
  if (msg.type === 'sync-state') return syncState();
  if (msg.type === 'sync-set') return setSync(!!msg.on, msg.mode);
  return undefined;
}
// sendResponse + `return true` instead of returning a Promise: works the same in Firefox and Chrome.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = handleMessage(msg, sender);
  if (!reply) return false;
  reply.then((value) => sendResponse(value), () => sendResponse(undefined));
  return true;
});

/* ---------- badge ---------- */
async function updateBadge(tab) {
  if (!tab || tab.id === undefined) return;
  await ready;
  const host = AE.hostOf(tab.url);
  let text = '';
  if (data.app.badge && host && AE.siteAllowed(data.app, host)) {
    const s = AE.withTabGain(AE.effective(data, host), await getTabGain(tab.id, host), data.app);
    if (s.enabled && s.gain !== 100) text = String(s.gain);
    else if (!s.enabled) text = 'off';
  }
  try {
    await browser.action.setBadgeText({ tabId: tab.id, text });
  } catch { /* tab closed */ }
}

async function updateAllBadges() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map(updateBadge));
}

browser.action.setBadgeBackgroundColor({ color: '#7c3aed' });
if (browser.action.setBadgeTextColor) browser.action.setBadgeTextColor({ color: '#ffffff' });

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // the tab's own volume belongs to the site it was set on
  if (info.url && (await getTabGains())[tabId] && (await getTabGain(tabId, AE.hostOf(info.url))) === null) await setTabGain(tabId, null);
  if (info.url || info.status === 'complete') updateBadge(tab);
  if ('audible' in info) updateDucking();
});
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  updateBadge(await browser.tabs.get(tabId));
  updateDucking();
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  await setDuck(tabId, undefined);
  if ((await getTabGains())[tabId]) await setTabGain(tabId, null, true);
  updateDucking();
});
// Firefox for Android has no windows API; a throw here would skip every listener below.
if (browser.windows) browser.windows.onFocusChanged.addListener(() => updateDucking());

/* ---------- sidebar mode ---------- */
// How the toolbar button opens the sidebar differs per browser (platform layer);
// where there is no sidebar the popup always stays enabled.
async function applySidebarMode() {
  await ready;
  await PLATFORM.sidebar.apply(!!data.app.sidebar);
}
browser.action.onClicked.addListener(() => PLATFORM.sidebar.onActionClicked());

/* ---------- keyboard shortcuts ---------- */
async function editActiveSite(fn) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab && AE.hostOf(tab.url);
  if (!host) return;
  await (ready = loadData());
  const s = AE.effective(data, host);
  fn(s);
  await browser.storage.local.set(AE.storeFor(data, host, s));
}

// Speed shortcuts have no default keys (the user assigns them); the step is the speed keys' step.
function speedBy(s, dir) {
  const step = AE.SPEED_STEPS.includes(data.app && data.app.speedStep) ? data.app.speedStep : 0.1;
  const v = Math.round((s.fx.speed.value + dir * step) * 100) / 100;
  s.fx.speed.value = Math.min(AE.SPEED_MAX, Math.max(AE.SPEED_MIN, v));
}

/** Volume shortcuts change what is heard in the tab: its own volume when the Mixer gave it one. */
async function stepGain(dir) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab && AE.hostOf(tab.url);
  const own = host ? await getTabGain(tab.id, host) : null;
  if (own === null) {
    editActiveSite((s) => { s.gain = Math.min(AE.gainCap(data.app), Math.max(0, s.gain + dir * GAIN_STEP)); s.enabled = true; });
    return;
  }
  await (ready = loadData());
  const s = AE.effective(data, host);
  if (!s.enabled) await browser.storage.local.set(AE.storeFor(data, host, { ...s, enabled: true }));
  await setTabGain(tab.id, Math.min(AE.gainCap(data.app), Math.max(0, own + dir * GAIN_STEP)));
}

function onCommand(name) {
  if (name === 'gain-up') stepGain(1);
  else if (name === 'gain-down') stepGain(-1);
  else if (name === 'toggle') editActiveSite((s) => { s.enabled = !s.enabled; });
  else if (name === 'speed-up') editActiveSite((s) => speedBy(s, 1));
  else if (name === 'speed-down') editActiveSite((s) => speedBy(s, -1));
  else if (name === 'speed-reset') editActiveSite((s) => { s.fx.speed.value = 1; });
}

// no keyboard shortcuts on Firefox for Android
if (browser.commands) browser.commands.onCommand.addListener(onCommand);

/* ---------- lower other tabs ---------- */
// Which tabs are currently lowered survives the event page being unloaded.
async function getDucks() { return (await browser.storage.session.get('duck')).duck || {}; }
async function getDuck(tabId) { return (await getDucks())[tabId] ?? 1; }
async function setDuck(tabId, factor) {
  const ducks = await getDucks();
  if (factor === undefined || factor === 1) delete ducks[tabId]; else ducks[tabId] = factor;
  await browser.storage.session.set({ duck: ducks });
}

async function updateDucking() {
  await ready;
  let focusedAudible = null;
  if (data.app.duck) {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.audible) focusedAudible = tab.id;
  }
  const ducks = await getDucks();
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    const want = focusedAudible !== null && tab.id !== focusedAudible && tab.audible ? DUCK_FACTOR : 1;
    const had = ducks[tab.id] ?? 1;
    if (want === had) continue;
    await setDuck(tab.id, want);
    browser.tabs.sendMessage(tab.id, { type: 'duck', factor: want }).catch(() => {});
  }
}

/* ---------- the tab's own volume (Mixer) ----------
   { tabId: { host, gain } } in storage.session: it survives the event page being unloaded and ends
   with the tab, a navigation to another site, or the browser. The page applies it on top of the site's
   settings (AE.withTabGain); the popup reads it from storage.session. */
async function getTabGains() { return (await browser.storage.session.get('tabGain')).tabGain || {}; }
async function getTabGain(tabId, host) {
  const t = tabId === undefined ? null : (await getTabGains())[tabId];
  return t && t.host === host && typeof t.gain === 'number' ? t.gain : null;
}
/** `gain` null: back to the site's volume. One at a time: a dragged Mixer slider sends many in a row. */
let tabGainQueue = Promise.resolve();
function setTabGain(tabId, gain, closed) {
  const run = tabGainQueue.then(() => writeTabGain(tabId, gain, closed));
  tabGainQueue = run.catch(() => {});
  return run;
}
async function writeTabGain(tabId, gain, closed) {
  const all = await getTabGains();
  let host = null;
  if (!closed) { try { host = AE.hostOf((await browser.tabs.get(tabId)).url); } catch { closed = true; } }
  if (typeof gain === 'number' && isFinite(gain) && host) all[tabId] = { host, gain: Math.round(gain) };
  else delete all[tabId];
  await browser.storage.session.set({ tabGain: all });
  if (closed) return { ok: true };
  browser.tabs.sendMessage(tabId, { type: 'tab-gain', gain: all[tabId] ? all[tabId].gain : null }).catch(() => {});
  try { await updateBadge(await browser.tabs.get(tabId)); } catch { /* tab gone */ }
  return { ok: true };
}

/* ---------- settings sync (opt-in: Settings → Sync) ----------
   storage.sync holds the app settings (without the per-device ones), defaults, EQ presets, sound profiles
   and one item per site ('site:<host>'): one item may hold 8 KB, all sites together would not fit.
   Output devices never leave the device (their ids only mean something in this browser profile).
   Local edits are pushed ~1.5 s later; changes from another device are pulled when they arrive. */
const SYNC_LOCAL_APP = ['sidebar', 'sync'];
const SITE_ITEM = 'site:';
let syncTimer = 0;
const pushed = new Map(); // item → JSON we wrote, to tell our own writes from another device's
const pulled = new Map(); // local key → JSON that came from the account: not an edit to send back
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function syncItems(d) {
  const app = { ...d.app };
  for (const k of SYNC_LOCAL_APP) delete app[k];
  const out = { app, defaults: d.defaults, presets: d.presets, soundProfiles: d.soundProfiles };
  for (const [h, s] of Object.entries(d.sites)) out[SITE_ITEM + h] = s;
  return out;
}

async function pushSync() {
  syncTimer = 0;
  const d = AE.normalize(await browser.storage.local.get(AE.KEYS));
  if (!d.app.sync) return;
  const want = syncItems(d), have = await browser.storage.sync.get(null);
  const set = {};
  for (const k of Object.keys(want)) if (!same(want[k], have[k])) { set[k] = want[k]; pushed.set(k, JSON.stringify(want[k])); }
  const gone = Object.keys(have).filter((k) => k.startsWith(SITE_ITEM) && !(k in want));
  try {
    if (gone.length) await browser.storage.sync.remove(gone);
    if (Object.keys(set).length) await browser.storage.sync.set(set);
    await browser.storage.session.set({ syncError: '' });
  } catch (e) {
    await browser.storage.session.set({ syncError: String((e && e.message) || e) }); // usually the quota
  }
}

async function pullSync() {
  const have = await browser.storage.sync.get(null);
  if (!have.app) return;
  const local = AE.normalize(await browser.storage.local.get(AE.KEYS));
  const sites = {};
  for (const [k, v] of Object.entries(have)) if (k.startsWith(SITE_ITEM)) sites[k.slice(SITE_ITEM.length)] = v;
  const next = {
    app: { ...local.app, ...have.app, sidebar: local.app.sidebar, sync: local.app.sync },
    defaults: have.defaults || local.defaults,
    presets: have.presets || [],
    soundProfiles: have.soundProfiles || [],
    sites,
  };
  const patch = {};
  for (const k of Object.keys(next)) if (!same(next[k], local[k])) { patch[k] = next[k]; pulled.set(k, JSON.stringify(next[k])); }
  if (Object.keys(patch).length) await browser.storage.local.set(patch);
}

/** Switch sync on ('this': this device's settings go up, 'synced': the account's come down) or off. */
async function setSync(on, mode) {
  const local = AE.normalize(await browser.storage.local.get(AE.KEYS));
  await browser.storage.local.set({ app: { ...local.app, sync: on } });
  if (!on) return { ok: true };
  if (mode === 'synced') await pullSync();
  else await pushSync();
  return { ok: true };
}

async function syncState() {
  const [{ app }, { syncError }] = await Promise.all([browser.storage.sync.get('app'), browser.storage.session.get('syncError')]);
  return { hasData: !!app, error: syncError || '' };
}

function schedulePush() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushSync().catch(() => {}), 1500);
}

/* ---------- storage ---------- */
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync') {
    // another device changed something (our own writes come back here too: skip those)
    const foreign = Object.keys(changes).some((k) => pushed.get(k) !== JSON.stringify(changes[k].newValue));
    await ready;
    if (foreign && data.app.sync && !syncTimer) pullSync().catch(() => {});
    return;
  }
  if (area !== 'local' || !AE.KEYS.some((k) => k in changes)) return;
  await (ready = loadData());
  const edited = Object.keys(changes).filter((k) => k !== 'outputs' && pulled.get(k) !== JSON.stringify(changes[k].newValue));
  pulled.clear();
  if (data.app.sync && edited.length) schedulePush();
  if (changes.app) {
    applySidebarMode();
    updateDucking();
  }
  updateAllBadges();
});

/* ---------- permissions granted later (e.g. "allow on this site") ---------- */
browser.permissions.onAdded.addListener(() => injectAll());

/* ---------- lifecycle ---------- */
async function init() {
  await ready;
  await applySidebarMode();   // not persisted by Firefox across restarts
  await updateAllBadges();    // per-tab badges are not persisted either
}

browser.runtime.onStartup.addListener(init);

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  const raw = await browser.storage.local.get([...AE.KEYS, 'meta']);
  const { data: migrated, changed } = AE.migrate(raw);
  const patch = { meta: { schema: AE.SCHEMA, version: browser.runtime.getManifest().version } };
  if (!raw.app) patch.app = AE.clone(AE.DEFAULT_APP); // UI language defaults to English
  if (changed) for (const k of AE.KEYS) if (k in migrated) patch[k] = migrated[k];
  await browser.storage.local.set(patch);
  await (ready = loadData());
  await init();
  await injectAll(); // tabs opened before install / update work without a reload
});

init();
