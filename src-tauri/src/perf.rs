//! Run-time HUD: memory and CPU of whatever a terminal's shell started (the program that "Run" launched).

use crate::term::Terms;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

pub struct Perf(Mutex<System>);

impl Default for Perf {
    fn default() -> Self {
        Perf(Mutex::new(System::new()))
    }
}

#[derive(Serialize)]
pub struct Stats {
    running: bool,
    procs: usize,
    mem_mb: f64,
    cpu: f64,
}

/// Programs that live under the shell but are not the user's program.
const NOISE: [&str; 3] = ["conhost.exe", "openconsole.exe", "wslhost.exe"];

#[tauri::command(async)]
pub fn term_stats(perf: State<'_, Perf>, terms: State<'_, Terms>, id: u32) -> Option<Stats> {
    let shell = terms.pid_of(id)?;
    let mut sys = perf.0.lock().ok()?;
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut tree: HashSet<Pid> = HashSet::from([Pid::from_u32(shell)]);
    loop {
        let grown: Vec<Pid> = sys
            .processes()
            .iter()
            .filter(|(pid, p)| !tree.contains(pid) && p.parent().is_some_and(|pp| tree.contains(&pp)))
            .filter(|(_, p)| !NOISE.contains(&p.name().to_string_lossy().to_lowercase().as_str()))
            .map(|(pid, _)| *pid)
            .collect();
        if grown.is_empty() {
            break;
        }
        tree.extend(grown);
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let (mut mem, mut cpu, mut n) = (0u64, 0f64, 0usize);
    for pid in tree.iter().filter(|p| p.as_u32() != shell) {
        if let Some(p) = sys.process(*pid) {
            mem += p.memory();
            cpu += p.cpu_usage() as f64;
            n += 1;
        }
    }
    Some(Stats { running: n > 0, procs: n, mem_mb: mem as f64 / 1048576.0, cpu: cpu / cores })
}
