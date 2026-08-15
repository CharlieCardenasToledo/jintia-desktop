// Orquesta el cierre perceptible del onboarding: anuncia el resultado,
// espera el intervalo mínimo y recarga una vez.
// Las dependencias se inyectan para permitir tests sin DOM ni temporizadores reales.
export async function runCompletionHandoff({ announce, wait, reload }) {
  announce();
  await wait();
  reload();
}
