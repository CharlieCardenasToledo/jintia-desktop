import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

globalThis.localStorage = memoryStorage();
const { ensureJintiaSubfolder } = await import("../src/state.js");

test("ensureJintiaSubfolder: agrega Jintia a una carpeta raíz elegida por el usuario", () => {
  assert.equal(
    ensureJintiaSubfolder("C:\\Users\\ana\\OneDrive - Universidad"),
    "C:\\Users\\ana\\OneDrive - Universidad\\Jintia"
  );
});

test("ensureJintiaSubfolder: no duplica Jintia si el usuario ya eligió esa carpeta", () => {
  assert.equal(ensureJintiaSubfolder("C:\\Users\\ana\\Documents\\Jintia"), "C:\\Users\\ana\\Documents\\Jintia");
  assert.equal(ensureJintiaSubfolder("/home/ana/jintia"), "/home/ana/jintia");
});

test("ensureJintiaSubfolder: respeta el separador del sistema operativo", () => {
  assert.equal(ensureJintiaSubfolder("/home/ana/cursos"), "/home/ana/cursos/Jintia");
});

test("ensureJintiaSubfolder: tolera rutas con separador final", () => {
  assert.equal(ensureJintiaSubfolder("C:\\Cursos\\"), "C:\\Cursos\\Jintia");
});

test("ensureJintiaSubfolder: valores vacíos se devuelven sin cambios", () => {
  assert.equal(ensureJintiaSubfolder(""), "");
  assert.equal(ensureJintiaSubfolder(undefined), undefined);
});

// Regresión: onboarding.js y settings.js deben compartir la misma llave de
// configuración (courseWorkspaceRoot). Antes de este fix, el onboarding
// escribía "courseRoot" mientras que Ajustes y courses.js leían
// "courseWorkspaceRoot" — dos llaves desconectadas que nunca se veían entre
// sí, así que la carpeta elegida en el onboarding jamás llegaba a afectar
// dónde se crean las asignaturas nuevas.
test("regresión: onboarding.js ya no usa la llave de config desconectada 'courseRoot'", async () => {
  const source = await readFile(new URL("../src/onboarding.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /state\.config\.courseRoot\b/);
  assert.match(source, /state\.config\.courseWorkspaceRoot/);
  assert.match(source, /ensureJintiaSubfolder/);
});

test("regresión: Ajustes aplica ensureJintiaSubfolder al elegir una carpeta nueva", async () => {
  const source = await readFile(new URL("../src/pages/settings.js", import.meta.url), "utf8");
  assert.match(source, /ensureJintiaSubfolder\(chosen\)/);
});
