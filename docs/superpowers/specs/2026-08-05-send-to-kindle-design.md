# Send to Kindle — Design Spec

**Date:** 2026-08-05
**Status:** Draft for review — spec only, no implementation yet
**Scope:** One new button in the shared book detail panel, plus a stored Kindle address

---

## 1. Purpose

Give the user a way to get an EPUB from their library onto their Kindle without
leaving the app. Amazon's Send-to-Kindle accepts a book as an email attachment sent
from a pre-approved sender address; Amazon performs EPUB conversion server-side, so
the app only needs to produce the email.

### Non-goals

- **No EPUB reader.** Explicitly out of scope. Reading happens in whatever app the
  OS already associates with `.epub`.
- **No format conversion.** Amazon converts EPUB on receipt.
- **No auto-send.** The draft always opens for the user to review and send.
- **No send history, no bulk send, no queue.** One book, one click, one draft.
- **No new screens.** The button lives in the existing detail panel.

---

## 2. Current state

`src/lib/components/BookDetail.svelte` is a single shared component rendered by all
three screens that show book detail:

| Route | `context` prop |
|---|---|
| `src/routes/+page.svelte` (browse) | *(none — default)* |
| `src/routes/up-next/+page.svelte` | `"upnext"` |
| `src/routes/discover/+page.svelte` | `"discover"` |

Its action area (currently `BookDetail.svelte:419-448`) already holds an **Open Book**
button that sits *outside* every `{#if context === ...}` guard, so it renders on all
three screens. That button calls `open_file_with_default_app` (`commands/mod.rs:12`),
which shells out to macOS `open`.

**A new button placed in the same unguarded block therefore reaches all three screens
with a single insertion.** No per-route work is required.

### Known defect to fix alongside

`openFile()` (`BookDetail.svelte:149-152`) is the only handler in that file with no
`try`/`catch` — compare the `.catch(...)` at lines 105 and 122 and the `try` blocks at
158, 169, 185. When `open` fails, the promise rejects and nothing reaches the user, so
the button looks dead.

This is not hypothetical, and the failure is **intermittent**, which is what makes it
worth guarding. The library lives entirely on an external volume
(`/Volumes/Extreme_Pro`, all 70,266 books). Over a single session that volume was
observed mounted, then absent — `0 of 200` sampled paths resolving, with only the
2.5 MB `SanDisk Unlocker` helper partition present — then mounted again with `50 of 50`
resolving. A user hitting the unmounted window gets a button that does nothing and no
indication why. Both buttons must surface errors.

---

## 3. Approaches considered

| | Mechanism | Prefills recipient | Setup cost | Verdict |
|---|---|---|---|---|
| **A** | AppleScript → Mail.app | **yes** | Mail.app account must be configured | **chosen** |
| B | macOS Share Sheet (`NSSharingServicePicker`) | no | none | rejected |
| C | Direct SMTP from the app (`lettre`) | yes | stores app-specific password | rejected |

`mailto:` was never a candidate: RFC 6068 defines no attachment parameter and no major
client honours one, so the URL scheme cannot carry the EPUB at all.

**B** was rejected because the recipient is the *same* Kindle address on every send;
retyping it per book is precisely the friction this feature exists to remove. Spark
Desktop (the user's daily client) ships `SparkDesktopShareExtension.appex` and so does
appear in the Share Sheet, but it declares no `NSAppleScriptEnabled` and ships no
`.sdef`, so it cannot be scripted directly.

**C** was rejected as disproportionate: it stores a credential in the local database
to save one click over **A**.

**A** requires Mail.app to hold the Amazon-approved sender account. That is a one-time
cost the user accepted, and the address must be approved with Amazon regardless.

---

## 4. Design

### 4.1 Stored Kindle address

A `kindle_email` row in the existing key/value `settings` table. **No migration** —
`get_settings` (`db/queries.rs:526`) already tolerates unknown keys via its `_ => {}`
arm and builds on `Settings::default()`.

Touch points:
- `Settings` struct (`db/mod.rs`): add `kindle_email: String`, default `""`.
- `get_settings`: add `"kindle_email" => settings.kindle_email = value`.
- `update_settings` (`commands/settings.rs:161`): accept and persist it.
- Settings page: a text input beside the Ollama fields, following the existing
  `bind:value` + `saveSettings()` pattern.

An empty string means "not configured" and is a first-class state, not an error.

### 4.2 Command: `send_book_to_kindle(book_id: i64)`

Takes the book id, not a path, so the command re-reads the current path from the
database rather than trusting whatever the frontend last rendered.

Guard chain, evaluated in order. Each arm returns a distinct, actionable message:

| # | Check | Message on failure |
|---|---|---|
| 1 | `kindle_email` non-empty | `Set your Kindle address in Settings` |
| 2 | book row exists | `That book is no longer in your library` |
| 3 | file exists on disk | `File not found — is the external drive connected?` |
| 4 | size ≤ 50 MB | `Kindle rejects attachments over 50 MB (this book is 62 MB)` |

Ordering is deliberate: the cheap configuration checks run before the filesystem
`stat`, and nothing launches Mail until every precondition holds.

Check 3 is the one that matters most in practice — see §2.

**There is deliberately no "does Mail have an account" precheck.** An earlier draft of
this spec proposed probing `~/Library/Mail`. That path is TCC-protected: reading it
returns `Operation not permitted` even to the user's own shell, so the probe cannot
distinguish "no account" from "not permitted", and attempting it would either fail
spuriously or provoke a privacy prompt for no benefit. Mail-side problems surface
through the AppleScript's own error instead (§5), which is both accurate and already
required for the cases a precheck could never catch — no *sendable* account, Mail
refusing, the user cancelling.

The 50 MB limit lives in one named constant, `KINDLE_MAX_ATTACHMENT_BYTES`.

### 4.3 AppleScript

Standard `make new outgoing message` → `to recipient` → `attachment`, with
`visible:true` so the draft appears for review.

**The script takes `on run argv` and receives the path, address and subject as
arguments. It does not interpolate them into the script text.** This is not
stylistic. The library is largely Spanish-language with titles such as
`¿Crees en el amor a primera vista?` and `Sálvenme de la Navidad`, and paths contain
apostrophes and accented characters; naive interpolation breaks on quote characters
and is an injection vector. Arguments sidestep both.

The path is passed as a POSIX path and converted inside the script.

### 4.4 Frontend

One button in the unguarded action block of `BookDetail.svelte`, styled
`btn-secondary` to sit under the primary **Open Book**, labelled *Send to Kindle*.

Both it and `openFile()` route failures through one shared error path, following the
component's existing `llmError` precedent: a `string | null` rendered inline in
`var(--gw-error)` (see `BookDetail.svelte:69`, displayed at `:332-334`).

Inline rather than the `toast.error(...)` used on the settings page, because these
messages are *instructions* — "Set your Kindle address in Settings", "is the external
drive connected?" — and the user needs them to persist while acting on them, not
fade after three seconds.

The button is disabled while a send is in flight, mirroring the existing
`isTogglingUpNext` guard.

---

## 5. Error handling

Every failure above is a *message*, never a silent no-op — that defect is the reason
this spec exists. Errors are shown inline in the detail panel rather than as a
`console.error`, since the user cannot see the console.

The AppleScript's own failure (Mail refuses, no sendable account, user cancels) is
caught and surfaced verbatim from `osascript`'s stderr rather than replaced with a
generic string, so a mail-side problem stays diagnosable.

---

## 6. Testing & verification

Pure validation is extracted so it is testable without touching Mail:

```rust
fn validate_send(path: &Path, addr: &str) -> Result<(), SendError>
```

It stats the file itself rather than taking a size parameter — a caller cannot
supply a size for a file that does not exist, so splitting the two would make the
missing-file and oversize checks awkward to order. `tempfile` gives the tests real
files to stat.

This covers guards 1, 3 and 4 plus address format. Guard 2 (book row exists) is a
database lookup, so it stays in the command and is exercised by the manual
verification rather than a unit test.

Rust unit tests, using `tempfile` as the existing suite does:

- unset address → `SendError::NoKindleAddress`
- malformed address (no `@`) → `SendError::InvalidAddress`
- missing file → `SendError::FileMissing` *(the unmounted-drive case)*
- size exactly at the limit → accepted (boundary)
- size one byte over → `SendError::TooLarge`, message quotes the actual size

The AppleScript is **verified manually**, once, against a configured Mail.app: a draft
must open with the correct recipient and the EPUB genuinely attached. It will not be
reported as working before that has been observed — an `osascript` exit code of 0 is
not evidence the attachment landed.

---

## 7. Implementation order

1. `kindle_email` setting: struct field, `get_settings` arm, `update_settings`, UI input.
2. `validate_send` + its unit tests (no Mail involvement).
3. `send_book_to_kindle` command wiring the guard chain to the AppleScript.
4. Button + shared error surfacing in `BookDetail.svelte`, including the `try`/`catch`
   fix for `openFile()`.
5. Manual verification of a real draft with a real attachment.

---

## 8. Open questions (defaults chosen; flag if wrong)

- **Subject line** defaults to the book title alone. Amazon ignores the subject for
  Send-to-Kindle; using the title keeps the sent-mail folder readable.
- **Body** is left empty. Amazon ignores it.
- **Platform:** macOS only. `tauri.conf.json` sets `"targets": "all"`, but the existing
  `open_file_with_default_app` already shells to macOS `open`, so the app is already
  macOS-bound in practice. This spec does not widen or fix that.
