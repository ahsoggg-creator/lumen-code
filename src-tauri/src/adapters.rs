//! Debug adapters that are downloaded on request. Supply-chain rules: the download address and the SHA-256 of every
//! package are pinned here (not taken from the UI or from the network), the hash is checked before anything is
//! unpacked, and nothing is downloaded without the user confirming it in the UI.

use crate::net::agent;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_DOWNLOAD: u64 = 120 << 20;
const MAX_UNPACKED: u64 = 700 << 20;

struct Preset {
    id: &'static str,
    version: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// Folder inside the archive whose content is unpacked (the rest is ignored).
    strip: &'static str,
    /// Program or script to start, relative to the unpacked folder.
    entry: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "codelldb",
        version: "1.12.3",
        url: "https://github.com/vadimcn/codelldb/releases/download/v1.12.3/codelldb-win32-x64.vsix",
        sha256: "a916e509308dac817732f63ca604a8b93ed29cd16f38a2fa9f0b64ed58e8f51a",
        strip: "extension",
        entry: "adapter/codelldb.exe",
    },
];

fn preset(id: &str) -> Result<&'static Preset, String> {
    PRESETS.iter().find(|p| p.id == id).ok_or_else(|| format!("неизвестный отладчик: {id}"))
}

fn install_dir(root: &str, p: &Preset) -> PathBuf {
    Path::new(root).join(format!("{}-{}", p.id, p.version))
}

#[derive(Serialize)]
pub struct AdapterInfo {
    id: &'static str,
    version: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// Path of the program to start when already installed.
    entry: Option<String>,
}

fn info_of(p: &'static Preset, root: &str) -> AdapterInfo {
    let entry = install_dir(root, p).join(p.entry);
    AdapterInfo { id: p.id, version: p.version, url: p.url, sha256: p.sha256, entry: entry.is_file().then(|| entry.to_string_lossy().into_owned()) }
}

#[tauri::command(async)]
pub fn adapter_info(id: String, root: String) -> Result<AdapterInfo, String> {
    Ok(info_of(preset(&id)?, &root))
}

/// Downloads to `tmp`, returning the SHA-256 (lower-case hex) of what was received.
fn download(url: &str, tmp: &Path) -> Result<String, String> {
    let resp = agent(Some(900)).get(url).call().map_err(|e| e.to_string())?;
    if resp.status().as_u16() >= 400 {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mut reader = resp.into_body().into_reader().take(MAX_DOWNLOAD + 1);
    let mut out = fs::File::create(tmp).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_DOWNLOAD {
            return Err("файл отладчика слишком большой".into());
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn unpack_zip(archive: &Path, strip: &str, dir: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let Ok(rel) = rel.strip_prefix(strip) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err("распакованный отладчик слишком велик".into());
        }
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Downloads and unpacks a pinned adapter into `<root>/<id>-<version>`; returns the path of its start program.
#[tauri::command(async)]
pub fn adapter_install(id: String, root: String) -> Result<String, String> {
    let p = preset(&id)?;
    let dir = install_dir(&root, p);
    let entry = dir.join(p.entry);
    if entry.is_file() {
        return Ok(entry.to_string_lossy().into_owned());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join(format!("lumen-adapter-{}-{}", std::process::id(), p.id));
    let got = download(p.url, &tmp);
    let result = got.and_then(|hash| {
        if hash != p.sha256 {
            return Err(format!("контрольная сумма не совпала (ожидалась {}, получена {hash}) — пакет не установлен", p.sha256));
        }
        let staging = Path::new(&root).join(format!("{}-{}.partial", p.id, p.version));
        let _ = fs::remove_dir_all(&staging);
        if let Err(e) = unpack_zip(&tmp, p.strip, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&staging, &dir).map_err(|e| e.to_string())?;
        if entry.is_file() { Ok(entry.to_string_lossy().into_owned()) } else { Err(format!("в пакете нет {}", p.entry)) }
    });
    let _ = fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_well_formed() {
        for p in PRESETS {
            assert!(p.url.starts_with("https://github.com/"), "{}", p.id);
            assert_eq!(p.sha256.len(), 64, "{}: sha256 must be 64 hex characters", p.id);
            assert!(p.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", p.id);
            assert!(p.url.contains(p.version), "{}: url and version disagree", p.id);
        }
    }

    #[test]
    fn unknown_adapter_is_refused() {
        assert!(preset("evil").is_err());
    }
}
