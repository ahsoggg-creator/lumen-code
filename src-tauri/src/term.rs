use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terms {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Term>>,
}

/// Splits off an incomplete UTF-8 tail so a multi-byte character is never cut between two events.
fn take_valid(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => {
            let s = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            return s;
        }
    };
    let rest = buf.split_off(valid);
    let s = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    s
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn term_open(
    app: AppHandle,
    terms: State<'_, Terms>,
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: HashMap<String, String>,
    path_prepend: Vec<String>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "LumenCode");
    for (k, v) in &env {
        cmd.env(k, v);
    }
    if !path_prepend.is_empty() {
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut parts: Vec<std::path::PathBuf> = path_prepend.iter().map(Into::into).collect();
        parts.extend(std::env::split_paths(&old));
        if let Ok(joined) = std::env::join_paths(parts) {
            cmd.env("PATH", joined);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{program}: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = terms.next.fetch_add(1, Ordering::Relaxed) + 1;
    terms.map.lock().unwrap().insert(id, Term { writer, master: pair.master, child });

    std::thread::spawn(move || {
        let mut raw = vec![0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut raw) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    let text = take_valid(&mut carry);
                    if !text.is_empty() {
                        let _ = app.emit("term-data", json!({ "id": id, "data": text }));
                    }
                }
            }
        }
        let _ = app.emit("term-exit", json!({ "id": id }));
    });
    Ok(id)
}

#[tauri::command(async)]
pub fn term_write(terms: State<'_, Terms>, id: u32, data: String) {
    if let Some(t) = terms.map.lock().unwrap().get_mut(&id) {
        let _ = t.writer.write_all(data.as_bytes());
        let _ = t.writer.flush();
    }
}

#[tauri::command(async)]
pub fn term_resize(terms: State<'_, Terms>, id: u32, cols: u16, rows: u16) {
    if let Some(t) = terms.map.lock().unwrap().get(&id) {
        let _ = t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command(async)]
pub fn term_close(terms: State<'_, Terms>, id: u32) {
    if let Some(mut t) = terms.map.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_is_carried() {
        let bytes = "дa".as_bytes().to_vec(); // д = D0 B4
        let mut buf = bytes[..1].to_vec();
        assert_eq!(take_valid(&mut buf), "");
        buf.extend_from_slice(&bytes[1..]);
        assert_eq!(take_valid(&mut buf), "дa");
        assert!(buf.is_empty());
    }
}
