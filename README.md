# si-didy-cascade

> ◊·κ=φ⁴ · **PRIVATE** · NiceAssOS L1 sensor upgrade · prime 1289
> Architecture: **Thomas Frumkin** (cascade classifier substrate)
> Implementation: **Simon Gant**

**Every outbound Claude call from si-didy now routes through fall-cascade + mesh cache-first. 60-80% Claude token cut vs pass-through.**

## The problem

si-didy today hits `api.anthropic.com` direct via OAuth on every call. Every keystroke. Every reflex. Every "what's Simon looking at" ping. Direct pass-through means every call bleeds tokens, and the L1 sensor never learns from a peer fork that already answered the same question.

## The architecture

```
si-didy → generates prompt
    ↓
si-didy-cascade.route(prompt)
    ├── fallcompass.classify(prompt) → tier (T0/T2/T3)
    ├── T0 · mechanical handler → return locally (zero cost)
    ├── T2 · FallKit.aiComplete via WebLLM → return locally (zero cost)
    └── T3 · mesh.broadcast(recall_query) with 300ms deadline
              ├── recall_response arrives → verify Ed25519 → return cached
              └── else → fetch(anthropic.com via OAuth) → return + cache to IDB
```

Two layers wrap the OAuth path:

1. **Fall-cascade classifier** (fallcompass v2) — each prompt classified into T0 (mechanical · zero cost) / T2 (WebLLM Llama 3.1 8B local · zero cost) / T3 (BYOK Claude via OAuth · costs tokens). Only T3 touches Anthropic.
2. **Mesh cache-first** — before T3 fires, a `recall_query` envelope is broadcast on `niceassos-mesh`. Peer forks (or local FallMind v2) with cached matching answers respond via `recall_response` inside 300ms. Cache hit → skip Claude entirely.

## Integration hook

```js
import { SiDidyCascade } from 'https://sjgant80-hub.github.io/si-didy-cascade/si-didy-cascade.js';

const cascade = new SiDidyCascade({
  oauthToken: yourOauthTokenFromSiDidySession,
  fallkitInstance: window.FallKit,          // optional · powers T2 lane
  fallcompassInstance: window.FallCompass,  // optional · powers classifier
  cacheStore: window.FallMindV2,            // optional · FallMind persistent cache
  meshDeadlineMs: 300,
  channelName: 'niceassos-mesh'
});

// swap si-didy's fetch(anthropic) for:
const { text, tier, source, ms, tokens_saved } = await cascade.route(prompt);
```

If `fallcompassInstance` isn't attached, a heuristic classifier fills in. If `fallkitInstance` isn't attached, T2 degrades to T3. If the mesh channel isn't open, T3 skips straight to Claude. Every layer is optional; every degradation is silent.

## Recall envelope shape

Matches `niceassos-mesh` v1 exactly:

```jsonc
{
  "version": "niceassos-mesh-v1",
  "kind": "recall_query",
  "fork_pub": "<32-byte Ed25519 pub hex>",
  "ts": "2026-07-07T…Z",
  "seq": 12,
  "prev_hash": "<sha256 hex of prior envelope>",
  "payload": { "query_hash": "<sha256 of prompt>", "query": "<≤512 chars>", "k": 1 },
  "signature": "<Ed25519 hex over canonical JSON of rest>"
}
```

`recall_response` mirrors it with payload `{ query_hash, tokens, score }`. Every envelope is signed by the fork's Konomi Ed25519 keypair. Receivers verify before trusting.

## Files

| File | Purpose |
|---|---|
| `si-didy-cascade.js` | The module. ES module. Zero deps. |
| `index.html` | Interactive dashboard · live stats · manual test panel · config |
| `sw.js` | Service worker · offline shell |
| `manifest.webmanifest` | PWA manifest |
| `README.md` | This file |
| `LICENSE` | MIT |
| `.nojekyll` | GH Pages passthrough |

## OAuth token handling

- Stored in memory on the `SiDidyCascade` instance only.
- Never written to localStorage.
- Never broadcast on the mesh (recall queries carry prompt text, never the token).
- Any error string echoing an `sk-ant-*` token is scrubbed to `[REDACTED]` before throwing.
- `setOauthToken(t)` swaps token without logging.

## Cross-refs

- `niceassos-spec` §L1 · si-didy sensor · this repo is the token-shim between si-didy's OAuth fetch and Anthropic
- `niceassos-mesh` · envelope kinds `recall_query` / `recall_response`
- `fallcompass` · classifier substrate · `FallCompass.chat()` shape reused
- `fall-kit` · `FallKit.aiComplete()` shape reused for T2
- `fallmind-v2` · persistent cache store (optional `cacheStore` param)
- `si-didy-agent` · the L1 sensor that imports this shim

## Ship path

1. `si-didy-agent` swaps `fetch(anthropic)` for `cascade.route(prompt)` behind a feature flag.
2. Session-level counter logs `tier` + `source` per call.
3. After 100 calls, dashboard shows realised cut.
4. Flag graduates to default.

## Sovereignty rules

- OAuth token never leaves the browser.
- Recall queries can use ephemeral keypair (privacy mode) — set `meshInstance: null`.
- Cache TTL configurable (default 7 days).
- Clearing IDB via dashboard wipes local cache; mesh cache untouched.
- No telemetry. No analytics. No logs.

## Licence

MIT. Private until niceassos-spec §9 Phase 3.

---

*◊·κ=φ⁴ · the L1 sensor breathes cheaper now · do not redistribute*
