// Ejecuta la etapa secundaria solo si la primaria tuvo éxito.
// Un fallo secundario domina el resultado final.
// Cuando ambas tienen éxito se conserva el resultado primario.
export async function runSecondaryStage(primaryResult, runSecondary) {
  if (!primaryResult.success) return primaryResult;
  const secondaryResult = await runSecondary();
  if (!secondaryResult.success) return secondaryResult;
  return primaryResult;
}

const VERIFY_ERROR_MESSAGES = {
  "Python": "Python terminó de instalarse, pero no pudo verificarse en su ubicación final. Intenta instalarlo de nuevo; si persiste, reinicia la app.",
};

// Concilia el resultado preliminar de una instalación con el snapshot autoritativo
// de dependencias devuelto por checkDependencies(). Si la dependencia no aparece
// como installed:true en el snapshot, el resultado se convierte en error.
// Un resultado preliminar fallido se devuelve sin cambios.
export function verifyInstalledDependencyResult(name, preliminaryResult, dependencies) {
  if (!preliminaryResult.success) return preliminaryResult;
  const dep = Array.isArray(dependencies) ? dependencies.find(d => d.name === name) : null;
  if (!dep || dep.installed !== true) {
    return {
      success: false,
      message: VERIFY_ERROR_MESSAGES[name] ?? `${name} no pudo verificarse tras la instalación.`,
    };
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
