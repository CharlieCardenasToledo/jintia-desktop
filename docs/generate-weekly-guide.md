# Generar una guía semanal

1. Pide al agente (Claude Code, Codex u OpenCode, vía `jintia-skill`) planificar la semana antes de crear archivos.
2. Confirma el resultado de aprendizaje, los `targets`, la matriz de alineación y la evidencia disponible — el plan se aprueba explícitamente antes de redactar.
3. Solicita la guía (`guide create` / `guide finalize`) para la semana correspondiente.
4. Ejecuta el cierre técnico:

```bash
npx @charlie.act7/jintia validate semanas/semana-03/guide.json --publish
npx @charlie.act7/jintia ready semanas/semana-03/guide.json
```

`jintia ready` encadena validación, procedencia de evidencia, bibliografía, render, lint, preflight y compilación a PDF (Vivliostyle CLI, administrado por Desktop) en un solo paso, deteniéndose en el primer bloqueo.

5. Revisa el PDF, la bibliografía y las figuras antes de compartirlo.

Ver la documentación completa del flujo en el repositorio de la skill:
[`docs/generate-weekly-guide.md`](https://github.com/CharlieCardenasToledo/jintia/blob/master/docs/generate-weekly-guide.md).
