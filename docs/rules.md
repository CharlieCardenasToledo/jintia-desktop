# Reglas deterministas

El catálogo canónico vive en el repositorio de la skill:
[`skill/rules/catalog.json`](https://github.com/CharlieCardenasToledo/jintia/blob/master/skill/rules/catalog.json).
Cada regla tiene un ID estable (`JIN-*`), categoría, severidad y descripción.
Desktop no mantiene una copia propia de este catálogo — lo consume tal cual
está publicado en la skill instalada.

Familias principales:

- `syllabus` (`JIN-SYL-*`): contrato y campos mínimos del sílabo;
- `plan` (`JIN-PLN-*`): contrato pedagógico del plan (targets, matriz de alineación, presupuesto de horas, contrato de evaluación);
- `alignment` (`JIN-ALN-*`): conexión entre resultado, enseñanza, práctica y evaluación;
- `bibliography` (`JIN-BIB-*`): claves citadas, `reference.bib`, `citationStyle`;
- `evidence` (`JIN-EVD-*`): procedencia NotebookLM / local / conocimiento del modelo;
- `self-instruction` (`JIN-SELF-*`): contrato de autoinstruccionalidad de `orientation` y `practice`;
- `assessment` (`JIN-ASM-*`): criterios, producto observable y alineación de evaluaciones;
- `accessibility`, `structure`, `pagination` (`JIN-CNT-*`, `JIN-HTM-*`): estructura y accesibilidad del documento.

No existe una categoría `latex`: el motor editorial es HTML + Vivliostyle CLI.

Uso (desde la CLI administrada por Desktop o vía `npx`):

```bash
npx @charlie.act7/jintia audit README.md
npx @charlie.act7/jintia audit README.md --json --strict
npx @charlie.act7/jintia validate semanas/semana-03/guide.json --strict --json
```

`audit` valida el sílabo (`README.md`); `validate` valida una guía semanal
(`guide.json`). `--strict` convierte también las advertencias en fallo de
proceso. Las reglas no sustituyen la revisión pedagógica del agente; aportan
una base reproducible.
