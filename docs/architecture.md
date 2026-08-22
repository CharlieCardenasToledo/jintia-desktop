# Arquitectura

## Límites del producto

```text
jintia (paquete npm @charlie.act7/jintia)         jintia-desktop
  package.json + release/release-config.json  ◀── engine.rs / release.rs los lee
                                                     │
  npm install --global --prefix <stage>  ◀────────── skill.rs (runtimes/skill.rs)
  (versión resuelta: la más reciente compatible      │
   con minimumDesktopVersion, no siempre @latest)     ├─ valida package.json / SKILL.md / jintia.js
                                                        ├─ smoke test: jintia capabilities profiles --json
                                                        ├─ valida release-config.json (release.rs)
                                                        └─ activa (rename) con rollback si algo falla
```

La aplicación administra runtimes, cursos, configuración y la instalación de
la skill. La skill `jintia` (paquete npm, no un payload embebido en Desktop)
aporta el método de diseño instruccional, las reglas de calidad, el motor
editorial HTML y el CLI que Desktop orquesta. Ambos productos se versionan y
publican de manera independiente; **ya no existe ningún payload de la skill
embebido en el binario de Desktop, ni el archivo de bloqueo que antes lo
describía** — esa arquitectura (release manifest + ZIPs → archivo de
bloqueo → `build.rs` → payload incorporado en tiempo de compilación) fue
reemplazada. `tests/skill-verify.test.mjs` y `tests/static-contracts.test.mjs`
exigen explícitamente que ese archivo de bloqueo heredado no exista en el
repositorio.

## Instalación de la skill (`src-tauri/src/runtimes/skill.rs`)

`download_portable_skill()`:

1. Resuelve la versión a instalar: consulta el registro npm y busca, de más
   reciente a más antigua, la primera versión publicada cuyo
   `minimumDesktopVersion` (declarado en su propio `release/release-config.json`)
   esta versión de Desktop satisface (`release::resolve_latest_compatible_version`).
   Si la resolución falla por cualquier motivo (sin red, metadatos
   inesperados), usa `@latest` como antes — sigue protegido por los pasos
   siguientes.
2. `npm install --global --prefix <stage> @charlie.act7/jintia@<versión>` con
   el Node administrado por Desktop, en un directorio de staging aislado.
3. Valida que el paquete instalado tenga `package.json`, `SKILL.md` y
   `skill/bin/jintia.js`.
4. Corre un smoke test real: `jintia capabilities profiles --json` y valida
   que la salida sea JSON bien formado.
5. Valida el contrato completo del release (`src-tauri/src/release.rs`):
   nombre y repositorio del paquete, `minimumDesktopVersion` contra la
   versión actual de Desktop, requisito de Node, y el contrato MCP de
   NotebookLM (paquete canónico, versión estable, integridad SRI SHA-512).
6. Solo entonces activa: respalda la instalación anterior, mueve el staging
   a la ubicación activa, y borra el respaldo. Si cualquier paso previo
   falla, el staging se descarta y la instalación anterior queda intacta.

## Motor (`src-tauri/src/engine.rs`)

Ejecuta la skill instalada (`jintia.js`) con el Node administrado
(`managed_node_command`), inyectando `JINTIA_VIVLIOSTYLE_BIN` cuando
Vivliostyle CLI está disponible. Es el único punto del código Rust que
invoca la skill; el resto de módulos (`course/`, `toolchain.rs`, `opencode/`)
delegan en él en vez de reimplementar lógica pedagógica o de compilación.

## Contrato de release (`src-tauri/src/release.rs`)

Único punto de lectura autorizado de `package.json` + `release/release-config.json`
del paquete `jintia` instalado. Expone un `JintiaReleaseContract` tipado con:
versión de la skill, `minimumDesktopVersion` (comparada contra
`CARGO_PKG_VERSION` de Desktop), requisito de Node (`runtime.node`), el
contrato MCP de NotebookLM (paquete, versión, requisito de Node, integridad
SRI) y los binarios de perfil declarados (`profileBinaries`, por plataforma).

## Providers de agente (`toolchain.rs`, `opencode/`)

La detección e instalación de la skill como agente global (Claude Code,
Codex, OpenCode) delega en el propio CLI de la skill (`jintia detect --json`,
`jintia harness install --json`) en vez de mantener una tabla de proveedores
duplicada en Rust. El módulo `opencode/` además inyecta contexto de agente
(`JINTIA_AGENTS_CONTEXT`) que declara explícitamente el pipeline vigente
(`guide.json → HTML → Vivliostyle`, sin LaTeX) y sincroniza `notebooks.json`
del curso con el MCP administrado de NotebookLM.

## Aplicación

- `src/`: frontend Vite + Tailwind (JavaScript, sin framework de componentes) y modo mock.
- `src-tauri/src/`: comandos Tauri, persistencia, runtimes administrados (Node, Vivliostyle, Python, MCP) e instalación de la skill.
- `tests/`: contratos propios de Desktop (incluida la prohibición de artefactos heredados de la arquitectura de payload embebido).
- `.github/workflows/`: CI e instaladores por plataforma.

La instalación conserva configuraciones de usuario y crea respaldos antes de
reemplazar una instalación (ver arriba). `course/structure.rs` delega la
creación de cursos en `jintia init` — no hay lógica de creación de curso
duplicada en Rust.

## Persistencia

| Dato | Ubicación |
|---|---|
| Cursos del panel | `localStorage` de la WebView |
| Preferencias | Directorio de configuración de Jintia |
| Curso, sílabo y guías | Carpeta elegida por el usuario |
| Skill administrada (la que ejecuta Desktop) | `runtimes/jintia/` bajo el directorio de runtimes de Desktop |
| Skill como agente — Claude Code | `~/.claude/skills/jintia-skill` |
| Skill como agente — Codex | `~/.agents/skills/jintia-skill` |
| Skill como agente — OpenCode | `~/.opencode/skills/jintia-skill` (o `$OPENCODE_CONFIG_DIR`) |
| Plugin universal (Codex/ChatGPT) | `~/.codex/plugins/jintia` |

## Versionado

La versión de Desktop está en `package.json`, `src-tauri/Cargo.toml` y
`src-tauri/tauri.conf.json`. La versión de la skill **no** se versiona junto
a Desktop: se instala en runtime desde npm y `release.rs` la lee del
`package.json` del paquete instalado en cada momento.
