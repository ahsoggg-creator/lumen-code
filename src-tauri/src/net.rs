//! Everything that talks to the network: generic HTTP for AI providers and plugins, SSE streaming, and the OS keychain.
//! All requests go through here so the webview itself never needs `connect-src` to the internet.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub fn agent(global_secs: Option<u64>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_global(global_secs.map(Duration::from_secs))
        .http_status_as_error(false)
        .user_agent(format!("LumenCode/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

pub fn with_retries<T>(mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

pub fn get_text(url: &str) -> Result<String, String> {
    with_retries(|| {
        let mut r = agent(Some(60)).get(url).header("Accept", "application/json").call().map_err(|e| e.to_string())?;
        let status = r.status().as_u16();
        let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
        if status >= 400 {
            return Err(format!("HTTP {status}"));
        }
        Ok(body)
    })
}

#[derive(Serialize)]
pub struct HttpResp {
    status: u16,
    body: String,
}

#[derive(Deserialize)]
pub struct HttpReq {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
}

fn send(a: &ureq::Agent, req: &HttpReq) -> Result<ureq::http::Response<ureq::Body>, String> {
    let method = req.method.as_deref().unwrap_or(if req.body.is_some() { "POST" } else { "GET" }).to_ascii_uppercase();
    if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    match method.as_str() {
        "GET" | "DELETE" | "HEAD" => {
            let mut b = if method == "GET" { a.get(&req.url) } else if method == "DELETE" { a.delete(&req.url) } else { a.head(&req.url) };
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            b.call().map_err(|e| e.to_string())
        }
        "POST" | "PUT" | "PATCH" => {
            let mut b = match method.as_str() {
                "POST" => a.post(&req.url),
                "PUT" => a.put(&req.url),
                _ => a.patch(&req.url),
            };
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            b.send(req.body.clone().unwrap_or_default()).map_err(|e| e.to_string())
        }
        m => Err(format!("unsupported method {m}")),
    }
}

#[tauri::command(async)]
pub fn http_request(req: HttpReq) -> Result<HttpResp, String> {
    let mut r = send(&agent(Some(120)), &req)?;
    let status = r.status().as_u16();
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(HttpResp { status, body })
}

#[derive(Deserialize)]
pub struct SendReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct SendResp {
    status: u16,
    reason: String,
    headers: Vec<(String, String)>,
    body: String,
    size: usize,
    time_ms: u64,
    truncated: bool,
}

const SEND_BODY_CAP: usize = 5 * 1024 * 1024;

/// REST-client request: any method and header list, with status line, headers, size and timing back (no browser CORS).
#[tauri::command(async)]
pub fn http_send(req: SendReq) -> Result<SendResp, String> {
    use std::io::Read;
    if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
        return Err("поддерживаются только http:// и https://".into());
    }
    let method: ureq::http::Method = req.method.to_ascii_uppercase().parse().map_err(|_| format!("неизвестный метод {}", req.method))?;
    let mut b = ureq::http::Request::builder().method(method).uri(&req.url);
    for (k, v) in &req.headers {
        b = b.header(k, v);
    }
    let agent = agent(Some(req.timeout_secs.unwrap_or(60).clamp(1, 600)));
    let started = std::time::Instant::now();
    let resp = match req.body.filter(|s| !s.is_empty()) {
        Some(body) => agent.run(b.body(body.into_bytes()).map_err(|e| e.to_string())?),
        None => agent.run(b.body(()).map_err(|e| e.to_string())?),
    }
    .map_err(|e| e.to_string())?;
    let status = resp.status();
    let headers = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_string())).collect();
    let mut bytes = Vec::new();
    resp.into_body().into_reader().take(SEND_BODY_CAP as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let time_ms = started.elapsed().as_millis() as u64;
    let truncated = bytes.len() > SEND_BODY_CAP;
    bytes.truncate(SEND_BODY_CAP);
    Ok(SendResp {
        status: status.as_u16(),
        reason: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        size: bytes.len(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        time_ms,
        truncated,
    })
}

#[derive(Default)]
pub struct Streams(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Streams the response line by line as `http-chunk` events (SSE/NDJSON), then `http-end`.
#[tauri::command(async)]
pub fn http_stream(app: AppHandle, streams: State<'_, Streams>, id: String, req: HttpReq) {
    let cancel = Arc::new(AtomicBool::new(false));
    streams.0.lock().unwrap().insert(id.clone(), cancel.clone());
    std::thread::spawn(move || {
        let end = |err: Option<String>, status: u16| {
            let _ = app.emit("http-end", json!({ "id": id, "error": err, "status": status }));
        };
        let resp = match send(&agent(None), &req) {
            Ok(r) => r,
            Err(e) => return end(Some(e), 0),
        };
        let status = resp.status().as_u16();
        let mut rd = BufReader::new(resp.into_body().into_reader());
        let mut buf = Vec::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return end(None, status);
            }
            buf.clear();
            match rd.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_owned();
                    let _ = app.emit("http-chunk", json!({ "id": id, "status": status, "line": line }));
                }
                Err(e) => return end(Some(e.to_string()), status),
            }
        }
        end(None, status);
    });
}

#[tauri::command(async)]
pub fn http_cancel(streams: State<'_, Streams>, id: String) {
    if let Some(c) = streams.0.lock().unwrap().remove(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("LumenCode", name).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_get(name: String) -> Option<String> {
    entry(&name).ok()?.get_password().ok()
}

#[tauri::command(async)]
pub fn secret_delete(name: String) {
    if let Ok(e) = entry(&name) {
        let _ = e.delete_credential();
    }
}
