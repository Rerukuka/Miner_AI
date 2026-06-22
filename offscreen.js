// offscreen.js — runs in the offscreen document so mining persists in the
// background. Holds the WebSocket + Stratum protocol and drives the hashing
// worker. Reports status/hashrate/log to the service worker via messages.
const SC = self.StratumCore;

let ws = null, workers = [], running = false, msgId = 0;
const pending = {};
let extranonce1 = '', extranonce2Size = 4, extranonce2Counter = 0, difficulty = 1;
const jobCtx = {};
let jobOrder = [];
let accepted = 0, rejected = 0;
let stratumStarted = false;
let cfg = null;

// BTCAI_PLUGIN_TELEMETRY_V1
let lastHps = 0;
let lastTotalHashes = 0;
let telemetryTimer = null;
let currentJobMessage = null;
let workerRates = {};
let workerTotals = {};
let lastTelemetryHashrateSent = 0;

function ui(data) { chrome.runtime.sendMessage({ target: 'ui', type: 'state', data }); }
function logLine(line, kind) { chrome.runtime.sendMessage({ target: 'ui', type: 'log', line, kind: kind || 'info' }); }
function setStatus(text, kind) { ui({ status: text, statusKind: kind || 'idle' }); }
function fmtHashrate(hps) {
  if (hps >= 1e6) return (hps / 1e6).toFixed(2) + ' MH/s';
  if (hps >= 1e3) return (hps / 1e3).toFixed(2) + ' kH/s';
  return Math.round(hps) + ' H/s';
}

// BTCAI_PLUGIN_TELEMETRY_HELPERS_V1
function isTelemetryBridge() {
  if (!cfg) return false;
  if (cfg.mode === 'bridge') return true;
  const url = String(cfg.directUrl || cfg.bridgeUrl || '');
  return /mine\.btcaiwork\.com|127\.0\.0\.1:8715|localhost:8715/i.test(url);
}

function sendTelemetry(reason) {
  try {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN || !cfg || !cfg.worker) return;
    if (!isTelemetryBridge()) return;

    const hps = Number(lastHps || 0);
    ws.send(JSON.stringify({
      type: 'telemetry',
      wallet: cfg.worker,
      worker: cfg.worker,
      hashrate_hs: Math.round(hps),
      reported_hashrate_hs: Math.round(hps),
      hashrate_display: fmtHashrate(hps),
      reported_hashrate: fmtHashrate(hps),
      accepted,
      rejected,
      total_hashes: lastTotalHashes,
      threads: workers.length || 1,
      difficulty,
      status: running ? 'mining' : 'stopped',
      reason: reason || 'timer',
      ts: new Date().toISOString()
    }));
  } catch (_) {}
}

function startTelemetryTimer() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  telemetryTimer = setInterval(() => sendTelemetry('interval'), 5000);
}

function stopTelemetryTimer() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  telemetryTimer = null;
}
// BTCAI_PLUGIN_TELEMETRY_HELPERS_V1_END


// BTCAI_MULTI_WORKER_FAST_MODE_V1
function getMiningThreadCount() {
  const cores = Number(navigator.hardwareConcurrency || 2);
  // Browser mining should stay responsive, so use most cores but leave one for UI/Chrome.
  return Math.max(1, Math.min(8, Math.max(1, cores - 1)));
}

function terminateWorkers() {
  for (const w of workers) {
    try { w.postMessage({ type: 'stop' }); } catch (_) {}
    try { w.terminate(); } catch (_) {}
  }
  workers = [];
  workerRates = {};
  workerTotals = {};
}

function updateAggregatedHashrate(reason) {
  let hps = 0;
  let total = 0;
  for (const v of Object.values(workerRates)) hps += Number(v || 0);
  for (const v of Object.values(workerTotals)) total += Number(v || 0);

  lastHps = hps;
  lastTotalHashes = total;
  ui({ hashrate: fmtHashrate(hps) + (workers.length > 1 ? ` (${workers.length} threads)` : '') });

  const now = Date.now();
  if (now - lastTelemetryHashrateSent >= 4000) {
    lastTelemetryHashrateSent = now;
    sendTelemetry(reason || 'hashrate');
  }
}

function handleWorkerMessage(e) {
  const m = e.data || {};
  if (m.type === 'hashrate') {
    const idx = Number(m.workerIndex || 0);
    workerRates[idx] = Number(m.hps || 0);
    workerTotals[idx] = Number(m.totalHashes || 0);
    updateAggregatedHashrate('hashrate');
  } else if (m.type === 'share') {
    submitShare(m);
  } else if (m.type === 'exhausted') {
    logLine('nonce range wrapped, waiting for new job', 'info');
  }
}

function startWorkers() {
  terminateWorkers();
  const n = getMiningThreadCount();
  for (let i = 0; i < n; i++) {
    const w = new Worker('stratum-worker.js');
    w.onmessage = handleWorkerMessage;
    workers.push(w);
  }
  logLine('fast mode: started ' + n + ' mining threads', 'ok');
  if (currentJobMessage) postJobToWorkers(currentJobMessage);
}

function postJobToWorkers(jobMessage) {
  currentJobMessage = jobMessage;
  if (!workers.length) startWorkers();
  const n = workers.length || 1;
  workers.forEach((w, i) => {
    try { w.postMessage({ ...jobMessage, workerIndex: i, workerCount: n }); } catch (_) {}
  });
}
// BTCAI_MULTI_WORKER_FAST_MODE_V1_END

function send(method, params) {
  const id = ++msgId;
  pending[id] = method;                 // keyed by full method name
  const line = JSON.stringify({ id, method, params });
  ws.send(line);
  logLine('→ ' + line, 'sent');
  return id;
}

function startStratum() {
  if (stratumStarted) return;           // subscribe exactly once per connection
  stratumStarted = true;
  send('mining.subscribe', ['btc-aiwork-miner/1.1']);
}

function handleNotify(params) {
  const [jobId, prevhash, coinb1, coinb2, merkleBranch, version, nbits, ntime] = params;
  extranonce2Counter = (extranonce2Counter + 1) >>> 0;
  const extranonce2 = extranonce2Counter.toString(16).padStart(extranonce2Size * 2, '0').slice(-extranonce2Size * 2);
  const coinbase = coinb1 + extranonce1 + extranonce2 + coinb2;
  const merkleRootBytes = SC.merkleRoot(coinbase, merkleBranch);
  let prefixHex;
  try {
    prefixHex = SC.buildHeaderPrefixHex({ version, prevhash, ntime, nbits }, merkleRootBytes, cfg.prevhashMode);
  } catch (err) { logLine('header build error: ' + err.message, 'err'); return; }

  jobCtx[jobId] = { extranonce2, ntime };
  jobOrder.push(jobId);
  while (jobOrder.length > 6) delete jobCtx[jobOrder.shift()];

  logLine('job ' + jobId + ' (diff ' + difficulty + ')', 'info');
  postJobToWorkers({ type: 'job', jobId, prefixHex, targetHex: SC.difficultyToTargetHexBE(difficulty) });
}

function submitShare(share) {
  const ctx = jobCtx[share.jobId];
  if (!ctx) { logLine('stale share for ' + share.jobId, 'info'); return; }
  send('mining.submit', [cfg.worker, share.jobId, ctx.extranonce2, ctx.ntime, share.nonceHex]);
  logLine('found share ' + share.hashHex.slice(0, 24) + '…', 'ok');
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { logLine('← (unparsable) ' + line, 'recv'); return; }

  if (msg.bridge) {
    if (msg.bridge === 'connected') { logLine('bridge → pool connected', 'ok'); if (cfg.mode === 'bridge') startStratum(); }
    else if (msg.bridge === 'error') { logLine('bridge error: ' + msg.error, 'err'); setStatus('bridge error', 'err'); }
    else if (msg.bridge === 'pool_closed') { logLine('pool closed', 'err'); setStatus('pool disconnected', 'err'); }
    return;
  }

  logLine('← ' + line, 'recv');

  if (msg.method) {
    if (msg.method === 'mining.notify') handleNotify(msg.params);
    else if (msg.method === 'mining.set_difficulty') { difficulty = msg.params[0]; ui({ difficulty: String(difficulty) }); logLine('set_difficulty ' + difficulty, 'info'); }
    else if (msg.method === 'mining.set_extranonce') { extranonce1 = msg.params[0]; extranonce2Size = msg.params[1]; }
    else if (msg.method === 'client.reconnect') { logLine('pool requested reconnect', 'info'); }
    return;
  }

  const what = pending[msg.id]; delete pending[msg.id];
  if (what === 'mining.subscribe') {
    if (msg.error || !msg.result) { logLine('subscribe failed', 'err'); setStatus('subscription rejected', 'err'); return; }
    extranonce1 = msg.result[1];
    extranonce2Size = msg.result[2];
    logLine('subscribed, en1=' + extranonce1 + ' en2size=' + extranonce2Size, 'ok');
    send('mining.authorize', [cfg.worker, cfg.password]);
  } else if (what === 'mining.authorize') {
    if (msg.result === true) { setStatus('mining', 'mining'); logLine('authorized ✓', 'ok'); sendTelemetry('authorized'); }
    else { setStatus('login rejected', 'err'); logLine('authorize rejected: ' + JSON.stringify(msg.error), 'err'); }
  } else if (what === 'mining.submit') {
    if (msg.result === true) { accepted++; ui({ accepted }); logLine('share ACCEPTED', 'ok'); sendTelemetry('share_accepted'); }
    else { rejected++; ui({ rejected }); logLine('share REJECTED: ' + JSON.stringify(msg.error), 'err'); sendTelemetry('share_rejected'); }
  }
}

function startMining(config) {
  stopMining();
  cfg = config;
  accepted = 0; rejected = 0; difficulty = 1; extranonce1 = ''; extranonce2Counter = 0; stratumStarted = false;
  currentJobMessage = null; workerRates = {}; workerTotals = {}; lastHps = 0; lastTotalHashes = 0; lastTelemetryHashrateSent = 0;
  for (const k in jobCtx) delete jobCtx[k];
  jobOrder = [];
  ui({ status: 'connecting…', statusKind: 'connecting', hashrate: '0 H/s', accepted: 0, rejected: 0, difficulty: '—', running: true });

  const bridge = cfg.mode === 'bridge';
  let wsUrl, poolHost, poolPort;
  if (bridge) {
    wsUrl = cfg.bridgeUrl;
    const addr = cfg.poolAddr; const idx = addr.lastIndexOf(':');
    if (idx < 0) { logLine('pool address must be host:port', 'err'); setStatus('address error', 'err'); return; }
    poolHost = addr.slice(0, idx); poolPort = parseInt(addr.slice(idx + 1), 10);
  } else {
    wsUrl = cfg.directUrl;
  }
  if (!cfg.worker) { logLine('enter wallet/login', 'err'); setStatus('no wallet', 'err'); return; }

  logLine('connecting ' + wsUrl, 'info');
  try { ws = new WebSocket(wsUrl); } catch (err) { logLine('WS error: ' + err.message, 'err'); setStatus('error', 'err'); return; }
  running = true;
  startTelemetryTimer();

  ws.onopen = () => { logLine('websocket open', 'ok'); if (bridge) ws.send(JSON.stringify({ type: 'connect', host: poolHost, port: poolPort })); else startStratum(); sendTelemetry('ws_open'); };
  ws.onmessage = (ev) => { String(ev.data).split('\n').forEach((l) => { if (l.trim()) onLine(l.trim()); }); };
  ws.onerror = () => { logLine('websocket error', 'err'); setStatus('connection error', 'err'); };
  ws.onclose = () => { if (running) { logLine('websocket closed', 'err'); setStatus('connection closed', 'err'); } };

  startWorkers();
}

function stopMining() {
  sendTelemetry('stop');
  stopTelemetryTimer();
  running = false; stratumStarted = false;
  terminateWorkers();
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'start') startMining(msg.config);
  else if (msg.cmd === 'stop') { stopMining(); ui({ status: 'stopped', statusKind: 'idle', hashrate: '0 H/s', running: false }); }
});
