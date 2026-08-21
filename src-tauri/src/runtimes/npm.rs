use crate::paths;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde::Deserialize;
use super::try_runtime_mutation_lock;
use super::node::{managed_node_command, NODE_RUNTIME_MUTATION_LOCK};

pub(super) static NOTEBOOKLM_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn notebooklm_lock_entry<'a>(lock: &'a serde_json::Value, package_name: &str) -> Option<&'a serde_json::Value> {
    let key = format!("node_modules/{package_name}");
    lock.get("packages")?.get(&key)
}

fn notebooklm_package_dir(prefix: &std::path::Path, package: &str) -> PathBuf {
    prefix.join("node_modules").join(package)
}

pub(crate) fn portable_notebooklm_mcp_package_dir_for(package: &str) -> PathBuf {
    notebooklm_package_dir(&paths::portable_notebooklm_mcp_prefix(), package)
}

pub(super) fn notebooklm_package_matches_contract(
    package: &serde_json::Value,
    lock: &serde_json::Value,
    contract: &crate::release::ManagedMcpContract,
) -> bool {
    package.get("name").and_then(|v| v.as_str()) == Some(contract.package.as_str())
        && package.get("version").and_then(|v| v.as_str()) == Some(contract.version.as_str())
        && notebooklm_lock_entry(lock, &contract.package)
            .and_then(|entry| entry.get("version"))
            .and_then(|v| v.as_str()) == Some(contract.version.as_str())
        && notebooklm_lock_entry(lock, &contract.package)
            .and_then(|entry| entry.get("integrity"))
            .and_then(|v| v.as_str()) == Some(contract.npm_integrity.as_str())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookLmBrowserStatus {
    pub browser: String,
    pub installed: bool,
    pub hermetic: bool,
    pub executable_path: Option<PathBuf>,
}

pub fn resolve_notebooklm_mcp_bin_for(package_dir: &std::path::Path, contract: &crate::release::ManagedMcpContract) -> Result<PathBuf, String> {
    let package_path = package_dir.join("package.json");
    let package: serde_json::Value = serde_json::from_slice(
        &fs::read(&package_path).map_err(|e| format!("No se pudo leer package.json del MCP: {e}"))?,
    ).map_err(|e| format!("package.json del MCP inválido: {e}"))?;
    if package.get("name").and_then(|v| v.as_str()) != Some(contract.package.as_str())
        || package.get("version").and_then(|v| v.as_str()) != Some(contract.version.as_str())
    {
        return Err("package.json del MCP no coincide con el contrato aprobado.".to_string());
    }
    let bin = package.get("bin").and_then(|value| value.as_str().map(str::to_owned).or_else(|| {
        value.get(contract.package.rsplit('/').next().unwrap_or_default())
            .and_then(|v| v.as_str()).map(str::to_owned)
    })).ok_or("El MCP no expone su bin público administrado.")?;
    if bin.trim().is_empty() || std::path::Path::new(&bin).is_absolute() || bin.split(['/', '\\']).any(|part| part == "..") {
        return Err("El bin público del MCP no es una ruta segura.".to_string());
    }
    let candidate = package_dir.join(bin);
    let root = fs::canonicalize(package_dir).map_err(|e| format!("No se pudo resolver el paquete MCP: {e}"))?;
    let resolved = fs::canonicalize(&candidate).map_err(|e| format!("El bin público del MCP no existe: {e}"))?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err("El bin público del MCP escapa de su paquete o no es un archivo.".to_string());
    }
    Ok(resolved)
}

fn validate_browser_status(status: &NotebookLmBrowserStatus, managed_root: &std::path::Path) -> Result<(), String> {
    if status.browser != "chromium" || !status.installed || !status.hermetic {
        return Err("El MCP no confirmó un Chromium hermético instalado.".to_string());
    }
    let executable = status.executable_path.as_ref().ok_or("El MCP no devolvió executablePath.")?;
    if !executable.is_file() {
        return Err("El executablePath del Chromium no existe.".to_string());
    }
    let root = fs::canonicalize(managed_root).map_err(|e| format!("No se pudo resolver el runtime MCP: {e}"))?;
    let executable = fs::canonicalize(executable).map_err(|e| format!("No se pudo resolver Chromium: {e}"))?;
    if !executable.starts_with(&root) {
        return Err("El Chromium del MCP está fuera del runtime administrado.".to_string());
    }
    Ok(())
}

pub fn build_managed_notebooklm_browser_command(
    node: &std::path::Path,
    bin: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    action: &str,
) -> std::process::Command {
    let mut command = managed_node_command(node);
    command
        .arg(bin)
        .args(["browser", action, "--json"])
        .env("PATH", managed_path);
    command
}

fn run_notebooklm_browser_command(node: &std::path::Path, bin: &std::path::Path, action: &str) -> Result<NotebookLmBrowserStatus, String> {
    let managed_path = super::npm::managed_node_runtime_path()?;
    let output = build_managed_notebooklm_browser_command(node, bin, &managed_path, action)
        .output()
        .map_err(|e| format!("No se pudo ejecutar el bin público del MCP: {e}"))?;
    if !output.status.success() {
        return Err(format!("MCP browser {action} falló: {}", String::from_utf8_lossy(&output.stderr)));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Respuesta JSON inválida de MCP browser {action}: {e}"))
}

fn validate_notebooklm_browser(node: &std::path::Path, package_dir: &std::path::Path, managed_root: &std::path::Path, action: &str, contract: &crate::release::ManagedMcpContract) -> Result<(), String> {
    let bin = resolve_notebooklm_mcp_bin_for(package_dir, contract)?;
    let status = run_notebooklm_browser_command(node, &bin, action)?;
    validate_browser_status(&status, managed_root)
}

pub fn build_managed_notebooklm_npm_command(
    node: &std::path::Path,
    npm_cli: &std::path::Path,
    stage: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    args: &[&str],
) -> std::process::Command {
    let mut command = managed_node_command(node);
    command
        .arg(npm_cli)
        .args(args)
        .current_dir(stage)
        .env("PATH", managed_path);
    command
}

pub(super) fn activate_staged_notebooklm_mcp<F>(
    stage: &std::path::Path,
    active: &std::path::Path,
    backup: &std::path::Path,
    validate_active: F,
) -> Result<(), String>
where
    F: FnOnce(&std::path::Path) -> Result<(), String>,
{
    let had_previous_runtime = active.exists();

    if had_previous_runtime {
        fs::rename(active, backup)
            .map_err(|e| format!("Error preparando reemplazo de NotebookLM MCP: {e}"))?;
    }

    if let Err(activation_error) = fs::rename(stage, active) {
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup, active) {
                return Err(format!(
                    "Error activando NotebookLM MCP: {activation_error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }

        return Err(format!("Error activando NotebookLM MCP: {activation_error}"));
    }

    if let Err(validation_error) = validate_active(active) {
        if let Err(cleanup_error) = fs::remove_dir_all(active) {
            return Err(format!(
                "NotebookLM MCP no pasó validación post-activación: {validation_error}; además no se pudo retirar el runtime inválido: {cleanup_error}; el backup anterior se conserva en {}",
                backup.display()
            ));
        }

        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup, active) {
                return Err(format!(
                    "NotebookLM MCP no pasó validación post-activación: {validation_error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }

        return Err(format!(
            "NotebookLM MCP no pasó validación post-activación: {validation_error}"
        ));
    }

    if had_previous_runtime && backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }

    Ok(())
}

pub fn portable_notebooklm_mcp_installed_for(contract: &crate::release::ManagedMcpContract) -> bool {
    let package_dir = portable_notebooklm_mcp_package_dir_for(&contract.package);
    let package = package_dir.join("package.json");
    let lock = paths::portable_notebooklm_mcp_lock();
    let Ok(package) = fs::read_to_string(package) else { return false; };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&package) else { return false; };
    let Ok(lock) = fs::read_to_string(lock) else { return false; };
    let Ok(lock) = serde_json::from_str::<serde_json::Value>(&lock) else { return false; };
    notebooklm_package_matches_contract(&package, &lock, contract)
        && resolve_notebooklm_mcp_bin_for(&package_dir, contract).is_ok()
        && validate_notebooklm_browser(&paths::portable_node_exe(), &package_dir, &paths::portable_notebooklm_mcp_prefix().join("node_modules"), "status", contract).is_ok()
}

pub fn install_notebooklm_mcp() -> Result<(), String> {
    let _mcp_guard = try_runtime_mutation_lock(&NOTEBOOKLM_RUNTIME_MUTATION_LOCK, "el runtime NotebookLM MCP administrado")?;
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let contract = crate::release::managed_mcp_contract()?;
    let node = paths::portable_node_exe();
    let npm = paths::portable_npm_cli();
    if !node.is_file() || !npm.is_file() {
        return Err("NotebookLM MCP requiere Node.js y npm administrados por Jintia.".to_string());
    }
    let root = paths::portable_runtimes_dir();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let stage = root.join(format!(".notebooklm-mcp-stage-{}", paths::timestamp()));
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let managed_path = managed_node_runtime_path()?;
    let package = serde_json::json!({"private": true, "dependencies": {contract.package.clone(): contract.version.clone()}});
    let result = (|| -> Result<(), String> {
        fs::write(stage.join("package.json"), serde_json::to_vec_pretty(&package).unwrap()).map_err(|e| e.to_string())?;
        let run = |args: &[&str]| -> Result<(), String> {
            let output = build_managed_notebooklm_npm_command(
                &node,
                &npm,
                &stage,
                &managed_path,
                args,
            )
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
            Ok(())
        };
        run(&["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let lock: serde_json::Value = serde_json::from_slice(&fs::read(stage.join("package-lock.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let entry = notebooklm_lock_entry(&lock, &contract.package).ok_or("El lock de NotebookLM MCP no contiene el paquete.")?;
        if entry.get("version").and_then(|v| v.as_str()) != Some(contract.version.as_str()) || entry.get("integrity").and_then(|v| v.as_str()) != Some(contract.npm_integrity.as_str()) { return Err("El integrity de NotebookLM MCP no coincide con el contrato administrado de Jintia.".to_string()); }
        run(&["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let package_dir = notebooklm_package_dir(&stage, &contract.package);
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "install", &contract)?;
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "status", &contract)?;
        let active = paths::portable_notebooklm_mcp_prefix();
        let backup = root.join(format!(".notebooklm-mcp-backup-{}", paths::timestamp()));
        activate_staged_notebooklm_mcp(
            &stage,
            &active,
            &backup,
            |active_root| {
                let active_package = notebooklm_package_dir(active_root, &contract.package);
                validate_notebooklm_browser(
                    &node,
                    &active_package,
                    &active_root.join("node_modules"),
                    "status",
                    &contract,
                )
            },
        )
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&stage); }
    result
}

pub(crate) fn managed_node_runtime_path() -> Result<std::ffi::OsString, String> {
    std::env::join_paths([paths::portable_node_bin_dir()])
        .map_err(|error| format!("No se pudo construir el PATH administrado de Node: {error}"))
}

pub fn build_managed_node_cli_version_command(
    node: &std::path::Path,
    executable: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    args: &[&str],
) -> std::process::Command {
    let mut command = if cfg!(target_os = "windows")
        && executable
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        let mut command = managed_node_command("cmd");
        command.arg("/C").arg(executable);
        command
    } else {
        let mut command = managed_node_command(node);
        command.arg(executable);
        command
    };

    command
        .args(args)
        .env("PATH", managed_path);
    command
}

pub fn build_managed_npm_install_command(
    node: &std::path::Path,
    npm_cli: &std::path::Path,
    prefix: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    packages: &[String],
) -> std::process::Command {
    let mut command = managed_node_command(node);
    command
        .arg(npm_cli)
        .arg("install")
        .arg("--global")
        .arg("--prefix")
        .arg(prefix)
        .args(packages)
        .env("PATH", managed_path);
    command
}

pub fn install_vivliostyle() -> Result<(), String> {
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let managed_path = managed_node_runtime_path()?;
    // El tema jintia-clasico declara "@vivliostyle/theme-base" como capa
    // base en su vivliostyle.config.js (y lo extiende/sobrescribe encima).
    // Sin este paquete, la compilación a PDF sigue funcionando porque el
    // CSS propio de Jintia cubre lo visible, pero Vivliostyle emite 404 al
    // intentar cargar la capa base declarada y el render queda incompleto
    // respecto a lo que el tema espera.
    let output = managed_node_command(&node)
            .arg(&npm_cli)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .arg("@vivliostyle/theme-base")
            .env("PATH", managed_path)
            .output()
    .map_err(|e| format!("No se pudo ejecutar npm con el runtime portable: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install @vivliostyle/cli falló: {stderr}"));
    }

    let executable = paths::portable_vivliostyle_bin();
    if !executable.is_file() {
        return Err(format!(
            "Vivliostyle fue instalado por npm pero no se encontró el ejecutable administrado en {}.",
            executable.display()
        ));
    }

    Ok(())
}

/// Instala `opencode-ai` en el prefix Node administrado por Jintia (en vez
/// de depender de una instalación global del usuario). Así, cuando
/// OpenCodeManager arranca el servidor y su proceso hereda el PATH del
/// runtime gestionado, el binario `opencode` que encuentra siempre coincide
/// con el que la app conoce y verificó, en cualquier máquina.
pub fn install_opencode() -> Result<(), String> {
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let managed_path = managed_node_runtime_path()?;
    let output = managed_node_command(&node)
            .arg(&npm_cli)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("opencode-ai")
            .env("PATH", managed_path)
            .output()
    .map_err(|e| format!("No se pudo ejecutar npm con el runtime portable: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install opencode-ai falló: {stderr}"));
    }

    let executable = paths::portable_opencode_bin();
    if !executable.is_file() {
        return Err(format!(
            "OpenCode fue instalado por npm pero no se encontró el ejecutable administrado en {}.",
            executable.display()
        ));
    }

    Ok(())
}

/// Nombre base de un specifier npm: "@scope/pkg@version" -> "@scope/pkg",
/// "pkg@version" -> "pkg".
pub(super) fn npm_bare_name(spec: &str) -> &str {
    if let Some(rest) = spec.strip_prefix('@') {
        match rest.find('@') {
            Some(idx) => &spec[..idx + 1],
            None => spec,
        }
    } else {
        match spec.find('@') {
            Some(idx) => &spec[..idx],
            None => spec,
        }
    }
}

/// Filtra `packages` a solo los que no están ya instalados en el prefix
/// global administrado por Jintia (donde install_npm_packages los pone).
/// Se usa antes de ofrecer instalar las herramientas recomendadas del
/// perfil disciplinar, para no pedir instalar de nuevo lo que ya está.
pub fn missing_npm_packages(packages: &[String]) -> Vec<String> {
    let prefix = paths::portable_node_prefix();
    packages
        .iter()
        .filter(|spec| {
            let name = npm_bare_name(spec);
            !prefix.join("node_modules").join(name).join("package.json").is_file()
        })
        .cloned()
        .collect()
}

pub fn install_npm_packages(packages: &[String]) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;

    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let managed_path = managed_node_runtime_path()?;
    let output = build_managed_npm_install_command(
        &node,
        &npm_cli,
        &prefix,
        &managed_path,
        packages,
    )
    .output()
    .map_err(|e| {
        format!("No se pudo ejecutar npm con el runtime portable: {e}")
    })?;

    if !output.status.success() {
        let stderr =
            String::from_utf8_lossy(&output.stderr);

        return Err(format!(
            "npm install falló para el perfil disciplinar: {stderr}"
        ));
    }

    Ok(())
}

pub fn resolve_vivliostyle() -> Option<PathBuf> {
    let portable = paths::portable_vivliostyle_bin();

    if portable.is_file() {
        return Some(portable);
    }

    None
}

pub fn vivliostyle_version() -> Option<String> {
    let executable = resolve_vivliostyle()?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return None;
    }

    let managed_path = managed_node_runtime_path().ok()?;
    let output = build_managed_node_cli_version_command(
        &node,
        &executable,
        &managed_path,
        &["--version"],
    )
    .output()
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };

    String::from_utf8(text).ok().and_then(|value| {
        value
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
    })
}

pub fn resolve_node_cli(command: &str) -> Option<PathBuf> {
    let portable_name = if cfg!(target_os = "windows") {
        format!("{command}.cmd")
    } else {
        command.to_string()
    };

    let portable = paths::portable_node_bin_dir()
        .join(portable_name);

    if portable.is_file() {
        return Some(portable);
    }

    None
}

pub fn node_cli_version(
    command: &str,
    args: &[&str],
) -> Option<String> {
    let executable = resolve_node_cli(command)?;

    let node = paths::portable_node_exe();
    if !node.is_file() {
        return None;
    }

    let managed_path = managed_node_runtime_path().ok()?;
    let output = build_managed_node_cli_version_command(
        &node,
        &executable,
        &managed_path,
        args,
    )
    .output()
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let bytes = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };

    String::from_utf8(bytes)
        .ok()
        .and_then(|value| {
            value
                .lines()
                .find(|line| {
                    !line.trim().is_empty()
                })
                .map(|line| {
                    line.trim().to_string()
                })
        })
}

