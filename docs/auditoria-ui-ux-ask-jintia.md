# Auditoría UI/UX de Ask Jintia

**Producto auditado:** Jintia Desktop 1.1.1  
**Pantalla principal:** `src/pages/jintia-chat.js`  
**Fecha:** 18 de agosto de 2026  
**Alcance:** identidad de marca, sistema visual, arquitectura de información, interacción, heurísticas de usabilidad, leyes de UX, accesibilidad WCAG 2.2 AA, confianza y propuesta de mejora.

## 1. Resumen ejecutivo

Ask Jintia tiene una base funcional competente: usa un patrón de chat reconocible, ofrece historial, streaming, estados de conexión, confirmación de acciones destructivas, foco visible y preferencias de reducción de movimiento. La integración con asignaturas, semanas y NotebookLM también diferencia al producto de un chat genérico.

Sin embargo, la pantalla todavía se percibe más como una consola para operar OpenCode/Codex que como la experiencia propia de Jintia. La promesa de marca —«Diseña el camino del aprendizaje»— y su valor diferencial —respuestas y acciones apoyadas por fuentes verificables— no estructuran la interfaz. Los nombres de motores, modelos, puertos lógicos, estados técnicos e identificadores de sesión reciben más presencia de la necesaria.

Los riesgos principales son:

1. La salida Markdown del modelo se inserta como HTML sin una sanitización visible y los enlaces no pasan por la capa segura de Tauri.
2. Se expone una «Cadena de pensamiento», contenido interno que no aporta una evidencia confiable al docente y puede generar confusión o filtraciones.
3. El botón de cancelar usa la operación de OpenCode incluso cuando el proveedor activo es Codex, por lo que la promesa del control puede ser falsa.
4. El feed no es un `log` accesible, no anuncia respuestas ni streaming y varios controles no tienen etiquetas programáticas.
5. Cambiar la semana parece cambiar el contexto actual, pero la semana solo se aplica al crear una sesión; cambiar de proveedor puede mezclar dos historiales mentales dentro del mismo feed.
6. La paleta principal falla contraste en varios usos: blanco sobre `#0fa3a3` da **3.09:1**, y `slate-400` sobre blanco da **2.56:1**.

### Estado de implementación — 18 de agosto de 2026

Las mejoras P0, P1 y la dirección visual P2 descritas en este documento ya fueron aplicadas al producto: Markdown saneado, fuentes externas controladas, eliminación del razonamiento interno, cancelación específica por proveedor, contexto de semana consistente, estados accesibles, recuperación del prompt, historial buscable, panel persistente de fuentes y lenguaje visual propio de Jintia. También se migró la integración al protocolo vigente del Codex CLI instalado (`turn/start`, streaming por deltas e interrupción de turnos).

La implementación pasó las pruebas automatizadas, el build de producción y la compilación Rust. La inspección visual automatizada quedó pendiente porque no había un navegador conectado en la sesión de validación; conviene completar un recorrido manual en la aplicación Tauri antes de publicar.

### Puntuación orientativa

| Dimensión | Nota | Diagnóstico |
| --- | ---: | --- |
| Identidad de marca | 6.5/10 | Paleta y marca presentes, pero la experiencia central no expresa el concepto de camino ni la evidencia. |
| Jerarquía visual | 6/10 | Estructura legible; barra de contexto saturada y lectura demasiado ancha. |
| Usabilidad e interacción | 5/10 | Buen feedback básico, pero hay contradicciones de estado y controles con efectos poco claros. |
| Accesibilidad | 4.5/10 | Buen foco y teclado parcial; fallan etiquetas, anuncios dinámicos, contraste y algunos objetivos táctiles. |
| Confianza y transparencia | 4/10 | Las fuentes no son protagonistas; se muestra razonamiento interno y la salida HTML requiere endurecimiento. |
| **Resultado global** | **5.2/10** | Base sólida, todavía no lista como experiencia distintiva y confiable de Jintia. |

> Esta es una auditoría estática basada en el código fuente, los tokens, estados y flujos implementados. En esta sesión no hubo un navegador disponible para validar píxel a píxel, reflujo, zoom, lector de pantalla ni percepción en movimiento. Esos puntos deben cerrarse con una segunda pasada visual y pruebas con usuarios.

## 2. Qué debe ser Ask Jintia

### Usuario principal

Docentes que preparan, revisan y validan materiales de una asignatura. No deberían necesitar conocer OpenCode, Codex, proveedores, IDs de sesión ni detalles del runtime.

### Trabajo principal de la pantalla

**Permitir que un docente pregunte, genere, revise o valide contenido de una asignatura con contexto visible y fuentes verificables.**

### Promesa de experiencia

> «Sé en qué asignatura y semana estoy, sé qué fuentes usa Jintia, puedo verificar cada afirmación y siempre conservo el control de las acciones.»

La interfaz actual cumple bien la parte de conversar, pero solo parcialmente las partes de contexto, verificación y control.

## 3. Auditoría de marca

### Lo que sí cumple

- Usa correctamente el nombre **Jintia**, sin formas lingüísticas o culturales indebidas.
- El shell emplea el isotipo oficial y el lema.
- La paleta navy, teal y verde coincide con la marca.
- El contenido académico permanece en superficies opacas; el vidrio se reserva sobre todo al shell y controles flotantes.
- Syne para jerarquía e Inter para contenido crea una voz más distintiva que una UI completamente neutra.
- El uso de nodos, rutas y conexión está permitido por las directrices culturales de marca.

### Lo que debilita la marca

| Hallazgo | Impacto | Mejora |
| --- | --- | --- |
| Las respuestas usan un círculo con la letra `J`, no el isotipo de Jintia. | La conversación parece un chat genérico tematizado. | Usar una versión simplificada y optimizada del isotipo oficial como avatar. |
| El concepto de «camino» no organiza la experiencia. | La marca vive en el logo, no en la interacción. | Convertir contexto → respuesta → fuentes → acción en una «ruta de evidencia» con nodos sutiles. |
| «OpenCode», «Codex», «modelo» y «Powered by» dominan la pantalla. | La tecnología compite con el producto y aumenta carga cognitiva. | Mover motor/modelo a Preferencias avanzadas. Mostrar «Jintia está lista» y «Motor administrado automáticamente». |
| NotebookLM aparece como tarjeta eventual dentro del feed. | El principal activo de confianza puede perderse al desplazarse o limpiarse el chat. | Mostrar siempre un indicador de fuentes en el encabezado: «12 fuentes conectadas». |
| Hay dos definiciones de marca que han divergido. | El manual usa `#0f766e`, mientras los tokens principales usan `#0fa3a3`; el manual tipográfico habla solo de Inter y la app incorpora Syne. | Consolidar una sola fuente de verdad de tokens y actualizar el manual si Syne es una decisión oficial. |
| El recurso `jintia-chatbot.svg` encapsula una imagen rasterizada enorme. | No es apropiado como icono pequeño, aumenta peso y puede verse blando. | Crear un SVG vectorial ligero, derivado del isotipo y optimizado para 20–32 px. |

### Dirección visual recomendada

Mantener la base clara y productiva, pero hacer memorable una sola idea: **la ruta de evidencia**. Una línea vertical muy sutil conecta tres nodos en cada respuesta importante:

1. pregunta o intención;
2. respuesta de Jintia;
3. fuentes y acción resultante.

Esto expresa «camino» sin convertir la pantalla en decoración ni usar referencias culturales no autorizadas.

## 4. Principios de UI

| Principio | Estado | Evidencia y recomendación |
| --- | --- | --- |
| Jerarquía | Parcial | Curso, semana, proveedor, modelo, estado, conectar y nueva sesión compiten en una sola fila. Separar contexto, estado y acciones. |
| Contraste | No cumple | Blanco sobre `#0fa3a3`: 3.09:1. `slate-400` sobre blanco: 2.56:1. Usar `brand-700` o más oscuro para botones con texto y `slate-600` para microtexto. |
| Consistencia | Parcial | Se mezclan `brand`, `teal` y colores Tailwind para el mismo significado. Estados dicen OpenCode aun cuando se usa Codex. |
| Alineación | Cumple parcialmente | La retícula general es clara, pero el feed queda pegado al borde y no tiene una columna de lectura centrada. |
| Espaciado | Parcial | Los controles superiores están densos; el cuerpo en pantallas anchas queda excesivamente vacío y las líneas se alargan. |
| Tipografía | Parcial | Buena pareja Syne/Inter, pero abundan textos de 10–11 px. El tamaño no debe sustituir jerarquía por miniaturización. |
| Escala y proporción | Parcial | El historial fijo de 192 px es estrecho; las burbujas de 80% son demasiado anchas en monitores grandes. |
| Affordance | Parcial | Botones e inputs son reconocibles; el botón cuadrado de cancelar es ambiguo sin texto visible. |
| Feedback | Parcial | Hay spinner, badge, toast y streaming; faltan progreso útil en Codex, `aria-busy` y recuperación del prompt al fallar. |
| Prevención de errores | Parcial | La eliminación confirma; cambiar contexto o proveedor no advierte que puede iniciar otra conversación mental. |
| Reconocimiento sobre recuerdo | Parcial | Hay ejemplos iniciales, pero desaparecen al conectar. Mantener sugerencias contextuales accesibles junto al compositor. |
| Divulgación progresiva | No cumple | Motor y modelo aparecen como controles primarios. Deben vivir en un menú avanzado. |
| Capacidad de respuesta | Parcial | `flex-wrap` evita parte del desbordamiento, pero no existe una composición específica para ancho reducido ni historial colapsable. |
| Accesibilidad | No cumple | Faltan labels, log vivo y estado accesible; hay contraste insuficiente y objetivos de aproximadamente 23 px. |

## 5. Heurísticas de Nielsen

| Heurística | Evaluación | Hallazgo principal |
| --- | --- | --- |
| 1. Visibilidad del estado | Parcial | El badge informa, pero no es `role=status`; Conectar queda deshabilitado con el texto «Conectar» cuando ya está conectado. |
| 2. Correspondencia con el mundo real | No cumple | OpenCode, Codex, modelo e IDs pertenecen al sistema, no al lenguaje docente. |
| 3. Control y libertad | Parcial | Hay cancelar y nueva sesión, pero cancelar no corresponde al flujo Codex y no hay deshacer/restaurar prompt fallido. |
| 4. Consistencia y estándares | Parcial | El patrón chat es familiar; estados y proveedores se mezclan de forma inconsistente. |
| 5. Prevención de errores | Parcial | Confirmación destructiva correcta; cambios de semana/proveedor son ambiguos y el prompt se pierde ante error. |
| 6. Reconocimiento antes que recuerdo | Parcial | Ejemplos iniciales buenos, pero no persisten; IDs de sesión no ayudan a reconocer conversaciones. |
| 7. Flexibilidad y eficiencia | Parcial | Enter/Shift+Enter y sesiones ayudan; faltan acciones frecuentes como copiar, reintentar, citar o aplicar a semana. |
| 8. Estética y diseño minimalista | No cumple | La barra superior expone demasiada infraestructura y el pie «Powered by…» repite información técnica. |
| 9. Recuperación de errores | No cumple | Los errores son principalmente toasts temporales; no siempre indican acción concreta y pueden hacer perder contenido. |
| 10. Ayuda y documentación | Parcial | Hay ejemplos y enlace a Ajustes; falta explicar alcance, fuentes usadas y efecto de contexto/semana. |

## 6. Leyes de UX aplicables

No existe un catálogo universal y cerrado de «todas» las leyes de UX. Esta auditoría cubre las 21 leyes y efectos más utilizados en el marco Laws of UX, además de Nielsen, Norman, Gestalt y WCAG.

| Ley o efecto | Estado | Aplicación a Ask Jintia |
| --- | --- | --- |
| Ley de Jakob | Cumple parcialmente | Se parece a chats conocidos, pero introduce demasiados controles técnicos en el encabezado. |
| Ley de Fitts | No cumple | Renombrar/eliminar usan objetivos cercanos a 23 px y solo aparecen por hover/foco. Llevarlos a 32–36 px. |
| Ley de Hick | No cumple | Siete decisiones visibles antes de escribir. Reducir a curso, semana/fuentes y nueva conversación. |
| Ley de Miller | No cumple parcialmente | La barra de contexto y los estados técnicos exceden el agrupamiento natural. Formar 3 grupos claramente rotulados. |
| Ley de Postel | Parcial | Se acepta Markdown y texto libre, pero el sistema no conserva el prompt ante fallo ni controla HTML/enlaces de salida. |
| Ley de Tesler | No cumple | La complejidad del proveedor se transfiere al docente. Jintia debe seleccionar el motor por defecto. |
| Efecto estética-usabilidad | Parcial | La interfaz es limpia, pero microtexto débil y densidad técnica reducen percepción de calidad y confianza. |
| Efecto Von Restorff | Parcial | El botón enviar destaca; también compiten Conectar, badges y selectores. Reservar el acento a la acción principal. |
| Efecto de posición serial | Parcial | Curso y nueva sesión están bien situados; fuentes, la información más importante para confianza, queda oculta en medio del flujo. |
| Efecto Zeigarnik | No cumple | No se visualizan tareas pendientes, pasos del agente ni respuestas interrumpidas de forma persistente. |
| Regla del pico y final | No cumple | El final de una respuesta no ofrece cierre memorable: fuentes, resumen, acción o confirmación del resultado. |
| Regla pico-fin / Doherty | Parcial | OpenCode transmite deltas; Codex espera al final y solo muestra «pensando», reduciendo sensación de respuesta. |
| Gradiente de meta | No aplica bien hoy | Las tareas largas carecen de etapas visibles. Mostrar «Buscando fuentes → redactando → verificando». |
| Ley de Parkinson | Riesgo | Un compositor sin estructura invita prompts difusos. Los iniciadores por intención reducen tiempo y ambigüedad. |
| Navaja de Occam | No cumple | Conectar, proveedor, modelo y estado pueden reducirse a un único estado administrado por Jintia. |
| Principio de Prägnanz | Parcial | La composición general es simple; la barra superior rompe la forma perceptual por acumulación. |
| Proximidad | Parcial | Etiqueta visual y select están próximos; pero los controles del motor se mezclan con el contexto académico. |
| Región común | Parcial | Toolbar, feed y compositor están separados; fuentes y conexión no tienen una región semántica propia. |
| Similitud | Parcial | Muchos controles comparten estilo aun cuando su importancia y función son distintas. |
| Conectividad uniforme | No cumple | No se muestra la relación entre asignatura, semana, notebook, respuesta y cita. La ruta de evidencia la haría explícita. |
| Umbral de Doherty | Parcial | El streaming ayuda a mantener respuesta percibida por debajo del umbral; faltan estados útiles en operaciones largas y Codex. |

## 7. Principios de Norman y Gestalt

### Norman

- **Visibilidad:** buena para enviar y crear sesión; deficiente para saber qué fuentes y contexto exacto están activos.
- **Feedback:** existe, pero no siempre corresponde al proveedor ni es accesible.
- **Restricciones:** deshabilitar el compositor evita errores, pero también impide preparar el siguiente mensaje mientras Jintia responde.
- **Mapeo:** cambiar semana parece afectar el chat actual; en realidad solo se consume al crear una sesión.
- **Consistencia:** «OpenCode listo» puede aparecer en una experiencia configurada como ChatGPT.
- **Affordance:** los iconos de editar/eliminar son convencionales; el cuadrado de cancelar no comunica por sí solo «Detener respuesta».
- **Modelo conceptual:** el usuario debería pensar en curso, semana, fuentes y tarea, no en runtime, motor y modelo.

### Gestalt

- **Proximidad y región común:** la estructura base funciona, pero el encabezado agrupa elementos académicos y técnicos que no pertenecen al mismo nivel.
- **Figura-fondo:** superficies blancas sobre fondo claro son limpias; el estado vacío a `opacity-50` parece deshabilitado y pierde figura.
- **Continuidad:** falta una continuidad visual entre respuesta, fuentes y acciones.
- **Similitud:** selectores de curso y modelo lucen equivalentes aunque el primero sea esencial y el segundo avanzado.

## 8. Accesibilidad WCAG 2.2 AA

| Criterio | Estado | Hallazgo / corrección |
| --- | --- | --- |
| 1.3.1 Información y relaciones | No cumple | «Asignatura» y «Semana» son `span`, no `label`; proveedor/modelo dependen de `title`. Usar `label for` o `aria-labelledby`. |
| 1.3.2 Secuencia significativa | Parcial | Orden DOM razonable; acciones flotantes del historial requieren validar lectura real. |
| 1.4.3 Contraste mínimo | No cumple | `slate-400`/blanco 2.56:1; blanco/brand-600 3.09:1; verde y rojo pequeños también quedan por debajo de 4.5:1. |
| 1.4.10 Reflow | Sin verificar / riesgo alto | Historial fijo, barra con muchos controles y shell sin navegación móvil alternativa. Probar a 320 CSS px y 400% zoom. |
| 1.4.11 Contraste no textual | Parcial | Foco es suficientemente visible; varios bordes `slate-200` son demasiado sutiles para identificar controles por sí solos. |
| 2.1.1 Teclado | Cumple parcialmente | Enter, Shift+Enter, acciones de historial y diálogo funcionan con teclado. Falta validar todo el flujo y enlaces Markdown. |
| 2.4.3 Orden de foco | Parcial | La decisión de mantener acciones con `opacity` es correcta. Cambios de feed no administran foco ni anuncio. |
| 2.4.6 Encabezados y etiquetas | No cumple | El compositor usa solo placeholder; el estado vacío usa `div` y varios selectores no tienen nombre visible/programático completo. |
| 2.4.7 Foco visible | Cumple | Existe un anillo global de 3 px y tratamientos específicos. |
| 2.5.8 Tamaño de objetivo | No cumple parcialmente | Botones de historial: icono 11 px + 12 px de padding ≈ 23 px. Usar mínimo 24 px, recomendado 32–44 px. |
| 3.2.2 Al recibir entrada | Parcial | Cambiar curso autoejecuta conexión; debería explicitar el cambio de conversación/contexto. |
| 3.3.1 Identificación de errores | Parcial | Los toasts anuncian globalmente, pero son temporales y no están asociados al control que falló. |
| 3.3.2 Etiquetas o instrucciones | No cumple | Placeholder no reemplaza una etiqueta; proveedor, modelo y notebook requieren labels accesibles. |
| 4.1.2 Nombre, función y valor | No cumple parcialmente | Estado activo de sesión no usa `aria-current`; badge carece de rol; cancelar depende de `title`. |
| 4.1.3 Mensajes de estado | No cumple parcialmente | Toast sí usa `role=status`; feed, streaming, badge y «pensando» no están expuestos como estado/log accesible. |

### Cambios mínimos de accesibilidad

1. Convertir el feed en `role="log" aria-live="polite" aria-relevant="additions text"` y usar `aria-busy` durante generación.
2. Añadir labels reales a todos los selectores y al textarea.
3. Anunciar el estado en un elemento `role="status" aria-live="polite" aria-atomic="true"`.
4. Dar a cada mensaje una estructura semántica con autor y contenido.
5. Subir el microtexto relevante a 12 px y `slate-600` como mínimo.
6. Usar `brand-700` (`#0f7f86`, 4.77:1 con blanco) o `#0f766e` (5.47:1) en botones con texto blanco.
7. Aumentar objetivos de acciones secundarias a mínimo 32 px.
8. Probar teclado, NVDA, zoom 200%/400%, contraste forzado y reducción de movimiento/transparencia.

## 9. Hallazgos funcionales que afectan UX y confianza

### P0 — críticos

#### P0.1 Sanitizar contenido y controlar enlaces

`marked.parse()` se asigna directamente a `innerHTML` en respuestas e historial. Debe pasar por una política de sanitización, bloquear scripts/HTML peligroso y convertir enlaces externos en acciones seguras de Tauri. También deben limitarse esquemas a `https`, `http` autorizados y rutas internas conocidas.

#### P0.2 Eliminar «Cadena de pensamiento»

No es una fuente, no es una explicación pedagógica confiable y no debería mostrarse como razonamiento interno del modelo. Sustituirla, cuando sea útil, por un panel de **Actividad** con eventos verificables:

- consultó 8 fuentes;
- encontró 3 coincidencias;
- generó una propuesta;
- validó la estructura.

#### P0.3 Hacer que Cancelar corresponda al proveedor

En modo Codex, el botón actual ejecuta `agent_abort` de OpenCode. Implementar cancelación de Codex o no prometer esa acción. El control visible debe decir «Detener respuesta», no depender solo de un cuadrado.

#### P0.4 Corregir el contexto de semana y proveedor

- La semana debe quedar vinculada a la conversación y mostrarse en el encabezado del hilo.
- Si cambia la semana, preguntar: «¿Crear una conversación para Semana 04?» o aplicar el cambio de forma real y visible.
- Cambiar de motor no debe mezclar dos historiales dentro del mismo feed. Crear un nuevo hilo o mantener el motor como detalle invisible.

#### P0.5 Hacer accesible la conversación

Agregar log vivo, estados anunciados, labels, autores, `aria-busy`, foco administrado y nombres accesibles robustos.

### P1 — alta prioridad

#### P1.1 Simplificar la barra de contexto

Visible por defecto:

- asignatura;
- semana;
- estado de fuentes;
- nueva conversación.

Oculto en «Opciones avanzadas» o Ajustes:

- proveedor;
- modelo;
- información «Powered by»;
- diagnóstico de conexión.

#### P1.2 Convertir fuentes en una función primaria

Mostrar un chip persistente como **«12 fuentes conectadas»**. Cada respuesta debe tener citas numeradas y un panel expandible con título de fuente, fragmento, ubicación y acción «Abrir fuente».

#### P1.3 Recuperar el mensaje ante error

El texto se borra antes de confirmar el envío. Si falla, devolverlo al compositor y ofrecer «Reintentar». Conservar también respuestas parciales canceladas.

#### P1.4 Mejorar la legibilidad

- Centrar la conversación en una columna de `max-width: 720px` o `68–72ch`.
- Evitar burbujas de 80% sin límite absoluto.
- Usar 14–15 px para respuesta, 12–13 px para metadatos y evitar 10 px salvo datos no esenciales.
- Envolver tablas Markdown en un contenedor con scroll horizontal.

#### P1.5 Rediseñar historial

- Ancho 232–256 px, colapsable.
- Mostrar título y fecha relativa, no el ID técnico.
- Añadir búsqueda cuando haya más de 8–10 conversaciones.
- Marcar la sesión activa con `aria-current="true"` y un indicador que no dependa solo del color.

### P2 — diferenciación del producto

- Iniciadores agrupados por intención: **Preguntar**, **Crear**, **Revisar**, **Validar**.
- Acciones al final de respuesta: Copiar, Ver fuentes, Aplicar a semana, Reintentar.
- Resumen de acciones realizadas y archivos modificados.
- Vista de fuentes lateral opcional.
- Firma visual «ruta de evidencia».
- Historial y capacidades coherentes para todos los motores.

## 10. Propuesta de arquitectura de interfaz

```text
┌ Historial ───────┬──────────────── Conversación ───────────────┬ Fuentes ───────┐
│ Buscar           │ IFT200  ›  Semana 03                        │ 12 conectadas   │
│                  │ [Fuentes verificadas]        [Nuevo chat]   │                 │
│ Hoy              ├─────────────────────────────────────────────┤ Sílabus          │
│ • Normalización  │                                             │ Capítulo 4       │
│ • Rúbrica S03    │        Ask Jintia + isotipo                  │ Artículo ACM     │
│                  │ Pregunta, crea o valida con tus fuentes.     │ …                │
│ Ayer             │                                             │                 │
│ • Plan de clase  │ [Preguntar] [Crear] [Revisar] [Validar]     │                 │
│                  │                                             │                 │
│                  │ ─── respuesta, citas y acciones ───         │                 │
│                  ├─────────────────────────────────────────────┤                 │
│                  │ ¿Qué quieres hacer con esta asignatura? [→] │                 │
└──────────────────┴─────────────────────────────────────────────┴─────────────────┘
```

En anchos menores, Fuentes se convierte en drawer y el Historial en panel colapsable. La conversación conserva una medida de lectura estable.

## 11. Sistema visual propuesto

### Color

| Rol | Token recomendado | Uso |
| --- | --- | --- |
| Fondo | `#F1F4F6` | Canvas general. |
| Papel | `#FFFFFF` | Respuestas, formularios y contenido. |
| Tinta | `#0D1B2A` | Texto principal. |
| Texto secundario | `#475569` | Metadatos y ayudas; evita `slate-400` en texto pequeño. |
| Acción | `#0F7F86` o `#0F766E` | Botones con texto blanco y foco de marca. |
| Acento | `#0FA3A3` | Nodos, iconos grandes, bordes y fondos suaves; no texto blanco pequeño. |
| Progreso | `#1FAE6D` | Éxito/progreso acompañado de icono y texto. |

### Tipografía

- **Syne:** nombre de la página, estados vacíos y uno o dos encabezados de alto nivel.
- **Inter:** conversación, controles y metadatos.
- **Cascadia Code:** únicamente rutas, comandos o detalles técnicos expandibles.
- Escala recomendada: 24 / 18 / 15 / 13 / 12 px. Evitar 10 px en contenido operativo.

### Componentes

- Botón primario: fondo `brand-700`, 36–40 px de alto; 44 px en superficies táctiles.
- Selectores: label visible, altura mínima 36 px, foco de 3 px.
- Mensaje Jintia: sin burbuja excesiva; bloque editorial de máximo 72ch con isotipo y citas.
- Mensaje usuario: burbuja navy de máximo 60ch.
- Estado de fuentes: chip con icono, cantidad y nombre de notebook; no solo color.
- Estado vacío: opacidad 100%, texto de alto contraste y cuatro iniciadores por intención.

## 12. Roadmap recomendado

### Fase 0 — confianza y accesibilidad (2–3 días)

1. Sanitizar Markdown y enrutar enlaces de forma segura.
2. Retirar cadena de pensamiento.
3. Corregir cancelación Codex y recuperación del prompt.
4. Añadir labels, log vivo, estado anunciado y `aria-busy`.
5. Corregir contraste y tamaño de objetivos.

### Fase 1 — claridad del flujo (3–5 días)

1. Simplificar encabezado y ocultar proveedor/modelo.
2. Hacer persistente el estado de fuentes.
3. Vincular semana a sesión y separar historiales por motor.
4. Rediseñar historial y ancho de lectura.
5. Añadir acciones de mensaje y estados de error persistentes.

### Fase 2 — marca y diferenciación (1–2 semanas)

1. Implementar ruta de evidencia.
2. Crear avatar vectorial optimizado.
3. Diseñar iniciadores por intención y panel de fuentes.
4. Consolidar tokens/documentación y pruebas visuales.
5. Realizar prueba de usabilidad con 5 docentes.

## 13. Criterios de aceptación

- Cero errores críticos/serios en axe para la pantalla y sus estados principales.
- Flujo completo operable con teclado y comprensible con NVDA.
- Contraste AA en texto, controles, foco y estados.
- Reflujo usable a 320 CSS px y zoom de 400% donde aplique.
- 100% de respuestas basadas en NotebookLM muestran fuentes verificables o declaran claramente que no usaron fuentes.
- Cancelar funciona en todos los motores visibles.
- Un cambio de curso, semana o motor nunca altera silenciosamente el contexto de una conversación.
- El prompt se conserva ante error o cancelación.
- Tiempo mediano hasta la primera pregunta menor a 20 segundos para un curso ya configurado.
- En prueba con docentes, al menos 4 de 5 pueden explicar qué fuentes usó Jintia y qué contexto estaba activo sin ayuda.

## 14. Veredicto

La interfaz no necesita una renovación puramente estética. Necesita reorganizar su promesa: **Jintia primero, motores después; fuentes antes que razonamiento; contexto visible antes que configuración; acciones verificables antes que estados técnicos.**

Con las correcciones P0 y P1 puede pasar de un chat técnico funcional a una herramienta docente confiable. La «ruta de evidencia» sería la mejora que, además de resolver UX, haría que la experiencia fuese reconocible como Jintia y no intercambiable con cualquier otro chat.
