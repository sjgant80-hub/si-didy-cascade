# CLAUDE.md — working notes for agents

## What this is

`si-didy-cascade` is a zero-dependency ES module (`si-didy-cascade.js`) exposing
one class, `SiDidyCascade`. It routes each prompt through the cheapest lane that
can answer it (T0 mechanical → T2 local model → T3 remote), serving cache-first
before any remote call. See `SPEC.md` for the full data model and invariants.

Entry point: `route(prompt, opts) -> { text, tier, source, ms, tokens_saved }`.

## Invariants to preserve

When changing `si-didy-cascade.js`, keep these true (they are asserted in
`test.mjs`):

1. `_estTokens(text) === ceil(text.length / 4)`, and is null-safe (→ 0).
2. `setMeshDeadline` clamps to `[50, 2000]`; `setCacheTtl` floors at `60000`.
3. The heuristic classifier is deterministic: mechanical verbs and short
   arithmetic → `T0`; short non-heavy prompts → `T2`; otherwise `T3`.
4. `_runMechanical` is a pure function; unmatched input returns `""`.
5. `route('')` and whitespace-only prompts return `source: 'noop'` with
   `tokens_saved: 0` and never touch a lane.
6. Envelopes are hash-chained: `seq` is strictly monotonic per instance and each
   `prev_hash` is the SHA-256 of the previous envelope's canonical JSON; the
   first envelope's `prev_hash` is `null`.
7. A T3 call with no configured credential rejects *before* any network I/O, and
   error strings never echo a raw credential.
8. Missing classifier / local model / mesh channel / IndexedDB must degrade
   silently, never throw to the caller.

If you add or change a tier's classification contract or the envelope shape, bump
`VERSION` / `ENVELOPE_VERSION` and update `SPEC.md`.

## How to run the tests

```
npm test
```

which runs `node test.mjs`. The suite imports the module directly and asserts on
real return values. It needs only Node 20+ with Web Crypto (no browser, no
network); lanes that require the remote endpoint or IndexedDB are not exercised,
only their guard conditions. A failing assertion exits non-zero.

## Boundaries

- Do not commit real OAuth tokens or credentials; they live in instance memory
  only and are passed at construction time.
- The mesh (`BroadcastChannel`) and cache (`IndexedDB`) are same-machine only.
