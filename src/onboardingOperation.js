const FALLBACK = "No se pudo completar la operación.";

// Normaliza cualquier valor rechazado a un mensaje de usuario legible.
// Aplica trim() al candidato; si queda vacío usa el fallback.
// No expone stacks ni serializaciones arbitrarias.
function normalizeErrorMessage(error) {
  let candidate = null;
  if (error instanceof Error) candidate = error.message;
  else if (typeof error === "string") candidate = error;
  else if (error && typeof error === "object" && typeof error.message === "string") candidate = error.message;
  const trimmed = candidate?.trim() ?? "";
  return trimmed || FALLBACK;
}

// Espera preparation y ejecuta cleanup() exactamente una vez (éxito o rechazo).
// Propaga el rechazo sin capturarlo ni transformarlo.
export async function awaitPreparationWithCleanup(preparation, cleanup) {
  try {
    return await preparation;
  } finally {
    cleanup();
  }
}

// Construye un ActionResult fallido con el mensaje normalizado para cualquier rechazo.
export function operationFailureResult(error) {
  return { success: false, message: normalizeErrorMessage(error) };
}

// Ejecuta operation() y garantiza que:
//   - onSettled() se invoca exactamente una vez (éxito o rechazo).
//   - En caso de rechazo, onError(message) se invoca antes de onSettled().
//   - Un ActionResult {success:false} se devuelve sin activar onError.
//   - La promesa devuelta siempre resuelve; nunca rechaza.
export async function runOperationWithFeedback(operation, { onError, onSettled }) {
  try {
    return await operation();
  } catch (e) {
    const result = operationFailureResult(e);
    onError(result.message);
    return result;
  } finally {
    onSettled();
  }
}
