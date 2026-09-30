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
    return Promise.all([getDuck(tabId), cap && tabId !== undefined ? cap.isOn(tabId) : false])
      .then(([duck, bypass]) => ({ host: sender.tab ? AE.hostOf(sender.tab.url) : null, duck, bypass }));
  }
  // Popup edits are persisted here so they survive the popup closing mid-save.
  if (msg.type === 'persist' && msg.patch) {
    const patch = {};
    for (const k of AE.KEYS) if (k in msg.patch) patch[k] = msg.patch[k];
    return browser.storage.local.set(patch);
  }
  if (msg.type === 'inject' && typeof msg.tabId === 'number') return injectTab(msg.tabId);
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
  if (data.app.badge && host) {
    const s = AE.effective(data, host);
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

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updateBadge(tab);
  if ('audible' in info) updateDucking();
});
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  updateBadge(await browser.tabs.get(tabId));
  updateDucking();
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  await setDuck(tabId, undefined);
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

// no keyboard shortcuts on Firefox for Android
if (browser.commands) browser.commands.onCommand.addListener((name) => {
  if (name === 'gain-up') editActiveSite((s) => { s.gain = Math.min(AE.gainCap(data.app), s.gain + GAIN_STEP); s.enabled = true; });
  else if (name === 'gain-down') editActiveSite((s) => { s.gain = Math.max(0, s.gain - GAIN_STEP); s.enabled = true; });
  else if (name === 'toggle') editActiveSite((s) => { s.enabled = !s.enabled; });
});

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

/* ---------- storage ---------- */
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !AE.KEYS.some((k) => k in changes)) return;
  await (ready = loadData());
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
