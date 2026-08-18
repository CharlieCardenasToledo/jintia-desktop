/**
 * Datos de muestra usados en el preview de plantillas y para generar sílabos de demostración.
 * El contenido describe el propio flujo de trabajo de Jintia para que el docente
 * vea de inmediato para qué sirve la herramienta.
 */
export function buildSampleGuideData(config = {}) {
  const institution = safeSampleText(config.institution, "la institución");
  const career = safeSampleText(config.career, "el programa académico");

  return {
    courseCode: "JINTIA-101",
    courseName: "Diseño instruccional asistido por IA",
    credits: 3,
    academicPeriod: safeSampleText(config.academicPeriod, "Período académico vigente"),
    semester: "Formación transversal",
    description:
      `Guía didáctica de muestra para ${career} en ${institution}. ` +
      "Ilustra el flujo completo de Jintia: desde la creación de la asignatura y la vinculación " +
      "de la biblioteca de conocimiento (Gemini Notebook), hasta la generación de guías didácticas " +
      "en PDF con diseño tipográfico institucional.",
    weeksData: [
      {
        number: 1,
        title: "Tu flujo de trabajo semanal con Jintia",
        unit: "Unidad I: Asistencia pedagógica con IA",
        topics:
          "Estructura de una asignatura en Jintia: carpetas, guías y sílabo\n" +
          "Gemini Notebook como biblioteca de conocimiento personal del docente\n" +
          "El chat Ask Jintia: preguntas sobre la materia con citas verificables\n" +
          "Generación de guías didácticas PDF con plantillas institucionales",
        outcomes:
          "Crear una asignatura completa en Jintia y vincular su Gemini Notebook\n" +
          "Formular preguntas al chat Ask Jintia y validar las fuentes citadas\n" +
          "Generar la guía didáctica de la primera semana en formato PDF",
        bibliography:
          "Anderson, L. W., y Krathwohl, D. R. (2001). A Taxonomy for Learning, Teaching, and Assessing. Longman.\n" +
          "Mayer, R. E. (2009). Multimedia Learning (2.ª ed.). Cambridge University Press.\n" +
          "Selwyn, N. (2022). The Future of AI and Education. European Journal of Education, 57(4), 664–676.",
        teachingHours: 2,
        practiceHours: 2,
        autonomousHours: 4,
        gradedActivity:
          "Crea tu primera asignatura en Jintia, vincula un Gemini Notebook con al menos " +
          "dos fuentes bibliográficas y genera la guía de la semana 1 en PDF. " +
          "Entrega: captura de pantalla de la guía generada y un párrafo explicando cómo " +
          "usarías Jintia en tu contexto docente real.",
      },
    ],
  };
}

function safeSampleText(value, fallback) {
  const clean = String(value || "")
    .trim()
    .replace(/[\\{}$&#_%~^]/g, " ")
    .replace(/\s+/g, " ");
  return clean || fallback;
}
