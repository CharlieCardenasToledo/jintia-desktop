# Encargo de revisión visual con Playwright — Ask Jintia

## Objetivo

Revisar visual y funcionalmente la interfaz de **Ask Jintia** en un navegador mediante Playwright. La revisión debe confirmar que la pantalla se percibe como parte del sistema visual de Jintia, que los iconos se renderizan correctamente y que las acciones del historial funcionan.

No evaluar únicamente una captura estática: ejecutar las interacciones indicadas y documentar cualquier defecto con evidencia reproducible.

## Proyecto y escenario mock

- Repositorio: `D:\Proyectos Personales\jintia\jintia-desktop`
- Comando de desarrollo:

  ```powershell
  npm run dev:web -- --host 127.0.0.1 --port 1421
  ```

- URL directa del escenario:

  ```text
  http://127.0.0.1:1421/?bypass=1&ask-jintia=1
  ```

El parámetro `bypass=1` omite el onboarding. `ask-jintia=1` carga una asignatura de demostración, NotebookLM conectado, cuatro conversaciones y respuestas representativas con Markdown, tabla y fuentes.

Si el puerto 1421 está ocupado, detener únicamente el proceso de desarrollo perteneciente a este proyecto o iniciar el servidor en otro puerto y conservar los mismos parámetros de consulta.

## Archivos relevantes

- `src/pages/jintia-chat.js`: interfaz y comportamiento de Ask Jintia.
- `src/mocks/tauri-core.mock.js`: backend simulado y conversaciones de prueba.
- `src/state.js`: asignatura mock y apertura directa de la página.
- `src/icons.js`: registro e hidratación de iconos Lucide.
- `src/styles.css`: tokens y estilos globales de Jintia.
- `src/main.js`: sidebar principal usado como referencia visual.
- `src-tauri/src/opencode/client.rs`: endpoints para renombrar y eliminar sesiones.

## Referencia de marca que debe respetarse

La pantalla debe compartir el lenguaje visual de la aplicación:

- Azul marino principal: `brand-950`, cercano a `#0D1B2A`.
- Turquesa de acción y ruta: `brand-700`/`brand-600`.
- Tipografía de interfaz: Inter.
- Tipografía de títulos: Syne.
- Marca oficial desde `/brand/`, sin letras «J» improvisadas.
- El concepto distintivo es una **ruta de aprendizaje y evidencia**: nodos, conexiones, contexto de asignatura/semana y fuentes verificables.
- El contenido debe permanecer opaco y legible; los efectos decorativos no deben competir con la lectura.

El historial interior debe verse relacionado con el sidebar principal de Jintia: fondo azul marino, texto claro, turquesa para el estado activo y marca oficial. No debe parecer un panel blanco genérico perteneciente a otra aplicación.

## Viewports obligatorios

Realizar la revisión al menos en estos tamaños:

1. Escritorio amplio: `1440 × 900`.
2. Escritorio compacto: `1280 × 800`.
3. Tableta: `1024 × 768`.
4. Móvil: `390 × 844`.

Tomar una captura completa en cada tamaño. En escritorio, incluir además una captura con una conversación del historial abierta.

## Recorrido funcional obligatorio

### 1. Carga inicial

1. Abrir la URL del escenario mock.
2. Esperar a que desaparezcan estados de carga.
3. Confirmar que la navegación activa es **Ask Jintia**.
4. Confirmar que aparecen:
   - asignatura `IFT200 · Interacción Persona Computador`;
   - selector de semana;
   - estado de OpenCode;
   - indicador de fuentes conectadas;
   - historial de conversaciones;
   - panel de fuentes en escritorio amplio;
   - compositor de mensajes.
5. Registrar errores y advertencias de consola.

### 2. Iconos

Confirmar visualmente que no existan botones vacíos. Deben verse, como mínimo:

- abrir/cerrar conversaciones;
- búsqueda;
- editar conversación;
- eliminar conversación;
- nueva conversación;
- fuentes;
- enviar;
- detener respuesta cuando corresponda;
- cerrar paneles responsivos.

Inspeccionar el DOM si alguno no se ve. Verificar que el placeholder `<i data-lucide>` haya sido convertido en un `<svg>` visible y que no existan nombres de icono ausentes del registro.

### 3. Renombrar una conversación

1. Elegir una conversación que no esté activa.
2. Hacer clic en el icono de lápiz.
3. Confirmar que aparece un input visible, enfocado y con el nombre seleccionado.
4. Verificar que hacer clic dentro del input **no cambia de conversación**.
5. Escribir `Revisión visual actualizada` y pulsar Enter.
6. Confirmar el mensaje de éxito y que el nuevo título permanece en el historial.
7. Repetir el inicio de la edición y pulsar Escape; el título no debe cambiar.
8. Repetir el inicio de la edición, cambiar el texto y hacer clic fuera; debe guardarse una sola vez, sin solicitudes duplicadas.

### 4. Eliminar una conversación

1. Elegir una conversación inactiva.
2. Hacer clic en el icono de papelera.
3. Confirmar que aparece el diálogo propio de Jintia, no `window.confirm()`.
4. Pulsar Cancelar: la conversación debe permanecer.
5. Abrir nuevamente el diálogo y confirmar Eliminar.
6. Confirmar el mensaje de éxito y que la fila desaparece sin reaparecer al recargar el historial.
7. Verificar que no se informa éxito ante un error o una conversación inexistente.

### 5. Historial

1. Escribir parte de un título en el buscador.
2. Confirmar que solo se muestran coincidencias.
3. Limpiar la búsqueda y confirmar que reaparecen todas.
4. Abrir una conversación.
5. Confirmar que la fila activa se distingue mediante color, borde turquesa y `aria-current`, no únicamente por color.
6. Confirmar que no se muestran IDs técnicos de sesión.
7. Revisar que los iconos de editar y eliminar sean visibles sin depender exclusivamente de `hover`.

### 6. Conversación y fuentes

1. Abrir `Evaluación heurística · Semana 03` o su nombre actualizado.
2. Confirmar que se muestran el mensaje del usuario y la respuesta de Jintia.
3. Revisar jerarquía de títulos, listas, tabla y ancho de lectura.
4. Confirmar que la tabla tiene desplazamiento horizontal cuando no cabe.
5. Confirmar que aparecen las acciones `Copiar`, `Ver fuentes` y `Usar como base`.
6. Pulsar `Ver fuentes` y comprobar el panel correspondiente.
7. Confirmar que las fuentes muestran NN/g y WCAG sin navegar el WebView interno.
8. Pulsar `Usar como base`; debe rellenar el compositor sin enviar automáticamente.

### 7. Cambio de semana y nueva conversación

1. Cambiar de semana después de abrir una sesión.
2. Confirmar que aparece el diálogo que advierte sobre iniciar una conversación nueva.
3. Cancelar y verificar que la semana anterior se conserva.
4. Confirmar el cambio y verificar que el resumen de contexto y el saludo usan la nueva semana.
5. Pulsar `Nueva conversación` y confirmar que no se mezclan mensajes anteriores.

### 8. Responsive

En tableta y móvil:

- el historial debe abrirse como panel lateral y poder cerrarse;
- el panel de fuentes debe abrirse y cerrarse;
- ningún panel debe quedar fuera del viewport;
- encabezado, selectores y estado no deben superponerse;
- el compositor debe permanecer visible y utilizable;
- los botones deben tener objetivos táctiles suficientes;
- no debe existir desplazamiento horizontal global.

## Revisión de accesibilidad

Comprobar con teclado:

1. Recorrer controles con Tab y Shift+Tab.
2. Confirmar foco visible en todos los botones, selectores, buscador e input de renombrado.
3. Activar editar/eliminar con teclado.
4. Confirmar que Escape cancela la edición y cierra los diálogos cuando corresponde.
5. Revisar nombres accesibles de botones de icono.
6. Confirmar `role="log"`, `aria-live`, `aria-busy` y el estado anunciado.
7. Confirmar que el contraste del texto y los iconos es legible tanto en el historial oscuro como en las superficies claras.

Si el entorno dispone de herramientas automáticas, ejecutar un análisis de accesibilidad, pero no sustituir con él la comprobación manual de teclado y foco.

## Criterios de evaluación visual

Puntuar de 1 a 5 y justificar:

| Dimensión | Pregunta |
| --- | --- |
| Identidad Jintia | ¿La pantalla podría reconocerse como Jintia sin leer el nombre? |
| Coherencia | ¿El historial, el chat y las fuentes parecen partes del mismo producto? |
| Jerarquía | ¿Asignatura, semana, conversación y fuentes tienen prioridades claras? |
| Legibilidad | ¿La respuesta se lee cómodamente y mantiene un ancho razonable? |
| Affordance | ¿Las acciones se descubren y se entiende qué harán? |
| Estados | ¿Carga, listo, error, edición, eliminación y selección son inequívocos? |
| Accesibilidad | ¿Teclado, foco, contraste y nombres accesibles cumplen? |
| Responsive | ¿La arquitectura se adapta sin perder funciones? |

## Evidencia requerida

Entregar:

1. Capturas PNG de los cuatro viewports.
2. Captura antes y después de renombrar.
3. Captura del diálogo de eliminación.
4. Captura de una respuesta con tabla y panel de fuentes.
5. Lista de errores de consola, si existen.
6. Lista de solicitudes fallidas, si existen.
7. Resultado de cada paso funcional: `PASS`, `FAIL` o `BLOCKED`.

## Formato del reporte

Crear `docs/reporte-playwright-ask-jintia.md` con esta estructura:

```markdown
# Reporte Playwright — Ask Jintia

## Veredicto
Resumen breve y decisión: aprobado, aprobado con observaciones o no aprobado.

## Resultados funcionales
Tabla con prueba, resultado y evidencia.

## Hallazgos visuales
Hallazgos ordenados por severidad: P0, P1, P2 y P3.

## Accesibilidad
Teclado, foco, semántica, contraste y movimiento.

## Responsive
Resultado por viewport.

## Capturas
Ruta y explicación de cada imagen.

## Recomendaciones
Cambios concretos, archivo probable y criterio de aceptación.
```

Cada defecto debe incluir:

- severidad;
- pasos exactos para reproducirlo;
- comportamiento observado;
- comportamiento esperado;
- captura o evidencia DOM/consola;
- archivo o componente probable;
- recomendación concreta.

## Restricciones

- No aprobar iconos únicamente porque exista un botón en el DOM: el SVG debe verse.
- No considerar exitoso renombrar o eliminar solo porque aparezca un toast: comprobar el estado final del historial.
- No modificar archivos antes de terminar el reporte inicial; primero documentar el estado observado.
- No usar datos reales ni requerir cuentas externas: el escenario mock debe ser suficiente.
- No evaluar el proveedor Codex en esta revisión; el alcance principal es la interfaz y el historial OpenCode simulado.

