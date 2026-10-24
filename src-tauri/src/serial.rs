//! Serial monitor transport: lists COM ports, opens one at a baud rate and streams what the device sends as `serial-data` events.

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

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
        while !stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Emit only complete UTF-8 sequences; keep a split trailing character for the next read.
                    let cut = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let chunk: Vec<u8> = pending.drain(..cut).collect();
                    if !chunk.is_empty() {
                        let _ = app.emit("serial-data", json!({ "id": id, "data": String::from_utf8_lossy(&chunk) }));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    let _ = app.emit("serial-exit", json!({ "id": id, "error": e.to_string() }));
                    return;
                }
            }
        }
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
