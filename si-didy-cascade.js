/* si-didy-cascade v1.0.0 · PRIVATE
 * Routes every outbound Claude call through fall-cascade + mesh cache-first.
 * NiceAssOS L1 upgrade · si-didy sensor · Simon Gant · sjgant80@gmail.com
 * MIT · ◊·κ=φ⁴
 *
 * import { SiDidyCascade } from 'https://sjgant80-hub.github.io/si-didy-cascade/si-didy-cascade.js'
 */

const VERSION = '1.0.0';
const ENVELOPE_VERSION = 'niceassos-mesh-v1';
const DEFAULT_MESH_DEADLINE_MS = 300;
const DEFAULT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7d
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL_DEFAULT = 'claude-opus-4-7';
const ANTHROPIC_MAX_TOKENS_DEFAULT = 1024;
const IDB_NAME = 'si-didy-cascade';
const IDB_STORE = 'recall';

// ─────────────────────────────────────────────────────────── crypto helpers ──
const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return hex(buf);
}
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

// ─────────────────────────────────────────────────────────────── IDB cache ──
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'hash' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(hash) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(hash);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(rec) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

// ─────────────────────────────────────────────────────── the cascade class ──
export class SiDidyCascade {
  constructor(opts = {}) {
    this.meshInstance = opts.meshInstance || null;
    this.fallcompassInstance = opts.fallcompassInstance || null;
    this.fallkitInstance = opts.fallkitInstance || null;
    this.cacheStore = opts.cacheStore || null; // FallMind v2 or similar
    this._oauthToken = opts.oauthToken || null; // never logged
    this.anthropicModel = opts.anthropicModel || ANTHROPIC_MODEL_DEFAULT;
    this.anthropicMaxTokens = opts.anthropicMaxTokens || ANTHROPIC_MAX_TOKENS_DEFAULT;
    this.meshDeadlineMs = opts.meshDeadlineMs || DEFAULT_MESH_DEADLINE_MS;
    this.cacheTtlMs = opts.cacheTtlMs || DEFAULT_CACHE_TTL_MS;
    this.fallcompassEndpoint = opts.fallcompassEndpoint || 'https://sjgant80-hub.github.io/fallcompass/fallcompass-shim.js';
    this.channelName = opts.channelName || 'niceassos-mesh';
    this.forkPub = null;
    this.forkPriv = null;
    this._seq = 0;
    this._prevHash = null;
    this._pending = new Map(); // queryHash -> resolver
    this._channel = null;
    this._stats = { T0: 0, T2: 0, T3: 0, cacheHits: 0, tokensSaved: 0, calls: [] };
    this._ready = this._init();
  }

  async _init() {
    // Konomi Ed25519 identity — ephemeral per session unless mesh supplies one
    if (this.meshInstance && this.meshInstance.forkPub && this.meshInstance.forkPriv) {
      this.forkPub = this.meshInstance.forkPub;
      this.forkPriv = this.meshInstance.forkPriv;
    } else {
      const kp = await crypto.subtle.generateKey(
        { name: 'Ed25519', namedCurve: 'Ed25519' },
        true, ['sign', 'verify']
      ).catch(() => null);
      if (kp) {
        this.forkPriv = kp.privateKey;
        const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
        this.forkPub = hex(rawPub);
      } else {
        // Ed25519 unavailable → random-hex identity (unsigned envelopes still traceable)
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        this.forkPub = hex(buf);
      }
    }
    // BroadcastChannel — same-machine mesh
    try {
      this._channel = new BroadcastChannel(this.channelName);
      this._channel.onmessage = ev => this._onMeshMessage(ev.data);
    } catch (_) { this._channel = null; }
  }

  // ───────────────────────────────────────────────── main entry: route(...) ──
  async route(prompt, opts = {}) {
    await this._ready;
    const t0 = performance.now();
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { text: '', tier: 'T0', source: 'noop', ms: 0, tokens_saved: 0 };
    }
    const hash = await sha256hex(prompt);

    // 1 · classify via fallcompass (or heuristic fallback)
    let tier = await this._classify(prompt);
    if (opts.forceTier) tier = opts.forceTier;

    // 2 · T0 mechanical — zero cost
    if (tier === 'T0') {
      const text = this._runMechanical(prompt);
      const ms = performance.now() - t0;
      this._record('T0', 'mechanical', ms, prompt.length);
      return { text, tier: 'T0', source: 'mechanical', ms, tokens_saved: this._estTokens(prompt) };
    }

    // 3 · T2 WebLLM — local, zero cost
    if (tier === 'T2') {
      const text = await this._runWebLLM(prompt, opts);
      const ms = performance.now() - t0;
      this._record('T2', 'webllm', ms, prompt.length);
      return { text, tier: 'T2', source: 'webllm', ms, tokens_saved: this._estTokens(prompt) };
    }

    // 4 · T3 — mesh cache-first
    const cached = await this._checkLocalCache(hash);
    if (cached) {
      const ms = performance.now() - t0;
      this._stats.cacheHits++;
      this._record('T3', 'cache-local', ms, prompt.length);
      return { text: cached.response, tier: 'T3', source: 'cache-local', ms, tokens_saved: this._estTokens(prompt) + this._estTokens(cached.response) };
    }

    const meshHit = await this._queryMesh(prompt, hash);
    if (meshHit) {
      await this._cache(prompt, hash, meshHit.tokens);
      const ms = performance.now() - t0;
      this._stats.cacheHits++;
      this._record('T3', 'cache-mesh', ms, prompt.length);
      return { text: meshHit.tokens, tier: 'T3', source: 'cache-mesh', ms, tokens_saved: this._estTokens(prompt) + this._estTokens(meshHit.tokens) };
    }

    // 5 · fall through to Claude
    const claudeText = await this._callClaude(prompt, opts);
    await this._cache(prompt, hash, claudeText);
    const ms = performance.now() - t0;
    this._record('T3', 'claude', ms, prompt.length);
    return { text: claudeText, tier: 'T3', source: 'claude', ms, tokens_saved: 0 };
  }

  // ─────────────────────────────────────────────────────────────── classify ──
  async _classify(prompt) {
    // Try fallcompass instance if injected
    try {
      if (this.fallcompassInstance && typeof this.fallcompassInstance.classify === 'function') {
        const r = await this.fallcompassInstance.classify(prompt);
        if (r && r.tier) return r.tier;
      }
    } catch (_) { /* fall through */ }
    // Heuristic fallback matching fallcompass v2 shape
    const s = prompt.trim();
    // T0: mechanical / deterministic ops
    if (/^(echo|count|reverse|uppercase|lowercase|hash|sha256|md5|base64|hex)\b/i.test(s)) return 'T0';
    if (s.length < 40 && /^[\d\s+\-*/().]+$/.test(s)) return 'T0';
    // T2: short generative, no code / no long-context
    if (s.length < 400 && !/\b(implement|debug|architect|design|analy[sz]e|refactor|deep|full)\b/i.test(s)) return 'T2';
    // T3: everything else → Claude
    return 'T3';
  }

  _runMechanical(prompt) {
    const s = prompt.trim();
    if (/^echo\s+/i.test(s)) return s.replace(/^echo\s+/i, '');
    if (/^count\s+/i.test(s)) return String(s.replace(/^count\s+/i, '').length);
    if (/^reverse\s+/i.test(s)) return s.replace(/^reverse\s+/i, '').split('').reverse().join('');
    if (/^uppercase\s+/i.test(s)) return s.replace(/^uppercase\s+/i, '').toUpperCase();
    if (/^lowercase\s+/i.test(s)) return s.replace(/^lowercase\s+/i, '').toLowerCase();
    if (/^[\d\s+\-*/().]+$/.test(s)) {
      try { return String(Function('"use strict";return (' + s + ')')()); } catch (_) { return ''; }
    }
    return '';
  }

  async _runWebLLM(prompt, opts) {
    if (this.fallkitInstance && typeof this.fallkitInstance.aiComplete === 'function') {
      const out = await this.fallkitInstance.aiComplete(
        opts.system || 'You are a concise assistant.',
        prompt,
        opts.maxTokens || 512
      );
      if (out) return out;
    }
    // No WebLLM available — degrade to T3
    return await this._callClaude(prompt, opts);
  }

  // ────────────────────────────────────────────────────────── mesh recall ──
  async _queryMesh(prompt, hash) {
    if (!this._channel) return null;
    const env = await this._buildEnvelope('recall_query', {
      query_hash: hash,
      query: prompt.slice(0, 512), // cap payload
      k: 1
    });
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        this._pending.delete(hash);
        resolve(null);
      }, this.meshDeadlineMs);
      this._pending.set(hash, (payload) => {
        clearTimeout(timer);
        this._pending.delete(hash);
        resolve(payload);
      });
      try { this._channel.postMessage(env); } catch (_) { clearTimeout(timer); resolve(null); }
    });
  }

  async _onMeshMessage(env) {
    if (!env || env.version !== ENVELOPE_VERSION) return;
    // Verify signature best-effort
    const ok = await this._verify(env);
    if (env.kind === 'recall_response' && env.payload && env.payload.query_hash) {
      const resolver = this._pending.get(env.payload.query_hash);
      if (resolver && ok !== false) resolver(env.payload);
    }
    if (env.kind === 'recall_query' && env.payload && env.payload.query_hash) {
      // Serve from local cache if we have it
      const rec = await idbGet(env.payload.query_hash).catch(() => null);
      if (rec && rec.response) {
        const resp = await this._buildEnvelope('recall_response', {
          query_hash: env.payload.query_hash,
          tokens: rec.response,
          score: 1.0
        });
        try { this._channel.postMessage(resp); } catch (_) {}
      }
    }
  }

  async _buildEnvelope(kind, payload) {
    this._seq++;
    const base = {
      version: ENVELOPE_VERSION,
      kind,
      fork_pub: this.forkPub,
      ts: new Date().toISOString(),
      seq: this._seq,
      prev_hash: this._prevHash,
      payload
    };
    const canonical = canonicalize(base);
    let signature = '';
    try {
      if (this.forkPriv && typeof this.forkPriv !== 'string') {
        const sig = await crypto.subtle.sign({ name: 'Ed25519' }, this.forkPriv, enc.encode(canonical));
        signature = hex(sig);
      }
    } catch (_) { signature = ''; }
    this._prevHash = await sha256hex(canonical);
    return { ...base, signature };
  }

  async _verify(env) {
    if (!env.signature || !env.fork_pub) return null; // unverified but allowed
    try {
      const pubKey = await crypto.subtle.importKey(
        'raw', fromHex(env.fork_pub),
        { name: 'Ed25519', namedCurve: 'Ed25519' },
        false, ['verify']
      );
      const { signature, ...rest } = env;
      const canonical = canonicalize(rest);
      return await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, fromHex(signature), enc.encode(canonical));
    } catch (_) { return null; }
  }

  // ───────────────────────────────────────────────────────── Claude call ──
  async _callClaude(prompt, opts = {}) {
    if (!this._oauthToken) {
      throw new Error('si-didy-cascade: no oauthToken configured — T3 requires BYOK/OAuth');
    }
    const body = {
      model: opts.model || this.anthropicModel,
      max_tokens: opts.maxTokens || this.anthropicMaxTokens,
      messages: [{ role: 'user', content: prompt }]
    };
    if (opts.system) body.system = opts.system;
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Authorization': 'Bearer ' + this._oauthToken // read-only, never logged
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      // scrub any accidental token echo
      throw new Error('Claude API ' + res.status + ' ' + err.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]'));
    }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return text;
  }

  // ────────────────────────────────────────────────────────────── cache ──
  async _checkLocalCache(hash) {
    // FallMind v2 first
    if (this.cacheStore && typeof this.cacheStore.get === 'function') {
      try {
        const hit = await this.cacheStore.get(hash);
        if (hit && (Date.now() - (hit.ts || 0)) < this.cacheTtlMs) return hit;
      } catch (_) {}
    }
    // IDB fallback
    try {
      const rec = await idbGet(hash);
      if (rec && (Date.now() - (rec.ts || 0)) < this.cacheTtlMs) return rec;
    } catch (_) {}
    return null;
  }

  async _cache(prompt, hash, response) {
    const rec = { hash, prompt: prompt.slice(0, 2048), response, ts: Date.now() };
    if (this.cacheStore && typeof this.cacheStore.put === 'function') {
      try { await this.cacheStore.put(hash, rec); return; } catch (_) {}
    }
    try { await idbPut(rec); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────── stats + util ──
  _estTokens(text) { return Math.ceil((text || '').length / 4); }
  _record(tier, source, ms, promptLen) {
    this._stats[tier]++;
    const entry = { tier, source, ms: Math.round(ms), promptLen, at: Date.now() };
    this._stats.calls.unshift(entry);
    if (this._stats.calls.length > 100) this._stats.calls.pop();
    if (source === 'cache-local' || source === 'cache-mesh') {
      this._stats.tokensSaved += this._estTokens('x'.repeat(promptLen)) + 200;
    }
  }
  getStats() {
    const total = this._stats.T0 + this._stats.T2 + this._stats.T3;
    return {
      version: VERSION,
      total,
      T0: this._stats.T0,
      T2: this._stats.T2,
      T3: this._stats.T3,
      cacheHits: this._stats.cacheHits,
      cacheHitRate: total ? (this._stats.cacheHits / total) : 0,
      tokensSaved: this._stats.tokensSaved,
      recent: this._stats.calls.slice(0, 20)
    };
  }
  async listCache() { return await idbAll().catch(() => []); }
  setOauthToken(t) { this._oauthToken = t; } // no logging
  setMeshDeadline(ms) { this.meshDeadlineMs = Math.max(50, Math.min(2000, ms | 0)); }
  setCacheTtl(ms) { this.cacheTtlMs = Math.max(60000, ms | 0); }
}

export default SiDidyCascade;
export const version = VERSION;
