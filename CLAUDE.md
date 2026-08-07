# Refactorización Jintia Desktop → P0: Notas de Progreso

## Estado Actual
Se completaron las **Fases 1-3 del plan** (Fases 1, 1b, 2, 2b, 3).

### Cambios Implementados

**FASE 1: Engine Adapter (`src-tauri/src/engine.rs`)**
- Nuevo módulo genérico que ejecuta comandos `jintia` vía Node CLI
- Funciones: `run_jintia()` (stdout/stderr) y `run_jintia_json<T>()` (parsing automático)
- Registrado en `lib.rs`

**FASE 1b: Reescribir `toolchain.rs`**
- `run()` ahora delega a `engine::run_jintia()` sin validaciones `.tex`
- `manage_harness()` también delega a Engine Adapter
- Eliminadas restricciones de extensión de archivo

**FASE 3: Provider Detection (`src-tauri/src/harnesses.rs`)**
- `detect()` llama `jintia detect --json` vía Engine Adapter
- Fallback a tabla local si Skill no está disponible
- Eliminada tabla hardcodeada de 13 proveedores

**FASE 2: Eliminar Motor LaTeX (`src-tauri/src/course.rs`)**
- Eliminadas funciones: `compile_syllabus_pdf()` (~400 líneas), `compile_via_pdflatex()`, helpers
- Eliminadas constantes LaTeX
- `create_course_structure()` ahora llama `jintia init`
- Eliminado parámetro `weeks` del contrato Tauri

**FASE 2b: Actualizar `course_state.rs` y `config.rs`**
- `week_guide_exists()` busca `guide.json` en lugar de `.tex`
- Test actualizado

## Compilación
- ✅ `cargo check` pasa sin errores
- ⚠️ Warnings esperados sobre código no usado

## Próximas Prioridades
1. FASE 4 — Migration wizard
2. FASE 5 — Tests (quitar LaTeX-specific)
3. FASE 6 — CI multi-plataforma
4. FASE 0 — Skill endpoints (opcional)
