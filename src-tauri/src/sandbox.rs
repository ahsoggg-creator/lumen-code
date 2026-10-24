//! Runs scratchpad code (Python, Lua) under a Windows Job Object: the whole process tree dies on timeout, on cancel
//! and when the editor exits, and the job has a memory ceiling and a limit on the number of processes.
//! Output is capped, so a runaway `print` loop cannot fill the editor's memory.

use crate::tasks::prepare;
use crate::util::ExecOut;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

const OUT_CAP: usize = 1 << 20;

/// `jobs` holds the live Job Object of each run; whoever removes an entry from it is the only one that closes the handle,
/// so a handle is never closed twice. `early` remembers a cancel that arrived before its run registered its job.
#[derive(Default)]
pub struct Sandboxes {
    jobs: Mutex<HashMap<String, usize>>,
    early: Mutex<HashSet<String>>,
}

fn drain_capped<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let (mut kept, mut buf) = (Vec::new(), [0u8; 8192]);
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            if kept.len() < OUT_CAP {
                kept.extend_from_slice(&buf[..n.min(OUT_CAP - kept.len())]);
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;

    pub fn create(mem_bytes: usize) -> Option<usize> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = 32;
            info.JobMemoryLimit = mem_bytes;
            let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            if ok == 0 {
                CloseHandle(h);
                return None;
            }
            Some(h as usize)
        }
    }

    pub fn assign(job: usize, child: &Child) -> bool {
        unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) != 0 }
    }

    /// Closing the handle terminates every process still in the job.
    pub fn close(job: usize) {
        unsafe {
            CloseHandle(job as HANDLE);
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn create(_: usize) -> Option<usize> {
        None
    }
    pub fn assign(_: usize, _: &std::process::Child) -> bool {
        false
    }
    pub fn close(_: usize) {}
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn sandbox_run(
    sb: State<'_, Sandboxes>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: u64,
    mem_mb: u64,
) -> ExecOut {
    let fail = |m: String| ExecOut { code: -1, stdout: String::new(), stderr: m };
    let mut child = match prepare(&program, &args, &cwd, &env.unwrap_or_default()).spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("{program}: {e}")),
    };
    let job = job::create((mem_mb as usize) << 20).filter(|j| job::assign(*j, &child));
    match job {
        Some(j) => {
            sb.jobs.lock().unwrap().insert(id.clone(), j);
        }
        None => {} // without a job only the direct child can be stopped (taskkill below covers the tree)
    }
    let out = drain_capped(child.stdout.take().unwrap());
    let err = drain_capped(child.stderr.take().unwrap());
    let start = Instant::now();
    let mut note = "";
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(-1),
            Ok(None) => {
                let early = sb.early.lock().unwrap().remove(&id);
                let cancelled = early || (job.is_some() && !sb.jobs.lock().unwrap().contains_key(&id));
                if cancelled || start.elapsed() > Duration::from_millis(timeout_ms) {
                    note = if cancelled { "[cancelled]" } else { "[timed out]" };
                    stop_tree(&sb, &id, &child);
                    let _ = child.kill();
                    let _ = child.wait();
                    break -1;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break -1,
        }
    };
    // Normal exit: drop the job (and anything the program left running) unless a cancel already did.
    if let Some(j) = sb.jobs.lock().unwrap().remove(&id) {
        job::close(j);
    }
    sb.early.lock().unwrap().remove(&id);
    let stdout = out.join().unwrap_or_default();
    let mut stderr = err.join().unwrap_or_default();
    if !note.is_empty() {
        stderr.push_str(&format!("\n{note}"));
    }
    ExecOut { code, stdout, stderr }
}

/// Ends the whole process tree of a run: through its job when it has one, with `taskkill /T` otherwise.
fn stop_tree(sb: &Sandboxes, id: &str, child: &std::process::Child) {
    match sb.jobs.lock().unwrap().remove(id) {
        Some(j) => job::close(j),
        None => {
            #[cfg(windows)]
            let _ = crate::util::command("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
            #[cfg(not(windows))]
            let _ = child;
        }
    }
}

/// Stops a running sandbox job (and every process it started). A cancel that beats its run to the registry is remembered.
#[tauri::command(async)]
pub fn sandbox_cancel(sb: State<'_, Sandboxes>, id: String) {
    match sb.jobs.lock().unwrap().remove(&id) {
        Some(j) => job::close(j),
        None => {
            sb.early.lock().unwrap().insert(id);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn run(sb: &Sandboxes, args: &[&str], timeout: u64) -> (ExecOut, Duration) {
        let started = Instant::now();
        // The same body as `sandbox_run`, called without a Tauri `State`.
        let mut child = prepare("cmd", &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &None, &HashMap::new()).spawn().unwrap();
        let j = job::create(256 << 20).unwrap();
        assert!(job::assign(j, &child));
        sb.jobs.lock().unwrap().insert("t".into(), j);
        let out = drain_capped(child.stdout.take().unwrap());
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if started.elapsed() > Duration::from_millis(timeout) {
                job::close(j);
                let _ = child.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        let _ = child.wait();
        (ExecOut { code: 0, stdout: out.join().unwrap(), stderr: String::new() }, started.elapsed())
    }

    #[test]
    fn job_kills_the_whole_tree_on_timeout() {
        let sb = Sandboxes::default();
        // cmd starts ping (a grandchild) that would run for ~30 s.
        let (_, took) = run(&sb, &["/c", "ping -n 30 127.0.0.1 > nul"], 400);
        assert!(took < Duration::from_secs(5), "took {took:?}");
    }

    #[test]
    fn output_is_capped() {
        let sb = Sandboxes::default();
        let (out, _) = run(&sb, &["/c", "for /l %i in (1,1,200000) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], 20000);
        assert!(out.stdout.len() <= OUT_CAP);
    }
}
