include!(concat!(env!("OUT_DIR"), "/skill_release.rs"));

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
    value.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("El contrato Jintia requiere {key} como string no vacío."))
}

fn valid_sri(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("sha512-") else { return false; };
    if encoded.is_empty() || !encoded.is_ascii() || encoded.len() % 4 != 0 { return false; }
    let padding = encoded.as_bytes().iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 || padding == encoded.len() { return false; }
    let body_len = encoded.len() - padding;
    encoded.as_bytes()[..body_len].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && encoded.as_bytes()[body_len..].iter().all(|byte| *byte == b'=')
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
    let minimum_version = Version::parse(minimum).map_err(|e| format!("minimumDesktopVersion inválida: {e}"))?;
    let desktop = Version::parse(desktop_version).map_err(|e| format!("Versión Desktop inválida: {e}"))?;
    if desktop < minimum_version {
        return Err(format!("Jintia requiere Desktop >= {minimum}, pero se ejecuta {desktop}."));
    }
    let mcp = release.get("mcp").ok_or("El contrato Jintia no contiene mcp.")?;
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
    Ok(ManagedMcpContract { package: package_name.to_string(), version, node_requirement, npm_integrity, jintia_version })
}

pub fn managed_mcp_contract_from(package_root: &Path, desktop_version: &str) -> Result<ManagedMcpContract, String> {
    let root = fs::canonicalize(package_root).map_err(|e| format!("No se pudo resolver el package Jintia: {e}"))?;
    if !root.is_dir() { return Err("El package Jintia no es un directorio.".into()); }
    let package_path = fs::canonicalize(root.join("package.json")).map_err(|e| format!("package.json de Jintia inválido: {e}"))?;
    let release_path = fs::canonicalize(root.join("release").join("release-config.json")).map_err(|e| format!("release/release-config.json inválido: {e}"))?;
    if !package_path.starts_with(&root) || !release_path.starts_with(&root) || !package_path.is_file() || !release_path.is_file() {
        return Err("El contrato Jintia escapa del package administrado.".into());
    }
    let package_json = fs::read(package_path)
        .map_err(|_| "El Jintia administrado no contiene el contrato MCP distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    let release_config = fs::read(release_path)
        .map_err(|_| "El Jintia administrado no contiene el contrato MCP distribuido. Actualiza Jintia desde Configuración > Entorno.".to_string())?;
    parse_managed_mcp_contract(&package_json, &release_config, desktop_version)
}

pub fn managed_mcp_contract() -> Result<ManagedMcpContract, String> {
    managed_mcp_contract_from(&crate::paths::portable_skill_npm_package_dir(), env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID_MCP_VERSION: &str = "2.3.10";
    const VALID_SRI: &str = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    fn fixture() -> (Vec<u8>, Vec<u8>) {
        (format!(r#"{{"name":"@charlie.act7/jintia","version":"11.6.10"}}"#).into_bytes(), format!(r#"{{"$schemaVersion":"1.0.0","repository":"CharlieCardenasToledo/jintia","minimumDesktopVersion":"1.1.0","mcp":{{"package":"@charlie.act7/gemini-notebook-mcp","version":"{VALID_MCP_VERSION}","node":">=22.13.0","npmIntegrity":"{VALID_SRI}"}}}}"#).into_bytes())
    }
    fn parse_with(mut package: Value, mut release: Value) -> Result<ManagedMcpContract, String> {
        let (p, r) = fixture();
        let base_package: Value = serde_json::from_slice(&p).unwrap();
        let base_release: Value = serde_json::from_slice(&r).unwrap();
        if package.is_null() { package = base_package; }
        if release.is_null() { release = base_release; }
        parse_managed_mcp_contract(serde_json::to_string(&package).unwrap().as_bytes(), serde_json::to_string(&release).unwrap().as_bytes(), "1.1.1")
    }
    #[test] fn accepts_valid_contract_and_reads_jintia_version_from_package() { let (p, r) = fixture(); let c = parse_managed_mcp_contract(&p, &r, "1.1.1").unwrap(); assert_eq!(c.jintia_version, "11.6.10"); }
    #[test] fn rejects_missing_or_invalid_package_json() { assert!(parse_managed_mcp_contract(b"", &fixture().1, "1.1.1").is_err()); assert!(parse_managed_mcp_contract(br#"{}"#, &fixture().1, "1.1.1").is_err()); assert!(parse_managed_mcp_contract(br#"{"name":"other","version":"1.0.0"}"#, &fixture().1, "1.1.1").is_err()); assert!(parse_managed_mcp_contract(br#"{"name":"@charlie.act7/jintia","version":"bad"}"#, &fixture().1, "1.1.1").is_err()); }
    #[test] fn rejects_release_schema_repository_minimum_and_json_errors() { let p = fixture().0; for r in [b"{".as_slice(), br#"{}"#, br#"{"$schemaVersion":"2.0.0","repository":"CharlieCardenasToledo/jintia","minimumDesktopVersion":"1.1.0"}"#, br#"{"$schemaVersion":"1.0.0","repository":"other","minimumDesktopVersion":"1.1.0"}"#, br#"{"$schemaVersion":"1.0.0","repository":"CharlieCardenasToledo/jintia","minimumDesktopVersion":"bad"}"#] { assert!(parse_managed_mcp_contract(&p, r, "1.1.1").is_err()); } let mut r: Value = serde_json::from_slice(&fixture().1).unwrap(); r["minimumDesktopVersion"] = Value::String("99.0.0".into()); assert!(parse_with(Value::Null, r).is_err()); }
    #[test] fn rejects_floating_prerelease_and_invalid_mcp_versions() { for version in ["latest", "^2.3.10", "~2.3.10", "*", "2.3", "v2.3.10", "2.3.10-beta.1"] { let mut r: Value = serde_json::from_slice(&fixture().1).unwrap(); r["mcp"]["version"] = Value::String(version.into()); assert!(parse_with(Value::Null, r).is_err()); } }
    #[test] fn rejects_invalid_node_requirements_and_sri() { for node in ["latest", "node", "not-a-range", "https://example.com"] { let mut r: Value = serde_json::from_slice(&fixture().1).unwrap(); r["mcp"]["node"] = Value::String(node.into()); assert!(parse_with(Value::Null, r).is_err()); } for sri in ["sha512-AA=AAAA", "sha512-=AAAAAA", "sha512-AAAA===", "sha512-AAAA AAAA", "sha512-", "sha1-AAAA", "sha256-AAAA"] { let mut r: Value = serde_json::from_slice(&fixture().1).unwrap(); r["mcp"]["npmIntegrity"] = Value::String(sri.into()); assert!(parse_with(Value::Null, r).is_err()); } }
    #[test] fn accepts_terminal_sri_padding() { assert!(valid_sri("sha512-AAAA")); assert!(valid_sri(VALID_SRI)); }
    #[test] fn rejects_missing_release_config() { let dir = std::env::temp_dir().join(format!("jintia-contract-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir_all(&dir).unwrap(); fs::write(dir.join("package.json"), fixture().0).unwrap(); assert!(managed_mcp_contract_from(&dir, "1.1.1").is_err()); let _ = fs::remove_dir_all(dir); }
}
