use semver::{Version, VersionReq};
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedMcpContract {
    pub package: String,
    pub version: String,
    pub node_requirement: String,
    pub npm_integrity: String,
    pub jintia_version: String,
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

pub fn parse_managed_mcp_contract(
    package_json_bytes: &[u8],
    release_config_bytes: &[u8],
    desktop_version: &str,
) -> Result<ManagedMcpContract, String> {
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
    let minimum_version =
        Version::parse(minimum).map_err(|e| format!("minimumDesktopVersion inválida: {e}"))?;
    let desktop =
        Version::parse(desktop_version).map_err(|e| format!("Versión Desktop inválida: {e}"))?;
    if desktop < minimum_version {
        return Err(format!(
            "Jintia requiere Desktop >= {minimum}, pero se ejecuta {desktop}."
        ));
    }
    let mcp = release
        .get("mcp")
        .ok_or("El contrato Jintia no contiene mcp.")?;
    let package_name = required_string(mcp, "package")?;
    if package_name != "@charlie.act7/gemini-notebook-mcp" {
        return Err("El contrato MCP no usa el paquete canónico.".into());
    }
    let version = required_string(mcp, "version")?.to_string();
    parse_stable_version(&version, "Versión MCP")?;
    let node_requirement = required_string(mcp, "node")?.to_string();
    VersionReq::parse(&node_requirement).map_err(|e| format!("Requisito Node inválido: {e}"))?;
    let npm_integrity = required_string(mcp, "npmIntegrity")?.to_string();
    if !valid_sri(&npm_integrity) {
        return Err("npmIntegrity no es un SRI SHA-512 válido.".into());
    }
    Ok(ManagedMcpContract {
        package: package_name.to_string(),
        version,
        node_requirement,
        npm_integrity,
        jintia_version,
    })
}

pub fn managed_mcp_contract_from(
    package_root: &Path,
    desktop_version: &str,
) -> Result<ManagedMcpContract, String> {
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
        .map_err(|_| "El Jintia administrado no contiene el contrato MCP distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    let release_config = fs::read(release_path)
        .map_err(|_| "El Jintia administrado no contiene el contrato MCP distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    parse_managed_mcp_contract(&package_json, &release_config, desktop_version)
}

pub fn managed_mcp_contract() -> Result<ManagedMcpContract, String> {
    managed_mcp_contract_from(
        &crate::paths::portable_skill_npm_package_dir(),
        env!("CARGO_PKG_VERSION"),
    )
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
}
