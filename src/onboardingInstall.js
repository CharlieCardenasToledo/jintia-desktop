// Ejecuta la etapa secundaria solo si la primaria tuvo éxito.
// Un fallo secundario domina el resultado final.
// Cuando ambas tienen éxito se conserva el resultado primario.
export async function runSecondaryStage(primaryResult, runSecondary) {
  if (!primaryResult.success) return primaryResult;
  const secondaryResult = await runSecondary();
  if (!secondaryResult.success) return secondaryResult;
  return primaryResult;
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
