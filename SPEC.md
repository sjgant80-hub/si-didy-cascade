# si-didy-cascade — design note

Version: 1.0.0 (matches the `VERSION` constant exported by `si-didy-cascade.js`)
Status: Accepted

## Purpose

`si-didy-cascade` is a single-file ES module that sits between a caller and a
remote language-model HTTP endpoint. For each prompt it decides the *cheapest
lane that can answer correctly*, and only escalates to the paid remote call when
no cheaper lane applies. The goal is to cut remote token spend without changing
the caller's contract: `route(prompt)` returns text just like a direct call
would.

The module is browser-oriented (it uses `crypto.subtle`, `IndexedDB`, and
`BroadcastChannel`), but every lane degrades silently when its backing capability
is absent, so the pure classification/mechanical/accounting logic is exercisable
under plain Node with Web Crypto.

## Data model

### Tiers

Each prompt is classified into exactly one tier:

| Tier | Lane        | Cost    | Handled by                                   |
|------|-------------|---------|----------------------------------------------|
| T0   | mechanical  | zero    | `_runMechanical` — deterministic string ops  |
| T2   | local model | zero    | injected `fallkitInstance.aiComplete` (else falls to T3) |
| T3   | remote      | tokens  | cache lookup, then peer mesh, then remote HTTP |

Classification is delegated to an injected classifier when present; otherwise a
built-in heuristic is used:

- **T0** — the prompt begins with a mechanical verb (`echo`, `count`, `reverse`,
  `uppercase`, `lowercase`, `hash`, …) or is a short pure-arithmetic expression.
- **T2** — short (< 400 chars) and free of heavy-work keywords
  (`implement`, `debug`, `architect`, `design`, `analyse`, `refactor`, `deep`, `full`).
- **T3** — everything else.

### Recall envelope

Peer cache exchange uses a signed, hash-chained envelope (`ENVELOPE_VERSION =
"niceassos-mesh-v1"`):

```
{ version, kind, fork_pub, ts, seq, prev_hash, payload, signature }
```

- `kind` is `recall_query` or `recall_response`.
- `seq` increments once per envelope built by an instance.
- `prev_hash` is the SHA-256 of the previous envelope's canonical JSON, forming a
  per-instance chain (the first envelope's `prev_hash` is `null`).
- `signature` is an Ed25519 signature over the canonical JSON of every field
  except `signature`; empty string when Ed25519 is unavailable.
- `fork_pub` is the 32-byte identity public key, hex-encoded (64 hex chars).

## Invariants

1. **Deterministic classification.** Given the built-in heuristic, the same
   prompt always yields the same tier.
2. **Deterministic mechanical lane.** `_runMechanical` is a pure function of its
   input string; unmatched input yields `""`.
3. **Token accounting.** `_estTokens(text) === ceil(text.length / 4)`, null-safe
   (absent/empty input → 0).
4. **Bounded configuration.** `meshDeadlineMs` is clamped to `[50, 2000]`;
   `cacheTtlMs` is floored at `60000`.
5. **Canonical JSON is stable.** Object keys are serialised in sorted order, so
   the same logical value always hashes and signs identically.
6. **Envelope chain integrity.** `seq` is strictly monotonic per instance and
   each `prev_hash` equals the SHA-256 of the prior envelope's canonical form.
7. **No token leakage.** A T3 call without a configured credential rejects before
   any network I/O; any credential-shaped substring in an error is redacted.
8. **Silent degradation.** A missing classifier, local model, mesh channel, or
   IndexedDB store never throws to the caller — the lane falls through.

## Public API

- `new SiDidyCascade(opts)` — options: `oauthToken`, `fallkitInstance`,
  `fallcompassInstance`, `cacheStore`, `meshInstance`, `anthropicModel`,
  `anthropicMaxTokens`, `meshDeadlineMs`, `cacheTtlMs`, `channelName`.
- `route(prompt, opts) -> { text, tier, source, ms, tokens_saved }` — the main
  entry point.
- `getStats() -> { version, total, T0, T2, T3, cacheHits, cacheHitRate,
  tokensSaved, recent }`.
- `listCache()`, `setOauthToken(t)`, `setMeshDeadline(ms)`, `setCacheTtl(ms)`.
- Module exports: `SiDidyCascade` (named + default) and `version`.

## Determinism & testing

The classification, mechanical, token-accounting, configuration-clamping, and
envelope-chaining logic are fully deterministic and are covered by `test.mjs`,
which imports the module directly and asserts on observed return values. Lanes
that require the remote endpoint or a browser store are not exercised in CI;
their guard conditions (e.g. the missing-credential rejection) are.

## Versioning

The module's behavioural version is the `VERSION` constant (`1.0.0`) and
`ENVELOPE_VERSION` (`niceassos-mesh-v1`). A change to the envelope shape or to a
tier's classification contract is a breaking change and must bump the relevant
constant.
