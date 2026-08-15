// Ejecuta la etapa secundaria solo si la primaria tuvo éxito.
// Un fallo secundario domina el resultado final.
// Cuando ambas tienen éxito se conserva el resultado primario.
export async function runSecondaryStage(primaryResult, runSecondary) {
  if (!primaryResult.success) return primaryResult;
  const secondaryResult = await runSecondary();
  if (!secondaryResult.success) return secondaryResult;
  return primaryResult;
}

const PYTHON_VERIFY_ERROR =
  "Python no pudo verificarse en su ubicación final. Si tienes antivirus activo, agrega una excepción para la carpeta de Jintia; si no, reinicia la app e intenta de nuevo.";

// Concilia el resultado preliminar de Python con el snapshot autoritativo de checkDependencies().
// Solo aplica a Python; otras dependencias conservan su flujo sin modificación.
// Un resultado preliminar fallido se devuelve sin cambios.
export function verifyPythonInstallResult(preliminaryResult, dependencies) {
  if (!preliminaryResult.success) return preliminaryResult;
  const dep = Array.isArray(dependencies) ? dependencies.find(d => d.name === "Python") : null;
  if (!dep || dep.installed !== true) {
    return { success: false, message: PYTHON_VERIFY_ERROR };
  }
  return preliminaryResult;
}

// Convierte la respuesta de installDisciplinePackages() en un ActionResult uniforme.
// El objeto de entrada puede tener { error, failedStage } en caso de fallo
// o carecer de ellos en caso de éxito.
export function normalizeProfileInstallResult(profileResult) {
  if (!profileResult?.error) {
    return { success: true, message: profileResult?.message ?? "Perfil instalado." };
  }
  const stage = profileResult.failedStage ? ` (${profileResult.failedStage})` : "";
  return {
    success: false,
    message: `No se pudo preparar el perfil${stage}: ${profileResult.error}`,
  };
}
