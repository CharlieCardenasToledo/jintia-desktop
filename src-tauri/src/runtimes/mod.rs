mod node;
mod npm;
mod profile_binary;
mod python;
mod skill;

// ==================== SHARED IMPORTS ====================

use std::fs;
use std::io::Read;
use std::sync::{Mutex, MutexGuard, TryLockError};
use sha2::{Digest, Sha256};
use hex;
use tauri::AppHandle;
use tauri::Emitter;

// ==================== RE-EXPORTS: node ====================

pub use node::{
    global_node_available,
    resolve_node,
    portable_node_installed,
    node_version,
    download_portable_node,
};
pub(crate) use node::managed_node_command;

// ==================== RE-EXPORTS: python ====================

pub use python::{
    global_python_available,
    resolve_python,
    portable_python_installed,
    python_version,
    download_portable_python,
    install_pip_packages,
};

// ==================== RE-EXPORTS: npm ====================

pub use npm::{
    install_npm_packages,
    install_vivliostyle,
    install_opencode,
    resolve_vivliostyle,
    vivliostyle_version,
    resolve_node_cli,
    node_cli_version,
    install_notebooklm_mcp,
    portable_notebooklm_mcp_installed_for,
    resolve_notebooklm_mcp_bin_for,
};
pub(crate) use npm::{
    portable_notebooklm_mcp_package_dir_for,
    managed_node_runtime_path,
};

// ==================== RE-EXPORTS: skill ====================

pub use skill::{
    portable_skill_installed,
    resolve_skill,
    global_skill_available,
    download_portable_skill,
    visual_install_profiles,
};

// ==================== RE-EXPORTS: profile_binary ====================

pub use profile_binary::install_profile_binaries;

// ==================== SHARED HELPERS ====================

pub(super) fn try_runtime_mutation_lock<'a>(
    lock: &'a Mutex<()>,
    resource: &str,
) -> Result<MutexGuard<'a, ()>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::WouldBlock) => Err(format!(
            "Ya hay una operación sobre {resource} en curso."
        )),
        Err(TryLockError::Poisoned(_)) => Err(format!(
            "No se pudo iniciar una operación sobre {resource}: \
             el bloqueo interno quedó invalidado. \
             Reinicia Jintia Desktop y vuelve a intentarlo."
        )),
    }
}

pub(super) fn emit_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    emit_dependency_progress(app, "Node.js", phase, Some(percent), message);
    let _ = app.emit(
        "node-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

pub fn emit_dependency_progress(
    app: &AppHandle,
    name: &str,
    phase: &str,
    percent: Option<f32>,
    message: &str,
) {
    let _ = app.emit(
        "dependency-install-progress",
        serde_json::json!({
            "name": name,
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

pub(super) fn verify_sha256(file_path: &std::path::Path, expected_hex: &str) -> Result<(), String> {
    let mut file = fs::File::open(file_path)
        .map_err(|e| format!("Error abriendo archivo para verificar: {e}"))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 64];

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Error leyendo para checksum: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let actual = hex::encode(hasher.finalize());
    let expected = expected_hex.trim().to_lowercase();

    if actual != expected {
        return Err(format!(
            "Checksum inválido. Esperado: {}…, Actual: {}…",
            &expected[..16.min(expected.len())],
            &actual[..16.min(actual.len())]
        ));
    }

    Ok(())
}

pub(super) fn node_checksum_from_manifest(manifest: &str, filename: &str) -> Result<String, String> {
    let mut checksum = None;

    for line in manifest.lines() {
        let Some((candidate, candidate_filename)) = line.trim_end().split_once("  ") else {
            continue;
        };

        if candidate_filename.trim() != filename {
            continue;
        }

        if checksum.is_some() {
            return Err(format!("Checksum duplicado para {filename}"));
        }

        if candidate.len() != 64 || !candidate.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Checksum SHA-256 inválido para {filename}"));
        }

        checksum = Some(candidate.to_ascii_lowercase());
    }

    checksum.ok_or_else(|| format!("Checksum no encontrado para {filename}"))
}

pub(super) fn fetch_node_checksum() -> Result<String, String> {
    let url = format!("https://nodejs.org/dist/v{}/SHASUMS256.txt", node::NODE_VERSION);
    let text = reqwest::blocking::get(&url)
        .map_err(|e| format!("Error descargando checksums: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando checksums: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo checksums: {e}"))?;

    let filename = node::node_download_url()
        .rsplit('/')
        .next()
        .ok_or_else(|| "No se pudo determinar el archivo de Node.js".to_string())?;

    node_checksum_from_manifest(&text, filename)
}

// ==================== TESTS ====================

#[cfg(test)]
mod tests {
    use super::*;
    use super::node::{
        activate_staged_node_runtime,
        build_portable_node_version_command,
        build_staged_node_version_command,
        managed_node_command,
        node_version_text_matches_expected,
        NODE_RUNTIME_MUTATION_LOCK,
    };
    #[cfg(target_os = "windows")]
    use super::node::extract_zip;
    #[cfg(not(target_os = "windows"))]
    use super::node::extract_node_tar_gz;
    use super::python::{
        activate_staged_python_runtime,
        build_managed_pip_install_command,
        build_portable_python_version_command,
        managed_python_command,
        managed_python_runtime_path,
        python_version_text_matches_expected,
        quarantine_python_runtime,
        PYTHON_RUNTIME_MUTATION_LOCK,
    };
    use super::npm::{
        activate_staged_notebooklm_mcp,
        build_managed_node_cli_version_command,
        build_managed_notebooklm_browser_command,
        build_managed_notebooklm_npm_command,
        build_managed_npm_install_command,
        managed_node_runtime_path,
        NOTEBOOKLM_RUNTIME_MUTATION_LOCK,
    };
    use super::skill::SKILL_RUNTIME_MUTATION_LOCK;
    use crate::paths;
    #[cfg(target_os = "windows")]
    use super::python::extract_official_python_zip;
    use std::fs;

    #[test]
    fn managed_node_command_uses_exact_program() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-program"));
    }

    #[test]
    fn managed_node_command_removes_node_options() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_node_command_starts_without_arguments() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_args().count(), 0);
    }

    #[test]
    fn managed_node_command_does_not_override_current_dir() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn managed_python_command_uses_exact_program() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
    }

    #[test]
    fn managed_python_command_starts_with_only_isolated_mode_argument() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("-I")]);
    }

    #[test]
    fn managed_python_command_does_not_override_current_dir() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn portable_python_version_command_uses_isolated_mode_and_version_argument() {
        let command = build_portable_python_version_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["-I", "--version"]);
    }

    #[test]
    fn runtime_install_lock_rejects_overlapping_operation() {
        let lock = std::sync::Mutex::new(());
        let guard = try_runtime_mutation_lock(&lock, "el runtime Node administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&lock, "el runtime Node administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Node administrado en curso."
        );
        drop(guard);
    }

    #[test]
    fn runtime_install_lock_allows_retry_after_guard_drop() {
        let lock = std::sync::Mutex::new(());
        let guard = try_runtime_mutation_lock(&lock, "el runtime Python administrado")
            .expect("primera adquisición debe ser Ok");
        drop(guard);
        let result = try_runtime_mutation_lock(&lock, "el runtime Python administrado");
        assert!(result.is_ok());
    }

    #[test]
    fn node_and_python_runtime_install_locks_are_independent() {
        let node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")
            .expect("lock Node debe estar libre");
        let python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")
            .expect("lock Python debe estar libre mientras Node está ocupado");
        drop(node_guard);
        drop(python_guard);
    }

    #[test]
    fn skill_and_notebooklm_runtime_mutation_locks_are_independent() {
        let skill_guard = try_runtime_mutation_lock(&SKILL_RUNTIME_MUTATION_LOCK, "el runtime Jintia administrado")
            .expect("lock Skill debe estar libre");
        let mcp_guard = try_runtime_mutation_lock(&NOTEBOOKLM_RUNTIME_MUTATION_LOCK, "el runtime NotebookLM MCP administrado")
            .expect("lock NotebookLM MCP debe estar libre mientras Skill está ocupado");
        drop(skill_guard);
        drop(mcp_guard);
    }

    #[test]
    fn node_runtime_mutation_lock_is_shared_by_node_dependents() {
        let node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Node administrado en curso."
        );
        drop(node_guard);
    }

    #[test]
    fn python_runtime_mutation_lock_serializes_prefix_mutations() {
        let python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Python administrado en curso."
        );
        drop(python_guard);
    }

    #[test]
    fn managed_npm_install_command_removes_node_options() {
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["some-package".to_string()],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_node_runtime_path_contains_only_portable_node_bin() {
        let path = managed_node_runtime_path().unwrap();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(entries, vec![paths::portable_node_bin_dir()]);
    }

    #[test]
    fn managed_python_runtime_path_contains_only_portable_python_dirs() {
        let python = paths::portable_python_exe();
        let path = managed_python_runtime_path(&python).unwrap();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        let prefix = paths::portable_python_prefix();
        let expected = if cfg!(target_os = "windows") {
            vec![prefix.clone(), prefix.join("Scripts")]
        } else {
            vec![prefix.join("bin")]
        };

        assert_eq!(entries, expected);
    }

    #[test]
    fn managed_pip_command_uses_portable_python_module() {
        let packages = vec!["pkg-a".to_string()];
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &packages,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
        assert_eq!(&args[..5], ["-I", "-m", "pip", "install", "--quiet"]);
    }

    #[test]
    fn managed_pip_command_uses_python_isolated_mode() {
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-only"),
            &[],
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(&args[..5], ["-I", "-m", "pip", "install", "--quiet"]);
    }

    #[test]
    fn managed_pip_command_uses_only_managed_path() {
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &[],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");

        assert_eq!(path, std::ffi::OsStr::new("managed-python-only"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_pip_command_preserves_package_arguments() {
        let packages = vec![
            "package-a>=1".to_string(),
            "package-b[extra]==2.0".to_string(),
        ];
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &packages,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(&args[5..], ["package-a>=1", "package-b[extra]==2.0"]);
    }

    #[test]
    fn install_pip_packages_empty_input_is_noop() {
        assert!(install_pip_packages(&[]).is_ok());
    }

    #[test]
    fn node_checksum_manifest_resolves_exact_asset() {
        let manifest = format!(
            "{}  node-v22.13.0-win-x64.zip\n{}  node-v22.13.0-darwin-arm64.tar.gz\n",
            "a".repeat(64),
            "b".repeat(64),
        );

        assert_eq!(
            node_checksum_from_manifest(&manifest, "node-v22.13.0-darwin-arm64.tar.gz")
                .unwrap(),
            "b".repeat(64)
        );
    }

    #[test]
    fn node_checksum_manifest_rejects_missing_asset() {
        let manifest = format!("{}  node-v22.13.0-win-x64.zip\n", "a".repeat(64));
        let error = node_checksum_from_manifest(&manifest, "node-v22.13.0-linux-x64.tar.gz")
            .unwrap_err();

        assert!(error.contains("Checksum no encontrado"));
    }

    #[test]
    fn node_checksum_manifest_rejects_malformed_sha256() {
        let short = node_checksum_from_manifest(
            "abc123  node-v22.13.0-win-x64.zip\n",
            "node-v22.13.0-win-x64.zip",
        )
        .unwrap_err();
        let non_hex = node_checksum_from_manifest(
            &format!("{}  node-v22.13.0-win-x64.zip\n", "g".repeat(64)),
            "node-v22.13.0-win-x64.zip",
        )
        .unwrap_err();

        assert!(short.contains("Checksum SHA-256 inválido"));
        assert!(non_hex.contains("Checksum SHA-256 inválido"));
    }

    #[test]
    fn node_checksum_manifest_rejects_duplicate_asset() {
        let manifest = format!(
            "{}  node-v22.13.0-win-x64.zip\n{}  node-v22.13.0-win-x64.zip\n",
            "a".repeat(64),
            "b".repeat(64),
        );
        let error = node_checksum_from_manifest(&manifest, "node-v22.13.0-win-x64.zip")
            .unwrap_err();

        assert!(error.contains("Checksum duplicado"));
    }

    #[test]
    fn verify_sha256_accepts_matching_digest() {
        let path = std::env::temp_dir().join(format!(
            "jintia-node-checksum-matching-{}",
            std::process::id()
        ));
        fs::write(&path, []).unwrap();

        let result = verify_sha256(
            &path,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        let _ = fs::remove_file(&path);

        assert!(result.is_ok());
    }

    #[test]
    fn verify_sha256_rejects_mismatch() {
        let path = std::env::temp_dir().join(format!(
            "jintia-node-checksum-mismatch-{}",
            std::process::id()
        ));
        fs::write(&path, []).unwrap();

        let result = verify_sha256(&path, &"a".repeat(64));
        let _ = fs::remove_file(&path);

        assert!(result.unwrap_err().contains("Checksum inválido"));
    }

    fn activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-node-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn node_activation_installs_staged_runtime_when_live_is_absent() {
        let root = activation_fixture("first");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_node).unwrap();
        fs::write(staged_node.join("marker-new"), "new").unwrap();

        activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir).unwrap();

        assert!(node_dir.join("marker-new").is_file());
        assert!(!staged_node.exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_activation_replaces_existing_runtime_after_staging() {
        let root = activation_fixture("replace");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_node).unwrap();
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(staged_node.join("marker-new"), "new").unwrap();
        fs::write(node_dir.join("marker-old"), "old").unwrap();

        activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir).unwrap();

        assert!(node_dir.join("marker-new").is_file());
        assert!(!node_dir.join("marker-old").exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_activation_restores_previous_runtime_when_stage_activation_fails() {
        let root = activation_fixture("rollback");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(node_dir.join("marker-old"), "old").unwrap();

        let error = activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir)
            .unwrap_err();

        assert!(error.contains("Error activando Node"));
        assert!(node_dir.join("marker-old").is_file());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn python_activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-python-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn python_activation_installs_staged_runtime_when_live_is_absent() {
        let root = python_activation_fixture("first");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_python).unwrap();
        fs::write(staged_python.join("marker-new"), "new").unwrap();

        activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(()), quarantine_python_runtime).unwrap();

        assert!(python_dir.join("marker-new").is_file());
        assert!(!staged_python.exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_activation_replaces_existing_runtime_after_staging() {
        let root = python_activation_fixture("replace");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_python).unwrap();
        fs::create_dir_all(&python_dir).unwrap();
        fs::write(staged_python.join("marker-new"), "new").unwrap();
        fs::write(python_dir.join("marker-old"), "old").unwrap();

        activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(()), quarantine_python_runtime).unwrap();

        assert!(python_dir.join("marker-new").is_file());
        assert!(!python_dir.join("marker-old").exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_activation_restores_previous_runtime_when_stage_activation_fails() {
        let root = python_activation_fixture("rollback");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&python_dir).unwrap();
        fs::write(python_dir.join("marker-old"), "old").unwrap();

        let error = activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(()), quarantine_python_runtime)
            .unwrap_err();

        assert!(error.contains("Error activando Python"));
        assert!(python_dir.join("marker-old").is_file());
        assert!(!backup_dir.exists());
        assert!(!python_dir.join("marker-new").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn notebooklm_activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-notebooklm-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn notebooklm_activation_installs_staged_runtime_when_live_is_absent() {
        let root = notebooklm_activation_fixture("first");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| Ok(())).unwrap();
        assert!(active.join("marker-new").is_file());
        assert!(!stage.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_replaces_existing_runtime_after_validation() {
        let root = notebooklm_activation_fixture("replace");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&active).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        activate_staged_notebooklm_mcp(&stage, &active, &backup, |active_root| {
            assert!(active_root.join("marker-new").is_file());
            Ok(())
        })
        .unwrap();
        assert!(active.join("marker-new").is_file());
        assert!(!active.join("marker-old").exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_restores_previous_runtime_when_stage_move_fails() {
        let root = notebooklm_activation_fixture("stage-rollback");
        let stage = root.join("missing-stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&active).unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| Ok(())).unwrap_err();
        assert!(error.contains("Error activando NotebookLM MCP"));
        assert!(active.join("marker-old").is_file());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_restores_previous_runtime_when_active_validation_fails() {
        let root = notebooklm_activation_fixture("validation-rollback");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&active).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| {
            Err("validation failed".to_string())
        })
        .unwrap_err();
        assert!(error.contains("validation failed"));
        assert!(active.join("marker-old").is_file());
        assert!(!active.join("marker-new").exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_removes_invalid_first_install() {
        let root = notebooklm_activation_fixture("invalid-first");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| {
            Err("validation failed".to_string())
        })
        .unwrap_err();
        assert!(error.contains("validation failed"));
        assert!(!active.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_npm_command_uses_managed_node_and_npm_cli() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &["ci"],
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(&args[..2], ["managed-npm-cli.js", "ci"]);
    }

    #[test]
    fn notebooklm_npm_command_uses_only_managed_path() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["ci"],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn notebooklm_npm_command_runs_inside_staging() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &["ci"],
        );
        assert_eq!(
            command.get_current_dir(),
            Some(std::path::Path::new("managed-stage"))
        );
    }

    #[test]
    fn notebooklm_npm_command_preserves_package_lock_arguments() {
        let args = [
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ];
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &args,
        );
        let actual: Vec<_> = command.get_args().skip(1).collect();
        assert_eq!(actual, args.map(std::ffi::OsStr::new).to_vec());
    }

    #[test]
    fn notebooklm_npm_command_preserves_ci_arguments() {
        let args = [
            "ci",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ];
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &args,
        );
        let actual: Vec<_> = command.get_args().skip(1).collect();
        assert_eq!(actual, args.map(std::ffi::OsStr::new).to_vec());
    }

    #[test]
    fn notebooklm_npm_command_removes_node_options() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["ci"],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn notebooklm_browser_command_uses_managed_node_and_bin() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(args[0], "managed-mcp-bin.js");
    }

    #[test]
    fn notebooklm_browser_command_uses_only_managed_path() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
            "status",
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn notebooklm_browser_command_removes_node_options() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
            "status",
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn notebooklm_browser_command_preserves_status_arguments() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [
            std::ffi::OsStr::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("browser"),
            std::ffi::OsStr::new("status"),
            std::ffi::OsStr::new("--json"),
        ]);
    }

    #[test]
    fn notebooklm_browser_command_preserves_install_arguments() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "install",
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [
            std::ffi::OsStr::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("browser"),
            std::ffi::OsStr::new("install"),
            std::ffi::OsStr::new("--json"),
        ]);
    }

    #[test]
    fn notebooklm_browser_command_does_not_override_current_dir() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        assert!(command.get_current_dir().is_none());
    }

    #[test]
    fn node_version_text_accepts_exact_managed_version() {
        assert!(node_version_text_matches_expected("v22.13.0"));
        assert!(node_version_text_matches_expected(" v22.13.0\n"));
    }

    #[test]
    fn node_version_text_rejects_unexpected_runtime_version() {
        assert!(!node_version_text_matches_expected("v21.0.0"));
        assert!(!node_version_text_matches_expected("v22.13.1"));
        assert!(!node_version_text_matches_expected("22.13.0"));
    }

    #[test]
    fn staged_node_version_command_uses_exact_node_and_version_argument() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("staged-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("--version")]);
    }

    #[test]
    fn staged_node_version_command_removes_node_options() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn staged_node_version_command_has_only_version_argument() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        assert_eq!(command.get_args().count(), 1);
        assert_eq!(
            command.get_args().next(),
            Some(std::ffi::OsStr::new("--version"))
        );
    }

    #[test]
    fn portable_node_version_command_uses_exact_node_and_version_argument() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("portable-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("--version")]);
    }

    #[test]
    fn portable_node_version_command_removes_node_options() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn portable_node_version_command_has_only_version_argument() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_args().count(), 1);
        assert_eq!(
            command.get_args().next(),
            Some(std::ffi::OsStr::new("--version"))
        );
    }

    #[test]
    fn portable_node_version_command_does_not_override_current_dir() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn python_version_text_accepts_exact_managed_version() {
        assert!(python_version_text_matches_expected("Python 3.13.15"));
        assert!(python_version_text_matches_expected(" Python 3.13.15\n"));
    }

    #[test]
    fn python_version_text_rejects_unexpected_patch_version() {
        assert!(!python_version_text_matches_expected("Python 3.13.14"));
        assert!(!python_version_text_matches_expected("Python 3.13.16"));
        assert!(!python_version_text_matches_expected("Python 3.13.0"));
    }

    #[test]
    fn python_version_text_rejects_other_python_series() {
        assert!(!python_version_text_matches_expected("Python 3.12.15"));
        assert!(!python_version_text_matches_expected("Python 3.14.0"));
    }

    #[test]
    fn python_version_text_rejects_non_exact_version_output() {
        assert!(!python_version_text_matches_expected("Python 3.13.15rc1"));
        assert!(!python_version_text_matches_expected("Python 3.13.15 custom"));
        assert!(!python_version_text_matches_expected("3.13.15"));
    }

    #[test]
    fn disciplinary_npm_command_uses_managed_node_and_npm_cli() {
        let packages = vec!["pkg-a".to_string(), "@scope/pkg-b".to_string()];
        let managed_path = std::ffi::OsString::from("managed-bin");
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            &managed_path,
            &packages,
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(args, vec![
            std::ffi::OsStr::new("managed-npm-cli.js"),
            std::ffi::OsStr::new("install"),
            std::ffi::OsStr::new("--global"),
            std::ffi::OsStr::new("--prefix"),
            std::ffi::OsStr::new("managed-prefix"),
            std::ffi::OsStr::new("pkg-a"),
            std::ffi::OsStr::new("@scope/pkg-b"),
        ]);
    }

    #[test]
    fn disciplinary_npm_command_uses_only_managed_path() {
        let managed_path = std::ffi::OsString::from("managed-only-bin");
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            &managed_path,
            &[],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn disciplinary_npm_command_preserves_package_arguments() {
        let packages = vec!["@scope/pkg@1.2.3".to_string(), "plain-package@4.5.6".to_string()];
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            std::ffi::OsStr::new("managed-bin"),
            &packages,
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(&args[5..], [
            std::ffi::OsStr::new("@scope/pkg@1.2.3"),
            std::ffi::OsStr::new("plain-package@4.5.6"),
        ]);
        assert_ne!(command.get_program(), std::ffi::OsStr::new("npm"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("npm.cmd"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("cmd"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("sh"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("bash"));
    }

    #[test]
    fn install_npm_packages_empty_input_is_noop() {
        assert!(install_npm_packages(&[]).is_ok());
    }

    #[test]
    fn managed_node_cli_version_command_uses_only_managed_path() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_node_cli_version_command_preserves_arguments() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version", "--verbose"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(&args[args.len() - 2..], [
            std::ffi::OsStr::new("--version"),
            std::ffi::OsStr::new("--verbose"),
        ]);
    }

    #[test]
    fn managed_node_cli_version_command_uses_expected_launcher() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new(if cfg!(target_os = "windows") {
                "managed-cli.cmd"
            } else {
                "managed-cli"
            }),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        if cfg!(target_os = "windows") {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("cmd"));
            assert_eq!(&args[..2], [
                std::ffi::OsStr::new("/C"),
                std::ffi::OsStr::new("managed-cli.cmd"),
            ]);
        } else {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
            assert_eq!(&args[..1], [std::ffi::OsStr::new("managed-cli")]);
        }
    }

    #[test]
    fn managed_node_cli_version_command_supports_vivliostyle_version() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new(if cfg!(target_os = "windows") {
                "vivliostyle.cmd"
            } else {
                "vivliostyle"
            }),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        if cfg!(target_os = "windows") {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("cmd"));
            assert_eq!(&args[..3], [
                std::ffi::OsStr::new("/C"),
                std::ffi::OsStr::new("vivliostyle.cmd"),
                std::ffi::OsStr::new("--version"),
            ]);
        } else {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
            assert_eq!(&args[..2], [
                std::ffi::OsStr::new("vivliostyle"),
                std::ffi::OsStr::new("--version"),
            ]);
        }
    }

    #[test]
    fn managed_node_cli_version_command_removes_node_options() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[cfg(target_os = "windows")]
    fn zip_fixture(name: &str, entry: &str, bytes: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("jintia-node-zip-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join(name);
        let file = fs::File::create(&archive_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(entry, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
        (archive_path, root.join("dest"))
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_zip_keeps_node_under_managed_runtime() {
        let (archive, dest) = zip_fixture("node.zip", "node-v22.13.0-win-x64/bin/node.exe", b"node");
        fs::create_dir_all(&dest).unwrap();
        extract_zip(&archive, &dest).unwrap();
        assert_eq!(fs::read(dest.join("node/bin/node.exe")).unwrap(), b"node");
        let root = archive.parent().unwrap();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_zip_rejects_path_traversal() {
        let (archive, dest) = zip_fixture("unsafe.zip", "../escape.txt", b"escape");
        fs::create_dir_all(&dest).unwrap();
        assert!(extract_zip(&archive, &dest).is_err());
        assert!(!dest.parent().unwrap().join("escape.txt").exists());
        let root = archive.parent().unwrap();
        fs::remove_dir_all(&dest).ok();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_official_python_zip_keeps_flat_runtime_under_managed_prefix() {
        let (archive, dest) = zip_fixture("python.zip", "python.exe", b"python");
        extract_official_python_zip(&archive, &dest).unwrap();
        assert_eq!(fs::read(dest.join("python.exe")).unwrap(), b"python");
        let root = archive.parent().unwrap();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_official_python_zip_rejects_path_traversal() {
        let (archive, dest) = zip_fixture("python-unsafe.zip", "../escape.txt", b"escape");
        assert!(extract_official_python_zip(&archive, &dest).is_err());
        assert!(!dest.parent().unwrap().join("escape.txt").exists());
        let root = archive.parent().unwrap();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(not(target_os = "windows"))]
    fn tar_gz_fixture(
        name: &str,
        entries: &[(&str, &[u8])],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        use tar::Builder;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-node-tar-gz-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("node.tar.gz");
        let file = fs::File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);

        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *path, *bytes).unwrap();
        }

        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
        (archive_path, root.join("dest"))
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_normalizes_single_node_root() {
        let (archive, dest) = tar_gz_fixture(
            "normal",
            &[("node-v22.13.0-test/bin/marker", b"marker")],
        );
        fs::create_dir_all(&dest).unwrap();

        extract_node_tar_gz(&archive, &dest).unwrap();

        assert_eq!(fs::read(dest.join("node/bin/marker")).unwrap(), b"marker");
        assert!(!dest.join("node-v22.13.0-test").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_rejects_missing_node_root() {
        let (archive, dest) = tar_gz_fixture("missing-root", &[("unexpected-root/file", b"file")]);
        fs::create_dir_all(&dest).unwrap();

        let error = extract_node_tar_gz(&archive, &dest).unwrap_err();

        assert!(error.contains("directorio raíz esperado"));
        assert!(!dest.join("node").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_rejects_multiple_node_roots() {
        let (archive, dest) = tar_gz_fixture(
            "multiple-roots",
            &[
                ("node-v22.13.0-a/file", b"a"),
                ("node-v22.13.0-b/file", b"b"),
            ],
        );
        fs::create_dir_all(&dest).unwrap();

        let error = extract_node_tar_gz(&archive, &dest).unwrap_err();

        assert!(error.contains("múltiples directorios raíz"));
        assert!(!dest.join("node").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    fn contract() -> crate::release::ManagedMcpContract {
        crate::release::ManagedMcpContract { package: "@scope/pkg".into(), version: "2.3.10".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-AAAA".into(), jintia_version: "11.6.10".into() }
    }

    #[test]
    fn package_and_lock_match_contract_exactly() {
        use super::npm::notebooklm_package_matches_contract;
        let c = contract();
        let package = serde_json::json!({"name":"@scope/pkg","version":"2.3.10"});
        let lock = serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.10","integrity":"sha512-AAAA"}}});
        assert!(notebooklm_package_matches_contract(&package, &lock, &c));
        for (package, lock) in [
            (serde_json::json!({"name":"other","version":"2.3.10"}), lock.clone()),
            (serde_json::json!({"name":"@scope/pkg","version":"2.3.9"}), lock.clone()),
            (package.clone(), serde_json::json!({"packages":{}})),
            (package.clone(), serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.9","integrity":"sha512-AAAA"}}})),
            (package.clone(), serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.10","integrity":"sha512-BBBB"}}})),
        ] { assert!(!notebooklm_package_matches_contract(&package, &lock, &c)); }
    }

    #[test]
    fn notebooklm_lock_entry_resolves_scoped_package() {
        use super::npm::notebooklm_lock_entry;
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "node_modules/@charlie.act7/gemini-notebook-mcp": {
                    "version": "2.3.3",
                    "integrity": "sha512-test"
                }
            }
        });
        let entry = notebooklm_lock_entry(&lock, "@charlie.act7/gemini-notebook-mcp").expect("debe resolver la clave scoped completa");
        assert_eq!(entry.get("version").and_then(|value| value.as_str()), Some("2.3.3"));
        assert_eq!(entry.get("integrity").and_then(|value| value.as_str()), Some("sha512-test"));
    }

    #[test]
    fn notebooklm_lock_entry_returns_none_when_package_is_missing() {
        use super::npm::notebooklm_lock_entry;
        let lock = serde_json::json!({ "packages": {} });
        assert!(notebooklm_lock_entry(&lock, "@charlie.act7/gemini-notebook-mcp").is_none());
    }

    #[test]
    fn resolve_notebooklm_mcp_bin_accepts_string_and_scoped_bin_object() {
        let contract = crate::release::ManagedMcpContract { package: "@charlie.act7/gemini-notebook-mcp".into(), version: "2.3.5".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-test".into(), jintia_version: "11.6.8".into() };
        let root = std::env::temp_dir().join(format!("jintia-mcp-bin-test-{}", crate::paths::timestamp()));
        let package = root.join("node_modules/@charlie.act7/gemini-notebook-mcp");
        let cli = ["dist", "cli.js"].join("/");
        fs::create_dir_all(package.join("dist")).unwrap();
        fs::write(package.join(&cli), "#!/usr/bin/env node\n").unwrap();
        fs::write(package.join("package.json"), serde_json::json!({
            "name": contract.package,
            "version": contract.version,
            "bin": { "gemini-notebook-mcp": cli }
        }).to_string()).unwrap();
        assert_eq!(resolve_notebooklm_mcp_bin_for(&package, &contract).unwrap(), fs::canonicalize(package.join(&cli)).unwrap());
        fs::write(package.join("package.json"), serde_json::json!({
            "name": contract.package,
            "version": contract.version,
            "bin": cli
        }).to_string()).unwrap();
        assert!(resolve_notebooklm_mcp_bin_for(&package, &contract).is_ok());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn resolve_notebooklm_mcp_bin_rejects_escape_and_missing_bin() {
        let root = std::env::temp_dir().join(format!("jintia-mcp-bin-invalid-{}", crate::paths::timestamp()));
        let package = root.join("package");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.json"), serde_json::json!({
            "name": "@charlie.act7/gemini-notebook-mcp",
            "version": "2.3.5",
            "bin": { "other": "../escape.js" }
        }).to_string()).unwrap();
        let contract = crate::release::ManagedMcpContract { package: "@charlie.act7/gemini-notebook-mcp".into(), version: "2.3.5".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-test".into(), jintia_version: "11.6.8".into() };
        assert!(resolve_notebooklm_mcp_bin_for(&package, &contract).is_err());
        fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod python_activation_tests {
    use super::python::{
        activate_staged_python_runtime,
        retry_python_runtime_validation,
    };
    #[cfg(target_os = "windows")]
    use super::python::{
        resolve_python_asset,
        PYTHON_OFFICIAL_ARCHIVE_URL,
        PYTHON_OFFICIAL_ARCHIVE_SHA256,
    };
    use std::fs;

    fn make_temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jintia-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("crear temp dir");
        dir
    }

    fn touch_marker(dir: &std::path::Path, name: &str) {
        fs::write(dir.join(name), b"marker").expect("crear marker");
    }

    fn inline_quarantine(p: &std::path::Path) -> Result<(), String> {
        let q = p.with_extension("invalid-test");
        if q.exists() {
            fs::remove_dir_all(&q).map_err(|e| format!("cleanup preexistente: {e}"))?;
        }
        fs::rename(p, &q).map_err(|e| format!("rename: {e}"))?;
        if let Err(_) = fs::remove_dir_all(&q) {}
        Ok(())
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn official_python_asset_is_pinned_and_portable() {
        let asset = resolve_python_asset().expect("resolver asset oficial");
        assert_eq!(asset.filename, "python-3.13.15-amd64.zip");
        assert_eq!(asset.url, PYTHON_OFFICIAL_ARCHIVE_URL);
        assert_eq!(asset.sha256, PYTHON_OFFICIAL_ARCHIVE_SHA256);
        assert_eq!(asset.sha256.len(), 64);
    }

    #[test]
    fn python_final_validation_retries_transient_failures() {
        let prefix = std::path::Path::new("managed-python");
        let mut validations = 0;
        let mut waits = 0;

        let result = retry_python_runtime_validation(
            prefix,
            4,
            |_| {
                validations += 1;
                if validations < 3 {
                    Err("archivo temporalmente bloqueado".to_string())
                } else {
                    Ok(())
                }
            },
            || waits += 1,
        );

        assert!(result.is_ok());
        assert_eq!(validations, 3, "debe detenerse en el primer éxito");
        assert_eq!(waits, 2, "debe esperar solamente entre intentos fallidos");
    }

    #[test]
    fn python_final_validation_reports_the_last_failure() {
        let prefix = std::path::Path::new("managed-python");
        let mut validations = 0;
        let mut waits = 0;

        let error = retry_python_runtime_validation(
            prefix,
            3,
            |_| {
                validations += 1;
                Err(format!("fallo {validations}"))
            },
            || waits += 1,
        )
        .unwrap_err();

        assert_eq!(validations, 3);
        assert_eq!(waits, 2);
        assert!(error.contains("después de 3 intentos"));
        assert!(error.contains("fallo 3"), "debe conservar el diagnóstico más reciente");
    }

    #[test]
    fn python_activation_validates_the_final_path_before_removing_backup() {
        let staged = make_temp_dir("staged");
        let python_dir = make_temp_dir("python_dir");
        let backup_dir = std::env::temp_dir().join(format!("jintia-test-backup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");

        let mut validated_path: Option<std::path::PathBuf> = None;

        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |p| { validated_path = Some(p.to_path_buf()); Ok(()) },
            |_| unreachable!("evict no debe llamarse si la validación es exitosa"),
        );

        assert!(result.is_ok(), "la activación debe tener éxito: {result:?}");

        let validated = validated_path.expect("el validador debe haberse llamado");
        assert_eq!(validated, python_dir, "el validador debe recibir la ruta final");

        assert!(python_dir.join("staged.marker").exists(), "el marker debe estar en python_dir");
        assert!(!staged.exists() || !staged.join("staged.marker").exists());
        assert!(!backup_dir.exists());

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_removes_backup_only_after_successful_validation() {
        let staged = make_temp_dir("staged2");
        let python_dir = make_temp_dir("python_dir2");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |_| Ok(()),
            |_| unreachable!("evict no debe llamarse si la validación es exitosa"),
        );

        assert!(result.is_ok());
        assert!(!backup_dir.exists(), "el backup debe eliminarse tras validación exitosa");

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_restores_previous_runtime_when_final_validation_fails() {
        let staged = make_temp_dir("staged3");
        let python_dir = make_temp_dir("python_dir3");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |_| Err("validación final falló".to_string()),
            inline_quarantine,
        );

        assert!(result.is_err(), "debe retornar error si la validación final falla");
        assert!(result.unwrap_err().contains("verificación final"));

        assert!(python_dir.exists(), "python_dir debe existir (runtime restaurado)");
        assert!(
            python_dir.join("previous.marker").exists(),
            "el runtime anterior debe estar restaurado"
        );
        assert!(!python_dir.join("staged.marker").exists(), "runtime inválido no debe estar activo");
        assert!(!backup_dir.exists(), "el backup no debe permanecer tras restauración");

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_removes_invalid_runtime_when_no_backup_exists() {
        let staged = make_temp_dir("staged4");
        let python_dir = std::env::temp_dir()
            .join(format!("jintia-test-python4-{}", std::process::id()));
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup4-{}", std::process::id()));
        let _ = fs::remove_dir_all(&python_dir);
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");

        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |_| Err("ejecutable no válido".to_string()),
            inline_quarantine,
        );

        assert!(result.is_err());
        assert!(!python_dir.exists(), "el runtime inválido no debe permanecer en python_dir");
    }

    #[test]
    fn python_activation_handles_preexisting_quarantine_before_rollback() {
        let staged = make_temp_dir("staged_q");
        let python_dir = make_temp_dir("python_q");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup-q-{}", std::process::id()));
        let quarantine = std::env::temp_dir()
            .join(format!("jintia-test-quarantine-q-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);
        let _ = fs::remove_dir_all(&quarantine);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        // Simula un quarantine preexistente de una activación fallida anterior.
        fs::create_dir_all(&quarantine).expect("crear quarantine preexistente");
        touch_marker(&quarantine, "leftover.marker");

        let quarantine_clone = quarantine.clone();
        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |_| Err("validación fallida".to_string()),
            move |p| {
                if quarantine_clone.exists() {
                    fs::remove_dir_all(&quarantine_clone)
                        .map_err(|e| format!("limpieza preexistente: {e}"))?;
                }
                fs::rename(p, &quarantine_clone).map_err(|e| format!("rename: {e}"))?;
                if let Err(_) = fs::remove_dir_all(&quarantine_clone) {}
                Ok(())
            },
        );

        assert!(result.is_err());

        // El runtime anterior debe haber sido restaurado.
        assert!(python_dir.exists(), "python_dir debe existir tras restauración");
        assert!(
            python_dir.join("previous.marker").exists(),
            "el runtime anterior debe estar restaurado"
        );
        // El runtime inválido no debe estar activo.
        assert!(!python_dir.join("staged.marker").exists(), "runtime inválido no activo");

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_reports_failure_to_evict_invalid_runtime() {
        let staged = make_temp_dir("staged_evict");
        let python_dir = make_temp_dir("python_evict");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup-evict-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        let result = activate_staged_python_runtime(
            &staged, &python_dir, &backup_dir,
            |_| Err("validación fallida".to_string()),
            |_| Err("imposible apartar el runtime".to_string()),
        );

        assert!(result.is_err());
        let msg = result.unwrap_err();

        // El mensaje debe incluir el error de validación y el de desalojo.
        assert!(msg.contains("verificación final"), "debe incluir error de validación: {msg}");
        assert!(msg.contains("apartar"), "debe incluir error de desalojo: {msg}");

        // El backup no debe haberse tocado: python_dir seguía ocupado cuando evict falló.
        assert!(backup_dir.exists(), "el backup debe estar preservado");
        assert!(
            backup_dir.join("previous.marker").exists(),
            "el contenido del backup debe estar intacto"
        );

        // python_dir contiene el runtime inválido (evict no lo movió).
        assert!(
            python_dir.join("staged.marker").exists(),
            "el runtime inválido sigue en python_dir"
        );

        let _ = fs::remove_dir_all(&python_dir);
        let _ = fs::remove_dir_all(&backup_dir);
    }
}
