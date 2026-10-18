//! Language Server Protocol transport: starts a language server and relays its framed JSON over stdio.
//! The protocol itself lives in the UI (`src/lsp`).

use crate::rpc::{frame, read_frames};
use crate::util::command;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Lsps(Mutex<HashMap<String, Server>>);

struct Server {
    stdin: ChildStdin,
    child: Child,
}

/// Starts `program` and forwards every message it writes as an `lsp-msg` event (`lsp-log` for stderr, `lsp-exit` at the end).
#[tauri::command(async)]
pub fn lsp_spawn(app: AppHandle, lsps: State<'_, Lsps>, id: String, program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let mut c = command(&program);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take().ok_or("нет stdin у языкового сервера")?;
    let stdout = child.stdout.take().ok_or("нет stdout у языкового сервера")?;
    let stderr = child.stderr.take().ok_or("нет stderr у языкового сервера")?;
    if let Some(old) = lsps.0.lock().unwrap().insert(id.clone(), Server { stdin, child }) {
        let mut old = old;
        let _ = old.child.kill();
    }
    let (app_err, id_err) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("lsp-log", json!({ "id": id_err, "line": l }));
        }
    });
    std::thread::spawn(move || {
        read_frames(stdout, |m| {
            let _ = app.emit("lsp-msg", json!({ "id": id, "msg": m }));
        });
        let _ = app.emit("lsp-exit", json!({ "id": id }));
    });
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_send(lsps: State<'_, Lsps>, id: String, msg: String) -> Result<(), String> {
    let mut map = lsps.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("языковой сервер не запущен")?;
    s.stdin.write_all(&frame(&msg)).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn lsp_close(lsps: State<'_, Lsps>, id: String) {
    if let Some(mut s) = lsps.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}
