//! Installing VS Code extension packages (.vsix = zip). Only the files an editor without the VS Code
//! extension host can use are interesting (themes, snippets, grammars, language configs), but the whole
//! `extension/` folder is unpacked so nothing is lost.

use crate::net::agent;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_DOWNLOAD: u64 = 200 << 20;
const MAX_UNPACKED: u64 = 600 << 20;
const ALLOWED_HOSTS: [&str; 1] = ["https://open-vsx.org/"];

#[derive(Serialize)]
pub struct Installed {
    dir: String,
    id: String,
    version: String,
}

fn download(url: &str, dest: &Path) -> Result<(), String> {
    if !ALLOWED_HOSTS.iter().any(|h| url.starts_with(h)) {
        return Err("скачивание разрешено только с https://open-vsx.org/".into());
    }
    let resp = agent(Some(600)).get(url).call().map_err(|e| e.to_string())?;
    if resp.status().as_u16() >= 400 {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mut reader = resp.into_body().into_reader().take(MAX_DOWNLOAD + 1);
    let mut out = fs::File::create(dest).map_err(|e| e.to_string())?;
    let n = std::io::copy(&mut reader, &mut out).map_err(|e| e.to_string())?;
    if n > MAX_DOWNLOAD {
        return Err("файл расширения слишком большой".into());
    }
    out.flush().map_err(|e| e.to_string())
}

/// Unpacks the `extension/` folder of a .vsix into `<dest_root>/<publisher>.<name>-<version>`.
pub fn unpack(vsix: &Path, dest_root: &Path) -> Result<Installed, String> {
    let file = fs::File::open(vsix).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("это не .vsix: {e}"))?;
    let manifest: serde_json::Value = {
        let mut f = zip.by_name("extension/package.json").map_err(|_| "в архиве нет extension/package.json")?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| format!("package.json: {e}"))?
    };
    let name = manifest["name"].as_str().ok_or("в package.json нет name")?;
    let publisher = manifest["publisher"].as_str().unwrap_or("local");
    let version = manifest["version"].as_str().unwrap_or("0.0.0");
    let safe = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !(safe(name) && safe(publisher) && safe(version)) {
        return Err("недопустимые символы в имени расширения".into());
    }
    let id = format!("{publisher}.{name}");
    let dir: PathBuf = dest_root.join(format!("{id}-{version}"));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let Ok(rel) = rel.strip_prefix("extension") else { continue };
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
            let _ = fs::remove_dir_all(&dir);
            return Err("распакованное расширение слишком велико".into());
        }
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(Installed { dir: dir.to_string_lossy().into_owned(), id, version: version.to_owned() })
}

/// `source` is a local .vsix path or an https://open-vsx.org/ download URL.
#[tauri::command(async)]
pub fn vsix_install(source: String, dest_root: String) -> Result<Installed, String> {
    fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    if source.starts_with("https://") {
        let tmp = std::env::temp_dir().join(format!("lumen-{}.vsix", std::process::id()));
        let r = download(&source, &tmp).and_then(|_| unpack(&tmp, Path::new(&dest_root)));
        let _ = fs::remove_file(&tmp);
        r
    } else {
        unpack(Path::new(&source), Path::new(&dest_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn make_vsix(path: &Path, evil: bool) {
        let f = fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("extension/package.json", o).unwrap();
        z.write_all(br#"{"name":"demo","publisher":"acme","version":"1.2.3","contributes":{}}"#).unwrap();
        z.start_file("extension/themes/a.json", o).unwrap();
        z.write_all(b"{}").unwrap();
        z.start_file("[Content_Types].xml", o).unwrap();
        z.write_all(b"<x/>").unwrap();
        if evil {
            z.start_file("extension/../../escape.txt", o).unwrap();
            z.write_all(b"x").unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn unpacks_only_the_extension_folder() {
        let base = std::env::temp_dir().join(format!("lumen-vsix-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        make_vsix(&base.join("a.vsix"), true);
        let r = unpack(&base.join("a.vsix"), &base.join("out")).unwrap();
        assert_eq!(r.id, "acme.demo");
        assert!(base.join("out/acme.demo-1.2.3/themes/a.json").exists());
        assert!(!base.join("out/acme.demo-1.2.3/[Content_Types].xml").exists());
        assert!(!base.join("escape.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_foreign_hosts() {
        assert!(download("https://evil.example/x.vsix", Path::new("x")).is_err());
    }
}
