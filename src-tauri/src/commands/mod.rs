//! Tauri command handlers

pub mod books;
pub mod export;
pub mod kindle;
pub mod library;
pub mod ollama;
pub mod recommendations;
pub mod settings;
pub mod upnext;

#[tauri::command]
pub async fn open_file_with_default_app(path: String) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to open file: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}
