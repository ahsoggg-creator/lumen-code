//! Model Context Protocol transport (stdio): starts an MCP server and relays its newline-delimited JSON messages.
//! The protocol itself lives in the UI (`src/ai/mcp.ts`).

use crate::util::command;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Mcps(Mutex<HashMap<String, Server>>);

struct Server {
    stdin: ChildStdin,
    child: Child,
}

/// Starts `program`; every stdout line is an `mcp-msg` event, stderr goes to `mcp-log`, the end of the process to `mcp-exit`.
#[tauri::command(async)]
pub fn mcp_spawn(app: AppHandle, mcps: State<'_, Mcps>, id: String, program: String, args: Vec<String>, cwd: Option<String>, env: Option<HashMap<String, String>>) -> Result<(), String> {
    let mut c = command(&program);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    if let Some(env) = env {
        c.envs(env);
    }
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take().ok_or("нет stdin у MCP-сервера")?;
    let stdout = child.stdout.take().ok_or("нет stdout у MCP-сервера")?;
    let stderr = child.stderr.take().ok_or("нет stderr у MCP-сервера")?;
    if let Some(mut old) = mcps.0.lock().unwrap().insert(id.clone(), Server { stdin, child }) {
        let _ = old.child.kill();
    }
    let (app_err, id_err) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("mcp-log", json!({ "id": id_err, "line": l }));
        }
    });
    std::thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !l.trim().is_empty() {
                let _ = app.emit("mcp-msg", json!({ "id": id, "msg": l }));
            }
        }
        let _ = app.emit("mcp-exit", json!({ "id": id }));
    });
    Ok(())
}

/// `msg` is one JSON object without line breaks.
#[tauri::command(async)]
pub fn mcp_send(mcps: State<'_, Mcps>, id: String, msg: String) -> Result<(), String> {
    let mut map = mcps.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("MCP-сервер не запущен")?;
    s.stdin.write_all(msg.replace(['\r', '\n'], " ").as_bytes()).and_then(|_| s.stdin.write_all(b"\n")).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn mcp_close(mcps: State<'_, Mcps>, id: String) {
    if let Some(mut s) = mcps.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}
