//! Self-update from GitHub Releases. Nothing happens in the background unless the user enabled the daily check:
//! one request to `api.github.com`. Downloading starts only when the user agrees; the file replaces the running
//! executable only if its SHA-256 matches the published `SHA256SUMS.txt`.

use crate::net::{agent, get_text, with_retries};
use crate::util::command;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "ahsoggg-creator/lumen-code";
const ASSET: &str = "LumenCode.exe";
const DOWNLOAD_PREFIX: &str = "https://github.com/ahsoggg-creator/lumen-code/";
const MAX_DOWNLOAD: u64 = 300 << 20;

type Version = (u32, u32, u32);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Release {
    tag: String,
    version: String,
    notes: String,
    exe_url: String,
    sums_url: String,
    size: u64,
    page: String,
}

pub fn parse_version(s: &str) -> Option<Version> {
    let mut it = s.trim().trim_start_matches(['v', 'V']).split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next().unwrap_or("0").split(['-', '+']).next()?.parse().ok()?;
    Some((major, minor, patch))
}

pub fn parse_release(json: &str) -> Result<(Version, Release), String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("bad release JSON: {e}"))?;
    let tag = v["tag_name"].as_str().ok_or("release has no tag")?.to_owned();
    let version = parse_version(&tag).ok_or_else(|| format!("cannot read version from tag '{tag}'"))?;
    let find = |name: &str| v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == name));
    let url = |name: &str| find(name).and_then(|x| x["browser_download_url"].as_str()).map(str::to_owned);
    let exe_url = url(ASSET).ok_or_else(|| format!("release has no {ASSET}"))?;
    let sums_url = url("SHA256SUMS.txt").ok_or("release has no SHA256SUMS.txt")?;
    for u in [&exe_url, &sums_url] {
        if !u.starts_with(DOWNLOAD_PREFIX) {
            return Err(format!("refusing to download from an unexpected address: {u}"));
        }
    }
    let size = find(ASSET).and_then(|x| x["size"].as_u64()).unwrap_or(0);
    Ok((
        version,
        Release {
            version: format!("{}.{}.{}", version.0, version.1, version.2),
            notes: v["body"].as_str().unwrap_or("").to_owned(),
            page: v["html_url"].as_str().unwrap_or("").to_owned(),
            tag,
            exe_url,
            sums_url,
            size,
        },
    ))
}

/// `hash  name` lines as written by `sha256sum`.
pub fn parse_sums(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| {
            let (hash, name) = l.trim().split_once(char::is_whitespace)?;
            let name = name.trim().trim_start_matches('*');
            (hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| (name.to_owned(), hash.to_ascii_lowercase()))
        })
        .collect()
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command(async)]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// `Ok(None)` when this build is up to date.
#[tauri::command(async)]
pub fn update_check() -> Result<Option<Release>, String> {
    let body = get_text(&format!("https://api.github.com/repos/{REPO}/releases/latest")).map_err(|e| {
        if e == "HTTP 404" { "no releases published yet".to_owned() } else { e }
    })?;
    let (version, rel) = parse_release(&body)?;
    let current = parse_version(env!("CARGO_PKG_VERSION")).unwrap_or((0, 0, 0));
    Ok((version > current).then_some(rel))
}

/// Downloads, verifies, swaps the executable, starts the new one and exits.
#[tauri::command(async)]
pub fn update_install(app: AppHandle, release: Release) -> Result<(), String> {
    if !release.exe_url.starts_with(DOWNLOAD_PREFIX) || !release.sums_url.starts_with(DOWNLOAD_PREFIX) {
        return Err("unexpected download address".into());
    }
    let cur = std::env::current_exe().map_err(|e| e.to_string())?;
    let sums_text = get_text(&release.sums_url)?;
    let expected = parse_sums(&sums_text).remove(ASSET).ok_or_else(|| format!("SHA256SUMS.txt has no entry for {ASSET}"))?;

    let target = cur.with_extension("exe.new");
    let dl = with_retries(|| -> Result<(), String> {
        let resp = agent(Some(30 * 60)).get(&release.exe_url).call().map_err(|e| e.to_string())?;
        if resp.status().as_u16() >= 400 {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let total = resp.body().content_length().unwrap_or(release.size);
        let mut reader = resp.into_body().into_reader().take(MAX_DOWNLOAD);
        let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 << 10];
        let (mut done, mut last_emit) = (0u64, 0u64);
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if done - last_emit > (512 << 10) {
                last_emit = done;
                let _ = app.emit("update-progress", json!({ "done": done, "total": total }));
            }
        }
        out.flush().map_err(|e| e.to_string())
    });
    if let Err(e) = dl {
        let _ = fs::remove_file(&target);
        return Err(e);
    }
    let _ = app.emit("update-progress", json!({ "done": 1, "total": 1, "verifying": true }));
    let actual = sha256_file(&target).map_err(|e| e.to_string())?;
    let mut head = [0u8; 2];
    let looks_exe = fs::File::open(&target).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"MZ";
    if actual != expected || !looks_exe {
        let _ = fs::remove_file(&target);
        return Err(format!("checksum mismatch (expected {expected}, got {actual})"));
    }
    let old = cur.with_extension("exe.old");
    let _ = fs::remove_file(&old);
    fs::rename(&cur, &old).map_err(|e| format!("cannot replace the running program: {e}"))?;
    if let Err(e) = fs::rename(&target, &cur) {
        let _ = fs::rename(&old, &cur);
        return Err(format!("cannot install the update: {e}"));
    }
    command(cur.to_string_lossy().as_ref()).arg("--after-update").spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

pub fn cleanup_old() {
    if let Ok(cur) = std::env::current_exe() {
        let _ = fs::remove_file(cur.with_extension("exe.old"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare() {
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("v1.2.3-beta"), Some((1, 2, 3)));
        assert_eq!(parse_version("nightly"), None);
    }

    #[test]
    fn release_json() {
        let j = r#"{"tag_name":"v0.2.0","body":"notes","html_url":"https://github.com/x","assets":[
          {"name":"LumenCode.exe","size":10,"browser_download_url":"https://github.com/ahsoggg-creator/lumen-code/releases/download/v0.2.0/LumenCode.exe"},
          {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/ahsoggg-creator/lumen-code/releases/download/v0.2.0/SHA256SUMS.txt"}]}"#;
        let (v, r) = parse_release(j).unwrap();
        assert_eq!(v, (0, 2, 0));
        assert_eq!(r.size, 10);
        let evil = j.replace("github.com/ahsoggg-creator/lumen-code", "evil.example/x");
        assert!(parse_release(&evil).is_err());
    }

    #[test]
    fn sums() {
        let h = "a".repeat(64);
        let m = parse_sums(&format!("{h} *LumenCode.exe\nbad line\n"));
        assert_eq!(m.get("LumenCode.exe"), Some(&h));
    }
}
