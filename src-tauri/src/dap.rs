//! Debug Adapter Protocol transport: framed JSON over a TCP socket (e.g. debugpy started in a terminal)
//! or over the stdio of a spawned adapter. The protocol itself lives in the UI.

use crate::util::command;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Daps(Mutex<HashMap<String, Session>>);

struct Session {
    writer: Box<dyn Write + Send>,
    child: Option<Child>,
    stream: Option<TcpStream>,
}

pub fn frame(msg: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg).into_bytes()
}

fn read_frames<R: Read>(r: R, mut on_msg: impl FnMut(String)) {
    let mut rd = BufReader::new(r);
    loop {
        let mut len = 0usize;
        let mut line = String::new();
        loop {
            line.clear();
            match rd.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let t = line.trim();
            if t.is_empty() {
                break;
            }
            if let Some(v) = t.strip_prefix("Content-Length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        if len == 0 {
            continue;
        }
        let mut body = vec![0u8; len];
        if rd.read_exact(&mut body).is_err() {
            return;
        }
        on_msg(String::from_utf8_lossy(&body).into_owned());
    }
}

fn pump<R: Read + Send + 'static>(app: AppHandle, id: String, r: R) {
    std::thread::spawn(move || {
        read_frames(r, |m| {
            let _ = app.emit("dap-msg", json!({ "id": id, "msg": m }));
        });
        let _ = app.emit("dap-exit", json!({ "id": id }));
    });
}

/// Connects to a debug adapter that listens on a port, retrying until `timeout_ms` (the adapter may still be starting).
#[tauri::command(async)]
pub fn dap_connect(app: AppHandle, daps: State<'_, Daps>, id: String, host: String, port: u16, timeout_ms: u64) -> Result<(), String> {
    let start = Instant::now();
    let stream = loop {
        match TcpStream::connect((host.as_str(), port)) {
            Ok(s) => break s,
            Err(e) if start.elapsed() > Duration::from_millis(timeout_ms) => return Err(format!("не удалось подключиться к отладчику {host}:{port}: {e}")),
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    };
    let _ = stream.set_nodelay(true);
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let writer = stream.try_clone().map_err(|e| e.to_string())?;
    daps.0.lock().unwrap().insert(id.clone(), Session { writer: Box::new(writer), child: None, stream: Some(stream) });
    pump(app, id, reader);
    Ok(())
}

/// Starts an adapter that speaks DAP on stdin/stdout.
#[tauri::command(async)]
pub fn dap_spawn(app: AppHandle, daps: State<'_, Daps>, id: String, program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let mut c = command(&program);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app2.emit("dap-log", json!({ "id": id2, "line": l }));
        }
    });
    daps.0.lock().unwrap().insert(id.clone(), Session { writer: Box::new(stdin), child: Some(child), stream: None });
    pump(app, id, stdout);
    Ok(())
}

#[tauri::command(async)]
pub fn dap_send(daps: State<'_, Daps>, id: String, msg: String) -> Result<(), String> {
    let mut map = daps.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("сеанс отладки не найден")?;
    s.writer.write_all(&frame(&msg)).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dap_close(daps: State<'_, Daps>, id: String) {
    if let Some(mut s) = daps.0.lock().unwrap().remove(&id) {
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
        if let Some(st) = s.stream.as_ref() {
            let _ = st.shutdown(Shutdown::Both);
        }
    }
}

/// A TCP port nobody listens on right now.
#[tauri::command(async)]
pub fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_roundtrip() {
        let mut data = frame(r#"{"seq":1}"#);
        data.extend(frame(r#"{"seq":2,"текст":"привет"}"#));
        let mut got = Vec::new();
        read_frames(Cursor::new(data), |m| got.push(m));
        assert_eq!(got, vec![r#"{"seq":1}"#.to_string(), r#"{"seq":2,"текст":"привет"}"#.to_string()]);
    }

    #[test]
    fn truncated_frame_ends_cleanly() {
        let mut got = Vec::new();
        read_frames(Cursor::new(b"Content-Length: 50\r\n\r\n{}".to_vec()), |m| got.push(m));
        assert!(got.is_empty());
    }
}
