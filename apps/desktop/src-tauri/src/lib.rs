use std::{
    fs::{self, File, OpenOptions},
    io,
    os::fd::AsRawFd,
};

use tauri::Manager;

struct AppInstanceLock {
    _file: File,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let Some(instance_lock) = acquire_app_instance_lock(app)? else {
                std::process::exit(0);
            };
            app.manage(instance_lock);

            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("stronghold-salt.txt");
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;
            Ok(())
        })
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running Review Ninja desktop application");
}

fn acquire_app_instance_lock(
    app: &tauri::App,
) -> Result<Option<AppInstanceLock>, Box<dyn std::error::Error>> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .expect("could not resolve app local data path");
    fs::create_dir_all(&data_dir)?;

    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(data_dir.join("review-ninja.lock"))?;
    let lock_result = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };

    if lock_result == 0 {
        return Ok(Some(AppInstanceLock { _file: lock_file }));
    }

    let error = io::Error::last_os_error();
    let raw_error = error.raw_os_error();
    if raw_error == Some(libc::EWOULDBLOCK) || raw_error == Some(libc::EAGAIN) {
        return Ok(None);
    }

    Err(Box::new(error))
}
