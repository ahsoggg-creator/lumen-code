use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Watch(Mutex<Option<RecommendedWatcher>>);

fn ignored(p: &Path) -> bool {
    p.components().any(|c| {
        let n = c.as_os_str().to_string_lossy();
        matches!(n.as_ref(), ".git" | "node_modules" | "target" | "__pycache__" | ".venv" | "venv" | "dist")
    })
}

/// Watches the workspace; changed paths are batched and emitted as one `fs-change` event every ~250 ms.
#[tauri::command(async)]
pub fn watch_root(app: AppHandle, state: State<'_, Watch>, root: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    *slot = None; // drops the old watcher, which also ends its batching thread
    let Some(root) = root else { return Ok(()) };
    let (tx, rx) = mpsc::channel::<String>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                if !ignored(&p) {
                    let _ = tx.send(p.to_string_lossy().into_owned());
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(p) => {
                    pending.insert(p);
                    if pending.len() < 2000 {
                        continue;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if !pending.is_empty() {
                let paths: Vec<String> = pending.drain().collect();
                let _ = app.emit("fs-change", json!({ "paths": paths }));
            }
        }
    });
    *slot = Some(w);
    Ok(())
}
