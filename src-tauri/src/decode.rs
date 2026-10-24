//! ESP32 / Arduino crash decoder: turns the raw addresses of a `Backtrace:` line into function, file and line
//! with the toolchain's `addr2line` and the project's .elf.

use crate::util::command;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Debug, PartialEq)]
pub struct Frame {
    pub addr: String,
    pub func: String,
    pub file: String,
    pub line: u32,
}

/// Parses `addr2line -pfiaC` output: `0x400d1234: app_main at C:/p/main.cpp:12` plus `(inlined by) …` lines.
pub fn parse(out: &str) -> Vec<Frame> {
    let mut frames = Vec::new();
    let mut addr = String::new();
    for raw in out.lines() {
        let mut rest = raw.trim();
        if let Some(r) = rest.strip_prefix("(inlined by)") {
            rest = r.trim();
        } else if rest.starts_with("0x") {
            let Some((a, r)) = rest.split_once(": ") else { continue };
            addr = a.to_string();
            rest = r;
        } else {
            continue;
        }
        let Some((func, loc)) = rest.rsplit_once(" at ") else { continue };
        let Some((file, line)) = loc.rsplit_once(':') else { continue };
        let line: u32 = line.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if file.starts_with("??") || line == 0 {
            continue;
        }
        frames.push(Frame { addr: addr.clone(), func: func.to_string(), file: file.to_string(), line });
    }
    frames
}

fn valid_addr(a: &str) -> bool {
    a.len() > 2 && a.len() <= 18 && a.starts_with("0x") && a[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// addr2line builds shipped with the ESP32 Arduino core, PlatformIO and ESP-IDF.
fn candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(l).join("Arduino15").join("packages"));
    }
    if let Some(h) = std::env::var_os("USERPROFILE") {
        let h = PathBuf::from(h);
        roots.push(h.join(".platformio").join("packages"));
        roots.push(h.join(".espressif").join("tools"));
    }
    let mut out = Vec::new();
    for r in roots.into_iter().filter(|r| r.is_dir()) {
        for e in WalkBuilder::new(r).max_depth(Some(8)).standard_filters(false).build().flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if n.ends_with("addr2line.exe") && (n.contains("xtensa") || n.contains("riscv")) {
                out.push(e.into_path());
            }
        }
    }
    out
}

#[tauri::command(async)]
pub fn decode_backtrace(elf: String, addrs: Vec<String>) -> Result<Vec<Frame>, String> {
    if !std::path::Path::new(&elf).is_file() {
        return Err(format!("нет файла .elf: {elf}"));
    }
    let addrs: Vec<String> = addrs.into_iter().filter(|a| valid_addr(a)).take(64).collect();
    if addrs.is_empty() {
        return Ok(Vec::new());
    }
    let tools = candidates();
    if tools.is_empty() {
        return Err("addr2line не найден: установите ядро ESP32 в Arduino IDE/arduino-cli или PlatformIO".into());
    }
    let mut best = Vec::new();
    for t in tools {
        let Ok(o) = command(&t.to_string_lossy()).args(["-pfiaC", "-e", &elf]).args(&addrs).output() else { continue };
        let frames = parse(&String::from_utf8_lossy(&o.stdout));
        if frames.len() > best.len() {
            best = frames;
        }
        // The right architecture resolves every address; stop at the first complete answer.
        if best.len() >= addrs.len() {
            break;
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frames_and_inlines() {
        let out = "0x400d1234: app_main at C:/p/main.cpp:12\n0x40081234: ?? ??:0\n0x400d5678: loop at C:/p/sk.ino:30 (discriminator 2)\n(inlined by) run at C:/p/sk.ino:50\n";
        let f = parse(out);
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].addr.as_str(), f[0].func.as_str(), f[0].line), ("0x400d1234", "app_main", 12));
        assert_eq!(f[1].line, 30);
        assert_eq!((f[2].addr.as_str(), f[2].func.as_str(), f[2].file.as_str()), ("0x400d5678", "run", "C:/p/sk.ino"));
    }

    #[test]
    fn only_plain_hex_addresses_pass() {
        assert!(valid_addr("0x400d1234"));
        assert!(!valid_addr("--help") && !valid_addr("0x") && !valid_addr("0xZZ") && !valid_addr("0x1; calc"));
    }
}
