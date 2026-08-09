# Jintia Desktop

Aplicación de escritorio para configurar el entorno, organizar asignaturas,
preparar sílabos e instalar Jintia Skill para Claude, ChatGPT y Codex.

Este repositorio contiene únicamente la aplicación. La skill se desarrolla y
publica de forma independiente en
[`jintia`](https://github.com/CharlieCardenasToledo/jintia).
Desktop consume una release inmutable declarada en `skill.lock.json`; durante
el build verifica el manifest y los SHA-256 antes de incorporar los payloads.

## Desarrollo

Requisitos: Node.js 22.13 o superior, Rust estable y las dependencias de Tauri
para tu sistema operativo.

```bash
npm ci
npm run skill:verify
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Para ejecutar la interfaz en navegador con servicios simulados:

```bash
npm run dev:web
```

Para ejecutar la aplicación Tauri:

```bash
npm run tauri:dev
```

## Actualizar la skill incorporada

Las releases de la skill son el único contrato entre ambos repositorios:

```bash
npm run skill:sync -- --tag=vX.Y.Z
npm run skill:verify
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

El comando descarga el manifest y los ZIP oficiales, verifica tamaño y hash, y
actualiza `skill.lock.json`. Los ZIP se versionan para conservar builds offline
y reproducibles. No se copian archivos directamente desde el checkout de la
skill.

## Distribución

Los tags `v*` activan instaladores Windows y macOS. La versión de Desktop es
independiente de la versión bloqueada de la skill. Consulta
[`docs/releasing.md`](docs/releasing.md) y [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md).

## Privacidad y licencia

Jintia no incluye telemetría ni un backend propio. Las operaciones que requieren
red se muestran al usuario. Consulta [`PRIVACY.md`](PRIVACY.md) y
[`SECURITY.md`](SECURITY.md).

Código bajo licencia MIT. © 2026 Charlie Cárdenas Toledo.
