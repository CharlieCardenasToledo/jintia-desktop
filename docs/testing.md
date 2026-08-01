# Pruebas

```bash
npm ci
npm run skill:verify
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

`skill:verify` comprueba el manifest y los SHA-256 de ambos payloads. Las pruebas
JavaScript cubren contratos de UI y empaquetado; las pruebas Rust cubren la
lógica nativa y fuerzan la extracción verificada que usa el build real.

Las pruebas internas de Jintia Skill se ejecutan en su propio repositorio.
