//! Serial monitor transport: lists COM ports, opens one at a baud rate and streams what the device sends as `serial-data` events.

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// One event per frame, at most this much text per event; a longer burst keeps only its tail.
const EMIT_EVERY: Duration = Duration::from_millis(16);
const MAX_BATCH: usize = 64 * 1024;
/// A line the device never ends is split here so no consumer buffers it without bound.
const MAX_LINE: usize = 4096;

/// Inserts a line break wherever a line would exceed `MAX_LINE`; `line_len` carries the current line's length between chunks.
fn cap_line_len(chunk: &str, line_len: &mut usize) -> String {
    let mut out = String::with_capacity(chunk.len());
    for c in chunk.chars() {
        if c == '\n' {
            *line_len = 0;
        } else {
            if *line_len >= MAX_LINE {
                out.push('\n');
                *line_len = 0;
            }
            *line_len += 1;
        }
        out.push(c);
    }
    out
}

/// Keeps the last `max` bytes of `s` (on a character boundary) and returns how many bytes were dropped.
fn trim_front(s: &mut String, max: usize) -> usize {
    if s.len() <= max {
        return 0;
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    s.drain(..cut);
    cut
}

struct Conn {
    writer: Box<dyn serialport::SerialPort>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Serials(Mutex<HashMap<String, Conn>>);

#[derive(Serialize)]
pub struct PortInfo {
    name: String,
    kind: String,
}

#[tauri::command(async)]
pub fn serial_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| PortInfo {
            kind: match p.port_type {
                serialport::SerialPortType::UsbPort(u) => u.product.or(u.manufacturer).unwrap_or_else(|| "USB".into()),
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                _ => String::new(),
            },
            name: p.port_name,
        })
        .collect())
}

#[tauri::command(async)]
pub fn serial_open(app: AppHandle, state: State<'_, Serials>, id: String, port: String, baud: u32) -> Result<(), String> {
    serial_close(state.clone(), id.clone());
    let mut reader = serialport::new(&port, baud).timeout(Duration::from_millis(50)).open().map_err(|e| format!("{port}: {e}"))?;
    let writer = reader.try_clone().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    state.0.lock().unwrap().insert(id.clone(), Conn { writer, stop: stop.clone() });
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        let mut batch = String::new();
        let (mut line_len, mut dropped) = (0usize, 0usize);
        let mut last_emit = Instant::now();
        let flush = |batch: &mut String, dropped: &mut usize, last: &mut Instant| {
            if !batch.is_empty() || *dropped > 0 {
                let _ = app.emit("serial-data", json!({ "id": id, "data": std::mem::take(batch), "dropped": std::mem::take(dropped) }));
            }
            *last = Instant::now();
        };
        while !stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Only complete UTF-8 sequences go on; a split trailing character waits for the next read.
                    let cut = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let chunk: Vec<u8> = pending.drain(..cut).collect();
                    batch.push_str(&cap_line_len(&String::from_utf8_lossy(&chunk), &mut line_len));
                    let cut = trim_front(&mut batch, MAX_BATCH);
                    if cut > 0 {
                        dropped += cut;
                        line_len = 0;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    flush(&mut batch, &mut dropped, &mut last_emit);
                    let _ = app.emit("serial-exit", json!({ "id": id, "error": e.to_string() }));
                    return;
                }
            }
            // At most one event per frame (60 Hz) no matter how fast the device talks.
            if last_emit.elapsed() >= EMIT_EVERY {
                flush(&mut batch, &mut dropped, &mut last_emit);
            }
        }
        flush(&mut batch, &mut dropped, &mut last_emit);
        let _ = app.emit("serial-exit", json!({ "id": id, "error": null }));
    });
    Ok(())
}

#[tauri::command(async)]
pub fn serial_write(state: State<'_, Serials>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let c = map.get_mut(&id).ok_or("порт не открыт")?;
    c.writer.write_all(data.as_bytes()).and_then(|_| c.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn serial_close(state: State<'_, Serials>, id: String) {
    if let Some(c) = state.0.lock().unwrap().remove(&id) {
        c.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endless_line_is_split_across_chunks() {
        let mut len = 0;
        let a = cap_line_len(&"x".repeat(3000), &mut len);
        let b = cap_line_len(&"y".repeat(3000), &mut len);
        let all = format!("{a}{b}");
        assert!(all.split('\n').all(|l| l.chars().count() <= MAX_LINE));
        assert_eq!(all.replace('\n', "").len(), 6000);
    }

    #[test]
    fn newline_resets_the_counter() {
        let mut len = 0;
        let s = cap_line_len(&"ab\n".repeat(5000), &mut len);
        assert!(!s.contains("\n\n"));
    }

    #[test]
    fn burst_keeps_only_the_tail_on_a_char_boundary() {
        let mut s = "я".repeat(40_000);
        let dropped = trim_front(&mut s, MAX_BATCH);
        assert!(s.len() <= MAX_BATCH && dropped > 0 && s.chars().all(|c| c == 'я'));
    }
}
