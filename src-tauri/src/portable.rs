//! Обновление портативной версии: скачать новый exe, проверить подпись, подменить самого себя и перезапуститься.
//! У установленной версии свой обновлятор (плагин Tauri), здесь только портативный случай.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{
    fs,
    path::{Path, PathBuf},
};
use url::Url;

const MAX_BYTES: usize = 80 * 1024 * 1024;

/// Установщик кладёт рядом с программой uninstall.exe; если его нет, программа запущена как портативная.
pub fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| !d.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

/// Файл с новой версией разрешено брать только с GitHub (релизы).
pub fn allowed_url(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|_| "bad url".to_string())?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() == "https" && (host == "github.com" || host.ends_with(".githubusercontent.com")) {
        Ok(u)
    } else {
        Err("update source is not allowed".into())
    }
}

pub async fn download(raw: &str) -> Result<Vec<u8>, String> {
    let url = allowed_url(raw)?;
    let client = crate::proxy::build_client()?;
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err("file is too large".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// Подпись проверяется тем же открытым ключом, что и у обычных обновлений (он записан в tauri.conf.json).
pub fn verify(bytes: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let text = |b64: &str| -> Result<String, String> {
        String::from_utf8(B64.decode(b64.trim()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    };
    let key = PublicKey::decode(&text(pubkey_b64)?).map_err(|e| e.to_string())?;
    let sig = Signature::decode(&text(signature_b64)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &sig, false).map_err(|e| e.to_string())
}

fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "app".into());
    exe.with_file_name(format!("{stem}{suffix}"))
}

/// Windows не даёт удалить запущенный файл, но даёт его переименовать: старый уходит в «.old.exe», новый встаёт на его место.
pub fn swap(exe: &Path, new_bytes: &[u8]) -> Result<(), String> {
    let staged = sibling(exe, ".update.tmp");
    let old = sibling(exe, ".old.exe");
    fs::write(&staged, new_bytes).map_err(|e| format!("cannot write next to the program: {e}"))?;
    let _ = fs::remove_file(&old);
    if let Err(e) = fs::rename(exe, &old) {
        let _ = fs::remove_file(&staged);
        return Err(format!("cannot replace the program file: {e}"));
    }
    if let Err(e) = fs::rename(&staged, exe) {
        let _ = fs::rename(&old, exe); // возвращаем как было
        return Err(format!("cannot place the new version: {e}"));
    }
    Ok(())
}

/// Старую копию удаляем при следующем запуске (пока она работала, удалить её было нельзя).
pub fn cleanup_old() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(sibling(&exe, ".old.exe"));
        let _ = fs::remove_file(sibling(&exe, ".update.tmp"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // тестовая подпись настоящим ключом (tools: tauri signer sign) для байтов b"velvet-test"
    const PUB: &str = include_str!("../tests/pubkey.txt");
    const SIG: &str = include_str!("../tests/velvet-test.sig");

    #[test]
    fn accepts_only_github_https() {
        assert!(allowed_url("https://github.com/septeamone/velvet-desktop/releases/download/v1/x.exe").is_ok());
        assert!(allowed_url("https://objects.githubusercontent.com/abc").is_ok());
        for bad in ["http://github.com/x", "https://evil.example.com/x.exe", "https://github.com.evil.com/x", "file:///C:/x.exe", "https://127.0.0.1/x"] {
            assert!(allowed_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn verifies_signature_and_rejects_tampering() {
        assert!(verify(b"velvet-test", SIG, PUB).is_ok());
        assert!(verify(b"velvet-tesT", SIG, PUB).is_err());
        assert!(verify(b"velvet-test", "bm90IGEgc2lnbmF0dXJl", PUB).is_err());
    }

    #[test]
    fn swaps_files_and_keeps_old_copy() {
        let dir = std::env::temp_dir().join(format!("velvet-swap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("velvet-tv.exe");
        fs::write(&exe, b"old version").unwrap();
        swap(&exe, b"new version").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new version");
        assert_eq!(fs::read(dir.join("velvet-tv.old.exe")).unwrap(), b"old version");
        assert!(!dir.join("velvet-tv.update.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
