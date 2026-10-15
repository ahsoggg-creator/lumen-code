use crate::util::{command, ExecOut};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Tasks(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

fn prepare(program: &str, args: &[String], cwd: &Option<String>, env: &HashMap<String, String>) -> std::process::Command {
    let mut c = command(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8").env("PYTHONUNBUFFERED", "1");
    if let Some(d) = cwd.as_ref().filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    c
}

fn drain<R: Read + Send + 'static>(r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = BufReader::new(r).read_to_end(&mut s);
        String::from_utf8_lossy(&s).into_owned()
    })
}

/// Runs a program to completion (or until `timeout_ms`) and returns its output.
#[tauri::command(async)]
pub fn exec_capture(program: String, args: Vec<String>, cwd: Option<String>, env: Option<HashMap<String, String>>, timeout_ms: Option<u64>) -> ExecOut {
    run_capture(&program, &args, &cwd, &env.unwrap_or_default(), timeout_ms.unwrap_or(30_000))
}

pub fn run_capture(program: &str, args: &[String], cwd: &Option<String>, env: &HashMap<String, String>, timeout_ms: u64) -> ExecOut {
    let mut child = match prepare(program, args, cwd, env).spawn() {
        Ok(c) => c,
        Err(e) => return ExecOut { code: -1, stdout: String::new(), stderr: format!("{program}: {e}") },
    };
    let out = drain(child.stdout.take().unwrap());
    let err = drain(child.stderr.take().unwrap());
    let start = Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(-1),
            Ok(None) if start.elapsed() > Duration::from_millis(timeout_ms) => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break -1;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break -1,
        }
    };
    let stdout = out.join().unwrap_or_default();
    let mut stderr = err.join().unwrap_or_default();
    if timed_out {
        stderr.push_str("\n[timed out]");
    }
    ExecOut { code, stdout, stderr }
}

/// Starts a program and streams its output as `task-output` events; `task-exit` follows when it ends.
#[tauri::command(async)]
pub fn task_spawn(
    app: AppHandle,
    tasks: State<'_, Tasks>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let mut child = prepare(&program, &args, &cwd, &env.unwrap_or_default()).spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    tasks.0.lock().unwrap().insert(id.clone(), child.clone());

    let pump = |r: Box<dyn Read + Send>, stream: &'static str, app: AppHandle, id: String| {
        std::thread::spawn(move || {
            let mut rd = BufReader::new(r);
            let mut line = Vec::new();
            while let Ok(n) = rd.read_until(b'\n', &mut line) {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_owned();
                let _ = app.emit("task-output", json!({ "id": id, "stream": stream, "line": text }));
                line.clear();
            }
        })
    };
    let h1 = pump(Box::new(stdout), "stdout", app.clone(), id.clone());
    let h2 = pump(Box::new(stderr), "stderr", app.clone(), id.clone());
    std::thread::spawn(move || {
        let code = loop {
            let status = child.lock().unwrap().try_wait();
            match status {
                Ok(Some(s)) => break s.code().unwrap_or(-1),
                Ok(None) => std::thread::sleep(Duration::from_millis(60)),
                Err(_) => break -1,
            }
        };
        let _ = h1.join();
        let _ = h2.join();
        let _ = app.emit("task-exit", json!({ "id": id, "code": code }));
    });
    Ok(())
}

#[tauri::command(async)]
pub fn task_kill(tasks: State<'_, Tasks>, id: String) {
    if let Some(c) = tasks.0.lock().unwrap().remove(&id) {
        let _ = c.lock().unwrap().kill();
    }
}

#[tauri::command(async)]
pub fn task_forget(tasks: State<'_, Tasks>, id: String) {
    tasks.0.lock().unwrap().remove(&id);
}
