// popup.js — control panel only. Mining runs in the offscreen document (managed
// by the service worker), so it keeps going when this popup is closed.
const $ = (id) => document.getElementById(id);
const modeEl = $('mode'), bridgeFields = $('bridge-fields'), directFields = $('direct-fields'),
  bridgeUrlEl = $('bridge-url'), poolAddrEl = $('pool-addr'), directUrlEl = $('direct-url'),
  workerEl = $('worker'), passEl = $('password'), prevhashEl = $('prevhash-mode'),
  toggleEl = $('toggle'), statusEl = $('status'), hashrateEl = $('hashrate'),
  acceptedEl = $('accepted'), rejectedEl = $('rejected'), diffEl = $('difficulty'), logEl = $('log');

let running = false;
const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const FIELDS = ['mode', 'bridgeUrl', 'poolAddr', 'directUrl', 'worker', 'password', 'prevhashMode'];

function applyMode() {
  const b = modeEl.value === 'bridge';
  bridgeFields.style.display = b ? '' : 'none';
  directFields.style.display = b ? 'none' : '';
}
async function restore() {
  if (hasStorage) {
    try {
      const s = await chrome.storage.local.get(FIELDS);
      if (s.mode) modeEl.value = s.mode;
      if (s.bridgeUrl) bridgeUrlEl.value = s.bridgeUrl;
      if (s.poolAddr) poolAddrEl.value = s.poolAddr;
      if (s.directUrl) directUrlEl.value = s.directUrl;
      if (s.worker) workerEl.value = s.worker;
      if (s.password) passEl.value = s.password;
      if (s.prevhashMode) prevhashEl.value = s.prevhashMode;
    } catch (_) {}
  }
  applyMode();
}
function persist() {
  if (!hasStorage) return;
  chrome.storage.local.set({
    mode: modeEl.value, bridgeUrl: bridgeUrlEl.value.trim(), poolAddr: poolAddrEl.value.trim(),
    directUrl: directUrlEl.value.trim(), worker: workerEl.value.trim(),
    password: passEl.value, prevhashMode: prevhashEl.value
  }).catch(() => {});
}
function config() {
  return {
    mode: modeEl.value, bridgeUrl: bridgeUrlEl.value.trim(), poolAddr: poolAddrEl.value.trim(),
    directUrl: directUrlEl.value.trim(), worker: workerEl.value.trim(),
    password: passEl.value, prevhashMode: prevhashEl.value
  };
}

function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = 'status status-' + (kind || 'idle'); }
function setRunningUI(r) {
  running = r;
  toggleEl.textContent = r ? '■ Остановить' : '▶ Подключиться и майнить';
  toggleEl.classList.toggle('running', r);
  [modeEl, bridgeUrlEl, poolAddrEl, directUrlEl, workerEl, passEl, prevhashEl].forEach((el) => { el.disabled = r; });
}
function addLog(line, kind) {
  const li = document.createElement('li');
  li.className = 'log-' + (kind || 'info');
  li.textContent = line;
  logEl.prepend(li);
  while (logEl.children.length > 120) logEl.removeChild(logEl.lastChild);
}
function renderState(s) {
  if (!s) return;
  if (s.status !== undefined) setStatus(s.status, s.statusKind);
  if (s.hashrate !== undefined) hashrateEl.textContent = s.hashrate;
  if (s.accepted !== undefined) acceptedEl.textContent = String(s.accepted);
  if (s.rejected !== undefined) rejectedEl.textContent = String(s.rejected);
  if (s.difficulty !== undefined) diffEl.textContent = String(s.difficulty);
}

toggleEl.addEventListener('click', () => {
  if (running) {
    chrome.runtime.sendMessage({ target: 'bg', cmd: 'stop' });
    setRunningUI(false); setStatus('остановлено', 'idle'); hashrateEl.textContent = '0 H/s';
  } else {
    if (!workerEl.value.trim()) { addLog('укажи кошелёк/логин', 'err'); return; }
    persist();
    logEl.innerHTML = '';
    setRunningUI(true); setStatus('подключение…', 'connecting');
    chrome.runtime.sendMessage({ target: 'bg', cmd: 'start', config: config() });
  }
});
modeEl.addEventListener('change', () => { applyMode(); persist(); });
[bridgeUrlEl, poolAddrEl, directUrlEl, workerEl, passEl, prevhashEl].forEach((el) => el.addEventListener('change', persist));

// live updates broadcast from the offscreen miner
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'ui') return;
  if (msg.type === 'state') renderState(msg.data);
  else if (msg.type === 'log') addLog(msg.line, msg.kind);
});

// on open: load fields, then sync with whatever the miner is already doing
(async () => {
  await restore();
  try {
    const resp = await chrome.runtime.sendMessage({ target: 'bg', cmd: 'getState' });
    if (resp) {
      if (resp.log) resp.log.forEach((l) => addLog(l.line, l.kind));
      renderState(resp.state);
      setRunningUI(!!(resp.state && resp.state.running));
    }
  } catch (_) {}
})();
