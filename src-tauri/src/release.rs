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
    value.strip_prefix("sha512-").is_some_and(|encoded| {
        !encoded.is_empty()
            && !encoded.contains(char::is_whitespace)
            && encoded.len() % 4 == 0
            && encoded.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
            && encoded.trim_end_matches('=').len() == encoded.len() - encoded.chars().rev().take_while(|c| *c == '=').count()
            && encoded.chars().rev().take_while(|c| *c == '=').count() <= 2
    })
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
    fn fixture() -> (Vec<u8>, Vec<u8>) {
        (br#"{"name":"@charlie.act7/jintia","version":"11.6.8"}"#.to_vec(), br#"{"$schemaVersion":"1.0.0","repository":"CharlieCardenasToledo/jintia","minimumDesktopVersion":"1.1.0","mcp":{"package":"@charlie.act7/gemini-notebook-mcp","version":"2.3.5","node":">=22.13.0","npmIntegrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}}"#.to_vec())
    }
    #[test] fn accepts_valid_contract() { let (p, r) = fixture(); assert!(parse_managed_mcp_contract(&p, &r, "1.1.1").is_ok()); }
    #[test] fn rejects_invalid_contract_fields() {
        for (needle, replacement) in [("@charlie.act7/jintia", "other"), ("1.1.0", "99.0.0"), ("sha512-", "sha1-")] {
            let (p, mut r) = fixture();
            if needle == "@charlie.act7/jintia" { let mut p2 = p; let s = String::from_utf8(p2).unwrap().replace(needle, replacement); assert!(parse_managed_mcp_contract(s.as_bytes(), &r, "1.1.1").is_err()); }
            else { r = String::from_utf8(r).unwrap().replace(needle, replacement).into_bytes(); assert!(parse_managed_mcp_contract(&p, &r, "1.1.1").is_err()); }
        }
    }
    #[test] fn rejects_missing_release_config() { let dir = std::env::temp_dir().join(format!("jintia-contract-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir_all(&dir).unwrap(); fs::write(dir.join("package.json"), fixture().0).unwrap(); assert!(managed_mcp_contract_from(&dir, "1.1.1").is_err()); let _ = fs::remove_dir_all(dir); }
}
