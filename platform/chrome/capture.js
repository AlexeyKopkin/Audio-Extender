/* =========================================================
   Audio Extender — deep mode, service-worker side (Chrome / Edge)

   Loaded after background.js (uses its `ready`, `data`, `getDuck`).
   Deep mode = the tab's whole audio output is captured (tabCapture)
   and processed in the offscreen document; the in-page engine of that
   tab switches to bypass so nothing is processed twice.

   Which tabs are in deep mode survives the service worker being
   unloaded (storage.session); the captures live in the offscreen document.
   ========================================================= */
const OFFSCREEN = 'offscreen.html';

async function deepTabs() { return (await chrome.storage.session.get('deep')).deep || {}; }
async function setDeepTab(tabId, host) {
  const deep = await deepTabs();
  if (host === undefined) delete deep[tabId]; else deep[tabId] = host;
  await chrome.storage.session.set({ deep });
}

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ['USER_MEDIA'],
      justification: 'Plays the audio of a tab the user switched to deep mode through the equalizer and effects.',
    });
  } catch (e) {
    if (!/single offscreen document/i.test(String(e && e.message))) throw e; // created meanwhile
  }
}
const toOffscreen = (msg) => chrome.runtime.sendMessage(msg);

// the in-page engine of every frame in the tab
const setBypass = (tabId, on) => chrome.tabs.sendMessage(tabId, { type: 'bypass', on }).catch(() => {});

async function settingsFor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await ready;
  const host = AE.hostOf(tab.url);
  const output = AE.outputFor(data, host);
  // the tab's own volume (Mixer) goes separately: the popup's live edits carry only the site's settings
  const own = await getTabGain(tabId, host);
  const tabGain = own === null ? null : Math.min(own, AE.gainCap(data.app));
  return { host, settings: AE.effective(data, host), tabGain, duck: await getDuck(tabId), output: output ? output.id : '' };
}

async function captureStart(tabId) {
  const { host, settings, tabGain, duck, output } = await settingsFor(tabId);
  await setBypass(tabId, true);
  let res;
  try {
    // Chrome allows this only after the user invoked the extension on this tab (popup / shortcut).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    res = await toOffscreen({ type: 'offscreen-start', tabId, streamId, settings, tabGain, duck, output });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    await setBypass(tabId, false); // never leave the tab unprocessed and uncaptured
    return res || { ok: false, error: 'no answer from the offscreen document' };
  }
  await setDeepTab(tabId, host);
  return { ok: true };
}

async function captureStop(tabId, alreadyEnded) {
  if (!alreadyEnded) await toOffscreen({ type: 'offscreen-stop', tabId }).catch(() => {});
  await setDeepTab(tabId, undefined);
  await setBypass(tabId, false);
  return { ok: true };
}

async function pushToCaptures(onlyTabId) {
  const deep = await deepTabs();
  for (const id of Object.keys(deep)) {
    const tabId = +id;
    if (onlyTabId !== undefined && tabId !== onlyTabId) continue;
    try {
      const { host, settings, tabGain, duck, output } = await settingsFor(tabId);
      if (host !== deep[id]) await setDeepTab(tabId, host);
      await toOffscreen({ type: 'offscreen-update', tabId, settings, tabGain, duck, output });
    } catch { /* tab gone */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'capture-start' && typeof msg.tabId === 'number') { captureStart(msg.tabId).then(sendResponse); return true; }
  if (msg.type === 'capture-stop' && typeof msg.tabId === 'number') { captureStop(msg.tabId).then(sendResponse); return true; }
  if (msg.type === 'capture-ended' && typeof msg.tabId === 'number') { captureStop(msg.tabId, true); return false; }
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => { if ((await deepTabs())[tabId] !== undefined) captureStop(tabId); });
// navigation inside a captured tab: Chrome keeps the capture; follow the new site's settings
chrome.tabs.onUpdated.addListener(async (tabId, info) => { if (info.url && (await deepTabs())[tabId] !== undefined) pushToCaptures(tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && AE.KEYS.some((k) => k in changes)) || (area === 'session' && (changes.duck || changes.tabGain))) pushToCaptures();
});

// The browser was restarted or the extension updated: captures are gone, forget them.
async function resetCaptures() {
  const deep = await deepTabs();
  if (!Object.keys(deep).length) return;
  let live = [];
  try { if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) live = await toOffscreen({ type: 'offscreen-list' }); } catch { /* none */ }
  for (const id of Object.keys(deep)) if (!live.includes(+id)) await captureStop(+id, true);
}
chrome.runtime.onStartup.addListener(resetCaptures);
chrome.runtime.onInstalled.addListener(resetCaptures);
