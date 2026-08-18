/* test.mjs · behavioural test suite for si-didy-cascade
 *
 * Every assertion below was derived by importing the real module, calling the
 * real method, and observing the real return value under Node's webcrypto.
 * No stubs, no mocks, no tautologies. A failure exits non-zero.
 *
 * Run: node test.mjs   (relative import resolves from this file, cwd-independent)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import SiDidyCascadeDefault, { SiDidyCascade, version } from './si-didy-cascade.js';

// The class opens a BroadcastChannel in _init(). Track every instance so the
// suite can release those handles and let the process exit cleanly.
const live = [];
async function mk(opts = {}) {
  const c = new SiDidyCascade(opts);
  await c._ready;                              // key generation + channel setup settle here
  if (c._channel && typeof c._channel.unref === 'function') c._channel.unref();
  live.push(c);
  return c;
}
after(() => {
  for (const c of live) {
    try { c._channel && c._channel.close && c._channel.close(); } catch { /* already closed */ }
  }
});

test('module surface: named, default, and version exports agree', () => {
  assert.equal(version, '1.0.0');
  assert.equal(typeof SiDidyCascade, 'function');
  assert.equal(SiDidyCascadeDefault, SiDidyCascade);
});

test('_estTokens is ceil(length / 4)', async () => {
  const c = await mk();
  assert.equal(c._estTokens('abcd'), 1);       // 4 / 4
  assert.equal(c._estTokens('abcde'), 2);      // 5 / 4 -> ceil
  assert.equal(c._estTokens(''), 0);
  assert.equal(c._estTokens('x'.repeat(400)), 100);
  assert.equal(c._estTokens(undefined), 0);    // null-safe path
});

test('setMeshDeadline clamps into [50, 2000]', async () => {
  const c = await mk();
  c.setMeshDeadline(10);
  assert.equal(c.meshDeadlineMs, 50);          // below floor -> floor
  c.setMeshDeadline(5000);
  assert.equal(c.meshDeadlineMs, 2000);        // above ceiling -> ceiling
  c.setMeshDeadline(300);
  assert.equal(c.meshDeadlineMs, 300);         // in range -> unchanged
});

test('setCacheTtl floors at 60000ms', async () => {
  const c = await mk();
  c.setCacheTtl(1000);
  assert.equal(c.cacheTtlMs, 60000);           // below floor -> floor
  c.setCacheTtl(120000);
  assert.equal(c.cacheTtlMs, 120000);          // above floor -> unchanged
});

test('heuristic classifier maps prompts to tiers', async () => {
  const c = await mk();
  assert.equal(await c._classify('echo hi'), 'T0');                 // mechanical verb
  assert.equal(await c._classify('2 + 3'), 'T0');                   // short arithmetic
  assert.equal(await c._classify('hello there'), 'T2');             // short generative
  assert.equal(await c._classify('implement a refactor of the whole design deep'), 'T3'); // heavy keyword
});

test('mechanical handlers return exact deterministic results', async () => {
  const c = await mk();
  assert.equal(c._runMechanical('echo hello world'), 'hello world');
  assert.equal(c._runMechanical('count hello'), '5');              // length of "hello"
  assert.equal(c._runMechanical('reverse abc'), 'cba');
  assert.equal(c._runMechanical('uppercase abc'), 'ABC');
  assert.equal(c._runMechanical('lowercase ABC'), 'abc');
  assert.equal(c._runMechanical('2 + 3'), '5');                    // arithmetic eval
  assert.equal(c._runMechanical('(2+3)*4'), '20');
  assert.equal(c._runMechanical('hello'), '');                     // no handler matches
});

test('route() resolves a T0 prompt with token accounting', async () => {
  const c = await mk();
  const r = await c.route('echo hello world');
  assert.equal(r.text, 'hello world');
  assert.equal(r.tier, 'T0');
  assert.equal(r.source, 'mechanical');
  assert.equal(r.tokens_saved, 4);             // ceil(16 chars / 4)
  assert.ok(r.ms >= 0);
});

test('route() evaluates arithmetic through the T0 lane', async () => {
  const c = await mk();
  const r = await c.route('2 + 3');
  assert.equal(r.text, '5');
  assert.equal(r.tier, 'T0');
  assert.equal(r.source, 'mechanical');
  assert.equal(r.tokens_saved, 2);             // ceil(5 chars / 4)
});

test('route() treats empty and whitespace prompts as a no-op', async () => {
  const c = await mk();
  const r = await c.route('');
  assert.equal(r.source, 'noop');
  assert.equal(r.text, '');
  assert.equal(r.tokens_saved, 0);
  assert.equal(r.ms, 0);
  const r2 = await c.route('   ');
  assert.equal(r2.source, 'noop');
});

test('getStats() aggregates routed calls', async () => {
  const c = await mk();
  await c.route('echo a');
  await c.route('echo b');
  const s = c.getStats();
  assert.equal(s.version, '1.0.0');
  assert.equal(s.total, 2);
  assert.equal(s.T0, 2);
  assert.equal(s.T2, 0);
  assert.equal(s.T3, 0);
  assert.equal(s.cacheHits, 0);
  assert.equal(s.cacheHitRate, 0);
  assert.equal(s.recent.length, 2);
});

test('_callClaude rejects when no OAuth token is configured', async () => {
  const c = await mk();
  await assert.rejects(() => c._callClaude('hi'), /no oauthToken configured/);
});

test('_buildEnvelope produces a hash-chained, signed envelope sequence', async () => {
  const c = await mk();
  const e1 = await c._buildEnvelope('recall_query', { query_hash: 'h', k: 1 });
  assert.equal(e1.version, 'niceassos-mesh-v1');
  assert.equal(e1.kind, 'recall_query');
  assert.equal(e1.seq, 1);
  assert.equal(e1.prev_hash, null);            // first envelope has no predecessor
  assert.match(e1.fork_pub, /^[0-9a-f]{64}$/); // 32-byte identity, hex
  assert.deepEqual(e1.payload, { query_hash: 'h', k: 1 });
  assert.equal(typeof e1.signature, 'string');

  const linkHash = c._prevHash;                // hash the next envelope must reference
  assert.match(linkHash, /^[0-9a-f]{64}$/);

  const e2 = await c._buildEnvelope('recall_response', { query_hash: 'h', tokens: 't' });
  assert.equal(e2.seq, 2);                      // monotonic sequence
  assert.equal(e2.prev_hash, linkHash);        // e2 links back to e1's canonical hash
});


// ─────────────────────────────────────────────────────────────────────────────
// The boundaries the mutation gate proved nothing was holding (estate bring-up).
// Everything below is deterministic: fetch, Date.now, Date, and indexedDB are
// stubbed per-test and restored in finally — no network, no real clock races.
// ─────────────────────────────────────────────────────────────────────────────

const withFetch = async (fake, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const withNow = async (ms, fn) => {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
};
const withIDB = async (idb, fn) => {
  globalThis.indexedDB = idb;
  try { return await fn(); } finally { delete globalThis.indexedDB; }
};

/** The smallest IndexedDB honouring THIS module's shape: keyPath records, tx.oncomplete. */
function fakeVaultIDB(seed = []) {
  const data = new Map(seed.map(r => [r.hash, r]));
  const req = (result) => { const r = { result }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; };
  return {
    _data: data,
    open() {
      const r = {};
      queueMicrotask(() => {
        r.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = {
              objectStore: () => ({
                get: (h) => req(data.get(h)),
                put: (rec) => { data.set(rec.hash, rec); },
                getAll: () => req([...data.values()]),
              }),
            };
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete && tx.oncomplete()));
            return tx;
          },
        };
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
}

const okJson = (body) => async (url, init) => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('EVERY CONSTRUCTOR SEAT HOLDS WHAT WAS GIVEN — sixteen || fallbacks, each killable alone', async () => {
  const given = {
    meshInstance: { m: 1 }, fallcompassInstance: { f: 1 }, fallkitInstance: { k: 1 },
    cacheStore: { c: 1 }, oauthToken: 'tok', anthropicModel: 'm-x', anthropicMaxTokens: 7,
    meshDeadlineMs: 123, cacheTtlMs: 61000, fallcompassEndpoint: 'E', channelName: 'seat-' + Math.random(),
    ollamaHost: 'H', ollamaModel: 'OM', ollamaTimeoutMs: 9, ollamaEnabled: false,
  };
  const c = await mk(given);
  assert.strictEqual(c.meshInstance, given.meshInstance);
  assert.strictEqual(c.fallcompassInstance, given.fallcompassInstance);
  assert.strictEqual(c.fallkitInstance, given.fallkitInstance);
  assert.strictEqual(c.cacheStore, given.cacheStore);
  assert.equal(c._oauthToken, 'tok');
  assert.equal(c.anthropicModel, 'm-x');
  assert.equal(c.anthropicMaxTokens, 7);
  assert.equal(c.meshDeadlineMs, 123);
  assert.equal(c.cacheTtlMs, 61000);
  assert.equal(c.fallcompassEndpoint, 'E');
  assert.equal(c.channelName, given.channelName);
  assert.equal(c.ollamaHost, 'H');
  assert.equal(c.ollamaModel, 'OM');
  assert.equal(c.ollamaTimeoutMs, 9);
  assert.equal(c.ollamaEnabled, false, 'ollamaEnabled: false was not honoured');

  const d = await mk({ channelName: 'seat-d-' + Math.random() });
  assert.strictEqual(d.meshInstance, null);
  assert.strictEqual(d.cacheStore, null);
  assert.strictEqual(d._oauthToken, null);
  assert.equal(d.anthropicModel, 'claude-opus-4-7');
  assert.equal(d.anthropicMaxTokens, 1024);
  assert.equal(d.meshDeadlineMs, 300);
  assert.equal(d.cacheTtlMs, 1000 * 60 * 60 * 24 * 7);
  assert.equal(d.ollamaHost, 'http://localhost:11434');
  assert.equal(d.ollamaModel, 'qwen2.5:7b');
  assert.equal(d.ollamaTimeoutMs, 120000);
  assert.equal(d.ollamaEnabled, true, 'local-first must default ON');
});

test('CANONICALIZATION IS KEY-ORDER-BLIND AND NULL-SAFE — two insertion orders, one hash', async () => {
  // The envelope chain hashes canonicalize(base). If object keys serialize in insertion order,
  // two forks of the same history hash apart and the chain silently splits. And prev_hash starts
  // life as null — a canonicalizer that cannot take null throws on the very first envelope.
  const c1 = await mk({ channelName: 'canon1-' + Math.random() });
  const c2 = await mk({ channelName: 'canon2-' + Math.random() });
  c1.forkPub = c2.forkPub = 'PUB';
  c1.forkPriv = c2.forkPriv = null;
  c1._seq = c2._seq = 0;
  c1._prevHash = c2._prevHash = null;
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { toISOString() { return '2026-01-01T00:00:00.000Z'; } };
  try {
    await c1._buildEnvelope('k', { b: 1, a: 1 });
    await c2._buildEnvelope('k', { a: 1, b: 1 });
  } finally { globalThis.Date = RealDate; }
  assert.equal(c1._prevHash, c2._prevHash, 'key order leaked into the canonical hash');
});

test('A REAL KEY SIGNS FOR REAL — the envelope signature is 64 bytes of Ed25519, not a shrug', async () => {
  const c = await mk({ channelName: 'sig-' + Math.random() });
  const e = await c._buildEnvelope('recall_query', { query_hash: 'h' });
  assert.match(e.signature, /^[0-9a-f]{128}$/, 'the envelope went out unsigned');
});

test('CLASSIFIER LENGTH GATES ARE EXCLUSIVE — 39 is short arithmetic, 40 is not; 399 is T2, 400 is not', async () => {
  const c = await mk({ channelName: 'cls-' + Math.random() });
  const a39 = '1+'.repeat(19) + '1';        // 39 chars of pure arithmetic
  const a40 = '1+'.repeat(19) + '11';       // 40 chars — one past the gate
  assert.equal(a39.length, 39); assert.equal(a40.length, 40);
  assert.equal(await c._classify(a39), 'T0');
  assert.equal(await c._classify(a40), 'T2', 'the < 40 gate admitted its own boundary');
  assert.equal(await c._classify('x'.repeat(399)), 'T2');
  assert.equal(await c._classify('x'.repeat(400)), 'T3', 'the < 400 gate admitted its own boundary');
});

test('AN INJECTED CLASSIFIER IS BELIEVED — and an empty tier from it is NOT', async () => {
  // fallcompass says T3 for a prompt the heuristic would call T2: the injected answer must win.
  const hit = { response: 'cached-answer', ts: Date.now() };
  const c = await mk({
    channelName: 'fc1-' + Math.random(),
    fallcompassInstance: { classify: () => ({ tier: 'T3' }) },
    cacheStore: { get: () => hit },
  });
  const r = await c.route('hello there');
  assert.equal(r.source, 'cache-local', 'the injected T3 classification was ignored');
  assert.equal(r.text, 'cached-answer');

  // a classifier that answers { tier: '' } has NOT classified — fall to the heuristic (T2)
  const c2 = await mk({
    channelName: 'fc2-' + Math.random(),
    fallcompassInstance: { classify: () => ({ tier: '' }) },
    fallkitInstance: { aiComplete: () => 'webllm-answer' },
  });
  const r2 = await c2.route('hello there');
  assert.equal(r2.source, 'webllm', 'an empty tier string was routed as a real tier');
});

test('T2 ROUTES THROUGH WEBLLM WITH EXACT DEFAULTS — system prompt and token cap land verbatim', async () => {
  const calls = [];
  const c = await mk({
    channelName: 'wl-' + Math.random(),
    fallkitInstance: { aiComplete: (sys, p, max) => { calls.push([sys, p, max]); return 'webllm-answer'; } },
  });
  const r = await c.route('hello there');
  assert.equal(r.tier, 'T2');
  assert.equal(r.source, 'webllm');
  assert.equal(r.text, 'webllm-answer');
  assert.deepEqual(calls[0], ['You are a concise assistant.', 'hello there', 512]);
  await c.route('hello again', { system: 'S', maxTokens: 9 });
  assert.deepEqual(calls[1], ['S', 'hello again', 9]);
  assert.equal(c.getStats().T2, 2);
});

test('NO WEBLLM MEANS THE HONEST DEGRADE — the T3 refusal, not a crash on a null instance', async () => {
  const c = await mk({ channelName: 'wl2-' + Math.random() });
  await assert.rejects(() => c._runWebLLM('hello there', {}), /no oauthToken configured/,
    'the degrade path did not reach the T3 guard');
});

test('OLLAMA DISABLED OR noLocal MEANS NO CALL AT ALL — declined before fetch, not after', async () => {
  let fetches = 0;
  await withFetch(async () => { fetches++; return { ok: true, json: async () => ({ response: 'x' }) }; }, async () => {
    const off = await mk({ channelName: 'ol0-' + Math.random(), ollamaEnabled: false });
    assert.strictEqual(await off._tryOllama('p'), null);
    const on = await mk({ channelName: 'ol1-' + Math.random() });
    assert.strictEqual(await on._tryOllama('p', { noLocal: true }), null);
    assert.equal(fetches, 0, 'a declined local call still reached the network');
  });
});

test('OLLAMA ANSWERS ARE TRIMMED, EMPTY IS DECLINED, AND THE MODEL SEAT IS EXACT', async () => {
  const seen = [];
  const fake = (body) => async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, json: async () => body }; };
  const c = await mk({ channelName: 'ol2-' + Math.random() });
  await withFetch(fake({ response: '  hi  ' }), async () => {
    assert.equal(await c._tryOllama('p'), 'hi');
    assert.equal(seen[0].model, 'qwen2.5:7b', 'the default model was not used');
    assert.equal(await c._tryOllama('p', { ollamaModel: 'other:1b' }), 'hi');
    assert.equal(seen[1].model, 'other:1b', 'the per-call model override was ignored');
  });
  await withFetch(fake({ response: '' }), async () => {
    assert.strictEqual(await c._tryOllama('p'), null, 'an empty answer must DECLINE, not return ""');
  });
  await withFetch(async () => ({ ok: false, json: async () => ({ response: 'SHOULD NOT SURFACE' }) }), async () => {
    assert.strictEqual(await c._tryOllama('p'), null, 'a non-ok response was read anyway');
  });
});

test('probeLocal REPORTS HONESTLY — up with the real model list, down as down', async () => {
  const c = await mk({ channelName: 'pr-' + Math.random() });
  await withFetch(okJson({ models: [{ name: 'qwen2.5:7b' }, { name: 'other' }] }), async () => {
    const p = await c.probeLocal();
    assert.deepEqual(p, { up: true, models: ['qwen2.5:7b', 'other'], hasModel: true });
  });
  await withFetch(async () => ({ ok: false, json: async () => ({ models: [{ name: 'ghost' }] }) }), async () => {
    const p = await c.probeLocal();
    assert.deepEqual(p, { up: false, models: [], hasModel: false }, 'a down host was reported up');
  });
});

test('MESH ROUND-TRIP — one fork asks, the other serves from its cache, signed and verified', async () => {
  const H = 'deadbeef'.repeat(8);
  await withIDB(fakeVaultIDB([{ hash: H, response: 'from-mesh', ts: Date.now() }]), async () => {
    const ch = 'rt-' + Math.random();
    const c1 = await mk({ channelName: ch, meshDeadlineMs: 1500 });
    await mk({ channelName: ch });
    const hit = await c1._queryMesh('the prompt', H);
    assert.ok(hit, 'the mesh answer never arrived');
    assert.equal(hit.tokens, 'from-mesh');
    assert.equal(hit.query_hash, H);
  });
});

test('AN UNSIGNED PEER IS STILL HEARD — unverified-but-allowed, only a FAILED verify blocks', async () => {
  const H = 'cafebabe'.repeat(8);
  await withIDB(fakeVaultIDB([{ hash: H, response: 'unsigned-answer', ts: Date.now() }]), async () => {
    const ch = 'un-' + Math.random();
    const c1 = await mk({ channelName: ch, meshDeadlineMs: 1500 });
    const c2 = await mk({ channelName: ch });
    c2.forkPriv = null;  // its envelopes go out with signature '' — unverified, not invalid
    const hit = await c1._queryMesh('the prompt', H);
    assert.ok(hit, 'an unsigned envelope was treated as a forged one');
    assert.equal(hit.tokens, 'unsigned-answer');
  });
});

test('GARBAGE ON THE MESH IS IGNORED WITHOUT A CRASH', async () => {
  const c = await mk({ channelName: 'gb-' + Math.random() });
  await c._onMeshMessage(null);
  await c._onMeshMessage(undefined);
  await c._onMeshMessage({ version: 'wrong-version', kind: 'recall_response' });
  assert.ok(true);
});

test('THE CLAUDE CALL SENDS EXACTLY WHAT WAS CONFIGURED — model, cap, bearer; and parses defensively', async () => {
  const seen = [];
  const fake = (body) => async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => body }; };
  const c = await mk({ channelName: 'cl-' + Math.random(), oauthToken: 'tok-123', anthropicModel: 'm-conf', anthropicMaxTokens: 77 });
  await withFetch(fake({ content: [{ text: 'claude-says' }] }), async () => {
    const t = await c._callClaude('p');
    assert.strictEqual(t, 'claude-says');
    assert.equal(seen[0].body.model, 'm-conf');
    assert.equal(seen[0].body.max_tokens, 77);
    assert.equal(seen[0].init.headers['Authorization'], 'Bearer tok-123');
    const t2 = await c._callClaude('p', { model: 'm-call', maxTokens: 5 });
    assert.equal(seen[1].body.model, 'm-call');
    assert.equal(seen[1].body.max_tokens, 5);
    assert.equal(t2, 'claude-says');
  });
  await withFetch(fake({}), async () => {
    assert.strictEqual(await c._callClaude('p'), '', 'an empty response body must yield "", not a crash');
  });
  await withFetch(fake({ content: [] }), async () => {
    assert.strictEqual(await c._callClaude('p'), '');
  });
});

test('AN API ERROR NEVER ECHOES A TOKEN — scrubbed to [REDACTED] before it can be logged', async () => {
  const c = await mk({ channelName: 'sc-' + Math.random(), oauthToken: 'tok' });
  await withFetch(async () => ({ ok: false, status: 500, text: async () => 'upstream said sk-ant-SECRET123 invalid' }), async () => {
    await assert.rejects(() => c._callClaude('p'), (e) => {
      assert.match(e.message, /\[REDACTED\]/);
      assert.ok(!e.message.includes('SECRET123'), 'the raw token leaked into the error');
      return true;
    });
  });
});

test('THE CACHE TTL BOUNDARY IS EXCLUSIVE — a record EXACTLY ttl old is expired, a stale one never serves', async () => {
  const NOW = 1_000_000_000_000;
  const claude = okJson({ content: [{ text: 'fresh-answer' }] });
  // exactly ttl old → expired → the route must go all the way to Claude
  const ttl = 60000;
  const c = await mk({
    channelName: 'ttl-' + Math.random(), meshDeadlineMs: 60, ollamaEnabled: false,
    oauthToken: 'tok', cacheTtlMs: ttl,
    cacheStore: { get: () => ({ response: 'EXPIRED', ts: NOW - ttl }) },
  });
  await withNow(NOW, () => withFetch(claude, async () => {
    const r = await c.route('anything', { forceTier: 'T3' });
    assert.equal(r.source, 'claude', 'a record exactly ttl old was served from cache');
    assert.equal(r.text, 'fresh-answer');
  }));
  // fresh → served, with the hit counted
  const c2 = await mk({
    channelName: 'ttl2-' + Math.random(), cacheTtlMs: ttl,
    cacheStore: { get: () => ({ response: 'cached-answer', ts: NOW - 1000 }) },
  });
  await withNow(NOW, async () => {
    const r = await c2.route('anything', { forceTier: 'T3' });
    assert.equal(r.source, 'cache-local');
    assert.equal(r.text, 'cached-answer');
    assert.equal(c2.getStats().cacheHits, 1);
  });
});

test('THE IDB FALLBACK ROUND-TRIPS AND EXPIRES THE SAME WAY — and listCache sees what was put', async () => {
  const NOW = 2_000_000_000_000;
  await withIDB(fakeVaultIDB(), async () => {
    const c = await mk({ channelName: 'idb-' + Math.random(), cacheTtlMs: 60000 });
    await withNow(NOW, async () => {
      await c._cache('the prompt', 'H1', 'stored-answer');
      const rec = await c._checkLocalCache('H1');
      assert.ok(rec, 'the IDB record was not found');
      assert.equal(rec.response, 'stored-answer');
    });
    await withNow(NOW + 60000, async () => {
      assert.strictEqual(await c._checkLocalCache('H1'), null, 'a record exactly ttl old was served');
    });
    const all = await c.listCache();
    assert.equal(all.length, 1);
    assert.equal(all[0].hash, 'H1');
  });
});

test('THE STATS RING HOLDS EXACTLY 100 — the hundredth call is kept, the hundred-and-first evicts one', async () => {
  const c = await mk({ channelName: 'ring-' + Math.random() });
  for (let i = 0; i < 100; i++) c._record('T3', 'claude', 1, 4);
  assert.equal(c._stats.calls.length, 100, 'the ring evicted its own boundary');
  c._record('T3', 'claude', 1, 4);
  assert.equal(c._stats.calls.length, 100);
});

test('TOKENS ARE SAVED ONLY BY CACHE SOURCES — a paid claude call saves nothing', async () => {
  const c = await mk({ channelName: 'ts-' + Math.random() });
  c._record('T3', 'claude', 1, 8);
  assert.equal(c._stats.tokensSaved, 0, 'a paid call was counted as savings');
  c._record('T3', 'cache-local', 1, 8);
  assert.equal(c._stats.tokensSaved, 202);            // ceil(8/4) + 200
  c._record('T3', 'cache-mesh', 1, 8);
  assert.equal(c._stats.tokensSaved, 404, 'a mesh cache hit did not count as savings');
});


test('_cache PREFERS THE INJECTED STORE — put is called, and IDB is never touched when it works', async () => {
  const puts = [];
  const c = await mk({
    channelName: 'put-' + Math.random(),
    cacheStore: { put: (h, rec) => { puts.push([h, rec]); } },
  });
  await c._cache('the prompt', 'HX', 'answer');
  assert.equal(puts.length, 1, 'the injected store was skipped');
  assert.equal(puts[0][0], 'HX');
  assert.equal(puts[0][1].response, 'answer');
  assert.equal(puts[0][1].prompt, 'the prompt');
});

test('THE MESH HANDLER KIND GUARDS ARE EXACT — a response is never served, an absent hash is silence', async () => {
  const H = 'ab'.repeat(32);
  await withIDB(fakeVaultIDB([{ hash: H, response: 'held-answer', ts: Date.now() }]), async () => {
    const c = await mk({ channelName: 'kg-' + Math.random() });
    const posts = [];
    c._channel.close();
    c._channel = { postMessage: m => posts.push(m), close() {} };
    // a RESPONSE arriving must never be treated as a query to serve
    await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_response', payload: { query_hash: H } });
    assert.equal(posts.length, 0, 'a response was answered as if it were a query');
    // a QUERY for a hash we do not hold answers nothing, quietly
    await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_query', payload: { query_hash: 'cd'.repeat(32) } });
    assert.equal(posts.length, 0, 'an absent hash produced an answer');
    // a QUERY for a held hash answers exactly once
    await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_query', payload: { query_hash: H } });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'recall_response');
    assert.equal(posts[0].payload.tokens, 'held-answer');
  });
});

test('A RESPONSE FOR NOBODY, OR WITH NO PAYLOAD, RESOLVES QUIETLY — never a crash in the handler', async () => {
  const c = await mk({ channelName: 'rn-' + Math.random() });
  await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_response', payload: { query_hash: '0'.repeat(64) } });
  await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_response', payload: null });
  await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_query', payload: null });
  assert.ok(true);
});

test('A QUERY ON THE WIRE NEVER RESOLVES A PENDING ASK — only a response answers', async () => {
  const H = 'ef'.repeat(32);
  const c = await mk({ channelName: 'pq-' + Math.random(), meshDeadlineMs: 60 });
  c._channel.close();
  c._channel = { postMessage() {}, close() {} };
  const p = c._queryMesh('prompt', H);
  await c._onMeshMessage({ version: 'niceassos-mesh-v1', kind: 'recall_query', payload: { query_hash: H, query: 'x' } });
  assert.strictEqual(await p, null, 'a QUERY envelope was mistaken for an answer');
});
