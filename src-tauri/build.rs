use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

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

fn extract(path: &Path, destination: &Path, prefix: &str) {
    if destination.exists() {
        fs::remove_dir_all(destination).expect("No se pudo limpiar OUT_DIR");
    }
    fs::create_dir_all(destination).expect("No se pudo preparar OUT_DIR");
    let file = fs::File::open(path).expect("No se pudo abrir el artefacto ZIP");
    let mut archive = ZipArchive::new(file).expect("Artefacto ZIP inválido");
    let prefix = Path::new(prefix);

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("Entrada ZIP inválida");
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            panic!("El artefacto contiene un enlace simbólico no permitido");
        }
        let enclosed = entry
            .enclosed_name()
            .unwrap_or_else(|| panic!("Ruta insegura dentro del ZIP: {}", entry.name()));
        let relative = enclosed.strip_prefix(prefix).unwrap_or_else(|_| {
            panic!(
                "La entrada {} está fuera de la raíz esperada {}",
                enclosed.display(),
                prefix.display()
            )
        });
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).expect("No se pudo crear una carpeta del payload");
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("No se pudo crear una carpeta del payload");
        }
        let mut target = fs::File::create(&output).expect("No se pudo extraer el payload");
        io::copy(&mut entry, &mut target).expect("No se pudo copiar una entrada del payload");
    }
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
    let skill_file = required(&lock, "/artifacts/skill/file");
    let plugin_file = required(&lock, "/artifacts/openaiPlugin/file");
    for name in [manifest_file, skill_file, plugin_file] {
        println!("cargo:rerun-if-changed={}", resources.join(name).display());
    }

    verify(
        &resources.join(manifest_file),
        required(&lock, "/manifest/sha256"),
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(resources.join(manifest_file)).expect("No se pudo leer el manifest fijado"),
    )
    .expect("El manifest fijado no es JSON válido");
    for pointer in ["/skillVersion", "/mcp", "/artifacts"] {
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
    verify(
        &resources.join(skill_file),
        required(&lock, "/artifacts/skill/sha256"),
    );
    verify(
        &resources.join(plugin_file),
        required(&lock, "/artifacts/openaiPlugin/sha256"),
    );
    extract(
        &resources.join(skill_file),
        &out_dir.join("jintia-skill"),
        required(&lock, "/artifacts/skill/installRoot"),
    );
    extract(
        &resources.join(plugin_file),
        &out_dir.join("jintia"),
        required(&lock, "/artifacts/openaiPlugin/installRoot"),
    );

    let package = required(&lock, "/mcp/package");
    let version = required(&lock, "/mcp/version");
    let generated = format!(
        "pub const SKILL_VERSION: &str = {};\n\
         pub const NOTEBOOKLM_MCP_PACKAGE: &str = {};\n",
        quoted(required(&lock, "/skillVersion")),
        quoted(&format!("{package}@{version}")),
    );
    fs::write(out_dir.join("skill_release.rs"), generated)
        .expect("No se pudo generar el contrato Rust de la release");
    tauri_build::build();
}
