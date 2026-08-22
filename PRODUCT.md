# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** Docentes universitarios que diseñan cursos desde cero o rediseñan asignaturas existentes. Trabajan con sílabos documentados, necesitan convertir contenido en estructuras pedagógicas verificables, y quieren generar guías semanales listas para publicar.

**Context:** Educación superior con énfasis en currículo intercultural y pedagógico. Usuarios manejan herramientas variadas (archivos, textos) pero no necesariamente tienen experiencia técnica avanzada. Trabajar en equipos educativos, revisar con pares, iterar por semestre.

## Product Purpose

Convertir un sílabo universitario en una ruta conectada de resultados, contenidos, actividades, evaluaciones y guías semanales listas para publicar. La aplicación elimina la fricción de instalar y configurar manualmente un entorno de diseño instruccional, gestionando runtimes administrados (Node.js, Vivliostyle CLI, Python) y servicios (NotebookLM MCP) alrededor de la skill `jintia` (motor editorial HTML) en una sola aplicación de escritorio con interfaz clara.

**Success means:** Un docente puede instalar la aplicación, completar el onboarding en minutos, crear una asignatura, subir un sílabo o contenido existente, y generar guías semanales HTML compiladas a PDF (vía Vivliostyle) con criterios pedagógicos verificables (UDL 3.0, Backward Design, Quality Matters 7, WCAG 2.2).

## Positioning

Jintia es la única herramienta que integra:
- **Instalador + configurador visual** (Tauri + Vite/JS + Tailwind) para docentes sin experiencia técnica.
- **Skill `jintia`** (npm, motor editorial HTML) como autoridad pedagógica: plan, targets, evidencia, reglas de calidad, `guide.json`.
- **Motor editorial HTML + Vivliostyle CLI** para PDF reproducible local, sin vendor lock-in ni LaTeX.
- **NotebookLM MCP** para investigación de fuentes integrada, como fuente primaria de evidencia.
- **Privacidad por diseño:** compilación y archivos completamente locales.

Competidores ofrecen LMS genéricos (Moodle, Canvas) o herramientas pedagógicas sin automatización; Jintia automatiza todo desde un sílabo.

## Operating Context

**Workflow canónico:**
1. Instalar aplicación Tauri + completar onboarding (runtimes administrados: Node, npm, Vivliostyle CLI; Python opcional para el pipeline visual).
2. Configurar datos institucionales (docente, institución, carrera, paleta visual) y NotebookLM.
3. Crear asignatura (`jintia init`) y estructurar su sílabo (temas, actividades).
4. Planificar la semana (`jintia plan`): targets, matriz de alineación, evidencia — antes de redactar.
5. Consultar fuentes mediante NotebookLM MCP (investigación integrada, jerarquía NotebookLM → local → ai-fallback).
6. Generar la guía (`guide.json` + `evidence.json`) y cerrarla con `jintia ready`.
7. Compilar a PDF localmente (Vivliostyle) y revisar.
8. Iterar y regresar al agente (Claude Code, Codex u OpenCode, vía `jintia-skill`) para refinamientos.

**Environments:** Windows 10/11, macOS (Apple Silicon y Intel), Linux. Aplicación de escritorio con acceso local a archivos, ejecución de compiladores, integración con MCP.

**Tools & Materials:**
- Sílabos escritos (PDF, Word, texto plano, Google Docs).
- NotebookLM notebooks (para curación de fuentes, fuente primaria de evidencia).
- Temas HTML de la skill (`jintia-clasico`, `jintia-tecnico`, `jintia-cuaderno`).
- Claude Code, Codex u OpenCode + `jintia-skill` (para generación y validación).

## Capabilities and Constraints

**Verified Capabilities:**
- Descarga y administra Node.js, npm, Vivliostyle CLI y (opcionalmente) Python como runtimes propios, sin depender de instalaciones globales del sistema.
- Instala la skill `jintia` desde npm (`@charlie.act7/jintia`) en staging, valida su contrato (`package.json`, `SKILL.md`, `skill/bin/jintia.js`, smoke test, `release-config.json`) y activa con rollback automático si algo falla.
- Resuelve la versión de la skill más reciente compatible con la versión de Desktop instalada, en vez de instalar siempre la última publicada a ciegas.
- En Windows: instala dependencias del sistema vía `winget` con solicitud de autorización, cuando aplica.
- Crea estructura canónica de asignatura delegando en `jintia init` (sin lógica de creación de curso duplicada).
- Conecta NotebookLM MCP sin sobrescribir otras configuraciones.
- Instala la skill como agente global en Claude Code, Codex y OpenCode delegando en el propio CLI de `jintia` (detección/instalación de harnesses).
- Mantiene todos los archivos, compilación y datos localmente (sin servidores).

**Constraints:**
- Aplicación requiere conexión para descargar dependencias e instalarlas.
- DMG actual (macOS) no está firmado ni notarizado (Gatekeeper warning).
- Instaladores Windows aún no están firmados (SignPath en trámite).
- Tres temas HTML incluidos en la skill (expansible en futuro).
- El motor de compilación a PDF es Vivliostyle CLI (CSS Paged Media) — no hay pipeline LaTeX activo.

**Product Facts (undecided):**
- Mobile companion app: no confirmado; web responsive vs. desktop-only a decidir.
- Soporte para cursos en progreso: actualmente por semestre; histórico indefinido.

## Brand Commitments

**Name:** _Jintia_ — palabra del Shuar Chicham (lengua indígena ecuatoriana) que significa "camino". Expresa el propósito: convertir un sílabo en una ruta coherente.

**Attribution:** Uso reconocido explícitamente en docs y about view. Sin representación, aprobación ni vinculación institucional con comunidades Shuar (requisito cultural).

**Voice:** Educativo, claro, técnicamente honesto. Explicaciones sin jerga; advertencias visibles (ej: "No firmado" en DMG). Compromiso con privacidad.

**Visual Identity:** Glassmorphic con liquid control elements (ver DESIGN.md). Paleta: teal oceánico moderno (#0f766e) para acciones, neutros suaves, sombras translúcidas. Tipografía: Inter, legible en 13px, minimalista.

**Legal:**
- MIT License.
- Código abierto, repositorio público GitHub.
- Privacidad: sin telemetría, sin envío de cursos a servidores Jintia. NotebookLM consultas van a Google; otros datos locales.

## Evidence on Hand

**Published artifacts:**
- Aplicación Desktop 1.0.0 publicada inicialmente en la release monorepo v10.8.0.
- README principal: propósito, instalación, uso, estructura.
- Documentación técnica: guía Claude Desktop, arquitectura, design system, proceso de release.
- DESIGN.md: sistema visual completo (colores, tipografía, componentes glassmorphic).
- CHANGELOG.md: historial de versiones.
- THIRD_PARTY_NOTICES.md: atribuciones.

**Repository:** `github.com/CharlieCardenasToledo/jintia-desktop`

**Absent or undecided:**
- User research data (testing con docentes reales).
- Analytics (ni planeado; privacidad por diseño).
- Marketing copy (fuera de scope de docs técnicas).

## Product Principles

1. **Accesibilidad pedagógica:** La herramienta no sustituye el juicio del docente; amplifica su intención pedagógica mediante UDL, Backward Design, Quality Matters. Guías verificables y reproducibles.

2. **Privacidad y soberanía:** Todos los datos, compilación y output del usuario se procesan localmente. Sin telemetría, sin vendor lock-in. Runtimes administrados y abiertos (Node.js, Vivliostyle CLI, Python opcional).

3. **Honestidad técnica:** Advertencias visibles (unsigned installers, requisitos), no ocultar fricción. Documentación clara sobre qué requiere conexión y qué no.

4. **Coherencia visual y conceptual:** Interfaz minimalista glassmorphic refleja el enfoque del producto (claridad, ligereza, enfoque en contenido). Cada control es intencional.

5. **Integración sin silos:** La app instala y configura; la skill en Claude Code es el motor. Ambas comunican limpiamente. Exportación en ZIP preserva independencia.

## Accessibility & Inclusion

**Required standards:**
- WCAG 2.2 AA: interfaz accesible (contraste, navegación por teclado, lectores de pantalla).
- Tipografía: Inter a 13px línea 1.5 para densidad y legibilidad.
- Soporte UTF-8: español, quechua, shuar, otras lenguas indígenas.

**Pedagogical inclusion (UDL 3.0):**
- Múltiples modos de presentación (gráficos, texto, datos).
- Flexibilidad en acciones (CLI, MCP, UI).
- Engagement claro: propósito visible, feedback inmediato.
