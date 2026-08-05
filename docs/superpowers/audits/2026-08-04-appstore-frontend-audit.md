# EpubGraph Frontend + Packaging Audit — Mac App Store Readiness

Scope: `src/` (SvelteKit app), `package.json`, `svelte.config.js`, `vite.config.ts`, plus `src-tauri/tauri.conf.json` / `src-tauri/capabilities/default.json` / `src-tauri/Cargo.toml` / `src-tauri/src/main.rs` where needed to correlate JS plugin usage with what's actually registered (not a full Rust audit — that's a separate agent's scope).

Branch: `feature/up-next-3d-shelf`. Read-only audit, no changes made.

---

## 1. Tauri plugin usage from JS

Declared in `package.json`: `@tauri-apps/plugin-dialog@^2.6.0`, `@tauri-apps/plugin-fs@^2.4.5`, `@tauri-apps/plugin-notification@^2.3.3`, `@tauri-apps/plugin-shell@^2.3.4`. All four are registered in `src-tauri/src/main.rs:25-28` (`tauri_plugin_shell::init()`, `tauri_plugin_dialog::init()`, `tauri_plugin_fs::init()`, `tauri_plugin_notification::init()`) and granted broad capabilities in `src-tauri/capabilities/default.json` (fs scoped to `$HOME/**`, `$APPDATA/**`, `$APPLOCALDATA/**`, and a bare `**`).

### `@tauri-apps/plugin-dialog` — actively used, 9 call sites

| Site | Call | Flow | What happens to the path |
|---|---|---|---|
| `src/lib/components/Sidebar.svelte:158` | `open({ directory: true, multiple: false })` | "Add Library" folder picker (sidebar) | Passed straight to `addLibrary(selected)` → `invoke('add_library', { path })` (`src/lib/stores/library.ts:102`, `src/lib/api/commands.ts:199`). No JS-side file access. |
| `src/lib/components/BookGrid.svelte:77` | `ask(...)` | Context-menu "Delete Book" confirm | Confirms only; deletion done via `invoke('delete_book', ...)`. |
| `src/lib/components/BookGrid.svelte:118` | `ask(...)` | Context-menu "Delete by Author" confirm | Same pattern. |
| `src/routes/+page.svelte:67` | `ask(...)` | `Delete`/`Backspace` keyboard shortcut on selected book | Same pattern (`handleKeyDown`, `src/routes/+page.svelte:44-90`). |
| `src/routes/settings/+page.svelte:26` (static import `{ open, save }`) | `save(...)` | "Create Backup" (`handleBackup`, :162-178) | Path → `invoke('create_backup', { path })`. Default filename `alexandria-backup-<date>.db` — stale product name (see §5). |
| same | `open(...)` | "Restore Backup" (`handleRestore`, :180-195) | Path → `invoke('restore_backup', { path })`. |
| same | `save(...)` | "Export JSON" (`handleExport`, :197-213) | Path → `invoke('export_library', { path })`. Default filename `alexandria-export-<date>.json` — stale name. |
| same | `open(...)` | "Import JSON" (`handleImport`, :215-230) | Path → `invoke('import_library', { path })`. |
| same | `open({ directory: true })` | "Change Database Location" (`handleChangeDatabasePath`, :308-321) | Path → `invoke('set_database_path_preference', { path })`; user is told to restart. |

All dialog usage is either a confirm (`ask`) or a native file/folder picker whose resulting path is forwarded verbatim to a Tauri command — no raw filesystem access happens in JS. This is the MAS-friendly pattern (user-driven picker grants access; app doesn't need broad FS entitlements for these flows).

### `@tauri-apps/plugin-fs` — declared, registered, capability-scoped broadly, **zero JS call sites**

No `import ... from '@tauri-apps/plugin-fs'`, `readTextFile`, `writeTextFile`, `readFile`, `writeFile`, `readDir`, or `BaseDirectory` anywhere in `src/` (grep across `*.ts`/`*.svelte` returned nothing). All file I/O (library scanning, cover extraction, backup/export/import, DB relocation) happens via custom `invoke()` commands that presumably do file I/O directly in Rust (`std::fs` / `tokio::fs`), not through the JS-facing fs plugin API. The plugin is registered and capability-scoped to `$HOME/**` / `**` for both read and write (`src-tauri/capabilities/default.json:29-42`) but that surface is unexercised from the frontend. Whether the Rust side actually needs the plugin (vs. just `std::fs`) is the Rust auditor's call, but from the frontend's perspective this is dead JS-facing surface — flag for entitlements review since MAS sandbox reviewers will look at the broad `**` fs scope regardless of which layer uses it.

### `@tauri-apps/plugin-shell` — declared, registered, **zero JS call sites, and zero Rust call sites found**

No `plugin-shell` import, `Command`, or `.open()` usage anywhere in `src/`. A targeted grep of `src-tauri/src/` for `ShellExt`/`shell::`/`.shell()` only matched the `main.rs` registration line itself — no actual shell-plugin invocation elsewhere in Rust either (confirm with the Rust auditor, this was a shallow check). "Open Book" (context menu, `src/lib/components/BookGrid.svelte:48-52`) calls a **custom** command instead: `invoke('open_file_with_default_app', { path: contextMenuBook.path })`, registered directly in `src-tauri/src/main.rs:88` (not part of `commands.ts`'s wrapper module, and not going through `plugin-shell`'s own `open()` API). This looks like the one flow that "opens" something external, but it bypasses the declared shell plugin entirely — worth confirming with the Rust auditor whether `open_file_with_default_app` itself shells out (e.g. `open` on macOS) and whether that's MAS-sandbox-safe.

### `@tauri-apps/plugin-notification` — declared, registered, **zero call sites anywhere**

No `sendNotification`, `isPermissionGranted`, `requestPermission`, or plugin import in `src/`, and the Rust-side grep found nothing beyond the registration line in `main.rs`. This plugin appears fully dead — no in-app notifications are ever shown. Candidate for removal (simplifies the privacy/permissions story and MAS entitlement surface).

**Risk summary by plugin:** dialog = low risk, actively used, standard picker pattern. fs = unused from JS but capability-scoped very broadly (`**`) — flag for the Rust auditor / entitlements review. shell = unused from JS and apparently unused from Rust too — candidate to drop. notification = fully dead — candidate to drop.

---

## 2. Ollama-facing UI

### Settings screen (`src/routes/settings/+page.svelte:373-437`, "AI Settings (Ollama)")
Three plain-text fields, all client-editable and persisted via `updateSettings()` → `invoke('update_settings', ...)`:
- **Ollama Endpoint** (`ollamaEndpoint`, default `http://localhost:11434`, :382-391)
- **Embedding Model** (`ollamaModel`, default `nomic-embed-text`, :394-406)
- **Chat Model** (`ollamaChatModel`, default `mistral:7b`, :408-420)

Plus a "Test Connection" button (`testOllamaConnection`, :146-160) that calls `configureOllama(endpoint, model)` then `getOllamaStatus()`, and a status dot + "Connected"/"Disconnected" label (:422-435).

These three fields, their placeholder copy, and the section header literally naming "Ollama" are the primary UI surface that assumes an external Ollama daemon. If Ollama is replaced by a bundled local model, this entire section (endpoint field in particular — a bundled model has no user-configurable network endpoint) needs to be redesigned, not just relabeled.

### "Ollama Offline" status plumbing (sidebar)
`src/lib/components/Sidebar.svelte`:
- `getOllamaStatus()` polled via `src/routes/+page.svelte:46-73` (`loadStatus`/`scheduleNextPoll`), with **adaptive polling intervals**: 5s when disconnected (`POLL_INTERVAL_DISCONNECTED`), 30s when connected idle (`POLL_INTERVAL_CONNECTED`), 3s while actively processing (`POLL_INTERVAL_ACTIVE`) — `src/routes/+page.svelte:42-44`.
- Status pill: `src/lib/components/Sidebar.svelte:345-356` — `"Ollama Connected"` / `"Ollama Offline"` text plus the connected model name (`ollamaStatus.model`, :355).
- Error copy directly names Ollama: `src/lib/components/BookDetail.svelte:198` — `'Could not generate explanation. Make sure Ollama is running with the configured model.'` (shown when `generateRecommendationReason` fails, :179-202).

### Embedding-progress UI ("N pending")
`src/lib/components/Sidebar.svelte:393-435` — the "Embeddings" panel:
- `processingStatus.pending` count drives the "Embeddings Complete" vs. in-progress vs. "N pending" states.
- `canStartEmbeddings = processingStatus.pending > 0 && ollamaStatus?.connected && !needsMetadataFirst` (:396) — embedding processing is **gated on Ollama being connected**; if Ollama is swapped for a bundled model that's always "connected," this gate and its copy become vestigial but harmless, though the gating logic itself (and the metadata-first sequencing) will need to stay conceptually equivalent.
- Batch loop: `startEmbeddingProcessing()` (`Sidebar.svelte:90-110` and mirrored in `+page.svelte:90-110`) calls `processEmbeddingsBatch(10)` in a `setTimeout`-driven loop every 500ms until `remaining === 0`.
- Separate metadata-parsing loop (`startMetadataParsing`, `+page.svelte:121-153`) calls `parseMetadataBatch(20)` every 100ms — not Ollama-gated, runs regardless of connection status.

### Feature → backend command map (LLM/embedding consumers)

| Frontend feature | File | Command(s) invoked |
|---|---|---|
| Discover page | `src/routes/discover/+page.svelte:4,44` | `getSmartRecommendations(24)` → `get_smart_recommendations` |
| Book Graph | `src/lib/components/GraphView.svelte:75`, `src/routes/graph/+page.svelte:31-89` | `get_book_graph`, plus `get_book` / `query_books` for node hydration |
| RecommendedCard (used by Discover) | `src/lib/components/RecommendedCard.svelte:3-4` | Consumes `SmartRecommendation` objects passed in as props; fetches its own cover via `getCoverImage` |
| BookDetail — similar books | `src/lib/components/BookDetail.svelte:5,118` | `getRecommendations(bookId, 5)` → `get_recommendations` |
| BookDetail — "why recommended" LLM explanation | `src/lib/components/BookDetail.svelte:179-202` | `generateRecommendationReason(...)` → `generate_recommendation_reason` (this is the one true **chat-model** call site — everything else above is embedding/similarity, not generative text) |
| Up Next / Want-to-Read | `src/lib/stores/upnext.ts:63-79` | `get_up_next_books`, `get_want_to_read_books` (no LLM dependency — pure DB reads) |
| Sidebar embedding controls | `src/lib/components/Sidebar.svelte` | `get_ollama_status`, `get_processing_status`, `process_embeddings_batch`, `parse_metadata_batch` |

Notable: the Discover page caches LLM-generated "why recommended" reason strings in **`localStorage`** (`src/routes/discover/+page.svelte:15-37`, key `recommendation_reasons`, 7-day expiry) to avoid re-calling the chat model — this is local-only, no network egress, but is a piece of app-generated (not user) data worth listing in the privacy inventory (§6).

---

## 3. External resources (http(s) fetches, CDNs, fonts, remote images, external links)

- **No `fetch()` calls anywhere in `src/`** (grep for `fetch(` returned nothing).
- **No XMLHttpRequest/WebSocket/EventSource** in the bookshelf 3D code or elsewhere.
- **No CDN links** — grep for `fonts.googleapis`, `fonts.gstatic`, `cdn.`, `unpkg.com`, `jsdelivr` returned nothing.
- **No `@font-face` / remote `@import`** — `src/app.css` only has `@import "tailwindcss"; @import "glasswindui";`, both local npm packages bundled at build time. Book cover typography uses a **system font stack** (`SERIF_STACK = "'Iowan Old Style', 'Baskerville', 'Georgia', serif"`, `src/lib/components/bookshelf/three/textures/artwork.ts:6`) — all pre-installed macOS fonts, not web fonts.
- **Cover images are local, not remote**: `getCoverImage(bookId)` (`src/lib/api/commands.ts:278-281`) returns a `data:` URL from the Rust backend (confirmed by the comment at `src/lib/components/bookshelf/three/coverPipeline.ts:102`: *"getCoverImage's data: URL is same-origin by construction"*). Consumed by `BookCard.svelte:32`, `RecommendedCard.svelte:19`, `BookDetail.svelte:101`, `Library3D.svelte:890`, `coverPipeline.ts:190`. No network image fetch anywhere.
- **The only `http://` literals in `src/`** are the Ollama endpoint default/placeholder strings (`src/routes/settings/+page.svelte:52,108,390`, value `http://localhost:11434`) — localhost, not external.
- **No `shell.open()` of external https links found** — see §1, the shell plugin has no JS call sites. There is no in-app "visit our website" / "rate us" / social link that opens a browser.
- CSP in `src-tauri/tauri.conf.json:22`: `"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'"` — consistent with the fully self-contained, no-external-fetch picture above.

**Conclusion: the frontend makes zero external network calls.** The only network traffic in the whole app is the Rust backend talking to `localhost:11434` (Ollama), which is local, not "external" in the App Store sense, but is a runtime dependency outside the sandboxed app bundle (relevant to the Ollama-replacement plan in §2, not a privacy/external-resource issue per se).

---

## 4. Updater / distribution artifacts

- **No updater plugin** (`@tauri-apps/plugin-updater` is not in `package.json`, not registered in `main.rs`, no `updater` key in `src-tauri/tauri.conf.json`).
- **No "check for updates" UI** anywhere in `src/` — grep for `updat(e|er)` across `*.ts`/`*.svelte` only matched the `updateSettings`/`updateBook`/`updateSettings` command names (config mutation, unrelated to app updates) and the "Database will move to new location on **restart**" toast copy.
- **No in-app download links.** Settings page (`src/routes/settings/+page.svelte`) has no "About"/version section at all — confirmed by scanning the full 654-line file: no `version`, `About`, changelog, or GitHub-link text anywhere in the UI.
- **No app version displayed anywhere in the UI.** `package.json` version `0.1.0` and `src-tauri/tauri.conf.json` version `0.1.0` are in sync with each other but neither is surfaced to the user.
- `windows.certificateThumbprint` / `timestampUrl` in `tauri.conf.json:33-34` are Windows code-signing config, empty/null — not relevant to macOS but confirms no updater-adjacent signing config exists either.

**Conclusion: fully clean for MAS — no updater plumbing to strip, no download links to remove.** (If the docs/ site mentions GitHub downloads, that's outside `src/` and not part of the shipped app bundle.) The one gap worth optionally fixing before submission: no version number is shown anywhere in-app, which App Store reviewers sometimes expect to be visible somewhere (e.g. a Settings footer).

---

## 5. Packaging story as-is

### Adapter / build output
- `svelte.config.js`: `@sveltejs/adapter-static` with `pages: 'build'`, `assets: 'build'`, `fallback: 'index.html'`, `precompress: false`, `strict: true`. Standard static-SPA-shell config for Tauri; `strict: true` means the build will fail if any route can't be statically rendered/prerendered — worth confirming the `/dev/*` routes and `graph`/`up-next` (which do client-only `invoke()` work) don't trip this (they use `browser` guards, so should be fine, matches existing pattern used throughout the codebase).
- `vite.config.ts`: standard SvelteKit + Tailwind v4 plugin, `envPrefix: ['VITE_', 'TAURI_']`, build target `safari13` (correct for macOS webview), minify via esbuild unless `TAURI_DEBUG`. Nothing dev-only leaks into the prod build config itself.
- `frontendDist: "../build"` in `tauri.conf.json:8` — matches the adapter's `pages`/`assets: 'build'` output dir.

### Dev-only routes (known, confirmed, nothing else found)
- `src/routes/dev/shelf/+page.svelte` and `src/routes/dev/textures/+page.svelte` exist and **will ship** in the static build (adapter-static has no route-exclusion mechanism by default — every route under `src/routes` gets prerendered/included). No `+layout.ts`/`+page.ts` with `export const prerender = false` or similar exclusion found for these routes (there are **no** `+page.ts`/`+layout.ts` files anywhere in `src/routes` at all). Confirmed already known/slated for removal per the task brief — I found no *other* dev-ish routes, debug panels, or test-only UI reachable in the shipped route tree. `src/lib/components/bookshelf/Library3D.svelte:848` has one `import.meta.env.DEV` branch (dev-only console diagnostics), which is compiled out / no-ops in production builds — not a shipped concern.
- No nav links to `/dev/shelf` or `/dev/textures` exist in `Sidebar.svelte` or `+layout.svelte` — they're unlinked but still reachable by direct URL navigation once bundled, since adapter-static ships them as real files.

### Icons / assets
- `src-tauri/icons/`: `32x32.png`, `128x128.png`, `128x128@2x.png` (256x256), `64x64.png`, `icon.png` (512x512), `icon.icns`, `icon.ico`, plus a full Windows `Square*Logo.png` / `StoreLogo.png` set (MSIX-oriented, irrelevant to macOS/MAS but harmless).
- `icon.icns` was verified via `iconutil -c iconset` to contain the **full retina set through 512x512@2x (i.e. 1024x1024)** — this is MAS-complete; the App Store 1024×1024 marketing/App Store icon requirement is satisfied by what's already embedded in the .icns.
- `tauri.conf.json` `bundle.icon` list (`:27-33`) only explicitly references `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` — doesn't list `icon.png` (512) directly, but that's fine since `icon.icns` already carries the full macOS set.
- A separate **`app-icon.png` at the repo root** (not under `src-tauri/icons/`, not referenced by `tauri.conf.json` at all) is 1024×1024 — looks like the source master used to generate the `.icns`/`.ico` set. Not part of the packaged bundle, no action needed unless it's meant to be the literal App Store Connect upload asset (in which case point App Store Connect at this file directly, it doesn't need to be wired into `tauri.conf.json`).

### Window config
`src-tauri/tauri.conf.json:11-20`: single window, `title: "EpubGraph"`, `1400x900` default, `minWidth: 900` / `minHeight: 600`, `resizable: true`, `fullscreen: false`, `center: true`. **No `titleBarStyle` set** (defaults to native/standard macOS title bar — fine for MAS, no custom chrome to worry about from a HIG-compliance angle). No `transparent`, `decorations: false`, or custom traffic-light handling — this is about as vanilla/compliant a window config as it gets.

### Product-name inconsistency (minor, cosmetic)
The app is branded "EpubGraph" everywhere (`tauri.conf.json` `productName`, `app.html` `<title>`, Sidebar logo text) **except** two default filenames in Settings that still say "alexandria" — `src/routes/settings/+page.svelte:167` (`alexandria-backup-<date>.db`) and `:202` (`alexandria-export-<date>.json`). Cosmetic, but a MAS reviewer or a user opening a save dialog could reasonably flag "why does this rebranded app propose Alexandria filenames" — cheap fix before submission.

---

## 6. Privacy-label inventory

**Bottom line: nothing in the frontend contradicts a "no data collected" privacy declaration.**

- **Analytics/telemetry/crash-reporting: none found.** Grepped `src/`, `package.json`, and `src-tauri/Cargo.toml` for `analytics|telemetry|sentry|posthog|mixpanel|amplitude|crashreport|bugsnag|segment\.io|google-analytics|gtag` — the only hits were unrelated identifier substrings (`BOB_AMPLITUDE` in the 3D carousel animation code). No analytics SDK is in `dependencies`/`devDependencies`, no crash reporter, no telemetry beacon of any kind.
- **No `fetch()`/XHR/WebSocket anywhere in `src/`** (see §3) — there is no code path capable of phoning home even accidentally.
- **Local data touched by the app** (for the privacy questionnaire):
  - **User's ebook files** — read via user-selected library folders (dialog-picker flow, §1); paths and file contents processed entirely locally by the Rust backend.
  - **Book metadata & embeddings** — stored in a local SQLite DB (`getDatabasePath()`/`getDatabaseStats()`, settings page), user-relocatable via the "Change Database Location" picker.
  - **`localStorage`** (all local, no sync): `theme` (`src/lib/stores/theme.ts:11,27`), `epubgraph_recently_viewed` — last 20 viewed book IDs (`src/lib/stores/recentlyViewed.ts:10,31`), `recommendation_reasons` — cached LLM explanation text keyed by book ID, 7-day TTL (`src/routes/discover/+page.svelte:15,33,35`).
  - **Backup/export files** — user-initiated `.db`/`.json` dumps written wherever the user picks via `save()` (§1); not sent anywhere.
- **No accounts, no auth, no sign-in flow** anywhere in `src/routes` or `src/lib` — confirmed by the full route listing (`+page`, `discover`, `graph`, `settings`, `up-next`, `dev/*` — no `login`/`auth`/`account` route or component).
- **Only "external" runtime contact is Ollama at `localhost:11434`** (§2/§3) — this is loopback, not a remote server, and Ollama itself isn't bundled/networked beyond the local machine. Not a privacy-label concern under Apple's definitions (no data leaves the device), but worth a one-line mention in reviewer notes if Apple's review team asks about the "AI" framing, since the app's own copy ("AI-Powered Library" tagline in `Sidebar.svelte:193`, "AI Settings (Ollama)" section header) invites the question.

**Verified consistent with "Data Not Collected."** No contradicting code found.

---

## Appendix: files touched by this audit (read-only)

- `package.json`, `svelte.config.js`, `vite.config.ts`
- `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs` (correlation only, not a full Rust audit)
- `src/lib/api/commands.ts` (full command surface)
- `src/lib/components/{BookGrid,Sidebar,BookDetail,BookCard,RecommendedCard,GraphView}.svelte`
- `src/lib/stores/{library,theme,recentlyViewed,upnext}.ts`
- `src/routes/{+page,+layout,settings/+page,discover/+page,graph/+page,up-next/+page}.svelte`
- `src/routes/dev/{shelf,textures}/+page.svelte` (existence confirmed, not deep-read)
- `src/lib/components/bookshelf/three/{coverPipeline,textures/artwork}.ts`
- `src/app.html`, `src/app.css`
- `src-tauri/icons/*` (inspected with `sips`/`iconutil`), root `app-icon.png`
