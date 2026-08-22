# Contribuir

## Preparar el entorno

```bash
git clone https://github.com/CharlieCardenasToledo/jintia-desktop.git
cd jintia-desktop
npm ci
npm run skill:verify
```

Se requiere Node.js 22.13 o superior y Rust estable.

## Antes de proponer cambios

1. No agregues configuraciones institucionales, tokens, cookies ni documentos reales.
2. La skill `jintia` es una dependencia npm que se instala en runtime (ver `src-tauri/src/runtimes/skill.rs`), no un payload embebido: no copies su árbol fuente al repositorio ni fijes su versión aquí.
3. Añade una entrada a `CHANGELOG.md` cuando el cambio sea visible o distribuible.

## Validación

```bash
npm run skill:verify
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Describe en el pull request el problema, la solución y las pruebas ejecutadas.
Incluye capturas cuando modifiques una pantalla.
