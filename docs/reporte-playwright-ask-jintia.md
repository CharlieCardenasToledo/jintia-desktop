# Reporte Playwright — Ask Jintia

Fecha de ejecución: 2026-08-18  
Escenario: `http://127.0.0.1:1421/?bypass=1&ask-jintia=1`  
Servidor: `npm run dev:web -- --host 127.0.0.1 --port 1421`

## Veredicto

**Aprobado tras mejoras, con validación manual de teclado pendiente.** Los P1, P2 y P3 del estado inicial fueron corregidos. Ask Jintia ahora prioriza la conversación, reúne NotebookLM, enlaces citados e historial en un único panel contextual, se contiene dentro del viewport y usa objetivos táctiles de 44 px. Al entrar en Ask Jintia, el menú principal se contrae automáticamente y conserva un control visible para recuperarlo. La suite automatizada y el build terminan correctamente; Tab/Shift+Tab sigue pendiente de repetición manual por la limitación del controlador embebido descrita en Accesibilidad.

## Resultados funcionales

| Prueba | Resultado | Evidencia |
| --- | --- | --- |
| Carga directa y navegación activa `Ask Jintia` | PASS | Asignatura IFT200, semana, OpenCode listo, fuentes, cuatro conversaciones, compositor y panel de fuentes visibles en `01-inicial-1440x900.png`. |
| Iconos Lucide visibles | PASS | 24 SVG medidos; 0 placeholders `i[data-lucide]` sin hidratar; búsqueda, lápiz, papelera, ruta, libro, enviar y cierres tienen SVG con dimensiones visibles cuando corresponde. |
| Renombrar: input visible, foco y selección | PASS | El input tomó foco, seleccionó 0–30 caracteres y no cambió de sesión al pulsarlo. Véase `02-renombrar-antes.png`. |
| Renombrar con Enter | PASS | Toast `Conversación renombrada`; `Revisión visual actualizada` permaneció tras terminar la recarga del historial. Véase `03-renombrar-despues.png`. |
| Renombrar con Escape | PASS | `Cambio que debe cancelarse` no se guardó y el título anterior se conservó. |
| Renombrar al perder foco | PASS | `Revisión visual actualizada fuera` se guardó una vez. El guard `settled` de `src/pages/jintia-chat.js:574` evita doble commit entre `blur` y Enter. |
| Diálogo propio de eliminación | PASS | No apareció diálogo JavaScript nativo; se mostró `role="alertdialog"`, foco inicial en Cancelar y advertencia irreversible. Véase `04-dialogo-eliminacion.png`. |
| Cancelar eliminación | PASS | `Revisión del sílabo` permaneció después de Cancelar; Escape también cerró el diálogo. |
| Confirmar eliminación y persistencia tras recargar historial | PASS | Tras confirmar `Eliminar`, apareció `Conversación eliminada`; `Revisión del sílabo` desapareció y la recarga interna terminó con tres conversaciones, sin reaparición. Véase `11-eliminacion-confirmada.png`. |
| Error al eliminar sesión inexistente | PASS (código) | El mock lanza error en `src/mocks/tauri-core.mock.js:334`; la UI retorna sin eliminar ni mostrar éxito en `src/pages/jintia-chat.js:614`. No se forzó una sesión inexistente desde el DOM. |
| Buscar, filtrar y limpiar | PASS | `Gestalt` dejó una coincidencia; `Ctrl+A` + Backspace restauró las cuatro filas. La limpieza con `fill("")` del controlador no emitió el evento de usuario y no se consideró defecto del producto. |
| Abrir conversación y estado activo | PASS | La fila usa `aria-current="true"`, borde izquierdo turquesa y fondo distinto; no hay IDs `ses_*` visibles. Véase `05-conversacion-abierta-1440x900.png`. |
| Mensajes, Markdown y tabla | PASS | El `role="log"` contiene el mensaje del usuario y la respuesta; la tabla mide 544 px dentro de un contenedor de 521 px con `overflow-x:auto`. |
| Acciones de respuesta | PASS | `Copiar`, `Ver fuentes` y `Usar como base` visibles. `Usar como base` rellenó y enfocó el compositor sin añadir mensaje al log. |
| Fuentes NN/g y WCAG | PASS | `Ver fuentes` mostró `10 Usability Heuristics` y `WCAG 2.2` sin abrir el WebView. Véase `06-tabla-y-fuentes-1440x900.png`. |
| Cambio de semana: cancelar | PASS | Al elegir Semana 04 apareció aviso de conversación nueva; Cancelar restauró `Contexto general`. |
| Cambio de semana: confirmar | PASS | Semana 04 quedó seleccionada, saludo y resumen se actualizaron y desapareció el contenido de la sesión anterior. |
| Nueva conversación | PASS | El log anterior se limpió, apareció saludo de nueva conversación y ninguna fila quedó activa. |
| Consola | PASS | 0 errores y 0 advertencias capturados durante el recorrido. |
| Solicitudes o recursos fallidos | PASS con alcance | No hubo errores de consola ni imágenes rotas. El controlador embebido no expuso interceptación de red; el escenario usa `invoke` mock local y no se observó fallo asociado. |

## Hallazgos visuales del estado inicial

### P1 — El historial se abre automáticamente y sale del viewport en móvil

- **Pasos:** cargar el escenario directamente a 390 × 844; esperar a `OpenCode listo`.
- **Observado:** `startRuntime()` abre siempre el historial. El panel ocupa `x=12…284`, `y=152…953`, por lo que termina 109 px por debajo del viewport. Tapa el contexto y la conversación. El compositor queda en `y=805…881`, también por debajo del viewport mientras el panel está abierto.
- **Esperado:** inicio móvil con el historial cerrado; al abrirlo, panel completamente contenido, con scroll interno y compositor recuperable sin desplazamiento global.
- **Evidencia:** `09-responsive-390x844.png` y medición DOM anterior.
- **Archivo probable:** `src/pages/jintia-chat.js:141`, `src/pages/jintia-chat.js:432` y `src/pages/jintia-chat.js:967`.
- **Recomendación:** no invocar `showSessionsPanel()` automáticamente por debajo del breakpoint de escritorio; limitar el overlay a la altura real disponible (`max-height`/`inset-block`) y mantener el scroll dentro del panel.

### P1 — Historial y fuentes pueden ocupar simultáneamente la tableta

- **Pasos:** cargar a 1024 × 768; con el historial abierto por defecto, pulsar `Fuentes conectadas`.
- **Observado:** historial (`x=232…456`) y fuentes (`x=672…1008`) quedan abiertos. Fuentes cubre 336 px del área del log y deja aproximadamente 216 px de conversación realmente visibles.
- **Esperado:** en tableta, abrir un panel debe cerrar el otro o ambos deben comportarse como overlays mutuamente excluyentes.
- **Evidencia:** `10-tableta-paneles-simultaneos-1024x768.png`.
- **Archivo probable:** `src/pages/jintia-chat.js:432` y `src/pages/jintia-chat.js:446`.
- **Recomendación:** en breakpoints menores a `xl`, hacer que `showSessionsPanel()` llame a `hideSourcesPanel()` y viceversa; añadir backdrop y devolver foco al disparador al cerrar.

### P2 — Varios objetivos táctiles son menores que 44 × 44 px

- **Pasos:** revisar 390 × 844 y medir botones visibles.
- **Observado:** editar/eliminar/cerrar historial miden 32 × 32 px; `Nueva conversación` tiene 33.6 px de alto; `Copiar`, `Ver fuentes` y `Usar como base` tienen 32 px de alto. El SVG de lápiz y papelera mide 11 × 11 px y se percibe tenue sobre la cápsula clara.
- **Esperado:** objetivo táctil equivalente de al menos 44 × 44 px o espaciado que evite activaciones accidentales, con iconos claramente perceptibles.
- **Evidencia:** `01-inicial-1440x900.png`, `08-responsive-1024x768.png` y `09-responsive-390x844.png`.
- **Archivo probable:** `src/pages/jintia-chat.js:503`, `src/pages/jintia-chat.js:510`, `src/pages/jintia-chat.js:1263` y clases de botones en `src/uiClasses.js`.
- **Recomendación:** elevar `min-h/min-w` de acciones de icono a 44 px en táctil, mantener al menos 16 px de SVG y aumentar contraste del icono.

### P3 — La barra superior pierde legibilidad en móvil

- **Pasos:** cargar a 390 × 844 con el panel cerrado.
- **Observado:** el subtítulo `Chat nativo…` queda parcialmente recortado bajo la franja de controles de ventana y aparece una zona vertical vacía amplia antes del contenido.
- **Esperado:** una barra compacta con título y controles sin recorte ni espacio muerto.
- **Evidencia:** estado móvil con panel cerrado observado durante el recorrido; el estado inicial con panel abierto está en `09-responsive-390x844.png`.
- **Archivo probable:** cabecera global de la página y estilos responsive compartidos en `src/styles.css`/`src/main.js`.
- **Recomendación:** ocultar o truncar explícitamente el subtítulo en móvil y recalcular la altura reservada para la barra de ventana.

No se encontraron P0.

## Accesibilidad

- **Semántica:** PASS. El feed usa `role="log"`, `aria-live="polite"` y `aria-busy="false"`; el estado OpenCode usa `role="status"`. La confirmación usa `role="alertdialog"`, `aria-modal`, `aria-labelledby` y `aria-describedby`.
- **Nombres accesibles:** PASS. Todos los botones de icono inspeccionados tienen `aria-label` o texto accesible; los SVG son decorativos con `aria-hidden="true"`.
- **Foco visible:** PASS parcial. Buscador, compositor e input de renombrado mostraron anillo/sombra turquesa; el input de renombrado recibió foco y selección completa. El diálogo enfoca Cancelar y devuelve foco al disparador por implementación.
- **Escape:** PASS en edición, diálogo de eliminación y avisos de cambio.
- **Tab y Shift+Tab:** BLOCKED. El controlador del navegador mantuvo el foco en el mismo input al inyectar Tab/Shift+Tab; no fue posible distinguir de forma fiable una limitación del controlador de un fallo de la página. Debe repetirse manualmente en una WebView/Chrome real antes de aprobar accesibilidad de teclado.
- **Activación Enter/Espacio de editar/eliminar:** BLOCKED por la misma limitación de inyección de teclado en botones; la interacción por puntero sí funciona.
- **Contraste:** PASS para texto principal y panel oscuro; **observación P2** para lápiz/papelera por tamaño de 11 px y baja prominencia visual.
- **Movimiento:** no se observaron animaciones problemáticas ni contenido parpadeante.
- **Análisis automático:** no se ejecutó axe porque `axe-core` no está instalado en el proyecto.

## Responsive

| Viewport | Resultado | Observación |
| --- | --- | --- |
| 1440 × 900 | PASS | Historial, conversación y fuentes conviven con ancho de lectura razonable; no hay overflow global. |
| 1280 × 800 | PASS | Arquitectura completa, compositor visible y `scrollWidth === clientWidth`. |
| 1024 × 768 | FAIL | Carga directa es utilizable con historial abierto, pero fuentes puede abrirse simultáneamente y cubrir gran parte del chat. Los dos paneles se pueden cerrar. |
| 390 × 844 | FAIL | Sin overflow horizontal global, pero historial abre por defecto y tanto panel como compositor quedan parcialmente fuera del viewport. Tras cerrar el historial, el compositor vuelve a ser utilizable. |

## Evaluación visual

| Dimensión | Nota | Justificación |
| --- | ---: | --- |
| Identidad Jintia | 4/5 | Marca oficial, azul marino, turquesa, ruta y fuentes verificables son reconocibles. |
| Coherencia | 4/5 | Historial oscuro, chat y fuentes comparten tokens; las cápsulas claras de acciones del historial necesitan más contraste. |
| Jerarquía | 4/5 | Asignatura, semana, estado y conversación están bien ordenados; los paneles simultáneos rompen la jerarquía en tableta. |
| Legibilidad | 4/5 | Buen ancho en escritorio, Markdown y tabla legibles; degradación fuerte cuando fuentes cubre el chat en 1024. |
| Affordance | 3/5 | Acciones presentes y etiquetadas, pero varios iconos son pequeños y tenues. |
| Estados | 4/5 | Listo, carga, edición, selección, confirmación, éxito y error están contemplados. |
| Accesibilidad | 3/5 | Semántica y foco intencional buenos; falta completar recorrido de teclado real y mejorar objetivos táctiles. |
| Responsive | 2/5 | Conserva funciones, pero falla contención y exclusividad de paneles en 390/1024. |

## Capturas

Todas las rutas son relativas a `docs/evidencia-playwright-ask-jintia/`.

| Archivo | Contenido |
| --- | --- |
| `01-inicial-1440x900.png` | Carga inicial de escritorio amplio. |
| `02-renombrar-antes.png` | Input de renombrado visible, enfocado y seleccionado. |
| `03-renombrar-despues.png` | Título actualizado en el historial. |
| `04-dialogo-eliminacion.png` | Alertdialog propio de Jintia antes de confirmar. |
| `05-conversacion-abierta-1440x900.png` | Conversación activa con tabla y fuentes citadas. |
| `06-tabla-y-fuentes-1440x900.png` | Tabla y panel de fuentes NN/g/WCAG. |
| `07-responsive-1280x800.png` | Carga directa en escritorio compacto. |
| `08-responsive-1024x768.png` | Carga directa en tableta. |
| `09-responsive-390x844.png` | Carga directa móvil con historial abierto fuera del viewport. |
| `10-tableta-paneles-simultaneos-1024x768.png` | Historial y fuentes abiertos simultáneamente. |
| `11-eliminacion-confirmada.png` | Estado final tras confirmar la eliminación y recargar el historial. |

Las capturas son del viewport completo. La aplicación está construida como una superficie de altura fija con scroll interno; el intento de captura `fullPage` agotó el tiempo del controlador y no aporta contenido adicional en escritorio.

## Recomendaciones

1. **RESUELTO:** panel contextual único y contenido en `src/pages/jintia-chat.js`. A 1024 y 390 existe un solo overlay; a 1440 queda persistente y el historial aparece después de los enlaces citados.
2. **RESUELTO:** objetivos táctiles de acciones, respuesta y cierres de al menos 44 px en breakpoints táctiles, con lápiz/papelera de 16 px.
3. **RESUELTO:** cabecera global móvil compacta, sin subtítulo superpuesto ni overflow horizontal.
4. **PENDIENTE MANUAL:** repetir Tab/Shift+Tab y Enter/Espacio en la WebView de Tauri o Chrome y añadir axe al conjunto de pruebas. **Aceptación:** orden de foco completo, foco visible, activación de editar/eliminar y ausencia de violaciones críticas/serias.

## Revalidación posterior a mejoras — 2026-08-19

### Decisiones UX aplicadas

- Se eliminó la competencia entre dos paneles laterales. El orden del panel derecho es ahora **Notebook conectado → Enlaces citados → Conversaciones**, que agrupa contexto y evidencia antes de navegación histórica.
- El menú global del dashboard se contrae al entrar en Ask Jintia para ampliar el área de lectura. El botón de la barra superior mantiene `aria-controls`, `aria-expanded` y permite restaurarlo; al salir de Ask Jintia vuelve a expandirse.
- En Cursos, la acción nativa se convirtió en un botón directo con texto **Ask Jintia**. ChatGPT y Claude Code se trasladaron a **Más acciones → Abrir con IA**, con nombre, icono, indicación de aplicación externa y objetivos de 44 px.
- Para acciones pequeñas se usa `/brand/jintia-mark.svg`, el isotipo vectorial nítido. `jintia-chatbot-icon-exacto (1).svg` coincide con `/brand/jintia-chatbot.svg` y se conserva para avatares grandes. `jintia-chatbot-extracted.svg` contiene el símbolo de OpenAI y no debe representar a Jintia; las variantes grayscale son rasterizadas y demasiado pesadas para controles de 18–20 px.
- Los colores se consolidaron en navy `#0D1B2A`, teal `#0F7F86`/`#0FA3A3`, superficies blancas y slate. El historial trasladado usa fondo claro, selección teal, texto slate y estados coherentes con fuentes y conversación.

### Resultado responsive final

| Viewport | Resultado | Evidencia |
| --- | --- | --- |
| 1440 × 900 | PASS | Sidebar global contraído (`width: 0` tras la transición), panel contextual persistente de 320 px, `scrollWidth === 1440`; `mejoras/08-final-1440x900-contexto.png`. |
| 1280 × 800 | PASS | Sin overflow global y compositor visible; `mejoras/04-mejora-1280x800.png`. |
| 1024 × 768 | PASS | Panel contextual como overlay único, completamente contenido; `mejoras/03-mejora-1024x768-fuentes.png`. |
| 390 × 844 | PASS | Inicio sin overlay, compositor visible; panel contextual `x=42…378`, `y=124…832`, cierre 44 × 44 y foco devuelto al disparador; `mejoras/07-final-contexto-historial-movil.png`. |

### Verificación final

- `npm test`: **193/193 PASS**.
- `npm run build`: **PASS** con las advertencias preexistentes de tamaño de chunk/import dinámico; sin errores de compilación.
- Navegación Cursos → Ask Jintia: **PASS**; menú principal pasa a `data-collapsed="true"` y ancho final 0 px.
- Expansión manual del menú dentro de Ask Jintia: **PASS**; ancho 240 px y `aria-expanded="true"`.
- Tabla Cursos: botón Ask Jintia 116.9 × 44 px en escritorio y 87.6 × 44 px en móvil; sin overflow global.
- Menú Abrir con IA: ChatGPT, Claude Code y el resto de acciones miden 44 px; el panel queda dentro de 1440 × 900.
- Escape cierra el panel contextual responsive y devuelve foco; Tab/Shift+Tab continúa **BLOCKED por el controlador**, no atribuido a la aplicación.

### Evidencia adicional

Todas las rutas son relativas a `docs/evidencia-playwright-ask-jintia/mejoras/`.

| Archivo | Contenido |
| --- | --- |
| `07-final-contexto-historial-movil.png` | Panel contextual móvil con el orden final y objetivos táctiles. |
| `08-final-1440x900-contexto.png` | Ask Jintia amplio con menú global contraído e historial después de enlaces. |
| `09-final-tabla-cursos-1440x900.png` | Tabla con la acción directa Ask Jintia. |
| `10-final-menu-ia-1440x900.png` | Menú etiquetado para ChatGPT y Claude Code. |
| `11-final-cursos-390x844.png` | Tarjeta de curso móvil sin desbordamiento de acciones. |
