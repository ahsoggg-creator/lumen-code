//! Windows shell integration without admin rights (HKCU only): "Open with" entries for chosen extensions,
//! Explorer context-menu items, and a Default Apps registration so Windows lists Lumen Code in its settings.

use crate::util::command;
use serde::Serialize;

const PROG_ID: &str = "LumenCode.File";
const CAPS: &str = r"Software\Lumen Code\Capabilities";

#[derive(Serialize)]
pub struct AssocStatus {
    exts: Vec<String>,
    context_menu: bool,
    registered: bool,
}

fn reg(args: &[&str]) -> bool {
    command("reg").args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

fn add_default(key: &str, value: &str) -> bool {
    reg(&["add", key, "/ve", "/d", value, "/f"])
}

fn add_value(key: &str, name: &str, value: &str) -> bool {
    reg(&["add", key, "/v", name, "/d", value, "/f"])
}

fn exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

pub fn open_command(exe: &str, arg: &str) -> String {
    format!("\"{exe}\" \"{arg}\"")
}

fn clean_ext(e: &str) -> Option<String> {
    let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
    (!e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '+')).then_some(e)
}

fn register_prog(exe: &str) -> bool {
    let root = format!(r"HKCU\Software\Classes\{PROG_ID}");
    add_default(&root, "Файл Lumen Code")
        && add_default(&format!(r"{root}\DefaultIcon"), &format!("\"{exe}\",0"))
        && add_default(&format!(r"{root}\shell\open\command"), &open_command(exe, "%1"))
}

fn register_capabilities(exe: &str, exts: &[String]) {
    let caps = format!(r"HKCU\{CAPS}");
    let _ = add_value(&caps, "ApplicationName", "Lumen Code");
    let _ = add_value(&caps, "ApplicationDescription", "Лёгкий редактор кода");
    let _ = add_value(&format!(r"HKCU\Software\Lumen Code\Capabilities\FileAssociations"), ".txt", PROG_ID);
    for e in exts {
        let _ = add_value(&format!(r"HKCU\{CAPS}\FileAssociations"), &format!(".{e}"), PROG_ID);
    }
    let _ = add_value(r"HKCU\Software\RegisteredApplications", "LumenCode", CAPS);
    let app = r"HKCU\Software\Classes\Applications\LumenCode.exe";
    let _ = add_default(&format!(r"{app}\shell\open\command"), &open_command(exe, "%1"));
    let _ = add_value(app, "FriendlyAppName", "Lumen Code");
}

#[tauri::command(async)]
pub fn assoc_status(exts: Vec<String>) -> AssocStatus {
    let mut on = Vec::new();
    for e in exts.iter().filter_map(|e| clean_ext(e)) {
        if reg(&["query", &format!(r"HKCU\Software\Classes\.{e}\OpenWithProgids"), "/v", PROG_ID]) {
            on.push(e);
        }
    }
    AssocStatus {
        exts: on,
        context_menu: reg(&["query", r"HKCU\Software\Classes\*\shell\LumenCode"]),
        registered: reg(&["query", &format!(r"HKCU\Software\Classes\{PROG_ID}")]),
    }
}

#[tauri::command(async)]
pub fn assoc_apply(exts: Vec<String>, all_known: Vec<String>, context_menu: bool) -> Result<(), String> {
    let exe = exe()?;
    if !register_prog(&exe) {
        return Err("не удалось записать данные в реестр (HKCU)".into());
    }
    let want: Vec<String> = exts.iter().filter_map(|e| clean_ext(e)).collect();
    for e in all_known.iter().filter_map(|e| clean_ext(e)) {
        let key = format!(r"HKCU\Software\Classes\.{e}\OpenWithProgids");
        if want.contains(&e) {
            add_value(&key, PROG_ID, "");
        } else {
            reg(&["delete", &key, "/v", PROG_ID, "/f"]);
        }
    }
    register_capabilities(&exe, &want);

    let items = [
        (r"HKCU\Software\Classes\*\shell\LumenCode", "Открыть в Lumen Code", "%1"),
        (r"HKCU\Software\Classes\Directory\shell\LumenCode", "Открыть папку в Lumen Code", "%1"),
        (r"HKCU\Software\Classes\Directory\Background\shell\LumenCode", "Открыть папку в Lumen Code", "%V"),
    ];
    for (key, label, arg) in items {
        if context_menu {
            add_default(key, label);
            add_value(key, "Icon", &format!("\"{exe}\",0"));
            add_default(&format!(r"{key}\command"), &open_command(&exe, arg));
        } else {
            reg(&["delete", key, "/f"]);
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn assoc_remove_all(all_known: Vec<String>) {
    for e in all_known.iter().filter_map(|e| clean_ext(e)) {
        reg(&["delete", &format!(r"HKCU\Software\Classes\.{e}\OpenWithProgids"), "/v", PROG_ID, "/f"]);
    }
    for key in [
        format!(r"HKCU\Software\Classes\{PROG_ID}"),
        r"HKCU\Software\Classes\*\shell\LumenCode".into(),
        r"HKCU\Software\Classes\Directory\shell\LumenCode".into(),
        r"HKCU\Software\Classes\Directory\Background\shell\LumenCode".into(),
        r"HKCU\Software\Classes\Applications\LumenCode.exe".into(),
        r"HKCU\Software\Lumen Code".into(),
    ] {
        reg(&["delete", &key, "/f"]);
    }
    reg(&["delete", r"HKCU\Software\RegisteredApplications", "/v", "LumenCode", "/f"]);
}

/// Opens Windows "Default apps" so the user can make Lumen Code the default for the extensions it registered.
#[tauri::command(async)]
pub fn open_default_apps() {
    let _ = command("cmd").args(["/c", "start", "", "ms-settings:defaultapps"]).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_is_quoted() {
        assert_eq!(open_command(r"C:\Program Files\Lumen\LumenCode.exe", "%1"), r#""C:\Program Files\Lumen\LumenCode.exe" "%1""#);
    }

    #[test]
    fn extensions_are_sanitised() {
        assert_eq!(clean_ext(".PY").as_deref(), Some("py"));
        assert_eq!(clean_ext("c++").as_deref(), Some("c++"));
        assert_eq!(clean_ext("a\\b"), None);
        assert_eq!(clean_ext(""), None);
    }
}
