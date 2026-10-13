mod log;
mod portable;
mod proxy;

use proxy::ProxyInfo;
use tauri::Manager;

#[tauri::command]
fn proxy_info(info: tauri::State<'_, ProxyInfo>) -> ProxyInfo {
    info.inner().clone()
}

/// Строка в журнал радио (из интерфейса).
#[tauri::command]
fn log_line(text: String) {
    log::line(&text);
}

/// Журнал радио целиком в виде текста: кнопка «Скопировать журнал» в настройках.
#[tauri::command]
fn radio_log() -> Option<String> {
    log::tail()
}

#[tauri::command]
fn is_portable() -> bool {
    portable::is_portable()
}

/// Обновление портативной версии: скачать, проверить подпись, подменить файл, запустить новую копию и закрыться.
#[tauri::command]
async fn portable_update(app: tauri::AppHandle, url: String, signature: String, version: String) -> Result<(), String> {
    if !portable::is_portable() {
        return Err("not portable".into());
    }
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .ok_or("no public key")?
        .to_string();
    let bytes = portable::download(&url).await?;
    let signed = portable::verify(&bytes, &signature, &pubkey)?;
    portable::check_binding(&signed, &version, &url, &app.package_info().version.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    portable::swap(&exe, &bytes)?;
    std::process::Command::new(&exe).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if let Ok(dir) = app.path().app_log_dir() {
                log::init(dir);
            }
            portable::cleanup_old();
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let info = tauri::async_runtime::block_on(proxy::start())?;
            app.manage(info);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![proxy_info, log_line, radio_log, is_portable, portable_update])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
