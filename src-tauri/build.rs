use tauri_build::{Attributes, InlinedPlugin};

fn main() {
    // `wavrmedia` and `folder` are inline plugins (built with `plugin::Builder::new(...)` inside this
    // crate, not separate crates), so tauri-build doesn't discover them automatically and never
    // generates an ACL manifest / permissions for them. Without an ACL entry, EVERY plugin-scoped
    // invoke is denied by the runtime authority (see tauri webview `resolve_access`) — including the
    // reserved `register_listener` command that `addPluginListener("wavrmedia", "control", …)` issues.
    // That silently rejected the listener registration, so the Kotlin MediaSession's `trigger("control")`
    // (notification / lock-screen transport buttons) reached no JS listener and did nothing.
    //
    // Declaring the inline plugins here autogenerates `allow-*` permissions for the listed commands
    // (incl. the reserved listener commands) and an `allow-*` default set, which the capability grants.
    // The metadata commands (`media_update`, etc.) are plain app commands in `generate_handler!`, so
    // they're covered by `core:default` and don't need to be listed here.
    let attributes = Attributes::new()
        .plugin(
            "wavrmedia",
            InlinedPlugin::new()
                // Reserved listener commands used by `addPluginListener` (control / audiofocus /
                // bluetooth events all flow back through these).
                .commands(&["register_listener", "remove_listener"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        )
        .plugin(
            "folder",
            InlinedPlugin::new()
                .commands(&["register_listener", "remove_listener"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
