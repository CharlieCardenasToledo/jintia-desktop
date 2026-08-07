# Refactorización Jintia Desktop → P0: Notas de Progreso

## Estado Actual
Se completaron las **Fases 1-4 del plan** (Fases 1, 1b, 2, 2b, 3, 4).
En progreso: **FASE 5a (Tests Rust)**.

### Cambios Implementados

**FASE 1: Engine Adapter (`src-tauri/src/engine.rs`)**
- Nuevo módulo genérico que ejecuta comandos `jintia` vía Node CLI
- Funciones: `run_jintia()` (stdout/stderr) y `run_jintia_json<T>()` (parsing automático)
- Registrado en `lib.rs`

**FASE 1b: Reescribir `toolchain.rs`**
- `run()` ahora delega a `engine::run_jintia()` sin validaciones `.tex`
- `manage_harness()` también delega a Engine Adapter

**FASE 3: Provider Detection (`src-tauri/src/harnesses.rs`)**
- `detect()` llama `jintia detect --json` vía Engine Adapter
- Eliminada tabla hardcodeada de 13 proveedores

**FASE 2: Eliminar Motor LaTeX (`src-tauri/src/course.rs`)**
- Eliminadas ~400 líneas de funciones de compilación LaTeX
- `create_course_structure()` ahora llama `jintia init`

**FASE 2b: Actualizar State y Config**
- `week_guide_exists()` busca `guide.json` en lugar de `.tex`

**FASE 4: Migración de Proyectos 1.1.x**
- Nuevas funciones: `check_migration_needed()`, `run_migration()`
- Nuevos comandos Tauri: `check_migration_needed`, `run_migration`
- Nuevo struct: `MigrationStatus` en models.rs

## Compilación
- ✅ `cargo check` sin errores
- ⚠️ Tests Rust en ejecución (background)

## Próximas Tareas
| Fase | Tarea | Estado |
|------|-------|--------|
| 5a | Tests Rust (eliminar LaTeX-specific) | 🔄 In Progress |
| 5b | Tests JS (eliminar LaTeX strings) | ⏳ Pending |
| 6 | CI Windows/macOS | ⏳ Pending |
| 0 | Skill endpoints (optional) | ⏳ Pending |
