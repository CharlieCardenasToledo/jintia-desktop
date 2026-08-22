# NotebookLM

NotebookLM es la fuente **primaria** de evidencia disciplinar del flujo
Jintia — no una integración opcional para "contrastar" afirmaciones después
de escribir. La jerarquía es NotebookLM (hasta 3 intentos) → fuente local
verificable → conocimiento del modelo (`ai-fallback`, último recurso, nunca
fabrica bibliografía). Ver la política completa en
[`docs/notebooklm.md` de la skill](https://github.com/CharlieCardenasToledo/jintia/blob/master/docs/notebooklm.md).

## Rol de Desktop

Desktop administra el servidor MCP de NotebookLM (`@charlie.act7/gemini-notebook-mcp`,
versión fijada por el contrato de la skill instalada — ver
`src-tauri/src/release.rs`) y sincroniza `config/notebooks.json` del curso.
No implementa lógica de investigación propia: el agente (Claude Code, Codex
u OpenCode) es quien consulta NotebookLM a través de las herramientas MCP;
Desktop solo instala, configura y mantiene la sesión de autenticación.

`jintia doctor` no gestiona la autenticación de NotebookLM (eso ocurre vía
`setup_auth`/`re_auth` del MCP); solo confirma que el servidor esté
configurado.
