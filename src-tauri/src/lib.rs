mod proxy;

use proxy::ProxyInfo;
use tauri::Manager;

#[tauri::command]
fn proxy_info(info: tauri::State<'_, ProxyInfo>) -> ProxyInfo {
    info.inner().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let info = tauri::async_runtime::block_on(proxy::start())?;
            app.manage(info);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![proxy_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
