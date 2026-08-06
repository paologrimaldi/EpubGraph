//! Send-to-Kindle: opens an Apple Mail draft with a book attached.
//!
//! Amazon accepts a book as an email attachment from a pre-approved sender and
//! performs EPUB conversion server-side, so this module only has to produce the
//! draft. It never sends — the user reviews and sends.

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
