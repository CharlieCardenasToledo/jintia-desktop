//! approval.rs — Aprobación humana firmada de una guía antes de compilar el PDF.
//!
//! `jintia ready --skip-pdf` (repo `jintia`) congela un snapshot inmutable
//! del HTML validado y reporta su hash. `jintia compile --publish` (y el
//! propio `ready` sin `--skip-pdf`) exigen una aprobación firmada atada
//! exactamente a ese hash antes de generar el PDF
//! (`skill/scripts/revision-manager.js::checkApproval`).
//!
//! Por qué firma y no solo un hash comparado: el agente tiene acceso de
//! shell al directorio del curso — con un hash-only, podría escribir a mano
//! un `.jintia-approval.json` con el hash actual y autoaprobarse. La firma
//! Ed25519 solo puede producirla Jintia Desktop: la clave privada se genera
//! UNA VEZ por instalación y vive únicamente en el directorio de datos de
//! la app (`paths::app_config_dir()`), nunca en el directorio de un curso
//! ni en ningún lugar que el agente pueda leer o escribir.
//!
//! El payload que se firma tiene que serializarse BYTE A BYTE igual que
//! `scripts/revision-manager.js::canonicalizeApprovalPayload` en el repo
//! `jintia` (orden alfabético de claves: approvedAt, hash, week) — de lo
//! contrario la verificación en Node (`crypto.verify`) nunca validaría una
//! firma generada aquí. Por eso se construye el JSON a mano en vez de
//! confiar en el orden de serialización de un struct/mapa.

use crate::engine::{self, EngineResult};
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use std::fs;
use std::path::{Path, PathBuf};

const PRIVATE_KEY_FILE: &str = "approval-signing-key.bin";
const PUBLIC_KEY_FILE_NAME: &str = "approval-public-key.pem";

fn private_key_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_config_dir()?.join(PRIVATE_KEY_FILE))
}

/// Carga el keypair de aprobación de esta instalación, generándolo la
/// primera vez que se necesita. Un solo keypair para toda la instalación
/// (no uno por curso).
fn load_or_create_signing_key() -> Result<SigningKey, String> {
    let path = private_key_path()?;
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(array) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SigningKey::from_bytes(&array));
        }
        // Contenido con el tamaño equivocado (archivo corrupto/truncado):
        // no se sobreescribe en silencio — sería fabricar una identidad de
        // firma nueva sin que el usuario lo sepa, invalidando aprobaciones
        // ya emitidas con la clave anterior.
        return Err(format!(
            "La clave de aprobación en {} está corrupta (tamaño inesperado). Restaura un respaldo o elimínala manualmente para generar una nueva.",
            path.display()
        ));
    }

    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, signing_key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(signing_key)
}

/// Serialización canónica del payload de aprobación — DEBE coincidir byte a
/// byte con `canonicalizeApprovalPayload()` en `scripts/revision-manager.js`
/// (repo `jintia`): `JSON.stringify({approvedAt, hash, week})`, sin
/// espacios, claves en orden alfabético.
fn canonicalize_approval_payload(hash: &str, week: u32, approved_at: &str) -> Result<Vec<u8>, String> {
    let approved_at_json = serde_json::to_string(approved_at).map_err(|e| e.to_string())?;
    let hash_json = serde_json::to_string(hash).map_err(|e| e.to_string())?;
    Ok(format!(r#"{{"approvedAt":{approved_at_json},"hash":{hash_json},"week":{week}}}"#).into_bytes())
}

fn week_dir(course_path: &str, week: u32) -> PathBuf {
    PathBuf::from(course_path.trim())
        .join("semanas")
        .join(format!("semana-{week:02}"))
}

/// Escribe/actualiza la clave pública de aprobación en `<curso>/.jintia/`.
/// La skill la necesita para verificar firmas
/// (`revision-manager.js::checkApproval`, código `JIN-APR-003` si falta).
pub fn ensure_public_key_in_course(course_path: &str) -> Result<(), String> {
    let signing_key = load_or_create_signing_key()?;
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let pem = verifying_key
        .to_public_key_pem(Default::default())
        .map_err(|e| e.to_string())?;

    let dir = PathBuf::from(course_path.trim()).join(".jintia");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(PUBLIC_KEY_FILE_NAME), pem).map_err(|e| e.to_string())
}

/// Firma la revisión `hash` de la semana `week` y escribe
/// `.jintia-approval.json`/`.jintia-approval.sig` en
/// `semanas/semana-NN/` — exactamente donde
/// `revision-manager.js::checkApproval()` los espera. No verifica aquí que
/// el snapshot `hash` exista de verdad en `.jintia-revisions/`: eso lo hace
/// la propia skill al intentar compilar (si no existe, `compile --publish`
/// simplemente no encontrará el `guide.html` congelado y fallará con un
/// error de archivo, no con un `JIN-APR-*` — aceptable porque el llamador
/// real (la UI de aprobación) solo ofrece aprobar un hash que ella misma
/// acaba de leer de un reporte de `ready --skip-pdf` real).
pub fn grant_approval(course_path: &str, week: u32, hash: &str) -> Result<(), String> {
    ensure_public_key_in_course(course_path)?;
    let signing_key = load_or_create_signing_key()?;

    let approved_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = canonicalize_approval_payload(hash, week, &approved_at)?;
    let signature = signing_key.sign(&payload);

    let dir = week_dir(course_path, week);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join(".jintia-approval.json"),
        format!(r#"{{"approvedAt":"{approved_at}","hash":"{hash}","week":{week}}}"#),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        dir.join(".jintia-approval.sig"),
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signature.to_bytes()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Compila el PDF final vía la skill (`jintia compile <guide.json> --publish`),
/// SIN pasar por el agente — se invoca directamente desde Tauri en respuesta
/// a la aprobación del docente, la misma garantía que motiva `grant_approval`:
/// la IA queda fuera del circuito en el tramo final.
///
/// `jintia compile` no tiene soporte completo de `--json` para sus propias
/// compuertas (a diferencia de `validate`/`ready`) — reporta éxito/fallo por
/// código de salida y texto plano en stderr (incluidos los códigos
/// `JIN-APR-*` de este mismo cambio). Se usa `engine::run_jintia` (no la
/// variante `_json`) y se deja que el llamador (la UI) muestre `stderr` tal
/// cual si `success` es `false`, en vez de intentar parsear algo que la
/// skill no promete devolver como JSON en este comando.
pub fn publish(project_path: &str, week: u32) -> Result<EngineResult, String> {
    let guide_path = week_dir(project_path, week).join("guide.json");
    let guide_path_str = guide_path.to_string_lossy().into_owned();

    let Some(skill_path) = crate::runtimes::resolve_skill() else {
        return Err("Jintia administrado no está disponible. Instálalo o actualízalo desde Configuración > Entorno.".to_string());
    };

    engine::run_jintia(Path::new(&skill_path), &["compile", &guide_path_str, "--publish"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_approval_payload_orden_alfabetico_sin_espacios() {
        let bytes = canonicalize_approval_payload("abc123", 3, "2026-08-23T00:00:00.000Z").unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text, r#"{"approvedAt":"2026-08-23T00:00:00.000Z","hash":"abc123","week":3}"#);
    }

    #[test]
    fn firma_y_verificacion_ed25519_roundtrip() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let payload = canonicalize_approval_payload("hash1", 1, "2026-08-23T00:00:00.000Z").unwrap();
        let signature = signing_key.sign(&payload);
        assert!(signing_key.verifying_key().verify_strict(&payload, &signature).is_ok());
    }

    #[test]
    fn firma_no_verifica_contra_una_clave_publica_distinta() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let other_key = SigningKey::generate(&mut csprng);
        let payload = canonicalize_approval_payload("hash1", 1, "2026-08-23T00:00:00.000Z").unwrap();
        let signature = signing_key.sign(&payload);
        assert!(other_key.verifying_key().verify_strict(&payload, &signature).is_err());
    }

    #[test]
    fn verifying_key_produce_un_pem_spki_valido() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let pem = signing_key.verifying_key().to_public_key_pem(Default::default()).unwrap();
        assert!(pem.contains("BEGIN PUBLIC KEY"));
    }
}
