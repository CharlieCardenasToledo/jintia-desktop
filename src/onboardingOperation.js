// Normaliza cualquier valor rechazado a un mensaje de usuario legible.
// No expone stacks ni serializaciones arbitrarias.
function normalizeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim())
    return error.message.trim();
  return "No se pudo completar la operación.";
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
    const message = normalizeErrorMessage(e);
    onError(message);
    return { success: false, message };
  } finally {
    onSettled();
  }
}
