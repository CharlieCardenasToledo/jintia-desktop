use semver::{Version, VersionReq};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

// ── Contrato MCP (retrocompatibilidad) ─────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedMcpContract {
    pub package: String,
    pub version: String,
    pub node_requirement: String,
    pub npm_integrity: String,
    pub jintia_version: String,
}

// ── Contrato completo release-config.json ──────────────────────────────────

/// Contrato completo de una release de Jintia, combinando package.json y
/// release-config.json.  Es el único lugar del proyecto que debe leer esos
/// archivos; el resto del código consume tipos de aquí.
// jintia_version, minimum_desktop_version y runtime_node_requirement se parsean
// en su totalidad porque este struct es la única lectura autorizada del
// contrato (ver doc de arriba), aunque hoy solo `mcp` y `profile_binaries`
// tienen consumidores. Quedan disponibles para el futuro gate de versión
// mínima de Desktop y el chequeo de Node en `doctor`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct JintiaReleaseContract {
    pub jintia_version: String,
    pub minimum_desktop_version: Version,
    /// Requisito de Node para ejecutar la skill (runtime.node).
    pub runtime_node_requirement: VersionReq,
    pub mcp: ManagedMcpContract,
    /// Binarios de perfil declarados en profileBinaries, indexados por id.
    pub profile_binaries: HashMap<String, ProfileBinaryContract>,
}

#[derive(Debug, Clone)]
pub struct ProfileBinaryContract {
    #[allow(dead_code)]
    pub version: String,
    /// Especificación para la plataforma actual; None si no está declarada.
    pub current_platform_spec: Option<BinaryPlatformSpec>,
}

/// Variantes de instalación de un binario de perfil.
#[derive(Debug, Clone)]
pub enum BinaryPlatformSpec {
    /// El binario puede descargarse automáticamente.
    Download(BinaryDownloadSpec),
    /// Requiere instalación manual; se incluye un hint accionable para el usuario.
    ManualOnly { hint: String },
}

#[derive(Debug, Clone)]
pub struct BinaryDownloadSpec {
    pub url: String,
    pub sha256: String,
    /// "zip" | "tar.gz"
    pub archive_type: String,
    /// Subdirectorio dentro del archivo comprimido cuyos contenidos van a bin/.
    pub bin_subdir: Option<String>,
}

/// Clave de la plataforma actual (mismos valores que `current_platform_key()` en runtimes.rs).
fn platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "win32-x64";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64";
    #[allow(unreachable_code)]
    "unknown"
}

fn parse_binary_platform_spec(spec: &Value) -> Option<BinaryPlatformSpec> {
    if let Some(hint) = spec.get("manualInstallHint").and_then(Value::as_str) {
        return Some(BinaryPlatformSpec::ManualOnly { hint: hint.to_string() });
    }
    let url = spec.get("url").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.starts_with("PENDING"))?;
    let sha256 = spec.get("sha256").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.starts_with("PENDING"))?;
    let archive_type = spec.get("archiveType").and_then(Value::as_str).unwrap_or("zip");
    let bin_subdir = spec.get("binSubdir").and_then(Value::as_str).map(str::to_string);
    Some(BinaryPlatformSpec::Download(BinaryDownloadSpec {
        url: url.to_string(),
        sha256: sha256.to_string(),
        archive_type: archive_type.to_string(),
        bin_subdir,
    }))
}

fn parse_profile_binaries(release: &Value) -> HashMap<String, ProfileBinaryContract> {
    let platform = platform_key();
    let Some(binaries_obj) = release.get("profileBinaries").and_then(Value::as_object) else {
        return HashMap::new();
    };
    binaries_obj
        .iter()
        .map(|(id, entry)| {
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let current_platform_spec = entry
                .get("platforms")
                .and_then(|p| p.get(platform))
                .and_then(parse_binary_platform_spec);
            (id.clone(), ProfileBinaryContract { version, current_platform_spec })
        })
        .collect()
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("El contrato Jintia requiere {key} como string no vacío."))
}

fn valid_sri(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("sha512-") else {
        return false;
    };
    if encoded.is_empty() || !encoded.is_ascii() || encoded.len() % 4 != 0 {
        return false;
    }
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count();
    if padding > 2 || padding == encoded.len() {
        return false;
    }
    let body_len = encoded.len() - padding;
    encoded.as_bytes()[..body_len]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && encoded.as_bytes()[body_len..]
            .iter()
            .all(|byte| *byte == b'=')
}

fn parse_stable_version(value: &str, label: &str) -> Result<Version, String> {
    let version = Version::parse(value).map_err(|e| format!("{label} inválida: {e}"))?;
    if !version.pre.is_empty() {
        return Err(format!("{label} no puede ser una versión prerelease."));
    }
    Ok(version)
}

/// Parsea el contrato completo a partir de los bytes de `package.json` y
/// `release-config.json`.  Es el único punto de entrada de parsing; todas las
/// funciones públicas delegan aquí.
pub fn parse_release_contract(
    package_json_bytes: &[u8],
    release_config_bytes: &[u8],
    desktop_version: &str,
) -> Result<JintiaReleaseContract, String> {
    let package: Value = serde_json::from_slice(package_json_bytes)
        .map_err(|e| format!("package.json de Jintia inválido: {e}"))?;
    let release: Value = serde_json::from_slice(release_config_bytes)
        .map_err(|e| format!("release/release-config.json de Jintia inválido: {e}"))?;
    if required_string(&package, "name")? != "@charlie.act7/jintia" {
        return Err("El paquete administrado no es @charlie.act7/jintia.".into());
    }
    let jintia_version = required_string(&package, "version")?.to_string();
    Version::parse(&jintia_version).map_err(|e| format!("Versión Jintia inválida: {e}"))?;
    if required_string(&release, "$schemaVersion")? != "1.0.0"
        || required_string(&release, "repository")? != "CharlieCardenasToledo/jintia"
    {
        return Err("El contrato Jintia no pertenece al repositorio canónico.".into());
    }
    let minimum = required_string(&release, "minimumDesktopVersion")?;
    let minimum_desktop_version =
        Version::parse(minimum).map_err(|e| format!("minimumDesktopVersion inválida: {e}"))?;
    let desktop =
        Version::parse(desktop_version).map_err(|e| format!("Versión Desktop inválida: {e}"))?;
    if desktop < minimum_desktop_version {
        return Err(format!(
            "Jintia {jintia_version} requiere Jintia Desktop {minimum} o superior (tienes {desktop}). \
             Actualiza Jintia Desktop para instalar esta versión de Jintia; tu instalación actual no se modifica."
        ));
    }
    let runtime_node_str = release
        .get("runtime")
        .and_then(|r| r.get("node"))
        .and_then(Value::as_str)
        .unwrap_or(">=22.13.0");
    let runtime_node_requirement = VersionReq::parse(runtime_node_str)
        .map_err(|e| format!("runtime.node inválido en el contrato Jintia: {e}"))?;
    let mcp = release
        .get("mcp")
        .ok_or("El contrato Jintia no contiene mcp.")?;
    let package_name = required_string(mcp, "package")?;
    if package_name != "@charlie.act7/gemini-notebook-mcp" {
        return Err("El contrato MCP no usa el paquete canónico.".into());
    }
    let version = required_string(mcp, "version")?.to_string();
    parse_stable_version(&version, "Versión MCP")?;
    let mcp_node_requirement = required_string(mcp, "node")?.to_string();
    VersionReq::parse(&mcp_node_requirement)
        .map_err(|e| format!("Requisito Node del MCP inválido: {e}"))?;
    let npm_integrity = required_string(mcp, "npmIntegrity")?.to_string();
    if !valid_sri(&npm_integrity) {
        return Err("npmIntegrity no es un SRI SHA-512 válido.".into());
    }
    let mcp_contract = ManagedMcpContract {
        package: package_name.to_string(),
        version,
        node_requirement: mcp_node_requirement,
        npm_integrity,
        jintia_version: jintia_version.clone(),
    };
    let profile_binaries = parse_profile_binaries(&release);
    Ok(JintiaReleaseContract {
        jintia_version,
        minimum_desktop_version,
        runtime_node_requirement,
        mcp: mcp_contract,
        profile_binaries,
    })
}

// Solo tiene consumidores en `#[cfg(test)]` (fixtures con bytes sintéticos, sin
// tocar el filesystem); `cargo check` sin --tests la reporta como dead_code
// aunque `cargo test` sí la ejercita. Mantiene la firma original para no
// romper los tests existentes que la invocan directamente.
#[allow(dead_code)]
pub fn parse_managed_mcp_contract(
    package_json_bytes: &[u8],
    release_config_bytes: &[u8],
    desktop_version: &str,
) -> Result<ManagedMcpContract, String> {
    parse_release_contract(package_json_bytes, release_config_bytes, desktop_version)
        .map(|c| c.mcp)
}

pub fn managed_release_contract_from(
    package_root: &Path,
    desktop_version: &str,
) -> Result<JintiaReleaseContract, String> {
    let root = fs::canonicalize(package_root)
        .map_err(|e| format!("No se pudo resolver el package Jintia: {e}"))?;
    if !root.is_dir() {
        return Err("El package Jintia no es un directorio.".into());
    }
    let package_path = fs::canonicalize(root.join("package.json"))
        .map_err(|e| format!("package.json de Jintia inválido: {e}"))?;
    let release_path = fs::canonicalize(root.join("release").join("release-config.json"))
        .map_err(|e| format!("release/release-config.json inválido: {e}"))?;
    if !package_path.starts_with(&root)
        || !release_path.starts_with(&root)
        || !package_path.is_file()
        || !release_path.is_file()
    {
        return Err("El contrato Jintia escapa del package administrado.".into());
    }
    let package_json = fs::read(package_path)
        .map_err(|_| "El Jintia administrado no contiene el contrato distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    let release_config = fs::read(release_path)
        .map_err(|_| "El Jintia administrado no contiene el contrato distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    parse_release_contract(&package_json, &release_config, desktop_version)
}

pub fn managed_release_contract() -> Result<JintiaReleaseContract, String> {
    managed_release_contract_from(
        &crate::paths::portable_skill_npm_package_dir(),
        env!("CARGO_PKG_VERSION"),
    )
}

pub fn managed_mcp_contract_from(
    package_root: &Path,
    desktop_version: &str,
) -> Result<ManagedMcpContract, String> {
    managed_release_contract_from(package_root, desktop_version).map(|c| c.mcp)
}

pub fn managed_mcp_contract() -> Result<ManagedMcpContract, String> {
    managed_mcp_contract_from(
        &crate::paths::portable_skill_npm_package_dir(),
        env!("CARGO_PKG_VERSION"),
    )
}

// ── Resolución de "latest compatible" (evita instalar un @latest que exija
// una versión de Desktop más nueva que la instalada) ───────────────────────

const REGISTRY_METADATA_URL: &str = "https://registry.npmjs.org/@charlie.act7%2Fjintia";
/// Tope de versiones candidatas a inspeccionar (de más reciente a más
/// antigua) antes de rendirse y dejar que el llamador use "@latest" —
/// evita una cadena de descargas ilimitada si hay muchas versiones
/// incompatibles publicadas.
const MAX_COMPATIBILITY_CANDIDATES: usize = 15;

/// Extrae, de la respuesta JSON del registro npm (`GET /<paquete>`), las
/// versiones estables (sin prerelease) junto a la URL de su tarball,
/// ordenadas de más reciente a más antigua. Función pura: no hace I/O, para
/// poder probarla con fixtures.
fn parse_registry_versions(body: &[u8]) -> Result<Vec<(Version, String)>, String> {
    let packument: Value =
        serde_json::from_slice(body).map_err(|e| format!("Metadatos npm inválidos: {e}"))?;
    let versions = packument
        .get("versions")
        .and_then(Value::as_object)
        .ok_or("Metadatos npm sin campo 'versions'.")?;
    let mut parsed: Vec<(Version, String)> = versions
        .iter()
        .filter_map(|(raw_version, entry)| {
            let version = Version::parse(raw_version).ok()?;
            if !version.pre.is_empty() {
                return None;
            }
            let tarball = entry.get("dist")?.get("tarball")?.as_str()?.to_string();
            Some((version, tarball))
        })
        .collect();
    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(parsed)
}

/// Extrae `minimumDesktopVersion` de `release/release-config.json` dentro de
/// un tarball npm (`.tgz`) ya descargado en memoria. Todos los tarballs npm
/// envuelven su contenido bajo el prefijo `package/`. Función pura: recibe
/// los bytes ya descargados, para poder probarla con un tarball fabricado en
/// memoria sin red.
fn parse_minimum_desktop_version_from_tarball(tarball_bytes: &[u8]) -> Result<Version, String> {
    let decoder = flate2::read::GzDecoder::new(tarball_bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| format!("Tarball npm ilegible: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Tarball npm ilegible: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Tarball npm ilegible: {e}"))?
            .into_owned();
        if path != Path::new("package/release/release-config.json") {
            continue;
        }
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|e| format!("release-config.json ilegible en el tarball: {e}"))?;
        let release: Value = serde_json::from_str(&content)
            .map_err(|e| format!("release-config.json inválido en el tarball: {e}"))?;
        let minimum = required_string(&release, "minimumDesktopVersion")?;
        return Version::parse(minimum)
            .map_err(|e| format!("minimumDesktopVersion inválida en el tarball: {e}"));
    }
    Err("release/release-config.json no encontrado en el tarball.".to_string())
}

/// Descarga los metadatos del paquete `@charlie.act7/jintia` desde el
/// registro npm.
fn fetch_registry_versions() -> Result<Vec<(Version, String)>, String> {
    let response = reqwest::blocking::get(REGISTRY_METADATA_URL)
        .map_err(|e| format!("Error consultando el registro npm: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error consultando el registro npm: {e}"))?;
    let bytes = response
        .bytes()
        .map_err(|e| format!("Error leyendo el registro npm: {e}"))?;
    parse_registry_versions(&bytes)
}

/// Descarga un tarball npm y extrae su `minimumDesktopVersion`.
fn fetch_minimum_desktop_version(tarball_url: &str) -> Result<Version, String> {
    let bytes = reqwest::blocking::get(tarball_url)
        .map_err(|e| format!("Error descargando tarball: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando tarball: {e}"))?
        .bytes()
        .map_err(|e| format!("Error leyendo tarball: {e}"))?;
    parse_minimum_desktop_version_from_tarball(&bytes)
}

/// Resuelve la versión más reciente de `@charlie.act7/jintia` publicada en
/// npm cuyo `minimumDesktopVersion` esta versión de Desktop satisface.
///
/// Devuelve `Ok(None)` (no `Err`) cuando no se pudo determinar una versión
/// compatible por cualquier motivo — sin red, metadatos inesperados, todas
/// las candidatas inspeccionadas resultaron incompatibles, etc. El llamador
/// debe interpretar `None` como "usa `@latest`": ese comportamiento ya está
/// protegido por el rollback de `download_portable_skill`, así que no instalar
/// nada nunca es peor que instalar `@latest` sin esta resolución previa.
pub fn resolve_latest_compatible_version(desktop_version: &str) -> Option<String> {
    let desktop = Version::parse(desktop_version).ok()?;
    let candidates = fetch_registry_versions().ok()?;
    for (version, tarball_url) in candidates.into_iter().take(MAX_COMPATIBILITY_CANDIDATES) {
        match fetch_minimum_desktop_version(&tarball_url) {
            Ok(minimum) if desktop >= minimum => return Some(version.to_string()),
            _ => continue,
        }
    }
    None
}

/// ¿La versión instalada difiere de la última compatible? Función pura
/// (sin I/O) para poder probar la comparación sin red: la ambigüedad real
/// (versión inválida, ausente, etc.) siempre resuelve a "sin actualización
/// disponible" — nunca se ofrece actualizar sobre datos que no se pudieron
/// interpretar con certeza.
fn skill_update_available(installed: Option<&str>, latest_compatible: Option<&str>) -> bool {
    match (installed, latest_compatible) {
        (Some(installed), Some(compatible)) => {
            match (Version::parse(installed), Version::parse(compatible)) {
                (Ok(installed), Ok(compatible)) => compatible > installed,
                _ => false,
            }
        }
        _ => false,
    }
}

/// Compara la Jintia Skill instalada localmente contra lo publicado en npm:
/// solo si la versión instalada es distinta (más vieja) que el `@latest`
/// real de npm — sin lógica de compatibilidad de por medio, eso lo sigue
/// resolviendo `resolve_latest_compatible_version` al momento de instalar/
/// actualizar (download_portable_skill), no este chequeo informativo. Nunca
/// falla: cualquier problema de red o parseo se refleja como `None`, no
/// como error.
pub fn check_skill_update() -> crate::models::SkillUpdateStatus {
    let installed_version = managed_release_contract().ok().map(|c| c.jintia_version);
    let latest_npm_version = fetch_registry_versions()
        .ok()
        .and_then(|versions| versions.first().map(|(version, _)| version.to_string()));
    let update_available =
        skill_update_available(installed_version.as_deref(), latest_npm_version.as_deref());
    crate::models::SkillUpdateStatus {
        installed_version,
        latest_npm_version,
        update_available,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID_MCP_VERSION: &str = "2.3.10";
    const VALID_SRI: &str = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    fn fixture() -> (Value, Value) {
        (
            serde_json::json!({"name":"@charlie.act7/jintia","version":"11.6.10"}),
            serde_json::json!({"$schemaVersion":"1.0.0","repository":"CharlieCardenasToledo/jintia","minimumDesktopVersion":"1.1.0","mcp":{"package":"@charlie.act7/gemini-notebook-mcp","version":VALID_MCP_VERSION,"node":">=22.13.0","npmIntegrity":VALID_SRI}}),
        )
    }
    fn parse_fixture(
        package: Value,
        release: Value,
        desktop: &str,
    ) -> Result<ManagedMcpContract, String> {
        parse_managed_mcp_contract(
            serde_json::to_vec(&package).unwrap().as_slice(),
            serde_json::to_vec(&release).unwrap().as_slice(),
            desktop,
        )
    }
    fn temp_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "jintia-release-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    // Solo la usan los tests #[cfg(unix)] de escape por symlink de más abajo;
    // en Windows queda sin consumidores y cargo la marca como dead_code.
    #[allow(dead_code)]
    fn write_valid_package(root: &std::path::Path) {
        let (package, release) = fixture();
        fs::create_dir_all(root.join("release")).unwrap();
        fs::write(
            root.join("package.json"),
            serde_json::to_vec(&package).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("release/release-config.json"),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
    }
    fn release_with(mutator: impl FnOnce(&mut Value)) -> Value {
        let release = fixture().1;
        let mut release = release;
        mutator(&mut release);
        release
    }

    #[test]
    fn accepts_valid_contract_and_reads_jintia_version_from_package_bytes() {
        let (p, r) = fixture();
        let c = parse_fixture(p, r, "1.1.1").unwrap();
        assert_eq!(c.jintia_version, "11.6.10");
    }
    #[test]
    fn rejects_package_json_invalid_json() {
        let r = fixture().1;
        assert!(parse_managed_mcp_contract(
            b"not-json",
            serde_json::to_vec(&r).unwrap().as_slice(),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_package_name_missing() {
        let (mut p, r) = fixture();
        p.as_object_mut().unwrap().remove("name");
        assert!(parse_fixture(p, r, "1.1.1").is_err());
    }
    #[test]
    fn rejects_wrong_jintia_package_name() {
        let (mut p, r) = fixture();
        p["name"] = Value::String("other".into());
        assert!(parse_fixture(p, r, "1.1.1").is_err());
    }
    #[test]
    fn rejects_package_version_missing() {
        let (mut p, r) = fixture();
        p.as_object_mut().unwrap().remove("version");
        assert!(parse_fixture(p, r, "1.1.1").is_err());
    }
    #[test]
    fn rejects_invalid_jintia_version() {
        let (mut p, r) = fixture();
        p["version"] = Value::String("bad".into());
        assert!(parse_fixture(p, r, "1.1.1").is_err());
    }
    #[test]
    fn rejects_missing_release_config_json() {
        let dir = temp_dir("missing-config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.json"),
            serde_json::to_vec(&fixture().0).unwrap(),
        )
        .unwrap();
        let result = managed_mcp_contract_from(&dir, "1.1.1");
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_err());
    }
    #[test]
    fn rejects_missing_package_root() {
        let dir = temp_dir("missing-root");
        let result = managed_mcp_contract_from(&dir, "1.1.1");
        assert!(result.is_err());
    }
    #[test]
    fn rejects_missing_package_json_from_filesystem_loader() {
        let dir = temp_dir("missing-package");
        fs::create_dir_all(dir.join("release")).unwrap();
        fs::write(
            dir.join("release/release-config.json"),
            serde_json::to_vec(&fixture().1).unwrap(),
        )
        .unwrap();
        let result = managed_mcp_contract_from(&dir, "1.1.1");
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_err());
    }
    #[test]
    fn rejects_release_config_invalid_json() {
        let (p, _) = fixture();
        assert!(parse_managed_mcp_contract(
            serde_json::to_vec(&p).unwrap().as_slice(),
            b"{",
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_schema_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r.as_object_mut().unwrap().remove("$schemaVersion");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_wrong_schema_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| r["$schemaVersion"] = Value::String("2.0.0".into())),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_repository() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r.as_object_mut().unwrap().remove("repository");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_wrong_repository() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| r["repository"] = Value::String("other".into())),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_minimum_desktop_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r.as_object_mut().unwrap().remove("minimumDesktopVersion");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_invalid_minimum_desktop_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| r["minimumDesktopVersion"] = Value::String("bad".into())),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_incompatible_desktop_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| r["minimumDesktopVersion"] = Value::String("99.0.0".into())),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_mcp_object() {
        let mut r = fixture().1;
        r.as_object_mut().unwrap().remove("mcp");
        assert!(parse_fixture(fixture().0, r, "1.1.1").is_err());
    }
    #[test]
    fn rejects_missing_mcp_package() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r["mcp"].as_object_mut().unwrap().remove("package");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_wrong_mcp_package() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| r["mcp"]["package"] = Value::String("otro-package".into())),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_mcp_version() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r["mcp"].as_object_mut().unwrap().remove("version");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_invalid_mcp_versions() {
        for version in [
            "latest",
            "^2.3.10",
            "~2.3.10",
            "*",
            "2.3",
            "v2.3.10",
            "2.3.10-beta.1",
        ] {
            assert!(
                parse_fixture(
                    fixture().0,
                    release_with(|r| r["mcp"]["version"] = Value::String(version.into())),
                    "1.1.1"
                )
                .is_err(),
                "accepted invalid MCP version {version}"
            );
        }
    }
    #[test]
    fn accepts_valid_node_requirement() {
        assert!(parse_fixture(fixture().0, fixture().1, "1.1.1").is_ok());
    }
    #[test]
    fn rejects_missing_node_requirement() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r["mcp"].as_object_mut().unwrap().remove("node");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_invalid_node_requirements() {
        for node in ["latest", "node", "not-a-range", "https://example.com"] {
            assert!(
                parse_fixture(
                    fixture().0,
                    release_with(|r| r["mcp"]["node"] = Value::String(node.into())),
                    "1.1.1"
                )
                .is_err(),
                "accepted invalid Node requirement {node}"
            );
        }
    }
    #[test]
    fn rejects_missing_sri() {
        assert!(parse_fixture(
            fixture().0,
            release_with(|r| {
                r["mcp"].as_object_mut().unwrap().remove("npmIntegrity");
            }),
            "1.1.1"
        )
        .is_err());
    }
    #[test]
    fn rejects_invalid_sri_values() {
        for sri in [
            "sha512-AA=AAAA",
            "sha512-=AAAAAA",
            "sha512-AAAA===",
            "sha512-AAAA AAAA",
            "sha512-",
            "sha1-AAAA",
            "sha256-AAAA",
        ] {
            assert!(
                parse_fixture(
                    fixture().0,
                    release_with(|r| r["mcp"]["npmIntegrity"] = Value::String(sri.into())),
                    "1.1.1"
                )
                .is_err(),
                "accepted invalid SRI {sri}"
            );
        }
    }
    #[test]
    fn accepts_valid_sri_without_padding() {
        assert!(valid_sri("sha512-AAAA"));
    }
    #[test]
    fn accepts_valid_sri_with_one_padding_character() {
        assert!(valid_sri("sha512-AAE="));
    }
    #[test]
    fn accepts_valid_sri_with_two_padding_characters() {
        assert!(valid_sri("sha512-AA=="));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_release_config_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("release-symlink");
        let outside = temp_dir("outside-release");
        write_valid_package(&dir);
        fs::write(&outside, serde_json::to_vec(&fixture().1).unwrap()).unwrap();
        fs::remove_file(dir.join("release/release-config.json")).unwrap();
        symlink(&outside, dir.join("release/release-config.json")).unwrap();
        let result = managed_mcp_contract_from(&dir, "1.1.1");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&outside);
        assert!(result.is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_package_json_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("package-symlink");
        let outside = temp_dir("outside-package");
        write_valid_package(&dir);
        fs::write(&outside, serde_json::to_vec(&fixture().0).unwrap()).unwrap();
        fs::remove_file(dir.join("package.json")).unwrap();
        symlink(&outside, dir.join("package.json")).unwrap();
        let result = managed_mcp_contract_from(&dir, "1.1.1");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&outside);
        assert!(result.is_err());
    }

    // ── resolución de "latest compatible" ──────────────────────────────────

    #[test]
    fn parses_registry_versions_sorted_descending_and_skips_prereleases() {
        let body = serde_json::json!({
            "versions": {
                "1.0.0": { "dist": { "tarball": "https://example.com/1.0.0.tgz" } },
                "2.0.0": { "dist": { "tarball": "https://example.com/2.0.0.tgz" } },
                "1.5.0-beta.1": { "dist": { "tarball": "https://example.com/1.5.0-beta.1.tgz" } },
                "not-a-real-version": { "dist": { "tarball": "https://example.com/x.tgz" } }
            }
        });
        let versions =
            parse_registry_versions(serde_json::to_vec(&body).unwrap().as_slice()).unwrap();
        let strings: Vec<String> = versions.iter().map(|(v, _)| v.to_string()).collect();
        assert_eq!(strings, vec!["2.0.0".to_string(), "1.0.0".to_string()]);
    }

    #[test]
    fn rejects_registry_metadata_without_versions_field() {
        assert!(parse_registry_versions(b"{}").is_err());
    }

    #[test]
    fn rejects_registry_metadata_invalid_json() {
        assert!(parse_registry_versions(b"not-json").is_err());
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn make_tarball(entry_path: &str, content: &[u8]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_path(entry_path).unwrap();
            header.set_size(content.len() as u64);
            header.set_cksum();
            builder.append(&header, content).unwrap();
            builder.finish().unwrap();
        }
        gzip(&tar_bytes)
    }

    #[test]
    fn extracts_minimum_desktop_version_from_tarball() {
        let content =
            serde_json::to_vec(&serde_json::json!({ "minimumDesktopVersion": "1.2.0" })).unwrap();
        let tarball = make_tarball("package/release/release-config.json", &content);
        let version = parse_minimum_desktop_version_from_tarball(&tarball).unwrap();
        assert_eq!(version, Version::parse("1.2.0").unwrap());
    }

    #[test]
    fn rejects_tarball_without_release_config() {
        let tarball = make_tarball("package/README.md", b"irrelevant");
        assert!(parse_minimum_desktop_version_from_tarball(&tarball).is_err());
    }

    #[test]
    fn rejects_tarball_with_invalid_release_config() {
        let tarball = make_tarball("package/release/release-config.json", b"not-json");
        assert!(parse_minimum_desktop_version_from_tarball(&tarball).is_err());
    }

    #[test]
    fn rejects_tarball_missing_minimum_desktop_version_field() {
        let content = serde_json::to_vec(&serde_json::json!({ "other": "x" })).unwrap();
        let tarball = make_tarball("package/release/release-config.json", &content);
        assert!(parse_minimum_desktop_version_from_tarball(&tarball).is_err());
    }

    // ── skill_update_available ──────────────────────────────────────────────

    #[test]
    fn skill_update_available_is_true_when_compatible_is_newer() {
        assert!(skill_update_available(Some("11.6.10"), Some("11.7.0")));
    }

    #[test]
    fn skill_update_available_is_false_when_versions_match() {
        assert!(!skill_update_available(Some("11.6.10"), Some("11.6.10")));
    }

    #[test]
    fn skill_update_available_is_false_when_compatible_is_older() {
        // No debería pasar en la práctica (resolve_latest_compatible_version
        // nunca devuelve algo más viejo que lo instalado), pero si pasara no
        // debe ofrecerse como "actualización".
        assert!(!skill_update_available(Some("11.7.0"), Some("11.6.10")));
    }

    #[test]
    fn skill_update_available_is_false_when_either_side_is_missing_or_invalid() {
        assert!(!skill_update_available(None, Some("11.7.0")));
        assert!(!skill_update_available(Some("11.6.10"), None));
        assert!(!skill_update_available(None, None));
        assert!(!skill_update_available(Some("not-a-version"), Some("11.7.0")));
        assert!(!skill_update_available(Some("11.6.10"), Some("not-a-version")));
    }
}
