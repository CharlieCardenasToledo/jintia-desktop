use crate::paths;
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use super::{try_runtime_mutation_lock, emit_dependency_progress};
use super::node::{managed_node_command, NODE_RUNTIME_MUTATION_LOCK};
use super::npm::managed_node_runtime_path;

pub(super) static SKILL_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());

pub fn portable_skill_installed() -> bool {
    paths::portable_skill_bin().is_file()
}

pub fn resolve_skill() -> Option<String> {
    let portable = paths::portable_skill_bin();
    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }
    None
}

pub fn global_skill_available() -> bool {
    let checker = if cfg!(target_os = "windows") { "where.exe" } else { "which" };
    std::process::Command::new(checker)
        .arg("jintia")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn download_portable_skill(app: &AppHandle) -> Result<(), String> {
    let _skill_guard = try_runtime_mutation_lock(&SKILL_RUNTIME_MUTATION_LOCK, "el runtime Jintia administrado")?;
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let runtimes_dir = paths::portable_runtimes_dir();
    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio de runtimes: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stage = runtimes_dir.join(format!(".jintia-stage-{ts}"));

    let managed_path = managed_node_runtime_path()?;

    emit_skill_progress(app, "installing", 5.0, "Instalando Jintia desde npm...");

    let output = managed_node_command(&node)
            .arg(&npm_cli)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&stage)
            .arg("@charlie.act7/jintia@latest")
            .arg("--no-audit")
            .arg("--no-fund")
            .env("PATH", &managed_path)
            .output()
    .map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("No se pudo ejecutar npm: {e}")
    })?;

    if !output.status.success() {
        let _ = fs::remove_dir_all(&stage);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "npm install @charlie.act7/jintia@latest falló: {stderr}"
        ));
    }

    emit_skill_progress(app, "validating", 70.0, "Validando instalación...");

    let pkg_dir = paths::portable_skill_npm_package_dir_for(&stage);
    let skill_js = pkg_dir.join("skill").join("bin").join("jintia.js");
    let pkg_json_path = pkg_dir.join("package.json");
    let skill_md = pkg_dir.join("skill").join("SKILL.md");

    if !pkg_json_path.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "package.json no encontrado en {}",
            pkg_dir.display()
        ));
    }
    if !skill_md.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "SKILL.md no encontrado en {}",
            pkg_dir.display()
        ));
    }
    if !skill_js.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "skill/bin/jintia.js no encontrado en {}",
            pkg_dir.display()
        ));
    }

    let pkg_json = fs::read_to_string(&pkg_json_path)
        .map_err(|e| format!("Error leyendo package.json: {e}"))?;
    let pkg: serde_json::Value = serde_json::from_str(&pkg_json)
        .map_err(|e| format!("Error parseando package.json: {e}"))?;
    let name = pkg["name"].as_str().unwrap_or("");
    let version = pkg["version"].as_str().unwrap_or("").to_string();
    if name != "@charlie.act7/jintia" {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("Nombre incorrecto en package.json: {name}"));
    }
    if version.is_empty() {
        let _ = fs::remove_dir_all(&stage);
        return Err("Versión vacía en package.json".to_string());
    }

    emit_skill_progress(
        app,
        "testing",
        80.0,
        &format!("Probando Jintia {version}..."),
    );

    let smoke_output = managed_node_command(&node)
        .arg(&skill_js)
        .arg("capabilities")
        .arg("profiles")
        .arg("--json")
        .env("PATH", &managed_path)
        .output()
        .map_err(|e| {
            let _ = fs::remove_dir_all(&stage);
            format!("No se pudo ejecutar la prueba de humo: {e}")
        })?;

    if !smoke_output.status.success() {
        let _ = fs::remove_dir_all(&stage);
        let stderr = String::from_utf8_lossy(&smoke_output.stderr);
        return Err(format!("Prueba de humo falló: {stderr}"));
    }

    let smoke_stdout = String::from_utf8_lossy(&smoke_output.stdout);
    serde_json::from_str::<serde_json::Value>(&smoke_stdout).map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("La prueba de humo devolvió JSON inválido: {e}")
    })?;

    crate::release::managed_mcp_contract_from(&pkg_dir, env!("CARGO_PKG_VERSION"))
        .map_err(|error| { let _ = fs::remove_dir_all(&stage); error })?;

    emit_skill_progress(app, "activating", 92.0, "Activando instalación...");

    let active = paths::portable_skill_prefix();
    let backup = runtimes_dir.join(format!(".jintia-backup-{ts}"));

    if active.exists() {
        fs::rename(&active, &backup)
            .map_err(|e| format!("Error respaldando instalación anterior: {e}"))?;
    }

    if let Err(e) = fs::rename(&stage, &active) {
        if backup.exists() {
            let _ = fs::rename(&backup, &active);
        }
        return Err(format!("Error activando nueva instalación: {e}"));
    }

    let _ = fs::remove_dir_all(&backup);

    emit_skill_progress(
        app,
        "done",
        100.0,
        &format!("Jintia {version} instalado correctamente."),
    );

    Ok(())
}

pub fn visual_install_profiles() -> Result<serde_json::Value, String> {
    let path = paths::portable_skill_source_dir()
        .join("config")
        .join("visual-install-profiles.json");

    let bytes = fs::read(&path).map_err(|e| {
        format!("No se pudo leer {}: {e}", path.display())
    })?;

    let value = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|e| format!("Contrato visual inválido: {e}"))?;

    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "El contrato visual no tiene campo 'version' numérico".to_string())?;

    if version < 3 {
        return Err(format!(
            "Versión del contrato visual demasiado antigua: {version} (mínima 3)"
        ));
    }

    let profiles = value
        .get("profiles")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "El contrato visual no tiene 'profiles' como array".to_string())?;

    let required_ids = ["minimum", "core", "full"];
    for id in required_ids {
        let found = profiles.iter().any(|p| {
            p.get("id").and_then(|v| v.as_str()) == Some(id)
        });
        if !found {
            return Err(format!("Perfil requerido '{id}' ausente en el contrato visual"));
        }
    }

    value
        .get("disciplines")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "El contrato visual no tiene 'disciplines' como objeto".to_string())?;

    Ok(value)
}

fn emit_skill_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    emit_dependency_progress(app, "Jintia Skill", phase, Some(percent), message);
    let _ = tauri::Emitter::emit(app,
        "skill-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}
