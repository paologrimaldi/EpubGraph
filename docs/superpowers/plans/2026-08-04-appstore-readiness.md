# EpubGraph → Mac App Store Readiness Plan

**Date:** 2026-08-04
**Status:** Draft for review — plan only, no implementation yet
**Inputs:** three audits in `docs/superpowers/audits/` (Rust backend, frontend/packaging, local-LLM research — the research is web-verified as of Aug 2026, with sources)

---

## 1. Goal

Ship EpubGraph as a sandboxed, self-contained Mac App Store app: no Ollama
dependency (bundled local inference for embeddings + chat), library folders that
survive relaunches under the App Sandbox, and a clean signing/submission
pipeline. Direct distribution (notarized DMG) ships first as a de-risking
milestone on the same foundations.

### Non-goals (v1)

- iOS/iPadOS. Windows/Linux packaging changes.
- Apple Foundation Models integration (macOS 26+, Apple Silicon only, no
  embeddings API, requires a Swift/XPC bridge with known Tauri signing
  hazards). Revisit as a v2 chat backend.
- Streaming chat UX (the one chat use is a short cached explanation blurb).

---

## 2. Audit verdict (what actually blocks MAS today)

| # | Blocker | Where | Fix |
|---|---|---|---|
| 1 | Library folder paths stored as raw strings; every scan/read/watch/delete re-touches them across launches with no security-scoped bookmarks — dies on second launch under sandbox | `commands/library.rs:59-61` + all consumers (`library.rs`, `books.rs`) | Phase A bookmarks module |
| 2 | `std::process::Command::new("open")` — sandboxed apps can't exec | `commands/mod.rs:13` | Use `tauri-plugin-shell` open (already granted) |
| 3 | No entitlements / Info.plist / signing config at all | `tauri.conf.json` macOS block | Phase C |
| 4 | Capabilities grant fs read `**` / write `$HOME/**` | `capabilities/default.json:30-46` | Tighten in Phase A |
| 5 | `trash::delete()` on unbookmarked paths | `commands/books.rs:117-133,183` | Covered by bookmarks module |
| 6 | Ollama required for Discover / Book Graph / similar-books / explanations | `ollama/mod.rs`, `commands/ollama.rs`, `recommendations.rs` | Phase B bundled inference |

Frontend is already MAS-friendly: zero telemetry/fetches/accounts (true
**"No Data Collected"** privacy label), dialog plugin used correctly, and two
plugins (`notification`, JS-side `fs`) are dead weight to remove. Known
leftovers to clean at packaging time: `/dev/shelf` + `/dev/textures` routes,
stale "alexandria" export filenames in Settings.

**Current Ollama surface being replaced:** embeddings `POST /api/embeddings`
with `qwen3-embedding:8b` truncated to **2048 dims**; generation
`POST /api/generate` with `mistral:7b` for (a) book summaries that feed
embeddings and (b) the BookDetail "why recommended" blurb (frontend caches it
in localStorage 7 days). Changing the embedding model ⇒ **full library
re-embed** (the migration is designed in Phase B).

---

## 3. Architecture decisions

**D1 — One inference runtime: `llama-cpp-2` (llama.cpp Rust bindings, GGUF, Metal).**
Weekly-released crate; llama.cpp's Metal backend runs inside the App Sandbox
with a plain entitlements file — proven by a shipping MAS app (Noema, see
research report). One runtime serves both embeddings and chat. On Intel Macs it
falls back to CPU (slower but functional; embeddings batch overnight, chat is
one short blurb). Alternatives (candle, mlx-rs, mistral.rs, Swift sidecar) are
scored in the research doc; all lose on maturity, sandbox risk, or the missing
embeddings path.

**D2 — Models (both Apache 2.0, redistribution-safe):**
- Embeddings: **IBM Granite Embedding 311M Multilingual R2** (~253MB GGUF,
  768 dims, strong Spanish — the library is Spanish-heavy).
- Chat: **Qwen3-1.7B instruct** (~1.1GB GGUF Q4) — ample for summary +
  explanation prose on 8GB machines.

**D3 — Delivery: post-first-run download, not bundled.** ~1.4GB in-bundle would
bloat every app update. Apple explicitly permits post-install content downloads
with user consent (Guideline 4.2.3(ii)). Resumable (HTTP Range) downloads into
the app container (`Application Support/epub-graph/models/`), with a consent
card, progress UI, and integrity check (SHA256). The app stays fully usable
without models — exactly like today's "Ollama Offline" degradation.

**D4 — `InferenceBackend` trait; Ollama survives as an opt-in "Advanced"
backend.** `trait InferenceBackend { async fn embed(&self, texts) -> Vec<Vec<f32>>;
async fn generate(&self, prompt, opts) -> String; fn id(&self) -> &str; }`
with `LlamaCppBackend` (default) and the existing Ollama client refactored to
implement it (localhost networking is sandbox-legal with `network-client`).
Power users keep their setup; App Review sees a fully self-contained default.

**D5 — Hand-rolled security-scoped bookmarks via `objc2`.** No Tauri support
exists (4-year-old open issue; `persisted-scope` remembers paths, not sandbox
access). A small `bookmarks` module wraps `NSURL bookmarkDataWithOptions:
NSURLBookmarkCreationWithSecurityScope` / `startAccessingSecurityScopedResource`,
compiled on macOS only (no-op elsewhere).

**D6 — DMG before MAS.** Developer ID + notarization has no sandbox
requirement and exercises the whole signing pipeline; it becomes the always-
working distribution channel while the two live Tauri MAS signing bugs (see
Phase C) are worked around.

---

## 4. Phases

### Phase A — Sandbox foundations (est. 3–5 days)

*Everything here is correct and testable even before sandboxing is enforced;
the acceptance gate is a locally signed sandboxed build.*

**A1. `src-tauri/src/platform/bookmarks.rs`** (new, macOS-gated via `objc2` +
`objc2-foundation`): `create_bookmark(path) -> Vec<u8>`,
`resolve_bookmark(bytes) -> (PathBuf, StaleFlag)`,
`ScopedAccess` RAII guard (`start/stopAccessingSecurityScopedResource`).
Unit-testable on macOS dev machines without sandbox (APIs work unsandboxed).

**A2. Schema migration v5:** `libraries.bookmark BLOB NULL` (+ same for any
other persisted external path — audit found only libraries). On folder pick
(`commands/library.rs:59-61`): create bookmark alongside path. On app start /
library access: resolve bookmark → refresh if stale (re-store), hold
`ScopedAccess` for the operation's duration. Wrap the access points found in
the audit: scan (`library.rs:104-198`), book file reads + cover extraction
(`books.rs:95-266`), watcher registration (`library.rs:337-367`), trash delete
(`books.rs:117-133,183`), Calibre `metadata.db` reads. Missing/unresolvable
bookmark → surface a per-library "Re-authorize folder access" UI state (one
click → folder picker pre-aimed at the old path).

**A3. Kill the exec:** replace `Command::new("open")` (`commands/mod.rs:13`)
with the shell plugin's `open()` (capability `shell:allow-open` already
granted).

**A4. Plugin + capability diet:** remove `tauri-plugin-notification` (zero call
sites) and JS-side `fs` plugin registration (Rust does all I/O); tighten
`capabilities/default.json` to: dialog, shell-open, core — no fs `**` scopes.

**A5. Sandbox smoke gate:** a dev entitlements plist (app-sandbox +
user-selected read-write + bookmarks.app-scope) and a `scripts/sandbox-dev.sh`
that codesigns the debug build with it. Acceptance: add library → quit →
relaunch → library scans and covers load with NO folder dialog; watcher fires;
"Open book" opens; trash works.

### Phase B — Bundled local inference (est. 6–9 days)

**B1. `InferenceBackend` trait** (`src-tauri/src/inference/mod.rs`) per D4;
port the existing Ollama client behind it unchanged in behavior.

**B2. `LlamaCppBackend`** (`inference/llamacpp.rs`) on `llama-cpp-2`: one
lazily-loaded context per model (embed model + chat model), Metal on Apple
Silicon / CPU on x86_64, embed batching sized to keep UI responsive
(existing batch pipeline in `commands/ollama.rs:185` generalizes), generation
with the two existing prompt shapes (summary, explanation). Bench gate on
target hardware: ≥ 50 embeds/min on M-series for the 311M model (research
suggests far more), explanation blurb < 10s.

**B3. Model manager** (`inference/models.rs` + `commands/models.rs`):
manifest of {name, url, sha256, size, license} for the two GGUFs (hosted on
HF or our own CDN — decide at implementation; HF direct is fine for v1),
resumable download into the container, integrity verify, delete/redownload
commands, disk-space preflight.

**B4. Re-embedding migration:** embeddings table gains model-id awareness
(the `embeddingModel` column already exists); switching the active embedding
backend/model marks all books `pending` and the EXISTING progress pipeline
("N pending" UI) re-embeds in the background. Similarity search reads only
vectors matching the active model id — mixed states stay correct during the
transition. Dims change 2048 → 768: the vector cache/table must not assume a
fixed dim (audit: verify + fix any hardcoding).

**B5. Frontend rework:** Settings "AI (Ollama)" becomes "AI Models": default
= Built-in (download status, model versions, re-download, disk usage);
Advanced = Ollama (endpoint/model fields, exactly today's). "Ollama Offline"
status pill becomes backend-aware ("AI models not downloaded" + download CTA).
Consent card on first Discover/Graph use. The feature→backend map is 1:1 from
the frontend audit (Discover, BookGraph, similar-books, explanation blurb) —
no feature logic changes, only status plumbing.

### Phase C — Packaging & signing (est. 3–5 days + Apple account latency)

**C1. Production entitlements:** app-sandbox, user-selected read-write,
bookmarks.app-scope, network-client (model downloads + optional Ollama).
Info.plist additions (category, encryption-exempt declaration).

**C2. Developer ID channel:** certificates, hardened-runtime build, notarized
+ stapled DMG, `scripts/release-dmg.sh`. This is the first shippable output.

**C3. MAS channel with known-bug workarounds:** Apple Distribution cert +
provisioning profile; custom sign script working around the two live Tauri
issues (entitlements not reaching the `.app` through `productbuild --sign`,
and the Apple-Distribution signing bug — both documented with workarounds in
the research report §5). Universal binary; Transporter upload; TestFlight
for macOS as the validation loop.

**C4. Repo hygiene at build time:** exclude `/dev/*` routes from production
builds (adapter-static has no route exclusion — smallest fix: guard both dev
pages behind `import.meta.env.DEV` redirects and strip their chunks, or move
them under a vite-dev-only plugin); fix stale "alexandria" export filenames
(`settings/+page.svelte:167,202`); full icon set from `app-icon.png` via
`tauri icon`.

### Phase D — Store collateral & submission (est. 2–3 days + review cycles)

Privacy labels ("No Data Collected" — audit-verified), privacy policy page on
the existing site, screenshots (the 3D shelf is the hero shot), description/
keywords/category (Books or Productivity), review notes explaining the local-
AI model download and the Calibre-library use case, age rating, pricing.
Expect one rejection round; the risky reviewer topics (post-install model
download, user-library file access) both have explicit guideline cover.

---

## 5. Effort summary

| Phase | Estimate | Parallelizable? |
|---|---|---|
| A — Sandbox foundations | 3–5 days | A1/A2 sequential; A3/A4 parallel to them |
| B — Local inference | 6–9 days | B1–B3 largely parallel to Phase A; B4/B5 after B2 |
| C — Packaging & signing | 3–5 days + account setup | C2 before C3; C4 anytime |
| D — Submission | 2–3 days + review latency | after C |
| **Total engineering** | **~3–4 weeks** calendar with review buffers | |

Riskiest items (watch closely): the two Tauri MAS signing bugs (mitigated by
custom scripts + the DMG channel always working), bookmark edge cases
(network volumes, moved folders — the re-authorize UI is the safety net), and
Intel-Mac inference performance (CPU-only; acceptable because embedding is
background work and chat is one short blurb — but verify on x86 before C3).

## 6. Open questions (defaults chosen; flag if wrong)

1. **Keep Ollama as Advanced backend** (D4) — default yes.
2. **Model hosting** for downloads: HF direct links v1 — acceptable?
3. **Minimum macOS:** propose 13.0 (Ventura) — llama.cpp Metal and objc2 are
   comfortable there; current config's value TBC at implementation.
4. **Pricing/App Store account**: personal vs organization account affects
   the seller name shown — your call, needed before C3.
