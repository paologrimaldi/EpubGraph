// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use epub_graph_lib::commands;
use epub_graph_lib::state::AppState;
use std::sync::Arc;
use tauri::Manager;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    // Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "epub_graph=debug,tauri=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting EpubGraph...");

    // Initialize application state
    let app_state = Arc::new(AppState::new().expect("Failed to initialize app state"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Library commands
            commands::library::get_libraries,
            commands::library::add_library,
            commands::library::remove_library,
            commands::library::scan_library,
            commands::library::parse_metadata_batch,
            commands::library::cleanup_orphaned_books,
            // Book commands
            commands::books::query_books,
            commands::books::get_book,
            commands::books::update_book,
            commands::books::delete_book,
            commands::books::set_rating,
            commands::books::set_read_status,
            commands::books::get_cover_image,
            // Recommendation commands
            commands::recommendations::get_recommendations,
            commands::recommendations::get_personalized_recommendations,
            commands::recommendations::get_book_graph,
            // Ollama commands
            commands::ollama::get_ollama_status,
            commands::ollama::configure_ollama,
            commands::ollama::get_processing_status,
            commands::ollama::pause_processing,
            commands::ollama::resume_processing,
            commands::ollama::prioritize_book,
            commands::ollama::process_embeddings_batch,
            // Settings commands
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::get_database_path,
            commands::settings::get_database_stats,
            commands::settings::reset_database,
            commands::settings::clear_embeddings,
            commands::settings::get_database_path_preference,
            commands::settings::set_database_path_preference,
            commands::settings::rebuild_graph_edges,
            // Export commands
            commands::export::export_library,
            commands::export::import_library,
            commands::export::create_backup,
            commands::export::restore_backup,
        ])
        .setup(|app| {
            let state = app.state::<Arc<AppState>>();
            
            // Start background services
            let state_clone = state.inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = state_clone.start_background_services().await {
                    tracing::error!("Failed to start background services: {}", e);
                }
            });

            tracing::info!("EpubGraph initialized successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
