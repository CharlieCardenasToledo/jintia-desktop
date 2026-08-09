# Arquitectura

## Límites del producto

```text
jintia                                       jintia-desktop
  release manifest + ZIPs  ───────────────▶  skill.lock.json
                                               │
                                               ├─ build.rs verifica SHA-256
                                               ├─ Tauri incorpora los payloads
                                               └─ la UI instala o exporta la skill
```

La aplicación administra cursos, configuración y dependencias. La skill aporta
el método de diseño instruccional, las plantillas y su runtime. Ambos productos
se versionan y publican de manera independiente.

## Contrato de release

`skill.lock.json` fija el repositorio, tag, versión, contrato MCP y hashes de:

- `jintia-release-manifest.json`;
- el ZIP de Claude;
- el plugin universal para ChatGPT y Codex.

`src-tauri/build.rs` rechaza hashes distintos, rutas ZIP inseguras y enlaces
simbólicos. Extrae los payloads únicamente a `OUT_DIR`, por lo que el código
Rust nunca depende de una ruta externa al repositorio.

Los recursos se conservan en `src-tauri/resources/` para permitir compilaciones
offline. `npm run skill:sync -- --tag=vX.Y.Z` es la única vía soportada para
actualizarlos.

## Aplicación

- `src/`: frontend Vite/Tailwind y modo mock.
- `src-tauri/src/`: comandos, persistencia e instalación atómica de payloads.
- `tests/`: contratos propios de Desktop.
- `.github/workflows/`: CI e instaladores por plataforma.

La instalación conserva configuraciones de usuario, crea respaldos antes de
reemplazar una instalación y mantiene compatibilidad de migración con la antigua
carpeta histórica de filesystem `instructional-designer-skill`.

## Persistencia

| Dato | Ubicación |
|---|---|
| Cursos del panel | `localStorage` de la WebView |
| Preferencias | Directorio de configuración de Jintia |
| Curso, sílabo y guías | Carpeta elegida por el usuario |
| Skill para Claude | `~/.claude/skills/jintia-skill` |
| Plugin universal | `~/.codex/plugins/jintia` |

## Versionado

La versión de Desktop está en `package.json`, `src-tauri/Cargo.toml` y
`src-tauri/tauri.conf.json`. La versión incorporada de la skill existe solo en
`skill.lock.json` y se propaga al frontend y Rust durante el build.
