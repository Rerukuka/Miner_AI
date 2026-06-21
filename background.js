// background.js — service worker. Mining itself runs in an offscreen document so
// it keeps going while the popup is closed and you use Chrome normally.
// This worker only: creates/closes the offscreen doc, caches latest state +
// recent log, and routes messages between popup and offscreen.

let state = {
  running: false, status: 'остановлено', statusKind: 'idle',
  hashrate: '0 H/s', accepted: 0, rejected: 0, difficulty: '—'
};
let logRing = [];
const MAX_LOG = 80;

async function hasOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
  } catch (_) {}
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  } catch (_) { return false; }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Фоновое соединение с пулом и хеширование SHA-256d.'
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) { try { await chrome.offscreen.closeDocument(); } catch (_) {} }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.target === 'bg') {
    if (msg.cmd === 'start') {
      logRing = [];
      state = { running: true, status: 'подключение…', statusKind: 'connecting', hashrate: '0 H/s', accepted: 0, rejected: 0, difficulty: '—' };
      (async () => {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'start', config: msg.config });
      })();
      return;
    }
    if (msg.cmd === 'stop') {
      state.running = false; state.status = 'остановлено'; state.statusKind = 'idle'; state.hashrate = '0 H/s';
      chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop' });
      closeOffscreen();
      return;
    }
    if (msg.cmd === 'getState') {
      hasOffscreen().then((has) => {
        sendResponse({ state: { ...state, running: has }, log: logRing });
      });
      return true; // async response
    }
  } else if (msg.target === 'ui') {
    if (msg.type === 'state') { Object.assign(state, msg.data); if (msg.data && msg.data.running === undefined) state.running = true; }
    else if (msg.type === 'log') { logRing.push({ line: msg.line, kind: msg.kind }); if (logRing.length > MAX_LOG) logRing.shift(); }
    // popup, if open, receives the same broadcast and updates itself
  }
});
