#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assoc;
mod dap;
mod fsx;
mod git;
mod net;
mod python;
mod search;
mod tasks;
mod term;
mod update;
mod vsix;
mod util;
mod watch;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

/// Shows the window once the UI has painted its first frame (avoids a white flash). `LUMEN_HEADLESS=1` keeps it hidden for tests.
#[tauri::command(async)]
fn app_ready(window: tauri::WebviewWindow) {
    if std::env::var_os("LUMEN_HEADLESS").is_none() {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    update::cleanup_old();
    let mut builder = tauri::Builder::default();
    // A second launch (e.g. "Open with Lumen Code") hands its arguments to the running window.
    // Skipped under LUMEN_HEADLESS so tests can run next to a normal instance.
    if std::env::var_os("LUMEN_HEADLESS").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv.into_iter().skip(1).filter(|a| !a.starts_with("--")).collect();
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = tauri::Emitter::emit(app, "open-paths", serde_json::json!({ "paths": paths }));
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(term::Terms::default())
        .manage(tasks::Tasks::default())
        .manage(net::Streams::default())
        .manage(watch::Watch::default())
        .manage(dap::Daps::default())
        .setup(|app| {
            if std::env::var_os("LUMEN_HEADLESS").is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            fsx::get_paths,
            fsx::read_dir,
            fsx::read_file,
            fsx::read_file_b64,
            fsx::write_file,
            fsx::create_dir,
            fsx::rename_path,
            fsx::delete_path,
            fsx::copy_path,
            fsx::path_exists,
            fsx::real_path,
            fsx::reveal_in_explorer,
            fsx::open_external,
            fsx::open_path,
            fsx::refresh_env,
            vsix::vsix_install,
            assoc::assoc_status,
            assoc::assoc_apply,
            assoc::assoc_remove_all,
            assoc::open_default_apps,
            dap::dap_connect,
            dap::dap_spawn,
            dap::dap_send,
            dap::dap_close,
            dap::free_port,
            search::search_text,
            search::replace_in_files,
            search::list_files,
            git::git_status,
            git::git_show,
            git::git_diff_hunks,
            git::git_log,
            git::git_exec,
            term::term_open,
            term::term_write,
            term::term_resize,
            term::term_close,
            tasks::exec_capture,
            tasks::task_spawn,
            tasks::task_kill,
            tasks::task_forget,
            python::py_discover,
            python::pypi_info,
            net::http_request,
            net::http_stream,
            net::http_cancel,
            net::secret_set,
            net::secret_get,
            net::secret_delete,
            update::app_version,
            update::update_check,
            update::update_install,
            watch::watch_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lumen Code");
}
