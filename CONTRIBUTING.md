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
2. Conserva la skill como dependencia de release: no copies su árbol fuente al repositorio.
3. Actualiza `skill.lock.json` solo mediante `npm run skill:sync -- --tag=vX.Y.Z`.
4. Añade una entrada a `CHANGELOG.md` cuando el cambio sea visible o distribuible.

## Validación

```bash
npm run skill:verify
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Describe en el pull request el problema, la solución y las pruebas ejecutadas.
Incluye capturas cuando modifiques una pantalla.
