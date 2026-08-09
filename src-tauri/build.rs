use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

fn required<'a>(value: &'a serde_json::Value, pointer: &str) -> &'a str {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("skill.lock.json no contiene {pointer}"))
}

fn sha256(path: &Path) -> String {
    let mut file = fs::File::open(path)
        .unwrap_or_else(|error| panic!("No se pudo abrir {}: {error}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .unwrap_or_else(|error| panic!("No se pudo leer {}: {error}", path.display()));
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    format!("{:x}", hasher.finalize())
}

fn verify(path: &Path, expected: &str) {
    let actual = sha256(path);
    assert_eq!(
        actual,
        expected,
        "El artefacto {} no coincide con skill.lock.json. Ejecuta npm run skill:sync.",
        path.display()
    );
}

fn quoted(value: &str) -> String {
    format!("{value:?}")
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repository = manifest_dir.parent().expect("src-tauri no tiene directorio padre");
    let lock_path = repository.join("skill.lock.json");
    let resources = manifest_dir.join("resources");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed={}", lock_path.display());

    let lock: serde_json::Value = serde_json::from_slice(
        &fs::read(&lock_path).expect("No se pudo leer skill.lock.json"),
    )
    .expect("skill.lock.json no es JSON válido");
    let manifest_file = required(&lock, "/manifest/file");
    println!("cargo:rerun-if-changed={}", resources.join(manifest_file).display());

    verify(
        &resources.join(manifest_file),
        required(&lock, "/manifest/sha256"),
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(resources.join(manifest_file)).expect("No se pudo leer el manifest fijado"),
    )
    .expect("El manifest fijado no es JSON válido");
    for pointer in ["/mcp"] {
        assert_eq!(
            manifest.pointer(pointer),
            lock.pointer(pointer),
            "El manifest y skill.lock.json no coinciden en {pointer}"
        );
    }
    assert_eq!(
        manifest.pointer("/source/repository").and_then(serde_json::Value::as_str),
        lock.get("repository").and_then(serde_json::Value::as_str),
        "El manifest fijado pertenece a otro repositorio"
    );
    let package = required(&lock, "/mcp/package");
    let version = required(&lock, "/mcp/version");
    let generated = format!(
        "pub const NOTEBOOKLM_MCP_PACKAGE: &str = {};\n",
        quoted(&format!("{package}@{version}")),
    );
    fs::write(out_dir.join("skill_release.rs"), generated)
        .expect("No se pudo generar el contrato Rust de la release");
    tauri_build::build();
}
