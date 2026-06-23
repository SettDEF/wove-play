mod analysis;
mod cast;
mod commands;
mod folder;
mod libdb;
mod media;
mod mpris;
mod native_audio;
mod stream;
mod taste;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(folder::init())
        .plugin(media::init())
        .setup(|app| {
            // Restore the taste engine from app-data and manage it (Phase 5 persistence).
            let base = app.path().app_data_dir().unwrap_or_default();
            app.manage(taste::TasteState::load(base.join("taste")));
            app.manage(analysis::AnalysisCache::load(base.join("analysis")));
            app.manage(libdb::LibDb::open(base.join("library.db"))); // SQLite library index (P2.9)
            app.manage(native_audio::NativeAudio::new());
            app.manage(mpris::Mpris::new()); // desktop OS media controls (MPRIS on Linux)
            // Linux: pre-build the audio engine off the UI thread. cpal's ALSA device enumeration can take
            // SECONDS here (jack/oss/dmix probe timeouts); doing it lazily inside the sync na_load command
            // froze the webview on first play (sync commands run on the GTK main thread). [perf]
            #[cfg(target_os = "linux")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let st: tauri::State<native_audio::NativeAudio> = handle.state();
                    native_audio::prewarm(st.inner());
                });
            }
            app.manage(stream::MediaServer::new());
            app.manage(cast::CastState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analysis::track_analysis,
            analysis::analyze_track,
            analysis::track_waveform,
            analysis::analyze_tracks,
            analysis::endless_set,
            analysis::dj_set,
            stream::stream_url,
            stream::stream_set_lan,
            stream::cast_url,
            cast::cast_discover,
            cast::cast_play,
            cast::cast_stop,
            native_audio::na_load,
            native_audio::na_play,
            native_audio::na_pause,
            native_audio::na_seek,
            native_audio::na_set_volume,
            native_audio::na_set_balance,
            native_audio::na_set_mono,
            native_audio::na_state,
            native_audio::na_set_eq,
            native_audio::na_set_tone,
            native_audio::na_set_vocal,
            native_audio::na_set_replaygain,
            native_audio::na_set_output,
            native_audio::na_load_next,
            native_audio::na_crossfade,
            native_audio::na_set_loop,
            native_audio::na_clear_loop,
            commands::debug_log,
            commands::scan_library,
            commands::scan_library_diff,
            commands::scan_library_stream,
            commands::tracks_meta,
            commands::write_tags,
            commands::set_cover,
            mpris::mpris_update,
            mpris::mpris_playback,
            mpris::mpris_clear,
            commands::http_get_bytes,
            commands::md5_hex,
            commands::cover_art,
            commands::cover_cache_clear,
            commands::read_lyrics,
            commands::library_cache_save,
            commands::library_cache_load,
            commands::library_cache_stream,
            commands::save_file,
            libdb::libdb_replace,
            libdb::libdb_upsert,
            libdb::libdb_clear,
            libdb::libdb_count,
            libdb::libdb_page,
            libdb::libdb_albums,
            libdb::libdb_artists,
            folder::pick_folder,
            folder::list_folder,
            folder::list_folder_stream,
            folder::start_indexing,
            folder::stop_indexing,
            folder::clear_index,
            folder::index_status,
            folder::read_index,
            folder::read_bytes,
            folder::cover_uri,
            folder::clear_cover_cache,
            folder::read_tags_uris,
            folder::media_store_scan,
            folder::has_media_permission,
            folder::request_media_permission,
            folder::media_store_folders,
            folder::open_url,
            folder::system_colors,
            media::media_start,
            media::media_update,
            media::media_stop,
            media::media_set_browse_tree,
            media::media_bt_has_permission,
            media::media_bt_request_permission,
            media::media_content_stream_url,
            media::media_set_app_icon,
            taste::taste_record_event,
            taste::taste_analyze_samples,
            taste::taste_analyze_samples_b64,
            taste::taste_analyze_paths,
            taste::taste_add_fingerprint,
            taste::taste_has_fingerprint,
            taste::taste_persist,
            taste::taste_score,
            taste::taste_scores,
            taste::taste_similar,
            taste::taste_vibe,
            taste::taste_explain,
            taste::taste_next,
            taste::taste_stations,
            taste::taste_station_tracks,
            taste::taste_recluster,
            taste::taste_clusters,
            taste::taste_generated_mixes,
            taste::taste_generate_recipe,
            taste::taste_create_recipe,
            taste::taste_recipes,
            taste::taste_maintain,
            taste::taste_reset,
            taste::taste_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WAVR Play");
}
