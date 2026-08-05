# EpubGraph Rust/Tauri Backend — Mac App Store Sandbox Audit

Branch: `feature/up-next-3d-shelf`. Scope: `src-tauri/` (src/**, Cargo.toml, tauri.conf.json, capabilities/). No `Info.plist`, no entitlements file, and no `src-tauri/gen/apple` project exist in the repo — this is a pure Tauri v2 project with no macOS Xcode scaffold generated yet.

---

## 1. FILESYSTEM ACCESS MAP

### 1.1 Library folders (user-chosen directories containing EPUBs)

| Path origin | Read/Write | file:line | Recurs without fresh dialog? |
|---|---|---|---|
| User picks folder via native picker | n/a (UI) | `src/lib/components/Sidebar.svelte:158-165` — `@tauri-apps/plugin-dialog` `open({directory:true})` | — |
| Path string stored verbatim in SQLite | Write (DB) | `src-tauri/src/commands/library.rs:59-61` `add_library()` → `src-tauri/src/db/queries.rs:51-67` `INSERT INTO libraries (...path...)` | — |
| Path re-read from DB on every app start | Read | `src-tauri/src/commands/library.rs:15-24` `get_libraries()` calls `std::path::Path::new(&library.path).exists()` | **YES — no dialog.** Just a stored `TEXT` column, no bookmark. |
| Library re-scanned (walks entire tree) | Read (recursive) | `src-tauri/src/commands/library.rs:104-107` `scan_library()`: `Scanner::new().fast_scan(&path)` → `src-tauri/src/scanner/mod.rs:76-137` (`WalkDir::new(root)`, max_depth 20, follows into every subdir/file) | **YES — no dialog**, triggered by user clicking "Scan" or (if `auto_scan_enabled`) automatically. |
| Cover image lookup beside each epub | Read | `src-tauri/src/scanner/mod.rs:155-185` `find_cover()` — checks sibling/parent dir for `cover.jpg` etc. | Same session as scan above — same access problem. |
| Metadata parse pass (per-book) | Read | `src-tauri/src/commands/library.rs:213-324` `parse_metadata_batch()` → `EpubParser::parse(path)` opens each epub file (`src-tauri/src/epub/mod.rs:34-40` `File::open(path)`) | **YES**, runs on a poll loop from the frontend, no dialog. |
| Orphan cleanup (existence check per book) | Read | `src-tauri/src/commands/library.rs:337-367` `cleanup_orphaned_books()` — `Path::new(&book_path).exists()` for every stored book path | **YES**, on-demand command, no dialog. |
| Cover image serving to UI | Read | `src-tauri/src/commands/books.rs:225-266` `get_cover_image()` — reads `book.cover_path` file directly (`std::fs::read`) if present, else opens the epub and extracts the embedded cover in-memory (`EpubParser::extract_cover`, `src-tauri/src/epub/mod.rs:106-121`) | **YES**, called on every grid/detail render, no dialog. Cover bytes are base64-inlined into the response — **no cache file is ever written to disk** for covers. |
| Delete/trash book file (and possibly whole folder) | Write (delete via OS trash) | `src-tauri/src/commands/books.rs:95-138` `delete_book()` — `trash::delete(&book.path)` or the enclosing folder via `get_book_folder()` (`books.rs:39-66`); also batched in `delete_books_by_author` (`books.rs:161-190`) | **YES**, no dialog; uses the `trash` crate (calls Finder/`NSWorkspace` trash under the hood on macOS). |
| Open book in external app | Read/Exec | `src-tauri/src/commands/mod.rs:11-25` `open_file_with_default_app()` — spawns `open <path>` (see §3) | **YES**, no dialog. |

**This is the core sandbox blocker.** Library folder paths are plain `TEXT` in SQLite (`src-tauri/src/db/migrations.rs:213` `path TEXT UNIQUE NOT NULL`) with zero bookmark data captured at grant time. Every one of the operations above (scan, parse, cover read, delete, open, watch) re-touches files under that folder on subsequent app launches purely from the stored string, with no security-scoped bookmark resolution. Under the App Sandbox this will fail outright (no access) as soon as the temporary URL-based grant from the picker expires (typically end of that launch). **Needs**: capture a security-scoped bookmark when the dialog resolves, persist the bookmark blob (not just the path) in the `libraries` table, and start-accessing/stop-accessing it around every scan/read/write/watch session.

### 1.2 Calibre metadata.db

- Detected (not actually imported): `src-tauri/src/commands/library.rs:42-49` — when adding a library, checks `path_buf.join("metadata.db").exists()` and stores the path in `libraries.calibre_db_path` (`db/queries.rs:54-55`, schema at `db/migrations.rs:215`).
- **`CalibreImporter` (`src-tauri/src/calibre/mod.rs`) is dead code** — `import_books()`, `import_to_database()`, `find_epub_path()`, `find_cover_path()` are never called from any `#[tauri::command]` or from `lib.rs`/`main.rs`. Grep confirms zero call sites outside the module's own tests (`calibre/mod.rs:273`). So today Calibre's `metadata.db` is opened only implicitly if the Calibre library folder itself is added as a regular library and scanned as EPUB files by the generic scanner — the dedicated Calibre SQLite-read path (`Connection::open(&db_path)` at `calibre/mod.rs:61,77`) is unreachable in the shipped app. Flag for the plan: either wire it up (needs the same bookmark treatment, since `metadata.db` lives inside the user-chosen library folder) or delete it.

### 1.3 App-internal data (inside sandbox container — fine as-is)

- `src-tauri/src/state.rs:56-70`: `data_dir = dirs::data_dir()/"epub-graph"` → on macOS resolves via the module's own `dirs::data_dir()` shim (`state.rs:136-163`) to `$HOME/Library/Application Support/epub-graph`. `std::fs::create_dir_all(&data_dir)` (state.rs:61), `library.db` created there (state.rs:63-67).
- `src-tauri/src/commands/settings.rs:152-157` `get_config_path()`: uses the **`dirs` crate's** `dirs::config_dir()` (different resolution than the hand-rolled one in state.rs, but macOS `dirs::config_dir()` also resolves to `~/Library/Application Support`) → `.../epub-graph/config.json`. Written by `set_database_path_preference` (`settings.rs:118-150`) and read by `get_database_path_preference` (`settings.rs:105-116`). Both stay inside the container under sandbox — fine.
- **Caveat**: `set_database_path_preference` (`settings.rs:120-129`) accepts an arbitrary `path: String` from the frontend with no validation that it's inside the container — if ever wired to a folder-picker for "custom DB location" (not currently exposed in the UI I could find), it would need the same bookmark treatment. Currently not called from `src/lib` — command exists but appears unused by the frontend today (grep only found the get/set wrapper functions in `commands.ts`, no call sites in components). Low priority but note for the plan.

### 1.4 Export / Import / Backup (explicit user-chosen file paths)

- `src-tauri/src/commands/export.rs:65-113` `export_library()` — writes JSON to `path: String` param via `File::create(&path)`.
- `src-tauri/src/commands/export.rs:117-227` `import_library()` — reads JSON via `File::open(&path)`.
- `src-tauri/src/commands/export.rs:248-262` `create_backup()` — `std::fs::copy(&db_path, &backup_path)`.
- `src-tauri/src/commands/export.rs:265-283` `restore_backup()` — `std::fs::copy(&backup_path, &db_path)`.
- All four take a raw path string from the caller. I did not find frontend call sites feeding these through `@tauri-apps/plugin-dialog`'s save/open dialogs (not present in the `src/lib` grep for `dialog.open` — only the library-add flow in Sidebar.svelte uses it). **If these are UI-reachable via a raw text input rather than a native save/open dialog, that's a second sandbox blocker** (arbitrary path write outside container) independent of bookmarks — worth confirming on the frontend side. If they *do* route through the dialog plugin's save/open (one-shot, not persisted), no bookmark is needed since it's a single-use operation, not a recurring one.

### 1.5 Capabilities file grants (Tauri's own permission layer, not macOS entitlements)

`src-tauri/capabilities/default.json:30-46` grants the `fs` plugin scope:
```json
{ "identifier": "fs:allow-read",  "allow": [{ "path": "$HOME/**" }, { "path": "$APPDATA/**" }, { "path": "$APPLOCALDATA/**" }, { "path": "**" }] },
{ "identifier": "fs:allow-write", "allow": [{ "path": "$APPDATA/**" }, { "path": "$APPLOCALDATA/**" }, { "path": "$HOME/**" }] }
```
`{"path": "**"}` for read is effectively unrestricted filesystem read via the JS-side `@tauri-apps/plugin-fs` API (separate from all the Rust `std::fs` calls audited above, which bypass this scope entirely since they're native Rust, not going through the plugin's permission checker). This is a Tauri-level allowlist, **not** an App Sandbox entitlement — it does not grant real sandbox access — but it signals current intent to read/write anywhere, and should be tightened to the minimum needed scopes as part of the sandboxing work (it will also fail loudly the moment sandbox is on, since the plugin can't touch paths outside the container/security-scoped bookmarks regardless of what this JSON says).

---

## 2. FILE WATCHING

- Module: `src-tauri/src/watcher/mod.rs`, built on `notify` crate with `macos_fsevent` feature (`Cargo.toml:46`).
- `LibraryWatcher::new/start/watch_path/unwatch_path/process_events/stop` (`watcher/mod.rs:23-220`) is a complete, working implementation: FSEvents-backed (`RecommendedWatcher`, 2s poll config at `watcher/mod.rs:41`), recursive watch (`RecursiveMode::Recursive`, `watcher/mod.rs:56`), handles create/modify/delete of `.epub` files by re-parsing and updating the DB (`watcher/mod.rs:126-190`).
- **It is never instantiated.** Grep for `LibraryWatcher` across `src-tauri/src` shows only its own definition — no call site in `main.rs`, `lib.rs`, `state.rs`, or any command. The `libraries.watch_enabled` DB column (`db/migrations.rs:217`, default `1`) and the `watchEnabled: boolean` field surfaced to the frontend (`src/lib/api/commands.ts:58`) are **not backed by any running watcher** — it's a schema/UI stub only.
- Sandbox implication: currently moot since it's dead code, but if wired up later, FSEvents watching a security-scoped-bookmark path requires the bookmark to stay "started" (`startAccessingSecurityScopedResource`) for the life of the watch, which is a real constraint to design for.

---

## 3. PROCESS SPAWNING

- **Only one spawn site in the whole backend**: `src-tauri/src/commands/mod.rs:11-25`
  ```rust
  #[tauri::command]
  pub async fn open_file_with_default_app(path: String) -> Result<(), String> {
      let output = std::process::Command::new("open").arg(&path).output()...
  ```
  Invoked from the frontend at `src/lib/components/BookDetail.svelte:150` and `src/lib/components/BookGrid.svelte:51` ("open in default reader"). Sandboxed apps cannot exec `/usr/bin/open` (or any binary) directly — this must become `tauri_plugin_shell`'s `.open()` API (LSOpenURLsWithRole под the hood, which sandbox allows) or `tauri_plugin_opener`. Note `tauri-plugin-shell` is already a dependency (`Cargo.toml:21`) and `shell:allow-open` is already granted in capabilities (`capabilities/default.json:25`) — but the Rust code doesn't use the plugin's open API yet, it shells out directly. This is a straightforward fix.
- No other `Command::new`, `std::process::`, `osascript`, or AppleScript usage anywhere in `src-tauri/src` (confirmed via repo-wide grep — zero hits for `osascript`/`AppleScript`).
- `tauri-plugin-shell` is registered (`main.rs:26`) but capabilities only grant `shell:default` + `shell:allow-open` (`capabilities/default.json:24-25`) — no `shell:allow-execute` / arbitrary-command scope, so no other shell-exec surface exists today.

---

## 4. NETWORK MAP

All outbound traffic in the Rust backend goes through one `reqwest::Client` wrapper, `OllamaClient` (`src-tauri/src/ollama/mod.rs`), instantiated fresh per-call in most places (each command builds its own `OllamaClient::new(endpoint, model)`), with a 120s timeout (`ollama/mod.rs:19-22`) and **no retry logic** anywhere.

**Base URL**: entirely user/DB-configurable, default `http://localhost:11434` — hardcoded default in three places that must stay in sync: `state.rs:82`, `db/mod.rs:215` (Settings::default), `db/migrations.rs:243` (seed row in `settings` table). Runtime value comes from `settings.ollama_endpoint`, changeable via `configure_ollama` command (`commands/ollama.rs:26-43`) or `update_settings` (`commands/settings.rs:165-170`).

| Endpoint | Purpose | Model(s) referenced | Called from (feature) | file:line |
|---|---|---|---|---|
| `GET {endpoint}/api/tags` | Health check / list available models | n/a | `get_ollama_status` command | `ollama/mod.rs:48-93`, called by `commands/ollama.rs:8-23` |
| `POST {endpoint}/api/embeddings` | Generate embedding vector | Default `qwen3-embedding:8b` (7168-dim native, MRL-truncated to 2048 — see §5) | Batch embedding pipeline (`process_embeddings_batch` command) and the (dead) background worker | `ollama/mod.rs:96-122`; callers at `commands/ollama.rs:185`, `worker/mod.rs:159,311` |
| `POST {endpoint}/api/generate` (non-streaming, `stream:false`) | Chat/text generation | Configurable `ollama_chat_model`, default `mistral:7b` (`db/mod.rs:217`) | (a) LLM book-summary generation feeding the embedding text, (b) LLM-authored recommendation explanations | `ollama/mod.rs:137-163`; callers `ollama/mod.rs:347-348` (`get_or_generate_summary`) and `commands/recommendations.rs:857-858` (`generate_recommendation_reason`) |

No `/api/chat` usage (uses the older `/api/generate` completion endpoint, not the chat-turn endpoint). No streaming consumed despite `reqwest`'s `stream` feature being enabled in Cargo.toml (`Cargo.toml:56`) — `stream: false` is hardcoded (`ollama/mod.rs:143`).

**No other network hosts anywhere in the Rust code** — grep for `http://`/`https://`/`reqwest` across `src-tauri/src` returns only the Ollama endpoints above. No update-checker, no telemetry, no remote cover-art fetch, no crash reporting. `tauri.conf.json` has no `updater` config block at all (checked; absent). This is good news for sandbox/network-entitlement scoping — only localhost Ollama traffic needs `com.apple.security.network.client` (loopback still requires the entitlement under App Sandbox).

---

## 5. EMBEDDING / VECTOR PIPELINE

- **Computation**: `OllamaClient::embed()` (`ollama/mod.rs:96-122`) calls `/api/embeddings`, then applies MRL truncation + L2 normalization via `truncate_and_normalize()` (`ollama/mod.rs:360-374`) down to `EMBEDDING_DIM = 2048` (`vector/mod.rs:14`, comment notes native model output is 7168-dim).
- **Storage**: dedicated SQLite table `embeddings` (not `book_embeddings` despite that name appearing in `Database::reset()` — see note below), created by `VectorStore::init_schema()` (`vector/mod.rs:42-63`):
  ```sql
  CREATE TABLE IF NOT EXISTS embeddings (
      book_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL,
      text_hash TEXT, created_at INTEGER ..., FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
  )
  ```
  Vectors are raw little-endian `f32` byte blobs (`serialize_embedding`/`deserialize_embedding`, `vector/mod.rs:288-311`), not JSON despite the module doc comment claiming "JSON-encoded" (stale comment, `vector/mod.rs:4`).
- **Cache / the "Loaded N embeddings into cache" log**: `VectorStore` keeps a full in-memory `DashMap<i64, Vec<f32>>` mirror (`vector/mod.rs:19`). `load_cache()` (`vector/mod.rs:66-89`) does `SELECT book_id, embedding FROM embeddings` and populates the map; the log line is at `vector/mod.rs:86`. Triggered on startup via a **detached background thread** spawned in `AppState::new()` (`state.rs:73-78`, `std::thread::spawn`) — not awaited, not cancellable, runs once.
- **Similarity search**: brute-force cosine similarity over the full in-memory cache, `find_similar()`/`find_similar_to_book()` (`vector/mod.rs:154-186`), `cosine_similarity()` (`vector/mod.rs:262-285`). O(n) per query, sorted + truncated to k. No ANN index (fine at current scale, but means the whole embedding set stays memory-resident).
- **Two field types that track "the model" and how they diverge**:
  - `embeddings.model` (per-vector, in the vector-store table) — **is** written correctly on every `store_embedding()` call (`vector/mod.rs:92-120`, e.g. from `commands/ollama.rs:188` and `worker/mod.rs:172`).
  - `books.embedding_model` (per-book column on the main `books` table, schema at `db/migrations.rs:95`) — **is never written** except being reset to `NULL` in `reset_all_embedding_statuses()` (`db/queries.rs:611`). Grep across `src-tauri/src` confirms no `UPDATE books SET embedding_model = ...` anywhere. It's read back into the `Book` struct (`db/mod.rs:131`, `db/queries.rs:1024`) but always `None` in practice. Treat this column as dead/unused in the plan — don't build re-embedding-on-model-change logic around it; the real source of truth for "what model produced this vector" is `embeddings.model`.
  - `books.embedding_status` (`db/migrations.rs:94`, values `pending`/`complete`/`failed`/`skipped`) **is** actively maintained (`update_embedding_status`, `db/queries.rs:597-605`) and drives the pending-work queries (`get_pending_embedding_books`, `db/queries.rs:622`).
- **What breaks if the model changes**: nothing detects a model change automatically. `clear_embeddings` command (`commands/settings.rs:82-102`) is the only path — it wipes the `embeddings` table (`vector_store.clear_all()`, `vector/mod.rs:214-221`) and resets every book's `embedding_status` to `pending` (`db/queries.rs:608-618`), forcing full re-embedding on the next batch pass. There's no automatic detection that `settings.ollama_model` changed and stale vectors exist — it's a manual "Clear Embeddings" user action. `text_hash` (SipHash of the embedding input text, `ollama/mod.rs:275-281`) is stored per-embedding and per-summary (`book_summaries.text_hash`) purely to detect **content** changes (re-parsed metadata), not model changes.
- **DB schema note (not a sandbox item, flag anyway)**: `Database::reset()` (`db/mod.rs:65-75`) does `DELETE FROM book_embeddings` but the actual table created by `VectorStore` is named `embeddings` — `reset_database` command will error/no-op on that line since `book_embeddings` doesn't exist. Worth fixing regardless of this audit's scope.

---

## 6. CHAT/GENERATION USAGE (LLM text generation)

Two distinct call sites, both via `OllamaClient::chat()` → `POST /api/generate`:

1. **Book summary generation** (feeds the embedding pipeline, not shown directly to the user) — `get_or_generate_summary()` (`ollama/mod.rs:331-356`). Prompt built by `build_summary_context()` (`ollama/mod.rs:299-322`, title/author/series/subjects/description truncated to 3000 bytes/chapter titles up to 30) prefixed with a fixed instruction (`SUMMARY_PROMPT_PREFIX`, `ollama/mod.rs:324-327`: "write a concise 200-word summary focusing on themes, genre, setting, writing style, target audience, and comparable works"). Result cached in `book_summaries` table (`db/migrations.rs:315-321`, keyed by `book_id`, invalidated by `text_hash`). Called from both the live command path (`commands/ollama.rs:167-170`, inside `process_embeddings_batch`) and the dead-code worker path (`worker/mod.rs:135,289`).
2. **Recommendation-reason explanation** (user-facing copy) — `generate_recommendation_reason` command (`commands/recommendations.rs:751-861`). Builds a prompt listing the recommended book + up to N seed books (title/author/series/rating/Up-Next flag/truncated description) and asks for a 1-2 sentence personalized explanation (prompt template at `recommendations.rs:781-848`). Not cached — regenerated every call. Uses `settings.ollama_chat_model` read fresh from DB (`recommendations.rs:850-854`).

Both use whatever model is configured as `ollama_chat_model` (default `mistral:7b`, `db/mod.rs:217`) — separate from the embedding model setting.

---

## 7. TAURI CONFIG & CAPABILITIES

**Plugins registered** (`src-tauri/src/main.rs:26-29`):
- `tauri_plugin_shell::init()`
- `tauri_plugin_dialog::init()`
- `tauri_plugin_fs::init()`
- `tauri_plugin_notification::init()`

(`Cargo.toml:21-24` — versions all `2`.)

**Capabilities** (`src-tauri/capabilities/default.json`): window `"main"` only. Permissions: `core:default`, `core:event:default`, `core:window:default`, `dialog:default` + `allow-open/allow-save/allow-message/allow-ask/allow-confirm`, `fs:default` + `allow-read/allow-write/allow-exists/allow-mkdir/allow-remove/allow-rename/allow-copy-file`, `shell:default` + `allow-open`, `notification:default` + `allow-is-permission-granted/allow-request-permission/allow-notify`, plus the broad `fs:allow-read`/`fs:allow-write` scope overrides at `default.json:30-46` covering `$HOME/**`, `$APPDATA/**`, `$APPLOCALDATA/**`, and (read-only) `**` — i.e., unrestricted. **No `shell:allow-execute` scope** — matches the finding in §3 that only `open_file_with_default_app`'s raw `Command::new` bypasses the plugin layer entirely (it doesn't even go through `tauri_plugin_shell`, so this scope wouldn't have covered it anyway).

**Bundle config** (`tauri.conf.json:30-48`):
- `"targets": "all"` — builds every target Tauri knows (dmg, app, deb, etc.) rather than scoping to macOS-only outputs; should be narrowed for a Mac-App-Store-specific build pipeline (Tauri v2 supports an `"app"`/App Store bundle target — not configured here).
- `macOS: { "minimumSystemVersion": "10.15" }` — only field present under `macOS`. **No `entitlements` path, no `signingIdentity`, no `hardenedRuntime`, no `exceptionDomain`, no `providerShortName` for notarization/MAS submission.**
- `windows` bundle config present (certificateThumbprint/digestAlgorithm/timestampUrl, all effectively empty) but no macOS-specific signing block at all.
- No `updater` key anywhere in `tauri.conf.json` (grep confirmed absent) — no Sparkle/Tauri-updater to strip out for MAS (App Store builds can't self-update), which is good — nothing to remove there.
- `identifier`: `"com.epubgraph.app"` (`tauri.conf.json:5`) — will need to match the App Store Connect bundle ID.
- CSP: `"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'"` (`tauri.conf.json:27`) — reasonably tight, no `connect-src` restriction though, so the Ollama `fetch`/`reqwest` traffic (Rust-side, not subject to CSP) is unaffected either way.
- No `src-tauri/gen/apple` Xcode project exists yet (only `gen/schemas/*.json` present, which are Tauri's auto-generated ACL/capability schema references, not a real Xcode scaffold) — `cargo tauri ios init`/`macos` App Store scaffolding hasn't been run in this repo.
- No `Info.plist` anywhere in the repo (confirmed via repo-wide `find`).

---

## 8. MISC SANDBOX HAZARDS

- **Home-dir dot-file / hidden-file reads**: none beyond directory traversal skipping hidden entries during scan (`scanner/mod.rs:195-201` `is_hidden()` — actually *excludes* dotfiles/dirs from scanning, not reads them). `dirs::data_dir()`/`dirs::config_dir()` resolve inside `~/Library/Application Support`, which is fine.
- **`/tmp` / `NSTemporaryDirectory` usage**: none in production code — the only `tempfile`/`TempDir` usage is in `#[cfg(test)]` blocks (`scanner/mod.rs:207`, and dev-dependency `tempfile = "3"` in `Cargo.toml:86`, used only by tests). No runtime temp-file writes anywhere in `src-tauri/src`.
- **AppleScript/osascript**: none (confirmed via grep, zero hits).
- **Keychain / Security.framework**: none (no `keychain`, `SecItem`, or Security.framework references anywhere).
- **Login items**: none (no `LSSharedFileList`, `SMLoginItem`, or launch-agent code).
- **Other apps' containers**: the Calibre `metadata.db` path is only ever a path *inside a user-chosen library folder* (typically `~/Documents/Calibre Library` or similar, i.e. the user's own folder, not Calibre.app's own sandboxed container) — read via plain `rusqlite::Connection::open()` in `calibre/mod.rs:61,77` (dead code today, see §1.2). If Calibre itself ships as a sandboxed Mac App Store app in the future, its true container would be inaccessible regardless; today Calibre is typically non-sandboxed and stores its library wherever the user pointed it, so this is really just another instance of the general library-folder bookmark problem, not a distinct new container-crossing hazard.
- **`trash` crate** (`Cargo.toml:83`, used in `commands/books.rs:117,120,126,132,183`): sends files to the Finder trash. Under sandbox this generally works via NSWorkspace's `recycleURL` internally for security-scoped-bookmark-backed files but will fail for arbitrary un-bookmarked paths — another consumer of the same bookmark fix from §1.1.
- **`walkdir` recursive traversal depth 20** (`scanner/mod.rs:48`, `ScannerConfig::default`) — not itself a sandbox issue, but worth noting the scanner will attempt to descend into anything reachable from the granted root, so once bookmarks are in place the granted root must be exactly the directory the user picked (no implicit escalation needed/wanted).

---

## Summary of dead code found during this audit (context for planning — don't build around these)

- `src-tauri/src/watcher/mod.rs` — `LibraryWatcher`, fully implemented, never instantiated (§2).
- `src-tauri/src/worker/mod.rs` — `BackgroundWorker` and `process_pending_embeddings()`, fully implemented, never instantiated; `AppState::start_background_services()` (`state.rs:101-108`) is a no-op stub. All embedding processing in practice happens via the frontend-driven poll of the `process_embeddings_batch` command (`commands/ollama.rs:101-235`).
- `src-tauri/src/calibre/mod.rs` — `CalibreImporter`, fully implemented, never called from any command (§1.2).
- `books.embedding_model` column — schema present, never written (§5).
