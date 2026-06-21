// offscreen.js — runs in the offscreen document so mining persists in the
// background. Holds the WebSocket + Stratum protocol and drives the hashing
// worker. Reports status/hashrate/log to the service worker via messages.
const SC = self.StratumCore;

let ws = null, worker = null, running = false, msgId = 0;
const pending = {};
let extranonce1 = '', extranonce2Size = 4, extranonce2Counter = 0, difficulty = 1;
const jobCtx = {};
let jobOrder = [];
let accepted = 0, rejected = 0;
let stratumStarted = false;
let cfg = null;

function ui(data) { chrome.runtime.sendMessage({ target: 'ui', type: 'state', data }); }
function logLine(line, kind) { chrome.runtime.sendMessage({ target: 'ui', type: 'log', line, kind: kind || 'info' }); }
function setStatus(text, kind) { ui({ status: text, statusKind: kind || 'idle' }); }
function fmtHashrate(hps) {
  if (hps >= 1e6) return (hps / 1e6).toFixed(2) + ' MH/s';
  if (hps >= 1e3) return (hps / 1e3).toFixed(2) + ' kH/s';
  return Math.round(hps) + ' H/s';
}

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
  if (worker) worker.postMessage({ type: 'job', jobId, prefixHex, targetHex: SC.difficultyToTargetHexBE(difficulty) });
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
    else if (msg.bridge === 'error') { logLine('bridge error: ' + msg.error, 'err'); setStatus('ошибка моста', 'err'); }
    else if (msg.bridge === 'pool_closed') { logLine('pool closed', 'err'); setStatus('пул отключился', 'err'); }
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
    if (msg.error || !msg.result) { logLine('subscribe failed', 'err'); setStatus('подписка отклонена', 'err'); return; }
    extranonce1 = msg.result[1];
    extranonce2Size = msg.result[2];
    logLine('subscribed, en1=' + extranonce1 + ' en2size=' + extranonce2Size, 'ok');
    send('mining.authorize', [cfg.worker, cfg.password]);
  } else if (what === 'mining.authorize') {
    if (msg.result === true) { setStatus('майнинг идёт', 'mining'); logLine('authorized ✓', 'ok'); }
    else { setStatus('логин отклонён', 'err'); logLine('authorize rejected: ' + JSON.stringify(msg.error), 'err'); }
  } else if (what === 'mining.submit') {
    if (msg.result === true) { accepted++; ui({ accepted }); logLine('share ACCEPTED', 'ok'); }
    else { rejected++; ui({ rejected }); logLine('share REJECTED: ' + JSON.stringify(msg.error), 'err'); }
  }
}

function startMining(config) {
  stopMining();
  cfg = config;
  accepted = 0; rejected = 0; difficulty = 1; extranonce1 = ''; extranonce2Counter = 0; stratumStarted = false;
  for (const k in jobCtx) delete jobCtx[k];
  jobOrder = [];
  ui({ status: 'подключение…', statusKind: 'connecting', hashrate: '0 H/s', accepted: 0, rejected: 0, difficulty: '—', running: true });

  const bridge = cfg.mode === 'bridge';
  let wsUrl, poolHost, poolPort;
  if (bridge) {
    wsUrl = cfg.bridgeUrl;
    const addr = cfg.poolAddr; const idx = addr.lastIndexOf(':');
    if (idx < 0) { logLine('адрес пула должен быть host:port', 'err'); setStatus('ошибка адреса', 'err'); return; }
    poolHost = addr.slice(0, idx); poolPort = parseInt(addr.slice(idx + 1), 10);
  } else {
    wsUrl = cfg.directUrl;
  }
  if (!cfg.worker) { logLine('укажи кошелёк/логин', 'err'); setStatus('нет кошелька', 'err'); return; }

  logLine('connecting ' + wsUrl, 'info');
  try { ws = new WebSocket(wsUrl); } catch (err) { logLine('WS error: ' + err.message, 'err'); setStatus('ошибка', 'err'); return; }
  running = true;

  ws.onopen = () => { logLine('websocket open', 'ok'); if (bridge) ws.send(JSON.stringify({ type: 'connect', host: poolHost, port: poolPort })); else startStratum(); };
  ws.onmessage = (ev) => { String(ev.data).split('\n').forEach((l) => { if (l.trim()) onLine(l.trim()); }); };
  ws.onerror = () => { logLine('websocket error', 'err'); setStatus('ошибка связи', 'err'); };
  ws.onclose = () => { if (running) { logLine('websocket closed', 'err'); setStatus('соединение закрыто', 'err'); } };

  worker = new Worker('stratum-worker.js');
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'hashrate') ui({ hashrate: fmtHashrate(m.hps) });
    else if (m.type === 'share') submitShare(m);
    else if (m.type === 'exhausted') logLine('nonce wrapped, ждём новую работу', 'info');
  };
}

function stopMining() {
  running = false; stratumStarted = false;
  if (worker) { worker.terminate(); worker = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'start') startMining(msg.config);
  else if (msg.cmd === 'stop') { stopMining(); ui({ status: 'остановлено', statusKind: 'idle', hashrate: '0 H/s', running: false }); }
});
