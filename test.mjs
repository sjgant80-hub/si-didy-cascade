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
