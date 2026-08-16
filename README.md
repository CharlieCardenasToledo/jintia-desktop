# Jintia Desktop

Aplicación de escritorio para configurar el entorno, organizar asignaturas,
preparar sílabos e instalar Jintia Skill para Claude, ChatGPT y Codex.

Este repositorio contiene únicamente la aplicación. La skill se desarrolla y
publica de forma independiente en
[`jintia`](https://github.com/CharlieCardenasToledo/jintia) y se descarga en
tiempo de ejecución desde el registro npm (`@charlie.act7/jintia`). El contrato
entre ambos repositorios está declarado en el `release-config.json` del paquete
skill (consumido por Desktop en `src-tauri/src/release.rs`).

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

## Modelo de distribución de la skill

Desktop descarga la skill en tiempo de ejecución usando el paso de onboarding
("Instalar Jintia Skill"). No hay ZIPs ni archivos lock versionados en este
repositorio; la versión mínima compatible se declara en `minimumDesktopVersion`
dentro del `release-config.json` del paquete skill.

Para probar Desktop con una versión específica de la skill, instálala
manualmente en el entorno del usuario desde la pantalla de configuración o
directamente con `npm install --global @charlie.act7/jintia@X.Y.Z`.

## Distribución

Los tags `v*` activan instaladores Windows y macOS. La versión de Desktop es
independiente de la versión de la skill. Consulta
[`docs/releasing.md`](docs/releasing.md) y [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md).

## Privacidad y licencia

Jintia no incluye telemetría ni un backend propio. Las operaciones que requieren
red se muestran al usuario. Consulta [`PRIVACY.md`](PRIVACY.md) y
[`SECURITY.md`](SECURITY.md).

Código bajo licencia MIT. © 2026 Charlie Cárdenas Toledo.
