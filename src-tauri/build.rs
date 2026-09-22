fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_none() {
        return;
    }

    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
