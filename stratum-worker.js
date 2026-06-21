// stratum-worker.js — does ONLY the hashing. The popup speaks Stratum and hands
// this worker a ready-to-hash 76-byte header prefix + the share target.

// ---------- SHA-256 / SHA-256d (verified against Node crypto) ----------
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
const _w = new Uint32Array(64);
function sha256(msg) {
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const l = msg.length;
  const total = ((((l + 8) >> 6) + 1) << 6);
  const buf = new Uint8Array(total);
  buf.set(msg); buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = l * 8;
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) _w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = _w[t-15], y = _w[t-2];
      const s0 = rotr(x,7) ^ rotr(x,18) ^ (x>>>3);
      const s1 = rotr(y,17) ^ rotr(y,19) ^ (y>>>10);
      _w[t] = (_w[t-16] + s0 + _w[t-7] + s1) >>> 0;
    }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch = (e&f)^(~e&g);
      const t1 = (h + S1 + ch + K[t] + _w[t]) >>> 0;
      const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj = (a&b)^(a&c)^(b&c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i=0;i<8;i++) odv.setUint32(i*4, H[i]);
  return out;
}
function sha256d(m) { return sha256(sha256(m)); }

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}
function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// hash is sha256d output. Bitcoin compares it as a little-endian 256-bit number
// against the target. Most-significant byte of that number is hash[31].
// targetBE is the 32-byte target in big-endian. Returns true if hash <= target.
function meetsTarget(hash, targetBE) {
  for (let i = 0; i < 32; i++) {
    const a = hash[31 - i], b = targetBE[i];
    if (a < b) return true;
    if (a > b) return false;
  }
  return true;
}

// ---------- mining loop ----------
let running = false;
let jobId = null;
let prefix = null;     // Uint8Array(76)
let target = null;     // Uint8Array(32) big-endian
const header = new Uint8Array(80);
const headerDV = new DataView(header.buffer);
let nonce = 0;
let totalHashes = 0;
let hashesSinceReport = 0;
let lastReport = 0;

function startJob(msg) {
  jobId = msg.jobId;
  prefix = hexToBytes(msg.prefixHex);   // 76 bytes
  target = hexToBytes(msg.targetHex);   // 32 bytes BE
  header.set(prefix, 0);
  nonce = (Math.random() * 0xffffffff) >>> 0; // random start point in the nonce space
  if (!running) {
    running = true;
    lastReport = performance.now();
    mineBatch();
  }
}

function mineBatch() {
  if (!running || !prefix) return;
  const BATCH = 1500;
  for (let i = 0; i < BATCH; i++) {
    headerDV.setUint32(76, nonce, true); // nonce field is little-endian in the header
    const h = sha256d(header);
    if (meetsTarget(h, target)) {
      const rev = new Uint8Array(32);
      for (let j = 0; j < 32; j++) rev[j] = h[31 - j]; // display order
      self.postMessage({
        type: 'share',
        jobId,
        nonce: nonce >>> 0,
        nonceHex: (nonce >>> 0).toString(16).padStart(8, '0'),
        hashHex: toHex(rev)
      });
    }
    nonce = (nonce + 1) >>> 0;
    if (nonce === 0) self.postMessage({ type: 'exhausted', jobId }); // wrapped 2^32
    totalHashes++;
    hashesSinceReport++;
  }
  const now = performance.now();
  const dt = now - lastReport;
  if (dt >= 500) {
    self.postMessage({ type: 'hashrate', hps: hashesSinceReport / (dt / 1000), totalHashes });
    hashesSinceReport = 0;
    lastReport = now;
  }
  setTimeout(mineBatch, 0); // yield so 'stop'/'job' messages are processed
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'job') startJob(m);
  else if (m.type === 'stop') { running = false; prefix = null; }
};
