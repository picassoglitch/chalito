fn main() {
    // agent.rs BUILT_WIRING: a rebuild picks up a changed public app config.
    for k in ["VITE_CHALITO_API_BASE", "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"] {
        println!("cargo:rerun-if-env-changed={k}");
    }
    tauri_build::build()
}
