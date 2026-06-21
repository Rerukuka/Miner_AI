// stratum-core.js — pure functions for turning a Stratum job into a hashable
// header. No DOM, no network: loaded by the popup AND unit-tested in Node.
(function (global) {
'use strict';

// ---- SHA-256 / SHA-256d (same verified routine as the worker) ----
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

// ---- hex helpers ----
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
// reverse byte order within each 4-byte word (keeps word order)
function swapEndianWords(hex) {
  let out = '';
  for (let i = 0; i < hex.length; i += 8) {
    const w = hex.substr(i, 8);
    out += w.substr(6,2) + w.substr(4,2) + w.substr(2,2) + w.substr(0,2);
  }
  return out;
}
// reverse the whole byte string
function reverseHex(hex) {
  let out = '';
  for (let i = hex.length - 2; i >= 0; i -= 2) out += hex.substr(i, 2);
  return out;
}

// ---- merkle root from a Stratum coinbase + branch ----
function merkleRoot(coinbaseHex, branchHexArray) {
  let h = sha256d(hexToBytes(coinbaseHex)); // 32 bytes, internal order
  for (const b of branchHexArray) {
    h = sha256d(concatBytes(h, hexToBytes(b)));
  }
  return h; // bytes
}

// ---- assemble the 76-byte header prefix (everything before the nonce) ----
// job: { version, prevhash, ntime, nbits } as received in mining.notify (hex).
// prevhashMode: 'wordswap' (default), 'reverse', or 'asis' — pools differ; this
// is the usual knob to flip if shares get rejected.
function buildHeaderPrefixHex(job, merkleRootBytes, prevhashMode) {
  const mode = prevhashMode || 'wordswap';
  let ph;
  if (mode === 'reverse') ph = reverseHex(job.prevhash);
  else if (mode === 'asis') ph = job.prevhash;
  else ph = swapEndianWords(job.prevhash);

  const hex =
    swapEndianWords(job.version) +   // 4 bytes -> little-endian
    ph +                             // 32 bytes
    bytesToHex(merkleRootBytes) +    // 32 bytes, internal order
    swapEndianWords(job.ntime) +     // 4 bytes -> little-endian
    swapEndianWords(job.nbits);      // 4 bytes -> little-endian

  if (hex.length !== 152) throw new Error('header prefix must be 76 bytes, got ' + (hex.length/2));
  return hex;
}

// ---- target (big-endian, 32 bytes) from pool difficulty ----
const DIFF1 = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
function difficultyToTargetHexBE(difficulty) {
  let target;
  if (Number.isInteger(difficulty) && difficulty > 0) {
    target = DIFF1 / BigInt(difficulty);
  } else {
    const S = 1000000n;
    const d = BigInt(Math.max(1, Math.round(difficulty * 1e6)));
    target = (DIFF1 * S) / d;
  }
  let hex = target.toString(16);
  if (hex.length > 64) hex = hex.slice(-64);
  return hex.padStart(64, '0');
}

const api = {
  sha256, sha256d, hexToBytes, bytesToHex, concatBytes,
  swapEndianWords, reverseHex, merkleRoot, buildHeaderPrefixHex,
  difficultyToTargetHexBE, DIFF1
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.StratumCore = api;
})(typeof self !== 'undefined' ? self : this);
