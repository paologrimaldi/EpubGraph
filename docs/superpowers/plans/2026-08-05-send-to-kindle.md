# Send to Kindle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Send to Kindle" button to the shared book detail panel that opens an Apple Mail draft with the EPUB attached and the user's stored `@kindle.com` address prefilled.

**Architecture:** A `kindle_email` row in the existing key/value `settings` table feeds a new `send_book_to_kindle` Tauri command. The command runs a guard chain (address set → book exists → file on disk → size ≤ 50 MB), then shells to `osascript`, passing the path/address/subject as **`argv` arguments** rather than interpolating them into the script text. One button in `BookDetail.svelte`'s unguarded action block reaches all three screens at once.

**Tech Stack:** Rust (Tauri 2, rusqlite), Svelte, AppleScript via `osascript`, `tempfile` for tests.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-05-send-to-kindle-design.md` — read it before starting.
- **Attachment limit:** 50 MB, expressed once as `KINDLE_MAX_ATTACHMENT_BYTES`.
- **No AppleScript string interpolation.** Path/address/subject are passed as `argv`. The library is largely Spanish-language (`¿Crees en el amor a primera vista?`, `Sálvenme de la Navidad`) with apostrophes and accents in paths; interpolation breaks on quotes and is an injection vector.
- **No Mail-account precheck.** `~/Library/Mail` is TCC-protected and returns `Operation not permitted`, so it cannot distinguish "no account" from "not permitted". Mail failures surface via `osascript` stderr.
- **No migration.** `get_settings` (`db/queries.rs:526`) already ignores unknown keys via `_ => {}`.
- **Errors are always shown.** Every failure path renders a message; a silent no-op is the defect this feature exists to remove.
- **macOS only.** Consistent with the existing `open_file_with_default_app`, which already shells to macOS `open`.
- Rust tests: `cd src-tauri && cargo test`. Frontend: `pnpm vitest run`, `pnpm check`.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/kindle.rs` | **New.** `SendError`, `validate_send`, the AppleScript constant, `send_book_to_kindle`. Self-contained so the validation logic is unit-testable without Mail. |
| `src-tauri/src/commands/mod.rs` | Declare `pub mod kindle;` |
| `src-tauri/src/main.rs:87` | Register the command |
| `src-tauri/src/db/mod.rs:202` | `Settings.kindle_email` |
| `src-tauri/src/db/queries.rs:537` | `get_settings` match arm |
| `src-tauri/src/commands/settings.rs:205` | `PartialSettings.kindle_email` + persist arm |
| `src/lib/api/commands.ts:174` | `Settings.kindleEmail` |
| `src/routes/settings/+page.svelte` | Kindle address input |
| `src/lib/components/BookDetail.svelte` | Button, shared error state, `openFile` try/catch |

---

### Task 1: Store the Kindle address

**Files:**
- Modify: `src-tauri/src/db/mod.rs:202-210` (struct), `:212+` (Default impl)
- Modify: `src-tauri/src/db/queries.rs:537-546`
- Modify: `src-tauri/src/commands/settings.rs:205-213`, `:161+`
- Modify: `src/lib/api/commands.ts:174-182`
- Modify: `src/routes/settings/+page.svelte`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings.kindle_email: String` (Rust), `Settings.kindleEmail: string` (TS). Task 3 reads `state.db.get_settings()?.kindle_email`.

- [ ] **Step 1: Add the field to the Rust struct**

In `src-tauri/src/db/mod.rs`, add to `pub struct Settings` after `scan_interval_minutes`:

```rust
    /// Amazon Send-to-Kindle address. Empty string means "not configured",
    /// which is a first-class state, not an error.
    pub kindle_email: String,
```

And in `impl Default for Settings`, after `scan_interval_minutes: 60,`:

```rust
            kindle_email: String::new(),
```

- [ ] **Step 2: Read it in get_settings**

In `src-tauri/src/db/queries.rs`, add to the `match key.as_str()` block before `_ => {}`:

```rust
                    "kindle_email" => settings.kindle_email = value,
```

- [ ] **Step 3: Accept it in PartialSettings**

In `src-tauri/src/commands/settings.rs`, add to `pub struct PartialSettings`:

```rust
    pub kindle_email: Option<String>,
```

And in `update_settings`, before the final `Ok(())`:

```rust
    if let Some(ref kindle_email) = settings.kindle_email {
        state.db.update_setting("kindle_email", kindle_email.trim()).map_err(|e| e.to_string())?;
    }
```

- [ ] **Step 4: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: `Finished` with no errors.

- [ ] **Step 5: Add the TypeScript field**

In `src/lib/api/commands.ts`, add to `export interface Settings`:

```typescript
	kindleEmail: string;
```

- [ ] **Step 6: Add the settings UI**

In `src/routes/settings/+page.svelte`, add a state variable beside `ollamaEndpoint`:

```typescript
	let kindleEmail = '';
```

In the settings-load block beside `ollamaEndpoint = settings.ollamaEndpoint || ...`:

```typescript
				kindleEmail = settings.kindleEmail || '';
```

In `saveSettings()`, add to the `updateSettings({...})` object:

```typescript
				kindleEmail,
```

And in the "General" section (after `<h2 ...>General</h2>`, matching the Ollama Endpoint input block):

```svelte
						<div>
							<label for="kindle-email" class="block text-[12px] font-medium text-secondary mb-1.5">
								Send-to-Kindle Address
							</label>
							<input
								id="kindle-email"
								type="text"
								bind:value={kindleEmail}
								class="glass-input"
								placeholder="yourname@kindle.com"
							/>
							<p class="text-[11px] text-muted mt-1.5">
								Find this in Amazon → Manage Your Content and Devices → Preferences.
								Your sending address must be approved there too.
							</p>
						</div>
```

- [ ] **Step 7: Verify frontend typechecks**

Run: `pnpm check`
Expected: `0 errors` (9 pre-existing a11y warnings are unrelated).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/queries.rs src-tauri/src/commands/settings.rs src/lib/api/commands.ts src/routes/settings/+page.svelte
git commit -m "feat(kindle): store Send-to-Kindle address in settings"
```

---

### Task 2: `validate_send` guard chain (TDD)

**Files:**
- Create: `src-tauri/src/commands/kindle.rs`
- Modify: `src-tauri/src/commands/mod.rs:3-9`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum SendError` with variants `NoKindleAddress`, `InvalidAddress(String)`, `FileMissing(String)`, `TooLarge { actual: u64 }`; `pub fn validate_send(path: &Path, addr: &str) -> Result<(), SendError>`; `impl SendError { pub fn user_message(&self) -> String }`; `pub const KINDLE_MAX_ATTACHMENT_BYTES: u64`. Task 3 calls `validate_send` and maps errors with `user_message()`.

- [ ] **Step 1: Create the module with the failing test**

Create `src-tauri/src/commands/kindle.rs`:

```rust
//! Send-to-Kindle: opens an Apple Mail draft with a book attached.

use std::path::Path;

/// Amazon rejects Send-to-Kindle attachments above this size.
pub const KINDLE_MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    NoKindleAddress,
    InvalidAddress(String),
    FileMissing(String),
    TooLarge { actual: u64 },
}

impl SendError {
    /// Actionable text shown directly in the book detail panel.
    pub fn user_message(&self) -> String {
        match self {
            SendError::NoKindleAddress =>
                "Set your Kindle address in Settings".to_string(),
            SendError::InvalidAddress(a) =>
                format!("\"{}\" is not a valid email address", a),
            SendError::FileMissing(_) =>
                "File not found — is the external drive connected?".to_string(),
            SendError::TooLarge { actual } => format!(
                "Kindle rejects attachments over 50 MB (this book is {} MB)",
                actual / (1024 * 1024)
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn book_of_size(dir: &TempDir, bytes: usize) -> std::path::PathBuf {
        let p = dir.path().join("b.epub");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(&vec![0u8; bytes]).unwrap();
        p
    }

    #[test]
    fn rejects_unset_address() {
        let d = TempDir::new().unwrap();
        let p = book_of_size(&d, 10);
        assert_eq!(validate_send(&p, "   "), Err(SendError::NoKindleAddress));
    }

    #[test]
    fn rejects_malformed_address() {
        let d = TempDir::new().unwrap();
        let p = book_of_size(&d, 10);
        assert!(matches!(
            validate_send(&p, "not-an-email"),
            Err(SendError::InvalidAddress(_))
        ));
    }

    /// The intermittent-external-drive case: over one session the volume went
    /// mounted -> absent (0/200 paths resolving) -> mounted again.
    #[test]
    fn rejects_missing_file() {
        let d = TempDir::new().unwrap();
        let ghost = d.path().join("not-there.epub");
        assert!(matches!(
            validate_send(&ghost, "x@kindle.com"),
            Err(SendError::FileMissing(_))
        ));
    }

    #[test]
    fn accepts_a_file_exactly_at_the_limit() {
        let d = TempDir::new().unwrap();
        let p = book_of_size(&d, KINDLE_MAX_ATTACHMENT_BYTES as usize);
        assert_eq!(validate_send(&p, "x@kindle.com"), Ok(()));
    }

    #[test]
    fn rejects_one_byte_over_the_limit_and_reports_actual_size() {
        let d = TempDir::new().unwrap();
        let p = book_of_size(&d, KINDLE_MAX_ATTACHMENT_BYTES as usize + 1);
        let err = validate_send(&p, "x@kindle.com").unwrap_err();
        assert!(matches!(err, SendError::TooLarge { .. }));
        assert!(err.user_message().contains("50 MB"));
    }
}
```

In `src-tauri/src/commands/mod.rs`, add after `pub mod export;`:

```rust
pub mod kindle;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test kindle::`
Expected: FAIL — `cannot find function 'validate_send' in this scope`.

- [ ] **Step 3: Implement validate_send**

Add to `src-tauri/src/commands/kindle.rs`, after the `impl SendError` block:

```rust
/// Guard chain, cheapest first: the configuration checks run before the
/// filesystem stat, and nothing launches Mail until every one of them holds.
///
/// Stats the file itself rather than taking a size — a caller cannot supply a
/// size for a file that does not exist, so splitting the two would make the
/// missing-file and oversize checks awkward to order.
pub fn validate_send(path: &Path, addr: &str) -> Result<(), SendError> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Err(SendError::NoKindleAddress);
    }
    // Deliberately loose: Amazon is the real validator. This only catches
    // obvious typos before we bother opening Mail.
    let valid = addr.contains('@')
        && !addr.starts_with('@')
        && !addr.ends_with('@')
        && !addr.contains(char::is_whitespace);
    if !valid {
        return Err(SendError::InvalidAddress(addr.to_string()));
    }

    let meta = std::fs::metadata(path)
        .map_err(|_| SendError::FileMissing(path.display().to_string()))?;
    if meta.len() > KINDLE_MAX_ATTACHMENT_BYTES {
        return Err(SendError::TooLarge { actual: meta.len() });
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test kindle::`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/kindle.rs src-tauri/src/commands/mod.rs
git commit -m "feat(kindle): add validate_send guard chain with tests"
```

---

### Task 3: `send_book_to_kindle` command + AppleScript

**Files:**
- Modify: `src-tauri/src/commands/kindle.rs`
- Modify: `src-tauri/src/main.rs:87`

**Interfaces:**
- Consumes: `validate_send`, `SendError::user_message` (Task 2); `Settings.kindle_email` (Task 1); `state.db.get_book(id) -> AppResult<Book>` with fields `.path: String` and `.title: String`.
- Produces: Tauri command `send_book_to_kindle(bookId: number) -> Result<(), String>`. Task 4 invokes it as `invoke('send_book_to_kindle', { bookId: book.id })`.

- [ ] **Step 1: Add the AppleScript and runner**

Add to the top of `src-tauri/src/commands/kindle.rs` (after the `use std::path::Path;` line):

```rust
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;
```

Add after `validate_send`:

```rust
/// Takes path/address/subject via `on run argv` so nothing is interpolated into
/// the script text — book paths contain apostrophes and accented characters, and
/// interpolation would both break and open an injection hole.
const MAIL_DRAFT_SCRIPT: &str = r#"
on run argv
    set filePath to item 1 of argv
    set toAddress to item 2 of argv
    set msgSubject to item 3 of argv
    tell application "Mail"
        set newMessage to make new outgoing message with properties {subject:msgSubject, content:"", visible:true}
        tell newMessage
            make new to recipient at end of to recipients with properties {address:toAddress}
            tell content
                make new attachment with properties {file name:(POSIX file filePath)} at after the last paragraph
            end tell
        end tell
        activate
    end tell
end run
"#;

fn open_mail_draft(path: &str, addr: &str, subject: &str) -> Result<(), String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(MAIL_DRAFT_SCRIPT)
        .arg(path)
        .arg(addr)
        .arg(subject)
        .output()
        .map_err(|e| format!("Could not run osascript: {}", e))?;

    if !output.status.success() {
        // Surface Mail's own error verbatim rather than a generic string, so a
        // mail-side problem stays diagnosable. This is also the reason there is
        // no Mail-account precheck — see the spec.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Apple Mail could not create the draft".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}
```

- [ ] **Step 2: Add the command**

Append to `src-tauri/src/commands/kindle.rs` (before `#[cfg(test)] mod tests`):

```rust
/// Opens an Apple Mail draft with the book attached and the stored Kindle
/// address prefilled. Never sends — the user reviews and sends.
///
/// Takes a book id rather than a path so the current path is re-read from the
/// database instead of trusting whatever the frontend last rendered.
#[tauri::command]
pub async fn send_book_to_kindle(
    state: State<'_, Arc<AppState>>,
    book_id: i64,
) -> Result<(), String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let addr = settings.kindle_email.trim().to_string();

    // Guard 1 up front so an unconfigured address costs no database work.
    if addr.is_empty() {
        return Err(SendError::NoKindleAddress.user_message());
    }

    // Guard 2.
    let book = state
        .db
        .get_book(book_id)
        .map_err(|_| "That book is no longer in your library".to_string())?;

    // Guards 3 and 4 (and address format again, keeping validate_send whole).
    validate_send(Path::new(&book.path), &addr).map_err(|e| e.user_message())?;

    open_mail_draft(&book.path, &addr, &book.title)
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/main.rs`, add after `commands::open_file_with_default_app,`:

```rust
            commands::kindle::send_book_to_kindle,
```

- [ ] **Step 4: Verify it compiles and tests still pass**

Run: `cd src-tauri && cargo test kindle::`
Expected: compiles cleanly, 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/kindle.rs src-tauri/src/main.rs
git commit -m "feat(kindle): add send_book_to_kindle command driving Apple Mail"
```

---

### Task 4: Button and shared error surfacing

**Files:**
- Modify: `src/lib/components/BookDetail.svelte` — imports `:8-21`, `openFile` `:149-152`, action block `:419-448`

**Interfaces:**
- Consumes: `send_book_to_kindle` (Task 3).
- Produces: user-visible UI. Nothing downstream depends on it.

- [ ] **Step 1: Add the Send icon import**

In `src/lib/components/BookDetail.svelte`, add to the `lucide-svelte` import list after `ExternalLink,`:

```typescript
		Send,
```

- [ ] **Step 2: Add shared error state and fix the silent openFile failure**

Replace the whole `openFile` function (currently `:149-152`):

```typescript
	// Shared by both action buttons. Follows the existing `llmError` precedent
	// rather than toast, because these messages are instructions the user needs
	// to act on ("Set your Kindle address in Settings"), not transient status.
	let actionError: string | null = null;
	let isSendingToKindle = false;

	async function openFile() {
		actionError = null;
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('open_file_with_default_app', { path: book.path });
		} catch (error) {
			console.error('Failed to open file:', error);
			actionError =
				typeof error === 'string'
					? error
					: 'Could not open this file. Is the external drive connected?';
		}
	}

	async function sendToKindle() {
		if (isSendingToKindle) return;
		isSendingToKindle = true;
		actionError = null;
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('send_book_to_kindle', { bookId: book.id });
		} catch (error) {
			console.error('Failed to send to Kindle:', error);
			actionError = typeof error === 'string' ? error : 'Could not create the email draft.';
		} finally {
			isSendingToKindle = false;
		}
	}
```

- [ ] **Step 3: Add the button and error display**

In the actions block, replace the existing Open Book button (`:420-426`) with:

```svelte
		{#if actionError}
			<div class="p-3 rounded-lg" style="background: rgba(255, 59, 48, 0.06); border: 0.5px solid rgba(255, 59, 48, 0.12)">
				<p class="text-[12px]" style="color: var(--gw-error)">{actionError}</p>
			</div>
		{/if}
		<button
			class="btn-primary w-full"
			on:click={openFile}
		>
			<ExternalLink class="w-3.5 h-3.5" />
			Open Book
		</button>
		<button
			class="btn-secondary w-full flex items-center justify-center gap-2"
			on:click={sendToKindle}
			disabled={isSendingToKindle}
		>
			{#if isSendingToKindle}
				<Loader2 class="w-3.5 h-3.5 animate-spin" />
				Opening Mail…
			{:else}
				<Send class="w-3.5 h-3.5" />
				Send to Kindle
			{/if}
		</button>
```

- [ ] **Step 4: Verify typecheck and tests**

Run: `pnpm check && pnpm vitest run`
Expected: `0 errors`; 106 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/BookDetail.svelte
git commit -m "feat(kindle): add Send to Kindle button, surface action errors"
```

---

### Task 5: Manual verification

**Files:** none — verification only.

**Interfaces:** consumes everything above.

Automated tests cover the guard chain but cannot prove Mail received the
attachment. An `osascript` exit code of 0 is **not** evidence the attachment
landed. Do not report this feature working until step 4 below has been observed.

- [ ] **Step 1: Build and install**

```bash
pnpm tauri build
```
Then replace `/Applications/EpubGraph.app` with `src-tauri/target/release/bundle/macos/EpubGraph.app`.

- [ ] **Step 2: Configure the address**

Launch the app → Settings → General → Send-to-Kindle Address → enter the `@kindle.com` address → Save. Reopen Settings and confirm it persisted.

- [ ] **Step 3: Verify each error path**

| Test | How | Expected message |
|---|---|---|
| No address | Clear the setting, click Send | `Set your Kindle address in Settings` |
| Missing file | Eject `/Volumes/Extreme_Pro`, click Send | `File not found — is the external drive connected?` |
| Missing file (open) | Same, click **Open Book** | Same message — no longer silent |
| Oversize | Pick a book > 50 MB | `Kindle rejects attachments over 50 MB (this book is N MB)` |

- [ ] **Step 4: Verify the real draft (the gate)**

With the drive mounted and a valid address, pick a book **with an accented or apostrophised title** (e.g. `Sálvenme de la Navidad`) and click Send to Kindle. Confirm all four:

1. A Mail compose window opens
2. The recipient is the `@kindle.com` address
3. **The `.epub` is actually attached** — visible in the message body, non-zero size
4. The subject shows the accented title correctly (proves the `argv` approach handles non-ASCII)

- [ ] **Step 5: Confirm on all three screens**

Open the detail panel from browse, Up Next, and Discover. The button must appear in all three (it sits outside every `context` guard).

- [ ] **Step 6: Send one real book and confirm arrival on the Kindle**

The end-to-end proof. If Amazon bounces it, the sending address is not approved — that is an Amazon-side setup step, not a bug in this feature.
