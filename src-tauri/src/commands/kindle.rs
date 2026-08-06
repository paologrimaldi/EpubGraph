//! Send-to-Kindle: opens an Apple Mail draft with a book attached.
//!
//! Amazon accepts a book as an email attachment from a pre-approved sender and
//! performs EPUB conversion server-side, so this module only has to produce the
//! draft. It never sends — the user reviews and sends.

use crate::state::AppState;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

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
    /// Actionable text shown directly in the book detail panel. Every one of
    /// these tells the user what to do about it — a silent no-op is the defect
    /// this feature exists to remove.
    pub fn user_message(&self) -> String {
        match self {
            SendError::NoKindleAddress => "Set your Kindle address in Settings".to_string(),
            SendError::InvalidAddress(a) => format!("\"{}\" is not a valid email address", a),
            SendError::FileMissing(_) => {
                "File not found — is the external drive connected?".to_string()
            }
            SendError::TooLarge { actual } => format!(
                "Kindle rejects attachments over 50 MB (this book is {} MB)",
                actual / (1024 * 1024)
            ),
        }
    }
}

/// Guard chain, cheapest first: the configuration checks run before the
/// filesystem stat, and nothing launches Mail until every one of them holds.
///
/// Stats the file itself rather than taking a size parameter — a caller cannot
/// supply a size for a file that does not exist, so splitting the two would make
/// the missing-file and oversize checks awkward to order.
pub fn validate_send(path: &Path, addr: &str) -> Result<(), SendError> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Err(SendError::NoKindleAddress);
    }

    // Deliberately loose — Amazon is the real validator. This only catches
    // obvious typos before we bother opening Mail.
    let plausible = addr.contains('@')
        && !addr.starts_with('@')
        && !addr.ends_with('@')
        && !addr.contains(char::is_whitespace);
    if !plausible {
        return Err(SendError::InvalidAddress(addr.to_string()));
    }

    let meta = std::fs::metadata(path)
        .map_err(|_| SendError::FileMissing(path.display().to_string()))?;
    if meta.len() > KINDLE_MAX_ATTACHMENT_BYTES {
        return Err(SendError::TooLarge { actual: meta.len() });
    }

    Ok(())
}

/// Receives path/address/subject via `on run argv` so nothing is interpolated
/// into the script text. This is not stylistic: book paths here contain
/// apostrophes and accented characters (the library is largely Spanish-language,
/// e.g. `¿Crees en el amor a primera vista?`), which would both break naive
/// interpolation and open an injection hole.
/// The explicit `with timeout` is not decorative. AppleScript's default AppleEvent
/// timeout is 120s, and the *first* time an app scripts Mail, macOS shows an
/// Automation consent dialog that blocks the event until the user answers it.
/// Observed during development: the first attempt died with
/// `AppleEvent timed out (-1712)` purely because the prompt sat unanswered, and a
/// draft was left half-built with the recipient set but no attachment. Once
/// consent is granted the whole thing runs in ~0.6s. EpubGraph will trigger its
/// own consent prompt on first use, so this guard is what stops that first run
/// from failing.
const MAIL_DRAFT_SCRIPT: &str = r#"
on run argv
    set filePath to item 1 of argv
    set toAddress to item 2 of argv
    set msgSubject to item 3 of argv
    tell application "Mail"
        with timeout of 600 seconds
            set newMessage to make new outgoing message with properties {subject:msgSubject, content:"", visible:true}
            tell newMessage
                make new to recipient at end of to recipients with properties {address:toAddress}
                tell content
                    make new attachment with properties {file name:(POSIX file filePath)} at after the last paragraph
                end tell
            end tell
            activate
        end timeout
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
        // Surface Mail's own error verbatim rather than replacing it with a
        // generic string, so a mail-side problem stays diagnosable. This is also
        // why there is no "does Mail have an account" precheck: ~/Library/Mail is
        // TCC-protected and returns "Operation not permitted" even to the user's
        // own shell, so a probe could not tell "no account" from "not permitted".
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Apple Mail could not create the draft".to_string()
        } else {
            stderr
        });
    }

    Ok(())
}

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

    // Guard 1 up front, so an unconfigured address costs no database work.
    if addr.is_empty() {
        return Err(SendError::NoKindleAddress.user_message());
    }

    // Guard 2.
    let book = state
        .db
        .get_book(book_id)
        .map_err(|_| "That book is no longer in your library".to_string())?;

    // Guards 3 and 4 (plus address format again, keeping validate_send whole).
    validate_send(Path::new(&book.path), &addr).map_err(|e| e.user_message())?;

    open_mail_draft(&book.path, &addr, &book.title)
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

    /// The intermittent-external-drive case. Over one session the volume holding
    /// all 70,266 books went mounted -> absent (0/200 paths resolving) -> mounted
    /// again, so this is a window a user can hit through no fault of their own.
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
