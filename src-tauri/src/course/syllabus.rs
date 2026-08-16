use super::course_directory;
use crate::models::{ActionResult, WeekData};
use crate::paths::{atomic_write, backup_file, canonical_directory, path_text};
use std::sync::Mutex;

static SYLLABUS_WRITE_OPERATION: Mutex<()> = Mutex::new(());

pub(super) fn bullets(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .map(|line| {
            line.trim_start_matches(|character: char| matches!(character, '-' | '*' | '•' | ' '))
                .trim()
        })
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

pub(super) fn labelled_outcomes(text: &str) -> Vec<String> {
    bullets(text)
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if [
                "docencia:",
                "práctica:",
                "practica:",
                "autónomo:",
                "autonomo:",
            ]
            .iter()
            .any(|prefix| line.to_lowercase().starts_with(prefix))
            {
                line
            } else if index == 0 {
                format!("Docencia: {line}")
            } else {
                line
            }
        })
        .collect()
}

pub(super) fn list_block(items: Vec<String>, empty: &str) -> String {
    if items.is_empty() {
        format!("- {empty}")
    } else {
        items
            .into_iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn build_syllabus_md(
    code: &str,
    name: &str,
    credits: u32,
    academic_period: &str,
    semester: &str,
    description: &str,
    weeks: &[WeekData],
) -> Result<String, String> {
    if code.trim().is_empty() || name.trim().is_empty() {
        return Err("Código y nombre de asignatura son obligatorios.".to_string());
    }
    if weeks.is_empty() {
        return Err("Agrega al menos una semana.".to_string());
    }

    let mut output = format!(
        "# {code} — {name}\n\n**Asignatura:** {code} — {name}\n**Periodo académico ordinario:** {}\n**Créditos:** {credits}\n**Semestre:** {}\n\n## Descripción del curso\n\n{}\n\n---\n\n## Plan semanal\n\n",
        academic_period.trim(),
        semester.trim(),
        description.trim()
    );

    for week in weeks {
        if !(1..=52).contains(&week.number) {
            return Err(format!("Número de semana inválido: {}", week.number));
        }
        let topics = bullets(&week.topics);
        let title = if week.title.trim().is_empty() {
            topics
                .first()
                .cloned()
                .unwrap_or_else(|| week.unit.trim().to_string())
        } else {
            week.title.trim().to_string()
        };
        output.push_str(&format!(
            "### Semana {:02} — {}\n\n**Unidad:** {}\n\n**Tema / contenido semanal:**\n{}\n\n**Resultado de aprendizaje:**\n{}\n\n**Herramienta de aprendizaje:**\n{}\n\n**Horas:** Docencia: {} | Práctica: {} | Autónomo: {}\n\n**Actividades calificadas:**\n{}\n\n---\n\n",
            week.number,
            title,
            week.unit.trim(),
            list_block(topics, "No especificado"),
            list_block(labelled_outcomes(&week.outcomes), "No especificado"),
            list_block(bullets(&week.bibliography), "No especificada"),
            week.teaching_hours,
            week.practice_hours,
            week.autonomous_hours,
            list_block(
                week.graded_activity.as_deref().map(bullets).unwrap_or_default(),
                "Ninguna"
            )
        ));
    }
    Ok(output)
}

pub fn generate_syllabus(
    course_path: String,
    course_code: String,
    course_name: String,
    credits: u32,
    academic_period: String,
    semester: String,
    description: String,
    weeks_data: Vec<WeekData>,
) -> ActionResult {
    let _operation = match SYLLABUS_WRITE_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno del sílabo está bloqueado."),
    };
    let root = match canonical_directory(&course_path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let course = match course_directory(&root, &course_code, &course_name) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = std::fs::create_dir_all(&course) {
        return ActionResult::error(format!("No se pudo crear carpeta del curso: {error}"));
    }

    let content = match build_syllabus_md(
        &course_code,
        &course_name,
        credits,
        &academic_period,
        &semester,
        &description,
        &weeks_data,
    ) {
        Ok(content) => content,
        Err(error) => return ActionResult::error(error),
    };
    let path = course.join("README.md");
    if std::fs::read(&path).ok().as_deref() == Some(content.as_bytes()) {
        return ActionResult::ok(format!(
            "El sílabo de prueba ya estaba actualizado; no se creó otro archivo ni respaldo.\n{}",
            path_text(&path)
        ))
        .with_path(path_text(&path));
    }
    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, content.as_bytes()) {
        return ActionResult::error(error);
    }

    let result = ActionResult::ok(format!(
        "Sílabo canónico generado en:\n{}",
        path_text(&path)
    ))
    .with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}

pub fn append_demo_week(full_content: &mut String, week: &WeekData, marginal_layout: bool) {
    full_content.push_str(
        "\\begin{mintblock}[title=Resultado de aprendizaje de la semana]\n\
         Al finalizar, podrás:\n\\begin{itemize}\n",
    );
    for line in week.outcomes.lines().filter(|line| !line.trim().is_empty()) {
        full_content.push_str(&format!("\\item {}\n", line.trim()));
    }
    full_content.push_str("\\end{itemize}\n\\end{mintblock}\n\n");
    if marginal_layout {
        full_content.push_str(
            "\\marginconcept{Criterio}{Condición explícita y observable usada para comparar alternativas.}\n",
        );
    }
    full_content.push_str(
        "\
         \\guidesection{Antes de empezar: una decisión cotidiana}\n\
         \\begin{softblock}\n\
         Una organización debe elegir una nueva plataforma para atender solicitudes de sus usuarios. \
         Una opción es económica, otra es fácil de usar y una tercera ofrece mejores controles de seguridad. \
         Cada área recomienda una alternativa distinta y la reunión termina con una frase conocida: \
         ``escojamos la que parece mejor''.\n\n\
         El problema no es la falta de opiniones. El problema es que todavía no existe una forma compartida \
         de comparar las opciones. Esta semana aprenderás a transformar una preferencia intuitiva en una \
         recomendación profesional que otra persona pueda revisar, cuestionar y mejorar.\n\n\
         \\textbf{Tiempo estimado:} 2 horas de estudio guiado, 2 horas de práctica y 4 horas de trabajo autónomo.\n\
         \\end{softblock}\n\n\
         \\guidesection{1. De la información a la evidencia}\n\
         Una decisión justificable separa tres elementos que suelen confundirse:\n\
         \\begin{accentblock}[title=Tres niveles de lectura]\n\
         \\begin{itemize}\n\
         \\item \\textbf{Dato:} registro observable sin una conclusión incorporada. Ejemplo: 38 de 50 usuarios completaron una tarea.\n\
         \\item \\textbf{Evidencia:} dato pertinente y suficientemente confiable para responder una pregunta concreta. El mismo registro es evidencia si la pregunta es cuál opción facilita completar la tarea.\n\
         \\item \\textbf{Interpretación:} explicación razonada de lo que la evidencia significa, considerando contexto y límites. En este caso, el resultado sugiere facilidad de uso, pero no demuestra seguridad ni costo total.\n\
         \\end{itemize}\n\
         \\end{accentblock}\n\n\
         Una cifra no se convierte automáticamente en evidencia. Primero debe relacionarse con la decisión, \
         provenir de una fuente identificable y permitir una comparación razonable. Pregunta siempre: \
         \\textit{¿qué decisión ayuda a tomar este dato y qué no permite concluir?}\n\n\
         \\begin{sandblock}[title=Pausa de recuperación]\n\
         Un proveedor afirma que su plataforma tiene ``95 puntos de satisfacción''. Antes de aceptar esa cifra, \
         escribe tres preguntas sobre la muestra, la forma de medición y el grupo con el que se compara.\n\
         \\end{sandblock}\n\n\
         \\guidesection{2. Comparar alternativas con criterios explícitos}\n\
         Elegir profesionalmente requiere declarar qué significa una buena decisión antes de enamorarse de una opción. \
         Un \\textbf{criterio} es una condición utilizada para comparar alternativas. Debe ser relevante, comprensible \
         y observable.\n\n\
         \\begin{accentblock}[title=Herramienta: matriz de decisión en cinco pasos]\n\
         \\begin{enumerate}\n\
         \\item Formula la decisión en una pregunta: ``¿qué plataforma conviene implementar durante el próximo año?''\n\
         \\item Define criterios antes de puntuar: accesibilidad, facilidad de uso, seguridad, costo total y soporte.\n\
         \\item Asigna a cada criterio una importancia relativa y documenta por qué.\n\
         \\item Puntúa cada alternativa con la misma escala y vincula cada puntuación con una evidencia.\n\
         \\item Revisa si un cambio pequeño en los pesos modifica la recomendación. Si la cambia, la decisión es sensible y necesita más información.\n\
         \\end{enumerate}\n\
         \\end{accentblock}\n\n\
         Cuando varios criterios tienen distinta importancia, puede utilizarse una puntuación ponderada. \
         Para cada alternativa $A_j$, se multiplica el peso $w_i$ de cada criterio por su puntuación $s_{ij}$:\n\
         \\begin{equation}\n\
         P(A_j)=\\sum_{i=1}^{n} w_i s_{ij}, \\qquad \\sum_{i=1}^{n} w_i=1\n\
         \\label{eq:puntuacion-ponderada}\n\
         \\end{equation}\n\
         La ecuación no reemplaza el juicio profesional: hace visibles sus supuestos y permite revisar cómo se obtuvo el resultado.\n\n\
         \\begin{guidetable}\n\
         \\guidetablecaption{Comparación resumida de las alternativas del caso.}{tab:comparacion-alternativas}\n\
         \\small\n\
         \\begin{tabularx}{\\textwidth}{lXXX}\n\
         \\toprule\n\
         \\textbf{Alternativa} & \\textbf{Fortaleza principal} & \\textbf{Riesgo observado} & \\textbf{Evidencia disponible} \\\\\n\
         \\midrule\n\
         A & Menor costo inicial & Más pasos para el usuario & Cotización y prueba de tareas \\\\\n\
         B & Mejor accesibilidad y uso & Costo variable por volumen & Prueba con usuarios y revisión de seguridad \\\\\n\
         C & Mayor número de funciones & Soporte en otro huso horario & Demostración del proveedor \\\\\n\
         \\bottomrule\n\
         \\end{tabularx}\n\
         \\end{guidetable}\n\n\
         La Tabla~\\ref{tab:comparacion-alternativas} permite contrastar fortalezas, riesgos y calidad de evidencia, \
         mientras la Ecuación~\\ref{eq:puntuacion-ponderada} documenta cómo combinar criterios cuando se requiere una puntuación total.\n\n\
         \\begin{softblock}[title=Ejemplo trabajado]\n\
         El comité considera que la accesibilidad y la seguridad son críticas, mientras que el precio es importante \
         pero no decisivo. La opción A cuesta menos, aunque exige más pasos para completar una solicitud. La opción B \
         obtiene mejores resultados en una prueba con usuarios y cumple los controles requeridos. La opción C ofrece \
         más funciones, pero su soporte solo está disponible en otro huso horario.\n\n\
         La recomendación preliminar favorece la opción B. No porque ``sea la mejor'' en términos absolutos, sino porque \
         responde mejor a los criterios acordados y cuenta con evidencia directa en los aspectos de mayor importancia.\n\
         \\end{softblock}\n\n\
         La Figura~\\ref{fig:ruta-decision} resume la ruta completa. Observa que la recomendación no aparece al inicio: \
         es el resultado de hacer explícitos los criterios, contrastar evidencia y comparar alternativas.\n\n\
         \\begin{guidefigure}\n\
         \\begin{tikzpicture}[\n\
           node distance=5mm,\n\
           stage/.style={draw,rounded corners=2mm,fill=softbg,draw=softline,text=ink,\n\
             minimum width=7.2cm,text width=6.5cm,minimum height=9mm,align=center,inner sep=2.5mm},\n\
           key/.style={stage,fill=weekaccent!10,draw=weekaccent,line width=.8pt},\n\
           flow/.style={-{Stealth[length=2.5mm]},line width=.8pt,draw=weekaccent}\n\
         ]\n\
         \\node[stage] (question) {\\textbf{1. Formular la decisión}\\\\Una pregunta concreta y delimitada};\n\
         \\node[stage,below=of question] (criteria) {\\textbf{2. Acordar criterios}\\\\Qué significa una buena alternativa};\n\
         \\node[stage,below=of criteria] (evidence) {\\textbf{3. Reunir evidencia}\\\\Datos pertinentes, confiables y comparables};\n\
         \\node[stage,below=of evidence] (compare) {\\textbf{4. Comparar y probar sensibilidad}\\\\Puntuaciones, pesos, riesgos y vacíos};\n\
         \\node[key,below=of compare] (recommend) {\\textbf{5. Recomendar y revisar}\\\\Decisión, razones, límites y próximo paso};\n\
         \\draw[flow] (question) -- (criteria);\n\
         \\draw[flow] (criteria) -- (evidence);\n\
         \\draw[flow] (evidence) -- (compare);\n\
         \\draw[flow] (compare) -- (recommend);\n\
         \\end{tikzpicture}\n\
         \\guidefigurecaption{Ruta de una decisión profesional justificable.}{fig:ruta-decision}\n\
         \\end{guidefigure}\n\n\
         \\guidesection{3. Sesgos, incertidumbre y límites}\n\
         Incluso una matriz ordenada puede amplificar juicios débiles. Tres riesgos son especialmente frecuentes:\n\
         \\begin{roseblock}[title=Señales de alerta]\n\
         \\begin{itemize}\n\
         \\item \\textbf{Anclaje:} la primera cifra o propuesta condiciona las comparaciones posteriores.\n\
         \\item \\textbf{Confirmación:} se buscan datos que apoyan la opción preferida y se ignoran los contrarios.\n\
         \\item \\textbf{Exceso de confianza:} se presenta una estimación como certeza y se ocultan los vacíos de información.\n\
         \\end{itemize}\n\
         \\end{roseblock}\n\n\
         La respuesta profesional no consiste en fingir certeza. Consiste en declarar los límites: qué información falta, \
         qué riesgo permanece y qué hecho haría reconsiderar la decisión. Una prueba piloto puede ser una mejor decisión \
         que una adopción total cuando la evidencia todavía es incompleta.\n\n\
         \\guidesection{4. Del análisis a una recomendación clara}\n\
         \\begin{mintblock}[title=Estructura de una recomendación profesional]\n\
         \\begin{enumerate}\n\
         \\item \\textbf{Decisión:} expresa qué se recomienda y para qué contexto.\n\
         \\item \\textbf{Razones:} conecta los criterios prioritarios con la evidencia disponible.\n\
         \\item \\textbf{Límites:} identifica supuestos, datos faltantes y posibles efectos adversos.\n\
         \\item \\textbf{Próximo paso:} propone una acción verificable, una persona responsable y una fecha de revisión.\n\
         \\end{enumerate}\n\
         \\end{mintblock}\n\n\
         \\begin{accentblock}[title=Recomendación del caso]\n\
         Se recomienda realizar un piloto de cuatro semanas con la opción B porque obtuvo mejores resultados de accesibilidad \
         y facilidad de uso, y cumple los controles de seguridad establecidos. La estimación de costos aún depende del volumen \
         real de solicitudes; por ello, el piloto debe registrar tiempos de atención, incidencias, satisfacción y costo por caso. \
         El comité revisará esos indicadores antes de autorizar la implementación completa.\n\
         \\end{accentblock}\n\n\
         \\guidesection{Transferencia a cualquier profesión}\n\
         El método no depende del sector. Una profesional de salud puede comparar intervenciones; un docente, estrategias de \
         evaluación; una ingeniera, soluciones técnicas; un abogado, cursos de acción; y un administrador, proveedores. \
         En todos los casos cambia el contenido experto, pero permanece la secuencia: formular la decisión, acordar criterios, \
         buscar evidencia, comparar alternativas, declarar incertidumbre y comunicar una recomendación revisable.\n\n\
         \\begin{sandblock}[title=Actividad calificada]\n",
    );
    if let Some(activity) = week
        .graded_activity
        .as_ref()
        .filter(|activity| !activity.trim().is_empty())
    {
        full_content.push_str(activity.trim());
    }
    full_content.push_str(
        "\n\n\\textbf{Criterios de logro:} la entrega distingue hechos de supuestos, aplica los mismos criterios a todas \
         las alternativas, vincula cada conclusión con evidencia e identifica al menos una limitación.\n\
         \\end{sandblock}\n\n\
         \\guidesection{Autoevaluación}\n\
         Antes de entregar, comprueba:\n\
         \\begin{itemize}\n\
         \\item Puedo explicar la diferencia entre dato, evidencia e interpretación.\n\
         \\item Definí los criterios antes de seleccionar una alternativa.\n\
         \\item Puedo rastrear cada puntuación hasta una fuente o una observación.\n\
         \\item Reconocí un sesgo posible y un vacío de información.\n\
         \\item Mi recomendación incluye un próximo paso verificable.\n\
         \\end{itemize}\n\n\
         \\guidesection{Referencias bibliográficas}\n\
         \\begin{softblock}\n\\begin{itemize}\n",
    );
    for line in week
        .bibliography
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        full_content.push_str(&format!("\\item {}\n", line.trim()));
    }
    full_content.push_str("\\end{itemize}\n\\end{softblock}\n\n");
}
