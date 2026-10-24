#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapters;
mod ast;
mod assoc;
mod dap;
mod db;
mod decode;
mod fsx;
mod git;
mod history;
mod lsp;
mod mcp;
mod net;
mod perf;
mod python;
mod rpc;
mod sandbox;
mod search;
mod serial;
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

#[tauri::command]
fn is_headless() -> bool {
    std::env::var_os("LUMEN_HEADLESS").is_some()
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
        .manage(lsp::Lsps::default())
        .manage(mcp::Mcps::default())
        .manage(history::History::default())
        .manage(serial::Serials::default())
        .manage(sandbox::Sandboxes::default())
        .manage(perf::Perf::default())
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
            is_headless,
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
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_close,
            adapters::adapter_info,
            adapters::adapter_install,
            mcp::mcp_spawn,
            mcp::mcp_send,
            mcp::mcp_close,
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
            history::history_save,
            history::history_list,
            history::history_get,
            history::history_clear,
            history::history_clear_all,
            sandbox::sandbox_run,
            sandbox::sandbox_cancel,
            db::db_tables,
            db::db_page,
            db::db_query,
            db::db_exec,
            db::db_update_cell,
            decode::decode_backtrace,
            perf::term_stats,
            net::http_send,
            serial::serial_ports,
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
            ast::ast_outline,
            ast::ast_search,
            ast::ast_replace,
            ast::scratch_instrument,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lumen Code");
}
