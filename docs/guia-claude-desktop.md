# Usar Jintia con Claude

Esta guía separa las cuatro superficies de Claude que pueden intervenir en el
flujo. No son equivalentes y la forma de instalar la skill cambia en cada una.

## Elegir la modalidad

| Modalidad | Instalación | Uso recomendado |
|---|---|---|
| Claude Code | Carpeta local en `~/.claude/skills/` | Crear y compilar archivos dentro de un curso local |
| Claude Skills | Subir un ZIP en `Customize → Skills` | Usar el método pedagógico en chats compatibles |
| Claude Projects | Agregar instrucciones y conocimiento al proyecto | Mantener contexto estable; no sustituye la instalación de la skill |
| Cowork | Usar una skill cargada y una carpeta autorizada | Tareas de archivos desde la aplicación de escritorio, sujeto a sus límites actuales |

Consulta la documentación oficial de
[Skills](https://support.claude.com/en/articles/12512180-use-skills-in-claude),
[Projects](https://support.claude.com/en/articles/9517075-what-are-projects),
[Claude Code](https://code.claude.com/docs/en/slash-commands) y
[Cowork](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork)
para confirmar disponibilidad según tu plan y plataforma.

## Antes de instalar

La generación completa de guías requiere:

- Node.js (administrado por la propia app, no necesitas instalarlo aparte);
- Vivliostyle CLI (motor de compilación a PDF; la app puede administrarlo);
- Python (opcional, solo para parte del pipeline visual);
- NotebookLM MCP — fuente primaria de evidencia, no un complemento opcional.

La aplicación comprueba y administra estos requisitos por ti (runtimes
propios, sin depender de instalaciones globales del sistema). En Windows
puede iniciar instalaciones de dependencias del sistema vía `winget` después
de pedir confirmación.

## Opción 1: Claude Code

Es la modalidad recomendada para trabajar directamente con las carpetas del
curso, ejecutar validadores y compilar la guía a HTML/PDF.

### Instalación desde la aplicación

1. Completa el onboarding.
2. Configura la institución y NotebookLM.
3. Abre la sección de activación.
4. Selecciona la instalación local para Claude Code.
5. Reinicia Claude Code si ya estaba abierto.

La app instala el payload en:

```text
Windows: %USERPROFILE%\.claude\skills\jintia-skill
macOS:   ~/.claude/skills/jintia-skill
Linux:   ~/.claude/skills/jintia-skill
```

### Instalación manual

Clona el repositorio y copia **el contenido de `skill/`**, no la raíz del
monorepo, a la ruta anterior. `SKILL.md` debe quedar directamente dentro de
`jintia-skill/`.

La estructura mínima es:

```text
jintia-skill/
├── SKILL.md
├── config/
├── references/
├── scripts/
└── templates/
```

Claude Code puede activar la skill por contexto o mediante:

```text
/jintia-skill
```

Abre Claude Code en la carpeta de la asignatura y pide, por ejemplo:

```text
Crea la guía de la semana 03 usando el README del curso como sílabo canónico.
```

## Opción 2: Claude Skills mediante ZIP

1. En la app, selecciona **Exportar skill**.
2. Elige una carpeta de destino.
3. En Claude, abre `Customize → Skills`.
4. Sube el ZIP generado.
5. Activa la skill en un chat compatible.

No descargues un supuesto ZIP de la GitHub Release: las releases actuales
publican los instaladores de escritorio. El ZIP de la skill se genera desde la
app con tu configuración.

> El ZIP puede contener `institution.json` y `notebooks.json` reales. Revísalo
> antes de compartirlo o subirlo a una cuenta distinta.

## Opción 3: Claude Projects

Projects sirve para conservar instrucciones, archivos de conocimiento y
conversaciones relacionadas. No convierte automáticamente el contenido pegado
en una skill ni registra `/jintia-skill`.

Úsalo para:

- adjuntar el sílabo o documentación institucional;
- mantener instrucciones específicas de una asignatura;
- conservar contexto entre conversaciones.

Para ejecutar el flujo completo con archivos locales y scripts, utiliza Claude
Code o una modalidad de Cowork que permita autorizar la carpeta necesaria.

## Opción 4: Cowork

Cowork puede trabajar con carpetas autorizadas y skills disponibles en Claude,
pero su arquitectura y capacidades cambian con rapidez. Actualmente sus
proyectos son locales a la aplicación y no admiten compartir el proyecto con
otras personas.

No asumas que Cowork:

- descubre automáticamente `~/.claude/skills`;
- comparte un proyecto entre miembros de un equipo;
- tiene acceso al Vivliostyle CLI administrado por Jintia Desktop en el equipo local.

Autoriza únicamente la carpeta del curso y verifica el resultado antes de
sobrescribir archivos existentes. La
[arquitectura oficial de Cowork](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
describe el modelo de ejecución vigente.

## Configurar NotebookLM MCP

La aplicación preserva otros servidores MCP y agrega `notebooklm` con la
versión fijada por el contrato de la skill instalada (`release.rs` la lee de
`release/release-config.json`; nunca se hardcodea aquí, para no
desincronizarse del release real):

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "@charlie.act7/gemini-notebook-mcp@<versión del contrato>"]
    }
  }
}
```

La autenticación puede abrir un navegador. Las consultas salen del equipo y
se procesan mediante los servicios de Google/NotebookLM.

## Actualizaciones

La app preserva `institution.json` y `notebooks.json` al actualizar una
instalación local. Aun así, conserva una copia de seguridad antes de realizar
cambios importantes. Cuando exportes otro ZIP, vuelve a revisar los datos que
incluye.

## Solución de problemas

### Claude Code no detecta la skill

- Confirma que `SKILL.md` está directamente dentro de la carpeta de la skill.
- Confirma que la carpeta se llama `jintia-skill`.
- Si conservas una instalación anterior en
  `instructional-designer-skill`, vuelve a instalar desde Jintia Desktop
  para migrarla a `jintia-skill`.
- Reinicia Claude Code.

### NotebookLM no autentica

- Comprueba Node.js y `npx`.
- Ejecuta la autenticación desde la app.
- Si la sesión guardada caducó, usa la opción de reautenticación.

### La guía no compila

- Ejecuta primero `jintia validate guide.json` para descartar errores de estructura/esquema.
- Confirma que Vivliostyle CLI está instalado y accesible (la app lo administra; revisa el estado en Configuración > Entorno).
- Si validas manualmente, `jintia preflight guide.html` detecta problemas de paginación antes de compilar.
- No hay dependencia de ninguna distribución ni compilador de documentos externo en ninguna plataforma: el motor es HTML + Vivliostyle CLI.

## Alcance de privacidad

Los archivos y la compilación son locales. Requieren red:

- autenticación y consultas de NotebookLM;
- extracción de una paleta desde un sitio institucional;
- instalación o descarga de dependencias;
- subida de una skill a Claude.
